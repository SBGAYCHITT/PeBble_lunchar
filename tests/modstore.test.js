// modstore 离线测试：Markdown 安全渲染、HTML 剥离、格式化、哈希
// 联网部分另跑：PL_LIVE=1 node tests/modstore.test.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const ms = require('../modstore');

let fail = 0;
function check(name, ok, extra) {
  console.log((ok ? '  ok  ' : ' FAIL ') + name + (extra ? ' -> ' + extra : ''));
  if (!ok) fail++;
}

console.log('=== Markdown 渲染（安全是重点） ===');
const XSS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<a href="javascript:alert(1)">点我</a>',
  '<iframe src="https://evil"></iframe>',
  '<svg onload=alert(1)>',
  '<body onload=alert(1)>',
  '[恶意链接](javascript:alert(1))',
  '![x](javascript:alert(1))',
  '<div style="background:url(javascript:alert(1))">x</div>'
];
// 白名单之外的标签一律不许出现；事件属性一律不许出现
const ALLOWED = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li',
  'strong', 'em', 'del', 'code', 'pre', 'hr', 'a', 'br']);
function tagsOf(html) {
  return (html.match(/<\/?([a-zA-Z][\w-]*)/g) || []).map((t) => t.replace(/<\/?/, ''));
}
for (const bad of XSS) {
  const out = ms.miniMarkdown(bad);
  const badTags = tagsOf(out).filter((t) => !ALLOWED.has(t.toLowerCase()));
  // 只检查"真标签"里的事件属性；被转义成文本的 &lt;img onerror=... 不算
  const hasEvent = /<[a-zA-Z][\w-]*[^>]*\son[a-z]+\s*=/i.test(out);
  const ok = badTags.length === 0 && !hasEvent;
  check('只输出白名单标签且无事件属性: ' + bad.slice(0, 32), ok,
    ok ? '' : ('多余标签=' + badTags.join(',') + ' 事件属性=' + hasEvent));
}
// 正文里的 URL 只允许 http/https
check('javascript: 链接被丢弃（只留文字）',
  ms.miniMarkdown('[点我](javascript:alert(1))') === '<p>点我</p>',
  ms.miniMarkdown('[点我](javascript:alert(1))'));

const md = ms.miniMarkdown('# 标题\n\n这是 **粗体** 和 *斜体* 和 `代码`。\n\n- 项目一\n- 项目二\n\n[链接](https://example.com)');
check('标题渲染为 h1', md.indexOf('<h1>标题</h1>') >= 0);
check('粗体渲染为 strong', md.indexOf('<strong>粗体</strong>') >= 0);
check('斜体渲染为 em', md.indexOf('<em>斜体</em>') >= 0);
check('行内代码渲染为 code', md.indexOf('<code>代码</code>') >= 0);
check('列表渲染为 ul/li', md.indexOf('<ul>') >= 0 && md.indexOf('<li>项目一</li>') >= 0);
check('安全链接保留为 data-ext', md.indexOf('data-ext="https://example.com"') >= 0);

console.log('\n=== HTML 剥离（CurseForge 描述用） ===');
const h = ms.htmlToText('<p>第一段</p><script>alert(1)</script><ul><li>A</li><li>B</li></ul>');
check('script 内容被去掉', h.indexOf('alert') < 0, h);
check('段落文本保留', h.indexOf('第一段') >= 0, h);
check('列表项转成 - 行', h.indexOf('- A') >= 0 && h.indexOf('- B') >= 0, h);
check('实体被还原', ms.htmlToText('a &amp; b &lt; c') === 'a & b < c', ms.htmlToText('a &amp; b &lt; c'));

console.log('\n=== 格式化 ===');
check('亿级下载量', ms.fmtNum(226446006) === '2.3 亿', ms.fmtNum(226446006));
check('万级下载量', ms.fmtNum(45678) === '4.6 万', ms.fmtNum(45678));
check('小数字原样', ms.fmtNum(123) === '123', ms.fmtNum(123));
check('空值不为 NaN', ms.fmtNum(undefined) === '0', ms.fmtNum(undefined));
check('相对时间：今天', ms.relTime(new Date().toISOString()) === '今天', ms.relTime(new Date().toISOString()));
check('相对时间：40 天前', (() => {
  const d = new Date(Date.now() - 40 * 86400000).toISOString();
  return ms.relTime(d) === '1 个月前';
})());
check('相对时间：垃圾输入', ms.relTime('不是时间') === '');

console.log('\n=== 文件名 / 哈希 ===');
check('非法字符被替换', ms.safeName('a/b:c*d?e"f<g>h|i.jar') === 'a_b_c_d_e_f_g_h_i.jar', ms.safeName('a/b:c*d?e"f<g>h|i.jar'));
check('超长文件名被截断', ms.safeName('x'.repeat(300)).length === 180);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-ms-'));
const f1 = path.join(tmp, 'a.jar');
fs.writeFileSync(f1, Buffer.from('hello'));
check('sha1 与已知值一致', ms.sha1OfFile(f1) === 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d', ms.sha1OfFile(f1));
check('不存在的文件返回空串', ms.sha1OfFile(path.join(tmp, 'nope')) === '');

const lh = ms.localHashes(tmp, ['.jar']);
check('localHashes 收录 sha1', lh.get('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d') === 'a.jar');
check('localHashes 过滤扩展名', ms.localHashes(tmp, ['.zip']).size === 0);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

console.log('\n=== 类型映射 ===');
check('mods → mod / 6', ms.KINDS.mods.mr === 'mod' && ms.KINDS.mods.cf === 6);
check('rps → resourcepack / 12', ms.KINDS.rps.mr === 'resourcepack' && ms.KINDS.rps.cf === 12);
check('shaders → shader / 6552', ms.KINDS.shaders.mr === 'shader' && ms.KINDS.shaders.cf === 6552);

(async () => {
  if (process.env.PL_LIVE !== '1') {
    console.log('\n（跳过联网测试，设 PL_LIVE=1 开启）');
    console.log('\n' + (fail === 0 ? '★ modstore 全部通过' : `★ modstore 有 ${fail} 项失败`));
    process.exit(fail === 0 ? 0 : 1);
  }
  console.log('\n=== 联网：Modrinth ===');
  try {
    const r = await ms.search({ kind: 'mods', query: 'sodium', limit: 3, source: 'modrinth' });
    check('搜到结果', r.items.length > 0, String(r.items.length));
    check('无错误', r.errors.length === 0, r.errors.join(';'));
    const it = r.items[0];
    check('有标题', !!it.title, it.title);
    check('有图标 URL', /^https?:/.test(it.icon), it.icon);
    check('下载量已格式化', !!it.downloadsText, it.downloadsText);
    console.log('  示例:', JSON.stringify({ t: it.title, a: it.author, d: it.downloadsText, l: it.loaders }));

    const d = await ms.details({ source: 'modrinth', id: it.slug });
    check('详情有正文', (d.bodyRaw || '').length > 50, String((d.bodyRaw || '').length));
    check('详情有画廊', Array.isArray(d.gallery));
    const img = d.icon ? await ms.fetchImage(d.icon) : null;
    check('图标能抓成 data URL', !!img && img.startsWith('data:image/'), img ? img.slice(0, 30) : 'null');

    const vs = await ms.versions({ source: 'modrinth', id: it.slug });
    check('版本列表非空', vs.length > 0, String(vs.length));
    const v = vs[0];
    check('版本带文件', !!(v && v.file && v.file.url), v && JSON.stringify(v.file).slice(0, 80));
    check('版本带 sha1', !!(v && v.file && v.file.sha1));
  } catch (e) {
    check('联网搜索', false, e.message);
  }

  console.log('\n=== 联网：CurseForge（无 key 应明确报错而不是静默） ===');
  try {
    const r = await ms.search({ kind: 'mods', query: 'jei', limit: 3, source: 'curseforge' });
    check('无 key 时应报错', r.errors.length > 0, 'items=' + r.items.length);
  } catch (e) {
    check('无 key 时抛出', false, e.message);
  }

  console.log('\n' + (fail === 0 ? '★ modstore 全部通过（含联网）' : `★ modstore 有 ${fail} 项失败`));
  process.exit(fail === 0 ? 0 : 1);
})();
