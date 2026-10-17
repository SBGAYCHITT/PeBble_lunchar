/*
 * nbt.js「保类型编码」单测。
 *
 * 这个文件里有一套**独立的** NBT 编码器（下面的 PUT/N/LIST/COMPOUND/ROOT）。
 * 刻意不复用被测模块的 serialize —— 用被测代码生成期望值，等于自己证明自己。
 * 这里的编码器每一步都显式给类型，写出来的就是"游戏会写出的那种字节"。
 *
 * 要钉住的核心事实：区块里有一批字段，**JS 值看不出它原本是什么类型**。
 *   · PostProcessing 是 LIST of SHORT，里面存的全是 0 → 按值推断会写成 LIST of INT；
 *   · Entities[].Pos 是 LIST of DOUBLE，实体恰好站在整数坐标时全是整数 → 会被写成 LIST of INT；
 *   · sections[].Y、yPos 是 BYTE/SHORT → 会被写成 INT。
 * 游戏读这些字段时期望的类型是写死的，拿到别的类型直接抛异常。
 * 用户看到的是"区块损坏打不开"，而这个报错离真正的原因（写入端按值猜类型）十万八千里。
 */
const assert = require('assert');
const nbt = require('../nbt');

const T = nbt.T;
const { BYTE, SHORT, INT, LONG, FLOAT, DOUBLE, BYTE_ARRAY, STRING, LIST, COMPOUND, INT_ARRAY, LONG_ARRAY } = T;

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('这个用例是异步的，请改用 ta()');
    pass++; console.log('  ok   ' + name);
  } catch (e) { fail++; failures.push(name + ' -> ' + e.message); console.log(' FAIL  ' + name + ' -> ' + e.message); }
}

/* ================= 独立编码器（测试专用） ================= */
function cat(...bs) { return Buffer.concat(bs.filter((b) => b != null)); }
function u2(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }
function i4(n) { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; }

const PUT = {
  [BYTE]: (v) => { const b = Buffer.alloc(1); b.writeInt8(v); return b; },
  [SHORT]: (v) => { const b = Buffer.alloc(2); b.writeInt16BE(v); return b; },
  [INT]: (v) => i4(v),
  [LONG]: (v) => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(v)); return b; },
  [FLOAT]: (v) => { const b = Buffer.alloc(4); b.writeFloatBE(v); return b; },
  [DOUBLE]: (v) => { const b = Buffer.alloc(8); b.writeDoubleBE(v); return b; },
  [BYTE_ARRAY]: (v) => { const b = Buffer.alloc(v.length); v.forEach((n, i) => b.writeInt8(n, i)); return cat(i4(v.length), b); },
  [STRING]: (v) => { const b = Buffer.from(v, 'utf8'); return cat(u2(b.length), b); },
  [INT_ARRAY]: (v) => { const b = Buffer.alloc(v.length * 4); v.forEach((n, i) => b.writeInt32BE(n, i * 4)); return cat(i4(v.length), b); },
  [LONG_ARRAY]: (v) => { const b = Buffer.alloc(v.length * 8); v.forEach((n, i) => b.writeBigInt64BE(BigInt(n), i * 8)); return cat(i4(v.length), b); }
};

/** 带名字的标签：类型 + 名字长度 + 名字 + 载荷 */
function N(type, name, payload) {
  const nb = Buffer.from(name, 'utf8');
  return cat(Buffer.from([type]), u2(nb.length), nb, payload);
}
/** 无名载荷（LIST 元素用） */
function V(type, v) { return PUT[type](v); }
/** LIST：元素类型是显式给的，不靠元素反推 */
function L(type, vals) { return cat(Buffer.from([type]), i4(vals.length), ...vals.map((v) => PUT[type](v))); }
/** 已经是 Buffer 的元素（如 LIST of COMPOUND） */
function LB(type, bufs) { return cat(Buffer.from([type]), i4(bufs.length), ...bufs); }
function CP(fields) { return cat(...fields, Buffer.from([T.END])); }
function ROOT(name, fields) {
  const nb = Buffer.from(name, 'utf8');
  return cat(Buffer.from([COMPOUND]), u2(nb.length), nb, CP(fields));
}

/* ================= 一个真实形态的区块 ================= */
const PALETTE = ['minecraft:air', 'minecraft:stone', 'minecraft:dirt', 'minecraft:grass_block'];
const CHEST_X = -40, CHEST_Y = 65, CHEST_Z = 113;

function realChunk() {
  const section = CP([
    N(BYTE, 'Y', V(BYTE, 0)),
    N(COMPOUND, 'block_states', CP([
      N(LIST, 'palette', LB(COMPOUND, PALETTE.map((n) => CP([N(STRING, 'Name', V(STRING, n))])))),
      N(LONG_ARRAY, 'data', V(LONG_ARRAY, [0n, -1n, 1234567890123456789n, 0n]))
    ])),
    N(COMPOUND, 'biomes', CP([
      N(LIST, 'palette', L(STRING, ['minecraft:plains', 'minecraft:forest'])),
      N(LONG_ARRAY, 'data', V(LONG_ARRAY, [0n, -1n]))
    ])),
    N(BYTE_ARRAY, 'BlockLight', V(BYTE_ARRAY, new Array(24).fill(0))),
    N(BYTE_ARRAY, 'SkyLight', V(BYTE_ARRAY, new Array(24).fill(-1)))
  ]);

  return ROOT('', [
    N(INT, 'DataVersion', V(INT, 3465)),
    N(INT, 'xPos', V(INT, -3)),
    N(INT, 'zPos', V(INT, 7)),
    N(SHORT, 'yPos', V(SHORT, -4)),
    N(STRING, 'Status', V(STRING, 'full')),
    N(LONG, 'LastUpdate', V(LONG, 1234567n)),
    N(LONG, 'InhabitedTime', V(LONG, 99999n)),
    N(BYTE, 'isLightOn', V(BYTE, 1)),

    /* ← 关键字段一：区块自己的 LIST of SHORT，值全是 0 */
    N(LIST, 'PostProcessing', L(SHORT, new Array(64).fill(0))),

    N(LIST, 'sections', LB(COMPOUND, [section])),

    N(LIST, 'block_entities', LB(COMPOUND, [
      CP([
        N(STRING, 'id', V(STRING, 'minecraft:chest')),
        N(INT, 'x', V(INT, CHEST_X)),
        N(INT, 'y', V(INT, CHEST_Y)),
        N(INT, 'z', V(INT, CHEST_Z)),
        N(BYTE, 'KeepPacked', V(BYTE, 0)),
        N(LIST, 'Items', LB(COMPOUND, [
          CP([
            N(STRING, 'id', V(STRING, 'minecraft:diamond_sword')),
            N(BYTE, 'Count', V(BYTE, 1)),
            N(BYTE, 'Slot', V(BYTE, 13))
          ])
        ]))
      ])
    ])),

    N(LIST, 'Entities', LB(COMPOUND, [
      CP([
        N(STRING, 'id', V(STRING, 'minecraft:pig')),
        /* ← 关键字段二：实体正好站在整数坐标，Pos 是 LIST of DOUBLE 却看不出小数 */
        N(LIST, 'Pos', L(DOUBLE, [100, 64, -200])),
        N(LIST, 'Motion', L(DOUBLE, [0, 0, 0])),
        N(LIST, 'Rotation', L(FLOAT, [90.5, 0])),
        N(BYTE, 'OnGround', V(BYTE, 1)),
        N(SHORT, 'Health', V(SHORT, 10))
      ])
    ])),

    N(COMPOUND, 'Heightmaps', CP([
      N(LONG_ARRAY, 'MOTION_BLOCKING', V(LONG_ARRAY, [1n, 2n, 3n])),
      N(LONG_ARRAY, 'WORLD_SURFACE', V(LONG_ARRAY, [-1n, 7n]))
    ])),

    /* ← 关键字段三：空列表，元素类型只存在于头部一个字节里 */
    N(LIST, 'block_ticks', LB(COMPOUND, [])),

    N(COMPOUND, 'structures', CP([
      N(COMPOUND, 'starts', CP([
        N(COMPOUND, 'minecraft:village', CP([
          N(LIST, 'Children', LB(COMPOUND, []))
        ]))
      ])),
      N(COMPOUND, 'References', CP([]))
    ]))
  ]);
}

/** 逐字节差异位置 */
function diffAt(a, b) {
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

/* ================= round-trip ================= */
t('真实形态区块：带类型表 round-trip 字节完全相同', () => {
  const raw = realChunk();
  const r = nbt.roundTrip(raw);
  assert.strictEqual(r.identical, true,
    '长度 ' + r.out.length + ' vs ' + raw.length + '，差异 ' + diffAt(raw, r.out).length + ' 字节');
});

t('不看编码器脸色：字段值确实被解出来了', () => {
  const tree = nbt.parse(realChunk()).value;
  assert.strictEqual(tree.yPos, -4);
  assert.strictEqual(tree.Status, 'full');
  assert.strictEqual(tree.sections.length, 1);
  assert.strictEqual(tree.sections[0].Y, 0);
  assert.strictEqual(tree.block_entities[0].id, 'minecraft:chest');
  assert.strictEqual(tree.block_entities[0].x, CHEST_X);
  assert.strictEqual(tree.Entities[0].Pos[0], 100);
  assert.strictEqual(tree.PostProcessing.length, 64);
  assert.strictEqual(tree.block_ticks.length, 0);
  assert.strictEqual(tree.structures.starts['minecraft:village'].Children.length, 0);
});

/* ================= 反例：不带类型表会写坏 ================= */
t('反例：不带类型表，PostProcessing 会被写成 LIST of INT', () => {
  const raw = realChunk();
  const out = nbt.serialize('', nbt.parse(raw).value);   // ← 故意不给类型表
  // 布局：[type=LIST][len=00 0E]['PostProcessing'][元素类型][元素个数]
  // 名字之后紧跟的那一个字节就是元素类型
  const key = 'PostProcessing';
  const ra = raw.indexOf(Buffer.from(key, 'utf8')) + key.length;
  const oa = out.indexOf(Buffer.from(key, 'utf8')) + key.length;
  assert.strictEqual(raw[ra], SHORT, '原文件里 PostProcessing 是 LIST of SHORT');
  assert.strictEqual(out[oa], INT, '不带类型表就被写成了 LIST of INT（每个元素多 2 字节）');
  assert.ok(out.length > raw.length, '整体长度也变长了');
});

t('反例：实体站在整数坐标时，Pos 会被写成 LIST of INT', () => {
  const raw = realChunk();
  const out = nbt.serialize('', nbt.parse(raw).value);   // ← 自动在 PostProcessing 之后找
  const key = Buffer.from('Pos', 'utf8');
  const ra = raw.indexOf(key, raw.indexOf(Buffer.from('minecraft:pig', 'utf8'))) + 3;
  const oa = out.indexOf(key, out.indexOf(Buffer.from('minecraft:pig', 'utf8'))) + 3;
  assert.strictEqual(raw[ra], DOUBLE, '原文件里 Pos 是 LIST of DOUBLE');
  assert.strictEqual(out[oa], INT, '值恰好是整数，就被误判成 INT 了');
});

t('空 LIST 的元素类型也能保住（不带表时会退化成 END）', () => {
  const raw = realChunk();
  const types = nbt.newTypes();
  const out = nbt.serialize('', nbt.parse(raw, types).value, types);
  assert.strictEqual(out.equals(raw), true);

  const out2 = nbt.serialize('', nbt.parse(raw).value);
  const key = 'block_ticks';
  const a = raw.indexOf(Buffer.from(key, 'utf8')) + key.length;
  const b = out2.indexOf(Buffer.from(key, 'utf8')) + key.length;
  assert.strictEqual(raw[a], COMPOUND, '原文件里空列表声明的是「元素为 COMPOUND」');
  assert.strictEqual(out2[b], T.END, '不带表就丢了，退化成 END —— 游戏读它时元素类型对不上');
});

/* ================= 局部改写：只动目标字段 ================= */
t('只改一个 SHORT 字段（yPos），差异恰好落在那 2 个字节上', () => {
  const raw = realChunk();
  const types = nbt.newTypes();
  const tree = nbt.parse(raw, types).value;
  assert.strictEqual(tree.yPos, -4);
  tree.yPos = 5;
  const out = nbt.serialize('', tree, types);

  assert.strictEqual(out.length, raw.length, '长度必须不变（类型变了长度就会变）');
  const name = raw.indexOf(Buffer.from('yPos', 'utf8'));
  const at = diffAt(raw, out);
  // 布局：[type=SHORT][nameLen=00 04]['yPos'][2 字节值]，所以值在名字起点 +4、+5
  assert.deepStrictEqual(at, [name + 4, name + 5],
    '差异应当只在 yPos 的值里，实际落在 ' + JSON.stringify(at));
});

t('平移建筑改 BlockEntities 的 x/y/z：其余字段一个字节都不动', () => {
  const raw = realChunk();
  const types = nbt.newTypes();
  const tree = nbt.parse(raw, types).value;
  // 整区块平移 64 格（= 4 个区块），容器坐标必须跟着走
  const be = tree.block_entities[0];
  assert.strictEqual(be.x, CHEST_X);
  be.x = CHEST_X + 64;

  const out = nbt.serialize('', tree, types);
  assert.strictEqual(out.length, raw.length);
  const idEnd = raw.indexOf(Buffer.from('minecraft:chest', 'utf8')) + 'minecraft:chest'.length;
  // 之后是：[type=INT][nameLen=00 01]['x'][4 字节值]
  const valAt = idEnd + 1 + 2 + 1;
  assert.deepStrictEqual(diffAt(raw, out), [valAt, valAt + 1, valAt + 2, valAt + 3]);
});

t('平移实体改 Pos：LIST of DOUBLE 里塞整数也必须还是 DOUBLE', () => {
  const raw = realChunk();
  const types = nbt.newTypes();
  const tree = nbt.parse(raw, types).value;
  tree.Entities[0].Pos[0] = 164;      // 整数！正是最容易写坏的形态
  tree.Entities[0].Pos[2] = -136;
  const out = nbt.serialize('', tree, types);
  assert.strictEqual(out.length, raw.length);
  const idx = out.indexOf(Buffer.from('Pos', 'utf8'), out.indexOf(Buffer.from('minecraft:pig', 'utf8')));
  assert.strictEqual(out[idx + 3], DOUBLE, '元素类型必须保持 DOUBLE');
  const back = nbt.parse(out).value;
  assert.deepStrictEqual(back.Entities[0].Pos, [164, 64, -136]);
});

/* ================= fitsType 与失败模式 ================= */
t('fitsType：SHORT 的上限就是 32767，不接受 tagOf 那套推断', () => {
  assert.strictEqual(nbt.fitsType(0, SHORT), true, 'SHORT 里的 0 是合法的，哪怕 tagOf 说它是 INT');
  assert.strictEqual(nbt.fitsType(32767, SHORT), true);
  assert.strictEqual(nbt.fitsType(-32768, SHORT), true);
  assert.strictEqual(nbt.fitsType(32768, SHORT), false);
  assert.strictEqual(nbt.fitsType(0, BYTE), true);
  assert.strictEqual(nbt.fitsType(127, BYTE), true);
  assert.strictEqual(nbt.fitsType(128, BYTE), false);
  assert.strictEqual(nbt.fitsType(true, BYTE), true);
  assert.strictEqual(nbt.fitsType(1.5, INT), false);
  assert.strictEqual(nbt.fitsType(1.5, DOUBLE), true);
  assert.strictEqual(nbt.fitsType(2 ** 53, LONG), false, '超出安全整数的 LONG 已经不是原值了');
  assert.strictEqual(nbt.fitsType(2n ** 60n, LONG), true);
  assert.strictEqual(nbt.fitsType([1], LIST), true);
  assert.strictEqual(nbt.fitsType([1], COMPOUND), false);
});

t('把 SHORT 字段塞进超范围的值 → 直接报错，不写坏数据', () => {
  const types = nbt.newTypes();
  const tree = nbt.parse(realChunk(), types).value;
  tree.yPos = 70000;                   // SHORT 装不下
  assert.throws(() => nbt.serialize('', tree, types), /yPos/,
    '错误信息里必须点名字段，否则排查要翻半天');
});

t('把非整数塞进 INT 字段 → 报错', () => {
  const types = nbt.newTypes();
  const tree = nbt.parse(realChunk(), types).value;
  tree.xPos = 1.5;
  assert.throws(() => nbt.serialize('', tree, types), /xPos/);
});

t('改 list 元素类型不一致 → 报错', () => {
  const types = nbt.newTypes();
  const tree = nbt.parse(realChunk(), types).value;
  tree.Entities[0].Pos.push('不是数字');
  assert.throws(() => nbt.serialize('', tree, types), /LIST 第 3 项/);
});

t('LIST of SHORT 里塞进超出 SHORT 的值 → 报错（这才是真会踩的场景）', () => {
  const types = nbt.newTypes();
  const tree = nbt.parse(realChunk(), types).value;
  assert.strictEqual(tree.PostProcessing.length, 64);
  tree.PostProcessing[7] = 40000;      // 40000 装不进 SHORT
  assert.throws(() => nbt.serialize('', tree, types), /LIST 第 7 项放不进 SHORT/);
});

/* ================= 向后兼容 ================= */
t('不给类型表时行为不变：老调用点 serialize(name, value) 照样能用', () => {
  const obj = { a: 1, b: 'x', c: [1, 2, 3], d: { e: 2.5 } };
  const buf = nbt.serialize('hello', obj);
  const back = nbt.parse(buf);
  assert.strictEqual(back.name, 'hello');
  assert.deepStrictEqual(back.value, obj);
});

t('新增字段（旁路表里没有）仍按值推断，不会因为表的存在而写不出去', () => {
  const types = nbt.newTypes();
  const tree = nbt.parse(realChunk(), types).value;
  tree.extraField = '测试';
  const out = nbt.serialize('', tree, types);
  const back = nbt.parse(out).value;
  assert.strictEqual(back.extraField, '测试');
});

t('旁路表是 WeakMap：同一份数据重复解析不会互相干扰', () => {
  const raw = realChunk();
  for (let i = 0; i < 3; i++) {
    const ty = nbt.newTypes();
    const tr = nbt.parse(raw, ty).value;
    tr.yPos = i;
    const out = nbt.serialize('', tr, ty);
    assert.strictEqual(nbt.parse(out).value.yPos, i);
  }
});

t('两份不同的树共用一张表也不会串（表按对象索引，不按名字）', () => {
  const raw = realChunk();
  const types = nbt.newTypes();
  const a = nbt.parse(raw, types).value;
  const b = nbt.parse(raw, types).value;
  a.yPos = 1; b.yPos = 2;
  const oa = nbt.serialize('', a, types);
  const ob = nbt.serialize('', b, types);
  assert.strictEqual(nbt.parse(oa).value.yPos, 1);
  assert.strictEqual(nbt.parse(ob).value.yPos, 2);
  assert.strictEqual(oa.equals(ob), false);
});

t('idempotent：连续 round-trip 三次字节仍然不变', () => {
  let cur = realChunk();
  const first = cur;
  for (let i = 0; i < 3; i++) {
    const r = nbt.roundTrip(cur);
    assert.strictEqual(r.identical, true, '第 ' + (i + 1) + ' 次就不一致了');
    cur = r.out;
  }
  assert.strictEqual(cur.equals(first), true);
});

/* ================= node 表：换了新数组也要保住类型 ================= */
t('原地改数组内容 → 类型自然保住（推荐写法）', () => {
  const types = nbt.newTypes();
  const tree = nbt.parse(realChunk(), types).value;
  const data = tree.sections[0].block_states.data;
  assert.strictEqual(data.length, 4);
  data[0] = -1n;            // 原地改，还是同一个数组对象 → 表里查得到
  const out = nbt.serialize('', tree, types);
  assert.strictEqual(out.length, realChunk().length, '长度不能变（变成长度就说明类型变了）');
});

t('换同一字段名下的新数组：字段名表直接命中，不用额外登记', () => {
  const raw = realChunk();
  const types = nbt.newTypes();
  const tree = nbt.parse(raw, types).value;
  tree.sections[0].block_states.data = [1n, 2n, 3n, -4n];   // 换了新数组
  const out = nbt.serialize('', tree, types);
  assert.strictEqual(out.length, raw.length,
    'block_states.data 这个字段名在表里记着 LONG_ARRAY，换数组不影响');
  assert.deepStrictEqual(nbt.parse(out).value.sections[0].block_states.data, [1n, 2n, 3n, -4n]);
});

t('新造的复合节点里的 long 数组：只有 node 表能救它', () => {
  const raw = realChunk();
  const types = nbt.newTypes();
  const tree = nbt.parse(raw, types).value;
  const arr = [1n, 2n, 3n];
  tree.newSection = { data: arr };     // 整个 compound 都是新造的，字段名表里没有

  const bad = nbt.serialize('', tree, types);
  const ty1 = nbt.newTypes();
  const back1 = nbt.parse(bad, ty1).value;
  assert.strictEqual(ty1.node.get(back1.newSection.data), LIST,
    '没有登记时按值推断成了 LIST —— 这正是要防的那种静默改类型');

  types.node.set(arr, LONG_ARRAY);     // ← 显式登记
  const good = nbt.serialize('', tree, types);
  assert.strictEqual(bad.length - good.length, 1,
    'LONG_ARRAY 头是 4 字节（只有个数），LIST 头是 5 字节（元素类型 + 个数），正好差 1');
  const ty2 = nbt.newTypes();
  const back2 = nbt.parse(good, ty2).value;
  assert.strictEqual(ty2.node.get(back2.newSection.data), LONG_ARRAY);
  assert.deepStrictEqual(back2.newSection.data, [1n, 2n, 3n]);
});

t('node 表也能认出 LONG_ARRAY 和 LIST 的区别（它们在 JS 里都是 Array）', () => {
  const types = nbt.newTypes();
  const tree = nbt.parse(realChunk(), types).value;
  assert.strictEqual(types.node.get(tree.sections[0].block_states.data), LONG_ARRAY);
  assert.strictEqual(types.node.get(tree.PostProcessing), LIST);
  assert.strictEqual(types.node.get(tree.sections), LIST);
  assert.strictEqual(types.node.get(tree.Heightmaps), COMPOUND);
  assert.strictEqual(types.node.get(tree.sections[0].BlockLight), BYTE_ARRAY);
  assert.strictEqual(types.list.get(tree.PostProcessing), SHORT, 'LIST 的元素类型也要在表里');
});

/* ================= 汇总 ================= */
console.log('\n=== nbt.js 保类型编码 结果 ===');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (failures.length) {
  console.log('失败清单:');
  for (const f of failures) console.log('  · ' + f);
}
process.exit(fail ? 1 : 0);
