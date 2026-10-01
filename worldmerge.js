// Pebble Lunchar - 世界合并与建筑移植（V4 第一组）
//
// 场景：创造存档里搭好的城堡搬进生存存档；1.12 里调好的红石机器搬到 1.20 继续用；
//       把朋友存档里的一整片地形切过来当新地图。
//
// 为什么必须分成「干跑」和「执行」两步：
//   这个工具出错时覆盖掉的是玩家几百小时的世界，代价极高。所以 plan() 只读不写，
//   把"要动哪些区块、会覆盖掉什么、目标里有几处冲突"全摊开给人看；
//   apply() 才真正落盘，而且落盘前自动打时光机快照、每个 region 文件再留 .bak。
//
// ⚠️ 两个必须讲清楚的限制（不讲清楚用户会以为能搬"半个区块"）：
//   1. **区块是最小搬运单位**。给的是方块坐标矩形，实际按区块向外吸附 ——
//      要搬 x=20..40，落地的其实是 x=16..47（两个区块）。边角一定会多带一点。
//   2. **垂直方向是整列**（0~320），不做 y 范围裁剪。区块里的方块是长在一起的：
//      光照、高度图、方块实体、生物群系全挂在同一个 chunk 上，只搬一段 y 必然把
//      存档搞坏。想只搬一部分，请先在游戏里用结构方块或 WorldEdit 裁好。
//
// @module worldmerge

const fs = require('fs');
const path = require('path');
const anvil = require('./anvil');
const nbt = require('./nbt');

/** 一次能搬的区块数上限。32768 = 128×128 区块 = 2048×2048 方块，已经远超"搬个建筑"。 */
const MAX_CHUNKS = 32768;
/** 超过这个数就提醒一句 —— 多半是把"整张地图"当"一栋房子"选了 */
const WARN_CHUNKS = 4096;
/** 实体热点阈值：单区块实体数超过它，就在计划里标出来 */
const ENTITY_THRESHOLD = 100;
/** 单批写入的堆内存预算 */
const PUT_BUDGET = 32 * 1024 * 1024;

/**
 * 方块坐标矩形 → 区块盒子（向外吸附到区块边界）
 * @param {{x1:number,z1:number,x2:number,z2:number}} o
 * @returns {{cx1:number,cz1:number,cx2:number,cz2:number,chunks:number,
 *            block:{x1:number,z1:number,x2:number,z2:number}, aligned:boolean}}
 */
function chunkBox(o) {
  const px1 = Math.min(Number(o.x1), Number(o.x2));
  const px2 = Math.max(Number(o.x1), Number(o.x2));
  const pz1 = Math.min(Number(o.z1), Number(o.z2));
  const pz2 = Math.max(Number(o.z1), Number(o.z2));
  if (![px1, px2, pz1, pz2].every(Number.isFinite)) throw new Error('区域坐标必须是数字');
  const cx1 = Math.floor(px1 / 16);
  const cz1 = Math.floor(pz1 / 16);
  const cx2 = Math.floor(px2 / 16);
  const cz2 = Math.floor(pz2 / 16);
  const bx1 = cx1 * 16;
  const bz1 = cz1 * 16;
  const bx2 = (cx2 + 1) * 16 - 1;
  const bz2 = (cz2 + 1) * 16 - 1;
  return {
    cx1, cz1, cx2, cz2,
    chunks: (cx2 - cx1 + 1) * (cz2 - cz1 + 1),
    block: { x1: bx1, z1: bz1, x2: bx2, z2: bz2 },
    aligned: bx1 === px1 && bz1 === pz1 && bx2 === px2 && bz2 === pz2
  };
}

/** 把区块盒子里涉及到的 region 文件分组列出来（一次只处理一个文件，控制内存） */
function regionsInBox(box) {
  const groups = new Map();
  for (let cx = box.cx1; cx <= box.cx2; cx++) {
    for (let cz = box.cz1; cz <= box.cz2; cz++) {
      const { rx, rz } = anvil.regionOf(cx, cz);
      const key = rx + ',' + rz;
      let g = groups.get(key);
      if (!g) { g = { rx, rz, keys: [] }; groups.set(key, g); }
      g.keys.push({ cx, cz });
    }
  }
  return [...groups.values()];
}

/**
 * 读一个 region 文件里盒子里那些区块。
 * 自己做而不是复用 scanSaveChunks：后者扫整个存档（几千个 region），
 * 而搬一栋房子只涉及几个文件，扫全库纯属浪费时间。
 * @returns {{map: Map<string, {raw:Buffer, hash:string, bytes:number, entities:number}>,
 *            exists:boolean, broken:number}}
 */
function readRegionBox(file, keys, withEntities) {
  /** @type {Map<string, {raw:Buffer, hash:string, bytes:number, entities:number}>} */
  const map = new Map();
  let broken = 0;
  const buf = anvil.readRegionFile(file);
  if (!buf) return { map, exists: false, broken: 0 };
  for (const { cx, cz } of keys) {
    let r;
    try { r = anvil.readRaw(buf, cx, cz); } catch { broken++; continue; }
    if (!r) continue;
    const raw = r.data;
    const rec = { raw, hash: anvil.hashOf(raw), bytes: raw.length, entities: 0 };
    if (withEntities) { try { rec.entities = nbt.countEntities(raw); } catch {} }
    map.set(cx + ',' + cz, rec);
  }
  return { map, exists: true, broken };
}

function regionFileOf(saveDir, dim, kind, rx, rz) {
  return path.join(anvil.dataDir(saveDir, dim, kind), anvil.regionFile(rx, rz));
}

/**
 * 干跑：算清楚这次搬运会做什么，**只读不写**。
 *
 * @param {{from:string, to:string, dim?:string, kind?:string, x1:number, z1:number,
 *          x2:number, z2:number, mode?:'replace'|'skip-existing',
 *          syncEntities?:boolean, entityThreshold?:number}} o
 * @returns {Promise<object>} 计划书
 */
async function plan(o) {
  if (!o.from || !o.to) throw new Error('必须同时给出源存档 from 和目标存档 to');
  if (path.resolve(o.from) === path.resolve(o.to)) throw new Error('源存档和目标存档是同一个目录');
  if (!fs.existsSync(o.from)) throw new Error('源存档不存在: ' + o.from);
  if (!fs.existsSync(o.to)) throw new Error('目标存档不存在: ' + o.to);

  const dim = o.dim || 'overworld';
  const mode = o.mode === 'skip-existing' ? 'skip-existing' : 'replace';
  const syncEntities = o.syncEntities !== false;
  const threshold = o.entityThreshold || ENTITY_THRESHOLD;
  const box = chunkBox(o);
  if (box.chunks > MAX_CHUNKS) {
    throw new Error('一次最多搬 ' + MAX_CHUNKS + ' 个区块（本次 ' + box.chunks + ' 个），请缩小范围');
  }

  const out = {
    ok: false,
    from: o.from, to: o.to, dim, dimLabel: anvil.dimInfo(dim).label,
    mode, syncEntities, box,
    source: { present: 0, missing: 0, bytes: 0, entities: 0, files: 0, broken: 0, missingSample: [] },
    target: { create: 0, same: 0, conflict: 0, entities: 0, files: 0 },
    write: { chunks: 0, same: 0, skipped: 0, entityWrite: 0, entityDelete: 0 },
    conflictsSample: [],
    hotspots: [],
    warnings: []
  };

  for (const g of regionsInBox(box)) {
    const sFile = regionFileOf(o.from, dim, 'region', g.rx, g.rz);
    const dFile = regionFileOf(o.to, dim, 'region', g.rx, g.rz);
    const s = readRegionBox(sFile, g.keys, true);
    const d = readRegionBox(dFile, g.keys, false);
    if (s.exists) out.source.files++;
    if (d.exists) out.target.files++;
    out.source.broken += s.broken;

    const sEnt = syncEntities
      ? readRegionBox(regionFileOf(o.from, dim, 'entities', g.rx, g.rz), g.keys, false).map
      : new Map();
    const dEnt = syncEntities
      ? readRegionBox(regionFileOf(o.to, dim, 'entities', g.rx, g.rz), g.keys, false).map
      : new Map();

    for (const { cx, cz } of g.keys) {
      const key = cx + ',' + cz;
      const src = s.map.get(key);
      if (!src) {
        out.source.missing++;
        if (out.source.missingSample.length < 200) out.source.missingSample.push(key);
        continue;
      }
      out.source.present++;
      out.source.bytes += src.bytes;
      out.source.entities += src.entities;
      if (src.entities >= threshold) out.hotspots.push({ cx, cz, entities: src.entities });

      const dst = d.map.get(key);
      if (!dst) out.target.create++;
      else if (dst.hash === src.hash) out.target.same++;
      else {
        out.target.conflict++;
        if (out.conflictsSample.length < 200) {
          out.conflictsSample.push({ cx, cz, targetEntities: dst.entities, sourceEntities: src.entities });
        }
      }

      // 区块与实体**两边都相同**才算"没什么可做"。只看区块会让"区块没变但实体变了"
      // 被误判成无需处理，那正是搬运最该修的一种脏数据。
      const sameRegion = !!dst && dst.hash === src.hash;
      const sameEnt = syncEntities ? (sEnt.has(key) ? !!(dEnt.has(key) && dEnt.get(key).hash === sEnt.get(key).hash) : !dEnt.has(key)) : true;
      if (sameRegion && sameEnt) { out.write.same++; continue; }

      // 目标已经有内容、又要求不覆盖 → 这个区块整块跳过（连实体也不动它）
      if (dst && mode === 'skip-existing') { out.write.skipped++; continue; }
      out.write.chunks++;
      // 实体跟着区块走：源里有就写过去，源里没有而目标里有就删掉
      // （不然新搬来的城堡里会残留目标存档原有的生物和掉落物）
      if (syncEntities) {
        if (sEnt.has(key)) out.write.entityWrite++;
        else if (dEnt.has(key)) out.write.entityDelete++;
      }
      out.target.entities += dEnt.has(key) ? 1 : 0;
    }
  }

  out.hotspots.sort((a, b) => b.entities - a.entities);
  out.hotspots = out.hotspots.slice(0, 100);
  out.ok = out.write.chunks > 0;

  if (!box.aligned) {
    out.warnings.push('给定的方块范围已按区块向外吸附到 x=' + box.block.x1 + '..' + box.block.x2 +
      '，z=' + box.block.z1 + '..' + box.block.z2 + '（区块是搬运的最小单位）');
  }
  if (out.source.missing) {
    out.warnings.push('源存档里有 ' + out.source.missing + ' 个区块是空的（未探索或未生成），这部分不会搬过去');
  }
  if (out.write.chunks > WARN_CHUNKS) {
    out.warnings.push('这次要动 ' + out.write.chunks + ' 个区块，数量偏大 —— 确认不是把整张地图当一栋房子选了吗？');
  }
  if (out.target.conflict && mode === 'replace') {
    out.warnings.push('目标存档里有 ' + out.target.conflict + ' 个区块将被覆盖，apply 前会自动打快照');
  }
  if (out.hotspots.length) {
    out.warnings.push('源存档有 ' + out.hotspots.length + ' 个区块实体数偏高（最多 ' + out.hotspots[0].entities + ' 个），搬过去可能拖慢目标存档');
  }
  if (!out.ok) {
    out.warnings.push(out.source.present
      ? '目标存档里这些区块已经和源一致，没有需要搬的内容'
      : '源存档在这个范围内一个区块都没有，没有可搬的内容');
  }
  return out;
}

/**
 * 执行搬运。
 *
 * 落盘前的三道保险：
 *   1. 给了 tmDir → 先给**目标存档**打一个时光机快照（这是唯一能整档回退的手段）；
 *   2. 每个被改动的 region 文件写回前自动留 `.bak`（anvil 的默认行为）；
 *   3. 写完复验：重扫目标，逐个比对指纹，对不上的列出来（默认严格模式直接抛错）。
 *
 * @param {{from:string, to:string, dim?:string, x1:number, z1:number, x2:number, z2:number,
 *          mode?:'replace'|'skip-existing', syncEntities?:boolean, tmDir?:string,
 *          backup?:boolean, verify?:boolean,
 *          onProgress?:(o:object)=>void}} o
 * @returns {Promise<object>}
 */
async function apply(o) {
  const p = await plan(o);
  // "没什么要搬的"不是错误：目标里这些区块已经和源一模一样了。
  // 所以不要用 ok:false 表达它 —— ok 只表示"这次操作本身顺不顺利"，
  // 否则调用方没法区分"没事干"和"失败了"。
  if (!p.write.chunks) {
    return {
      ok: true, nothingToDo: true, plan: p, safety: null,
      written: 0, deleted: 0, files: 0,
      verification: { ok: true, checked: 0, mismatched: [] }, verified: true
    };
  }

  // 1. 安全快照（打的是目标存档 —— 被改的是它）
  let safety = null;
  if (o.tmDir) {
    const tm = require('./savetimemachine');
    try {
      const s = await tm.createSnapshot({
        saveDir: o.to, storeDir: o.tmDir, label: '合并前自动快照', auto: true
      });
      safety = s.id;
    } catch { safety = null; }
  }

  const dim = p.dim;
  const mode = p.mode;
  const syncEntities = p.syncEntities;
  let written = 0;
  let deleted = 0;
  let files = 0;
  let objects = 0;
  /** 真正写过的区块（"cx,cz"）。复验只认这些 —— 见下方 verification 的说明。 */
  const writtenKeys = new Set();

  for (const g of regionsInBox(p.box)) {
    const s = readRegionBox(regionFileOf(o.from, dim, 'region', g.rx, g.rz), g.keys, false);
    const d = readRegionBox(regionFileOf(o.to, dim, 'region', g.rx, g.rz), g.keys, false);
    const sEntMap = syncEntities
      ? readRegionBox(regionFileOf(o.from, dim, 'entities', g.rx, g.rz), g.keys, false).map
      : null;
    const dEntMap = syncEntities
      ? readRegionBox(regionFileOf(o.to, dim, 'entities', g.rx, g.rz), g.keys, false).map
      : new Map();

    /** @type {Array<{cx:number,cz:number,raw:Buffer}>} */
    const puts = [];
    /** @type {Array<{cx:number,cz:number,raw:Buffer}>} */
    const entPuts = [];
    /** @type {Array<{cx:number,cz:number}>} */
    const entDels = [];
    let budget = 0;

    for (const { cx, cz } of g.keys) {
      const key = cx + ',' + cz;
      const src = s.map.get(key);
      if (!src) continue;
      const dst = d.map.get(key);
      // 目标已有内容而要求不覆盖 → 整块跳过，连它的实体也不动
      if (dst && mode === 'skip-existing') continue;

      const e = sEntMap ? sEntMap.get(key) : null;
      const de = dEntMap.get(key);
      // 区块和它的实体归同一个 key，必须**成对**判断与替换：
      // 只看区块就跳过的话，新搬来的城堡里会残留目标存档原有的生物与掉落物；
      // 反过来只看区块就写的话，又会在空地上凭空多出一堆实体。
      const sameRegion = !!dst && dst.hash === src.hash;
      const sameEnt = syncEntities ? (e ? !!(de && de.hash === e.hash) : !de) : true;
      if (sameRegion && sameEnt) continue;

      if (!sameRegion) {
        puts.push({ cx, cz, raw: src.raw });
        writtenKeys.add(key);
        budget += src.raw.length;
        objects++;
      }
      if (syncEntities) {
        if (e) { if (!(de && de.hash === e.hash)) entPuts.push({ cx, cz, raw: e.raw }); }
        else if (de) entDels.push({ cx, cz });
      }
    }

    if (puts.length) {
      const r = await anvil.applySaveChunks({
        saveDir: o.to, dim, kind: 'region', puts, dels: [], backup: o.backup !== false
      });
      written += r.written; files += r.files; deleted += r.deleted;
    }
    if (entPuts.length || entDels.length) {
      const r2 = await anvil.applySaveChunks({
        saveDir: o.to, dim, kind: 'entities', puts: entPuts, dels: entDels, backup: o.backup !== false
      });
      written += r2.written; files += r2.files; deleted += r2.deleted;
    }
    if (o.onProgress) o.onProgress({ dim, written, deleted, files, budget });
  }

  // 3. 复验：**只核对确实写过的区块**。
  //    不能拿整个盒子去对指纹 —— skip-existing 模式下被"故意跳过"的区块本来就该和源不同，
  //    那样会把一次完全正确的搬运判成失败（而且要人盯着看半天才发现是误报）。
  let verification = { ok: true, checked: 0, mismatched: [] };
  if (o.verify !== false) {
    for (const g of regionsInBox(p.box)) {
      const need = g.keys.filter((k) => writtenKeys.has(k.cx + ',' + k.cz));
      if (!need.length) continue;
      const s = readRegionBox(regionFileOf(o.from, dim, 'region', g.rx, g.rz), need, false);
      const d = readRegionBox(regionFileOf(o.to, dim, 'region', g.rx, g.rz), need, false);
      for (const { cx, cz } of need) {
        const key = cx + ',' + cz;
        const src = s.map.get(key);
        if (!src) continue;
        verification.checked++;
        const dst = d.map.get(key);
        if (!dst || dst.hash !== src.hash) {
          if (verification.mismatched.length < 200) verification.mismatched.push(key);
        }
      }
    }
    verification.ok = verification.mismatched.length === 0;
  }

  return {
    ok: verification.ok,
    nothingToDo: false,
    plan: p,
    safety,
    written, deleted, files,
    verification,
    verified: verification.ok
  };
}

module.exports = {
  MAX_CHUNKS, WARN_CHUNKS, ENTITY_THRESHOLD,
  chunkBox, regionsInBox, readRegionBox,
  plan, apply
};
