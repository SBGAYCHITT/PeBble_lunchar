#!/usr/bin/env node
/**
 * Pebble Lunchar - node_modules 本地补丁管理器
 *
 * 背景：electron-builder 打包时会去下载 winCodeSign，其中的 darwin 符号链接在
 * 无管理员权限的 Windows 上无法解压，导致打包失败。我们对 app-builder-lib 打了两处补丁绕开。
 * 以前这些补丁只存在于 node_modules 里，重装依赖就丢失 —— 现在补丁定义随仓库走，
 * `npm install` 后由 postinstall 自动校验并重放。
 *
 * 用法：
 *   node scripts/apply-patches.js          # 校验并（若需要）应用补丁
 *   node scripts/apply-patches.js --check  # 只校验，不改写
 *
 * 设计：幂等。先找 marker（补丁已应用的标记），已应用就跳过；
 *      否则用 find/replace 应用；find 匹配不到说明上游版本变了，会明确告警而不是静默失败。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ---- 补丁 1：winPackager 直接 spawn 本地 rcedit，不走 executeAppBuilder（后者会触发下载） ----
const WINPACKAGER_FIND = `if (process.platform === "win32" || process.platform === "darwin") {
            const vendorPath = await (0, windowsCodeSign_1.getSignVendorPath)();
            await (0, builder_util_1.executeAppBuilder)(["rcedit", ...args]);`;

const WINPACKAGER_REPLACE = `if (process.platform === "win32" || process.platform === "darwin") {
            // 本地补丁：直接调用缓存里已解压的 rcedit，避免 app-builder 去下载 winCodeSign
            // （winCodeSign 压缩包内的 darwin 符号链接在无管理员权限时无法解压）
            const vendorPath = await (0, windowsCodeSign_1.getSignVendorPath)();
            const rcedit = path.join(vendorPath, "rcedit-x64.exe");
            await new Promise((resolve, reject) => {
                const cp = require("child_process").spawn(rcedit, args, { stdio: "inherit" });
                cp.on("error", reject);
                cp.on("close", (code) => code === 0 ? resolve() : reject(new Error("rcedit 退出码 " + code)));
            });`;

// ---- 补丁 2：getSignVendorPath 优先复用已解压缓存 ----
const SIGNPATH_FIND = 'function getSignVendorPath() {';
const SIGNPATH_REPLACE = `function getSignVendorPath() {
    // 本地补丁：优先复用已解压的 winCodeSign 缓存（避免无管理员权限时 7z 创建符号链接失败）
    try {
        const cache = path.join(process.env.LOCALAPPDATA || "", "electron-builder", "Cache", "winCodeSign");
        const dirs = require("fs").readdirSync(cache);
        for (const d of dirs) {
            const full = path.join(cache, d);
            if (require("fs").existsSync(path.join(full, "windows-10")) && require("fs").existsSync(path.join(full, "rcedit-x64.exe"))) {
                return Promise.resolve(full);
            }
        }
    } catch (e) {}`;

const PATCHES = [
  {
    name: 'winPackager: rcedit 直调本地缓存',
    file: 'node_modules/app-builder-lib/out/winPackager.js',
    marker: '本地补丁：直接调用缓存里已解压的 rcedit',
    find: WINPACKAGER_FIND,
    replace: WINPACKAGER_REPLACE
  },
  {
    name: 'windowsCodeSign: 复用已解压缓存',
    file: 'node_modules/app-builder-lib/out/codeSign/windowsCodeSign.js',
    marker: '本地补丁：优先复用已解压的 winCodeSign',
    find: SIGNPATH_FIND,
    replace: SIGNPATH_REPLACE
  }
];

function main() {
  const checkOnly = process.argv.includes('--check');
  let fail = 0;

  for (const p of PATCHES) {
    const abs = path.join(ROOT, p.file);
    if (!fs.existsSync(abs)) {
      console.log(`[跳过] ${p.name} —— 未安装 ${p.file}`);
      continue;
    }
    let src = fs.readFileSync(abs, 'utf8');

    if (src.includes(p.marker)) {
      console.log(`[已应用] ${p.name}`);
      continue;
    }
    if (checkOnly) {
      console.log(`[缺失] ${p.name} —— 需要应用补丁`);
      fail++;
      continue;
    }
    if (!src.includes(p.find)) {
      console.log(`[警告] ${p.name} —— 未找到待替换代码，上游版本可能已变化，请人工确认：\n        ${p.file}`);
      fail++;
      continue;
    }
    src = src.replace(p.find, p.replace);
    fs.writeFileSync(abs, src, 'utf8');
    console.log(`[已应用] ${p.name}`);
  }

  if (fail) {
    console.log('\n有 ' + fail + ' 个补丁未能自动应用。若打包报 winCodeSign 相关错误，请按 scripts/apply-patches.js 顶部说明手工处理。');
    if (checkOnly) process.exitCode = 1;
  } else {
    console.log('\n补丁状态正常。');
  }
}

main();
