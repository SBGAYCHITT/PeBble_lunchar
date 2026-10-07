// 多账户并行 IPC（V4 第五组 · R14）
//
// 职责：把 accountbook 的「账户列表 + 活动账户 + 实例绑定」这套纯逻辑接到渲染层，
// 替掉 renderer.js 里那段**没人验证过的旧格式迁移**（它只处理了"第一次读"的情况）。
//
// 设计取舍 —— 为什么这里**不**做"主进程权威副本"：
//   `securestore` 已经由渲染层通过 `account-store-load/save` 持有，凭据读写路径成熟。
//   本组只加"多账户书"的逻辑层，入参带 store、出参返回新 store，**不改变落盘归属**。
//   一次只做一层变更，避免在新增四个功能的同时重写登录链路。
//
// 实例绑定放在 `instances.js` 的 `inst.accountId` 上（删实例时绑定自然消失），
// 因此 `acct-bind` 实际是写实例而不是写账户簿。
const accountbook = require('../accountbook');
const instances = require('../instances');
const { safe } = require('./util');

/** 账户簿里不该回传给渲染层的字段（凭据只留在加密文件里） */
const SECRETS = ['accessToken', 'refreshToken', 'password', 'clientToken', 'msAccessToken', 'microsoftToken'];

/** 去掉凭据字段，只留展示与逻辑需要的部分 */
function desensitize(store) {
  const list = (store && store.accounts) || [];
  return {
    v: store ? store.v : accountbook.SCHEMA,
    activeId: store ? store.activeId : null,
    accounts: list.map((a) => {
      const out = Object.assign({}, a);
      for (const k of SECRETS) delete out[k];
      out.hasSecret = SECRETS.some((k) => !!a[k]);
      return out;
    })
  };
}

module.exports = function register(ctx) {
  const { ipcMain, userData } = ctx;

  /** 读实例表（给 summary / stale / for-instance 用） */
  function instList() {
    try { return instances.list({ root: userData }).instances || []; }
    catch { return []; }
  }

  /**
   * 迁移 + 规范化。能吃下 v2 结构、默认空结构、**旧版单账户对象**。
   * @param {object} raw securestore.load() 拿到的 data
   */
  ipcMain.handle('acct-normalize', safe((_e, raw) => {
    const r = accountbook.normalize(raw);
    return {
      ok: true,
      store: r.store,
      view: desensitize(r.store),
      migrated: r.migrated,
      warnings: r.warnings,
      schema: accountbook.SCHEMA,
      kinds: accountbook.KINDS
    };
  }));

  /** 新增（或替换同 uuid 的）账户。令牌刷新回写也走这里。 */
  ipcMain.handle('acct-add', safe((_e, o) => {
    const opt = o || {};
    const r = accountbook.addAccount(opt.store, opt.account);
    return {
      ok: r.ok, error: r.error,
      store: r.store, view: desensitize(r.store),
      added: r.added, replaced: r.replaced
    };
  }));

  /** 删除账户 */
  ipcMain.handle('acct-remove', safe((_e, o) => {
    const opt = o || {};
    const r = accountbook.removeAccount(opt.store, opt.uuid);
    return {
      ok: true, store: r.store, view: desensitize(r.store),
      removed: r.removed, wasActive: r.wasActive
    };
  }));

  /** 切换活动账户 */
  ipcMain.handle('acct-set-active', safe((_e, o) => {
    const opt = o || {};
    const r = accountbook.setActive(opt.store, opt.uuid);
    return { ok: r.ok, error: r.error, store: r.store, view: desensitize(r.store) };
  }));

  /** 局部更新（改名 / 回写令牌） */
  ipcMain.handle('acct-update', safe((_e, o) => {
    const opt = o || {};
    const r = accountbook.updateAccount(opt.store, opt.uuid, opt.patch);
    return { ok: r.ok, error: r.error, store: r.store, view: desensitize(r.store), updated: r.updated };
  }));

  /** 账户簿概况 + 绑定统计（顺带列出绑空了的实例，UI 上要提醒） */
  ipcMain.handle('acct-summary', safe((_e, o) => {
    const opt = o || {};
    const list = opt.instances || instList();
    const s = accountbook.summary(opt.store, list);
    return {
      ok: true,
      summary: Object.assign({}, s, { activeName: s.active ? s.active.name : null }),
      stale: accountbook.staleBindings(opt.store, list),
      instances: list.map((i) => ({
        id: i.id, name: i.name, accountId: i.accountId || null,
        version: i.version || '', loader: i.loader || ''
      }))
    };
  }));

  /**
   * 这个实例该用哪个账户。
   * 绑定失效时回退到活动账户并带 `stale`（而不是直接启动失败）。
   * @param {{store:object, id:string}} o
   */
  ipcMain.handle('acct-for-instance', safe((_e, o) => {
    const opt = o || {};
    let inst = null;
    if (opt.id) {
      try { inst = instances.get({ root: userData, id: opt.id }); } catch { inst = null; }
    } else if (opt.inst) {
      inst = opt.inst;
    }
    const r = accountbook.accountForInstance(opt.store, inst);
    return {
      ok: true,
      instanceId: opt.id || (inst && inst.id) || null,
      source: r.source,
      stale: !!r.stale,
      missingId: r.missingId || null,
      // 注意：这里必须整份用脱敏后的副本 —— 若先 Object.assign 全量再覆盖，
      // 被 delete 掉的凭据字段是**不会**从目标对象上消失的。
      account: r.account ? desensitize({ accounts: [r.account] }).accounts[0] : null
    };
  }));

  /**
   * 把实例绑定到某个账户（accountId 传 null 表示跟随活动账户）。
   * 写的是实例表，不是账户簿 —— 所以删账户不会留下孤儿绑定记录。
   * @param {{id:string, accountId:string|null}} o
   */
  ipcMain.handle('acct-bind', safe((_e, o) => {
    const opt = o || {};
    if (!opt.id) return { ok: false, error: '没有指定实例。' };
    const accountId = opt.accountId ? String(opt.accountId) : null;
    const inst = instances.update({ root: userData, id: opt.id, patch: { accountId } });
    return { ok: true, instance: { id: inst.id, name: inst.name, accountId: inst.accountId || null } };
  }));
};
