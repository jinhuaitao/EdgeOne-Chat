// UI 代码：页面内容按段落拆分在 src/ui/ 下，这里按原始顺序拼回同一个字符串
// 彻底清除了前端代码中所有可能被转义破坏的反引号，确保100%部署通过

import HEAD_HTML from './head.js';
import STYLES_HTML from './styles.js';
import BODY_HTML from './body.js';
import APP_CORE_HTML from './app-core.js';
import APP_TTS_HTML from './app-tts.js';
import APP_MESSAGE_ACTIONS_HTML from './app-message-actions.js';
import APP_STATE_HTML from './app-state.js';
import APP_DIALOGS_HTML from './app-dialogs.js';
import APP_RENDER_HTML from './app-render.js';
import APP_SEND_HTML from './app-send.js';
import APP_SETTINGS_HTML from './app-settings.js';
import APP_PWA_HTML from './app-pwa.js';

export const HTML_CONTENT =
  HEAD_HTML
  + STYLES_HTML
  + BODY_HTML
  + APP_CORE_HTML
  + APP_TTS_HTML
  + APP_MESSAGE_ACTIONS_HTML
  + APP_STATE_HTML
  + APP_DIALOGS_HTML
  + APP_RENDER_HTML
  + APP_SEND_HTML
  + APP_SETTINGS_HTML
  + APP_PWA_HTML;
