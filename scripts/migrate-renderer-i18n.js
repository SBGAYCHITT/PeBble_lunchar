#!/usr/bin/env node
// 一次性把 renderer.js 里残留的硬编码中文文案迁移到 T('key')（原子替换 + 断言）。
// 用 split/join 避免正则与 $ 转义问题；每条 old 必须命中且唯一。
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'renderer.js');
const src = fs.readFileSync(FILE, 'utf8');

const REPL = [
  [
    "      PL.setStatus('已添加离线账户: ' + name, '');",
    "      PL.setStatus(T('acc.offlineAdded', { name }), '');"
  ],
  [
    "      if (!server || !user || !pass) { PL.setStatus('请填写完整的外置登录信息', 'err'); return; }",
    "      if (!server || !user || !pass) { PL.setStatus(T('acc.yggFill'), 'err'); return; }"
  ],
  [
    "      PL.setStatus('正在登录外置账户…', 'run');",
    "      PL.setStatus(T('acc.yggLogging'), 'run');"
  ],
  [
    "      if (!r || !r.ok) { PL.setStatus('外置登录失败: ' + ((r && r.error) || '未知'), 'err'); return; }",
    "      if (!r || !r.ok) { PL.setStatus(T('acc.yggFail', { err: (r && r.error) || T('common.unknown') }), 'err'); return; }"
  ],
  [
    "      PL.setStatus('外置登录成功: ' + r.name, '');",
    "      PL.setStatus(T('acc.yggOk', { name: r.name }), '');"
  ],
  [
    "      PL.setStatus('等待微软授权…', 'run');",
    "      PL.setStatus(T('acc.msWaiting'), 'run');"
  ],
  [
    "      if (!r || !r.ok) { PL.setStatus('微软登录失败: ' + ((r && r.error) || '未知'), 'err'); return; }",
    "      if (!r || !r.ok) { PL.setStatus(T('acc.msFail', { err: (r && r.error) || T('common.unknown') }), 'err'); return; }"
  ],
  [
    "      PL.setStatus(r.stopped ? `已结束 ${r.stopped} 个游戏进程` : '没有正在运行的游戏', '');",
    "      PL.setStatus(r.stopped ? T('ml.stopped', { n: r.stopped }) : T('ml.noneRunning'), '');"
  ],
  [
    "      if (hint) hint.textContent = '准备中…';",
    "      if (hint) hint.textContent = T('java.dlPreparing');"
  ],
  [
    "      if (hint) hint.textContent = (r && r.ok) ? ((r.cached ? '已安装过：' : '安装完成：') + r.javaPath) : ('失败: ' + ((r && r.error) || '未知'));",
    "      if (hint) hint.textContent = (r && r.ok) ? ((r.cached ? T('java.dlCached') : T('java.dlDone')) + r.javaPath) : (T('common.fail') + ((r && r.error) || T('common.unknown')));"
  ],
  [
    "  const PAGE_TITLE = { launch: '启动', versions: '版本', instances: '实例', mods: 'Mod', rps: '资源包', shaders: '光影', saves: '存档', shots: '截图', account: '账户', lab: '调优', logs: '日志', settings: '设置', about: '关于' };\n  PAGE_INIT.instances = async () => {",
    "  PAGE_INIT.instances = async () => {"
  ],
  [
    "        $('nav-title').textContent = window.I18N ? window.I18N.t('nav.' + page) : (PAGE_TITLE[page] || '');",
    "        $('nav-title').textContent = window.I18N ? window.I18N.t('nav.' + page) : '';"
  ],
  [
    "    if (!r.ok) { sel.innerHTML = '<option value=\"\">清单获取失败，检查网络</option>'; return; }",
    "    if (!r.ok) { sel.innerHTML = '<option value=\"\">' + T('dl.manifestFail') + '</option>'; return; }"
  ],
  [
    "      if (s.state === 'running') PL.setStatus('游戏运行中', 'run');",
    "      if (s.state === 'running') PL.setStatus(T('status.running'), 'run');"
  ],
  [
    "      if (s.state === 'error') PL.setStatus('游戏异常 (code ' + s.code + ')', 'err');",
    "      if (s.state === 'error') PL.setStatus(T('status.errorCode', { code: s.code }), 'err');"
  ],
  [
    "      if (s.state === 'exit') PL.setStatus(s.code === 0 ? '游戏已退出' : '游戏异常退出 (code ' + s.code + ')', s.code === 0 ? '' : 'err');",
    "      if (s.state === 'exit') PL.setStatus(s.code === 0 ? T('status.exited') : T('status.exitCode', { code: s.code }), s.code === 0 ? '' : 'err');"
  ]
];

let out = src;
let ok = 0;
for (const [from, to] of REPL) {
  const n = out.split(from).length - 1;
  if (n !== 1) {
    console.error('  [WARN] 期望命中 1 次，实际 ' + n + ' 次：' + from.slice(0, 40));
    if (n === 0) { console.error('    -> 跳过，未替换'); continue; }
  }
  out = out.split(from).join(to);
  ok++;
}
console.log('替换成功 ' + ok + '/' + REPL.length + ' 条');
fs.writeFileSync(FILE, out, 'utf8');
console.log('已写回 ' + FILE);
