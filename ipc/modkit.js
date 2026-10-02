// Mod 与内容管理 IPC 聚合（V4 第四组）：
//   - Mod 更新风险评估  modupdate （新旧 jar 对比 → 分级风险 + 破坏性变更）
//   - Mod 汉化补全      modl10n   （扫 jar 内语言文件 → 离线词典补齐 → 独立资源包）
//   - 资源包/光影预览    packinfo  （pack.png 图标 + 描述 + 依赖 + 截图）
//   - 整合包创建向导     packbuilder（挑选 → 检查冲突 → 导出 zip）
//
// 设计要点：
//   1) 全程本地、**不联网**（第四组的原则：Mod 元数据都在 jar 里，够用了）。
//   2) 每个 handler 都返回 {ok, ...}，UI 不用 try/catch，只看 ok。
//   3) 会给"改动文件"的操作（导出整合包 / 生成汉化资源包）一律要求显式 outPath，
//      且**默认不覆盖**已有文件 —— 避免误删用户的东西。
const fs = require('fs');
const path = require('path');
const os = require('os');

const modguard = require('../modguard');
const modupdate = require('../modupdate');
const modl10n = require('../modl10n');
const packinfo = require('../packinfo');
const packbuilder = require('../packbuilder');
const zipwrite = require('../zipwrite');
const { safe } = require('./util');

/** 列出一个目录下的 mod jar（含 .disabled） */
function listJars(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((n) => /\.jar(\.disabled)?$/i.test(n))
      .map((n) => {
        const p = path.join(dir, n);
        let size = 0;
        try { size = fs.statSync(p).size; } catch { /* 读不到就算了 */ }
        return { file: n, path: p, size };
      });
  } catch { return []; }
}

module.exports = function register(ctx) {
  const { ipcMain } = ctx;

  /* ================= ① Mod 更新风险评估 ================= */

  /**
   * 评估"把 incomingDir 里的 jar 装到 modsDir"的风险。
   * 只读 —— 不写任何文件（真的安装由现有的 mod 管理通道做）。
   * @param {{modsDir:string, incomingDir:string, useDict?:boolean}} o
   */
  ipcMain.handle('modkit-update-assess', safe((_e, o) => {
    const opt = o || {};
    if (!opt.modsDir || !opt.incomingDir) {
      return { ok: false, error: '需要同时指定当前 mods 目录和待安装目录。' };
    }
    const r = modupdate.assessDir({ modsDir: opt.modsDir, incomingDir: opt.incomingDir });
    return Object.assign({ ok: true }, r);
  }));

  /** 对比两个具体的 jar（用户手动挑新旧各一个） */
  ipcMain.handle('modkit-update-compare', safe((_e, o) => {
    const opt = o || {};
    if (!opt.oldPath || !opt.newPath) return { ok: false, error: '需要指定新旧两个 jar。' };
    if (!fs.existsSync(opt.oldPath)) return { ok: false, error: '旧 jar 不存在：' + opt.oldPath };
    if (!fs.existsSync(opt.newPath)) return { ok: false, error: '新 jar 不存在：' + opt.newPath };
    const r = modupdate.assess({ oldPath: opt.oldPath, newPath: opt.newPath });
    return Object.assign({ ok: true }, r);
  }));

  /* ================= ② Mod 汉化补全 ================= */

  /** 分析单个 jar 的汉化缺口（只读） */
  ipcMain.handle('modkit-l10n-analyze', safe((_e, o) => {
    const opt = o || {};
    const jarPath = opt.jarPath;
    if (!jarPath) return { ok: false, error: '没有指定 jar。' };
    if (!fs.existsSync(jarPath)) return { ok: false, error: '文件不存在：' + jarPath };

    const r = modl10n.analyzeJar({
      jarPath,
      target: opt.target || 'zh_cn',
      useDict: opt.useDict !== false,
      extraDict: opt.extraDict
    });
    return Object.assign({ ok: true }, r);
  }));

  /**
   * 分析整个 mods 目录（一次扫所有 jar，给出总覆盖率）。
   * 大目录会慢 —— 所以做成"逐个 jar 回报进度"的形态，
   * 但 handler 本身仍是同步返回汇总（UI 想看进度就分批调 analyze）。
   */
  ipcMain.handle('modkit-l10n-analyze-dir', safe((_e, o) => {
    const opt = o || {};
    if (!opt.modsDir) return { ok: false, error: '没有指定 mods 目录。' };

    const jars = listJars(opt.modsDir).filter((j) => j.file.toLowerCase().endsWith('.jar'));
    const results = [];
    let agg = { total: 0, already: 0, missing: 0, autoFilled: 0, stillMissing: 0, skipped: 0 };

    for (const j of jars) {
      try {
        const r = modl10n.analyzeJar({
          jarPath: j.path,
          target: opt.target || 'zh_cn',
          useDict: opt.useDict !== false
        });
        if (!r || !r.ok) continue;
        const s = r.stats || {};
        // 完全没语言文件的 jar 不计入（不是"缺汉化"，是本来就没做多语言）
        if (!s.total) continue;
        results.push({
          file: j.file, ns: (r.entries && r.entries[0] && r.entries[0].ns) || '',
          stats: s, available: r.available || []
        });
        agg.total += s.total || 0;
        agg.already += s.already || 0;
        agg.missing += s.missing || 0;
        agg.autoFilled += s.autoFilled || 0;
        agg.stillMissing += s.stillMissing || 0;
        agg.skipped += s.skipped || 0;
      } catch { /* 单个 jar 坏了不中断整目录扫描 */ }
    }

    agg.coverage = agg.missing > 0
      ? Math.round(((agg.already + agg.autoFilled) / agg.missing) * 100)
      : 100;

    // 缺口大的排前面 —— 用户先看最该补的
    results.sort((a, b) => (b.stats.stillMissing || 0) - (a.stats.stillMissing || 0));
    return { ok: true, count: results.length, jars: results, agg };
  }));

  /**
   * 生成汉化资源包（zip）—— **不改原 jar**，产出一个可直接放进 resourcepacks 的包。
   * @param {{jarPath?:string, modsDir?:string, outZip:string, includeTranslated?:boolean,
   *          name?:string, packFormat?:number}} o
   */
  ipcMain.handle('modkit-l10n-buildpack', safe((_e, o) => {
    const opt = o || {};
    const outZip = opt.outZip;
    if (!outZip) return { ok: false, error: '没有指定输出路径。' };
    if (!opt.jarPath && !opt.modsDir) return { ok: false, error: '需要指定 jar 或 mods 目录。' };
    if (fs.existsSync(outZip) && !opt.overwrite) {
      return { ok: false, error: '输出文件已存在，未覆盖。', exists: true };
    }

    // 1) 收集要写的语言文件
    const allLangs = {};   // 'assets/<ns>/lang/zh_cn.json' → 对象
    let analyzed = 0;
    const details = [];

    const oneJar = (p) => {
      const r = modl10n.analyzeJar({ jarPath: p, target: opt.target || 'zh_cn', useDict: opt.useDict !== false });
      if (!r || !r.ok) return;
      const built = modl10n.buildPackFiles(r, { includeTranslated: opt.includeTranslated });
      if (!built || !built.count) return;
      analyzed++;
      for (const k of Object.keys(built.langs)) allLangs[k] = built.langs[k];
      details.push({ file: path.basename(p), ns: built.ns, count: built.count, stats: r.stats });
    };

    if (opt.jarPath) {
      if (!fs.existsSync(opt.jarPath)) return { ok: false, error: '文件不存在：' + opt.jarPath };
      oneJar(opt.jarPath);
    } else {
      for (const j of listJars(opt.modsDir)) {
        if (!j.file.toLowerCase().endsWith('.jar')) continue;
        try { oneJar(j.path); } catch { /* 跳过坏 jar */ }
      }
    }

    if (!Object.keys(allLangs).length) {
      return { ok: false, error: '没有找到可补全的条目（可能这个 mod 本来就没有语言文件，或已全部汉化）。' };
    }

    // 2) 组一个合法的资源包：pack.mcmeta + 各语言文件
    const pf = Number(opt.packFormat) || 15;
    const entries = [{
      name: 'pack.mcmeta',
      data: JSON.stringify({
        pack: {
          pack_format: pf,
          description: opt.name || 'Pebble Lunchar 汉化补全包'
        }
      }, null, 2)
    }, {
      // 让玩家在资源包列表里能一眼看到来源
      name: 'README.txt',
      data: buildPackReadme(details, opt)
    }];

    for (const k of Object.keys(allLangs)) {
      entries.push({ name: k, data: JSON.stringify(allLangs[k], null, 2) });
    }

    zipwrite.writeZipEntries(outZip, entries, { level: 9 });

    return {
      ok: true,
      outZip,
      size: fs.statSync(outZip).size,
      jars: analyzed,
      files: Object.keys(allLangs).length,
      details
    };
  }));

  /** 单独查一次词典（UI 上做"输入英文看能翻成什么"的即时预览） */
  ipcMain.handle('modkit-l10n-translate', safe((_e, text) => {
    const r = modl10n.translate(String(text || ''));
    return Object.assign({ ok: true, input: String(text || '') }, r);
  }));

  /** 列出 jar 里有哪些语言文件（给 UI 做语言选择） */
  ipcMain.handle('modkit-l10n-langs', safe((_e, jarPath) => {
    if (!jarPath || !fs.existsSync(jarPath)) return { ok: false, error: '文件不存在。' };
    const langs = modl10n.listLangs(jarPath);
    return { ok: true, langs: langs.map((l) => ({ ns: l.ns, locale: l.locale, name: l.name })) };
  }));

  /* ================= ③ 资源包 / 光影预览 ================= */

  /**
   * 预览一批资源包 / 光影（缩略图 + 描述 + 格式 + 依赖）。
   * @param {{paths?:string[], dirs?:string[], kind?:'rps'|'shaders'}} o
   */
  ipcMain.handle('modkit-pack-preview', safe((_e, o) => {
    const opt = o || {};
    const kind = opt.kind === 'shaders' ? 'shaders' : 'rps';

    // 允许传一个父目录，自动列出里面的包
    let list = Array.isArray(opt.paths) ? opt.paths.slice() : [];
    for (const d of (opt.dirs || [])) {
      try {
        for (const n of fs.readdirSync(d)) {
          if (/\.zip$/i.test(n)) list.push(path.join(d, n));
        }
      } catch { /* 目录读不到就跳过 */ }
    }
    if (!list.length) return { ok: true, items: [], count: 0 };

    const items = packinfo.describePacks(list, kind);
    return { ok: true, items, count: items.length };
  }));

  /** 单个包的详情（含数据包格式范围、匹配的 MC 版本） */
  ipcMain.handle('modkit-pack-detail', safe((_e, o) => {
    const opt = o || {};
    if (!opt.path) return { ok: false, error: '没有指定包路径。' };
    const kind = opt.kind === 'shaders' ? 'shaders' : 'rps';
    const d = packinfo.describePack(opt.path, kind);
    return Object.assign({ ok: true }, d);
  }));

  /** 本机资源包 / 光影目录里都有什么（给页面做默认列表） */
  ipcMain.handle('modkit-pack-scan', safe((_e, gameDir) => {
    if (!gameDir) return { ok: false, error: '没有指定游戏目录。' };
    const out = { resourcepacks: [], shaderpacks: [] };
    for (const key of Object.keys(out)) {
      const d = path.join(gameDir, key);
      try {
        for (const n of fs.readdirSync(d)) {
          if (/\.zip$/i.test(n)) out[key].push(path.join(d, n));
        }
        // 也有解压成文件夹的形态
        for (const n of fs.readdirSync(d)) {
          const p = path.join(d, n);
          try {
            if (fs.statSync(p).isDirectory()) out[key].push(p);
          } catch { /* 忽略 */ }
        }
      } catch { /* 目录不存在 → 空列表 */ }
    }
    return {
      ok: true,
      resourcepacks: packinfo.describePacks(out.resourcepacks, 'rps'),
      shaderpacks: packinfo.describePacks(out.shaderpacks, 'shaders')
    };
  }));

  /* ================= ④ 整合包创建向导 ================= */

  /** 候选清单（可勾选的 mod 列表） */
  ipcMain.handle('modkit-pack-candidates', safe((_e, o) => {
    const opt = o || {};
    if (!opt.modsDir) return { ok: false, error: '没有指定 mods 目录。' };
    const r = packbuilder.candidates({
      modsDir: opt.modsDir, mcVersion: opt.mcVersion, loader: opt.loader
    });
    return Object.assign({ ok: true }, r);
  }));

  /** 依赖与冲突检查 */
  ipcMain.handle('modkit-pack-check', safe((_e, o) => {
    const opt = o || {};
    if (!opt.modsDir) return { ok: false, error: '没有指定 mods 目录。' };
    const r = packbuilder.check({
      modsDir: opt.modsDir, selected: opt.selected, mcVersion: opt.mcVersion, loader: opt.loader
    });
    return Object.assign({ ok: true }, r);
  }));

  /** 预览 manifest（不落盘，让用户先看一眼再导出） */
  ipcMain.handle('modkit-pack-manifest', safe((_e, o) => {
    const opt = o || {};
    if (!opt.modsDir) return { ok: false, error: '没有指定 mods 目录。' };
    const m = packbuilder.buildManifest(opt);
    return { ok: true, manifest: m };
  }));

  /**
   * 导出整合包 zip。
   * @param {{modsDir:string, selected:string[], outZip:string, mode?:'manifest'|'full',
   *          force?:boolean, name?:string, author?:string, mcVersion?:string,
   *          loader?:string, loaderVersion?:string, note?:string, overwrite?:boolean}} o
   */
  ipcMain.handle('modkit-pack-export', safe((_e, o) => {
    const opt = o || {};
    if (!opt.outZip) return { ok: false, error: '没有指定输出路径。' };
    if (fs.existsSync(opt.outZip) && !opt.overwrite) {
      return { ok: false, error: '输出文件已存在，未覆盖。', exists: true };
    }
    return packbuilder.exportPack(opt);
  }));

  /** 把整合包 zip 解到本机资源包/mods 目录（"一键导入"的落地端） */
  ipcMain.handle('modkit-pack-inspect', safe((_e, zipPath) => {
    if (!zipPath || !fs.existsSync(zipPath)) return { ok: false, error: '文件不存在。' };
    const zipread = require('../zipread');
    let names = [];
    try { names = zipread.listEntries(zipPath).map((e) => e.name); }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }

    const manifestEntry = names.find((n) => /(^|\/)manifest\.json$/.test(n));
    let manifest = null;
    if (manifestEntry) {
      const hit = zipread.readFirst(zipPath, [manifestEntry]);
      if (hit) {
        try { manifest = JSON.parse(hit.data.toString('utf8')); }
        catch { /* 清单坏了也把文件列表给回去 */ }
      }
    }
    return {
      ok: true,
      isPack: !!manifest,
      manifest,
      mods: names.filter((n) => /^mods\/.*\.jar$/i.test(n)).map((n) => path.basename(n)),
      files: names.length
    };
  }));

  /* ================= ⑤ 汇总信息 ================= */

  /** 第四组的"能干什么"说明（UI 上做功能卡片） */
  ipcMain.handle('modkit-features', safe(() => ({
    ok: true,
    groups: [
      { id: 'update', name: 'Mod 更新风险评估', desc: '装新版本前先看会炸什么：依赖变动、mixin 结构、MC 支持区间。' },
      { id: 'l10n', name: 'Mod 汉化补全', desc: '扫出没中文的条目，用离线词典补齐，输出独立资源包（不改原 jar）。' },
      { id: 'preview', name: '资源包与光影预览', desc: '图标缩略图、描述、支持的 MC 版本与数据包格式，一眼看完。' },
      { id: 'pack', name: '整合包创建向导', desc: '勾 mod → 查依赖与冲突 → 导出可分享的 zip（默认只导清单，规避版权）。' }
    ]
  })));

  /** 生成一个默认的输出文件名（放在用户桌面/下载目录） */
  ipcMain.handle('modkit-suggest-path', safe((_e, o) => {
    const opt = o || {};
    const base = opt.dir || os.tmpdir();
    const stem = String(opt.stem || 'pebble-pack').replace(/[\\/:*?"<>|]/g, '_');
    const ext = opt.ext === 'zip' ? 'zip' : (opt.ext || 'zip');
    let p = path.join(base, `${stem}.${ext}`);
    // 重名就加序号，避免一上来就撞已存在文件
    let i = 2;
    while (fs.existsSync(p) && i < 1000) {
      p = path.join(base, `${stem} (${i}).${ext}`);
      i++;
    }
    return { ok: true, path: p };
  }));
};

/** 汉化资源包里的说明文件 */
function buildPackReadme(details, opt) {
  const lines = [
    String((opt && opt.name) || 'Pebble Lunchar 汉化补全包'),
    '',
    '这个资源包由 Pebble Lunchar 从本机 mod 的语言文件中提取缺口、用内置离线词典补齐后生成。',
    '**它不会修改任何 mod 本体** —— 想还原直接删掉这个包即可。',
    '',
    '— 收录情况 —',
    '',
    ...details.map((d) => `${d.ns || d.file}`.padEnd(28) +
      `补 ${d.count} 条` + (d.stats && d.stats.stillMissing ? `，仍有 ${d.stats.stillMissing} 条待翻译` : '')),
    '',
    '— 用法 —',
    '',
    '1. 把本 zip 放进 .minecraft/resourcepacks/',
    '2. 游戏内：选项 → 资源包 → 启用它（放在原资源包上面）',
    '3. 因为语言文件按命名空间合并，不会和其他资源包冲突',
    '',
    '注意：词典只覆盖常见 Minecraft 术语与通用词，生造的专有名词仍会保留英文。',
    '未命中的条目请反馈给对应 mod 的作者。'
  ];
  return lines.join('\r\n') + '\r\n';
}
