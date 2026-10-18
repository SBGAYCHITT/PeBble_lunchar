/* Pebble Launcher Lite —— 前端（Rust + WebView2 版）
 *
 * 与 Electron 版的分工一致：界面只管展示与交互，所有文件系统 / 进程操作走 Rust。
 * 通信方式从 ipcRenderer.invoke 换成 Tauri 的 invoke，其余逻辑照旧。
 */
(() => {
  'use strict';

  const T = window.__TAURI__;
  const invoke = (cmd, args) => T.core.invoke(cmd, args);
  const listen = (ev, cb) => T.event.listen(ev, cb);

  const $ = (id) => document.getElementById(id);

  const PAGE_TITLE = {
    launch: '启动', versions: '版本', account: '账户', settings: '设置', about: '关于',
  };

  let settings = null;
  let accounts = [];
  let versions = [];
  let javas = [];
  let selected = '';
  let running = false;
  let saveTimer = null;

  // ---------------------------------------------------------------- 工具

  /** 方块图标：正式版草方块 / 快照命令方块。原版贴图，2D 平贴。 */
  function blockIcon(type, size) {
    const snap = type === 'snapshot' || type === 'old_beta' || type === 'old_alpha';
    const file = snap ? 'assets/blocks/command_block.png' : 'assets/blocks/grass_block.png';
    return `<img class="blk" src="${file}" alt="" width="${size}" height="${size}" ` +
      'style="image-rendering:pixelated;display:block" draggable="false" />';
  }

  function typeLabel(t) {
    if (t === 'release') return '正式版';
    if (t === 'snapshot') return '快照';
    if (t === 'old_beta') return '远古 Beta';
    if (t === 'old_alpha') return '远古 Alpha';
    if (t === 'broken') return '损坏';
    return t || '未知';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function log(line) {
    const el = $('log-view');
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
    el.textContent += line + '\n';
    // 只在用户本来就贴着底部时才自动滚，避免把往上翻日志的人拽回来
    if (atBottom) el.scrollTop = el.scrollHeight;
  }

  function setStatus(text, kind) {
    $('status-text').textContent = text;
    $('status-dot').className = 'status-dot' + (kind ? ' ' + kind : '');
  }

  async function toast(msg) {
    setStatus(msg, 'warn');
    log('[启动器] ' + msg);
  }

  // ---------------------------------------------------------------- 设置读写

  function bindSetting(el, key, cast) {
    const node = $(el);
    if (!node) return;
    node.addEventListener('change', () => {
      settings[key] = cast ? cast(node) : node.value;
      scheduleSave();
    });
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try { await invoke('settings_save', { settings }); } catch (e) { log('[启动器] 保存设置失败: ' + e); }
    }, 350);
  }

  function fillSettingsForm() {
    $('st-mcdir').value = settings.mc_dir || '';
    $('st-java').value = settings.java_path || '';
    $('st-jvm').value = settings.jvm_args || '';
    $('st-mem').value = settings.memory_gb;
    $('st-w').value = settings.win_w;
    $('st-h').value = settings.win_h;
    $('st-fullscreen').checked = !!settings.fullscreen;
    $('st-hide').checked = !!settings.hide_after_launch;

    $('mem').value = settings.memory_gb;
    $('mem-label').textContent = settings.memory_gb + ' GB';
    $('win-w').value = settings.win_w;
    $('win-h').value = settings.win_h;
    $('fullscreen').checked = !!settings.fullscreen;
    $('player-name').value = settings.player_name || '';
  }

  async function reloadJava() {
    javas = await invoke('detect_java', { extra: settings.java_path || null });
    const box = $('java-installed');
    if (!javas.length) {
      box.innerHTML = '<p class="tip">没检测到 Java。装了 JDK / JRE 之后点「重新检测」。</p>';
    } else {
      box.innerHTML = javas.map((j) =>
        `<div class="item"><span class="item-ico">☕</span><div style="min-width:0">` +
        `<div class="t">Java ${j.major} <span class="s">· ${esc(j.version)}</span></div>` +
        `<div class="s mono">${esc(j.path)}　[${esc(j.source)}]</div></div></div>`).join('');
    }
    const info = $('java-info');
    if (!javas.length) {
      info.textContent = '未检测到 Java —— 去设置里指定 java.exe';
      info.classList.add('bad');
    } else {
      const j = javas[0];
      info.textContent = `Java ${j.major} · ${j.version}　${j.path}`;
      info.classList.remove('bad');
    }
  }

  // ---------------------------------------------------------------- 版本

  /** 版本列表在界面上有两份：启动页的「本地版本」和版本页的「已安装版本」。
   *  两处渲染同一批数据、共用同一个 `selected`，所以必须一起更新 ——
   *  只写其中一份的话，另一页就会一直空着（看起来像「一个版本都没装」）。 */
  const VERSION_LISTS = ['version-list', 'installed-list'];

  function renderVersions() {
    const html = versions.length
      ? versions.map((v) => {
        const cls = 'item' + (v.id === selected ? ' selected' : '') + (v.error ? ' sev-error' : '');
        const size = v.jarSize ? (v.jarSize / 1048576).toFixed(1) + ' MB' : '无 jar';
        const sub = v.error
          ? esc(v.error)
          : `${typeLabel(v.type)} · ${size}` + (v.inherits ? ` · 继承 ${esc(v.inherits)}` : '') +
            (v.javaMajor ? ` · 需 Java ${v.javaMajor}+` : '');
        return `<div class="${cls}" data-id="${esc(v.id)}">` +
          `<span class="item-ico">${blockIcon(v.type, 32)}</span>` +
          `<div style="min-width:0"><div class="t">${esc(v.id)}</div><div class="s">${sub}</div></div>` +
          '</div>';
      }).join('')
      : '<p class="tip">这个游戏目录里没有已安装的版本。<br />' +
        '用官方启动器装一次，或者把设置里的目录指到你已有的 .minecraft。</p>';

    for (const id of VERSION_LISTS) {
      const box = $(id);
      if (!box) continue;
      box.innerHTML = html;
      box.querySelectorAll('.item').forEach((it) => {
        it.addEventListener('click', () => selectVersion(it.dataset.id));
      });
    }
  }

  async function reloadVersions() {
    versions = await invoke('list_versions', { mcDir: settings.mc_dir || null });
    if (!versions.some((v) => v.id === selected)) {
      selected = versions.find((v) => !v.error)?.id || '';
    }
    renderVersions();
  }

  async function selectVersion(id) {
    selected = id;
    renderVersions();
    try {
      const d = await invoke('version_detail', { mcDir: settings.mc_dir || null, versionId: id });
      const rows = [
        ['主类', d.mainClass || '—'],
        ['继承', d.inherits || '无（独立版本）'],
        ['需要 Java', d.javaMajor ? `${d.javaMajor} 或更高` : '未声明'],
        ['库数量', `${d.libraryCount - d.missingLibraries} / ${d.libraryCount} 已就位`],
        ['资源索引', d.hasAssetsIndex ? `${d.assetIndex}（已下载）` : `${d.assetIndex}（缺失，首次启动会没有音效与语言文件）`],
      ];
      $('ver-detail').innerHTML = rows.map(([k, v]) =>
        `<div class="set-row"><label>${esc(k)}</label><span class="mono">${esc(v)}</span></div>`).join('');
    } catch (e) {
      $('ver-detail').innerHTML = `<span class="bad">${esc(e)}</span>`;
    }
  }

  // ---------------------------------------------------------------- 账户

  function activeAccount() {
    return accounts.find((a) => a.id === settings.active_account) || null;
  }

  function renderAccounts() {
    const cur = activeAccount();
    const name = cur ? cur.name : (settings.player_name || '未登录');
    const uuid = cur ? cur.uuid : '';

    const initial = name ? name[0].toUpperCase() : '?';
    $('acc-name').textContent = name;
    $('acc-name2').textContent = name;
    $('avatar').textContent = initial;
    $('acc-avatar').textContent = initial;
    $('acc-type').textContent = cur ? '离线模式' : '离线模式（未保存）';
    $('acc-type2').textContent = cur ? '离线模式' : '离线模式（未保存）';
    $('acc-uuid').textContent = uuid;

    const box = $('acc-list');
    if (!accounts.length) {
      box.innerHTML = '<p class="tip">还没有保存的账户。</p>';
      return;
    }
    box.innerHTML = accounts.map((a) =>
      `<div class="item${a.id === settings.active_account ? ' selected' : ''}" data-id="${esc(a.id)}">` +
      `<span class="item-ico">☺</span><div style="min-width:0">` +
      `<div class="t">${esc(a.name)}</div><div class="s mono">${esc(a.uuid)}</div></div>` +
      `<span class="ops"><button class="ghost-btn danger" data-del="${esc(a.id)}">删除</button></span></div>`
    ).join('');
    box.querySelectorAll('.item').forEach((it) => {
      it.addEventListener('click', async (ev) => {
        if (ev.target.dataset.del) return;
        await invoke('account_set_active', { id: it.dataset.id });
        settings = await invoke('settings_get');
        fillSettingsForm();
        renderAccounts();
      });
    });
    box.querySelectorAll('[data-del]').forEach((b) => {
      b.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        accounts = await invoke('account_remove', { id: b.dataset.del });
        settings = await invoke('settings_get');
        fillSettingsForm();
        renderAccounts();
      });
    });
  }

  // ---------------------------------------------------------------- 启动

  async function doLaunch() {
    if (running) return;
    if (!selected) {
      await toast('先在左边选一个版本');
      return;
    }
    settings.player_name = $('player-name').value.trim();
    await invoke('settings_save', { settings });

    $('btn-launch').disabled = true;
    $('btn-kill').disabled = false;
    running = true;
    setStatus('正在启动…', 'ok');
    log(`[启动器] 启动 ${selected} …`);

    try {
      const r = await invoke('launch_game', { versionId: selected, playerName: settings.player_name });
      log(`[启动器] 进程 pid=${r.pid}，Java ${r.javaMajor}`);
      setStatus('游戏运行中', 'ok');
    } catch (e) {
      running = false;
      $('btn-launch').disabled = false;
      $('btn-kill').disabled = true;
      setStatus('启动失败', 'bad');
      log('[启动器] 失败：' + e);
    }
  }

  function onGameExit(code) {
    running = false;
    $('btn-launch').disabled = false;
    $('btn-kill').disabled = true;
    // MC 正常退出码是 0；非 0 一般是崩溃
    setStatus(code === 0 ? '已退出' : `已退出（代码 ${code}）`, code === 0 ? '' : 'bad');
    log(`[启动器] 游戏进程结束，退出码 ${code}`);
  }

  // ---------------------------------------------------------------- 各页刷新

  async function refreshAll() {
    settings = await invoke('settings_get');
    fillSettingsForm();
    accounts = await invoke('accounts_list');
    renderAccounts();
    await reloadVersions();
    await reloadJava();
  }

  // ---------------------------------------------------------------- 绑定

  function bindUI() {
    // 导航
    document.querySelectorAll('.nav-item').forEach((b) => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.nav-item').forEach((x) => x.classList.remove('active'));
        document.querySelectorAll('.page').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        const p = b.dataset.page;
        $('page-' + p).classList.add('active');
        $('nav-title').textContent = PAGE_TITLE[p] || p;
      });
    });

    // 窗口按钮
    $('btn-min').addEventListener('click', () => invoke('win_min'));
    $('btn-max').addEventListener('click', () => invoke('win_max'));
    $('btn-close').addEventListener('click', () => invoke('win_close'));

    // 启动页
    $('btn-refresh').addEventListener('click', async () => { await refreshAll(); });
    $('btn-vrefresh').addEventListener('click', async () => { await reloadVersions(); });
    $('btn-launch').addEventListener('click', doLaunch);
    $('btn-clearlog').addEventListener('click', () => { $('log-view').textContent = ''; });
    $('btn-kill').addEventListener('click', async () => {
      try { await invoke('kill_game'); log('[启动器] 已请求结束进程'); } catch (e) { await toast(String(e)); }
    });

    // 快捷设置
    $('mem').addEventListener('input', () => {
      $('mem-label').textContent = $('mem').value + ' GB';
    });
    $('mem').addEventListener('change', () => {
      settings.memory_gb = parseInt($('mem').value, 10) || 4;
      $('st-mem').value = settings.memory_gb;
      scheduleSave();
    });
    for (const [id, key, num] of [['win-w', 'win_w', true], ['win-h', 'win_h', true]]) {
      $(id).addEventListener('change', () => {
        settings[key] = num ? (parseInt($(id).value, 10) || 0) : $(id).value;
        if (key === 'win_w') $('st-w').value = settings.win_w;
        if (key === 'win_h') $('st-h').value = settings.win_h;
        scheduleSave();
      });
    }
    $('fullscreen').addEventListener('change', () => {
      settings.fullscreen = $('fullscreen').checked;
      $('st-fullscreen').checked = settings.fullscreen;
      scheduleSave();
    });
    $('player-name').addEventListener('change', () => {
      settings.player_name = $('player-name').value.trim();
      scheduleSave();
    });

    // 账户页
    $('btn-acc-refresh').addEventListener('click', async () => {
      accounts = await invoke('accounts_list');
      renderAccounts();
    });
    $('btn-off-login').addEventListener('click', async () => {
      const n = $('off-name').value.trim();
      if (!n) return;
      try {
        accounts = await invoke('account_add_offline', { name: n });
        settings = await invoke('settings_get');
        $('off-name').value = '';
        fillSettingsForm();
        renderAccounts();
        await toast('已添加离线账户 ' + n);
      } catch (e) { await toast(String(e)); }
    });

    // 设置页
    bindSetting('st-mcdir', 'mc_dir');
    bindSetting('st-java', 'java_path');
    bindSetting('st-jvm', 'jvm_args');
    bindSetting('st-mem', 'memory_gb', (n) => parseInt(n.value, 10) || 4);
    bindSetting('st-w', 'win_w', (n) => parseInt(n.value, 10) || 854);
    bindSetting('st-h', 'win_h', (n) => parseInt(n.value, 10) || 480);
    bindSetting('st-fullscreen', 'fullscreen', (n) => n.checked);
    bindSetting('st-hide', 'hide_after_launch', (n) => n.checked);

    $('st-mcdir').addEventListener('change', async () => { await reloadVersions(); });
    $('st-java').addEventListener('change', async () => { await reloadJava(); });
    $('btn-st-mcdir').addEventListener('click', async () => {
      const p = await invoke('pick_dir');
      if (p) { $('st-mcdir').value = p; settings.mc_dir = p; scheduleSave(); await reloadVersions(); }
    });
    $('btn-st-mcdir-default').addEventListener('click', async () => {
      const d = await invoke('default_mcdir');
      $('st-mcdir').value = d; settings.mc_dir = d; scheduleSave(); await reloadVersions();
    });
    $('btn-st-java').addEventListener('click', async () => {
      const p = await invoke('pick_file', { filterName: 'java.exe', extensions: ['exe'] });
      if (p) { $('st-java').value = p; settings.java_path = p; scheduleSave(); await reloadJava(); }
    });
    $('btn-st-javadetect').addEventListener('click', async () => { await reloadJava(); });

    // 目录快捷打开
    document.querySelectorAll('[data-open]').forEach((b) => {
      b.addEventListener('click', async () => {
        const root = settings.mc_dir || await invoke('default_mcdir');
        const kind = b.dataset.open;
        const sub = kind === 'mc' ? '' : kind;
        const p = sub ? `${root}\\${sub}` : root;
        try { await invoke('open_path', { path: p }); }
        catch (e) { await toast('打不开：' + p); }
      });
    });

    // 关于页
    $('btn-open-appdir').addEventListener('click', async () => {
      const info = await invoke('app_info');
      try { await invoke('open_path', { path: info.dataDir }); } catch (e) { await toast(String(e)); }
    });
    $('btn-open-mcsite').addEventListener('click', () => {
      window.open('https://www.minecraft.net/', '_blank');
    });
  }

  // ---------------------------------------------------------------- 启动

  /** 界面自检信标：把「界面到底渲染成什么样」回传给 Rust 侧。
   *
   * 为什么要这个：WebView2 用 DirectComposition 合成，外部截屏（BitBlt /
   * PrintWindow）抓到的永远是全黑或全白，光看截图没法判断界面是白屏还是被
   * 截屏方式骗了。这里改成由页面自己汇报实测值 —— DOM 数量、样式是否生效、
   * 图片有没有真的加载、IPC 通不通 —— 都是不可伪造的证据。
   * 平时这个命令是空操作，只有设了 PEBBLE_LITE_BOOT_LOG 才会落盘。 */
  function selfCheck(extra) {
    const logo = document.querySelector('.logo-mark');
    const css = getComputedStyle(document.documentElement);
    return Object.assign({
      title: document.title,
      navItems: document.querySelectorAll('.nav-item').length,
      pages: [...document.querySelectorAll('.nav-item')].map((b) => b.dataset.page),
      activePage: (document.querySelector('.page.active') || {}).id,
      hasTitlebar: !!document.getElementById('titlebar'),
      dragRegion: !!document.querySelector('#titlebar[data-tauri-drag-region]'),
      cssVarBg: css.getPropertyValue('--bg').trim(),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      bodyBgImage: getComputedStyle(document.body).backgroundImage.slice(0, 40),
      logoLoaded: !!logo && logo.complete && logo.naturalWidth > 0,
      logoWidth: logo ? logo.naturalWidth : 0,
      blockIcons: document.querySelectorAll('.blk').length,
      tauriGlobal: typeof window.__TAURI__,
      versionRows: versions.length,
      accounts: accounts.length,
      javas: javas.length,
      mcDir: settings && settings.mc_dir,
      viewport: [window.innerWidth, window.innerHeight],
      dpr: window.devicePixelRatio,
    }, extra || {});
  }

  /** 启动进度写进窗口标题。
   *
   * 不是给玩家看的花活，是给「界面白屏、又连不上 WebView2 调试端口」这种情况留的
   * 线索：窗口标题用系统 API（EnumWindows / GetWindowText）就能读到，不需要任何
   * 调试通道，也不受沙箱限制。启动卡在哪一步，看一眼标题就知道。
   * 正常跑完会还原成正式标题。 */
  function mark(stage) {
    try { document.title = 'Pebble Launcher Lite · ' + stage; } catch { /* 标题只用于诊断 */ }
  }
  function markDone() {
    try { document.title = 'Pebble Launcher Lite'; } catch { /* 同上 */ }
  }

  async function init() {
    mark('boot');
    if (!T || !T.core) {
      throw new Error('window.__TAURI__ 未注入（tauri.conf.json 里 withGlobalTauri 未生效）');
    }
    bindUI();
    mark('ui已绑定');
    await listen('game-log', (e) => log(e.payload));
    await listen('game-exit', (e) => onGameExit(e.payload));
    mark('事件已订阅');

    const info = await invoke('app_info');
    mark('app_info 已返回');
    $('about-info').innerHTML = [
      ['版本', info.version],
      ['运行时', info.runtime],
      ['默认游戏目录', info.defaultMcDir],
      ['数据目录', info.dataDir],
    ].map(([k, v]) => `<div class="set-row"><label>${esc(k)}</label><span class="mono">${esc(v)}</span></div>`).join('');

    await refreshAll();
    mark('数据已加载');
    log('[启动器] Pebble Launcher Lite ' + info.version + ' 就绪');
    setStatus('就绪', '');
    markDone();
    invoke('ui_ready', { diag: selfCheck({ ok: true, runtime: info.runtime }) }).catch(() => {});
  }

  window.addEventListener('DOMContentLoaded', () => {
    init().catch((e) => {
      const msg = String((e && e.message) || e);
      mark('✗ ' + msg);
      document.body.insertAdjacentHTML('afterbegin',
        `<div style="padding:12px;color:#c33;font-size:13px">初始化失败：${esc(msg)}</div>`);
      // 这一句自己也可能失败（比如 __TAURI__ 没注入），单独包一层，
      // 免得把原始错误吞掉、只剩下一个没有线索的白窗口。
      try {
        invoke('ui_ready', { diag: selfCheck({ ok: false, error: String(e && e.stack || e) }) })
          .catch(() => {});
      } catch { /* 诊断通道不可用时就算了，标题里已经有原因 */ }
    });
  });
})();
