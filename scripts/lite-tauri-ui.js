#!/usr/bin/env node
/**
 * 打开 Lite 的前端预览台（可选指定页面）。
 *
 * 单独包一层是为了两个环境坑：
 *   1. `ELECTRON_RUN_AS_NODE` 一旦被设上，electron.exe 会退化成纯 Node，
 *      `require('electron')` 拿到的是个路径字符串，解构出来全是 undefined。
 *      本进程里清掉它。
 *   2. 必须用项目自带的 electron.exe，而不是 PATH 上随便一个。
 *
 * 用法：node scripts/lite-tauri-ui.js [launch|versions|account|settings|about]
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PROJ = path.join(ROOT, 'lite-tauri');

if (!fs.existsSync(ELECTRON)) {
  console.error('✗ 找不到 ' + ELECTRON + '，先 npm install');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = ['preview-ui.js', ...process.argv.slice(2)];
const r = spawnSync(ELECTRON, args, { cwd: PROJ, stdio: 'inherit', env });
process.exit(r.status === null ? 1 : r.status);
