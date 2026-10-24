// 「原版本体是否装齐」的判定契约。
//
// 为什么值得单独测：2026-10-24 玩家（用户本人）踩到了
//   versions/fabric-loader-0.20.1-1.20.1/fabric-loader-0.20.1-1.20.1.json 存在
//   但 versions/1.20.1/1.20.1.jar 不存在的状态 ——
// 列表里看得见、选得中，一启动就「缺少客户端 jar」。
// 判定必须同时看 json **和** jar，只看目录存在就会把半装当装好。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const downloader = require('../downloader');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log(' FAIL ' + name + ' -> ' + e.message); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pebble-base-'));
const vDir = path.join(tmp, 'versions', '1.20.1');
fs.mkdirSync(vDir, { recursive: true });

t('目录都不存在时判为未安装', () => {
  assert.strictEqual(downloader.baseInstalled(tmp, '1.20.1'), false);
});

fs.writeFileSync(path.join(vDir, '1.20.1.json'), '{}');
t('只有 json、没有 jar 时仍判为未安装（半装状态）', () => {
  assert.strictEqual(downloader.baseInstalled(tmp, '1.20.1'), false);
});

fs.writeFileSync(path.join(vDir, '1.20.1.jar'), 'fake');
t('json + jar 都在才判为已安装', () => {
  assert.strictEqual(downloader.baseInstalled(tmp, '1.20.1'), true);
});

(async () => {
  // 已装齐时 ensureInstalled 必须走「跳过」，不能联网重下
  const r = await downloader.ensureInstalled({ mcDir: tmp, versionId: '1.20.1' });
  t('已装齐时 ensureInstalled 直接跳过（不联网、不重下）', () => {
    assert.strictEqual(r.skipped, true);
    assert.strictEqual(r.ok, true);
  });

  t('导出面完整（ipc/versions.js 依赖这两个函数）', () => {
    assert.strictEqual(typeof downloader.baseInstalled, 'function');
    assert.strictEqual(typeof downloader.ensureInstalled, 'function');
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n★ 结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
