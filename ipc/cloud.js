// 云端后端（PeBble Cloud）的 IPC 接口
//
// 后端：Deno Deploy（pebble-backend-deno.ts，不在本仓库）
// 客户端：../pebblecloud.js（register/login/putBlob/getBlob/listBlobs/deleteBlob）
// 用途：云账号 + 云存档，对接「账户迁移」（V4 路线图第 5 项）
// 注册方式：在 ipc/index.js 的 DOMAINS 里加 './cloud'，本文件导出 register(ctx)。
//
// 为什么这里不用 util 的 safe()，而是自己写 errOut：
//   safe() 只把 e.message 交出去，e.code 会被丢掉。而云端这一路要区分
//   「登录过期（CLOUD_UNAUTHORIZED）」「没登录（CLOUD_NOAUTH）」「网络不通（CLOUD_NET）」
//   —— 界面拿到 code 才能决定是切回登录视图、还是只弹个重试提示。
//   （ipc/world.js 的合并接口因为同样的理由也是自己写的 errOut。）
const cloud = require('../pebblecloud');

/** 「账户配置」这个云存档固定的 key。别的用途一律走通用 cloud-put/cloud-get。 */
const PROFILES_KEY = 'profiles';

module.exports = function register(ctx) {
  const { ipcMain, userData } = ctx;

  // 必须先把 userData 交给客户端：它也负责决定 token 落盘在哪。
  // 刻意不从 cloud 内部去调 app.getPath —— 那样这个域就先得依赖 Electron 才能加载。
  cloud.configure({ userData });

  const errOut = (e) => ({
    ok: false, error: e.message,
    code: e.code || null
  });

  /**
   * 把「抛错 → {ok:false,error,code}」这一步包起来。
   * ⚠️ 刻意写成返回 handler 的工厂、而不是 `const handler = (ch, fn) => ipcMain.handle(ch, ...)`：
   *   tests/ipc-contract.test.js 是**静态正则**扫描 `ipcMain.handle('通道名'` 来对账
   *   preload 与主进程的，包一层间接之后它扫不到通道名，会把所有通道判成「调用了但没注册」。
   *   实测踩过。所以每个通道名都必须是字面量、直接出现在 ipcMain.handle 的第一个参数位。
   */
  const wrap = (fn) => async (...a) => {
    try { return await fn(...a); } catch (e) { return errOut(e); }
  };

  /**
   * 登录态快照给渲染层：**不含 token**（token 只在主进程和加密存储里）。
   * persistent=false 表示系统不支持加密存储，登录态只在内存里，重启要重登。
   */
  ipcMain.handle('cloud-status', wrap(() => cloud.status()));

  /** 探活 + 验证当前 token 是否还有效（会真发一次请求）。 */
  ipcMain.handle('cloud-check', wrap(() => cloud.probe()));

  /** 注册。成功即登录（服务端注册不回 token，客户端内部会接着登一次）。 */
  ipcMain.handle('cloud-register', wrap((_e, username, password) => cloud.register(username, password)));

  /** 登录。 */
  ipcMain.handle('cloud-login', wrap((_e, username, password) => cloud.login(username, password)));

  /** 登出：清加密存储里的 token + 元信息文件。 */
  ipcMain.handle('cloud-logout', wrap(() => { cloud.logout(); return { ok: true }; }));

  /* ---------- 通用云存档（任意 JSON） ---------- */

  ipcMain.handle('cloud-put', wrap((_e, key, data) => cloud.putBlob(key, data)));

  /** @returns {any|null} 不存在返回 null（与「出错」区分开） */
  ipcMain.handle('cloud-get', wrap((_e, key) => cloud.getBlob(key)));

  ipcMain.handle('cloud-list', wrap(() => cloud.listBlobs()));

  ipcMain.handle('cloud-delete', wrap((_e, key) => cloud.deleteBlob(key)));

  /* ---------- 账户迁移专用快捷接口 ---------- */

  /**
   * 上传账户配置。
   * 不传 data 时由**主进程自己去读** securestore，不让这份带凭据的数据绕一圈渲染层
   * —— 少一次跨进程搬运，也少一个「渲染层能塞任意内容进云存档」的口子。
   * ⚠️ 这份数据里含 Minecraft 账户的 accessToken / refreshToken，是**故意**要传到云端
   *    （账户迁移就得这样），所以界面上必须明说，不能默默传。
   */
  ipcMain.handle('cloud-upload-profiles', wrap((_e, data) => {
    let payload = data;
    if (!payload) {
      const r = require('../securestore').load();
      if (!r || !r.ok) {
        const e = new Error('读本地账户配置失败：' + ((r && r.error) || '未知原因'));
        e.code = 'CLOUD_LOCAL';
        throw e;
      }
      payload = r.data;
    }
    return cloud.putBlob(PROFILES_KEY, payload).then(() => ({
      ok: true, key: PROFILES_KEY, accounts: (payload.accounts || []).length
    }));
  }));

  /** 从云端下载账户配置（不存在返回 null）。写回 securestore 由渲染层确认后再走 account-store-save。 */
  ipcMain.handle('cloud-download-profiles', wrap(() => cloud.getBlob(PROFILES_KEY)));

  /** 云端那份账户配置的概览：只报数量和时间，不回传凭据本体。 */
  ipcMain.handle('cloud-profiles-info', wrap(async () => {
    const data = await cloud.getBlob(PROFILES_KEY);
    if (!data) return { exists: false };
    return {
      exists: true,
      accounts: Array.isArray(data.accounts) ? data.accounts.length : 0,
      activeId: data.activeId || null,
      // 只给名字和类型，够界面显示「里面是谁」；凭据本体一律不外传
      names: (Array.isArray(data.accounts) ? data.accounts : [])
        .map((a) => ({ name: a && a.name, type: a && a.type }))
    };
  }));
};
