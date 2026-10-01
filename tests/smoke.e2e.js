// 端到端冒烟：在真实 Electron 里加载 index.html，验证 IPC 与 UI 容器可用
// 运行（必须在项目根目录，main.js 里的 loadFile 用的是相对路径）：
//   node_modules\electron\dist\electron.exe tests\smoke.e2e.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 无头环境下 GPU 进程会直接崩掉并连累整个 app，先关掉
for (const s of ['disable-gpu', 'disable-gpu-compositing', 'disable-software-rasterizer', 'no-sandbox']) {
  app.commandLine.appendSwitch(s);
}

const { makeZip, fakePng } = require('./fixtures');

// Electron 在 Windows 是 GUI 子系统程序，父进程重定向 stdout 拿不到它的输出，
// 所以这里把所有 console 输出同步落盘一份，由 SMOKE_LOG 指定路径。
const SMOKE_LOG = process.env.SMOKE_LOG || path.join(os.tmpdir(), 'pl-smoke.log');
try { fs.writeFileSync(SMOKE_LOG, ''); } catch {}
const _log = console.log.bind(console);
const _err = console.error.bind(console);
const _sink = (s) => { try { fs.appendFileSync(SMOKE_LOG, s + '\n'); } catch {} };
console.log = (...a) => { _sink(a.map(String).join(' ')); _log(...a); };
console.error = (...a) => { _sink('[err] ' + a.map(String).join(' ')); _err(...a); };
console.log('smoke log: ' + SMOKE_LOG);

// 造一个假实例：mods 目录 + 一个存档 + 资源包 + 一个 fabric 版本 JSON
function fixture() {
  const root = path.join(os.tmpdir(), 'pl-smoke-instance');
  fs.rmSync(root, { recursive: true, force: true });
  const mods = path.join(root, 'mods');
  fs.mkdirSync(mods, { recursive: true });
  fs.writeFileSync(path.join(mods, 'fake.jar'), Buffer.alloc(1024, 1));

  // 资源包：一个 zip 包 + 一个未解压目录（后者以前会被列表整个吞掉）
  const rp = path.join(root, 'resourcepacks');
  fs.mkdirSync(rp, { recursive: true });
  makeZip(path.join(rp, 'smoke-pack.zip'), [
    { name: 'pack.mcmeta', data: JSON.stringify({ pack: { pack_format: 12, description: '冒烟用材质包' } }) },
    { name: 'pack.png', data: fakePng() }
  ]);
  const dirPack = path.join(rp, 'UnzippedPack');
  fs.mkdirSync(dirPack, { recursive: true });
  fs.writeFileSync(path.join(dirPack, 'pack.mcmeta'),
    JSON.stringify({ pack: { pack_format: 9, description: '目录材质包' } }));

  const save = path.join(root, 'saves', 'TestWorld');
  fs.mkdirSync(path.join(save, 'region'), { recursive: true });
  fs.writeFileSync(path.join(save, 'level.dat'), require('zlib').gzipSync(Buffer.from('x')));
  fs.writeFileSync(path.join(save, 'region', 'r.0.0.mca'), Buffer.alloc(8192));

  const mcDir = path.join(root, 'mc');
  const vdir = path.join(mcDir, 'versions', 'fabric-loader-0.15.7-1.20.1');
  fs.mkdirSync(vdir, { recursive: true });
  fs.writeFileSync(path.join(vdir, 'fabric-loader-0.15.7-1.20.1.json'),
    JSON.stringify({ id: 'fabric-loader-0.15.7-1.20.1', inheritsFrom: '1.20.1' }));
  const bdir = path.join(mcDir, 'versions', '1.20.1');
  fs.mkdirSync(bdir, { recursive: true });
  fs.writeFileSync(path.join(bdir, '1.20.1.json'), JSON.stringify({ id: '1.20.1' }));
  return { root, save, mcDir, rp, version: 'fabric-loader-0.15.7-1.20.1' };
}

// 必须加载真实的 main.js —— IPC 处理器是在那里注册的，
// 自己 new 一个 BrowserWindow 是测不到 ipcMain 那半边的。
require('../main');

(async () => {
  try { app.disableHardwareAcceleration(); } catch {}
  await app.whenReady();

  const fx = fixture();

  // 用 main.js 建好的那个窗口（它已经加载了 index.html + 真实 preload）
  await new Promise((r) => setTimeout(r, 1500));
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) throw new Error('主窗口未创建');
  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg); });
  win.webContents.on('did-fail-load', (_e, code, desc) => errors.push('load fail: ' + desc));
  await new Promise((r) => setTimeout(r, 800));

  const dom = await win.webContents.executeJavaScript(`(() => {
    const has = (k) => typeof (window.api && window.api[k]) === 'function';
    return {
      apiType: typeof window.api,
      apiCount: Object.keys(window.api || {}).length,
      newIpc: ['saveTmList','saveTmCreate','saveTmRestore','saveTmDelete','saveTmGc','saveTmStats','saveHealth',
               'modAnalyze','modSnapshot','modSnapList','modRestore','modSnapDelete','modStats','modDiffLatest',
               'resolveMcVersion','tmDir','packInfo','modMeta',
               'storeSearch','storeMcVersions','storeDetails','storeVersions','storeInstall',
               'storeImage','storeLocalHashes','storeKeyStatus','storeKeySet','onStoreProgress',
               'instList','instActive','instGet','instSetActive','instCreate','instDuplicate',
               'instUpdate','instRemove','instCopyable','instOpen',
               'migDetect','migInspect','migScan','migImport',
               'avGet','avBatch','avClear','avCacheSize',
               'mlList','mlStop','mlStopAll','mlBusy','onMlChanged',
               'labPresets','labMemAdvice','labRun','labHistory','labSummary',
               'labCompare','labClear','onLabProgress'].filter(k => !has(k)),
      pages: document.querySelectorAll('.page').length,
      hasModal: !!document.getElementById('modal'),
      hasGuard: !!document.getElementById('mod-guard'),
      hasMgScan: !!document.getElementById('mg-scan'),
      hasInsList: !!document.getElementById('ins-list'),
      hasInstSelect: !!document.getElementById('inst-select'),
      hasMigFound: !!document.getElementById('mig-found'),
      hasAccList: !!document.getElementById('acc-list'),
      hasMlList: !!document.getElementById('ml-list'),
      hasLab: !!document.getElementById('lab-a') && !!document.getElementById('lab-history'),
      segs: document.querySelectorAll('.seg').length,
      storeBars: document.querySelectorAll('.store-bar').length,
      storeGrids: document.querySelectorAll('.store-grid').length
    };
  })()`);
  console.log('DOM/IPC:', JSON.stringify(dom));

  // 真跑一遍新增 IPC
  const r1 = await win.webContents.executeJavaScript(`window.api.resolveMcVersion(${JSON.stringify(fx.mcDir)}, ${JSON.stringify(fx.version)})`);
  console.log('resolve-mc-version:', JSON.stringify(r1));

  const r2 = await win.webContents.executeJavaScript(`window.api.modAnalyze(${JSON.stringify(fx.root)}, ${JSON.stringify(r1.mc || '')}, 'auto')`);
  console.log('mod-analyze:', JSON.stringify({ ok: r2.ok, mods: (r2.mods || []).length, issues: (r2.issues || []).length }));

  const r3 = await win.webContents.executeJavaScript(`window.api.saveHealth(${JSON.stringify(fx.save)})`);
  console.log('save-health:', JSON.stringify({ ok: r3.ok, files: r3.scannedFiles, chunks: r3.chunkTotal }));

  const r4 = await win.webContents.executeJavaScript(`window.api.modSnapshot(${JSON.stringify(fx.root)}, '冒烟测试')`);
  console.log('mod-snapshot:', JSON.stringify({ ok: r4.ok, files: r4.snap && r4.snap.fileCount }));

  const r5 = await win.webContents.executeJavaScript(`window.api.saveTmCreate(${JSON.stringify(fx.save)}, '冒烟测试')`);
  console.log('save-tm-create:', JSON.stringify({ ok: r5.ok, files: r5.snap && r5.snap.fileCount }));

  const r6 = await win.webContents.executeJavaScript(`window.api.saveTmList(${JSON.stringify(fx.save)}).then(l => l.length)`);
  console.log('save-tm-list count:', r6);

  const r7 = await win.webContents.executeJavaScript(`window.api.modDiffLatest(${JSON.stringify(fx.root)})`);
  console.log('mod-diff-latest:', JSON.stringify({ ok: r7.ok, hasBase: r7.hasBase, added: (r7.diff && r7.diff.added || []).length }));

  // 未解压的资源包目录必须出现在列表里（原来会被吞掉）
  const r8 = await win.webContents.executeJavaScript(`window.api.listResourcepacks(${JSON.stringify(fx.root)})`);
  console.log('list-resourcepacks:', JSON.stringify(r8.map((x) => ({ n: x.name, dir: !!x.isDir }))));

  const r9 = await win.webContents.executeJavaScript(
    `window.api.packInfo(${JSON.stringify(r8.map((x) => x.path))}, 'rps', ${JSON.stringify(r1.mc || '')})`);
  console.log('pack-info:', JSON.stringify((r9.items || []).map((x) => ({
    n: x.name, fmt: x.format, mc: x.mc, compat: x.compat, icon: !!x.icon, desc: x.desc
  }))));

  const r10 = await win.webContents.executeJavaScript(
    `window.api.modMeta(${JSON.stringify(fx.root + '/mods')})`);
  console.log('mod-meta:', JSON.stringify({ ok: r10.ok, mods: (r10.mods || []).map((m) => m.name) }));

  // 在线仓库：真连一次 Modrinth（不配 CF key，验证"只出 MR + 明确报错"的行为）
  const r11 = await win.webContents.executeJavaScript(`window.api.storeMcVersions()`);
  console.log('store-mc-versions:', JSON.stringify({ ok: r11.ok, n: (r11.versions || []).length, top: (r11.versions || []).slice(0, 3) }));

  const r12 = await win.webContents.executeJavaScript(
    `window.api.storeSearch({kind:'mods', query:'sodium', source:'modrinth', limit:3, destDir: ${JSON.stringify(fx.root + '/mods')}})`);
  console.log('store-search:', JSON.stringify({
    ok: r12.ok, n: (r12.items || []).length, errs: (r12.errors || []).length,
    first: (r12.items || [])[0] && { t: (r12.items || [])[0].title, d: (r12.items || [])[0].downloadsText }
  }));

  const first = (r12.items || [])[0];
  if (first) {
    const r13 = await win.webContents.executeJavaScript(
      `window.api.storeDetails({source:'modrinth', id: ${JSON.stringify(first.id)}})`);
    console.log('store-details:', JSON.stringify({
      ok: r13.ok, title: r13.project && r13.project.title,
      bodyLen: (r13.project && r13.project.body || '').length,
      gallery: (r13.project && r13.project.gallery || []).length
    }));

    const r14 = await win.webContents.executeJavaScript(
      `window.api.storeVersions({source:'modrinth', id: ${JSON.stringify(first.id)}})`);
    console.log('store-versions:', JSON.stringify({
      ok: r14.ok, n: (r14.versions || []).length,
      hasFile: !!(r14.versions || [])[0] && !!(r14.versions || [])[0].file && !!(r14.versions || [])[0].file.url
    }));

    const r15 = await win.webContents.executeJavaScript(
      `window.api.storeImage(${JSON.stringify(first.icon)})`);
    console.log('store-image:', JSON.stringify({ ok: r15.ok, isData: String(r15.data || '').startsWith('data:image/') }));
  }

  const r16 = await win.webContents.executeJavaScript(`window.api.storeKeyStatus()`);
  console.log('store-key-status:', JSON.stringify(r16));

  const r17 = await win.webContents.executeJavaScript(
    `window.api.storeSearch({kind:'mods', query:'jei', source:'curseforge', limit:3})`);
  console.log('store-search(CF 无key):', JSON.stringify({ items: (r17.items || []).length, errs: r17.errors }));

  const r18 = await win.webContents.executeJavaScript(`window.api.storeLocalHashes(${JSON.stringify(fx.root + '/mods')})`);
  console.log('store-local-hashes:', JSON.stringify({ n: (r18.hashes || []).length }));

  // 真实下载一个文件到 mods 目录，验证「自动装进游戏目录」
  if (first) {
    const vs = await win.webContents.executeJavaScript(
      `window.api.storeVersions({source:'modrinth', id: ${JSON.stringify(first.id)}})`);
    const v = (vs.versions || []).find((x) => x.file && x.file.url && x.file.sha1);
    if (v) {
      const r19 = await win.webContents.executeJavaScript(`window.api.storeInstall(${
        JSON.stringify({ source: 'modrinth', id: first.id, url: v.file.url, name: v.file.name,
          sha1: v.file.sha1, size: v.file.size, destDir: fx.root + '/mods', key: 'k1' })
      })`);
      console.log('store-install:', JSON.stringify({ ok: r19.ok, file: r19.file && require('path').basename(r19.file), bytes: r19.bytes }));
      const mods = await win.webContents.executeJavaScript(`window.api.listMods(${JSON.stringify(fx.root)})`);
      console.log('安装后 mods 目录:', JSON.stringify(mods.map((m) => m.name)));
      // 再装一次，应走 sha1 命中跳过
      const r20 = await win.webContents.executeJavaScript(`window.api.storeInstall(${
        JSON.stringify({ source: 'modrinth', id: first.id, url: v.file.url, name: v.file.name,
          sha1: v.file.sha1, size: v.file.size, destDir: fx.root + '/mods', key: 'k2' })
      })`);
      console.log('重复安装:', JSON.stringify({ ok: r20.ok, skipped: !!r20.skipped }));
    }
  }

  // 真的把资源页建起来并切到「在线仓库」，验证分页 + 卡片渲染（不只是 IPC 能通）
  const ui1 = await win.webContents.executeJavaScript(`(async () => {
    window.Pages.refreshRes('mods');
    await new Promise(r => setTimeout(r, 300));
    const el = document.querySelector('.res-page[data-kind="mods"]');
    const seg = el.querySelector('.seg button[data-tab="store"]');
    seg.click();
    await new Promise(r => setTimeout(r, 4000));
    return {
      segs: document.querySelectorAll('.seg').length,
      storeBars: document.querySelectorAll('.store-bar').length,
      mcOptions: el.querySelectorAll('.store-sel[data-f=mc] option').length,
      cards: el.querySelectorAll('.store-card').length,
      firstCard: (el.querySelector('.store-card .store-title') || {}).textContent || '',
      iconsLoaded: el.querySelectorAll('.store-card img.store-icon').length,
      srcTags: el.querySelectorAll('.store-card .src-tag').length
    };
  })()`);
  console.log('在线仓库 UI:', JSON.stringify(ui1));

  /* ---- 实例与迁移：真的建一个实例、真的扫一次内容 ----
   * 注意：实例表存在真实 userData 里，会跨次残留，
   * 所以实例名带时间戳、结束后必须清理，否则第二次跑就会撞「已存在使用该目录的实例」。
   */
  const ins = await win.webContents.executeJavaScript(`(async () => {
    const root = ${JSON.stringify(fx.root)};
    const tag = '冒烟实例-' + Date.now();
    const list0 = await window.api.instList(${JSON.stringify(fx.mcDir)}, 'fabric-loader-0.15.7-1.20.1');
    const before = list0.instances.length;
    const out = { before, err: '' };
    let made = null, dup = null;
    try {
      made = await window.api.instCreate({
        name: tag, version: '1.20.1',
        copyFrom: [root], items: ['mods', 'saves']
      });
      if (!made || !made.id) throw new Error('instCreate 返回异常: ' + JSON.stringify(made));
      const list1 = await window.api.instList(${JSON.stringify(fx.mcDir)}, '1.20.1');
      const act = await window.api.instActive(${JSON.stringify(fx.mcDir)}, false, '1.20.1');
      const scan = await window.api.migScan(root);
      const found = await window.api.migDetect();
      dup = await window.api.instDuplicate({ id: made.id, name: tag + '副本', items: ['mods'] });
      const rm = await window.api.instRemove(dup.id, true);
      dup = null;
      out.after = list1.instances.length;
      out.madeName = made.name;
      out.switched = act.inst && act.inst.id;
      out.scanExists = scan && (scan.items || scan).exists;
      out.scanMods = scan && ((scan.items || scan).counts || {}).mods;
      out.foundLaunchers = Array.isArray(found) ? found.length : ((found.items || []).length);
      out.dupOk = true; out.rmOk = rm && rm.ok;
    } catch (e) { out.err = e.message; }
    // 清理：删掉本次造的实例，并把激活项还给原来第一个，保证下次跑干净
    if (dup && dup.id) { try { await window.api.instRemove(dup.id, true); } catch {} }
    if (made && made.id) { try { await window.api.instRemove(made.id, true); } catch {} }
    try {
      const rest = await window.api.instList(${JSON.stringify(fx.mcDir)}, '1.20.1');
      const first = (rest.instances || [])[0];
      if (first) await window.api.instSetActive(first.id);
    } catch {}
    return out;
  })()`);
  console.log('实例/迁移:', JSON.stringify(ins));

  /* ---- 加载器：端到端复现并验证「Forge 获取失败」的修复 ----
   * 回归点：① downloader 少导出 downloadFile/fetchJson 导致全部加载器查询 TypeError
   *        ② BMCLAPI 的 forge maven-metadata.xml 是 2022 冻结快照 → 1.19+ 永远空列表
   *        ③ 列表若带 "<mc>-" 前缀，安装时会拼成 forge-26.2-26.2-x → 404
   */
  const ld = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const out = {};
    out.forge26_2 = await window.api.loaderVersions('forge', '26.2');
    out.forge26_3 = await window.api.loaderVersions('forge', '26.3');
    out.fabric   = await window.api.loaderVersions('fabric', '1.20.1');
    out.optifine = await window.api.loaderVersions('optifine', '1.20.1');
    // 真跑一遍 UI
    document.getElementById('loader-kind').value = 'forge';
    document.getElementById('loader-mc').value = '26.2';
    window.Pages.loadLoaderVersions();
    await sleep(6000);
    out.uiOpts = [...document.getElementById('loader-ver').options].map(o => o.value + ' | ' + o.textContent).slice(0, 3);
    // 切到 Forge 尚未支持的版本：必须是「暂无可用版本 + 一键改用建议」
    document.getElementById('loader-mc').value = '26.3';
    window.Pages.loadLoaderVersions();
    await sleep(6000);
    out.uiEmpty = document.getElementById('loader-ver').options[0].textContent;
    out.uiHint = (document.getElementById('loader-hint').textContent || '').trim();
    return out;
  })()`);
  console.log('加载器:', JSON.stringify({
    forge26_2: { ok: ld.forge26_2.ok, n: (ld.forge26_2.list || []).length, top: (ld.forge26_2.list || [])[0] },
    forge26_3: { ok: ld.forge26_3.ok, n: (ld.forge26_3.list || []).length, reason: ld.forge26_3.reason, msg: ld.forge26_3.message },
    fabric: (ld.fabric.list || []).length,
    optifine: { ok: ld.optifine.ok, n: (ld.optifine.list || []).length },
    uiOpts: ld.uiOpts, uiEmpty: ld.uiEmpty, uiHint: ld.uiHint
  }));

  /* 硬断言：这几条挂了就说明「Forge 获取失败」又回来了 */
  const ldBad = [];
  if (!(ld.forge26_2.list || []).length) ldBad.push('Forge 26.2 版本列表为空');
  if (!(ld.forge26_2.list || []).some((x) => x && x.tag)) ldBad.push('Forge 26.2 没有推荐/最新标记');
  if (ld.forge26_3.reason !== 'unsupported') ldBad.push('Forge 26.3 未标记 unsupported');
  if (!ld.forge26_3.forgeLatestMc) ldBad.push('Forge 26.3 没给出最高支持版本');
  if (!(ld.fabric.list || []).length) ldBad.push('Fabric 版本列表为空');
  if (/获取失败/.test(ld.uiOpts.join(' '))) ldBad.push('UI 下拉仍是「获取失败」');
  if (ld.uiHint && ld.uiHint.includes('获取失败')) ldBad.push('UI 提示文案没区分「未支持」与「网络失败」');
  if (ld.uiOpts.length && !ld.forge26_3.forgeLatestMc) ldBad.push('空列表时没给一键改用按钮');

  /* ---- 多账户 + 并行 + JVM 实验室：IPC 真跑一遍 + UI 真渲染一遍 ----
   * labRun 会真的启动游戏，这里不跑；能验的是「配置面」全链路：
   * 预设按 Java 版本过滤、内存建议、账户列表 UI、多开面板、历史聚合。
   */
  const six = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const out = {};
    // 1) 预设：Java 8 必须把 ZGC 标为不支持，Java 21 可用
    const p8 = await window.api.labPresets(8);
    const p21 = await window.api.labPresets(21);
    out.presets = { n: (p21.presets || []).length,
      zgc8: (p8.presets || []).find(p => p.id === 'zgc').supported,
      zgc21: (p21.presets || []).find(p => p.id === 'zgc').supported };
    // 2) 内存建议
    const adv = await window.api.labMemAdvice();
    out.mem = { totalGB: adv.totalGB, recommendGB: adv.recommendGB, saneMaxGB: adv.saneMaxGB };
    // 3) 多账户：连续添加两个账户，列表必须同时留住
    //    （旧 bug：saveAcc 只写当前账户，第二次登录会把前一个从磁盘抹掉）
    const a1 = await window.api.accountOffline('冒烟甲');
    const a2 = await window.api.accountOffline('冒烟乙');
    window.PL.upsertAccount(a1);
    window.PL.upsertAccount(a2);
    const l2 = await window.api.accountStoreLoad();
    out.accounts = { after: ((l2.data || {}).accounts || []).length, active: (l2.data || {}).activeId === a2.uuid };
    out.plAccounts = (window.PL.accounts || []).length;
    // 4) UI：账户列表真的渲染出卡片
    await window.Pages.refreshAccounts();
    await sleep(300);
    out.accCards = document.querySelectorAll('#acc-list .acc-card').length;
    // 用完清掉，别把冒烟账户留在真实 userData 里
    window.PL.removeAccount(a1.uuid);
    window.PL.removeAccount(a2.uuid);
    window.PL.saveAcc();
    // 5) 多开面板（没在跑游戏，应当是空态而不是报错）
    await window.Pages.refreshMulti();
    await sleep(200);
    const ml = await window.api.mlList();
    out.ml = { items: (ml.items || []).length, emptyHint: !!document.querySelector('#ml-list .empty') };
    // 6) 实验室页：初始化 + 历史
    await window.Pages.initLab();
    await sleep(300);
    out.lab = {
      options: document.getElementById('lab-a').options.length,
      advice: (document.getElementById('lab-advice').textContent || '').trim().slice(0, 40)
    };
    const sum = await window.api.labSummary();
    out.history = (sum.rows || []).length;
    return out;
  })()`);
  console.log('多账户/多开/实验室:', JSON.stringify(six));

  const sixBad = [];
  if (!six.presets.n) sixBad.push('实验室没有可用预设');
  if (six.presets.zgc8 !== false) sixBad.push('Java 8 上 ZGC 应标为不支持');
  if (six.presets.zgc21 !== true) sixBad.push('Java 21 上 ZGC 应可用');
  if (!(six.mem.recommendGB > 0) || six.mem.saneMaxGB < 2) sixBad.push('内存建议异常');
  if (!(six.accounts.after >= 2)) sixBad.push('多账户被覆盖（存盘只有 1 个）: ' + JSON.stringify(six.accounts));
  if (!six.accounts.active) sixBad.push('activeId 没跟着最新一次 upsert 走');
  if (!(six.plAccounts >= 2)) sixBad.push(' renderer 内的账户列表没留住两个');
  if (!six.accCards) sixBad.push('账户列表没有渲染出卡片');
  if (!six.ml.emptyHint) sixBad.push('多开面板空态提示缺失');
  if (six.lab.options < 2) sixBad.push('实验室预设下拉没填充');
  if (!six.lab.advice) sixBad.push('实验室没给出内存建议');

  /* ---- 关键路径强化：13 页导航 + 关于页版本 + 设置读写 + 截图整理 + 启动 IPC ----
   * 直接对应发版前最该保住的用户路径。GUI 子进程在 CI 沙箱里跑不了，
   * 但这些断言保留，在真机 `npm run test:e2e` 时生效。
   * 注意：executeJavaScript 跑在渲染进程（无 fs/path），临时目录在 Node 侧建好再传路径。
   */
  const shotsDir = path.join(os.tmpdir(), 'pl-smoke-shots');
  try { fs.mkdirSync(shotsDir, { recursive: true }); } catch {}
  const harden = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const out = { navCount: 0, visited: 0, aboutVersion: '', settings: {}, shots: {}, launch: false };
    // 1) 遍历所有导航项（13 个功能页），每一项都必须能切到对应 .page
    const navBtns = [...document.querySelectorAll('.nav-item')];
    out.navCount = navBtns.length;
    for (const b of navBtns) {
      try { b.click(); } catch {}
      await sleep(120);
      const active = document.querySelector('.page.active') || document.querySelector('.page:not(.hidden)');
      if (active) out.visited++;
    }
    // 2) 关于页：必须渲染出当前版本（发版改成 V3 后应为 3.0.0）
    const aboutBtn = [...document.querySelectorAll('.nav-item')].find(b => (b.getAttribute('data-page') || '') === 'about');
    if (aboutBtn) { aboutBtn.click(); await sleep(300); }
    const ab = document.querySelector('.page.active');
    const m = ((ab && ab.innerText) || document.body.innerText).match(/\\d+\\.\\d+\\.\\d+/);
    out.aboutVersion = m ? m[0] : '';
    // 3) 设置读写：通过 window.PL.cfg + saveCfg 写一项再读回（用完还原）
    try {
      const k = '__smokeProbe__';
      const v0 = window.PL.cfg ? window.PL.cfg[k] : undefined;
      out.settings.hasCfg = !!window.PL.cfg;
      out.settings.hasSave = typeof window.PL.saveCfg === 'function';
      if (window.PL.cfg) {
        window.PL.cfg[k] = 'v3-ok';
        if (window.PL.saveCfg) window.PL.saveCfg();
        await sleep(150);
        out.settings.wrote = window.PL.cfg[k];
        window.PL.cfg[k] = v0;
        if (window.PL.saveCfg) window.PL.saveCfg();
        out.settings.restored = window.PL.cfg[k];
      }
    } catch (e) { out.settings.err = String(e); }
    // 4) 截图整理：调用 IPC（无图也应收得到一个结果对象，而不是抛错）
    try {
      const r = await window.api.shotsOrganize(${JSON.stringify(shotsDir)}, 'month');
      out.shots.result = r && typeof r === 'object' ? Object.keys(r).length : -1;
    } catch (e) { out.shots.err = String(e); }
    // 5) 启动 IPC：能力必须存在；不真启动游戏（太重），只验证入口
    out.launch = typeof window.api.launch === 'function';
    return out;
  })()`);
  console.log('关键路径:', JSON.stringify(harden));

  const hardenBad = [];
  if (!harden.navCount || harden.navCount < 13) hardenBad.push('导航项不足 13 个: ' + harden.navCount);
  if (harden.visited !== harden.navCount) hardenBad.push('存在无法切换的页面（visited ' + harden.visited + ' / ' + harden.navCount + '）');
  if (!/^3\\.0\\.0$/.test(harden.aboutVersion || '')) hardenBad.push('关于页版本未显示 3.0.0: ' + harden.aboutVersion);
  if (!harden.settings.hasCfg || !harden.settings.hasSave) hardenBad.push('设置读写能力缺失（cfg/saveCfg）');
  if (harden.settings.wrote !== 'v3-ok') hardenBad.push('设置写入未生效: ' + JSON.stringify(harden.settings));
  if (harden.settings.restored === 'v3-ok') hardenBad.push('设置还原失败（残留冒烟值）');
  if (harden.shots.err) hardenBad.push('截图整理 IPC 抛错: ' + harden.shots.err);
  if (!harden.launch) hardenBad.push('window.api.launch 不是函数');

  console.log('控制台错误数:', errors.length);
  if (errors.length) console.log('  ', errors.slice(0, 6).join('\n   '));

  fs.rmSync(fx.root, { recursive: true, force: true });
  const bad = ldBad.concat(sixBad, hardenBad);
  if (bad.length) {
    console.error('SMOKE FAILED（断言）: ' + bad.join(' / '));
    app.quit();
    process.exit(1);
  }
  app.quit();
})().catch((e) => { console.error('SMOKE FAILED', e); process.exit(1); });
