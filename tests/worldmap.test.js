// worldmap 单测（纯合成存档，不依赖真实 .minecraft）
// 覆盖：位打包解码、调色板、纯函数 analyzeChunk、以及 scan 端到端（写真 region 文件）
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const anvil = require('../anvil');
const nbt = require('../nbt');
const wm = require('../worldmap');

let pass = 0, fail = 0, name = '';
function t(n, fn) { name = n; try { fn(); console.log('  ok   ' + n); pass++; } catch (e) { console.log(' FAIL  ' + n + ' -> ' + e.message); fail++; } }
function eq(n, a, b) { t(n, () => assert.strictEqual(a, b)); }

/** 造一个全 grass_block 的区块（palette=[air,grass]，data 全填 0x111… → 每 4 位=1=grass） */
function grassChunkBuf() {
  const data = [];
  for (let i = 0; i < 256; i++) data.push(0x1111111111111111n); // 16 个 nibble 全 1 → 每个索引=1
  const body = {
    DataVersion: 3465,
    Level: {
      xPos: 0, zPos: 0, Status: 'full',
      Sections: [{ Y: 0, block_states: { palette: [{ Name: 'minecraft:air' }, { Name: 'minecraft:grass_block' }], data } }]
    }
  };
  return nbt.serialize('', body);
}
function emptyChunkBuf() {
  const body = { DataVersion: 3465, Level: { xPos: 3, zPos: 4, Status: 'full' } };
  return nbt.serialize('', body);
}

/* ---------- 位打包解码 ---------- */
t('packedIndex：单 long 内取位', () => {
  const data = [0xABCDn]; // 1010 1011 1100 1101
  assert.strictEqual(wm.packedIndex(data, 0, 4), 0xD); // 低 4 位 = 1101 = 13
  assert.strictEqual(wm.packedIndex(data, 1, 4), 0xC); // 1100 = 12
  assert.strictEqual(wm.packedIndex(data, 3, 4), 0xA); // 1010 = 10
});
t('packedIndex：跨 long 边界', () => {
  // 元素 idx=12、bits=5 占据位 [60,65)：long0 的顶 4 位（60..63）+ long1 的最低 1 位（64）。
  // long0=0xF000000000000000（顶 4 位=1111），long1=0x0000000000000001（最低位=1）。
  // 拼出来应是 11111 = 31。
  const data = [0xF000000000000000n, 0x0000000000000001n];
  assert.strictEqual(wm.packedIndex(data, 12, 5), 0x1F, '跨边界应拼出 11111=31');
});
t('packedIndex：数组不足不崩', () => {
  assert.strictEqual(wm.packedIndex([], 0, 4), 0);
  assert.strictEqual(wm.packedIndex([1n], 100, 4), 0);
});

/* ---------- 纯函数 ---------- */
t('blockColor：水/草/石 各自有稳定色', () => {
  assert.deepStrictEqual(wm.blockColor('minecraft:water'), [38, 92, 170]);
  assert.strictEqual(wm.blockColor('minecraft:grass_block')[1] > 100, true);
  assert.strictEqual(Array.isArray(wm.blockColor('minecraft:stone')), true);
});
t('heightColor：低→高 渐变（高亮于低）', () => {
  const lo = wm.heightColor(10), hi = wm.heightColor(200);
  assert.strictEqual(hi[2] > lo[2], true, '高处蓝分量应更高');
});
t('biomeColor：同一 id 稳定，不同 id 不同', () => {
  assert.deepStrictEqual(wm.biomeColor(1), wm.biomeColor(1));
  assert.notDeepStrictEqual(wm.biomeColor(1), wm.biomeColor(50));
});
t('topBlock：全空气区块返回 null', () => {
  const root = nbt.parse(emptyChunkBuf()).value;
  assert.strictEqual(wm.analyzeChunk(root).topName, null);
});
t('topBlock：全 grass_block 区块返回 grass_block + 合理高度', () => {
  const root = nbt.parse(grassChunkBuf()).value;
  const a = wm.analyzeChunk(root);
  assert.strictEqual(a.topName, 'minecraft:grass_block');
  assert.strictEqual(a.topY, 15, '唯一 section Y=0，顶层 yLocal=15');
});
t('analyzeChunk：垃圾输入不崩', () => {
  assert.deepStrictEqual(wm.analyzeChunk(null), { topName: null, topY: null, biome: null });
  assert.deepStrictEqual(wm.analyzeChunk(42), { topName: null, topY: null, biome: null });
});

/* ---------- scan 端到端 ---------- */
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-test-'));
  const saveDir = path.join(dir, 'World1');
  fs.mkdirSync(path.join(saveDir, 'region'), { recursive: true });
  // 写 (0,0) 全 grass_block
  anvil.writeSaveChunk({ saveDir, dim: 'overworld', cx: 0, cz: 0, raw: grassChunkBuf(), backup: false });
  // 写 (3,4) 全空气（空区块）
  anvil.writeSaveChunk({ saveDir, dim: 'overworld', cx: 3, cz: 4, raw: emptyChunkBuf(), backup: false });

  const r = await wm.scan({ saveDir, layer: 'blocks' });
  eq('scan：扫描到 2 个区块', r.cells.length, 2);
  const g = r.cells.find((c) => c.cx === 0 && c.cz === 0);
  const e = r.cells.find((c) => c.cx === 3 && c.cz === 4);
  t('scan：(0,0) 顶层草方块、绿色', () => {
    assert.strictEqual(g.topName, 'minecraft:grass_block');
    assert.deepStrictEqual(g.cBlocks, [86, 148, 64]);
  });
  t('scan：(3,4) 空区块落为深色占位', () => {
    assert.strictEqual(e.topName, null);
    assert.deepStrictEqual(e.cBlocks, [20, 22, 28]);
  });
  t('scan：bounds 正确', () => {
    assert.deepStrictEqual(r.bounds, { minCx: 0, minCz: 0, maxCx: 3, maxCz: 4 });
  });
  t('regionOverview：列出已写 region', () => {
    const ov = wm.regionOverview({ saveDir });
    assert.strictEqual(ov.length, 1);
    assert.strictEqual(ov[0].rx, 0); assert.strictEqual(ov[0].rz, 0);
  });

  // 实体热点：再造一个有 100 实体的区块
  const hotBody = { DataVersion: 3465, Level: { xPos: 1, zPos: 1, Status: 'full', Entities: Array.from({ length: 100 }, () => ({ id: 'minecraft:pig' })) } };
  anvil.writeSaveChunk({ saveDir, dim: 'overworld', cx: 1, cz: 1, raw: nbt.serialize('', hotBody), backup: false });
  const r2 = await wm.scan({ saveDir, entityThreshold: 80 });
  t('scan：实体数≥阈值的区块进热点', () => {
    const h = r2.entityHotspots.find((x) => x.cx === 1 && x.cz === 1);
    assert.ok(h, '应有热点');
    assert.strictEqual(h.count, 100);
    assert.strictEqual(r2.entityMax, 100);
  });

  console.log('\nworldmap: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
