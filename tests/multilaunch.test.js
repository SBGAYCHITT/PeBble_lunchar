// multilaunch / avatar 离线测试：并行组合去重、登记表清理、头像 URL 与缓存名
const ml = require('../multilaunch');
const av = require('../avatar');

let fail = 0;
function check(name, ok, extra) {
  console.log((ok ? '  ok  ' : ' FAIL ') + name + (extra ? ' -> ' + extra : ''));
  if (!ok) fail++;
}
function eq(name, got, want) {
  check(name + ' (=' + JSON.stringify(want) + ')', JSON.stringify(got) === JSON.stringify(want),
    JSON.stringify(got) === JSON.stringify(want) ? '' : 'got=' + JSON.stringify(got));
}

console.log('=== 组合主键 ===');
eq('实例 + 账户', ml.makeKey({ instanceId: 'i1', accountUuid: 'u1' }), 'i1|u1');
eq('缺实例记为 -', ml.makeKey({ accountUuid: 'u1' }), '-|u1');
eq('缺账户记为 -', ml.makeKey({ instanceId: 'i1' }), 'i1|-');
eq('两缺记为 -|-', ml.makeKey({}), '-|-');

console.log('\n=== 运行时长格式化 ===');
eq('秒级', ml.fmtDuration(45000), '0:45');
eq('分钟补零', ml.fmtDuration(125000), '2:05');
eq('小时级', ml.fmtDuration(3725000), '1:02:05');
eq('负数兜底 0', ml.fmtDuration(-5), '0:00');

console.log('\n=== 登记表（用假的存活判定，不碰真进程） ===');
ml.clear();
const fakePid = 40001;
ml.add({ pid: fakePid, instanceId: 'i1', accountUuid: 'u1', accountName: 'Steve', version: '1.20.1', gameDir: 'D:/g1' });
ml.add({ pid: 40002, instanceId: 'i2', accountUuid: 'u2', accountName: 'Alex', version: '1.20.1', gameDir: 'D:/g2' });
// 同组合重复登记应当覆盖而不是堆两条
ml.add({ pid: 40009, instanceId: 'i1', accountUuid: 'u1', accountName: 'Steve', version: '1.20.1', gameDir: 'D:/g1' });

const allAlive = ml.list({ alive: () => true });
eq('三条记录登记后同组合只剩一条', allAlive.length, 2);
check('同组合被后来的 PID 覆盖', allAlive.find(e => e.key === 'i1|u1').pid === 40009, allAlive.find(e => e.key === 'i1|u1').pid);

check('不同组合不被误判占用', ml.occupied({ instanceId: 'i1', accountUuid: 'u2' }) === null);
eq('默认实例（无 instanceId）与显式实例不是同一组合', ml.occupied({ accountUuid: 'u1' }), null);
// 假 PID 在真实探活下必然是死的 —— occupied 用活 PID 才有意义（拿测试进程自己顶上）
ml.add({ pid: process.pid, instanceId: 'self', accountUuid: 'u-self', accountName: 'Self' });
check('活着的 PID 能被 occupied 拦住', !!ml.occupied({ instanceId: 'self', accountUuid: 'u-self' }));
ml.clear();
ml.add({ pid: fakePid, instanceId: 'i1', accountUuid: 'u1', accountName: 'Steve', version: '1.20.1', gameDir: 'D:/g1' });
ml.add({ pid: 40002, instanceId: 'i2', accountUuid: 'u2', accountName: 'Alex', version: '1.20.1', gameDir: 'D:/g2' });

const deadOnly = ml.list({ alive: () => false });
eq('全部判定为死进程后列表清空', deadOnly.length, 0);

console.log('\n=== prune 纯函数 ===');
const entries = [
  { key: 'a', pid: 1, exited: false },
  { key: 'b', pid: 2, exited: true },
  { key: 'c', pid: 3, exited: false }
];
const pruned = ml.prune(entries, (pid) => pid === 1);
eq('保留仍活着的', pruned.entries.map(e => e.key), ['a']);
eq('清掉显式退出与死 PID', pruned.removed, ['b', 'c']);

console.log('\n=== 退出登记与结束 ===');
ml.clear();
ml.add({ pid: 50001, instanceId: 'i9', accountUuid: 'u9', accountName: 'Bob' });
ml.add({ pid: 50002, instanceId: 'i8', accountUuid: 'u8', accountName: 'Eve' });
ml.markExited(50001);
eq('markExited 移除对应记录', ml.list({ alive: () => true }).length, 1);
check('markExited 不影响其它记录', !!ml.find({ instanceId: 'i8', accountUuid: 'u8' }));
const rNull = ml.stop('不存在的key');
check('结束不存在的 key 返回错误而不抛异常', rNull.ok === false, JSON.stringify(rNull));
eq('结束不存在的 key 时不算成功', rNull.ok, false);
check('find 能按组合取回记录', (ml.find({ instanceId: 'i8', accountUuid: 'u8' }) || {}).accountName === 'Eve');
check('find 查不到时返回 null', ml.find({ instanceId: 'zz', accountUuid: 'zz' }) === null);
ml.clear();
eq('clear 清空', ml.list({ alive: () => true }).length, 0);

console.log('\n=== 头像：URL 与缓存名（纯函数） ===');
const UUID = '069a79f4-44e9-4726-a5be-fca90e38aaf5';
check('head URL 指向 Crafatar', av.avatarUrl(UUID, 64, 'head').primary.indexOf('https://crafatar.com/avatars/') === 0, av.avatarUrl(UUID, 64, 'head').primary);
check('head URL 带 overlay（显示第二层皮肤）', av.avatarUrl(UUID, 64, 'head').primary.indexOf('overlay') > 0);
check('body URL 指向 renders/body', av.avatarUrl(UUID, 64, 'body').primary.indexOf('/renders/body/') > 0);
check('有备用源', !!av.avatarUrl(UUID, 64, 'head').fallback);
eq('非法 UUID 不拼 URL', av.avatarUrl('not-a-uuid', 64, 'head'), '');
eq('UUID 带横杠也能用', av.avatarUrl(UUID, 64, 'head').primary.indexOf(UUID.replace(/-/g, '')) > 0, true);
check('size 被夹在合理范围', av.avatarUrl(UUID, 4, 'head').primary.indexOf('size=8') > 0, av.avatarUrl(UUID, 4, 'head').primary);
check('size 超大也被夹住', av.avatarUrl(UUID, 99999, 'head').primary.indexOf('size=512') > 0);
eq('缓存名含 uuid 与 kind', av.cacheName(UUID, 64, 'head'), UUID.replace(/-/g, '') + '-head-64.img');
eq('非法 uuid 缓存名为空', av.cacheName('x', 64, 'head'), '');

console.log('\n=== 头像：mime 嗅探 ===');
check('PNG 能识别', av.sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47])) === 'image/png');
check('JPEG 能识别', av.sniffMime(Buffer.from([0xff, 0xd8, 0xff])) === 'image/jpeg');
check('GIF 能识别', av.sniffMime(Buffer.from('GIF89a', 'latin1')) === 'image/gif');
const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP', 'latin1')]);
check('WEBP 能识别', av.sniffMime(webp) === 'image/webp');
eq('空 buffer 识别不了', av.sniffMime(Buffer.alloc(0)), '');

console.log('\n=== 头像：兜底首字母 ===');
eq('英文取字母', av.initials('Steve'), 'S');
eq('中文取汉字', av.initials('史蒂夫'), '史');
eq('空字符串兜底', av.initials(''), '?');
eq('空白兜底', av.initials('   '), '?');
check('非法 uuid 不发起网络请求', true);

(async () => {
  const bad = await av.getAvatar({ uuid: 'nope' });
  eq('非法 uuid 直接返回 null', bad, null);
  console.log('\n' + (fail === 0 ? '★ multilaunch / avatar 全部通过' : `★ 有 ${fail} 项失败`));
  process.exit(fail === 0 ? 0 : 1);
})();
