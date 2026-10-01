// Pebble Lunchar - 多账户并行：运行中游戏的登记表
//
// 「并行」= 一个游戏进程可以绑定自己的（实例，账户）组合。
// 实例（组 5）提供独立 gameDir，账户提供独立会话 —— 两者都不同才谈得上真并行：
//   · 同 gameDir 开两个 MC：两个客户端抢写一个 options.txt / logs/latest.log，退出时互相覆盖设置
//   · 同账户开两个 MC：正版会话会被服务端踢，离线也一样容易串档
// 所以登记表以 `${instanceId}|${accountUuid}` 为主键，重复组合直接拒绝启动。
//
// 这里只做登记与查询，不负责 spawn —— spawn 仍在 launcher.launchGame。

const { execFileSync } = require('child_process');

const registry = new Map();   // key -> entry

/** 纯函数：组合主键。缺省实例记为 '-'（沿用当前 gameDir 的情况） */
function makeKey(o) {
  const inst = (o && o.instanceId) || '-';
  const acc = (o && o.accountUuid) || '-';
  return inst + '|' + acc;
}

/** 纯函数：Windows 上用信号 0 探活（不会真的发信号）；Unix 同理 */
function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) {
    // 权限不足时（极少）认为它还活着，避免误删这条记录
    return e && (e.code === 'EPERM' || e.code === 'EACCES');
  }
}

/**
 * 纯函数：清掉已退出的记录。
 * @param {Array} entries 登记表条目
 * @param {Function} alive (pid)=>boolean
 * @returns {{entries: Array, removed: string[]}}
 */
function prune(entries, alive) {
  const isAlive = alive || pidAlive;
  const kept = [];
  const removed = [];
  for (const e of entries) {
    if (e.exited || !isAlive(e.pid)) removed.push(e.key);
    else kept.push(e);
  }
  return { entries: kept, removed };
}

function aliveMs(e, now) {
  return Math.max(0, (now || Date.now()) - (e.startedAt || 0));
}

/** 格式化运行时长。纯函数便于断言 */
function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/* ---------- 登记 ---------- */
function add(e) {
  const key = makeKey(e);
  const entry = {
    key,
    pid: e.pid,
    instanceId: e.instanceId || '-',
    instanceName: e.instanceName || '',
    accountUuid: e.accountUuid || '-',
    accountName: e.accountName || '',
    accountType: e.accountType || '',
    version: e.version || '',
    gameDir: e.gameDir || '',
    startedAt: e.startedAt || Date.now(),
    exited: false
  };
  registry.set(key, entry);
  return entry;
}

/** 查一次已存在的组合。key 或 {instanceId, accountUuid} 都行 */
function find(o) {
  const key = typeof o === 'string' ? o : makeKey(o);
  return registry.get(key) || null;
}

function list(opts) {
  const alive = (opts && opts.alive) || pidAlive;
  const out = [];
  for (const e of registry.values()) {
    if (e.exited || !alive(e.pid)) { registry.delete(e.key); continue; }
    out.push(Object.assign({}, e, { uptimeMs: aliveMs(e), uptime: fmtDuration(aliveMs(e)) }));
  }
  out.sort((a, b) => b.startedAt - a.startedAt);
  return out;
}

function byAccount(uuid) {
  return list().filter((e) => e.accountUuid === uuid);
}

function byInstance(instanceId) {
  return list().filter((e) => e.instanceId === (instanceId || '-'));
}

function count() { return list().length; }

/** 进程退出时由调用方（main.js 的 close 回调）显式标记 */
function markExited(pid) {
  let hit = null;
  for (const e of registry.values()) {
    if (e.pid === pid) { e.exited = true; registry.delete(e.key); hit = e; }
  }
  return hit;
}

function clear() { registry.clear(); }

/* ---------- 结束进程 ---------- */
/** Windows：连同子进程一起杀（MC 会派生 JVM 子进程/日志写入进程）；其它平台退化为 SIGTERM */
function killProcess(pid, log) {
  const tell = (s) => { if (log) log(s); };
  if (!pid) return { ok: false, error: '无效 PID' };
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      return { ok: true };
    } catch (e) {
      // 进程已经没了也算达成目的
      if (!pidAlive(pid)) return { ok: true, alreadyGone: true };
      return { ok: false, error: e.message };
    }
  }
  try { process.kill(pid, 'SIGTERM'); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

/** 结束一条记录（按 pid 或 key） */
function stop(target, log) {
  let entry = null;
  if (typeof target === 'number') {
    for (const e of registry.values()) if (e.pid === target) entry = e;
  } else {
    entry = registry.get(target) || null;
  }
  if (!entry) return { ok: false, error: '没有这条运行记录' };
  const r = killProcess(entry.pid, log);
  if (r.ok) { entry.exited = true; registry.delete(entry.key); }
  return Object.assign({ entry }, r);
}

function stopAll(log) {
  const items = list();
  let okCount = 0;
  for (const e of items) { if (stop(e.key, log).ok) okCount++; }
  return { ok: true, stopped: okCount, total: items.length };
}

/** 同一组合是否已占用（用于启动前拦截） */
function occupied(o) {
  const e = find(o);
  if (!e) return null;
  return pidAlive(e.pid) ? e : null;
}

module.exports = {
  makeKey, pidAlive, prune, fmtDuration, aliveMs,
  add, find, list, byAccount, byInstance, count, clear, markExited,
  stop, stopAll, killProcess, occupied
};
