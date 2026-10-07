// V4 新域 IPC 运行时契约（不带 Electron）
//
// 目的：ipc-contract.test.js 只做**静态扫描**（channel 有没有对齐），抓不到
//      「handler 跑起来才炸」的问题 —— 比如返回字段名写错、模块 API 记错、
//      参数解构错位。这里手工装配一个最小的 ctx，把各新域的每个 channel
//      都真调一遍，断言返回结构。
//
// 不测的 channel：会弹系统对话框的（skin-pick / skin-save-as / redstone-save /
//   redstone-load）—— 无头环境里弹不出来；它们的参数拼装由 ipc-contract 静态兜住。
//
// ⚠️ 坑：ipcMain.handle 的 handler 首参是 **event**，业务参数从第二个开始。
//   直接 handler(arg) 会让 arg 被当成 event、业务参数变 undefined ——
//   表现为明明传了参数却说没传，排查时容易怀疑人生。所以这里一律 (null, arg)。
const path = require('path');
const os = require('os');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

const H = {};
const ctx = {
  ipcMain: { handle: (c, f) => { H[c] = f; } },
  dialog: {},
  emit: () => {},
  getWin: () => null,
  getSysConf: () => ({}),
  patchSysConf: (p) => p,
  setAutoStart: () => ({}),
  refreshTray: () => {},
  setLaunching: () => {},
  setLastLaunch: () => {},
  getLaunching: () => false,
  getLastLaunch: () => null,
  TM_DIR: path.join(os.tmpdir(), 'pl-smoke-tm'),
  INST_ROOT: path.join(os.tmpdir(), 'pl-smoke-inst'),
  JAVA_ROOT: path.join(os.tmpdir(), 'pl-smoke-java'),
  userData: path.join(os.tmpdir(), 'pl-smoke-userdata'),
  APP_DIR: ROOT,
  AUTO_KEEP: 3
};
fs.mkdirSync(ctx.userData, { recursive: true });

for (const d of ['entitydoctor', 'craftplanner', 'livemetrics', 'accountbook', 'skinedit', 'redstone', 'instance']) {
  require(path.join(ROOT, 'ipc', d + '.js'))(ctx);
}

let pass = 0, fail = 0;
async function t(name, fn) {
  try {
    const r = await fn();
    if (r === false) throw new Error('断言为 false');
    console.log('  ok   ' + name);
    pass++;
  } catch (e) {
    console.log(' FAIL  ' + name + ' -> ' + e.message);
    fail++;
  }
}
const must = (v, msg) => { if (!v) throw new Error(msg || '期望为真'); return true; };

(async () => {
  console.log('=== entitydoctor ===');
  await t('entdoc-meta 返回类别与阈值', async () => {
    const r = await H['entdoc-meta'](null);
    must(r.ok && r.categories.length === 8 && r.dims.length === 3, JSON.stringify(r).slice(0, 200));
  });
  await t('entdoc-scan 缺目录时返回 ok:false 而不是抛错', async () => {
    const r = await H['entdoc-scan'](null, {});
    must(r && r.ok === false, 'should be ok:false');
  });
  await t('entdoc-analyze 缺目录时返回 ok:false', async () => {
    const r = await H['entdoc-analyze'](null, {});
    must(r && r.ok === false);
  });
  await t('entdoc-analyze 指向不存在目录也不抛（返回空结论）', async () => {
    const r = await H['entdoc-analyze'](null, { saveDir: path.join(os.tmpdir(), 'pl-no-such-save') });
    must(r && r.ok === true, '应返回 ok:true + 空统计, got ' + JSON.stringify(r).slice(0, 200));
    must(r.summary && r.summary.total === 0, 'total 应为 0');
  });
  await t('entdoc-report 能生成纯文本', async () => {
    const r = await H['entdoc-report'](null, { name: 'X', summary: { total: 3 } });
    must(r.ok && r.text.indexOf('Pebble Lunchar') >= 0);
  });

  console.log('=== craftplanner ===');
  await t('craft-meta 有配方统计', async () => {
    const r = await H['craft-meta'](null);
    must(r.ok && r.stats.recipes > 300, JSON.stringify(r.stats));
  });
  await t('craft-search 中文能命中', async () => {
    const r = await H['craft-search'](null, '钻石');
    must(r.ok && r.items.length > 0, JSON.stringify(r).slice(0, 200));
  });
  await t('craft-search 空串返回空数组', async () => {
    const r = await H['craft-search'](null, '   ');
    must(r.ok && r.items.length === 0);
  });
  await t('craft-recipes 展开标签候选', async () => {
    const r = await H['craft-recipes'](null, 'stick');
    must(r.ok && r.recipes.length > 0, JSON.stringify(r).slice(0, 200));
    const tagIng = r.recipes[0].ing.filter((x) => x.tag);
    must(tagIng.every((x) => x.candidates.length > 0), '标签要有候选');
  });
  await t('craft-plan 目标为空时 ok:false', async () => {
    const r = await H['craft-plan'](null, { targets: [] });
    must(r.ok === false);
  });
  await t('craft-plan 正常算出一条链路', async () => {
    const r = await H['craft-plan'](null, { targets: [{ id: 'diamond_pickaxe', n: 1 }] });
    must(r.ok, JSON.stringify(r).slice(0, 300));
    must(r.plan.base.length > 0, '应有基础材料');
    must(r.order.length > 0, '应有采集顺序');
    must(r.gaps.items.length === 1);
  });
  await t('craft-plan 字符串目标也能吃下', async () => {
    const r = await H['craft-plan'](null, { targets: ['torch'] });
    must(r.ok && r.plan.totals.kinds > 0);
  });
  await t('craft-plan 库存足够时缺口为 0', async () => {
    const r = await H['craft-plan'](null, { targets: [{ id: 'stick', n: 4 }], have: { stick: 64 } });
    must(r.ok && r.gaps.allEnough === true, JSON.stringify(r.gaps));
  });
  await t('craft-gaps 只算缺口', async () => {
    const r = await H['craft-gaps'](null, { targets: ['stick'], have: { stick: 1 } });
    must(r.ok && r.gaps.missingTotal === 0 || r.gaps.missingTotal === 3, JSON.stringify(r.gaps));
  });
  await t('craft-import 追加自定义配方', async () => {
    const r = await H['craft-import'](null, { list: [{ out: 'smoke_widget', n: 1, in: { stick: 2 } }] });
    must(r.ok && r.added === 1, JSON.stringify(r));
  });
  await t('craft-plan 能用上刚导入的配方', async () => {
    const r = await H['craft-plan'](null, { targets: ['smoke_widget'] });
    must(r.ok && r.plan.steps.length > 0, JSON.stringify(r.plan.steps).slice(0, 200));
  });

  console.log('=== livemetrics ===');
  await t('live-spec 返回协议', async () => {
    const r = await H['live-spec'](null);
    must(r.ok && r.spec.fileName === 'pebble-metrics.jsonl' && r.metrics.length === 8);
  });
  await t('live-snapshot 缺 gameDir 返回 ok:false', async () => {
    const r = await H['live-snapshot'](null, {});
    must(r.ok === false);
  });
  await t('live-snapshot 对空目录返回 ok:true + hasMod:false', async () => {
    const dir = path.join(os.tmpdir(), 'pl-smoke-gamedir');
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    const r = await H['live-snapshot'](null, { gameDir: dir });
    must(r.ok === true, JSON.stringify(r).slice(0, 200));
    must(r.hasMod === false, 'hasMod 应 false');
    must(r.summary.fps.count === 0, 'FPS 应无样本');
    must(r.lagHealth.score === 100, '无卡顿时满分');
  });
  await t('live-snapshot 能读日志里的卡顿与 GC', async () => {
    const dir = path.join(os.tmpdir(), 'pl-smoke-gamedir2');
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'logs', 'latest.log'), [
      '[2026-10-07T10:00:00.100+0800] [Render thread/INFO]: Can\'t keep up! Is the server overloaded? Running 2500ms behind',
      '[2026-10-07T10:00:05.100+0800] [Render thread/INFO]: [gc] GC(12) Pause Young 512M->128M(2048M) 12.3ms',
      '[2026-10-07T10:00:10.100+0800] [Render thread/INFO]: Can\'t keep up! Running 300ms or 6 ticks behind',
      ''
    ].join('\n'));
    const r = await H['live-snapshot'](null, { gameDir: dir });
    must(r.ok && r.lag.events.length === 2, '应识别 2 次落后, got ' + JSON.stringify(r.lag.events));
    must(r.lag.events[1].ticks === 6, '第二种句式 ticks 应=6');
    must(r.lag.gcLast && r.lag.gcLast.used === 128 * 1048576, 'GC 解析错误');
    must(r.lagHealth.worstMs === 2500, '最长落后应 2500');
  });
  await t('live-snapshot 能读伴随 Mod 的 jsonl（含 null 不当成 0）', async () => {
    const dir = path.join(os.tmpdir(), 'pl-smoke-gamedir3');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pebble-metrics.jsonl'), [
      '{"t":1000,"fps":120,"tps":20,"mem":null,"entities":50}',
      '{"t":2000,"fps":60,"tps":19.5,"mem":1073741824,"entities":80}',
      '{ 半截的行',
      ''
    ].join('\n'));
    const r = await H['live-snapshot'](null, { gameDir: dir });
    must(r.hasMod === true, 'hasMod 应 true');
    must(r.sources.modBad === 1, '应有 1 行解析失败, got ' + r.sources.modBad);
    must(r.summary.mem.count === 1, 'mem 只有 1 个非 null 样本, got ' + r.summary.mem.count);
    must(r.summary.fps.count === 2);
    must(r.summary.fps.last === 60, 'last 应是最新样本 60 而不是最大值, got ' + r.summary.fps.last);
    must(r.last.dim === null, 'dim 缺失应为 null');
    must(r.verdict && r.verdict.title, 'verdict 要有结论');
  });
  await t('live-parse-log 只解析文本', async () => {
    const r = await H['live-parse-log'](null, 'Can\'t keep up! Running 900ms behind');
    must(r.ok && r.lag.length === 1 && r.lagHealth.count === 1);
  });

  console.log('=== accountbook ===');
  await t('acct-normalize 能吃旧版单账户对象', async () => {
    const r = await H['acct-normalize'](null, { uuid: 'u1', name: 'Alice', type: 'offline' });
    must(r.ok && r.migrated === true, JSON.stringify(r).slice(0, 200));
    must(r.store.accounts.length === 1 && r.store.activeId === 'u1');
  });
  await t('acct-normalize 的 view 不含凭据字段', async () => {
    const r = await H['acct-normalize'](null, { accounts: [{ uuid: 'u1', name: 'A', accessToken: 'SECRET', kind: 'microsoft' }], activeId: 'u1' });
    must(r.ok, 'ok');
    const acc = r.view.accounts[0];
    must(!acc.accessToken, '不该回传 accessToken');
    must(acc.hasSecret === true, '应标记 hasSecret');
  });
  let BOOK = null;
  await t('acct-add 第一个账户自动成为活动', async () => {
    const r = await H['acct-add'](null, { store: null, account: { uuid: 'u1', name: 'A' } });
    must(r.ok && r.added === true && r.store.activeId === 'u1');
    BOOK = r.store;
  });
  await t('acct-add 同 uuid 视为替换且不丢原名', async () => {
    const r = await H['acct-add'](null, { store: BOOK, account: { uuid: 'u1', accessToken: 'T' } });
    must(r.ok && r.replaced === true && r.store.accounts.length === 1, JSON.stringify(r.store));
    must(r.store.accounts[0].name === 'A', '替换时不该用 uuid 盖掉原名, got ' + r.store.accounts[0].name);
    BOOK = r.store;
  });
  await t('acct-add 第二个账户不抢活动状态', async () => {
    const r = await H['acct-add'](null, { store: BOOK, account: { uuid: 'u2', name: 'B' } });
    must(r.store.activeId === 'u1', 'got ' + r.store.activeId);
    BOOK = r.store;
  });
  await t('acct-set-active 切换', async () => {
    const r = await H['acct-set-active'](null, { store: BOOK, uuid: 'u2' });
    must(r.ok && r.store.activeId === 'u2');
    BOOK = r.store;
  });
  await t('acct-set-active 目标不存在时报错', async () => {
    const r = await H['acct-set-active'](null, { store: BOOK, uuid: 'nope' });
    must(r.ok === false && r.error);
  });
  await t('acct-update 局部改令牌但保留 uuid', async () => {
    const r = await H['acct-update'](null, { store: BOOK, uuid: 'u2', patch: { uuid: 'HACK', accessToken: 'X' } });
    must(r.ok && r.store.accounts[1].uuid === 'u2', 'uuid 不该被改掉');
    BOOK = r.store;
  });
  await t('acct-summary 报出账户与实例统计', async () => {
    const r = await H['acct-summary'](null, { store: BOOK, instances: [{ id: 'i1', name: 'I', accountId: 'u2' }, { id: 'i2', name: 'J' }] });
    must(r.ok && r.summary.total === 2, JSON.stringify(r.summary));
    must(r.summary.bound === 1 && r.summary.unbound === 1);
    must(r.summary.activeName === 'B', 'got ' + r.summary.activeName);
  });
  await t('acct-summary 报出失效绑定', async () => {
    const r = await H['acct-summary'](null, { store: BOOK, instances: [{ id: 'i1', name: 'I', accountId: 'ghost' }] });
    must(r.summary.stale === 1 && r.stale.length === 1, JSON.stringify(r.stale));
  });
  await t('acct-for-instance 绑定生效时 source=bound', async () => {
    const r = await H['acct-for-instance'](null, { store: BOOK, inst: { id: 'i1', accountId: 'u1' } });
    must(r.ok && r.source === 'bound' && r.account.uuid === 'u1', JSON.stringify(r).slice(0, 200));
    must(!r.account.accessToken, '不该回传凭据');
  });
  await t('acct-for-instance 绑定失效时回退活动并标 stale', async () => {
    const r = await H['acct-for-instance'](null, { store: BOOK, inst: { id: 'i1', accountId: 'ghost' } });
    must(r.stale === true && r.account.uuid === 'u2', JSON.stringify(r).slice(0, 200));
  });
  await t('acct-remove 删活动账户后顺延', async () => {
    const r = await H['acct-remove'](null, { store: BOOK, uuid: 'u2' });
    must(r.ok && r.removed === true && r.store.activeId === 'u1', JSON.stringify(r.store));
  });
  await t('acct-bind 缺 id 时 ok:false', async () => {
    const r = await H['acct-bind'](null, {});
    must(r.ok === false);
  });

  /* ---------- V4 第五组：3D 皮肤编辑器 ---------- */
  console.log('=== skinedit ===');
  let skinUrl = '';

  await t('skin-meta 返回部件 / 第二层 / 模板 / 调色板', async () => {
    const r = await H['skin-meta'](null);
    must(r.parts.length === 6 && r.overlay.length === 6 && r.templates.length >= 4,
      'parts=' + r.parts.length + ' overlay=' + r.overlay.length + ' tpl=' + r.templates.length);
    must(Array.isArray(r.palette) && r.palette.length > 8, '调色板');
    must(r.faceZh && r.faceZh.front, '面名映射');
    must(r.size && r.size.w === 64, '尺寸');
  });

  await t('skin-mesh 默认 72 面；关掉第二层 36 面', async () => {
    const a = await H['skin-mesh'](null);
    const b = await H['skin-mesh'](null, false);
    must(a.ok && a.count === 72, '默认 count=' + a.count);
    must(b.ok && b.count === 36, '关第二层 count=' + b.count);
    must(a.faces[0].quad.length === 4 && a.faces[0].uv.w > 0, '每面应有 4 顶点与 uv');
  });

  await t('skin-template 每个模板都能造出来且是 64×64', async () => {
    const meta = await H['skin-meta'](null);
    for (const tpl of meta.templates) {
      const r = await H['skin-template'](null, tpl.id);
      must(r.ok && r.w === 64 && r.h === 64, tpl.id + ' -> ' + JSON.stringify(r).slice(0, 120));
      must(String(r.dataUrl).startsWith('data:image/png;base64,'), tpl.id + ' dataUrl 前缀');
    }
  });

  await t('skin-template 未知 id 返回 ok:false 而不是抛错', async () => {
    const r = await H['skin-template'](null, 'nope');
    must(r && r.ok === false, JSON.stringify(r));
  });

  await t('skin-validate 认出合法皮肤，并带第二层覆盖率', async () => {
    const tpl = await H['skin-template'](null, 'warm');
    const r = await H['skin-validate'](null, tpl.dataUrl);
    must(r.ok === true && r.errors.length === 0, JSON.stringify(r).slice(0, 200));
    must(r.stats && r.stats.colors > 10, '颜色数');
    must(r.coverage && typeof r.coverage.empty === 'number', '第二层覆盖率');
  });

  await t('skin-validate 对垃圾输入返回 ok:false', async () => {
    const r = await H['skin-validate'](null, 'not-a-data-url');
    must(r && r.ok === false);
  });

  await t('skin-mirror 返回新图，且镜像两次能还原', async () => {
    const tpl = await H['skin-template'](null, 'warm');
    skinUrl = tpl.dataUrl;
    const once = await H['skin-mirror'](null, skinUrl);
    must(once.ok && once.swap > 0, JSON.stringify(once).slice(0, 120));
    const twice = await H['skin-mirror'](null, once.dataUrl);
    must(twice.ok && twice.dataUrl === skinUrl, '镜像两次应回到原图');
  });

  await t('skin-mirror 对 64×32 的旧格式图明确拒绝', async () => {
    const se = require(path.join(ROOT, 'skinedit'));
    const small = se.toDataUrl(se.blankImage(64, 32));
    const r = await H['skin-mirror'](null, small);
    must(r.ok === false && !!r.error, JSON.stringify(r));
  });

  await t('skin-part-map 按部件裁出放大图（头的展开块是 32×16）', async () => {
    const r = await H['skin-part-map'](null, skinUrl, 'head', 4);
    must(r.ok && r.bw === 32 && r.bh === 16 && r.scale === 4,
      JSON.stringify({ bw: r.bw, bh: r.bh, scale: r.scale }));
    must(String(r.dataUrl).startsWith('data:image/png;base64,'));
  });

  await t('skin-part-map 未知部件返回 ok:false', async () => {
    const r = await H['skin-part-map'](null, skinUrl, 'tail', 4);
    must(r.ok === false);
  });

  await t('skin-load 文件不存在时 ok:false（不抛）', async () => {
    const r = await H['skin-load'](null, path.join(os.tmpdir(), 'pl-no-such-skin.png'));
    must(r && r.ok === false, JSON.stringify(r));
  });

  /* ---------- V4 第五组：红石电路模拟器 ---------- */
  console.log('=== redstone ===');

  await t('redstone-components 返回 9 种元件', async () => {
    const r = await H['redstone-components'](null);
    must(Array.isArray(r) && r.length === 9, 'count=' + (r && r.length));
    must(r.every((c) => c.id && c.zh && c.kind), '每项要有 id / zh / kind');
  });

  await t('redstone-samples 列出内置示例', async () => {
    const r = await H['redstone-samples'](null);
    must(Array.isArray(r) && r.length >= 4, 'count=' + (r && r.length));
    must(r.every((s) => s.id && s.zh && s.note), '每项要有 id / zh / note');
  });

  await t('redstone-new 给出空电路', async () => {
    const r = await H['redstone-new'](null);
    must(r.ok && r.count === 0 && r.tick === 0, JSON.stringify(r).slice(0, 150));
  });

  await t('place / set / step 组合出一盏亮的灯', async () => {
    await H['redstone-new'](null);
    await H['redstone-place'](null, { x: 0, y: 0, type: 'lever', patch: { facing: 'e' } });
    await H['redstone-set'](null, { x: 0, y: 0, patch: { on: true } });
    await H['redstone-place'](null, { x: 1, y: 0, type: 'wire' });
    const r = await H['redstone-place'](null, { x: 2, y: 0, type: 'lamp' });
    must(r.ok && r.count === 3, 'count=' + r.count);
    const step = await H['redstone-step'](null, 2);
    const wire = step.cells.find((c) => c.type === 'wire');
    const lamp = step.cells.find((c) => c.type === 'lamp');
    must(wire.out === 15, '线强度应为 15，实际 ' + wire.out);
    must(lamp.lit === true, '灯应亮');
  });

  await t('redstone-set 改 on 时自动推进一刻（扳开关立刻看到下游反应）', async () => {
    await H['redstone-new'](null);
    await H['redstone-place'](null, { x: 0, y: 0, type: 'lever', patch: { facing: 'e' } });
    await H['redstone-place'](null, { x: 1, y: 0, type: 'wire' });
    await H['redstone-place'](null, { x: 2, y: 0, type: 'lamp' });
    // 只扳开关，不再手动 step —— 灯必须自己亮
    const r = await H['redstone-set'](null, { x: 0, y: 0, patch: { on: true } });
    const lamp = r.cells.find((c) => c.type === 'lamp');
    must(r.tick === 1, '应自动走过一刻，实际 tick=' + r.tick);
    must(lamp.lit === true, '扳开关后灯应立刻亮');
    // 纯配置改动（改延迟）不该推进时间
    await H['redstone-place'](null, { x: 4, y: 0, type: 'repeater', patch: { facing: 'e' } });
    const r2 = await H['redstone-set'](null, { x: 4, y: 0, patch: { delay: 3 } });
    must(r2.tick === 1, '改延迟不该推进 tick，实际 ' + r2.tick);
    const rep = r2.cells.find((c) => c.type === 'repeater');
    must(rep.delay === 3, '延迟应为 3，实际 ' + rep.delay);
  });

  await t('redstone-rotate 改变朝向', async () => {
    await H['redstone-new'](null);
    await H['redstone-place'](null, { x: 0, y: 0, type: 'repeater', patch: { facing: 'n' } });
    const r = await H['redstone-rotate'](null, { x: 0, y: 0 });
    must(r.cells[0].facing === 'e', 'n 转 90° 应为 e，实际 ' + r.cells[0].facing);
  });

  await t('redstone-sample 火把时钟真的在振荡', async () => {
    const r = await H['redstone-sample'](null, 'torchclock');
    must(r.ok && r.count === 4, JSON.stringify(r).slice(0, 200));
    const w1 = await H['redstone-wave'](null, 20);
    must(w1.ok && w1.waves.length >= 1, '应有探针波形');
    await H['redstone-step'](null, 6);
    const w2 = await H['redstone-wave'](null, 20);
    must(w2.waves[0].changes > 2, '波形应有多次翻转，实际 ' + w2.waves[0].changes);
  });

  await t('redstone-sample 装载后就已经「通上电」（不是一片黑）', async () => {
    // 火把/中继器 1 tick 延迟 —— 只推进 1 刻的话第一刻只排队不输出，
    // 示例打开是「没通电」的样子，用户会以为坏了。
    const r = await H['redstone-sample'](null, 'not');
    must(r.ok, JSON.stringify(r).slice(0, 150));
    must(r.tick >= 2, '装载后应已推进至少 2 刻，实际 ' + r.tick);
    const lamp = r.cells.find((c) => c.type === 'lamp');
    must(lamp && lamp.lit === true, '非门示例默认（拉杆关）灯应该是亮的');
    // 扳开拉杆 → 火把灭、灯灭：这才是「非」
    const on = await H['redstone-set'](null, { x: 0, y: 1, patch: { on: true } });
    must(on.cells.find((c) => c.type === 'lamp').lit === false, '拉杆打开后灯应灭');
  });

  await t('redstone-reset 清掉运行状态但保留布局', async () => {
    await H['redstone-sample'](null, 'not');
    const r = await H['redstone-reset'](null);
    must(r.ok && r.count > 0 && r.tick === 0,
      JSON.stringify({ count: r.count, tick: r.tick }));
  });

  await t('redstone-probe 能开也能关', async () => {
    await H['redstone-sample'](null, 'decay');
    const off = await H['redstone-probe'](null, { x: 18, y: 0, on: false });
    must(off.probes === 0, 'probes=' + off.probes);
    const on = await H['redstone-probe'](null, { x: 18, y: 0, on: true });
    must(on.probes === 1, 'probes=' + on.probes);
  });

  await t('redstone-ascii 导出字符画', async () => {
    await H['redstone-sample'](null, 'delay');
    const r = await H['redstone-ascii'](null);
    must(r.ok && typeof r.art === 'string' && r.art.length > 0, JSON.stringify(r).slice(0, 120));
    must(r.art.includes('L'), '应含拉杆的 L');
  });

  await t('redstone-remove 删掉一个元件', async () => {
    await H['redstone-new'](null);
    const s = await H['redstone-sample'](null, 'not');
    const r = await H['redstone-remove'](null, { x: 0, y: 1 });
    must(r.ok && r.count === s.count - 1, s.count + ' -> ' + r.count);
  });

  await t('redstone-sample 未知 id 返回 ok:false', async () => {
    const r = await H['redstone-sample'](null, 'nope');
    must(r.ok === false);
  });

  await t('redstone-import 缺参数时返回 ok:false 而不是抛错', async () => {
    const r = await H['redstone-import'](null, {});
    must(r && r.ok === false, JSON.stringify(r).slice(0, 200));
  });

  console.log('\n' + (fail === 0 ? '★ 冒烟全部通过' : '★ 冒烟有 ' + fail + ' 项失败') + ' (' + pass + '/' + (pass + fail) + ')');
  process.exit(fail ? 1 : 0);
})();
