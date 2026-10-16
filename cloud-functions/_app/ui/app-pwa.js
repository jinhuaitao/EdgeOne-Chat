// PWA 接线：SW 注册、离线探针、安装提示（_worker.js 原第 4623-4707 行，内嵌页面分片；只允许字符串导出）
export default `  // ================= PWA =================

  // 1) 注册 Service Worker（挂在根路径，scope 覆盖整站）
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }

  // 2) 离线检测 + 按需自动重连（v6.9.5 优化）
  //    旧版每 8 秒无条件轮询 /healthz（含后台标签页），单标签页每天消耗上万次 Worker 请求。
  //    现改为：仅在首次加载、网络切回或进入离线态（offlineState === true）时轮询 /healthz，
  //    一旦探测恢复在线立即停止轮询；且标签页在后台（document.hidden）时暂停探测。
  const offlineBanner = document.getElementById('offlineBanner');
  const offlineText = document.getElementById('offlineText');
  let offlineState = false;
  let healthPollTimer = null;

  function startHealthPolling() {
    if (healthPollTimer) return;
    healthPollTimer = setInterval(() => {
      if (!document.hidden) checkHealth();
    }, 8000);
  }

  function stopHealthPolling() {
    if (healthPollTimer) {
      clearInterval(healthPollTimer);
      healthPollTimer = null;
    }
  }

  function setOffline(on, reason) {
    if (on) startHealthPolling();
    else stopHealthPolling();
    if (on === offlineState) return;
    offlineState = on;
    if (offlineBanner) offlineBanner.classList.toggle('show', on);
    if (on && offlineText && reason) offlineText.textContent = reason;
  }

  async function checkHealth() {
    if (document.hidden) return;
    try {
      const res = await fetch('/healthz', { cache: 'no-store' });
      if (!res.ok) throw new Error('unhealthy');
      if (offlineState) {
        setOffline(false);
        // 刚恢复：重绘当前会话，清掉离线期间残留的错误气泡
        if (!isCurrentlyStreaming) renderMessages();
      } else {
        stopHealthPolling();
      }
    } catch (e) {
      setOffline(true, '网络已断开，正在尝试重连…');
    }
  }

  window.addEventListener('online', checkHealth);
  window.addEventListener('offline', () => setOffline(true, '网络已断开，正在尝试重连…'));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && offlineState) checkHealth();
  });
  checkHealth();

  // 3) 安装到桌面 / 主屏幕
  let deferredInstallPrompt = null;
  const installBtn = document.getElementById('installBtn');

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    if (installBtn) installBtn.hidden = false;
  });

  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      try { await deferredInstallPrompt.userChoice; } catch (e) {}
      deferredInstallPrompt = null;
      installBtn.hidden = true;
    });
  }

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    if (installBtn) installBtn.hidden = true;
  });

  // 已经以独立窗口方式运行时不再显示安装按钮
  if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) {
    if (installBtn) installBtn.hidden = true;
  }

  init();

  // 4) 支持 manifest 快捷方式 /?new=1 —— 直接开一个新会话
  try {
    if (new URLSearchParams(location.search).get('new') === '1' && sessions.length > 0) {
      createNewSession();
    }
  } catch (e) {}

</script>
</body>
</html>`;
