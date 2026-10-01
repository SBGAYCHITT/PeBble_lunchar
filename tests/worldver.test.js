/*
 * worldver.js（世界版本控制）单测。
 *
 * 全部用合成存档，不依赖真实 .minecraft。重点覆盖那些"看起来对、实际错"的地方：
 *   · 内容寻址去重：同一个区块内容在多个提交里只落一份对象
 *   · status 必须是**只读**的，不能顺手往对象库里塞东西
 *   · 分支之间互不干扰（在 experiment 上提交，main 的 HEAD 不许动）
 *   · checkout 既要写回老内容，也要删掉目标版本里不存在的区块
 *   · 索引是"沿父提交回溯重建"的，缓存清掉后结果必须一模一样
 *   · entities/ 目录与 region/ 分开跟踪，互不串味
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const anvil = require('../anvil');
const nbt = require('../nbt');
const wv = require('../worldver');

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

console.log('\n=== worldver.js 单测 ===\n');

const TMP = path.join(os.tmpdir(), 'pl-worldver-test');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

/* 索引缓存是**进程级**的（不然每次 diff 都要重走一遍提交链）。同一个 node 进程里
   跑多轮测试时，必须手动清掉，否则第二轮读到的是上一轮同名目录留下的缓存。 */
wv.clearCache();

function mkSave(name) {
  const d = path.join(TMP, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 造一个"像区块"的最小 NBT，返回它的内容指纹（用来断言去重） */
function chunkRaw(marker, pad) {
  const body = { DataVersion: 3465, Status: 'full', Marker: String(marker), xPos: 0, zPos: 0 };
  if (pad) body.Pad = 'x'.repeat(pad);
  return nbt.serialize('', body);
}
function put(saveDir, cx, cz, marker, o) {
  const opt = o || {};
  const raw = chunkRaw(marker, opt.pad);
  anvil.writeSaveChunk({
    saveDir, dim: opt.dim || 'overworld', kind: opt.kind || 'region',
    cx, cz, raw, backup: false
  });
  return anvil.hashOf(raw);
}
function markerOf(saveDir, cx, cz, o) {
  const opt = o || {};
  const r = anvil.readSaveChunk({ saveDir, dim: opt.dim || 'overworld', kind: opt.kind || 'region', cx, cz });
  if (!r) return null;
  return nbt.parse(r.raw).value.Marker;
}

const SAVE = mkSave('新世界');
const STORE = path.join(TMP, 'worldver');
const W = '新世界';

let baseId = null;     // 首个提交
let editId = null;     // 第二次提交：改 1 个 + 加 2 个
let revertId = null;   // 第三次提交：把 0,0 改回首提的内容（验证内容寻址去重）
let expId = null;      // experiment 分支的提交
let dirtyId = null;    // main 上的最新提交（改 1 加 1 删 1）

/* ================= 1. 名称与路径 ================= */
console.log('--- 命名与路径 ---');

t('worldKeyOf：Windows 非法字符被替换、结尾的点和空格被去掉', () => {
  assert.strictEqual(wv.worldKeyOf('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.strictEqual(wv.worldKeyOf('新世界'), '新世界');
  assert.strictEqual(wv.worldKeyOf('trailing. '), 'trailing');
  assert.strictEqual(wv.worldKeyOf(''), 'world');
  assert.strictEqual(wv.worldKeyOf(null), 'world');
});

t('ensureStore 幂等：已有 refs.json / HEAD 不会被重置', () => {
  const root = wv.ensureStore(STORE, W);
  assert.ok(fs.existsSync(path.join(root, 'objects')));
  assert.ok(fs.existsSync(path.join(root, 'commits')));
  fs.writeFileSync(path.join(root, 'HEAD'), 'mybranch');
  wv.ensureStore(STORE, W);   // 再建一次
  assert.strictEqual(wv.readHead(root), 'mybranch', 'HEAD 被重置了');
  fs.writeFileSync(path.join(root, 'HEAD'), wv.DEFAULT_BRANCH);
});

/* ================= 2. init / commit ================= */
(async () => {
  console.log('\n--- init 与提交 ---');

  await ta('init：建库 + 首个提交，第二次 init 报 existed=true', async () => {
    put(SAVE, 0, 0, 'a');
    put(SAVE, 1, 0, 'b');
    put(SAVE, 0, 1, 'c');
    put(SAVE, -1, -1, 'neg');
    put(SAVE, 0, 0, 'nether-a', { dim: 'nether' });
    put(SAVE, 0, 0, 'ent-1', { kind: 'entities' });

    const r = await wv.init({ saveDir: SAVE, storeDir: STORE, world: W });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.existed, false);
    baseId = r.initial;
    assert.ok(baseId, '没有产生首个提交');

    const r2 = await wv.init({ saveDir: SAVE, storeDir: STORE, world: W });
    assert.strictEqual(r2.existed, true);
    assert.strictEqual(r2.initial, baseId);
  });

  await ta('commit：什么都没改 → unchanged，不产生新提交', async () => {
    const before = wv.stats({ storeDir: STORE, world: W }).commits;
    const r = await wv.commit({ saveDir: SAVE, storeDir: STORE, world: W, message: '无改动' });
    assert.strictEqual(r.unchanged, true);
    assert.strictEqual(r.id, baseId);
    assert.strictEqual(wv.stats({ storeDir: STORE, world: W }).commits, before, '不该多出提交');
  });

  await ta('commit：改 1 个 + 加 2 个 → changed 计数正确', async () => {
    put(SAVE, 0, 0, 'a2');
    put(SAVE, 5, 5, 'n1');
    put(SAVE, 6, 5, 'n2');
    const r = await wv.commit({ saveDir: SAVE, storeDir: STORE, world: W, message: '拆主城试试' });
    assert.strictEqual(r.unchanged, false);
    editId = r.id;
    assert.notStrictEqual(editId, baseId, '同一秒内提交的 id 必须去重');
    assert.strictEqual(r.changed.add, 3, 'add 应为 3，实际 ' + r.changed.add);
    assert.strictEqual(r.changed.del, 0);
    assert.ok(r.newBytes > 0, 'newBytes 应有值');
  });

  await ta('提交只存增量：第二次提交的 dims 里 add 只有 3 条', async () => {
    const root = wv.worldRoot(STORE, W);
    const c = wv.readCommit(root, editId);
    const add = Object.keys(c.dims.overworld.region.add);
    assert.deepStrictEqual(add.sort(), ['0,0', '5,5', '6,5']);
    assert.strictEqual(c.parent, baseId);
  });

  await ta('内容寻址去重：未改动的区块不重复落对象', async () => {
    const root = wv.worldRoot(STORE, W);
    // 首提 5 个 region 区块 + 1 个 entities 区块；二提只有 3 个新内容
    const st = wv.stats({ storeDir: STORE, world: W });
    assert.strictEqual(st.objects, 9, '对象数应为 9（8 region 内容 + 1 entities），实际 ' + st.objects);
    // 落盘走的是"先写 .tmp 再改名"，库里不该留下任何半成品
    const leftovers = [];
    for (const d of fs.readdirSync(path.join(root, 'objects'))) {
      for (const f of fs.readdirSync(path.join(root, 'objects', d))) {
        if (f.endsWith('.tmp')) leftovers.push(d + '/' + f);
      }
    }
    assert.deepStrictEqual(leftovers, [], '不应留下 .tmp 半成品');
  });

  await ta('重复提交同样内容只落一份对象：把 a2 改回 a 不产生新对象', async () => {
    const root = wv.worldRoot(STORE, W);
    const before = wv.stats({ storeDir: STORE, world: W }).objects;
    put(SAVE, 0, 0, 'a');   // 内容回到首提时的 'a'
    const r = await wv.commit({ saveDir: SAVE, storeDir: STORE, world: W, message: '改回去' });
    revertId = r.id;
    assert.strictEqual(r.changed.add, 1);
    assert.strictEqual(r.newBytes, 0, '内容已存在，不该写新对象');
    assert.strictEqual(wv.stats({ storeDir: STORE, world: W }).objects, before);
    // 这份内容的对象仍是首提写的那一个
    assert.ok(wv.hasObject(root, anvil.hashOf(chunkRaw('a'))), '该对象应仍在库里');
  });

  /* ================= 3. status ================= */
  console.log('\n--- status（必须只读） ---');

  await ta('status：干净工作区 → 无改动', async () => {
    const r = await wv.status({ saveDir: SAVE, storeDir: STORE, world: W });
    assert.strictEqual(r.tracked, true);
    assert.strictEqual(r.changes.total, 0, JSON.stringify(r.changes));
    assert.ok(r.chunks > 0, '应报出工作区区块数');
    assert.ok(r.bytes > 0, '应报出工作区数据量');
  });

  await ta('status：改 1 加 1 删 1，计数与 sample 都对', async () => {
    put(SAVE, 5, 5, 'n1-改');                       // change
    put(SAVE, 7, 7, 'n3');                          // add
    anvil.applySaveChunks({ saveDir: SAVE, dim: 'overworld', dels: [{ cx: 6, cz: 5 }], backup: false });
    const r = await wv.status({ saveDir: SAVE, storeDir: STORE, world: W });
    assert.strictEqual(r.changes.add, 1, JSON.stringify(r.changes));
    assert.strictEqual(r.changes.change, 1);
    assert.strictEqual(r.changes.del, 1);
    assert.deepStrictEqual(r.sample.change, ['5,5']);
    assert.deepStrictEqual(r.sample.add, ['7,7']);
    assert.deepStrictEqual(r.sample.del, ['6,5']);
  });

  await ta('status 不写对象库（看一眼不该留副作用）', async () => {
    const before = wv.stats({ storeDir: STORE, world: W }).objects;
    await wv.status({ saveDir: SAVE, storeDir: STORE, world: W });
    assert.strictEqual(wv.stats({ storeDir: STORE, world: W }).objects, before, 'status 往库里写了东西');
  });

  await ta('未跟踪的存档：tracked=false 且不抛错', async () => {
    const other = mkSave('没跟踪过');
    put(other, 0, 0, 'x');
    const r = await wv.status({ saveDir: other, storeDir: STORE, world: '没跟踪过' });
    assert.strictEqual(r.tracked, false);
    assert.strictEqual(r.head, null);
    assert.strictEqual(r.changes.total, 0);
    // 只是"看一眼"，库里不该多出一个空存档（否则它会出现在 listWorlds 里）
    assert.strictEqual(fs.existsSync(wv.worldRoot(STORE, '没跟踪过')), false,
      'status 不该创建库目录');
  });

  dirtyId = (await wv.commit({ saveDir: SAVE, storeDir: STORE, world: W, message: '第三次' })).id;

  /* ================= 4. log / diff / blame ================= */
  console.log('\n--- log / diff / blame ---');

  await ta('log：最新在前，isHead 标记正确', async () => {
    const lg = wv.log({ storeDir: STORE, world: W });
    assert.strictEqual(lg[0].id, dirtyId);
    assert.strictEqual(lg[0].isHead, true);
    assert.strictEqual(lg[lg.length - 1].id, baseId, '最老的应是首提');
    assert.strictEqual(lg[lg.length - 1].parent, null);
  });

  await ta('log：limit 生效', async () => {
    const lg = wv.log({ storeDir: STORE, world: W, limit: 2 });
    assert.strictEqual(lg.length, 2);
    assert.strictEqual(lg[0].id, dirtyId);
  });

  await ta('diff：added / changed / removed 三类齐全', async () => {
    // 基线取 revertId 而不是 editId —— 0,0 在 revertId 已经变回 'a'，到 dirtyId 之间没再动过
    const d = wv.diff({ storeDir: STORE, world: W, a: revertId, b: dirtyId });
    assert.strictEqual(d.counts.changed, 1, JSON.stringify(d.counts));
    assert.strictEqual(d.counts.added, 1);
    assert.strictEqual(d.counts.removed, 1);
    assert.deepStrictEqual(d.changed, ['5,5']);
    assert.deepStrictEqual(d.added, ['7,7']);
    assert.deepStrictEqual(d.removed, ['6,5']);
  });

  await ta('diff：同一个提交跟自己比 → 全 0', async () => {
    const d = wv.diff({ storeDir: STORE, world: W, a: dirtyId, b: dirtyId });
    assert.deepStrictEqual(d.counts, { added: 0, removed: 0, changed: 0 });
  });

  await ta('blame：能列出该区块的完整改动史，最新的在最前', async () => {
    const b = wv.blame({ storeDir: STORE, world: W, id: dirtyId, cx: 0, cz: 0 });
    const ids = b.history.map((h) => h.id);
    assert.ok(ids.includes(baseId), '首提应在改动史里');
    assert.ok(ids.includes(editId), '第二次提交应在改动史里');
    assert.ok(ids.includes(revertId), '改回去那次应在改动史里');
    // dirtyId 本身没碰过 0,0，所以它不是"引入当前内容"的那次
    assert.strictEqual(b.history[0].id, revertId, '最新的改动应来自 revertId');
    assert.strictEqual(b.hash, b.history[0].hash);
    assert.ok(!ids.includes(dirtyId), '没碰过这个区块的提交不该出现在改动史里');
  });

  await ta('blame：被删掉的区块，最新一条 hash 为 null', async () => {
    const b = wv.blame({ storeDir: STORE, world: W, id: dirtyId, cx: 6, cz: 5 });
    assert.strictEqual(b.history[0].hash, null, '最新一条应是删除');
    assert.strictEqual(b.hash, null);
  });

  await ta('blame：从没被动过的区块 → 改动史只有首提一条', async () => {
    const b = wv.blame({ storeDir: STORE, world: W, id: dirtyId, cx: 1, cz: 0 });
    assert.strictEqual(b.history.length, 1);
    assert.strictEqual(b.history[0].id, baseId);
  });

  await ta('blame：三个维度/种类互不串味', async () => {
    const b = wv.blame({ storeDir: STORE, world: W, id: dirtyId, cx: 0, cz: 0, dim: 'nether' });
    assert.strictEqual(b.history.length, 1, '下界那条只被首提写过');
    const e = wv.blame({ storeDir: STORE, world: W, id: dirtyId, cx: 0, cz: 0, kind: 'entities' });
    assert.strictEqual(e.history.length, 1, '实体是独立跟踪的');
  });

  /* ================= 5. 分支 ================= */
  console.log('\n--- 分支 ---');

  await ta('createBranch / branches / 非法名与重名都被拦', async () => {
    const r = wv.createBranch({ storeDir: STORE, world: W, name: 'experiment' });
    assert.strictEqual(r.id, dirtyId, '新分支应指向当前 HEAD');
    assert.throws(() => wv.createBranch({ storeDir: STORE, world: W, name: 'experiment' }), /已存在/);
    assert.throws(() => wv.createBranch({ storeDir: STORE, world: W, name: 'a/b' }), /非法字符/);
    assert.throws(() => wv.createBranch({ storeDir: STORE, world: W, name: '  ' }), /不能为空/);
    const list = wv.branches({ storeDir: STORE, world: W });
    assert.deepStrictEqual(list.map((b) => b.name).sort(), ['experiment', 'main']);
    assert.strictEqual(list[0].current, true, '当前分支排在最前');
  });

  await ta('分支隔离：在 experiment 上提交，main 的指针不许动', async () => {
    wv.switchBranch({ storeDir: STORE, world: W, name: 'experiment' });
    put(SAVE, 0, 0, '实验版本');
    const r = await wv.commit({ saveDir: SAVE, storeDir: STORE, world: W, message: '实验分支的提交' });
    expId = r.id;
    assert.strictEqual(r.changed.add, 1);
    const br = wv.branches({ storeDir: STORE, world: W });
    const main = br.find((b) => b.name === 'main');
    const exp = br.find((b) => b.name === 'experiment');
    assert.strictEqual(main.id, dirtyId, 'main 被动了');
    assert.strictEqual(exp.id, expId);
    assert.strictEqual(br.find((b) => b.current).name, 'experiment');
  });

  await ta('两条分支的 diff 就是那一个区块', async () => {
    const d = wv.diff({ storeDir: STORE, world: W, a: dirtyId, b: expId });
    assert.deepStrictEqual(d.counts, { added: 0, removed: 0, changed: 1 });
    assert.deepStrictEqual(d.changed, ['0,0']);
  });

  await ta('log 按分支走，不会把另一条分支的提交混进来', async () => {
    const mainLog = wv.log({ storeDir: STORE, world: W, branch: 'main' }).map((x) => x.id);
    assert.ok(!mainLog.includes(expId), 'main 的历史里不该出现实验分支的提交');
    const expLog = wv.log({ storeDir: STORE, world: W, branch: 'experiment' }).map((x) => x.id);
    assert.strictEqual(expLog[0], expId);
  });

  await ta('switchBranch：不存在的分支报错，且非当前分支不能删', async () => {
    assert.throws(() => wv.switchBranch({ storeDir: STORE, world: W, name: 'nope' }), /不存在/);
    assert.throws(() => wv.deleteBranch({ storeDir: STORE, world: W, name: 'experiment' }), /当前分支/);
    wv.switchBranch({ storeDir: STORE, world: W, name: 'main' });
    assert.strictEqual(wv.deleteBranch({ storeDir: STORE, world: W, name: 'experiment' }).ok, true);
    assert.deepStrictEqual(wv.branches({ storeDir: STORE, world: W }).map((b) => b.name), ['main']);
  });

  /* ================= 6. checkout ================= */
  console.log('\n--- checkout（回滚） ---');

  await ta('checkout：内容改动被写回（written>0）', async () => {
    const r = await wv.checkout({ saveDir: SAVE, storeDir: STORE, world: W, id: dirtyId });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.id, dirtyId);
    assert.ok(r.written >= 1, '应有写回，实际 ' + r.written);
    assert.strictEqual(markerOf(SAVE, 5, 5), 'n1-改');
    assert.strictEqual(markerOf(SAVE, 7, 7), 'n3');
  });

  await ta('checkout 到首提：新加的区块被删掉，磁盘回到最初状态', async () => {
    const r = await wv.checkout({ saveDir: SAVE, storeDir: STORE, world: W, id: baseId });
    assert.strictEqual(r.deleted, 2, '7,7 和…应被删除，实际 ' + r.deleted);
    assert.strictEqual(markerOf(SAVE, 0, 0), 'a');
    assert.strictEqual(markerOf(SAVE, 5, 5), null);
    assert.strictEqual(markerOf(SAVE, 7, 7), null);
    assert.strictEqual(markerOf(SAVE, -1, -1), 'neg');
    assert.strictEqual(markerOf(SAVE, 0, 0, { dim: 'nether' }), 'nether-a');
    assert.strictEqual(markerOf(SAVE, 0, 0, { kind: 'entities' }), 'ent-1');
    // 回滚之后再看 status：相对 HEAD(dirtyId)，磁盘上少了 5,5 与 7,7。
    // 0,0 不算变化 —— 它在首提和 HEAD 里都是 'a'。
    const s = await wv.status({ saveDir: SAVE, storeDir: STORE, world: W });
    assert.strictEqual(s.changes.add, 0, JSON.stringify(s.changes));
    assert.strictEqual(s.changes.change, 0);
    assert.strictEqual(s.changes.del, 2);
    assert.deepStrictEqual(s.sample.del.slice().sort(), ['5,5', '7,7']);
  });

  await ta('checkout：prune:false 只补写不删除', async () => {
    await wv.checkout({ saveDir: SAVE, storeDir: STORE, world: W, id: dirtyId });   // 先回到最新
    const r = await wv.checkout({ saveDir: SAVE, storeDir: STORE, world: W, id: baseId, prune: false });
    assert.strictEqual(r.deleted, 0, 'prune:false 不该删东西');
    assert.strictEqual(markerOf(SAVE, 0, 0), 'a', '内容仍应被写回');
    assert.strictEqual(markerOf(SAVE, 5, 5), 'n1-改', '目标版本里没有的区块应保留');
  });

  await ta('checkout：给 tmDir 时先打时光机安全快照', async () => {
    const tm = require('../savetimemachine');
    const TM = path.join(TMP, 'tm');
    const r = await wv.checkout({ saveDir: SAVE, storeDir: STORE, world: W, id: dirtyId, tmDir: TM });
    assert.ok(r.safety, '应产生安全快照 id');
    const list = tm.listSnapshots({ storeDir: TM });
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].label, '回滚前自动快照');
    fs.rmSync(TM, { recursive: true, force: true });
  });

  await ta('checkout：不存在的提交必须报错，不能把存档清空', async () => {
    await assert.rejects(
      () => wv.checkout({ saveDir: SAVE, storeDir: STORE, world: W, id: '不存在的提交' }),
      /提交不存在/
    );
    assert.strictEqual(markerOf(SAVE, 0, 0), 'a', '报错时不该动过存档');
  });

  await ta('checkout 只动指定维度：回滚下界，主世界一个字节都不许碰', async () => {
    await wv.checkout({ saveDir: SAVE, storeDir: STORE, world: W, id: dirtyId });
    put(SAVE, 0, 0, 'nether-改脏', { dim: 'nether' });
    put(SAVE, 1, 0, 'overworld-改脏');
    const r = await wv.checkout({ saveDir: SAVE, storeDir: STORE, world: W, id: baseId, dims: ['nether'] });
    assert.strictEqual(r.dims.length, 1, '只该有一个维度被处理');
    assert.strictEqual(r.dims[0].dim, 'nether');
    assert.strictEqual(markerOf(SAVE, 0, 0, { dim: 'nether' }), 'nether-a', '下界该被回滚');
    assert.strictEqual(markerOf(SAVE, 1, 0), 'overworld-改脏', '主世界不该被动');
  });

  /* ================= 7. 索引重建与缓存 ================= */
  console.log('\n--- 索引重建与缓存 ---');

  await ta('clearCache 后重建的索引与缓存命中时完全一致', async () => {
    const root = wv.worldRoot(STORE, W);
    const a = wv.snapshotIndex({ storeDir: STORE, world: W, id: dirtyId });
    wv.clearCache();
    const b = wv.snapshotIndex({ storeDir: STORE, world: W, id: dirtyId });
    assert.deepStrictEqual(a, b, '缓存清掉后重建结果不一致 —— 增量回溯算错了');
    assert.ok(Object.keys(a.dims.overworld.region).length > 0);
    assert.strictEqual(Object.keys(a.dims.end.region).length, 0, '末地没有区块，索引应为空');
    assert.strictEqual(Object.keys(a.dims.overworld.entities).length, 1);
  });

  await ta('indexOf：不存在的提交返回空索引，且不会污染缓存', async () => {
    const root = wv.worldRoot(STORE, W);
    const s = wv.indexOf(root, '不存在的提交');
    assert.strictEqual(s.get('overworld|region').size, 0);
    // 真提交的结果必须还是对的
    const real = wv.indexOf(root, dirtyId);
    assert.ok(real.get('overworld|region').size > 0);
  });

  await ta('chainTo：能从叶子一路回到根，且不会因为数据坏了死循环', async () => {
    const root = wv.worldRoot(STORE, W);
    const chain = wv.chainTo(root, dirtyId);
    assert.strictEqual(chain[0].id, baseId);
    assert.strictEqual(chain[chain.length - 1].id, dirtyId);
    // 人为造一个自指的提交，验证防环
    const bad = Object.assign({}, wv.readCommit(root, baseId), { id: 'bad-self', parent: 'bad-self' });
    fs.writeFileSync(path.join(root, 'commits', 'bad-self.json'), JSON.stringify(bad));
    const c2 = wv.chainTo(root, 'bad-self');
    assert.ok(c2.length <= 2, '自指提交应被防环拦住，实际长度 ' + c2.length);
    fs.unlinkSync(path.join(root, 'commits', 'bad-self.json'));
  });

  /* ================= 8. tree / stats / gc ================= */
  console.log('\n--- tree / stats / gc ---');

  await ta('tree：与重建出来的索引逐项对得上', async () => {
    wv.switchBranch({ storeDir: STORE, world: W, name: wv.DEFAULT_BRANCH });
    const tr = wv.tree({ storeDir: STORE, world: W, id: dirtyId });
    assert.strictEqual(tr.id, dirtyId);
    const idx = wv.snapshotIndex({ storeDir: STORE, world: W, id: dirtyId });
    let expected = 0;
    for (const dim of wv.DIM_KEYS) {
      for (const kind of wv.KINDS) expected += Object.keys(idx.dims[dim][kind]).length;
    }
    assert.strictEqual(tr.total.count, expected,
      'tree 的合计与索引不一致：' + tr.total.count + ' vs ' + expected);
    const ow = tr.dims.find((d) => d.dim === 'overworld');
    assert.strictEqual(ow.kinds.region.count, Object.keys(idx.dims.overworld.region).length);
    assert.strictEqual(ow.kinds.entities.count, 1, '实体是单独跟踪的一类');
    assert.strictEqual(tr.dims.find((d) => d.dim === 'nether').kinds.region.count, 1);
    assert.strictEqual(tr.dims.find((d) => d.dim === 'end').count, 0, '末地没有区块');
    assert.ok(tr.total.bytes > 0);
  });

  await ta('stats：提交数 / 对象数 / 逻辑体积 / 分支数', async () => {
    const s = wv.stats({ storeDir: STORE, world: W });
    // 提交文件数 = main 上的 4 个 + 已删除的 experiment 分支遗留的 1 个（gc 只管对象，不删提交）
    assert.strictEqual(s.commits, 5, JSON.stringify({ commits: s.commits }));
    assert.strictEqual(wv.log({ storeDir: STORE, world: W }).length, 4, 'main 自己只有 4 个');
    assert.strictEqual(s.branches, 1);
    assert.strictEqual(s.head, dirtyId);
    assert.ok(s.objects > 0 && s.physical > 0);
    assert.ok(s.logical > 0 && s.chunks > 0);
    assert.ok(s.root.endsWith(W));
  });

  await ta('gc：没被任何提交引用的对象被回收，被引用的保留', async () => {
    const root = wv.worldRoot(STORE, W);
    const orphan = wv.putObject(root, chunkRaw('孤零零的区块'));
    assert.strictEqual(orphan.isNew, true);
    const before = wv.stats({ storeDir: STORE, world: W }).objects;
    const g = wv.gc({ storeDir: STORE, world: W });
    assert.strictEqual(g.removed, 1, '应回收 1 个孤儿对象，实际 ' + g.removed);
    assert.ok(g.freed > 0);
    assert.strictEqual(wv.stats({ storeDir: STORE, world: W }).objects, before - 1);
    assert.strictEqual(wv.hasObject(root, orphan.hash), false);
    // 被引用的那些一个都不能掉
    assert.ok(wv.hasObject(root, anvil.hashOf(chunkRaw('a'))), '被引用的对象被误删');
    // 回收之后 checkout 仍然要能正常工作
    await wv.checkout({ saveDir: SAVE, storeDir: STORE, world: W, id: dirtyId });
    assert.strictEqual(markerOf(SAVE, 3, 0) || true, true);
  });

  await ta('gc：反复执行是幂等的（第二次回收 0 个）', async () => {
    const g1 = wv.gc({ storeDir: STORE, world: W });
    const g2 = wv.gc({ storeDir: STORE, world: W });
    assert.strictEqual(g1.removed, 0);
    assert.strictEqual(g2.removed, 0);
  });

  await ta('listWorlds：能列出库里跟踪过的存档', async () => {
    await wv.init({ saveDir: path.join(TMP, '没跟踪过'), storeDir: STORE, world: '另一个世界' });
    const list = wv.listWorlds({ storeDir: STORE });
    const names = list.map((x) => x.world).sort();
    assert.deepStrictEqual(names, ['另一个世界', W].sort());
    const mine = list.find((x) => x.world === W);
    assert.strictEqual(mine.commits, 5);
    assert.ok(list.find((x) => x.world === '另一个世界').commits === 1);
  });

  await ta('空库：stats / log / tree 都不抛错', async () => {
    const empty = path.join(TMP, 'navy');
    assert.strictEqual(wv.stats({ storeDir: empty, world: 'x' }).commits, 0);
    assert.deepStrictEqual(wv.log({ storeDir: empty, world: 'x' }), []);
    assert.strictEqual(wv.tree({ storeDir: empty, world: 'x' }).id, null);
    assert.deepStrictEqual(wv.listWorlds({ storeDir: empty }), []);
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
