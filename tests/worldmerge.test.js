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
