// Agent 工具：DuckDuckGo 搜索与网页结构化正文抓取（支持 offset 分页与 Jina 免密钥回退）

import { isBlockedFetchHost } from '../net/ssrf.js';

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

async function toolWebFetch(url, offset) {
  url = String(url || '').trim();
  if (!/^https?:\/\//i.test(url)) return 'URL 非法，仅支持 http/https';
  offset = Math.max(0, parseInt(offset, 10) || 0);
  const PAGE_SIZE = 6000;
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
    const totalLen = text.length;
    if (offset >= totalLen) {
      return '偏移量 offset=' + offset + ' 已超出页面正文总长度（' + totalLen + ' 字符）';
    }
    const slice = text.slice(offset, offset + PAGE_SIZE);
    const nextOffset = offset + slice.length;
    if (nextOffset < totalLen) {
      return slice + '\n\n> （当前显示第 ' + offset + ' ~ ' + nextOffset + ' 字符，网页正文共 ' + totalLen + ' 字符；如需继续阅读后续部分，请调用 web_fetch 并传 offset=' + nextOffset + '）';
    }
    return slice;
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

export {
  parseDuckDuckGo,
  parseDuckDuckGoLite,
  htmlToStructuredText,
  toolWebSearch,
  toolWebFetch,
};
