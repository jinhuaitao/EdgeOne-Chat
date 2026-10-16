// PWA Service Worker 源码（含离线页 HTML），由 Worker 运行时下发（_worker.js 原第 2473-2619 行）

// ================= PWA：Service Worker 源码 =================
// ⚠️ 本段位于外层模板字符串内部，只有【一层】转义，但仍需遵守：
//    1) 不得出现反引号（会截断外层模板字符串）—— 一律用单引号 + 字符串拼接；
//    2) 不得出现 ${（会被当成插值）—— 用 + 拼接；
//    3) 不得出现反斜杠 —— 避免二次转义歧义。
// 因此下面的 OFFLINE_HTML 用数组 join 构造，且不含任何内联脚本。
const SW_JS = `/* EdgeOne-Chat Service Worker —— 由 _worker.js 内嵌生成，请勿单独维护此文件 */
const VERSION = '{{PWA_VERSION}}';
const CACHE = 'edgeone-chat-' + VERSION;
const SHELL = '/';

const PRECACHE = [
  '/',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png'
];

const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/marked@4.3.0/marked.min.js',
  'https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js',
  'https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/atom-one-dark.min.css',
  'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js'
];

const CDN_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

const OFFLINE_HTML = [
  '<!DOCTYPE html>',
  '<html lang="zh-CN"><head><meta charset="UTF-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<meta http-equiv="refresh" content="5">',
  '<title>离线中 - EdgeOne-Chat</title>',
  '<style>',
  'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;',
  'background:#f8fafc;color:#0f172a;',
  'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}',
  '.box{text-align:center;padding:40px 32px;max-width:360px}',
  '.dot{width:56px;height:56px;margin:0 auto 20px;border-radius:50%;',
  'background:linear-gradient(135deg,#3b82f6,#6366f1);',
  'display:flex;align-items:center;justify-content:center;color:#fff;font-size:26px;font-weight:700}',
  'h1{font-size:18px;margin:0 0 10px}',
  'p{font-size:13px;color:#475569;line-height:1.7;margin:0}',
  '</style></head><body><div class="box">',
  '<div class="dot">!</div>',
  '<h1>当前处于离线状态</h1>',
  '<p>页面资源已缓存，但网络暂不可用。<br>本页每 5 秒自动重试一次，恢复后会自动刷新。</p>',
  '</div></body></html>'
].join('');

self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    const cache = await caches.open(CACHE);
    // 应用外壳：任一失败不影响整体安装
    await Promise.all(PRECACHE.map(async function (u) {
      try { await cache.add(new Request(u, { cache: 'reload' })); } catch (e) {}
    }));
    // 第三方资源：离线时页面仍要能渲染 Markdown 与代码高亮
    await Promise.all(CDN_ASSETS.map(async function (u) {
      try {
        const res = await fetch(u, { mode: 'cors', credentials: 'omit' });
        if (res && (res.ok || res.type === 'opaque')) await cache.put(u, res);
      } catch (e) {}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    const keys = await caches.keys();
    await Promise.all(keys.map(function (k) {
      if (k !== CACHE && k.indexOf('edgeone-chat-') === 0) return caches.delete(k);
      return Promise.resolve(false);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // 健康探针：显式放行且绝不缓存。
  // 若在此处 respondWith 并缓存，探针会永远「成功」，自动重连将完全失效。
  if (url.pathname === '/healthz') return;

  // 实时接口：直连网络，不缓存
  if (url.pathname.indexOf('/api/') === 0) return;
  if (url.pathname === '/tg-webhook') return;
  // 自诊断端点同样直连网络：它返回的是实时配置与 Telegram 侧状态，缓存毫无意义
  if (url.pathname === '/tg-setup') return;

  // 页面导航：network-first，断网时回退到缓存的页面外壳
  if (req.mode === 'navigate') {
    event.respondWith((async function () {
      const cache = await caches.open(CACHE);
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) cache.put(SHELL, fresh.clone());
        return fresh;
      } catch (e) {
        const cached = await cache.match(SHELL);
        if (cached) return cached;
        return new Response(OFFLINE_HTML, {
          headers: { 'Content-Type': 'text/html;charset=UTF-8' }
        });
      }
    })());
    return;
  }

  // 同源静态资源（图标 / manifest）：cache-first
  if (url.origin === self.location.origin) {
    event.respondWith((async function () {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) cache.put(req, fresh.clone());
        return fresh;
      } catch (e) {
        return Response.error();
      }
    })());
    return;
  }

  // 第三方 CDN：stale-while-revalidate
  if (CDN_HOSTS.indexOf(url.hostname) >= 0) {
    event.respondWith((async function () {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      const network = fetch(req).then(function (res) {
        if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      }).catch(function () { return null; });
      if (cached) return cached;
      const res = await network;
      return res || Response.error();
    })());
  }
});
`;

export {
  SW_JS,
};
