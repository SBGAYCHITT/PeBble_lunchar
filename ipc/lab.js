// JVM A/B 调优实验室
const fs = require('fs');
const os = require('os');
const path = require('path');
const launcher = require('../launcher');
const jvmlab = require('../jvmlab');
const multilaunch = require('../multilaunch');

module.exports = function register(ctx) {
  const { ipcMain, emit } = ctx;

  ipcMain.handle('lab-presets', (_e, javaMajor) => ({ ok: true, presets: jvmlab.usablePresets(javaMajor) }));

  ipcMain.handle('lab-mem-advice', () => {
    const totalGB = os.totalmem() / 1073741824;
    const r = jvmlab.recommendMem(totalGB);
    return {
      ok: true,
      totalGB: Math.round(totalGB * 10) / 10,
      recommendGB: r.gb,
      note: r.note,
      saneMaxGB: jvmlab.saneMax(totalGB)
    };
  });

  ipcMain.handle('lab-history', () => jvmlab.loadHistory());
  ipcMain.handle('lab-summary', () => ({ ok: true, rows: jvmlab.presetSummary(jvmlab.loadHistory().runs) }));
  ipcMain.handle('lab-clear', () => jvmlab.clearHistory());

  ipcMain.handle('lab-compare', (_e, aId, bId) => {
    const runs = jvmlab.loadHistory().runs;
    const byPreset = {};
    for (const r of runs) (byPreset[r.presetId] = byPreset[r.presetId] || []).push(r);
    const a = jvmlab.aggregate(byPreset[aId] || []);
    const b = jvmlab.aggregate(byPreset[bId] || []);
    const pa = jvmlab.getPreset(aId), pb = jvmlab.getPreset(bId);
    const rows = jvmlab.compare(a, b);
    return {
      ok: true, rows,
      nameA: pa ? pa.name : aId, nameB: pb ? pb.name : bId,
      a, b, verdict: jvmlab.verdict(rows, pa ? pa.name : aId, pb ? pb.name : bId)
    };
  });

  /**
   * 真正跑一次基准：用指定预设 + GC 日志启动游戏，蹲守到「到主菜单」后自动关闭。
   * 整段逻辑跑在实际的 Java 进程上，所以失败信息必须能回给用户看（缺 Java / 版本没装 / 预设不支持）。
   */
  ipcMain.handle('lab-run', async (_e, o) => {
    const sendLog = (line) => emit('game-log', line);
    try {
      const opts = o || {};
      const mcDir = opts.mcDir;
      const version = opts.version;
      const memMB = Math.max(1024, parseInt(opts.memMB, 10) || 4096);

      // 1) 先确认用哪个 Java —— 预设要按 Java 版本过滤（ZGC 需要 17+），GC 日志语法也分 8 / 9+ 两套
      let javaPath = opts.javaPath || '';
      let javaVer = null;
      if (javaPath && fs.existsSync(javaPath)) javaVer = await launcher.javaVersionOf(javaPath);
      if (!javaVer) {
        const det = await launcher.detectJava(mcDir, launcher.requiredJavaMajor(version));
        if (!det) return { ok: false, error: '未找到可用的 Java' };
        javaPath = det.path; javaVer = det.version;
      }
      const javaMajor = parseInt(String(javaVer).split(/[._]/)[0], 10) || 0;
      sendLog(`[实验室] Java ${javaVer}（主版本 ${javaMajor}）`);

      // 2) 组参数：预设 + GC 日志
      const gcLogName = `pl-gc-${Date.now().toString(36)}.log`;
      const built = jvmlab.buildBenchArgs({
        presetId: opts.presetId, javaMajor, gcLogName, extraArgs: opts.extraArgs
      });
      if (!built) {
        return {
          ok: false,
          error: `预设 ${opts.presetId} 需要 Java ${(jvmlab.getPreset(opts.presetId) || {}).minJava || '?'}+，当前是 ${javaMajor}`
        };
      }
      sendLog('[实验室] JVM 参数: ' + built.args.join(' '));

      const result = await launcher.launchGame({
        version, mcDir, gameDir: opts.gameDir, account: opts.account,
        javaPath, maxMemMB: memMB, jvmArgs: built.args.join(' '),
        isolation: false, width: opts.width || 854, height: opts.height || 480,
        authlibInjector: opts.authlibInjector
      }, sendLog);
      if (!result.ok || !result.child) return { ok: false, error: (result && result.error) || '启动失败' };

      const child = result.child;
      // 实验室进程也登记进多开表，界面上能看到它在跑
      const entry = multilaunch.add({
        pid: child.pid, instanceId: 'lab', instanceName: 'JVM 实验室',
        accountUuid: opts.account && opts.account.uuid,
        accountName: opts.account && opts.account.name,
        accountType: opts.account && opts.account.type,
        version, gameDir: result.gameDir
      });
      emit('ml-changed', multilaunch.list());
      child.on('close', () => { multilaunch.markExited(child.pid); emit('ml-changed', multilaunch.list()); });

      // 3) 蹲守采样
      const probe = jvmlab.attachProbe(child, {
        pid: child.pid, startedAt: Date.now(), gameDir: result.gameDir, gcLogName,
        presetId: opts.presetId, version, memMB, javaMajor,
        quietMs: opts.quietMs, holdMs: opts.holdMs, timeoutMs: opts.timeoutMs,
        autoClose: opts.autoClose !== false, logger: sendLog,
        onUpdate: (s) => emit('lab-progress', Object.assign({ presetId: opts.presetId }, s))
      });
      const run = await probe.promise;
      // GC 日志文件是临时产物，跑完顺手删，别在游戏目录里堆
      try { fs.unlinkSync(path.join(result.gameDir, gcLogName)); } catch {}
      return { ok: true, run, entry };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
};
