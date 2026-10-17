// Telegram Agent 主循环：自主规划 → 工具调用 → 汇总作答（_worker.js 原第 1311-1344,1468-1704 行）

import { buildAIRequest, fetchWithKeyRotation, authHeaders } from '../channel.js';
import { parseDSMLToolCalls, stripDSMLBlocks } from './dsml.js';
import { truncateToolResult, readErrorBody, toolCallSignature, trimAgentMessages } from './stability.js';
import { agentLimits, describeToolCall } from './limits.js';
import { agentSaveResumeState } from './resume.js';
import { readUpstreamMessage } from './upstream.js';
import { getAgentTools, execAgentTool } from './tools.js';
import { agentGetMemories } from './memory.js';
import { buildAgentSystemPrompt } from './prompt.js';
import { kbGetRegistry } from '../kb/registry.js';

// 工具结果是否算失败。只认工具层自己的固定前缀，避免正文里偶然出现
// "失败"二字（如新闻标题）被误判，导致正常结果也被当成空转。
function isToolResultFailure(result) {
  const s = String(result == null ? '' : result);
  return /^(搜索失败|搜索请求失败|搜索「[^」]*」无结果|抓取失败|URL 非法|该地址禁止抓取|不支持抓取|计算失败|计算结果非法|单位换算失败|文本工具执行失败|网络查询失败|GitHub 查询失败|GitHub 未找到|arXiv 检索失败|arXiv 未找到|热榜获取失败|时区无效|天气查询失败|找不到城市|汇率查询失败|维基百科查询失败|维基百科未找到|维基百科查询关键词为空|关键词为空|工具执行失败|工具 [^ ]+ 执行超时|未知工具|R2 未绑定|知识库文档写入|记忆写入|内容为空|标题为空|城市名为空|表达式为空|表达式含非法字符)/.test(s);
}

// 步数用尽后的无工具收尾：不再提供 tools，强制模型把已有结果收成最终答案。
// 剩余预算不足 8 秒或上游报错时返回 null，由调用方走原来的暂停 / 已产出兜底。
async function agentWrapUp(env, targetModelId, messages, loopStartIdx, ctxBudget, deadline, onDelta) {
  if (Date.now() > deadline - 8000) return null;
  const sendMessages = trimAgentMessages(messages, loopStartIdx, ctxBudget).concat([{
    role: 'user',
    content: '【系统提示】可用的推理步数已用尽，不能再调用任何工具。请仅根据上面已经拿到的工具结果，直接给出最终答案：先给结论，再说明依据；没查到的部分明确说"未查到"，不要编造，也不要再输出调用计划或工具名。'
  }]);
  const cfg = buildAIRequest(env, targetModelId, sendMessages, true, null);
  if (cfg.error) return null;
  let resp;
  try {
    // 收尾这一枪同样走密钥池轮换：401/402/403/429 时换一个 key 再试，
    // 免得前面几步都跑完了，最后一步因为撞上一个失效 key 而白费。
    const r = await fetchWithKeyRotation(cfg, (key) => ({
      method: 'POST',
      headers: authHeaders(key),
      body: JSON.stringify(cfg.payload),
      signal: AbortSignal.timeout(Math.max(8000, Math.min(60000, deadline - Date.now())))
    }));
    resp = r.resp;
  } catch (e) { return null; }
  if (!resp.ok) { try { await resp.body.cancel(); } catch (e) {} return null; }
  let msg;
  try { msg = await readUpstreamMessage(resp, onDelta); }
  catch (e) { return null; }
  const clean = stripDSMLBlocks(msg.content || '').trim();
  if (!clean) return null;
  if (msg.forwarded && clean === String(msg.content || '').trim()) return { text: clean, streamed: true };
  return { text: clean, streamed: false };
}

function tgAgentDeadline(env, opts) {
  let timeoutMs = agentLimits(env).timeoutMs;
  if (opts && opts.maxRuntimeMs > 0 && opts.maxRuntimeMs < timeoutMs) timeoutMs = opts.maxRuntimeMs;
  return Date.now() + timeoutMs;
}

// 提取消息的纯文本部分（兼容多模态数组 [{type:'text', text:'...'}, {type:'image_url',...}]）
function extractMsgPlainText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(p => p && p.type === 'text' && typeof p.text === 'string')
      .map(p => p.text)
      .join('\n');
  }
  return String(content || '');
}

async function tgAgentChat(env, tgApi, chatId, targetModelId, history, allowTools, onProgress, opts) {
  const query = history.length ? extractMsgPlainText(history[history.length - 1].content) : '';
  const kbReadOnly = !!(opts && opts.kbReadOnly);
  const shouldLoadKb = !!(allowTools || (opts && opts.kbFirst));
  const [memories, kbDocs] = await Promise.all([
    kbReadOnly ? Promise.resolve([]) : agentGetMemories(env, chatId),
    shouldLoadKb ? kbGetRegistry(env).catch(() => null) : Promise.resolve(null),
  ]);
  const systemPrompt = buildAgentSystemPrompt(memories, query, kbDocs, kbReadOnly);
  const tools = allowTools ? getAgentTools(kbReadOnly) : null;
  const messages = [{ role: 'system', content: systemPrompt }];
  for (const m of history) messages.push({ role: m.role, content: m.content });

  const deadline = tgAgentDeadline(env, opts);
  const origUserText = (opts && opts.origUserText) !== undefined ? opts.origUserText : query;
  return await tgAgentRunLoop(env, tgApi, chatId, targetModelId, messages, tools, allowTools, onProgress, deadline,
    (opts && opts.resumeKey) || null, false, undefined,
    (opts && opts.onDelta) || null, (opts && opts.onReset) || null, kbReadOnly, origUserText);
}

// 「继续」入口：messages 里已包含 system + 历史，直接接着跑（仅 Telegram）
async function tgAgentResume(env, tgApi, chatId, saved, onProgress, opts) {
  const allowTools = !!saved.allowTools;
  const tools = allowTools ? getAgentTools() : null;
  const deadline = tgAgentDeadline(env, opts);
  const baseLoopStartIdx = (typeof saved.loopStartIdx === 'number' && saved.loopStartIdx >= 0) ? saved.loopStartIdx : undefined;
  return await tgAgentRunLoop(env, tgApi, chatId, saved.targetModelId, saved.messages, tools, allowTools, onProgress, deadline,
    (opts && opts.resumeKey) || null, true, baseLoopStartIdx,
    (opts && opts.onDelta) || null, (opts && opts.onReset) || null, false, saved.origUserText || '');
}

async function tgAgentRunLoop(env, tgApi, chatId, targetModelId, messages, tools, allowTools, onProgress, deadline, resumeKey, isResume, baseLoopStartIdx, onDelta, onReset, kbReadOnly, origUserText) {
  const maxSteps = agentLimits(env).maxSteps;
  const useUpstreamStream = env.AGENT_STREAM_UPSTREAM !== '0';
  const rollbackStreamed = async (forwarded) => {
    if (!forwarded || typeof onReset !== 'function') return;
    try { await onReset(); } catch (e) {}
  };
  const lastAssistantText = () => {
    const f = [...messages].reverse().find(m => m.role === 'assistant' && m.content);
    return f ? f.content : '';
  };
  const loopStartIdx = (typeof baseLoopStartIdx === 'number' && baseLoopStartIdx >= 0)
    ? Math.min(baseLoopStartIdx, messages.length)
    : messages.length;
  let ctxBudget = parseInt(env.AGENT_CONTEXT_BUDGET || '24000', 10);
  if (!(ctxBudget > 0)) ctxBudget = 24000;
  const pauseForResume = async () => {
    const t = stripDSMLBlocks(lastAssistantText());
    let saved = false;
    if (resumeKey) {
      saved = await agentSaveResumeState(env, chatId, {
        v: 1, savedAt: Date.now(), chatId, targetModelId, allowTools,
        messages: trimAgentMessages(messages, loopStartIdx, ctxBudget),
        loopStartIdx: loopStartIdx,
        origUserText: origUserText || ''
      });
    }
    if (saved) {
      return { text: '⏸️ 任务较长，已暂停并保存进度，发送「继续」让我接着做。' + (t ? '\n\n已产出：\n' + t : ''), usedTools: true, paused: true };
    }
    return { text: '（本次任务超时，已停止）' + (t ? '\n\n' + t : ''), usedTools: true };
  };

  const heartbeat = setInterval(() => {
    try { tgApi('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}); } catch (e) {}
  }, 20000);
  try {
  const callSigHistory = [];
  let toolFailStreak = 0;
  for (let step = 0; step < maxSteps; step++) {
    if (Date.now() > deadline) return await pauseForResume();
    const stepLabel = '🤖 Agent 思考中' + (isResume ? '（继续）' : '') + '（第 ' + (step + 1) + ' 步）…';
    if (typeof onProgress === 'function') {
      try { await onProgress(stepLabel); } catch (e) {}
    }
    try { tgApi('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}); } catch (e) {}

    const sendMessages = trimAgentMessages(messages, loopStartIdx, ctxBudget);
    const cfg = buildAIRequest(env, targetModelId, sendMessages, useUpstreamStream, tools);
    if (cfg.error) return { error: cfg.error };

    let resp;
    try {
      // 密钥池轮换：多 key 时若撞上失效/被限流的 key，自动换一个重试
      // （buildInit 每次尝试都会被重新调用，所以超时信号按当次剩余预算重算）
      const r = await fetchWithKeyRotation(cfg, (key) => ({
        method: 'POST',
        headers: authHeaders(key),
        body: JSON.stringify(cfg.payload),
        signal: AbortSignal.timeout(Math.max(15000, Math.min(180000, deadline - Date.now())))
      }));
      resp = r.resp;
    } catch (e) {
      const nm = e && e.name ? String(e.name) : '';
      const msg = String((e && e.message) || '');
      const aborted = nm === 'AbortError' || nm === 'TimeoutError' || /abort/i.test(msg);
      if (aborted && Date.now() >= deadline - 2000) return await pauseForResume();
      if (aborted) return { error: '上游响应超时，请重试或换个问法' };
      return { error: '网络错误：' + (msg || String(e)) };
    }

    if (!resp.ok) {
      const t = await readErrorBody(resp, 2048);
      if (allowTools && step === 0 &&
          ((resp.status >= 400 && resp.status < 500) || /tool|function|unsupported/i.test(t))) {
        return { fallback: true };
      }
      return { error: 'API 报错 (' + resp.status + ')：' + String(t).slice(0, 500) };
    }

    let msg;
    try {
      msg = await readUpstreamMessage(resp, onDelta);
    } catch (e) {
      const nm = e && e.name ? String(e.name) : '';
      const emsg = String((e && e.message) || '');
      const aborted = nm === 'AbortError' || nm === 'TimeoutError' || /abort/i.test(emsg);
      if (aborted) {
        await rollbackStreamed(true);
        if (Date.now() >= deadline - 2000) return await pauseForResume();
        return { error: '上游响应超时，请重试或换个问法' };
      }
      if (nm === 'UpstreamSSEError') return { error: '上游返回错误：' + emsg };
      return { error: '网络错误：' + (emsg || String(e)) };
    }

    if (msg.imageUrl) {
      return { text: '[🖼️ 点击查看生成的图片](' + msg.imageUrl + ')', usedTools: false, isImage: true };
    }
    if (!msg.content && !msg.toolCalls.length && !msg.reasoning) {
      return { error: 'AI 没有返回有效内容' };
    }

    let toolCalls = msg.toolCalls || [];
    let assistantText = msg.content || '';
    if (!toolCalls.length && assistantText.indexOf('DSML') !== -1) {
      const dsmlCalls = parseDSMLToolCalls(assistantText);
      if (dsmlCalls.length) {
        toolCalls = dsmlCalls;
        assistantText = stripDSMLBlocks(assistantText);
      }
    }
    const assistantMsg = { role: 'assistant', content: assistantText };
    if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
    const reasoning = msg.reasoning || '';
    if (reasoning) assistantMsg.reasoning_content = reasoning;
    messages.push(assistantMsg);

    if (!toolCalls.length) {
      const clean = stripDSMLBlocks(assistantText).trim();
      if (!clean) {
        await rollbackStreamed(msg.forwarded);
        const text = assistantText.indexOf('DSML') !== -1
          ? '（工具调用格式解析失败，已隐藏原始标记，请换个问法重试或切换模型）'
          : (reasoning ? '（模型思考后没有给出文字答复，请换个问法重试）' : '（模型返回了空内容，请换个问法重试）');
        return { text: text, usedTools: step > 0 };
      }
      if (msg.forwarded && clean === assistantText.trim()) {
        return { text: clean, usedTools: step > 0, streamed: true };
      }
      await rollbackStreamed(msg.forwarded);
      return { text: clean, usedTools: step > 0 };
    }

    const stepSig = toolCalls.map(toolCallSignature).sort().join(';;');
    callSigHistory.push(stepSig);
    if (callSigHistory.length >= 3 &&
        callSigHistory[callSigHistory.length - 1] === stepSig &&
        callSigHistory[callSigHistory.length - 2] === stepSig &&
        callSigHistory[callSigHistory.length - 3] === stepSig) {
      await rollbackStreamed(msg.forwarded);
      const prefix = stripDSMLBlocks(assistantText).trim();
      return { text: (prefix ? prefix + '\n\n' : '') + '（检测到重复调用同一工具，已停止以避免空转；请换个问法或补充信息后重试）', usedTools: true };
    }

    await rollbackStreamed(msg.forwarded);

    if (typeof onProgress === 'function') {
      try {
        const descs = toolCalls.map(tc => {
          const fn = (tc && tc.function) || {};
          let a = {};
          try { a = JSON.parse(fn.arguments || '{}'); } catch (e) {}
          return describeToolCall(fn.name || 'unknown', a);
        });
        await onProgress(stepLabel + '\n' + descs.join('\n'), true);
      } catch (e) {}
    }

    // 并发度控制（上限 4）+ 同批次同参去重：避免单轮大量工具调用打满连接或重复执行
    const MAX_CONCURRENT_TOOLS = 4;
    const toolResults = new Array(toolCalls.length);
    const stepDedup = new Map();
    let cursor = 0;
    const workers = Array.from({ length: Math.min(MAX_CONCURRENT_TOOLS, toolCalls.length) }, async () => {
      while (cursor < toolCalls.length) {
        const idx = cursor++;
        const tc = toolCalls[idx];
        const fn = (tc && tc.function) || {};
        let args = {};
        try { args = JSON.parse(fn.arguments || '{}'); } catch (e) {}
        if (!fn.name) {
          toolResults[idx] = { tc, result: '工具调用缺少名称，已跳过', failed: true };
          continue;
        }
        const sig = toolCallSignature(tc);
        let p = stepDedup.get(sig);
        if (!p) {
          p = execAgentTool(fn.name, args, env, chatId, kbReadOnly);
          stepDedup.set(sig, p);
        }
        const result = await p;
        toolResults[idx] = { tc, result: truncateToolResult(result, 4000), failed: isToolResultFailure(result) };
      }
    });
    await Promise.all(workers);
    let stepFailed = 0;
    for (const tr of toolResults) {
      const fn = (tr.tc && tr.tc.function) || {};
      messages.push({
        role: 'tool',
        tool_call_id: tr.tc.id,
        name: fn.name || 'unknown',
        content: tr.result
      });
      if (tr.failed) stepFailed += 1;
    }
    if (toolResults.length && stepFailed === toolResults.length) toolFailStreak += 1;
    else toolFailStreak = 0;
    if (toolFailStreak >= 2) {
      messages.push({
        role: 'user',
        content: '【系统提示】最近的工具调用连续失败。请换关键词、换工具或换思路；若已无法取得更多信息，请基于已有结果直接给出最终答案，并明确说明哪些信息没查到。不要再用相同参数重复调用。'
      });
    }
  }
  } finally {
    clearInterval(heartbeat);
  }
  const wrapUp = await agentWrapUp(env, targetModelId, messages, loopStartIdx, ctxBudget, deadline, onDelta);
  if (wrapUp && wrapUp.text) return { text: wrapUp.text, usedTools: true, streamed: !!wrapUp.streamed };
  const t = stripDSMLBlocks(lastAssistantText());
  if (resumeKey) {
    const saved = await agentSaveResumeState(env, chatId, {
      v: 1, savedAt: Date.now(), chatId, targetModelId, allowTools,
      messages: trimAgentMessages(messages, loopStartIdx, ctxBudget),
      loopStartIdx: loopStartIdx,
      origUserText: origUserText || ''
    });
    if (saved) {
      return { text: '⏸️ 推理步数已用尽，进度已保存，发送「继续」让我接着做。' + (t ? '\n\n已产出：\n' + t : ''), usedTools: true, paused: true };
    }
  }
  return { text: t || '（思考步数已用尽，请换个问法重试）', usedTools: true };
}

export {
  isToolResultFailure,
  extractMsgPlainText,
  tgAgentDeadline,
  tgAgentChat,
  tgAgentResume,
  tgAgentRunLoop,
};
