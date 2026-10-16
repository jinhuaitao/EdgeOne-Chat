// 发送与流式接收：Agent 进度与可折叠工具轨迹胶囊、重试、中断处理（内嵌页面分片；只允许字符串导出）
export default `  async function sendMessage() {
    const text = userInput.value.trim(); 
    if (!text && !isCurrentlyStreaming) return;
    
    const reqSession = sessions.find(s => s.id === currentSessionId);
    if (!reqSession) return;
    const reqSessionId = reqSession.id;
    const isCurrentActiveSession = () => currentSessionId === reqSessionId && sessions.indexOf(reqSession) !== -1;

    if (reqSession.messages.length === 0) {
      reqSession.title = text.length > 14 ? text.substring(0, 14) + '...' : text;
      renderSessionList();
    }
    
    stopSpeaking();
    emptyState.style.display = 'none';
    userInput.value = '';
    userInput.style.height = 'auto';
    statusDot.classList.add('generating');
    // 发送新消息永远从底部开始看，并收起「回到底部」按钮
    isNearBottom = true;
    if (scrollBottomBtn) scrollBottomBtn.classList.remove('show');

    const userT = Date.now();
    appendMessageDOM('user', text, null, false, userT);
    reqSession.messages.push({ role: 'user', content: text, t: userT });
    saveSessions();
    syncRegenButtons();   // 上一轮的 AI 回复不再是最后一条，收起它的「重新生成」

    const aiMsgId = 'ai_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    // 字符串拼接替换模板字符串
    appendMessageDOM('ai', 
      '<div class="reasoning-box" style="display:none;"></div>' +
      '<div class="message-text markdown-body">' +
        '<div class="typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>' +
      '</div>', aiMsgId);
    
    const bubble = document.getElementById(aiMsgId);
    isCurrentlyStreaming = true;
    syncRegenButtons();   // 进入生成态：收起上一轮的「重新生成」
    
    const localAbortController = new AbortController();
    currentAbortController = localAbortController;
    sendBtn.classList.remove('active');
    sendBtn.classList.add('stop-mode');
    sendBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="2" ry="2"></rect></svg>';

    try {
      const reqHeaders = { 'Content-Type': 'application/json' };
      if (accessToken) reqHeaders['X-Access-Token'] = accessToken;

      let aiContent = '';
      let reasoningContent = '';
      let gotDone = false; // 是否收到 SSE 正常结束标记 data: [DONE]
      const AGENT_IDLE_TIMEOUT_MS = 90000;
      let idleTimedOut = false; // 区分"用户手动中止"与"看门狗中止"

      const rBox = bubble.querySelector('.reasoning-box');
      const tBox = bubble.querySelector('.message-text');

      let isRenderPending = false;
      let lastRenderTime = 0;
      const cursorHtml = '<span style="display:inline-block; width:6px; height:18px; background:var(--brand-color); animation:typing 1s infinite; vertical-align:middle; margin-left:4px; border-radius:2px;"></span>';

      function scheduleUpdateUI(force = false) {
        const now = Date.now();
        if (!force && now - lastRenderTime < 60) return;
        if (isRenderPending) return;
        isRenderPending = true;

        requestAnimationFrame(() => {
          isRenderPending = false;
          lastRenderTime = Date.now();

          if ((!isCurrentlyStreaming && !force) || !isCurrentActiveSession()) return;

          if (reasoningContent && rBox) {
            if (rBox.style.display === 'none') rBox.style.display = 'block';
            rBox.textContent = reasoningContent;
            rBox.scrollTop = rBox.scrollHeight;
          }

          if (aiContent || !reasoningContent) {
            tBox.innerHTML = safeHtml(aiContent) + (isCurrentlyStreaming ? cursorHtml : '');
          } else if (reasoningContent && !aiContent) {
            tBox.innerHTML = '<div style="color: var(--brand-color); font-size: 14px; font-weight: 500;">正在深度思考... ▍</div>';
          }

          const distanceToBottom = scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight;
          if (distanceToBottom < 120) {
            scrollArea.scrollTop = scrollArea.scrollHeight;
          }
        });
      }

      // v6.6.0 / v7.0.0 Agent 实时进度条 + 可折叠「工具调用轨迹胶囊」
      let agentProgressEl = null;
      let agentProgressBase = '';
      let agentProgressT0 = 0;
      let agentProgressTimer = null;
      const agentToolSteps = [];
      let agentTraceEl = null;

      function recordAgentToolSteps(progressText) {
        const lines = String(progressText || '').split('\\n').map(s => s.trim()).filter(Boolean);
        // 首行是 "🤖 Agent 思考中（第 N 步）…"，后续行是具体调用的工具描述
        for (let i = 1; i < lines.length; i++) {
          const cleanStep = lines[i].replace(/正在/g, '');
          if (cleanStep && agentToolSteps.indexOf(cleanStep) === -1) {
            agentToolSteps.push(cleanStep);
          }
        }
      }

      function renderAgentTraceCapsule() {
        if (!agentToolSteps.length) return;
        const elapsedSec = agentProgressT0 > 0 ? Math.max(1, Math.round((Date.now() - agentProgressT0) / 1000)) : 0;
        if (!agentTraceEl) {
          agentTraceEl = document.createElement('details');
          agentTraceEl.className = 'agent-trace';
          bubble.insertBefore(agentTraceEl, tBox);
        }
        agentTraceEl.replaceChildren();
        const sum = document.createElement('summary');
        sum.className = 'agent-trace-summary';
        sum.textContent = '🛠️ 已调用 ' + agentToolSteps.length + ' 项工具' + (elapsedSec > 0 ? '（耗时 ' + elapsedSec + 's）' : '');
        const list = document.createElement('div');
        list.className = 'agent-trace-list';
        agentToolSteps.forEach((st, idx) => {
          const item = document.createElement('div');
          item.className = 'agent-trace-item';
          item.textContent = (idx + 1) + '. ' + st;
          list.appendChild(item);
        });
        agentTraceEl.appendChild(sum);
        agentTraceEl.appendChild(list);
      }

      function renderAgentProgress() {
        if (!agentProgressEl) return;
        const s = Math.round((Date.now() - agentProgressT0) / 1000);
        agentProgressEl.textContent = agentProgressBase + (s >= 3 ? '\\n（已等待 ' + s + ' 秒）' : '');
      }
      function showAgentProgress(text) {
        if (!agentProgressEl) {
          agentProgressEl = document.createElement('div');
          agentProgressEl.className = 'agent-progress';
          bubble.appendChild(agentProgressEl);
          if (!agentProgressT0) agentProgressT0 = Date.now();
          agentProgressTimer = setInterval(renderAgentProgress, 1000);
        }
        recordAgentToolSteps(text);
        agentProgressEl.style.display = '';
        agentProgressBase = text;
        renderAgentProgress();
        if (isCurrentActiveSession()) {
          const distanceToBottom = scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight;
          if (distanceToBottom < 120) {
            scrollArea.scrollTop = scrollArea.scrollHeight;
          }
        }
      }
      // 正文开始流式输出后收起实时进度条，并将已执行的工具步骤转为顶部可折叠轨迹胶囊
      function hideAgentProgress() {
        if (agentProgressEl) agentProgressEl.style.display = 'none';
        renderAgentTraceCapsule();
      }
      function clearAgentProgress() {
        if (agentProgressTimer) { clearInterval(agentProgressTimer); agentProgressTimer = null; }
        if (agentProgressEl && agentProgressEl.parentNode) agentProgressEl.parentNode.removeChild(agentProgressEl);
        agentProgressEl = null;
        agentProgressBase = '';
        renderAgentTraceCapsule();
      }
      function resetStreamedText() {
        aiContent = '';
        reasoningContent = '';
        if (rBox) { rBox.style.display = 'none'; rBox.textContent = ''; }
        tBox.innerHTML = '';
        if (agentProgressEl) showAgentProgress(agentProgressBase || '🤖 Agent 正在继续…');
      }

      // 自动重试提示条（只在断流重试时短暂出现）
      let retryNoticeEl = null;
      function setRetryNotice(text) {
        if (!text) {
          if (retryNoticeEl && retryNoticeEl.parentNode) retryNoticeEl.parentNode.removeChild(retryNoticeEl);
          retryNoticeEl = null;
          return;
        }
        if (!retryNoticeEl) {
          retryNoticeEl = document.createElement('div');
          retryNoticeEl.className = 'retry-notice';
          bubble.appendChild(retryNoticeEl);
        }
        retryNoticeEl.textContent = text;
      }

      function resetStreamUI() {
        aiContent = '';
        reasoningContent = '';
        gotDone = false;
        agentToolSteps.length = 0;
        if (agentTraceEl && agentTraceEl.parentNode) agentTraceEl.parentNode.removeChild(agentTraceEl);
        agentTraceEl = null;
        clearAgentProgress();
        if (rBox) { rBox.style.display = 'none'; rBox.textContent = ''; }
        tBox.innerHTML = '';
      }

      // 单次流式请求。收到 [DONE] 返回 true；网络/鉴权等错误直接 throw。
      async function runOnce() {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: reqHeaders,
          body: JSON.stringify({
            messages: reqSession.messages.slice(-MAX_SEND_MSGS),
            model: modelSelect.value,
            agent: agentMode,
            session_id: reqSessionId
          }),
          signal: localAbortController.signal
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: '网络或服务接口错误' }));
          if (response.status === 401) {
            openSettings();
            const authErr = new Error('访问口令错误或未填写');
            authErr.name = 'AuthError';
            throw authErr;
          }
          throw new Error(errorData.error || '请求失败');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        idleTimedOut = false;
        let idleTimer = null;
        function bumpIdle() {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(function () {
            idleTimedOut = true;
            try { localAbortController.abort(); } catch (e) {}
          }, AGENT_IDLE_TIMEOUT_MS);
        }
        bumpIdle();

        try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bumpIdle();

          buffer += decoder.decode(value, { stream: true });
          let lines = buffer.split('\\n');
          buffer = lines.pop();

          for (let line of lines) {
            line = line.trim();
            if (!line.startsWith('data:')) continue;
            if (line.slice(5).trim() === '[DONE]') { gotDone = true; continue; }
            if (line.indexOf('"agent_progress"') > 0 || line.indexOf('"agent_error"') > 0 || line.indexOf('"agent_reset"') > 0) {
              let handledAsAgentEvent = false;
              try {
                const adata = JSON.parse(line.slice(5).trim());
                if (adata && adata.agent_progress !== undefined) {
                  showAgentProgress(adata.agent_progress);
                  handledAsAgentEvent = true;
                } else if (adata && adata.agent_reset !== undefined) {
                  resetStreamedText();
                  handledAsAgentEvent = true;
                } else if (adata && adata.agent_error !== undefined) {
                  const ae = new Error(adata.agent_error);
                  ae.name = 'AgentError';
                  throw ae;
                }
              } catch (e) {
                if (e && e.name === 'AgentError') throw e;
              }
              if (handledAsAgentEvent) continue;
            }
            let sseData = null;
            try { sseData = JSON.parse(line.slice(5).trim()); } catch (e) { sseData = null; }
            if (!sseData) continue;
            if (sseData.error) {
              const de = new Error(sseData.error.message || JSON.stringify(sseData.error));
              de.name = 'ServerError';
              throw de;
            }
            if (sseData.choices && sseData.choices[0] && sseData.choices[0].delta) {
              const delta = sseData.choices[0].delta;
              if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
              if (delta.content !== undefined && delta.content !== null && delta.content !== '') {
                aiContent += delta.content;
                hideAgentProgress();
              }
              scheduleUpdateUI();
            }
          }
        }
        } finally {
          if (idleTimer) clearTimeout(idleTimer);
        }

        if (!gotDone && buffer.trim() && buffer.trim().startsWith('data:') && !buffer.includes('[DONE]')) {
          try {
            const data = JSON.parse(buffer.slice(5).trim());
            if (data.choices && data.choices[0].delta) {
              const delta = data.choices[0].delta;
              if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
              if (delta.content) aiContent += delta.content;
            }
          } catch(e) {}
        }
      }

      const MAX_AUTO_RETRY = 3;
      let attempt = 0;
      let streamError = null;
      while (true) {
        attempt++;
        streamError = null;
        try {
          await runOnce();
        } catch (e) {
          const en = (e && e.name) || '';
          if (en === 'AuthError' || en === 'ServerError' || en === 'IdleTimeout') {
            setRetryNotice(null);
            throw e;
          }
          if (en === 'AbortError') {
            setRetryNotice(null);
            if (idleTimedOut) {
              const ie = new Error('超过 ' + Math.round(AGENT_IDLE_TIMEOUT_MS / 1000) + ' 秒没有收到服务端任何数据，连接可能已中断，请重试');
              ie.name = 'IdleTimeout';
              throw ie;
            }
            throw e;
          }
          streamError = e;
        }
        if (gotDone) break;
        if (!streamError) streamError = new Error('连接意外中断（未收到结束标记）');
        if (agentMode) break;
        if (attempt > MAX_AUTO_RETRY) break;
        resetStreamUI();
        setRetryNotice('连接意外中断，正在自动重试（第 ' + attempt + ' 次）…');
        await new Promise(function (resolve) { setTimeout(resolve, 1200 * attempt); });
      }
      setRetryNotice(null);
      if (!gotDone) throw streamError;

      isCurrentlyStreaming = false;
      if (!reasoningContent && rBox) rBox.remove();
      clearAgentProgress();

      tBox.innerHTML = safeHtml(aiContent);
      bubble.__rawText = aiContent;   // 供「复制」取原始 Markdown
      if (isCurrentActiveSession() && isNearBottom) scrollArea.scrollTop = scrollArea.scrollHeight;

      // 自动朗读（若已在左下角开启且仍在当前会话）
      if (isCurrentActiveSession() && autoSpeak && aiContent && aiContent.trim()) {
        const sb = bubble.querySelector('.speak-btn');
        if (sb) toggleSpeak(sb, bubble);
      }
      
      if (sessions.indexOf(reqSession) !== -1) {
        const aiT = Date.now();
        reqSession.messages.push({ role: 'assistant', content: aiContent, t: aiT });
        bubble.__time = aiT;
        ensureMessageActions(bubble);
        saveSessions();
      }
      
    } catch (error) {
      if (!error) error = new Error('连接意外中断（未收到结束标记）');
      isCurrentlyStreaming = false;
      clearAgentProgress();
      const tBox = bubble.querySelector('.message-text');

      if (error.name === 'AgentError') {
        tBox.innerHTML = '<span style="color: #ef4444; font-size: 14px; font-weight: 600;">' + escapeHtml(error.message) + '</span>';
        if (bubble.parentElement) bubble.parentElement.classList.add('error-msg');
      } else if (error.name === 'AbortError') {
        const interruptNote = '<br><br><span style="color: var(--text-secondary); font-size: 13px; font-weight: 500;">(🛑 生成已手动中止)</span>';
        tBox.innerHTML = safeHtml(aiContent || '已中止') + interruptNote;
        if (aiContent && sessions.indexOf(reqSession) !== -1) {
          const abortT = Date.now();
          reqSession.messages.push({ role: 'assistant', content: aiContent, t: abortT });
          bubble.__rawText = aiContent;
          bubble.__time = abortT;
          ensureMessageActions(bubble);
        }
      } else if (error.name === 'AuthError') {
        tBox.innerHTML = '<span style="color: var(--brand-color); font-size: 15px; font-weight: 600;">需要访问口令</span>' +
          '<div style="color: var(--text-secondary); font-size: 13px; margin-top: 8px; line-height: 1.6;">请在左下角「设置」中填写与服务端 ACCESS_PASSWORD 一致的口令，保存后重新发送。</div>';
        if (bubble.parentElement) bubble.parentElement.classList.add('error-msg');
        if (sessions.indexOf(reqSession) !== -1) reqSession.messages.pop();
        if (isCurrentActiveSession()) {
          userInput.value = text;
          userInput.dispatchEvent(new Event('input'));
        }
      } else {
        if (typeof checkHealth === 'function') checkHealth();
        if (aiContent || reasoningContent) {
          tBox.innerHTML = safeHtml(aiContent) + '<br><br><span style="color: #ef4444; font-size: 13px; font-weight: 500;">(⚠️ 网络连接中断，已保留当前生成的内容。错误: ' + escapeHtml(error.message) + ')</span>';
          if (sessions.indexOf(reqSession) !== -1) {
            const partT = Date.now();
            reqSession.messages.push({ role: 'assistant', content: aiContent, t: partT });
            bubble.__rawText = aiContent;
            bubble.__time = partT;
            ensureMessageActions(bubble);
          }
          if (rBox && reasoningContent) rBox.remove();
        } else {
          tBox.innerText = '通信断开: ' + error.message; 
          if (bubble.parentElement) bubble.parentElement.classList.add('error-msg');
          if (sessions.indexOf(reqSession) !== -1) reqSession.messages.pop(); 
        }
      }
      saveSessions();
    } finally {
      isCurrentlyStreaming = false;
      try {
        clearAgentProgress();
        const tb = bubble.querySelector('.message-text');
        if (tb && tb.querySelector('.typing-indicator')) {
          tb.innerHTML = '<span style="color:#ef4444;font-size:14px;font-weight:600;">连接中断，未收到回复，请重试</span>';
          if (bubble.parentElement) bubble.parentElement.classList.add('error-msg');
        }
      } catch (e) {}
      if (currentAbortController === localAbortController) {
        currentAbortController = null;
      }
      statusDot.classList.remove('generating'); 
      syncRegenButtons();
      
      sendBtn.classList.remove('stop-mode');
      sendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>';
      
      if (userInput.value.trim().length > 0) sendBtn.classList.add('active'); 
      if (isCurrentActiveSession()) userInput.focus();
    }
  }

  sendBtn.addEventListener('click', () => {
    if (isCurrentlyStreaming && currentAbortController) {
      currentAbortController.abort(); 
    } else {
      sendMessage();
    }
  });

  userInput.addEventListener('keydown', (e) => { 
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault(); 
      if (sendBtn.classList.contains('active') && !isCurrentlyStreaming) { 
        sendMessage(); 
      }
    } 
  });
  
`;
