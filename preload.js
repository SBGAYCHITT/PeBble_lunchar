const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  /* 基础 */
  defaultMcDir: () => ipcRenderer.invoke('default-mcdir'),
  listVersions: (mcDir) => ipcRenderer.invoke('list-versions', mcDir),
  detectJava: (mcDir, preferMajor) => ipcRenderer.invoke('detect-java', mcDir, preferMajor),
  pickDirectory: () => ipcRenderer.invoke('pick-directory'),
  pickFile: (filters) => ipcRenderer.invoke('pick-file', filters),
  saveFile: (name, filters) => ipcRenderer.invoke('save-file', name, filters),

  /* 启动 */
  launch: (opts) => ipcRenderer.invoke('launch', opts),

  /* 下载与加载器 */
  getManifest: () => ipcRenderer.invoke('get-manifest'),
  installVersion: (opts) => ipcRenderer.invoke('install-version', opts),
  loaderVersions: (kind, mcVersion) => ipcRenderer.invoke('loader-versions', kind, mcVersion),
  installLoader: (opts) => ipcRenderer.invoke('install-loader', opts),

  /* 资源目录 */
  listMods: (gd) => ipcRenderer.invoke('list-mods', gd),
  listResourcepacks: (gd) => ipcRenderer.invoke('list-resourcepacks', gd),
  listShaderpacks: (gd) => ipcRenderer.invoke('list-shaderpacks', gd),
  listSaves: (gd) => ipcRenderer.invoke('list-saves', gd),
  listScreenshots: (gd) => ipcRenderer.invoke('list-screenshots', gd),
  listCrashes: (gd) => ipcRenderer.invoke('list-crashes', gd),
  readLog: (p, len) => ipcRenderer.invoke('read-log', p, len),
  toggleFile: (p) => ipcRenderer.invoke('toggle-file', p),
  deletePath: (p) => ipcRenderer.invoke('delete-path', p),
  openFolder: (p) => ipcRenderer.invoke('open-folder', p),
  copyFile: (src, destDir) => ipcRenderer.invoke('copy-file', src, destDir),
  zipDir: (src, destZip) => ipcRenderer.invoke('zip-dir', src, destZip),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  showInExplorer: (p) => ipcRenderer.invoke('show-in-explorer', p),
  readOptions: (gd) => ipcRenderer.invoke('read-options', gd),
  writeOptions: (gd, patch) => ipcRenderer.invoke('write-options', gd, patch),

  /* 版本操作 */
  versionAction: (action, args) => ipcRenderer.invoke('version-action', action, args),

  /* 账户 */
  accountOffline: (name) => ipcRenderer.invoke('account-offline', name),
  accountYggdrasil: (server, user, pass) => ipcRenderer.invoke('account-yggdrasil', server, user, pass),
  accountMicrosoft: (clientId) => ipcRenderer.invoke('account-microsoft', clientId),

  /* 凭据加密存储（替代明文 localStorage） */
  accountStoreLoad: () => ipcRenderer.invoke('account-store-load'),
  accountStoreSave: (data) => ipcRenderer.invoke('account-store-save', data),
  accountStoreClear: () => ipcRenderer.invoke('account-store-clear'),

  /* 头像（主进程抓图，规避 CSP） */
  avGet: (o) => ipcRenderer.invoke('av-get', o),
  avBatch: (list, size, kind) => ipcRenderer.invoke('av-batch', list, size, kind),
  avClear: () => ipcRenderer.invoke('av-clear'),
  avCacheSize: () => ipcRenderer.invoke('av-cache-size'),

  /* 多账户并行 */
  mlList: () => ipcRenderer.invoke('ml-list'),
  mlStop: (key) => ipcRenderer.invoke('ml-stop', key),
  mlStopAll: () => ipcRenderer.invoke('ml-stop-all'),
  mlBusy: (o) => ipcRenderer.invoke('ml-busy', o),
  onMlChanged: (cb) => { ipcRenderer.on('ml-changed', (_e, items) => cb(items)); },

  /* JVM A/B 调优实验室 */
  labPresets: (javaMajor) => ipcRenderer.invoke('lab-presets', javaMajor),
  labMemAdvice: () => ipcRenderer.invoke('lab-mem-advice'),
  labRun: (o) => ipcRenderer.invoke('lab-run', o),
  labHistory: () => ipcRenderer.invoke('lab-history'),
  labSummary: () => ipcRenderer.invoke('lab-summary'),
  labCompare: (a, b) => ipcRenderer.invoke('lab-compare', a, b),
  labClear: () => ipcRenderer.invoke('lab-clear'),
  onLabProgress: (cb) => { ipcRenderer.on('lab-progress', (_e, p) => cb(p)); },

  /* 崩溃报告 */
  readCrashReport: (p) => ipcRenderer.invoke('read-crash-report', p),
  copyText: (t) => ipcRenderer.invoke('copy-text', t),

  /* 资源包 / 光影元信息 + Mod 真实元数据 */
  packInfo: (list, kind, mcVersion) => ipcRenderer.invoke('pack-info', list, kind, mcVersion),
  modMeta: (modsDir) => ipcRenderer.invoke('mod-meta', modsDir),

  /* 在线仓库（Modrinth / CurseForge） */
  storeSearch: (o) => ipcRenderer.invoke('store-search', o),
  storeMcVersions: () => ipcRenderer.invoke('store-mc-versions'),
  storeDetails: (o) => ipcRenderer.invoke('store-details', o),
  storeVersions: (o) => ipcRenderer.invoke('store-versions', o),
  storeInstall: (o) => ipcRenderer.invoke('store-install', o),
  storeImage: (url) => ipcRenderer.invoke('store-image', url),
  storeLocalHashes: (dir) => ipcRenderer.invoke('store-local-hashes', dir),
  storeKeyStatus: () => ipcRenderer.invoke('store-key-status'),
  storeKeySet: (v) => ipcRenderer.invoke('store-key-set', v),
  onStoreProgress: (cb) => { ipcRenderer.on('store-progress', (_e, p) => cb(p)); },

  /* 存档时光机（块级去重快照） */
  tmDir: () => ipcRenderer.invoke('tm-dir'),
  resolveMcVersion: (mcDir, id) => ipcRenderer.invoke('resolve-mc-version', mcDir, id),
  saveTmList: (saveDir) => ipcRenderer.invoke('save-tm-list', saveDir),
  saveTmCreate: (saveDir, label) => ipcRenderer.invoke('save-tm-create', saveDir, label),
  saveTmRestore: (saveDir, id) => ipcRenderer.invoke('save-tm-restore', saveDir, id),
  saveTmDelete: (id) => ipcRenderer.invoke('save-tm-delete', id),
  saveTmGc: () => ipcRenderer.invoke('save-tm-gc'),
  saveTmStats: (saveDir) => ipcRenderer.invoke('save-tm-stats', saveDir),
  saveHealth: (saveDir) => ipcRenderer.invoke('save-health', saveDir),

  /* Mod 守卫（后悔药） */
  modAnalyze: (gameDir, mcVersion, loader) => ipcRenderer.invoke('mod-analyze', gameDir, mcVersion, loader),
  modSnapshot: (gameDir, label) => ipcRenderer.invoke('mod-snapshot', gameDir, label),
  modSnapList: (gameDir) => ipcRenderer.invoke('mod-snap-list', gameDir),
  modRestore: (gameDir, id) => ipcRenderer.invoke('mod-restore', gameDir, id),
  modSnapDelete: (id) => ipcRenderer.invoke('mod-snap-delete', id),
  modStats: (gameDir) => ipcRenderer.invoke('mod-stats', gameDir),
  modDiffLatest: (gameDir) => ipcRenderer.invoke('mod-diff-latest', gameDir),

  /* 实例系统（多实例隔离） */
  instList: (mcDir, version) => ipcRenderer.invoke('inst-list', mcDir, version),
  instActive: (mcDir, isolation, version) => ipcRenderer.invoke('inst-active', mcDir, isolation, version),
  instGet: (id) => ipcRenderer.invoke('inst-get', id),
  instSetActive: (id) => ipcRenderer.invoke('inst-set-active', id),
  instCreate: (o) => ipcRenderer.invoke('inst-create', o),
  instDuplicate: (o) => ipcRenderer.invoke('inst-duplicate', o),
  instUpdate: (id, patch) => ipcRenderer.invoke('inst-update', id, patch),
  instRemove: (id, deleteFiles) => ipcRenderer.invoke('inst-remove', id, deleteFiles),
  instCopyable: () => ipcRenderer.invoke('inst-copyable'),
  instOpen: (id, mcDir) => ipcRenderer.invoke('inst-open', id, mcDir),

  /* 跨启动器迁移（PCL2 / HMCL / 官方 / Prism） */
  migDetect: () => ipcRenderer.invoke('mig-detect'),
  migInspect: (dir) => ipcRenderer.invoke('mig-inspect', dir),
  migScan: (gameDir) => ipcRenderer.invoke('mig-scan', gameDir),
  migImport: (destGameDir, items, overwrite) => ipcRenderer.invoke('mig-import', destGameDir, items, overwrite),

  /* 组7：系统配置（开机自启 / 托盘 / 快捷方式 / 语言） */
  sysconfGet: () => ipcRenderer.invoke('sysconf-get'),
  autostartSet: (enable) => ipcRenderer.invoke('autostart-set', enable),
  minimizeTraySet: (enable) => ipcRenderer.invoke('minimize-tray-set', enable),
  langSet: (code) => ipcRenderer.invoke('lang-set', code),
  langGet: () => ipcRenderer.invoke('lang-get'),
  shortcutCreate: (kinds) => ipcRenderer.invoke('shortcut-create', kinds),
  shortcutRemove: (kinds) => ipcRenderer.invoke('shortcut-remove', kinds),
  onSysconfChanged: (cb) => { ipcRenderer.on('sysconf-changed', (_e, c) => cb(c)); },
  onTrayAction: (cb) => { ipcRenderer.on('tray-action', (_e, a) => cb(a)); },

  /* 组7：自动更新 */
  updateCheck: (feedUrl) => ipcRenderer.invoke('update-check', feedUrl),
  updateFeedSet: (url) => ipcRenderer.invoke('update-feed-set', url),

  /* 组7：截图增强 */
  shotsMeta: (gd) => ipcRenderer.invoke('shots-meta', gd),
  shotsOrganize: (gd, mode) => ipcRenderer.invoke('shots-organize', gd, mode),

  /* 找不到 Java 时自动下载一份 */
  javaEnsure: (o) => ipcRenderer.invoke('java-ensure', o),
  javaInstalled: () => ipcRenderer.invoke('java-installed'),
  javaRemove: (name) => ipcRenderer.invoke('java-remove', name),
  onJavaProgress: (cb) => { ipcRenderer.on('java-progress', (_e, p) => cb(p)); },

  /* 杂项 */
  notify: (t, b) => ipcRenderer.invoke('notify', t, b),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  appInfo: () => ipcRenderer.invoke('app-info'),
  minimize: () => ipcRenderer.send('win-minimize'),
  close: () => ipcRenderer.send('win-close'),
  setOpacity: (v) => ipcRenderer.send('set-opacity', v),

  /* 事件 */
  onLog: (cb) => ipcRenderer.on('game-log', (_e, line) => cb(line)),

  /* 世界：版本控制 / 合并搬运 / 地图预览 / 跨存档检索 */
  worldVerList: () => ipcRenderer.invoke('world-ver-list'),
  worldVerStatus: (saveDir) => ipcRenderer.invoke('world-ver-status', saveDir),
  worldVerTrack: (saveDir, message) => ipcRenderer.invoke('world-ver-track', saveDir, message),
  worldVerCommit: (saveDir, message, branch) => ipcRenderer.invoke('world-ver-commit', saveDir, message, branch),
  worldVerLog: (saveDir) => ipcRenderer.invoke('world-ver-log', saveDir),
  worldVerBranches: (saveDir) => ipcRenderer.invoke('world-ver-branches', saveDir),
  worldVerBranchCreate: (saveDir, name, from) => ipcRenderer.invoke('world-ver-branch-create', saveDir, name, from),
  worldVerBranchSwitch: (saveDir, name) => ipcRenderer.invoke('world-ver-branch-switch', saveDir, name),
  worldVerCheckout: (saveDir, ref, prune) => ipcRenderer.invoke('world-ver-checkout', saveDir, ref, prune),
  worldVerDiff: (saveDir, a, b) => ipcRenderer.invoke('world-ver-diff', saveDir, a, b),
  worldVerBlame: (saveDir, cx, cz, dim, kind, id) => ipcRenderer.invoke('world-ver-blame', saveDir, cx, cz, dim, kind, id),
  worldVerGc: (saveDir) => ipcRenderer.invoke('world-ver-gc', saveDir),
  worldVerStats: (saveDir) => ipcRenderer.invoke('world-ver-stats', saveDir),
  worldMergePlan: (o) => ipcRenderer.invoke('world-merge-plan', o),
  worldMergeApply: (o) => ipcRenderer.invoke('world-merge-apply', o),
  worldMapScan: (saveDir, dim, layer) => ipcRenderer.invoke('world-map-scan', saveDir, dim, layer),
  worldMapRegions: (saveDir, dim) => ipcRenderer.invoke('world-map-regions', saveDir, dim),
  worldDbIndex: (gameDir) => ipcRenderer.invoke('world-db-index', gameDir),
  worldDbSearch: (gameDir, query) => ipcRenderer.invoke('world-db-search', gameDir, query),

  /* 性能：诊断 / 自动调参 */
  perfProfile: () => ipcRenderer.invoke('perf-profile'),
  perfDiagnose: (o) => ipcRenderer.invoke('perf-diagnose', o),
  perfAutotune: (o) => ipcRenderer.invoke('perf-autotune', o),
  perfParseArgs: (logText) => ipcRenderer.invoke('perf-parse-args', logText),
  perfRules: () => ipcRenderer.invoke('perf-rules'),

  /* Mod 与内容管理：更新风险评估 / 汉化补全 / 资源包预览 / 整合包向导 */
  modkitFeatures: () => ipcRenderer.invoke('modkit-features'),
  modkitSuggestPath: (o) => ipcRenderer.invoke('modkit-suggest-path', o),
  // ① 更新风险评估
  modkitUpdateAssess: (o) => ipcRenderer.invoke('modkit-update-assess', o),
  modkitUpdateCompare: (o) => ipcRenderer.invoke('modkit-update-compare', o),
  // ② 汉化补全
  modkitL10nAnalyze: (o) => ipcRenderer.invoke('modkit-l10n-analyze', o),
  modkitL10nAnalyzeDir: (o) => ipcRenderer.invoke('modkit-l10n-analyze-dir', o),
  modkitL10nBuildPack: (o) => ipcRenderer.invoke('modkit-l10n-buildpack', o),
  modkitL10nTranslate: (text) => ipcRenderer.invoke('modkit-l10n-translate', text),
  modkitL10nLangs: (jarPath) => ipcRenderer.invoke('modkit-l10n-langs', jarPath),
  // ③ 资源包与光影预览
  modkitPackPreview: (o) => ipcRenderer.invoke('modkit-pack-preview', o),
  modkitPackDetail: (o) => ipcRenderer.invoke('modkit-pack-detail', o),
  modkitPackScan: (gameDir) => ipcRenderer.invoke('modkit-pack-scan', gameDir),
  // ④ 整合包创建向导
  modkitPackCandidates: (o) => ipcRenderer.invoke('modkit-pack-candidates', o),
  modkitPackCheck: (o) => ipcRenderer.invoke('modkit-pack-check', o),
  modkitPackManifest: (o) => ipcRenderer.invoke('modkit-pack-manifest', o),
  modkitPackExport: (o) => ipcRenderer.invoke('modkit-pack-export', o),
  modkitPackInspect: (zipPath) => ipcRenderer.invoke('modkit-pack-inspect', zipPath),
  // 注：退出码统一走 onLaunchState({state:'exited', code})，不再单独发 'game-exit'
  onLaunchState: (cb) => ipcRenderer.on('launch-state', (_e, s) => cb(s)),
  onInstallProgress: (cb) => ipcRenderer.on('install-progress', (_e, p) => cb(p)),
  onMsCode: (cb) => ipcRenderer.on('ms-code', (_e, c) => cb(c)),
  onMsPoll: (cb) => ipcRenderer.on('ms-code-poll', () => cb())
});
