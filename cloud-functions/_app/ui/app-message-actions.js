// 消息操作按钮：朗读 / 复制 / 重新生成（_worker.js 原第 3699-3799 行，内嵌页面分片；只允许字符串导出）
export default `  // 给消息挂上操作按钮：朗读（仅 AI）/ 复制（全部）。幂等，可重复调用。
  function ensureMessageActions(bubble) {
    if (!bubble) return;
    const row = bubble.parentElement;
    const isUser = !!(row && row.classList.contains('user'));

    let actions = bubble.querySelector('.msg-actions');
    if (!actions) {
      actions = document.createElement('div');
      actions.className = 'msg-actions';
      bubble.appendChild(actions);
    }

    // v6.9.0：时间戳（有值时显示在操作行最前，随操作行一起悬浮出现）
    let timeEl = actions.querySelector('.msg-time');
    if (bubble.__time) {
      if (!timeEl) {
        timeEl = document.createElement('span');
        timeEl.className = 'msg-time';
        actions.insertBefore(timeEl, actions.firstChild);
      }
      const d = new Date(bubble.__time);
      const p2 = (n) => String(n).padStart(2, '0');
      timeEl.textContent = p2(d.getHours()) + ':' + p2(d.getMinutes());
      timeEl.title = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
    } else if (timeEl) {
      timeEl.remove();
    }

    // 朗读：只给 AI 消息（自己说的话没必要朗读）
    if (!isUser && !actions.querySelector('.speak-btn')) {
      const sp = document.createElement('button');
      sp.className = 'speak-btn';
      sp.type = 'button';
      sp.title = '朗读这条回复';
      sp.setAttribute('aria-label', '朗读这条回复');
      sp.innerHTML = SPEAK_ICON;
      sp.addEventListener('click', () => toggleSpeak(sp, bubble));
      actions.appendChild(sp);
    }

    // 复制：复制原始 Markdown（拿不到就退回渲染后的纯文本）
    if (!actions.querySelector('[data-action="copy-msg"]')) {
      const cp = document.createElement('button');
      cp.className = 'icon-btn';
      cp.type = 'button';
      cp.title = '复制这条消息';
      cp.setAttribute('aria-label', '复制这条消息');
      cp.dataset.action = 'copy-msg';
      cp.innerHTML = COPY_ICON;
      cp.addEventListener('click', async () => {
        const raw = bubble.__rawText;
        const ok = await copyText(raw != null && raw !== '' ? raw : getBubbleText(bubble));
        if (ok) flashIcon(cp, CHECK_ICON, COPY_ICON);
      });
      actions.appendChild(cp);
    }
  }

  // 「重新生成」只挂在最后一条 AI 回复上 —— 挂在旧消息上会让用户以为能重跑那一轮，
  // 实际只能重跑末尾，语义不一致。生成中一律收起（避免点了没反应）。
  function syncRegenButtons() {
    const rows = Array.prototype.slice.call(messagesDiv.querySelectorAll('.message-row'));
    let lastAiRow = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].classList.contains('ai')) { lastAiRow = rows[i]; break; }
    }
    rows.forEach((r) => {
      const bubble = r.querySelector('.message-bubble');
      if (!bubble) return;
      const btn = r.querySelector('[data-action="regen"]');
      const shouldHave = (r === lastAiRow) && !isCurrentlyStreaming;
      if (shouldHave && !btn) {
        const rg = document.createElement('button');
        rg.className = 'icon-btn';
        rg.type = 'button';
        rg.title = '重新生成这条回复';
        rg.setAttribute('aria-label', '重新生成');
        rg.dataset.action = 'regen';
        rg.innerHTML = REGEN_ICON;
        rg.addEventListener('click', () => regenerate());
        let actions = bubble.querySelector('.msg-actions');
        if (!actions) {
          actions = document.createElement('div');
          actions.className = 'msg-actions';
          bubble.appendChild(actions);
        }
        actions.appendChild(rg);
      } else if (!shouldHave && btn) {
        btn.remove();
      }
    });
  }

  // 重新生成最后一轮：丢掉末尾的用户提问与其后的回复，用同样的提问重跑一次
  async function regenerate() {
    if (isCurrentlyStreaming) return;
    const s = sessions.find((x) => x.id === currentSessionId);
    if (!s || !s.messages.length) return;

    let lastUser = -1;
    for (let i = s.messages.length - 1; i >= 0; i--) {
      if (s.messages[i].role === 'user') { lastUser = i; break; }
    }
    if (lastUser < 0) return;

    const text = s.messages[lastUser].content;
    s.messages.splice(lastUser);          // 连同这轮的用户提问一起丢弃
    saveSessions();
    stopSpeaking();
    renderMessages();                     // 重渲染，末尾回到上一轮的 AI 回复

    userInput.value = text;
    userInput.dispatchEvent(new Event('input'));
    await sendMessage();                  // 复用原发送流程，不改动它的逻辑
  }

`;
