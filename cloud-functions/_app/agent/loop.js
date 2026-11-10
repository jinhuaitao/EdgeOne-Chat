// Agent 主循环：自主规划 → 工具调用 → 汇总作答（Telegram / Web / 微信共用）
//
// v7.5.0 精修要点（都是在真机上踩过的坑，不是纸面优化）：
//   1) 时间预算治理：工具超时与上游超时都随「剩余预算」收缩，并给收尾预留固定额度。
//      旧实现里工具固定 30 秒、上游至少 15 秒，与整体 deadline 无关 —— 预算只剩 5 秒
//      时仍会傻等，最后函数被平台在 120 秒处掐断，断点状态没写进去，用户既没答案
//      也不能「继续」。现在任何一步开跑前都先扣掉收尾预留，收尾那一枪一定打得出去。
//   2) 超时也给结论：Web 端没有「继续」入口，旧实现到点直接把半截推理甩给用户；
//      现在先用剩余预算做一次「不许调工具、只许总结」的收尾请求。
//   3) 跨步重复调用熔断：同工具同参数本轮第 3 次跳过执行、第 4 次收尾。
//      旧实现只防「连续三次完全相同」，A/B/A/B 交替打转能耗光全部步数。
//   4) 无新信息检测：整步结果与之前完全一致（含缓存命中）时累计，连续 3 步收尾。
//   5) 非法 JSON 参数不执行：直接回一条可纠正的提示，而不是带空参数跑一遍工具。
//   6) 每轮统计：步数 / 工具数 / 失败数 / 耗时 / 停止原因，供 /healthz 排障与调参。

import { buildAIRequest, fetchWithKeyRotation, authHeaders } from '../channel.js';
import { parseDSMLToolCalls, stripDSMLBlocks } from './dsml.js';
import { truncateToolResult, readErrorBody, toolCallSignature, trimAgentMessages } from './stability.js';
import { isToolFailure, toolResultDigest } from './result.js';
import { agentLimits, describeToolCall, toolBudgetMs, upstreamTimeoutMs, toolResultMax } from './limits.js';
import { agentSaveResumeState } from './resume.js';
import { readUpstreamMessage } from './upstream.js';
import { getAgentTools, execAgentTool, getAgentToolCacheStats } from './tools.js';
import { agentGetMemories } from './memory.js';
import { getWorking, getEpisodes, pickRelevantEpisodes, recordTurnMemory, layersEnabled } from './memory-layers.js';
import { buildAgentSystemPrompt, buildPromptToolManual } from './prompt.js';
import { buildAccuracyHint, precomputeArithmetic } from './accuracy.js';
import { kbGetRegistry } from '../kb/registry.js';
import { kbPrefetch } from '../kb/prefetch.js';

// 同一工具 + 同一参数，本轮累计「成功执行」到第 3 次就不再执行（结果必然一样），第 4 次直接收尾。
// 只数成功次数：失败不占名额（v7.9.0），否则网络抖一下、重试两次就被判成原地打转。
const REPEAT_SKIP_AT = 3;
const REPEAT_STOP_AT = 4;
// 连续几步「没有任何新信息」就收尾
const NO_PROGRESS_STOP = 3;
// 每轮最多插入几条系统提示，避免提示本身把上下文撑爆
const MAX_HINTS = 3;
// 记录多少条已见结果指纹（防 isolate 常驻内存无限增长）
const RESULT_MEMORY_MAX = 240;

// 工具结果是否算失败。判定逻辑收敛在 result.js（与工具缓存共用同一份事实源），
// 这里保留同名导出，供老调用方与自检脚本继续使用。
function isToolResultFailure(result) {
  return isToolFailure(result);
}

// ==================== 每轮统计（供 /healthz 排障与调参） ====================
const turnStats = {
  turns: 0,
  stepsTotal: 0,
  toolCallsTotal: 0,
  failedTotal: 0,
  pausedTurns: 0,
  timedOutTurns: 0,
  promptCharsTotal: 0,
  promptTokensTotal: 0,
  completionTokensTotal: 0,
  // v7.10.2：确定性算式预计算的采纳率 —— 判断准确率增强是否真的落到答案里。
  arithmeticHintedTotal: 0,
  arithmeticAdoptedTotal: 0,
  lastStopReason: '',
  lastElapsedMs: 0,
};

function newTurnStats() {
  return {
    startedAt: Date.now(), steps: 0, toolCalls: 0, failed: 0, skipped: 0, stopReason: '',
    // v7.9.0：promptChars = 最近一步真实发出的请求体字符数（含工具定义），
    // 用来暴露「配置的上下文预算 ≠ 实际 prompt 体积」这个盲区。
    promptChars: 0,
    // 上游给了 usage 才累加（部分通道不回传，保持 0 比编一个数字诚实）
    promptTokens: 0, completionTokens: 0,
    // v7.10.0：本轮用过哪些工具、存过哪些文档 —— 情景记忆的「线索」，
    // 让以后能回答「上次我们是查了哪些资料才定的」。
    toolNames: [], docTitles: [],
    arithmeticHinted: 0, arithmeticAdopted: 0,
  };
}

function commitTurnStats(stats, r) {
  try {
    const elapsedMs = Date.now() - (stats.startedAt || Date.now());
    const stopReason = (r && r.stopReason)
      || (r && r.paused ? 'paused'
        : r && r.error ? 'error'
          : r && r.fallback ? 'fallback' : 'done');
    turnStats.turns += 1;
    turnStats.stepsTotal += stats.steps || 0;
    turnStats.toolCallsTotal += stats.toolCalls || 0;
    turnStats.failedTotal += stats.failed || 0;
    turnStats.promptCharsTotal += stats.promptChars || 0;
    turnStats.promptTokensTotal += stats.promptTokens || 0;
    turnStats.completionTokensTotal += stats.completionTokens || 0;
    turnStats.arithmeticHintedTotal += stats.arithmeticHinted || 0;
    turnStats.arithmeticAdoptedTotal += stats.arithmeticAdopted || 0;
    if (r && r.paused) turnStats.pausedTurns += 1;
    if (stopReason === 'time_budget') turnStats.timedOutTurns += 1;
    turnStats.lastStopReason = stopReason;
    turnStats.lastElapsedMs = elapsedMs;
    if (r && typeof r === 'object') {
      r.stats = {
        steps: stats.steps || 0,
        toolCalls: stats.toolCalls || 0,
        failed: stats.failed || 0,
        skipped: stats.skipped || 0,
        elapsedMs,
        stopReason,
        promptChars: stats.promptChars || 0,
        promptTokens: stats.promptTokens || 0,
        completionTokens: stats.completionTokens || 0,
        arithmeticHinted: stats.arithmeticHinted || 0,
        arithmeticAdopted: stats.arithmeticAdopted || 0,
      };
    }
  } catch (e) {}
}

function agentTurnStats() {
  const t = turnStats;
  const avg = (n) => (t.turns > 0 ? Math.round((n / t.turns) * 100) / 100 : 0);
  let cache = null;
  try { cache = getAgentToolCacheStats(); } catch (e) {}
  return {
    turns: t.turns,
    avgSteps: avg(t.stepsTotal),
    avgToolCalls: avg(t.toolCallsTotal),
    avgFailed: avg(t.failedTotal),
    pausedTurns: t.pausedTurns,
    timedOutTurns: t.timedOutTurns,
    // 每轮平均 prompt 体积（含工具定义）与累计 token —— 调预算/换模型时看这两个数
    avgPromptChars: avg(t.promptCharsTotal),
    promptTokens: t.promptTokensTotal,
    completionTokens: t.completionTokensTotal,
    // 只统计「注入过预计算结果」的那些轮：0 命中时返回 null，避免和「全部答错」混淆。
    arithmeticHinted: t.arithmeticHintedTotal,
    arithmeticAdoptRate: t.arithmeticHintedTotal > 0
      ? Math.round((t.arithmeticAdoptedTotal / t.arithmeticHintedTotal) * 100) / 100
      : null,
    lastStopReason: t.lastStopReason || '',
    lastElapsedMs: t.lastElapsedMs,
    cache,
  };
}

function __resetAgentTurnStats() {
  turnStats.turns = 0;
  turnStats.stepsTotal = 0;
  turnStats.toolCallsTotal = 0;
  turnStats.failedTotal = 0;
  turnStats.pausedTurns = 0;
  turnStats.timedOutTurns = 0;
  turnStats.promptCharsTotal = 0;
  turnStats.promptTokensTotal = 0;
  turnStats.completionTokensTotal = 0;
  turnStats.arithmeticHintedTotal = 0;
  turnStats.arithmeticAdoptedTotal = 0;
  turnStats.lastStopReason = '';
  turnStats.lastElapsedMs = 0;
}

// 收尾提示按「为什么停下来」区分措辞：模型知道真实原因，才不会瞎猜自己是被打断还是被限流
function wrapUpNote(reason) {
  const why = reason === 'time_budget'
    ? '本次推理的时间预算已用尽'
    : reason === 'no_progress'
      ? '工具已经无法提供更多新信息（继续调用只会得到同样的结果）'
      : reason === 'repeat'
        ? '工具调用在原地重复（同样的工具与参数已经调过多次，结果不会变）'
        : '可用的推理步数已用尽';
  return '【系统提示】' + why + '，不能再调用任何工具。请仅根据上面已经拿到的工具结果，直接给出最终答案：'
    + '先给结论，再说明依据；没查到的部分明确说"未查到"，不要编造，也不要再输出调用计划或工具名。';
}

// 步数用尽 / 时间耗尽后的无工具收尾：不再提供 tools，强制模型把已有结果收成最终答案。
// 剩余预算不足 3 秒或上游报错时返回 null，由调用方走原来的暂停 / 已产出兜底。
async function agentWrapUp(env, targetModelId, messages, loopStartIdx, ctxBudget, deadline, onDelta, reason) {
  if (deadline - Date.now() < 3000) return null;
  const sendMessages = trimAgentMessages(messages, loopStartIdx, ctxBudget)
    .concat([{ role: 'user', content: wrapUpNote(reason) }]);
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
      // v7.5.0：收尾请求的超时也必须跟着剩余预算走。旧实现 Math.max(8000, ...)
      // 会在只剩 2 秒时硬等 8 秒，把函数一起拖过平台上限。
      signal: AbortSignal.timeout(upstreamTimeoutMs(deadline, Date.now(), { floorMs: 2500, capMs: 60000 }))
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

// 一轮结束后写回 L1/L2。三道保险，缺一不可：
//   1) 只有拿到最终答案才写（error / fallback 不写，否则记忆里会留下半截对话）；
//   2) 最多等 0.8 秒 —— 记忆是增强项，不能为了记一条摘要让用户多等；
//   3) 失败只计数，不抛错（Blob 抖动时用户依然应该看到完整回答）。
async function recordTurnMemorySafe(env, chatId, turn, opts) {
  try {
    const job = recordTurnMemory(env, chatId, turn, opts);
    const timeout = new Promise(resolve => setTimeout(() => resolve({ ok: false, reason: 'timeout' }), 800));
    return await Promise.race([job, timeout]);
  } catch (e) {
    return { ok: false, reason: 'error' };
  }
}

async function tgAgentChat(env, tgApi, chatId, targetModelId, history, allowTools, onProgress, opts) {
  const query = history.length ? extractMsgPlainText(history[history.length - 1].content) : '';
  const kbReadOnly = !!(opts && opts.kbReadOnly);
  const shouldLoadKb = !!(allowTools || (opts && opts.kbFirst));
  // deadline 必须在预检索之前算：预检索本身也要花时间（默认上限 2.5 秒），
  // 算在 deadline 之后等于「预算外白送 2.5 秒」，Web 端的 90 秒承诺就会变成 92.5 秒。
  const deadline = tgAgentDeadline(env, opts);
  // 三层记忆（v7.10.0）：
  //   L3 语义记忆在旧实现里是「kbReadOnly 就不读」——于是 Web 端完全没有记忆，
  //   连用户自己刚说过的话都不记得。现在读写分开：读由 memoryRead 控制（Web 也读），
  //   写由 memoryWrite / kbReadOnly 控制（Web 仍不允许用工具写长期事实）。
  const memScope = (opts && opts.memoryScope) || chatId;
  const memRead = layersEnabled(env) && !(opts && opts.memoryRead === false);
  const layeredOn = layersEnabled(env) && !(opts && opts.memoryLayers === false);
  const [memories, kbDocs, workMem, episodes] = await Promise.all([
    memRead ? agentGetMemories(env, memScope).catch(() => []) : Promise.resolve([]),
    shouldLoadKb ? kbGetRegistry(env).catch(() => null) : Promise.resolve(null),
    layeredOn ? getWorking(env, chatId).catch(() => null) : Promise.resolve(null),
    layeredOn ? getEpisodes(env, memScope).catch(() => []) : Promise.resolve([]),
  ]);
  // v7.7.0：预检索。只注入标题列表时，模型仍可能「看了标题就凭知识库作答」，
  // 或者先花一步 search_docs 才摸到正文。这里在进入循环前直接把最相关的 2 段正文
  // 取出来放进提示词，Web 端（含关闭 Agent 的普通对话）都能第一时间用上知识库。
  // 预检索自带预算与跳过规则，失败一律静默降级（不影响正常回答）。
  let kbPrefetchText = '';
  if (shouldLoadKb && opts && opts.kbPrefetch) {
    // 预检索也受总预算约束：剩余时间不足 4 秒就干脆不查，把时间留给作答与收尾。
    const reserveMs = agentLimits(env).wrapupReserveMs || 12000;
    const remainMs = deadline - Date.now() - reserveMs;
    if (remainMs > 4000) {
      if (onProgress) { try { await onProgress('📚 正在优先检索知识库…'); } catch (e) {} }
      const wantBudget = opts.kbPrefetchBudgetMs > 0 ? opts.kbPrefetchBudgetMs : 2500;
      const pre = await kbPrefetch(env, query, {
        budgetMs: Math.min(wantBudget, remainMs),
        topN: opts.kbPrefetchTopN,
      }).catch(() => null);
      if (pre && pre.ok) kbPrefetchText = pre.text;
    }
  }
  // L2 情景记忆只挑与本次提问相关的几条注入（最多 3 条），不做全量回放：
  // 情景记忆一多，全量塞进去会把真正的用户问题挤到上下文深处。
  const layered = layeredOn
    ? { work: workMem, episodes: pickRelevantEpisodes(episodes, query, 3), budget: opts && opts.memoryInjectChars }
    : null;
  let systemPrompt = buildAgentSystemPrompt(memories, query, kbDocs, kbReadOnly, kbPrefetchText, layered);
  // v7.10.2：本轮准确性约束（确定性算式预计算 + 按提问意图生成的一轮性规则）。
  // allowTools=false 的纯聊天 / 降级轮不注入「必须调工具」类指令，只保留已核验结果与诚实要求。
  // AGENT_ACCURACY_HINT=0 可整体关闭，便于 A/B 对比这项增强的真实收益。
  const accuracyOn = String((env && env.AGENT_ACCURACY_HINT) || '1') !== '0';
  const precomputed = accuracyOn ? precomputeArithmetic(query) : [];
  if (accuracyOn) {
    systemPrompt += buildAccuracyHint(query, { toolsAvailable: !!allowTools, precomputed });
  }
  // 降级模式：通道 400 拒绝 tools 参数时，把工具清单与调用格式写进提示词，
  // 由模型用 DSML 文本格式发起调用（loop 里原本就有 DSML 解析，这里只是让它有输入）。
  // 旧实现遇到这种通道直接 allowTools=false —— 用户拿到的是一个"没有工具"的答案，
  // 而且没有任何提示说明能力被砍掉了。
  if (allowTools && opts && opts.promptTools) {
    systemPrompt += buildPromptToolManual(getAgentTools(kbReadOnly));
  }
  const tools = allowTools ? getAgentTools(kbReadOnly) : null;
  const messages = [{ role: 'system', content: systemPrompt }];
  for (const m of history) messages.push({ role: m.role, content: m.content });

  const origUserText = (opts && opts.origUserText) !== undefined ? opts.origUserText : query;
  const stats = newTurnStats();
  const r = await tgAgentRunLoop(env, tgApi, chatId, targetModelId, messages, tools, allowTools, onProgress, deadline,
    (opts && opts.resumeKey) || null, false, undefined,
    (opts && opts.onDelta) || null, (opts && opts.onReset) || null, kbReadOnly, origUserText, stats,
    !!(opts && opts.promptTools), memScope);
  // 不改答案，只记录「预计算结果有没有被模型采纳」—— 这是准确率增强的可观测指标。
  if (precomputed.length && !(r && r.fallback) && !(r && r.error)) {
    const answer = String((r && r.text) || '');
    stats.arithmeticHinted = precomputed.length;
    stats.arithmeticAdopted = precomputed.filter((x) => answer.indexOf(x.value) !== -1).length;
  }
  // fallback 表示「这个通道不支持 tools」，会立刻用不带工具的方式重跑一遍；
  // 那一轮不计入统计，否则 avgSteps 会被一堆 0 步的降级轮稀释。
  if (!(r && r.fallback)) commitTurnStats(stats, r);
  // v7.10.0：写回三层记忆的 L1（工作记忆）与 L2（情景记忆）。
  // 放在这里而不是 handler 里：三条通道（TG / Web / 微信）都走这个函数，
  // 写回逻辑只有一份，不会出现「微信记得、Web 不记得」这种各端不一致。
  if (!(r && r.fallback) && !(r && r.error) && !(opts && opts.memoryWrite === false)) {
    await recordTurnMemorySafe(env, chatId, {
      userText: origUserText,
      assistantText: (r && r.text) || '',
      tools: stats.toolNames || [],
      docs: stats.docTitles || [],
      paused: !!(r && r.paused),
      stopReason: (r && r.stopReason) || '',
    }, { episodeScope: memScope });
  }
  return r;
}

// 「继续」入口：messages 里已包含 system + 历史，直接接着跑（仅 Telegram）
async function tgAgentResume(env, tgApi, chatId, saved, onProgress, opts) {
  const allowTools = !!saved.allowTools;
  const tools = allowTools ? getAgentTools() : null;
  const deadline = tgAgentDeadline(env, opts);
  const baseLoopStartIdx = (typeof saved.loopStartIdx === 'number' && saved.loopStartIdx >= 0) ? saved.loopStartIdx : undefined;
  const stats = newTurnStats();
  const r = await tgAgentRunLoop(env, tgApi, chatId, saved.targetModelId, saved.messages, tools, allowTools, onProgress, deadline,
    (opts && opts.resumeKey) || null, true, baseLoopStartIdx,
    (opts && opts.onDelta) || null, (opts && opts.onReset) || null, false, saved.origUserText || '', stats,
    !!(saved.promptTools || (opts && opts.promptTools)), (opts && opts.memoryScope) || chatId);
  commitTurnStats(stats, r);
  return r;
}

async function tgAgentRunLoop(env, tgApi, chatId, targetModelId, messages, tools, allowTools, onProgress, deadline, resumeKey, isResume, baseLoopStartIdx, onDelta, onReset, kbReadOnly, origUserText, stats, promptTools, memScope) {
  const limits = agentLimits(env);
  const maxSteps = limits.maxSteps;
  // 收尾预留：循环内所有「还能不能再跑一步」的判断都用 deadline - reserve
  const reserve = limits.wrapupReserveMs;
  const ctxBudget = (() => {
    // v7.9.0：默认 24000 → 28000。24000 是「消息字符数」，不含每步都要发的工具定义
    // （约 7.5k）与系统提示词，实际 prompt 会到 35k+；多篇文档一读就被迫裁剪。
    // 真实体积见 /healthz 的 debug.agent.avgPromptChars。
    const v = parseInt(env.AGENT_CONTEXT_BUDGET || '28000', 10);
    return v > 0 ? v : 28000;
  })();
  const useUpstreamStream = env.AGENT_STREAM_UPSTREAM !== '0';
  // 统计对象可能是调用方传进来的空壳，补齐默认字段（否则 += 会得到 NaN）。
  // 注意要就地补齐而不是新建对象：调用方要靠这个对象读到本轮统计。
  if (!stats || typeof stats !== 'object') {
    stats = newTurnStats();
  } else {
    const defaults = newTurnStats();
    for (const k of Object.keys(defaults)) {
      if (typeof stats[k] !== 'number') stats[k] = defaults[k];
    }
  }

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

  const saveResume = async () => {
    if (!resumeKey) return false;
    return await agentSaveResumeState(env, chatId, {
      v: 1, savedAt: Date.now(), chatId, targetModelId, allowTools,
      messages: trimAgentMessages(messages, loopStartIdx, ctxBudget),
      loopStartIdx: loopStartIdx,
      origUserText: origUserText || '',
      // 续做时保持同样的工具模式：降级通道不能因为「继续」又变回原生 tools
      promptTools: !!promptTools
    });
  };

  const pauseForResume = async (reason) => {
    const t = stripDSMLBlocks(lastAssistantText());
    const saved = await saveResume();
    if (saved) {
      return {
        text: '⏸️ 任务较长，已暂停并保存进度，发送「继续」让我接着做。' + (t ? '\n\n已产出：\n' + t : ''),
        usedTools: true, paused: true, stopReason: reason || 'time_budget'
      };
    }
    return { text: '（本次任务超时，已停止）' + (t ? '\n\n' + t : ''), usedTools: true, stopReason: reason || 'time_budget' };
  };

  // 预算耗尽时的统一出口：
  //   Telegram 有「继续」入口 → 存档等续做；
  //   Web / 微信一次性通道 → 用剩余预算收尾成一段完整答案，而不是甩半截推理。
  const finishByTimeout = async (reason) => {
    stats.stopReason = reason || 'time_budget';
    if (resumeKey) return await pauseForResume(stats.stopReason);
    const w = await agentWrapUp(env, targetModelId, messages, loopStartIdx, ctxBudget, deadline, onDelta, stats.stopReason);
    if (w && w.text) return { text: w.text, usedTools: true, streamed: !!w.streamed, stopReason: stats.stopReason };
    const t = stripDSMLBlocks(lastAssistantText()).trim();
    return {
      text: (t ? t + '\n\n' : '') + '（本次推理已到时间上限，以上是已经查到的部分。把问题拆小一点再问，会更容易一次答完。）',
      usedTools: true, stopReason: stats.stopReason
    };
  };

  const heartbeat = setInterval(() => {
    try { tgApi('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}); } catch (e) {}
  }, 20000);
  try {
  // 跨步去重与防呆状态
  const sigSuccess = new Map();     // 工具签名 → 本轮「成功执行」次数（失败不计，见下方注释）
  const seenResults = new Set();    // 已见结果指纹
  const recentBatches = [];         // 最近两步的调用批次：{ sig, failed }（判「连续原地打转」）
  let noProgressStreak = 0;
  let failStreak = 0;
  let totalFailed = 0;
  let hintsSent = 0;
  const pushHint = (text) => {
    if (hintsSent >= MAX_HINTS) return;
    // 同样的提示只插一次，避免自己把上下文刷满
    if (messages.some(m => m.role === 'user' && m.content === text)) return;
    hintsSent += 1;
    messages.push({ role: 'user', content: text });
  };

  for (let step = 0; step < maxSteps; step++) {
    if (Date.now() > deadline - reserve) return await finishByTimeout('time_budget');
    if (deadline - Date.now() < 3000) return await finishByTimeout('time_budget');
    // 真正开跑才算一步：上面两个预算判断可能直接返回，不该虚报步数
    stats.steps = step + 1;

    const stepLabel = '🤖 Agent 思考中' + (isResume ? '（继续）' : '') + '（第 ' + (step + 1) + ' 步）…';
    if (typeof onProgress === 'function') {
      try { await onProgress(stepLabel); } catch (e) {}
    }
    try { tgApi('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}); } catch (e) {}

    const sendMessages = trimAgentMessages(messages, loopStartIdx, ctxBudget);
    // promptTools 是「通道不收 tools 参数」时的降级模式：工具清单写进提示词，
    // 由模型用 DSML 文本格式发起调用，请求体里不再带 tools 字段。
    const cfg = buildAIRequest(env, targetModelId, sendMessages, useUpstreamStream, promptTools ? null : tools);
    if (cfg.error) return { error: cfg.error };
    // 真实 prompt 体积（含工具定义）：AGENT_CONTEXT_BUDGET 只管消息，
    // 不算这一项的话，运维看到的预算和实际发出去的 prompt 差着好几千字符
    try { stats.promptChars = JSON.stringify(cfg.payload).length; } catch (e) {}

    let resp;
    try {
      // 密钥池轮换：多 key 时若撞上失效/被限流的 key，自动换一个重试
      // （buildInit 每次尝试都会被重新调用，所以超时信号按当次剩余预算重算）
      const r = await fetchWithKeyRotation(cfg, (key) => ({
        method: 'POST',
        headers: authHeaders(key),
        body: JSON.stringify(cfg.payload),
        signal: AbortSignal.timeout(upstreamTimeoutMs(deadline, Date.now()))
      }));
      resp = r.resp;
    } catch (e) {
      const nm = e && e.name ? String(e.name) : '';
      const msg = String((e && e.message) || '');
      const aborted = nm === 'AbortError' || nm === 'TimeoutError' || /abort/i.test(msg);
      if (aborted && Date.now() >= deadline - reserve) return await finishByTimeout('time_budget');
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
        if (Date.now() >= deadline - reserve) return await finishByTimeout('time_budget');
        return { error: '上游响应超时，请重试或换个问法' };
      }
      if (nm === 'UpstreamSSEError') return { error: '上游返回错误：' + emsg };
      return { error: '网络错误：' + (emsg || String(e)) };
    }
    // token 用量：上游回传就累加，不回传就保持 0（不估算，估算出来的数字更误导人）
    if (msg && msg.usage) {
      const u = msg.usage;
      if (u.prompt_tokens > 0) stats.promptTokens += u.prompt_tokens;
      if (u.completion_tokens > 0) stats.completionTokens += u.completion_tokens;
    }

    if (msg.imageUrl) {
      return { text: '[🖼️ 点击查看生成的图片](' + msg.imageUrl + ')', usedTools: false, isImage: true, stopReason: 'image' };
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
        return { text: text, usedTools: step > 0, stopReason: 'empty' };
      }
      if (msg.forwarded && clean === assistantText.trim()) {
        return { text: clean, usedTools: step > 0, streamed: true, stopReason: 'done' };
      }
      await rollbackStreamed(msg.forwarded);
      return { text: clean, usedTools: step > 0, stopReason: 'done' };
    }

    // 连续三次完全相同的调用：早就该停了，不必等到步数耗尽。
    // v7.9.0：只对「前两次都成功」的批次生效。失败后重试是最该鼓励的行为，
    // 旧实现把三次失败的重试也判成「原地打转」，用户明明只是网络抖了一下。
    const stepSig = toolCalls.map(toolCallSignature).sort().join(';;');
    const prev1 = recentBatches.length >= 1 ? recentBatches[recentBatches.length - 1] : null;
    const prev2 = recentBatches.length >= 2 ? recentBatches[recentBatches.length - 2] : null;
    if (prev1 && prev2 && prev1.sig === stepSig && prev2.sig === stepSig && !prev1.failed && !prev2.failed) {
      await rollbackStreamed(msg.forwarded);
      const prefix = stripDSMLBlocks(assistantText).trim();
      stats.stopReason = 'repeat';
      return { text: (prefix ? prefix + '\n\n' : '') + '（检测到重复调用同一工具，已停止以避免空转；请换个问法或补充信息后重试）', usedTools: true, stopReason: 'repeat' };
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

    // 并发度控制 + 同批次同参去重：避免单轮大量工具调用打满连接或重复执行
    const MAX_CONCURRENT_TOOLS = limits.toolConcurrency;
    // 本批次工具最多用掉「剩余预算 - 收尾预留」，绝不把收尾时间吃光
    const batchBudget = toolBudgetMs(limits, deadline);
    const toolResults = new Array(toolCalls.length);
    const stepDedup = new Map();
    // 同一批次里的同参调用只算一次「调用次数」：stepDedup 会把它们合并成一次执行，
    // 若按条累加，模型一次性并行发 4 个相同调用就会被误判成「已重复 4 次」直接熔断。
    const batchSigSeen = new Set();
    let cursor = 0;
    const workers = Array.from({ length: Math.min(MAX_CONCURRENT_TOOLS, toolCalls.length) }, async () => {
      while (cursor < toolCalls.length) {
        const idx = cursor++;
        const tc = toolCalls[idx];
        const fn = (tc && tc.function) || {};
        if (!fn.name) {
          toolResults[idx] = { tc, result: '工具调用缺少名称，已跳过', failed: true };
          continue;
        }
        // 参数必须是合法 JSON 对象。旧实现解析失败就静默退化成 {}，
        // 工具只会回一句"关键词为空"，模型拿到这种结果往往原地重试，白烧一整步。
        let args = {};
        const rawArgs = typeof fn.arguments === 'string' ? fn.arguments.trim() : '';
        if (rawArgs) {
          let parsed = null;
          try { parsed = JSON.parse(rawArgs); } catch (e) { parsed = null; }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            toolResults[idx] = {
              tc,
              result: '工具参数不是合法 JSON，未执行：' + rawArgs.slice(0, 160) + '。请重新调用 ' + fn.name + '，arguments 必须是合法的 JSON 对象。',
              failed: true
            };
            continue;
          }
          args = parsed;
        }
        // 跨步重复调用：同一工具 + 同一参数本轮「成功执行」第 3 次起不再执行（结果必然一样）。
        // v7.9.0：只统计成功次数。旧实现执行前就 +1，失败也占一次名额 ——
        // 网络抖一下、工具超时一次，模型重试两次就被判成「原地打转」直接跳过，
        // 提示还写着「结果不会变化」，可对一次失败而言这是假话，用户什么都拿不到。
        // 失败后重试恰恰是最该鼓励的行为，所以失败不计数、也不该触发熔断。
        const sig = toolCallSignature(tc);
        const firstInBatch = !batchSigSeen.has(sig);
        if (firstInBatch) batchSigSeen.add(sig);
        const doneCount = sigSuccess.get(sig) || 0;
        if (firstInBatch && doneCount >= REPEAT_STOP_AT - 1) {
          toolResults[idx] = {
            tc,
            result: '（同一工具与相同参数本轮已成功执行 ' + doneCount + ' 次，结果不会变化，已跳过重复执行；请换关键词/工具，或直接基于已有结果作答）',
            failed: true,
            skipped: true,
            hardStop: true
          };
          continue;
        }
        if (firstInBatch && doneCount >= REPEAT_SKIP_AT - 1) {
          toolResults[idx] = {
            tc,
            result: '（同一工具与相同参数本轮已成功执行 ' + doneCount + ' 次，结果不会变化，已跳过重复执行；请换关键词/工具，或直接基于已有结果作答）',
            failed: true,
            skipped: true
          };
          continue;
        }
        let p = stepDedup.get(sig);
        if (!p) {
          // 记忆类工具必须用「记忆作用域」而不是会话 id：Web 端 L1 跟会话（web_<sid>）、
          // L2/L3 跟浏览器（webu_<client_id>），传错就会「刚聊过却查不到」。
          p = execAgentTool(fn.name, args, env, memScope || chatId, kbReadOnly, { budgetMs: batchBudget });
          stepDedup.set(sig, p);
        }
        const result = await p;
        // v7.10.0：记下本轮用了哪些工具、存了哪些文档，供情景记忆做「线索」。
        // 只记名字不记参数：参数里可能有用户隐私（手机号、地址），记忆不该复制这些。
        if (fn.name && stats.toolNames.indexOf(fn.name) === -1) stats.toolNames.push(fn.name);
        if (fn.name === 'save_doc' && !isToolFailure(result)) {
          const docTitle = String(args.title || '').trim().slice(0, 60);
          if (docTitle && stats.docTitles.indexOf(docTitle) === -1) stats.docTitles.push(docTitle);
        }
        // 只有成功才算「这一次参数用过了」；失败留给模型重试的机会
        if (firstInBatch && !isToolFailure(result)) sigSuccess.set(sig, doneCount + 1);
        // 分页类工具（web_fetch / read_doc）保留它们承诺的页大小，
        // 并在截断提示里直接写出续读用的 offset，省掉模型自己猜的那一步
        const paginated = fn.name === 'web_fetch' || fn.name === 'read_doc';
        toolResults[idx] = {
          tc,
          result: truncateToolResult(result, toolResultMax(env, fn.name), { offsetHint: paginated }),
          failed: isToolFailure(result)
        };
      }
    });
    await Promise.all(workers);

    let stepFailed = 0;
    let stepSkipped = 0;
    let fresh = 0;
    let hardStop = false;
    for (const tr of toolResults) {
      const fn = (tr.tc && tr.tc.function) || {};
      messages.push({
        role: 'tool',
        tool_call_id: tr.tc.id,
        name: fn.name || 'unknown',
        content: tr.result
      });
      if (tr.failed) stepFailed += 1;
      if (tr.skipped) stepSkipped += 1;
      if (tr.hardStop) hardStop = true;
      if (!tr.skipped) {
        const d = toolResultDigest(tr.result);
        if (!seenResults.has(d)) {
          if (seenResults.size >= RESULT_MEMORY_MAX) seenResults.clear();
          seenResults.add(d);
          fresh += 1;
        }
      }
    }
    stats.toolCalls += toolResults.length;
    stats.failed += stepFailed;
    stats.skipped += stepSkipped;
    totalFailed += stepFailed;
    // 记录这一步的批次签名与「是否有失败」：失败批次不参与「连续三次相同即停」的判定
    recentBatches.push({ sig: stepSig, failed: stepFailed > 0 });
    if (recentBatches.length > 2) recentBatches.shift();

    // 整步没有任何新信息（全是重复调用 / 同样的缓存结果 / 同样的失败）
    if (toolResults.length && fresh === 0) noProgressStreak += 1;
    else if (fresh > 0) noProgressStreak = 0;

    if (stepSkipped > 0) {
      pushHint('【系统提示】检测到重复调用相同工具与参数，已跳过执行（结果不会变化）。请换关键词、换工具，或直接基于已有结果作答。');
    }
    // 整批调用全是重复：模型已经陷在原地打转，再给它一步也是同样的结果，直接收尾
    if (toolResults.length && stepSkipped === toolResults.length) {
      stats.stopReason = 'repeat';
      break;
    }
    // 批次里夹着新调用、但同参已到第 4 次：同样不必再等
    if (hardStop) {
      stats.stopReason = 'repeat';
      break;
    }
    // 失败比例：不再要求「整批全失败」才算数，一半以上失败同样值得提醒
    if (stepFailed > 0 && stepFailed * 2 >= toolResults.length && totalFailed >= 3) failStreak += 1;
    else if (stepFailed === 0) failStreak = 0;
    if (failStreak >= 2) {
      pushHint('【系统提示】最近的工具调用连续失败。请换关键词、换工具或换思路；若已无法取得更多信息，请基于已有结果直接给出最终答案，并明确说明哪些信息没查到。不要再用相同参数重复调用。');
      failStreak = 0;
    }
    if (noProgressStreak >= 2) {
      pushHint('【系统提示】这一步拿到的信息与前面完全相同，继续同样的调用不会带来新内容。请改用不同关键词/工具，或直接作答。');
    }
    if (noProgressStreak >= NO_PROGRESS_STOP) {
      stats.stopReason = 'no_progress';
      break;
    }
    // 工具跑完后重新看一眼预算：不够下一步就立刻去收尾，而不是再发一次上游请求
    if (Date.now() > deadline - reserve) return await finishByTimeout('time_budget');
  }
  } finally {
    clearInterval(heartbeat);
  }

  if (!stats.stopReason) stats.stopReason = 'max_steps';
  const wrapUp = await agentWrapUp(env, targetModelId, messages, loopStartIdx, ctxBudget, deadline, onDelta, stats.stopReason);
  if (wrapUp && wrapUp.text) return { text: wrapUp.text, usedTools: true, streamed: !!wrapUp.streamed, stopReason: stats.stopReason };
  const t = stripDSMLBlocks(lastAssistantText()).trim();
  if (resumeKey) {
    const saved = await saveResume();
    if (saved) {
      return {
        text: '⏸️ 本轮已到执行上限，进度已保存，发送「继续」让我接着做。' + (t ? '\n\n已产出：\n' + t : ''),
        usedTools: true, paused: true, stopReason: stats.stopReason
      };
    }
  }
  const fallbackText = (stats.stopReason === 'repeat' || stats.stopReason === 'no_progress')
    ? '（工具没能提供更多新信息，本次先到这里。请换个问法或补充关键信息后重试）'
    : '（思考步数已用尽，请换个问法重试）';
  return { text: t || fallbackText, usedTools: true, stopReason: stats.stopReason };
}

export {
  isToolResultFailure,
  extractMsgPlainText,
  tgAgentDeadline,
  tgAgentChat,
  tgAgentResume,
  tgAgentRunLoop,
  agentTurnStats,
  __resetAgentTurnStats,
};
