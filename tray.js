// 系统托盘：常驻后台、最小化到托盘、托盘菜单控制启动器
//
// 设计要点：菜单结构用纯函数 buildTrayMenuTemplate 生成（可单测、不依赖 Electron 运行时），
// 真正建 Tray 的时候再把它翻译成 Electron 的 MenuItem。这样"菜单项什么时候禁用/显示什么文案"
// 这类逻辑能离线验证，不需要真开一个窗口。
const path = require('path');
const i18n = require('./i18n');

/** 托盘悬停提示（纯函数，走 i18n） */
function trayTooltip(state) {
  const s = state || {};
  return i18n.t('tray.tooltip', {
    name: s.playerName || '未登录',
    ver: s.version ? ' · ' + s.version : '',
    run: s.running ? ' · ' + s.running + ' 个游戏运行中' : ''
  });
}

/**
 * 生成托盘菜单结构（纯函数）
 * @param {{visible?:boolean, launching?:boolean, running?:number, version?:string,
 *          playerName?:string, autostart?:boolean, gameDir?:string}} [state]
 * @returns {Array<{id?:string,label?:string,enabled?:boolean,checked?:boolean,type?:string}>}
 */
function buildTrayMenuTemplate(state) {
  const s = /** @type {any} */ (state || {});
  const running = s.running || 0;
  const items = [];

  items.push({ id: 'toggle', label: s.visible ? i18n.t('tray.hide') : i18n.t('tray.show') });
  items.push({
    id: 'launch',
    label: s.launching ? i18n.t('tray.launching') : i18n.t('tray.launch'),
    enabled: !s.launching && !!s.version
  });

  if (running > 0) {
    items.push({ id: 'running', label: i18n.t('tray.running', { n: running }), enabled: false });
    items.push({ id: 'stopall', label: i18n.t('tray.stopall') });
  }

  items.push({ type: 'separator' });
  items.push({ id: 'openGameDir', label: i18n.t('tray.openDir'), enabled: !!s.gameDir });
  items.push({ id: 'autostart', label: i18n.t('tray.autostart'), type: 'checkbox', checked: !!s.autostart });
  items.push({ type: 'separator' });
  items.push({ id: 'quit', label: i18n.t('tray.quit') });
  return items;
}

/** 把纯结构翻译成 Electron 的 Menu 模板（actions: id -> 回调） */
function toElectronTemplate(items, actions) {
  return (items || []).map((it) => {
    const out = {};
    if (it.type === 'separator') { out.type = 'separator'; return out; }
    out.label = it.label;
    if (it.enabled === false) out.enabled = false;
    if (it.type === 'checkbox') { out.type = 'checkbox'; out.checked = !!it.checked; }
    if (it.id && actions && typeof actions[it.id] === 'function') out.click = actions[it.id];
    return out;
  });
}

/**
 * 建立托盘。返回 tray 实例（失败返回 null——托盘在部分环境/远程会话里会创建失败，
 * 不能让它把整个启动器拖崩）。
 */
function createTray(opts) {
  const o = opts || {};
  let electron;
  try { electron = require('electron'); } catch { return null; }
  if (!electron || !electron.Tray) return null;

  const iconPath = o.iconPath || path.join(__dirname, 'assets', 'logo.png');
  let tray;
  try {
    tray = new electron.Tray(iconPath);
  } catch (e) {
    return null;
  }
  tray.setToolTip(trayTooltip(o.getState ? o.getState() : {}));

  const refresh = () => {
    const state = (o.getState && o.getState()) || {};
    tray.setToolTip(trayTooltip(state));
    const actions = {};
    // 每个 id 都包一层：回调里重新取最新 state，避免菜单建好后状态变了还按旧的走
    for (const id of ['toggle', 'launch', 'stopall', 'openGameDir', 'autostart', 'quit']) {
      actions[id] = () => { if (o.onAction) o.onAction(id, (o.getState && o.getState()) || {}); };
    }
    const tpl = toElectronTemplate(buildTrayMenuTemplate(state), actions);
    tray.setContextMenu(electron.Menu.buildFromTemplate(tpl));
  };

  tray.on('click', () => { if (o.onAction) o.onAction('toggle', (o.getState && o.getState()) || {}); });
  refresh();
  return { tray, refresh, destroy: () => { try { tray.destroy(); } catch {} } };
}

module.exports = { trayTooltip, buildTrayMenuTemplate, toElectronTemplate, createTray };
