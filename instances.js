// Pebble Lunchar - 实例系统
//
// 设计要点
// ─────────────────────────────────────────────────────────────
// 之前整个启动器只有「一个 .minecraft 目录」，mods / 存档 / 资源包全部混在一起。
// 想同时跑「纯净生存」和「200 mod 的科技整合包」就必须手动搬文件夹。
//
// 实例 = 一份元数据 + 一个独立的 gameDir。
//
//   · gameDir 为空          → 沿用旧行为（直接用 mcDir，配合「版本隔离」开关）
//   · gameDir 为具体路径    → 完全独立的 mods / saves / resourcepacks / options.txt
//
// 老用户升级时 ensureDefault() 会把当前用法封装成一个名为「默认实例」的实例，
// gameDir 保持 null —— 也就是说升级后所有东西都还在原地，一个字节都不会被搬动。
//
// 实例本身只有元数据，真正的游戏版本 / 资源 / 库仍然共用 mcDir，
// 所以开第二个实例不会重复下载几百 MB。

const fs = require('fs');
const path = require('path');
const fsutil = require('./fsutil');

const FILE_VERSION = 1;

/** 复制实例时默认要带上的目录 / 文件 */
const COPYABLE = [
  { key: 'saves', dir: 'saves', label: '存档' },
  { key: 'mods', dir: 'mods', label: 'Mod' },
  { key: 'rps', dir: 'resourcepacks', label: '资源包' },
  { key: 'shaders', dir: 'shaderpacks', label: '光影' },
  { key: 'shots', dir: 'screenshots', label: '截图' },
  { key: 'config', dir: 'config', label: 'Mod 配置' },
  { key: 'options', file: 'options.txt', label: '游戏设置' }
];

const DEFAULT_INSTANCE_ID = 'default';

/* ---------- 存储 ---------- */

function storeFile(root) { return path.join(root, 'instances.json'); }

function readStore(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(root), 'utf8'));
    const list = Array.isArray(raw && raw.instances) ? raw.instances : [];
    return {
      version: (raw && raw.version) || FILE_VERSION,
      activeId: (raw && raw.activeId) || '',
      instances: list
    };
  } catch {
    return { version: FILE_VERSION, activeId: '', instances: [] };
  }
}

function writeStore(root, data) {
  fs.mkdirSync(root, { recursive: true });
  const tmp = storeFile(root) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, storeFile(root));   // 原子替换：写一半崩了也不会丢原有实例表
  return data;
}

/* ---------- 只读查询 ---------- */

function list({ root }) {
  const data = readStore(root);
  return {
    activeId: data.activeId,
    instances: data.instances.slice().sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0))
  };
}

function get({ root, id }) {
  const data = readStore(root);
  return data.instances.find((i) => i.id === id) || null;
}

function active({ root }) {
  const data = readStore(root);
  return data.instances.find((i) => i.id === data.activeId) ||
         data.instances.find((i) => i.id === DEFAULT_INSTANCE_ID) ||
         null;
}

function setActive({ root, id }) {
  const data = readStore(root);
  if (!data.instances.some((i) => i.id === id)) throw new Error('实例不存在: ' + id);
  data.activeId = id;
  writeStore(root, data);
  return get({ root, id });
}

/**
 * 计算出真正的游戏目录。
 * inst.gameDir 为空时退回旧逻辑（mcDir，可选按版本隔离子目录）。
 */
function resolveGameDir({ inst, mcDir, isolation, version }) {
  if (inst && inst.gameDir) return inst.gameDir;
  if (isolation && version) return path.join(mcDir, 'versions', version, 'isolation');
  return mcDir;
}

function touchPlayed({ root, id }) {
  const data = readStore(root);
  const inst = data.instances.find((i) => i.id === id);
  if (!inst) return;
  inst.lastPlayed = Date.now();
  writeStore(root, data);
}

/* ---------- 写入操作 ---------- */

function newId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

function slugish(name) {
  // Windows 保留名也不能用作目录名，统一加前缀规避
  return String(name || 'instance')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '-')
    .slice(0, 40) || 'instance';
}

/**
 * 首次使用时把现有用法固化成「默认实例」。
 * 只有当实例表为空时才创建，且 gameDir 保持 null（继续用 mcDir）——什么都不搬。
 */
function ensureDefault({ root, mcDir, version }) {
  const data = readStore(root);
  if (data.instances.length) return data.instances.find((i) => i.id === DEFAULT_INSTANCE_ID) || null;
  const inst = {
    id: DEFAULT_INSTANCE_ID,
    name: '默认实例',
    note: '沿用原来的 .minecraft 目录，升级前的存档 / Mod 都在这里',
    gameDir: '',
    version: version || '',
    loader: '',
    javaPath: '',
    mem: 0,
    jvmArgs: '',
    winW: 0, winH: 0, fullscreen: false,
    createdAt: Date.now(),
    lastPlayed: Date.now(),
    builtin: true
  };
  data.instances.push(inst);
  data.activeId = DEFAULT_INSTANCE_ID;
  writeStore(root, data);
  return inst;
}

/**
 * 新建实例。
 * @param {object}   o
 * @param {string}   o.root        实例元数据目录（一般是 userData）
 * @param {string}   o.name        显示名
 * @param {string}  [o.version]    绑定的游戏版本
 * @param {string}  [o.loader]     加载器标识（fabric/forge/neoforge/quilt，空=原版）
 * @param {string}  [o.gameDir]    为空则自动生成 <instancesRoot>/<name>
 * @param {string}  [o.instancesRoot] gameDir 的父目录
 * @param {string[]}[o.copyFrom]   从这些实例（或任意 gameDir）复制内容
 * @param {string[]}[o.items]      COPYABLE 的 key 子集
 */
function create({ root, name, version, loader, gameDir, instancesRoot, copyFrom, items }) {
  if (!name || !String(name).trim()) throw new Error('实例名不能为空');
  const data = readStore(root);
  const trimName = String(name).trim();
  const id = newId();
  const dir = gameDir || path.join(instancesRoot || path.join(root, 'instances'), slugish(trimName));
  if (data.instances.some((i) => (i.gameDir || '').toLowerCase() === dir.toLowerCase())) {
    throw new Error('已存在使用该目录的实例: ' + dir);
  }
  const inst = {
    id,
    name: trimName,
    note: '',
    gameDir: dir,
    version: version || '',
    loader: loader || '',
    javaPath: '',
    mem: 0,
    jvmArgs: '',
    winW: 0, winH: 0, fullscreen: false,
    createdAt: Date.now(),
    lastPlayed: Date.now()
  };
  fs.mkdirSync(dir, { recursive: true });
  if (copyFrom && copyFrom.length && items && items.length) {
    copyInto({ from: copyFrom[0], to: dir, items });
  }
  data.instances.push(inst);
  data.activeId = id;
  writeStore(root, data);
  return inst;
}

/**
 * 复制实例。可以选择哪些内容跟着过去（默认全选）。
 */
function duplicate({ root, id, name, instancesRoot, items }) {
  const data = readStore(root);
  const src = data.instances.find((i) => i.id === id);
  if (!src) throw new Error('实例不存在: ' + id);
  const trimName = String(name || src.name + ' 副本').trim();
  const newInstId = newId();
  const dir = path.join(instancesRoot || path.join(root, 'instances'), slugish(trimName));
  if (data.instances.some((i) => (i.gameDir || '').toLowerCase() === dir.toLowerCase())) {
    throw new Error('已存在使用该目录的实例: ' + dir);
  }
  const want = items && items.length ? items : COPYABLE.map((c) => c.key);
  const inst = Object.assign({}, src, {
    id: newInstId,
    name: trimName,
    gameDir: dir,
    builtin: false,
    createdAt: Date.now(),
    lastPlayed: Date.now()
  });
  fs.mkdirSync(dir, { recursive: true });
  if (src.gameDir) copyInto({ from: src.gameDir, to: dir, items: want });
  data.instances.push(inst);
  data.activeId = newInstId;
  writeStore(root, data);
  return inst;
}

function update({ root, id, patch }) {
  const data = readStore(root);
  const inst = data.instances.find((i) => i.id === id);
  if (!inst) throw new Error('实例不存在: ' + id);
  const ALLOWED = ['name', 'note', 'version', 'loader', 'javaPath', 'mem', 'jvmArgs', 'winW', 'winH', 'fullscreen', 'gameDir'];
  for (const k of ALLOWED) {
    if (Object.prototype.hasOwnProperty.call(patch || {}, k)) inst[k] = patch[k];
  }
  writeStore(root, data);
  return inst;
}

/**
 * 删除实例。deleteFiles 为真时连同 gameDir 一起删（危险，UI 需二次确认）。
 * 默认实例是 builtin，不允许删。
 */
function remove({ root, id, deleteFiles }) {
  const data = readStore(root);
  const inst = data.instances.find((i) => i.id === id);
  if (!inst) throw new Error('实例不存在: ' + id);
  if (inst.builtin) throw new Error('默认实例不能删除');
  data.instances = data.instances.filter((i) => i.id !== id);
  if (data.activeId === id) {
    data.activeId = (data.instances.find((i) => i.id === DEFAULT_INSTANCE_ID) || data.instances[0] || {}).id || '';
  }
  writeStore(root, data);
  if (deleteFiles && inst.gameDir && fs.existsSync(inst.gameDir)) {
    fs.rmSync(inst.gameDir, { recursive: true, force: true });
  }
  return { ok: true, remaining: data.instances.length };
}

/* ---------- 文件搬运 ---------- */

function copyInto({ from, to, items }) {
  const done = [];
  const skipped = [];
  for (const key of items || []) {
    const c = COPYABLE.find((x) => x.key === key);
    if (!c) continue;
    const src = path.join(from, c.dir || c.file);
    if (!fs.existsSync(src)) { skipped.push(c.label); continue; }
    try {
      fsutil.copyPath(src, path.join(to, c.dir || c.file), { overwrite: true });
      done.push(c.label);
    } catch (e) {
      skipped.push(c.label + '(' + e.message + ')');
    }
  }
  return { done, skipped };
}

/** 实例规模（gameDir 总大小 + 各项计数），用于列表展示 */
function stats({ gameDir }) {
  const out = { size: 0, mods: 0, saves: 0, rps: 0, shaders: 0, shots: 0, hasOptions: false };
  if (!gameDir || !fs.existsSync(gameDir)) return out;
  out.hasOptions = fs.existsSync(path.join(gameDir, 'options.txt'));
  for (const c of COPYABLE) {
    if (!c.dir) continue;
    const d = path.join(gameDir, c.dir);
    if (!fs.existsSync(d)) continue;
    try {
      out[c.key === 'rps' ? 'rps' : c.key] = fs.readdirSync(d).filter((n) => n !== '.DS_Store').length;
      out.size += quickSize(d);
    } catch {}
  }
  return out;
}

/** 目录体积。dirSize 在 mcapi 里，但那边有 depth>3 的限制，这里要算准 */
function quickSize(dir, depth) {
  const d = depth || 0;
  if (d > 8) return 0;
  let total = 0;
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const it of items) {
    try {
      const p = path.join(dir, it.name);
      if (it.isDirectory()) total += quickSize(p, d + 1);
      else total += fs.statSync(p).size;
    } catch {}
  }
  return total;
}

module.exports = {
  list, get, active, setActive, create, duplicate, update, remove,
  ensureDefault, resolveGameDir, touchPlayed, stats, copyInto,
  storeFile, quickSize, COPYABLE, DEFAULT_INSTANCE_ID
};
