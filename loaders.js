// Pebble Launcher - 加载器自动安装（Forge / NeoForge / Fabric / Quilt / OptiFine）
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { downloadFile, fetchJson, mirrorOf } = require('./downloader');
const { prefetchInstallerLibraries, ensureVersionJson } = require('./installerprep');

const BMCL = 'https://bmclapi2.bangbang93.com';
const FORGE_MAVEN = 'https://maven.minecraftforge.net';
const FORGE_PROMOS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';

async function fetchText(url) {
  // 官方优先、镜像兜底。**不能**反过来：BMCLAPI 上 Forge 的 maven-metadata.xml
  // 是 2022-02-21 的冻结快照，镜像优先会让 Forge 列表又卡回 1.18。
  const urls = [url, mirrorOf(url)].filter(Boolean);
  let lastErr;
  for (const u of urls) {
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error('获取失败: ' + url + ' (' + (lastErr && lastErr.message) + ')');
}

/**
 * 镜像优先的 JSON 拉取（只用于 Fabric / Quilt 这类「镜像和官方同构」的元数据）。
 * 官方通常要等满 30 秒超时才回落，镜像 0.2 秒就回来了。
 */
async function fetchJsonMirrorFirst(officialUrl) {
  const m = mirrorOf(officialUrl);
  if (m) {
    try {
      return await fetchJson(m);
    } catch {
      /* 落回官方 */
    }
  }
  return await fetchJson(officialUrl);
}

/* ---------- 元数据解析 ---------- */
function parseMavenVersions(xml) {
  const out = [];
  const re = /<version>([^<]+)<\/version>/g;
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

/* ---------- 版本号比较（点分数字，1.9 < 1.21 < 26.2） ---------- */
function cmpDotted(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10));
  const pb = String(b).split('.').map(n => parseInt(n, 10));
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}
const byVerDesc = (a, b) => cmpDotted(b.version, a.version);

/* ---------- Forge 版本列表 ----------
 * 历史坑：以前只读 BMCLAPI 的 /maven/net/minecraftforge/forge/maven-metadata.xml，
 * 而那份元数据是 2022-02-21 的冻结快照（<latest> 恒为 1.18-38.0.17），
 * 导致 1.19 之后**所有** MC 版本一律拿不到 Forge 列表，UI 显示「获取失败」。
 * 现在改成多来源，且能区分「网络失败」和「该 MC 版本还没被 Forge 支持」：
 *   1) BMCLAPI /forge/minecraft/<mc>  —— 国内快，未发布时明确返回 []
 *   2) 官方 maven-metadata.xml        —— 兜底（BMCL 挂掉/格式变化）
 *   3) 官方 promotions_slim.json      —— 只用于标注「推荐/最新」+ 推断最高支持版本
 */
async function forgeBuildsFromBmcl(mc) {
  const r = await fetchJson(`${BMCL}/forge/minecraft/${encodeURIComponent(mc)}`);
  if (!Array.isArray(r)) throw new Error('接口返回非数组');
  return r
    .map(o => ({ version: String(o.version || '').trim(), build: Number(o.build) || 0, time: o.modified || '' }))
    .filter(o => /^\d+\.\d+/.test(o.version));
}

/** 纯函数：从 maven-metadata.xml 里挑出某个 MC 版本的构建（去掉 <mc>- 前缀，得到裸 Forge 版本号） */
function parseForgeMavenVersions(xml, mc) {
  const head = String(mc) + '-';
  return parseMavenVersions(xml)
    .filter(v => v.startsWith(head) && !v.includes('installer'))
    .map(v => ({ version: v.slice(head.length), build: 0, time: '' }))
    .filter(o => /^\d+\.\d+/.test(o.version));
}

async function forgeBuildsFromMaven(mc) {
  const xml = await fetchText(`${FORGE_MAVEN}/net/minecraftforge/forge/maven-metadata.xml`);
  return parseForgeMavenVersions(xml, mc);
}

let _promos = { at: 0, data: null };
async function forgePromos() {
  if (_promos.data && Date.now() - _promos.at < 10 * 60 * 1000) return _promos.data;
  const j = await fetchJson(FORGE_PROMOS);
  const p = (j && j.promos) || {};
  _promos = { at: Date.now(), data: p };
  return p;
}

/** 纯函数：promos 里所有被支持过的 MC 版本，按版本号升序 */
function promosSupportedMc(promos) {
  const set = new Set();
  for (const k of Object.keys(promos || {})) {
    const m = /^(.+?)-(latest|recommended)$/.exec(k);
    if (m) set.add(m[1]);
  }
  return [...set].sort(cmpDotted);
}

/** 纯函数：UI 可能传整串 "26.2-65.1.3"（历史格式）或裸号 "65.1.3"，统一成裸号 */
function normalizeForgeVersion(mcVersion, version) {
  let v = String(version || '').trim();
  const mc = String(mcVersion || '').trim();
  if (mc && v.startsWith(mc + '-')) v = v.slice(mc.length + 1);
  // 传进来只有 MC 版本号（Forge 版本号历史上从不等于 MC 版本号）→ 视为无效，避免拼出 404 URL
  if (mc && v === mc) return '';
  return /^\d+\.\d+/.test(v) ? v : '';
}

/**
 * 纯函数：拼 Forge 安装器地址。
 * 注意别把 "<mc>-" 拼两次（历史上 UI 传整串 + 这里再补前缀 = forge-26.2-26.2-65.1.3 → 404）。
 */
function forgeInstallerUrls(mcVersion, version) {
  const bare = normalizeForgeVersion(mcVersion, version);
  if (!bare) return null;
  const full = `${mcVersion}-${bare}`;
  const file = `forge-${full}-installer.jar`;
  return {
    bare, full, file,
    urls: [
      `${BMCL}/maven/net/minecraftforge/forge/${full}/${file}`,
      `${FORGE_MAVEN}/net/minecraftforge/forge/${full}/${file}`
    ]
  };
}

async function forgeVersions(mcVersion) {
  const mc = String(mcVersion || '').trim();
  if (!mc) return { ok: false, list: [], error: '未指定 MC 版本' };

  let builds = null;
  const errs = [];
  try { builds = await forgeBuildsFromBmcl(mc); }
  catch (e) { errs.push('BMCLAPI: ' + e.message); }

  // BMCLAPI 说「没有」时再用官方源复核一次，避免镜像滞后导致误判
  if (builds !== null && builds.length === 0) {
    try {
      const alt = await forgeBuildsFromMaven(mc);
      if (alt.length) builds = alt;
    } catch { /* 官方也拿不到，按未发布处理 */ }
  }
  if (builds === null) {
    try { builds = await forgeBuildsFromMaven(mc); }
    catch (e) { errs.push('Forge 官方: ' + e.message); }
  }
  // 两个来源全挂 → 真·网络故障，报错而不是「未发布」
  if (builds === null) {
    return { ok: false, list: [], error: '版本列表获取失败（' + errs.join('；') + '）' };
  }

  let promos = {};
  try { promos = await forgePromos(); } catch { promos = {}; }
  const rec = promos[`${mc}-recommended`] || '';
  const lat = promos[`${mc}-latest`] || '';

  const dedup = new Map();
  for (const b of builds) if (!dedup.has(b.version)) dedup.set(b.version, b);
  const list = [...dedup.values()].sort(byVerDesc).slice(0, 15)
    .map(b => ({ version: b.version, build: b.build, tag: b.version === rec ? '推荐' : (b.version === lat ? '最新' : '') }));

  if (!list.length) {
    const supported = promosSupportedMc(promos);
    const top = supported.length ? supported[supported.length - 1] : '';
    return {
      ok: true, list: [], reason: 'unsupported', forgeLatestMc: top || null,
      message: top
        ? `Forge 尚未发布 MC ${mc} 的构建（当前最高支持 ${top}）`
        : `未找到 MC ${mc} 的 Forge 构建，请确认版本号`
    };
  }
  return { ok: true, list };
}

/**
 * 纯函数：MC 版本 → NeoForge 版本前缀。
 * NeoForge 版本号就是「MC 版本去掉前导 1.」+ 构建号：
 *   1.21.1 → 21.1.x        26.2 → 26.2.0.x
 * 例外：MC 1.20.1 沿用 Forge 风格的 47.x。
 */
function neoforgeMcPrefix(mcVersion) {
  const mc = String(mcVersion || '').trim();
  if (!mc) return [];
  return mc === '1.20.1' ? ['47.', '20.1'] : [mc.startsWith('1.') ? mc.slice(2) : mc];
}

async function neoforgeVersions(mcVersion) {
  const mc = String(mcVersion || '').trim();
  if (!mc) throw new Error('未指定 MC 版本');

  /* 历史坑（2026-10-25 实测）：以前只读 maven.neoforged.net 的 maven-metadata.xml。
     这个域名在国内经常直接连不上 —— 20 秒超时、`fetch failed`，
     UI 就只显示「获取失败」，用户以为是自己填错了版本。
     改成镜像优先：BMCLAPI 有按 MC 版本过滤好的 /neoforge/list/<mc>，
     国内 0.3 秒返回；官方 maven 只当兜底。 */
  const errs = [];
  let all = null;
  try {
    all = await neoforgeVersionsFromBmcl(mc);
  } catch (e) {
    errs.push('BMCLAPI: ' + e.message);
  }
  // 镜像返回空 = 这个 MC 版本确实还没发布，但镜像也可能滞后，再用官方复核一次
  if (!all || !all.length) {
    try {
      all = await neoforgeVersionsFromMaven(mc);
    } catch (e) {
      errs.push('NeoForge 官方: ' + e.message);
    }
  }
  if (all === null) throw new Error('版本列表获取失败（' + errs.join('；') + '）');

  // 返回字符串数组（与旧契约一致，IPC 层直接塞进 list，前端 String(v) 就能用）
  return [...new Set(all)].sort((a, b) => cmpDotted(b, a)).slice(0, 15);
}

/** BMCLAPI：已按 MC 版本过滤，直接就是该版本的构建列表 */
async function neoforgeVersionsFromBmcl(mc) {
  let r;
  try {
    r = await fetchJson(`${BMCL}/neoforge/list/${encodeURIComponent(mc)}`);
  } catch (e) {
    // 404 = 这个 MC 版本没有 NeoForge 构建（不是网络故障），按空列表处理，
    // 免得把「还没发布」也报成「获取失败」
    if (/HTTP 404/.test(e.message)) return [];
    throw e;
  }
  if (!Array.isArray(r)) throw new Error('接口返回非数组');
  return r
    .map(o => String(o.version || o.rawVersion || '').replace(/^neoforge-/, '').trim())
    .filter(v => /^\d+\.\d+/.test(v));
}

/** 官方 maven：全量列表，按 MC 前缀过滤（1.21.1 → 21.1.x） */
async function neoforgeVersionsFromMaven(mcVersion) {
  const xml = await fetchText(`${NEOFORGE_MAVEN}/maven-metadata.xml`);
  const prefixes = neoforgeMcPrefix(mcVersion);
  if (!prefixes.length) return [];
  return parseMavenVersions(xml).filter(v => prefixes.some(p => v.startsWith(p.endsWith('.') ? p : p + '.')));
}

/**
 * 纯函数：NeoForge 安装器地址。
 * 镜像在前：maven.neoforged.net 在国内不通是这个 bug 的根因，
 * 官方地址留着只是为了镜像挂掉时不至于完全装不了。
 */
function neoforgeInstallerUrls(version) {
  const v = String(version || '').trim();
  if (!/^\d+\.\d+/.test(v)) return null;
  const file = `neoforge-${v}-installer.jar`;
  return {
    file,
    urls: [
      `${BMCL}/maven/net/neoforged/neoforge/${v}/${file}`,
      `${NEOFORGE_MAVEN}/${v}/${file}`,
    ],
  };
}

async function fabricLoaderVersions() {
  const r = await fetchJsonMirrorFirst('https://meta.fabricmc.net/v2/versions/loader');
  const arr = Array.isArray(r) ? r : [];
  // Fabric meta 现在只把「最新那一个」loader 标成 stable:true（253 条里 1 条），
  // 按 stable 过滤会让下拉只剩 1 项，没法回退旧版本。改成交出最新 10 个 + 稳定标记。
  return arr.slice(0, 10).map(v => ({ version: v.version, tag: v.stable ? '稳定' : '' }));
}

async function fabricInstallerUrl() {
  const r = await fetchJsonMirrorFirst('https://meta.fabricmc.net/v2/versions/installer');
  const v = (r || [])[0];
  if (!v) throw new Error('无法获取 Fabric installer');
  return { version: v.version, url: `https://maven.fabricmc.net/net/fabricmc/fabric-installer/${v.version}/fabric-installer-${v.version}.jar` };
}

async function quiltLoaderVersions() {
  const r = await fetchJsonMirrorFirst('https://meta.quiltmc.org/v3/versions/loader');
  return (r || []).map(v => v.version).slice(0, 10);
}

async function quiltInstallerUrl() {
  const xml = await fetchText('https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/maven-metadata.xml');
  const all = parseMavenVersions(xml);
  const v = all[all.length - 1];
  if (!v) throw new Error('无法获取 Quilt installer');
  return { version: v, url: `https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/${v}/quilt-installer-${v}.jar` };
}

async function optifineVersions(mcVersion) {
  // BMCLAPI 提供 OptiFine 列表
  const r = await fetchJson(`${BMCL}/optifine/${mcVersion}`);
  return (r || []).map(o => ({
    version: o.patch || o.version,
    type: o.type,
    mirror: o.mirror || (o.file ? `${BMCL}/optifine/${mcVersion}/${o.type}/${o.patch}` : null)
  }));
}

/* ---------- 预建 launcher_profiles.json ----------
 * 加载器安装器（Forge / NeoForge / Fabric / Quilt）在「写/读启动器 profile」这一步
 * 都要读 <mcDir>/launcher_profiles.json。Pebble 自己用版本 JSON + 实例系统管理启动，
 * 从不写这个文件，于是首次装任何加载器时它往往不存在，旧版安装器会直接抛
 * “Could not find a valid launcher profile .json” 然后整个安装失败（典型现象：
 * fabric-loader-xxx.json 已经写出来了，却在末步报这个错）。
 * 这里在安装前确保它存在且合法：
 *   - 已存在且是合法 JSON（含 profiles 字段）→ 不动（保护用户可能共用的官方启动器配置）
 *   - 不存在 → 写最小合法壳 {"profiles":{},"settings":{},"version":3}
 *   - 存在但损坏（解析失败 / 缺 profiles）→ 先备份 .bak，再写最小壳
 * 返回 true 表示「新建/修复了文件」，false 表示本来就没问题。
 */
function ensureLauncherProfiles(mcDir) {
  if (mcDir) { try { fs.mkdirSync(mcDir, { recursive: true }); } catch {} }
  const p = path.join(mcDir || '.', 'launcher_profiles.json');
  let valid = false;
  try {
    const o = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (o && typeof o === 'object' && ('profiles' in o)) valid = true;
  } catch {}
  if (valid) return false;
  if (fs.existsSync(p)) {
    try { fs.copyFileSync(p, p + '.bak'); } catch {}
  }
  fs.writeFileSync(p, JSON.stringify({ profiles: {}, settings: {}, version: 3 }, null, 2));
  return true;
}

/* ---------- 安装执行 ---------- */
/** 依次尝试多个源下载同一个文件；大小异常（半截文件/错误页）自动换下一个源 */
async function downloadFirst(urls, dest) {
  let lastErr;
  for (const u of urls) {
    try {
      await downloadFile(u, dest);
      const size = fs.statSync(dest).size;
      if (size >= 64 * 1024) return u; // 加载器安装器至少几百 KB
      throw new Error('文件不完整（' + size + ' 字节）');
    } catch (e) {
      lastErr = e;
      try { fs.unlinkSync(dest); } catch {}
      try { fs.unlinkSync(dest + '.part'); } catch {}
    }
  }
  throw new Error('下载失败: ' + (lastErr ? lastErr.message : '未知') + ' | ' + urls.join(' , '));
}

/* ---------- 安装器命令行参数（纯函数，契约由单测锁死） ----------
 * 各加载器安装器的 CLI 坑不一处，集中在这里生成。
 *
 * Fabric：安装器末步会走 ProfileInstaller.getInstalledLauncherTypes()，只要
 * <dir> 下既没有 launcher_profiles.json 也没有 launcher_profiles_microsoft_store.json，
 * 就直接抛 FileNotFoundException("Could not find a valid launcher profile .json")。
 * 官方给第三方启动器留了 -noprofile —— 跳过整套 profile 逻辑。Pebble 用的是
 * 「版本 JSON + 实例」体系，本来就不需要官方 profile，所以用 -noprofile：
 * 既不报错，也不会去动/伪造用户真实的 .minecraft 启动器配置。
 *   ⚠ -noprofile 必须放最后：ArgumentParser 对「无值 flag」的解析方式是
 *     「下一个以 - 开头的 token 才算下一个参数」，后面若再跟不带 - 的 token，
 *     就会被吃成它的值。
 *   ⚠ 参数键不能重复，否则 ArgumentParser 直接抛 "Argument x already passed"。
 *
 * Quilt：对应开关叫 --no-profile（已带）。
 * Forge / NeoForge：没有跳过开关，硬要求 <mcDir>/launcher_profiles.json 存在，
 * 由 ensureLauncherProfiles 兜底（见上）。
 */
/* ---------- 安装器输出解码 ----------
 * 中文 Windows 上 Java 进程往管道里写的是 GBK（控制台代码页），
 * 一律 buf.toString() 会解成「1 ?????????」这种乱码，用户根本无法判断错在哪。
 * 先按严格 UTF-8 试一次：不抛就说明对方真是 UTF-8；抛了就是 GBK，改用它。
 */
function makeStreamDecoder() {
  let dec = null;
  return function decode(buf) {
    if (!dec) {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(buf, { stream: true });
        dec = new TextDecoder('utf-8');
      } catch {
        try { dec = new TextDecoder('gbk'); } catch { dec = new TextDecoder('utf-8'); }
      }
    }
    return dec.decode(buf, { stream: true });
  };
}

/**
 * 把安装器的失败翻译成一句人话。
 * 原始堆栈已经由 pump 打进「运行日志」了，状态栏不该再糊一屏 at java.base/...
 */
function humanizeInstallerFailure(code, out, loader) {
  const s = String(out || '');
  if (/(拒绝访问|AccessDenied|另一个程序|正在使用|being used by another process|The process cannot access)/i.test(s)) {
    return `安装器退出码 ${code}：目标文件被占用。先把游戏关掉、等杀毒软件扫完再重试。`;
  }
  if (/(Timed out|timed out|UnknownHost|Connection reset|ConnectException|502|503|504)/i.test(s)) {
    // 别再把 Forge/NeoForge 的超时也说成 fabricmc.net —— 它们跟 Fabric 没关系，
    // 用户照着这句话去查 fabricmc 会白折腾。
    const host =
      loader === 'neoforge' ? 'maven.neoforged.net' :
        loader === 'forge' ? 'maven.minecraftforge.net' :
          'meta.fabricmc.net';
    return `安装器退出码 ${code}：下载依赖超时（${host} 在国内不稳定）。依赖已尽量走镜像预置，仍失败就再点一次安装。`;
  }
  if (/(Could not find or load main class|UnsupportedClassVersionError)/i.test(s)) {
    return `安装器退出码 ${code}：Java 版本不对，换 17 或 21 再试。`;
  }
  return `安装器退出码 ${code}：安装器自己报错了，详细堆栈见下方「运行日志」。`;
}

function loaderCliArgs(o) {
  const { loader, jarPath, mcDir, mcVersion, version } = o;
  switch (loader) {
    case 'forge':
      return ['-jar', jarPath, '--installClient', mcDir];
    case 'neoforge':
      return ['-jar', jarPath, '--install-client', mcDir];
    case 'fabric':
      return ['-jar', jarPath, 'client', '-mcversion', mcVersion, '-loader', version, '-dir', mcDir, '-noprofile'];
    case 'quilt':
      return ['-jar', jarPath, 'install', 'client', mcVersion, version, '--install-dir=' + mcDir, '--no-profile'];
    case 'optifine':
      return ['-jar', jarPath]; // OptiFine 需要 GUI 点击安装
    default:
      throw new Error('暂不支持的加载器: ' + loader);
  }
}

/** 只有这两个安装器强制要求 launcher_profiles.json 存在（它们没有 -noprofile 这类开关） */
const PROFILE_REQUIRED = new Set(['forge', 'neoforge']);

async function installLoader(opts, onLog) {
  const { loader, mcDir, mcVersion, version, javaBin } = opts;
  const log = (s) => onLog && onLog(String(s));
  if (!javaBin) throw new Error('未指定 Java，无法执行安装器');

  const tmpDir = path.join(mcDir, 'pl-temp');
  fs.mkdirSync(tmpDir, { recursive: true });

  // Fabric/Quilt 走各自的「跳过 profile」开关，不去动用户的 .minecraft；
  // 只有 Forge/NeoForge 真的需要这个文件，缺了才补。
  if (PROFILE_REQUIRED.has(loader)) {
    const created = ensureLauncherProfiles(mcDir);
    if (created) log('预建 launcher_profiles.json（' + loader + ' 安装器强制要求此文件）');
  }

  let jarPath;

  if (loader === 'forge') {
    // 兼容 UI 传过来的两种格式：整串 "26.2-65.1.3" 或裸号 "65.1.3"
    const info = forgeInstallerUrls(mcVersion, version);
    if (!info) throw new Error('Forge 版本号无效: ' + version);
    jarPath = path.join(tmpDir, info.file);
    log('下载 Forge 安装器 ' + info.bare + '…');
    await downloadFirst(info.urls, jarPath);
  } else if (loader === 'neoforge') {
    const info = neoforgeInstallerUrls(version);
    if (!info) throw new Error('NeoForge 版本号无效: ' + version);
    jarPath = path.join(tmpDir, info.file);
    log('下载 NeoForge 安装器 ' + version + '…');
    await downloadFirst(info.urls, jarPath);
  } else if (loader === 'fabric') {
    const info = await fabricInstallerUrl();
    jarPath = path.join(tmpDir, 'fabric-installer.jar');
    log('下载 Fabric 安装器 (' + info.version + ')…');
    await downloadFile(info.url, jarPath);
  } else if (loader === 'quilt') {
    const info = await quiltInstallerUrl();
    jarPath = path.join(tmpDir, 'quilt-installer.jar');
    log('下载 Quilt 安装器 (' + info.version + ')…');
    await downloadFile(info.url, jarPath);
  } else if (loader === 'optifine') {
    const [type, patch] = String(version).split('|');
    jarPath = path.join(tmpDir, `OptiFine_${mcVersion}_${type}_${patch}.jar`);
    const url = `${BMCL}/optifine/${mcVersion}/${type}/${patch}`;
    log('下载 OptiFine 安装器…');
    await downloadFile(url, jarPath);
    log('注意：OptiFine 安装器为图形界面，请在弹出窗口中点击 Install');
  } else {
    throw new Error('暂不支持的加载器: ' + loader);
  }

  const args = loaderCliArgs({ loader, jarPath, mcDir, mcVersion, version });

  /* Forge / NeoForge 的安装器不走 -Dhttps.proxy，也不认 --mirror（实测），
     它们直连 maven.neoforged.net 下 70 个库。国内这个域名不通，
     每个库等一次超时就整体失败。所以先把库预置进 libraries/，
     安装器看到 "File exists. Checksum valid." 就跳过下载。 */
  if (loader === 'forge' || loader === 'neoforge') {
    try {
      await prefetchInstallerLibraries(jarPath, mcDir, log);
    } catch (e) {
      log('依赖预置失败（继续让安装器自己试）: ' + e.message);
    }
  }

  log('执行安装: ' + path.basename(jarPath));
  return new Promise((resolve, reject) => {
    /* 装上编码开关：Java 19+ 支持 stdout/stderr.encoding，
       老版本会当成普通系统属性忽略掉，不报错。
       这样安装器写出的中文提示就是 UTF-8，配合下面的解码兜底不会乱码。 */
    const enc = ['-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8', '-Dfile.encoding=UTF-8'];
    const p = spawn(javaBin, enc.concat(args), { cwd: tmpDir, windowsHide: true });
    const decode = makeStreamDecoder();
    let out = '';
    const pump = (buf) => {
      const s = decode(buf);
      out += s;
      for (const line of s.split('\n')) if (line.trim()) log(line.trim().slice(0, 300));
    };
    p.stdout.on('data', pump);
    p.stderr.on('data', pump);
    p.on('error', e => reject(new Error('启动安装器失败: ' + e.message)));
    p.on('close', code => {
      const tail = decode(Buffer.alloc(0));   // 冲掉流式解码器里剩下的字节
      if (tail) { out += tail; log(tail.trim()); }
      if (code === 0) {
        // NeoForge 21.1.264 的安装器只写 launcher_profiles.json，
        // 不写 versions/<id>/<id>.json —— 不补这份，启动器列表里就没有它。
        if (loader === 'forge' || loader === 'neoforge') {
          try {
            ensureVersionJson(jarPath, mcDir, log);
          } catch (e) {
            log('补写版本清单失败: ' + e.message);
          }
        }
        resolve({ ok: true, loader, version, log: out.slice(-2000) });
      } else {
        reject(new Error(humanizeInstallerFailure(code, out, loader)));
      }
    });
  });
}

module.exports = {
  forgeVersions, neoforgeVersions, fabricLoaderVersions, quiltLoaderVersions, optifineVersions,
  installLoader,
  /* 供单测使用的纯函数 */
  cmpDotted, parseForgeMavenVersions, promosSupportedMc, normalizeForgeVersion, forgeInstallerUrls,
  neoforgeMcPrefix, neoforgeInstallerUrls, ensureLauncherProfiles, loaderCliArgs, PROFILE_REQUIRED,
  makeStreamDecoder, humanizeInstallerFailure
};
