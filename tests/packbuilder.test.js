// packbuilder.js 单元测试（V4 第四组 · R19 整合包创建向导）
//
// 这里跑的 jar 都是**真 zip + 真元数据**（fabric.mod.json / mods.toml），
// 因为 candidates/check 的价值全在"能不能从 jar 里正确读出 id 和依赖"上 ——
// 用假对象会把这条最容易错的路径绕过去。

const fs = require('fs');
const os = require('os');
const path = require('path');
const zipread = require('../zipread');
const pb = require('../packbuilder');
const { makeZip } = require('./fixtures');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name); console.log('      ' + (e && e.message)); }
}
async function ta(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name); console.log('      ' + (e && e.message)); }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || '断言失败'}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}
function ok(v, msg) { if (!v) throw new Error(msg || '期望为真'); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-pack-'));
const MODS = path.join(TMP, 'mods');
fs.mkdirSync(MODS, { recursive: true });

/** 造一个 fabric 风格的 mod jar */
function fabricMod(fileName, { id, name, version, mc, loader, depends }) {
  const meta = {
    schemaVersion: 1,
    id,
    version: version || '1.0.0',
    name: name || id,
    depends: Object.assign({}, depends || {})
  };
  if (mc !== null) meta.depends.minecraft = mc || '1.20.x';
  if (loader !== null) meta.depends.fabricloader = loader || '>=0.14';
  makeZip(path.join(MODS, fileName), [
    { name: 'fabric.mod.json', data: JSON.stringify(meta) }
  ]);
  return path.join(MODS, fileName);
}

/** 造一个 forge 风格的 mod jar（mods.toml 的依赖表） */
function forgeMod(fileName, { id, name, version, mc, deps }) {
  const depLines = [];
  if (mc !== null) {
    depLines.push(`[[dependencies.${id}]]\n    modId="minecraft"\n    mandatory=true\n    versionRange="${mc || '[1.20,1.21)'}"\n`);
  }
  for (const d of deps || []) {
    depLines.push(`[[dependencies.${id}]]\n    modId="${d.id}"\n    mandatory=${d.optional ? 'false' : 'true'}\n    versionRange="${d.range || '*'}"\n`);
  }
  const toml = `modLoader="javafml"\nloaderVersion="[43,)"\n[[mods]]\nmodId="${id}"\nversion="${version || '1.0.0'}"\ndisplayName="${name || id}"\n` + depLines.join('\n');
  makeZip(path.join(MODS, fileName), [{ name: 'META-INF/mods.toml', data: toml }]);
  return path.join(MODS, fileName);
}

/** 一个读不出元数据的文件（不是 zip） */
function junkFile(fileName) {
  fs.writeFileSync(path.join(MODS, fileName), 'not a zip at all', 'utf8');
  return path.join(MODS, fileName);
}

/* =========================================================
   夹具：一个够真实的 mods 目录
   ========================================================= */

fabricMod('fabric-api-0.92.0.jar', {
  id: 'fabric-api', name: 'Fabric API', version: '0.92.0',
  depends: { fabricloader: '>=0.14' }
});
fabricMod('cloth-config-11.1.106.jar', {
  id: 'cloth-config', name: 'Cloth Config', version: '11.1.106',
  depends: { fabricloader: '>=0.14' }
});
// 主 mod：依赖 fabric-api + cloth-config + 一个本地没有的 libmissing
fabricMod('coolmod-1.2.0.jar', {
  id: 'coolmod', name: 'Cool Mod', version: '1.2.0',
  mc: '1.20.x', depends: { fabricloader: '>=0.14', 'fabric-api': '*', 'cloth-config': '>=11.0', libmissing: '*' }
});
// 只依赖本地有的（用于 suggestAdd 命中）
fabricMod('helpermod-2.0.0.jar', {
  id: 'helpermod', name: 'Helper Mod', version: '2.0.0',
  mc: '1.20.x', depends: { fabricloader: '>=0.14', 'fabric-api': '*' }
});
// 只支持 1.19 —— 用来触发 MC_MISMATCH
fabricMod('oldmod-1.0.0.jar', {
  id: 'oldmod', name: 'Old Mod', version: '1.0.0',
  mc: '1.19.x', depends: { fabricloader: '>=0.14' }
});
// 依赖版本要求 >=2.0，本地只有 1.0 → DEP_VERSION
fabricMod('demander-1.0.0.jar', {
  id: 'demander', name: 'Demander', version: '1.0.0',
  mc: '1.20.x', depends: { fabricloader: '>=0.14', 'helpermod': '>=2.0' }
});
// forge 生态的 —— 用来触发 LOADER_MIX
forgeMod('forgeonly-1.0.0.jar', { id: 'forgeonly', name: 'Forge Only', version: '1.0.0', mc: '[1.20,1.21)' });
// 同名 modId 两个版本 → DUP_ID
fabricMod('coolmod-1.3.0.jar', {
  id: 'coolmod', name: 'Cool Mod', version: '1.3.0',
  mc: '1.20.x', depends: { fabricloader: '>=0.14' }
});
// 读不出元数据
junkFile('broken.jar');

/* =========================================================
   ① candidates
   ========================================================= */

console.log('packbuilder.js');

t('candidates：扫出全部候选，含 broken.jar', () => {
  const r = pb.candidates({ modsDir: MODS });
  eq(r.ok, true);
  // 9 个 jar
  eq(r.stats.total, 9);
});

t('candidates：能读出 id/version/loader', () => {
  const r = pb.candidates({ modsDir: MODS });
  const api = r.items.find((i) => i.id === 'fabric-api');
  ok(api, '该找到 fabric-api');
  eq(api.version, '0.92.0');
  eq(api.loader, 'fabric');
});

t('candidates：过滤掉内置依赖，deps 只剩真正要装的', () => {
  const r = pb.candidates({ modsDir: MODS });
  const cool = r.items.find((i) => i.id === 'coolmod' && i.version === '1.2.0');
  const ids = cool.deps.map((d) => d.id).sort();
  eq(ids.join(','), 'cloth-config,fabric-api,libmissing', 'minecraft/fabricloader 不该出现');
});

t('candidates：识别基础库', () => {
  const r = pb.candidates({ modsDir: MODS });
  ok(r.items.find((i) => i.id === 'fabric-api').library, 'fabric-api 该判成库');
  ok(!r.items.find((i) => i.id === 'coolmod' && i.version === '1.2.0').library, 'coolmod 不是库');
  ok(r.stats.libraries >= 1);
});

t('candidates：基础库排到后面', () => {
  const r = pb.candidates({ modsDir: MODS });
  const firstLib = r.items.findIndex((i) => i.library);
  const lastNonLib = r.items.map((i) => i.library).lastIndexOf(false);
  ok(firstLib > lastNonLib, '库应排在非库之后');
});

t('candidates：MC 版本不匹配被标出', () => {
  const r = pb.candidates({ modsDir: MODS, mcVersion: '1.20.1' });
  const old = r.items.find((i) => i.id === 'oldmod');
  eq(old.mcOk, false);
  eq(old.mcRange, '1.19.x');
  ok(r.stats.mcMismatch >= 1);
});

t('candidates：不传 mcVersion 时 mcOk 为 null（不做判断）', () => {
  const r = pb.candidates({ modsDir: MODS });
  const old = r.items.find((i) => i.id === 'oldmod');
  eq(old.mcOk, null);
});

t('candidates：broken.jar 标记 unknown', () => {
  const r = pb.candidates({ modsDir: MODS });
  const b = r.items.find((i) => i.file === 'broken.jar');
  ok(b, '该有 broken.jar');
  ok(b.unknown, '该标 unknown');
  ok(r.stats.unknown >= 1);
});

t('candidates：目录不存在返回 ok:false 而不是抛', () => {
  const r = pb.candidates({ modsDir: path.join(TMP, 'nope') });
  eq(r.ok, false);
  eq(r.items.length, 0);
});

t('candidates：空参数不炸', () => {
  const r = pb.candidates({});
  eq(r.ok, false);
  eq(r.stats.total, 0);
});

t('candidates：文件体积被累加', () => {
  const r = pb.candidates({ modsDir: MODS });
  ok(r.stats.totalBytes > 0, '总字节数该 > 0');
});

/* =========================================================
   ② isLibrary / isBuiltinDep / versionSatisfies
   ========================================================= */

t('isLibrary：命中白名单', () => {
  ok(pb.isLibrary('cloth-config'));
  ok(pb.isLibrary('fabric-api'));
  ok(pb.isLibrary('geckolib'));
});

t('isLibrary：命中命名模式', () => {
  ok(pb.isLibrary('somelib'));
  ok(pb.isLibrary('my-core'));
  ok(pb.isLibrary('random-api-mod'));
  ok(pb.isLibrary('xx_framework'));
});

t('isLibrary：普通 mod 不算库', () => {
  ok(!pb.isLibrary('coolmod'));
  ok(!pb.isLibrary('create-adventure'));
  ok(!pb.isLibrary(''));
  ok(!pb.isLibrary(null));
});

t('isBuiltinDep：载入器与游戏自带的不算 mod', () => {
  ok(pb.isBuiltinDep('minecraft'));
  ok(pb.isBuiltinDep('FABRICLOADER'), '大小写不敏感');
  ok(pb.isBuiltinDep('neoforge'));
  ok(!pb.isBuiltinDep('fabric-api'), 'fabric-api 是 mod 不是内置');
  ok(!pb.isBuiltinDep('coolmod'));
});

t('versionSatisfies：通配与空区间恒真', () => {
  ok(pb.versionSatisfies('1.0.0', '*'));
  ok(pb.versionSatisfies('1.0.0', ''));
  ok(pb.versionSatisfies('1.0.0', null));
});

t('versionSatisfies：maven 区间语义', () => {
  ok(pb.versionSatisfies('1.5.0', '[1.0,2.0)'));
  ok(!pb.versionSatisfies('2.1.0', '[1.0,2.0)'));
  ok(pb.versionSatisfies('2.0.0', '[2.0,)'));
});

/* =========================================================
   ③ check —— 缺依赖
   ========================================================= */

t('check：本地没有的依赖 → DEP_MISSING(error)', () => {
  const r = pb.check({ modsDir: MODS, selected: ['coolmod-1.2.0.jar'] });
  const iss = r.issues.filter((i) => i.code === 'DEP_MISSING');
  eq(iss.length, 1);
  eq(iss[0].level, 'error');
  ok(iss[0].detail.includes('libmissing'), '该指出是哪个 id：' + iss[0].detail);
});

t('check：本地有但没勾 → DEP_NOT_PICKED(warn) 且进 suggestAdd', () => {
  const r = pb.check({ modsDir: MODS, selected: ['helpermod-2.0.0.jar'] });
  const iss = r.issues.filter((i) => i.code === 'DEP_NOT_PICKED');
  eq(iss.length, 1);
  eq(iss[0].level, 'warn');
  ok(r.suggestAdd.includes('fabric-api'), 'suggestAdd 该含 fabric-api');
});

t('check：DEP_MISSING 不进 suggestAdd（本地根本没有）', () => {
  const r = pb.check({ modsDir: MODS, selected: ['coolmod-1.2.0.jar'] });
  ok(!r.suggestAdd.includes('libmissing'), '本地没有的不该出现在一键补齐里');
});

t('check：把依赖勾上后 DEP_NOT_PICKED 消失', () => {
  const r = pb.check({ modsDir: MODS, selected: ['helpermod-2.0.0.jar', 'fabric-api-0.92.0.jar'] });
  eq(r.issues.filter((i) => i.code === 'DEP_NOT_PICKED').length, 0);
  eq(r.count, 2);
});

t('check：missing 汇总了 id/range/wantedBy', () => {
  const r = pb.check({ modsDir: MODS, selected: ['coolmod-1.2.0.jar'] });
  const m = r.missing.find((x) => x.id === 'libmissing');
  ok(m, '该有 libmissing');
  ok(m.wantedBy.some((w) => /Cool Mod/.test(w)), 'wantedBy 该是 Cool Mod');
});

t('check：同一个依赖被多个 mod 需要 → wantedBy 有两条', () => {
  const r = pb.check({ modsDir: MODS, selected: ['coolmod-1.2.0.jar', 'helpermod-2.0.0.jar'] });
  const m = r.missing.find((x) => x.id === 'fabric-api');
  eq(m.wantedBy.length, 2);
});

t('check：不勾任何东西 → 无 issue', () => {
  const r = pb.check({ modsDir: MODS, selected: [] });
  eq(r.count, 0);
  eq(r.issues.length, 0);
  eq(r.hasError, false);
});

/* =========================================================
   ④ check —— 依赖版本 / MC / 载入器 / 重复 / 未知
   ========================================================= */

t('check：依赖版本不满足 → DEP_VERSION(error)', () => {
  const r = pb.check({ modsDir: MODS, selected: ['demander-1.0.0.jar', 'helpermod-2.0.0.jar'] });
  const iss = r.issues.filter((i) => i.code === 'DEP_VERSION');
  eq(iss.length, 0, '2.0.0 满足 >=2.0，不该报错');
});

t('check：依赖版本真的不够时报错', () => {
  // helpermod 1.0.0 不满足 demander 要的 >=2.0
  fabricMod('helpermod-1.0.0.jar', {
    id: 'helpermod', name: 'Helper Mod', version: '1.0.0',
    mc: '1.20.x', depends: { fabricloader: '>=0.14' }
  });
  // 用 id 选中：会同时命中两个 helpermod → 先看 DUP，所以这里只选 demander + 低版本那条
  const r = pb.check({ modsDir: MODS, selected: ['demander-1.0.0.jar', 'helpermod-1.0.0.jar'] });
  const iss = r.issues.filter((i) => i.code === 'DEP_VERSION');
  ok(iss.length >= 1, '该报 DEP_VERSION，实际 ' + JSON.stringify(r.issues.map((i) => i.code)));
});

t('check：MC 版本不支持 → MC_MISMATCH(error)', () => {
  const r = pb.check({ modsDir: MODS, selected: ['oldmod-1.0.0.jar'], mcVersion: '1.20.1' });
  const iss = r.issues.filter((i) => i.code === 'MC_MISMATCH');
  eq(iss.length, 1);
  eq(iss[0].level, 'error');
  ok(iss[0].detail.includes('1.20.1'), '该提到目标版本');
});

t('check：不传 mcVersion 就不做 MC 检查', () => {
  const r = pb.check({ modsDir: MODS, selected: ['oldmod-1.0.0.jar'] });
  eq(r.issues.filter((i) => i.code === 'MC_MISMATCH').length, 0);
});

t('check：forge mod 混进 fabric 包 → LOADER_MIX(error)', () => {
  const r = pb.check({ modsDir: MODS, selected: ['coolmod-1.2.0.jar', 'forgeonly-1.0.0.jar'], loader: 'fabric' });
  const iss = r.issues.filter((i) => i.code === 'LOADER_MIX');
  ok(iss.length >= 1, '该报混装，实际 ' + JSON.stringify(r.issues.map((i) => i.code)));
  eq(iss[0].level, 'error');
});

t('check：同为 fabric 不报混装', () => {
  const r = pb.check({ modsDir: MODS, selected: ['coolmod-1.2.0.jar', 'fabric-api-0.92.0.jar'], loader: 'fabric' });
  eq(r.issues.filter((i) => i.code === 'LOADER_MIX').length, 0);
});

t('check：不传 loader 但混了生态 → LOADER_MIXED(warn)', () => {
  const r = pb.check({ modsDir: MODS, selected: ['coolmod-1.2.0.jar', 'forgeonly-1.0.0.jar'] });
  const iss = r.issues.filter((i) => i.code === 'LOADER_MIXED');
  ok(iss.length >= 1, '该给出软提醒');
  eq(iss[0].level, 'warn');
});

t('check：同 id 两份 → DUP_ID(error)', () => {
  const r = pb.check({ modsDir: MODS, selected: ['coolmod-1.2.0.jar', 'coolmod-1.3.0.jar'] });
  const iss = r.issues.filter((i) => i.code === 'DUP_ID');
  ok(iss.length >= 1, '该报重复，实际 ' + JSON.stringify(r.issues.map((i) => i.code)));
  ok(iss[0].detail.includes('1.2.0') && iss[0].detail.includes('1.3.0'), '该列出两个版本');
});

t('check：unknown 文件 → UNKNOWN_META(info)', () => {
  const r = pb.check({ modsDir: MODS, selected: ['broken.jar'] });
  const iss = r.issues.filter((i) => i.code === 'UNKNOWN_META');
  eq(iss.length, 1);
  eq(iss[0].level, 'info');
  eq(r.hasError, false, 'info 不算错误');
});

t('check：issues 按 error → warn → info 排序', () => {
  const r = pb.check({
    modsDir: MODS,
    selected: ['coolmod-1.2.0.jar', 'oldmod-1.0.0.jar', 'broken.jar'],
    mcVersion: '1.20.1', loader: 'fabric'
  });
  const lv = r.issues.map((i) => i.level);
  const rank = { error: 0, warn: 1, info: 2 };
  for (let i = 1; i < lv.length; i++) {
    ok(rank[lv[i - 1]] <= rank[lv[i]], `排序错了：${lv.join(',')}`);
  }
});

t('check：hasError / errorCount / warnCount 一致', () => {
  const r = pb.check({ modsDir: MODS, selected: ['coolmod-1.2.0.jar'], mcVersion: '1.20.1', loader: 'fabric' });
  eq(r.hasError, r.errorCount > 0);
  eq(r.errorCount, r.issues.filter((i) => i.level === 'error').length);
  eq(r.warnCount, r.issues.filter((i) => i.level === 'warn').length);
});

t('check：picked 带 file/id/version/size', () => {
  const r = pb.check({ modsDir: MODS, selected: ['coolmod-1.2.0.jar'] });
  eq(r.picked.length, 1);
  eq(r.picked[0].id, 'coolmod');
  eq(r.picked[0].version, '1.2.0');
  ok(r.picked[0].size > 0);
  ok(r.bytes > 0);
});

t('check：selected 可用 modId 代替文件名', () => {
  const r = pb.check({ modsDir: MODS, selected: ['fabric-api'] });
  ok(r.count >= 1, '该按 id 命中');
  ok(r.picked.every((p) => p.id === 'fabric-api'));
});

t('check：selected 大小写不敏感', () => {
  const r = pb.check({ modsDir: MODS, selected: ['COOLMOD-1.2.0.JAR'] });
  eq(r.count, 1);
});

t('check：勾不存在的文件被忽略', () => {
  const r = pb.check({ modsDir: MODS, selected: ['not-here.jar'] });
  eq(r.count, 0);
});

/* =========================================================
   ⑤ buildManifest
   ========================================================= */

t('buildManifest：基本字段齐全', () => {
  const m = pb.buildManifest({
    modsDir: MODS, selected: ['fabric-api-0.92.0.jar'],
    name: '测试包', author: 'Felix', mcVersion: '1.20.1', loader: 'fabric',
    loaderVersion: '0.15.0', note: '备注'
  });
  eq(m.formatVersion, 1);
  eq(m.generator, 'Pebble Lunchar');
  eq(m.name, '测试包');
  eq(m.author, 'Felix');
  eq(m.note, '备注');
  eq(m.game.minecraft, '1.20.1');
  eq(m.game.loader, 'fabric');
  eq(m.game.loaderVersion, '0.15.0');
  ok(/^\d{4}-\d{2}-\d{2}T/.test(m.createdAt), 'createdAt 该是 ISO');
});

t('buildManifest：默认名兜底', () => {
  const m = pb.buildManifest({ modsDir: MODS, selected: [] });
  eq(m.name, '未命名整合包');
  eq(m.author, '');
});

t('buildManifest：mods 清单与选择一致', () => {
  const m = pb.buildManifest({ modsDir: MODS, selected: ['fabric-api-0.92.0.jar', 'cloth-config-11.1.106.jar'] });
  eq(m.mods.length, 2);
  const api = m.mods.find((x) => x.id === 'fabric-api');
  eq(api.version, '0.92.0');
  eq(api.library, true);
  ok(api.file.endsWith('.jar'));
});

t('buildManifest：dependencies 收集依赖与 requiredBy', () => {
  const m = pb.buildManifest({ modsDir: MODS, selected: ['coolmod-1.2.0.jar'] });
  const dep = m.dependencies.find((d) => d.id === 'fabric-api');
  ok(dep, '该有 fabric-api 依赖项');
  ok(dep.requiredBy.includes('coolmod'));
  ok(m.dependencies.some((d) => d.id === 'libmissing'), '本地没有的依赖也要记进清单');
});

t('buildManifest：dependencies 里不含内置依赖', () => {
  const m = pb.buildManifest({ modsDir: MODS, selected: ['coolmod-1.2.0.jar'] });
  ok(!m.dependencies.some((d) => /^(minecraft|fabricloader|forge)$/i.test(d.id)), '内置依赖不该出现');
});

t('buildManifest：issues / stats 带上', () => {
  const m = pb.buildManifest({ modsDir: MODS, selected: ['coolmod-1.2.0.jar'], mcVersion: '1.20.1' });
  ok(Array.isArray(m.issues));
  ok(m.stats.count >= 1);
  ok(m.stats.bytes > 0);
});

t('buildManifest：空参数不炸', () => {
  const m = pb.buildManifest({});
  eq(m.mods.length, 0);
  eq(m.dependencies.length, 0);
});

/* =========================================================
   ⑥ exportPack
   ========================================================= */

(async () => {

  await ta('exportPack：manifest 模式产出可读 zip', async () => {
    const out = path.join(TMP, 'out', 'pack-manifest.zip');
    const r = await pb.exportPack({
      modsDir: MODS, selected: ['fabric-api-0.92.0.jar'],
      outZip: out, name: '只清单'
    });
    eq(r.ok, true, r.error);
    eq(r.mode, 'manifest');
    ok(fs.existsSync(out), 'zip 该存在');
    ok(r.size > 0);

    const names = zipread.listEntries(out).map((e) => (typeof e === 'string' ? e : e.name));
    ok(names.some((n) => /(^|\/)manifest\.json$/.test(n)), '该有 manifest.json：' + names.join(','));
    ok(names.some((n) => /(^|\/)README\.txt$/.test(n)), '该有 README.txt');
    ok(!names.some((n) => /\.jar$/.test(n)), 'manifest 模式不该带 jar');
  });

  await ta('exportPack：manifest 内容能被 JSON.parse', async () => {
    const out = path.join(TMP, 'out', 'pack-manifest2.zip');
    await pb.exportPack({
      modsDir: MODS, selected: ['fabric-api-0.92.0.jar'],
      outZip: out, name: 'X', mcVersion: '1.20.1', loader: 'fabric'
    });
    const hit = zipread.readFirst(out, ['manifest.json']);
    ok(hit, '该能读出 manifest.json');
    const m = JSON.parse(hit.data.toString('utf8'));
    eq(m.name, 'X');
    eq(m.game.minecraft, '1.20.1');
    eq(m.mods.length, 1);
  });

  await ta('exportPack：README.txt 里有 Mod 清单与安装说明', async () => {
    const out = path.join(TMP, 'out', 'pack-readme.zip');
    await pb.exportPack({
      modsDir: MODS, selected: ['fabric-api-0.92.0.jar'],
      outZip: out, name: '读我', author: 'Felix', mcVersion: '1.20.1', loader: 'fabric'
    });
    const hit = zipread.readFirst(out, ['README.txt']);
    ok(hit, '该能读出 README.txt');
    const txt = hit.data.toString('utf8');
    ok(txt.includes('读我'), '该有包名');
    ok(txt.includes('Felix'), '该有作者');
    ok(txt.includes('Fabric API'), '该有 mod 清单');
    ok(txt.includes('安装说明'), '该有安装步骤');
  });

  await ta('exportPack：full 模式把 jar 复制进去', async () => {
    const out = path.join(TMP, 'out', 'pack-full.zip');
    const r = await pb.exportPack({
      modsDir: MODS, selected: ['fabric-api-0.92.0.jar', 'cloth-config-11.1.106.jar'],
      outZip: out, mode: 'full', name: '全量'
    });
    eq(r.ok, true, r.error);
    eq(r.mode, 'full');
    const names = zipread.listEntries(out).map((e) => (typeof e === 'string' ? e : e.name));
    const jars = names.filter((n) => /\.jar$/.test(n));
    eq(jars.length, 2, '该带两个 jar：' + names.join(','));
  });

  await ta('exportPack：full 模式只复制选中的，不夹带私货', async () => {
    const out = path.join(TMP, 'out', 'pack-full2.zip');
    await pb.exportPack({
      modsDir: MODS, selected: ['fabric-api-0.92.0.jar'],
      outZip: out, mode: 'full'
    });
    const names = zipread.listEntries(out).map((e) => (typeof e === 'string' ? e : e.name));
    ok(!names.some((n) => /coolmod/.test(n)), '没勾的 coolmod 不该进去');
    ok(!names.some((n) => /broken/.test(n)), '坏 jar 也不该进去');
  });

  await ta('exportPack：检查有 error 时拒绝导出，并要 force', async () => {
    const out = path.join(TMP, 'out', 'pack-blocked.zip');
    const r = await pb.exportPack({
      modsDir: MODS, selected: ['coolmod-1.2.0.jar'],   // 缺 libmissing → error
      outZip: out, name: '坏包'
    });
    eq(r.ok, false);
    eq(r.needForce, true);
    ok(r.error.includes('1'), '该说明有几个问题：' + r.error);
    ok(!fs.existsSync(out), '被拒时不该留下文件');
  });

  await ta('exportPack：force=true 跳过门控并标记 warned', async () => {
    const out = path.join(TMP, 'out', 'pack-forced.zip');
    const r = await pb.exportPack({
      modsDir: MODS, selected: ['coolmod-1.2.0.jar'],
      outZip: out, name: '强导', force: true
    });
    eq(r.ok, true, r.error);
    eq(r.warned, true);
    ok(fs.existsSync(out));
  });

  await ta('exportPack：没有 outZip 直接报错', async () => {
    const r = await pb.exportPack({ modsDir: MODS, selected: [] });
    eq(r.ok, false);
    ok(r.error.includes('outZip'), '该提示缺路径');
  });

  await ta('exportPack：自动创建输出目录', async () => {
    const out = path.join(TMP, 'deep', 'a', 'b', 'pack.zip');
    const r = await pb.exportPack({ modsDir: MODS, selected: ['fabric-api-0.92.0.jar'], outZip: out });
    eq(r.ok, true, r.error);
    ok(fs.existsSync(out), '深层目录该被建出来');
  });

  await ta('exportPack：onProgress 被调用且 done 递增到 total', async () => {
    const out = path.join(TMP, 'out', 'pack-prog.zip');
    const seen = [];
    await pb.exportPack({
      modsDir: MODS,
      selected: ['fabric-api-0.92.0.jar', 'cloth-config-11.1.106.jar', 'helpermod-2.0.0.jar'],
      outZip: out, mode: 'full',
      onProgress: (p) => seen.push(p)
    });
    eq(seen.length, 3);
    eq(seen[0].done, 1);
    eq(seen[2].done, 3);
    eq(seen[0].total, 3);
  });

  await ta('exportPack：没有 error 时不置 warned', async () => {
    const out = path.join(TMP, 'out', 'pack-clean.zip');
    const r = await pb.exportPack({
      modsDir: MODS, selected: ['fabric-api-0.92.0.jar', 'cloth-config-11.1.106.jar'],
      outZip: out
    });
    eq(r.ok, true, r.error);
    eq(r.warned, false);
  });

  await ta('exportPack：产物可被 zipread 正常解析（不是空壳）', async () => {
    const out = path.join(TMP, 'out', 'pack-valid.zip');
    await pb.exportPack({ modsDir: MODS, selected: ['fabric-api-0.92.0.jar'], outZip: out });
    const names = zipread.listEntries(out);
    ok(names.length >= 2, '该至少两个条目');
  });

  console.log(`\n  ${pass} 通过 / ${fail} 失败`);
  if (fail) process.exit(1);
})();
