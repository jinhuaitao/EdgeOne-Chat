// Agent 工具定义与分发（全套无配置增强：共 21 个零密钥工具 + L1 结果缓存与并发去重）

import { toolWebSearch, toolWebFetch, toolGithubLookup, toolArxivSearch, toolTrendingNews, clearWebPageCache } from './tools-web.js';
import { toolCalculate, toolGetTime, toolGetWeather, toolExchangeRate, toolWikiLookup, toolUnitConvert, toolTextToolkit, toolNetworkLookup } from './tools-local.js';
import { agentSaveMemory, agentForgetMemory, agentTouchMemories } from './memory.js';
import { recallMemory, formatRecallResult, forgetEpisodes } from './memory-layers.js';
import { toolSaveDoc, toolListDocs, toolSearchDocs, toolReadDoc, toolDeleteDoc } from '../kb/doc-tools.js';
import { clearKbPrefetchCache } from '../kb/prefetch.js';
import { isToolFailure } from './result.js';
import { normalizeToolArgs } from './accuracy.js';

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

// ==================== Agent 工具定义（共 21 项零密钥工具） ====================
function getAgentTools(kbReadOnly) {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: '联网搜索最新信息。只用于时效性内容（实时新闻、近期事件、赛事结果）或超出你知识范围的问题；稳定常识不要搜，直接回答。',
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
        description: '抓取网页结构化正文（单次最多 6000 字符，长网页可传 offset 翻页）。只对搜索结果或用户给出的 URL 使用，不要编造 URL。',
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
        description: '查维基百科词条摘要与相关条目，自动识别中英文。人物、历史事件、科学概念、地理、专有名词优先用它。',
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
        description: '查 GitHub 仓库详情（传 owner/repo 得 Stars/Forks/协议/最新 Release），或按关键词搜高星开源项目。',
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
        description: '检索 arXiv 预印本论文，返回标题、作者、发表日期、摘要与 PDF 链接。',
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
        description: '实时热榜：Hacker News 科技热榜（source=hn，默认）或 GitHub 近两周飙升项目。',
        parameters: {
          type: 'object',
          properties: {
            source: { type: 'string', description: 'hn（默认）或 github' },
            language: { type: 'string', description: '可选：source=github 时按语言筛选，如 python' },
            count: { type: 'integer', description: '可选：条数，1-8，默认 5' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'exchange_rate',
        description: '实时汇率换算（USD/CNY/JPY/EUR 等）与加密货币价格及 24h 涨跌。查汇率或币价用它，不要用 web_search。',
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
        description: '精确计算器：四则运算、乘方(^)、括号、常量(pi/e/tau/phi)及 sqrt/log/round/sin/sum/avg/median/std/gcd/lcm/fact/comb/perm 等。任何数学或统计运算都用它，不要心算。',
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
        description: '单位与进制换算：长度、重量、温度、面积、体积、速度、数据存储，以及 2~36 进制互转（传 base_from/base_to）。',
        parameters: {
          type: 'object',
          properties: {
            value: { type: ['number', 'string'], description: '数值或进制字符串（100 或 "FF"）' },
            from: { type: 'string', description: '源单位（km、lb、F、亩、GB）或进制名（bin/oct/dec/hex）' },
            to: { type: 'string', description: '目标单位（mi、kg、C、m2、MB）或进制名' },
            base_from: { type: 'integer', description: '可选：源进制（2~36）' },
            base_to: { type: 'integer', description: '可选：目标进制（2~36）' }
          },
          required: ['value']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'text_toolkit',
        description: '文本与编码工具箱：字数/汉字/词/行/字节统计（stats）、SHA 哈希、Base64、URL 编解码、UUID。需精确字数或编码转换时必须调用。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', description: 'stats（默认）/hash/base64_encode/base64_decode/url_encode/url_decode/uuid' },
            text: { type: 'string', description: '要处理的文本（uuid 时可省略）' },
            algorithm: { type: 'string', description: '可选：SHA-256（默认）/SHA-1/SHA-384/SHA-512' },
            count: { type: 'integer', description: '可选：uuid 数量，1~10，默认 1' }
          },
          required: ['action']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'network_lookup',
        description: '查 IP（IPv4/IPv6）归属地、运营商、ASN，或域名 DNS 记录（A/AAAA/CNAME/MX/TXT/NS）。',
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
        description: '获取当前时间（可指定时区），或算两个日期天数差（target_date）、加减 N 天（add_days）。不要心算日历。',
        parameters: {
          type: 'object',
          properties: {
            timezone: { type: 'string', description: 'IANA 时区，如 Asia/Shanghai，默认 Asia/Shanghai' },
            base_date: { type: 'string', description: '可选：基准日期 YYYY-MM-DD，默认今天' },
            target_date: { type: 'string', description: '可选：目标日期 YYYY-MM-DD，算与基准日期的天数差' },
            add_days: { type: 'integer', description: '可选：基准日期加减的天数（负数为向前）' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: '查城市当前天气与未来三天预报（温度、湿度、风速、降水概率）。用户没说城市先追问，不要猜。',
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
        description: '保存用户的长期事实（偏好、生日、项目名、常用城市、长期要求）。仅用户明确要求记住时调用；同一主题改口直接记新值，旧值自动覆盖。',
        parameters: {
          type: 'object',
          properties: {
            fact: { type: 'string', description: '一句话事实' },
            kind: { type: 'string', description: '可选：fact（默认）/preference/profile/project/instruction' },
            tags: { type: 'array', items: { type: 'string' }, description: '可选：标签，如 ["工作"]' }
          },
          required: ['fact']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'forget_memory',
        description: '删除记忆。默认只删长期事实；layer=episodic 删情景记忆，all 两层都删。仅用户明确要求忘掉时调用。',
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '要删除的记忆关键词' },
            layer: { type: 'string', description: '可选：semantic（默认）/episodic/all' }
          },
          required: ['keyword']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'recall_memory',
        description: '检索三层记忆：L1 本次会话要点、L2 过往对话、L3 用户长期事实。用户说"上次/之前/我说过"或需确认历史偏好时用。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '检索关键词；留空返回最近条目' },
            layer: { type: 'string', description: '可选：all（默认）/work/episodic/semantic' },
            count: { type: 'integer', description: '可选：每层条数，1-8，默认 5' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'save_doc',
        description: '把长篇内容存为知识库文档（文件名取自标题）。仅用户明确要求保存文档时调用；简短个人信息用 remember。只有它返回成功才能说已保存。',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '文档标题，用作文件名' },
            content: { type: 'string', description: 'Markdown 正文' },
            source: { type: 'string', description: '可选：原文链接，记入文件头' }
          },
          required: ['title', 'content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_docs',
        description: '列出知识库文档（标题 + 体积 + 更新时间，按最近更新倒序）。只想确认有哪些文档时用；不确定是哪篇就用 search_docs。',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'search_docs',
        description: '在知识库全部文档里全文检索（标题+正文，多关键词），返回最相关片段、文档名与 offset。不确定读哪篇、或要确认讲过没讲过时先用它。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '关键词，空格分隔多个，如"回源 超时"' },
            count: { type: 'integer', description: '可选：片段数，1-8，默认 3' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_doc',
        description: '按标题读知识库文档正文（单次 8000 字）。超一页时首次返回【章节目录】含每节 offset，可直接跳节不必逐页翻；标题对不上会自动退回全库检索并返回 Top 3 片段。',
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
        description: '删除一篇知识库文档（不可逆）。仅用户明确要求删除文档时调用；query 给标题或关键词，找不到会返回现有标题列表。',
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
    case 'remember': return await agentSaveMemory(env, chatId, args.fact, { kind: args.kind, tags: args.tags });
    case 'forget_memory': {
      const kw = String(args.keyword || '').trim();
      if (!kw) return '关键词为空，未删除任何记忆';
      const layer = String(args.layer || 'semantic').toLowerCase();
      const parts = [];
      let persistError = '';
      if (layer === 'semantic' || layer === 'all') {
        const rr = await agentForgetMemory(env, chatId, kw);
        if (rr.persistError) persistError = rr.persistError;
        else if (rr.removed > 0) parts.push(rr.removed + ' 条长期事实');
      }
      if (layer === 'episodic' || layer === 'epi' || layer === 'all') {
        const re = await forgetEpisodes(env, chatId, kw);
        if (re.removed > 0) parts.push(re.removed + ' 条情景记忆');
      }
      if (persistError) return persistError;
      if (!parts.length) {
        return layer === 'episodic' || layer === 'epi'
          ? '未找到包含「' + kw + '」的情景记忆'
          : '未找到包含「' + kw + '」的长期记忆';
      }
      return '已删除 ' + parts.join('、') + '（包含「' + kw + '」）';
    }
    case 'recall_memory': {
      if (String(env.MEMORY_LAYERS || '1') === '0') {
        return '三层记忆已被 MEMORY_LAYERS=0 关闭，本次没有可检索的记忆。请如实告知用户，不要凭空回忆。';
      }
      const r = await recallMemory(env, chatId, args.query, { layer: args.layer, limit: args.count });
      // 命中语义记忆时记录使用度：常用的事实以后更容易被排到前面。
      // 只在这里记（显式检索），不在每轮注入时记 —— 避免每轮都写一次索引。
      if (r.semantic && r.semantic.length) {
        try { await agentTouchMemories(env, chatId, r.semantic.map(m => m.fact)); } catch (e) {}
      }
      return formatRecallResult(r);
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
  // v7.10.2：参数别名归一化放在缓存 key 之前 —— 同一语义的不同写法应命中同一份结果缓存，
  // 也避免模型把 expression 写成 expr 后白跑一步、再靠重试补救。
  args = normalizeToolArgs(name, args);
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
