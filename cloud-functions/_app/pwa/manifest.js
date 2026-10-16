// PWA Web App Manifest（_worker.js 原第 2450-2471 行）

// ================= PWA：Web App Manifest =================
const MANIFEST_JSON = JSON.stringify({
  name: 'EdgeOne-Chat',
  short_name: 'EO-Chat',
  description: '跑在腾讯云 EdgeOne Makers 上的多通道 AI 对话前端',
  lang: 'zh-CN',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'any',
  background_color: '#f8fafc',
  theme_color: '#3b82f6',
  categories: ['productivity', 'utilities'],
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
  shortcuts: [
    { name: '发起新对话', short_name: '新对话', url: '/?new=1' },
  ],
});

export {
  MANIFEST_JSON,
};
