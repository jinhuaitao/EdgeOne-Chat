// 上游流式读取：把 SSE 还原成与非流式相同的 message 形状（_worker.js 原第 1346-1466 行）

// ==================== 上游流式读取（Agent 真流式） ====================
// 把上游的 SSE 流还原成与「非流式」完全相同的 message 形状：
//   { content, reasoning, toolCalls, forwarded, imageUrl }
// 这样 Agent 循环里的 tool_calls 判定、DSML 兜底、熔断、工具执行等逻辑一行都不用改，
// 变的只是"怎么拿到 msg"。同时把正文 / 推理增量实时回调出去，实现逐字输出。
//
// 兼容三种上游形态：
//   1. 标准 SSE（data: {...}\n\n … data: [DONE]）—— 主流通道
//   2. 忽略 stream 参数、直接返回完整 JSON —— 走 !sawSSE 兜底
//   3. 图片生成通道 —— 返回 data[0].url
// forwarded 表示"正文是否已经推给客户端"，调用方据此决定要不要再补发一次。
async function readUpstreamMessage(resp, onDelta) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let raw = '';          // 完整原文，供非 SSE 兜底解析
  let buffer = '';       // 行缓冲
  let content = '';
  let reasoning = '';
  let forwarded = false;
  const toolMap = new Map(); // 按 index 合并流式 tool_calls 分片
  let sawSSE = false;
  let sawToolCalls = false;  // 一旦出现工具调用，这一步的后续正文不再外发

  const emit = async (text, kind) => {
    if (!text || typeof onDelta !== 'function') return;
    try { await onDelta(text, kind); } catch (e) {}
    if (kind === 'content') forwarded = true;
  };

  // 返回 true 表示遇到 [DONE]，可以停止读取
  const consumeLine = async (line) => {
    line = line.trim();
    // 空行、以 ':' 开头的注释（含保活行）直接跳过
    if (!line || line.charAt(0) === ':') return false;
    if (line.indexOf('data:') !== 0) return false;
    sawSSE = true;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return true;
    let ev = null;
    try { ev = JSON.parse(payload); } catch (e) { return false; }
    if (ev && ev.error) {
      const err = new Error(ev.error.message || JSON.stringify(ev.error));
      err.name = 'UpstreamSSEError';
      throw err;
    }
    const choice = ev && ev.choices && ev.choices[0];
    if (!choice) return false;
    // 部分通道把完整 message 塞在一个 chunk 里（非增量），delta / message 两种都兼容
    const d = choice.delta || choice.message || {};
    const rc = d.reasoning_content || d.reasoning || '';
    if (rc) { reasoning += rc; await emit(rc, 'reasoning'); }
    // 先处理 tool_calls：一旦这一步确定是工具调用，紧随其后的正文就不再外发，
    // 少一次"先显示再撤回"的闪烁（前面已发出的部分仍由调用方 rollback 收回）
    if (Array.isArray(d.tool_calls) && d.tool_calls.length) {
      sawToolCalls = true;
      for (const tc of d.tool_calls) {
        const idx = typeof tc.index === 'number' ? tc.index : toolMap.size;
        let slot = toolMap.get(idx);
        if (!slot) {
          slot = { id: '', type: 'function', function: { name: '', arguments: '' } };
          toolMap.set(idx, slot);
        }
        if (tc.id) slot.id = tc.id;
        if (tc.type) slot.type = tc.type;
        const fn = tc.function || {};
        // name 只在首个分片里给全，重复出现时不追加；arguments 按规范必须累加
        if (fn.name && !slot.function.name) slot.function.name = fn.name;
        if (fn.arguments) slot.function.arguments += fn.arguments;
      }
    }
    if (d.content) {
      content += d.content;
      if (!sawToolCalls) await emit(d.content, 'content');
    }
    return false;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    raw += chunk;
    // 防 OOM：异常巨大的响应体直接掐断（正常对话远达不到 4MB）
    if (raw.length > 4000000) { try { await reader.cancel(); } catch (e) {} break; }
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    let stop = false;
    for (const line of lines) {
      if (await consumeLine(line)) { stop = true; break; }
    }
    if (stop) { try { await reader.cancel(); } catch (e) {} break; }
  }
  // 收尾：最后一行可能没有换行符
  if (buffer.trim()) {
    try { await consumeLine(buffer); } catch (e) { if (e && e.name === 'UpstreamSSEError') throw e; }
  }

  // 兜底：上游没有按 SSE 返回（部分通道忽略 stream 参数，直接给完整 JSON）
  if (!sawSSE) {
    try {
      const j = JSON.parse(raw);
      if (j && j.data && j.data[0] && j.data[0].url) {
        return { imageUrl: j.data[0].url, content: '', reasoning: '', toolCalls: [], forwarded: false };
      }
      const ch = j && j.choices && j.choices[0];
      const m = ch && (ch.message || ch.delta);
      if (m) {
        return {
          content: m.content || '',
          reasoning: m.reasoning_content || m.reasoning || '',
          toolCalls: m.tool_calls || [],
          forwarded: false
        };
      }
    } catch (e) {}
  }

  const toolCalls = Array.from(toolMap.keys()).sort((a, b) => a - b).map(k => toolMap.get(k));
  return { content, reasoning, toolCalls, forwarded };
}

export {
  readUpstreamMessage,
};
