// zipwrite.js 单元测试
//
// 这个模块的产物是要被别人（其他启动器 / 解压软件）读的，所以测试重点不是"函数返回值对不对"，
// 而是**产出的字节是否真的符合 ZIP 规范** —— 用 zipread.js（独立实现）交叉验证。
// 一个 zip 生成器自己读自己能过，不代表别人能读。

const fs = require('fs');
const os = require('os');
const path = require('path');
const zw = require('../zipwrite');
const zr = require('../zipread');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name); console.log('      ' + (e && e.message)); }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || '断言失败'}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}
function ok(v, msg) { if (!v) throw new Error(msg || '期望为真'); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-zw-'));

console.log('zipwrite.js');

/* ---------- crc32 ---------- */

t('crc32：已知向量 "123456789" = 0xCBF43926', () => {
  eq(zw.crc32(Buffer.from('123456789', 'ascii')), 0xcbf43926);
});

t('crc32：空串 = 0', () => {
  eq(zw.crc32(Buffer.alloc(0)), 0);
});

t('crc32：永远无符号（不返回负数）', () => {
  // 这条是真踩过的坑：`c ^ -1` 是有符号的，漏了 `>>> 0`
  // 会让 writeUInt32LE 抛 "value out of range"
  for (const s of ['a', 'hello', '你好世界', 'x'.repeat(1000)]) {
    const v = zw.crc32(Buffer.from(s, 'utf8'));
    ok(v >= 0 && v <= 0xffffffff, `${s} 的 crc 该是正数，实际 ${v}`);
  }
});

/* ---------- 基本写出/读回 ---------- */

t('单个文件：写得进、读得回', () => {
  const out = path.join(TMP, 'one.zip');
  zw.writeZipEntries(out, [{ name: 'a.txt', data: 'hello' }]);
  const hit = zr.readFirst(out, ['a.txt']);
  ok(hit, '该能读出 a.txt');
  eq(hit.data.toString('utf8'), 'hello');
});

t('多个文件：条目数与内容都对', () => {
  const out = path.join(TMP, 'multi.zip');
  zw.writeZipEntries(out, [
    { name: 'a.txt', data: 'aaa' },
    { name: 'dir/b.txt', data: 'bbb' },
    { name: 'dir/sub/c.txt', data: 'ccc' }
  ]);
  const names = zr.listEntries(out).map((e) => e.name).sort();
  eq(names.join(','), 'a.txt,dir/b.txt,dir/sub/c.txt');
  eq(zr.readFirst(out, ['dir/sub/c.txt']).data.toString('utf8'), 'ccc');
});

t('空文件也能正确写出', () => {
  const out = path.join(TMP, 'empty.zip');
  zw.writeZipEntries(out, [{ name: 'zero.txt', data: '' }]);
  const hit = zr.readFirst(out, ['zero.txt']);
  ok(hit, '该能读出空文件');
  eq(hit.data.length, 0);
});

t('zip 里没有条目时不炸', () => {
  const out = path.join(TMP, 'nothing.zip');
  const r = zw.writeZipEntries(out, []);
  eq(r.count, 0);
  ok(fs.existsSync(out));
  eq(zr.listEntries(out).length, 0);
});

/* ---------- 内容正确性 ---------- */

t('大文件（>32 字节）走 deflate 且内容无损', () => {
  const out = path.join(TMP, 'big.zip');
  // 用可压缩的内容，确保真的走了 deflate 分支
  const text = 'The quick brown fox jumps over the lazy dog. '.repeat(200);
  zw.writeZipEntries(out, [{ name: 'big.txt', data: text }]);
  const buf = fs.readFileSync(out);
  const entry = zr.listEntries(out)[0];
  eq(entry.method, 8, '该用 deflate');
  ok(entry.compSize < entry.size, '该真的变小了');
  eq(zr.readFirst(out, ['big.txt']).data.toString('utf8'), text);
  ok(buf.length > 0);
});

t('小文件不做无意义压缩（存 Stored）', () => {
  const out = path.join(TMP, 'small.zip');
  zw.writeZipEntries(out, [{ name: 's.txt', data: 'hi' }]);
  const e = zr.listEntries(out)[0];
  eq(e.method, 0, '太小了，压了反而更大，该存原文');
});

t('压不动的数据回退到 Stored（不硬塞）', () => {
  const out = path.join(TMP, 'random.zip');
  // xorshift32 造高熵数据 —— 别用 i*常数&0xff（低字节循环，deflate 压得掉）
  let x = 123456789;
  const bytes = Buffer.alloc(4096);
  for (let i = 0; i < bytes.length; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;  x >>>= 0;
    bytes[i] = x & 0xff;
  }
  zw.writeZipEntries(out, [{ name: 'r.bin', data: bytes }]);
  const e = zr.listEntries(out)[0];
  eq(e.method, 0, '压不小就该存原文');
  ok(zr.readFirst(out, ['r.bin']).data.equals(bytes), '内容该一模一样');
});

t('level:0 全走 Stored', () => {
  const out = path.join(TMP, 'nolevel.zip');
  zw.writeZipEntries(out, [{ name: 'x.txt', data: 'a'.repeat(500) }], { level: 0 });
  eq(zr.listEntries(out)[0].method, 0);
});

/* ---------- 编码 ---------- */

t('中文文件名与中文内容都正确（UTF-8 标志位）', () => {
  const out = path.join(TMP, 'utf8.zip');
  zw.writeZipEntries(out, [{ name: '说明/公告.txt', data: '你好，世界！整合包测试。' }]);
  const e = zr.listEntries(out)[0];
  eq(e.name, '说明/公告.txt', '中文名该原样读回');
  eq(zr.readFirst(out, ['说明/公告.txt']).data.toString('utf8'), '你好，世界！整合包测试。');
});

t('UTF-8 标志位（bit 11）被置上', () => {
  const out = path.join(TMP, 'flag.zip');
  zw.writeZipEntries(out, [{ name: '中文.txt', data: 'x' }]);
  const buf = fs.readFileSync(out);
  const flags = buf.readUInt16LE(6);
  ok((flags & 0x0800) !== 0, '该置上 UTF-8 位，实际 flags=0x' + flags.toString(16));
});

t('反斜杠被归一成正斜杠（ZIP 规定用 /）', () => {
  const out = path.join(TMP, 'slash.zip');
  zw.writeZipEntries(out, [{ name: 'a\\b\\c.txt', data: 'x' }]);
  eq(zr.listEntries(out)[0].name, 'a/b/c.txt');
});

t('Buffer 内容原样写入', () => {
  const out = path.join(TMP, 'bin.zip');
  const data = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f]);
  zw.writeZipEntries(out, [{ name: 'b.bin', data }]);
  ok(zr.readFirst(out, ['b.bin']).data.equals(data));
});

/* ---------- 结构正确性 ---------- */

t('产物 magic 是 PK\\x03\\x04（真 zip，不是 tar）', () => {
  const out = path.join(TMP, 'magic.zip');
  zw.writeZipEntries(out, [{ name: 'a', data: 'b' }]);
  const buf = fs.readFileSync(out);
  eq(buf.readUInt32LE(0), 0x04034b50);
});

t('末尾是 EOCD（PK\\x05\\x06）', () => {
  const out = path.join(TMP, 'eocd.zip');
  zw.writeZipEntries(out, [{ name: 'a', data: 'b' }]);
  const buf = fs.readFileSync(out);
  eq(buf.readUInt32LE(buf.length - 22), 0x06054b50);
});

t('EOCD 里的条目数与实际一致', () => {
  const out = path.join(TMP, 'count.zip');
  zw.writeZipEntries(out, [
    { name: '1.txt', data: '1' }, { name: '2.txt', data: '2' }, { name: '3.txt', data: '3' }
  ]);
  const buf = fs.readFileSync(out);
  eq(buf.readUInt16LE(buf.length - 22 + 8), 3);
  eq(buf.readUInt16LE(buf.length - 22 + 10), 3);
});

t('返回的 size 与磁盘上的文件大小一致', () => {
  const out = path.join(TMP, 'size.zip');
  const r = zw.writeZipEntries(out, [{ name: 'a.txt', data: 'hello world' }]);
  eq(r.size, fs.statSync(out).size);
  eq(r.count, 1);
});

t('自动创建输出目录（含多级）', () => {
  const out = path.join(TMP, 'deep', 'x', 'y', 'z.zip');
  zw.writeZipEntries(out, [{ name: 'a', data: 'b' }]);
  ok(fs.existsSync(out));
});

t('输出路径也能用 .jar 后缀（mod 打包场景）', () => {
  const out = path.join(TMP, 'fake.jar');
  zw.writeZipEntries(out, [{ name: 'fabric.mod.json', data: '{"id":"x"}' }]);
  const hit = zr.readFirst(out, ['fabric.mod.json']);
  eq(JSON.parse(hit.data.toString('utf8')).id, 'x');
});

t('同名条目重复出现时都写入（不做去重）', () => {
  const out = path.join(TMP, 'dupentry.zip');
  zw.writeZipEntries(out, [
    { name: 'a.txt', data: 'first' },
    { name: 'a.txt', data: 'second' }
  ]);
  eq(zr.listEntries(out).length, 2, '两个都该在（由调用方负责去重）');
});

t('时间戳被写进头里（DOS 时间不为 0）', () => {
  const out = path.join(TMP, 'time.zip');
  zw.writeZipEntries(out, [{ name: 'a', data: 'b' }], { mtime: new Date(2026, 9, 2, 14, 30, 0) });
  const buf = fs.readFileSync(out);
  const date = buf.readUInt16LE(12);
  const time = buf.readUInt16LE(10);
  ok(date !== 0, '日期不该是 0');
  ok(time !== 0, '时间不该是 0');
  eq((date >> 9) + 1980, 2026, '年份该对');
  eq((date >> 5) & 0x0f, 10, '月份该对');
});

/* ---------- zipDir ---------- */

t('zipDir：整棵目录树打进去，保留相对路径', () => {
  const src = path.join(TMP, 'tree');
  fs.mkdirSync(path.join(src, 'sub', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(src, 'root.txt'), 'r');
  fs.writeFileSync(path.join(src, 'sub', 'mid.txt'), 'm');
  fs.writeFileSync(path.join(src, 'sub', 'deep', 'leaf.txt'), 'l');

  const out = path.join(TMP, 'tree.zip');
  zw.zipDir(out, src);
  const names = zr.listEntries(out).map((e) => e.name).sort();
  eq(names.join(','), 'root.txt,sub/deep/leaf.txt,sub/mid.txt');
  eq(zr.readFirst(out, ['sub/deep/leaf.txt']).data.toString('utf8'), 'l');
});

t('zipDir：skip 回调能排除文件', () => {
  const src = path.join(TMP, 'tree2');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'keep.txt'), 'k');
  fs.writeFileSync(path.join(src, 'drop.log'), 'd');

  const out = path.join(TMP, 'tree2.zip');
  zw.zipDir(out, src, { skip: (rel) => rel.endsWith('.log') });
  const names = zr.listEntries(out).map((e) => e.name);
  eq(names.join(','), 'keep.txt');
});

t('zipDir：目录不存在时产出空 zip 而不是抛', () => {
  const out = path.join(TMP, 'missing.zip');
  const r = zw.zipDir(out, path.join(TMP, 'no-such-dir'));
  eq(r.count, 0);
  ok(fs.existsSync(out), '空 zip 也该被建出来');
});

/* ---------- 与 zipread 的往返一致性（关键交叉验证） ---------- */

t('往返：50 个随机条目全部无损', () => {
  const out = path.join(TMP, 'roundtrip.zip');
  const entries = [];
  let x = 987654321;
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
  for (let i = 0; i < 50; i++) {
    const len = rnd() % 3000;
    const b = Buffer.alloc(len);
    for (let j = 0; j < len; j++) b[j] = rnd() & 0xff;
    entries.push({ name: `f${String(i).padStart(3, '0')}.bin`, data: b });
  }
  zw.writeZipEntries(out, entries);

  const listed = zr.listEntries(out);
  eq(listed.length, 50);
  const fd = fs.openSync(out, 'r');
  try {
    for (const e of entries) {
      const got = zr.readEntry(fd, listed.find((l) => l.name === e.name));
      ok(got && got.equals(e.data), `${e.name} 内容不一致`);
    }
  } finally { fs.closeSync(fd); }
});

console.log(`\n  ${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
