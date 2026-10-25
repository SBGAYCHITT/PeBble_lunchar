// installerprep 的单测：zip 读取是手写的，必须有测试兜住。
// 不联网 —— 预下载那一层只测纯函数（collectArtifacts），真实下载交给 --live 用例。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../installerprep');

let pass = 0;
let fail = 0;
async function ta(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.log('  ✗ ' + name + '\n      ' + e.message);
  }
}

/* ---------------- 造一个 stored（不压缩）的 zip ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const data = Buffer.from(e.data);
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 8); // stored
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    chunks.push(lh, nameBuf, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([ch, nameBuf]));

    offset += 30 + nameBuf.length + data.length;
  }

  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, eocd]);
}

(async () => {
  console.log('[installerprep] ZIP 读取');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-prep-'));
  const verJson = JSON.stringify({ id: 'test-loader-1', inheritsFrom: '1.21.1', libraries: [] }, null, 2);
  const profJson = JSON.stringify({
    spec: 1,
    libraries: [
      { name: 'a:b:1', downloads: { artifact: { path: 'a/b/1/b-1.jar', sha1: 'AA11' } } },
      { name: 'c:d:2', downloads: { classifiers: { natives: { path: 'c/d/2/d-2-natives.jar', sha1: 'BB22' } } } },
    ],
    versionInfo: { libraries: [{ downloads: { artifact: { path: 'e/f/3/f-3.jar', sha1: 'CC33' } } }] },
  });
  const jar = path.join(tmp, 'fake-installer.jar');
  fs.writeFileSync(
    jar,
    makeZip([
      { name: 'META-INF/MANIFEST.MF', data: 'Manifest-Version: 1.0\n' },
      { name: 'install_profile.json', data: profJson },
      { name: 'version.json', data: verJson },
    ]),
  );

  await ta('能读出 install_profile.json', () => {
    const raw = P.readZipEntry(jar, 'install_profile.json');
    assert.ok(raw, '没读到');
    assert.strictEqual(JSON.parse(raw.toString('utf8')).spec, 1);
  });

  await ta('能读出 version.json（带中文/多行也不坏）', () => {
    const raw = P.readZipEntry(jar, 'version.json');
    assert.strictEqual(raw.toString('utf8'), verJson);
  });

  await ta('不存在的条目返回 null（不抛）', () => {
    assert.strictEqual(P.readZipEntry(jar, 'no-such.json'), null);
  });

  await ta('不是 zip 的文件给出明确错误', () => {
    const bad = path.join(tmp, 'not-a-zip.jar');
    fs.writeFileSync(bad, Buffer.from('hello'));
    assert.throws(() => P.readZipEntry(bad, 'x'), /不是有效的 zip/);
  });

  console.log('[installerprep] 库清单解析');
  await ta('收集 artifact + classifiers + versionInfo，且路径统一成正斜杠', () => {
    const list = P.collectArtifacts(JSON.parse(profJson));
    assert.deepStrictEqual(
      list.map((x) => x.path).sort(),
      ['a/b/1/b-1.jar', 'c/d/2/d-2-natives.jar', 'e/f/3/f-3.jar'],
    );
    assert.strictEqual(list.find((x) => x.path.startsWith('a/')).sha1, 'aa11', 'sha1 应转小写');
  });

  await ta('没有 downloads 的库直接忽略（不乱下）', () => {
    assert.deepStrictEqual(P.collectArtifacts({ libraries: [{ name: 'x:y:1' }] }), []);
  });

  console.log('[installerprep] 版本清单兜底');
  await ta('缺 versions/<id>/<id>.json 时补写', () => {
    const mc = path.join(tmp, 'mc');
    fs.mkdirSync(mc, { recursive: true });
    const id = P.ensureVersionJson(jar, mc);
    assert.strictEqual(id, 'test-loader-1');
    const dest = path.join(mc, 'versions', 'test-loader-1', 'test-loader-1.json');
    assert.ok(fs.existsSync(dest), '文件没写出来');
    assert.strictEqual(fs.readFileSync(dest, 'utf8'), verJson, '内容应原样');
  });

  await ta('已存在时不覆盖（安装器写了就以它为准）', () => {
    const mc = path.join(tmp, 'mc');
    const id = P.ensureVersionJson(jar, mc);
    assert.strictEqual(id, null);
  });

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n[installerprep] 通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) process.exit(1);
})();
