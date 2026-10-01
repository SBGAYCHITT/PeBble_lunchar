// Pebble Lunchar - 核心启动逻辑（主进程侧）
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const LAUNCHER_NAME = 'PebbleLunchar';
/** 启动器自身版本，写进 -Dminecraft.launcher.version / ${launcher_version} */
const APP_VERSION = (function () {
  try { return require('./package.json').version || '0.0.0'; } catch { return '0.0.0'; }
})();

/* ---------- 离线 UUID（与正版服务器/Bukkit 离线模式算法一致：UUID v3 of "OfflinePlayer:<name>" UTF-8） ---------- */
function offlineUUID(name) {
  const hash = crypto.createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30; // version 3
  hash[8] = (hash[8] & 0x3f) | 0x80; // IETF variant
  const h = hash.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

/* ---------- 版本所需 Java 主版本 ---------- */
function requiredJavaMajor(verId) {
  const m = String(verId).match(/^(\d+)\.(\d+)/);
  if (!m) return 8;
  const minor = parseInt(m[2], 10);
  if (minor >= 21) return 21;   // 1.20.5+
  if (minor >= 18) return 17;   // 1.18 ~ 1.20.4
  if (minor >= 17) return 16;   // 1.17.x
  return 8;                      // 1.16.5 及更早
}

/**
 * 解析 `java -version` 输出的版本串 → Java 主版本号。
 * 关键是 1.8.0_402 这种老格式也要算成 8（直接 parseInt 会得到 1）。
 * 历史坑：旧代码写的是 `javaVer >= 24`，而 javaVer 是字符串 "25.0.1"，
 * Number("25.0.1") 是 NaN，比较恒为 false —— 这个分支其实从来没生效过。
 */
function javaMajorOf(v) {
  const s = String(v || '');
  const m = s.match(/^(\d+)/);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return n === 1 ? (parseInt((s.split('.')[1] || '0'), 10) || 0) : n;
}

/* ---------- 客户端 jar 解析 ----------
 * 这是「Forge 总是说缺 jar」的根因所在。
 *
 * Forge / NeoForge / Fabric / Quilt / OptiFine 生成的版本目录里 **只有 json、没有 jar**：
 *   versions/26.3-forge-66.0.4/26.3-forge-66.0.4.json      ← 只有这一个文件
 *   versions/26.3/26.3.jar                                  ← 真正的主程序在父版本目录里
 * 其 json 靠 `"inheritsFrom": "26.3"` 指回原版，主程序 jar 必须沿继承链去父版本拿。
 *
 * 旧代码两处都写死了 `versions/<id>/<id>.jar`（listVersions 的 hasJar、launchGame 的校验），
 * 于是：版本列表里每个 Forge 版本都挂「· 缺 jar」；点启动直接返回
 * 「缺少客户端 jar: ...\versions\26.3-forge-66.0.4\26.3-forge-66.0.4.jar」。
 *
 * 解析顺序：自身目录 → json 里显式声明的 `jar` 字段（OptiFine 等会写）→ 沿 inheritsFrom 向上。
 * @returns {{jar:string, from:string, chain:string[]}|null}
 */
function resolveClientJar(mcDir, id) {
  const seen = new Set();
  const chain = [];
  let cur = id;
  for (let i = 0; i < 10 && cur; i++) {
    if (seen.has(cur)) break;           // 继承链成环保护
    seen.add(cur);
    chain.push(cur);
    const own = path.join(mcDir, 'versions', cur, cur + '.jar');
    if (fs.existsSync(own)) return { jar: own, from: cur, chain };
    let j = null;
    try { j = JSON.parse(fs.readFileSync(path.join(mcDir, 'versions', cur, cur + '.json'), 'utf8')); } catch { break; }
    if (j && j.jar && j.jar !== cur) {
      const jp = path.join(mcDir, 'versions', j.jar, j.jar + '.jar');
      if (fs.existsSync(jp)) return { jar: jp, from: j.jar, chain };
    }
    cur = (j && j.inheritsFrom) || null;
  }
  return null;
}

/* ---------- 版本扫描 ---------- */
function listVersions(mcDir) {
  const out = [];
  const vDir = path.join(mcDir, 'versions');
  let entries;
  try { entries = fs.readdirSync(vDir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const json = path.join(vDir, e.name, e.name + '.json');
    if (!fs.existsSync(json)) continue;
    let type = '';
    try { type = JSON.parse(fs.readFileSync(json, 'utf8')).type || ''; } catch {}
    // hasJar 走继承链：加载器版本自己没有 jar，但父版本有，就不该标「缺 jar」
    const r = resolveClientJar(mcDir, e.name);
    out.push({ id: e.name, type, hasJar: !!r, jarFrom: r ? r.from : null });
  }
  out.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
  return out;
}

/* ---------- 版本 JSON 解析（含 inheritsFrom） ---------- */
function loadVersionJson(mcDir, id, seen = new Set()) {
  if (seen.has(id)) return null;
  seen.add(id);
  const p = path.join(mcDir, 'versions', id, id + '.json');
  let json;
  try { json = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
  if (json.inheritsFrom) {
    const parent = loadVersionJson(mcDir, json.inheritsFrom, seen);
    if (parent) json = mergeJson(parent, json);
  }
  return json;
}

/**
 * 纯函数：合并 arguments。
 * 官方语义是 **拼接**，不是覆盖：
 *   game: 父在前、子在后（父给 --username/--version/--gameDir/--assetsDir/--uuid…，
 *         子给 --launchTarget forge_client 这类加载器专有项）
 *   jvm:  同样拼接（父给 -Djava.library.path / --add-exports / -cp ${classpath}，
 *         子给加载器自己的 -DlibraryDirectory / -p / --add-modules）
 *
 * 历史 bug：这里原来是被 child 整体覆盖，于是 Forge 版本启动时
 *   · 游戏参数只剩 `--launchTarget forge_client` —— 账号、游戏目录、资源索引全丢；
 *   · JVM 参数丢掉 natives 提取路径与 `-cp ${classpath}`。
 * 结果必然是启动即崩，而报错信息完全指不到这里。
 */
function mergeArguments(parent, child) {
  const p = parent || {};
  const c = child || {};
  const out = Object.assign({}, p);
  for (const k of Object.keys(c)) {
    if (k === 'game' || k === 'jvm') {
      const a = Array.isArray(p[k]) ? p[k] : [];
      const b = Array.isArray(c[k]) ? c[k] : [];
      out[k] = a.concat(b);
    } else {
      out[k] = c[k];
    }
  }
  return out;
}

function mergeJson(parent, child) {
  const out = Object.assign({}, parent);
  for (const k of Object.keys(child)) {
    if (k === 'libraries') {
      const map = new Map();
      for (const l of (parent.libraries || [])) map.set(l.name, l);
      for (const l of (child.libraries || [])) map.set(l.name, l); // 子覆盖父
      out.libraries = [...map.values()];
    } else if (k === 'arguments') {
      out.arguments = mergeArguments(parent.arguments, child.arguments);
    } else if (k === 'minecraftArguments') {
      // 旧格式（1.12 及更早）是一整串参数，父子都得保留
      out[k] = [parent[k], child[k]].filter(Boolean).join(' ');
    } else {
      out[k] = child[k];
    }
  }
  return out;
}

/* ---------- 库 / 参数规则 ---------- */
function osName() { return 'windows'; }

// 官方启动器的规则匹配：os 与 features 必须同时命中。features 缺省一律视为 false。
function ruleAllowed(rules, features) {
  if (!rules) return true;
  let ok = false;
  for (const r of rules) {
    let match = true;
    if (r.os) {
      if (r.os.name && r.os.name !== osName()) match = false;
      if (r.os.arch === 'x86' && process.arch !== 'ia32') match = false;
      if (r.os.version) {
        try { if (!new RegExp(r.os.version).test(os.release())) match = false; } catch (e) {}
      }
    }
    if (match && r.features) {
      for (const key of Object.keys(r.features)) {
        const want = !!r.features[key];
        const has = !!(features && features[key]);
        if (want !== has) { match = false; break; }
      }
    }
    if (match) ok = (r.action === 'allow');
  }
  return ok;
}

function libPath(lib) {
  if (lib.path) return lib.path.replace(/\//g, '\\');
  const [group, artifact, version, classifier] = lib.name.split(':');
  const file = classifier
    ? `${artifact}-${version}-${classifier}.jar`
    : `${artifact}-${version}.jar`;
  return path.join(...group.split('.'), artifact, version, file);
}

/** 展开 `-Dfoo=${bar}` 这类占位符；未识别的占位符原样保留（便于发现拼错的变量） */
function fillVars(s, vars) {
  return String(s).replace(/\$\{([^}]+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m));
}

/**
 * 纯函数：展开版本 JSON 的 `arguments.jvm`（字符串项 + 带 rules 的对象项）。
 * 这是官方 JVM 参数的唯一权威来源，解析不了它就只能靠启动器硬猜。
 */
function expandJvmArgs(list, vars, features) {
  const out = [];
  for (const a of (list || [])) {
    if (typeof a === 'string') { out.push(fillVars(a, vars)); continue; }
    if (a && a.rules) {
      if (!ruleAllowed(a.rules, features)) continue;
      const vals = Array.isArray(a.value) ? a.value : [a.value];
      for (const v of vals) out.push(fillVars(v, vars));
    }
  }
  return out;
}

/* ---------- natives 解压（用系统 bsdtar，Win10+ 自带） ---------- */
function extractNatives(jarPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  try {
    fs.accessSync(jarPath);
  } catch {
    return;
  }
  require('child_process').execSync(`tar -xf "${jarPath}" -C "${destDir}"`, { stdio: 'ignore' });
}

/* ---------- Java 检测 ---------- */
function javaVersionOf(binPath) {
  return new Promise((resolve) => {
    execFile(binPath, ['-version'], { timeout: 8000 }, (err, _so, se) => {
      const out = String(se || _so || '');
      const m = out.match(/version "([^"]+)"/);
      resolve(m ? m[1] : null);
    });
  });
}

/* ---------- 扫描官方启动器内置运行时（.minecraft/runtime/<name>/bin/javaw.exe） ---------- */
function scanBundledRuntimes(mcDir) {
  const out = [];
  if (!mcDir) return out;
  const base = path.join(mcDir, 'runtime');
  let dirs = [];
  try { dirs = fs.readdirSync(base, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const p = path.join(base, d.name, 'bin', 'javaw.exe');
    try { if (fs.existsSync(p)) out.push({ path: p, source: '内置运行时 ' + d.name }); } catch {}
  }
  return out;
}

async function detectJava(mcDir, preferMajor) {
  const candidates = [...scanBundledRuntimes(mcDir)];
  // 常见安装目录
  const roots = [
    process.env.ProgramFiles + '\\Java',
    process.env['ProgramFiles(x86)'] + '\\Java',
    process.env.ProgramFiles + '\\Eclipse Adoptium',
    process.env.ProgramFiles + '\\Microsoft',
    process.env['ProgramFiles(x86)'] + '\\Microsoft',
    process.env.ProgramFiles + '\\Zulu',
    process.env.ProgramFiles + '\\Amazon Corretto',
    process.env.LOCALAPPDATA + '\\Programs'
  ];
  for (const root of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const name = d.name.toLowerCase();
      if (!/jdk|jre|java|zulu|corretto|temurin/.test(name)) continue;
      for (const bin of ['\\bin\\javaw.exe', '\\bin\\java.exe']) {
        const p = path.join(root, d.name, bin);
        try {
          if (fs.existsSync(p)) { candidates.push({ path: p, source: root }); break; }
        } catch {}
      }
    }
  }
  // PATH 上的 java
  const pathDirs = (process.env.PATH || '').split(';').filter(Boolean);
  for (const pd of pathDirs) {
    const p = path.join(pd, 'javaw.exe');
    try { if (fs.existsSync(p)) { candidates.push({ path: p, source: '系统 PATH' }); break; } } catch {}
  }

  // 读取版本号
  const probed = [];
  for (const c of candidates) {
    const v = await javaVersionOf(c.path);
    if (!v) continue;
    const major = parseInt(v.split(/[._]/)[0], 10) || 0;
    probed.push({ path: c.path, version: v, major, source: c.source });
  }
  if (!probed.length) return null;

  // 选择策略：优先满足目标版本需求的最小 Java；没有目标则取最高版本
  if (preferMajor) {
    const ok = probed.filter(p => p.major >= preferMajor).sort((a, b) => a.major - b.major);
    if (ok.length) return ok[0];
  }
  probed.sort((a, b) => b.major - a.major);
  return probed[0];
}

/* ---------- 组装并启动 ---------- */
async function launchGame(opts, onLog) {
  const { version, mcDir, javaPath, maxMemMB, jvmArgs, isolation, width, height, fullscreen } = opts;
  const errors = [];
  const tell = (s) => onLog && onLog('[启动器] ' + s);

  // 账户信息（离线 / 外置 / 微软）
  const acc = opts.account || { type: 'offline', name: opts.name || 'Player' };
  const name = acc.name || 'Player';
  const uuid = acc.uuid || offlineUUID(name);
  const accessToken = acc.accessToken || '0';
  const userType = acc.userType || 'legacy';
  const profileProperties = acc.properties || '{}';

  // 游戏目录。实例系统解析出来的 gameDir 优先级最高（它能覆盖版本隔离），
  // 没有实例时才退回「版本隔离子目录 / 直接用 mcDir」的老逻辑。
  const gameDir = opts.gameDir || (isolation ? path.join(mcDir, 'versions', version, 'isolation') : mcDir);
  try { fs.mkdirSync(gameDir, { recursive: true }); } catch {}

  // 校验
  if (!fs.existsSync(mcDir)) return { ok: false, error: '.minecraft 目录不存在: ' + mcDir };
  const json = loadVersionJson(mcDir, version);
  if (!json) return { ok: false, error: '无法读取版本 JSON（含 inheritsFrom 解析）' };

  // 客户端主程序：加载器版本（Forge/NeoForge/Fabric/Quilt/OptiFine）自己的目录里没有 jar，
  // 必须沿 inheritsFrom 去父版本拿。详见 resolveClientJar 的注释。
  const cj = resolveClientJar(mcDir, version);
  if (!cj) {
    const chain = json.inheritsFrom ? (version + ' → ' + json.inheritsFrom) : version;
    return {
      ok: false,
      error: `缺少客户端 jar：${chain} 都没有 .jar。请先在「下载」里安装对应的原版版本（加载器需要它的主程序）。`
    };
  }
  const clientJar = cj.jar;
  if (cj.from !== version) tell(`客户端主程序取自父版本: ${cj.from}/${cj.from}.jar`);

  // Java
  let javaBin = javaPath;
  let javaVer = null;
  if (!javaBin) {
    const det = await detectJava(mcDir, requiredJavaMajor(version));
    if (!det) return { ok: false, error: '未找到 Java，请在设置中手动指定 javaw.exe' };
    javaBin = det.path;
    javaVer = det.version;
  } else {
    if (!fs.existsSync(javaBin)) return { ok: false, error: 'Java 路径无效: ' + javaBin };
    javaVer = await javaVersionOf(javaBin);
  }
  const javaMajor = javaMajorOf(javaVer);
  tell('使用 Java: ' + javaBin + (javaVer ? ' (v' + javaVer + ')' : ''));

  // classpath + natives
  const libsDir = path.join(mcDir, 'libraries');
  const nativesDir = path.join(mcDir, 'versions', version, 'natives-' + version);
  // 规则 features：只开启用户真正选中的能力。
  // 官方 JSON 用 features 门控互斥参数（--demo / --width,height / 4 个 --quickPlay*），
  // 全部当成 true 会同时传出多个 quick play 选项，游戏在参数校验阶段直接抛
  // IllegalArgumentException: Only one quick play option can be specified 并退出。
  const qp = opts.quickPlay || null;
  const features = {
    is_demo_user: false,
    has_custom_resolution: !!(width && height),
    has_quick_plays_support: false,
    is_quick_play_singleplayer: !!(qp && qp.type === 'singleplayer' && qp.value),
    is_quick_play_multiplayer: !!(qp && qp.type === 'multiplayer' && qp.value),
    is_quick_play_realms: !!(qp && qp.type === 'realms' && qp.value)
  };
  const cp = [];
  const nativesJars = [];
  for (const lib of (json.libraries || [])) {
    if (!ruleAllowed(lib.rules, features)) continue;
    const isNative = !!lib.natives && lib.natives[osName()] !== undefined;
    if (isNative) {
      const classifier = (lib.natives[osName()] || '').replace('${arch}', process.arch === 'ia32' ? '32' : '64');
      const p = path.join(libsDir, libPath(Object.assign({}, lib, { name: lib.name + ':' + classifier })));
      if (fs.existsSync(p)) nativesJars.push(p);
      else tell('缺少 natives 库: ' + lib.name);
    } else {
      const p = path.join(libsDir, libPath(lib));
      if (fs.existsSync(p)) cp.push(p);
      else errors.push(lib.name);
    }
  }
  cp.push(clientJar);
  if (errors.length) {
    tell('警告: 缺少 ' + errors.length + ' 个依赖库，游戏可能无法运行');
    for (const e of errors.slice(0, 6)) tell('     缺: ' + e);
    if (errors.length > 6) tell('     …另有 ' + (errors.length - 6) + ' 项');
  }

  // natives 目录。
  // 旧格式（≤1.18）由启动器解压 natives jar，新格式（1.19+）官方 JSON 里没有 `natives` 字段，
  // natives 直接进 classpath，由 LWJGL / JNA / Netty 自己解压到 ${natives_directory}/<子目录>。
  // 官方 JSON 明确引用了 java / lwjgl / jna / netty 四个子目录，这里先把目录建出来，
  // 否则 Java 侧首次解压可能因为目录不存在而失败。
  try {
    fs.rmSync(nativesDir, { recursive: true, force: true });
    for (const sub of ['', 'java', 'lwjgl', 'jna', 'netty']) {
      fs.mkdirSync(sub ? path.join(nativesDir, sub) : nativesDir, { recursive: true });
    }
  } catch {}
  for (const nj of nativesJars) extractNatives(nj, nativesDir);
  tell('natives 就绪: 解压 ' + nativesJars.length + ' 个（新版由 LWJGL 自解压）');

  // assets
  const assetsDir = path.join(mcDir, 'assets');
  const assetIndex = json.assetIndex ? json.assetIndex.id : (json.assets || 'legacy');

  // 参数
  const mainClass = json.mainClass || 'net.minecraft.client.main.Main';
  const classPath = cp.join(path.delimiter);

  // ---- 官方 JSON 的 ${...} 占位符变量表（jvm 与 game 共用）----
  const vars = {
    auth_player_name: name,
    version_name: version,
    game_directory: gameDir,
    assets_root: assetsDir,
    assets_index_name: assetIndex,
    auth_uuid: uuid,
    auth_access_token: accessToken,
    auth_session: accessToken,
    clientid: '0',
    auth_xuid: '0',
    user_type: userType,
    version_type: json.type || 'release',
    user_properties: profileProperties,
    resolution_width: String(width || 854),
    resolution_height: String(height || 480),
    quickPlayPath: (qp && qp.type === 'path' && qp.value) ? qp.value : '',
    quickPlaySingleplayer: (qp && qp.type === 'singleplayer') ? qp.value : '',
    quickPlayMultiplayer: (qp && qp.type === 'multiplayer') ? qp.value : '',
    quickPlayRealms: (qp && qp.type === 'realms') ? qp.value : '',
    // ---- JVM 侧 ----
    natives_directory: nativesDir,
    launcher_name: LAUNCHER_NAME,
    launcher_version: APP_VERSION,
    classpath: classPath,
    classpath_separator: path.delimiter,
    library_directory: libsDir
  };

  // 版本 JSON 自带的 JVM 参数是第一优先级来源：
  // natives 提取路径、--add-exports、--enable-native-access、`-cp ${classpath}` 全在里面。
  // 老代码完全忽略它，等于把这些全丢了 —— 只有 1.18 之前的老版本才勉强能跑。
  const jsonJvm = expandJvmArgs(json.arguments && json.arguments.jvm, vars, features);
  const hasJvm = (prefix) => jsonJvm.some((a) => a === prefix || String(a).startsWith(prefix));

  const args = [
    '-Xmx' + (maxMemMB || 2048) + 'M',
    '-Xms' + Math.min(512, maxMemMB || 2048) + 'M'
  ];
  // 下面这些兜底只在 JSON 没给的时候才补，避免同键重复（重复时后者生效，容易莫名改行为）
  if (!hasJvm('-Djava.library.path=')) args.push('-Djava.library.path=' + nativesDir);
  if (!hasJvm('-Dorg.lwjgl.system.SharedLibraryExtractPath=')) args.push('-Dorg.lwjgl.system.SharedLibraryExtractPath=' + nativesDir);
  if (!hasJvm('-Dminecraft.launcher.brand=')) args.push('-Dminecraft.launcher.brand=' + LAUNCHER_NAME);
  if (!hasJvm('-Dminecraft.launcher.version=')) args.push('-Dminecraft.launcher.version=' + APP_VERSION);

  // 外置登录：注入 authlib-injector
  if (acc.authServer && opts.authlibInjector && fs.existsSync(opts.authlibInjector)) {
    args.push('-javaagent:' + opts.authlibInjector + '=' + acc.authServer);
    args.push('-Dauthlibinjector.side=client');
    tell('已注入 authlib-injector: ' + acc.authServer);
  }
  if (jvmArgs) args.push(...jvmArgs.split(/\s+/).filter(Boolean));
  // Java 24+ 默认会对 LWJGL 的原生访问打印警告（不影响运行，但会刷满日志）
  if (javaMajor >= 24 && !hasJvm('--enable-native-access')) args.push('--enable-native-access=ALL-UNNAMED');
  // 编码：Windows 下 JVM 默认用系统 ANSI（中文=GBK），游戏输出读出来会乱码。
  // 强制 UTF-8（JSON 或用户自定义 jvmArgs 里若已指定则不覆盖）
  const hasEnc = (s) => args.some((a) => String(a).indexOf(s) === 0) || jsonJvm.some((a) => String(a).indexOf(s) === 0);
  if (!hasEnc('-Dfile.encoding=')) args.push('-Dfile.encoding=UTF-8');
  if (!hasEnc('-Dsun.stdout.encoding=')) args.push('-Dsun.stdout.encoding=UTF-8');
  if (!hasEnc('-Dsun.stderr.encoding=')) args.push('-Dsun.stderr.encoding=UTF-8');

  args.push(...jsonJvm);
  // `-cp` 通常由官方 JSON 给出（`-cp ${classpath}` 已展开），别重复追加
  if (!hasJvm('-cp') && !hasJvm('--class-path')) args.push('-cp', classPath);
  args.push(mainClass);

  // 游戏参数（新版 arguments.game，含父版本拼接；旧版 minecraftArguments）
  const gameArgs = [];
  const argSrc = json.arguments && json.arguments.game
    ? json.arguments.game
    : (json.minecraftArguments || '').split(/\s+/).filter(Boolean);
  for (const a of argSrc) {
    if (typeof a === 'string') {
      gameArgs.push(fillVars(a, vars));
    } else if (a && a.rules) {
      if (ruleAllowed(a.rules, features)) {
        const vals = Array.isArray(a.value) ? a.value : [a.value];
        for (const v of vals) gameArgs.push(fillVars(v, vars));
      }
    }
  }
  args.push(...gameArgs);
  // 窗口尺寸 / 全屏：JSON 已按 has_custom_resolution 输出过 --width/--height 就不重复追加
  if (fullscreen) args.push('--fullscreen');
  else if (width && height && !gameArgs.includes('--width')) {
    args.push('--width', String(width), '--height', String(height));
  }

  tell('玩家: ' + name + ' (' + userType + ')  UUID: ' + uuid);
  tell('版本: ' + version + '  资产索引: ' + assetIndex);
  tell('游戏目录: ' + gameDir);
  tell('游戏参数: ' + gameArgs.join(' '));

  // 干跑：只组装并返回命令，不 spawn（给「预览启动命令」和排障用）
  if (opts.dryRun) {
    return { ok: true, dryRun: true, args, gameDir, mainClass, clientJar, javaVersion: javaVer, javaBin };
  }

  // 启动（分离进程，关掉启动器游戏不受影响）
  const { spawn } = require('child_process');
  let child;
  try {
    child = spawn(javaBin, args, { cwd: gameDir, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.unref();
  } catch (e) {
    return { ok: false, error: '启动失败: ' + e.message };
  }
  return { ok: true, pid: child.pid, javaVersion: javaVer, child, gameDir, args };
}

module.exports = {
  listVersions, detectJava, launchGame, offlineUUID, requiredJavaMajor, ruleAllowed, libPath, javaVersionOf,
  /* 供单测使用的纯函数 / 解析器 */
  resolveClientJar, loadVersionJson, mergeJson, mergeArguments, expandJvmArgs, fillVars, javaMajorOf,
  LAUNCHER_NAME, APP_VERSION
};
