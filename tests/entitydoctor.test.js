// entitydoctor.js 单元测试（纯 Node，不依赖 Electron）
const assert = require('assert');
const ed = require('../entitydoctor');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('entitydoctor.test');
console.log('==================');

/* ---------------- bare ---------------- */
t('bare：去掉 minecraft: 前缀', () => {
  assert.strictEqual(ed.bare('minecraft:zombie'), 'zombie');
});
t('bare：没有前缀时原样返回', () => {
  assert.strictEqual(ed.bare('zombie'), 'zombie');
});
t('bare：非字符串返回空串', () => {
  assert.strictEqual(ed.bare(null), '');
  assert.strictEqual(ed.bare(undefined), '');
  assert.strictEqual(ed.bare(42), '');
});

/* ---------------- classify ---------------- */
t('classify：掉落物', () => {
  assert.strictEqual(ed.classify('minecraft:item'), 'item');
});
t('classify：经验球', () => {
  assert.strictEqual(ed.classify('experience_orb'), 'xp');
});
t('classify：抛射物', () => {
  assert.strictEqual(ed.classify('arrow'), 'projectile');
  assert.strictEqual(ed.classify('minecraft:spectral_arrow'), 'projectile');
  assert.strictEqual(ed.classify('trident'), 'projectile');
});
t('classify：载具（各种船 / 木筏 / 矿车）', () => {
  assert.strictEqual(ed.classify('oak_boat'), 'vehicle');
  assert.strictEqual(ed.classify('bamboo_chest_raft'), 'vehicle');
  assert.strictEqual(ed.classify('minecart'), 'vehicle');
  assert.strictEqual(ed.classify('hopper_minecart'), 'vehicle');
});
t('classify：村民与流浪商人', () => {
  assert.strictEqual(ed.classify('villager'), 'villager');
  assert.strictEqual(ed.classify('wandering_trader'), 'villager');
});
t('classify：敌对生物', () => {
  assert.strictEqual(ed.classify('zombie'), 'hostile');
  assert.strictEqual(ed.classify('creeper'), 'hostile');
  assert.strictEqual(ed.classify('warden'), 'hostile');
});
t('classify：友好生物', () => {
  assert.strictEqual(ed.classify('cow'), 'passive');
  assert.strictEqual(ed.classify('wolf'), 'passive');
});
t('classify：未知归入 other', () => {
  assert.strictEqual(ed.classify('armor_stand'), 'other');
  assert.strictEqual(ed.classify('some_modded_thing'), 'other');
  assert.strictEqual(ed.classify(''), 'other');
});

/* ---------------- costOf ---------------- */
t('costOf：掉落物最便宜，村民最贵', () => {
  assert.ok(ed.costOf('item') < ed.costOf('arrow'));
  assert.ok(ed.costOf('arrow') < ed.costOf('zombie'));
  assert.ok(ed.costOf('zombie') < ed.costOf('villager'));
});
t('costOf：未知实体有兜底成本', () => {
  assert.strictEqual(typeof ed.costOf('nope'), 'number');
  assert.ok(ed.costOf('nope') > 0);
});

/* ---------------- entitiesOf ---------------- */
t('entitiesOf：老格式（root.Level.Entities）', () => {
  const r = { Level: { Entities: [{ id: 'minecraft:pig' }] } };
  assert.strictEqual(ed.entitiesOf(r).length, 1);
});
t('entitiesOf：1.18+ 格式（root.Entities）', () => {
  const r = { Entities: [{ id: 'minecraft:pig' }, { id: 'minecraft:cow' }] };
  assert.strictEqual(ed.entitiesOf(r).length, 2);
});
t('entitiesOf：null / 无实体字段不抛异常', () => {
  assert.deepStrictEqual(ed.entitiesOf(null), []);
  assert.deepStrictEqual(ed.entitiesOf({}), []);
  assert.deepStrictEqual(ed.entitiesOf({ Level: {} }), []);
});

/* ---------------- countChunk ---------------- */
t('countChunk：空区块返回零值', () => {
  const r = ed.countChunk({ Entities: [] });
  assert.strictEqual(r.count, 0);
  assert.strictEqual(r.cost, 0);
  assert.deepStrictEqual(Object.keys(r.types), []);
});

t('countChunk：null 不抛异常', () => {
  const r = ed.countChunk(null);
  assert.strictEqual(r.count, 0);
});

t('countChunk：按类型计数', () => {
  const r = ed.countChunk({
    Entities: [
      { id: 'minecraft:zombie' }, { id: 'minecraft:zombie' },
      { id: 'minecraft:item' }
    ]
  });
  assert.strictEqual(r.count, 3);
  assert.strictEqual(r.types.zombie, 2);
  assert.strictEqual(r.types.item, 1);
});

t('countChunk：按类别计数', () => {
  const r = ed.countChunk({
    Entities: [{ id: 'zombie' }, { id: 'cow' }, { id: 'item' }, { id: 'arrow' }]
  });
  assert.strictEqual(r.cats.hostile, 1);
  assert.strictEqual(r.cats.passive, 1);
  assert.strictEqual(r.cats.item, 1);
  assert.strictEqual(r.cats.projectile, 1);
});

t('countChunk：成本 = Σ 各类别数量 × 权重', () => {
  const r = ed.countChunk({ Entities: [{ id: 'item' }, { id: 'item' }, { id: 'villager' }] });
  const want = ed.COST.item * 2 + ed.COST.villager;
  assert.strictEqual(r.cost, Math.round(want * 10) / 10);
});

t('countChunk：缺少 id 的条目被跳过', () => {
  const r = ed.countChunk({ Entities: [{ id: 'zombie' }, {}, null, { id: '' }] });
  assert.strictEqual(r.count, 1);
});

t('countChunk：不是对象的条目被跳过', () => {
  const r = ed.countChunk({ Entities: ['zombie', 7, { id: 'pig' }] });
  assert.strictEqual(r.count, 1);
});

t('countChunk：类型统计对象无原型污染风险', () => {
  const r = ed.countChunk({ Entities: [{ id: '__proto__' }, { id: 'constructor' }] });
  assert.strictEqual(r.count, 2);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(r.types, '__proto__'), true);
});

/* ---------------- summarize ---------------- */
function chunk(cx, cz, ents) {
  const c = ed.countChunk({ Entities: ents.map(id => ({ id })) });
  return { cx, cz, types: c.types, cats: c.cats, count: c.count, cost: c.cost };
}

t('summarize：空数组不抛异常', () => {
  const s = ed.summarize([]);
  assert.strictEqual(s.chunks, 0);
  assert.strictEqual(s.total, 0);
  assert.deepStrictEqual(s.hot, []);
});

t('summarize：null 不抛异常', () => {
  const s = ed.summarize(null);
  assert.strictEqual(s.total, 0);
});

t('summarize：跨区块合并类型数量', () => {
  const s = ed.summarize([
    chunk(0, 0, ['item', 'item']),
    chunk(1, 0, ['item', 'zombie'])
  ]);
  const item = s.byType.find(x => x.id === 'item');
  assert.strictEqual(item.count, 3);
  assert.strictEqual(s.total, 4);
});

t('summarize：nonEmpty 只数有实体的区块', () => {
  const s = ed.summarize([chunk(0, 0, []), chunk(1, 0, ['pig'])]);
  assert.strictEqual(s.chunks, 2);
  assert.strictEqual(s.nonEmpty, 1);
});

t('summarize：maxCount 取最大单区块数量', () => {
  const s = ed.summarize([chunk(0, 0, ['pig']), chunk(9, 9, ['pig', 'pig', 'pig'])]);
  assert.strictEqual(s.maxCount, 3);
});

t('summarize：hot 按成本降序，不是按数量', () => {
  // 8 个村民（成本高） vs 20 个掉落物（数量多但便宜）
  const villagers = chunk(5, 5, new Array(8).fill('villager'));
  const items = chunk(0, 0, new Array(20).fill('item'));
  const s = ed.summarize([items, villagers], { top: 10 });
  assert.strictEqual(s.hot[0].cx, 5, '村民区块应排第一');
  assert.strictEqual(s.hot[1].cx, 0);
});

t('summarize：hot 默认截取条数受 top 控制', () => {
  const cs = [];
  for (let i = 0; i < 30; i++) cs.push(chunk(i, 0, ['pig']));
  assert.strictEqual(ed.summarize(cs, { top: 5 }).hot.length, 5);
  assert.strictEqual(ed.summarize(cs).hot.length, ed.TH.top);
});

t('summarize：hot 里排除空区块', () => {
  const s = ed.summarize([chunk(0, 0, []), chunk(1, 1, ['pig'])], { top: 10 });
  assert.strictEqual(s.hot.length, 1);
});

t('summarize：hot 条目的 types 按成本降序', () => {
  const c = ed.countChunk({ Entities: [{ id: 'item' }, { id: 'villager' }] });
  const s = ed.summarize([{ cx: 0, cz: 0, ...c }], { top: 5 });
  assert.strictEqual(s.hot[0].types[0].id, 'villager');
});

t('summarize：byCategory 带中文标签', () => {
  const s = ed.summarize([chunk(0, 0, ['villager'])]);
  const v = s.byCategory.find(x => x.key === 'villager');
  assert.strictEqual(v.label, '村民');
});

t('summarize：byCategory 按成本降序', () => {
  const s = ed.summarize([chunk(0, 0, ['item', 'item', 'villager'])]);
  assert.strictEqual(s.byCategory[0].key, 'villager');
});

/* ---------------- suggest ---------------- */
t('suggest：干净存档无 error 且评分 100', () => {
  const s = ed.summarize([chunk(0, 0, ['pig'])]);
  const r = ed.suggest(s);
  assert.strictEqual(r.hasError, false);
  assert.strictEqual(r.score, 100);
  assert.strictEqual(r.grade, 'good');
});

t('suggest：单区块 200+ 实体报 error', () => {
  const s = ed.summarize([chunk(0, 0, new Array(ed.TH.chunkEntitiesError).fill('pig'))]);
  const r = ed.suggest(s);
  assert.strictEqual(r.hasError, true);
  assert.ok(r.findings.some(f => f.code === 'CHUNK_FLOOD'));
});

t('suggest：单区块 80+ 实体报 warn', () => {
  const s = ed.summarize([chunk(0, 0, new Array(ed.TH.chunkEntities).fill('pig'))]);
  const r = ed.suggest(s);
  assert.strictEqual(r.hasError, false);
  assert.ok(r.findings.some(f => f.code === 'CHUNK_DENSE'));
});

t('suggest：掉落物堆积命中 ITEM_PILE', () => {
  const s = ed.summarize([chunk(0, 0, new Array(ed.TH.items).fill('item'))]);
  const r = ed.suggest(s);
  assert.ok(r.findings.some(f => f.code === 'ITEM_PILE'));
});

t('suggest：经验球堆积命中 XP_PILE', () => {
  const s = ed.summarize([chunk(0, 0, new Array(ed.TH.xp).fill('experience_orb'))]);
  const r = ed.suggest(s);
  assert.ok(r.findings.some(f => f.code === 'XP_PILE'));
});

t('suggest：村民聚集命中 VILLAGER_CROWD', () => {
  const s = ed.summarize([chunk(0, 0, new Array(ed.TH.villagers).fill('villager'))]);
  const r = ed.suggest(s);
  assert.ok(r.findings.some(f => f.code === 'VILLAGER_CROWD'));
});

t('suggest：全存档总量偏大发 info', () => {
  const s = ed.summarize([chunk(0, 0, new Array(ed.TH.totalEntities).fill('pig'))]);
  const r = ed.suggest(s);
  assert.ok(r.findings.some(f => f.code === 'TOTAL_HIGH'));
});

t('suggest：findings 按严重度排序（error 在前）', () => {
  const s = ed.summarize([
    chunk(0, 0, new Array(ed.TH.chunkEntitiesError).fill('pig')),
    chunk(1, 0, new Array(ed.TH.items).fill('item'))
  ]);
  const r = ed.suggest(s);
  const sevs = r.findings.map(f => f.severity);
  const order = sevs.map(x => ed.SEV_ORDER[x]);
  assert.deepStrictEqual(order, order.slice().sort((a, b) => a - b));
});

t('suggest：每条 finding 都有必要字段', () => {
  const s = ed.summarize([chunk(0, 0, new Array(ed.TH.chunkEntitiesError).fill('pig'))]);
  const r = ed.suggest(s);
  for (const f of r.findings) {
    assert.ok(typeof f.severity === 'string');
    assert.ok(typeof f.code === 'string');
    assert.ok(typeof f.title === 'string' && f.title.length > 0);
    assert.ok(typeof f.detail === 'string' && f.detail.length > 0);
    assert.ok(typeof f.advice === 'string' && f.advice.length > 0);
  }
});

t('suggest：自定义阈值生效', () => {
  const s = ed.summarize([chunk(0, 0, new Array(10).fill('pig'))]);
  assert.strictEqual(ed.suggest(s).findings.length, 0);
  const strict = ed.suggest(s, { th: { chunkEntities: 5 } });
  assert.ok(strict.findings.some(f => f.code === 'CHUNK_DENSE'));
});

t('suggest：评分随严重度下降且不低于 0', () => {
  const many = [];
  for (let i = 0; i < 40; i++) many.push(chunk(i, 0, new Array(ed.TH.chunkEntitiesError).fill('villager')));
  const r = ed.suggest(ed.summarize(many, { top: 40 }));
  assert.ok(r.score >= 0 && r.score <= 100);
  assert.strictEqual(r.grade, 'bad');
});

/* ---------------- commands ---------------- */
t('commands：区块坐标换算成世界坐标', () => {
  const s = ed.summarize([chunk(2, 3, ['item'])], { top: 5 });
  const c = ed.commands(s);
  assert.strictEqual(c.length, 1);
  assert.ok(c[0].cmd.includes('x=32'), '2*16=32');
  assert.ok(c[0].cmd.includes('z=48'), '3*16=48');
  assert.ok(c[0].cmd.includes('dx=16'));
  assert.ok(c[0].cmd.includes('dz=16'));
});

t('commands：负坐标正确换算', () => {
  const s = ed.summarize([chunk(-1, -2, ['item'])], { top: 5 });
  const c = ed.commands(s);
  assert.ok(c[0].cmd.includes('x=-16'));
  assert.ok(c[0].cmd.includes('z=-32'));
});

t('commands：目标类型取区块内成本最高的', () => {
  const c0 = ed.countChunk({ Entities: [{ id: 'item' }, { id: 'villager' }] });
  const s = ed.summarize([{ cx: 0, cz: 0, ...c0 }], { top: 5 });
  const c = ed.commands(s);
  assert.ok(c[0].cmd.includes('type=minecraft:villager'));
});

t('commands：max 限制条数', () => {
  const cs = [];
  for (let i = 0; i < 10; i++) cs.push(chunk(i, 0, ['pig']));
  assert.strictEqual(ed.commands(ed.summarize(cs, { top: 10 }), { max: 3 }).length, 3);
});

t('commands：空输入返回空数组', () => {
  assert.deepStrictEqual(ed.commands(null), []);
  assert.deepStrictEqual(ed.commands({ hot: [] }), []);
});

/* ---------------- report ---------------- */
t('report：包含各主要小节', () => {
  const s = ed.summarize([chunk(0, 0, new Array(ed.TH.items).fill('item'))]);
  const sug = ed.suggest(s);
  const txt = ed.report({
    name: '测试世界', saveDir: '/tmp/w', summary: s,
    findings: sug.findings, score: sug.score, grade: sug.grade,
    commands: ed.commands(s)
  });
  assert.ok(txt.includes('实体清理报告'));
  assert.ok(txt.includes('测试世界'));
  assert.ok(txt.includes('—— 总览 ——'));
  assert.ok(txt.includes('—— 按类别 ——'));
  assert.ok(txt.includes('—— 实体类型 Top 15 ——'));
  assert.ok(txt.includes('—— 成本最高的区块 Top 10 ——'));
  assert.ok(txt.includes('—— 建议'));
  assert.ok(txt.includes('—— 清理指令'));
});

t('report：干净存档说明无问题', () => {
  const s = ed.summarize([]);
  const sug = ed.suggest(s);
  const txt = ed.report({ saveDir: 'w', summary: s, findings: sug.findings, commands: [] });
  assert.ok(txt.includes('没有发现需要处理的问题'));
  assert.ok(txt.includes('无。'));
});

t('report：null 不抛异常', () => {
  assert.ok(typeof ed.report(null) === 'string');
});

/* ---------------- analyze 的纯逻辑组合（不读盘） ---------------- */
t('analyze 组合：summary + suggest 结果自洽', () => {
  const cs = [chunk(0, 0, new Array(ed.TH.chunkEntitiesError).fill('villager')), chunk(4, 4, ['pig'])];
  const s = ed.summarize(cs, { top: 10 });
  const sug = ed.suggest(s);
  assert.strictEqual(s.total, ed.TH.chunkEntitiesError + 1);
  assert.strictEqual(sug.hasError, true);
  assert.ok(sug.score < 100);
});

t('常量表完整性：每个 CATEGORY 都有中文名与成本', () => {
  for (const k of Object.keys(ed.CATEGORY)) {
    assert.ok(ed.CATEGORY_ZH[k], k + ' 缺中文名');
    assert.ok(typeof ed.COST[k] === 'number', k + ' 缺成本权重');
  }
});

console.log('==================');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
