// 实例系统与跨启动器迁移的单元测试（离线，全部用临时目录）
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const instances = require('../instances');
const migrate = require('../migrate');
const { makeZip, makeLevelDat, fakePng } = require('./fixtures');

let pass = 0, fail = 0;
// 同步写 stdout：进程若崩溃，管道里的缓冲输出会丢，日志会停在错误位置之前的某一句
const say = (s) => { try { fs.writeSync(1, s + '\n'); } catch {} };
function check(name, ok, extra) {
  if (ok) { pass++; say('  ok    ' + name); }
  else { fail++; say('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

const TMP = path.join(os.tmpdir(), 'pl-inst-' + Date.now());
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

/* ---------- 造一个"像样的"假 .minecraft ---------- */
function makeGameDir(dir, opt) {
  opt = opt || {};
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'versions', '1.20.1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'versions', '1.20.1', '1.20.1.json'), '{}');
  if (opt.mods) {
    fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
    for (const n of opt.mods) fs.writeFileSync(path.join(dir, 'mods', n), Buffer.alloc(2048, 7));
  }
  if (opt.saves) {
    fs.mkdirSync(path.join(dir, 'saves'), { recursive: true });
    for (const n of opt.saves) {
      const s = path.join(dir, 'saves', n);
      fs.mkdirSync(s, { recursive: true });
      fs.writeFileSync(path.join(s, 'level.dat'), makeLevelDat({ name: n }));
      fs.writeFileSync(path.join(s, 'icon.png'), fakePng());
    }
  }
  if (opt.rps) {
    fs.mkdirSync(path.join(dir, 'resourcepacks'), { recursive: true });
    for (const n of opt.rps) makeZip(path.join(dir, 'resourcepacks', n + '.zip'), [{ name: 'pack.mcmeta', data: '{}' }]);
  }
  if (opt.options) fs.writeFileSync(path.join(dir, 'options.txt'), 'renderDistance:12\n');
  return dir;
}

say('=== 实例系统 ===');
{
  const root = path.join(TMP, 'meta1');
  const mcDir = makeGameDir(path.join(TMP, 'mc1'), { mods: ['a.jar'], saves: ['W1'], options: true });
  fs.mkdirSync(root, { recursive: true });

  // 1) 老用户升级：必须生成一个 default 实例，且 gameDir 为空 = 什么都不搬
  const d = instances.ensureDefault({ root, mcDir, version: '1.20.1' });
  check('ensureDefault 创建默认实例', !!d && d.id === 'default', JSON.stringify(d));
  check('默认实例 gameDir 为空（沿用 mcDir，不搬家）', d && d.gameDir === '', d && d.gameDir);
  check('默认实例被设为当前实例', instances.active({ root }) && instances.active({ root }).id === 'default');

  // 2) resolveGameDir 的三条分支
  const g1 = instances.resolveGameDir({ inst: d, mcDir, isolation: false, version: '1.20.1' });
  check('gameDir 为空 → 用 mcDir', g1 === mcDir, g1);
  const g2 = instances.resolveGameDir({ inst: d, mcDir, isolation: true, version: '1.20.1' });
  check('gameDir 为空 + 版本隔离 → versions/<v>/isolation', g2 === path.join(mcDir, 'versions', '1.20.1', 'isolation'), g2);
  const g3 = instances.resolveGameDir({ inst: { gameDir: 'X' }, mcDir, isolation: true, version: 'v' });
  check('显式 gameDir 优先于版本隔离', g3 === 'X', g3);

  // 3) 新建实例：目录真的被创建，且带上复制的内容
  const inst = instances.create({
    root, name: '整合包 A', version: '1.20.1', instancesRoot: path.join(TMP, 'insts'),
    copyFrom: [mcDir], items: ['mods', 'saves', 'options']
  });
  check('create 返回实例且 gameDir 自动分配', !!inst && fs.existsSync(inst.gameDir), inst && inst.gameDir);
  check('复制了 mods', fs.existsSync(path.join(inst.gameDir, 'mods', 'a.jar')));
  check('复制了 saves', fs.existsSync(path.join(inst.gameDir, 'saves', 'W1', 'level.dat')));
  check('复制了 options.txt', fs.existsSync(path.join(inst.gameDir, 'options.txt')));
  check('没勾选的资源包没被带过来', !fs.existsSync(path.join(inst.gameDir, 'resourcepacks')));
  check('新建后自动切换为当前实例', instances.active({ root }).id === inst.id);

  // 4) 复制的同名实例目录要被拒绝（否则两个实例共用目录会互相踩）
  let dupErr = '';
  try {
    instances.create({ root, name: '整合包 A', instancesRoot: path.join(TMP, 'insts') });
  } catch (e) { dupErr = e.message; }
  check('重复 gameDir 会被拒绝', /已存在使用该目录/.test(dupErr), dupErr);

  // 5) 复制实例
  const copy = instances.duplicate({ root, id: inst.id, name: '整合包 A 副本', instancesRoot: path.join(TMP, 'insts'), items: ['mods'] });
  check('duplicate 生成新实例', !!copy && copy.id !== inst.id);
  check('复制实例带上了 mods', fs.existsSync(path.join(copy.gameDir, 'mods', 'a.jar')));
  check('复制实例没带未勾选的存档', !fs.existsSync(path.join(copy.gameDir, 'saves', 'W1')));

  // 6) update 只认白名单
  instances.update({ root, id: copy.id, patch: { name: '改名了', evil: 'x', mem: 6 } });
  const after = instances.get({ root, id: copy.id });
  check('update 改名称成功', after.name === '改名了', after.name);
  check('update 忽略非白名单字段', after.evil === undefined);
  check('update 改 mem 成功', after.mem === 6);

  // 7) stats
  const st = instances.stats({ gameDir: inst.gameDir });
  check('stats 统计 mods/saves 数量', st.mods === 1 && st.saves === 1, JSON.stringify(st));
  check('stats 认出 options.txt', st.hasOptions === true);
  check('stats 体积大于 0', st.size > 0, String(st.size));

  // 8) touchPlayed 会让实例排到列表前面
  instances.touchPlayed({ root, id: inst.id });
  const sorted = instances.list({ root }).instances;
  check('最近玩过的实例排在前面', sorted[0].id === inst.id, sorted.map((i) => i.id).join(','));

  // 9) 默认实例不可删；普通实例可删（含文件 / 不含文件两种）
  let builtinErr = '';
  try { instances.remove({ root, id: 'default' }); } catch (e) { builtinErr = e.message; }
  check('默认实例不能删除', /不能删除/.test(builtinErr), builtinErr);

  instances.remove({ root, id: copy.id, deleteFiles: true });
  check('删除实例后文件也没了', !fs.existsSync(copy.gameDir));
  check('删除后列表不再包含它', !instances.list({ root }).instances.some((i) => i.id === copy.id));

  const keepDir = instances.get({ root, id: inst.id }).gameDir;
  instances.remove({ root, id: inst.id, deleteFiles: false });
  check('不勾选删文件时目录保留', fs.existsSync(keepDir));

  // 10) 重复调用 ensureDefault 不会重建
  const total = instances.list({ root }).instances.length;
  instances.ensureDefault({ root, mcDir, version: '1.20.1' });
  check('ensureDefault 幂等', instances.list({ root }).instances.length === total);

  // 11) 实例名里的非法字符不能导致目录创建失败
  const weird = instances.create({ root, name: 'a/b:c*d?', instancesRoot: path.join(TMP, 'insts') });
  check('非法文件名会被清理', !!weird && fs.existsSync(weird.gameDir), weird && weird.gameDir);
}

say('\n=== 跨启动器迁移：探测 ===');
{
  const appData = path.join(TMP, 'AppDataRoaming');
  const localAppData = path.join(TMP, 'AppDataLocal');
  const home = path.join(TMP, 'Home');
  const pclRoots = [path.join(TMP, 'Disks')];

  // 官方启动器
  const official = makeGameDir(path.join(appData, '.minecraft'), { mods: ['o.jar'] });
  // Prism：两个实例
  const prismRoot = path.join(appData, 'PrismLauncher');
  const p1 = path.join(prismRoot, 'instances', 'SkyFactory');
  fs.mkdirSync(path.join(p1, '.minecraft', 'mods'), { recursive: true });
  fs.writeFileSync(path.join(p1, '.minecraft', 'mods', 'sf.jar'), Buffer.alloc(1024, 1));
  fs.writeFileSync(path.join(p1, 'instance.cfg'), '[General]\nConfigVersion=1.2\nname=我的天空工厂\niconKey=chest\nnotes=测试实例\n');
  fs.writeFileSync(path.join(p1, 'mmc-pack.json'), JSON.stringify({
    components: [{ uid: 'net.minecraft', version: '1.19.2' }, { uid: 'net.fabricmc.fabric-loader', version: '0.14.21' }]
  }));
  const p2 = path.join(prismRoot, 'instances', 'Vanilla 1.20');
  fs.mkdirSync(path.join(p2, '.minecraft', 'versions'), { recursive: true });
  fs.writeFileSync(path.join(p2, 'instance.cfg'), 'name=香草Foo\n');
  fs.writeFileSync(path.join(p2, '.minecraft', 'options.txt'), 'x');
  fs.mkdirSync(path.join(prismRoot, 'instances', 'not-an-instance'), { recursive: true });
  // HMCL：配置里指向一个自定义游戏目录
  const hmclRoot = path.join(appData, '.hmcl');
  const hmclGame = makeGameDir(path.join(TMP, 'Disks', 'hmcl-game'), { saves: ['HM存档'], mods: ['hm.jar'] });
  fs.mkdirSync(hmclRoot, { recursive: true });
  fs.writeFileSync(path.join(hmclRoot, 'config.json'), JSON.stringify({
    backgroundImage: '/img/foo.png',
    somethingElse: 42,
    gameDir: hmclGame.replace(/\\/g, '/')
  }));
  // PCL2：绿色版，藏在磁盘根目录里
  const pclDir = path.join(pclRoots[0], 'PCL2 v2.7');
  const pclGame = makeGameDir(path.join(pclDir, '.minecraft'), { saves: ['PCL世界'], mods: ['p.jar'] });
  fs.writeFileSync(path.join(pclDir, 'PCL.exe'), 'binary');
  fs.writeFileSync(path.join(pclDir, 'PCL.ini'), [
    'VersionIndicator:12345',
    'CacheFilePath:' + path.join(pclDir, 'cache', 'impossible.jar'),
    'VersionIndicator:12345',
    'VersionCustom:' + path.join(TMP, 'does-not-exist'),
    'DebugAnimation:True'
  ].join('\n'));
  const unrelated = path.join(pclRoots[0], 'SteamLibrary');
  fs.mkdirSync(unrelated, { recursive: true });

  const found = migrate.detectLaunchers({ appData, localAppData, home, pclRoots });
  const byId = {};
  for (const f of found) (byId[f.launcher] = byId[f.launcher] || []).push(f);

  check('探测到 4 类启动器', Object.keys(byId).sort().join(',') === 'hmcl,official,pcl,prism', Object.keys(byId).join(','));
  check('官方启动器找到 .minecraft', (byId.official || []).length === 1 && (byId.official || [])[0].instances[0].gameDir === official);
  check('Prism 找到 2 个实例（跳过目录名伪装）', (byId.prism || [])[0] && (byId.prism || [])[0].instances.length === 2,
    JSON.stringify((byId.prism || [])[0] && (byId.prism || [])[0].instances.map((i) => i.name)));
  const sf = (byId.prism || [])[0].instances.find((i) => i.name === '我的天空工厂');
  check('Prism 实例名取自 instance.cfg 而非文件夹名', !!sf, JSON.stringify((byId.prism || [])[0].instances.map((i) => i.name)));
  check('Prism 从 mmc-pack.json 解析出 MC 版本 1.19.2', sf && sf.mcVersion === '1.19.2', sf && sf.mcVersion);
  const vanilla = (byId.prism || [])[0].instances.find((i) => i.gameDir.indexOf('Vanilla') >= 0);
  check('Prism gameDir 指向 .minecraft 子目录', vanilla && vanilla.gameDir === path.join(p2, '.minecraft'), vanilla && vanilla.gameDir);
  check('HMCL 从 config.json 摸出游戏目录', (byId.hmcl || []).length === 1 && (byId.hmcl || [])[0].instances[0].gameDir === hmclGame,
    JSON.stringify(byId.hmcl));
  check('HMCL 不会把 backgroundImage 这种无关路径当成游戏目录',
    !(byId.hmcl || []).some((l) => l.instances.some((i) => /backgroundImage|img/.test(i.gameDir))));
  check('PCL2 找到 .minecraft', (byId.pcl || []).length === 1 && (byId.pcl || [])[0].instances.some((i) => i.gameDir === pclGame),
    JSON.stringify(byId.pcl));
  check('PCL2 ini 里不存在的路径不会被列出来',
    !(byId.pcl || []).some((l) => l.instances.some((i) => /does-not-exist|cache/.test(i.gameDir))));
  check('未匹配的普通目录不会被误认', !found.some((l) => l.instances.some((i) => /SteamLibrary/.test(i.gameDir))));

  // 同一个游戏目录被多个启动器指向时只应出现一次
  const allDirs = [];
  for (const l of found) for (const i of l.instances) allDirs.push(i.gameDir.toLowerCase());
  check('没有重复的游戏目录', new Set(allDirs).size === allDirs.length, allDirs.join(' | '));
}

say('\n=== 跨启动器迁移：清点 ===');
{
  const src = makeGameDir(path.join(TMP, 'scan-src'), {
    mods: ['jei.jar', 'sodium.jar'], saves: ['主世界', '下界之家'], rps: ['faithful'],
    options: true
  });
  fs.mkdirSync(path.join(src, 'screenshots'), { recursive: true });
  fs.writeFileSync(path.join(src, 'screenshots', 'a.png'), fakePng());
  fs.writeFileSync(path.join(src, 'launcher_profiles.json'), JSON.stringify({
    authenticationDatabase: {
      'aaa': { displayName: 'Notch', accessToken: 'SECRET-TOKEN-SHOULD-NEVER-BE-IMPORTED', uuid: 'x' }
    }
  }));

  const c = migrate.scanContent({ gameDir: src });
  check('清点：mods 2 个', c.counts.mods === 2, JSON.stringify(c.counts));
  check('清点：存档 2 个且读出了真实世界名',
    c.saves.length === 2 && c.saves.some((s) => s.name === '主世界') && c.saves.some((s) => s.name === '下界之家'),
    JSON.stringify(c.saves.map((s) => s.name)));
  check('清点：资源包 1 个', c.rps.length === 1);
  check('清点：截图 1 张', c.shots.length === 1);
  check('清点：认出 options.txt', c.options === true);
  check('清点：体积大于 0', c.size > 0, String(c.size));

  check('玩家名被提取出来', c.players.indexOf('Notch') >= 0, JSON.stringify(c.players));
  const json = JSON.stringify(c);
  check('★ 凭据不会被带出来', json.indexOf('SECRET-TOKEN') < 0, json.slice(0, 200));

  check('不存在的目录标记为 exists:false', migrate.scanContent({ gameDir: path.join(TMP, 'nope') }).exists === false);
}

say('\n=== 跨启动器迁移：导入 ===');
{
  const src = makeGameDir(path.join(TMP, 'import-src'), {
    mods: ['x.jar'], saves: ['世界A'], rps: ['pack1'], options: true
  });
  const dest = path.join(TMP, 'import-dest');
  fs.mkdirSync(dest, { recursive: true });

  const c = migrate.scanContent({ gameDir: src });
  const r1 = migrate.importItems({
    destGameDir: dest,
    items: [
      { kind: 'mods', paths: c.mods.map((m) => m.path) },
      { kind: 'saves', paths: c.saves.map((s) => s.dir) },
      { kind: 'options', paths: [path.join(src, 'options.txt')] }
    ]
  });
  check('导入：3 项成功、0 失败', r1.copied === 3 && r1.failed === 0, JSON.stringify(r1));
  check('导入到 mods/', fs.existsSync(path.join(dest, 'mods', 'x.jar')));
  check('导入到 saves/ 且目录结构完整', fs.existsSync(path.join(dest, 'saves', '世界A', 'level.dat')));
  check('options.txt 直接落在根目录', fs.existsSync(path.join(dest, 'options.txt')));
  check('未勾选的资源包没有被导入', !fs.existsSync(path.join(dest, 'resourcepacks')));
  check('源目录不受影响（只读原则）', fs.existsSync(path.join(src, 'mods', 'x.jar')) && fs.existsSync(path.join(src, 'saves', '世界A')));

  // 重复导入默认跳过，不覆盖
  fs.writeFileSync(path.join(dest, 'mods', 'x.jar'), Buffer.alloc(9999, 3));
  const r2 = migrate.importItems({ destGameDir: dest, items: [{ kind: 'mods', paths: c.mods.map((m) => m.path) }] });
  check('重复导入默认跳过（不覆盖已有文件）', r2.skipped === 1 && r2.copied === 0, JSON.stringify(r2));
  check('跳过后原文件内容保持原样', fs.statSync(path.join(dest, 'mods', 'x.jar')).size === 9999);

  const r3 = migrate.importItems({ destGameDir: dest, overwrite: true, items: [{ kind: 'mods', paths: c.mods.map((m) => m.path) }] });
  check('overwrite=true 时覆盖', r3.copied === 1 && fs.statSync(path.join(dest, 'mods', 'x.jar')).size === 2048);

  const r4 = migrate.importItems({ destGameDir: dest, items: [{ kind: 'saves', paths: [path.join(src, 'saves', '压根没有的世界')] }] });
  check('不存在的源路径记为失败但不中断', r4.failed === 1 && r4.errors.length === 1, JSON.stringify(r4));
}

/* ---------- 收尾 ---------- */
say(`\n${fail === 0 ? '★' : '✗'} 结果: ${pass} 通过 / ${fail} 失败`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
