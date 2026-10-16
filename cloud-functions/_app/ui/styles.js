// 页面样式：设计令牌、布局、深浅色主题（_worker.js 原第 2647-3372 行，内嵌页面分片；只允许字符串导出）
export default `  <style>
    /* ============================================================
       设计令牌（浅色 / 深色）
       与原页面内联样式引用的旧变量名（--text-secondary / --brand-color 等）
       保持别名映射，避免改动任何内联 style。
       ============================================================ */
    :root {
      --bg: #ffffff;
      --bg-soft: #f7f7f8;
      --panel: #ffffff;
      --border: #e6e7eb;
      --border-strong: #d3d5dc;
      --text: #14161c;
      --text-2: #4a4f5c;
      --muted: #8b90a0;
      --accent: #2563eb;
      --accent-2: #7c3aed;
      --accent-gradient: linear-gradient(135deg, #2563eb, #7c3aed);
      --accent-soft: #eef3ff;
      --user-bubble: #f1f2f6;
      --danger: #dc2626;
      --shadow: 0 1px 2px rgba(16, 18, 24, .06), 0 8px 24px rgba(16, 18, 24, .06);
      --code-bg: #12141a;
      --code-text: #e8eaf0;
      --radius: 14px;
      --hover: rgba(127, 140, 170, .14);
      --warn-bg: #fff8e6;
      --warn-border: #efd08a;
      --warn-text: #7a5300;

      /* —— 兼容旧变量名（内联 style 与脚本里仍在引用） —— */
      --bg-base: var(--bg);
      --text-main: var(--text);
      --text-secondary: var(--text-2);
      --brand-color: var(--accent);
      --brand-gradient: var(--accent);
      --glass-bg: var(--panel);
      --glass-border: var(--border);
      --glass-shadow: var(--shadow);
      --hover-bg: var(--hover);
      --input-bg: var(--panel);
      --border-radius: var(--radius);
      --user-msg: var(--user-bubble);
      --user-text: var(--text);
    }

    /* 主题由脚本设在 document.body 上（applyTheme），故选择器用 body[...] */
    body[data-theme="dark"] {
      --bg: #0c0e13;
      --bg-soft: #13161d;
      --panel: #13161d;
      --border: #262a35;
      --border-strong: #333846;
      --text: #e9ebf1;
      --text-2: #b6bbc8;
      --muted: #868c9b;
      --accent: #4d8dff;
      --accent-2: #a78bfa;
      --accent-gradient: linear-gradient(135deg, #4d8dff, #a78bfa);
      --accent-soft: #17203a;
      --user-bubble: #1c2029;
      --danger: #f87171;
      --shadow: 0 1px 2px rgba(0, 0, 0, .4), 0 8px 24px rgba(0, 0, 0, .35);
      --code-bg: #0a0c11;
      --code-text: #e8eaf0;
      --hover: rgba(127, 140, 170, .18);
      --warn-bg: #2b2312;
      --warn-border: #6b5423;
      --warn-text: #f0d089;
    }

    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    html, body { height: 100%; margin: 0; }

    body {
      background: var(--bg);
      color: var(--text);
      font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB",
            "Microsoft YaHei", Roboto, Helvetica, Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
      overflow: hidden;
    }

    button, input, select, textarea { font: inherit; color: inherit; }

    ::-webkit-scrollbar { width: 9px; height: 9px; }
    ::-webkit-scrollbar-thumb { background: rgba(127, 140, 170, .34); border-radius: 8px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(127, 140, 170, .55); }
    ::-webkit-scrollbar-track { background: transparent; }

    /* ---------------- 离线提示条 ---------------- */
    .offline-banner {
      position: fixed; top: 0; left: 0; right: 0; z-index: 9999;
      display: flex; align-items: center; justify-content: center; gap: 10px;
      padding: 10px 16px; font-size: 13px; font-weight: 600; letter-spacing: .2px;
      color: var(--warn-text);
      background: var(--warn-bg);
      border-bottom: 1px solid var(--warn-border);
      box-shadow: 0 4px 18px rgba(16, 18, 24, .10);
      transform: translateY(-105%);
      transition: transform .32s cubic-bezier(.4, 0, .2, 1);
      pointer-events: none;
    }
    .offline-banner.show { transform: translateY(0); }
    .offline-banner .spin { animation: offlineSpin 1s linear infinite; flex-shrink: 0; }
    @keyframes offlineSpin { to { transform: rotate(360deg); } }

    /* ---------------- 整体布局 ---------------- */
    .app-container {
      display: flex;
      height: 100dvh;
      width: 100%;
      overflow: hidden;
      background: var(--bg);
    }

    /* ---------------- 侧边栏 ---------------- */
    .sidebar {
      width: 268px;
      flex: 0 0 268px;
      display: flex;
      flex-direction: column;
      min-height: 0;
      background: var(--bg-soft);
      border-right: 1px solid var(--border);
    }

    .sidebar-header { padding: 14px 12px 8px; }

    .brand {
      display: flex; align-items: center; gap: 9px;
      padding: 4px 8px 14px;
      font-weight: 650; font-size: 15px; letter-spacing: .2px;
    }
    .brand-dot {
      width: 22px; height: 22px; border-radius: 7px;
      background: var(--accent-gradient); color: #fff;
      display: grid; place-items: center;
      font-size: 12px; font-weight: 700;
      flex-shrink: 0;
    }
    .brand-name {
      background: linear-gradient(120deg, var(--text) 20%, var(--accent) 95%);
      -webkit-background-clip: text; background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .new-chat-btn {
      width: 100%;
      display: flex; align-items: center; justify-content: center; gap: 8px;
      border: 1px solid var(--accent);
      background: var(--accent);
      color: #fff;
      border-radius: 10px;
      padding: 9px 12px;
      font-size: 13.5px; font-weight: 550;
      cursor: pointer;
      transition: filter .12s ease;
    }
    .new-chat-btn:hover { filter: brightness(1.06); }

    .session-list {
      flex: 1;
      overflow-y: auto;
      padding: 4px 8px 8px;
      min-height: 0;
    }

    .session-item {
      position: relative;
      display: flex; align-items: center; gap: 8px;
      padding: 9px 10px;
      border-radius: 10px;
      cursor: pointer;
      color: var(--text-2);
      transition: background .12s ease, color .12s ease;
    }
    .session-item:hover { background: var(--hover); color: var(--text); }
    .session-item.active { background: var(--accent-soft); color: var(--accent); font-weight: 550; }
    .session-item::before {
      content: '';
      position: absolute; left: 0; top: 22%; bottom: 22%;
      width: 3px; border-radius: 2px;
      background: var(--accent);
      opacity: 0;
      transition: opacity .14s ease;
    }
    .session-item.active::before { opacity: 1; }

    .session-title {
      flex: 1; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-size: 14px;
    }

    .delete-btn {
      border: 0; background: transparent; cursor: pointer;
      color: var(--muted);
      display: grid; place-items: center;
      padding: 3px; border-radius: 6px;
      opacity: 0;
      transition: opacity .12s ease, background .12s ease, color .12s ease;
    }
    .session-item:hover .delete-btn { opacity: 1; }
    .delete-btn:hover { background: rgba(220, 38, 38, .14); color: var(--danger); }

    .sidebar-footer {
      border-top: 1px solid var(--border);
      padding: 10px 12px 12px;
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
    }
    .side-tools { display: flex; gap: 2px; flex-shrink: 0; }
    .side-version { font-size: 11.5px; color: var(--muted); white-space: nowrap; flex-shrink: 0; }

    .theme-toggle {
      width: 32px; height: 32px;
      border: 1px solid transparent; border-radius: 9px;
      background: transparent; color: var(--text-2);
      display: grid; place-items: center;
      cursor: pointer;
      transition: background .12s ease, color .12s ease;
    }
    .theme-toggle:hover { background: var(--hover); color: var(--text); }
    .theme-toggle.active { background: var(--accent-soft); color: var(--accent); }
    .theme-toggle[hidden] { display: none; }

    .sidebar-overlay {
      display: none;
      position: fixed; inset: 0; z-index: 40;
      background: rgba(10, 12, 18, .45);
    }
    .sidebar-overlay.active { display: block; }

    /* ---------------- 主区域 ---------------- */
    .chat-area {
      flex: 1; min-width: 0;
      display: flex; flex-direction: column;
      min-height: 0;
      background: var(--bg);
    }

    .header {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      min-height: 54px;
      flex-shrink: 0;
    }
    .header-inner { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; }

    .menu-toggle {
      display: none;
      border: 1px solid transparent; border-radius: 10px;
      background: transparent; color: var(--text-2);
      padding: 6px 9px; cursor: pointer;
      transition: background .12s ease, color .12s ease;
      flex-shrink: 0;
    }
    .menu-toggle:hover { background: var(--hover); color: var(--text); }

    .header-title {
      flex: 1; min-width: 0;
      display: flex; align-items: center; gap: 8px;
      font-weight: 550; font-size: 14.5px;
    }
    .header-title span {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }

    .status-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #10b981; flex-shrink: 0;
      transition: background .3s ease;
    }
    .status-dot.generating {
      background: var(--accent);
      animation: breathing 1.5s infinite;
    }
    @keyframes breathing {
      0%   { box-shadow: 0 0 0 0 rgba(37, 99, 235, .45); }
      70%  { box-shadow: 0 0 0 8px rgba(37, 99, 235, 0); }
      100% { box-shadow: 0 0 0 0 rgba(37, 99, 235, 0); }
    }

    /* ---------------- 消息区 ---------------- */
    .messages-container {
      flex: 1;
      overflow-y: auto; overflow-x: hidden;
      min-height: 0;
      padding: 8px 20px 20px;
      scroll-behavior: smooth;
    }

    .messages {
      max-width: 820px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
    }

    .scroll-bottom-btn {
      position: sticky;
      bottom: 12px;
      z-index: 5;
      width: 36px; height: 36px;
      margin: -48px auto 0;
      padding: 0;
      border: 1px solid var(--border);
      border-radius: 50%;
      background: var(--panel);
      color: var(--text-2);
      display: grid; place-items: center;
      cursor: pointer;
      box-shadow: var(--shadow);
      opacity: 0; visibility: hidden; pointer-events: none;
      transform: translateY(6px);
      transition: opacity .18s ease, visibility .18s ease, transform .18s ease, color .12s ease, border-color .12s ease;
    }
    .scroll-bottom-btn.show {
      opacity: 1; visibility: visible; pointer-events: auto;
      transform: translateY(0);
    }
    .scroll-bottom-btn:hover { color: var(--accent); border-color: var(--accent); }
    .scroll-bottom-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .scroll-bottom-btn svg { width: 18px; height: 18px; }

    .message-row {
      display: flex;
      gap: 13px;
      padding: 18px 0;
      animation: slideUp .3s ease both;
    }
    @keyframes slideUp {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: none; }
    }

    .message-row::before {
      content: 'AI';
      flex: 0 0 30px;
      width: 30px; height: 30px;
      border-radius: 9px;
      background: var(--accent);
      color: #fff;
      display: grid; place-items: center;
      font-size: 12px; font-weight: 650;
      user-select: none;
    }
    .message-row.user::before {
      content: '你';
      background: var(--user-bubble);
      color: var(--text-2);
    }

    .message-bubble {
      flex: 1; min-width: 0;
      font-size: 15px; line-height: 1.7;
      overflow-wrap: anywhere; word-break: break-word;
    }
    .message-row.user .message-bubble {
      background: var(--user-bubble);
      border-radius: 14px;
      padding: 11px 15px;
      white-space: pre-wrap;
    }
    .message-row.ai .message-bubble { padding-top: 3px; }
    .message-row.error-msg .message-bubble { color: var(--danger); }

    /* ---------------- Markdown 正文 ---------------- */
    .markdown-body { overflow-wrap: anywhere; }
    .markdown-body > :first-child { margin-top: 0; }
    .markdown-body > :last-child { margin-bottom: 0; }
    .markdown-body p { margin: 0 0 12px; }
    .markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4 {
      margin: 20px 0 10px; line-height: 1.35; font-weight: 650;
    }
    .markdown-body h1 { font-size: 20px; }
    .markdown-body h2 { font-size: 18px; }
    .markdown-body h3 { font-size: 16.5px; }
    .markdown-body h4 { font-size: 15.5px; }
    .markdown-body ul, .markdown-body ol { margin: 0 0 12px; padding-left: 22px; }
    .markdown-body li { margin: 4px 0; }
    .markdown-body a {
      color: var(--accent); text-decoration: none;
      border-bottom: 1px solid transparent;
      word-break: break-all;
    }
    .markdown-body a:hover { border-bottom-color: currentColor; }
    .markdown-body hr { border: 0; border-top: 1px solid var(--border); margin: 18px 0; }
    .markdown-body blockquote {
      margin: 0 0 12px;
      padding: 4px 0 4px 14px;
      border-left: 3px solid var(--border-strong);
      color: var(--text-2);
    }
    .markdown-body blockquote p { margin: 4px 0; }
    .markdown-body code {
      background: var(--hover);
      padding: 1.5px 5px; border-radius: 5px;
      font-size: .9em;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .markdown-body del { color: var(--muted); }
    .markdown-body table {
      display: block; overflow-x: auto; white-space: nowrap;
      border-collapse: collapse; margin: 0 0 12px; width: 100%; font-size: 14px;
    }
    .markdown-body th, .markdown-body td {
      border: 1px solid var(--border); padding: 6px 10px; text-align: left;
    }
    .markdown-body img { max-width: 100%; height: auto; border-radius: 10px; margin-top: 8px; border: 1px solid var(--border); }
    .md-img-link { display: inline-block; max-width: 100%; line-height: 0; }
    .md-img-link img { cursor: zoom-in; margin-top: 0; }

    /* ---------------- 代码块 ---------------- */
    .code-wrapper {
      margin: 0 0 14px;
      border-radius: 12px;
      overflow: hidden;
      border: 1px solid var(--border);
      background: var(--code-bg);
    }
    .code-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 6px 10px 6px 13px;
      font-size: 11.5px; letter-spacing: .4px; text-transform: uppercase;
      color: #8f97a8;
      background: rgba(255, 255, 255, .045);
    }
    .code-header > span:first-child {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .copy-btn {
      display: inline-flex; align-items: center; gap: 5px;
      border: 1px solid transparent; border-radius: 7px;
      background: transparent; color: #a7aebd;
      font-size: 11.5px; letter-spacing: 0;
      padding: 4px 8px; cursor: pointer;
      transition: background .12s ease, color .12s ease;
    }
    .copy-btn:hover { background: rgba(255, 255, 255, .12); color: #fff; }
    .copy-btn svg { display: block; flex-shrink: 0; }
    .code-wrapper pre {
      margin: 0; padding: 13px 15px;
      overflow-x: auto; background: transparent;
    }
    .code-wrapper pre code {
      background: transparent; padding: 0;
      color: var(--code-text);
      font-size: 13px; line-height: 1.62;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: pre;
    }

    /* ---------------- 推理过程 / 工具轨迹胶囊 / 消息操作 ---------------- */
    .reasoning-box {
      font-size: 13.5px; color: var(--text-2);
      background: var(--bg-soft);
      padding: 11px 14px;
      border-radius: 12px;
      border-left: 3px solid var(--border-strong);
      margin-bottom: 14px;
      white-space: pre-wrap; line-height: 1.6;
      max-height: 160px; overflow-y: auto;
      overflow-wrap: anywhere;
    }
    .reasoning-box::-webkit-scrollbar { width: 4px; }
    .reasoning-box::-webkit-scrollbar-thumb { background: rgba(128, 128, 128, .3); border-radius: 4px; }

    /* v7.0.0：可折叠「工具调用轨迹胶囊」 */
    .agent-trace {
      margin: 0 0 12px;
      border: 1px solid var(--border);
      background: var(--bg-soft);
      border-radius: 10px;
      font-size: 12.5px;
      color: var(--text-2);
      overflow: hidden;
    }
    .agent-trace-summary {
      padding: 6px 12px;
      cursor: pointer;
      font-weight: 550;
      user-select: none;
      list-style: none;
      display: flex;
      align-items: center;
      justify-content: space-between;
      transition: background .12s ease, color .12s ease;
    }
    .agent-trace-summary::-webkit-details-marker { display: none; }
    .agent-trace-summary::after {
      content: '▾';
      font-size: 12px;
      color: var(--muted);
      transition: transform .15s ease;
    }
    .agent-trace[open] .agent-trace-summary::after {
      transform: rotate(180deg);
    }
    .agent-trace-summary:hover {
      background: var(--hover);
      color: var(--text);
    }
    .agent-trace-list {
      padding: 6px 12px 10px;
      border-top: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 12px;
      line-height: 1.5;
    }
    .agent-trace-item {
      color: var(--text-2);
      overflow-wrap: anywhere;
    }

    .msg-actions {
      display: flex; gap: 2px; align-items: center;
      margin-top: 8px; flex-wrap: wrap;
      opacity: 0;
      transition: opacity .14s ease;
    }
    .message-row:hover .msg-actions { opacity: 1; }

    .msg-time {
      font-size: 11px; color: var(--muted);
      margin-right: 7px; line-height: 27px;
      user-select: none; white-space: nowrap;
    }

    .icon-btn, .speak-btn {
      width: 27px; height: 27px; padding: 0;
      display: grid; place-items: center;
      border: 1px solid transparent; border-radius: 8px;
      background: transparent; color: var(--muted);
      cursor: pointer; font-family: inherit; line-height: 1;
      transition: background .12s ease, color .12s ease, transform .1s ease;
    }
    .icon-btn:hover, .speak-btn:hover { background: rgba(127, 140, 170, .18); color: var(--text); }
    .icon-btn:active, .speak-btn:active { transform: scale(.92); }
    .icon-btn:focus-visible, .speak-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .icon-btn svg, .speak-btn svg { width: 16px; height: 16px; display: block; pointer-events: none; }

    .icon-btn.done { color: var(--accent); }
    .icon-btn.done:hover { background: var(--accent-soft); }

    .speak-btn.speaking { background: var(--accent-soft); color: var(--accent); }
    .speak-btn.speaking svg { animation: speakPulse 1s infinite ease-in-out; }
    @keyframes speakPulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }

    .agent-progress, .retry-notice {
      font-size: 12px; color: var(--text-2);
      margin-top: 10px; padding: 8px 12px;
      background: var(--bg-soft);
      border-radius: 10px;
      white-space: pre-line;
      overflow-wrap: anywhere;
    }
    .agent-progress { animation: speakPulse 1.6s infinite ease-in-out; }

    /* ---------------- 打字指示器 ---------------- */
    .typing-indicator {
      display: inline-flex; gap: 5px; align-items: center;
      padding: 4px 2px; height: 24px;
    }
    .typing-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--accent);
      animation: typing 1.4s infinite ease-in-out both;
    }
    .typing-dot:nth-child(1) { animation-delay: -.32s; }
    .typing-dot:nth-child(2) { animation-delay: -.16s; }
    @keyframes typing {
      0%, 80%, 100% { transform: scale(.4); opacity: .4; }
      40%           { transform: scale(1);  opacity: 1; }
    }

    /* ---------------- 空状态 ---------------- */
    .empty-state {
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      min-height: 58vh;
      max-width: 820px;
      margin: 0 auto;
      padding: 8px 0 40px;
    }
    .empty-state svg {
      width: 52px; height: 52px;
      color: var(--accent);
      margin-bottom: 20px;
    }
    .empty-state h2 {
      margin: 0; font-size: 25px; font-weight: 650;
      letter-spacing: -.3px; color: var(--text);
      background: linear-gradient(120deg, var(--text) 20%, var(--accent) 95%);
      -webkit-background-clip: text; background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .empty-state p { margin: 8px 0 0; font-size: 14.5px; color: var(--muted); }

    .suggestion-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      width: 100%;
      max-width: 560px;
      margin-top: 30px;
    }
    .suggestion-chip {
      display: flex; align-items: center; gap: 10px;
      padding: 13px 15px;
      border: 1px solid var(--border);
      border-radius: 13px;
      background: var(--panel);
      color: var(--text-2);
      font-size: 13.5px; text-align: left;
      cursor: pointer;
      transition: border-color .14s ease, background .14s ease, color .14s ease, transform .14s ease, box-shadow .14s ease;
    }
    .suggestion-chip:hover {
      border-color: var(--accent);
      background: var(--accent-soft);
      color: var(--text);
      transform: translateY(-2px);
      box-shadow: var(--shadow);
    }
    .suggestion-chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .suggestion-chip svg { width: 17px; height: 17px; color: var(--accent); flex-shrink: 0; }
    .suggestion-chip span {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }

    /* ---------------- 输入区 ---------------- */
    .input-wrapper { flex-shrink: 0; padding: 8px 20px 16px; }

    .input-box {
      max-width: 820px;
      margin: 0 auto;
      display: flex; flex-direction: column; gap: 8px;
      border: 1px solid var(--border-strong);
      background: var(--panel);
      border-radius: 20px;
      padding: 10px 12px 12px 16px;
      box-shadow: var(--shadow);
      transition: border-color .14s ease, box-shadow .14s ease;
    }
    .input-box:focus-within {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-soft), var(--shadow);
    }

    .input-top { display: flex; align-items: flex-end; gap: 9px; }

    .input-box textarea {
      flex: 1; min-height: 24px;
      border: 0; background: transparent;
      padding: 6px 0; outline: none;
      resize: none; max-height: 190px;
      line-height: 1.55; font-size: 15px;
      box-shadow: none;
    }
    .input-box textarea::placeholder { color: var(--muted); }

    .send-btn {
      flex-shrink: 0;
      width: 38px; height: 38px;
      padding: 0; border: 0; border-radius: 50%;
      background: var(--hover); color: var(--muted);
      display: grid; place-items: center;
      cursor: not-allowed;
      transition: background .14s ease, color .14s ease, transform .1s ease, box-shadow .14s ease;
    }
    .send-btn.active {
      background: var(--accent-gradient); color: #fff; cursor: pointer;
      box-shadow: 0 4px 14px rgba(37, 99, 235, .32);
    }
    .send-btn.active:hover { transform: scale(1.06); }
    .send-btn.stop-mode {
      background: rgba(220, 38, 38, .12); color: var(--danger); cursor: pointer;
    }
    .send-btn.stop-mode:hover { background: rgba(220, 38, 38, .2); transform: scale(1.06); }
    .send-btn.stop-mode svg { fill: currentColor; stroke: currentColor; }

    .input-bottom {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
    }

    .model-selector-container {
      position: relative;
      display: inline-flex; align-items: center; gap: 7px;
      padding: 5px 10px;
      border: 1px solid transparent; border-radius: 9px;
      background: var(--hover);
      cursor: pointer;
      max-width: 100%; overflow: hidden;
      transition: border-color .12s ease;
    }
    .model-selector-container:hover { border-color: var(--border-strong); }
    .model-display-text {
      font-size: 12.5px; font-weight: 550; color: var(--text-2);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      max-width: 160px; pointer-events: none;
    }
    .model-select {
      position: absolute; inset: 0;
      width: 100%; height: 100%;
      opacity: 0; cursor: pointer;
      border: 0; outline: none;
      -webkit-appearance: none; appearance: none;
    }

    .agent-toggle {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 12px; font-weight: 600;
      color: var(--muted);
      background: transparent;
      border: 1px solid var(--border-strong);
      border-radius: 999px;
      padding: 5px 11px;
      cursor: pointer; white-space: nowrap;
      transition: background .14s ease, color .14s ease, border-color .14s ease;
    }
    .agent-toggle:hover { color: var(--text); border-color: var(--muted); }
    .agent-toggle.active { background: var(--accent); border-color: var(--accent); color: #fff; }

    .disclaimer {
      max-width: 820px;
      margin: 7px auto 0;
      font-size: 11.5px; color: var(--muted); text-align: center;
    }

    /* ---------------- 设置弹窗 ---------------- */
    .settings-modal-overlay {
      position: fixed; inset: 0; z-index: 70;
      background: rgba(10, 12, 18, .45);
      display: none;
      align-items: center; justify-content: center;
      padding: 24px;
      opacity: 0;
      transition: opacity .2s ease;
    }
    .settings-modal-overlay.active { opacity: 1; }

    .settings-box {
      width: 100%; max-width: 380px;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 22px;
      box-shadow: var(--shadow);
    }
    .settings-box h3 { margin: 0 0 18px; font-size: 16px; font-weight: 650; }

    .settings-field { margin-bottom: 18px; }
    .settings-field:last-of-type { margin-bottom: 0; }

    .settings-label {
      display: block;
      font-size: 13px; font-weight: 550; color: var(--text-2);
      margin-bottom: 8px;
    }

    .settings-select, .settings-input {
      width: 100%;
      padding: 9px 11px;
      border: 1px solid var(--border-strong); border-radius: 10px;
      background: var(--panel);
      font-size: 13.5px; outline: none;
      transition: border-color .12s ease, box-shadow .12s ease;
    }
    .settings-select { cursor: pointer; }
    .settings-select:focus, .settings-input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-soft);
    }

    .settings-hint {
      font-size: 12px; color: var(--muted);
      margin-top: 8px; line-height: 1.55;
    }

    .settings-actions { display: flex; justify-content: flex-end; margin-top: 24px; }
    .settings-btn {
      border: 1px solid var(--accent); border-radius: 10px;
      background: var(--accent); color: #fff;
      padding: 9px 18px;
      font-size: 13.5px; font-weight: 550;
      cursor: pointer;
      transition: filter .12s ease;
    }
    .settings-btn:hover { filter: brightness(1.06); }

    /* ---------------- 通用按钮 / 确认弹窗 ---------------- */
    .btn {
      border: 1px solid var(--border-strong);
      background: var(--panel);
      color: var(--text);
      border-radius: 10px;
      padding: 8px 12px;
      cursor: pointer;
      font-size: 13.5px;
      transition: background .12s ease, border-color .12s ease, opacity .12s ease;
      white-space: nowrap;
    }
    .btn:hover { background: var(--bg-soft); }
    .btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .btn.danger { background: var(--danger); border-color: var(--danger); color: #fff; font-weight: 550; }
    .btn.danger:hover { filter: brightness(1.06); }

    .modal-mask {
      position: fixed; inset: 0; z-index: 80;
      background: rgba(10, 12, 18, .45);
      display: grid; place-items: center; padding: 24px;
    }
    .modal {
      width: 100%; max-width: 360px;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 20px;
      box-shadow: var(--shadow);
    }
    .modal h3 { margin: 0 0 14px; font-size: 16px; font-weight: 650; }
    .modal .modal-text { margin: 0; color: var(--text-2); font-size: 13.5px; line-height: 1.6; }
    .modal .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px; }

    /* ---------------- 主题切换过渡 / 动效减弱 ---------------- */
    body.theme-anim, body.theme-anim *, body.theme-anim *::before, body.theme-anim *::after {
      transition: background-color .25s ease, border-color .25s ease, color .25s ease, box-shadow .25s ease, fill .25s ease, stroke .25s ease !important;
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: .01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: .01ms !important;
      }
    }

    /* ---------------- 移动端 ---------------- */
    @media (max-width: 768px) {
      .sidebar {
        position: fixed; top: 0; left: 0; bottom: 0;
        z-index: 50;
        transform: translateX(-100%);
        transition: transform .22s ease;
        box-shadow: var(--shadow);
      }
      .sidebar.open { transform: translateX(0); }

      .menu-toggle { display: grid; }

      .messages-container { padding-left: 14px; padding-right: 14px; }
      .input-wrapper { padding-left: 14px; padding-right: 14px; }

      .empty-state { min-height: 50vh; }
      .empty-state h2 { font-size: 22px; }
      .suggestion-grid { grid-template-columns: 1fr; max-width: 400px; }
      .scroll-bottom-btn { bottom: 10px; }

      .msg-actions { opacity: 1; }
      .delete-btn { opacity: 1; }
    }
  </style>
`;
