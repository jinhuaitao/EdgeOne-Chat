// 知识库预检索：在请求大模型之前，先把与本次提问最相关的正文片段取出来。
//
// 为什么需要这一层：
//   只把「文档标题列表」塞进系统提示词，模型要么凭训练知识直接回答（压根没读知识库），
//   要么先花一步工具调用去 search_docs —— 前者答错、后者慢一步。Web 端普通对话模式
//   更是连标题列表都没有（不加载工具），知识库等于不存在。
//   预检索把「最相关的 2 段正文」直接放到模型眼前，两种模式都能第一时间用上知识库。
//
// 三条硬约束：
//   1) 有预算上限（默认 2.5 秒）——预检索是「加分项」，不能把整轮时间吃光；
//   2) 有跳过规则（闲聊、过短、知识库为空）——不为一句「你好」去扫全库；
//   3) 有字符上限（默认 2600 字）——片段太长会把真正的用户问题挤到上下文深处。

import { kbGetRegistry } from './registry.js';
import { kbSearchDocs } from './doc-tools.js';

const PREFETCH_CACHE_MAX = 40;
const PREFETCH_CACHE_TTL_MS = 60 * 1000;
const PREFETCH_MAX_CHARS_DEFAULT = 2600;
const PREFETCH_BUDGET_DEFAULT_MS = 2500;

// key 是问题原文（小写归一），同一问题重复提问（含前端断流自动重试）不再扫库
const prefetchCache = new Map();

// 闲聊 / 纯指令：这类问题去查知识库只会把无关文档塞进上下文
const CHITCHAT_RE = new RegExp(
  '^(' +
  [
    '你好', '您好', 'hi', 'hello', 'hey', '嗨', '哈喽', '在吗', '在不在', '有人吗',
    '谢谢', '多谢', '感谢', 'thanks', 'thank you', 'thx',
    'ok', 'okay', '好的', '好', '嗯', '嗯嗯', '收到', '明白', '知道了',
    '再见', '拜拜', 'bye', '晚安', '早上好', '晚上好',
    '测试', 'test', '你是谁', '你能做什么', '你会什么', '帮助', 'help',
  ].join('|') +
  ')[\\s!！。.~，,、?？]*$',
  'i'
);

function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  if (!(n > 0)) return def;
  return Math.max(min, Math.min(max, n));
}

function normalizeQuery(q) {
  return String(q || '').replace(/\s+/g, ' ').trim();
}

// 预检索是否值得做（不做也要给出原因，方便排障）
function kbPrefetchGate(query) {
  const q = normalizeQuery(query);
  if (!q) return { ok: false, reason: 'empty' };
  // 先判闲聊再判长度：「你好」「谢谢」这类问题长度也短，但原因应报 chitchat 而非 too_short
  if (CHITCHAT_RE.test(q)) return { ok: false, reason: 'chitchat' };
  if (q.length < 3) return { ok: false, reason: 'too_short' };
  return { ok: true, reason: '' };
}

// save_doc 写入的正文以 frontmatter 开头；片段若从文档开头切，会把 ---title:...---
// 一起塞进提示词。这里在文本层面剥掉（不改 offset，只影响片段观感）。
function stripFrontmatter(s) {
  const str = String(s || '');
  const atHead = str.match(/^\s*---\r?\n[\s\S]{0,600}?\r?\n---\r?\n?/);
  if (atHead) return str.slice(atHead[0].length);
  // 片段从 frontmatter 中间切进来（首行残留 "…---"，第二行起是 title: …）时同样剥掉
  const tail = str.match(/^[^\n]*\ntitle: [\s\S]{0,600}?\r?\n---\r?\n?/);
  if (tail) return str.slice(tail[0].length);
  return str;
}

// 把命中的正文切成「紧凑片段」：命中点前 320 字、后 720 字。
// 比工具结果里的片段更短——预检索是给模型「先看一眼」，不够它会自己去 read_doc。
function kbPrefetchSnippet(h) {
  const text = String(h.text || '');
  const anchor = Math.max(0, Math.min(text.length, h.bestOffset || 0));
  const start = Math.max(0, anchor - 320);
  const end = Math.min(text.length, anchor + 720);
  let frag = text.slice(start, end);
  frag = stripFrontmatter(frag).trim();
  if (start > 0) frag = '…' + frag;
  if (end < text.length) frag = frag + '…';
  return { start, frag };
}

function kbFormatPrefetch(hits, maxChars) {
  const blocks = [];
  let used = 0;
  const titles = [];
  for (const h of hits) {
    const { start, frag } = kbPrefetchSnippet(h);
    if (!frag) continue;
    const head = '--- 《' + String(h.title || h.file || '未命名文档') + '》（片段起于全文第 '
      + start + ' 字符，全文 ' + String(h.text || '').length + ' 字符）---';
    const block = head + '\n' + frag;
    if (used + block.length > maxChars) break;
    blocks.push(block);
    titles.push(String(h.title || h.file || ''));
    used += block.length;
  }
  if (!blocks.length) return { text: '', titles: [] };

  const head = '【知识库预检索结果】（系统已按本次提问检索知识库，以下是最相关的正文片段；'
    + '直接据此作答并注明"据知识库文档《标题》"，不要用相同关键词重复 search_docs；'
    + '片段不足以回答时再用 read_doc 读原文或翻页）';
  return { text: head + '\n' + blocks.join('\n\n'), titles };
}

function rememberPrefetch(key, val, ttlMs) {
  if (prefetchCache.size >= PREFETCH_CACHE_MAX) {
    const oldest = prefetchCache.keys().next().value;
    if (oldest !== undefined) prefetchCache.delete(oldest);
  }
  prefetchCache.set(key, { val, exp: Date.now() + ttlMs });
}

function clearKbPrefetchCache() {
  prefetchCache.clear();
}

// 主入口。永远不抛错：预检索失败不该影响正常回答。
// 返回 { ok, reason, text, titles, hits, scanned, total, ms, cached }
async function kbPrefetch(env, query, opts) {
  opts = opts || {};
  const t0 = Date.now();
  const q = normalizeQuery(query);
  const gate = kbPrefetchGate(q);
  if (!gate.ok) return { ok: false, reason: gate.reason, text: '', titles: [], hits: [], ms: 0, cached: false };
  if (!env || !env.R2) return { ok: false, reason: 'no_store', text: '', titles: [], hits: [], ms: 0, cached: false };

  const cacheKey = q.toLowerCase();
  const hit = prefetchCache.get(cacheKey);
  if (hit && Date.now() < hit.exp) {
    prefetchCache.delete(cacheKey);
    prefetchCache.set(cacheKey, hit);
    return Object.assign({}, hit.val, { cached: true });
  }

  try {
    const reg = await kbGetRegistry(env);
    if (!reg || !reg.length) {
      return { ok: false, reason: 'empty_kb', text: '', titles: [], hits: [], ms: Date.now() - t0, cached: false };
    }

    const budgetMs = clampInt(opts.budgetMs, 800, 8000, PREFETCH_BUDGET_DEFAULT_MS);
    const topN = clampInt(opts.topN, 1, 4, 2);
    const maxChars = clampInt(opts.maxChars, 600, 8000, PREFETCH_MAX_CHARS_DEFAULT);
    const r = await kbSearchDocs(env, q, { topN, budgetMs });
    const formatted = kbFormatPrefetch(r.hits || [], maxChars);

    const val = {
      ok: !!formatted.text,
      reason: formatted.text ? '' : 'no_hit',
      text: formatted.text,
      titles: formatted.titles,
      hits: (r.hits || []).map(h => ({ title: h.title, file: h.file, score: h.score, bestOffset: h.bestOffset })),
      scanned: r.scanned || 0,
      total: r.total || 0,
      truncated: !!r.truncated,
      ms: Date.now() - t0,
      cached: false,
    };
    // 命中与「确实查过但没有」都缓存：前者省一次全库扫描，后者省一次空扫描。
    // 注意这里不做写操作失效——Web 端知识库只读，且 TTL 只有 60 秒。
    rememberPrefetch(cacheKey, val, val.ok ? PREFETCH_CACHE_TTL_MS : 20000);
    return val;
  } catch (e) {
    return { ok: false, reason: 'error', text: '', titles: [], hits: [], ms: Date.now() - t0, cached: false };
  }
}

export {
  kbPrefetch,
  kbPrefetchGate,
  kbFormatPrefetch,
  kbPrefetchSnippet,
  clearKbPrefetchCache,
  PREFETCH_MAX_CHARS_DEFAULT,
};
