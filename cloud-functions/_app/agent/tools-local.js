// Agent 工具：科学/统计计算器、时间与日期推算、天气、实时汇率/加密币价、维基百科、单位/进制换算、文本/编码工具箱、IP/DNS 网络诊断

// 安全科学计算器：递归下降解析，支持四则运算、乘方、括号、科学常量（pi/e/tau/phi）与 35+ 数学/统计/组合函数，绝不使用 eval
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

    const gcd2 = (x, y) => {
      let u = Math.abs(Math.trunc(x)), v = Math.abs(Math.trunc(y));
      while (v) { const t = v; v = u % v; u = t; }
      return u;
    };
    const factorial = (n) => {
      const k = Math.trunc(n);
      if (k < 0 || k > 170) throw new Error('阶乘参数范围应为 0~170');
      let r = 1;
      for (let idx = 2; idx <= k; idx++) r *= idx;
      return r;
    };

    const FUNCS = {
      sqrt: (a) => Math.sqrt(a[0]),
      cbrt: (a) => Math.cbrt(a[0]),
      abs: (a) => Math.abs(a[0]),
      sign: (a) => Math.sign(a[0]),
      trunc: (a) => Math.trunc(a[0]),
      round: (a) => a.length > 1 ? Number(a[0].toFixed(Math.max(0, Math.min(10, a[1] | 0)))) : Math.round(a[0]),
      floor: (a) => Math.floor(a[0]),
      ceil: (a) => Math.ceil(a[0]),
      sin: (a) => Math.sin(a[0]),
      cos: (a) => Math.cos(a[0]),
      tan: (a) => Math.tan(a[0]),
      asin: (a) => Math.asin(a[0]),
      acos: (a) => Math.acos(a[0]),
      atan: (a) => a.length > 1 ? Math.atan2(a[0], a[1]) : Math.atan(a[0]),
      atan2: (a) => Math.atan2(a[0], a[1]),
      sinh: (a) => Math.sinh(a[0]),
      cosh: (a) => Math.cosh(a[0]),
      tanh: (a) => Math.tanh(a[0]),
      deg: (a) => (a[0] * 180) / Math.PI,
      rad: (a) => (a[0] * Math.PI) / 180,
      ln: (a) => Math.log(a[0]),
      log: (a) => a.length > 1 ? Math.log(a[0]) / Math.log(a[1]) : Math.log10(a[0]),
      log10: (a) => Math.log10(a[0]),
      log2: (a) => Math.log2(a[0]),
      exp: (a) => Math.exp(a[0]),
      pow: (a) => Math.pow(a[0], a[1]),
      hypot: (a) => Math.hypot(...a),
      min: (a) => Math.min(...a),
      max: (a) => Math.max(...a),
      sum: (a) => a.reduce((x, y) => x + y, 0),
      avg: (a) => a.reduce((x, y) => x + y, 0) / a.length,
      mean: (a) => a.reduce((x, y) => x + y, 0) / a.length,
      median: (a) => {
        const sorted = a.slice().sort((x, y) => x - y);
        const mid = sorted.length >> 1;
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      },
      var: (a) => {
        const mu = a.reduce((x, y) => x + y, 0) / a.length;
        return a.reduce((acc, v) => acc + (v - mu) * (v - mu), 0) / a.length;
      },
      std: (a) => {
        const mu = a.reduce((x, y) => x + y, 0) / a.length;
        return Math.sqrt(a.reduce((acc, v) => acc + (v - mu) * (v - mu), 0) / a.length);
      },
      gcd: (a) => a.reduce((x, y) => gcd2(x, y)),
      lcm: (a) => a.reduce((x, y) => {
        const u = Math.abs(Math.trunc(x)), v = Math.abs(Math.trunc(y));
        if (!u || !v) return 0;
        return (u / gcd2(u, v)) * v;
      }),
      fact: (a) => factorial(a[0]),
      factorial: (a) => factorial(a[0]),
      comb: (a) => {
        if (a.length < 2) throw new Error('comb(n,k) 需要 2 个参数');
        let n = Math.trunc(a[0]), k = Math.trunc(a[1]);
        if (k < 0 || n < 0 || k > n) return 0;
        if (k > n - k) k = n - k;
        let r = 1;
        for (let j = 1; j <= k; j++) r = (r * (n - k + j)) / j;
        return Math.round(r);
      },
      ncr: (a) => FUNCS.comb(a),
      perm: (a) => {
        if (a.length < 2) throw new Error('perm(n,k) 需要 2 个参数');
        const n = Math.trunc(a[0]), k = Math.trunc(a[1]);
        if (k < 0 || n < 0 || k > n) return 0;
        let r = 1;
        for (let j = 0; j < k; j++) r *= (n - j);
        return r;
      },
      npr: (a) => FUNCS.perm(a),
    };
    const CONSTS = {
      pi: Math.PI,
      e: Math.E,
      tau: Math.PI * 2,
      phi: (1 + Math.sqrt(5)) / 2,
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
      // 标识符：科学函数调用或常量（pi / e / tau / phi）
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
      '&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max,uv_index_max&timezone=auto&forecast_days=3');
    const wm = { 0: '晴', 1: '大致晴', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇', 51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 61: '小雨', 63: '中雨', 65: '大雨', 71: '小雪', 73: '中雪', 75: '大雪', 80: '阵雨', 81: '阵雨', 82: '暴雨', 95: '雷阵雨' };
    const c = w.current, d = w.daily;
    let t = loc.name + '（' + (loc.country || '') + '）当前：' + (wm[c.weather_code] || '未知') +
      '，' + c.temperature_2m + '°C，体感' + c.apparent_temperature + '°C，湿度' + c.relative_humidity_2m + '%，风速' + c.wind_speed_10m + 'km/h\n';
    const label = d.time.length >= 3 ? '未来三天：' : '今明两天：';
    t += label + d.time.map((dt, i) => {
      let item = dt.slice(5) + ' ' + (wm[d.weather_code[i]] || '') + ' ' + d.temperature_2m_min[i] + '~' + d.temperature_2m_max[i] + '°C';
      const pop = d.precipitation_probability_max && d.precipitation_probability_max[i];
      if (typeof pop === 'number' && pop > 0) item += '（降水概率 ' + pop + '%）';
      return item;
    }).join('；');
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

// ==================== 新增工具 1：全能单位换算与进制转换（toolUnitConvert） ====================
const UNIT_GROUPS = {
  length: {
    mm: 0.001, '毫米': 0.001,
    cm: 0.01, '厘米': 0.01, '公分': 0.01,
    dm: 0.1, '分米': 0.1,
    m: 1, '米': 1, 'meter': 1, 'meters': 1,
    km: 1000, '千米': 1000, '公里': 1000,
    in: 0.0254, 'inch': 0.0254, 'inches': 0.0254, '英寸': 0.0254,
    ft: 0.3048, 'foot': 0.3048, 'feet': 0.3048, '英尺': 0.3048,
    yd: 0.9144, 'yard': 0.9144, 'yards': 0.9144, '码': 0.9144,
    mi: 1609.344, 'mile': 1609.344, 'miles': 1609.344, '英里': 1609.344,
    nmi: 1852, '海里': 1852,
    '里': 500, '华里': 500,
    '丈': 10 / 3,
    '尺': 1 / 3,
    '寸': 1 / 30,
  },
  mass: {
    mg: 1e-6, '毫克': 1e-6,
    g: 0.001, '克': 0.001, 'gram': 0.001,
    kg: 1, '千克': 1, '公斤': 1,
    t: 1000, 'ton': 1000, '吨': 1000,
    oz: 0.028349523125, '盎司': 0.028349523125,
    lb: 0.45359237, 'lbs': 0.45359237, 'pound': 0.45359237, '磅': 0.45359237,
    st: 6.35029318, '英石': 6.35029318,
    '斤': 0.5, '市斤': 0.5,
    '两': 0.05,
    'ct': 0.0002, '克拉': 0.0002,
  },
  area: {
    mm2: 1e-6, '平方毫米': 1e-6,
    cm2: 1e-4, '平方厘米': 1e-4,
    m2: 1, sq_m: 1, sqm: 1, '平方米': 1, '平米': 1,
    km2: 1e6, sq_km: 1e6, '平方千米': 1e6, '平方公里': 1e6,
    sq_ft: 0.09290304, sqft: 0.09290304, '平方英尺': 0.09290304,
    sq_yd: 0.83612736, '平方码': 0.83612736,
    acre: 4046.8564224, '英亩': 4046.8564224,
    ha: 10000, hectare: 10000, '公顷': 10000,
    '亩': 2000 / 3,
    '坪': 400 / 121,
  },
  volume: {
    ml: 0.001, '毫升': 0.001, cc: 0.001,
    l: 1, liter: 1, '升': 1,
    m3: 1000, '立方米': 1000,
    tsp: 0.00492892159375, '茶匙': 0.00492892159375,
    tbsp: 0.01478676478125, '汤匙': 0.01478676478125,
    fl_oz: 0.0295735295625, '液量盎司': 0.0295735295625,
    cup: 0.2365882365, '杯': 0.2365882365,
    pt: 0.473176473, pint: 0.473176473, '品脱': 0.473176473,
    qt: 0.946352946, quart: 0.946352946, '夸脱': 0.946352946,
    gal: 3.785411784, gallon: 3.785411784, '加仑': 3.785411784,
  },
  speed: {
    'm/s': 1, mps: 1, '米每秒': 1,
    'km/h': 1 / 3.6, kph: 1 / 3.6, kmh: 1 / 3.6, '千米每小时': 1 / 3.6, '公里每小时': 1 / 3.6,
    mph: 0.44704, '英里每小时': 0.44704,
    knot: 1852 / 3600, kn: 1852 / 3600, '节': 1852 / 3600,
    mach: 340.3, '马赫': 340.3,
  },
  data: {
    bit: 1 / 8, b: 1 / 8, '比特': 1 / 8,
    byte: 1, B: 1, '字节': 1,
    kb: 1024, kib: 1024,
    mb: 1024 ** 2, mib: 1024 ** 2,
    gb: 1024 ** 3, gib: 1024 ** 3,
    tb: 1024 ** 4, tib: 1024 ** 4,
    pb: 1024 ** 5, pib: 1024 ** 5,
  },
  duration: {
    ms: 0.001, '毫秒': 0.001,
    s: 1, sec: 1, second: 1, seconds: 1, '秒': 1,
    min: 60, minute: 60, minutes: 60, '分': 60, '分钟': 60,
    h: 3600, hr: 3600, hour: 3600, hours: 3600, '小时': 3600,
    d: 86400, day: 86400, days: 86400, '天': 86400,
    wk: 604800, week: 604800, weeks: 604800, '周': 604800,
    yr: 31536000, year: 31536000, years: 31536000, '年': 31536000,
  }
};

const BASE_ALIASES = {
  bin: 2, binary: 2, '二进制': 2, '2': 2,
  oct: 8, octal: 8, '八进制': 8, '8': 8,
  dec: 10, decimal: 10, '十进制': 10, '10': 10,
  hex: 16, hexadecimal: 16, '十六进制': 16, '16': 16,
};

function normTempUnit(u) {
  const s = String(u || '').trim().toLowerCase().replace(/^°/, '');
  if (s === 'c' || s === 'celsius' || s === '摄氏度' || s === '摄氏') return 'C';
  if (s === 'f' || s === 'fahrenheit' || s === '华氏度' || s === '华氏') return 'F';
  if (s === 'k' || s === 'kelvin' || s === '开尔文' || s === '开氏') return 'K';
  return '';
}

function findUnitFactor(u) {
  const raw = String(u || '').trim();
  const lower = raw.toLowerCase();
  for (const [groupName, table] of Object.entries(UNIT_GROUPS)) {
    if (groupName === 'data') {
      if (raw === 'b' || raw === 'bit') return { group: groupName, factor: 1 / 8 };
      if (raw === 'B' || lower === 'byte') return { group: groupName, factor: 1 };
    }
    if (Object.prototype.hasOwnProperty.call(table, raw)) return { group: groupName, factor: table[raw] };
    if (Object.prototype.hasOwnProperty.call(table, lower)) return { group: groupName, factor: table[lower] };
  }
  return null;
}

function toolUnitConvert(args) {
  args = args || {};
  const fromStr = String(args.from || '').trim();
  const toStr = String(args.to || '').trim();
  const valRaw = args.value !== undefined && args.value !== null ? args.value : 1;

  // 1) 进制转换分支（base_from / base_to，或 from/to 为 bin/oct/dec/hex）
  const bFrom = parseInt(args.base_from, 10) || BASE_ALIASES[fromStr.toLowerCase()];
  const bTo = parseInt(args.base_to, 10) || BASE_ALIASES[toStr.toLowerCase()];
  if (bFrom || bTo) {
    const srcBase = bFrom || 10;
    const dstBase = bTo || 10;
    if (srcBase < 2 || srcBase > 36 || dstBase < 2 || dstBase > 36) {
      return '单位换算失败: 进制范围仅支持 2 ~ 36';
    }
    let cleanVal = String(valRaw).trim().replace(/^0[bBoOxX]/, '');
    const neg = cleanVal.startsWith('-');
    if (neg) cleanVal = cleanVal.slice(1);
    if (!cleanVal) return '单位换算失败: 数值为空';
    try {
      const digits = '0123456789abcdefghijklmnopqrstuvwxyz';
      let n = 0n;
      const bigBase = BigInt(srcBase);
      for (const ch of cleanVal.toLowerCase()) {
        const d = digits.indexOf(ch);
        if (d < 0 || d >= srcBase) return `单位换算失败: 字符 "${ch}" 不属于 ${srcBase} 进制`;
        n = n * bigBase + BigInt(d);
      }
      if (neg) n = -n;
      const converted = n.toString(dstBase).toUpperCase();
      return `进制转换结果：\n${neg ? '-' : ''}${cleanVal}（${srcBase} 进制） = ${converted}（${dstBase} 进制）\n常用对照：十进制=${n.toString(10)} | 十六进制=0x${(n < 0n ? (-n) : n).toString(16).toUpperCase()} | 二进制=0b${(n < 0n ? (-n) : n).toString(2)}`;
    } catch (e) {
      return '单位换算失败: ' + e.message;
    }
  }

  const num = parseFloat(valRaw);
  if (!isFinite(num)) return '单位换算失败: 请输入有效数值';
  if (!fromStr || !toStr) return '单位换算失败: 请提供源单位（from）与目标单位（to）';

  // 2) 温度换算分支
  const tFrom = normTempUnit(fromStr);
  const tTo = normTempUnit(toStr);
  if (tFrom && tTo) {
    let celsius = num;
    if (tFrom === 'F') celsius = (num - 32) * (5 / 9);
    else if (tFrom === 'K') celsius = num - 273.15;
    let res = celsius;
    if (tTo === 'F') res = celsius * (9 / 5) + 32;
    else if (tTo === 'K') res = celsius + 273.15;
    const rounded = Math.round(res * 1e6) / 1e6;
    return `温度换算结果：${num} °${tFrom} = ${rounded} °${tTo}`;
  }

  // 3) 物理/数据/时间单位换算
  const u1 = findUnitFactor(fromStr);
  const u2 = findUnitFactor(toStr);
  if (!u1 || !u2) {
    return `单位换算失败: 未识别的单位（${!u1 ? fromStr : toStr}）。支持长度(m/km/ft/mi/寸/尺)、重量(g/kg/lb/oz/斤/两)、温度(C/F/K)、面积(m2/acre/亩/坪)、体积(ml/l/gal/fl_oz)、速度(m/s,km/h,mph,knot)、数据容量(B/KB/MB/GB/TB)及 2~36 进制转换。`;
  }
  if (u1.group !== u2.group) {
    return `单位换算失败: ${fromStr}（${u1.group}）与 ${toStr}（${u2.group}）不属于同一物理量纲，无法直接换算`;
  }
  const baseVal = num * u1.factor;
  const resVal = baseVal / u2.factor;
  const formatted = (Math.abs(resVal) >= 1e-6 && Math.abs(resVal) < 1e15)
    ? Number(resVal.toFixed(8))
    : resVal;
  return `单位换算结果：${num} ${fromStr} = ${formatted} ${toStr}`;
}

// ==================== 新增工具 2：文本/编码/哈希/UUID 工具箱（toolTextToolkit） ====================
async function toolTextToolkit(args) {
  args = args || {};
  const action = String(args.action || 'stats').trim().toLowerCase();
  const text = String(args.text !== undefined && args.text !== null ? args.text : '');

  try {
    if (action === 'uuid') {
      const cnt = Math.min(Math.max(parseInt(args.count, 10) || 1, 1), 10);
      const list = [];
      for (let i = 0; i < cnt; i++) {
        if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
          list.push(globalThis.crypto.randomUUID());
        } else {
          list.push('xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            const v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
          }));
        }
      }
      return '生成的 UUID (v4)：\n' + list.join('\n');
    }

    if (action === 'hash' || action === 'sha256' || action === 'sha1' || action === 'sha512') {
      const algoRaw = String(args.algorithm || (action === 'hash' ? 'SHA-256' : action)).toUpperCase();
      const algo = algoRaw === 'SHA1' || algoRaw === 'SHA-1' ? 'SHA-1'
        : algoRaw === 'SHA384' || algoRaw === 'SHA-384' ? 'SHA-384'
        : algoRaw === 'SHA512' || algoRaw === 'SHA-512' ? 'SHA-512'
        : 'SHA-256';
      const bytes = new TextEncoder().encode(text);
      const subtle = (globalThis.crypto && globalThis.crypto.subtle) || null;
      if (subtle) {
        const buf = await subtle.digest(algo, bytes);
        const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
        return `哈希摘要（${algo}）：\n${hex}`;
      }
      // 纯 JS SHA-256 兜底（兼容未暴露 globalThis.crypto.subtle 的运行时）
      const K = [
        0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
      ];
      const rotr = (n, x) => (x >>> n) | (x << (32 - n));
      const l = bytes.length;
      const bitLen = l * 8;
      const padLen = ((l + 9 + 63) & ~63);
      const buf = new Uint8Array(padLen);
      buf.set(bytes);
      buf[l] = 0x80;
      const dv = new DataView(buf.buffer);
      dv.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);
      dv.setUint32(padLen - 4, bitLen >>> 0, false);
      let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
      let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
      const W = new Uint32Array(64);
      for (let off = 0; off < padLen; off += 64) {
        for (let t = 0; t < 16; t++) W[t] = dv.getUint32(off + t * 4, false);
        for (let t = 16; t < 64; t++) {
          const s0 = rotr(7, W[t - 15]) ^ rotr(18, W[t - 15]) ^ (W[t - 15] >>> 3);
          const s1 = rotr(17, W[t - 2]) ^ rotr(19, W[t - 2]) ^ (W[t - 2] >>> 10);
          W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
        }
        let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
        for (let t = 0; t < 64; t++) {
          const S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
          const ch = (e & f) ^ (~e & g);
          const temp1 = (h + S1 + ch + K[t] + W[t]) >>> 0;
          const S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
          const maj = (a & b) ^ (a & c) ^ (b & c);
          const temp2 = (S0 + maj) >>> 0;
          h = g; g = f; f = e; e = (d + temp1) >>> 0;
          d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
        }
        h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
        h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
      }
      const hex = [h0, h1, h2, h3, h4, h5, h6, h7].map(v => v.toString(16).padStart(8, '0')).join('');
      return `哈希摘要（SHA-256）：\n${hex}`;
    }

    if (action === 'base64_encode') {
      const bytes = new TextEncoder().encode(text);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return 'Base64 编码结果：\n' + btoa(bin);
    }

    if (action === 'base64_decode') {
      const bin = atob(text.trim());
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return 'Base64 解码结果：\n' + new TextDecoder('utf-8').decode(bytes);
    }

    if (action === 'url_encode') {
      return 'URL 编码结果：\n' + encodeURIComponent(text);
    }

    if (action === 'url_decode') {
      return 'URL 解码结果：\n' + decodeURIComponent(text);
    }

    // 默认 stats：精确统计字符数、中文字符数、英文单词数、行数与 UTF-8 字节数
    const codePoints = Array.from(text);
    const totalChars = codePoints.length;
    const noSpaceChars = codePoints.filter(c => !/\s/.test(c)).length;
    const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
    const enWords = (text.match(/[a-zA-Z]+(?:'[a-zA-Z]+)?/g) || []).length;
    const digits = (text.match(/[0-9]/g) || []).length;
    const lines = text ? text.split(/\r?\n/).length : 0;
    const utf8Bytes = new TextEncoder().encode(text).byteLength;

    return `文本精确统计结果：\n- 总字符数（含空格）：${totalChars}\n- 非空白字符数：${noSpaceChars}\n- 中文汉字数：${cjkChars}\n- 英文单词数：${enWords}\n- 数字字符数：${digits}\n- 行数：${lines}\n- UTF-8 字节数：${utf8Bytes} Bytes`;
  } catch (e) {
    return '文本工具执行失败: ' + e.message;
  }
}

// ==================== 新增工具 3：IP 归属地 / ASN 与域名 DNS 解析（toolNetworkLookup） ====================
async function toolNetworkLookup(args) {
  args = args || {};
  const target = String(args.target || args.ip || args.domain || '').trim();
  if (!target) return '网络查询失败: 请提供要查询的 IP 地址或域名';

  const isIpv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(target);
  const isIpv6 = target.indexOf(':') !== -1 && /^[0-9a-fA-F:]+$/.test(target);

  try {
    if (isIpv4 || isIpv6) {
      const info = await fetchJson(`https://ipwho.is/${encodeURIComponent(target)}`, 10000, {
        'User-Agent': 'EdgeOne-Chat/7.0'
      });
      if (!info || info.success === false) {
        return '网络查询失败: ' + ((info && info.message) || '无法解析该 IP 归属信息');
      }
      const conn = info.connection || {};
      const tz = info.timezone || {};
      return `【IP 归属地与网络信息：${info.ip || target}】\n`
        + `- 地区：${[info.country, info.region, info.city].filter(Boolean).join(' · ') || '未知'}\n`
        + `- 运营商 / ISP：${conn.isp || conn.org || '未知'}\n`
        + `- 自治系统 (ASN)：${conn.asn ? 'AS' + conn.asn + (conn.org ? ' (' + conn.org + ')' : '') : '未知'}\n`
        + `- 经纬度：${info.latitude ?? '-'}, ${info.longitude ?? '-'}\n`
        + `- 时区：${tz.id || '-'}${tz.utc ? ' (UTC' + tz.utc + ')' : ''}`;
    }

    // 域名 DNS 解析（使用 Google Public DNS-over-HTTPS）
    const cleanDomain = target.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0];
    const recType = String(args.record_type || 'A').trim().toUpperCase();
    const validTypes = new Set(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA']);
    const type = validTypes.has(recType) ? recType : 'A';

    const dns = await fetchJson(
      `https://dns.google/resolve?name=${encodeURIComponent(cleanDomain)}&type=${encodeURIComponent(type)}`,
      10000,
      { 'Accept': 'application/json', 'User-Agent': 'EdgeOne-Chat/7.0' }
    );
    const answers = (dns && Array.isArray(dns.Answer)) ? dns.Answer : [];
    if (!answers.length) {
      return `域名 ${cleanDomain} 未查到 ${type} 记录（DNS Status: ${dns && dns.Status !== undefined ? dns.Status : '未知'}）`;
    }
    let out = `【域名 DNS 解析：${cleanDomain} (${type})】\n`
      + answers.slice(0, 10).map(a => `- ${a.name} [TTL ${a.TTL}s] → ${a.data}`).join('\n');

    // 若查询 A 记录且拿到首个 IPv4，顺带附加上该 IP 的归属地与 ASN
    const firstIp = answers.find(a => a && a.type === 1 && /^(\d{1,3}\.){3}\d{1,3}$/.test(String(a.data || '')));
    if (firstIp) {
      try {
        const ipInfo = await fetchJson(`https://ipwho.is/${encodeURIComponent(firstIp.data)}`, 6000, {
          'User-Agent': 'EdgeOne-Chat/7.0'
        });
        if (ipInfo && ipInfo.success !== false) {
          const c = ipInfo.connection || {};
          out += `\n\n首跳节点归属（${firstIp.data}）：${[ipInfo.country, ipInfo.region, ipInfo.city].filter(Boolean).join(' ')} · ${c.isp || c.org || ''}${c.asn ? ' (AS' + c.asn + ')' : ''}`;
        }
      } catch (e) {}
    }
    return out;
  } catch (e) {
    return '网络查询失败: ' + e.message;
  }
}

export {
  toolCalculate,
  toolGetTime,
  toolGetWeather,
  toolExchangeRate,
  toolWikiLookup,
  toolUnitConvert,
  toolTextToolkit,
  toolNetworkLookup,
};
