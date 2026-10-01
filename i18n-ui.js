// 渲染层文案字典（i18n-ui.js）。
//
// 负责给 renderer.js / index.html 里用到的「业务文案」提供 zh-CN + en-US 双语。
// 通过 I18N.addDict 增量挂进来（i18n.js 先加载，这里后加载，顺序在 index.html 里保证）。
//
// 命名空间约定：
//   sec.*     安全 / 加密存储
//   acc.*     账户（离线 / 外置 / 微软）
//   launch.*  启动页
//   java.*    Java 检测与自动下载
//   status.*  状态栏（基础项在 i18n.js 基础字典，这里补带参数的）
//   common.*  通用（补 unknown / fail）
//   sys.*     系统设置（自启 / 托盘）
//   sc.*      快捷方式
//   upd.*     更新检查
//   lang.*    语言名
//   set.*     设置（补 optionsSaved）
//   dl.*      版本清单 / 下载
//   ml.*      并行多开
//   about.*   关于页
//   log.*     日志前缀
//
// 带 {{x}} 的占位符由 T(key, { x }) 注入；带 HTML 的字符串仍用于 innerHTML。
(function (root) {
  const I18N = (typeof module === 'object' && module.exports) ? null : root.I18N;

  const ZH = {
    'sec.degraded': '当前系统不支持加密存储，敏感凭据不会被保存，需要重新登录。',
    'sec.migrated': '已把历史明文账户迁移到加密存储。',
    'sec.loadFail': '读取加密账户失败: ',

    'acc.notLoggedIn': '未登录',
    'acc.type.offline': '离线模式',
    'acc.type.ygg': '外置登录',
    'acc.type.ms': '微软账户',
    'acc.nameInvalid': '玩家名无效',
    'acc.offlineAdded': '已添加离线账户: {{name}}',
    'acc.yggFill': '请填写完整的外置登录信息',
    'acc.yggLogging': '正在登录外置账户…',
    'acc.yggFail': '外置登录失败: {{err}}',
    'acc.yggOk': '外置登录成功: {{name}}',
    'acc.msWaiting': '等待微软授权…',
    'acc.msFail': '微软登录失败: {{err}}',
    'acc.msOk': '微软账户登录成功: {{name}}',

    'launch.needMcDir': '请先设置 .minecraft 目录',
    'launch.noVersion': '未找到版本<br /><small>去「版本」页下载或安装加载器</small>',
    'launch.missingJar': ' · 缺 jar',
    'launch.needAccount': '请先在「账户」页登录，或填写有效的玩家名',
    'launch.pickVersion': '请选择游戏版本',
    'launch.launching': '<span class="launch-icon">◈</span> 启动中…',
    'launch.failed': '启动失败: ',
    'launch.logPrefix': '[启动器] ',
    'launch.runningJava': '游戏运行中 · Java ',
    'launch.button': '<span class="launch-icon">▶</span> 启动游戏',

    'java.autoStart': '未检测到可用 Java，开始自动下载 Temurin Java {{major}}…',
    'java.autoStatus': '未找到 Java，正在自动下载 Java {{major}}…',
    'java.autoFail': 'Java 自动下载失败',
    'java.autoFailLog': '自动下载失败: {{err}}（可在设置页手动指定 javaw.exe）',
    'java.reused': '复用已安装的 ',
    'java.installedTo': '已安装到 ',
    'java.autoInstalled': 'Java {{major}} · 自动安装',
    'java.detecting': '正在检测 Java…',
    'java.suggest': 'Java {{ver}} · 该版本建议 Java {{need}}+',
    'java.tooLow': 'Java 版本可能偏低',
    'java.autoDownloading': '未检测到 Java，正在自动下载…',
    'java.none': '尚未下载任何 Java',
    'java.noBinary': '未找到可执行文件',
    'java.dlPreparing': '准备中…',
    'java.dlCached': '已安装过：',
    'java.dlDone': '安装完成：',

    'status.ready': '就绪',
    'status.starting': '正在启动…',
    'status.noJava': '缺少 Java',
    'status.running': '游戏运行中',
    'status.error': '游戏异常',
    'status.exited': '游戏已退出',
    'status.errorCode': '游戏异常 (code {{code}})',
    'status.exitCode': '游戏异常退出 (code {{code}})',

    'common.unknown': '未知',
    'common.delete': '删除',
    'common.fail': '失败: ',

    'sys.autostartOn': '已设为开机自启',
    'sys.autostartOff': '已取消开机自启',
    'sys.autostartFail': '设置开机自启失败',
    'sys.trayHintOn': '关闭窗口将最小化到托盘（托盘图标可叫回来）',
    'sys.trayHintOff': '关闭窗口将直接退出',

    'sc.desktopOk': '已创建桌面快捷方式',
    'sc.startOk': '已创建开始菜单快捷方式',
    'sc.removed': '已移除快捷方式',

    'upd.checking': '正在检查…',
    'upd.checkFailed': '检查失败: ',
    'upd.found': '发现新版 {{latest}}（当前 {{current}}）',
    'upd.openPage': ' · 打开下载页',
    'upd.logPrefix': '[更新] ',
    'upd.latest': '已是最新版（{{current}}）',

    'lang.zhCN': '简体中文',

    'set.optionsSaved': '已保存到 options.txt',

    'dl.manifestFail': '清单获取失败，检查网络',

    'ml.stopped': '已结束 {{n}} 个游戏进程',
    'ml.noneRunning': '没有正在运行的游戏',

    'about.version': '版本 {{version}} · Electron {{electron}} · Node {{node}}',

    'log.download': '[下载] ',
    'log.page': '[页面] '
  };

  const EN = {
    'sec.degraded': 'This system does not support encrypted storage; credentials will not be saved and you will need to log in again.',
    'sec.migrated': 'Migrated legacy plaintext accounts into encrypted storage.',
    'sec.loadFail': 'Failed to read encrypted accounts: ',

    'acc.notLoggedIn': 'Not logged in',
    'acc.type.offline': 'Offline',
    'acc.type.ygg': 'External auth',
    'acc.type.ms': 'Microsoft',
    'acc.nameInvalid': 'Invalid player name',
    'acc.offlineAdded': 'Offline account added: {{name}}',
    'acc.yggFill': 'Fill in all external-login fields',
    'acc.yggLogging': 'Logging into external account…',
    'acc.yggFail': 'External login failed: {{err}}',
    'acc.yggOk': 'External login succeeded: {{name}}',
    'acc.msWaiting': 'Waiting for Microsoft authorization…',
    'acc.msFail': 'Microsoft login failed: {{err}}',
    'acc.msOk': 'Microsoft account signed in: {{name}}',

    'launch.needMcDir': 'Set the .minecraft folder first',
    'launch.noVersion': 'No version found<br /><small>Download or install a loader in the Versions tab</small>',
    'launch.missingJar': ' · missing jar',
    'launch.needAccount': 'Log in on the Accounts tab, or enter a valid player name',
    'launch.pickVersion': 'Select a game version',
    'launch.launching': '<span class="launch-icon">◈</span> Launching…',
    'launch.failed': 'Launch failed: ',
    'launch.logPrefix': '[Launcher] ',
    'launch.runningJava': 'Game running · Java ',
    'launch.button': '<span class="launch-icon">▶</span> Launch',

    'java.autoStart': 'No Java found; downloading Temurin Java {{major}}…',
    'java.autoStatus': 'No Java found; downloading Java {{major}}…',
    'java.autoFail': 'Java auto-download failed',
    'java.autoFailLog': 'Auto-download failed: {{err}} (set javaw.exe manually in Settings)',
    'java.reused': 'Reusing installed ',
    'java.installedTo': 'Installed to ',
    'java.autoInstalled': 'Java {{major}} · auto-installed',
    'java.detecting': 'Detecting Java…',
    'java.suggest': 'Java {{ver}} · this version recommends Java {{need}}+',
    'java.tooLow': 'Java version may be too low',
    'java.autoDownloading': 'No Java detected; downloading…',
    'java.none': 'No downloaded Java yet',
    'java.noBinary': 'Executable not found',
    'java.dlPreparing': 'Preparing…',
    'java.dlCached': 'Already installed: ',
    'java.dlDone': 'Installed: ',

    'status.ready': 'Ready',
    'status.starting': 'Launching…',
    'status.noJava': 'No Java found',
    'status.running': 'Game running',
    'status.error': 'Game crashed',
    'status.exited': 'Game exited',
    'status.errorCode': 'Game crashed (code {{code}})',
    'status.exitCode': 'Game exited abnormally (code {{code}})',

    'common.unknown': 'unknown',
    'common.delete': 'Delete',
    'common.fail': 'Failed: ',

    'sys.autostartOn': 'Launch at login enabled',
    'sys.autostartOff': 'Launch at login disabled',
    'sys.autostartFail': 'Failed to set launch-at-login',
    'sys.trayHintOn': 'Closing the window will minimize to tray (tray icon brings it back)',
    'sys.trayHintOff': 'Closing the window will quit',

    'sc.desktopOk': 'Desktop shortcut created',
    'sc.startOk': 'Start-menu shortcut created',
    'sc.removed': 'Shortcuts removed',

    'upd.checking': 'Checking…',
    'upd.checkFailed': 'Check failed: ',
    'upd.found': 'New version {{latest}} available (current {{current}})',
    'upd.openPage': ' · Open download page',
    'upd.logPrefix': '[Update] ',
    'upd.latest': 'Up to date ({{current}})',

    'lang.zhCN': 'Chinese (Simplified)',

    'set.optionsSaved': 'Saved to options.txt',

    'dl.manifestFail': 'Failed to fetch version list, check your network',

    'ml.stopped': 'Stopped {{n}} game process(es)',
    'ml.noneRunning': 'No game running',

    'about.version': 'Version {{version}} · Electron {{electron}} · Node {{node}}',

    'log.download': '[download] ',
    'log.page': '[page] '
  };

  if (I18N && I18N.addDict) {
    I18N.addDict('zh-CN', ZH);
    I18N.addDict('en-US', EN);
  }
  if (typeof module === 'object' && module.exports) module.exports = { ZH, EN };
})(typeof self !== 'undefined' ? self : this);
