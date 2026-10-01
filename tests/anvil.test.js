/*
 * anvil.js（Anvil region 读写层）单测。
 *
 * 全部用合成数据，不依赖真实存档：用 nbt.serialize 造区块 NBT，
 * 用 anvil.empty() + setChunk() 造 region，再验证往返、扇区对齐、
 * 「未改动区块不被重压缩」、损坏条目不炸、以及存档级扫描。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const anvil = require('../anvil');
const nbt = require('../nbt');

let pass = 0, fail = 0;
const failures = [];

function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; failures.push(name + ' -> ' + e.message); console.log(' FAIL  ' + name + ' -> ' + e.message); }
}
async function ta(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; failures.push(name + ' -> ' + e.message); console.log(' FAIL  ' + name + ' -> ' + e.message); }
}

console.log('\n=== anvil.js 单测 ===\n');

/* ---------- 工具 ---------- */
/**
 * 造一段**压不动**的填充串（线性同余伪随机 + 只取可打印 ASCII）。
 * 不能用 Buffer.alloc(n).toString('base64') —— 那是一片 'A'，deflate 会把它压成几十字节，
 * 于是「多扇区区块」的用例永远占不到 2 个扇区。
 */
function padStr(n) {
  const b = Buffer.alloc(n);
  let x = 0x2545f491;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    b[i] = 32 + (x % 95);
  }
  return b.toString('latin1');   // 全是 ASCII，utf8 编码后 1 字符 = 1 字节
}

/**
 * 造一段压不动的字节（xorshift32），给 BYTE_ARRAY 填充用。
 * 字符串填充有 65535 的长度上限，做大区块必须走这个。
 * @param {number} n
 * @returns {Int8Array}
 */
function rawBytes(n) {
  const b = new Int8Array(n);
  let x = 0x2545f491;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    b[i] = x & 0xff;
  }
  return b;
}

/** 造一个「像区块」的最小 NBT：根名空，带一个能识别身份的 Marker */
function chunkNbt(marker, padBytes) {
  const body = { DataVersion: 3465, xPos: 0, zPos: 0, Status: 'full', Marker: String(marker) };
  if (padBytes) body.Pad = padStr(padBytes);
  return nbt.serialize('', body);
}

/** 从 region 里取出某个槽位磁盘上的原始负载字节（用于验证「没被动过」） */
function rawPayloadOf(buf, cx, cz) {
  const { entries } = anvil.parseHeader(buf);
  const e = entries[anvil.chunkIndex(cx, cz)];
  assert.ok(!e.empty, '槽位不该是空的');
  return anvil.payloadSlice(buf, e);
}

const TMP = path.join(os.tmpdir(), 'pl-anvil-test');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

/* ================= 1. 坐标换算 ================= */
console.log('--- 坐标换算 ---');

t('chunkIndex：四角与边界', () => {
  assert.strictEqual(anvil.chunkIndex(0, 0), 0);
  assert.strictEqual(anvil.chunkIndex(31, 0), 31);
  assert.strictEqual(anvil.chunkIndex(0, 31), 992);
  assert.strictEqual(anvil.chunkIndex(31, 31), 1023);
});

t('chunkIndex：负数走位运算，不需要取模修正', () => {
  // -1 & 31 === 31，-1 >> 5 === -1
  assert.strictEqual(anvil.chunkIndex(-1, -1), 1023);
  assert.strictEqual(anvil.chunkIndex(-32, 0), 0);
  assert.strictEqual(anvil.chunkIndex(-33, -33), 1023);   // -33 mod 32 = 31
  assert.deepStrictEqual(anvil.regionOf(-33, -33), { rx: -2, rz: -2 });
  // 关键坑：(-1,-1) 与 (31,31) 的**局部槽位相同**，但分属 r.-1.-1 与 r.0.0 两个文件。
  // 把这两者写进同一个 region buffer 会互相覆盖 —— 下面那条用例专门盯这个。
  assert.strictEqual(anvil.chunkIndex(-1, -1), anvil.chunkIndex(31, 31));
  assert.notDeepStrictEqual(anvil.regionOf(-1, -1), anvil.regionOf(31, 31));
});

t('regionOf / regionFile / parseRegionName', () => {
  assert.deepStrictEqual(anvil.regionOf(0, 0), { rx: 0, rz: 0 });
  assert.deepStrictEqual(anvil.regionOf(31, 31), { rx: 0, rz: 0 });
  assert.deepStrictEqual(anvil.regionOf(32, 64), { rx: 1, rz: 2 });
  assert.deepStrictEqual(anvil.regionOf(-1, -1), { rx: -1, rz: -1 });
  assert.strictEqual(anvil.regionFile(-1, 2), 'r.-1.2.mca');
  assert.deepStrictEqual(anvil.parseRegionName('r.-1.2.mca'), { rx: -1, rz: 2 });
  assert.strictEqual(anvil.parseRegionName('r.0.0.txt'), null);
  assert.strictEqual(anvil.parseRegionName('random.mca'), null);
});

t('区块坐标 → region 槽位 → 世界坐标，能原样还原（含负坐标）', () => {
  for (const cx of [-65, -33, -32, -1, 0, 31, 32, 63, 64, 1000]) {
    for (const cz of [-65, -1, 0, 5, 31, 32, 999]) {
      const { rx, rz } = anvil.regionOf(cx, cz);
      const i = anvil.chunkIndex(cx, cz);
      const backX = rx * anvil.SIDE + (i % anvil.SIDE);
      const backZ = rz * anvil.SIDE + Math.floor(i / anvil.SIDE);
      assert.strictEqual(backX, cx, `cx ${cx} 还原失败`);
      assert.strictEqual(backZ, cz, `cz ${cz} 还原失败`);
    }
  }
});

t('每个 region 的槽位下标互不冲突（32x32 全覆盖）', () => {
  const seen = new Set();
  const { rx, rz } = anvil.regionOf(0, 0);
  for (let lx = 0; lx < 32; lx++) {
    for (let lz = 0; lz < 32; lz++) {
      const i = anvil.chunkIndex(rx * 32 + lx, rz * 32 + lz);
      assert.ok(!seen.has(i), '槽位重复: ' + i);
      seen.add(i);
    }
  }
  assert.strictEqual(seen.size, 1024);
});

/* ================= 2. 空 region ================= */
console.log('\n--- 空 region ---');

t('empty() 是两张空表，长度 8192', () => {
  const e = anvil.empty();
  assert.strictEqual(e.length, anvil.HEADER_BYTES);
  assert.strictEqual(e.length, 8192);
  assert.ok(e.every((b) => b === 0));
});

t('空 region 的头表全空，listChunks 返回空数组', () => {
  const h = anvil.parseHeader(anvil.empty());
  assert.strictEqual(h.tooShort, false);
  assert.strictEqual(h.count, 0);
  assert.strictEqual(anvil.listChunks(anvil.empty(), 0, 0).length, 0);
});

t('过短的 buffer 被当成空 region，而不是崩', () => {
  const h = anvil.parseHeader(Buffer.alloc(10));
  assert.strictEqual(h.tooShort, true);
  assert.strictEqual(h.count, 0);
  assert.strictEqual(anvil.listChunks(Buffer.alloc(10), 0, 0).length, 0);
});

/* ================= 3. 写入 / 读回 ================= */
console.log('\n--- 写入与读回 ---');

// 一个 region buffer 只装得下**一个** region 的区块，所以这里全用 r.0.0 范围内的坐标；
// 负坐标另有用例。
const SPOTS = [[0, 0], [5, 7], [31, 31], [1, 30]];

t('写 4 个区块，都能原样读回', () => {
  let buf = anvil.empty();
  for (const [cx, cz] of SPOTS) {
    buf = anvil.setChunk(buf, cx, cz, chunkNbt(`m-${cx}-${cz}`)).buf;
  }
  assert.strictEqual(anvil.listChunks(buf, 0, 0).length, 4);
  for (const [cx, cz] of SPOTS) {
    const r = anvil.readNbt(buf, cx, cz);
    assert.ok(r, `区块 ${cx},${cz} 读不到`);
    assert.strictEqual(r.value.Marker, `m-${cx}-${cz}`);
    assert.strictEqual(r.value.DataVersion, 3465);
  }
});

t('槽位语义：region buffer 不带 region 身份，隔离靠「先选对文件」而不是靠坐标', () => {
  // 本模块最容易踩的坑，写清楚：
  // (-1,-1) 与 (31,31) 的局部槽位都是 1023，所以对**同一个 buffer**读这两个坐标，
  // 拿到的必然是同一个区块 —— 这是 Anvil 格式本身决定的，不是 bug。
  // 真实的隔离来自「它们分属 r.-1.-1.mca 与 r.0.0.mca 两个文件」。
  const negBuf = anvil.setChunk(anvil.empty(), -1, -1, chunkNbt('neg')).buf;
  assert.strictEqual(anvil.chunkIndex(-1, -1), anvil.chunkIndex(31, 31));
  assert.strictEqual(anvil.readNbt(negBuf, -1, -1).value.Marker, 'neg');
  assert.strictEqual(anvil.readNbt(negBuf, 31, 31).value.Marker, 'neg',
    '同一个 buffer 里，同槽位就是同一个区块');

  // 真正的隔离在文件层：同一份存档里 r.-1.-1.mca 与 r.0.0.mca 各存各的
  const save = path.join(TMP, 'slot-save');
  anvil.writeSaveChunk({ saveDir: save, dim: 'overworld', cx: -1, cz: -1, raw: chunkNbt('neg'), backup: false });
  anvil.writeSaveChunk({ saveDir: save, dim: 'overworld', cx: 31, cz: 31, raw: chunkNbt('pos'), backup: false });

  assert.notStrictEqual(
    anvil.regionFilePath(save, 'overworld', 'region', -1, -1),
    anvil.regionFilePath(save, 'overworld', 'region', 31, 31),
    '两个坐标必须落到不同的 region 文件');
  assert.strictEqual(anvil.readSaveChunk({ saveDir: save, dim: 'overworld', cx: -1, cz: -1 }).hash,
    anvil.hashOf(chunkNbt('neg')));
  assert.strictEqual(anvil.readSaveChunk({ saveDir: save, dim: 'overworld', cx: 31, cz: 31 }).hash,
    anvil.hashOf(chunkNbt('pos')));
});

t('读不存在的区块返回 null（不是抛错）', () => {
  const buf = anvil.setChunk(anvil.empty(), 0, 0, chunkNbt('a')).buf;
  assert.strictEqual(anvil.readRaw(buf, 3, 3), null);
  assert.strictEqual(anvil.readNbt(buf, 3, 3), null);
  assert.strictEqual(anvil.chunkHash(buf, 3, 3), null);
});

t('覆盖写：同坐标再写一次，内容变成新的，总数不变', () => {
  let buf = anvil.setChunk(anvil.empty(), 2, 2, chunkNbt('v1')).buf;
  const h1 = anvil.chunkHash(buf, 2, 2);
  buf = anvil.setChunk(buf, 2, 2, chunkNbt('v2')).buf;
  const h2 = anvil.chunkHash(buf, 2, 2);
  assert.notStrictEqual(h1, h2, '内容改了，指纹应当变');
  assert.strictEqual(anvil.readNbt(buf, 2, 2).value.Marker, 'v2');
  assert.strictEqual(anvil.listChunks(buf, 0, 0).length, 1);
});

t('删除区块：自己的没了，别人的还在', () => {
  let buf = anvil.empty();
  buf = anvil.setChunk(buf, 0, 0, chunkNbt('keep')).buf;
  buf = anvil.setChunk(buf, 1, 1, chunkNbt('drop')).buf;
  buf = anvil.deleteChunk(buf, 1, 1).buf;
  assert.strictEqual(anvil.readRaw(buf, 1, 1), null);
  assert.strictEqual(anvil.readNbt(buf, 0, 0).value.Marker, 'keep');
  assert.strictEqual(anvil.listChunks(buf, 0, 0).length, 1);
});

t('只改一个区块时，其余区块的磁盘字节完全没被重压缩', () => {
  let buf = anvil.empty();
  buf = anvil.setChunk(buf, 0, 0, chunkNbt('a1')).buf;
  buf = anvil.setChunk(buf, 5, 7, chunkNbt('b1')).buf;
  buf = anvil.setChunk(buf, 6, 7, chunkNbt('c1')).buf;

  const before = new Map();
  for (const [cx, cz] of [[5, 7], [6, 7]]) before.set(`${cx},${cz}`, rawPayloadOf(buf, cx, cz));

  // 只动 (0,0)
  const after = anvil.setChunk(buf, 0, 0, chunkNbt('a2')).buf;

  for (const [cx, cz] of [[5, 7], [6, 7]]) {
    const b = rawPayloadOf(after, cx, cz);
    assert.ok(b.equals(before.get(`${cx},${cz}`)), `区块 ${cx},${cz} 的字节被动过了（说明被重新压缩）`);
  }
  assert.strictEqual(anvil.readNbt(after, 0, 0).value.Marker, 'a2');
});

/* ================= 4. 扇区对齐 ================= */
console.log('\n--- 扇区与偏移 ---');

t('负载按 4096 对齐，偏移指向自己的负载起点', () => {
  const buf = anvil.setChunk(anvil.empty(), 0, 0, chunkNbt('x')).buf;
  const rec = anvil.listChunks(buf, 0, 0)[0];
  assert.strictEqual(rec.offset, 2, '第一个区块应紧跟在 2 个头部扇区之后');
  assert.strictEqual(rec.sectors, 1);
  assert.strictEqual(buf.readUInt32BE(rec.offset * anvil.SECTOR), buf.readUInt32BE(rec.offset * 4096));
  // 长度字段 = 压缩后数据长度 + 1（那个 1 是压缩类型字节），故恒等于「负载字节数 - 4」。
  // 注意它**不等于**扇区对齐后的长度 —— 尾部填充不计入。
  const len = buf.readUInt32BE(rec.offset * anvil.SECTOR);
  assert.strictEqual(len, rec.bytes - 4, '长度字段应等于负载去掉 4 字节长度头');
  assert.strictEqual(buf[rec.offset * anvil.SECTOR + 4], 2, '默认压缩类型应为 zlib(2)');
  assert.ok(4 + len <= rec.sectors * anvil.SECTOR, '负载必须装得进已分配的扇区');
  assert.ok(4 + len > (rec.sectors - 1) * anvil.SECTOR, '扇区数应是「刚好装下」');
});

t('大区块占多个扇区，且不影响后续区块的偏移计算', () => {
  const big = chunkNbt('big', 20000);   // 压缩后仍会超过 1 个扇区
  let buf = anvil.setChunk(anvil.empty(), 0, 0, big).buf;
  buf = anvil.setChunk(buf, 1, 0, chunkNbt('small')).buf;

  const bigRec = anvil.listChunks(buf, 0, 0).find((r) => r.cx === 0);
  const smallRec = anvil.listChunks(buf, 0, 0).find((r) => r.cx === 1);
  assert.ok(bigRec.sectors >= 2, '大区块应占 >=2 扇区，实际 ' + bigRec.sectors);
  assert.strictEqual(smallRec.offset, bigRec.offset + bigRec.sectors, '后一个区块要紧接着排');
  assert.strictEqual(smallRec.offset * 4096 % 4096, 0);

  // 两个都能正常读回
  assert.strictEqual(anvil.readNbt(buf, 0, 0).value.Marker, 'big');
  assert.strictEqual(anvil.readNbt(buf, 1, 0).value.Marker, 'small');
});

t('超出 255 扇区的区块被拒绝，而不是写出坏表项', () => {
  // 255 扇区（约 1MB）是 Anvil 单区块的硬上限（扇区数只有 1 字节）。
  // 坑：不要用 `i * 常数 & 0xff` 造"随机"数据 —— 低字节每 256 步就循环一遍，
  // deflate 会把这种周期序列压到几百字节，用例就永远碰不到上限。
  // 注意别用字符串做 1MB 级填充：NBT 的字符串长度字段只有 2 字节（上限 65535），
  // 超了会直接抛 RangeError。BYTE_ARRAY 的长度字段是 4 字节，随便塞。
  const raw = nbt.serialize('', { DataVersion: 3465, Marker: 'huge', Pad: rawBytes(1200 * 1024) });
  assert.ok(zlib.deflateSync(raw).length > 255 * anvil.SECTOR, '前提：这份数据必须压不进 255 扇区');
  assert.throws(() => anvil.setChunk(anvil.empty(), 0, 0, raw), /255 扇区/);
});

/* ================= 5. 压缩类型 ================= */
console.log('\n--- 压缩类型 ---');

t('gzip(1) / zlib(2) / 未压缩(3) 都能读回同一份内容，且指纹一致', () => {
  const raw = chunkNbt('comp-test');
  const hashes = [];
  for (const comp of [1, 2, 3]) {
    const buf = anvil.setChunk(anvil.empty(), 0, 0, raw, { comp }).buf;
    const r = anvil.readRaw(buf, 0, 0);
    assert.strictEqual(r.comp, comp);
    assert.ok(r.data.equals(raw), '压缩类型 ' + comp + ' 读回的内容与原始字节不一致');
    hashes.push(anvil.hashOf(r.data));
  }
  assert.strictEqual(new Set(hashes).size, 1, '同一内容换压缩方式，指纹必须相同（否则 diff 会误报）');
});

t('LZ4(4) 明确报「不支持」，不当成未压缩读出垃圾', () => {
  const buf = anvil.empty();
  // 手工塞一条 comp=4 的负载
  const data = Buffer.from([1, 2, 3, 4, 5, 6]);
  const payload = Buffer.alloc(4 + 1 + data.length);
  payload.writeUInt32BE(data.length + 1, 0);
  payload[4] = 4;
  data.copy(payload, 5);
  const padded = Buffer.alloc(4096);
  payload.copy(padded);
  const out = Buffer.concat([buf, padded]);
  const p = 0;
  out[p] = 0; out[p + 1] = 0; out[p + 2] = 2; out[p + 3] = 1;   // 槽位 0 -> 扇区 2
  assert.throws(() => anvil.readRaw(out, 0, 0), /LZ4/);
});

/* ================= 6. 损坏条目 ================= */
console.log('\n--- 损坏容错 ---');

/** 手工造一个「槽位 0 正常、槽位 1 偏移越界」的 region */
function brokenRegion() {
  const good = chunkNbt('good');
  const payload = anvil.pack(good, 2);
  const padded = Buffer.alloc(4096);
  payload.copy(padded);
  const head = Buffer.alloc(8192);
  head[2] = 2; head[3] = 1;                       // 槽位 0 -> 扇区 2，占 1 扇区
  head[4 + 2] = 0xff; head[4 + 3] = 0xff;         // 槽位 1 -> 扇区 65535（越界），占 255 扇区
  head[4 + 5] = 255;
  return Buffer.concat([head, padded]);
}

t('偏移越界的条目被标为 broken，不会让整个文件读不出来', () => {
  const buf = brokenRegion();
  const list = anvil.listChunks(buf, 0, 0);
  const bad = list.filter((r) => r.broken);
  assert.strictEqual(bad.length, 1, '应恰好有 1 条损坏');
  assert.strictEqual(bad[0].i, 1);
  // 好区块照常读
  assert.strictEqual(anvil.readNbt(buf, 0, 0).value.Marker, 'good');
});

t('重打包时损坏条目计入 dropped 而不是崩，好区块原样保留', () => {
  const buf = brokenRegion();
  const res = anvil.repack(buf);
  assert.deepStrictEqual(res.dropped, [1]);
  assert.strictEqual(anvil.readNbt(res.buf, 0, 0).value.Marker, 'good');
  assert.strictEqual(anvil.listChunks(res.buf, 0, 0).length, 1, '重打包后只剩好区块');
});

t('损坏条目可以被显式覆盖修复', () => {
  const buf = brokenRegion();
  const res = anvil.setChunk(buf, 1, 0, chunkNbt('fixed')).buf;
  assert.strictEqual(anvil.readNbt(res, 1, 0).value.Marker, 'fixed');
  assert.strictEqual(anvil.listChunks(res, 0, 0).length, 2);
  assert.strictEqual(anvil.listChunks(res, 0, 0).filter((r) => r.broken).length, 0);
});

t('长度字段异常的条目也算损坏', () => {
  const buf = brokenRegion();
  buf.writeUInt32BE(0xfffffff0, 2 * 4096);   // 把好区块的长度字段写成天文数字
  const list = anvil.listChunks(buf, 0, 0);
  assert.strictEqual(list.filter((r) => r.broken).length, 2);
});

/* ================= 7. 文件级读写 ================= */
console.log('\n--- 文件级读写 ---');

t('写文件后不留 .tmp，再写一次会留下 .bak（内容 = 上一版）', () => {
  const file = path.join(TMP, 'region', 'r.0.0.mca');
  const v1 = anvil.setChunk(anvil.empty(), 0, 0, chunkNbt('v1')).buf;
  const r1 = anvil.writeRegionFile(file, v1, { backup: true });
  assert.strictEqual(r1.backup, null, '首次写没有旧文件，不该产生 .bak');
  assert.ok(fs.existsSync(file));
  assert.ok(!fs.existsSync(file + '.tmp'), '.tmp 必须被 rename 掉');

  const v2 = anvil.setChunk(v1, 0, 0, chunkNbt('v2')).buf;
  const r2 = anvil.writeRegionFile(file, v2, { backup: true });
  assert.strictEqual(r2.backup, file + '.bak');
  assert.ok(fs.readFileSync(file + '.bak').equals(v1), '.bak 应当是上一版内容');
  assert.ok(fs.readFileSync(file).equals(v2), '主文件应当是这一版内容');
  assert.ok(!fs.existsSync(file + '.tmp'));
});

t('readRegionFile：不存在 / 过短都返回 null', () => {
  assert.strictEqual(anvil.readRegionFile(path.join(TMP, 'nope.mca')), null);
  const tiny = path.join(TMP, 'tiny.mca');
  fs.writeFileSync(tiny, Buffer.alloc(100));
  assert.strictEqual(anvil.readRegionFile(tiny), null);
});

t('listRegionFiles 只认合法命名，按坐标排序', () => {
  const dir = path.join(TMP, 'listing');
  fs.mkdirSync(dir, { recursive: true });
  for (const n of ['r.1.0.mca', 'r.-1.2.mca', 'r.0.0.mca', 'readme.txt', 'r.x.y.mca']) {
    fs.writeFileSync(path.join(dir, n), anvil.empty());
  }
  const list = anvil.listRegionFiles(dir);
  assert.strictEqual(list.length, 3);
  assert.deepStrictEqual(list.map((f) => f.name), ['r.-1.2.mca', 'r.0.0.mca', 'r.1.0.mca']);
});

/* ================= 8. 存档级接口 ================= */
console.log('\n--- 存档级接口 ---');

(async () => {
  const save = path.join(TMP, 'save');
  fs.mkdirSync(path.join(save, 'region'), { recursive: true });
  fs.mkdirSync(path.join(save, 'DIM-1', 'region'), { recursive: true });
  fs.mkdirSync(path.join(save, 'DIM1', 'region'), { recursive: true });
  fs.mkdirSync(path.join(save, 'entities'), { recursive: true });

  // 主世界 2 个区块（分别在 r.0.0.mca 与 r.1.0.mca，负坐标落在 r.-1.-1.mca）
  let r00 = anvil.empty();
  r00 = anvil.setChunk(r00, 0, 0, chunkNbt('ow-0')).buf;
  anvil.writeRegionFile(path.join(save, 'region', 'r.0.0.mca'), r00, { backup: false });
  const r10 = anvil.setChunk(anvil.empty(), 33, 5, chunkNbt('ow-33')).buf;
  anvil.writeRegionFile(path.join(save, 'region', 'r.1.0.mca'), r10, { backup: false });

  let rNeg = anvil.setChunk(anvil.empty(), -1, -1, chunkNbt('ow-neg')).buf;
  anvil.writeRegionFile(path.join(save, 'region', 'r.-1.-1.mca'), rNeg, { backup: false });

  anvil.writeRegionFile(path.join(save, 'DIM-1', 'region', 'r.0.0.mca'),
    anvil.setChunk(anvil.empty(), 0, 0, chunkNbt('nether-0')).buf, { backup: false });
  anvil.writeRegionFile(path.join(save, 'DIM1', 'region', 'r.0.0.mca'),
    anvil.setChunk(anvil.empty(), 0, 0, chunkNbt('end-0')).buf, { backup: false });
  anvil.writeRegionFile(path.join(save, 'entities', 'r.0.0.mca'),
    anvil.setChunk(anvil.empty(), 0, 0, chunkNbt('ent-0')).buf, { backup: false });

  t('dataDir 三个维度落点正确', () => {
    assert.strictEqual(anvil.dataDir(save, 'overworld', 'region'), path.join(save, 'region'));
    assert.strictEqual(anvil.dataDir(save, 'nether', 'region'), path.join(save, 'DIM-1', 'region'));
    assert.strictEqual(anvil.dataDir(save, 'end', 'region'), path.join(save, 'DIM1', 'region'));
    assert.strictEqual(anvil.dataDir(save, 'overworld', 'entities'), path.join(save, 'entities'));
    assert.strictEqual(anvil.dataDir(save, 'nether', 'entities'), path.join(save, 'DIM-1', 'entities'));
  });

  t('regionFilePath 把区块坐标落到正确的文件', () => {
    assert.strictEqual(anvil.regionFilePath(save, 'overworld', 'region', 5, 5),
      path.join(save, 'region', 'r.0.0.mca'));
    assert.strictEqual(anvil.regionFilePath(save, 'overworld', 'region', 33, 5),
      path.join(save, 'region', 'r.1.0.mca'));
    assert.strictEqual(anvil.regionFilePath(save, 'nether', 'region', -1, -1),
      path.join(save, 'DIM-1', 'region', 'r.-1.-1.mca'));
  });

  t('readSaveChunk：三个维度 + 负坐标都能取到', () => {
    assert.strictEqual(anvil.readSaveChunk({ saveDir: save, dim: 'overworld', cx: 0, cz: 0 }).hash,
      anvil.hashOf(chunkNbt('ow-0')));
    assert.strictEqual(anvil.readSaveChunk({ saveDir: save, dim: 'overworld', cx: -1, cz: -1 }).hash,
      anvil.hashOf(chunkNbt('ow-neg')));
    assert.strictEqual(anvil.readSaveChunk({ saveDir: save, dim: 'nether', cx: 0, cz: 0 }).hash,
      anvil.hashOf(chunkNbt('nether-0')));
    assert.strictEqual(anvil.readSaveChunk({ saveDir: save, dim: 'end', cx: 0, cz: 0 }).hash,
      anvil.hashOf(chunkNbt('end-0')));
    assert.strictEqual(anvil.readSaveChunk({ saveDir: save, dim: 'overworld', cx: 9, cz: 9 }), null);
  });

  t('writeSaveChunk：新建文件时 created=true，写回后能读到', () => {
    // (70,70) 落在 r.2.2.mca，这个文件在 setup 里没造过
    const w = anvil.writeSaveChunk({
      saveDir: save, dim: 'overworld', cx: 70, cz: 70, raw: chunkNbt('new-70'), backup: false
    });
    assert.strictEqual(w.created, true, 'r.2.2.mca 此前不存在，应算新建');
    assert.ok(w.file.endsWith('r.2.2.mca'), '应落到 r.2.2.mca，实际 ' + w.file);
    assert.strictEqual(anvil.readSaveChunk({ saveDir: save, dim: 'overworld', cx: 70, cz: 70 }).hash,
      anvil.hashOf(chunkNbt('new-70')));

    const w2 = anvil.writeSaveChunk({
      saveDir: save, dim: 'overworld', cx: 71, cz: 70, raw: chunkNbt('new-71'), backup: false
    });
    assert.strictEqual(w2.created, false, '同一 region 文件的第二个区块不该算新建');
  });

  await ta('scanSaveChunks：索引齐全、键是 cx,cz、同内容两次扫描指纹一致', async () => {
    const a = await anvil.scanSaveChunks({ saveDir: save, dim: 'overworld' });
    // 0,0 / 33,5 / -1,-1 / 70,70 / 71,70
    assert.strictEqual(a.chunks, 5, '主世界应有 5 个区块，实际 ' + a.chunks);
    assert.ok(a.index['0,0'] && a.index['33,5'] && a.index['-1,-1'], '键应形如 cx,cz');
    assert.strictEqual(a.broken, 0);
    assert.strictEqual(a.missing, false);

    const b = await anvil.scanSaveChunks({ saveDir: save, dim: 'overworld' });
    assert.deepStrictEqual(b.index, a.index, '没改动时两次扫描必须完全一致');
  });

  await ta('scanSaveChunks：entities 目录与各维度互不串味', async () => {
    const ent = await anvil.scanSaveChunks({ saveDir: save, dim: 'overworld', kind: 'entities' });
    assert.strictEqual(ent.chunks, 1);
    assert.strictEqual(ent.index['0,0'].hash, anvil.hashOf(chunkNbt('ent-0')));

    const ow = await anvil.scanSaveChunks({ saveDir: save, dim: 'overworld' });
    assert.notStrictEqual(ow.index['0,0'].hash, ent.index['0,0'].hash, '主世界与实体目录不该混在一起');

    const ne = await anvil.scanSaveChunks({ saveDir: save, dim: 'nether' });
    assert.strictEqual(ne.index['0,0'].hash, anvil.hashOf(chunkNbt('nether-0')));
  });

  await ta('scanSaveChunks：改一个区块只影响它自己的指纹', async () => {
    const before = await anvil.scanSaveChunks({ saveDir: save, dim: 'overworld' });
    anvil.writeSaveChunk({
      saveDir: save, dim: 'overworld', cx: 0, cz: 0, raw: chunkNbt('ow-0-v2'), backup: false
    });
    const after = await anvil.scanSaveChunks({ saveDir: save, dim: 'overworld' });

    const changed = Object.keys(after.index).filter((k) => after.index[k].hash !== before.index[k].hash);
    assert.deepStrictEqual(changed, ['0,0'], '只应有一个区块变化，实际 ' + JSON.stringify(changed));
  });

  await ta('scanSaveChunks：目录不存在时 missing=true 而不是抛错', async () => {
    const r = await anvil.scanSaveChunks({ saveDir: path.join(TMP, 'no-such-save'), dim: 'overworld' });
    assert.strictEqual(r.missing, true);
    assert.strictEqual(r.chunks, 0);
    assert.strictEqual(r.files, 0);
  });

  /* ================= 批量写入 / 删除 ================= */
  console.log('\n--- applySaveChunks（按 region 归并，每个文件只重打包一次） ---');

  const batch = path.join(TMP, 'batch');

  await ta('applySaveChunks：同一 region 的多个改动只重打包一次', async () => {
    const r = await anvil.applySaveChunks({
      saveDir: batch, dim: 'overworld', backup: false,
      puts: [
        { cx: 0, cz: 0, raw: chunkNbt('b0') },
        { cx: 1, cz: 0, raw: chunkNbt('b1') },
        { cx: 2, cz: 0, raw: chunkNbt('b2') }
      ]
    });
    assert.strictEqual(r.files, 1, '三个区块同属 r.0.0.mca，应只处理一个文件');
    assert.strictEqual(r.created, 1);
    assert.strictEqual(r.written, 3);
    assert.ok(fs.existsSync(path.join(batch, 'region', 'r.0.0.mca')));
    assert.strictEqual(anvil.readSaveChunk({ saveDir: batch, dim: 'overworld', cx: 1, cz: 0 }).hash,
      anvil.hashOf(chunkNbt('b1')));
  });

  await ta('applySaveChunks：写入与删除合并，仍只重打包那一个文件', async () => {
    const r = await anvil.applySaveChunks({
      saveDir: batch, dim: 'overworld', backup: false,
      puts: [{ cx: 3, cz: 0, raw: chunkNbt('b3') }],
      dels: [{ cx: 0, cz: 0 }]
    });
    assert.strictEqual(r.files, 1);
    assert.strictEqual(r.written, 1);
    assert.strictEqual(r.deleted, 1);
    assert.strictEqual(anvil.readSaveChunk({ saveDir: batch, dim: 'overworld', cx: 0, cz: 0 }), null);
    assert.strictEqual(anvil.readSaveChunk({ saveDir: batch, dim: 'overworld', cx: 2, cz: 0 }).hash,
      anvil.hashOf(chunkNbt('b2')), '同文件里的邻居不该被牵连');
  });

  await ta('applySaveChunks：删除不存在的区块不计入 deleted', async () => {
    const r = await anvil.applySaveChunks({
      saveDir: batch, dim: 'overworld', backup: false, dels: [{ cx: 20, cz: 20 }]
    });
    assert.strictEqual(r.deleted, 0);
  });

  await ta('applySaveChunks：目标文件不存在、只有删除 → 不凭空造一个空 region', async () => {
    const e = path.join(TMP, 'batch-empty');
    const r = await anvil.applySaveChunks({
      saveDir: e, dim: 'overworld', backup: false, dels: [{ cx: 0, cz: 0 }]
    });
    assert.strictEqual(r.files, 1);
    assert.strictEqual(r.created, 0);
    assert.strictEqual(fs.existsSync(path.join(e, 'region', 'r.0.0.mca')), false);
  });

  await ta('applySaveChunks：同一区块同时在 puts 和 dels 里时以删除为准', async () => {
    const c = path.join(TMP, 'batch-conflict');
    const r = await anvil.applySaveChunks({
      saveDir: c, dim: 'overworld', backup: false,
      puts: [{ cx: 0, cz: 0, raw: chunkNbt('会被删掉') }],
      dels: [{ cx: 0, cz: 0 }]
    });
    assert.strictEqual(r.written, 0, '不能写出一个"刚写进去又删掉"的假成功');
    assert.strictEqual(anvil.readSaveChunk({ saveDir: c, dim: 'overworld', cx: 0, cz: 0 }), null);
  });

  await ta('applySaveChunks：跨 region 时每个 region 各处理一次', async () => {
    const m = path.join(TMP, 'batch-multi');
    const r = await anvil.applySaveChunks({
      saveDir: m, dim: 'overworld', backup: false,
      puts: [
        { cx: -1, cz: -1, raw: chunkNbt('neg') },
        { cx: 0, cz: 0, raw: chunkNbt('zero') },
        { cx: 33, cz: 0, raw: chunkNbt('r1') }
      ]
    });
    assert.strictEqual(r.files, 3, '(-1,-1)/(0,0)/(33,0) 分属 r.-1.-1 / r.0.0 / r.1.0');
    assert.strictEqual(r.created, 3);
    assert.strictEqual(r.written, 3);
    // 负坐标与正坐标不能串味：槽位只按 & 31 归约，隔离全靠"选对文件"
    assert.strictEqual(anvil.readSaveChunk({ saveDir: m, dim: 'overworld', cx: -1, cz: -1 }).hash,
      anvil.hashOf(chunkNbt('neg')));
  });

  await ta('applySaveChunks：backup:false 时不留 .bak', async () => {
    await anvil.applySaveChunks({
      saveDir: batch, dim: 'overworld', backup: false,
      puts: [{ cx: 5, cz: 5, raw: chunkNbt('nb') }]
    });
    assert.strictEqual(fs.existsSync(path.join(batch, 'region', 'r.0.0.mca.bak')), false);
  });

  await ta('scanSaveChunks：onChunk 能拿到每个区块的未压缩字节与长度', async () => {
    const seen = [];
    const res = await anvil.scanSaveChunks({
      saveDir: batch, dim: 'overworld',
      onChunk: (key, raw, bytes) => seen.push({ key, raw, bytes })
    });
    assert.strictEqual(seen.length, res.chunks, 'onChunk 次数应与区块数一致');
    assert.ok(seen.length > 0);
    for (const s of seen) {
      assert.ok(Buffer.isBuffer(s.raw), 'raw 应是 Buffer');
      assert.strictEqual(anvil.hashOf(s.raw), res.index[s.key].hash, '回调里的字节与索引指纹对不上');
      assert.ok(s.bytes > 0);
    }
    // 回调拿到的字节可以直接解析成 NBT —— worldver 就是靠这个把区块收进对象库的
    const one = seen.find((s) => s.key === '1,0');
    assert.strictEqual(nbt.parse(one.raw).value.Marker, 'b1');
  });

  await ta('scanSaveChunks：不传 onChunk 时不报错（老调用点不受影响）', async () => {
    const r = await anvil.scanSaveChunks({ saveDir: batch, dim: 'overworld' });
    assert.ok(r.chunks > 0);
  });

  /* ---------- 收尾 ---------- */
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log('\n=== 结果 ===');
  console.log(`  通过 ${pass} | 失败 ${fail}`);
  if (fail) {
    console.log('  失败项：');
    for (const f of failures) console.log('    · ' + f);
  }
  process.exit(fail ? 1 : 0);
})();
