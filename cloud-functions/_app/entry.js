// EdgeOne Makers 入口：把 EdgeOne 的 onRequest(context) 适配成原来的
// Workers 风格 routeRequest(request, env, ctx)，路由分发逻辑与原 _worker.js 完全一致。
//
// 与原版的唯一实质差异：
//   1) 存储：env.R2 由 store/edge-store.js 注入（EdgeOne Blob 或 KV 的 R2 兼容替身）；
//   2) 客户端 IP：rate-limit.js 增加了 EO-Connecting-IP 等头名；
//   3) 配置缓存：channel.js 的模型配置缓存加了 env 签名，避免多实例下串配置；
//   4) /healthz 额外返回当前生效的存储后端，便于线上排障；
//   5) 新增 /tg-setup 自诊断端点，把 Telegram 的静默失败翻成可读原因。

import { CORS_HEADERS, TEXT_HEADERS, HTML_HEADERS, SSE_HEADERS, PNG_HEADERS,
  MANIFEST_HEADERS, SW_HEADERS, HEALTH_HEADERS, APP_VERSION, imgHeaders } from './constants.js';
import { denyUnauthorized } from './auth.js';
import { hitRateLimit } from './rate-limit.js';
import { getChannelConfig, buildAIRequest } from './channel.js';
import { readErrorBody } from './agent/stability.js';
import { handleWebAgent } from './web-agent.js';
import { handleTgWebhook } from './telegram/handler.js';
import { handleTgSetup } from './telegram/setup.js';
import { ICON_B64, getIconBytes } from './pwa/icons.js';
import { MANIFEST_JSON } from './pwa/manifest.js';
import { SW_JS } from './pwa/service-worker.js';
import { getPwaVersion } from './pwa/version.js';
import { HTML_CONTENT } from './ui/index.js';
import { resolveStore, ensureProvisioned, activeBackendName, storageDiagnostics, probeStore } from './store/edge-store.js';
import { loadStoredImage, buildImageSseResponse, IMG_URL_PATH } from './images.js';

// 把 EdgeOne 的 context.env 包一层，在保留原有全部环境变量的同时，
// 额外提供 env.R2（存储替身）。用 Proxy 而不是对象展开，是为了不丢失
// 平台可能用 getter 暴露的变量，也不改变 env 的原始行为。
function makeEnvView(rawEnv, store) {
  const base = rawEnv || {};
  return new Proxy(base, {
    get(target, prop) {
      if (prop === 'R2') return store || undefined;
      return target[prop];
    },
    has(target, prop) {
      if (prop === 'R2') return !!store;
      return prop in target;
    },
    ownKeys(target) {
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, prop) {
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
}

async function routeRequest(request, env, ctx) {
  // 顶层兜底：任何路由内未捕获的异常都以 JSON 500 返回，
  // 而不是让函数崩成平台的错误页（前端无从显示原因）
  try {
    const url = new URL(request.url);

    // 可选域名所有权验证文件：支持通过环境变量 VERIFY_FILE_PATH / VERIFY_FILE_CONTENT 配置
    if (request.method === 'GET' && env && env.VERIFY_FILE_PATH && url.pathname === env.VERIFY_FILE_PATH) {
      return new Response(String(env.VERIFY_FILE_CONTENT || ''), { headers: TEXT_HEADERS });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // ================= PWA 路由 =================
    if (request.method === 'GET' && url.pathname === '/manifest.webmanifest') {
      return new Response(MANIFEST_JSON, { headers: MANIFEST_HEADERS });
    }

    if (request.method === 'GET' && url.pathname === '/sw.js') {
      return new Response(SW_JS.replaceAll('{{PWA_VERSION}}', getPwaVersion()), { headers: SW_HEADERS });
    }

    if (request.method === 'GET' && ICON_B64[url.pathname]) {
      const bytes = getIconBytes(url.pathname);
      if (bytes) return new Response(bytes, { headers: PNG_HEADERS });
    }

    // 健康探针：供前端与 Service Worker 判断服务端是否可达。
    // ⚠️ SW 中必须显式放行该路径且绝不缓存，否则探针会被缓存应答 →
    //    永远「探测成功」→ 自动重连逻辑形同虚设。
    // 额外返回 storage 字段：blob:xxx / kv(xxx) / memory，一眼看出持久化是否真的接上了。
    // 设 STORAGE_DEBUG=1 时会附带后端探测详情（Blob 引入报错、发现的 KV 绑定名等），便于排障。
    if (request.method === 'GET' && url.pathname === '/healthz') {
      const payload = {
        ok: true,
        t: Date.now(),
        runtime: 'edgeone',
        storage: activeBackendName() || 'memory',
      };
      if (env && env.STORAGE_DEBUG === '1') {
        const debug = {};
        try { Object.assign(debug, storageDiagnostics(ctx && ctx.__context, env)); } catch (e) {}
        // ?probe=1 会真实写入并读回一个临时对象，用来确认存储「真的能用」
        // （getStore() 成功只代表 SDK 加载了，不代表有权限/有配额）
        if (url.searchParams.get('probe') === '1') {
          try { debug.probe = await probeStore(); } catch (e) {}
        }
        payload.debug = debug;
      }
      return new Response(JSON.stringify(payload), { headers: HEALTH_HEADERS });
    }

    // 生图结果：转存后的图片通过这里回给浏览器。
    // 公开访问（<img src> 没法带自定义头），所以靠随机且不可枚举的 id 做保护，
    // 并严格校验 id 形态杜绝路径穿越。
    if (request.method === 'GET' && url.pathname.startsWith(IMG_URL_PATH)) {
      const id = url.pathname.slice(IMG_URL_PATH.length);
      const img = await loadStoredImage(env, id);
      if (!img) return new Response('Not Found', { status: 404 });
      return new Response(img.bytes, { headers: imgHeaders(img.contentType) });
    }

    if (request.method === 'POST' && url.pathname === '/api/chat') {
      const denied = denyUnauthorized(env, request);
      if (denied) return denied;

      if (hitRateLimit(request, env)) {
        return new Response(JSON.stringify({ error: "请求过于频繁，请稍后再试", code: "RATE_LIMITED" }), {
          status: 429, headers: CORS_HEADERS,
        });
      }

      try {
        let body;
        try {
          body = await request.json();
        } catch (e) {
          return new Response(JSON.stringify({ error: "无效的请求格式" }), { status: 400, headers: CORS_HEADERS });
        }

        const aiConfig = buildAIRequest(env, body.model, body.messages, body.agent !== true);
        if (aiConfig.error) {
          return new Response(JSON.stringify({ error: aiConfig.error }), { status: 500, headers: CORS_HEADERS });
        }

        const { apiUrl, currentApiKey, payload, isImageAPI } = aiConfig;

        // Web 端 Agent 模式 —— 复用 Telegram 同一套 ReAct 循环 + 工具链，
        // 进度通过 SSE 事件推送。Web 端对知识库只读（kbReadOnly: true），优先检索知识库文档。
        if (body.agent === true && !isImageAPI) {
          return await handleWebAgent(env, body);
        }

        const upstreamResponse = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${currentApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload)
        });

        if (!upstreamResponse.ok) {
          // 错误正文限长读取 —— 上游偶发返回超大 HTML 错误页时不再整段读入
          const errText = await readErrorBody(upstreamResponse, 2048);
          return new Response(JSON.stringify({ error: `API 报错 (${upstreamResponse.status}):${errText}` }), {
            status: upstreamResponse.status,
            headers: CORS_HEADERS,
          });
        }

        if (!isImageAPI) {
          return new Response(upstreamResponse.body, { headers: SSE_HEADERS });
        } else {
          // 图像接口的响应体不是 chat 流，需要单独解析：
          // 兼容 data[].url、data[].b64_json（SenseNova 默认返回方式）以及
          // 少数把图片塞在 choices[].message.content 里的网关。
          // 拿到的图片统一转存到自有存储，返回 /api/img/<id> 长期链接。
          return await buildImageSseResponse(env, upstreamResponse);
        }
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: CORS_HEADERS });
      }
    }

    if (request.method === 'GET' && url.pathname === '/') {
      const { models } = getChannelConfig(env);

      const escHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

      let optionsHtml = '';
      for (let i = 0; i < models.length; i++) {
        const item = models[i];
        let displayName = item.name;
        if (!item.original.includes(':')) {
          displayName = item.id.length > 24 ? item.id.substring(0, 22) + '...' : item.id;
        }
        optionsHtml += `<option value="${escHtml(item.id)}" ${i === 0 ? 'selected' : ''}>${escHtml(displayName)}</option>`;
      }

      if (models.length === 0) {
        optionsHtml = '<option value="" disabled selected>未配置模型，请检查环境变量</option>';
      }

      const html = HTML_CONTENT.replaceAll('{{MODEL_OPTIONS}}', optionsHtml).replaceAll('{{APP_VERSION}}', APP_VERSION);
      return new Response(html, { headers: HTML_HEADERS });
    }

    // Telegram Bot Webhook：命令、Agent 对话与回复发送都在该模块内处理
    if (request.method === 'POST' && url.pathname === '/tg-webhook') {
      return await handleTgWebhook(request, env);
    }

    // Telegram 自诊断 / 一键绑定 webhook（需 TG_SETUP_KEY，回退 TG_WEBHOOK_SECRET）。
    // 存在的理由：setWebhook 返回 ok 只代表「请求被接受」，不代表链路可用 ——
    // 真正的失败信息藏在 getWebhookInfo().last_error_message 里。这个端点把它
    // 连同本地配置快照与进程内事件一起摊开，省掉「盲猜 + 反复重部署」。
    if ((request.method === 'GET' || request.method === 'POST') && url.pathname === '/tg-setup') {
      return await handleTgSetup(request, env, url);
    }

    return new Response('Not Found', { status: 404 });
  } catch (error) {
    return new Response(JSON.stringify({ error: error && error.message ? error.message : String(error) }), { status: 500, headers: CORS_HEADERS });
  }
}

// CORS 收紧（可选）。配置 CORS_ORIGIN 后，Access-Control-Allow-Origin 只回显名单内的 Origin。
// 在顶层统一改写，覆盖包括 web-agent / auth 等所有子模块的响应。
function applyCorsOrigin(res, env, request) {
  if (!env || !env.CORS_ORIGIN) return res;
  if (!res.headers.has('Access-Control-Allow-Origin')) return res;
  const allowed = String(env.CORS_ORIGIN).split(',').map(s => s.trim()).filter(Boolean);
  const origin = request.headers.get('Origin');
  const h = new Headers(res.headers);
  if (origin && allowed.includes(origin)) {
    h.set('Access-Control-Allow-Origin', origin);
    h.set('Vary', 'Origin');
  } else {
    h.delete('Access-Control-Allow-Origin');
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

// EdgeOne Makers Functions 的统一入口
async function handle(context) {
  const request = context.request;
  const rawEnv = context.env || {};

  let store = null;
  try {
    // 传入 context 是为了让存储层能在 env / context / globalThis 三处自动发现 KV 绑定
    store = await resolveStore(context, rawEnv);
  } catch (e) {
    store = null;
  }

  const env = makeEnvView(rawEnv, store);
  const ctx = {
    waitUntil: (p) => {
      try {
        if (typeof context.waitUntil === 'function') return context.waitUntil(p);
      } catch (e) {}
      return undefined;
    },
    // EdgeOne 原始 context：仅供存储层自动发现 KV 绑定与 /healthz 排障输出使用
    __context: context,
  };

  // 自动创建 Blob 命名空间：首个请求时异步跑一次「写标记 + 读回校验」，不阻塞本次响应。
  // 放在这里（而不是模块顶层）是因为需要 waitUntil 托管，避免响应结束后写入被截断。
  try { ensureProvisioned(rawEnv, ctx, store); } catch (e) {}

  const res = await routeRequest(request, env, ctx);
  return applyCorsOrigin(res, env, request);
}

export { handle, routeRequest };
