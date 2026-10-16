// 持久化层：R2 读写删（_worker.js 原第 191-195,276-301 行）

// ==================== 持久化层：R2 ====================
// v6.3.1 起彻底移除 KV，只用 R2：无日写入上限（免费版每月 100 万次 A 类操作）、
// 单对象可达 5TB、读写强一致。未绑定 R2 时退化为纯内存
// （isolate 重启丢失；Telegram 机器人需要持久化，请务必绑定 R2）。
//
async function storeGet(env, key) {
  if (!env.R2) return null;
  try {
    const obj = await env.R2.get(key);
    if (obj) return await obj.text();
  } catch (e) {}
  return null;
}

async function storePut(env, key, value) {
  if (!env.R2) return;
  try { await env.R2.put(key, String(value)); } catch (e) {}
}

// v6.8.3：带成功返回的 R2 写入。storePut 静默吞错，只用于"尽力而为"的场景；
// 知识库/记忆写入必须诚实——没存上就要让 Agent 知道，而不是谎称成功。
async function storePutChecked(env, key, value) {
  if (!env.R2) return false;
  try { await env.R2.put(key, String(value)); return true; }
  catch (e) { return false; }
}

async function storeDelete(env, key) {
  if (!env.R2) return;
  try { await env.R2.delete(key); } catch (e) {}
}

export {
  storeGet,
  storePut,
  storePutChecked,
  storeDelete,
};
