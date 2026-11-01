// Agent 工具定义与分发（全套无配置增强：共 20 个零密钥工具 + L1 结果缓存与并发去重）

import { toolWebSearch, toolWebFetch, toolGithubLookup, toolArxivSearch, toolTrendingNews, clearWebPageCache } from './tools-web.js';
import { toolCalculate, toolGetTime, toolGetWeather, toolExchangeRate, toolWikiLookup, toolUnitConvert, toolTextToolkit, toolNetworkLookup } from './tools-local.js';
import { agentSaveMemory, agentForgetMemory } from './memory.js';
import { toolSaveDoc, toolListDocs, toolSearchDocs, toolReadDoc, toolDeleteDoc } from '../kb/doc-tools.js';
import { clearKbPrefetchCache } from '../kb/prefetch.js';
import { isToolFailure } from './result.js';

// ==================== 工具结果 L1 缓存与同参并发去重 ====================
// 对幂等只读工具进行短期缓存（仅缓存成功结果，失败结果绝不缓存），
// 并合并同一时刻参数完全相同的并发请求（inFlightTools），显著降低重复搜索/抓取/API 调用延迟。
const TOOL_CACHE_MAX = 120;
const TOOL_CACHE_TTL_BY_NAME = {
  web_search: 3 * 60 * 1000,
  web_fetch: 5 * 60 * 1000,
  wiki_lookup: 10 * 60 * 1000,
  exchange_rate: 60 * 1000,
  calculate: 10 * 60 * 1000,
  unit_convert: 10 * 60 * 1000,
  get_weather: 5 * 60 * 1000,
  github_lookup: 5 * 60 * 1000,
  arxiv_search: 10 * 60 * 1000,
  trending_news: 3 * 60 * 1000,
  network_lookup: 5 * 60 * 1000,
  // 知识库只读检索：同一轮里模型常常「换个措辞再查一遍」，缓存 30 秒既省掉整库重扫，
  // 又不会让刚保存的文档长时间看不到（TTL 远小于「读一次就忘」的容忍度）。
  search_docs: 30 * 1000,
  read_doc: 30 * 1000,
  list_docs: 30 * 1000,
};

const toolResultCache = new Map();
const inFlightTools = new Map();
let cacheHits = 0;
let cacheMisses = 0;

function canonicalizeArgs(args) {
  if (!args || typeof args !== 'object') return '{}';
  const keys = Object.keys(args).sort();
  const out = {};
  for (const k of keys) {
    if (args[k] !== undefined) out[k] = args[k];
  }
  try { return JSON.stringify(out); } catch (e) { return '{}'; }
}

function isCacheableToolSuccess(result) {
  // 失败判定统一走 result.js，避免「循环层当失败、缓存层当成功」的分裂
  return !isToolFailure(result);
}

function clearAgentToolCache() {
  toolResultCache.clear();
  inFlightTools.clear();
  clearWebPageCache();
  // 知识库预检索的 60 秒缓存也一起失效，否则刚保存的文档在 Web 端要等一分钟才「出现」
  try { clearKbPrefetchCache(); } catch (e) {}
  cacheHits = 0;
  cacheMisses = 0;
}

function getAgentToolCacheStats() {
  return { size: toolResultCache.size, inFlight: inFlightTools.size, hits: cacheHits, misses: cacheMisses };
}

// ==================== Agent 工具定义（共 20 项零密钥工具） ====================
function getAgentTools(kbReadOnly) {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: '联网搜索最新信息。仅在需要时效性内容（实时新闻、近期事件、赛事结果等）或问题超出你知识范围时使用；稳定的常识性知识不要搜，直接回答。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词' },
            count: { type: 'integer', description: '返回条数，1-8，默认5' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'web_fetch',
        description: '抓取指定网页的结构化正文（保留标题、代码块、表格与列表，单次最多返回 6000 字符；长网页可传 offset 翻页续读）。只对搜索结果中或用户明确给出的 URL 使用，不要猜测/编造 URL。',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '完整的 http(s) URL' },
            offset: { type: 'integer', description: '可选：起始字符偏移量（默认 0），用于长网页翻页续读' }
          },
          required: ['url']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'wiki_lookup',
        description: '查询维基百科（Wikipedia）权威词条摘要与相关条目，自动识别中英文。查人物、历史事件、科学概念、地理或专有名词的定义与背景时优先使用，比通用网页搜索更准确且无广告噪音。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '词条名称或搜索关键词，如"量子纠缠"、"Alan Turing"' },
            lang: { type: 'string', description: '可选：语言代码 zh 或 en，默认按关键词自动识别' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'github_lookup',
        description: '查询 GitHub 开源仓库详情（传入 owner/repo 如 "facebook/react" 可获取 Stars、Forks、Issues、协议、最新 Release 版本）或按关键词搜索高星开源项目。查开源项目、代码库或最新版本号时优先使用。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '仓库全名（如 "owner/repo"）或搜索关键词（如 "mcp server typescript"）' },
            sort: { type: 'string', description: '可选：排序方式 stars（默认）或 updated' },
            count: { type: 'integer', description: '可选：搜索返回条数，1-8，默认 5' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'arxiv_search',
        description: '检索 arXiv 预印本学术论文（计算机、人工智能、物理、数学等），返回论文标题、作者、发表日期、摘要及 PDF 链接。用户询问学术论文、前沿算法研究时优先使用。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '英文学术检索关键词，如 "deepseek r1 reinforcement learning" 或 "attention is all you need"' },
            sort: { type: 'string', description: '可选：relevance（相关性，默认）或 date（最新发表）' },
            count: { type: 'integer', description: '可选：返回篇数，1-6，默认 4' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'trending_news',
        description: '获取实时科技与开源热榜：支持 Hacker News 实时热门资讯（source="hn"）与 GitHub 近期飙升开源项目榜（source="github"）。当用户问"今天科技圈有什么热门新闻"或"最近 GitHub 有什么火的项目"时直接调用。',
        parameters: {
          type: 'object',
          properties: {
            source: { type: 'string', description: '热榜来源：hn（Hacker News 实时热榜，默认）或 github（GitHub 近两周飙升新项目）' },
            language: { type: 'string', description: '可选：当 source="github" 时按编程语言筛选，如 python、typescript、rust' },
            count: { type: 'integer', description: '可选：返回条数，1-8，默认 5' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'exchange_rate',
        description: '查询实时法币汇率换算（支持 USD/CNY/JPY/EUR/HKD/TWD/GBP 等全球货币）及主流加密货币实时价格与 24h 涨跌（BTC/ETH/SOL/BNB/DOGE/XRP/TON/SUI 等）。查汇率或币价时优先用它，不要用 web_search。',
        parameters: {
          type: 'object',
          properties: {
            from: { type: 'string', description: '源货币或加密币代码，如 USD、JPY、BTC、人民币' },
            to: { type: 'string', description: '目标货币代码，默认 CNY，如 CNY、USD' },
            amount: { type: 'number', description: '换算金额，默认 1' }
          },
          required: ['from']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'calculate',
        description: '精确科学与统计计算器，支持四则运算、乘方(^)、取余(%)、括号、科学记数法、常量(pi, e, tau, phi)以及函数：sqrt, cbrt, abs, sign, trunc, round(x,n), floor, ceil, sin, cos, tan, asin, acos, atan, atan2(y,x), sinh, cosh, tanh, deg, rad, ln, log(x,base), log10, log2, exp, pow(a,b), hypot, min, max, sum, avg/mean, median, std, var, gcd, lcm, fact(n), comb(n,k)/ncr, perm(n,k)/npr。任何数学或统计运算都用它，不要心算。',
        parameters: {
          type: 'object',
          properties: {
            expression: { type: 'string', description: '数学表达式，如 (3280-1299)*1.13、std(12,15,18,22,30) 或 comb(52,5)' }
          },
          required: ['expression']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'unit_convert',
        description: '精确单位换算与进制转换器。支持长度(mm/cm/m/km/in/ft/yd/mi/nmi/寸/尺/里)、重量(mg/g/kg/t/oz/lb/斤/两/克拉)、温度(C/F/K)、面积(m2/km2/sq_ft/acre/ha/亩/坪)、体积(ml/l/m3/fl_oz/cup/pt/qt/gal)、速度(m/s,km/h,mph,knot,mach)、数据存储(bit/B/KB/MB/GB/TB/PB)以及 2~36 进制大整数互转（传 base_from / base_to）。',
        parameters: {
          type: 'object',
          properties: {
            value: { type: ['number', 'string'], description: '要转换的数值或进制字符串（如 100 或 "FF"）' },
            from: { type: 'string', description: '源单位（如 km、lb、F、亩、GB）或进制名（bin/oct/dec/hex）' },
            to: { type: 'string', description: '目标单位（如 mi、kg、C、m2、MB）或进制名（bin/oct/dec/hex）' },
            base_from: { type: 'integer', description: '可选：进制转换时的源进制（2~36）' },
            base_to: { type: 'integer', description: '可选：进制转换时的目标进制（2~36）' }
          },
          required: ['value']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'text_toolkit',
        description: '文本与编码工具箱：支持精确统计字数/汉字数/英文词数/行数/UTF-8字节数（action="stats"）、计算 SHA-256/SHA-1/SHA-512 哈希摘要（action="hash"）、Base64 编解码（base64_encode / base64_decode）、URL 编解码（url_encode / url_decode）及生成随机 UUID v4（action="uuid"）。凡需精确字数统计、哈希或编码转换时必须调用，不要心算字数或编码。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', description: '操作类型：stats（字数统计，默认）、hash、base64_encode、base64_decode、url_encode、url_decode、uuid' },
            text: { type: 'string', description: '要处理的文本内容（action="uuid" 时可省略）' },
            algorithm: { type: 'string', description: '可选：action="hash" 时的算法，SHA-256（默认）/ SHA-1 / SHA-384 / SHA-512' },
            count: { type: 'integer', description: '可选：action="uuid" 时生成的数量（1~10，默认 1）' }
          },
          required: ['action']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'network_lookup',
        description: '查询 IP 地址（IPv4/IPv6）的地理位置、运营商 ISP、自治系统号 ASN，或查询域名的 DNS 解析记录（A/AAAA/CNAME/MX/TXT/NS）。排查网络、查询域名解析或 IP 归属地时使用。',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'IP 地址（如 8.8.8.8）或域名（如 github.com）' },
            record_type: { type: 'string', description: '可选：查域名时的 DNS 记录类型，A（默认）/ AAAA / CNAME / MX / TXT / NS' }
          },
          required: ['target']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_time',
        description: '获取当前时间（可指定 IANA 时区），并支持精确日期推算：计算两个日期之间相差多少天/周（target_date），或计算某日期加减 N 天后的具体日期与星期几（add_days）。遇到时间、日期差、倒计时推算时必须用它，不要心算日历。',
        parameters: {
          type: 'object',
          properties: {
            timezone: { type: 'string', description: 'IANA 时区，如 Asia/Shanghai、America/New_York，默认 Asia/Shanghai' },
            base_date: { type: 'string', description: '可选：基准日期 YYYY-MM-DD，默认取当前时区的今天' },
            target_date: { type: 'string', description: '可选：目标日期 YYYY-MM-DD，用于计算与基准日期相差的天数和周数' },
            add_days: { type: 'integer', description: '可选：在基准日期上加减的天数（正数向后推，负数向前推）' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: '查询指定城市当前天气与未来三天预报（含温度、湿度、风速及降水概率）。city 必须给明确城市名（如"北京"、"Tokyo"）；用户没说城市时先追问，不要猜。',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string', description: '城市名，如"北京"、"Tokyo"' }
          },
          required: ['city']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'remember',
        description: '把关于用户的重要长期信息存入记忆（如偏好、生日、项目名、常用城市），存入后以后所有对话都会记得。仅在用户明确要求记住（"记住…"）时调用，不要把临时对话内容存进去。同一主题（如"我的手机号是…"）改口后直接记住新值即可：旧值会被自动覆盖更新，无需先删除。',
        parameters: {
          type: 'object',
          properties: {
            fact: { type: 'string', description: '一句话事实' }
          },
          required: ['fact']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'forget_memory',
        description: '按关键词删除已保存的用户长期记忆。仅在用户明确要求忘掉/删除某条记忆（如"忘掉我之前的住址"、"删掉关于猫的记忆"）时调用。',
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '要删除的记忆关键词' }
          },
          required: ['keyword']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'save_doc',
        description: '把长篇内容保存为知识库文档，真实写入 R2 的 kb/docs/ 文件夹（文件名取自标题）。仅在用户明确要求保存文档（"保存成文档/存到知识库/生成知识库文件"）时调用；简短的个人信息用 remember，不要用它；不要主动为普通回答生成文档。只有本工具返回成功，才可以告诉用户"已保存/已生成"；失败或没调用时绝不声称已保存。',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '文档标题，用作文件名，如"甲骨文云ARM放货知识库"' },
            content: { type: 'string', description: 'Markdown 格式的正文' },
            source: { type: 'string', description: '可选：原文链接，会记入文件头' }
          },
          required: ['title', 'content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_docs',
        description: '列出知识库文档（标题 + 体积 + 更新时间，按最近更新排序）。想通览有哪些文档时用；只知道主题、不确定是哪一篇时，用 search_docs 按关键词检索全文更准。',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'search_docs',
        description: '在知识库全部文档里做全文检索（标题 + 正文，支持多关键词与中文 2-gram），返回相关性最高的若干片段，以及所属文档名与该片段在全文中的 offset。当你想确认"知识库里有没有讲过 X"、或不确定该读哪一篇时，先用它；已知确切标题要读整篇时用 read_doc。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '检索关键词，可空格分隔多个词，如"回源 超时 重试"' },
            count: { type: 'integer', description: '可选：返回片段数，1-8，默认 3' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_doc',
        description: '按标题读取知识库文档正文（单次返回 8000 字）。文档比一页长时，首次返回会附带【章节目录】（含每节的 offset），可直接传 offset 跳到需要的章节，不必逐页翻。query 给标题；标题对不上时会自动退回全库检索并返回最相关的 Top 3 片段。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '文档标题（推荐给完整标题），或标题关键词' },
            offset: { type: 'integer', description: '可选：读取起始字符偏移量（默认 0），用于跳转到目录里的某一节或翻页' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'delete_doc',
        description: '删除一篇知识库文档（R2 kb/docs/）。仅在用户明确要求删除文档时调用；query 给标题或关键词模糊匹配，找不到会返回现有标题列表。删除不可逆，调用前确保用户意图明确。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '文档标题或关键词' }
          },
          required: ['query']
        }
      }
    }
  ];
  if (kbReadOnly) {
    const writes = ['remember', 'forget_memory', 'save_doc', 'delete_doc'];
    return tools.filter(t => writes.indexOf(t.function.name) === -1);
  }
  return tools;
}

async function runRawAgentTool(name, args, env, chatId) {
  switch (name) {
    case 'web_search': return await toolWebSearch(args.query, args.count);
    case 'web_fetch': return await toolWebFetch(args.url, args.offset);
    case 'wiki_lookup': return await toolWikiLookup(args.query, args.lang);
    case 'github_lookup': return await toolGithubLookup(args);
    case 'arxiv_search': return await toolArxivSearch(args);
    case 'trending_news': return await toolTrendingNews(args);
    case 'exchange_rate': return await toolExchangeRate(args);
    case 'calculate': return toolCalculate(args.expression);
    case 'unit_convert': return toolUnitConvert(args);
    case 'text_toolkit': return await toolTextToolkit(args);
    case 'network_lookup': return await toolNetworkLookup(args);
    case 'get_time': return toolGetTime(args.timezone, args);
    case 'get_weather': return await toolGetWeather(args.city);
    case 'remember': return await agentSaveMemory(env, chatId, args.fact);
    case 'forget_memory': {
      const kw = String(args.keyword || '').trim();
      if (!kw) return '关键词为空，未删除任何记忆';
      const rr = await agentForgetMemory(env, chatId, kw);
      if (rr.persistError) return rr.persistError;
      return rr.removed > 0
        ? '已删除 ' + rr.removed + ' 条包含「' + kw + '」的长期记忆'
        : '未找到包含「' + kw + '」的长期记忆';
    }
    case 'save_doc': {
      const r = await toolSaveDoc(env, chatId, args);
      // 知识库内容变了：立刻清掉 list_docs / search_docs / read_doc 的 L1 缓存，
      // 否则刚保存的文档在 30 秒内「查不到」，用户会以为没存上。
      if (String(r).startsWith('已保存')) clearAgentToolCache();
      return r;
    }
    case 'list_docs': return await toolListDocs(env);
    case 'search_docs': return await toolSearchDocs(env, args);
    case 'read_doc': return await toolReadDoc(env, args);
    case 'delete_doc': {
      const r = await toolDeleteDoc(env, args);
      if (String(r).startsWith('已删除')) clearAgentToolCache();
      return r;
    }
    default: return '未知工具: ' + name;
  }
}

async function execAgentTool(name, args, env, chatId, kbReadOnly, opts) {
  args = args || {};
  env = env || {};
  // v6.9.3 / v7.0.0 执行层硬校验：Web 端（kbReadOnly）即使模型幻觉出写入类工具调用，也绝不执行
  if (kbReadOnly && (name === 'remember' || name === 'forget_memory' || name === 'save_doc' || name === 'delete_doc')) {
    return '工具 ' + name + ' 在本端不可用：知识库为只读，写入与删除（记忆 / 文档保存与删除）仅 Telegram 端支持。请如实告知用户，并引导其通过 Telegram 机器人完成该操作；不要声称已完成。';
  }

  // 检查是否开启只读工具 L1 缓存（默认开启，设 AGENT_TOOL_CACHE=0 可关闭）
  const ttlMs = env.AGENT_TOOL_CACHE === '0' ? 0 : (TOOL_CACHE_TTL_BY_NAME[name] || 0);
  const cacheKey = ttlMs > 0 ? (name + '|' + canonicalizeArgs(args)) : '';

  if (cacheKey) {
    const now = Date.now();
    const hit = toolResultCache.get(cacheKey);
    if (hit && now < hit.exp) {
      cacheHits++;
      toolResultCache.delete(cacheKey);
      toolResultCache.set(cacheKey, hit);
      return hit.val;
    }
    if (hit) toolResultCache.delete(cacheKey);
    if (inFlightTools.has(cacheKey)) {
      cacheHits++;
      return await inFlightTools.get(cacheKey);
    }
    cacheMisses++;
  }

  let toolTimeoutMs = parseInt(env.AGENT_TOOL_TIMEOUT_MS || '30000', 10);
  if (!(toolTimeoutMs > 0)) toolTimeoutMs = 30000;
  // v7.5.0：工具超时不再是一个与整体预算无关的常数。
  // 循环层会把「剩余预算 - 收尾预留」算好传进来，工具最多只能用这么多时间，
  // 否则会出现「只剩 5 秒还在等 30 秒的工具 → 函数被平台掐断 → 断点没存上」。
  const budgetMs = opts && opts.budgetMs > 0 ? opts.budgetMs : 0;
  if (budgetMs && budgetMs < toolTimeoutMs) toolTimeoutMs = Math.max(1500, budgetMs);

  const execPromise = (async () => {
    let timer;
    try {
      const run = runRawAgentTool(name, args, env, chatId);
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('__TOOL_TIMEOUT__')), toolTimeoutMs);
      });
      const res = await Promise.race([run, timeout]);
      if (cacheKey && isCacheableToolSuccess(res)) {
        if (toolResultCache.size >= TOOL_CACHE_MAX) {
          const oldest = toolResultCache.keys().next().value;
          if (oldest !== undefined) toolResultCache.delete(oldest);
        }
        toolResultCache.set(cacheKey, { val: res, exp: Date.now() + ttlMs });
      }
      return res;
    } catch (e) {
      if (e && e.message === '__TOOL_TIMEOUT__') return '工具 ' + name + ' 执行超时（' + Math.round(toolTimeoutMs / 1000) + ' 秒），已跳过';
      return '工具执行失败: ' + (e && e.message ? e.message : String(e));
    } finally {
      if (timer) clearTimeout(timer);
      if (cacheKey) inFlightTools.delete(cacheKey);
    }
  })();

  if (cacheKey) inFlightTools.set(cacheKey, execPromise);
  return await execPromise;
}

export {
  getAgentTools,
  execAgentTool,
  clearAgentToolCache,
  getAgentToolCacheStats,
};
