// EdgeOne Makers 路由：/ （站点根路径，返回聊天页面）
// 业务逻辑统一在 _app/entry.js，这里只做一层极薄的转发。

import { handle } from './_app/entry.js';

export default function onRequest(context) {
  return handle(context);
}
