#!/usr/bin/env node
// 原子修复 i18n-ui.js 的 EN 字典：补 log.page、把 lang.zhCN 英文改成 Chinese (Simplified)。
'use strict';
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, '..', 'i18n-ui.js');
let s = fs.readFileSync(FILE, 'utf8');

const A = [
  // EN 的 lang.zhCN 必须区别于 ZH（否则英文下该语言名退化成中文，契约测试会判「未翻译」）
  [
    "    'upd.latest': 'Up to date ({{current}})',\n\n    'lang.zhCN': '简体中文',",
    "    'upd.latest': 'Up to date ({{current}})',\n\n    'lang.zhCN': 'Chinese (Simplified)',"
  ],
  // EN 补 log.page（ZH 已有）
  [
    "    'log.download': '[download] '\n  };",
    "    'log.download': '[download] ',\n    'log.page': '[page] '\n  };"
  ]
];

let ok = 0;
for (const [from, to] of A) {
  const n = s.split(from).length - 1;
  if (n !== 1) { console.error('[WARN] 命中 ' + n + ' 次：' + from.slice(0, 30)); continue; }
  s = s.split(from).join(to);
  ok++;
}
fs.writeFileSync(FILE, s, 'utf8');
console.log('i18n-ui.js 修复 ' + ok + '/' + A.length);
