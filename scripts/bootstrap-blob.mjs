#!/usr/bin/env node
// Blob 命名空间预创建 / 就绪检查脚本
//
// 背景：@edgeone/pages-blob 的 getStore("name") 会在**首次写入时**由平台自动创建命名空间。
// 也就是说「自动创建」本来就有，但发生在第一个真实用户请求里 —— 创建失败会被伪装成
// 「某次聊天保存失败」，而且创建耗时落在关键路径上。
//
// 这个脚本用 SDK 的 token 模式（{ projectId, token }）在**部署前/CI 里**就把命名空间建好并验证，
// 于是线上第一个请求面对的是一个已存在的命名空间。
//
// 用法：
//   EO_PROJECT_ID=pages-xxxxxxxx EO_API_TOKEN=xxx node scripts/bootstrap-blob.mjs
//   node scripts/bootstrap-blob.mjs --project-id pages-xxxxxxxx --token xxx --namespace edgeone-chat
//   node scripts/bootstrap-blob.mjs --check          # 只检查，不创建
//   node scripts/bootstrap-blob.mjs --help
//
// 参数（命令行优先于环境变量）：
//   --project-id <id>    EdgeOne Makers 项目 ID（形如 pages-urtsvuwmfvli）。也可用 EO_PROJECT_ID
//   --token <token>      API Token（控制台「API Token」页面生成）。也可用 EO_API_TOKEN
//   --namespace <name>   Blob 命名空间名，默认 edgeone-chat。也可用 EO_BLOB_NAMESPACE
//   --check              只报告状态，不创建
//   --json               以 JSON 输出（便于 CI 解析）
//
// 退出码：0 = 就绪；1 = 失败；2 = 用法/配置错误

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const MARKER_KEY = '__meta__/provision.json';

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const out = { check: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--project-id') out.projectId = argv[++i];
    else if (a === '--token') out.token = argv[++i];
    else if (a === '--namespace') out.namespace = argv[++i];
    else if (a.startsWith('--project-id=')) out.projectId = a.slice('--project-id='.length);
    else if (a.startsWith('--token=')) out.token = a.slice('--token='.length);
    else if (a.startsWith('--namespace=')) out.namespace = a.slice('--namespace='.length);
    else if (a !== '') out.unknown = (out.unknown || []).concat([a]);
  }
  return out;
}

const USAGE = `
Blob 命名空间预创建 / 就绪检查

  node scripts/bootstrap-blob.mjs --project-id <id> --token <token> [--namespace <name>]
  node scripts/bootstrap-blob.mjs --check
  node scripts/bootstrap-blob.mjs --help

参数：
  --project-id <id>   EdgeOne Makers 项目 ID（形如 pages-urtsvuwmfvli），或环境变量 EO_PROJECT_ID
  --token <token>     API Token，或环境变量 EO_API_TOKEN
  --namespace <name>  Blob 命名空间名，默认 edgeone-chat，或环境变量 EO_BLOB_NAMESPACE
  --check             只报告状态，不创建
  --json              以 JSON 输出

退出码：0 = 就绪；1 = 失败；2 = 用法/配置错误
`;

const args = parseArgs(process.argv.slice(2));

function fail(msg, code) {
  if (args.json) {
    console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  } else {
    console.error('\n  ✗ ' + msg + '\n');
  }
  process.exit(code || 1);
}

if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
if (args.unknown && args.unknown.length) {
  console.error(USAGE);
  fail('无法识别的参数：' + args.unknown.join(' '), 2);
}

const projectId = args.projectId || process.env.EO_PROJECT_ID || '';
const token = args.token || process.env.EO_API_TOKEN || '';
const namespace = args.namespace || process.env.EO_BLOB_NAMESPACE || 'edgeone-chat';

if (!projectId) {
  console.error(USAGE);
  fail('缺少项目 ID：用 --project-id 或环境变量 EO_PROJECT_ID 提供（控制台项目概览里可复制）', 2);
}
if (!token && !args.check) {
  console.error(USAGE);
  fail('缺少 API Token：用 --token 或环境变量 EO_API_TOKEN 提供（控制台「API Token」页面生成）', 2);
}

// ---------- 载入 SDK ----------
// 用 createRequire 从项目根目录解析，保证拿到的是 package.json 里声明的那份依赖。
const require = createRequire(join(ROOT, 'package.json'));
let sdk;
try {
  sdk = require('@edgeone/pages-blob');
} catch (e) {
  fail(
    '加载 @edgeone/pages-blob 失败：' + (e && e.message ? e.message : String(e)) + '\n' +
    '    请先在项目根目录执行 npm install。\n' +
    '    目录：' + ROOT
  );
}
const getStore = sdk && sdk.getStore;
const listStores = sdk && sdk.listStores;
if (typeof getStore !== 'function' || typeof listStores !== 'function') {
  fail('@edgeone/pages-blob 未导出 getStore / listStores，请确认版本（当前项目要求 ^0.0.18）');
}

// ---------- 工具 ----------
function log(msg) { if (!args.json) console.log(msg); }

function humanErr(e) {
  const code = (e && e.code) ? e.code : '';
  const msg = (e && e.message) ? e.message : String(e);
  const hints = {
    MISSING_PROJECT_ID: 'token 模式下必须同时提供 projectId 与 token。',
    MISSING_ENVIRONMENT: '缺少 token：外部访问必须显式提供 { projectId, token }。',
    CREDENTIAL_ERROR: '凭证换取失败：API Token 可能已失效，或 projectId 不属于该 Token。',
    INVALID_STORE_NAME: '命名空间名非法：只允许字母/数字/下划线/连字符，UTF-8 不超过 64 字节。',
    QUOTA_EXCEEDED: 'Blob 容量已满（免费版单账户 1GB）。',
    RATE_LIMITED: '请求被限流，稍后重试。',
    COS_ERROR: '底层对象存储返回错误。',
  };
  return { code: code, message: msg, hint: hints[code] || '' };
}

// ---------- 主流程 ----------
async function main() {
  log('');
  log('  Blob 命名空间预创建');
  log('  ─────────────────────────────────────────────');
  log('  项目 ID    : ' + projectId);
  log('  命名空间   : ' + namespace);
  log('  模式       : ' + (args.check ? '只检查（--check）' : '检查并在缺失时创建'));
  log('');

  const report = {
    ok: false,
    projectId: projectId,
    namespace: namespace,
    existed: false,
    created: false,
    verified: false,
    checkOnly: !!args.check,
  };

  // 1) 列出当前项目的命名空间
  let names = [];
  try {
    const r = await listStores({ projectId: projectId, token: token, consistency: 'strong' });
    names = (r && Array.isArray(r.stores)) ? r.stores.map(function (s) { return s.name; }) : [];
  } catch (e) {
    const h = humanErr(e);
    report.error = h;
    if (args.json) { console.log(JSON.stringify(report, null, 2)); process.exit(1); }
    console.error('\n  ✗ 列举命名空间失败：' + h.message);
    if (h.code) console.error('    错误码：' + h.code);
    if (h.hint) console.error('    处理：' + h.hint);
    console.error('    （若提示凭证问题，请确认 API Token 未过期、且 projectId 正确）\n');
    process.exit(1);
  }

  report.existingNamespaces = names;
  report.existed = names.indexOf(namespace) !== -1;

  log('  现有命名空间 (' + names.length + ')：' + (names.length ? names.join(', ') : '（无）'));
  log('  目标命名空间是否存在：' + (report.existed ? '是' : '否'));
  log('');

  // 2) 缺失则创建
  if (!report.existed) {
    if (args.check) {
      report.ok = false;
      report.error = { message: '命名空间不存在（--check 模式不做创建）' };
      if (args.json) { console.log(JSON.stringify(report, null, 2)); process.exit(1); }
      console.error('  ✗ 命名空间「' + namespace + '」不存在。去掉 --check 重跑即可创建。\n');
      process.exit(1);
    }
    log('  → 正在创建…（通过写入一个标记对象触发平台创建命名空间）');
    const store = getStore({ name: namespace, projectId: projectId, token: token, consistency: 'strong' });
    try {
      await store.setJSON(MARKER_KEY, {
        namespace: namespace,
        project: 'edgeone-chat',
        provisioned_at: new Date().toISOString(),
        provisioned_by: 'scripts/bootstrap-blob.mjs',
      });
    } catch (e) {
      const h = humanErr(e);
      report.error = h;
      if (args.json) { console.log(JSON.stringify(report, null, 2)); process.exit(1); }
      console.error('\n  ✗ 创建失败：' + h.message);
      if (h.code) console.error('    错误码：' + h.code);
      if (h.hint) console.error('    处理：' + h.hint);
      console.error('');
      process.exit(1);
    }
    report.created = true;
    log('  → 已写入标记对象 ' + MARKER_KEY);
  }

  // 3) 读回校验：写成功不等于读得回来（一致性/权限都可能出问题）
  log('  → 校验读写…');
  const store = getStore({ name: namespace, projectId: projectId, token: token, consistency: 'strong' });
  let marker = null;
  try {
    marker = await store.get(MARKER_KEY, { type: 'json' });
  } catch (e) {
    const h = humanErr(e);
    report.error = h;
    if (args.json) { console.log(JSON.stringify(report, null, 2)); process.exit(1); }
    console.error('\n  ✗ 读取标记对象失败：' + h.message + '\n');
    process.exit(1);
  }

  if (marker) {
    report.verified = true;
    report.ok = true;
    log('  → 读回成功：' + JSON.stringify(marker));
  } else {
    // 标记不存在不一定是故障：可能是你手动清理过。再确认一次命名空间列表。
    report.verified = false;
    log('  → 标记对象不存在（可能被手动清理过）');
  }

  // 4) 再列一次，确认命名空间真的出现了
  let names2 = [];
  try {
    const r2 = await listStores({ projectId: projectId, token: token, consistency: 'strong' });
    names2 = (r2 && Array.isArray(r2.stores)) ? r2.stores.map(function (s) { return s.name; }) : [];
  } catch (e) { /* 上一步已经能读，这里失败不致命 */ }
  report.existingNamespaces = names2;
  report.existed = names2.indexOf(namespace) !== -1;

  if (!report.existed) {
    report.ok = false;
    report.error = {
      message: '写入后命名空间仍未出现在列表中。可能原因：token 模式无创建权限，'
        + '或创建是异步的（稍等片刻重试）。兜底方案：先部署项目并触发一次请求，'
        + '函数内的 ensureProvisioned() 会在 Makers 环境里完成创建。',
    };
    if (args.json) { console.log(JSON.stringify(report, null, 2)); process.exit(1); }
    console.error('\n  ✗ 命名空间「' + namespace + '」写入后仍未出现。');
    console.error('    token 模式可能没有创建权限。兜底方案：');
    console.error('      1) 先正常部署项目；');
    console.error('      2) 访问一次 /healthz 触发请求 —— 函数内的 ensureProvisioned()');
    console.error('         会在 Makers 环境里自动创建命名空间；');
    console.error('      3) 再看 /healthz?probe=1（需 STORAGE_DEBUG=1）确认 debug.provision.ok 为 true。\n');
    process.exit(1);
  }

  report.ok = true;

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    log('');
    log('  ─────────────────────────────────────────────');
    log('  ✓ 命名空间「' + namespace + '」已就绪');
    log('    存在：是  |  本次创建：' + (report.created ? '是' : '否') + '  |  读写校验：' + (report.verified ? '通过' : '跳过'));
    log('');
    log('  下一步：正常部署项目。函数启动时会自动复用这个命名空间，');
    log('  部署后访问 /healthz 应看到 storage 为 blob:' + namespace + '。');
    log('');
  }
  process.exit(0);
}

// 项目里没有 node_modules 时给一句更直白的提示
if (!existsSync(join(ROOT, 'node_modules'))) {
  if (!args.json) {
    console.log('');
    console.log('  提示：' + ROOT + '/node_modules 不存在，将尝试加载全局或上级依赖。');
  }
}

main().catch(function (e) {
  fail('脚本自身异常：' + (e && e.stack ? e.stack : String(e)), 1);
});
