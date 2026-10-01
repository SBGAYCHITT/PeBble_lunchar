#!/usr/bin/env node
/**
 * 代码签名工具 —— 给 dist 产物打 Authenticode 签名。
 *
 * 为什么需要它：Smart App Control（本机是 On）只放行「已用受信任 CA 证书签名」的应用，
 * 未签名的 exe/dll 会直接被拒，且 SAC 没有任何「仍要运行」的绕过入口。
 *
 * 一个容易忽略的点：Electron 官方发布的 electron.exe 和它那几个 dll **本身就是未签名的**，
 * 所以打包产物里除了我们自己的 exe，还有 5 个未签名的 Electron dll（d3dcompiler_47.dll 是
 * 微软签的，不用管）。只签主 exe 有可能不够，本工具默认把它们一起签掉。
 *
 * 用法（证书来源按优先级自动探测）：
 *   node scripts/sign.js                      # 探测环境变量/开发证书
 *   node scripts/sign.js --pfx my.pfx --password ***
 *   node scripts/sign.js --thumbprint A1B2... # 证书在存储里（USB token / 云 HSM）
 *   node scripts/sign.js --dev                # 用 scripts/dev-cert.ps1 生成的开发证书
 *   node scripts/sign.js --azure              # Azure 工件签名（需 dotnet sign CLI）
 *
 * 可选：--targets a.exe,b.exe  指定文件；--force 已签名的也重签；--dry 只打印计划；
 *       --strict 没有可用证书时以失败退出（默认是「跳过并退出 0」，免得打包流程被卡死）。
 *
 * 环境变量：SIGNTOOL / SIGN_PFX / SIGN_PFX_PASSWORD / SIGN_THUMBPRINT / SIGN_TIMESTAMP_URL
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const UNPACKED = path.join(DIST, 'win-unpacked');
const OUTER_EXE = path.join(DIST, 'Pebble-Lunchar.exe');
const SIGNING_DIR = path.join(ROOT, '.signing');
const DEV_THUMB_FILE = path.join(SIGNING_DIR, 'dev-thumbprint.txt');

/** 时间戳服务器（RFC 3161）。国内网络下 digicert 偶发超时，按顺序回退。 */
const TS_SERVERS = (process.env.SIGN_TIMESTAMP_URL ? [process.env.SIGN_TIMESTAMP_URL] : [
  'http://timestamp.digicert.com',
  'http://timestamp.sectigo.com',
  'http://timestamp.globalsign.com/tsa/r6advanced1',
  'http://tsa.starfieldtech.com',
]);

const DESCRIPTION = 'Pebble Lunchar';

// 本机沙箱（以及某些受控环境）会拒绝为子进程创建 stdin 管道，导致 spawnSync 直接 EBUSY。
// 统一显式声明 stdio：stdin 走 NUL，stdout/stderr 走管道。
const STDIO = ['ignore', 'pipe', 'pipe'];

/* ---------------- 参数 ---------------- */
function parseArgs(argv) {
  const out = { targets: [], force: false, dry: false, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pfx') out.pfx = argv[++i];
    else if (a === '--password') out.password = argv[++i];
    else if (a === '--thumbprint') out.thumbprint = argv[++i];
    else if (a === '--targets') out.targets = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--dev') out.dev = true;
    else if (a === '--azure') out.azure = true;
    else if (a === '--force') out.force = true;
    else if (a === '--dry') out.dry = true;
    else if (a === '--strict') out.strict = true;
  }
  return out;
}

/* ---------------- 找 signtool ---------------- */
function cmpVer(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function findSigntool() {
  if (process.env.SIGNTOOL && fs.existsSync(process.env.SIGNTOOL)) return process.env.SIGNTOOL;
  const bases = [
    'C:\\Program Files (x86)\\Windows Kits\\10\\bin',
    'C:\\Program Files\\Windows Kits\\10\\bin',
  ];
  const found = [];
  for (const base of bases) {
    let vers = [];
    try { vers = fs.readdirSync(base); } catch { continue; }
    for (const v of vers) {
      for (const arch of ['x64', 'x86']) {
        const p = path.join(base, v, arch, 'signtool.exe');
        if (fs.existsSync(p)) { found.push({ p, v }); break; }
      }
    }
  }
  if (found.length) {
    found.sort((a, b) => cmpVer(b.v, a.v));
    return found[0].p;
  }
  const r = spawnSync('where', ['signtool.exe'], { encoding: 'utf8', stdio: STDIO, shell: true });
  if (r.status === 0 && String(r.stdout).trim()) return String(r.stdout).trim().split(/\r?\n/)[0].trim();
  return null;
}

/* ---------------- 证书来源 ---------------- */
function resolveCert(args) {
  if (args.pfx) return { kind: 'pfx', file: path.resolve(args.pfx), password: args.password || '' };
  if (args.thumbprint) return { kind: 'thumbprint', thumbprint: normThumb(args.thumbprint) };
  if (args.azure) return { kind: 'azure' };
  if (args.dev) {
    if (!fs.existsSync(DEV_THUMB_FILE)) return null;
    const t = fs.readFileSync(DEV_THUMB_FILE, 'utf8').trim();
    return t ? { kind: 'thumbprint', thumbprint: normThumb(t), dev: true } : null;
  }
  // 环境变量
  if (process.env.SIGN_PFX) {
    return { kind: 'pfx', file: path.resolve(process.env.SIGN_PFX), password: process.env.SIGN_PFX_PASSWORD || '' };
  }
  if (process.env.SIGN_THUMBPRINT) {
    return { kind: 'thumbprint', thumbprint: normThumb(process.env.SIGN_THUMBPRINT) };
  }
  // 兜底：之前生成过开发证书
  if (fs.existsSync(DEV_THUMB_FILE)) {
    const t = fs.readFileSync(DEV_THUMB_FILE, 'utf8').trim();
    if (t) return { kind: 'thumbprint', thumbprint: normThumb(t), dev: true };
  }
  return null;
}

function normThumb(s) {
  return String(s).replace(/[^0-9a-fA-F]/g, '').toUpperCase();
}

/* ---------------- 目标 ---------------- */
function collectTargets(args) {
  if (args.targets.length) return args.targets.map((p) => path.resolve(p));
  const list = [];
  if (fs.existsSync(UNPACKED)) {
    for (const f of fs.readdirSync(UNPACKED)) {
      if (/\.(exe|dll)$/i.test(f)) list.push(path.join(UNPACKED, f));
    }
  }
  if (fs.existsSync(OUTER_EXE)) list.push(OUTER_EXE);
  return list;
}

/* ---------------- 签名/校验 ---------------- */
function hasValidSignature(signtool, file) {
  const r = spawnSync(signtool, ['verify', '/pa', '/q', file], { encoding: 'utf8', stdio: STDIO });
  return r.status === 0;
}

function signArgs(cert, tsUrl) {
  const a = ['sign', '/fd', 'sha256', '/d', DESCRIPTION];
  if (tsUrl) a.push('/td', 'sha256', '/tr', tsUrl);
  if (cert.kind === 'pfx') {
    a.push('/f', cert.file);
    if (cert.password) a.push('/p', cert.password);
  } else if (cert.kind === 'thumbprint') {
    a.push('/sha1', cert.thumbprint);
  }
  return a;
}

/**
 * 先带时间戳签；时间戳服务器连不上就退回不带时间戳（仍能签，只是证书过期后签名会失效）。
 * 返回 { ok, note }
 */
function signFile(signtool, cert, file, log) {
  if (cert.kind === 'azure') return signFileAzure(file, log);
  for (let i = 0; i <= TS_SERVERS.length; i++) {
    const ts = i < TS_SERVERS.length ? TS_SERVERS[i] : null;
    const args = signArgs(cert, ts).concat([file]);
    const r = spawnSync(signtool, args, { encoding: 'utf8', stdio: STDIO });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    if (r.status === 0) {
      return { ok: true, note: ts ? `时间戳 ${new URL(ts).host}` : '无时间戳（时间戳服务器全部不可达）' };
    }
    const diag = `status=${r.status}` +
      (r.error ? ` spawnError=${r.error.code || r.error.message}` : '') +
      (out.trim() ? `\n      ${out.trim().split(/\r?\n/).slice(-5).join('\n      ')}` : ' (无输出)');
    // 证书/私钥类错误：换时间戳服务器也没用，直接失败
    if (/no certificates|private key|not found|Bad PFX|password|0x8007000D/i.test(out)) {
      log.push(`[${path.basename(file)}] ${diag}`);
      return { ok: false, note: '证书不可用' };
    }
    if (i === TS_SERVERS.length - 1) {
      log.push(`[${path.basename(file)}] ${diag}`);
      return { ok: false, note: '签名失败' };
    }
  }
  return { ok: false, note: '签名失败' };
}

function signFileAzure(file, log) {
  const args = [
    'code', 'artifact-signing',
    '--timestamp-url', 'http://timestamp.acs.microsoft.com',
    '--artifact-signing-endpoint', process.env.SIGN_AZURE_ENDPOINT || '',
    '--artifact-signing-account', process.env.SIGN_AZURE_ACCOUNT || '',
    '--artifact-signing-certificate-profile', process.env.SIGN_AZURE_PROFILE || '',
    file,
  ];
  const r = spawnSync('sign', args, { encoding: 'utf8', stdio: STDIO, shell: true });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status === 0) return { ok: true, note: 'Azure 工件签名' };
  log.push(out.trim().split(/\r?\n/).slice(-4).join('\n'));
  return { ok: false, note: 'Azure 签名失败（需要 dotnet sign CLI 与三个 SIGN_AZURE_* 变量）' };
}

/* ---------------- 主流程 ---------------- */
function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = [];
  const say = (s) => console.log(s);

  say('== 代码签名 ==');

  const signtool = findSigntool();
  if (!signtool) {
    say('  找不到 signtool.exe（装 Windows SDK 的「Windows SDK 签名工具」组件，或设 SIGNTOOL 环境变量）');
    if (args.strict) process.exit(1);
    return;
  }
  say(`  signtool : ${signtool}`);

  const cert = resolveCert(args);
  if (!cert) {
    say('');
    say('  没有可用证书 → 跳过签名（打包产物仍会生成，但 SAC 会拦）。');
    say('  选项：');
    say('    临时本机自测 : npm run devcert     （生成自签名证书，仅本机/装过证书的机器有效）');
    say('    正式发行     : 买一张 OV/EV 代码签名证书，然后');
    say('                   npm run sign -- --pfx <证书.pfx> --password <密码>');
    say('    开源项目     : 申请 SignPath Foundation 免费签名');
    if (args.strict) process.exit(1);
    return;
  }
  say(`  证书来源 : ${cert.kind === 'pfx' ? cert.file : cert.kind === 'azure' ? 'Azure 工件签名' : cert.thumbprint + (cert.dev ? '（开发证书）' : '')}`);

  const targets = collectTargets(args).filter((f) => fs.existsSync(f));
  if (!targets.length) {
    say('  没有可签名的目标（先跑 npm run pack）');
    if (args.strict) process.exit(1);
    return;
  }

  const todo = [];
  let skipped = 0;
  for (const f of targets) {
    if (!args.force && hasValidSignature(signtool, f)) { skipped++; continue; }
    todo.push(f);
  }

  say(`  目标     : 共 ${targets.length} 个，其中已有有效签名跳过 ${skipped} 个，待签 ${todo.length} 个`);
  if (args.dry) {
    for (const f of todo) say('    [dry] ' + path.relative(ROOT, f));
    return;
  }
  if (!todo.length) { say('  全部已签名，无需处理'); return; }

  let ok = 0;
  const failed = [];
  for (const f of todo) {
    const rel = path.relative(ROOT, f);
    const r = signFile(signtool, cert, f, log);
    if (r.ok) {
      ok++;
      say(`  [OK]   ${rel}  — ${r.note}`);
    } else {
      failed.push(rel);
      say(`  [FAIL] ${rel}  — ${r.note}`);
    }
  }

  say('');
  say(`  结果 : 成功 ${ok} / 失败 ${failed.length} / 跳过 ${skipped}`);
  if (failed.length) {
    if (log.length) say('  错误摘要:\n    ' + log.join('\n    '));
    process.exit(2);
  }

  // 验签报告
  say('');
  say('  验签:');
  for (const f of targets) {
    const r = spawnSync(signtool, ['verify', '/pa', '/v', f], { encoding: 'utf8', stdio: STDIO });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const issuer = (out.match(/Issued to:\s*(.+)/) || [])[1] || '-';
    const st = r.status === 0 ? 'Valid' : 'UNTRUSTED/INVALID';
    say(`    ${st.padEnd(17)} ${path.relative(ROOT, f)}`);
    if (r.status === 0) say(`      ${issuer.trim()}`);
  }
}

main();
