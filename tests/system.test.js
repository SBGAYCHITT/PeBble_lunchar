// 组7 离线测试：托盘菜单结构 / 开机启动与快捷方式 / i18n / 更新版本比较 / 截图元数据与归档
// 需要 Electron 运行时的部分（真建 Tray、真写快捷方式）不在这里跑。
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tray = require('../tray');
const sysconf = require('../sysconf');
const i18n = require('../i18n');
const updater = require('../updater');
const shots = require('../screenshots');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log(' FAIL  ' + name + ' -> ' + e.message); fail++; }
}

/* ---------------- 托盘 ---------------- */
console.log('=== 托盘 ===');
t('提示含玩家名 / 版本 / 运行数', () => {
  const tip = tray.trayTooltip({ playerName: 'Felix', version: '1.20.1', running: 2 });
  assert.ok(tip.indexOf('Felix') >= 0 && tip.indexOf('1.20.1') >= 0 && tip.indexOf('2') >= 0, tip);
});
t('未登录时提示不炸', () => assert.ok(tray.trayTooltip({}).length > 0));
t('窗口可见时菜单显示"隐藏窗口"', () => {
  const m = tray.buildTrayMenuTemplate({ visible: true, version: '1.20.1' });
  assert.strictEqual(m[0].id, 'toggle');
  assert.strictEqual(m[0].label, '隐藏窗口');
});
t('窗口隐藏时菜单显示"显示窗口"', () => {
  const m = tray.buildTrayMenuTemplate({ visible: false, version: '1.20.1' });
  assert.strictEqual(m[0].label, '显示窗口');
});
t('没选版本时"启动游戏"禁用', () => {
  const m = tray.buildTrayMenuTemplate({ visible: true, version: '' });
  const launch = m.find((x) => x.id === 'launch');
  assert.strictEqual(launch.enabled, false);
});
t('启动中"启动游戏"禁用且文案变化', () => {
  const m = tray.buildTrayMenuTemplate({ visible: true, version: '1.20.1', launching: true });
  const launch = m.find((x) => x.id === 'launch');
  assert.strictEqual(launch.enabled, false);
  assert.ok(launch.label.indexOf('正在启动') >= 0, launch.label);
});
t('有游戏在跑才出现"结束全部游戏"', () => {
  const a = tray.buildTrayMenuTemplate({ visible: true, version: '1.20.1', running: 0 });
  const b = tray.buildTrayMenuTemplate({ visible: true, version: '1.20.1', running: 2 });
  assert.strictEqual(a.find((x) => x.id === 'stopall'), undefined);
  assert.ok(b.find((x) => x.id === 'stopall'));
});
t('开机自启是 checkbox 且反映状态', () => {
  const m = tray.buildTrayMenuTemplate({ visible: true, version: 'v', autostart: true });
  const item = m.find((x) => x.id === 'autostart');
  assert.strictEqual(item.type, 'checkbox');
  assert.strictEqual(item.checked, true);
});
t('菜单最后一项是退出', () => {
  const m = tray.buildTrayMenuTemplate({ visible: true, version: 'v' });
  assert.strictEqual(m[m.length - 1].id, 'quit');
});
t('toElectronTemplate 正确映射分隔符/勾选/回调', () => {
  let clicked = 0;
  const out = tray.toElectronTemplate(
    [{ id: 'a', label: 'A' }, { type: 'separator' }, { id: 'b', label: 'B', type: 'checkbox', checked: true }],
    { a: () => { clicked++; } }
  );
  assert.strictEqual(out[1].type, 'separator');
  assert.strictEqual(out[2].type, 'checkbox');
  assert.strictEqual(out[2].checked, true);
  assert.strictEqual(typeof out[0].click, 'function');
  assert.strictEqual(typeof out[2].click, 'undefined');
  out[0].click(); assert.strictEqual(clicked, 1);
});

/* ---------------- 开机启动 / 快捷方式 ---------------- */
console.log('\n=== 开机启动 / 快捷方式 ===');
t('开启+隐藏 → openAsHidden 为 true', () =>
  assert.deepStrictEqual(sysconf.loginItemArgs(true, true), { openAtLogin: true, openAsHidden: true }));
t('开启不隐藏 → openAsHidden 为 false', () =>
  assert.deepStrictEqual(sysconf.loginItemArgs(true, false), { openAtLogin: true, openAsHidden: false }));
t('未开启时隐藏必须被忽略（否则留下脏启动项）', () =>
  assert.deepStrictEqual(sysconf.loginItemArgs(false, true), { openAtLogin: false, openAsHidden: false }));
t('桌面+开始菜单 → 两条 .lnk', () => {
  const r = sysconf.shortcutTargets({ name: 'PB', desktopDir: 'D:/Desktop', startMenuDir: 'C:/SM' });
  assert.strictEqual(r.length, 2);
  assert.ok(r[0].linkPath.endsWith('PB.lnk'));
  assert.deepStrictEqual(r.map((x) => x.kind), ['desktop', 'startMenu']);
});
t('只选桌面 → 只有一条', () => {
  const r = sysconf.shortcutTargets({ name: 'PB', desktopDir: 'D:/Desktop', kinds: ['desktop'] });
  assert.strictEqual(r.length, 1);
});
t('目录缺失的位置被跳过', () => {
  const r = sysconf.shortcutTargets({ name: 'PB', startMenuDir: 'C:/SM' });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].kind, 'startMenu');
});
t('快捷方式参数不写入 undefined 字段', () => {
  const o = sysconf.buildShortcutOptions({ target: 'a.exe', cwd: 'd' });
  assert.deepStrictEqual(Object.keys(o).sort(), ['cwd', 'target']);
});
t('带图标时补 iconIndex', () => {
  const o = sysconf.buildShortcutOptions({ target: 'a.exe', icon: 'i.ico' });
  assert.strictEqual(o.iconIndex, 0);
});

// 回归：早期版本用 shell.writeShortcutLink(path, 'delete') 删快捷方式，
// 而 Electron 的 operation 只有 create/update/replace，'delete' 会抛异常并被 catch 吞掉，
// 表现为「点了删除但 .lnk 还在」。这里用真实临时目录锁住 unlink 实现。
t('removeShortcuts 真的删掉了 .lnk 文件', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-lnk-'));
  const desk = path.join(tmp, 'desktop');
  fs.mkdirSync(desk);
  const link = path.join(desk, 'PB.lnk');
  fs.writeFileSync(link, 'fake');
  const r = sysconf.removeShortcuts({ name: 'PB', desktopDir: desk, kinds: ['desktop'] });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.removed.length, 1);
  assert.strictEqual(fs.existsSync(link), false, '.lnk 仍在，说明删除没生效');
  fs.rmSync(tmp, { recursive: true, force: true });
});
t('removeShortcuts 对不存在的链接不报错', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-lnk2-'));
  const r = sysconf.removeShortcuts({ name: 'PB', desktopDir: tmp, kinds: ['desktop'] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.removed.length, 0);
  fs.rmSync(tmp, { recursive: true, force: true });
});

/* ---------------- i18n ---------------- */
console.log('\n=== i18n ===');
t('默认是简体中文', () => {
  i18n.setLang('zh-CN');
  assert.strictEqual(i18n.t('nav.launch'), '启动');
});
t('切英文生效', () => {
  i18n.setLang('en-US');
  assert.strictEqual(i18n.t('nav.launch'), 'Launch');
  i18n.setLang('zh-CN');
});
t('未知语言回落到默认', () => {
  i18n.setLang('xx-YY');
  assert.strictEqual(i18n.getLang(), 'zh-CN');
});
t('未收录的 key 返回 key 本身（不会显示 undefined）', () =>
  assert.strictEqual(i18n.t('some.missing.key'), 'some.missing.key'));
t('参数插值 {{n}}', () => assert.strictEqual(i18n.t('shots.count', { n: 5 }), '共 5 张'));
t('可用语言列表含中英', () => {
  const codes = i18n.available().map((x) => x.code);
  assert.ok(codes.indexOf('zh-CN') >= 0 && codes.indexOf('en-US') >= 0, JSON.stringify(codes));
});
t('英文覆盖了全部已收录 key', () => {
  const miss = i18n.missing('en-US');
  assert.deepStrictEqual(miss, [], '英文缺失: ' + miss.join(', '));
});
t('未收录的语言报告全部缺失', () =>
  assert.strictEqual(i18n.missing('xx-YY').length, i18n.keys().length));

/* ---------------- 更新检查 ---------------- */
console.log('\n=== 更新检查 ===');
t('新版更大', () => assert.strictEqual(updater.compareVersion('1.1.0', '1.0.0'), 1));
t('旧版更小', () => assert.strictEqual(updater.compareVersion('1.0.0', '1.1.0'), -1));
t('相同版本为 0', () => assert.strictEqual(updater.compareVersion('1.0.0', '1.0.0'), 0));
t('1.10 > 1.9（按数值而非字符串）', () => assert.strictEqual(updater.compareVersion('1.10', '1.9'), 1));
t('位数不等按 0 补齐', () => assert.strictEqual(updater.compareVersion('1.0', '1.0.0'), 0));
t('前缀 v 被忽略', () => assert.strictEqual(updater.compareVersion('v1.2.0', '1.2.0'), 0));
t('feed 合法', () => {
  const r = updater.parseFeed({ version: '2.0.0', url: 'https://x/y.exe', notes: 'n' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.version, '2.0.0');
});
t('feed 缺 version → 报错', () => assert.strictEqual(updater.parseFeed({ url: 'x' }).ok, false));
t('feed 不是对象 → 报错', () => assert.strictEqual(updater.parseFeed('nope').ok, false));

/* ---------------- 截图 ---------------- */
console.log('\n=== 截图 ===');
function makePng(w, h) {
  const b = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
t('解析 PNG 宽高', () => assert.deepStrictEqual(shots.pngInfo(makePng(1920, 1080)), { width: 1920, height: 1080 }));
t('非 PNG 返回 null', () => assert.strictEqual(shots.pngInfo(Buffer.alloc(24)), null));
t('数据过短返回 null', () => assert.strictEqual(shots.pngInfo(Buffer.alloc(10)), null));
t('IHDR 缺失返回 null', () => {
  const b = makePng(10, 10); b.write('ABCD', 12, 'latin1');
  assert.strictEqual(shots.pngInfo(b), null);
});
t('dateKey 按月', () => assert.strictEqual(shots.dateKey(new Date('2026-09-23T10:00:00').getTime(), 'month'), '2026-09'));
t('dateKey 按天', () => assert.strictEqual(shots.dateKey(new Date('2026-09-23T10:00:00').getTime(), 'day'), '2026-09-23'));
t('dateKey 按年', () => assert.strictEqual(shots.dateKey(new Date('2026-09-23T10:00:00').getTime(), 'year'), '2026'));
t('非法时间归到 unknown', () => assert.strictEqual(shots.dateKey(NaN, 'month'), 'unknown'));
t('归档计划按月份分组', () => {
  const plan = shots.planOrganize([
    { name: 'a.png', path: '/s/a.png', mtime: new Date('2026-09-01').getTime() },
    { name: 'b.png', path: '/s/b.png', mtime: new Date('2026-10-01').getTime() }
  ], { baseDir: '/s', mode: 'month' });
  assert.strictEqual(plan.length, 2);
  assert.ok(plan[0].to.indexOf('2026-09') > 0, plan[0].to);
  assert.ok(plan[1].to.indexOf('2026-10') > 0, plan[1].to);
});
t('同名冲突自动加序号，不覆盖', () => {
  const plan = shots.planOrganize([
    { name: 'a.png', path: '/x/a.png', mtime: new Date('2026-09-01').getTime() },
    { name: 'a.png', path: '/y/a.png', mtime: new Date('2026-09-02').getTime() }
  ], { baseDir: '/s', mode: 'month' });
  assert.notStrictEqual(plan[0].name, plan[1].name);
  assert.ok(/\(1\)/.test(plan[1].name), plan[1].name);
});
t('已在目标位置的文件不进计划', () => {
  const base = path.join(os.tmpdir(), 'pl-shot-plan');
  const plan = shots.planOrganize([
    { name: 'a.png', path: path.join(base, '2026-09', 'a.png'), mtime: new Date('2026-09-01').getTime() }
  ], { baseDir: base, mode: 'month' });
  assert.strictEqual(plan.length, 0);
});
t('统计数量与总体积', () => {
  const s = shots.stats([{ size: 100, mtime: 2 }, { size: 300, mtime: 1 }]);
  assert.strictEqual(s.count, 2);
  assert.strictEqual(s.bytes, 400);
  assert.strictEqual(s.earliest, 1);
  assert.strictEqual(s.latest, 2);
});

console.log('\n=== 截图归档（真实文件系统） ===');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-shots-'));
const shotDir = path.join(tmp, 'screenshots');
fs.mkdirSync(shotDir, { recursive: true });
for (const [name, when] of [['a.png', '2026-09-01T10:00:00'], ['b.png', '2026-09-05T10:00:00'], ['c.png', '2026-10-02T10:00:00']]) {
  fs.writeFileSync(path.join(shotDir, name), makePng(1920, 1080));
  fs.utimesSync(path.join(shotDir, name), new Date(when), new Date(when));
}
t('listWithMeta 读宽高', () => {
  const list = shots.listWithMeta(tmp);
  assert.strictEqual(list.length, 3);
  assert.strictEqual(list[0].width, 1920);
  assert.strictEqual(list[0].height, 1080);
});
t('listWithMeta 按时间倒序', () => {
  const list = shots.listWithMeta(tmp);
  assert.ok(list[0].mtime >= list[1].mtime && list[1].mtime >= list[2].mtime);
});
t('目录不存在返回空数组', () => assert.deepStrictEqual(shots.listWithMeta(path.join(tmp, 'nope')), []));
t('归档把文件移进月份子目录', () => {
  const r = shots.organize(tmp, 'month');
  assert.strictEqual(r.ok, true, JSON.stringify(r.failed));
  assert.strictEqual(r.moved, 3);
  assert.deepStrictEqual(r.keys, ['2026-09', '2026-10']);
  assert.ok(fs.existsSync(path.join(shotDir, '2026-09', 'a.png')));
  assert.ok(fs.existsSync(path.join(shotDir, '2026-10', 'c.png')));
  assert.ok(!fs.existsSync(path.join(shotDir, 'a.png')));
});
t('重复执行归档不报错且不再移动', () => {
  const r = shots.organize(tmp, 'month');
  assert.strictEqual(r.moved, 0);
});
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

console.log('\n' + (fail === 0 ? '★ system 全部通过（' + pass + ' 项）' : `★ system 有 ${fail} 项失败`));
process.exit(fail === 0 ? 0 : 1);
