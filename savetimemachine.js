// Pebble Lunchar - 存档时光机
//
// 与 PCL2 / HMCL / Prism 的关键差异：它们的"备份"都是**全量拷贝**，
// 一个 1GB 的存档存 20 份就是 20GB。这里做**内容寻址的块级增量去重**：
//   把每个文件切成 1MB 的块，按 SHA1 存进块库；相同内容的块只存一份。
//   MC 的 region 文件每次只改动少量区块，所以第 2 次之后的快照往往只增加几 MB。
// 于是可以做到：每次启动游戏前都自动打快照，而空间开销几乎可以忽略。
//
// 目录结构：
//   <storeDir>/chunks/<hash前2位>/<hash>   块库（内容寻址）
//   <storeDir>/snapshots/<id>.json         快照清单
//
// 纯本地、无网络、零成本。

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const nbt = require('./nbt');
const anvil = require('./anvil');

const CHUNK_SIZE = 1024 * 1024; // 1MB 块
const SKIP_FILES = new Set(['session.lock']); // 游戏运行时锁定文件，快照无意义

function sha1(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }
const chunksDir = (store) => path.join(store, 'chunks');
const snapsDir = (store) => path.join(store, 'snapshots');

function ensure(store) {
  fs.mkdirSync(chunksDir(store), { recursive: true });
  fs.mkdirSync(snapsDir(store), { recursive: true });
}

function walk(dir, base, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(base, abs);
    if (e.isDirectory()) walk(abs, base, out);
    else if (!SKIP_FILES.has(e.name)) out.push(rel);
  }
}

function putChunk(store, buf) {
  const h = sha1(buf);
  const p = path.join(chunksDir(store), h.slice(0, 2), h);
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
    return { hash: h, isNew: true };
  }
  return { hash: h, isNew: false };
}

function getChunk(store, h) {
  return fs.readFileSync(path.join(chunksDir(store), h.slice(0, 2), h));
}

function snapPath(store, id) { return path.join(snapsDir(store), id + '.json'); }

function newId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ---------- 创建快照 ---------- */
/**
 * @param {object} o
 * @param {string} o.saveDir
 * @param {string} o.storeDir
 * @param {string} [o.label]
 * @param {boolean} [o.auto]
 * @param {string} [o.world]
 * @param {(done:number, total:number)=>void} [o.onProgress]
 */
async function createSnapshot({ saveDir, storeDir, label, auto, world, onProgress }) {
  if (!saveDir || !fs.existsSync(saveDir)) throw new Error('目录不存在: ' + saveDir);
  ensure(storeDir);

  const files = [];
  walk(saveDir, saveDir, files);

  const mf = {
    id: newId(),
    time: Date.now(),
    world: world || path.basename(saveDir), // 允许调用方指定命名空间（例如 Mod 快照用 "mods:<实例名>"）
    label: label || (auto ? '自动快照' : '手动快照'),
    auto: !!auto,
    files: [],
    totalSize: 0,
    newBytes: 0,      // 本次真正写入磁盘的字节（去重后）
    fileCount: 0
  };

  let done = 0;
  for (const rel of files) {
    const abs = path.join(saveDir, rel);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (!st.isFile()) continue;

    const chunks = [];
    const size = st.size;
    const fd = fs.openSync(abs, 'r');
    try {
      let off = 0;
      let since = 0;
      while (off < size) {
        const len = Math.min(CHUNK_SIZE, size - off);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, off);
        const { hash, isNew } = putChunk(storeDir, buf);
        if (isNew) mf.newBytes += len;
        chunks.push(hash);
        off += len;
        // 大文件（几百 MB 的 region）要分片让出事件循环，否则整个主进程会卡死
        if (++since >= 16) { since = 0; await new Promise((r) => setImmediate(r)); }
      }
    } finally { fs.closeSync(fd); }

    mf.files.push({ p: rel, size, chunks });
    mf.totalSize += size;
    mf.fileCount++;
    if (++done % 20 === 0) await new Promise((r) => setImmediate(r)); // 让出事件循环
    if (onProgress) onProgress(done, files.length);
  }

  // id 可能重复（同一秒内），加后缀
  let id = mf.id;
  let n = 1;
  while (fs.existsSync(snapPath(storeDir, id))) id = mf.id + '-' + (++n);
  mf.id = id;

  fs.writeFileSync(snapPath(storeDir, id), JSON.stringify(mf));
  return mf;
}

/* ---------- 列出快照 ---------- */
/**
 * @param {object} o
 * @param {string} o.storeDir
 * @param {string} [o.world] 只列出该世界的快照
 */
function listSnapshots({ storeDir, world }) {
  if (!storeDir || !fs.existsSync(snapsDir(storeDir))) return [];
  const out = [];
  for (const f of fs.readdirSync(snapsDir(storeDir))) {
    if (!f.endsWith('.json')) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(snapsDir(storeDir), f), 'utf8'));
      if (world && m.world !== world) continue;
      out.push(m);
    } catch {}
  }
  return out.sort((a, b) => b.time - a.time);
}

function readSnapshot(storeDir, id) {
  const p = snapPath(storeDir, id);
  if (!fs.existsSync(p)) throw new Error('快照不存在: ' + id);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/* ---------- 恢复到某个快照 ---------- */
async function restoreSnapshot({ saveDir, storeDir, id }) {
  const mf = readSnapshot(storeDir, id);
  // 回滚前先给当前状态打个安全快照 —— 让"回滚"本身也可撤销
  const safety = await createSnapshot({ saveDir, storeDir, label: '回滚前自动备份', auto: true, world: mf.world });

  // 清空当前存档内容（保留目录本身）
  for (const e of fs.readdirSync(saveDir)) {
    const p = path.join(saveDir, e);
    try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
  // 写入快照内容
  for (const f of mf.files) {
    const abs = path.join(saveDir, f.p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (!f.chunks.length) { fs.writeFileSync(abs, Buffer.alloc(0)); continue; }
    fs.writeFileSync(abs, Buffer.concat(f.chunks.map((h) => getChunk(storeDir, h))));
  }
  return { ok: true, restored: mf.id, safety: safety.id };
}

/* ---------- 删除快照 + 垃圾回收 ---------- */
function deleteSnapshot({ storeDir, id }) {
  const p = snapPath(storeDir, id);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  return { ok: true };
}

/** 删除没有任何快照引用的块（在删除快照后调用） */
function gc({ storeDir }) {
  const used = new Set();
  for (const m of listSnapshots({ storeDir })) {
    for (const f of m.files) for (const h of f.chunks) used.add(h);
  }
  let removed = 0, freed = 0;
  const base = chunksDir(storeDir);
  if (!fs.existsSync(base)) return { removed: 0, freed: 0 };
  for (const d of fs.readdirSync(base)) {
    const dd = path.join(base, d);
    for (const f of fs.readdirSync(dd)) {
      if (used.has(f)) continue;
      const p = path.join(dd, f);
      try { freed += fs.statSync(p).size; fs.unlinkSync(p); removed++; } catch {}
    }
  }
  return { removed, freed };
}

/** 只保留最近 N 个自动快照（手动快照永远保留） */
function pruneAuto({ storeDir, world, keep = 10 }) {
  const list = listSnapshots({ storeDir, world }).filter((s) => s.auto && s.label !== '回滚前自动备份');
  const drop = list.slice(keep);
  for (const s of drop) deleteSnapshot({ storeDir, id: s.id });
  return { removed: drop.length };
}

function stats({ storeDir, world }) {
  const list = listSnapshots({ storeDir, world });
  const logical = list.reduce((a, s) => a + (s.totalSize || 0), 0);
  let physical = 0;
  const base = chunksDir(storeDir);
  if (fs.existsSync(base)) {
    for (const d of fs.readdirSync(base)) {
      for (const f of fs.readdirSync(path.join(base, d))) {
        try { physical += fs.statSync(path.join(base, d, f)).size; } catch {}
      }
    }
  }
  return {
    count: list.length,
    logical,
    physical,
    ratio: physical ? (logical / physical) : 1
  };
}

/* ================= 存档健康检查 ================= */
// 扫描 region 文件：定位损坏区块、超大区块，并统计每个区块的实体数找到 lag 源头。
// 这是 PCL2 / HMCL / Prism 都没有的能力（通常只能靠外部工具 Region Fixer）。

// 只跳读不建树的实体计数在 ./nbt 里（此前这里有一份重复实现）。
// 注意不能用 mcapi.parseNBT —— 它把根结构硬编码成 level.dat 字段，读区块会得到错误结果。
function countEntitiesInChunk(buf) {
  try { return nbt.countEntities(buf); } catch { return 0; }
}

/** 压缩类型的可读名字，用来把「为什么坏」讲清楚 */
function compName(comp) {
  if (comp === anvil.COMP.ZLIB) return 'zlib';
  if (comp === anvil.COMP.GZIP) return 'gzip';
  if (comp === anvil.COMP.NONE) return 'raw';
  if (comp === anvil.COMP.LZ4) return 'lz4';
  return '类型' + comp;
}

/**
 * 扫描一个 .mca 文件。
 *
 * region 的头部解析与负载边界判断**全部下放到 ./anvil**（此前这里有一份重复实现，
 * 和 anvil 是同一套字节运算写两遍）。本函数现在只负责一件事：
 * 把探测结果翻译成给玩家看的健康报告。
 *
 * @param {string} file
 * @param {number} [entityThreshold]
 * @returns {{file:string, chunks:number, bad:number, corrupt:Array, hotspots:Array,
 *            oversize:Array, ok:boolean, entityTotal:number}}
 */
function scanRegion(file, entityThreshold = 100) {
  // chunks = 成功解压并读取的区块数；bad = 损坏/越界的区块数。两者不混在一起，
  // 否则 UI 上"有效区块"会把坏块也算进去，看起来像一切正常。
  const res = { file: path.basename(file), chunks: 0, bad: 0, corrupt: [], hotspots: [], oversize: [], ok: true, entityTotal: 0 };
  let buf;
  try { buf = fs.readFileSync(file); } catch { res.ok = false; return res; }
  if (buf.length < anvil.HEADER_BYTES) { res.ok = false; return res; }

  const rc = anvil.parseRegionName(path.basename(file));
  const rx = rc ? rc.rx : 0;
  const rz = rc ? rc.rz : 0;

  const { entries } = anvil.parseHeader(buf);
  for (let i = 0; i < anvil.CHUNKS_PER_REGION; i++) {
    const e = entries[i];
    if (e.empty) continue;
    const cx = rx * anvil.SIDE + (i % anvil.SIDE);
    const cz = rz * anvil.SIDE + Math.floor(i / anvil.SIDE);

    const ins = anvil.inspectEntry(buf, e);
    if (!ins.ok) {
      res.bad++;
      res.corrupt.push({ i, cx, cz, reason: ins.reason });
      res.ok = false;
      continue;
    }

    let raw;
    try { raw = anvil.decompress(ins.payload.slice(5), ins.comp); }
    catch {
      res.bad++;
      res.corrupt.push({ i, cx, cz, reason: '解压失败(' + compName(ins.comp) + ')' });
      res.ok = false;
      continue;
    }
    res.chunks++;

    // 超大区块（异常 NBT，可能导致读取卡顿）
    if (raw.length > 1024 * 1024) {
      res.oversize.push({ cx, cz, bytes: raw.length });
    }
    // 实体统计（找 lag 源头）
    try {
      const n = countEntitiesInChunk(raw);
      if (n > 0) res.entityTotal += n;
      if (n >= entityThreshold) res.hotspots.push({ cx, cz, entities: n });
    } catch {}
  }
  res.hotspots.sort((a, b) => b.entities - a.entities);
  return res;
}

/** 对整个存档做健康检查（主世界 + 下界 + 末地） */
function healthCheck({ saveDir, entityThreshold = 100 }) {
  // 1.18+ 把实体数据从区块里拆到了独立的 entities/ 目录，两个都要扫
  const groups = [
    { name: '主世界', roots: [saveDir] },
    { name: '下界', roots: [path.join(saveDir, 'DIM-1')] },
    { name: '末地', roots: [path.join(saveDir, 'DIM1')] }
  ];
  const kinds = [
    { key: 'region', label: '区块' },
    { key: 'entities', label: '实体' }
  ];

  const out = {
    ok: true, regions: [], corrupt: [], hotspots: [], oversize: [],
    chunkTotal: 0, badTotal: 0, scannedFiles: 0, entityTotal: 0
  };

  for (const g of groups) {
    for (const root of g.roots) {
      for (const k of kinds) {
        const dir = path.join(root, k.key);
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mca'));
        for (const f of files) {
          const r = scanRegion(path.join(dir, f), entityThreshold);
          out.scannedFiles++;
          out.chunkTotal += r.chunks;
          out.badTotal += r.bad || 0;
          out.entityTotal += r.entityTotal || 0;
          if (!r.ok) out.ok = false;
          const tag = { dim: g.name, kind: k.label, file: r.file };
          for (const c of r.corrupt) out.corrupt.push(Object.assign({}, tag, c));
          for (const h of r.hotspots) if (h.entities >= entityThreshold) out.hotspots.push(Object.assign({}, tag, h));
          for (const o of r.oversize) out.oversize.push(Object.assign({}, tag, o));
          out.regions.push(Object.assign({}, tag, { chunks: r.chunks, ok: r.ok }));
        }
      }
    }
  }
  out.hotspots.sort((a, b) => b.entities - a.entities);
  return out;
}

module.exports = {
  createSnapshot, listSnapshots, readSnapshot, restoreSnapshot,
  deleteSnapshot, gc, pruneAuto, stats, healthCheck, scanRegion
};
