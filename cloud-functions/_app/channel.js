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
        modelMap.set(id, { url, keys });
      }
    }
  };

  if (env.API_CONFIG) {
    try {
      const channels = JSON.parse(env.API_CONFIG);
      channels.forEach(ch => {
        const url = ch.url;
        const keys = Array.isArray(ch.keys) ? ch.keys : parseCommaSeparated(ch.keys);
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
      const keys = parseCommaSeparated(env[`API_KEY_${i}`]);
      addModels(modelStr, url, keys);
    }
  }
  if (hasIndexed && models.length > 0) {
    return setConfigCache(env, { models, modelMap });
  }

  // 兜底：只使用环境变量中显式配置的模型，不再内置任何默认模型
  const fallbackUrl = env.API_URL || "";
  const fallbackKeys = parseCommaSeparated(env.API_KEY);
  const fallbackModelStr = env.MODEL || "";

  if (fallbackUrl && fallbackModelStr) {
    addModels(fallbackModelStr, fallbackUrl, fallbackKeys);
  }

  cachedConfig = { models, modelMap };
  cachedSig = sig;
  return cachedConfig;
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

  const currentApiKey = channel.keys.length > 0 ? channel.keys[Math.floor(Math.random() * channel.keys.length)] : "";
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

  return { apiUrl, currentApiKey, payload, isImageAPI };
}

export {
  getChannelConfig,
  buildAIRequest,
  buildImagePayload,
};
