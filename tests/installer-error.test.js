// 安装器输出的解码 / 失败文案。
//
// 事故背景（2026-10-24）：Fabric 安装器在中文 Windows 上按 GBK 往管道里写，
// 启动器一律 buf.toString() 解成 UTF-8，状态栏变成
//   安装失败: 安装器退出码 1 1 ?????????????? at java.base/sun.nio.fs...
// 玩家根本看不出是「文件被占用」还是「网断了」。
const assert = require('assert');
const L = require('../loaders');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log(' FAIL ' + name + ' -> ' + e.message); }
}

t('GBK 字节能解出中文（不再是一串问号）', () => {
  const dec = L.makeStreamDecoder();
  assert.strictEqual(dec(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])), '中文');
});

t('本来就是 UTF-8 的流不会被误解码', () => {
  const dec = L.makeStreamDecoder();
  assert.strictEqual(dec(Buffer.from('正在下载 sponge-mixin 库', 'utf8')), '正在下载 sponge-mixin 库');
});

t('文件被占用的报错翻译成「被占用」', () => {
  const msg = L.humanizeInstallerFailure(1, 'java.nio.file.AccessDeniedException: C:\\x.jar\n另一个程序正在使用此文件');
  assert.ok(/被占用/.test(msg), msg);
  assert.ok(!/java\.nio/.test(msg), '不该把堆栈糊到状态栏: ' + msg);
});

t('网络超时翻译成「下载超时」', () => {
  const msg = L.humanizeInstallerFailure(1, 'Request to https://meta.fabricmc.net/v2/versions/game failed: Timed out after reading 4673 bytes');
  assert.ok(/超时/.test(msg), msg);
});

t('无法归类的失败指路「运行日志」', () => {
  const msg = L.humanizeInstallerFailure(3, 'something odd happened');
  assert.ok(/运行日志/.test(msg), msg);
});

t('loaderCliArgs 仍然存在（Fabric 参数没被改坏）', () => {
  assert.strictEqual(typeof L.loaderCliArgs, 'function');
  const a = L.loaderCliArgs({ loader: 'fabric', jarPath: 'x.jar', mcDir: 'C:\\mc', mcVersion: '1.20.1', version: '0.20.1' });
  assert.ok(a.includes('-noprofile'), a.join(' '));
  assert.ok(a.includes('-mcversion') && a.includes('1.20.1'), a.join(' '));
});

console.log('\n★ 结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
