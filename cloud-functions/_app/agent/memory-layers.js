// 三层记忆（L1 工作记忆 / L2 情景记忆 / L3 语义记忆）的存储、提炼、检索与注入。
//
// 为什么要有三层，而不是「一堆 fact + 一个知识库」：
//   原来的长期记忆只有一层（用户明确让我记住的事实），它能回答「我喜欢什么」，
//   却回答不了「我们上次聊到哪了」「刚才那个方案你定了没」。而对话历史会被
//   TG_HISTORY_ROUNDS / MAX_SEND_MSGS 裁掉，Web 端更是每个会话各自独立。
//   于是「越聊越像失忆」——上下文一裁，之前确认过的结论全没了。
//
//   三层各管一段，边界清楚：
//     L1 工作记忆  kb/work/<scope>.json   本次会话的要点、主题、未完成事项（易失，24h）
//     L2 情景记忆  kb/epi/<scope>.json    每次实质对话一条摘要，可按关键词/时间回溯（保留 180 天）
//     L3 语义记忆  kb/agent_mem_<scope>   用户明确告知的稳定事实与偏好（长期，带类型/标签）
//   知识库文档（kb/docs）不属于记忆：它是「共享资料」，不是「关于这个用户的经历」。
//
// 三条硬约束（和项目里其它增强一致）：
//   1) 不额外调用大模型 —— 摘要用确定性抽取（首句 + 结论句 + 关键词），零费用零延迟；
//   2) 写入失败绝不影响回答 —— 所有写回都 try/catch，只在 /healthz 与 /memory 里如实体现；
//   3) 有容量与预算上限 —— 工作记忆 12 轮、情景 200 条、注入 ≤ 1800 字符，防无限膨胀。

import { mapSetBounded, mapGetBounded } from '../utils.js';
import { storeGet, storePutChecked, storeDelete } from '../store/r2.js';
import { kbSafeChatId } from '../store/kb.js';
import { agentSearchMemories, agentMemStats } from './memory.js';

// ==================== 存储布局 ====================
// 与 kb/ 下的其它数据放在同一棵目录树里：控制台能直接浏览，备份与生命周期规则也统一。
const WORK_PREFIX = 'kb/work/';
const EPI_PREFIX = 'kb/epi/';

// 作用域清洗：chatId 可能来自 Telegram（数字）、微信（ilink id）或 Web（web_xxx / webu_xxx）。
// 只保留字母数字下划线中划线，防止 ../ 之类的路径穿越污染 kb/ 目录。
//
// 空作用域返回空串，绝不兜底成 'default'：一旦兜底，所有拿不到 chatId 的请求
// （外部调用、旧缓存页面、异常通道）会共用 kb/work/default.json，
// 一个用户就能读到另一个用户的对话摘要。宁可「没有记忆」，也不能串号。
// 下面每个读写函数都对空 scope 短路：读返回空、写返回 false。
function memScope(chatId) {
  return kbSafeChatId(chatId) || '';
}
function workKey(chatId) {
  const s = memScope(chatId);
  return s ? WORK_PREFIX + s + '.json' : '';
}
function epiKey(chatId) {
  const s = memScope(chatId);
  return s ? EPI_PREFIX + s + '.json' : '';
}

// ==================== 容量与预算 ====================
// 全部可用环境变量覆盖，方便按部署规模调（也方便自检把上限压到很小来验证淘汰逻辑）。
const DEFAULTS = {
  workTurns: 12,        // L1 保留最近多少轮要点
  workTurnChars: 240,   // 单条要点上限（用户句 + 结论句合计）
  workTtlMs: 24 * 3600 * 1000,   // 工作记忆超过 24 小时视为上一场会话
  epiMax: 200,          // L2 每个用户最多保留多少条
  epiTtlMs: 180 * 24 * 3600 * 1000, // L2 保留 180 天
  epiMergeMs: 20 * 60 * 1000,   // 20 分钟内的同主题对话合并成一条，避免「一句一条」
  injectChars: 1800,    // L1+L2 注入提示词的总字符上限
  recallMax: 6,         // 一次召回最多返回几条
};

function intEnv(env, name, def, min, max) {
  const n = parseInt((env && env[name]) || '', 10);
  if (!(n > 0)) return def;
  return Math.max(min, Math.min(max, n));
}
function limitsOf(env) {
  return {
    workTurns: intEnv(env, 'MEMORY_WORK_TURNS', DEFAULTS.workTurns, 2, 40),
    workTurnChars: intEnv(env, 'MEMORY_WORK_TURN_CHARS', DEFAULTS.workTurnChars, 80, 800),
    workTtlMs: DEFAULTS.workTtlMs,
    epiMax: intEnv(env, 'MEMORY_EPISODE_MAX', DEFAULTS.epiMax, 10, 1000),
    epiTtlMs: DEFAULTS.epiTtlMs,
    epiMergeMs: DEFAULTS.epiMergeMs,
    injectChars: intEnv(env, 'MEMORY_INJECT_CHARS', DEFAULTS.injectChars, 400, 8000),
    recallMax: intEnv(env, 'MEMORY_RECALL_MAX', DEFAULTS.recallMax, 1, 12),
  };
}

// 总开关：MEMORY_LAYERS=0 退回「只有 L3 长期记忆」的旧行为（L1/L2 不读不写）。
function layersEnabled(env) {
  return String((env && env.MEMORY_LAYERS) || '1') !== '0';
}
// 自动写回开关：只读部署（比如纯展示站）可以关掉，省掉每轮的两次写入。
function autoWriteEnabled(env) {
  return layersEnabled(env) && String((env && env.MEMORY_AUTO_WRITE) || '1') !== '0';
}

// ==================== 实例内统计（供 /healthz 排障） ====================
const memCounters = {
  turnsRecorded: 0,
  workWrites: 0,
  episodesWritten: 0,
  episodesMerged: 0,
  recalls: 0,
  recallHits: 0,
  writeFails: 0,
  lastError: '',
};
function memoryDiag() {
  return Object.assign({}, memCounters);
}
function __resetMemoryDiag() {
  for (const k of Object.keys(memCounters)) memCounters[k] = typeof memCounters[k] === 'number' ? 0 : '';
}

// ==================== 文本工具：摘要与主题词 ====================
// 停用词表：中文按「整词」与「2-gram」两种形态都要拦，否则「什么/可以/一下」会占满主题位。
const TOPIC_STOP = new Set([
  '的', '了', '是', '我', '你', '他', '她', '它', '们', '在', '和', '与', '就', '不', '也', '都',
  '这', '那', '有', '吗', '呢', '啊', '吧', '呀', '把', '被', '给', '对', '从', '到', '而', '并',
  '一个', '一下', '什么', '怎么', '怎样', '如何', '可以', '能否', '是否', '我们', '你们', '他们',
  '这个', '那个', '这些', '那些', '现在', '然后', '就是', '还是', '没有', '因为', '所以', '如果',
  '但是', '或者', '以及', '进行', '需要', '应该', '已经', '可能', '之后', '之前', '时候', '问题',
  '东西', '帮我', '请问', '告诉', '一下', '一些', '这样', '那样', '自己', '知道', '觉得', '想要',
  'the', 'and', 'for', 'with', 'that', 'this', 'you', 'are', 'was', 'have', 'has', 'but', 'not',
  'can', 'will', 'would', 'could', 'should', 'from', 'they', 'them', 'then', 'than', 'there',
  'what', 'when', 'where', 'which', 'who', 'how', 'why', 'all', 'any', 'our', 'out', 'get', 'got',
]);

// 折叠空白、去掉 Markdown 标记噪音、截断。摘要要短，不能把代码块整段搬进记忆。
function clipText(s, max) {
  let t = String(s == null ? '' : s);
  t = t.replace(/```[\s\S]*?```/g, ' （代码块） ');
  t = t.replace(/`([^`]*)`/g, '$1');
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/^[ \t]*[#>*+-]+[ \t]*/gm, '');
  t = t.replace(/\s+/g, ' ').trim();
  const cap = max > 0 ? max : 240;
  if (t.length <= cap) return t;
  // 尽量在句读处截断，读起来像一句话而不是被砍掉半截
  const head = t.slice(0, cap);
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('；'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('. '));
  if (cut > cap * 0.5) return head.slice(0, cut + 1);
  return head + '…';
}

function bump(map, key, n) {
  map.set(key, (map.get(key) || 0) + n);
}

// 主题词抽取：英文按词、中文按「短语（2~6 字）+ 2-gram」。
// 短语权重高于 2-gram，这样「手机号」「甲骨文云」不会被拆成两个碎片顶上去；
// 最后再做一次包含去重（已选「手机号」就不再选「手机」）。
function extractTopics(text, limit) {
  const src = String(text || '').toLowerCase();
  const counts = new Map();
  const segs = src.split(/[^a-z0-9\u4e00-\u9fff]+/);
  for (const seg of segs) {
    if (!seg) continue;
    if (/^[a-z0-9]+$/.test(seg)) {
      if (seg.length >= 3 && !TOPIC_STOP.has(seg)) bump(counts, seg, 2);
      continue;
    }
    for (const part of seg.split(/[a-z0-9]+/)) {
      if (!part) continue;
      if (part.length >= 2 && part.length <= 6 && !TOPIC_STOP.has(part)) bump(counts, part, 3);
      for (let i = 0; i + 2 <= part.length; i++) {
        const g = part.slice(i, i + 2);
        if (!TOPIC_STOP.has(g)) bump(counts, g, 1);
      }
    }
  }
  const ranked = [...counts.entries()]
    .filter(([k, v]) => v >= 2 && k.length >= 2)
    .sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length));
  const out = [];
  for (const [k] of ranked) {
    if (out.some(o => o.indexOf(k) !== -1)) continue;
    out.push(k);
    if (out.length >= (limit > 0 ? limit : 6)) break;
  }
  return out;
}

// 结论句：回答的第一句往往就是结论；没有句读时取开头一段。
// 这一句比整段回答更适合进记忆——用户回头要的是「当时怎么定的」，不是全文。
function firstConclusion(text, max) {
  const t = clipText(text, 600);
  if (!t) return '';
  const m = t.match(/^(.{6,}?[。！？.!?])/);
  const s = m ? m[1] : t;
  return clipText(s, max > 0 ? max : 160);
}

// 判断这一轮是否「值得记一条情景记忆」。
// 纯问候、单字追问不记；调过工具、存过文档、回答够长、或用户说了较长的一段话，才记。
const CHITCHAT_RE = new RegExp(
  '^(' + ['你好', '您好', 'hi', 'hello', '嗨', '在吗', '谢谢', '多谢', '感谢', 'thanks', 'thx',
    'ok', 'okay', '好的', '好', '嗯', '收到', '明白', '再见', '拜拜', '晚安', '测试', 'test',
    '你是谁', '你能做什么', '继续', '接着'].join('|') + ')[\\s!！。.~，,、?？]*$', 'i');

function shouldRecordEpisode(digest) {
  if (!digest) return false;
  const user = String(digest.user || '');
  if (CHITCHAT_RE.test(user)) return false;
  if (digest.docs && digest.docs.length) return true;
  if (digest.tools && digest.tools.length) return true;
  if (user.length >= 24) return true;
  if (String(digest.ai || '').length >= 240) return true;
  return false;
}

// 把一轮对话压成一条 digest。确定性、无模型调用、长度可控。
function digestTurn(input) {
  input = input || {};
  const user = clipText(input.userText, 120);
  const aiFull = String(input.assistantText || '');
  const ai = firstConclusion(aiFull, 160);
  const tools = Array.isArray(input.tools) ? input.tools.filter(Boolean).slice(0, 6) : [];
  const docs = Array.isArray(input.docs) ? input.docs.filter(Boolean).slice(0, 4) : [];
  const paused = !!input.paused;
  // 「未完成」判定：本轮被暂停，或模型在结尾追问/要求补充信息。
  const tail = clipText(aiFull.slice(-120), 120);
  const pending = paused || /[?？]$/.test(tail) || /(请提供|请补充|需要你|你希望|要不要|还需要)/.test(tail);
  return {
    ts: Date.now(),
    user: user,
    ai: ai,
    topics: extractTopics(user + ' ' + ai, 6),
    tools: tools,
    docs: docs,
    pending: pending,
  };
}

// ==================== 写操作串行化 ====================
// 记忆的写回是「读 → 改 → 写」，同一用户连发两条消息时两个写回会读到同一份旧数据，
// 后写的把前一条整个覆盖掉——表现就是「刚说的话没进记忆」。
// 这里在 isolate 内用一条 per-scope 的 Promise 链把写操作排成队；跨 isolate 仍有竞争，
// 但那时丢的是「一条摘要」而不是「整轮对话」，且不影响任何回答。
// 链尾完成后自动从 Map 删除，避免长驻 isolate 泄漏。
const writeChains = new Map();
function withWriteLock(scope, fn) {
  if (!scope) return Promise.resolve(fn());
  const prev = writeChains.get(scope) || Promise.resolve();
  const next = prev.then(fn, fn);   // 前一个失败也要继续，否则一次抖动会卡死后续写入
  const tail = next.then(() => {}, () => {});
  writeChains.set(scope, tail);
  tail.then(() => { if (writeChains.get(scope) === tail) writeChains.delete(scope); });
  return next;
}

// ==================== L1 工作记忆 ====================
const workCache = new Map();
const workExp = new Map();
// 缓存 TTL 由 mapSetBounded 的默认值（60 秒）控制，见 utils.js。
// 这里不再单独定义一份常量：定义了却不用，读代码的人会以为它能调。

function emptyWork(scope) {
  const now = Date.now();
  return { v: 1, scope: scope, startedAt: now, updatedAt: now, turns: [], topics: [], openTasks: [] };
}

function normalizeWork(raw, scope) {
  if (!raw || typeof raw !== 'object') return null;
  const turns = Array.isArray(raw.turns)
    ? raw.turns.filter(t => t && typeof t === 'object' && (t.user || t.ai)).slice(-40)
    : [];
  return {
    v: 1,
    scope: String(raw.scope || scope),
    startedAt: raw.startedAt || raw.updatedAt || Date.now(),
    updatedAt: raw.updatedAt || Date.now(),
    turns: turns,
    topics: Array.isArray(raw.topics) ? raw.topics.filter(x => typeof x === 'string').slice(0, 12) : [],
    openTasks: Array.isArray(raw.openTasks) ? raw.openTasks.filter(x => typeof x === 'string').slice(0, 8) : [],
  };
}

// 读工作记忆。过期（默认 24 小时）视为上一场会话：清空轮次但保留主题，避免「昨天的待办」缠着今天。
async function getWorking(env, chatId, opts) {
  if (!layersEnabled(env) || !env || !env.R2) return null;
  const scope = memScope(chatId);
  if (!scope) return null;
  const cached = mapGetBounded(workCache, scope, env.R2 ? workExp : null);
  if (cached) return JSON.parse(JSON.stringify(cached));
  let work = null;
  try {
    const raw = await storeGet(env, workKey(scope));
    if (raw) work = normalizeWork(JSON.parse(raw), scope);
  } catch (e) { work = null; }
  if (work) {
    const ttl = limitsOf(env).workTtlMs;
    if (Date.now() - (work.updatedAt || 0) > ttl) {
      work = { v: 1, scope: scope, startedAt: Date.now(), updatedAt: Date.now(), turns: [], topics: work.topics.slice(0, 6), openTasks: [] };
    }
  }
  if (work) mapSetBounded(workCache, scope, work, undefined, workExp);
  return work;
}

async function saveWorking(env, chatId, work) {
  if (!env || !env.R2) return false;
  const scope = memScope(chatId);
  if (!scope) return false;
  work.updatedAt = Date.now();
  mapSetBounded(workCache, scope, JSON.parse(JSON.stringify(work)), undefined, workExp);
  const ok = await storePutChecked(env, workKey(scope), JSON.stringify(work));
  if (!ok) { memCounters.writeFails++; memCounters.lastError = 'work_write_failed'; }
  return ok;
}

// 追加一轮到工作记忆：轮次超限从最旧丢弃，主题做加权合并（新主题优先），
// openTasks 只保留最近 6 条且去重——它是「下次接着做」的清单，不是日志。
// 整个「读-改-写」放在写锁里，避免同用户连发两条时后一条覆盖前一条。
async function appendWorkingTurn(env, chatId, digest) {
  if (!layersEnabled(env) || !env || !env.R2) return false;
  const scope = memScope(chatId);
  if (!scope) return false;
  const lim = limitsOf(env);
  return await withWriteLock(scope, async () => {
    let work = (await getWorking(env, scope)) || emptyWork(scope);
    const entry = {
      ts: digest.ts || Date.now(),
      user: clipText(digest.user, Math.round(lim.workTurnChars * 0.5)),
      ai: clipText(digest.ai, Math.round(lim.workTurnChars * 0.5)),
      topics: (digest.topics || []).slice(0, 6),
      tools: (digest.tools || []).slice(0, 6),
      docs: (digest.docs || []).slice(0, 4),
      pending: !!digest.pending,
    };
    work.turns.push(entry);
    while (work.turns.length > lim.workTurns) work.turns.shift();

    // 主题：把本轮主题插到最前（越新越靠前），去重后截断
    const merged = [];
    for (const t of entry.topics.concat(work.topics)) {
      if (t && merged.indexOf(t) === -1) merged.push(t);
    }
    work.topics = merged.slice(0, 10);

    // 未完成事项：本轮 pending 就记一条，否则把已完成的（同主题）清掉
    const taskText = entry.pending ? clipText(entry.user, 80) : '';
    const keptTasks = work.openTasks.filter(t => {
      if (!taskText) return !entry.topics.some(tp => t.indexOf(tp) !== -1);
      return t !== taskText;
    });
    if (taskText) keptTasks.unshift(taskText);
    work.openTasks = keptTasks.slice(0, 6);

    const ok = await saveWorking(env, scope, work);
    if (ok) memCounters.workWrites++;
    return ok;
  });
}

async function clearWorking(env, chatId) {
  const scope = memScope(chatId);
  if (!scope) return true;
  workCache.delete(scope);
  workExp.delete(scope);
  if (!env || !env.R2) return true;
  try { await storeDelete(env, workKey(scope)); } catch (e) {}
  return true;
}

// ==================== L2 情景记忆 ====================
const epiCache = new Map();
const epiExp = new Map();

function normalizeEpisodes(raw, scope) {
  const items = raw && Array.isArray(raw.items) ? raw.items : [];
  return {
    v: 1,
    scope: String((raw && raw.scope) || scope),
    updatedAt: (raw && raw.updatedAt) || Date.now(),
    items: items
      .filter(e => e && typeof e === 'object' && (e.title || e.summary))
      .map(e => ({
        id: String(e.id || ('ep_' + (e.ts || Date.now()).toString(36))),
        ts: e.ts || Date.now(),
        title: clipText(e.title, 60),
        summary: clipText(e.summary, 320),
        topics: Array.isArray(e.topics) ? e.topics.filter(x => typeof x === 'string').slice(0, 8) : [],
        tools: Array.isArray(e.tools) ? e.tools.filter(x => typeof x === 'string').slice(0, 6) : [],
        docs: Array.isArray(e.docs) ? e.docs.filter(x => typeof x === 'string').slice(0, 4) : [],
        turns: e.turns > 0 ? e.turns : 1,
      }))
      .sort((a, b) => a.ts - b.ts),
  };
}

async function getEpisodes(env, chatId) {
  if (!layersEnabled(env) || !env || !env.R2) return [];
  const scope = memScope(chatId);
  if (!scope) return [];
  const cached = mapGetBounded(epiCache, scope, env.R2 ? epiExp : null);
  if (cached) return cached.items.slice();
  let data = null;
  try {
    const raw = await storeGet(env, epiKey(scope));
    if (raw) data = normalizeEpisodes(JSON.parse(raw), scope);
  } catch (e) { data = null; }
  const items = data ? data.items : [];
  mapSetBounded(epiCache, scope, { items: items }, undefined, epiExp);
  return items.slice();
}

async function saveEpisodes(env, chatId, items) {
  if (!env || !env.R2) return false;
  const scope = memScope(chatId);
  if (!scope) return false;
  const lim = limitsOf(env);
  const cutoff = Date.now() - lim.epiTtlMs;
  // 先按时间淘汰过期条目，再按容量保留最近的 epiMax 条。
  // 情景记忆是「流水账」，越老价值越低；不做加权淘汰，保持可预期。
  const kept = items
    .filter(e => e && e.ts >= cutoff)
    .sort((a, b) => a.ts - b.ts)
    .slice(-lim.epiMax);
  mapSetBounded(epiCache, scope, { items: kept }, undefined, epiExp);
  const ok = await storePutChecked(env, epiKey(scope), JSON.stringify({ v: 1, scope: scope, updatedAt: Date.now(), items: kept }));
  if (!ok) { memCounters.writeFails++; memCounters.lastError = 'episode_write_failed'; }
  return ok;
}

function topicOverlap(a, b) {
  if (!a || !b || !a.length || !b.length) return 0;
  const set = new Set(b);
  let n = 0;
  for (const t of a) if (set.has(t)) n++;
  return n / Math.min(a.length, b.length);
}

// 合并两条摘要：保留「首条结论」+「最新结论」，中间用省略号略过。
// 旧实现是 clipText(旧 + '；' + 新, 320)，而 clipText 从头部截断——合并次数越多，
// 最新的结论越容易被砍掉，最后变成「ts 是最新的、内容是第一次聊的」这种最坏错配：
// 用户追问「刚才说的第三点」，模型翻到一条时间最新、内容却停在第一轮的记忆。
function mergeSummary(oldS, newS, cap) {
  const a = String(oldS || '');
  const b = String(newS || '');
  if (!b) return clipText(a, cap);
  if (!a) return clipText(b, cap);
  const budget = Math.max(80, cap - 4);          // 留出「；…；」的位置
  const head = clipText(a, Math.max(40, Math.round(budget * 0.55)));
  const tail = clipText(b, Math.max(40, budget - head.length - 3));
  const out = head + '；…；' + tail;
  return out.length <= cap ? out : head + '；…；' + clipText(b, Math.max(20, cap - head.length - 3));
}

// 追加一条情景记忆。20 分钟内的同主题对话合并成一条：
// 「先问额度、再问怎么开、再问计费」本质是同一件事，拆成三条只会让回忆时读到三段碎片。
async function appendEpisode(env, chatId, digest) {
  if (!layersEnabled(env) || !env || !env.R2) return false;
  const scope = memScope(chatId);
  if (!scope) return false;
  const lim = limitsOf(env);
  return await withWriteLock(scope, async () => {
    const items = await getEpisodes(env, scope);
    const now = digest.ts || Date.now();
    const title = clipText(digest.user || digest.ai, 50);
    const summary = clipText(digest.ai || digest.user, 320);
    const last = items.length ? items[items.length - 1] : null;
    if (last && now - last.ts <= lim.epiMergeMs && topicOverlap(digest.topics || [], last.topics) >= 0.5) {
      last.ts = now;
      last.turns = (last.turns || 1) + 1;
      last.summary = mergeSummary(last.summary, summary, 320);
      last.topics = [...new Set((last.topics || []).concat(digest.topics || []))].slice(0, 8);
      last.tools = [...new Set((last.tools || []).concat(digest.tools || []))].slice(0, 6);
      last.docs = [...new Set((last.docs || []).concat(digest.docs || []))].slice(0, 4);
      memCounters.episodesMerged++;
    } else {
      items.push({
        id: 'ep_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 6),
        ts: now,
        title: title,
        summary: summary,
        topics: (digest.topics || []).slice(0, 8),
        tools: (digest.tools || []).slice(0, 6),
        docs: (digest.docs || []).slice(0, 4),
        turns: 1,
      });
      memCounters.episodesWritten++;
    }
    return await saveEpisodes(env, scope, items);
  });
}

async function clearEpisodes(env, chatId) {
  const scope = memScope(chatId);
  if (!scope) return true;
  epiCache.delete(scope);
  epiExp.delete(scope);
  if (!env || !env.R2) return true;
  try { await storeDelete(env, epiKey(scope)); } catch (e) {}
  return true;
}

async function forgetEpisodes(env, chatId, keyword) {
  const kw = String(keyword || '').trim();
  if (!kw) return { removed: 0 };
  const scope = memScope(chatId);
  if (!scope) return { removed: 0 };
  const kwLower = kw.toLowerCase();
  // 读-改-写整段都在锁里：否则「读完之后、加锁之前」新写入的一条会被这次删除覆盖掉。
  const removed = await withWriteLock(scope, async () => {
    const items = await getEpisodes(env, scope);
    const kept = items.filter(e => {
      const hay = (e.title + ' ' + e.summary + ' ' + (e.topics || []).join(' ')).toLowerCase();
      return hay.indexOf(kwLower) === -1;
    });
    const n = items.length - kept.length;
    if (n > 0) await saveEpisodes(env, scope, kept);
    return n;
  });
  return { removed: removed };
}

// ==================== 检索（跨三层） ====================
function daysBetween(a, b) { return Math.abs(a - b) / 86400000; }

// 情景记忆打分：关键词命中（正文/标题/主题）+ 时间衰减。
// 时间衰减用 1/(1+天数/30)：30 天前的条目权重减半，但不会被判成 0——
// 「三个月前聊过的那套方案」恰恰是最需要被想起来的。
// 情景条目是否真的命中关键词。与语义记忆同理：分数里含时间衰减加分，
// 刚聊完的无关内容也能拿高分，所以过滤必须看「有没有命中」，不能看总分。
function episodeHits(ep, qLower, qTokens) {
  const hay = (ep.title + ' ' + ep.summary + ' ' + (ep.topics || []).join(' ') + ' ' + (ep.docs || []).join(' ')).toLowerCase();
  if (qLower && hay.indexOf(qLower) !== -1) return true;
  for (const t of qTokens) if (t && hay.indexOf(t) !== -1) return true;
  return false;
}

function scoreEpisode(ep, qLower, qTokens, now) {
  const hay = (ep.title + ' ' + ep.summary + ' ' + (ep.topics || []).join(' ') + ' ' + (ep.docs || []).join(' ')).toLowerCase();
  let score = 0;
  if (qLower && hay.indexOf(qLower) !== -1) score += 8;
  for (const t of qTokens) {
    if (t && hay.indexOf(t) !== -1) score += t.length >= 2 ? 3 : 1;
  }
  for (const tp of (ep.topics || [])) {
    if (qTokens.some(t => tp.indexOf(t) !== -1)) score += 2;
  }
  const recency = 4 / (1 + daysBetween(now, ep.ts) / 30);
  return score + recency;
}

function queryTokens(q) {
  const out = [];
  for (const seg of String(q || '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/)) {
    if (!seg) continue;
    out.push(seg);
    if (/[\u4e00-\u9fff]/.test(seg)) {
      for (let i = 0; i + 2 <= seg.length; i++) out.push(seg.slice(i, i + 2));
    }
  }
  return [...new Set(out)].filter(t => !TOPIC_STOP.has(t));
}

// 注入用：从情景记忆里挑出与本次提问最相关的几条。
// 与 recallMemory 的区别是「静默」——没有相关条目时返回空数组，不做任何 I/O。
// 没有查询词就没有「相关」可言：返回空，而不是把最近几条贴上
// 「与本次提问相关的过往对话」的标签塞给模型——那等于让模型把无关历史当上下文用。
function pickRelevantEpisodes(episodes, query, limit) {
  const list = Array.isArray(episodes) ? episodes : [];
  if (!list.length) return [];
  const q = String(query || '').trim();
  if (!q) return [];
  const qLower = q.toLowerCase();
  const qTokens = queryTokens(q);
  const now = Date.now();
  const scored = list.map(e => ({ e: e, s: scoreEpisode(e, qLower, qTokens, now) }));
  const picked = scored.filter(x => episodeHits(x.e, qLower, qTokens));
  picked.sort((a, b) => b.s - a.s);
  return picked.slice(0, limit > 0 ? limit : 3).map(x => x.e);
}

// 主入口：一次把三层都查了。任何一层失败都不影响其它层（记忆是增强，不是依赖）。
async function recallMemory(env, chatId, query, opts) {
  opts = opts || {};
  const t0 = Date.now();
  const lim = limitsOf(env);
  const limit = Math.max(1, Math.min(opts.limit > 0 ? opts.limit : lim.recallMax, 12));
  const layer = String(opts.layer || 'all').toLowerCase();
  const q = String(query || '').trim();
  const qLower = q.toLowerCase();
  const qTokens = queryTokens(q);
  const now = Date.now();
  const out = { ok: false, query: q, layer: layer, work: null, episodes: [], semantic: [], ms: 0 };

  if (layersEnabled(env)) {
    if (layer === 'all' || layer === 'work') {
      try { out.work = await getWorking(env, chatId); } catch (e) { out.work = null; }
    }
    if (layer === 'all' || layer === 'episodic' || layer === 'epi') {
      try {
        const items = await getEpisodes(env, chatId);
        out.episodes = items
          .map(e => ({ e: e, s: q ? scoreEpisode(e, qLower, qTokens, now) : 4 / (1 + daysBetween(now, e.ts) / 30) }))
          .filter(x => (q ? episodeHits(x.e, qLower, qTokens) : true))
          .sort((a, b) => b.s - a.s)
          .slice(0, limit)
          .map(x => Object.assign({ score: Math.round(x.s * 10) / 10 }, x.e));
      } catch (e) { out.episodes = []; }
    }
  }
  if (layer === 'all' || layer === 'semantic' || layer === 'fact') {
    try { out.semantic = await agentSearchMemories(env, chatId, q, limit); } catch (e) { out.semantic = []; }
  }

  memCounters.recalls++;
  if (out.episodes.length || out.semantic.length || (out.work && out.work.turns.length)) memCounters.recallHits++;
  out.ms = Date.now() - t0;
  out.ok = !!(out.episodes.length || out.semantic.length || (out.work && out.work.turns.length));
  return out;
}

// 工具输出（recall_memory）。格式固定、带层标签，模型只要学会一种读法。
function formatRecallResult(r) {
  const lines = [];
  if (r.work && r.work.turns && r.work.turns.length) {
    lines.push('【L1 工作记忆】本次会话 ' + r.work.turns.length + ' 轮'
      + (r.work.topics && r.work.topics.length ? '｜主题：' + r.work.topics.slice(0, 6).join('、') : ''));
    for (const t of r.work.turns.slice(-4)) {
      lines.push('- ' + fmtClock(t.ts) + ' 用户问：' + t.user + (t.ai ? ' → 结论：' + t.ai : ''));
    }
    if (r.work.openTasks && r.work.openTasks.length) {
      lines.push('- 未完成：' + r.work.openTasks.slice(0, 3).join('；'));
    }
  }
  if (r.episodes && r.episodes.length) {
    lines.push('【L2 情景记忆】相关过往对话 ' + r.episodes.length + ' 条');
    for (const e of r.episodes) {
      lines.push('- ' + fmtDate(e.ts) + '《' + e.title + '》：' + e.summary
        + (e.docs && e.docs.length ? '（涉及文档：' + e.docs.join('、') + '）' : ''));
    }
  }
  if (r.semantic && r.semantic.length) {
    lines.push('【L3 语义记忆】用户稳定事实 ' + r.semantic.length + ' 条');
    for (const m of r.semantic) lines.push('- ' + memKindLabel(m.kind) + '：' + m.fact);
  }
  if (!lines.length) {
    return '三层记忆里都没有与「' + (r.query || '（空）') + '」相关的内容。'
      + '可以换更短的关键词再试；确实没聊过就直接说没有，不要编造。';
  }
  return lines.join('\n')
    + '\n\n> （记忆只是参考：L3 是用户明确告知的稳定事实，优先级最高；L1/L2 是对话记录，'
    + '与当前说法冲突时以用户此刻的说法为准，并说明「之前记的是…」）';
}

// ==================== 时间渲染 ====================
// 记忆里的时间一律按北京时间渲染。EdgeOne 边缘节点跑在 UTC，若直接用 getHours()，
// 提示词里会同时出现「当前时间：10:03（北京时间）」和「L1 最近更新 02:03」，
// 模型看到两个矛盾的时间，很可能照着后者回答「现在是凌晨两点」——直接把错误时间
// 交给用户。Intl 的 timeZone 是唯一可靠做法（手算 +8 在夏令时/自定义时区下会错）。
const MEM_TZ = 'Asia/Shanghai';
const MEM_TZ_FALLBACK_MS = 8 * 3600 * 1000;

// 格式化器只建一次：Intl.DateTimeFormat 的构造比 format 贵得多（实测约 0.16ms/次），
// 而一轮提示词要渲染 4~6 个时间戳。这里缓存失败结果，避免缺少完整 ICU 时反复抛异常。
let memFmt;
let memFmtReady = false;
function memFormatter() {
  if (memFmtReady) return memFmt;
  memFmtReady = true;
  try {
    memFmt = new Intl.DateTimeFormat('zh-CN', {
      timeZone: MEM_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch (e) {
    memFmt = null;
  }
  return memFmt;
}

function memTimeParts(ts) {
  const t = (typeof ts === 'number' && ts > 0) ? ts : Date.now();
  const fmt = memFormatter();
  if (fmt) {
    try {
      const o = {};
      for (const p of fmt.formatToParts(new Date(t))) o[p.type] = p.value;
      // hour12:false 在部分实现里会把午夜给成 24
      if (o.hour === '24') o.hour = '00';
      if (o.year && o.month && o.day && o.hour && o.minute) {
        return { y: o.year, m: o.month, d: o.day, hh: o.hour, mm: o.minute };
      }
    } catch (e) { /* 落到下面的手算兜底 */ }
  }
  const d = new Date(t + MEM_TZ_FALLBACK_MS);
  const p = n => String(n).padStart(2, '0');
  return {
    y: String(d.getUTCFullYear()), m: p(d.getUTCMonth() + 1), d: p(d.getUTCDate()),
    hh: p(d.getUTCHours()), mm: p(d.getUTCMinutes()),
  };
}
function fmtDate(ts) {
  const p = memTimeParts(ts);
  return p.y + '-' + p.m + '-' + p.d;
}
function fmtClock(ts) {
  const p = memTimeParts(ts);
  return p.hh + ':' + p.mm;
}
function memKindLabel(kind) {
  switch (String(kind || 'fact')) {
    case 'preference': return '偏好';
    case 'profile': return '画像';
    case 'project': return '项目';
    case 'instruction': return '长期要求';
    default: return '事实';
  }
}

// ==================== 提示词注入 ====================
// L1 只给「主题 + 最近结论 + 未完成」，不重复原始对话：
// 原始历史已经在 messages 里，再抄一遍既费 token 又容易让模型以为有两份对话。
function formatWorkingBlock(work, budget) {
  if (!work || !work.turns || !work.turns.length) return '';
  const cap = budget > 0 ? budget : 900;
  const lines = [];
  lines.push('【L1 会话工作记忆】（本次对话已 ' + work.turns.length + ' 轮，最近更新 '
    + fmtClock(work.updatedAt || work.turns[work.turns.length - 1].ts) + '；'
    + '原始对话可能已被裁剪，这里是保留的要点）');
  if (work.topics && work.topics.length) lines.push('主题：' + work.topics.slice(0, 8).join('、'));
  const recent = work.turns.slice(-3);
  for (const t of recent) {
    const line = '- ' + fmtClock(t.ts) + ' 用户问「' + t.user + '」→ ' + (t.ai || '（无结论）');
    if (lines.join('\n').length + line.length > cap) break;
    lines.push(line);
  }
  if (work.openTasks && work.openTasks.length) {
    const line = '- 未完成：' + work.openTasks.slice(0, 3).join('；');
    if (lines.join('\n').length + line.length <= cap) lines.push(line);
  }
  return lines.join('\n');
}

function formatEpisodesBlock(episodes, budget) {
  const list = Array.isArray(episodes) ? episodes : [];
  if (!list.length) return '';
  const cap = budget > 0 ? budget : 900;
  const lines = ['【L2 相关情景记忆】（与本次提问相关的过往对话，供参考）'];
  for (const e of list) {
    const line = '- ' + fmtDate(e.ts) + '《' + e.title + '》：' + clipText(e.summary, 160);
    if (lines.join('\n').length + line.length > cap) break;
    lines.push(line);
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

// 组装 L1 + L2 两块文本（L3 由 prompt.js 单独按相关性注入，逻辑保持不变）。
// 预算必须是硬上限：旧写法 epiBudget = Math.max(300, total - workText.length) 在
// total 被调到 400 时会给出 180 + 300 = 480，比预算还多——「限制」变成了「建议」。
// 现在剩余额度不足 120 字符就干脆不注入 L2（半句话的历史比没有历史更容易误导）。
function formatLayeredMemory(layered, opts) {
  opts = opts || {};
  if (!layered) return { text: '', chars: 0 };
  const total = opts.budget > 0 ? opts.budget : DEFAULTS.injectChars;
  const workBudget = Math.round(total * 0.45);
  const workText = formatWorkingBlock(layered.work, workBudget);
  const epiBudget = total - workText.length - 2;   // 2 = 中间那个 '\n\n'
  const epiText = epiBudget >= 120 ? formatEpisodesBlock(layered.episodes, epiBudget) : '';
  const parts = [workText, epiText].filter(Boolean);
  const text = parts.join('\n\n');
  return { text: text, chars: text.length };
}

// ==================== 每轮写回 ====================
// 唯一写入口。调用方（loop.js）会套一层时间上限，这里再兜一次 try/catch：
// 记忆写不进去只该少一条记录，绝不能让用户等答案等到超时。
async function recordTurnMemory(env, chatId, turn, opts) {
  opts = opts || {};
  if (!autoWriteEnabled(env)) return { ok: false, reason: 'disabled' };
  if (!env || !env.R2) return { ok: false, reason: 'no_store' };
  const digest = digestTurn(turn);
  if (!digest.user && !digest.ai) return { ok: false, reason: 'empty' };
  const out = { ok: true, work: false, episode: false, digest: digest };
  try {
    out.work = await appendWorkingTurn(env, chatId, digest);
    if (opts.episode !== false && shouldRecordEpisode(digest)) {
      // 情景记忆可以写在与工作记忆不同的作用域：
      // Web 端 L1 跟会话（web_<sid>）、L2 跟浏览器（webu_<client_id>），
      // 否则「换个新对话」就等于把过往经历全丢了。
      out.episode = await appendEpisode(env, opts.episodeScope || chatId, digest);
    }
    memCounters.turnsRecorded++;
  } catch (e) {
    out.ok = false;
    out.reason = 'error';
    memCounters.writeFails++;
    memCounters.lastError = String((e && e.message) || e).slice(0, 200);
  }
  return out;
}

// ==================== 命令与统计 ====================
// 三层并行读：/memory 和 /status 都是交互命令，串行三次 R2 往返纯属白等。
async function memoryStats(env, chatId) {
  const empty = { workTurns: 0, workTopics: [], openTasks: 0, episodes: 0, semantic: 0, chars: 0 };
  try {
    const [work, episodes, sem] = await Promise.all([
      layersEnabled(env) ? getWorking(env, chatId).catch(() => null) : Promise.resolve(null),
      layersEnabled(env) ? getEpisodes(env, chatId).catch(() => []) : Promise.resolve([]),
      agentMemStats(env, chatId).catch(() => ({ count: 0, chars: 0 })),
    ]);
    return {
      workTurns: work && work.turns ? work.turns.length : 0,
      workTopics: work && work.topics ? work.topics.slice(0, 6) : [],
      openTasks: work && work.openTasks ? work.openTasks.length : 0,
      episodes: episodes.length,
      semantic: sem.count,
      chars: sem.chars,
    };
  } catch (e) { return empty; }
}

// /memory 命令的三层报告（Telegram 与微信共用，避免两处文案漂移）。
async function memoryReport(env, chatId, opts) {
  opts = opts || {};
  const showItems = opts.showItems !== false;
  const [work, episodes, semAll, semStat] = await Promise.all([
    layersEnabled(env) ? getWorking(env, chatId).catch(() => null) : Promise.resolve(null),
    layersEnabled(env) ? getEpisodes(env, chatId).catch(() => []) : Promise.resolve([]),
    // 列表只要前 30 条；条数必须另外取，否则「共 60 条」会把 400 条的上限说成 60 条。
    agentSearchMemories(env, chatId, '', 30).catch(() => []),
    agentMemStats(env, chatId).catch(() => ({ count: 0, chars: 0, max: 0 })),
  ]);
  const sem = semAll;
  const semTotal = Math.max(semStat.count || 0, sem.length);

  const lines = ['🧠 三层记忆', '────────────'];
  // L1
  if (work && work.turns.length) {
    lines.push('【L1 工作记忆】' + work.turns.length + ' 轮'
      + (work.topics.length ? '｜主题：' + work.topics.slice(0, 5).join('、') : ''));
    if (showItems) {
      for (const t of work.turns.slice(-3)) lines.push('  · ' + fmtClock(t.ts) + ' ' + clipText(t.user, 60));
    }
    if (work.openTasks.length) lines.push('  · 未完成：' + work.openTasks.slice(0, 2).join('；'));
  } else {
    lines.push('【L1 工作记忆】本次会话暂无记录');
  }
  // L2
  lines.push('【L2 情景记忆】共 ' + episodes.length + ' 条'
    + (episodes.length ? '（保留最近 180 天）' : ''));
  if (showItems && episodes.length) {
    for (const e of episodes.slice(-3).reverse()) lines.push('  · ' + fmtDate(e.ts) + '《' + e.title + '》');
  }
  // L3：条数用真实总数（semTotal），列表只用前 30 条。
  // 旧写法直接用检索结果的长度当「共 N 条」，而检索本身有 limit，
  // 于是有 200 条记忆的用户会看到「共 60 条」——报数错得比没报还糟。
  lines.push('【L3 语义记忆】共 ' + semTotal + ' 条'
    + (semStat.max > 0 ? '（上限 ' + semStat.max + '）' : ''));
  if (showItems && sem.length) {
    for (let i = 0; i < sem.length; i++) {
      lines.push('  ' + (i + 1) + '. ' + sem[i].fact);
    }
    if (semTotal > sem.length) lines.push('  …（其余 ' + (semTotal - sem.length) + ' 条可用 /recall 关键词 检索）');
  }
  if (!work || !work.turns.length) {
    if (!episodes.length && !semTotal) {
      lines.push('');
      lines.push('💡 暂无记忆。对我说「记住 xxx」保存长期事实；聊过几轮后会自动生成工作记忆与情景记忆。');
    }
  }
  lines.push('');
  lines.push('💡 /recall 关键词 检索三层记忆｜/forget 关键词 删语义记忆｜/forget --epi 关键词 删情景记忆｜/forget --all 关键词 全删');
  return lines.join('\n');
}

export {
  memScope,
  workKey,
  epiKey,
  layersEnabled,
  autoWriteEnabled,
  limitsOf,
  clipText,
  extractTopics,
  firstConclusion,
  digestTurn,
  mergeSummary,
  memTimeParts,
  shouldRecordEpisode,
  getWorking,
  appendWorkingTurn,
  clearWorking,
  getEpisodes,
  appendEpisode,
  clearEpisodes,
  forgetEpisodes,
  recallMemory,
  pickRelevantEpisodes,
  formatRecallResult,
  formatWorkingBlock,
  formatEpisodesBlock,
  formatLayeredMemory,
  recordTurnMemory,
  memoryStats,
  memoryReport,
  memoryDiag,
  memKindLabel,
  __resetMemoryDiag,
  DEFAULTS,
};
