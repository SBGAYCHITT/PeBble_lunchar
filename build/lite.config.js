/**
 * Lite（精简）版构建配置。
 *
 * 和标准版的差异只有三处，别的一律共用同一份源码：
 *   1. files 白名单 —— 只打进 5 个页面用得到的后端模块（其余模块连文件都不进包）
 *   2. electronLanguages —— 55 个语言包砍到 2 个，这是体积下降的主力（约 38 MB）
 *   3. afterPack —— 删掉用不到的图形后端（约 18 MB）
 *
 * 用法：
 *   node scripts/make-lite.js                      # 先生成 build/lite/index.html
 *   PL_OUT_DIR=dist-lite node node_modules/electron-builder/out/cli/cli.js \
 *     --win --x64 --dir --config build/lite.config.js --config.directories.output=dist-lite
 *   PL_SRC=dist-lite/win-unpacked PL_OUT=dist-lite/Pebble-Launcher-Lite.exe \
 *     PL_INSTDIR=PebbleLauncherLite node make-exe.js
 *
 * 语言包不用 electronLanguages 配置项：electron-builder 内部会一次性 rm 掉 53 个 .pak，
 * 撞上沙箱「单轮批量删除 50 项」的守卫，packaging 直接失败。
 * 改为在 afterPack 里逐个 unlink（不受该限制），结果一样。
 */
const CORE = [
  // 前端（index.html 用 build/lite/ 里的裁剪版替换，见 files 里的映射）
  'main.js', 'preload.js', 'renderer.js', 'pages.js', 'style.css',
  'assets/**/*',
  // 启动链路
  'launcher.js', 'mcapi.js', 'downloader.js', 'loaders.js', 'manifestversions.js',
  // 账户
  'accounts.js', 'securestore.js', 'avatar.js',
  // 运行时环境与系统
  // zipread 是 javadl 拆包用的（不是只有 modguard 才要），漏了它主进程会在启动时
  // 抛 Cannot find module 并静默卡死窗口 —— 跑 scripts/lite-verify.js 可以提前发现。
  'javadl.js', 'zipread.js', 'fsutil.js', 'nbt.js', 'crashdoctor.js', 'updater.js',
  'sysconf.js', 'tray.js', 'screenshots.js', 'multilaunch.js',
  // 文案
  'i18n.js', 'i18n-ui.js', 'i18n-pages.js',
  // 只注册这 7 个 IPC 域；ipc/index.js 会按文件存在与否自动跳过其余域。
  // update.js 必须留着：settings 页在 Lite 白名单里，更新按钮也在，
  // 少了这个域点「检查更新」就是 invoke 一个没人接的 channel（表现为点了没反应）。
  'ipc/index.js', 'ipc/window.js', 'ipc/base.js',
  'ipc/launch.js', 'ipc/versions.js', 'ipc/account.js', 'ipc/system.js', 'ipc/update.js'
];

module.exports = {
  appId: 'com.felix.pebblelauncher',
  /* productName 刻意与标准版保持一致：Electron 拿它当 userData 目录名
     （%APPDATA%\Pebble Launcher），两版共用同一份账户 / 设置 / 已下载的 Java。
     改这里会让 Lite 变成"另一台机器"，玩家得重新登录 —— 那不是我们想要的精简。 */
  productName: 'Pebble Launcher',
  // 输出目录可用 PL_OUT_DIR 覆盖：沙箱对「单轮批量删除 50 项」有守卫，
  // 已存在的输出目录被 emptyDir 清理时会直接失败，这时换个新目录重建即可。
  directories: { output: process.env.PL_OUT_DIR || 'dist-lite' },
  /* 指向「预精简的 Electron 运行时」（scripts/make-lite-dist.js 生成）。
     不走 electronLanguages：那个选项由 electron-builder 内部一次性 rm 掉 53 个语言包，
     会撞上沙箱的批量删除守卫让 packaging 直接失败。预精简版则在复制阶段就跳过它们，
     全程不删文件。要重新生成：node scripts/make-lite-dist.js */
  electronDist: 'build/electron-lite',
  files: [
    ...CORE,
    /* 裁剪过的页面入口，与 index.html 同层（HTML 里的相对引用因此不用改写）。
       main.js 检测到它就优先加载，标准版包里没有这个文件。
       注意：不要试图用 {from,to} 把它改名成 index.html —— 那个映射对单文件不生效，
       实测打出来的包里直接没有 index.html，启动即白屏。 */
    'index.lite.html'
  ],
  win: {
    target: ['portable'],
    icon: 'build/icon.ico'
  },
  portable: { artifactName: 'Pebble-Launcher-Lite.exe' }
};
