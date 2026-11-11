// 通用工具：有界内存缓存（支持 LRU 顺序与可选 TTL）、逗号分隔解析、定长口令比较、
// 以及 UTF-16 代理项安全的截断与清理（v7.10.4）。

// v6.8.1 有界内存缓存：isolate 常驻时 Map 只增不减会缓慢泄漏。
// v6.9.5 增强：
//  1) 写入时先 delete 再 set，使 Map 保持最近活跃（LRU）顺序；
//  2) 支持可选 TTL（通过附加时间戳 Map 校验过期），缓解多 isolate 下 L1 缓存永不过期导致的脏读。
const MEM_CACHE_MAX = 2000;
const DEFAULT_CACHE_TTL_MS = 60 * 1000; // 默认 L1 缓存 60 秒过期回源 R2

function mapSetBounded(map, key, value, max, expMap, ttlMs) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  if (expMap) {
    const ttl = ttlMs > 0 ? ttlMs : DEFAULT_CACHE_TTL_MS;
    expMap.set(key, Date.now() + ttl);
  }
  const limit = max > 0 ? max : MEM_CACHE_MAX;
  for (const k of map.keys()) {
    if (map.size <= limit) break;
    if (k === key) continue;
    map.delete(k);
    if (expMap) expMap.delete(k);
  }
}

function mapGetBounded(map, key, expMap) {
  if (!map.has(key)) return undefined;
  if (expMap) {
    const exp = expMap.get(key);
    if (typeof exp === 'number' && Date.now() > exp) {
      map.delete(key);
      expMap.delete(key);
      return undefined;
    }
  }
  return map.get(key);
}

function parseCommaSeparated(str) {
  if (!str) return [];
  return str.split(',').map(s => s.trim()).filter(Boolean);
}

// v6.9.5 加固：定长比较，消除长度不一致时提前返回导致的口令长度侧信道泄露
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] || 0) ^ (bb[i] || 0);
  }
  return diff === 0;
}

// ==================== UTF-16 代理项安全（v7.10.4） ====================
// 事故背景：上游报 "JSON syntax error: ... messages[0].content: unexpected end of
// hex escape at line 1 column 8887"。根因是 somewhere 按 code unit 截断，把 emoji
// 之类的增补平面字符切成半个代理项。JSON.stringify 会把孤立代理项输出成 \ud83d
// 这种转义 —— Node/V8 的 JSON.parse 能容忍，但 vLLM / SGLang / llama.cpp 等用
// 严格 C++ 解析器的推理服务读到孤立高代理项后会期待紧跟一个 \uXXXX 低代理项，
// 等不到就报「hex escape 意外结束」。本地自检全绿、线上偶发失败，正是这个原因。
function isHighSurrogate(c) { return c >= 0xd800 && c <= 0xdbff; }
function isLowSurrogate(c) { return c >= 0xdc00 && c <= 0xdfff; }

// 按 code unit 截断，但绝不在代理对中间下刀。
function safeSlice(s, max) {
  const str = String(s == null ? '' : s);
  if (!(max > 0) || str.length <= max) return str;
  let cut = max;
  if (isHighSurrogate(str.charCodeAt(cut - 1))) cut -= 1;
  return str.slice(0, cut);
}

// 清掉已经存在的孤立代理项（可能来自前端、上游流、旧数据或第三方接口）。
// 合法的成对代理项（正常 emoji）原样保留。快路径让绝大多数文本零开销。
function stripLoneSurrogates(s) {
  const str = String(s == null ? '' : s);
  if (!/[\uD800-\uDFFF]/.test(str)) return str;
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (isHighSurrogate(c)) {
      const n = str.charCodeAt(i + 1);
      if (isLowSurrogate(n)) { out += str[i] + str[i + 1]; i++; }
      // 孤立高代理项：丢弃
    } else if (isLowSurrogate(c)) {
      // 孤立低代理项：丢弃
    } else {
      out += str[i];
    }
  }
  return out;
}

export {
  MEM_CACHE_MAX,
  DEFAULT_CACHE_TTL_MS,
  mapSetBounded,
  mapGetBounded,
  parseCommaSeparated,
  safeEqual,
  safeSlice,
  stripLoneSurrogates,
};
