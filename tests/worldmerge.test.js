/*
 * worldmerge.js（世界合并与建筑移植）单测。
 *
 * 重点压三类"看着对、实际错"的地方：
 *   · **跨 region 的负坐标**。anvil 的槽位只按 & 31 归约，一个 buffer 不带 region 身份，
 *     所以 (-1,-1) 和 (31,31) 在同一个 buffer 里是同一个区块。搬运时如果 region 文件
 *     选错，两个不同的区块会被当成同一个 —— 这是 Anvil 层最大的坑，必须有用例钉住。
 *   · **区块与实体必须成对替换**。只看区块就跳过，新搬来的城堡里会残留目标存档原有的
 *     生物与掉落物；只看区块就写，又会在空地上凭空多出一堆实体。
 *   · **plan 必须只读**。它的价值就是让人在真正落盘前看清楚会发生什么。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const anvil = require('../anvil');
const nbt = require('../nbt');
const wm = require('../worldmerge');

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

console.log('\n=== worldmerge.js 单测 ===\n');

const TMP = path.join(os.tmpdir(), 'pl-worldmerge-test');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const A = path.join(TMP, '创造存档');   // 源
const B = path.join(TMP, '生存存档');   // 目标
fs.mkdirSync(A, { recursive: true });
fs.mkdirSync(B, { recursive: true });

function mkSave(name) {
  const d = path.join(TMP, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/**
 * 造一个"像区块"的最小 NBT。`entities` > 0 时带上实体列表，
 * 用来验证实体热点统计和"区块/实体成对搬运"。
 */
function chunkRaw(marker, entities) {
  const body = { DataVersion: 3465, Status: 'full', Marker: String(marker), xPos: 0, zPos: 0 };
  if (entities) body.Entities = Array.from({ length: entities }, (_, i) => ({ id: 'minecraft:pig', n: i }));
  return nbt.serialize('', body);
}
function put(saveDir, cx, cz, marker, o) {
  const opt = o || {};
  const raw = chunkRaw(marker, opt.entities);
  anvil.writeSaveChunk({
    saveDir, dim: opt.dim || 'overworld', kind: opt.kind || 'region',
    cx, cz, raw, backup: false
  });
  return anvil.hashOf(raw);
}
function markerOf(saveDir, cx, cz, o) {
  const opt = o || {};
  const r = anvil.readSaveChunk({ saveDir, dim: opt.dim || 'overworld', kind: opt.kind || 'region', cx, cz });
  return r ? nbt.parse(r.raw).value.Marker : null;
}
/** 读一个 region 文件的原始字节指纹，用来验证"plan 没动过盘" */
function fileHash(p) {
  try { return anvil.hashOf(fs.readFileSync(p)); } catch { return null; }
}

/* ================= 1. 坐标换算 ================= */
console.log('--- 方块坐标 → 区块盒子 ---');

t('chunkBox：按区块向外吸附，并标记 aligned=false', () => {
  const b = wm.chunkBox({ x1: 33, z1: 33, x2: 62, z2: 62 });
  assert.strictEqual(b.cx1, 2);
  assert.strictEqual(b.cz1, 2);
  assert.strictEqual(b.cx2, 3);
  assert.strictEqual(b.cz2, 3);
  assert.strictEqual(b.chunks, 4);
  assert.deepStrictEqual(b.block, { x1: 32, z1: 32, x2: 63, z2: 63 });
  assert.strictEqual(b.aligned, false, '33 不是 16 的整数倍，必须标记为已吸附');
});

t('chunkBox：正好对齐时 aligned=true 且不扩大范围', () => {
  const b = wm.chunkBox({ x1: 0, z1: 0, x2: 31, z2: 31 });
  assert.strictEqual(b.chunks, 4);
  assert.deepStrictEqual(b.block, { x1: 0, z1: 0, x2: 31, z2: 31 });
  assert.strictEqual(b.aligned, true);
});

t('chunkBox：坐标颠倒也按同一块区域处理', () => {
  const b1 = wm.chunkBox({ x1: 100, z1: 100, x2: -100, z2: -100 });
  const b2 = wm.chunkBox({ x1: -100, z1: -100, x2: 100, z2: 100 });
  assert.deepStrictEqual(b1, b2);
});

t('chunkBox：负坐标的区块索引取整正确（-1 属于区块 -1，而不是 0）', () => {
  const b = wm.chunkBox({ x1: -1, z1: -1, x2: -1, z2: -1 });
  assert.strictEqual(b.cx1, -1);
  assert.strictEqual(b.cz1, -1);
  assert.strictEqual(b.chunks, 1);
  assert.deepStrictEqual(b.block, { x1: -16, z1: -16, x2: -1, z2: -1 });
});

t('chunkBox：非数字坐标直接报错', () => {
  assert.throws(() => wm.chunkBox({ x1: 'a', z1: 0, x2: 1, z2: 1 }), /必须是数字/);
  assert.throws(() => wm.chunkBox({ x1: NaN, z1: 0, x2: 1, z2: 1 }), /必须是数字/);
});

t('regionsInBox：region 边界在 32 的倍数上（不是 16）', () => {
  // 区块 -1..2：-1 属于 region -1，0/1/2 属于 region 0 —— 所以分组大小是 1/3/3/9，
  // 不是均分的 4/4/4/4。这个用例专门钉住"边界是 32 而不是 16"。
  const box = wm.chunkBox({ x1: -16, z1: -16, x2: 47, z2: 47 });
  assert.strictEqual(box.chunks, 16, '-1..2 是 4×4 个区块');
  const gs = wm.regionsInBox(box);
  assert.deepStrictEqual(gs.map((g) => g.rx + ',' + g.rz).sort(), ['-1,-1', '-1,0', '0,-1', '0,0']);
  const sizes = {};
  for (const g of gs) sizes[g.rx + ',' + g.rz] = g.keys.length;
  assert.deepStrictEqual(sizes, { '-1,-1': 1, '-1,0': 3, '0,-1': 3, '0,0': 9 });
  // 每个区块只能落进一个分组 —— 落进两个就会被写两遍，落到 0 个就会被漏掉
  const all = gs.reduce((a, g) => a.concat(g.keys.map((k) => k.cx + ',' + k.cz)), []);
  assert.strictEqual(all.length, 16);
  assert.strictEqual(new Set(all).size, 16, '有区块被分进了两个 region 或被漏掉');
});

t('regionsInBox：正好覆盖两个完整 region 时四组均分', () => {
  const box = wm.chunkBox({ x1: -256, z1: -256, x2: 255, z2: 255 });   // 区块 -16..15
  const gs = wm.regionsInBox(box);
  assert.strictEqual(gs.length, 4);
  for (const g of gs) assert.strictEqual(g.keys.length, 16 * 16, '每组应是 16×16 个区块');
});

/* ================= 2. plan 只读 + 计数 ================= */
(async () => {
  console.log('\n--- plan：只读的计划书 ---');

  // 源：2×2 区块的"城堡" + 两个实体区块；再放一块"实体热点"
  put(A, 2, 2, 'castle-a');
  put(A, 3, 2, 'castle-b');
  put(A, 2, 3, 'castle-c');
  put(A, 3, 3, 'castle-d');
  put(A, 2, 2, 'castle-a-ent', { kind: 'entities' });
  put(A, 3, 3, 'castle-d-ent', { kind: 'entities' });
  put(A, 8, 8, 'hot', { entities: 150 });

  // 目标：2,2 有冲突地形；3,2 恰好和源一样；2,3 只有实体；9,9 在盒子外
  put(B, 2, 2, '当地地形');
  put(B, 3, 2, 'castle-b');
  put(B, 2, 3, '当地实体', { kind: 'entities' });
  put(B, 9, 9, '盒子外');

  const BOX = { x1: 33, z1: 33, x2: 62, z2: 62 };   // → 区块 2..3 × 2..3

  let plan = null;
  await ta('plan：create / same / conflict 三类计数正确', async () => {
    plan = await wm.plan(Object.assign({ from: A, to: B }, BOX));
    assert.strictEqual(plan.ok, true);
    assert.strictEqual(plan.source.present, 4);
    assert.strictEqual(plan.source.missing, 0);
    assert.strictEqual(plan.target.create, 2, '2,3 和 3,3 在目标里是空的');
    assert.strictEqual(plan.target.same, 1, '3,2 内容恰好相同');
    assert.strictEqual(plan.target.conflict, 1, '2,2 会被覆盖');
    assert.strictEqual(plan.conflictsSample.length, 1);
    assert.deepStrictEqual(
      [plan.conflictsSample[0].cx, plan.conflictsSample[0].cz], [2, 2]
    );
  });

  await ta('plan：区块与实体的写入/删除分开计数', async () => {
    assert.strictEqual(plan.write.chunks, 3, '4 个里只有 3 个需要写（3,2 已相同）');
    assert.strictEqual(plan.write.same, 1);
    assert.strictEqual(plan.write.skipped, 0);
    assert.strictEqual(plan.write.entityWrite, 2, '源里 2,2 与 3,3 有实体');
    assert.strictEqual(plan.write.entityDelete, 1, '源里 2,3 没实体而目标有 → 该删');
  });

  await ta('plan：吸附与冲突都给出人话警告', async () => {
    assert.ok(plan.warnings.some((w) => /向外吸附/.test(w)), '应提示已吸附');
    assert.ok(plan.warnings.some((w) => /将被覆盖/.test(w)), '应提示会被覆盖');
    assert.strictEqual(plan.box.aligned, false);
  });

  await ta('plan 只读：两个存档的 region 文件字节一个都没变', async () => {
    const files = [
      path.join(A, 'region', 'r.0.0.mca'),
      path.join(A, 'entities', 'r.0.0.mca'),
      path.join(B, 'region', 'r.0.0.mca'),
      path.join(B, 'entities', 'r.0.0.mca')
    ];
    const before = files.map(fileHash);
    await wm.plan(Object.assign({ from: A, to: B }, BOX));
    assert.deepStrictEqual(files.map(fileHash), before, 'plan 改了盘，它必须只读');
  });

  await ta('plan：syncEntities=false 时不统计也不动实体', async () => {
    const p = await wm.plan(Object.assign({ from: A, to: B, syncEntities: false }, BOX));
    assert.strictEqual(p.write.entityWrite, 0);
    assert.strictEqual(p.write.entityDelete, 0);
    // 区块侧不受影响
    assert.strictEqual(p.write.chunks, 3);
  });

  /* ================= 3. apply ================= */
  console.log('\n--- apply：真正落盘 ---');

  await ta('apply：搬运成功且复验通过', async () => {
    const r = await wm.apply(Object.assign({ from: A, to: B }, BOX));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.nothingToDo, false);
    assert.strictEqual(r.verification.ok, true, JSON.stringify(r.verification.mismatched));
    assert.strictEqual(r.verification.checked, 3, '只复验写过的 3 个（3,2 本来就相同，没写）');
    assert.strictEqual(r.written, 5, '3 个区块 + 2 个实体区块');
    assert.strictEqual(r.deleted, 1, '删掉目标里 2,3 的实体');
  });

  await ta('apply：四个区块内容都换成了源', async () => {
    assert.strictEqual(markerOf(B, 2, 2), 'castle-a');
    assert.strictEqual(markerOf(B, 3, 2), 'castle-b');
    assert.strictEqual(markerOf(B, 2, 3), 'castle-c');
    assert.strictEqual(markerOf(B, 3, 3), 'castle-d');
  });

  await ta('apply：实体和区块成对落地', async () => {
    assert.strictEqual(markerOf(B, 2, 2, { kind: 'entities' }), 'castle-a-ent');
    assert.strictEqual(markerOf(B, 3, 3, { kind: 'entities' }), 'castle-d-ent');
    assert.strictEqual(markerOf(B, 2, 3, { kind: 'entities' }), null,
      '源里 2,3 没有实体，目标原有的必须被删掉，否则城堡里会残留当地生物');
  });

  await ta('apply：盒子外的区块毫发无损', async () => {
    assert.strictEqual(markerOf(B, 9, 9), '盒子外');
  });

  await ta('apply：源里没有 entities 目录时，会把目标同区域的实体一并清掉', async () => {
    const S = mkSave('纯地形源');
    const T = mkSave('带实体的目标');
    put(S, 4, 4, '地形');
    put(T, 4, 4, '目标地形');
    put(T, 4, 4, '目标实体', { kind: 'entities' });
    const r = await wm.apply({ from: S, to: T, x1: 64, z1: 64, x2: 79, z2: 79 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(markerOf(T, 4, 4), '地形');
    assert.strictEqual(markerOf(T, 4, 4, { kind: 'entities' }), null,
      '源没有实体数据 → 目标这段区域的实体应该清掉（整块区域变成源的样子）');
  });

  await ta('apply：再跑一次无事可做，且用 nothingToDo 表达而不是失败', async () => {
    const r = await wm.apply(Object.assign({ from: A, to: B }, BOX));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.nothingToDo, true);
    assert.strictEqual(r.written, 0);
    assert.strictEqual(r.plan.write.chunks, 0);
    assert.strictEqual(r.plan.write.same, 4);
  });

  await ta('apply：给 tmDir 时先给目标存档打快照', async () => {
    const tm = require('../savetimemachine');
    const TM = path.join(TMP, 'tm');
    put(B, 2, 3, '又变回当地地形');   // 制造出"有事可做"
    const r = await wm.apply(Object.assign({ from: A, to: B, tmDir: TM }, BOX));
    assert.ok(r.safety, '应产生安全快照 id');
    const list = tm.listSnapshots({ storeDir: TM });
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].label, '合并前自动快照');
    fs.rmSync(TM, { recursive: true, force: true });
  });

  /* ================= 4. mode ================= */
  console.log('\n--- mode：skip-existing ---');

  await ta('skip-existing：目标已有内容就整块跳过，连实体也不动', async () => {
    const S = mkSave('模式源');
    const T = mkSave('模式目标');
    put(S, 0, 0, '想要搬的');
    put(S, 1, 0, '想搬的空位');
    put(S, 0, 0, '源实体', { kind: 'entities' });
    put(T, 0, 0, '当地已有');
    put(T, 0, 0, '当地实体', { kind: 'entities' });

    const p = await wm.plan({ from: S, to: T, x1: 0, z1: 0, x2: 31, z2: 15, mode: 'skip-existing' });
    assert.strictEqual(p.write.skipped, 1, '0,0 已有 → 跳过');
    assert.strictEqual(p.write.chunks, 1, '1,0 是空位 → 照搬');

    const r = await wm.apply({ from: S, to: T, x1: 0, z1: 0, x2: 31, z2: 15, mode: 'skip-existing' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(markerOf(T, 0, 0), '当地已有', '已有内容必须保留');
    assert.strictEqual(markerOf(T, 0, 0, { kind: 'entities' }), '当地实体', '实体也不该被碰');
    assert.strictEqual(markerOf(T, 1, 0), '想搬的空位', '空位应该被补上');
  });

  /* ================= 5. 跨 region / 负坐标（最大的坑） ================= */
  console.log('\n--- 跨 region 与负坐标 ---');

  await ta('跨 region 搬运：(-1,-1) 与 (31,31) 必须仍是两个不同的区块', async () => {
    const S = mkSave('跨区源');
    const T = mkSave('跨区目标');
    // 这四个区块分布在 r.-1.-1 与 r.0.0 两个文件里，
    // (-1,-1) 和 (31,31) 在各自的 buffer 里都是槽位 1023 —— 选错文件就会互相覆盖
    put(S, -1, -1, 'negneg');
    put(S, 31, 31, 'pospos');
    put(S, 0, 0, 'zero');
    put(S, -32, -32, 'farneg');

    const p = await wm.plan({ from: S, to: T, x1: -512, z1: -512, x2: 511, z2: 511 });
    assert.strictEqual(p.source.present, 4);
    assert.strictEqual(p.write.chunks, 4);

    const r = await wm.apply({ from: S, to: T, x1: -512, z1: -512, x2: 511, z2: 511 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.verification.ok, true, JSON.stringify(r.verification.mismatched));
    assert.strictEqual(markerOf(T, -1, -1), 'negneg');
    assert.strictEqual(markerOf(T, 31, 31), 'pospos');
    assert.strictEqual(markerOf(T, 0, 0), 'zero');
    assert.strictEqual(markerOf(T, -32, -32), 'farneg');
    // 交叉验证：这些内容之间不能互相串
    assert.notStrictEqual(markerOf(T, -1, -1), markerOf(T, 31, 31));
    // region 文件也该落在正确的位置
    assert.ok(fs.existsSync(path.join(T, 'region', 'r.-1.-1.mca')), '缺 r.-1.-1.mca');
    assert.ok(fs.existsSync(path.join(T, 'region', 'r.0.0.mca')), '缺 r.0.0.mca');
  });

  await ta('跨 region 搬运：只覆盖一个小角，同文件里的其它区块不受影响', async () => {
    const S = mkSave('小角源');
    const T = mkSave('小角目标');
    // 目标里 r.0.0.mca 已有 (-1,-1) 与 (0,0)，源只提供 (31,31)
    put(T, -1, -1, '别动我-1');
    put(T, 0, 0, '别动我-2');
    put(S, 31, 31, '新来的');
    const r = await wm.apply({ from: S, to: T, x1: 496, z1: 496, x2: 511, z2: 511 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.written, 1, '只该写这一个区块');
    assert.strictEqual(markerOf(T, 31, 31), '新来的');
    assert.strictEqual(markerOf(T, -1, -1), '别动我-1', '同文件里的邻居被误改了');
    assert.strictEqual(markerOf(T, 0, 0), '别动我-2', '同文件里的邻居被误改了');
  });

  /* ================= 6. 实体热点 / 缺失 / 边界 ================= */
  console.log('\n--- 热点 / 缺失 / 边界 ---');

  await ta('plan：单区块实体数超阈值时进 hotspots 并给出警告', async () => {
    const p = await wm.plan({ from: A, to: mkSave('热点目标'), x1: 128, z1: 128, x2: 143, z2: 143 });
    assert.strictEqual(p.source.present, 1, '8,8 那个热点区块');
    assert.strictEqual(p.source.entities, 150);
    assert.ok(p.hotspots.length >= 1, '应报出热点');
    assert.strictEqual(p.hotspots[0].entities, 150);
    assert.ok(p.warnings.some((w) => /实体数偏高/.test(w)));
  });

  await ta('plan：阈值可以调高，热点随之消失', async () => {
    const p = await wm.plan({ from: A, to: mkSave('热点目标2'), x1: 128, z1: 128, x2: 143, z2: 143, entityThreshold: 500 });
    assert.strictEqual(p.hotspots.length, 0);
  });

  await ta('plan：源里空区块计入 missing 并给出警告', async () => {
    const p = await wm.plan({ from: A, to: B, x1: 0, z1: 0, x2: 300, z2: 60 });
    assert.ok(p.source.missing > 0, '大部分格子应是空的');
    assert.strictEqual(p.source.present + p.source.missing, p.box.chunks);
    assert.ok(p.warnings.some((w) => /是空的/.test(w)));
  });

  await ta('plan：纯空白区域 → ok=false 且说明原因，不抛错', async () => {
    const p = await wm.plan({ from: A, to: B, x1: 5000, z1: 5000, x2: 5100, z2: 5100 });
    assert.strictEqual(p.ok, false);
    assert.strictEqual(p.write.chunks, 0);
    assert.ok(p.warnings.some((w) => /一个区块都没有/.test(w)));
  });

  await ta('apply：无事可做时返回 nothingToDo 而不是失败', async () => {
    const r = await wm.apply({ from: A, to: B, x1: 5000, z1: 5000, x2: 5100, z2: 5100 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.nothingToDo, true);
    assert.strictEqual(r.safety, null, '没事可做就不该打快照');
  });

  await ta('plan：源和目标同一个目录直接拒绝', async () => {
    await assert.rejects(() => wm.plan({ from: A, to: A, x1: 0, z1: 0, x2: 16, z2: 16 }), /同一个目录/);
  });

  await ta('plan：源或目标不存在时报清楚的名字', async () => {
    await assert.rejects(
      () => wm.plan({ from: path.join(TMP, '并不存在'), to: B, x1: 0, z1: 0, x2: 16, z2: 16 }),
      /源存档不存在/
    );
    await assert.rejects(
      () => wm.plan({ from: A, to: path.join(TMP, '也不存在'), x1: 0, z1: 0, x2: 16, z2: 16 }),
      /目标存档不存在/
    );
    await assert.rejects(
      () => wm.plan({ to: B, x1: 0, z1: 0, x2: 16, z2: 16 }),
      /必须同时给出源存档/
    );
  });

  await ta('plan：超过区块上限直接拒绝并报出实际数量', async () => {
    await assert.rejects(
      () => wm.plan({ from: A, to: B, x1: 0, z1: 0, x2: 16 * 300, z2: 16 * 300 }),
      /一次最多搬/
    );
  });

  await ta('plan：目标存档缺少目标维度目录时也能工作（会自动创建）', async () => {
    const S = mkSave('下界源');
    const T = mkSave('下界目标');
    put(S, 0, 0, '下界要塞', { dim: 'nether' });
    const p = await wm.plan({ from: S, to: T, dim: 'nether', x1: 0, z1: 0, x2: 15, z2: 15 });
    assert.strictEqual(p.source.present, 1);
    const r = await wm.apply({ from: S, to: T, dim: 'nether', x1: 0, z1: 0, x2: 15, z2: 15 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(markerOf(T, 0, 0, { dim: 'nether' }), '下界要塞');
    assert.ok(fs.existsSync(path.join(T, 'DIM-1', 'region', 'r.0.0.mca')), '下界目录应落在 DIM-1 下');
  });

  await ta('apply：不传 verify:false 时复验是默认打开的', async () => {
    const v = await wm.apply({ from: A, to: B, x1: 128, z1: 128, x2: 143, z2: 143 });
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.verification.checked, 1);
    assert.strictEqual(v.verification.ok, true);
  });

  /* ================= 7. 区块对齐平移 ================= */
  console.log('\n--- 区块对齐平移：规范化与盒子 ---');

  t('normalizeShift：16 的整数倍直接通过（含 0 与负数）', () => {
    assert.strictEqual(wm.normalizeShift({}).ok, true, '没给平移量就是 0，保持旧行为');
    assert.strictEqual(wm.normalizeShift({}).dxc, 0);
    const a = wm.normalizeShift({ dx: 32, dz: -48 });
    assert.strictEqual(a.ok, true);
    assert.strictEqual(a.dxc, 2);
    assert.strictEqual(a.dzc, -3);
  });

  t('normalizeShift：非对齐的量被拒绝，并把最近可用的值带出来', () => {
    const r = wm.normalizeShift({ dx: 20, dz: 0 });
    assert.strictEqual(r.ok, false, '挪 20 格做不到 —— 那要逐格重排方块与光照');
    assert.strictEqual(r.dxc, 0, '被拒绝时不能留下半个平移量');
    assert.strictEqual(r.nearest.dx, 16, '20 最近的是 16，不是 32');
    assert.strictEqual(r.nearest.dxc, 1);
    assert.ok(/16 的整数倍/.test(r.reason), r.reason);
    assert.ok(/最近可用的是 16,0/.test(r.reason), r.reason);
  });

  t('shiftBox：整体平移，方块范围跟着走', () => {
    const b = wm.chunkBox({ x1: 0, z1: 0, x2: 15, z2: 15 });
    const s = wm.shiftBox(b, 2, -1);
    assert.deepStrictEqual([s.cx1, s.cz1, s.cx2, s.cz2], [2, -1, 2, -1]);
    assert.deepStrictEqual(s.block, { x1: 32, z1: -16, x2: 47, z2: -1 });
    assert.strictEqual(s.chunks, 1);
  });

  /* ---------- 7.1 坐标同步 ---------- */

  /**
   * 造一个"坐标字段齐全"的区块，用来验平移。
   *
   * 关键在类型：`Pos` 注册成 **LIST of DOUBLE**，而值**故意取整数** ——
   * 平移之后整数加整数还是整数，JS 里看不出它原本是 DOUBLE，
   * 不带类型表写回就会被写成 INT。这正是里程碑一那个坑的翻版。
   * `PostProcessing` 是 LIST of SHORT（值全 0），平移不该碰它，但它必须活着回来。
   */
  function mkCoordChunk(o) {
    const opt = Object.assign({ cx: 0, cz: 0, x: 100, z: -200, tag: 'z' }, o);
    const types = nbt.newTypes();
    const pp = new Array(64).fill(0);
    types.node.set(pp, nbt.T.LIST);
    types.list.set(pp, nbt.T.SHORT);
    const pos = [opt.x, 64, opt.z];
    types.list.set(pos, nbt.T.DOUBLE);
    const cpos = [opt.x, 65, opt.z];
    types.list.set(cpos, nbt.T.DOUBLE);
    const body = {
      DataVersion: 3465, Status: 'full', Marker: opt.tag,
      xPos: opt.cx, zPos: opt.cz, yPos: -4,
      PostProcessing: pp,
      block_entities: [{ id: 'minecraft:chest', x: opt.x, y: 64, z: opt.z, Items: [] }],
      block_ticks: [{ i: 'minecraft:water', x: opt.x, y: 64, z: opt.z, t: 0, p: -1 }],
      fluid_ticks: [{ i: 'minecraft:water', x: opt.x, y: 64, z: opt.z, t: 0, p: -1 }],
      Entities: [{
        id: 'minecraft:pig', Pos: pos, TileX: opt.x, TileZ: opt.z,
        Passengers: [{ id: 'minecraft:chicken', Pos: cpos }]
      }]
    };
    return nbt.serialize('', body, types);
  }

  const TY = nbt.T;

  t('平移：xPos/zPos、方块实体、刻、实体、乘客全都跟着走，y 不动', () => {
    const raw = mkCoordChunk({ cx: 3, cz: -4, x: 48, z: -64, tag: '城堡' });
    const out = wm.translateChunkRaw(raw, 32, -16, 2, -1).raw;
    const t2 = nbt.parse(out).value;
    assert.strictEqual(t2.xPos, 5, '区块坐标 3 + 2');
    assert.strictEqual(t2.zPos, -5, '区块坐标 -4 + (-1)');
    assert.strictEqual(t2.yPos, -4, '竖直方向平移不做，yPos 必须原样');
    assert.strictEqual(t2.Marker, '城堡', '无关字段原样');
    assert.strictEqual(t2.block_entities[0].x, 80, '48 + 32');
    assert.strictEqual(t2.block_entities[0].z, -80, '-64 + (-16)');
    assert.strictEqual(t2.block_entities[0].y, 64, 'y 不动');
    assert.strictEqual(t2.block_ticks[0].x, 80);
    assert.strictEqual(t2.block_ticks[0].z, -80);
    assert.strictEqual(t2.fluid_ticks[0].x, 80, '流体刻也带绝对坐标，漏了它会凭空触发');
    assert.deepStrictEqual(t2.Entities[0].Pos.slice(), [80, 64, -80]);
    assert.strictEqual(t2.Entities[0].TileX, 80);
    assert.strictEqual(t2.Entities[0].TileZ, -80);
    assert.deepStrictEqual(t2.Entities[0].Passengers[0].Pos.slice(), [80, 65, -80],
      '乘客自己的 Pos 也是绝对坐标 —— 漏了就是"船搬走了猪还在原地"');
    assert.strictEqual(t2.PostProcessing.length, 64, 'PostProcessing 不该被碰');
  });

  t('平移必须保类型：整数坐标的实体 Pos 仍然是 DOUBLE（不是 INT）', () => {
    const raw = mkCoordChunk({ x: 100, z: -200 });
    const out = wm.translateChunkRaw(raw, 32, -16, 2, -1).raw;
    const at = out.indexOf(Buffer.from('minecraft:pig', 'utf8'));
    const p = out.indexOf(Buffer.from('Pos', 'utf8'), at);
    assert.ok(p > at, '得能在 pig 之后找到 Pos');
    assert.strictEqual(out[p + 3], TY.DOUBLE, 'Pos 的 LIST 元素类型必须是 DOUBLE');
    // 反面对照：不带类型表写一遍，100+32=132 是整数 → 被写成 INT
    const bad = nbt.serialize('', nbt.parse(out).value);
    const at2 = bad.indexOf(Buffer.from('minecraft:pig', 'utf8'));
    const p2 = bad.indexOf(Buffer.from('Pos', 'utf8'), at2);
    assert.strictEqual(bad[p2 + 3], TY.INT, '不带类型表就会退化成 INT（对照组）');

    // PostProcessing 同理：值是 0，不带表就会从 SHORT 变成 INT
    const key = 'PostProcessing';
    const k = out.indexOf(Buffer.from(key, 'utf8')) + key.length;
    assert.strictEqual(out[k], TY.SHORT);
    const k2 = bad.indexOf(Buffer.from(key, 'utf8')) + key.length;
    assert.strictEqual(bad[k2], TY.INT, '对照组');
  });

  t('平移：平移过的字节自己必须能无损 round-trip', () => {
    const raw = mkCoordChunk({ cx: 1, cz: 2, x: 16, z: 32 });
    const out = wm.translateChunkRaw(raw, -16, 48, -1, 3).raw;
    assert.strictEqual(nbt.roundTrip(out).identical, true);
  });

  t('平移：没有坐标字段时不动它（0 平移也是恒等变换）', () => {
    const raw = nbt.serialize('', { DataVersion: 3465, sections: [] });
    const out = wm.translateChunkRaw(raw, 32, 32, 2, 2).raw;
    assert.strictEqual(anvil.hashOf(out), anvil.hashOf(raw));
    const m = wm.translateChunkRaw(raw, 32, 32, 2, 2).moved;
    assert.strictEqual(m.pos + m.blockEntities + m.ticks + m.entities + m.structures, 0);
  });

  t('平移：1.16 及更早的写法（坐标全在 Level 里）也认', () => {
    // ≤1.17：xPos/zPos、TileEntities、TileTicks、Entities 都在 Level 下面
    const raw = nbt.serialize('', {
      DataVersion: 2586,
      Level: {
        xPos: -2, zPos: 7, Status: 'full',
        TileEntities: [{ id: 'minecraft:chest', x: -20, y: 70, z: 118 }],
        TileTicks: [{ i: 'minecraft:water', x: -20, y: 70, z: 118, t: 0, p: -1 }],
        LiquidTicks: [{ i: 'minecraft:water', x: -20, y: 70, z: 118, t: 0, p: -1 }],
        Entities: [{ id: 'minecraft:pig', Pos: [-20, 70, 118] }]
      }
    });
    const t2 = nbt.parse(wm.translateChunkRaw(raw, 16, -32, 1, -2).raw).value;
    assert.strictEqual(t2.Level.xPos, -1);
    assert.strictEqual(t2.Level.zPos, 5);
    assert.strictEqual(t2.Level.TileEntities[0].x, -4, '方块坐标 -20 + 16');
    assert.strictEqual(t2.Level.TileEntities[0].z, 86, '118 + (-32)');
    assert.strictEqual(t2.Level.TileTicks[0].x, -4);
    assert.strictEqual(t2.Level.LiquidTicks[0].z, 86);
    assert.deepStrictEqual(t2.Level.Entities[0].Pos.slice(), [-4, 70, 86]);
  });

  t('平移：实体区块（entities/）的根用 Position: [cx, cz] 标位置，也要改', () => {
    const types = nbt.newTypes();
    const pos = [3, 64, 5];
    types.list.set(pos, TY.DOUBLE);
    const raw = nbt.serialize('', {
      DataVersion: 3465, Position: [0, 0],
      Entities: [{ id: 'minecraft:pig', Pos: pos }]
    }, types);
    const out = wm.translateChunkRaw(raw, 32, -16, 2, -1).raw;
    const t2 = nbt.parse(out).value;
    assert.deepStrictEqual(t2.Position.slice(), [2, -1], '根上的区块坐标');
    assert.deepStrictEqual(t2.Entities[0].Pos.slice(), [35, 64, -11], '实体自己的世界坐标');
    const at = out.indexOf(Buffer.from('minecraft:pig', 'utf8'));
    const p = out.indexOf(Buffer.from('Pos', 'utf8'), at);
    assert.strictEqual(out[p + 3], TY.DOUBLE, '这里同样不能丢掉 DOUBLE');
  });

  t('平移结构起点：ChunkX/ChunkZ、包围盒、Children、References 的键', () => {
    const raw = nbt.serialize('', {
      DataVersion: 3465, xPos: 4, zPos: -3,
      structures: {
        starts: {
          'minecraft:village': {
            ChunkX: 4, ChunkZ: -3,
            BB: [64, 60, -48, 90, 80, -20],
            Children: [{ ChunkX: 4, ChunkZ: -3, BB: [64, 60, -48, 90, 80, -20] }]
          }
        },
        References: { '4,-3': ['minecraft:village'] }
      }
    });
    const out = wm.translateChunkRaw(raw, 32, -16, 2, -1).raw;
    const st = nbt.parse(out).value.structures;
    const s = st.starts['minecraft:village'];
    assert.strictEqual(s.ChunkX, 6);
    assert.strictEqual(s.ChunkZ, -4);
    assert.deepStrictEqual(s.BB.slice(), [96, 60, -64, 122, 80, -36],
      'BB 只有 x/z 两对应改，y 那两对必须原样');
    assert.strictEqual(s.Children[0].ChunkX, 6);
    assert.deepStrictEqual(s.Children[0].BB.slice(), [96, 60, -64, 122, 80, -36]);
    assert.deepStrictEqual(Object.keys(st.References), ['6,-4'],
      'References 的键是 "cx,cz"，不改就等于指着一张不存在的图');
    assert.deepStrictEqual(st.References['6,-4'].slice(), ['minecraft:village']);
    assert.strictEqual(nbt.roundTrip(out).identical, true);
  });

  /* ---------- 7.2 预检 ---------- */

  console.log('\n--- 目标存档预检 ---');

  function writeLevelDat(dir, dv) {
    fs.writeFileSync(path.join(dir, 'level.dat'), nbt.serialize('', { Data: { DataVersion: dv, LevelName: 'x' } }));
  }
  function writeLock(dir, ts) {
    const b = Buffer.alloc(8);
    b.writeBigInt64BE(BigInt(ts));
    fs.writeFileSync(path.join(dir, 'session.lock'), b);
  }

  t('lockInfo：session.lock 时间戳很新 → 判定为"游戏正开着"', () => {
    const S = mkSave('锁-新');
    writeLock(S, Date.now());
    const l = wm.lockInfo(S);
    assert.strictEqual(l.present, true);
    assert.strictEqual(l.open, true);
    assert.strictEqual(l.via, 'timestamp');
    assert.ok(Math.abs(l.agoSec) < 5, '时间差算得不对: ' + l.agoSec);
  });

  t('lockInfo：时间戳是个随机数（旧版/第三方工具写的）时退回 mtime', () => {
    const S = mkSave('锁-随机数');
    writeLock(S, 123456789);          // 1973 年，不可能是毫秒时间戳
    const l = wm.lockInfo(S);
    assert.strictEqual(l.agoSec, null, '不可信的时间戳不能拿来算"多久以前"');
    assert.strictEqual(l.open, true, '文件刚被写过 → mtime 这道信号也要拦住');
    assert.strictEqual(l.via, 'mtime');
  });

  t('lockInfo：没有锁文件、或锁已经是旧的 → 不拦', () => {
    assert.strictEqual(wm.lockInfo(mkSave('锁-没有')).open, false);
    const S = mkSave('锁-旧');
    writeLock(S, Date.now() - 3600 * 1000);
    const l = wm.lockInfo(S);
    assert.strictEqual(l.open, false);
    assert.ok(l.agoSec >= 3595 && l.agoSec <= 3605, '一小时前 ≈ 3600 秒: ' + l.agoSec);
  });

  t('precheckTarget：跨过 1.18 的版本代差是**硬拦**（负 Y 区段目标根本不认识）', () => {
    const S = mkSave('版本源-1.20');
    const T = mkSave('版本目标-1.16');
    writeLevelDat(S, 3465);   // 1.20.x
    writeLevelDat(T, 2586);   // 1.16.5
    const p = wm.precheckTarget({ from: S, to: T });
    assert.strictEqual(p.ok, false);
    assert.ok(p.blockers.some((b) => /负 Y 区段/.test(b)), JSON.stringify(p.blockers));
    assert.strictEqual(p.dataVersion.gap, -879);
  });

  t('precheckTarget：没跨过 1.18 的代差只是提醒，不拦', () => {
    const S = mkSave('版本源-1.19');
    const T = mkSave('版本目标-1.18');
    writeLevelDat(S, 3337);   // 1.19.4
    writeLevelDat(T, 2865);   // 1.18.2（已经 ≥ 2825）
    const p = wm.precheckTarget({ from: S, to: T });
    assert.strictEqual(p.ok, true, JSON.stringify(p.blockers));
    assert.ok(p.warnings.some((w) => /比目标新/.test(w)), JSON.stringify(p.warnings));

    const S2 = mkSave('版本源-1.16');
    const T2 = mkSave('版本目标-1.12');
    writeLevelDat(S2, 2586);
    writeLevelDat(T2, 1343);
    const p2 = wm.precheckTarget({ from: S2, to: T2 });
    assert.strictEqual(p2.ok, true, '两个都在 1.18 之前，不存在负 Y 的问题');
    assert.ok(p2.warnings.some((w) => /比目标新/.test(w)));
  });

  t('precheckTarget：读不出 level.dat 时给提醒而不是拦死', () => {
    const S = mkSave('无版本源');
    const T = mkSave('无版本目标');
    const p = wm.precheckTarget({ from: S, to: T });
    assert.strictEqual(p.ok, true, JSON.stringify(p.blockers));
    assert.strictEqual(p.dataVersion.src, null);
    assert.ok(p.warnings.some((w) => /读不出源存档的版本/.test(w)), JSON.stringify(p.warnings));
    assert.ok(p.warnings.some((w) => /level.dat/.test(w)));
  });

  t('precheckTarget：要写的目标文件写不进去 → 硬拦并点名', () => {
    const S = mkSave('写不了源');
    const T = mkSave('写不了目标');
    // 拿一个**目录**当文件传进去：开 r+ 必然失败，等价于"这个文件被占着"
    const p = wm.precheckTarget({ from: S, to: T, files: [T] });
    assert.strictEqual(p.ok, false);
    assert.strictEqual(p.files.checked, 1);
    assert.strictEqual(p.files.locked.length, 1);
    assert.ok(p.blockers.some((b) => /写不进去/.test(b)), JSON.stringify(p.blockers));
    // 文件还不存在（目录也没建）不算问题 —— 写的时候会连目录一起建
    const p2 = wm.precheckTarget({ from: S, to: T, files: [path.join(T, '还不存在的目录', 'r.0.0.mca')] });
    assert.strictEqual(p2.ok, true, JSON.stringify(p2.blockers));
  });

  /* ---------- 7.3 平移的端到端 ---------- */

  console.log('\n--- 平移：端到端 ---');

  /**
   * entities/ 里的实体区块。根结构和区块**不一样**：它用 `Position: [cx, cz]`
   * 标自己的位置，而不是 xPos/zPos。拿区块的造法去造它，平移就什么都改不到 ——
   * 而且是**静默**什么都不改（数据看着还挺正常）。
   */
  function mkEntityChunk(cx, cz, tag) {
    const types = nbt.newTypes();
    const pos = [cx * 16 + 3, 64, cz * 16 + 5];
    types.list.set(pos, TY.DOUBLE);
    return nbt.serialize('', {
      DataVersion: 3465, Position: [cx, cz], Marker: tag,
      Entities: [{ id: 'minecraft:pig', Pos: pos, TileX: cx * 16 + 3, TileZ: cz * 16 + 5 }]
    }, types);
  }

  /** 往存档里写一个带坐标的区块 / 实体区块 */
  function putCoord(saveDir, cx, cz, tag, o) {
    const opt = o || {};
    const kind = opt.kind || 'region';
    const raw = kind === 'entities'
      ? mkEntityChunk(cx, cz, tag)
      : mkCoordChunk({ cx, cz, x: cx * 16 + 3, z: cz * 16 + 5, tag });
    anvil.writeSaveChunk({
      saveDir, dim: opt.dim || 'overworld', kind, cx, cz, raw, backup: false
    });
    return raw;
  }
  /** 读回来一个区块的解析结果 */
  function treeOf(saveDir, cx, cz, o) {
    const opt = o || {};
    const r = anvil.readSaveChunk({
      saveDir, dim: opt.dim || 'overworld', kind: opt.kind || 'entities', cx, cz
    });
    return r ? nbt.parse(r.raw).value : null;
  }

  await ta('平移：非对齐的量在 plan 阶段就被拒，并把最近可用的值带出来', async () => {
    let err = null;
    try { await wm.plan({ from: A, to: B, x1: 0, z1: 0, x2: 15, z2: 15, dx: 20 }); } catch (e) { err = e; }
    assert.ok(err, '挪 20 格必须被拒');
    assert.strictEqual(err.code, 'SHIFT_NOT_ALIGNED');
    assert.strictEqual(err.nearest.dx, 16);
    assert.ok(/16 的整数倍/.test(err.message), err.message);
  });

  await ta('平移：超出世界边界直接拒绝', async () => {
    // 30000000 正好是 16 的整数倍，能过对齐检查，然后必须被边界检查拦下
    await assert.rejects(
      () => wm.plan({ from: A, to: B, x1: 0, z1: 0, x2: 15, z2: 15, dx: 30000000 }),
      /超出世界边界/
    );
  });

  await ta('平移端到端：内容与坐标一起搬到新位置，原位置不动', async () => {
    const S = mkSave('平移源');
    const T = mkSave('平移目标');
    putCoord(S, 0, 0, '城堡');

    const BOX2 = { x1: 0, z1: 0, x2: 15, z2: 15, dx: 32, dz: -16 };
    const p = await wm.plan(Object.assign({ from: S, to: T }, BOX2));
    assert.strictEqual(p.shift.needed, true);
    assert.deepStrictEqual([p.destBox.cx1, p.destBox.cz1, p.destBox.cx2, p.destBox.cz2], [2, -1, 2, -1]);
    assert.strictEqual(p.source.present, 1);
    assert.strictEqual(p.target.create, 1);
    assert.strictEqual(p.write.chunks, 1);
    assert.strictEqual(p.translate.chunks, 1, '有平移时应当统计出真的平移了几个区块');
    assert.ok(p.translate.blockEntities >= 1 && p.translate.entities >= 1);
    assert.ok(p.warnings.some((w) => /整体搬到/.test(w)), JSON.stringify(p.warnings));

    const r = await wm.apply(Object.assign({ from: S, to: T }, BOX2));
    assert.strictEqual(r.ok, true, JSON.stringify(r.verification));
    assert.strictEqual(r.verification.checked, 1, '复验要认平移后的指纹，不能拿原始字节去比');

    const t2 = treeOf(T, 2, -1, { kind: 'region' });
    assert.strictEqual(t2.Marker, '城堡');
    assert.strictEqual(t2.xPos, 2, '区块坐标要跟着改，否则游戏会以为这块还在 (0,0)');
    assert.strictEqual(t2.zPos, -1);
    assert.strictEqual(t2.block_entities[0].x, 35, '0*16+3 + 32 = 35');
    assert.strictEqual(t2.block_entities[0].z, -11, '0*16+5 - 16 = -11');
    assert.deepStrictEqual(t2.Entities[0].Pos.slice(), [35, 64, -11]);
    assert.strictEqual(t2.block_ticks[0].x, 35);
    assert.strictEqual(t2.fluid_ticks[0].z, -11);
    // 落盘的那份自己也得是类型正确的（平移是"重写一遍字节"，最容易在这儿把类型弄丢）
    const onDisk = anvil.readSaveChunk({ saveDir: T, dim: 'overworld', kind: 'region', cx: 2, cz: -1 });
    assert.strictEqual(nbt.roundTrip(onDisk.raw).identical, true, '落盘区块的 round-trip 必须字节一致');

    // 原位置、以及盒子里的其它格子都必须是空的 —— 搬是"复制到新位置"，不是"挪走"
    assert.strictEqual(treeOf(T, 0, 0, { kind: 'region' }), null);
    assert.strictEqual(treeOf(T, 1, -1, { kind: 'region' }), null);
    // 源存档一个字节都没被动过
    assert.strictEqual(treeOf(S, 0, 0, { kind: 'region' }).Marker, '城堡');
  });

  await ta('平移：同一个平移再跑一次 → 无事可做（不是"又搬一遍"）', async () => {
    const S = mkSave('平移幂等源');
    const T = mkSave('平移幂等目标');
    putCoord(S, 0, 0, '幂等');
    const BOX2 = { from: S, to: T, x1: 0, z1: 0, x2: 15, z2: 15, dx: 16, dz: 16 };
    const r1 = await wm.apply(Object.assign({}, BOX2));
    assert.strictEqual(r1.ok, true, JSON.stringify(r1.verification));
    const r2 = await wm.apply(Object.assign({}, BOX2));
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.nothingToDo, true, '第二次必须认出来"目标已经和源平移后一致"');
    assert.strictEqual(r2.written, 0);
  });

  await ta('平移：跨 region 时写到正确的目标文件', async () => {
    const S = mkSave('跨区源');
    const T = mkSave('跨区目标');
    putCoord(S, 30, 30, '跨区');
    // 480=30*16 正好对齐；+512 方块 = 32 个区块 → 目标 (62,62)，落进 r.1.1.mca
    const r = await wm.apply({ from: S, to: T, x1: 480, z1: 480, x2: 495, z2: 495, dx: 512, dz: 512 });
    assert.strictEqual(r.ok, true, JSON.stringify(r.verification));
    assert.strictEqual(treeOf(T, 62, 62, { kind: 'region' }).Marker, '跨区');
    assert.ok(fs.existsSync(path.join(T, 'region', 'r.1.1.mca')), '应当落在第二个 region 文件里');
    assert.strictEqual(treeOf(T, 30, 30, { kind: 'region' }), null, '原位置不该有东西');
  });

  await ta('平移：entities/ 里的实体区块一起走（Position 与实体坐标都对）', async () => {
    const S = mkSave('平移实体源');
    const T = mkSave('平移实体目标');
    put(S, 0, 0, '地形');
    putCoord(S, 0, 0, '实体区块', { kind: 'entities' });
    const r = await wm.apply({ from: S, to: T, x1: 0, z1: 0, x2: 15, z2: 15, dx: 16, dz: 0 });
    assert.strictEqual(r.ok, true, JSON.stringify(r.verification));
    const e = treeOf(T, 1, 0, { kind: 'entities' });
    assert.ok(e, '实体区块必须搬到了 (1,0)');
    assert.deepStrictEqual(e.Position.slice(), [1, 0]);
    assert.deepStrictEqual(e.Entities[0].Pos.slice(), [19, 64, 5], '3 + 16 = 19');
    assert.strictEqual(e.Entities[0].TileX, 19);
    assert.strictEqual(treeOf(T, 0, 0, { kind: 'entities' }), null);
  });

  await ta('plan：指纹矩阵把每个目标区块的状态摊成一张图', async () => {
    const S = mkSave('矩阵源');
    const T = mkSave('矩阵目标');
    put(S, 0, 0, 'a'); put(S, 1, 0, 'b'); put(S, 0, 1, 'c');   // (1,1) 源里没有
    put(T, 0, 0, '冲突');
    put(T, 1, 0, 'b');
    const p = await wm.plan({ from: S, to: T, x1: 0, z1: 0, x2: 31, z2: 31 });
    assert.strictEqual(p.matrix.w, 2);
    assert.strictEqual(p.matrix.h, 2);
    assert.strictEqual(p.matrix.cx1, 0);
    assert.strictEqual(p.matrix.cz1, 0);
    // 行 = cz，列 = cx
    assert.deepStrictEqual(p.matrix.cells, ['!=', 'n.'],
      '实际: ' + JSON.stringify(p.matrix.cells));
    assert.strictEqual(p.matrix.legend.length, 6);
    assert.ok(p.matrix.legend.some((l) => l.ch === '!' && l.key === 'conflict'));

    // 平移之后矩阵的坐标原点是**目标**盒子的原点
    const p2 = await wm.plan({ from: S, to: T, x1: 0, z1: 0, x2: 31, z2: 31, dx: 32, dz: 0 });
    assert.strictEqual(p2.matrix.cx1, 2);
    assert.strictEqual(p2.matrix.cz1, 0);
    assert.strictEqual(p2.matrix.cells.length, 2);
  });

  await ta('apply：预检有硬问题时默认拒绝，force 才继续', async () => {
    const S = mkSave('预检拦截源');
    const T = mkSave('预检拦截目标');
    put(S, 0, 0, '新内容');
    writeLock(T, Date.now());            // 模拟"游戏正开着目标存档"

    const p = await wm.plan({ from: S, to: T, x1: 0, z1: 0, x2: 15, z2: 15 });
    assert.strictEqual(p.precheck.ok, false);
    assert.ok(p.warnings.some((w) => /必须先解决/.test(w)),
      'plan 也要把硬问题说出来，不能只在 apply 时拦: ' + JSON.stringify(p.warnings));

    const r = await wm.apply({ from: S, to: T, x1: 0, z1: 0, x2: 15, z2: 15 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocked, true);
    assert.ok(r.blockers.length >= 1);
    assert.ok(/正被游戏打开/.test(r.blockers[0]), r.blockers[0]);
    assert.strictEqual(treeOf(T, 0, 0, { kind: 'region' }), null, '被拦住时一个字节都不该写');

    const r2 = await wm.apply({ from: S, to: T, x1: 0, z1: 0, x2: 15, z2: 15, force: true });
    assert.strictEqual(r2.ok, true, JSON.stringify(r2.verification));
    assert.strictEqual(treeOf(T, 0, 0, { kind: 'region' }).Marker, '新内容');
  });

  await ta('plan：平移后仍只读（源、目标四个 region 文件字节都没变）', async () => {
    const S = mkSave('平移只读源');
    const T = mkSave('平移只读目标');
    putCoord(S, 0, 0, '只读');
    putCoord(T, 2, 2, '目标原有');
    const files = [
      path.join(S, 'region', 'r.0.0.mca'),
      path.join(T, 'region', 'r.0.0.mca')
    ];
    const before = files.map(fileHash);
    await wm.plan({ from: S, to: T, x1: 0, z1: 0, x2: 15, z2: 15, dx: 32, dz: 32 });
    assert.deepStrictEqual(files.map(fileHash), before, '平移的 plan 也必须只读');
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
})().catch((e) => { console.error('测试驱动器异常：', (e && e.stack) || e); process.exit(1); });
