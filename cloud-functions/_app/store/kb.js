// R2 文件夹布局与知识库记忆的 Markdown 镜像辅助（_worker.js 原第 196-275 行）

import { storePut } from './r2.js';

// ---------- R2 文件夹布局（v6.6.6 起，v6.6.7 补充 md 镜像） ----------
// R2 没有真正的目录，用 key 前缀 + '/' 模拟文件夹，控制台按此展示层级。
// 「知识库」（Agent 长期记忆）独立存放在 kb/ 文件夹下，与其它数据隔离，
// 便于在控制台单独浏览、备份或设置生命周期规则；其余数据保持原样不动。
//
//   kb/agent_mem_<chatId>   知识库索引：长期记忆 JSON 数组 [{fact, ts, file}]（唯一可信源）
//   kb/mem/<chatId>/*.md    知识库镜像：每条记忆一个 Markdown 文件（frontmatter + 正文），供控制台浏览
//   kb/docs/<标题>.md       知识库文档：save_doc 工具写入的长篇 Markdown（全局共享）
//   kb/docs/registry.json   文档注册表：标题/来源/大小/时间的索引（去重与列表的唯一依据，损坏自动重建）
//   tg_hist_<chatId>         Telegram 对话历史（根目录，保持原样）
//   tg_user_<chatId>         用户模型选择（根目录，保持原样）
//   agent_mode_<chatId>      Agent 开关（根目录，保持原样）
//   tg_agent_<chatId>        Agent 断点续做（根目录，保持原样）
//
// 注意：md 镜像只是"可读副本"，机器人只读 JSON 索引。手动在控制台改 md
// 不会生效；以索引为准，缺失的 md 会在下次加载时自动补建。
const KB_PREFIX = 'kb/';
function agentMemKey(chatId) { return KB_PREFIX + 'agent_mem_' + chatId; }
function agentMemKeyLegacy(chatId) { return 'agent_mem_' + chatId; } // v6.6.5 及更早的旧 key（根目录），仅用于兼容迁移
// chatId 清洗：只允许字母数字、下划线、中划线，防路径遍历（如 ../）污染 kb/mem/ 目录
function kbSafeChatId(chatId) { return String(chatId == null ? '' : chatId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64); }
function kbMemDir(chatId) { return KB_PREFIX + 'mem/' + kbSafeChatId(chatId) + '/'; }
// md 文件名：时间戳（36 进制，可按字典序排列）+ 随机后缀防同毫秒碰撞
function kbNewMemFile() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6) + '.md'; }
function kbMemMarkdown(chatId, fact, ts) {
  let d = '';
  try { d = new Date(ts || Date.now()).toISOString(); } catch (e) { d = new Date().toISOString(); }
  return '---\nchat_id: "' + kbSafeChatId(chatId) + '"\nsaved_at: ' + d + '\n---\n\n' + String(fact == null ? '' : fact) + '\n';
}
// R2 批量删除（delete 支持字符串数组，一次最多 1000 个）
async function kbDeleteKeys(env, keys) {
  if (!env.R2 || !keys || !keys.length) return;
  try { await env.R2.delete(keys.slice(0, 1000)); } catch (e) {}
  if (keys.length > 1000) await kbDeleteKeys(env, keys.slice(1000));
}
// 清空某用户的整个 md 镜像目录（删 Web 会话时用）
async function kbDeleteMemDir(env, chatId) {
  if (!env.R2) return;
  try {
    const prefix = kbMemDir(chatId);
    let cursor;
    do {
      const listed = await env.R2.list({ prefix: prefix, cursor: cursor, limit: 1000 });
      const keys = (listed.objects || []).map(function (o) { return o.key; });
      if (keys.length) await env.R2.delete(keys);
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  } catch (e) {}
}
// 回补 md 镜像：给缺 file 字段的老条目分配文件名，并补建 R2 里缺失的 md 文件。
// 返回 true 表示索引数组被修改过（调用方需重写索引）。
async function kbBackfillMd(env, chatId, arr) {
  if (!env.R2 || !Array.isArray(arr) || !arr.length) return false;
  const dir = kbMemDir(chatId);
  let indexChanged = false;
  const need = [];
  for (const m of arr) {
    if (!m || !m.fact) continue;
    if (!m.file) { m.file = kbNewMemFile(); indexChanged = true; }
    need.push(m);
  }
  if (!need.length) return indexChanged;
  // 查目录找出 R2 里缺失的 md（分页取全量，避免逐个 HEAD；超 1000 条也 OK）
  const existing = new Set();
  try {
    let cursor;
    do {
      const listed = await env.R2.list({ prefix: dir, limit: 1000, cursor: cursor });
      for (const o of (listed.objects || [])) existing.add(o.key);
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  } catch (e) {}
  const puts = [];
  for (const m of need) {
    const key = dir + m.file;
    if (!existing.has(key)) puts.push(storePut(env, key, kbMemMarkdown(chatId, m.fact, m.ts)));
  }
  if (puts.length) await Promise.all(puts);
  return indexChanged;
}

export {
  KB_PREFIX,
  agentMemKey,
  agentMemKeyLegacy,
  kbSafeChatId,
  kbMemDir,
  kbNewMemFile,
  kbMemMarkdown,
  kbDeleteKeys,
  kbDeleteMemDir,
  kbBackfillMd,
};
