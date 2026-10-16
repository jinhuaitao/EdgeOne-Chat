// PWA 版本号：前端页面 + Service Worker 源码的内容哈希（_worker.js 原第 99-112 行）
import { HTML_CONTENT } from '../ui/index.js';
import { SW_JS } from './service-worker.js';

// PWA 缓存版本号 = 前端页面 + SW 源码的内容哈希。
// 好处：只要改了页面或 SW，版本号自动变化 → 浏览器触发更新 → activate 清掉旧缓存。
// 因为它是纯函数（只依赖源码文本），isolate 重启后依然稳定，不会导致 SW 反复更新。
let cachedPwaVersion = null;
function getPwaVersion() {
  if (cachedPwaVersion) return cachedPwaVersion;
  const s = HTML_CONTENT + SW_JS;
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  }
  cachedPwaVersion = (h >>> 0).toString(36);
  return cachedPwaVersion;
}

export { getPwaVersion };
