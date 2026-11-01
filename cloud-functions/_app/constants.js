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
const APP_VERSION = '7.8.0';
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
