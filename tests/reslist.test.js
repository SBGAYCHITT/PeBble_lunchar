// 资源列表取数口径的回归测试
//
// 背景（真实 bug）：资源页把「已经拼好子目录的路径」传给了会自己再拼一次的接口，
// 实际读的是 `...\mods\mods` —— 目录不存在，列表永远是空的。
// 玩家那边的表现是：明明装了 Mod，启动器里一个都不显示。
//
// 这里锁两件事：
//   1) mcapi.listXxx 的入参是「游戏根目录」，传子目录进去只会拿到空数组（契约本身如此）；
//   2) pages.js 的 refreshRes 必须传 gameDir()，不能再出现 fn()(resDir(...)) 这种写法。
const fs = require('fs');
const path = require('path');
const os = require('os');
const mcapi = require('../mcapi');

let pass = 0, fail = 0;
const say = (s) => { try { fs.writeSync(1, s + '\n'); } catch {} };
function check(name, ok, extra) {
  if (ok) { pass++; say('  ok    ' + name); }
  else { fail++; say('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

const TMP = path.join(os.tmpdir(), 'pl-reslist-' + Date.now());
fs.rmSync(TMP, { recursive: true, force: true });

/* ---------- 1. 接口契约：入参是游戏根目录 ---------- */
say('=== mcapi 资源列表：入参是游戏根目录 ===');
for (const c of [
  { kind: 'mods', sub: 'mods', file: 'demo-1.0.0.jar', fn: 'listMods' },
  { kind: 'rps', sub: 'resourcepacks', file: 'pack.zip', fn: 'listResourcepacks' },
  { kind: 'shaders', sub: 'shaderpacks', file: 'shader.zip', fn: 'listShaderpacks' },
]) {
  const gameDir = path.join(TMP, c.kind);
  const sub = path.join(gameDir, c.sub);
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, c.file), 'x');

  const fromRoot = mcapi[c.fn](gameDir);
  const fromSub = mcapi[c.fn](sub);
  check(`${c.kind}: 传游戏根目录能列到文件`, fromRoot.length === 1 && fromRoot[0].name === c.file, JSON.stringify(fromRoot));
  check(`${c.kind}: 传子目录拿到空数组（这就是 bug 的形态）`, fromSub.length === 0, JSON.stringify(fromSub));
}

/* ---------- 2. 渲染层不许再把 resDir 传进去 ---------- */
say('\n=== pages.js 取数口径 ===');
const src = fs.readFileSync(path.join(__dirname, '..', 'pages.js'), 'utf8');
const refreshBody = (() => {
  const i = src.indexOf('async function refreshRes(kind)');
  if (i < 0) return '';
  return src.slice(i, i + 600);
})();
check('refreshRes 存在', refreshBody.length > 0);
check('refreshRes 传的是 gameDir()', /fn\(\)\(gameDir\(\)\)/.test(refreshBody), refreshBody.split('\n').slice(0, 8).join(' | '));
check('refreshRes 不再传 resDir(kind)', !/fn\(\)\(resDir\(/.test(refreshBody));
check('整个文件里没有 fn()(resDir( 这种双拼写法', !/RES_META\[[^\]]+\]\.fn\(\)\(resDir\(/.test(src));

/* ---------- 收尾 ---------- */
say(`\n${fail === 0 ? '★' : '✗'} 结果: ${pass} 通过 / ${fail} 失败`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
