// 微信 ClawBot（腾讯官方 iLink Bot API / @tencent-weixin/openclaw-weixin 协议）底层通信与加解密层
// 支持：
// 1) 二维码获取（get_bot_qrcode）与扫码状态长轮询（get_qrcode_status，支持 scaned_but_redirect 跨区节点自动跳转与配对码）；
// 2) 会话生命周期通知（ilink/bot/msg/notifystart & notifystop）；
// 3) 长轮询增量消息拉取（ilink/bot/getupdates，支持 get_updates_buf 游标与 -14 过期检测）；
// 4) 文本消息投递（ilink/bot/sendmessage）与 Markdown 智能转微信原生排版（formatWechatText）；
// 5) 原生“对方正在输入…”状态指示器（ilink/bot/getconfig 获取 typing_ticket + ilink/bot/sendtyping 续期/关闭）；
// 6) 微信 CDN 媒体双向加解密：
//    - 入站：AES-128-ECB 解密下载（支持微信发图 Vision 多模态识图、语音转文字与文件读取）；
//    - 出站：零依赖 MD5 + AES-128-ECB 加密上传（getuploadurl 携带 context_token + CDN upload + image_item 原图直发微信）。

const DEFAULT_ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_ILINK_CDN_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const DEFAULT_ILINK_CHANNEL_VERSION = '2.4.10';
const DEFAULT_BOT_AGENT = 'openclaw-weixin';
const ILINK_BOT_TYPE = 3;

// 将语义化版本号（如 "2.4.10" 或 "2.1.7"）编码为 iLink-App-ClientVersion 所需的 uint32 (0x00MMNNPP)
function buildClientVersion(version) {
  const v = String(version || DEFAULT_ILINK_CHANNEL_VERSION).trim();
  if (/^\d+$/.test(v)) return parseInt(v, 10) >>> 0;
  const parts = v.split('.').map(p => parseInt(p, 10) || 0);
  const major = (parts[0] || 0) & 0xff;
  const minor = (parts[1] || 0) & 0xff;
  const patch = (parts[2] || 0) & 0xff;
  return (((major << 16) | (minor << 8) | patch) >>> 0);
}

// 每次请求生成新的 X-WECHAT-UIN：随机 uint32 -> 十进制字符串 -> Base64
function randomWechatUin() {
  let u32 = 0;
  try {
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    u32 = arr[0] >>> 0;
  } catch (e) {
    u32 = (Math.floor(Math.random() * 0xffffffff) >>> 0);
  }
  return btoa(String(u32));
}

function normalizeBaseUrl(baseUrl) {
  let s = String(baseUrl || DEFAULT_ILINK_BASE_URL).trim().replace(/\/+$/, '');
  if (!s) return DEFAULT_ILINK_BASE_URL;
  if (!/^https?:\/\//i.test(s)) {
    s = 'https://' + s.replace(/^\/+/, '');
  }
  return s;
}

function buildBaseInfo(channelVersion) {
  return {
    channel_version: String(channelVersion || DEFAULT_ILINK_CHANNEL_VERSION).trim() || DEFAULT_ILINK_CHANNEL_VERSION,
    bot_agent: DEFAULT_BOT_AGENT,
  };
}

// 构造符合 iLink Bot API 规范的公共与认证请求头（不手动设置 Content-Length，避免 Node/Edge fetch 报错）
function buildIlinkHeaders(token, channelVersion, isJsonPost = true) {
  const headers = {
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': String(buildClientVersion(channelVersion)),
    'X-WECHAT-UIN': randomWechatUin(),
  };
  if (isJsonPost) {
    headers['Content-Type'] = 'application/json';
    headers['AuthorizationType'] = 'ilink_bot_token';
  }
  if (token) {
    headers['Authorization'] = 'Bearer ' + String(token).trim();
  }
  return headers;
}

// 通用 iLink POST JSON 调用封装（内置针对 ilinkai.weixin.qq.com 偶发节点抖动的快速重试）
async function ilinkPost(baseUrl, endpoint, bodyObj, token, channelVersion, timeoutMs) {
  const base = normalizeBaseUrl(baseUrl);
  const ep = String(endpoint || '').replace(/^\/+/, '');
  const payload = Object.assign({}, bodyObj || {}, {
    base_info: buildBaseInfo(channelVersion),
  });
  const raw = JSON.stringify(payload);
  const budgetMs = timeoutMs || 15000;
  let res = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const startAt = Date.now();
    try {
      res = await fetch(`${base}/${ep}`, {
        method: 'POST',
        headers: buildIlinkHeaders(token, channelVersion, true),
        body: raw,
        signal: AbortSignal.timeout(budgetMs),
      });
      break;
    } catch (err) {
      const elapsed = Date.now() - startAt;
      // 若在建连/TLS 阶段快速失败（< 3.5s，如命中不稳定 IP 节点），立即换新 UIN 重试一次；若已是长轮询等待超时则直接抛出由上层按超时处理
      if (attempt >= 2 || elapsed >= 3500 || budgetMs < 5000) throw err;
      await new Promise(r => { const t = setTimeout(r, 350); if (t && typeof t.unref === 'function') t.unref(); });
    }
  }
  if (!res.ok) {
    let errBody = '';
    try { errBody = (await res.text()).slice(0, 400); } catch (e) {}
    const err = new Error(`iLink HTTP ${res.status}${errBody ? ': ' + errBody : ''}`);
    err.status = res.status;
    throw err;
  }
  const text = (await res.text()).trim();
  if (!text || text === '{}') return { ret: 0 };
  try {
    return JSON.parse(text);
  } catch (e) {
    return { ret: 0, raw: text };
  }
}

// 1. 获取微信 ClawBot 登录二维码（固定向主入口申请）
async function ilinkGetQrCode(baseUrl, channelVersion, timeoutMs) {
  const base = normalizeBaseUrl(baseUrl || DEFAULT_ILINK_BASE_URL);
  const url = `${base}/ilink/bot/get_bot_qrcode?bot_type=${ILINK_BOT_TYPE}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: buildIlinkHeaders(null, channelVersion, false),
    signal: AbortSignal.timeout(timeoutMs || 12000),
  });
  if (!res.ok) {
    throw new Error(`获取二维码失败 (HTTP ${res.status})`);
  }
  const data = await res.json();
  return data || {};
}

// 2. 轮询二维码扫码状态
// 支持状态：wait -> scaned -> scaned_but_redirect / binded_redirect -> need_verifycode -> confirmed | expired
async function ilinkGetQrStatus(baseUrl, qrcode, channelVersion, timeoutMs, verifyCode) {
  const base = normalizeBaseUrl(baseUrl);
  let url = `${base}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(String(qrcode || '').trim())}`;
  if (verifyCode) {
    url += `&verify_code=${encodeURIComponent(String(verifyCode).trim())}`;
  }
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: buildIlinkHeaders(null, channelVersion, false),
      signal: AbortSignal.timeout(timeoutMs || 10000),
    });
    if (!res.ok) {
      throw new Error(`查询扫码状态失败 (HTTP ${res.status})`);
    }
    const data = (await res.json()) || { status: 'wait' };
    const redirectRaw = data.redirect_host || data.baseurl || data.host || '';
    if (redirectRaw) {
      data.redirect_baseurl = normalizeBaseUrl(redirectRaw);
    }
    return data;
  } catch (e) {
    const nm = (e && e.name) ? String(e.name) : '';
    const msg = String((e && e.message) || '');
    if (nm === 'AbortError' || nm === 'TimeoutError' || /abort|timeout/i.test(msg)) {
      return { ret: 0, status: 'wait', timedOut: true };
    }
    throw e;
  }
}

// 3. 会话生命周期通知（notifyStart / notifyStop）
async function ilinkNotifyStart(baseUrl, token, channelVersion, timeoutMs) {
  try {
    return await ilinkPost(baseUrl, 'ilink/bot/msg/notifystart', {}, token, channelVersion, timeoutMs || 8000);
  } catch (e) {
    return { ret: -1, errmsg: e && e.message ? e.message : String(e) };
  }
}

async function ilinkNotifyStop(baseUrl, token, channelVersion, timeoutMs) {
  try {
    return await ilinkPost(baseUrl, 'ilink/bot/msg/notifystop', {}, token, channelVersion, timeoutMs || 6000);
  } catch (e) {
    return { ret: -1, errmsg: e && e.message ? e.message : String(e) };
  }
}

// 4. 长轮询获取新消息（getupdates）
// 关键工程约束：
// Serverless 平台（Cloudflare Workers waitUntil / EdgeOne 网关 / Node undici 默认 headersTimeout）
// 对无响应头的后台连接有严格的 30 秒硬限制（超时会抛 UND_ERR_HEADERS_TIMEOUT 或直接强杀实例导致断链，
// 进而使微信顶部出现“暂时无法连接 OpenClaw”）。
// 因此单次长轮询窗口默认设为 18 秒（允许范围 8s~24s），确保在 30 秒大限前 100% 干净返回并交棒下一跳！
const ILINK_DEFAULT_POLL_TIMEOUT_MS = 18000;

async function ilinkGetUpdates(baseUrl, token, getUpdatesBuf, channelVersion, timeoutMs) {
  const effectiveTimeout = Math.min(Math.max(parseInt(timeoutMs, 10) || ILINK_DEFAULT_POLL_TIMEOUT_MS, 5000), 25000);
  const startAt = Date.now();
  try {
    const data = await ilinkPost(
      baseUrl,
      'ilink/bot/getupdates',
      { get_updates_buf: String(getUpdatesBuf || '') },
      token,
      channelVersion,
      effectiveTimeout
    );
    return data || { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf || '' };
  } catch (e) {
    const elapsed = Date.now() - startAt;
    const nm = (e && e.name) ? String(e.name) : '';
    const msg = String((e && e.message) || '');
    const cause = (e && e.cause) || {};
    const causeStr = `${cause.name || ''} ${cause.code || ''} ${cause.message || ''}`;
    const st = (e && typeof e.status === 'number') ? e.status : 0;
    // 客户端主动超时、undici HeadersTimeoutError (Issue #67564)、长等待后的连接重置或网关 502/503/504/524
    // 一律视为正常的长轮询空包边界，保留原游标平滑进入下一棒，绝不中断轮询链！
    if (
      nm === 'AbortError'
      || nm === 'TimeoutError'
      || /abort|timeout|UND_ERR_HEADERS_TIMEOUT|UND_ERR_SOCKET|ECONNRESET|socket hang up/i.test(msg + ' ' + causeStr)
      || (elapsed >= effectiveTimeout - 1500)
      || st === 502 || st === 503 || st === 504 || st === 524
    ) {
      if (st >= 500) {
        await new Promise(r => { const t = setTimeout(r, 800); if (t && typeof t.unref === 'function') t.unref(); });
      }
      return { ret: 0, msgs: [], get_updates_buf: String(getUpdatesBuf || ''), timedOut: true };
    }
    throw e;
  }
}

// 5. 获取用户配置（用于提取 typing_ticket）
async function ilinkGetConfig(baseUrl, token, userId, contextToken, channelVersion, timeoutMs) {
  const body = { ilink_user_id: String(userId || '') };
  if (contextToken) body.context_token = String(contextToken);
  return await ilinkPost(baseUrl, 'ilink/bot/getconfig', body, token, channelVersion, timeoutMs || 10000);
}

// 6. 发送/取消“对方正在输入…”状态（status: 1=开始输入, 2=停止输入）
async function ilinkSendTyping(baseUrl, token, userId, typingTicket, status, channelVersion, timeoutMs) {
  const st = status === 2 ? 2 : 1;
  const body = {
    ilink_user_id: String(userId || ''),
    to_user_id: String(userId || ''),
    typing_ticket: String(typingTicket || ''),
    status: st,
    command: st,
  };
  return await ilinkPost(baseUrl, 'ilink/bot/sendtyping', body, token, channelVersion, timeoutMs || 8000);
}

// 7. 发送文本消息（sendmessage）
async function ilinkSendMessage(baseUrl, token, toUserId, text, contextToken, channelVersion, timeoutMs) {
  const clientId = 'wxbot-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  const body = {
    msg: {
      from_user_id: '',
      to_user_id: String(toUserId || ''),
      client_id: clientId,
      message_type: 2, // 2 = BOT 消息
      message_state: 2, // 2 = FINISH
      context_token: String(contextToken || ''),
      item_list: [
        {
          type: 1,
          text_item: { text: String(text || '') },
        },
      ],
    },
  };
  return await ilinkPost(baseUrl, 'ilink/bot/sendmessage', body, token, channelVersion, timeoutMs || 15000);
}

// ================= 8. 微信专属 Markdown 智能清洗排版器 =================
// 微信聊天窗口不渲染 Markdown，直接显示 ** 或 ### 会非常杂乱；此函数将 Markdown 转化为干净易读的微信原生排版
function formatWechatText(rawText) {
  if (!rawText) return '';
  let s = String(rawText).replace(/\r\n/g, '\n');

  // 1) 保护代码块，将其转化为整洁的缩进框
  const codeBlocks = [];
  s = s.replace(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    const header = lang ? `╭─ [${lang}] ─────\n` : '╭─ [代码] ─────\n';
    const body = String(code || '').replace(/\n+$/, '');
    codeBlocks.push(`${header}${body}\n╰──────────`);
    return `\x00CODEBLOCK_${idx}\x00`;
  });

  // 2) 转换 Markdown 标题 (# ~ ######) 为醒目分节符
  s = s.replace(/^[ \t]*#{1,2}[ \t]+(.+?)[ \t]*#*$/gm, '\n▎$1');
  s = s.replace(/^[ \t]*#{3,6}[ \t]+(.+?)[ \t]*#*$/gm, '▪ $1');

  // 3) 转换 Markdown 链接 [文字](url) -> 文字 (url)，避免图片语法先被误吞
  s = s.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (_, alt, url) => {
    return `${alt ? `🖼️ ${alt}: ` : '🖼️ 图片: '}${url}`;
  });
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
    const cleanLabel = String(label || '').trim();
    const cleanUrl = String(url || '').trim();
    if (!cleanLabel || cleanLabel === cleanUrl) return cleanUrl;
    return `${cleanLabel} (${cleanUrl})`;
  });

  // 4) 转换粗体/斜体与行内代码
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  s = s.replace(/__([^_\n]+)__/g, '$1');
  s = s.replace(/`([^`\n]+)`/g, '「$1」');

  // 5) 转换无序列表与引用块
  s = s.replace(/^[ \t]*[-*+][ \t]+/gm, '• ');
  s = s.replace(/^[ \t]*>[ \t]?(.*)$/gm, '｜$1');
  s = s.replace(/^[ \t]*(-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '────────────');

  // 6) 还原代码块并收敛多余空行
  s = s.replace(/\x00CODEBLOCK_(\d+)\x00/g, (_, i) => codeBlocks[Number(i)] || '');
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

// ================= 9. 零依赖 MD5 与 AES-128-ECB 双向加解密（用于微信收发图片/文件） =================
function md5Hex(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  const K = new Int32Array([
    -680876936, -389564586, 606105819, -1044525330, -176418897, 1200080426, -1473231341, -45705983,
    1770035416, -1958414417, -42063, -1990404162, 1804603682, -40341101, -1502002290, 1236535329,
    -165796510, -1069501632, 643717713, -373897302, -701558691, 38016083, -660478335, -405537848,
    568446438, -1019803690, -187363961, 1163531501, -1444681467, -51403784, 1735328473, -1926607734,
    -378558, -2022574463, 1839030562, -35309556, -1530992060, 1272893353, -155497632, -1094730640,
    681279174, -358537222, -722521979, 76029189, -640364487, -421815835, 530742520, -995338651,
    -198630844, 1126891415, -1416354905, -57434055, 1700485571, -1894986606, -1051523, -2054922799,
    1873313359, -30611744, -1560198380, 1309151649, -145523070, -1120210379, 718787259, -343485551,
  ]);
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const origLen = data.length;
  const totalLen = (((origLen + 8) >>> 6) + 1) << 6;
  const buf = new Uint8Array(totalLen);
  buf.set(data, 0);
  buf[origLen] = 0x80;
  const bitLenLo = (origLen << 3) >>> 0;
  const bitLenHi = (origLen >>> 29) >>> 0;
  const dv = new DataView(buf.buffer);
  dv.setUint32(totalLen - 8, bitLenLo, true);
  dv.setUint32(totalLen - 4, bitLenHi, true);

  let a0 = 0x67452301 | 0;
  let b0 = 0xefcdab89 | 0;
  let c0 = 0x98badcfe | 0;
  let d0 = 0x10325476 | 0;
  const M = new Int32Array(16);

  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let j = 0; j < 16; j++) M[j] = dv.getInt32(offset + (j << 2), true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F = 0, g = 0;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
      else { F = C ^ (B | ~D); g = (7 * i) & 15; }
      const temp = D;
      D = C;
      C = B;
      const sum = (A + F + K[i] + M[g]) | 0;
      const rot = (sum << S[i]) | (sum >>> (32 - S[i]));
      B = (B + rot) | 0;
      A = temp;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  const out = new Uint8Array(16);
  const outDv = new DataView(out.buffer);
  outDv.setInt32(0, a0, true);
  outDv.setInt32(4, b0, true);
  outDv.setInt32(8, c0, true);
  outDv.setInt32(12, d0, true);
  let hex = '';
  for (let i = 0; i < 16; i++) hex += out[i].toString(16).padStart(2, '0');
  return hex;
}

function parseIlinkAesKey(rawKey) {
  const s = String(rawKey || '').trim();
  if (!s) return null;
  const hexToBytes = (hex) => {
    if (!/^[0-9a-fA-F]{32}$/.test(hex)) return null;
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  };
  if (/^[0-9a-fA-F]{32}$/.test(s)) return hexToBytes(s);
  try {
    const bin = atob(s);
    if (bin.length === 16) {
      const out = new Uint8Array(16);
      for (let i = 0; i < 16; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    if (bin.length === 32 && /^[0-9a-fA-F]{32}$/.test(bin)) {
      return hexToBytes(bin);
    }
  } catch (e) {}
  return null;
}

// 标准 AES-128 S-Box 与密钥扩展（用于毫秒级同步 AES-128-ECB + PKCS#7 加密）
let AES_SBOX = null;
let AES_RCON = null;
function initAesTables() {
  if (AES_SBOX) return;
  AES_SBOX = new Uint8Array([
    0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
    0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
    0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
    0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
    0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
    0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
    0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
    0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
    0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
    0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
    0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
    0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
    0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
    0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
    0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
    0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16,
  ]);
  AES_RCON = new Uint8Array([0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36]);
}

function xtime(x) {
  return ((x << 1) ^ ((x & 0x80) ? 0x1b : 0x00)) & 0xff;
}

function expandAes128Key(key16) {
  initAesTables();
  const rk = new Uint8Array(176);
  rk.set(key16.subarray(0, 16), 0);
  const temp = new Uint8Array(4);
  for (let i = 16; i < 176; i += 4) {
    temp[0] = rk[i - 4];
    temp[1] = rk[i - 3];
    temp[2] = rk[i - 2];
    temp[3] = rk[i - 1];
    if (i % 16 === 0) {
      const t = temp[0];
      temp[0] = AES_SBOX[temp[1]] ^ AES_RCON[i >> 4];
      temp[1] = AES_SBOX[temp[2]];
      temp[2] = AES_SBOX[temp[3]];
      temp[3] = AES_SBOX[t];
    }
    rk[i] = rk[i - 16] ^ temp[0];
    rk[i + 1] = rk[i - 15] ^ temp[1];
    rk[i + 2] = rk[i - 14] ^ temp[2];
    rk[i + 3] = rk[i - 13] ^ temp[3];
  }
  return rk;
}

function encryptAes128Ecb(plainBytes, key16) {
  initAesTables();
  const input = plainBytes instanceof Uint8Array ? plainBytes : new Uint8Array(plainBytes || 0);
  const padLen = 16 - (input.length % 16);
  const totalLen = input.length + padLen;
  const out = new Uint8Array(totalLen);
  out.set(input, 0);
  out.fill(padLen, input.length, totalLen);

  const rk = expandAes128Key(key16);
  const state = new Uint8Array(16);
  const tmp = new Uint8Array(16);

  for (let offset = 0; offset < totalLen; offset += 16) {
    for (let i = 0; i < 16; i++) state[i] = out[offset + i] ^ rk[i];
    for (let round = 1; round <= 10; round++) {
      // SubBytes & ShiftRows
      tmp[0] = AES_SBOX[state[0]];
      tmp[1] = AES_SBOX[state[5]];
      tmp[2] = AES_SBOX[state[10]];
      tmp[3] = AES_SBOX[state[15]];
      tmp[4] = AES_SBOX[state[4]];
      tmp[5] = AES_SBOX[state[9]];
      tmp[6] = AES_SBOX[state[14]];
      tmp[7] = AES_SBOX[state[3]];
      tmp[8] = AES_SBOX[state[8]];
      tmp[9] = AES_SBOX[state[13]];
      tmp[10] = AES_SBOX[state[2]];
      tmp[11] = AES_SBOX[state[7]];
      tmp[12] = AES_SBOX[state[12]];
      tmp[13] = AES_SBOX[state[1]];
      tmp[14] = AES_SBOX[state[6]];
      tmp[15] = AES_SBOX[state[11]];

      const ro = round << 4;
      if (round < 10) {
        for (let c = 0; c < 16; c += 4) {
          const a0 = tmp[c], a1 = tmp[c + 1], a2 = tmp[c + 2], a3 = tmp[c + 3];
          const t = a0 ^ a1 ^ a2 ^ a3;
          state[c] = a0 ^ t ^ xtime(a0 ^ a1) ^ rk[ro + c];
          state[c + 1] = a1 ^ t ^ xtime(a1 ^ a2) ^ rk[ro + c + 1];
          state[c + 2] = a2 ^ t ^ xtime(a2 ^ a3) ^ rk[ro + c + 2];
          state[c + 3] = a3 ^ t ^ xtime(a3 ^ a0) ^ rk[ro + c + 3];
        }
      } else {
        for (let i = 0; i < 16; i++) state[i] = tmp[i] ^ rk[ro + i];
      }
    }
    out.set(state, offset);
  }
  return out;
}

// 纯 JS 零依赖 AES-128-ECB + PKCS#7 解密（不依赖 globalThis.crypto.subtle，在 EdgeOne Node 与 Workers 下 100% 兼容）
let AES_INV_SBOX = null;
function initAesInvTables() {
  initAesTables();
  if (AES_INV_SBOX) return;
  AES_INV_SBOX = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    AES_INV_SBOX[AES_SBOX[i]] = i;
  }
}

function gfMul(a, b) {
  let p = 0;
  let aa = a & 0xff;
  let bb = b & 0xff;
  for (let i = 0; i < 8; i++) {
    if (bb & 1) p ^= aa;
    const hi = aa & 0x80;
    aa = (aa << 1) & 0xff;
    if (hi) aa ^= 0x1b;
    bb >>= 1;
  }
  return p;
}

async function decryptAes128Ecb(cipherBytes, key16) {
  initAesInvTables();
  const input = cipherBytes instanceof Uint8Array ? cipherBytes : new Uint8Array(cipherBytes || 0);
  if (!input.length || input.length % 16 !== 0) return null;
  const n = input.length;
  const out = new Uint8Array(n);
  const rk = expandAes128Key(key16);
  const state = new Uint8Array(16);
  const tmp = new Uint8Array(16);

  for (let offset = 0; offset < n; offset += 16) {
    for (let i = 0; i < 16; i++) state[i] = input[offset + i] ^ rk[160 + i];
    for (let round = 9; round >= 0; round--) {
      // InvShiftRows & InvSubBytes
      tmp[0] = AES_INV_SBOX[state[0]];
      tmp[1] = AES_INV_SBOX[state[13]];
      tmp[2] = AES_INV_SBOX[state[10]];
      tmp[3] = AES_INV_SBOX[state[7]];
      tmp[4] = AES_INV_SBOX[state[4]];
      tmp[5] = AES_INV_SBOX[state[1]];
      tmp[6] = AES_INV_SBOX[state[14]];
      tmp[7] = AES_INV_SBOX[state[11]];
      tmp[8] = AES_INV_SBOX[state[8]];
      tmp[9] = AES_INV_SBOX[state[5]];
      tmp[10] = AES_INV_SBOX[state[2]];
      tmp[11] = AES_INV_SBOX[state[15]];
      tmp[12] = AES_INV_SBOX[state[12]];
      tmp[13] = AES_INV_SBOX[state[9]];
      tmp[14] = AES_INV_SBOX[state[6]];
      tmp[15] = AES_INV_SBOX[state[3]];

      const ro = round << 4;
      for (let i = 0; i < 16; i++) tmp[i] ^= rk[ro + i];

      if (round > 0) {
        for (let c = 0; c < 16; c += 4) {
          const s0 = tmp[c], s1 = tmp[c + 1], s2 = tmp[c + 2], s3 = tmp[c + 3];
          state[c] = gfMul(s0, 0x0e) ^ gfMul(s1, 0x0b) ^ gfMul(s2, 0x0d) ^ gfMul(s3, 0x09);
          state[c + 1] = gfMul(s0, 0x09) ^ gfMul(s1, 0x0e) ^ gfMul(s2, 0x0b) ^ gfMul(s3, 0x0d);
          state[c + 2] = gfMul(s0, 0x0d) ^ gfMul(s1, 0x09) ^ gfMul(s2, 0x0e) ^ gfMul(s3, 0x0b);
          state[c + 3] = gfMul(s0, 0x0b) ^ gfMul(s1, 0x0d) ^ gfMul(s2, 0x09) ^ gfMul(s3, 0x0e);
        }
      } else {
        for (let i = 0; i < 16; i++) state[i] = tmp[i];
      }
    }
    out.set(state, offset);
  }

  const pad = out[n - 1];
  if (pad >= 1 && pad <= 16) {
    let validPad = true;
    for (let i = n - pad; i < n; i++) {
      if (out[i] !== pad) { validPad = false; break; }
    }
    if (validPad) return out.subarray(0, n - pad);
  }
  return out;
}

// 从微信 CDN 下载并解密媒体文件
async function ilinkDownloadMediaBytes(cdnBaseUrl, encryptQueryParam, rawAesKey, maxBytes, timeoutMs) {
  const cdn = String(cdnBaseUrl || DEFAULT_ILINK_CDN_URL).trim().replace(/\/+$/, '');
  const eqp = String(encryptQueryParam || '').trim();
  if (!eqp) throw new Error('缺少 encrypted_query_param');
  const url = /^https?:\/\//i.test(eqp)
    ? eqp
    : `${cdn}/download?encrypted_query_param=${encodeURIComponent(eqp)}`;
  const res = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(timeoutMs || 15000),
  });
  if (!res.ok) throw new Error(`CDN 下载失败 (HTTP ${res.status})`);
  const buf = await res.arrayBuffer();
  if (maxBytes && buf.byteLength > maxBytes) {
    throw new Error(`媒体文件超过大小限制（最大 ${Math.round(maxBytes / 1024)} KB）`);
  }
  const encrypted = new Uint8Array(buf);
  const key16 = parseIlinkAesKey(rawAesKey);
  if (!key16) return encrypted;
  return (await decryptAes128Ecb(encrypted, key16)) || encrypted;
}

// 10. 上传并发送加密图片到微信聊天（getuploadurl -> AES-128-ECB -> CDN upload -> sendmessage image_item）
async function ilinkUploadAndSendImage(baseUrl, cdnBaseUrl, token, toUserId, contextToken, plainBytes, channelVersion, timeoutMs) {
  const rawBytes = plainBytes instanceof Uint8Array ? plainBytes : new Uint8Array(plainBytes || 0);
  if (!rawBytes.byteLength) throw new Error('图片内容为空');

  // 1) 生成随机 16 字节 AES 密钥与随机 filekey
  const key16 = new Uint8Array(16);
  const fkBytes = new Uint8Array(16);
  try {
    crypto.getRandomValues(key16);
    crypto.getRandomValues(fkBytes);
  } catch (e) {
    for (let i = 0; i < 16; i++) {
      key16[i] = Math.floor(Math.random() * 256);
      fkBytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let aesKeyHex = '';
  let filekey = '';
  let keyBin = '';
  for (let i = 0; i < 16; i++) {
    aesKeyHex += key16[i].toString(16).padStart(2, '0');
    filekey += fkBytes[i].toString(16).padStart(2, '0');
    keyBin += String.fromCharCode(key16[i]);
  }
  const aesKeyBase64 = btoa(keyBin);

  // 2) 计算明文 MD5 并执行 AES-128-ECB + PKCS#7 加密
  const rawsize = rawBytes.byteLength;
  const rawfilemd5 = md5Hex(rawBytes);
  const cipherBytes = encryptAes128Ecb(rawBytes, key16);
  const filesize = cipherBytes.byteLength;

  // 3) 请求 getuploadurl（必须携带 context_token，否则 iLink 返回 ret=-2 / -14）
  const uploadMeta = await ilinkPost(
    baseUrl,
    'ilink/bot/getuploadurl',
    {
      filekey,
      media_type: 1, // 1 = IMAGE
      to_user_id: String(toUserId || ''),
      rawsize,
      rawfilemd5,
      filesize,
      aeskey: aesKeyHex,
      no_need_thumb: true,
      context_token: String(contextToken || ''),
    },
    token,
    channelVersion,
    timeoutMs || 15000
  );

  if (uploadMeta && (uploadMeta.ret === -14 || uploadMeta.errcode === -14)) {
    return uploadMeta;
  }
  if (!uploadMeta || (uploadMeta.ret !== undefined && uploadMeta.ret !== 0) || (!uploadMeta.upload_param && !uploadMeta.upload_full_url)) {
    throw new Error(`getuploadurl 失败 (ret=${uploadMeta ? uploadMeta.ret : 'null'} ${uploadMeta && uploadMeta.errmsg ? uploadMeta.errmsg : ''})`);
  }

  // 4) 上传加密字节到微信 CDN
  const cdn = String(cdnBaseUrl || DEFAULT_ILINK_CDN_URL).trim().replace(/\/+$/, '');
  const uploadUrl = uploadMeta.upload_full_url
    ? String(uploadMeta.upload_full_url)
    : `${cdn}/upload?encrypted_query_param=${encodeURIComponent(String(uploadMeta.upload_param))}&filekey=${encodeURIComponent(filekey)}`;

  const cdnRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: cipherBytes,
    signal: AbortSignal.timeout(timeoutMs || 20000),
  });
  if (!cdnRes.ok) {
    throw new Error(`微信 CDN 上传失败 (HTTP ${cdnRes.status})`);
  }

  let encryptedParam = cdnRes.headers.get('x-encrypted-param') || cdnRes.headers.get('X-Encrypted-Param') || '';
  if (!encryptedParam) {
    try {
      const cdnJson = await cdnRes.json();
      encryptedParam = (cdnJson && (cdnJson.encrypt_query_param || cdnJson.encrypted_query_param || cdnJson.x_encrypted_param)) || '';
    } catch (e) {}
  }
  if (!encryptedParam) {
    throw new Error('微信 CDN 未返回 x-encrypted-param');
  }

  // 5) 调用 sendmessage 发送原生 image_item
  const clientId = 'wximg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  const sendBody = {
    msg: {
      from_user_id: '',
      to_user_id: String(toUserId || ''),
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      context_token: String(contextToken || ''),
      item_list: [
        {
          type: 2,
          image_item: {
            media: {
              encrypt_query_param: encryptedParam,
              aes_key: aesKeyBase64,
              encrypt_type: 1,
            },
            mid_size: filesize,
          },
        },
      ],
    },
  };
  return await ilinkPost(baseUrl, 'ilink/bot/sendmessage', sendBody, token, channelVersion, timeoutMs || 15000);
}


// ================= 11. 多格式文档正文提取器（支持 Word .docx / Excel .xlsx / PPT .pptx / PDF / Markdown / CSV / JSON / 代码，自动识别 UTF-8 与 GB18030） =================
const SUPPORTED_KB_FILE_EXT_RE = /\.(docx|xlsx|pptx|pdf|md|markdown|txt|csv|tsv|json|jsonl|log|rtf|py|js|mjs|cjs|ts|tsx|jsx|vue|svelte|html|htm|css|scss|less|xml|yaml|yml|toml|ini|conf| env|sh|bash|zsh|sql|go|rs|java|kt|swift|c|cpp|h|hpp|cs|php|rb|lua|r|dart)$/i;

function decodeTextSmart(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  if (!u8.byteLength) return '';
  // UTF-8 BOM
  if (u8.byteLength >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(u8.subarray(3));
  }
  // UTF-16LE BOM
  if (u8.byteLength >= 2 && u8[0] === 0xff && u8[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(u8.subarray(2));
  }
  // UTF-16BE BOM
  if (u8.byteLength >= 2 && u8[0] === 0xfe && u8[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(u8.subarray(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(u8);
  } catch (e) {
    try {
      return new TextDecoder('gb18030').decode(u8);
    } catch (e2) {
      return new TextDecoder('utf-8').decode(u8);
    }
  }
}

function decodeXmlEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10) || 32))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16) || 32));
}

async function inflateRawBytes(compData, format = 'raw') {
  if (typeof DecompressionStream === 'undefined') return null;
  if (format === 'zlib') {
    try {
      const ds = new DecompressionStream('deflate');
      const w = ds.writable.getWriter();
      w.write(compData).catch(() => {});
      w.close().catch(() => {});
      const reader = ds.readable.getReader();
      const chunks = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) { chunks.push(value); total += value.byteLength; }
        }
      } catch (err) {}
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.byteLength; }
      return out;
    } catch (e) {
      return null;
    }
  }
  try {
    const ds = new DecompressionStream('deflate-raw');
    const w = ds.writable.getWriter();
    w.write(compData).catch(() => {});
    w.close().catch(() => {});
    return new Uint8Array(await new Response(ds.readable).arrayBuffer());
  } catch (e) {
    // 兼容仅支持 'deflate' (zlib 封装) 的 Node 18 等运行时：前置 0x78 0x9c 头部读取解压流
    const wrapped = new Uint8Array(compData.byteLength + 2);
    wrapped[0] = 0x78;
    wrapped[1] = 0x9c;
    wrapped.set(compData, 2);
    return await inflateRawBytes(wrapped, 'zlib');
  }
}

async function extractZipXmlEntries(zipBytes, targetPattern) {
  const bytes = zipBytes instanceof Uint8Array ? zipBytes : new Uint8Array(zipBytes || 0);
  if (bytes.byteLength < 22) throw new Error('文件体积过小，不是合法的 Office/ZIP 文档');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocdPos = -1;
  const minPos = Math.max(0, bytes.byteLength - 65557);
  for (let i = bytes.byteLength - 22; i >= minPos; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos < 0) throw new Error('未找到 ZIP 目录签名，请确认文件是 .docx/.xlsx/.pptx 格式（老版二进制 .doc/.xls 请另存为 .docx/.xlsx）');
  const totalEntries = dv.getUint16(eocdPos + 10, true);
  const cdOffset = dv.getUint32(eocdPos + 16, true);
  let pos = cdOffset;
  const results = [];
  const dec = new TextDecoder('utf-8');

  for (let idx = 0; idx < totalEntries && pos + 46 <= bytes.byteLength; idx++) {
    if (dv.getUint32(pos, true) !== 0x02014b50) break;
    const method = dv.getUint16(pos + 10, true);
    const compSize = dv.getUint32(pos + 20, true);
    const fnLen = dv.getUint16(pos + 28, true);
    const extraLen = dv.getUint16(pos + 30, true);
    const commentLen = dv.getUint16(pos + 32, true);
    const localHdrOffset = dv.getUint32(pos + 42, true);
    const name = dec.decode(bytes.subarray(pos + 46, pos + 46 + fnLen));
    pos += 46 + fnLen + extraLen + commentLen;

    if (!targetPattern.test(name)) continue;
    if (localHdrOffset + 30 > bytes.byteLength) continue;
    const lFnLen = dv.getUint16(localHdrOffset + 26, true);
    const lExtraLen = dv.getUint16(localHdrOffset + 28, true);
    const dataStart = localHdrOffset + 30 + lFnLen + lExtraLen;
    if (dataStart + compSize > bytes.byteLength) continue;
    const compData = bytes.subarray(dataStart, dataStart + compSize);

    let rawBytes = null;
    if (method === 0) rawBytes = compData;
    else if (method === 8) rawBytes = await inflateRawBytes(compData, 'raw');
    if (rawBytes && rawBytes.byteLength) {
      results.push({ name, text: dec.decode(rawBytes) });
    }
  }
  return results;
}

async function extractWechatDocumentText(fileName, rawBytes) {
  const fname = String(fileName || 'document.txt').trim();
  const extMatch = /\.([a-zA-Z0-9]+)$/.exec(fname);
  const ext = extMatch ? extMatch[1].toLowerCase() : '';
  const bytes = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes || 0);

  // 1) Word (.docx)
  if (ext === 'docx') {
    const entries = await extractZipXmlEntries(bytes, /^word\/(document|header\d*|footer\d*)\.xml$/i);
    if (!entries.length) throw new Error('无法从 .docx 中解析出 word/document.xml');
    entries.sort((a, b) => (a.name.includes('document') ? -1 : 1));
    const parts = [];
    for (const e of entries) {
      const cleaned = decodeXmlEntities(
        e.text
          .replace(/<w:tab\b[^>]*\/>/gi, '\t')
          .replace(/<w:br\b[^>]*\/>/gi, '\n')
          .replace(/<\/w:p>/gi, '\n')
          .replace(/<\/w:tr>/gi, '\n')
          .replace(/<\/w:tc>/gi, ' | ')
          .replace(/<[^>]+>/g, '')
      ).replace(/\n{3,}/g, '\n\n').trim();
      if (cleaned) parts.push(cleaned);
    }
    return parts.join('\n\n').trim();
  }

  // 2) Excel (.xlsx)
  if (ext === 'xlsx') {
    const entries = await extractZipXmlEntries(bytes, /^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/i);
    if (!entries.length) throw new Error('无法从 .xlsx 中解析出工作表数据');
    const sharedStrings = [];
    const ssEntry = entries.find(e => /sharedStrings\.xml$/i.test(e.name));
    if (ssEntry) {
      const siMatches = ssEntry.text.match(/<si\b[^>]*>[\s\S]*?<\/si>/gi) || [];
      for (const si of siMatches) {
        const tParts = (si.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gi) || []).map(t => decodeXmlEntities(t.replace(/<[^>]+>/g, '')));
        sharedStrings.push(tParts.join(''));
      }
    }
    const sheets = entries.filter(e => /worksheets\/sheet\d+\.xml$/i.test(e.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const sheetTexts = [];
    sheets.forEach((sh, idx) => {
      const rows = sh.text.match(/<row\b[^>]*>[\s\S]*?<\/row>/gi) || [];
      const rowLines = [];
      for (const rowXml of rows) {
        const cells = rowXml.match(/<c\b[^>]*>[\s\S]*?<\/c>/gi) || [];
        const cellVals = [];
        for (const cXml of cells) {
          const isShared = /\bt="s"/i.test(cXml);
          const isInline = /\bt="inlineStr"/i.test(cXml);
          if (isInline) {
            const m = /<is\b[^>]*>([\s\S]*?)<\/is>/i.exec(cXml);
            cellVals.push(m ? decodeXmlEntities(m[1].replace(/<[^>]+>/g, '')).trim() : '');
          } else {
            const m = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(cXml);
            const rawV = m ? m[1].trim() : '';
            if (isShared && rawV !== '') {
              const sIdx = parseInt(rawV, 10);
              cellVals.push(sharedStrings[sIdx] !== undefined ? sharedStrings[sIdx] : rawV);
            } else {
              cellVals.push(decodeXmlEntities(rawV));
            }
          }
        }
        if (cellVals.some(v => v !== '')) rowLines.push(cellVals.join(' | '));
      }
      if (rowLines.length) sheetTexts.push(`### 工作表 ${idx + 1}\n` + rowLines.join('\n'));
    });
    return sheetTexts.join('\n\n').trim();
  }

  // 3) PowerPoint (.pptx)
  if (ext === 'pptx') {
    const entries = await extractZipXmlEntries(bytes, /^ppt\/slides\/slide\d+\.xml$/i);
    if (!entries.length) throw new Error('无法从 .pptx 中解析出幻灯片内容');
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const slides = [];
    entries.forEach((sl, idx) => {
      const txt = decodeXmlEntities(
        sl.text
          .replace(/<\/a:p>/gi, '\n')
          .replace(/<[^>]+>/g, '')
      ).replace(/\n{3,}/g, '\n\n').trim();
      if (txt) slides.push(`### 幻灯片第 ${idx + 1} 页\n${txt}`);
    });
    return slides.join('\n\n').trim();
  }

  // 4) PDF (.pdf) 轻量级文本流提取
  if (ext === 'pdf') {
    const latin = new TextDecoder('latin1').decode(bytes);
    const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    const extractedChunks = [];
    let m;
    let count = 0;
    while ((m = streamRegex.exec(latin)) !== null && count < 120) {
      count++;
      const rawStr = m[1];
      const chunkBytes = new Uint8Array(rawStr.length);
      for (let i = 0; i < rawStr.length; i++) chunkBytes[i] = rawStr.charCodeAt(i) & 0xff;
      let decodedStream = '';
      const inflated = await inflateRawBytes(chunkBytes, 'zlib');
      if (inflated && inflated.byteLength) {
        decodedStream = decodeTextSmart(inflated);
      } else {
        decodedStream = rawStr;
      }
      const tjMatches = decodedStream.match(/\(([^()\\]|\\.)*\)\s*Tj|\[([^\]]*)\]\s*TJ/g) || [];
      for (const tj of tjMatches) {
        const lits = tj.match(/\(([^()\\]|\\.)*\)/g) || [];
        const line = lits.map(l => l.slice(1, -1).replace(/\\([nrtbf()\\])/g, '$1')).join('');
        if (line.trim()) extractedChunks.push(line.trim());
      }
    }
    const joined = extractedChunks.join('\n').trim();
    if (joined.length >= 20) return joined;
    throw new Error('该 PDF 为扫描件或使用了自定义字库编码，建议转为 .docx / .md / .txt 或直接截图发给我识图');
  }

  // 5) HTML / XML / 文本 / Markdown / CSV / JSON / 代码
  let text = decodeTextSmart(bytes);
  if (ext === 'html' || ext === 'htm') {
    text = decodeXmlEntities(
      text
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer)>/gi, '\n')
        .replace(/<br\b[^>]*\/>/gi, '\n')
        .replace(/<[^>]+>/g, '')
    ).replace(/\n{3,}/g, '\n\n').trim();
  }
  return text.trim();
}

// 解析入站 iLink 消息体：提取文本、语音转写、引用上下文及图片/文件媒体描述
function extractWechatMessageContent(msg) {
  if (!msg || typeof msg !== 'object') {
    return { text: '', isUserMsg: false, fromUserId: '', contextToken: '', msgId: '' };
  }
  const fromUserId = String(msg.from_user_id || msg.user_id || '').trim();
  const contextToken = String(msg.context_token || '').trim();
  const msgType = msg.message_type !== undefined ? Number(msg.message_type) : 1;
  const isUserMsg = msgType === 1 && !!fromUserId;
  const msgId = String(msg.msg_id || msg.message_id || msg.seq || msg.client_id || '').trim();

  if (typeof msg.text === 'string' && msg.text.trim() && !Array.isArray(msg.item_list)) {
    return {
      text: msg.text.trim(),
      isUserMsg,
      fromUserId,
      contextToken,
      msgId,
      imageMedia: null,
      fileMedia: null,
    };
  }

  const items = Array.isArray(msg.item_list) ? msg.item_list : [];
  const textParts = [];
  let quotePrefix = '';
  let imageMedia = null;
  let fileMedia = null;
  let unsupportedMediaType = '';

  if (msg.ref_msg && (msg.ref_msg.title || msg.ref_msg.content)) {
    const q = String(msg.ref_msg.content || msg.ref_msg.title || '').trim();
    if (q) quotePrefix = `【引用消息：${q.slice(0, 300)}】\n`;
  }

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const t = Number(item.type);
    if (item.ref_msg && !quotePrefix) {
      const q = String(item.ref_msg.content || item.ref_msg.title || '').trim();
      if (q) quotePrefix = `【引用消息：${q.slice(0, 300)}】\n`;
    }
    if (t === 1 && item.text_item && typeof item.text_item.text === 'string') {
      const txt = item.text_item.text.trim();
      if (txt) textParts.push(txt);
    } else if (t === 3 && item.voice_item) {
      const vTxt = String(item.voice_item.text || item.voice_item.transcription || '').trim();
      if (vTxt) {
        textParts.push(vTxt);
      } else {
        unsupportedMediaType = '未包含文字转写的语音消息';
      }
    } else if (t === 2 && item.image_item) {
      const img = item.image_item;
      const media = img.media || {};
      const eqp = media.encrypt_query_param || img.encrypt_query_param || media.full_url || '';
      const aesKey = media.aes_key || img.aeskey || img.aes_key || '';
      const directUrl = img.url || media.url || media.full_url || '';
      if (eqp || directUrl) {
        imageMedia = { encryptQueryParam: eqp, aesKey, url: directUrl };
      } else {
        unsupportedMediaType = '图片消息（缺少媒体参数）';
      }
    } else if ((t === 4 || t === 3) && item.file_item) {
      const fi = item.file_item;
      const media = fi.media || {};
      const fileName = String(fi.file_name || fi.filename || 'document.txt');
      const eqp = media.encrypt_query_param || fi.encrypt_query_param || media.full_url || '';
      const aesKey = media.aes_key || fi.aeskey || fi.aes_key || '';
      if (eqp) {
        fileMedia = { fileName, encryptQueryParam: eqp, aesKey, fileSize: fi.file_size || fi.rawsize || 0 };
      } else {
        unsupportedMediaType = `文件《${fileName}》`;
      }
    } else if (t === 5 || item.video_item) {
      unsupportedMediaType = '视频消息';
    }
  }

  const combinedText = (quotePrefix ? quotePrefix + textParts.join('\n') : textParts.join('\n')).trim();
  return {
    text: combinedText,
    isUserMsg,
    fromUserId,
    contextToken,
    msgId,
    imageMedia,
    fileMedia,
    unsupportedMediaType,
  };
}

export {
  DEFAULT_ILINK_BASE_URL,
  DEFAULT_ILINK_CDN_URL,
  DEFAULT_ILINK_CHANNEL_VERSION,
  DEFAULT_BOT_AGENT,
  ILINK_BOT_TYPE,
  buildClientVersion,
  randomWechatUin,
  normalizeBaseUrl,
  buildBaseInfo,
  buildIlinkHeaders,
  ilinkPost,
  ilinkGetQrCode,
  ilinkGetQrStatus,
  ilinkNotifyStart,
  ilinkNotifyStop,
  ilinkGetUpdates,
  ilinkGetConfig,
  ilinkSendTyping,
  ilinkSendMessage,
  formatWechatText,
  md5Hex,
  parseIlinkAesKey,
  encryptAes128Ecb,
  decryptAes128Ecb,
  ilinkDownloadMediaBytes,
  ilinkUploadAndSendImage,
  SUPPORTED_KB_FILE_EXT_RE,
  decodeTextSmart,
  extractWechatDocumentText,
  extractWechatMessageContent,
};
