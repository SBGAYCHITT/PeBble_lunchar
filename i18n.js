// 轻量 i18n：字典 + t()，未命中的 key 回退到中文，再不济回退成 key 本身。
//
// 为什么这么设计：一次性把几百处文案全部抽成 key 风险太高（漏一个就是界面上一个洞）。
// 现在的策略是"渐进迁移"——已迁移的走字典，没迁移的原样渲染中文，
// 所以任何时候切语言都不会白屏/报错，覆盖率可以慢慢补。
/**
 * UMD 包装：既能在主进程 require，也能直接用 <script> 挂到 window.I18N。
 * @param {any} root  全局对象（浏览器是 self/window，Node 走 module.exports 分支）
 * @param {() => any} factory
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (/** @type {any} */ (root)).I18N = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DICT = {
    'zh-CN': {
      'nav.launch': '启动', 'nav.versions': '版本', 'nav.instances': '实例', 'nav.mods': 'Mod',
      'nav.rps': '资源包', 'nav.shaders': '光影', 'nav.saves': '存档', 'nav.shots': '截图',
      'nav.account': '账户', 'nav.lab': '调优', 'nav.logs': '日志', 'nav.settings': '设置', 'nav.about': '关于', 'nav.world': '世界', 'nav.perf': '性能',
      'common.refresh': '刷新', 'common.openFolder': '打开目录', 'common.delete': '删除',
      'common.browse': '浏览', 'common.autoDetect': '自动检测', 'common.save': '保存',
      'common.cancel': '取消', 'common.close': '关闭', 'common.loading': '加载中…',
      'status.ready': '就绪', 'status.running': '游戏运行中', 'status.error': '游戏异常',
      'status.exited': '游戏已退出', 'status.noJava': '缺少 Java', 'status.starting': '正在启动…',
      'set.game': '游戏', 'set.download': '下载', 'set.appearance': '外观',
      'set.options': '游戏内设置（options.txt）', 'set.system': '系统与更新',
      'set.mcdir': '.minecraft 目录', 'set.java': 'Java 路径', 'set.jvm': '额外 JVM 参数',
      'set.hide': '启动后隐藏启动器窗口', 'set.isolation': '为每个版本使用独立游戏目录',
      'set.source': '下载源', 'set.threads': '并发线程', 'set.theme': '主题',
      'set.opacity': '窗口不透明度', 'set.animation': '启用过渡动画',
      'sys.autostart': '开机自动启动', 'sys.tray': '关闭时最小化到托盘',
      'sys.shortcut': '创建快捷方式', 'sys.shortcutDesktop': '桌面',
      'sys.shortcutStart': '开始菜单', 'sys.language': '界面语言',
      'sys.checkUpdate': '检查更新', 'sys.updateFeed': '更新源地址（JSON）',
      'shots.organize': '按日期整理', 'shots.organizeHint': '把截图按拍摄月份归档到子目录',
      'shots.empty': '没有截图', 'shots.count': '共 {{n}} 张',
      'tray.show': '显示窗口', 'tray.hide': '隐藏窗口',
      'tray.launch': '启动游戏', 'tray.launching': '正在启动…',
      'tray.running': '游戏运行中（{{n}}）', 'tray.stopall': '结束全部游戏',
      'tray.openDir': '打开游戏目录', 'tray.autostart': '开机自动启动',
      'tray.quit': '退出启动器', 'tray.tooltip': 'Pebble Lunchar · {{name}}{{ver}}{{run}}'
    },
    'en-US': {
      'nav.launch': 'Launch', 'nav.versions': 'Versions', 'nav.instances': 'Instances', 'nav.mods': 'Mods',
      'nav.rps': 'Resource Packs', 'nav.shaders': 'Shaders', 'nav.saves': 'Saves', 'nav.shots': 'Screenshots',
      'nav.account': 'Accounts', 'nav.lab': 'Tuning', 'nav.logs': 'Logs', 'nav.settings': 'Settings', 'nav.about': 'About', 'nav.world': 'World', 'nav.perf': 'Performance',
      'common.refresh': 'Refresh', 'common.openFolder': 'Open folder', 'common.delete': 'Delete',
      'common.browse': 'Browse', 'common.autoDetect': 'Auto-detect', 'common.save': 'Save',
      'common.cancel': 'Cancel', 'common.close': 'Close', 'common.loading': 'Loading…',
      'status.ready': 'Ready', 'status.running': 'Game running', 'status.error': 'Game crashed',
      'status.exited': 'Game exited', 'status.noJava': 'No Java found', 'status.starting': 'Launching…',
      'set.game': 'Game', 'set.download': 'Downloads', 'set.appearance': 'Appearance',
      'set.options': 'In-game settings (options.txt)', 'set.system': 'System & Updates',
      'set.mcdir': '.minecraft folder', 'set.java': 'Java path', 'set.jvm': 'Extra JVM args',
      'set.hide': 'Hide launcher after launch', 'set.isolation': 'Separate game folder per version',
      'set.source': 'Download source', 'set.threads': 'Threads', 'set.theme': 'Theme',
      'set.opacity': 'Window opacity', 'set.animation': 'Enable transitions',
      'sys.autostart': 'Launch at login', 'sys.tray': 'Minimize to tray on close',
      'sys.shortcut': 'Create shortcuts', 'sys.shortcutDesktop': 'Desktop',
      'sys.shortcutStart': 'Start Menu', 'sys.language': 'Language',
      'sys.checkUpdate': 'Check for updates', 'sys.updateFeed': 'Update feed URL (JSON)',
      'shots.organize': 'Organize by date', 'shots.organizeHint': 'Move screenshots into monthly subfolders',
      'shots.empty': 'No screenshots', 'shots.count': '{{n}} screenshots',
      'tray.show': 'Show window', 'tray.hide': 'Hide window',
      'tray.launch': 'Launch game', 'tray.launching': 'Launching…',
      'tray.running': '{{n}} game(s) running', 'tray.stopall': 'Stop all games',
      'tray.openDir': 'Open game folder', 'tray.autostart': 'Launch at login',
      'tray.quit': 'Quit launcher', 'tray.tooltip': 'Pebble Lunchar · {{name}}{{ver}}{{run}}'
    }
  };

  const DEFAULT_LANG = 'zh-CN';
  let current = DEFAULT_LANG;

  /**
   * 增量注册文案（供 i18n-ui.js 这类大字典分批挂进来）。
   * 后注册的覆盖先注册的，方便按页面拆分文件。
   * @param {string} code 语言代码
   * @param {Record<string, string>} obj 文案表
   * @param {string} [name] 语言显示名（未注册过的语言才用得上）
   */
  function addDict(code, obj, name) {
    if (!code || !obj) return;
    DICT[code] = Object.assign(DICT[code] || {}, obj);
    if (name && !NAME[code]) NAME[code] = name;
  }

  function available() {
    return Object.keys(DICT).map((code) => ({ code, name: NAME[code] || code }));
  }
  const NAME = { 'zh-CN': '简体中文', 'en-US': 'English' };

  function setLang(code) { if (DICT[code]) current = code; else current = DEFAULT_LANG; return current; }
  function getLang() { return current; }

  /** 取文案：当前语言 → 默认语言 → fallback → key 本身（永不返回 undefined，避免界面出现 undefined）
   *  fallback 是渐进迁移的关键：代码里可以先写 t('x', '中文原文')，
   *  字典还没补英文时照样显示中文，不会白屏。 */
  function t(key, params, fallback) {
    let s = (DICT[current] && DICT[current][key]);
    if (s == null) s = (DICT[DEFAULT_LANG] && DICT[DEFAULT_LANG][key]);
    if (s == null) s = fallback;
    if (s == null) return String(key);
    if (params) {
      for (const k of Object.keys(params)) s = s.split('{{' + k + '}}').join(String(params[k]));
    }
    return s;
  }

  /** 把带 data-i18n 的元素批量刷成当前语言；data-i18n-attr 指定写哪个属性（默认 textContent）；
   *  data-i18n-fb 给一个中文兜底（字典还没补英文时用，避免界面露出裸 key） */
  function applyDom(root) {
    if (typeof document === 'undefined') return 0;
    const scope = root || document;
    let n = 0;
    const nodes = scope.querySelectorAll('[data-i18n]');
    for (const el of nodes) {
      const key = el.getAttribute('data-i18n');
      const attr = el.getAttribute('data-i18n-attr');
      const fb = el.getAttribute('data-i18n-fb');
      const val = t(key, null, fb || undefined);
      if (attr) el.setAttribute(attr, val); else el.textContent = val;
      n++;
    }
    return n;
  }

  /** 默认语言里已收录的全部 key（用于校验其它语言的覆盖率） */
  function keys() { return Object.keys(DICT[DEFAULT_LANG] || {}); }

  /** 某个语言相对默认语言缺了哪些 key */
  function missing(code) {
    const target = DICT[code];
    if (!target) return keys();
    return keys().filter((k) => target[k] == null);
  }

  return { t, setLang, getLang, available, applyDom, keys, missing, addDict, DEFAULT_LANG, langs: Object.keys(DICT) };
});
