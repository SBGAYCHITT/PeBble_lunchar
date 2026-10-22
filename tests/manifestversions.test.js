// 版本清单挑选的回归测试。
//
// 背景：`get-manifest` 曾经写死 slice(0, 120)，而 Mojang 清单是时间倒序的，
// 于是 1.20.1（第 223 位）永远不会出现在列表里。这类"看起来正常、其实永久缺失"
// 的 bug 不会报错，只能靠断言钉住。

const assert = require('node:assert');
const { pickManifestVersions, MAX_SNAPSHOTS } = require('../manifestversions');

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok    ' + name);
  } catch (e) {
    fail++;
    console.log('  FAIL  ' + name + ' — ' + e.message);
  }
}

console.log('\n=== 版本清单挑选 ===');

/** 造一份"新版本很多"的清单：200 个新 release 在前面，1.20.1 埋在第 201 位 */
function sample() {
  const all = [];
  for (let i = 0; i < 200; i++) {
    all.push({ id: '26.' + (200 - i), type: 'release' });
  }
  all.push({ id: '1.20.1', type: 'release' });
  for (let i = 0; i < 120; i++) {
    all.push({ id: 'snap-' + (120 - i), type: 'snapshot' });
  }
  return all;
}

t('排在第 201 位的 1.20.1 仍然被保留', () => {
  const out = pickManifestVersions(sample());
  assert.ok(out.some((v) => v.id === '1.20.1'), '1.20.1 不在结果里');
});

t('所有正式版一个不少', () => {
  const all = sample();
  const out = pickManifestVersions(all);
  const relIn = all.filter((v) => v.type === 'release').length;
  const relOut = out.filter((v) => v.type === 'release').length;
  assert.strictEqual(relOut, relIn);
});

t('快照最多保留 MAX_SNAPSHOTS 个', () => {
  const out = pickManifestVersions(sample());
  const snaps = out.filter((v) => v.type === 'snapshot').length;
  assert.strictEqual(snaps, MAX_SNAPSHOTS);
  assert.strictEqual(MAX_SNAPSHOTS, 60);
});

t('保持原有先后顺序', () => {
  const out = pickManifestVersions(sample());
  const ids = out.map((v) => v.id);
  assert.strictEqual(ids[0], '26.200');
  assert.ok(ids.indexOf('1.20.1') > 0, '1.20.1 的位置不对');
  // 正式版之后才轮到快照
  const lastRelease = ids.lastIndexOf('1.20.1');
  const firstSnap = ids.findIndex((s) => s.startsWith('snap-'));
  assert.ok(firstSnap > lastRelease, '快照不应排在老正式版前面');
});

t('old_beta / old_alpha 不进列表', () => {
  const out = pickManifestVersions([
    { id: '26.1', type: 'release' },
    { id: 'b1.7.3', type: 'old_beta' },
    { id: 'a1.2.6', type: 'old_alpha' },
  ]);
  assert.deepStrictEqual(
    out.map((v) => v.id),
    ['26.1'],
  );
});

t('空输入 / 脏数据不抛异常', () => {
  assert.deepStrictEqual(pickManifestVersions([]), []);
  assert.deepStrictEqual(pickManifestVersions(null), []);
  assert.deepStrictEqual(pickManifestVersions([null, undefined, { id: 'x' }]), []);
});

t('maxSnapshots 传 0 时只留正式版', () => {
  const out = pickManifestVersions(sample(), 0);
  assert.strictEqual(out.filter((v) => v.type === 'snapshot').length, 0);
  assert.strictEqual(out.filter((v) => v.type === 'release').length, 201);
});

console.log(`\n★ 结果: ${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
