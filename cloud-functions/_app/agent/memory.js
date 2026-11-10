// L3 语义记忆：用户明确告知的稳定事实 / 偏好 / 画像（JSON 索引为唯一可信源 + md 只读镜像）
//
// 三层记忆里的第三层，管的是「关于这个人的稳定信息」：称呼、偏好、常用城市、项目名、
// 长期要求（比如「回答先给结论」）。它和另外两层的分工：
//   L1 工作记忆 = 本次会话发生了什么（易失）
//   L2 情景记忆 = 以前聊过什么（可按时间/关键词回溯）
//   L3 语义记忆 = 这个人是谁、要什么（长期，改口即覆盖）
// 只有 L3 允许由模型通过 remember 工具写入，因此必须最保守：
//   - 同一主题（"X是/为/: Y" 的 X）只保留最新，改口即覆盖，绝不积累互相矛盾的条目；
//   - 归一化后完全重复的不再重复保存；
//   - 超过容量上限时按「最近使用 + 新近度」淘汰最边缘的条目（不是删最新的）。

import { mapSetBounded, mapGetBounded } from '../utils.js';
import { storeGet, storePutChecked, storeDelete } from '../store/r2.js';
import { agentMemKey, agentMemKeyLegacy, kbMemDir, kbNewMemFile, kbMemMarkdown,
  kbBackfillMd, kbDeleteKeys, kbSafeChatId } from '../store/kb.js';
import { memoryTokens as sharedMemoryTokens } from './memory-text.js';

// ==================== Telegram Agent：长期记忆 + 开关 ====================
const tgAgentMemCache = new Map();
const tgAgentMemExp = new Map();

// 单用户语义记忆上限。400 条足够覆盖「一个人的全部稳定事实」，再多基本是模型在乱记。
// 超限时淘汰最久没用过、也最旧的条目（见 evictMemories），而不是直接丢弃新条目。
const MEM_MAX_ITEMS_DEFAULT = 400;
const MEM_FACT_MAX_CHARS = 200;
const MEM_TAGS_MAX = 6;

// 记忆类型：不同类型在提示词里用不同措辞，也让「长期要求」这类条目更容易被遵守。
const MEM_KINDS = ['fact', 'preference', 'profile', 'project', 'instruction'];
function normalizeMemKind(kind) {
  const k = String(kind || '').trim().toLowerCase();
  return MEM_KINDS.indexOf(k) !== -1 ? k : 'fact';
}
function normalizeTags(tags) {
  const arr = Array.isArray(tags) ? tags : (tags ? String(tags).split(/[,，;；\s]+/) : []);
  const out = [];
  for (const t of arr) {
    const s = String(t || '').trim().slice(0, 16);
    if (s && out.indexOf(s) === -1) out.push(s);
    if (out.length >= MEM_TAGS_MAX) break;
  }
  return out;
}
function memMaxItems(env) {
  const v = parseInt((env && env.MEMORY_ITEM_MAX) || '', 10);
  if (!(v > 0)) return MEM_MAX_ITEMS_DEFAULT;
  return Math.max(20, Math.min(2000, v));
}

// ---------- 知识库自动优化（v6.9.2）：确定性本地规则，不依赖 LLM ----------
// 归一化：转小写、去全部空白。"我养了一只猫 叫汤圆" 与 "我养了一只猫叫汤圆"
// 归一化后相同 → 视为同一条记忆（完全重复判断与加载时清理都用它）。
function memNorm(fact) {
  return String(fact || '').toLowerCase().replace(/\s+/g, '');
}
// 主题键：归一化文本中第一个 是/为/:/：/=/＝ 之前的部分（至少 2 字符）。
// 同一主题只保留最新事实——"我的手机号是A" 改口成 "我的手机号是B" 时自动
// 覆盖旧条目，不再积累互相矛盾的记忆。没有分隔符或主语太短返回 null，
// 不做主题判断（保守起步：宁可多存一条，不可误删用户事实）。
function memSubjectKey(fact) {
  const s = memNorm(fact);
  // v7.10.3：先把 URL 协议里的冒号掩码掉（等长替换，索引仍然对齐）。
  // 旧实现取第一个 ':' ——「https://a.com 是我的博客」的 subject 会退化成 "https"，
  // 于是所有网址开头的记忆互相覆盖，用户事实被悄悄删掉。
  const masked = s.replace(/[a-z][a-z0-9+.-]*:\/\//g, m => '\u0000'.repeat(m.length));
  let idx = -1;
  for (const d of ['是', '为', ':', '：', '=', '＝']) {
    const i = masked.indexOf(d);
    if (i !== -1 && (idx === -1 || i < idx)) idx = i;
  }
  if (idx < 2) return null;
  const key = s.slice(0, idx);
  // 纯数字/符号前缀（「10:30 是我的闹钟」→ "10"）不能当主题，否则同一时间格式的
  // 所有条目会被判成同一主题。至少要有中文或 2 个以上连续字母才算有效主语。
  if (!/[\u4e00-\u9fff]/.test(key) && !/[a-z]{2,}/.test(key)) return null;
  return key;
}

// 归一化单条记忆：补齐 v7.10.0 新增字段（kind/tags/hits/lastUsed）。
// 老数据没有这些字段，读的时候补上即可，不必立刻重写索引。
function normalizeMemItem(m) {
  if (!m || typeof m.fact !== 'string' || !m.fact) return null;
  return {
    fact: m.fact,
    ts: m.ts || 0,
    file: m.file || '',
    kind: normalizeMemKind(m.kind),
    tags: normalizeTags(m.tags),
    hits: m.hits > 0 ? m.hits : 0,
    lastUsed: m.lastUsed > 0 ? m.lastUsed : 0,
  };
}

// 容量淘汰：按「最近使用 → 保存时间」升序，删掉最边缘的条目。
// 为什么不用「最旧优先」：三年前记的生日依然有用，但三年前记的「这周在赶 XX 项目」
// 早就过期了——用过（hits/lastUsed）比新旧更能说明价值。
function evictMemories(arr, max) {
  if (arr.length <= max) return { kept: arr, removed: [] };
  const scored = arr.map((m, i) => ({ m: m, i: i, s: (m.lastUsed || 0) * 2 + (m.ts || 0) }));
  scored.sort((a, b) => a.s - b.s);
  const drop = new Set(scored.slice(0, arr.length - max).map(x => x.i));
  const kept = [];
  const removed = [];
  arr.forEach((m, i) => { if (drop.has(i)) removed.push(m); else kept.push(m); });
  return { kept: kept, removed: removed };
}

async function agentGetMemories(env, chatId) {
  // v7.10.1：作用域为空时直接返回空，不去读 kb/agent_mem_ 这个「公共桶」。
  // 与 memory-layers 的空作用域短路同一原则：拿不到用户标识就没有「谁的记忆」，
  // 宁可读到空，也不能让不同请求读到同一份。
  if (!kbSafeChatId(chatId)) return [];
  // v6.9.5：当绑定了 R2 时使用 60 秒 TTL 校验，防多 isolate 下长期脏读；
  // 未绑定 R2（纯内存退化模式）时不使内存缓存过期，避免纯内存模式下 60 秒后丢失记忆。
  const cached = mapGetBounded(tgAgentMemCache, chatId, env && env.R2 ? tgAgentMemExp : null);
  if (Array.isArray(cached)) return cached.slice();
  let arr = [];
  // v6.6.6 起知识库搬入 kb/ 文件夹：先读新 key；若为空再尝试旧 key，
  // 读到旧数据立即搬迁（写新 key + 删旧 key），老部署升级不丢记忆。
  let raw = await storeGet(env, agentMemKey(chatId));
  if (!raw) {
    const legacy = await storeGet(env, agentMemKeyLegacy(chatId));
    if (legacy) {
      raw = legacy;
      // v6.8.4：先确认新 key 写成功再删旧 key——之前静默写入失败后仍删旧 key 会丢数据
      const okMig = await storePutChecked(env, agentMemKey(chatId), legacy);
      if (okMig) await storeDelete(env, agentMemKeyLegacy(chatId));
    }
  }
  if (raw) {
    try {
      const p = JSON.parse(raw);
      if (Array.isArray(p)) {
        // v6.8.6 索引校验：过滤脏条目（非对象 / fact 缺失或非字符串）
        // v6.9.2 自动优化：归一化后完全重复的条目合并为最新一条
        const clean = [];
        const seen = new Map();
        const orphanMd = [];
        for (const m of p) {
          const item = normalizeMemItem(m);
          if (!item) continue;
          const n = memNorm(item.fact);
          const prevIdx = seen.get(n);
          if (prevIdx === undefined) {
            seen.set(n, clean.length);
            clean.push(item);
          } else {
            const prev = clean[prevIdx];
            if ((item.ts || 0) > (prev.ts || 0)) {
              clean[prevIdx] = item;
              if (prev.file && prev.file !== item.file) orphanMd.push(kbMemDir(chatId) + prev.file);
            } else if (item.file && item.file !== prev.file) {
              orphanMd.push(kbMemDir(chatId) + item.file);
            }
          }
        }
        // 容量淘汰同样在加载时做一次：老部署可能已经超限（旧版本没有上限）
        const ev = evictMemories(clean, memMaxItems(env));
        for (const m of ev.removed) if (m.file) orphanMd.push(kbMemDir(chatId) + m.file);
        arr = ev.kept;
        if (arr.length !== p.length) {
          // 索引写成功才删孤儿 md：写失败时保持原样，下次加载会重试
          try {
            if (await storePutChecked(env, agentMemKey(chatId), JSON.stringify(arr))) {
              if (orphanMd.length) await kbDeleteKeys(env, orphanMd);
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
  }
  // v6.6.7：回补 md 镜像 —— 老条目自动分配文件名并建 md；控制台误删的 md 也会按索引重建
  try {
    if (await kbBackfillMd(env, chatId, arr)) {
      await storePutChecked(env, agentMemKey(chatId), JSON.stringify(arr));
    }
  } catch (e) {}
  mapSetBounded(tgAgentMemCache, chatId, arr.slice(), undefined, tgAgentMemExp);
  return arr.slice();
}

// opts: { kind, tags } —— 均可省略（旧调用方式完全兼容）
async function agentSaveMemory(env, chatId, fact, opts) {
  opts = opts || {};
  if (!kbSafeChatId(chatId)) return '缺少用户标识，未保存（记忆必须归属到某个具体用户）';
  const arr = await agentGetMemories(env, chatId);
  fact = String(fact || '').trim().slice(0, MEM_FACT_MAX_CHARS);
  if (!fact) return '内容为空，未保存';
  const norm = memNorm(fact);
  if (arr.some(m => memNorm(m.fact) === norm)) return '已记住过，无需重复保存';
  // 自动优化：同一主题（"X是/为/: Y" 的同 X）只保留最新——改口即覆盖
  const key = memSubjectKey(fact);
  const replacedFiles = [];
  let oldFact = '';
  let oldTs = 0;
  if (key) {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (memSubjectKey(arr[i].fact) === key) {
        if ((arr[i].ts || 0) >= oldTs) { oldTs = arr[i].ts || 0; oldFact = arr[i].fact; }
        if (arr[i].file) replacedFiles.push(kbMemDir(chatId) + arr[i].file);
        arr.splice(i, 1);
      }
    }
  }
  const replaced = !!oldFact;
  // v6.6.7：条目带 file 字段；先写 md 镜像再写索引（索引是唯一可信源）
  const m = {
    fact: fact,
    ts: Date.now(),
    file: kbNewMemFile(),
    kind: normalizeMemKind(opts.kind),
    tags: normalizeTags(opts.tags),
    hits: 0,
    lastUsed: 0,
  };
  arr.push(m);
  // 超限淘汰：先算出要保留的集合，索引与 md 一起收敛，避免「索引里没了、md 还在」
  const ev = evictMemories(arr, memMaxItems(env));
  const finalArr = ev.kept;
  for (const rm of ev.removed) if (rm.file) replacedFiles.push(kbMemDir(chatId) + rm.file);
  const evicted = ev.removed.length;
  mapSetBounded(tgAgentMemCache, chatId, finalArr.slice(), undefined, tgAgentMemExp);
  const replNote = replaced ? '（本条自动覆盖了旧记忆《' + oldFact + '》）' : '';
  const evNote = evicted > 0 ? '（容量已满，淘汰最久未用的 ' + evicted + ' 条）' : '';
  // v6.8.3：未绑定 R2 时只留内存，必须如实告知
  if (!env.R2) {
    return '已暂存于内存（R2 未绑定，Worker 重启后会丢失；按 README 第二步绑定 R2 后可永久记住）' + replNote + '：' + fact;
  }
  const okMd = await storePutChecked(env, kbMemDir(chatId) + m.file, kbMemMarkdown(chatId, fact, m.ts));
  const okIdx = await storePutChecked(env, agentMemKey(chatId), JSON.stringify(finalArr));
  if (!okMd || !okIdx) return '记忆写入 R2 失败，已暂存于内存' + replNote + '；请检查 R2 绑定与权限后重试：' + fact;
  // 索引落盘成功后才清理被覆盖 / 被淘汰条目的 md 镜像
  if (replacedFiles.length) await kbDeleteKeys(env, replacedFiles);
  if (replaced) return '已自动更新记忆：旧《' + oldFact + '》→ 新《' + fact + '》（共' + finalArr.length + '条）' + evNote;
  return '已记住：' + fact + '（共' + finalArr.length + '条）' + evNote;
}

async function agentForgetMemory(env, chatId, keyword) {
  keyword = String(keyword || '').trim();
  if (!keyword) return { removed: 0 };
  const arr = await agentGetMemories(env, chatId);
  // v7.10.3：与 memNorm 去重口径一致，英文关键词不该因为大小写漏删。
  const kwLower = keyword.toLowerCase();
  const kept = arr.filter(m => String(m.fact || '').toLowerCase().indexOf(kwLower) < 0);
  const removed = arr.length - kept.length;
  if (removed > 0) {
    // v6.6.7：同步删除被删条目的 md 镜像
    const keptSet = new Set(kept);
    const files = [];
    for (const m of arr) {
      if (!keptSet.has(m) && m && m.file) files.push(kbMemDir(chatId) + m.file);
    }
    // v6.8.4：索引写入失败时不更新缓存并如实报错
    if (!env.R2) {
      mapSetBounded(tgAgentMemCache, chatId, kept.slice(), undefined, tgAgentMemExp);
      if (files.length) await kbDeleteKeys(env, files);
      return { removed: removed };
    }
    const okIdx = await storePutChecked(env, agentMemKey(chatId), JSON.stringify(kept));
    if (!okIdx) {
      return { removed: 0, persistError: '记忆索引写入 R2 失败，未删除任何记忆；请检查 R2 绑定与权限后重试' };
    }
    mapSetBounded(tgAgentMemCache, chatId, kept.slice(), undefined, tgAgentMemExp);
    if (files.length) await kbDeleteKeys(env, files);
  }
  return { removed: removed };
}

// ==================== L3 检索与使用度 ====================
// 分词与 prompt.js 的记忆打分口径保持一致（英文按词、中文按 2-gram，中文不拆单字）。
// v7.10.3：统一到 memory-text.js（含停用词与纯虚词 2-gram 过滤）。
// 保留同名导出，老调用方与自检不受影响。
function memTokens(s) {
  return sharedMemoryTokens(s);
}

// 单条打分：关键词命中为主，新近度与使用次数为辅。
// 「长期要求（instruction）」额外加权：这类条目一旦记下就应当长期生效，
// 不能因为一次不相关提问就被排到列表末尾。
function scoreMemoryItem(m, qTokens, now) {
  const hay = (String(m.fact || '') + ' ' + (m.tags || []).join(' ')).toLowerCase();
  let score = 0;
  for (const t of qTokens) if (t && hay.indexOf(t) !== -1) score += t.length >= 2 ? 3 : 1;
  const ageDays = Math.max(0, (now - (m.ts || now)) / 86400000);
  score += 3 / (1 + ageDays / 60);
  score += Math.min(3, (m.hits || 0) * 0.5);
  if (m.kind === 'instruction') score += 1.5;
  if (m.kind === 'profile' || m.kind === 'preference') score += 0.5;
  return score;
}

// 关键词是否真的命中。检索结果必须靠它过滤，不能拿总分过滤——
// 总分里含「新近度」加分，一条刚存但完全不相关的事实也能拿到 3 分，
// 那样「相关记忆」里就会混进一堆无关条目，模型反而被误导。
function memKeywordHits(m, qTokens) {
  const hay = (String(m.fact || '') + ' ' + (m.tags || []).join(' ')).toLowerCase();
  for (const t of qTokens) if (t && hay.indexOf(t) !== -1) return true;
  return false;
}

// 检索语义记忆。query 为空时按「新近度 + 使用度」返回，用于 /memory 列表。
async function agentSearchMemories(env, chatId, query, limit) {
  const arr = await agentGetMemories(env, chatId);
  const q = String(query || '').trim();
  const qTokens = q ? memTokens(q) : [];
  const now = Date.now();
  const max = limit > 0 ? limit : 8;
  const scored = arr.map(m => ({
    m: m,
    s: q ? scoreMemoryItem(m, qTokens, now) : ((m.lastUsed || 0) + (m.ts || 0) / 1e6),
    hit: q ? memKeywordHits(m, qTokens) : true,
  }));
  const filtered = q ? scored.filter(x => x.hit) : scored;
  filtered.sort((a, b) => b.s - a.s || (b.m.ts || 0) - (a.m.ts || 0));
  return filtered.slice(0, max).map(x => Object.assign({ score: Math.round(x.s * 10) / 10 }, x.m));
}

// 记录「这条记忆被用过」：只在 recall_memory 命中时调用，不在每轮注入时调用——
// 否则每轮都要写一次索引，写放大比收益大得多。
async function agentTouchMemories(env, chatId, facts) {
  const list = Array.isArray(facts) ? facts.filter(f => typeof f === 'string' && f) : [];
  if (!list.length || !env || !env.R2) return false;
  const arr = await agentGetMemories(env, chatId);
  // v7.10.3：按归一化文本匹配。recall 返回的 fact 可能与索引里的写法有空白差异，
  // 以前用精确字符串比较会静默漏记「这条记忆被用过」，容量淘汰随之失真。
  const set = new Set(list.map(memNorm));
  let changed = false;
  const now = Date.now();
  for (const m of arr) {
    if (set.has(memNorm(m.fact))) { m.hits = (m.hits || 0) + 1; m.lastUsed = now; changed = true; }
  }
  if (!changed) return false;
  mapSetBounded(tgAgentMemCache, chatId, arr.slice(), undefined, tgAgentMemExp);
  return await storePutChecked(env, agentMemKey(chatId), JSON.stringify(arr));
}

// 纯文本块：给「不走 Agent 循环」的普通对话模式用（entry.js 直接注入 system 消息）。
// Agent 模式不用它——那边由 prompt.js 统一编排三层记忆的顺序与预算。
function formatSemanticBlock(memories, query, budget) {
  const list = Array.isArray(memories) ? memories : [];
  if (!list.length) return '';
  const q = String(query || '').trim();
  const qTokens = q ? memTokens(q) : [];
  const now = Date.now();
  const scored = list.map(m => ({
    m: m,
    s: q ? scoreMemoryItem(m, qTokens, now) : ((m.ts || 0) / 1e6),
    hit: q ? memKeywordHits(m, qTokens) : true,
  }));
  // v7.10.3：长期要求（instruction）不看关键词命中，也不参与排序竞争 ——
  // 它是「每轮都要生效」的约束。旧实现里问一句「今天天气」就会把它过滤掉，
  // 用户明明设过「回答先给结论」，普通聊天模式却完全不生效。
  const picked = q ? scored.filter(x => x.hit || x.m.kind === 'instruction') : scored;
  picked.sort((a, b) => {
    const ai = a.m.kind === 'instruction' ? 1 : 0;
    const bi = b.m.kind === 'instruction' ? 1 : 0;
    return (bi - ai) || (b.s - a.s);
  });
  let left = budget > 0 ? budget : 1200;
  const lines = [];
  for (const x of picked) {
    const line = '- ' + (x.m.kind && x.m.kind !== 'fact' ? '［' + memKindLabelOf(x.m.kind) + '］' : '') + String(x.m.fact || '');
    if (line.length > left) continue;
    lines.push(line);
    left -= line.length;
  }
  if (!lines.length) return '';
  return '【关于用户的长期记忆】（共' + list.length + '条'
    + (lines.length < list.length ? '，按相关性注入' + lines.length + '条' : '') + '）\n'
    + lines.join('\n');
}

// 与 memory-layers 的 memKindLabel 保持一致（此处内联，避免 memory.js 反向依赖上层模块）
function memKindLabelOf(kind) {
  switch (String(kind || 'fact')) {
    case 'preference': return '偏好';
    case 'profile': return '画像';
    case 'project': return '项目';
    case 'instruction': return '长期要求';
    default: return '事实';
  }
}

async function agentMemStats(env, chatId) {
  try {
    const arr = await agentGetMemories(env, chatId);
    let chars = 0;
    const kinds = {};
    for (const m of arr) {
      chars += String(m.fact || '').length;
      const k = normalizeMemKind(m.kind);
      kinds[k] = (kinds[k] || 0) + 1;
    }
    return { count: arr.length, chars: chars, kinds: kinds, max: memMaxItems(env) };
  } catch (e) {
    return { count: 0, chars: 0, kinds: {}, max: memMaxItems(env) };
  }
}

export {
  tgAgentMemCache,
  MEM_KINDS,
  memNorm,
  memSubjectKey,
  memTokens,
  normalizeMemKind,
  normalizeTags,
  evictMemories,
  scoreMemoryItem,
  agentGetMemories,
  agentSaveMemory,
  agentForgetMemory,
  agentSearchMemories,
  agentTouchMemories,
  agentMemStats,
  formatSemanticBlock,
};
