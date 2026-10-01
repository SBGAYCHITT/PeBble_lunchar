// 实例系统：实例表放在 userData，游戏目录放在 userData/instances 下（除非玩家自己指定）
const fs = require('fs');
const instances = require('../instances');
const mcapi = require('../mcapi');
const { safe } = require('./util');

module.exports = function register(ctx) {
  const { ipcMain, userData, INST_ROOT } = ctx;

  ipcMain.handle('inst-list', (_e, mcDir, version) => {
    instances.ensureDefault({ root: userData, mcDir, version });
    const data = instances.list({ root: userData });
    // 顺带把每个实例的规模算出来给 UI 显示（存档数 / Mod 数 / 体积）
    for (const i of data.instances) {
      try { i.stats = instances.stats({ gameDir: instances.resolveGameDir({ inst: i, mcDir, isolation: false, version }) }); }
      catch { i.stats = null; }
    }
    return data;
  });

  ipcMain.handle('inst-active', (_e, mcDir, isolation, version) => {
    instances.ensureDefault({ root: userData, mcDir, version });
    const inst = instances.active({ root: userData }) || { gameDir: '' };
    return { inst, gameDir: instances.resolveGameDir({ inst, mcDir, isolation, version }) };
  });

  ipcMain.handle('inst-get', (_e, id) => instances.get({ root: userData, id }));

  ipcMain.handle('inst-set-active', (_e, id) => {
    const r = instances.setActive({ root: userData, id });
    instances.touchPlayed({ root: userData, id });
    return r;
  });

  ipcMain.handle('inst-create', safe((_e, o) =>
    instances.create(Object.assign({ root: userData, instancesRoot: INST_ROOT }, o || {}))));

  ipcMain.handle('inst-duplicate', safe((_e, o) =>
    instances.duplicate(Object.assign({ root: userData, instancesRoot: INST_ROOT }, o || {}))));

  ipcMain.handle('inst-update', safe((_e, id, patch) =>
    instances.update({ root: userData, id, patch: patch || {} })));

  ipcMain.handle('inst-remove', safe((_e, id, deleteFiles) =>
    instances.remove({ root: userData, id, deleteFiles: !!deleteFiles })));

  ipcMain.handle('inst-copyable', () => instances.COPYABLE);

  ipcMain.handle('inst-open', (_e, id, mcDir) => {
    const inst = instances.get({ root: userData, id });
    const gd = inst ? instances.resolveGameDir({ inst, mcDir, isolation: false, version: inst.version }) : null;
    if (gd && fs.existsSync(gd)) mcapi.openFolder(gd);
    return gd;
  });
};
