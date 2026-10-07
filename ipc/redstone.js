// 红石电路模拟 IPC（V4 第五组：红石电路模拟器）
//
// 状态放**主进程**：电路对象里有 Map/Set，而且每 tick 都要在整张图上做
// 松弛迭代。让渲染层持有一份、每次操作把整张电路传回来，既慢又容易两边不一致。
// 所以渲染层只发「操作」，拿回一份 snapshot 用于绘制 —— 单一数据源。
//
// 只有 redstone-import 会碰文件系统，而且是**只读**扫存档；其余全是内存计算。
const redstone = require('../redstone');
const { safe } = require('./util');

/* ---------- 内置示例电路（用户点一下就能看到东西在动） ---------- */

/** @type {Array<{id:string, zh:string, note:string, build:(c:any)=>void}>} */
const SAMPLES = [
  {
    id: 'torchclock',
    zh: '火把时钟',
    note: '两个火把夹着方块互相反相，信号每 tick 翻转 —— 最经典的红石时钟',
    build(c) {
      redstone.place(c, 1, 0, 'block');
      redstone.place(c, 1, 1, 'torch', { facing: 'n' });
      redstone.place(c, 2, 1, 'block');
      redstone.place(c, 2, 0, 'torch', { facing: 's' });
      redstone.probe(c, 1, 1);
      redstone.probe(c, 2, 0);
    }
  },
  {
    id: 'not',
    zh: '反相器（非门）',
    note: '拉杆通电 → 方块被充能 → 火把熄灭 → 灯灭。这就是「非门」',
    build(c) {
      redstone.place(c, 0, 1, 'lever', { facing: 'e' });
      redstone.place(c, 1, 1, 'block');
      redstone.place(c, 1, 0, 'torch', { facing: 's' });
      redstone.place(c, 1, -1, 'wire');
      redstone.place(c, 2, -1, 'wire');
      redstone.place(c, 3, -1, 'lamp');
      redstone.probe(c, 1, 0);
      redstone.probe(c, 3, -1);
    }
  },
  {
    id: 'delay',
    zh: '延时对比（1~4 tick）',
    note: '四台中继器延迟分别是 1/2/3/4 tick，拉杆一开就能看出信号先后到',
    build(c) {
      redstone.place(c, 0, 0, 'lever', { facing: 'e' });
      redstone.place(c, 1, 0, 'wire');
      for (let i = 0; i < 4; i++) {
        const y = i * 2;
        redstone.place(c, 2, y, 'repeater', { facing: 'e', delay: i + 1 });
        redstone.place(c, 3, y, 'wire');
        redstone.place(c, 4, y, 'lamp');
        redstone.probe(c, 4, y);
      }
    }
  },
  {
    id: 'decay',
    zh: '信号衰减',
    note: '红石线每走一格强度 −1，走满 15 格就完全没信号了',
    build(c) {
      redstone.place(c, 0, 0, 'lever', { facing: 'e' });
      for (let x = 1; x <= 17; x++) redstone.place(c, x, 0, 'wire');
      redstone.place(c, 18, 0, 'lamp');
      redstone.probe(c, 18, 0);
    }
  },
  {
    id: 'compare',
    zh: '比较器（比较 / 减法）',
    note: '上面是 compare 模式、下面是 subtract 模式，侧输入都来自同一个拉杆',
    build(c) {
      // 后侧输入：一条 8 格长的线，末端强度 8
      redstone.place(c, 0, 0, 'lever', { facing: 'e' });
      for (let x = 1; x <= 7; x++) redstone.place(c, x, 0, 'wire');
      // 侧输入源（上下共用）
      redstone.place(c, 7, -3, 'lever', { facing: 's' });
      redstone.place(c, 7, -2, 'wire');
      redstone.place(c, 7, -1, 'wire');
      // compare
      redstone.place(c, 8, 0, 'comparator', { facing: 'e', mode: 'compare' });
      redstone.place(c, 9, 0, 'lamp');
      // subtract
      redstone.place(c, 8, 2, 'comparator', { facing: 'e', mode: 'subtract' });
      redstone.place(c, 9, 2, 'lamp');
      redstone.probe(c, 9, 0);
      redstone.probe(c, 9, 2);
    }
  }
];

module.exports = function register(ctx) {
  const { ipcMain, dialog } = ctx;

  /** 当前电路（单一数据源） */
  let circuit = redstone.createCircuit();

  /** 统一的返回：snapshot + 规模 */
  function snap(extra) {
    return Object.assign({ ok: true }, redstone.snapshot(circuit), redstone.stats(circuit), extra || {});
  }

  /* ---------- 元件清单与示例 ---------- */

  ipcMain.handle('redstone-components', safe(() => redstone.COMPONENTS.map((c) => ({
    id: c.id, zh: c.zh, en: c.en, kind: c.kind, color: c.color, hotkey: c.hotkey
  }))));

  ipcMain.handle('redstone-samples', safe(() => SAMPLES.map((s) => ({
    id: s.id, zh: s.zh, note: s.note
  }))));

  ipcMain.handle('redstone-sample', safe((_e, id) => {
    const s = SAMPLES.find((x) => x.id === id);
    if (!s) return { ok: false, error: '未知示例 ' + id };
    circuit = redstone.createCircuit();
    s.build(circuit);
    // 装载后跑到**静定**为止（不是写死几刻）：火把/中继器都是 1 tick 延迟的，
    // 第 1 刻只把目标排队、不输出 —— 只跑 1 刻的话示例打开就是「没通电」的样子
    // （灯不亮、火把不亮），用户会以为坏了。而到底要几刻取决于电路里有几级延迟元件，
    // 调用方算不出来，交给 settle 的收敛条件决定。
    // 振荡电路（火把时钟）永远静定不了，settle 会按上限收尾。
    redstone.settle(circuit);
    return snap({ sample: id, zh: s.zh, note: s.note });
  }));

  /* ---------- 编辑 ---------- */

  ipcMain.handle('redstone-new', safe(() => {
    circuit = redstone.createCircuit();
    return snap();
  }));

  ipcMain.handle('redstone-place', safe((_e, o) => {
    const p = o || {};
    const x = Math.round(Number(p.x) || 0), y = Math.round(Number(p.y) || 0);
    redstone.place(circuit, x, y, String(p.type), p.patch || {});
    return snap();
  }));

  ipcMain.handle('redstone-remove', safe((_e, o) => {
    const p = o || {};
    redstone.remove(circuit, Math.round(Number(p.x) || 0), Math.round(Number(p.y) || 0));
    return snap();
  }));

  ipcMain.handle('redstone-set', safe((_e, o) => {
    const p = o || {};
    redstone.setProp(circuit, Math.round(Number(p.x) || 0), Math.round(Number(p.y) || 0), p.patch || {});
    // 扳拉杆/按按钮是「我动了电路一下」，等价于过去一刻 —— 只改 on 不推进的话，
    // 下游的红石线和灯要等用户再点一次「+1 刻」才变，看起来像没反应。
    // 拖延迟/朝向这类纯配置改动不推进时间。
    if (p.patch && Object.prototype.hasOwnProperty.call(p.patch, 'on')) redstone.settle(circuit);
    return snap();
  }));

  ipcMain.handle('redstone-rotate', safe((_e, o) => {
    const p = o || {};
    redstone.rotate(circuit, Math.round(Number(p.x) || 0), Math.round(Number(p.y) || 0));
    return snap();
  }));

  /* ---------- 模拟 ---------- */

  ipcMain.handle('redstone-reset', safe(() => {
    redstone.reset(circuit);
    return snap();
  }));

  ipcMain.handle('redstone-step', safe((_e, n) => {
    redstone.run(circuit, Math.max(1, Math.min(200, Number(n) || 1)));
    return snap();
  }));

  /* ---------- 探针与波形 ---------- */

  ipcMain.handle('redstone-probe', safe((_e, o) => {
    const p = o || {};
    const x = Math.round(Number(p.x) || 0), y = Math.round(Number(p.y) || 0);
    if (p.on === false) redstone.unprobe(circuit, x, y);
    else redstone.probe(circuit, x, y);
    return snap();
  }));

  ipcMain.handle('redstone-wave', safe((_e, last) => ({
    ok: true,
    tick: circuit.tick,
    waves: redstone.allWaveforms(circuit, Math.max(1, Math.min(2000, Number(last) || 200)))
  })));

  /* ---------- 导出 ---------- */

  ipcMain.handle('redstone-ascii', safe(() => ({ ok: true, art: redstone.toAscii(circuit) })));

  ipcMain.handle('redstone-save', safe(async (_e, name) => {
    const r = await dialog.showSaveDialog(ctx.getWin(), {
      title: '保存电路',
      defaultPath: String(name || 'circuit.json'),
      filters: [{ name: '电路文件', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    const fs = require('fs');
    const data = redstone.serialize(circuit);
    fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2), 'utf8');
    return { ok: true, file: r.filePath, cells: data.cells.length };
  }));

  ipcMain.handle('redstone-load', safe(async () => {
    const r = await dialog.showOpenDialog(ctx.getWin(), {
      title: '打开电路',
      properties: ['openFile'],
      filters: [{ name: '电路文件', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    circuit = redstone.deserialize(data);
    // 装载后跑到**静定**为止（不是写死几刻）：火把/中继器都是 1 tick 延迟的，
    // 第 1 刻只把目标排队、不输出 —— 只跑 1 刻的话示例打开就是「没通电」的样子
    // （灯不亮、火把不亮），用户会以为坏了。而到底要几刻取决于电路里有几级延迟元件，
    // 调用方算不出来，交给 settle 的收敛条件决定。
    // 振荡电路（火把时钟）永远静定不了，settle 会按上限收尾。
    redstone.settle(circuit);
    return snap({ file: r.filePaths[0] });
  }));

  /* ---------- 从存档导入（只读） ---------- */

  ipcMain.handle('redstone-import', safe(async (_e, o) => {
    const p = o || {};
    const res = await redstone.importFromSave({
      saveDir: String(p.saveDir || ''),
      dim: p.dim || 'overworld',
      x1: Math.round(Number(p.x1) || 0),
      z1: Math.round(Number(p.z1) || 0),
      x2: Math.round(Number(p.x2) || 0),
      z2: Math.round(Number(p.z2) || 0),
      y: Math.round(Number(p.y) || 0)
    });
    if (!res.ok) return res;
    circuit = res.circuit;
    // 装载后跑到**静定**为止（不是写死几刻）：火把/中继器都是 1 tick 延迟的，
    // 第 1 刻只把目标排队、不输出 —— 只跑 1 刻的话示例打开就是「没通电」的样子
    // （灯不亮、火把不亮），用户会以为坏了。而到底要几刻取决于电路里有几级延迟元件，
    // 调用方算不出来，交给 settle 的收敛条件决定。
    // 振荡电路（火把时钟）永远静定不了，settle 会按上限收尾。
    redstone.settle(circuit);
    return snap({
      origin: res.origin, w: res.w, h: res.h,
      counts: res.counts, skipped: res.skipped
    });
  }));
};
