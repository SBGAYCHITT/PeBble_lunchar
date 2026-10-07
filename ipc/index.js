// IPC 注册入口：main.js 只负责装配，各域 handler 分散在 ipc/*.js
//
// 为什么拆：main.js 曾塞了 110 个 ipcMain.handle，找一个 channel 要翻上千行。
// 拆开后每个域一个文件，新增功能时不会互相打架。
//
// 副作用：handler 不再能直接读写 main.js 里的 let 变量（原始值没有共享引用），
// 所以凡是「状态」都必须通过 ctx 的函数访问（getSysConf / setLaunching / refreshTray ...）。
// 拆错/漏拆由 tests/ipc-contract.test.js 兜住（静态比对 handle 与 preload 的 invoke）。

/**
 * @typedef {Object} IpcContext
 * @property {import('electron').IpcMain} ipcMain
 * @property {import('electron').Dialog} dialog
 * @property {(channel:string, payload:any) => void} emit  向渲染层推送事件
 * @property {() => any} getWin          当前窗口（可能为 null）
 * @property {() => any} getSysConf     系统配置对象
 * @property {(patch:Object) => Object} patchSysConf
 * @property {(enable:boolean) => Object} setAutoStart
 * @property {() => void} refreshTray
 * @property {(v:boolean) => void} setLaunching
 * @property {(o:Object) => void} setLastLaunch
 * @property {string} TM_DIR     时光机仓库
 * @property {string} INST_ROOT  实例根目录
 * @property {string} JAVA_ROOT  自带 Java 安装根
 * @property {string} userData   app.getPath('userData')
 * @property {string} APP_DIR    __dirname（取图标等资源用）
 * @property {number} AUTO_KEEP  每个存档保留的自动快照数
 */

const DOMAINS = [
  './window',
  './base',
  './launch',
  './account',
  './multilaunch',
  './lab',
  './versions',
  './content',
  './store',
  './backup',
  './instance',
  './migrate',
  './system',
  './world',
  './perf',
  './modkit',
  './entitydoctor',
  './craftplanner',
  './livemetrics',
  './accountbook'
];

/**
 * 注册全部 IPC handler
 * @param {IpcContext} ctx
 */
function registerAll(ctx) {
  for (const d of DOMAINS) require(d)(ctx);
}

module.exports = { registerAll, DOMAINS };
