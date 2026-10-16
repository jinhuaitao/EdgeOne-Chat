// /api/chat 访问口令校验（_worker.js 原第 131-145 行）

import { safeEqual } from './utils.js';
import { CORS_HEADERS } from './constants.js';

// /api/chat 访问口令校验
// 未配置 ACCESS_PASSWORD 时返回 null（直接放行，行为与从前一致）；
// 配置后要求请求头 X-Access-Token 与之一致，否则返回 401。
function denyUnauthorized(env, request) {
  const required = env.ACCESS_PASSWORD;
  if (!required) return null;

  const provided = request.headers.get('X-Access-Token') || '';
  if (safeEqual(provided, required)) return null;

  return new Response(JSON.stringify({
    error: "访问口令错误或未提供",
    code: "UNAUTHORIZED",
  }), { status: 401, headers: CORS_HEADERS });
}

export {
  denyUnauthorized,
};
