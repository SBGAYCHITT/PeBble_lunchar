// accountbook.js 单元测试（纯 Node，不依赖 Electron）
const assert = require('assert');
const ab = require('../accountbook');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('accountbook.test');
console.log('=================');

const A1 = { uuid: 'u1', name: 'Alice', kind: 'offline' };
const A2 = { uuid: 'u2', name: 'Bob', kind: 'microsoft', refreshToken: 'r' };

function storeOf(...accs) {
  return ab.normalize({ accounts: accs, activeId: accs.length ? accs[0].uuid : null }).store;
}

/* ---------------- kindOf ---------------- */
t('kindOf：显式 kind 优先', () => {
  assert.strictEqual(ab.kindOf({ kind: 'yggdrasil' }), 'yggdrasil');
});
t('kindOf：非法 kind 会被推断覆盖', () => {
  assert.strictEqual(ab.kindOf({ kind: 'nonsense' }), 'offline');
});
t('kindOf：有 refreshToken 判为微软', () => {
  assert.strictEqual(ab.kindOf({ refreshToken: 'x' }), 'microsoft');
});
t('kindOf：accessToken+clientToken 判为外置登录', () => {
  assert.strictEqual(ab.kindOf({ accessToken: 'a', clientToken: 'c' }), 'yggdrasil');
});
t('kindOf：裸 accessToken 判为微软', () => {
  assert.strictEqual(ab.kindOf({ accessToken: 'a' }), 'microsoft');
});
t('kindOf：什么都没有就是离线', () => {
  assert.strictEqual(ab.kindOf({}), 'offline');
  assert.strictEqual(ab.kindOf(null), 'offline');
});

/* ---------------- accountId / normalizeAccount ---------------- */
t('accountId：优先 uuid，其次 id', () => {
  assert.strictEqual(ab.accountId({ uuid: 'x' }), 'x');
  assert.strictEqual(ab.accountId({ id: 'y' }), 'y');
});
t('accountId：没有 uuid 时用名字派生离线 UUID', () => {
  const id = ab.accountId({ name: 'Alice' });
  assert.ok(id && id.length > 0);
  assert.strictEqual(id, ab.accountId({ name: 'Alice' }), '同一个名字应派生同一个 id');
});
t('accountId：彻底没信息返回空串', () => {
  assert.strictEqual(ab.accountId({}), '');
  assert.strictEqual(ab.accountId(null), '');
});
t('normalizeAccount：补全 uuid / kind / name', () => {
  const a = ab.normalizeAccount({ name: 'Alice' });
  assert.strictEqual(a.name, 'Alice');
  assert.strictEqual(a.kind, 'offline');
  assert.ok(a.uuid);
});
t('normalizeAccount：username 兼容成 name', () => {
  assert.strictEqual(ab.normalizeAccount({ uuid: 'u', username: 'Bob' }).name, 'Bob');
});
t('normalizeAccount：保留凭据字段', () => {
  const a = ab.normalizeAccount({ uuid: 'u', name: 'n', accessToken: 'tok', refreshToken: 'ref' });
  assert.strictEqual(a.accessToken, 'tok');
  assert.strictEqual(a.refreshToken, 'ref');
});
t('normalizeAccount：不保留 id 字段（统一成 uuid）', () => {
  const a = ab.normalizeAccount({ id: 'legacy', name: 'n' });
  assert.strictEqual(a.id, undefined);
  assert.strictEqual(a.uuid, 'legacy');
});
t('normalizeAccount：无效输入返回 null', () => {
  assert.strictEqual(ab.normalizeAccount(null), null);
  assert.strictEqual(ab.normalizeAccount('x'), null);
  assert.strictEqual(ab.normalizeAccount([]), null);
  assert.strictEqual(ab.normalizeAccount({}), null);
});
t('normalizeAccount：不修改传入对象', () => {
  const src = { name: 'Alice' };
  ab.normalizeAccount(src);
  assert.strictEqual(src.uuid, undefined);
  assert.strictEqual(src.kind, undefined);
});

/* ---------------- normalize ---------------- */
t('normalize：null 给空存储', () => {
  const r = ab.normalize(null);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.store.accounts, []);
  assert.strictEqual(r.store.activeId, null);
  assert.strictEqual(r.migrated, false);
});
t('normalize：securestore 的默认结构能原样吃下', () => {
  const r = ab.normalize({ v: 1, accounts: [], activeId: null });
  assert.strictEqual(r.store.accounts.length, 0);
  assert.strictEqual(r.migrated, false);
});
t('normalize：v2 结构正常读取', () => {
  const r = ab.normalize({ v: 2, accounts: [A1, A2], activeId: 'u2' });
  assert.strictEqual(r.store.accounts.length, 2);
  assert.strictEqual(r.store.activeId, 'u2');
  assert.strictEqual(r.migrated, false);
});
t('normalize 迁移：旧版单账户对象被包成列表', () => {
  const r = ab.normalize({ uuid: 'old', name: 'Legacy', accessToken: 't' });
  assert.strictEqual(r.migrated, true);
  assert.strictEqual(r.store.accounts.length, 1);
  assert.strictEqual(r.store.accounts[0].uuid, 'old');
  assert.strictEqual(r.store.activeId, 'old');
  assert.ok(r.warnings.some(w => w.includes('旧版')));
});
t('normalize：淘汰无效账户并给出提示', () => {
  const r = ab.normalize({ accounts: [A1, null, {}, 'x', A2], activeId: 'u1' });
  assert.strictEqual(r.store.accounts.length, 2);
});
t('normalize：同 uuid 去重且保留较新的一条', () => {
  const r = ab.normalize({
    accounts: [{ uuid: 'u1', name: 'Old' }, { uuid: 'u1', name: 'New' }], activeId: 'u1'
  });
  assert.strictEqual(r.store.accounts.length, 1);
  assert.strictEqual(r.store.accounts[0].name, 'New');
  assert.ok(r.warnings.some(w => w.includes('重复')));
});
t('normalize：activeId 指空时回退到首个并提示', () => {
  const r = ab.normalize({ accounts: [A1], activeId: 'ghost' });
  assert.strictEqual(r.store.activeId, 'u1');
  assert.ok(r.warnings.some(w => w.includes('不存在')));
});
t('normalize：没有账户时 activeId 为 null', () => {
  assert.strictEqual(ab.normalize({ accounts: [], activeId: 'ghost' }).store.activeId, null);
});
t('normalize：返回的 store 带当前 schema 版本', () => {
  assert.strictEqual(ab.normalize({ accounts: [A1] }).store.v, ab.SCHEMA);
});

/* ---------------- addAccount ---------------- */
t('addAccount：新增账户', () => {
  const r = ab.addAccount(ab.emptyStore(), A1);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.added, true);
  assert.strictEqual(r.store.accounts.length, 1);
});
t('addAccount：第一个账户自动成为活动账户', () => {
  const r = ab.addAccount(ab.emptyStore(), A1);
  assert.strictEqual(r.store.activeId, 'u1');
});
t('addAccount：后续账户不会抢走活动状态', () => {
  const s1 = ab.addAccount(ab.emptyStore(), A1).store;
  const s2 = ab.addAccount(s1, A2).store;
  assert.strictEqual(s2.activeId, 'u1');
  assert.strictEqual(s2.accounts.length, 2);
});
t('addAccount：同 uuid 视为替换而不是新增', () => {
  const s1 = ab.addAccount(ab.emptyStore(), A1).store;
  const r = ab.addAccount(s1, { uuid: 'u1', name: 'Alice2' });
  assert.strictEqual(r.added, false);
  assert.strictEqual(r.replaced, true);
  assert.strictEqual(r.store.accounts.length, 1);
  assert.strictEqual(r.store.accounts[0].name, 'Alice2');
});
t('addAccount：替换时保留位置与原有字段', () => {
  const s1 = storeOf(A1, A2);
  const r = ab.addAccount(s1, { uuid: 'u1', accessToken: 'newtok' });
  assert.strictEqual(r.store.accounts.length, 2);
  assert.strictEqual(r.store.accounts[0].uuid, 'u1', '应保持在第一位');
  assert.strictEqual(r.store.accounts[0].accessToken, 'newtok');
  assert.strictEqual(r.store.accounts[0].name, 'Alice', '原有名字不该丢');
});
t('addAccount：无效账户返回失败且不改动 store', () => {
  const s = ab.emptyStore();
  const r = ab.addAccount(s, {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.store.accounts.length, 0);
  assert.ok(r.error);
});
t('addAccount：不修改传入的 store（纯函数）', () => {
  const s = storeOf(A1);
  const before = s.accounts.length;
  ab.addAccount(s, A2);
  assert.strictEqual(s.accounts.length, before);
});

/* ---------------- removeAccount ---------------- */
t('removeAccount：按 uuid 删除', () => {
  const r = ab.removeAccount(storeOf(A1, A2), 'u1');
  assert.strictEqual(r.removed, true);
  assert.strictEqual(r.store.accounts.length, 1);
  assert.strictEqual(r.store.accounts[0].uuid, 'u2');
});
t('removeAccount：删除活动账户时顺延到下一个', () => {
  const r = ab.removeAccount(storeOf(A1, A2), 'u1');
  assert.strictEqual(r.wasActive, true);
  assert.strictEqual(r.store.activeId, 'u2');
});
t('removeAccount：删除非活动账户不动活动状态', () => {
  const r = ab.removeAccount(storeOf(A1, A2), 'u2');
  assert.strictEqual(r.wasActive, false);
  assert.strictEqual(r.store.activeId, 'u1');
});
t('removeAccount：删掉最后一个后 activeId 置空', () => {
  const r = ab.removeAccount(storeOf(A1), 'u1');
  assert.strictEqual(r.store.accounts.length, 0);
  assert.strictEqual(r.store.activeId, null);
});
t('removeAccount：uuid 不存在时 removed=false', () => {
  assert.strictEqual(ab.removeAccount(storeOf(A1), 'nope').removed, false);
});
t('removeAccount：空 store 不抛异常', () => {
  assert.strictEqual(ab.removeAccount(ab.emptyStore(), 'x').removed, false);
});

/* ---------------- setActive ---------------- */
t('setActive：切到存在的账户', () => {
  const r = ab.setActive(storeOf(A1, A2), 'u2');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.store.activeId, 'u2');
});
t('setActive：切到不存在的账户报错且不改动', () => {
  const s = storeOf(A1, A2);
  const r = ab.setActive(s, 'ghost');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.store.activeId, 'u1');
  assert.ok(r.error);
});

/* ---------------- updateAccount ---------------- */
t('updateAccount：可局部更新令牌', () => {
  const r = ab.updateAccount(storeOf(A1), 'u1', { accessToken: 'fresh' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.store.accounts[0].accessToken, 'fresh');
  assert.strictEqual(r.store.accounts[0].name, 'Alice');
});
t('updateAccount：补丁不能改 uuid', () => {
  const r = ab.updateAccount(storeOf(A1), 'u1', { uuid: 'hacked' });
  assert.strictEqual(r.store.accounts[0].uuid, 'u1');
});
t('updateAccount：name 传 null 时保留原名', () => {
  const r = ab.updateAccount(storeOf(A1), 'u1', { name: null });
  assert.strictEqual(r.store.accounts[0].name, 'Alice');
});
t('updateAccount：账户不存在时报错', () => {
  assert.strictEqual(ab.updateAccount(storeOf(A1), 'ghost', {}).ok, false);
});

/* ---------------- activeOf / findById ---------------- */
t('activeOf：返回活动账户对象', () => {
  assert.strictEqual(ab.activeOf(storeOf(A1, A2)).uuid, 'u1');
});
t('activeOf：activeId 失效时回退第一个', () => {
  const s = { v: 2, accounts: [A1, A2], activeId: 'ghost' };
  assert.strictEqual(ab.activeOf(s).uuid, 'u1');
});
t('activeOf：没有账户返回 null', () => {
  assert.strictEqual(ab.activeOf(ab.emptyStore()), null);
  assert.strictEqual(ab.activeOf(null), null);
});
t('findById：命中与未命中', () => {
  const s = storeOf(A1, A2);
  assert.strictEqual(ab.findById(s, 'u2').name, 'Bob');
  assert.strictEqual(ab.findById(s, 'x'), null);
  assert.strictEqual(ab.findById(null, 'u1'), null);
});

/* ---------------- accountForInstance ---------------- */
t('accountForInstance：优先用实例绑定的账户', () => {
  const s = storeOf(A1, A2); // 活动是 u1
  const r = ab.accountForInstance(s, { accountId: 'u2' });
  assert.strictEqual(r.account.uuid, 'u2');
  assert.strictEqual(r.source, 'bound');
});
t('accountForInstance：没绑定时用活动账户', () => {
  const r = ab.accountForInstance(storeOf(A1, A2), {});
  assert.strictEqual(r.account.uuid, 'u1');
  assert.strictEqual(r.source, 'active');
});
t('accountForInstance：绑定失效时回退活动账户并标记 stale', () => {
  const r = ab.accountForInstance(storeOf(A1, A2), { accountId: 'ghost' });
  assert.strictEqual(r.account.uuid, 'u1');
  assert.strictEqual(r.source, 'active');
  assert.strictEqual(r.stale, true);
  assert.strictEqual(r.missingId, 'ghost');
});
t('accountForInstance：一个账户都没有时返回 none', () => {
  const r = ab.accountForInstance(ab.emptyStore(), {});
  assert.strictEqual(r.account, null);
  assert.strictEqual(r.source, 'none');
});
t('accountForInstance：store 为 null 不抛异常', () => {
  assert.strictEqual(ab.accountForInstance(null, {}).source, 'none');
});

/* ---------------- staleBindings ---------------- */
t('staleBindings：找出绑定失效的实例', () => {
  const s = storeOf(A1);
  const list = ab.staleBindings(s, [{ id: 'i1', name: '主世界', accountId: 'u1' }, { id: 'i2', name: '测试', accountId: 'ghost' }]);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].instanceId, 'i2');
  assert.strictEqual(list[0].name, '测试');
});
t('staleBindings：未绑定的实例不算失效', () => {
  assert.deepStrictEqual(ab.staleBindings(storeOf(A1), [{ id: 'i1' }]), []);
});
t('staleBindings：非数组输入不抛异常', () => {
  assert.deepStrictEqual(ab.staleBindings(storeOf(A1), null), []);
});

/* ---------------- summary ---------------- */
t('summary：统计总数与分类', () => {
  const s = storeOf(A1, A2, { uuid: 'u3', name: 'C', kind: 'yggdrasil' });
  const r = ab.summary(s, []);
  assert.strictEqual(r.total, 3);
  assert.strictEqual(r.byKind.offline, 1);
  assert.strictEqual(r.byKind.microsoft, 1);
  assert.strictEqual(r.byKind.yggdrasil, 1);
});
t('summary：报告活动账户', () => {
  assert.strictEqual(ab.summary(storeOf(A1, A2), []).active.uuid, 'u1');
});
t('summary：统计绑定与失效数量', () => {
  const s = storeOf(A1);
  const r = ab.summary(s, [
    { id: 'i1', accountId: 'u1' }, { id: 'i2', accountId: 'ghost' }, { id: 'i3' }
  ]);
  assert.strictEqual(r.bound, 2);
  assert.strictEqual(r.unbound, 1);
  assert.strictEqual(r.stale, 1);
});
t('summary：没有实例时也不报错', () => {
  const r = ab.summary(storeOf(A1));
  assert.strictEqual(r.bound, 0);
  assert.strictEqual(r.unbound, 0);
});
t('summary：空账户簿', () => {
  const r = ab.summary(ab.emptyStore(), []);
  assert.strictEqual(r.total, 0);
  assert.strictEqual(r.active, null);
});

/* ---------------- 端到端组合 ---------------- */
t('组合：添加→切换→绑定→删账户→回退，链路自洽', () => {
  let s = ab.emptyStore();
  s = ab.addAccount(s, A1).store;
  s = ab.addAccount(s, A2).store;
  s = ab.setActive(s, 'u2').store;
  assert.strictEqual(ab.accountForInstance(s, { accountId: 'u1' }).account.uuid, 'u1');

  s = ab.removeAccount(s, 'u1').store;
  const r = ab.accountForInstance(s, { accountId: 'u1' });
  assert.strictEqual(r.stale, true);
  assert.strictEqual(r.account.uuid, 'u2', '应回退到活动账户 u2');
  assert.strictEqual(ab.summary(s, [{ id: 'i1', accountId: 'u1' }]).stale, 1);
});
t('组合：旧版单账户升级后仍能正常取到账户', () => {
  const s = ab.normalize({ uuid: 'old', name: 'Legacy', accessToken: 't', clientToken: 'c' }).store;
  const r = ab.accountForInstance(s, {});
  assert.strictEqual(r.account.uuid, 'old');
  assert.strictEqual(r.account.kind, 'yggdrasil');
});

console.log('=================');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
