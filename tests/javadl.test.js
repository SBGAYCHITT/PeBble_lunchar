// javadl 离线测试：API 地址装配 / 资源挑选 / 解压（含 zip-slip 防护）/ 定位 java / 缓存命中
// 真正联网下载那一层不在这里跑（需要网络 + 几十 MB）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const jd = require('../javadl');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log(' FAIL  ' + name + ' -> ' + e.message); fail++; }
}
async function ta(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log(' FAIL  ' + name + ' -> ' + e.message); fail++; }
}

/* ---------- 造一个真 zip（Stored，无压缩）用于解压测试 ---------- */
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function buildZip(files) {
  const chunks = [], central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const crc = crc32(data);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); lfh.writeUInt16LE(20, 4);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18); lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    chunks.push(lfh, nameBuf, data);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); cdh.writeUInt16LE(20, 4); cdh.writeUInt16LE(20, 6);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(data.length, 20); cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cdh, nameBuf]));
    offset += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

/* ---------------- API 地址与资源挑选 ---------------- */
console.log('=== API 地址 ===');
t('含主版本号', () => assert.ok(jd.apiUrl(21).indexOf('/21/') > 0, jd.apiUrl(21)));
t('Windows 默认取 jre 而不是 jdk', () => {
  const u = jd.apiUrl(21);
  assert.ok(u.indexOf('os=windows') > 0 && u.indexOf('image_type=jre') > 0, u);
});
t('可指定 jdk / 架构', () =>
  assert.ok(jd.apiUrl(17, { imageType: 'jdk', arch: 'x86' }).indexOf('image_type=jdk') > 0));
t('默认 vendor=eclipse', () => assert.ok(jd.apiUrl(21).indexOf('vendor=eclipse') > 0));

console.log('\n=== 资源挑选 ===');
t('正常返回取第一个带下载链接的包', () => {
  const a = jd.pickAsset([{ binaries: [{ package: { link: 'https://x/y.zip', name: 'y.zip', size: 12 } }] }]);
  assert.strictEqual(a.url, 'https://x/y.zip');
  assert.strictEqual(a.size, 12);
});
t('带版本号信息', () => {
  const a = jd.pickAsset([{ version_data: { semver: '21.0.1' }, binaries: [{ package: { link: 'u' } }] }]);
  assert.strictEqual(a.version, '21.0.1');
});
t('空数组 → null', () => assert.strictEqual(jd.pickAsset([]), null));
t('非数组 → null', () => assert.strictEqual(jd.pickAsset({ error: 'x' }), null));
t('binaries 缺 package → null', () => assert.strictEqual(jd.pickAsset([{ binaries: [{}] }]), null));

/* ---------------- 解压 ---------------- */
console.log('\n=== 解压 ===');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-java-'));
const zipPath = path.join(tmp, 'x.zip');
fs.writeFileSync(zipPath, buildZip([
  { name: 'jdk-21/bin/javaw.exe', data: 'EXE' },
  { name: 'jdk-21/lib/modules', data: 'MODULES' },
  { name: 'jdk-21/release', data: 'RELEASE' }
]));
const outDir = path.join(tmp, 'out');
t('解压出全部文件', () => {
  const n = jd.extractZip(zipPath, outDir);
  assert.strictEqual(n, 3);
  assert.strictEqual(fs.readFileSync(path.join(outDir, 'jdk-21/release'), 'utf8'), 'RELEASE');
});
t('自动建多级目录', () => assert.ok(fs.existsSync(path.join(outDir, 'jdk-21', 'bin', 'javaw.exe'))));
t('空 zip 抛错', () => {
  const empty = path.join(tmp, 'empty.zip');
  fs.writeFileSync(empty, Buffer.alloc(10));
  assert.throws(() => jd.extractZip(empty, path.join(tmp, 'o2')));
});

console.log('\n=== zip-slip 防护 ===');
const evilZip = path.join(tmp, 'evil.zip');
fs.writeFileSync(evilZip, buildZip([
  { name: '../../evil.txt', data: 'PWNED' },
  { name: 'ok.txt', data: 'OK' }
]));
const evilOut = path.join(tmp, 'evilout');
t('带 ../ 的条目被丢弃，不会写出到解压目录之外', () => {
  const n = jd.extractZip(evilZip, evilOut);
  assert.strictEqual(n, 1, '只应写出 ok.txt');
  assert.ok(fs.existsSync(path.join(evilOut, 'ok.txt')));
  assert.ok(!fs.existsSync(path.join(tmp, 'evil.txt')), '上级目录被写了文件！');
  assert.ok(!fs.existsSync(path.resolve(tmp, '..', 'evil.txt')), '更上级被写了文件！');
});

/* ---------------- 定位 java ---------------- */
console.log('\n=== 定位 java ===');
t('根目录有 bin/javaw.exe 直接命中', () => {
  const found = jd.locateJava(outDir + '/jdk-21');
  assert.ok(found && found.replace(/\\/g, '/').indexOf('bin/javaw.exe') > 0, String(found));
});
t('zip 多一层目录也能找到', () => assert.ok(jd.locateJava(outDir)));
t('目录不存在返回 null', () => assert.strictEqual(jd.locateJava(path.join(tmp, 'nope')), null));
t('没有 java 的目录返回 null', () => {
  const d = path.join(tmp, 'nojava');
  fs.mkdirSync(d, { recursive: true });
  assert.strictEqual(jd.locateJava(d), null);
});

/* ---------------- 缓存命中（不联网） ---------------- */
console.log('\n=== 已装 Java 的缓存命中 ===');
const root = path.join(tmp, 'runtime');
const jreDir = path.join(root, 'java', 'temurin-21');
fs.mkdirSync(path.join(jreDir, 'bin'), { recursive: true });
fs.writeFileSync(path.join(jreDir, 'bin', 'javaw.exe'), 'X');
(async () => {
  await ta('已装过就直接返回，不再联网', async () => {
    const r = await jd.ensureJava({ major: 21, destRoot: root });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.cached, true);
    assert.ok(r.javaPath.replace(/\\/g, '/').indexOf('bin/javaw.exe') > 0);
  });
  await ta('没指定目录时明确报错', async () => {
    const r = await jd.ensureJava({ major: 21 });
    assert.strictEqual(r.ok, false);
  });

  console.log('\n=== 已安装列表与清理 ===');
  t('installed 列出本地 Java', () => {
    const list = jd.installed(root);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, 'temurin-21');
    assert.ok(list[0].bytes > 0);
  });
  t('installed 目录为空 → 空数组', () => assert.deepStrictEqual(jd.installed(path.join(tmp, 'nope')), []));
  t('remove 删除指定 Java', () => {
    const r = jd.remove(root, 'temurin-21');
    assert.strictEqual(r.ok, true);
    assert.ok(!fs.existsSync(jreDir));
    assert.deepStrictEqual(jd.installed(root), []);
  });
  t('remove 不存在 → 报错', () => assert.strictEqual(jd.remove(root, 'nope').ok, false));

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  console.log('\n' + (fail === 0 ? '★ javadl 全部通过（' + pass + ' 项）' : `★ javadl 有 ${fail} 项失败`));
  process.exit(fail === 0 ? 0 : 1);
})();
