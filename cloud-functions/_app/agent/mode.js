// Agent 模式开关（默认开启）（_worker.js 原第 705,1036-1049 行）

import { mapSetBounded, mapGetBounded } from '../utils.js';
import { storeGet, storePut } from '../store/r2.js';

const tgAgentModeCache = new Map();
const tgAgentModeExp = new Map();

// 获取 Agent 模式开关（默认开启）
async function agentGetMode(env, chatId) {
  const cached = mapGetBounded(tgAgentModeCache, chatId, env && env.R2 ? tgAgentModeExp : null);
  if (typeof cached === 'boolean') return cached;
  let on = true; // 默认开启 Agent 模式
  const v = await storeGet(env, 'agent_mode_' + chatId);
  on = v !== '0';
  mapSetBounded(tgAgentModeCache, chatId, on, undefined, tgAgentModeExp);
  return on;
}

async function agentSetMode(env, chatId, on) {
  mapSetBounded(tgAgentModeCache, chatId, !!on, undefined, tgAgentModeExp);
  await storePut(env, 'agent_mode_' + chatId, on ? '1' : '0');
}

export {
  agentGetMode,
  agentSetMode,
};
