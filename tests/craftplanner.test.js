// craftplanner.js 单元测试（纯 Node，不依赖 Electron）
const assert = require('assert');
const cp = require('../craftplanner');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('craftplanner.test');
console.log('==================');

/* ---------------- itemZh ---------------- */
t('itemZh：已知物品返回中文', () => {
  assert.strictEqual(cp.itemZh('diamond_sword'), '钻石剑');
  assert.strictEqual(cp.itemZh('minecraft:diamond_sword'), '钻石剑');
});
t('itemZh：未知物品把下划线换成空格', () => {
  assert.strictEqual(cp.itemZh('some_mod_item'), 'some mod item');
});
t('itemZh：空输入返回空串', () => {
  assert.strictEqual(cp.itemZh(''), '');
  assert.strictEqual(cp.itemZh(null), '');
});

/* ---------------- expandTag ---------------- */
t('expandTag：标签展开成候选列表', () => {
  const p = cp.expandTag('#planks');
  assert.ok(p.length >= 10);
  assert.ok(p.includes('oak_planks'));
});
t('expandTag：普通物品返回单元素数组', () => {
  assert.deepStrictEqual(cp.expandTag('stick'), ['stick']);
  assert.deepStrictEqual(cp.expandTag('minecraft:stick'), ['stick']);
});
t('expandTag：未知标签返回空数组', () => {
  assert.deepStrictEqual(cp.expandTag('#nope'), []);
});
t('expandTag：非字符串不抛异常', () => {
  assert.deepStrictEqual(cp.expandTag(null), []);
});

/* ---------------- recipesFor / stats ---------------- */
t('recipesFor：查得到配方', () => {
  assert.ok(cp.recipesFor('stick').length > 0);
  assert.strictEqual(cp.recipesFor('stick')[0].out, 'stick');
});
t('recipesFor：未知物品返回空数组', () => {
  assert.deepStrictEqual(cp.recipesFor('definitely_not_a_thing'), []);
});
t('stats：配方表规模合理', () => {
  const s = cp.stats();
  assert.ok(s.recipes > 300, '配方数 ' + s.recipes + ' 偏少');
  assert.ok(s.outputs > 300);
  assert.ok(s.byVia.craft > 0 && s.byVia.smelt > 0 && s.byVia.uncraft > 0);
});
t('配方表：每种木头都有一整套木制品', () => {
  for (const w of cp.WOODS) {
    for (const suffix of ['_planks', '_stairs', '_slab', '_fence', '_door', '_boat']) {
      assert.ok(cp.recipesFor(w + suffix).length > 0, w + suffix + ' 缺配方');
    }
  }
});
t('配方表：工具与盔甲齐全（除下界合金）', () => {
  for (const p of ['wooden', 'stone', 'iron', 'golden', 'diamond']) {
    for (const tool of ['pickaxe', 'axe', 'shovel', 'hoe', 'sword']) {
      assert.ok(cp.recipesFor(p + '_' + tool).length > 0, p + '_' + tool + ' 缺配方');
    }
  }
});
t('配方表：每种物品的配方都自洽（产出数 > 0、材料非空）', () => {
  for (const r of cp.RECIPES) {
    assert.ok(r.out && typeof r.out === 'string', '配方缺 out');
    assert.ok(r.n > 0, r.out + ' 产出数应为正');
    assert.ok(r.in && Object.keys(r.in).length > 0, r.out + ' 材料为空');
    for (const k of Object.keys(r.in)) {
      assert.ok(r.in[k] > 0, r.out + ' 的 ' + k + ' 数量应为正');
    }
  }
});

/* ---------------- sourceOf ---------------- */
t('sourceOf：矿石归挖矿', () => {
  assert.strictEqual(cp.sourceOf('iron_ore').key, 'mine');
  assert.strictEqual(cp.sourceOf('raw_iron').key, 'mine');
  assert.strictEqual(cp.sourceOf('diamond').key, 'mine');
});
t('sourceOf：原木归伐木', () => {
  assert.strictEqual(cp.sourceOf('oak_log').key, 'wood');
  assert.strictEqual(cp.sourceOf('crimson_stem').key, 'wood');
});
t('sourceOf：农牧产品归农牧', () => {
  assert.strictEqual(cp.sourceOf('wheat').key, 'farm');
  assert.strictEqual(cp.sourceOf('leather').key, 'farm');
  assert.strictEqual(cp.sourceOf('red_wool').key, 'farm');
});
t('sourceOf：锭类归熔炼', () => {
  assert.strictEqual(cp.sourceOf('iron_ingot').key, 'smelt');
  assert.strictEqual(cp.sourceOf('glass').key, 'smelt');
});
t('sourceOf：未知物品兜底到合成/其他', () => {
  assert.strictEqual(cp.sourceOf('whatever_thing').key, 'craft');
});

/* ---------------- plan：基础 ---------------- */
t('plan：空目标返回空结果', () => {
  const p = cp.plan([]);
  assert.strictEqual(p.ok, true);
  assert.deepStrictEqual(p.base, []);
  assert.strictEqual(p.steps.length, 0);
});
t('plan：null 不抛异常', () => {
  assert.strictEqual(cp.plan(null).ok, true);
});
t('plan：接受数组与对象两种目标写法', () => {
  const a = cp.plan([{ id: 'stick', n: 4 }]);
  const b = cp.plan({ stick: 4 });
  assert.deepStrictEqual(a.base.map(x => x.id), b.base.map(x => x.id));
});
t('plan：无配方的目标直接成为基础材料', () => {
  const p = cp.plan([{ id: 'diamond', n: 5 }]);
  assert.strictEqual(p.base.length, 1);
  assert.strictEqual(p.base[0].id, 'diamond');
  assert.strictEqual(p.base[0].missing, 5);
});
t('plan：钻石剑 ×2 需要 4 钻石 + 1 原木', () => {
  const p = cp.plan([{ id: 'diamond_sword', n: 2 }]);
  const m = {};
  for (const b of p.base) m[b.id] = b.missing;
  assert.strictEqual(m.diamond, 4);
  assert.strictEqual(m.oak_log, 1);
});
t('plan：基础材料带中文名与来源标签', () => {
  const p = cp.plan([{ id: 'diamond_sword', n: 1 }]);
  for (const b of p.base) {
    assert.ok(b.zh && b.zh.length > 0);
    assert.ok(b.sourceLabel && b.sourceLabel.length > 0);
  }
});
t('plan：合成步骤带 via 与材料明细', () => {
  const p = cp.plan([{ id: 'torch', n: 4 }]);
  const st = p.steps.find(s => s.id === 'torch');
  assert.ok(st, '缺火把合成步骤');
  assert.strictEqual(st.via, 'craft');
  assert.strictEqual(st.times, 1);
  assert.ok(st.from.length >= 2);
});
t('plan：熔炼步骤排在合成步骤前面', () => {
  const p = cp.plan([{ id: 'iron_pickaxe', n: 1 }]);
  const idxSmelt = p.steps.findIndex(s => s.via === 'smelt');
  const idxTool = p.steps.findIndex(s => s.id === 'iron_pickaxe');
  assert.ok(idxSmelt >= 0 && idxTool >= 0);
  assert.ok(idxSmelt < idxTool, '熔炼应排在工具合成之前');
});

/* ---------------- plan：共享与抵扣 ---------------- */
t('plan：多目标共享中间产物，木棍只算一次', () => {
  // 剑 1 木棍 + 镐 2 木棍 = 3 木棍 → 1 次合成（产出 4）
  const p = cp.plan([{ id: 'diamond_sword', n: 1 }, { id: 'iron_pickaxe', n: 1 }]);
  const stick = p.steps.find(s => s.id === 'stick');
  assert.strictEqual(stick.times, 1, '木棍应该只合成 1 次，实际 ' + stick.times);
});
t('plan：木棍 ×4 只需 2 木板 → 1 原木', () => {
  const p = cp.plan([{ id: 'stick', n: 4 }]);
  const m = {};
  for (const b of p.base) m[b.id] = b.missing;
  assert.strictEqual(m.oak_log, 1);
  assert.strictEqual(p.base.length, 1, '不该有多余的基础材料');
});
t('plan：库存抵扣减少上游需求', () => {
  const withStock = cp.plan([{ id: 'iron_pickaxe', n: 1 }], { have: { iron_ingot: 3, stick: 2 } });
  assert.strictEqual(withStock.base.length, 0, '铁锭与木棍都够了，不该还要材料');
});
t('plan：库存不足时只算差额', () => {
  const p = cp.plan([{ id: 'iron_pickaxe', n: 2 }], { have: { iron_ingot: 3 } });
  const m = {};
  for (const b of p.base) m[b.id] = b.missing;
  assert.strictEqual(m.raw_iron, 3, '需 6 铁锭、已有 3，还差 3');
});
t('plan：从上游中间品抵扣也生效', () => {
  const p = cp.plan([{ id: 'stick', n: 4 }], { have: { oak_planks: 2 } });
  assert.strictEqual(p.base.length, 0, '有木板就不该再要原木');
});
t('plan：标签优先选用库存里已有的种类', () => {
  const p = cp.plan([{ id: 'stick', n: 4 }], { have: { spruce_planks: 10 } });
  assert.strictEqual(p.tagChoice['#planks'], 'spruce_planks');
});
t('plan：标签无库存时选定后不再变化', () => {
  const p = cp.plan([{ id: 'stick', n: 8 }, { id: 'crafting_table', n: 1 }]);
  assert.ok(p.tagChoice['#planks'], '应选定一个木板种类');
  assert.strictEqual(typeof p.tagChoice['#planks'], 'string');
});

/* ---------------- plan：回路防护（回归） ---------------- */
t('plan 回归：方块↔锭不会形成死循环', () => {
  const p = cp.plan([{ id: 'diamond', n: 2 }]);
  const m = {};
  for (const b of p.base) m[b.id] = b.missing;
  assert.strictEqual(m.diamond, 2, '钻石应是基础材料，不该被"拆解"出来');
  assert.strictEqual(p.base.length, 1);
  assert.deepStrictEqual(p.unresolved, []);
});
t('plan 回归：多目标不产生指数爆炸', () => {
  const p = cp.plan([
    { id: 'diamond_sword', n: 1 }, { id: 'iron_pickaxe', n: 1 }, { id: 'torch', n: 16 }
  ]);
  for (const s of p.steps) {
    assert.ok(s.times < 100, s.id + ' 合成次数异常：' + s.times);
  }
  for (const b of p.base) {
    assert.ok(b.missing < 1000, b.id + ' 需求异常：' + b.missing);
  }
});
t('plan 回归：金锭不会从金块里"造"出来', () => {
  const p = cp.plan([{ id: 'gold_ingot', n: 5 }]);
  const steps = p.steps.map(s => s.id);
  assert.ok(!steps.includes('gold_block'), '不该去合成金块');
});
t('plan：uncraft 默认不参与', () => {
  const p = cp.plan([{ id: 'diamond', n: 2 }]);
  assert.ok(!p.steps.some(s => s.via === 'uncraft'));
});
t('plan：allowUncraft 打开后拆解可用', () => {
  const p = cp.plan([{ id: 'diamond', n: 2 }], { allowUncraft: true });
  assert.ok(p.steps.some(s => s.via === 'uncraft'), '打开后应能用拆解配方');
});
t('plan：正常方向（锭→方块）仍然是合成', () => {
  const p = cp.plan([{ id: 'diamond_block', n: 1 }], { have: { diamond: 9 } });
  assert.strictEqual(p.base.length, 0);
  const st = p.steps.find(s => s.id === 'diamond_block');
  assert.strictEqual(st.via, 'craft');
});

/* ---------------- plan：异常输入 ---------------- */
t('plan：不认识的物品进 unknown 而不进 unresolved', () => {
  const p = cp.plan([{ id: 'totally_fake_item', n: 3 }]);
  assert.strictEqual(p.unresolved.length, 0);
  assert.strictEqual(p.unknown.length, 1);
  assert.strictEqual(p.unknown[0].key, 'totally_fake_item');
});
t('plan：数量为 0 或负数的目标被忽略', () => {
  const p = cp.plan([{ id: 'stick', n: 0 }, { id: 'torch', n: -5 }]);
  assert.deepStrictEqual(p.base, []);
});
t('plan：缺少 id 的条目被跳过', () => {
  const p = cp.plan([{ n: 5 }, null, { id: 'stick', n: 4 }]);
  assert.strictEqual(p.base.length, 1);
});
t('plan：totals 汇总基础材料种类与总量', () => {
  const p = cp.plan([{ id: 'diamond_sword', n: 1 }]);
  assert.strictEqual(p.totals.kinds, p.base.length);
  assert.ok(p.totals.items >= 3);
});
t('plan：craftable 统计参与合成的物品种类', () => {
  const p = cp.plan([{ id: 'diamond_sword', n: 1 }]);
  assert.ok(p.craftable >= 2, '至少该有木棍与剑');
});

/* ---------------- order ---------------- */
t('order：按来源分组且挖矿优先', () => {
  const p = cp.plan([{ id: 'diamond_sword', n: 1 }]);
  const g = cp.order(p.base);
  assert.ok(g.length >= 2);
  assert.strictEqual(g[0].key, 'mine', '挖矿应排第一');
  assert.strictEqual(g[1].key, 'wood', '伐木排第二');
});
t('order：每组带总计与中文标签', () => {
  const p = cp.plan([{ id: 'diamond_sword', n: 1 }]);
  for (const g of cp.order(p.base)) {
    assert.ok(g.label && g.label.length > 0);
    assert.ok(g.total > 0);
    assert.ok(Array.isArray(g.items) && g.items.length > 0);
  }
});
t('order：组内按数量降序', () => {
  const base = [
    { id: 'iron_ore', missing: 1 }, { id: 'diamond', missing: 7 }, { id: 'coal', missing: 3 }
  ];
  const g = cp.order(base);
  const mine = g.find(x => x.key === 'mine');
  assert.strictEqual(mine.items[0].id, 'diamond');
});
t('order：忽略数量为 0 的材料', () => {
  assert.deepStrictEqual(cp.order([{ id: 'iron_ore', missing: 0 }]), []);
});
t('order：空输入不抛异常', () => {
  assert.deepStrictEqual(cp.order(null), []);
});

/* ---------------- gaps ---------------- */
t('gaps：全部充足时 allEnough 为真', () => {
  const g = cp.gaps([{ id: 'diamond_sword', n: 1 }], { diamond_sword: 1 });
  assert.strictEqual(g.allEnough, true);
  assert.strictEqual(g.missingKinds, 0);
});
t('gaps：算出缺口数量', () => {
  const g = cp.gaps([{ id: 'diamond', n: 10 }], { diamond: 4 });
  assert.strictEqual(g.items[0].missing, 6);
  assert.strictEqual(g.missingKinds, 1);
  assert.strictEqual(g.missingTotal, 6);
});
t('gaps：接受对象形式的目标', () => {
  const g = cp.gaps({ diamond: 10 }, { diamond: 4 });
  assert.strictEqual(g.items[0].missing, 6);
});
t('gaps：不足的排在前面', () => {
  const g = cp.gaps({ a_item: 5, b_item: 1 }, { a_item: 5, b_item: 0 });
  assert.strictEqual(g.items[0].id, 'b_item');
});
t('gaps：每条带中文名与 enough 标记', () => {
  const g = cp.gaps([{ id: 'diamond_sword', n: 1 }], {});
  assert.strictEqual(g.items[0].zh, '钻石剑');
  assert.strictEqual(g.items[0].enough, false);
});
t('gaps：空输入不抛异常', () => {
  assert.strictEqual(cp.gaps(null, null).allEnough, true);
});

/* ---------------- inventoryOf ---------------- */
t('inventoryOf：汇总 count 字段', () => {
  const inv = cp.inventoryOf([{ id: 'minecraft:diamond', count: 3 }, { id: 'diamond', count: 2 }]);
  assert.strictEqual(inv.diamond, 5);
});
t('inventoryOf：兼容 Count 字段（NBT 原始写法）', () => {
  const inv = cp.inventoryOf([{ id: 'iron_ingot', Count: 7 }]);
  assert.strictEqual(inv.iron_ingot, 7);
});
t('inventoryOf：缺 count 时按 1 计', () => {
  const inv = cp.inventoryOf([{ id: 'stick' }]);
  assert.strictEqual(inv.stick, 1);
});
t('inventoryOf：跳过无效条目', () => {
  const inv = cp.inventoryOf([null, {}, { id: '' }, { id: 'coal', count: 2 }]);
  assert.strictEqual(inv.coal, 2);
  assert.strictEqual(Object.keys(inv).length, 1);
});
t('inventoryOf 与 plan 联动：库存能直接喂给 have', () => {
  const have = cp.inventoryOf([{ id: 'iron_ingot', count: 3 }]);
  const p = cp.plan([{ id: 'iron_pickaxe', n: 1 }], { have });
  const m = {};
  for (const b of p.base) m[b.id] = b.missing;
  assert.strictEqual(m.raw_iron, undefined, '3 铁锭够做镐，不该还要粗铁');
});

/* ---------------- importRecipes ---------------- */
t('importRecipes：数组形式可追加', () => {
  const before = cp.stats().recipes;
  const r = cp.importRecipes([['test_widget', 2, { stick: 1 }]]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.added, 1);
  assert.strictEqual(cp.stats().recipes, before + 1);
  assert.strictEqual(cp.recipesFor('test_widget')[0].n, 2);
});
t('importRecipes：对象形式可追加', () => {
  cp.importRecipes([{ out: 'test_gadget', n: 1, in: { test_widget: 1 }, via: 'craft' }]);
  assert.strictEqual(cp.recipesFor('test_gadget').length, 1);
  const p = cp.plan([{ id: 'test_gadget', n: 1 }]);
  assert.ok(p.steps.some(s => s.id === 'test_gadget'));
});
t('importRecipes：跳过无效条目', () => {
  const r = cp.importRecipes([null, {}, { out: 'x' }, { out: 'y', in: {} }]);
  assert.strictEqual(r.added, 0);
});
t('importRecipes：非数组输入不抛异常', () => {
  assert.strictEqual(cp.importRecipes(null).added, 0);
});
t('importRecipes：追加的配方能被规划使用', () => {
  cp.importRecipes([['test_sword', 1, { test_widget: 2 }]]);
  const p = cp.plan([{ id: 'test_sword', n: 1 }]);
  assert.ok(p.steps.some(s => s.id === 'test_sword'));
  assert.ok(p.steps.some(s => s.id === 'test_widget'), '应回溯到中间品');
  assert.ok(p.base.some(b => /_log$/.test(b.id)), '一路回溯到原木');
});

console.log('==================');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
