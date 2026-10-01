// 账户：离线 / Yggdrasil / 微软登录，以及凭据安全存储、头像
const accounts = require('../accounts');
const securestore = require('../securestore');
const avatar = require('../avatar');

module.exports = function register(ctx) {
  const { ipcMain, emit } = ctx;

  ipcMain.handle('account-offline', (_e, name) => accounts.offlineAccount(name));

  ipcMain.handle('account-yggdrasil', async (_e, server, user, pass) => {
    try { return await accounts.yggdrasilLogin(server, user, pass); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('account-microsoft', async (_e, clientId) => {
    try {
      return await accounts.msLogin(clientId,
        (code) => emit('ms-code', code),
        () => emit('ms-code-poll'));
    } catch (e) { return { ok: false, error: e.message }; }
  });

  /* ---------- 凭据安全存储（safeStorage / DPAPI，替代明文 localStorage） ---------- */
  ipcMain.handle('account-store-load', () => {
    const r = securestore.load();
    return { ok: r.ok, data: r.data, degraded: r.degraded, encrypted: securestore.canEncrypt(), error: r.error };
  });
  ipcMain.handle('account-store-save', (_e, data) => securestore.save(data || {}));
  ipcMain.handle('account-store-clear', () => securestore.clear());

  /* ---------- 头像（主进程抓图，规避 CSP） ---------- */
  ipcMain.handle('av-get', async (_e, o) => {
    try { return { ok: true, data: await avatar.getAvatar(o || {}) }; }
    catch (e) { return { ok: false, error: e.message, data: null }; }
  });
  ipcMain.handle('av-batch', async (_e, list, size, kind) => {
    try { return { ok: true, map: await avatar.getAvatars(list, size, kind) }; }
    catch (e) { return { ok: false, error: e.message, map: {} }; }
  });
  ipcMain.handle('av-clear', () => avatar.clearCache());
  ipcMain.handle('av-cache-size', () => avatar.cacheSize());
};
