// Pebble Lunchar - 账户：离线 / 外置 Yggdrasil / 微软设备码登录
const crypto = require('crypto');
const https = require('https');

function offlineUUID(name) {
  const hash = crypto.createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const h = hash.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

function offlineAccount(name) {
  return {
    type: 'offline',
    name,
    uuid: offlineUUID(name),
    accessToken: '0',
    userType: 'legacy',
    ok: true
  };
}

async function postJson(url, body, headers) {
  const res = await fetch(url, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json', 'User-Agent': 'PebbleLunchar/1.0' }, headers || {}),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });
  const txt = await res.text();
  let json;
  try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
  return { status: res.status, json };
}

async function getJson(url, headers) {
  const res = await fetch(url, { headers: Object.assign({ 'User-Agent': 'PebbleLunchar/1.0' }, headers || {}), signal: AbortSignal.timeout(30000) });
  const txt = await res.text();
  let json;
  try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
  return { status: res.status, json };
}

/* ---------- 外置登录（Yggdrasil / authlib-injector 服务器） ---------- */
async function yggdrasilLogin(authServer, username, password) {
  const base = authServer.replace(/\/+$/, '');
  const clientToken = crypto.randomUUID();
  const r = await postJson(base + '/authenticate', {
    agent: { name: 'Minecraft', version: 1 },
    username, password, clientToken, requestUser: true
  });
  if (r.status !== 200) {
    const msg = (r.json && (r.json.errorMessage || r.json.message)) || 'HTTP ' + r.status;
    throw new Error(msg);
  }
  const p = r.json.selectedProfile;
  if (!p) throw new Error('该账户没有可用的游戏角色');
  return {
    type: 'yggdrasil',
    name: p.name,
    uuid: p.id.replace(/^(\w{8})(\w{4})(\w{4})(\w{4})(\w{12})$/, '$1-$2-$3-$4-$5'),
    accessToken: r.json.accessToken,
    clientToken: r.json.clientToken,
    userType: 'mojang',
    authServer: base,
    properties: r.json.user && r.json.user.properties ? JSON.stringify({}) : '{}',
    ok: true
  };
}

/* ---------- 微软登录（设备码流程） ---------- */
const MS_CLIENT_ID = '00000000402b5328';

async function msDeviceCode(clientId) {
  const body = new URLSearchParams({
    client_id: clientId || MS_CLIENT_ID,
    scope: 'XboxLive.signin offline_access'
  });
  const res = await fetch('https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    signal: AbortSignal.timeout(30000)
  });
  const j = /** @type {any} */ (await res.json());
  if (!res.ok) throw new Error((j && j.error_description) || '获取设备码失败');
  return j; // { device_code, user_code, verification_uri, expires_in, interval }
}

async function msPoll(deviceCode, clientId, onTick, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 15 * 60 * 1000);
  while (Date.now() < deadline) {
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId || MS_CLIENT_ID,
      device_code: deviceCode
    });
    const res = await fetch('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
      signal: AbortSignal.timeout(30000)
    });
    const j = /** @type {any} */ (await res.json());
    if (res.ok) return j;
    if (j.error === 'authorization_pending') { if (onTick) onTick(); await sleep(3000); continue; }
    throw new Error(j.error_description || j.error || '授权失败');
  }
  throw new Error('授权超时');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function msLogin(clientId, onCode, onTick) {
  const code = await msDeviceCode(clientId);
  if (onCode) onCode(code);
  const token = await msPoll(code.device_code, clientId, onTick);
  // Xbox Live
  const xbl = await postJson('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: 'd=' + token.access_token },
    RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT'
  });
  if (xbl.status !== 200) throw new Error('Xbox Live 认证失败: ' + JSON.stringify(xbl.json).slice(0, 200));
  const xblToken = xbl.json.Token;
  const uhs = xbl.json.DisplayClaims && xbl.json.DisplayClaims.xdi && xbl.json.DisplayClaims.xdi.uhs;
  // XSTS
  const xsts = await postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
    RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT'
  });
  if (xsts.status !== 200) throw new Error('XSTS 认证失败: ' + JSON.stringify(xsts.json).slice(0, 200));
  const xstsToken = xsts.json.Token;
  const uhs2 = xsts.json.DisplayClaims && xsts.json.DisplayClaims.xdi && xsts.json.DisplayClaims.xdi.uhs || uhs;
  // Minecraft
  const mc = await postJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
    identityToken: `XBL3.0 x=${uhs2};${xstsToken}`
  });
  if (mc.status !== 200) throw new Error('Minecraft 认证失败: ' + JSON.stringify(mc.json).slice(0, 200));
  const mcToken = mc.json.access_token;
  const prof = await getJson('https://api.minecraftservices.com/minecraft/profile', { Authorization: 'Bearer ' + mcToken });
  if (prof.status !== 200 || !prof.json || !prof.json.name) throw new Error('该微软账户未购买 Minecraft');
  const id = prof.json.id;
  return {
    type: 'microsoft',
    name: prof.json.name,
    uuid: id.replace(/^(\w{8})(\w{4})(\w{4})(\w{4})(\w{12})$/, '$1-$2-$3-$4-$5'),
    accessToken: mcToken,
    refreshToken: token.refresh_token,
    userType: 'msa',
    ok: true
  };
}

module.exports = { offlineAccount, offlineUUID, yggdrasilLogin, msLogin };
