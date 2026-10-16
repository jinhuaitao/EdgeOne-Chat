// 通用弹窗（替换原生 confirm / alert）与删除会话（_worker.js 原第 3963-4054 行，内嵌页面分片；只允许字符串导出）
export default `  // ===== 通用弹窗：替掉浏览器原生 confirm() / alert()，样式跟随主题 =====
  // 原生对话框不受页面 CSS 影响，在换过皮的界面里会显得格格不入。
  function openDialog(opts) {
    return new Promise(function (resolve) {
      const mask = document.createElement('div');
      mask.className = 'modal-mask';

      const box = document.createElement('div');
      box.className = 'modal';

      const h = document.createElement('h3');
      h.textContent = opts.title || '确认操作';

      const p = document.createElement('p');
      p.className = 'modal-text';
      p.textContent = opts.message || '';

      const actions = document.createElement('div');
      actions.className = 'actions';

      function finish(value) {
        if (mask.parentNode) mask.parentNode.removeChild(mask);
        document.removeEventListener('keydown', onKey);
        resolve(value);
      }
      function onKey(ev) {
        if (ev.key === 'Escape') finish(false);
        else if (ev.key === 'Enter' && opts.danger) finish(true);
      }

      // 只有一个「知道了」的情况（提示类）
      if (!opts.danger) {
        const ok = document.createElement('button');
        ok.type = 'button';
        ok.className = 'btn';
        ok.textContent = opts.okText || '知道了';
        ok.addEventListener('click', function () { finish(true); });
        actions.appendChild(ok);
        actions.lastChild.focus();
      } else {
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'btn';
        cancel.textContent = opts.cancelText || '取消';

        const ok = document.createElement('button');
        ok.type = 'button';
        ok.className = 'btn danger';
        ok.textContent = opts.okText || '删除';

        cancel.addEventListener('click', function () { finish(false); });
        ok.addEventListener('click', function () { finish(true); });
        actions.appendChild(cancel);
        actions.appendChild(ok);
        ok.focus();
      }

      mask.addEventListener('click', function (ev) { if (ev.target === mask) finish(false); });
      document.addEventListener('keydown', onKey);

      box.appendChild(h);
      box.appendChild(p);
      box.appendChild(actions);
      mask.appendChild(box);
      document.body.appendChild(mask);
    });
  }

  function askConfirm(message) {
    return openDialog({ title: '确认操作', message: message, danger: true, okText: '删除' });
  }

  function showAlert(message, title) {
    return openDialog({ title: title || '提示', message: message });
  }

  async function deleteSession(e, id) {
    e.stopPropagation();
    if (!(await askConfirm('确认删除这个对话吗？删除后无法恢复。'))) return;
    if (currentSessionId === id && typeof abortActiveStream === 'function') {
      abortActiveStream();
    }
    sessions = sessions.filter(s => s.id !== id);
    saveSessions();
    if (sessions.length === 0) createNewSession();
    else if (currentSessionId === id) switchSession(sessions[0].id);
    else renderSessionList();
  }

`;
