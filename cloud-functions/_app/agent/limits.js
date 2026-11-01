// Agent 运行上限、时间预算与工具进度的可读文案

// ==================== Agent 运行上限 ====================
// ReAct 风格：LLM 决策 → 执行工具 → 结果回填 → 最多 maxSteps 步。
// 通道/模型不支持 tools 参数时返回 { fallback: true }，由调用方降级为普通对话。
//
// v7.5.0 时间预算治理：
//   以前只有「整体超时」一个数，工具自己的 30 秒超时与它无关。于是会出现
//   「只剩 5 秒预算，却还在等一个 30 秒的工具」——函数被平台在 120 秒处掐断，
//   断点状态没来得及写，用户既没答案也不能「继续」。
//   现在把预算拆成三份：可用时间 - 收尾预留 = 循环可用；循环内每一步、每个工具
//   都按「当下剩余」重新收缩，保证收尾那一枪一定打得出去。

// Cloud Functions 单次调用上限 120 秒，这里留 5 秒给平台回收与响应写出
const DEFAULT_RUNTIME_CAP_MS = 115000;

function intEnv(env, name, def, min, max) {
  let v = parseInt((env && env[name]) || '', 10);
  if (!(v > 0)) v = def;
  if (min !== undefined && v < min) v = min;
  if (max !== undefined && v > max) v = max;
  return v;
}

function agentLimits(env) {
  const maxSteps = intEnv(env, 'AGENT_MAX_STEPS', 6, 1, 12);
  const runtimeCapMs = intEnv(env, 'AGENT_MAX_RUNTIME_MS', DEFAULT_RUNTIME_CAP_MS, 20000, 600000);
  // AGENT_TIMEOUT_MS 是「Agent 整体超时」，但再大也大不过函数存活时间，
  // 否则预算永远用不完就被平台掐死。取两者较小值。
  const timeoutMs = Math.min(intEnv(env, 'AGENT_TIMEOUT_MS', 240000, 10000, 600000), runtimeCapMs);
  // 收尾预留：步数/时间用尽后，还要留时间做一次「不许调工具、只许总结」的收尾请求
  const wrapupReserveMs = intEnv(env, 'AGENT_WRAPUP_RESERVE_MS', 12000, 4000, 40000);
  const toolConcurrency = intEnv(env, 'AGENT_TOOL_CONCURRENCY', 4, 1, 8);
  const toolTimeoutMs = intEnv(env, 'AGENT_TOOL_TIMEOUT_MS', 30000, 2000, 120000);
  return { maxSteps, timeoutMs, runtimeCapMs, wrapupReserveMs, toolConcurrency, toolTimeoutMs };
}

// 本次工具批次可用的毫秒数：不超过工具自身上限，也不吃掉收尾预留。
// 下限 3000：低于 3 秒的等待基本等于失败，不如让工具层立刻返回超时，
// 把时间让给收尾。
function toolBudgetMs(limits, deadline, now) {
  const remain = deadline - (now || Date.now()) - (limits.wrapupReserveMs || 0);
  const cap = limits.toolTimeoutMs > 0 ? limits.toolTimeoutMs : 30000;
  return Math.max(3000, Math.min(cap, remain));
}

// 上游单次请求的超时：同样按剩余预算收缩。
// 旧实现用 Math.max(15000, ...) 兜底，剩余预算只有 3 秒时仍会等满 15 秒 ——
// 这正是「预算耗尽却没能暂停保存」的元凶之一。
function upstreamTimeoutMs(deadline, now, opts) {
  const o = opts || {};
  const remain = deadline - (now || Date.now());
  const floor = o.floorMs > 0 ? o.floorMs : 3000;
  const cap = o.capMs > 0 ? o.capMs : 180000;
  return Math.min(cap, Math.max(floor, remain));
}

// 工具结果进入上下文时的长度上限。
// web_fetch 单页 6000 字符、read_doc 单页 8000 字符 —— 这两个工具自己就承诺了页大小，
// 再按统一的 4000 砍一半，等于「工具让你读 8000，循环只给你 4000」，
// 用户看到的就是「文档读了一半」。所以按工具给默认值，环境变量可整体覆盖。
const TOOL_RESULT_MAX_BY_NAME = { read_doc: 8500, web_fetch: 6500 };
function toolResultMax(env, name) {
  const v = parseInt((env && env.AGENT_TOOL_RESULT_MAX) || '', 10);
  if (v > 0) return v;
  return TOOL_RESULT_MAX_BY_NAME[name] || 4000;
}

// 工具调用的人类可读描述，用于进度提示与 Web 端工具调用轨迹胶囊
function describeToolCall(name, args) {
  args = args || {};
  const offNote = args.offset > 0 ? '（续读 offset=' + args.offset + '）' : '';
  switch (name) {
    case 'web_search': return '🔍 正在搜索：' + (args.query || '');
    case 'web_fetch': return '📄 正在读取网页' + offNote + '…';
    case 'wiki_lookup': return '🌐 正在查阅维基百科：' + (args.query || '');
    case 'exchange_rate': return '💱 正在查询汇率/行情：' + (args.from || '') + (args.to ? ' → ' + args.to : '');
    case 'calculate': return '🧮 正在计算：' + (args.expression || '');
    case 'unit_convert': return '📏 正在换算单位/进制：' + (args.value !== undefined ? args.value + ' ' : '') + (args.from || args.base_from || '') + ' → ' + (args.to || args.base_to || '');
    case 'text_toolkit': return '🔤 正在执行文本/编码工具：' + (args.action || 'stats');
    case 'network_lookup': return '🖧 正在查询 IP/DNS 网络信息：' + (args.target || '');
    case 'github_lookup': return '🐙 正在检索 GitHub 开源仓库：' + (args.query || args.repo || '');
    case 'arxiv_search': return '🎓 正在检索 arXiv 学术论文：' + (args.query || '');
    case 'trending_news': return '🔥 正在获取实时科技/开源热榜：' + (args.source || 'hn');
    case 'get_weather': return '🌤 正在查询天气：' + (args.city || '');
    case 'get_time': return '🕐 正在获取时间/推算日期…';
    case 'remember': return '🧠 正在记住…';
    case 'forget_memory': return '🗑️ 正在清理记忆：' + (args.keyword || '');
    case 'save_doc': return '💾 正在保存文档：' + (args.title || '');
    case 'list_docs': return '📚 正在查看知识库文档…';
    case 'read_doc': return '📖 正在读取文档：' + (args.query || '') + offNote;
    case 'delete_doc': return '🗑️ 正在删除文档：' + (args.query || '');
    default: return '⚙️ 正在调用：' + name;
  }
}

export {
  agentLimits,
  toolBudgetMs,
  upstreamTimeoutMs,
  toolResultMax,
  describeToolCall,
};
