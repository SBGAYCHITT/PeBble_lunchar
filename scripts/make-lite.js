#!/usr/bin/env node
/**
 * 生成 Lite 版前端入口。
 *
 * 为什么是「生成」而不是「维护第二份 index.html」：
 *   Lite 与完整版的差异只有「哪几个页面存在」，其余结构、样式、脚本完全一致。
 *   手抄一份会造成两处长期漂移 —— 完整版改了启动页，Lite 忘了同步，就出线上事故。
 *   所以这里从唯一真源 index.html 裁出 Lite 版，任何结构改动只要动一个地方。
 *
 * 产出：index.lite.html（项目根，与 style.css / pages.js 同层 —— 这样 HTML 里的相对引用
 *       不用做任何改写；main.js 检测到它存在就优先加载，标准版包里没有这个文件）。
 *
 * 为什么不产出到 build/lite/ 再用 electron-builder 的 {from,to} 映射改名：
 *   实测该映射对「单文件」不生效（目录映射才行），打出来的包里根本没有 index.html，
 *   应用启动后是 ERR_FILE_NOT_FOUND 白屏。同层生成最省事也最不容易出错。
 *
 * 用法：node scripts/make-lite.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'index.html');
const OUT = path.join(ROOT, 'index.lite.html');

/* Lite 版保留的页面。其余 nav 项与 <section> 全部裁掉。
   启动器的「必须有」：选版本启动 / 装版本 / 登账户 / 改设置 / 看关于。 */
const KEEP = ['launch', 'versions', 'account', 'settings', 'about'];

/* index.html 里 page-<id> 的总数。**加页面时必须同步改这里** ——
   下面的断言就是靠它发现「页面被改了但裁剪逻辑没跟上」，改漏了会当场 die 而不是
   静默裁错（这正是当初写成硬编码数字的原因）。 */
const PAGE_COUNT = 17;

/* 启动页里的「当前实例」卡片：属于实例系统，Lite 无实例页，一并去掉 */
const INST_CARD = `            <div class="card inst-pick">
              <div class="card-head"><span>当前实例</span><button id="btn-inst-manage" class="ghost-btn">管理</button></div>
              <select id="inst-select" class="sel wide"><option value="">加载中…</option></select>
              <div class="inst-hint" id="inst-hint"></div>
            </div>
`;

/* 关于页里的功能清单：Lite 版得如实说明自己砍了什么，不能照抄完整版 */
const ABOUT_OLD = `            <p class="tip">功能覆盖：离线/外置/微软账户、版本下载、Forge/Fabric/Quilt/NeoForge/OptiFine 自动安装、
              Mod/资源包/光影管理、存档与截图管理、崩溃日志查看、版本隔离与导入导出、世界版本控制与区域搬运、跨存档检索、云账号与云存档。<br />
              按需求不包含联机相关功能（局域网/P2P 联机）。</p>`;
const ABOUT_NEW = `            <p class="tip"><b>Lite 精简版</b>：只保留启动器最核心的部分 —— 账户登录、版本下载、
              加载器安装、启动与日志。<br />
              不含 Mod/资源包/光影/存档/截图管理、实例与迁移、世界工具、性能诊断、Mod 工具、云端账号与云存档。<br />
              需要完整功能请用标准版。</p>`;

function die(msg) { console.error('✗ ' + msg); process.exit(1); }

let html = fs.readFileSync(SRC, 'utf8');
const before = html.length;

/* ---------- 1. 裁 section ---------- */
let cutSections = 0;
html = html.replace(/[ \t]*<section class="page[^"]*" id="page-([a-z0-9-]+)">[\s\S]*?<\/section>\n?/g,
  (m, id) => {
    if (KEEP.includes(id)) return m;
    cutSections++;
    return '';
  });
if (cutSections !== PAGE_COUNT - KEEP.length) {
  die(`预期裁掉 ${PAGE_COUNT - KEEP.length} 个 section，实际 ${cutSections} —— 页面结构可能变了，请核对 index.html（新加页面记得同步 PAGE_COUNT）`);
}

/* ---------- 2. 裁 nav 项 ---------- */
let cutNav = 0;
html = html.replace(/[ \t]*<button class="nav-item[^"]*" data-page="([a-z0-9-]+)">[\s\S]*?<\/button>\n?/g,
  (m, id) => {
    if (KEEP.includes(id)) return m;
    cutNav++;
    return '';
  });
if (cutNav !== PAGE_COUNT - KEEP.length) {
  die(`预期裁掉 ${PAGE_COUNT - KEEP.length} 个 nav 项，实际 ${cutNav}（新加页面记得同步 PAGE_COUNT）`);
}

/* ---------- 3. 启动页去掉「当前实例」卡片 ---------- */
if (!html.includes(INST_CARD)) die('启动页的实例卡片没匹配上（index.html 改动过？）');
html = html.replace(INST_CARD, '');

/* ---------- 4. 账户页去掉「并行多开」+「实例账户绑定」两组 ---------- */
const multiIdx = html.indexOf('<div class="set-title">并行多开');
if (multiIdx < 0) die('账户页的「并行多开」分组没匹配上');
const grpStart = html.lastIndexOf('<div class="set-group">', multiIdx);
const accEnd = html.indexOf('</div></section>', multiIdx);
if (grpStart < 0 || accEnd < 0) die('账户页边界定位失败');
html = html.slice(0, grpStart) + html.slice(accEnd);

/* ---------- 5. 关于页文案改成 Lite 版 ---------- */
if (!html.includes(ABOUT_OLD)) die('关于页的功能清单没匹配上');
html = html.replace(ABOUT_OLD, ABOUT_NEW);
html = html.replace('<p class="sub">Minecraft 离线启动器</p>',
  '<p class="sub">Minecraft 离线启动器 · Lite 精简版</p>');

/* ---------- 6. 标题栏加 LITE 徽标 + 窗口标题 ---------- */
html = html.replace('<span class="logo-badge" id="nav-title">启动</span>',
  '<span class="logo-badge" id="nav-title">启动</span>\n        <span class="logo-badge lite">LITE</span>');
html = html.replace('<title>Pebble Lunchar</title>', '<title>Pebble Lunchar Lite</title>');

/* ---------- 校验：剩下的页面必须正好是白名单 ---------- */
const leftNav = [...html.matchAll(/data-page="([a-z0-9-]+)"/g)].map((m) => m[1]);
const leftSec = [...html.matchAll(/<section class="page[^"]*" id="page-([a-z0-9-]+)">/g)].map((m) => m[1]);
if (leftNav.join(',') !== KEEP.join(',')) die('剩余 nav 项不是白名单：' + leftNav.join(','));
if (leftSec.join(',') !== KEEP.join(',')) die('剩余 section 不是白名单：' + leftSec.join(','));
for (const id of KEEP) {
  if (html.includes(`page-${id}`) !== true) die(`缺页面 page-${id}`);
}
// 被裁页面的痕迹不该残留（防止只删了壳、留下按钮）
for (const gone of ['inst-select', 'btn-inst-manage', 'ml-list', 'ab-bind', 'saves-list', 'shots-list', 'cloud-user', 'cloud-key']) {
  if (html.includes(`id="${gone}"`)) die(`被裁元素仍残留：${gone}`);
}

fs.writeFileSync(OUT, html);

console.log('✓ Lite 前端已生成');
console.log('  源文件     : index.html (' + before + ' 字节)');
console.log('  产物       : ' + path.relative(ROOT, OUT).replace(/\\/g, '/') + ' (' + html.length + ' 字节)');
console.log('  保留页面   : ' + KEEP.join(' · '));
console.log('  裁掉       : ' + cutSections + ' 个 section + ' + cutNav + ' 个 nav 项');
