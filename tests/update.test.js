// updater.js 单测：版本比较 / feed 校验 / 流式下载 / 替换脚本。
//
// 全程用假 fetch，不联网。
// 真连线上和"真把自己的 exe 换掉"都不放在这里 —— 前者会把回归变成联网测试，
// 后者会在跑测试的时候把正在跑测试的进程替换掉，属于自毁。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const updater = require('../updater');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log(' FAIL  ' + name + ' -> ' + e.message); }
}
// ⚠️ 异步用例必须用 ta。用 t 包 async 函数会"立刻返回成功"，测试根本没等它跑完（踩过）。
async function ta(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log(' FAIL  ' + name + ' -> ' + e.message); }
}

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pl-upd-' + (tag || 'x') + '-'));
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 造一个按块吐数据的假 Response */
function fakeRes(chunks, o) {
  const opt = o || {};
  const total = chunks.reduce((n, c) => n + c.length, 0);
  return {
    ok: opt.ok !== false,
    status: opt.status || 200,
    headers: opt.headers === false ? null : {
      get: (k) => (String(k).toLowerCase() === 'content-length'
        ? String(opt.length != null ? opt.length : total) : null)
    },
    body: {
      getReader() {
        let i = 0;
        return {
          read: async () => {
            if (opt.failAt != null && i === opt.failAt) {
              throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
            }
            if (i >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[i++] };
          }
        };
      }
    }
  };
}

console.log('\n=== updater.js 单测 ===\n');

// 异步用例不能在模块顶层 await —— Node 会因此判定"既像 CJS 又像 ESM"直接报错。
// 统一裹进一个 async IIFE（同 cloud.test.js 的写法）。
(async () => {

/* ---------- 版本比较 ---------- */
console.log('--- 版本比较 ---');
t('按数值比，不按字符串（1.10 > 1.9）', () => {
  assert.strictEqual(updater.compareVersion('1.10.0', '1.9.0'), 1);
});
t('位数不等按 0 补齐', () => {
  assert.strictEqual(updater.compareVersion('1.0', '1.0.0'), 0);
});
t('前缀 v 被忽略', () => {
  assert.strictEqual(updater.compareVersion('v5.0.0', '5.0.0'), 0);
});
t('5.0.0 比 4.4.0 新', () => {
  assert.strictEqual(updater.compareVersion('5.0.0', '4.4.0'), 1);
});

/* ---------- feed 校验 ---------- */
console.log('\n--- feed 校验 ---');
t('合法 sha256 归一化成小写', () => {
  const f = updater.parseFeed({ version: '5.0.0', sha256: 'A'.repeat(64), size: 123 });
  assert.strictEqual(f.ok, true);
  assert.strictEqual(f.sha256, 'a'.repeat(64));
  assert.strictEqual(f.size, 123);
});
t('sha256 长度不对就等于没给（不能降级成"能装"）', () => {
  assert.strictEqual(updater.parseFeed({ version: '1.0.0', sha256: 'abc' }).sha256, '');
  assert.strictEqual(updater.parseFeed({ version: '1.0.0', sha256: 'z'.repeat(64) }).sha256, '');
});
t('size 只收正数，字符串数字也认', () => {
  assert.strictEqual(updater.parseFeed({ version: '1.0.0', size: 0 }).size, 0);
  assert.strictEqual(updater.parseFeed({ version: '1.0.0', size: -5 }).size, 0);
  assert.strictEqual(updater.parseFeed({ version: '1.0.0', size: '100' }).size, 100);
  assert.strictEqual(updater.parseFeed({ version: '1.0.0', size: 'abc' }).size, 0);
});
t('缺 version 仍然报错', () => {
  assert.strictEqual(updater.parseFeed({ url: 'x' }).ok, false);
});
t('url + 合法 sha256 才允许自动安装', () => {
  assert.strictEqual(updater.canAutoInstall({ url: 'https://x/a.exe', sha256: 'a'.repeat(64) }), true);
  assert.strictEqual(updater.canAutoInstall({ url: 'https://x/a.exe' }), false, '没校验值不能自动装');
  assert.strictEqual(updater.canAutoInstall({ url: 'ftp://x/a.exe', sha256: 'a'.repeat(64) }), false);
  assert.strictEqual(updater.canAutoInstall(null), false);
});

/* ---------- 检查更新（假 fetch） ---------- */
console.log('\n--- 检查更新 ---');
const realFetch = global.fetch;
const withFetch = async (impl, fn) => {
  global.fetch = impl;
  try { return await fn(); } finally { global.fetch = realFetch; }
};

await ta('有新版时把 sha256/size/canAutoInstall 一起带回来', async () => {
  const feed = { version: '5.1.0', url: 'https://x/a.exe', sha256: 'b'.repeat(64), size: 4096, notes: 'n' };
  const r = await withFetch(
    async () => ({ ok: true, status: 200, json: async () => feed }),
    () => updater.checkUpdate({ feedUrl: 'https://x/feed.json', currentVersion: '5.0.0' })
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.hasUpdate, true);
  assert.strictEqual(r.latestVersion, '5.1.0');
  assert.strictEqual(r.sha256, 'b'.repeat(64));
  assert.strictEqual(r.size, 4096);
  assert.strictEqual(r.canAutoInstall, true);
});

await ta('只有 url 没有 sha256 时 canAutoInstall=false（退回手动下载）', async () => {
  const feed = { version: '5.1.0', url: 'https://x/a.exe' };
  const r = await withFetch(
    async () => ({ ok: true, status: 200, json: async () => feed }),
    () => updater.checkUpdate({ feedUrl: 'https://x/feed.json', currentVersion: '5.0.0' })
  );
  assert.strictEqual(r.hasUpdate, true);
  assert.strictEqual(r.canAutoInstall, false);
});

await ta('更新源 404 时报 HTTP 错误而不是崩', async () => {
  const r = await withFetch(
    async () => ({ ok: false, status: 404, json: async () => ({}) }),
    () => updater.checkUpdate({ feedUrl: 'https://x/feed.json', currentVersion: '5.0.0' })
  );
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.indexOf('404') >= 0, r.error);
});

/* ---------- 下载 ---------- */
console.log('\n--- 下载 ---');
const PAYLOAD = Buffer.from('pebble-launcher-payload-'.repeat(2000));

await ta('正常下载：写盘、哈希正确、进度收在 100%、不留 .part', async () => {
  const dir = tmpDir('ok');
  const dest = path.join(dir, 'Pebble-Launcher-5.1.0.exe');
  const ps = [];
  const r = await updater.downloadUpdate({
    url: 'https://x/a.exe', dest, sha256: sha(PAYLOAD), size: PAYLOAD.length,
    fetchImpl: async () => fakeRes([PAYLOAD.slice(0, 1000), PAYLOAD.slice(1000)]),
    onProgress: (p) => ps.push(p),
    stallMs: 5000
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(fs.readFileSync(dest).equals(PAYLOAD), true);
  assert.strictEqual(r.sha256, sha(PAYLOAD));
  assert.ok(ps.length >= 1, '一次进度都没报');
  assert.strictEqual(ps[ps.length - 1].percent, 100, '收尾没补 100%');
  assert.strictEqual(fs.existsSync(dest + '.part'), false, '.part 没清掉');
});

await ta('哈希不匹配：报 UPD_HASH，且成品和半成品都不留', async () => {
  const dir = tmpDir('hash');
  const dest = path.join(dir, 'a.exe');
  const r = await updater.downloadUpdate({
    url: 'https://x/a.exe', dest, sha256: 'c'.repeat(64),
    fetchImpl: async () => fakeRes([PAYLOAD]), stallMs: 5000
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'UPD_HASH');
  assert.strictEqual(fs.existsSync(dest), false);
  assert.strictEqual(fs.existsSync(dest + '.part'), false);
});

await ta('大小对不上：报 UPD_SIZE（清单写错也该拦住）', async () => {
  const dir = tmpDir('size');
  const dest = path.join(dir, 'a.exe');
  const r = await updater.downloadUpdate({
    url: 'https://x/a.exe', dest, sha256: sha(PAYLOAD), size: PAYLOAD.length + 99,
    fetchImpl: async () => fakeRes([PAYLOAD]), stallMs: 5000
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'UPD_SIZE');
  assert.strictEqual(fs.existsSync(dest), false);
});

await ta('HTTP 404：报 UPD_HTTP，不落盘', async () => {
  const dir = tmpDir('404');
  const dest = path.join(dir, 'a.exe');
  const r = await updater.downloadUpdate({
    url: 'https://x/a.exe', dest,
    fetchImpl: async () => fakeRes([], { ok: false, status: 404 }), stallMs: 5000
  });
  assert.strictEqual(r.code, 'UPD_HTTP');
  assert.strictEqual(fs.existsSync(dest), false);
});

await ta('取消：报 UPD_CANCEL，半截文件删干净', async () => {
  const dir = tmpDir('cancel');
  const dest = path.join(dir, 'a.exe');
  let n = 0;
  const r = await updater.downloadUpdate({
    url: 'https://x/a.exe', dest,
    fetchImpl: async () => fakeRes([PAYLOAD.slice(0, 500), PAYLOAD.slice(500)]),
    // 第一块之后就不再继续
    isCancelled: () => (++n > 1),
    stallMs: 5000
  });
  assert.strictEqual(r.code, 'UPD_CANCEL');
  assert.strictEqual(r.cancelled, true);
  assert.strictEqual(fs.existsSync(dest), false);
  assert.strictEqual(fs.existsSync(dest + '.part'), false);
});

await ta('中途断线：报网络错误，不留半截文件', async () => {
  const dir = tmpDir('net');
  const dest = path.join(dir, 'a.exe');
  const r = await updater.downloadUpdate({
    url: 'https://x/a.exe', dest,
    fetchImpl: async () => fakeRes([PAYLOAD.slice(0, 500), PAYLOAD.slice(500)], { failAt: 1 }),
    stallMs: 5000
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(fs.existsSync(dest), false);
  assert.strictEqual(fs.existsSync(dest + '.part'), false);
});

/* ---------- 替换脚本 ---------- */
console.log('\n--- 替换脚本 ---');
t('脚本会等 PID 消失、复制、重启、自删', () => {
  const s = updater.buildApplyScript({ staged: 'C:\\tmp\\new.exe', target: 'D:\\app\\Pebble.exe', pid: 4321 });
  assert.ok(s.indexOf('chcp 65001') >= 0, '缺 chcp（中文路径会乱码）');
  assert.ok(s.indexOf('PID eq 4321') >= 0, '没等旧进程退出');
  assert.ok(s.indexOf('copy /Y "C:\\tmp\\new.exe" "D:\\app\\Pebble.exe"') >= 0, '复制命令不对');
  assert.ok(s.indexOf('start "" "D:\\app\\Pebble.exe"') >= 0, '没重启新版本');
  assert.ok(s.indexOf('del "%~f0"') >= 0, '脚本没自删');
  assert.ok(s.indexOf('\r\n') >= 0, 'bat 必须是 CRLF');
});
t('PID 等待有上限（应用没退干净时脚本不能永远赖着）', () => {
  const s = updater.buildApplyScript({ staged: 'a', target: 'b.exe', pid: 1 });
  assert.ok(s.indexOf('if %w% lss 120 goto wait_pid') >= 0, '缺等待上限');
});
t('restart:false 时不启动新进程', () => {
  const s = updater.buildApplyScript({ staged: 'a', target: 'b.exe', pid: 1, restart: false });
  assert.strictEqual(/^start "/m.test(s), false);
});

/* ---------- 应用替换 ---------- */
console.log('\n--- 应用替换 ---');
t('待安装文件不存在时直接拒绝', () => {
  const d = tmpDir('ap1');
  const r = updater.applyUpdate({ staged: path.join(d, 'nope.exe'), target: path.join(d, 't.exe') });
  assert.strictEqual(r.ok, false);
});
t('目标不是 .exe 时拒绝（防误删）', () => {
  const d = tmpDir('ap2');
  const staged = path.join(d, 'new.exe');
  fs.writeFileSync(staged, 'x');
  const r = updater.applyUpdate({ staged, target: path.join(d, 'data.txt') });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.indexOf('.exe') >= 0 || r.error.indexOf('可执行') >= 0, r.error);
});
t('待安装文件与目标是同一个时拒绝', () => {
  const d = tmpDir('ap3');
  const f = path.join(d, 'same.exe');
  fs.writeFileSync(f, 'x');
  assert.strictEqual(updater.applyUpdate({ staged: f, target: f }).ok, false);
});
t('正常路径：写出 bat、内容正确、调用 onSpawn', () => {
  const d = tmpDir('ap4');
  const staged = path.join(d, 'new.exe');
  fs.writeFileSync(staged, 'new');
  const target = path.join(d, 'Pebble.exe');
  const scriptPath = path.join(d, 'pl-apply-update.bat');
  let spawned = null;
  const r = updater.applyUpdate({
    staged, target, pid: 777, scriptPath,
    onSpawn: (s) => { spawned = s; }
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(spawned, scriptPath);
  assert.ok(fs.existsSync(scriptPath), '脚本没写出来');
  const body = fs.readFileSync(scriptPath, 'utf8');
  assert.ok(body.indexOf('PID eq 777') >= 0);
  assert.ok(body.indexOf(`copy /Y "${staged}" "${target}"`) >= 0);
});

console.log('\nupdater: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

})();
