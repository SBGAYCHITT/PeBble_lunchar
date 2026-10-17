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

  /* ================= V5 第二组：深度 =================
   * 这一组补的是"索引到底看没看见东西"：
   *   · 1.18 起方块实体挪成了顶层 block_entities —— 只认 Level.BlockEntities 的话，
   *     所有新存档都索引不到容器，而且是**静默**的（"这个存档没有箱子"）。
   *   · 1.20.5 起物品从 {id,Count,tag} 变成 {id,count,components} —— 同理。
   *   · 三个维度、玩家背包/末影箱、带物品栏的实体，原来一个都没扫。
   *   · 每次全量重扫要解压几万个区块，落盘索引能把这件事变成"只读变过的文件"。
   */

  console.log('\n--- V5：容器识别与两种物品格式 ---');

  t('容器识别：染色潜影盒靠规则命中（17 个 id 不可能靠白名单列全）', () => {
    assert.strictEqual(wdb.isContainerId('minecraft:shulker_box'), true);
    assert.strictEqual(wdb.isContainerId('minecraft:red_shulker_box'), true);
    assert.strictEqual(wdb.isContainerId('minecraft:light_blue_shulker_box'), true);
    assert.strictEqual(wdb.isContainerId('minecraft:crafter'), true);
    assert.strictEqual(wdb.isContainerId('minecraft:chiseled_bookshelf'), true);
    assert.strictEqual(wdb.isContainerId('minecraft:stone'), false);
    assert.strictEqual(wdb.isContainerId('minecraft:sign'), false);
    // 原来表里那条拼错的规则：游戏里根本没有 smokestack 这个方块，
    // 留着它只会让人以为烟熏炉是靠它命中的
    assert.strictEqual(wdb.isContainerId('minecraft:smokestack'), false);
  });

  /** 1.18+ 形态的区块：方块实体在顶层 block_entities */
  function chunk18(bes, ents) {
    return nbt.serialize('', {
      DataVersion: 3465, xPos: 0, zPos: 0, Status: 'full',
      block_entities: bes || [], Entities: ents || []
    });
  }

  t('indexChunk：1.18+ 的顶层 block_entities（老代码只认 Level.BlockEntities）', () => {
    const raw = chunk18([{ id: 'minecraft:barrel', x: 1, y: 2, z: 3, Items: [{ id: 'minecraft:stone', Count: 5 }] }]);
    const r = wdb.indexChunk(nbt.parse(raw).value, { cx: 4, cz: -5, dim: 'overworld' });
    assert.strictEqual(r.containers.length, 1, '顶层 block_entities 必须认，否则新存档一个容器都索引不到');
    assert.strictEqual(r.containers[0].type, 'barrel');
    assert.strictEqual(r.containers[0].items[0].count, 5);
    assert.strictEqual(r.containers[0].dim, 'overworld', '维度要带上，不然按维度筛就没法做');
    assert.strictEqual(r.containers[0].cx, 4);
  });

  t('物品：1.20.5+ 的 {id, count, components} 写法', () => {
    const raw = chunk18([{
      id: 'minecraft:chest', x: 0, y: 0, z: 0,
      Items: [
        {
          id: 'minecraft:diamond_sword', count: 1,
          components: {
            'minecraft:custom_name': '{"text":"斩龙剑"}',
            'minecraft:enchantments': { levels: { 'minecraft:sharpness': 5, 'minecraft:mending': 1 } }
          }
        },
        { id: 'minecraft:iron_ingot', count: 12 },
        { id: { id: 'minecraft:emerald', count: 7 } }          // 堆叠形态
      ]
    }]);
    const items = wdb.indexChunk(nbt.parse(raw).value, { cx: 0, cz: 0 }).containers[0].items;
    assert.strictEqual(items.length, 3, '新写法一条都不能漏');
    assert.strictEqual(items[0].zh, '钻石剑');
    assert.strictEqual(items[0].count, 1);
    assert.strictEqual(items[0].name, '斩龙剑', '物品自定义名在 components 里');
    assert.strictEqual(items[0].enchanted, true);
    assert.deepStrictEqual(items[0].ench, ['sharpness', 'mending']);
    assert.strictEqual(items[1].count, 12);
    assert.strictEqual(items[2].zh, '绿宝石');
    assert.strictEqual(items[2].count, 7, 'id 写成 {id,count} 的堆叠形态也要认');
  });

  t('物品：潜影盒嵌套（老 BlockEntityTag 与新 container 组件两种）', () => {
    const oldWay = {
      id: 'minecraft:shulker_box', Count: 1,
      tag: { BlockEntityTag: { Items: [{ id: 'minecraft:diamond', Count: 64 }] } }
    };
    const newWay = {
      id: 'minecraft:shulker_box', count: 1,
      components: { 'minecraft:container': [{ slot: 0, item: { id: 'minecraft:emerald', count: 3 } }] }
    };
    const a = wdb.readItems([oldWay], 0);
    assert.strictEqual(a[0].nested[0].zh, '钻石');
    assert.strictEqual(a[0].nested[0].count, 64);
    const b = wdb.readItems([newWay], 0);
    assert.strictEqual(b[0].nested[0].zh, '绿宝石');

    // 深度限制：套两层就停。给了构造深层嵌套数据打爆内存的机会就不好了。
    const deep = { id: 'minecraft:shulker_box', Count: 1, tag: { BlockEntityTag: { Items: [oldWay] } } };
    const d = wdb.readItems([deep], 0);
    assert.ok(d[0].nested, '第一层');
    assert.ok(d[0].nested[0].nested, '第二层');
    assert.strictEqual(d[0].nested[0].nested[0].nested, undefined, '第三层就不再展开了');
    // 统计必须把嵌套算进去，否则"我到底有多少钻石"会少算
    assert.strictEqual(wdb.countItems(d).total, 1 + 1 + 64);
  });

  t('indexChunk：带物品栏的实体（矿车/船）也算容器', () => {
    const raw = chunk18([], [{
      id: 'minecraft:chest_minecart', Pos: [10.5, 64, -20.5],
      Items: [{ id: 'minecraft:gold_ingot', Count: 9 }]
    }]);
    const r = wdb.indexChunk(nbt.parse(raw).value, { cx: 0, cz: -2, dim: 'overworld' });
    assert.strictEqual(r.containers.length, 1, '矿车里的东西也是"我的东西"');
    assert.strictEqual(r.containers[0].kind, 'entity-container');
    assert.strictEqual(r.containers[0].items[0].zh, '金锭');
    assert.strictEqual(r.containers[0].x, 10.5);
    assert.strictEqual(r.containers[0].dim, 'overworld');
  });

  /* ---------- 多维度 / 玩家背包 / 落盘索引 ---------- */
  console.log('\n--- V5：多维度 + 玩家背包 + 落盘增量索引 ---');

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wdb-v5-'));
  const gd2 = path.join(dir2, 'mc');
  const S2 = path.join(gd2, 'saves', '生存世界');
  const CACHE = path.join(dir2, 'cache');
  fs.mkdirSync(path.join(S2, 'region'), { recursive: true });

  // level.dat：玩家站在 (100.5,64,-200.5)，背包里有一把附魔钻石剑（自定义名"斩龙剑"），
  // 末影箱里有一颗下界之星。
  fs.writeFileSync(path.join(S2, 'level.dat'), nbt.serialize('', {
    Data: {
      DataVersion: 3465, LevelName: '生存世界', Time: 24000 * 5,
      LastPlayed: 1700000000000, SpawnX: 0, SpawnY: 64, SpawnZ: 0,
      Player: {
        Pos: [100.5, 64, -200.5], Dimension: 'minecraft:overworld',
        Inventory: [
          {
            id: 'minecraft:diamond_sword', Count: 1,
            tag: { Enchantments: [{ id: 'minecraft:sharpness', lvl: 5 }], display: { Name: '{"text":"斩龙剑"}' } }
          },
          { id: 'minecraft:cobblestone', Count: 64 }
        ],
        EnderItems: [{ id: 'minecraft:nether_star', Count: 1 }]
      }
    }
  }));

  // 主世界：箱子在 (180,64,-260) —— 离玩家约 99 格，正好用来区分 near:me 的 64/128 两条半径
  anvil.writeSaveChunk({
    saveDir: S2, dim: 'overworld', cx: 11, cz: -17, backup: false,
    raw: chunk18([{
      id: 'minecraft:chest', x: 180, y: 64, z: -260,
      Items: [{ id: 'minecraft:redstone', Count: 10 }, { id: 'minecraft:stone', Count: 1 }]
    }])
  });
  // 主世界的命名实体走 entities/ 文件（1.17+ 的真实布局，根上是 Position: [cx,cz]）
  anvil.writeSaveChunk({
    saveDir: S2, dim: 'overworld', kind: 'entities', cx: 11, cz: -17, backup: false,
    raw: nbt.serialize('', {
      DataVersion: 3465, Position: [11, -17],
      Entities: [{ id: 'minecraft:villager', CustomName: '{"text":"店主"}', Pos: [185, 64, -255] }]
    })
  });
  // 下界：木桶 + 一个命名僵尸
  anvil.writeSaveChunk({
    saveDir: S2, dim: 'nether', cx: 6, cz: 7, backup: false,
    raw: chunk18([{ id: 'minecraft:barrel', x: 100, y: 70, z: 120, Items: [{ id: 'minecraft:gold_ingot', Count: 9 }] }])
  });
  anvil.writeSaveChunk({
    saveDir: S2, dim: 'nether', kind: 'entities', cx: 6, cz: 7, backup: false,
    raw: nbt.serialize('', {
      DataVersion: 3465, Position: [6, 7],
      Entities: [{ id: 'minecraft:zombie', CustomName: '{"text":"看门的"}', Pos: [100, 70, 120] }]
    })
  });
  // 末地：末影珍珠
  anvil.writeSaveChunk({
    saveDir: S2, dim: 'end', cx: -1, cz: 0, backup: false,
    raw: chunk18([{ id: 'minecraft:chest', x: -8, y: 64, z: 8, Items: [{ id: 'minecraft:ender_pearl', Count: 3 }] }])
  });

  let sv2 = null;
  await (async () => {
    sv2 = await wdb.scanSave({ saveDir: S2, cacheDir: CACHE, gameDir: gd2 });
  })();

  t('scanSave：三个维度都扫，容器都带上正确的 dim', () => {
    const dims = new Set(sv2.containers.filter((c) => c.kind === 'container').map((c) => c.dim));
    assert.deepStrictEqual([...dims].sort(), ['end', 'nether', 'overworld'],
      '只扫主世界的话，下界与末地的箱子会凭空消失');
    assert.strictEqual(sv2.entities.length, 2, '主世界的店主 + 下界的看门的');
    assert.deepStrictEqual(sv2.dims, ['overworld', 'nether', 'end']);
  });

  t('scanSave：玩家背包与末影箱当成两个容器（"我的东西放哪了"最常问的一个）', () => {
    const player = sv2.containers.find((c) => c.kind === 'player');
    const ender = sv2.containers.find((c) => c.kind === 'ender_chest');
    assert.ok(player && ender, '玩家背包与末影箱都要有');
    assert.strictEqual(player.dim, 'overworld');
    assert.strictEqual(player.x, 100.5);
    assert.strictEqual(player.z, -200.5);
    assert.strictEqual(player.items.length, 2);
    const sword = player.items.find((it) => it.zh === '钻石剑');
    assert.ok(sword && sword.enchanted, '背包里的附魔钻石剑要能查到');
    assert.strictEqual(sword.name, '斩龙剑');
    assert.strictEqual(ender.items[0].zh, '下界之星');
    assert.strictEqual(sv2.player.pos[0], 100.5);
  });

  t('落盘索引：第一次全解析，第二次全部复用', async () => {
    assert.strictEqual(sv2.scan.incremental, true);
    assert.ok(sv2.scan.parsedFiles >= 5, '第一次应当真解析所有 region 文件，实际 ' + sv2.scan.parsedFiles);
    assert.strictEqual(sv2.scan.reusedFiles, 0);
    assert.ok(fs.existsSync(wdb.cachePath(CACHE, S2)), '缓存文件要落盘');
    const sv3 = await wdb.scanSave({ saveDir: S2, cacheDir: CACHE, gameDir: gd2 });
    assert.strictEqual(sv3.scan.cached, true);
    assert.strictEqual(sv3.scan.parsedFiles, 0, '没有任何文件变化就一个都不该重解析');
    assert.strictEqual(sv3.scan.reusedFiles, sv2.scan.files);
    assert.strictEqual(sv3.containers.length, sv2.containers.length, '复用出来的结果必须一模一样');
    assert.strictEqual(sv3.entities.length, sv2.entities.length);
  });

  t('落盘索引：只改一个 region 文件 → 只有它被重解析', async () => {
    // 连"同一毫秒里改的"这种情况也要认出来（指纹相同时靠 mtime >= 索引写入时刻兜底）
    anvil.writeSaveChunk({
      saveDir: S2, dim: 'nether', cx: 6, cz: 7, backup: false,
      raw: chunk18([
        { id: 'minecraft:barrel', x: 100, y: 70, z: 120, Items: [{ id: 'minecraft:gold_ingot', Count: 9 }] },
        { id: 'minecraft:chest', x: 104, y: 70, z: 124, Items: [{ id: 'minecraft:diamond', Count: 2 }] }
      ])
    });
    const sv4 = await wdb.scanSave({ saveDir: S2, cacheDir: CACHE, gameDir: gd2 });
    assert.strictEqual(sv4.scan.parsedFiles, 1, '只有下界那个文件变了，实际重解析 ' + sv4.scan.parsedFiles);
    assert.ok(sv4.scan.reusedFiles >= 4, '其余文件应当全部复用，实际 ' + sv4.scan.reusedFiles);
    assert.ok(sv4.containers.some((c) => c.type === 'chest' && c.dim === 'nether'), '新加的箱子要被索引到');
  });

  t('落盘索引：版本对不上就整份丢弃重扫（不做"尽力兼容"）', async () => {
    const p = wdb.cachePath(CACHE, S2);
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    j.version = wdb.INDEX_VERSION + 1;
    fs.writeFileSync(p, JSON.stringify(j));
    const sv5 = await wdb.scanSave({ saveDir: S2, cacheDir: CACHE });
    assert.strictEqual(sv5.scan.cached, false, '旧版本缓存不能被当成有效缓存');
    assert.ok(sv5.scan.parsedFiles >= 5, '版本不匹配时要整份重扫');
    assert.strictEqual(sv5.containers.length, sv2.containers.length + 1, '重扫出来的内容不能少');
  });

  t('dropIndex：删掉缓存文件后下一轮是全量重扫', async () => {
    assert.strictEqual(wdb.dropIndex(CACHE, S2), true);
    assert.ok(!fs.existsSync(wdb.cachePath(CACHE, S2)));
    const sv6 = await wdb.scanSave({ saveDir: S2, cacheDir: CACHE });
    assert.strictEqual(sv6.scan.cached, false);
    assert.ok(fs.existsSync(wdb.cachePath(CACHE, S2)), '重扫之后缓存要重新落地');
  });

  /* ---------- 检索 DSL ---------- */
  console.log('\n--- V5：检索 DSL ---');

  t('DSL：只给过滤器时列出该范围内的全部内容（"下界里都有些什么"）', () => {
    const r = wdb.search([sv2], 'dim:nether');
    assert.ok(r.length >= 2, '下界有木桶 + 新加的箱子 + 看门的，实际 ' + r.length);
    assert.ok(r.every((x) => x.dim === 'nether'), JSON.stringify(r.map((x) => x.dim)));
    // 中文别名
    const e = wdb.search([sv2], 'dim:末地');
    assert.strictEqual(e.length, 1);
    assert.strictEqual(e[0].items[0].zh, '末影珍珠');
  });

  t('DSL：kind 过滤 + 只取容器', () => {
    const all = wdb.search([sv2], { q: 'dim:nether' });
    const onlyC = wdb.search([sv2], { q: 'dim:nether', kind: 'container' });
    assert.ok(onlyC.length < all.length, '带 kind:container 之后应当排除掉实体');
    assert.ok(onlyC.every((x) => x.kind !== 'entity'));
  });

  t('DSL：save 限定存档', () => {
    assert.ok(wdb.search([sv2], 'save:生存').length > 0);
    assert.strictEqual(wdb.search([sv2], 'save:并不存在的世界').length, 0);
  });

  t('DSL：near:me 按**那个存档里玩家**的位置算距离（跨存档才有意义）', () => {
    // 玩家在 (100.5,64,-200.5)；玩家背包/末影箱就在身上 → 距离 0；
    // 主世界那个箱子在 (180,64,-260)，约 99 格。
    const near64 = wdb.search([sv2], 'near:me,64');
    assert.strictEqual(near64.length, 2, '64 格内只有身上的背包与末影箱，实际 ' + near64.length);
    assert.ok(near64.every((x) => x.dist === 0), JSON.stringify(near64.map((x) => x.dist)));

    const near128 = wdb.search([sv2], 'near:me,128');
    const box = near128.find((x) => x.type === 'chest' && x.dim === 'overworld');
    assert.ok(box, '128 格内应当能圈到那个箱子');
    assert.ok(box.dist > 90 && box.dist < 110, '距离算法不对: ' + box.dist);
  });

  t('DSL：near:x,y,z,r 按给定坐标算（同一存档内才有意义）', () => {
    // 箱子在 (180,64,-260) 本身 → 距离 0；店主在 (185,64,-255) → 约 7 格。
    // 半径 5 只圈得到箱子，半径 10 会把店主一起圈进来（实体也走同一套距离过滤）。
    const r = wdb.search([sv2], 'near:180,64,-260,5');
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].type, 'chest');
    assert.strictEqual(r[0].dist, 0);
    const r2 = wdb.search([sv2], 'near:180,64,-260,10');
    assert.strictEqual(r2.length, 2, '实体也要按距离过滤，不能只过滤容器');
    assert.ok(r2.some((x) => x.kind === 'entity' && x.dist > 0));
    // 半径太小就什么都圈不到 —— 不能悄悄把半径忽略掉
    assert.strictEqual(wdb.search([sv2], 'near:0,0,0,1').length, 0);
  });

  t('DSL：ench 命中附魔（中英文都认）', () => {
    assert.strictEqual(wdb.search([sv2], 'ench:sharpness').length, 1);
    const zh = wdb.search([sv2], 'ench:锋利');
    assert.strictEqual(zh.length, 1, '附魔中文名也要能查');
    assert.strictEqual(zh[0].items[0].name, '斩龙剑');
    assert.strictEqual(wdb.search([sv2], 'ench:mending').length, 0, '没有这个附魔就该查不到');
  });

  t('DSL：exact:stone 不再命中 redstone', () => {
    // 子串匹配下 stone 会命中 redstone —— 这正是 exact 存在的理由
    const loose = wdb.search([sv2], 'stone');
    assert.ok(loose.some((x) => x.items.some((i) => i.zh === '红石')), '松匹配应当命中红石');
    const exact = wdb.search([sv2], 'exact:stone');
    assert.ok(!exact.some((x) => x.items.some((i) => i.zh === '红石')), '精确匹配不该命中红石');
    assert.strictEqual(exact[0].items[0].zh, '石头');
    // 整串精确
    const allExact = wdb.search([sv2], 'exact 石头');
    assert.strictEqual(allExact[0].items[0].zh, '石头');
  });

  t('DSL：不认识的 key 当成普通词（minecraft:diamond_sword 也要能查）', () => {
    const r = wdb.search([sv2], 'minecraft:diamond_sword');
    assert.ok(r.length >= 1, '冒号在 mc id 里太常见，不能一见冒号就当成过滤器');
    assert.strictEqual(r[0].items[0].zh, '钻石剑');
    const q = wdb.parseQuery('minecraft:diamond_sword');
    assert.strictEqual(q.filters, 0);
    assert.deepStrictEqual(q.terms, ['minecraft:diamond_sword']);
  });

  t('DSL：sort:count + limit/page 分页', () => {
    const sorted = wdb.search([sv2], { q: 'dim:nether', sort: 'count', order: 'desc' });
    assert.ok(sorted.length >= 2);
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(sorted[i - 1].itemTotal >= sorted[i].itemTotal, '按物品总数降序');
    }
    const p1 = wdb.searchDetailed([sv2], { q: 'dim:nether', limit: 1, page: 1, sort: 'count' });
    assert.strictEqual(p1.total, sorted.length);
    assert.strictEqual(p1.pages, sorted.length);
    assert.strictEqual(p1.results.length, 1);
    const p2 = wdb.searchDetailed([sv2], { q: 'dim:nether', limit: 1, page: 2, sort: 'count' });
    assert.notStrictEqual(p2.results[0].type, p1.results[0].type, '翻页要真的换内容');
  });

  t('DSL：写错的地方给出可读错误，而不是静默返回空', () => {
    assert.ok(/维度/.test(wdb.parseQuery('dim:天界').error), wdb.parseQuery('dim:天界').error);
    assert.ok(/near/.test(wdb.parseQuery('near:abc').error));
    assert.ok(/半径/.test(wdb.parseQuery('near:me,-5').error));
    assert.ok(/sort/.test(wdb.parseQuery('sort:乱写').error));
    assert.ok(/kind/.test(wdb.parseQuery('kind:随便').error));
    assert.strictEqual(wdb.parseQuery('钻石剑').error, '', '正常查询不该有错');
    const d = wdb.searchDetailed([sv2], 'dim:天界');
    assert.ok(d.error, 'searchDetailed 要把错误带出来');
    assert.strictEqual(d.results.length, 0);
  });

  t('DSL：引号里带空格的词当成一个词', () => {
    const q = wdb.parseQuery('"斩龙 剑"');
    assert.deepStrictEqual(q.terms, ['斩龙 剑']);
    assert.strictEqual(q.filters, 0);
  });

  /* ---------- 统计扩展 ---------- */
  console.log('\n--- V5：统计 ---');

  t('stats：物品总数 / 附魔 / 维度分布 / 索引规模', async () => {
    // 前面几条用例往里加过东西（下界多了一个箱子），所以这里重新扫一遍再统计 ——
    // 拿一份过期的 sv2 去算，会得到"下界的箱子凭空少了"的假结论
    const sv9 = await wdb.scanSave({ saveDir: S2, cacheDir: CACHE });
    const s = wdb.stats([sv9]);
    assert.strictEqual(s.saves, 1);
    // 6 个容器：玩家背包、末影箱、主世界箱子、下界木桶 + 下界箱子、末地箱子
    assert.strictEqual(s.totalContainers, 6);
    assert.strictEqual(s.totalNamedEntities, 2);
    assert.strictEqual(s.totalItemStacks, 9, '实际 ' + s.totalItemStacks);
    assert.strictEqual(s.totalItems, 10 + 1 + 9 + 2 + 3 + 1 + 64 + 1, '含嵌套与堆叠的总数');
    assert.strictEqual(s.totalEnchantedItems, 1);
    assert.strictEqual(s.totalCustomNamedItems, 1);
    assert.strictEqual(s.topEnchants[0].zh, '锋利');
    assert.strictEqual(s.dims.overworld + s.dims.nether + s.dims.end, 6);
    assert.strictEqual(s.dims.nether, 2, '下界有两个容器');
    assert.strictEqual(s.indexedChunks, 5, '主世界1 + 主世界实体1 + 下界1 + 下界实体1 + 末地1');
    assert.strictEqual(s.playHours, 1.7, '120000 ticks / 20 / 3600');
    assert.ok(s.savings.indexMB >= 0);
    assert.ok(s.topSavesByContainers[0].playHours === 1.7);
  });

  t('stats：跳过缓存之后统计结果保持一致', async () => {
    const sv8 = await wdb.scanSave({ saveDir: S2, cacheDir: CACHE });
    const sv7 = await wdb.scanSave({ saveDir: S2, cacheDir: CACHE });
    const a = wdb.stats([sv8]);
    const b = wdb.stats([sv7]);
    assert.strictEqual(sv7.scan.parsedFiles, 0, '这一轮应当全是复用');
    assert.strictEqual(b.totalItems, a.totalItems);
    assert.strictEqual(b.totalContainers, a.totalContainers);
    assert.strictEqual(b.indexedChunks, a.indexedChunks);
  });

  t('scanGameDir：多个 gameDir 一起扫，并记下各自来自哪个 launcher 目录', async () => {
    const gd3 = path.join(dir2, 'mc2');
    const S3 = path.join(gd3, 'saves', '第二个世界');
    fs.mkdirSync(path.join(S3, 'region'), { recursive: true });
    anvil.writeSaveChunk({
      saveDir: S3, dim: 'overworld', cx: 0, cz: 0, backup: false,
      raw: chunk18([{ id: 'minecraft:chest', x: 1, y: 2, z: 3, Items: [{ id: 'minecraft:diamond', Count: 1 }] }])
    });
    const list = await wdb.scanGameDir({ gameDirs: [gd2, gd3], cacheDir: CACHE });
    assert.strictEqual(list.length, 2, '两个 gameDir 各一个存档');
    const fromGd = new Set(list.map((s) => path.basename(s.gameDir)));
    assert.deepStrictEqual([...fromGd].sort(), ['mc', 'mc2']);
    assert.ok(list.some((s) => s.name === '第二个世界'));
  });

  fs.rmSync(dir2, { recursive: true, force: true });

  console.log('\nworlddb: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
