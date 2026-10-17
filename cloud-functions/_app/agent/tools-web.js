// Agent 工具：DuckDuckGo 搜索、网页结构化正文抓取（含 L1 分页缓存与 Jina 回退）、GitHub 仓库检索、arXiv 论文检索、科技/开源实时热榜

import { isBlockedFetchHost } from '../net/ssrf.js';

// 网页正文 L1 缓存（URL -> { text, exp }），避免长网页用 offset 翻页时重复发起网络请求
const PAGE_CACHE_MAX = 30;
const PAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const parsedPageCache = new Map();

function getCachedPageText(url) {
  const hit = parsedPageCache.get(url);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    parsedPageCache.delete(url);
    return null;
  }
  parsedPageCache.delete(url);
  parsedPageCache.set(url, hit);
  return hit.text;
}

function setCachedPageText(url, text) {
  if (!url || !text || text.length > 300000) return;
  if (parsedPageCache.size >= PAGE_CACHE_MAX) {
    const oldest = parsedPageCache.keys().next().value;
    if (oldest !== undefined) parsedPageCache.delete(oldest);
  }
  parsedPageCache.set(url, { text, exp: Date.now() + PAGE_CACHE_TTL_MS });
}

function clearWebPageCache() {
  parsedPageCache.clear();
}

// 还原 DuckDuckGo 的跳转链接：html 端把真实地址藏在 uddg 参数里
function unwrapDdgHref(href) {
  let u = String(href || '');
  const uddg = u.match(/[?&]uddg=([^&]+)/);
  if (uddg) { try { u = decodeURIComponent(uddg[1]); } catch (e) {} }
  return u;
}

// DuckDuckGo HTML 结果解析（抽出以便测试）
function parseDuckDuckGo(html, count) {
  const out = [];
  const seen = new Set();
  const clean = (s) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const push = (title, href, snip) => {
    const url = unwrapDdgHref(href);
    if (!title || !url || !url.startsWith('http') || seen.has(url)) return;
    seen.add(url);
    out.push({ title, url, snip: snip ? snip.slice(0, 200) : '' });
  };
  const blockRe = /<div[^>]*class="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*\bresult\b[^"]*"|<\/body>|$)/g;
  let bm;
  while ((bm = blockRe.exec(html)) && out.length < count) {
    const body = bm[1];
    const am = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(body);
    if (!am) continue;
    const sm = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(body)
      || /<[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td|span)>/.exec(body);
    push(clean(am[2]), am[1], sm ? clean(sm[1]) : '');
  }
  if (out.length) return out;
  const altRe = /<(?:div|article|li)[^>]*class="[^"]*\b(?:web-result|results_links|result--(?:url|snippet)?)\b[^"]*"[^>]*>([\s\S]*?)(?=<(?:div|article|li)[^>]*class="[^"]*\b(?:web-result|results_links)\b|<\/body>|$)/g;
  let am2;
  while ((am2 = altRe.exec(html)) && out.length < count) {
    const body = am2[1];
    const link = /<a[^>]*class="[^"]*result-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(body)
      || /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(body);
    if (!link) continue;
    const sn = /<[^>]*class="[^"]*(?:result-snippet|result__snippet)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|td|span|a|p)>/.exec(body);
    push(clean(link[2]), link[1], sn ? clean(sn[1]) : '');
  }
  return out;
}

// v6.8.6：流式读取并设预算，到量即停 —— 不把超大响应体整段读进 isolate 内存
async function readBodyBudget(res, maxChars) {
  let out = '';
  try {
    const reader = res.body.getReader();
    const dec = new TextDecoder('utf-8');
    while (out.length < maxChars) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    try { await reader.cancel(); } catch (e) {}
  } catch (e) {
    if (!out) throw e;
  }
  return out.length > maxChars ? out.slice(0, maxChars) : out;
}

// v7.0.0：结构化 HTML → 轻量 Markdown 提取，保留标题层级、代码块、列表、表格与段落换行
function htmlToStructuredText(html) {
  let s = String(html || '');
  // 移除不可见/导航噪音区块
  s = s.replace(/<(?:script|style|noscript|svg|canvas|iframe|footer|nav)[\s\S]*?<\/(?:script|style|noscript|svg|canvas|iframe|footer|nav)>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  // 保留代码块与行内代码
  s = s.replace(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_, c) => '\n```\n' + c.replace(/<[^>]*>/g, '').trim() + '\n```\n');
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, c) => '\n```\n' + c.replace(/<[^>]*>/g, '').trim() + '\n```\n');
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, c) => '`' + c.replace(/<[^>]*>/g, '').trim() + '`');
  // 保留标题 h1~h4
  s = s.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, c) => '\n# ' + c.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() + '\n');
  s = s.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, c) => '\n## ' + c.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() + '\n');
  s = s.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, c) => '\n### ' + c.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() + '\n');
  s = s.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_, c) => '\n#### ' + c.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() + '\n');
  // 保留列表与表格基本结构
  s = s.replace(/<li[^>]*>/gi, '\n- ');
  s = s.replace(/<\/(?:tr|p|div|section|article|blockquote)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(?:td|th)>/gi, ' | ');
  // 剥离剩余标签并解码常见 HTML 实体
  s = s.replace(/<[^>]*>/g, ' ');
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 10)); } catch (e) { return ''; } });
  // 规整空白与多余空行
  s = s.replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

// 免密钥 Jina Reader 回退：当直接抓取遭遇 403/429 反爬或 SPA 空壳页面时尝试提取正文
async function tryJinaFallback(targetUrl, signal) {
  try {
    const jinaUrl = 'https://r.jina.ai/' + targetUrl;
    const res = await fetch(jinaUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; EdgeOne-Chat/7.0)',
        'X-Return-Format': 'markdown'
      },
      signal
    });
    if (!res.ok) {
      try { if (res.body) await res.body.cancel(); } catch (e) {}
      return '';
    }
    const text = await readBodyBudget(res, 200000);
    return String(text || '').trim();
  } catch (e) {
    return '';
  }
}

async function toolWebSearch(query, count) {
  query = String(query || '').trim();
  if (!query) return '搜索关键词为空';
  count = Math.min(Math.max(parseInt(count) || 5, 1), 8);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const endpoints = [
      'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query),
      'https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(query)
    ];
    let out = [];
    let lastStatus = 0;
    for (const endpoint of endpoints) {
      if (ctrl.signal.aborted) break;
      let res;
      try {
        res = await fetch(endpoint, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
          signal: ctrl.signal
        });
      } catch (e) {
        if (e && e.name === 'AbortError') return '搜索失败: 超时';
        continue;
      }
      lastStatus = res.status;
      if (!res.ok) { try { if (res.body) await res.body.cancel(); } catch (e) {} continue; }
      let html = '';
      try { html = await readBodyBudget(res, 300000); }
      catch (e) { continue; }
      out = endpoint.indexOf('/lite/') !== -1 ? parseDuckDuckGoLite(html, count) : parseDuckDuckGo(html, count);
      if (!out.length && endpoint.indexOf('/lite/') === -1) out = parseDuckDuckGoLite(html, count);
      if (out.length) break;
    }
    if (!out.length && lastStatus && lastStatus !== 200) return '搜索请求失败，HTTP ' + lastStatus;
    if (!out.length) return '搜索「' + query + '」无结果';
    let text = '搜索「' + query + '」结果：\n';
    out.forEach((r, i) => { text += (i + 1) + '. ' + r.title + '\n   ' + r.url + (r.snip ? '\n   摘要：' + r.snip : '') + '\n'; });
    return text.slice(0, 4000);
  } catch (e) {
    return '搜索失败: ' + (e.name === 'AbortError' ? '超时' : e.message);
  } finally { clearTimeout(timer); }
}

function formatWebPageSlice(text, offset, pageSize) {
  const totalLen = text.length;
  if (offset >= totalLen) {
    return '偏移量 offset=' + offset + ' 已超出页面正文总长度（' + totalLen + ' 字符）';
  }
  const slice = text.slice(offset, offset + pageSize);
  const nextOffset = offset + slice.length;
  if (nextOffset < totalLen) {
    return slice + '\n\n> （当前显示第 ' + offset + ' ~ ' + nextOffset + ' 字符，网页正文共 ' + totalLen + ' 字符；如需继续阅读后续部分，请调用 web_fetch 并传 offset=' + nextOffset + '）';
  }
  return slice;
}

async function toolWebFetch(url, offset) {
  url = String(url || '').trim();
  if (!/^https?:\/\//i.test(url)) return 'URL 非法，仅支持 http/https';
  offset = Math.max(0, parseInt(offset, 10) || 0);
  const PAGE_SIZE = 6000;

  // 若 L1 页面缓存已命中（尤其是 offset > 0 连续翻页场景），零网络开销直接切片返回
  const cachedText = getCachedPageText(url);
  if (cachedText) {
    return formatWebPageSlice(cachedText, offset, PAGE_SIZE);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 16000);
  try {
    let current = url;
    let res = null;
    for (let hop = 0; hop <= 5; hop++) {
      let fetchHost = '';
      try { fetchHost = new URL(current).hostname; } catch (e) { return 'URL 非法，仅支持 http/https'; }
      if (isBlockedFetchHost(fetchHost)) return '该地址禁止抓取（内网 / 本机 / 云元数据地址）';
      res = await fetch(current, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
        signal: ctrl.signal, redirect: 'manual'
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        try { if (res.body) await res.body.cancel(); } catch (e) {}
        if (!loc) return '抓取失败：重定向缺少目标地址';
        try { current = new URL(loc, current).href; } catch (e) { return '抓取失败：重定向地址非法'; }
        continue;
      }
      break;
    }
    if (res && res.status >= 300 && res.status < 400) return '重定向次数过多（超过 5 跳），已停止抓取';
    if (!res) return '抓取失败';

    let text = '';
    if (!res.ok) {
      try { if (res.body) await res.body.cancel(); } catch (e) {}
      // 遭遇 401/403/429/5xx 时尝试 Jina 免密钥 Reader 回退
      text = await tryJinaFallback(current, ctrl.signal);
      if (!text) return '抓取失败，HTTP ' + res.status;
    } else {
      const ct = res.headers.get('content-type') || '';
      if (/pdf|image|video|audio|octet-stream/i.test(ct)) {
        try { if (res.body) await res.body.cancel(); } catch (e) {}
        return '不支持抓取该类型内容(' + ct + ')';
      }
      let html;
      try { html = await readBodyBudget(res, 500000); }
      catch (e) { return '抓取失败: ' + (e.name === 'AbortError' ? '超时' : e.message); }
      text = htmlToStructuredText(html);
      // 若页面是纯前端 SPA 空壳（提取文本不足 80 字符），自动尝试 Jina Reader 回退
      if (text.length < 80) {
        const fallbackText = await tryJinaFallback(current, ctrl.signal);
        if (fallbackText.length > text.length) text = fallbackText;
      }
    }

    if (!text) return '页面无有效文本内容';
    setCachedPageText(url, text);
    return formatWebPageSlice(text, offset, PAGE_SIZE);
  } catch (e) {
    return '抓取失败: ' + (e.name === 'AbortError' ? '超时' : e.message);
  } finally { clearTimeout(timer); }
}

function parseDuckDuckGoLite(html, count) {
  const out = [];
  const seen = new Set();
  const clean = (s) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const linkRe = /<a[^>]*class="[^"]*result-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = linkRe.exec(html)) && out.length < count) {
    const url = unwrapDdgHref(m[1]);
    const title = clean(m[2]);
    if (!title || !url || !url.startsWith('http') || seen.has(url)) continue;
    seen.add(url);
    const after = html.slice(m.index, m.index + 1200);
    const sn = /<td[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/.exec(after);
    out.push({ title, url, snip: sn ? clean(sn[1]).slice(0, 200) : '' });
  }
  return out;
}

// ==================== 新增工具 4：GitHub 开源仓库详情与搜索（toolGithubLookup） ====================
async function toolGithubLookup(args) {
  args = args || {};
  let raw = String(args.query || args.repo || '').trim();
  if (!raw) return 'GitHub 查询失败: 关键词或仓库名为空';
  raw = raw.replace(/^https?:\/\/(?:www\.)?github\.com\//i, '').replace(/\/+$/, '');

  const ghHeaders = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'EdgeOne-Chat/7.0'
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);

  try {
    // 若形如 owner/repo（无空格），直接查询该仓库详情与最新 Release
    const repoMatch = /^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/.exec(raw);
    if (repoMatch) {
      const slug = `${repoMatch[1]}/${repoMatch[2].replace(/\.git$/i, '')}`;
      const [repoRes, relRes] = await Promise.all([
        fetch(`https://api.github.com/repos/${slug}`, { headers: ghHeaders, signal: ctrl.signal }),
        fetch(`https://api.github.com/repos/${slug}/releases/latest`, { headers: ghHeaders, signal: ctrl.signal }).catch(() => null),
      ]);
      if (!repoRes.ok) {
        return `GitHub 查询失败: 仓库 ${slug} 请求返回 HTTP ${repoRes.status}`;
      }
      const repo = await repoRes.json();
      let relLine = '无正式 Release';
      if (relRes && relRes.ok) {
        try {
          const rel = await relRes.json();
          if (rel && rel.tag_name) {
            relLine = `${rel.tag_name}${rel.published_at ? '（发布于 ' + rel.published_at.slice(0, 10) + '）' : ''}`;
          }
        } catch (e) {}
      }
      const topics = Array.isArray(repo.topics) && repo.topics.length ? repo.topics.slice(0, 8).join(', ') : '无';
      return `【GitHub 仓库：${repo.full_name}】\n`
        + `- 链接：${repo.html_url}\n`
        + `- 简介：${repo.description || '无描述'}\n`
        + `- 数据：⭐ ${repo.stargazers_count} Stars | 🍴 ${repo.forks_count} Forks | 🐛 ${repo.open_issues_count} Open Issues\n`
        + `- 语言与协议：${repo.language || '未知'} | License: ${(repo.license && (repo.license.spdx_id || repo.license.name)) || '未声明'}\n`
        + `- 最新版本：${relLine}\n`
        + `- 最近推送：${repo.pushed_at ? repo.pushed_at.slice(0, 10) : '未知'}\n`
        + `- 标签 (Topics)：${topics}`;
    }

    // 否则按关键词检索热门仓库
    const count = Math.min(Math.max(parseInt(args.count, 10) || 5, 1), 8);
    const sort = args.sort === 'updated' ? 'updated' : 'stars';
    const searchUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(raw)}&sort=${sort}&order=desc&per_page=${count}`;
    const res = await fetch(searchUrl, { headers: ghHeaders, signal: ctrl.signal });
    if (!res.ok) return `GitHub 查询失败: HTTP ${res.status}`;
    const data = await res.json();
    const items = (data && Array.isArray(data.items)) ? data.items : [];
    if (!items.length) return `GitHub 未找到与「${raw}」相关的开源仓库`;

    let out = `【GitHub 开源仓库检索：「${raw}」（共找到 ${data.total_count || items.length} 个，显示前 ${items.length} 个）】\n`;
    items.forEach((it, idx) => {
      out += `${idx + 1}. **${it.full_name}** (⭐ ${it.stargazers_count} | ${it.language || '未知语言'})\n`
        + `   链接：${it.html_url}\n`
        + `   简介：${(it.description || '无描述').slice(0, 180)}\n`;
    });
    return out.trim();
  } catch (e) {
    return 'GitHub 查询失败: ' + (e && e.name === 'AbortError' ? '超时' : e.message);
  } finally {
    clearTimeout(timer);
  }
}

// ==================== 新增工具 5：arXiv 学术论文检索（toolArxivSearch） ====================
function decodeXmlEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

async function toolArxivSearch(args) {
  args = args || {};
  const query = String(args.query || '').trim();
  if (!query) return 'arXiv 检索失败: 查询关键词为空';
  const count = Math.min(Math.max(parseInt(args.count, 10) || 4, 1), 6);
  const sortBy = args.sort === 'date' ? 'submittedDate' : 'relevance';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const apiUrl = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${count}&sortBy=${sortBy}&sortOrder=descending`;
    const res = await fetch(apiUrl, {
      headers: { 'User-Agent': 'EdgeOne-Chat/7.0' },
      signal: ctrl.signal
    });
    if (!res.ok) return `arXiv 检索失败: HTTP ${res.status}`;
    const xml = await readBodyBudget(res, 250000);
    const entries = [];
    const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
    let m;
    while ((m = entryRe.exec(xml)) && entries.length < count) {
      const block = m[1];
      const titleM = /<title>([\s\S]*?)<\/title>/.exec(block);
      const sumM = /<summary>([\s\S]*?)<\/summary>/.exec(block);
      const idM = /<id>([\s\S]*?)<\/id>/.exec(block);
      const pubM = /<published>([\s\S]*?)<\/published>/.exec(block);
      const authors = [];
      const authRe = /<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g;
      let am;
      while ((am = authRe.exec(block)) && authors.length < 5) {
        authors.push(decodeXmlEntities(am[1]));
      }
      const rawId = idM ? decodeXmlEntities(idM[1]) : '';
      const pdfUrl = rawId ? rawId.replace('/abs/', '/pdf/') : '';
      entries.push({
        title: titleM ? decodeXmlEntities(titleM[1]) : '无标题',
        summary: sumM ? decodeXmlEntities(sumM[1]).slice(0, 450) : '',
        url: rawId,
        pdfUrl,
        published: pubM ? decodeXmlEntities(pubM[1]).slice(0, 10) : '',
        authors: authors.join(', ') + (authors.length >= 5 ? ' 等' : ''),
      });
    }
    if (!entries.length) return `arXiv 未找到与「${query}」相关的论文`;
    let out = `【arXiv 学术论文检索：「${query}」】\n`;
    entries.forEach((e, i) => {
      out += `${i + 1}. 《${e.title}》（${e.published || '未知日期'}）\n`
        + `   作者：${e.authors || '未知'}\n`
        + `   链接：${e.url}${e.pdfUrl ? ' | PDF: ' + e.pdfUrl : ''}\n`
        + `   摘要：${e.summary}\n`;
    });
    return out.trim();
  } catch (e) {
    return 'arXiv 检索失败: ' + (e && e.name === 'AbortError' ? '超时' : e.message);
  } finally {
    clearTimeout(timer);
  }
}

// ==================== 新增工具 6：科技与开源实时热榜（toolTrendingNews） ====================
async function toolTrendingNews(args) {
  args = args || {};
  const source = String(args.source || 'hn').trim().toLowerCase();
  const count = Math.min(Math.max(parseInt(args.count, 10) || 5, 1), 8);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);

  try {
    if (source === 'github' || source === 'gh') {
      const sinceDate = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
      const lang = String(args.language || '').trim();
      const q = `created:>${sinceDate}` + (lang ? ` language:${lang}` : '');
      const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${count}`;
      const res = await fetch(url, {
        headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'EdgeOne-Chat/7.0' },
        signal: ctrl.signal
      });
      if (!res.ok) return `热榜获取失败: GitHub HTTP ${res.status}`;
      const data = await res.json();
      const items = (data && Array.isArray(data.items)) ? data.items : [];
      if (!items.length) return '热榜获取失败: 暂无符合条件的 GitHub 热门新仓库';
      let out = `【GitHub 近期飙升开源项目榜${lang ? ' (' + lang + ')' : ''}】\n`;
      items.forEach((it, idx) => {
        out += `${idx + 1}. **${it.full_name}** (⭐ ${it.stargazers_count} | ${it.language || '综合'})\n`
          + `   ${it.html_url}\n`
          + `   简介：${(it.description || '无描述').slice(0, 160)}\n`;
      });
      return out.trim();
    }

    // 默认 Hacker News Top Stories
    const topRes = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json', {
      headers: { 'User-Agent': 'EdgeOne-Chat/7.0' },
      signal: ctrl.signal
    });
    if (!topRes.ok) return `热榜获取失败: Hacker News HTTP ${topRes.status}`;
    const ids = await topRes.json();
    if (!Array.isArray(ids) || !ids.length) return '热榜获取失败: Hacker News 列表为空';
    const pickedIds = ids.slice(0, count);
    const stories = await Promise.all(pickedIds.map(async (id) => {
      try {
        const r = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, {
          headers: { 'User-Agent': 'EdgeOne-Chat/7.0' },
          signal: ctrl.signal
        });
        if (!r.ok) return null;
        return await r.json();
      } catch (e) { return null; }
    }));
    const valid = stories.filter(s => s && s.title);
    if (!valid.length) return '热榜获取失败: 未能读取 Hacker News 条目详情';
    let out = `【Hacker News 实时科技热榜 Top ${valid.length}】\n`;
    valid.forEach((s, idx) => {
      const link = s.url || `https://news.ycombinator.com/item?id=${s.id}`;
      out += `${idx + 1}. ${s.title}（🔥 ${s.score || 0} pts · 💬 ${s.descendants || 0} 评论）\n   ${link}\n`;
    });
    return out.trim();
  } catch (e) {
    return '热榜获取失败: ' + (e && e.name === 'AbortError' ? '超时' : e.message);
  } finally {
    clearTimeout(timer);
  }
}

export {
  parseDuckDuckGo,
  parseDuckDuckGoLite,
  htmlToStructuredText,
  toolWebSearch,
  toolWebFetch,
  toolGithubLookup,
  toolArxivSearch,
  toolTrendingNews,
  clearWebPageCache,
};
