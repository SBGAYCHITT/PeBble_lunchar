#!/usr/bin/env node
/**
 * 通过 WebView2 的远程调试端口给界面做真机体检。
 *
 * 为什么不能用截屏：WebView2 用的是 DirectComposition 合成表面，
 * 外部的 `BitBlt`（PIL ImageGrab）和 `PrintWindow` **都抓不到内容**，
 * 截出来是全黑或者全白 —— 我第一次就是这么被误导的。
 * 走 CDP 拿到的则是渲染进程自己吐出来的位图和 DOM，是可信的。
 *
 * 用法：
 *   1. WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 \
 *        ./Pebble-Launcher-Lite.exe
 *   2. node probe-ui.js
 */
const fs = require('fs');
const http = require('http');

const PORT = 9222;
const OUT = 'target/_ui-cdp.png';

const get = (p) => new Promise((res, rej) => {
  const req = http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d));
  });
  req.on('error', rej);
  // 本机回环不要去走 HTTP 代理（带着代理会变成一个莫名其妙的 502）
  req.setNoDelay(true);
});

(async () => {
  let targets;
  try {
    targets = JSON.parse(await get('/json'));
  } catch (e) {
    console.error('✗ 连不上 127.0.0.1:' + PORT + '（' + e.code + ' ' + e.message + '）');
    console.error('  1) 启动时必须带 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=' + PORT);
    console.error('     注意要用 `export VAR=...` 的形式，写成 `VAR=... ./app.exe` 传不进去。');
    console.error('  2) 若在沙箱里跑本脚本，本机回环连接会被拦掉，需要放开沙箱。');
    process.exit(1);
  }
  const page = targets.find((t) => t.type === 'page');
  if (!page) { console.error('✗ 没有 page 目标，实际有：'
    + targets.map((t) => t.type).join(', ')); process.exit(1); }
  console.log('▸ 页面      ' + page.url);
  console.log('▸ 标题      ' + page.title);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const waiters = new Map();
  const console_ = [];   // 页面控制台输出，专门用来抓「命令被 ACL 拒绝」这类静默失败
  const send = (method, params = {}) => new Promise((res) => {
    const mid = ++id;
    waiters.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      console_.push('[' + m.params.type + '] ' + m.params.args
        .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      console_.push('[throw] ' + (d.exception ? d.exception.description : d.text));
    }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Runtime.enable');
  await send('Log.enable');

  /** 在页面里求值，返回字符串化结果 */
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true
    });
    const res = r.result && r.result.result;
    if (r.result && r.result.exceptionDetails) {
      return 'EXCEPTION: ' + (r.result.exceptionDetails.exception
        ? r.result.exceptionDetails.exception.description : '?');
    }
    return res && res.value;
  };

  let pass = 0, fail = 0;
  const chk = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); c ? pass++ : fail++; };

  console.log('\n=== DOM ===');
  chk((await evalJs('document.title')) === 'Pebble Launcher Lite',
    'title = ' + JSON.stringify(await evalJs('document.title')));
  const nav = await evalJs("document.querySelectorAll('.nav-item').length");
  chk(nav === 5, '导航 5 项（实为 ' + nav + '）');
  chk((await evalJs("!!document.getElementById('titlebar')")), '标题栏存在');
  chk((await evalJs("!!document.querySelector('#titlebar[data-tauri-drag-region]')")),
    '标题栏挂了 data-tauri-drag-region（无边框窗口才拖得动）');
  const bg = await evalJs("getComputedStyle(document.body).backgroundColor");
  chk(bg && bg !== 'rgba(0, 0, 0, 0)', '样式表已生效，body 背景 = ' + bg);
  const logoW = await evalJs("(document.querySelector('.logo-mark')||{}).naturalWidth");
  chk(logoW > 0, 'logo.png 已加载，原始宽度=' + logoW);
  chk((await evalJs("document.querySelectorAll('.blk').length")) > 0, '方块图标已渲染');

  console.log('\n=== IPC（Tauri 命令）===');
  chk((await evalJs('typeof window.__TAURI__')) === 'object', 'withGlobalTauri 生效');
  const info = await evalJs(
    "window.__TAURI__.core.invoke('app_info').then(r=>JSON.stringify(r)).catch(e=>'ERR: '+e)");
  chk(typeof info === 'string' && info.startsWith('{'), 'app_info 返回 ' + info);
  const vers = await evalJs(
    "window.__TAURI__.core.invoke('list_versions').then(r=>JSON.stringify(r.map(v=>v.id))).catch(e=>'ERR: '+e)");
  chk(typeof vers === 'string' && vers.startsWith('['), 'list_versions 返回 ' + vers);
  const javas = await evalJs(
    "window.__TAURI__.core.invoke('detect_java').then(r=>JSON.stringify(r.length)).catch(e=>'ERR: '+e)");
  chk(typeof javas === 'string' && !javas.startsWith('ERR'), 'detect_java 返回 ' + javas + ' 条');
  const st = await evalJs(
    "window.__TAURI__.core.invoke('settings_get').then(r=>JSON.stringify(r)).catch(e=>'ERR: '+e)");
  chk(typeof st === 'string' && st.startsWith('{'), 'settings_get 返回 ' + String(st).slice(0, 90));
  // 事件通道（game-log / game-exit 靠它推给界面）
  const ev = await evalJs(
    "window.__TAURI__.event.listen('__probe',()=>{}).then(()=> 'ok').catch(e=>'ERR: '+e)");
  chk(ev === 'ok', 'event.listen 可用（core:event 权限已授予）');

  console.log('\n=== 截图（走渲染进程，绕过合成表面）===');
  await send('Page.enable');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const data = shot.result && shot.result.data;
  if (data) {
    fs.writeFileSync(OUT, Buffer.from(data, 'base64'));
    const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
    chk(fs.statSync(OUT).size > 20000, '已存 ' + OUT + '（' + kb + ' KB）');
  } else {
    chk(false, 'captureScreenshot 没有返回数据');
  }

  if (console_.length) {
    console.log('\n=== 页面控制台 ===');
    for (const l of console_.slice(0, 25)) console.log('  ' + l.slice(0, 220));
  }

  console.log('\n============================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
