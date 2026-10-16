// 存储适配层入口：为 EdgeOne 环境构造一个「长得像 R2」的对象，挂到 env.R2 上。
//
// 设计原则：让上层业务代码零改动。
//   原项目里 store/r2.js、store/kb.js、kb/registry.js、kb/doc-tools.js、agent/memory.js、
//   agent/resume.js、agent/mode.js、telegram/handler.js 全部直接调用 env.R2.get/put/delete/list，
//   所以这里只要提供一个接口一致的替身，那 8 个文件一行都不用改。
//
// ============ 「自动创建 / 自动绑定」的真实边界（重要） ============
//
//   Blob（本项目唯一使用的后端）
//     创建：**完全自动**。首次 getStore("name") 时平台为项目自动创建该命名空间。
//           本层在首个请求时还会异步写一个 __meta__/provision.json 标记并读回校验，
//           让「创建」从「首次写入时顺带发生」变成「启动即确认」——见 ensureProvisioned()。
//     绑定：**不存在这一步**。官方文档明确：Blob 在控制台仅支持只读浏览
//           （查看命名空间列表、浏览对象目录），命名空间的创建与所有数据操作都走 SDK。
//           所以「把 Blob 绑定到某个变量名」这件事在 EdgeOne 上根本没有入口，
//           代码里也不需要认绑定名。环境变量 EO_BLOB_BINDING 仅作为逃生口保留：
//           当你在自检/本地脚本里自己构造了一个 Store 实例想注入时才会用到。
//
//   KV（备选，仅 Edge Functions 可用）
//     创建：**无法自动**。没有 SDK、没有管理 API，只能控制台手动创建命名空间。
//     绑定：只能控制台手动绑定。→ 本层能做的是**绑定名自动发现**：
//           你在控制台绑成什么变量名都行，代码都能自己认出来，不需要 EO_KV_BINDING。
//
// 后端选择（可用环境变量 STORAGE_BACKEND 覆盖）：
//   blob（默认）→ EdgeOne Blob 存储（@edgeone/pages-blob）。语义最接近 R2、key 无字符集限制、
//                 支持强一致读、命名空间自动创建 —— 本项目唯一推荐的后端。
//                 故意不自动回退到 KV：KV 的语义差异（最终一致、key 长度限制）是隐性的，
//                 静默降级会让问题更难排查。Blob 不可用时直接暴露出来，/healthz 会说明原因。
//   kv          → EdgeOne KV 存储（备选，仅 Edge Functions 可用）。需要显式指定。
//   auto        → 先试 Blob，失败再退 KV（旧行为，保留给确实需要 KV 兜底的场景）
//   none        → 不挂载，退化为纯内存（Web 端聊天与 PWA 仍可用，Telegram 机器人与知识库失效）
//
// 相关环境变量：
//   STORAGE_BACKEND      blob（默认）| kv | auto | none
//   EO_BLOB_NAMESPACE    Blob 命名空间名，默认 edgeone-chat（自动创建）
//                        ⚠️ 改了它等于换一个命名空间：原来写进去的数据在新命名空间里读不到。
//   BLOB_CONSISTENCY     strong（默认）| eventual —— 读取一致性
//   BLOB_AUTOPROVISION   1（默认）| 0 —— 是否在首个请求时自动创建并校验命名空间
//   EO_BLOB_BINDING      逃生口：注入自建的 Store 实例（一般不需要）
//   EO_KV_BINDING        指定 KV 绑定名（一般不需要——不填会自动发现）
//   STORAGE_DEBUG        设为 1 时，/healthz 会额外输出后端探测详情；再加 ?probe=1 会真实读写一次

import { makeBlobBackend, normalizeConsistency, blobLastError, hintForCode } from './blob-backend.js';
import { makeKvBackend } from './kv-backend.js';

const DEFAULT_BLOB_NAMESPACE = 'edgeone-chat';
const PROVISION_KEY = '__meta__/provision.json';
// 优先按这些常见名字找，命中即返回，避免全量扫描
const DEFAULT_KV_BINDING_NAMES = [
  'CHAT_KV', 'KV', 'STORAGE', 'EO_KV', 'EDGEONE_KV', 'EDGEONE_CHAT_KV',
];
// 全量扫描时要跳过的全局名，避免误触 getter 或匹配到无关对象。
// 特别注意 'R2'：那是本层自己挂上去的 R2 替身，它同样有 get/put/delete/list，
// 若不排除会被当成 KV 再包一层，造成自我套娃。
const SCAN_SKIP = new Set([
  'R2',
  'globalThis', 'global', 'window', 'self', 'process', 'require', 'module', 'exports',
  'console', 'caches', 'navigator', 'performance', 'crypto', 'fetch', 'Request', 'Response',
  'Headers', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'ReadableStream',
  'WritableStream', 'TransformStream', 'Blob', 'File', 'FormData', 'AbortController',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask',
  'structuredClone', 'atob', 'btoa', 'Buffer', 'localStorage', 'sessionStorage',
]);

// isolate 级缓存：同一实例内只解析一次后端，避免每个请求都做一次 SDK 查找。
// 只缓存「成功」的结果；解析失败走一个短负缓存，避免每请求都重试动态引入。
let cachedStore = null;
let cachedBackendName = '';
let lastFailAt = 0;
const FAIL_RETRY_MS = 15000;

// 最近一次探测的详情，供 /healthz 排障
let lastBlobError = '';
let lastBlobFound = '';
let lastKvFound = '';
let lastConsistency = '';

// 自动置备状态（每个 isolate 一份）
let provisionState = { state: 'idle', ok: false, at: 0, namespace: '', error: '' };
let provisionInFlight = null;
let provisionLastAttempt = 0;
const PROVISION_RETRY_MS = 60000;

function errText(e) {
  return (e && e.message) ? String(e.message).slice(0, 300) : String(e).slice(0, 300);
}

// 判断一个对象「像不像 KV 命名空间」。
// KV 的签名是 get / put / delete / list；Blob 的 Store 用的是 set（没有 put），
// caches 是 open/match/delete（没有 put）——所以 put 这个特征足以把两者区分开。
function looksLikeKvNamespace(v) {
  return !!v
    && typeof v === 'object'
    && typeof v.get === 'function'
    && typeof v.put === 'function'
    && typeof v.delete === 'function';
}

// 判断一个对象「像不像 Blob Store」。
// Blob 的签名是 set / get / delete / list，且**没有 put**（put 是 KV 的特征键）。
// 仅用于 EO_BLOB_BINDING 逃生口的形态校验 —— Blob 没有控制台绑定机制，不做全量扫描。
function looksLikeBlobStore(v) {
  return !!v
    && typeof v === 'object'
    && typeof v.set === 'function'
    && typeof v.get === 'function'
    && typeof v.delete === 'function'
    && typeof v.list === 'function'
    && typeof v.put !== 'function';
}

function collectSources(context, env) {
  const sources = [];
  if (env) sources.push({ label: 'env', obj: env });
  if (context && context.env && context.env !== env) sources.push({ label: 'context.env', obj: context.env });
  if (context) sources.push({ label: 'context', obj: context });
  try { sources.push({ label: 'globalThis', obj: globalThis }); } catch (e) {}
  return sources;
}

// 自动发现 KV 绑定：显式指定 → 常见名字 → 全量扫描（任意变量名都能认出）
function detectKvBinding(context, env) {
  const sources = collectSources(context, env);

  const explicit = env && env.EO_KV_BINDING ? String(env.EO_KV_BINDING) : '';
  if (explicit) {
    for (const s of sources) {
      let v;
      try { v = s.obj[explicit]; } catch (e) { continue; }
      if (looksLikeKvNamespace(v)) return { kv: v, name: s.label + '.' + explicit };
    }
  }

  for (const n of DEFAULT_KV_BINDING_NAMES) {
    for (const s of sources) {
      let v;
      try { v = s.obj[n]; } catch (e) { continue; }
      if (looksLikeKvNamespace(v)) return { kv: v, name: s.label + '.' + n };
    }
  }

  for (const s of sources) {
    let keys;
    try { keys = Object.getOwnPropertyNames(s.obj); } catch (e) { continue; }
    for (const k of keys) {
      if (SCAN_SKIP.has(k)) continue;
      let v;
      try { v = s.obj[k]; } catch (e) { continue; }
      if (looksLikeKvNamespace(v)) return { kv: v, name: s.label + '.' + k };
    }
  }

  return null;
}

// 列出所有「像 KV」的绑定名，仅用于排障输出
function listKvCandidates(context, env) {
  const out = [];
  for (const s of collectSources(context, env)) {
    let keys;
    try { keys = Object.getOwnPropertyNames(s.obj); } catch (e) { continue; }
    for (const k of keys) {
      if (SCAN_SKIP.has(k)) continue;
      let v;
      try { v = s.obj[k]; } catch (e) { continue; }
      if (looksLikeKvNamespace(v)) out.push(s.label + '.' + k);
    }
  }
  return out;
}

// EO_BLOB_BINDING 逃生口：只认显式指定的名字。
// 为什么不做全量扫描：Blob 没有「绑定到变量」这个机制（控制台只读），
// 扫出来的任何东西都只可能是误判 —— 比如某个恰好带 set/get/list 的无关对象。
function detectBlobBinding(context, env) {
  const explicit = env && env.EO_BLOB_BINDING ? String(env.EO_BLOB_BINDING) : '';
  if (!explicit) return null;
  for (const s of collectSources(context, env)) {
    let v;
    try { v = s.obj[explicit]; } catch (e) { continue; }
    if (looksLikeBlobStore(v)) return { store: v, name: s.label + '.' + explicit };
  }
  return null;
}

async function tryCreateBlob(env, context) {
  const consistency = normalizeConsistency(env && env.BLOB_CONSISTENCY);
  const name = String((env && env.EO_BLOB_NAMESPACE) || DEFAULT_BLOB_NAMESPACE);

  // 逃生口：显式注入的 Store 实例（自检 / 本地脚本用）
  const bound = detectBlobBinding(context, env);
  if (bound) {
    lastBlobError = '';
    lastBlobFound = bound.name;
    lastConsistency = consistency;
    return { store: makeBlobBackend(bound.store, { consistency }), name: 'blob(' + bound.name + ')' };
  }
  lastBlobFound = '';

  let mod;
  try {
    // 动态引入：未安装 @edgeone/pages-blob 时不至于让整个函数加载失败
    mod = await import('@edgeone/pages-blob');
  } catch (e) {
    lastBlobError = 'import 失败：' + errText(e);
    return null;
  }
  // 该 SDK 是 CommonJS 产物（module.exports = { getStore, ... }），
  // 在 ESM 下既可能被解析成具名导出，也可能只落在 default 上，两种都兼容。
  const getStore = (mod && typeof mod.getStore === 'function')
    ? mod.getStore
    : (mod && mod.default && typeof mod.default.getStore === 'function' ? mod.default.getStore : null);
  if (!getStore) {
    lastBlobError = '模块已加载但未导出 getStore（请确认依赖版本为 @edgeone/pages-blob）';
    return null;
  }
  try {
    // 用对象形式传 consistency，把一致性设成整个 Store 的默认值
    // （SDK 内部默认是 "eventual"，会导致「刚写完读不到」）。
    // 命名空间名非法时这里会抛 INVALID_STORE_NAME，正好被下面的 catch 收住。
    let store;
    try {
      store = getStore({ name: name, consistency: consistency });
    } catch (e) {
      // PagesBlobError 一定带 code；老版本 SDK 不认识对象形式时抛的是 TypeError（无 code）。
      // 用这个区分「版本不兼容」和「真实的配置/凭证错误」，避免把后者伪装成前者。
      if (e && e.code) throw e;
      store = getStore(name);
    }
    if (!store || typeof store.set !== 'function' || typeof store.list !== 'function') {
      lastBlobError = 'getStore 返回的对象不是预期的 Store';
      return null;
    }
    lastBlobError = '';
    lastConsistency = consistency;
    return { store: makeBlobBackend(store, { consistency }), name: 'blob:' + name };
  } catch (e) {
    lastBlobError = 'getStore 调用失败：' + errText(e)
      + (hintForCode(e && e.code) ? ' —— ' + hintForCode(e && e.code) : '');
    return null;
  }
}

function tryCreateKv(context, env) {
  const found = detectKvBinding(context, env);
  if (!found) return null;
  lastKvFound = found.name;
  return { store: makeKvBackend(found.kv), name: 'kv(' + found.name + ')' };
}

// 解析并返回 R2 兼容存储；不可用时返回 null（调用方会走纯内存降级）
async function resolveStore(context, env) {
  if (cachedStore) return cachedStore;

  const rawMode = String((env && env.STORAGE_BACKEND) || 'blob').trim().toLowerCase();
  const mode = rawMode || 'blob';
  if (mode === 'none') return null;

  // 短负缓存：刚失败过就别每个请求都重试动态引入
  if (lastFailAt && Date.now() - lastFailAt < FAIL_RETRY_MS) return null;

  let picked = null;
  if (mode === 'kv') {
    picked = tryCreateKv(context, env);
  } else if (mode === 'auto') {
    picked = await tryCreateBlob(env, context);
    if (!picked) picked = tryCreateKv(context, env);
  } else {
    // blob，以及任何拼错的取值 —— 都按 Blob 处理。
    // 拼错环境变量时静默退化成内存太难排查，这里宁可继续走默认后端，
    // 同时在 /healthz 的排障输出里把原始取值回显出来。
    picked = await tryCreateBlob(env, context);
  }

  if (!picked) {
    lastFailAt = Date.now();
    return null;
  }

  cachedStore = picked.store;
  cachedBackendName = picked.name;
  lastFailAt = 0;
  return cachedStore;
}

// ============ 自动创建命名空间 ============
// getStore() 只是拿到一个句柄，真正的命名空间创建是**首次写入时**由平台完成的。
// 这有两个问题：创建失败会伪装成「某次聊天保存失败」，而且创建本身要花时间在关键路径上。
// 所以这里在首个请求时异步跑一次「写标记 → 读回校验」：
//   - 不阻塞当前响应（交给 waitUntil 托管）
//   - 把结果缓存在 isolate 里，/healthz 的 debug.provision 直接能看到
//   - 写进去的 __meta__/provision.json 在控制台可见，等于给命名空间盖了个「本项目在用」的戳
// 用 BLOB_AUTOPROVISION=0 可以关掉（例如你不想让冷启动产生任何写操作）。
function ensureProvisioned(env, ctx, store) {
  if (!store) {
    // 存储根本没接通，置备无从谈起。明确标成 unavailable，
    // 避免 /healthz 里出现一个含义模糊的 idle 让人以为「还没开始跑」。
    if (provisionState.state === 'idle') {
      provisionState = {
        state: 'unavailable',
        ok: false,
        at: 0,
        namespace: '',
        error: '存储未接通，无法创建命名空间（见 debug.blobError / debug.hint）',
      };
    }
    return;
  }
  const enabled = String((env && env.BLOB_AUTOPROVISION) || '1') !== '0';
  if (!enabled) {
    if (provisionState.state === 'idle') {
      provisionState = { state: 'disabled', ok: false, at: 0, namespace: '', error: '' };
    }
    return;
  }
  if (provisionInFlight) return;
  if (provisionState.state === 'ready') return;
  if (provisionState.state === 'failed' && Date.now() - provisionLastAttempt < PROVISION_RETRY_MS) return;

  const namespace = String((env && env.EO_BLOB_NAMESPACE) || DEFAULT_BLOB_NAMESPACE);
  provisionLastAttempt = Date.now();
  provisionState = { state: 'pending', ok: false, at: provisionLastAttempt, namespace: namespace, error: '' };

  provisionInFlight = (async () => {
    try {
      const meta = {
        namespace: namespace,
        project: 'edgeone-chat',
        runtime: 'edgeone-cloud-functions',
        provisioned_at: new Date().toISOString(),
      };
      if (typeof store.__markProvisioned === 'function') {
        await store.__markProvisioned(meta);
      } else {
        await store.put(PROVISION_KEY, JSON.stringify(meta));
      }
      // 写完立刻读回：只有读得回来才算「创建并可用」，否则只是「调用没报错」
      const back = await store.get(PROVISION_KEY);
      const ok = !!back;
      provisionState = {
        state: ok ? 'ready' : 'failed',
        ok: ok,
        at: Date.now(),
        namespace: namespace,
        error: ok ? '' : '写入成功但读不回来（一致性或权限问题）',
      };
    } catch (e) {
      provisionState = {
        state: 'failed',
        ok: false,
        at: Date.now(),
        namespace: namespace,
        error: errText(e) + (hintForCode(e && e.code) ? ' —— ' + hintForCode(e && e.code) : ''),
      };
    } finally {
      provisionInFlight = null;
    }
  })();

  // 交给平台托管，避免响应结束后实例被回收、写入被截断
  try {
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(provisionInFlight.catch(function () {}));
    } else {
      provisionInFlight.catch(function () {});
    }
  } catch (e) {
    provisionInFlight.catch(function () {});
  }
}

// 当前生效的存储后端名（供 /healthz 显示）
function activeBackendName() {
  return cachedBackendName;
}

// 排障详情：仅在 STORAGE_DEBUG=1 时由 /healthz 输出
function storageDiagnostics(context, env) {
  const mode = String((env && env.STORAGE_BACKEND) || 'blob').trim().toLowerCase() || 'blob';
  const known = mode === 'blob' || mode === 'kv' || mode === 'auto' || mode === 'none';
  const err = blobLastError();
  const ns = String((env && env.EO_BLOB_NAMESPACE) || DEFAULT_BLOB_NAMESPACE);
  return {
    backend: cachedBackendName || 'memory',
    mode: mode,
    namespace: ns,
    consistency: lastConsistency || normalizeConsistency(env && env.BLOB_CONSISTENCY),
    provision: {
      state: provisionState.state,
      ok: provisionState.ok,
      at: provisionState.at || null,
      namespace: provisionState.namespace || null,
      error: provisionState.error || null,
    },
    blobError: lastBlobError || null,
    blobBindingUsed: lastBlobFound || null,
    kvBindingUsed: lastKvFound || null,
    // 最近一次存储读写错误。上层大多把异常当成「读不到」处理，
    // 于是「配额满了」会伪装成「知识库是空的」—— 这里把它摊开。
    lastStorageError: err
      ? { op: err.op, code: err.code, message: err.message, at: err.at, hint: hintForCode(err.code) }
      : null,
    kvCandidates: listKvCandidates(context, env),
    ...(known ? {} : { warning: 'STORAGE_BACKEND 取值无法识别（' + mode + '），已按默认后端 blob 处理' }),
    hint: cachedBackendName
      ? ''
      : 'Blob 会自动创建命名空间、无需控制台操作（Blob 也没有「绑定」这一步，控制台只读）。'
        + '若 blobError 提示找不到 @edgeone/pages-blob，说明依赖没装上（安装命令需为 npm install）；'
        + '跑在 Edge Functions 上的话 Blob 的 Node.js SDK 不可用，需改用 STORAGE_BACKEND=kv 并在控制台绑定 KV 命名空间。',
  };
}

// 真实读写一次，确认存储不只是「SDK 加载成功」而是「真的能写能读」。
// getStore() 返回对象不代表有权限、有配额，只有写进去再读回来才算数。
async function probeStore() {
  if (!cachedStore) {
    return { ok: false, backend: 'memory', reason: '未接通存储（见 debug.blobError / debug.hint）' };
  }
  if (typeof cachedStore.__probe !== 'function') {
    return { ok: false, backend: cachedBackendName, reason: '该后端不支持自检' };
  }
  try {
    const ok = await cachedStore.__probe();
    return { ok: !!ok, backend: cachedBackendName };
  } catch (e) {
    return { ok: false, backend: cachedBackendName, reason: errText(e) };
  }
}

// 仅供自检脚本使用：等待「自动创建命名空间」这件事落定
function __awaitProvision() {
  return provisionInFlight || Promise.resolve();
}

// 仅供自检脚本使用：清空 isolate 级缓存与探测记录
function __resetForTest() {
  cachedStore = null;
  cachedBackendName = '';
  lastFailAt = 0;
  lastBlobError = '';
  lastBlobFound = '';
  lastKvFound = '';
  lastConsistency = '';
  provisionState = { state: 'idle', ok: false, at: 0, namespace: '', error: '' };
  provisionInFlight = null;
  provisionLastAttempt = 0;
}

export {
  resolveStore,
  ensureProvisioned,
  activeBackendName,
  storageDiagnostics,
  probeStore,
  detectKvBinding,
  detectBlobBinding,
  listKvCandidates,
  looksLikeKvNamespace,
  looksLikeBlobStore,
  __awaitProvision,
  __resetForTest,
  DEFAULT_BLOB_NAMESPACE,
  PROVISION_KEY,
};
