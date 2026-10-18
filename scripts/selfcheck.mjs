// 移植自检脚本：不需要 EdgeOne 环境，纯本地验证「模块图能加载 + 存储适配层契约正确 + 路由可用」。
// 运行：node scripts/selfcheck.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  \u2713 ' + name);
  } catch (e) {
    fail++;
    console.log('  \u2717 ' + name + '\n      ' + (e && e.message ? e.message : String(e)));
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  \u2713 ' + name);
  } catch (e) {
    fail++;
    console.log('  \u2717 ' + name + '\n      ' + (e && e.message ? e.message : String(e)));
  }
}

// ---------- 内存版 Blob / KV 假实现，用于验证适配层契约 ----------
// 记录每次读调用收到的 options，用来断言一致性参数真的传下去了
function fakeBlobStore() {
  const m = new Map();
  const calls = { get: [], list: [] };
  return {
    __calls: calls,
    async set(k, v) { m.set(String(k), typeof v === 'string' ? v : String(v)); },
    async setJSON(k, v) { m.set(String(k), JSON.stringify(v)); },
    async get(k, opts) {
      calls.get.push({ key: String(k), opts: opts });
      return m.has(String(k)) ? m.get(String(k)) : null;
    },
    async delete(k) { m.delete(String(k)); },
    async list(opts) {
      calls.list.push(opts);
      const prefix = (opts && opts.prefix) || '';
      const blobs = [...m.keys()].filter(k => k.startsWith(prefix)).map(k => ({ key: k, etag: 'e' + k.length }));
      return { blobs };
    },
  };
}

// 抛指定错误码的 Blob Store，用来验证错误不会被静默吞掉
function throwingBlobStore(code) {
  const e = new Error('simulated ' + code);
  e.code = code;
  return {
    async set() { throw e; },
    async setJSON() { throw e; },
    async get() { throw e; },
    async delete() { throw e; },
    async list() { throw e; },
  };
}

function fakeKvNamespace() {
  const m = new Map();
  return {
    async put(k, v) { m.set(String(k), String(v)); },
    async get(k) { return m.has(String(k)) ? m.get(String(k)) : null; },
    async delete(k) { m.delete(String(k)); },
    async list(opts) {
      opts = opts || {};
      const prefix = opts.prefix || '';
      const limit = opts.limit || 256;
      const all = [...m.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = opts.cursor ? (parseInt(String(opts.cursor), 10) || 0) : 0;
      const page = all.slice(start, start + limit);
      const next = start + page.length;
      const complete = next >= all.length;
      return { complete, cursor: complete ? null : String(next), keys: page.map(k => ({ key: k })) };
    },
  };
}

// 内存版 localStorage，用来对「旧键自动迁移」做行为级测试
function fakeLocalStorage(init) {
  const m = new Map(Object.entries(init || {}));
  return {
    getItem(k) { return m.has(String(k)) ? m.get(String(k)) : null; },
    setItem(k, v) { m.set(String(k), String(v)); },
    removeItem(k) { m.delete(String(k)); },
    __dump() { const o = {}; m.forEach((v, k) => { o[k] = v; }); return o; },
  };
}

// 用同一套 R2 契约用例同时打两个后端
async function runR2Contract(label, store) {
  console.log('\n[' + label + '] R2 契约');

  await checkAsync('put / get 文本往返', async () => {
    await store.put('kb/docs/测试文档.md', '---\ntitle: "测试"\n---\n\n正文内容');
    const obj = await store.get('kb/docs/测试文档.md');
    assert.ok(obj, 'get 应返回对象');
    assert.equal(await obj.text(), '---\ntitle: "测试"\n---\n\n正文内容');
  });

  await checkAsync('get 不存在的 key 返回 null', async () => {
    assert.equal(await store.get('不存在/key.md'), null);
  });

  await checkAsync('get 的 range 选项按 offset/length 切片', async () => {
    await store.put('range.txt', '0123456789ABCDEF');
    const obj = await store.get('range.txt', { range: { offset: 4, length: 6 } });
    assert.equal(await obj.text(), '456789');
  });

  await checkAsync('delete 支持字符串数组（对齐 R2 批量删除）', async () => {
    await store.put('bulk/a', '1');
    await store.put('bulk/b', '2');
    await store.put('bulk/c', '3');
    await store.delete(['bulk/a', 'bulk/b', 'bulk/c']);
    assert.equal(await store.get('bulk/a'), null);
    assert.equal(await store.get('bulk/b'), null);
    assert.equal(await store.get('bulk/c'), null);
  });

  await checkAsync('list 的 prefix / objects[].key / truncated / cursor 语义正确', async () => {
    for (let i = 0; i < 5; i++) await store.put('page/doc' + i + '.md', 'v' + i);
    const first = await store.list({ prefix: 'page/', limit: 2 });
    assert.equal(first.objects.length, 2, 'limit 应生效');
    assert.equal(first.truncated, true, '还有剩余时应 truncated=true');
    assert.ok(first.objects.every(o => o.key.startsWith('page/')), 'prefix 应生效');
    assert.equal(typeof first.cursor, 'string');
    const second = await store.list({ prefix: 'page/', limit: 2, cursor: first.cursor });
    assert.equal(second.objects.length, 2);
    const third = await store.list({ prefix: 'page/', limit: 2, cursor: second.cursor });
    assert.equal(third.objects.length, 1);
    assert.equal(third.truncated, false);
    const seen = new Set([...first.objects, ...second.objects, ...third.objects].map(o => o.key));
    assert.equal(seen.size, 5, '三页合起来应覆盖全部 5 个对象且不重复');
  });

  await checkAsync('list 结果对应用层字段 size / uploaded 不抛错', async () => {
    const r = await store.list({ prefix: 'page/', limit: 1 });
    const o = r.objects[0];
    assert.ok('size' in o && 'uploaded' in o);
    assert.equal(typeof o.size, 'number');
  });
}

async function main() {
  console.log('=== 1. 模块图加载 ===');
  let mod;
  await checkAsync('cloud-functions/_app/entry.js 可被完整加载', async () => {
    mod = await import('../cloud-functions/_app/entry.js');
    assert.equal(typeof mod.handle, 'function');
  });

  let blobBackend;
  let kvBackend;
  await checkAsync('适配层模块可加载', async () => {
    blobBackend = await import('../cloud-functions/_app/store/blob-backend.js');
    kvBackend = await import('../cloud-functions/_app/store/kv-backend.js');
    assert.equal(typeof blobBackend.makeBlobBackend, 'function');
    assert.equal(typeof kvBackend.makeKvBackend, 'function');
  });

  console.log('\n=== 2. 存储适配层 ===');
  await runR2Contract('Blob 后端', blobBackend.makeBlobBackend(fakeBlobStore()));
  await runR2Contract('KV 后端', kvBackend.makeKvBackend(fakeKvNamespace()));

  console.log('\n[Blob 后端] 一致性与错误可见性');
  await checkAsync('读操作默认带 consistency=strong（SDK 默认是 eventual，会让刚写完读不到）', async () => {
    const raw = fakeBlobStore();
    const store = blobBackend.makeBlobBackend(raw);
    await store.put('c/a', 'v');
    await store.get('c/a');
    await store.list({ prefix: 'c/' });
    assert.equal(store.__consistency, 'strong');
    assert.ok(raw.__calls.get.length >= 1, 'get 应被调用');
    assert.equal(raw.__calls.get[0].opts.consistency, 'strong', 'get 必须显式传 consistency');
    assert.equal(raw.__calls.list[0].consistency, 'strong', 'list 必须显式传 consistency');
  });

  await checkAsync('BLOB_CONSISTENCY=eventual 时可切回最终一致', async () => {
    const raw = fakeBlobStore();
    const store = blobBackend.makeBlobBackend(raw, { consistency: 'eventual' });
    await store.put('c/b', 'v');
    await store.get('c/b');
    assert.equal(store.__consistency, 'eventual');
    assert.equal(raw.__calls.get[0].opts.consistency, 'eventual');
  });

  await checkAsync('consistency 取值非法时按 strong 处理（不静默变成 eventual）', () => {
    assert.equal(blobBackend.normalizeConsistency('STRONG'), 'strong');
    assert.equal(blobBackend.normalizeConsistency(''), 'strong');
    assert.equal(blobBackend.normalizeConsistency(undefined), 'strong');
    assert.equal(blobBackend.normalizeConsistency('乱七八糟'), 'strong');
    assert.equal(blobBackend.normalizeConsistency('eventual'), 'eventual');
  });

  await checkAsync('底层报错不会被伪装成「读不到」——错误码被记录下来', async () => {
    const store = blobBackend.makeBlobBackend(throwingBlobStore('QUOTA_EXCEEDED'));
    blobBackend.clearBlobError();
    // 读失败仍返回 null（保持上层行为不变），但错误必须被记下
    assert.equal(await store.get('x'), null);
    const err = blobBackend.blobLastError();
    assert.ok(err, '应记录错误');
    assert.equal(err.code, 'QUOTA_EXCEEDED');
    assert.equal(err.op, 'get');
    assert.match(blobBackend.hintForCode('QUOTA_EXCEEDED'), /1GB/);
    blobBackend.clearBlobError();
    assert.equal(blobBackend.blobLastError(), null);
  });

  await checkAsync('写失败必须抛出（丢数据比报错严重），同时记录错误', async () => {
    const store = blobBackend.makeBlobBackend(throwingBlobStore('RATE_LIMITED'));
    blobBackend.clearBlobError();
    await assert.rejects(() => store.put('y', 'v'));
    assert.equal(blobBackend.blobLastError().op, 'put');
    assert.equal(blobBackend.blobLastError().code, 'RATE_LIMITED');
    blobBackend.clearBlobError();
  });

  console.log('\n[KV 后端] 专属行为');
  await checkAsync('key 编码可逆（含中文与斜杠）', () => {
    const raw = 'kb/docs/甲骨文云ARM.md';
    const enc = kvBackend.encKey(raw);
    assert.match(enc, /^[0-9a-f]+$/, '编码后应只含 [0-9a-f]');
    assert.equal(kvBackend.decKey(enc), raw);
  });
  await checkAsync('编码保持前缀性质（list prefix 才可用）', () => {
    const p = kvBackend.encKey('kb/docs/');
    const k = kvBackend.encKey('kb/docs/甲骨文.md');
    assert.ok(k.startsWith(p));
  });
  await checkAsync('超长 key 写入时抛出明确错误（而不是静默写坏数据）', async () => {
    const kv = kvBackend.makeKvBackend(fakeKvNamespace());
    await assert.rejects(() => kv.put('x'.repeat(300), 'v'), /超长/);
  });
  await checkAsync('超长 key 读取时安静返回 null（此类 key 不可能存在）', async () => {
    const kv = kvBackend.makeKvBackend(fakeKvNamespace());
    assert.equal(await kv.get('x'.repeat(300)), null);
  });

  console.log('\n=== 3. 路由与降级（STORAGE_BACKEND=none 走纯内存） ===');
  const baseEnv = { STORAGE_BACKEND: 'none' };
  const call = (path, init) => mod.handle({
    request: new Request('https://example.com' + path, init),
    env: baseEnv,
    waitUntil: () => {},
  });

  await checkAsync('GET /healthz 返回 200 且标明 storage=memory', async () => {
    const res = await call('/healthz');
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ok, true);
    assert.equal(j.runtime, 'edgeone');
    assert.equal(j.storage, 'memory');
  });

  await checkAsync('GET / 返回聊天页面（未配置模型时给出明确提示）', async () => {
    const res = await call('/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('Content-Type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /未配置模型/);
  });

  await checkAsync('GET /sw.js 返回 200 且已替换版本占位符', async () => {
    const res = await call('/sw.js');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Service-Worker-Allowed'), '/');
    const js = await res.text();
    assert.ok(!js.includes('{{PWA_VERSION}}'), '版本占位符应已被替换');
  });

  await checkAsync('GET /manifest.webmanifest 返回 200', async () => {
    const res = await call('/manifest.webmanifest');
    assert.equal(res.status, 200);
  });

  await checkAsync('GET /icon-192.png 返回 PNG', async () => {
    const res = await call('/icon-192.png');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'image/png');
  });

  await checkAsync('POST /api/chat 非法 JSON 返回 400', async () => {
    const res = await call('/api/chat', { method: 'POST', body: 'not-json' });
    assert.equal(res.status, 400);
  });

  await checkAsync('POST /api/chat 未配置模型返回 500 且提示检查环境变量', async () => {
    const res = await call('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 500);
    const j = await res.json();
    assert.match(j.error, /未配置任何可用模型/);
  });

  await checkAsync('未知路径返回 404', async () => {
    const res = await call('/definitely-not-a-route');
    assert.equal(res.status, 404);
  });

  console.log('\n=== 4. 环境变量解析（多通道模型列表） ===');
  await checkAsync('API_URL_1/API_KEY_1/MODEL_1 能解析出模型下拉框', async () => {
    const env = {
      STORAGE_BACKEND: 'none',
      API_URL_1: 'https://api.example.com/v1/chat/completions',
      API_KEY_1: 'sk-test',
      MODEL_1: 'gpt-4o:GPT-4o, qwen-plus:通义千问 Plus',
    };
    const res = await mod.handle({ request: new Request('https://example.com/'), env, waitUntil: () => {} });
    const html = await res.text();
    assert.match(html, /gpt-4o/);
    assert.match(html, /通义千问 Plus/);
  });

  console.log('\n=== 4b. 密钥池：多 key 轮换、失败换 key 重试、短期熔断 ===');
  const chan = await import('../cloud-functions/_app/channel.js');

  // 假 fetch：记录每次请求实际带上的 Authorization 头，便于断言「换了 key」
  function installFetchMock(handler) {
    const orig = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
      const h = (init && init.headers) || {};
      const auth = h.Authorization || h.authorization || '';
      calls.push({ url: String(url), auth: auth });
      return handler({ url: String(url), auth: auth, n: calls.length });
    };
    return { calls: calls, restore() { globalThis.fetch = orig; } };
  }

  function chatEnv(apiKey, extra) {
    return Object.assign({
      STORAGE_BACKEND: 'none',
      API_URL_1: 'https://api.example.com/v1/chat/completions',
      API_KEY_1: apiKey,
      MODEL_1: 'm1:模型一',
    }, extra || {});
  }

  function chatCfg(env) {
    return chan.buildAIRequest(env, 'm1', [{ role: 'user', content: 'hi' }], true);
  }

  await checkAsync('API_KEY_1 逗号分隔的多个 key 全部进入密钥池（去空格、丢空项）', () => {
    const env = chatEnv('sk-a, sk-b ,sk-c,,');
    const cfg = chatCfg(env);
    assert.deepEqual(cfg.keys, ['sk-a', 'sk-b', 'sk-c']);
    assert.equal(cfg.hasKey, true);
  });

  await checkAsync('authHeaders：未配置密钥时不带 Authorization 头（兼容免密钥网关）', () => {
    assert.equal(chan.authHeaders('').Authorization, undefined);
    assert.equal(chan.authHeaders('').Authorization, undefined);
    assert.equal(chan.authHeaders('sk-x').Authorization, 'Bearer sk-x');
  });

  await checkAsync('同一个模型写在两个通道、地址相同时合并密钥池（原来直接丢弃）', () => {
    const env = {
      STORAGE_BACKEND: 'none',
      API_URL_1: 'https://a.example/v1/chat/completions', API_KEY_1: 'sk-1',
      MODEL_1: 'gpt-4o:GPT-4o',
      API_URL_2: 'https://a.example/v1/chat/completions', API_KEY_2: 'sk-2, sk-3',
      MODEL_2: 'gpt-4o:GPT-4o',
    };
    const cfg = chan.buildAIRequest(env, 'gpt-4o', [{ role: 'user', content: 'hi' }], true);
    assert.deepEqual(cfg.keys, ['sk-1', 'sk-2', 'sk-3']);
  });

  await checkAsync('同一个模型但地址不同时不合并（保留第一个通道，避免串了接口）', () => {
    const env = {
      STORAGE_BACKEND: 'none',
      API_URL_1: 'https://a.example/v1/chat/completions', API_KEY_1: 'sk-1',
      MODEL_1: 'gpt-4o:GPT-4o',
      API_URL_2: 'https://b.example/v1/chat/completions', API_KEY_2: 'sk-2',
      MODEL_2: 'gpt-4o:GPT-4o',
    };
    const cfg = chan.buildAIRequest(env, 'gpt-4o', [{ role: 'user', content: 'hi' }], true);
    assert.deepEqual(cfg.keys, ['sk-1']);
    assert.equal(cfg.apiUrl, 'https://a.example/v1/chat/completions');
  });

  await checkAsync('API_CONFIG 的 keys 支持数组写法（key 里含逗号也能配）', () => {
    const env = {
      STORAGE_BACKEND: 'none',
      API_CONFIG: JSON.stringify([
        { url: 'https://a.example/v1/chat/completions', keys: ['sk,with,commas', 'sk-plain'], models: 'm1:模型一' },
      ]),
    };
    const cfg = chatCfg(env);
    assert.deepEqual(cfg.keys, ['sk,with,commas', 'sk-plain']);
  });

  await checkAsync('只配一个 key 时不会产生多余的重试请求', async () => {
    chan.__resetKeyHealth();
    const cfg = chatCfg(chatEnv('sk-solo'));
    const m = installFetchMock(() => new Response('nope', { status: 401 }));
    try {
      const r = await chan.fetchWithKeyRotation(cfg, (k) => ({ method: 'POST', headers: chan.authHeaders(k) }));
      assert.equal(r.attempts, 1);
      assert.equal(m.calls.length, 1);
    } finally { m.restore(); }
  });

  await checkAsync('撞上失效 key 时自动换一个并最终成功（多 key 的核心收益）', async () => {
    chan.__resetKeyHealth();
    const cfg = chatCfg(chatEnv('sk-bad-1, sk-good-1'));
    const m = installFetchMock(({ auth }) => auth.indexOf('sk-bad-1') !== -1
      ? new Response('invalid api key', { status: 401 })
      : new Response('{"ok":true}', { status: 200 }));
    try {
      for (let i = 0; i < 6; i++) {
        const r = await chan.fetchWithKeyRotation(cfg, (k) => ({ method: 'POST', headers: chan.authHeaders(k) }));
        assert.equal(r.resp.status, 200, '第 ' + (i + 1) + ' 次应最终成功');
        assert.equal(r.key, 'sk-good-1', '最终应落在可用的 key 上');
      }
    } finally { m.restore(); }
  });

  await checkAsync('429 限流同样会换 key 重试（多 key 就是为了分散单 key 配额）', async () => {
    chan.__resetKeyHealth();
    const cfg = chatCfg(chatEnv('sk-429-a, sk-429-b'));
    const m = installFetchMock(({ n }) => n === 1
      ? new Response('rate limited', { status: 429 })
      : new Response('{"ok":true}', { status: 200 }));
    try {
      const r = await chan.fetchWithKeyRotation(cfg, (k) => ({ method: 'POST', headers: chan.authHeaders(k) }));
      assert.equal(r.resp.status, 200);
      assert.equal(r.attempts, 2);
    } finally { m.restore(); }
  });

  await checkAsync('400 参数错误不换 key 重试（换 key 治不了参数问题）', async () => {
    chan.__resetKeyHealth();
    const cfg = chatCfg(chatEnv('sk-400-a, sk-400-b, sk-400-c'));
    const m = installFetchMock(() => new Response('bad request', { status: 400 }));
    try {
      const r = await chan.fetchWithKeyRotation(cfg, (k) => ({ method: 'POST', headers: chan.authHeaders(k) }));
      assert.equal(r.resp.status, 400);
      assert.equal(r.attempts, 1);
      assert.equal(m.calls.length, 1);
    } finally { m.restore(); }
  });

  await checkAsync('5xx 上游故障不换 key 重试（所有 key 会一起挂，重试只是浪费额度）', async () => {
    chan.__resetKeyHealth();
    const cfg = chatCfg(chatEnv('sk-500-a, sk-500-b, sk-500-c'));
    const m = installFetchMock(() => new Response('upstream boom', { status: 503 }));
    try {
      const r = await chan.fetchWithKeyRotation(cfg, (k) => ({ method: 'POST', headers: chan.authHeaders(k) }));
      assert.equal(r.attempts, 1);
    } finally { m.restore(); }
  });

  await checkAsync('网络层异常不换 key 重试（换 key 治不了网络问题，只会把一次超时变两次）', async () => {
    chan.__resetKeyHealth();
    const cfg = chatCfg(chatEnv('sk-net-a, sk-net-b, sk-net-c'));
    const m = installFetchMock(() => { throw new Error('ECONNRESET'); });
    let threw = false;
    try {
      await chan.fetchWithKeyRotation(cfg, (k) => ({ method: 'POST', headers: chan.authHeaders(k) }));
    } catch (e) { threw = true; }
    finally { m.restore(); }
    assert.equal(threw, true, '网络异常应原样抛出，交给调用方的超时/暂停逻辑');
    assert.equal(m.calls.length, 1, '不该换 key 重试');
  });

  await checkAsync('所有 key 都失败时把最后一次的错误交回调用方（不吞错、且每个 key 只试一次）', async () => {
    chan.__resetKeyHealth();
    const cfg = chatCfg(chatEnv('sk-all-a, sk-all-b'));
    const m = installFetchMock(() => new Response('nope', { status: 401 }));
    try {
      const r = await chan.fetchWithKeyRotation(cfg, (k) => ({ method: 'POST', headers: chan.authHeaders(k) }));
      assert.equal(r.resp.status, 401);
      assert.equal(r.attempts, 2);
      const used = m.calls.map(c => c.auth);
      assert.equal(new Set(used).size, 2, '两次尝试必须用不同的 key');
    } finally { m.restore(); }
  });

  await checkAsync('单次请求最多尝试 3 个 key（key 再多也不会无限重试）', async () => {
    chan.__resetKeyHealth();
    const cfg = chatCfg(chatEnv('sk-m1, sk-m2, sk-m3, sk-m4, sk-m5'));
    const m = installFetchMock(() => new Response('nope', { status: 401 }));
    try {
      const r = await chan.fetchWithKeyRotation(cfg, (k) => ({ method: 'POST', headers: chan.authHeaders(k) }));
      assert.equal(r.attempts, 3);
      assert.equal(m.calls.length, 3);
    } finally { m.restore(); }
  });

  await checkAsync('buildInit 每次尝试都被重新调用（超时按当次剩余预算重算，而非共用首次 deadline）', async () => {
    chan.__resetKeyHealth();
    const cfg = chatCfg(chatEnv('sk-b-init-a, sk-b-init-b, sk-b-init-c'));
    const m = installFetchMock(() => new Response('nope', { status: 401 }));
    let built = 0;
    try {
      await chan.fetchWithKeyRotation(cfg, (k) => {
        built++;
        return { method: 'POST', headers: chan.authHeaders(k), signal: AbortSignal.timeout(1000) };
      });
    } finally { m.restore(); }
    assert.equal(built, 3);
    assert.equal(built, m.calls.length);
  });

  await checkAsync('连续失败的 key 进入冷却期（熔断），排障输出可见', async () => {
    chan.__resetKeyHealth();
    const env = chatEnv('sk-cool-a');
    const cfg = chatCfg(env);
    const m = installFetchMock(() => new Response('nope', { status: 401 }));
    try {
      for (let i = 0; i < 2; i++) {
        await chan.fetchWithKeyRotation(cfg, (k) => ({ method: 'POST', headers: chan.authHeaders(k) }));
      }
    } finally { m.restore(); }
    const status = chan.keyPoolStatus(env);
    const h = status[0].health[0];
    assert.equal(h.failStreak, 2, '连续失败次数应被记录');
    assert.equal(h.lastStatus, 401);
    assert.ok(h.cooldownMs > 0, '应处于冷却期');
  });

  await checkAsync('冷却中的 key 不再被优先选中（有健康 key 时完全不碰它）', async () => {
    chan.__resetKeyHealth();
    const env = chatEnv('sk-hot-a, sk-hot-b');
    const cfg = chatCfg(env);
    const m = installFetchMock(({ auth }) => auth.indexOf('sk-hot-a') !== -1
      ? new Response('nope', { status: 401 })
      : new Response('{"ok":true}', { status: 200 }));
    try {
      for (let i = 0; i < 3; i++) {
        await chan.fetchWithKeyRotation({ url: cfg.apiUrl, keys: ['sk-hot-a'], keyRotate: true },
          (k) => ({ method: 'POST', headers: chan.authHeaders(k) }));
      }
      m.calls.length = 0;
      for (let i = 0; i < 10; i++) {
        await chan.fetchWithKeyRotation(cfg, (k) => ({ method: 'POST', headers: chan.authHeaders(k) }));
      }
      const used = m.calls.map(c => c.auth);
      assert.ok(used.length > 0);
      assert.ok(used.every(a => a.indexOf('sk-hot-b') !== -1),
        '冷却中的 key 不该再被选中，实际用了: ' + used.join(','));
    } finally { m.restore(); }
  });

  await checkAsync('API_KEY_ROTATE=0 时退回单次尝试（不换 key 重试的逃生口）', async () => {
    chan.__resetKeyHealth();
    const cfg = chatCfg(chatEnv('sk-r1, sk-r2', { API_KEY_ROTATE: '0' }));
    assert.equal(cfg.keyRotate, false);
    const m = installFetchMock(() => new Response('nope', { status: 401 }));
    try {
      const r = await chan.fetchWithKeyRotation(cfg, (k) => ({ method: 'POST', headers: chan.authHeaders(k) }));
      assert.equal(r.attempts, 1);
      assert.equal(m.calls.length, 1);
    } finally { m.restore(); }
  });

  await checkAsync('密钥池排障只输出掩码，绝不回显 key 原文', () => {
    chan.__resetKeyHealth();
    const env = chatEnv('sk-secret-abcdefgh');
    const json = JSON.stringify(chan.keyPoolStatus(env));
    assert.equal(json.indexOf('sk-secret-abcdefgh'), -1, '不得出现 key 原文');
    assert.ok(json.indexOf('***efgh') !== -1, '应给出掩码');
  });

  await checkAsync('STORAGE_DEBUG=1 时 /healthz 附带密钥池状态（掩码）', async () => {
    chan.__resetKeyHealth();
    const env = chatEnv('sk-hz-1234, sk-hz-5678', { STORAGE_DEBUG: '1' });
    const res = await mod.handle({ request: new Request('https://example.com/healthz'), env, waitUntil: () => {} });
    const j = await res.json();
    assert.ok(Array.isArray(j.debug.keyPool), 'debug.keyPool 应是数组');
    assert.equal(j.debug.keyPool[0].keys, 2);
    assert.equal(JSON.stringify(j.debug.keyPool).indexOf('sk-hz-1234'), -1);
  });

  await checkAsync('端到端：/api/chat 撞上失效 key 会自动换 key 并正常返回（含逗号后空格）', async () => {
    chan.__resetKeyHealth();
    const env = chatEnv('sk-dead-e2e, sk-live-e2e');
    const m = installFetchMock(({ auth }) => auth.indexOf('sk-dead-e2e') !== -1
      ? new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 401 })
      : new Response('data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n', { status: 200 }));
    try {
      const res = await mod.handle({
        request: new Request('https://example.com/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] }),
        }),
        env, waitUntil: () => {},
      });
      assert.equal(res.status, 200, '换 key 后应正常返回，而不是把 401 抛给用户');
      assert.match(await res.text(), /你好/);
      assert.ok(m.calls.length >= 1 && m.calls.length <= 2);
      assert.ok(m.calls[m.calls.length - 1].auth.indexOf('sk-live-e2e') !== -1);
    } finally { m.restore(); }
  });

  await checkAsync('端到端：未配置 API_KEY 时不发送 Authorization 头（兼容 Ollama 等免密钥网关）', async () => {
    const env = { STORAGE_BACKEND: 'none', API_URL_1: 'https://local.example/v1/chat/completions', MODEL_1: 'llama3:本地模型' };
    const m = installFetchMock(() => new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 }));
    try {
      const res = await mod.handle({
        request: new Request('https://example.com/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'llama3', messages: [{ role: 'user', content: 'hi' }] }),
        }),
        env, waitUntil: () => {},
      });
      assert.equal(res.status, 200);
      assert.equal(m.calls.length, 1);
      assert.equal(m.calls[0].auth, '', '未配置密钥时不该出现 Authorization 头');
    } finally { m.restore(); }
  });

  console.log('\n=== 5. 端到端：挂上存储后端后，知识库与长期记忆真的落盘并能读回 ===');
  // 这一段验证的是「原项目那 8 个直接调用 env.R2 的文件一行都没改，也能正常工作」
  const r2 = await import('../cloud-functions/_app/store/r2.js');
  const memory = await import('../cloud-functions/_app/agent/memory.js');
  const docTools = await import('../cloud-functions/_app/kb/doc-tools.js');

  for (const [label, makeStore] of [
    ['Blob 后端', () => blobBackend.makeBlobBackend(fakeBlobStore())],
    ['KV 后端', () => kvBackend.makeKvBackend(fakeKvNamespace())],
  ]) {
    const env = { R2: makeStore() };
    const chatId = 'web_e2e_' + (label === 'Blob 后端' ? 'blob' : 'kv');

    await checkAsync('[' + label + '] storePut / storeGet / storeDelete 往返', async () => {
      await r2.storePut(env, 'tg_user_1', 'gpt-4o');
      assert.equal(await r2.storeGet(env, 'tg_user_1'), 'gpt-4o');
      await r2.storeDelete(env, 'tg_user_1');
      assert.equal(await r2.storeGet(env, 'tg_user_1'), null);
    });

    await checkAsync('[' + label + '] 长期记忆写入 → 读回 → md 镜像存在', async () => {
      const msg = await memory.agentSaveMemory(env, chatId, '我养了一只猫叫汤圆');
      assert.match(msg, /已记住/);
      const arr = await memory.agentGetMemories(env, chatId);
      assert.equal(arr.length, 1);
      assert.equal(arr[0].fact, '我养了一只猫叫汤圆');
      const mirror = await r2.storeGet(env, 'kb/mem/' + chatId + '/' + arr[0].file);
      assert.ok(mirror, 'md 镜像应存在');
      assert.match(mirror, /我养了一只猫叫汤圆/);
    });

    await checkAsync('[' + label + '] 同主题改口自动覆盖旧记忆（"X是Y" 句式）', async () => {
      const cid = chatId + '_sub';
      assert.match(await memory.agentSaveMemory(env, cid, '我的手机号是13800000000'), /已记住/);
      assert.match(await memory.agentSaveMemory(env, cid, '我的手机号是13900000000'), /已自动更新记忆/);
      const arr = await memory.agentGetMemories(env, cid);
      assert.equal(arr.length, 1);
      assert.equal(arr[0].fact, '我的手机号是13900000000');
    });

    await checkAsync('[' + label + '] 知识库文档：中文标题保存 → 列表 → 精读 → 删除', async () => {
      const saveMsg = await docTools.toolSaveDoc(env, chatId, {
        title: '甲骨文云 ARM 实例',
        content: '正文：ARM 实例的免费额度与网络说明。'.repeat(20),
      });
      assert.match(saveMsg, /已保存为知识库文档/);

      const listMsg = await docTools.toolListDocs(env);
      assert.match(listMsg, /甲骨文云 ARM 实例/);

      const readMsg = await docTools.toolReadDoc(env, { query: '甲骨文云 ARM 实例' });
      assert.match(readMsg, /ARM 实例的免费额度/);

      const delMsg = await docTools.toolDeleteDoc(env, { query: '甲骨文云 ARM 实例' });
      assert.match(delMsg, /已删除知识库文档/);
      assert.match(await docTools.toolListDocs(env), /知识库文档为空/);
    });

    await checkAsync('[' + label + '] 知识库正文分词检索能命中（多关键词相关性排序）', async () => {
      await docTools.toolSaveDoc(env, chatId, {
        title: '网络配置笔记',
        content: '这一段讲的是边缘节点的回源超时配置与重试策略，和前面的内容无关。',
      });
      const hit = await docTools.toolReadDoc(env, { query: '回源超时' });
      assert.match(hit, /命中/, '标题未命中时应回落到正文检索并给出命中片段');
    });
  }

  console.log('\n=== 6. KV 绑定自动发现（"自动绑定"能自动到哪一步） ===');
  const edgeStore = await import('../cloud-functions/_app/store/edge-store.js');

  await checkAsync('识别规则：KV（有 put）为真，Blob Store（用 set）为假', () => {
    assert.equal(edgeStore.looksLikeKvNamespace(fakeKvNamespace()), true);
    assert.equal(edgeStore.looksLikeKvNamespace(fakeBlobStore()), false);
    assert.equal(edgeStore.looksLikeKvNamespace(null), false);
  });

  await checkAsync('任意变量名绑定的 KV 都能被自动发现（无需 EO_KV_BINDING）', () => {
    globalThis.MY_WEIRD_NAME_KV = fakeKvNamespace();
    try {
      const found = edgeStore.detectKvBinding({}, {});
      assert.ok(found, '应发现 KV 绑定');
      assert.equal(found.name, 'globalThis.MY_WEIRD_NAME_KV');
    } finally {
      delete globalThis.MY_WEIRD_NAME_KV;
    }
  });

  await checkAsync('EO_KV_BINDING 显式指定时优先命中该名字', () => {
    globalThis.KV_ALPHA = fakeKvNamespace();
    globalThis.KV_BETA = fakeKvNamespace();
    try {
      const found = edgeStore.detectKvBinding({}, { EO_KV_BINDING: 'KV_BETA' });
      assert.equal(found.name, 'globalThis.KV_BETA');
    } finally {
      delete globalThis.KV_ALPHA;
      delete globalThis.KV_BETA;
    }
  });

  await checkAsync('常见默认名 CHAT_KV 无需配置即可命中', () => {
    globalThis.CHAT_KV = fakeKvNamespace();
    try {
      const found = edgeStore.detectKvBinding({}, {});
      assert.equal(found.name, 'globalThis.CHAT_KV');
    } finally {
      delete globalThis.CHAT_KV;
    }
  });

  await checkAsync('env.R2（本层挂载的替身）不会被误判成 KV 绑定', () => {
    const env = { R2: blobBackend.makeBlobBackend(fakeBlobStore()) };
    assert.equal(edgeStore.detectKvBinding({}, env), null);
    assert.deepEqual(edgeStore.listKvCandidates({}, env), []);
  });

  await checkAsync('端到端：globalThis 上任意名字的 KV 被自动接管为 env.R2', async () => {
    globalThis.SOME_RANDOM_KV_NAME = fakeKvNamespace();
    edgeStore.__resetForTest();
    try {
      const res = await mod.handle({
        request: new Request('https://example.com/healthz'),
        env: { STORAGE_BACKEND: 'kv' },
        waitUntil: () => {},
      });
      const j = await res.json();
      assert.equal(j.storage, 'kv(globalThis.SOME_RANDOM_KV_NAME)');
    } finally {
      delete globalThis.SOME_RANDOM_KV_NAME;
      edgeStore.__resetForTest();
    }
  });

  await checkAsync('端到端：auto 模式下没有后端时退化为 memory（不抛错）', async () => {
    edgeStore.__resetForTest();
    try {
      const res = await mod.handle({
        request: new Request('https://example.com/healthz'),
        env: { STORAGE_BACKEND: 'auto' },
        waitUntil: () => {},
      });
      const j = await res.json();
      assert.equal(j.storage, 'memory');
    } finally {
      edgeStore.__resetForTest();
    }
  });

  console.log('\n=== 6b. Blob 默认后端（"使用 Blob 存储"） ===');

  await checkAsync('识别规则：Blob Store（用 set，无 put）为真，KV 为假', () => {
    assert.equal(edgeStore.looksLikeBlobStore(fakeBlobStore()), true);
    assert.equal(edgeStore.looksLikeBlobStore(fakeKvNamespace()), false);
    assert.equal(edgeStore.looksLikeBlobStore(null), false);
    // 本层自己挂载的 env.R2 替身同样带 list/delete，但它有 put，不能被当成 Blob Store
    assert.equal(edgeStore.looksLikeBlobStore(blobBackend.makeBlobBackend(fakeBlobStore())), false);
  });

  await checkAsync('未设置 STORAGE_BACKEND 时默认走 Blob，绝不静默降级到 KV', async () => {
    // 故意在 globalThis 上放一个可用的 KV：旧行为（auto）会用它兜底，
    // 新行为必须无视它 —— Blob 不可用就如实报 memory，而不是偷偷换后端。
    globalThis.CHAT_KV = fakeKvNamespace();
    edgeStore.__resetForTest();
    try {
      const res = await mod.handle({
        request: new Request('https://example.com/healthz'),
        env: {},
        waitUntil: () => {},
      });
      const j = await res.json();
      assert.equal(j.storage, 'memory', '默认后端是 Blob；Blob 不可用时应暴露为 memory');
    } finally {
      delete globalThis.CHAT_KV;
      edgeStore.__resetForTest();
    }
  });

  await checkAsync('Blob 不做绑定名全量扫描（控制台只读，没有绑定机制）', () => {
    // 即便 globalThis 上真有个长得像 Blob Store 的对象，也不该被认成「绑定」
    globalThis.MY_WEIRD_BLOB = fakeBlobStore();
    try {
      assert.equal(edgeStore.detectBlobBinding({}, {}), null, '未显式指定时不应发现任何绑定');
    } finally {
      delete globalThis.MY_WEIRD_BLOB;
    }
  });

  await checkAsync('EO_BLOB_BINDING 逃生口：显式指定时才注入自建 Store', () => {
    globalThis.BLOB_ALPHA = fakeBlobStore();
    globalThis.BLOB_BETA = fakeBlobStore();
    try {
      const found = edgeStore.detectBlobBinding({}, { EO_BLOB_BINDING: 'BLOB_BETA' });
      assert.ok(found, '显式指定应命中');
      assert.equal(found.name, 'globalThis.BLOB_BETA');
      // 形态不符（KV 没有 set）时不能误认
      globalThis.BLOB_ALPHA = fakeKvNamespace();
      assert.equal(edgeStore.detectBlobBinding({}, { EO_BLOB_BINDING: 'BLOB_ALPHA' }), null);
    } finally {
      delete globalThis.BLOB_ALPHA;
      delete globalThis.BLOB_BETA;
    }
  });

  await checkAsync('端到端：注入的 Blob Store 被接管为 env.R2，且真的能写能读', async () => {
    const bound = fakeBlobStore();
    edgeStore.__resetForTest();
    try {
      const res = await mod.handle({
        // ?probe=1 会真实写入并读回一个临时对象 —— 这一步才证明存储「能用」而不只是「能加载」
        request: new Request('https://example.com/healthz?probe=1'),
        env: { EO_BLOB_BINDING: 'BLOB', BLOB: bound, STORAGE_DEBUG: '1' },
        waitUntil: () => {},
      });
      const j = await res.json();
      assert.equal(j.storage, 'blob(env.BLOB)');
      assert.equal(j.debug.blobBindingUsed, 'env.BLOB');
      assert.equal(j.debug.probe.ok, true, '真实读写应成功');
    } finally {
      edgeStore.__resetForTest();
    }
  });

  console.log('\n=== 6c. Blob 命名空间自动创建（provision） ===');

  await checkAsync('首个请求会异步创建命名空间：写入并读回 __meta__/provision.json', async () => {
    const raw = fakeBlobStore();
    edgeStore.__resetForTest();
    try {
      const res = await mod.handle({
        request: new Request('https://example.com/healthz'),
        env: { EO_BLOB_BINDING: 'BLOB', BLOB: raw },
        waitUntil: () => {},
      });
      const j = await res.json();
      assert.equal(j.storage, 'blob(env.BLOB)');
      // 置备是异步的（交给 waitUntil），这里等它落定
      await edgeStore.__awaitProvision();
      const written = await raw.get(edgeStore.PROVISION_KEY);
      assert.ok(written, '应写入置备标记对象');
      const meta = JSON.parse(written);
      assert.equal(meta.namespace, 'edgeone-chat');
      assert.ok(meta.provisioned_at, '应带创建时间');
    } finally {
      edgeStore.__resetForTest();
    }
  });

  await checkAsync('置备结果在 /healthz 的 debug.provision 里可见', async () => {
    const raw = fakeBlobStore();
    edgeStore.__resetForTest();
    try {
      const res = await mod.handle({
        request: new Request('https://example.com/healthz'),
        env: { EO_BLOB_BINDING: 'BLOB', BLOB: raw, STORAGE_DEBUG: '1' },
        waitUntil: () => {},
      });
      const j = await res.json();
      assert.ok(j.debug.provision, '应输出置备状态');
      assert.equal(j.debug.provision.namespace, 'edgeone-chat');
      await edgeStore.__awaitProvision();
      // 再请求一次，此时应已就绪
      const res2 = await mod.handle({
        request: new Request('https://example.com/healthz'),
        env: { EO_BLOB_BINDING: 'BLOB', BLOB: raw, STORAGE_DEBUG: '1' },
        waitUntil: () => {},
      });
      const j2 = await res2.json();
      assert.equal(j2.debug.provision.state, 'ready');
      assert.equal(j2.debug.provision.ok, true);
    } finally {
      edgeStore.__resetForTest();
    }
  });

  await checkAsync('BLOB_AUTOPROVISION=0 时不产生任何写入', async () => {
    const raw = fakeBlobStore();
    edgeStore.__resetForTest();
    try {
      await mod.handle({
        request: new Request('https://example.com/healthz'),
        env: { EO_BLOB_BINDING: 'BLOB', BLOB: raw, BLOB_AUTOPROVISION: '0', STORAGE_DEBUG: '1' },
        waitUntil: () => {},
      });
      await edgeStore.__awaitProvision();
      assert.equal(await raw.get(edgeStore.PROVISION_KEY), null, '不应写入置备标记');
    } finally {
      edgeStore.__resetForTest();
    }
  });

  await checkAsync('置备失败时被如实记录（不假装成功）', async () => {
    edgeStore.__resetForTest();
    try {
      await mod.handle({
        request: new Request('https://example.com/healthz'),
        env: { EO_BLOB_BINDING: 'BLOB', BLOB: throwingBlobStore('QUOTA_EXCEEDED'), STORAGE_DEBUG: '1' },
        waitUntil: () => {},
      });
      await edgeStore.__awaitProvision();
      const res = await mod.handle({
        request: new Request('https://example.com/healthz'),
        env: { EO_BLOB_BINDING: 'BLOB', BLOB: throwingBlobStore('QUOTA_EXCEEDED'), STORAGE_DEBUG: '1' },
        waitUntil: () => {},
      });
      const j = await res.json();
      assert.equal(j.debug.provision.state, 'failed');
      assert.equal(j.debug.provision.ok, false);
      assert.match(j.debug.provision.error, /1GB/);
    } finally {
      edgeStore.__resetForTest();
    }
  });

  console.log('\n=== 7. /healthz 排障输出 ===');
  await checkAsync('STORAGE_DEBUG=1 时输出后端探测详情', async () => {
    const res = await mod.handle({
      request: new Request('https://example.com/healthz'),
      env: { STORAGE_BACKEND: 'none', STORAGE_DEBUG: '1' },
      waitUntil: () => {},
    });
    const j = await res.json();
    assert.ok(j.debug, '应包含 debug 字段');
    assert.equal(j.debug.backend, 'memory');
    assert.ok(Array.isArray(j.debug.kvCandidates));
    assert.ok(j.debug.hint.length > 0, '未接通时应给出提示');
  });

  await checkAsync('默认不输出排障详情（不对外暴露内部绑定名）', async () => {
    const res = await call('/healthz');
    const j = await res.json();
    assert.equal(j.debug, undefined);
  });

  await checkAsync('排障输出回显后端模式与命名空间（默认 blob）', async () => {
    edgeStore.__resetForTest();
    try {
      const res = await mod.handle({
        request: new Request('https://example.com/healthz'),
        env: { STORAGE_DEBUG: '1' },
        waitUntil: () => {},
      });
      const j = await res.json();
      assert.equal(j.debug.mode, 'blob', '未设置 STORAGE_BACKEND 时应回显默认值 blob');
      assert.equal(j.debug.namespace, 'edgeone-chat');
      assert.equal(j.debug.consistency, 'strong', '读取一致性默认应为 strong');
      assert.equal(j.debug.blobBindingUsed, null);
      assert.ok(j.debug.provision, '应输出置备状态');
      assert.ok(Array.isArray(j.debug.kvCandidates));
      assert.equal(j.debug.warning, undefined, '合法取值不应有 warning');
    } finally {
      edgeStore.__resetForTest();
    }
  });

  await checkAsync('BLOB_CONSISTENCY=eventual 时排障输出如实反映', async () => {
    edgeStore.__resetForTest();
    try {
      const res = await mod.handle({
        request: new Request('https://example.com/healthz'),
        env: { STORAGE_DEBUG: '1', BLOB_CONSISTENCY: 'eventual' },
        waitUntil: () => {},
      });
      const j = await res.json();
      assert.equal(j.debug.consistency, 'eventual');
    } finally {
      edgeStore.__resetForTest();
    }
  });

  await checkAsync('真实 SDK 接入路径：本地无 Makers 凭证时优雅降级并说明缺什么', async () => {
    // 装了依赖就用真 SDK 走一遍（能验证 import 与 getStore 的真实行为）；
    // 没装依赖则验证「依赖缺失」这条路径的提示是否清晰。两种情况都必须降级为 memory 而不是崩掉。
    let sdkAvailable = true;
    try { await import('@edgeone/pages-blob'); } catch (e) { sdkAvailable = false; }
    edgeStore.__resetForTest();
    try {
      const res = await mod.handle({
        request: new Request('https://example.com/healthz'),
        env: { STORAGE_DEBUG: '1' },
        waitUntil: () => {},
      });
      const j = await res.json();
      assert.equal(j.storage, 'memory', '无凭证时必须降级为 memory');
      if (sdkAvailable) {
        assert.match(j.debug.blobError, /getStore 调用失败/, '应指出是 getStore 阶段失败');
        assert.match(j.debug.blobError, /Makers/, '应给出「不在 Makers 环境」的可操作提示');
      } else {
        assert.match(j.debug.blobError, /import 失败/, '应指出是依赖未安装');
      }
    } finally {
      edgeStore.__resetForTest();
    }
  });

  await checkAsync('存储读写错误会在排障输出里摊开（不再伪装成「知识库是空的」）', async () => {
    edgeStore.__resetForTest();
    blobBackend.clearBlobError();
    const throwingEnv = {
      EO_BLOB_BINDING: 'BLOB',
      BLOB: throwingBlobStore('QUOTA_EXCEEDED'),
      STORAGE_DEBUG: '1',
    };
    try {
      // 首个请求会触发自动置备，置备写入失败 → 错误被记录
      await mod.handle({
        request: new Request('https://example.com/healthz'),
        env: throwingEnv,
        waitUntil: () => {},
      });
      await edgeStore.__awaitProvision();
      const res = await mod.handle({
        request: new Request('https://example.com/healthz'),
        env: throwingEnv,
        waitUntil: () => {},
      });
      const j = await res.json();
      assert.ok(j.debug.lastStorageError, '应暴露最近一次存储错误');
      assert.equal(j.debug.lastStorageError.code, 'QUOTA_EXCEEDED');
      assert.equal(j.debug.lastStorageError.op, 'provision');
      assert.match(j.debug.lastStorageError.hint, /1GB/);
    } finally {
      blobBackend.clearBlobError();
      edgeStore.__resetForTest();
    }
  });

  await checkAsync('STORAGE_BACKEND 拼错时按 blob 处理并明确给出 warning', async () => {
    edgeStore.__resetForTest();
    try {
      const res = await mod.handle({
        request: new Request('https://example.com/healthz'),
        env: { STORAGE_BACKEND: 'bolb', STORAGE_DEBUG: '1' },
        waitUntil: () => {},
      });
      const j = await res.json();
      assert.equal(j.debug.mode, 'bolb', '应原样回显，方便发现拼写错误');
      assert.match(j.debug.warning, /无法识别/);
    } finally {
      edgeStore.__resetForTest();
    }
  });

  await checkAsync('?probe=1 在存储未接通时明确报 ok:false 并给出原因', async () => {
    edgeStore.__resetForTest();
    try {
      const res = await mod.handle({
        request: new Request('https://example.com/healthz?probe=1'),
        env: { STORAGE_DEBUG: '1' },
        waitUntil: () => {},
      });
      const j = await res.json();
      assert.equal(j.debug.probe.ok, false);
      assert.match(j.debug.probe.reason, /未接通/);
    } finally {
      edgeStore.__resetForTest();
    }
  });

  await checkAsync('不加 ?probe=1 时不会做真实读写（避免每次探针都产生写操作）', async () => {
    const bound = fakeBlobStore();
    edgeStore.__resetForTest();
    try {
      const res = await mod.handle({
        request: new Request('https://example.com/healthz'),
        env: { EO_BLOB_BINDING: 'BLOB', BLOB: bound, STORAGE_DEBUG: '1', BLOB_AUTOPROVISION: '0' },
        waitUntil: () => {},
      });
      const j = await res.json();
      assert.equal(j.storage, 'blob(env.BLOB)', '存储应已接通');
      assert.equal(j.debug.probe, undefined, '未加 ?probe=1 时不应做探测写入');
    } finally {
      edgeStore.__resetForTest();
    }
  });

  console.log('\n=== 8. 生图链路（SenseNova 日日新等图像接口） ===');
  const images = await import('../cloud-functions/_app/images.js');
  const channelMod = await import('../cloud-functions/_app/channel.js');
  const IMG_BASE = '/api/img/';

  async function sseTextOf(res) {
    const txt = await res.text();
    const m = txt.match(/^data: (.*)$/m);
    assert.ok(m, 'SSE 里应有 data: 行');
    return JSON.parse(m[1]).choices[0].delta.content;
  }

  await checkAsync('SenseNova 图像地址被判为图像接口，且默认显式要 url', () => {
    const env = {
      API_URL_1: 'https://token.sensenova.cn/v1/images/generations',
      API_KEY_1: 'sk-test',
      MODEL_1: 'sensenova-u1.5-fast:日日新 U1.5 Fast',
    };
    const cfg = channelMod.buildAIRequest(env, 'sensenova-u1.5-fast',
      [{ role: 'user', content: '一只白色海豹宝宝' }], false);
    assert.equal(cfg.isImageAPI, true);
    assert.equal(cfg.payload.response_format, 'url', '必须显式要 url —— 上游默认 b64_json 就是丢图的根因');
    assert.equal(cfg.payload.prompt, '一只白色海豹宝宝');
    assert.equal(cfg.payload.n, 1);
    assert.equal(cfg.payload.size, undefined, '未配置的可选参数不应发送');
    assert.equal(cfg.payload.watermark, undefined);
  });

  await checkAsync('图像接口可选参数按环境变量透传', () => {
    const env = {
      API_URL_1: 'https://token.sensenova.cn/v1/images/generations',
      API_KEY_1: 'sk-test',
      MODEL_1: 'sensenova-u1.5-fast:日日新',
      IMAGE_SIZE: '2048x2048',
      IMAGE_OUTPUT_FORMAT: 'webp',
      IMAGE_WATERMARK: 'false',
      IMAGE_PROMPT_EXTEND: '0',
      IMAGE_RESPONSE_FORMAT: 'b64_json',
    };
    const cfg = channelMod.buildAIRequest(env, 'sensenova-u1.5-fast', [{ role: 'user', content: 'x' }], false);
    assert.equal(cfg.payload.size, '2048x2048');
    assert.equal(cfg.payload.output_format, 'webp');
    assert.equal(cfg.payload.watermark, false);
    assert.equal(cfg.payload.prompt_extend, false);
    assert.equal(cfg.payload.response_format, 'b64_json');
  });

  await checkAsync('普通 chat 通道不会被误判为图像接口', () => {
    const env = {
      API_URL_1: 'https://api.deepseek.com/v1/chat/completions',
      API_KEY_1: 'sk-test',
      MODEL_1: 'deepseek-chat:DeepSeek Chat',
    };
    const cfg = channelMod.buildAIRequest(env, 'deepseek-chat', [{ role: 'user', content: 'hi' }], true);
    assert.equal(cfg.isImageAPI, false);
    assert.equal(cfg.payload.prompt, undefined);
    assert.equal(cfg.payload.response_format, undefined);
  });

  await checkAsync('base64 编解码往返（含非 ASCII 字节）', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 200, 255, 89, 137, 80, 78, 71]);
    assert.deepEqual(Array.from(images.base64ToBytes(images.bytesToBase64(bytes))), Array.from(bytes));
    assert.equal(images.bytesToBase64(new Uint8Array([0])), 'AA==');
    assert.equal(images.bytesToBase64(new Uint8Array([255, 255, 255])), '////');
    assert.equal(images.base64ToBytes('').length, 0);
  });

  const imgEnv = { R2: blobBackend.makeBlobBackend(fakeBlobStore()) };

  await checkAsync('base64 图片转存后可读回（字节与 content-type 都正确）', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const path = await images.persistBase64Image(imgEnv, images.bytesToBase64(bytes), 'image/png');
    assert.ok(path && path.indexOf(IMG_BASE) === 0, '应返回 /api/img/<id>');
    const got = await images.loadStoredImage(imgEnv, path.slice(IMG_BASE.length));
    assert.ok(got, '应能读回');
    assert.equal(got.contentType, 'image/png');
    assert.deepEqual(Array.from(got.bytes), Array.from(bytes));
  });

  await checkAsync('未绑定存储时转存返回 null（调用方回退，不抛错）', async () => {
    assert.equal(await images.persistBase64Image({}, 'AAAA', 'image/png'), null);
    assert.equal(await images.persistRemoteImage({}, 'https://cdn.example.com/a.png', 1000), null);
  });

  await checkAsync('图片 id 路径穿越与非法形态被拒绝', async () => {
    assert.equal(await images.loadStoredImage(imgEnv, '../../etc/passwd'), null);
    assert.equal(await images.loadStoredImage(imgEnv, 'a.png'), null);
    assert.equal(await images.loadStoredImage(imgEnv, 'aa-11.png/../../x'), null);
  });

  await checkAsync('上游 URL 图片会被下载转存', async () => {
    const realFetch = globalThis.fetch;
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9, 9]);
    globalThis.fetch = async () => new Response(png, { headers: { 'content-type': 'image/png' } });
    try {
      const path = await images.persistRemoteImage(imgEnv, 'https://cdn.example.com/a.png', 5000);
      assert.ok(path && path.indexOf(IMG_BASE) === 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await checkAsync('非图片内容类型拒收（避免把错误页当图片存下来）', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('<html>err</html>', { headers: { 'content-type': 'text/html' } });
    try {
      assert.equal(await images.persistRemoteImage(imgEnv, 'https://cdn.example.com/err.html', 5000), null);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await checkAsync('内网 / 云元数据图片地址被 SSRF 拦截且不发起请求', async () => {
    const realFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => { called = true; return new Response('x'); };
    try {
      assert.equal(await images.persistRemoteImage(imgEnv, 'http://127.0.0.1/a.png', 5000), null);
      assert.equal(await images.persistRemoteImage(imgEnv, 'http://169.254.169.254/latest/meta-data/', 5000), null);
      assert.equal(await images.persistRemoteImage(imgEnv, 'file:///etc/passwd', 5000), null);
      assert.equal(called, false, '被拦截的地址不应真的发起请求');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await checkAsync('b64_json 响应能解析成图片（原实现正是在这里丢图）', async () => {
    const b64 = images.bytesToBase64(new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]));
    const upstream = new Response(JSON.stringify({ created: 1, data: [{ b64_json: b64 }] }),
      { headers: { 'content-type': 'application/json' } });
    const content = await sseTextOf(await images.buildImageSseResponse(imgEnv, upstream));
    assert.match(content, /!\[生成结果\]\(\/api\/img\//, '应转存并给出 /api/img 链接');
  });

  await checkAsync('url 响应会被下载转存成自有长期链接', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(new Uint8Array([137, 80, 78, 71, 5, 6]),
      { headers: { 'content-type': 'image/png' } });
    try {
      const upstream = new Response(JSON.stringify({ data: [{ url: 'https://cdn.sensenova.dev/gen/x.png' }] }),
        { headers: { 'content-type': 'application/json' } });
      const content = await sseTextOf(await images.buildImageSseResponse(imgEnv, upstream));
      assert.match(content, /\(\/api\/img\//);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await checkAsync('IMAGE_PERSIST=0 时保留上游链接并明确提示 24 小时失效', async () => {
    const env = { R2: imgEnv.R2, IMAGE_PERSIST: '0' };
    const upstream = new Response(JSON.stringify({ data: [{ url: 'https://cdn.sensenova.dev/gen/y.png' }] }),
      { headers: { 'content-type': 'application/json' } });
    const content = await sseTextOf(await images.buildImageSseResponse(env, upstream));
    assert.match(content, /https:\/\/cdn\.sensenova\.dev\/gen\/y\.png/);
    assert.match(content, /24 小时/);
  });

  await checkAsync('多张图片逐个转存并带序号', async () => {
    const b64a = images.bytesToBase64(new Uint8Array([1, 2, 3]));
    const b64b = images.bytesToBase64(new Uint8Array([4, 5, 6]));
    const upstream = new Response(JSON.stringify({ data: [{ b64_json: b64a }, { b64_json: b64b }] }),
      { headers: { 'content-type': 'application/json' } });
    const content = await sseTextOf(await images.buildImageSseResponse(imgEnv, upstream));
    assert.match(content, /生成结果 1/);
    assert.match(content, /生成结果 2/);
  });

  await checkAsync('图像接口报错时把上游原因透传给用户', async () => {
    const upstream = new Response(JSON.stringify({ error: { message: 'quota exceeded' } }),
      { headers: { 'content-type': 'application/json' } });
    assert.match(await sseTextOf(await images.buildImageSseResponse(imgEnv, upstream)), /quota exceeded/);
  });

  await checkAsync('返回里既无 url 也无 b64_json 时给出原始响应片段', async () => {
    const upstream = new Response(JSON.stringify({ data: [{ revised_prompt: 'x' }] }),
      { headers: { 'content-type': 'application/json' } });
    assert.match(await sseTextOf(await images.buildImageSseResponse(imgEnv, upstream)), /未返回任何图片/);
  });

  await checkAsync('上游返回非 JSON 时给出可读错误而不是崩掉', async () => {
    const upstream = new Response('<html>502 Bad Gateway</html>', { headers: { 'content-type': 'text/html' } });
    assert.match(await sseTextOf(await images.buildImageSseResponse(imgEnv, upstream)), /不是合法 JSON/);
  });

  await checkAsync('端到端：GET /api/img/<id> 经完整路由取回图片字节', async () => {
    globalThis.E2E_IMG_KV = fakeKvNamespace();
    edgeStore.__resetForTest();
    try {
      const backend = kvBackend.makeKvBackend(globalThis.E2E_IMG_KV);
      const bytes = new Uint8Array([137, 80, 78, 71, 99, 100, 101]);
      const path = await images.persistBase64Image({ R2: backend }, images.bytesToBase64(bytes), 'image/png');
      assert.ok(path, '应先转存成功');
      const res = await mod.handle({
        request: new Request('https://example.com' + path),
        env: { STORAGE_BACKEND: 'kv' },
        waitUntil: () => {},
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('Content-Type'), 'image/png');
      assert.match(res.headers.get('Cache-Control'), /immutable/);
      assert.deepEqual(Array.from(new Uint8Array(await res.arrayBuffer())), Array.from(bytes));
    } finally {
      delete globalThis.E2E_IMG_KV;
      edgeStore.__resetForTest();
    }
  });

  await checkAsync('GET /api/img/<不存在的 id> 返回 404', async () => {
    edgeStore.__resetForTest();
    try {
      const res = await mod.handle({
        request: new Request('https://example.com/api/img/abcdefgh-12345678.png'),
        env: { STORAGE_BACKEND: 'none' },
        waitUntil: () => {},
      });
      assert.equal(res.status, 404);
    } finally {
      edgeStore.__resetForTest();
    }
  });

  console.log('\n=== 9. 生成页面本身的合法性 ===');
  // ui/*.js 导出的都是模板字符串，改动很容易因为两层转义把页面脚本写坏，
  // 而那种错误在服务端完全看不出来（只有浏览器打开才炸）。这里把内联脚本抽出来单独 parse。
  const uiMod = await import('../cloud-functions/_app/ui/index.js');
  const pageHtml = uiMod.HTML_CONTENT;

  await checkAsync('页面 HTML 能生成且包含模型下拉框占位符', () => {
    assert.ok(pageHtml.length > 50000, 'HTML 长度异常');
    assert.match(pageHtml, /\{\{MODEL_OPTIONS\}\}/);
  });

  await checkAsync('页面内联脚本块全部语法合法（两层转义没写坏）', () => {
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
    let m;
    let n = 0;
    while ((m = re.exec(pageHtml)) !== null) {
      const code = m[1];
      if (!code.trim()) continue;
      n++;
      // new Function 只做解析不执行，足以抓出语法/转义错误
      // eslint-disable-next-line no-new-func
      new Function(code);
    }
    assert.ok(n > 0, '应至少有一个内联脚本块');
  });

  await checkAsync('生图相关的前端改动都已生效', () => {
    assert.match(pageHtml, /renderer\.image\s*=\s*function/, '缺少图片渲染器');
    assert.match(pageHtml, /\.md-img-link/, '缺少图片链接样式');
    assert.match(pageHtml, /内联图片过大，已省略/, '缺少 localStorage 配额兜底');
  });

  console.log('\n=== 10. 品牌名改名（cloudflare-chat → edgeone-chat） ===');

  await checkAsync('页面标题、品牌名、PWA meta 都已是 EdgeOne-Chat', () => {
    assert.match(pageHtml, /<title>EdgeOne-Chat<\/title>/, '页面标题未改');
    assert.match(pageHtml, /<span class="brand-name">EdgeOne-Chat<\/span>/, '侧边栏品牌名未改');
    assert.match(pageHtml, /name="apple-mobile-web-app-title" content="EdgeOne-Chat"/);
    assert.match(pageHtml, /name="application-name" content="EdgeOne-Chat"/);
    assert.equal(/Cloudflare-Chat/.test(pageHtml), false, '页面里不应再有旧品牌名');
  });

  await checkAsync('PWA manifest 已改名', async () => {
    const m = await import('../cloud-functions/_app/pwa/manifest.js');
    const j = JSON.parse(m.MANIFEST_JSON);
    assert.equal(j.name, 'EdgeOne-Chat');
    assert.equal(j.short_name, 'EO-Chat');
    assert.equal(/Cloudflare/.test(j.description), false, '描述里不应再提 Cloudflare Workers');
  });

  await checkAsync('Service Worker 用新缓存名，且只清理自己的缓存', async () => {
    const sw = await import('../cloud-functions/_app/pwa/service-worker.js');
    assert.match(sw.SW_JS, /const CACHE = 'edgeone-chat-' \+ VERSION;/);
    assert.match(sw.SW_JS, /k\.indexOf\('edgeone-chat-'\) === 0/, 'activate 里应按新前缀清理');
    assert.match(sw.SW_JS, /<title>离线中 - EdgeOne-Chat<\/title>/);
    // 已按要求移除旧前缀兼容（LEGACY_CACHE_PREFIX）。若日后要重新支持旧名，记得
    // 同时改这里的断言和 activate 的匹配条件 —— 只改一处会静默失效。
    assert.equal(/cloudflare/i.test(sw.SW_JS), false, 'SW 源码里不应再有旧名');
  });

  await checkAsync('Agent 系统提示、对外 User-Agent、Telegram 日志前缀已改名', () => {
    // 静态检查源码文本：这几个字符串在运行时很难被观测到（要真去抓网页/发 TG 消息），
    // 但一旦漏改就会把旧品牌名暴露给第三方站点或日志。
    const files = [
      'cloud-functions/_app/agent/prompt.js',
      'cloud-functions/_app/agent/tools-local.js',
      'cloud-functions/_app/agent/tools-web.js',
      'cloud-functions/_app/telegram/handler.js',
      'cloud-functions/_app/telegram/diag.js',
      'cloud-functions/_app/telegram/setup.js',
      'cloud-functions/_app/ui/head.js',
      'cloud-functions/_app/ui/body.js',
      'cloud-functions/_app/ui/app-state.js',
      'cloud-functions/_app/pwa/manifest.js',
      'cloud-functions/_app/pwa/service-worker.js',
      'cloud-functions/_app/store/edge-store.js',
      'scripts/bootstrap-blob.mjs',
      'package.json',
      'edgeone.json',
    ];
    for (const f of files) {
      const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
      assert.equal(/cloudflare/i.test(src), false, f + ' 里仍有旧名');
    }
    const promptSrc = readFileSync(new URL('../cloud-functions/_app/agent/prompt.js', import.meta.url), 'utf8');
    assert.match(promptSrc, /你是 EdgeOne-Chat 智能助手/);
    const localSrc = readFileSync(new URL('../cloud-functions/_app/agent/tools-local.js', import.meta.url), 'utf8');
    assert.match(localSrc, /EdgeOne-Chat\/7\.0/);
    // 顺带确认没把 User-Agent 里指向 Cloudflare 的 URL 留在对外请求上
    assert.equal(/workers\.cloudflare\.com/.test(localSrc), false, 'UA 里不应再指向 Cloudflare');
    const tgSrc = readFileSync(new URL('../cloud-functions/_app/telegram/handler.js', import.meta.url), 'utf8');
    assert.match(tgSrc, /\[edgeone-chat\]/);
  });

  await checkAsync('存储默认命名空间是 edgeone-chat，且不再内置任何旧命名空间后门', () => {
    assert.equal(edgeStore.DEFAULT_BLOB_NAMESPACE, 'edgeone-chat');
    // 曾经有个 LEGACY_BLOB_NAMESPACE 常量 + /healthz 的 legacyNamespace 提示，
    // 已按要求移除。EO_BLOB_NAMESPACE 本身是通用变量，需要时仍可手动指向任意命名空间。
    assert.equal('LEGACY_BLOB_NAMESPACE' in edgeStore, false, '旧命名空间常量应已移除');
    assert.ok(edgeStore.looksLikeKvNamespace(fakeKvNamespace()));
  });

  await checkAsync('排障输出只报当前命名空间，不带任何旧命名空间痕迹', async () => {
    edgeStore.__resetForTest();
    try {
      const res = await mod.handle({
        request: new Request('https://example.com/healthz'),
        env: { STORAGE_DEBUG: '1' },
        waitUntil: () => {},
      });
      const j = await res.json();
      assert.equal(j.debug.namespace, 'edgeone-chat');
      assert.equal('legacyNamespace' in j.debug, false, '不应再有 legacyNamespace 字段');
      // kvCandidates 会列出环境里真实存在的 KV 绑定名，不纳入这条检查
      const relevant = JSON.stringify({
        namespace: j.debug.namespace,
        provision: j.debug.provision,
        hint: j.debug.hint,
        blobError: j.debug.blobError,
      });
      assert.equal(/cloudflare/i.test(relevant), false, '排障信息里不应再出现旧名');
    } finally {
      edgeStore.__resetForTest();
    }
  });

  await checkAsync('EO_BLOB_NAMESPACE 仍可指向任意命名空间（通用能力，不是旧名后门）', async () => {
    edgeStore.__resetForTest();
    try {
      const res = await mod.handle({
        request: new Request('https://example.com/healthz'),
        env: { STORAGE_DEBUG: '1', EO_BLOB_NAMESPACE: 'my-own-store' },
        waitUntil: () => {},
      });
      const j = await res.json();
      assert.equal(j.debug.namespace, 'my-own-store');
    } finally {
      edgeStore.__resetForTest();
    }
  });

  await checkAsync('KV 常见绑定名里已无旧名；任意名字仍能被全量扫描发现', () => {
    // 注意：从常见名列表里删掉旧名只是「源码里不再出现它」，并不会让代码认不出旧绑定名 ——
    // 第三层是全量扫描，任意变量名都能被认出。这是通用能力，不是为旧名留的后门。
    const src = readFileSync(new URL('../cloud-functions/_app/store/edge-store.js', import.meta.url), 'utf8');
    assert.equal(/cloudflare/i.test(src), false, 'edge-store.js 源码里不应再有旧名');

    globalThis.SOME_ARBITRARY_KV_NAME = fakeKvNamespace();
    try {
      const found = edgeStore.detectKvBinding({}, {});
      assert.ok(found, '任意名字的 KV 绑定都应被发现');
      assert.equal(found.name, 'globalThis.SOME_ARBITRARY_KV_NAME');
    } finally {
      delete globalThis.SOME_ARBITRARY_KV_NAME;
    }
  });

  console.log('\n=== 11. 浏览器端键名迁移（cfchat_* → eochat_*，不能丢老用户记录） ===');

  // 直接从渲染出来的页面里切出真实代码片段来跑 —— 不复制一份逻辑，避免「测试和实现各写一遍」。
  function sliceScript(from, to) {
    const i = pageHtml.indexOf(from);
    assert.ok(i >= 0, '页面里找不到片段起点：' + from);
    const j = pageHtml.indexOf(to, i);
    assert.ok(j > i, '页面里找不到片段终点：' + to);
    return pageHtml.slice(i, j);
  }

  function runSessionsScript(lsInit) {
    const code = sliceScript("const STORAGE_KEY = 'eochat_sessions'", 'let currentSessionId = null;');
    const ls = fakeLocalStorage(lsInit);
    const fn = new Function('localStorage', code + '\nreturn { sessions: sessions, KEY: STORAGE_KEY, LEGACY: LEGACY_STORAGE_KEYS };');
    return { out: fn(ls), ls: ls };
  }

  await checkAsync('老用户 cfchat_sessions 会被搬到 eochat_sessions（数据不丢）', () => {
    const old = JSON.stringify([{ id: 's1', title: '旧会话', messages: [] }]);
    const r = runSessionsScript({ cfchat_sessions: old });
    assert.equal(r.out.KEY, 'eochat_sessions');
    assert.equal(r.out.sessions.length, 1, '旧会话应被读出来');
    assert.equal(r.out.sessions[0].title, '旧会话');
    assert.equal(r.ls.getItem('eochat_sessions'), old, '应写入新键');
    assert.equal(r.ls.getItem('cfchat_sessions'), null, '应清掉旧键');
  });

  await checkAsync('更老的 nvidia_ai_sessions 也能一路迁移到 eochat_sessions', () => {
    const ancient = JSON.stringify([{ id: 'a1', title: '上古会话' }]);
    const r = runSessionsScript({ nvidia_ai_sessions: ancient });
    assert.equal(r.out.sessions.length, 1);
    assert.equal(r.out.sessions[0].title, '上古会话');
    assert.equal(r.ls.getItem('eochat_sessions'), ancient);
    assert.equal(r.ls.getItem('nvidia_ai_sessions'), null);
  });

  await checkAsync('新旧键同时存在时以新键为准，且旧键被清理', () => {
    const r = runSessionsScript({
      eochat_sessions: JSON.stringify([{ id: 'new' }]),
      cfchat_sessions: JSON.stringify([{ id: 'old' }]),
    });
    assert.equal(r.out.sessions[0].id, 'new', '不能拿旧键覆盖新键');
    assert.equal(r.ls.getItem('cfchat_sessions'), null);
  });

  await checkAsync('全新用户（无任何旧键）不报错、会话为空', () => {
    const r = runSessionsScript({});
    assert.deepEqual(r.out.sessions, []);
    assert.equal(r.ls.getItem('eochat_sessions'), null, '没数据就不该凭空写入');
  });

  await checkAsync('旧键内容损坏（非 JSON / 非数组）时降级为空而不是崩掉', () => {
    assert.deepEqual(runSessionsScript({ cfchat_sessions: '{坏数据' }).out.sessions, []);
    assert.deepEqual(runSessionsScript({ cfchat_sessions: '"not-an-array"' }).out.sessions, []);
  });

  function runAgentModeScript(lsInit) {
    const code = sliceScript("const AGENT_MODE_KEY = 'eochat_agent_mode'", 'function renderAgentToggle()');
    const ls = fakeLocalStorage(lsInit);
    const fn = new Function('localStorage', code + '\nreturn { agentMode: agentMode, KEY: AGENT_MODE_KEY };');
    return { out: fn(ls), ls: ls };
  }

  await checkAsync('Agent 开关：默认开启，旧键 cfchat_agent_mode 的值被搬过来', () => {
    assert.equal(runAgentModeScript({}).out.agentMode, true, '无记录时默认开启');
    const off = runAgentModeScript({ cfchat_agent_mode: '0' });
    assert.equal(off.out.agentMode, false, '旧键里的「关闭」必须被继承');
    assert.equal(off.ls.getItem('eochat_agent_mode'), '0');
    assert.equal(off.ls.getItem('cfchat_agent_mode'), null);
    const on = runAgentModeScript({ cfchat_agent_mode: '1' });
    assert.equal(on.out.agentMode, true);
  });

  await checkAsync('Agent 开关：新键存在时优先，不被旧键覆盖', () => {
    const r = runAgentModeScript({ eochat_agent_mode: '0', cfchat_agent_mode: '1' });
    assert.equal(r.out.agentMode, false);
    assert.equal(r.ls.getItem('cfchat_agent_mode'), '1', '新键已存在时不该去动旧键');
  });

  console.log('\n=== 12. Telegram 链路自诊断（把静默失败翻成可读原因） ===');

  const diag = await import('../cloud-functions/_app/telegram/diag.js');
  const origFetch = globalThis.fetch;

  // 伪 Telegram API：按方法名返回预设响应，并记录每次调用，便于断言「到底发了什么」
  function stubTelegramFetch(opts) {
    const o = opts || {};
    const calls = [];
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      const method = u.split('/').pop().split('?')[0];
      calls.push({ method: method, init: init, url: u });
      let body;
      if (method === 'getMe') body = o.me || { ok: true, result: { id: 12345, is_bot: true, username: 'my_test_bot' } };
      else if (method === 'getWebhookInfo') body = o.info || { ok: true, result: { url: '', pending_update_count: 0 } };
      else if (method === 'setWebhook') body = { ok: true, result: true, description: 'Webhook was set' };
      else if (method === 'sendMessage') body = { ok: true, result: { message_id: 1 } };
      else body = { ok: false, error_code: 404, description: 'Not Found' };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    return calls;
  }
  function restoreFetch() { globalThis.fetch = origFetch; }

  const FAKE_TOKEN = '123456789:AAFakeSecretTokenValueThatShouldNeverLeak012345';
  const TG_MODELS = { API_URL: 'https://up.example/v1/chat/completions', MODEL: 'm1', API_KEY: 'k1' };

  function tgWebhookCall(env, update, headers) {
    return mod.handle({
      request: new Request('https://example.com/tg-webhook', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
        body: JSON.stringify(update),
      }),
      env: env,
      waitUntil: () => {},
    });
  }
  function tgSetupCall(qs, env) {
    return mod.handle({
      request: new Request('https://example.com/tg-setup' + qs),
      env: env,
      waitUntil: () => {},
    });
  }

  await checkAsync('diag 模块可加载，且快照结构完整', () => {
    diag.tgReset();
    const ev = diag.tgNote('skip', { reason: 'unit_test', chatId: 42 });
    assert.equal(ev.reason, 'unit_test');
    const snap = diag.tgSnapshot();
    assert.equal(snap.counters.skipped, 1);
    assert.equal(snap.events.length, 1);
    assert.equal(snap.events[0].chatId, 42);
    assert.ok(snap.startedAt && snap.now);
    diag.tgReset();
    assert.equal(diag.tgSnapshot().counters.skipped, 0, 'tgReset 应清空状态');
  });

  await checkAsync('/tg-setup 在未配置任何 key 时直接关闭（否则任何人都能改你的 webhook）', async () => {
    const res = await tgSetupCall('', { STORAGE_BACKEND: 'none', TG_BOT_TOKEN: FAKE_TOKEN });
    assert.equal(res.status, 403);
    const j = await res.json();
    assert.equal(j.ok, false);
    assert.match(j.error, /TG_SETUP_KEY/);
  });

  await checkAsync('/tg-setup key 不正确时返回 403', async () => {
    const res = await tgSetupCall('?key=wrong', { STORAGE_BACKEND: 'none', TG_SETUP_KEY: 'right' });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /key 不正确/);
  });

  await checkAsync('/tg-setup 读不到 TG_BOT_TOKEN 时明确报出来，并带上进程内事件', async () => {
    diag.tgReset();
    diag.tgNote('skip', { reason: 'no_bot_token' });
    const res = await tgSetupCall('?key=k', { STORAGE_BACKEND: 'none', TG_SETUP_KEY: 'k' });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ok, false);
    assert.match(j.error, /TG_BOT_TOKEN/);
    assert.equal(j.diag.counters.skipped, 1, '应附带进程内观测');
    assert.equal(j.topHint.code, 'no_bot_token');
    diag.tgReset();
  });

  await checkAsync('/tg-setup 把 getWebhookInfo 的 last_error_message 翻出来（setWebhook 成功 ≠ 链路可用）', async () => {
    const calls = stubTelegramFetch({
      info: {
        ok: true,
        result: {
          url: 'https://example.com/tg-webhook',
          pending_update_count: 7,
          last_error_date: 1700000000,
          last_error_message: 'Wrong response from the webhook: 403 Forbidden',
        },
      },
    });
    try {
      const res = await tgSetupCall('?key=k', { STORAGE_BACKEND: 'none', TG_SETUP_KEY: 'k', TG_BOT_TOKEN: FAKE_TOKEN });
      const j = await res.json();
      assert.equal(j.webhook.urlMatches, true);
      assert.equal(j.webhook.pendingUpdateCount, 7);
      assert.match(j.webhook.lastErrorMessage, /403 Forbidden/);
      assert.equal(j.healthy, false, '有投递错误时不应报健康');
      const codes = j.hints.map(h => h.code);
      assert.ok(codes.includes('last_error'), '应给出投递失败提示');
      assert.ok(codes.includes('pending_updates'), '积压更新也应提示');
      assert.ok(calls.some(c => c.method === 'getMe'), '应调用 getMe');
      assert.ok(calls.some(c => c.method === 'getWebhookInfo'), '应调用 getWebhookInfo');
    } finally {
      restoreFetch();
    }
  });

  await checkAsync('注册地址与预期不一致时报 url_mismatch（Telegram 的请求根本没打到这里）', async () => {
    stubTelegramFetch({ info: { ok: true, result: { url: 'https://old-domain.example/tg-webhook', pending_update_count: 0 } } });
    try {
      const res = await tgSetupCall('?key=k', { STORAGE_BACKEND: 'none', TG_SETUP_KEY: 'k', TG_BOT_TOKEN: FAKE_TOKEN });
      const j = await res.json();
      assert.equal(j.webhook.urlMatches, false);
      assert.equal(j.webhook.expectedUrl, 'https://example.com/tg-webhook');
      const mismatch = j.hints.find(h => h.code === 'url_mismatch');
      assert.ok(mismatch, '应给出 url_mismatch');
      assert.equal(mismatch.level, 'fatal');
      assert.match(mismatch.message, /old-domain\.example/);
    } finally {
      restoreFetch();
    }
  });

  await checkAsync('自定义域名场景：TG_PUBLIC_BASE_URL 覆盖推导出的地址', async () => {
    stubTelegramFetch({ info: { ok: true, result: { url: 'https://chat.my.domain/tg-webhook', pending_update_count: 0 } } });
    try {
      const res = await tgSetupCall('?key=k', {
        STORAGE_BACKEND: 'none', TG_SETUP_KEY: 'k', TG_BOT_TOKEN: FAKE_TOKEN,
        TG_PUBLIC_BASE_URL: 'https://chat.my.domain/',
      });
      const j = await res.json();
      assert.equal(j.base, 'https://chat.my.domain', '尾部斜杠应被归一化');
      assert.equal(j.usingCustomBase, true);
      assert.equal(j.webhook.urlMatches, true, '用了自定义域名就不该误报不一致');
    } finally {
      restoreFetch();
    }
  });

  await checkAsync('action=set 会把 secret_token 与 allowed_updates 一起带上，并如实报告是否发送了 secret', async () => {
    const calls = stubTelegramFetch({});
    try {
      const res = await tgSetupCall('?key=k&action=set', {
        STORAGE_BACKEND: 'none', TG_SETUP_KEY: 'k', TG_BOT_TOKEN: FAKE_TOKEN,
        TG_WEBHOOK_SECRET: 'abcdef0123456789',
      });
      const j = await res.json();
      assert.equal(j.setWebhook.ok, true);
      assert.equal(j.setWebhook.sentSecretToken, true);
      assert.equal(j.setWebhook.sentSecretLength, 16);
      const setCall = calls.find(c => c.method === 'setWebhook');
      assert.ok(setCall, '应调用 setWebhook');
      const sent = JSON.parse(setCall.init.body);
      assert.equal(sent.url, 'https://example.com/tg-webhook');
      assert.equal(sent.secret_token, 'abcdef0123456789');
      assert.deepEqual(sent.allowed_updates, ['message', 'callback_query']);
      assert.equal(sent.drop_pending_updates, false);
    } finally {
      restoreFetch();
    }
  });

  await checkAsync('未配置 TG_WEBHOOK_SECRET 时不发送 secret_token，并提示接口处于开放状态', async () => {
    const calls = stubTelegramFetch({});
    try {
      const res = await tgSetupCall('?key=k&action=set', { STORAGE_BACKEND: 'none', TG_SETUP_KEY: 'k', TG_BOT_TOKEN: FAKE_TOKEN });
      const j = await res.json();
      assert.equal(j.setWebhook.sentSecretToken, false);
      const sent = JSON.parse(calls.find(c => c.method === 'setWebhook').init.body);
      assert.equal('secret_token' in sent, false, '没配就不该发送该字段');
      assert.ok(j.hints.some(h => h.code === 'no_secret'));
    } finally {
      restoreFetch();
    }
  });

  await checkAsync('响应里绝不回显 bot token 原文（只回 bot_id 与密钥长度）', async () => {
    stubTelegramFetch({});
    try {
      const res = await tgSetupCall('?key=k&action=set', {
        STORAGE_BACKEND: 'none', TG_SETUP_KEY: 'k', TG_BOT_TOKEN: FAKE_TOKEN, TG_WEBHOOK_SECRET: 'abcdef0123456789',
      });
      const text = await res.text();
      assert.equal(text.includes(FAKE_TOKEN), false, '绝不能出现完整 token');
      assert.equal(text.includes('AAFakeSecretTokenValueThatShouldNeverLeak012345'), false, '绝不能出现 token 密钥段');
      const j = JSON.parse(text);
      assert.equal(j.bot.botId, '123456789', 'bot_id 可公开，便于核对是不是自己的 bot');
      assert.equal(j.bot.formatOk, true);
    } finally {
      restoreFetch();
    }
  });

  await checkAsync('出网失败（fetch 抛错）时给出 tg_unreachable，而不是含糊的失败', async () => {
    globalThis.fetch = async () => { throw new Error('fetch failed'); };
    try {
      const res = await tgSetupCall('?key=k', { STORAGE_BACKEND: 'none', TG_SETUP_KEY: 'k', TG_BOT_TOKEN: FAKE_TOKEN });
      const j = await res.json();
      assert.equal(j.getMe.transportError, 'fetch failed');
      const h = j.hints.find(x => x.code === 'tg_unreachable');
      assert.ok(h, '应给出出网不通的提示');
      assert.equal(h.level, 'fatal');
    } finally {
      restoreFetch();
    }
  });

  await checkAsync('没有模型时 webhook 记录 no_models —— 且对 Telegram 仍返回 200（这正是静默的根源）', async () => {
    diag.tgReset();
    const res = await tgWebhookCall(
      { STORAGE_BACKEND: 'none', TG_BOT_TOKEN: FAKE_TOKEN, TG_ALLOWED_CHAT_IDS: '999' },
      { update_id: 101, message: { message_id: 1, chat: { id: 999, type: 'private' }, text: '你好' } },
    );
    assert.equal(res.status, 200, 'Telegram 侧看到的是成功 —— 所以必须靠自诊断才能发现问题');
    const snap = diag.tgSnapshot();
    assert.equal(snap.counters.received, 1);
    assert.equal(snap.counters.skipped, 1);
    const ev = snap.events.find(e => e.reason === 'no_models');
    assert.ok(ev, '应记录 no_models');
    assert.equal(ev.updateId, 101);
    diag.tgReset();
  });

  await checkAsync('白名单拦下时记录真实 chat_id —— 用户可以直接复制进 TG_ALLOWED_CHAT_IDS', async () => {
    diag.tgReset();
    const res = await tgWebhookCall(
      Object.assign({ STORAGE_BACKEND: 'none', TG_BOT_TOKEN: FAKE_TOKEN, TG_ALLOWED_CHAT_IDS: '111' }, TG_MODELS),
      { update_id: 202, message: { message_id: 2, chat: { id: 88888888, type: 'private' }, text: '在吗' } },
    );
    assert.equal(res.status, 200);
    const snap = diag.tgSnapshot();
    const ev = snap.events.find(e => e.reason === 'chat_not_allowed');
    assert.ok(ev, '应记录 chat_not_allowed');
    assert.equal(ev.chatId, 88888888, '必须记下真实 chat_id');
    assert.equal(ev.chatType, 'private');

    // 自诊断端点要把这个 id 直接翻成人话提示
    const hint = diag.tgTopHint(snap);
    assert.equal(hint.code, 'chat_not_allowed');
    assert.equal(hint.chatId, 88888888);
    assert.match(hint.message, /88888888/);
    assert.match(hint.message, /TG_ALLOWED_CHAT_IDS/);
    diag.tgReset();
  });

  await checkAsync('白名单内的消息不会被误拦（chat id 用字符串比较，避免数字/字符串不一致）', async () => {
    diag.tgReset();
    await tgWebhookCall(
      Object.assign({ STORAGE_BACKEND: 'none', TG_BOT_TOKEN: FAKE_TOKEN, TG_ALLOWED_CHAT_IDS: ' 777 ' }, TG_MODELS),
      { update_id: 203, message: { message_id: 3, chat: { id: 777, type: 'private' }, text: 'hi' } },
    );
    const snap = diag.tgSnapshot();
    assert.equal(snap.events.some(e => e.reason === 'chat_not_allowed'), false, '带空格的配置也应被正确解析');
    diag.tgReset();
  });

  await checkAsync('secret 不匹配时返回 403 并留痕（改了 secret 却没重新 setWebhook 的典型症状）', async () => {
    diag.tgReset();
    const res = await tgWebhookCall(
      { STORAGE_BACKEND: 'none', TG_BOT_TOKEN: FAKE_TOKEN, TG_WEBHOOK_SECRET: 'expected-secret' },
      { update_id: 303, message: { message_id: 4, chat: { id: 1, type: 'private' }, text: 'x' } },
      { 'X-Telegram-Bot-Api-Secret-Token': 'stale-secret' },
    );
    assert.equal(res.status, 403);
    const snap = diag.tgSnapshot();
    assert.equal(snap.counters.forbidden, 1);
    const ev = snap.events.find(e => e.reason === 'secret_mismatch');
    assert.ok(ev, '应记录 secret_mismatch');
    assert.match(ev.detail, /长度 12/, '应报出收到的长度，便于发现被截断');
    assert.equal(snap.lastError.reason, 'secret_mismatch');
    diag.tgReset();
  });

  await checkAsync('secret 正确时放行（回归保护：别把正常请求也拦了）', async () => {
    diag.tgReset();
    const res = await tgWebhookCall(
      { STORAGE_BACKEND: 'none', TG_BOT_TOKEN: FAKE_TOKEN, TG_WEBHOOK_SECRET: 'right-secret' },
      { update_id: 304, message: { message_id: 5, chat: { id: 1, type: 'private' }, text: 'x' } },
      { 'X-Telegram-Bot-Api-Secret-Token': 'right-secret' },
    );
    assert.equal(res.status, 200);
    assert.equal(diag.tgSnapshot().counters.forbidden, 0);
    diag.tgReset();
  });

  await checkAsync('非消息类更新（如 channel_post）被识别为 not_a_message 并说明实际类型', async () => {
    diag.tgReset();
    await tgWebhookCall(
      Object.assign({ STORAGE_BACKEND: 'none', TG_BOT_TOKEN: FAKE_TOKEN, TG_ALLOWED_CHAT_IDS: '999' }, TG_MODELS),
      { update_id: 404, channel_post: { message_id: 6, chat: { id: 5, type: 'channel' }, text: 'x' } },
    );
    const ev = diag.tgSnapshot().events.find(e => e.reason === 'not_a_message');
    assert.ok(ev, '应记录 not_a_message');
    assert.match(ev.detail, /channel_post/);
    diag.tgReset();
  });

  await checkAsync('请求体不是合法 JSON 时留痕并返回 500（Telegram 会重试）', async () => {
    diag.tgReset();
    const res = await mod.handle({
      request: new Request('https://example.com/tg-webhook', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not-json{',
      }),
      env: { STORAGE_BACKEND: 'none', TG_BOT_TOKEN: FAKE_TOKEN },
      waitUntil: () => {},
    });
    assert.equal(res.status, 500);
    const ev = diag.tgSnapshot().events.find(e => e.reason === 'bad_json_or_fatal');
    assert.ok(ev, '应记录 bad_json_or_fatal');
    diag.tgReset();
  });

  await checkAsync('/tg-setup?action=test 会往白名单第一个会话发一条自检消息', async () => {
    const calls = stubTelegramFetch({});
    try {
      const res = await tgSetupCall('?key=k&action=test', {
        STORAGE_BACKEND: 'none', TG_SETUP_KEY: 'k', TG_BOT_TOKEN: FAKE_TOKEN, TG_ALLOWED_CHAT_IDS: '555,666',
      });
      const j = await res.json();
      assert.equal(j.test.ok, true);
      assert.equal(j.test.chatId, '555');
      const sent = JSON.parse(calls.find(c => c.method === 'sendMessage').init.body);
      assert.equal(sent.chat_id, '555');
      assert.match(sent.text, /连通性自检/);
    } finally {
      restoreFetch();
    }
  });

  await checkAsync('action=test 在白名单为空时拒绝执行（不瞎猜发给谁）', async () => {
    stubTelegramFetch({});
    try {
      const res = await tgSetupCall('?key=k&action=test', { STORAGE_BACKEND: 'none', TG_SETUP_KEY: 'k', TG_BOT_TOKEN: FAKE_TOKEN });
      const j = await res.json();
      assert.equal(j.test.ok, false);
      assert.match(j.test.error, /TG_ALLOWED_CHAT_IDS/);
    } finally {
      restoreFetch();
    }
  });

  await checkAsync('未知 action 返回 400 并列出可用值', async () => {
    const res = await tgSetupCall('?key=k&action=whatever', { STORAGE_BACKEND: 'none', TG_SETUP_KEY: 'k', TG_BOT_TOKEN: FAKE_TOKEN });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /status.*set.*delete.*test/s);
  });

  await checkAsync('/tg-setup 与 /tg-webhook 都在 Service Worker 的放行名单里（否则诊断结果会被缓存）', async () => {
    const swMod = await import('../cloud-functions/_app/pwa/service-worker.js');
    assert.match(swMod.SW_JS, /url\.pathname === '\/tg-webhook'/);
    assert.match(swMod.SW_JS, /url\.pathname === '\/tg-setup'/);
  });

  await checkAsync('群聊默认仅在 @机器人 或引用回复时触发，普通闲聊记录 group_not_mentioned 并忽略', async () => {
    diag.tgReset();
    const calls = stubTelegramFetch({});
    try {
      const env = Object.assign({ STORAGE_BACKEND: 'none', TG_BOT_TOKEN: FAKE_TOKEN, TG_ALLOWED_CHAT_IDS: '-100888' }, TG_MODELS);
      await tgWebhookCall(env, {
        update_id: 901,
        message: { message_id: 10, chat: { id: -100888, type: 'supergroup' }, from: { id: 1, is_bot: false }, text: '群里普通闲聊' },
      });
      const snap1 = diag.tgSnapshot();
      assert.equal(snap1.events[0].reason, 'group_not_mentioned', '未 @ 机器人的群消息应被忽略');
      assert.equal(calls.some(c => c.method === 'sendMessage'), false, '不应发送任何回复');

      diag.tgReset();
      await tgWebhookCall(env, {
        update_id: 902,
        message: { message_id: 11, chat: { id: -100888, type: 'supergroup' }, from: { id: 1, is_bot: false }, text: '/help@other_bot' },
      });
      assert.equal(diag.tgSnapshot().events[0].reason, 'group_not_mentioned', '发给其他机器人的命令应被忽略');

      diag.tgReset();
      await tgWebhookCall(env, {
        update_id: 903,
        message: { message_id: 12, chat: { id: -100888, type: 'supergroup' }, from: { id: 1, is_bot: false }, text: '/help@my_test_bot' },
      });
      assert.equal(diag.tgSnapshot().events[0].reason, 'command', '发给本机器人的命令应正常触发');
    } finally {
      restoreFetch();
      diag.tgReset();
    }
  });

  console.log('\n=== 13. Agent 性能加速与 19 项零密钥工具自检 ===');

  const agentToolsMod = await import('../cloud-functions/_app/agent/tools.js');
  const toolsLocalMod = await import('../cloud-functions/_app/agent/tools-local.js');
  const toolsWebMod = await import('../cloud-functions/_app/agent/tools-web.js');
  const limitsMod = await import('../cloud-functions/_app/agent/limits.js');

  await checkAsync('Agent 工具箱共注册 19 项工具（Web 只读模式自动过滤 4 项写入工具剩 15 项）', () => {
    const allTools = agentToolsMod.getAgentTools(false);
    const roTools = agentToolsMod.getAgentTools(true);
    assert.equal(allTools.length, 19);
    assert.equal(roTools.length, 15);
    const names = allTools.map(t => t.function.name);
    for (const expected of ['unit_convert', 'text_toolkit', 'network_lookup', 'github_lookup', 'arxiv_search', 'trending_news']) {
      assert.ok(names.includes(expected), '应包含新工具 ' + expected);
      assert.match(limitsMod.describeToolCall(expected, { query: 'q', target: 't', value: 1, from: 'km', to: 'mi' }), /正在/);
    }
  });

  await checkAsync('科学/统计计算器扩展：支持 sum/avg/median/std/gcd/lcm/fact/comb/perm 与常量 tau/phi', () => {
    assert.equal(toolsLocalMod.toolCalculate('sum(1, 2, 3, 4, 5)'), '计算结果：15');
    assert.equal(toolsLocalMod.toolCalculate('avg(10, 20, 30)'), '计算结果：20');
    assert.equal(toolsLocalMod.toolCalculate('median(1, 99, 7, 10)'), '计算结果：8.5');
    assert.equal(toolsLocalMod.toolCalculate('gcd(48, 18, 30)'), '计算结果：6');
    assert.equal(toolsLocalMod.toolCalculate('lcm(4, 6, 8)'), '计算结果：24');
    assert.equal(toolsLocalMod.toolCalculate('fact(6)'), '计算结果：720');
    assert.equal(toolsLocalMod.toolCalculate('comb(10, 3)'), '计算结果：120');
    assert.equal(toolsLocalMod.toolCalculate('perm(5, 2)'), '计算结果：20');
    assert.equal(toolsLocalMod.toolCalculate('round(tau / pi, 4)'), '计算结果：2');
  });

  await checkAsync('全能单位换算与大整数进制转换（unit_convert）精确无误', () => {
    assert.match(toolsLocalMod.toolUnitConvert({ value: 100, from: 'C', to: 'F' }), /212 °F/);
    assert.match(toolsLocalMod.toolUnitConvert({ value: 1, from: 'km', to: 'm' }), /1000 m/);
    assert.match(toolsLocalMod.toolUnitConvert({ value: 2, from: 'GB', to: 'MB' }), /2048 MB/);
    assert.match(toolsLocalMod.toolUnitConvert({ value: 'FF', base_from: 16, base_to: 10 }), /255（10 进制）/);
    assert.match(toolsLocalMod.toolUnitConvert({ value: 42, from: 'dec', to: 'bin' }), /101010（2 进制）/);
  });

  await checkAsync('文本与编码工具箱（text_toolkit）：字数统计、SHA-256、Base64、URL 编解码与 UUID', async () => {
    const st = await toolsLocalMod.toolTextToolkit({ action: 'stats', text: '你好 EdgeOne 123\n第二行' });
    assert.match(st, /中文汉字数：5/);
    assert.match(st, /英文单词数：1/);
    assert.match(st, /行数：2/);

    const h = await toolsLocalMod.toolTextToolkit({ action: 'hash', text: 'abc', algorithm: 'SHA-256' });
    assert.match(h, /ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad/);

    const b64 = await toolsLocalMod.toolTextToolkit({ action: 'base64_encode', text: 'EdgeOne 智能助手' });
    const encoded = b64.split('\n').pop().trim();
    const dec = await toolsLocalMod.toolTextToolkit({ action: 'base64_decode', text: encoded });
    assert.match(dec, /EdgeOne 智能助手/);

    const uuids = await toolsLocalMod.toolTextToolkit({ action: 'uuid', count: 3 });
    assert.equal((uuids.match(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi) || []).length, 3);
  });

  await checkAsync('新联网工具（github_lookup / arxiv_search / trending_news / network_lookup）解析与返回格式正常', async () => {
    agentToolsMod.clearAgentToolCache();
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('api.github.com/repos/owner/repo/releases/latest')) {
        return new Response(JSON.stringify({ tag_name: 'v2.5.0', published_at: '2026-10-01T00:00:00Z' }), { status: 200 });
      }
      if (u.includes('api.github.com/repos/owner/repo')) {
        return new Response(JSON.stringify({
          full_name: 'owner/repo', html_url: 'https://github.com/owner/repo',
          description: 'Fast AI Agent', stargazers_count: 8888, forks_count: 666,
          open_issues_count: 12, language: 'JavaScript', license: { spdx_id: 'MIT' },
          pushed_at: '2026-10-15T00:00:00Z', topics: ['ai', 'agent']
        }), { status: 200 });
      }
      if (u.includes('export.arxiv.org')) {
        const xml = `<feed><entry><id>http://arxiv.org/abs/2610.00001v1</id><published>2026-10-10T00:00:00Z</published><title>Fast Edge Agent Architecture</title><summary>We propose a fast agent loop.</summary><author><name>Alice</name></author></entry></feed>`;
        return new Response(xml, { status: 200 });
      }
      if (u.includes('hacker-news.firebaseio.com/v0/topstories.json')) {
        return new Response(JSON.stringify([101]), { status: 200 });
      }
      if (u.includes('hacker-news.firebaseio.com/v0/item/101.json')) {
        return new Response(JSON.stringify({ id: 101, title: 'EdgeOne AI Released', score: 350, descendants: 88, url: 'https://example.org/news' }), { status: 200 });
      }
      if (u.includes('ipwho.is/8.8.8.8')) {
        return new Response(JSON.stringify({
          success: true, ip: '8.8.8.8', country: 'United States', region: 'California', city: 'Mountain View',
          latitude: 37.386, longitude: -122.0838,
          connection: { asn: 15169, org: 'Google LLC', isp: 'Google' },
          timezone: { id: 'America/Los_Angeles', utc: '-07:00' }
        }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };
    try {
      const gh = await toolsWebMod.toolGithubLookup({ query: 'owner/repo' });
      assert.match(gh, /8888 Stars/);
      assert.match(gh, /v2.5.0/);

      const ax = await toolsWebMod.toolArxivSearch({ query: 'edge agent' });
      assert.match(ax, /Fast Edge Agent Architecture/);
      assert.match(ax, /Alice/);

      const hn = await toolsWebMod.toolTrendingNews({ source: 'hn', count: 1 });
      assert.match(hn, /EdgeOne AI Released/);
      assert.match(hn, /350 pts/);

      const net = await toolsLocalMod.toolNetworkLookup({ target: '8.8.8.8' });
      assert.match(net, /AS15169/);
      assert.match(net, /Mountain View/);
    } finally {
      restoreFetch();
    }
  });

  await checkAsync('性能优化：L1 工具结果缓存、同参并发去重、以及 web_fetch 翻页零网络开销缓存', async () => {
    agentToolsMod.clearAgentToolCache();
    let fetchCount = 0;
    const longHtml = '<html><body><h1>Title</h1><p>' + 'A'.repeat(4500) + '</p><p>' + 'B'.repeat(4500) + '</p></body></html>';
    globalThis.fetch = async () => {
      fetchCount++;
      await new Promise(r => setTimeout(r, 20));
      return new Response(longHtml, { status: 200, headers: { 'Content-Type': 'text/html' } });
    };
    try {
      // 1) 并发发起两个完全相同的 web_fetch 调用 → 应合并为 1 次底层请求
      const [r1, r2] = await Promise.all([
        agentToolsMod.execAgentTool('web_fetch', { url: 'https://example.com/long-doc', offset: 0 }, {}, 'c1', false),
        agentToolsMod.execAgentTool('web_fetch', { url: 'https://example.com/long-doc', offset: 0 }, {}, 'c1', false),
      ]);
      assert.equal(r1, r2);
      assert.equal(fetchCount, 1, '同参并发调用应只触发 1 次网络请求');

      // 2) 翻页续读 offset=6000 → 命中 L1 页面缓存，不触发新的网络请求
      const rPage2 = await agentToolsMod.execAgentTool('web_fetch', { url: 'https://example.com/long-doc', offset: 6000 }, {}, 'c1', false);
      assert.equal(fetchCount, 1, 'web_fetch 传 offset 翻页应直接命中 L1 正文缓存，零网络请求');
      assert.match(rPage2, /B{50}/);
    } finally {
      restoreFetch();
      agentToolsMod.clearAgentToolCache();
    }
  });

  await checkAsync('事件环形缓冲有上限（isolate 常驻也不会无限增长）', () => {
    diag.tgReset();
    const total = diag.MAX_EVENTS + 25;
    for (let i = 0; i < total; i++) {
      diag.tgNote('skip', { reason: 'flood', updateId: i });
    }
    const snap = diag.tgSnapshot();
    assert.equal(snap.events.length, diag.MAX_EVENTS, '事件明细应被截断到上限');
    assert.equal(snap.counters.skipped, total, '计数不该被截断 —— 只有明细有上限');
    assert.equal(snap.events[0].updateId, total - 1, '倒序输出，第一条应是最新的');
    diag.tgReset();
  });


  console.log('\n=== 14. 微信 ClawBot (iLink) 通道与四重防盗绑自检 ===');
  const wxIlink = await import('../cloud-functions/_app/wechat/ilink.js');
  const wxHandler = await import('../cloud-functions/_app/wechat/handler.js');

  await checkAsync('buildClientVersion 编码 2.4.10 为 132106 (0x0002040a)', () => {
    assert.equal(wxIlink.buildClientVersion('2.4.10'), 132106);
    assert.ok(wxIlink.randomWechatUin().length > 0);
  });

  await checkAsync('入站消息解析：支持纯文本、语音转写与引用上下文', () => {
    const p1 = wxIlink.extractWechatMessageContent({
      msg_id: 'm1',
      from_user_id: 'wxid_1@im.wechat',
      message_type: 1,
      context_token: 'ctx_1',
      item_list: [{ type: 1, text_item: { text: '你好 EdgeOne' } }],
    });
    assert.equal(p1.isUserMsg, true);
    assert.equal(p1.fromUserId, 'wxid_1@im.wechat');
    assert.equal(p1.text, '你好 EdgeOne');

    const p2 = wxIlink.extractWechatMessageContent({
      from_user_id: 'wxid_1@im.wechat',
      message_type: 1,
      context_token: 'ctx_2',
      item_list: [{ type: 3, voice_item: { text: '语音转写测试' } }],
    });
    assert.equal(p2.text, '语音转写测试');
  });

  await checkAsync('四重防盗绑 1：未配置 WX_ADMIN_SECRET 或 ACCESS_PASSWORD 时，/api/wx/qrcode 强制返回 403 拒绝', async () => {
    const res = await mod.handle({
      request: new Request('https://example.com/api/wx/qrcode', { method: 'POST' }),
      env: { STORAGE_BACKEND: 'none' },
      waitUntil: () => {},
    });
    assert.equal(res.status, 403);
    const j = await res.json();
    assert.equal(j.code, 'NO_SECRET_CONFIGURED');
  });

  await checkAsync('四重防盗绑 2：配置 WX_ADMIN_SECRET 后，未带密钥时隐藏详情并拒绝二维码请求，带密钥时解锁', async () => {
    const env = { STORAGE_BACKEND: 'none', WX_ADMIN_SECRET: 'eo-admin-999' };
    const rPub = await mod.handle({
      request: new Request('https://example.com/api/wx/status'),
      env, waitUntil: () => {},
    });
    const jPub = await rPub.json();
    assert.equal(jPub.adminAuthorized, false);
    assert.equal(jPub.botId, undefined);

    const rUnauth = await mod.handle({
      request: new Request('https://example.com/api/wx/qrcode', { method: 'POST' }),
      env, waitUntil: () => {},
    });
    assert.equal(rUnauth.status, 401);

    const rAdm = await mod.handle({
      request: new Request('https://example.com/api/wx/status', {
        headers: { 'X-Wx-Admin-Token': 'eo-admin-999' },
      }),
      env, waitUntil: () => {},
    });
    const jAdm = await rAdm.json();
    assert.equal(jAdm.adminAuthorized, true);
  });

  await checkAsync('四重防盗绑 3 & 4：已绑定后自动加锁防覆盖，且自动锁定绑定人 ilink_user_id', async () => {
    const store = blobBackend.makeBlobBackend(fakeBlobStore());
    const env = { R2: store, WX_ADMIN_SECRET: 'eo-admin-999' };
    await wxHandler.saveWxCredentials(env, {
      bot_token: 'bot_123:token_abc',
      ilink_bot_id: 'bot_123@im.bot',
      ilink_user_id: 'owner_wxid@im.wechat',
      baseurl: 'https://ilinkai.weixin.qq.com',
      expired: false,
    });
    const rQr = await wxHandler.handleWxApi(
      new Request('https://example.com/api/wx/qrcode', {
        method: 'POST',
        headers: { 'X-Wx-Admin-Token': 'eo-admin-999' },
      }),
      env,
      new URL('https://example.com/api/wx/qrcode')
    );
    assert.equal(rQr.status, 409);
    const jQr = await rQr.json();
    assert.equal(jQr.code, 'ALREADY_BOUND');

    // 非绑定人发来的消息应被自动归属锁拦截（not_bound_owner）
    const creds = await wxHandler.getWxCredentials(env);
    const strangerRes = await wxHandler.processWechatMessage(env, creds, {
      from_user_id: 'stranger_wxid@im.wechat',
      message_type: 1,
      context_token: 'ctx_x',
      item_list: [{ type: 1, text_item: { text: '你好' } }],
    });
    assert.equal(strangerRes.skipped, true);
    assert.equal(strangerRes.reason, 'not_bound_owner');
  });

  await checkAsync('微信专属排版清洗、中英双语口令解析与 MD5/AES-128-ECB 加解密自检', async () => {
    const formatted = wxIlink.formatWechatText('## 标题测试\n**粗体文字**与`行内代码`\n- 列表项1\n[链接](https://example.com)');
    assert.match(formatted, /▎标题测试/);
    assert.ok(!formatted.includes('**'), '不应残留 ** 符号');
    assert.match(formatted, /「行内代码」/);
    assert.match(formatted, /• 列表项1/);

    assert.deepEqual(wxHandler.parseWxCommand('菜单'), { cmd: '/help', rest: '' });
    assert.deepEqual(wxHandler.parseWxCommand('模型 2'), { cmd: '/model', rest: '2' });
    assert.deepEqual(wxHandler.parseWxCommand('画 一只穿宇航服的猫'), { cmd: '/draw', rest: '一只穿宇航服的猫' });
    assert.deepEqual(wxHandler.parseWxCommand('清空'), { cmd: '/clear', rest: '' });
    assert.deepEqual(wxHandler.parseWxCommand('状态'), { cmd: '/status', rest: '' });
    assert.deepEqual(wxHandler.parseWxCommand('忘掉 测试关键词'), { cmd: '/forget', rest: '测试关键词' });

    const sampleBytes = new TextEncoder().encode('Hello WeChat ClawBot Image Crypto!');
    const sampleKey = new Uint8Array([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]);
    const enc = wxIlink.encryptAes128Ecb(sampleBytes, sampleKey);
    const dec = await wxIlink.decryptAes128Ecb(enc, sampleKey);
    assert.deepEqual(Array.from(dec), Array.from(sampleBytes));
    assert.equal(wxIlink.md5Hex(new TextEncoder().encode('abc')), '900150983cd24fb0d6963f7d28e17f72');
  });

  await checkAsync('微信 35s 长轮询对齐与后台自接力链：不产生半途掐断僵尸连接，且收到消息立即释放锁并交棒下一跳', async () => {
    const store = blobBackend.makeBlobBackend(fakeBlobStore());
    const env = {
      R2: store,
      WX_ADMIN_SECRET: 'eo-admin-999',
      API_URL_1: 'https://api.example.com/v1/chat/completions',
      API_KEY_1: 'sk-test-123',
      MODEL_1: 'gpt-test:测试模型',
    };
    await wxHandler.saveWxCredentials(env, {
      bot_token: 'bot_relay:token_xyz',
      ilink_bot_id: 'bot_relay@im.bot',
      ilink_user_id: 'owner_wx@im.wechat',
      baseurl: 'https://ilinkai.weixin.qq.com',
      relay_origin: 'https://my-bot.edgeone.app',
      expired: false,
    });

    let relayDispatchedDuringAi = false;
    let lockHeldDuringAi = true;
    let relayHopReceived = 0;

    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes('/ilink/bot/getupdates')) {
        return new Response(JSON.stringify({
          ret: 0,
          msgs: [{
            msg_id: 'msg_fast_1',
            from_user_id: 'owner_wx@im.wechat',
            message_type: 1,
            context_token: 'ctx_fast_1',
            item_list: [{ type: 1, text_item: { text: '测试65秒修复' } }],
          }],
          get_updates_buf: 'cursor_after_1',
          longpolling_timeout_ms: 35000,
        }), { status: 200 });
      }
      if (u.includes('/wx-webhook?relay=1')) {
        const mHop = /hop=(\d+)/.exec(u);
        if (mHop) relayHopReceived = parseInt(mHop[1], 10);
        return new Response(JSON.stringify({ ok: true, relayed: true }), { status: 200 });
      }
      if (u.includes('api.example.com/v1/chat/completions')) {
        // 当 AI 正在思考时，验证轮询锁已被提前释放，且下一棒自接力请求已经发出！
        const lockObj = await store.get('wx_poll_lock');
        lockHeldDuringAi = !!lockObj;
        relayDispatchedDuringAi = relayHopReceived > 0;
        return new Response(JSON.stringify({
          choices: [{ message: { content: '秒回成功！' } }],
        }), { status: 200 });
      }
      if (u.includes('/ilink/bot/sendmessage') || u.includes('/ilink/bot/getconfig') || u.includes('/ilink/bot/sendtyping')) {
        return new Response(JSON.stringify({ ret: 0, typing_ticket: 'tk_1' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };

    try {
      const res = await wxHandler.runWechatPollCycle(env, {
        maxRuntimeMs: 44000,
        longPollTimeoutMs: 40000,
        maxRounds: 2,
        singleShot: false,
        autoRelay: true,
        origin: 'https://my-bot.edgeone.app',
        relayHop: 5,
      });
      assert.equal(res.ok, true);
      assert.equal(res.received, 1);
      assert.equal(res.processed, 1);
      assert.equal(lockHeldDuringAi, false, '进入 AI 推理前必须已释放轮询锁，供下一棒立即监听');
      assert.equal(relayDispatchedDuringAi, true, '进入 AI 推理前必须已触发下一棒自接力请求');
      assert.equal(relayHopReceived, 6, '下一棒 hop 应递增为 6');
    } finally {
      restoreFetch();
    }
  });

  console.log('\n=== 结果 ===');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail > 0) process.exit(1);
}

main().catch(e => {
  console.error('自检脚本自身异常：', e);
  process.exit(1);
});
