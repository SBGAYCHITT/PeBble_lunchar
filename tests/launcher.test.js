/*
 * launcher.js 单测 —— 锁死「Forge 总是说缺 jar」那次的根因，防止再犯。
 *
 * 事故现象：装了 Forge（26.3-forge-66.0.4）后
 *   1) 版本列表里每个 Forge 版本都标「· 缺 jar」
 *   2) 点启动 → 「缺少客户端 jar: ...\versions\26.3-forge-66.0.4\26.3-forge-66.0.4.jar」
 *
 * 两个独立根因：
 *   A. 客户端 jar 解析写死了 versions/<id>/<id>.jar。加载器版本的目录里**只有 json**，
 *      主程序 jar 在父版本目录（靠 inheritsFrom 指过去）→ 必须沿继承链解析。
 *   B. mergeJson 合并 arguments 时用「子覆盖父」，而官方语义是**拼接**。
 *      于是 Forge 版本的 game 参数只剩 `--launchTarget forge_client`，
 *      账号 / 游戏目录 / 资源索引 / natives 路径 / `-cp ${classpath}` 全部丢失。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../launcher');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-launcher-'));

/* ---------- 工具：造一个假的 .minecraft ---------- */
function mkMc(name) {
  const mc = path.join(tmpRoot, name);
  fs.mkdirSync(path.join(mc, 'versions'), { recursive: true });
  return mc;
}
function putVersion(mc, id, json, withJar) {
  const d = path.join(mc, 'versions', id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, id + '.json'), JSON.stringify(json, null, 2));
  if (withJar) fs.writeFileSync(path.join(d, id + '.jar'), Buffer.alloc(2048, 7));
  return d;
}

/* ---------- 真实形状的 fixture（字段名与官方 JSON 一致） ---------- */
const VANILLA_JSON = {
  id: '26.3',
  type: 'release',
  mainClass: 'net.minecraft.client.main.Main',
  assets: '34',
  assetIndex: { id: '34', url: 'https://example.invalid/34.json' },
  arguments: {
    game: [
      '--username', '${auth_player_name}',
      '--version', '${version_name}',
      '--gameDir', '${game_directory}',
      '--assetsDir', '${assets_root}',
      '--assetIndex', '${assets_index_name}',
      '--uuid', '${auth_uuid}',
      '--accessToken', '${auth_access_token}',
      { rules: [{ action: 'allow', features: { has_custom_resolution: true } }], value: ['--width', '${resolution_width}', '--height', '${resolution_height}'] }
    ],
    jvm: [
      { rules: [{ action: 'allow', os: { name: 'osx' } }], value: ['-XstartOnFirstThread'] },
      { rules: [{ action: 'allow', os: { name: 'windows' } }], value: '-XX:HeapDumpPath=mojang.heapdump' },
      { rules: [{ action: 'allow', os: { arch: 'x86' } }], value: '-Xss1M' },
      '-Djava.library.path=${natives_directory}/java',
      '-Dminecraft.launcher.version=${launcher_version}',
      '-cp', '${classpath}'
    ]
  },
  libraries: [
    { name: 'org.lwjgl:lwjgl:3.3.3' },
    { name: 'com.mojang:brigadier:1.0.18' }
  ]
};

const FORGE_JSON = {
  id: '26.3-forge-66.0.4',
  inheritsFrom: '26.3',
  type: 'release',
  mainClass: 'net.minecraftforge.bootstrap.ForgeBootstrap',
  arguments: {
    game: ['--launchTarget', 'forge_client'],
    jvm: ['-Djava.net.preferIPv6Addresses=system', '-XX:+UseCompactObjectHeaders']
  },
  libraries: [
    { name: 'net.minecraftforge:forge:26.3-66.0.4:universal' },
    { name: 'com.mojang:brigadier:1.0.18' } // 与父重复，应被子覆盖而非重复
  ]
};

/* ================= A. 客户端 jar 解析 ================= */
console.log('\n[launcher] A. 客户端 jar 解析（resolveClientJar）');

t('原版：自己目录里有 jar → from = 自己', () => {
  const mc = mkMc('a1');
  putVersion(mc, '26.3', VANILLA_JSON, true);
  const r = L.resolveClientJar(mc, '26.3');
  assert.ok(r, '应该解析到 jar');
  assert.strictEqual(r.from, '26.3');
  assert.strictEqual(path.basename(r.jar), '26.3.jar');
});

t('加载器版本：自己没 jar → 沿 inheritsFrom 拿到父版本的 jar', () => {
  const mc = mkMc('a2');
  putVersion(mc, '26.3', VANILLA_JSON, true);
  putVersion(mc, '26.3-forge-66.0.4', FORGE_JSON, false); // 关键：不写 jar
  const r = L.resolveClientJar(mc, '26.3-forge-66.0.4');
  assert.ok(r, 'Forge 版本应当解析到父版本的 jar（这正是旧代码报「缺 jar」的地方）');
  assert.strictEqual(r.from, '26.3');
  assert.deepStrictEqual(r.chain, ['26.3-forge-66.0.4', '26.3']);
});

t('json 里显式声明 jar 字段时优先于 inheritsFrom', () => {
  const mc = mkMc('a3');
  putVersion(mc, '26.3', VANILLA_JSON, true);
  putVersion(mc, '26.2', Object.assign({}, VANILLA_JSON, { id: '26.2' }), true);
  putVersion(mc, '26.3-optifine-x', {
    id: '26.3-optifine-x', inheritsFrom: '26.3', jar: '26.2', type: 'release'
  }, false);
  const r = L.resolveClientJar(mc, '26.3-optifine-x');
  assert.strictEqual(r.from, '26.2');
});

t('三层继承链也能一路走到有 jar 的那层', () => {
  const mc = mkMc('a4');
  putVersion(mc, '26.3', VANILLA_JSON, true);
  putVersion(mc, '26.3-forge-66.0.4', FORGE_JSON, false);
  putVersion(mc, '26.3-forge-66.0.4-patched', { inheritsFrom: '26.3-forge-66.0.4' }, false);
  const r = L.resolveClientJar(mc, '26.3-forge-66.0.4-patched');
  assert.strictEqual(r.from, '26.3');
  assert.strictEqual(r.chain.length, 3);
});

t('整条链都没有 jar → null（父版本也没装原版）', () => {
  const mc = mkMc('a5');
  putVersion(mc, '26.3-forge-66.0.4', FORGE_JSON, false); // 父版本 26.3 根本不存在
  assert.strictEqual(L.resolveClientJar(mc, '26.3-forge-66.0.4'), null);
});

t('继承链成环不死循环', () => {
  const mc = mkMc('a6');
  putVersion(mc, 'x', { id: 'x', inheritsFrom: 'y' }, false);
  putVersion(mc, 'y', { id: 'y', inheritsFrom: 'x' }, false);
  assert.strictEqual(L.resolveClientJar(mc, 'x'), null);
});

/* ================= B. arguments 合并 ================= */
console.log('\n[launcher] B. arguments 合并（官方语义是拼接，不是覆盖）');

t('mergeArguments：game 父在前子在后', () => {
  const m = L.mergeArguments(
    { game: ['--username', 'A'], jvm: ['-cp', 'CP'] },
    { game: ['--launchTarget', 'forge_client'], jvm: ['-Dforge=1'] }
  );
  assert.deepStrictEqual(m.game, ['--username', 'A', '--launchTarget', 'forge_client']);
  assert.deepStrictEqual(m.jvm, ['-cp', 'CP', '-Dforge=1']);
});

t('mergeArguments：父有子无的键保留（jvm/game 之外的直通）', () => {
  const m = L.mergeArguments({ game: ['a'], 'default-user-jvm': [1] }, { game: ['b'] });
  assert.deepStrictEqual(m.game, ['a', 'b']);
  assert.deepStrictEqual(m['default-user-jvm'], [1]);
});

t('mergeJson：Forge 合并后 game 参数同时含账号参数与 --launchTarget', () => {
  const m = L.mergeJson(VANILLA_JSON, FORGE_JSON);
  assert.ok(m.arguments.game.includes('--launchTarget'), '保留子版本的 --launchTarget');
  assert.ok(m.arguments.game.includes('--username'), '★ 关键回归：父版本的 --username 不能丢');
  assert.ok(m.arguments.game.includes('${auth_player_name}'));
  assert.ok(m.arguments.game[0] === '--username', '父参数应排在前面');
  assert.strictEqual(m.arguments.game[m.arguments.game.length - 1], 'forge_client');
});

t('mergeJson：Forge 合并后 jvm 参数保留 -cp ${classpath} 与 natives 路径', () => {
  const m = L.mergeJson(VANILLA_JSON, FORGE_JSON);
  assert.ok(m.arguments.jvm.includes('-cp'), '★ 关键回归：-cp 不能丢');
  assert.ok(m.arguments.jvm.includes('${classpath}'));
  assert.ok(m.arguments.jvm.some(a => String(a).startsWith('-Djava.library.path=')));
  assert.ok(m.arguments.jvm.includes('-Djava.net.preferIPv6Addresses=system'), '子版本自己的 jvm 参数要在');
});

t('mergeJson：libraries 按 name 去重，子覆盖父', () => {
  const m = L.mergeJson(VANILLA_JSON, FORGE_JSON);
  const names = m.libraries.map(l => l.name);
  assert.strictEqual(names.filter(n => n === 'com.mojang:brigadier:1.0.18').length, 1, '重复项应合并为一条');
  assert.ok(names.includes('net.minecraftforge:forge:26.3-66.0.4:universal'));
});

t('mergeJson：mainClass / id 由子版本覆盖，assetIndex 从父继承', () => {
  const m = L.mergeJson(VANILLA_JSON, FORGE_JSON);
  assert.strictEqual(m.mainClass, 'net.minecraftforge.bootstrap.ForgeBootstrap');
  assert.strictEqual(m.id, '26.3-forge-66.0.4');
  assert.strictEqual(m.assetIndex.id, '34', 'Forge json 没有 assetIndex，必须继承父的');
});

t('mergeJson：旧格式 minecraftArguments 拼接而非丢弃', () => {
  const m = L.mergeJson({ minecraftArguments: '--username a' }, { minecraftArguments: '--tweakClass x' });
  assert.strictEqual(m.minecraftArguments, '--username a --tweakClass x');
});

t('mergeJson 是纯函数，不改动入参', () => {
  const p = JSON.parse(JSON.stringify(VANILLA_JSON));
  const c = JSON.parse(JSON.stringify(FORGE_JSON));
  L.mergeJson(p, c);
  assert.deepStrictEqual(p, VANILLA_JSON);
  assert.deepStrictEqual(c, FORGE_JSON);
});

t('loadVersionJson：从磁盘读到 Forge 也会正确合并（老代码在这里丢参数）', () => {
  const mc = mkMc('b1');
  putVersion(mc, '26.3', VANILLA_JSON, true);
  putVersion(mc, '26.3-forge-66.0.4', FORGE_JSON, false);
  const j = L.loadVersionJson(mc, '26.3-forge-66.0.4');
  assert.ok(j.arguments.game.includes('--gameDir'));
  assert.ok(j.arguments.jvm.includes('-cp'));
  assert.strictEqual(j.mainClass, 'net.minecraftforge.bootstrap.ForgeBootstrap');
});

/* ================= C. JVM 参数展开 ================= */
console.log('\n[launcher] C. arguments.jvm 展开');

const VARS = {
  natives_directory: 'C:\\natives',
  classpath: 'a.jar;b.jar',
  launcher_version: '3.0.0',
  launcher_name: 'PebbleLunchar',
  classpath_separator: ';',
  library_directory: 'C:\\libs'
};

t('字符串项做占位符替换', () => {
  const out = L.expandJvmArgs(VANILLA_JSON.arguments.jvm, VARS, {});
  assert.ok(out.includes('-Djava.library.path=C:\\natives/java'));
  assert.ok(out.includes('-Dminecraft.launcher.version=3.0.0'));
});

t('os 规则过滤：windows 项留下，osx / x86 项剔除', () => {
  const out = L.expandJvmArgs(VANILLA_JSON.arguments.jvm, VARS, {});
  assert.ok(out.includes('-XX:HeapDumpPath=mojang.heapdump'), 'windows 项应保留');
  assert.ok(!out.includes('-XstartOnFirstThread'), 'osx 项应剔除');
  assert.ok(!out.includes('-Xss1M'), 'x86 项应剔除');
});

t('-cp 与 ${classpath} 正确展开', () => {
  const out = L.expandJvmArgs(VANILLA_JSON.arguments.jvm, VARS, {});
  const i = out.indexOf('-cp');
  assert.ok(i >= 0);
  assert.strictEqual(out[i + 1], 'a.jar;b.jar');
});

t('相同占位符出现多次会全部替换（旧的链式 replace 只换第一个）', () => {
  const out = L.expandJvmArgs(['${natives_directory}/x', '-Dp=${natives_directory}/y'], VARS, {});
  assert.deepStrictEqual(out, ['C:\\natives/x', '-Dp=C:\\natives/y']);
});

t('未识别的占位符原样保留（便于发现拼错的变量名）', () => {
  assert.deepStrictEqual(L.expandJvmArgs(['-Dx=${no_such_var}'], VARS, {}), ['-Dx=${no_such_var}']);
});

t('features 规则：has_custom_resolution 未开启时不输出 --width', () => {
  const out = L.expandJvmArgs(
    [{ rules: [{ action: 'allow', features: { has_custom_resolution: true } }], value: ['-DW=1'] }],
    VARS, { has_custom_resolution: false }
  );
  assert.deepStrictEqual(out, []);
});

t('expandJvmArgs 容忍 undefined / 非数组（老版本 json 没有 arguments）', () => {
  assert.deepStrictEqual(L.expandJvmArgs(undefined, VARS, {}), []);
  assert.deepStrictEqual(L.expandJvmArgs([], VARS, {}), []);
});

/* ================= D. 版本列表 hasJar ================= */
console.log('\n[launcher] D. 版本列表的 hasJar');

t('Forge 版本在列表里 hasJar = true（旧代码在这里显示「缺 jar」）', () => {
  const mc = mkMc('d1');
  putVersion(mc, '26.3', VANILLA_JSON, true);
  putVersion(mc, '26.3-forge-66.0.4', FORGE_JSON, false);
  const list = L.listVersions(mc);
  const forge = list.find(v => v.id === '26.3-forge-66.0.4');
  const vanilla = list.find(v => v.id === '26.3');
  assert.ok(forge, '应扫到 Forge 版本');
  assert.strictEqual(forge.hasJar, true);
  assert.strictEqual(forge.jarFrom, '26.3');
  assert.strictEqual(vanilla.hasJar, true);
  assert.strictEqual(vanilla.jarFrom, '26.3');
});

t('原版缺失时 Forge 仍然 hasJar = false（这才是真缺 jar）', () => {
  const mc = mkMc('d2');
  putVersion(mc, '26.3-forge-66.0.4', FORGE_JSON, false);
  const list = L.listVersions(mc);
  assert.strictEqual(list.find(v => v.id === '26.3-forge-66.0.4').hasJar, false);
});

t('没有 json 的目录不进入列表', () => {
  const mc = mkMc('d3');
  fs.mkdirSync(path.join(mc, 'versions', 'empty-dir'), { recursive: true });
  assert.deepStrictEqual(L.listVersions(mc).map(v => v.id), []);
});

/* ================= E. Java 版本号 ================= */
console.log('\n[launcher] E. Java 主版本号解析');

t('1.8.0_402 → 8（旧代码 parseInt 会得到 1）', () => {
  assert.strictEqual(L.javaMajorOf('1.8.0_402'), 8);
});
t('25.0.1 → 25 / 17.0.9 → 17', () => {
  assert.strictEqual(L.javaMajorOf('25.0.1'), 25);
  assert.strictEqual(L.javaMajorOf('17.0.9'), 17);
});
t('空值 / 垃圾输入 → 0', () => {
  assert.strictEqual(L.javaMajorOf(''), 0);
  assert.strictEqual(L.javaMajorOf(null), 0);
  assert.strictEqual(L.javaMajorOf('abc'), 0);
});

/* ---------- 收尾 ---------- */
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

console.log(`\n[launcher] 通过 ${pass}，失败 ${fail}\n`);
process.exit(fail ? 1 : 0);
