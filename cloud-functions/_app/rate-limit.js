// 按 IP 滑动窗口限流（实例级内存，轻量防刷）（_worker.js 原第 147-164 行）

// ======= 按 IP 滑动窗口限流（实例级内存，轻量防刷） =======
// 环境变量 RATE_LIMIT_PER_MIN：每 IP 每分钟允许的 /api/chat 请求数，默认 60；设为 0 关闭。
// EdgeOne 注入的客户端 IP 头是 EO-Connecting-IP；同时保留 Cloudflare 的 CF-Connecting-IP，
// 便于同一份代码在两个平台间来回迁移。都取不到时退回 X-Forwarded-For 的第一段。
const rateLimitMap = new Map();
function hitRateLimit(request, env) {
  const perMin = parseInt(env.RATE_LIMIT_PER_MIN || '60', 10);
  if (!(perMin > 0)) return false;
  const ip = request.headers.get('EO-Connecting-IP')
    || request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Real-IP')
    || (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim()
    || 'unknown';
  const now = Date.now();
  let arr = rateLimitMap.get(ip) || [];
  arr = arr.filter(t => now - t < 60000);
  if (arr.length >= perMin) return true;
  arr.push(now);
  // v6.9.5：先 delete 再 set，利用 Map 原生插入序维护最近活跃（LRU）顺序，
  // 满额淘汰时直接从 Map 头部顺序删除最旧的一半，复杂度从 O(N log N) 降为 O(N)。
  if (rateLimitMap.has(ip)) rateLimitMap.delete(ip);
  rateLimitMap.set(ip, arr);
  if (rateLimitMap.size > 5000) {
    const dropTarget = Math.floor(rateLimitMap.size / 2);
    let dropped = 0;
    for (const k of rateLimitMap.keys()) {
      if (dropped >= dropTarget) break;
      if (k === ip) continue;
      rateLimitMap.delete(k);
      dropped++;
    }
  }
  return false;
}

export {
  hitRateLimit,
};
