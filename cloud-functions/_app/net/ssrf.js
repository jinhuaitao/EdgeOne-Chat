// SSRF 防护：拦截内网 / 本机 / 云元数据地址（_worker.js 原第 532-587 行）

// ==================== SSRF 防护（v6.8.1，v6.8.6/v6.9.5 加固） ====================
// web_fetch 的目标 URL 来自模型输出（可被用户 prompt 间接操控），必须拦截
// 内网 / 本机 / 云元数据地址，防止 Worker 被当成代理去探测内网或借出口 IP 攻击第三方。
// Workers 拿不到底层 DNS，做多层拦截：
//  1) 字面量私网与保留 IP —— WHATWG URL 解析会自动把十进制/十六进制/八进制写法归一化为
//     点分十进制（如 http://2130706433/ → 127.0.0.1、http://0x7f.0.0.1/ → 127.0.0.1），
//     因此只需判断归一化后的 hostname；
//  2) FQDN 尾点 —— localhost. / 127.0.0.1. 与不带点的写法等价，先剥掉（v6.8.6）；
//  3) IPv6 —— 按规范展开成 8 组再判，覆盖 IPv4 映射地址的十六进制压缩写法（v6.8.6）；
//  4) 危险主机名（localhost、各类云元数据服务域名）。
// 重定向不在此层处理：web_fetch 手动逐跳跟随，每跳都过本函数。
// 残余风险：DNS 重绑定（域名先解析到公网、TTL 过期后指向内网）。Workers 无法在建连时
// 做二次校验，如需彻底封堵请在前置 WAF / 出站代理层限制。

// 把 IPv6 文本展开为 8 组 4 位十六进制；非法返回 null。
function expandIPv6Groups(h6) {
  const s = String(h6 || '');
  if (!/^[0-9a-fA-F:.]+$/.test(s)) return null;
  const halves = s.split('::');
  let head, tail;
  if (halves.length === 2) {
    head = halves[0] === '' ? [] : halves[0].split(':');
    tail = halves[1] === '' ? [] : halves[1].split(':');
  } else if (halves.length === 1) {
    head = s.split(':');
    tail = [];
  } else {
    return null; // 多于一个 ::
  }
  const all = head.concat(tail);
  if (all.length > 8) return null;
  for (const g of all) if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
  const fill = 8 - all.length;
  if (halves.length === 1 && fill !== 0) return null; // 无 :: 必须恰好 8 组
  const groups = [];
  for (const g of head) groups.push(g);
  for (let i = 0; i < fill; i++) groups.push('0');
  for (const g of tail) groups.push(g);
  return groups.map(g => g.toLowerCase().padStart(4, '0'));
}

function isBlockedFetchHost(hostname) {
  // v6.8.6：先剥 FQDN 尾点 —— "localhost." 与 "localhost"、"127.0.0.1." 与 "127.0.0.1"
  // 在 DNS 上等价，不剥掉就能绕过黑名单
  const h = String(hostname || '').toLowerCase().replace(/\.+$/, '');
  if (!h) return true;
  // —— 危险主机名 ——
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === 'metadata.google.internal' || h.endsWith('.metadata.google.internal')) return true;
  if (h === 'instance-data' || h === 'instance-data.compute.internal') return true;
  if (h === 'metadata.azure.internal' || h === 'metadata') return true;
  if (h === 'metadata.tencentyun.com' || h === 'metadata.alibaba.internal') return true;
  if (h === '169.254.169.254.nip.io' || h.endsWith('.169.254.169.254.nip.io')) return true;
  // —— IPv4 私网与保留段 ——
  // v6.8.9：容忍 1~4 段的 IPv4 简写（127.1 = 127.0.0.1、2130706433 = 127.0.0.1）。
  if (/^\d+(\.\d+){0,3}$/.test(h)) {
    const parts = h.split('.').map(Number);
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i] > 255) return true; // 越界宁可拦截
    }
    const bytes = parts.slice(0, parts.length - 1);
    const span = 4 - bytes.length;
    const last = parts[parts.length - 1];
    if (last >= Math.pow(256, span)) return true; // 末段越界，宁可拦截
    for (let k = span - 1; k >= 0; k--) bytes.push((last >>> (8 * k)) & 255);
    const b = bytes;
    if (b[0] === 10) return true;                                  // 10.0.0.0/8
    if (b[0] === 127) return true;                                 // 127.0.0.0/8 回环
    if (b[0] === 169 && b[1] === 254) return true;                 // 169.254.0.0/16（含云元数据）
    if (b[0] === 172 && b[1] >= 16 && b[1] <= 31) return true;     // 172.16.0.0/12
    if (b[0] === 192 && b[1] === 168) return true;                 // 192.168.0.0/16
    if (b[0] === 0) return true;                                   // 0.0.0.0/8
    if (b[0] === 100 && b[1] >= 64 && b[1] <= 127) return true;    // 100.64.0.0/10 CGNAT / 阿里云元数据
    if (b[0] === 192 && b[1] === 0 && b[2] === 0) return true;     // 192.0.0.0/24 IETF 协议保留（v6.9.5）
    if (b[0] === 192 && b[1] === 0 && b[2] === 2) return true;     // TEST-NET-1
    if (b[0] === 198 && (b[1] === 18 || b[1] === 19)) return true; // 198.18.0.0/15 基准测试 / 代理保留（v6.9.5）
    if (b[0] === 198 && b[1] === 51 && b[2] === 100) return true;  // TEST-NET-2
    if (b[0] === 203 && b[1] === 0 && b[2] === 113) return true;   // TEST-NET-3
    if (b[0] >= 224) return true;                                  // 224.0.0.0/4 组播 + 240.0.0.0/4 保留与广播（v6.9.5）
    return false;
  }
  // —— IPv6（hostname 可能带方括号） ——
  const h6 = h.replace(/^\[|\]$/g, '');
  if (h6.indexOf(':') !== -1) {
    // 内嵌点分十进制的 IPv4 映射地址，如 ::ffff:127.0.0.1 → 按 IPv4 再判一次
    const tail = h6.slice(h6.lastIndexOf(':') + 1);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) return isBlockedFetchHost(tail);
    // v6.8.6：按规范展开成 8 组再判，压缩组补零后映射地址不再漏判
    const groups = expandIPv6Groups(h6);
    if (!groups) return true; // 解析失败的地址按危险处理，宁可拦截
    const allZero = (from, to) => groups.slice(from, to).every(g => g === '0000');
    const g0 = parseInt(groups[0], 16);
    const tailAsV4 = () => [parseInt(groups[6].slice(0, 2), 16), parseInt(groups[6].slice(2, 4), 16),
      parseInt(groups[7].slice(0, 2), 16), parseInt(groups[7].slice(2, 4), 16)].join('.');
    // :: 未指定地址 / ::1 回环
    if (g0 === 0 && allZero(1, 7) && (groups[7] === '0000' || groups[7] === '0001')) return true;
    // ::ffff:0:0/96 IPv4 映射地址 & ::ffff:0:0:0/96 SIIT 转换地址
    if (g0 === 0 && allZero(1, 5) && groups[5] === 'ffff') return isBlockedFetchHost(tailAsV4());
    if (g0 === 0 && allZero(1, 4) && groups[4] === 'ffff' && groups[5] === '0000') return isBlockedFetchHost(tailAsV4());
    // 64:ff9b::/96 NAT64（同样可携带 IPv4 目标）
    if (groups[0] === '0064' && groups[1] === 'ff9b' && allZero(2, 6)) return isBlockedFetchHost(tailAsV4());
    // 100::/64 丢弃前缀 & 2001:db8::/32 文档专用前缀（v6.9.5）
    if (groups[0] === '0100' && allZero(1, 4)) return true;
    if (groups[0] === '2001' && groups[1] === '0db8') return true;
    if (g0 >= 0xfe80 && g0 <= 0xfebf) return true;   // fe80::/10 链路本地
    if ((g0 & 0xfe00) === 0xfc00) return true;       // fc00::/7 唯一本地
    if (g0 >= 0xff00) return true;                   // ff00::/8 组播地址（v6.9.5）
    return false;
  }
  return false;
}

export {
  isBlockedFetchHost,
  expandIPv6Groups,
};
