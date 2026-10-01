// Pebble Lunchar - 凭据加密存储
// 用 Electron safeStorage（Windows = DPAPI，密钥绑定当前系统用户）加密后落盘，
// 避免 refresh token / accessToken / 密码以明文形式留在 localStorage 里。
//
// 存储结构：{ v: 1, accounts: [...], activeId: string|null }
// 若系统不支持加密（罕见），则只保留公开字段（name/uuid/type），敏感字段丢弃并提示重新登录。

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const FILE = 'accounts.enc';
const SENSITIVE = ['accessToken', 'refreshToken', 'password', 'clientToken'];

function storePath() {
  return path.join(app.getPath('userData'), FILE);
}

function canEncrypt() {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}

/** 读取并解密。返回 { ok, data, degraded } —— degraded=true 表示加密不可用、敏感字段已被丢弃 */
function load() {
  const p = storePath();
  if (!fs.existsSync(p)) return { ok: true, data: { v: 1, accounts: [], activeId: null }, degraded: false };
  try {
    const raw = fs.readFileSync(p);
    let json;
    if (canEncrypt()) {
      json = JSON.parse(safeStorage.decryptString(Buffer.from(raw.toString('utf8'), 'base64')));
    } else {
      json = JSON.parse(raw.toString('utf8'));
    }
    return { ok: true, data: json, degraded: !canEncrypt() };
  } catch (e) {
    return { ok: false, error: '读取凭据失败: ' + e.message, data: { v: 1, accounts: [], activeId: null }, degraded: false };
  }
}

/** 加密并写入。返回 { ok, degraded, dropped } —— dropped 为因无法加密而被丢弃的字段数 */
function save(data) {
  const payload = { v: 1, accounts: Array.isArray(data.accounts) ? data.accounts : [], activeId: data.activeId || null };
  let dropped = 0;
  const enc = canEncrypt();
  if (!enc) {
    // 不支持加密：只落盘公开字段，绝不写明文敏感信息
    payload.accounts = payload.accounts.map((a) => {
      const safe = { type: a.type, name: a.name, uuid: a.uuid };
      for (const k of SENSITIVE) if (a[k]) dropped++;
      safe._needsReauth = true;
      return safe;
    });
  }
  try {
    fs.mkdirSync(path.dirname(storePath()), { recursive: true });
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const out = enc ? safeStorage.encryptString(body.toString('utf8')).toString('base64') : body.toString('utf8');
    fs.writeFileSync(storePath(), out, 'utf8');
    return { ok: true, degraded: !enc, dropped };
  } catch (e) {
    return { ok: false, error: '保存凭据失败: ' + e.message, degraded: !enc, dropped };
  }
}

function clear() {
  try { fs.unlinkSync(storePath()); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

/** 清理历史遗留的明文账户（renderer 的 localStorage 由前端调用清除） */
function legacyHint() {
  return { file: storePath(), encrypted: canEncrypt() };
}

/* ---------- 零散密钥（例如 CurseForge API Key）----------
 * 与账户分开存：账户结构是为登录设计的，往里塞第三方 key 只会越来越乱。
 * 同样走 safeStorage；加密不可用时拒绝写入（不降级明文）。
 */
const SECRET_FILE = 'secrets.enc';

function secretPath() {
  return path.join(app.getPath('userData'), SECRET_FILE);
}

function readSecrets() {
  const p = secretPath();
  if (!fs.existsSync(p)) return {};
  try {
    const raw = fs.readFileSync(p);
    if (canEncrypt()) {
      return JSON.parse(safeStorage.decryptString(Buffer.from(raw.toString('utf8'), 'base64')));
    }
    // 加密不可用时旧文件是明文 JSON，读出来只用于提示，不信任内容
    return JSON.parse(raw.toString('utf8'));
  } catch { return {}; }
}

function writeSecrets(obj) {
  fs.mkdirSync(path.dirname(secretPath()), { recursive: true });
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const out = canEncrypt()
    ? safeStorage.encryptString(body.toString('utf8')).toString('base64')
    : null;
  if (out === null) return { ok: false, error: '当前系统不支持加密，无法安全保存密钥' };
  fs.writeFileSync(secretPath(), out, 'utf8');
  return { ok: true };
}

/** @returns {string} 没存过返回 '' */
function getSecret(name) {
  const s = readSecrets();
  return typeof s[name] === 'string' ? s[name] : '';
}

function setSecret(name, value) {
  const s = readSecrets();
  if (value === '' || value == null) delete s[name];
  else s[name] = String(value);
  return writeSecrets(s);
}

function hasSecret(name) {
  return !!getSecret(name);
}

module.exports = {
  load, save, clear, canEncrypt, storePath, legacyHint, SENSITIVE,
  getSecret, setSecret, hasSecret, secretPath
};
