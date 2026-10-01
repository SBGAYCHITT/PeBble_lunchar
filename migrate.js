// Pebble Lunchar - 跨启动器迁移
//
// 只读扫描本机其他启动器留下的痕迹，把它们的游戏目录 / 实例列出来，
// 让用户勾选要搬过来的内容（Mod、存档、资源包、光影、截图、游戏设置）。
//
// 原则：
//   1. 只读源、只写目标。任何时候都不删除、不修改别人目录下的东西。
//   2. 不搬运账号凭据。微软登录 token 是别人的，搬过来既不安全也会立刻失效，
//      这里最多提取「玩家名」供离线模式参考，且明确标注。
//   3. 找不到就明确告诉用户「没检测到」，而不是显示一个空列表假装「没有可导入的」。

const fs = require('fs');
const path = require('path');
const mcapi = require('./mcapi');
const instances = require('./instances');
const fsutil = require('./fsutil');

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const readDir = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } };

/** 一个目录看起来是否像 MC 游戏目录 */
function looksLikeGameDir(p) {
  if (!isDir(p)) return false;
  if (isDir(path.join(p, 'versions'))) return true;
  return isDir(path.join(p, 'saves')) || isDir(path.join(p, 'mods')) || isFile(path.join(p, 'options.txt'));
}

/* ---------- 启动器位置探测 ---------- */

function defaultEnv() {
  return {
    appData: process.env.APPDATA || '',
    localAppData: process.env.LOCALAPPDATA || '',
    home: (process.env.USERPROFILE || process.env.HOME || '')
  };
}

/** 所有可用磁盘的根目录（只是列出顶层，开销很小） */
function driveRoots() {
  const out = [];
  for (let c = 67; c <= 90; c++) {   // C..Z
    const root = String.fromCharCode(c) + ':\\';
    if (isDir(root)) out.push(root);
  }
  return out;
}

/**
 * 从一段「键值文本」里找出所有指向真实游戏目录的路径。
 * 各启动器配置文件字段名都不一样（PCL.ini / HMCL config.json），
 * 与其逐个硬编码字段名，不如直接认「长得像绝对路径且磁盘上确实存在」的值。
 */
function pathsInText(text) {
  const hits = [];
  const re = /([A-Za-z]:[\\/][^\r\n"'`]*|\/[^\r\n\s"'`]*)/g;
  let m;
  while ((m = re.exec(text))) {
    let s = m[1].trim().replace(/[\\/,;]+$/, '');
    if (s.length < 4 || s.length > 260) continue;
    if (!/[\\/]/.test(s)) continue;
    // 跳过明显是 jar/dll/exe 文件路径的
    if (/\.(jar|dll|exe|png|jpg|json|log|txt)$/i.test(s)) continue;
    if (looksLikeGameDir(s)) hits.push(s);
  }
  return hits;
}

/**
 * 路径归一化。
 * 配置文件里写出来的路径分隔符不一定是本平台的（HMCL 的 config.json 用 `/`，
 * PCL 的 ini 用 `\`），后面拿去做 fs 调用和路径比较时必须先统一。
 */
function norm(p) {
  if (!p || typeof p !== 'string') return p;
  try { return path.normalize(p); } catch { return p; }
}

function pathsInJsonDeep(obj, out) {
  out = out || [];
  if (!obj) return out;
  if (typeof obj === 'string') {
    if (/[\\/]/.test(obj) && looksLikeGameDir(obj)) out.push(obj);
    return out;
  }
  if (Array.isArray(obj)) { for (const v of obj) pathsInJsonDeep(v, out); return out; }
  if (typeof obj === 'object') { for (const k of Object.keys(obj)) pathsInJsonDeep(obj[k], out); return out; }
  return out;
}

/** Prism / MultiMC： instances/<id>/instance.cfg + mmc-pack.json */
function readPrismInstance(dir) {
  const cfgFile = path.join(dir, 'instance.cfg');
  const packFile = path.join(dir, 'mmc-pack.json');
  if (!isFile(cfgFile) && !isFile(packFile)) return null;

  let name = path.basename(dir);
  let iconKey = '';
  let notes = '';
  if (isFile(cfgFile)) {
    try {
      const lines = fs.readFileSync(cfgFile, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
        if (!m) continue;
        const k = m[1];
        if (k === 'name' && m[2].trim()) name = m[2].trim();
        else if (k === 'iconKey') iconKey = m[2].trim();
        else if (k === 'notes') notes = m[2].trim();
      }
    } catch {}
  }
  let mcVersion = '';
  if (isFile(packFile)) {
    try {
      const pack = JSON.parse(fs.readFileSync(packFile, 'utf8'));
      const comps = pack.components || [];
      const mc = comps.find((c) => c && c.uid === 'net.minecraft');
      if (mc && mc.version) mcVersion = mc.version;
      if (!mcVersion && pack.formatVersion === undefined) mcVersion = '';
    } catch {}
  }
  const gameDir = isDir(path.join(dir, '.minecraft')) ? path.join(dir, '.minecraft')
    : (isDir(path.join(dir, 'minecraft')) ? path.join(dir, 'minecraft') : '');
  if (!gameDir && !isDir(path.join(dir, 'versions'))) return null;
  return {
    name,
    mcVersion,
    note: notes || '',
    gameDir: gameDir || dir,
    icon: iconKey ? '' : pickInstanceIcon(dir)
  };
}

function pickInstanceIcon(dir) {
  for (const n of ['icon.png', 'instance.png']) {
    const p = path.join(dir, n);
    if (isFile(p)) return p;
  }
  return '';
}

/**
 * 扫描本机所有已知启动器。
 * @returns {Array<{launcher:string, name:string, root:string, instances:Array}>}
 */
function detectLaunchers(env) {
  const e = env || defaultEnv();
  const found = [];
  const seenGameDir = new Set();

  const addGameDirs = (launcher, name, root, list) => {
    const items = list.filter((it) => {
      it.gameDir = norm(it.gameDir);
      const k = (it.gameDir || '').toLowerCase();
      if (!k || seenGameDir.has(k)) return false;
      seenGameDir.add(k);
      return true;
    });
    if (items.length) found.push({ launcher, name, root, instances: items });
  };

  /* ---- 官方启动器 ---- */
  {
    const gd = path.join(e.appData, '.minecraft');
    if (looksLikeGameDir(gd)) {
      addGameDirs('official', '官方启动器', gd, [{ name: '.minecraft（官方）', mcVersion: '', note: '', gameDir: gd, icon: '' }]);
    }
  }

  /* ---- Prism Launcher / MultiMC ---- */
  {
    const roots = [
      path.join(e.appData, 'PrismLauncher'),
      path.join(e.localAppData, 'PrismLauncher'),
      path.join(e.appData, 'MultiMC'),
      path.join(e.localAppData, 'MultiMC'),
      path.join(e.home, '.local', 'share', 'PrismLauncher')
    ];
    for (const root of roots) {
      const instDir = path.join(root, 'instances');
      if (!isDir(instDir)) continue;
      const items = [];
      for (const d of readDir(instDir)) {
        if (!d.isDirectory()) continue;
        const it = readPrismInstance(path.join(instDir, d.name));
        if (it) items.push(it);
      }
      if (items.length) {
        const label = /multimc/i.test(root) ? 'MultiMC' : 'Prism Launcher';
        addGameDirs('prism', label, root, items);
      }
    }
  }

  /* ---- HMCL ---- */
  {
    const roots = [path.join(e.appData, '.hmcl'), path.join(e.appData, 'HMCL'), path.join(e.home, '.hmcl')];
    for (const root of roots) {
      if (!isDir(root)) continue;
      const items = [];
      // 1) 它自己的 .minecraft
      const own = path.join(root, '.minecraft');
      if (looksLikeGameDir(own)) items.push({ name: 'HMCL 游戏目录', mcVersion: '', note: '', gameDir: own, icon: '' });
      // 2) 配置文件里指到的游戏目录（字段名不固定，直接认路径）
      for (const cfg of ['config.json', 'hmcl.json', 'settings.json']) {
        const f = path.join(root, cfg);
        if (!isFile(f)) continue;
        try {
          const j = JSON.parse(fs.readFileSync(f, 'utf8'));
          for (const p of pathsInJsonDeep(j)) {
            items.push({ name: path.basename(p) || p, mcVersion: '', note: '来自 ' + cfg, gameDir: p, icon: '' });
          }
        } catch {}
      }
      addGameDirs('hmcl', 'HMCL', root, items);
    }
  }

  /* ---- PCL2（绿色版为主，得自己找位置）---- */
  {
    const cand = new Set();
    const pushDirs = (base) => {
      for (const d of readDir(base)) {
        if (!d.isDirectory()) continue;
        const full = path.join(base, d.name);
        if (/^(pcl|pcl2|pclauncher|pcl-launcher)/i.test(d.name)) cand.add(full);
      }
    };
    for (const base of [e.appData, e.localAppData, path.join(e.home, 'Desktop'), path.join(e.home, 'Downloads')]) {
      if (isDir(base)) pushDirs(base);
    }
    // e.pclRoots 供测试注入；生产环境走真实磁盘根目录
    for (const root of (e.pclRoots || driveRoots())) pushDirs(root);

    const items = [];
    for (const dir of cand) {
      const hits = [];
      // PCL.ini 里的自定义游戏目录
      for (const ini of ['PCL.ini', 'PCL2.ini', 'Options.ini']) {
        const f = path.join(dir, ini);
        if (!isFile(f)) continue;
        try { hits.push(...pathsInText(fs.readFileSync(f, 'utf8'))); } catch {}
      }
      const own = path.join(dir, '.minecraft');
      if (looksLikeGameDir(own)) hits.unshift(own);
      for (const h of hits) {
        items.push({ name: path.basename(dir) + ' · ' + (path.basename(h) || h), mcVersion: '', note: '', gameDir: h, icon: '' });
      }
    }
    addGameDirs('pcl', 'PCL2', '', items);
  }

  return found;
}

/** 手动指定目录时用它：把任意目录当成游戏目录来扫 */
function inspectDir(gameDir) {
  const g = norm(gameDir);
  return {
    launcher: 'custom',
    name: path.basename(g) || g,
    root: g,
    instances: [{ name: path.basename(g) || g, mcVersion: '', note: '', gameDir: g, icon: '' }]
  };
}

/* ---------- 内容清点 ---------- */

/**
 * 清点一个游戏目录里有什么可搬的。
 * 返回各项的数量与体积，UI 直接拿去显示。
 */
function scanContent({ gameDir }) {
  if (!gameDir || !isDir(gameDir)) {
    return { exists: false, saves: [], mods: [], rps: [], shaders: [], shots: [], options: false, players: [], size: 0 };
  }
  let saves = [], mods = [], rps = [], shaders = [], shots = [];
  try { saves = mcapi.listSaves(gameDir); } catch {}
  try { mods = mcapi.listMods(gameDir); } catch {}
  try { rps = mcapi.listResourcepacks(gameDir); } catch {}
  try { shaders = mcapi.listShaderpacks(gameDir); } catch {}
  try { shots = mcapi.listScreenshots(gameDir); } catch {}

  const sum = (list, k) => list.reduce((a, b) => a + (b[k] || 0), 0);
  const size = instances.quickSize(gameDir);

  return {
    exists: true,
    size,
    saves: saves.map((s) => ({ name: s.name, dir: s.dir, size: s.size, lastPlayed: s.lastPlayed })),
    mods: mods.map((m) => ({ name: m.name, path: m.path, size: m.size })),
    rps: rps.map((m) => ({ name: m.name, path: m.path, size: m.size })),
    shaders: shaders.map((m) => ({ name: m.name, path: m.path, size: m.size })),
    shots: shots.map((m) => ({ name: m.name, path: m.path, size: m.size })),
    options: isFile(path.join(gameDir, 'options.txt')),
    counts: {
      saves: saves.length, mods: mods.length, rps: rps.length, shaders: shaders.length, shots: shots.length,
      savesSize: sum(saves, 'size'), modsSize: sum(mods, 'size')
    },
    // 只取「玩家名」作为离线模式参考。绝不搬运 token / accessToken。
    players: readPlayerNames(gameDir)
  };
}

/**
 * 从别的启动器里读「玩家名」（纯文本，不含凭据）。
 * 官方 launcher_profiles.json 里存的 accessToken 是我们刻意不碰的东西。
 */
function readPlayerNames(gameDir) {
  const names = new Set();
  const tryJson = (f) => {
    if (!isFile(f)) return;
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        if (!Array.isArray(o) && typeof o.displayName === 'string' && o.displayName.trim()) {
          names.add(o.displayName.trim());
        }
        for (const k of Object.keys(o)) {
          if (/token|password|secret|credential/i.test(k)) continue;  // 明确跳过凭据字段
          walk(o[k]);
        }
      };
      walk(j);
    } catch {}
  };
  tryJson(path.join(gameDir, 'launcher_profiles.json'));
  tryJson(path.join(gameDir, 'launcher_accounts.json'));
  // PCL / HMCL 常用 username.json 存上次的玩家名
  try {
    const f = path.join(gameDir, 'username.json');
    if (isFile(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (typeof j === 'string' && j.trim()) names.add(j.trim());
      else if (j && typeof j.name === 'string') names.add(j.name.trim());
    }
  } catch {}
  return [...names].slice(0, 10);
}

/* ---------- 导入 ---------- */

/**
 * 把勾选的内容复制进目标实例目录。
 * @param {object}   o
 * @param {string}   o.destGameDir  目标 gameDir
 * @param {object[]} o.items        [{kind:'mods', paths:['...']}]
 * @param {boolean} [o.overwrite]   同名是否覆盖（默认跳过）
 * @param {(info:{phase:string, src?:string, dest?:string})=>void} [o.onProgress] 复制进度回调
 */
function importItems({ destGameDir, items, overwrite, onProgress }) {
  if (!destGameDir) throw new Error('目标实例目录为空');
  fs.mkdirSync(destGameDir, { recursive: true });
  const KIND_DIR = {
    saves: 'saves', mods: 'mods', rps: 'resourcepacks',
    shaders: 'shaderpacks', shots: 'screenshots', options: ''
  };
  const report = { copied: 0, skipped: 0, failed: 0, bytes: 0, errors: [] };
  for (const group of items || []) {
    const sub = KIND_DIR[group.kind];
    if (sub === undefined) continue;
    for (const src of group.paths || []) {
      const dest = sub ? path.join(destGameDir, sub, path.basename(src)) : path.join(destGameDir, path.basename(src));
      if (fs.existsSync(dest) && !overwrite) { report.skipped++; continue; }
      try {
        if (onProgress) onProgress({ phase: 'copy', src, dest });
        const st = fsutil.copyPath(src, dest, { overwrite: !!overwrite });
        if (!st.files && !fs.existsSync(dest)) throw new Error('复制后目标不存在');
        report.copied++;
        report.bytes += st.bytes;
      } catch (e) {
        report.failed++;
        report.errors.push(path.basename(src) + ': ' + e.message);
      }
    }
  }
  return report;
}

module.exports = {
  detectLaunchers, inspectDir, scanContent, importItems,
  readPrismInstance, readPlayerNames, looksLikeGameDir,
  driveRoots, pathsInText, pathsInJsonDeep, defaultEnv, norm
};
