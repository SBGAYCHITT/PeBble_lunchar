// ============================================================
// pebblecloud.js —— PeBble 云端后端的客户端（跑在 Electron 主进程）
//
// 后端：Deno Deploy 上的 pebble-backend-deno.ts（不在本仓库，契约靠实测锁定，见下）
// 暴露给渲染层的入口是 ipc/cloud.js，本模块**不直接**注册任何 IPC。
//
// 用法：
//   const cloud = require('./pebblecloud');
//   cloud.configure({ userData: ctx.userData });   // 必须先配，否则没法落盘
//   await cloud.register('名字', '密码123');        // 注册（成功即登录）
//   await cloud.login('名字', '密码123');           // 之后登录，token 进加密存储
//   await cloud.putBlob('profiles', [...]);        // 备份账户配置（对接账户迁移）
//   const data = await cloud.getBlob('profiles');  // 另一台机器上恢复
//
// ---------- 实测锁定的服务端契约（2026-10-15 对线上服务逐条验过）----------
//   POST /api/auth/register {username,password}  → 200 {ok:true}   ← 注意：**不发 token**
//                                                  400 用户名至少3位 / 密码至少6位
//                                                  409 用户名已存在
//   POST /api/auth/login    {username,password}  → 200 {ok:true,token,username}
//                                                  401 密码错误（不含 token 的 401，见下）
//                                                  404 用户不存在
//   PUT  /api/blob/item?key=K  {data}            → 200 {ok:true}
//   GET  /api/blob/item?key=K                    → 200 {ok:true,exists,data}
//   GET  /api/blob                               → 200 {ok:true,keys:[...]}
//   DELETE /api/blob/item?key=K                  → 200 {ok:true}
//
// ---------- 401 的两种含义，必须分开处理 ----------
// 服务端的鉴权中间件跑在**路由之前**：带一个**有效** token 访问不存在的路径，
// 返回的是 404 not found；带一个**垃圾** token 才是 401 unauthorized。
//   · 请求**带了** token 却收到 401 → token 失效，登录态已死 → 清本地 token 并让用户重登
//   · 请求**没带** token 收到 401 → 是登录接口在说「密码错误」，绝不能提示「登录已过期」
// 这条判据一旦搞混，用户输错密码会被提示成「登录过期，请重新登录」，而且会把
// 本来好好的登录态清掉。所以下面统一用 `usedToken` 而不是单看状态码。
//
// ---------- token 存在哪 ----------
// 不放明文文件。走 securestore 的 secrets.enc（safeStorage / Windows DPAPI 加密）。
// 系统不支持加密时**拒绝落盘**，token 只留内存：这次会话照常能用，重启需要重登，
// 并把 degraded=true 如实报给界面 —— 不静默降级成明文（那等于把凭据裸放在磁盘上）。
// ============================================================

const fs = require('fs');
const path = require('path');

/** 默认后端地址。可以用环境变量 PEBBLE_CLOUD_ENDPOINT 或 configure({endpoint}) 覆盖，
 *  方便自建后端 / 内网联调，而不用改源码。 */
const ENDPOINT_DEFAULT = 'https://rusty-ferret-9754.shitsmart.deno.net';
/** 请求超时。Deno Deploy 冷启动实测要 4 秒左右，30 秒足够，也不至于把界面卡到像死机。 */
const TIMEOUT_MS = 30000;
/** securestore 里的密钥名 */
const SECRET_TOKEN = 'cloud.token';
/** 非敏感元信息（用户名 / 登录时间）。token 绝不写进这个文件。 */
const META_FILE = 'pebble-cloud.json';
/** 与服务端一致的输入下限（服务端会返回「用户名至少3位」「密码至少6位」） */
const USERNAME_MIN = 3;
const PASSWORD_MIN = 6;

let userData = '';
let endpointOverride = '';
let session = null;     // { token, username, savedAt, persistent }
let loaded = false;

/* ---------- 装配 ---------- */

/**
 * 注入运行期依赖。主进程在 ipc/cloud.js 里从 ctx 取 userData 传进来。
 * 刻意不做模块加载期的 `app.getPath()`：那会让本模块**必须先有 Electron 才能被加载**，
 * 无头测试里连 require 都过不去。
 * @param {{userData?:string, endpoint?:string}} [o]
 */
function configure(o) {
  if (o && o.userData) { userData = String(o.userData); loaded = false; session = null; }
  if (o && o.endpoint) endpointOverride = String(o.endpoint);
}

function dir() {
  if (userData) return userData;
  // 没 configure 过就直接用（例如有人单独 require 这个模块）——
  // 惰性 require electron，理由同上。
  const { app } = require('electron');
  userData = app.getPath('userData');
  return userData;
}

/** @returns {string} 当前生效的后端地址 */
function endpointOf() {
  return process.env.PEBBLE_CLOUD_ENDPOINT || endpointOverride || ENDPOINT_DEFAULT;
}

function metaPath() { return path.join(dir(), META_FILE); }

/* ---------- 加密存储 ---------- */

/** 惰性 require：securestore 顶层就 require('electron')，无头测试要先桩掉才能加载。 */
function store() { return require('./securestore'); }

function canEncrypt() {
  try { return !!store().canEncrypt(); } catch { return false; }
}

function readToken() {
  try { return store().getSecret(SECRET_TOKEN) || ''; } catch { return ''; }
}

/**
 * 写 token。
 * @returns {boolean} 是否真的落到了盘上（加密不可用 / 读写失败都是 false）
 */
function writeToken(token) {
  try { return !!store().setSecret(SECRET_TOKEN, token).ok; } catch { return false; }
}

function readMeta() {
  try {
    const o = JSON.parse(fs.readFileSync(metaPath(), 'utf8'));
    return o && typeof o === 'object' ? o : {};
  } catch { return {}; }
}

function writeMeta(o) {
  try {
    fs.mkdirSync(path.dirname(metaPath()), { recursive: true });
    fs.writeFileSync(metaPath(), JSON.stringify(o, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

/* ---------- 会话 ---------- */

/**
 * 读取登录态（有内存缓存，只读一次盘）。
 * @returns {{token:string, username:string, savedAt:number|null, persistent:boolean}|null}
 */
function loadSession() {
  if (loaded) return session;
  loaded = true;
  session = null;

  const meta = readMeta();
  let token = readToken();
  let legacy = false;

  // 兼容第一版写法：token 曾经和用户名一起明文写在 pebble-cloud.json 里。
  if (!token && typeof meta.token === 'string' && meta.token) {
    token = meta.token;
    legacy = true;
  }
  if (!token) return null;

  session = {
    token,
    username: typeof meta.username === 'string' ? meta.username : '',
    savedAt: typeof meta.savedAt === 'number' ? meta.savedAt : null,
    persistent: false
  };

  if (legacy) {
    // 老明文 token：能加密就搬进加密存储并把明文那行删掉（不搬走等于没修）；
    // 搬不动（系统不支持加密）就原样留着 + 如实上报 degraded，而不是把用户的登录态删掉。
    session.persistent = writeToken(token);
    if (session.persistent) { delete meta.token; writeMeta(meta); }
  } else {
    session.persistent = true;
  }
  return session;
}

function saveSession(token, username) {
  session = {
    token,
    username: username || '',
    savedAt: Date.now(),
    persistent: writeToken(token)
  };
  loaded = true;
  if (session.persistent) {
    const meta = readMeta();
    delete meta.token;            // 老版本可能把 token 写在这儿，顺手清掉
    meta.username = session.username;
    meta.savedAt = session.savedAt;
    writeMeta(meta);
  }
  return session;
}

/**
 * 兜底：加密不可用时 setSecret 会**拒绝写入**（它不降级写明文，这是对的），
 * 于是「登出后 token 还留在 secrets.enc 里」。
 * 那种情况下文件本身就已经是明文 JSON，我们只把**自己这把 key** 抹掉再写回去 ——
 * 不删整个文件，因为里面还有别人的密钥（比如 CurseForge API Key）。
 * 这一步严格来说是减少磁盘上的明文，所以不违反「绝不写明文凭据」。
 */
function scrubTokenFromPlainFile() {
  try {
    const p = store().secretPath();
    if (!fs.existsSync(p)) return;
    const raw = fs.readFileSync(p, 'utf8');
    let obj;
    try { obj = JSON.parse(raw); } catch { return; }   // 加密过的内容不是 JSON，解析失败就跳过
    if (!obj || typeof obj !== 'object' || !(SECRET_TOKEN in obj)) return;
    delete obj[SECRET_TOKEN];
    fs.writeFileSync(p, JSON.stringify(obj), 'utf8');
  } catch { /* 尽力而为，不阻塞登出 */ }
}

/** 清干净登录态：内存 + 加密存储 + 元信息文件。 */
function forget() {
  session = null;
  loaded = true;
  if (!writeToken('')) scrubTokenFromPlainFile();
  try {
    const p = metaPath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch { /* 删不掉也不该把登出流程卡住 */ }
}

/**
 * 给界面看的登录态快照。**不含 token** —— token 不出主进程。
 * @returns {{loggedIn:boolean, username:string|null, savedAt:number|null,
 *            persistent:boolean, canEncrypt:boolean, endpoint:string}}
 */
function status() {
  loadSession();
  const loggedIn = !!(session && session.token);
  return {
    loggedIn,
    username: loggedIn ? session.username : null,
    savedAt: loggedIn ? session.savedAt : null,
    // token 是否真落到了加密存储里；false = 只在内存，重启后要重登
    persistent: loggedIn ? !!session.persistent : false,
    canEncrypt: canEncrypt(),
    endpoint: endpointOf()
  };
}

/* ---------- 请求 ---------- */

function wrap(code, msg, extra) {
  // code / status 是挂上去的自定义字段，Error 类型上没有，所以标 any（同 worldmerge 的写法）
  /** @type {any} */
  const e = new Error(msg);
  e.code = code;
  Object.assign(e, extra || {});
  return e;
}

/** 把 fetch 的各种失败翻译成人看得懂的话（原来的 'fetch failed' 帮不上任何忙） */
function describeNet(e) {
  const name = e && e.name;
  if (name === 'TimeoutError') {
    return '连接云端超时（' + Math.round(TIMEOUT_MS / 1000) + ' 秒无响应），请检查网络后重试';
  }
  const cause = (e && e.cause) || {};
  const c = String(cause.code || '');
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return '解析不到云端域名，请检查网络或 DNS';
  if (c === 'ECONNREFUSED') return '云端服务拒绝了连接，请确认服务是否在跑';
  if (c === 'ECONNRESET' || c === 'EPIPE' || c === 'UND_ERR_SOCKET') return '与云端的连接被中断，请稍后重试';
  if (/CERT|SSL|TLS|SELF_SIGNED/i.test(c)) return '云端证书校验失败（' + c + '）';
  const m = String((e && e.message) || '');
  if (/fetch failed/i.test(m)) return '网络请求失败' + (c ? '（' + c + '）' : '') + '，请检查网络或代理设置';
  return m || '未知的网络错误';
}

/**
 * 发一个请求。
 * @param {string} method
 * @param {string} p 以 / 开头的路径（含 query）
 * @param {object} [body]
 * @param {{noAuth?:boolean}} [opt] noAuth：这次请求刻意不带 Authorization
 * @returns {Promise<object>}
 */
async function req(method, p, body, opt) {
  loadSession();
  // 登录 / 注册走 noAuth：它们本来就不需要 token，而**带上**会让「401 = 登录过期」
  // 这条判据失效 —— 已登录账号 A 时用错密码去登账号 B，服务端回 401 密码错误，
  // 带了旧 token 就会被误报成「登录已过期」，还会顺手把 A 的登录态清掉。
  const usedToken = !(opt && opt.noAuth) && !!(session && session.token);
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'PebbleLunchar/1.0' };
  if (usedToken) headers.Authorization = 'Bearer ' + session.token;

  let res;
  try {
    res = await fetch(endpointOf() + p, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (e) {
    throw wrap('CLOUD_NET', describeNet(e), { cause: e });
  }

  const txt = await res.text();
  let json = null;
  try { json = JSON.parse(txt); } catch { json = null; }

  if (!res.ok) {
    // 见文件头：只有「带着 token 的 401」才等于登录态失效。
    if (res.status === 401 && usedToken) {
      forget();
      throw wrap('CLOUD_UNAUTHORIZED', '登录已过期，请重新登录', { status: 401 });
    }
    const serverMsg = json && typeof json.error === 'string' ? json.error : '';
    if (!serverMsg && res.status >= 500) {
      throw wrap('CLOUD_SERVER', '云端服务内部错误（HTTP ' + res.status + '），不是你这边的问题，可稍后重试', { status: res.status });
    }
    throw wrap('CLOUD_HTTP', serverMsg || txt.slice(0, 200) || ('HTTP ' + res.status), { status: res.status });
  }
  if (json === null) {
    throw wrap('CLOUD_BADJSON', '云端返回了无法解析的内容（HTTP ' + res.status + '）：' + txt.slice(0, 120), { status: res.status });
  }
  return json;
}

/* ---------- 输入校验（对齐服务端，能本地拦下就别往返一趟） ---------- */

function checkUser(username) {
  const s = String(username == null ? '' : username).trim();
  if (s.length < USERNAME_MIN) {
    throw wrap('CLOUD_INPUT', '用户名至少 ' + USERNAME_MIN + ' 位（云端服务端也是这个要求）');
  }
  return s;
}

function checkPass(password) {
  // 刻意不 trim：密码里的空格是合法字符，悄悄改掉用户输入就是另一类 bug。
  const s = String(password == null ? '' : password);
  if (s.length < PASSWORD_MIN) throw wrap('CLOUD_INPUT', '密码至少 ' + PASSWORD_MIN + ' 位');
  return s;
}

function checkKey(key) {
  const s = String(key == null ? '' : key).trim();
  if (!s) throw wrap('CLOUD_INPUT', '云存档的名字不能为空');
  if (s.length > 128) throw wrap('CLOUD_INPUT', '云存档的名字太长（最多 128 个字符）');
  return s;
}

function requireLogin() {
  loadSession();
  if (!session || !session.token) throw wrap('CLOUD_NOAUTH', '还没有登录云端账号');
}

/* ---------- 账号 ---------- */

/**
 * 注册。**成功即登录** —— 服务端注册只回 {ok:true} 不发 token，
 * 所以这里直接接着登一次，调用方不用记这一步（忘了登就是「注册成功但什么都没生效」）。
 * @returns {Promise<{username:string, persistent:boolean}>}
 */
async function register(username, password) {
  const u = checkUser(username);
  const p = checkPass(password);
  await req('POST', '/api/auth/register', { username: u, password: p }, { noAuth: true });
  return login(u, p);
}

/**
 * 登录。token 只进主进程的加密存储，**不返回给调用方/渲染层**。
 * @returns {Promise<{username:string, persistent:boolean}>}
 */
async function login(username, password) {
  const u = checkUser(username);
  const p = checkPass(password);
  const r = await req('POST', '/api/auth/login', { username: u, password: p }, { noAuth: true });
  if (!r || typeof r.token !== 'string' || !r.token) {
    throw wrap('CLOUD_CONTRACT', '云端登录成功了，但返回体里没有 token（拿到 '
      + JSON.stringify(r).slice(0, 160) + '），后端契约可能变了');
  }
  const s = saveSession(r.token, typeof r.username === 'string' ? r.username : u);
  return { username: s.username, persistent: s.persistent };
}

function logout() { forget(); }

/* ---------- 云存档 ---------- */

/** @param {string} key @param {any} data 任意可 JSON 序列化的值 */
async function putBlob(key, data) {
  requireLogin();
  return req('PUT', '/api/blob/item?key=' + encodeURIComponent(checkKey(key)), { data });
}

/** @returns {Promise<any|null>} 不存在返回 null（服务端会给 exists:false） */
async function getBlob(key) {
  requireLogin();
  const r = await req('GET', '/api/blob/item?key=' + encodeURIComponent(checkKey(key)));
  return r && r.exists ? r.data : null;
}

/** @returns {Promise<string[]>} */
async function listBlobs() {
  requireLogin();
  const r = await req('GET', '/api/blob');
  return r && Array.isArray(r.keys) ? r.keys : [];
}

async function deleteBlob(key) {
  requireLogin();
  return req('DELETE', '/api/blob/item?key=' + encodeURIComponent(checkKey(key)));
}

/**
 * 探活 + 验证当前 token 还有效没。
 *
 * 这里**不能**走 listBlobs()：它开头有 requireLogin()，未登录时会直接抛 CLOUD_NOAUTH
 * 而请求根本没发出去 —— 那样断网时点「测试连接」也会报「连得上」。
 * 所以这里直接发一次 `GET /api/blob`（存在且需要认证），按返回分三种情况：
 *   200            → 服务在，登录态有效
 *   带 token 的 401 → 服务在，token 死了（req 已顺手清掉登录态）
 *   不带 token 的 401 → 服务在，只是没登录（鉴权在路由之前，任何路径都会回 401）
 *   其他（含网络失败）→ 服务不可用
 * 刻意不用 `/api/auth/me` 探：那条路由在服务端**不存在**（实测带有效 token 回 404），
 * 拿它探会把「路由不存在」误判成「服务不正常」。
 * @returns {Promise<{reachable:boolean, ok:boolean, loggedIn:boolean, username?:string,
 *                    count?:number, code?:string, error?:string}>}
 */
async function probe() {
  let keys;
  try {
    const r = await req('GET', '/api/blob');
    keys = r && Array.isArray(r.keys) ? r.keys : [];
  } catch (e) {
    if (e.code === 'CLOUD_UNAUTHORIZED') {
      return { reachable: true, ok: true, loggedIn: false, code: e.code, error: e.message };
    }
    if (e.code === 'CLOUD_HTTP' && e.status === 401) {
      return { reachable: true, ok: true, loggedIn: false };
    }
    return { reachable: false, ok: false, loggedIn: false, code: e.code || 'CLOUD_NET', error: e.message };
  }
  loadSession();
  return {
    reachable: true, ok: true, loggedIn: true,
    username: (session || {}).username || '', count: keys.length
  };
}

module.exports = {
  ENDPOINT_DEFAULT, TIMEOUT_MS, SECRET_TOKEN, META_FILE, USERNAME_MIN, PASSWORD_MIN,
  configure, endpointOf, metaPath,
  register, login, logout, status, loadSession, saveSession, forget,
  putBlob, getBlob, listBlobs, deleteBlob,
  probe, canEncrypt
};
