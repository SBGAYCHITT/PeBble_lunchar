// Pebble Lunchar - 渲染层核心：状态、导航、启动、账户、设置
(function () {
  /** 按 id 取元素。返回类型放宽到 any：渲染层几乎每处都要直接读写 value / checked / disabled，
   *  而 getElementById 的官方类型是 HTMLElement | null，逐处断言只会制造噪音。
   *  @type {(id: string) => any} */
  const $ = (id) => document.getElementById(id);
  const P = () => window.Pages;
  /** 取文案。I18N 还没加载时退回中文兜底 fb —— 渐进迁移期间界面永远不会有洞。
   *  @param {string} key @param {Record<string, any>} [params] @param {string} [fb] */
  const T = (key, params, fb) => (window.I18N ? window.I18N.t(key, params, fb) : (fb != null ? fb : key));

  /* ---------- 全局状态 ---------- */
  const DEFAULT_CFG = {
    mcDir: '', javaPath: '', mem: 4, jvmArgs: '', version: '',
    playerName: '', theme: 'dark', opacity: 100, anim: true, source: 'official',
    threads: 16, isolation: false, hide: false, winW: 854, winH: 480, fullscreen: false,
    authlibJar: ''
  };

  const PL = {
    cfg: Object.assign({}, DEFAULT_CFG),
    versions: [],
    selectedVersion: '',
    account: null,
    javaInfo: null,
    javaAuto: true,
    launching: false,
    currentPage: 'launch'
  };

  function loadCfg() {
    try { PL.cfg = Object.assign({}, DEFAULT_CFG, JSON.parse(localStorage.getItem('pl-cfg') || '{}')); } catch {}
    PL.selectedVersion = PL.cfg.version || '';
  }
  function saveCfg() {
    PL.cfg.version = PL.selectedVersion;
    localStorage.setItem('pl-cfg', JSON.stringify(PL.cfg));
  }

  /* 账户凭据：改为 safeStorage 加密存储（Windows=DPAPI），不再明文落 localStorage。
     启动时把历史明文迁移进加密区并删除明文。 */
  async function loadAccountSecure() {
    try {
      const legacy = localStorage.getItem('pl-acc');
      const r = await window.api.accountStoreLoad();
      if (r && r.ok && r.data) {
        const list = r.data.accounts || [];
        PL.account = list.length ? (list.find((a) => a.uuid === r.data.activeId) || list[0]) : null;
        PL.accounts = list;
        if (r.degraded) {
          PL.appendLog(T('sec.degraded'));
        }
      }
      if (legacy && legacy !== 'null') {
        try {
          const old = JSON.parse(legacy);
          if (old && old.uuid) {
            if (!PL.account) PL.account = old;
            await window.api.accountStoreSave({ accounts: [old], activeId: old.uuid });
          }
        } catch {}
        localStorage.removeItem('pl-acc'); // 清除历史明文
        PL.appendLog(T('sec.migrated'));
      }
    } catch (e) {
      PL.appendLog(T('sec.loadFail') + e.message);
    }
  }
  // 注意：必须把整份列表写回去。以前这里只写当前账户，导致每登录一个新账户
  // 就把其它账户全清掉 —— 多账户功能等于不存在。
  function saveAcc() {
    const list = PL.accounts && PL.accounts.length ? PL.accounts : (PL.account ? [PL.account] : []);
    window.api.accountStoreSave({ accounts: list, activeId: PL.account ? PL.account.uuid : null });
  }
  /** 登录结果追加进列表：同 UUID 覆盖，其余保留，并切换为当前账户 */
  function upsertAccount(a) {
    if (!a || !a.uuid) return;
    PL.accounts = PL.accounts || [];
    const i = PL.accounts.findIndex((x) => x.uuid === a.uuid);
    if (i >= 0) PL.accounts[i] = a; else PL.accounts.push(a);
    PL.account = a;
    saveAcc();
  }
  PL.upsertAccount = upsertAccount;
  PL.saveAcc = saveAcc;
  /** 删除账户：删的是列表里的那一条，当前账户被删时自动切换到第一个 */
  PL.removeAccount = (uuid) => {
    PL.accounts = (PL.accounts || []).filter((a) => a.uuid !== uuid);
    if (PL.account && PL.account.uuid === uuid) PL.account = PL.accounts[0] || null;
    saveAcc();
  };
  PL.updateAccountUI = updateAccountUI;
  PL.switchAccount = (uuid) => {
    const a = (PL.accounts || []).find((x) => x.uuid === uuid);
    if (a) { PL.account = a; saveAcc(); }
  };

  PL.saveCfg = saveCfg;
  // 有实例系统后，「游戏目录」优先取当前实例解析出来的目录
  PL.gameDir = () => (PL.instGameDir && PL.instGameDir !== PL.cfg.mcDir)
    ? PL.instGameDir
    : ((PL.cfg.isolation && PL.selectedVersion)
        ? `${PL.cfg.mcDir}\\versions\\${PL.selectedVersion}\\isolation`
        : PL.cfg.mcDir);
  PL.setVersion = (id) => {
    PL.selectedVersion = id || '';
    saveCfg();
    // 版本变了，「空 gameDir 实例 + 版本隔离」解析出的目录也会变
    if (window.Pages) window.Pages.syncActiveGameDir();
  };

  /* ---------- 状态与日志 ---------- */
  PL.setStatus = (text, mode) => {
    $('status-text').textContent = text;
    $('status-dot').className = 'status-dot' + (mode ? ' ' + mode : '');
  };
  PL.appendLog = (line) => {
    const el = $('log-view');
    el.textContent += line + '\n';
    const lines = el.textContent.split('\n');
    if (lines.length > 500) el.textContent = lines.slice(-500).join('\n');
    el.scrollTop = el.scrollHeight;
  };

  /* ---------- 头像 / 账户显示 ---------- */
  function updateAccountUI() {
    const a = PL.account;
    const name = a ? a.name : T('acc.notLoggedIn');
    const typeMap = {
      offline: T('acc.type.offline'), yggdrasil: T('acc.type.ygg'), microsoft: T('acc.type.ms')
    };
    const type = a ? (typeMap[a.type] || a.type) : T('acc.type.offline');
    $('avatar').textContent = name.charAt(0).toUpperCase();
    $('acc-avatar').textContent = name.charAt(0).toUpperCase();
    $('acc-name').textContent = name;
    $('acc-name2').textContent = name;
    $('acc-type').textContent = type;
    $('acc-type2').textContent = type;
    $('acc-uuid').textContent = a ? a.uuid : '';
    if (!PL.cfg.playerName && a) PL.cfg.playerName = a.name;
    // 头像异步补位：主进程抓图有磁盘缓存，重复调用很便宜
    for (const id of ['avatar', 'acc-avatar']) {
      const el = $(id);
      if (el) el.classList.remove('has-img'), el.style.backgroundImage = '';
    }
    if (a && a.uuid && window.api.avGet) {
      window.api.avGet({ uuid: a.uuid, size: 48 }).then((r) => {
        if (!r || !r.ok || !r.data) return;
        for (const id of ['avatar', 'acc-avatar']) {
          const el = $(id);
          if (el) { el.classList.add('has-img'); el.style.backgroundImage = `url("${r.data}")`; }
        }
      }).catch(() => {});
    }
  }

  /* ---------- 版本列表（启动页） ---------- */
  async function refreshVersions() {
    const box = $('version-list');
    if (!PL.cfg.mcDir) { box.innerHTML = '<div class="empty">' + T('launch.needMcDir') + '</div>'; return; }
    PL.versions = await window.api.listVersions(PL.cfg.mcDir);
    box.innerHTML = '';
    if (!PL.versions.length) {
      box.innerHTML = '<div class="empty">' + T('launch.noVersion') + '</div>';
      return;
    }
    if (!PL.selectedVersion || !PL.versions.some(v => v.id === PL.selectedVersion)) {
      PL.selectedVersion = PL.versions[0].id; saveCfg();
    }
    for (const v of PL.versions) {
      const d = document.createElement('div');
      d.className = 'item' + (v.id === PL.selectedVersion ? ' selected' : '');
      d.innerHTML = `<div><div class="t">${P().esc(v.id)}</div><div class="s">${P().esc(v.type || '')}${v.hasJar ? '' : T('launch.missingJar')}</div></div>`;
      d.onclick = () => {
        PL.setVersion(v.id); refreshVersions();
        detectJava(requiredJava(v.id));
      };
      box.appendChild(d);
    }
  }

  function requiredJava(verId) {
    const m = String(verId).match(/^(\d+)\.(\d+)/);
    if (!m) return 8;
    const mi = parseInt(m[2], 10);
    if (mi >= 21) return 21;
    if (mi >= 18) return 17;
    if (mi >= 17) return 16;
    return 8;
  }

  /* ---------- Java ---------- */
  /**
   * 找不到 Java 时自动下载一份官方 Temurin。
   * 只会在第一次真正走网络：装完落在启动器自己的目录里，之后直接命中本地缓存。
   */
  async function autoDownloadJava(major) {
    const want = major || 21;
    PL.appendLog(T('java.autoStart', { major: want }));
    PL.setStatus(T('java.autoStatus', { major: want }), 'run');
    let r;
    try { r = await window.api.javaEnsure({ major: want }); }
    catch (e) { r = { ok: false, error: e.message }; }
    if (!r || !r.ok) {
      PL.setStatus(T('java.autoFail'), 'err');
      PL.appendLog(T('java.autoFailLog', { err: (r && r.error) || T('common.unknown') }));
      return null;
    }
    PL.cfg.javaPath = r.javaPath; saveCfg(); syncSettingsUI();
    PL.appendLog('[Java] ' + (r.cached ? T('java.reused') : T('java.installedTo')) + r.javaPath);
    $('java-info').textContent = T('java.autoInstalled', { major: want });
    PL.setStatus(T('status.ready'), '');
    refreshJavaInstalled();
    return r.javaPath;
  }
  PL.autoDownloadJava = autoDownloadJava;

  async function detectJava(preferMajor) {
    $('java-info').textContent = T('java.detecting');
    const j = await window.api.detectJava(PL.cfg.mcDir, preferMajor || 0);
    PL.javaInfo = j;
    if (j && j.path) {
      $('java-info').textContent = `Java ${j.version} · ${j.source}`;
      if (PL.javaAuto) { PL.cfg.javaPath = j.path; saveCfg(); syncSettingsUI(); }
      if (PL.selectedVersion && j.major < requiredJava(PL.selectedVersion)) {
        $('java-info').textContent = T('java.suggest', { ver: j.version, need: requiredJava(PL.selectedVersion) });
        PL.setStatus(T('java.tooLow'), 'warn');
      } else PL.setStatus(T('status.ready'), '');
    } else {
      $('java-info').textContent = T('java.autoDownloading');
      PL.setStatus(T('status.noJava'), 'err');
      // 不 await：45MB 的下载不该卡住界面初始化，进度走日志回传
      autoDownloadJava(preferMajor || (PL.selectedVersion ? requiredJava(PL.selectedVersion) : 0) || 21);
    }
  }

  /* ---------- 启动 ---------- */
  async function launch() {
    if (PL.launching) return;
    let acc = PL.account;
    if (!acc) {
      const name = ($('player-name').value || '').trim();
      if (!/^[A-Za-z0-9_\u4e00-\u9fa5]{1,16}$/.test(name)) {
        PL.setStatus(T('launch.needAccount'), 'err'); return;
      }
      acc = await window.api.accountOffline(name);
      PL.account = acc; saveAcc(); updateAccountUI();
    }
    if (!PL.selectedVersion) { PL.setStatus(T('launch.pickVersion'), 'err'); return; }
    PL.launching = true;
    $('btn-launch').disabled = true;
    $('btn-launch').innerHTML = T('launch.launching');
    $('log-view').textContent = '';
    PL.setStatus(T('status.starting'), 'run');
    // 并行多开的去重键：实例 + 账户。没选实例时记为 '-'（沿用当前 gameDir）
    const insState = P() && P().insState ? P().insState() : null;
    const instanceId = insState ? (insState.selected || insState.activeId || '') : '';
    const instObj = insState && insState.list ? insState.list.find((i) => i.id === instanceId) : null;
    try {
      const r = await window.api.launch({
        account: acc,
        version: PL.selectedVersion,
        mcDir: PL.cfg.mcDir,
        gameDir: PL.gameDir(),
        instanceId: instanceId || undefined,
        instanceName: instObj ? instObj.name : '',
        javaPath: PL.cfg.javaPath,
        maxMemMB: (Number(PL.cfg.mem) || 4) * 1024,
        jvmArgs: PL.cfg.jvmArgs,
        isolation: PL.cfg.isolation,
        width: Number(PL.cfg.winW) || 854,
        height: Number(PL.cfg.winH) || 480,
        fullscreen: !!PL.cfg.fullscreen,
        authlibInjector: PL.cfg.authlibJar
      });
      if (!r.ok) {
        PL.setStatus(T('launch.failed') + r.error, 'err');
        PL.appendLog(T('launch.logPrefix') + r.error);
        if (r.duplicate && P()) P().refreshMulti();
      }
      else {
        PL.setStatus(T('launch.runningJava') + (r.javaVersion || ''), 'run');
        if (P()) P().refreshMulti();
        if (PL.cfg.hide) window.api.minimize();
      }
    } catch (e) { PL.setStatus(T('launch.failed') + e.message, 'err'); }
    finally {
      PL.launching = false;
      $('btn-launch').disabled = false;
      $('btn-launch').innerHTML = T('launch.button');
    }
  }

  /* ---------- 设置 ---------- */
  function syncSettingsUI() {
    $('st-mcdir').value = PL.cfg.mcDir;
    $('st-java').value = PL.cfg.javaPath;
    $('st-jvm').value = PL.cfg.jvmArgs;
    $('st-source').value = PL.cfg.source;
    $('st-threads').value = PL.cfg.threads;
    $('st-theme').value = PL.cfg.theme;
    $('st-opacity').value = PL.cfg.opacity;
    $('opacity-label').textContent = PL.cfg.opacity + '%';
    $('st-anim').checked = !!PL.cfg.anim;
    $('st-isolation').checked = !!PL.cfg.isolation;
    $('st-hide').checked = !!PL.cfg.hide;
    $('mem').value = PL.cfg.mem;
    $('mem-label').textContent = PL.cfg.mem + ' GB';
    $('win-w').value = PL.cfg.winW;
    $('win-h').value = PL.cfg.winH;
    $('fullscreen').checked = !!PL.cfg.fullscreen;
    $('player-name').value = PL.cfg.playerName;
    $('authlib-jar').value = PL.cfg.authlibJar;
  }

  function applyTheme() {
    document.body.classList.toggle('theme-light', PL.cfg.theme === 'light' ||
      (PL.cfg.theme === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches));
    document.body.classList.toggle('no-anim', !PL.cfg.anim);
    if (window.api.setOpacity) window.api.setOpacity(PL.cfg.opacity / 100);
  }

  function bindSettings() {
    const bind = (id, key, parse) => {
      const el = $(id);
      const handler = () => {
        PL.cfg[key] = parse ? parse(el.value, el) : el.value;
        saveCfg();
        if (key === 'theme' || key === 'anim') applyTheme();
        if (key === 'opacity') { $('opacity-label').textContent = PL.cfg.opacity + '%'; if (window.api.setOpacity) window.api.setOpacity(PL.cfg.opacity / 100); }
        if (key === 'mcDir') refreshAll();
      };
      el.addEventListener('change', handler);
      if (el.type === 'range') el.addEventListener('input', handler);
    };
    bind('st-mcdir', 'mcDir');
    bind('st-java', 'javaPath');
    bind('st-jvm', 'jvmArgs');
    bind('st-source', 'source');
    bind('st-threads', 'threads', v => parseInt(v, 10) || 16);
    bind('st-theme', 'theme');
    bind('st-opacity', 'opacity', v => parseInt(v, 10));
    bind('win-w', 'winW', v => parseInt(v, 10) || 854);
    bind('win-h', 'winH', v => parseInt(v, 10) || 480);
    bind('player-name', 'playerName');
    bind('authlib-jar', 'authlibJar');
    const chk = (id, key) => $(id).addEventListener('change', () => { PL.cfg[key] = $(id).checked; saveCfg(); });
    chk('st-anim', 'anim'); chk('st-isolation', 'isolation'); chk('st-hide', 'hide'); chk('fullscreen', 'fullscreen');

    $('mem').addEventListener('input', () => {
      PL.cfg.mem = parseInt($('mem').value, 10);
      $('mem-label').textContent = PL.cfg.mem + ' GB'; saveCfg();
    });

    $('btn-st-mcdir').onclick = async () => {
      const d = await window.api.pickDirectory();
      if (d) { PL.cfg.mcDir = d; saveCfg(); syncSettingsUI(); refreshAll(); }
    };
    $('btn-st-java').onclick = async () => {
      const f = await window.api.pickFile();
      if (f) { PL.cfg.javaPath = f; PL.javaAuto = false; saveCfg(); syncSettingsUI(); }
    };
    $('btn-st-javadetect').onclick = () => { PL.javaAuto = true; detectJava(PL.selectedVersion ? requiredJava(PL.selectedVersion) : 0); };
    $('btn-authlib-pick').onclick = async () => {
      const f = await window.api.pickFile([{ name: 'jar', extensions: ['jar'] }]);
      if (f) { PL.cfg.authlibJar = f; saveCfg(); syncSettingsUI(); }
    };

    $('btn-op-save').onclick = async () => {
      const patch = {};
      if ($('op-fov').value) patch.fov = $('op-fov').value;
      if ($('op-rd').value) patch.renderDistance = $('op-rd').value;
      if ($('op-gfx').value) patch.graphicsMode = $('op-gfx').value;
      if ($('op-ao').value) patch.ao = $('op-ao').value;
      await window.api.writeOptions(PL.gameDir(), patch);
      $('op-hint').textContent = T('set.optionsSaved');
      setTimeout(() => { $('op-hint').textContent = ''; }, 2500);
    };
  }

  async function loadOptionsIntoUI() {
    if (!PL.cfg.mcDir) return;
    const o = await window.api.readOptions(PL.gameDir());
    if (o.fov) $('op-fov').value = o.fov;
    if (o.renderDistance) $('op-rd').value = o.renderDistance;
    if (o.graphicsMode) $('op-gfx').value = o.graphicsMode;
    if (o.ao) $('op-ao').value = o.ao;
  }

  /* ---------- 组7：系统设置（自启 / 托盘 / 快捷方式 / 语言 / 更新 / Java） ---------- */
  function populateLangs(langs, current) {
    const sel = $('sys-lang');
    if (!sel) return;
    sel.innerHTML = '';
    for (const l of (langs || [])) {
      const o = document.createElement('option');
      o.value = l.code; o.textContent = l.name;
      if (l.code === current) o.selected = true;
      sel.appendChild(o);
    }
  }

  function applyLang(lang) {
    if (!window.I18N) return;
    window.I18N.setLang(lang || 'zh-CN');
    window.I18N.applyDom(document);
    const tt = $('nav-title');
    if (tt && PL.currentPage) tt.textContent = window.I18N.t('nav.' + PL.currentPage);
  }

  /** 列出启动器自己下载的 Java（可删除） */
  async function refreshJavaInstalled() {
    const box = $('java-installed');
    if (!box || !window.api.javaInstalled) return;
    let items = [];
    try { const r = await window.api.javaInstalled(); items = (r && r.items) || []; } catch { return; }
    box.innerHTML = '';
    if (!items.length) { box.innerHTML = '<div class="empty">' + T('java.none') + '</div>'; return; }
    for (const it of items) {
      const d = document.createElement('div');
      d.className = 'item';
      const info = document.createElement('div');
      const t = document.createElement('div'); t.className = 't'; t.textContent = it.name;
      const s = document.createElement('div'); s.className = 's'; s.textContent = it.javaPath || T('java.noBinary');
      info.appendChild(t); info.appendChild(s); d.appendChild(info);
      const del = document.createElement('span');
      del.className = 'danger-link'; del.textContent = T('common.delete');
      del.onclick = async () => { await window.api.javaRemove(it.name); refreshJavaInstalled(); };
      d.appendChild(del);
      box.appendChild(d);
    }
  }
  PL.refreshJavaInstalled = refreshJavaInstalled;

  async function loadSysConf() {
    if (!window.api.sysconfGet) return;
    let r;
    try { r = await window.api.sysconfGet(); } catch { return; }
    if (!r || !r.ok) return;
    if ($('sys-autostart')) $('sys-autostart').checked = !!(r.conf && r.conf.autostart) || !!(r.loginItem && r.loginItem.openAtLogin);
    if ($('sys-mintray')) $('sys-mintray').checked = !!(r.conf && r.conf.minimizeToTray);
    if ($('sys-feed')) $('sys-feed').value = (r.conf && r.conf.updateFeed) || '';
    let langs = [{ code: 'zh-CN', name: T('lang.zhCN') }, { code: 'en-US', name: 'English' }];
    let cur = (r.conf && r.conf.lang) || 'zh-CN';
    if (window.api.langGet) {
      try {
        const lr = await window.api.langGet();
        if (lr && lr.langs) langs = lr.langs;
        if (lr && lr.lang) cur = lr.lang;
      } catch {}
    }
    populateLangs(langs, cur);
    applyLang(cur);
  }

  function bindSystem() {
    const sa = $('sys-autostart');
    if (sa) sa.addEventListener('change', async () => {
      const r = await window.api.autostartSet(sa.checked);
      PL.setStatus(r && r.ok ? (sa.checked ? T('sys.autostartOn') : T('sys.autostartOff')) : T('sys.autostartFail'), (r && r.ok) ? '' : 'err');
    });
    const sm = $('sys-mintray');
    if (sm) sm.addEventListener('change', async () => {
      await window.api.minimizeTraySet(sm.checked);
      PL.setStatus(sm.checked ? T('sys.trayHintOn') : T('sys.trayHintOff'), '');
    });

    const scHint = (txt) => { const el = $('sc-hint'); if (el) el.textContent = txt; };
    const failText = (r) => T('common.fail') + ((r && r.error) || T('common.unknown'));
    if ($('btn-sc-desktop')) $('btn-sc-desktop').onclick = async () => {
      const r = await window.api.shortcutCreate(['desktop']);
      scHint(r && r.ok ? T('sc.desktopOk') : failText(r));
    };
    if ($('btn-sc-start')) $('btn-sc-start').onclick = async () => {
      const r = await window.api.shortcutCreate(['startMenu']);
      scHint(r && r.ok ? T('sc.startOk') : failText(r));
    };
    if ($('btn-sc-del')) $('btn-sc-del').onclick = async () => {
      await window.api.shortcutRemove(['desktop', 'startMenu']);
      scHint(T('sc.removed'));
    };

    if ($('sys-lang')) $('sys-lang').addEventListener('change', async () => {
      const r = await window.api.langSet($('sys-lang').value);
      applyLang((r && r.lang) || $('sys-lang').value);
    });

    if ($('btn-update-check')) $('btn-update-check').onclick = async () => {
      const el = $('update-result');
      if (el) el.textContent = T('upd.checking');
      const feed = $('sys-feed') ? $('sys-feed').value : '';
      try {
        await window.api.updateFeedSet(feed);
        const r = await window.api.updateCheck(feed);
        if (!el) return;
        el.textContent = '';
        if (!r || !r.ok) { el.textContent = T('upd.checkFailed') + ((r && r.error) || T('common.unknown')); return; }
        if (r.hasUpdate) {
          el.textContent = T('upd.found', { latest: r.latestVersion, current: r.currentVersion });
          if (r.url) {
            const a = document.createElement('a');
            a.href = '#'; a.textContent = T('upd.openPage');
            a.onclick = (ev) => { ev.preventDefault(); window.api.openExternal(r.url); };
            el.appendChild(a);
          }
          if (r.notes) PL.appendLog(T('upd.logPrefix') + r.notes);
        } else el.textContent = T('upd.latest', { current: r.currentVersion });
      } catch (e) { if (el) el.textContent = T('upd.checkFailed') + e.message; }
    };

    if ($('btn-java-dl')) $('btn-java-dl').onclick = async () => {
      const major = parseInt($('java-major').value, 10) || 21;
      $('btn-java-dl').disabled = true;
      const hint = $('java-dl-hint');
      if (hint) hint.textContent = T('java.dlPreparing');
      const r = await window.api.javaEnsure({ major });
      $('btn-java-dl').disabled = false;
      if (hint) hint.textContent = (r && r.ok) ? ((r.cached ? T('java.dlCached') : T('java.dlDone')) + r.javaPath) : (T('common.fail') + ((r && r.error) || T('common.unknown')));
      if (r && r.ok) { PL.cfg.javaPath = r.javaPath; saveCfg(); syncSettingsUI(); refreshJavaInstalled(); }
    };

    if ($('btn-shot-organize')) $('btn-shot-organize').onclick = () => { if (P() && P().organizeShots) P().organizeShots('month'); };
  }

  /* ---------- 账户 ---------- */
  function bindAccount() {
    document.querySelectorAll('.tab').forEach(t => {
      t.onclick = () => {
        document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
        document.querySelectorAll('.tabpane').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        $('tab-' + t.dataset.tab).classList.add('active');
      };
    });

    $('btn-off-login').onclick = async () => {
      const name = $('off-name').value.trim() || PL.cfg.playerName;
      if (!/^[A-Za-z0-9_\u4e00-\u9fa5]{1,16}$/.test(name)) { PL.setStatus(T('acc.nameInvalid'), 'err'); return; }
      const acc = await window.api.accountOffline(name);
      upsertAccount(acc); updateAccountUI(); PL.cfg.playerName = name; saveCfg(); syncSettingsUI();
      PL.setStatus(T('acc.offlineAdded', { name }), '');
      if (P()) P().refreshAccounts();
    };

    $('btn-ygg-login').onclick = async () => {
      const server = $('ygg-server').value.trim();
      const user = $('ygg-user').value.trim();
      const pass = $('ygg-pass').value;
      if (!server || !user || !pass) { PL.setStatus(T('acc.yggFill'), 'err'); return; }
      PL.setStatus(T('acc.yggLogging'), 'run');
      const r = await window.api.accountYggdrasil(server, user, pass);
      if (!r || !r.ok) { PL.setStatus(T('acc.yggFail', { err: (r && r.error) || T('common.unknown') }), 'err'); return; }
      upsertAccount(r); updateAccountUI();
      PL.setStatus(T('acc.yggOk', { name: r.name }), '');
      if (P()) P().refreshAccounts();
    };

    $('btn-ms-login').onclick = async () => {
      $('ms-code-box').classList.remove('hidden');
      PL.setStatus(T('acc.msWaiting'), 'run');
      const r = await window.api.accountMicrosoft($('ms-client').value.trim() || null);
      if (!r || !r.ok) { PL.setStatus(T('acc.msFail', { err: (r && r.error) || T('common.unknown') }), 'err'); return; }
      upsertAccount(r); updateAccountUI();
      $('ms-code-box').classList.add('hidden');
      PL.setStatus(T('acc.msOk', { name: r.name }), '');
      if (P()) P().refreshAccounts();
    };

    if ($('btn-acc-refresh')) $('btn-acc-refresh').onclick = () => P().refreshAccounts();
    if ($('btn-ml-refresh')) $('btn-ml-refresh').onclick = () => P().refreshMulti();
    if ($('btn-ml-stopall')) $('btn-ml-stopall').onclick = async () => {
      const r = await window.api.mlStopAll();
      PL.setStatus(r.stopped ? T('ml.stopped', { n: r.stopped }) : T('ml.noneRunning'), '');
      P().refreshMulti();
    };
  }

  /* ---------- 导航 ---------- */
  const PAGE_INIT = {
    versions: async () => { await P().refreshInstalled(); if (!$('dl-select').dataset.loaded) loadManifest(); },
    mods: () => P().refreshRes('mods'),
    rps: () => P().refreshRes('rps'),
    shaders: () => P().refreshRes('shaders'),
    saves: () => P().refreshSaves(),
    shots: () => P().refreshShots(),
    logs: () => P().refreshLogs(),
    settings: async () => { syncSettingsUI(); await loadOptionsIntoUI(); },
    lab: async () => { await P().initLab(); P().refreshLabHistory(); },
    account: async () => { await P().refreshAccounts(); P().refreshMulti(); },
    about: async () => {
      const info = await window.api.appInfo();
      $('about-info').textContent = T('about.version', { version: info.version, electron: info.electron, node: info.node });
    }
  };
  PAGE_INIT.instances = async () => {
    P().initInstancePage();
    await P().refreshInstances();
    if (!document.querySelector('#mig-found .mig-item')) P().migDetect();
  };

  PAGE_INIT.world = async () => { P().initWorld(); };

  function bindNav() {
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.onclick = async () => {
        document.querySelectorAll('.nav-item').forEach(x => x.classList.remove('active'));
        document.querySelectorAll('.page').forEach(x => x.classList.remove('active'));
        btn.classList.add('active');
        const page = btn.dataset.page;
        $('page-' + page).classList.add('active');
        // 优先走 i18n（切语言时标题也会跟着换），没加载 I18N 就退回内置中文表
        $('nav-title').textContent = window.I18N ? window.I18N.t('nav.' + page) : '';
        PL.currentPage = page;
        if (PAGE_INIT[page]) { try { await PAGE_INIT[page](); } catch (e) { PL.appendLog(T('log.page') + e.message); } }
      };
    });
  }

  /* ---------- 版本清单 ---------- */
  let loaderMcTouched = false; // 用户手动改过加载器 MC 版本号，就不再自动跟随下拉
  function syncLoaderMc(v) {
    const el = $('loader-mc');
    if (!el || loaderMcTouched || !v) return;
    el.value = v;
  }

  async function loadManifest() {
    const sel = $('dl-select');
    const r = await window.api.getManifest();
    if (!r.ok) { sel.innerHTML = '<option value="">' + T('dl.manifestFail') + '</option>'; return; }
    sel.dataset.loaded = '1';
    sel.innerHTML = '';
    for (const v of r.versions) {
      if (v.type !== 'release' && !$('dl-snapshot').checked) continue;
      const o = document.createElement('option');
      o.value = v.id;
      o.textContent = v.id + (v.type === 'release' ? '' : ' · ' + v.type);
      sel.appendChild(o);
    }
    if (r.latest && r.latest.release) sel.value = r.latest.release;
    syncLoaderMc(sel.value);
  }

  /* ---------- 事件回传 ---------- */
  function bindEvents() {
    window.api.onLog(l => PL.appendLog(l));
    window.api.onLaunchState(s => {
      if (s.state === 'running') PL.setStatus(T('status.running'), 'run');
      if (s.state === 'error') PL.setStatus(T('status.errorCode', { code: s.code }), 'err');
      if (s.state === 'exit') PL.setStatus(s.code === 0 ? T('status.exited') : T('status.exitCode', { code: s.code }), s.code === 0 ? '' : 'err');
    });
    window.api.onInstallProgress(p => {
      const pct = p.total ? Math.round(p.done / p.total * 100) : 0;
      const fill = $('dl-fill');
      if (fill) fill.style.width = pct + '%';
      const cnt = p.total > 1 ? ` ${p.done}/${p.total} (${pct}%)` : '';
      const txt = $('dl-text');
      if (txt) txt.textContent = p.phase + cnt + (p.file ? ' · ' + p.file : '');
      if (p.phase) PL.appendLog(T('log.download') + p.phase + cnt);
      const llog = $('loader-log');
      if (llog) { llog.textContent += (p.phase || '') + '\n'; llog.scrollTop = llog.scrollHeight; }
    });
    window.api.onMsCode(c => {
      $('ms-url').textContent = c.verification_uri;
      $('ms-code').textContent = c.user_code;
    });
    // Java 自动下载进度 / 托盘菜单触发的启动 / 系统配置被托盘改动后的同步
    if (window.api.onJavaProgress) window.api.onJavaProgress((p) => { if (p && p.phase) PL.appendLog('[Java] ' + p.phase); });
    if (window.api.onTrayAction) window.api.onTrayAction((a) => { if (a === 'launch') launch(); });
    if (window.api.onSysconfChanged) window.api.onSysconfChanged((c) => {
      if (!c) return;
      if ($('sys-autostart')) $('sys-autostart').checked = !!c.autostart;
      if ($('sys-mintray')) $('sys-mintray').checked = !!c.minimizeToTray;
    });
  }

  /* ---------- 其它按钮 ---------- */
  function bindMisc() {
    $('btn-min').onclick = () => window.api.minimize();
    $('btn-close').onclick = () => window.api.close();
    $('btn-refresh').onclick = () => refreshAll();
    $('btn-clearlog').onclick = () => { $('log-view').textContent = ''; };
    $('btn-launch').onclick = launch;
    $('btn-vrefresh').onclick = () => P().refreshInstalled();
    $('btn-dl').onclick = () => P().downloadOfficial();
    $('btn-loadervers').onclick = () => P().loadLoaderVersions();
    $('btn-loader-install').onclick = () => P().installLoader();
    $('dl-select').onchange = (e) => syncLoaderMc(e.target.value);
    $('loader-mc').oninput = () => { loaderMcTouched = true; };
    $('btn-save-refresh').onclick = () => P().refreshSaves();
    $('btn-shot-refresh').onclick = () => P().refreshShots();
    $('btn-log-refresh').onclick = () => P().refreshLogs();
    $('dl-snapshot').addEventListener('change', () => loadManifest());
    document.querySelectorAll('[data-open]').forEach(b => {
      b.onclick = () => {
        const k = b.dataset.open;
        const dir = (k === 'mc') ? PL.cfg.mcDir : `${PL.gameDir()}\\${k}`;
        window.api.openFolder(dir);
      };
    });
    document.querySelectorAll('[data-vop]').forEach(b => {
      b.onclick = () => P().versionOp(b.dataset.vop);
    });
    $('btn-inst-manage').onclick = () => {
      const b = document.querySelector('.nav-item[data-page="instances"]');
      if (b) b.click();
    };
    $('btn-open-appdir').onclick = () => window.api.openExternal('https://www.minecraft.net/');
    $('btn-open-mcsite').onclick = () => window.api.openExternal('https://www.minecraft.net/');
  }

  /* ---------- 刷新全部 ---------- */
  async function refreshAll() {
    await refreshVersions();
    if (PL.currentPage === 'versions') await P().refreshInstalled();
  }
  PL.refreshAll = refreshAll;

  /* ---------- 初始化 ---------- */
  (async function init() {
    window.PL = PL;
    loadCfg();
    await loadAccountSecure();          // 加密凭据（并迁移历史明文）
    if (!PL.cfg.mcDir) { PL.cfg.mcDir = await window.api.defaultMcDir(); saveCfg(); }
    if (!PL.account && PL.cfg.playerName) {
      PL.account = await window.api.accountOffline(PL.cfg.playerName);
      saveAcc();
    }
    updateAccountUI();
    syncSettingsUI();
    applyTheme();
    bindSettings(); bindSystem(); bindAccount(); bindNav(); bindEvents(); bindMisc();
    await loadSysConf();       // 自启/托盘/语言/更新源（主进程持久化）
    refreshJavaInstalled();    // 启动器自己下载过的 Java
    P().initInstancePage();
    await P().refreshInstances();   // 必须在刷新版本之后：实例规模统计要用得到
    await refreshVersions();
    await detectJava(PL.selectedVersion ? requiredJava(PL.selectedVersion) : 0);
    await loadOptionsIntoUI();
    loadManifest();
  })();
})();
