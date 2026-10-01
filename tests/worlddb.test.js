// worlddb 单测（纯合成存档，不依赖真实 .minecraft）
// 覆盖：物品中文名 / 附魔判定 / 命名解析 / indexChunk / scanSave / search / stats
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const anvil = require('../anvil');
const nbt = require('../nbt');
const wdb = require('../worlddb');

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); console.log('  ok   ' + n); pass++; } catch (e) { console.log(' FAIL  ' + n + ' -> ' + e.message); fail++; } }

/* ---------- 纯函数 ---------- */
t('itemZh：映射命中 + 回退', () => {
  assert.strictEqual(wdb.itemZh('minecraft:diamond_sword'), '钻石剑');
  assert.strictEqual(wdb.itemZh('minecraft:unknown_thing'), 'unknown thing');
});
t('isEnchanted：Enchantments 命中', () => {
  assert.strictEqual(wdb.isEnchanted({ Enchantments: [{ id: 'sharpness' }] }), true);
  assert.strictEqual(wdb.isEnchanted({}), false);
  assert.strictEqual(wdb.isEnchanted(null), false);
});
t('customName：JSON 字符串 / 纯字符串 / 组件', () => {
  assert.strictEqual(wdb.customName('{"text":"阿强"}'), '阿强');
  assert.strictEqual(wdb.customName('直接名字'), '直接名字');
  assert.strictEqual(wdb.customName({ text: '组件名' }), '组件名');
  assert.strictEqual(wdb.customName(null), null);
});

/* ---------- indexChunk 纯函数 ---------- */
function chunkRoot() {
  return {
    Level: {
      xPos: 0, zPos: 0,
      BlockEntities: [{
        id: 'minecraft:chest', x: 5, y: 64, z: 9,
        Items: [
          { id: 'minecraft:diamond_sword', Count: 1, tag: { Enchantments: [{ id: 'minecraft:sharpness', lvl: 5 }] } },
          { id: 'minecraft:iron_ingot', Count: 3 }
        ]
      }],
      Entities: [
        { id: 'minecraft:villager', CustomName: '{"text":"村民阿强"}', Pos: [10, 65, 12] },
        { id: 'minecraft:pig' } // 无名字 → 不计入命名实体
      ]
    }
  };
}
t('indexChunk：抽容器与物品', () => {
  const r = wdb.indexChunk(chunkRoot(), { cx: 0, cz: 0 });
  assert.strictEqual(r.containers.length, 1);
  const c = r.containers[0];
  assert.strictEqual(c.type, 'chest');
  assert.strictEqual(c.x, 5); assert.strictEqual(c.items.length, 2);
  assert.strictEqual(c.items[0].enchanted, true);
  assert.strictEqual(c.items[0].zh, '钻石剑');
  assert.strictEqual(c.items[1].count, 3);
});
t('indexChunk：抽命名实体（无名字的猪不算）', () => {
  const r = wdb.indexChunk(chunkRoot(), { cx: 0, cz: 0 });
  assert.strictEqual(r.entities.length, 1);
  assert.strictEqual(r.entities[0].name, '村民阿强');
  assert.strictEqual(r.entities[0].x, 10);
});
t('indexChunk：非容器 BlockEntity 被忽略', () => {
  const root = { Level: { BlockEntities: [{ id: 'minecraft:sign', x: 1, y: 2, z: 3 }] } };
  assert.strictEqual(wdb.indexChunk(root, { cx: 0, cz: 0 }).containers.length, 0);
});

/* ---------- scanSave 端到端 ---------- */
function chunkBuf() {
  const body = {
    DataVersion: 3465,
    Level: {
      xPos: 0, zPos: 0, Status: 'full',
      Sections: [{ Y: 0, block_states: { palette: [{ Name: 'minecraft:air' }], data: [] } }],
      BlockEntities: [{
        id: 'minecraft:chest', x: 5, y: 64, z: 9,
        Items: [
          { id: 'minecraft:diamond_sword', Count: 1, tag: { Enchantments: [{ id: 'minecraft:sharpness', lvl: 5 }] } },
          { id: 'minecraft:iron_ingot', Count: 3 }
        ]
      }],
      Entities: [{ id: 'minecraft:villager', CustomName: '{"text":"村民阿强"}', Pos: [10, 65, 12] }]
    }
  };
  return nbt.serialize('', body);
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdb-test-'));
  const gameDir = path.join(dir, 'mc');
  const saveDir = path.join(gameDir, 'saves', 'World1');
  fs.mkdirSync(path.join(saveDir, 'region'), { recursive: true });
  anvil.writeSaveChunk({ saveDir, dim: 'overworld', cx: 0, cz: 0, raw: chunkBuf(), backup: false });

  const sv = await wdb.scanSave({ saveDir });
  t('scanSave：索引到 1 个容器 + 1 个命名实体', () => {
    assert.strictEqual(sv.name, 'World1');
    assert.strictEqual(sv.containers.length, 1);
    assert.strictEqual(sv.entities.length, 1);
  });

  t('search：按「附魔」只回带附魔的物品', () => {
    const r = wdb.search([sv], '附魔');
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].kind, 'container');
    assert.strictEqual(r[0].items.length, 1);
    assert.strictEqual(r[0].items[0].id, 'minecraft:diamond_sword');
  });
  t('search：按「钻石剑」命中 zh 名', () => {
    const r = wdb.search([sv], '钻石剑');
    assert.strictEqual(r.length, 1);
  });
  t('search：按「铁」命中 iron_ingot', () => {
    const r = wdb.search([sv], '铁');
    assert.strictEqual(r.length, 1);
  });
  t('search：命名实体按名字命中', () => {
    const r = wdb.search([sv], '阿强');
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].kind, 'entity');
  });
  t('search：空查询返回空', () => {
    assert.strictEqual(wdb.search([sv], '   ').length, 0);
  });

  t('stats：聚合正确', () => {
    const s = wdb.stats([sv]);
    assert.strictEqual(s.saves, 1);
    assert.strictEqual(s.totalContainers, 1);
    assert.strictEqual(s.totalNamedEntities, 1);
    const iron = s.topItems.find((x) => x.zh === '铁锭');
    assert.ok(iron, '热门物品应包含铁锭');
    assert.strictEqual(iron.count, 3);
  });

  t('scanGameDir：扫到 saves 下所有存档', async () => {
    const list = await wdb.scanGameDir({ gameDir });
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].containers.length, 1);
  });

  console.log('\nworlddb: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
