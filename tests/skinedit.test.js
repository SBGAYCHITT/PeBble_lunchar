// skinedit.js 单元测试
//
// 这个模块的两类风险完全不一样，测试也分两条线：
//   ① PNG 编解码 —— 产物要给游戏读、还要能反复编辑不劣化。
//      所以重点测「编码 → 解码逐字节一致」，并且**五种滤波类型都要验**
//      （自己编码只写滤波 0，光测往返覆盖不到反滤波，那才是最易错的一段）。
//   ② 几何 / 分区 —— 错了不会报错，只会「脸贴在后脑勺」。
//      所以要把 uv 区域的重叠、面顶点的朝向都钉死。

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const se = require('../skinedit');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name); console.log('      ' + (e && e.message)); }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || '断言失败'}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}
function ok(v, msg) { if (!v) throw new Error(msg || '期望为真'); }
function near(a, b, tol, msg) {
  if (Math.abs(a - b) > tol) throw new Error(`${msg || '断言失败'}: 期望约 ${b}，实际 ${a}`);
}
function deepEq(a, b, msg) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg || '断言失败'}: 期望 ${sb}，实际 ${sa}`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-sk-'));

console.log('skinedit.js');

/* ============================================================
 * 测试辅助：手工造一张指定滤波类型的 PNG
 * ============================================================ */

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(se.crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 把 RGBA 按指定滤波类型编码成 PNG（用于反向验证解码器的反滤波） */
function makePng(w, h, rgba, filterType) {
  const stride = w * 4;
  const px = Buffer.from(rgba);
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = filterType;
    const outStart = y * (stride + 1) + 1;
    const inStart = y * stride;
    const upStart = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const cur = px[inStart + x];
      const a = x >= 4 ? px[inStart + x - 4] : 0;
      const b = y > 0 ? px[upStart + x] : 0;
      const c = (x >= 4 && y > 0) ? px[upStart + x - 4] : 0;
      let pred = 0;
      if (filterType === 1) pred = a;
      else if (filterType === 2) pred = b;
      else if (filterType === 3) pred = (a + b) >> 1;
      else if (filterType === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      raw[outStart + x] = (cur - pred) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/** 造一张确定性的随机图（不用 Math.random，保证失败可复现） */
function noiseImage(w, h, seed) {
  const rgba = new Uint8Array(w * h * 4);
  let s = seed || 12345;
  for (let i = 0; i < rgba.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    rgba[i] = s & 0xff;
  }
  return { w, h, rgba };
}

/* ============================================================
 * PNG 编解码
 * ============================================================ */

t('PNG：crc32 已知向量 "123456789" = 0xCBF43926', () => {
  eq(se.crc32(Buffer.from('123456789', 'ascii')), 0xcbf43926);
});

t('PNG：编码后再解码，逐字节一致（64×64 噪声图）', () => {
  const img = noiseImage(64, 64, 7);
  const png = se.encodePng(img);
  const back = se.decodePng(png);
  eq(back.w, 64, '宽');
  eq(back.h, 64, '高');
  eq(Buffer.from(back.rgba).equals(Buffer.from(img.rgba)), true, '像素应完全一致');
});

t('PNG：非正方形也能往返（16×4）', () => {
  const img = noiseImage(16, 4, 99);
  const back = se.decodePng(se.encodePng(img));
  eq(back.w, 16); eq(back.h, 4);
  eq(Buffer.from(back.rgba).equals(Buffer.from(img.rgba)), true);
});

// 自己编码只写滤波 0，所以下面四条专门验反滤波 1~4。
// 这几种滤波写错不会崩，只会让整张图斜切/发糊，靠肉眼看很难发现。
for (const ft of [0, 1, 2, 3, 4]) {
  t(`PNG：反滤波类型 ${ft} 能正确还原`, () => {
    const img = noiseImage(24, 9, 1000 + ft);
    const back = se.decodePng(makePng(24, 9, img.rgba, ft));
    eq(Buffer.from(back.rgba).equals(Buffer.from(img.rgba)), true, `滤波 ${ft}`);
  });
}

t('PNG：签名不对时明确抛错', () => {
  let threw = false;
  try { se.decodePng(Buffer.from('not a png at all')); } catch (e) { threw = true; }
  ok(threw, '应抛错');
});

t('PNG：16-bit 明确抛错（不静默猜）', () => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4);
  ihdr[8] = 16; ihdr[9] = 6;
  const buf = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IEND', Buffer.alloc(0))
  ]);
  let msg = '';
  try { se.decodePng(buf); } catch (e) { msg = e.message; }
  ok(/8-bit/.test(msg), '错误信息应点明只支持 8-bit，实际: ' + msg);
});

t('PNG：隔行（Adam7）明确抛错', () => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[12] = 1;
  const buf = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IEND', Buffer.alloc(0))
  ]);
  let msg = '';
  try { se.decodePng(buf); } catch (e) { msg = e.message; }
  ok(/隔行/.test(msg), '实际: ' + msg);
});

/* ============================================================
 * 分区表：uv 公式与不重叠
 * ============================================================ */

const P = (id) => se.PARTS.find((p) => p.id === id);

t('分区：body 的六个面位置符合 MC 标准展开', () => {
  const uv = se.partUv(P('body'));
  deepEq(uv.top, { x: 20, y: 16, w: 8, h: 4 }, 'top');
  deepEq(uv.bottom, { x: 28, y: 16, w: 8, h: 4 }, 'bottom');
  deepEq(uv.right, { x: 16, y: 20, w: 4, h: 12 }, 'right');
  deepEq(uv.front, { x: 20, y: 20, w: 8, h: 12 }, 'front');
  deepEq(uv.left, { x: 28, y: 20, w: 4, h: 12 }, 'left');
  deepEq(uv.back, { x: 32, y: 20, w: 8, h: 12 }, 'back');
});

t('分区：head 的六个面位置符合 MC 标准展开', () => {
  const uv = se.partUv(P('head'));
  deepEq(uv.top, { x: 8, y: 0, w: 8, h: 8 }, 'top');
  deepEq(uv.front, { x: 8, y: 8, w: 8, h: 8 }, 'front');
  deepEq(uv.back, { x: 24, y: 8, w: 8, h: 8 }, 'back');
});

t('分区：腿/臂都是 4×12×4，展开区 16×16', () => {
  for (const id of ['armR', 'armL', 'legR', 'legL']) {
    const uv = se.partUv(P(id));
    deepEq(uv.top, { x: P(id).u0 + 4, y: P(id).v0, w: 4, h: 4 }, id + ' top');
    deepEq(uv.back, { x: P(id).u0 + 12, y: P(id).v0 + 4, w: 4, h: 12 }, id + ' back');
  }
});

t('分区：本体 36 个面区域两两不重叠，且都在 64×64 内', () => {
  const cnt = new Int8Array(64 * 64);
  for (const p of se.PARTS) {
    const uv = se.partUv(p);
    for (const f of se.FACE_ORDER) {
      const r = uv[f];
      ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 64 && r.y + r.h <= 64, `${p.id}.${f} 越界`);
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          const i = y * 64 + x;
          eq(cnt[i], 0, `${p.id}.${f} 与其它区域在 (${x},${y}) 重叠`);
          cnt[i] = 1;
        }
      }
    }
  }
});

t('分区：加上第二层后仍然两两不重叠', () => {
  const cnt = new Int8Array(64 * 64);
  const all = [];
  for (const p of se.PARTS) all.push({ id: p.id, uv: se.partUv(p) });
  for (const o of se.OVERLAY) {
    const b = P(o.of);
    all.push({ id: o.id, uv: se.uvOf(b.w, b.h, b.d, o.u0, o.v0) });
  }
  for (const item of all) {
    for (const f of se.FACE_ORDER) {
      const r = item.uv[f];
      ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 64 && r.y + r.h <= 64, `${item.id}.${f} 越界`);
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          const i = y * 64 + x;
          eq(cnt[i], 0, `${item.id}.${f} 与其它区域在 (${x},${y}) 重叠`);
          cnt[i] = 1;
        }
      }
    }
  }
});

/* ============================================================
 * 几何：面顶点朝向
 * ============================================================ */

t('几何：boxFaces 返回 6 个面，名字齐全', () => {
  const fs_ = se.boxFaces(0, 0, 0, 8, 12, 4, 0);
  eq(fs_.length, 6);
  deepEq(fs_.map((f) => f.face).sort(), ['back', 'bottom', 'front', 'left', 'right', 'top']);
});

t('几何：每个面的 4 个顶点都落在该面所在的平面上', () => {
  const faces = se.boxFaces(0, 0, 0, 8, 12, 4, 0);
  const byName = Object.fromEntries(faces.map((f) => [f.face, f.quad]));
  eq(byName.front.every((v) => v.z === 2), true, 'front 应在 z=+2');
  eq(byName.back.every((v) => v.z === -2), true, 'back 应在 z=-2');
  eq(byName.right.every((v) => v.x === 4), true, 'right 应在 x=+4');
  eq(byName.left.every((v) => v.x === -4), true, 'left 应在 x=-4');
  eq(byName.top.every((v) => v.y === 6), true, 'top 应在 y=+6');
  eq(byName.bottom.every((v) => v.y === -6), true, 'bottom 应在 y=-6');
});

t('几何：盒子的包围盒尺寸等于传入的 w/h/d', () => {
  const q = se.boxFaces(0, 0, 0, 8, 12, 4, 0).flatMap((f) => f.quad);
  const xs = q.map((v) => v.x), ys = q.map((v) => v.y), zs = q.map((v) => v.z);
  eq(Math.max(...xs) - Math.min(...xs), 8);
  eq(Math.max(...ys) - Math.min(...ys), 12);
  eq(Math.max(...zs) - Math.min(...zs), 4);
});

t('几何：inflate 让盒子向外膨胀（用于第二层）', () => {
  const a = se.boxFaces(0, 0, 0, 8, 8, 8, 0).flatMap((f) => f.quad).map((v) => v.x);
  const b = se.boxFaces(0, 0, 0, 8, 8, 8, 0.5).flatMap((f) => f.quad).map((v) => v.x);
  eq(Math.max(...b) - Math.max(...a), 0.5);
});

t('几何：buildMesh 默认把第二层一起装配，共 72 面（12 盒 × 6 面）', () => {
  eq(se.buildMesh().length, 72);
});

t('几何：关闭第二层只剩本体 36 面', () => {
  eq(se.buildMesh({ overlay: false }).length, 36);
});

t('几何：显式 overlay:true 与默认一致', () => {
  eq(se.buildMesh({ overlay: true }).length, 72);
});

t('几何：可以只装配指定部件', () => {
  const m = se.buildMesh({ parts: ['head'], overlay: false });
  eq(m.length, 6);
  eq(m.every((f) => f.part === 'head'), true);
});

t('几何：每个面带 part / face / uv 三件套', () => {
  for (const f of se.buildMesh()) {
    ok(typeof f.part === 'string' && f.part, 'part');
    ok(se.FACE_ORDER.includes(f.face), 'face 非法: ' + f.face);
    ok(f.uv && f.uv.w > 0 && f.uv.h > 0, 'uv 缺失');
    eq(f.quad.length, 4, '四边形应有 4 个顶点');
  }
});

/* ============================================================
 * 投影
 * ============================================================ */

t('投影：原点投到画面中心', () => {
  const s = se.project({ x: 0, y: 0, z: 0 }, { scale: 10, cx: 100, cy: 100, camZ: 64 });
  near(s.x, 100, 1e-9); near(s.y, 100, 1e-9); near(s.depth, 64, 1e-9);
});

t('投影：模型 y 向上 → 屏幕 y 减小（不上下颠倒）', () => {
  const up = se.project({ x: 0, y: 10, z: 0 }, { scale: 10, cx: 100, cy: 100, camZ: 64 });
  ok(up.y < 100, '模型上方的点应该画在中心上方，实际 y=' + up.y);
});

t('投影：模型 x 向右 → 屏幕 x 增大', () => {
  const r = se.project({ x: 10, y: 0, z: 0 }, { scale: 10, cx: 100, cy: 100, camZ: 64 });
  ok(r.x > 100);
});

t('投影：相机背后的点返回 null（不是负深度）', () => {
  eq(se.project({ x: 0, y: 0, z: 999 }, { camZ: 64 }), null);
});

t('投影：正交 —— 远近同大（刻意如此，见下一条「平行四边形」）', () => {
  const nearP = se.project({ x: 8, y: 0, z: 32 }, { scale: 10, camZ: 64 });
  const farP = se.project({ x: 8, y: 0, z: -32 }, { scale: 10, camZ: 64 });
  near(nearP.x, farP.x, 1e-9, '正交下同一 x 不管多深都投到同一像素');
});

t('投影：persp=true 才恢复近大远小', () => {
  const c = { scale: 10, camZ: 64, persp: true };
  const nearP = se.project({ x: 8, y: 0, z: 32 }, c);
  const farP = se.project({ x: 8, y: 0, z: -32 }, c);
  ok(Math.abs(nearP.x) > Math.abs(farP.x), '近处的偏移应更大');
});

// 这条是整个渲染路径最容易踩坑的地方：canvas 2D 只能「两个三角形 + 仿射」贴一个面，
// 而仿射对平行四边形是精确的、对梯形有误差。所以「投影后还是平行四边形」是
// 皮肤上不会出现拼缝斜线的**充要条件**，必须钉死。
t('投影：任意面投影后仍是平行四边形（仿射贴图零误差 ⇒ 无拼缝）', () => {
  const mesh = se.buildMesh();
  for (const rotY of [0, 0.4, -0.6, 1.2, Math.PI / 2]) {
    for (const rotX of [0, 0.12, -0.35]) {
      const cam = { rotY, rotX, scale: 9, cx: 160, cy: 342, camZ: 256 };
      for (const f of mesh) {
        const p = f.quad.map((v) => se.project(v, cam));
        ok(p.every(Boolean), '示例相机下不该有顶点被剔除');
        // 平行四边形判据：对边向量相等
        const d1x = p[1].x - p[0].x, d1y = p[1].y - p[0].y;
        const d3x = p[2].x - p[3].x, d3y = p[2].y - p[3].y;
        const d2x = p[2].x - p[1].x, d2y = p[2].y - p[1].y;
        const d4x = p[3].x - p[0].x, d4y = p[3].y - p[0].y;
        near(d1x, d3x, 1e-9, `${f.part}/${f.face} 对边 x`);
        near(d1y, d3y, 1e-9, `${f.part}/${f.face} 对边 y`);
        near(d2x, d4x, 1e-9, `${f.part}/${f.face} 对边 x'`);
        near(d2y, d4y, 1e-9, `${f.part}/${f.face} 对边 y'`);
      }
    }
  }
});

t('投影：绕 y 轴旋转 90° 后 x 方向的信息转到 z 方向', () => {
  const s = se.project({ x: 10, y: 0, z: 0 }, { rotY: Math.PI / 2, scale: 10, cx: 0, cy: 0, camZ: 64 });
  near(s.x, 0, 1e-9, '旋转后 x 分量应归零');
});

t('投影：sortByDepth 按深度从远到近排序', () => {
  const arr = [{ depth: 1 }, { depth: 9 }, { depth: 5 }];
  deepEq(se.sortByDepth(arr).map((a) => a.depth), [9, 5, 1]);
});

t('投影：renderMesh 输出带屏幕坐标与深度', () => {
  const out = se.renderMesh(se.buildMesh({ overlay: false }), { scale: 10, cx: 100, cy: 100, camZ: 64 });
  eq(out.length, 36);
  for (const f of out) {
    eq(f.pts.length, 4);
    ok(Number.isFinite(f.pts[0].x) && Number.isFinite(f.pts[0].y));
    ok(Number.isFinite(f.depth));
  }
});

/* ============================================================
 * 像素编辑
 * ============================================================ */

t('编辑：setPixel / getPixel 往返', () => {
  const img = se.blankImage(8, 8);
  eq(se.setPixel(img, 3, 4, [10, 20, 30, 40]), true);
  deepEq(se.getPixel(img, 3, 4), [10, 20, 30, 40]);
});

t('编辑：越界写入返回 false 且不改动任何像素', () => {
  const img = se.blankImage(8, 8);
  eq(se.setPixel(img, -1, 0, [255, 0, 0, 255]), false);
  eq(se.setPixel(img, 8, 0, [255, 0, 0, 255]), false);
  eq(se.getPixel(img, -1, 0)[3], 0);
});

t('编辑：alpha 缺省为 255（不透明）', () => {
  const img = se.blankImage(2, 2);
  se.setPixel(img, 0, 0, [1, 2, 3]);
  eq(se.getPixel(img, 0, 0)[3], 255);
});

t('编辑：fillRect 覆盖指定矩形', () => {
  const img = se.blankImage(8, 8);
  se.fillRect(img, { x: 1, y: 1, w: 3, h: 2 }, [255, 0, 0, 255]);
  eq(se.getPixel(img, 1, 1)[0], 255);
  eq(se.getPixel(img, 3, 2)[0], 255);
  eq(se.getPixel(img, 4, 1)[3], 0, '矩形外不应被填');
});

t('编辑：floodFill 填充连通区并返回改动像素数', () => {
  const img = se.blankImage(8, 8);
  const n = se.floodFill(img, 0, 0, [0, 255, 0, 255]);
  eq(n, 64, '整张空白图应被一次填满');
});

t('编辑：floodFill 遇到异色边界会停下', () => {
  const img = se.blankImage(8, 8);
  // 竖着画一道墙，把图切成左右两块
  for (let y = 0; y < 8; y++) se.setPixel(img, 4, y, [255, 0, 0, 255]);
  const n = se.floodFill(img, 0, 0, [0, 0, 255, 255]);
  eq(n, 32, '只应填满左侧 4 列 × 8 行');
  eq(se.getPixel(img, 5, 0)[3], 0, '墙右侧应保持透明');
});

t('编辑：floodFill 目标色与当前色相同时返回 0（不死循环）', () => {
  const img = se.blankImage(4, 4, [0, 0, 0, 0]);
  eq(se.floodFill(img, 0, 0, [0, 0, 0, 0]), 0);
});

t('编辑：flipRectH 水平翻转', () => {
  const img = se.blankImage(4, 1);
  se.setPixel(img, 0, 0, [255, 0, 0, 255]);
  se.flipRectH(img, { x: 0, y: 0, w: 4, h: 1 });
  deepEq(se.getPixel(img, 3, 0), [255, 0, 0, 255]);
  eq(se.getPixel(img, 0, 0)[3], 0);
});

/* ============================================================
 * 模板
 * ============================================================ */

t('模板：四个模板都是 64×64', () => {
  for (const tpl of se.TEMPLATES) {
    const img = se.fromTemplate(tpl.id);
    eq(img.w, 64, tpl.id + ' 宽');
    eq(img.h, 64, tpl.id + ' 高');
  }
});

t('模板：未知 id 抛错而不是返回空图', () => {
  let threw = false;
  try { se.fromTemplate('nope'); } catch (e) { threw = true; }
  ok(threw);
});

t('模板：空白模板全透明', () => {
  eq(se.stats(se.fromTemplate('blank')).opaque, 0);
});

t('模板：分区导览把每个部件区域都填满（不透明）', () => {
  const img = se.fromTemplate('guide');
  for (const p of se.PARTS) {
    const uv = se.partUv(p);
    for (const f of se.FACE_ORDER) {
      const r = uv[f];
      ok(se.getPixel(img, r.x + 1, r.y + 1)[3] === 255, `${p.id}.${f} 左上应为不透明`);
      ok(se.getPixel(img, r.x + r.w - 2, r.y + r.h - 2)[3] === 255, `${p.id}.${f} 右下应为不透明`);
    }
  }
});

t('模板：分区导览给不同部位用了不同颜色', () => {
  const img = se.fromTemplate('guide');
  const c1 = se.getPixel(img, 1, 1);
  const c2 = se.getPixel(img, 41, 21);
  ok(c1[0] !== c2[0] || c1[1] !== c2[1] || c1[2] !== c2[2], '头与右臂颜色应不同');
});

t('模板：暖色人形有足够多的颜色（不是纯色块）', () => {
  const s = se.stats(se.fromTemplate('warm'));
  ok(s.colors > 20, '颜色数应 > 20，实际 ' + s.colors);
  ok(s.opaque > 1000, '应有大量不透明像素');
});

t('模板：暖色人形的正面有眼睛（深色像素）', () => {
  const img = se.fromTemplate('warm');
  const f = se.partUv(P('head')).front;
  let dark = 0;
  for (let x = 0; x < f.w; x++) for (let y = 0; y < f.h; y++) {
    const c = se.getPixel(img, f.x + x, f.y + y);
    if (c[0] < 80 && c[1] < 80) dark++;
  }
  ok(dark >= 4, '应至少有 4 个眼部像素，实际 ' + dark);
});

t('模板：像素网格有半透明的分隔线', () => {
  const s = se.stats(se.fromTemplate('grid'));
  ok(s.semi > 0, '应有半透明像素（网格线）');
  ok(s.opaque === 0, '网格模板不应有不透明像素（那样会挡住底图）');
});

/* ============================================================
 * 左右镜像
 * ============================================================ */

t('镜像：支持 64×64', () => {
  const img = se.blankImage(64, 64);
  eq(se.mirrorLR(img).ok, true);
});

t('镜像：非 64×64 时明确拒绝（返回 ok:false，不抛错）', () => {
  eq(se.mirrorLR(se.blankImage(64, 32)).ok, false);
  eq(se.mirrorLR(se.blankImage(32, 32)).ok, false);
});

t('镜像：左右臂的内容互换', () => {
  const img = se.blankImage(64, 64);
  const rUv = se.partUv(P('armR')), lUv = se.partUv(P('armL'));
  se.fillRect(img, rUv.front, [255, 0, 0, 255]);
  se.fillRect(img, lUv.front, [0, 0, 255, 255]);
  se.mirrorLR(img);
  deepEq(se.getPixel(img, lUv.front.x + 1, lUv.front.y + 1), [255, 0, 0, 255], '左臂应拿到原右臂的红色');
  deepEq(se.getPixel(img, rUv.front.x + 1, rUv.front.y + 1), [0, 0, 255, 255], '右臂应拿到原左臂的蓝色');
});

t('镜像：左右腿的内容互换', () => {
  const img = se.blankImage(64, 64);
  const rUv = se.partUv(P('legR')), lUv = se.partUv(P('legL'));
  se.fillRect(img, rUv.front, [255, 0, 0, 255]);
  se.fillRect(img, lUv.front, [0, 255, 0, 255]);
  se.mirrorLR(img);
  deepEq(se.getPixel(img, lUv.front.x + 1, lUv.front.y + 1), [255, 0, 0, 255]);
  deepEq(se.getPixel(img, rUv.front.x + 1, rUv.front.y + 1), [0, 255, 0, 255]);
});

t('镜像：正面图案水平翻转（不是原样搬过去）', () => {
  const img = se.blankImage(64, 64);
  const rUv = se.partUv(P('armR'));
  // 在前面的最左列画一条红竖线
  for (let y = 0; y < rUv.front.h; y++) se.setPixel(img, rUv.front.x, rUv.front.y + y, [255, 0, 0, 255]);
  se.mirrorLR(img);
  const lUv = se.partUv(P('armL'));
  deepEq(se.getPixel(img, lUv.front.x + lUv.front.w - 1, lUv.front.y), [255, 0, 0, 255], '线应落在左臂正面的最右列');
  eq(se.getPixel(img, lUv.front.x, lUv.front.y)[3], 0, '最左列应为空');
});

t('镜像：对合（镜像两次回到原状）', () => {
  const img = se.fromTemplate('warm');
  const before = Buffer.from(img.rgba).toString('base64');
  se.mirrorLR(img);
  se.mirrorLR(img);
  eq(Buffer.from(img.rgba).toString('base64'), before, '两次镜像应还原');
});

/* ============================================================
 * 旧格式归一化与校验
 * ============================================================ */

t('归一化：64×64 原样返回并标记 legacy=false', () => {
  const img = se.fromTemplate('warm');
  const out = se.normalizeSkin(img);
  eq(out.w, 64); eq(out.h, 64); eq(out.legacy, false);
  eq(Buffer.from(out.rgba).equals(Buffer.from(img.rgba)), true);
});

t('归一化：64×32 补齐为 64×64 并标记 legacy=true', () => {
  const small = se.blankImage(64, 32);
  se.fillRect(small, se.partUv(P('legR')).front, [255, 0, 0, 255]);
  const out = se.normalizeSkin(small);
  eq(out.w, 64); eq(out.h, 64); eq(out.legacy, true);
});

t('归一化：旧格式的左腿是右腿的**镜像**（不是直接复制 —— 那样会得到两条同向的腿）', () => {
  const small = se.blankImage(64, 32);
  const rLeg = se.partUv(P('legR'));
  // 右腿正面最左列画红：镜像后应出现在左腿正面的最右列
  for (let y = 0; y < rLeg.front.h; y++) se.setPixel(small, rLeg.front.x, rLeg.front.y + y, [255, 0, 0, 255]);
  const out = se.normalizeSkin(small);
  const lLeg = se.partUv(P('legL'));
  deepEq(se.getPixel(out, lLeg.front.x + lLeg.front.w - 1, lLeg.front.y), [255, 0, 0, 255], '左腿最右列');
  eq(se.getPixel(out, lLeg.front.x, lLeg.front.y)[3], 0, '左腿最左列不该有（说明是镜像而非平移）');
});

t('归一化：旧格式的左臂也是镜像补齐', () => {
  const small = se.blankImage(64, 32);
  const rArm = se.partUv(P('armR'));
  for (let y = 0; y < rArm.front.h; y++) se.setPixel(small, rArm.front.x, rArm.front.y + y, [0, 255, 0, 255]);
  const out = se.normalizeSkin(small);
  const lArm = se.partUv(P('armL'));
  deepEq(se.getPixel(out, lArm.front.x + lArm.front.w - 1, lArm.front.y), [0, 255, 0, 255]);
});

t('归一化：其它尺寸明确抛错', () => {
  let msg = '';
  try { se.normalizeSkin(se.blankImage(32, 32)); } catch (e) { msg = e.message; }
  ok(/64×64|64×32/.test(msg), '实际: ' + msg);
});

t('校验：正常皮肤 ok=true 且无错误', () => {
  const v = se.validate(se.fromTemplate('warm'));
  eq(v.ok, true);
  eq(v.errors.length, 0);
  eq(v.legacy, false);
});

t('校验：尺寸不对进 errors 且 ok=false', () => {
  const v = se.validate(se.blankImage(10, 10));
  eq(v.ok, false);
  ok(v.errors.length > 0);
});

t('校验：全透明给出警告但不判错', () => {
  const v = se.validate(se.blankImage(64, 64));
  eq(v.ok, true, '空白皮肤是合法的（用户就是要从零画）');
  ok(v.warnings.some((w) => /全透明/.test(w)), '应提示全透明，实际: ' + JSON.stringify(v.warnings));
});

t('校验：64×32 提示会自动补左臂左腿', () => {
  const v = se.validate(se.blankImage(64, 32));
  eq(v.legacy, true);
  ok(v.warnings.some((w) => /旧格式/.test(w)));
});

t('统计：计数覆盖 opaque / semi / transparent', () => {
  const img = se.blankImage(4, 4);
  se.setPixel(img, 0, 0, [1, 2, 3, 255]);
  se.setPixel(img, 1, 0, [1, 2, 3, 128]);
  const s = se.stats(img);
  eq(s.opaque, 1); eq(s.semi, 1); eq(s.transparent, 14);
  eq(s.colors, 1, '同 RGB 不同 alpha 只算一种颜色');
});

t('统计：第二层全空时 partial=0 empty=6', () => {
  const c = se.overlayCoverage(se.blankImage(64, 64));
  eq(c.empty, 6); eq(c.full, 0); eq(c.partial, 0);
});

/* ============================================================
 * 颜色与文件
 * ============================================================ */

t('颜色：hex → rgba', () => {
  deepEq(se.hexToRgba('#ff8000'), [255, 128, 0, 255]);
  deepEq(se.hexToRgba('#f80'), [255, 136, 0, 255], '三位缩写');
});

t('颜色：rgba → hex 小写补零', () => {
  eq(se.rgbaToHex([1, 2, 3, 255]), '#010203');
});

t('文件：saveSkin / loadSkin 往返', () => {
  const img = se.fromTemplate('warm');
  const f = path.join(TMP, 'a.png');
  const s = se.saveSkin(f, img);
  eq(s.ok, true);
  ok(s.bytes > 0);
  const l = se.loadSkin(f);
  eq(l.ok, true);
  eq(l.w, 64); eq(l.h, 64); eq(l.legacy, false);
  eq(Buffer.from(l.rgba).equals(Buffer.from(img.rgba)), true, '存读应逐字节一致');
});

t('文件：saveSkin 不留 .tmp 残渣', () => {
  const f = path.join(TMP, 'b.png');
  se.saveSkin(f, se.fromTemplate('blank'));
  eq(fs.existsSync(f + '.tmp'), false);
});

t('文件：64×32 的皮肤读进来会自动补齐', () => {
  const f = path.join(TMP, 'legacy.png');
  fs.writeFileSync(f, se.encodePng(se.blankImage(64, 32)));
  const l = se.loadSkin(f);
  eq(l.ok, true);
  eq(l.w, 64); eq(l.h, 64); eq(l.legacy, true);
});

t('文件：非 PNG 返回 ok:false 而不是抛错', () => {
  const f = path.join(TMP, 'bad.png');
  fs.writeFileSync(f, 'this is not a png');
  const l = se.loadSkin(f);
  eq(l.ok, false);
  ok(!!l.error);
});

t('文件：读不存在的路径返回 ok:false', () => {
  const l = se.loadSkin(path.join(TMP, 'nope.png'));
  eq(l.ok, false);
});

t('dataUrl：往返一致', () => {
  const img = se.fromTemplate('warm');
  const url = se.toDataUrl(img);
  ok(url.startsWith('data:image/png;base64,'));
  const back = se.fromDataUrl(url);
  eq(back.ok, true);
  eq(back.w, 64);
  eq(Buffer.from(back.rgba).equals(Buffer.from(img.rgba)), true);
});

t('dataUrl：非法输入返回 ok:false', () => {
  eq(se.fromDataUrl('garbage').ok, false);
  eq(se.fromDataUrl('').ok, false);
});

/* ============================================================
 * 收尾
 * ============================================================ */

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }

console.log('');
console.log(`skinedit：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
