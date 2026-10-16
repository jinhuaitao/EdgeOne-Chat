// Telegram 一键诊断 / 绑定 webhook（GET|POST /tg-setup）
//
// 为什么需要这个端点：
//   Telegram 的 setWebhook 只要「请求本身被接受」就返回 ok:true ——
//   它不校验你的 URL 真的可达，也不校验 secret_token 与后端一致。
//   于是最常见的翻车姿势是：setWebhook 报成功，机器人却永远不说话。
//   真正的失败信息藏在 getWebhookInfo().last_error_message 里，
//   而这个接口把它连同「注册的 URL 是否等于本函数以为的 URL」一起翻出来。
//
// 安全：
//   1) 必须带 key（TG_SETUP_KEY，未配置时回退用 TG_WEBHOOK_SECRET）。
//      两者都没配 → 端点直接关闭，避免任何人都能改你的 webhook。
//   2) 响应里永远不回显 bot token 原文，只回 bot_id（本就是公开信息）与密钥长度。
//   3) 用 safeEqual 做定长比较，避免口令长度侧信道。

import { APP_VERSION } from '../constants.js';
import { safeEqual, parseCommaSeparated } from '../utils.js';
import { getChannelConfig } from '../channel.js';
import { activeBackendName } from '../store/edge-store.js';
import { tgSnapshot, tgTopHint } from './diag.js';

const SETUP_HEADERS = {
  'Content-Type': 'application/json;charset=UTF-8',
  'Cache-Control': 'no-store',
};

const TG_API_TIMEOUT_MS = 15000;

function jsonOut(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status: status || 200,
    headers: SETUP_HEADERS,
  });
}

// Telegram bot token 形如 <bot_id>:<35 位密钥>。
// bot_id 本身就是公开信息（出现在 t.me/<bot> 链接与 API 路径里），保留它便于核对
// 「我配的是不是这个 bot」；密钥部分只报长度，绝不回显。
function describeToken(token) {
  const t = String(token || '');
  if (!t) return { present: false };
  const colon = t.indexOf(':');
  const secretLength = colon > 0 ? t.length - colon - 1 : 0;
  return {
    present: true,
    botId: colon > 0 ? t.slice(0, colon) : null,
    secretLength: secretLength,
    // 正常 token 的密钥段是 35 位左右；明显偏短多半是复制时被截断
    formatOk: colon > 0 && secretLength >= 30,
    hasWhitespace: /\s/.test(t),
  };
}

async function tgApi(token, method, payload) {
  const init = { signal: AbortSignal.timeout(TG_API_TIMEOUT_MS) };
  if (payload !== undefined) {
    init.method = 'POST';
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(payload);
  }
  try {
    const res = await fetch('https://api.telegram.org/bot' + token + '/' + method, init);
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) {}
    return {
      httpStatus: res.status,
      ok: !!(data && data.ok),
      data: data,
      rawText: data ? undefined : text.slice(0, 400),
    };
  } catch (e) {
    // 出网被拦 / DNS 失败 / 超时都会落到这里 —— 这本身就是一条重要线索
    return { httpStatus: 0, ok: false, transportError: String((e && e.message) || e) };
  }
}

function summarize(r) {
  if (!r) return null;
  const out = { httpStatus: r.httpStatus, ok: r.ok };
  if (r.transportError) out.transportError = r.transportError;
  if (r.rawText) out.rawText = r.rawText;
  if (r.data) {
    if (r.data.description) out.description = r.data.description;
    if (!r.data.ok && r.data.error_code) out.errorCode = r.data.error_code;
    if (r.data.result !== undefined) out.result = r.data.result;
  }
  return out;
}

function tail(s, n) {
  const str = String(s === undefined || s === null ? '' : s);
  return str.length > n ? '…' + str.slice(-n) : str;
}

export async function handleTgSetup(request, env, url) {
  const e = env || {};
  const key = e.TG_SETUP_KEY || e.TG_WEBHOOK_SECRET || '';
  if (!key) {
    return jsonOut({
      ok: false,
      error: '未配置 TG_SETUP_KEY（也未配置 TG_WEBHOOK_SECRET），/tg-setup 出于安全考虑已关闭。'
        + '请先设置 TG_SETUP_KEY 再使用本端点。',
    }, 403);
  }

  const got = url.searchParams.get('key')
    || request.headers.get('X-Setup-Key')
    || '';
  if (!safeEqual(got, key)) {
    return jsonOut({ ok: false, error: 'key 不正确。用法：/tg-setup?key=<TG_SETUP_KEY>' }, 403);
  }

  const action = String(url.searchParams.get('action') || 'status').toLowerCase();
  const drop = url.searchParams.get('drop') === '1';

  // 公开地址推导：优先用显式配置（自定义域名 / 反代场景 origin 可能不是对外域名），
  // 否则用本次请求的 origin。两者不一致时会在下方给出提示。
  const derivedBase = String(url.origin || '').replace(/\/+$/, '');
  const base = String(e.TG_PUBLIC_BASE_URL || derivedBase).replace(/\/+$/, '');
  const hookUrl = base + '/tg-webhook';

  const token = e.TG_BOT_TOKEN || '';
  const tokenInfo = describeToken(token);
  const allowedIds = parseCommaSeparated(e.TG_ALLOWED_CHAT_IDS);
  const { models } = getChannelConfig(e);

  const out = {
    ok: true,
    endpoint: '/tg-setup',
    action: action,
    version: APP_VERSION,
    runtime: 'edgeone-cloud-functions',
    storage: activeBackendName() || 'memory',
    base: base,
    origin: derivedBase,
    usingCustomBase: !!e.TG_PUBLIC_BASE_URL,
    webhookUrl: hookUrl,
    bot: tokenInfo,
  };

  if (!token) {
    out.ok = false;
    out.healthy = false;
    out.error = '函数读不到 TG_BOT_TOKEN。请确认它配置在 Cloud Functions 的环境变量里，并且已重新部署。';
    out.local = localConfig(e, allowedIds, models, tokenInfo);
    out.diag = tgSnapshot();
    out.topHint = tgTopHint();
    return jsonOut(out, 200);
  }

  // ---------- 动作：绑定 / 解绑 / 发测试消息 ----------
  if (action === 'set') {
    const payload = {
      url: hookUrl,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: drop,
    };
    if (e.TG_WEBHOOK_SECRET) payload.secret_token = e.TG_WEBHOOK_SECRET;
    out.setWebhook = summarize(await tgApi(token, 'setWebhook', payload));
    out.setWebhook.sentSecretToken = !!payload.secret_token;
    out.setWebhook.sentSecretLength = payload.secret_token ? String(payload.secret_token).length : 0;
    out.setWebhook.dropPendingUpdates = drop;
  } else if (action === 'delete') {
    out.deleteWebhook = summarize(await tgApi(token, 'deleteWebhook', { drop_pending_updates: drop }));
  } else if (action === 'test') {
    if (!allowedIds.length) {
      out.test = { ok: false, error: 'TG_ALLOWED_CHAT_IDS 为空，无法确定要发给谁。先填上你的 chat id 再试。' };
    } else {
      out.test = summarize(await tgApi(token, 'sendMessage', {
        chat_id: allowedIds[0],
        text: '✅ edgeone-chat 连通性自检（v' + APP_VERSION + '）。收到这条说明 bot token 与出网都正常。',
      }));
      out.test.chatId = allowedIds[0];
    }
  } else if (action !== 'status' && action !== 'diag') {
    out.ok = false;
    out.error = '未知 action：' + action + '。可用值：status（默认）/ set / delete / test / diag。';
    return jsonOut(out, 400);
  }

  // ---------- 始终附带：getMe + getWebhookInfo ----------
  const me = await tgApi(token, 'getMe');
  out.getMe = summarize(me);

  const info = await tgApi(token, 'getWebhookInfo');
  const infoRes = (info.data && info.data.result) || null;
  const registered = (infoRes && infoRes.url) || '';

  out.webhookInfo = summarize(info);
  out.webhook = {
    registeredUrl: registered,
    expectedUrl: hookUrl,
    urlMatches: registered === hookUrl,
    pendingUpdateCount: infoRes ? infoRes.pending_update_count : null,
    allowedUpdates: infoRes ? infoRes.allowed_updates : null,
    lastErrorDate: infoRes ? infoRes.last_error_date : null,
    lastErrorMessage: infoRes ? infoRes.last_error_message : null,
    // 同步失败与投递失败是两码事：前者说明 Telegram 连你的地址都连不上
    lastSynchronizationErrorDate: infoRes ? infoRes.last_synchronization_error_date : null,
    ipAddress: infoRes ? infoRes.ip_address : null,
  };

  // ---------- 本地侧配置 ----------
  out.local = localConfig(e, allowedIds, models, tokenInfo);

  // ---------- 进程内观测 ----------
  const snap = tgSnapshot();
  out.diag = snap;
  out.topHint = tgTopHint(snap);

  out.hints = buildHints(e, out, allowedIds, models);

  const fatal = out.hints.some(h => h.level === 'fatal');
  out.healthy = !fatal
    && !!out.webhook.urlMatches
    && !out.webhook.lastErrorMessage
    && !out.webhook.lastSynchronizationErrorDate;

  return jsonOut(out, 200);
}

function localConfig(e, allowedIds, models, tokenInfo) {
  return {
    envVisible: {
      TG_BOT_TOKEN: tokenInfo.present,
      TG_BOT_TOKEN_botId: tokenInfo.botId || null,
      TG_WEBHOOK_SECRET: !!e.TG_WEBHOOK_SECRET,
      TG_WEBHOOK_SECRET_length: e.TG_WEBHOOK_SECRET ? String(e.TG_WEBHOOK_SECRET).length : 0,
      TG_ALLOWED_CHAT_IDS: allowedIds,
      TG_SETUP_KEY: !!e.TG_SETUP_KEY,
      TG_PUBLIC_BASE_URL: e.TG_PUBLIC_BASE_URL || null,
      TG_HISTORY_ROUNDS: e.TG_HISTORY_ROUNDS || null,
      TG_WEBHOOK_BUDGET_MS: e.TG_WEBHOOK_BUDGET_MS || null,
    },
    models: models.map(m => m.id),
    modelCount: models.length,
  };
}

function buildHints(e, out, allowedIds, models) {
  const hints = [];
  const push = (level, code, message) => hints.push({ level: level, code: code, message: message });

  const tokenInfo = out.bot || {};
  if (!tokenInfo.formatOk) {
    push('fatal', 'token_format',
      'TG_BOT_TOKEN 格式不像有效 token（应为 <bot_id>:<约35位密钥>）。'
      + (tokenInfo.botId ? '当前 bot_id = ' + tokenInfo.botId + '，密钥段长度 ' + tokenInfo.secretLength + '。' : '当前值里没有冒号。')
      + ' 请从 @BotFather 重新复制，注意别把换行或空格带进来。');
  } else if (tokenInfo.hasWhitespace) {
    push('warn', 'token_whitespace', 'TG_BOT_TOKEN 里含有空白字符，多半是复制时带进来的换行/空格，请清理后重新部署。');
  }

  const me = out.getMe || {};
  if (me.transportError) {
    push('fatal', 'tg_unreachable',
      '调用 Telegram API 失败：' + me.transportError
      + '。说明函数出网到 api.telegram.org 不通（被墙或被平台网络策略拦截）。'
      + '这种情况下 webhook 永远收不到消息，需要改用反代地址或换部署区域。');
  } else if (me.ok === false) {
    push('fatal', 'token_rejected',
      'getMe 被 Telegram 拒绝（HTTP ' + me.httpStatus + '：' + (me.description || '无描述') + '）。'
      + 'token 无效或已被撤销，请到 @BotFather 用 /mybots 重新签发。');
  }

  const wi = out.webhook || {};
  if (wi.registeredUrl === '' || wi.registeredUrl === undefined) {
    push('fatal', 'no_webhook',
      '当前没有注册任何 webhook（getWebhookInfo.url 为空）。'
      + '用 /tg-setup?key=<key>&action=set 一键绑定，或手动执行 setWebhook。');
  } else if (!wi.urlMatches) {
    push('fatal', 'url_mismatch',
      '已注册的地址和本函数以为的地址不一致：注册的是「' + wi.registeredUrl + '」，'
      + '本函数认为是「' + wi.expectedUrl + '」。'
      + '若你用的是自定义域名/反代，请设置 TG_PUBLIC_BASE_URL 后重跑 action=set；'
      + '否则 Telegram 的请求根本没打到这里。');
  }
  if (wi.lastErrorMessage) {
    push('fatal', 'last_error',
      'Telegram 最近一次投递失败：' + wi.lastErrorMessage
      + (wi.lastErrorDate ? '（' + new Date(wi.lastErrorDate * 1000).toISOString() + '）' : '')
      + '。常见含义：403 Forbidden = 你设了 secret_token 但后端校验不通过（或没设却校验了）；'
      + 'Wrong response from the webhook = 后端返回了非 2xx，请直接 curl 一下 /tg-webhook 看状态码。');
  }
  if (wi.lastSynchronizationErrorDate) {
    push('fatal', 'sync_error', 'Telegram 连不上你的 webhook 地址（同步失败）。请确认域名已生效、路径是 /tg-webhook、且没有被访问控制挡住。');
  }
  if (typeof wi.pendingUpdateCount === 'number' && wi.pendingUpdateCount > 0) {
    push('warn', 'pending_updates',
      '有 ' + wi.pendingUpdateCount + ' 条更新堆积未投递。'
      + (wi.lastErrorMessage ? '根因见上一条。' : '通常意味着请求打到了函数但没有返回 2xx。')
      + ' 修好后可用 &drop=1 丢弃积压，避免机器人突然把旧消息一次性补发。');
  }

  if (models.length === 0) {
    push('fatal', 'no_models',
      '【最容易被忽略的静默失败】没有解析到任何模型。'
      + 'Telegram 分支在拿到更新后的第一步就 return 了，机器人表现为完全没反应，'
      + '而 Telegram 侧看不到任何错误（HTTP 200）。'
      + '请在同一个环境里配置 API_URL_1 / API_KEY_1 / MODEL_1，或 API_URL / API_KEY / MODEL。');
  }

  if (!e.TG_WEBHOOK_SECRET) {
    push('warn', 'no_secret',
      '未配置 TG_WEBHOOK_SECRET，/tg-webhook 处于开放状态：任何人都能伪造更新来消耗你的模型额度。'
      + '建议生成一个（openssl rand -hex 24）后用 action=set 重新绑定，secret_token 会自动带上。');
  } else if (wi.registeredUrl) {
    push('info', 'secret_reminder',
      '注意：Telegram 不会回显已注册的 secret_token，所以无法从 getWebhookInfo 反查。'
      + '如果你改过 TG_WEBHOOK_SECRET，必须重跑一次 action=set，否则会出现 403 静默失败。');
  }

  if (!allowedIds.length) {
    push('warn', 'no_allowlist',
      '未配置 TG_ALLOWED_CHAT_IDS：任何人都能私聊你的 bot 并消耗额度。建议填上你自己的 chat id。');
  }

  const snap = out.diag || {};
  const counters = snap.counters || {};
  if (counters.received === 0 && wi.registeredUrl) {
    push('info', 'no_hits',
      '这个函数实例至今没收到过任何 /tg-webhook 请求。'
      + '如果你刚才确实发过消息，说明请求没打到这里 —— 优先怀疑 webhook URL 不对或域名未生效。'
      + '（注意：多实例部署时本计数只反映当前实例，仅供参考。）');
  }
  if (counters.forbidden > 0) {
    push('fatal', 'forbidden_seen',
      '本实例已经拦下 ' + counters.forbidden + ' 次 secret 校验失败的请求：'
      + 'Telegram 发来的 X-Telegram-Bot-Api-Secret-Token 与后端的 TG_WEBHOOK_SECRET 不一致。'
      + '最省事的修法是重跑一次 action=set 让两边对齐。');
  }
  if (counters.failed > 0) {
    push('warn', 'failed_seen', '本实例有 ' + counters.failed + ' 次处理更新时抛错，详情见 diag.lastError。');
  }
  if (counters.skipped > 0 && !counters.replied) {
    push('warn', 'skipped_only', '本实例收到的更新全部被早退分支拦下，没有一次成功回复。请重点看 diag.events 里的 reason。');
  }

  return hints;
}
