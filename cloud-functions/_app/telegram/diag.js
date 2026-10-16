// Telegram 链路自诊断：把「静默失败」变成「看得见的失败」。
//
// 背景：/tg-webhook 为了不让 Telegram 无限重试，绝大多数分支都返回 200 OK。
// 代价是——配置错了（chat id 不在白名单 / 没解析出模型 / token 没读到）时，
// 机器人完全静默：Telegram 侧看不到任何错误（HTTP 200），控制台也没有异常。
// 用户唯一的感受就是「发了消息，没反应」，无从下手。
//
// 本模块在 isolate 内存里保留最近一圈事件与计数，由 /tg-setup 一次性摊开。
//
// 观测边界（务必知情）：这是 L1（进程内）观测。Cloud Functions 会扩缩容、
// 会实例复用，所以快照只反映「处理 /tg-setup 这个请求的那个实例」看到的事件。
// 排障时这通常恰好就是我们想看的那一个——因为被静默丢掉的那条消息，
// 极可能落在同一个实例上。要跨实例看全量请用控制台日志。

const MAX_EVENTS = 30;
const MAX_DETAIL = 300;

function emptyCounters() {
  return {
    received: 0,   // 收到 POST /tg-webhook 的次数
    replied: 0,    // 成功发出回复（或命令响应）的次数
    skipped: 0,    // 被早退分支拦下的次数
    failed: 0,     // 处理过程中抛错的次数
    forbidden: 0,  // secret 不匹配被 403 的次数
    deduped: 0,    // 被 update_id 去重吞掉的次数
  };
}

let counters = emptyCounters();
let events = [];
let lastError = null;
let startedAt = Date.now();

function clip(v, n) {
  const s = v === undefined || v === null ? '' : String(v);
  const max = n > 0 ? n : MAX_DETAIL;
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// kind: hit | ok | skip | error | forbidden | dedup
// reason 是机器可读的短标识（如 chat_not_allowed），detail 是给人看的一句话。
function tgNote(kind, data) {
  const d = data || {};
  const ev = {
    at: new Date().toISOString(),
    kind: kind,
    reason: d.reason || kind,
    updateId: d.updateId === undefined || d.updateId === null ? null : d.updateId,
    chatId: d.chatId === undefined || d.chatId === null ? null : d.chatId,
  };
  if (d.chatType) ev.chatType = d.chatType;
  if (d.cmd) ev.cmd = d.cmd;
  if (d.detail) ev.detail = clip(d.detail);

  if (kind === 'hit') counters.received++;
  else if (kind === 'ok') counters.replied++;
  else if (kind === 'skip') counters.skipped++;
  else if (kind === 'error') counters.failed++;
  else if (kind === 'forbidden') counters.forbidden++;
  else if (kind === 'dedup') counters.deduped++;

  if (kind === 'error' || kind === 'forbidden') {
    lastError = { at: ev.at, reason: ev.reason, detail: ev.detail };
  }

  events.push(ev);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  return ev;
}

function tgSnapshot() {
  return {
    startedAt: new Date(startedAt).toISOString(),
    now: new Date().toISOString(),
    counters: Object.assign({}, counters),
    lastError: lastError ? Object.assign({}, lastError) : null,
    // 倒序：最近发生的排在最前面，方便一眼看到「刚才那条为什么没反应」
    events: events.slice().reverse(),
  };
}

// 仅供自检使用：清空进程内观测状态，避免用例之间互相污染
function tgReset() {
  counters = emptyCounters();
  events = [];
  lastError = null;
  startedAt = Date.now();
}

// 从事件流里挑出「最可能让用户一头雾水」的那一条，转成一句可执行的中文提示。
// 目前覆盖两类最高频的静默失败：
//   1) chat_not_allowed —— 直接把真实 chat_id 报出来，复制进白名单即可；
//   2) no_models        —— 模型没配，TG 分支在拿到更新后第一行就 return。
function tgTopHint(snapshot) {
  const snap = snapshot || tgSnapshot();
  const evs = snap.events || [];
  const blocked = evs.find(e => e.reason === 'chat_not_allowed' && e.chatId !== null);
  if (blocked) {
    return {
      code: 'chat_not_allowed',
      chatId: blocked.chatId,
      message: '最近有一条消息被白名单拦下：chat_id = ' + blocked.chatId
        + '。如果你要用的就是这个会话，把它加进 TG_ALLOWED_CHAT_IDS（多个用英文逗号分隔）后重新部署即可。',
    };
  }
  const noModels = evs.find(e => e.reason === 'no_models');
  if (noModels) {
    return {
      code: 'no_models',
      message: 'Webhook 收到了更新，但没有解析到任何模型，代码在第一步就返回了。'
        + '请在同一个环境里配置 API_URL_1 / API_KEY_1 / MODEL_1（或 API_URL / API_KEY / MODEL）。',
    };
  }
  const noToken = evs.find(e => e.reason === 'no_bot_token');
  if (noToken) {
    return {
      code: 'no_bot_token',
      message: '函数读不到 TG_BOT_TOKEN。请确认它配置在 Cloud Functions 的环境变量里（而不是只写在本地 .env），并且已重新部署。',
    };
  }
  const badJson = evs.find(e => e.reason === 'bad_json_or_fatal');
  if (badJson) {
    return { code: 'bad_json_or_fatal', message: '解析请求体失败：' + (badJson.detail || '') };
  }
  const procErr = evs.find(e => e.reason === 'process_error');
  if (procErr) {
    return { code: 'process_error', message: '处理更新时抛错：' + (procErr.detail || '') };
  }
  return null;
}

export {
  tgNote,
  tgSnapshot,
  tgReset,
  tgTopHint,
  MAX_EVENTS,
};
