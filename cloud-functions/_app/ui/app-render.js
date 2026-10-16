// 会话列表与消息渲染（_worker.js 原第 4055-4139 行，内嵌页面分片；只允许字符串导出）
export default `  function renderSessionList() {
    sessionListDiv.replaceChildren();
    const fragment = document.createDocumentFragment();

    sessions.forEach(session => {
      const item = document.createElement('div');
      item.className = 'session-item ' + (session.id === currentSessionId ? 'active' : '');
      item.onclick = () => switchSession(session.id);
      
      const titleSpan = document.createElement('span'); 
      titleSpan.className = 'session-title'; 
      titleSpan.innerText = session.title;
      
      const delBtn = document.createElement('button'); 
      delBtn.className = 'delete-btn'; 
      delBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4h4v2"></path></svg>';
      delBtn.onclick = (e) => deleteSession(e, session.id);
      
      item.appendChild(titleSpan); 
      item.appendChild(delBtn); 
      fragment.appendChild(item);
    });

    sessionListDiv.appendChild(fragment);
  }

  function renderMessages() {
    messagesDiv.replaceChildren();
    const currentSession = sessions.find(s => s.id === currentSessionId);
    if (!currentSession) return;
    
    if (currentSession.messages.length === 0) {
      emptyState.style.display = 'flex';
    } else { 
      emptyState.style.display = 'none'; 
      currentSession.messages.forEach(msg => {
        const uiRole = msg.role === 'assistant' ? 'ai' : msg.role;
        appendMessageDOM(uiRole, msg.content, null, false, msg.t);
      }); 
      syncRegenButtons();
    }
  }

  function appendMessageDOM(role, content, msgId = null, isError = false, time = null) {
    let row = msgId ? document.getElementById('row_' + msgId) : null;
    let bubble = msgId ? document.getElementById(msgId) : null;

    if (!row) {
      row = document.createElement('div');
      row.className = 'message-row ' + role;
      if (msgId) row.id = 'row_' + msgId;
      if (isError) row.classList.add('error-msg');

      bubble = document.createElement('div');
      bubble.className = 'message-bubble';
      if (msgId) bubble.id = msgId;

      row.appendChild(bubble);
      messagesDiv.appendChild(row);
    }

    // v6.9.0：时间戳（旧会话数据没有 t 字段则为 null，不显示）
    bubble.__time = time || null;

    if (role === 'ai') {
      if (msgId) {
        bubble.innerHTML = content;
      } else {
        // v6.9.5：isCurrentlyStreaming 为 false 时，safeHtml 内部的 marked renderer 已完成代码高亮，无需二次调用 hljs.highlightElement
        isCurrentlyStreaming = false;
        bubble.innerHTML = '<div class="message-text markdown-body">' + safeHtml(content) + '</div>';
        // 复制按钮要的是原始 Markdown，不是渲染后的 HTML
        bubble.__rawText = content;
      }
    } else {
      bubble.innerText = content; 
      bubble.__rawText = content;
    }
    ensureMessageActions(bubble);

    // v6.9.0：智能滚动 —— 用户自己的消息永远贴底；AI 消息只在用户
    // 停在底部附近时跟随（向上翻历史时不被流式输出拽走）
    if (role === 'user' || isNearBottom) {
      isNearBottom = true;
      scrollArea.scrollTop = scrollArea.scrollHeight;
    }

    const rBox = bubble.querySelector('.reasoning-box');
    if (rBox) { rBox.scrollTop = rBox.scrollHeight; }

    return bubble;
  }

`;
