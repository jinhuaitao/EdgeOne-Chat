// Agent 断点续做：ReAct 循环状态存档（_worker.js 原第 1280-1309 行）

import { storeGet, storePutChecked, storeDelete } from '../store/r2.js';

// ==================== Agent 断点续做 ====================
// webhook 内单轮预算约 55 秒（Telegram 约 60 秒无响应会重发 update；
// 客户端断开后 worker 会被 cancel，靠"不断开赌长连接"是不可靠的）。
// 预算耗尽不再终结任务，而是把 ReAct 循环的 messages 存到 R2，
// 用户发「继续」即用全新预算接着跑，超长任务可分多段完成。
function tgAgentResumeKey(chatId) { return 'tg_agent_' + chatId; }
async function agentSaveResumeState(env, chatId, state) {
  if (!env.R2) return false;
  // v6.8.9：改用 checked 写入。旧版经 storePut 转发，而 storePut 静默吞错，
  // 这里永远返回 true —— 断点实际没存上时仍告诉用户「发送继续可接着做」
  return await storePutChecked(env, tgAgentResumeKey(chatId), JSON.stringify(state));
}
async function agentLoadResumeState(env, chatId) {
  const raw = await storeGet(env, tgAgentResumeKey(chatId));
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    if (!s || !Array.isArray(s.messages) || !s.messages.length) return null;
    // 30 分钟过期：太旧的任务上下文已无意义
    if (Date.now() - (s.savedAt || 0) > 30 * 60 * 1000) {
      await agentClearResumeState(env, chatId);
      return null;
    }
    return s;
  } catch (e) { return null; }
}
async function agentClearResumeState(env, chatId) {
  try { await storeDelete(env, tgAgentResumeKey(chatId)); } catch (e) {}
}

export {
  tgAgentResumeKey,
  agentSaveResumeState,
  agentLoadResumeState,
  agentClearResumeState,
};
