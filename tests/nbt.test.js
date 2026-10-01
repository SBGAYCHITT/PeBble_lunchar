// nbt 离线测试：类型推断、编码往返、压缩识别、实体计数、损坏数据的边界行为
// 重点：以前两份 NBT 实现都缺边界检查，这里把「损坏数据必须报错而不是静默错读」钉死。
const zlib = require('zlib');
const nbt = require('../nbt');
const mcapi = require('../mcapi');

let fail = 0;
function check(name, ok, extra) {
  console.log((ok ? '  ok  ' : ' FAIL ') + name + (extra ? ' -> ' + extra : ''));
  if (!ok) fail++;
}
function eq(name, got, want) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  check(name + ' (=' + JSON.stringify(want) + ')', same, same ? '' : 'got=' + JSON.stringify(got));
}
function throws(name, fn, re) {
  let msg = '';
  try { fn(); } catch (e) { msg = e.name + ':' + e.message; }
  check(name, !!msg && (!re || re.test(msg)), msg || '(没有抛错)');
}

/* ---------- 类型推断 ---------- */
console.log('=== 类型推断 tagOf ===');
eq('整数 → INT', nbt.tagOf(42), 3);
eq('超大整数 → LONG', nbt.tagOf(9007199254740991), 4);
eq('小数 → DOUBLE', nbt.tagOf(1.5), 6);
eq('字符串 → STRING', nbt.tagOf('hi'), 8);
eq('布尔 → BYTE', nbt.tagOf(true), 1);
eq('Int8Array → BYTE_ARRAY', nbt.tagOf(new Int8Array(2)), 7);
eq('Int32Array → INT_ARRAY', nbt.tagOf(new Int32Array(2)), 11);
eq('普通对象 → COMPOUND', nbt.tagOf({ a: 1 }), 10);
eq('数组 → LIST', nbt.tagOf([1, 2]), 9);
eq('null → null（不该猜）', nbt.tagOf(null), null);
eq('NaN → null（不该猜）', nbt.tagOf(NaN), null);

/* ---------- 编码 → 解码 往返 ---------- */
console.log('\n=== 序列化往返 ===');
function roundTrip(name, value, expect) {
  const buf = nbt.serialize('root', value);
  const back = nbt.parse(buf).value;
  // Int8Array/Int32Array 的 JSON 化是 {"0":..} 形式，先转成普通数组再比
  const norm = (v) => {
    if (v instanceof Int8Array || v instanceof Int32Array) return Array.from(v);
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, sub] of Object.entries(v)) o[k] = norm(sub);
      return o;
    }
    return v;
  };
  eq(name, norm(back), norm(expect !== undefined ? expect : value));
}

roundTrip('各基础类型', { i: 7, s: 'abc', d: 2.5, str: '中文' });
roundTrip('嵌套 compound', { a: { b: { c: 1 } } });
roundTrip('LIST<INT>', { xs: [1, 2, 3] });
roundTrip('LIST<STRING>', { xs: ['a', 'b'] });
roundTrip('空 LIST', { xs: [] });
roundTrip('BYTE_ARRAY', { bs: new Int8Array([1, -2, 3]) }, { bs: [1, -2, 3] });
roundTrip('INT_ARRAY', { is: new Int32Array([10, -20]) }, { is: [10, -20] });
roundTrip('复合混装', { n: 1, sub: { list: [1, 2], txt: 'x' }, arr: new Int8Array([5]) },
  { n: 1, sub: { list: [1, 2], txt: 'x' }, arr: [5] });

// 已知的类型提升（JS 侧无法区分 byte/long/float），明确断言以免后人误以为是对称的
const rt = nbt.parse(nbt.serialize('r', { b: true, big: 99999999999, f: 1.5 })).value;
eq('boolean 编码为 BYTE(1)', rt.b, 1);
eq('超 int32 编码为 LONG', rt.big, 99999999999);
eq('小数编码为 DOUBLE', rt.f, 1.5);

check('根名保留', nbt.serialize('Hello', {}) && nbt.parse(nbt.serialize('Hello', {})).name === 'Hello');
throws('LIST 元素类型不一致 → 报错', () => nbt.serialize('r', { xs: [1, 'a'] }), /类型不一致/);
throws('无法推断的字段 → 报错', () => nbt.serialize('r', { bad: null }), /无法推断/);

/* ---------- 压缩识别 ---------- */
console.log('\n=== 解压识别 ===');
const raw = nbt.serialize('root', { a: 1 });
eq('gzip 能被还原', nbt.parse(nbt.decompress(zlib.gzipSync(raw))).value, { a: 1 });
eq('zlib 能被还原', nbt.parse(nbt.decompress(zlib.deflateSync(raw))).value, { a: 1 });
eq('未压缩原样返回', nbt.decompress(raw).equals(raw), true);
throws('假 gzip → 明确报错', () => nbt.decompress(Buffer.from([0x1f, 0x8b, 1, 2, 3])), /gzip/);

/* ---------- 边界检查（旧实现会静默错读） ---------- */
console.log('\n=== 损坏数据必须报错 ===');
throws('根不是 COMPOUND → 报错', () => nbt.parse(Buffer.from([3, 0, 0])), /根标签/);
throws('字符串长度超出 buffer → 越界', () => {
  const b = Buffer.alloc(16);
  b[0] = 10; b.writeUInt16BE(0, 1);        // 根名空
  b[3] = 8; b.writeUInt16BE(9, 4); b.writeUInt16BE(100, 6); // string 声称 100 字节
  nbt.parse(b);
}, /越界/);
throws('LIST 长度异常 → 拦住（不死循环）', () => {
  const b = Buffer.concat([
    Buffer.from([10, 0, 0]),
    Buffer.from([9, 0, 0]),                       // 空名的 LIST
    Buffer.from([3]),                             // 元素类型 INT
    (() => { const x = Buffer.alloc(4); x.writeInt32BE(200000000); return x; })()
  ]);
  nbt.parse(b);
}, /长度异常/);
throws('未知类型 → 报错', () => {
  const b = Buffer.concat([Buffer.from([10, 0, 0]), Buffer.from([99, 0, 0])]);
  nbt.parse(b);
}, /未知 NBT 类型/);
throws('截断的 compound → 越界', () => nbt.parse(Buffer.from([10, 0, 0, 3, 0, 1])), /越界/);

/* ---------- level.dat 字段 ---------- */
console.log('\n=== level.dat 字段提取 ===');
eq('.Data 层级兼容', nbt.levelDatFields({ Data: { LevelName: 'w', GameType: 1 } }).LevelName, 'w');
eq('无 .Data 时取根', nbt.levelDatFields({ LevelName: 'w2' }).LevelName, 'w2');
eq('Version 是对象 → 取 Name',
  nbt.levelDatFields({ Version: { Name: '1.20.1', Id: 100 } }).Version, '1.20.1');
eq('Version 是标量 → 转字符串', nbt.levelDatFields({ Version: 19133 }).Version, '19133');
eq('空输入 → null', nbt.levelDatFields(null), null);
eq('缺失字段 → undefined 而不是崩', nbt.levelDatFields({}).Time, undefined);

// 端到端：真的写一个 gzip 的 level.dat 再读回来
const tmp = require('path').join(require('os').tmpdir(), 'pl-nbt-' + Date.now());
require('fs').mkdirSync(tmp, { recursive: true });
const datFile = require('path').join(tmp, 'level.dat');
require('fs').writeFileSync(datFile, zlib.gzipSync(nbt.serialize('', {
  Data: {
    LevelName: '测试世界', Version: { Name: '1.20.1' },
    GameType: 0, hardcore: 1, allowCommands: 0,
    LastPlayed: 1700000000000, Time: 12345, Difficulty: 2
  }
})));
const lv = mcapi.readLevelDat(datFile);
eq('readLevelDat 端到端', lv && lv.LevelName, '测试世界');
eq('readLevelDat Version', lv && lv.Version, '1.20.1');
eq('readLevelDat LastPlayed(long)', lv && lv.LastPlayed, 1700000000000);
eq('readLevelDat 对不存在文件返回 null', mcapi.readLevelDat(require('path').join(tmp, 'nope.dat')), null);
eq('readLevelDat 对损坏文件返回 null（不抛）',
  (require('fs').writeFileSync(datFile, Buffer.from([0x1f, 0x8b, 9, 9, 9])), mcapi.readLevelDat(datFile)), null);
require('fs').rmSync(tmp, { recursive: true, force: true });

/* ---------- 实体计数 ---------- */
console.log('\n=== 实体计数（区块） ===');
function chunkWith(entities) {
  const p = [Buffer.from([10]), Buffer.from([0, 0])];
  const name = Buffer.from('Entities', 'utf8');
  const nl = Buffer.alloc(2); nl.writeUInt16BE(name.length);
  p.push(Buffer.from([9]), nl, name, Buffer.from([10]));
  const c = Buffer.alloc(4); c.writeInt32BE(entities);
  p.push(c);
  for (let i = 0; i < entities; i++) p.push(Buffer.from([0]));
  p.push(Buffer.from([0]));
  return Buffer.concat(p);
}
eq('空区块 → 0', nbt.countEntities(chunkWith(0)), 0);
eq('300 实体', nbt.countEntities(chunkWith(300)), 300);
// block_entities 同样要计数（新版 MC 的方块实体）
const beName = Buffer.from('block_entities', 'utf8');
const beLen = Buffer.alloc(2); beLen.writeUInt16BE(beName.length);
eq('block_entities 也计数',
  nbt.countEntities(Buffer.concat([
    Buffer.from([10, 0, 0]),
    Buffer.from([9]), beLen, beName, Buffer.from([10]),
    (() => { const x = Buffer.alloc(4); x.writeInt32BE(5); return x; })(),
    Buffer.alloc(5),
    Buffer.from([0])
  ])), 5);
eq('非 compound 根 → 0', nbt.countEntities(Buffer.from([3, 0, 0])), 0);
eq('空 buffer → 0', nbt.countEntities(Buffer.alloc(0)), 0);

// 计数之后偏移必须落在末尾：结束符之后还有数据说明跳读跳错了
const full = chunkWith(4);
const r = new nbt._Reader(full);
r.u1(); r.str();
nbt._skip(r, 10);
// END 标签本身也会被消耗，所以正确偏移是 length（差一个字节就说明跳读漏了字段）
eq('跳读后偏移正确（正好读完根结束符）', r.p, full.length);

console.log('\n' + (fail === 0 ? '★ nbt 全部通过' : `★ nbt 有 ${fail} 项失败`));
process.exit(fail === 0 ? 0 : 1);
