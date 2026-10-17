#!/usr/bin/env node
/**
 * Lite 前后端契约静态对账。
 *
 * 为什么需要单独一个检查器：前端是 JS、后端是 Rust，两边靠字符串（命令名、
 * 字段名）约定，编译器一个都管不了。而且失败方式极其安静 ——
 * Tauri **不会**把 Rust 的 snake_case 返回值转成 camelCase（只转入参），
 * 所以 `info.defaultMcDir` 读一个叫 `default_mc_dir` 的字段，结果是 undefined：
 * 不报错、不崩溃、界面照常打开，只是那几行字空着。这一轮就是这么踩到的。
 *
 * 检查四件事：
 *   1. app.js 里 invoke 的命令都在 generate_handler! 里注册了；
 *   2. invoke 传的参数名（camelCase）能对上 Rust 的入参名（snake_case）；
 *   3. 直接赋值拿到的返回值，读的字段名能在对应结构体里找到；
 *   4. 数组结果（版本 / Java / 账户）在 map 回调里读的字段同样能对上。
 *
 * 用法（在 lite-tauri/ 下）：node check-contract.js
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src');
const APP_JS = path.join(__dirname, 'ui', 'app.js');

const camelToSnake = (s) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());

// ---------------------------------------------------------------- 解析 Rust

/** 去掉行注释与块注释。
 *  注意**不能**顺手把字符串字面量也擦掉：`#[serde(rename_all = "camelCase")]`
 *  里的 camelCase 就在字符串里，擦掉之后所有字段名都会被误判成没重命名。 */
function stripRs(text) {
  return text
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 按顶层逗号切分。
 *
 *  angle=true 时把 `<` `>` 也算作括号深度 —— Rust 侧需要（`Option<String, _>`
 *  里的逗号不能被切开）。JS 侧必须关掉：`a < b, c` 或箭头函数 `=>` 会让深度
 *  错乱，把该切的逗号漏掉。 */
function splitTop(s, angle = true) {
  const open = angle ? '{([<' : '{([';
  const close = angle ? '})]>' : '})]';
  const out = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (open.includes(ch)) depth++;
    else if (close.includes(ch)) depth--;
    if (ch === ',' && depth <= 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const splitTopRs = (s) => splitTop(s, true);
const splitTopJs = (s) => splitTop(s, false);

function parseStructs(text) {
  const out = new Map();
  // `pub` 是可选的：main.rs 里 AppInfo / VersionDetail / LaunchResult 都是私有结构体。
  // 早先只认 `pub struct`，这三个就被静默跳过 —— 恰好是 camelCase 那批坑所在的地方。
  // 结尾的 `}` 不要求独占一行，单行写的结构体也要能解析。
  const re = /((?:#\[[^\]]*\]\s*)*)(?:pub\s+)?struct (\w+)\s*\{([\s\S]*?)\}/g;
  let m;
  while ((m = re.exec(text))) {
    const attrs = m[1] || '';
    const name = m[2];
    const camel = /rename_all\s*=\s*"camelCase"/.test(attrs);
    const fields = [];
    // 字段之间是顶层逗号，所以直接用 splitTopRs 切；
    // `#[serde(rename = "x")]` 与 `HashMap<String, u32>` 里的逗号都在括号里，不会被切开。
    for (const token of splitTopRs(m[3])) {
      const t = token.trim();
      if (!t) continue;
      const rn = t.match(/#\[serde\(rename\s*=\s*"([^"]+)"/);
      const stripped = t.replace(/#\[[^\]]*\]/g, ' ');   // 去掉属性，避免匹配到 rename 本身
      const f = stripped.match(/(\w+)\s*:/);
      if (!f) continue;
      let key = f[1];
      if (rn) key = rn[1];
      else if (camel) key = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      fields.push(key);
    }
    out.set(name, fields);
  }
  return out;
}

function parseCommands(text) {
  const out = new Map();   // 名字 -> { params: [snake 名], ret: 结构体名 | null }
  const re = /#\[tauri::command\]\s*(?:pub\s+)?(?:async\s+)?fn (\w+)\s*\(([\s\S]*?)\)\s*(?:->\s*([\s\S]*?))?\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    const name = m[1];
    const params = [];
    for (const p of splitTopRs(m[2] || '')) {
      const pm = p.match(/^\s*(\w+)\s*:/);
      if (!pm) continue;
      // Tauri 自己注入的参数不用前端传
      if (['state', 'app', 'window', 'webview', 'app_handle'].includes(pm[1])) continue;
      params.push(pm[1]);
    }
    let ret = null;
    const rt = (m[3] || '').trim();
    if (rt) {
      const base = rt.match(/(?:Result|Option)\s*<\s*([\w:]+)/) || rt.match(/Vec\s*<\s*([\w:]+)/) ||
        rt.match(/^([\w:]+)/);
      if (base) ret = base[1].split('::').pop();
    }
    out.set(name, { params, ret });
  }
  const h = text.match(/generate_handler!\s*\[([\s\S]*?)\]/);
  const registered = h
    ? h[1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.split('::').pop())
    : [];
  return { commands: out, registered };
}

// ---------------------------------------------------------------- 解析 JS

/** JS 数组自带的成员，不是结构体字段 */
const JS_BUILTIN = new Set(['length', 'map', 'filter', 'find', 'some', 'every', 'forEach',
  'slice', 'join', 'push', 'sort', 'concat', 'at', 'indexOf', 'includes', 'reduce',
  'entries', 'keys', 'values', 'pop', 'shift', 'reverse', 'flat']);

/** 收集 invoke('cmd', {...}) 调用。
 *
 *  两个坑，都是"参数被当成没传"却不报错：
 *  1. 对象简写 `invoke('x', { settings })` —— `settings` 后面没有冒号，
 *     只匹配 `^\w+\s*:` 的话会认为这个参数不存在。这里两种写法都收。
 *  2. 嵌套对象 `invoke('x', { diag: f({ ok }) })` —— 非贪婪正则会停在
 *     内层 `}` 上。所以这里改成手写配对扫描，不用正则吃括号。 */
function parseInvokes(js) {
  const out = [];
  const needle = 'invoke(';
  let i = -1;
  while ((i = js.indexOf(needle, i + 1)) !== -1) {
    const start = i;
    let p = i + needle.length;
    while (p < js.length && /\s/.test(js[p])) p++;
    const q = js[p];
    if (q !== "'" && q !== '"') continue;          // 命令名不是字面量，跳过
    const end = js.indexOf(q, p + 1);
    if (end === -1) continue;
    const cmd = js.slice(p + 1, end);
    p = end + 1;
    while (p < js.length && /\s/.test(js[p])) p++;

    let args = [];
    let nonObject = false;
    if (js[p] === ',') {
      p++;
      while (p < js.length && /\s/.test(js[p])) p++;
      if (js[p] === '{') {
        const s = p;
        let depth = 0, inStr = null;
        for (; p < js.length; p++) {
          const ch = js[p];
          if (inStr) {
            if (ch === '\\') { p++; continue; }
            if (ch === inStr) inStr = null;
            continue;
          }
          if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
          if (ch === '{') depth++;
          else if (ch === '}') { depth--; if (depth === 0) { p++; break; } }
        }
        // 顶层逗号切分（嵌套里的逗号不算）；`k: v` 与简写 `k` 都算参数名
        args = splitTopJs(js.slice(s + 1, p - 1))
          .map((t) => {
            const tt = t.trim();
            const mm = tt.match(/^(\w+)\s*:/) || tt.match(/^(\w+)$/);
            return mm ? mm[1] : null;
          })
          .filter(Boolean);
      } else {
        // 第二参不是对象字面量（传变量等）时留空，下面会按"没传参"报出来
        nonObject = true;
      }
    }
    out.push({
      cmd, args, nonObject, index: start,
      line: js.slice(0, start).split('\n').length,
    });
  }
  return out;
}

/** 判断 `/` 在这里是正则开头还是除号（JS 里的老难题，这里只用一个
 *  "上一个有意义的字符"启发式，足够应付本项目的代码）。 */
function regexAllowed(prev) {
  if (!prev) return true;
  return '([{,;:=!&|?+-*%<>~^'.includes(prev);
}

/** 极简词法扫描：跳过字符串 / 模板串 / 注释 / 正则，只收集花括号位置。
 *
 *  为什么非得跳过正则：app.js:49 有 `.replace(/"/g, '&quot;')`，那个正则里的
 *  `"` 会被朴素扫描器当成字符串开头，后面所有引号配对全部错位，最后的结果
 *  是"每个作用域都等于整个文件"——检查看上去还在跑，其实什么都没查。
 *  这个 bug 不报错、只是静默失效，所以扫描器本身也得写对。 */
function matchBraces(js) {
  const events = [];
  const n = js.length;
  let i = 0, prev = '';
  let lineComment = false, blockComment = false;
  while (i < n) {
    const ch = js[i];
    if (lineComment) { if (ch === '\n') lineComment = false; i++; continue; }
    if (blockComment) {
      if (ch === '*' && js[i + 1] === '/') { blockComment = false; i += 2; } else i++;
      continue;
    }
    if (ch === '/' && js[i + 1] === '/') { lineComment = true; i += 2; continue; }
    if (ch === '/' && js[i + 1] === '*') { blockComment = true; i += 2; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch;
      i++;
      while (i < n) {
        if (js[i] === '\\') { i += 2; continue; }
        if (js[i] === q) { i++; break; }
        i++;
      }
      prev = q;
      continue;
    }
    if (ch === '/' && regexAllowed(prev)) {
      i++;
      let inClass = false;
      while (i < n) {
        const c2 = js[i];
        if (c2 === '\\') { i += 2; continue; }
        if (c2 === '[') inClass = true;
        else if (c2 === ']') inClass = false;
        else if (c2 === '/' && !inClass) { i++; break; }
        else if (c2 === '\n') break;          // 正则不跨行，防跑飞
        i++;
      }
      while (i < n && /[a-z]/.test(js[i])) i++;   // 标志位
      prev = '/';
      continue;
    }
    if (ch === '{' || ch === '}') events.push(i);
    if (!/\s/.test(ch)) prev = ch;
    i++;
  }

  const pairs = [];                            // [开括号位置, 闭括号位置]
  const stack = [];
  for (const pos of events) {
    if (js[pos] === '{') stack.push(pos);
    else { const o = stack.pop(); if (o !== undefined) pairs.push([o, pos]); }
  }
  return pairs;
}

/** idx 所在的**最内层**花括号块。
 *
 *  为什么要按作用域裁剪字段读取：app.js 里 `info` 在 reloadJava 里是
 *  `$('java-info')` 那个 DOM 元素、在 init 里才是 app_info 的返回。全局扫
 *  `info.xxx` 会把 `info.textContent` 也算到结构体上，报出一堆假失败；
 *  反过来若改成"名字出现两次就跳过"，`r`、`settings` 这些正常变量又会被
 *  全部跳过，检查等于白写。按函数体切开，两个毛病都没有。 */
function scopeText(js, idx, pairs) {
  let best = null;
  for (const [o, c] of pairs) {
    if (o < idx && c > idx && (best === null || o > best[0])) best = [o, c];
  }
  return best ? js.slice(best[0], best[1] + 1) : js;
}

/** 变量名 -> [{ cmd, index, keyword }]：`const x = await invoke('cmd'` 或 `x = await invoke('cmd'`
 *
 *  同一变量可能有多处赋值（`settings` 在好几个函数里重取），全部记下来。
 *  只留最后一个会把前面那些函数里读的字段整个漏掉。 */
function parseAssignments(js) {
  const out = new Map();
  const re = /(const|let|var)?\s*(\w+)\s*=\s*await\s+invoke\(\s*'(\w+)'/g;
  let m;
  while ((m = re.exec(js))) {
    if (!out.has(m[2])) out.set(m[2], []);
    out.get(m[2]).push({ cmd: m[3], index: m.index, keyword: m[1] || '' });
  }
  return out;
}

/** 这次赋值所属变量的**绑定作用域**从哪开始算。
 *
 *  - 带 `const/let/var` 的，它自己就是声明 → 用本次赋值的位置。
 *  - 裸赋值 `settings = await invoke(...)`，往回找最近一次
 *    `let settings` 声明；`let settings = null` 在 IIFE 顶层，于是作用域
 *    就是整个文件，其它函数里读的 `settings.mc_dir` 才算数。
 *
 *  为什么不能一律用"本次赋值所在函数"：`settings` 的读取全在
 *  `fillSettingsForm()` / `launch()` 里，那些函数里根本没有 invoke 赋值，
 *  作用域一裁就什么都没了 —— 这一项曾经整段消失过。 */
function bindScopeIndex(js, site, name) {
  if (site.keyword) return site.index;
  const decl = new RegExp('\\b(?:const|let|var)\\s+' + name + '\\b', 'g');
  let last = -1, m;
  while ((m = decl.exec(js))) if (m.index < site.index) last = m.index;
  return last >= 0 ? last : site.index;
}

/** 某个变量被读过的字段（x.foo） */
function fieldsRead(js, varName) {
  const out = new Set();
  const re = new RegExp('\\b' + varName + '\\.([A-Za-z_]\\w*)', 'g');
  let m;
  while ((m = re.exec(js))) out.add(m[1]);
  return out;
}

// ---------------------------------------------------------------- 分析

const SKIP_RET = new Set(['String', 'str', 'bool', 'Vec', 'Option', 'Result',
  'usize', 'isize', 'u8', 'u16', 'u32', 'u64', 'i32', 'i64', 'f32', 'f64',
  'Value', 'JsonValue', 'HashMap', 'BTreeMap']);

// 数组结果：map 回调里的形参名是固定的，这里显式登记
const ELEMENT_VARS = [
  { holder: 'versions', cb: 'v', cmd: 'list_versions' },
  { holder: 'javas', cb: 'j', cmd: 'detect_java' },
  { holder: 'accounts', cb: 'a', cmd: 'accounts_list' },
];

/** 跑完整套核对，返回结果而不是直接打印 —— 这样自检模式能拿同一套逻辑
 *  去跑构造出来的坏样本，验证"该报的确实报得出来"。 */
function analyze(rsText, jsText, jsLabel) {
  const rs = stripRs(rsText);
  const structs = parseStructs(rs);
  const { commands, registered } = parseCommands(rs);
  const pairs = matchBraces(jsText);
  const invokes = parseInvokes(jsText);
  const assigns = parseAssignments(jsText);

  const lines = [];
  let pass = 0, fail = 0;
  const ok = (m) => { lines.push(['ok', m]); pass++; };
  const no = (m) => { lines.push(['FAIL', m]); fail++; };

  lines.push(['head', '=== 命令注册 ===']);
  lines.push(['info', '  Rust 注册 ' + registered.length + ' 条，JS 调用 '
    + new Set(invokes.map((i) => i.cmd)).size + ' 条']);
  for (const cmd of [...new Set(invokes.map((i) => i.cmd))].sort()) {
    if (registered.includes(cmd)) ok(cmd + ' 已注册');
    else no(cmd + ' **没有注册**（generate_handler! 里找不到）');
  }

  lines.push(['head', '=== 入参名（JS camelCase ↔ Rust snake_case）===']);
  const seenArgs = new Set();
  for (const iv of invokes) {
    const c = commands.get(iv.cmd);
    if (!c) { no(iv.cmd + ' 定义解析不到'); continue; }
    // 同一个命令在多处按同样方式调用，只核对一次，免得刷屏
    const sig = iv.cmd + '|' + iv.args.join(',');
    if (seenArgs.has(sig)) continue;
    seenArgs.add(sig);
    const at = iv.cmd + '(' + jsLabel + ':' + iv.line + ')';
    if (iv.nonObject) {
      no(at + ' 第二参不是对象字面量，无法静态核对（Rust 需要 '
        + (c.params.join(', ') || '（无）') + '）');
      continue;
    }
    if (!iv.args.length) {
      if (!c.params.length) ok(at + ' 无参数');
      else no(at + ' 前端没传参，但 Rust 需要 ' + c.params.join(', '));
      continue;
    }
    for (const a of iv.args) {
      const snake = camelToSnake(a);
      if (c.params.includes(snake)) ok(at + ' 的 ' + a + ' → ' + snake);
      else no(at + ' 传了 ' + a + '（推断 ' + snake + '），Rust 入参是 '
        + (c.params.join(', ') || '（无）'));
    }
  }

  lines.push(['head', '=== 返回值字段（最容易静默变 undefined）===']);
  const audited = new Set();
  for (const [varName, sites] of assigns) {
    // 同一个变量名也可能在不同地方接不同命令的返回，按命令分组
    const byCmd = new Map();
    for (const s of sites) {
      if (!byCmd.has(s.cmd)) byCmd.set(s.cmd, []);
      byCmd.get(s.cmd).push(s);
    }
    for (const [cmd, list] of byCmd) {
      const c = commands.get(cmd);
      if (!c || !c.ret) continue;
      const fields = structs.get(c.ret);
      if (!fields) {
        // 返回标量（String / bool / Vec<..>）跳过是正常的；
        // 但"看起来像结构体却没解析到"必须报出来，否则就是检查器自己开的盲区。
        if (/^[A-Z]/.test(c.ret) && !SKIP_RET.has(c.ret)) {
          no(cmd + ' 的返回类型 ' + c.ret + ' 没解析到结构体定义，字段无法核对（盲区）');
        }
        continue;
      }
      audited.add(cmd);
      // 每个赋值点都在它**绑定的**作用域里找字段，再取并集 ——
      // 既不会把同名的 DOM 元素算进来，也不会漏掉其它函数里的读取。
      const used = new Set();
      for (const s of list) {
        const sc = scopeText(jsText, bindScopeIndex(jsText, s, varName), pairs);
        for (const f of fieldsRead(sc, varName)) used.add(f);
      }
      for (const f of used) {
        if (JS_BUILTIN.has(f)) continue;
        if (fields.includes(f)) ok(cmd + ' → ' + varName + '.' + f);
        else no(cmd + ' → ' + varName + '.' + f + ' 在 ' + c.ret + ' 里不存在（可选：'
          + fields.join(', ') + '）');
      }
    }
  }
  lines.push(['info', '  （本轮实际核对了 ' + [...audited].sort().join(', ') + ' 的返回值字段）']);

  lines.push(['head', '=== 数组元素字段 ===']);
  for (const { holder, cb, cmd } of ELEMENT_VARS) {
    const c = commands.get(cmd);
    if (!c) continue;          // 本套数组检查只针对真实项目那三个命令，样本里没有就跳过
    const fields = c && structs.get(c.ret);
    if (!fields) { no(cmd + ' 的返回结构解析不到'); continue; }
    const used = fieldsRead(jsText, cb);
    for (const f of used) {
      if (JS_BUILTIN.has(f)) continue;
      if (fields.includes(f)) ok(holder + ' 元素 ' + cb + '.' + f);
      else no(holder + ' 元素 ' + cb + '.' + f + ' 在 ' + c.ret + ' 里不存在（可选：'
        + fields.join(', ') + '）');
    }
  }

  return { pass, fail, lines };
}

function printResult(r) {
  for (const [kind, text] of r.lines) {
    if (kind === 'head') console.log('\n' + text);
    else if (kind === 'info') console.log(text);
    else console.log('  ' + (kind === 'ok' ? 'ok   ' : 'FAIL ') + text);
  }
  console.log('\n============================');
  console.log('通过 ' + r.pass + ' 项，失败 ' + r.fail + ' 项');
}

// ---------------------------------------------------------------- 自检

/** 这套检查器自己踩过三次"不报错、只是静默失效"：一次是正则吃括号把参数
 *  丢了，一次是只认 `pub struct` 于是私有结构体全被跳过，一次是正则字面量
 *  里的引号把作用域扫描弄崩。所以不能靠"看它打印 ok"来判断它还活着 ——
 *  这里用构造出来的坏样本验证它**确实会报错**。 */
function selftest() {
  const RS_OK = `
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Info { pub ver_num: u8, pub data_dir: String }

#[tauri::command]
fn get_info(extra: Option<String>) -> Result<Info, String> { }

generate_handler![get_info];
`;
  // 样本的 Rust 侧也要写 generate_handler!，否则每条都会额外报"没有注册"
  const reg = (...cmds) => '\ngenerate_handler![' + cmds.join(', ') + '];\n';

  const cases = [
    {
      name: 'camelCase 重命名被认出来，读对了不报错',
      rs: RS_OK,
      js: `invoke('get_info', { extra: null });\nconst x = await invoke('get_info', { extra: null });\nuse(x.verNum);\n`,
      want: 0,
    },
    {
      name: '读错字段名（snake_case 读 camelCase 结构体）要报错',
      rs: RS_OK,
      js: `invoke('get_info', { extra: null });\nconst x = await invoke('get_info', { extra: null });\nuse(x.ver_num);\n`,
      want: 1,
      substr: 'x.ver_num',
    },
    {
      name: '对象字面量简写 { settings } 不能当成没传参',
      rs: `#[tauri::command]\nfn save(settings: String) -> bool { }\n` + reg('save'),
      js: `invoke('save', { settings });\n`,
      want: 0,
    },
    {
      name: '嵌套对象 { diag: f({ ok }) } 不能把参数丢了',
      rs: `#[tauri::command]\nfn ready(diag: String) -> bool { }\n` + reg('ready'),
      js: `invoke('ready', { diag: f({ ok: true, n: 1 }) });\n`,
      want: 0,
    },
    {
      name: '换行断开的调用也要能取到参数',
      rs: `#[tauri::command]\nfn save(settings: String) -> bool { }\n` + reg('save'),
      js: `invoke('save', { settings }\n  ).catch(() => {});\n`,
      want: 0,
    },
    {
      name: '没注册的命令要报错',
      rs: `#[tauri::command]\nfn other() -> bool { }\n\n#[tauri::command]\nfn unregistered() -> bool { }\n`
        + reg('other'),
      js: `invoke('unregistered');\n`,
      want: 1,
      substr: '没有注册',
    },
    {
      name: '名字与其它变量重名时，不能把别的对象的字段算进来',
      rs: `#[derive(serde::Serialize)]\n#[serde(rename_all = "camelCase")]\nstruct J { pub ver_num: u8 }\n\n`
        + `#[tauri::command]\nfn list() -> Result<Vec<J>, String> { }\n` + reg('list'),
      js: `function a() {\n  const list = await invoke('list');\n  return list.length;\n}\n`
        + `function b() {\n  const x = { verNum: 1 };\n  return x.textContent;\n}\n`,
      want: 0,
    },
    {
      // app.js:49 那种 `.replace(/"/g, '&quot;')`，正则里的引号会让朴素扫描器
      // 的引号配对错位，作用域退化成整个文件，于是这里会假报 textContent
      name: '正则字面量里的引号不能弄坏作用域扫描',
      rs: `#[derive(serde::Serialize)]\n#[serde(rename_all = "camelCase")]\nstruct A { pub ver_num: u8 }\n\n`
        + `#[tauri::command]\nfn get_a() -> Result<A, String> { }\n` + reg('get_a'),
      js: `function esc(s) { return s.replace(/"/g, '&quot;'); }\n`
        + `function load() {\n  const a = await invoke('get_a');\n  return a.verNum;\n}\n`
        + `function other() {\n  const a = document.getElementById('x');\n  return a.textContent + a.classList;\n}\n`,
      want: 0,
    },
    {
      name: '私有结构体（无 pub）也要能解析到字段',
      rs: `#[derive(serde::Serialize)]\n#[serde(rename_all = "camelCase")]\nstruct P { pub a_b: u8 }\n\n`
        + `#[tauri::command]\nfn get_p() -> Result<P, String> { }\n` + reg('get_p'),
      js: `const p = await invoke('get_p');\nuse(p.bogus);\n`,
      want: 1,
      substr: 'p.bogus',
    },
    {
      name: '找不到结构体定义必须显式报警，不能静默跳过',
      rs: `#[tauri::command]\nfn get_q() -> Result<Nowhere, String> { }\n` + reg('get_q'),
      js: `const q = await invoke('get_q');\nuse(q.anything);\n`,
      want: 1,
      substr: '盲区',
    },
    {
      // settings 就是这种形状：`let s = null` 在顶层，赋值和使用分散在不同函数
      name: '顶层变量的字段在别的函数里读，也要能核对到',
      rs: `#[derive(serde::Serialize)]\n#[serde(rename_all = "camelCase")]\nstruct S { pub a_b: u8 }\n\n`
        + `#[tauri::command]\nfn get_s() -> Result<S, String> { }\n` + reg('get_s'),
      js: `let s = null;\n`
        + `async function load() {\n  s = await invoke('get_s');\n}\n`
        + `function other() {\n  return s.nope;\n}\n`,
      want: 1,
      substr: 's.nope',
    },
    {
      name: '顶层变量读对了字段就不报错',
      rs: `#[derive(serde::Serialize)]\n#[serde(rename_all = "camelCase")]\nstruct S { pub a_b: u8 }\n\n`
        + `#[tauri::command]\nfn get_s() -> Result<S, String> { }\n` + reg('get_s'),
      js: `let s = null;\n`
        + `async function load() {\n  s = await invoke('get_s');\n}\n`
        + `function other() {\n  return s.aB;\n}\n`,
      want: 0,
    },
  ];

  let bad = 0;
  for (const c of cases) {
    const r = analyze(c.rs, c.js, 'case.js');
    const probs = [];
    if (r.fail !== c.want) probs.push('失败数 ' + r.fail + ' ≠ 预期 ' + c.want);
    if (c.substr && !r.lines.some(([k, m]) => k === 'FAIL' && m.includes(c.substr))) {
      probs.push('没有报出含「' + c.substr + '」的失败');
    }
    if (probs.length) {
      bad++;
      console.log('  FAIL ' + c.name + ' —— ' + probs.join('；'));
      printResult(r);
    } else {
      console.log('  ok   ' + c.name);
    }
  }
  console.log('\n============================');
  console.log('自检 ' + (cases.length - bad) + '/' + cases.length + ' 项通过');
  return bad;
}

// ---------------------------------------------------------------- 跑

if (process.argv.includes('--selftest')) {
  process.exit(selftest() ? 1 : 0);
}

const rsFiles = fs.readdirSync(SRC).filter((f) => f.endsWith('.rs'));
let rsAll = '';
for (const f of rsFiles) rsAll += stripRs(fs.readFileSync(path.join(SRC, f), 'utf8'));
const r = analyze(rsAll, fs.readFileSync(APP_JS, 'utf8'), 'app.js');
printResult(r);
process.exit(r.fail ? 1 : 0);
