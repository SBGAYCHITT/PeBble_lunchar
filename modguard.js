// Pebble Lunchar - Mod 守卫（"后悔药"）
//
// 别的启动器做到哪一步：PCL2 / HMCL 能列出 mod、能开关、部分能做依赖检查。
// 但"我刚更新了 12 个 mod，进游戏崩了，到底是哪个？"这件事它们都帮不上忙——
// 你只能靠记忆一个个退回。
//
// 这里做三件事，且全部本地完成、不联网：
//   1. 解析每个 mod jar 里的元数据（fabric.mod.json / mods.toml / mcmod.info / quilt.mod.json），
//      拿到真实的 modId、版本、载入器、MC 版本区间、依赖项——而不是靠文件名猜。
//   2. 在任何 mod 变动前自动打快照（复用 savetimemachine 的块级去重，几乎不占空间），
//      出事后一键回到"上次能进游戏"的组合，并且能告诉你这次到底改了什么。
//   3. 破坏性变更预检：载入器装错、MC 版本不 match、依赖缺失、同 ID 重复——
//      在按下启动之前就报出来。

const fs = require('fs');
const path = require('path');
const zip = require('./zipread');
const tm = require('./savetimemachine');

const DISABLED = '.disabled';
const MOD_EXTS = ['.jar', '.zip', '.litemod'];

// jar 内元数据文件的查找顺序（越靠前越优先）
const META_CANDIDATES = [
  'fabric.mod.json',
  'quilt.mod.json',
  'META-INF/neoforge.mods.toml',
  'META-INF/mods.toml',
  'mcmod.info'
];

// 这些依赖 id 由启动器/载入器提供，不需要玩家自己装
const BUILTIN_DEPS = new Set([
  'minecraft', 'forge', 'neoforge', 'fabricloader', 'fabric', 'fabric-api',
  'quilt_loader', 'quilt_base', 'java', 'minecraftforge', 'fml', 'neoforged'
]);

/* ---------------- 版本比较 ---------------- */
function cmpVer(a, b) {
  const pa = String(a).split(/[.\-+]/);
  const pb = String(b).split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = parseInt(pa[i], 10);
    const y = parseInt(pb[i], 10);
    if (isNaN(x) && isNaN(y)) continue;
    if (isNaN(x)) return -1;
    if (isNaN(y)) return 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * 判断 MC 版本是否满足依赖区间
 * 支持：[1.19.4,1.20)  (1.20,1.21]  >=1.20  <1.21  =1.20.1  1.20.x  1.20.*  1.20.1
 */
function mcSatisfies(mc, range) {
  if (!range || !mc) return true;
  const r = String(range).trim();
  if (!r || r === '*') return true;

  // 逗号分隔的多个条件里，只要含 MC 语义的区间就交给下面处理；
  // 这里先处理区间
  const m = r.match(/^([\[\(])\s*([^,]*)\s*,\s*([^\]\)]*)\s*([\]\)])$/);
  if (m) {
    const loInc = m[1] === '[';
    const hiInc = m[4] === ']';
    const lo = m[2].trim();
    const hi = m[3].trim();
    if (lo && cmpVer(mc, lo) < (loInc ? 0 : 1)) return false;   // mc < lo 或 mc <= lo（不含）
    if (hi && cmpVer(mc, hi) > (hiInc ? 0 : -1)) return false;  // mc > hi 或 mc >= hi（不含）
    return true;
  }

  const op = r.match(/^(>=|<=|==|=|>|<)\s*(.+)$/);
  if (op) {
    const c = cmpVer(mc, op[2].trim());
    switch (op[1]) {
      case '>=': return c >= 0;
      case '<=': return c <= 0;
      case '>': return c > 0;
      case '<': return c < 0;
      default: return c === 0;
    }
  }

  // 1.20.x / 1.20.* → 前缀匹配
  const wild = r.match(/^(\d+)\.(\d+)\.\s*[xX*]$/);
  if (wild) {
    const parts = String(mc).split('.');
    return parts[0] === wild[1] && parts[1] === wild[2];
  }
  const wild2 = r.match(/^(\d+)\.\s*[xX*]$/);
  if (wild2) return String(mc).split('.')[0] === wild2[1];

  return cmpVer(mc, r) === 0;
}

/* ---------------- TOML（只解析我们关心的键） ---------------- */
// Forge 的 mods.toml 是标准 TOML，但为了它去引一个 TOML 库不值得。
// 这里做"够用"的解析：只要 modId / version / displayName / 依赖块。
function parseModsToml(text) {
  const out = { mods: [], deps: [], modLoader: '', loaderVersion: '' };
  let section = '';
  /** @type {any} */
  let curMod = null;
  /** @type {any} */
  let curDep = null;

  const flushDep = () => {
    if (curDep && curDep.modId) out.deps.push(curDep);
    curDep = null;
  };
  const flushMod = () => {
    flushDep();
    if (curMod && (curMod.modId || curMod.modid)) out.mods.push(curMod);
    curMod = null;
  };

  for (let raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('[[')) {
      flushMod();
      const name = line.slice(2, line.indexOf(']]')).trim();
      if (name === 'mods') { curMod = {}; section = 'mods'; }
      else if (name.startsWith('dependencies')) { curDep = {}; section = 'dep'; }
      else { section = name; }
      continue;
    }
    if (line.startsWith('[')) {
      flushMod();
      section = line.slice(1, line.indexOf(']')).trim();
      continue;
    }

    const kv = line.match(/^([A-Za-z0-9_\-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();
    // 去掉行尾注释（粗粒度，够用）
    const q = val.match(/^("([^"\\]|\\.)*"|'([^'\\]|\\.)*')/);
    if (q) {
      val = q[1].slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else {
      const bare = val.match(/^[^#]+/);
      val = bare ? bare[0].trim() : '';
      if (val.endsWith(',')) val = val.slice(0, -1).trim();
    }

    if (section === 'mods' && curMod) {
      if (key === 'modId') curMod.modId = val;
      else if (key === 'version') curMod.version = val;
      else if (key === 'displayName' || key === 'displayname') curMod.displayName = val;
    } else if (section === 'dep' && curDep) {
      if (key === 'modId') curDep.modId = val;
      else if (key === 'versionRange') curDep.versionRange = val;
      else if (key === 'mandatory') curDep.mandatory = (val === 'true');
      else if (key === 'ordering') curDep.ordering = val;
    } else if (section === '') {
      if (key === 'modLoader') out.modLoader = val;
      else if (key === 'loaderVersion') out.loaderVersion = val;
    }
  }
  flushMod();
  return out;
}

/* ---------------- 单个 mod 的元数据 ---------------- */
function parseFabricJson(j) {
  const ql = j.quilt_loader;
  if (ql) {
    const deps = [];
    const push = (arr) => { for (const d of arr || []) deps.push({ modId: d.id, versionRange: d.versions, mandatory: true }); };
    push(ql.depends);
    if (ql.depends && !Array.isArray(ql.depends)) {
      for (const k of Object.keys(ql.depends)) deps.push({ modId: k, versionRange: ql.depends[k], mandatory: true });
    }
    return {
      id: ql.id, name: (ql.metadata && ql.metadata.name) || ql.id,
      version: ql.version, loader: 'quilt', deps
    };
  }
  const deps = [];
  const collect = (obj) => {
    if (!obj) return;
    for (const k of Object.keys(obj)) deps.push({ modId: k, versionRange: obj[k], mandatory: true });
  };
  collect(j.depends);
  collect(j.requires);
  return {
    id: j.id, name: j.name || j.id, version: j.version, loader: 'fabric', deps
  };
}

function parseMcmodInfo(j) {
  const arr = Array.isArray(j) ? j : [j];
  const list = arr[0] && arr[0].modList ? arr[0].modList : arr;
  const first = list[0] || {};
  return {
    id: first.modid || '',
    name: first.name || first.modid || '',
    version: first.version || '',
    loader: 'forge',
    mcRange: first.mcversion || '',
    legacy: true,
    deps: (first.dependencies || []).map((d) => ({ modId: d.modId || d, versionRange: d.versionRange, mandatory: d.mandatory !== false }))
  };
}

function parseMeta(name, text) {
  if (name.endsWith('.toml')) {
    const t = parseModsToml(text);
    const m = t.mods[0] || {};
    const isNeo = /neoforge/i.test(name);
    const mcDep = t.deps.find((d) => d.modId === 'minecraft' || d.modId === 'minecraftforge');
    return {
      id: m.modId || '',
      name: m.displayName || m.modId || '',
      version: m.version || '',
      loader: isNeo ? 'neoforge' : 'forge',
      deps: t.deps,
      mcRange: (t.deps.find((d) => d.modId === 'minecraft') || {}).versionRange || (mcDep ? mcDep.versionRange : '')
    };
  }
  if (name === 'mcmod.info') {
    try { return parseMcmodInfo(JSON.parse(text)); } catch { return null; }
  }
  try { return parseFabricJson(JSON.parse(text)); } catch { return null; }
}

/* ---------------- 扫描 ---------------- */
const cache = new Map(); // 同一个文件（路径+大小+mtime）只解析一次

function readModMeta(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const key = file + '|' + st.size + '|' + Math.floor(st.mtimeMs);
  if (cache.has(key)) return cache.get(key);

  let meta = null;
  try {
    const hit = zip.readFirst(file, META_CANDIDATES);
    if (hit) meta = parseMeta(hit.name, hit.data.toString('utf8'));
  } catch {}
  if (!meta) meta = { id: '', name: '', version: '', loader: '', deps: [], unknown: true };
  if (!meta.mcRange) meta.mcRange = '';

  if (cache.size > 500) cache.clear(); // 防止长时间运行无限增长
  cache.set(key, meta);
  return meta;
}

/**
 * 扫描 mods 目录
 * @returns {{mods:Array, dir:string, ok:boolean}}
 */
function scan({ modsDir }) {
  const out = [];
  let items = [];
  try { items = fs.readdirSync(modsDir); } catch { return { mods: out, dir: modsDir, ok: false }; }

  for (const name of items) {
    const disabled = name.endsWith(DISABLED);
    const real = disabled ? name.slice(0, -DISABLED.length) : name;
    if (!MOD_EXTS.some((e) => real.toLowerCase().endsWith(e))) continue;
    const abs = path.join(modsDir, name);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (!st.isFile()) continue;

    const meta = readModMeta(abs) || { id: '', name: '', version: '', loader: '', deps: [], unknown: true };
    out.push({
      file: name,
      real,
      path: abs,
      size: st.size,
      mtime: st.mtimeMs,
      enabled: !disabled,
      id: meta.id || '',
      name: meta.name || real,
      version: meta.version || '',
      loader: meta.loader || '',
      mcRange: meta.mcRange || '',
      deps: meta.deps || [],
      unknown: !!meta.unknown
    });
  }
  out.sort((a, b) => a.real.localeCompare(b.real));
  return { mods: out, dir: modsDir, ok: true };
}

/** 载入器兼容矩阵：行=实例载入器，列=mod 载入器 */
const LOADER_OK = {
  fabric: { fabric: true, quilt: 'warn', forge: false, neoforge: false },
  quilt: { fabric: 'warn', quilt: true, forge: false, neoforge: false },
  forge: { fabric: false, quilt: false, forge: true, neoforge: false },
  neoforge: { fabric: false, quilt: false, forge: false, neoforge: true },
  vanilla: { fabric: false, quilt: false, forge: false, neoforge: false }
};

/** 从 mod 自身的元数据里推断实例用的是哪个载入器（取出现次数最多的） */
function inferLoader(mods, instanceHint) {
  const tally = new Map();
  for (const m of mods) {
    if (!m.enabled || !m.loader) continue;
    tally.set(m.loader, (tally.get(m.loader) || 0) + 1);
  }
  if (!tally.size) return instanceHint || '';
  let best = '', n = 0;
  for (const [k, v] of tally) if (v > n) { best = k; n = v; }
  // quilt 与 fabric 生态互通，归到同一边统计，否则容易误判
  const fabricSide = (tally.get('fabric') || 0) + (tally.get('quilt') || 0);
  if (fabricSide > n) best = tally.get('fabric') >= (tally.get('quilt') || 0) ? 'fabric' : 'quilt';
  return best;
}

/**
 * 破坏性变更预检
 * @param {{modsDir:string, mcVersion?:string, loader?:string}} o
 *   loader 传 'auto' 或留空时，从 mod 元数据里推断（少数派会被判为装错生态）
 */
function analyze({ modsDir, mcVersion, loader }) {
  const { mods, ok } = scan({ modsDir });
  const issues = [];
  const byId = new Map();

  const hint = (loader || '').toLowerCase();
  const effective = (hint === 'auto' || !hint) ? inferLoader(mods, '') : hint;
  const inferred = !hint || hint === 'auto';

  for (const m of mods) {
    if (!m.enabled) continue; // 被禁用的不参与检查

    // 1) 元数据无法识别
    if (m.unknown || !m.id) {
      issues.push({ level: 'info', file: m.file, title: '无法识别元数据', detail: '读不到 modId（可能是 .litemod / 打包不规范 / 加密 jar），依赖与版本检查已跳过。' });
    }

    // 2) 载入器不匹配 —— 崩溃的头号原因
    const want = (effective || 'vanilla').toLowerCase();
    const got = (m.loader || '').toLowerCase();
    if (got && want && LOADER_OK[want] && LOADER_OK[want][got] === false) {
      issues.push({
        level: 'error', file: m.file, title: '载入器不匹配',
        detail: inferred
          ? `这是 ${got} 的 mod，但同目录里大多数是 ${want}，混装生态几乎必定崩溃。`
          : `这是 ${got} 的 mod，但当前实例是 ${want}。进游戏几乎必定崩溃。`
      });
    } else if (got && want && LOADER_OK[want] && LOADER_OK[want][got] === 'warn') {
      issues.push({ level: 'warn', file: m.file, title: '载入器跨生态', detail: `${got} mod 跑在 ${want} 上，通常能用但不保证。` });
    }

    // 3) MC 版本不匹配（从依赖里取 minecraft 区间）
    const mcDep = (m.deps || []).find((d) => d.modId === 'minecraft');
    const range = mcDep ? mcDep.versionRange : m.mcRange;
    if (mcVersion && range && !mcSatisfies(mcVersion, range)) {
      issues.push({ level: 'error', file: m.file, title: 'MC 版本不匹配', detail: `要求 ${range}，当前实例是 ${mcVersion}。` });
    }

    // 4) 同 ID 重复
    if (m.id) {
      if (byId.has(m.id)) {
        issues.push({ level: 'error', file: m.file, title: '重复 mod', detail: `与 ${byId.get(m.id).file} 的 modId 相同（${m.id}），同时加载会崩溃。` });
      } else {
        byId.set(m.id, m);
      }
    }
  }

  // 5) 依赖缺失（只检查已启用的 mod 的必需依赖）
  const present = new Set(mods.filter((m) => m.enabled && m.id).map((m) => m.id));
  const disabledIds = new Set(mods.filter((m) => !m.enabled && m.id).map((m) => m.id));
  for (const m of mods) {
    if (!m.enabled) continue;
    for (const d of m.deps || []) {
      if (!d.mandatory) continue;
      const id = d.modId;
      if (!id || BUILTIN_DEPS.has(id.toLowerCase())) continue;
      if (present.has(id)) continue;
      if (disabledIds.has(id)) {
        issues.push({ level: 'warn', file: m.file, title: '依赖被禁用', detail: `需要 ${id}${d.versionRange ? ' ' + d.versionRange : ''}，它存在但被禁用了。` });
      } else {
        issues.push({ level: 'error', file: m.file, title: '依赖缺失', detail: `需要 ${id}${d.versionRange ? ' ' + d.versionRange : ''}，但 mods 目录里没有。` });
      }
    }
  }

  const order = { error: 0, warn: 1, info: 2 };
  issues.sort((a, b) => order[a.level] - order[b.level]);
  return {
    mods, issues, ok,
    loader: effective, loaderInferred: inferred,
    hasError: issues.some((i) => i.level === 'error')
  };
}

/* ---------------- 变更对比 ---------------- */
/** 对比两次 scan 的结果，返回人类可读的变更列表 */
function diff(before, after) {
  // 快照里存的 modList 只有 file 字段，实时扫描出来的是 real 字段，统一一下
  const key = (m) => m.real || m.file;
  const bmap = new Map((before.mods || before || []).map((m) => [key(m), m]));
  const amap = new Map((after.mods || after || []).map((m) => [key(m), m]));

  const added = [], removed = [], updated = [];
  for (const [k, m] of amap) {
    const b = bmap.get(k);
    if (!b) { added.push(m); continue; }
    // 快照里的 modList 没存 size，只有两边都有 size 时才比大小，否则会误报"全部被改过"
    const sizeChanged = (b.size != null && m.size != null) && b.size !== m.size;
    if (b.version !== m.version || sizeChanged) {
      const down = cmpVer(m.version || '0', b.version || '0') < 0;
      updated.push({ file: k, from: b.version || '?', to: m.version || '?', downgrade: down });
    }
  }
  for (const [k, m] of bmap) if (!amap.has(k)) removed.push(m);

  const enabledChanged = [];
  for (const [k, m] of amap) {
    const b = bmap.get(k);
    if (b && b.enabled !== m.enabled) enabledChanged.push({ file: k, enabled: m.enabled });
  }

  return { added, removed, updated, enabledChanged };
}

/* ---------------- 快照（复用时光机的块级去重） ---------------- */
const worldKey = (gameDir) => 'mods:' + path.basename(gameDir || 'default');

async function snapshot({ gameDir, storeDir, label, auto, onProgress }) {
  const modsDir = path.join(gameDir, 'mods');
  if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });
  const scanRes = scan({ modsDir });
  const snap = await tm.createSnapshot({
    saveDir: modsDir, storeDir, label, auto,
    world: worldKey(gameDir), onProgress
  });
  // 把这次的 mod 清单一起存进快照，回滚时能直接展示"回到了哪一组 mod"
  try {
    const p = path.join(storeDir, 'snapshots', snap.id + '.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    j.modList = scanRes.mods.map((m) => ({ file: m.file, id: m.id, name: m.name, version: m.version, loader: m.loader, enabled: m.enabled }));
    fs.writeFileSync(p, JSON.stringify(j));
  } catch {}
  return snap;
}

function listSnapshots({ storeDir, gameDir }) {
  return tm.listSnapshots({ storeDir, world: worldKey(gameDir) });
}

async function restore({ gameDir, storeDir, id }) {
  return tm.restoreSnapshot({ saveDir: path.join(gameDir, 'mods'), storeDir, id });
}

function removeSnapshot({ storeDir, id }) { return tm.deleteSnapshot({ storeDir, id }); }
function gc({ storeDir }) { return tm.gc({ storeDir }); }
function prune({ storeDir, gameDir, keep = 10 }) {
  return tm.pruneAuto({ storeDir, world: worldKey(gameDir), keep });
}
function stats({ storeDir, gameDir }) {
  return tm.stats({ storeDir, world: worldKey(gameDir) });
}

module.exports = {
  scan, analyze, diff, snapshot, listSnapshots, restore, removeSnapshot, gc, prune, stats,
  inferLoader, mcSatisfies, cmpVer, parseModsToml, readModMeta, worldKey, META_CANDIDATES
};
