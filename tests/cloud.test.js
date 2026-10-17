// pebblecloud.js 的无头单测。
//
// 为什么值得单独测：这个模块是**唯一一个会往外网发凭据**的地方（用户名 + 密码），
// 而且它的错误分类直接影响用户看到什么话 ——
//   · 401 有两种含义（密码错误 / 登录过期），搞混就会「输错密码被提示登录过期」
//     或者更糟：把好好的登录态清掉；
//   · fetch 抛出来的 'fetch failed' 对用户零信息量，必须翻译成能照着做的提示。
// 这些都不该靠连真服务去验（会把测试变成联网测试，还会在服务端留下垃圾账号），
// 所以这里桩掉 electron 与 fetch，逐条验状态码 → 行为的映射。
//
// 真实服务端的契约另外用一次性账号实测锁定过，形状记在 pebblecloud.js 文件头。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ' -> ' + e.message); }
}
function ta(name, fn) {
  return (async () => {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + ' -> ' + e.message); }
  })();
}
/**
 * 断言「必须抛错，且 code 对得上」。
 * **刻意不把异常抛给调用方**：抛出去会让这一组后面的用例全部崩掉（整个进程以
 * unhandled rejection 退出），排查时只能看到第一条失败 —— 那不是回归测试该有的样子。
 * 返回兜底的空 Error，调用方读 .message 不会二次崩。
 */
async function expectCode(fn, code, name) {
  let got = null;
  try { await fn(); } catch (e) { got = e; }
  t(name, () => {
    assert.ok(got, '没有抛错');
    assert.strictEqual(got.code, code, 'code=' + got.code + ' 期望 ' + code + '（' + got.message + '）');
  });
  return got || new Error('');
}

/* ---------------- electron 桩件 ---------------- */
/** safeStorage 开关，逐条用例可翻转（模拟「系统不支持加密存储」） */
let ENC = true;
let UD = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-cloud-'));

const electronStub = {
  app: { getPath: (n) => (n === 'userData' ? UD : path.join(UD, n)) },
  safeStorage: {
    isEncryptionAvailable: () => ENC,
    // 真品用的是 DPAPI；这里用可逆前缀冒充，只为验证「密文落盘 / 明文不落盘」这个行为
    encryptString: (s) => Buffer.from('ENC:' + String(s), 'utf8'),
    decryptString: (b) => {
      const s = Buffer.from(b).toString('utf8');
      if (!s.startsWith('ENC:')) throw new Error('not encrypted');
      return s.slice(4);
    }
  }
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return electronStub;
  return origLoad.apply(this, arguments);
};

/* ---------------- fetch 桩件 ---------------- */
const calls = [];
/** @type {(url:string, opt:object) => any} */
let responder = () => ({ ok: true, status: 200, text: async () => '{}' });

global.fetch = async (url, opt) => {
  calls.push({ url, method: opt.method, headers: opt.headers, body: opt.body });
  return responder(url, opt);
};

function json(status, obj) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) };
}
function raw(status, txt) {
  return { ok: status >= 200 && status < 300, status, text: async () => txt };
}
function netFail(code) {
  return () => {
    const e = new TypeError('fetch failed');
    e.cause = Object.assign(new Error('x'), { code });
    throw e;
  };
}
function timeout() {
  return () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); };
}

/** 换一个干净的 userData 目录（不换的话上一组用例落盘的 token 会被下一组读到，
 *  测「没登录」时其实已经是登录态 —— 这个坑真踩过一次） */
function newDir() { UD = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-cloud-')); return UD; }

/** 重装模块 + 指向**当前** UD。用来模拟「重启进程」（保留磁盘上的登录态）。 */
function reopen() {
  for (const k of Object.keys(require.cache)) {
    if (/[\\/](pebblecloud|securestore)\.js$/.test(k)) delete require.cache[k];
  }
  const c = require('../pebblecloud');
  c.configure({ userData: UD });
  return c;
}

/** 全新的目录 + 全新的模块实例 */
function fresh() { newDir(); return reopen(); }

function secretsFile() { return path.join(UD, 'secrets.enc'); }
function metaFile() { return path.join(UD, 'pebble-cloud.json'); }
function readSecrets() {
  if (!fs.existsSync(secretsFile())) return {};
  const raw = fs.readFileSync(secretsFile(), 'utf8');
  try { return JSON.parse(ENC ? Buffer.from(raw, 'base64').toString('utf8').slice(4) : raw); }
  catch { return null; }
}

/* ---------------- 用例 ---------------- */
(async () => {
  console.log('=== 输入校验（不该为了一个明显非法的输入就往网上发） ===');
  {
    ENC = true;
    const cloud = fresh();
    calls.length = 0;
    await expectCode(() => cloud.login('ab', 'password'), 'CLOUD_INPUT', '用户名 2 位');
    await expectCode(() => cloud.login('abc', '12345'), 'CLOUD_INPUT', '密码 5 位');
    await expectCode(() => cloud.register('ab', 'password'), 'CLOUD_INPUT', '注册用户名 2 位');
    t('校验失败时不发任何请求', () => assert.strictEqual(calls.length, 0, '发了 ' + calls.length + ' 次'));
    await ta('用户名两侧空格会被去掉（否则注册完再登录就对不上）', async () => {
      const e = await expectCode(() => cloud.login('  ab  ', 'password'), 'CLOUD_INPUT', '去空格后 2 位');
      assert.ok(/至少 3 位/.test(e.message), e.message);
    });  }

  console.log('\n=== 未登录时调云存档：报「没登录」而不是发一个注定 401 的请求 ===');
  {
    const cloud = fresh();
    calls.length = 0;
    await expectCode(() => cloud.putBlob('a', {}), 'CLOUD_NOAUTH', 'putBlob');
    await expectCode(() => cloud.getBlob('a'), 'CLOUD_NOAUTH', 'getBlob');
    await expectCode(() => cloud.listBlobs(), 'CLOUD_NOAUTH', 'listBlobs');
    await expectCode(() => cloud.deleteBlob('a'), 'CLOUD_NOAUTH', 'deleteBlob');
    t('未登录时不发请求', () => assert.strictEqual(calls.length, 0, '发了 ' + calls.length + ' 次'));
    await ta('空 key / 超长 key 被本地拦下', async () => {
      await expectCode(() => cloud.getBlob('   '), 'CLOUD_NOAUTH', 'key 先报未登录');   // 未登录优先
    });
  }

  console.log('\n=== 注册：服务端不发 token，客户端必须自己接着登一次 ===');
  {
    const cloud = fresh();
    calls.length = 0;
    responder = (url) => {
      if (url.endsWith('/api/auth/register')) return json(200, { ok: true });
      if (url.endsWith('/api/auth/login')) return json(200, { ok: true, token: 'tok-1', username: 'alice' });
      return json(404, { error: 'not found' });
    };
    const r = await cloud.register('alice', 'password1');
    t('register 返回的是登录后的用户名', () => assert.strictEqual(r.username, 'alice'));
    t('register 之后真的又登了一次', () => {
      const paths = calls.map((c) => c.url.replace(/^.*\/api/, '/api'));
      assert.deepStrictEqual(paths, ['/api/auth/register', '/api/auth/login'], paths.join(' → '));
    });
    t('注册请求体就是 {username,password}', () => {
      assert.deepStrictEqual(JSON.parse(calls[0].body), { username: 'alice', password: 'password1' });
    });
    t('登录后 status() 是已登录，且**不含 token**（token 不出主进程）', () => {
      const s = cloud.status();
      assert.strictEqual(s.loggedIn, true);
      assert.strictEqual(s.username, 'alice');
      assert.ok(!('token' in s), 'status() 泄漏了 token: ' + JSON.stringify(s));
    });
    await ta('带 token 的后续请求真的带上了 Authorization', async () => {
      calls.length = 0;
      responder = () => json(200, { ok: true, keys: ['k'] });
      await cloud.listBlobs();
      assert.strictEqual(calls[0].headers.Authorization, 'Bearer tok-1', JSON.stringify(calls[0].headers));
      assert.strictEqual(calls[0].url.endsWith('/api/blob'), true, calls[0].url);
    });
  }

  console.log('\n=== 契约不符要吵出来，不能假装成功 ===');
  {
    const cloud = fresh();
    responder = () => json(200, { ok: true, username: 'alice' });   // 没有 token
    const e = await expectCode(() => cloud.login('alice', 'password1'), 'CLOUD_CONTRACT', '登录没回 token');
    t('报错里带着真实返回体，便于对照后端改动', () => assert.ok(/username/.test(e.message), e.message));
    t('契约不符时不留下半截登录态', () => assert.strictEqual(cloud.status().loggedIn, false));
  }

  console.log('\n=== 401 的两种含义 ===');
  {
    const cloud = fresh();
    // ① 登录接口自己的 401 = 密码错误（这次请求**没带** token）
    responder = () => json(401, { error: '密码错误' });
    const e1 = await expectCode(() => cloud.login('alice', 'wrongpass'), 'CLOUD_HTTP', '密码错误');
    t('登录 401 原样转达服务端文案', () => assert.strictEqual(e1.message, '密码错误'));
    t('登录 401 不会被说成「登录已过期」', () => assert.ok(!/过期/.test(e1.message), e1.message));
  }
  {
    const cloud = fresh();
    // 先正常登录
    responder = (url) => url.endsWith('/api/auth/login')
      ? json(200, { ok: true, token: 'tok-2', username: 'bob' }) : json(200, { ok: true });
    await cloud.login('bob', 'password1');
    t('前置：已登录', () => assert.strictEqual(cloud.status().loggedIn, true));

    // ② 带着 token 的 401 = token 失效（实测：鉴权在路由之前，有效 token 访问不存在
    //    的路径是 404，所以带 token 的 401 只可能是登录态死了）
    responder = () => json(401, { error: 'unauthorized' });
    const e2 = await expectCode(() => cloud.listBlobs(), 'CLOUD_UNAUTHORIZED', 'token 失效');
    t('文案是给用户看的「登录已过期」', () => assert.strictEqual(e2.message, '登录已过期，请重新登录'));
    t('同时把本地失效的 token 清掉（否则会一直拿它去撞墙）', () => {
      assert.strictEqual(cloud.status().loggedIn, false);
      assert.ok(!fs.existsSync(metaFile()), '元信息文件没清掉');
      const sec = readSecrets();
      assert.ok(!sec || !sec['cloud.token'], 'secrets 里还留着 token: ' + JSON.stringify(sec));
    });
  }

  console.log('\n=== 网络层错误要说人话 ===');
  {
    const cloud = fresh();
    responder = () => json(200, { ok: true, token: 't', username: 'u' });
    await cloud.login('alice', 'password1');

    responder = timeout();
    const et = await expectCode(() => cloud.listBlobs(), 'CLOUD_NET', '超时');
    t('超时提示带秒数且能照着做', () => assert.ok(/超时/.test(et.message) && /30 秒/.test(et.message), et.message));

    for (const [code, kw] of [['ENOTFOUND', 'DNS'], ['ECONNREFUSED', '拒绝'], ['ECONNRESET', '中断'], ['CERT_HAS_EXPIRED', '证书']]) {
      responder = netFail(code);
      const e = await expectCode(() => cloud.listBlobs(), 'CLOUD_NET', '网络 ' + code);
      t(code + ' 被翻译成人话（' + kw + '）', () => assert.ok(e.message.includes(kw), e.message));
    }

    responder = () => raw(500, 'Internal Server Error');
    const e5 = await expectCode(() => cloud.listBlobs(), 'CLOUD_SERVER', '500');
    t('500 明确说「不是你这边的问题」', () => assert.ok(/不是你这边的问题/.test(e5.message), e5.message));

    responder = () => raw(200, '<html>502 bad gateway</html>');
    const eb = await expectCode(() => cloud.listBlobs(), 'CLOUD_BADJSON', '非 JSON');
    t('非 JSON 200 不当作成功', () => assert.ok(/无法解析/.test(eb.message), eb.message));
    t('上面这些失败都**不影响登录态**（只有 401 才清）', () => assert.strictEqual(cloud.status().loggedIn, true));
  }

  console.log('\n=== 云存档读写 ===');
  {
    const cloud = fresh();
    responder = (url) => url.endsWith('/api/auth/login')
      ? json(200, { ok: true, token: 'tok-3', username: 'carol' }) : json(200, { ok: true });
    await cloud.login('carol', 'password1');

    responder = (url, opt) => {
      if (opt.method === 'PUT') return json(200, { ok: true });
      if (url.includes('key=missing')) return json(200, { ok: true, exists: false, data: null });
      if (url.includes('key=there')) return json(200, { ok: true, exists: true, data: { a: 1 } });
      return json(200, { ok: true, keys: ['x', 'y'], unexpected: 1 });
    };
    await cloud.putBlob('there', { a: 1 });
    t('put 把 data 包在 {data} 里发出去', () => {
      const put = calls[calls.length - 1];
      assert.deepStrictEqual(JSON.parse(put.body), { data: { a: 1 } });
      assert.ok(put.url.includes('key=there'), put.url);
    });
    await ta('key 会被 URL 编码（否则带 & / 空格的名字会串味）', async () => {
      await cloud.getBlob('a b&c');
      const g = calls[calls.length - 1];
      assert.ok(g.url.includes('key=a%20b%26c'), g.url);
    });
    await ta('getBlob：exists=false 返回 null（不是 {}、不是抛错）', async () => {
      assert.strictEqual(await cloud.getBlob('missing'), null);
    });
    await ta('getBlob：exists=true 返回 data 本身', async () => {
      assert.deepStrictEqual(await cloud.getBlob('there'), { a: 1 });
    });
    await ta('listBlobs 只认 keys 数组', async () => {
      assert.deepStrictEqual(await cloud.listBlobs(), ['x', 'y']);
    });
    await ta('listBlobs：keys 不是数组时退化成空列表，不炸', async () => {
      responder = () => json(200, { ok: true });
      assert.deepStrictEqual(await cloud.listBlobs(), []);
    });
  }

  console.log('\n=== token 落盘：只进加密存储，绝不进明文文件 ===');
  {
    ENC = true;
    UD = newDir();
    const cloud = fresh();
    responder = (url) => url.endsWith('/api/auth/login')
      ? json(200, { ok: true, token: 'SECRET-TOKEN', username: 'dave' }) : json(200, { ok: true });
    await cloud.login('dave', 'password1');

    t('加密可用时 persistent=true', () => assert.strictEqual(cloud.status().persistent, true));
    t('token 进了 secrets.enc', () => {
      const sec = readSecrets();
      assert.strictEqual(sec['cloud.token'], 'SECRET-TOKEN', JSON.stringify(sec));
    });
    t('明文元信息文件里**没有** token', () => {
      const meta = JSON.parse(fs.readFileSync(metaFile(), 'utf8'));
      assert.strictEqual(meta.username, 'dave');
      assert.ok(!('token' in meta), 'meta 里有 token: ' + JSON.stringify(meta));
      assert.ok(!fs.readFileSync(metaFile(), 'utf8').includes('SECRET-TOKEN'), '明文文件里出现了 token 原文');
    });
    t('整个 userData 目录里搜不到 token 明文', () => {
      const hit = fs.readdirSync(UD).filter((f) => {
        try { return fs.readFileSync(path.join(UD, f), 'utf8').includes('SECRET-TOKEN'); } catch { return false; }
      });
      assert.deepStrictEqual(hit, [], '这些文件里能找到明文 token: ' + hit.join(', '));
    });

    // 新实例（模拟重启）能自己读回来
    const cloud2 = reopen();
    t('重启后能读回登录态（走加密存储，不靠内存）', () => {
      const s = cloud2.status();
      assert.strictEqual(s.loggedIn, true);
      assert.strictEqual(s.username, 'dave');
      assert.strictEqual(s.persistent, true);
    });
    t('登出把加密存储和元信息文件都清掉', () => {
      cloud2.logout();
      assert.strictEqual(cloud2.status().loggedIn, false);
      const sec = readSecrets();
      assert.ok(!sec || !sec['cloud.token'], JSON.stringify(sec));
      assert.ok(!fs.existsSync(metaFile()), 'meta 文件还在');
    });
    t('登出后新实例也读不到 token 了', () => {
      const s = reopen().status();
      assert.strictEqual(s.loggedIn, false);
    });
  }

  console.log('\n=== 系统不支持加密时：能登录，但如实说「存不住」，绝不降级写明文 ===');
  {
    ENC = false;
    const cloud = fresh();
    responder = (url) => url.endsWith('/api/auth/login')
      ? json(200, { ok: true, token: 'SECRET-2', username: 'erin' }) : json(200, { ok: true });
    await cloud.login('erin', 'password1');

    t('本次会话仍算已登录', () => assert.strictEqual(cloud.status().loggedIn, true));
    t('persistent=false（重启要重登，界面据此提示）', () => assert.strictEqual(cloud.status().persistent, false));
    t('canEncrypt=false 如实上报', () => assert.strictEqual(cloud.status().canEncrypt, false));
    t('没有写出任何明文凭据文件', () => {
      const hit = [];
      for (const f of fs.readdirSync(UD)) {
        try { if (fs.readFileSync(path.join(UD, f), 'utf8').includes('SECRET-2')) hit.push(f); } catch { /* 目录 */ }
      }
      assert.deepStrictEqual(hit, [], '明文写了 token: ' + hit.join(', '));
    });
    t('登出不会因为写不进去而报错', () => {
      cloud.logout();
      assert.strictEqual(cloud.status().loggedIn, false);
    });
  }

  console.log('\n=== 老版本留下的明文 token：读到就搬进加密存储，并把明文删掉 ===');
  {
    ENC = true;
    newDir();
    fs.writeFileSync(path.join(UD, 'pebble-cloud.json'),
      JSON.stringify({ token: 'OLD-PLAIN', username: 'frank', savedAt: 123 }), 'utf8');

    const cloud = reopen();
    t('旧明文 token 被认成已登录', () => {
      const s = cloud.status();
      assert.strictEqual(s.loggedIn, true);
      assert.strictEqual(s.username, 'frank');
    });
    t('搬到加密存储了', () => {
      const sec = readSecrets();
      assert.strictEqual(sec['cloud.token'], 'OLD-PLAIN', JSON.stringify(sec));
    });
    t('明文文件里的 token 被删掉（不搬走等于没修）', () => {
      const txt = fs.readFileSync(metaFile(), 'utf8');
      assert.ok(!txt.includes('OLD-PLAIN'), txt);
      assert.strictEqual(JSON.parse(txt).username, 'frank');
    });
  }
  {
    ENC = false;
    newDir();
    fs.writeFileSync(path.join(UD, 'pebble-cloud.json'),
      JSON.stringify({ token: 'OLD-PLAIN-2', username: 'gina' }), 'utf8');
    const cloud = reopen();
    t('搬不动时（不支持加密）保留旧文件 + 如实报 persistent=false，而不是把人静默登出', () => {
      const s = cloud.status();
      assert.strictEqual(s.loggedIn, true);
      assert.strictEqual(s.username, 'gina');
      assert.strictEqual(s.persistent, false);
    });
  }

  console.log('\n=== 探活 / 服务端地址 ===');
  {
    ENC = true;
    const cloud = fresh();
    t('默认地址就是部署好的那台', () => {
      assert.strictEqual(cloud.endpointOf(), cloud.ENDPOINT_DEFAULT);
    });

    responder = () => json(200, { ok: true, token: 'tok-9', username: 'henry' });
    await cloud.login('henry', 'password1');
    responder = () => json(200, { ok: true, keys: ['a', 'b'] });
    const p1 = await cloud.probe();
    t('probe：已登录且 token 有效', () => {
      assert.deepStrictEqual([p1.reachable, p1.ok, p1.loggedIn, p1.count], [true, true, true, 2]);
    });

    responder = () => json(401, { error: 'unauthorized' });
    const p2 = await cloud.probe();
    t('probe：token 失效 → loggedIn=false 且登录态被清', () => {
      assert.strictEqual(p2.reachable, true);
      assert.strictEqual(p2.loggedIn, false);
      assert.strictEqual(cloud.status().loggedIn, false);
    });

    const p3 = await cloud.probe();
    t('probe：未登录也算「云端可达」', () => {
      assert.deepStrictEqual([p3.reachable, p3.ok, p3.loggedIn], [true, true, false]);
    });

    const p4base = calls.length;
    responder = netFail('ENOTFOUND');
    const p4 = await cloud.probe();
    t('probe：网络不通 → reachable=false，并带 code/error 供界面显示', () => {
      assert.strictEqual(p4.reachable, false);
      assert.strictEqual(p4.code, 'CLOUD_NET');
      assert.ok(p4.error, '没有 error 文案');
    });
    t('probe：未登录时也真的发了请求（否则断网点「测试连接」会说连得上）', () => {
      assert.ok(calls.length > p4base, '没发请求');
    });
  }
  {
    ENC = true;
    const cloud = fresh();
    t('configure({endpoint}) 能指向自建后端', () => {
      cloud.configure({ endpoint: 'https://example.test' });
      assert.strictEqual(cloud.endpointOf(), 'https://example.test');
    });
    t('环境变量优先级更高（联调时不用改代码）', () => {
      process.env.PEBBLE_CLOUD_ENDPOINT = 'https://env.test';
      assert.strictEqual(cloud.endpointOf(), 'https://env.test');
      delete process.env.PEBBLE_CLOUD_ENDPOINT;
      assert.strictEqual(cloud.endpointOf(), 'https://example.test');
    });
    await ta('发出去的 URL 用的是配置后的地址', async () => {
      cloud.configure({ endpoint: 'https://final.test' });
      responder = () => json(200, { ok: true, token: 'x', username: 'ivy' });
      calls.length = 0;
      await cloud.login('ivy', 'password1');
      assert.ok(calls[0].url.startsWith('https://final.test/api/auth/login'), calls[0].url);
    });
  }

  console.log('\n' + (fail === 0 ? '★ 云端客户端全部通过' : `★ 云端客户端有 ${fail} 项失败`));
  process.exit(fail ? 1 : 0);
})();
