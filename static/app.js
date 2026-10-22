(() => {
  'use strict';

  const doc = document;
  const body = doc.body;
  const csrfMeta = doc.querySelector('meta[name="csrf-token"]');
  const csrfToken = csrfMeta ? csrfMeta.content : '';
  const toastStack = doc.getElementById('toast-stack');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const qs = (selector, root = doc) => root.querySelector(selector);
  const qsa = (selector, root = doc) => Array.from(root.querySelectorAll(selector));

  function svgIcon(name, className = 'icon') {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', className);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const use = doc.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  }

  /* ---------- Toasts ---------- */
  const toastTimers = new WeakMap();

  function dismissToast(toast) {
    if (!toast || toast.classList.contains('is-leaving')) return;
    const timer = toastTimers.get(toast);
    if (timer) clearTimeout(timer);
    toast.classList.add('is-leaving');
    window.setTimeout(() => toast.remove(), reduceMotion ? 0 : 200);
  }

  function armToast(toast, timeout = 7000) {
    if (!toast) return;
    const timer = window.setTimeout(() => dismissToast(toast), timeout);
    toastTimers.set(toast, timer);
    toast.addEventListener('mouseenter', () => {
      const active = toastTimers.get(toast);
      if (active) clearTimeout(active);
    });
    toast.addEventListener('mouseleave', () => {
      const next = window.setTimeout(() => dismissToast(toast), 2600);
      toastTimers.set(toast, next);
    });
  }

  function showToast(message, type = 'info', timeout = 6500) {
    if (!toastStack || !message) return;
    const toast = doc.createElement('div');
    toast.className = 'toast toast-' + type;
    toast.setAttribute('role', 'status');

    const iconWrap = doc.createElement('span');
    iconWrap.className = 'toast-icon';
    const iconName = type === 'success' ? 'check-circle' : type === 'error' ? 'alert-circle' : type === 'warning' ? 'alert' : 'info';
    iconWrap.appendChild(svgIcon(iconName));

    const copy = doc.createElement('span');
    copy.className = 'toast-message';
    copy.textContent = message;

    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', '关闭提示');
    close.setAttribute('data-toast-close', '');
    close.appendChild(svgIcon('x'));

    toast.append(iconWrap, copy, close);
    toastStack.appendChild(toast);
    armToast(toast, timeout);
  }

  qsa('.toast').forEach((toast) => armToast(toast, 6500));
  doc.addEventListener('click', (event) => {
    const close = event.target.closest('[data-toast-close]');
    if (!close) return;
    dismissToast(close.closest('.toast'));
  });

  /* ---------- Theme ---------- */
  const themeOrder = ['auto', 'light', 'dark'];
  const themeTitles = { auto: '主题：跟随系统', light: '主题：浅色', dark: '主题：深色' };

  function applyTheme(mode) {
    if (!themeOrder.includes(mode)) mode = 'auto';
    doc.documentElement.setAttribute('data-theme', mode);
    qsa('[data-theme-toggle]').forEach((button) => {
      button.setAttribute('data-mode', mode);
      button.setAttribute('title', themeTitles[mode] + '，点击切换');
      button.setAttribute('aria-label', themeTitles[mode] + '，点击切换');
    });
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    doc.cookie = 'ddns_theme=' + mode + '; Path=/; Max-Age=31536000; SameSite=Lax' + secure;
  }

  qsa('[data-theme-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const current = button.getAttribute('data-mode') || 'auto';
      const index = themeOrder.indexOf(current);
      applyTheme(themeOrder[(index + 1) % themeOrder.length]);
    });
  });

  /* ---------- Countdown ---------- */
  function formatCountdown(target) {
    const diff = target.getTime() - Date.now();
    if (diff <= 1500) return '即将开始';
    const seconds = Math.ceil(diff / 1000);
    if (seconds < 60) return seconds + ' 秒后';
    const minutes = Math.ceil(seconds / 60);
    if (minutes < 60) return minutes + ' 分钟后';
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours < 24) return rest ? hours + ' 小时 ' + rest + ' 分' : hours + ' 小时';
    const days = Math.ceil(hours / 24);
    return days + ' 天后';
  }

  function updateCountdowns() {
    qsa('[data-countdown-target]').forEach((element) => {
      const raw = element.getAttribute('data-countdown-target');
      if (!raw) return;
      const target = new Date(raw);
      if (Number.isNaN(target.getTime())) return;
      if (!element.getAttribute('title')) {
        element.setAttribute('title', target.toLocaleString('zh-CN'));
      }
      const text = formatCountdown(target);
      if (element.textContent !== text) element.textContent = text;
    });
  }

  if (qsa('[data-countdown-target]').length) {
    updateCountdowns();
    window.setInterval(updateCountdowns, 15000);
  }

  /* ---------- Navigation ---------- */
  function openNav() {
    body.classList.add('nav-open');
  }

  function closeNav() {
    body.classList.remove('nav-open');
  }

  qsa('[data-open-nav]').forEach((button) => button.addEventListener('click', openNav));
  qsa('[data-close-nav]').forEach((element) => element.addEventListener('click', closeNav));
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeNav();
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth > 900) closeNav();
  });
  qsa('.sidebar-nav a').forEach((link) => link.addEventListener('click', closeNav));

  /* ---------- Dialogs ---------- */
  function openDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.showModal === 'function') {
      try {
        dialog.showModal();
      } catch (_) {
        dialog.setAttribute('open', '');
      }
    } else {
      dialog.setAttribute('open', '');
    }
    body.classList.add('modal-open');
  }

  function closeDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
    if (!qs('dialog[open]')) body.classList.remove('modal-open');
  }

  doc.addEventListener('click', (event) => {
    const closer = event.target.closest('[data-close-dialog]');
    if (closer) {
      closeDialog(closer.closest('dialog'));
      return;
    }
    if (event.target instanceof HTMLDialogElement && event.target.hasAttribute('open')) {
      closeDialog(event.target);
    }
  });

  doc.addEventListener('close', (event) => {
    if (event.target instanceof HTMLDialogElement && !qs('dialog[open]')) {
      body.classList.remove('modal-open');
    }
  }, true);

  /* ---------- Confirm forms ---------- */
  const confirmDialog = doc.getElementById('confirm-dialog');
  const confirmForm = doc.getElementById('confirm-form');
  const confirmTitle = qs('[data-confirm-title]', confirmDialog || doc);
  const confirmMessage = qs('[data-confirm-message]', confirmDialog || doc);
  const confirmLabel = qs('[data-confirm-submit]', confirmDialog || doc);

  doc.addEventListener('submit', (event) => {
    const form = event.target.closest('form[data-confirm]');
    if (!form || !confirmDialog || !confirmForm) return;
    event.preventDefault();
    confirmForm.setAttribute('action', form.getAttribute('action') || '/');
    if (confirmTitle) confirmTitle.textContent = form.getAttribute('data-confirm-title') || '确认操作';
    if (confirmMessage) confirmMessage.textContent = form.getAttribute('data-confirm-message') || '此操作无法撤销。';
    if (confirmLabel) confirmLabel.textContent = form.getAttribute('data-confirm-label') || '确认';
    openDialog(confirmDialog);
  }, true);

  /* ---------- Secret visibility ---------- */
  doc.addEventListener('click', (event) => {
    const button = event.target.closest('[data-secret-toggle]');
    if (!button) return;
    const holder = button.closest('.input-with-button');
    const input = holder && holder.querySelector('input');
    if (!input) return;
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    const use = button.querySelector('use');
    if (use) use.setAttribute('href', reveal ? '#i-eye-off' : '#i-eye');
    button.setAttribute('aria-label', reveal ? '隐藏内容' : '显示内容');
    button.setAttribute('title', reveal ? '隐藏内容' : '显示内容');
  });

  /* ---------- Copy ---------- */
  function fallbackCopy(text) {
    const area = doc.createElement('textarea');
    area.value = text;
    area.className = 'copy-helper';
    area.setAttribute('readonly', '');
    doc.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = doc.execCommand('copy');
    } catch (_) {
      ok = false;
    }
    area.remove();
    return ok;
  }

  doc.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy]');
    if (!button) return;
    const text = button.getAttribute('data-copy') || '';
    if (!text) return;
    let copied = false;
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch (_) {
        copied = false;
      }
    }
    if (!copied) copied = fallbackCopy(text);
    showToast(copied ? 'IP 已复制到剪贴板' : '复制失败，请手动选择', copied ? 'success' : 'error', 3500);
  });

  /* ---------- File inputs ---------- */
  qsa('[data-file-input]').forEach((input) => {
    input.addEventListener('change', () => {
      const label = input.closest('[data-file-drop]');
      const name = label && label.querySelector('[data-file-name]');
      if (!name) return;
      name.textContent = input.files && input.files.length ? input.files[0].name : '选择备份文件';
    });
  });

  /* ---------- Misc ---------- */
  qsa('[data-go-back]').forEach((button) => {
    button.addEventListener('click', () => {
      if (window.history.length > 1) window.history.back();
      else window.location.assign('/');
    });
  });

  if (body.getAttribute('data-sync-running') === 'true') {
    const startedAt = Date.now();
    const watchSync = async () => {
      try {
        const response = await fetch('/healthz', { cache: 'no-store' });
        if (response.ok) {
          const health = await response.json();
          if (!health.syncing) {
            window.location.reload();
            return;
          }
        }
      } catch (_) {
        /* 网络抖动时继续轮询 */
      }
      if (Date.now() - startedAt < 180000) {
        window.setTimeout(watchSync, 4000);
      }
    };
    window.setTimeout(watchSync, 4000);
  }

  /* ---------- API helpers ---------- */
  async function apiPost(url, payload) {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-CSRF-Token': csrfToken,
        'X-Requested-With': 'fetch'
      },
      body: JSON.stringify(payload || {})
    });
    if (response.redirected) {
      throw new Error('登录状态已失效，请刷新页面重新登录');
    }
    const type = response.headers.get('content-type') || '';
    if (!type.includes('application/json')) {
      throw new Error('服务器返回了非预期响应，请刷新页面重试');
    }
    const data = await response.json();
    if (!response.ok || data.ok === false) {
      throw new Error(data.error || '请求失败（HTTP ' + response.status + '）');
    }
    return data;
  }

  /* ---------- API tests ---------- */
  const testButtons = qsa('[data-api-test]');
  testButtons.forEach((button) => {
    button.addEventListener('click', async () => {
      const kind = button.getAttribute('data-api-test');
      const endpoint = button.getAttribute('data-endpoint');
      const form = button.closest('form');
      const result = form ? form.querySelector('[data-test-result="' + kind + '"]') : null;
      if (!endpoint) return;

      const payload = {};
      if (kind === 'cloudflare') {
        const input = form && form.querySelector('input[name="token"]');
        payload.token = input ? input.value.trim() : '';
      } else if (kind === 'telegram') {
        const tokenInput = form && form.querySelector('input[name="tg_token"]');
        const chatInput = form && form.querySelector('input[name="tg_chat_id"]');
        payload.token = tokenInput ? tokenInput.value.trim() : '';
        payload.chat_id = chatInput ? chatInput.value.trim() : '';
      }

      const previous = button.innerHTML;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      if (result) {
        result.textContent = '正在验证…';
        result.className = 'test-result';
      }
      try {
        const data = await apiPost(endpoint, payload);
        if (result) {
          result.textContent = data.message || '验证通过';
          result.className = 'test-result is-ok';
        }
      } catch (error) {
        if (result) {
          result.textContent = error.message;
          result.className = 'test-result is-error';
        }
      } finally {
        button.disabled = false;
        button.removeAttribute('aria-busy');
        button.innerHTML = previous;
      }
    });
  });

  /* ---------- Domain dialog ---------- */
  const domainDialog = doc.getElementById('domain-dialog');
  const domainForm = doc.getElementById('domain-form');

  if (domainDialog && domainForm) {
    const titleEl = qs('[data-domain-title]', domainDialog);
    const subtitleEl = qs('[data-domain-subtitle]', domainDialog);
    const submitLabel = qs('[data-domain-submit-label]', domainDialog);
    const nameInput = qs('#domain-name', domainDialog);
    const idInput = qs('input[name="id"]', domainDialog);
    const sourceRadios = qsa('input[name="ip_source"]', domainDialog);
    const typeRadios = qsa('input[name="record_type"]', domainDialog);
    const interfaceField = qs('[data-interface-field]', domainDialog);
    const interfaceSelect = qs('#domain-interface', domainDialog);
    const ttlSelect = qs('#domain-ttl', domainDialog);
    const proxiedInput = qs('input[name="proxied"]', domainDialog);
    const createInput = qs('input[name="create_if_missing"]', domainDialog);
    const errorBox = qs('[data-domain-error]', domainDialog);
    const inspectButton = qs('[data-inspect-domain]', domainDialog);
    const inspectBox = qs('[data-inspect-result]', domainDialog);
    const submitButton = qs('[data-domain-submit]', domainDialog);

    let interfaceCache = [];

    function selectedSource() {
      const checked = sourceRadios.find((radio) => radio.checked);
      return checked ? checked.value : 'api';
    }

    function selectedType() {
      const checked = typeRadios.find((radio) => radio.checked);
      return checked && checked.value === 'AAAA' ? 'AAAA' : 'A';
    }

    function renderInterfaceOptions(previous) {
      if (!interfaceSelect) return;
      interfaceSelect.innerHTML = '';
      const wantV6 = selectedType() === 'AAAA';
      const family = wantV6 ? 'IPv6' : 'IPv4';
      if (!interfaceCache.length) {
        const option = doc.createElement('option');
        option.value = '';
        option.textContent = '未发现可用网卡';
        interfaceSelect.appendChild(option);
        return;
      }
      let firstUsable = '';
      interfaceCache.forEach((iface) => {
        const addresses = (Array.isArray(iface.addresses) ? iface.addresses : []).filter((address) => address.includes(':') === wantV6);
        const option = doc.createElement('option');
        option.value = iface.name;
        option.textContent = iface.name + ' · ' + (addresses.length ? addresses[0] : '无可用 ' + family);
        option.title = addresses.length ? addresses.join(', ') : iface.name + ' 没有可用的 ' + family + ' 地址';
        option.disabled = addresses.length === 0;
        if (!option.disabled && !firstUsable) firstUsable = iface.name;
        interfaceSelect.appendChild(option);
      });
      const preferred = previous ? interfaceSelect.querySelector('option[value="' + CSS.escape(previous) + '"]:not(:disabled)') : null;
      interfaceSelect.value = preferred ? previous : firstUsable;
    }

    function syncInterfaceVisibility() {
      const show = selectedSource() === 'interface';
      interfaceField.hidden = !show;
      interfaceSelect.disabled = !show;
    }

    function syncTTLState() {
      const proxied = proxiedInput.checked;
      ttlSelect.disabled = proxied;
    }

    function setRadio(radios, value) {
      radios.forEach((radio) => {
        radio.checked = radio.value === value;
      });
    }

    function setInspectError(message) {
      if (!inspectBox) return;
      inspectBox.hidden = false;
      inspectBox.textContent = '';
      const strong = doc.createElement('strong');
      strong.textContent = '检测失败';
      const text = doc.createElement('span');
      text.textContent = message;
      inspectBox.append(strong, text);
      inspectBox.classList.add('is-error');
    }

    function renderInspection(data) {
      if (!inspectBox) return;
      inspectBox.hidden = false;
      inspectBox.textContent = '';
      inspectBox.classList.remove('is-error');

      const strong = doc.createElement('strong');
      strong.textContent = 'Zone：' + (data.zone || '已定位');
      inspectBox.appendChild(strong);

      const records = Array.isArray(data.records) ? data.records : [];
      if (!records.length) {
        const empty = doc.createElement('span');
        empty.textContent = 'Cloudflare 上还没有该域名的 A / AAAA 记录，可开启“自动创建记录”。';
        inspectBox.appendChild(empty);
        return;
      }
      records.forEach((record) => {
        const row = doc.createElement('span');
        row.className = 'inspect-record';
        const badge = doc.createElement('span');
        badge.className = 'badge badge-' + (record.type === 'AAAA' ? 'violet' : 'indigo');
        badge.textContent = record.type;
        const ip = doc.createElement('code');
        ip.textContent = record.content;
        const meta = doc.createElement('span');
        meta.textContent = (record.proxied ? '已代理' : '仅 DNS') + ' · TTL ' + (record.ttl > 1 ? record.ttl + 's' : '自动');
        row.append(badge, ip, meta);
        inspectBox.appendChild(row);
      });
    }

    async function loadInterfaces(selected) {
      if (!interfaceSelect) return;
      const previous = selected || interfaceSelect.value;
      interfaceSelect.innerHTML = '';
      const loading = doc.createElement('option');
      loading.value = '';
      loading.textContent = '正在读取网卡…';
      interfaceSelect.appendChild(loading);
      interfaceSelect.disabled = selectedSource() !== 'interface';

      try {
        const response = await fetch('/api/interfaces', {
          credentials: 'same-origin',
          headers: { 'Accept': 'application/json', 'X-Requested-With': 'fetch' }
        });
        if (response.redirected) throw new Error('登录状态已失效，请刷新页面');
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || '读取网卡失败');

        interfaceCache = Array.isArray(data.interfaces) ? data.interfaces : [];
        renderInterfaceOptions(previous);
      } catch (error) {
        interfaceCache = [];
        interfaceSelect.innerHTML = '';
        const option = doc.createElement('option');
        option.value = '';
        option.textContent = '读取失败，请刷新重试';
        interfaceSelect.appendChild(option);
        showToast(error.message, 'error');
      }
      interfaceSelect.disabled = selectedSource() !== 'interface';
    }

    function resetDomainForm() {
      domainForm.reset();
      domainForm.setAttribute('action', '/domains');
      idInput.value = '';
      setRadio(sourceRadios, 'api');
      setRadio(typeRadios, 'A');
      ttlSelect.value = '1';
      proxiedInput.checked = false;
      createInput.checked = true;
      if (errorBox) {
        errorBox.hidden = true;
        errorBox.textContent = '';
      }
      if (inspectBox) {
        inspectBox.hidden = true;
        inspectBox.textContent = '';
        inspectBox.classList.remove('is-error');
      }
      if (titleEl) titleEl.textContent = '添加域名';
      if (subtitleEl) subtitleEl.textContent = '将域名交给面板自动维护';
      if (submitLabel) submitLabel.textContent = '添加并同步';
      syncInterfaceVisibility();
      syncTTLState();
      loadInterfaces('');
    }

    function fillDomainForm(button) {
      domainForm.reset();
      const id = button.getAttribute('data-id') || '';
      domainForm.setAttribute('action', '/domains/' + id);
      idInput.value = id;
      nameInput.value = button.getAttribute('data-name') || '';
      setRadio(typeRadios, button.getAttribute('data-type') === 'AAAA' ? 'AAAA' : 'A');
      setRadio(sourceRadios, button.getAttribute('data-source') === 'interface' ? 'interface' : 'api');
      ttlSelect.value = button.getAttribute('data-ttl') || '1';
      proxiedInput.checked = button.getAttribute('data-proxied') === 'true';
      createInput.checked = button.getAttribute('data-create') === 'true';
      if (errorBox) {
        errorBox.hidden = true;
        errorBox.textContent = '';
      }
      if (inspectBox) {
        inspectBox.hidden = true;
        inspectBox.textContent = '';
        inspectBox.classList.remove('is-error');
      }
      if (titleEl) titleEl.textContent = '编辑域名';
      if (subtitleEl) subtitleEl.textContent = '更新后会立即重新检查 Cloudflare 记录';
      if (submitLabel) submitLabel.textContent = '保存并同步';
      syncInterfaceVisibility();
      syncTTLState();
      loadInterfaces(button.getAttribute('data-interface') || '');
    }

    qsa('[data-open-domain]').forEach((button) => {
      button.addEventListener('click', () => {
        resetDomainForm();
        openDialog(domainDialog);
        window.setTimeout(() => nameInput.focus(), 80);
      });
    });

    doc.addEventListener('click', (event) => {
      const button = event.target.closest('[data-edit-domain]');
      if (!button) return;
      fillDomainForm(button);
      openDialog(domainDialog);
    });

    sourceRadios.forEach((radio) => radio.addEventListener('change', syncInterfaceVisibility));
    typeRadios.forEach((radio) => radio.addEventListener('change', () => renderInterfaceOptions(interfaceSelect.value)));
    proxiedInput.addEventListener('change', syncTTLState);
    nameInput.addEventListener('input', () => {
      if (inspectBox) {
        inspectBox.hidden = true;
        inspectBox.textContent = '';
      }
      if (errorBox) {
        errorBox.hidden = true;
        errorBox.textContent = '';
      }
    });

    if (inspectButton) {
      inspectButton.addEventListener('click', async () => {
        const name = nameInput.value.trim();
        if (!name) {
          showToast('请先填写记录域名', 'warning');
          nameInput.focus();
          return;
        }
        if (errorBox) {
          errorBox.hidden = true;
          errorBox.textContent = '';
        }
        const previous = inspectButton.innerHTML;
        inspectButton.disabled = true;
        inspectButton.innerHTML = '';
        inspectButton.appendChild(svgIcon('spinner', 'icon spin'));
        const text = doc.createElement('span');
        text.textContent = ' 检测中';
        inspectButton.appendChild(text);
        if (inspectBox) {
          inspectBox.hidden = false;
          inspectBox.textContent = '正在向 Cloudflare 查询…';
          inspectBox.classList.remove('is-error');
        }
        try {
          const data = await apiPost('/api/domain/inspect', { name });
          renderInspection(data);
        } catch (error) {
          setInspectError(error.message);
        } finally {
          inspectButton.disabled = false;
          inspectButton.innerHTML = previous;
        }
      });
    }

    domainForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (errorBox) {
        errorBox.hidden = true;
        errorBox.textContent = '';
      }
      if (selectedSource() === 'interface' && !interfaceSelect.value) {
        if (errorBox) {
          errorBox.textContent = '请选择要读取 IP 的网卡';
          errorBox.hidden = false;
        }
        showToast('请选择要读取 IP 的网卡', 'warning');
        return;
      }
      const previous = submitButton.innerHTML;
      submitButton.disabled = true;
      submitButton.innerHTML = '';
      submitButton.appendChild(svgIcon('spinner', 'icon spin'));
      const saving = doc.createElement('span');
      saving.textContent = ' 保存中';
      submitButton.appendChild(saving);

      try {
        const response = await fetch(domainForm.getAttribute('action'), {
          method: 'POST',
          body: new FormData(domainForm),
          credentials: 'same-origin',
          headers: {
            'Accept': 'application/json',
            'X-CSRF-Token': csrfToken,
            'X-Requested-With': 'fetch'
          }
        });
        if (response.redirected) {
          window.location.assign(response.url);
          return;
        }
        const type = response.headers.get('content-type') || '';
        if (!type.includes('application/json')) {
          throw new Error('服务器返回了非预期响应，请刷新页面重试');
        }
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || '保存失败');
        window.location.assign(data.redirect || '/');
      } catch (error) {
        if (errorBox) {
          errorBox.textContent = error.message;
          errorBox.hidden = false;
        }
        showToast(error.message, 'error');
        submitButton.disabled = false;
        submitButton.innerHTML = previous;
      }
    });
  }

})();
