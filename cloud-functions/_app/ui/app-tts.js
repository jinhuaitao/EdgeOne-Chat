// 语音朗读（Web Speech API，浏览器原生，无需 API Key）（_worker.js 原第 3548-3698 行，内嵌页面分片；只允许字符串导出）
export default `  // ===== 语音朗读（Web Speech API，浏览器原生，无需任何 API Key）=====
  const TTS_AUTO_KEY = 'tts_auto';
  let autoSpeak = localStorage.getItem(TTS_AUTO_KEY) === '1';
  let activeSpeakBtn = null;

  const SPEAK_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>';
  // 消息操作图标（纯字符串拼接，不写反引号/反斜杠，避免模板字符串两层转义）
  const COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
  const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  const REGEN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 5 22 10 17 10"></polyline><path d="M19.7 14.6A8 8 0 1 1 17.7 6.3L22 10"></path></svg>';

  // 复制文本：优先用剪贴板 API，非安全上下文（http 非 localhost）降级到 execCommand
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  // 点击后短暂换成「已完成」图标，让纯图标按钮有明确反馈
  function flashIcon(btn, doneIcon, backIcon) {
    btn.innerHTML = doneIcon;
    btn.classList.add('done');
    clearTimeout(btn.__flashTimer);
    btn.__flashTimer = setTimeout(function () {
      btn.innerHTML = backIcon;
      btn.classList.remove('done');
    }, 1300);
  }

  function updateTtsToggleUI() {
    const btn = document.getElementById('ttsToggle');
    if (btn) {
      btn.classList.toggle('active', autoSpeak);
      btn.title = autoSpeak ? '自动朗读：已开启（点击关闭）' : '自动朗读：已关闭（点击开启）';
    }
  }

  // 把 Markdown / 代码块清理成适合朗读的纯文本
  // ⚠️ 本段位于外层模板字符串内部，存在「两层转义」：
  //    模板字符串吃掉一层反斜杠，浏览器解析 JS 字符串字面量再吃掉一层。
  //    因此这里【完全不写反斜杠】，一律用字符码拼接，避免正则被破坏。
  function cleanForSpeech(text) {
    if (!text) return '';
    const BT = String.fromCharCode(96);  // 反引号
    const BS = String.fromCharCode(92);  // 反斜杠
    const NL = String.fromCharCode(10);  // 换行
    const TAB = String.fromCharCode(9);
    // 用 @ 占位，展开成反斜杠；这样源码里不出现任何反斜杠
    const rx = function (p) { return p.split('@').join(BS); };

    const rules = [
      [BT + BT + BT + rx('[@s@S]*?') + BT + BT + BT, 'g', ' （代码块已省略） '],
      [BT + '([^' + BT + ']*)' + BT, 'g', '$1'],
      [rx('!@[[^@]]*@]@([^)]*@)'), 'g', ' （图片） '],
      [rx('@[([^@]]*)@]@([^)]*@)'), 'g', '$1'],
      [rx('^@s{0,3}#{1,6}@s*'), 'gm', ''],
      [rx('^@s{0,3}>@s?'), 'gm', ''],
      [rx('(@*@*|__)(.*?)@1'), 'g', '$2'],
      [rx('(@*|_)(.*?)@1'), 'g', '$2'],
      [rx('^@s*[-*+]@s+'), 'gm', ''],
      [rx('^@s*@d+@.@s+'), 'gm', ''],
      [rx('@|'), 'g', ' '],
      ['^[-=]{3,}$', 'gm', ' '],
      [rx('^[@s:-]*[-:][@s:-]*$'), 'gm', ''],
      ['[ ' + TAB + ']{2,}', 'g', ' '],
      [rx('@n{3,}'), 'g', NL + NL]
    ];

    let out = String(text);
    for (let i = 0; i < rules.length; i++) {
      try {
        out = out.replace(new RegExp(rules[i][0], rules[i][1]), rules[i][2]);
      } catch (e) { /* 单条规则异常不影响其余 */ }
    }
    return out.trim();
  }

  // 是否包含中日韩字符（用于选择朗读语言）
  function containsCJK(text) {
    const re = new RegExp('[' + String.fromCharCode(0x4e00) + '-' + String.fromCharCode(0x9fff) + ']');
    return re.test(text);
  }

  function getBubbleText(bubble) {
    const box = bubble.querySelector('.message-text') || bubble;
    return (box.innerText || box.textContent || '').trim();
  }

  function stopSpeaking() {
    if (window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch (e) {}
    }
    if (activeSpeakBtn) {
      activeSpeakBtn.classList.remove('speaking');
      activeSpeakBtn.title = '朗读这条回复';
      activeSpeakBtn.setAttribute('aria-label', '朗读这条回复');
      activeSpeakBtn = null;
    }
  }

  function toggleSpeak(btn, bubble) {
    if (btn.classList.contains('speaking')) { stopSpeaking(); return; }

    if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
      showAlert('当前浏览器不支持语音朗读，请使用 Chrome / Edge / Safari 较新版本。');
      return;
    }

    stopSpeaking();

    const text = cleanForSpeech(getBubbleText(bubble));
    if (!text) return;

    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = containsCJK(text) ? 'zh-CN' : 'en-US';
    utter.rate = 1;
    utter.pitch = 1;

    const reset = () => {
      if (activeSpeakBtn === btn) {
        btn.classList.remove('speaking');
        btn.title = '朗读这条回复';
        btn.setAttribute('aria-label', '朗读这条回复');
        activeSpeakBtn = null;
      }
    };
    utter.onend = reset;
    utter.onerror = reset;

    activeSpeakBtn = btn;
    btn.classList.add('speaking');
    btn.title = '停止朗读';
    btn.setAttribute('aria-label', '停止朗读');

    window.speechSynthesis.speak(utter);
  }

`;
