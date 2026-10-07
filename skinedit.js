// Pebble Lunchar - Minecraft 皮肤编辑器内核（生产模块，纯本地）
//
// 职责边界：本模块只在 Node 侧做「数据 + 数学 + 文件 IO」——
//   PNG 编解码、皮肤分区表、立方体模型几何、投影、模板库、像素编辑。
//   真正的绘制（canvas 2D 把贴图四边形贴上去）在渲染进程做，
//   这样核心逻辑能脱离 Electron 单测。
//
// 为什么自己写 PNG 解码：
//   皮肤是「用户从任何地方下载的 PNG」，改一个像素再存回去必须**逐字节可控**。
//   走 nativeImage / ImageBitmap 那条路会经过颜色管理和缩放转换，
//   存回去可能产生肉眼看不见的色偏，而且没法在 Node 单测里验。
//   自己解成 RGBA 数组最可控，也顺手能测「编码再解码 == 原图」。
//   只支持 bitDepth=8 的非隔行 PNG（皮肤的现实情况），其余**明确报错**而不是静默猜。
//
// ⚠️ 两个容易踩的点：
//   ① 皮肤有**旧格式 64×32**。别把它当错误拒绝 —— 那会把大量老皮肤挡在门外。
//      统一补齐成 64×64 再处理（左腿/左臂按旧格式的约定从右侧镜像出来）。
//   ② PNG 每行前面有**一个滤波类型字节**，它不属于像素数据。
//      行 stride = w*bpp + 1，忘了这个 +1 会让整张图斜切。

'use strict';

const fs = require('fs');
const zlib = require('zlib');

/* ============================================================
 * 一、PNG 编解码
 * ============================================================ */

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG 用的 CRC-32（与 ZIP 同多项式）。
 *  ⚠️ 末尾必须 `>>> 0` —— JS 位运算是 32 位有符号的，不加会得到负数。 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

/** @param {Buffer} buf @returns {number} */
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/** Paeth 预测器（PNG 滤波类型 4）
 *  @param {number} a @param {number} b @param {number} c @returns {number} */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** 每种 colorType 的通道数（bitDepth=8 时 = 字节数/像素） */
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * 解一张 PNG 成 RGBA 像素。
 *
 * 支持 bitDepth=8 的 colorType 0/2/3/4/6（灰/RGB/调色板/灰+α/RGBA），非隔行。
 * 皮肤的实际形态是 colorType 6，但用户可能拿别的工具存成 2 或 3，
 * 所以这几种都认；真遇到 16-bit 或 Adam7 隔行会**明确抛错**，不做有损猜测。
 *
 * @param {Buffer|Uint8Array} input
 * @returns {{w:number, h:number, rgba:Uint8Array}}
 */
function decodePng(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('不是 PNG（签名不符）');

  let off = 8;
  /** @type {any} */
  let ihdr = null;
  let palette = null;
  let trns = null;
  /** @type {Buffer[]} */
  const idat = [];

  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (data.length < len) throw new Error('PNG 截断：chunk ' + type + ' 长度越界');

    if (type === 'IHDR') {
      ihdr = {
        w: data.readUInt32BE(0),
        h: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12]
      };
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      trns = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len; // len(4) + type(4) + data + crc(4)
  }

  if (!ihdr) throw new Error('PNG 无 IHDR');
  if (ihdr.bitDepth !== 8) throw new Error('只支持 8-bit PNG（当前 ' + ihdr.bitDepth + '-bit）');
  if (ihdr.interlace !== 0) throw new Error('不支持隔行（Adam7）PNG');
  if (ihdr.colorType === 3 && !palette) throw new Error('调色板 PNG 缺 PLTE');
  const ch = CHANNELS[ihdr.colorType];
  if (!ch) throw new Error('不支持的 colorType ' + ihdr.colorType);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { w, h } = ihdr;
  const stride = w * ch;
  if (raw.length < (stride + 1) * h) throw new Error('PNG 像素数据不足（文件可能损坏）');

  // ---- 逐行反滤波 ----
  // ⚠️ 这里用 Buffer.alloc（非池化）并直接按索引读写，
  //    不用 subarray 视图 —— 视图在下面 a/b/c 的读取里少了边界判断，容易越界读脏数据。
  const px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const lineStart = y * (stride + 1) + 1;
    const outStart = y * stride;
    const upStart = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[outStart + x - ch] : 0;
      const b = y > 0 ? px[upStart + x] : 0;
      const c = (x >= ch && y > 0) ? px[upStart + x - ch] : 0;
      let v = raw[lineStart + x];
      switch (ft) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: v += paeth(a, b, c); break;
        default: throw new Error('未知 PNG 滤波类型 ' + ft + '（第 ' + y + ' 行）');
      }
      px[outStart + x] = v & 0xff;
    }
  }

  // ---- 统一转 RGBA ----
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0, n = w * h; i < n; i++) {
    let r = 0, g = 0, b = 0, a = 255;
    if (ihdr.colorType === 0) { r = g = b = px[i]; }
    else if (ihdr.colorType === 2) { r = px[i * 3]; g = px[i * 3 + 1]; b = px[i * 3 + 2]; }
    else if (ihdr.colorType === 3) {
      const idx = px[i];
      r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
      if (trns && idx < trns.length) a = trns[idx];
    } else if (ihdr.colorType === 4) { r = g = b = px[i * 2]; a = px[i * 2 + 1]; }
    else { r = px[i * 4]; g = px[i * 4 + 1]; b = px[i * 4 + 2]; a = px[i * 4 + 3]; }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }
  return { w, h, rgba: new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.length) };
}

/** 把 CRC 正确的 chunk 拼出来 */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * 把 RGBA 像素编码成 PNG（colorType 6 / bitDepth 8 / 非隔行 / 全用滤波 0）。
 *
 * 不做滤波择优：皮肤图小（64×64=16KB），滤波 0 出来的体积已经够小，
 * 而且**往返可逆**是这里最看重的性质 —— 择优滤波会让「编码→解码」这条单测
 * 多一层「滤波有没有写对」的干扰变量。
 *
 * @param {{w:number, h:number, rgba:Uint8Array|Buffer}} img
 * @returns {Buffer}
 */
function encodePng(img) {
  const { w, h } = img;
  const rgba = Buffer.from(img.rgba);
  if (rgba.length < w * h * 4) throw new Error('像素数据长度与尺寸不符');

  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // 滤波类型 0（None）
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bitDepth
  ihdr[9] = 6;   // colorType RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ============================================================
 * 二、皮肤分区表与模型
 * ============================================================ */

/** 现代格式尺寸 */
const SIZE_MODERN = { w: 64, h: 64 };
/** 旧格式尺寸（无独立左臂/左腿，也没有第二层） */
const SIZE_LEGACY = { w: 64, h: 32 };

/**
 * 六个部件在贴图上的展开原点 `u0,v0`，以及模型空间里的盒子尺寸与中心。
 *
 * 展开规则（以 body 为例，w=8 h=12 d=4 → 展开区 24×16）：
 *   top    = (u0+d,     v0,   w, d)
 *   bottom = (u0+d+w,   v0,   w, d)
 *   right  = (u0,       v0+d, d, h)
 *   front  = (u0+d,     v0+d, w, h)
 *   left   = (u0+d+w,   v0+d, d, h)
 *   back   = (u0+d+w+d, v0+d, w, h)
 * 这套公式对头(8,8,8)/臂(4,12,4)/腿(4,12,4)全部成立。
 *
 * 模型坐标：x 向右、y 向上、z 朝向观察者；原点在**脚底中心**。
 * 尺寸单位是「皮肤像素」（1 像素 = 1/16 方块）。
 * @type {Array<{id:string,zh:string,w:number,h:number,d:number,u0:number,v0:number,ox:number,oy:number,oz:number}>}
 */
const PARTS = [
  { id: 'head', zh: '头',   w: 8, h: 8,  d: 8, u0: 0,  v0: 0,  ox: 0,  oy: 28, oz: 0 },
  { id: 'body', zh: '身体', w: 8, h: 12, d: 4, u0: 16, v0: 16, ox: 0,  oy: 18, oz: 0 },
  { id: 'armR', zh: '右臂', w: 4, h: 12, d: 4, u0: 40, v0: 16, ox: -6, oy: 18, oz: 0 },
  { id: 'armL', zh: '左臂', w: 4, h: 12, d: 4, u0: 32, v0: 48, ox: 6,  oy: 18, oz: 0 },
  { id: 'legR', zh: '右腿', w: 4, h: 12, d: 4, u0: 0,  v0: 16, ox: -2, oy: 6,  oz: 0 },
  { id: 'legL', zh: '左腿', w: 4, h: 12, d: 4, u0: 16, v0: 48, ox: 2,  oy: 6,  oz: 0 }
];

/** 第二层（帽子 / 外套 / 袖 / 裤）。原点就是对应部件原点 + 32 的 v 偏移。
 *  `inflate` 让第二层比本体大一圈，避免同一个位置的两层三角形互相 z-fighting（闪烁）。
 *  @type {Array<{id:string,of:string,zh:string,u0:number,v0:number,inflate:number}>} */
const OVERLAY = [
  { id: 'hat',    of: 'head', zh: '帽子',   u0: 32, v0: 0,  inflate: 0.5 },
  { id: 'jacket', of: 'body', zh: '外套',   u0: 16, v0: 32, inflate: 0.25 },
  { id: 'sleeveR', of: 'armR', zh: '右袖',  u0: 40, v0: 32, inflate: 0.25 },
  { id: 'sleeveL', of: 'armL', zh: '左袖',  u0: 48, v0: 48, inflate: 0.25 },
  { id: 'pantsR', of: 'legR', zh: '右裤',   u0: 0,  v0: 32, inflate: 0.25 },
  { id: 'pantsL', of: 'legL', zh: '左裤',   u0: 0,  v0: 48, inflate: 0.25 }
];

/** 面的固定顺序 */
const FACE_ORDER = ['top', 'bottom', 'right', 'front', 'left', 'back'];
const FACE_ZH = { top: '顶', bottom: '底', right: '右', front: '前', left: '左', back: '后' };

/**
 * 拿某个盒子的 6 个面在贴图上的 uv 矩形。
 * @param {number} w @param {number} h @param {number} d
 * @param {number} u0 @param {number} v0
 * @returns {Record<string, {x:number,y:number,w:number,h:number}>}
 */
function uvOf(w, h, d, u0, v0) {
  return {
    top:    { x: u0 + d,         y: v0,     w, h: d },
    bottom: { x: u0 + d + w,     y: v0,     w, h: d },
    right:  { x: u0,             y: v0 + d, w: d, h },
    front:  { x: u0 + d,         y: v0 + d, w, h },
    left:   { x: u0 + d + w,     y: v0 + d, w: d, h },
    back:   { x: u0 + d + w + d, y: v0 + d, w, h }
  };
}

/** 取部件的 uv 表（对外暴露，UI 画 2D 展开图时要用） */
function partUv(part) {
  return uvOf(part.w, part.h, part.d, part.u0, part.v0);
}

/**
 * 一个盒子的 6 个面：每个面 4 个顶点（从**外侧**看去是逆时针）+ 对应 uv 四角。
 *
 * uv 四角与顶点的对应关系固定为「左下 → 右下 → 右上 → 左上」，
 * 这样贴图从外侧看是正的、不镜像。写错这个顺序，模型上会出现
 * 「脸贴在后脑勺」这种一眼看去很怪、但代码上一时找不到的错。
 *
 * @param {number} cx @param {number} cy @param {number} cz 中心
 * @param {number} w @param {number} h @param {number} d
 * @param {number} inflate 向外膨胀量（第二层用）
 * @returns {Array<{face:string, quad:Array<{x:number,y:number,z:number}>}>}
 */
function boxFaces(cx, cy, cz, w, h, d, inflate) {
  const g = inflate || 0;
  const x0 = cx - w / 2 - g, x1 = cx + w / 2 + g;
  const y0 = cy - h / 2 - g, y1 = cy + h / 2 + g;
  const z0 = cz - d / 2 - g, z1 = cz + d / 2 + g;
  const P = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ z) => ({ x, y, z });
  return [
    // +y 从上往下看：贴图 v 增大方向 = z 增大（向前）
    { face: 'top',    quad: [P(x0, y1, z1), P(x1, y1, z1), P(x1, y1, z0), P(x0, y1, z0)] },
    // -y 从下往上看
    { face: 'bottom', quad: [P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1)] },
    // +x 从右侧看：左侧 = z+（前）
    { face: 'right',  quad: [P(x1, y0, z1), P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1)] },
    // -x 从左侧看：左侧 = z-（后）
    { face: 'left',   quad: [P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0)] },
    // +z 正对观察者
    { face: 'front',  quad: [P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)] },
    // -z 背面：从后往前看，左右反过来
    { face: 'back',   quad: [P(x1, y0, z0), P(x0, y0, z0), P(x0, y1, z0), P(x1, y1, z0)] }
  ];
}

/**
 * 装配整个模型的三角面（含可选的第二层）。
 *
 * 返回的是**扁平的面列表**，每项自带 uv 矩形与深度排序所需的顶点。
 * 渲染侧只需：投影 → 按深度排序 → 逐面贴图。
 *
 * @param {{overlay?:boolean, parts?:string[], scale?:number}} [opts]
 *   `overlay` 缺省为 **true** —— 渲染时帽子/外套/袖/裤要跟本体一起画，
 *   想让用户单独看本体（比如「只看本体」开关）再传 false。
 * @returns {Array<{part:string, partZh:string, face:string, layer:number,
 *                  quad:Array<{x:number,y:number,z:number}>,
 *                  uv:{x:number,y:number,w:number,h:number}}>}
 */
function buildMesh(opts) {
  const o = opts || {};
  const only = o.parts && o.parts.length ? new Set(o.parts) : null;
  /** @type {any[]} */
  const out = [];

  for (const p of PARTS) {
    if (only && !only.has(p.id)) continue;
    const uv = partUv(p);
    for (const f of boxFaces(p.ox, p.oy, p.oz, p.w, p.h, p.d, 0)) {
      out.push({ part: p.id, partZh: p.zh, face: f.face, layer: 0, quad: f.quad, uv: uv[f.face] });
    }
  }

  if (o.overlay !== false) {
    for (const ov of OVERLAY) {
      if (only && !only.has(ov.of)) continue;
      const base = PARTS.find((p) => p.id === ov.of);
      if (!base) continue;
      const uv = uvOf(base.w, base.h, base.d, ov.u0, ov.v0);
      for (const f of boxFaces(base.ox, base.oy, base.oz, base.w, base.h, base.d, ov.inflate)) {
        out.push({
          part: ov.id, partZh: ov.zh, face: f.face, layer: 1, quad: f.quad, uv: uv[f.face]
        });
      }
    }
  }
  return out;
}

/* ============================================================
 * 三、投影（纯数学，渲染侧直接用）
 * ============================================================ */

/**
 * 投影：先绕 y 轴转（左右转头），再绕 x 轴转（抬头低头），然后压到屏幕。
 *
 * **正交（默认）而不是透视**，这是刻意的：
 *   canvas 2D 没有「四边形贴图」，一个面只能用两个三角形 + 各自解一个仿射矩阵来画。
 *   透视下四边形的投影是梯形，两个三角形的仿射逼近在共用对角线上对不齐 ——
 *   皮肤上会出现一条淡淡的斜线（尤其是有渐变/花纹的地方一眼可见）。
 *   正交下四边形的投影是**平行四边形**，仿射映射就是精确解，拼缝彻底消失。
 *   Blockbench 的皮肤预览默认也是正交，观感一致。
 * 需要近大远小（比如给别处做透视演示）时传 `cam.persp = true`，代价就是上述拼缝。
 *
 * @param {{x:number,y:number,z:number}} p
 * @param {{rotX?:number, rotY?:number, scale?:number, cx?:number, cy?:number, camZ?:number, persp?:boolean}} cam
 * @returns {{x:number, y:number, depth:number, k:number}|null} 相机背后的点返回 null
 */
function project(p, cam) {
  const c = cam || {};
  const rotX = c.rotX || 0, rotY = c.rotY || 0;
  const scale = c.scale || 10, cx = c.cx || 0, cy = c.cy || 0;
  const camZ = c.camZ || 64;

  // 绕 y 轴（左右转头）→ 再绕 x 轴（抬头低头）
  const cy1 = Math.cos(rotY), sy1 = Math.sin(rotY);
  const x1 = p.x * cy1 + p.z * sy1;
  const z1 = -p.x * sy1 + p.z * cy1;
  const cx1 = Math.cos(rotX), sx1 = Math.sin(rotX);
  const y2 = p.y * cx1 - z1 * sx1;
  const z2 = p.y * sx1 + z1 * cx1;

  // 模型 y 向上、屏幕 y 向下 —— cy 那里要减
  const depth = camZ - z2;   // 只用于排序与「跑到相机背后」的剔除
  if (depth <= 1) return null; // 贴到相机上或跑到背后，丢弃
  const k = c.persp ? scale * (camZ / depth) : scale; // 正交时与深度无关
  return { x: cx + x1 * k, y: cy - y2 * k, depth, k };
}

/**
 * 画家算法排序：远的先画。
 * 用面 4 个顶点的**平均深度**（比最近顶点更稳，避免大面被小面穿插时错序）。
 * @param {Array<{depth:number}>} faces @returns {Array<any>}
 */
function sortByDepth(faces) {
  return faces.slice().sort((a, b) => b.depth - a.depth);
}

/**
 * 一次把 mesh 投完并排好序，渲染侧直接用。
 * @param {ReturnType<typeof buildMesh>} mesh
 * @param {{rotX?:number, rotY?:number, scale?:number, cx?:number, cy?:number, camZ?:number}} cam
 * @returns {Array<{part:string, face:string, layer:number, uv:any, pts:Array<{x:number,y:number}>, depth:number}>}
 */
function renderMesh(mesh, cam) {
  /** @type {any[]} */
  const out = [];
  for (const f of mesh) {
    /** @type {Array<{x:number,y:number}>} */
    const pts = [];
    let sum = 0, ok = true;
    for (const v of f.quad) {
      const s = project(v, cam);
      if (!s) { ok = false; break; }
      pts.push({ x: s.x, y: s.y });
      sum += s.depth;
    }
    if (!ok) continue;
    out.push({
      part: f.part, face: f.face, layer: f.layer, uv: f.uv,
      pts, depth: sum / f.quad.length
    });
  }
  return sortByDepth(out);
}

/* ============================================================
 * 四、图像工具与模板
 * ============================================================ */

/** 造一张空图
 *  @param {number} w @param {number} h @param {number[]} [rgba]
 *  @returns {{w:number,h:number,rgba:Uint8Array}} */
function blankImage(w, h, rgba) {
  const px = new Uint8Array(w * h * 4);
  if (rgba) for (let i = 0; i < w * h; i++) {
    px[i * 4] = rgba[0]; px[i * 4 + 1] = rgba[1];
    px[i * 4 + 2] = rgba[2]; px[i * 4 + 3] = rgba[3] === undefined ? 255 : rgba[3];
  }
  return { w, h, rgba: px };
}

/** @param {{w:number,h:number,rgba:Uint8Array}} img @param {number} x @param {number} y
 *  @returns {number[]} [r,g,b,a]，越界返回 [0,0,0,0] */
function getPixel(img, x, y) {
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return [0, 0, 0, 0];
  const i = (y * img.w + x) * 4;
  return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2], img.rgba[i + 3]];
}

/** 写一个像素（就地修改）
 *  @param {{w:number,h:number,rgba:Uint8Array}} img @param {number} x @param {number} y
 *  @param {number[]} rgba @returns {boolean} 是否真的写了（越界 = false） */
function setPixel(img, x, y, rgba) {
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return false;
  const i = (y * img.w + x) * 4;
  img.rgba[i] = rgba[0]; img.rgba[i + 1] = rgba[1];
  img.rgba[i + 2] = rgba[2];
  img.rgba[i + 3] = rgba[3] === undefined ? 255 : rgba[3];
  return true;
}

/** 填一个矩形（就地）
 *  @param {{w:number,h:number,rgba:Uint8Array}} img
 *  @param {{x:number,y:number,w:number,h:number}} rect @param {number[]} rgba */
function fillRect(img, rect, rgba) {
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) setPixel(img, x, y, rgba);
  }
}

/**
 * 油漆桶：从 (x,y) 起把**四邻域内同色**的连通块换成目标色。
 * 用显式栈而不是递归 —— 64×64 起来递归深度能到 4096，虽然 Node 栈够，
 * 但栈式写法在大图上更稳，也不受 V8 栈限制影响。
 * @param {{w:number,h:number,rgba:Uint8Array}} img
 * @param {number} x @param {number} y @param {number[]} rgba
 * @returns {number} 改了多少像素
 */
function floodFill(img, x, y, rgba) {
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return 0;
  const target = getPixel(img, x, y);
  if (target[0] === rgba[0] && target[1] === rgba[1] &&
      target[2] === rgba[2] && target[3] === (rgba[3] === undefined ? 255 : rgba[3])) {
    return 0; // 同色，直接返回（否则会死循环）
  }
  const key = (/** @type {number} */ px, /** @type {number} */ py) => py * img.w + px;
  const seen = new Uint8Array(img.w * img.h);
  /** @type {number[]} */
  const stack = [x, y];
  let n = 0;
  while (stack.length) {
    const py = /** @type {number} */ (stack.pop());
    const px = /** @type {number} */ (stack.pop());
    if (px < 0 || py < 0 || px >= img.w || py >= img.h) continue;
    const k = key(px, py);
    if (seen[k]) continue;
    const c = getPixel(img, px, py);
    if (c[0] !== target[0] || c[1] !== target[1] || c[2] !== target[2] || c[3] !== target[3]) continue;
    seen[k] = 1;
    setPixel(img, px, py, rgba);
    n++;
    stack.push(px + 1, py, px - 1, py, px, py + 1, px, py - 1);
  }
  return n;
}

/** 把一块矩形区域做水平翻转（就地）
 *  @param {{w:number,h:number,rgba:Uint8Array}} img
 *  @param {{x:number,y:number,w:number,h:number}} r */
function flipRectH(img, r) {
  const half = Math.floor(r.w / 2);
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let dx = 0; dx < half; dx++) {
      const xa = r.x + dx, xb = r.x + r.w - 1 - dx;
      const a = getPixel(img, xa, y), b = getPixel(img, xb, y);
      setPixel(img, xa, y, b);
      setPixel(img, xb, y, a);
    }
  }
}

/**
 * 左右镜像整个皮肤。
 *
 * 不是「把矩形翻转」那么粗暴 —— 那样会出现「脸跑到后脑勺」。
 * 正确的镜像要连**面的归属**一起换：
 *   源部件的 right 面 → 目标部件的 left 面（其余面水平翻转后原位）
 * 并且 armR↔armL、legR↔legL 互换。头部与身体只做面级翻转。
 *
 * @param {{w:number,h:number,rgba:Uint8Array}} img @returns {{ok:boolean, swap:number}}
 */
function mirrorLR(img) {
  if (img.w !== 64 || img.h !== 64) return { ok: false, swap: 0 };
  const src = { w: img.w, h: img.h, rgba: new Uint8Array(img.rgba) };
  // ⚠️ 左右部件必须**成对双向**处理：只写 [from→to] 单向的话，
  //    目标拿到了源的像素，源自己却没被更新 —— 结果是「两条一样的胳膊」。
  //    这里读的一律是 `src` 快照，所以双向处理不会互相污染。
  const pairs = [
    ['armR', 'armL'], ['armL', 'armR'],
    ['legR', 'legL'], ['legL', 'legR'],
    ['head', 'head'], ['body', 'body']
  ];
  const uvMap = new Map(PARTS.map((p) => [p.id, partUv(p)]));
  let swap = 0;

  for (const [from, to] of pairs) {
    const fuv = uvMap.get(from), tuv = uvMap.get(to);
    if (!fuv || !tuv) continue;
    for (const face of FACE_ORDER) {
      // 镜像后：源 right ↔ 目标 left
      const mirrorFace = face === 'right' ? 'left' : face === 'left' ? 'right' : face;
      const s = fuv[face], t = tuv[mirrorFace];
      if (s.w !== t.w || s.h !== t.h) continue;
      // 先原样搬过去，再在目标位置水平翻转（左右面互换时不需要翻，其余要翻）
      for (let y = 0; y < s.h; y++) {
        for (let x = 0; x < s.w; x++) {
          const px = face === 'right' || face === 'left' ? x : s.w - 1 - x;
          setPixel(img, t.x + x, t.y + y, getPixel(src, s.x + px, s.y + y));
        }
      }
      swap++;
    }
  }
  // 第二层跟着一起镜像（有就做，没有就跳过 —— 旧皮肤本来就没第二层）
  const ovMap = new Map(OVERLAY.map((o) => [o.id, uvOf(
    (PARTS.find((p) => p.id === o.of) || PARTS[0]).w,
    (PARTS.find((p) => p.id === o.of) || PARTS[0]).h,
    (PARTS.find((p) => p.id === o.of) || PARTS[0]).d,
    o.u0, o.v0
  )]));
  for (const [from, to] of [
    ['sleeveR', 'sleeveL'], ['sleeveL', 'sleeveR'],
    ['pantsR', 'pantsL'], ['pantsL', 'pantsR'],
    ['hat', 'hat'], ['jacket', 'jacket']
  ]) {
    const fuv = ovMap.get(from), tuv = ovMap.get(to);
    if (!fuv || !tuv) continue;
    for (const face of FACE_ORDER) {
      const mirrorFace = face === 'right' ? 'left' : face === 'left' ? 'right' : face;
      const s = fuv[face], t = tuv[mirrorFace];
      if (s.w !== t.w || s.h !== t.h) continue;
      for (let y = 0; y < s.h; y++) {
        for (let x = 0; x < s.w; x++) {
          const px = face === 'right' || face === 'left' ? x : s.w - 1 - x;
          setPixel(img, t.x + x, t.y + y, getPixel(src, s.x + px, s.y + y));
        }
      }
    }
  }
  return { ok: true, swap };
}

/** UI 用的预设调色板（自绘，不含任何第三方素材） */
const PALETTE = [
  '#000000', '#1d1d21', '#3c3c46', '#6b6b78', '#a5a5b0', '#d8d8e0', '#ffffff', '#f5e6d3',
  '#e8b48a', '#c98a5c', '#8a5a3b', '#5a3a26', '#ffe0a3', '#ffc93c', '#f59e0b', '#b45309',
  '#ef4444', '#b91c1c', '#f97316', '#84cc16', '#22c55e', '#15803d', '#0ea5e9', '#2563eb',
  '#6366f1', '#8b5cf6', '#a855f7', '#ec4899', '#14b8a6', '#0891b2', '#78716c', '#292524'
];

/** @param {string} hex @returns {number[]} */
function hexToRgba(hex) {
  const s = String(hex || '').replace('#', '');
  const v = parseInt(s.length === 3 ? s.split('').map((c) => c + c).join('') : s, 16);
  if (!Number.isFinite(v)) return [0, 0, 0, 255];
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff, 255];
}

/** @param {number[]} c @returns {string} */
function rgbaToHex(c) {
  const h = (/** @type {number} */ n) => (n < 16 ? '0' : '') + n.toString(16);
  return '#' + h(c[0]) + h(c[1]) + h(c[2]);
}

/** 模板：空白 */
function tplBlank() { return blankImage(64, 64); }

/** 模板：分区导览 —— 每个部件一块颜色、每个面加深描边。
 *  新手最容易搞不清「2D 贴图的哪一块对应 3D 的哪个部位」，这张图就是为它准备的。 */
function tplGuide() {
  const img = blankImage(64, 64);
  const colors = ['#f59e0b', '#22c55e', '#3b82f6', '#ec4899', '#8b5cf6', '#14b8a6'];
  PARTS.forEach((p, i) => {
    const uv = partUv(p);
    const base = hexToRgba(colors[i % colors.length]);
    const dark = [Math.round(base[0] * 0.55), Math.round(base[1] * 0.55), Math.round(base[2] * 0.55), 255];
    for (const face of FACE_ORDER) {
      const r = uv[face];
      fillRect(img, r, base);
      // 面边框：1px，方便数格
      for (let x = 0; x < r.w; x++) {
        setPixel(img, r.x + x, r.y, dark);
        setPixel(img, r.x + x, r.y + r.h - 1, dark);
      }
      for (let y = 0; y < r.h; y++) {
        setPixel(img, r.x, r.y + y, dark);
        setPixel(img, r.x + r.w - 1, r.y + y, dark);
      }
    }
  });
  return img;
}

/** 模板：暖色人形 —— 自绘配色（**不使用任何官方皮肤素材**）。
 *  躯干/四肢按「上亮下暗」给一点纵向渐变，3D 预览里就有体积感。 */
function tplWarm() {
  const img = blankImage(64, 64);
  /** @type {[number,number,number]} */
  const skin = [232, 180, 138];
  /** @type {[number,number,number]} */
  const shirt = [58, 122, 200];
  /** @type {[number,number,number]} */
  const pants = [70, 78, 96];
  /** @type {[number,number,number]} */
  const hair = [72, 48, 32];
  const fill = (/** @type {any} */ part, /** @type {number[]} */ c, /** @type {number} */ shade) => {
    const uv = partUv(part);
    for (const face of FACE_ORDER) {
      const r = uv[face];
      for (let y = 0; y < r.h; y++) {
        const t = 1 - (y / Math.max(1, r.h - 1)) * (shade || 0);
        const col = [
          Math.max(0, Math.min(255, Math.round(c[0] * t))),
          Math.max(0, Math.min(255, Math.round(c[1] * t))),
          Math.max(0, Math.min(255, Math.round(c[2] * t))),
          255
        ];
        for (let x = 0; x < r.w; x++) setPixel(img, r.x + x, r.y + y, col);
      }
    }
    return uv;
  };
  const byId = (/** @type {string} */ id) => /** @type {any} */ (PARTS.find((p) => p.id === id));
  const headUv = fill(byId('head'), skin, 0.18);
  const bodyUv = fill(byId('body'), shirt, 0.22);
  fill(byId('armR'), skin, 0.2);
  fill(byId('armL'), skin, 0.2);
  fill(byId('legR'), pants, 0.2);
  fill(byId('legL'), pants, 0.2);
  // 头发：头顶 + 头部的上半圈
  for (const face of ['top', 'back', 'left', 'right']) fillRect(img, headUv[face], [...hair, 255]);
  const f = headUv.front;
  fillRect(img, { x: f.x, y: f.y, w: f.w, h: Math.max(1, Math.round(f.h * 0.35)) }, [...hair, 255]);
  // 两只眼睛（正面的 8×8 里，第 2 行第 2/5 列）
  setPixel(img, f.x + 1, f.y + 4, [40, 32, 28, 255]);
  setPixel(img, f.x + 2, f.y + 4, [40, 32, 28, 255]);
  setPixel(img, f.x + 5, f.y + 4, [40, 32, 28, 255]);
  setPixel(img, f.x + 6, f.y + 4, [40, 32, 28, 255]);
  // 衣领：身体顶面用深一点的颜色
  fillRect(img, bodyUv.top, [46, 98, 168, 255]);
  return img;
}

/** 模板：像素网格 —— 透明底 + 每 8px 一条浅灰线，便于手工对齐 */
function tplGrid() {
  const img = blankImage(64, 64);
  const line = [255, 255, 255, 90];
  for (let i = 0; i < 64; i += 8) {
    for (let x = 0; x < 64; x++) {
      setPixel(img, x, i, line);
      setPixel(img, i, x, line);
    }
  }
  return img;
}

/** @type {Array<{id:string, zh:string, en:string, make:() => any}>} */
const TEMPLATES = [
  { id: 'blank', zh: '空白', en: 'Blank', make: tplBlank },
  { id: 'guide', zh: '分区导览', en: 'Region guide', make: tplGuide },
  { id: 'warm',  zh: '暖色人形', en: 'Warm avatar', make: tplWarm },
  { id: 'grid',  zh: '像素网格', en: 'Pixel grid', make: tplGrid }
];

/**
 * 按 id 造模板图。
 * @param {string} id @returns {{w:number,h:number,rgba:Uint8Array}}
 */
function fromTemplate(id) {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error('未知模板 ' + id);
  return t.make();
}

/* ============================================================
 * 五、旧格式归一化与校验
 * ============================================================ */

/**
 * 把 64×32 的旧皮肤补齐成 64×64。
 *
 * 旧格式里**左臂和左腿与右侧共用**同一块贴图，所以现代格式里那两个区域是空的。
 * 直接复制右臂/右腿的像素过去**不对** —— 会得到两条同向的腿。
 * 官方客户端是按「镜像」用的，所以这里也镜像着填：
 * 左腿 ← 右腿水平翻转，左臂 ← 右臂水平翻转。
 *
 * @param {{w:number,h:number,rgba:Uint8Array}} img @returns {{w:number,h:number,rgba:Uint8Array,legacy:boolean}}
 */
function normalizeSkin(img) {
  if (img.w === 64 && img.h === 64) return { ...img, legacy: false };
  if (img.w !== 64 || img.h !== 32) {
    throw new Error('皮肤尺寸必须是 64×64 或 64×32（当前 ' + img.w + '×' + img.h + '）');
  }
  const out = blankImage(64, 64);
  // 上半部分原样搬
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 64; x++) setPixel(out, x, y, getPixel(img, x, y));
  }
  /** @type {Array<[string,string]>} */
  const legacyPairs = [['legR', 'legL'], ['armR', 'armL']];
  for (const [from, to] of legacyPairs) {
    const fp = PARTS.find((p) => p.id === from);
    const tp = PARTS.find((p) => p.id === to);
    if (!fp || !tp) continue;
    const fuv = partUv(fp), tuv = partUv(tp);
    for (const face of FACE_ORDER) {
      const s = fuv[face], t = tuv[face];
      for (let y = 0; y < s.h; y++) {
        for (let x = 0; x < s.w; x++) {
          setPixel(out, t.x + x, t.y + y, getPixel(img, s.x + s.w - 1 - x, s.y + y));
        }
      }
    }
  }
  return { w: 64, h: 64, rgba: out.rgba, legacy: true };
}

/**
 * 校验一张皮肤是否可用。
 * @param {{w:number,h:number,rgba:Uint8Array}} img
 * @returns {{ok:boolean, w:number, h:number, legacy:boolean, errors:string[], warnings:string[], stats:any}}
 */
function validate(img) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  const legacy = img.h === 32;
  if (img.w !== 64 || (img.h !== 64 && img.h !== 32)) {
    errors.push('尺寸 ' + img.w + '×' + img.h + ' 不是 64×64 或 64×32');
  } else {
    if (legacy) warnings.push('旧格式 64×32：左臂/左腿将由右侧镜像补齐');
    const s = stats(img);
    if (s.opaque === 0) warnings.push('整张皮肤全透明');
    else if (s.opaque < 64) warnings.push('几乎全透明（仅 ' + s.opaque + ' 个不透明像素）');
    if (!legacy) {
      // 第二层未使用时是全透明的，这不是问题；但第二层只画了一半就可能是画漏了
      const ov = overlayCoverage(img);
      if (ov.partial > 0) {
        warnings.push(ov.partial + ' 个第二层区域只画了一部分（可能忘了补全）');
      }
    }
  }
  return {
    ok: errors.length === 0, w: img.w, h: img.h, legacy,
    errors, warnings, stats: stats(img)
  };
}

/** 非透明像素数 / 用到的颜色数
 *  @param {{w:number,h:number,rgba:Uint8Array}} img */
function stats(img) {
  const colors = new Set();
  let opaque = 0, semi = 0;
  for (let i = 0, n = img.w * img.h; i < n; i++) {
    const a = img.rgba[i * 4 + 3];
    if (a === 0) continue;
    if (a < 255) semi++;
    else opaque++;
    colors.add((img.rgba[i * 4] << 16) | (img.rgba[i * 4 + 1] << 8) | img.rgba[i * 4 + 2]);
  }
  return { opaque, semi, transparent: img.w * img.h - opaque - semi, colors: colors.size };
}

/** 第二层各区域「全空 / 全满 / 画了一半」的统计 */
function overlayCoverage(img) {
  let empty = 0, full = 0, partial = 0;
  for (const ov of OVERLAY) {
    const base = PARTS.find((p) => p.id === ov.of);
    if (!base) continue;
    const uv = uvOf(base.w, base.h, base.d, ov.u0, ov.v0);
    let tot = 0, on = 0;
    for (const face of FACE_ORDER) {
      const r = uv[face];
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          tot++;
          if (getPixel(img, x, y)[3] > 0) on++;
        }
      }
    }
    if (on === 0) empty++;
    else if (on === tot) full++;
    else partial++;
  }
  return { empty, full, partial };
}

/* ============================================================
 * 六、文件读写
 * ============================================================ */

/**
 * 读一张皮肤文件（允许 64×32，会自动补齐）。
 * @param {string} file @returns {{ok:boolean, file?:string, w?:number, h?:number,
 *   rgba?:Uint8Array, legacy?:boolean, error?:string}}
 */
function loadSkin(file) {
  try {
    const buf = fs.readFileSync(file);
    const dec = decodePng(buf);
    const img = normalizeSkin(dec);
    return {
      ok: true, file, w: img.w, h: img.h,
      rgba: img.rgba, legacy: !!img.legacy
    };
  } catch (e) {
    return { ok: false, error: (e && /** @type {any} */ (e).message) || String(e) };
  }
}

/**
 * 存一张皮肤（写 PNG）。原子写：先写 `.tmp` 再 rename，
 * 避免用户存到一半被中断时把原文件也毁掉。
 * @param {string} file @param {{w:number,h:number,rgba:Uint8Array}} img
 * @returns {{ok:boolean, file?:string, bytes?:number, error?:string}}
 */
function saveSkin(file, img) {
  try {
    const png = encodePng(img);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, png);
    fs.renameSync(tmp, file);
    return { ok: true, file, bytes: png.length };
  } catch (e) {
    return { ok: false, error: (e && /** @type {any} */ (e).message) || String(e) };
  }
}

/**
 * 把图打包成 data URL（给渲染进程 <img> / canvas 用）。
 * 走 base64 而不是原生 Buffer —— IPC 传 Buffer 会变 Uint8Array，
 * 在渲染进程再转 base64 反而绕，直接在这里转好最省事（16KB 的图无所谓开销）。
 * @param {{w:number,h:number,rgba:Uint8Array}} img @returns {string}
 */
function toDataUrl(img) {
  return 'data:image/png;base64,' + encodePng(img).toString('base64');
}

/**
 * 从 data URL 解回图（渲染进程编辑完回传保存时用）。
 * @param {string} url @returns {{ok:boolean, w?:number, h?:number, rgba?:Uint8Array, error?:string}}
 */
function fromDataUrl(url) {
  try {
    const s = String(url || '');
    const i = s.indexOf(',');
    if (i < 0 || s.indexOf('base64') < 0) throw new Error('不是 base64 data URL');
    const dec = decodePng(Buffer.from(s.slice(i + 1), 'base64'));
    return { ok: true, w: dec.w, h: dec.h, rgba: dec.rgba };
  } catch (e) {
    return { ok: false, error: (e && /** @type {any} */ (e).message) || String(e) };
  }
}

module.exports = {
  // PNG
  decodePng, encodePng, crc32,
  // 布局与几何
  SIZE_MODERN, SIZE_LEGACY, PARTS, OVERLAY, FACE_ORDER, FACE_ZH,
  uvOf, partUv, boxFaces, buildMesh,
  // 投影
  project, sortByDepth, renderMesh,
  // 图像与编辑
  blankImage, getPixel, setPixel, fillRect, floodFill, flipRectH, mirrorLR,
  hexToRgba, rgbaToHex, PALETTE,
  // 模板
  TEMPLATES, fromTemplate,
  // 校验与统计
  normalizeSkin, validate, stats, overlayCoverage,
  // 文件
  loadSkin, saveSkin, toDataUrl, fromDataUrl
};
