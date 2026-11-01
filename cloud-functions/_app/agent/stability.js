// Agent 稳定性增强：结果截断、调用签名、上下文预算裁剪与压缩

// ==================== Agent 稳定性增强（v6.6.5，v7.5.0 加二级压缩） ====================
// 1) truncateToolResult：工具结果截断并明确标注，避免模型误以为拿到了完整数据。
// 2) toolCallSignature：工具调用签名，用于"重复调用熔断"。
// 3) trimAgentMessages：上下文预算裁剪，两级策略：
//    第一级（删）——超预算时从最旧的"整轮"（1 条 assistant + 其 tool 消息）开始删，
//                    成对删除保证 OpenAI 消息序列合法（assistant tool_calls 后必须紧跟 tool 应答）。
//    第二级（压）——删完仍超预算，说明是单条巨型结果撑爆的（一次 web_fetch 可达 4000 字，
//                    read_doc 可达 8000 字）。这时整条丢掉会直接丢失关键信息，
//                    改为保留头尾、中间折叠，既压到预算内又不至于让模型答不上来。
//    只动本轮循环产生的消息（loopStartIdx 之后），system 与历史对话永不裁剪；
//    最后一条消息（刚发出 tool_calls 的 assistant）永不改动，否则会破坏工具应答配对。

// 工具结果截断：超长时保留前 maxChars 并标注，避免模型误判为完整数据
// v6.8.7：不在代理对中间切断 —— emoji 等增补平面字符占两个 code unit，
// 切开后会产出两个非法字符，可能污染下游的 JSON 序列化与前端渲染
// v7.5.0：对支持分页的工具（web_fetch / read_doc）把截断点写进提示里。
//   旧文案只说「仅显示前 N 字符」，模型不知道该用 offset=N 续读，往往改成
//   换关键词重搜 —— 明明一次翻页就能拿到，却多烧一整步。
function truncateToolResult(result, maxChars, opts) {
  const s = String(result == null ? '' : result);
  maxChars = maxChars > 0 ? maxChars : 4000;
  if (s.length <= maxChars) return s;
  let cut = maxChars;
  const prev = s.charCodeAt(cut - 1);
  if (prev >= 0xd800 && prev <= 0xdbff) cut -= 1;
  const hint = opts && opts.offsetHint ? '；如需后续内容，请用 offset=' + cut + ' 继续读取' : '';
  return s.slice(0, cut) + '\n…（结果过长，仅显示前 ' + cut + ' 字符' + hint + '）';
}

// 保留头尾、折叠中间。切点同样避开代理对，避免产出半个 emoji。
function compactContent(content, keepHead, keepTail) {
  const s = String(content == null ? '' : content);
  const head = keepHead > 0 ? keepHead : 900;
  const tail = keepTail > 0 ? keepTail : 400;
  if (s.length <= head + tail + 64) return s;
  let headEnd = head;
  const hp = s.charCodeAt(headEnd - 1);
  if (hp >= 0xd800 && hp <= 0xdbff) headEnd -= 1;
  let tailStart = s.length - tail;
  const tp = s.charCodeAt(tailStart);
  if (tp >= 0xdc00 && tp <= 0xdfff) tailStart += 1;
  if (tailStart <= headEnd) return s;
  const omitted = tailStart - headEnd;
  return s.slice(0, headEnd) + '\n…（中间 ' + omitted + ' 字符已折叠，如需细节请用更精确的参数重新查询）…\n' + s.slice(tailStart);
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
  // 裁剪边界：system 与历史对话（[0, start)）永不触碰
  const start = Math.max(0, Math.min(loopStartIdx | 0, arr.length));
  // 估算字符数（JSON 长度近似 token 量的上界）
  const msgLen = (m) => {
    try { return JSON.stringify(m).length; } catch (e) { return 0; }
  };
  let out = arr.slice();
  let lens = out.map(msgLen);
  let total = 0;
  for (let i = 0; i < lens.length; i++) total += lens[i];
  if (total <= budget) return out;

  // ---------- 第一级：从最旧的整轮开始删 ----------
  // 找出本轮循环内的"轮次"边界：每轮以 role=assistant 开头
  const rounds = [];
  let cur = -1;
  for (let i = start; i < out.length; i++) {
    if (out[i] && out[i].role === 'assistant') { cur = rounds.length; rounds.push([i]); }
    else if (cur >= 0) rounds[cur].push(i);
  }
  // 至少保留最后一轮（当前正在进行的上下文）
  const doomed = new Set();
  for (let r = 0; r < rounds.length - 1 && total > budget; r++) {
    for (const i of rounds[r]) { doomed.add(i); total -= lens[i]; }
  }
  if (doomed.size) {
    const kept = [];
    const keptLens = [];
    for (let i = 0; i < out.length; i++) {
      if (!doomed.has(i)) { kept.push(out[i]); keptLens.push(lens[i]); }
    }
    out = kept;
    lens = keptLens;
  }
  if (total <= budget) return out;

  // ---------- 第二级：折叠仍然过长的工具/助手消息 ----------
  // 候选：本轮循环内、除最后一条之外、JSON 长度超过阈值的 tool / assistant 消息。
  // 最后一条必须原样保留 —— 它带着刚发出的 tool_calls，改内容会破坏配对。
  const candidates = [];
  for (let i = start; i < out.length - 1; i++) {
    const m = out[i];
    if (!m || (m.role !== 'tool' && m.role !== 'assistant')) continue;
    if (typeof m.content !== 'string' || !m.content) continue;
    if (lens[i] > 1200) candidates.push(i);
  }
  candidates.sort((a, b) => lens[b] - lens[a]);
  for (const i of candidates) {
    if (total <= budget) break;
    const m = out[i];
    const compacted = compactContent(m.content, 900, 400);
    if (compacted.length >= m.content.length) continue;
    const next = Object.assign({}, m, { content: compacted });
    const nl = msgLen(next);
    if (nl >= lens[i]) continue;
    total -= (lens[i] - nl);
    lens[i] = nl;
    out[i] = next;
  }
  return out;
}

export {
  truncateToolResult,
  compactContent,
  readErrorBody,
  toolCallSignature,
  trimAgentMessages,
};
