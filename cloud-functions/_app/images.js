// 生图结果处理：把上游返回的图片（公网 URL 或 base64）转存成自己域名下的稳定链接。
//
// 为什么必须有这一层（原实现「生图返回不了图片」的三个根因）：
//   1) 只认 data[0].url。而 SenseNova 等图像接口的 response_format **默认是 b64_json**，
//      响应里根本没有 url 字段 → 必然落到「图片生成失败或未返回格式」。
//   2) base64 不能直接内联进 Markdown。聊天记录存在浏览器 localStorage（配额约 5MB），
//      一张 2K PNG 的 base64 就能把整份会话写挂；而 saveSessions 是 try/catch 静默吞错的，
//      用户只会看到「历史记录莫名其妙没了」。
//   3) 图像接口给的 URL 是 24 小时临时链接，过期即失效；聊天记录却是长期保存的，
//      第二天回来所有图片全裂。
// 所以统一转存到 Blob/KV，通过 /api/img/<id> 提供稳定、可长期访问的链接。
//
// 相关环境变量：
//   IMAGE_PERSIST        1（默认）/ 0 —— 是否把图片转存到自己的存储
//   IMAGE_MAX_MB         单张图片转存上限，默认 8（超过则退回上游原始链接）
//   IMAGE_TIMEOUT_MS     下载上游图片的超时，默认 20000
//   IMAGE_RESPONSE_FORMAT  请求上游时的 response_format，默认 url
//   IMAGE_SIZE / IMAGE_OUTPUT_FORMAT / IMAGE_WATERMARK / IMAGE_PROMPT_EXTEND
//                        透传给图像接口的可选参数，不设则不发送（用上游默认值）

import { storePutChecked, storeGet } from './store/r2.js';
import { isBlockedFetchHost } from './net/ssrf.js';
import { SSE_HEADERS } from './constants.js';

const IMG_PREFIX = 'img/';
const IMG_URL_PATH = '/api/img/';
const DEFAULT_MAX_MB = 8;
const DEFAULT_TIMEOUT_MS = 600000;

const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

// 只接受本层自己生成的 id 形态，杜绝 ../ 之类的路径穿越
const IMG_ID_RE = /^[a-z0-9]{4,32}-[a-z0-9]{4,16}\.(png|jpg|jpeg|webp|gif)$/;

// ---------------- base64 编解码（不依赖 Buffer，Workers 与 Node 都能跑） ----------------

function bytesToBase64(bytes) {
  if (typeof btoa === 'function') {
    let bin = '';
    const CHUNK = 0x8000; // 分块避免 apply 参数过多爆栈
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }
  const C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const parts = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    parts.push(C[b0 >> 2], C[((b0 & 3) << 4) | ((b1 || 0) >> 4)]);
    parts.push(b1 === undefined ? '=' : C[((b1 & 15) << 2) | ((b2 || 0) >> 6)]);
    parts.push(b2 === undefined ? '=' : C[b2 & 63]);
  }
  return parts.join('');
}

function base64ToBytes(b64) {
  const s = String(b64 || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!s) return new Uint8Array(0);
  if (typeof atob === 'function') {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Int16Array(256);
  for (let i = 0; i < 256; i++) lookup[i] = -1;
  for (let i = 0; i < C.length; i++) lookup[C.charCodeAt(i)] = i;
  const out = [];
  for (let i = 0; i < s.length; i += 4) {
    const n = (lookup[s.charCodeAt(i)] << 18) | (lookup[s.charCodeAt(i + 1)] << 12)
      | ((lookup[s.charCodeAt(i + 2)] & 63) << 6) | (lookup[s.charCodeAt(i + 3)] & 63);
    out.push((n >> 16) & 255);
    if (s[i + 2] !== '=' && s[i + 2] !== undefined) out.push((n >> 8) & 255);
    if (s[i + 3] !== '=' && s[i + 3] !== undefined) out.push(n & 255);
  }
  return new Uint8Array(out);
}

// ---------------- 参数解析 ----------------

function truthy(value, defaultValue) {
  if (value === undefined || value === null || String(value).trim() === '') return defaultValue;
  const s = String(value).trim().toLowerCase();
  return !(s === '0' || s === 'false' || s === 'off' || s === 'no');
}

// 默认开启转存：否则用户第二天回来图片全裂，属于更难排查的「隐性 bug」
function persistEnabled(env) {
  return truthy(env && env.IMAGE_PERSIST, true);
}

function maxBytes(env) {
  const mb = parseFloat(env && env.IMAGE_MAX_MB);
  return (mb > 0 ? mb : DEFAULT_MAX_MB) * 1024 * 1024;
}

function timeoutOf(env) {
  const t = parseInt(env && env.IMAGE_TIMEOUT_MS, 10);
  return t > 0 ? t : DEFAULT_TIMEOUT_MS;
}

function newImageId(ext) {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10) + '.' + ext;
}

function mimeOfExt(ext) {
  return MIME_BY_EXT[String(ext || '').toLowerCase()] || 'image/png';
}

// 从返回条目里推断 mime：优先显式字段，其次看 output_format
function mimeFromItem(item) {
  const it = item || {};
  const explicit = String(it.mime_type || it.content_type || '').toLowerCase();
  if (EXT_BY_MIME[explicit]) return explicit;
  const fmt = String(it.output_format || '').toLowerCase();
  if (fmt === 'jpeg' || fmt === 'jpg') return 'image/jpeg';
  if (fmt === 'webp') return 'image/webp';
  if (fmt === 'png') return 'image/png';
  return 'image/png';
}

// ---------------- 转存与读取 ----------------

// 把 base64 图片存进存储，返回可长期访问的相对路径；未绑定存储或超限时返回 null
async function persistBase64Image(env, b64, mime) {
  if (!env || !env.R2) return null;
  const clean = String(b64 || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!clean) return null;
  const approxBytes = Math.floor((clean.length * 3) / 4);
  if (approxBytes > maxBytes(env)) return null;
  const id = newImageId(EXT_BY_MIME[String(mime || '').toLowerCase()] || 'png');
  const ok = await storePutChecked(env, IMG_PREFIX + id, clean);
  return ok ? IMG_URL_PATH + id : null;
}

// 把上游返回的图片 URL 下载后转存，返回可长期访问的相对路径；失败返回 null
async function persistRemoteImage(env, url, timeoutMs) {
  if (!env || !env.R2) return null;
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch (e) {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  // 图片 URL 来自第三方接口响应，同样过一遍 SSRF 拦截，避免被当成内网探测代理
  if (isBlockedFetchHost(parsed.hostname)) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    try { ctrl.abort(); } catch (e) {}
  }, timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(parsed.toString(), { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) return null;
    const ctype = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    // 内容类型不是图片就拒收，避免把错误页当成图片存下来
    if (ctype && ctype.indexOf('image/') !== 0) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes(env)) return null;
    const id = newImageId(EXT_BY_MIME[ctype] || 'png');
    const ok = await storePutChecked(env, IMG_PREFIX + id, bytesToBase64(new Uint8Array(buf)));
    return ok ? IMG_URL_PATH + id : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 读取已转存的图片，供 GET /api/img/<id> 使用
async function loadStoredImage(env, id) {
  const name = String(id || '');
  if (!IMG_ID_RE.test(name)) return null;
  const b64 = await storeGet(env, IMG_PREFIX + name);
  if (!b64) return null;
  return {
    bytes: base64ToBytes(b64),
    contentType: mimeOfExt(name.slice(name.lastIndexOf('.') + 1)),
  };
}

// ---------------- 把图像接口响应转成前端可直接渲染的 SSE ----------------

function excerpt(raw, max) {
  const s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  const limit = max > 0 ? max : 300;
  return s.length > limit ? s.slice(0, limit) + '…' : s;
}

function sseFromText(text) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const chunk = JSON.stringify({ choices: [{ delta: { content: String(text) + '\n\n' } }] });
      controller.enqueue(encoder.encode('data: ' + chunk + '\n\n'));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

function sseFromError(message) {
  // 用 SSE 通道回传错误，前端会当作正文渲染 —— 比抛 500 更能让用户看到具体原因
  return sseFromText('⚠️ ' + message);
}

// 解析图像接口响应，返回给前端的 SSE 流（正文是 Markdown 图片语法）
async function buildImageSseResponse(env, upstreamResponse) {
  let raw = '';
  let data = null;
  try {
    raw = await upstreamResponse.text();
    data = JSON.parse(raw);
  } catch (e) {
    return sseFromError('图像接口返回的不是合法 JSON：' + excerpt(raw));
  }

  if (data && data.error) {
    const em = (data.error && data.error.message) ? data.error.message : JSON.stringify(data.error);
    return sseFromError('图像接口报错：' + em);
  }

  const items = (data && Array.isArray(data.data)) ? data.data : [];
  const markdowns = [];
  const notes = [];

  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const alt = items.length > 1 ? ('生成结果 ' + (i + 1)) : '生成结果';
    const label = '第 ' + (i + 1) + ' 张';
    let line = null;

    if (typeof it.url === 'string' && it.url) {
      // ① 上游直接给了 URL
      if (persistEnabled(env)) {
        const local = await persistRemoteImage(env, it.url, timeoutOf(env));
        if (local) {
          line = '![' + alt + '](' + local + ')';
        } else {
          line = '![' + alt + '](' + it.url + ')';
          notes.push(label + '未能转存（存储未绑定或图片过大），用的是上游临时链接，24 小时后会失效。');
        }
      } else {
        line = '![' + alt + '](' + it.url + ')';
        notes.push(label + '使用上游临时链接（有效期 24 小时）；设置 IMAGE_PERSIST=1 可转存为长期链接。');
      }
    } else if (typeof it.b64_json === 'string' && it.b64_json) {
      // ② 上游给了 base64 —— SenseNova 等接口的默认返回方式，原实现就是在这里丢图的
      const mime = mimeFromItem(it);
      const local = await persistBase64Image(env, it.b64_json, mime);
      if (local) {
        line = '![' + alt + '](' + local + ')';
      } else {
        const clean = it.b64_json.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
        line = '![' + alt + '](data:' + mime + ';base64,' + clean + ')';
        notes.push(label + '未能转存（未绑定存储或图片过大），已内联展示；刷新页面后可能无法恢复，且会占用浏览器存储配额。');
      }
    }

    if (line) {
      markdowns.push(line);
    } else {
      notes.push(label + '的返回里既没有 url 也没有 b64_json，无法识别。');
    }
  }

  // ③ 有些网关把图片塞进 chat 响应的 message.content 里
  if (!markdowns.length) {
    const c = data && data.choices && data.choices[0]
      && data.choices[0].message && data.choices[0].message.content;
    if (typeof c === 'string' && c.trim()) return sseFromText(c);
  }

  if (!markdowns.length) {
    return sseFromError('图像接口未返回任何图片。原始响应：' + excerpt(raw, 400));
  }

  let out = markdowns.join('\n\n');
  if (notes.length) out += '\n\n> ' + notes.join('\n> ');
  return sseFromText(out);
}

export {
  IMG_PREFIX,
  IMG_URL_PATH,
  IMG_ID_RE,
  EXT_BY_MIME,
  MIME_BY_EXT,
  bytesToBase64,
  base64ToBytes,
  persistEnabled,
  mimeFromItem,
  persistBase64Image,
  persistRemoteImage,
  loadStoredImage,
  buildImageSseResponse,
};
