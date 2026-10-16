// EdgeOne Makers 路由：/*（兜底路由，接管所有未命中静态资源的请求）
//
// 覆盖：/api/chat、/tg-webhook、/sw.js、/manifest.webmanifest、/healthz、
//       /icon-192.png、/icon-512.png、/icon-maskable-512.png、以及自定义的 VERIFY_FILE_PATH。
//
// 注意：EdgeOne 的路由匹配是「更具体的路由优先」，且静态资源优先于函数。
// 因此本项目里真实存在的静态文件（如 /tts-demo.html）会走静态资源，不会进到这里，这是预期行为。

import { handle } from './_app/entry.js';

export default function onRequest(context) {
  return handle(context);
}
