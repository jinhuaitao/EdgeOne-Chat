// 统一解析多通道配置（带内存缓存）并构建上游 AI 请求（_worker.js 原第 19-20,1706-1821 行）

import { parseCommaSeparated } from './utils.js';

// 优化：不再校验 env 的引用，因为函数实例生命周期内环境变量是恒定的。
// EdgeOne 移植说明：Cloud Functions 存在实例复用场景，若在控制台改了环境变量，
// 复用的旧实例可能仍持有旧配置。因此缓存增加「配置签名」校验，签名变化即重新解析。
let cachedConfig = null;
let cachedSig = '';

function channelConfigSig(env) {
  const parts = [];
  parts.push(env.API_CONFIG || '');
  for (let i = 1; i <= 20; i++) {
    const u = env['API_URL_' + i];
    if (!u) continue;
    parts.push(i + ':' + u + '|' + (env['MODEL_' + i] || '') + '|' + (env['API_KEY_' + i] || ''));
  }
  parts.push('F:' + (env.API_URL || '') + '|' + (env.MODEL || '') + '|' + (env.API_KEY || ''));
  return parts.join('\u0001');
}

function setConfigCache(env, cfg) {
  cachedConfig = cfg;
  cachedSig = channelConfigSig(env);
  return cachedConfig;
}

// ======= 统一解析通道配置（带内存缓存 + 签名校验） =======
function getChannelConfig(env) {
  const sig = channelConfigSig(env);
  if (cachedConfig && cachedSig === sig) {
    return cachedConfig;
  }

  const models = [];
  const modelMap = new Map();

  const addModels = (modelStr, url, keys) => {
    if (!modelStr) return;
    const arr = modelStr.split(',');
    for (let i = 0; i < arr.length; i++) {
      const raw = arr[i].trim();
      if (!raw) continue;
      
      // 用第一个冒号切分：模型 ID 本身不含冒号，显示名里允许出现冒号
      const colonIdx = raw.indexOf(':');
      const id = colonIdx > 0 ? raw.substring(0, colonIdx).trim() : raw;
      const name = colonIdx > 0 ? raw.substring(colonIdx + 1).trim() : raw;

      if (!modelMap.has(id)) {
        models.push({ id, name, original: raw });
        modelMap.set(id, { url, keys: keys.slice() });
      } else {
        // 同一个模型 ID 在多个通道里重复出现时：接口地址一致就把密钥池合并去重。
        // 原实现直接丢弃，导致「同一个模型写两遍」并不能扩容密钥池 ——
        // 用户以为配了两遍 key，实际只有第一遍生效，是很难自查的静默行为。
        const prev = modelMap.get(id);
        if (prev && prev.url === url) {
          for (let k = 0; k < keys.length; k++) {
            if (keys[k] && prev.keys.indexOf(keys[k]) === -1) prev.keys.push(keys[k]);
          }
        }
      }
    }
  };

  // 密钥列表归一化：兼容 JSON 数组与逗号字符串两种写法，统一去空格、丢空项
  const toKeyList = (v) => (Array.isArray(v) ? v : parseCommaSeparated(v))
    .map(k => String(k == null ? '' : k).trim())
    .filter(Boolean);

  if (env.API_CONFIG) {
    try {
      const channels = JSON.parse(env.API_CONFIG);
      channels.forEach(ch => {
        const url = ch.url;
        const keys = toKeyList(ch.keys);
        const modelStr = Array.isArray(ch.models) ? ch.models.join(',') : ch.models;
        if (url && modelStr) addModels(modelStr, url, keys);
      });
      if (models.length > 0) {
        return setConfigCache(env, { models, modelMap });
      }
    } catch (e) {
      console.log("API_CONFIG 解析失败:", e);
    }
  }

  let hasIndexed = false;
  for (let i = 1; i <= 20; i++) {
    const url = env[`API_URL_${i}`];
    const modelStr = env[`MODEL_${i}`];
    if (url && modelStr) {
      hasIndexed = true;
      const keys = toKeyList(env[`API_KEY_${i}`]);
      addModels(modelStr, url, keys);
    }
  }
  if (hasIndexed && models.length > 0) {
    return setConfigCache(env, { models, modelMap });
  }

  // 兜底：只使用环境变量中显式配置的模型，不再内置任何默认模型
  const fallbackUrl = env.API_URL || "";
  const fallbackKeys = toKeyList(env.API_KEY);
  const fallbackModelStr = env.MODEL || "";

  if (fallbackUrl && fallbackModelStr) {
    addModels(fallbackModelStr, fallbackUrl, fallbackKeys);
  }

  cachedConfig = { models, modelMap };
  cachedSig = sig;
  return cachedConfig;
}

// ======= 密钥池：健康状态 + 失败轮换（多 key 支持） =======
// 背景：API_KEY_i 允许用英文逗号填多个 key，但原实现只是「每次请求随机取一个」。
// 取到失效的 key（过期 / 欠费 / 被限流）时，这一次请求就把错误原样抛给用户，
// 不会换一个 key 再试 —— 于是「配了 3 个 key 但其中一个坏了」表现为随机报错。
// 这里补上三件事：
//   1) 健康优先选取：处于冷却期的 key 不再被优先选中；
//   2) 失败换 key 重试：只在 401/402/403/429 这类「换 key 有意义」的状态上重试；
//   3) 短期熔断：连续失败的 key 指数退避冷却，避免每次都白撞一遍。
// 注意：网络层异常（超时 / DNS / TLS）不换 key 重试 —— 换 key 治不了网络问题，
// 只会把一次超时变成两次，对 Agent 的时间预算尤其有害。

const KEY_HEALTH = new Map(); // key -> { failStreak, cooldownUntil, lastStatus }
const KEY_HEALTH_MAX = 256;   // 防御性上限：环境变量反复改动时不至于无限增长

const KEY_MAX_ATTEMPTS = 3;                  // 单次请求最多尝试几个 key
const KEY_COOLDOWN_BASE_MS = 30 * 1000;      // 首次失败冷却 30 秒
const KEY_COOLDOWN_MAX_MS = 10 * 60 * 1000;  // 连续失败最多冷却 10 分钟

// 只有这些状态码才值得换一个 key 重试：
// 401 密钥无效 / 402 欠费 / 403 无权限或被封 / 429 限流（换 key 可绕过单 key 配额）
// 400（参数错误）、404（地址错误）、5xx（上游故障）换 key 都没用，直接交回调用方。
const KEY_RETRYABLE_STATUS = [401, 402, 403, 429];

function isKeyRetryableStatus(status) {
  return KEY_RETRYABLE_STATUS.indexOf(Number(status)) !== -1;
}

function keyHealthOf(key) {
  let h = KEY_HEALTH.get(key);
  if (!h) {
    if (KEY_HEALTH.size >= KEY_HEALTH_MAX) {
      // 先清掉已经恢复的，再退化为清空重来（key 数量本就有限，这里只是兜底）
      const now = Date.now();
      for (const [k, v] of KEY_HEALTH) {
        if (v.cooldownUntil <= now) KEY_HEALTH.delete(k);
      }
      if (KEY_HEALTH.size >= KEY_HEALTH_MAX) KEY_HEALTH.clear();
    }
    h = { failStreak: 0, cooldownUntil: 0, lastStatus: 0 };
    KEY_HEALTH.set(key, h);
  }
  return h;
}

// 选取本次请求要用的 key：优先健康（不在冷却期）的，冷却中的按「最早解冻」排序兜底
function pickApiKey(keys, exclude) {
  const pool = keys.filter(k => !exclude || exclude.indexOf(k) === -1);
  if (pool.length === 0) return null;
  const now = Date.now();
  const healthy = pool.filter(k => keyHealthOf(k).cooldownUntil <= now);
  if (healthy.length > 0) {
    return healthy[Math.floor(Math.random() * healthy.length)];
  }
  // 全部都在冷却期：挑最早解冻的那个，避免一直撞同一个 key
  let best = pool[0];
  for (let i = 1; i < pool.length; i++) {
    if (keyHealthOf(pool[i]).cooldownUntil < keyHealthOf(best).cooldownUntil) best = pool[i];
  }
  return best;
}

// 记录一次密钥使用结果。ok 时立刻恢复；失败时指数退避进入冷却期。
function noteKeyResult(key, ok, status) {
  if (!key) return;
  const h = keyHealthOf(key);
  h.lastStatus = Number(status) || 0;
  if (ok) {
    h.failStreak = 0;
    h.cooldownUntil = 0;
    return;
  }
  h.failStreak += 1;
  const wait = Math.min(KEY_COOLDOWN_BASE_MS * Math.pow(2, h.failStreak - 1), KEY_COOLDOWN_MAX_MS);
  h.cooldownUntil = Date.now() + wait;
}

// 上游请求头：未配置密钥时**不发送** Authorization。
// 原实现固定发 `Bearer `（尾部为空），对 Ollama 之类免密钥网关是多余的畸形头，
// 对需要密钥的服务则会掩盖「其实是没配 key」这个事实。
function authHeaders(key) {
  const h = { 'Content-Type': 'application/json' };
  if (key) h['Authorization'] = 'Bearer ' + key;
  return h;
}

// 带密钥轮换的上游请求。buildInit(key) 每次尝试都会被重新调用 ——
// 调用方在闭包里计算超时信号，这样每次尝试都拿到正确的剩余预算，
// 而不是共用第一次算出来的 deadline（否则重试会整体超出函数时限）。
// 返回值：{ resp, key, attempts }；resp 可能是 !ok 的响应，由调用方决定如何报错。
async function fetchWithKeyRotation(cfg, buildInit, opts) {
  const o = opts || {};
  const keys = (cfg && Array.isArray(cfg.keys)) ? cfg.keys.filter(Boolean) : [];
  const rotationOn = !(cfg && cfg.keyRotate === false);
  const wantAttempts = o.maxAttempts > 0 ? o.maxAttempts : KEY_MAX_ATTEMPTS;
  const maxAttempts = rotationOn
    ? Math.max(1, Math.min(keys.length || 1, wantAttempts))
    : 1;

  const tried = [];
  let lastResp = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const key = keys.length > 0 ? pickApiKey(keys, tried) : '';
    if (keys.length > 0 && key === null) break;
    tried.push(key);
    const isLast = attempt >= maxAttempts;

    let resp;
    try {
      resp = await fetch(cfg.apiUrl, buildInit(key));
    } catch (e) {
      // 网络层异常：不记熔断、不换 key 重试（见上方说明），原样抛给调用方处理超时/暂停逻辑
      throw e;
    }

    if (resp.ok) {
      noteKeyResult(key, true, resp.status);
      return { resp, key, attempts: attempt };
    }

    lastResp = resp;
    noteKeyResult(key, false, resp.status);

    // 换 key 也治不好的错误，或者已经没得换了：交回调用方
    if (!isKeyRetryableStatus(resp.status) || isLast) {
      return { resp, key, attempts: attempt };
    }

    // 还有下一次尝试：把这次失败的响应体丢掉，避免连接悬挂
    try { await resp.body.cancel(); } catch (e) {}
  }

  return { resp: lastResp, key: tried[tried.length - 1] || '', attempts: tried.length };
}

// 密钥池状态（供 /healthz?debug 排障用）。只回显掩码，绝不输出 key 原文。
function keyPoolStatus(env) {
  let cfg;
  try { cfg = getChannelConfig(env); } catch (e) { return []; }
  const models = (cfg && cfg.models) || [];
  const now = Date.now();
  const out = [];
  for (const m of models) {
    const ch = cfg.modelMap.get(m.id);
    if (!ch) continue;
    out.push({
      model: m.id,
      keys: ch.keys.length,
      health: ch.keys.map(k => {
        const h = KEY_HEALTH.get(k);
        return {
          k: maskKey(k),
          failStreak: h ? h.failStreak : 0,
          lastStatus: h ? h.lastStatus : 0,
          cooldownMs: h && h.cooldownUntil > now ? h.cooldownUntil - now : 0,
        };
      }),
    });
  }
  return out;
}

function maskKey(k) {
  const s = String(k || '');
  if (!s) return '(未配置)';
  if (s.length <= 4) return '***';
  return '***' + s.slice(-4);
}

// 测试用：清空密钥健康状态，避免用例之间互相污染
function __resetKeyHealth() {
  KEY_HEALTH.clear();
}

// ======= 图像接口请求体 =======
// 关键点：必须显式声明 response_format。
// 多数图像接口（含 SenseNova 日日新）的默认值是 b64_json —— 只返回 base64、不返回 url。
// 前端拿到 base64 既没法直接渲染，内联进 Markdown 又会撑爆 localStorage 配额。
// 这里默认要 url，再由 images.js 转存成自有域名下的长期链接。
// 想强制 base64 可设 IMAGE_RESPONSE_FORMAT=b64_json。
function envBool(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const s = String(v).trim().toLowerCase();
  return !(s === '0' || s === 'false' || s === 'off' || s === 'no');
}

function buildImagePayload(env, model, prompt) {
  const p = { model: model, prompt: prompt, n: 1 };

  const rf = String(env.IMAGE_RESPONSE_FORMAT || 'url').trim().toLowerCase();
  p.response_format = (rf === 'b64_json') ? 'b64_json' : 'url';

  const size = String(env.IMAGE_SIZE || '').trim();
  if (size) p.size = size;

  const fmt = String(env.IMAGE_OUTPUT_FORMAT || '').trim().toLowerCase();
  if (fmt) p.output_format = fmt;

  // watermark / prompt_extend 不配置就不发送，交给上游用自己的默认值，
  // 避免对参数校验严格的接口因为多出来的字段整单 400
  const wm = envBool(env.IMAGE_WATERMARK);
  if (wm !== null) p.watermark = wm;

  const pe = envBool(env.IMAGE_PROMPT_EXTEND);
  if (pe !== null) p.prompt_extend = pe;

  return p;
}

// 提取共用的 AI 请求构建逻辑 (DRY原则)
// tools: 可选，OpenAI 兼容的 tools 数组（Agent 模式用）；图片通道自动忽略
function buildAIRequest(env, requestedModel, messagesArray, isStream, tools) {
  const { models, modelMap } = getChannelConfig(env);

  if (models.length === 0) {
    return { error: "未配置任何可用模型。请在 Worker 的环境变量中设置 API_URL_1 / API_KEY_1 / MODEL_1（或 API_URL / API_KEY / MODEL），保存后重新部署一次。" };
  }

  let selectedModel = requestedModel || models[0].id;

  if (!modelMap.has(selectedModel)) {
    selectedModel = models[0].id;
  }

  const channel = modelMap.get(selectedModel);
  if (!channel || !channel.url) return { error: `模型 ${selectedModel} 对应的 API_URL 未配置或异常` };

  // 密钥池：优先挑健康的 key。currentApiKey 是「首选 key」（保留给旧调用方），
  // 真正发请求请走 fetchWithKeyRotation —— 它会自行轮换，并在失败时换一个 key 重试。
  const currentApiKey = channel.keys.length > 0 ? pickApiKey(channel.keys, []) : "";
  const apiUrl = channel.url;
  // 图片模型按接口路径判定，不再按模型名猜测，避免误伤。
  // 走 URL 解析而不是裸 includes：带上查询串的地址也能判准。
  let apiPath = apiUrl;
  try { apiPath = new URL(apiUrl).pathname; } catch (e) {}
  const isImageAPI = /\/images\/(generations|edits)(\/|$)/.test(apiPath) || apiUrl.includes('images/generations');

  // max_tokens 可配：环境变量 MAX_TOKENS，默认 4096，上限 32000
  let maxTokens = parseInt(env.MAX_TOKENS || '4096', 10);
  if (!(maxTokens > 0)) maxTokens = 16384;
  if (maxTokens > 32000) maxTokens = 32000;

  // v6.8.9：图片通道取最后一条消息的纯文本。之前直接
  // messagesArray[len-1].content —— 空数组会 TypeError，多模态 content（分片数组）
  // 会把整个对象塞进 prompt，上游必然报错
  let lastPrompt = '';
  const lastMsg = messagesArray[messagesArray.length - 1];
  if (lastMsg) {
    if (typeof lastMsg.content === 'string') {
      lastPrompt = lastMsg.content;
    } else if (Array.isArray(lastMsg.content)) {
      const seg = lastMsg.content.find(s => s && s.type === 'text' && typeof s.text === 'string');
      lastPrompt = seg ? seg.text : '';
    }
  }

  const payload = isImageAPI ? buildImagePayload(env, selectedModel, lastPrompt) : {
    model: selectedModel,
    // v6.9.0：只透传上游认识的标准字段。本地附加字段（如前端时间戳 t）
    // 不剥离的话，严格校验参数的上游会整单 400
    messages: messagesArray.map(m => {
      const o = { role: m.role, content: m.content };
      if (m.tool_calls) o.tool_calls = m.tool_calls;
      if (m.tool_call_id) { o.tool_call_id = m.tool_call_id; if (m.name) o.name = m.name; }
      if (m.reasoning_content) o.reasoning_content = m.reasoning_content;
      return o;
    }),
    stream: isStream,
    max_tokens: maxTokens,
  };
  if (tools && tools.length && !isImageAPI) payload.tools = tools;

  return {
    apiUrl,
    currentApiKey,
    keys: channel.keys,
    hasKey: channel.keys.length > 0,
    // API_KEY_ROTATE=0 可关掉「失败换 key 重试」，退回「一次请求一个 key」的老行为
    keyRotate: String(env.API_KEY_ROTATE || '1') !== '0',
    payload,
    isImageAPI,
  };
}

export {
  getChannelConfig,
  buildAIRequest,
  buildImagePayload,
  fetchWithKeyRotation,
  authHeaders,
  isKeyRetryableStatus,
  keyPoolStatus,
  __resetKeyHealth,
};
