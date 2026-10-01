// 合成假资源包 / 光影包，验证 packinfo 的元信息读取与版本匹配判定
const fs = require('fs');
const path = require('path');
const os = require('os');
const pi = require('../packinfo');
const { makeZip, fakePng } = require('./fixtures');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-pack-'));
const rpDir = path.join(tmp, 'resourcepacks');
const spDir = path.join(tmp, 'shaderpacks');
fs.mkdirSync(rpDir, { recursive: true });
fs.mkdirSync(spDir, { recursive: true });

/* ---------- 夹具 ---------- */

// 1) 标准资源包：mcmeta 用文本组件写描述 + pack.png
makeZip(path.join(rpDir, '§x-fancy.zip'), [
  { name: 'pack.mcmeta', data: JSON.stringify({ pack: { pack_format: 12, description: { text: '一个很好看的材质包' } } }) },
  { name: 'pack.png', data: fakePng() },
  { name: 'assets/minecraft/textures/block/stone.png', data: fakePng() }
]);

// 2) 描述是纯字符串、格式偏旧
makeZip(path.join(rpDir, 'old-pack.zip'), [
  { name: 'pack.mcmeta', data: JSON.stringify({ pack: { pack_format: 4, description: '老版本材质' } }) },
  { name: 'pack.png', data: fakePng() }
]);

// 3) 没有 mcmeta（常见于随手打包的 zip）
makeZip(path.join(rpDir, 'broken.zip'), [{ name: 'readme.txt', data: 'hello' }]);

// 4) 未解压的目录形式资源包（很常见）
const dirPack = path.join(rpDir, 'MyUnzippedPack');
fs.mkdirSync(dirPack, { recursive: true });
fs.writeFileSync(path.join(dirPack, 'pack.mcmeta'),
  JSON.stringify({ pack: { pack_format: 15, description: ['未解压的', { text: '材质包' }] } }));
fs.writeFileSync(path.join(dirPack, 'pack.png'), fakePng());

// 5) 正常光影包
makeZip(path.join(spDir, 'cool-shader.zip'), [
  { name: 'shaders/final.fsh', data: 'void main() {}' },
  { name: 'shaders/gbuffers_terrain.vsh', data: 'void main() {}' },
  { name: 'shaders/composite.fsh', data: 'void main() {}' },
  { name: 'shaders/lang/en_US.lang', data: 'x=y' }
]);

// 6) 不是光影包（zip 里没有 shaders/）
makeZip(path.join(spDir, 'not-a-shader.zip'), [{ name: 'foo.txt', data: 'bar' }]);

// 7) 目录形式光影包
const dirShader = path.join(spDir, 'FolderShader');
fs.mkdirSync(path.join(dirShader, 'shaders', 'program'), { recursive: true });
fs.writeFileSync(path.join(dirShader, 'shaders', 'program', 'a.glsl'), 'x');
fs.writeFileSync(path.join(dirShader, 'shaders', 'program', 'b.frag'), 'x');

/* ---------- 断言 ---------- */
let fail = 0;
function check(name, ok, extra) {
  console.log((ok ? '  ok  ' : ' FAIL ') + name + (extra ? ' -> ' + extra : ''));
  if (!ok) fail++;
}

console.log('=== 资源包 ===');
const rps = pi.describePacks([
  path.join(rpDir, '§x-fancy.zip'),
  path.join(rpDir, 'old-pack.zip'),
  path.join(rpDir, 'broken.zip'),
  dirPack
], 'rps');

const a = rps[0], b = rps[1], c = rps[2], d = rps[3];
check('标准包：格式为 12', a.format === 12, String(a.format));
check('标准包：版本区间正确', a.mc === '1.20 – 1.20.1', String(a.mc));
check('标准包：文本组件描述被拍平', a.desc === '一个很好看的材质包', JSON.stringify(a.desc));
check('标准包：读到图标（data URL）', !!a.icon && a.icon.startsWith('data:image/png;base64,'), a.icon && a.icon.slice(0, 30));
check('标准包：ok', a.ok === true);
check('旧包：格式 4 → 1.13 – 1.14.4', b.format === 4 && b.mc === '1.13 – 1.14.4', String(b.mc));
check('旧包：字符串描述', b.desc === '老版本材质', String(b.desc));
check('缺 mcmeta：标记不 ok 并给提示', c.ok === false && !!c.note, String(c.note));
check('缺 mcmeta：图标为空而非崩溃', !c.icon);
check('目录包：识别为目录', d.isDir === true);
check('目录包：格式 15', d.format === 15, String(d.format));
check('目录包：数组描述被拍平', d.desc === '未解压的材质包', JSON.stringify(d.desc));
check('目录包：读到图标', !!d.icon);

console.log('\n=== 光影包 ===');
const sps = pi.describePacks([
  path.join(spDir, 'cool-shader.zip'),
  path.join(spDir, 'not-a-shader.zip'),
  dirShader
], 'shaders');
const s1 = sps[0], s2 = sps[1], s3 = sps[2];
check('zip 光影：数出 3 个着色器（lang 不算）', s1.shaderFiles === 3, String(s1.shaderFiles));
check('zip 光影：ok', s1.ok === true, String(s1.note));
check('非光影：被判为不 ok 且有提示', s2.ok === false && /shaders/.test(s2.note || ''), String(s2.note));
check('目录光影：数出 2 个', s3.shaderFiles === 2, String(s3.shaderFiles));

console.log('\n=== pack_format 匹配判定 ===');
const cases = [
  [12, '1.20.1', true], [12, '1.20', true], [12, '1.19.4', false], [12, '1.21', false],
  [4, '1.14.4', true], [4, '1.15', false],
  [12, '24w14a', null], [12, '', null], [99, '1.20.1', null]
];
for (const [fmt, mc, want] of cases) {
  const got = pi.formatMatches(fmt, mc);
  check(`format ${fmt} vs MC ${mc || '(空)'} = ${want}`, got === want, String(got));
}

console.log('\n=== 容错 ===');
check('不存在的文件不抛异常', (() => {
  const r = pi.describePack(path.join(tmp, 'nope.zip'), 'rps');
  return r.ok === false;
})());
check('mcmeta 是垃圾 JSON 时不抛异常', (() => {
  const p = path.join(rpDir, 'garbage.zip');
  makeZip(p, [{ name: 'pack.mcmeta', data: '{ this is not json' }]);
  const r = pi.describePack(p, 'rps');
  return r.ok === false && !!r.note;
})());
check('带行注释的 mcmeta 也能解析', (() => {
  const p = path.join(rpDir, 'commented.zip');
  makeZip(p, [{ name: 'pack.mcmeta', data: '{\n  // 注释\n  "pack": { "pack_format": 9, "description": "带注释" }\n}' }]);
  const r = pi.describePack(p, 'rps');
  return r.format === 9 && r.desc === '带注释';
})());

console.log('\n' + (fail === 0 ? '★ packinfo 全部通过' : `★ packinfo 有 ${fail} 项失败`));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
