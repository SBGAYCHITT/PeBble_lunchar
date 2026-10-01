// 系统级配置：开机自启 + 快捷方式创建
//
// 两个坑：
// 1) setLoginItemSettings 在"已经设为开机启动"之后重复调用是幂等的，但传 openAsHidden 时
//    必须和 openAtLogin 一起传，否则 Windows 上会留下一条旧的启动项。
// 2) 快捷方式用 Electron 自带的 shell.writeShortcutLink（仅 Windows），不要用 PowerShell 拼 COM：
//    路径里带中文/空格时引号转义非常容易写错，而 writeShortcutLink 直接吃对象参数。
const path = require('path');

/** 开机启动项参数（纯函数） */
function loginItemArgs(enable, hidden) {
  return { openAtLogin: !!enable, openAsHidden: !!enable && !!hidden };
}

/**
 * 计算要创建的快捷方式目标（纯函数）
 * @param {{name:string, desktopDir?:string, startMenuDir?:string, kinds?:string[]}} o
 * @returns {Array<{kind:string, linkPath:string}>}
 */
function shortcutTargets(o) {
  const opt = /** @type {any} */ (o || {});
  const name = opt.name || 'Pebble Lunchar';
  const kinds = opt.kinds || ['desktop', 'startMenu'];
  const out = [];
  for (const kind of kinds) {
    const dir = kind === 'desktop' ? opt.desktopDir : (kind === 'startMenu' ? opt.startMenuDir : null);
    if (!dir) continue;
    out.push({ kind, linkPath: path.join(dir, name + '.lnk') });
  }
  return out;
}

/** writeShortcutLink 的参数对象（纯函数） */
function buildShortcutOptions(o) {
  const opt = /** @type {any} */ (o || {});
  /** @type {any} */
  const out = { target: opt.target };
  if (opt.cwd) out.cwd = opt.cwd;
  if (opt.args) out.args = opt.args;
  if (opt.description) out.description = opt.description;
  if (opt.icon) { out.icon = opt.icon; out.iconIndex = opt.iconIndex || 0; }
  return out;
}

/** 读取当前开机启动状态 */
function getLoginItem() {
  try {
    const { app } = require('electron');
    return app.getLoginItemSettings();
  } catch { return { openAtLogin: false, openAsHidden: false }; }
}

/** 设置开机启动 */
function setLoginItem(enable, hidden) {
  try {
    const { app } = require('electron');
    app.setLoginItemSettings(loginItemArgs(enable, hidden));
    return { ok: true, settings: app.getLoginItemSettings() };
  } catch (e) { return { ok: false, error: e.message }; }
}

/**
 * 创建快捷方式
 * @param {{target:string, cwd?:string, args?:string, description?:string, icon?:string,
 *          name?:string, kinds?:string[], desktopDir?:string, startMenuDir?:string}} o
 */
function createShortcuts(o) {
  const opt = /** @type {any} */ (o || {});
  if (!opt.target) return { ok: false, error: '缺少目标程序路径', created: [], failed: [] };
  let shell;
  try { shell = require('electron').shell; } catch { return { ok: false, error: '当前环境不支持快捷方式', created: [], failed: [] }; }
  if (!shell || typeof shell.writeShortcutLink !== 'function') {
    return { ok: false, error: '当前平台不支持 writeShortcutLink', created: [], failed: [] };
  }
  const targets = shortcutTargets(opt);
  if (!targets.length) return { ok: false, error: '没有可写入的快捷方式位置', created: [], failed: [] };

  const opts = buildShortcutOptions(opt);
  const created = [], failed = [];
  for (const t of targets) {
    try {
      shell.writeShortcutLink(t.linkPath, 'create', opts);
      created.push(t);
    } catch (e) {
      // 目标已存在时先尝试覆盖（'update' 对不存在的链接会失败，所以先 create 再 update）
      try {
        shell.writeShortcutLink(t.linkPath, 'update', opts);
        created.push(t);
      } catch (e2) { failed.push({ kind: t.kind, linkPath: t.linkPath, error: e2.message }); }
    }
  }
  return { ok: failed.length === 0, created, failed };
}

/**
 * 删除已创建的快捷方式
 *
 * 坑：Electron 的 shell.writeShortcutLink 只支持 'create' | 'update' | 'replace'
 * 三种 operation，**没有 'delete'**。早期版本传 'delete' 会抛异常并被 catch 吞掉，
 * 表现为「点了删除但快捷方式还在」。快捷方式本质就是个 .lnk 文件，直接 unlink 即可。
 * @param {{name?:string, kinds?:string[], desktopDir?:string, startMenuDir?:string}} o
 * @returns {{ok:boolean, removed:Array, failed:Array}}
 */
function removeShortcuts(o) {
  const opt = /** @type {any} */ (o || {});
  const fs = require('fs');
  const targets = shortcutTargets(opt);
  const removed = [], failed = [];
  for (const t of targets) {
    try {
      if (fs.existsSync(t.linkPath)) {
        fs.unlinkSync(t.linkPath);
        removed.push(t);
      }
    } catch (e) { failed.push({ kind: t.kind, linkPath: t.linkPath, error: e.message }); }
  }
  return { ok: failed.length === 0, removed, failed };
}

module.exports = {
  loginItemArgs, shortcutTargets, buildShortcutOptions,
  getLoginItem, setLoginItem, createShortcuts, removeShortcuts
};
