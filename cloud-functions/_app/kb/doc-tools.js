// Agent 工具：知识库文档的保存 / 列表 / 检索 / 精读（支持目录跳读与 offset 分页） / 删除
//
// v7.6.0 知识库阅读链路重做（都是"读不全 / 读错 / 读得慢"这三类真问题）：
//   1) 检索范围：旧实现 `reg.slice(0, 30)` 只扫前 30 篇 —— 文档一多，第 31 篇之后
//      永远不会被全文检索命中，而且界面上完全看不出来。现在按「标题相关度 + 更新
//      时间」排序后扫全库，用时间预算（默认 7 秒）与累计读入量兜底，并在结果里
//      如实写出「已扫描 N/M 篇」。
//   2) 检索算法：旧实现按 800 字步长滑窗，长文档要跑上百个窗口 × 每个关键词一次
//      indexOf。现在先收集关键词出现位置，再对位置做一次滑动窗口找「最密集区」，
//      复杂度从 O(文档长度/步长 × 关键词数) 降到 O(命中次数)。
//   3) 读错文档：标题模糊命中就短路返回第一篇。现在返回「最优候选 + 其它相近标题」，
//      让模型知道还有别的选择。
//   4) 盲翻页：长文档只能一页页读（每页 8000 字，3 万字文档要 4 步）。现在首次读取
//      附带章节目录（含每节 offset），模型可以直接跳到需要的章节。
//   5) 检索与精读混在一个工具里：新增 search_docs 专做检索，read_doc 专做精读，
//      模型行为更可预测，也更省步数。

import { storePutChecked } from '../store/r2.js';
import { kbSafeChatId } from '../store/kb.js';
import { KB_DOCS_PREFIX, kbDocSlug, kbNormSource, kbDocTitleOf, kbGetRegistry,
  kbSaveRegistry, kbFindRegCandidates, kbFmtSize, kbFmtDate } from './registry.js';

// L1 文档正文短期缓存（绑定当前 env.R2 实例，60s TTL，最多缓存 50 篇），
// 加速长文档 offset 連続翻页与多关键词全文检索，写删操作自动失效对应条目。
const KB_BODY_CACHE_MAX = 50;
const KB_BODY_CACHE_TTL_MS = 60 * 1000;
const kbDocBodyCache = new Map();
let kbDocBodyCacheBucket = null;

// 单页读取长度（与 tool description 里的「单次返回 8000 字」保持一致）
const KB_PAGE_SIZE = 8000;
// 检索：并发、单次预算、最多扫多少篇、累计读入字符上限
const KB_SEARCH_CONCURRENCY = 8;
const KB_SEARCH_BUDGET_MS = 7000;
const KB_SEARCH_MAX_DOCS = 400;
const KB_SEARCH_MAX_CHARS = 4000000;
// 片段窗口：命中点前 450 字、后 650 字
const KB_SNIPPET_BEFORE = 450;
const KB_SNIPPET_AFTER = 650;

async function kbGetDocTextCached(env, key) {
  if (!env || !env.R2) return null;
  const now = Date.now();
  if (kbDocBodyCacheBucket !== env.R2) {
    kbDocBodyCache.clear();
    kbDocBodyCacheBucket = env.R2;
  }
  const hit = kbDocBodyCache.get(key);
  if (hit && now < hit.exp) {
    kbDocBodyCache.delete(key);
    kbDocBodyCache.set(key, hit);
    return hit.text;
  }
  const obj = await env.R2.get(key);
  if (!obj) return null;
  const text = await obj.text();
  if (text.length <= 120000) {
    if (kbDocBodyCache.size >= KB_BODY_CACHE_MAX) {
      const oldest = kbDocBodyCache.keys().next().value;
      if (oldest !== undefined) kbDocBodyCache.delete(oldest);
    }
    kbDocBodyCache.set(key, { text, exp: now + KB_BODY_CACHE_TTL_MS });
  }
  return text;
}

function kbInvalidateDocCache(key) {
  if (key) kbDocBodyCache.delete(key);
  else kbDocBodyCache.clear();
}

// 分词辅助：英文/数字按词、中文按 2-gram，用于正文多关键词相关性检索
// v7.6.0：中文不再额外拆单字。旧实现给每个汉字都记一个 token，于是"完全不存在的
// 词组"也能靠"的/不/在"命中一堆文档 —— 检索结果全是噪音，模型会误以为知识库里
// 真的讲过。只有整个查询本身就是单字时才保留单字 token。
function docSearchTokens(s) {
  const out = [];
  const segs = String(s || '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/);
  for (const seg of segs) {
    if (!seg) continue;
    out.push(seg);
    if (/[\u4e00-\u9fff]/.test(seg)) {
      for (let i = 0; i + 2 <= seg.length; i++) out.push(seg.slice(i, i + 2));
      if (seg.length === 1) out.push(seg);
    }
  }
  return [...new Set(out)];
}

function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  if (!(n > 0)) return def;
  return Math.max(min, Math.min(max, n));
}

// 标题相关度：精确相等 > 标题包含 query > 标题命中若干关键词。
// 只用于「先扫哪几篇」的排序，不参与正文打分。
function kbTitleScore(entry, qLower, tokens) {
  const t = String((entry && entry.title) || '').toLowerCase();
  if (!t) return 0;
  if (qLower && t === qLower) return 100;
  let s = 0;
  if (qLower && t.indexOf(qLower) !== -1) s += 60;
  for (const tk of tokens) {
    if (tk.length >= 2 && t.indexOf(tk) !== -1) s += 6;
  }
  return s;
}

// 在全文里找「关键词最密集」的 1200 字窗口。
// 先收集每个关键词的出现位置（每词最多记 200 处，防止高频词把数组撑爆），
// 再对位置序列做一次滑动窗口 —— 比「按固定步长切窗口逐个 indexOf」快一到两个数量级，
// 而且窗口边界是贴着真实命中的，不会像固定网格那样把命中点切在窗口边缘。
function kbBestWindow(lower, tokens, winSize) {
  const win = winSize > 0 ? winSize : 1200;
  const positions = [];
  for (const tk of tokens) {
    if (!tk) continue;
    const weight = tk.length >= 2 ? tk.length * 3 : 1;
    let from = 0;
    let guard = 0;
    while (guard < 200) {
      const p = lower.indexOf(tk, from);
      if (p === -1) break;
      positions.push({ pos: p, w: weight });
      from = p + tk.length;
      guard++;
    }
  }
  if (!positions.length) return null;
  positions.sort((a, b) => a.pos - b.pos);

  let best = { score: 0, anchor: -1 };
  let score = 0;
  let tail = 0;
  for (let i = 0; i < positions.length; i++) {
    score += positions[i].w;
    while (positions[i].pos - positions[tail].pos > win) {
      score -= positions[tail].w;
      tail++;
    }
    if (score > best.score) best = { score, anchor: positions[tail].pos };
  }
  return best.score > 0 ? best : null;
}

// 从 Markdown 正文里抽章节目录（h1~h4），带绝对字符 offset
function kbBuildToc(text, limit) {
  const out = [];
  const max = limit > 0 ? limit : 12;
  const re = /^#{1,4}[ \t]+(.{1,80})$/gm;
  let m;
  let guard = 0;
  while ((m = re.exec(text)) && out.length < max) {
    const level = (m[0].match(/^#+/) || ['#'])[0].length;
    const title = String(m[1] || '').trim();
    if (title) out.push({ offset: m.index, level, title });
    if (++guard > 400) break;
  }
  return out;
}

// 单篇打分：精确子串优先（按出现次数加权），否则退回关键词密集窗口
async function kbScoreOneDoc(env, entry, qLower, tokens) {
  try {
    const key = KB_DOCS_PREFIX + (entry.file || '');
    const text = await kbGetDocTextCached(env, key);
    if (text === null) return null;
    const lower = text.toLowerCase();
    const title = entry.title || kbDocTitleOf(key);

    const exact = qLower ? lower.indexOf(qLower) : -1;
    if (exact !== -1) {
      let count = 0;
      let from = 0;
      while (count < 20) {
        const p = lower.indexOf(qLower, from);
        if (p === -1) break;
        count++;
        from = p + qLower.length;
      }
      return {
        title, file: entry.file, text, bestOffset: exact,
        updated_at: entry.updated_at || '',
        score: 1000 + count * 20 + kbTitleScore(entry, qLower, tokens) * 3
      };
    }

    const win = kbBestWindow(lower, tokens, 1200);
    if (!win) return null;
    return { title, file: entry.file, text, bestOffset: win.anchor, updated_at: entry.updated_at || '', score: win.score };
  } catch (e) { return null; }
}

// 全库检索：返回结构化命中（title / file / score / bestOffset / text）与扫描统计。
// 调用方（search_docs 与 read_doc 的回落分支）共用这一份实现，避免两套打分逻辑漂移。
async function kbSearchDocs(env, query, opts) {
  opts = opts || {};
  const raw = String(query || '').trim();
  const qLower = raw.toLowerCase();
  const tokens = docSearchTokens(raw);
  const empty = { ok: false, scanned: 0, total: 0, hits: [], truncated: false, timedOut: false };
  if (!qLower) return empty;
  const reg = await kbGetRegistry(env);
  if (!reg.length) return { ok: true, scanned: 0, total: 0, hits: [], truncated: false, timedOut: false };

  const topN = clampInt(opts.topN, 1, 8, 3);
  const maxDocs = clampInt(opts.maxDocs, 1, 1000, KB_SEARCH_MAX_DOCS);
  const budgetMs = clampInt(opts.budgetMs, 1000, 30000, KB_SEARCH_BUDGET_MS);
  const deadline = Date.now() + budgetMs;

  // 先扫最可能相关的：标题命中优先，其次最近更新的。
  // 知识库大到超过 maxDocs 时，这个顺序决定了「被扫到的机会」，比插入顺序有意义得多。
  const ordered = reg.slice().sort((a, b) => {
    const sa = kbTitleScore(a, qLower, tokens);
    const sb = kbTitleScore(b, qLower, tokens);
    if (sb !== sa) return sb - sa;
    return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
  });
  const queue = ordered.slice(0, maxDocs);

  const hits = [];
  let scanned = 0;
  let chars = 0;
  let truncated = queue.length < reg.length;
  let timedOut = false;

  for (let i = 0; i < queue.length; i += KB_SEARCH_CONCURRENCY) {
    if (Date.now() > deadline) { timedOut = true; truncated = true; break; }
    const batch = queue.slice(i, i + KB_SEARCH_CONCURRENCY);
    const res = await Promise.all(batch.map(e => kbScoreOneDoc(env, e, qLower, tokens)));
    for (const h of res) {
      scanned++;
      if (!h) continue;
      chars += h.text.length;
      hits.push(h);
    }
    if (chars > KB_SEARCH_MAX_CHARS) { truncated = true; break; }
  }

  // 分数相同（常见于同一主题的多篇笔记）时，让较新的排在前面：
  // 提示词里承诺「多篇说法冲突取较新」，这里保证它真的能看到较新的那篇。
  hits.sort((a, b) => (b.score - a.score)
    || String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  return { ok: true, scanned, total: reg.length, truncated, timedOut, hits: hits.slice(0, topN) };
}

// 统一片段格式：「【命中 N：知识库文档《X》（offset=…，全文 … 字符）】」
// 这个格式同时被 search_docs 与 read_doc 的回落分支使用，模型只要学会一种读法。
function kbFormatHits(hits, meta) {
  const blocks = hits.map((h, idx) => {
    const start = Math.max(0, h.bestOffset - KB_SNIPPET_BEFORE);
    const end = Math.min(h.text.length, h.bestOffset + KB_SNIPPET_AFTER);
    let frag = h.text.slice(start, end);
    if (start > 0) frag = '…' + frag;
    if (end < h.text.length) frag = frag + '…';
    return '【命中 ' + (idx + 1) + '：知识库文档《' + h.title + '》（offset=' + start + '，全文 ' + h.text.length + ' 字符）】\n' + frag;
  });
  let tail = '\n\n> （以上为正文相关性最高的片段；如需阅读某篇完整上下文，请用 read_doc 传入完整文档标题及对应 offset）';
  if (meta && meta.truncated) {
    tail += '\n> （本次已扫描 ' + meta.scanned + '/' + meta.total + ' 篇'
      + (meta.timedOut ? '，时间预算用尽' : '')
      + '；可换更具体的关键词缩小范围）';
  }
  return blocks.join('\n\n---\n\n') + tail;
}

// 文档过多时，别把整张标题表塞进上下文
function kbTitleList(reg, limit) {
  const max = limit > 0 ? limit : 20;
  const lines = reg.slice(0, max).map(e => '- ' + (e.title || e.file));
  if (reg.length > max) lines.push('- …（共 ' + reg.length + ' 篇，其余可用 list_docs 查看）');
  return lines.join('\n');
}

async function toolSaveDoc(env, chatId, args) {
  args = args || {};
  // v6.8.4：标题/source 去掉换行（换行会破坏 frontmatter 解析，导致重建注册表时标题丢失）
  const title = String(args.title || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
  const cleanSource = String(args.source || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
  let content = String(args.content || '');
  if (!title) return '标题为空，未保存';
  if (!content.trim()) return '内容为空，未保存';
  // v6.8.3：R2 未绑定时必须明确失败——之前会静默跳过写入却谎称"已保存"
  if (!env.R2) return 'R2 未绑定，知识库文档无法保存。请先按 README 第二步绑定 R2 存储桶后再试；本次内容未保存。';
  if (content.length > 100000) content = content.slice(0, 100000) + '\n\n> （内容过长，仅保存前 10 万字符）';
  const file = kbDocSlug(title) + '.md';
  const key = KB_DOCS_PREFIX + file;
  const reg = await kbGetRegistry(env);
  // 同链接去重（O(1) 查注册表）：已存为另一篇文档时拒绝
  const normSrc = kbNormSource(args.source);
  if (normSrc) {
    const dup = reg.find(e => kbNormSource(e.source) === normSrc);
    if (dup && dup.file !== file) {
      return '该链接已保存为知识库文档《' + (dup.title || dup.file) + '》，未重复保存。如需更新内容，请用标题"' + (dup.title || dup.file) + '"（或清洗后同名标题）重新保存以覆盖，或先用 delete_doc 删除旧文档。';
    }
  }
  const prevEntry = reg.find(e => e.file === file);
  const existed = !!prevEntry;
  const head = '---\ntitle: "' + title.replace(/"/g, '') + '"\nsaved_at: ' + new Date().toISOString()
    + '\nchat_id: "' + kbSafeChatId(chatId) + '"'
    + (cleanSource ? '\nsource: ' + cleanSource : '')
    + '\n---\n\n';
  const body = head + content;
  // v6.8.3：校验写入结果，R2 写入失败（如权限问题）不再谎称成功
  const okDoc = await storePutChecked(env, key, body);
  kbInvalidateDocCache(key);
  if (!okDoc) return '知识库文档写入 R2 失败（' + key + '），请检查 R2 绑定与权限后重试；本次内容未保存。';
  const entry = {
    file: file,
    title: title,
    source: cleanSource,
    size: body.length,
    updated_at: new Date().toISOString()
  };
  const idx = reg.findIndex(e => e.file === file);
  if (idx >= 0) reg[idx] = entry; else reg.push(entry);
  // v6.8.4：注册表写入失败必须如实返回——正文已落盘但列表查不到时，引导用户重试修复
  const okReg = await kbSaveRegistry(env, reg);
  if (!okReg) return '文档正文已写入 R2（' + key + '），但注册表更新失败，文档可能暂不出现在列表中；请稍后重新保存一次以修复注册表，本次内容未丢失。';
  let verNote = existed ? '，已覆盖旧版本' : '，新建';
  // v6.8.4：slug 碰撞提示——"A/B" 与 "AB" 会生成同一文件，覆盖时明确告知
  if (existed && prevEntry && prevEntry.title !== title) {
    verNote += '（注意：新标题清洗后与旧文档《' + prevEntry.title + '》同名，旧内容已被覆盖）';
  }
  return '已保存为知识库文档：' + key + '（' + content.length + ' 字符' + verNote + '）';
}

// 列表：按更新时间倒序（最近存的排前面），带日期与体积，超过 40 篇截断。
// 旧实现按插入顺序且不分页，文档一多模型看到的是一屏没有时间信息的标题。
async function toolListDocs(env) {
  if (!env.R2) return 'R2 未绑定，无法读取知识库文档';
  const reg = await kbGetRegistry(env);
  if (!reg.length) return '知识库文档为空（kb/docs/ 下暂无文档，可用 save_doc 保存）';
  const sorted = reg.slice().sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  const MAX_LIST = 40;
  const shown = sorted.slice(0, MAX_LIST);
  let text = '知识库文档（共' + reg.length + '篇，按更新时间倒序' + (reg.length > MAX_LIST ? '，显示前 ' + MAX_LIST + ' 篇' : '') + '）：\n';
  text += shown.map((e, i) => {
    const date = kbFmtDate(e.updated_at);
    return (i + 1) + '. ' + (e.title || e.file)
      + '（' + kbFmtSize(e.size) + (date ? '，' + date : '') + '）';
  }).join('\n');
  text += '\n\n提示：不确定该读哪篇时，用 search_docs 按关键词检索全文。';
  return text;
}

// 首次读取长文档时附带的章节目录：模型可以直接跳到需要的节，不必逐页翻
function kbTocBlock(fullText, pageSize) {
  const toc = kbBuildToc(fullText, 12);
  if (!toc.length) {
    const pages = Math.ceil(fullText.length / pageSize);
    return '\n> （本文无 Markdown 小标题，共 ' + fullText.length + ' 字符、约 ' + pages + ' 页；可传 offset 顺序阅读）\n';
  }
  const lines = toc.map((t, i) => {
    const pad = '  '.repeat(Math.max(0, t.level - 1));
    return (i + 1) + '. ' + pad + t.title + '（offset=' + t.offset + '）';
  });
  return '\n> 【章节目录】（共 ' + fullText.length + ' 字符，每页 ' + pageSize + ' 字；可直接传对应 offset 跳到该节）\n'
    + lines.join('\n') + '\n';
}

async function toolReadDoc(env, args) {
  args = args || {};
  const query = String(args.query || '').trim();
  if (!query) return '请给出要读取的文档标题关键词';
  if (!env.R2) return 'R2 未绑定，无法读取知识库文档';
  const reg = await kbGetRegistry(env);
  if (!reg.length) return '知识库文档为空（kb/docs/ 下暂无文档）';
  const offset = Math.max(0, parseInt(args.offset, 10) || 0);
  const MAX = KB_PAGE_SIZE;

  // 候选：最优一篇照常读，其余相近标题在末尾提示一句，避免"读错篇还以为是全部"
  const candidates = kbFindRegCandidates(reg, query);
  const hit = candidates.length ? candidates[0] : null;
  const others = candidates.slice(1, 4);

  if (hit) {
    try {
      const fullText = await kbGetDocTextCached(env, KB_DOCS_PREFIX + hit.file);
      if (fullText === null) return '文档读取失败：' + (hit.title || hit.file);
      const totalLen = fullText.length;
      const docName = hit.title || hit.file;
      const head = '【知识库文档《' + docName + '》】';
      if (offset >= totalLen) {
        return head + '偏移量 offset=' + offset + ' 已超出文档总长度（' + totalLen + ' 字符）。'
          + (totalLen > MAX ? kbTocBlock(fullText, MAX) : '');
      }
      const slice = fullText.slice(offset, offset + MAX);
      const nextOffset = offset + slice.length;
      let out = head;
      // 只在「第一次读、且文档比一页长」时给目录：后续翻页再给一遍纯属浪费上下文
      if (offset === 0 && totalLen > MAX) out += kbTocBlock(fullText, MAX);
      out += '\n' + slice;
      if (nextOffset < totalLen) {
        out += '\n\n> （当前显示第 ' + offset + ' ~ ' + nextOffset + ' 字符，全文共 ' + totalLen + ' 字符；'
          + '如需继续阅读后续内容，请调用 read_doc 并传 offset=' + nextOffset + '）';
      } else if (offset > 0) {
        out += '\n\n> （当前显示第 ' + offset + ' ~ ' + totalLen + ' 字符，已读到文档末尾）';
      }
      if (others.length) {
        out += '\n\n> （另有 ' + others.length + ' 篇标题相近的文档：'
          + others.map(e => '《' + (e.title || e.file) + '》').join('、')
          + '；如需要请用完整标题读取）';
      }
      return out;
    } catch (e) { return '文档读取失败：' + (hit.title || hit.file); }
  }

  // 标题无命中 → 全库全文检索（与 search_docs 同一套打分）
  const r = await kbSearchDocs(env, query, { topN: 3 });
  if (r.hits.length) return kbFormatHits(r.hits, r);
  return '未找到标题或正文包含「' + query + '」的文档（已扫描 ' + r.scanned + '/' + r.total + ' 篇）。现有文档：\n'
    + kbTitleList(reg, 20);
}

// 专门的检索工具：只回答「哪几篇文档讲了这个」，不返回整页正文
async function toolSearchDocs(env, args) {
  args = args || {};
  const query = String(args.query || '').trim();
  if (!query) return '关键词为空，未检索';
  if (!env.R2) return 'R2 未绑定，无法检索知识库文档';
  const r = await kbSearchDocs(env, query, { topN: args.count, budgetMs: args.budget_ms });
  if (!r.total) return '知识库文档为空（kb/docs/ 下暂无文档）';
  if (!r.hits.length) {
    return '知识库中未找到与「' + query + '」相关的内容（已扫描 ' + r.scanned + '/' + r.total + ' 篇）。'
      + '可换更短或更通用的关键词再试，或用 list_docs 查看全部标题。';
  }
  return kbFormatHits(r.hits, r);
}

async function toolDeleteDoc(env, args) {
  args = args || {};
  const query = String(args.query || '').trim();
  if (!query) return '请给出要删除的文档标题关键词';
  if (!env.R2) return 'R2 未绑定，无法删除知识库文档';
  const reg = await kbGetRegistry(env);
  if (!reg.length) return '知识库文档为空，无需删除';
  // 与 read_doc 同样先取全部候选：删除不可逆，多篇命中时必须告诉用户「只删了哪一篇」
  const candidates = kbFindRegCandidates(reg, query);
  const hit = candidates.length ? candidates[0] : null;
  const others = candidates.slice(1, 4);
  if (!hit) {
    return '未找到标题包含"' + query + '"的文档。现有文档：\n' + kbTitleList(reg, 20);
  }
  try { await env.R2.delete(KB_DOCS_PREFIX + hit.file); kbInvalidateDocCache(KB_DOCS_PREFIX + hit.file); } catch (e) { return '删除失败：' + (hit.title || hit.file); }
  const okReg = await kbSaveRegistry(env, reg.filter(e => e !== hit));
  if (!okReg) return '文档文件已删除，但注册表更新失败，列表可能仍显示旧条目；下次读取会自动重建注册表。《' + (hit.title || hit.file) + '》';
  let msg = '已删除知识库文档《' + (hit.title || hit.file) + '》';
  if (others.length) {
    msg += '（另有 ' + others.length + ' 篇标题相近的文档未删除：'
      + others.map(e => '《' + (e.title || e.file) + '》').join('、')
      + '；如也要删除，请用完整标题）';
  }
  return msg;
}

// 兼容旧导出：旧调用方只拿片段文本。参数 entries 保留但不再使用（改为扫全库）。
async function kbSearchDocBody(env, entries, query) {
  const r = await kbSearchDocs(env, query, { topN: 3 });
  if (!r.hits.length) return null;
  return kbFormatHits(r.hits, r);
}

export {
  docSearchTokens,
  kbBuildToc,
  kbBestWindow,
  kbSearchDocs,
  kbFormatHits,
  toolSaveDoc,
  toolListDocs,
  toolSearchDocs,
  toolReadDoc,
  kbSearchDocBody,
  toolDeleteDoc,
};
