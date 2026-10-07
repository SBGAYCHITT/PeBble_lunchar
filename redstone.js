// Pebble Lunchar - 红石电路模拟内核（生产模块，纯本地）
//
// 定位：在启动器里搭红石电路、逐 tick 看信号怎么走，也能**从存档里导入**
//   现成电路来分析。纯计算，不碰游戏、不联网。
//
// 关于「做得像不像 MC」——先说清楚边界，免得失望：
//   这是**教学/分析向**的简化模型，不是 MC 的逐行复刻。保留的是让人看懂电路
//   必需的规则（信号衰减、火把反相、中继器延时、比较器比较、强/弱充能之分），
//   省略的是活塞推动、侦测器、准连接、0-tick 这类与方块更新顺序强绑定的行为。
//   所以：**它能把电路讲明白，不能当"电路能不能用"的最终裁决**。
//
// 三个必须踩对的点（错了会得到"看着合理但完全不对"的结果）：
//   ① **同步推进**：同一 tick 内所有元件都读到*上一 tick*的输出。
//      图省事写成"边遍历边更新"，结果会随格子遍历顺序变化 ——
//      同一张电路换个位置放就行为不同，而且加一个无关方块就能改变结果。
//   ② **弱充能不能激活中继器**：红石线只能让方块「弱充能」，
//      中继器/比较器只认「强充能」和直连信号。这条是红石教学里的经典考点，
//      漏了它，所有「线直接怼中继器」的电路都会表现错误。
//   ③ **火把环必须能振荡**：两个火把互相反相要能交替闪烁。
//      这靠的是给火把 1 tick 延迟；延迟写成 0 会立刻死循环（信号在同 tick 内来回传）。
//
// 坐标约定：x 向右、y **向下**（屏幕坐标），单位是方块。
//   MC 的 z 轴映射到这里的 y —— 所以 north = y-1、south = y+1。

'use strict';

const anvil = require('./anvil');
const nbt = require('./nbt');

/* ============================================================
 * 一、方向与元件定义
 * ============================================================ */

/** 方向 → 网格增量。y 向下，所以 n 是 -1。 */
const DIRS = {
  n: { dx: 0, dy: -1 },
  s: { dx: 0, dy: 1 },
  e: { dx: 1, dy: 0 },
  w: { dx: -1, dy: 0 }
};
const DIR_LIST = ['n', 'e', 's', 'w'];

/** @param {string} d @returns {string} */
function opposite(d) {
  return d === 'n' ? 's' : d === 's' ? 'n' : d === 'e' ? 'w' : 'e';
}
/** 「左」= 站在 facing 方向上看过去的左侧。y 向下时，n 的左边是 w。 */
/** @param {string} d @returns {string} */
function leftOf(d) { return d === 'n' ? 'w' : d === 'w' ? 's' : d === 's' ? 'e' : 'n'; }
/** @param {string} d @returns {string} */
function rightOf(d) { return opposite(leftOf(d)); }
/** @param {string} d @returns {string} */
function rotateCW(d) { return d === 'n' ? 'e' : d === 'e' ? 's' : d === 's' ? 'w' : 'n'; }

/**
 * 元件清单。`kind` 决定模拟时的角色：
 *   source      电源，向**四周**输出
 *   directional 定向输出（只往 facing 那一格）
 *   inverter    反相器（火把），向四周输出反相结果
 *   network     红石线，强度沿网络衰减
 *   sink        只显示不输出
 *   inert       不参与逻辑（实心块本身不导电，但会被充能）
 */
const COMPONENTS = [
  { id: 'wire',       zh: '红石线',   en: 'Redstone dust',  kind: 'network',     color: '#c0392b', hotkey: '1' },
  { id: 'torch',      zh: '红石火把', en: 'Redstone torch', kind: 'inverter',    color: '#e74c3c', hotkey: '2' },
  { id: 'repeater',   zh: '中继器',   en: 'Repeater',       kind: 'directional', color: '#d35400', hotkey: '3' },
  { id: 'comparator', zh: '比较器',   en: 'Comparator',     kind: 'directional', color: '#8e44ad', hotkey: '4' },
  { id: 'lever',      zh: '拉杆',     en: 'Lever',          kind: 'source',      color: '#f1c40f', hotkey: '5' },
  { id: 'button',     zh: '按钮',     en: 'Button',         kind: 'source',      color: '#f39c12', hotkey: '6' },
  { id: 'plate',      zh: '压力板',   en: 'Pressure plate', kind: 'source',      color: '#e67e22', hotkey: '7' },
  { id: 'lamp',       zh: '红石灯',   en: 'Redstone lamp',  kind: 'sink',        color: '#ffe066', hotkey: '8' },
  { id: 'block',      zh: '实心块',   en: 'Solid block',    kind: 'inert',       color: '#6b6b78', hotkey: '9' }
];

const TYPE_MAP = new Map(COMPONENTS.map((c) => [c.id, c]));
/** 有延迟的元件及其默认延迟（单位：tick） */
const DEFAULT_DELAY = { repeater: 1, comparator: 1, torch: 1 };
const MAX_HISTORY = 4000;

/* ============================================================
 * 二、电路对象与编辑
 * ============================================================ */

/** @param {number} x @param {number} y @returns {string} */
function kx(x, y) { return x + ',' + y; }
/** @param {string} k @returns {{x:number, y:number}} */
function parseKey(k) {
  const i = k.indexOf(',');
  return { x: parseInt(k.slice(0, i), 10), y: parseInt(k.slice(i + 1), 10) };
}
/** @param {string} k @param {string} dir @returns {string} */
function stepKey(k, dir) {
  const p = parseKey(k);
  const d = DIRS[/** @type {keyof typeof DIRS} */ (dir)];
  return kx(p.x + d.dx, p.y + d.dy);
}

/** 新建一张空电路 */
function createCircuit() {
  return {
    cells: /** @type {Map<string, any>} */ (new Map()),
    tick: 0,
    probes: /** @type {Set<string>} */ (new Set()),
    history: /** @type {Map<string, number[]>} */ (new Map())
  };
}

/**
 * 造一个元件状态。
 * @param {string} type @param {number} x @param {number} y @param {object} [patch]
 * @returns {any}
 */
function makeComp(type, x, y, patch) {
  const meta = TYPE_MAP.get(type);
  if (!meta) throw new Error('未知元件 ' + type);
  return Object.assign({
    type,
    kind: meta.kind,
    x, y,
    facing: 'e',            // directional / torch 的朝向
    out: 0,                 // 当前输出强度 0-15
    next: 0,                // 排队中的目标输出
    timer: -1,              // 倒计时（-1 表示没有排队）
    delay: DEFAULT_DELAY[/** @type {keyof typeof DEFAULT_DELAY} */ (type)] || 0,
    on: false,              // lever / button / plate 的开关
    lit: false,             // 灯是否亮
    mode: 'compare',        // comparator: compare | subtract
    locked: false
  }, patch || {});
}

/**
 * 放一个元件（覆盖原有）。
 * @param {any} c @param {number} x @param {number} y @param {string} type
 * @param {object} [patch] @returns {any|null}
 */
function place(c, x, y, type, patch) {
  const comp = makeComp(type, x, y, patch);
  c.cells.set(kx(x, y), comp);
  return comp;
}

/**
 * 删除一个元件。
 * @param {any} c @param {number} x @param {number} y @returns {boolean}
 */
function remove(c, x, y) {
  const k = kx(x, y);
  c.probes.delete(k);
  c.history.delete(k);
  return c.cells.delete(k);
}

/** @param {any} c @param {number} x @param {number} y @returns {any|null} */
function getCell(c, x, y) { return c.cells.get(kx(x, y)) || null; }

/**
 * 改元件属性（UI 用）。
 * @param {any} c @param {number} x @param {number} y @param {object} patch @returns {boolean}
 */
function setProp(c, x, y, patch) {
  const comp = getCell(c, x, y);
  if (!comp) return false;
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'delay' && comp.type === 'repeater') {
      comp.delay = Math.max(1, Math.min(4, Number(v) || 1));
    } else if (k === 'mode' && comp.type === 'comparator') {
      comp.mode = v === 'subtract' ? 'subtract' : 'compare';
    } else if (k === 'on') {
      comp.on = !!v;
      // 开关型电源立刻生效（不等延迟）
      if (comp.type === 'lever' || comp.type === 'button' || comp.type === 'plate') {
        comp.out = comp.on ? 15 : 0;
        comp.next = comp.out;
        comp.timer = -1;
      }
    } else if (k === 'facing') {
      if (DIRS[/** @type {keyof typeof DIRS} */ (String(v))]) comp.facing = String(v);
    } else {
      comp[k] = v;
    }
  }
  return true;
}

/** 顺时针旋转 90°
 *  @param {any} c @param {number} x @param {number} y @returns {boolean} */
function rotate(c, x, y) {
  const comp = getCell(c, x, y);
  if (!comp) return false;
  comp.facing = rotateCW(comp.facing);
  return true;
}

/** 清掉所有运行时状态（保留布局），用于「重跑」 */
function reset(c) {
  c.tick = 0;
  for (const comp of c.cells.values()) {
    comp.out = 0;
    comp.next = 0;
    comp.timer = -1;
    comp.locked = false;
    comp.lit = false;
    if (comp.type !== 'lever') comp.on = false; // 拉杆保持用户设的位置
  }
  for (const arr of c.history.values()) arr.length = 0;
  // 让电源在本 tick 就位
  for (const comp of c.cells.values()) {
    if (comp.type === 'lever' || comp.type === 'button' || comp.type === 'plate') {
      comp.out = comp.on ? 15 : 0;
      comp.next = comp.out;
    }
  }
  net(c);
  return c;
}

/* ============================================================
 * 三、信号模型
 * ============================================================ */

/** 某格是否是实心块
 *  @param {any} c @param {string} k @returns {boolean} */
function isSolid(c, k) {
  const t = c.cells.get(k);
  return !!t && t.type === 'block';
}

/**
 * 方块的**强充能**：只有「定向元件的输出正对着它」和「电源挨着它」才算。
 * 强充能能激活中继器 —— 这是它和弱充能唯一的区别，也是整个模型里最容易被写错的一条。
 * @param {any} c @param {string} k @returns {number}
 */
function strongPower(c, k) {
  if (!isSolid(c, k)) return 0;
  let p = 0;
  for (const dir of DIR_LIST) {
    const nk = stepKey(k, dir);
    const n = c.cells.get(nk);
    if (!n || n.out <= 0) continue;
    if (n.type === 'repeater' || n.type === 'comparator') {
      if (stepKey(nk, n.facing) === k) p = Math.max(p, n.out);
    } else if (n.type === 'lever' || n.type === 'button' || n.type === 'plate') {
      p = Math.max(p, n.out);
    }
  }
  return p;
}

/**
 * 方块的**弱充能**：挨着通电的红石线/火把就算。
 * 能让火把熄灭、能点亮灯，但**不能激活中继器**。
 *
 * `except` 用来**排除火把自己** —— 不然会自锁：
 * 火把亮 → 给自己附着的方块弱充能 → 火把看到"自己被充能了" → 熄灭 → 又亮…
 * 结果每个孤零零的火把都在抽搐。排除掉自己，两个火把夹一块方块的经典
 * 「火把时钟」才能正确地交替闪烁。
 *
 * @param {any} c @param {string} k @param {string} [except]
 * @returns {number}
 */
function weakPower(c, k, except) {
  if (!isSolid(c, k)) return 0;
  let p = 0;
  for (const dir of DIR_LIST) {
    const nk = stepKey(k, dir);
    if (except && nk === except) continue;
    const n = c.cells.get(nk);
    if (!n || n.out <= 0) continue;
    if (n.type === 'wire' || n.type === 'torch') p = 15;
  }
  return p;
}

/**
 * 从 `selfKey` 朝 `dir` 看过去，那个邻居给过来的输入强度。
 *
 * ⚠️ 定向元件只从**正对的那一面**输出 —— 旁边挨着不算。
 * 少这个判断，中继器的侧后方也会莫名收到信号。
 *
 * @param {any} c @param {string} selfKey @param {string} dir
 * @param {boolean} [needStrong] 只看强充能（中继器/比较器的后侧用）
 * @returns {number}
 */
function neighborInput(c, selfKey, dir, needStrong) {
  const nk = stepKey(selfKey, dir);
  const t = c.cells.get(nk);
  if (!t) return 0;
  if (t.type === 'wire') return t.out;
  if (t.type === 'block') {
    return needStrong ? strongPower(c, nk) : Math.max(strongPower(c, nk), weakPower(c, nk));
  }
  if (t.type === 'repeater' || t.type === 'comparator') {
    return stepKey(nk, t.facing) === selfKey ? t.out : 0;
  }
  if (t.type === 'lever' || t.type === 'button' || t.type === 'plate' || t.type === 'torch') {
    return t.out;
  }
  return 0;
}

/**
 * 火把感受到的输入：它附着的那个方块有没有被充能（强或弱都算）。
 * 附着位置没有方块时退化为「四周有没有通电的线/被充能的块」——
 * 这样用户把火把单独摆在地上也能用，不会一脸茫然。
 * @param {any} c @param {string} k @param {any} comp @returns {boolean}
 */
function torchInput(c, k, comp) {
  const att = stepKey(k, comp.facing);
  if (isSolid(c, att)) {
    return strongPower(c, att) > 0 || weakPower(c, att, k) > 0;
  }
  for (const dir of DIR_LIST) {
    const nk = stepKey(k, dir);
    const t = c.cells.get(nk);
    if (!t) continue;
    if (t.type === 'wire' && t.out > 0) return true;
    if (t.type === 'block' && (strongPower(c, nk) > 0 || weakPower(c, nk, k) > 0)) return true;
  }
  return false;
}

/** 中继器是否被侧面的另一个中继器锁定（锁存）
 *  @param {any} c @param {string} k @param {any} comp @returns {boolean} */
function isLocked(c, k, comp) {
  for (const side of [leftOf(comp.facing), rightOf(comp.facing)]) {
    const nk = stepKey(k, side);
    const n = c.cells.get(nk);
    // 只有中继器会锁定（比较器不锁定）
    if (n && n.type === 'repeater' && n.out > 0 && stepKey(nk, n.facing) === k) return true;
  }
  return false;
}

/**
 * 重算红石线网络。
 *
 * 线网就是一个「多源最短路 + 每走一格衰减 1」的问题：
 *   strength(格子) = max over 所有源 (源强度 - 到源的距离)
 * 用松弛迭代而不是 Dijkstra —— 强度上限是 15，所以最多 15 轮就收敛，
 * 电路规模又小，代码短得多也更好读。
 *
 * @param {any} c
 */
function net(c) {
  /** @type {Array<string>} */
  const wires = [];
  /** @type {Map<string, number>} */
  const best = new Map();
  for (const [k, comp] of c.cells) {
    if (comp.type !== 'wire') continue;
    wires.push(k);
    best.set(k, 0);
  }
  if (!wires.length) return;

  // 注入源：非 wire 元件的输出打到相邻线格
  // ⚠️ 定向元件（中继器/比较器）**只往 facing 那一格注入**。
  //    写成"四邻都注入"会出一个很隐蔽的错：中继器输出后会把自己**输入侧**的线
  //    也顶到满强度 —— 表现为「信号莫名其妙从输出倒灌回输入端」，
  //    而且因为线本身能双向传，整条链路会长出根本不存在的回路。
  for (const [k, comp] of c.cells) {
    if (comp.type === 'wire' || comp.out <= 0) continue;
    if (comp.kind === 'sink' || comp.kind === 'inert') continue;
    if (comp.kind === 'directional') {
      const nk = stepKey(k, comp.facing);
      if (best.has(nk)) best.set(nk, Math.max(/** @type {number} */ (best.get(nk)), comp.out));
      continue;
    }
    for (const dir of DIR_LIST) {
      const nk = stepKey(k, dir);
      if (best.has(nk)) best.set(nk, Math.max(/** @type {number} */ (best.get(nk)), comp.out));
    }
  }
  // 强充能方块也给相邻线格满强度
  for (const [k, comp] of c.cells) {
    if (comp.type !== 'block') continue;
    if (strongPower(c, k) <= 0) continue;
    for (const dir of DIR_LIST) {
      const nk = stepKey(k, dir);
      if (best.has(nk)) best.set(nk, Math.max(/** @type {number} */ (best.get(nk)), 15));
    }
  }

  // 松弛到不动点（强度每格 -1，天然收敛）
  let changed = true, guard = 0;
  while (changed && guard++ < 64) {
    changed = false;
    for (const k of wires) {
      const cur = /** @type {number} */ (best.get(k));
      let v = cur;
      for (const dir of DIR_LIST) {
        const nk = stepKey(k, dir);
        if (!best.has(nk)) continue;
        const cand = /** @type {number} */ (best.get(nk)) - 1;
        if (cand > v) v = cand;
      }
      if (v !== cur) { best.set(k, v); changed = true; }
    }
  }

  for (const k of wires) {
    const comp = c.cells.get(k);
    const v = /** @type {number} */ (best.get(k));
    comp.out = Math.max(0, Math.min(15, v));
  }
}

/**
 * 这个元件「想要输出」多少。**只读当前状态**，不写任何东西 —— 同步推进的关键。
 * @param {any} c @param {string} k @param {any} comp @returns {number}
 */
function respond(c, k, comp) {
  switch (comp.type) {
    case 'lever':
    case 'button':
    case 'plate':
      return comp.on ? 15 : 0;

    case 'torch':
      return torchInput(c, k, comp) ? 0 : 15;

    case 'repeater': {
      if (isLocked(c, k, comp)) return comp.out; // 被锁存：保持原输出
      const inp = neighborInput(c, k, opposite(comp.facing), true);
      return inp > 0 ? 15 : 0;
    }

    case 'comparator': {
      const a = neighborInput(c, k, opposite(comp.facing), true);
      const l = neighborInput(c, k, leftOf(comp.facing), false);
      const r = neighborInput(c, k, rightOf(comp.facing), false);
      const side = Math.max(l, r);
      if (comp.mode === 'subtract') return Math.max(0, a - side);
      return a >= side ? a : 0;
    }

    case 'lamp':
    case 'wire':
    case 'block':
    default:
      return 0;
  }
}

/** 灯这类「只显示」的元件，输入来自所有相邻（无方向要求）
 *  @param {any} c @param {string} k @returns {number} */
function sinkInput(c, k) {
  let p = 0;
  for (const dir of DIR_LIST) p = Math.max(p, neighborInput(c, k, dir, false));
  return p;
}

/* ============================================================
 * 四、推进
 * ============================================================ */

/**
 * 推进一个 tick。
 *
 * 顺序是刻意的：
 *   A 结算上一轮排队的延迟元件 → B 用最新输出重算线网 → C 评估各元件的新目标
 *   → D 同步显示元件 → E 记波形
 *
 * B 在 C 之前，所以「电源在同一 tick 内点亮下游的灯」是成立的；
 * 但延迟元件的输出要等下一 tick —— 这正是中继器/火把延时的来源。
 *
 * @param {any} c @returns {number} 新的 tick 号
 */
function step(c) {
  c.tick++;

  // A. 结算排队的延迟
  for (const comp of c.cells.values()) {
    if (comp.timer > 0) {
      comp.timer--;
      if (comp.timer === 0) {
        comp.out = comp.next;
        comp.timer = -1;
      }
    }
  }

  // B. 重算线网
  net(c);

  // C. 评估新目标，有变化就排队
  for (const [k, comp] of c.cells) {
    if (comp.type === 'wire') continue; // 线的输出完全由 net() 决定
    // 锁存状态要写回字段 —— isLocked() 是纯查询，不落字段的话
    // UI 上永远看不到「这个中继器被锁住了」
    if (comp.type === 'repeater') comp.locked = isLocked(c, k, comp);
    const want = respond(c, k, comp);

    // 零延迟元件（拉杆/按钮/压力板/灯）**当 tick 生效**，不排队。
    // 若也走 delay 逻辑，timer=0 会永远停在"未到 0"不会结算的状态，
    // 表现为「按了拉杆但灯就是不亮」。
    if (comp.delay <= 0) {
      comp.out = want;
      comp.next = want;
      comp.timer = -1;
      continue;
    }

    if (want !== comp.next) {
      if (want === comp.out) {
        // 又变回去了（脉冲太短）：撤销排队，别白白等一个延迟
        comp.next = want;
        comp.timer = -1;
      } else {
        comp.next = want;
        comp.timer = comp.delay;
      }
    }
  }

  // D. 显示元件即时响应
  for (const [k, comp] of c.cells) {
    if (comp.type !== 'lamp') continue;
    const inp = sinkInput(c, k);
    comp.lit = inp > 0;
    comp.out = comp.lit ? 15 : 0;
  }

  // E. 波形
  record(c);
  return c.tick;
}

/** @param {any} c @param {number} [n] @returns {number} */
function run(c, n) {
  const count = Math.max(1, Math.min(10000, n || 1));
  for (let i = 0; i < count; i++) step(c);
  return c.tick;
}

/** 还有元件在排队等延迟吗
 *  @param {any} c @returns {boolean} */
function busy(c) {
  for (const comp of c.cells.values()) if (comp.timer > 0) return true;
  return false;
}

/**
 * 连跑「到电路静定为止」：一直走，直到没有任何元件还在排队等延迟。
 *
 * 为什么要它：用户扳一下开关，期待**立刻**看到新状态。只推进一刻的话，
 * 1 tick 延迟的火把 / 中继器还在排队，界面上看起来像「点了没反应」，
 * 得再点一次「+1 刻」才行。而推迟多少刻取决于电路里有几级延迟元件，
 * 调用方算不出来 —— 由这里的收敛条件决定才对。
 *
 * 收敛性：延迟元件（火把/中继器/比较器）至少 1 tick，而红石线是 0 延迟、
 * 在 net() 里松弛到不动点。所以「一刻结束时没有排队」就等价于「下一刻不会有任何变化」，
 * 不需要再多跑一刻做确认（不会白涨 tick 计数）。
 * 对持续振荡的电路（火把时钟）永远静定不了，这时按 max 收尾，不会卡住。
 *
 * @param {any} c @param {number} [max] 上限刻数（默认 8）
 * @returns {number} 实际推进了几刻（至少 1）
 */
function settle(c, max) {
  const cap = Math.max(1, Math.min(64, max || 8));
  let n = 0;
  do {
    step(c);
    n++;
  } while (busy(c) && n < cap);
  return n;
}

/* ============================================================
 * 五、探针与时序波形
 * ============================================================ */

/** @param {any} c @param {number} x @param {number} y @returns {boolean} */
function probe(c, x, y) {
  const k = kx(x, y);
  if (!c.cells.has(k)) return false;
  c.probes.add(k);
  if (!c.history.has(k)) c.history.set(k, []);
  return true;
}
/** @param {any} c @param {number} x @param {number} y @returns {boolean} */
function unprobe(c, x, y) {
  const k = kx(x, y);
  c.history.delete(k);
  return c.probes.delete(k);
}

/** 某格当前的「可读值」：灯读亮/灭，其它读输出强度 */
function valueOf(comp) {
  if (!comp) return 0;
  if (comp.type === 'lamp') return comp.lit ? 15 : 0;
  return comp.out;
}

/** @param {any} c */
function record(c) {
  if (!c.probes.size) return;
  for (const k of c.probes) {
    const arr = c.history.get(k);
    if (!arr) continue;
    arr.push(valueOf(c.cells.get(k)));
    if (arr.length > MAX_HISTORY) arr.splice(0, arr.length - MAX_HISTORY);
  }
}

/**
 * 取波形。
 * @param {any} c @param {number} x @param {number} y @param {number} [last]
 * @returns {{ok:boolean, key?:string, type?:string, zh?:string, samples?:number[], min?:number, max?:number, changes?:number}}
 */
function waveform(c, x, y, last) {
  const k = kx(x, y);
  const comp = c.cells.get(k);
  if (!comp) return { ok: false };
  const full = c.history.get(k) || [];
  const samples = last && last > 0 ? full.slice(-last) : full.slice();
  let changes = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i] !== samples[i - 1]) changes++;
  const meta = TYPE_MAP.get(comp.type);
  return {
    ok: true, key: k, type: comp.type,
    zh: meta ? meta.zh : comp.type,
    samples,
    min: samples.length ? Math.min(...samples) : 0,
    max: samples.length ? Math.max(...samples) : 0,
    changes
  };
}

/** 当前所有探针的波形摘要
 *  @param {any} c @param {number} [last] */
function allWaveforms(c, last) {
  const out = [];
  for (const k of c.probes) {
    const p = parseKey(k);
    out.push(waveform(c, p.x, p.y, last));
  }
  return out;
}

/* ============================================================
 * 六、快照（给 UI 渲染）
 * ============================================================ */

/** @param {any} c */
function snapshot(c) {
  const cells = [];
  for (const [k, comp] of c.cells) {
    const meta = TYPE_MAP.get(comp.type);
    cells.push({
      key: k, x: comp.x, y: comp.y,
      type: comp.type, zh: meta ? meta.zh : comp.type,
      facing: comp.facing, out: comp.out, on: comp.on, lit: comp.lit,
      delay: comp.delay, mode: comp.mode, locked: comp.locked,
      probe: c.probes.has(k)
    });
  }
  return { tick: c.tick, cells, count: cells.length };
}

/** 电路规模统计
 *  @param {any} c */
function stats(c) {
  /** @type {Record<string, number>} */
  const byType = {};
  for (const comp of c.cells.values()) byType[comp.type] = (byType[comp.type] || 0) + 1;
  return { total: c.cells.size, byType, tick: c.tick, probes: c.probes.size };
}

/* ============================================================
 * 七、从存档导入
 * ============================================================ */

/**
 * MC 的 facing 值 → 本模块的方向。
 * MC 里 z+ 是 south、x+ 是 east，和这里的 y/x 一一对应。
 * @param {string} f @returns {string}
 */
function mcFacing(f) {
  const s = String(f || '').toLowerCase();
  if (s === 'north') return 'n';
  if (s === 'south') return 's';
  if (s === 'east') return 'e';
  if (s === 'west') return 'w';
  return 'e';
}

/**
 * 方块名 + 方块状态 → 元件描述。
 * 认不出来的一律当**实心块**（对红石电路来说，绝大多数非红石方块就是实心块，
 * 玻璃/树叶这类透明块会被误判 —— 这个误差在这里可接受，写在注释里免得日后困惑）。
 *
 * @param {string} name 形如 `minecraft:repeater`
 * @param {Record<string,string>} [props]
 * @returns {{type:string, facing?:string, delay?:number, mode?:string, on?:boolean, skipped?:boolean}}
 */
function blockToPart(name, props) {
  const n = String(name || '').replace(/^minecraft:/, '');
  const p = props || {};
  if (n === 'air' || n === 'cave_air' || n === 'void_air') return { type: 'air', skipped: true };
  if (n === 'redstone_wire') return { type: 'wire' };
  if (n === 'repeater') return { type: 'repeater', facing: mcFacing(p.facing), delay: Math.max(1, Math.min(4, Number(p.delay) || 1)) };
  if (n === 'comparator') return { type: 'comparator', facing: mcFacing(p.facing), mode: p.mode === 'subtract' ? 'subtract' : 'compare' };
  if (n === 'redstone_torch') return { type: 'torch', facing: 's' };          // 立式：附着在下方
  if (n === 'redstone_wall_torch') return { type: 'torch', facing: opposite(mcFacing(p.facing)) }; // 墙式：附着在背后
  if (n === 'lever') return { type: 'lever', facing: mcFacing(p.facing), on: p.powered === 'true' };
  if (/button$/.test(n)) return { type: 'button', facing: mcFacing(p.facing), on: p.powered === 'true' };
  if (/pressure_plate$/.test(n)) return { type: 'plate', on: p.powered === 'true' };
  if (n === 'redstone_lamp') return { type: 'lamp', on: p.lit === 'true' };
  if (n === 'redstone_block') return { type: 'block' };
  return { type: 'block' };
}

/**
 * 从 LONG_ARRAY 取第 idx 个、占 bits 位的值（与 worldmap 同一套打包规则）。
 * @param {any[]} data @param {number} idx @param {number} bits @returns {number}
 */
function packedIndex(data, idx, bits) {
  const bitOffset = idx * bits;
  const longIndex = Math.floor(bitOffset / 64);
  const bitInLong = bitOffset % 64;
  const mask = (bits >= 64) ? -1n : ((1n << BigInt(bits)) - 1n);
  const a = BigInt(data[longIndex] || 0n);
  let v = a >> BigInt(bitInLong);
  if (bitInLong + bits > 64) {
    const b = BigInt(data[longIndex + 1] || 0n);
    v |= b << BigInt(64 - bitInLong);
  }
  v &= mask;
  return Number(v);
}

/**
 * 从区块的 Sections 里取出指定世界高度那一层的 16×16 方块状态。
 * 支持 1.13/1.14 的 `{Palette, BlockStates}` 与 1.15+ 的 `{block_states:{palette,data}}`。
 *
 * @param {any[]} sections
 * @param {number} y 世界高度
 * @returns {Array<{Name:string, Properties?:Record<string,string>}|null>|null} 按 z*16+x 排列
 */
function decodeSectionAtY(sections, y) {
  if (!Array.isArray(sections) || !sections.length) return null;
  const sectionY = Math.floor(y / 16);
  const yLocal = ((y % 16) + 16) % 16;
  const sec = sections.find((s) => Number(s.Y) === sectionY);
  if (!sec) return null;
  const bs = sec.block_states || (sec.Palette ? { palette: sec.Palette, data: sec.BlockStates } : null);
  if (!bs || !Array.isArray(bs.palette) || !bs.palette.length) return null;
  const palette = bs.palette;
  const bits = palette.length <= 1 ? 0 : Math.max(4, 32 - Math.clz32(palette.length - 1));
  const data = Array.isArray(bs.data) ? bs.data : [];
  /** @type {Array<any>} */
  const out = new Array(256).fill(null);
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      const i = (yLocal * 16 + z) * 16 + x;
      const pi = bits === 0 ? 0 : packedIndex(data, i, bits);
      const entry = palette[pi];
      out[z * 16 + x] = entry ? { Name: String(entry.Name || ''), Properties: entry.Properties } : null;
    }
  }
  return out;
}

/**
 * 从存档某一层导入电路。
 *
 * 只读：全程不写存档。
 *
 * @param {{saveDir:string, dim?:string, x1:number, z1:number, x2:number, z2:number, y:number,
 *          onProgress?: (done:number, total:number) => void}} o
 * @returns {Promise<{ok:boolean, circuit?:any, w?:number, h?:number, origin?:{x:number,y:number},
 *   single?:boolean, counts?:Record<string,number>, skipped?:number, error?:string}>}
 */
async function importFromSave(o) {
  try {
    // 空路径必须拦住：底层扫目录对"不存在"是静默返回空列表的，
    // 不校验就会把「目录写错了」变成「导入成功但啥也没有」，用户完全无从判断。
    if (!o || !o.saveDir) return { ok: false, error: '缺少存档目录' };
    const x1 = Math.min(o.x1, o.x2), x2 = Math.max(o.x1, o.x2);
    const z1 = Math.min(o.z1, o.z2), z2 = Math.max(o.z1, o.z2);
    const w = x2 - x1 + 1, h = z2 - z1 + 1;
    if (w < 1 || h < 1) return { ok: false, error: '选区为空' };
    if (w > 256 || h > 256) return { ok: false, error: '选区过大（上限 256×256 方块）' };

    const cx1 = Math.floor(x1 / 16), cx2 = Math.floor(x2 / 16);
    const cz1 = Math.floor(z1 / 16), cz2 = Math.floor(z2 / 16);
    const totalChunks = (cx2 - cx1 + 1) * (cz2 - cz1 + 1);

    const c = createCircuit();
    /** @type {Record<string, number>} */
    const counts = {};
    let skipped = 0, seen = 0;

    await anvil.scanSaveChunks({
      saveDir: o.saveDir,
      dim: o.dim || 'overworld',
      onProgress: o.onProgress,
      onChunk: (key, raw) => {
        const cx = parseInt(key.split(',')[0], 10);
        const cz = parseInt(key.split(',')[1], 10);
        if (cx < cx1 || cx > cx2 || cz < cz1 || cz > cz2) return;
        seen++;
        let root = null;
        try { root = nbt.parse(raw).value; } catch (e) { return; } // 损坏区块跳过
        const lv = root.Level || root;
        const layer = decodeSectionAtY(lv.Sections, o.y);
        if (!layer) return;

        for (let bz = 0; bz < 16; bz++) {
          for (let bx = 0; bx < 16; bx++) {
            const wx = cx * 16 + bx, wz = cz * 16 + bz;
            if (wx < x1 || wx > x2 || wz < z1 || wz > z2) continue;
            const entry = layer[bz * 16 + bx];
            if (!entry) continue;
            const part = blockToPart(entry.Name, entry.Properties);
            if (part.skipped) { skipped++; continue; }
            const gx = wx - x1, gy = wz - z1;
            /** @type {any} */
            const patch = {};
            if (part.facing) patch.facing = part.facing;
            if (part.delay) patch.delay = part.delay;
            if (part.mode) patch.mode = part.mode;
            if (part.on !== undefined) patch.on = part.on;
            const comp = place(c, gx, gy, part.type, patch);
            // 拉杆等的初始输出要在第一 tick 前就位
            if (part.type === 'lever' || part.type === 'button' || part.type === 'plate') {
              comp.out = comp.on ? 15 : 0;
              comp.next = comp.out;
            }
            counts[part.type] = (counts[part.type] || 0) + 1;
          }
        }
      }
    });

    net(c);
    return {
      ok: true, circuit: c, w, h,
      origin: { x: x1, y: z1 },
      single: totalChunks === 1 || seen <= 1,
      counts, skipped
    };
  } catch (e) {
    return { ok: false, error: (e && /** @type {any} */ (e).message) || String(e) };
  }
}

/* ============================================================
 * 八、文本导出（分享用）
 * ============================================================ */

/** 每个元件一个字符，方便贴到聊天里
 *  @param {any} c @param {number} [w] @param {number} [h] @returns {string} */
function toAscii(c, w, h) {
  let maxX = 0, maxY = 0, minX = 0, minY = 0;
  for (const comp of c.cells.values()) {
    maxX = Math.max(maxX, comp.x);
    maxY = Math.max(maxY, comp.y);
    minX = Math.min(minX, comp.x);
    minY = Math.min(minY, comp.y);
  }
  // 坐标是**带负数的**：元件在 y<0 一侧很常见（示例里的反相器/比较器就用了 y=-1）。
  // 早先直接从 (0,0) 起画，负坐标那半边被整个切掉 —— 复制出来的字符画少一半、还看不出来少了。
  // 这里只做「负数才平移」：全部非负时 offX/offY 为 0，输出与旧行为逐字节一致。
  const offX = minX < 0 ? -minX : 0;
  const offY = minY < 0 ? -minY : 0;
  const W = w || maxX - minX + 1, H = h || maxY - minY + 1;
  const ch = {
    wire: '.', torch: 'T', repeater: 'R', comparator: 'C',
    lever: 'L', button: 'B', plate: 'P', lamp: 'O', block: '#'
  };
  const lines = [];
  for (let y = 0; y < H; y++) {
    let s = '';
    for (let x = 0; x < W; x++) {
      const comp = c.cells.get(kx(x - offX, y - offY));
      s += comp ? (ch[/** @type {keyof typeof ch} */ (comp.type)] || '?') : ' ';
    }
    lines.push(s.replace(/\s+$/, ''));
  }
  return lines.join('\n');
}

/* ============================================================
 * 九、序列化（存盘 / 分享）
 * ============================================================ */

/**
 * 电路 → 可 JSON 序列化的普通对象。
 * Map / Set 不能直接 JSON.stringify，而且运行时状态（out/timer）没必要存 ——
 * 加载后从电源重新推一遍就能复原，存了反而会和布局不一致。
 * @param {any} c
 */
function serialize(c) {
  return {
    v: 1,
    tick: c.tick,
    probes: [...c.probes],
    cells: [...c.cells.values()].map((x) => ({
      x: x.x, y: x.y, type: x.type,
      facing: x.facing, delay: x.delay, mode: x.mode, on: x.on
    }))
  };
}

/**
 * 反序列化（不恢复运行时输出，加载后跑一步即可）。
 * @param {any} data @returns {any}
 */
function deserialize(data) {
  const c = createCircuit();
  const d = data && typeof data === 'object' ? data : {};
  for (const cell of (Array.isArray(d.cells) ? d.cells : [])) {
    if (!TYPE_MAP.has(cell.type)) continue;
    const patch = {};
    if (cell.facing) patch.facing = cell.facing;
    if (cell.delay != null) patch.delay = cell.delay;
    if (cell.mode) patch.mode = cell.mode;
    const comp = place(c, Number(cell.x) || 0, Number(cell.y) || 0, cell.type, patch);
    if (cell.on && (cell.type === 'lever' || cell.type === 'button' || cell.type === 'plate')) {
      comp.on = true;
      comp.out = 15;
      comp.next = 15;
    }
  }
  for (const k of (Array.isArray(d.probes) ? d.probes : [])) {
    if (!c.cells.has(k)) continue;
    c.probes.add(k);
    c.history.set(k, []);
  }
  net(c);
  return c;
}

module.exports = {
  // 常量
  DIRS, DIR_LIST, COMPONENTS, TYPE_MAP, DEFAULT_DELAY,
  // 方向
  opposite, leftOf, rightOf, rotateCW, mcFacing,
  // 坐标
  kx, parseKey, stepKey,
  // 电路编辑
  createCircuit, makeComp, place, remove, getCell, setProp, rotate, reset,
  // 信号模型（导出便于单测逐条验证）
  isSolid, strongPower, weakPower, neighborInput, torchInput, isLocked, net, respond, sinkInput,
  // 推进
  step, run, settle, busy,
  // 探针与波形
  probe, unprobe, valueOf, waveform, allWaveforms,
  // 快照
  snapshot, stats, toAscii,
  // 序列化
  serialize, deserialize,
  // 存档导入
  blockToPart, packedIndex, decodeSectionAtY, importFromSave
};
