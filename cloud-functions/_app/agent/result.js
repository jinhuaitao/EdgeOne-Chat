// 工具结果判定与内容指纹：loop.js / tools.js 共用的单一事实源
//
// 背景：这套判定以前在 loop.js（isToolResultFailure）和 tools.js（isCacheableToolSuccess）
// 里各抄了一份同样的正则。两份副本只要有一处漏改，就会出现「循环层认为是失败、
// 缓存层认为是成功」的分裂行为——失败结果被缓存 5 分钟，用户连续两次拿到同一个
// 「抓取失败」。这里收敛成一份，新增工具时只改一处。
//
// 判定依据是工具层自己写死的固定前缀，绝不靠正文里是否出现「失败」二字：
// 新闻标题、论文摘要里完全可能合法地出现这两个字，用子串匹配会把正常结果误判成失败。

const TOOL_FAILURE_PATTERN = [
  // 搜索 / 抓取
  '搜索失败',
  '搜索请求失败',
  '搜索「[^」]*」无结果',
  '抓取失败',
  'URL 非法',
  '该地址禁止抓取',
  '不支持抓取',
  '页面无有效文本内容',
  '偏移量 offset=\\d+ 已超出',
  '重定向次数过多',
  // 本地计算类
  '计算失败',
  '计算结果非法',
  '单位换算失败',
  '文本工具执行失败',
  '表达式为空',
  '表达式含非法字符',
  // 网络查询类
  '网络查询失败',
  'GitHub 查询失败',
  'GitHub 未找到',
  'arXiv 检索失败',
  'arXiv 未找到',
  '热榜获取失败',
  '时区无效',
  '天气查询失败',
  '找不到城市',
  '城市名为空',
  '汇率查询失败',
  '维基百科查询失败',
  '维基百科未找到',
  '维基百科查询关键词为空',
  '关键词为空',
  // 执行层
  '工具执行失败',
  '工具 [^ ]+ 执行超时',
  '工具参数不是合法 JSON',
  '工具调用缺少名称',
  '未知工具',
  // 存储层
  'R2 未绑定',
  '知识库文档写入',
  '记忆写入',
  '内容为空',
  '标题为空',
].join('|');

const TOOL_FAILURE_RE = new RegExp('^(?:' + TOOL_FAILURE_PATTERN + ')');

// 工具结果是否为「失败」。仅认前缀，避免正文误伤。
function isToolFailure(result) {
  const s = String(result == null ? '' : result);
  if (!s) return true;
  return TOOL_FAILURE_RE.test(s);
}

// 结果内容指纹（FNV-1a 32 位）：用于判断「这一步拿到的信息是不是已经拿过」。
// 不追求抗碰撞——同一轮对话里几十条结果撞上 32 位哈希的概率可以忽略，
// 而真正的重复结果（同样的搜索缓存、同样的文档片段）必然同哈希。
function toolResultDigest(result) {
  const s = String(result == null ? '' : result);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return (h >>> 0).toString(16) + ':' + s.length;
}

export {
  isToolFailure,
  toolResultDigest,
};
