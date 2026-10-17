/*
 * worldver.js 「V5 第一组：世界版本控制完整版」单测。
 *
 * 覆盖三块新能力：方块级 blame、时间轴回放（帧列表 + 单帧内容）、自研三方合并。
 *
 * 用例刻意往"看起来对、实际错"的地方压：
 *   · blame 必须把状态**归属到最先引入它的那次提交**，而不是"最近一次碰过这个区块的提交"。
 *     只改旁边的方块时状态没变，那种提交不该出现在 blame 历史里 —— 这是最容易写错的一条。
 *   · 合并提交的增量必须**相对我方**存。存成相对对方的增量，indexOf 沿第一父链重建出来的
 *     状态会整个错位，而且不报任何错。
 *   · 同一个区块两边都改了，但改的是**不同的方块** —— 这是最常见的真实情况，
 *     必须能识别出"方块级不冲突"，而不是一律当成冲突吓唬人。
 *   · 共同祖先必须走**全部父节点**。只看第一父链会退化到根提交，两侧自开始以来的
 *     全部改动都会被判成冲突，等于没有合并能力。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const anvil = require('../anvil');
const nbt = require('../nbt');
const wv = require('../worldver');
const bs = require('../blockstate');

let pass = 0, fail = 0;
const failures = [];
/**
 * 所有异步用例的 promise 都登记在这里，最后统一 await。
 *
 * 这条不是"保险"而是"必需"：ta() 返回 promise，写用例时漏一个 await，
 * 断言就会在 process.exit 之后才跑 —— 输出里看不到、计数里也不算，
 * 表现为"这个用例凭空消失"。本次开发就真的踩过一次（4 个用例没执行，
 * 却报 26 项全过）。所以除了调用处写 await，这里再兜一道。
 */
const PENDING = [];
function t(name, fn) {
  try {
    const r = fn();
    // ⚠️ 同步断言器拿到 async 函数时，函数体里的 throw 会变成 rejected promise
    // 被 try/catch 漏掉 —— 测试会「假装通过」。这种静默失效必须直接炸出来。
    if (r && typeof r.then === 'function') throw new Error('这个用例是异步的，请改用 ta()');
    pass++; console.log('  ok   ' + name);
  }
  catch (e) { fail++; failures.push(name + ' -> ' + e.message); console.log(' FAIL  ' + name + ' -> ' + e.message); }
}
function ta(name, fn) {
  const p = (async () => {
    try { await fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; failures.push(name + ' -> ' + e.message); console.log(' FAIL  ' + name + ' -> ' + e.message); }
  })();
  PENDING.push(p);
  return p;
}

console.log('\n=== worldver.js V5 第一组 单测 ===\n');

const TMP = path.join(os.tmpdir(), 'pl-worldver5-test');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

// 索引缓存是进程级的；同一个 node 进程里跑多轮必须手动清，否则读到上一轮的残留
wv.clearCache();
wv.clearObjCache();

const STORE = path.join(TMP, 'store');
const SAVE = path.join(TMP, 'save');
fs.mkdirSync(SAVE, { recursive: true });

/* ================= 造区块 ================= */

/** 调色板固定 4 项，so bits=4。AIR=0 STONE=1 DIRT=2 GRASS=3 */
const PAL = [
  { Name: 'minecraft:air' },
  { Name: 'minecraft:stone' },
  { Name: 'minecraft:dirt' },
  { Name: 'minecraft:grass_block' }
];
const AIR = 0, STONE = 1, DIRT = 2, GRASS = 3;

/** 填充打包（1.16+）：索引不跨 long */
function packPadded(seq, bits, total) {
  const per = Math.floor(64 / bits);
  const out = new Array(Math.ceil(total / per)).fill(0n);
  for (let i = 0; i < total; i++) {
    out[Math.floor(i / per)] |= BigInt(seq[i]) << BigInt((i % per) * bits);
  }
  return out;
}

/**
 * 方块绝对坐标 → 4096 索引（section Y=4，即 y 落在 64..79）
 *
 * ⚠️ 越界坐标**必须炸**，不能默默算出一个"别名索引"。x=20 会算出 (z=3, x=4) 那一格，
 *    而 `blockAt` 恰好也对 x 取模 16 —— 两边用同一个错公式，错位之后断言照样能过，
 *    只是测的已经不是你想测的那个格子了。本文件就真踩过一次：用例里写了 x=25 / x=20，
 *    报出来的现象是"合流把我方的改动吃掉了"，查半天才发现是坐标越界导致的索引错位。
 */
function idxAt(x, y, z) {
  if (!Number.isInteger(x) || x < 0 || x > 15) throw new Error('idxAt: x 必须落在 0..15，收到 ' + x);
  if (!Number.isInteger(z) || z < 0 || z > 15) throw new Error('idxAt: z 必须落在 0..15，收到 ' + z);
  if (!Number.isInteger(y) || y < 64 || y > 79) throw new Error('idxAt: y 必须落在 64..79，收到 ' + y);
  const ly = y - 64;
  return (ly * 16 + z) * 16 + x;
}

/**
 * 把一个区块写进存档。
 * 内容完全由 (cx, cz, edits) 决定 —— edits 相同则 hash 相同，这正是内容寻址要的。
 */
function writeChunk(cx, cz, edits) {
  const seq = new Array(4096).fill(STONE);
  for (const k of Object.keys(edits || {})) seq[Number(k)] = edits[k];
  const raw = nbt.serialize('', {
    DataVersion: 3465, xPos: cx, zPos: cz, yPos: -4,
    sections: [{
      Y: 4,
      block_states: { palette: PAL, data: BigInt64Array.from(packPadded(seq, 4, 4096)) }
    }]
  });
  anvil.writeSaveChunk({ saveDir: SAVE, dim: 'overworld', kind: 'region', cx, cz, raw, backup: false });
  return anvil.hashOf(raw);
}

/** 常态：chunk(0,0) 与 chunk(10,10) 都是整层石头 */
function baseWorld() {
  writeChunk(0, 0, {});
  writeChunk(10, 10, {});
}

const W = 'w5';
const co = (o) => Object.assign({ storeDir: STORE, world: W }, o);

/* ================= 准备一条三提交的历史 =================
 *   c1  基础（整层石头）
 *   c2  把 (3,64,5) 改成泥土
 *   c3  改旁边的方块 (9,64,9) → 草，**不动** (3,64,5)
 *   → blame (3,64,5) 必须归属 c2，且 c3 不该出现
 */
let C1 = '', C2 = '', C3 = '';

(async () => {
  baseWorld();
  const r1 = await wv.init(co({ saveDir: SAVE, message: '开始跟踪' }));
  C1 = r1.initial;

  writeChunk(0, 0, { [idxAt(3, 64, 5)]: DIRT });
  const r2 = await wv.commit(co({ saveDir: SAVE, message: '放下泥土' }));
  C2 = r2.id;

  writeChunk(0, 0, { [idxAt(3, 64, 5)]: DIRT, [idxAt(9, 64, 9)]: GRASS });
  const r3 = await wv.commit(co({ saveDir: SAVE, message: '旁边种草' }));
  C3 = r3.id;

  console.log('--- 提交历史 ---');
  console.log('  c1=' + C1 + '  c2=' + C2 + '  c3=' + C3);

  /* ================= 1. 方块级 blame ================= */
  console.log('\n=== 方块级 blame ===');

  t('三次提交都产生了新版本（没有静默 unchanged）', () => {
    assert.notStrictEqual(C1, C2);
    assert.notStrictEqual(C2, C3);
  });

  t('blame 当前状态正确', () => {
    const r = wv.blameBlock(co({ x: 3, y: 64, z: 5 }));
    assert.strictEqual(r.supported, true, r.reason);
    assert.strictEqual(r.state, 'minecraft:dirt');
    assert.strictEqual(r.chunk, '0,0');
    assert.strictEqual(r.touched, 3, '这个区块被 3 次提交碰过');
  });

  t('blame 归属到**最先引入该状态**的提交，不是最近碰过区块的提交', () => {
    const r = wv.blameBlock(co({ x: 3, y: 64, z: 5 }));
    assert.strictEqual(r.history.length, 2, '应该只有两条：泥土、石头');
    assert.strictEqual(r.history[0].id, C2, '当前状态来自 c2（放下泥土），不是 c3');
    assert.strictEqual(r.history[0].state, 'minecraft:dirt');
    assert.strictEqual(r.history[0].current, true);
    assert.strictEqual(r.history[1].id, C1);
    assert.strictEqual(r.history[1].state, 'minecraft:stone');
    assert.ok(!r.history.some((h) => h.id === C3), 'c3 没动这个方块，不该出现在历史里');
  });

  t('blame 另一列：由 c3 引入', () => {
    const r = wv.blameBlock(co({ x: 9, y: 64, z: 9 }));
    assert.strictEqual(r.state, 'minecraft:grass_block');
    assert.strictEqual(r.history[0].id, C3);
    assert.strictEqual(r.history[1].state, 'minecraft:stone');
  });

  t('blame 没被改过的坐标：状态是基础值，历史只有一条', () => {
    const r = wv.blameBlock(co({ x: 1, y: 64, z: 1 }));
    assert.strictEqual(r.state, 'minecraft:stone');
    assert.strictEqual(r.history.length, 1);
    assert.strictEqual(r.history[0].id, C1);
  });

  t('blame 指定历史提交时看到的是那个版本的状态', () => {
    assert.strictEqual(wv.blameBlock(co({ x: 3, y: 64, z: 5, id: C1 })).state, 'minecraft:stone');
    assert.strictEqual(wv.blameBlock(co({ x: 3, y: 64, z: 5, id: C2 })).state, 'minecraft:dirt');
  });

  t('blame 一个从没被跟踪过的区块时给出可读理由，而不是空历史', () => {
    const r = wv.blameBlock(co({ x: 300, y: 64, z: 300 }));
    assert.strictEqual(r.supported, false);
    assert.ok(r.reason.length > 0, '必须给出理由');
  });

  t('blame 负坐标能正确映射到区块与局部坐标', () => {
    const r = wv.blameBlock(co({ x: -1, y: 64, z: -1 }));
    assert.strictEqual(r.chunk, '-1,-1');
    assert.strictEqual(r.supported, false, '这个区块没被跟踪');
  });

  /* ================= 2. 时间轴回放 ================= */
  console.log('\n=== 时间轴回放 ===');

  t('timeline 给出这个区块的帧列表，且**由旧到新**排列', () => {
    const tl = wv.timeline(co({ cx: 0, cz: 0 }));
    assert.strictEqual(tl.frames.length, 3);
    assert.deepStrictEqual(tl.frames.map((f) => f.id), [C1, C2, C3], '时间必须正着排');
    assert.deepStrictEqual(tl.frames.map((f) => f.index), [0, 1, 2]);
    assert.ok(tl.frames.every((f) => f.exists === true));
  });

  t('timeline 对没变过的区块给出空帧列表', () => {
    const tl = wv.timeline(co({ cx: 99, cz: 99 }));
    assert.strictEqual(tl.frames.length, 0);
  });

  t('frame 取得到每一帧的方块层', () => {
    const f1 = wv.frame(co({ cx: 0, cz: 0, y: 64, id: C1 }));
    assert.strictEqual(f1.states.length, 256, '一层是 16×16');
    assert.strictEqual(f1.states[5 * 16 + 3], 'minecraft:stone', 'c1 那格还是石头');
    const f2 = wv.frame(co({ cx: 0, cz: 0, y: 64, id: C2 }));
    assert.strictEqual(f2.states[5 * 16 + 3], 'minecraft:dirt');
    const f3 = wv.frame(co({ cx: 0, cz: 0, y: 64, id: C3 }));
    assert.strictEqual(f3.states[5 * 16 + 3], 'minecraft:dirt', 'c3 没动这格');
    assert.strictEqual(f3.states[9 * 16 + 9], 'minecraft:grass_block');
  });

  t('frame 的索引是 z*16+x，行列装反就会被这条抓住', () => {
    const f = wv.frame(co({ cx: 0, cz: 0, y: 64, id: C3 }));
    assert.strictEqual(f.states[5 * 16 + 3], 'minecraft:dirt', '(x=3,z=5) 是泥土');
    assert.strictEqual(f.states[3 * 16 + 5], 'minecraft:stone', '(x=5,z=3) 是石头');
  });

  t('frame 对不存在的层给出理由而不是假装成功', () => {
    const f = wv.frame(co({ cx: 0, cz: 0, y: 0, id: C3 }));
    assert.strictEqual(f.states, null);
    assert.ok(/y=0|不在/.test(f.reason), '理由要提到这一层: ' + f.reason);
  });

  t('frame 对不存在的区块给出理由', () => {
    const f = wv.frame(co({ cx: 99, cz: 99, y: 64, id: C3 }));
    assert.strictEqual(f.hash, null);
    assert.ok(/不存在/.test(f.reason), f.reason);
  });

  // ⚠️ 这个用例必须 await。checkout 会**改写共享的存档目录**，而下面的主流程
  //   紧接着也要 checkout(C3) 并写区块。不 await 的话两个 checkout 的写盘会交错，
  //   断言读到的可能是主流程后面才写进去的方块 —— 表现为"checkout 似乎没生效"，
  //   实际是被后一轮覆盖了。异步用例一旦碰共享状态，就必须排队跑。
  await ta('checkout 到 c1 后，工作区真的退回去了', async () => {
    const r = await wv.checkout(co({ saveDir: SAVE, id: C1 }));
    assert.strictEqual(r.ok, true);
    assert.ok(r.written > 0 || r.deleted > 0, '应该写出了东西');
    // 必须**从磁盘读**。blameBlock 读的是对象库（HEAD 的历史），
    // 拿它来验证 checkout 等于自己骗自己 —— 它根本不看存档目录。
    const file = path.join(anvil.dataDir(SAVE, 'overworld', 'region'), anvil.regionFile(0, 0));
    const tree = nbt.parse(anvil.readRaw(anvil.readRegionFile(file), 0, 0).data).value;
    assert.strictEqual(bs.blockAt(tree, 3, 64, 5), 'minecraft:stone', '磁盘上那格应该退回石头');
    assert.strictEqual(bs.blockAt(tree, 9, 64, 9), 'minecraft:stone', '另一格也退回石头');
  });

  /* ================= 3. 自研三方合并 ================= */
  console.log('\n=== 自研三方合并 ===');

  // 回到 C3 状态，然后在两个分支上分别改**不同**的方块
  await wv.checkout(co({ saveDir: SAVE, id: C3 }));

  t('建分支 exp 并切过去', () => {
    wv.createBranch(co({ name: 'exp', from: C3 }));
    const r = wv.switchBranch(co({ name: 'exp' }));
    assert.strictEqual(r.branch, 'exp');
    assert.strictEqual(r.id, C3);
  });

  // exp 上：把 (3,64,5) 从泥土改成草
  writeChunk(0, 0, { [idxAt(3, 64, 5)]: GRASS, [idxAt(9, 64, 9)]: GRASS });
  const rExp = await wv.commit(co({ saveDir: SAVE, message: 'exp：泥土改草' }));
  const EXP = rExp.id;

  // 回 main，退回到 C3，再改**另一个**方块
  wv.switchBranch(co({ name: 'main' }));
  await wv.checkout(co({ saveDir: SAVE, id: C3 }));
  writeChunk(0, 0, { [idxAt(3, 64, 5)]: DIRT, [idxAt(9, 64, 9)]: GRASS, [idxAt(12, 64, 7)]: DIRT });
  const rMain = await wv.commit(co({ saveDir: SAVE, message: 'main：另加一块泥土' }));
  const MAIN = rMain.id;

  t('两个分支各自产生了提交', () => {
    assert.notStrictEqual(MAIN, EXP);
    assert.strictEqual(wv.branches(co({})).find((b) => b.name === 'exp').id, EXP);
    assert.strictEqual(wv.branches(co({})).find((b) => b.name === 'main').id, MAIN);
  });

  let PLAN = null;
  t('共同祖先是 C3（必须走全部父节点，否则会退化到 C1）', () => {
    PLAN = wv.mergePlan(co({ ours: 'main', theirs: 'exp' }));
    assert.strictEqual(PLAN.base, C3, '共同祖先应该是 C3');
    assert.strictEqual(PLAN.strategy, 'conflict');
  });

  t('同一个区块两边都改了 → 区块级冲突', () => {
    assert.strictEqual(PLAN.stats.conflict, 1, 'chunk(0,0) 两侧都改了');
    assert.strictEqual(PLAN.conflictCount, 1);
    assert.strictEqual(PLAN.clean, false);
  });

  t('方块级分析判定"不冲突"：两边改的是不同的方块', () => {
    const c = PLAN.conflicts[0];
    assert.ok(c.detail && c.detail.decoded, '应当做方块级分析');
    assert.strictEqual(c.detail.conflict, 0, '没有一个方块被两边改成不同东西');
    assert.strictEqual(c.detail.disjoint, true, '两边改动不相交');
    assert.strictEqual(c.detail.oursOnly, 1, '我方只改了一个方块');
    assert.strictEqual(c.detail.theirsOnly, 1, '对方只改了一个方块');
  });

  t('方块级不冲突 + 不涉及方块实体 → 能合流，损失归零', () => {
    // 这条是 V5 第二组补完之后**行为反转**的地方。
    // 以前只能整块取一侧：哪怕方块级判定"两边改的不是同一格"，落点也一定会
    // 吃掉另一侧那一格。现在冲突区块能做方块级三方合流，两侧改动都留得下来。
    const c = PLAN.conflicts[0];
    assert.strictEqual(c.mergeable, true, '方块级不冲突、又不涉及方块实体，应当可以合流: ' + c.mergeReason);
    assert.strictEqual(c.dropped, 0, '能合流就不该再丢方块');
    assert.strictEqual(PLAN.stats.droppedBlocks, 0, '总损失也应当是 0');
    assert.ok(c.mergeCells > 0, '应该真的改了几格，实际 ' + c.mergeCells);
    assert.strictEqual(c.mergeLightRisk, 0, '泥土换草都是不透明实心方块，不该有光照风险');
    assert.strictEqual(PLAN.stats.mergeableChunks, 1);
    assert.strictEqual(PLAN.droppedPartial, false, '冲突都在分析上限内，不该标成截断');
  });

  t('策略换成 theirs 也一样能合流（该取对方的取对方、该留我方的留我方）', () => {
    const pt = wv.mergePlan(co({ ours: 'main', theirs: 'exp', strategy: 'theirs' }));
    assert.strictEqual(pt.conflicts[0].mergeable, true);
    assert.strictEqual(pt.conflicts[0].dropped, 0);
    assert.strictEqual(pt.stats.droppedBlocks, 0);
  });

  // 默认门槛这条也是 V5 第二组之后**行为反转**的一处：
  // 以前"有区块冲突就拒绝执行"，因为冲突必然等于丢方块；现在冲突区块能做方块级合流，
  // 两侧改的是不同格时损失是 0，再用 conflictCount 去拦就是自相矛盾
  // （计划书写着"可合流、损失归零"，执行却报"有 1 个区块冲突未解决"）。
  // 真正的拦截条件改成"有救不回来的冲突"，那条由下面的用例用**真冲突**验。
  // 这一条体是同步的（只读计划书），但一样 await：它断言的是"分支指针没动"，
  // 而后面紧接着的用例就会去动指针，靠 microtask 顺序去赌太脆。
  await ta('损失为 0 的区块冲突不该触发默认拦截（git 式：同一区块改不同格 = 自动合并）', async () => {
    const p = wv.mergePlan(co({ ours: 'main', theirs: 'exp' }));
    const risky = p.conflicts.filter((c) => !c.mergeable || (c.dropped || 0) > 0);
    assert.strictEqual(p.conflictCount, 1);
    assert.strictEqual(risky.length, 0, '所有冲突都应当是可无损合流的，实际拦下了 ' + risky.length);
    assert.strictEqual(p.stats.droppedBlocks, 0);
    assert.strictEqual(wv.readRefs(wv.worldRoot(STORE, W)).main, MAIN, '只看计划书不该动指针');
  });

  let MERGED = '';
  t('allowConflicts 时按策略落点并生成**合并提交**', () => {
    // 先量一下存档目录里的字节：合并**只动对象库与提交图**，
    // 把结果落到磁盘是 checkout 的事，不该被合并顺手做掉。
    const file = path.join(anvil.dataDir(SAVE, 'overworld', 'region'), anvil.regionFile(0, 0));
    const before = anvil.hashOf(anvil.readRaw(anvil.readRegionFile(file), 0, 0).data);
    const r = wv.mergeApply(co({ ours: 'main', theirs: 'exp', allowConflicts: true, message: '合并 exp' }));
    const after = anvil.hashOf(anvil.readRaw(anvil.readRegionFile(file), 0, 0).data);
    assert.strictEqual(after, before, '被合并的存档目录不许被改动');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.fastForward, false);
    MERGED = r.id;
    assert.notStrictEqual(MERGED, MAIN);
  });

  t('合并提交有两个父：我方 + 对方', () => {
    const c = wv.readCommit(wv.worldRoot(STORE, W), MERGED);
    assert.strictEqual(c.parent, MAIN, '第一父是我方');
    assert.deepStrictEqual(c.merges, [EXP], '合并父是对方');
    assert.strictEqual(c.mergeFrom, 'exp');
    assert.strictEqual(c.conflicts.length, 1, '冲突清单要记进提交，方便之后回查');
  });

  t('合并提交的增量相对**我方**存 —— indexOf 沿第一父链重建必须正确', () => {
    const st = wv.indexOf(wv.worldRoot(STORE, W), MERGED);
    assert.ok(st instanceof Map, '索引要能重建出来');
    const f = wv.frame(co({ cx: 0, cz: 0, y: 64, id: MERGED }));
    // 索引是 z*16+x。合流之后**两侧的改动都留下来了**，这是本轮的核心价值：
    //   (x=3, z=5)  对方把泥土改成草 → 结果应当是草（对方那格被采纳）
    //   (x=12,z=7)  我方加的泥土     → 结果应当是泥土（我方那格没被吃掉）
    assert.strictEqual(f.states[5 * 16 + 3], 'minecraft:grass_block', '对方那格的改动必须保留');
    assert.strictEqual(f.states[7 * 16 + 12], 'minecraft:dirt', '我方那格的改动必须保留');
    assert.strictEqual(f.states[9 * 16 + 9], 'minecraft:grass_block');
  });

  await ta('合并后 main 上 exp 的非冲突改动确实进了结果', async () => {
    // chunk(10,10) 两边都没动 → 合并结果里必须有它
    const tl = wv.timeline(co({ cx: 10, cz: 10 }));
    assert.ok(tl.frames.length >= 1, 'chunk(10,10) 应该还在');
  });

  t('log 能看出这是一次合并', () => {
    const rows = wv.log(co({}));
    const m = rows.find((r) => r.id === MERGED);
    assert.ok(m, '合并提交要在历史里');
    assert.deepStrictEqual(m.merges, [EXP]);
    assert.strictEqual(m.mergeFrom, 'exp');
    assert.strictEqual(m.conflictCount, 1);
    assert.strictEqual(rows[0].id, MERGED, '合并提交是 HEAD');
  });

  t('合并完再合一次 → upToDate（对方已是我方祖先）', () => {
    const p = wv.mergePlan(co({ ours: 'main', theirs: 'exp' }));
    assert.strictEqual(p.upToDate, true);
  });

  t('我方是对方祖先 → fastForward，不产生新提交', () => {
    wv.createBranch(co({ name: 'ff', from: C1 }));
    const p = wv.mergePlan(co({ ours: 'ff', theirs: 'main' }));
    assert.strictEqual(p.fastForward, true);
    const r = wv.mergeApply(co({ ours: 'ff', theirs: 'main' }));
    assert.strictEqual(r.fastForward, true);
    assert.strictEqual(r.id, MERGED, '快进就是把指针移过去');
    assert.strictEqual(wv.readRefs(wv.worldRoot(STORE, W)).ff, MERGED);
  });

  // ⚠️ 必须 await：这条会在里面**新建并切换分支 other**，后面两条用例全靠它。
  //   不 await 就轮到后面时 other 还不存在 —— 报出来的错会指向"分支不存在"，
  //   让人以为是 mergePlan 的问题，其实是这条用例还没跑完。
  await ta('真·方块级冲突能被识别出来', async () => {
    // 两侧把**同一个方块**改成不同东西
    wv.switchBranch(co({ name: 'main' }));
    await wv.checkout(co({ saveDir: SAVE, id: MERGED }));
    writeChunk(0, 0, { [idxAt(3, 64, 5)]: STONE, [idxAt(9, 64, 9)]: GRASS, [idxAt(12, 64, 7)]: DIRT });
    const a = await wv.commit(co({ saveDir: SAVE, message: 'main：那格改回石头' }));
    wv.createBranch(co({ name: 'other', from: MERGED }));
    wv.switchBranch(co({ name: 'other' }));
    await wv.checkout(co({ saveDir: SAVE, id: MERGED }));
    writeChunk(0, 0, { [idxAt(3, 64, 5)]: AIR, [idxAt(9, 64, 9)]: GRASS, [idxAt(12, 64, 7)]: DIRT });
    const b = await wv.commit(co({ saveDir: SAVE, message: 'other：那格挖成空气' }));
    assert.notStrictEqual(a.id, b.id);

    const p = wv.mergePlan(co({ ours: 'main', theirs: 'other' }));
    assert.strictEqual(p.conflictCount, 1);
    const d = p.conflicts[0].detail;
    assert.ok(d.decoded, '要做方块级分析');
    assert.strictEqual(d.conflict, 1, '正好一个方块真冲突');
    assert.strictEqual(d.disjoint, false);
    assert.strictEqual(d.conflictSample.length, 1);
    const s = d.conflictSample[0];
    assert.strictEqual(s.x, 3);
    assert.strictEqual(s.y, 64);
    assert.strictEqual(s.z, 5);
    // base 是 MERGED。注意 MERGED 里 (3,64,5) 已经是**草**（上一轮合流把对方的改动
    // 保留下来了），不再是泥土 —— 这正是合流生效后被连带改变的一处期望值。
    assert.strictEqual(s.base, 'minecraft:grass_block');
    assert.strictEqual(s.ours, 'minecraft:stone');
    assert.strictEqual(s.theirs, 'minecraft:air');
    // 真冲突合流也救不了：这一格必然被覆盖一次，所以损失仍然记 1
    assert.strictEqual(p.conflicts[0].dropped, 1);
    assert.strictEqual(p.stats.droppedBlocks, 1);
    assert.strictEqual(p.conflicts[0].mergeable, true, '合流本身是能做的，只是救不了这一格');
    assert.strictEqual(p.conflicts[0].mergeCells, 0, '除了真冲突那格，没有别的格子要合');
  });

  // 上面那条的反面：真有救不回来的东西时才拦，而且拦得**说得清**。
  // main/other 在这一格上是"石头 vs 空气"的真冲突，合流救不了，所以默认必须中止。
  await ta('有救不回来的冲突时默认拒绝执行，并带上计划书', async () => {
    const before = wv.readRefs(wv.worldRoot(STORE, W)).main;
    const p = wv.mergePlan(co({ ours: 'main', theirs: 'other' }));
    assert.strictEqual(p.stats.droppedBlocks, 1, '真冲突那一格必然被覆盖一次');
    assert.strictEqual(p.conflicts.filter((c) => !c.mergeable || (c.dropped || 0) > 0).length, 1);

    let err = null;
    try { wv.mergeApply(co({ ours: 'main', theirs: 'other' })); } catch (e) { err = e; }
    assert.ok(err, '有损失必须默认中止');
    assert.strictEqual(err.code, 'MERGE_CONFLICT');
    assert.ok(err.plan, '错误里要带计划书，UI 才能显示冲突详情');
    assert.ok(/1 处方块改动会被覆盖/.test(err.message), '错误信息要给出损失量: ' + err.message);
    assert.ok(/allowConflicts/.test(err.message), '要告诉用户怎么继续');
    assert.strictEqual(wv.readRefs(wv.worldRoot(STORE, W)).main, before, '分支指针不许动');
  });

  await ta('strategy=theirs 时冲突区块取对方', async () => {
    const p = wv.mergePlan(co({ ours: 'main', theirs: 'other', strategy: 'theirs' }));
    assert.strictEqual(p.conflicts[0].resolved, p.conflicts[0].theirs);
    const r = wv.mergeApply(co({ ours: 'main', theirs: 'other', strategy: 'theirs', allowConflicts: true }));
    assert.strictEqual(r.ok, true);
    const f = wv.frame(co({ cx: 0, cz: 0, y: 64, id: r.id }));
    assert.strictEqual(f.states[5 * 16 + 3], 'minecraft:air', '按 theirs 落点');
  });

  /* ================= 合流产出真实字节（V5 第二组） ================= */
  console.log('\n=== 合流产出真实字节 ===');

  // 带 chest / glass 的调色板。6 项仍然只占 4 位（bitsForCount 的下限就是 4），
  // 所以不影响上面那些用 PAL 构造的场景。
  const PAL2 = PAL.concat([{ Name: 'minecraft:chest' }, { Name: 'minecraft:glass' }]);

  /**
   * 造一个"字段比较像真区块"的区块：带 PostProcessing（**LIST of SHORT**）、
   * Heightmaps（LONG_ARRAY）、Status。
   * PostProcessing 是这一整套改动的试金石 —— 它里面全是 0，JS 看不出类型，
   * 不带类型表写回就会变成 LIST of INT，游戏读这种区块直接报错。
   */
  function richChunk(edits, opts) {
    const o = opts || {};
    const seq = new Array(4096).fill(STONE);
    for (const k of Object.keys(edits || {})) seq[Number(k)] = edits[k];
    const ty = nbt.newTypes();
    const pp = new Array(64).fill(0);
    ty.node.set(pp, nbt.T.LIST);
    ty.list.set(pp, nbt.T.SHORT);
    const body = {
      DataVersion: 3465, xPos: 0, zPos: 0, yPos: -4, Status: 'full', InhabitedTime: 1234,
      PostProcessing: pp,
      sections: [{ Y: 4, block_states: { palette: PAL2, data: BigInt64Array.from(packPadded(seq, 4, 4096)) } }],
      Heightmaps: { WORLD_SURFACE: BigInt64Array.from([1n, 2n, -3n]) }
    };
    if (o.withBE) {
      body.block_entities = [
        { id: 'minecraft:chest', x: 3, y: 64, z: 5, KeepPacked: 0, Items: [] },
        { id: 'minecraft:chest', x: 3, y: 65, z: 5, KeepPacked: 0, Items: [] }
      ];
    }
    return nbt.serialize('', body, ty);
  }

  t('合流：两侧改不同格 → 产出的字节里两格都在', () => {
    const base = richChunk({ [idxAt(3, 64, 5)]: DIRT });
    const ours = richChunk({ [idxAt(3, 64, 5)]: DIRT, [idxAt(6, 64, 11)]: DIRT });
    const theirs = richChunk({ [idxAt(3, 64, 5)]: GRASS });
    const r = wv.mergeChunkBytes({ base, ours, theirs, strategy: 'ours', cx: 0, cz: 0 });
    assert.strictEqual(r.ok, true, r.reason);
    assert.strictEqual(r.stats.conflict, 0);
    // 只有"对方改、我方没改"那一格需要写进新字节；我方那格本来就是新字节的基础
    assert.strictEqual(r.stats.cells, 1);
    const tree = nbt.parse(r.raw).value;
    assert.strictEqual(bs.blockAt(tree, 3, 64, 5), 'minecraft:grass_block', '对方那格被采纳');
    assert.strictEqual(bs.blockAt(tree, 6, 64, 11), 'minecraft:dirt', '我方那格没被吃掉');
    assert.strictEqual(bs.blockAt(tree, 0, 64, 0), 'minecraft:stone', '没动的格子原样');
    assert.strictEqual(bs.blockAt(tree, 5, 64, 3), 'minecraft:stone', '(x=5,z=3) 不能跟着动');
    assert.strictEqual(tree.Status, 'full', '其它字段要原样保留');
    assert.strictEqual(tree.InhabitedTime, 1234);
    assert.deepStrictEqual(Array.from(tree.Heightmaps.WORLD_SURFACE), [1n, 2n, -3n]);
  });

  t('两侧把同一格改成同一样东西 → 一格都不用写，原样返回我方字节', () => {
    // 这是"看起来要合、实际什么都不用干"的情形：差异全是 bothSame / oursOnly，
    // 硬走一遍重编码既浪费时间，又给了"本来无损却被编坏"的机会。
    const base = richChunk({ [idxAt(3, 64, 5)]: STONE });
    const ours = richChunk({ [idxAt(3, 64, 5)]: DIRT });
    const theirs = richChunk({ [idxAt(3, 64, 5)]: DIRT });
    const r = wv.mergeChunkBytes({ base, ours, theirs, strategy: 'ours', cx: 0, cz: 0 });
    assert.strictEqual(r.ok, true, r.reason);
    assert.strictEqual(r.stats.cells, 0);
    assert.strictEqual(r.unchanged, true, '没有格子要改就该说明白，而不是悄悄重编码一遍');
    assert.strictEqual(r.raw, ours, '必须原样把我方字节还回来');
    assert.strictEqual(bs.blockAt(nbt.parse(r.raw).value, 3, 64, 5), 'minecraft:dirt');
  });

  t('合流产出的字节自己必须能无损 round-trip（类型没被改坏）', () => {
    // 这条把地基和合流串起来验：只要写回时类型被改，round-trip 立刻不相等
    const base = richChunk({ [idxAt(3, 64, 5)]: DIRT });
    const ours = richChunk({ [idxAt(3, 64, 5)]: DIRT, [idxAt(6, 64, 11)]: DIRT });
    const theirs = richChunk({ [idxAt(3, 64, 5)]: GRASS });
    const r = wv.mergeChunkBytes({ base, ours, theirs, strategy: 'ours', cx: 0, cz: 0 });
    const rt = nbt.roundTrip(r.raw);
    assert.strictEqual(rt.identical, true, '合流结果的 round-trip 必须字节一致');

    const key = 'PostProcessing';
    const at = r.raw.indexOf(Buffer.from(key, 'utf8')) + key.length;
    assert.strictEqual(r.raw[at], nbt.T.SHORT, 'PostProcessing 必须是 LIST of SHORT');
    // 反面对照：不带类型表写一遍，它就会变成 LIST of INT —— 这正是当初卡住合并的那个坑
    const bad = nbt.serialize('', nbt.parse(r.raw).value);
    const at2 = bad.indexOf(Buffer.from(key, 'utf8')) + key.length;
    assert.strictEqual(bad[at2], nbt.T.INT, '不带类型表就会写成 INT（对照组）');
  });

  t('涉及方块实体 → 拒绝合流并说清原因，不硬合', () => {
    // 硬合的结果是箱子变空，属于静默丢数据 —— 宁可退回整块取一侧
    const base = richChunk({ [idxAt(3, 64, 5)]: 4 }, { withBE: true });      // 4 = chest
    const ours = richChunk({ [idxAt(3, 64, 5)]: 4, [idxAt(6, 64, 11)]: DIRT }, { withBE: true });
    const theirs = richChunk({ [idxAt(3, 64, 5)]: STONE }, { withBE: true }); // 对方把那格改成石头
    const r = wv.mergeChunkBytes({ base, ours, theirs, strategy: 'ours', cx: 0, cz: 0 });
    assert.strictEqual(r.ok, false, '碰到方块实体载体必须拒绝');
    assert.strictEqual(r.code, 'NEEDS_BLOCK_ENTITY');
    assert.ok(/方块实体/.test(r.reason), r.reason);
    assert.strictEqual(r.raw, null, '拒绝时不能返回半成品字节');
  });

  t('合流顺手清掉"坐标对不上方块"的残留方块实体（脏数据）', () => {
    // 正常情况下方块实体载体的改动会被上一条拒绝掉，所以这里测的是**脏数据**：
    // 存档里偶尔会留下一个坐标上已经没有箱子的箱子实体（崩溃或第三方工具造成）。
    // 合流改到那一格时顺手删掉它 —— 留着会在游戏里变成一个"看不见的容器"。
    const seq = new Array(4096).fill(STONE);
    const base = richChunk({ [idxAt(3, 64, 5)]: STONE }, { withBE: true });
    const ours = richChunk({ [idxAt(3, 64, 5)]: STONE }, { withBE: true });
    const theirs = richChunk({ [idxAt(3, 64, 5)]: 5 });      // 对方把那格改成玻璃
    const r = wv.mergeChunkBytes({ base, ours, theirs, strategy: 'ours', cx: 0, cz: 0 });
    assert.strictEqual(r.ok, true, r.reason);
    const tree = nbt.parse(r.raw).value;
    assert.strictEqual(bs.blockAt(tree, 3, 64, 5), 'minecraft:glass');
    assert.strictEqual(r.stats.removedBlockEntities, 1, '那一格的残留实体应当被删掉');
    assert.strictEqual(tree.block_entities.length, 1, '另一个 BE 的坐标没被动过，必须留着');
    assert.strictEqual(tree.block_entities[0].x, 3);
    assert.strictEqual(tree.block_entities[0].y, 65);
  });

  t('涉及非不透明方块 → 合流照做，但把光照风险逐格报出来', () => {
    // 透明度变化的格子会让该格光照与高度图过时（进游戏表现为局部偏暗/偏亮）。
    // 这不是数据损坏，所以**不拒绝**；但也绝不替用户咽下去 —— 逐格报上来。
    const base = richChunk({ [idxAt(7, 64, 13)]: STONE });
    const ours = richChunk({ [idxAt(7, 64, 13)]: STONE, [idxAt(6, 64, 11)]: DIRT });
    const theirs = richChunk({ [idxAt(7, 64, 13)]: 5, [idxAt(8, 64, 14)]: DIRT }); // 5 = glass
    const r = wv.mergeChunkBytes({ base, ours, theirs, strategy: 'ours', cx: 0, cz: 0 });
    assert.strictEqual(r.ok, true, r.reason);
    // (8,64,14) 是"石头换泥土"，两边都是不透明完整方块 → 不该进风险清单。
    // 要是 isOpaque 判错（或者干脆不判），这条会变成 2。
    assert.strictEqual(r.stats.lightRisk, 1, '只有玻璃那格算光照风险');
    assert.strictEqual(r.lightRisk.length, 1);
    assert.strictEqual(r.lightRisk[0].x, 7);
    assert.strictEqual(r.lightRisk[0].y, 64);
    assert.strictEqual(r.lightRisk[0].z, 13);
    assert.strictEqual(r.lightRisk[0].from, 'minecraft:stone');
    assert.strictEqual(r.lightRisk[0].to, 'minecraft:glass');
    // 但方块还是改过去了 —— 我们只报告，不替用户拒绝
    const tree = nbt.parse(r.raw).value;
    assert.strictEqual(bs.blockAt(tree, 7, 64, 13), 'minecraft:glass');
    assert.strictEqual(bs.blockAt(tree, 8, 64, 14), 'minecraft:dirt');
  });

  t('合流把方块挖成空气也算光照风险（最常见的真实情形）', () => {
    // 挖方块是最常见的存档改动。空气是"非不透明"里最典型的一种，
    // 后缀规则（_air）要覆盖不到裸名 minecraft:air 就整条失效了。
    const base = richChunk({ [idxAt(2, 64, 9)]: STONE });
    const ours = richChunk({ [idxAt(2, 64, 9)]: STONE });
    const theirs = richChunk({ [idxAt(2, 64, 9)]: AIR });
    const r = wv.mergeChunkBytes({ base, ours, theirs, strategy: 'ours', cx: 0, cz: 0 });
    assert.strictEqual(r.ok, true, r.reason);
    assert.strictEqual(r.stats.lightRisk, 1);
    assert.strictEqual(r.lightRisk[0].to, 'minecraft:air');
    assert.strictEqual(bs.blockAt(nbt.parse(r.raw).value, 2, 64, 9), 'minecraft:air');
  });

  t('对方改了我方没有的区段 → 拒绝合流（重写不到那儿）', () => {
    const seq = new Array(4096).fill(STONE);
    const ty = nbt.newTypes();
    const sec = (y, s) => ({
      Y: y, block_states: { palette: PAL2, data: BigInt64Array.from(packPadded(s, 4, 4096)) }
    });
    const base = nbt.serialize('', {
      DataVersion: 3465, xPos: 0, zPos: 0, yPos: -4, sections: [sec(4, seq)]
    }, ty);
    const ours = nbt.serialize('', {
      DataVersion: 3465, xPos: 0, zPos: 0, yPos: -4, sections: [sec(4, seq)]
    }, ty);
    const s2 = seq.slice(); s2[3] = DIRT;
    const theirs = nbt.serialize('', {
      DataVersion: 3465, xPos: 0, zPos: 0, yPos: -4, sections: [sec(4, seq), sec(5, s2)]
    }, ty);
    const r = wv.mergeChunkBytes({ base, ours, theirs, strategy: 'ours', cx: 0, cz: 0 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'MISSING_SECTION');
    assert.ok(/没有的区段/.test(r.reason), r.reason);
  });

  /* ================= 端到端：合流结果真的落到磁盘 ================= */
  await ta('端到端：合流 → checkout → 从磁盘读，两侧改动都在', async () => {
    wv.switchBranch(co({ name: 'main' }));
    await wv.checkout(co({ saveDir: SAVE, id: C3 }));

    // c3 的状态：(3,64,5)=泥土、(9,64,9)=草，其余石头。
    // 两条分支各改**不同的一格** —— 这是真实里最常见的情形（两人在同一个区块里
    // 各干各的），也正是"方块级合流"存在的理由。刻意不让它们撞同一格，
    // 这样合并能走**默认**路径（不传 allowConflicts）—— 顺带验证默认门槛没把
    // 无损合并拦下来。
    const C3STATE = { [idxAt(3, 64, 5)]: DIRT, [idxAt(9, 64, 9)]: GRASS };

    wv.createBranch(co({ name: 'flowA', from: C3 }));
    wv.switchBranch(co({ name: 'flowA' }));
    await wv.checkout(co({ saveDir: SAVE, id: C3 }));
    writeChunk(0, 0, Object.assign({}, C3STATE, { [idxAt(1, 64, 1)]: DIRT }));
    const aId = (await wv.commit(co({ saveDir: SAVE, message: 'flowA：加一格泥土' }))).id;

    wv.createBranch(co({ name: 'flowB', from: C3 }));
    wv.switchBranch(co({ name: 'flowB' }));
    await wv.checkout(co({ saveDir: SAVE, id: C3 }));
    writeChunk(0, 0, Object.assign({}, C3STATE, { [idxAt(11, 64, 2)]: GRASS }));
    const bId = (await wv.commit(co({ saveDir: SAVE, message: 'flowB：再种一格草' }))).id;
    assert.notStrictEqual(aId, bId);

    wv.switchBranch(co({ name: 'flowA' }));
    const mg = wv.mergeApply(co({ ours: 'flowA', theirs: 'flowB', message: '合流 flowB' }));
    assert.strictEqual(mg.ok, true, JSON.stringify(mg).slice(0, 200));
    assert.ok(mg.mergedChunks >= 1, '应当至少合掉一个区块，实际 ' + mg.mergedChunks);
    assert.ok(mg.mergedBytes > 0, '合流应当真的产出了字节');
    assert.strictEqual(mg.lightRiskBlocks, 0, '泥土换泥土、石头换草都不涉及透明方块');

    // mergeApply 的边界：**只写版本库，不碰存档目录**。落盘仍然是切到该分支再 checkout。
    const ck = await wv.checkout(co({ saveDir: SAVE, id: mg.id }));
    assert.strictEqual(ck.ok, true);

    // 必须从**磁盘**读。读对象库/HEAD 的历史等于自己骗自己。
    const file = path.join(anvil.dataDir(SAVE, 'overworld', 'region'), anvil.regionFile(0, 0));
    const tree = nbt.parse(anvil.readRaw(anvil.readRegionFile(file), 0, 0).data).value;
    assert.strictEqual(bs.blockAt(tree, 1, 64, 1), 'minecraft:dirt', 'flowA 那格没被吃掉');
    assert.strictEqual(bs.blockAt(tree, 11, 64, 2), 'minecraft:grass_block', 'flowB 那格也落盘了');
    assert.strictEqual(bs.blockAt(tree, 3, 64, 5), 'minecraft:dirt', 'base 里的内容不能被抹掉');
    assert.strictEqual(bs.blockAt(tree, 9, 64, 9), 'minecraft:grass_block');
    assert.strictEqual(bs.blockAt(tree, 0, 64, 0), 'minecraft:stone');
    // 落盘的区块自己还得是类型正确的
    const rt = nbt.roundTrip(anvil.readRaw(anvil.readRegionFile(file), 0, 0).data);
    assert.strictEqual(rt.identical, true, '落盘区块的 round-trip 必须字节一致');
  });

  t('不存在的分支/自我合并都给出明确错误', () => {
    assert.throws(() => wv.mergePlan(co({ ours: 'main', theirs: 'nope' })), /不存在|还没有提交/);
    assert.throws(() => wv.mergePlan(co({ ours: 'main', theirs: 'main' })), /合并到它自己/);
  });

  /* ================= 汇总 ================= */
  // 先把所有异步用例收干，再报数 —— 顺序反了就会漏掉还没跑完的用例
  await Promise.all(PENDING);
  console.log('\n=== worldver.js V5 第一组 结果 ===');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  if (failures.length) { console.log('失败清单:'); for (const f of failures) console.log('  · ' + f); }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n测试脚本自身崩了: ' + (e && e.stack || e));
  process.exit(1);
});
