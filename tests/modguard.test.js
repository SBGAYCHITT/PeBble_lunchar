// 合成带真实元数据的假 mod jar，验证 modguard 的解析 / 预检 / diff / 快照回滚
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const mg = require('../modguard');

const { makeZip } = require('./fixtures');

/* ---------- 夹具 ---------- */
const FABRIC = {
  schemaVersion: 1, id: 'testmod', version: '1.0.0', name: 'Test Mod',
  depends: { minecraft: '1.20.x', fabricloader: '>=0.14' }
};
const FABRIC_DUP = JSON.parse(JSON.stringify(FABRIC));
FABRIC_DUP.name = 'Test Mod (重复)';

const FORGE_TOML = `modLoader="javafml"
loaderVersion="[43,)"
[[mods]]
modId="forgeexample"
version="2.1.0"
displayName="Forge Example"
# 一个注释行
[[dependencies.forgeexample]]
    modId="minecraft"
    mandatory=true
    versionRange="[1.20,1.21)"
    ordering="NONE"
    side="BOTH"
[[dependencies.forgeexample]]
    modId="jei"
    mandatory=true
    versionRange="[15.0,)"
    ordering="AFTER"
    side="BOTH"
`;

const NEO_TOML = `modLoader="javafml"
[[mods]]
modId="neoexample"
version="1.2.3"
displayName="Neo Example"
[[dependencies.neoexample]]
    modId="minecraft"
    mandatory=true
    versionRange="[1.20.2,)"
`;

const MCINFO = [{ modList: [{ modid: 'oldmod', name: 'Old Mod', version: '3.0', mcversion: '1.12.2' }] }];

(async () => {
  const root = path.join(os.tmpdir(), 'pl-mod-test');
  fs.rmSync(root, { recursive: true, force: true });
  const gameDir = path.join(root, 'instance');
  const modsDir = path.join(gameDir, 'mods');
  const store = path.join(root, 'store');
  fs.mkdirSync(modsDir, { recursive: true });

  makeZip(path.join(modsDir, 'testmod-1.0.0.jar'), [
    { name: 'fabric.mod.json', data: JSON.stringify(FABRIC) },
    { name: 'dummy.class', data: Buffer.alloc(4096, 7) }
  ]);
  makeZip(path.join(modsDir, 'testmod-duplicate.jar'), [
    { name: 'fabric.mod.json', data: JSON.stringify(FABRIC_DUP) }
  ]);
  makeZip(path.join(modsDir, 'forge-example.jar'), [
    { name: 'META-INF/mods.toml', data: FORGE_TOML }
  ]);
  makeZip(path.join(modsDir, 'neo-example.jar'), [
    { name: 'META-INF/neoforge.mods.toml', data: NEO_TOML }
  ]);
  makeZip(path.join(modsDir, 'old-mod.jar'), [
    { name: 'mcmod.info', data: JSON.stringify(MCINFO) }
  ]);
  // 再放两个 fabric mod，让"多数派"明确是 fabric（真实实例很少出现平票）
  makeZip(path.join(modsDir, 'another-fabric.jar'), [
    { name: 'fabric.mod.json', data: JSON.stringify({ id: 'another', version: '2.0', name: 'Another' }) }
  ]);
  makeZip(path.join(modsDir, 'ze-fabric.jar'), [
    { name: 'fabric.mod.json', data: JSON.stringify({ id: 'zebra', version: '1.1', name: 'Zebra' }) }
  ]);
  // 一个被禁用的 + 一个元数据无法识别的
  makeZip(path.join(modsDir, 'disabled-mod.jar.disabled'), [
    { name: 'fabric.mod.json', data: JSON.stringify({ id: 'sleepy', version: '0.1', name: 'Sleepy' }) }
  ]);
  fs.writeFileSync(path.join(modsDir, 'weird.litemod'), Buffer.alloc(2048, 3));

  console.log('=== 版本区间判定 ===');
  const cases = [
    ['1.20.1', '[1.20,1.21)', true], ['1.21', '[1.20,1.21)', false], ['1.20', '[1.20,1.21)', true],
    ['1.19.4', '[1.20,1.21)', false], ['1.20.1', '1.20.x', true], ['1.21.1', '1.20.x', false],
    ['1.20.4', '[1.20.2,)', true], ['1.20.1', '[1.20.2,)', false],
    ['1.20.1', '>=1.19', true], ['1.18.2', '>=1.19', false],
    ['1.20.1', '1.20.1', true], ['1.20.1', '', true], ['1.20.1', '*', true]
  ];
  let vok = true;
  for (const [mc, r, want] of cases) {
    const got = mg.mcSatisfies(mc, r);
    if (got !== want) { vok = false; console.log('  ✗', mc, r, '=>', got, '期望', want); }
  }
  console.log('版本区间:', vok ? '全部正确 (13/13)' : '有错');

  console.log('\n=== 元数据解析 ===');
  const s = mg.scan({ modsDir });
  for (const m of s.mods) {
    console.log(' ', (m.enabled ? '●' : '○'), m.file.padEnd(30), '| id=' + (m.id || '-').padEnd(14),
      '| v=' + (m.version || '-').padEnd(7), '| loader=' + (m.loader || '-').padEnd(9),
      '| mc=' + (m.mcRange || '-'), m.unknown ? '| 未识别' : '');
  }
  const parsed = s.mods.length === 9 &&
    s.mods.find((m) => m.file === 'testmod-1.0.0.jar').id === 'testmod' &&
    s.mods.find((m) => m.file === 'forge-example.jar').id === 'forgeexample' &&
    s.mods.find((m) => m.file === 'neo-example.jar').loader === 'neoforge' &&
    s.mods.find((m) => m.file === 'old-mod.jar').id === 'oldmod' &&
    s.mods.find((m) => m.file === 'weird.litemod').unknown === true;
  console.log('★ 解析判定:', parsed ? '正确（9 个文件，fabric/forge/neo/legacy/未识别 全部解析）' : '不符预期');

  console.log('\n=== 破坏性变更预检（实例 = fabric 1.20.1）===');
  const a = mg.analyze({ modsDir, mcVersion: '1.20.1', loader: 'fabric' });
  for (const i of a.issues) {
    console.log(' ', i.level === 'error' ? '✖' : i.level === 'warn' ? '!' : 'i',
      i.title.padEnd(12), '|', i.file.padEnd(26), '|', i.detail);
  }
  const cnt = (t) => a.issues.filter((i) => i.title === t).length;
  // neo 要求 [1.20.2,) 、old-mod 要求 1.12.2，两个都真的不满足 1.20.1 -> 版本错应为 2
  const okAnalyze = cnt('载入器不匹配') === 3 && cnt('重复 mod') === 1 &&
                    cnt('依赖缺失') === 1 && cnt('MC 版本不匹配') === 2 && a.hasError;
  console.log('★ 预检判定:', okAnalyze ? '正确（载入器错3/重复1/缺依赖1/版本错2）'
    : `不符预期 -> 载入器${cnt('载入器不匹配')} 重复${cnt('重复 mod')} 缺依赖${cnt('依赖缺失')} 版本${cnt('MC 版本不匹配')}`);

  // 载入器推断：不告诉它实例是什么，让它自己从 mod 里看出多数派
  const auto = mg.analyze({ modsDir, mcVersion: '1.20.1', loader: 'auto' });
  console.log('  自动推断载入器:', auto.loader, '| 推断出', auto.issues.filter((i) => i.title === '载入器不匹配').length, '个装错的');
  const okAuto = auto.loaderInferred === true && auto.loader === 'fabric' &&
                 auto.issues.filter((i) => i.title === '载入器不匹配').length === 3;
  console.log('★ 自动推断判定:', okAuto ? '正确（识别出少数派是装错的）' : '不符预期');

  console.log('\n=== 变更对比 ===');
  const before = mg.scan({ modsDir });
  fs.rmSync(path.join(modsDir, 'old-mod.jar'));
  makeZip(path.join(modsDir, 'testmod-1.0.0.jar'), [
    { name: 'fabric.mod.json', data: JSON.stringify(Object.assign({}, FABRIC, { version: '0.9.0' })) }
  ]);
  makeZip(path.join(modsDir, 'brand-new.jar'), [
    { name: 'fabric.mod.json', data: JSON.stringify({ id: 'brandnew', version: '1.0', name: 'Brand New' }) }
  ]);
  const after = mg.scan({ modsDir });
  const d = mg.diff(before, after);
  console.log('  新增:', d.added.map((m) => m.file).join(', ') || '无');
  console.log('  移除:', d.removed.map((m) => m.file).join(', ') || '无');
  console.log('  更新:', d.updated.map((u) => u.file + ' ' + u.from + '->' + u.to + (u.downgrade ? '(回退)' : '')).join(', ') || '无');
  const okDiff = d.added.length === 1 && d.removed.length === 1 &&
                 d.updated.length === 1 && d.updated[0].downgrade === true;
  console.log('★ 对比判定:', okDiff ? '正确（新增1/移除1/更新1且识别为版本回退）' : '不符预期');

  console.log('\n=== 后悔药：快照 + 回滚 ===');
  const snap1 = await mg.snapshot({ gameDir, storeDir: store, label: '能进游戏的组合' });
  console.log('  快照:', snap1.id, '| 文件', snap1.fileCount, '| 逻辑', (snap1.totalSize / 1024).toFixed(0), 'KB | 实际写入', (snap1.newBytes / 1024).toFixed(0), 'KB');

  // 模拟一次"灾难性更新"：删掉一个 mod，加两个新的
  fs.rmSync(path.join(modsDir, 'testmod-1.0.0.jar'));
  makeZip(path.join(modsDir, 'bad-mod.jar'), [{ name: 'fabric.mod.json', data: JSON.stringify({ id: 'bad', version: '1', name: 'Bad' }) }]);
  console.log('  更新后 mod 数:', mg.scan({ modsDir }).mods.length, '| testmod 存在:', fs.existsSync(path.join(modsDir, 'testmod-1.0.0.jar')));

  const r = await mg.restore({ gameDir, storeDir: store, id: snap1.id });
  const back = mg.scan({ modsDir });
  console.log('  回滚后 mod 数:', back.mods.length, '| testmod 存在:', fs.existsSync(path.join(modsDir, 'testmod-1.0.0.jar')),
    '| bad-mod 残留:', fs.existsSync(path.join(modsDir, 'bad-mod.jar')));
  const st = mg.stats({ storeDir: store, gameDir });
  console.log('  存储:', st.count, '个快照 | 逻辑', (st.logical / 1024).toFixed(0), 'KB | 物理', (st.physical / 1024).toFixed(0), 'KB | 去重比', st.ratio.toFixed(2) + 'x');
  const okRollback = back.mods.length === snap1.fileCount &&
                     fs.existsSync(path.join(modsDir, 'testmod-1.0.0.jar')) &&
                     !fs.existsSync(path.join(modsDir, 'bad-mod.jar'));
  console.log('★ 回滚判定:', okRollback ? '正确（恢复到' + snap1.fileCount + '个 mod，新装的已清掉）' : '不符预期');

  console.log('\n=== 快照命名空间隔离（mods vs 存档）===');
  const saveDir = path.join(root, 'aworld');
  fs.mkdirSync(path.join(saveDir, 'region'), { recursive: true });
  fs.writeFileSync(path.join(saveDir, 'level.dat'), zlib.gzipSync(Buffer.from('x')));
  await require('../savetimemachine').createSnapshot({ saveDir, storeDir: store, label: '存档快照' });
  console.log('  mods 快照数:', mg.listSnapshots({ storeDir: store, gameDir }).length, '(应为 2：手动 + 回滚前自动备份)');
  console.log('  存档快照数:', require('../savetimemachine').listSnapshots({ storeDir: store, world: 'aworld' }).length, '(应为 1)');
  const okNs = mg.listSnapshots({ storeDir: store, gameDir }).length === 2 &&
               require('../savetimemachine').listSnapshots({ storeDir: store, world: 'aworld' }).length === 1;
  console.log('★ 命名空间判定:', okNs ? '正确（互不干扰）' : '不符预期');

  fs.rmSync(root, { recursive: true, force: true });
  console.log('\n临时目录已清理');
})();
