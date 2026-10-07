// redstone.js 单元测试
//
// 这个模块最容易出的不是"崩"，而是"看着合理但完全不对" ——
// 信号顺序、充能等级、延迟这些地方写错，程序照跑，结果全错。
// 所以测试按「电路行为」组织：搭一个最小电路，验它的时序。
//
// 三条最关键的断言（错了整个模型就没意义）：
//   ① 弱充能不能激活中继器
//   ② 中继器/火把的延时刚好是标称的 tick 数（不多不少）
//   ③ 火把时钟真的在振荡，且孤立火把不会自激抽搐

const rs = require('../redstone');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name); console.log('      ' + (e && e.message)); }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || '断言失败'}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}
function ok(v, msg) { if (!v) throw new Error(msg || '期望为真'); }
function deepEq(a, b, msg) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg || '断言失败'}: 期望 ${sb}，实际 ${sa}`);
}

console.log('redstone.js');

/* ---------- 搭电路的小助手 ---------- */
function build(fn) {
  const c = rs.createCircuit();
  fn(c);
  return c;
}
/** 放一个拉杆并让它立刻通电/断电 */
function lever(c, x, y, facing, on) {
  rs.place(c, x, y, 'lever', { facing: facing || 'e' });
  rs.setProp(c, x, y, { on: on !== false });
  return rs.getCell(c, x, y);
}
const outAt = (c, x, y) => rs.getCell(c, x, y).out;
const litAt = (c, x, y) => rs.getCell(c, x, y).lit;

/* ============================================================
 * 方向与坐标
 * ============================================================ */

t('方向：opposite 两两相反', () => {
  eq(rs.opposite('n'), 's'); eq(rs.opposite('s'), 'n');
  eq(rs.opposite('e'), 'w'); eq(rs.opposite('w'), 'e');
});

t('方向：leftOf / rightOf 互为反', () => {
  for (const d of ['n', 'e', 's', 'w']) {
    eq(rs.opposite(rs.leftOf(d)), rs.rightOf(d), d);
    ok(rs.leftOf(d) !== d && rs.rightOf(d) !== d, d + ' 左右不应等于自身');
  }
});

t('方向：rotateCW 转四次回到原方向', () => {
  for (const d of ['n', 'e', 's', 'w']) {
    let v = d;
    for (let i = 0; i < 4; i++) v = rs.rotateCW(v);
    eq(v, d);
  }
});

t('方向：y 向下 —— north 是 y-1、south 是 y+1', () => {
  eq(rs.DIRS.n.dy, -1);
  eq(rs.DIRS.s.dy, 1);
  eq(rs.DIRS.e.dx, 1);
  eq(rs.DIRS.w.dx, -1);
});

t('坐标：kx / parseKey 往返（含负数）', () => {
  for (const [x, y] of [[0, 0], [5, -3], [-12, 7]]) {
    const p = rs.parseKey(rs.kx(x, y));
    eq(p.x, x); eq(p.y, y);
  }
});

t('坐标：stepKey 按方向移动一位', () => {
  eq(rs.stepKey('2,2', 'n'), '2,1');
  eq(rs.stepKey('2,2', 's'), '2,3');
  eq(rs.stepKey('2,2', 'e'), '3,2');
  eq(rs.stepKey('2,2', 'w'), '1,2');
});

t('MC 朝向 → 本模块方向（z+ 是 south）', () => {
  eq(rs.mcFacing('north'), 'n');
  eq(rs.mcFacing('south'), 's');
  eq(rs.mcFacing('east'), 'e');
  eq(rs.mcFacing('west'), 'w');
  eq(rs.mcFacing('NORTH'), 'n', '大小写不敏感');
});

/* ============================================================
 * 编辑操作
 * ============================================================ */

t('编辑：place / getCell / remove', () => {
  const c = build((cc) => { rs.place(cc, 3, 4, 'wire'); });
  eq(rs.getCell(c, 3, 4).type, 'wire');
  eq(rs.remove(c, 3, 4), true);
  eq(rs.getCell(c, 3, 4), null);
});

t('编辑：place 覆盖同一格', () => {
  const c = build((cc) => { rs.place(cc, 0, 0, 'wire'); rs.place(cc, 0, 0, 'lamp'); });
  eq(rs.getCell(c, 0, 0).type, 'lamp');
  eq(rs.stats(c).total, 1);
});

t('编辑：未知元件抛错', () => {
  let threw = false;
  try { rs.place(rs.createCircuit(), 0, 0, 'nope'); } catch (e) { threw = true; }
  ok(threw);
});

t('编辑：中继器延迟被夹在 1~4', () => {
  const c = build((cc) => { rs.place(cc, 0, 0, 'repeater'); });
  rs.setProp(c, 0, 0, { delay: 9 });
  eq(rs.getCell(c, 0, 0).delay, 4);
  rs.setProp(c, 0, 0, { delay: 0 });
  eq(rs.getCell(c, 0, 0).delay, 1, '0 应被抬到 1（中继器最少 1 tick）');
});

t('编辑：比较器 mode 只认 compare / subtract', () => {
  const c = build((cc) => { rs.place(cc, 0, 0, 'comparator'); });
  rs.setProp(c, 0, 0, { mode: 'subtract' });
  eq(rs.getCell(c, 0, 0).mode, 'subtract');
  rs.setProp(c, 0, 0, { mode: '乱七八糟' });
  eq(rs.getCell(c, 0, 0).mode, 'compare');
});

t('编辑：rotate 顺时针转 90°', () => {
  const c = build((cc) => { rs.place(cc, 0, 0, 'repeater', { facing: 'n' }); });
  rs.rotate(c, 0, 0);
  eq(rs.getCell(c, 0, 0).facing, 'e');
});

t('编辑：setProp facing 忽略非法方向', () => {
  const c = build((cc) => { rs.place(cc, 0, 0, 'repeater', { facing: 'n' }); });
  rs.setProp(c, 0, 0, { facing: 'up' });
  eq(rs.getCell(c, 0, 0).facing, 'n');
});

t('编辑：对空格子 setProp / rotate 返回 false', () => {
  const c = rs.createCircuit();
  eq(rs.setProp(c, 5, 5, { on: true }), false);
  eq(rs.rotate(c, 5, 5), false);
});

/* ============================================================
 * 红石线：衰减与线网
 * ============================================================ */

t('红石线：每走一格衰减 1', () => {
  const c = build((cc) => {
    lever(cc, 0, 0, 'e', true);
    for (let x = 1; x <= 5; x++) rs.place(cc, x, 0, 'wire');
  });
  rs.run(c, 1);
  eq(outAt(c, 1, 0), 15, '紧挨电源的线是满强度');
  eq(outAt(c, 2, 0), 14);
  eq(outAt(c, 3, 0), 13);
  eq(outAt(c, 4, 0), 12);
  eq(outAt(c, 5, 0), 11);
});

/* ---------- settle：跑到静定 ----------
 * UI 上「扳一下开关要立刻看到结果」全靠这个：推进几刻取决于电路里有几级延迟元件，
 * 调用方算不出来。这里把收敛行为和刻数都钉住。 */

t('settle：空电路也要走够 1 刻（0 刻的话新接的线不会通电）', () => {
  const c = rs.createCircuit();
  eq(rs.settle(c), 1, '至少要推进一刻');
  eq(c.tick, 1);
});

t('settle：纯红石线电路 1 刻就静定', () => {
  const c = build((cc) => {
    lever(cc, 0, 0, 'e', true);
    rs.place(cc, 1, 0, 'wire');
    rs.place(cc, 2, 0, 'lamp');
  });
  eq(rs.settle(c), 1, '线是 0 延迟，一刻就够');
  eq(litAt(c, 2, 0), true);
});

t('settle：非门刚好 2 刻（火把 1 tick 延迟 + 传播 1 刻）', () => {
  const c = build((cc) => {
    lever(cc, 0, 1, 'e', false);          // 关着的拉杆
    rs.place(cc, 1, 1, 'block');
    rs.place(cc, 1, 0, 'torch', { facing: 's' });
    rs.place(cc, 1, -1, 'wire');
    rs.place(cc, 2, -1, 'wire');
    rs.place(cc, 3, -1, 'lamp');
  });
  eq(rs.settle(c), 2, '刻数不能多也不能少');
  eq(litAt(c, 3, -1), true, '拉杆关 → 火把亮 → 灯亮');
  // 扳开拉杆后立刻再静定一次，灯应该灭
  rs.setProp(c, 0, 1, { on: true });
  rs.settle(c);
  eq(litAt(c, 3, -1), false, '拉杆开 → 火把灭 → 灯灭');
});

t('settle：4 tick 延迟的中继器要 5 刻才静定（1 刻传播 + 4 刻延迟）', () => {
  const c = build((cc) => {
    lever(cc, 0, 0, 'e', true);
    rs.place(cc, 1, 0, 'repeater', { facing: 'e', delay: 4 });
    rs.place(cc, 2, 0, 'lamp');
  });
  eq(rs.settle(c), 5);
  eq(litAt(c, 2, 0), true);
});

t('settle：振荡电路静定不了，按上限收尾（不卡死）', () => {
  const c = build((cc) => {
    rs.place(cc, 1, 0, 'block');
    rs.place(cc, 1, 1, 'torch', { facing: 'n' });
    rs.place(cc, 2, 1, 'block');
    rs.place(cc, 2, 0, 'torch', { facing: 's' });
  });
  const n = rs.settle(c, 10);
  eq(n, 10, '应跑满上限而不是死循环');
  ok(rs.busy(c), '振荡电路收尾时仍有排队中的元件');
});

t('busy：静定后为 false', () => {
  const c = build((cc) => {
    lever(cc, 0, 0, 'e', true);
    rs.place(cc, 1, 0, 'wire');
  });
  ok(!rs.busy(c), '还没跑过时没有排队');
  rs.settle(c);
  ok(!rs.busy(c), '静定后不该有排队');
});

t('红石线：超过 15 格就收不到信号', () => {
  const c = build((cc) => {
    lever(cc, 0, 0, 'e', true);
    for (let x = 1; x <= 20; x++) rs.place(cc, x, 0, 'wire');
  });
  rs.run(c, 1);
  eq(outAt(c, 15, 0), 1, '第 15 格衰减到 1');
  eq(outAt(c, 16, 0), 0, '第 16 格应完全没信号');
});

t('红石线：断电后整条线归零', () => {
  const c = build((cc) => {
    lever(cc, 0, 0, 'e', true);
    for (let x = 1; x <= 4; x++) rs.place(cc, x, 0, 'wire');
  });
  rs.run(c, 2);
  ok(outAt(c, 3, 0) > 0);
  rs.setProp(c, 0, 0, { on: false });
  rs.run(c, 2);
  eq(outAt(c, 3, 0), 0);
});

t('红石线：两个电源取最强的那支', () => {
  const c = build((cc) => {
    lever(cc, 0, 0, 'e', true);
    for (let x = 1; x <= 8; x++) rs.place(cc, x, 0, 'wire');
    lever(cc, 9, 0, 'w', true); // 远端再来一个电源（放在 9，别盖住线）
  });
  rs.run(c, 1);
  eq(outAt(c, 8, 0), 15, '紧挨右电源应为满强度');
  // (6,0) 从左数要衰减 5 格（10），从右数只衰减 2 格（13）→ 取 13
  eq(outAt(c, 6, 0), 13, '应取两侧最强的一支');
  rs.setProp(c, 9, 0, { on: false });
  rs.run(c, 2);
  eq(outAt(c, 6, 0), 10, '关掉右电源后只剩左边的 10');
});

t('红石线：中间断开的线不会互相供电', () => {
  const c = build((cc) => {
    lever(cc, 0, 0, 'e', true);
    rs.place(cc, 1, 0, 'wire');
    // (2,0) 空着
    rs.place(cc, 3, 0, 'wire');
  });
  rs.run(c, 2);
  eq(outAt(c, 1, 0), 15);
  eq(outAt(c, 3, 0), 0, '断开的线不应收到信号');
});

/* ============================================================
 * 中继器
 * ============================================================ */

t('中继器：把衰减的信号恢复成满强度，且不倒灌回输入端', () => {
  const c = build((cc) => {
    lever(cc, 0, 0, 'e', true);
    for (let x = 1; x <= 5; x++) rs.place(cc, x, 0, 'wire');
    rs.place(cc, 6, 0, 'repeater', { facing: 'e' });
    for (let x = 7; x <= 9; x++) rs.place(cc, x, 0, 'wire');
  });
  rs.run(c, 4);
  eq(outAt(c, 5, 0), 11, '中继器前衰减到 11');
  eq(outAt(c, 7, 0), 15, '中继器后应恢复满强度');
  eq(outAt(c, 9, 0), 13);
});

t('中继器：输出不会从输出侧倒灌回输入侧（定向输出）', () => {
  const c = build((cc) => {
    // 输入线只接电源、后面接一个被隔离的中继器
    lever(cc, 0, 0, 'e', true);
    rs.place(cc, 1, 0, 'wire');       // 这条线只有 15-0=15
    rs.place(cc, 2, 0, 'repeater', { facing: 'e' });
    rs.place(cc, 3, 0, 'wire');       // 中继器输出侧
  });
  rs.run(c, 4);
  eq(outAt(c, 1, 0), 15, '输入侧的线应保持自己的强度');
  eq(outAt(c, 3, 0), 15, '输出侧由中继器供满');
});

t('中继器：延时 1 tick（第 1 tick 不输出，第 2 tick 才输出）', () => {
  const c = build((cc) => {
    lever(cc, 0, 0, 'e', true);
    rs.place(cc, 1, 0, 'repeater', { facing: 'e', delay: 1 });
    rs.place(cc, 2, 0, 'lamp');
  });
  rs.run(c, 1);
  eq(outAt(c, 1, 0), 0, '第 1 tick 中继器还没输出');
  eq(litAt(c, 2, 0), false);
  rs.run(c, 1);
  eq(outAt(c, 1, 0), 15, '第 2 tick 输出');
  eq(litAt(c, 2, 0), true, '灯应同步亮起');
});

t('中继器：4 tick 延迟要等满 4 个 tick', () => {
  const c = build((cc) => {
    lever(cc, 0, 0, 'e', true);
    rs.place(cc, 1, 0, 'repeater', { facing: 'e', delay: 4 });
  });
  // 第 1 tick 是"输入出现"的那一 tick —— 它只做排队，不输出
  for (let i = 1; i <= 4; i++) {
    rs.run(c, 1);
    eq(outAt(c, 1, 0), 0, `第 ${i} tick 不该输出`);
  }
  rs.run(c, 1);
  eq(outAt(c, 1, 0), 15, '延迟 4 tick → 第 5 tick 才输出');
});

t('中继器：只向 facing 方向输出，侧后方收不到', () => {
  const c = build((cc) => {
    lever(cc, 0, 0, 'e', true);
    rs.place(cc, 1, 0, 'repeater', { facing: 'e' });
    rs.place(cc, 1, 1, 'lamp');   // 在侧后方
  });
  rs.run(c, 4);
  eq(litAt(c, 1, 1), false, '侧后方的灯不应亮');
});

t('中继器：侧面的另一个中继器会把它锁存', () => {
  const c = build((cc) => {
    // 主链：lever → wire → repeater(2,1) facing e
    lever(cc, 0, 1, 'e', true);
    rs.place(cc, 1, 1, 'wire');
    rs.place(cc, 2, 1, 'repeater', { facing: 'e' });
    // 锁存器：repeater(2,0) facing s，指着主中继器
    lever(cc, 2, -1, 's', false);
    rs.place(cc, 2, 0, 'repeater', { facing: 's' });
  });
  rs.run(c, 3);
  eq(outAt(c, 2, 1), 15, '先正常输出');
  // 打开锁存器
  rs.setProp(c, 2, -1, { on: true });
  rs.run(c, 3);
  ok(rs.getCell(c, 2, 1).locked, '主中继器应处于锁存状态');
  // 断开主链输入，锁存后输出应保持
  rs.setProp(c, 0, 1, { on: false });
  rs.run(c, 4);
  eq(outAt(c, 2, 1), 15, '被锁存时输入断开，输出应保持');
});

/* ============================================================
 * 强充能 vs 弱充能（最关键的一条规则）
 * ============================================================ */

t('充能：红石线只能给方块**弱充能**', () => {
  const c = build((cc) => {
    lever(cc, 0, 0, 'e', true);
    rs.place(cc, 1, 0, 'wire');
    rs.place(cc, 2, 0, 'block');
  });
  rs.run(c, 2);
  eq(rs.weakPower(c, '2,0'), 15, '方块应被弱充能');
  eq(rs.strongPower(c, '2,0'), 0, '但不该被强充能');
});

t('充能：★ 弱充能不能激活中继器（经典考点）', () => {
  const c = build((cc) => {
    lever(cc, 0, 0, 'e', true);
    rs.place(cc, 1, 0, 'wire');
    rs.place(cc, 2, 0, 'block');           // 中间隔一个被弱充能的方块
    rs.place(cc, 3, 0, 'repeater', { facing: 'e' });
  });
  rs.run(c, 8);
  eq(rs.weakPower(c, '2,0'), 15, '方块确实被充能了');
  eq(outAt(c, 3, 0), 0, '中继器仍不该被激活');
});

t('充能：★ 红石线直连中继器就能激活', () => {
  const c = build((cc) => {
    lever(cc, 0, 0, 'e', true);
    rs.place(cc, 1, 0, 'wire');
    rs.place(cc, 2, 0, 'repeater', { facing: 'e' });
  });
  rs.run(c, 4);
  eq(outAt(c, 2, 0), 15, '直连时应当激活');
});

t('充能：拉杆能给相邻方块强充能', () => {
  const c = build((cc) => { lever(cc, 0, 0, 'e', true); rs.place(cc, 1, 0, 'block'); });
  rs.run(c, 2);
  eq(rs.strongPower(c, '1,0'), 15);
});

t('充能：中继器输出正对的方块被强充能', () => {
  const c = build((cc) => {
    lever(cc, 0, 0, 'e', true);
    rs.place(cc, 1, 0, 'repeater', { facing: 'e' });
    rs.place(cc, 2, 0, 'block');
  });
  rs.run(c, 4);
  eq(rs.strongPower(c, '2,0'), 15);
});

t('充能：中继器**背后**的方块不会被它充能', () => {
  const c = build((cc) => {
    lever(cc, 0, 0, 'e', true);
    rs.place(cc, 1, 0, 'block');   // 中继器背后
    rs.place(cc, 2, 0, 'repeater', { facing: 'e' });
  });
  rs.run(c, 5);
  eq(rs.strongPower(c, '1,0'), 15, '它被拉杆强充能（来自 lever）');
  // 这个方块同时也是中继器的输入侧，但不是中继器给它充能 —— 换个位置验
  const c2 = build((cc) => {
    lever(cc, 0, 0, 'e', true);
    rs.place(cc, 1, 0, 'wire');
    rs.place(cc, 2, 0, 'repeater', { facing: 'e' });
    rs.place(cc, 3, 1, 'block');   // 侧后方
  });
  rs.run(c2, 5);
  eq(rs.strongPower(c2, '3,1'), 0, '侧后方的方块不该被强充能');
});

/* ============================================================
 * 比较器
 * ============================================================ */

t('比较器：compare 模式 —— 后侧 ≥ 两侧时输出后侧', () => {
  const c = build((cc) => {
    lever(cc, 0, 0, 'e', true);
    rs.place(cc, 1, 0, 'comparator', { facing: 'e', mode: 'compare' });
    lever(cc, 1, -1, 'e', true);   // 侧输入（左）
  });
  rs.run(c, 4);
  eq(outAt(c, 1, 0), 15, '15 >= 15 → 输出 15');
});

t('比较器：compare 模式 —— 后侧 < 两侧时输出 0', () => {
  const c = build((cc) => {
    // 后侧只有 10（经过衰减的线），侧输入 15
    lever(cc, 0, 0, 'e', true);
    for (let x = 1; x <= 6; x++) rs.place(cc, x, 0, 'wire');
    rs.place(cc, 7, 0, 'comparator', { facing: 'e', mode: 'compare' });
    lever(cc, 7, -1, 'e', true);
  });
  rs.run(c, 4);
  eq(outAt(c, 6, 0), 10, '后侧强度应为 10');
  eq(outAt(c, 7, 0), 0, '10 < 15 → 输出 0');
});

t('比较器：subtract 模式 = 后侧 − 两侧较大者', () => {
  const c = build((cc) => {
    lever(cc, 0, 0, 'e', true);
    // 后侧 15，侧输入用一条衰减到 7 的线
    for (let x = 1; x <= 8; x++) rs.place(cc, x, 0, 'wire');
    // 造一条独立侧输入：从远处喂，使强度为 7
    rs.place(cc, 1, 0, 'comparator', { facing: 'e', mode: 'subtract' });
  });
  // 直接验数学：手搭一个后侧 15、侧 0 的减法
  const c2 = build((cc) => {
    lever(cc, 0, 0, 'e', true);
    rs.place(cc, 1, 0, 'comparator', { facing: 'e', mode: 'subtract' });
  });
  rs.run(c2, 4);
  eq(outAt(c2, 1, 0), 15, '15 - 0 = 15');

  const c3 = build((cc) => {
    lever(cc, 0, 0, 'e', true);
    rs.place(cc, 1, 0, 'comparator', { facing: 'e', mode: 'subtract' });
    lever(cc, 1, -1, 'e', true);  // 侧 15
  });
  rs.run(c3, 4);
  eq(outAt(c3, 1, 0), 0, '15 - 15 = 0');
});

t('比较器：侧输入取左右两边较大者', () => {
  const c = build((cc) => {
    lever(cc, 0, 0, 'e', true);
    rs.place(cc, 1, 0, 'comparator', { facing: 'e', mode: 'compare' });
    // 左边不接，右边接一个 15
    lever(cc, 1, 1, 'e', true);
  });
  rs.run(c, 4);
  eq(outAt(c, 1, 0), 15, '右边有 15 也应该算进 side');
});

/* ============================================================
 * 红石火把
 * ============================================================ */

t('火把：没有输入时点亮', () => {
  const c = build((cc) => {
    rs.place(cc, 1, 0, 'block');
    rs.place(cc, 0, 0, 'torch', { facing: 'e' });
  });
  rs.run(c, 4);
  eq(outAt(c, 0, 0), 15);
});

t('火把：附着方块被充能时熄灭（反相）', () => {
  const c = build((cc) => {
    rs.place(cc, 1, 0, 'block');
    rs.place(cc, 0, 0, 'torch', { facing: 'e' });
    lever(cc, 2, 0, 'w', true);   // 给那个方块强充能
  });
  rs.run(c, 4);
  eq(rs.strongPower(c, '1,0'), 15, '方块确实被充能了');
  eq(outAt(c, 0, 0), 0, '火把应熄灭');
});

t('火把：★ 孤立的火把稳定点亮（不会因自充能而抽搐）', () => {
  const c = build((cc) => {
    rs.place(cc, 1, 0, 'block');
    rs.place(cc, 0, 0, 'torch', { facing: 'e' });
  });
  rs.run(c, 6);
  const vals = [];
  for (let i = 0; i < 5; i++) { rs.step(c); vals.push(outAt(c, 0, 0)); }
  ok(vals.every((v) => v === 15), '应稳定在 15，实际: ' + vals.join(','));
});

t('火把：给相邻的红石线供电', () => {
  const c = build((cc) => {
    rs.place(cc, 1, 0, 'block');
    rs.place(cc, 0, 0, 'torch', { facing: 'e' });
    rs.place(cc, 0, 1, 'wire');
  });
  rs.run(c, 4);
  eq(outAt(c, 0, 1), 15);
});

t('火把：★ 火把时钟持续振荡（不会停住）', () => {
  //  B1(1,0)  T2(2,0)
  //  T1(1,1)  B2(2,1)
  // 各附着另一侧的方块，互相反相 → 信号来回翻
  const c = build((cc) => {
    rs.place(cc, 1, 0, 'block');
    rs.place(cc, 1, 1, 'torch', { facing: 'n' });
    rs.place(cc, 2, 1, 'block');
    rs.place(cc, 2, 0, 'torch', { facing: 's' });
  });
  rs.run(c, 2);
  const seq = [];
  for (let i = 0; i < 8; i++) { rs.step(c); seq.push(outAt(c, 1, 1)); }
  const uniq = new Set(seq);
  eq(uniq.size, 2, '应在 0/15 两个值之间翻，实际: ' + [...uniq].join(','));
  for (let i = 1; i < seq.length; i++) {
    ok(seq[i] !== seq[i - 1], `第 ${i} 个采样没翻转（说明停住了）：` + seq.join(','));
  }
});

t('火把：延时 1 tick', () => {
  const c = build((cc) => {
    rs.place(cc, 1, 0, 'block');
    rs.place(cc, 0, 0, 'torch', { facing: 'e' });
  });
  rs.run(c, 1);
  eq(outAt(c, 0, 0), 0, '第 1 tick 还没点亮');
  rs.run(c, 1);
  eq(outAt(c, 0, 0), 15, '第 2 tick 才亮');
});

/* ============================================================
 * 红石灯与电源
 * ============================================================ */

t('灯：拉杆直连即时点亮', () => {
  const c = build((cc) => { lever(cc, 0, 0, 'e', true); rs.place(cc, 1, 0, 'lamp'); });
  rs.run(c, 1);
  eq(litAt(c, 1, 0), true);
});

t('灯：拉杆关闭后熄灭', () => {
  const c = build((cc) => { lever(cc, 0, 0, 'e', true); rs.place(cc, 1, 0, 'lamp'); });
  rs.run(c, 2);
  rs.setProp(c, 0, 0, { on: false });
  rs.run(c, 2);
  eq(litAt(c, 1, 0), false);
});

t('灯：被衰减过的线点亮（强度 1 也够）', () => {
  const c = build((cc) => {
    lever(cc, 0, 0, 'e', true);
    for (let x = 1; x <= 15; x++) rs.place(cc, x, 0, 'wire');
    rs.place(cc, 16, 0, 'lamp');
  });
  rs.run(c, 2);
  eq(outAt(c, 15, 0), 1, '线末端强度 1');
  eq(litAt(c, 16, 0), true, '强度 1 也应点亮');
});

t('灯：放到衰减不到的位置就不亮', () => {
  const c = build((cc) => {
    lever(cc, 0, 0, 'e', true);
    for (let x = 1; x <= 16; x++) rs.place(cc, x, 0, 'wire');
    rs.place(cc, 17, 0, 'lamp');
  });
  rs.run(c, 2);
  eq(litAt(c, 17, 0), false);
});

t('按钮 / 压力板：按下时输出 15', () => {
  const c = build((cc) => { rs.place(cc, 0, 0, 'button'); rs.place(cc, 1, 0, 'lamp'); });
  rs.run(c, 2);
  eq(litAt(c, 1, 0), false);
  rs.setProp(c, 0, 0, { on: true });
  rs.run(c, 2);
  eq(litAt(c, 1, 0), true);
});

t('拉杆：开关立刻生效，不等延迟', () => {
  const c = build((cc) => { rs.place(cc, 0, 0, 'lever', { facing: 'e' }); rs.place(cc, 1, 0, 'wire'); });
  rs.run(c, 1);
  eq(outAt(c, 1, 0), 0, '没打开时无线号');
  rs.setProp(c, 0, 0, { on: true });
  rs.run(c, 1);
  eq(outAt(c, 1, 0), 15, '打开后 1 tick 内就通电');
});

t('实心块：本身不输出信号', () => {
  const c = build((cc) => { rs.place(cc, 0, 0, 'block'); });
  rs.run(c, 2);
  eq(outAt(c, 0, 0), 0);
});

/* ============================================================
 * 同步推进（顺序无关）
 * ============================================================ */

t('★ 同步推进：元件插入顺序不改变结果', () => {
  const make = (reverse) => {
    const c = rs.createCircuit();
    const items = [
      ['lever', 0, 0, { facing: 'e', on: true }],
      ['wire', 1, 0, null],
      ['wire', 2, 0, null],
      ['repeater', 3, 0, { facing: 'e' }],
      ['lamp', 4, 0, null]
    ];
    const list = reverse ? items.slice().reverse() : items;
    for (const item of list) {
      const [type, x, y, patch] = item;
      rs.place(c, x, y, type, patch || {});
      if (type === 'lever') rs.setProp(c, x, y, { on: true });
    }
    rs.run(c, 6);
    return [outAt(c, 3, 0), rs.valueOf(rs.getCell(c, 4, 0))];
  };
  const a = make(false), b = make(true);
  deepEq(a, [15, 15], '先确认电路本身是通的');
  deepEq(a, b, '插入顺序不应影响结果');
});

t('同步推进：链式传播要按 tick 逐级推进，不是一 tick 内穿透', () => {
  const c = build((cc) => {
    lever(cc, 0, 0, 'e', true);
    rs.place(cc, 1, 0, 'repeater', { facing: 'e' });
    rs.place(cc, 2, 0, 'repeater', { facing: 'e' });
    rs.place(cc, 3, 0, 'repeater', { facing: 'e' });
  });
  rs.run(c, 1);
  deepEq([outAt(c, 1, 0), outAt(c, 2, 0), outAt(c, 3, 0)], [0, 0, 0], '第 1 tick 全都没输出');
  rs.run(c, 1);
  deepEq([outAt(c, 1, 0), outAt(c, 2, 0), outAt(c, 3, 0)], [15, 0, 0], '第 2 tick 只到第 1 级');
  rs.run(c, 1);
  deepEq([outAt(c, 1, 0), outAt(c, 2, 0), outAt(c, 3, 0)], [15, 15, 0], '第 3 tick 到第 2 级');
  rs.run(c, 1);
  deepEq([outAt(c, 1, 0), outAt(c, 2, 0), outAt(c, 3, 0)], [15, 15, 15], '第 4 tick 全通');
});

/* ============================================================
 * 探针、波形、重置
 * ============================================================ */

t('探针：记录波形，并能算翻转次数', () => {
  const c = build((cc) => { lever(cc, 0, 0, 'e', true); rs.place(cc, 1, 0, 'lamp'); });
  eq(rs.probe(c, 1, 0), true);
  rs.run(c, 3);
  const w = rs.waveform(c, 1, 0);
  eq(w.ok, true);
  eq(w.samples.length, 3);
  eq(w.type, 'lamp');
  eq(w.max, 15);
});

t('探针：对空格子返回 false / ok:false', () => {
  const c = rs.createCircuit();
  eq(rs.probe(c, 9, 9), false);
  eq(rs.waveform(c, 9, 9).ok, false);
});

t('探针：可以取消', () => {
  const c = build((cc) => { rs.place(cc, 0, 0, 'wire'); });
  rs.probe(c, 0, 0);
  eq(rs.stats(c).probes, 1);
  eq(rs.unprobe(c, 0, 0), true);
  eq(rs.stats(c).probes, 0);
});

t('波形：能反映出振荡（翻转次数 > 0）', () => {
  const c = build((cc) => {
    rs.place(cc, 1, 0, 'block');
    rs.place(cc, 1, 1, 'torch', { facing: 'n' });
    rs.place(cc, 2, 1, 'block');
    rs.place(cc, 2, 0, 'torch', { facing: 's' });
  });
  rs.probe(c, 1, 1);
  rs.run(c, 8);
  const w = rs.waveform(c, 1, 1);
  ok(w.changes > 2, '应有多次翻转，实际 ' + w.changes);
});

t('重置：清掉运行状态但保留布局', () => {
  const c = build((cc) => {
    lever(cc, 0, 0, 'e', true);
    for (let x = 1; x <= 4; x++) rs.place(cc, x, 0, 'wire');
    rs.place(cc, 5, 0, 'repeater', { facing: 'e' });
  });
  rs.run(c, 5);
  ok(outAt(c, 2, 0) > 0);
  rs.reset(c);
  eq(rs.stats(c).total, 6, '布局应保留');
  eq(outAt(c, 5, 0), 0, '中继器状态被清');
  eq(rs.stats(c).tick, 0);
});

t('重置：拉杆保持用户拨的位置（不会偷偷关掉）', () => {
  const c = build((cc) => { lever(cc, 0, 0, 'e', true); rs.place(cc, 1, 0, 'wire'); });
  rs.run(c, 3);
  ok(outAt(c, 1, 0) > 0);
  rs.reset(c);
  eq(rs.getCell(c, 0, 0).on, true);
  eq(outAt(c, 1, 0), 15, '重置后线网应立即按当前拉杆位置重算');
});

/* ============================================================
 * 快照与统计
 * ============================================================ */

t('快照：包含坐标、类型、朝向与状态', () => {
  const c = build((cc) => {
    lever(cc, 2, 3, 'e', true);
    rs.place(cc, 3, 3, 'wire');
  });
  rs.run(c, 2);
  const snap = rs.snapshot(c);
  eq(snap.count, 2);
  eq(snap.tick, 2);
  const w = snap.cells.find((s) => s.type === 'wire');
  eq(w.x, 3); eq(w.y, 3); eq(w.out, 15);
  ok(typeof w.zh === 'string' && w.zh.length > 0, '应带中文名给 UI');
});

t('统计：按类型计数', () => {
  const c = build((cc) => {
    rs.place(cc, 0, 0, 'wire');
    rs.place(cc, 1, 0, 'wire');
    rs.place(cc, 2, 0, 'lamp');
  });
  const s = rs.stats(c);
  eq(s.total, 3);
  eq(s.byType.wire, 2);
  eq(s.byType.lamp, 1);
});

t('文本导出：每个元件一个字符', () => {
  const c = build((cc) => {
    lever(cc, 0, 0, 'e', true);
    rs.place(cc, 1, 0, 'wire');
    rs.place(cc, 2, 0, 'repeater', { facing: 'e' });
    rs.place(cc, 3, 0, 'lamp');
  });
  const art = rs.toAscii(c);
  eq(art, 'L.RO', 'L=拉杆 .=线 R=中继器 O=灯');
});

t('文本导出：负坐标不能被切掉（旧行为从 (0,0) 起画，y<0 那半边整行消失）', () => {
  const c = build((cc) => {
    // 一个纵向的 3 行电路：顶层 y=-1、中层 y=0、底层 y=1
    lever(cc, 0, 0, 'e', true);
    rs.place(cc, 1, 0, 'wire');
    rs.place(cc, 0, -1, 'torch', { facing: 's' });
    rs.place(cc, 0, 1, 'lamp');
  });
  eq(rs.toAscii(c), 'T\nL.\nO', '三行都要在；负数侧整体平移而不是丢弃');
});

/* ============================================================
 * 存档导入
 * ============================================================ */

t('方块映射：红石线', () => {
  eq(rs.blockToPart('minecraft:redstone_wire', {}).type, 'wire');
});

t('方块映射：中继器带朝向与延迟', () => {
  const p = rs.blockToPart('minecraft:repeater', { facing: 'east', delay: '3' });
  eq(p.type, 'repeater'); eq(p.facing, 'e'); eq(p.delay, 3);
});

t('方块映射：比较器带模式', () => {
  const p = rs.blockToPart('minecraft:comparator', { facing: 'north', mode: 'subtract' });
  eq(p.type, 'comparator'); eq(p.facing, 'n'); eq(p.mode, 'subtract');
});

t('方块映射：立式火把附着在下方', () => {
  eq(rs.blockToPart('minecraft:redstone_torch', {}).facing, 's');
});

t('方块映射：墙式火把的附着位置在朝向的**反方向**', () => {
  // MC 的 wall_torch facing 指火把背离墙的方向，所以附着位置在反侧
  eq(rs.blockToPart('minecraft:redstone_wall_torch', { facing: 'north' }).facing, 's');
  eq(rs.blockToPart('minecraft:redstone_wall_torch', { facing: 'south' }).facing, 'n');
});

t('方块映射：拉杆带开关状态', () => {
  const p = rs.blockToPart('minecraft:lever', { facing: 'west', powered: 'true' });
  eq(p.type, 'lever'); eq(p.facing, 'w'); eq(p.on, true);
  eq(rs.blockToPart('minecraft:lever', { powered: 'false' }).on, false);
});

t('方块映射：各种按钮和压力板', () => {
  eq(rs.blockToPart('minecraft:oak_button', {}).type, 'button');
  eq(rs.blockToPart('minecraft:stone_button', {}).type, 'button');
  eq(rs.blockToPart('minecraft:stone_pressure_plate', {}).type, 'plate');
  eq(rs.blockToPart('minecraft:light_weighted_pressure_plate', {}).type, 'plate');
});

t('方块映射：红石灯读 lit', () => {
  const p = rs.blockToPart('minecraft:redstone_lamp', { lit: 'true' });
  eq(p.type, 'lamp'); eq(p.on, true);
});

t('方块映射：空气被标记跳过', () => {
  eq(rs.blockToPart('minecraft:air', {}).skipped, true);
  eq(rs.blockToPart('minecraft:cave_air', {}).skipped, true);
});

t('方块映射：认不出的当实心块（对红石电路来说是合理近似）', () => {
  eq(rs.blockToPart('minecraft:stone', {}).type, 'block');
  eq(rs.blockToPart('minecraft:oak_planks', {}).type, 'block');
  eq(rs.blockToPart('', {}).type, 'block');
});

t('区块解码：单色 section（palette 长度 1，无 data 数组）', () => {
  const sections = [{ Y: 0, block_states: { palette: [{ Name: 'minecraft:stone' }] } }];
  const layer = rs.decodeSectionAtY(sections, 5);
  ok(!!layer, '应解出这一层');
  eq(layer.length, 256);
  eq(layer[0].Name, 'minecraft:stone');
  eq(layer[255].Name, 'minecraft:stone');
});

t('区块解码：多色 section 按索引取对应方块', () => {
  // palette 长度 2 → bits = max(4, 32-clz32(1)) = 4，每 long 装 16 个值
  const data = new Array(256).fill(0n);
  data[0] = 1n; // 索引 0 指向 palette[1] = stone
  const sections = [{
    Y: 0,
    block_states: {
      palette: [{ Name: 'minecraft:air' }, { Name: 'minecraft:stone' }],
      data
    }
  }];
  const layer = rs.decodeSectionAtY(sections, 0);
  eq(layer[0].Name, 'minecraft:stone', '(x=0,z=0) 应为石头');
  eq(layer[1].Name, 'minecraft:air', '(x=1,z=0) 应为空气');
});

t('区块解码：Y 对不上时返回 null', () => {
  const sections = [{ Y: 0, block_states: { palette: [{ Name: 'minecraft:stone' }] } }];
  eq(rs.decodeSectionAtY(sections, 40), null, 'Y=40 属于 section 2，不存在');
  eq(rs.decodeSectionAtY([], 0), null);
  eq(rs.decodeSectionAtY(null, 0), null);
});

t('区块解码：兼容 1.13/1.14 的 Palette / BlockStates 字段名', () => {
  const sections = [{ Y: 0, Palette: [{ Name: 'minecraft:redstone_wire' }], BlockStates: [] }];
  const layer = rs.decodeSectionAtY(sections, 3);
  ok(!!layer);
  eq(layer[7].Name, 'minecraft:redstone_wire');
});

t('打包索引：packedIndex 能跨 long 取值', () => {
  // bits=4：索引 16 落在第二个 long 的第 0 位
  const data = [0n, 5n];
  eq(rs.packedIndex(data, 0, 4), 0);
  eq(rs.packedIndex(data, 16, 4), 5);
});

/* ============================================================
 * 收尾
 * ============================================================ */

console.log('');
console.log(`redstone：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
