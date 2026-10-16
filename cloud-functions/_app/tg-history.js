// Telegram 多轮对话历史（内存 L1 + R2 L2）（_worker.js 原第 166-167,174-190,303-321 行）

import { mapSetBounded, mapGetBounded } from './utils.js';
import { storeGet, storePut, storeDelete } from './store/r2.js';

// ======= Telegram 多轮对话历史（内存 L1 + R2 L2） =======
const tgHistories = new Map();
const tgHistoriesExp = new Map();
function tgHistoryKey(chatId) { return 'tg_hist_' + chatId; }

function tgTrimHistory(history, env) {
  // v6.9.5：先浅拷贝再裁剪，绝不原地修改调用方或缓存中的数组引用
  const list = Array.isArray(history) ? history.slice() : [];
  let maxRounds = parseInt(env.TG_HISTORY_ROUNDS || '10', 10);
  if (!(maxRounds > 0)) maxRounds = 10;
  if (maxRounds > 30) maxRounds = 30;
  const maxMsgs = maxRounds * 2;
  while (list.length > maxMsgs) list.shift();
  // 字符预算：超长历史从最旧开始成对丢弃（user+assistant 一起），
  // 保证剩余序列仍以 user 开头、按轮次交替，上游不会因消息序列非法而报错
  const budget = 12000;
  let total = 0;
  for (let i = 0; i < list.length; i++) total += String(list[i].content || '').length;
  while (list.length > 2 && total > budget) {
    let dropCount = 1;
    if (list[0].role === 'user' && list.length > 1 && list[1].role === 'assistant') dropCount = 2;
    let droppedChars = 0;
    for (let d = 0; d < dropCount && list.length > 2; d++) {
      const dropped = list.shift();
      droppedChars += String(dropped.content || '').length;
    }
    total -= droppedChars;
  }
  return list;
}

async function tgGetHistory(env, chatId) {
  const cached = mapGetBounded(tgHistories, chatId, tgHistoriesExp);
  // v6.9.5：返回浅拷贝，避免外部 history.push() 原地污染缓存（若本轮请求失败会导致脏 user 消息残留）
  if (Array.isArray(cached)) return cached.slice();
  const raw = await storeGet(env, tgHistoryKey(chatId));
  if (raw) {
    try {
      const h = JSON.parse(raw);
      if (Array.isArray(h)) {
        mapSetBounded(tgHistories, chatId, h.slice(), undefined, tgHistoriesExp);
        return h.slice();
      }
    } catch (e) {}
  }
  return [];
}

async function tgSaveHistory(env, chatId, history) {
  const clean = Array.isArray(history) ? history.slice() : [];
  mapSetBounded(tgHistories, chatId, clean, undefined, tgHistoriesExp);
  await storePut(env, tgHistoryKey(chatId), JSON.stringify(clean));
}

async function tgClearHistory(env, chatId) {
  tgHistories.delete(chatId);
  tgHistoriesExp.delete(chatId);
  await storeDelete(env, tgHistoryKey(chatId));
}

export {
  tgHistoryKey,
  tgTrimHistory,
  tgGetHistory,
  tgSaveHistory,
  tgClearHistory,
};
