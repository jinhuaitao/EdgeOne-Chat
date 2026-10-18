// 页面骨架 HTML：侧栏、消息区、输入区、弹窗（_worker.js 原第 3373-3482 行，内嵌页面分片；只允许字符串导出）
export default `</head>
<body>

<div class="offline-banner" id="offlineBanner" role="status" aria-live="polite">
  <svg class="spin" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>
  <span id="offlineText">网络已断开，正在尝试重连…</span>
</div>

<div class="sidebar-overlay" id="sidebarOverlay"></div>

<div class="settings-modal-overlay" id="settingsModal">
  <div class="settings-box">
    <h3>系统偏好设置</h3>
    <div class="settings-field">
      <label class="settings-label" for="defaultModelSetting">新对话默认模型</label>
      <select id="defaultModelSetting" class="settings-select">
        {{MODEL_OPTIONS}}
      </select>
    </div>
    <div class="settings-field">
      <label class="settings-label" for="accessTokenSetting">访问口令</label>
      <input type="password" id="accessTokenSetting" class="settings-input" placeholder="留空则不发送校验头" autocomplete="off">
      <div class="settings-hint">仅当服务端配置了 ACCESS_PASSWORD 时才需要填写，需与之一致。口令只保存在本机浏览器，不会上传。</div>
    </div>
    <div class="settings-actions">
      <button id="closeSettingsBtn" class="settings-btn">保存并关闭</button>
    </div>
  </div>
</div>

<div class="settings-modal-overlay" id="wxModal">
  <div class="settings-box" style="max-width:480px;max-height:88vh;overflow-y:auto;">
    <h3>🟢 微信 ClawBot 通道管理</h3>

    <!-- 第一步：密码验证门禁页（未通过密码验证前仅显示此页，不显示微信绑定页面） -->
    <div id="wxAuthStep">
      <div style="text-align:center;padding:10px 6px 14px;">
        <div style="font-size:34px;line-height:1;margin-bottom:10px;">🔒</div>
        <div style="font-size:15px;font-weight:600;margin-bottom:6px;">请先验证管理员密码</div>
        <div style="font-size:12px;color:var(--text-sub);line-height:1.6;">
          为防止公开网址被他人恶意扫码盗绑，必须先通过管理员密码（WX_ADMIN_SECRET 或 ACCESS_PASSWORD）验证后，才能进入微信绑定与管理页面。
        </div>
      </div>
      <div class="settings-field">
        <label class="settings-label" for="wxAdminTokenInput">🔑 管理员密码 (WX_ADMIN_SECRET 或 ACCESS_PASSWORD)</label>
        <input type="password" id="wxAdminTokenInput" class="settings-input" placeholder="请输入管理员密码（按回车或点击下方按钮验证）" autocomplete="off">
        <div id="wxAuthErrorBox" style="display:none;margin-top:8px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.5;background:rgba(239,68,68,0.1);color:#ef4444;border:1px solid rgba(239,68,68,0.25);"></div>
      </div>
      <div class="settings-actions" style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;">
        <button type="button" id="closeWxAuthBtn" class="btn">关闭</button>
        <button type="button" id="wxVerifyAdminBtn" class="settings-btn" style="width:auto;padding:10px 20px;">🔓 验证并进入绑定页面</button>
      </div>
    </div>

    <!-- 第二步：密码验证通过后才出现的微信绑定与控制页面 -->
    <div id="wxMainStep" style="display:none;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;padding:6px 10px;border-radius:8px;background:var(--bg-soft);border:1px solid var(--border);font-size:12px;">
        <span style="color:#10b981;font-weight:600;">🔓 密码验证已通过</span>
        <button type="button" id="wxLockBtn" class="btn" style="padding:3px 8px;font-size:11px;">🔒 退出并重新锁定</button>
      </div>
      <div class="settings-field">
        <div id="wxStatusBox" style="font-size:13px;line-height:1.65;padding:10px 12px;border-radius:10px;background:var(--bg-soft);border:1px solid var(--border);">
          正在读取微信 ClawBot 通道绑定状态…
        </div>
      </div>
      <div class="settings-field" id="wxQrArea" style="display:none;text-align:center;">
        <div style="margin:6px 0 8px;font-size:13px;font-weight:600;" id="wxQrStatusText">请使用手机微信扫描下方二维码确认连接</div>
        <div id="wxQrLinkWrap" style="margin:8px auto;padding:12px;background:#fff;border-radius:12px;display:inline-block;border:1px solid var(--border);">
          <img id="wxQrImg" alt="微信 ClawBot 扫码绑定" style="width:190px;height:190px;display:block;" />
        </div>
        <div id="wxVerifyCodeArea" style="display:none;margin:8px auto;max-width:260px;">
          <div style="font-size:12px;margin-bottom:4px;color:var(--brand-color);">📱 手机微信要求输入数字配对码：</div>
          <div style="display:flex;gap:6px;">
            <input type="text" id="wxVerifyCodeInput" class="settings-input" placeholder="输入手机上的配对码" style="flex:1;text-align:center;">
            <button type="button" id="wxVerifyCodeBtn" class="btn">提交</button>
          </div>
        </div>
        <div style="margin-top:6px;font-size:12px;">
          <a id="wxQrDirectLink" href="#" target="_blank" rel="noopener noreferrer" style="color:var(--brand-color);text-decoration:underline;">或点击此处在新标签页打开官方扫码页</a>
        </div>
      </div>
      <div class="settings-field">
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" id="wxGetQrBtn" class="btn" style="flex:1;">📱 扫码绑定微信</button>
          <button type="button" id="wxPollNowBtn" class="btn" title="立即向微信 iLink 强制同步最新消息">🔄 立即同步</button>
          <button type="button" id="wxSyncChatBtn" class="btn" title="把手机微信里的对话同步到当前网页左侧会话列表">💬 同步对话到网页</button>
          <button type="button" id="wxLogoutBtn" class="btn danger" style="display:none;">解绑</button>
        </div>
      </div>
      <div class="settings-field" id="wxTestSendArea" style="display:none;margin-top:8px;">
        <label class="settings-label" for="wxTestMsgInput">📨 从网页主动发消息到手机微信（测试连通性）</label>
        <div style="display:flex;gap:8px;">
          <input type="text" id="wxTestMsgInput" class="settings-input" style="flex:1;" value="🎉 微信 ClawBot 通道连通成功！直接发「菜单」查看快捷口令，或发「画 一只太空猫」试试生图吧～">
          <button type="button" id="wxTestSendBtn" class="btn">发送测试</button>
        </div>
        <div class="settings-hint">注：首次扫码绑定后，请先在手机微信（我 → 设置 → 插件 → ClawBot）里给机器人发任意一句话（如「你好」）以激活对话令牌。</div>
      </div>
      <div class="settings-field" style="margin-top:10px;padding:10px 12px;border-radius:10px;background:var(--bg-soft);border:1px solid var(--border);font-size:12px;line-height:1.6;">
        <div style="font-weight:600;color:#10b981;">⚡ 全自动后台收发（像 Telegram 一样免配置外部监控）</div>
        <div style="color:var(--text-sub);margin-top:2px;">扫码绑定成功后，服务端会自动启动「自接力常驻长轮询引擎」；即使直接关掉当前网页，机器人也会在云端自动接力收发微信消息，无需手动添加任何外部监控。</div>
      </div>
      <div class="settings-field" id="wxDiagSection" style="display:none;margin-top:10px;">
        <label class="settings-label">📋 实时收发与诊断日志</label>
        <div id="wxDiagBox" style="font-size:12px;line-height:1.55;max-height:130px;overflow-y:auto;padding:8px 10px;border-radius:8px;background:var(--bg-soft);border:1px solid var(--border);font-family:monospace;white-space:pre-wrap;">暂无收发记录</div>
      </div>
      <div class="settings-actions">
        <button id="closeWxModalBtn" class="settings-btn">关闭</button>
      </div>
    </div>
  </div>
</div>

<div class="app-container">
  <div class="sidebar" id="sidebar">
    <div class="sidebar-header">
      <div class="brand">
        <span class="brand-dot">AI</span>
        <span class="brand-name">EdgeOne-Chat</span>
      </div>
      <button class="new-chat-btn" id="newChatBtn">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
        发起新对话
      </button>
    </div>
    <div class="session-list" id="sessionList"></div>
    <div class="sidebar-footer">
      <div class="side-tools">
        <button class="theme-toggle" id="settingsToggle" title="系统设置">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
        </button>
        <button class="theme-toggle" id="wxModalToggle" title="微信 ClawBot 通道绑定与管理" style="position:relative;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>
          <span id="wxOnlineBadge" style="display:none;position:absolute;top:4px;right:4px;width:8px;height:8px;border-radius:50%;background:#10b981;box-shadow:0 0 0 2px var(--bg-main);"></span>
        </button>
        <button class="theme-toggle" id="ttsToggle" title="自动朗读回复">
          <svg id="ttsIcon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>
        </button>
        <button class="theme-toggle" id="installBtn" title="安装到桌面 / 主屏幕" hidden>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
        </button>
        <button class="theme-toggle" id="themeToggle" title="切换主题">
          <svg id="themeIcon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
        </button>
      </div>
      <span class="side-version">v{{APP_VERSION}}</span>
    </div>
  </div>

  <div class="chat-area">
    <div class="header">
      <div class="header-inner">
        <button class="menu-toggle" id="menuToggle">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>
        </button>
        <div class="header-title">
          <div class="status-dot" id="statusDot"></div>
          <span id="headerTitle">AI 核心处理中枢</span>
        </div>
      </div>
    </div>

    <div class="messages-container" id="scrollArea">
      <div class="messages" id="messages"></div>
      <div class="empty-state" id="emptyState">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>
        <h2>今天我能为你提供什么帮助？</h2>
        <p>输入问题即可开始，支持 Markdown、代码高亮、19 项 Agent 工具、Telegram 与微信 ClawBot 通道。</p>
        <div class="suggestion-grid" id="suggestionGrid">
          <button class="suggestion-chip" type="button" data-prompt="帮我写一封得体的商务邮件">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>
            <span>帮我写一封商务邮件</span>
          </button>
          <button class="suggestion-chip" type="button" data-prompt="用通俗的语言给我解释一个技术概念">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"></path><path d="M10 22h4"></path><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.4 1 2.3h6c0-.9.4-1.8 1-2.3A7 7 0 0 0 12 2z"></path></svg>
            <span>通俗解释技术概念</span>
          </button>
          <button class="suggestion-chip" type="button" data-prompt="搜索并总结最近的科技新闻">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
            <span>搜索总结科技新闻</span>
          </button>
          <button class="suggestion-chip" type="button" data-prompt="帮我规划一个周末出行方案">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
            <span>规划周末出行方案</span>
          </button>
        </div>
      </div>
      <button class="scroll-bottom-btn" id="scrollBottomBtn" title="回到底部" aria-label="回到底部">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
      </button>
    </div>

    <div class="input-wrapper">
      <div class="input-box">
        <div class="input-top">
          <textarea id="userInput" placeholder="输入指令或开始对话..." rows="1"></textarea>
          <button class="send-btn" id="sendBtn">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
          </button>
        </div>

        <div class="input-bottom">
          <div class="model-selector-container">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--brand-color)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none;"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>
            <span class="model-display-text" id="modelDisplayText">加载中...</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity:0.6; pointer-events:none;"><polyline points="6 9 12 15 18 9"></polyline></svg>
            <select class="model-select" id="modelSelect">
              {{MODEL_OPTIONS}}
            </select>
          </div>
          <button class="agent-toggle" id="agentToggle" title="Agent 模式：自主规划并调用工具（🔍 搜索 / 📄 网页 / 🌐 维基 / 🐙 GitHub / 🎓 论文 / 🔥 热榜 / 💱 汇率 / 🧮 计算 / 📏 换算 / 🔤 编码 / 🖧 网络 / 🌤 天气 / 🕐 时间），回答优先查知识库文档；知识库在本端只读，保存文档/记住信息请通过 Telegram 或微信 ClawBot 机器人">🤖 Agent</button>
        </div>
      </div>
      <div class="disclaimer">AI 生成的内容可能不准确，请核实重要信息。</div>
    </div>
  </div>
</div>

`;
