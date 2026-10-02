// Pebble Lunchar - 整合包创建向导（V4 第四组 · R19）
//
// 要解决的事：玩家装了几百个 mod，想分享给朋友 —— 但直接 zip 整个 mods 目录
// 有几个问题：① 体积巨大（大家都有的 API 也塞进去了）；② 版权不干净（作者不允许二次分发）；
// ③ 对方装了会冲突（本地私货 mod 一起被打包）。
//
// 这里做的是「向导 + 检查 + 打包」三段，**全程本地、只读原目录、输出到新 zip**：
//
//   1. 挑选：从本地已下载的 mod 里勾选要包含的
//   2. 检查：复用 modguard 的依赖分析，找出「缺依赖」「版本冲突」「载入器混装」
//      —— 关键点：**缺的依赖要能明确告诉用户"还差哪几个"**，而不是笼统报个错
//   3. 导出：生成 manifest.json（记录 MC 版本/载入器/mod 清单与依赖）+ 可选的
//      mods/ 目录打包，或者只导出清单（推荐 —— 让使用者自己下载，规避版权问题）
//
// 默认走「只导出清单」模式：这是最干净的分享方式，也让本功能不碰版权红线。

const fs = require('fs');
const path = require('path');
const modguard = require('./modguard');

/* 由启动器/载入器提供的依赖，不算"需要玩家装的 mod"。
 *
 * ⚠️ 与 modguard 的同名表**故意不一致**：modguard 那份还含 `fabric` / `fabric-api`
 * （它在做"依赖差集"时把 Fabric API 当公共设施处理）。
 * 但在**整合包**语境下这是错的 —— Fabric API 不是载入器自带的，玩家**必须自己装**，
 * 而且它恰恰是整合包最常见的头号依赖。把它当内置会直接从依赖清单里消失，
 * 使用者按清单装完仍然缺依赖、进不去游戏。所以这里只保留真正的"载入器/游戏/Java 本身"。
 */
const BUILTIN_DEPS = new Set([
  'minecraft', 'forge', 'neoforge', 'fabricloader',
  'quilt_loader', 'quilt_base', 'java', 'minecraftforge', 'fml', 'neoforged'
]);

/** 这个依赖是不是载入器/游戏自带的 */
function isBuiltinDep(id) {
  return BUILTIN_DEPS.has(String(id || '').toLowerCase());
}

const LIBRARY_HINTS = new Set([
  'fabric-api', 'fabric', 'architectury', 'architectury-api', 'cloth-config',
  'cloth-config2', 'geckolib', 'citresewn', 'forge-config-api-port',
  'kotlinforforge', 'kfflang', 'bookshelf', 'balm', 'patchouli',
  'collective', 'resourceful-lib', 'moonlight', 'curios', 'flywheel',
  'create', 'botania', 'libipn', 'trinkets', 'yacl', 'owo-lib',
  'cloth_config', 'midnightlib', 'sodium', 'iris', 'indium'
]);

/** 判断某个 mod id 是不是"基础库" */
function isLibrary(id) {
  const s = String(id || '').toLowerCase();
  if (!s) return false;
  if (LIBRARY_HINTS.has(s)) return true;
  // `somelib`（连写）/ `my-core`（分隔）/ `xx_framework` 都要命中；
  // 但 `create` 这种"关键词恰好是完整单词的普通 mod"不能命中 —— 所以要求关键词
  // 要么紧跟分隔符，要么直接结尾。
  return /(^|[-_])(api|lib|library|core|config|loader|hook|hub|bridge|framework|runtime)([-_]|$)/.test(s)
      || /(api|lib|library|core|config|loader|hook|hub|bridge|framework|runtime)$/.test(s) && /[-_\d]|^[a-z]{2,}(api|lib|core)$/.test(s);
}

/* ---------------- ① 建立候选清单 ---------------- */

/**
 * 扫描 mods 目录，给出可选的 mod 清单（带分类、依赖、体积）
 * @param {{modsDir:string, mcVersion?:string, loader?:string}} o
 */
function candidates(o) {
  const opt = /** @type {any} */ (o || {});
  const { mods, ok, dir } = modguard.scan({ modsDir: opt.modsDir });

  const mc = opt.mcVersion || '';
  const items = mods.map((m) => {
    const deps = (m.deps || [])
      .filter((d) => d.mandatory && d.modId && !isBuiltinDep(d.modId))
      .map((d) => ({ id: d.modId, range: d.versionRange || '' }));

    // 该 mod 是否支持当前 MC 版本
    const range = (m.deps || []).find((d) => d.modId === 'minecraft');
    const mcRange = (range && range.versionRange) || m.mcRange || '';
    const mcOk = !mc || !mcRange ? null : modguard.mcSatisfies(mc, mcRange);

    return {
      file: m.file,
      id: m.id,
      name: m.name,
      version: m.version,
      loader: m.loader,
      size: m.size,
      enabled: m.enabled,
      unknown: m.unknown,
      deps,
      mcRange,
      mcOk,
      library: isLibrary(m.id) || isLibrary(m.file),
      // 名字里带 "config" 且体积很小的，多半是配置文件而非 mod
      suspectConfig: /\.(json|toml|cfg)$/i.test(m.file)
    };
  });

  items.sort((a, b) => (a.library === b.library ? a.name.localeCompare(b.name) : (a.library ? 1 : -1)));

  return {
    ok, dir,
    items,
    stats: {
      total: items.length,
      libraries: items.filter((i) => i.library).length,
      unknown: items.filter((i) => i.unknown).length,
      mcMismatch: items.filter((i) => i.mcOk === false).length,
      totalBytes: items.reduce((n, i) => n + (i.size || 0), 0)
    }
  };
}

/* ---------------- ② 依赖与冲突检查 ---------------- */

/**
 * 对一组"勾选好的 mod"做检查
 * @param {{modsDir:string, selected:string[], mcVersion?:string, loader?:string}} o
 *   selected 是选中的文件名（带扩展名）或 modId —— 两种都认
 */
function check(o) {
  const opt = /** @type {any} */ (o || {});
  const all = candidates({ modsDir: opt.modsDir, mcVersion: opt.mcVersion, loader: opt.loader });
  const sel = new Set((opt.selected || []).map((s) => String(s).toLowerCase()));

  const picked = all.items.filter((i) => sel.has(String(i.file).toLowerCase()) || sel.has(String(i.id).toLowerCase()));
  const pickedIds = new Set(picked.filter((i) => i.id).map((i) => i.id.toLowerCase()));
  const availableIds = new Set(all.items.filter((i) => i.id).map((i) => i.id.toLowerCase()));

  const issues = [];
  const push = (level, code, title, detail, modId) => issues.push({ level, code, title, detail, modId });

  /* —— 缺依赖 —— */
  const missing = new Map();      // id → { id, range, wantedBy: [] }
  for (const m of picked) {
    for (const d of m.deps) {
      const id = d.id.toLowerCase();
      if (pickedIds.has(id)) continue;
      if (!missing.has(id)) missing.set(id, { id: d.id, range: d.range, wantedBy: [] });
      missing.get(id).wantedBy.push(m.name || m.file);
    }
  }
  for (const d of missing.values()) {
    const inLib = availableIds.has(d.id.toLowerCase());
    push(inLib ? 'warn' : 'error', inLib ? 'DEP_NOT_PICKED' : 'DEP_MISSING',
      inLib ? '依赖没勾选' : '缺少依赖',
      `「${d.wantedBy.join('、')}」需要 ${d.id}${d.range ? ' ' + d.range : ''}` +
      (inLib ? '，它在你本地有，但没勾进来。' : '，你的 mods 目录里也没有 —— 整合包里必须补上，或换掉那个 mod。'),
      d.id);
  }

  /* —— 依赖版本不满足 —— */
  const byId = new Map(picked.filter((i) => i.id).map((i) => [i.id.toLowerCase(), i]));
  for (const m of picked) {
    for (const d of m.deps) {
      const dep = byId.get(d.id.toLowerCase());
      if (!dep || !d.range || !dep.version) continue;
      if (!versionSatisfies(dep.version, d.range)) {
        push('error', 'DEP_VERSION', '依赖版本不满足',
          `「${m.name}」要求 ${d.id} ${d.range}，但勾选的是 ${dep.version}。`, d.id);
      }
    }
  }

  /* —— MC 版本不匹配 —— */
  const mc = opt.mcVersion;
  if (mc) {
    for (const m of picked) {
      if (m.mcOk === false) {
        push('error', 'MC_MISMATCH', 'MC 版本不支持',
          `「${m.name}」要求 ${m.mcRange}，当前整合包目标是 ${mc}。`, m.id);
      }
    }
  }

  /* —— 载入器混装 —— */
  const loaders = new Map();
  for (const m of picked) {
    const l = (m.loader || '').toLowerCase();
    if (l) loaders.set(l, (loaders.get(l) || 0) + 1);
  }
  const boot = String(opt.loader || '').toLowerCase();
  if (boot) {
    for (const [l, n] of loaders) {
      const okMap = { fabric: { fabric: true, quilt: 'warn' }, quilt: { fabric: 'warn', quilt: true },
                      forge: { forge: true }, neoforge: { neoforge: true } };
      const verdict = (okMap[boot] || {})[l];
      if (verdict === false || verdict === undefined) {
        push('error', 'LOADER_MIX', '载入器不匹配',
          `有 ${n} 个 ${l} 的 mod，但整合包用的是 ${boot}。混装生态几乎必定崩溃。`, '');
      } else if (verdict === 'warn') {
        push('warn', 'LOADER_WARN', '载入器跨生态',
          `有 ${n} 个 ${l} 的 mod 跑在 ${boot} 上，通常能用但不保证。`, '');
      }
    }
  } else if (loaders.size > 1) {
    push('warn', 'LOADER_MIXED', '勾选的 mod 来自多个生态',
      `包含 ${Array.from(loaders.entries()).map(([k, v]) => `${k}×${v}`).join('、')}。建议统一到一个载入器。`, '');
  }

  /* —— 重复 modId（不该发生，但勾选时可能有同名不同版本） —— */
  const dup = new Map();
  for (const m of picked) {
    if (!m.id) continue;
    const k = m.id.toLowerCase();
    if (!dup.has(k)) dup.set(k, []);
    dup.get(k).push(m);
  }
  for (const [id, list] of dup) {
    if (list.length > 1) {
      push('error', 'DUP_ID', '同一个 mod 勾了多个版本',
        `${id} 有 ${list.length} 份：${list.map((x) => x.version || x.file).join('、')}。同时加载会崩溃。`, id);
    }
  }

  /* —— 元数据无法识别 —— */
  for (const m of picked) {
    if (m.unknown || !m.id) {
      push('info', 'UNKNOWN_META', '无法识别元数据',
        `「${m.file}」读不到 modId，依赖检查已跳过。它可能不是标准 mod，或打包不规范。`, '');
    }
  }

  const order = { error: 0, warn: 1, info: 2 };
  issues.sort((a, b) => order[a.level] - order[b.level]);

  const errors = issues.filter((i) => i.level === 'error');

  return {
    ok: true,
    picked: picked.map((p) => ({ file: p.file, id: p.id, name: p.name, version: p.version, size: p.size, library: p.library })),
    count: picked.length,
    bytes: picked.reduce((n, p) => n + (p.size || 0), 0),
    missing: Array.from(missing.values()),
    issues,
    hasError: errors.length > 0,
    errorCount: errors.length,
    warnCount: issues.filter((i) => i.level === 'warn').length,
    // 一键补齐建议：把"本地有但没勾"的依赖列出来，UI 上能直接"全选这些"
    suggestAdd: Array.from(missing.values())
      .filter((d) => availableIds.has(d.id.toLowerCase()))
      .map((d) => d.id)
  };
}

/** 版本区间判断（复用 modguard 的语义，但作用于 mod 版本号而非 MC 版本） */
function versionSatisfies(ver, range) {
  const r = String(range || '').trim();
  if (!r || r === '*') return true;
  // maven 风格的区间 [1.0,2.0) 直接用 mcSatisfies 的逻辑（它本来就是通用版本比较）
  return modguard.mcSatisfies(ver, r);
}

/* ---------------- ③ 生成 manifest ---------------- */

/**
 * 生成整合包清单（给使用者看，也给启动器读）
 * @param {{modsDir:string, selected:string[], name?:string, author?:string,
 *          mcVersion?:string, loader?:string, loaderVersion?:string, note?:string}} o
 */
function buildManifest(o) {
  const opt = /** @type {any} */ (o || {});
  const chk = check(opt);

  const manifest = {
    formatVersion: 1,
    generator: 'Pebble Lunchar',
    name: opt.name || '未命名整合包',
    author: opt.author || '',
    note: opt.note || '',
    game: {
      minecraft: opt.mcVersion || '',
      loader: opt.loader || '',
      loaderVersion: opt.loaderVersion || ''
    },
    createdAt: new Date().toISOString(),
    // mods 清单：含 id/版本/依赖，使用者据此自己下载
    mods: chk.picked.map((p) => ({
      id: p.id, name: p.name, version: p.version, file: p.file, library: p.library
    })),
    // 依赖关系单独存，便于以后做"一键补齐"
    dependencies: collectDeps(opt),
    issues: chk.issues,
    stats: { count: chk.count, bytes: chk.bytes }
  };
  return manifest;
}

/** 收集所有勾选 mod 的对外依赖（id → 需要它的 mod 列表） */
function collectDeps(opt) {
  const all = candidates({ modsDir: opt.modsDir });
  const sel = new Set((opt.selected || []).map((s) => String(s).toLowerCase()));
  const picked = all.items.filter((i) => sel.has(String(i.file).toLowerCase()) || sel.has(String(i.id).toLowerCase()));

  const map = new Map();
  for (const m of picked) {
    for (const d of m.deps) {
      const k = d.id.toLowerCase();
      if (!map.has(k)) map.set(k, { id: d.id, range: d.range, requiredBy: [] });
      map.get(k).requiredBy.push(m.id || m.file);
    }
  }
  return Array.from(map.values());
}

/* ---------------- ④ 导出 ---------------- */

/**
 * 导出整合包
 *
 * mode：
 *   'manifest'  —— 只导出 manifest.json（默认，推荐：干净、无版权问题）
 *   'full'      —— manifest.json + mods/ 里的 jar（体积大，注意分发授权）
 *
 * 实现上不自己写 zip：复用 mcapi.zipDir 会走系统 tar。
 * 但这里要"挑文件打包"，所以先把选中的 jar 复制到临时目录再打包。
 *
 * @param {{modsDir:string, selected:string[], outZip:string, mode?:'manifest'|'full',
 *          name?:string, author?:string, mcVersion?:string, loader?:string,
 *          loaderVersion?:string, note?:string, onProgress?:(p:Object)=>void}} o
 */
async function exportPack(o) {
  const opt = /** @type {any} */ (o || {});
  const mode = opt.mode === 'full' ? 'full' : 'manifest';
  const outZip = opt.outZip;
  if (!outZip) return { ok: false, error: '没有指定输出路径（outZip）。' };

  const chk = check(opt);
  if (chk.hasError && !opt.force) {
    return {
      ok: false,
      error: `检查出 ${chk.errorCount} 个必须先解决的问题，没有导出。`,
      issues: chk.issues,
      needForce: true
    };
  }

  const manifest = buildManifest(opt);
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pl-pack-'));

  try {
    // manifest.json 放根目录（UTF-8 无 BOM，别的启动器读起来不会出错）
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    // 人类可读的说明（用户双击能看）
    fs.writeFileSync(path.join(tmp, 'README.txt'), buildReadme(manifest), 'utf8');

    if (mode === 'full') {
      const modsDir = path.join(tmp, 'mods');
      fs.mkdirSync(modsDir, { recursive: true });
      const sel = new Set((opt.selected || []).map((s) => String(s).toLowerCase()));
      const all = candidates({ modsDir: opt.modsDir });
      const picked = all.items.filter((i) => sel.has(String(i.file).toLowerCase()) || sel.has(String(i.id).toLowerCase()));

      let done = 0;
      for (const p of picked) {
        const src = path.join(opt.modsDir, p.file);
        try {
          fs.copyFileSync(src, path.join(modsDir, p.file));
        } catch { /* 单个文件失败不中断整体 */ }
        done++;
        if (opt.onProgress) opt.onProgress({ phase: 'copy', done, total: picked.length, file: p.file });
      }
    }

    // 打包：**自己写 zip**，不调系统 tar。
    // tar 在 MSYS 上是 zip 格式不支持的（会静默产出 tar 内容），
    // 且把 `C:\...` 当远程主机报 "Cannot connect to C:"。见 zipwrite.js 的模块注释。
    const zipwrite = require('./zipwrite');
    zipwrite.zipDir(outZip, tmp, { level: 9 });

    const size = fs.statSync(outZip).size;
    return {
      ok: true, outZip, mode, size,
      manifest,
      count: chk.count,
      issues: chk.issues,
      warned: chk.hasError && !!opt.force
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    // 清临时目录（尽力而为）
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch { /* Windows 上偶发占用，留给系统清理 */ }
  }
}

/** 生成给人看的 README */
function buildReadme(manifest) {
  const g = manifest.game || {};
  const lines = [
    `整合包：${manifest.name}`,
    manifest.author ? `作者：${manifest.author}` : '',
    manifest.note ? `说明：${manifest.note}` : '',
    '',
    `游戏版本：${g.minecraft || '未指定'}`,
    `载入器：${g.loader || '未指定'}${g.loaderVersion ? ' ' + g.loaderVersion : ''}`,
    `Mod 数量：${(manifest.mods || []).length}`,
    `导出时间：${manifest.createdAt}`,
    '',
    '— Mod 清单 —',
    '',
    ...(manifest.mods || []).map((m, i) =>
      `${String(i + 1).padStart(3, ' ')}. ${m.name || m.id}  ${m.version || ''}${m.library ? '  [基础库]' : ''}`),
    '',
    '— 安装说明 —',
    '',
    '1. 装好上面指定的 Minecraft 版本与载入器',
    '2. 把上面清单里的 mod 依次放进 mods 文件夹',
    '   （本整合包可能未附带 jar，请到各 mod 的发布页下载对应版本）',
    '3. 启动游戏',
    '',
    '本清单由 Pebble Lunchar 生成。'
  ];
  return lines.filter((l) => l !== '').join('\r\n') + '\r\n';
}

module.exports = {
  candidates, check, buildManifest, exportPack,
  isLibrary, isBuiltinDep, versionSatisfies,
  LIBRARY_HINTS, BUILTIN_DEPS
};
