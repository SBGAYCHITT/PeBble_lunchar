#!/usr/bin/env node
/**
 * 生成 Lite 版专用的 Electron 运行时目录（build/electron-lite）。
 *
 * 为什么不是「先复制全量、再删掉不要的」：
 *   本机沙箱对「单轮批量删除」有 50 项上限 —— 55 个语言包一次删不完，
 *   electron-builder 自带的 electronLanguages 就是这么失败在 packaging 阶段的
 *   （SAFE_DELETE_BULK_CONFIRM_REQUIRED，count 50 / threshold 50）。
 *   改成「只复制需要的」：用 cpSync 的 filter 在复制那一刻就跳过，
 *   全程不调用任何删除 API，也就不会撞上那条限制。
 *
 * 产出被 lite.config.js 当 electronDist 用。
 * 用法：node scripts/make-lite-dist.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'node_modules', 'electron', 'dist');
const DEST = path.join(ROOT, 'build', 'electron-lite');

/* 语言包白名单：zh-CN 是界面语言，en-US 是 Chromium 匹配不到时的兜底。
   这一项是 Lite 瘦身的主力 —— 55 个 .pak 未压缩合计约 39 MB。 */
const KEEP_LOCALES = new Set(['zh-CN.pak', 'en-US.pak']);

/* 用不到的运行时组件，每项都写清理由，免得下次谁也不敢动、或者反向乱加回来。 */
const DROP_FILES = new Map([
  ['vk_swiftshader.dll', 'SwiftShader：纯 CPU 的 Vulkan 后端，桌面 2D 界面用不到'],
  ['vk_swiftshader_icd.json', '上面那项的 ICD 注册清单'],
  ['libGLESv2.dll', 'ANGLE 的 GLES 实现；本应用没有 WebGL / 3D 场景'],
  ['libEGL.dll', 'ANGLE 的 EGL 入口，与上一项成对'],
  ['d3dcompiler_47.dll', 'HLSL 运行时编译器，只在 ANGLE 走 D3D 路径时才加载']
]);

/* 刻意保留 LICENSES.chromium.html：
   它只是许可证全文（未压缩约 9 MB，纯文本压完很小），删掉省不了多少，
   却会让「分发时未附带第三方许可证声明」变成实打实的合规问题。 */
const DROP_LICENSES = false;

function die(m) { console.error('✗ ' + m); process.exit(1); }

if (!fs.existsSync(SRC)) die('找不到 ' + SRC + '，先跑 npm install');

/* 目标目录已存在就用标记文件判断要不要重建（内容完全由本脚本决定）。
   标记文件刻意放在 DEST 之外 —— 放进 DEST 会被当成运行时文件一起打进安装包。 */
const STAMP = path.join(ROOT, 'build', '.lite-dist-stamp.json');
const stamp = { locales: [...KEEP_LOCALES].sort(), drop: [...DROP_FILES.keys()].sort(), dropLicenses: DROP_LICENSES };
if (fs.existsSync(STAMP)) {
  const old = JSON.parse(fs.readFileSync(STAMP, 'utf8'));
  if (JSON.stringify(old) === JSON.stringify(stamp)) {
    console.log('✓ 已是最新，跳过重建：' + path.relative(ROOT, DEST).replace(/\\/g, '/'));
    process.exit(0);
  }
}

let skippedLocale = 0, skippedFile = 0;
const t0 = Date.now();

fs.cpSync(SRC, DEST, {
  recursive: true,
  force: true,
  filter: (s) => {
    const rel = path.relative(SRC, s).replace(/\\/g, '/');
    if (!rel || rel === '.') return true;
    const base = path.basename(rel);

    // locales/ 下只放行白名单
    if (rel.startsWith('locales/')) {
      if (KEEP_LOCALES.has(base)) return true;
      skippedLocale++;
      return false;
    }
    if (DROP_FILES.has(base)) { skippedFile++; return false; }
    if (DROP_LICENSES && base === 'LICENSES.chromium.html') { skippedFile++; return false; }
    return true;
  }
});

fs.writeFileSync(STAMP, JSON.stringify(stamp, null, 2));

/* 校验：复制过来的东西必须齐活，少一个应用就起不来 */
const must = ['electron.exe', 'icudtl.dat', 'resources.pak', 'ffmpeg.dll', 'v8_context_snapshot.bin'];
const missing = must.filter((f) => !fs.existsSync(path.join(DEST, f)));
if (missing.length) die('精简后的运行时缺关键文件：' + missing.join(', '));

const locales = fs.readdirSync(path.join(DEST, 'locales'));
if (locales.length !== KEEP_LOCALES.size) die('语言包数量不对：' + locales.join(','));

console.log('✓ Lite 运行时已生成：' + path.relative(ROOT, DEST).replace(/\\/g, '/'));
console.log('  跳过语言包 : ' + skippedLocale + ' 个（保留 ' + locales.join('/') + '）');
console.log('  跳过组件   : ' + skippedFile + ' 个');
console.log('  耗时       : ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒');
