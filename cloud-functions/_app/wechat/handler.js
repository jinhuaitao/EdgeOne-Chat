// EdgeOne-Chat 微信 ClawBot（iLink Bot API / openclaw-weixin）全功能通道处理器：
// 支持：
// 1) 四重防盗绑安全机制：
//    - 强制管理鉴权：未配置 WX_ADMIN_SECRET 且未配置 ACCESS_PASSWORD 时严禁网页端扫码/解绑，杜绝公开网址被路人盗绑；
//    - 独立管理员密钥：支持配置专属 WX_ADMIN_SECRET（与普通访客的 ACCESS_PASSWORD 分离），未通过管理员鉴权时 /api/wx/status 隐藏一切敏感信息；
//    - 已绑定防覆盖锁：已处于有效连接状态时禁止直接生成新二维码覆盖，需管理员显式解锁/解绑；
//    - 号主自动校准与白名单：支持 WX_ALLOWED_USERS 白名单，未配置白名单时自动绑定并校准扫码微信号；
// 2) 三栖全天候消息接入：
//    - 网页全局自动守护长轮询（绑定后自动开启，无需手动勾选或保持弹窗打开）；
//    - 免开网页全天候保活唤醒（GET/POST /wx-webhook?key=... 或 /api/wx/poll?key=...&single_shot=0 满周期连续长轮询）；
//    - 第三方 iLink 网关 Webhook 消息推送；
// 3) 完整支持扫码节点重定向（scaned_but_redirect / binded_redirect）与数字配对码（need_verifycode）；
// 4) 原生微信加密图片直发（getuploadurl + AES-128-ECB + CDN 上传 + image_item），支持文生图模型与「画 <描述>」快捷生图；
// 5) 微信专属 Markdown 智能排版清洗（formatWechatText），告别裸露的 ** 与 ### 符号；
// 6) 中英双语快捷口令（菜单/帮助、模型/模型 序号、智能体/模式、画 <描述>、清空、记忆、忘掉、知识库、状态）+ 网页端会话同步与实时收发诊断日志。

import { APP_VERSION, CORS_HEADERS } from '../constants.js';
import { mapSetBounded, mapGetBounded, parseCommaSeparated, safeEqual } from '../utils.js';
import { storeGet, storePut, storePutChecked, storeDelete } from '../store/r2.js';
import { getChannelConfig, buildAIRequest, fetchWithKeyRotation, authHeaders } from '../channel.js';
import { tgTrimHistory, tgGetHistory, tgSaveHistory, tgClearHistory } from '../tg-history.js';
import { agentGetMemories, agentForgetMemory } from '../agent/memory.js';
import { agentGetMode, agentSetMode } from '../agent/mode.js';
import { agentLoadResumeState, agentClearResumeState, tgAgentResumeKey } from '../agent/resume.js';
import { tgAgentChat, tgAgentResume } from '../agent/loop.js';
import { readErrorBody } from '../agent/stability.js';
import { toolSaveDoc, toolListDocs, toolReadDoc, toolDeleteDoc, kbSearchDocBody } from '../kb/doc-tools.js';
import { kbGetRegistry, KB_DOCS_PREFIX } from '../kb/registry.js';
import { base64ToBytes, IMG_PREFIX } from '../images.js';
import {
  DEFAULT_ILINK_BASE_URL,
  DEFAULT_ILINK_CDN_URL,
  DEFAULT_ILINK_CHANNEL_VERSION,
  normalizeBaseUrl,
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
  ilinkDownloadMediaBytes,
  ilinkUploadAndSendImage,
  SUPPORTED_KB_FILE_EXT_RE,
  extractWechatDocumentText,
  extractWechatMessageContent,
} from './ilink.js';

// ================= 存储键名与 L1 内存缓存 =================
const WX_CREDS_KEY = 'wx_clawbot_creds';
const WX_DEDUP_KEY = 'wx_updates_dedup';
const WX_POLL_LOCK_KEY = 'wx_poll_lock';
const WX_DIAG_KEY = 'wx_diag_state';
const WX_DEDUP_WINDOW_MS = 10 * 60 * 1000;
const WX_DEDUP_MAX = 200;

let cachedWxCreds = null;
let cachedWxCredsExp = 0;

const wxUserModels = new Map();
const wxUserModelsExp = new Map();

const wxContextTokens = new Map();
const wxContextTokensExp = new Map();

const wxTypingTickets = new Map();
const wxTypingTicketsExp = new Map();

const wxCursors = new Map();
const wxCursorsExp = new Map();

// 扫码过程中的临时 redirect_baseurl 缓存（qrcode -> baseurl）
const wxQrRedirectNodes = new Map();

const seenWxMsgIds = new Map();
let activePollInIsolate = false;
let lastDaemonWakeCheckAt = 0;
let lastKnownPublicOrigin = '';

function isRealPublicOrigin(origin) {
  if (!origin || typeof origin !== 'string') return false;
  if (!/^https?:\/\//i.test(origin)) return false;
  if (/example\.com|localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(origin)) return false;
  return true;
}

function rememberPublicOrigin(urlOrOrigin) {
  try {
    const o = typeof urlOrOrigin === 'string' && urlOrOrigin.startsWith('http')
      ? new URL(urlOrOrigin).origin
      : (urlOrOrigin && urlOrOrigin.origin ? urlOrOrigin.origin : '');
    if (isRealPublicOrigin(o)) lastKnownPublicOrigin = o;
    return lastKnownPublicOrigin;
  } catch (e) {
    return lastKnownPublicOrigin;
  }
}

function computeWxRelayToken(botToken) {
  const t = String(botToken || '').trim();
  if (!t) return '';
  return md5Hex(new TextEncoder().encode('wx_self_relay_v1_' + t));
}

// 实时诊断状态（内存 + 存储双写）
const wxDiagMem = {
  lastPollAt: 0,
  lastInboundAt: 0,
  lastReplyAt: 0,
  lastError: '',
  totalPolls: 0,
  totalProcessed: 0,
  events: [],
};

async function wxRecordDiag(env, kind, detail, userId = '', persist = false) {
  const now = Date.now();
  if (kind === 'poll') {
    wxDiagMem.lastPollAt = now;
    wxDiagMem.totalPolls += 1;
  } else if (kind === 'inbound') {
    wxDiagMem.lastInboundAt = now;
  } else if (kind === 'reply' || kind === 'image') {
    wxDiagMem.lastReplyAt = now;
    wxDiagMem.totalProcessed += 1;
  } else if (kind === 'error') {
    wxDiagMem.lastError = String(detail || '').slice(0, 240);
  }
  if (kind !== 'poll') {
    wxDiagMem.events.unshift({
      ts: now,
      kind,
      userId: String(userId || ''),
      detail: String(detail || '').slice(0, 220),
    });
    if (wxDiagMem.events.length > 20) wxDiagMem.events.length = 20;
  }
  if (persist && env && env.R2) {
    try {
      await storePut(env, WX_DIAG_KEY, JSON.stringify({
        lastPollAt: wxDiagMem.lastPollAt,
        lastInboundAt: wxDiagMem.lastInboundAt,
        lastReplyAt: wxDiagMem.lastReplyAt,
        lastError: wxDiagMem.lastError,
        totalPolls: wxDiagMem.totalPolls,
        totalProcessed: wxDiagMem.totalProcessed,
        events: wxDiagMem.events.slice(0, 12),
      }));
    } catch (e) {}
  }
}

async function getWxDiagSummary(env) {
  if (wxDiagMem.events.length === 0 && env && env.R2) {
    try {
      const raw = await storeGet(env, WX_DIAG_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (p && typeof p === 'object') {
          if (p.lastPollAt > wxDiagMem.lastPollAt) wxDiagMem.lastPollAt = p.lastPollAt;
          if (p.lastInboundAt > wxDiagMem.lastInboundAt) wxDiagMem.lastInboundAt = p.lastInboundAt;
          if (p.lastReplyAt > wxDiagMem.lastReplyAt) wxDiagMem.lastReplyAt = p.lastReplyAt;
          if (!wxDiagMem.lastError && p.lastError) wxDiagMem.lastError = p.lastError;
          if (p.totalPolls > wxDiagMem.totalPolls) wxDiagMem.totalPolls = p.totalPolls;
          if (p.totalProcessed > wxDiagMem.totalProcessed) wxDiagMem.totalProcessed = p.totalProcessed;
          if (Array.isArray(p.events) && p.events.length) wxDiagMem.events = p.events.slice(0, 20);
        }
      }
    } catch (e) {}
  }
  return {
    lastPollAt: wxDiagMem.lastPollAt,
    lastInboundAt: wxDiagMem.lastInboundAt,
    lastReplyAt: wxDiagMem.lastReplyAt,
    lastError: wxDiagMem.lastError,
    totalPolls: wxDiagMem.totalPolls,
    totalProcessed: wxDiagMem.totalProcessed,
    events: wxDiagMem.events.slice(0, 12),
  };
}

function wxSafeId(id) {
  return String(id == null ? '' : id).replace(/[^a-zA-Z0-9_@.-]/g, '_').slice(0, 96);
}

// 为微信用户生成与 Telegram / Web 隔离的会话 ID（复用 tg-history / memory / mode / resume）
function wxSessionChatId(userId) {
  return 'wx_' + String(userId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 56);
}

function wxChannelVersion(env) {
  return String((env && env.WX_CHANNEL_VERSION) || DEFAULT_ILINK_CHANNEL_VERSION).trim() || DEFAULT_ILINK_CHANNEL_VERSION;
}

function uint8ToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ================= 0. 微信通道管理员鉴权（防路人盗绑核心防线） =================
function checkWxAdminAuth(env, request, url) {
  const adminSecret = String((env && env.WX_ADMIN_SECRET) || '').trim();
  const accessPwd = String((env && env.ACCESS_PASSWORD) || '').trim();
  const webhookSecret = String((env && env.WX_WEBHOOK_SECRET) || '').trim();
  const requiredSecret = adminSecret || accessPwd || webhookSecret;

  if (!requiredSecret) {
    return {
      authorized: false,
      noSecretConfigured: true,
      reason: '安全锁定：当前未配置 WX_ADMIN_SECRET 或 ACCESS_PASSWORD，为防止公开网址被他人恶意扫码绑定，已禁止网页端绑定操作。请在环境变量中设置 WX_ADMIN_SECRET（或使用 Telegram 机器人发送 /wxlogin 绑定）。',
    };
  }

  const providedAdmin = (request && request.headers && request.headers.get('X-Wx-Admin-Token')) || '';
  const providedAccess = (request && request.headers && request.headers.get('X-Access-Token')) || '';
  const providedWebhook = (request && request.headers && (request.headers.get('X-Wechat-Webhook-Secret') || request.headers.get('X-Webhook-Secret'))) || '';
  const authHeader = ((request && request.headers && request.headers.get('Authorization')) || '').replace(/^Bearer\s+/i, '').trim();
  const queryKey = (url && url.searchParams && url.searchParams.get('key')) || '';

  const candidates = [requiredSecret, adminSecret, accessPwd, webhookSecret].filter(Boolean);
  const inputs = [providedAdmin, providedAccess, providedWebhook, authHeader, queryKey].filter(Boolean);

  for (const inp of inputs) {
    for (const cand of candidates) {
      if (safeEqual(inp, cand)) {
        return { authorized: true, noSecretConfigured: false };
      }
    }
  }

  return {
    authorized: false,
    noSecretConfigured: false,
    reason: adminSecret
      ? '需要微信管理员密钥（WX_ADMIN_SECRET）才能执行此操作'
      : '需要访问口令（ACCESS_PASSWORD）才能执行此操作',
  };
}

// ================= 1. 微信 ClawBot 凭证存取（支持扫码持久化 + 环境变量兜底） =================
async function getWxCredentials(env, forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && cachedWxCreds && now < cachedWxCredsExp) {
    return cachedWxCreds;
  }

  if (env && env.WX_BOT_TOKEN) {
    const token = String(env.WX_BOT_TOKEN).trim();
    const botIdFromToken = token.includes(':') ? token.split(':')[0] : 'env_bot';
    cachedWxCreds = {
      bot_token: token,
      ilink_bot_id: String(env.WX_BOT_ID || botIdFromToken).trim(),
      ilink_user_id: String(env.WX_USER_ID || '').trim(),
      baseurl: normalizeBaseUrl(env.WX_BASE_URL || DEFAULT_ILINK_BASE_URL),
      cdn_url: String(env.WX_CDN_BASE_URL || DEFAULT_ILINK_CDN_URL).trim(),
      expired: false,
      errmsg: '',
      updated_at: '',
      source: 'env',
    };
    cachedWxCredsExp = Date.now() + 30 * 1000;
    return cachedWxCreds;
  }

  if (env && env.R2) {
    try {
      const raw = await storeGet(env, WX_CREDS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.bot_token) {
          cachedWxCreds = {
            bot_token: String(parsed.bot_token).trim(),
            ilink_bot_id: String(parsed.ilink_bot_id || 'default_bot').trim(),
            ilink_user_id: String(parsed.ilink_user_id || '').trim(),
            baseurl: normalizeBaseUrl(parsed.baseurl || (env && env.WX_BASE_URL) || DEFAULT_ILINK_BASE_URL),
            cdn_url: String(parsed.cdn_url || (env && env.WX_CDN_BASE_URL) || DEFAULT_ILINK_CDN_URL).trim(),
            expired: !!parsed.expired,
            errmsg: parsed.errmsg || '',
            updated_at: parsed.updated_at || '',
            relay_origin: String(parsed.relay_origin || ''),
            source: 'r2',
          };
          cachedWxCredsExp = Date.now() + 30 * 1000;
          return cachedWxCreds;
        }
      }
    } catch (e) {}
  }

  return null;
}

async function saveWxCredentials(env, creds) {
  const clean = {
    bot_token: String(creds.bot_token || '').trim(),
    ilink_bot_id: String(creds.ilink_bot_id || 'default_bot').trim(),
    ilink_user_id: String(creds.ilink_user_id || '').trim(),
    baseurl: normalizeBaseUrl(creds.baseurl || (env && env.WX_BASE_URL) || DEFAULT_ILINK_BASE_URL),
    cdn_url: String(creds.cdn_url || (env && env.WX_CDN_BASE_URL) || DEFAULT_ILINK_CDN_URL).trim(),
    expired: !!creds.expired,
    errmsg: String(creds.errmsg || ''),
    updated_at: creds.updated_at || new Date().toISOString(),
    relay_origin: String(creds.relay_origin || lastKnownPublicOrigin || ''),
    source: 'r2',
  };
  cachedWxCreds = clean;
  cachedWxCredsExp = Date.now() + 30 * 1000;
  if (env && env.R2) {
    return await storePutChecked(env, WX_CREDS_KEY, JSON.stringify(clean));
  }
  return true;
}

async function markWxSessionExpired(env, creds, errmsg) {
  if (!creds) return;
  const msg = String(errmsg || '会话已过期 (ret=-14)，请重新扫码绑定');
  await wxRecordDiag(env, 'error', msg, creds.ilink_user_id, true);
  const updated = Object.assign({}, creds, {
    expired: true,
    errmsg: msg,
    updated_at: new Date().toISOString(),
  });
  cachedWxCreds = updated;
  cachedWxCredsExp = Date.now() + 30 * 1000;
  if (env && env.R2 && creds.source !== 'env') {
    await storePut(env, WX_CREDS_KEY, JSON.stringify(updated));
  }
  if (creds.ilink_bot_id) {
    wxCursors.delete(creds.ilink_bot_id);
    wxCursorsExp.delete(creds.ilink_bot_id);
    await storeDelete(env, 'wx_cursor_' + wxSafeId(creds.ilink_bot_id));
  }
}

async function clearWxCredentials(env) {
  const prev = await getWxCredentials(env);
  cachedWxCreds = null;
  cachedWxCredsExp = 0;
  if (prev && prev.ilink_bot_id) {
    wxCursors.delete(prev.ilink_bot_id);
    wxCursorsExp.delete(prev.ilink_bot_id);
    await storeDelete(env, 'wx_cursor_' + wxSafeId(prev.ilink_bot_id));
  }
  await storeDelete(env, WX_CREDS_KEY);
}

// ================= 2. 游标 (get_updates_buf) 与 Context Token 持久化 =================
async function getWxCursor(env, botId) {
  const key = wxSafeId(botId || 'default_bot');
  const cached = mapGetBounded(wxCursors, key, env && env.R2 ? wxCursorsExp : null);
  if (typeof cached === 'string') return cached;
  const raw = await storeGet(env, 'wx_cursor_' + key);
  const val = typeof raw === 'string' ? raw : '';
  mapSetBounded(wxCursors, key, val, 100, wxCursorsExp, 60 * 1000);
  return val;
}

async function saveWxCursor(env, botId, buf) {
  if (buf === undefined || buf === null) return;
  const key = wxSafeId(botId || 'default_bot');
  const s = String(buf);
  const prev = mapGetBounded(wxCursors, key);
  mapSetBounded(wxCursors, key, s, 100, wxCursorsExp, 60 * 1000);
  if (s !== prev) {
    await storePut(env, 'wx_cursor_' + key, s);
  }
}

async function getWxContextToken(env, userId) {
  const key = wxSafeId(userId || 'default_user');
  const cached = mapGetBounded(wxContextTokens, key, env && env.R2 ? wxContextTokensExp : null);
  if (typeof cached === 'string' && cached) return cached;
  const raw = await storeGet(env, 'wx_ctx_' + key);
  if (raw) {
    mapSetBounded(wxContextTokens, key, raw, 500, wxContextTokensExp, 5 * 60 * 1000);
    return raw;
  }
  return '';
}

async function saveWxContextToken(env, userId, contextToken) {
  if (!userId || !contextToken) return;
  const key = wxSafeId(userId);
  const ct = String(contextToken).trim();
  if (!ct) return;
  const prev = mapGetBounded(wxContextTokens, key);
  mapSetBounded(wxContextTokens, key, ct, 500, wxContextTokensExp, 5 * 60 * 1000);
  if (ct !== prev) {
    await storePut(env, 'wx_ctx_' + key, ct);
    await storePut(env, 'wx_last_peer', JSON.stringify({
      user_id: String(userId),
      context_token: ct,
      ts: Date.now(),
    }));
  }
}

async function getWxLastPeer(env) {
  try {
    const raw = await storeGet(env, 'wx_last_peer');
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return null;
}

// ================= 3. 入站消息去重（L1 内存 + L2 Blob/KV 滚动窗口） =================
async function loadWxDedupWindow(env) {
  try {
    const raw = await storeGet(env, WX_DEDUP_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (Array.isArray(p)) return p;
    }
  } catch (e) {}
  return [];
}

async function markWxMsgSeen(env, msgKey) {
  if (!msgKey) return false;
  const now = Date.now();
  if (seenWxMsgIds.has(msgKey)) return true;
  const win = await loadWxDedupWindow(env);
  const fresh = win.filter(e => e && e.id && now - (e.ts || 0) < WX_DEDUP_WINDOW_MS);
  if (fresh.some(e => e.id === msgKey)) {
    seenWxMsgIds.set(msgKey, now);
    return true;
  }
  fresh.push({ id: msgKey, ts: now });
  if (fresh.length > WX_DEDUP_MAX) fresh.splice(0, fresh.length - WX_DEDUP_MAX);
  try { await storePutChecked(env, WX_DEDUP_KEY, JSON.stringify(fresh)); } catch (e) {}
  seenWxMsgIds.set(msgKey, now);
  for (const [k, t] of seenWxMsgIds) {
    if (now - t > WX_DEDUP_WINDOW_MS) seenWxMsgIds.delete(k);
  }
  return false;
}

async function releaseWxMsgForRetry(env, msgKey) {
  if (!msgKey) return;
  seenWxMsgIds.delete(msgKey);
  try {
    const win = await loadWxDedupWindow(env);
    const fresh = win.filter(e => !(e && e.id === msgKey));
    if (fresh.length !== win.length) await storePutChecked(env, WX_DEDUP_KEY, JSON.stringify(fresh));
  } catch (e) {}
}

// ================= 4. “对方正在输入…” 状态管理 =================
async function getOrFetchTypingTicket(env, creds, userId, contextToken) {
  const key = wxSafeId(userId);
  const cached = mapGetBounded(wxTypingTickets, key, wxTypingTicketsExp);
  if (typeof cached === 'string' && cached) return cached;
  try {
    const r = await ilinkGetConfig(creds.baseurl, creds.bot_token, userId, contextToken, wxChannelVersion(env), 8000);
    if (r && r.typing_ticket) {
      mapSetBounded(wxTypingTickets, key, r.typing_ticket, 500, wxTypingTicketsExp, 18 * 3600 * 1000);
      return r.typing_ticket;
    }
  } catch (e) {}
  return '';
}

async function sendWxTypingStatus(env, creds, userId, contextToken, status) {
  try {
    const ticket = await getOrFetchTypingTicket(env, creds, userId, contextToken);
    if (!ticket) return;
    await ilinkSendTyping(creds.baseurl, creds.bot_token, userId, ticket, status, wxChannelVersion(env), 6000);
  } catch (e) {}
}

// ================= 5. 微信文本分段与中英双语口令解析 =================
function splitWechatText(text, maxLength = 3800, maxChunks = 5) {
  const chunks = [];
  let remaining = String(text || '').trim();
  while (remaining.length > 0) {
    if (remaining.length <= maxLength || chunks.length >= maxChunks - 1) {
      if (remaining.length > maxLength * 2) {
        chunks.push(remaining.slice(0, maxLength * 2) + '\n\n…（内容过长，已截断显示）');
      } else {
        chunks.push(remaining);
      }
      break;
    }
    let sliceLength = maxLength;
    const lastNewline = remaining.lastIndexOf('\n', maxLength);
    if (lastNewline > Math.floor(maxLength * 0.7)) {
      sliceLength = lastNewline;
    }
    const chunk = remaining.slice(0, sliceLength).trim();
    remaining = remaining.slice(sliceLength).trim();
    if (chunk) chunks.push(chunk);
  }
  return chunks.length ? chunks : [''];
}

// 微信端不支持原生 / 斜杠菜单弹窗，因此同时支持 /cmd 与中文自然口令（如「菜单」「模型 2」「清空」「画 一只猫」）
function parseWxCommand(text) {
  const s = String(text || '').trim();
  if (!s) return null;

  // 1) 标准斜杠命令
  const slash = /^(\/[a-zA-Z]+)(?:\s+([\s\S]*))?$/.exec(s);
  if (slash) {
    const rawCmd = slash[1].toLowerCase();
    const rest = (slash[2] || '').trim();
    if (rawCmd === '/menu') return { cmd: '/help', rest };
    if (rawCmd === '/img' || rawCmd === '/image' || rawCmd === '/paint') return { cmd: '/draw', rest };
    return { cmd: rawCmd, rest };
  }

  // 2) 中文自然语言口令
  if (/^(菜单|帮助|指令|功能|命令|使用说明)$/.test(s)) {
    return { cmd: '/help', rest: '' };
  }
  if (/^(模型|模型列表|切换模型|换模型|查看模型)$/.test(s)) {
    return { cmd: '/model', rest: '' };
  }
  const modelMatch = /^(?:切换模型|换模型|模型)\s+(.+)$/.exec(s);
  if (modelMatch) {
    return { cmd: '/model', rest: modelMatch[1].trim() };
  }
  if (/^(模式|切换模式|智能体|智能体模式|普通模式)$/.test(s)) {
    return { cmd: '/agent', rest: '' };
  }
  if (/^(清空|清空上下文|新对话|重置|重置对话|清空记忆上下文)$/.test(s)) {
    return { cmd: '/clear', rest: '' };
  }
  if (/^(记忆|查看记忆|长期记忆)$/.test(s)) {
    return { cmd: '/memory', rest: '' };
  }
  const forgetMatch = /^(?:忘掉|删除记忆|清除记忆)\s+(.+)$/.exec(s);
  if (forgetMatch) {
    return { cmd: '/forget', rest: forgetMatch[1].trim() };
  }
  if (/^(知识库|查看知识库|文档列表)$/.test(s)) {
    return { cmd: '/kb', rest: '' };
  }
  if (/^(整理知识库|存入知识库|整理成知识库|保存到知识库|入库)$/.test(s)) {
    return { cmd: '/savekb', rest: '' };
  }
  const saveKbMatch = /^(?:整理知识库|存入知识库|整理成知识库|保存到知识库|保存知识库)[:：\s]+(.+)$/.exec(s);
  if (saveKbMatch) {
    return { cmd: '/savekb', rest: saveKbMatch[1].trim() };
  }
  const readKbMatch = /^(?:读取文档|查看文档|精读文档|打开文档)[:：\s]+(.+)$/.exec(s);
  if (readKbMatch) {
    return { cmd: '/readdoc', rest: readKbMatch[1].trim() };
  }
  const delKbMatch = /^(?:删除文档|删除知识库|删除知识库文档)[:：\s]+(.+)$/.exec(s);
  if (delKbMatch) {
    return { cmd: '/deldoc', rest: delKbMatch[1].trim() };
  }
  if (/^(状态|连接状态|运行状态|系统状态)$/.test(s)) {
    return { cmd: '/status', rest: '' };
  }
  const drawMatch = /^(?:画一张|画一幅|画个|画|生成图片|生图)[:：\s]+([\s\S]+)$/.exec(s);
  if (drawMatch && drawMatch[1].trim()) {
    return { cmd: '/draw', rest: drawMatch[1].trim() };
  }

  return null;
}

// 从图片数据源（二进制、data:image/...、/api/img/<id> 或 https://...）加载字节并加密发送至微信
async function sendWechatImageFromSource(env, creds, userId, contextToken, source) {
  const chanVer = wxChannelVersion(env);
  let imgBytes = null;

  if (source instanceof Uint8Array) {
    imgBytes = source;
  } else if (typeof source === 'string') {
    const s = source.trim();
    if (s.startsWith('data:image/')) {
      imgBytes = base64ToBytes(s);
    } else if (s.startsWith('/api/img/')) {
      const imgId = s.slice('/api/img/'.length).trim();
      const b64 = await storeGet(env, IMG_PREFIX + imgId);
      if (b64) imgBytes = base64ToBytes(b64);
    } else if (/^https?:\/\//i.test(s)) {
      const r = await fetch(s, { signal: AbortSignal.timeout(20000), redirect: 'follow' });
      if (!r.ok) throw new Error(`下载生成图片失败 (HTTP ${r.status})`);
      imgBytes = new Uint8Array(await r.arrayBuffer());
    } else if (s.length > 100 && !s.includes(' ')) {
      imgBytes = base64ToBytes(s);
    }
  }

  if (!imgBytes || !imgBytes.byteLength) {
    throw new Error('未能获取到有效图片字节数据');
  }

  const res = await ilinkUploadAndSendImage(
    creds.baseurl,
    creds.cdn_url,
    creds.bot_token,
    userId,
    contextToken,
    imgBytes,
    chanVer,
    25000
  );
  if (res && (res.ret === -14 || res.errcode === -14)) {
    await markWxSessionExpired(env, creds, res.errmsg);
    throw new Error('微信会话已过期 (ret=-14)');
  }
  if (res && res.ret !== undefined && res.ret !== 0) {
    throw new Error(`发送微信图片返回错误 (ret=${res.ret} ${res.errmsg || ''})`);
  }
  await wxRecordDiag(env, 'image', `向微信发送原图成功 (${Math.round(imgBytes.byteLength / 1024)} KB)`, userId, true);
  return res;
}

const SUPPORTED_DOC_EXT_RE = /\.(md|markdown|txt|csv|tsv|json|jsonl|log|py|js|mjs|ts|tsx|jsx|html|htm|css|xml|yaml|yml|toml|ini|conf|sh|bash|sql|go|rs|java|c|cpp|h)$/i;

// 自动调用 AI 对新入库文档进行结构化知识整理，并将「AI 结构化大纲 + 原始全文归档」自动同步写入知识库
async function autoOrganizeAndSaveKbDoc(env, chatId, activeModelId, docTitle, rawContent, sourceLabel, userNote = '') {
  const cleanTitle = String(docTitle || '未命名知识文档').replace(/[\r\n]+/g, ' ').trim().slice(0, 75) || '未命名知识文档';
  const fullText = String(rawContent || '').trim();
  if (!fullText) return { ok: false, error: '文档内容为空' };

  // 第一步：先将原始全文安全落盘入库（防止超大文档或网络抖动丢数据）
  let saveResult = '';
  if (env && env.R2) {
    saveResult = await toolSaveDoc(env, chatId, {
      title: cleanTitle,
      content: fullText,
      source: sourceLabel || 'wechat_upload',
    });
  }

  // 第二步：调用 AI 自动提炼结构化知识大纲、核心要点、关键数据与检索标签
  const excerpt = fullText.length > 42000
    ? fullText.slice(0, 42000) + '\n\n…（原文较长，以上为前 42000 字符）'
    : fullText;
  const kbMessages = [
    {
      role: 'system',
      content: '你是一位专业的知识库架构师。请将用户提供的文档或资料自动整理成结构严谨、高信息密度的知识库档案。必须完整保留原文中的关键数据、核心定义、流程步骤、条款规则与结论，切勿遗漏重要细节。',
    },
    {
      role: 'user',
      content: `请将以下资料《${cleanTitle}》自动整理为结构化知识库档案，严格包含以下四个部分：\n`
        + `1. 【📌 核心摘要】：用 2~4 句话高度概括文档主旨与用途；\n`
        + `2. 【🗂️ 结构化知识大纲】：按逻辑模块或章节详细提炼所有核心知识点、规则、公式、接口或流程；\n`
        + `3. 【📊 关键数据与结论速查】：提取文中的关键参数、数字指标、表格结论或时间节点；\n`
        + `4. 【🏷️ 检索关键词标签】：列出 5~10 个核心检索词。\n`
        + (userNote ? `\n用户附加说明：${userNote}\n` : '')
        + `\n原始资料内容如下：\n\`\`\`\n${excerpt}\n\`\`\``,
    },
  ];

  let organizedSummary = '';
  const aiCfg = buildAIRequest(env, activeModelId, kbMessages, false);
  if (!aiCfg.error) {
    try {
      const { resp } = await fetchWithKeyRotation(aiCfg, (key) => ({
        method: 'POST',
        headers: authHeaders(key),
        body: JSON.stringify(aiCfg.payload),
        signal: AbortSignal.timeout(55000),
      }));
      if (resp && resp.ok) {
        const d = await resp.json();
        if (d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) {
          organizedSummary = String(d.choices[0].message.content).trim();
        }
      }
    } catch (e) {}
  }

  // 第三步：将「AI 结构化知识整理 + 原始文档全文」合并写回知识库，实现检索与精读双优
  if (organizedSummary && env && env.R2) {
    const combinedDoc = `## 🤖 AI 自动整理知识大纲\n\n${organizedSummary}\n\n---\n\n## 📄 原始文档全文归档（${cleanTitle}）\n\n${fullText}`;
    saveResult = await toolSaveDoc(env, chatId, {
      title: cleanTitle,
      content: combinedDoc,
      source: sourceLabel || 'wechat_upload',
    });
  }

  return {
    ok: !!(env && env.R2 && /^已保存为知识库文档/.test(saveResult)),
    title: cleanTitle,
    organizedSummary: organizedSummary || ('（已提取原文共 ' + fullText.length + ' 字符）\n' + fullText.slice(0, 1200)),
    saveResult: saveResult || (env && env.R2 ? '已保存' : '⚠️ 当前未绑定持久化存储 (R2/Blob/KV)，仅在当前会话生效'),
    charCount: fullText.length,
  };
}

// 读取全部知识库文档列表与正文（供网页端自动同步展示）
async function loadAllKbDocsForSync(env) {
  if (!env || !env.R2) return [];
  try {
    const reg = await kbGetRegistry(env);
    if (!Array.isArray(reg) || !reg.length) return [];
    const docs = [];
    for (const entry of reg.slice(0, 30)) {
      let text = '';
      try {
        const obj = await env.R2.get(KB_DOCS_PREFIX + entry.file);
        if (obj) text = await obj.text();
      } catch (e) {}
      const cleanBody = text.replace(/^---[\s\S]*?---\s*/, '').trim();
      docs.push({
        file: entry.file,
        title: entry.title || entry.file,
        size: entry.size || cleanBody.length,
        updatedAt: entry.updated_at || '',
        source: entry.source || '',
        content: cleanBody.slice(0, 25000),
      });
    }
    return docs;
  } catch (e) {
    return [];
  }
}

// ================= 6. 单条微信入站消息核心处理（口令 + 多模态 + 原图直发 + Agent 循环） =================
async function processWechatMessage(env, creds, rawMsg) {
  const parsed = extractWechatMessageContent(rawMsg);
  if (!parsed.isUserMsg || !parsed.fromUserId) return { skipped: true, reason: 'not_user_msg' };

  const userId = parsed.fromUserId;
  const allowedUsers = parseCommaSeparated(env.WX_ALLOWED_USERS);
  if (allowedUsers.length > 0) {
    if (allowedUsers.indexOf(userId) === -1) {
      await wxRecordDiag(env, 'error', `拦截非白名单微信号: ${userId}`, userId, false);
      return { skipped: true, reason: 'user_not_in_whitelist' };
    }
  } else if (creds) {
    // 若扫码阶段未返回 @im.wechat 格式的 user_id，首次收到消息时自动校准绑定为号主；
    // 若已绑定明确的 @im.wechat 号主，则拦截其他微信号（可通过 WX_ALLOW_ANY_USER=1 放开）
    if (!creds.ilink_user_id || !creds.ilink_user_id.includes('@im.wechat')) {
      creds.ilink_user_id = userId;
      if (creds.source !== 'env') {
        try { await saveWxCredentials(env, creds); } catch (e) {}
      }
    } else if (creds.ilink_user_id !== userId && String((env && env.WX_ALLOW_ANY_USER) || '') !== '1') {
      await wxRecordDiag(env, 'error', `拦截非绑定人微信号: ${userId} (已绑定: ${creds.ilink_user_id})`, userId, false);
      return { skipped: true, reason: 'not_bound_owner' };
    }
  }

  let contextToken = parsed.contextToken;
  if (contextToken) {
    await saveWxContextToken(env, userId, contextToken);
  } else {
    contextToken = await getWxContextToken(env, userId);
  }
  if (!contextToken) {
    await wxRecordDiag(env, 'error', '入站消息缺少 context_token', userId, false);
    return { skipped: true, reason: 'missing_context_token' };
  }

  const dedupKey = parsed.msgId
    ? `id:${parsed.msgId}`
    : `hash:${userId}:${contextToken.slice(-24)}:${(parsed.text || '').slice(0, 48)}`;
  if (await markWxMsgSeen(env, dedupKey)) {
    return { skipped: true, reason: 'duplicate' };
  }

  const chatId = wxSessionChatId(userId);
  const chanVer = wxChannelVersion(env);
  await wxRecordDiag(
    env,
    'inbound',
    parsed.text
      ? parsed.text.slice(0, 120)
      : (parsed.imageMedia ? '[收到微信图片]' : (parsed.fileMedia ? `[收到文件: ${parsed.fileMedia.fileName}]` : '[收到媒体消息]')),
    userId,
    false
  );

  // 发送经过微信原生排版清洗的文字回复
  const sendReply = async (replyText, skipFormat = false) => {
    const cleanText = skipFormat ? String(replyText || '').trim() : formatWechatText(replyText);
    const chunks = splitWechatText(cleanText, 3800, 5);
    for (const chunk of chunks) {
      if (!chunk) continue;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const latestCtxToken = (await getWxContextToken(env, userId)) || contextToken;
          const r = await ilinkSendMessage(creds.baseurl, creds.bot_token, userId, chunk, latestCtxToken, chanVer, 15000);
          if (r && (r.ret === -14 || r.errcode === -14)) {
            await markWxSessionExpired(env, creds, r.errmsg);
            return;
          }
          if (r && r.ret !== undefined && r.ret !== 0) {
            throw new Error(`iLink sendmessage ret=${r.ret} ${r.errmsg || ''}`.trim());
          }
          break;
        } catch (e) {
          if (attempt === 3) throw e;
          await new Promise(r => { const t = setTimeout(r, 600 * attempt); if (t && typeof t.unref === 'function') t.unref(); });
        }
      }
    }
    await wxRecordDiag(env, 'reply', cleanText.slice(0, 120), userId, true);
  };

  try {
    const { models: modelObjList } = getChannelConfig(env);
    if (modelObjList.length === 0) {
      await sendReply('⚠️ 尚未配置任何 AI 模型，请在环境变量中设置 API_URL_1 / API_KEY_1 / MODEL_1。', true);
      return { processed: true };
    }

    let userText = parsed.text || '';
    let historyUserText = userText;
    let multimodalContent = null;

    // 处理入站图片消息（支持图+文同时发送，或单独发图）
    if (parsed.imageMedia) {
      try {
        await sendWxTypingStatus(env, creds, userId, contextToken, 1);
        let imgBytes = null;
        if (parsed.imageMedia.encryptQueryParam) {
          imgBytes = await ilinkDownloadMediaBytes(
            creds.cdn_url,
            parsed.imageMedia.encryptQueryParam,
            parsed.imageMedia.aesKey,
            3 * 1024 * 1024,
            15000
          );
        } else if (parsed.imageMedia.url) {
          const r = await fetch(parsed.imageMedia.url, { signal: AbortSignal.timeout(15000) });
          if (r.ok) imgBytes = new Uint8Array(await r.arrayBuffer());
        }
        if (imgBytes && imgBytes.byteLength > 0) {
          const dataUrl = 'data:image/jpeg;base64,' + uint8ToBase64(imgBytes);
          const promptForImg = userText || '请详细查看并分析这张图片的内容。';
          userText = promptForImg;
          historyUserText = '[微信图片] ' + promptForImg;
          multimodalContent = [
            { type: 'text', text: promptForImg },
            { type: 'image_url', image_url: { url: dataUrl } },
          ];
        } else if (!userText) {
          await sendReply('⚠️ 暂无法读取该微信图片内容，请附带文字描述或稍后重试。', true);
          return { processed: true };
        }
      } catch (e) {
        if (!userText) {
          await sendReply('⚠️ 读取微信图片失败：' + (e && e.message ? e.message : String(e)), true);
          return { processed: true };
        }
      }
    } else if (parsed.fileMedia) {
      const fm = parsed.fileMedia;
      if (!SUPPORTED_KB_FILE_EXT_RE.test(fm.fileName)) {
        await sendReply('⚠️ 暂不支持该文件格式（' + fm.fileName + '）。支持自动整理入库的格式：Word (.docx)、Excel (.xlsx)、PPT (.pptx)、PDF (.pdf)、Markdown (.md)、文本 (.txt)、表格 (.csv/.tsv)、JSON/YAML/HTML/XML 及各类代码文件。', true);
        return { processed: true };
      }
      try {
        await sendWxTypingStatus(env, creds, userId, contextToken, 1);
        const bytes = await ilinkDownloadMediaBytes(creds.cdn_url, fm.encryptQueryParam, fm.aesKey, 4 * 1024 * 1024, 20000);
        let docText = await extractWechatDocumentText(fm.fileName, bytes);
        if (!docText || !docText.trim()) {
          await sendWxTypingStatus(env, creds, userId, contextToken, 2);
          await sendReply(`⚠️ 文件《${fm.fileName}》未能解析出有效文本内容。`, true);
          return { processed: true };
        }
        if (docText.length > 90000) {
          docText = docText.slice(0, 90000) + '\n\n…（文件较长，已截取前 90000 字符）';
        }

        // 获取当前选中的模型
        let fModelId = mapGetBounded(wxUserModels, chatId, env && env.R2 ? wxUserModelsExp : null);
        if (!fModelId) fModelId = await storeGet(env, `tg_user_${chatId}`);
        const useModelId = (fModelId && modelObjList.some(m => m.id === fModelId)) ? fModelId : modelObjList[0].id;

        const docTitle = String(fm.fileName || '微信上传文档').replace(/\.[^.]+$/, '').trim() || fm.fileName;
        const orgRes = await autoOrganizeAndSaveKbDoc(
          env,
          chatId,
          useModelId,
          docTitle,
          docText,
          'wechat_file:' + fm.fileName,
          userText
        );
        await sendWxTypingStatus(env, creds, userId, contextToken, 2);

        const kbReply = `📚 文件《${fm.fileName}》已自动整理并同步入库！\n`
          + `────────────\n`
          + `${orgRes.organizedSummary}\n`
          + `────────────\n`
          + `✅ 入库状态：${orgRes.saveResult}\n`
          + `🔄 已自动同步至微信、Telegram 与网页端「📚 知识库中心」，后续在任意端直接提问即可自动检索引用！`;

        // 将本次文件整理结果同步写入会话历史，方便后续直接追问及网页端同步查看
        const baseHist = await tgGetHistory(env, chatId);
        let nextHist = baseHist.slice();
        nextHist.push({ role: 'user', content: `【上传文件并自动整理入库：《${fm.fileName}》】\n` + docText.slice(0, 4000) });
        nextHist.push({ role: 'assistant', content: kbReply });
        nextHist = tgTrimHistory(nextHist, env);
        await tgSaveHistory(env, chatId, nextHist);

        await wxRecordDiag(env, 'reply', `自动整理文件入库《${docTitle}》(${docText.length}字)`, userId, true);
        await sendReply(kbReply);
        return { processed: true };
      } catch (e) {
        await sendWxTypingStatus(env, creds, userId, contextToken, 2);
        await sendReply('⚠️ 解析并整理微信上传文件失败：' + (e && e.message ? e.message : String(e)), true);
        return { processed: true };
      }
    } else if (!userText && parsed.unsupportedMediaType) {
      await sendReply(`⚠️ 收到${parsed.unsupportedMediaType}，当前通道支持文字、语音转文字、发图识图、画图生成及文本类文档（.md/.txt/.csv/.json/代码）。`, true);
      return { processed: true };
    }

    if (!userText) return { skipped: true, reason: 'empty_text' };

    let targetModelId = mapGetBounded(wxUserModels, chatId, env && env.R2 ? wxUserModelsExp : null);
    if (!targetModelId) {
      targetModelId = await storeGet(env, `tg_user_${chatId}`);
      if (targetModelId) mapSetBounded(wxUserModels, chatId, targetModelId, undefined, wxUserModelsExp);
    }
    const activeModelId = (targetModelId && modelObjList.some(m => m.id === targetModelId))
      ? targetModelId
      : modelObjList[0].id;
    const activeModelObj = modelObjList.find(m => m.id === activeModelId) || modelObjList[0];

    const cmd = !multimodalContent ? parseWxCommand(userText) : null;

    // 1) /start 或 /model 或「模型」
    if (cmd && (cmd.cmd === '/start' || cmd.cmd === '/model')) {
      const arg = cmd.rest.trim();
      if (cmd.cmd === '/model' && arg) {
        let picked = null;
        const idx = parseInt(arg, 10);
        if (String(idx) === arg && idx >= 1 && idx <= modelObjList.length) {
          picked = modelObjList[idx - 1];
        } else {
          const q = arg.toLowerCase();
          picked = modelObjList.find(m => m.id.toLowerCase() === q || m.name.toLowerCase() === q)
            || modelObjList.find(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
        }
        if (!picked) {
          await sendReply(`⚠️ 未找到匹配的模型「${arg}」。\n请直接发送「模型」或「/model」查看可用模型列表与编号。`, true);
          return { processed: true };
        }
        mapSetBounded(wxUserModels, chatId, picked.id, undefined, wxUserModelsExp);
        await storePut(env, `tg_user_${chatId}`, picked.id);
        await sendReply(`✅ 已切换模型为：${picked.name} (${picked.id})`, true);
        return { processed: true };
      }

      const useAgentNow = await agentGetMode(env, chatId);
      const listLines = modelObjList.map((m, i) => {
        const mark = m.id === activeModelId ? ' ✅ [当前]' : '';
        return `${i + 1}. ${m.name} (${m.id})${mark}`;
      }).join('\n');

      await sendReply(
        `🟢 EdgeOne-Chat 微信 ClawBot 助手 (v${APP_VERSION})\n`
        + `────────────\n`
        + `🤖 当前模式：${useAgentNow ? 'Agent 智能体（19 项工具 + 记忆 + 知识库）' : '普通对话模式'}\n`
        + `🎯 可用模型列表：\n${listLines}\n\n`
        + `💡 微信快捷口令（无需敲斜杠，直接发中文即可）：\n`
        + `• 发「模型 序号」（如：模型 2）—— 切换模型\n`
        + `• 发「画 画面描述」—— AI 生图并直接发原图到微信\n`
        + `• 发「模式」—— 切换 Agent / 普通对话\n`
        + `• 发「清空」—— 开启新对话\n`
        + `• 发「菜单」—— 查看完整功能指南`,
        true
      );
      return { processed: true };
    }

    // 2) /clear 或 /new 或「清空」
    if (cmd && (cmd.cmd === '/clear' || cmd.cmd === '/new')) {
      await tgClearHistory(env, chatId);
      await agentClearResumeState(env, chatId);
      await sendReply('🧹 当前微信会话上下文已清空，可以开始新的话题了。', true);
      return { processed: true };
    }

    // 3) /help 或「菜单」「帮助」
    if (cmd && cmd.cmd === '/help') {
      const useAgentNow = await agentGetMode(env, chatId);
      await sendReply(
        `🤖 微信 ClawBot 完整功能与口令菜单\n`
        + `────────────\n`
        + `📌 当前模型：${activeModelObj.name}\n`
        + `📌 当前模式：${useAgentNow ? '🤖 Agent 智能体模式' : '💬 普通对话模式'}\n\n`
        + `▎一、中文快捷口令（也可带 / 斜杠）\n`
        + `• 「模型」或 /model —— 查看模型列表\n`
        + `• 「模型 2」或 /model 2 —— 切换到第 2 个模型\n`
        + `• 「画 宇航员猫咪」或 /draw —— 生成图片并直发微信原图\n`
        + `• 「模式」或 /agent —— 切换 Agent / 普通对话模式\n`
        + `• 「清空」或 /clear —— 清空对话上下文\n`
        + `• 「记忆」或 /memory —— 查看长期记忆（平时说「记住…」即可保存）\n`
        + `• 「忘掉 关键词」或 /forget —— 删除指定记忆\n`
        + `• 「知识库」或 /kb —— 查看知识库文档与记忆统计\n`
        + `• 「状态」或 /status —— 查看通道健康度与会话统计\n`
        + `• 「继续」—— 当长任务暂停时接着完成推理\n\n`
        + `▎二、多模态能力\n`
        + `• 🎙️ 发语音：自动语音转文字并回答\n`
        + `• 🖼️ 发图片：自动解密并进行 Vision 视觉分析\n`
        + `• 📄 发文件：支持 .md/.txt/.csv/.json/代码文件阅读与存入知识库`,
        true
      );
      return { processed: true };
    }

    // 4) /status 或「状态」
    if (cmd && cmd.cmd === '/status') {
      const useAgentNow = await agentGetMode(env, chatId);
      const mems = await agentGetMemories(env, chatId);
      const hist = await tgGetHistory(env, chatId);
      await sendReply(
        `📊 微信 ClawBot 运行状态\n`
        + `────────────\n`
        + `• 连接状态：🟢 在线正常\n`
        + `• 当前模型：${activeModelObj.name} (${activeModelObj.id})\n`
        + `• 对话模式：${useAgentNow ? '🤖 Agent 智能体模式' : '💬 普通对话模式'}\n`
        + `• 上下文轮数：${Math.floor(hist.length / 2)} 轮（${hist.length} 条消息）\n`
        + `• 长期记忆：${mems.length} 条\n`
        + `• 持久化存储：${env && env.R2 ? '✅ 已接通' : '⚠️ 内存模式'}\n`
        + `• 累计轮询/回复：${wxDiagMem.totalPolls} 次 / ${wxDiagMem.totalProcessed} 条`,
        true
      );
      return { processed: true };
    }

    // 5) /memory 或「记忆」
    if (cmd && cmd.cmd === '/memory') {
      const mems = await agentGetMemories(env, chatId);
      if (!mems.length) {
        await sendReply('🧠 暂无长期记忆。\n\n平时直接在对话中对我说「记住xxx」即可永久保存，例如：记住，我喜欢用 Python 写脚本。', true);
      } else {
        let text = `🧠 长期记忆（共 ${mems.length} 条）：\n────────────\n`;
        mems.forEach((mm, i) => { text += `${i + 1}. ${mm.fact}\n`; });
        text += '\n💡 发送「忘掉 关键词」可删除对应记忆。';
        await sendReply(text, true);
      }
      return { processed: true };
    }

    // 6) /kb 或「知识库」
    if (cmd && cmd.cmd === '/kb') {
      const mems = await agentGetMemories(env, chatId);
      let text = '📚 知识库总览（三端实时自动同步）\n────────────\n';
      text += `🧠 长期记忆：共 ${mems.length} 条（发「记忆」查看，「忘掉 关键词」删除）\n\n`;
      text += await toolListDocs(env);
      text += '\n\n💡 快捷操作：\n• 直接在微信发送文件（.docx/.xlsx/.pptx/.pdf/.md/.txt/.csv/代码）即可【自动整理入库】\n• 发「整理知识库 标题」可将刚聊的内容自动整理入库\n• 发「读取文档 标题」查看内容 | 发「删除文档 标题」删除';
      await sendReply(text, true);
      return { processed: true };
    }

    if (cmd && cmd.cmd === '/readdoc') {
      const q = cmd.rest.trim();
      if (!q) {
        await sendReply('📖 用法：发送「读取文档 标题关键词」或「/readdoc 标题关键词」', true);
      } else {
        const content = await toolReadDoc(env, { query: q, offset: 0 });
        await sendReply(content);
      }
      return { processed: true };
    }

    if (cmd && cmd.cmd === '/deldoc') {
      const q = cmd.rest.trim();
      if (!q) {
        await sendReply('🗑️ 用法：发送「删除文档 标题关键词」或「/deldoc 标题关键词」', true);
      } else {
        const res = await toolDeleteDoc(env, { query: q });
        await sendReply('🗑️ ' + res, true);
      }
      return { processed: true };
    }

    if (cmd && cmd.cmd === '/savekb') {
      await sendWxTypingStatus(env, creds, userId, contextToken, 1);
      const hist = await tgGetHistory(env, chatId);
      if (!hist.length) {
        await sendWxTypingStatus(env, creds, userId, contextToken, 2);
        await sendReply('⚠️ 当前会话暂无上下文可整理。你可以直接发送文件给我自动整理入库，或先聊几句再发「整理知识库 标题」。', true);
        return { processed: true };
      }
      const recentTurns = hist.slice(-12).map(m => `${m.role === 'assistant' ? 'AI' : '用户'}：${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n\n');
      const customTitle = cmd.rest.trim() || ('对话知识整理_' + new Date().toISOString().slice(0, 10));
      const orgRes = await autoOrganizeAndSaveKbDoc(env, chatId, activeModelId, customTitle, recentTurns, 'wechat_chat_summary');
      await sendWxTypingStatus(env, creds, userId, contextToken, 2);
      await sendReply(
        `📚 已将当前对话自动整理并存入知识库：《${orgRes.title}》\n`
        + `────────────\n`
        + `${orgRes.organizedSummary}\n`
        + `────────────\n`
        + `✅ ${orgRes.saveResult}`,
      );
      return { processed: true };
    }

    // 7) /forget 或「忘掉 关键词」
    if (cmd && cmd.cmd === '/forget') {
      const kw = cmd.rest;
      if (!kw) {
        await sendReply('用法：发「忘掉 关键词」或「/forget 关键词」\n例如：忘掉 猫 —— 删除所有包含「猫」的记忆', true);
      } else {
        const rr = await agentForgetMemory(env, chatId, kw);
        await sendReply(rr.persistError ? '⚠️ ' + rr.persistError : (rr.removed > 0 ? `🗑 已删除 ${rr.removed} 条包含「${kw}」的记忆。` : `没有找到包含「${kw}」的记忆。`), true);
      }
      return { processed: true };
    }

    // 8) /agent 或「模式」
    if (cmd && cmd.cmd === '/agent') {
      const cur = await agentGetMode(env, chatId);
      await agentSetMode(env, chatId, !cur);
      await sendReply(
        !cur
          ? '🤖 Agent 智能体模式已开启\n\n我会自主规划并调用 19 项工具（🔍 联网搜索、📄 网页抓取、🌐 维基百科、🐙 GitHub、🎓 arXiv、🔥 热榜、💱 汇率/币价、🖧 DNS/IP、🧮 计算、📏 换算、🔤 编码、🌤 天气、🕐 时间），并支持 🧠 长期记忆与 📚 知识库文档读写。'
          : '💬 已切换为普通对话模式\n\n单轮直接问答，不调用工具、不使用长期记忆。如需切回请再发「模式」或 /agent。',
        true
      );
      return { processed: true };
    }

    // 9) /draw 或「画 <描述>」—— 自动选择图像模型（或当前模型）生图并加密直发微信原图
    if (cmd && cmd.cmd === '/draw') {
      const drawPrompt = cmd.rest.trim();
      if (!drawPrompt) {
        await sendReply('🎨 用法：发送「画 画面描述」或「/draw 画面描述」\n例如：画 一只穿宇航服在月球喝咖啡的橘猫，赛博朋克风格', true);
        return { processed: true };
      }
      await sendWxTypingStatus(env, creds, userId, contextToken, 1);

      // 优先查找已配置为 /images/generations 的生图模型，或名称含 Paint/Draw/Flux/Image/DALL/Kolors/生图/画图 的模型
      let drawModelId = activeModelId;
      for (const m of modelObjList) {
        const probe = buildAIRequest(env, m.id, [{ role: 'user', content: drawPrompt }], false);
        if (probe && probe.isImageAPI) {
          drawModelId = m.id;
          break;
        }
      }

      const drawCfg = buildAIRequest(env, drawModelId, [{ role: 'user', content: drawPrompt }], false);
      if (drawCfg && drawCfg.isImageAPI) {
        try {
          const { resp } = await fetchWithKeyRotation(drawCfg, (key) => ({
            method: 'POST',
            headers: authHeaders(key),
            body: JSON.stringify(drawCfg.payload),
            signal: AbortSignal.timeout(60000),
          }));
          if (!resp.ok) {
            const errTxt = await readErrorBody(resp, 300);
            await sendWxTypingStatus(env, creds, userId, contextToken, 2);
            await sendReply(`⚠️ 图像生成接口报错 (HTTP ${resp.status})：${errTxt}`, true);
            return { processed: true };
          }
          const imgData = await resp.json();
          const item = (imgData && Array.isArray(imgData.data) && imgData.data[0])
            || (imgData && Array.isArray(imgData.images) && imgData.images[0])
            || null;
          const imgSource = item ? (item.b64_json ? ('data:image/png;base64,' + item.b64_json) : item.url) : '';
          await sendWxTypingStatus(env, creds, userId, contextToken, 2);
          if (!imgSource) {
            await sendReply('⚠️ 图像接口未返回有效图片数据。', true);
            return { processed: true };
          }
          try {
            await sendWechatImageFromSource(env, creds, userId, contextToken, imgSource);
          } catch (uploadErr) {
            if (/^https?:\/\//i.test(imgSource)) {
              await sendReply(`🎨 图片已生成（微信 CDN 原图投递降级，请点击链接查看）：\n${imgSource}`, true);
            } else {
              await sendReply('⚠️ 微信原图投递失败：' + (uploadErr && uploadErr.message ? uploadErr.message : String(uploadErr)), true);
            }
          }
          return { processed: true };
        } catch (e) {
          await sendWxTypingStatus(env, creds, userId, contextToken, 2);
          await sendReply('⚠️ 生图请求异常：' + (e && e.message ? e.message : String(e)), true);
          return { processed: true };
        }
      }
      // 若当前没有配置独立的 /images/generations 渠道，则将 userText 交给当前模型处理
      userText = drawPrompt;
      historyUserText = '画 ' + drawPrompt;
    }

    // 异步非阻塞触发“对方正在输入…”并启动 5s 自动续期心跳，确保长推理/生图期间手机端提示不中断
    sendWxTypingStatus(env, creds, userId, contextToken, 1).catch(() => {});
    const typingHeartbeatTimer = setInterval(() => {
      sendWxTypingStatus(env, creds, userId, contextToken, 1).catch(() => {});
    }, 5000);
    if (typingHeartbeatTimer && typeof typingHeartbeatTimer.unref === 'function') {
      typingHeartbeatTimer.unref();
    }

    // 检查当前选中的模型本身是否是图像生成接口（/images/generations）
    const modelProbe = buildAIRequest(env, activeModelId, [{ role: 'user', content: userText }], false);
    const isDirectImageModel = !!(modelProbe && modelProbe.isImageAPI);

    const useAgent = !isDirectImageModel && (await agentGetMode(env, chatId));
    const wantResume = useAgent && !multimodalContent && userText.trim() === '继续';
    let resumeState = null;
    if (wantResume) resumeState = await agentLoadResumeState(env, chatId);
    if (useAgent && !resumeState) await agentClearResumeState(env, chatId);

    const baseHistory = await tgGetHistory(env, chatId);
    let history = baseHistory.slice();
    if (!resumeState) {
      history.push({ role: 'user', content: multimodalContent || userText });
      history = tgTrimHistory(history, env);
    }

    let replyText = null;
    let directImageSource = null;
    let agentErr = null;

    let wxBudgetMs = parseInt(env.WX_WEBHOOK_BUDGET_MS || env.TG_WEBHOOK_BUDGET_MS || '55000', 10);
    if (!(wxBudgetMs >= 10000)) wxBudgetMs = 55000;
    if (wxBudgetMs > 240000) wxBudgetMs = 240000;

    let lastTypingSent = Date.now();
    const wxCompatApi = async (method) => {
      if (method === 'sendChatAction') {
        const now = Date.now();
        if (now - lastTypingSent >= 5000) {
          lastTypingSent = now;
          await sendWxTypingStatus(env, creds, userId, contextToken, 1);
        }
      }
      return { ok: true };
    };

    if (useAgent && !multimodalContent) {
      const onProgress = async () => {
        const now = Date.now();
        if (now - lastTypingSent >= 5500) {
          lastTypingSent = now;
          await sendWxTypingStatus(env, creds, userId, contextToken, 1);
        }
      };
      const agentOpts = {
        maxRuntimeMs: wxBudgetMs,
        resumeKey: tgAgentResumeKey(chatId),
        origUserText: historyUserText,
      };
      const runAgentTurn = (allowTools) => {
        if (resumeState) {
          return tgAgentResume(env, wxCompatApi, chatId, {
            targetModelId: resumeState.targetModelId || activeModelId,
            allowTools,
            messages: resumeState.messages,
            loopStartIdx: resumeState.loopStartIdx,
            origUserText: resumeState.origUserText || '',
          }, onProgress, agentOpts);
        }
        return tgAgentChat(env, wxCompatApi, chatId, activeModelId, history, allowTools, onProgress, agentOpts);
      };

      let r;
      try {
        r = await runAgentTurn(true);
        if (r.fallback) r = await runAgentTurn(false);
      } catch (e) {
        r = { error: '⚠️ Agent 执行出错：' + (e && e.message ? e.message : String(e)) };
      }

      if (r.error) {
        agentErr = r.error;
      } else {
        replyText = r.text;
        if (r.isImage && replyText) {
          const mUrl = /\((https?:\/\/[^\s)]+|data:image\/[^\s)]+|\/api\/img\/[^\s)]+)\)/.exec(replyText);
          if (mUrl) directImageSource = mUrl[1];
        }
        if (!r.paused) {
          if (!r.isImage && replyText) {
            let finalHist = baseHistory.slice();
            const qToSave = resumeState ? (resumeState.origUserText || '') : historyUserText;
            if (qToSave) finalHist.push({ role: 'user', content: qToSave });
            finalHist.push({ role: 'assistant', content: replyText });
            finalHist = tgTrimHistory(finalHist, env);
            await tgSaveHistory(env, chatId, finalHist);
          }
          await agentClearResumeState(env, chatId);
        }
      }
    } else {
      // 普通非 Agent 对话、文生图接口或多模态图片问答（复用多密钥轮换池）
      const aiConfig = buildAIRequest(env, activeModelId, history, false);
      if (aiConfig.error) {
        await sendWxTypingStatus(env, creds, userId, contextToken, 2);
        await sendReply('⚠️ ' + aiConfig.error, true);
        return { processed: true };
      }
      const { payload } = aiConfig;
      let aiResponse = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const r = await fetchWithKeyRotation(aiConfig, (key) => ({
            method: 'POST',
            headers: authHeaders(key),
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(45000),
          }));
          aiResponse = r.resp;
          break;
        } catch (e) {
          aiResponse = null;
          if (attempt >= 2) {
            agentErr = '⚠️ 上游接口请求失败，请稍后再试。';
            break;
          }
          await new Promise(r => setTimeout(r, 1500));
        }
      }
      if (!agentErr) {
        if (aiResponse && aiResponse.ok) {
          const aiData = await aiResponse.json();
          const imgItem = (aiData && Array.isArray(aiData.data) && aiData.data[0])
            || (aiData && Array.isArray(aiData.images) && aiData.images[0])
            || null;
          if (aiData.choices && aiData.choices[0]?.message) {
            replyText = aiData.choices[0].message.content;
          } else if (imgItem && (imgItem.b64_json || imgItem.url)) {
            directImageSource = imgItem.b64_json ? ('data:image/png;base64,' + imgItem.b64_json) : imgItem.url;
            replyText = imgItem.url ? `🎨 生成的图片：\n${imgItem.url}` : '';
          } else {
            replyText = 'AI 没有返回有效内容。';
          }
          if (aiData.choices && aiData.choices[0]?.message && replyText) {
            let finalHist = baseHistory.slice();
            finalHist.push({ role: 'user', content: historyUserText });
            finalHist.push({ role: 'assistant', content: replyText });
            finalHist = tgTrimHistory(finalHist, env);
            await tgSaveHistory(env, chatId, finalHist);
          }
        } else {
          let diag = '';
          if (aiResponse) {
            try {
              diag = `（HTTP ${aiResponse.status}：${await readErrorBody(aiResponse, 300)}）`;
            } catch (e) {}
          }
          agentErr = (multimodalContent ? '⚠️ 当前模型可能不支持图片识别（请发「模型」切换多模态模型）。' : '⚠️ AI 接口请求失败，请稍后再试。') + diag;
        }
      }
    }

    clearInterval(typingHeartbeatTimer);
    sendWxTypingStatus(env, creds, userId, contextToken, 2).catch(() => {});

    if (agentErr) {
      await wxRecordDiag(env, 'error', agentErr, userId, true);
      await sendReply(agentErr, true);
      return { processed: true };
    }

    // 如果有生成的图片（或者回复中包含 Markdown 图片链接），优先加密上传并作为微信原生图片发送
    if (!directImageSource && replyText) {
      const mdImgMatch = /!\[[^\]]*\]\((https?:\/\/[^\s)]+|data:image\/[^\s)]+|\/api\/img\/[^\s)]+)\)/.exec(replyText);
      if (mdImgMatch) directImageSource = mdImgMatch[1];
    }

    if (directImageSource) {
      try {
        await sendWechatImageFromSource(env, creds, userId, contextToken, directImageSource);
        // 如果除了图片外还有实质性文字说明，一并发送文字
        const textWithoutImg = String(replyText || '')
          .replace(/\[🖼️ 点击查看生成的图片\]\([^)]+\)/g, '')
          .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
          .replace(/^🎨 生成的图片：\s*https?:\/\/\S+$/gm, '')
          .trim();
        if (textWithoutImg) {
          await sendReply(textWithoutImg);
        }
        return { processed: true };
      } catch (imgErr) {
        // 降级为发送文本链接
        if (replyText) {
          await sendReply(replyText);
        } else {
          await sendReply('⚠️ 微信图片发送失败：' + (imgErr && imgErr.message ? imgErr.message : String(imgErr)), true);
        }
        return { processed: true };
      }
    }

    if (replyText) {
      await sendReply(replyText);
    }
    return { processed: true };
  } catch (err) {
    try { if (typeof typingHeartbeatTimer !== 'undefined') clearInterval(typingHeartbeatTimer); } catch (e) {}
    await releaseWxMsgForRetry(env, dedupKey);
    sendWxTypingStatus(env, creds, userId, contextToken, 2).catch(() => {});
    await wxRecordDiag(env, 'error', err && err.message ? err.message : String(err), userId, true);
    throw err;
  }
}

// ================= 7. 全天候保活长轮询引擎（24s 双轮 waitUntil + 容器内常驻循环 + 25s notifyStart 在线续期） =================
// 为什么之前的保活机制会断？
// 1) 父请求退出会切断未闭合的子请求流：若子请求 `/wx-webhook?relay=1` 保持响应流不关闭，父请求退出时平台会强制关闭父请求 socket，连带掐死子请求；
//    修复：`/wx-webhook?relay=1` 收到请求后【立即返回完整 200 OK JSON 响应】（5ms 完成干净握手，彻底与父请求解耦），
//    然后在自身的 `waitUntil` 中跑满 24 秒（2 轮 × 11.5 秒长轮询，严格小于 Serverless 30 秒 waitUntil 上限），在第 24 秒准时触发下一棒！
// 2) 容器内常驻循环曾被 `if (!httpRelayDispatched)` 误关：在 EdgeOne Node 等常驻容器环境中，必须【同时开启】公网 HTTP 接力与容器内 `+600ms` 定时器接力（通过分布式锁互斥），
//    一旦公网同域自调用受限或断开，容器内定时器在 600ms 后自动接管继续无限循环保活！
// 3) 任何访问（含 `/healthz`）自动唤醒：将 `maybeWakeWxDaemon` 移至 `/healthz` 之前，只要没持有锁立即拉起保活链，并每 25s 发送 `notifystart` 刷新微信在线状态！
const WX_LOCK_DEFAULT_TTL_MS = 16000;
const WX_MIN_FULL_POLL_MS = 4000;
const WX_DEFAULT_LONGPOLL_MS = 11500;
let lastNotifyStartAt = 0;

async function isPollLockHeld(env) {
  if (activePollInIsolate) return true;
  if (!env || !env.R2) return false;
  try {
    const now = Date.now();
    const raw = await storeGet(env, WX_POLL_LOCK_KEY);
    if (raw) {
      const lock = JSON.parse(raw);
      if (lock && lock.exp > now && lock.exp - now <= 20000) {
        return true;
      }
    }
  } catch (e) {}
  return false;
}

async function acquirePollLock(env, ttlMs, force) {
  if (activePollInIsolate && !force) return false;
  if (!env || !env.R2) {
    activePollInIsolate = true;
    return true;
  }
  try {
    const now = Date.now();
    if (!force) {
      const raw = await storeGet(env, WX_POLL_LOCK_KEY);
      if (raw) {
        const lock = JSON.parse(raw);
        if (lock && lock.exp > now && lock.exp - now <= 20000) {
          return false;
        }
      }
    }
    activePollInIsolate = true;
    const leaseMs = Math.min(Math.max(parseInt(ttlMs, 10) || WX_LOCK_DEFAULT_TTL_MS, 6000), 18000);
    await storePut(env, WX_POLL_LOCK_KEY, JSON.stringify({ exp: now + leaseMs, ts: now }));
  } catch (e) {
    activePollInIsolate = true;
  }
  return true;
}

async function renewPollLock(env, ttlMs) {
  if (!env || !env.R2) return;
  try {
    const now = Date.now();
    const leaseMs = Math.min(Math.max(parseInt(ttlMs, 10) || WX_LOCK_DEFAULT_TTL_MS, 6000), 18000);
    await storePut(env, WX_POLL_LOCK_KEY, JSON.stringify({ exp: now + leaseMs, ts: now }));
  } catch (e) {}
}

async function releasePollLock(env) {
  activePollInIsolate = false;
  if (env && env.R2) {
    try { await storeDelete(env, WX_POLL_LOCK_KEY); } catch (e) {}
  }
}

// 每 25 秒向腾讯 iLink 发送一次 notifystart 在线心跳，确保微信顶部永不弹出“暂时无法连接 OpenClaw”
function maybeSendPeriodicNotifyStart(creds, chanVer, ctx) {
  try {
    const now = Date.now();
    if (now - lastNotifyStartAt < 25000) return;
    lastNotifyStartAt = now;
    const p = ilinkNotifyStart(creds.baseurl, creds.bot_token, chanVer, 5000).catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') {
      try { ctx.waitUntil(p); } catch (e) {}
    }
  } catch (e) {}
}

// 将收到的微信消息交由独立 `/wx-webhook?process=1` 实例（或当前实例）执行 AI 推理与回复
async function dispatchOrProcessMessages(env, creds, pendingMsgs, effOrigin, elapsedMs, ctx) {
  let processedCount = 0;
  if (!pendingMsgs || !pendingMsgs.length) return 0;

  if (elapsedMs >= 4000 && isRealPublicOrigin(effOrigin)) {
    try {
      const relayToken = computeWxRelayToken(creds.bot_token);
      const procUrl = `${effOrigin}/wx-webhook?process=1`;
      const res = await fetch(procUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Wx-Relay-Token': relayToken,
        },
        body: JSON.stringify({ action: 'process', async_process: true, msgs: pendingMsgs }),
        signal: AbortSignal.timeout(4000),
      });
      if (res && res.ok) {
        return pendingMsgs.length;
      }
    } catch (e) {
      // 回退到当前实例直接处理
    }
  }

  for (const m of pendingMsgs) {
    try {
      const r = await processWechatMessage(env, creds, m);
      if (r && r.processed) processedCount += 1;
    } catch (err) {
      console.log('处理微信 ClawBot 消息异常:', err);
    }
  }
  return processedCount;
}

async function runWechatPollCycle(env, opts) {
  opts = opts || {};
  const cycleStartAt = Date.now();
  const creds = await getWxCredentials(env);
  if (!creds || !creds.bot_token) {
    return { ok: false, reason: 'not_configured', message: '尚未绑定微信 ClawBot，请先扫码绑定或配置 WX_BOT_TOKEN' };
  }
  if (creds.expired) {
    return { ok: false, reason: 'session_expired', expired: true, message: creds.errmsg || '微信 ClawBot 会话已过期 (ret=-14)，请重新扫码绑定' };
  }

  const longPollTimeoutMs = Math.min(Math.max(parseInt(opts.longPollTimeoutMs || env.WX_LONGPOLL_TIMEOUT_MS || String(WX_DEFAULT_LONGPOLL_MS), 10) || WX_DEFAULT_LONGPOLL_MS, WX_MIN_FULL_POLL_MS), 18000);
  const maxRuntimeMs = Math.min(Math.max(parseInt(opts.maxRuntimeMs || env.WX_POLL_BUDGET_MS || '24000', 10) || 24000, longPollTimeoutMs + 1000), 85000);
  const maxRounds = Math.min(Math.max(parseInt(opts.maxRounds || '2', 10) || 2, 1), 8);

  if (!(await acquirePollLock(env, longPollTimeoutMs + 3500, !!opts.force))) {
    const diagNow = await getWxDiagSummary(env);
    return {
      ok: true,
      locked: true,
      received: 0,
      processed: 0,
      lastPollAt: diagNow.lastPollAt,
      lastReplyAt: diagNow.lastReplyAt,
      totalProcessed: diagNow.totalProcessed,
      message: '后台长轮询实例正在运行中',
    };
  }

  const chanVer = wxChannelVersion(env);
  maybeSendPeriodicNotifyStart(creds, chanVer, opts.ctx);
  await wxRecordDiag(env, 'poll', '', creds.ilink_user_id, false);

  const deadline = Date.now() + maxRuntimeMs;
  let totalReceived = 0;
  let totalProcessed = 0;
  let cursor = await getWxCursor(env, creds.ilink_bot_id);
  let lockReleased = false;
  let relayTaskPromise = null;
  const effOrigin = isRealPublicOrigin(opts.origin)
    ? opts.origin
    : (isRealPublicOrigin(creds.relay_origin) ? creds.relay_origin : lastKnownPublicOrigin);
  const currentHop = parseInt(opts.relayHop, 10) || 0;

  const startUnlockAndRelay = async (shouldRelay) => {
    if (!lockReleased) {
      lockReleased = true;
      await releasePollLock(env);
    }
    if (shouldRelay && opts.autoRelay && !relayTaskPromise) {
      relayTaskPromise = triggerNextSelfRelay(env, effOrigin, currentHop, opts.ctx).catch(() => {});
      if (opts.ctx && typeof opts.ctx.waitUntil === 'function') {
        try { opts.ctx.waitUntil(relayTaskPromise); } catch (e) {}
      }
    }
  };

  try {
    const pendingMsgs = [];

    for (let round = 0; round < maxRounds; round++) {
      const remainMs = deadline - Date.now();
      if (round > 0 && remainMs < WX_MIN_FULL_POLL_MS) break;

      const pollTimeout = round === 0
        ? Math.min(longPollTimeoutMs, Math.max(WX_MIN_FULL_POLL_MS, remainMs - 300))
        : Math.min(longPollTimeoutMs, Math.max(WX_MIN_FULL_POLL_MS, remainMs - 300));

      if (round > 0) {
        maybeSendPeriodicNotifyStart(creds, chanVer, opts.ctx);
        await renewPollLock(env, pollTimeout + 3500);
      }

      const resp = await ilinkGetUpdates(creds.baseurl, creds.bot_token, cursor, chanVer, pollTimeout);
      if (resp && (resp.ret === -14 || resp.errcode === -14)) {
        await markWxSessionExpired(env, creds, resp.errmsg);
        await startUnlockAndRelay(false);
        return {
          ok: false,
          reason: 'session_expired',
          expired: true,
          received: totalReceived,
          processed: totalProcessed,
          message: '微信 ClawBot 会话已过期 (ret=-14)，请重新扫码绑定',
        };
      }

      if (resp && typeof resp.get_updates_buf === 'string' && resp.get_updates_buf) {
        cursor = resp.get_updates_buf;
        await saveWxCursor(env, creds.ilink_bot_id, cursor);
      }

      const msgs = (resp && Array.isArray(resp.msgs)) ? resp.msgs : [];
      totalReceived += msgs.length;

      if (msgs.length > 0) {
        for (const rawM of msgs) {
          try {
            const p = extractWechatMessageContent(rawM);
            if (p && p.isUserMsg && p.fromUserId && p.contextToken) {
              await saveWxContextToken(env, p.fromUserId, p.contextToken);
            }
          } catch (e) {}
        }
        pendingMsgs.push(...msgs);
        break;
      }

      if (opts.singleShot) break;
    }

    // 持久化最近一次成功轮询时间戳，方便多实例与状态面板实时观测
    wxDiagMem.lastPollAt = Date.now();
    if (env && env.R2 && (currentHop % 2 === 0 || pendingMsgs.length > 0)) {
      wxRecordDiag(env, 'poll_sync', '', creds.ilink_user_id, true).catch(() => {});
    }

    // 立即释放锁并触发下一棒接力（此时距 30s waitUntil 上限还有充裕余量）
    await startUnlockAndRelay(true);

    if (pendingMsgs.length > 0) {
      const elapsedMs = Date.now() - cycleStartAt;
      totalProcessed += await dispatchOrProcessMessages(env, creds, pendingMsgs, effOrigin, elapsedMs, opts.ctx);
    }

    if (relayTaskPromise) {
      await relayTaskPromise;
    }

    return {
      ok: true,
      received: totalReceived,
      processed: totalProcessed,
      botId: creds.ilink_bot_id,
      userId: creds.ilink_user_id,
      lastPollAt: wxDiagMem.lastPollAt,
      lastReplyAt: wxDiagMem.lastReplyAt,
      totalProcessed: wxDiagMem.totalProcessed,
    };
  } catch (e) {
    await new Promise(r => { const t = setTimeout(r, 600); if (t && typeof t.unref === 'function') t.unref(); });
    await startUnlockAndRelay(true);
    if (relayTaskPromise) {
      await relayTaskPromise;
    }
    await wxRecordDiag(env, 'error', e && e.message ? e.message : String(e), creds.ilink_user_id, true);
    return {
      ok: false,
      error: e && e.message ? e.message : String(e),
      received: totalReceived,
      processed: totalProcessed,
    };
  } finally {
    if (!lockReleased) {
      await releasePollLock(env);
    }
  }
}

// 双引擎全自动自接力保活：
// 引擎 A：公网 POST `/wx-webhook?relay=1`（下游收到后 5ms 立即返回完整 200 OK 闭合 HTTP 事务，杜绝父请求退出掐死子请求，并在下游自身 waitUntil 中跑满 24s 双轮长轮询）；
// 引擎 B：容器内 `+600ms` 定时器常驻续跑（无论公网接力是否受同域限制，只要 600ms 后锁未被新实例接管，当前常驻容器立刻无缝续跑下一轮 24s 周期！）。
async function triggerNextSelfRelay(env, origin, hop, ctx) {
  try {
    const creds = await getWxCredentials(env);
    if (!creds || !creds.bot_token || creds.expired) return;
    const effOrigin = isRealPublicOrigin(origin) ? origin : (isRealPublicOrigin(creds.relay_origin) ? creds.relay_origin : lastKnownPublicOrigin);
    const nextHop = ((parseInt(hop, 10) || 0) + 1) % 10000;

    // 引擎 A：公网 HTTP 唤醒下一棒实例（下游立即返回 200 OK JSON，耗时仅 ~50-200ms）
    if (isRealPublicOrigin(effOrigin)) {
      const relayToken = computeWxRelayToken(creds.bot_token);
      const relayUrl = `${effOrigin}/wx-webhook?relay=1&hop=${nextHop}`;
      try {
        await fetch(relayUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Wx-Relay-Token': relayToken,
          },
          body: JSON.stringify({ action: 'poll', relay: true, hop: nextHop }),
          signal: AbortSignal.timeout(3500),
        });
      } catch (e) {}
    }

    // 引擎 B：始终注册容器内 +600ms 兜底定时器（若引擎 A 因同域子请求上限等原因未能拿到锁，当前常驻进程立刻接管继续无限循环！）
    const inProcessChain = new Promise(resolve => {
      const t = setTimeout(resolve, 600);
      if (t && typeof t.unref === 'function') t.unref();
    }).then(async () => {
      if (await isPollLockHeld(env)) return;
      await runWechatPollCycle(env, {
        maxRuntimeMs: 24000,
        longPollTimeoutMs: WX_DEFAULT_LONGPOLL_MS,
        maxRounds: 2,
        singleShot: false,
        autoRelay: true,
        origin: effOrigin,
        relayHop: nextHop,
        ctx,
      });
    }).catch(() => {});

    if (ctx && typeof ctx.waitUntil === 'function') {
      try { ctx.waitUntil(inProcessChain); } catch (e) {}
    }
  } catch (e) {}
}

function kickWxAutoDaemon(env, ctx, origin) {
  const effOrigin = rememberPublicOrigin(origin);
  const task = (async () => {
    if (await isPollLockHeld(env)) return;
    await runWechatPollCycle(env, {
      maxRuntimeMs: 24000,
      longPollTimeoutMs: WX_DEFAULT_LONGPOLL_MS,
      maxRounds: 2,
      singleShot: false,
      autoRelay: true,
      origin: effOrigin,
      relayHop: 1,
      ctx,
    });
  })().catch(() => {});
  if (ctx && typeof ctx.waitUntil === 'function') {
    try { ctx.waitUntil(task); } catch (e) {}
  }
  return task;
}

function maybeWakeWxDaemon(request, env, ctx) {
  try {
    const now = Date.now();
    if (activePollInIsolate) return;
    if (now - lastDaemonWakeCheckAt < 4000) return;
    lastDaemonWakeCheckAt = now;
    const origin = request && request.url ? rememberPublicOrigin(request.url) : lastKnownPublicOrigin;
    const task = (async () => {
      if (await isPollLockHeld(env)) return;
      const creds = await getWxCredentials(env);
      if (!creds || !creds.bot_token || creds.expired) return;
      await kickWxAutoDaemon(env, ctx, origin || creds.relay_origin);
    })().catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') {
      try { ctx.waitUntil(task); } catch (e) {}
    }
  } catch (e) {}
}

// ================= 8. Webhook 接收器与全天候免开网页保活端点（GET/POST /wx-webhook） =================
async function handleWxWebhook(request, env, url, ctx) {
  const reqUrl = url || new URL(request.url);
  const origin = rememberPublicOrigin(reqUrl.origin);
  const credsForRelay = await getWxCredentials(env);
  const relayHeader = (request && request.headers && request.headers.get('X-Wx-Relay-Token')) || '';
  const isValidRelay = !!(credsForRelay && credsForRelay.bot_token && relayHeader && safeEqual(relayHeader, computeWxRelayToken(credsForRelay.bot_token)));
  const auth = isValidRelay ? { authorized: true, noSecretConfigured: false } : checkWxAdminAuth(env, request, reqUrl);

  if (env.WX_WEBHOOK_SECRET) {
    const got = request.headers.get('X-Wechat-Webhook-Secret')
      || request.headers.get('X-Webhook-Secret')
      || (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim()
      || reqUrl.searchParams.get('key')
      || '';
    if (!safeEqual(got, env.WX_WEBHOOK_SECRET) && !auth.authorized) {
      return new Response('Forbidden', { status: 403 });
    }
  } else if (!auth.authorized) {
    return new Response(JSON.stringify({ ok: false, error: auth.reason }), { status: 401, headers: CORS_HEADERS });
  }

  // 外部定时监控（UptimeRobot / Crontab / 云监控）GET /wx-webhook?key=...：直接跑满 52 秒多轮长轮询并在末尾接力
  if (request.method === 'GET') {
    const timeoutMs = parseInt(reqUrl.searchParams.get('timeout_ms') || '52000', 10) || 52000;
    const res = await runWechatPollCycle(env, {
      maxRuntimeMs: Math.min(Math.max(timeoutMs, 15000), 85000),
      longPollTimeoutMs: 12000,
      maxRounds: 5,
      singleShot: false,
      autoRelay: true,
      origin,
      relayHop: 1,
      ctx,
    });
    return new Response(JSON.stringify(res), { status: 200, headers: CORS_HEADERS });
  }

  try {
    const rawText = (await request.text()).trim();
    const payload = rawText ? JSON.parse(rawText) : {};

    if (!payload || payload.action === 'poll' || (!payload.msgs && !payload.from_user_id && !payload.user_id && !payload.msg)) {
      const isRelay = !!(payload && payload.relay) || reqUrl.searchParams.get('relay') === '1';
      const hop = parseInt((payload && payload.hop) || reqUrl.searchParams.get('hop') || '1', 10) || 1;
      if (isRelay) {
        // 关键设计：立即返回完整 200 OK JSON 响应，使上游父请求在 5ms 内干净结束 HTTP 事务（绝不在父请求退出时向本实例发送 TCP RST 断开信号！）；
        // 同时将本实例的轮询严格控制在 24 秒（2 轮 × 11.5s，小于 waitUntil 30 秒硬限制），在第 24 秒准时触发下一棒！
        const relayCycleTask = runWechatPollCycle(env, {
          maxRuntimeMs: 24000,
          longPollTimeoutMs: WX_DEFAULT_LONGPOLL_MS,
          maxRounds: 2,
          singleShot: false,
          autoRelay: true,
          origin,
          relayHop: hop,
          ctx,
        }).catch(() => {});
        if (ctx && typeof ctx.waitUntil === 'function') {
          try { ctx.waitUntil(relayCycleTask); } catch (e) {}
        }
        return new Response(JSON.stringify({ ok: true, relayed: true, hop }), { status: 200, headers: CORS_HEADERS });
      }
      const timeoutMs = parseInt(payload.timeout_ms || reqUrl.searchParams.get('timeout_ms') || '52000', 10) || 52000;
      const res = await runWechatPollCycle(env, {
        maxRuntimeMs: Math.min(Math.max(timeoutMs, 15000), 85000),
        longPollTimeoutMs: 12000,
        maxRounds: 5,
        singleShot: false,
        autoRelay: true,
        origin,
        relayHop: 1,
        ctx,
      });
      return new Response(JSON.stringify(res), { status: 200, headers: CORS_HEADERS });
    }

    const creds = await getWxCredentials(env);
    if (!creds || !creds.bot_token) {
      return new Response(JSON.stringify({ ok: false, error: 'WX_BOT_TOKEN or QR login not configured' }), {
        status: 200,
        headers: CORS_HEADERS,
      });
    }

    if (payload && typeof payload.get_updates_buf === 'string' && payload.get_updates_buf) {
      await saveWxCursor(env, creds.ilink_bot_id, payload.get_updates_buf);
    }

    const msgs = Array.isArray(payload && payload.msgs)
      ? payload.msgs
      : (payload && (payload.from_user_id || payload.user_id || payload.msg) ? [payload.msg || payload] : []);

    // 若是内部转发的异步慢消息处理（async_process: true），立即返回 200 OK 并在当前新实例的 waitUntil 中满血执行 AI 推理
    if (payload && payload.async_process) {
      const procTask = (async () => {
        for (const m of msgs) {
          try { await processWechatMessage(env, creds, m); } catch (e) {}
        }
      })().catch(() => {});
      if (ctx && typeof ctx.waitUntil === 'function') {
        try { ctx.waitUntil(procTask); } catch (e) {}
      }
      return new Response(JSON.stringify({ ok: true, queued: msgs.length }), { status: 200, headers: CORS_HEADERS });
    }

    let processed = 0;
    for (const m of msgs) {
      try {
        const r = await processWechatMessage(env, creds, m);
        if (r && r.processed) processed += 1;
      } catch (e) {
        console.log('Webhook 处理微信消息异常:', e);
      }
    }

    return new Response(JSON.stringify({ ok: true, received: msgs.length, processed }), {
      status: 200,
      headers: CORS_HEADERS,
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) }), {
      status: 400,
      headers: CORS_HEADERS,
    });
  }
}

// ================= 9. Web 管理端接口（/api/wx/*，带强制防盗绑鉴权 + 诊断 + 会话同步） =================
function maskToken(token) {
  const s = String(token || '');
  if (s.length <= 12) return s ? '***' : '';
  return s.slice(0, 6) + '…' + s.slice(-6);
}

async function handleWxApi(request, env, url, ctx) {
  const path = url.pathname;
  const origin = rememberPublicOrigin(url.origin);
  const chanVer = wxChannelVersion(env);
  const defaultBase = normalizeBaseUrl((env && env.WX_BASE_URL) || DEFAULT_ILINK_BASE_URL);
  const auth = checkWxAdminAuth(env, request, url);

  // 1) 查询状态：未通过管理员口令校验时，只返回脱敏的布尔状态与鉴权提示
  if (request.method === 'GET' && path === '/api/wx/status') {
    const creds = await getWxCredentials(env, true);
    const connected = !!(creds && creds.bot_token && !creds.expired);
    if (!auth.authorized) {
      return new Response(JSON.stringify({
        ok: true,
        adminAuthorized: false,
        noSecretConfigured: auth.noSecretConfigured,
        authReason: auth.reason,
        connected,
        expired: !!(creds && creds.expired),
        r2Bound: !!(env && env.R2),
        channelVersion: chanVer,
      }), { status: 200, headers: CORS_HEADERS });
    }
    const lastPeer = await getWxLastPeer(env);
    const cursor = creds ? await getWxCursor(env, creds.ilink_bot_id) : '';
    const effectiveUserId = (creds && creds.ilink_user_id) || (lastPeer && lastPeer.user_id) || '';
    const hasContextToken = effectiveUserId
      ? !!(await getWxContextToken(env, effectiveUserId)) || !!(lastPeer && lastPeer.context_token)
      : false;
    const diag = await getWxDiagSummary(env);
    return new Response(JSON.stringify({
      ok: true,
      adminAuthorized: true,
      noSecretConfigured: false,
      connected,
      expired: !!(creds && creds.expired),
      errmsg: (creds && creds.errmsg) || '',
      source: (creds && creds.source) || null,
      botId: (creds && creds.ilink_bot_id) || '',
      userId: effectiveUserId,
      hasContextToken,
      baseUrl: (creds && creds.baseurl) || defaultBase,
      maskedToken: creds ? maskToken(creds.bot_token) : '',
      hasCursor: !!cursor,
      updatedAt: (creds && creds.updated_at) || '',
      r2Bound: !!(env && env.R2),
      channelVersion: chanVer,
      diag,
    }), { status: 200, headers: CORS_HEADERS });
  }

  // 其余所有操作均要求通过管理员鉴权！
  if (!auth.authorized) {
    return new Response(JSON.stringify({
      ok: false,
      code: auth.noSecretConfigured ? 'NO_SECRET_CONFIGURED' : 'WX_ADMIN_UNAUTHORIZED',
      error: auth.reason,
    }), { status: auth.noSecretConfigured ? 403 : 401, headers: CORS_HEADERS });
  }

  // 2) 获取微信对话历史（用于在网页侧栏一键同步查看手机微信上的对话）
  if (request.method === 'GET' && path === '/api/wx/history') {
    const creds = await getWxCredentials(env);
    const lastPeer = await getWxLastPeer(env);
    const userId = String(url.searchParams.get('user_id') || (creds && creds.ilink_user_id) || (lastPeer && lastPeer.user_id) || '').trim();
    if (!userId) {
      return new Response(JSON.stringify({
        ok: true,
        userId: '',
        messages: [],
        kbDocs: await loadAllKbDocsForSync(env),
        message: '尚未收到过微信端消息，请先在手机微信 ClawBot 中发送一条消息',
      }), { status: 200, headers: CORS_HEADERS });
    }
    const chatId = wxSessionChatId(userId);
    const [messages, modelId, agentMode, kbDocs] = await Promise.all([
      tgGetHistory(env, chatId),
      storeGet(env, `tg_user_${chatId}`),
      agentGetMode(env, chatId),
      loadAllKbDocsForSync(env),
    ]);
    return new Response(JSON.stringify({
      ok: true,
      userId,
      chatId,
      modelId: modelId || '',
      agentMode,
      messages: Array.isArray(messages) ? messages : [],
      kbDocs,
    }), { status: 200, headers: CORS_HEADERS });
  }

  // 3) 获取微信 ClawBot 扫码绑定二维码（带防覆盖锁）
  if (request.method === 'POST' && path === '/api/wx/qrcode') {
    const existing = await getWxCredentials(env, true);
    if (existing && existing.source === 'env') {
      return new Response(JSON.stringify({
        ok: false,
        error: '当前已通过环境变量 WX_BOT_TOKEN 固定绑定，Web 端扫码已锁定，无法覆盖。',
      }), { status: 409, headers: CORS_HEADERS });
    }
    let body = {};
    try { body = await request.json(); } catch (e) { body = {}; }
    if (existing && existing.bot_token && !existing.expired && !body.force) {
      return new Response(JSON.stringify({
        ok: false,
        code: 'ALREADY_BOUND',
        error: '当前已绑定微信账号（' + (existing.ilink_user_id || existing.ilink_bot_id) + '）。为防误覆盖，请先点击「解绑」后再重新扫码。',
      }), { status: 409, headers: CORS_HEADERS });
    }
    try {
      const qrData = await ilinkGetQrCode(defaultBase, chanVer, 12000);
      if (!qrData || !qrData.qrcode) {
        return new Response(JSON.stringify({
          ok: false,
          error: '微信 iLink 未返回有效二维码：' + JSON.stringify(qrData || {}),
        }), { status: 502, headers: CORS_HEADERS });
      }
      wxQrRedirectNodes.set(qrData.qrcode, defaultBase);
      return new Response(JSON.stringify({
        ok: true,
        qrcode: qrData.qrcode,
        qrcode_img_content: qrData.qrcode_img_content || '',
        base_url: defaultBase,
        ret: qrData.ret ?? 0,
      }), { status: 200, headers: CORS_HEADERS });
    } catch (e) {
      return new Response(JSON.stringify({
        ok: false,
        error: e && e.message ? e.message : String(e),
      }), { status: 500, headers: CORS_HEADERS });
    }
  }

  // 4) 轮询扫码状态（完整支持 scaned_but_redirect 跨节点自动跳转与 need_verifycode 配对码）
  if (request.method === 'GET' && path === '/api/wx/qrcode-status') {
    const qrcode = (url.searchParams.get('qrcode') || '').trim();
    const verifyCode = (url.searchParams.get('verify_code') || '').trim();
    const clientBase = (url.searchParams.get('base_url') || '').trim();
    if (!qrcode) {
      return new Response(JSON.stringify({ ok: false, error: '缺少 qrcode 参数' }), { status: 400, headers: CORS_HEADERS });
    }
    let targetBase = normalizeBaseUrl(clientBase || wxQrRedirectNodes.get(qrcode) || defaultBase);
    try {
      let st = await ilinkGetQrStatus(targetBase, qrcode, chanVer, 8000, verifyCode);
      let status = st.status || 'wait';

      // 若遇到跨区 IDC 节点重定向（scaned_but_redirect / binded_redirect），立即切换到新节点并跟进查询一次
      if ((status === 'scaned_but_redirect' || status === 'binded_redirect' || st.redirect_baseurl) && st.redirect_baseurl) {
        targetBase = st.redirect_baseurl;
        wxQrRedirectNodes.set(qrcode, targetBase);
        const followUp = await ilinkGetQrStatus(targetBase, qrcode, chanVer, 5000, verifyCode);
        if (followUp && followUp.status) {
          st = followUp;
          status = followUp.status;
          if (followUp.redirect_baseurl) {
            targetBase = followUp.redirect_baseurl;
            wxQrRedirectNodes.set(qrcode, targetBase);
          }
        }
      }

      if (status === 'confirmed' && st.bot_token) {
        const allowedUsers = parseCommaSeparated(env.WX_ALLOWED_USERS);
        if (allowedUsers.length > 0 && st.ilink_user_id && allowedUsers.indexOf(st.ilink_user_id) === -1) {
          return new Response(JSON.stringify({
            ok: false,
            status: 'rejected',
            error: `扫码微信号 (${st.ilink_user_id}) 不在 WX_ALLOWED_USERS 白名单中，已拒绝绑定。`,
          }), { status: 403, headers: CORS_HEADERS });
        }

        const finalBaseUrl = normalizeBaseUrl(st.redirect_baseurl || st.baseurl || targetBase || defaultBase);
        const newCreds = {
          bot_token: st.bot_token,
          ilink_bot_id: st.ilink_bot_id || (st.bot_token.includes(':') ? st.bot_token.split(':')[0] : 'wx_bot'),
          ilink_user_id: st.ilink_user_id || '',
          baseurl: finalBaseUrl,
          cdn_url: String((env && env.WX_CDN_BASE_URL) || DEFAULT_ILINK_CDN_URL).trim(),
          expired: false,
          errmsg: '',
          updated_at: new Date().toISOString(),
        };
        const savedOk = await saveWxCredentials(env, newCreds);
        await saveWxCursor(env, newCreds.ilink_bot_id, '');
        newCreds.relay_origin = origin;
        await saveWxCredentials(env, newCreds);
        await ilinkNotifyStart(newCreds.baseurl, newCreds.bot_token, chanVer, 6000);
        await wxRecordDiag(env, 'login', `扫码绑定成功 (${newCreds.ilink_user_id || newCreds.ilink_bot_id})，后台自接力守护已启动`, newCreds.ilink_user_id, true);
        wxQrRedirectNodes.delete(qrcode);
        kickWxAutoDaemon(env, ctx, origin);
        return new Response(JSON.stringify({
          ok: true,
          status: 'confirmed',
          persisted: savedOk,
          r2Bound: !!(env && env.R2),
          botId: newCreds.ilink_bot_id,
          userId: newCreds.ilink_user_id,
          baseUrl: newCreds.baseurl,
          maskedToken: maskToken(newCreds.bot_token),
        }), { status: 200, headers: CORS_HEADERS });
      }
      return new Response(JSON.stringify({
        ok: true,
        status,
        base_url: targetBase,
        need_verifycode: status === 'need_verifycode' || !!st.need_verifycode,
        ret: st.ret ?? 0,
      }), { status: 200, headers: CORS_HEADERS });
    } catch (e) {
      return new Response(JSON.stringify({
        ok: false,
        error: e && e.message ? e.message : String(e),
      }), { status: 500, headers: CORS_HEADERS });
    }
  }

  // 5) 手动、前端后台守护或外部定时触发器触发微信消息长轮询
  if ((request.method === 'POST' || request.method === 'GET') && path === '/api/wx/poll') {
    let body = {};
    if (request.method === 'POST') {
      try { body = await request.json(); } catch (e) { body = {}; }
    }
    const reqTimeoutMs = parseInt(body.timeout_ms || url.searchParams.get('timeout_ms') || '12000', 10) || 12000;
    const singleShot = body.single_shot !== undefined
      ? !!body.single_shot
      : (url.searchParams.get('single_shot') !== '0');
    const force = !!(body.force || url.searchParams.get('force') === '1');
    const effectivePollMs = Math.min(Math.max(reqTimeoutMs, WX_MIN_FULL_POLL_MS), 16000);
    const result = await runWechatPollCycle(env, {
      maxRuntimeMs: singleShot ? (effectivePollMs + 3000) : 52000,
      longPollTimeoutMs: effectivePollMs,
      maxRounds: singleShot ? 1 : 4,
      singleShot,
      force,
      autoRelay: true,
      origin,
      relayHop: 1,
      ctx,
    });
    return new Response(JSON.stringify(result), { status: 200, headers: CORS_HEADERS });
  }

  // 6) 主动向微信用户发送消息（支持在网页控制台一键发测试消息）
  if (request.method === 'POST' && path === '/api/wx/send') {
    let body = {};
    try { body = await request.json(); } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: '无效的 JSON 请求体' }), { status: 400, headers: CORS_HEADERS });
    }
    const text = String(body.text || '').trim();
    if (!text) {
      return new Response(JSON.stringify({ ok: false, error: '消息内容 text 不能为空' }), { status: 400, headers: CORS_HEADERS });
    }
    const creds = await getWxCredentials(env);
    if (!creds || !creds.bot_token) {
      return new Response(JSON.stringify({ ok: false, error: '微信 ClawBot 尚未绑定' }), { status: 400, headers: CORS_HEADERS });
    }
    const lastPeer = await getWxLastPeer(env);
    const toUserId = String(body.to_user_id || creds.ilink_user_id || (lastPeer && lastPeer.user_id) || '').trim();
    if (!toUserId) {
      return new Response(JSON.stringify({
        ok: false,
        error: '尚未获取到你的微信对话句柄：请先打开手机微信 -> 我 -> 设置 -> 插件 -> ClawBot，向机器人随便发一句话（如「你好」）以激活对话令牌！',
      }), { status: 400, headers: CORS_HEADERS });
    }
    const contextToken = String(
      body.context_token
      || (await getWxContextToken(env, toUserId))
      || (lastPeer && lastPeer.context_token)
      || ''
    ).trim();
    if (!contextToken) {
      return new Response(JSON.stringify({
        ok: false,
        error: '缺少微信会话 context_token（腾讯 iLink 协议规定必须先由手机微信端发起首条消息以签发路由令牌）。请先在手机微信向 ClawBot 发送任意消息！',
      }), { status: 400, headers: CORS_HEADERS });
    }
    try {
      const cleanText = formatWechatText(text);
      const r = await ilinkSendMessage(creds.baseurl, creds.bot_token, toUserId, cleanText, contextToken, chanVer, 15000);
      if (r && (r.ret === -14 || r.errcode === -14)) {
        await markWxSessionExpired(env, creds, r.errmsg);
        return new Response(JSON.stringify({ ok: false, expired: true, error: '会话已过期 (ret=-14)，请重新扫码绑定' }), {
          status: 401,
          headers: CORS_HEADERS,
        });
      }
      await wxRecordDiag(env, 'reply', `[网页端主动发送] ${cleanText.slice(0, 80)}`, toUserId, true);
      return new Response(JSON.stringify({ ok: true, to_user_id: toUserId, result: r }), { status: 200, headers: CORS_HEADERS });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) }), {
        status: 500,
        headers: CORS_HEADERS,
      });
    }
  }

  // 7) 解绑 / 退出当前微信 ClawBot 登录凭证
  if (request.method === 'POST' && path === '/api/wx/logout') {
    const creds = await getWxCredentials(env);
    if (creds && creds.source === 'env') {
      return new Response(JSON.stringify({
        ok: false,
        error: '当前通过环境变量 WX_BOT_TOKEN 绑定，请在控制台移除该变量以解绑。',
      }), { status: 409, headers: CORS_HEADERS });
    }
    if (creds && creds.bot_token) {
      await ilinkNotifyStop(creds.baseurl, creds.bot_token, chanVer, 5000);
    }
    await clearWxCredentials(env);
    await wxRecordDiag(env, 'login', '管理员主动解绑微信 ClawBot', '', true);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS_HEADERS });
  }

  return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404, headers: CORS_HEADERS });
}

export {
  wxSessionChatId,
  checkWxAdminAuth,
  getWxCredentials,
  saveWxCredentials,
  clearWxCredentials,
  getWxContextToken,
  saveWxContextToken,
  getWxCursor,
  saveWxCursor,
  splitWechatText,
  parseWxCommand,
  processWechatMessage,
  runWechatPollCycle,
  kickWxAutoDaemon,
  maybeWakeWxDaemon,
  autoOrganizeAndSaveKbDoc,
  loadAllKbDocsForSync,
  handleWxWebhook,
  handleWxApi,
};
