// R2 兼容后端 A：EdgeOne Blob 存储（@edgeone/pages-blob，Cloud Functions / Node.js 运行时）
//
// 为什么用 Blob 而不是 KV：
//   1) Blob 的 key 支持 "/" 与中文，本项目的 key 形如 kb/docs/甲骨文ARM.md、kb/mem/web_xxx/1a2b.md，
//      在 KV 上（key 仅允许数字/字母/下划线）会直接非法；
//   2) Blob 支持 prefix 列举与强一致读，与 R2 语义最接近；
//   3) Blob 无 512B key 长度焦虑；
//   4) Blob 的命名空间**自动创建**，控制台零操作。
//
// 与 R2 的差异及弥补方式：
//   - store.delete 只接受单个 key → 本适配层对数组做循环删除（与 R2 的批量删除行为对齐）
//   - store.list 不返回 size / uploaded → 返回 size:0、uploaded:undefined。
//     影响面仅限「控制台展示体积」一处：kb/registry.js 里 size 走 `o.size || 0`，
//     updated_at 优先取 frontmatter 的 saved_at，因此文档日期仍然正确。
//     想拿真实体积只能用 store.getMetadata(key)（不下载正文，但仍是每 key 一次请求）。
//   - store.get 不支持 range → 读全量后按 offset/length 切片（本项目仅用于读 frontmatter 前 4096 字节）
//   - store.list 默认自动聚合全部分页 → 本适配层用「聚合后内存切片」模拟 R2 的 cursor/truncated 语义
//   - **读取一致性 SDK 默认是 eventual** → 本层显式指定（见下方 READ_CONSISTENCY 说明）
//
// ============ 关于一致性（重要，曾是个真 bug） ============
// SDK 的 Store 默认一致性是 "eventual"：走 CDN 缓存域，写入后要「通常秒级」才能在所有节点读到。
// 对本项目这意味着两处用户可见的故障：
//   1) 刚写进长期记忆 / 知识库的内容，紧接着的检索查不到（表现为随机「失忆」）；
//   2) 生图转存后返回 /api/img/<id>，浏览器立刻去取时可能 404（表现为图片裂开）。
// 因此本层默认改用 "strong"（跳过缓存直读主存储，略慢但可预期）。
// 需要极致读取延迟、且能容忍短暂不一致的场景，设 BLOB_CONSISTENCY=eventual 换速度。

const LIST_FETCH_CAP = 5000; // 单次 list 聚合的对象上限，防极端情况拖垮函数

function normalizeConsistency(v) {
  return String(v == null ? '' : v).trim().toLowerCase() === 'eventual' ? 'eventual' : 'strong';
}

// 最近一次存储操作错误。SDK 抛的是带 code 的 PagesBlobError，
// 但上层（kb/registry.js 等）大多把异常当成「读不到」处理 —— 于是「配额满了」会伪装成
// 「知识库是空的」。这里把错误记下来交给 /healthz 暴露，既不改上层行为，又能被看见。
let lastError = null;

function noteError(op, e) {
  lastError = {
    op: op,
    code: (e && e.code) ? String(e.code) : '',
    message: (e && e.message) ? String(e.message).slice(0, 300) : String(e).slice(0, 300),
    at: Date.now(),
  };
}

function blobLastError() { return lastError; }
function clearBlobError() { lastError = null; }

// SDK 错误码 → 可操作的中文提示。/healthz 会带上这个，省得对着 QUOTA_EXCEEDED 发愣。
const CODE_HINT = {
  QUOTA_EXCEEDED: 'Blob 容量已满（免费版单账户 1GB）。清理无用对象或升级套餐。',
  RATE_LIMITED: 'Blob 请求被限流。稍后重试；若持续出现，检查是否有循环内高频读写。',
  MISSING_ENVIRONMENT: '函数不在 Makers 环境中，且未提供 { projectId, token }。',
  MISSING_PROJECT_ID: 'token 模式下缺少 projectId。',
  CREDENTIAL_ERROR: '凭证换取失败。API Token 可能已失效，或项目 ID 不对。',
  INVALID_STORE_NAME: '命名空间名非法：只允许字母/数字/下划线/连字符，且 UTF-8 不超过 64 字节。',
  INVALID_KEY: '对象 key 非法。',
  COS_ERROR: '底层对象存储返回错误，详见 message。',
};

function hintForCode(code) {
  return CODE_HINT[code] || '';
}

function makeBlobBackend(store, options) {
  const consistency = normalizeConsistency(options && options.consistency);
  const readOpts = { consistency: consistency };

  // 统一把 value 归一化成字符串：本项目所有持久化数据都是 JSON 或 Markdown 文本
  function toText(value) {
    if (typeof value === 'string') return value;
    if (value == null) return '';
    if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
    if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value);
    return String(value);
  }

  return {
    __backend: 'blob',
    __consistency: consistency,

    // get(key) | get(key, { range: { offset, length } })
    // 返回 R2Object 的等价物：{ text(), json(), arrayBuffer(), size }
    async get(key, opts) {
      let text;
      try {
        // 显式带 consistency：SDK 默认 eventual 会让「刚写完就读」读到旧值
        text = await store.get(String(key), readOpts);
      } catch (e) {
        noteError('get', e);
        return null;
      }
      if (text === null || text === undefined) return null;
      const full = toText(text);
      const range = opts && opts.range;
      const sliced = (range && typeof range.offset === 'number')
        ? full.slice(range.offset, range.offset + (typeof range.length === 'number' ? range.length : undefined))
        : full;
      return {
        size: full.length,
        async text() { return sliced; },
        async json() { return JSON.parse(sliced); },
        async arrayBuffer() { return new TextEncoder().encode(sliced).buffer; },
      };
    },

    async put(key, value) {
      try {
        await store.set(String(key), toText(value));
      } catch (e) {
        // 写失败必须让上层知道（丢了数据比报错严重得多），所以这里记录后继续抛出
        noteError('put', e);
        throw e;
      }
    },

    // delete(key) | delete([key, key, ...]) —— 对齐 R2 的批量删除
    async delete(key) {
      if (Array.isArray(key)) {
        for (const k of key) {
          try { await store.delete(String(k)); } catch (e) { noteError('delete', e); }
        }
        return;
      }
      try {
        await store.delete(String(key));
      } catch (e) {
        noteError('delete', e);
      }
    },

    // list({ prefix, limit, cursor }) → { objects: [{ key, size, uploaded }], truncated, cursor }
    async list(opts) {
      opts = opts || {};
      const prefix = opts.prefix ? String(opts.prefix) : '';
      const limit = (typeof opts.limit === 'number' && opts.limit > 0) ? opts.limit : 1000;
      const start = opts.cursor ? (parseInt(String(opts.cursor), 10) || 0) : 0;

      let blobs = [];
      try {
        // 强一致：避免刚写入的知识库文档在列不出来（Blob 默认最终一致，边缘缓存有秒级延迟）
        const r = await store.list({ prefix, consistency: consistency });
        blobs = (r && Array.isArray(r.blobs)) ? r.blobs : [];
      } catch (e) {
        noteError('list', e);
        blobs = [];
      }

      if (blobs.length > LIST_FETCH_CAP) blobs = blobs.slice(0, LIST_FETCH_CAP);
      // Blob 返回顺序不保证稳定，按 key 字典序排序，保证 cursor 切片在多次调用间一致
      blobs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

      const page = blobs.slice(start, start + limit);
      const next = start + page.length;
      const truncated = next < blobs.length;

      return {
        objects: page.map(b => ({ key: b.key, size: 0, uploaded: undefined, etag: b.etag })),
        truncated,
        cursor: truncated ? String(next) : undefined,
      };
    },

    // 非 R2 标准接口，仅用于健康检查/自检
    async __probe() {
      const k = '__probe__/' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      try {
        await store.set(k, 'ok');
        const v = await store.get(k, readOpts);
        await store.delete(k);
        return v === 'ok';
      } catch (e) {
        noteError('probe', e);
        throw e;
      }
    },

    // 置备标记：写入一个带时间戳的小对象，用来强制平台创建命名空间，
    // 并给「这个命名空间是本项目在用」留下可见痕迹（控制台只读，能看到这个对象）。
    // 这里也要记错误：置备失败若不记录，线上就只剩「存储是 memory」这一个模糊现象。
    async __markProvisioned(meta) {
      try {
        await store.setJSON('__meta__/provision.json', meta);
      } catch (e) {
        noteError('provision', e);
        throw e;
      }
    },
  };
}

export {
  makeBlobBackend,
  normalizeConsistency,
  blobLastError,
  clearBlobError,
  hintForCode,
};
