// Agent 稳定性增强：结果截断、调用签名、上下文预算裁剪与压缩

// ==================== Agent 稳定性增强（v6.6.5，v7.5.0 加二级压缩） ====================
// 1) truncateToolResult：工具结果截断并明确标注，避免模型误以为拿到了完整数据。
// 2) toolCallSignature：工具调用签名，用于"重复调用熔断"。
// 3) trimAgentMessages：上下文预算裁剪，两级策略：
//    第一级（压）——超预算时先把「本轮循环内的旧消息」折叠成「头 + 尾」（compactContent），
//                    只改 content、不动 role/tool_call_id，工具应答配对不会被破坏。
//    第二级（删）——折叠完仍超预算（轮次太多，不是单条太大），才从最旧的"整轮"开始删，
//                    成对删除保证 OpenAI 消息序列合法（assistant tool_calls 后必须紧跟 tool 应答）。
//    v7.9.0 把「删」和「压」的顺序对调了。旧实现先删后压，后果很具体：
//    用户问「对比这三篇文档」，3 次 read_doc（各 8500 字）会把最早那篇整段删掉，
//    模型手里只剩最后一篇——答案看起来完整，其实只比了一篇。折叠优先则三篇都在，
//    只是每篇被压成 900+400 字，对比类任务至少能看到三篇的结论与要点。
//    只动本轮循环产生的消息（loopStartIdx 之后），system 与历史对话永不裁剪；
//    最后一条消息永不改动，否则会破坏工具应答配对。

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
  budget = budget > 0 ? budget : 28000;
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

  // ---------- 第一级：折叠（保住「存在性」，只压体积） ----------
  // 候选：本轮循环内、除最后一条之外、内容够长的 tool / assistant 消息。
  // 最后一条必须原样保留 —— 它带着刚发出的 tool_calls，改内容会破坏配对。
  const foldCandidates = () => {
    const idx = [];
    for (let i = start; i < out.length - 1; i++) {
      const m = out[i];
      if (!m || (m.role !== 'tool' && m.role !== 'assistant')) continue;
      if (typeof m.content !== 'string' || m.content.length < 400) continue;
      idx.push(i);
    }
    // 先折叠最长的：同样的压缩量，损失的可读内容最少
    idx.sort((a, b) => lens[b] - lens[a]);
    return idx;
  };
  const foldPass = (keepHead, keepTail) => {
    for (const i of foldCandidates()) {
      if (total <= budget) break;
      const m = out[i];
      const compacted = compactContent(m.content, keepHead, keepTail);
      if (compacted.length >= m.content.length) continue;
      const next = Object.assign({}, m, { content: compacted });
      const nl = msgLen(next);
      if (nl >= lens[i]) continue;
      total -= (lens[i] - nl);
      lens[i] = nl;
      out[i] = next;
    }
  };
  // 两档：先温和（900/400，够看清结论），不够再激进（400/150，只留头尾关键词）
  foldPass(900, 400);
  if (total <= budget) return out;
  foldPass(400, 150);
  if (total <= budget) return out;

  // ---------- 第二级：折叠后仍超预算（轮次太多）才删最旧的整轮 ----------
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
  return out;
}

export {
  truncateToolResult,
  compactContent,
  readErrorBody,
  toolCallSignature,
  trimAgentMessages,
};
