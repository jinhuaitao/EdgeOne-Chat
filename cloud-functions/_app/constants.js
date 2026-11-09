// 应用版本号与复用的 HTTP 响应头常量

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Access-Token, X-Wx-Admin-Token',
};

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
};

const HTML_HEADERS = { 'Content-Type': 'text/html;charset=UTF-8' };
const TEXT_HEADERS = { 'Content-Type': 'text/plain;charset=UTF-8' };

// 应用版本号（/help 显示；发版时同步 package.json）
// 7.10.1：三层记忆收口 —— 修掉五处会真实出错的边界：①普通对话模式（关闭 Agent）只注入
//        不写回，L1/L2 永远为空（现在用 tee 旁路写回，不改动发给客户端的字节）；
//        ②记忆时间按 UTC 渲染而提示词声明「北京时间」，模型会照着错时间答；③L2 同主题
//        合并时从头部截断，越合并越丢最新结论；④空作用域兜底成 default 导致匿名请求
//        串号；⑤/memory 的 L3 条数被检索上限截断（有 200 条却报「共 60 条」）。
//        另：注入预算改为硬上限、同用户并发写加锁、/memory 三层并行读。
// 7.10.0：三层记忆 —— L1 工作记忆（会话要点/主题/未完成，kb/work/）、L2 情景记忆（每次实质对话
//        一条摘要，可按关键词回溯，kb/epi/）、L3 语义记忆（用户稳定事实，带类型/标签/使用度与
//        容量淘汰）。新增 recall_memory 工具与 /recall 命令；/memory 改为三层报告；/clear 只清
//        L1；Web 端按 client_id 跨会话记忆（旧实现 Web 完全没有记忆）；/healthz 增 debug.memory。
// 7.9.0：Agent 深水区修复 —— 上下文裁剪改为先折叠后删除（多文档对比不再只剩一篇）、
//        重复调用熔断只统计成功次数（失败重试不再被判原地打转）、工具描述与文档列表瘦身、
//        通道拒收 tools 时降级为 DSML 文本调用模式、usage/token 与真实 prompt 体积统计、
//        web_search 增加百度回退与限流识别、temperature 默认 0.7。
// 7.8.0：知识库改为 Web 端恒定优先 —— 移除「📚 知识库」开关（误触关掉后回答质量断崖下跌
//        且无人知道原因），请求体不再带 kb_first，预检索默认执行；升级时清理历史偏好
//        eochat_kb_first。运维级关闭仍可用 WEB_KB_FIRST=0，外部调用仍可传 kb_first=false。
// 7.7.0：Web 端优先读知识库 —— 新增知识库预检索（kb/prefetch.js）：进入模型前先按问题
//        检索一次，把最相关的正文片段直接放进提示词。Agent 模式与「关闭 Agent 的普通对话」
//        都生效（后者是旧版最大的漏洞：一关 Agent 知识库就等于不存在）。
// 7.6.0：知识库读取链路重做 —— 新增 search_docs 工具（检索与精读分离）、全文检索扫全库
//        并回报扫描范围、位置滑动窗口定位、中文不再拆单字、长文档章节目录跳读、
//        标题多候选提示、list_docs 按更新时间倒序。
// 7.5.0：Agent 精修 —— 时间预算治理（工具/上游超时随剩余预算收缩 + 收尾预留）、
//        跨步重复调用熔断、无新信息检测、上下文二级压缩、reasoning_content 回传策略。
// 7.4.0：同步新增微信 ClawBot（腾讯官方 iLink Bot API / openclaw-weixin 协议）通道支持 + 四重防盗绑安全锁。
const APP_VERSION = '7.10.1';
const PNG_HEADERS = {
  'Content-Type': 'image/png',
  'Cache-Control': 'public, max-age=86400',
  'Access-Control-Allow-Origin': '*',
};

const MANIFEST_HEADERS = {
  'Content-Type': 'application/manifest+json;charset=UTF-8',
  'Cache-Control': 'public, max-age=3600',
  'Access-Control-Allow-Origin': '*',
};

// SW 必须挂在根路径，并显式声明 scope；no-cache 保证新版本能及时下发
const SW_HEADERS = {
  'Content-Type': 'application/javascript;charset=UTF-8',
  'Service-Worker-Allowed': '/',
  'Cache-Control': 'no-cache',
};

const HEALTH_HEADERS = {
  'Content-Type': 'application/json;charset=UTF-8',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
};

// 生图结果转存后的读图响应头。图片按内容寻址（id 唯一且不可变），可以长缓存。
function imgHeaders(contentType) {
  return {
    'Content-Type': contentType || 'image/png',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Access-Control-Allow-Origin': '*',
  };
}

export {
  CORS_HEADERS,
  SSE_HEADERS,
  HTML_HEADERS,
  TEXT_HEADERS,
  PNG_HEADERS,
  MANIFEST_HEADERS,
  SW_HEADERS,
  HEALTH_HEADERS,
  APP_VERSION,
  imgHeaders,
};
