/*
 * blockstate.js（方块状态解码）单测。
 *
 * 这个模块的 bug 全是「静默给错方块」——不报错、不崩溃，方块名还合法，只是整体错位。
 * 所以测试的重点不是"能不能跑通"，而是**把两种打包方式的差异钉死**：
 *   1.6 起位打包从不跨 long 改成不跨 long。5 bits / 7 bits / 9 bits 这些不整除 64 的
 *   位宽下，两个解码器会给出不同结果。用例必须证明"用错了就会解错"，
 *   否则以后有人看着两个函数形似就把它们合并，错误无声无息地进来。
 *
 * 另有一批用例专门盯布局探测：1.18 把小写 sections 提到顶层、y 可以为负；
 * 只认 Level.Sections 的实现在 1.18+ 存档上拿到 undefined，地图整片空掉不报错。
 */
const assert = require('assert');
const nbt = require('../nbt');
const bs = require('../blockstate');

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; failures.push(name + ' -> ' + e.message); console.log(' FAIL  ' + name + ' -> ' + e.message); }
}

console.log('\n=== blockstate.js 单测 ===\n');

/* ============ 测试用的打包器 ============
   刻意**不复用**被测模块的写入逻辑：如果两者共用同一段代码，
   "打包→解包"往返测试永远通过，却证明不了与 Minecraft 真实布局一致。
   这里的实现按 wiki 的位布局独立写一遍。 */

const M64 = (1n << 64n) - 1n;

/** 打包结果统一转成**有符号** 64 位 —— 这一步不能省。
    nbt 的 LONG_ARRAY 是 readBigInt64BE 出来的有符号 BigInt，而"有符号"正是
    `>>` 会补 1 的原因。返回无符号数组的话，解码端那个 bug 根本复现不出来。 */
function asSigned(words) { return words.map((v) => BigInt.asIntN(64, v)); }

/** 交叉打包（≤1.15.2）：索引连续占位，可跨 long 边界 */
function packCrossing(seq, bits, total) {
  const nLongs = Math.ceil(total * bits / 64);
  const out = new Array(nLongs).fill(0n);
  for (let i = 0; i < total; i++) {
    const v = BigInt(seq[i]);
    const off0 = i * bits;
    const li = Math.floor(off0 / 64);
    const off = off0 % 64;
    out[li] |= (v << BigInt(off)) & M64;
    if (off + bits > 64) out[li + 1] |= v >> BigInt(64 - off);
  }
  return asSigned(out);
}

/** 填充打包（≥1.16）：索引不跨 long，尾部剩余位当填充 */
function packPadded(seq, bits, total) {
  const per = Math.floor(64 / bits);
  const nLongs = Math.ceil(total / per);
  const out = new Array(nLongs).fill(0n);
  for (let i = 0; i < total; i++) {
    const li = Math.floor(i / per);
    const off = (i % per) * bits;
    out[li] |= BigInt(seq[i]) << BigInt(off);
  }
  return asSigned(out);
}

/** 生成一段固定但"每个下标都不同"的索引序列，便于逐点比对 */
function seq4096(len) {
  const a = new Array(4096);
  for (let i = 0; i < 4096; i++) a[i] = (i * 7 + (i >> 3)) % len;
  return a;
}

/* ============ 1. 位宽 ============ */
t('bitsFor：1 个不占位、其余下限 4 位、按需增长', () => {
  assert.strictEqual(bs.bitsFor(1), 0);
  assert.strictEqual(bs.bitsFor(2), 4);
  assert.strictEqual(bs.bitsFor(16), 4);
  assert.strictEqual(bs.bitsFor(17), 5);
  assert.strictEqual(bs.bitsFor(32), 5);
  assert.strictEqual(bs.bitsFor(33), 6);
  assert.strictEqual(bs.bitsFor(4096), 12);
});

/* ============ 2. 两种打包必须互不兼容 ============ */
for (const bits of [4, 5, 6, 7, 9, 12]) {
  const palLen = Math.max(2, 1 << bits);
  const seq = seq4096(palLen);
  const cross = packCrossing(seq, bits, 4096);
  const pad = packPadded(seq, bits, 4096);

  t(`交叉打包往返自洽（${bits} bits）`, () => {
    for (let i = 0; i < 4096; i++) {
      assert.strictEqual(bs.packedIndexCrossing(cross, i, bits), seq[i], '下标 ' + i);
    }
  });

  t(`填充打包往返自洽（${bits} bits）`, () => {
    for (let i = 0; i < 4096; i++) {
      assert.strictEqual(bs.packedIndexPadded(pad, i, bits), seq[i], '下标 ' + i);
    }
  });

  if (64 % bits === 0 || bits === 4) {
    // 位宽整除 64（4/8/16）时两者布局恰好一致，这是可接受的巧合，不参与"必须不同"的断言
    continue;
  }
  t(`用错解码器必须解错（${bits} bits）`, () => {
    let wrong = 0;
    for (let i = 0; i < 4096; i++) {
      if (bs.packedIndexPadded(cross, i, bits) !== seq[i]) wrong++;
    }
    assert.ok(wrong > 0,
      `${bits} bits 下填充解码器读交叉数据竟然完全正确 —— 说明两个函数被写成了同一份逻辑`);
  });
}

t('packedIndex 保持向后兼容 = 交叉打包', () => {
  const seq = seq4096(32);
  const cross = packCrossing(seq, 5, 4096);
  for (let i = 0; i < 4096; i++) assert.strictEqual(bs.packedIndex(cross, i, 5), seq[i]);
});

/* ============ 3. 打包方式的判定 ============ */
/**
 * 造一个"看起来像真区块"的调色板容器。
 * 索引序列固定但每个下标都不同，便于逐点比对。
 */
function mkContainer(bits, packing) {
  const palLen = Math.max(2, 1 << bits);
  const palette = [];
  for (let i = 0; i < palLen; i++) palette.push({ Name: 'minecraft:b' + i });
  const data = new Array(4096).fill(0).map((_, i) => (i * 7 + (i >> 3)) % palLen);
  const longs = packing === 'cross' ? packCrossing(data, bits, 4096) : packPadded(data, bits, 4096);
  return { palette, data: longs, expected: data };
}

t('long 个数是硬判据：1.16 更新日志的 320 → 342', () => {
  // 5 bits 时，交叉打包 4096*5/64 = 320 个 long；填充打包每 long 放 12 个 → 342 个。
  // 这个差值就是 1.16 那次改动"存档略微变大"的来源，也是这里区分两种布局最硬的信号。
  assert.deepStrictEqual(bs.longCount(5, 4096), { padded: 342, crossing: 320, identical: false });
  assert.strictEqual(bs.longCount(4, 4096).identical, true);   // 4/8/16 位整除 64，两种布局一致
  assert.strictEqual(bs.longCount(12, 4096).padded, 820);
  assert.strictEqual(bs.longCount(12, 4096).crossing, 768);
});

t('DataVersion 2230（1.15.2）+ 交叉数据 → 判为交叉', () => {
  const c = mkContainer(5, 'cross');
  const r = bs.decodeContainer(c, 2230);
  assert.strictEqual(r.crossing, true);
  for (let i = 0; i < 4096; i++) assert.strictEqual(r.idx[i], c.expected[i], '下标 ' + i);
});

t('DataVersion 3465（1.18）+ 填充数据 → 判为填充', () => {
  const c = mkContainer(5, 'pad');
  const r = bs.decodeContainer(c, 3465);
  assert.strictEqual(r.crossing, false);
  for (let i = 0; i < 4096; i++) assert.strictEqual(r.idx[i], c.expected[i], '下标 ' + i);
});

t('DataVersion 缺失时靠 long 个数判对（交叉）', () => {
  const c = mkContainer(5, 'cross');
  const r = bs.decodeContainer(c, 0);
  assert.strictEqual(r.crossing, true);
  for (let i = 0; i < 4096; i++) assert.strictEqual(r.idx[i], c.expected[i], '下标 ' + i);
});

t('DataVersion 缺失时靠 long 个数判对（填充）', () => {
  const c = mkContainer(5, 'pad');
  const r = bs.decodeContainer(c, 0);
  assert.strictEqual(r.crossing, false);
  for (let i = 0; i < 4096; i++) assert.strictEqual(r.idx[i], c.expected[i], '下标 ' + i);
});

t('DataVersion 谎报也不会解错：数据本身说了算', () => {
  // 填充打包的数据，却声称自己是 1.15.2 的存档。
  // 早期版本这里靠"下标越界"来自检 —— 实测 5 bits 下越界数为 0，根本救不回来；
  // 现在靠 long 个数（342 ≠ 320），谎报无效。
  const c = mkContainer(5, 'pad');
  const r = bs.decodeContainer(c, 2230);
  assert.strictEqual(r.crossing, false, '应当无视谎报的 DataVersion');
  for (let i = 0; i < 4096; i++) assert.strictEqual(r.idx[i], c.expected[i], '下标 ' + i);
});

t('数据长度不标准时退回填充位判据', () => {
  const c = mkContainer(5, 'cross');
  const bogus = { palette: c.palette, data: c.data.concat([0n, 0n, 0n]) }; // 长度两边都不匹配
  assert.strictEqual(bs.paddingBitsAllZero(c.data, 5), false, '交叉数据的填充位必然非零');
  const r = bs.decodeContainer(bogus, 0);
  assert.strictEqual(r.crossing, true, '填充位非零 → 交叉');
});

t('单元素调色板：没有 data 也要填满整个 section', () => {
  const c = { palette: [{ Name: 'minecraft:stone' }], data: null };
  const r = bs.decodeContainer(c, 3465);
  assert.strictEqual(r.idx.length, 4096);
  for (let i = 0; i < 4096; i++) assert.strictEqual(r.idx[i], 0);
});

/* ============ 4. 调色板名规范化 ============ */
t('属性按 key 排序，书写顺序不影响结果', () => {
  const a = bs.entryName({ Name: 'minecraft:oak_stairs', Properties: { facing: 'north', half: 'bottom' } });
  const b = bs.entryName({ Name: 'minecraft:oak_stairs', Properties: { half: 'bottom', facing: 'north' } });
  assert.strictEqual(a, b);
  assert.strictEqual(a, 'minecraft:oak_stairs[facing=north,half=bottom]');
});

t('字符串形式的调色板条目（全默认状态简写）', () => {
  assert.strictEqual(bs.entryName('minecraft:stone'), 'minecraft:stone');
  assert.strictEqual(bs.entryName('stone'), 'minecraft:stone');
});

t('没有属性时不留空方括号', () => {
  assert.strictEqual(bs.entryName({ Name: 'minecraft:dirt', Properties: {} }), 'minecraft:dirt');
  assert.strictEqual(bs.entryName({ Name: 'minecraft:dirt' }), 'minecraft:dirt');
});

/* ============ 5. 布局探测 ============ */
function mkSection18(y, palette, data) {
  return { Y: y, block_states: { palette, data } };
}

t('1.18：顶层小写 sections 能被找到', () => {
  const root = { DataVersion: 3465, sections: [mkSection18(-4, [{ Name: 'minecraft:stone' }], null)] };
  assert.strictEqual(bs.sectionsOf(root).length, 1);
});

t('1.17：Level.Sections 能被找到', () => {
  const root = { DataVersion: 2724, Level: { Sections: [mkSection18(0, [{ Name: 'minecraft:stone' }], null)] } };
  assert.strictEqual(bs.sectionsOf(root).length, 1);
});

t('1.13~1.15：Palette + BlockStates 也能认', () => {
  const pal = [{ Name: 'minecraft:stone' }, { Name: 'minecraft:dirt' }];
  const data = new Array(4096).fill(0).map((_, i) => i % 2);
  const root = {
    DataVersion: 2230,
    Level: { Sections: [{ Y: 4, Palette: pal, BlockStates: packCrossing(data, 4, 4096) }] }
  };
  assert.strictEqual(bs.sectionsOf(root).length, 1);
  const c = bs.containerOf(bs.sectionsOf(root)[0]);
  assert.strictEqual(c.palette.length, 2);
});

t('史前字节格式必须显式判为不支持，不能猜方块名', () => {
  const root = {
    DataVersion: 1343,
    Level: { Sections: [{ Y: 0, Blocks: new Int8Array(4096), Add: new Int8Array(2048) }] }
  };
  const sup = bs.supportLevel(root);
  assert.strictEqual(sup.ok, false);
  assert.ok(/1\.12|全局方块 ID/.test(sup.reason), '理由要说清是格式不支持: ' + sup.reason);
});

/* ============ 6. 端到端：真实 NBT 往返 ============ */
/** 造一个 1.18 风格的区块 NBT（走 nbt.serialize，确保字节级往返） */
function mkChunk18(ySections) {
  const sections = ySections.map((s) => ({
    Y: s.y,
    block_states: {
      palette: s.palette,
      data: s.longs ? BigInt64Array.from(s.longs) : undefined
    }
  }));
  // undefined 字段会被 tagOf 拒掉，这里手动剔除
  for (const s of sections) if (s.block_states.data === undefined) delete s.block_states.data;
  return nbt.serialize('', { DataVersion: 3465, xPos: 0, zPos: 0, sections });
}

t('blockAt 端到端：y→z→x 索引顺序正确', () => {
  // 一个 section，调色板 4 色，索引按 (y*16+z)*16+x 编出来，逐点校验 round-trip
  const palLen = 4;
  const palette = [{ Name: 'minecraft:a' }, { Name: 'minecraft:b' },
    { Name: 'minecraft:c' }, { Name: 'minecraft:d' }];
  const seq = new Array(4096).fill(0).map((_, i) => (i * 3 + (i >> 5)) % palLen);
  const raw = mkChunk18([{ y: 4, palette, longs: packPadded(seq, 4, 4096) }]);
  const root = nbt.parse(raw).value;
  let checked = 0;
  for (let ly = 0; ly < 16; ly++) {
    for (let z = 0; z < 16; z += 5) {
      for (let x = 0; x < 16; x += 5) {
        const want = palette[seq[(ly * 16 + z) * 16 + x]].Name;
        assert.strictEqual(bs.blockAt(root, x, 64 + ly, z), want,
          `x=${x} y=${64 + ly} z=${z}`);
        checked++;
      }
    }
  }
  assert.ok(checked >= 40);
});

t('blockAt：坐标对负数的取模不能偏移', () => {
  const palette = [{ Name: 'minecraft:stone' }, { Name: 'minecraft:dirt' }];
  const seq = new Array(4096).fill(0).map((_, i) => i % 2);
  const raw = mkChunk18([{ y: -4, palette, longs: packPadded(seq, 4, 4096) }]);
  const root = nbt.parse(raw).value;
  // x=-1 与 x=15 是同一列，z=-1 与 z=15 是同一列
  assert.strictEqual(bs.blockAt(root, -1, -64, -1), bs.blockAt(root, 15, -64, 15));
  assert.strictEqual(bs.blockAt(root, -16, -64, -16), bs.blockAt(root, 0, -64, 0));
});

t('blockAt：坐标不在任何 section 里返回 null', () => {
  const raw = mkChunk18([{ y: 4, palette: [{ Name: 'minecraft:stone' }] }]);
  const root = nbt.parse(raw).value;
  assert.strictEqual(bs.blockAt(root, 0, 0, 0), null);
  assert.strictEqual(bs.blockAt(root, 0, 1000, 0), null);
});

t('layerAt 返回 256 个方块名', () => {
  const palette = [{ Name: 'minecraft:stone' }, { Name: 'minecraft:air' }];
  const seq = new Array(4096).fill(0).map((_, i) => ((i % 16 === 0) ? 1 : 0));
  const raw = mkChunk18([{ y: 4, palette, longs: packPadded(seq, 4, 4096) }]);
  const root = nbt.parse(raw).value;
  const layer = bs.layerAt(root, 64);
  assert.strictEqual(layer.length, 256);
  assert.strictEqual(layer[0], 'minecraft:air');
  assert.strictEqual(layer[1], 'minecraft:stone');
  assert.strictEqual(bs.layerAt(root, 0), null);
});

t('topBlock 会跳过空气，且认 1.18 顶层 sections', () => {
  const palette = [{ Name: 'minecraft:stone' }, { Name: 'minecraft:air' }];
  // y=127 整层空气，y=126 全石头 → 应该报到 126*… 即 section 7 的最高非空气层
  const airSeq = new Array(4096).fill(1);
  const stoneSeq = new Array(4096).fill(0);
  const raw = mkChunk18([
    { y: 7, palette, longs: packPadded(airSeq, 4, 4096) },
    { y: 6, palette, longs: packPadded(stoneSeq, 4, 4096) }
  ]);
  const root = nbt.parse(raw).value;
  const tb = bs.topBlock(root);
  assert.ok(tb, '应该找到顶层方块');
  assert.strictEqual(tb.name, 'minecraft:stone');
  assert.strictEqual(tb.y, 6 * 16 + 15);
});

t('supportLevel 对现代格式放行', () => {
  const raw = mkChunk18([{ y: 4, palette: [{ Name: 'minecraft:stone' }] }]);
  const root = nbt.parse(raw).value;
  assert.strictEqual(bs.supportLevel(root).ok, true);
});

/* ============ 写入端：打包 / 重编码 ============ */
console.log('\n--- 写入端 ---\n');

t('encodeIndices 是 packedIndexPadded 的逆（多种位宽逐点对拍）', () => {
  for (const bits of [4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    const seq = seq4096(1 << bits);
    const words = bs.encodeIndices(seq, bits, false);
    for (let i = 0; i < 4096; i += 7) {
      assert.strictEqual(bs.packedIndexPadded(words, i, bits), seq[i], `bits=${bits} i=${i}`);
    }
  }
});

t('encodeIndices 是 packedIndexCrossing 的逆', () => {
  for (const bits of [4, 5, 6, 7, 9, 11]) {
    const seq = seq4096(1 << bits);
    const words = bs.encodeIndices(seq, bits, true);
    for (let i = 0; i < 4096; i += 7) {
      assert.strictEqual(bs.packedIndexCrossing(words, i, bits), seq[i], `bits=${bits} i=${i}`);
    }
  }
});

t('写入端和「按 wiki 独立写的那份」输出逐位一致', () => {
  // 最有分量的一条：和测试自己实现的编码器对拍，两边都错、还错得一模一样的概率极低
  for (const bits of [4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    const seq = seq4096(1 << bits);
    const mine = bs.encodeIndices(seq, bits, false);
    const ref = packPadded(seq, bits, 4096);
    assert.strictEqual(mine.length, ref.length, `bits=${bits} long 个数`);
    for (let i = 0; i < ref.length; i++) {
      assert.strictEqual(mine[i] & M64, ref[i] & M64, `bits=${bits} 第 ${i} 个 long`);
    }
    const mineC = bs.encodeIndices(seq, bits, true);
    const refC = packCrossing(seq, bits, 4096);
    assert.strictEqual(mineC.length, refC.length, `bits=${bits} 交叉 long 个数`);
    for (let i = 0; i < refC.length; i++) {
      assert.strictEqual(mineC[i] & M64, refC[i] & M64, `bits=${bits} 交叉第 ${i} 个 long`);
    }
  }
});

t('打包出来的 BigInt 必须能被 writeBigInt64BE 直接接受', () => {
  // 最容易漏的一步：无符号视图里高位全 1 的 long 直接丢给 writeBigInt64BE 会抛
  // ERR_OUT_OF_RANGE，而报错地点离"我打包了个 long 数组"很远。
  // 交叉打包 + 8 bit 才能造出负数：8 bit × 8 个索引刚好铺满一个字，最后那个索引占第 63 位。
  const seq = new Array(4096).fill(0).map((_, i) => (i % 8 === 7 ? 200 : 3));
  const words = bs.encodeIndices(seq, 8, true);
  assert.ok(words.some((w) => w < 0n), '构造有问题 —— 没有负数就测不到符号转换');
  const b = Buffer.alloc(8);
  for (const w of words) {
    assert.doesNotThrow(() => b.writeBigInt64BE(BigInt(w)), '写不进去: ' + w);
  }
  // 填充打包的高位永远是填充位（0），所以永远不出负数 —— 这也是它的一条硬特征
  assert.strictEqual(bs.encodeIndices(seq, 5, false).some((w) => w < 0n), false);
});

t('toSigned64：无符号 ↔ 有符号视图互转', () => {
  assert.strictEqual(bs.toSigned64(0n), 0n);
  assert.strictEqual(bs.toSigned64(M64), -1n);
  assert.strictEqual(bs.toSigned64(1n << 63n), -(1n << 63n));
  assert.strictEqual(bs.toSigned64((1n << 63n) - 1n), (1n << 63n) - 1n);
  // 转回来还是原来那串位
  for (const v of [0n, 1n, M64, 1n << 63n, 1234567890123n]) {
    assert.strictEqual(bs.toSigned64(v) & M64, v & M64);
  }
});

t('填充打包的填充位必须是 0（detectPacking 判据②成立的前提）', () => {
  for (const bits of [5, 6, 7, 9, 10, 11, 12, 13, 14, 15]) {
    const words = bs.encodeIndices(seq4096(1 << bits), bits, false);
    assert.strictEqual(bs.paddingBitsAllZero(words, bits), true, `bits=${bits}`);
  }
});

t('交叉打包的 long 个数不因位宽整除而变（5 bit → 320）', () => {
  const words = bs.encodeIndices(seq4096(32), 5, true);
  assert.strictEqual(words.length, 320);
  assert.strictEqual(bs.encodeIndices(seq4096(32), 5, false).length, 342);
});

/* ============ 回归：交叉打包里"算术右移污染相邻位" ============ */
/* 这个 bug 只在 bits 不整除 64、且 off + bits > 64 时发作。
   4 bit / 8 bit 的 off 永远是 4 的倍数、到不了 63，所以怎么测都测不出来 ——
   它就这么在 1.15.2 及更早的存档上藏了很久。用测试自己的 packCrossing 造数据，
   不经过被测的写入端，才能确定问题真的出在解码侧。 */
console.log('\n--- 交叉打包回归 ---\n');

t('回归：5/6/7/9/10/11 bit 的交叉打包必须逐点解对', () => {
  for (const bits of [5, 6, 7, 9, 10, 11]) {
    const seq = seq4096(1 << bits);
    const words = packCrossing(seq, bits, 4096);
    assert.ok(words.some((w) => w < 0n), `bits=${bits} 没有负数 long，这条用例测不到符号问题`);
    for (let i = 0; i < 4096; i++) {
      assert.strictEqual(bs.packedIndexCrossing(words, i, bits), seq[i], `bits=${bits} i=${i}`);
    }
  }
});

t('回归：4 bit / 8 bit 本来就不受影响（off 永远是 4 的倍数）', () => {
  for (const bits of [4, 8]) {
    const seq = seq4096(1 << bits);
    const words = packCrossing(seq, bits, 4096);
    for (let i = 0; i < 4096; i += 3) {
      assert.strictEqual(bs.packedIndexCrossing(words, i, bits), seq[i], `bits=${bits} i=${i}`);
    }
  }
});

t('回归：全 1 的 long（最狠的情形）也要解对', () => {
  // 每个索引都取最大值 → 每个 long 都是 -1（无符号看全 1），算术右移必然补一串 1。
  // 4096×bits 对 5/6/7/9 都整除 64，所以整串 long 全是全 1。
  for (const bits of [5, 6, 7, 9]) {
    const max = (1 << bits) - 1;
    const seq = new Array(4096).fill(max);
    const words = packCrossing(seq, bits, 4096);
    assert.ok(words.every((w) => w === -1n), `bits=${bits} 应当全是全 1 的 long`);
    for (let i = 0; i < 4096; i++) {
      assert.strictEqual(bs.packedIndexCrossing(words, i, bits), max, `bits=${bits} i=${i}`);
    }
  }
});

/* ============ 重编码一个区段 ============ */
console.log('\n--- 区段重编码 ---\n');

/** 造一个"已解析"的 section 对象（不走 nbt 字节，applyBlockEdits 吃的就是对象） */
function mkSec(y, paletteNames, seq, bits, legacy) {
  if (legacy) {
    return { Y: y, Palette: paletteNames.map((n) => ({ Name: n })), BlockStates: packPadded(seq, bits, 4096) };
  }
  return { Y: y, block_states: { palette: paletteNames.map((n) => ({ Name: n })), data: packPadded(seq, bits, 4096) } };
}

t('applyBlockEdits：改一格，调色板自动扩容', () => {
  const seq = new Array(4096).fill(1);
  const sec = mkSec(4, ['minecraft:air', 'minecraft:stone'], seq, 4);
  const local = (0 * 16 + 3) * 16 + 5;          // ly=0, z=3, x=5
  const res = bs.applyBlockEdits(sec, 3465, new Map([[local, 'minecraft:diamond_block']]));
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.changed, 1);
  assert.strictEqual(res.palette.length, 3);
  assert.strictEqual(res.palette[2].Name, 'minecraft:diamond_block');
  const root = { DataVersion: 3465, sections: [{ Y: 4, block_states: { palette: res.palette, data: res.data } }] };
  assert.strictEqual(bs.blockAt(root, 5, 64, 3), 'minecraft:diamond_block');
  assert.strictEqual(bs.blockAt(root, 6, 64, 3), 'minecraft:stone');
  assert.strictEqual(bs.blockAt(root, 5, 64, 4), 'minecraft:stone');
});

t('applyBlockEdits：位宽被抬高时整段重打包（4→5 位，256→342 long）', () => {
  const names = [];
  for (let i = 0; i < 16; i++) names.push('minecraft:b' + i);
  const seq = new Array(4096).fill(0).map((_, i) => i % 16);
  const sec = mkSec(0, names, seq, 4);
  assert.strictEqual(sec.block_states.data.length, 256);

  const local = (5 * 16 + 7) * 16 + 9;
  const res = bs.applyBlockEdits(sec, 3465, new Map([[local, 'minecraft:brand_new']]));
  assert.strictEqual(res.palette.length, 17);
  assert.strictEqual(res.bits, 5);
  assert.strictEqual(res.data.length, 342, '1.16 更新日志里 5 bit 就是 342 个 long');

  const root = { DataVersion: 3465, sections: [{ Y: 0, block_states: { palette: res.palette, data: res.data } }] };
  assert.strictEqual(bs.blockAt(root, 9, 5, 7), 'minecraft:brand_new');
  let checked = 0;
  for (let ly = 0; ly < 16; ly += 3) {
    for (let z = 0; z < 16; z += 3) {
      for (let x = 0; x < 16; x += 3) {
        const k = (ly * 16 + z) * 16 + x;
        if (k === local) continue;
        assert.strictEqual(bs.blockAt(root, x, ly, z), 'minecraft:b' + (k % 16), `k=${k}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 100, '抽样点太少，这条用例没覆盖住');
});

t('applyBlockEdits：改同一格两次，第二次变回原样时 changed=0', () => {
  const seq = new Array(4096).fill(1);
  const sec = mkSec(0, ['minecraft:air', 'minecraft:stone'], seq, 4);
  const local = 100;
  const r1 = bs.applyBlockEdits(sec, 3465, new Map([[local, 'minecraft:stone']]));
  assert.strictEqual(r1.changed, 0, '本来就是 stone，写同样的值不算改动');
  assert.strictEqual(r1.palette, null, '没变就不该产生新调色板');
});

t('applyBlockEdits：单色区段（没有 data）也能改', () => {
  const sec = { Y: 0, block_states: { palette: [{ Name: 'minecraft:air' }] } };
  const res = bs.applyBlockEdits(sec, 3465, new Map([[7, 'minecraft:torch']]));
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.palette.length, 2);
  assert.strictEqual(res.bits, 4);
  assert.strictEqual(res.data.length, 256);
  const root = { DataVersion: 3465, sections: [{ Y: 0, block_states: { palette: res.palette, data: res.data } }] };
  assert.strictEqual(bs.blockAt(root, 7, 0, 0), 'minecraft:torch');
  assert.strictEqual(bs.blockAt(root, 8, 0, 0), 'minecraft:air');
});

t('applyBlockEdits：1.13~1.15 的 Palette/BlockStates 写法也支持', () => {
  const seq = new Array(4096).fill(0).map((_, i) => i % 2);
  const sec = mkSec(0, ['minecraft:stone', 'minecraft:dirt'], seq, 4, true);
  const res = bs.applyBlockEdits(sec, 2200, new Map([[5, 'minecraft:gold_block']]));
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.palette.length, 3);
  const root = { DataVersion: 2200, Level: { Sections: [{ Y: 0, Palette: res.palette, BlockStates: res.data }] } };
  assert.strictEqual(bs.blockAt(root, 5, 0, 0), 'minecraft:gold_block');
  assert.strictEqual(bs.blockAt(root, 6, 0, 0), 'minecraft:stone');   // seq[6]=0 → palette[0]
  assert.strictEqual(bs.blockAt(root, 7, 0, 0), 'minecraft:dirt');    // seq[7]=1 → palette[1]
});

t('applyBlockEdits：1.15 之前的交叉打包必须原样保持', () => {
  // dv=2200 < 2566 → 交叉打包。bit 数从 4 抬到 5，但打包方式不能跟着变
  const names = [];
  for (let i = 0; i < 16; i++) names.push('minecraft:b' + i);
  const seq = new Array(4096).fill(0).map((_, i) => i % 16);
  const sec = { Y: 0, block_states: { palette: names.map((n) => ({ Name: n })), data: packCrossing(seq, 4, 4096) } };
  const res = bs.applyBlockEdits(sec, 2200, new Map([[9, 'minecraft:newbie']]));
  assert.strictEqual(res.bits, 5);
  assert.strictEqual(res.crossing, true, '旧世界不能改成填充打包 —— 那是 1.16 才有的布局');
  assert.strictEqual(res.data.length, 320, '交叉打包下 5 bit 是 320 个 long');
  // 用交叉解码器验回来
  const back = bs.decodeIndices({ palette: res.palette, data: res.data }, 2200, 4096, 4);
  assert.strictEqual(res.palette[back.idx[9]].Name, 'minecraft:newbie');
});

t('entryFromName：带属性的完整状态名能还原成 {Name, Properties}', () => {
  const e = bs.entryFromName('minecraft:oak_stairs[facing=north,half=bottom]');
  assert.strictEqual(e.Name, 'minecraft:oak_stairs');
  assert.deepStrictEqual(e.Properties, { facing: 'north', half: 'bottom' });
  // 往返：entryName(entryFromName(x)) === x
  for (const n of ['minecraft:stone', 'minecraft:oak_stairs[facing=north]',
    'minecraft:water[level=0]', 'minecraft:oak_log[axis=y]']) {
    assert.strictEqual(bs.entryName(bs.entryFromName(n)), n);
  }
});

/* ============ 写回 + 类型登记 ============ */
console.log('\n--- 写回与类型 ---\n');

t('writeBlockStates 原地换内容：数组对象不变（类型旁路表才认得它）', () => {
  const seq = new Array(4096).fill(1);
  const sec = mkSec(0, ['minecraft:air', 'minecraft:stone'], seq, 4);
  const dataBefore = sec.block_states.data;
  const palBefore = sec.block_states.palette;
  const res = bs.applyBlockEdits(sec, 3465, new Map([[3, 'minecraft:gold_block']]));
  bs.writeBlockStates(sec, res);
  assert.strictEqual(sec.block_states.data, dataBefore, 'data 必须是同一个数组对象');
  assert.strictEqual(sec.block_states.palette, palBefore, 'palette 也必须是同一个数组对象');
  assert.strictEqual(sec.block_states.data.length, res.data.length);
  assert.strictEqual(sec.block_states.palette.length, 3);
});

t('端到端：改完写回 → nbt 序列化 → 再解析，方块值正确且其它字段没动', () => {
  const types = nbt.newTypes();
  const seq = new Array(4096).fill(0).map((_, i) => i % 4);
  const raw = mkChunk18([{
    y: 4,
    palette: [{ Name: 'minecraft:air' }, { Name: 'minecraft:stone' },
      { Name: 'minecraft:dirt' }, { Name: 'minecraft:grass_block' }],
    longs: packPadded(seq, 4, 4096)
  }]);
  const tree = nbt.parse(raw, types).value;
  const sec = tree.sections[0];
  const local = (2 * 16 + 6) * 16 + 11;      // ly=2, z=6, x=11
  const res = bs.applyBlockEdits(sec, 3465, new Map([[local, 'minecraft:diamond_block']]));
  assert.strictEqual(res.ok, true);
  bs.writeBlockStates(sec, res, types);

  const out = nbt.serialize('', tree, types);
  const back = nbt.parse(out).value;
  assert.strictEqual(bs.blockAt(back, 11, 66, 6), 'minecraft:diamond_block');
  assert.strictEqual(back.DataVersion, 3465);
  assert.strictEqual(back.sections[0].Y, 4, 'Y 字段必须原样保留（它是 SHORT/BYTE，掉了游戏读不了）');
  // 除了改掉的那一格，其它格全部保持原样
  let same = 0;
  for (let ly = 0; ly < 16; ly += 4) {
    for (let z = 0; z < 16; z += 4) {
      for (let x = 0; x < 16; x += 4) {
        const k = (ly * 16 + z) * 16 + x;
        if (k === local) continue;
        const want = ['minecraft:air', 'minecraft:stone', 'minecraft:dirt', 'minecraft:grass_block'][seq[k]];
        assert.strictEqual(bs.blockAt(back, x, 64 + ly, z), want, `k=${k}`);
        same++;
      }
    }
  }
  assert.ok(same > 30);
});

t('端到端：1.16 的填充打包区块改完仍然用填充打包（不能退回交叉）', () => {
  const types = nbt.newTypes();
  const names = [];
  for (let i = 0; i < 20; i++) names.push('minecraft:x' + i);   // 20 个 → 5 bit
  const seq = new Array(4096).fill(0).map((_, i) => (i * 3) % 20);
  const raw = nbt.serialize('', {
    DataVersion: 3465,
    sections: [{ Y: 0, block_states: { palette: names.map((n) => ({ Name: n })), data: packPadded(seq, 5, 4096) } }]
  });
  const tree = nbt.parse(raw, types).value;
  const sec = tree.sections[0];
  const res = bs.applyBlockEdits(sec, 3465, new Map([[77, 'minecraft:zzz']]));
  assert.strictEqual(res.crossing, false, '原区块是填充打包，改完还得是填充打包');
  bs.writeBlockStates(sec, res, types);
  const back = nbt.parse(nbt.serialize('', tree, types)).value;
  assert.strictEqual(bs.blockAt(back, 13, 0, 4), 'minecraft:zzz');
  assert.strictEqual(((back.sections[0].block_states.data.length)), 342);
});

/* ============ 光照 / 方块实体判据 ============ */
console.log('\n--- 合并判据 ---\n');

t('isOpaque：空气、水、玻璃、树叶都判为非实心', () => {
  for (const n of ['minecraft:air', 'minecraft:cave_air', 'minecraft:water', 'minecraft:lava',
    'minecraft:glass', 'minecraft:white_stained_glass', 'minecraft:oak_leaves',
    'minecraft:oak_slab', 'minecraft:oak_stairs', 'minecraft:oak_fence',
    'minecraft:oak_door', 'minecraft:torch', 'minecraft:snow', 'minecraft:ice']) {
    assert.strictEqual(bs.isOpaque(n), false, n + ' 应当判为非实心');
  }
});

t('isOpaque：普通方块的属性后缀不影响判断', () => {
  assert.strictEqual(bs.isOpaque('minecraft:oak_stairs[facing=north,half=bottom]'), false);
  assert.strictEqual(bs.isOpaque('minecraft:oak_log[axis=y]'), true);
  assert.strictEqual(bs.isOpaque('minecraft:oak_planks'), true);
  assert.strictEqual(bs.isOpaque('minecraft:stone'), true);
  assert.strictEqual(bs.isOpaque('minecraft:crafting_table'), true);
  assert.strictEqual(bs.isOpaque('minecraft:furnace[facing=north,lit=true]'), true);
  assert.strictEqual(bs.isOpaque('minecraft:deepslate_bricks'), true);
});

t('needsBlockEntity：容器、告示牌、刷怪笼都算；普通方块不算', () => {
  for (const n of ['minecraft:chest', 'minecraft:trapped_chest', 'minecraft:barrel',
    'minecraft:white_shulker_box', 'minecraft:furnace', 'minecraft:hopper',
    'minecraft:oak_sign', 'minecraft:oak_hanging_sign', 'minecraft:white_banner',
    'minecraft:spawner', 'minecraft:lectern', 'minecraft:beehive',
    'minecraft:chiseled_bookshelf', 'minecraft:decorated_pot']) {
    assert.strictEqual(bs.needsBlockEntity(n), true, n + ' 应当判为方块实体载体');
  }
  for (const n of ['minecraft:stone', 'minecraft:oak_planks', 'minecraft:dirt',
    'minecraft:oak_log', 'minecraft:glass', 'minecraft:crafting_table']) {
    assert.strictEqual(bs.needsBlockEntity(n), false, n + ' 不该判为方块实体载体');
  }
});

t('needsBlockEntity：属性后缀要先剥掉再判', () => {
  assert.strictEqual(bs.needsBlockEntity('minecraft:oak_sign[rotation=3,waterlogged=false]'), true);
  assert.strictEqual(bs.baseName('minecraft:oak_sign[rotation=3]'), 'minecraft:oak_sign');
});

/* ============ 汇总 ============ */
console.log('\n=== blockstate.js 结果 ===');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (failures.length) { console.log('失败清单:'); for (const f of failures) console.log('  · ' + f); }
process.exit(fail ? 1 : 0);
