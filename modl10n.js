// Pebble Lunchar - Mod 汉化补全（V4 第四组 · R17）
//
// 要解决的问题：英文 mod 一大堆，中文玩家看不懂物品名、方块名、配置项。
// 社区做法是「下载汉化资源包」，但那是别人做好的、覆盖不全、版本对不上。
//
// 本项目不能联网、不能调翻译 API，所以走「离线词典 + 手工补全」这条路：
//
//   1. 扫描 mod jar 里的 assets/<ns>/lang/en_us.json（英文原文）
//      与 zh_cn.json（已有中文），**差集就是缺翻译的条目**。
//   2. 拿内置离线词典去匹配 —— 词典按"词 → 译"组织，能命中大量通用词
//      （Diamond / Sword / Ore / Upgrade / Config 这类）。
//   3. 没命中的生成待翻译清单，用户可手工填或导入别人分享的翻译包。
//   4. 输出成一个**独立的资源包 zip**，不改原 jar —— 这样：
//      · 换 mod 版本不冲突（重新生成即可）
//      · 出问题删掉资源包就行，零风险
//      · 可以直接分享给朋友
//
// 词典来源：内置一份常用词表（见 BUILTIN_DICT）。词条是《我的世界》官方中文
// 译名 + 通用计算机/游戏术语，都是从公开资料整理的常见对应关系。

const fs = require('fs');
const path = require('path');
const zip = require('./zipread');

/* ---------------- 内置离线词典 ----------------
 *
 * 匹配策略（按优先级）：
 *   1. 完整词条精确匹配（"Diamond Sword" → "钻石剑"）
 *   2. 逐词替换（"Diamond" → "钻石"，"Sword" → "剑"），能拼出大部分组合
 *   3. 都不中 → 进待翻译清单
 *
 * 键统一小写比较，值保留原始大小写。
 */

/** 完整短语（优先精确匹配） */
const PHRASES = {
  'diamond sword': '钻石剑',
  'diamond pickaxe': '钻石镐',
  'diamond axe': '钻石斧',
  'diamond shovel': '钻石锹',
  'diamond hoe': '钻石锄',
  'iron sword': '铁剑',
  'iron pickaxe': '铁镐',
  'golden apple': '金苹果',
  'enchanted golden apple': '附魔金苹果',
  'netherite ingot': '下界合金锭',
  'nether star': '下界之星',
  'ender pearl': '末影珍珠',
  'ender eye': '末影之眼',
  'blaze rod': '烈焰棒',
  'blaze powder': '烈焰粉',
  'slime ball': '黏液球',
  'magma cream': '岩浆膏',
  'ghast tear': '恶魂之泪',
  'redstone dust': '红石粉',
  'glowstone dust': '荧石粉',
  'gunpowder': '火药',
  'sugar cane': '甘蔗',
  'cocoa beans': '可可豆',
  'nether wart': '下界疣',
  'experience bottle': '附魔之瓶',
  'bottle o\' enchanting': '附魔之瓶',
  'crafting table': '工作台',
  'furnace': '熔炉',
  'blast furnace': '高炉',
  'smoker': '烟熏炉',
  'stone cutter': '切石机',
  'anvil': '铁砧',
  'enchanting table': '附魔台',
  'brewing stand': '酿造台',
  'cauldron': '炼药锅',
  'chest': '箱子',
  'ender chest': '末影箱',
  'trapped chest': '陷阱箱',
  'barrel': '木桶',
  'hopper': '漏斗',
  'dropper': '投掷器',
  'dispenser': '发射器',
  'observer': '侦测器',
  'piston': '活塞',
  'sticky piston': '黏性活塞',
  'redstone repeater': '红石中继器',
  'redstone comparator': '红石比较器',
  'daylight detector': '阳光探测器',
  'note block': '音符盒',
  'jukebox': '唱片机',
  'beacon': '信标',
  'conduit': '潮涌核心',
  'spawner': '刷怪笼',
  'monster spawner': '刷怪笼',
  'crafting': '合成',
  'smelting': '冶炼',
  'blasting': '高炉冶炼',
  'smoking': '烟熏',
  'campfire cooking': '营火烹饪',
  'stonecutting': '切石',
  'smithing': '锻造',
  'brewing': '酿造'
};

/** 单词表（逐词替换） */
const WORDS = {
  // 材质
  diamond: '钻石', iron: '铁', gold: '金', golden: '金', netherite: '下界合金',
  emerald: '绿宝石', lapis: '青金石', redstone: '红石', coal: '煤炭',
  charcoal: '木炭', copper: '铜', bronze: '青铜', tin: '锡', silver: '银',
  lead: '铅', nickel: '镍', platinum: '铂', titanium: '钛', tungsten: '钨',
  uranium: '铀', steel: '钢', obsidian: '黑曜石', quartz: '石英',
  amethyst: '紫水晶', echo: '回响', sculk: '幽匿', prismarine: '海晶石',
  // 工具与武器
  sword: '剑', pickaxe: '镐', axe: '斧', shovel: '锹', hoe: '锄',
  bow: '弓', crossbow: '弩', arrow: '箭', shield: '盾牌', trident: '三叉戟',
  helmet: '头盔', chestplate: '胸甲', leggings: '护腿', boots: '靴子',
  armor: '盔甲', armour: '盔甲', tool: '工具', weapon: '武器',
  fishing: '钓鱼', rod: '钓竿', shears: '剪刀', flint: '燧石',
  // 方块
  block: '方块', ore: '矿石', ingot: '锭', nugget: '粒', gem: '宝石',
  plank: '木板', planks: '木板', log: '原木', wood: '木头', sapling: '树苗',
  leaves: '树叶', stone: '石头', cobblestone: '圆石', dirt: '泥土',
  grass: '草', sand: '沙子', gravel: '沙砾', clay: '黏土', brick: '砖',
  bricks: '砖块', glass: '玻璃', wool: '羊毛', carpet: '地毯',
  slab: '台阶', stairs: '楼梯', fence: '栅栏', gate: '栅栏门',
  door: '门', trapdoor: '活板门', ladder: '梯子', torch: '火把',
  lantern: '灯笼', candle: '蜡烛', campfire: '营火', sign: '告示牌', bed: '床', bookshelf: '书架', flower: '花',
  // 生物与实体
  zombie: '僵尸', skeleton: '骷髅', creeper: '苦力怕', spider: '蜘蛛',
  enderman: '末影人', endermite: '末影螨', slime: '史莱姆', witch: '女巫',
  villager: '村民', golem: '傀儡', iron_golem: '铁傀儡',
  snow_golem: '雪傀儡', wither: '凋灵', dragon: '末影龙', ender_dragon: '末影龙',
  pig: '猪', cow: '牛', sheep: '羊', chicken: '鸡', horse: '马',
  wolf: '狼', dog: '狗', cat: '猫', ocelot: '豹猫', fox: '狐狸',
  bee: '蜜蜂', panda: '熊猫', turtle: '海龟', dolphin: '海豚',
  squid: '鱿鱼', guardian: '守卫者', phantom: '幻翼', pillager: '掠夺者',
  ravager: '劫掠兽', evoker: '唤魔者', vindicator: '卫道士',
  illusioner: '幻术师', shulker: '潜影贝', warden: '监守者',
  hoglin: '疣猪兽', piglin: '猪灵', strider: '炽足兽',
  mob: '生物', entity: '实体', monster: '怪物', animal: '动物',
  // 功能与界面
  config: '配置', configuration: '配置', settings: '设置', setting: '设置',
  option: '选项', options: '选项', button: '按钮', menu: '菜单',
  screen: '界面', gui: '界面', page: '页面', tab: '页签', panel: '面板',
  search: '搜索', filter: '筛选', sort: '排序', list: '列表',
  enable: '启用', disable: '禁用', enabled: '已启用', disabled: '已禁用',
  on: '开', off: '关', none: '无',
  yes: '是', no: '否', all: '全部', default: '默认', custom: '自定义',
  auto: '自动', manual: '手动', random: '随机', reset: '重置',
  apply: '应用', cancel: '取消', confirm: '确认', close: '关闭',
  open: '打开', save: '保存', load: '加载', delete: '删除',
  remove: '移除', add: '添加', edit: '编辑', create: '创建',
  copy: '复制', paste: '粘贴', import: '导入', export: '导出',
  // 游戏机制
  health: '生命值', damage: '伤害', attack: '攻击', defense: '防御',
  speed: '速度', strength: '力量', power: '能量', energy: '能量',
  mana: '法力', experience: '经验', level: '等级', durability: '耐久',
  efficiency: '效率', fortune: '时运', silk: '精准', touch: '采集',
  sharpness: '锋利', smite: '亡灵杀手', bane: '节肢杀手',
  unbreaking: '耐久', mending: '经验修补', protection: '保护',
  thorns: '荆棘', looting: '抢夺', fire: '火焰', aspect: '附加',
  knockback: '击退', punch: '冲击', infinity: '无限', flame: '火矢',
  lure: '诱饵', luck: '海之眷顾', depth: '深海探索者',
  respiration: '水下呼吸', aqua: '水下速掘', affinity: '亲和',
  feather: '轻盈', falling: '摔落', blast: '爆炸', projectile: '弹射物',
  recipe: '配方', recipes: '配方', ingredient: '材料', ingredients: '材料',
  output: '产出', input: '输入', catalyst: '催化', fuel: '燃料',
  upgrade: '升级', upgrades: '升级', tier: '等级', tiered: '分级',
  // 电力/科技（常见科技 mod 术语）
  energy_storage: '能量存储', storage: '存储', tank: '储罐',
  fluid: '流体', liquid: '液体', gas: '气体', steam: '蒸汽',
  machine: '机器', generator: '发电机', reactor: '反应堆', turbine: '涡轮',
  pipe: '管道', cable: '线缆', wire: '导线', circuit: '电路',
  capacity: '容量', throughput: '吞吐量', transfer: '传输', transfer_rate: '传输速率',
  voltage: '电压', current: '电流', resistance: '电阻', battery: '电池',
  // 描述性
  color: '颜色', colour: '颜色', red: '红', blue: '蓝', green: '绿',
  yellow: '黄', orange: '橙', purple: '紫', pink: '粉', black: '黑',
  white: '白', gray: '灰', grey: '灰', brown: '棕', cyan: '青',
  light: '浅', dark: '深', bright: '亮', pale: '淡',
  small: '小', medium: '中', large: '大', tiny: '微型', huge: '巨大',
  big: '大', little: '小', normal: '普通', rare: '稀有',
  common: '普通', uncommon: '罕见', epic: '史诗', legendary: '传说',
  mythic: '神话', magic: '魔法', magical: '魔法', cursed: '诅咒',
  blessed: '祝福', holy: '神圣', evil: '邪恶',
  ancient: '远古', old: '旧', new: '新', broken: '破损',
  cracked: '裂纹', damaged: '受损', sturdy: '坚固',
  raw: '粗', refined: '精炼', pure: '纯净', dense: '致密',
  // 时间与数量
  second: '秒', seconds: '秒', minute: '分钟', minutes: '分钟',
  hour: '小时', hours: '小时', day: '天', days: '天',
  tick: '刻', ticks: '刻', per: '每', total: '总计',
  amount: '数量', count: '数量', size: '大小', weight: '重量',
  // 常见动词/形容词
  increase: '增加', decrease: '减少', reduce: '减少', boost: '提升',
  bonus: '加成', modifier: '修饰符', effect: '效果', duration: '时长',
  cooldown: '冷却', range: '范围', radius: '半径', area: '区域',
  chance: '几率', probability: '概率', max: '最大', min: '最小',
  up: '向上', down: '向下', left: '左', right: '右',
  top: '顶部', bottom: '底部', side: '侧面', front: '正面',
  inner: '内部', outer: '外部', upper: '上部', lower: '下部',
  piece: '块', pile: '堆', chunk: '块', lump: '团',
  // —— 结构词与连接词（组合短语时用，如 Block of Iron → 铁块）——
  of: '之', the: '之', and: '与', or: '或', with: '带', from: '来自',
  into: '转为', to: '至', for: '用于', in: '于', by: '由',
  // —— 手册/界面常见词 ——
  description: '说明', tooltip: '提示', usage: '用法',
  requirement: '需求', requirements: '需求', prerequisite: '前置',
  compatibility: '兼容性', compatible: '兼容', incompatible: '不兼容',
  version: '版本', versions: '版本', update: '更新', updated: '已更新',
  warning: '警告', error: '错误', info: '信息', notice: '提示',
  success: '成功', fail: '失败', failed: '失败', complete: '完成',
  incomplete: '未完成', progress: '进度', status: '状态', state: '状态',
  active: '激活', inactive: '未激活', available: '可用', unavailable: '不可用'
};

/** 不应该翻译的（专有名词 / 技术标识）—— 原样保留，不进待翻译清单 */
const SKIP_PATTERNS = [
  /^[\d\s.,:%+\-]+$/,            // 纯数字/符号
  // 内部标识符：全小写（可带下划线/点/连字符）才算。
  // ⚠️ 不能写成 /^[a-z0-9_.\-]+$/i —— 加了 i 之后 "Zzzqqq" 这种正常单词也会被吞掉，
  //    而 mod 里的物品名恰恰大量是这种驼峰/首字母大写的单词。
  /^[a-z0-9][a-z0-9_.\-]*$/,     // 纯小写标识符
  /^([a-z0-9]+[.:])+[a-z0-9_.\-]+$/,  // 带命名空间的 key，如 mymod.item.foo
  /^%\d*\$?s?$/,                 // 格式化占位符
  /^https?:\/\//i                // 网址
];

const SKIP_WORDS = new Set([
  'pebble', 'lunchar', 'minecraft', 'mod', 'mods', 'fabric', 'forge', 'neoforge',
  'quilt', 'java', 'api', 'json', 'nbt', 'ui', 'gui', 'hud', 'id', 'ip', 'url',
  'fps', 'tps', 'kb', 'mb', 'gb', 'ok'
]);

/* ---------------- 词条匹配 ---------------- */

/**
 * 用内置词典翻译一句英文
 * @returns {{text:string, method:'phrase'|'words'|'partial'|'miss', matched:number, total:number}}
 */
function translate(en) {
  const raw = String(en == null ? '' : en);
  const trimmed = raw.trim();
  if (!trimmed) return { text: '', method: 'miss', matched: 0, total: 0 };

  // ① 整句精确匹配（忽略大小写）
  const lower = trimmed.toLowerCase();
  if (PHRASES[lower]) return { text: PHRASES[lower], method: 'phrase', matched: 1, total: 1 };

  // ①.5 「A of B」语序 —— 在逐词翻译之前处理，否则会翻出"方块 之 铁"这种洋泾浜
  //     英文 Block of Iron → 中文 铁块（定语前置）。这里直接按英文原序重组再各自查词。
  const ofm = trimmed.match(/^([A-Za-z][A-Za-z\s'-]*?)\s+of\s+([A-Za-z][A-Za-z\s'-]*)$/);
  if (ofm) {
    const left = lookupPhrase(ofm[1].trim());   // 前半：核心名词，如 Block / Sword
    const right = lookupPhrase(ofm[2].trim());  // 后半：定语，如 Iron / Fire
    if (left && right) {
      // 中文语序：定语 + 核心。若核心本身是"XX块/XX锭"这类复合词，直接拼更自然
      const merged = right.text + left.text;
      return { text: merged, method: 'phrase', matched: 1, total: 1 };
    }
  }

  // ② 逐词替换：按空格/下划线/连字符切，保留分隔符形态
  const tokens = trimmed.split(/([\s_\-/]+)/);
  let hit = 0;
  let wordCount = 0;
  const outParts = [];
  for (const tk of tokens) {
    // 分隔符原样拼回（下划线转空格更好看，中英混排时下划线很丑）
    if (/^[\s_\-/]+$/.test(tk)) {
      outParts.push(/\s/.test(tk) ? ' ' : '');
      continue;
    }
    // 去掉结尾的冒号/括号等标点再查，查完拼回
    const m = tk.match(/^([(\[]?)([A-Za-z0-9']+)([)\]:,.!?]*)$/);
    if (!m) { outParts.push(tk); continue; }
    const [, pre, word, post] = m;
    wordCount++;
    const wl = word.toLowerCase();
    if (SKIP_WORDS.has(wl)) { outParts.push(tk); continue; }
    const t = WORDS[wl] || PHRASES[wl];
    if (t) { hit++; outParts.push(pre + t + post); }
    else outParts.push(tk);
  }

  const text = cleanup(outParts.join(''));
  if (wordCount > 0 && hit === wordCount) return { text, method: 'words', matched: hit, total: wordCount };
  if (hit > 0) return { text, method: 'partial', matched: hit, total: wordCount };
  return { text: '', method: 'miss', matched: 0, total: wordCount };
}

/**
 * 收尾清理：中文词之间的空格要去掉。
 *
 * 英文 "Iron Ingot" 逐词替换会得到 "铁 锭" —— 中文没有词间空格，读着很怪。
 * 但中英混排时（"Mod 设置"）又需要一个空格隔开，否则糊成一团。
 * 所以规则是：**只在"中+中"之间删空格**，"中+英"或"英+中"保留。
 */
function cleanup(s) {
  const CJK = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff';
  return String(s)
    .replace(/\s{2,}/g, ' ')
    // 汉字 + 空格 + 汉字 → 去掉空格
    .replace(new RegExp(`([${CJK}])\\s+([${CJK}])`, 'g'), '$1$2')
    .trim();
}

/** 查一个短语（可含空格）的中文；全词命中才算，否则返回 null */
function lookupPhrase(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  const low = t.toLowerCase();
  if (PHRASES[low]) return { text: PHRASES[low], n: 1 };
  const ws = t.split(/\s+/);
  const out = [];
  for (const w of ws) {
    const wl = w.toLowerCase();
    if (SKIP_WORDS.has(wl)) { out.push(w); continue; }
    const hit = WORDS[wl] || PHRASES[wl];
    if (!hit) return null;
    out.push(hit);
  }
  return { text: out.join(''), n: ws.length };
}

/** 是否值得进"待翻译清单"（过滤掉纯符号/标识符/专有词） */
function worthTranslating(en) {
  const t = String(en || '').trim();
  if (!t) return false;
  if (t.length < 2) return false;
  for (const re of SKIP_PATTERNS) if (re.test(t)) return false;
  // 全是专有词也不值得
  const words = t.toLowerCase().split(/[\s_\-/]+/).filter(Boolean);
  if (words.length && words.every((w) => SKIP_WORDS.has(w))) return false;
  return true;
}

/* ---------------- 读 jar 内语言文件 ---------------- */

const LANG_RE = /^assets\/([^/]+)\/lang\/([a-z]{2}(?:_[a-z]{2})?)\.json$/i;

/**
 * 列出 jar 里所有语言文件条目
 * @returns {Array<{ns:string, locale:string, name:string}>}
 */
function listLangs(jarPath) {
  let entries = [];
  try { entries = zip.listEntries(jarPath); } catch { return []; }
  const out = [];
  for (const e of entries) {
    const m = e.name.match(LANG_RE);
    if (m) out.push({ ns: m[1], locale: m[2].toLowerCase(), name: e.name });
  }
  return out;
}

/** 读并解析一个语言文件；失败返回 null */
function readLang(jarPath, entryName) {
  try {
    const hit = zip.readFirst(jarPath, [entryName]);
    if (!hit) return null;
    const j = JSON.parse(hit.data.toString('utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    const out = {};
    for (const k of Object.keys(j)) {
      if (typeof j[k] === 'string') out[k] = j[k];
    }
    return out;
  } catch { return null; }
}

/* ---------------- 单个 jar 的翻译缺口分析 ---------------- */

/**
 * @param {Object} o
 * @param {string} o.jarPath
 * @param {'zh_cn'|'zh_tw'} [o.target] 目标语言，默认 zh_cn
 * @param {boolean} [o.useDict] 是否用内置词典自动填，默认 true
 * @param {Object} [o.extraDict] 用户导入的词典（key → 译文），优先级高于内置
 */
function analyzeJar(o) {
  const opt = /** @type {any} */ (o || {});
  const target = (opt.target || 'zh_cn').toLowerCase();
  const useDict = opt.useDict !== false;
  const extra = opt.extraDict || {};

  const jarPath = opt.jarPath;
  if (!jarPath || !fs.existsSync(jarPath)) {
    return { ok: false, error: `jar 不存在：${jarPath}`, entries: [], stats: null };
  }

  const langs = listLangs(jarPath);
  if (!langs.length) {
    return { ok: false, error: '这个 jar 里没有语言文件（不是标准 mod，或资源内嵌在别处）。', entries: [], stats: null };
  }

  // 英文原文：优先 en_us，其次 en_gb，再退到第一个 en_*
  const enPick = langs.find((l) => l.locale === 'en_us')
    || langs.find((l) => l.locale === 'en_gb')
    || langs.find((l) => l.locale.startsWith('en'))
    || null;
  if (!enPick) {
    return { ok: false, error: '找不到英文语言文件，无法确定原文。', entries: [], stats: null, available: langs };
  }

  const zhPicks = langs.filter((l) => l.locale === target);

  const en = readLang(jarPath, enPick.name) || {};

  // 可能有多份（同名命名空间不同），合并：后面的覆盖前面的
  const existing = {};
  for (const z of zhPicks) {
    const d = readLang(jarPath, z.name);
    if (d) Object.assign(existing, d);
  }

  const entries = [];
  let missing = 0, dictHit = 0, already = 0, skipped = 0;

  for (const key of Object.keys(en)) {
    const src = en[key];
    if (!src || !String(src).trim()) continue;

    // 已有中文且不是"照抄英文"的，算已翻译
    const cur = existing[key];
    if (typeof cur === 'string' && cur.trim() && cur.trim() !== String(src).trim()) {
      already++;
      entries.push({ key, en: src, zh: cur, status: 'translated', source: 'jar' });
      continue;
    }

    // 现有中文等于英文原文 → 作者偷懒，视为未翻译
    if (!worthTranslating(src)) {
      skipped++;
      entries.push({ key, en: src, zh: cur || '', status: 'skip', source: 'none' });
      continue;
    }

    missing++;
    let zh = '';
    let source = 'none';
    if (useDict) {
      const ek = String(src).trim().toLowerCase();
      if (extra[ek]) { zh = extra[ek]; source = 'user'; dictHit++; }
      else {
        const r = translate(src);
        if (r.method === 'phrase' || r.method === 'words') { zh = r.text; source = 'dict'; dictHit++; }
        else if (r.method === 'partial' && r.matched >= Math.max(1, Math.ceil(r.total * 0.6))) {
          zh = r.text; source = 'dict-partial'; dictHit++;
        }
      }
    }
    entries.push({
      key, en: src, zh,
      status: zh ? 'auto' : 'missing',
      source
    });
  }

  // 排序：先待翻译，再自动填充，最后已翻译
  const rank = { missing: 0, auto: 1, translated: 2, skip: 3 };
  entries.sort((a, b) => (rank[a.status] - rank[b.status]) || a.key.localeCompare(b.key));

  const total = entries.filter((e) => e.status !== 'skip').length || 1;
  const covered = entries.filter((e) => e.status === 'translated' || e.status === 'auto').length;

  return {
    ok: true,
    jarPath,
    jarName: path.basename(jarPath),
    target,
    source: enPick.name,
    available: langs.map((l) => l.locale),
    entries,
    stats: {
      total,                       // 需要中文的条目数
      already,                     // jar 里本来就有中文
      missing,                     // 完全没中文（含词典命中）
      autoFilled: entries.filter((e) => e.status === 'auto').length,
      stillMissing: entries.filter((e) => e.status === 'missing').length,
      dictHit,
      skipped,
      coverage: Math.round((covered / total) * 100)
    }
  };
}

/* ---------------- 生成独立资源包 ---------------- */

/**
 * 从分析结果生成资源包的 lang JSON 内容。
 * 只收录"有中文可填"的条目（已翻译的不需要重复，除非 force 全量）。
 *
 * @param {Object} analysis analyzeJar 的返回值
 * @param {{includeTranslated?:boolean}} [opts]
 * @returns {{langs:Object<string,Object>, count:number, ns?:string}}
 *   langs 的 key 是资源包内路径，如 'assets/mymod/lang/zh_cn.json'
 *   ns 是识别出的命名空间（analysis 无效时无此字段）
 */
function buildPackFiles(analysis, opts) {
  const o = /** @type {any} */ (opts || {});
  if (!analysis || !analysis.ok) return { langs: {}, count: 0 };

  // 按命名空间归组：key 形如 "block.example.foo"，命名空间从 jar 的 assets/ 路径里拿
  // 但我们丢掉了 ns —— 从 source 路径反推：assets/<ns>/lang/en_us.json
  const m = String(analysis.source || '').match(/^assets\/([^/]+)\//);
  const ns = m ? m[1] : 'minecraft';

  const zh = {};
  const tw = {};
  let count = 0;
  for (const e of analysis.entries) {
    if (e.status === 'skip') continue;
    if (e.status === 'translated' && !o.includeTranslated) continue;
    if (!e.zh) continue;
    zh[e.key] = e.zh;
    count++;
    // 简繁粗转换：只对少数常用字做替换，够用于起步（用户可手改）
    if (analysis.target === 'zh_tw' || true) {
      tw[e.key] = toTraditional(e.zh);
    }
  }

  const files = {};
  files[`assets/${ns}/lang/zh_cn.json`] = zh;
  if (Object.keys(tw).length) files[`assets/${ns}/lang/zh_tw.json`] = tw;
  return { langs: files, count, ns };
}

/**
 * 极简简→繁映射（覆盖 MC 常见字；不做完整转换，够起步）。
 *
 * 只放「简繁确实不同」的字 —— 同形字（如 石/羊/僵/骷）放进来只是噪声，
 * 而且会让"这个字到底转没转"变得不可读。表按主题分段维护：
 *   材质物品 → 生物 → 界面/操作 → 品级 → 时间数量 → 补充高频
 * 顺序即插入顺序，**键必须唯一**（对象字面量里重复键后者胜，
 * 会让先写的那条静默失效 —— 曾经因为补丁叠加出 27 个重复键）。
 */
const S2T = {
  钻: '鑽', 铁: '鐵', 剑: '劍', 镐: '鎬', 锹: '鍬', 锄: '鋤', 灵: '靈', 药: '藥',
  酿: '釀', 锅: '鍋', 炉: '爐', 烟: '煙', 圆: '圓', 砾: '礫', 砖: '磚', 阶: '階',
  栏: '欄', 门: '門', 灯: '燈', 贝: '貝', 锭: '錠', 粒: '粒', 宝: '寶', 石: '石',
  龙: '龍', 龟: '龜', 猫: '貓', 鸟: '鳥', 鸡: '雞', 马: '馬', 鱼: '魚', 兽: '獸',
  猪: '豬', 潜: '潛', 翼: '翼', 监: '監', 炽: '熾', 卫: '衛', 劫: '劫', 掠: '掠',
  唤: '喚', 幻: '幻', 实: '實', 体: '體', 动: '動', 设: '設', 项: '項', 选: '選',
  单: '單', 钮: '鈕', 页: '頁', 签: '籤', 筛: '篩', 表: '表', 启: '啟', 禁: '禁',
  开: '開', 关: '關', 无: '無', 认: '認', 确: '確', 闭: '閉', 删: '刪', 复: '複',
  制: '製', 贴: '貼', 导: '導', 载: '載', 织: '織', 层: '層', 组: '組', 状: '狀',
  伤: '傷', 击: '擊', 御: '禦', 经: '經', 验: '驗', 级: '級', 准: '準', 采: '採',
  锋: '鋒', 杀: '殺', 节: '節', 护: '護', 补: '補', 荆: '荊', 抢: '搶', 夺: '奪',
  冲: '衝', 诱: '誘', 饵: '餌', 眷: '眷', 顾: '顧', 探: '探', 呼: '呼', 吸: '吸',
  亲: '親', 轻: '輕', 弹: '彈', 射: '射', 产: '產', 输: '輸', 催: '催', 燃: '燃',
  储: '儲', 罐: '罐', 液: '液', 气: '氣', 蒸: '蒸', 机: '機', 发: '發', 电: '電',
  应: '應', 涡: '渦', 轮: '輪', 缆: '纜', 线: '線', 容: '容', 吞: '吞', 传: '傳',
  压: '壓', 池: '池', 阻: '阻', 抗: '抗', 颜: '顏', 红: '紅', 蓝: '藍', 绿: '綠',
  黄: '黃', 灰: '灰', 浅: '淺', 深: '深', 淡: '淡', 亮: '亮', 普: '普', 通: '通',
  稀: '稀', 罕: '罕', 见: '見', 史: '史', 诗: '詩', 话: '話', 神: '神', 说: '說',
  诅: '詛', 祝: '祝', 圣: '聖', 黑: '黑', 暗: '暗', 恶: '惡', 远: '遠', 旧: '舊',
  破: '破', 损: '損', 裂: '裂', 纹: '紋', 坚: '堅', 固: '固', 炼: '煉', 纯: '純',
  净: '淨', 致: '緻', 密: '密', 钟: '鐘', 时: '時', 总: '總', 计: '計', 数: '數',
  增: '增', 减: '減', 饰: '飾', 果: '果', 长: '長', 冷: '冷', 却: '卻', 范: '範',
  围: '圍', 径: '徑', 区: '區', 域: '域', 几: '幾', 概: '概', 顶: '頂', 侧: '側',
  内: '內', 外: '外', 重: '重', 块: '塊', 书: '書', 台: '臺', 墙: '牆', 栅: '柵',
  篱: '籬', 柜: '櫃', 屉: '屜', 橱: '櫥', 窑: '窯', 瓮: '甕', 车: '車', 轨: '軌',
  矿: '礦', 铲: '鏟', 壳: '殼', 绳: '繩', 链: '鏈', 环: '環', 笼: '籠', 裤: '褲',
  袜: '襪', 铠: '鎧', 镜: '鏡', 盘: '盤', 壶: '壺', 坛: '壇', 篓: '簍', 篮: '籃',
  铜: '銅', 银: '銀', 锡: '錫', 铅: '鉛', 锌: '鋅', 镍: '鎳', 钛: '鈦', 铝: '鋁',
  盐: '鹽', 碱: '鹼', 蜡: '蠟', 胶: '膠', 纤: '纖', 维: '維', 纶: '綸', 绵: '綿',
  绸: '綢', 缎: '緞', 绢: '絹', 纱: '紗', 凤: '鳳', 虫: '蟲', 蚁: '蟻', 蝎: '蠍',
  蜗: '蝸', 鲲: '鯤', 鲸: '鯨', 鲨: '鯊', 鳗: '鰻', 鲑: '鮭', 鳕: '鱈', 鲈: '鱸',
  鲤: '鯉', 鲫: '鯽', 鲍: '鮑', 蚝: '蠔', 虾: '蝦', 泽: '澤', 湾: '灣', 峡: '峽',
  岭: '嶺', 岛: '島', 滩: '灘', 丛: '叢', 藓: '蘚', 霉: '黴', 茎: '莖', 叶: '葉',
  荚: '莢', 云: '雲', 雾: '霧', 闪: '閃', 烬: '燼', 灭: '滅', 温: '溫', 冻: '凍',
  馏: '餾', 涌: '湧', 涛: '濤', 澜: '瀾', 键: '鍵', 标: '標', 题: '題', 图: '圖',
  乐: '樂', 声: '聲', 响: '響', 静: '靜', 语: '語', 词: '詞', 录: '錄', 档: '檔',
  册: '冊', 码: '碼', 号: '號', 编: '編', 辑: '輯', 阅: '閱', 读: '讀', 写: '寫',
  备: '備', 终: '終', 结: '結', 断: '斷', 续: '續', 暂: '暫', 挂: '掛', 装: '裝',
  参: '參', 额: '額', 别: '別', 类: '類', 种: '種', 统: '統', 双: '雙', 对: '對',
  错: '錯', 误: '誤', 败: '敗', 余: '餘', 将: '將', 过: '過', 来: '來', 达: '達',
  离: '離', 缩: '縮', 叠: '疊', 择: '擇', 询: '詢', 问: '問', 报: '報', 记: '記',
  志: '誌', 周: '週', 约: '約', 规: '規', 则: '則', 条: '條', 样: '樣', 权: '權',
  许: '許', 与: '與', 异: '異', 满: '滿', 坏: '壞', 换: '換',
};

/** 简 → 繁（逐字映射，未收录的原样保留） */
function toTraditional(s) {
  let out = '';
  for (const ch of String(s)) out += S2T[ch] || ch;
  return out;
}

module.exports = {
  translate, analyzeJar, buildPackFiles, listLangs, readLang,
  worthTranslating, toTraditional,
  PHRASES, WORDS, SKIP_WORDS
};
