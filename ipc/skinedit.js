// 皮肤编辑器 IPC（V4 第五组：3D 皮肤编辑器）
//
// 分工：**数据在主进程、绘制在渲染层**。
//   主进程负责 PNG 编解码、镜像、校验、模板生成（这些要文件系统 + zlib，也只能在这里做）；
//   渲染层只拿 dataUrl 和几何数据，用 canvas 画 —— 3D 预览是软件光栅化的纹理四边形。
//
// 为什么用 dataUrl 而不是传 Uint8Array：
//   IPC 传二进制会变成普通对象/ArrayBuffer，渲染层要再转一次；64×64 的图本来就小，
//   直接给 `data:image/png;base64,...` 最省事，`<img>` / `drawImage` 拿来就能用。
//
// 所有写的操作都**默认不覆盖**：skin-save 会先问一次，除非显式 overwrite。
const path = require('path');
const skinedit = require('../skinedit');
const { safe } = require('./util');

module.exports = function register(ctx) {
  const { ipcMain, dialog } = ctx;

  /** 读一个皮肤文件并附上校验信息（供 UI 直接展示） */
  function loadFull(file) {
    const l = skinedit.loadSkin(file);
    if (!l.ok) return l;
    const img = { w: l.w, h: l.h, rgba: l.rgba };
    return {
      ok: true,
      file: l.file,
      w: l.w, h: l.h,
      legacy: l.legacy,
      dataUrl: skinedit.toDataUrl(img),
      validate: skinedit.validate(img),
      stats: skinedit.stats(img),
      coverage: skinedit.overlayCoverage(img)
    };
  }

  /* ---------- 元数据 ---------- */

  ipcMain.handle('skin-meta', safe(() => {
    /** @param {any} p */
    const withUv = (p) => ({
      id: p.id, zh: p.zh, w: p.w, h: p.h, d: p.d,
      u0: p.u0, v0: p.v0, uv: skinedit.partUv(p)
    });
    return {
      parts: skinedit.PARTS.map(withUv),
      overlay: skinedit.OVERLAY.map((o) => {
        const b = skinedit.PARTS.find((p) => p.id === o.of);
        return {
          id: o.id, zh: o.zh, of: o.of,
          uv: b ? skinedit.uvOf(b.w, b.h, b.d, o.u0, o.v0) : null
        };
      }),
      faces: skinedit.FACE_ORDER,
      faceZh: skinedit.FACE_ZH,
      palette: skinedit.PALETTE,
      size: skinedit.SIZE_MODERN,
      legacySize: skinedit.SIZE_LEGACY,
      templates: skinedit.TEMPLATES.map((t) => ({ id: t.id, zh: t.zh, en: t.en }))
    };
  }));

  /**
   * 立方体模型几何。一次性取回，渲染层反复用来投影 —— 每次转动镜头都走 IPC 就太吵了。
   * @param {boolean} [overlay] 是否含第二层（默认含）
   */
  ipcMain.handle('skin-mesh', safe((_e, overlay) => {
    const mesh = skinedit.buildMesh({ overlay: overlay !== false });
    return {
      ok: true,
      count: mesh.length,
      faces: mesh.map((f) => ({
        part: f.part, partZh: f.partZh, face: f.face, layer: f.layer,
        uv: f.uv,
        quad: f.quad.map((v) => [v.x, v.y, v.z])
      }))
    };
  }));

  /* ---------- 模板 ---------- */

  ipcMain.handle('skin-template', safe((_e, id) => {
    const img = skinedit.fromTemplate(String(id || 'blank'));
    return {
      ok: true, w: img.w, h: img.h,
      dataUrl: skinedit.toDataUrl(img),
      validate: skinedit.validate(img)
    };
  }));

  /* ---------- 读 ---------- */

  ipcMain.handle('skin-pick', safe(async () => {
    const r = await dialog.showOpenDialog(ctx.getWin(), {
      title: '选择皮肤',
      properties: ['openFile'],
      filters: [{ name: 'Minecraft 皮肤', extensions: ['png'] }]
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    return loadFull(r.filePaths[0]);
  }));

  ipcMain.handle('skin-load', safe((_e, file) => loadFull(String(file || ''))));

  /* ---------- 写 ---------- */

  ipcMain.handle('skin-save', safe((_e, file, dataUrl) => {
    const img = skinedit.fromDataUrl(dataUrl);
    if (!img.ok) return img;
    return skinedit.saveSkin(String(file || ''), { w: img.w, h: img.h, rgba: img.rgba });
  }));

  ipcMain.handle('skin-save-as', safe(async (_e, dataUrl, name) => {
    const r = await dialog.showSaveDialog(ctx.getWin(), {
      title: '保存皮肤',
      defaultPath: String(name || 'skin.png'),
      filters: [{ name: 'PNG 图片', extensions: ['png'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    const img = skinedit.fromDataUrl(dataUrl);
    if (!img.ok) return img;
    const saved = skinedit.saveSkin(r.filePath, { w: img.w, h: img.h, rgba: img.rgba });
    if (saved.ok) saved.file = r.filePath;
    return saved;
  }));

  /* ---------- 变换与校验 ---------- */

  ipcMain.handle('skin-mirror', safe((_e, dataUrl) => {
    const d = skinedit.fromDataUrl(dataUrl);
    if (!d.ok) return d;
    const img = { w: d.w, h: d.h, rgba: d.rgba };
    const r = skinedit.mirrorLR(img);
    if (!r.ok) return { ok: false, error: '只有 64×64 的皮肤支持左右镜像' };
    return { ok: true, swap: r.swap, dataUrl: skinedit.toDataUrl(img) };
  }));

  ipcMain.handle('skin-validate', safe((_e, dataUrl) => {
    const d = skinedit.fromDataUrl(dataUrl);
    if (!d.ok) return d;
    const img = { w: d.w, h: d.h, rgba: d.rgba };
    return Object.assign({ ok: true }, skinedit.validate(img), {
      coverage: skinedit.overlayCoverage(img)
    });
  }));

  /**
   * 按部件取该部件的 2D 展开图（放大后截出来给 UI 显示）。
   * 渲染层要画「当前在编辑哪个部位」的对照图，自己算 UV 容易和内核跑偏，所以由内核裁剪。
   * @param {string} dataUrl @param {string} partId
   * @param {number} [scale]
   */
  ipcMain.handle('skin-part-map', safe((_e, dataUrl, partId, scale) => {
    const d = skinedit.fromDataUrl(dataUrl);
    if (!d.ok) return d;
    const k = Math.max(1, Math.min(24, Number(scale) || 6));
    const src = { w: d.w, h: d.h, rgba: d.rgba };
    const part = skinedit.PARTS.find((p) => p.id === partId);
    if (!part) return { ok: false, error: '未知部件 ' + partId };

    // 输出「该部件的展开块」整块：宽 2*d+2*w、高 d+h
    const bw = 2 * part.d + 2 * part.w, bh = part.d + part.h;
    const out = skinedit.blankImage(bw * k, bh * k);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const c = skinedit.getPixel(src, part.u0 + x, part.v0 + y);
        for (let dy = 0; dy < k; dy++) {
          for (let dx = 0; dx < k; dx++) {
            // 只放大 alpha > 0 的像素；其余保持透明，UI 自己铺棋盘格背景
            if (c[3] > 0) skinedit.setPixel(out, x * k + dx, y * k + dy, c);
          }
        }
      }
    }
    return {
      ok: true, part: partId, zh: part.zh,
      u0: part.u0, v0: part.v0, bw, bh, scale: k,
      dataUrl: skinedit.toDataUrl(out)
    };
  }));
};
