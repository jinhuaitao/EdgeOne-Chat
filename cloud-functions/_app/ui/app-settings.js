// 偏好设置弹窗、微信 ClawBot 全功能控制台（两步门禁：先验证密码，验证通过后才出现微信绑定页面）与底部开关接线
export default `  const settingsModal = document.getElementById('settingsModal');
  const settingsToggle = document.getElementById('settingsToggle');
  const closeSettingsBtn = document.getElementById('closeSettingsBtn');
  const defaultModelSetting = document.getElementById('defaultModelSetting');
  const accessTokenSetting = document.getElementById('accessTokenSetting');

  if (defaultModelSetting) {
    defaultModelSetting.value = localStorage.getItem('default_model') || (modelSelect.options.length > 0 ? modelSelect.options[0].value : "");
  }
  if (accessTokenSetting) {
    accessTokenSetting.value = accessToken;
  }

  function openSettings() {
    settingsModal.style.display = 'flex';
    setTimeout(() => settingsModal.classList.add('active'), 10);
  }

  settingsToggle.addEventListener('click', openSettings);

  closeSettingsBtn.addEventListener('click', () => {
    settingsModal.classList.remove('active');
    if (defaultModelSetting.value) {
      localStorage.setItem('default_model', defaultModelSetting.value);
    }
    if (accessTokenSetting) {
      accessToken = accessTokenSetting.value.trim();
      if (accessToken) localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
      else localStorage.removeItem(ACCESS_TOKEN_KEY);
    }
    setTimeout(() => settingsModal.style.display = 'none', 300);
  });

  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettingsBtn.click();
  });

  // ===== 微信 ClawBot (iLink) 通道：严格「先验证密码 -> 再显示微信绑定页面」两步门禁 =====
  const WX_ADMIN_TOKEN_KEY = 'eochat_wx_admin_token';
  const WX_LIVE_POLL_KEY = 'eochat_wx_live_poll';
  const WX_SYNC_SESSION_ID = 'session_wx_clawbot_sync';
  let wxAdminToken = localStorage.getItem(WX_ADMIN_TOKEN_KEY) || '';
  let wxSessionUnlocked = false;

  const wxModal = document.getElementById('wxModal');
  const wxModalToggle = document.getElementById('wxModalToggle');
  const wxOnlineBadge = document.getElementById('wxOnlineBadge');
  const wxAuthStep = document.getElementById('wxAuthStep');
  const wxMainStep = document.getElementById('wxMainStep');
  const wxAuthErrorBox = document.getElementById('wxAuthErrorBox');
  const closeWxAuthBtn = document.getElementById('closeWxAuthBtn');
  const wxLockBtn = document.getElementById('wxLockBtn');
  const closeWxModalBtn = document.getElementById('closeWxModalBtn');
  const wxAdminTokenInput = document.getElementById('wxAdminTokenInput');
  const wxVerifyAdminBtn = document.getElementById('wxVerifyAdminBtn');
  const wxStatusBox = document.getElementById('wxStatusBox');
  const wxQrArea = document.getElementById('wxQrArea');
  const wxQrStatusText = document.getElementById('wxQrStatusText');
  const wxQrImg = document.getElementById('wxQrImg');
  const wxQrDirectLink = document.getElementById('wxQrDirectLink');
  const wxVerifyCodeArea = document.getElementById('wxVerifyCodeArea');
  const wxVerifyCodeInput = document.getElementById('wxVerifyCodeInput');
  const wxVerifyCodeBtn = document.getElementById('wxVerifyCodeBtn');
  const wxGetQrBtn = document.getElementById('wxGetQrBtn');
  const wxPollNowBtn = document.getElementById('wxPollNowBtn');
  const wxSyncChatBtn = document.getElementById('wxSyncChatBtn');
  const wxLogoutBtn = document.getElementById('wxLogoutBtn');
  const wxTestSendArea = document.getElementById('wxTestSendArea');
  const wxTestMsgInput = document.getElementById('wxTestMsgInput');
  const wxTestSendBtn = document.getElementById('wxTestSendBtn');
  const wxLivePollToggle = document.getElementById('wxLivePollToggle');
  const wxKeepaliveBox = document.getElementById('wxKeepaliveBox');
  const wxKeepaliveUrlInput = document.getElementById('wxKeepaliveUrlInput');
  const wxCopyKeepaliveBtn = document.getElementById('wxCopyKeepaliveBtn');
  const wxDiagSection = document.getElementById('wxDiagSection');
  const wxDiagBox = document.getElementById('wxDiagBox');

  let wxQrPollingActive = false;
  let wxPendingVerifyCode = '';
  let wxLivePollActive = localStorage.getItem(WX_LIVE_POLL_KEY) !== '0';
  let wxLiveLoopRunning = false;
  let wxIsConnectedState = false;

  function showWxAuthGate(errMsg) {
    wxSessionUnlocked = false;
    stopWxQrPolling();
    if (wxAuthStep) wxAuthStep.style.display = 'block';
    if (wxMainStep) wxMainStep.style.display = 'none';
    if (wxQrArea) wxQrArea.style.display = 'none';
    if (wxAuthErrorBox) {
      if (errMsg) {
        wxAuthErrorBox.style.display = 'block';
        wxAuthErrorBox.textContent = errMsg;
      } else {
        wxAuthErrorBox.style.display = 'none';
        wxAuthErrorBox.textContent = '';
      }
    }
  }

  function showWxMainPanel() {
    wxSessionUnlocked = true;
    if (wxAuthStep) wxAuthStep.style.display = 'none';
    if (wxMainStep) wxMainStep.style.display = 'block';
    if (wxAuthErrorBox) {
      wxAuthErrorBox.style.display = 'none';
      wxAuthErrorBox.textContent = '';
    }
  }

  function getEffectiveWxSecret() {
    return (wxAdminTokenInput && wxAdminTokenInput.value.trim()) || wxAdminToken || accessToken || '';
  }

  function buildWxAuthHeaders(overrideToken) {
    const h = { 'Content-Type': 'application/json' };
    if (accessToken) h['X-Access-Token'] = accessToken;
    const adm = overrideToken !== undefined ? overrideToken : getEffectiveWxSecret();
    if (adm) h['X-Wx-Admin-Token'] = adm;
    return h;
  }

  function stopWxQrPolling() {
    wxQrPollingActive = false;
    wxPendingVerifyCode = '';
    if (wxVerifyCodeArea) wxVerifyCodeArea.style.display = 'none';
  }

  function setWxButtonsEnabled(enabled, isConnected) {
    if (wxGetQrBtn) wxGetQrBtn.disabled = !enabled || !!isConnected;
    if (wxPollNowBtn) wxPollNowBtn.disabled = !enabled || !isConnected;
    if (wxSyncChatBtn) wxSyncChatBtn.disabled = !enabled || !isConnected;
    if (wxLogoutBtn) wxLogoutBtn.style.display = (enabled && isConnected) ? 'inline-block' : 'none';
    if (wxTestSendArea) wxTestSendArea.style.display = (enabled && isConnected) ? 'block' : 'none';
    if (wxOnlineBadge) wxOnlineBadge.style.display = isConnected ? 'block' : 'none';
  }

  function renderWxDiag(diag) {
    if (!wxDiagSection || !wxDiagBox) return;
    if (!diag) {
      wxDiagSection.style.display = 'none';
      return;
    }
    wxDiagSection.style.display = 'block';
    const lines = [];
    const fmtTime = (ts) => ts ? new Date(ts).toLocaleTimeString() : '尚未触发';
    lines.push('💓 最近轮询心跳: ' + fmtTime(diag.lastPollAt) + ' (累计 ' + (diag.totalPolls || 0) + ' 次轮询 / 已回复 ' + (diag.totalProcessed || 0) + ' 条)');
    if (diag.lastError) {
      lines.push('⚠️ 最近异常: ' + diag.lastError);
    }
    const evs = Array.isArray(diag.events) ? diag.events : [];
    if (evs.length === 0) {
      lines.push('📭 暂无微信消息记录（请在手机微信向 ClawBot 发送「菜单」或「你好」）');
    } else {
      lines.push('--- 最近收发动态 ---');
      for (let i = 0; i < evs.length; i++) {
        const e = evs[i];
        const tag = e.kind === 'inbound' ? '📥 [收到]' : (e.kind === 'reply' ? '📤 [回复]' : (e.kind === 'image' ? '🖼️ [发图]' : (e.kind === 'error' ? '❌ [错误]' : '🔔 [事件]')));
        lines.push(fmtTime(e.ts) + ' ' + tag + ' ' + (e.detail || ''));
      }
    }
    wxDiagBox.textContent = lines.join('\\n');
  }

  function updateWxKeepaliveUrl(authorized) {
    if (!wxKeepaliveBox || !wxKeepaliveUrlInput) return;
    const sec = getEffectiveWxSecret();
    if (!authorized || !sec) {
      wxKeepaliveBox.style.display = 'none';
      return;
    }
    wxKeepaliveBox.style.display = 'block';
    wxKeepaliveUrlInput.value = window.location.origin + '/wx-webhook?key=' + encodeURIComponent(sec);
  }

  async function syncWechatHistoryToWeb(switchNow) {
    try {
      const res = await fetch('/api/wx/history', { headers: buildWxAuthHeaders() });
      const data = await res.json();
      if (!data || !data.ok || !Array.isArray(data.messages) || data.messages.length === 0) {
        if (switchNow) {
          alert((data && data.message) || '当前暂无微信端聊天记录，请先在手机微信 ClawBot 中发送一条消息。');
        }
        return false;
      }
      const mappedMsgs = data.messages.map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: typeof m.content === 'string'
          ? m.content
          : (Array.isArray(m.content) ? m.content.filter(p => p && p.type === 'text').map(p => p.text).join('\\n') : String(m.content || '')),
      }));
      let existing = sessions.find(s => s.id === WX_SYNC_SESSION_ID);
      const fallbackModel = data.modelId || (modelSelect && modelSelect.options.length > 0 ? modelSelect.options[0].value : '');
      if (!existing) {
        existing = {
          id: WX_SYNC_SESSION_ID,
          title: '🟢 微信 ClawBot 对话',
          messages: mappedMsgs,
          model: fallbackModel,
        };
        sessions.unshift(existing);
      } else {
        existing.title = '🟢 微信 ClawBot 对话';
        existing.messages = mappedMsgs;
        if (data.modelId) existing.model = data.modelId;
      }
      saveSessions();
      renderSessionList();
      if (switchNow || currentSessionId === WX_SYNC_SESSION_ID) {
        switchSession(WX_SYNC_SESSION_ID);
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  async function refreshWxStatus(silent) {
    try {
      const res = await fetch('/api/wx/status', { headers: buildWxAuthHeaders() });
      const data = await res.json();
      wxIsConnectedState = !!(data && data.connected);
      if (wxOnlineBadge) wxOnlineBadge.style.display = wxIsConnectedState ? 'block' : 'none';

      if (!data || !data.adminAuthorized) {
        setWxButtonsEnabled(false, false);
        updateWxKeepaliveUrl(false);
        renderWxDiag(null);
        if (!silent) {
          showWxAuthGate((data && data.authReason) || '密码验证未通过，请重新输入正确的管理员密码。');
        }
        return data;
      }

      if (!silent) {
        showWxMainPanel();
      }
      updateWxKeepaliveUrl(true);
      renderWxDiag(data.diag || null);

      if (data.connected) {
        setWxButtonsEnabled(true, true);
        if (wxStatusBox) {
          wxStatusBox.innerHTML = '✅ <b>状态：已连接微信 ClawBot（防覆盖保护已开启）</b>' +
            '<br>• 机器人 ID：' + escapeHtml(data.botId || '-') +
            '<br>• 绑定微信号：' + escapeHtml(data.userId || '等待你在手机微信发首条消息激活') +
            '<br>• 会话令牌：' + (data.hasContextToken ? '🟢 已激活（可双向收发文字与原图）' : '🟡 待激活（请先在手机微信向 ClawBot 发一句「你好」）') +
            '<br>• 接入节点：' + escapeHtml(data.baseUrl || '-') +
            (data.r2Bound ? '<br>• 持久化存储：✅ 已接通（凭证、记忆与知识库永久保存）' : '<br>• ⚠️ 提示：未绑定持久化存储，实例重启后需重新扫码');
        }
        if (wxLivePollActive && !wxLiveLoopRunning) {
          runWxLivePollLoop();
        }
      } else if (data.expired) {
        setWxButtonsEnabled(true, false);
        if (wxLogoutBtn) wxLogoutBtn.style.display = 'inline-block';
        if (wxStatusBox) {
          wxStatusBox.innerHTML = '⚠️ <b>状态：微信会话已过期 (ret=-14)</b><br>' +
            escapeHtml(data.errmsg || '请先点击「解绑」或直接点击下方「📱 扫码绑定微信」重新扫码授权。');
        }
      } else {
        setWxButtonsEnabled(true, false);
        if (wxStatusBox) {
          wxStatusBox.innerHTML = '⚪ <b>状态：未绑定</b><br>点击下方「📱 扫码绑定微信」生成二维码，用手机微信扫码确认后即可在微信「我 → 设置 → 插件 → ClawBot」中直接对话、识图、画图与管理知识库。';
        }
      }
      return data;
    } catch (e) {
      if (!silent) {
        showWxAuthGate('⚠️ 验证请求失败：' + (e && e.message ? e.message : String(e)));
      }
      return null;
    }
  }

  async function verifyAndEnterWxPanel() {
    const candidate = (wxAdminTokenInput && wxAdminTokenInput.value.trim()) || '';
    if (!candidate) {
      showWxAuthGate('⚠️ 请先输入管理员密码（WX_ADMIN_SECRET 或 ACCESS_PASSWORD）');
      if (wxAdminTokenInput) wxAdminTokenInput.focus();
      return;
    }
    const origText = wxVerifyAdminBtn ? wxVerifyAdminBtn.textContent : '';
    if (wxVerifyAdminBtn) {
      wxVerifyAdminBtn.disabled = true;
      wxVerifyAdminBtn.textContent = '⏳ 正在验证密码…';
    }
    try {
      const res = await fetch('/api/wx/status', { headers: buildWxAuthHeaders(candidate) });
      const data = await res.json();
      if (!data || !data.adminAuthorized) {
        showWxAuthGate('❌ 密码验证失败：' + ((data && data.authReason) || '密码不正确，请核对后重试'));
        if (wxAdminTokenInput) wxAdminTokenInput.focus();
        return;
      }
      // 验证成功：保存密钥并切换到微信绑定与管理页面
      wxAdminToken = candidate;
      try { localStorage.setItem(WX_ADMIN_TOKEN_KEY, wxAdminToken); } catch (e) {}
      showWxMainPanel();
      await refreshWxStatus(false);
    } catch (e) {
      showWxAuthGate('⚠️ 网络或服务异常：' + (e && e.message ? e.message : String(e)));
    } finally {
      if (wxVerifyAdminBtn) {
        wxVerifyAdminBtn.disabled = false;
        wxVerifyAdminBtn.textContent = origText;
      }
    }
  }

  if (wxVerifyAdminBtn) {
    wxVerifyAdminBtn.addEventListener('click', verifyAndEnterWxPanel);
  }
  if (wxAdminTokenInput) {
    wxAdminTokenInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        verifyAndEnterWxPanel();
      }
    });
  }
  if (wxLockBtn) {
    wxLockBtn.addEventListener('click', () => {
      wxAdminToken = '';
      try { localStorage.removeItem(WX_ADMIN_TOKEN_KEY); } catch (e) {}
      if (wxAdminTokenInput) wxAdminTokenInput.value = '';
      showWxAuthGate('');
      if (wxAdminTokenInput) wxAdminTokenInput.focus();
    });
  }

  if (wxVerifyCodeBtn && wxVerifyCodeInput) {
    wxVerifyCodeBtn.addEventListener('click', () => {
      const code = wxVerifyCodeInput.value.trim();
      if (code) {
        wxPendingVerifyCode = code;
        if (wxQrStatusText) wxQrStatusText.textContent = '⏳ 正在提交配对码 ' + code + ' 并等待确认…';
      }
    });
  }

  async function startWxQrBinding() {
    stopWxQrPolling();
    if (wxGetQrBtn) wxGetQrBtn.disabled = true;
    if (wxQrArea) wxQrArea.style.display = 'block';
    if (wxQrStatusText) wxQrStatusText.textContent = '⏳ 正在向微信 iLink 请求登录二维码…';
    try {
      const res = await fetch('/api/wx/qrcode', {
        method: 'POST',
        headers: buildWxAuthHeaders(),
        body: JSON.stringify({ force: true })
      });
      const data = await res.json();
      if (res.status === 401 || res.status === 403) {
        showWxAuthGate('🔒 鉴权已失效：' + ((data && data.error) || '请重新验证管理员密码'));
        return;
      }
      if (!res.ok || !data || !data.ok || !data.qrcode) {
        if (wxQrStatusText) wxQrStatusText.textContent = '⚠️ ' + ((data && data.error) || '获取二维码失败');
        if (wxGetQrBtn) wxGetQrBtn.disabled = false;
        return;
      }
      const qrCodeKey = data.qrcode;
      const qrContentUrl = data.qrcode_img_content || '';
      let currentBaseUrl = data.base_url || '';

      if (wxQrImg && qrContentUrl) {
        wxQrImg.src = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(qrContentUrl);
      }
      if (wxQrDirectLink && qrContentUrl) {
        wxQrDirectLink.href = qrContentUrl;
      }
      if (wxQrStatusText) wxQrStatusText.textContent = '📱 请使用手机微信扫描二维码并在手机上点击确认';

      wxQrPollingActive = true;
      while (wxQrPollingActive) {
        await new Promise(r => setTimeout(r, 1800));
        if (!wxQrPollingActive) break;
        try {
          let pollUrl = '/api/wx/qrcode-status?qrcode=' + encodeURIComponent(qrCodeKey);
          if (currentBaseUrl) pollUrl += '&base_url=' + encodeURIComponent(currentBaseUrl);
          if (wxPendingVerifyCode) {
            pollUrl += '&verify_code=' + encodeURIComponent(wxPendingVerifyCode);
            wxPendingVerifyCode = '';
          }
          const stRes = await fetch(pollUrl, { headers: buildWxAuthHeaders() });
          const stData = await stRes.json();
          if (!wxQrPollingActive) break;

          if (stData && stData.base_url) {
            currentBaseUrl = stData.base_url;
          }
          if (stData && stData.status === 'rejected') {
            stopWxQrPolling();
            if (wxQrStatusText) wxQrStatusText.textContent = '🚫 ' + (stData.error || '非白名单微信号，已拒绝绑定');
            if (wxGetQrBtn) wxGetQrBtn.disabled = false;
            break;
          }
          if (!stData || !stData.ok) continue;

          if (stData.need_verifycode || stData.status === 'need_verifycode') {
            if (wxVerifyCodeArea) wxVerifyCodeArea.style.display = 'block';
            if (wxQrStatusText) wxQrStatusText.textContent = '🔢 手机微信要求输入数字配对码，请在下方输入框填写并提交';
          } else if (stData.status === 'scaned' || stData.status === 'scaned_but_redirect' || stData.status === 'binded_redirect') {
            if (wxQrStatusText) wxQrStatusText.textContent = '📲 已扫码！请在手机微信上点击「确认连接」…';
          } else if (stData.status === 'confirmed') {
            stopWxQrPolling();
            if (wxQrStatusText) wxQrStatusText.textContent = '🎉 绑定成功！后台实时轮询已自动启动，现在打开手机微信 ClawBot 发句「菜单」试试吧！';
            wxLivePollActive = true;
            if (wxLivePollToggle) wxLivePollToggle.checked = true;
            try { localStorage.setItem(WX_LIVE_POLL_KEY, '1'); } catch (e) {}
            await refreshWxStatus(false);
            runWxLivePollLoop();
            break;
          } else if (stData.status === 'expired') {
            stopWxQrPolling();
            if (wxQrStatusText) wxQrStatusText.textContent = '⌛ 二维码已过期，请重新点击「📱 扫码绑定微信」获取。';
            if (wxGetQrBtn) wxGetQrBtn.disabled = false;
            break;
          }
        } catch (e) {}
      }
    } catch (e) {
      if (wxQrStatusText) wxQrStatusText.textContent = '⚠️ 请求异常：' + (e && e.message ? e.message : String(e));
      if (wxGetQrBtn) wxGetQrBtn.disabled = false;
    }
  }

  async function triggerManualWxPoll() {
    if (!wxPollNowBtn) return;
    const origText = wxPollNowBtn.textContent;
    wxPollNowBtn.disabled = true;
    wxPollNowBtn.textContent = '⏳ 同步中…';
    try {
      const res = await fetch('/api/wx/poll', {
        method: 'POST',
        headers: buildWxAuthHeaders(),
        body: JSON.stringify({ timeout_ms: 40000, single_shot: true, force: false })
      });
      const data = await res.json();
      if (data && data.ok) {
        wxPollNowBtn.textContent = data.locked
          ? '🟢 后台实时监听中'
          : ('✅ 已处理 ' + (data.processed || 0) + ' 条');
        await syncWechatHistoryToWeb(false);
      } else {
        wxPollNowBtn.textContent = '⚠️ ' + ((data && (data.error || data.message)) || '未就绪');
      }
      await refreshWxStatus(true);
    } catch (e) {
      wxPollNowBtn.textContent = '⚠️ 失败';
    } finally {
      setTimeout(() => {
        if (wxPollNowBtn) {
          wxPollNowBtn.disabled = false;
          wxPollNowBtn.textContent = origText;
        }
      }, 1800);
    }
  }

  async function sendWxTestMessage() {
    if (!wxTestSendBtn || !wxTestMsgInput) return;
    const txt = wxTestMsgInput.value.trim();
    if (!txt) return;
    const orig = wxTestSendBtn.textContent;
    wxTestSendBtn.disabled = true;
    wxTestSendBtn.textContent = '发送中…';
    try {
      const res = await fetch('/api/wx/send', {
        method: 'POST',
        headers: buildWxAuthHeaders(),
        body: JSON.stringify({ text: txt })
      });
      const data = await res.json();
      if (res.ok && data && data.ok) {
        wxTestSendBtn.textContent = '✅ 已送达微信';
      } else {
        alert('发送失败：' + ((data && data.error) || '请先在手机微信向 ClawBot 发送任意一句话激活会话'));
        wxTestSendBtn.textContent = '⚠️ 失败';
      }
      await refreshWxStatus(true);
    } catch (e) {
      wxTestSendBtn.textContent = '⚠️ 异常';
    } finally {
      setTimeout(() => {
        if (wxTestSendBtn) {
          wxTestSendBtn.disabled = false;
          wxTestSendBtn.textContent = orig;
        }
      }, 2000);
    }
  }

  let wxLastSeenReplyAt = 0;
  let wxLastSeenTotalProcessed = 0;

  async function runWxLivePollLoop() {
    if (wxLiveLoopRunning) return;
    wxLiveLoopRunning = true;
    while (wxLivePollActive) {
      if (!getEffectiveWxSecret()) {
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      try {
        const res = await fetch('/api/wx/poll', {
          method: 'POST',
          headers: buildWxAuthHeaders(),
          body: JSON.stringify({ timeout_ms: 40000, single_shot: true })
        });
        const data = await res.json();
        if (res.status === 401 || res.status === 403 || (data && (data.expired || data.reason === 'not_configured'))) {
          wxIsConnectedState = false;
          if (wxOnlineBadge) wxOnlineBadge.style.display = 'none';
          await new Promise(r => setTimeout(r, 8000));
        } else {
          wxIsConnectedState = true;
          if (wxOnlineBadge) wxOnlineBadge.style.display = 'block';
          const replyAdvanced = !!(data && data.lastReplyAt && data.lastReplyAt > wxLastSeenReplyAt);
          const countAdvanced = !!(data && typeof data.totalProcessed === 'number' && data.totalProcessed > wxLastSeenTotalProcessed);
          if (data && data.lastReplyAt > wxLastSeenReplyAt) wxLastSeenReplyAt = data.lastReplyAt;
          if (data && typeof data.totalProcessed === 'number' && data.totalProcessed > wxLastSeenTotalProcessed) {
            wxLastSeenTotalProcessed = data.totalProcessed;
          }
          if ((data && data.processed > 0) || replyAdvanced || countAdvanced) {
            await syncWechatHistoryToWeb(false);
            if (wxModal && wxModal.classList.contains('active') && wxSessionUnlocked) {
              await refreshWxStatus(true);
            }
          }
          const waitMs = (data && data.locked) ? 3500 : (document.hidden ? 1500 : 400);
          await new Promise(r => setTimeout(r, waitMs));
        }
      } catch (e) {
        await new Promise(r => setTimeout(r, 4000));
      }
    }
    wxLiveLoopRunning = false;
  }

  if (wxLivePollToggle) {
    wxLivePollToggle.checked = wxLivePollActive;
    wxLivePollToggle.addEventListener('change', () => {
      wxLivePollActive = wxLivePollToggle.checked;
      try { localStorage.setItem(WX_LIVE_POLL_KEY, wxLivePollActive ? '1' : '0'); } catch (e) {}
      if (wxLivePollActive) runWxLivePollLoop();
    });
  }

  if (wxCopyKeepaliveBtn && wxKeepaliveUrlInput) {
    wxCopyKeepaliveBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(wxKeepaliveUrlInput.value);
        const orig = wxCopyKeepaliveBtn.textContent;
        wxCopyKeepaliveBtn.textContent = '✅ 已复制';
        setTimeout(() => { wxCopyKeepaliveBtn.textContent = orig; }, 1500);
      } catch (e) {
        wxKeepaliveUrlInput.select();
      }
    });
  }

  function closeWxModal() {
    stopWxQrPolling();
    if (!wxModal) return;
    wxModal.classList.remove('active');
    setTimeout(() => wxModal.style.display = 'none', 300);
  }

  if (wxModalToggle && wxModal) {
    wxModalToggle.addEventListener('click', () => {
      wxModal.style.display = 'flex';
      setTimeout(() => wxModal.classList.add('active'), 10);
      // 严格遵循「先验证密码，再出现微信绑定页面」：未在当前会话解锁时，一律先展示密码验证门禁页
      if (!wxSessionUnlocked) {
        if (wxAdminTokenInput && !wxAdminTokenInput.value && wxAdminToken) {
          wxAdminTokenInput.value = wxAdminToken;
        }
        showWxAuthGate('');
        setTimeout(() => { if (wxAdminTokenInput) wxAdminTokenInput.focus(); }, 60);
      } else {
        showWxMainPanel();
        refreshWxStatus(false);
      }
    });
  }
  if (closeWxModalBtn) closeWxModalBtn.addEventListener('click', closeWxModal);
  if (closeWxAuthBtn) closeWxAuthBtn.addEventListener('click', closeWxModal);
  if (wxModal) {
    wxModal.addEventListener('click', (e) => {
      if (e.target === wxModal) closeWxModal();
    });
  }
  if (wxGetQrBtn) wxGetQrBtn.addEventListener('click', startWxQrBinding);
  if (wxPollNowBtn) wxPollNowBtn.addEventListener('click', triggerManualWxPoll);
  if (wxSyncChatBtn) wxSyncChatBtn.addEventListener('click', () => syncWechatHistoryToWeb(true));
  if (wxTestSendBtn) wxTestSendBtn.addEventListener('click', sendWxTestMessage);
  if (wxLogoutBtn) {
    wxLogoutBtn.addEventListener('click', async () => {
      stopWxQrPolling();
      try {
        await fetch('/api/wx/logout', { method: 'POST', headers: buildWxAuthHeaders() });
        if (wxQrArea) wxQrArea.style.display = 'none';
        await refreshWxStatus(false);
      } catch (e) {}
    });
  }

  // 页面加载后若本地存有历史密钥，仅静默探测在线角标与后台消息轮询，绝不跳过弹窗的密码验证门禁页
  setTimeout(async () => {
    if (getEffectiveWxSecret()) {
      const st = await refreshWxStatus(true);
      if (st && st.connected && wxLivePollActive) {
        runWxLivePollLoop();
      }
    }
  }, 600);

  document.getElementById('newChatBtn').addEventListener('click', createNewSession);

  // 左下角「自动朗读」开关
  const ttsToggleBtn = document.getElementById('ttsToggle');
  if (ttsToggleBtn) {
    ttsToggleBtn.addEventListener('click', () => {
      autoSpeak = !autoSpeak;
      localStorage.setItem(TTS_AUTO_KEY, autoSpeak ? '1' : '0');
      if (!autoSpeak) stopSpeaking();
      updateTtsToggleUI();
    });
  }
  updateTtsToggleUI();

  // 页面关闭 / 切换标签页时停止朗读
  window.addEventListener('beforeunload', stopSpeaking);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopSpeaking(); });

`;
