// 启动游戏：启动前自动快照 + 多开去重 + 崩溃诊断回传
const fs = require('fs');
const path = require('path');
const launcher = require('../launcher');
const mcapi = require('../mcapi');
const crashdoctor = require('../crashdoctor');
const timemachine = require('../savetimemachine');
const modguard = require('../modguard');
const multilaunch = require('../multilaunch');

const MAX_AUTO_SNAPSHOT_BYTES = 8 * 1024 * 1024 * 1024; // 超过 8GB 的存档不自动快照（太慢）
const AUTO_SNAPSHOT_MIN_INTERVAL = 60 * 1000;           // 同一分钟内不重复打点

function dirChangedSince(dir, sinceMs) {
  let stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (e.name === 'session.lock') continue;
      try { if (fs.statSync(p).mtimeMs > sinceMs) return true; } catch {}
    }
  }
  return false;
}

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else { try { total += fs.statSync(p).size; } catch {} }
    }
  }
  return total;
}

/**
 * 启动前给所有存档 + Mod 目录打自动快照
 * @returns {{snapped:number, skipped:number, tooBig:number}}
 */
async function autoSnapshotBeforeLaunch(gameDir, sendLog, TM_DIR, AUTO_KEEP) {
  const stat = { snapped: 0, skipped: 0, tooBig: 0 };
  if (!gameDir || !fs.existsSync(gameDir)) return stat;

  const jobs = [];
  try {
    for (const s of mcapi.listSaves(gameDir)) jobs.push({ kind: 'save', dir: s.dir, name: s.name || path.basename(s.dir) });
  } catch {}
  const modsDir = path.join(gameDir, 'mods');
  if (fs.existsSync(modsDir)) jobs.push({ kind: 'mods', dir: modsDir, name: 'Mod' });

  for (const j of jobs) {
    try {
      const world = j.kind === 'mods' ? modguard.worldKey(gameDir) : path.basename(j.dir);
      const list = timemachine.listSnapshots({ storeDir: TM_DIR, world });
      const last = list[0];
      if (last && (Date.now() - last.time) < AUTO_SNAPSHOT_MIN_INTERVAL) { stat.skipped++; continue; }
      if (last && !dirChangedSince(j.dir, last.time)) { stat.skipped++; continue; }
      if (dirSize(j.dir) > MAX_AUTO_SNAPSHOT_BYTES) { stat.tooBig++; continue; }

      const snap = await timemachine.createSnapshot({
        saveDir: j.dir, storeDir: TM_DIR, label: '启动前自动', auto: true, world
      });
      timemachine.pruneAuto({ storeDir: TM_DIR, world, keep: AUTO_KEEP });
      stat.snapped++;
      sendLog(`[时光机] ${j.name} 已自动快照（新增 ${(snap.newBytes / 1048576).toFixed(1)} MB / 共 ${(snap.totalSize / 1048576).toFixed(1)} MB）`);
    } catch (e) {
      sendLog(`[时光机] ${j.name} 自动快照失败: ${e.message}`);
    }
  }
  return stat;
}

/* ---------- 崩溃报告摘要 + 本地规则库诊断（游戏异常退出时给出真正原因与可操作建议） ---------- */
function crashSummary(gameDir) {
  try {
    const dir = path.join(gameDir || '', 'crash-reports');
    if (!gameDir || !fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.txt'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (!files.length) return null;
    const newest = files[0];
    if (Date.now() - newest.t > 180000) return null; // 只认刚刚这次崩溃产生的
    const fullPath = path.join(dir, newest.f);
    const txt = fs.readFileSync(fullPath, 'utf8');
    const sum = crashdoctor.summarize(txt.slice(0, 20000));
    const diag = crashdoctor.diagnose(txt.slice(0, 20000));
    return { file: newest.f, path: fullPath, text: txt, desc: sum.desc, err: sum.err, stack: sum.stack, diag };
  } catch (e) { return null; }
}

// 把诊断结果写成可读的日志行
function reportCrash(c, sendLog) {
  if (!c) return;
  if (c.desc) sendLog('[诊断] 崩溃类型: ' + c.desc);
  if (c.err) sendLog('[诊断] ' + c.err);
  if (c.stack && c.stack.length) for (const s of c.stack) sendLog('[诊断]   ' + s);
  const diag = c.diag;
  if (diag && diag.matched && diag.matched.length) {
    for (const m of diag.matched) {
      sendLog('[诊断] ⚠ ' + m.name + '（匹配: ' + (m.evidence || '').slice(0, 120) + '）');
    }
    sendLog('[诊断] —— 建议 ——');
    for (const a of diag.advice) sendLog('[诊断] · ' + a);
  } else {
    sendLog('[诊断] 未匹配到已知问题规则，可复制完整报告到社区求助。');
  }
  sendLog('[诊断] 完整报告: ' + c.path);
}

module.exports = function register(ctx) {
  const { ipcMain, emit, TM_DIR, AUTO_KEEP } = ctx;

  ipcMain.handle('launch', async (_e, opts) => {
    const sendLog = (line) => emit('game-log', line);

    // 托盘菜单要据此判断"启动游戏"能否点击、显示哪个版本/账户
    ctx.setLaunching(true);
    ctx.setLastLaunch({
      version: (opts && opts.version) || '',
      playerName: (opts && opts.account && opts.account.name) || '',
      gameDir: (opts && opts.gameDir) || (opts && opts.mcDir) || ''
    });
    ctx.refreshTray();

    // 并行多开的重复检查：同「实例 + 账户」已经在跑就直接拦掉
    // （同 gameDir 两个客户端会互写 options.txt / latest.log；同账户会被服务端互踢）
    if (opts && opts.register !== false && !opts.force && !opts.lab) {
      const busy = multilaunch.occupied({
        instanceId: opts.instanceId,
        accountUuid: opts.account && opts.account.uuid
      });
      if (busy) {
        const msg = `该账户已在运行（${busy.instanceName || '当前目录'} · ${busy.accountName || '未知账户'}，PID ${busy.pid}）。多开请先换另一个实例或账户。`;
        sendLog('[多开] ' + msg);
        ctx.setLaunching(false);
        ctx.refreshTray();
        return { ok: false, error: msg, duplicate: true, entry: busy };
      }
    }

    // 先给"最后一次能进游戏的状态"留个底，再启动
    if (opts && opts.autoSnapshot !== false) {
      try {
        const gd = opts.gameDir || (opts.mcDir && opts.isolation ? path.join(opts.mcDir, 'versions', opts.version, 'isolation') : opts.mcDir);
        if (gd) await autoSnapshotBeforeLaunch(gd, sendLog, TM_DIR, AUTO_KEEP);
      } catch (e) { sendLog('[时光机] 自动快照异常: ' + e.message); }
    }

    const result = await launcher.launchGame(opts, sendLog);
    ctx.setLaunching(false);
    ctx.refreshTray();

    if (result.ok && result.child) {
      const child = result.child;
      const gameDir = result.gameDir;
      const sendState = (state, code) => emit('launch-state', { state, code });
      let buf = '';
      const recent = [];                       // 滚动保留最近输出，供无崩溃报告时诊断

      // 并行多开登记：同一（实例，账户）组合已经有进程在跑就别再开一个
      let entry = null;
      if (opts.register !== false) {
        entry = multilaunch.add({
          pid: child.pid,
          instanceId: opts.instanceId, instanceName: opts.instanceName,
          accountUuid: opts.account && opts.account.uuid,
          accountName: opts.account && opts.account.name,
          accountType: opts.account && opts.account.type,
          version: opts.version, gameDir
        });
      }
      emit('ml-changed', multilaunch.list());
      const pump = (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const l of lines) {
          if (!l.trim()) continue;
          sendLog(l.slice(0, 500));
          recent.push(l);
          if (recent.length > 400) recent.shift();
        }
      };
      // 没有崩溃报告时，用游戏输出本身跑一遍规则库
      const diagnoseLogTail = () => {
        const tail = recent.join('\n');
        if (!tail.trim()) return;
        const d = crashdoctor.diagnose(tail);
        if (d.matched && d.matched.length) {
          for (const m of d.matched) sendLog('[诊断] ⚠ ' + m.name + '（匹配: ' + (m.evidence || '').slice(0, 120) + '）');
          sendLog('[诊断] —— 建议 ——');
          for (const a of d.advice) sendLog('[诊断] · ' + a);
        } else {
          sendLog('[诊断] 日志中未匹配到已知问题，可复制输出到社区求助。');
        }
      };
      child.stdout.on('data', pump);
      child.stderr.on('data', pump);
      child.on('error', (e) => { sendLog('[启动器] 进程错误: ' + e.message); sendState('error', -1); });
      child.on('close', (code) => {
        if (entry) { multilaunch.markExited(child.pid); emit('ml-changed', multilaunch.list()); }
        if (code !== 0 && code !== null) {
          const c = crashSummary(gameDir);
          if (c) {
            reportCrash(c, sendLog);
          } else {
            sendLog('[启动器] 未找到新的崩溃报告，退出码 ' + code + '。');
            diagnoseLogTail();
          }
        }
        sendState('exit', code);
      });
      delete result.child;
    }
    return result;
  });
};
