// Agent 长期记忆（JSON 索引为唯一可信源 + md 只读镜像）（_worker.js 原第 703-704,707-784 行）

import { mapSetBounded, mapGetBounded } from '../utils.js';
import { storeGet, storePutChecked, storeDelete } from '../store/r2.js';
import { agentMemKey, agentMemKeyLegacy, kbMemDir, kbNewMemFile, kbMemMarkdown,
  kbBackfillMd, kbDeleteKeys } from '../store/kb.js';

// ==================== Telegram Agent：长期记忆 + 开关 ====================
const tgAgentMemCache = new Map();
const tgAgentMemExp = new Map();

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
  let idx = -1;
  for (const d of ['是', '为', ':', '：', '=', '＝']) {
    const i = s.indexOf(d);
    if (i !== -1 && (idx === -1 || i < idx)) idx = i;
  }
  if (idx < 2) return null;
  return s.slice(0, idx);
}

async function agentGetMemories(env, chatId) {
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
          if (!(m && typeof m.fact === 'string' && m.fact)) continue;
          const n = memNorm(m.fact);
          const prevIdx = seen.get(n);
          if (prevIdx === undefined) {
            seen.set(n, clean.length);
            clean.push(m);
          } else {
            const prev = clean[prevIdx];
            if ((m.ts || 0) > (prev.ts || 0)) {
              clean[prevIdx] = m;
              if (prev.file && prev.file !== m.file) orphanMd.push(kbMemDir(chatId) + prev.file);
            } else if (m.file && m.file !== prev.file) {
              orphanMd.push(kbMemDir(chatId) + m.file);
            }
          }
        }
        if (clean.length !== p.length) {
          // 索引写成功才删孤儿 md：写失败时保持原样，下次加载会重试
          try {
            if (await storePutChecked(env, agentMemKey(chatId), JSON.stringify(clean))) {
              if (orphanMd.length) await kbDeleteKeys(env, orphanMd);
            }
          } catch (e) {}
        }
        arr = clean;
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

async function agentSaveMemory(env, chatId, fact) {
  const arr = await agentGetMemories(env, chatId);
  fact = String(fact || '').trim().slice(0, 200);
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
  const m = { fact: fact, ts: Date.now(), file: kbNewMemFile() };
  arr.push(m);
  mapSetBounded(tgAgentMemCache, chatId, arr.slice(), undefined, tgAgentMemExp);
  const replNote = replaced ? '（本条自动覆盖了旧记忆《' + oldFact + '》）' : '';
  // v6.8.3：未绑定 R2 时只留内存，必须如实告知
  if (!env.R2) {
    return '已暂存于内存（R2 未绑定，Worker 重启后会丢失；按 README 第二步绑定 R2 后可永久记住）' + replNote + '：' + fact;
  }
  const okMd = await storePutChecked(env, kbMemDir(chatId) + m.file, kbMemMarkdown(chatId, fact, m.ts));
  const okIdx = await storePutChecked(env, agentMemKey(chatId), JSON.stringify(arr));
  if (!okMd || !okIdx) return '记忆写入 R2 失败，已暂存于内存' + replNote + '；请检查 R2 绑定与权限后重试：' + fact;
  // 索引落盘成功后才清理被覆盖条目的 md 镜像
  if (replacedFiles.length) await kbDeleteKeys(env, replacedFiles);
  if (replaced) return '已自动更新记忆：旧《' + oldFact + '》→ 新《' + fact + '》（共' + arr.length + '条）';
  return '已记住：' + fact + '（共' + arr.length + '条）';
}

async function agentForgetMemory(env, chatId, keyword) {
  keyword = String(keyword || '').trim();
  if (!keyword) return { removed: 0 };
  const arr = await agentGetMemories(env, chatId);
  const kept = arr.filter(m => String(m.fact || '').indexOf(keyword) < 0);
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

export {
  tgAgentMemCache,
  memNorm,
  memSubjectKey,
  agentGetMemories,
  agentSaveMemory,
  agentForgetMemory,
};
