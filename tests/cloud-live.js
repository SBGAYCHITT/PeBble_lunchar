// 云端后端的**活体**契约验证（会真连外网，所以不进 npm test）。
//
// 为什么单独一个脚本：
//   tests/cloud.test.js 桩掉了 fetch，验的是「状态码 → 行为」的映射，够稳但证明不了
//   线上服务还认这套契约。这个脚本用**真实代码路径**（pebblecloud.js 原样 require）打真服务，
//   专门用来回答一个问题：后端改过之后，客户端还连得上吗。
//
// 做法：只用一个**已有**的测试账号登录，只在自己的一把临时 key 上做增删查（跑完删干净）。
//   ⚠️ 刻意不 register：每次跑都建一个新账号，服务端会慢慢堆垃圾。
//      要测注册路径的话，把用户名改成想要的再跑，并且自己承担这个账号留在服务端。
//
// 用法：
//   node tests/cloud-live.js                    # 用默认测试账号
//   PL_LIVE_USER=xxx PL_LIVE_PASS=yyy node tests/cloud-live.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const USER = process.env.PL_LIVE_USER || 'zz_pl_probe_temp';
const PASS = process.env.PL_LIVE_PASS || 'probe-pass-2026';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log(' FAIL ' + name + ' -> ' + e.message); }
}
async function ta(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log(' FAIL ' + name + ' -> ' + e.message); }
}

/* 只桩 electron：真品在无头 Node 里加载不了（它要 app.getPath / safeStorage）。
   safeStorage 设成「不可用」，顺带验证降级路径在真网络下也不出问题。 */
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-cloud-live-'));
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') {
    return {
      app: { getPath: (n) => (n === 'userData' ? UD : path.join(UD, n)) },
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: (s) => Buffer.from(String(s), 'utf8'),
        decryptString: (b) => Buffer.from(b).toString('utf8')
      }
    };
  }
  return origLoad.apply(this, arguments);
};

const cloud = require('../pebblecloud');
cloud.configure({ userData: UD });

const KEY = '__live_check__';

(async () => {
  console.log('云端活体验证');
  console.log('  服务端 : ' + cloud.endpointOf());
  console.log('  账号   : ' + USER);
  console.log('');

  await ta('登录成功（用户名密码 → token）', async () => {
    const r = await cloud.login(USER, PASS);
    assert.strictEqual(r.username, USER, '返回的用户名是 ' + r.username);
    assert.strictEqual(cloud.status().loggedIn, true);
  });

  await ta('登录态里不含 token（token 只留在主进程）', () => {
    const s = cloud.status();
    assert.ok(!('token' in s), JSON.stringify(s));
  });

  await ta('探活：可达 + 登录有效', async () => {
    const p = await cloud.probe();
    assert.deepStrictEqual([p.reachable, p.ok, p.loggedIn], [true, true, true], JSON.stringify(p));
  });

  await ta('写 → 读 → 列表 → 删（真实往返）', async () => {
    const payload = { hello: 'world', n: 42, nested: { a: [1, 2, 3] }, cn: '中文能不能存' };
    await cloud.putBlob(KEY, payload);
    const back = await cloud.getBlob(KEY);
    assert.deepStrictEqual(back, payload, '读回来的和写进去的不一样：' + JSON.stringify(back));

    const keys = await cloud.listBlobs();
    assert.ok(keys.includes(KEY), '列表里没有 ' + KEY + '：' + JSON.stringify(keys));

    await cloud.deleteBlob(KEY);
    assert.strictEqual(await cloud.getBlob(KEY), null, '删掉之后还读得到');
    const after = await cloud.listBlobs();
    assert.ok(!after.includes(KEY), '删掉之后列表里还在：' + JSON.stringify(after));
  });

  await ta('不存在的 key 返回 null 而不是抛错', async () => {
    assert.strictEqual(await cloud.getBlob('__definitely_not_here__'), null);
  });

  await ta('错密码被识别成「密码错误」而不是「登录已过期」', async () => {
    let got = null;
    try { await cloud.login(USER, PASS + '_wrong'); } catch (e) { got = e; }
    assert.ok(got, '居然登录成功了');
    assert.strictEqual(got.code, 'CLOUD_HTTP', 'code=' + got.code);
    assert.ok(/密码|unauthorized|不存在/.test(got.message), '文案=' + got.message);
    // 关键：不能把别人（上面那次成功的）登录态给清了
    assert.strictEqual(cloud.status().loggedIn, true, '错密码把好好的登录态清掉了');
  });

  await ta('登出后本地读不到登录态', () => {
    cloud.logout();
    assert.strictEqual(cloud.status().loggedIn, false);
  });

  console.log('\n' + (fail === 0 ? '★ 活体契约全部通过' : `★ 活体契约有 ${fail} 项失败`));
  process.exit(fail ? 1 : 0);
})();
