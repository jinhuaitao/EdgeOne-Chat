// EdgeOne Makers 入口：把 EdgeOne 的 onRequest(context) 适配成原来的
// Workers 风格 routeRequest(request, env, ctx)，路由分发逻辑与原 _worker.js 完全一致。
//
// 与原版的唯一实质差异：
//   1) 存储：env.R2 由 store/edge-store.js 注入（EdgeOne Blob 或 KV 的 R2 兼容替身）；
//   2) 客户端 IP：rate-limit.js 增加了 EO-Connecting-IP 等头名；
//   3) 配置缓存：channel.js 的模型配置缓存加了 env 签名，避免多实例下串配置；
//   4) /healthz 额外返回当前生效的存储后端，便于线上排障；
//   5) 新增 /tg-setup 自诊断端点，把 Telegram 的静默失败翻成可读原因；
//   6) 新增微信 ClawBot (iLink) 通道路由（/api/wx/* 与 /wx-webhook）。

import { CORS_HEADERS, TEXT_HEADERS, HTML_HEADERS, SSE_HEADERS, PNG_HEADERS,
  MANIFEST_HEADERS, SW_HEADERS, HEALTH_HEADERS, APP_VERSION, imgHeaders } from './constants.js';
import { denyUnauthorized } from './auth.js';
import { hitRateLimit } from './rate-limit.js';
import { getChannelConfig, buildAIRequest, fetchWithKeyRotation, authHeaders, keyPoolStatus } from './channel.js';
import { readErrorBody } from './agent/stability.js';
import { handleWebAgent } from './web-agent.js';
import { agentTurnStats } from './agent/loop.js';
import { handleTgWebhook } from './telegram/handler.js';
import { handleTgSetup } from './telegram/setup.js';
import { handleWxWebhook, handleWxApi, maybeWakeWxDaemon } from './wechat/handler.js';
import { ICON_B64, getIconBytes } from './pwa/icons.js';
import { MANIFEST_JSON } from './pwa/manifest.js';
import { SW_JS } from './pwa/service-worker.js';
import { getPwaVersion } from './pwa/version.js';
import { HTML_CONTENT } from './ui/index.js';
import { resolveStore, ensureProvisioned, activeBackendName, storageDiagnostics, probeStore } from './store/edge-store.js';
import { loadStoredImage, buildImageSseResponse, IMG_URL_PATH } from './images.js';
import { kbPrefetch } from './kb/prefetch.js';
import { agentGetMemories, formatSemanticBlock } from './agent/memory.js';
import { getWorking, getEpisodes, pickRelevantEpisodes, formatLayeredMemory, memoryDiag,
  recordTurnMemory } from './agent/memory-layers.js';

// ==================== 普通对话模式的记忆写回 ====================
// v7.10.1：旧实现只在这里「注入」记忆，却从不「写回」——于是 L1/L2 永远是空的，
// 注入的那段代码等于白写，用户关掉 Agent 后聊一整天，`/memory` 里还是一片空白。
// 这里用 tee() 把上游 SSE 分出一支旁路，边读边抽取正文，流结束后写回。
// 三点约束：
//   1) 只旁路、不改写：客户端拿到的字节与原来完全一致；
//   2) 不阻塞：不 await，写回失败/超时都不影响已经发出去的答案；
//   3) 只收正文：上限 6000 字符，足够抽出结论句，也不会为一段长回答占满内存。
const MEM_MIRROR_MAX_CHARS = 6000;

async function collectSseAssistantText(stream) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line || line.charAt(0) === ':') continue;
        if (line.indexOf('data:') !== 0) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const ch = j && j.choices && j.choices[0];
          const d = ch && (ch.delta || ch.message);
          if (d && typeof d.content === 'string') text += d.content;
        } catch (e) { /* 非 JSON 的心跳/注释行，忽略 */ }
      }
      if (text.length >= MEM_MIRROR_MAX_CHARS) {
        text = text.slice(0, MEM_MIRROR_MAX_CHARS);
        break;
      }
    }
  } catch (e) {
    // 上游中途断开：已经收到的部分照样写回（半截结论也比没有强）
  }
  try { await reader.cancel(); } catch (e) {}
  return text;
}

// 旁路写回：调用方拿到响应后这里继续跑，不 await。
function mirrorTurnToMemory(env, upstreamBody, meta) {
  if (!upstreamBody || typeof upstreamBody.tee !== 'function') return upstreamBody;
  let client = null;
  let mirror = null;
  try {
    [client, mirror] = upstreamBody.tee();
  } catch (e) {
    return upstreamBody;
  }
  const job = (async () => {
    const ai = await collectSseAssistantText(mirror);
    if (!ai) return;
    const timeout = new Promise(r => setTimeout(() => r({ ok: false, reason: 'timeout' }), 800));
    await Promise.race([
      recordTurnMemory(env, meta.sessionScope, {
        userText: meta.userText,
        assistantText: ai,
      }, { episodeScope: meta.longScope }).catch(() => null),
      timeout,
    ]);
  })();
  // 显式吞掉异常：记忆是增强项，绝不能冒泡成未处理的 Promise 拒绝
  job.catch(() => {});
  return client;
}

// 取最后一条用户消息的纯文本（兼容多模态分片数组）。预检索用它当查询词。
function pickLastUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    const c = m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      const seg = c.find(s => s && s.type === 'text' && typeof s.text === 'string');
      return seg ? seg.text : '';
    }
    return '';
  }
  return '';
}

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
    // 任何非 /wx-webhook 请求（包括前端 /healthz 探针、首页访问或外部无鉴权监控 ping /healthz）均自动检测并唤醒微信后台保活链
    if (url.pathname !== '/wx-webhook') {
      maybeWakeWxDaemon(request, env, ctx);
    }

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
        if (url.searchParams.get('probe') === '1') {
          try { debug.probe = await probeStore(); } catch (e) {}
        }
        try { debug.keyPool = keyPoolStatus(env); } catch (e) {}
        // v7.5.0：Agent 每轮统计（步数 / 工具数 / 失败数 / 缓存命中 / 停止原因）。
        // 只反映「处理这个请求的实例」，跨实例看全量请用控制台日志。
        try { debug.agent = agentTurnStats(); } catch (e) {}
        // v7.10.0：三层记忆的实例内计数（写回次数 / 召回次数 / 写失败）。
        // 记忆是「悄悄生效」的功能，没有这几个数就完全没法判断它到底有没有在工作。
        try { debug.memory = memoryDiag(); } catch (e) {}
        payload.debug = debug;
      }
      return new Response(JSON.stringify(payload), { headers: HEALTH_HEADERS });
    }

    if (url.pathname.startsWith('/api/wx/')) {
      return await handleWxApi(request, env, url, ctx);
    }

    // 生图结果：转存后的图片通过这里回给浏览器。
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

        const { payload, isImageAPI } = aiConfig;

        // Web 端 Agent 模式 —— 复用 Telegram 同一套 ReAct 循环 + 工具链，
        // 进度通过 SSE 事件推送。Web 端对知识库只读（kbReadOnly: true），优先检索知识库文档。
        if (body.agent === true && !isImageAPI) {
          return await handleWebAgent(env, body);
        }

        // v7.7.0：普通对话模式也优先读知识库。
        // 旧实现只有 Agent 模式才加载知识库 —— 用户一关 Agent，知识库就等于不存在，
        // 回答完全靠模型训练知识。这里在调用上游之前先做一次轻量全文检索，
        // 命中就把片段作为一条 system 消息插到最前面（前端历史里不保存它，不会累积）。
        // v7.8.0：页面上不再有「📚 知识库」开关，知识库恒定开启（这正是用户要的默认行为）。
        // 保留 kb_first=false 只是给外部调用方/旧缓存页面留的逃生口，页面本身已不再发送；
        // 运维级关闭用 WEB_KB_FIRST=0。
        // v7.10.0：同一个位置再注入三层记忆。旧实现普通对话模式完全不带记忆，
        // 用户一说「刚才说的那个」就断片；现在把 L1 要点 / L2 相关历史 / L3 长期事实
        // 合成一段 system 前缀（≤1500 字符），和知识库片段一起下发。
        const injectParts = [];
        const lastUserText = pickLastUserText(body.messages);
        // v7.10.1：session_id 缺失时不再兜底成 'web_default'。
        // 兜底的后果是所有不带 session_id 的请求共用一份 L1 工作记忆——
        // 外部调用方 A 的对话要点会出现在调用方 B 的提示词里。
        // 现在没有会话标识就退回浏览器作用域（有 client_id）或干脆不读写 L1。
        const rawSid = String(body.session_id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
        const webCid = String(body.client_id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
        // L1 跟会话走、L2/L3 跟浏览器走（与 web-agent.js 同一套作用域规则）
        const longScope = webCid ? ('webu_' + webCid) : (rawSid ? 'web_' + rawSid : '');
        const sessionScope = rawSid ? ('web_' + rawSid) : longScope;
        const memoryOn = !isImageAPI && String(env.WEB_MEMORY || '1') !== '0' && !!longScope;

        if (memoryOn) {
          try {
            const [mems, work, eps] = await Promise.all([
              agentGetMemories(env, longScope).catch(() => []),
              sessionScope ? getWorking(env, sessionScope).catch(() => null) : Promise.resolve(null),
              getEpisodes(env, longScope).catch(() => []),
            ]);
            const memText = formatSemanticBlock(mems, lastUserText, 900);
            const layered = formatLayeredMemory({
              work: work,
              episodes: pickRelevantEpisodes(eps, lastUserText, 2),
            }, { budget: 700 }).text;
            const merged = [layered, memText].filter(Boolean).join('\n\n');
            if (merged) injectParts.push(merged);
          } catch (e) {
            // 记忆注入失败不影响正常对话
          }
        }

        if (!isImageAPI && body.kb_first !== false && String(env.WEB_KB_FIRST || '1') !== '0') {
          try {
            const pre = await kbPrefetch(env, lastUserText, {
              budgetMs: parseInt(env.WEB_KB_PREFETCH_MS || '', 10) > 0
                ? Math.min(parseInt(env.WEB_KB_PREFETCH_MS, 10), 6000)
                : 2200,
              topN: 2,
            });
            if (pre && pre.ok && pre.text) injectParts.push(pre.text);
          } catch (e) {
            // 预检索失败绝不能影响正常对话：静默降级为「不带知识库回答」
          }
        }

        if (injectParts.length) {
          const injected = injectParts.join('\n\n');
          const first = payload.messages[0];
          if (first && first.role === 'system') {
            // 前端自带 system 时合并，避免出现两条 system（部分上游会整单 400）
            payload.messages[0] = { role: 'system', content: String(first.content || '') + '\n\n' + injected };
          } else {
            payload.messages = [{ role: 'system', content: injected }].concat(payload.messages);
          }
        }

        const { resp: upstreamResponse } = await fetchWithKeyRotation(aiConfig, (key) => ({
          method: 'POST',
          headers: authHeaders(key),
          body: JSON.stringify(payload)
        }));

        if (!upstreamResponse.ok) {
          const errText = await readErrorBody(upstreamResponse, 2048);
          return new Response(JSON.stringify({ error: `API 报错 (${upstreamResponse.status}):${errText}` }), {
            status: upstreamResponse.status,
            headers: CORS_HEADERS,
          });
        }

        if (!isImageAPI) {
          // v7.10.1：普通对话模式也写回记忆。旁路 tee 不改变发给客户端的字节，
          // 写回在后台进行，失败/超时都不影响这一轮回答。
          const outBody = memoryOn
            ? mirrorTurnToMemory(env, upstreamResponse.body, {
              userText: lastUserText,
              sessionScope: sessionScope,
              longScope: longScope,
            })
            : upstreamResponse.body;
          return new Response(outBody, { headers: SSE_HEADERS });
        } else {
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
    if ((request.method === 'GET' || request.method === 'POST') && url.pathname === '/tg-setup') {
      return await handleTgSetup(request, env, url);
    }

    // 微信 ClawBot (iLink) Webhook：支持第三方 iLink 网关推送消息
    if ((request.method === 'POST' || request.method === 'GET') && url.pathname === '/wx-webhook') {
      return await handleWxWebhook(request, env, url, ctx);
    }

    return new Response('Not Found', { status: 404 });
  } catch (error) {
    return new Response(JSON.stringify({ error: error && error.message ? error.message : String(error) }), { status: 500, headers: CORS_HEADERS });
  }
}

// CORS 收紧（可选）。配置 CORS_ORIGIN 后，Access-Control-Allow-Origin 只回显名单内的 Origin。
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
    __context: context,
  };

  try { ensureProvisioned(rawEnv, ctx, store); } catch (e) {}

  const res = await routeRequest(request, env, ctx);
  return applyCorsOrigin(res, env, request);
}

export { handle, routeRequest };
