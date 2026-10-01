// Pebble Lunchar - 世界版本控制（V4 第一组）
//
// 目标：把存档当成一个**可以分支、对比、回滚的项目**，而不是一个只能整体覆盖的文件夹。
//   「想试试把主城拆了」→ 新建分支 → 改坏了直接丢弃，主线的世界毫发无损
//   「这周到底动了哪」  → 两次提交之间做区域级 diff
//   「这个区块是谁改的」→ blame 沿父提交链回溯
//
// 与 savetimemachine 的分工（两个都在，别混用）：
//   savetimemachine = **后悔药**。每次启动前自动全量打快照，只管"能退回去"，
//                     不需要知道"改了什么"。粒度是 1MB 文件块。
//   worldver        = **版本控制**。手动提交、有分支、有提交信息，能 diff / blame，
//                     粒度是**单个区块**（Anvil 的天然单位）。
//   → 想回答"改了哪些区块"，1MB 文件块的粒度不够：动一个方块也会让整个 1MB 块的指纹变。
//
// 存储布局（<storeDir>/<worldKey>/）：
//   objects/<h前2位>/<h>   区块对象库：4 字节大端未压缩长度 + deflate(未压缩 NBT)
//   commits/<id>.json      提交：只存**相对父提交的增量**，不存全量索引
//   refs.json              分支指针 { 分支名: 提交id }
//   HEAD                   当前分支名
//
// 为什么对象地址算在「未压缩 NBT 的 sha1」上，而不是文件里的字节：
//   同一个区块被游戏以不同压缩级别写回时，未压缩内容一模一样。按未压缩内容寻址，
//   才不会把"重新压过一遍"误判成一次改动。文件里存的仍是 deflate 后的字节
//   （否则第一次提交就要把整个存档按未压缩体积复制一份，约 2~3 倍膨胀），
//   只是地址算在未压缩内容上 —— 读取端默认信任自己的库，不重复校验。
//
// 为什么提交只存增量：
//   一个 2 万区块的世界，全量索引 JSON 约 1MB。每次提交都存一份 → 一百次提交就是
//   上百 MB；而且只改一个区块也会让整份索引变样，内容寻址完全兜不住。
//   改成"相对父提交的 add / del 增量"后，一次提交通常只有几 KB。
//   代价：读某个提交的完整状态要沿 parent 链回溯 —— 于是这里做了进程内 LRU 缓存。
//
// @module worldver

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const anvil = require('./anvil');

const DEFAULT_BRANCH = 'main';
const KINDS = [anvil.KIND.REGION, anvil.KIND.ENTITIES];   // region | entities
const DIM_KEYS = anvil.DIMS.map((d) => d.key);

/** 重建索引的 LRU 容量。一个索引可能几万条，缓存太多会吃掉几百 MB 内存。 */
const INDEX_CACHE_MAX = 8;
/** @type {Map<string, Map<string, Map<string, string>>>} */
const INDEX_CACHE = new Map();

/** 索引的键：维度 + 种类，例如 `overworld|region` */
function dk(dim, kind) { return dim + '|' + kind; }

function sha1(buf) { return anvil.hashOf(buf); }

/* ================= 路径与基础读写 ================= */

/** 存档名可能带 Windows 非法字符，落成目录名前先洗一遍 */
function worldKeyOf(name) {
  return String(name || 'world').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '') || 'world';
}

function worldRoot(storeDir, world) { return path.join(storeDir, worldKeyOf(world)); }
function objectsDir(root) { return path.join(root, 'objects'); }
function commitsDir(root) { return path.join(root, 'commits'); }
function objPath(root, h) { return path.join(objectsDir(root), h.slice(0, 2), h); }
function commitPath(root, id) { return path.join(commitsDir(root), id + '.json'); }
function refsPath(root) { return path.join(root, 'refs.json'); }
function headPath(root) { return path.join(root, 'HEAD'); }

/**
 * 建库（幂等）。已有内容一律不动。
 * @returns {string} 库根目录
 */
function ensureStore(storeDir, world) {
  if (!storeDir) throw new Error('缺少 storeDir');
  if (!world) throw new Error('缺少 world');
  const root = worldRoot(storeDir, world);
  fs.mkdirSync(objectsDir(root), { recursive: true });
  fs.mkdirSync(commitsDir(root), { recursive: true });
  if (!fs.existsSync(refsPath(root))) fs.writeFileSync(refsPath(root), JSON.stringify({}, null, 2));
  if (!fs.existsSync(headPath(root))) fs.writeFileSync(headPath(root), DEFAULT_BRANCH);
  return root;
}

function readRefs(root) {
  try { return JSON.parse(fs.readFileSync(refsPath(root), 'utf8')) || {}; } catch { return {}; }
}
function writeRefs(root, refs) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(refsPath(root), JSON.stringify(refs, null, 2));
}
function readHead(root) {
  try {
    const s = fs.readFileSync(headPath(root), 'utf8').trim();
    return s || DEFAULT_BRANCH;
  } catch { return DEFAULT_BRANCH; }
}
function writeHead(root, branch) { fs.writeFileSync(headPath(root), branch); }

/**
 * 读提交
 * @param {string} root
 * @param {string} id
 * @returns {any}
 */
function readCommit(root, id) {
  const p = commitPath(root, id);
  if (!fs.existsSync(p)) throw new Error('提交不存在: ' + id);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function hasCommit(root, id) { return fs.existsSync(commitPath(root, id)); }

/* ================= 对象库 ================= */

function hasObject(root, h) { return fs.existsSync(objPath(root, h)); }

/**
 * 存一个区块对象（内容寻址，重复内容只落一次盘）
 * @param {string} root
 * @param {Buffer} raw 未压缩 NBT
 * @returns {{hash:string, isNew:boolean, stored:number, raw:number}}
 */
function putObject(root, raw) {
  const h = sha1(raw);
  const p = objPath(root, h);
  if (fs.existsSync(p)) return { hash: h, isNew: false, stored: 0, raw: raw.length };
  const comp = zlib.deflateSync(raw);
  const out = Buffer.allocUnsafe(4 + comp.length);
  out.writeUInt32BE(raw.length, 0);
  comp.copy(out, 4);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // 先写 .tmp 再改名：对象是内容寻址且只写一次的，一旦留下半截文件，
  // 之后每次读它都会 inflate 失败，而且没法自愈（hash 对不上内容，谁也发现不了）。
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, p);
  return { hash: h, isNew: true, stored: out.length, raw: raw.length };
}

/**
 * 取一个区块对象（未压缩 NBT）
 * @param {string} root
 * @param {string} h
 * @returns {Buffer}
 */
function getObject(root, h) {
  const buf = fs.readFileSync(objPath(root, h));
  return zlib.inflateSync(buf.subarray(4));
}

/**
 * 只读对象头 4 字节拿到未压缩长度。
 * 统计体积时用得上：走这 4 字节就能算总大小，不必把每个区块都解压一遍。
 * @param {string} root
 * @param {string} h
 * @returns {number}
 */
function objSize(root, h) {
  let fd = -1;
  try {
    fd = fs.openSync(objPath(root, h), 'r');
    const b = Buffer.alloc(4);
    if (fs.readSync(fd, b, 0, 4, 0) < 4) return 0;
    return b.readUInt32BE(0);
  } catch { return 0; } finally { if (fd >= 0) fs.closeSync(fd); }
}

/* ================= 提交 id ================= */

function newId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ================= 扫描存档 → 状态 ================= */

/**
 * 扫描整个存档，算出每个区块的内容指纹，返回 `dk -> Map<"cx,cz", hash>` 状态。
 * 六个组合（三维度 × region/entities）一律给出，没有的维度是空 Map —— 这样上层的
 * diff / checkout 不用到处判空。
 *
 * `store:false` 时**只算指纹、不落对象库**。status 存在的意义是"看一眼改了什么"，
 * 如果看一眼就往库里塞几万个还没被任何提交引用的对象，得靠 gc 才清得掉，
 * 那 status 就成了一个有副作用的查询。
 *
 * 顺带把每个区块的未压缩长度收进 `sizes`：算提交体积时需要它，
 * 而这里本来就把字节捏在手上，不必事后再把每个对象开一遍文件去量。
 *
 * @param {{root:string, saveDir:string, store?:boolean,
 *          onProgress?:(o:{dim:string, kind:string, done:number, total:number})=>void}} o
 * @returns {Promise<{state: Map<string, Map<string,string>>,
 *                    sizes: Map<string, Map<string,number>>,
 *                    newBytes:number, chunks:number, storedBytes:number, broken:number}>}
 */
async function collect(o) {
  const root = o.root;
  const store = o.store !== false;
  /** @type {Map<string, Map<string,string>>} */
  const state = new Map();
  /** @type {Map<string, Map<string,number>>} */
  const sizes = new Map();
  let newBytes = 0;
  let chunks = 0;
  let storedBytes = 0;
  let broken = 0;

  for (const dim of DIM_KEYS) {
    for (const kind of KINDS) {
      const key = dk(dim, kind);
      const m = new Map();
      const sz = new Map();
      state.set(key, m);
      sizes.set(key, sz);
      const res = await anvil.scanSaveChunks({
        saveDir: o.saveDir,
        dim,
        kind,
        onProgress: o.onProgress
          ? (done, total) => o.onProgress({ dim, kind, done, total })
          : undefined,
        onChunk: (k, raw, bytes) => {
          chunks++;
          storedBytes += bytes;
          sz.set(k, raw.length);
          if (store) {
            const r = putObject(root, raw);
            if (r.isNew) newBytes += r.stored;
            m.set(k, r.hash);
          } else {
            m.set(k, anvil.hashOf(raw));
          }
        }
      });
      broken += res.broken;
    }
  }
  return { state, sizes, newBytes, chunks, storedBytes, broken };
}

/** 深拷一份状态（用于把"当前磁盘"当基线比对，避免原地改动缓存里的 Map） */
function cloneState(state) {
  const out = new Map();
  for (const [k, m] of state) out.set(k, new Map(m));
  return out;
}

/* ================= 索引重建（增量 → 全量） ================= */

function cacheGet(k) {
  if (!INDEX_CACHE.has(k)) return null;
  const v = INDEX_CACHE.get(k);
  INDEX_CACHE.delete(k);   // 重新插入 = 刷新到最新，实现 LRU
  INDEX_CACHE.set(k, v);
  return v;
}
function cacheSet(k, v) {
  if (INDEX_CACHE.has(k)) INDEX_CACHE.delete(k);
  INDEX_CACHE.set(k, v);
  while (INDEX_CACHE.size > INDEX_CACHE_MAX) INDEX_CACHE.delete(INDEX_CACHE.keys().next().value);
}
/** 单测用：清掉进程内索引缓存 */
function clearCache() { INDEX_CACHE.clear(); }

/** 从 id 沿 parent 一路回到根，返回**由旧到新**的提交序列 */
function chainTo(root, id, limit) {
  const out = [];
  const seen = new Set();
  let cur = id;
  let n = 0;
  while (cur) {
    if (seen.has(cur)) break;          // 数据坏了也不能死循环
    seen.add(cur);
    if (!hasCommit(root, cur)) break;
    out.push(readCommit(root, cur));
    cur = out[out.length - 1].parent || null;
    if (limit && ++n >= limit) break;
  }
  return out.reverse();
}

function applyDelta(state, commit) {
  const dims = commit.dims || {};
  for (const dim of Object.keys(dims)) {
    for (const kind of Object.keys(dims[dim])) {
      const d = dims[dim][kind] || {};
      const key = dk(dim, kind);
      let m = state.get(key);
      if (!m) { m = new Map(); state.set(key, m); }
      const del = d.del || [];
      for (const k of del) m.delete(k);
      const add = d.add || {};
      for (const k of Object.keys(add)) m.set(k, add[k]);
    }
  }
  return state;
}

/** 一个空状态（六个组合都是空 Map） */
function emptyState() {
  const s = new Map();
  for (const dim of DIM_KEYS) for (const kind of KINDS) s.set(dk(dim, kind), new Map());
  return s;
}

/**
 * 某个提交的**完整**区块索引（沿 parent 链回溯重建，带 LRU 缓存）
 * @param {string} root
 * @param {string} id
 * @returns {Map<string, Map<string,string>>}
 */
function indexOf(root, id) {
  if (!id) return emptyState();
  const ck = root + '#' + id;
  const hit = cacheGet(ck);
  if (hit) return hit;

  // 先看有没有祖先已经算过，能省掉一段回溯
  const chain = chainTo(root, id);
  // 提交不存在（文件还没落盘 / 数据坏了）时绝不能把"空索引"写进缓存：
  // 文件稍后出现，这里会一直返回那个错的空状态，比不缓存难查得多。
  if (!chain.length) return emptyState();
  let base = null;
  let from = 0;
  for (let i = chain.length - 1; i >= 0; i--) {
    const cached = cacheGet(root + '#' + chain[i].id);
    if (cached) { base = cached; from = i + 1; break; }
  }
  const state = base ? cloneState(base) : emptyState();
  for (let i = from; i < chain.length; i++) {
    applyDelta(state, chain[i]);
    cacheSet(root + '#' + chain[i].id, cloneState(state));
  }
  // chain 为空（提交不存在）时上面循环不执行，state 就是空状态
  const res = cacheGet(ck) || state;
  cacheSet(ck, res);
  return res;
}

/* ================= 提交 ================= */

/**
 * 把当前存档状态提交为一个新版本。
 *
 * 只读存档，绝不写存档目录 —— 提交是"记录"，不是"改动"。
 * 与父提交完全一致时默认不产生新提交（`allowEmpty` 可强制产生）。
 *
 * @param {{saveDir:string, storeDir:string, world:string, message?:string,
 *          branch?:string, auto?:boolean, allowEmpty?:boolean,
 *          onProgress?:(o:{dim:string, kind:string, done:number, total:number})=>void}} o
 * @returns {Promise<{ok:boolean, id:string, unchanged:boolean, newBytes:number,
 *                    changed:object, commit:object}>}
 */
async function commit(o) {
  if (!o.saveDir || !fs.existsSync(o.saveDir)) throw new Error('存档目录不存在: ' + o.saveDir);
  const root = ensureStore(o.storeDir, o.world);
  const refs = readRefs(root);
  const branch = o.branch || readHead(root);
  const parentId = refs[branch] || null;
  const parentState = parentId ? indexOf(root, parentId) : null;

  const { state, sizes, newBytes, broken } = await collect({
    root, saveDir: o.saveDir, store: true, onProgress: o.onProgress
  });
  const parentCommit = parentId ? readCommit(root, parentId) : null;

  // ---- 相对父提交算增量 ----
  // 累计的 count / bytes 从**父提交里已经算好的值**出发再加本次增量，
  // 而不是把整个世界的每个区块都 objSize 一遍 —— 2 万区块就是 2 万次开文件。
  const dims = {};
  let addTotal = 0;
  let delTotal = 0;
  for (const dim of DIM_KEYS) {
    dims[dim] = {};
    for (const kind of KINDS) {
      const key = dk(dim, kind);
      const cur = state.get(key) || new Map();
      const sz = sizes.get(key) || new Map();
      const prev = parentState ? (parentState.get(key) || new Map()) : null;
      const agg = (parentCommit && parentCommit.dims && parentCommit.dims[dim]
        && parentCommit.dims[dim][kind]) || null;

      const add = {};
      const del = [];
      let bytes = agg ? (agg.bytes || 0) : 0;
      let count = agg ? (agg.count || 0) : 0;

      for (const [k, h] of cur) {
        const old = prev ? prev.get(k) : undefined;
        if (old === h) continue;                       // 内容没动，连对象都不碰
        add[k] = h;
        addTotal++;
        bytes += sz.has(k) ? sz.get(k) : objSize(root, h);
        if (old) bytes -= objSize(root, old);          // 被替换掉的旧内容要减掉
        else count++;
      }
      for (const k of (prev ? prev.keys() : [])) {
        if (cur.has(k)) continue;
        del.push(k);
        delTotal++;
        count--;
        bytes -= objSize(root, prev.get(k));
      }
      dims[dim][kind] = { add, del, count: Math.max(0, count), bytes: Math.max(0, bytes) };
    }
  }

  const changed = { add: addTotal, del: delTotal, total: addTotal + delTotal };
  const id0 = newId();

  if (!changed.total && parentId && !o.allowEmpty) {
    refs[branch] = parentId;
    writeRefs(root, refs);
    return {
      ok: true, id: parentId, unchanged: true, newBytes,
      changed, commit: readCommit(root, parentId)
    };
  }

  let id = id0;
  let n = 1;
  while (hasCommit(root, id)) id = id0 + '-' + (++n);

  const record = {
    id,
    time: Date.now(),
    world: o.world,
    branch,
    parent: parentId,
    message: o.message || (o.auto ? '自动提交' : '手动提交'),
    auto: !!o.auto,
    dims,
    changed,
    newBytes,
    broken
  };
  fs.writeFileSync(commitPath(root, id), JSON.stringify(record));
  refs[branch] = id;
  writeRefs(root, refs);
  cacheSet(root + '#' + id, state);
  return { ok: true, id, unchanged: false, newBytes, changed, commit: record };
}

/**
 * 首次纳入版本控制：建库 + 打第一个提交。
 * @param {{saveDir:string, storeDir:string, world:string, message?:string,
 *          onProgress?:(o:{dim:string, kind:string, done:number, total:number})=>void}} o
 */
async function init(o) {
  const root = ensureStore(o.storeDir, o.world);
  const refs = readRefs(root);
  const branch = readHead(root) || DEFAULT_BRANCH;
  writeHead(root, branch);
  if (refs[branch]) return { ok: true, root, initial: refs[branch], existed: true };
  const r = await commit(Object.assign({}, o, { branch, message: o.message || '开始跟踪' }));
  return { ok: true, root, initial: r.id, existed: false };
}

/* ================= 查询 ================= */

/**
 * 提交历史（沿分支指针走第一父链，最新的在前）
 * @param {{storeDir:string, world:string, branch?:string, limit?:number}} o
 */
function log(o) {
  const root = worldRoot(o.storeDir, o.world);
  const refs = readRefs(root);
  const branch = o.branch || readHead(root);
  const head = refs[branch];
  if (!head) return [];
  const chain = chainTo(root, head, o.limit || 200).reverse();   // 已是由旧到新，反转成新在前
  return chain.map((c) => ({
    id: c.id, time: c.time, branch: c.branch, message: c.message, auto: !!c.auto,
    parent: c.parent, changed: c.changed, newBytes: c.newBytes,
    isHead: c.id === head
  }));
}

/**
 * 每个维度的区块数与体积（做 UI 摘要用，不读对象内容）
 * @param {{storeDir:string, world:string, id?:string}} o
 */
function tree(o) {
  const root = worldRoot(o.storeDir, o.world);
  const refs = readRefs(root);
  const id = o.id || refs[readHead(root)];
  if (!id) return { id: null, dims: [], total: { count: 0, bytes: 0 } };
  const c = readCommit(root, id);
  const out = [];
  let count = 0;
  let bytes = 0;
  for (const dim of DIM_KEYS) {
    const row = { dim, label: anvil.dimInfo(dim).label, count: 0, bytes: 0, kinds: {} };
    for (const kind of KINDS) {
      const d = (c.dims && c.dims[dim] && c.dims[dim][kind]) || { count: 0, bytes: 0 };
      row.kinds[kind] = { count: d.count || 0, bytes: d.bytes || 0 };
      row.count += d.count || 0;
      row.bytes += d.bytes || 0;
    }
    count += row.count;
    bytes += row.bytes;
    out.push(row);
  }
  return { id, time: c.time, message: c.message, dims: out, total: { count, bytes } };
}

/**
 * 工作区状态：当前磁盘 vs 分支 HEAD，到底改了什么。
 * @param {{saveDir:string, storeDir:string, world:string, branch?:string,
 *          sample?:number,
 *          onProgress?:(o:{dim:string, kind:string, done:number, total:number})=>void}} o
 * @returns {Promise<{tracked:boolean, branch:string, head:string|null,
 *                    changes:{add:number, change:number, del:number, total:number},
 *                    sample:{add:string[], change:string[], del:string[]},
 *                    dims:Array<object>, chunks:number, bytes:number}>}
 */
async function status(o) {
  // 刻意**不**调 ensureStore：status 是纯查询。给一个从没跟踪过的存档"看一眼"，
  // 不该在库目录里凭空造一个空存档出来 —— 那样它会立刻出现在 listWorlds 里，
  // 玩家会以为自己"已经把它纳入版本控制了"。
  const root = worldRoot(o.storeDir, o.world);
  const refs = readRefs(root);
  const branch = o.branch || readHead(root);
  const head = refs[branch] || null;
  const limit = o.sample || 200;

  if (!head) {
    return {
      tracked: false, branch, head: null,
      changes: { add: 0, change: 0, del: 0, total: 0 },
      sample: { add: [], change: [], del: [] }, dims: [], chunks: 0, bytes: 0
    };
  }

  const base = indexOf(root, head);
  // store:false —— status 是查询，不能顺手往对象库里塞东西
  const { state, chunks, storedBytes } = await collect({
    root, saveDir: o.saveDir, store: false, onProgress: o.onProgress
  });

  const changes = { add: 0, change: 0, del: 0, total: 0 };
  const sample = { add: [], change: [], del: [] };
  const dims = [];

  for (const dim of DIM_KEYS) {
    const row = { dim, label: anvil.dimInfo(dim).label, add: 0, change: 0, del: 0 };
    for (const kind of KINDS) {
      const key = dk(dim, kind);
      const cur = state.get(key) || new Map();
      const old = base.get(key) || new Map();
      for (const [k, h] of cur) {
        const before = old.get(k);
        if (before === undefined) {
          row.add++; changes.add++;
          if (sample.add.length < limit) sample.add.push(kind === 'region' ? k : kind + '@' + k);
        } else if (before !== h) {
          row.change++; changes.change++;
          if (sample.change.length < limit) sample.change.push(kind === 'region' ? k : kind + '@' + k);
        }
      }
      for (const k of old.keys()) {
        if (cur.has(k)) continue;
        row.del++; changes.del++;
        if (sample.del.length < limit) sample.del.push(kind === 'region' ? k : kind + '@' + k);
      }
    }
    row.total = row.add + row.change + row.del;
    if (row.total) dims.push(row);
  }
  changes.total = changes.add + changes.change + changes.del;
  return { tracked: true, branch, head, changes, sample, dims, chunks, bytes: storedBytes };
}

/**
 * 两次提交的差异（区域级）
 * @param {{storeDir:string, world:string, a:string, b:string,
 *          dim?:string, kind?:string, limit?:number}} o
 */
function diff(o) {
  const root = worldRoot(o.storeDir, o.world);
  const A = indexOf(root, o.a);
  const B = indexOf(root, o.b);
  const limit = o.limit || 5000;
  const dims = o.dim ? [o.dim] : DIM_KEYS;
  const kinds = o.kind ? [o.kind] : KINDS;

  const out = { a: o.a, b: o.b, added: [], removed: [], changed: [], counts: { added: 0, removed: 0, changed: 0 }, truncated: false, dims: [] };

  for (const dim of dims) {
    const row = { dim, label: anvil.dimInfo(dim).label, added: 0, removed: 0, changed: 0 };
    for (const kind of kinds) {
      const key = dk(dim, kind);
      const a = A.get(key) || new Map();
      const b = B.get(key) || new Map();
      const tag = (k) => (kind === 'region' ? k : kind + '@' + k);
      for (const [k, h] of b) {
        const before = a.get(k);
        if (before === undefined) { row.added++; out.counts.added++; if (out.added.length < limit) out.added.push(tag(k)); }
        else if (before !== h) { row.changed++; out.counts.changed++; if (out.changed.length < limit) out.changed.push(tag(k)); }
      }
      for (const k of a.keys()) {
        if (b.has(k)) continue;
        row.removed++; out.counts.removed++;
        if (out.removed.length < limit) out.removed.push(tag(k));
      }
    }
    if (row.added || row.removed || row.changed) out.dims.push(row);
  }
  out.truncated = out.added.length >= limit || out.removed.length >= limit || out.changed.length >= limit;
  return out;
}

/**
 * 单个区块的改动史（沿父提交链回溯，最新的在前）。
 *
 * history[0] 就是"当前内容是哪次提交引入的"，也就是 blame 的答案。
 * `hash === null` 的那条表示"这次提交把它删掉了"。
 *
 * @param {{storeDir:string, world:string, id?:string, dim?:string, kind?:string,
 *          cx:number, cz:number, limit?:number}} o
 * @returns {{key:string, hash:string|null, history:Array<object>}}
 */
function blame(o) {
  const root = worldRoot(o.storeDir, o.world);
  const refs = readRefs(root);
  const id = o.id || refs[readHead(root)];
  const dim = o.dim || 'overworld';
  const kind = o.kind || anvil.KIND.REGION;
  const key = o.cx + ',' + o.cz;
  const history = [];
  if (!id) return { key, hash: null, history };

  const chain = chainTo(root, id, o.limit || 500).reverse();   // 新 → 旧
  for (const c of chain) {
    const d = (c.dims && c.dims[dim] && c.dims[dim][kind]) || null;
    if (!d) continue;
    let h = null;
    if (d.add && Object.prototype.hasOwnProperty.call(d.add, key)) h = d.add[key];
    else if ((d.del || []).includes(key)) h = null;
    else continue;
    history.push({ id: c.id, time: c.time, branch: c.branch, message: c.message, auto: !!c.auto, hash: h });
  }
  return { key, hash: history.length ? history[0].hash : null, history };
}

/* ================= 分支 ================= */

function branches(o) {
  const root = worldRoot(o.storeDir, o.world);
  const refs = readRefs(root);
  const head = readHead(root);
  return Object.keys(refs).map((name) => {
    const id = refs[name];
    let time = 0;
    let message = '';
    try { const c = readCommit(root, id); time = c.time; message = c.message; } catch {}
    return { name, id, time, message, current: name === head };
  }).sort((a, b) => (a.current ? -1 : b.current ? 1 : a.name.localeCompare(b.name)));
}

/**
 * 新建分支（不碰存档目录，只是多一个指针）
 * @param {{storeDir:string, world:string, name:string, from?:string}} o
 */
function createBranch(o) {
  const root = worldRoot(o.storeDir, o.world);
  const refs = readRefs(root);
  const name = String(o.name || '').trim();
  if (!name) throw new Error('分支名不能为空');
  if (/[\\/:*?"<>|]/.test(name) || name.startsWith('.')) throw new Error('分支名含非法字符: ' + name);
  if (refs[name]) throw new Error('分支已存在: ' + name);
  const from = o.from || refs[readHead(root)];
  if (!from) throw new Error('还没有任何提交，无法建分支');
  if (!hasCommit(root, from)) throw new Error('起始提交不存在: ' + from);
  refs[name] = from;
  writeRefs(root, refs);
  return { ok: true, name, id: from };
}

/** 切分支：只改 HEAD，**不动存档**（要同步存档请接着调 checkout） */
function switchBranch(o) {
  const root = worldRoot(o.storeDir, o.world);
  const refs = readRefs(root);
  if (!refs[o.name]) throw new Error('分支不存在: ' + o.name);
  writeHead(root, o.name);
  return { ok: true, branch: o.name, id: refs[o.name] };
}

function deleteBranch(o) {
  const root = worldRoot(o.storeDir, o.world);
  const refs = readRefs(root);
  if (o.name === readHead(root)) throw new Error('不能删除当前分支');
  if (!refs[o.name]) throw new Error('分支不存在: ' + o.name);
  delete refs[o.name];
  writeRefs(root, refs);
  return { ok: true };
}

/* ================= 回滚 / 检出 ================= */

/** 单次 applySaveChunks 的堆内存上限：区块是整块读进内存的，不设上限会吃掉几个 GB */
const PUT_BUDGET = 32 * 1024 * 1024;

/**
 * 把存档的区块内容对齐到某个提交（branch 名或 id 都行）。
 *
 * 这是本模块**唯一会写存档目录**的操作，所以：
 *   1. 传了 `tmDir` 就先打一个时光机安全快照 —— 让"回滚"本身也能被回滚；
 *   2. 每个 region 文件写回前自动留 `.bak`（anvil.writeRegionFile 的默认行为）；
 *   3. 只改有差异的区块，没动的区块连字节都不碰。
 *
 * @param {{saveDir:string, storeDir:string, world:string, id?:string, branch?:string,
 *          dims?:string[], tmDir?:string, backup?:boolean, prune?:boolean,
 *          onProgress?:(o:object)=>void}} o
 * @returns {Promise<{ok:boolean, id:string, written:number, deleted:number,
 *                    files:number, safety:string|null, dims:Array<object>}>}
 */
async function checkout(o) {
  if (!o.saveDir || !fs.existsSync(o.saveDir)) throw new Error('存档目录不存在: ' + o.saveDir);
  const root = ensureStore(o.storeDir, o.world);
  const refs = readRefs(root);

  let target = o.id || null;
  if (!target && o.branch) target = refs[o.branch] || null;
  if (!target) {
    const br = readHead(root);
    target = refs[br] || null;
  }
  if (!target) throw new Error('没有可回滚的提交');
  if (!hasCommit(root, target)) throw new Error('提交不存在: ' + target);

  // 1. 安全快照（可选，但强烈建议 —— IPC 层一律传 tmDir）
  let safety = null;
  if (o.tmDir) {
    const tm = require('./savetimemachine');
    try {
      const s = await tm.createSnapshot({
        saveDir: o.saveDir, storeDir: o.tmDir, label: '回滚前自动快照', auto: true
      });
      safety = s.id;
    } catch { safety = null; }
  }

  const want = indexOf(root, target);
  // prune:false 只补写不删除 —— 给"我想看看老版本长什么样"留一条不动新地形的路
  const prune = o.prune !== false;
  const dims = o.dims && o.dims.length ? o.dims : DIM_KEYS;
  const report = [];
  let written = 0;
  let deleted = 0;
  let files = 0;

  for (const dim of dims) {
    for (const kind of KINDS) {
      const key = dk(dim, kind);
      const target2 = want.get(key) || new Map();
      const cur = await anvil.scanSaveChunks({ saveDir: o.saveDir, dim, kind });
      if (cur.missing && !target2.size) continue;

      /** @type {Array<{cx:number,cz:number,raw:Buffer,comp?:number}>} */
      let puts = [];
      let budget = 0;
      const row = { dim, kind, written: 0, deleted: 0 };

      const flush = async () => {
        if (!puts.length) return;
        const r = await anvil.applySaveChunks({
          saveDir: o.saveDir, dim, kind, puts, dels: [], backup: o.backup !== false
        });
        written += r.written; files += r.files;
        row.written += r.written;
        puts = [];
        budget = 0;
        if (o.onProgress) o.onProgress({ dim, kind, written, deleted, files });
      };

      for (const [k, h] of target2) {
        const have = cur.index[k];
        if (have && have.hash === h) continue;
        const [cx, cz] = k.split(',').map(Number);
        let raw;
        try { raw = getObject(root, h); }
        catch (e) { throw new Error('对象缺失或损坏（' + h + '，区块 ' + k + '）: ' + e.message); }
        puts.push({ cx, cz, raw });
        budget += raw.length;
        // 区块是整块进内存的，攒够预算就先落一批，别把几万个区块全攒在数组里
        if (budget >= PUT_BUDGET) await flush();
      }
      await flush();

      // 目标里没有、磁盘上有的 → 删掉，否则回滚不彻底。
      // 注意这会把"提交之后新生成的地形"也一并清掉 —— 语义上就是回到那个版本，
      // 但确实出乎意料，所以既有 prune:false 这个开关，调用方也应该传 tmDir 兜底。
      const dels = [];
      if (prune) {
        for (const k of Object.keys(cur.index)) {
          if (target2.has(k)) continue;
          const [cx, cz] = k.split(',').map(Number);
          dels.push({ cx, cz });
        }
      }
      if (dels.length) {
        const r = await anvil.applySaveChunks({
          saveDir: o.saveDir, dim, kind, puts: [], dels, backup: o.backup !== false
        });
        deleted += r.deleted; files += r.files;
        row.deleted += r.deleted;
      }

      if (row.written || row.deleted) report.push(row);
    }
  }

  return { ok: true, id: target, written, deleted, files, safety, dims: report };
}

/* ================= 清理 / 统计 ================= */

/**
 * 回收没有被任何提交引用的区块对象。
 * 注意只扫 commits/ 里所有提交的 add 表 —— del 表引用的是**更早**提交里 add 过的
 * 内容，本来就被那条链罩着，不需要单独算。
 * @param {{storeDir:string, world:string}} o
 */
function gc(o) {
  const root = worldRoot(o.storeDir, o.world);
  const used = new Set();
  const dir = commitsDir(root);
  if (!fs.existsSync(dir)) return { removed: 0, freed: 0, kept: 0 };
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let c;
    try { c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const dims = c.dims || {};
    for (const dim of Object.keys(dims)) {
      for (const kind of Object.keys(dims[dim])) {
        const add = (dims[dim][kind] || {}).add || {};
        for (const k of Object.keys(add)) used.add(add[k]);
      }
    }
  }
  let removed = 0;
  let freed = 0;
  const base = objectsDir(root);
  if (!fs.existsSync(base)) return { removed: 0, freed: 0, kept: used.size };
  for (const d of fs.readdirSync(base)) {
    const dd = path.join(base, d);
    let ents;
    try { ents = fs.readdirSync(dd); } catch { continue; }
    for (const f of ents) {
      if (used.has(f)) continue;
      const p = path.join(dd, f);
      try { freed += fs.statSync(p).size; fs.unlinkSync(p); removed++; } catch {}
    }
  }
  return { removed, freed, kept: used.size };
}

/**
 * 库统计
 * @param {{storeDir:string, world:string}} o
 */
function stats(o) {
  const root = worldRoot(o.storeDir, o.world);
  const refs = readRefs(root);
  let commits = 0;
  const dir = commitsDir(root);
  if (fs.existsSync(dir)) commits = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length;

  let objects = 0;
  let physical = 0;
  const base = objectsDir(root);
  if (fs.existsSync(base)) {
    for (const d of fs.readdirSync(base)) {
      for (const f of fs.readdirSync(path.join(base, d))) {
        try { physical += fs.statSync(path.join(base, d, f)).size; objects++; } catch {}
      }
    }
  }

  const head = refs[readHead(root)] || null;
  let logical = 0;
  let chunks = 0;
  if (head) {
    try {
      const c = readCommit(root, head);
      const dims = c.dims || {};
      for (const dim of Object.keys(dims)) {
        for (const kind of Object.keys(dims[dim])) {
          const d = dims[dim][kind] || {};
          logical += d.bytes || 0;
          chunks += d.count || 0;
        }
      }
    } catch {}
  }

  return {
    root, commits, branches: Object.keys(refs).length, head,
    objects, physical, logical, chunks,
    ratio: physical ? logical / physical : 1
  };
}

/**
 * 列出库里跟踪过的所有存档
 * @param {{storeDir:string}} o
 */
function listWorlds(o) {
  if (!o.storeDir || !fs.existsSync(o.storeDir)) return [];
  const out = [];
  for (const name of fs.readdirSync(o.storeDir)) {
    const root = path.join(o.storeDir, name);
    let st;
    try { st = fs.statSync(root); } catch { continue; }
    if (!st.isDirectory()) continue;
    if (!fs.existsSync(commitsDir(root))) continue;
    const refs = readRefs(root);
    const head = refs[readHead(root)] || null;
    let time = 0;
    let commits = 0;
    try {
      const files = fs.readdirSync(commitsDir(root)).filter((f) => f.endsWith('.json'));
      commits = files.length;
      if (head) time = readCommit(root, head).time;
    } catch {}
    out.push({ world: name, dir: root, commits, branches: Object.keys(refs).length, head, time });
  }
  return out.sort((a, b) => b.time - a.time);
}

/** 把某个提交（或 HEAD）导出成一份完整索引快照，便于排查/对拍 */
function snapshotIndex(o) {
  const root = worldRoot(o.storeDir, o.world);
  const refs = readRefs(root);
  const id = o.id || refs[readHead(root)];
  if (!id) return { id: null, dims: {} };
  const state = indexOf(root, id);
  const dims = {};
  for (const dim of DIM_KEYS) {
    dims[dim] = {};
    for (const kind of KINDS) {
      const m = state.get(dk(dim, kind)) || new Map();
      dims[dim][kind] = Object.fromEntries(m);
    }
  }
  return { id, dims };
}

module.exports = {
  DEFAULT_BRANCH, KINDS, DIM_KEYS, worldKeyOf, worldRoot,
  ensureStore, readRefs, readHead, readCommit, hasCommit,
  putObject, getObject, objSize, hasObject,
  indexOf, chainTo, clearCache,
  init, commit, status, log, diff, blame, tree,
  branches, createBranch, switchBranch, deleteBranch,
  checkout, gc, stats, listWorlds, snapshotIndex
};
