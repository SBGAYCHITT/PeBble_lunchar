/**
 * Lite 打包产物真机核验：直接驱动 dist-lite2/win-unpacked 里的 exe，
 * 通过 CDP 检查「页面是否只剩 5 个」「LITE 徽标是否在」「init 有没有断在半路」。
 *
 * 为什么要连打包产物而不是源码目录：Lite 的关键前提是「被裁掉的模块不进包、
 * 被裁掉的 IPC 域不注册」。只有跑真实产物才能验证这一点 —— 源码目录里所有文件都在，
 * 测出来永远是"全功能可用"，等于没测。
 *
 * 用法：node _lite.e2e.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/* 产物路径：优先 PL_EXE，否则自动挑最新的 dist-liteNN/win-unpacked。
   不写死目录名 —— Lite 重打包时会因为沙箱的 emptyDir 守卫换新目录（dist-lite2/3/…），
   写死了每次都得改脚本。 */
function findExe() {
  if (process.env.PL_EXE) return process.env.PL_EXE;
  const cands = [];
  for (const d of fs.readdirSync(ROOT)) {
    if (!/^dist-lite\d*$/.test(d)) continue;
    const p = path.join(ROOT, d, 'win-unpacked', 'Pebble Lunchar.exe');
    if (fs.existsSync(p)) cands.push({ p, t: fs.statSync(p).mtimeMs });
  }
  if (cands.length) {
    cands.sort((a, b) => b.t - a.t);
    return cands[0].p;
  }
  return path.join(ROOT, 'dist-lite', 'win-unpacked', 'Pebble Lunchar.exe');
}

const EXE = findExe();
const PORT = 9333;
const SHOT = process.env.PL_SHOT || path.join(ROOT, '..', 'shot-lite.png');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page;
    } catch { /* 还没起来 */ }
    await sleep(500);
  }
  throw new Error('CDP 端点 30 秒内没就绪');
}

function makeClient(ws) {
  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    } else if (m.method) {
      events.push(m);
    }
  });
  const send = (method, params) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { send, events };
}

(async () => {
  if (!fs.existsSync(EXE)) { console.error('找不到产物: ' + EXE); process.exit(1); }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-lite-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;   // 否则 exe 会以 Node 模式启动，秒退
  delete env.NODE_OPTIONS;

  console.log('启动产物: ' + EXE);
  const child = spawn(EXE, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userData}`,
    '--disable-gpu', '--disable-gpu-compositing', '--disable-software-rasterizer', '--no-sandbox'
  ], { stdio: ['ignore', 'pipe', 'pipe'], env, cwd: path.dirname(EXE) });

  const childLog = [];
  child.stdout.on('data', (d) => childLog.push(d.toString()));
  child.stderr.on('data', (d) => childLog.push(d.toString()));
  let exited = false;
  child.on('exit', (c) => { exited = true; childLog.push('!! 进程退出 code=' + c); });

  let pass = 0, fail = 0;
  const check = (name, ok, extra) => {
    console.log((ok ? '  ok   ' : '  FAIL ') + name + (extra ? '  → ' + extra : ''));
    ok ? pass++ : fail++;
  };

  try {
    const target = await waitTarget();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const { send, events } = makeClient(ws);

    await send('Runtime.enable');
    await send('Page.enable');
    await sleep(2500);   // 等 renderer 的 init() 跑完（版本清单是网络请求）

    const evalJS = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('页面内异常: ' + JSON.stringify(r.exceptionDetails.exception));
      return r.result.value;
    };

    /* ---------- 1. 页面结构 ---------- */
    const dom = await evalJS(`(() => ({
      navs: [...document.querySelectorAll('.nav-item')].map(b => b.dataset.page),
      secs: [...document.querySelectorAll('.page')].map(s => s.id.replace('page-','')),
      lite: !!document.querySelector('.logo-badge.lite'),
      title: document.title,
      pagesApi: typeof window.Pages,
      pl: !!window.PL,
      cur: window.PL && window.PL.currentPage,
      winW: window.innerWidth, winH: window.innerHeight
    }))()`);

    const want = ['launch', 'versions', 'account', 'settings', 'about'];
    check('导航只剩 5 项', dom.navs.join(',') === want.join(','), dom.navs.join(','));
    check('页面只剩 5 个', dom.secs.join(',') === want.join(','), dom.secs.join(','));
    check('标题栏有 LITE 徽标', dom.lite);
    check('窗口标题是 Lite', dom.title === 'Pebble Lunchar Lite', dom.title);
    check('渲染层脚本都加载了', dom.pagesApi === 'object' && dom.pl === true);
    check('启动页默认激活', dom.cur === 'launch', dom.cur);
    check('窗口已撑开', dom.winW >= 900, dom.winW + '×' + dom.winH);

    /* ---------- 2. 被裁元素确实不在（防止"只删了壳"） ---------- */
    const gone = await evalJS(`(() => {
      const ids = ['inst-select','btn-inst-manage','ml-list','ab-bind','saves-list','shots-list','page-world','page-modkit'];
      return ids.filter(i => document.getElementById(i));
    })()`);
    check('被裁 DOM 无残留', gone.length === 0, gone.join(','));

    /* ---------- 3. init 是否跑完（关键：断了就不会有版本） ---------- */
    const state = await evalJS(`(() => ({
      cfgMcDir: window.PL && window.PL.cfg.mcDir,
      log: (document.getElementById('log-view') || {}).textContent || '',
      verCards: document.querySelectorAll('#version-list .item').length,
      javaInfo: (document.getElementById('java-info') || {}).textContent || ''
    }))()`);
    check('init 跑到了默认目录解析', !!state.cfgMcDir, state.cfgMcDir);
    check('日志无页面级异常', !/页面|Cannot read|undefined 的/.test(state.log), state.log.slice(0, 80).replace(/\n/g, ' '));

    /* ---------- 4. 逐页切换 ---------- */
    const pageErrs = [];
    for (const p of want) {
      const r = await evalJS(`(async () => {
        const btn = document.querySelector('.nav-item[data-page="${p}"]');
        btn.click();
        await new Promise(r => setTimeout(r, 700));
        return {
          active: document.getElementById('page-${p}').classList.contains('active'),
          title: document.getElementById('nav-title').textContent,
          log: (document.getElementById('log-view') || {}).textContent || ''
        };
      })()`);
      const bad = /Cannot read|undefined|not a function|No handler/.test(r.log);
      if (!r.active || bad) pageErrs.push(p + (bad ? '(日志异常)' : '(未激活)'));
    }
    check('5 个页面都能切换', pageErrs.length === 0, pageErrs.join(','));

    /* ---------- 5. 版本页真的拿到了在线清单 ---------- */
    const dl = await evalJS(`(() => ({
      loaded: !!(document.getElementById('dl-list') || {}).dataset,
      cards: document.querySelectorAll('#dl-list .ver-card').length,
      icons: document.querySelectorAll('#dl-list .ver-card img.blk').length
    }))()`);
    check('在线版本清单已渲染', dl.cards > 0, dl.cards + ' 个版本卡片');
    check('版本图标是原版贴图', dl.icons > 0, dl.icons + ' 个 <img.blk>');

    /* ---------- 6. 控制台/未捕获异常 ---------- */
    const errs = events.filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text);
    check('无未捕获异常', errs.length === 0, errs.slice(0, 2).join(' | ').slice(0, 160));

    /* ---------- 7. 截图（切回启动页） ---------- */
    await evalJS(`document.querySelector('.nav-item[data-page="launch"]').click()`);
    await sleep(600);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log('  截图: ' + SHOT + ' (' + Math.round(fs.statSync(SHOT).size / 1024) + ' KB)');

    check('进程仍在运行', !exited, exited ? childLog.slice(-3).join(' ') : '');
    ws.close();
  } catch (e) {
    console.error('核验中断: ' + e.message);
    fail++;
  } finally {
    try { child.kill(); } catch {}
    await sleep(800);
    if (childLog.length) console.log('子进程输出:\n' + childLog.join('').slice(0, 1200));
  }

  console.log('\n★ ' + (fail === 0 ? '全部通过' : '有失败项') + ' (' + pass + ' 通过 / ' + fail + ' 失败)');
  process.exit(fail === 0 ? 0 : 1);
})();
