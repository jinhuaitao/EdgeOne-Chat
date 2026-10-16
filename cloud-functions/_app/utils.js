// 通用工具：有界内存缓存（支持 LRU 顺序与可选 TTL）、逗号分隔解析、定长口令比较

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

export {
  MEM_CACHE_MAX,
  DEFAULT_CACHE_TTL_MS,
  mapSetBounded,
  mapGetBounded,
  parseCommaSeparated,
  safeEqual,
};
