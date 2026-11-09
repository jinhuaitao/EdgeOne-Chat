// Web 端 Agent：与 Telegram 共用循环，进度与正文走 SSE（_worker.js 原第 1823-1897 行）

import { SSE_HEADERS } from './constants.js';
import { tgAgentChat } from './agent/loop.js';
import { agentLimits } from './agent/limits.js';

// ==================== Web 端 Agent（v6.6.0，v6.9.3 只读权限分域，v7.7.0 预检索） ====================
// 与 Telegram 共用 tgAgentChat（提供联网搜索、网页抓取、计算、天气、时间及知识库只读检索），
// Web 端对知识库只读（kbReadOnly: true），不暴露写入工具，也不再读取/产生 Web 会话记忆。
// v7.7.0：进入循环前先做一次知识库预检索（kbPrefetch），把最相关的正文片段直接放进
// 系统提示词 —— 这是「Web 优先读知识库」真正落地的地方：不依赖模型主动调工具。
// 进度通过 SSE 自定义事件推送：{"agent_progress": "..."} / {"agent_error": "..."}，
// 正文走标准 OpenAI delta 事件，最后 data: [DONE] 结束。
async function handleWebAgent(env, body) {
  // v7.10.1：session_id 缺失时不再兜底成 'default'。兜底会让所有不传 session_id 的
  // 调用方共用 web_default 这一份工作记忆，A 的对话要点会出现在 B 的提示词里。
  // 现在没有 session_id 就退回浏览器作用域；连 client_id 也没有就干脆不读写记忆
  // （没有身份就没有「谁的记忆」这回事）。
  const rawSid = String(body.session_id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  const webChatId = rawSid ? 'web_' + rawSid : '';
  // v7.10.0 三层记忆的作用域：
  //   L1 工作记忆跟「这一个会话」走（web_<sid>）—— 换会话就该是新的一段现场；
  //   L2/L3 跟「这个浏览器」走（webu_<client_id>）—— 换会话不该把「我是谁、上次聊了什么」也换掉。
  // client_id 由前端生成并持久化在 localStorage；老缓存页面没有它时退回会话级作用域，
  // 记忆变成「只在本次会话内有效」，但绝不会串到别人身上。
  const cid = String(body.client_id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  const longScope = cid ? ('webu_' + cid) : webChatId;
  const memoryOn = String(env.WEB_MEMORY || '1') !== '0' && !!longScope;
  // L1 的作用域：优先会话，没有会话标识时退回浏览器作用域（仍然唯一，不会串号）
  const l1Scope = webChatId || longScope;
  const history = Array.isArray(body.messages) ? body.messages : [];
  const targetModelId = body.model;
  const encoder = new TextEncoder();
  // Web 无 Telegram 上下文：typing 心跳直接 no-op
  const noOpTgApi = () => Promise.resolve({ ok: true });

  // Web 单轮预算：浏览器是长连接，不需要 Telegram 那套 55 秒妥协，但沿用
  // AGENT_TIMEOUT_MS 的 240 秒默认值会让用户对着"思考中"干等 4 分钟。
  // 90 秒足以覆盖绝大多数问题，超时立刻给明确结论。可用 WEB_AGENT_TIMEOUT_MS 覆盖。
  let webBudgetMs = parseInt(env.WEB_AGENT_TIMEOUT_MS || '90000', 10);
  if (!(webBudgetMs >= 10000)) webBudgetMs = 90000;
  if (webBudgetMs > 240000) webBudgetMs = 240000;
  // v7.5.0：再大也大不过函数存活时间。旧实现允许配到 240 秒，而 Cloud Functions
  // 上限是 120 秒 —— 真按 240 秒跑，函数会被平台直接掐断，前端只看到连接断开，
  // 既没有答案也没有任何错误原因。这里按平台上限收口，超时至少能走收尾流程。
  const runtimeCap = agentLimits(env).runtimeCapMs;
  if (webBudgetMs > runtimeCap) webBudgetMs = runtimeCap;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => {
        try { controller.enqueue(encoder.encode('data: ' + JSON.stringify(obj) + '\n\n')); } catch (e) {}
      };
      const done = () => {
        try { controller.enqueue(encoder.encode('data: [DONE]\n\n')); } catch (e) {}
        try { controller.close(); } catch (e) {}
      };
      // 保活心跳：每 15 秒发一个以 ':' 开头的 SSE 注释行
      const ka = setInterval(() => {
        try { controller.enqueue(encoder.encode(': keep-alive ' + Date.now() + '\n\n')); } catch (e) {}
      }, 15000);
      const webOpts = {
        maxRuntimeMs: webBudgetMs,
        // Web 端查询优先知识库：文档列表注入系统提示词（loop.js 读取此标记）
        kbFirst: true,
        // v7.7.0：进入循环前先做一次预检索，把最相关的正文片段直接放进提示词。
        // 只给标题列表时，模型经常「看了标题就凭训练知识答」，或先花一步 search_docs
        // 才摸到正文；预检索把这一步省掉，也让回答真正以知识库为准。
        // v7.8.0：页面上的开关已移除，知识库恒定开启。kb_first=false 只为外部调用与
        // 旧缓存页面保留；运维级关闭用 WEB_KB_FIRST=0。
        kbPrefetch: body.kb_first !== false && String(env.WEB_KB_FIRST || '1') !== '0',
        kbPrefetchBudgetMs: (() => {
          const v = parseInt(env.WEB_KB_PREFETCH_MS || '', 10);
          return v > 0 ? Math.min(v, 6000) : 2500;
        })(),
        // v6.9.3：Web 端对知识库只读——写入（remember / save_doc / delete_doc）
        // 仅 Telegram 端开放，Web 访客无法污染全局知识库
        kbReadOnly: true,
        // v7.10.0：三层记忆。读：Web 也读（旧实现 Web 完全没有记忆，连用户刚说的话都不记得）；
        // 写：L1/L2 由服务端自动写回（不是用户可触发的写工具），L3 仍禁止 Web 写入。
        memoryRead: memoryOn,
        memoryWrite: memoryOn,
        memoryLayers: memoryOn,
        memoryScope: longScope,
        onDelta: async (text, kind) => {
          if (kind === 'reasoning') send({ choices: [{ delta: { reasoning_content: text } }] });
          else send({ choices: [{ delta: { content: text } }] });
        },
        onReset: async () => { send({ agent_reset: true }); }
      };
      try {
        const onProgress = async (text) => { send({ agent_progress: String(text).slice(0, 500) }); };
        let r = await tgAgentChat(env, noOpTgApi, l1Scope, targetModelId, history, true, onProgress, webOpts);
        // v7.9.0：通道拒收 tools 时先降级为「文本调用模式」（工具仍能执行），
        // 再不行才彻底关工具 —— 旧实现一步跳到「没有工具」，用户拿到残废答案且毫不知情。
        if (r.fallback) {
          r = await tgAgentChat(env, noOpTgApi, l1Scope, targetModelId, history, true, onProgress,
            Object.assign({}, webOpts, { promptTools: true }));
        }
        if (r.fallback) r = await tgAgentChat(env, noOpTgApi, l1Scope, targetModelId, history, false, onProgress, webOpts);
        if (r.error) {
          send({ agent_error: r.error });
        } else if (r.streamed) {
          // 正文已经在流式过程中逐字推完了，这里什么都不用补，直接收尾
        } else if (r.text) {
          const t = r.text;
          for (let i = 0; i < t.length; i += 2000) {
            send({ choices: [{ delta: { content: t.slice(i, i + 2000) } }] });
          }
        } else {
          send({ agent_error: 'AI 没有返回有效内容' });
        }
      } catch (e) {
        send({ agent_error: '⚠️ Agent 执行出错：' + (e && e.message ? e.message : String(e)) });
      } finally {
        clearInterval(ka);
      }
      done();
    }
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

export {
  handleWebAgent,
};
