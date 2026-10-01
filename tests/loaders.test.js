/*
 * loaders.js 单测 —— 重点覆盖「Forge 获取失败」那次事故：
 *   1) BMCLAPI 的 maven-metadata.xml 是 2022 年冻结快照，不能作为版本列表唯一来源
 *   2) 列表里若已带 "<mc>-" 前缀，安装时再拼一次会得到 forge-26.2-26.2-65.1.3 → 404
 *   3) 网络失败 vs 该 MC 版本未被支持，必须能区分
 * 纯函数部分离线跑；带网络的部分需 PEBBLE_LIVE=1 才执行。
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const L = require('../loaders');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}
async function ta(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

/* 模拟 maven-metadata.xml（截取官方真实内容片段） */
const FIXTURE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<metadata><groupId>net.minecraftforge</groupId><artifactId>forge</artifactId><versioning>
<versions>
<version>26.2-65.1.3</version>
<version>26.2-65.1.2</version>
<version>26.2-65.0.0</version>
<version>26.1.2-64.1.3</version>
<version>1.21.9-59.0.5</version>
<version>1.20.1-47.4.23</version>
<version>1.20-32.0.108</version>
<version>1.18-38.0.17</version>
</versions></versioning></metadata>`;

(async () => {
  console.log('\n[loaders] 版本号比较');
  t('点分数字比较：1.9 < 1.21 < 26.2', () => {
    assert.ok(L.cmpDotted('1.9', '1.21') < 0);
    assert.ok(L.cmpDotted('1.21', '26.2') < 0);
    assert.ok(L.cmpDotted('65.1.3', '65.0.9') > 0);
  });

  console.log('\n[loaders] maven-metadata 解析');
  t('按 MC 版本精确前缀取构建，并剥掉前缀', () => {
    const r = L.parseForgeMavenVersions(FIXTURE_XML, '26.2');
    assert.deepStrictEqual(r.map(x => x.version), ['65.1.3', '65.1.2', '65.0.0']);
  });
  t('前缀不会串味：1.20 不会命中 1.20.1 的构建', () => {
    const r = L.parseForgeMavenVersions(FIXTURE_XML, '1.20');
    assert.deepStrictEqual(r.map(x => x.version), ['32.0.108']);
  });
  t('1.20.1 取到 47.4.23（不是 1.20 的）', () => {
    const r = L.parseForgeMavenVersions(FIXTURE_XML, '1.20.1');
    assert.deepStrictEqual(r.map(x => x.version), ['47.4.23']);
  });
  t('不存在的 MC 版本返回空数组（= Forge 未发布）', () => {
    assert.deepStrictEqual(L.parseForgeMavenVersions(FIXTURE_XML, '26.3'), []);
  });

  console.log('\n[loaders] Forge 版本号归一化（防双重前缀）');
  t('整串 "26.2-65.1.3" → "65.1.3"', () => {
    assert.strictEqual(L.normalizeForgeVersion('26.2', '26.2-65.1.3'), '65.1.3');
  });
  t('裸号 "65.1.3" 保持不变', () => {
    assert.strictEqual(L.normalizeForgeVersion('26.2', '65.1.3'), '65.1.3');
  });
  t('旧版整串 "1.20.1-47.2.0" → "47.2.0"', () => {
    assert.strictEqual(L.normalizeForgeVersion('1.20.1', '1.20.1-47.2.0'), '47.2.0');
  });
  t('非法版本号 → 空串', () => {
    assert.strictEqual(L.normalizeForgeVersion('26.2', ''), '');
    assert.strictEqual(L.normalizeForgeVersion('26.2', 'abc'), '');
    assert.strictEqual(L.normalizeForgeVersion('26.2', '26.2'), '');
  });

  console.log('\n[loaders] 安装器 URL 组装（回归：不能拼成 26.2-26.2-65.1.3）');
  t('裸号输入得到正确 URL', () => {
    const i = L.forgeInstallerUrls('26.2', '65.1.3');
    assert.strictEqual(i.file, 'forge-26.2-65.1.3-installer.jar');
    assert.strictEqual(i.urls[0],
      'https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/26.2-65.1.3/forge-26.2-65.1.3-installer.jar');
    assert.strictEqual(i.urls[1],
      'https://maven.minecraftforge.net/net/minecraftforge/forge/26.2-65.1.3/forge-26.2-65.1.3-installer.jar');
  });
  t('整串输入也必须得到同一个 URL（历史 bug 点）', () => {
    const i = L.forgeInstallerUrls('26.2', '26.2-65.1.3');
    assert.strictEqual(i.file, 'forge-26.2-65.1.3-installer.jar');
    assert.ok(!i.urls.join(' ').includes('26.2-26.2-'), 'URL 里出现了重复前缀: ' + i.urls[0]);
  });
  t('非法版本返回 null', () => {
    assert.strictEqual(L.forgeInstallerUrls('26.2', ''), null);
  });

  console.log('\n[loaders] promotions 支持的 MC 版本推断');
  t('去重、按版本号升序，末位即最高支持版本', () => {
    const promos = {
      '1.20.1-recommended': '47.4.0', '1.20.1-latest': '47.4.23',
      '26.1.2-latest': '64.1.3', '26.2-recommended': '65.1.3', '26.2-latest': '65.1.3',
      'homepage': 'x'
    };
    const all = L.promosSupportedMc(promos);
    assert.deepStrictEqual(all, ['1.20.1', '26.1.2', '26.2']);
    assert.strictEqual(all[all.length - 1], '26.2');
  });
  t('空 promos 不炸', () => {
    assert.deepStrictEqual(L.promosSupportedMc(null), []);
    assert.deepStrictEqual(L.promosSupportedMc({}), []);
  });

  console.log('\n[loaders] NeoForge 版本前缀映射');
  t('1.21.1 → 21.1', () => assert.deepStrictEqual(L.neoforgeMcPrefix('1.21.1'), ['21.1']));
  t('26.2 → 26.2（新版本号不带 1.）', () => assert.deepStrictEqual(L.neoforgeMcPrefix('26.2'), ['26.2']));
  t('1.20.1 走 Forge 风格的 47.x', () => assert.deepStrictEqual(L.neoforgeMcPrefix('1.20.1'), ['47.', '20.1']));
  t('空值 → 空数组', () => assert.deepStrictEqual(L.neoforgeMcPrefix(''), []));

  console.log('\n[loaders] 预建 launcher_profiles（修复 Fabric/Forge 安装器 “Could not find a valid launcher profile .json”）');
  t('缺失时新建最小合法壳并返回 true', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-prof-'));
    const created = L.ensureLauncherProfiles(tmp);
    assert.strictEqual(created, true);
    const o = JSON.parse(fs.readFileSync(path.join(tmp, 'launcher_profiles.json'), 'utf8'));
    assert.deepStrictEqual(o.profiles, {});
    assert.strictEqual(o.version, 3);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  t('已存在且合法时不动（保护官方启动器配置）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-prof2-'));
    const p = path.join(tmp, 'launcher_profiles.json');
    fs.writeFileSync(p, JSON.stringify({ profiles: { fabric: { name: 'x' } } }));
    const created = L.ensureLauncherProfiles(tmp);
    assert.strictEqual(created, false);
    const o = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.deepStrictEqual(o.profiles, { fabric: { name: 'x' } });
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  t('损坏文件先备份 .bak 再修复', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-prof3-'));
    const p = path.join(tmp, 'launcher_profiles.json');
    fs.writeFileSync(p, '{ not valid json');
    const created = L.ensureLauncherProfiles(tmp);
    assert.strictEqual(created, true);
    assert.ok(fs.existsSync(p + '.bak'), '没生成 .bak 备份');
    const o = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.deepStrictEqual(o.profiles, {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  await ta('Fabric 不再伪造 launcher_profiles.json（改用官方 -noprofile）', async () => {
    // 真因：Fabric 安装器末步 ProfileInstaller.getInstalledLauncherTypes() 只看文件是否存在，
    // 一个都找不到就抛 "Could not find a valid launcher profile .json"。
    // 官方给第三方启动器留了 -noprofile，直接跳过 —— 比伪造一个假 profile 干净。
    // 不联网：javaBin 传 null，会在下载前就抛 Java 错误；installLoader 是 async，
    // 同步 throw 会被包成 rejected Promise，必须 await + try/catch 才抓得到。
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-prof4-'));
    let threw = '';
    try {
      await L.installLoader({ loader: 'fabric', mcDir: tmp, mcVersion: '26.2', version: '0.19.5', javaBin: null }, () => {});
    } catch (e) { threw = e.message; }
    assert.ok(/Java/.test(threw), '预期因缺少 Java 报错，实际: ' + threw);
    assert.ok(!fs.existsSync(path.join(tmp, 'launcher_profiles.json')),
      'Fabric 不该再去动 launcher_profiles.json');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  console.log('\n[loaders] 安装器 CLI 参数契约（Fabric launcher profile 报错的修复）');

  // 1:1 复刻 fabric-installer 的 ArgumentParser（Java 侧 util/ArgumentParser.java）：
  //   - "-xxx" → key 去掉前导 -；下一个 token 若不以 "-" 开头，会被吃成它的值
  //   - key 重复直接抛 "Argument x already passed"
  //   - has(key) 等价于 containsKey
  function parseInstallerArgs(argv) {
    const map = new Map();
    for (let i = 0; i < argv.length; i++) {
      if (argv[i].startsWith('-')) {
        const key = argv[i].slice(1);
        let value = null;
        if (i + 1 < argv.length) {
          value = argv[i + 1];
          if (value.startsWith('-')) { map.set(key, ''); continue; }
          i++;
        }
        if (map.has(key)) throw new Error('Argument ' + key + ' already passed');
        map.set(key, value);
      }
    }
    return map;
  }
  // args 前两位是 java 自己的 -jar <path>，不属于安装器参数
  const instArgs = (loader) => parseInstallerArgs(L.loaderCliArgs({
    loader, jarPath: 'C:/x/installer.jar',
    mcDir: 'C:/Users/Felix/AppData/Roaming/.minecraft', mcVersion: '26.2', version: '0.19.5'
  }).slice(2));

  t('Fabric 必须带 -noprofile', () => {
    assert.ok(instArgs('fabric').has('noprofile'), '缺 -noprofile，末步必抛 launcher profile 报错');
  });
  t('-noprofile 必须排在最后（无值 flag 后不能跟裸 token）', () => {
    const args = L.loaderCliArgs({ loader: 'fabric', jarPath: 'x.jar', mcDir: 'D:/mc', mcVersion: '26.2', version: '0.19.5' });
    assert.strictEqual(args[args.length - 1], '-noprofile', '实际: ' + args.join(' '));
  });
  t('Fabric 的 -dir/-mcversion/-loader 都解析正确，没被吞掉', () => {
    const m = instArgs('fabric');
    assert.strictEqual(m.get('dir'), 'C:/Users/Felix/AppData/Roaming/.minecraft');
    assert.strictEqual(m.get('mcversion'), '26.2');
    assert.strictEqual(m.get('loader'), '0.19.5');
  });
  t('参数键不重复（重复会让 ArgumentParser 直接抛异常）', () => {
    for (const loader of ['fabric', 'quilt', 'forge', 'neoforge']) instArgs(loader); // 重复键在此抛
  });
  t('Quilt 走 --no-profile', () => {
    assert.ok(L.loaderCliArgs({ loader: 'quilt', jarPath: 'q.jar', mcDir: 'D:/mc', mcVersion: '26.2', version: '0.1' }).includes('--no-profile'));
  });
  t('只有 forge/neoforge 需要预建 launcher_profiles.json', () => {
    assert.ok(L.PROFILE_REQUIRED.has('forge') && L.PROFILE_REQUIRED.has('neoforge'));
    assert.ok(!L.PROFILE_REQUIRED.has('fabric') && !L.PROFILE_REQUIRED.has('quilt'),
      'Fabric/Quilt 有跳过开关，不该去动用户真实的 .minecraft');
  });
  t('未知加载器直接抛错', () => {
    assert.throws(() => L.loaderCliArgs({ loader: 'nope', jarPath: 'x', mcDir: 'D:/mc' }), /不支持/);
  });

  /* ---------- 以下需要网络 ---------- */
  const LIVE = process.env.PEBBLE_LIVE === '1' || process.argv.includes('--live');
  if (!LIVE) {
    console.log('\n[loaders] 网络用例已跳过（node tests/loaders.test.js --live 开启）');
  } else {
    console.log('\n[loaders] 联网：Forge 版本列表');
    await ta('MC 26.2 → 拿到版本列表，含 65.1.3 且标了标签', async () => {
      const r = await L.forgeVersions('26.2');
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.ok(r.list.length > 0, '列表为空');
      assert.ok(r.list.some(x => x.version === '65.1.3'), '缺 65.1.3');
      assert.ok(r.list.every(x => !String(x.version).includes('-')), '版本号里不该带 MC 前缀');
      assert.ok(r.list.some(x => x.tag), '没有任何推荐/最新标记');
    });
    await ta('MC 26.3（Forge 未发布）→ ok:true 但空列表 + unsupported', async () => {
      const r = await L.forgeVersions('26.3');
      assert.strictEqual(r.ok, true, '空列表不该报网络错: ' + JSON.stringify(r));
      assert.strictEqual(r.list.length, 0);
      assert.strictEqual(r.reason, 'unsupported');
      assert.ok(r.forgeLatestMc, '没给出最高支持版本');
      assert.ok(/未.*发布|未找到/.test(r.message), '提示文案不对: ' + r.message);
    });
    await ta('MC 1.20.1（老版本）也能取到列表', async () => {
      const r = await L.forgeVersions('1.20.1');
      assert.ok(r.list.length > 0, '列表为空');
    });
    await ta('空 MC 版本 → ok:false', async () => {
      const r = await L.forgeVersions('');
      assert.strictEqual(r.ok, false);
    });
    await ta('Fabric 列表不止 1 项，且首项标了稳定', async () => {
      const list = await L.fabricLoaderVersions();
      assert.ok(list.length > 1, '只剩 ' + list.length + ' 项');
      assert.ok(list.every(x => x.version), '版本号缺失');
      assert.ok(list[0].tag === '稳定', '最新 loader 没标稳定: ' + JSON.stringify(list[0]));
    });
    await ta('NeoForge 26.2 能取到 26.2.0.x（旧正则会漏）', async () => {
      const list = await L.neoforgeVersions('26.2');
      assert.ok(list.length > 0, '列表为空');
      assert.ok(list.every(v => v.startsWith('26.2.')), '混进了别的版本: ' + list.slice(0, 3));
    });
    await ta('Quilt / OptiFine 列表非空', async () => {
      assert.ok((await L.quiltLoaderVersions()).length > 0, 'Quilt 为空');
      assert.ok((await L.optifineVersions('1.20.1')).length > 0, 'OptiFine 为空');
    });

    // 真去下载安装器（javaBin 故意给个不存在的路径，只验证下载这一段）
    await ta('安装器 URL 真实可用（下载到 ~7MB 的 jar，而不是 404）', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-loader-'));
      const logs = [];
      let err = '';
      try {
        await L.installLoader({
          loader: 'forge', mcDir: tmp, mcVersion: '26.2', version: '65.1.3',
          javaBin: path.join(tmp, 'no-such-java.exe')
        }, (s) => logs.push(s));
      } catch (e) { err = e.message; }
      const jar = path.join(tmp, 'pl-temp', 'forge-26.2-65.1.3-installer.jar');
      const ok = fs.existsSync(jar) && fs.statSync(jar).size > 1024 * 1024;
      fs.rmSync(tmp, { recursive: true, force: true });
      assert.ok(ok, '安装器没下下来。日志: ' + logs.join(' | ') + ' 错误: ' + err);
      assert.ok(!/下载失败/.test(err), '下载阶段失败: ' + err);
      assert.ok(/java|启动安装器/.test(err), '预期是 Java 启动失败，实际: ' + err);
    });

    await ta('安装器 URL：UI 传整串也不会拼成 26.2-26.2-x（404）', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-loader2-'));
      const logs = [];
      let err = '';
      try {
        await L.installLoader({
          loader: 'forge', mcDir: tmp, mcVersion: '26.2', version: '26.2-65.1.3',
          javaBin: path.join(tmp, 'no-such-java.exe')
        }, (s) => logs.push(s));
      } catch (e) { err = e.message; }
      const jar = path.join(tmp, 'pl-temp', 'forge-26.2-65.1.3-installer.jar');
      const ok = fs.existsSync(jar) && fs.statSync(jar).size > 1024 * 1024;
      fs.rmSync(tmp, { recursive: true, force: true });
      assert.ok(ok, '整串输入导致下载失败: ' + err + ' | ' + logs.join(' | '));
      assert.ok(!/26\.2-26\.2-/.test(String(err)), 'URL 出现重复前缀: ' + err);
    });
  }

  console.log(`\n[loaders] 通过 ${pass} 项，失败 ${fail} 项\n`);
  process.exit(fail ? 1 : 0);
})();
