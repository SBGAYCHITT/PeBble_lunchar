'use strict';
/**
 * entitydoctor.js — 实体清理建议（存档 lag 分析）
 *
 * 定位：不进游戏，只看存档，回答「哪个区块的实体在拖后腿、该怎么清」。
 * 与隔壁两个模块的分工 ——
 *   - `perfdoctor.js` 看的是**日志 + 系统规格**，归因到 GC / 内存 / 参数；
 *   - `worlddb.js` 找的是**命名实体和容器**（"我的钻石剑在哪"）；
 *   - 本模块统计的是**全部实体**（含未命名、掉落物、经验球、抛射物），按区块聚合做成本排序。
 *
 * 三件事：
 *   1. 扫描各维度（region + 1.18+ 独立的 entities/）里的实体，按区块聚合成 `{类型: 数量}`；
 *   2. 用「实体类别 → 相对 tick 成本」的启发式权重排序，挑出最贵的区块（`hot`）；
 *   3. 产出可操作的建议（findings）、纯文本报告、以及**逐区块精确的清理指令**。
 *
 * 设计约束：
 *   - 核心逻辑全部是**纯函数**（`countChunk` / `summarize` / `suggest` / `report` / `commands`），
 *     单测直接喂合成对象，不碰磁盘；只有 `scanDim` / `analyze` 才读盘。
 *   - **只读**存档，任何情况下不写盘。清理指令只生成文本交给用户复核，不代为执行。
 *   - 权重是**启发式**，不是 Minecraft 的真实 tick 开销 —— 用来排序够用，别当成精确指标。
 *
 * ⚠️ 坑：1.18 起实体被拆到 `entities/` 目录，region 里的 `Level.Entities` 通常为空。
 *   两个来源都扫，**同一区块以 entities/ 为准**（见 `scanDim`），否则会把老版本存档的实体算丢、
 *   或者把两份数据重复计一次。
 */

const anvil = require('./anvil');
const nbt = require('./nbt');

/** 严重度排序（与 perfdoctor / modupdate 保持同一约定） */
const SEV_ORDER = { error: 0, warn: 1, info: 2 };
/** 严重度扣分（用于 0–100 评分） */
const SEV_PENALTY = { error: 20, warn: 8, info: 2 };

/** 实体类别 */
const CATEGORY = {
  item: 'item', xp: 'xp', projectile: 'projectile', vehicle: 'vehicle',
  villager: 'villager', hostile: 'hostile', passive: 'passive', other: 'other'
};

/** 类别中文名（UI 与报告共用） */
const CATEGORY_ZH = {
  item: '掉落物', xp: '经验球', projectile: '抛射物', vehicle: '载具',
  villager: '村民', hostile: '敌对生物', passive: '友好生物', other: '其他'
};

/**
 * 类别的相对 tick 成本（启发式）。
 * 排序依据：村民有复杂 AI 与日程、生物有寻路、载具有容器逻辑、抛射物有碰撞、
 * 掉落物/经验球基本只是合并检查，最便宜。
 */
const COST = {
  item: 1, xp: 1.5, projectile: 2, vehicle: 4,
  passive: 8, hostile: 10, villager: 25, other: 6
};

/** 抛射物白名单 */
const PROJECTILE = new Set([
  'arrow', 'spectral_arrow', 'trident', 'snowball', 'egg', 'ender_pearl', 'eye_of_ender',
  'fireball', 'small_fireball', 'dragon_fireball', 'wither_skull', 'llama_spit',
  'shulker_bullet', 'potion', 'experience_bottle', 'firework_rocket', 'wind_charge',
  'breeze_wind_charge', 'fishing_bobber', 'evoker_fangs', 'area_effect_cloud', 'thrown_trident'
]);

/** 敌对生物白名单 */
const HOSTILE = new Set([
  'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'wither_skeleton', 'creeper',
  'spider', 'cave_spider', 'enderman', 'witch', 'slime', 'magma_cube', 'blaze', 'ghast',
  'piglin', 'piglin_brute', 'hoglin', 'zoglin', 'wither', 'ender_dragon', 'phantom',
  'guardian', 'elder_guardian', 'shulker', 'silverfish', 'endermite', 'vex', 'vindicator',
  'evoker', 'pillager', 'ravager', 'illusioner', 'warden', 'breeze', 'creaking',
  'zombie_villager', 'zombified_piglin', 'giant'
]);

/** 友好/中立生物白名单 */
const PASSIVE = new Set([
  'cow', 'mooshroom', 'pig', 'sheep', 'chicken', 'rabbit', 'horse', 'donkey', 'mule',
  'llama', 'trader_llama', 'wolf', 'cat', 'ocelot', 'parrot', 'fox', 'panda', 'polar_bear',
  'turtle', 'dolphin', 'squid', 'glow_squid', 'cod', 'salmon', 'tropical_fish', 'pufferfish',
  'bat', 'bee', 'axolotl', 'goat', 'frog', 'tadpole', 'allay', 'sniffer', 'armadillo',
  'camel', 'happy_ghast', 'nautilus', 'skeleton_horse', 'zombie_horse', 'strider'
]);

/** 载具：各种船 / 木筏 / 矿车 */
const VEHICLE_RE = /(_boat|_raft|^boat$|^raft$|^minecart$|_minecart$)/;

/** 默认判定阈值 */
const TH = {
  /** 单区块实体总数：超过即告警 */
  chunkEntities: 80,
  chunkEntitiesError: 200,
  /** 单区块某种实体数量 */
  sameType: 60,
  /** 单区块掉落物 */
  items: 100,
  /** 单区块经验球 */
  xp: 150,
  /** 单区块村民 */
  villagers: 30,
  /** 单区块成本 */
  chunkCost: 600,
  /** 全存档实体总数（信息级提醒） */
  totalEntities: 2000,
  /** hot 列表返回条数 */
  top: 20
};

/** 去掉命名空间前缀 */
function bare(id) {
  if (typeof id !== 'string') return '';
  return id.replace(/^minecraft:/, '');
}

/**
 * 把一个实体 id 归入类别。
 * @param {string} id
 * @returns {string} CATEGORY 之一
 */
function classify(id) {
  const s = bare(id);
  if (!s) return CATEGORY.other;
  if (s === 'item') return CATEGORY.item;
  if (s === 'experience_orb') return CATEGORY.xp;
  if (PROJECTILE.has(s)) return CATEGORY.projectile;
  if (VEHICLE_RE.test(s)) return CATEGORY.vehicle;
  if (s === 'villager' || s === 'wandering_trader') return CATEGORY.villager;
  if (HOSTILE.has(s)) return CATEGORY.hostile;
  if (PASSIVE.has(s)) return CATEGORY.passive;
  return CATEGORY.other;
}

/**
 * 单个实体的相对成本。
 * @param {string} id
 * @returns {number}
 */
function costOf(id) {
  return COST[classify(id)] || COST.other;
}

/**
 * 取出 NBT root 里的实体列表。
 * 1.18+ 的 entities/ 文件实体在 root.Entities；老格式在 root.Level.Entities。
 * @param {object} root
 * @returns {Array<object>}
 */
function entitiesOf(root) {
  if (!root || typeof root !== 'object') return [];
  const lv = root.Level || root;
  const list = lv.Entities;
  return Array.isArray(list) ? list : [];
}

/**
 * **纯函数**：统计单个区块的实体。
 * @param {object} root 已解析的区块/实体文件 NBT root
 * @returns {{types: Record<string, number>, cats: Record<string, number>, count: number, cost: number}}
 */
function countChunk(root) {
  const types = Object.create(null);
  const cats = Object.create(null);
  let count = 0, cost = 0;
  for (const e of entitiesOf(root)) {
    if (!e || typeof e !== 'object') continue;
    const id = bare(e.id);
    if (!id) continue;
    types[id] = (types[id] || 0) + 1;
    const c = classify(id);
    cats[c] = (cats[c] || 0) + 1;
    count++;
    cost += COST[c] || COST.other;
  }
  return { types, cats, count, cost: Math.round(cost * 10) / 10 };
}

/**
 * **纯函数**：把逐区块统计聚合成全局视图。
 * @param {Array<{cx:number, cz:number, types:object, cats:object, count:number, cost:number, dim?:string}>} chunks
 * @param {{top?:number}} [opts]
 * @returns {{chunks:number, total:number, cost:number, byType:Array<{id:string,count:number,category:string,cost:number}>,
 *   byCategory:Array<{key:string,label:string,count:number,cost:number}>, hot:Array<object>,
 *   nonEmpty:number, maxCount:number}}
 */
function summarize(chunks, opts) {
  const top = Math.max(1, (opts && opts.top) || TH.top);
  const list = Array.isArray(chunks) ? chunks : [];
  const byType = Object.create(null);
  const byCat = Object.create(null);
  let total = 0, cost = 0, maxCount = 0, nonEmpty = 0;

  for (const c of list) {
    const n = c && Number(c.count) || 0;
    if (n > 0) nonEmpty++;
    if (n > maxCount) maxCount = n;
    total += n;
    cost += (c && Number(c.cost)) || 0;
    const types = (c && c.types) || {};
    for (const id of Object.keys(types)) {
      byType[id] = (byType[id] || 0) + types[id];
    }
    const cats = (c && c.cats) || {};
    for (const k of Object.keys(cats)) {
      byCat[k] = (byCat[k] || 0) + cats[k];
    }
  }

  const typeArr = Object.keys(byType).map(id => ({
    id, count: byType[id], category: classify(id), cost: Math.round(costOf(id) * byType[id] * 10) / 10
  })).sort((a, b) => b.cost - a.cost || b.count - a.count);

  const catArr = Object.keys(byCat).map(k => ({
    key: k, label: CATEGORY_ZH[k] || k, count: byCat[k],
    cost: Math.round((COST[k] || COST.other) * byCat[k] * 10) / 10
  })).sort((a, b) => b.cost - a.cost);

  const hot = list.slice()
    .filter(c => c && Number(c.count) > 0)
    .sort((a, b) => (b.cost - a.cost) || (b.count - a.count))
    .slice(0, top)
    .map(c => ({
      cx: c.cx, cz: c.cz, count: c.count, cost: c.cost, dim: c.dim || null,
      types: Object.keys(c.types || {})
        .map(id => ({ id, count: c.types[id], cost: Math.round(costOf(id) * c.types[id] * 10) / 10 }))
        .sort((a, b) => b.cost - a.cost || b.count - a.count)
    }));

  return {
    chunks: list.length,
    nonEmpty,
    total,
    cost: Math.round(cost * 10) / 10,
    maxCount,
    byType: typeArr,
    byCategory: catArr,
    hot
  };
}

/**
 * **纯函数**：根据汇总结果产出建议。
 * @param {{hot:Array<object>, total:number, cost:number, byCategory:Array<object>}} sum
 * @param {{th?:object}} [opts]
 * @returns {{findings:Array<object>, hasError:boolean, score:number, grade:string}}
 */
function suggest(sum, opts) {
  const th = Object.assign({}, TH, (opts && opts.th) || {});
  const findings = [];
  // `sum` 是外部传进来的一坨汇总数据，字段很多且随时会加 -> 用 any 承接，
  // 否则 checkJs 会把它推成 {}，每读一个字段就报一次 TS2339
  const s = /** @type {any} */ (sum || {});
  const hot = Array.isArray(s.hot) ? s.hot : [];

  const push = (severity, code, title, detail, advice, where) => {
    findings.push({ severity, code, title, detail, advice, where: where || null });
  };

  /** 单区块实体总数 */
  for (const c of hot) {
    const at = `(${c.cx},${c.cz})`;
    if (c.count >= th.chunkEntitiesError) {
      push('error', 'CHUNK_FLOOD', '区块实体严重超量',
        `${at} 有 ${c.count} 个实体，成本 ${c.cost}。`,
        '区块在被加载时这些实体都要参与 tick，实体太多会直接表现为卡顿。建议清理该区块或降低刷怪/收集装置产出。',
        c);
    } else if (c.count >= th.chunkEntities) {
      push('warn', 'CHUNK_DENSE', '区块实体偏多',
        `${at} 有 ${c.count} 个实体，成本 ${c.cost}。`,
        '尚未到危险程度，但已高于常见水平，值得留意。', c);
    }
    if (c.cost >= th.chunkCost) {
      push('warn', 'CHUNK_COST', '区块 tick 成本偏高',
        `${at} 的加权成本为 ${c.cost}，主要来自 ${(c.types[0] && c.types[0].id) || '未知'}。`,
        '成本高不等于数量多 —— 少数高成本实体（村民、生物）比大量掉落物更拖累性能。', c);
    }

    const top = c.types || [];
    for (const it of top) {
      if (it.count >= th.sameType) {
        push(it.id === 'item' ? 'warn' : 'info', 'TYPE_PILE', `${it.id} 单区块堆积`,
          `${at} 有 ${it.count} 个 ${it.id}。`,
          it.id === 'item'
            ? '掉落物过多通常是漏斗/收集系统堵塞或掉落物没被清理，可用下方指令清理。'
            : '同类实体大量聚集，常见于刷怪塔或 Farms，若不需要可清理。', c);
      }
      if (it.id === 'item' && it.count >= th.items) {
        push('warn', 'ITEM_PILE', '掉落物堆积',
          `${at} 有 ${it.count} 个掉落物。`,
          '掉落物会互相做合并检查，数量大时开销明显。建议清理或检查收集装置。', c);
      }
      if (it.id === 'experience_orb' && it.count >= th.xp) {
        push('warn', 'XP_PILE', '经验球堆积',
          `${at} 有 ${it.count} 个经验球。`,
          '经验球数量大时开销明显（且会持续向玩家吸附）。可清理。', c);
      }
      if ((it.id === 'villager' || it.id === 'wandering_trader') && it.count >= th.villagers) {
        push('warn', 'VILLAGER_CROWD', '村民聚集',
          `${at} 有 ${it.count} 个村民。`,
          '村民 AI 与日程系统是游戏里最贵的实体行为之一，大量聚集（交易大厅）会明显掉帧。建议隔离或减少数量。', c);
      }
    }
  }

  if (Number(s.total) >= th.totalEntities) {
    push('info', 'TOTAL_HIGH', '全存档实体总量偏大',
      `共 ${s.total} 个实体，加权成本 ${s.cost}。`,
      '总量大不一定卡 —— 关键在于它们是否集中在少数常加载区块。优先看下面的热区块列表。', null);
  }

  const cats = Array.isArray(s.byCategory) ? s.byCategory : [];
  const itemCat = cats.find(c => c.key === 'item');
  if (itemCat && itemCat.count >= th.items * 3) {
    push('info', 'ITEM_GLOBAL', '掉落物是主要负担',
      `全存档有 ${itemCat.count} 个掉落物。`,
      '如果常驻区块里掉落物很多，优先处理它们 —— 成本低但数量容易失控。', null);
  }

  findings.sort((a, b) => (SEV_ORDER[a.severity] - SEV_ORDER[b.severity]));

  let penalty = 0;
  for (const f of findings) penalty += SEV_PENALTY[f.severity] || 0;
  const score = Math.max(0, Math.min(100, 100 - penalty));
  const grade = score >= 90 ? 'good' : score >= 70 ? 'fair' : score >= 40 ? 'poor' : 'bad';
  const hasError = findings.some(f => f.severity === 'error');

  return { findings, hasError, score, grade };
}

/**
 * **纯函数**：生成逐区块的清理指令（文本，需用户自行复核后执行）。
 * 区块 (cx,cz) 覆盖的世界坐标范围是 x ∈ [cx*16, cx*16+16)，z 同理。
 * @param {{hot:Array<object>}} sum
 * @param {{max?:number, y?:number}} [opts]
 * @returns {Array<{cx:number, cz:number, label:string, cmd:string, count:number}>}
 */
function commands(sum, opts) {
  const max = Math.max(1, (opts && opts.max) || 5);
  const y = (opts && opts.y) || -64;
  const hot = (sum && sum.hot) || [];
  const out = [];
  for (const c of hot.slice(0, max)) {
    const pick = (c.types || [])[0];
    if (!pick) continue;
    const x1 = c.cx * 16;
    const z1 = c.cz * 16;
    const cmd = `/kill @e[type=minecraft:${pick.id},x=${x1},y=${y},z=${z1},dx=16,dy=384,dz=16]`;
    out.push({
      cx: c.cx, cz: c.cz, count: c.count,
      label: `区块 (${c.cx},${c.cz})　清理 ${pick.count} 个 ${pick.id}`,
      cmd
    });
  }
  return out;
}

/**
 * **纯函数**：生成纯文本报告。
 * @param {object} analysis analyze() 的返回值
 * @returns {string}
 */
function report(analysis) {
  const a = analysis || {};
  const sum = a.summary || {};
  const lines = [];
  lines.push('Pebble Lunchar · 实体清理报告');
  lines.push('存档：' + (a.name || a.saveDir || '(未知)'));
  lines.push('时间：' + new Date().toISOString());
  lines.push('');
  lines.push('—— 总览 ——');
  lines.push(`区块总数        ${sum.chunks || 0}（含实体的 ${sum.nonEmpty || 0}）`);
  lines.push(`实体总数        ${sum.total || 0}`);
  lines.push(`加权成本        ${sum.cost || 0}`);
  lines.push(`最挤的单区块    ${sum.maxCount || 0} 个实体`);
  lines.push('');
  lines.push('—— 按类别 ——');
  for (const c of (sum.byCategory || [])) {
    lines.push(`  ${c.label.padEnd(8, '　')} ${String(c.count).padStart(6)} 个   成本 ${c.cost}`);
  }
  lines.push('');
  lines.push('—— 实体类型 Top 15 ——');
  for (const t of (sum.byType || []).slice(0, 15)) {
    lines.push(`  ${t.id.padEnd(28)} ${String(t.count).padStart(6)} 个   成本 ${t.cost}`);
  }
  lines.push('');
  lines.push('—— 成本最高的区块 Top 10 ——');
  for (const c of (sum.hot || []).slice(0, 10)) {
    const head = (c.types || []).slice(0, 3).map(t => `${t.id}×${t.count}`).join(', ');
    lines.push(`  (${c.cx},${c.cz})  共 ${c.count} 个  成本 ${c.cost}   主要是 ${head}`);
  }
  lines.push('');
  lines.push(`—— 建议（评分 ${a.score === undefined ? '-' : a.score} / ${a.grade || '-'}）——`);
  const fs = a.findings || [];
  if (!fs.length) lines.push('  没有发现需要处理的问题。');
  for (const f of fs) {
    lines.push(`  [${f.severity.toUpperCase()}] ${f.title}`);
    lines.push(`      ${f.detail}`);
    lines.push(`      → ${f.advice}`);
  }
  lines.push('');
  lines.push('—— 清理指令（请自行核对坐标后再执行，不可撤销）——');
  const cmds = a.commands || [];
  if (!cmds.length) lines.push('  无。');
  for (const c of cmds) {
    lines.push('  # ' + c.label);
    lines.push('  ' + c.cmd);
  }
  lines.push('');
  lines.push('说明：加权成本是启发式估算，用于排序，不代表 Minecraft 的真实 tick 开销。');
  return lines.join('\n');
}

/* ================= 读盘部分 ================= */

/**
 * 扫描一个维度的实体，按区块聚合。
 *
 * region 与 entities/ 两个来源都扫，**同一区块以 entities/ 为准**（1.18+ 实体独立成文件，
 * region 里的 Level.Entities 通常为空；1.17 及以前没有 entities/ 目录，只有 region 有数据）。
 *
 * @param {{saveDir:string, dim?:string, onProgress?:(done:number,total:number)=>void}} o
 * @returns {Promise<{dim:string, chunks:Array<object>, missing:boolean, files:number, broken:number}>}
 */
async function scanDim(o) {
  const saveDir = o.saveDir;
  const dim = o.dim || 'overworld';
  const regionMap = new Map();
  const entityMap = new Map();
  let files = 0, broken = 0;

  const collect = async (kind, target) => {
    const r = await anvil.scanSaveChunks({
      saveDir, dim, kind,
      onProgress: o.onProgress,
      onChunk: (key, raw) => {
        let root;
        try { root = nbt.parse(raw).value; } catch { broken++; return; }
        const parts = String(key).split(',');
        const cx = parseInt(parts[0], 10);
        const cz = parseInt(parts[1], 10);
        if (!Number.isFinite(cx) || !Number.isFinite(cz)) return;
        const c = countChunk(root);
        target.set(key, { cx, cz, types: c.types, cats: c.cats, count: c.count, cost: c.cost, dim });
      }
    });
    files += (r && r.files) || 0;
    broken += (r && r.broken) || 0;
    return r;
  };

  const rr = await collect(anvil.KIND.REGION, regionMap);
  const re = await collect(anvil.KIND.ENTITIES, entityMap);

  const chunks = [];
  const keys = new Set([...regionMap.keys(), ...entityMap.keys()]);
  for (const k of keys) {
    const pick = entityMap.has(k) ? entityMap.get(k) : regionMap.get(k);
    if (pick) chunks.push(pick);
  }

  return {
    dim,
    chunks,
    missing: Boolean(rr && rr.missing) && Boolean(re && re.missing),
    files,
    broken
  };
}

/**
 * 分析一个存档的实体分布。
 * @param {{saveDir:string, name?:string, dims?:string[],
 *          onProgress?:(done:number,total:number)=>void, top?:number, th?:object}} o
 * @returns {Promise<object>} 见 `report()` 里用到的字段
 */
async function analyze(o) {
  const saveDir = o.saveDir;
  const dims = (o.dims && o.dims.length) ? o.dims : ['overworld', 'nether', 'end'];
  const all = [];
  const perDim = [];
  let broken = 0;

  for (const d of dims) {
    const r = await scanDim({ saveDir, dim: d, onProgress: o.onProgress });
    broken += r.broken;
    perDim.push({ dim: d, chunks: r.chunks.length, total: r.chunks.reduce((s, c) => s + c.count, 0), missing: r.missing });
    for (const c of r.chunks) all.push(c);
  }

  const summary = summarize(all, { top: o.top });
  const s = suggest(summary, { th: o.th });

  return {
    ok: true,
    saveDir,
    name: o.name || saveDir,
    dims: perDim,
    broken,
    summary,
    findings: s.findings,
    hasError: s.hasError,
    score: s.score,
    grade: s.grade,
    commands: commands(summary, {})
  };
}

module.exports = {
  SEV_ORDER, SEV_PENALTY, CATEGORY, CATEGORY_ZH, COST, TH,
  PROJECTILE, HOSTILE, PASSIVE,
  bare, classify, costOf, entitiesOf,
  countChunk, summarize, suggest, commands, report,
  scanDim, analyze
};
