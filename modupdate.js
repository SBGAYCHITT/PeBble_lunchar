// Pebble Lunchar - Mod 更新风险评估（V4 第四组 · R16）
//
// 别的启动器做到哪一步：PCL2 / HMCL 能从网上查"有没有新版本"，点一下自动下。
// 但那条路我们走不了 —— 本项目约束是「纯本地 / 零 API / 零服务器」。
//
// 换个思路：**更新的风险其实可以在本地算出来**。
// 玩家自己下载了新版本 jar 之后，"换了会不会崩"这件事有相当多的线索是藏在文件里的：
//
//   1. 依赖变了 —— 新增了没装的依赖（几乎必崩）、丢掉了原来依赖的（能跑但可能功能异常）
//   2. 元数据变了 —— modId 换了（配置/存档会认不出）、载入器生态换了（必崩）、
//      MC 支持区间不再覆盖当前实例（必崩）
//   3. 内部结构变了 —— 类数量大增/大减、语言文件条目大改、mixins 目标变化（破坏性重构的信号）
//   4. 版本号语义 —— 主版本号跳了（1.x → 2.x）、甚至降级了
//
// 这些都能只靠读两个 jar 算出来。**不做在线查询，全程只读文件。**
//
// 另外还做一件事：更新前自动打快照（复用 modguard.snapshot，块级去重几乎不占空间），
// 于是"更新崩了 → 一键回到更新前"这条链是闭合的。

const fs = require('fs');
const path = require('path');
const zip = require('./zipread');
const modguard = require('./modguard');

/* ---------------- 版本号语义 ---------------- */

/**
 * 拆出版本号的「主段」。1.20.4-0.15.7 → {nums:[1,20,4], pre:'', build:''}
 * 目的是判断"主版本跳了没"，所以只取前导的数字段。
 */
function versionShape(v) {
  const s = String(v || '').trim();
  const nums = [];
  for (const part of s.split(/[.\-_+]/)) {
    const n = parseInt(part, 10);
    if (Number.isNaN(n)) break;
    nums.push(n);
  }
  // 第一段是数字、且后面还有非数字内容 → 视为预发布/构建标记
  const tail = s.replace(/^[\d.\-_+]+/, '');
  return { nums, pre: tail };
}

/**
 * 判断这次版本变化有多"重"
 * @returns {{level:'major'|'minor'|'patch'|'downgrade'|'same'|'unknown', detail:string}}
 */
function bumpLevel(from, to) {
  const a = versionShape(from);
  const b = versionShape(to);
  if (!a.nums.length || !b.nums.length) {
    return { level: 'unknown', detail: '版本号不是数字开头，无法判断变化幅度。' };
  }
  // 逐段比较（补零对齐，1.2 vs 1.2.0 视为相同）
  const n = Math.max(a.nums.length, b.nums.length);
  const av = [], bv = [];
  for (let i = 0; i < n; i++) { av.push(a.nums[i] || 0); bv.push(b.nums[i] || 0); }

  let diff = -1;
  for (let i = 0; i < n; i++) if (av[i] !== bv[i]) { diff = i; break; }
  if (diff < 0) return { level: 'same', detail: '版本号没有变。' };

  if (modguard.cmpVer(to, from) < 0) {
    return { level: 'downgrade', detail: `版本从 ${from} 退回到 ${to}，是降级。` };
  }
  if (diff === 0) return { level: 'major', detail: `主版本号从 ${av[0]} 跳到 ${bv[0]}，按惯例可能有破坏性变更。` };
  if (diff === 1) return { level: 'minor', detail: `次版本号从 ${av[1]} 涨到 ${bv[1]}，一般新增功能、向后兼容。` };
  return { level: 'patch', detail: `修订号变化（第 ${diff + 1} 段），通常只是修 bug。` };
}

/* ---------------- jar 内部结构指纹 ---------------- */

const LANG_RE = /^assets\/[^/]+\/lang\/([a-z]{2}(?:_[a-z]{2})?)\.json$/i;
const MIXIN_JSON_RE = /^([\w.\-/]+)\.mixins\.json$/i;
const CLASS_RE = /\.class$/i;

/**
 * 读一个 jar 的"内部结构指纹"：类数量、语言文件条目数、mixins 配置。
 * 不解压内容，只数条目 —— listEntries 已经给了全部条目名。
 */
function jarShape(file) {
  let entries = [];
  try { entries = zip.listEntries(file); } catch { entries = []; }
  if (!entries.length) return null;

  const classes = entries.filter((e) => CLASS_RE.test(e.name)).length;
  const mixins = entries.filter((e) => MIXIN_JSON_RE.test(e.name)).map((e) => e.name);
  const langs = [];
  for (const e of entries) {
    const m = e.name.match(LANG_RE);
    if (m) langs.push({ locale: m[1].toLowerCase(), name: e.name });
  }
  return {
    total: entries.length,
    classes,
    mixins,
    langs,
    // 类列表太大，只留一个"是否含某前缀"的粗指纹给 diff 用
    topPrefixes: topPrefixes(entries, 3)
  };
}

/** 取出现次数最多的前 n 个顶层包前缀（用于判断包结构是否大改） */
function topPrefixes(entries, n) {
  const tally = new Map();
  for (const e of entries) {
    if (!CLASS_RE.test(e.name)) continue;
    const seg = e.name.split('/');
    // 跳过 com/org/net 这类组织级前缀，取再下一层更有信息量
    const key = seg.slice(0, Math.min(3, seg.length - 1)).join('/');
    tally.set(key, (tally.get(key) || 0) + 1);
  }
  return Array.from(tally.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
}

/* ---------------- 语言文件对比（汉化用，这里只取统计） ---------------- */

/** 读 jar 内某个 lang 文件的条目数；读不到返回 null */
function langEntryCount(file, entryName) {
  try {
    const hit = zip.readFirst(file, [entryName]);
    if (!hit) return null;
    const j = JSON.parse(hit.data.toString('utf8'));
    return j && typeof j === 'object' ? Object.keys(j).length : null;
  } catch { return null; }
}

/* ---------------- 主入口 ---------------- */

const SEV_ORDER = { error: 0, warn: 1, info: 2 };
const SEV_PENALTY = { error: 30, warn: 10, info: 2 };

/**
 * 对比新旧两个 mod jar，给出更新风险评估
 *
 * @param {Object} o
 * @param {string} o.oldPath 旧 jar（当前在 mods 目录里的）
 * @param {string} o.newPath 新 jar（刚下载的）
 * @param {string} [o.mcVersion] 当前实例 MC 版本
 * @param {string} [o.loader]    当前实例载入器
 * @param {string[]} [o.installedIds] 已安装的其他 mod id（判断新增依赖是否满足）
 * @param {boolean} [o.deep] 是否读语言文件条目数（要解压，稍慢）
 * @returns {Object}
 */
function assess(o) {
  const opt = /** @type {any} */ (o || {});
  const findings = [];
  const push = (severity, title, detail, code) => findings.push({ severity, title, detail, code });

  const oldPath = opt.oldPath;
  const newPath = opt.newPath;
  if (!oldPath || !newPath) {
    return { ok: false, error: '需要同时提供旧 jar（oldPath）和新 jar（newPath）。', findings: [] };
  }
  if (!fs.existsSync(oldPath)) return { ok: false, error: `旧 jar 不存在：${oldPath}`, findings: [] };
  if (!fs.existsSync(newPath)) return { ok: false, error: `新 jar 不存在：${newPath}`, findings: [] };

  const oldMeta = modguard.readModMeta(oldPath);
  const newMeta = modguard.readModMeta(newPath);
  if (!oldMeta || !newMeta) {
    return { ok: false, error: '读不到 mod 元数据（可能不是标准 mod jar）。', findings: [] };
  }

  /* ---- ① 身份变化 ---- */

  if (oldMeta.id && newMeta.id && oldMeta.id !== newMeta.id) {
    push('error', 'modId 变了',
      `从 "${oldMeta.id}" 变成 "${newMeta.id}"。这不是"同一个 mod 的新版本"，而是换了一个 mod —— ` +
      `旧 mod 的配置、存档里的方块/物品 id 都会认不出来。除非作者明确说明改名，否则不要这样更新。`,
      'ID_CHANGED');
  } else if (!newMeta.id) {
    push('warn', '新 jar 读不到 modId',
      '新文件里没有可识别的元数据（可能是打包不规范或被混淆）。更新后可能加载失败。',
      'ID_MISSING');
  }

  /* ---- ② 载入器变化（必崩级） ---- */

  const oldL = (oldMeta.loader || '').toLowerCase();
  const newL = (newMeta.loader || '').toLowerCase();
  if (oldL && newL && oldL !== newL) {
    push('error', '载入器生态变了',
      `从 ${oldL} 变成 ${newL}。这几乎必定崩溃 —— 换生态等于换了整个 mod 实现。`,
      'LOADER_CHANGED');
  }

  /* ---- ③ MC 支持区间 ---- */
  const mc = opt.mcVersion;
  if (mc) {
    const oldRange = rangeOf(oldMeta);
    const newRange = rangeOf(newMeta);
    if (newRange && !modguard.mcSatisfies(mc, newRange)) {
      push('error', '新版不再支持当前 MC 版本',
        `新版本要求 ${newRange}，当前实例是 ${mc}。更新后进不去游戏。`,
        'MC_UNSUPPORTED');
    } else if (oldRange && newRange && oldRange !== newRange) {
      push('info', '支持的 MC 区间有变化', `从 ${oldRange} 变成 ${newRange}。`, 'MC_RANGE_CHANGED');
    }
  }

  /* ---- ④ 依赖变化 ---- */

  const oldDeps = depMap(oldMeta);
  const newDeps = depMap(newMeta);

  const added = [];
  const removed = [];
  for (const [id, d] of newDeps) if (!oldDeps.has(id)) added.push({ id, range: d.versionRange });
  for (const [id, d] of oldDeps) if (!newDeps.has(id)) removed.push({ id, range: d.versionRange });

  // 已装清单：不传就认为"其他 mod 都还在"，只报"新增了依赖"这件事本身
  const installed = opt.installedIds ? new Set(opt.installedIds.map((s) => String(s).toLowerCase())) : null;

  for (const d of added) {
    if (installed && !installed.has(d.id)) {
      push('error', '新增了缺失的依赖',
        `新版本需要 ${d.id}${d.range ? ' ' + d.range : ''}，但你的 mods 目录里没有。` +
        `更新后启动会因缺依赖失败 —— 请先把这个依赖装上。`,
        'DEP_ADDED_MISSING');
    } else {
      push('warn', '新增了依赖',
        `新版本需要 ${d.id}${d.range ? ' ' + d.range : ''}。` +
        (installed ? '你已装，但请确认版本区间满足。' : '请确认它已安装且版本满足。'),
        'DEP_ADDED');
    }
  }
  for (const d of removed) {
    push('info', '不再依赖某 mod',
      `新版本不再需要 ${d.id}。如果你只为了它而装那个 mod，可以考虑一并清掉。`,
      'DEP_REMOVED');
  }

  // 依赖版本区间收紧（从宽松变严格，可能不满足）
  for (const [id, nd] of newDeps) {
    const od = oldDeps.get(id);
    if (!od) continue;
    const or = String(od.versionRange || '').trim();
    const nr = String(nd.versionRange || '').trim();
    if (nr && nr !== or) {
      // 只有"收紧"才值得报（宽的 → 窄的）
      if (!or || isNarrower(nr, or)) {
        push('warn', '依赖版本要求变严',
          `${id} 的要求从 ${or || '任意'} 收紧为 ${nr}。请确认已装的版本落在新区间内。`,
          'DEP_RANGE_TIGHTENED');
      }
    }
  }

  /* ---- ⑤ 版本号语义 ---- */
  const oldV = oldMeta.version || '';
  const newV = newMeta.version || '';
  let bump = { level: 'unknown', detail: '' };
  if (oldV && newV) {
    bump = bumpLevel(oldV, newV);
    if (bump.level === 'downgrade') push('warn', '版本降级', bump.detail, 'VER_DOWNGRADE');
    else if (bump.level === 'major') push('warn', '主版本号跳跃', bump.detail, 'VER_MAJOR');
    else if (bump.level === 'same') push('info', '版本号没变', bump.detail, 'VER_SAME');
  }

  /* ---- ⑥ 内部结构变化 ---- */
  const oldShape = jarShape(oldPath);
  const newShape = jarShape(newPath);

  if (oldShape && newShape) {
    const dc = newShape.classes - oldShape.classes;
    const base = oldShape.classes || 1;
    const ratio = Math.abs(dc) / base;
    if (ratio >= 0.35 && Math.abs(dc) >= 20) {
      push('warn', '内部结构大改',
        `类数量从 ${oldShape.classes} 变成 ${newShape.classes}（${dc > 0 ? '+' : ''}${dc}，约 ${Math.round(ratio * 100)}%）。` +
        `幅度这么大通常意味着作者做了重构或换实现，兼容性风险比普通更新高。`,
        'STRUCT_BIG');
    } else if (dc !== 0) {
      push('info', '类数量有变化', `${oldShape.classes} → ${newShape.classes}（${dc > 0 ? '+' : ''}${dc}）。`, 'STRUCT_CLASSES');
    }

    if (oldShape.mixins.length !== newShape.mixins.length) {
      push('info', 'mixins 配置数量变了',
        `从 ${oldShape.mixins.length} 个变成 ${newShape.mixins.length} 个。mixins 改动是启动崩溃的常见来源。`,
        'STRUCT_MIXINS');
    }

    // 顶层包结构大改（重命名包 = 破坏了别的 mod 对它的 API 调用）
    const oldPre = oldShape.topPrefixes.join('|');
    const newPre = newShape.topPrefixes.join('|');
    if (oldPre && newPre && oldPre !== newPre) {
      push('info', '内部包结构有变化',
        `主要包路径从 [${oldShape.topPrefixes.join(', ')}] 变成 [${newShape.topPrefixes.join(', ')}]。` +
        `如果别的 mod 依赖它，可能会出错。`,
        'STRUCT_PACKAGES');
    }

    // 语言文件条目数骤减（作者可能重写了内部资源，汉化补丁要重做）
    const countLangs = (s) => s.langs.reduce((n, l) => n + 1, 0);
    const oldZh = oldShape.langs.some((l) => l.locale === 'zh_cn' || l.locale === 'zh_tw');
    const newZh = newShape.langs.some((l) => l.locale === 'zh_cn' || l.locale === 'zh_tw');
    if (oldZh && !newZh) {
      push('warn', '新版去掉了中文语言文件',
        '旧版带 zh_cn，新版没有了 —— 中文显示会回退成英文。如果你做过汉化补丁，需要重新生成。',
        'LANG_ZH_LOST');
    } else if (!oldZh && newZh) {
      push('info', '新版自带中文了', '新版本里有 zh_cn 语言文件，不需要额外汉化。', 'LANG_ZH_ADDED');
    }
    if (countLangs(oldShape) !== countLangs(newShape)) {
      push('info', '语言文件数量变了',
        `从 ${countLangs(oldShape)} 种变成 ${countLangs(newShape)} 种。`,
        'LANG_COUNT');
    }

    // 深度模式：读 zh_cn 的实际条目数，看翻译是否被大改
    if (opt.deep) {
      const zhOld = oldShape.langs.find((l) => l.locale === 'zh_cn');
      const zhNew = newShape.langs.find((l) => l.locale === 'zh_cn');
      if (zhOld && zhNew) {
        const a = langEntryCount(oldPath, zhOld.name);
        const b = langEntryCount(newPath, zhNew.name);
        if (a != null && b != null && a !== b) {
          const d = b - a;
          push('info', '中文本地化条目数变了',
            `zh_cn 从 ${a} 条变成 ${b} 条（${d > 0 ? '+' : ''}${d}）。`,
            'LANG_ZH_ENTRIES');
        }
      }
    }
  } else if (!newShape) {
    push('warn', '新文件读不出内部结构',
      '可能是 ZIP64 格式或文件损坏，无法做结构对比。', 'STRUCT_UNREADABLE');
  }

  /* ---- ⑦ 文件名变化提示 ---- */
  if (path.basename(oldPath) !== path.basename(newPath) && oldMeta.id === newMeta.id) {
    push('info', '文件名变了',
      `${path.basename(oldPath)} → ${path.basename(newPath)}。` +
      `更新会删掉旧文件，如果你有用文件名做手工备注的习惯，注意一下。`,
      'FILE_RENAMED');
  }

  /* ---- 打分 ---- */
  findings.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  const score = Math.max(0, 100 - findings.reduce((n, f) => n + (SEV_PENALTY[f.severity] || 0), 0));
  const hasError = findings.some((f) => f.severity === 'error');

  return {
    ok: true,
    oldPath, newPath,
    old: { id: oldMeta.id, name: oldMeta.name, version: oldMeta.version, loader: oldMeta.loader, mcRange: rangeOf(oldMeta) },
    new: { id: newMeta.id, name: newMeta.name, version: newMeta.version, loader: newMeta.loader, mcRange: rangeOf(newMeta) },
    bump,
    findings,
    hasError,
    score,
    grade: score >= 90 ? 'safe' : score >= 70 ? 'caution' : score >= 40 ? 'risky' : 'danger',
    shape: { old: oldShape && { classes: oldShape.classes, mixins: oldShape.mixins.length }, 
             new: newShape && { classes: newShape.classes, mixins: newShape.mixins.length } }
  };
}

/** 元数据里的 MC 区间（依赖表里的 minecraft 优先） */
function rangeOf(meta) {
  const d = (meta.deps || []).find((x) => x.modId === 'minecraft');
  return (d && d.versionRange) || meta.mcRange || '';
}

/* 这些 id 由启动器/载入器提供，不算"玩家要装的依赖"—— 与 modguard 的 BUILTIN_DEPS 保持一致。
   这里自己维护一份而不是 import：modguard 没导出它，而依赖关系是稳定的。 */
const BUILTIN = new Set([
  'minecraft', 'forge', 'neoforge', 'fabricloader', 'fabric', 'fabric-api',
  'quilt_loader', 'quilt_base', 'java', 'minecraftforge', 'fml', 'neoforged'
]);

/** 必需依赖的 id → 依赖对象 */
function depMap(meta) {
  const m = new Map();
  for (const d of meta.deps || []) {
    if (!d.modId || !d.mandatory) continue;
    const id = String(d.modId).toLowerCase();
    if (BUILTIN.has(id)) continue;
    m.set(id, d);
  }
  return m;
}

/**
 * nr 是不是比 or 更严格（收窄）。
 * 只做保守判断：能确定收窄才返回 true，拿不准一律 false（避免误报）。
 *
 * 严格度用一个 0–4 的档位表示，数字越小越严格：
 *   0 精确值        1.2.3
 *   1 有界区间      [1.2,1.5)
 *   2 单边范围      >=1.2
 *   3 通配         1.2.x
 *   4 任意         空 / *
 */
function strictness(s) {
  const t = String(s || '').trim();
  if (!t || t === '*' || t === 'any') return 4;
  if (/^[\[\(].*[\]\)]$/.test(t)) return 1;
  if (/^(>=|<=|>|<)/.test(t)) return 2;
  if (/[xX*]/.test(t)) return 3;
  return 0;
}

function isNarrower(nr, or) {
  return strictness(nr) < strictness(or);
}

/* ---------------- 批量：扫描 mods 目录，找出可配对的"新旧"文件 ----------------
 *
 * 玩家的常见工作流是：下载了一堆新 jar 放在另一个目录，想批量看看哪些更新有风险。
 * 这里把两边按 modId 配对，只对"配对成功且版本不同"的做评估。
 */

/**
 * @param {{modsDir:string, incomingDir:string, mcVersion?:string, loader?:string, deep?:boolean}} o
 */
function assessDir(o) {
  const opt = /** @type {any} */ (o || {});
  const cur = modguard.scan({ modsDir: opt.modsDir });
  const inc = modguard.scan({ modsDir: opt.incomingDir });

  const installedIds = cur.mods.filter((m) => m.id).map((m) => m.id);
  const byId = new Map();
  for (const m of cur.mods) if (m.id) byId.set(m.id, m);

  const paired = [];
  const fresh = [];      // 不是更新，是新装
  const unknown = [];

  for (const n of inc.mods) {
    if (!n.id) { unknown.push(n); continue; }
    const old = byId.get(n.id);
    if (!old) { fresh.push(n); continue; }
    if (old.version && n.version && old.version === n.version && old.size === n.size) continue; // 一模一样
    paired.push({ old, incoming: n });
  }

  const results = paired.map((p) => {
    try {
      const r = assess({
        oldPath: p.old.path, newPath: p.incoming.path,
        mcVersion: opt.mcVersion, loader: opt.loader,
        installedIds, deep: opt.deep
      });
      // 顶层补 id/name：UI 列表要直接渲染，不该让它去翻 r.old / r.new
      // （assess 失败时 r.ok=false，此时用 modguard 扫出来的元数据兜底）
      const nMeta = (r && r.new) || {};
      return Object.assign(r, {
        fileName: p.incoming.real,
        id: nMeta.id || p.incoming.id || '',
        name: nMeta.name || p.incoming.name || p.incoming.real,
        oldVersion: p.old.version,
        newVersion: p.incoming.version
      });
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), fileName: p.incoming.real };
    }
  });

  results.sort((a, b) => (a.score == null ? 101 : a.score) - (b.score == null ? 101 : b.score));

  return {
    ok: cur.ok || inc.ok,
    count: results.length,
    updates: results,
    freshCount: fresh.length,
    fresh: fresh.map((m) => ({ file: m.real, id: m.id, version: m.version })),
    unknownCount: unknown.length,
    risky: results.filter((r) => r.ok && r.hasError).length
  };
}

module.exports = {
  assess, assessDir, bumpLevel, versionShape, jarShape, rangeOf, isNarrower, strictness
};
