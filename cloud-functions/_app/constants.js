// 应用版本号与复用的 HTTP 响应头常量（_worker.js 原第 22-43,54-77 行）

// 复用 HTTP 响应头结构
const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Access-Token',
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
// 7.0.0：全套零配置 Agent 增强与架构优化版。
//  - 知识库 2.0：read_doc 支持 offset 分页读取 10 万字长文档 + 多关键词分词/2-gram 全文相关性排序检索；
//  - 网页提取 2.0：web_fetch 保留 Markdown 结构（标题/代码块/表格/列表）+ 支持 offset 分页 + Jina 免密钥回退；
//  - 新工具：wiki_lookup（中英维基百科词条）、exchange_rate（实时法币汇率 + 主流加密币价）、forget_memory（自然语言删记忆）；
//  - 科学计算与日期推算：calculate 扩展 20 个科学函数与 pi/e 常量；get_time 支持日期间隔与加减天数推算；
//  - Telegram 增强：零配置支持直接发送文本文件（.md/.txt/.csv/.json/代码）分析或入库，以及发送图片多模态识图问答；
//  - Web UI 增强：新增可折叠「工具调用轨迹胶囊（Tool Trace）」，保留每步工具调用记录与总耗时。
const APP_VERSION = '7.0.0';
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
// 这里必须允许 CORS：前端可能把图片渲染在 <img> 之外的场景（如另存、画布处理）。
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
