'use strict';
/**
 * accountbook.js — 多账户簿
 *
 * 定位：把「账户列表 + 当前活动账户 + 实例绑定哪个账户」这套逻辑从 `renderer.js` 里
 * 搬到主进程，成为**可单测的纯逻辑**。原来这套判断散在前端（含一段没人验证过的旧格式迁移），
 * 既测不到，也容易在 UI 改动时被改坏。
 *
 * 存储结构（落在 `securestore.js` 的加密文件里，`v` 为结构版本）：
 * ```
 * { v: 2, accounts: [ {uuid, name, kind, ...凭据字段} ], activeId: 'uuid' | null }
 * ```
 *
 * 实例绑定**不放这里**，而是放在 `instances.js` 的实例对象上（`inst.accountId`）：
 * 删除实例时绑定自然消失，不会产生指向不存在实例的孤儿绑定。
 *
 * 设计约束：
 *   - 全部是**纯函数**：不改传入的 store，一律返回新的 store（浅拷贝）。
 *   - 不联网、不读盘 —— 落盘由 `ipc/accountbook.js` 负责。
 *
 * ⚠️ 坑：旧版本存的是**单个账户对象**（不是 `{accounts:[]}`），
 *   `normalize()` 必须能吃下这种格式并迁成 v2，否则老用户升级后账号会"消失"。
 *   `renderer.js` 里曾有一段等价的手写迁移，但它只处理了"第一次读"的情况。
 */

const accounts = require('./accounts');

/** 当前存储结构版本 */
const SCHEMA = 2;
/** 支持的账户类型 */
const KINDS = ['offline', 'yggdrasil', 'microsoft'];

/**
 * 推断账户类型。
 * @param {object} a
 * @returns {string} KINDS 之一
 */
function kindOf(a) {
  const o = a || {};
  if (typeof o.kind === 'string' && KINDS.indexOf(o.kind) >= 0) return o.kind;
  // 微软：有 refresh token 或微软专用字段
  if (o.refreshToken || o.msAccessToken || o.microsoftToken) return 'microsoft';
  // 外置登录：同时有 accessToken 与 clientToken 且指定了认证服务器
  if (o.accessToken && (o.clientToken || o.authServer || o.server)) return 'yggdrasil';
  if (o.accessToken && !o.clientToken) return 'microsoft';
  return 'offline';
}

/**
 * 取账户的稳定唯一标识。
 * @param {object} a
 * @returns {string}
 */
function accountId(a) {
  const o = a || {};
  if (o.uuid) return String(o.uuid);
  if (o.id) return String(o.id);
  const name = String(o.name || o.username || '').trim();
  if (!name) return '';
  try { return accounts.offlineUUID(name); } catch { return 'offline:' + name; }
}

/**
 * 规范化一个账户对象。
 * @param {object} raw
 * @returns {object|null} 无效时返回 null
 */
function normalizeAccount(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = String(raw.name || raw.username || '').trim();
  const uuid = accountId(raw);
  if (!name && !uuid) return null;
  const out = Object.assign({}, raw);
  delete out.id;
  out.uuid = uuid;
  out.name = name || uuid;
  out.kind = kindOf(raw);
  return out;
}

/** 空存储 */
function emptyStore() {
  return { v: SCHEMA, accounts: [], activeId: null };
}

/**
 * 迁移并规范化存储。能吃下 v2 结构、空的默认结构、以及**旧版单账户对象**。
 *
 * @param {object} raw
 * @returns {{ok:boolean, store:object, migrated:boolean, warnings:string[]}}
 */
function normalize(raw) {
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: true, store: emptyStore(), migrated: false, warnings };
  }

  let list = null;
  let activeId = null;
  let migrated = false;

  if (Array.isArray(raw.accounts)) {
    list = raw.accounts;
    activeId = raw.activeId || null;
  } else if (raw.uuid || raw.name || raw.username) {
    // ⚠️ 旧版：整个对象就是一个账户
    list = [raw];
    migrated = true;
    warnings.push('旧版单账户数据已迁移为多账户结构');
  } else {
    return { ok: true, store: emptyStore(), migrated: false, warnings };
  }

  const seen = new Map();
  const dropped = [];
  for (const item of list) {
    const a = normalizeAccount(item);
    if (!a) { dropped.push(item); continue; }
    if (seen.has(a.uuid)) {
      dropped.push(seen.get(a.uuid));
      warnings.push('账户 ' + a.uuid + ' 重复，保留较新的一条');
    }
    // 后者覆盖前者：同时存在时，后加入的多半是刷新过凭据的那份
    seen.set(a.uuid, a);
  }
  const accs = [...seen.values()];

  if (activeId && !seen.has(String(activeId))) {
    warnings.push('活动账户 ' + activeId + ' 不存在，已回退');
    activeId = null;
  }
  if (!activeId) {
    // 迁移过来的单账户直接设为活动
    activeId = accs.length ? accs[0].uuid : null;
  }

  return {
    ok: true,
    store: { v: SCHEMA, accounts: accs, activeId },
    migrated,
    warnings
  };
}

/**
 * 按 uuid 查账户。
 * @param {object} store
 * @param {string} uuid
 * @returns {object|null}
 */
function findById(store, uuid) {
  if (!store || !uuid) return null;
  const list = Array.isArray(store.accounts) ? store.accounts : [];
  const key = String(uuid);
  for (const a of list) if (String(a.uuid) === key) return a;
  return null;
}

/**
 * 当前活动账户。
 * @param {object} store
 * @returns {object|null}
 */
function activeOf(store) {
  if (!store) return null;
  const found = findById(store, store.activeId);
  if (found) return found;
  const list = Array.isArray(store.accounts) ? store.accounts : [];
  return list.length ? list[0] : null;
}

/**
 * 新增（或替换同 uuid 的）账户。
 * @param {object} store
 * @param {object} raw
 * @returns {{ok:boolean, store:object, added:boolean, replaced:boolean, error?:string}}
 */
function addAccount(store, raw) {
  const base = normalize(store).store;
  const acc = normalizeAccount(raw);
  if (!acc) return { ok: false, store: base, added: false, replaced: false, error: '账户数据无效' };

  const list = base.accounts.slice();
  const i = list.findIndex(a => String(a.uuid) === acc.uuid);
  const replaced = i >= 0;
  if (replaced) {
    const merged = Object.assign({}, list[i], acc);
    // `normalizeAccount` 在调用方没给名字时会用 uuid 兜底；
    // 替换场景下不该让这个兜底名盖掉原本的真实名字（局部更新令牌时最常见）
    if (acc.name === acc.uuid && list[i].name && list[i].name !== list[i].uuid) {
      merged.name = list[i].name;
    }
    list[i] = merged;
  } else {
    list.push(acc);
  }

  // 之前没有账户时，新加的直接成为活动账户
  const activeId = base.activeId || acc.uuid;
  return { ok: true, store: { v: SCHEMA, accounts: list, activeId }, added: !replaced, replaced };
}

/**
 * 删除账户。
 * @param {object} store
 * @param {string} uuid
 * @returns {{ok:boolean, store:object, removed:boolean, wasActive:boolean}}
 */
function removeAccount(store, uuid) {
  const base = normalize(store).store;
  const key = String(uuid || '');
  const list = base.accounts.filter(a => String(a.uuid) !== key);
  const removed = list.length !== base.accounts.length;
  const wasActive = String(base.activeId || '') === key;
  // 删掉的正好是活动账户 → 顺延到第一个；一个都不剩就置空
  const activeId = wasActive ? (list.length ? list[0].uuid : null) : base.activeId;
  return { ok: true, store: { v: SCHEMA, accounts: list, activeId: activeId || null }, removed, wasActive };
}

/**
 * 切换活动账户。
 * @param {object} store
 * @param {string} uuid
 * @returns {{ok:boolean, store:object, error?:string}}
 */
function setActive(store, uuid) {
  const base = normalize(store).store;
  const found = findById(base, uuid);
  if (!found) return { ok: false, store: base, error: '账户不存在: ' + uuid };
  return { ok: true, store: { v: SCHEMA, accounts: base.accounts, activeId: found.uuid } };
}

/**
 * 局部更新账户字段（令牌刷新后回写、改名等）。
 * @param {object} store
 * @param {string} uuid
 * @param {object} patch
 * @returns {{ok:boolean, store:object, updated:boolean, error?:string}}
 */
function updateAccount(store, uuid, patch) {
  const base = normalize(store).store;
  const i = base.accounts.findIndex(a => String(a.uuid) === String(uuid || ''));
  if (i < 0) return { ok: false, store: base, updated: false, error: '账户不存在: ' + uuid };
  const list = base.accounts.slice();
  const merged = Object.assign({}, list[i], patch || {});
  // 不允许补丁把 uuid 改掉（那会让活动账户与绑定指空）
  merged.uuid = list[i].uuid;
  if (merged.name === undefined || merged.name === null) merged.name = list[i].name;
  list[i] = merged;
  return { ok: true, store: { v: SCHEMA, accounts: list, activeId: base.activeId }, updated: true };
}

/**
 * 该实例该用哪个账户。
 *
 * 优先级：实例绑定的账户 → 当前活动账户 → 没有。
 * 绑定的账户已被删除时**回退到活动账户**并标记 `stale`（而不是直接启动失败）。
 *
 * @param {object} store
 * @param {{accountId?:string|null}} inst
 * @returns {{account:object|null, source:'bound'|'active'|'none', stale?:boolean, missingId?:string}}
 */
function accountForInstance(store, inst) {
  const base = normalize(store).store;
  const boundId = inst && inst.accountId ? String(inst.accountId) : '';
  if (boundId) {
    const bound = findById(base, boundId);
    if (bound) return { account: bound, source: 'bound' };
    const act = activeOf(base);
    return { account: act, source: act ? 'active' : 'none', stale: true, missingId: boundId };
  }
  const act = activeOf(base);
  return { account: act, source: act ? 'active' : 'none' };
}

/**
 * 找出绑定了不存在的账户的实例（给 UI 提示用）。
 * @param {object} store
 * @param {Array<object>} instances
 * @returns {Array<{instanceId:string, name:string, accountId:string}>}
 */
function staleBindings(store, instances) {
  const base = normalize(store).store;
  const out = [];
  for (const inst of (Array.isArray(instances) ? instances : [])) {
    if (!inst || !inst.accountId) continue;
    if (!findById(base, inst.accountId)) {
      out.push({ instanceId: inst.id, name: inst.name || inst.id, accountId: String(inst.accountId) });
    }
  }
  return out;
}

/**
 * 账户簿概况。
 * @param {object} store
 * @param {Array<object>} [instances]
 * @returns {{total:number, byKind:Record<string,number>, active:object|null,
 *   bound:number, unbound:number, stale:number}}
 */
function summary(store, instances) {
  const base = normalize(store).store;
  const byKind = { offline: 0, yggdrasil: 0, microsoft: 0 };
  for (const a of base.accounts) {
    const k = KINDS.indexOf(a.kind) >= 0 ? a.kind : 'offline';
    byKind[k]++;
  }
  const insts = Array.isArray(instances) ? instances : [];
  const bound = insts.filter(i => i && i.accountId).length;
  const stale = staleBindings(base, insts).length;
  return {
    total: base.accounts.length,
    byKind,
    active: activeOf(base),
    bound,
    unbound: insts.length - bound,
    stale
  };
}

module.exports = {
  SCHEMA, KINDS,
  kindOf, accountId, normalizeAccount, emptyStore,
  normalize, findById, activeOf,
  addAccount, removeAccount, setActive, updateAccount,
  accountForInstance, staleBindings, summary
};
