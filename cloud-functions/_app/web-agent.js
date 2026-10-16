// Web 端 Agent：与 Telegram 共用循环，进度与正文走 SSE（_worker.js 原第 1823-1897 行）

import { SSE_HEADERS } from './constants.js';
import { tgAgentChat } from './agent/loop.js';

// ==================== Web 端 Agent（v6.6.0，v6.9.3 只读权限分域） ====================
// 与 Telegram 共用 tgAgentChat（提供联网搜索、网页抓取、计算、天气、时间及知识库只读检索），
// Web 端对知识库只读（kbReadOnly: true），不暴露写入工具，也不再读取/产生 Web 会话记忆。
// 进度通过 SSE 自定义事件推送：{"agent_progress": "..."} / {"agent_error": "..."}，
// 正文走标准 OpenAI delta 事件，最后 data: [DONE] 结束。
async function handleWebAgent(env, body) {
  const sid = String(body.session_id || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'default';
  const webChatId = 'web_' + sid;
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
        // v6.9.3：Web 端对知识库只读——写入（remember / save_doc / delete_doc）
        // 仅 Telegram 端开放，Web 访客无法污染全局知识库
        kbReadOnly: true,
        onDelta: async (text, kind) => {
          if (kind === 'reasoning') send({ choices: [{ delta: { reasoning_content: text } }] });
          else send({ choices: [{ delta: { content: text } }] });
        },
        onReset: async () => { send({ agent_reset: true }); }
      };
      try {
        const onProgress = async (text) => { send({ agent_progress: String(text).slice(0, 500) }); };
        let r = await tgAgentChat(env, noOpTgApi, webChatId, targetModelId, history, true, onProgress, webOpts);
        if (r.fallback) r = await tgAgentChat(env, noOpTgApi, webChatId, targetModelId, history, false, onProgress, webOpts);
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
