// Agent 稳定性增强：结果截断、调用签名、上下文预算裁剪（_worker.js 原第 1191-1247 行）

// ==================== Agent 稳定性增强（v6.6.5） ====================
// 1) truncateToolResult：工具结果截断并明确标注，避免模型误以为拿到了完整数据。
// 2) toolCallSignature：工具调用签名，用于"重复调用熔断"。
// 3) trimAgentMessages：上下文预算裁剪。多步任务中工具结果（每条可达 4000 字）
//    会快速堆积，超预算时从最旧的"整轮"（1 条 assistant + 其 tool 消息）开始删，
//    成对删除保证 OpenAI 消息序列合法性（assistant tool_calls 后必须紧跟 tool 应答）。
//    只动本轮循环产生的消息（loopStartIdx 之后），system 与历史对话永不裁剪。

// 工具结果截断：超长时保留前 maxChars 并标注，避免模型误判为完整数据
// v6.8.7：不在代理对中间切断 —— emoji 等增补平面字符占两个 code unit，
// 切开后会产出两个非法字符，可能污染下游的 JSON 序列化与前端渲染
function truncateToolResult(result, maxChars) {
  const s = String(result == null ? '' : result);
  maxChars = maxChars > 0 ? maxChars : 4000;
  if (s.length <= maxChars) return s;
  let cut = maxChars;
  const prev = s.charCodeAt(cut - 1);
  if (prev >= 0xd800 && prev <= 0xdbff) cut -= 1;
  return s.slice(0, cut) + '\n…（结果过长，仅显示前 ' + cut + ' 字符）';
}

// v6.8.7：上游错误响应体带预算读取。错误页可能是几十 KB 的 HTML，
// 失败路径上整段读入只为取前几百字符做诊断，既慢又浪费内存
async function readErrorBody(resp, maxChars) {
  maxChars = maxChars > 0 ? maxChars : 2048;
  try {
    if (!resp.body) return (await resp.text()).slice(0, maxChars);
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let out = '';
    while (out.length < maxChars) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    try { await reader.cancel(); } catch (e) {}
    return out.slice(0, maxChars);
  } catch (e) { return ''; }
}

// 工具调用签名：name + 规范化后的参数，用于检测模型是否在原地打转
function toolCallSignature(tc) {
  const fn = (tc && tc.function) || {};
  let args = {};
  try { args = JSON.parse(fn.arguments || '{}'); } catch (e) { args = {}; }
  const keys = Object.keys(args).sort();
  const norm = {};
  for (const k of keys) norm[k] = args[k];
  return (fn.name || '') + '|' + JSON.stringify(norm);
}

// 按字符预算裁剪 Agent 循环消息；返回新数组（不修改原数组，便于测试与断点续存）
function trimAgentMessages(messages, loopStartIdx, budget) {
  budget = budget > 0 ? budget : 24000;
  const arr = Array.isArray(messages) ? messages : [];
  if (arr.length <= 1) return arr.slice();
  let start = Math.max(0, Math.min(loopStartIdx | 0, arr.length));
  // 估算字符数（JSON 长度近似 token 量的上界）
  const msgLen = (m) => {
    try { return JSON.stringify(m).length; } catch (e) { return 0; }
  };
  let total = 0;
  for (const m of arr) total += msgLen(m);
  if (total <= budget) return arr.slice();
  // 找出本轮循环内的"轮次"边界：每轮以 role=assistant 开头
  const rounds = [];
  let cur = -1;
  for (let i = start; i < arr.length; i++) {
    if (arr[i] && arr[i].role === 'assistant') { cur = rounds.length; rounds.push([i]); }
    else if (cur >= 0) rounds[cur].push(i);
  }
  // 至少保留最后一轮（当前正在进行的上下文），从最旧的轮次开始删
  const doomed = new Set();
  for (let r = 0; r < rounds.length - 1 && total > budget; r++) {
    for (const i of rounds[r]) { doomed.add(i); total -= msgLen(arr[i]); }
  }
  if (!doomed.size) return arr.slice();
  const out = [];
  for (let i = 0; i < arr.length; i++) if (!doomed.has(i)) out.push(arr[i]);
  return out;
}

export {
  truncateToolResult,
  readErrorBody,
  toolCallSignature,
  trimAgentMessages,
};
