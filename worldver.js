// Pebble Launcher - 世界版本控制（V4 第一组）
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
const nbt = require('./nbt');
const blockstate = require('./blockstate');

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
 *          branch?:string, auto?:boolean, allowEmpty?:boolean, merges?:string[],
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
    // 合并父。普通提交是空数组。indexOf 只沿第一父链回溯，这一点不受影响 ——
    // 合并提交的 dims 存的是"相对我方"的增量，套在我方状态上就是合并后的状态。
    merges: Array.isArray(o.merges) ? o.merges.filter(Boolean) : [],
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
    isHead: c.id === head,
    merges: c.merges || [],
    mergeFrom: c.mergeFrom || null,
    conflictCount: (c.conflicts || []).length
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
    history.push({ id: c.id, time: c.time, branch: c.branch, message: c.message, auto: !!c.auto, hash: h, merged: !!(c.merges && c.merges.length) });
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

/* ================= V5 第一组：方块级 blame / 时间轴回放 / 分支合并 =================
 *
 * 这一节把「世界版本控制」从**区块级**推到**方块级**，并补上分支之间真正的合并。
 *   · 区块级 blame 只能回答"这个区块是哪次改的"。玩家真正想问的是
 *     "我家门口这个方块是谁、什么时候放下的" —— 那要塞进区块内部去看。
 *   · 回放需要两个东西：**帧列表**（timeline：这个区块在哪几次提交里变过）和
 *     **单帧内容**（frame：那一帧的 16×16 方块层）。UI 拿滑块在帧之间拖动即可。
 *   · 合并是本模块里唯一要处理**分支图**的地方：要找共同祖先、要判断快进、
 *     要区分"只有一边改""两边改成一样""两边改得不一样"。
 *
 * ✅ 合并**能产出真实的区块字节了**（V5 第二组补完）。里程碑一当时卡在 nbt.js 的写入端
 *    靠 JS 值反推 NBT 类型：区块里的 `PostProcessing` 是 LIST of SHORT，值全是 0，
 *    写回去就变成 LIST of INT，游戏读这种区块直接报错。现在解析时可以带一张
 *    类型旁路表（`nbt.newTypes()`），写回按原类型编码，这条路才通。
 *    于是冲突区块做**方块级三方合并**（chunkMergePlan + mergeChunkBytes），
 *    两侧的改动都能留下来，不再只能"整块取一侧"。
 *
 *    但合流有两道**硬闸门**，碰到就退回"整块取一侧"并说明原因：
 *      · 对方改了我方没有的区段（只能重写已有的 section，碰不到的地方谈不上合并）；
 *      · 涉及方块实体载体（箱子/告示牌/刷怪笼）—— 容器里的内容不在这一层，
 *        硬合会让箱子变空，那是静默丢数据，比"光照过时"严重得多。
 *    还有一条**如实上报**：改动的方块如果不是不透明完整方块，该格的光照与高度图
 *    就不再准确。这一层不做光照重算，所以逐格列进 lightRisk 交出去，不替用户咽下去。
 *
 *    合并仍然**只写对象库与提交图，不碰存档目录** —— 要落盘还是合并完切到该分支
 *    再 checkout。这条边界不因为"能产字节了"就破掉。
 */

/** 解析过的区块对象缓存。一次 blame 可能要看几百个历史版本，解过的别重复解。 */
const OBJ_PARSE_MAX = 48;
/** @type {Map<string, object|null>} */
const OBJ_PARSE = new Map();

/**
 * 取一个区块对象并解析成 NBT 树（按 hash 缓存）。
 * 解析失败缓存成 null —— 对象被 gc 清掉时不该每次都去开一遍文件。
 * @param {string} root
 * @param {string|null} h
 * @returns {object|null}
 */
function parsedObject(root, h) {
  if (!h) return null;
  const hit = OBJ_PARSE.get(h);
  if (hit !== undefined) {
    OBJ_PARSE.delete(h);        // 重新插入 = 刷新到最新
    OBJ_PARSE.set(h, hit);
    return hit;
  }
  let v = null;
  try { v = nbt.parse(getObject(root, h)).value; } catch { v = null; }
  OBJ_PARSE.set(h, v);
  while (OBJ_PARSE.size > OBJ_PARSE_MAX) OBJ_PARSE.delete(OBJ_PARSE.keys().next().value);
  return v;
}

/** 单测用：清掉进程内的对象解析缓存 */
function clearObjCache() { OBJ_PARSE.clear(); }

/** 读某个区块对象里某个方块的状态 */
function stateOfBlock(root, h, x, y, z) {
  const tree = parsedObject(root, h);
  if (!tree) return null;
  try { return blockstate.blockAt(tree, x, y, z); } catch { return null; }
}

/**
 * 沿第一父链取出「这个区块每次被改动」的 (提交, hash) 序列，**新 → 旧**。
 *
 * 只认 `dims[dim][kind]` 里显式提到这个区块的提交：没提到 = 这次提交没动它 =
 * 方块状态必然没变，于是连对象都不用解压。一台 2 万区块的存档跑 blame 时，
 * 这个提前剪枝决定了它是"几百毫秒"还是"几十秒"。
 * 相邻两次 hash 相同也跳过（删掉又加回同一份内容的情况）。
 *
 * @returns {Array<{commit:object, hash:string|null}>}
 */
function chunkVersions(root, id, dim, kind, key, limit) {
  const out = [];
  if (!id) return out;
  const chain = chainTo(root, id, limit || 500).reverse();   // 新 → 旧
  let last;
  for (const c of chain) {
    const d = (c.dims && c.dims[dim] && c.dims[dim][kind]) || null;
    if (!d) continue;
    let h = null;
    if (d.add && Object.prototype.hasOwnProperty.call(d.add, key)) h = d.add[key];
    else if ((d.del || []).includes(key)) h = null;
    else continue;
    if (h === last) continue;
    out.push({ commit: c, hash: h });
    last = h;
  }
  return out;
}

/**
 * **方块级 blame**：某个方块坐标的完整改动史。
 *
 * history 每条都带 `state`（那次提交之后这个方块是什么）。`current:true` 的那条
 * 就是 HEAD 上的状态，history 按时间从新到旧。
 *
 * 为什么 history 的长度小于"改过这个区块的提交数"是正常的：
 * 连续几次提交如果让这个方块保持同一状态（比如只动了旁边的方块），
 * 只有**最先把它变成现在这个状态**的那次提交会留下记录 —— 这正是 blame 要的答案。
 * （从新往旧扫，把连续相同状态的区间归并成一段，取该段里最老的那次提交。）
 *
 * @param {{storeDir:string, world:string, dim?:string, kind?:string,
 *          x:number, y:number, z:number, id?:string, limit?:number}} o
 * @returns {{x:number, y:number, z:number, dim:string, kind:string, chunk:string,
 *            state:string|null, supported:boolean, reason:string, touched:number,
 *            history:Array<{id:string,time:number,branch:string,message:string,
 *              auto:boolean,state:string|null,hash:string|null,deleted:boolean,current:boolean}>}}
 */
function blameBlock(o) {
  const root = worldRoot(o.storeDir, o.world);
  const refs = readRefs(root);
  const id = o.id || refs[readHead(root)];
  const dim = o.dim || 'overworld';
  const kind = o.kind || anvil.KIND.REGION;
  const x = Math.trunc(Number(o.x));
  const y = Math.trunc(Number(o.y));
  const z = Math.trunc(Number(o.z));
  const cx = Math.floor(x / 16);
  const cz = Math.floor(z / 16);
  const key = cx + ',' + cz;
  const out = {
    x, y, z, dim, kind, chunk: key, state: null,
    supported: true, reason: '', touched: 0, history: []
  };
  // 没有 HEAD 就是"这个存档根本没纳入版本控制"。这里必须给一句明确的理由：
  // 直接返回一个 reason 为空的壳，UI 只能把它显示成"读不出来"，
  // 用户会去怀疑存档坏了，而真正该做的是点一下「纳入跟踪」。
  if (!id) {
    out.supported = false;
    out.reason = '这个存档还没有纳入版本控制，先在「版本控制」页点「纳入跟踪」';
    return out;
  }

  const vers = chunkVersions(root, id, dim, kind, key, o.limit);
  out.touched = vers.length;
  if (!vers.length) {
    out.supported = false;
    out.reason = '这个区块在所有提交里都没被改过（没纳入跟踪？）';
    return out;
  }

  // 先探一次格式支持情况。否则 UI 只能拿着空 history 猜是"没改过"还是"这个版本不支持"。
  const probe = parsedObject(root, vers[0].hash);
  if (!probe) {
    out.supported = false;
    out.reason = '区块对象读不出来（对象库可能被 gc 清过）';
  } else {
    const sup = blockstate.supportLevel(probe);
    out.supported = sup.ok;
    out.reason = sup.reason;
  }

  const states = vers.map((v) => (v.hash ? stateOfBlock(root, v.hash, x, y, z) : null));
  // 从新往旧扫，连续相同状态归并：一段的**最后一项**（最老的）才是引入这个状态的提交。
  // 注意 history[0] 不是 i=0 那条 —— i=0 落在"最新状态"那一段里，而这段要到
  // 状态第一次发生变化时才收尾。所以 current 要按**第几条 push** 判断，不能看 i。
  for (let i = 0; i < states.length; i++) {
    const runEnd = (i === states.length - 1) || states[i + 1] !== states[i];
    if (!runEnd) continue;
    const v = vers[i];
    out.history.push({
      id: v.commit.id, time: v.commit.time, branch: v.commit.branch,
      message: v.commit.message, auto: !!v.commit.auto,
      state: states[i], hash: v.hash, deleted: !v.hash,
      current: out.history.length === 0,      // 第一条描述的就是 HEAD 上的状态
      // 合并提交带进来的改动记在合并提交名下（blame 只走第一父链，
      // 跨合并父追溯是另一件事，这里不假装追到了）
      merged: !!(v.commit.merges && v.commit.merges.length)
    });
  }
  out.state = states[0];
  if (!out.history.length) out.reason = out.reason || '这个坐标上没有任何改动记录';
  return out;
}

/**
 * **时间轴回放**的帧列表：这个区块在哪几次提交里变过。
 *
 * 帧按**由旧到新**排列，UI 的滑块正着拖就是沿着时间往前走。
 * @param {{storeDir:string, world:string, dim?:string, kind?:string,
 *          cx:number, cz:number, branch?:string, id?:string, limit?:number}} o
 * @returns {{branch:string, dim:string, kind:string, cx:number, cz:number,
 *            chunk:string, frames:Array<object>}}
 */
function timeline(o) {
  const root = worldRoot(o.storeDir, o.world);
  const refs = readRefs(root);
  const branch = o.branch || readHead(root);
  const id = o.id || refs[branch];
  const dim = o.dim || 'overworld';
  const kind = o.kind || anvil.KIND.REGION;
  const cx = Math.trunc(Number(o.cx));
  const cz = Math.trunc(Number(o.cz));
  const key = cx + ',' + cz;
  const out = { branch, dim, kind, cx, cz, chunk: key, frames: [] };
  if (!id) return out;
  const vers = chunkVersions(root, id, dim, kind, key, o.limit);
  // vers 是"新 → 旧"，翻转成"旧 → 新"，帧号才和时间同向
  out.frames = vers.slice().reverse().map((v, i) => ({
    index: i,
    id: v.commit.id, time: v.commit.time, branch: v.commit.branch,
    message: v.commit.message, auto: !!v.commit.auto,
    hash: v.hash, exists: !!v.hash,
    changed: v.commit.changed
  }));
  return out;
}

/**
 * **时间轴回放的单帧内容**：某一帧里这个区块在 y 层的 16×16 方块名。
 *
 * `states` 的索引是 `z*16 + x`（相对区块的局部坐标，0..15）。
 * @param {{storeDir:string, world:string, dim?:string, kind?:string,
 *          cx:number, cz:number, y:number, id?:string, branch?:string, limit?:number}} o
 * @returns {{id:string, dim:string, kind:string, cx:number, cz:number, y:number,
 *            chunk:string, hash:string|null, states:Array<string|null>|null,
 *            supported:boolean, reason:string}}
 */
function frame(o) {
  const root = worldRoot(o.storeDir, o.world);
  const refs = readRefs(root);
  const id = o.id || refs[o.branch || readHead(root)];
  const dim = o.dim || 'overworld';
  const kind = o.kind || anvil.KIND.REGION;
  const cx = Math.trunc(Number(o.cx));
  const cz = Math.trunc(Number(o.cz));
  const y = Math.trunc(Number(o.y));
  const key = cx + ',' + cz;
  const out = {
    id: id || null, dim, kind, cx, cz, y, chunk: key,
    hash: null, states: null, supported: true, reason: ''
  };
  if (!id) return out;

  // 这一帧里该区块的 hash —— 沿父链找到最近的、显式提到它的那次提交
  let h = null;
  for (const c of chainTo(root, id, o.limit || 500).reverse()) {
    const d = (c.dims && c.dims[dim] && c.dims[dim][kind]) || null;
    if (!d) continue;
    if (d.add && Object.prototype.hasOwnProperty.call(d.add, key)) { h = d.add[key]; break; }
    if ((d.del || []).includes(key)) { h = null; break; }
  }
  out.hash = h;
  if (!h) { out.reason = '这一帧里这个区块还不存在'; return out; }

  const tree = parsedObject(root, h);
  if (!tree) { out.supported = false; out.reason = '区块对象读不出来'; return out; }
  const sup = blockstate.supportLevel(tree);
  out.supported = sup.ok;
  out.reason = sup.reason;
  out.states = blockstate.layerAt(tree, y);
  if (sup.ok && !out.states) out.reason = 'y=' + y + ' 这一层不在这个区块里';
  return out;
}

/* ================= 分支合并（自研三方合并） ================= */

/** 提交的全部父节点（第一父 + 合并父）。合并提交会是两个及以上。 */
function parentsOf(c) {
  const ps = [];
  if (c && c.parent) ps.push(c.parent);
  for (const m of ((c && c.merges) || [])) if (m) ps.push(m);
  return ps;
}

/**
 * 某个提交到各祖先的最短距离（BFS，走**全部**父节点，包括合并父）。
 * @returns {Map<string, number>}
 */
function ancestorDepths(root, start) {
  const depth = new Map();
  if (!start) return depth;
  const q = [[start, 0]];
  while (q.length) {
    const [id, d] = q.shift();
    if (!id || depth.has(id) || !hasCommit(root, id)) continue;
    depth.set(id, d);
    let c;
    try { c = readCommit(root, id); } catch { continue; }
    for (const p of parentsOf(c)) q.push([p, d + 1]);
  }
  return depth;
}

/**
 * 最近共同祖先（LCA）。
 *
 * 打分为 `max(到两边的最短距离)`，取最小；同分时取**时间更晚**的那个。
 * 只看第一父链的实现在合并图上会退化成"找到根提交"，于是两侧自打开始以来的
 * 全部改动都被判成冲突 —— 那等于没有合并能力。
 * @returns {string|null}
 */
function commonAncestor(root, a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  if (a === b) return a;
  const da = ancestorDepths(root, a);
  const db = ancestorDepths(root, b);
  let best = null;
  let bestScore = Infinity;
  let bestTime = -1;
  for (const [id, x] of da) {
    if (!db.has(id)) continue;
    const score = Math.max(x, db.get(id));
    let time = 0;
    try { time = readCommit(root, id).time || 0; } catch {}
    if (score < bestScore || (score === bestScore && time > bestTime)) {
      best = id; bestScore = score; bestTime = time;
    }
  }
  return best;
}

/** 支持的冲突策略 */
const MERGE_STRATEGIES = ['conflict', 'ours', 'theirs'];

/**
 * 把一个冲突区块拆到**方块级**看看到底冲不冲突。
 *
 * 这一步是给玩家看的，不是给机器看的：两个分支同时动了一个区块时，最常见的情况
 * 其实是"一个在盖房子、一个在挖矿"，改动位置完全不重叠 —— 那就不该吓唬人。
 * 只有**同一个方块位置两边都改、且改成了不同东西**才算真冲突。
 *
 * 代价：要把三份区块对象都解码一遍（最多 24 个 section × 4096）。所以只对
 * 前 `limit` 个冲突区块做，其余只报计数。
 *
 * @returns {{oursOnly:number, theirsOnly:number, bothSame:number, conflict:number,
 *            conflictSample:Array<object>, disjoint:boolean, decoded:boolean, reason:string,
 *            droppedOurs:{count:number,sample:Array<object>},
 *            droppedTheirs:{count:number,sample:Array<object>}}}
 */
function conflictDetail(root, o, bH, oH, tH) {
  const out = {
    oursOnly: 0, theirsOnly: 0, bothSame: 0, conflict: 0,
    conflictSample: [], disjoint: true, decoded: false, reason: '',
    // "整块取某一侧"这条退路会牺牲掉什么。
    // droppedOurs   = 取我方时被丢弃的方块（对方改的 + 真冲突）
    // droppedTheirs = 取对方时被丢弃的方块（我方改的 + 真冲突）
    droppedOurs: { count: 0, sample: [] },
    droppedTheirs: { count: 0, sample: [] }
  };
  const bT = bH ? parsedObject(root, bH) : null;
  const oT = oH ? parsedObject(root, oH) : null;
  const tT = tH ? parsedObject(root, tH) : null;
  if (!oT || !tT) { out.reason = '有一侧的区块对象读不出来'; return out; }
  const sup = blockstate.supportLevel(oT);
  if (!sup.ok) { out.reason = sup.reason; return out; }

  // 取两侧所有 section 的 Y 并集（base 可能缺某些层）
  const ys = new Set();
  for (const t of [bT, oT, tT]) {
    if (!t) continue;
    for (const sec of blockstate.sectionsOf(t)) ys.add(Number(sec.Y) || 0);
  }

  const SAMPLE_MAX = 20;
  /** 记一条"会被丢掉的改动"。x/z 用世界坐标，UI 上能直接照着找 */
  const note = (bucket, i, y, bv, ov, tv) => {
    bucket.count++;
    if (bucket.sample.length < SAMPLE_MAX) {
      bucket.sample.push({
        x: o.cx * 16 + (i % 16), y,
        z: o.cz * 16 + Math.floor(i / 16),
        base: bv, ours: ov, theirs: tv
      });
    }
  };

  for (const secY of [...ys].sort((a, c) => a - c)) {
    for (let ly = 0; ly < 16; ly++) {
      const y = secY * 16 + ly;
      const layerB = bT ? blockstate.layerAt(bT, y) : null;
      const layerO = blockstate.layerAt(oT, y);
      const layerT = blockstate.layerAt(tT, y);
      if (!layerO && !layerT) continue;
      for (let i = 0; i < 256; i++) {
        const ov = layerO ? layerO[i] : null;
        const tv = layerT ? layerT[i] : null;
        const bv = layerB ? layerB[i] : null;
        if (ov === tv) { if (ov !== bv) out.bothSame++; continue; }
        // 到这里两侧这一格已经不同了：无论按哪一侧落点，另一侧的那次改动都会消失。
        // 这就是"整块取一侧"的真实代价，必须逐格报出来，不能只给个冲突计数。
        if (ov === bv) { out.theirsOnly++; note(out.droppedOurs, i, y, bv, ov, tv); continue; }
        if (tv === bv) { out.oursOnly++; note(out.droppedTheirs, i, y, bv, ov, tv); continue; }
        out.conflict++;
        out.disjoint = false;
        note(out.droppedOurs, i, y, bv, ov, tv);
        note(out.droppedTheirs, i, y, bv, ov, tv);
        if (out.conflictSample.length < SAMPLE_MAX) {
          // i = z*16 + x（和 layerAt 的索引约定一致）
          out.conflictSample.push({
            x: o.cx * 16 + (i % 16), y,
            z: o.cz * 16 + Math.floor(i / 16),
            base: bv, ours: ov, theirs: tv
          });
        }
      }
    }
  }
  out.decoded = true;
  return out;
}

/**
 * **三方合并计划**（只读，不改任何东西）。
 *
 * 规则（区块级三方合并，标准语义）：
 *   · 两边一致                       → 就取这个值（谁都没改，或都改成了一样）
 *   · 我方 == 祖先、对方 != 祖先      → 取对方（只有对方改）
 *   · 对方 == 祖先、我方 != 祖先      → 取我方（只有我方改）
 *   · 两边都改了且不同                → 冲突，按 strategy 决定落点
 *
 * 快进：如果对方已经在我方的祖先里 → 无需合并；如果我方在对方的祖先里 → 可以直接快进。
 *
 * ✅ 冲突区块能做**方块级三方合流**（V5 第二组补完），所以"两边都改了"不再等于"必有损失"。
 *    合流能不能做，每条冲突上都带着预判结果 —— 计划书的语义是只读，只预判不产字节
 *    （而且要经 IPC 送到渲染层，塞几 MB 区块进去不合适）：
 *      · `mergeable` / `mergeCode` / `mergeReason` —— 能不能合、合不了的原因；
 *      · `mergeCells` —— 要改几格；`dropped` 只剩**真冲突**那些格（合流也救不回来）；
 *      · `mergeLightRisk` —— 会让几格的光照/高度图过时（如实上报，不替用户拒绝）。
 *
 *    两道**硬闸门**（宁可退回"整块取一侧"，也不做半吊子合并）：
 *      · 对方的改动落在我方没有的区段 —— 我们只能重写自己已有的 section；
 *      · 涉及**方块实体载体**（箱子/告示牌/刷怪笼）—— 容器内容不在这一层，
 *        硬合的结果是箱子变空，那是静默丢数据。
 *
 *    这两条退路的代价是**真实的数据丢失**，所以不能只报一个冲突计数：
 *      · `conflictDetail` 把冲突精确到方块；
 *      · `item.dropped / droppedSample` 逐格列出"按这个落点会丢掉哪些方块改动"；
 *      · `stats.droppedBlocks` 给出总和（`droppedPartial` 标明是否因为分析上限而截断）。
 *    `strategy:'conflict'`（默认）只拦**会丢东西**的那些（判据见 mergeApply）：
 *    损失为 0 的冲突自动合并 —— 和 git 一致，同一文件被两边改到不同位置不叫冲突。
 *
 * @param {{storeDir:string, world:string, ours?:string, theirs:string,
 *          strategy?:'conflict'|'ours'|'theirs', analyze?:boolean, analyzeLimit?:number}} o
 * @returns {object} 计划书：{ ok, upToDate, fastForward, base, ours, theirs, stats, dims, conflicts }
 */
/* ================= 方块级三方合并：产出真实区块字节 ================= */

/**
 * 找出区块里的方块实体列表（1.18+ 是顶层 `block_entities`，≤1.17 在 `Level.TileEntities`）。
 * @param {object} root
 * @returns {Array|null}
 */
function beListOf(root) {
  if (Array.isArray(root.block_entities)) return root.block_entities;
  const lv = root.Level && typeof root.Level === 'object' ? root.Level : null;
  if (lv && Array.isArray(lv.TileEntities)) return lv.TileEntities;
  if (Array.isArray(root.TileEntities)) return root.TileEntities;
  return null;
}

/**
 * 三方合并一个区块的方块层，**只算不写**：得出"要改哪些格"。
 *
 * 语义是标准 three-way：
 *   两边一样       → 不动
 *   只有一边变了   → 采纳变了的那边
 *   两边都变且不同 → 按策略取一边，计入 conflict
 *
 * 两条**硬拒绝**（宁可退回"整块取一侧"，也不做半吊子的合并）：
 *   ① 对方的改动落在**我方没有的区段**里。我们只能重写自己已有的 section，
 *      碰不到的地方谈不上合并。
 *   ② 涉及**方块实体载体**（箱子 / 告示牌 / 刷怪笼…）。容器里的内容不在这一层的
 *      能力范围内，硬合的结果是箱子变空、告示牌变白 —— 那是**静默丢数据**，
 *      比"光照过时"严重得多，所以这里宁可不算。
 *
 * 一条**如实报告**：改动两侧只要有一边不是"不透明完整方块"，这一格的光照和高度图
 * 就不再准确。这不损坏存档，但进游戏会表现为局部偏暗/偏亮、刷怪位置不对。
 * 逐格列进 lightRisk 交给调用方，而不是替用户咽下去。
 *
 * @param {object} rootO 我方区块
 * @param {object|null} rootB 共同祖先区块
 * @param {object} rootT 对方区块
 * @param {number} dv DataVersion
 * @param {'ours'|'theirs'} strategy 真冲突时整格取哪边
 * @param {{cx?:number, cz?:number}} [pos] 只用于把冲突坐标还原成世界坐标
 * @returns {{ok:boolean, reason:string, code:string, edits:Map<number, Map<number,string>>,
 *            lightRisk:Array<object>, conflictSample:Array<object>,
 *            conflict:number, oursOnly:number, theirsOnly:number, cells:number}}
 */
function chunkMergePlan(rootO, rootB, rootT, dv, strategy, pos) {
  const cx = pos && Number.isFinite(pos.cx) ? pos.cx : 0;
  const cz = pos && Number.isFinite(pos.cz) ? pos.cz : 0;
  const out = {
    ok: false, reason: '', code: '',
    edits: new Map(), lightRisk: [], conflictSample: [],
    conflict: 0, oursOnly: 0, theirsOnly: 0, cells: 0
  };
  const sup = blockstate.supportLevel(rootO);
  if (!sup.ok) { out.reason = sup.reason; out.code = 'UNSUPPORTED'; return out; }

  /** @type {Map<number, object>} */
  const secsO = new Map();
  for (const s of blockstate.sectionsOf(rootO)) secsO.set(Number(s.Y) || 0, s);

  const ys = new Set();
  for (const r of [rootO, rootB, rootT]) {
    if (!r) continue;
    for (const s of blockstate.sectionsOf(r)) ys.add(Number(s.Y) || 0);
  }

  for (const secY of [...ys].sort((a, b) => a - b)) {
    const hasO = secsO.has(secY);
    for (let ly = 0; ly < 16; ly++) {
      const y = secY * 16 + ly;
      const lO = blockstate.layerAt(rootO, y);
      const lT = rootT ? blockstate.layerAt(rootT, y) : null;
      const lB = rootB ? blockstate.layerAt(rootB, y) : null;
      if (!lO && !lT) continue;
      for (let i = 0; i < 256; i++) {
        const ov = lO ? lO[i] : null;
        const tv = lT ? lT[i] : null;
        const bv = lB ? lB[i] : null;
        if (ov === tv) continue;                                  // 两边一样 → 不动
        let target;
        if (ov === bv) { target = tv; out.theirsOnly++; }          // 只有对方改 → 采纳
        else if (tv === bv) { out.oursOnly++; continue; }          // 只有我方改 → 保持
        else {
          out.conflict++;
          target = strategy === 'theirs' ? tv : ov;
          // 真冲突记下样板：合流救不了这一格，它必然被覆盖一次，
          // 所以这份清单是"合流之后仍然会丢的东西"，得如实报给用户看
          if (out.conflictSample.length < 20) {
            out.conflictSample.push({
              x: cx * 16 + (i % 16), y, z: cz * 16 + Math.floor(i / 16),
              base: bv, ours: ov, theirs: tv
            });
          }
          if (strategy !== 'theirs') continue;                     // 取我方 = 不写
        }
        if (!hasO) {
          out.reason = '对方的改动落在我方没有的区段（y=' + secY + '），这块只能整段换';
          out.code = 'MISSING_SECTION';
          return out;
        }
        const beHit = blockstate.needsBlockEntity(ov) ? ov : (blockstate.needsBlockEntity(target) ? target : null);
        if (beHit) {
          out.reason = '涉及方块实体「' + beHit + '」，容器里的内容不在合并范围内';
          out.code = 'NEEDS_BLOCK_ENTITY';
          return out;
        }
        if (!blockstate.isOpaque(ov) || !blockstate.isOpaque(target)) {
          if (out.lightRisk.length < 200) {
            out.lightRisk.push({
              x: cx * 16 + (i % 16), y, z: cz * 16 + Math.floor(i / 16),
              from: ov, to: target
            });
          }
        }
        let m = out.edits.get(secY);
        if (!m) { m = new Map(); out.edits.set(secY, m); }
        m.set(ly * 256 + i, target);
        out.cells++;
      }
    }
  }
  out.ok = true;
  return out;
}

/**
 * 合并改了方块之后，把"位置上的方块已经换人"的方块实体删掉。
 *
 * 不删会留下什么：存档里一个坐标与方块类型对不上的方块实体。游戏遇到这种数据
 * 要么直接丢弃（箱子里的东西凭空消失），要么当成损坏区块。删掉反而**诚实** ——
 * 那个箱子本来就随着方块一起被覆盖掉了，留着它才是自欺欺人。
 *
 * @param {object} root 我方区块（就地修改）
 * @param {Map<number, Map<number, string>>} edits 已经决定要改的格
 * @returns {number} 删掉了几个
 */
function syncBlockEntities(root, edits) {
  const list = beListOf(root);
  if (!Array.isArray(list) || !list.length) return 0;
  const before = list.length;
  for (let i = list.length - 1; i >= 0; i--) {
    const be = list[i];
    if (!be || typeof be !== 'object') continue;
    const x = Number(be.x), y = Number(be.y), z = Number(be.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const secY = Math.floor(y / 16);
    const m = edits.get(secY);
    if (!m) continue;                                    // 这一层没有改动，方块实体保持原样
    const ly = y - secY * 16;
    const i2 = (((z % 16) + 16) % 16) * 16 + (((x % 16) + 16) % 16);
    const now = m.get(ly * 256 + i2);
    if (now === undefined) continue;                     // 这一格本身没被改
    const want = blockstate.baseName(now).replace(/^minecraft:/, '');
    const have = String(be.id || '').replace(/^minecraft:/, '');
    if (want !== have) list.splice(i, 1);
  }
  return before - list.length;
}

/**
 * 三方合并一个区块并**产出新的区块字节**。
 *
 * 这是里程碑一那条"只写版本库、不生成新字节"边界的补完。当时卡在 nbt.js 按 JS 值
 * 反推 NBT 类型：区块里的 `PostProcessing` 是 LIST of SHORT，值全是 0，写回去就变成
 * LIST of INT，游戏读这种区块直接报错。现在解析时可以带上类型旁路表（nbt.newTypes），
 * 写回时按原类型编码，才敢做这件事。
 *
 * 注意光照：合并只在**同一格替换方块**这个层面做，改动两侧都会让该格的光照与高度图
 * 过时（只要涉及空气或透明方块）。这一层不做光照重算 —— 那是独立的一块工作 ——
 * 所以把 lightRisk 逐格报出来，让调用方决定。
 *
 * @param {{base:Buffer|null, ours:Buffer, theirs:Buffer, strategy?:'ours'|'theirs',
 *          cx?:number, cz?:number}} o 三个区块的**未压缩** NBT 字节
 * @returns {{ok:boolean, code:string, reason:string, raw:Buffer|null, stats:object,
 *            lightRisk:Array<object>, conflictSample:Array<object>, unchanged?:boolean}}
 */
function mergeChunkBytes(o) {
  const strategy = o.strategy === 'theirs' ? 'theirs' : 'ours';
  const tO = nbt.newTypes();
  let parsedO, parsedT, parsedB = null;
  try { parsedO = nbt.parse(o.ours, tO); } catch (e) { return mfail('BAD_OURS', '我方区块解析失败: ' + e.message); }
  try { parsedT = nbt.parse(o.theirs, nbt.newTypes()); } catch (e) { return mfail('BAD_THEIRS', '对方区块解析失败: ' + e.message); }
  if (o.base) { try { parsedB = nbt.parse(o.base, nbt.newTypes()); } catch { parsedB = null; } }

  const rootO = parsedO.value;
  const dv = blockstate.dataVersionOf(rootO) || blockstate.dataVersionOf(parsedT.value);
  const p = chunkMergePlan(rootO, parsedB ? parsedB.value : null, parsedT.value, dv, strategy,
    { cx: o.cx, cz: o.cz });
  if (!p.ok) {
    return {
      ok: false, code: p.code, reason: p.reason, raw: null, stats: p,
      lightRisk: [], conflictSample: p.conflictSample
    };
  }
  // 一格都不用改（比如所有差异都落在"只有我方改"那边）→ 原样返回，别再走一遍编码
  if (!p.cells) {
    return {
      ok: true, code: '', reason: '', raw: o.ours, unchanged: true,
      lightRisk: [], conflictSample: p.conflictSample,
      stats: { cells: 0, conflict: p.conflict }
    };
  }

  /** @type {Map<number, object>} */
  const secsO = new Map();
  for (const s of blockstate.sectionsOf(rootO)) secsO.set(Number(s.Y) || 0, s);

  let touched = 0;
  for (const [secY, m] of p.edits) {
    const sec = secsO.get(secY);
    if (!sec) return mfail('MISSING_SECTION', '找不到 y=' + secY + ' 的区段');
    const r = blockstate.applyBlockEdits(sec, dv, m);
    if (!r.ok) return mfail('REWRITE_FAILED', r.reason);
    blockstate.writeBlockStates(sec, r, tO);
    touched += r.changed;
  }

  const removedBE = syncBlockEntities(rootO, p.edits);

  let raw;
  try { raw = nbt.serialize(parsedO.name, rootO, tO); }
  catch (e) { return mfail('SERIALIZE_FAILED', '写回失败: ' + e.message); }

  return {
    ok: true, code: '', reason: '', raw, lightRisk: p.lightRisk,
    conflictSample: p.conflictSample,
    stats: {
      cells: p.cells, touched, conflict: p.conflict,
      oursOnly: p.oursOnly, theirsOnly: p.theirsOnly,
      lightRisk: p.lightRisk.length, removedBlockEntities: removedBE
    }
  };
}

/** mergeChunkBytes 的失败返回值（统一形状，省得调用方到处判 undefined） */
function mfail(code, reason) {
  return { ok: false, code, reason, raw: null, lightRisk: [], conflictSample: [], stats: { cells: 0, conflict: 0 } };
}

/** 读对象库里的原始字节；读不到就返回 null（一次失败不该打断整份计划书） */
function tryObject(root, h) {
  if (!h) return null;
  try { const b = getObject(root, h); return b && b.length ? b : null; } catch { return null; }
}

function mergePlan(o) {
  const root = worldRoot(o.storeDir, o.world);
  const refs = readRefs(root);
  const oursName = o.ours || readHead(root);
  const theirsName = String(o.theirs || '').trim();
  const strategy = MERGE_STRATEGIES.includes(o.strategy) ? o.strategy : 'conflict';
  if (!theirsName) throw new Error('必须给出要合并进来的分支（theirs）');
  if (theirsName === oursName) throw new Error('不能把分支合并到它自己');
  const oursId = refs[oursName] || null;
  const theirsId = refs[theirsName] || null;
  if (!oursId) throw new Error('我方分支还没有提交: ' + oursName);
  if (!theirsId) throw new Error('对方分支不存在或还没有提交: ' + theirsName);

  const res = {
    ok: true, upToDate: false, fastForward: false, strategy,
    ours: oursName, theirs: theirsName,
    oursId, theirsId, base: null,
    stats: {
      unchanged: 0, oursOnly: 0, theirsOnly: 0, bothSame: 0, conflict: 0,
      added: 0, removed: 0, droppedBlocks: 0,
      mergeableChunks: 0, mergedCells: 0, lightRiskBlocks: 0
    },
    dims: [], conflicts: [], analysisCap: o.analyzeLimit || 20
  };

  if (oursId === theirsId) { res.upToDate = true; return res; }

  const fromOurs = ancestorDepths(root, oursId);
  if (fromOurs.has(theirsId)) {           // 对方是我方的祖先：早就合过了
    res.upToDate = true;
    res.base = theirsId;
    return res;
  }
  const fromTheirs = ancestorDepths(root, theirsId);
  if (fromTheirs.has(oursId)) {           // 我方是对方的祖先：直接快进
    res.fastForward = true;
    res.base = oursId;
    return res;
  }

  const baseId = commonAncestor(root, oursId, theirsId);
  res.base = baseId;

  const B = baseId ? indexOf(root, baseId) : emptyState();
  const O = indexOf(root, oursId);
  const T = indexOf(root, theirsId);
  const merged = emptyState();
  /** @type {Map<string, {dim:string,kind:string,k:string,b:string|undefined,o:string|undefined,t:string|undefined}>} */
  const conflictKeys = new Map();

  for (const dim of DIM_KEYS) {
    const row = { dim, label: anvil.dimInfo(dim).label, oursOnly: 0, theirsOnly: 0, bothSame: 0, conflict: 0, added: 0, removed: 0 };
    for (const kind of KINDS) {
      const key = dk(dim, kind);
      const b = B.get(key) || new Map();
      const oU = O.get(key) || new Map();
      const tH = T.get(key) || new Map();
      const m = merged.get(key);
      const keys = new Set([...oU.keys(), ...tH.keys(), ...b.keys()]);
      for (const k of keys) {
        const bv = b.get(k);
        const ov = oU.get(k);
        const tv = tH.get(k);
        let pick;
        if (ov === tv) {
          pick = ov;
          if (ov !== bv) { res.stats.bothSame++; row.bothSame++; }
          else res.stats.unchanged++;
        } else if (ov === bv) {
          pick = tv; res.stats.theirsOnly++; row.theirsOnly++;
        } else if (tv === bv) {
          pick = ov; res.stats.oursOnly++; row.oursOnly++;
        } else {
          res.stats.conflict++; row.conflict++;
          conflictKeys.set(key + '|' + k, { dim, kind, k, b: bv, o: ov, t: tv });
          pick = strategy === 'theirs' ? tv : ov;      // 默认把我方保留下来
        }
        if (pick != null) m.set(k, pick);
      }
    }
    // 相对我方算增删，让"这次合并到底动了几块"有数
    for (const kind of KINDS) {
      const key = dk(dim, kind);
      const m = merged.get(key);
      const oU = O.get(key) || new Map();
      for (const k of m.keys()) if (!oU.has(k) && !(T.get(key) || new Map()).has(k)) row.added++;
      for (const k of oU.keys()) if (!m.has(k)) row.removed++;
    }
    res.stats.added += row.added;
    res.stats.removed += row.removed;
    if (row.oursOnly || row.theirsOnly || row.bothSame || row.conflict || row.added || row.removed) res.dims.push(row);
  }

  // 冲突清单（含方块级分析）
  let analyzed = 0;
  for (const c of conflictKeys.values()) {
    const item = {
      dim: c.dim, kind: c.kind, chunk: c.k,
      base: c.b || null, ours: c.o || null, theirs: c.t || null,
      resolved: strategy === 'theirs' ? c.t || null : c.o || null
    };
    if (o.analyze !== false && analyzed < res.analysisCap) {
      analyzed++;
      const cx = Number(c.k.split(',')[0]);
      const cz = Number(c.k.split(',')[1]);
      item.detail = conflictDetail(root, { cx, cz }, c.b || null, c.o || null, c.t || null);
      // 把"这次落点会丢掉哪些方块"提到顶层，别埋在 detail 里。
      // 整块取一侧是本实现当前的硬边界，丢了多少必须是个显眼的数字 —
      // 否则用户以为合完了，实际自己刚建的房子少了一面墙。
      const d = item.detail;
      const loss = strategy === 'theirs' ? d.droppedTheirs : d.droppedOurs;
      item.dropped = loss.count;
      item.droppedSample = loss.sample;
      item.originalDropped = loss.count;
      res.stats.droppedBlocks += loss.count;
    }

    // 能不能做**方块级合流**？这里只预判，不产出字节 —— 计划书的语义是只读，
    // 而且它要经 IPC 送到渲染层，塞几 MB 的区块进去不合适。
    // 真正产出放在 mergeApply 里重算一遍（同一份输入的结果是确定的）。
    if (o.mergeChunks !== false && c.o && c.t) {
      const oRaw = tryObject(root, c.o);
      const tRaw = tryObject(root, c.t);
      if (oRaw && tRaw) {
        const mr = mergeChunkBytes({
          base: c.b ? tryObject(root, c.b) : null,
          ours: oRaw, theirs: tRaw,
          cx: Number(c.k.split(',')[0]), cz: Number(c.k.split(',')[1]),
          strategy: strategy === 'theirs' ? 'theirs' : 'ours'
        });
        item.mergeable = !!mr.ok;
        item.mergeCode = mr.code || '';
        item.mergeReason = mr.reason || '';
        item.mergeCells = (mr.stats && mr.stats.cells) || 0;
        item.mergeLightRisk = (mr.stats && mr.stats.lightRisk) || 0;
        if (mr.ok) {
          res.stats.mergeableChunks++;
          res.stats.mergedCells += item.mergeCells;
          res.stats.lightRiskBlocks += item.mergeLightRisk;
          // 合流之后损失只剩"真冲突"那些格：每格必然被覆盖一次，合流也救不了。
          // 不能一看到 mr.ok 就把损失清零 —— 那样 UI 会显示"丢了 0 个方块"，
          // 而用户真正被覆盖掉的那一格从此没人提。
          res.stats.droppedBlocks -= (item.originalDropped || 0);
          item.dropped = (mr.stats && mr.stats.conflict) || 0;
          item.droppedSample = mr.conflictSample || [];
          res.stats.droppedBlocks += item.dropped;
        }
      }
    }
    res.conflicts.push(item);
  }
  res.conflictsAnalyzed = analyzed;
  // 方块级分析是按需截断的，截断时这个总数只覆盖被分析过的区块 —— 如实标注
  res.droppedPartial = analyzed < res.conflicts.length;

  // 合并提交的增量必须**相对我方**存 —— indexOf 只沿第一父链回溯。
  // 存成"相对对方的增量"会让重建出来的状态整个错位，而且不会有任何报错。
  const dimsOut = {};
  for (const dim of DIM_KEYS) {
    dimsOut[dim] = {};
    for (const kind of KINDS) {
      const key = dk(dim, kind);
      const m = merged.get(key) || new Map();
      const cur = O.get(key) || new Map();
      const add = {};
      const del = [];
      let count = 0;
      let bytes = 0;
      for (const [k, h] of m) {
        count++;
        bytes += objSize(root, h);
        if (cur.get(k) !== h) add[k] = h;
      }
      for (const k of cur.keys()) if (!m.has(k)) del.push(k);
      dimsOut[dim][kind] = { add, del, count, bytes };
    }
  }
  res.delta = dimsOut;
  res.conflictCount = res.conflicts.length;
  res.clean = res.conflictCount === 0;
  return res;
}

/**
 * **执行合并**：生成一个合并提交（两个父：我方 + 对方）。
 *
 * 默认只拦**会丢东西**的合并：冲突区块先试方块级合流，只有"合不了的"或"合完还有真冲突"
 * 的才需要用户点头（`allowConflicts:true` 时按 strategy 落点，并把完整清单记进提交里）。
 * 损失为 0 的冲突**自动合并** —— 这和 git 的语义一致：同一个文件被两边改到不同位置
 * 不叫冲突，只有同一处改得不一样才要人决定。理由和 checkout 一样：合并出错的代价是
 * 玩家几百小时的世界，不该"默默按某一侧赢"。
 *
 * 注意：本操作**只写对象库与提交图，不碰存档目录**。要把合并结果落到磁盘，
 * 合并完切到该分支再调 checkout。
 *
 * @param {{storeDir:string, world:string, ours?:string, theirs:string, message?:string,
 *          strategy?:'conflict'|'ours'|'theirs', allowConflicts?:boolean,
 *          analyze?:boolean, analyzeLimit?:number, mergeChunks?:boolean}} o
 */
function mergeApply(o) {
  const root = ensureStore(o.storeDir, o.world);
  const plan = mergePlan(Object.assign({}, o, { storeDir: o.storeDir }));
  if (plan.upToDate) {
    return { ok: true, upToDate: true, id: plan.oursId, branch: plan.ours, plan };
  }
  const refs = readRefs(root);
  const branch = o.ours || readHead(root);
  if (plan.fastForward) {
    refs[branch] = plan.theirsId;
    writeRefs(root, refs);
    return { ok: true, fastForward: true, id: plan.theirsId, branch, plan };
  }
  // 默认（strategy:'conflict'）拦的是「**会丢东西**的合并」，判据不是"有没有区块冲突"。
  //
  // V5 第二组之前这两件事是一回事：冲突区块只能整块取一侧，所以"有冲突"就等于"有损失"。
  // 现在冲突区块能做方块级三方合流，两侧改的是不同格时损失是 **0** —— 再拿
  // `conflictCount > 0` 去拦，就会出现计划书自己写着「可合流、损失归零」、
  // 执行时却报「有 1 个区块冲突未解决」的自相矛盾。git 也是这个语义。
  //
  // 判据必须是**逐块**检查，不能只看 `stats.droppedBlocks`：史前字节格式的区块压根
  // 解码不了（conflictDetail 的 decoded=false），算出来的损失是 0 —— 那是"算不出来"
  // 而不是"没有"，必须当成有损失拦下来；分析被 analyzeLimit 截断时同理（那些块压根
  // 没被分析过，`mergeable` 是 undefined）。把"不知道"当成"没事"就是静默丢数据。
  const risky = plan.conflicts.filter((c) => !c.mergeable || (c.dropped || 0) > 0);
  if (risky.length && !o.allowConflicts) {
    // 抛的错要带上**计划书**：UI 得靠它把冲突显示到方块级。
    // 只丢一句话出去，用户就只能看到"有 3 个冲突"，然后无从下手。
    const unmergeable = plan.conflicts.filter((c) => !c.mergeable).length;
    /** @type {Error & {code?:string, plan?:object}} */
    const e = new Error('合并会丢东西：' + plan.conflictCount + ' 个区块两边都改了，其中 '
      + risky.length + ' 个救不回来（' + unmergeable + ' 个无法合流，'
      + (plan.stats.droppedBlocks || 0) + ' 处方块改动会被覆盖），已中止'
      + '（可传 allowConflicts 接受损失并按策略落点）');
    e.code = 'MERGE_CONFLICT';
    e.plan = plan;
    throw e;
  }

  // ★ 方块级合流：把"能合的"冲突区块真的合出来，写进对象库，并把增量里的落点
  //   换成合并结果的 hash。合不了的保持原样（按策略整块取一侧，丢了多少已经量化过）。
  //   注意这里**不碰存档目录** —— mergeApply 的既有语义就是只写版本库，
  //   要落盘仍然是合并完切到该分支再 checkout。这条边界不因为"能产字节了"就破掉。
  const produced = [];
  let lightRiskTotal = 0;
  if (o.mergeChunks !== false && plan.conflicts && plan.conflicts.length) {
    for (const c of plan.conflicts) {
      if (!c.mergeable || !c.ours || !c.theirs) continue;
      const oRaw = tryObject(root, c.ours);
      const tRaw = tryObject(root, c.theirs);
      if (!oRaw || !tRaw) continue;
      const mr = mergeChunkBytes({
        base: c.base ? tryObject(root, c.base) : null,
        ours: oRaw, theirs: tRaw,
        cx: Number(c.chunk.split(',')[0]), cz: Number(c.chunk.split(',')[1]),
        strategy: plan.strategy === 'theirs' ? 'theirs' : 'ours'
      });
      if (!mr.ok || !mr.raw) {
        c.mergeable = false;
        c.mergeReason = mr.reason || '合流失败';
        continue;
      }
      const put = putObject(root, mr.raw);
      const d = (plan.delta[c.dim] || {})[c.kind];
      if (d) {
        const di = d.del.indexOf(c.chunk);
        if (di >= 0) d.del.splice(di, 1);      // 合流后这个区块存在了，不能再算"删除"
        d.add[c.chunk] = put.hash;
      }
      c.resolved = put.hash;
      c.merged = true;
      c.mergedCells = mr.stats.touched;
      c.removedBlockEntities = mr.stats.removedBlockEntities;
      c.lightRisk = mr.stats.lightRisk;
      lightRiskTotal += mr.stats.lightRisk;
      produced.push({
        dim: c.dim, kind: c.kind, chunk: c.chunk,
        hash: put.hash, bytes: mr.raw.length, stats: mr.stats
      });
    }
  }

  const id0 = newId();
  let id = id0;
  let n = 1;
  while (hasCommit(root, id)) id = id0 + '-' + (++n);

  let addTotal = 0;
  let delTotal = 0;
  for (const dim of Object.keys(plan.delta)) {
    for (const kind of Object.keys(plan.delta[dim])) {
      const d = plan.delta[dim][kind];
      addTotal += Object.keys(d.add).length;
      delTotal += d.del.length;
    }
  }

  const record = {
    id,
    time: Date.now(),
    world: o.world,
    branch,
    parent: plan.oursId,
    merges: [plan.theirsId],
    mergeInto: plan.ours,
    mergeFrom: plan.theirs,
    message: o.message || ('合并 ' + plan.theirs + ' 到 ' + plan.ours),
    auto: false,
    dims: plan.delta,
    changed: { add: addTotal, del: delTotal, total: addTotal + delTotal },
    conflicts: plan.conflicts.map((c) => ({
      dim: c.dim, kind: c.kind, chunk: c.chunk,
      resolved: c.resolved,
      blockConflict: c.detail ? c.detail.conflict : null,
      // 记下这次落点丢掉的方块数：事后回查"我那次合并到底损失了什么"时，
      // 提交里只有 resolved 的 hash 是查不出来这件事的
      dropped: c.dropped == null ? null : c.dropped
    })),
    droppedBlocks: plan.stats.droppedBlocks || 0,
    // 这一轮新补的两笔账：真的合掉了几个区块、有多少格的光照会过时。
    // 事后回查"我那次合并到底做了什么"时，只看 conflicts 是看不出来的。
    mergedChunks: produced.length,
    lightRiskBlocks: lightRiskTotal,
    newBytes: 0,
    broken: 0
  };
  fs.writeFileSync(commitPath(root, id), JSON.stringify(record));
  refs[branch] = id;
  writeRefs(root, refs);
  // 合并提交的索引不是从第一父链能推出来的？其实**能** —— 因为 dims 存的就是
  // "从我方状态到我方+对方状态"的增量，沿第一父回溯照样重建得对。
  const mergedState = emptyState();
  // 直接复用 plan 期间的合并结果会跨出 mergePlan 的作用域，这里用增量套一遍最省事
  for (const dim of DIM_KEYS) {
    for (const kind of KINDS) {
      const key = dk(dim, kind);
      const d = (plan.delta[dim] || {})[kind] || { add: {}, del: [] };
      const base = indexOf(root, plan.oursId).get(key) || new Map();
      const m = mergedState.get(key);
      for (const [k, h] of base) m.set(k, h);
      for (const k of d.del) m.delete(k);
      for (const k of Object.keys(d.add)) m.set(k, d.add[k]);
    }
  }
  cacheSet(root + '#' + id, mergedState);
  return {
    ok: true, upToDate: false, fastForward: false, id, branch,
    conflicts: record.conflicts.length, plan,
    mergedChunks: produced.length,
    mergedBytes: produced.reduce((n, x) => n + x.bytes, 0),
    lightRiskBlocks: lightRiskTotal,
    produced
  };
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
  DEFAULT_BRANCH, KINDS, DIM_KEYS, MERGE_STRATEGIES, worldKeyOf, worldRoot,
  ensureStore, readRefs, readHead, readCommit, hasCommit,
  putObject, getObject, objSize, hasObject,
  indexOf, chainTo, clearCache, clearObjCache, parsedObject,
  init, commit, status, log, diff, blame, tree,
  branches, createBranch, switchBranch, deleteBranch,
  checkout, gc, stats, listWorlds, snapshotIndex,
  /* V5 第一组：方块级 blame / 时间轴回放 / 自研三方合并 */
  blameBlock, timeline, frame,
  parentsOf, ancestorDepths, commonAncestor, conflictDetail, mergePlan, mergeApply,
  /* V5 第二组：合并产出真实区块字节（配合 nbt 的保类型写入端） */
  chunkMergePlan, mergeChunkBytes, beListOf, syncBlockEntities
};
