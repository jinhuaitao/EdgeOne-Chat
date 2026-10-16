// Agent 工具：科学计算器、时间与日期推算、天气、实时汇率/加密币价、维基百科检索

// 安全科学计算器：递归下降解析，支持四则运算、乘方、括号、科学常量（pi/e）与常用数学函数，绝不使用 eval
function toolCalculate(expr) {
  try {
    const s = String(expr || '')
      .replace(/\s+/g, '')
      .replace(/×/g, '*')
      .replace(/÷/g, '/')
      .replace(/（/g, '(')
      .replace(/）/g, ')')
      .replace(/，/g, ',')
      .replace(/π/g, 'pi');
    if (!s) return '表达式为空';
    if (s.length > 500) return '表达式过长（上限 500 字符）';
    if (/[^0-9a-zA-Z_+\-*/%^(),.]/.test(s)) return '表达式含非法字符';

    const FUNCS = {
      sqrt: (a) => Math.sqrt(a[0]),
      cbrt: (a) => Math.cbrt(a[0]),
      abs: (a) => Math.abs(a[0]),
      round: (a) => a.length > 1 ? Number(a[0].toFixed(Math.max(0, Math.min(10, a[1] | 0)))) : Math.round(a[0]),
      floor: (a) => Math.floor(a[0]),
      ceil: (a) => Math.ceil(a[0]),
      sin: (a) => Math.sin(a[0]),
      cos: (a) => Math.cos(a[0]),
      tan: (a) => Math.tan(a[0]),
      asin: (a) => Math.asin(a[0]),
      acos: (a) => Math.acos(a[0]),
      atan: (a) => Math.atan(a[0]),
      ln: (a) => Math.log(a[0]),
      log: (a) => a.length > 1 ? Math.log(a[0]) / Math.log(a[1]) : Math.log10(a[0]),
      log10: (a) => Math.log10(a[0]),
      log2: (a) => Math.log2(a[0]),
      exp: (a) => Math.exp(a[0]),
      pow: (a) => Math.pow(a[0], a[1]),
      min: (a) => Math.min(...a),
      max: (a) => Math.max(...a),
    };
    const CONSTS = {
      pi: Math.PI,
      e: Math.E,
    };

    let i = 0;
    let depth = 0;
    const MAX_DEPTH = 64;
    function enter() {
      depth += 1;
      if (depth > MAX_DEPTH) throw new Error('表达式嵌套过深');
    }
    function leave() { depth -= 1; }
    function parseExpr() {
      enter();
      try { return parseExprBody(); }
      finally { leave(); }
    }
    function parseExprBody() {
      let v = parseTerm();
      while (i < s.length && (s[i] === '+' || s[i] === '-')) {
        const op = s[i++]; const r = parseTerm();
        v = op === '+' ? v + r : v - r;
      }
      return v;
    }
    function parseTerm() {
      let v = parseFactor();
      while (i < s.length && (s[i] === '*' || s[i] === '/' || s[i] === '%')) {
        const op = s[i++]; const r = parseFactor();
        v = op === '*' ? v * r : op === '/' ? v / r : v % r;
      }
      return v;
    }
    function parseFactor() {
      if (s[i] === '-') { i++; return -parseFactor(); }
      if (s[i] === '+') { i++; return parseFactor(); }
      let v = parsePrimary();
      if (i < s.length && s[i] === '^') { i++; v = Math.pow(v, parseFactor()); }
      return v;
    }
    function parsePrimary() {
      if (s[i] === '(') {
        i++;
        const v = parseExpr();
        if (s[i] !== ')') throw new Error('括号不匹配');
        i++;
        return v;
      }
      // 标识符：科学函数调用或常量（pi / e）
      if (/[a-zA-Z_]/.test(s[i])) {
        let j = i;
        while (j < s.length && /[a-zA-Z0-9_]/.test(s[j])) j++;
        const ident = s.slice(i, j).toLowerCase();
        i = j;
        if (s[i] === '(') {
          const fn = FUNCS[ident];
          if (!fn) throw new Error('不支持的函数: ' + ident);
          i++; // skip '('
          const args = [];
          if (s[i] !== ')') {
            args.push(parseExpr());
            while (i < s.length && s[i] === ',') {
              i++;
              args.push(parseExpr());
            }
          }
          if (s[i] !== ')') throw new Error('函数括号不匹配: ' + ident);
          i++;
          if (!args.length) throw new Error('函数缺少参数: ' + ident);
          return fn(args);
        }
        if (Object.prototype.hasOwnProperty.call(CONSTS, ident)) {
          return CONSTS[ident];
        }
        throw new Error('未知常量或标识符: ' + ident);
      }
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      if (j === i) throw new Error('意外的字符: ' + s[i]);
      const numStr = s.slice(i, j);
      if (!/^(\d+\.?\d*|\.\d+)$/.test(numStr)) throw new Error('数字格式非法: ' + numStr);
      const n = parseFloat(numStr);
      i = j;
      // 支持科学记数法字面量，如 1.5e-3 / 2e10（仅当紧跟 e/E 且后接 + / - / 数字）
      if (i < s.length && (s[i] === 'e' || s[i] === 'E') && /[0-9+\-]/.test(s[i + 1] || '')) {
        let k = i + 1;
        if (s[k] === '+' || s[k] === '-') k++;
        const expStart = k;
        while (k < s.length && /[0-9]/.test(s[k])) k++;
        if (k > expStart) {
          const sciVal = parseFloat(numStr + s.slice(i, k));
          i = k;
          if (!isFinite(sciVal)) throw new Error('数字非法');
          return sciVal;
        }
      }
      if (!isFinite(n)) throw new Error('数字非法');
      return n;
    }
    const v = parseExpr();
    if (i !== s.length) throw new Error('表达式未完全解析');
    if (!isFinite(v)) return '计算结果非法（可能除零或结果溢出）';
    const av = Math.abs(v);
    const out = (av >= 1e-6 && av < 1e15) ? Math.round(v * 1e10) / 1e10 : v;
    return '计算结果：' + String(out);
  } catch (e) { return '计算失败: ' + e.message; }
}

// 解析 YYYY-MM-DD 为 UTC 零点毫秒数
function parseIsoDateUtc(str) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(str || '').trim());
  if (!m) return null;
  const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, mo - 1, d);
  const dt = new Date(ms);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return ms;
}

// v7.0.0 增强版时间与日期推算：支持当前时间、两日期间隔天数（target_date）、日期加减天数（add_days）
function toolGetTime(timezone, opts) {
  if (timezone && typeof timezone === 'object') {
    opts = timezone;
    timezone = opts.timezone;
  }
  opts = opts || {};
  const tz = String(timezone || 'Asia/Shanghai').trim() || 'Asia/Shanghai';
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'long'
    });
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(now);
    const y = parts.find(p => p.type === 'year')?.value;
    const mo = parts.find(p => p.type === 'month')?.value;
    const da = parts.find(p => p.type === 'day')?.value;
    const todayIso = `${y}-${mo}-${da}`;

    let out = '当前时间（' + tz + '）：' + fmt.format(now);
    const baseIso = String(opts.base_date || todayIso).trim();
    const baseMs = parseIsoDateUtc(baseIso);

    if (opts.target_date) {
      const targetIso = String(opts.target_date).trim();
      const targetMs = parseIsoDateUtc(targetIso);
      if (baseMs === null || targetMs === null) {
        out += '\n日期格式无效（请使用 YYYY-MM-DD 格式，如 2026-12-31）';
      } else {
        const diffDays = Math.round((targetMs - baseMs) / 86400000);
        const absDays = Math.abs(diffDays);
        const weeks = Math.floor(absDays / 7);
        const remDays = absDays % 7;
        const wkNote = weeks > 0 ? `（即 ${weeks} 周${remDays > 0 ? '零 ' + remDays + ' 天' : ''}）` : '';
        const targetWk = new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', weekday: 'long' }).format(new Date(targetMs));
        out += `\n日期差推算：从 ${baseIso} 到 ${targetIso}（${targetWk}）共相差 ${diffDays} 天${wkNote}`;
      }
    }

    if (opts.add_days !== undefined && opts.add_days !== null && opts.add_days !== '') {
      const delta = parseInt(opts.add_days, 10);
      if (!isNaN(delta) && baseMs !== null) {
        const resMs = baseMs + delta * 86400000;
        const resDate = new Date(resMs);
        const resIso = resDate.toISOString().slice(0, 10);
        const resWk = new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', weekday: 'long' }).format(resDate);
        out += `\n日期加减推算：${baseIso} ${delta >= 0 ? '加上 ' + delta : '减去 ' + Math.abs(delta)} 天后为 ${resIso}（${resWk}）`;
      }
    }

    return out;
  } catch (e) { return '时区无效: ' + tz; }
}

async function fetchJson(url, timeoutMs, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 12000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: headers || {} });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function toolGetWeather(city) {
  city = String(city || '').trim();
  if (!city) return '城市名为空';
  try {
    const g = await fetchJson('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(city) + '&count=1&language=zh&format=json');
    if (!g.results || !g.results.length) return '找不到城市：' + city;
    const loc = g.results[0];
    const w = await fetchJson('https://api.open-meteo.com/v1/forecast?latitude=' + loc.latitude + '&longitude=' + loc.longitude +
      '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m' +
      '&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto&forecast_days=2');
    const wm = { 0: '晴', 1: '大致晴', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇', 51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 61: '小雨', 63: '中雨', 65: '大雨', 71: '小雪', 73: '中雪', 75: '大雪', 80: '阵雨', 81: '阵雨', 82: '暴雨', 95: '雷阵雨' };
    const c = w.current, d = w.daily;
    let t = loc.name + '（' + (loc.country || '') + '）当前：' + (wm[c.weather_code] || '未知') +
      '，' + c.temperature_2m + '°C，体感' + c.apparent_temperature + '°C，湿度' + c.relative_humidity_2m + '%，风速' + c.wind_speed_10m + 'km/h\n';
    t += '今明两天：' + d.time.map((dt, i) => dt.slice(5) + ' ' + (wm[d.weather_code[i]] || '') + ' ' + d.temperature_2m_min[i] + '~' + d.temperature_2m_max[i] + '°C').join('；');
    return t;
  } catch (e) { return '天气查询失败: ' + e.message; }
}

// v7.0.0 新增免密钥工具：实时法币汇率换算 & 主流加密货币实时行情
const CRYPTO_ID_MAP = {
  BTC: 'bitcoin', BITCOIN: 'bitcoin',
  ETH: 'ethereum', ETHEREUM: 'ethereum',
  SOL: 'solana', SOLANA: 'solana',
  BNB: 'binancecoin',
  DOGE: 'dogecoin', DOGECOIN: 'dogecoin',
  XRP: 'ripple',
  ADA: 'cardano',
  TON: 'the-open-network',
  SUI: 'sui',
  TRX: 'tron',
  DOT: 'polkadot',
  AVAX: 'avalanche-2',
  LINK: 'chainlink',
  LTC: 'litecoin',
};

const CURRENCY_ALIASES = {
  '人民币': 'CNY', 'RMB': 'CNY', 'CNH': 'CNY', '元': 'CNY',
  '美元': 'USD', '美金': 'USD', '刀': 'USD',
  '日元': 'JPY', '日币': 'JPY',
  '欧元': 'EUR',
  '英镑': 'GBP',
  '港币': 'HKD', '港元': 'HKD',
  '新台币': 'TWD', '台币': 'TWD',
  '韩元': 'KRW',
  '新币': 'SGD', '新加坡元': 'SGD',
  '澳元': 'AUD', '加元': 'CAD', '瑞士法郎': 'CHF',
};

function normCurrencyCode(c) {
  const raw = String(c || '').trim();
  if (!raw) return '';
  const up = raw.toUpperCase();
  return CURRENCY_ALIASES[raw] || CURRENCY_ALIASES[up] || up;
}

async function toolExchangeRate(args) {
  args = args || {};
  const from = normCurrencyCode(args.from || 'USD');
  const to = normCurrencyCode(args.to || 'CNY');
  const amount = isFinite(parseFloat(args.amount)) && parseFloat(args.amount) > 0 ? parseFloat(args.amount) : 1;
  if (!from || !to) return '汇率查询失败: 请提供源货币与目标货币代码（如 USD、CNY、JPY、BTC）';

  try {
    // 1) 若涉及主流加密货币，走 CoinGecko 免密钥公开接口
    const cryptoId = CRYPTO_ID_MAP[from] || CRYPTO_ID_MAP[to];
    if (cryptoId) {
      const isFromCrypto = !!CRYPTO_ID_MAP[from];
      const fiat = (isFromCrypto ? to : from).toLowerCase();
      const cg = await fetchJson(
        `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(cryptoId)}&vs_currencies=${encodeURIComponent(fiat)},usd,cny&include_24hr_change=true`,
        10000,
        { 'Accept': 'application/json', 'User-Agent': 'EdgeOne-Chat/7.0' }
      );
      const item = cg && cg[cryptoId];
      if (!item) return '汇率查询失败: 未找到加密货币 ' + (isFromCrypto ? from : to) + ' 的实时行情';
      const rate = item[fiat];
      const chg = typeof item[fiat + '_24h_change'] === 'number'
        ? item[fiat + '_24h_change'].toFixed(2) + '%'
        : (typeof item.usd_24h_change === 'number' ? item.usd_24h_change.toFixed(2) + '%' : '未知');
      if (typeof rate === 'number' && rate > 0) {
        const converted = isFromCrypto ? (amount * rate) : (amount / rate);
        return `实时加密行情（CoinGecko）：\n1 ${isFromCrypto ? from : to} = ${rate} ${(isFromCrypto ? to : from)}（USD: $${item.usd || '-'} / CNY: ¥${item.cny || '-'}，24h 涨跌：${chg}）\n换算结果：${amount} ${from} ≈ ${Number(converted.toFixed(6))} ${to}`;
      }
    }

    // 2) 法币汇率：优先 Open ER API（覆盖全球 160+ 币种含 TWD/HKD/KRW/RUB），回退欧洲央行 Frankfurter API
    let rate = null;
    let dateStr = '';
    try {
      const er = await fetchJson(`https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`, 10000);
      if (er && er.rates && typeof er.rates[to] === 'number') {
        rate = er.rates[to];
        dateStr = er.time_last_update_utc ? er.time_last_update_utc.slice(0, 16) : '';
      }
    } catch (e) {}

    if (rate === null) {
      const fk = await fetchJson(`https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(from)}&symbols=${encodeURIComponent(to)}`, 10000);
      if (fk && fk.rates && typeof fk.rates[to] === 'number') {
        rate = fk.rates[to];
        dateStr = fk.date || '';
      }
    }

    if (rate === null) return `汇率查询失败: 暂不支持 ${from} → ${to} 的直接汇率换算`;
    const converted = Math.round(amount * rate * 10000) / 10000;
    return `实时汇率${dateStr ? '（更新：' + dateStr + '）' : ''}：\n1 ${from} = ${rate} ${to}\n换算结果：${amount} ${from} = ${converted} ${to}`;
  } catch (e) {
    return '汇率查询失败: ' + e.message;
  }
}

// v7.0.0 新增免密钥工具：维基百科权威词条检索（自动识别中英文，支持搜索 + 摘要提取）
async function toolWikiLookup(query, lang) {
  query = String(query || '').trim();
  if (!query) return '维基百科查询关键词为空';
  const hasCjk = /[\u4e00-\u9fff]/.test(query);
  const wikiLang = (lang === 'en' || lang === 'zh') ? lang : (hasCjk ? 'zh' : 'en');
  const host = `https://${wikiLang}.wikipedia.org`;
  const headers = {
    'User-Agent': 'EdgeOne-Chat/7.0 (+https://edgeone.ai)',
    'Accept-Language': wikiLang === 'zh' ? 'zh-CN,zh;q=0.9' : 'en-US,en;q=0.9'
  };
  try {
    const searchUrl = `${host}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=3&utf8=1&format=json`;
    const sr = await fetchJson(searchUrl, 10000, headers);
    const hits = (sr && sr.query && sr.query.search) || [];
    if (!hits.length) {
      // 中文无结果时自动回退试一次英文维基
      if (wikiLang === 'zh' && !lang) return await toolWikiLookup(query, 'en');
      return `维基百科未找到「${query}」相关词条`;
    }
    const topTitle = hits[0].title;
    const sumUrl = `${host}/api/rest_v1/page/summary/${encodeURIComponent(topTitle)}`;
    let extract = '';
    let pageUrl = `${host}/wiki/${encodeURIComponent(topTitle)}`;
    try {
      const sum = await fetchJson(sumUrl, 10000, headers);
      if (sum && sum.extract) extract = sum.extract;
      if (sum && sum.content_urls && sum.content_urls.desktop && sum.content_urls.desktop.page) {
        pageUrl = sum.content_urls.desktop.page;
      }
    } catch (e) {}
    if (!extract) {
      extract = String(hits[0].snippet || '').replace(/<[^>]*>/g, '');
    }
    let out = `【维基百科 (${wikiLang})：《${topTitle}》】\n链接：${pageUrl}\n摘要：${extract.slice(0, 2500)}`;
    if (hits.length > 1) {
      out += '\n\n相关词条：\n' + hits.slice(1).map(h => `- 《${h.title}》：${String(h.snippet || '').replace(/<[^>]*>/g, '').slice(0, 120)}`).join('\n');
    }
    return out;
  } catch (e) {
    return '维基百科查询失败: ' + e.message;
  }
}

export {
  toolCalculate,
  toolGetTime,
  toolGetWeather,
  toolExchangeRate,
  toolWikiLookup,
};
