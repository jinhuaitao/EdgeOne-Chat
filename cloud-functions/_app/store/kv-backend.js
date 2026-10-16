// R2 兼容后端 B：EdgeOne KV 存储（备选；仅 Edge Functions 可用，Cloud Functions 不支持）
//
// 仅在你的项目改用 Edge Functions、且不想引入 @edgeone/pages-blob 依赖时使用。
// 通过环境变量 STORAGE_BACKEND=kv 或 EO_KV_BINDING=<绑定变量名> 启用。
//
// ⚠️ KV 与 R2 的语义差距（已在适配层内弥补，但仍有无法消除的差异）：
//   1) key 仅允许 [0-9A-Za-z_] → 本层用十六进制转义（每个字节 → 2 个 hex 字符）保证可逆；
//      代价是 key 变长约 2 倍，且编码后长度不得超过 512 字节（见 MAX_KEY_LEN 守卫）。
//   2) list 单页上限 256 → 本层内部翻页，凑满调用方请求的 limit。
//   3) list 返回 { complete, cursor, keys } 而非 R2 的 { truncated, cursor, objects }。
//   4) 无 size / uploaded → 返回 size:0、uploaded:undefined。
//   5) get 不支持 range → 读全量后切片。
//   6) 最终一致：跨边缘节点最长 60 秒脏读。同节点写入后可立即读到。
//      → 多设备/多节点场景下，刚存的知识库文档可能短暂「列不出来」，属预期行为。

const MAX_KEY_LEN = 512;
const KV_PAGE_MAX = 256;

// 逐字节十六进制编码：全 ASCII、只用 [0-9a-f]，可逆，且天然满足前缀性质
// （encKey('kb/docs/') 一定是 encKey('kb/docs/x.md') 的前缀）
function encKey(s) {
  const bytes = new TextEncoder().encode(String(s));
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function decKey(s) {
  const str = String(s);
  if (str.length % 2 !== 0) return str;
  const bytes = new Uint8Array(str.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(str.substr(i * 2, 2), 16);
  }
  try {
    return new TextDecoder().decode(bytes);
  } catch (e) {
    return str;
  }
}

function makeKvBackend(kv) {
  function toText(value) {
    if (typeof value === 'string') return value;
    if (value == null) return '';
    if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
    if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value);
    return String(value);
  }

  function guard(rawKey) {
    const k = encKey(rawKey);
    if (k.length > MAX_KEY_LEN) {
      throw new Error('KV key 编码后超长（' + k.length + ' > ' + MAX_KEY_LEN +
        ' 字节），原始 key：' + String(rawKey).slice(0, 60) + '… 请改用 Blob 存储后端（STORAGE_BACKEND=blob）。');
    }
    return k;
  }

  // 读/删场景下的宽松守卫：超长 key 在 KV 里必然不存在（因为 put 会拒绝写入），
  // 因此返回 null 让调用方走「不存在」分支即可，不必抛异常打断流程。
  function guardSafe(rawKey) {
    const k = encKey(rawKey);
    return k.length > MAX_KEY_LEN ? null : k;
  }

  return {
    __backend: 'kv',

    async get(key, opts) {
      const safe = guardSafe(key);
      if (safe === null) return null;
      let text;
      try {
        text = await kv.get(safe);
      } catch (e) {
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
      await kv.put(guard(key), toText(value));
    },

    async delete(key) {
      const list = Array.isArray(key) ? key : [key];
      for (const k of list) {
        const safe = guardSafe(k);
        if (safe === null) continue; // 超长 key 不可能存在于 KV 中，跳过即可
        try { await kv.delete(safe); } catch (e) {}
      }
    },

    async list(opts) {
      opts = opts || {};
      const rawPrefix = opts.prefix ? String(opts.prefix) : '';
      const encPrefix = rawPrefix ? encKey(rawPrefix) : '';
      const limit = (typeof opts.limit === 'number' && opts.limit > 0) ? opts.limit : 1000;
      const wantSkip = opts.cursor ? (parseInt(String(opts.cursor), 10) || 0) : 0;

      const keys = [];
      let cursor;
      let complete = false;
      let scanned = 0;
      let stopped = false;
      do {
        let page;
        try {
          page = await kv.list({ prefix: encPrefix, limit: KV_PAGE_MAX, cursor: cursor });
        } catch (e) {
          break;
        }
        const pageKeys = (page && Array.isArray(page.keys)) ? page.keys : [];
        for (const item of pageKeys) {
          scanned++;
          if (scanned <= wantSkip) continue;
          if (keys.length >= limit) { stopped = true; break; }
          keys.push(item.key);
        }
        complete = !page || page.complete === true || !page.cursor;
        cursor = page ? page.cursor : undefined;
        if (stopped || complete) break;
      } while (cursor);

      // 两种情况都算「还有下一页」：
      //   stopped —— 是因为凑满 limit 主动停的，后面必然还有没取的对象
      //   !complete —— KV 自己的分页还没走完
      const truncated = stopped || !complete;
      const next = wantSkip + keys.length;

      return {
        objects: keys.map(k => ({ key: decKey(k), size: 0, uploaded: undefined })),
        truncated,
        cursor: truncated ? String(next) : undefined,
      };
    },

    async __probe() {
      const k = '__probe__/' + Date.now().toString(36);
      await kv.put(guard(k), 'ok');
      const v = await kv.get(guard(k));
      await kv.delete(guard(k));
      return v === 'ok';
    },
  };
}

export { makeKvBackend, encKey, decKey };
