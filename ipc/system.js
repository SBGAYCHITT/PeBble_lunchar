// 系统级：通知 / 外部链接 / 应用信息 / 开机自启 / 托盘 / 快捷方式 / 语言 / 自动更新 / 截图 / Java
const path = require('path');
const { app, shell, Notification } = require('electron');
const sysconf = require('../sysconf');
const i18n = require('../i18n');
const updater = require('../updater');
const shots = require('../screenshots');
const javadl = require('../javadl');

/** 快捷方式位置：桌面 / 开始菜单。取不到目录就返回 null，让 UI 明确提示而不是静默失败 */
function shortcutDirs() {
  const get = (k) => { try { return app.getPath(k); } catch { return null; } };
  const appData = get('appData');
  return {
    desktopDir: get('desktop'),
    startMenuDir: appData ? path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : null
  };
}

module.exports = function register(ctx) {
  const { ipcMain, emit, JAVA_ROOT } = ctx;

  /* ---------- 通知 / 外部链接 / 应用信息 ---------- */
  ipcMain.handle('notify', (_e, title, body) => {
    if (Notification.isSupported()) new Notification({ title, body }).show();
    return true;
  });
  ipcMain.handle('open-external', (_e, url) => { shell.openExternal(url); });
  ipcMain.handle('app-info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node
  }));

  /* ---------- 系统配置（开机自启 / 托盘 / 快捷方式 / 语言） ---------- */
  ipcMain.handle('sysconf-get', () => ({
    ok: true, conf: ctx.getSysConf(), loginItem: sysconf.getLoginItem()
  }));

  ipcMain.handle('autostart-set', (_e, enable) => {
    const r = ctx.setAutoStart(!!enable);
    emit('sysconf-changed', ctx.getSysConf());
    return r;
  });

  ipcMain.handle('minimize-tray-set', (_e, enable) => {
    ctx.patchSysConf({ minimizeToTray: !!enable });
    emit('sysconf-changed', ctx.getSysConf());
    return { ok: true, minimizeToTray: !!enable };
  });

  ipcMain.handle('lang-set', (_e, code) => {
    ctx.patchSysConf({ lang: i18n.setLang(code) });
    ctx.refreshTray();                          // 托盘菜单跟着换语言
    return { ok: true, lang: i18n.getLang() };
  });
  ipcMain.handle('lang-get', () => ({ ok: true, lang: i18n.getLang(), langs: i18n.available() }));

  ipcMain.handle('shortcut-create', (_e, kinds) => {
    const dirs = shortcutDirs();
    return sysconf.createShortcuts(Object.assign({
      name: 'Pebble Lunchar',
      target: app.getPath('exe'),
      cwd: path.dirname(app.getPath('exe')),
      description: 'Pebble Lunchar - Minecraft 离线启动器',
      icon: path.join(ctx.APP_DIR, 'assets', 'logo.png')
    }, dirs, { kinds: (kinds && kinds.length ? kinds : ['desktop', 'startMenu']) }));
  });

  ipcMain.handle('shortcut-remove', (_e, kinds) => {
    const dirs = shortcutDirs();
    return sysconf.removeShortcuts(Object.assign({
      name: 'Pebble Lunchar', target: app.getPath('exe')
    }, dirs, { kinds: (kinds && kinds.length ? kinds : ['desktop', 'startMenu']) }));
  });

  /* ---------- 自动更新 ---------- */
  ipcMain.handle('update-check', async (_e, feedUrl) => {
    const url = String(feedUrl || ctx.getSysConf().updateFeed || '').trim();
    const r = await updater.checkUpdate({ feedUrl: url, currentVersion: app.getVersion() });
    if (r.ok && r.hasUpdate && Notification.isSupported()) {
      new Notification({
        title: 'Pebble Lunchar 有新版本 ' + r.latestVersion,
        body: '可在「设置 → 系统与更新」查看并下载'
      }).show();
    }
    return r;
  });

  ipcMain.handle('update-feed-set', (_e, url) => {
    ctx.patchSysConf({ updateFeed: String(url || '').trim() });
    return { ok: true, updateFeed: ctx.getSysConf().updateFeed };
  });

  /* ---------- 截图增强（分辨率元数据 + 按日期归档） ---------- */
  ipcMain.handle('shots-meta', (_e, gameDir) => {
    try {
      const items = shots.listWithMeta(gameDir);
      return { ok: true, items, stats: shots.stats(items) };
    } catch (e) { return { ok: false, error: e.message, items: [] }; }
  });
  ipcMain.handle('shots-organize', (_e, gameDir, mode) => {
    try { return shots.organize(gameDir, mode || 'month'); }
    catch (e) { return { ok: false, error: e.message, moved: 0 }; }
  });

  /* ---------- 找不到 Java 时自动下载一份 ----------
   * 装到 userData/java 下，和 .minecraft 分开：换游戏目录不会把已装的 Java 一起丢掉。 */
  ipcMain.handle('java-ensure', async (_e, o) => {
    const opt = o || {};
    const major = parseInt(opt.major, 10) || 0;
    if (!major) return { ok: false, error: '未指定需要的 Java 版本' };
    try {
      return await javadl.ensureJava({
        major, destRoot: JAVA_ROOT,
        onProgress: (p) => emit('java-progress', p)
      });
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('java-installed', () => ({ ok: true, items: javadl.installed(JAVA_ROOT) }));
  ipcMain.handle('java-remove', (_e, name) => javadl.remove(JAVA_ROOT, name));
};
