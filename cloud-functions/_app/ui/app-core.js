// 前端基础：HTML 转义、Markdown 渲染与安全清洗（_worker.js 原第 3483-3547 行，内嵌页面分片；只允许字符串导出）
export default `<script>
  let isCurrentlyStreaming = false;
  let currentAbortController = null; 

  const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
  const ESCAPE_REG = /[&<>]/g;
  const escapeHtml = str => str.replace(ESCAPE_REG, m => ESCAPE_MAP[m]);

  // AI 输出统一走 safeHtml：先 Markdown 渲染，再做 XSS 清洗。
  // DOMPurify 经 CDN 加载；若加载失败则降级为"解析后取纯文本"，保证永远安全。
  // 注意：本段在外层模板字符串内，不写反斜杠、反引号，避免两层转义破坏代码
  //（split 的分隔符写作双反斜杠加 n，经模板层转义后即为页面脚本里的换行符转义）。
  // v6.8.9：marked 也是 CDN 依赖 —— marked 缺失时按纯文本渲染（转义 + 换行转 <br>）。
  function safeHtml(mdText) {
    var raw = '';
    if (window.marked && window.marked.parse) {
      try { raw = marked.parse(mdText || ''); } catch (e) { raw = ''; }
    } else {
      return escapeHtml(mdText || '').split('\\n').join('<br>');
    }
    try {
      if (window.DOMPurify && window.DOMPurify.sanitize) return window.DOMPurify.sanitize(raw);
    } catch (e) {}
    var tmp = document.createElement('div');
    tmp.innerHTML = raw;
    return tmp.textContent || '';
  }

  // 属性值转义：比 escapeHtml 多转义引号，避免拼 HTML 时被属性注入
  const escAttr = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  if (window.marked && window.marked.Renderer) {
    const renderer = new marked.Renderer();
    renderer.code = function(code, language) {
      const displayLang = language || 'text';
      const escapedCode = escapeHtml(code);

      let highlightedCode = escapedCode;
      // hljs 同为 CDN 依赖，缺失时直接展示转义后的纯文本代码
      if (window.hljs && !isCurrentlyStreaming && language && hljs.getLanguage(language)) {
        try {
          highlightedCode = hljs.highlight(code, { language }).value;
        } catch (e) {}
      } else if (window.hljs && !isCurrentlyStreaming) {
        try {
          highlightedCode = hljs.highlightAuto(code).value;
        } catch (e) {}
      }

      // 使用纯字符串拼接，消灭反引号
      return '<div class="code-wrapper">' +
               '<div class="code-header">' +
                 '<span>' + displayLang + '</span>' +
                 '<button class="copy-btn" data-code="' + encodeURIComponent(code) + '">' +
                   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>' +
                   '<span>复制代码</span>' +
                 '</button>' +
               '</div>' +
               '<pre><code class="hljs ' + (language || '') + '">' + highlightedCode + '</code></pre>' +
             '</div>';
    };

    // 生图结果可视化：图片外包一层链接，点击可在新标签页看原图。
    // data: 内联图片不再包链接 —— href 里再放一份 base64 会让 DOM 体积凭空翻倍。
    renderer.image = function(href, title, text) {
      const src = String(href == null ? '' : href);
      const alt = escAttr(text == null || text === '' ? '生成结果' : text);
      const tip = escAttr(title || '点击查看原图');
      const img = '<img src="' + escAttr(src) + '" alt="' + alt + '" title="' + tip + '" loading="lazy">';
      if (!src || src.indexOf('data:') === 0) return img;
      return '<a class="md-img-link" href="' + escAttr(src) + '" target="_blank" rel="noopener noreferrer">' + img + '</a>';
    };

    marked.setOptions({ breaks: true, renderer: renderer });
  }

  // v6.9.5：复用 copyText，兼容非安全上下文并提供异常保护
  document.addEventListener('click', function(e) {
    const copyBtn = e.target.closest('.copy-btn');
    if (!copyBtn) return;
    const code = decodeURIComponent(copyBtn.getAttribute('data-code') || '');
    copyText(code).then((ok) => {
      if (!ok) return;
      const span = copyBtn.querySelector('span');
      if (!span) return;
      const originalText = span.innerText;
      span.innerText = '已复制';
      setTimeout(() => { span.innerText = originalText; }, 2000);
    });
  });

`;
