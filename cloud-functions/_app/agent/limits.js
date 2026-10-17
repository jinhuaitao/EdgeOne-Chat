// Agent 运行上限与工具进度的可读文案（_worker.js 原第 1249-1278 行）

// ==================== Telegram Agent：主循环 ====================
// ReAct 风格：LLM 决策 → 执行工具 → 结果回填 → 最多 MAX_STEPS 步。
// 通道/模型不支持 tools 参数时返回 { fallback: true }，由调用方降级为普通对话。
// Agent 运行限制（可配，防极端情况失控）
function agentLimits(env) {
  let maxSteps = parseInt(env.AGENT_MAX_STEPS || '6', 10);
  if (!(maxSteps > 0)) maxSteps = 6;
  if (maxSteps > 12) maxSteps = 12;
  let timeoutMs = parseInt(env.AGENT_TIMEOUT_MS || '240000', 10);
  if (!(timeoutMs > 0)) timeoutMs = 240000;
  return { maxSteps, timeoutMs };
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
  describeToolCall,
};
