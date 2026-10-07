// 离线合成规划 IPC（V4 第二组尾巴 · R12）
//
// 职责：把 craftplanner 的「目标 → 展开配方 → 抵扣库存 → 排采集顺序」接到渲染层。
// 纯内存计算，**不读盘不联网**（除非显式要求从存档统计库存，见 `scanSaveDir`）。
//
// 设计要点：
//   1) 与 worlddb 联动：`craft-plan` 传 `scanSaveDir` 会把该存档里所有容器的物品
//      汇总成"已有材料"，于是「还差多少」是拿真实库存算的，而不是玩家手填。
//      这一步要解压全部区块，比较慢，所以**默认关闭**，由 UI 上的勾选框决定。
//   2) 默认**不启用拆解配方**（方块→锭），否则与「锭→方块」形成回路、需求指数爆炸。
//      真要用拆解时才显式传 `allowUncraft`。
//   3) 配方表是进程级共享的，`craft-import` 是**追加**语义（给整合包补自定义配方），
//      不做持久化 —— 重启即回到内置表。
const craftplanner = require('../craftplanner');
const worlddb = require('../worlddb');
const { safe } = require('./util');

/** 所有可被搜到的物品 id：字典里的 + 所有配方的输出 */
function allItemIds() {
  const set = new Set(Object.keys(craftplanner.ITEM_ZH));
  for (const r of craftplanner.RECIPES) set.add(r.out);
  return set;
}

/** 从一组 worlddb 容器里汇总库存（container.items 形如 {id, count}） */
function harvest(containers) {
  const items = [];
  for (const c of (Array.isArray(containers) ? containers : [])) {
    for (const it of ((c && c.items) || [])) items.push(it);
  }
  return craftplanner.inventoryOf(items);
}

/** 把目标规格化成 [{id,n}]，非法项丢掉（前端可能传字符串数组） */
function normTargets(targets) {
  const out = [];
  if (Array.isArray(targets)) {
    for (const t of targets) {
      if (!t) continue;
      if (typeof t === 'string') { out.push({ id: t, n: 1 }); continue; }
      if (!t.id) continue;
      const n = (t.n === undefined || t.n === null) ? 1 : Number(t.n);
      if (Number.isFinite(n) && n > 0) out.push({ id: String(t.id), n });
    }
  } else if (targets && typeof targets === 'object') {
    for (const id of Object.keys(targets)) {
      const n = Number(targets[id]);
      if (Number.isFinite(n) && n > 0) out.push({ id, n });
    }
  }
  return out;
}

module.exports = function register(ctx) {
  const { ipcMain } = ctx;

  /** 配方库概况（条数 / 输出数 / 各来源分布）+ 木材与工具档位（UI 做快捷添加用） */
  ipcMain.handle('craft-meta', safe(() => ({
    ok: true,
    stats: craftplanner.stats(),
    woods: craftplanner.WOODS,
    tiers: craftplanner.TIERS
  })));

  /**
   * 按中文名或物品 id 搜物品（做输入联想）。
   * @param {string} q
   */
  ipcMain.handle('craft-search', safe((_e, q) => {
    const key = String(q || '').trim();
    if (!key) return { ok: true, items: [] };
    const low = key.toLowerCase();
    const hit = [];
    for (const id of allItemIds()) {
      const zh = craftplanner.itemZh(id) || '';
      const mId = id.toLowerCase().indexOf(low) >= 0;
      const mZh = zh.indexOf(key) >= 0;
      if (!mId && !mZh) continue;
      const exact = (zh === key || id === low) ? 0 : (mZh ? 1 : 2);
      hit.push({
        id,
        zh: zh || id,
        ways: craftplanner.recipesFor(id).length,
        source: craftplanner.sourceOf(id).label,
        exact
      });
    }
    hit.sort((a, b) => (a.exact - b.exact) || (a.id < b.id ? -1 : 1));
    return { ok: true, items: hit.slice(0, 60) };
  }));

  /**
   * 某个物品的配方明细（UI 点开看「这东西怎么做」）。
   * @param {string} id
   */
  ipcMain.handle('craft-recipes', safe((_e, id) => {
    const key = String(id || '').replace(/^minecraft:/, '');
    if (!key) return { ok: false, error: '没有指定物品。' };
    const rs = craftplanner.recipesFor(key);
    const src = craftplanner.sourceOf(key);
    return {
      ok: true,
      id: key,
      zh: craftplanner.itemZh(key) || key,
      source: src.label,
      sourceKey: src.key,
      recipes: rs.map((r) => ({
        out: r.out,
        n: r.n,
        via: r.via,
        ing: Object.keys(r.in).map((k) => {
          const isTag = k.charAt(0) === '#';
          return {
            key: k,
            tag: isTag,
            zh: isTag ? (k.slice(1) + '（任一种）') : (craftplanner.itemZh(k) || k),
            n: r.in[k],
            candidates: isTag ? craftplanner.expandTag(k) : [k]
          };
        })
      }))
    };
  }));

  /**
   * 规划合成。
   * @param {{targets:Array|Object, have?:Record<string,number>, depth?:number,
   *          allowUncraft?:boolean, scanSaveDir?:string, withOrder?:boolean}} o
   */
  ipcMain.handle('craft-plan', safe(async (_e, o) => {
    const opt = o || {};
    const targets = normTargets(opt.targets);
    if (!targets.length) return { ok: false, error: '还没有要合成的东西 —— 先在上面加几样。' };

    const have = Object.assign({}, opt.have || {});
    /** 库存来源说明，UI 上要讲清楚"这个数是从哪来的" */
    let invFrom = Object.keys(have).length ? 'manual' : null;

    if (opt.scanSaveDir) {
      try {
        const one = await worlddb.scanSave({ saveDir: opt.scanSaveDir });
        const fromSave = harvest(one && one.containers);
        for (const k of Object.keys(fromSave)) have[k] = (have[k] || 0) + fromSave[k];
        invFrom = invFrom ? 'manual+save' : 'save';
      } catch (e) {
        // 存档扫不动不该让整个规划失败 —— 退化成"没库存"继续算
        invFrom = invFrom || 'none';
      }
    }

    const p = craftplanner.plan(targets, {
      have,
      depth: Number(opt.depth) || undefined,
      allowUncraft: !!opt.allowUncraft
    });

    // 采集顺序只在需要时算（纯展示用，计算量不大但没必要每次都带）
    const groups = opt.withOrder === false ? [] : craftplanner.order(p.base);
    const gap = craftplanner.gaps(targets, have);

    return {
      ok: true,
      plan: p,
      order: groups,
      gaps: gap,
      have,
      inventoryFrom: invFrom || 'none'
    };
  }));

  /** 只算「目标 vs 库存」的缺口（不展开配方，给"随手看一眼还差多少"用） */
  ipcMain.handle('craft-gaps', safe((_e, o) => {
    const opt = o || {};
    const targets = normTargets(opt.targets);
    if (!targets.length) return { ok: false, error: '还没有要合成的东西。' };
    return { ok: true, gaps: craftplanner.gaps(targets, opt.have || {}) };
  }));

  /**
   * 追加自定义配方（整合包 / 模组物品）。**只影响当前进程**，不落盘。
   * @param {{list:Array, replace?:boolean}} o
   */
  ipcMain.handle('craft-import', safe((_e, o) => {
    const opt = o || {};
    const list = Array.isArray(opt.list) ? opt.list : (opt.list && opt.list.recipes);
    if (!Array.isArray(list) || !list.length) return { ok: false, error: '没有可导入的配方。' };
    const r = craftplanner.importRecipes(list, { replace: !!opt.replace });
    return Object.assign({ ok: true, stats: craftplanner.stats() }, r);
  }));
};
