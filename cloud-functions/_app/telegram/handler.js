// Telegram Webhook：命令、模型选择、文件/图片多模态处理、Agent 对话与回复发送
// v7.4.0 增强：新增私聊专属微信 ClawBot 安全绑定命令（/wxlogin、/wxstatus、/wxunbind）

import { APP_VERSION } from '../constants.js';
import { mapSetBounded, mapGetBounded, parseCommaSeparated, safeEqual } from '../utils.js';
import { storeGet, storePut, storePutChecked } from '../store/r2.js';
import { getChannelConfig, buildAIRequest, fetchWithKeyRotation, authHeaders } from '../channel.js';
import { tgTrimHistory, tgGetHistory, tgSaveHistory, tgClearHistory } from '../tg-history.js';
import { agentGetMemories, agentForgetMemory } from '../agent/memory.js';
import { agentGetMode, agentSetMode } from '../agent/mode.js';
import { agentLoadResumeState, agentClearResumeState, tgAgentResumeKey } from '../agent/resume.js';
import { tgAgentChat, tgAgentResume } from '../agent/loop.js';
import { readErrorBody } from '../agent/stability.js';
import { toolListDocs } from '../kb/doc-tools.js';
import { tgNote } from './diag.js';
import {
  DEFAULT_ILINK_BASE_URL,
  DEFAULT_ILINK_CDN_URL,
  DEFAULT_ILINK_CHANNEL_VERSION,
  normalizeBaseUrl,
  ilinkGetQrCode,
  ilinkGetQrStatus,
  ilinkNotifyStart,
  ilinkNotifyStop,
} from '../wechat/ilink.js';
import {
  getWxCredentials,
  saveWxCredentials,
  clearWxCredentials,
  saveWxCursor,
  kickWxAutoDaemon,
} from '../wechat/handler.js';

// 全局内存缓存（L1 缓存，带 60s TTL）
const tgUserModels = new Map();
const tgUserModelsExp = new Map();
// update_id 去重缓存（L1 内存）：
const seenUpdateIds = new Map();
let warnedNoWebhookSecret = false;

// ================= update_id 去重（v6.8.9：L1 内存 + L2 R2 滚动窗口） =================
const TG_DEDUP_KEY = 'tg_updates_dedup';
const TG_DEDUP_WINDOW_MS = 10 * 60 * 1000;
const TG_DEDUP_MAX = 200;
async function loadDedupWindow(env) {
  try {
    const raw = await storeGet(env, TG_DEDUP_KEY);
    if (raw) { const p = JSON.parse(raw); if (Array.isArray(p)) return p; }
  } catch (e) {}
  return [];
}
async function markUpdateSeen(env, uid) {
  if (uid === undefined || uid === null) return false;
  const now = Date.now();
  if (seenUpdateIds.has(uid)) return true;
  const win = await loadDedupWindow(env);
  const fresh = win.filter(e => e && e.id !== undefined && e.id !== null && now - (e.ts || 0) < TG_DEDUP_WINDOW_MS);
  if (fresh.some(e => e.id === uid)) {
    seenUpdateIds.set(uid, now);
    return true;
  }
  fresh.push({ id: uid, ts: now });
  if (fresh.length > TG_DEDUP_MAX) fresh.splice(0, fresh.length - TG_DEDUP_MAX);
  try { await storePutChecked(env, TG_DEDUP_KEY, JSON.stringify(fresh)); } catch (e) {}
  seenUpdateIds.set(uid, now);
  for (const [k, t] of seenUpdateIds) { if (now - t > WX_DEDUP_SAFE_MS) seenUpdateIds.delete(k); }
  return false;
}
const WX_DEDUP_SAFE_MS = TG_DEDUP_WINDOW_MS;
async function releaseUpdateForRetry(env, uid) {
  if (uid === undefined || uid === null) return;
  seenUpdateIds.delete(uid);
  try {
    const win = await loadDedupWindow(env);
    const fresh = win.filter(e => !(e && e.id === uid));
    if (fresh.length !== win.length) await storePutChecked(env, TG_DEDUP_KEY, JSON.stringify(fresh));
  } catch (e) {}
}

// 命令解析（v6.8.6）：兼容群组里的 /cmd@botname 写法与命令后带参数。
function parseCommand(t) {
  const m = /^(\/[a-zA-Z]+)(?:@[a-zA-Z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(String(t || '').trim());
  if (!m) return null;
  return { cmd: m[1].toLowerCase(), rest: (m[2] || '').trim() };
}

// 群组 @ 提及与引用回复识别缓存（key: bot token -> lowercase username）
const botUsernameCache = new Map();
const KNOWN_TG_COMMANDS = new Set([
  '/start', '/model', '/clear', '/new', '/help', '/memory', '/kb', '/forget', '/agent',
  '/wxlogin', '/wxstatus', '/wxunbind'
]);

function extractBotIdFromToken(token) {
  const t = String(token || '').trim();
  const colon = t.indexOf(':');
  return colon > 0 ? t.slice(0, colon) : '';
}

function escapeRegExp(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function resolveBotUsername(env, tgApi) {
  const configured = String((env && env.TG_BOT_USERNAME) || '').trim().replace(/^@+/, '').toLowerCase();
  if (configured) return configured;
  const token = String((env && env.TG_BOT_TOKEN) || '').trim();
  if (!token) return '';
  if (botUsernameCache.has(token)) return botUsernameCache.get(token);
  try {
    const res = await tgApi('getMe', {});
    if (res && res.ok) {
      const data = await res.json();
      const uname = String((data && data.result && data.result.username) || '').trim().replace(/^@+/, '').toLowerCase();
      if (uname) {
        botUsernameCache.set(token, uname);
        return uname;
      }
    }
  } catch (e) {}
  return '';
}

// 判断群组消息是否触发机器人（支持 @bot_username 提及、回复机器人消息、以及 /命令）
async function evaluateGroupTrigger(msg, env, tgApi) {
  const chatType = String((msg && msg.chat && msg.chat.type) || '');
  const isGroup = chatType === 'group' || chatType === 'supergroup';
  if (!isGroup || String((env && env.TG_GROUP_REPLY_ALL) || '') === '1') {
    return { isGroup, triggered: true, botUsername: '', cleanText: (s) => String(s || '') };
  }

  const botId = extractBotIdFromToken(env && env.TG_BOT_TOKEN);
  const rawText = typeof msg.text === 'string' ? msg.text : (typeof msg.caption === 'string' ? msg.caption : '');
  const entities = Array.isArray(msg.entities)
    ? msg.entities
    : (Array.isArray(msg.caption_entities) ? msg.caption_entities : []);

  const replyMsg = msg.reply_to_message;
  const isTopicHeader = !!(replyMsg && replyMsg.forum_topic_created && !replyMsg.text && !replyMsg.caption);
  const replyFrom = !isTopicHeader && replyMsg ? replyMsg.from : null;

  let isReplyToBot = !!(botId && replyFrom && String(replyFrom.id) === botId);
  let isTextMentionToBot = !!(botId && entities.some(e => e && e.type === 'text_mention' && e.user && String(e.user.id) === botId));

  const cmdMatch = /^(\/[a-zA-Z]+)(?:@([a-zA-Z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(rawText.trim());
  const isKnownCmd = !!(cmdMatch && KNOWN_TG_COMMANDS.has(cmdMatch[1].toLowerCase()));
  const cmdTarget = cmdMatch && cmdMatch[2] ? cmdMatch[2].toLowerCase() : '';

  let botUsername = '';
  if (rawText.indexOf('@') !== -1 || (replyFrom && replyFrom.is_bot && !isReplyToBot)) {
    botUsername = await resolveBotUsername(env, tgApi);
  }

  if (!isReplyToBot && botUsername && replyFrom && String(replyFrom.username || '').toLowerCase() === botUsername) {
    isReplyToBot = true;
  }

  let isCommandForBot = false;
  if (isKnownCmd) {
    if (!cmdTarget) isCommandForBot = true;
    else if (botUsername && cmdTarget === botUsername) isCommandForBot = true;
    else if (!botUsername) isCommandForBot = true;
  }

  let isUsernameMentioned = false;
  if (botUsername && rawText) {
    const mentionRe = new RegExp('(?:^|[^a-zA-Z0-9_])@' + escapeRegExp(botUsername) + '(?![a-zA-Z0-9_])', 'i');
    if (mentionRe.test(rawText)) isUsernameMentioned = true;
  }

  const triggered = isReplyToBot || isTextMentionToBot || isCommandForBot || isUsernameMentioned;
  const cleanText = (s) => {
    const str = String(s || '');
    if (!botUsername || isCommandForBot) return str;
    const stripRe = new RegExp('@' + escapeRegExp(botUsername) + '(?![a-zA-Z0-9_])\\s*', 'ig');
    return str.replace(stripRe, '').trim();
  };

  return { isGroup, triggered, botUsername, cleanText };
}

// v6.9.5：长消息按 3980 字符切分，自动闭合跨分片的 ``` 代码块
function splitTelegramMarkdown(text, maxLength = 3980) {
  const chunks = [];
  let remaining = String(text || '');
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    let sliceLength = maxLength;
    const lastNewline = remaining.lastIndexOf('\n', maxLength);
    if (lastNewline > 3000) {
      sliceLength = lastNewline;
    }
    let chunk = remaining.slice(0, sliceLength);
    remaining = remaining.slice(sliceLength);
    const fences = chunk.match(/```[^\n]*/g);
    if (fences && fences.length % 2 === 1) {
      const lastFence = fences[fences.length - 1];
      const lang = lastFence.slice(3).trim();
      chunk += '\n```';
      remaining = '```' + (lang ? lang : '') + '\n' + remaining.replace(/^\n/, '');
    }
    chunks.push(chunk);
  }
  return chunks;
}

// ================= v7.0.0：Telegram 文件直传与图片多模态辅助 =================
const SUPPORTED_DOC_EXT_RE = /\.(md|markdown|txt|csv|tsv|json|jsonl|log|py|js|mjs|ts|tsx|jsx|html|htm|css|xml|yaml|yml|toml|ini|conf|sh|bash|sql|go|rs|java|c|cpp|h)$/i;

async function tgFetchFileBytes(env, fileId, maxBytes, timeoutMs) {
  const metaRes = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`, {
    signal: AbortSignal.timeout(timeoutMs || 15000)
  });
  if (!metaRes.ok) throw new Error('获取文件信息失败 (HTTP ' + metaRes.status + ')');
  const meta = await metaRes.json();
  const filePath = meta && meta.result && meta.result.file_path;
  if (!filePath) throw new Error('Telegram 未返回有效文件路径');
  if (meta.result.file_size && maxBytes && meta.result.file_size > maxBytes) {
    throw new Error('文件体积超过上限（最大支持 ' + Math.round(maxBytes / 1024) + ' KB）');
  }
  const fileRes = await fetch(`https://api.telegram.org/file/bot${env.TG_BOT_TOKEN}/${filePath}`, {
    signal: AbortSignal.timeout(timeoutMs || 15000)
  });
  if (!fileRes.ok) throw new Error('下载文件失败 (HTTP ' + fileRes.status + ')');
  const buf = await fileRes.arrayBuffer();
  if (maxBytes && buf.byteLength > maxBytes) {
    throw new Error('文件体积超过上限（最大支持 ' + Math.round(maxBytes / 1024) + ' KB）');
  }
  return new Uint8Array(buf);
}

function uint8ToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function handleTgWebhook(request, env) {
  tgNote('hit', { reason: 'webhook_hit' });
  if (env.TG_WEBHOOK_SECRET) {
    const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
    if (!safeEqual(got, env.TG_WEBHOOK_SECRET)) {
      tgNote('forbidden', {
        reason: 'secret_mismatch',
        detail: '收到 secret 长度 ' + got.length + '（空=' + (got === '') + '），期望长度 ' + String(env.TG_WEBHOOK_SECRET).length,
      });
      return new Response('Forbidden', { status: 403 });
    }
  } else if (env.TG_BOT_TOKEN && !warnedNoWebhookSecret) {
    warnedNoWebhookSecret = true;
    console.log('⚠️ [edgeone-chat] 未配置 TG_WEBHOOK_SECRET，/tg-webhook 处于开放状态；强烈建议配置 secret_token 并用 setWebhook 重新绑定，同时可配 TG_ALLOWED_CHAT_IDS 白名单只允许自己的聊天。');
  }

  try {
    const update = await request.json();
    if (!env.TG_BOT_TOKEN) {
      tgNote('skip', { reason: 'no_bot_token', detail: '函数读不到 TG_BOT_TOKEN，无法调用 Telegram API' });
      return new Response('OK', { status: 200 });
    }

    let tgApiTimeoutMs = parseInt(env.TG_API_TIMEOUT_MS || '15000', 10);
    if (!(tgApiTimeoutMs > 0)) tgApiTimeoutMs = 15000;
    const tgApi = (method, body) => fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(tgApiTimeoutMs)
    });

    async function processTelegramUpdate(env, update, tgApi) {
      let pendingCleanup = null;
      try {
        const { models: modelObjList } = getChannelConfig(env);
        if (modelObjList.length === 0) {
          tgNote('skip', { reason: 'no_models', updateId: update.update_id, detail: 'getChannelConfig 解析出 0 个模型' });
          return;
        }

        const allowedChatIds = parseCommaSeparated(env.TG_ALLOWED_CHAT_IDS);
        const isChatAllowed = (cid) => !allowedChatIds.length || allowedChatIds.indexOf(String(cid)) !== -1;

        if (update.callback_query) {
          const cb = update.callback_query;
          const chatId = cb.message && cb.message.chat ? cb.message.chat.id : undefined;
          if (chatId === undefined || !isChatAllowed(chatId)) {
            tgNote('skip', {
              reason: 'callback_chat_not_allowed',
              updateId: update.update_id,
              chatId: chatId === undefined ? null : chatId,
              detail: '按钮回调来自未授权会话，白名单是 [' + allowedChatIds.join(',') + ']',
            });
            try { await tgApi('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {}); } catch (e) {}
            return;
          }
          const data = cb.data;

          if (data.startsWith('M:')) {
            const index = parseInt(data.substring(2), 10);
            if (modelObjList[index]) {
              const selected = modelObjList[index];
              mapSetBounded(tgUserModels, chatId, selected.id, undefined, tgUserModelsExp);
              await storePut(env, `tg_user_${chatId}`, selected.id);

              const safeModelName = String(selected.name || selected.id).replace(/`/g, "'");
              await tgApi('sendMessage', {
                chat_id: chatId,
                text: `✅ **已切换模型为:** \n\`${safeModelName}\``,
                parse_mode: "Markdown"
              }).catch(() => {});
            }
          }

          await tgApi('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
          return;
        }

        const msg = update.message;
        if (!msg || !msg.chat) {
          const kinds = Object.keys(update).filter(k => k !== 'update_id');
          tgNote('skip', {
            reason: 'not_a_message',
            updateId: update.update_id,
            detail: '更新里没有 message 字段，实际携带的是：' + (kinds.join(',') || '(空)'),
          });
          return;
        }
        const chatId = msg.chat.id;
        if (!isChatAllowed(chatId)) {
          tgNote('skip', {
            reason: 'chat_not_allowed',
            updateId: update.update_id,
            chatId: chatId,
            chatType: msg.chat.type,
            detail: '白名单是 [' + allowedChatIds.join(',') + ']，本会话是 ' + chatId,
          });
          return;
        }

        const groupCheck = await evaluateGroupTrigger(msg, env, tgApi);
        if (groupCheck.isGroup && !groupCheck.triggered) {
          tgNote('skip', {
            reason: 'group_not_mentioned',
            updateId: update.update_id,
            chatId: chatId,
            chatType: msg.chat.type,
            detail: '群聊消息未 @ 机器人且未回复机器人，已忽略（如需群内全量接话可设 TG_GROUP_REPLY_ALL=1）',
          });
          return;
        }
        const replyMsgParams = (groupCheck.isGroup && msg.message_id)
          ? { reply_to_message_id: msg.message_id, allow_sending_without_reply: true }
          : {};

        let userText = typeof msg.text === 'string' ? groupCheck.cleanText(msg.text) : '';
        if (groupCheck.isGroup && typeof msg.text === 'string' && msg.text.trim() && !userText) {
          userText = '你好';
        }
        let multimodalContent = null;
        let historyUserText = userText;

        if (!userText && msg.document) {
          const doc = msg.document;
          const fileName = String(doc.file_name || 'document.txt');
          const mime = String(doc.mime_type || '');
          const isTextDoc = mime.startsWith('text/') || /json|xml|javascript|csv|yaml/i.test(mime) || SUPPORTED_DOC_EXT_RE.test(fileName);
          if (!isTextDoc) {
            await tgApi('sendMessage', {
              chat_id: chatId,
              text: '⚠️ 暂仅支持文本类文档（如 .md / .txt / .csv / .json / 代码文件），当前文件类型：' + (mime || fileName)
            });
            return;
          }
          try {
            const bytes = await tgFetchFileBytes(env, doc.file_id, 512 * 1024, tgApiTimeoutMs);
            let docText = new TextDecoder('utf-8').decode(bytes);
            if (docText.length > 60000) {
              docText = docText.slice(0, 60000) + '\n\n…（文件较长，已截取前 60000 字符）';
            }
            const caption = groupCheck.cleanText(msg.caption || '') || '请阅读并总结这份文档的核心内容；如果我要求保存到知识库，请调用 save_doc 工具。';
            userText = `【上传文件：《${fileName}》】\n用户说明：${caption}\n\n文件内容如下：\n\`\`\`\n${docText}\n\`\`\``;
            historyUserText = `【上传文件：《${fileName}》】${caption}`;
          } catch (e) {
            await tgApi('sendMessage', { chat_id: chatId, text: '⚠️ 读取上传文件失败：' + (e && e.message ? e.message : String(e)) });
            return;
          }
        } else if (!userText && Array.isArray(msg.photo) && msg.photo.length > 0) {
          try {
            const candidates = msg.photo.filter(p => !p.file_size || p.file_size <= 1024 * 1024);
            const picked = candidates.length ? candidates[candidates.length - 1] : msg.photo[msg.photo.length - 1];
            const bytes = await tgFetchFileBytes(env, picked.file_id, 2 * 1024 * 1024, tgApiTimeoutMs);
            const dataUrl = 'data:image/jpeg;base64,' + uint8ToBase64(bytes);
            const caption = groupCheck.cleanText(msg.caption || '') || '请详细查看并分析这张图片的内容。';
            userText = caption;
            historyUserText = '[图片] ' + caption;
            multimodalContent = [
              { type: 'text', text: caption },
              { type: 'image_url', image_url: { url: dataUrl } }
            ];
          } catch (e) {
            await tgApi('sendMessage', { chat_id: chatId, text: '⚠️ 读取图片失败：' + (e && e.message ? e.message : String(e)) });
            return;
          }
        }

        if (userText) {
          const cmd = !multimodalContent ? parseCommand(userText) : null;
          if (cmd) {
            tgNote('ok', { reason: 'command', updateId: update.update_id, chatId: chatId, cmd: cmd.cmd });
          }

          // ===== 新增：Telegram 私聊安全管理微信 ClawBot（/wxstatus, /wxlogin, /wxunbind） =====
          if (cmd && (cmd.cmd === '/wxstatus' || cmd.cmd === '/wxlogin' || cmd.cmd === '/wxunbind')) {
            if (groupCheck.isGroup) {
              await tgApi('sendMessage', Object.assign({
                chat_id: chatId,
                text: '🔒 为保护你的微信账号隐私，请在与我的【私聊】窗口中使用微信 ClawBot 绑定命令。'
              }, replyMsgParams));
              return;
            }
            const chanVer = String((env && env.WX_CHANNEL_VERSION) || DEFAULT_ILINK_CHANNEL_VERSION).trim();
            const defaultBase = normalizeBaseUrl((env && env.WX_BASE_URL) || DEFAULT_ILINK_BASE_URL);

            if (cmd.cmd === '/wxstatus') {
              const creds = await getWxCredentials(env, true);
              if (creds && creds.bot_token && !creds.expired) {
                await tgApi('sendMessage', {
                  chat_id: chatId,
                  text: `🟢 微信 ClawBot 状态：已连接（已加锁保护）\n`
                    + `• 机器人 ID：${creds.ilink_bot_id || '-'}\n`
                    + `• 唯一绑定微信用户：${creds.ilink_user_id || '-'}\n`
                    + `• 来源：${creds.source === 'env' ? '环境变量 WX_BOT_TOKEN' : 'Blob/KV 扫码持久化'}\n`
                    + `• 如需解绑重绑，请发 /wxunbind`
                });
              } else if (creds && creds.expired) {
                await tgApi('sendMessage', { chat_id: chatId, text: '⚠️ 微信 ClawBot 会话已过期 (ret=-14)，请发送 /wxlogin 重新扫码绑定。' });
              } else {
                await tgApi('sendMessage', { chat_id: chatId, text: '⚪ 微信 ClawBot 尚未绑定。发送 /wxlogin 即可在私聊中获取专属绑定二维码。' });
              }
              return;
            }

            if (cmd.cmd === '/wxunbind') {
              const creds = await getWxCredentials(env, true);
              if (creds && creds.source === 'env') {
                await tgApi('sendMessage', { chat_id: chatId, text: '⚠️ 当前通过环境变量 WX_BOT_TOKEN 固定绑定，请在控制台移除该变量。' });
                return;
              }
              if (creds && creds.bot_token) {
                await ilinkNotifyStop(creds.baseurl, creds.bot_token, chanVer, 5000);
              }
              await clearWxCredentials(env);
              await tgApi('sendMessage', { chat_id: chatId, text: '✅ 已解绑并清除微信 ClawBot 登录凭证。如需重新绑定请发 /wxlogin。' });
              return;
            }

            if (cmd.cmd === '/wxlogin') {
              const existing = await getWxCredentials(env, true);
              if (existing && existing.bot_token && !existing.expired) {
                await tgApi('sendMessage', {
                  chat_id: chatId,
                  text: `🔒 当前已绑定微信账号（${existing.ilink_user_id || existing.ilink_bot_id}）。为防误覆盖，请先发送 /wxunbind 解绑后再执行 /wxlogin。`
                });
                return;
              }
              try {
                const qrData = await ilinkGetQrCode(defaultBase, chanVer, 12000);
                if (!qrData || !qrData.qrcode) {
                  await tgApi('sendMessage', { chat_id: chatId, text: '⚠️ 获取微信二维码失败，请稍后重试。' });
                  return;
                }
                const qrUrl = qrData.qrcode_img_content || '';
                const statusMsgRes = await tgApi('sendMessage', {
                  chat_id: chatId,
                  text: `📱 请在 45 秒内打开下方官方链接并用手机微信扫码确认连接：\n${qrUrl}\n\n⏳ 正在等待你扫码确认…`
                });
                let statusMsgId = null;
                if (statusMsgRes && statusMsgRes.ok) {
                  try { const d = await statusMsgRes.json(); statusMsgId = d && d.result && d.result.message_id; } catch (e) {}
                }
                const deadline = Date.now() + 50000;
                let pollBase = defaultBase;
                while (Date.now() < deadline) {
                  await new Promise(r => setTimeout(r, 2000));
                  const st = await ilinkGetQrStatus(pollBase, qrData.qrcode, chanVer, 6000);
                  if (st && st.redirect_baseurl) {
                    pollBase = st.redirect_baseurl;
                  }
                  if (st && st.status === 'confirmed' && st.bot_token) {
                    const newCreds = {
                      bot_token: st.bot_token,
                      ilink_bot_id: st.ilink_bot_id || 'wx_bot',
                      ilink_user_id: st.ilink_user_id || '',
                      baseurl: normalizeBaseUrl(st.redirect_baseurl || st.baseurl || pollBase || defaultBase),
                      cdn_url: String((env && env.WX_CDN_BASE_URL) || DEFAULT_ILINK_CDN_URL).trim(),
                      expired: false,
                      errmsg: '',
                      updated_at: new Date().toISOString(),
                    };
                    await saveWxCredentials(env, newCreds);
                    newCreds.relay_origin = new URL(request.url).origin;
                    await saveWxCredentials(env, newCreds);
                    await saveWxCursor(env, newCreds.ilink_bot_id, '');
                    await ilinkNotifyStart(newCreds.baseurl, newCreds.bot_token, chanVer, 6000);
                    kickWxAutoDaemon(env, null, newCreds.relay_origin);
                    const okText = `🎉 微信 ClawBot 绑定成功并已自动加锁！\n• 机器人 ID：${newCreds.ilink_bot_id}\n• 唯一授权微信用户：${newCreds.ilink_user_id}\n现在可以直接在手机微信 ClawBot 中与我对话了。`;
                    if (statusMsgId) {
                      await tgApi('editMessageText', { chat_id: chatId, message_id: statusMsgId, text: okText }).catch(() => {});
                    } else {
                      await tgApi('sendMessage', { chat_id: chatId, text: okText });
                    }
                    return;
                  } else if (st && st.status === 'expired') {
                    break;
                  }
                }
                const timeoutText = '⌛ 扫码等待窗口已结束。如尚未完成确认，请重新发送 /wxlogin 获取新二维码。';
                if (statusMsgId) {
                  await tgApi('editMessageText', { chat_id: chatId, message_id: statusMsgId, text: timeoutText }).catch(() => {});
                } else {
                  await tgApi('sendMessage', { chat_id: chatId, text: timeoutText });
                }
              } catch (e) {
                await tgApi('sendMessage', { chat_id: chatId, text: '⚠️ 微信扫码绑定异常：' + (e && e.message ? e.message : String(e)) });
              }
              return;
            }
          }

          if (cmd && (cmd.cmd === '/start' || cmd.cmd === '/model')) {
            const inline_keyboard = modelObjList.map((model, index) => {
              return [{ text: model.name, callback_data: `M:${index}` }];
            });

            await tgApi('sendMessage', {
              chat_id: chatId,
              text: "⚙️ **请选择对话要使用的 AI 模型:**\n\n_支持多轮对话（最近 " + (parseInt(env.TG_HISTORY_ROUNDS || '10', 10) || 10) + " 轮），支持直接发送图片识图或上传 .md/.txt/.csv 文档，发送 /clear 可清空上下文。_\n\n🤖 **Agent 模式**（默认开启）：我会自主规划、调用 19 项工具（🔍 搜索、📄 网页、🌐 维基百科、💱 实时汇率/币价、🧮 科学计算、🌤 天气、🕐 时间/日期推算），并用 🧠🗑️ 管理长期记忆、用 💾📚📖 存取知识库文档。发送 /agent 可切换为普通对话模式，/help 查看全部命令。",
              parse_mode: "Markdown",
              reply_markup: { inline_keyboard }
            });
            return;
          }

          if (cmd && (cmd.cmd === '/clear' || cmd.cmd === '/new')) {
            await tgClearHistory(env, chatId);
            await agentClearResumeState(env, chatId);
            await tgApi('sendMessage', { chat_id: chatId, text: "🧹 上下文已清空，可以开始新的话题了。" });
            return;
          }

          if (cmd && cmd.cmd === '/help') {
            await tgApi('sendMessage', {
              chat_id: chatId,
              text: "🤖 命令列表：\n\n"
                + "/start、/model —— 选择对话模型\n"
                + "/agent —— 切换 Agent / 普通对话模式\n"
                + "/clear —— 清空当前对话上下文\n"
                + "/memory —— 查看长期记忆\n"
                + "/forget 关键词 —— 删除包含关键词的记忆\n"
                + "/kb —— 知识库总览（文档列表 + 记忆统计）\n"
                + "/wxlogin、/wxstatus、/wxunbind ——（私聊专属）安全扫码绑定/查看/解绑微信 ClawBot\n"
                + "任务太长被暂停时，发送「继续」可接着做\n\n"
                + "✨ 支持直接发送图片（多模态识图）或上传文本文件（.md/.txt/.csv/.json 等，可直接总结或说“存进知识库”）。\n"
                + "🛠️ Agent 工具箱（19 项零密钥工具）：🔍 联网搜索、📄 结构化网页阅读（L1 分页缓存）、🌐 维基百科、🐙 GitHub 仓库检索、🎓 arXiv 论文检索、🔥 科技/开源实时热榜、💱 实时汇率/加密币价、🧮 科学/统计计算器、📏 单位与进制换算、🔤 文本/哈希/编码工具、🖧 IP/DNS 网络查询、🌤 3日天气预报、🕐 时间与日期推算、🧠🗑️ 长期记忆存取、💾📚📖 知识库分页精读与全文检索。"
                + "\n\n📌 当前版本 v" + APP_VERSION + "（R2 持久化 · 全套零配置增强）"
            });
            return;
          }

          if (cmd && cmd.cmd === '/memory') {
            const mems = await agentGetMemories(env, chatId);
            if (!mems.length) {
              await tgApi('sendMessage', { chat_id: chatId, text: "🧠 暂无长期记忆。\n\n对我说「记住xxx」即可保存，比如：记住，我养了一只猫叫汤圆" });
            } else {
              let text = '🧠 长期记忆（共' + mems.length + '条）：\n';
              mems.forEach((mm, i) => { text += (i + 1) + '. ' + mm.fact + '\n'; });
              text += '\n用 /forget 关键词 删除记忆，或直接对我说「忘掉关于xxx的记忆」。';
              for (let s = 0; s < text.length; s += 4000) {
                await tgApi('sendMessage', { chat_id: chatId, text: text.slice(s, s + 4000) });
              }
            }
            return;
          }

          if (cmd && cmd.cmd === '/kb') {
            const mems = await agentGetMemories(env, chatId);
            let text = '📚 知识库总览\n\n';
            text += '🧠 长期记忆：共' + mems.length + '条（/memory 查看，/forget 关键词 删除）\n\n';
            text += await toolListDocs(env);
            text += '\n\n💾 保存文档：对我说"把…存成知识库文档"或直接上传 .md/.txt 文件；🗑️ 删文档：说"删除知识库文档《标题》"';
            for (let s = 0; s < text.length; s += 4000) {
              await tgApi('sendMessage', { chat_id: chatId, text: text.slice(s, s + 4000) });
            }
            return;
          }

          if (cmd && cmd.cmd === '/forget') {
            const kw = cmd.rest;
            if (!kw) {
              await tgApi('sendMessage', { chat_id: chatId, text: "用法：/forget 关键词\n例如：/forget 猫 —— 删除所有包含「猫」的记忆" });
            } else {
              const rr = await agentForgetMemory(env, chatId, kw);
              await tgApi('sendMessage', {
                chat_id: chatId,
                text: rr.persistError ? '⚠️ ' + rr.persistError : (rr.removed > 0 ? '🗑 已删除 ' + rr.removed + ' 条包含「' + kw + '」的记忆。' : '没有找到包含「' + kw + '」的记忆。')
              });
            }
            return;
          }

          if (cmd && cmd.cmd === '/agent') {
            const cur = await agentGetMode(env, chatId);
            await agentSetMode(env, chatId, !cur);
            await tgApi('sendMessage', {
              chat_id: chatId,
              text: !cur
                ? "🤖 **Agent 模式已开启**\n\n我会自主规划、调用工具（🔍 联网搜索、📄 网页读取、🌐 维基百科、💱 汇率/币价、🧮 科学计算、🌤 天气、🕐 时间与日期推算），长期记住或清理你告诉我的重要信息，还能用 💾 保存、📚 查阅知识库文档。"
                : "💬 **已切换为普通对话模式**\n\n单轮问答，不调用工具、不使用长期记忆。如需 Agent 能力再发送 /agent 切回。",
              parse_mode: "Markdown"
            });
            return;
          }

          const cachedModelId = mapGetBounded(tgUserModels, chatId, env && env.R2 ? tgUserModelsExp : null);
          const [loadedModelId, useAgent, baseHistory] = await Promise.all([
            cachedModelId ? Promise.resolve(cachedModelId) : storeGet(env, `tg_user_${chatId}`),
            agentGetMode(env, chatId),
            tgGetHistory(env, chatId),
          ]);
          const targetModelId = loadedModelId || '';
          if (!cachedModelId && targetModelId) {
            mapSetBounded(tgUserModels, chatId, targetModelId, undefined, tgUserModelsExp);
          }

          const wantResume = useAgent && !multimodalContent && userText.trim() === '继续';
          let resumeState = null;
          if (wantResume) resumeState = await agentLoadResumeState(env, chatId);
          if (useAgent && !resumeState) await agentClearResumeState(env, chatId);
          let history = baseHistory.slice();
          if (!resumeState) {
            history.push({ role: "user", content: multimodalContent || userText });
            history = tgTrimHistory(history, env);
          }

          const sendActionPromise = tgApi('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
          const pendingMsgPromise = tgApi('sendMessage', Object.assign({
            chat_id: chatId,
            text: "⏳ _正在思考并生成内容，请稍候..._",
            parse_mode: "Markdown"
          }, replyMsgParams)).then(async res => {
            if (res.ok) {
              const data = await res.json();
              return data.result?.message_id;
            }
            return null;
          }).catch(() => null);

          const [, pendingMsgId] = await Promise.all([sendActionPromise, pendingMsgPromise]);
          pendingCleanup = async (err) => {
            if (pendingMsgId) tgApi('deleteMessage', { chat_id: chatId, message_id: pendingMsgId }).catch(() => {});
            tgApi('sendMessage', { chat_id: chatId, text: '⚠️ 处理消息时出错：' + (err && err.message ? err.message : String(err)) }).catch(() => {});
          };

          let replyText = null;
          let agentErr = null;

          let webhookBudgetMs = parseInt(env.TG_WEBHOOK_BUDGET_MS || '55000', 10);
          if (!(webhookBudgetMs >= 10000)) webhookBudgetMs = 55000;
          if (webhookBudgetMs > 240000) webhookBudgetMs = 240000;
          const agentOpts = { maxRuntimeMs: webhookBudgetMs, resumeKey: tgAgentResumeKey(chatId), origUserText: historyUserText };

          if (useAgent && !multimodalContent) {
            let lastProgressEdit = 0;
            const onProgress = async (text, force) => {
              if (!pendingMsgId) return;
              const now = Date.now();
              if (!force && now - lastProgressEdit < 1500) return;
              lastProgressEdit = now;
              try {
                await tgApi('editMessageText', { chat_id: chatId, message_id: pendingMsgId, text: String(text).slice(0, 4000) });
              } catch (e) {}
            };
            const runAgentTurn = (allowTools) => {
              if (resumeState) {
                return tgAgentResume(env, tgApi, chatId, {
                  targetModelId: resumeState.targetModelId || targetModelId,
                  allowTools: allowTools,
                  messages: resumeState.messages,
                  loopStartIdx: resumeState.loopStartIdx,
                  origUserText: resumeState.origUserText || ''
                }, onProgress, agentOpts);
              }
              return tgAgentChat(env, tgApi, chatId, targetModelId, history, allowTools, onProgress, agentOpts);
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
              if (!r.paused) {
                if (!r.isImage && replyText) {
                  let finalHist = baseHistory.slice();
                  const qToSave = resumeState ? (resumeState.origUserText || '') : historyUserText;
                  if (qToSave) finalHist.push({ role: "user", content: qToSave });
                  finalHist.push({ role: "assistant", content: replyText });
                  finalHist = tgTrimHistory(finalHist, env);
                  await tgSaveHistory(env, chatId, finalHist);
                }
                await agentClearResumeState(env, chatId);
              }
            }
          } else {
            const aiConfig = buildAIRequest(env, targetModelId, history, false);
            if (aiConfig.error) {
              if (pendingMsgId) {
                tgApi('deleteMessage', { chat_id: chatId, message_id: pendingMsgId }).catch(() => {});
              }
              await tgApi('sendMessage', { chat_id: chatId, text: '⚠️ ' + aiConfig.error });
              return;
            }
            const { payload } = aiConfig;
            let aiResponse = null;
            for (let tgAttempt = 1; tgAttempt <= 2; tgAttempt++) {
              try {
                const r = await fetchWithKeyRotation(aiConfig, (key) => ({
                  method: 'POST',
                  headers: authHeaders(key),
                  body: JSON.stringify(payload),
                  signal: AbortSignal.timeout(60000)
                }));
                aiResponse = r.resp;
                break;
              } catch (e) {
                aiResponse = null;
                if (tgAttempt >= 2) { agentErr = '上游接口请求失败，请稍后再试。'; break; }
                await new Promise(function (r) { setTimeout(r, 1500); });
              }
            }
            if (!agentErr) {
              if (aiResponse && aiResponse.ok) {
                const aiData = await aiResponse.json();
                if (aiData.choices && aiData.choices[0]?.message) {
                  replyText = aiData.choices[0].message.content;
                } else if (aiData.data && aiData.data[0]?.url) {
                  replyText = `[🖼️ 点击查看生成的图片](${aiData.data[0].url})`;
                } else {
                  replyText = "AI 没有返回有效内容。";
                }
                if (aiData.choices && aiData.choices[0]?.message && replyText) {
                  let finalHist = baseHistory.slice();
                  finalHist.push({ role: "user", content: historyUserText });
                  finalHist.push({ role: "assistant", content: replyText });
                  finalHist = tgTrimHistory(finalHist, env);
                  await tgSaveHistory(env, chatId, finalHist);
                }
              } else {
                let diag = '';
                if (aiResponse) {
                  try {
                    diag = '（HTTP ' + aiResponse.status + (aiResponse.statusText ? ' ' + aiResponse.statusText : '')
                      + '：' + await readErrorBody(aiResponse, 300) + '）';
                  } catch (e) {}
                }
                agentErr = (multimodalContent ? "⚠️ 当前模型可能不支持图片识别（请用 /model 切换到支持视觉的多模态模型，如 GPT-4o / Qwen-VL）。" : "⚠️ AI 接口请求失败，请稍后再试。") + diag;
              }
            }
          }

          if (pendingMsgId) {
            await tgApi('deleteMessage', { chat_id: chatId, message_id: pendingMsgId }).catch(() => {});
          }

          if (agentErr) {
            tgNote('ok', { reason: 'replied_error', updateId: update.update_id, chatId: chatId, detail: String(agentErr).slice(0, 200) });
            await tgApi('sendMessage', { chat_id: chatId, text: agentErr });
            return;
          }

          if (replyText) {
            const sendReplyChunk = async (text, useMarkdown) => {
              for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                  const r = await tgApi('sendMessage', Object.assign(
                    useMarkdown ? { chat_id: chatId, text, parse_mode: "Markdown" } : { chat_id: chatId, text },
                    replyMsgParams
                  ));
                  if (r.ok || attempt === 2) return r;
                } catch (e) {
                  if (attempt === 2) return { ok: false };
                }
                await new Promise(function (rr) { setTimeout(rr, 800); });
              }
              return { ok: false };
            };
            const chunks = splitTelegramMarkdown(replyText, 3980);
            let delivered = 0;
            for (const chunk of chunks) {
              const tgRes = await sendReplyChunk(chunk, true);
              if (!tgRes.ok) {
                await sendReplyChunk(chunk, false);
              } else {
                delivered++;
              }
            }
            tgNote('ok', {
              reason: 'replied',
              updateId: update.update_id,
              chatId: chatId,
              detail: '回复 ' + replyText.length + ' 字符，分 ' + chunks.length + ' 条，成功投递 ' + delivered + ' 条',
            });
          }
        }
      } catch (err) {
        console.log("后台处理异常:", err);
        if (pendingCleanup) { try { await pendingCleanup(err); } catch (e) {} }
        throw err;
      }
    }

    const uid = update && update.update_id;
    if (uid !== undefined && uid !== null && await markUpdateSeen(env, uid)) {
      tgNote('dedup', { reason: 'duplicate_update', updateId: uid, detail: '该 update_id 已处理过，直接丢弃' });
      return new Response('OK', { status: 200 });
    }

    try {
      await processTelegramUpdate(env, update, tgApi);
    } catch (err) {
      await releaseUpdateForRetry(env, uid);
      tgNote('error', { reason: 'process_error', updateId: uid, detail: String((err && err.message) || err) });
      console.log("处理 Telegram 更新异常:", err);
    }

    return new Response('OK', { status: 200 });
  } catch (error) {
    tgNote('error', { reason: 'bad_json_or_fatal', detail: String((error && error.message) || error) });
    return new Response('Error', { status: 500 });
  }
}

export {
  parseCommand,
  splitTelegramMarkdown,
  markUpdateSeen,
  releaseUpdateForRetry,
};
