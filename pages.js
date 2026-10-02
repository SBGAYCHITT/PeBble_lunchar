// Pebble Lunchar - 各功能页逻辑（版本 / 资源 / 存档 / 截图 / 日志）
(function () {
  const T = (key, params, fb) => (window.I18N ? window.I18N.t(key, params, fb) : (fb != null ? fb : key));
  /** 在线仓库的安装进度回调只允许绑一次。放闭包变量而不是 window.__xxx：
   *  既不污染全局，也让类型检查能认出来。 */
  let storeProgressBound = false;
  /** 按 id 取元素，类型放宽到 any（理由同 renderer.js 的 $）
   *  @type {(id: string) => any} */
  const $ = (id) => document.getElementById(id);
  const S = () => window.PL; // 全局状态（由 renderer.js 提供）
  const fmtSize = (b) => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
  const fmtTime = (t) => {
    const d = new Date(t);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  /* ============ 版本页 ============ */
  async function refreshInstalled() {
    const st = S();
    const box = $('installed-list');
    if (!box) return;
    const list = await window.api.listVersions(st.cfg.mcDir);
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = T("pg.L25C1", null, '<div class="empty">没有已安装版本<br /><small>可在右侧下载或安装加载器</small></div>');
      return;
    }
    for (const v of list) {
      const d = document.createElement('div');
      d.className = 'item' + (v.id === st.selectedVersion ? ' selected' : '');
      d.innerHTML = T("pg.L31C2", null, `<div><div class="t">${esc(v.id)}</div><div class="s">${esc(v.type || 'unknown')}${v.hasJar ? '' : ' · 缺 jar'}</div></div>`);
      d.onclick = () => { S().setVersion(v.id); refreshInstalled(); };
      box.appendChild(d);
    }
  }

  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  async function versionOp(op) {
    const st = S();
    const id = st.selectedVersion;
    if (!id) { st.setStatus(T("pg.L42C3", null, '请先选择版本'), 'warn'); return; }
    const mcDir = st.cfg.mcDir;
    if (op === 'open') { await window.api.openFolder(require_join(mcDir, 'versions', id)); return; }
    if (op === 'delete') {
      st.appendLog(T("pg.L46C4", null, `[版本] 删除 ${id}…`));
      const r = await window.api.versionAction('delete', { mcDir, id });
      st.setStatus(r.ok ? T("pg.L48C5", null, '已删除 ') + id : T("pg.L48C6", null, '删除失败: ') + r.error, r.ok ? '' : 'err');
      if (r.ok) { S().setVersion(null); await S().refreshAll(); refreshInstalled(); }
      return;
    }
    if (op === 'rename' || op === 'copy') {
      const newId = prompt(op === 'rename' ? T("pg.L53C7", null, '新版本名：') : T("pg.L53C8", null, '复制为：'), id);
      if (!newId || !newId.trim()) return;
      const r = await window.api.versionAction(op, { mcDir, id, newId: newId.trim() });
      st.setStatus(r.ok ? T("pg.L56C9", null, '操作成功') : T("pg.L56C10", null, '失败: ') + r.error, r.ok ? '' : 'err');
      if (r.ok) { S().setVersion(newId.trim()); await S().refreshAll(); refreshInstalled(); }
      return;
    }
    if (op === 'export') {
      const file = await window.api.saveFile(`${id}.zip`, [{ name: T("pg.L61C11", null, '压缩包'), extensions: ['zip'] }]);
      if (!file) return;
      const r = await window.api.versionAction('export', { mcDir, id, file });
      st.setStatus(r.ok ? T("pg.L64C12", null, '已导出: ') + file : T("pg.L64C13", null, '导出失败: ') + r.error, r.ok ? '' : 'err');
      return;
    }
    if (op === 'import') {
      const file = await window.api.pickFile([{ name: T("pg.L68C14", null, '压缩包'), extensions: ['zip'] }]);
      if (!file) return;
      const nid = prompt(T("pg.L70C15", null, '导入为版本名：'), 'imported-' + Date.now());
      if (!nid) return;
      const r = await window.api.versionAction('import', { mcDir, id: nid.trim(), file });
      st.setStatus(r.ok ? T("pg.L73C16", null, '已导入 ') + nid : T("pg.L73C17", null, '导入失败: ') + r.error, r.ok ? '' : 'err');
      if (r.ok) { await S().refreshAll(); refreshInstalled(); }
    }
  }

  function require_join(...p) { return p.join('\\'); }

  async function downloadOfficial() {
    const st = S();
    const id = $('dl-select').value;
    if (!id) { st.setStatus(T("pg.L83C18", null, '请选择版本'), 'warn'); return; }
    if (!st.cfg.mcDir) { st.setStatus(T("pg.L84C19", null, '请先设置 .minecraft 目录'), 'err'); return; }
    $('dl-progress').classList.remove('hidden');
    $('btn-dl').disabled = true;
    st.setStatus(T("pg.L87C20", null, '正在下载 ') + id + '…', 'run');
    const r = await window.api.installVersion({ mcDir: st.cfg.mcDir, versionId: id, threads: st.cfg.threads, source: st.cfg.source });
    $('btn-dl').disabled = false;
    if (r && r.ok) {
      st.setStatus(T("pg.L91C21", null, '安装完成: ') + id, '');
      S().setVersion(id);
      await S().refreshAll();
      refreshInstalled();
    } else {
      st.setStatus(T("pg.L96C22", null, '下载失败: ') + ((r && r.error) || T("pg.L96C23", null, '未知')), 'err');
    }
  }

  async function loadLoaderVersions() {
    const kind = $('loader-kind').value;
    const mc = $('loader-mc').value.trim();
    if (!mc) { S().setStatus(T("pg.L103C24", null, '请填写 MC 版本'), 'warn'); return; }
    $('loader-ver').innerHTML = T("pg.L104C25", null, '<option value="">获取中…</option>');
    const r = await window.api.loaderVersions(kind, mc);
    const sel = $('loader-ver');
    const hint = $('loader-hint');
    if (hint) hint.innerHTML = '';
    sel.innerHTML = '';
    if (!r || !r.ok) {
      sel.innerHTML = T("pg.L111C26", null, '<option value="">获取失败</option>');
      S().setStatus(T("pg.L112C27", null, '加载器版本获取失败: ') + ((r && r.error) || T("pg.L112C28", null, '未知错误')), 'err');
      return;
    }
    if (!r.list.length) {
      // 网络是通的，只是这个 MC 版本还没有对应加载器的构建
      sel.innerHTML = T("pg.L117C29", null, '<option value="">暂无可用版本</option>');
      S().setStatus(r.message || (kind + T("pg.L118C30", null, ' 暂不支持 MC ') + mc), 'warn');
      if (r.forgeLatestMc && hint) {
        const b = document.createElement('button');
        b.className = 'ghost-btn';
        b.textContent = T("pg.L122C31", null, '改用 ') + r.forgeLatestMc + T("pg.L122C32", null, ' 重新获取');
        b.onclick = () => { $('loader-mc').value = r.forgeLatestMc; loadLoaderVersions(); };
        hint.appendChild(b);
      }
      return;
    }
    for (const v of r.list) {
      let val, label;
      if (v && typeof v === 'object') {
        if (kind === 'optifine') { val = `${v.type}|${v.version}`; label = `${v.version} (${v.type})`; }
        else { val = String(v.version); label = String(v.version) + (v.tag ? ' · ' + v.tag : ''); }
      } else { val = String(v); label = String(v); }
      const o = document.createElement('option');
      o.value = val; o.textContent = label;
      sel.appendChild(o);
    }
    S().setStatus(T("pg.L138C33", null, '已获取 ') + r.list.length + T("pg.L138C34", null, ' 个版本'), '');
  }

  async function installLoader() {
    const st = S();
    const kind = $('loader-kind').value;
    const mc = $('loader-mc').value.trim();
    const ver = $('loader-ver').value;
    if (!ver) { st.setStatus(T("pg.L146C35", null, '请先获取加载器版本'), 'warn'); return; }
    let javaPath = st.cfg.javaPath;
    if (!javaPath) {
      const j = await window.api.detectJava(st.cfg.mcDir, 0);
      if (!j) { st.setStatus(T("pg.L150C36", null, '未找到 Java'), 'err'); return; }
      javaPath = j.path;
    }
    $('loader-log').textContent = '';
    st.setStatus(T("pg.L154C37", null, '正在安装 ') + kind + '…', 'run');
    const r = await window.api.installLoader({ loader: kind, mcDir: st.cfg.mcDir, mcVersion: mc, version: ver, javaBin: javaPath });
    if (r && r.ok) {
      st.setStatus(kind + T("pg.L157C38", null, ' 安装完成'), '');
      await S().refreshAll();
      refreshInstalled();
    } else {
      st.setStatus(T("pg.L161C39", null, '安装失败: ') + ((r && r.error) || T("pg.L161C40", null, '未知')), 'err');
    }
  }

  /* ============ 资源页（Mod / 资源包 / 光影） ============ */
  const RES_META = {
    mods: { title: T("pg.L167C41", null, 'Mod 管理'), dir: 'mods', exts: ['.jar', '.zip', '.litemod'], fn: () => window.api.listMods },
    rps: { title: T("pg.L168C42", null, '资源包管理'), dir: 'resourcepacks', exts: ['.zip'], fn: () => window.api.listResourcepacks },
    shaders: { title: T("pg.L169C43", null, '光影包管理'), dir: 'shaderpacks', exts: ['.zip'], fn: () => window.api.listShaderpacks }
  };

  function buildResPage(kind) {
    const el = document.querySelector(`.res-page[data-kind="${kind}"]`);
    if (!el || el.dataset.built === '1') return el;
    const meta = RES_META[kind];
    el.innerHTML = T("pg.L176C44", null, `
      <div class="card-head"><span>${meta.title}</span>
        <span class="row">
          <span class="seg" data-seg="${kind}">
            <button data-tab="local" class="on">已下载</button>
            <button data-tab="store">在线仓库</button>
          </span>
          <span class="row local-only">
            <button class="ghost-btn" data-act="refresh">⟳ 刷新</button>
            <button class="ghost-btn" data-act="open">打开目录</button>
            <button class="ghost-btn" data-act="add">添加文件</button>
          </span>
        </span></div>
      <div class="res-pane res-pane-local scroll"><div class="res-list"></div></div>
      <div class="res-pane res-pane-store hidden">
        <div class="store-bar">
          <input class="store-input" placeholder="搜索${meta.title.replace('管理', '')}…（回车搜索）" />
          <select class="store-sel" data-f="source">
            <option value="all">全部来源</option>
            <option value="modrinth">Modrinth</option>
            <option value="curseforge">CurseForge</option>
          </select>
          <select class="store-sel" data-f="mc"><option value="">全部版本</option></select>
          <select class="store-sel" data-f="loader">
            <option value="">全部载入器</option>
            <option value="fabric">Fabric</option>
            <option value="forge">Forge</option>
            <option value="neoforge">NeoForge</option>
            <option value="quilt">Quilt</option>
          </select>
          <select class="store-sel" data-f="sort">
            <option value="downloads">按下载量</option>
            <option value="relevance">按相关度</option>
            <option value="newest">按最新发布</option>
            <option value="updated">按最近更新</option>
          </select>
          <button class="primary-btn" data-act="search">搜索</button>
          <button class="ghost-btn" data-act="cfkey" title="配置 CurseForge API Key">CF Key</button>
        </div>
        <div class="store-status"></div>
        <div class="store-grid scroll"></div>
      </div>`);

    const seg = el.querySelector('.seg');
    seg.querySelectorAll('button').forEach((b) => {
      b.onclick = () => switchResTab(kind, b.dataset.tab);
    });

    el.querySelector('[data-act=refresh]').onclick = () => refreshRes(kind);
    el.querySelector('[data-act=open]').onclick = () => window.api.openFolder(resDir(kind));
    el.querySelector('[data-act=add]').onclick = async () => {
      const f = await window.api.pickFile([{ name: T("pg.L227C45", null, '资源文件'), extensions: meta.exts.map(e => e.slice(1)) }]);
      if (!f) return;
      const r = await window.api.copyFile(f, resDir(kind));
      S().setStatus(r && r.ok ? T("pg.L230C46", null, '已添加') : T("pg.L230C47", null, '添加失败'), r && r.ok ? '' : 'err');
      refreshRes(kind);
    };

    // 在线仓库的交互
    const bar = el.querySelector('.store-bar');
    const input = bar.querySelector('.store-input');
    input.onkeydown = (e) => { if (e.key === 'Enter') doStoreSearch(kind); };
    bar.querySelector('[data-act=search]').onclick = () => doStoreSearch(kind);
    bar.querySelector('[data-act=cfkey]').onclick = () => askCfKey(kind);

    el.dataset.built = '1';
    return el;
  }

  /** 已下载 / 在线仓库 切换 */
  function switchResTab(kind, tab) {
    const el = document.querySelector(`.res-page[data-kind="${kind}"]`);
    if (!el) return;
    el.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    el.querySelector('.res-pane-local').classList.toggle('hidden', tab !== 'local');
    el.querySelector('.res-pane-store').classList.toggle('hidden', tab !== 'store');
    el.querySelector('.local-only').classList.toggle('hidden', tab !== 'local');
    if (tab === 'local') refreshRes(kind);
    else initStore(kind);
  }

  /** 当前实例的 MC 版本（用于默认筛选） */
  async function currentMc() {
    const st = S();
    if (!st.selectedVersion) return '';
    try {
      const r = await window.api.resolveMcVersion(st.cfg.mcDir, st.selectedVersion);
      return (r && r.ok && r.mc) || '';
    } catch { return ''; }
  }

  /** 首次切到在线页：填版本下拉、默认选当前版本 */
  async function initStore(kind) {
    const el = buildResPage(kind);
    const sel = el.querySelector('.store-sel[data-f=mc]');
    if (sel.dataset.filled === '1') return;
    sel.dataset.filled = '1';
    const mc = await currentMc();
    try {
      const r = await window.api.storeMcVersions();
      const list = (r && r.versions) || [];
      for (const v of list) {
        const o = document.createElement('option');
        o.value = v; o.textContent = v;
        sel.appendChild(o);
      }
    } catch {}
    if (mc) {
      // 版本列表里可能没有当前版本（快照 / 自定义），补一个
      if (!Array.from(sel.options).some((o) => o.value === mc)) {
        const o = document.createElement('option');
        o.value = mc; o.textContent = mc + T("pg.L287C48", null, '（当前）');
        sel.insertBefore(o, sel.options[1] || null);
      }
      sel.value = mc;
    }
    doStoreSearch(kind);
  }

  function askCfKey(kind) {
    openModal('CurseForge API Key', (body) => {
      body.innerHTML = T("pg.L297C49", null, `
        <div class="md">
          <p>CurseForge 的官方接口 <strong>必须带 API Key</strong>（没有 key 会直接 403），
             Modrinth 不需要，所以不配也能正常用。</p>
          <p>申请：登录 CurseForge for Studios → API Keys → 免费生成。</p>
        </div>
        <div class="row" style="margin-top:10px">
          <input id="cf-key-input" class="store-input" style="flex:1" placeholder="粘贴 API Key，留空则清除" />
        </div>
        <div class="row" style="margin-top:10px;justify-content:flex-end">
          <button class="ghost-btn" id="cf-key-clear">清除</button>
          <button class="primary-btn" id="cf-key-save">保存</button>
        </div>
        <div class="cf-status" style="margin-top:8px"></div>`);
      const st = body.querySelector('.cf-status');
      window.api.storeKeyStatus().then((s) => { st.textContent = s.has ? (T("pg.L312C50", null, '当前：') + s.hint) : T("pg.L312C51", null, '当前：未配置（只用 Modrinth）'); });
      body.querySelector('#cf-key-save').onclick = async () => {
        const v = body.querySelector('#cf-key-input').value.trim();
        const r = await window.api.storeKeySet(v);
        st.textContent = r.ok ? (T("pg.L316C52", null, '已保存 · ') + (r.hint || '')) : (T("pg.L316C53", null, '保存失败：') + r.error);
        if (r.ok) doStoreSearch(kind);
      };
      body.querySelector('#cf-key-clear').onclick = async () => {
        await window.api.storeKeySet('');
        st.textContent = T("pg.L321C54", null, '已清除，现在只用 Modrinth');
        doStoreSearch(kind);
      };
    });
  }

  let storeSeq = 0;
  async function doStoreSearch(kind) {
    const el = buildResPage(kind);
    const bar = el.querySelector('.store-bar');
    const grid = el.querySelector('.store-grid');
    const status = el.querySelector('.store-status');
    const val = (f) => bar.querySelector(`.store-sel[data-f=${f}]`).value;
    const q = bar.querySelector('.store-input').value.trim();

    const seq = ++storeSeq;
    grid.innerHTML = T("pg.L337C55", null, '<div class="empty">正在搜索…</div>');
    status.innerHTML = '';

    // 已安装标记需要本地文件的 sha1
    let hashes = [];
    try {
      const h = await window.api.storeLocalHashes(resDir(kind));
      hashes = (h && h.hashes) || [];
    } catch {}

    const r = await window.api.storeSearch({
      kind, query: q, mc: val('mc'), loader: val('loader'),
      sort: val('sort'), source: val('source'), limit: 30, destDir: resDir(kind)
    });
    if (seq !== storeSeq) return; // 已经有更新的搜索了

    const items = (r && r.items) || [];
    const errs = (r && r.errors) || [];
    if (errs.length) {
      status.innerHTML = errs.map((e) => `<div class="chip warn">${esc(e)}</div>`).join(' ');
    }
    if (!items.length) {
      grid.innerHTML = T("pg.L359C56", null, `<div class="empty">没有结果${errs.length ? '（见上方提示）' : ''}</div>`);
      return;
    }

    grid.innerHTML = '';
    const hashSet = new Set(hashes);
    for (const it of items) {
      const card = document.createElement('div');
      card.className = 'store-card';
      const iconBox = document.createElement('div');
      iconBox.className = 'store-icon ph';
      card.appendChild(iconBox);

      const bodyEl = document.createElement('div');
      bodyEl.className = 'store-body';
      const chips = (it.loaders || []).slice(0, 3)
        .map((l) => `<span class="chip">${esc(LOADER_LABEL[l] || l)}</span>`).join('');
      bodyEl.innerHTML = T("pg.L376C57", null, `<div class="store-title">${esc(it.title)}${chips}</div>
        <div class="store-sub">${esc(it.author || '')} · ${esc(it.downloadsText || '')} 下载 · ${esc(it.updatedText || '')}</div>
        <div class="store-desc">${esc(it.summary || '')}</div>`);
      card.appendChild(bodyEl);

      const side = document.createElement('div');
      side.className = 'store-side';
      const src = document.createElement('span');
      src.className = 'src-tag ' + (it.source === 'curseforge' ? 'cf' : 'mr');
      src.textContent = it.source === 'curseforge' ? 'CF' : 'MR';
      src.title = it.source === 'curseforge' ? 'CurseForge' : 'Modrinth';
      side.appendChild(src);
      const btn = document.createElement('button');
      btn.className = 'primary-btn';
      btn.textContent = T("pg.L390C58", null, '详情');
      btn.onclick = () => openStoreDetail(kind, it, hashSet);
      side.appendChild(btn);
      card.appendChild(side);

      grid.appendChild(card);

      // 图标异步补（不阻塞列表出现）
      if (it.icon) {
        window.api.storeImage(it.icon).then((r2) => {
          if (!r2 || !r2.data) return;
          const img = document.createElement('img');
          img.className = 'store-icon';
          img.src = r2.data;
          img.alt = '';
          const ph = card.querySelector('.store-icon.ph');
          if (ph) ph.replaceWith(img);
        }).catch(() => {});
      }
    }
  }

  /** 详情弹层：介绍 + 画廊 + 版本列表 + 一键安装 */
  async function openStoreDetail(kind, item, hashSet) {
    openModal(item.title, (body) => {
      body.innerHTML = T("pg.L415C59", null, `
        <div class="sd-head">
          <div class="sd-icon ph"></div>
          <div class="sd-meta">
            <div class="sd-title">${esc(item.title)}</div>
            <div class="sd-sub">${esc(item.author || '')} · ${esc(item.downloadsText || '')} 下载 ·
              ${esc(item.updatedText || '')} · ${item.source === 'curseforge' ? 'CurseForge' : 'Modrinth'}</div>
            <div class="sd-tags"></div>
          </div>
        </div>
        <div class="sd-gallery"></div>
        <div class="md sd-body"><div class="empty-tip">正在加载介绍…</div></div>
        <div class="sd-vers">
          <div class="sd-vers-head">
            <span>可安装版本</span>
            <span class="row">
              <label class="sd-chk"><input type="checkbox" id="sd-fit" checked /> 只显示匹配当前筛选的</label>
            </span>
          </div>
          <div class="sd-vers-list"></div>
        </div>`);
      const gallery = body.querySelector('.sd-gallery');
      const bodyEl = body.querySelector('.sd-body');
      const vlist = body.querySelector('.sd-vers-list');

      // 安装进度条由主进程推送
      let progressKey = item.source + ':' + item.id;
      const progressBox = document.createElement('div');
      progressBox.className = 'sd-progress hidden';
      progressBox.innerHTML = '<div class="bar"><span></span></div><div class="txt"></div>';
      body.appendChild(progressBox);
      if (!storeProgressBound) {
        storeProgressBound = true;
        window.api.onStoreProgress((p) => {
          const box = document.querySelector('.sd-progress');
          if (!box || !p) return;
          if (box.dataset.key && box.dataset.key !== p.key) return;
          box.classList.remove('hidden');
          const pct = p.total ? Math.min(100, Math.round(p.got / p.total * 100)) : 0;
          box.querySelector('.bar span').style.width = pct + '%';
          box.querySelector('.txt').textContent = p.total
            ? T("pg.L456C60", null, `下载中 ${(p.got / 1048576).toFixed(1)} / ${(p.total / 1048576).toFixed(1)} MB`)
            : T("pg.L457C61", null, `下载中 ${(p.got / 1048576).toFixed(1)} MB`);
        });
      }

      // 图标
      if (item.icon) {
        window.api.storeImage(item.icon).then((r) => {
          if (!r || !r.data) return;
          const img = document.createElement('img');
          img.className = 'sd-icon';
          img.src = r.data;
          const ph = body.querySelector('.sd-icon.ph');
          if (ph) ph.replaceWith(img);
        }).catch(() => {});
      }

      const renderVersions = (vers, filterMc, filterLoader) => {
        vlist.innerHTML = '';
        if (!vers.length) { vlist.innerHTML = T("pg.L475C62", null, '<div class="empty-tip">没有可用版本</div>'); return; }
        const fit = document.getElementById('sd-fit');
        const onlyFit = !fit || fit.checked;
        let shown = vers;
        if (onlyFit) {
          shown = vers.filter((v) =>
            (!filterMc || (v.gameVersions || []).includes(filterMc)) &&
            (!filterLoader || (v.loaders || []).includes(filterLoader)));
          if (!shown.length) shown = vers; // 全都筛没了就别空着，退回全部
        }
        for (const v of shown.slice(0, 40)) {
          const row = document.createElement('div');
          row.className = 'sd-ver';
          const f = v.file || {};
          const installed = !!(f.sha1 && hashSet && hashSet.has(String(f.sha1).toLowerCase()));
          const typeTag = v.type === 'release' ? T("pg.L490C63", null, '<span class="chip ok">正式版</span>')
            : (v.type === 'beta' ? T("pg.L491C64", null, '<span class="chip warn">测试版</span>') : '');
          row.innerHTML = T("pg.L492C65", null, `
            <div class="sd-ver-main">
              <div class="sd-ver-name">${esc(v.name || v.number)}${typeTag}${installed ? '<span class="chip ok">已安装</span>' : ''}</div>
              <div class="sd-ver-sub">${esc((v.gameVersions || []).slice(0, 4).join(' / '))}
                ${(v.loaders || []).length ? ' · ' + esc(v.loaders.join('/')) : ''}
                ${v.dateText ? ' · ' + esc(v.dateText) : ''}</div>
            </div>`);
          const b = document.createElement('button');
          b.className = 'ghost-btn';
          b.textContent = installed ? T("pg.L501C66", null, '重新安装') : T("pg.L501C67", null, '安装');
          b.disabled = !f.url;
          if (!f.url) b.title = T("pg.L503C68", null, '该版本没有可用下载链接');
          b.onclick = async () => {
            b.disabled = true;
            b.textContent = T("pg.L506C69", null, '下载中…');
            progressBox.dataset.key = progressKey + ':' + v.id;
            progressBox.classList.remove('hidden');
            try {
              const r = await window.api.storeInstall({
                source: item.source, id: item.id, fileId: v.id,
                url: f.url, name: f.name, sha1: f.sha1, size: f.size,
                destDir: resDir(kind), key: progressBox.dataset.key
              });
              if (r && r.ok) {
                S().setStatus(r.skipped ? T("pg.L516C70", null, '已存在，跳过下载：') + f.name : T("pg.L516C71", null, '已安装到 ') + resDir(kind) + '：' + f.name);
                b.textContent = T("pg.L517C72", null, '已安装');
              } else {
                S().setStatus(T("pg.L519C73", null, '安装失败：') + ((r && r.error) || T("pg.L519C74", null, '未知错误')), 'err');
                b.textContent = T("pg.L520C75", null, '重试');
                b.disabled = false;
              }
            } catch (e) {
              S().setStatus(T("pg.L524C76", null, '安装失败：') + (e && e.message || e), 'err');
              b.textContent = T("pg.L525C77", null, '重试');
              b.disabled = false;
            }
            progressBox.classList.add('hidden');
          };
          row.appendChild(b);
          vlist.appendChild(row);
        }
      };

      // 拉取详情 + 版本
      (async () => {
        const el = buildResPage(kind);
        const val = (f) => el.querySelector(`.store-sel[data-f=${f}]`).value;
        const mc = val('mc'), loader = val('loader');
        let project = item;
        try {
          const d = await window.api.storeDetails({ source: item.source, id: item.id });
          if (d && d.ok && d.project) project = d.project;
        } catch {}

        const tags = body.querySelector('.sd-tags');
        const allTags = (project.loaders || []).concat(project.categories || []).filter(Boolean);
        tags.innerHTML = allTags.slice(0, 8).map((t) => `<span class="chip">${esc(t)}</span>`).join('');

        bodyEl.innerHTML = project.body
          ? project.body
          : T("pg.L552C78", null, `<p>${esc(project.summary || '（这个资源没有填写介绍）')}</p>`);
        // 正文里的外链改成"交给系统浏览器打开"
        bodyEl.querySelectorAll('a[data-ext]').forEach((a) => {
          a.style.cursor = 'pointer';
          a.onclick = () => window.api.openExternal(a.dataset.ext);
        });

        if (project.gallery && project.gallery.length) {
          for (const g of project.gallery.slice(0, 6)) {
            const img = document.createElement('img');
            img.className = 'sd-shot';
            img.alt = g.title || '';
            img.title = g.title || '';
            gallery.appendChild(img);
            window.api.storeImage(g.thumb || g.url).then((r) => {
              if (r && r.data) img.src = r.data; else img.remove();
            }).catch(() => img.remove());
          }
        }

        try {
          const vr = await window.api.storeVersions({ source: item.source, id: item.id, mc: mc || '' });
          renderVersions((vr && vr.versions) || [], mc, loader);
          const fit = document.getElementById('sd-fit');
          if (fit) fit.onchange = () => renderVersions((vr && vr.versions) || [], mc, loader);
        } catch (e) {
          vlist.innerHTML = T("pg.L578C79", null, '<div class="empty-tip">版本列表加载失败：') + esc(e.message || e) + '</div>';
        }
      })();
    });
  }

  /**
   * 当前资源目录。
   * 有了实例系统之后，「游戏目录」不再等于 .minecraft —— 实例可以指向完全独立的目录。
   * 所以统一以 st.gameDir（由实例解析出来）为准，没有实例信息时才退回旧算法。
   */
  function gameDir() {
    const st = S();
    // instGameDir 由实例系统解析出来；renderer 里 PL.gameDir 是个函数，别混用
    if (st.instGameDir) return st.instGameDir;
    return st.cfg.isolation && st.selectedVersion
      ? `${st.cfg.mcDir}\\versions\\${st.selectedVersion}\\isolation`
      : st.cfg.mcDir;
  }

  function resDir(kind) {
    return `${gameDir()}\\${RES_META[kind].dir}`;
  }

  /* 载入器 → 徽章文案 / 配色 */
  const LOADER_LABEL = { forge: 'Forge', fabric: 'Fabric', quilt: 'Quilt', neoforge: 'NeoForge', liteloader: 'LiteLoader', rift: 'Rift' };

  /**
   * 取资源的"真实信息"：
   * - mods  → 读 jar 里的 fabric.mod.json / mods.toml（不靠文件名猜）
   * - 其他  → 读 pack.mcmeta + pack.png
   * 拿不到就降级成文件名，绝不因为元信息读取失败而让列表空掉。
   */
  async function loadResMeta(list, kind) {
    const map = new Map();
    try {
      if (kind === 'mods') {
        const r = await window.api.modMeta(resDir(kind));
        for (const m of (r && r.mods) || []) map.set(m.path, m);
      } else {
        const st = S();
        let mc = '';
        if (st.selectedVersion) {
          try {
            const r = await window.api.resolveMcVersion(st.cfg.mcDir, st.selectedVersion);
            if (r && r.ok) mc = r.mc;
          } catch {}
        }
        const r = await window.api.packInfo(list.map((x) => x.path), kind, mc);
        for (const it of (r && r.items) || []) map.set(it.path, it);
      }
    } catch (e) {
      // 元信息失败不影响列表本身
    }
    return map;
  }

  async function refreshRes(kind) {
    const el = buildResPage(kind);
    const box = el.querySelector('.res-list');
    const list = await RES_META[kind].fn()(resDir(kind));
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = T("pg.L641C80", null, `<div class="empty">目录为空<br /><small>${esc(resDir(kind))}</small></div>`);
      if (kind === 'mods') refreshModGuard();
      return;
    }

    // 先渲染骨架（保证慢资源包也能立刻看到列表），拿到元信息后再补
    const rows = new Map();
    for (const it of list) {
      const row = document.createElement('div');
      row.className = 'res-row' + (it.enabled ? '' : ' off');
      row.innerHTML = T("pg.L651C81", null, `<div class="res-icon ph"></div>
        <div class="res-meta"><div class="res-name">${esc(it.name)}</div>
        <div class="res-sub">${fmtSize(it.size)} · ${fmtTime(it.mtime)}</div></div>
        <div class="ops">
          <span class="badge ${it.enabled ? '' : 'off'}">${it.enabled ? '已启用' : '已禁用'}</span>
          <button class="ghost-btn" data-act="toggle">${it.enabled ? '禁用' : '启用'}</button>
          <button class="ghost-btn" data-act="show">定位</button>
          <button class="ghost-btn danger" data-act="del">删除</button>
        </div>`);
      row.querySelector('[data-act=toggle]').onclick = async () => { await window.api.toggleFile(it.path); refreshRes(kind); };
      row.querySelector('[data-act=show]').onclick = () => window.api.showInExplorer(it.path);
      row.querySelector('[data-act=del]').onclick = async () => {
        if (!confirm(T("pg.L663C82", null, '确定删除 ') + it.name + ' ？')) return;
        await window.api.deletePath(it.path); refreshRes(kind);
      };
      box.appendChild(row);
      rows.set(it.path, row);
    }

    // Mod 列表刷新时顺带重跑一次预检，保证面板和列表始终一致
    if (kind === 'mods') refreshModGuard();

    const meta = await loadResMeta(list, kind);
    for (const it of list) {
      const row = rows.get(it.path);
      if (!row) continue;
      const m = meta.get(it.path);
      if (!m) continue;
      if (kind === 'mods') decorateModRow(row, it, m);
      else decoratePackRow(row, it, m, kind);
    }
  }

  /** Mod 行：真实名 + 版本 + 载入器徽章；解析不出时标「未识别」 */
  function decorateModRow(row, it, m) {
    const chips = [];
    if (m.loader) chips.push(`<span class="chip">${esc(LOADER_LABEL[m.loader] || m.loader)}</span>`);
    if (m.version) chips.push(`<span class="chip">v${esc(m.version)}</span>`);
    if (m.mcRange) chips.push(`<span class="chip">MC ${esc(m.mcRange)}</span>`);
    if (m.unknown) chips.push(T("pg.L690C83", null, `<span class="chip warn">元数据未识别</span>`));
    const realName = m.name && m.name !== it.name ? m.name : it.name;
    row.querySelector('.res-name').innerHTML = esc(realName) + chips.join('');
    // 文件名仍然要能看到（jar 名常常和 mod 名不一样，排查问题时靠它）
    row.querySelector('.res-sub').textContent =
      `${it.name} · ${fmtSize(it.size)} · ${fmtTime(it.mtime)}${m.id ? ' · ' + m.id : ''}`;
  }

  /** 资源包 / 光影行：图标 + 描述 + 适用版本（不匹配时警告） */
  function decoratePackRow(row, it, m, kind) {
    const ph = row.querySelector('.res-icon');
    if (m.icon) {
      const img = document.createElement('img');
      img.className = 'res-icon';
      img.src = m.icon;
      img.alt = '';
      ph.replaceWith(img);
    } else {
      ph.textContent = kind === 'shaders' ? '✦' : '▣';
    }

    const chips = [];
    if (m.isDir) chips.push(T("pg.L712C84", null, '<span class="chip">文件夹</span>'));
    if (m.mc) {
      const bad = m.compat === false;
      chips.push(T("pg.L715C85", null, `<span class="chip ${bad ? 'warn' : 'ok'}">${esc(m.mc)}${bad ? ' 不适用' : ''}</span>`));
    } else if (m.format != null) {
      chips.push(T("pg.L717C86", null, `<span class="chip warn">未知 pack_format ${m.format}</span>`));
    }
    if (kind === 'shaders' && m.shaderFiles != null) chips.push(T("pg.L719C87", null, `<span class="chip">${m.shaderFiles} 个着色器</span>`));
    if (m.note) chips.push(`<span class="chip warn">${esc(m.note)}</span>`);

    row.querySelector('.res-name').innerHTML = esc(m.name || it.name) + chips.join('');
    const parts = [fmtSize(it.size), fmtTime(it.mtime)];
    row.querySelector('.res-sub').textContent = parts.join(' · ');

    if (m.desc) {
      const d = document.createElement('div');
      d.className = 'res-desc';
      d.textContent = m.desc;
      row.querySelector('.res-meta').appendChild(d);
    }
  }

  /* ============ 通用弹层 ============ */
  function openModal(title, build) {
    const m = $('modal');
    if (!m) return;
    $('modal-title').textContent = title;
    const body = $('modal-body');
    body.innerHTML = '';
    m.classList.remove('hidden');
    try { build(body); } catch (e) { body.textContent = String(e && e.message || e); }
  }
  function closeModal() { const m = $('modal'); if (m) m.classList.add('hidden'); }
  (function bindModal() {
    const c = $('modal-close'); if (c) c.onclick = closeModal;
    const mask = document.querySelector('.modal-mask');
    if (mask) mask.onclick = closeModal;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
    const bind = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
    bind('mg-scan', () => refreshModGuard());
    bind('mg-snap', () => modSnapshot());
    bind('mg-rollback', () => modTimeMachine());
  })();

  /* ============ Mod 守卫（破坏性变更预检 + 后悔药） ============ */
  async function refreshModGuard() {
    const box = $('mod-guard');
    if (!box) return;
    const st = S();
    const gd = st.gameDir();
    box.innerHTML = T("pg.L762C88", null, '<div class="empty-tip">正在读取 mod 元数据…</div>');

    // 版本 id 可能是 "fabric-loader-0.15.7-1.20.1"，真正的 MC 版本要从继承链里解析
    let mc = '';
    if (st.selectedVersion) {
      try {
        const r = await window.api.resolveMcVersion(st.cfg.mcDir, st.selectedVersion);
        if (r && r.ok) mc = r.mc;
      } catch {}
    }

    const r = await window.api.modAnalyze(gd, mc, 'auto');
    if (!r || !r.ok) { box.innerHTML = T("pg.L774C89", null, `<div class="empty-tip">体检失败: ${esc((r && r.error) || '未知错误')}</div>`); return; }

    const errs = r.issues.filter((i) => i.level === 'error').length;
    const warns = r.issues.filter((i) => i.level === 'warn').length;
    const html = [];
    html.push(T("pg.L779C90", null, `<div class="guard-summary">
      <span class="pill ${errs ? 'err' : 'ok'}">${errs ? errs + ' 个致命' : '未发现致命问题'}</span>
      ${warns ? `<span class="pill warn">${warns} 个警告</span>` : ''}
      <span class="pill">mod ${r.mods.length}</span>
      ${r.loader ? `<span class="pill">生态 ${esc(r.loader)}${r.loaderInferred ? '（自动识别）' : ''}</span>` : ''}
      ${mc ? `<span class="pill">MC ${esc(mc)}</span>` : ''}
    </div>`));

    if (!r.issues.length) {
      html.push(T("pg.L788C91", null, '<div class="empty-tip">没有发现问题。改动 mod 之前记得点「打快照」，出事能一键退回。</div>'));
    } else {
      for (const i of r.issues.slice(0, 40)) {
        html.push(`<div class="issue ${i.level}">
          <div class="issue-t">${i.level === 'error' ? '✖ ' : i.level === 'warn' ? '! ' : 'i '}${esc(i.title)}</div>
          <div class="issue-f">${esc(i.file)}</div>
          <div class="issue-d">${esc(i.detail)}</div>
        </div>`);
      }
      if (r.issues.length > 40) html.push(T("pg.L797C92", null, `<div class="empty-tip">…还有 ${r.issues.length - 40} 条，先处理上面这些。</div>`));
    }
    box.innerHTML = html.join('');
  }

  async function modSnapshot() {
    const st = S();
    st.setStatus(T("pg.L804C93", null, '正在为 Mod 组合打快照…'), 'run');
    const r = await window.api.modSnapshot(st.gameDir(), T("pg.L805C94", null, '手动快照'));
    st.setStatus(r && r.ok ? T("pg.L806C95", null, `已打快照（新增 ${((r.snap.newBytes || 0) / 1048576).toFixed(1)} MB）`) : T("pg.L806C96", null, '快照失败: ') + ((r && r.error) || ''),
      r && r.ok ? '' : 'err');
    refreshModGuard();
  }

  async function modTimeMachine() {
    const st = S();
    const gd = st.gameDir();
    openModal(T("pg.L814C97", null, 'Mod 时光机'), async (body) => {
      body.innerHTML = T("pg.L815C98", null, '<div class="empty-tip">加载中…</div>');
      const [list, st2, d] = await Promise.all([
        window.api.modSnapList(gd), window.api.modStats(gd), window.api.modDiffLatest(gd)
      ]);

      const parts = [];
      parts.push(T("pg.L821C99", null, `<div class="tm-stat">共 ${list.length} 个快照 · 逻辑 ${fmtSize(st2.logical || 0)} · 实际占用 ${fmtSize(st2.physical || 0)} · 去重比 ${(st2.ratio || 1).toFixed(2)}x</div>`));

      // 先说"和上次快照比，这次动了什么"——这才是启动后崩了最想知道的
      if (d && d.ok && d.hasBase) {
        const df = d.diff || {};
        const bits = [];
        if (df.added && df.added.length) bits.push(T("pg.L827C100", null, '新增 ') + df.added.map((m) => esc(m.file)).join('、'));
        if (df.removed && df.removed.length) bits.push(T("pg.L828C101", null, '移除 ') + df.removed.map((m) => esc(m.file)).join('、'));
        if (df.updated && df.updated.length) {
          bits.push(T("pg.L830C102", null, '更新 ') + df.updated.map((u) => T("pg.L830C103", null, `${esc(u.file)} ${esc(u.from)}→${esc(u.to)}${u.downgrade ? '（回退）' : ''}`)).join('、'));
        }
        parts.push(T("pg.L832C104", null, `<div class="hl-sec">与最近快照（${esc(d.base.label)} · ${fmtTime(d.base.time)}）的差异</div>`));
        parts.push(bits.length ? `<div class="tm-tip">${bits.join('<br />')}</div>` : T("pg.L833C105", null, '<div class="tm-tip">没有变化。</div>'));
      } else {
        parts.push(T("pg.L835C106", null, '<div class="tm-tip">还没有基准快照。在改动 mod 前先打一个，之后就能对比出"这次到底改了什么"。</div>'));
      }

      parts.push(T("pg.L838C107", null, '<div class="hl-sec">快照列表</div>'));
      if (!list.length) {
        parts.push(T("pg.L840C108", null, '<div class="empty-tip">暂无快照</div>'));
      } else {
        for (const s of list) {
          const mods = (s.modList || []).length;
          parts.push(T("pg.L844C109", null, `<div class="tm-row" data-id="${esc(s.id)}">
            <div class="tm-meta">
              <div class="tm-name">${esc(s.label || s.id)}${s.auto ? ' · 自动' : ''}</div>
              <div class="tm-sub">${fmtTime(s.time)} · ${s.fileCount} 个文件${mods ? ' · ' + mods + ' 个 mod' : ''} · ${fmtSize(s.totalSize || 0)}</div>
            </div>
            <div class="tm-ops">
              <button class="ghost-btn" data-act="restore">回到这里</button>
              <button class="ghost-btn danger" data-act="del">删除</button>
            </div></div>`));
        }
      }
      body.innerHTML = parts.join('');

      body.querySelectorAll('.tm-row').forEach((row) => {
        const id = row.dataset.id;
        row.querySelector('[data-act=restore]').onclick = async () => {
          if (!confirm(T("pg.L860C110", null, '把 mods 目录恢复到这个快照？\n当前状态会先自动存一份，可以再退回来。'))) return;
          const r = await window.api.modRestore(gd, id);
          st.setStatus(r && r.ok ? T("pg.L862C111", null, '已回滚 Mod 组合') : T("pg.L862C112", null, '回滚失败: ') + ((r && r.error) || ''), r && r.ok ? '' : 'err');
          closeModal(); refreshRes('mods');
        };
        row.querySelector('[data-act=del]').onclick = async () => {
          await window.api.modSnapDelete(id);
          modTimeMachine();
        };
      });
    });
  }

  /* ============ 实例 / 迁移 ============ */
  let INS_STATE = { list: [], activeId: '', selected: '', copyable: [] };

  /** 重新拉取实例表，并把它同步到启动页的下拉框 */
  async function refreshInstances() {
    const st = S();
    let data = { activeId: '', instances: [] };
    try { data = await window.api.instList(st.cfg.mcDir, st.selectedVersion); } catch (e) { /* 首次可能还没起来 */ }
    INS_STATE.list = data.instances || [];
    INS_STATE.activeId = data.activeId || '';
    if (!INS_STATE.selected) INS_STATE.selected = INS_STATE.activeId;
    if (!INS_STATE.copyable.length) {
      try { INS_STATE.copyable = await window.api.instCopyable(); } catch {}
    }

    // 启动页下拉框
    const sel = $('inst-select');
    if (sel) {
      const keep = sel.value || INS_STATE.activeId;
      sel.innerHTML = '';
      for (const i of INS_STATE.list) {
        const o = document.createElement('option');
        o.value = i.id;
        o.textContent = i.name + (i.id === INS_STATE.activeId ? T("pg.L896C113", null, '（当前）') : '');
        sel.appendChild(o);
      }
      sel.value = INS_STATE.list.some((i) => i.id === keep) ? keep : INS_STATE.activeId;
    }
    renderInsList();
    renderInsDetail();
    // 让 renderer 知道当前实例指向哪个目录（资源页 / 启动都依赖它）
    await syncActiveGameDir();
    fillMigTargets();
  }

  /** 把「当前实例 → 真实游戏目录」告诉全局状态 */
  async function syncActiveGameDir() {
    const st = S();
    const id = INS_STATE.selected || INS_STATE.activeId;
    if (!id) { st.instGameDir = st.cfg.mcDir; return; }
    try {
      const inst = INS_STATE.list.find((i) => i.id === id);
      // 已经带 gameDir 的实例直接用；空 gameDir 的实例走老逻辑
      st.instGameDir = inst && inst.gameDir ? inst.gameDir
        : (st.cfg.isolation && st.selectedVersion
            ? `${st.cfg.mcDir}\\versions\\${st.selectedVersion}\\isolation`
            : st.cfg.mcDir);
      st.instanceId = id;
    } catch { st.instGameDir = st.cfg.mcDir; }
    const hint = $('inst-hint');
    if (hint) hint.textContent = T("pg.L923C114", null, '游戏目录：') + st.instGameDir;
  }

  function renderInsList() {
    const box = $('ins-list');
    if (!box) return;
    box.innerHTML = '';
    if (!INS_STATE.list.length) {
      box.innerHTML = T("pg.L931C115", null, '<div class="empty">还没有实例</div>');
      return;
    }
    for (const i of INS_STATE.list) {
      const el = document.createElement('div');
      el.className = 'ins-card' + (i.id === INS_STATE.selected ? ' on' : '');
      const s = i.stats || {};
      const tags = [];
      if (i.builtin) tags.push(T("pg.L939C116", null, '<span class="chip">内置</span>'));
      if (i.version) tags.push('<span class="chip">' + esc(i.version) + '</span>');
      if (i.loader) tags.push('<span class="chip">' + esc(i.loader) + '</span>');
      if (s.mods) tags.push('<span class="chip">' + s.mods + ' Mod</span>');
      if (s.saves) tags.push('<span class="chip">' + s.saves + T("pg.L943C117", null, ' 存档</span>'));
      if (s.size) tags.push('<span class="chip">' + fmtSize(s.size) + '</span>');
      el.innerHTML = T("pg.L945C118", null, `<div class="ins-main">
          <div class="ins-name">${esc(i.name)}${i.id === INS_STATE.activeId ? '<span class="chip ok">当前</span>' : ''}</div>
          <div class="ins-sub">${esc(i.gameDir || '沿用 .minecraft（不隔离）')}</div>
          <div class="ins-tags">${tags.join('')}</div>
        </div>`);
      el.onclick = async () => { INS_STATE.selected = i.id; renderInsList(); renderInsDetail(); };
      el.ondblclick = () => activateInstance(i.id);
      box.appendChild(el);
    }
  }

  function renderInsDetail() {
    const box = $('ins-detail');
    if (!box) return;
    const i = INS_STATE.list.find((x) => x.id === INS_STATE.selected);
    if (!i) { box.innerHTML = T("pg.L960C119", null, '<div class="tip">未选择实例</div>'); return; }
    const s = i.stats || {};
    const row = (k, v) => `<div><span class="k">${k}</span><span class="v">${esc(v || '—')}</span></div>`;
    box.innerHTML =
      row(T("pg.L964C120", null, '名称'), i.name) +
      row(T("pg.L965C121", null, '版本'), i.version) +
      row(T("pg.L966C122", null, '载入器'), i.loader) +
      row(T("pg.L967C123", null, '内存'), i.mem ? i.mem + ' GB' : T("pg.L967C124", null, '跟随全局')) +
      row(T("pg.L968C125", null, '游戏目录'), i.gameDir || T("pg.L968C126", null, '沿用 .minecraft')) +
      row(T("pg.L969C127", null, '备注'), i.note) +
      row(T("pg.L970C128", null, '规模'), T("pg.L970C129", null, `${s.mods || 0} Mod · ${s.saves || 0} 存档 · ${s.rps || 0} 资源包 · ${s.size ? fmtSize(s.size) : '—'}`));
  }

  async function activateInstance(id) {
    try {
      await window.api.instSetActive(id);
      INS_STATE.selected = id;
      INS_STATE.activeId = id;
      await refreshInstances();
      S().setStatus(T("pg.L979C130", null, '已切换到该实例'), '');
      // 切换后资源页内容全变了，全部重刷
      await refreshAllRes();
    } catch (e) { S().setStatus(T("pg.L982C131", null, '切换失败: ') + (e.error || e.message), 'err'); }
  }

  async function refreshAllRes() {
    for (const k of ['mods', 'rps', 'shaders']) {
      const el = document.querySelector(`.res-page[data-kind="${k}"]`);
      if (el && el.dataset.built === '1') { try { await refreshRes(k); } catch {} }
    }
  }

  async function newInstance() {
    const st = S();
    const copyable = INS_STATE.copyable.length ? INS_STATE.copyable : [];
    openModal(T("pg.L995C132", null, '新建实例'), (body) => {
      body.innerHTML = T("pg.L996C133", null, `
        <div class="row"><label class="k">名称</label><input id="ni-name" class="inp" placeholder="如：科技整合包" spellcheck="false" /></div>
        <div class="row"><label class="k">游戏版本</label><input id="ni-ver" class="inp" placeholder="${esc(st.selectedVersion || '留空跟随全局')}" spellcheck="false" /></div>
        <div class="row"><label class="k">目录</label><input id="ni-dir" class="inp" placeholder="留空自动分配" spellcheck="false" /><button id="ni-pick" class="ghost-btn">浏览</button></div>
        <div class="hl-sec">从现有实例带过去什么</div>
        <div id="ni-items" class="scroll" style="max-height:180px"></div>
        <div class="row wrap" style="margin-top:10px"><button id="ni-ok" class="primary-btn">创建</button></div>`);
      const box = body.querySelector('#ni-items');
      const cur = INS_STATE.list.find((i) => i.id === INS_STATE.selected) || null;
      const srcLabel = cur ? (cur.gameDir || st.cfg.mcDir) : st.cfg.mcDir;
      box.innerHTML = T("pg.L1006C134", null, `<div class="tip" style="margin-bottom:6px">来源：${esc(srcLabel)}</div>`) +
        copyable.map((c) => `<label class="ck-row"><input type="checkbox" value="${esc(c.key)}" checked />
          <span class="ck-main"><span class="ck-name">${esc(c.label)}</span></span></label>`).join('');
      body.querySelector('#ni-pick').onclick = async () => {
        const d = await window.api.pickDirectory();
        if (d) body.querySelector('#ni-dir').value = d;
      };
      body.querySelector('#ni-ok').onclick = async () => {
        const name = (body.querySelector('#ni-name').value || '').trim();
        if (!name) { st.setStatus(T("pg.L1015C135", null, '请填实例名'), 'err'); return; }
        const items = Array.from(box.querySelectorAll('input:checked')).map((x) => x.value);
        const dir = (body.querySelector('#ni-dir').value || '').trim();
        try {
          const r = await window.api.instCreate({
            name,
            version: (body.querySelector('#ni-ver').value || '').trim() || st.selectedVersion,
            gameDir: dir || undefined,
            copyFrom: [srcLabel],
            items
          });
          if (r && r.error) { st.setStatus(T("pg.L1026C136", null, '创建失败: ') + r.error, 'err'); return; }
          closeModal();
          await refreshInstances();
          st.setStatus(T("pg.L1029C137", null, '实例已创建：') + name, '');
        } catch (e) { st.setStatus(T("pg.L1030C138", null, '创建失败: ') + (e.error || e.message), 'err'); }
      };
    });
  }

  async function dupInstance() {
    const id = INS_STATE.selected;
    if (!id) return;
    const st = S();
    const name = prompt(T("pg.L1039C139", null, '副本名称'), (INS_STATE.list.find((i) => i.id === id) || {}).name + T("pg.L1039C140", null, ' 副本'));
    if (!name) return;
    try {
      const r = await window.api.instDuplicate({ id, name });
      if (r && r.error) { st.setStatus(T("pg.L1043C141", null, '复制失败: ') + r.error, 'err'); return; }
      await refreshInstances();
      st.setStatus(T("pg.L1045C142", null, '已复制实例'), '');
    } catch (e) { st.setStatus(T("pg.L1046C143", null, '复制失败: ') + (e.error || e.message), 'err'); }
  }

  async function delInstance() {
    const i = INS_STATE.list.find((x) => x.id === INS_STATE.selected);
    if (!i) return;
    if (i.builtin) { S().setStatus(T("pg.L1052C144", null, '默认实例不能删除'), 'err'); return; }
    const kill = confirm(T("pg.L1053C145", null, `删除实例「${i.name}」？\n\n确定 = 只删记录（文件保留）\n要连文件一起删请再点一次「确定」后勾选\n\n点取消放弃。`));
    if (!kill) return;
    const alsoFiles = confirm(T("pg.L1055C146", null, '是否同时删除游戏文件？\n') + (i.gameDir || '') + T("pg.L1055C147", null, '\n（点「确定」= 连同文件一起删，不可恢复）'));
    try {
      const r = await window.api.instRemove(i.id, alsoFiles);
      if (r && r.error) { S().setStatus(T("pg.L1058C148", null, '删除失败: ') + r.error, 'err'); return; }
      await refreshInstances();
      S().setStatus(alsoFiles ? T("pg.L1060C149", null, '已删除实例及其文件') : T("pg.L1060C150", null, '已删除实例（文件保留）'), '');
    } catch (e) { S().setStatus(T("pg.L1061C151", null, '删除失败: ') + (e.error || e.message), 'err'); }
  }

  /* ---- 迁移 ---- */
  let MIG = { found: [], picked: null, content: null };

  async function migDetect() {
    const box = $('mig-found');
    if (!box) return;
    box.innerHTML = T("pg.L1070C152", null, '<div class="empty">扫描中…</div>');
    let list = [];
    try {
      const r = await window.api.migDetect();
      list = (r && r.items) || (r && r.ok && r.items) || (Array.isArray(r) ? r : []) || [];
    } catch (e) { box.innerHTML = T("pg.L1075C153", null, '<div class="empty">扫描失败：') + esc(e.message || e) + '</div>'; return; }
    MIG.found = list;
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = T("pg.L1079C154", null, '<div class="empty">没找到其他启动器<br /><small>可以点「手动指定目录」直接选一个游戏目录</small></div>');
      fillMigTargets();
      return;
    }
    for (const l of list) {
      const h = document.createElement('div');
      h.className = 'mig-launcher';
      h.textContent = l.name + '（' + (l.instances || []).length + '）';
      box.appendChild(h);
      for (const it of l.instances || []) {
        const el = document.createElement('div');
        el.className = 'mig-item';
        el.innerHTML = `<div class="mi-main"><div class="mi-name">${esc(it.name)}</div>
            <div class="mi-sub">${esc(it.gameDir)}</div></div>`;
        el.onclick = () => pickMigrationSource(it.gameDir);
        box.appendChild(el);
      }
    }
    fillMigTargets();
  }

  async function pickMigrationSource(dir) {
    if (!dir) {
      dir = await window.api.pickDirectory();
      if (!dir) return;
    }
    MIG.picked = dir;
    const box = $('mig-content');
    if (box) box.innerHTML = T("pg.L1107C155", null, '<div class="empty">清点中…</div>');
    let r;
    try { r = await window.api.migScan(dir); } catch (e) { r = { ok: false, error: e.message }; }
    if (!r || r.ok === false || r.error) {
      if (box) box.innerHTML = T("pg.L1111C156", null, '<div class="empty">读取失败：') + esc((r && r.error) || T("pg.L1111C157", null, '未知')) + '</div>';
      return;
    }
    const c = r.items || r;
    MIG.content = c;
    if (!c.exists) { if (box) box.innerHTML = T("pg.L1116C158", null, '<div class="empty">这个目录不是有效的游戏目录</div>'); return; }
    switchMigTab('content');
    renderMigContent();
  }

  function renderMigContent() {
    const box = $('mig-content');
    const c = MIG.content;
    if (!box || !c) return;
    const groups = [
      { kind: 'saves', label: T("pg.L1126C159", null, '存档'), list: c.saves || [], name: (x) => x.name, path: (x) => x.dir, sub: (x) => fmtSize(x.size || 0) },
      { kind: 'mods', label: 'Mod', list: c.mods || [], name: (x) => x.name, path: (x) => x.path, sub: (x) => fmtSize(x.size || 0) },
      { kind: 'rps', label: T("pg.L1128C160", null, '资源包'), list: c.rps || [], name: (x) => x.name, path: (x) => x.path, sub: (x) => fmtSize(x.size || 0) },
      { kind: 'shaders', label: T("pg.L1129C161", null, '光影'), list: c.shaders || [], name: (x) => x.name, path: (x) => x.path, sub: (x) => fmtSize(x.size || 0) },
      { kind: 'shots', label: T("pg.L1130C162", null, '截图'), list: c.shots || [], name: (x) => x.name, path: (x) => x.path, sub: (x) => fmtSize(x.size || 0) }
    ];
    let html = T("pg.L1132C163", null, `<div class="tip" style="margin-bottom:8px">来源：${esc(MIG.picked || '')} · 共 ${fmtSize(c.size || 0)}</div>`);
    if ((c.players || []).length) html += T("pg.L1133C164", null, `<div class="tip" style="margin-bottom:8px">发现玩家名：${esc((c.players || []).join('、'))}（凭据不会被导入）</div>`);
    for (const g of groups) {
      if (!g.list.length) continue;
      html += `<div class="mig-launcher">${g.label}（${g.list.length}）</div>`;
      html += T("pg.L1137C165", null, `<label class="ck-row"><input type="checkbox" data-all="${esc(g.kind)}" checked />
        <span class="ck-main"><span class="ck-name">全选 ${esc(g.label)}</span></span></label>`);
      for (const x of g.list) {
        html += `<label class="ck-row"><input type="checkbox" data-kind="${esc(g.kind)}" data-path="${esc(g.path(x))}" checked />
          <span class="ck-main"><span class="ck-name">${esc(g.name(x))}</span><span class="ck-sub"> ${esc(g.sub(x))}</span></span></label>`;
      }
    }
    if (c.options) {
      html += T("pg.L1145C166", null, `<div class="mig-launcher">游戏设置</div>
        <label class="ck-row"><input type="checkbox" data-kind="options" data-path="${esc(MIG.picked)}\\options.txt" checked />
        <span class="ck-main"><span class="ck-name">options.txt（画质 / 键位 / 音量）</span></span></label>`);
    }
    box.innerHTML = html;
    for (const all of box.querySelectorAll('[data-all]')) {
      all.onchange = () => {
        const k = all.dataset.all;
        for (const x of box.querySelectorAll(`[data-kind="${k}"]`)) x.checked = all.checked;
      };
    }
  }

  function fillMigTargets() {
    const sel = $('mig-target');
    if (!sel) return;
    const keep = sel.value;
    sel.innerHTML = '';
    for (const i of INS_STATE.list) {
      const o = document.createElement('option');
      o.value = i.gameDir || '';
      o.textContent = i.name + (i.gameDir ? '' : '（.minecraft）');
      sel.appendChild(o);
    }
    // 再补一个"目标 = 当前选择的实例目录"，默认选中当前实例
    const st = S();
    const def = (INS_STATE.list.find((i) => i.id === INS_STATE.selected) || {}).gameDir || st.cfg.mcDir;
    let has = false;
    for (const o of sel.options) if (o.value === def) has = true;
    if (!has) {
      const o = document.createElement('option');
      o.value = def; o.textContent = T("pg.L1176C167", null, '当前游戏目录');
      sel.appendChild(o);
    }
    sel.value = INS_STATE.list.some((i) => (i.gameDir || '') === keep) ? keep : def;
  }

  async function doMigImport() {
    const box = $('mig-content');
    const log = $('mig-log');
    if (!box) return;
    const dest = ($('mig-target') || {}).value;
    if (!dest) { S().setStatus(T("pg.L1187C168", null, '请选择导入目标'), 'err'); return; }
    const groups = {};
    for (const x of box.querySelectorAll('input[data-kind]:checked')) {
      const k = x.dataset.kind;
      (groups[k] = groups[k] || []).push(x.dataset.path);
    }
    const items = Object.keys(groups).map((k) => ({ kind: k, paths: groups[k] }));
    if (!items.length) { S().setStatus(T("pg.L1194C169", null, '没有勾选任何内容'), 'err'); return; }
    if (log) log.textContent = T("pg.L1195C170", null, '导入中…');
    try {
      const r = await window.api.migImport(dest, items, !!($('mig-overwrite') || {}).checked);
      const rep = (r && r.report) || r || {};
      if (log) {
        log.textContent = T("pg.L1200C171", null, `完成：复制 ${rep.copied || 0} 项，跳过 ${rep.skipped || 0} 项，失败 ${rep.failed || 0} 项`) +
          ((rep.errors || []).length ? '\n' + rep.errors.join('\n') : '');
      }
      S().setStatus(T("pg.L1203C172", null, `导入完成：${rep.copied || 0} 项`), (rep.failed ? 'err' : ''));
      await refreshInstances();
      await refreshAllRes();
    } catch (e) {
      if (log) log.textContent = T("pg.L1207C173", null, '导入失败：') + (e.error || e.message);
      S().setStatus(T("pg.L1208C174", null, '导入失败: ') + (e.error || e.message), 'err');
    }
  }

  function switchMigTab(name) {
    for (const t of document.querySelectorAll('[data-mtab]')) t.classList.toggle('active', t.dataset.mtab === name);
    const a = $('mtab-found'), b = $('mtab-content');
    if (a) a.classList.toggle('active', name === 'found');
    if (b) b.classList.toggle('active', name === 'content');
  }

  /** 实例页的按钮 / 分页签统一在这里绑定（renderer 切页时调一次） */
  function initInstancePage() {
    if ($('ins-new') && $('ins-new').dataset.bound) return;
    const bind = (id, fn) => { const e = $(id); if (e) { e.dataset.bound = '1'; e.onclick = fn; } };
    bind('ins-new', newInstance);
    bind('ins-refresh', refreshInstances);
    bind('ins-open', () => { const i = INS_STATE.list.find((x) => x.id === INS_STATE.selected); window.api.openFolder((i && i.gameDir) || S().cfg.mcDir); });
    bind('ins-activate', () => activateInstance(INS_STATE.selected));
    bind('ins-dup', dupInstance);
    bind('ins-del', delInstance);
    bind('mig-scan-btn', migDetect);
    bind('mig-pick', () => pickMigrationSource(null));
    bind('mig-import', doMigImport);
    for (const t of document.querySelectorAll('[data-mtab]')) {
      if (t.dataset.bound) continue;
      t.dataset.bound = '1';
      t.onclick = () => switchMigTab(t.dataset.mtab);
    }
    const sel = $('inst-select');
    if (sel && !sel.dataset.bound) {
      sel.dataset.bound = '1';
      sel.onchange = async () => {
        INS_STATE.selected = sel.value;
        renderInsList();
        renderInsDetail();
        await syncActiveGameDir();
        await refreshAllRes();
      };
    }
  }

  /** 新建实例后用来刷新「导入目标」下拉 */
  function insState() { return INS_STATE; }

  /* ============ 存档 ============ */
  async function refreshSaves() {
    const st = S();
    const box = $('saves-list');
    const dir = st.gameDir();
    const list = await window.api.listSaves(dir);
    box.innerHTML = '';
    if (!list.length) { box.innerHTML = T("pg.L1260C175", null, `<div class="empty">没有存档<br /><small>${esc(dir)}\\saves</small></div>`); return; }
    for (const s of list) {
      const card = document.createElement('div');
      card.className = 'save-card';
      const icon = s.icon ? `<img class="save-icon" src="file:///${s.icon.replace(/\\/g, '/')}" />` : '<div class="save-icon"></div>';
      card.innerHTML = T("pg.L1265C176", null, `${icon}<div class="save-info">
        <div class="save-name">${esc(s.name)}</div>
        <div class="save-sub">${esc(s.version || '未知版本')} · ${esc(s.gameType)}${s.hardcore ? ' · 极限' : ''}${s.cheats ? ' · 作弊' : ''}</div>
        <div class="save-sub">${fmtTime(s.lastPlayed)} · ${fmtSize(s.size)}</div>
        <div class="save-ops">
          <button class="ghost-btn" data-act="open">打开</button>
          <button class="ghost-btn" data-act="backup">导出zip</button>
          <button class="ghost-btn" data-act="health">体检</button>
          <button class="ghost-btn" data-act="tm">时光机</button>
          <button class="ghost-btn danger" data-act="del">删除</button>
        </div></div>`);
      card.querySelector('[data-act=open]').onclick = () => window.api.openFolder(s.dir);
      card.querySelector('[data-act=backup]').onclick = async () => {
        const f = await window.api.saveFile(s.name.replace(/[\\/:*?"<>|]/g, '_') + '.zip');
        if (!f) return;
        const r = await window.api.zipDir(s.dir, f);
        st.setStatus(r && r.ok ? T("pg.L1281C177", null, '备份完成: ') + f : T("pg.L1281C178", null, '备份失败: ') + (r && r.error), r && r.ok ? '' : 'err');
      };
      card.querySelector('[data-act=health]').onclick = () => saveHealth(s);
      card.querySelector('[data-act=tm]').onclick = () => saveTimeMachine(s);
      card.querySelector('[data-act=del]').onclick = async () => {
        if (!confirm(T("pg.L1286C179", null, '确定删除存档「') + s.name + T("pg.L1286C180", null, '」？此操作不可恢复！'))) return;
        await window.api.deletePath(s.dir); refreshSaves();
      };
      box.appendChild(card);
    }
  }

  /* ============ 存档体检 ============ */
  async function saveHealth(s) {
    const st = S();
    openModal(T("pg.L1296C181", null, '存档体检 · ') + s.name, async (body) => {
      body.innerHTML = T("pg.L1297C182", null, '<div class="empty-tip">正在扫描 region 文件…</div>');
      const r = await window.api.saveHealth(s.dir);
      if (!r || !r.ok) { body.innerHTML = T("pg.L1299C183", null, `<div class="empty-tip">体检失败: ${esc((r && r.error) || '未知错误')}</div>`); return; }

      const cells = [
        [r.ok ? T("pg.L1302C184", null, '健康') : T("pg.L1302C185", null, '有问题'), r.ok ? 'ok' : 'err'],
        [r.chunkTotal + T("pg.L1303C186", null, ' 区块'), ''],
        [r.badTotal + T("pg.L1304C187", null, ' 损坏'), r.badTotal ? 'err' : ''],
        [r.oversize.length + T("pg.L1305C188", null, ' 超大'), r.oversize.length ? 'warn' : ''],
        [r.entityTotal + T("pg.L1306C189", null, ' 实体'), ''],
        [r.hotspots.length + T("pg.L1307C190", null, ' 热点'), r.hotspots.length ? 'warn' : '']
      ];
      const parts = ['<div class="hl-grid">'];
      for (const [num, cls] of cells) {
        parts.push(`<div class="hl-cell"><div class="hl-num ${cls}">${num}</div></div>`);
      }
      parts.push('</div>');
      parts.push(T("pg.L1314C191", null, `<div class="tm-tip">扫描了 ${r.scannedFiles} 个 region 文件${r.ok ? '，没有发现结构性问题。' : '，下面这些位置可能出问题。'}</div>`));

      const list = (title, arr, fmt) => {
        if (!arr || !arr.length) return '';
        let h = `<div class="hl-sec">${title}（${arr.length}）</div>`;
        for (const x of arr.slice(0, 30)) h += `<div class="kv">· ${fmt(x)}</div>`;
        if (arr.length > 30) h += T("pg.L1320C192", null, `<div class="kv">…还有 ${arr.length - 30} 条</div>`);
        return h;
      };
      parts.push(list(T("pg.L1323C193", null, '损坏区块（进这个区域会崩/回档）'), r.corrupt,
        (c) => T("pg.L1324C194", null, `${esc(c.dim)} ${esc(c.file)} 区块(${c.cx},${c.cz}) — ${esc(c.reason)}`)));
      parts.push(list(T("pg.L1325C195", null, '超大区块（读取卡顿）'), r.oversize,
        (o) => T("pg.L1326C196", null, `${esc(o.dim)} 区块(${o.cx},${o.cz}) — ${(o.bytes / 1048576).toFixed(2)} MB`)));
      parts.push(list(T("pg.L1327C197", null, '实体热点（卡顿源头）'), r.hotspots,
        (h2) => T("pg.L1328C198", null, `${esc(h2.dim)} 区块(${h2.cx},${h2.cz}) — ${h2.entities} 个实体`)));

      if (r.badTotal || r.oversize.length || r.hotspots.length) {
        parts.push(T("pg.L1331C199", null, '<div class="hl-sec">建议</div><div class="tm-tip">')
          + T("pg.L1332C200", null, '体检只做只读扫描，不会改动存档。若确实损坏，先去「时光机」回到损坏前的快照；')
          + T("pg.L1333C201", null, '实体热点通常是刷怪塔或掉落物堆积，进去清理即可。</div>'));
      }
      body.innerHTML = parts.join('');
    });
  }

  /* ============ 存档时光机 ============ */
  async function saveTimeMachine(s) {
    const st = S();
    const render = async (body) => {
      body.innerHTML = T("pg.L1343C202", null, '<div class="empty-tip">加载中…</div>');
      const [list, stat] = await Promise.all([window.api.saveTmList(s.dir), window.api.saveTmStats(s.dir)]);
      const parts = [];
      parts.push(T("pg.L1346C203", null, `<div class="tm-stat">共 ${list.length} 个快照 · 逻辑 ${fmtSize(stat.logical || 0)} · 实际占用 ${fmtSize(stat.physical || 0)} · 去重比 ${(stat.ratio || 1).toFixed(2)}x</div>`));
      parts.push(T("pg.L1347C204", null, '<div class="tm-tip">快照是块级去重的：没变过的数据不会重复占空间，所以每次启动前都会自动存一份。</div>'));

      parts.push(T("pg.L1349C205", null, '<div class="hl-sec">快照列表</div>'));
      if (!list.length) parts.push(T("pg.L1350C206", null, '<div class="empty-tip">还没有快照，点「立即快照」存一份当前状态。</div>'));
      for (const snap of list) {
        parts.push(T("pg.L1352C207", null, `<div class="tm-row" data-id="${esc(snap.id)}">
          <div class="tm-meta">
            <div class="tm-name">${esc(snap.label || snap.id)}${snap.auto ? ' · 自动' : ''}</div>
            <div class="tm-sub">${fmtTime(snap.time)} · ${snap.fileCount} 个文件 · ${fmtSize(snap.totalSize || 0)}</div>
          </div>
          <div class="tm-ops">
            <button class="ghost-btn" data-act="restore">回到这里</button>
            <button class="ghost-btn danger" data-act="del">删除</button>
          </div></div>`));
      }
      body.innerHTML = parts.join('');

      body.querySelectorAll('.tm-row').forEach((row) => {
        const id = row.dataset.id;
        row.querySelector('[data-act=restore]').onclick = async () => {
          if (!confirm(T("pg.L1367C208", null, '把存档「') + s.name + T("pg.L1367C209", null, '」回滚到这个快照？\n当前状态会先自动存一份，可以再退回来。'))) return;
          st.setStatus(T("pg.L1368C210", null, '正在回滚…'), 'run');
          const r = await window.api.saveTmRestore(s.dir, id);
          st.setStatus(r && r.ok ? T("pg.L1370C211", null, '已回滚') : T("pg.L1370C212", null, '回滚失败: ') + ((r && r.error) || ''), r && r.ok ? '' : 'err');
          closeModal(); refreshSaves();
        };
        row.querySelector('[data-act=del]').onclick = async () => {
          await window.api.saveTmDelete(id);
          render(body);
        };
      });
    };

    openModal(T("pg.L1380C213", null, '时光机 · ') + s.name, (body) => {
      const bar = document.createElement('div');
      bar.className = 'tm-ops';
      bar.style.marginBottom = '8px';
      bar.innerHTML = T("pg.L1384C214", null, '<button class="ghost-btn" data-act="now">立即快照</button><button class="ghost-btn" data-act="gc">清理无用块</button>');
      const content = document.createElement('div');
      content.style.flex = '1';
      content.style.minHeight = '0';
      body.appendChild(bar);
      body.appendChild(content);
      bar.querySelector('[data-act=now]').onclick = async () => {
        const label = prompt(T("pg.L1391C215", null, '给这个快照起个名字：'), T("pg.L1391C216", null, '手动快照'));
        st.setStatus(T("pg.L1392C217", null, '正在快照…'), 'run');
        const r = await window.api.saveTmCreate(s.dir, label || T("pg.L1393C218", null, '手动快照'));
        st.setStatus(r && r.ok ? T("pg.L1394C219", null, `已快照（新增 ${((r.snap.newBytes || 0) / 1048576).toFixed(1)} MB）`) : T("pg.L1394C220", null, '快照失败: ') + ((r && r.error) || ''),
          r && r.ok ? '' : 'err');
        render(content);
      };
      bar.querySelector('[data-act=gc]').onclick = async () => {
        const g = await window.api.saveTmGc();
        st.setStatus(T("pg.L1400C221", null, `已回收 ${g.removed} 个块，释放 ${fmtSize(g.freed || 0)}`), '');
        render(content);
      };
      render(content);
    });
  }

  /* ============ 截图 ============ */
  async function refreshShots() {
    const st = S();
    const box = $('shots-list');
    if (!box) return;
    // 走带分辨率/体积/时间的接口（老接口 listScreenshots 拿不到这些），取不到就退回老接口
    let list = [], stats = null;
    if (window.api.shotsMeta) {
      const r = await window.api.shotsMeta(st.gameDir());
      list = (r && r.items) || [];
      stats = (r && r.stats) || null;
    } else {
      list = await window.api.listScreenshots(st.gameDir());
    }
    const statsEl = $('shots-stats');
    if (statsEl) {
      statsEl.textContent = list.length
        ? T("pg.L1424C222", null, `共 ${list.length} 张 · 合计 ${fmtSize(stats ? stats.bytes : 0)}`) +
          (stats && stats.latest ? T("pg.L1425C223", null, ` · 最新 ${fmtTime(stats.latest)}`) : '')
        : '';
    }
    box.innerHTML = '';
    if (!list.length) { box.innerHTML = T("pg.L1429C224", null, '<div class="empty">没有截图<br /><small>游戏里按 F2 截图</small></div>'); return; }
    for (const s of list) {
      const d = document.createElement('div');
      d.className = 'shot';
      const dim = s.width && s.height ? `${s.width}×${s.height}` : '';
      const meta = [dim, fmtSize(s.size || 0), s.mtime ? fmtTime(s.mtime) : ''].filter(Boolean).join(' · ');
      d.innerHTML = T("pg.L1435C225", null, `<img src="file:///${s.path.replace(/\\/g, '/')}" loading="lazy" />
        <div class="sname"><b>${esc(s.name)}</b><span data-act="del">删除</span></div>
        <div class="smeta">${esc(meta)}</div>`);
      d.querySelector('img').onclick = () => window.api.openPath(s.path);
      d.querySelector('[data-act=del]').onclick = async () => { await window.api.deletePath(s.path); refreshShots(); };
      box.appendChild(d);
    }
  }

  /** 把截图按月份归档进子目录 */
  async function organizeShots(mode) {
    const st = S();
    try {
      const r = await window.api.shotsOrganize(st.gameDir(), mode || 'month');
      if (!r || !r.ok) { st.setStatus(T("pg.L1449C226", null, '整理失败: ') + ((r && r.error) || T("pg.L1449C227", null, '未知')), 'err'); return r; }
      st.setStatus(r.moved ? T("pg.L1450C228", null, `已把 ${r.moved} 张截图归入 ${(r.keys || []).join('、')}`) : T("pg.L1450C229", null, '截图已经是有序的'), '');
      await refreshShots();
      return r;
    } catch (e) { st.setStatus(T("pg.L1453C230", null, '整理失败: ') + e.message, 'err'); }
  }

  /* ============ 日志 ============ */
  async function refreshLogs() {
    const st = S();
    const box = $('crash-list');
    const list = await window.api.listCrashes(st.gameDir());
    box.innerHTML = '';
    if (!list.length) { box.innerHTML = T("pg.L1462C231", null, '<div class="empty">暂无日志与崩溃报告</div>'); return; }
    for (const c of list) {
      const d = document.createElement('div');
      d.className = 'item';
      d.innerHTML = `<div><div class="t">${esc(c.name)}</div><div class="s">${c.kind} · ${fmtTime(c.mtime)} · ${fmtSize(c.size)}</div></div>`;
      d.onclick = async () => { $('crash-view').textContent = await window.api.readLog(c.path, 30000); };
      box.appendChild(d);
    }
  }

  /* ============ 账户（多账户 + 并行多开） ============ */
  const ACC_TYPE = { offline: T("pg.L1473C232", null, '离线'), yggdrasil: T("pg.L1473C233", null, '外置'), microsoft: T("pg.L1473C234", null, '微软') };

  async function refreshAccounts() {
    const st = S();
    const box = $('acc-list');
    if (!box) return;
    const list = st.accounts || (st.account ? [st.account] : []);
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = T("pg.L1482C235", null, '<div class="empty">还没有账户<br /><small>在下方「登录 / 添加账户」里加一个</small></div>');
      return;
    }
    const activeId = st.account ? st.account.uuid : null;
    for (const a of list) {
      const card = document.createElement('div');
      card.className = 'acc-card' + (a.uuid === activeId ? ' active' : '');

      const face = document.createElement('div');
      face.className = 'acc-face';
      face.dataset.face = a.uuid;
      face.textContent = String(a.name || '?').trim().charAt(0).toUpperCase();

      const meta = document.createElement('div');
      meta.className = 'acc-meta';
      const nm = document.createElement('div');
      nm.className = 'acc-name-row';
      nm.textContent = a.name || T("pg.L1499C236", null, '未知');
      const sub = document.createElement('div');
      sub.className = 'acc-sub';
      sub.textContent = (ACC_TYPE[a.type] || a.type || T("pg.L1502C237", null, '未知')) + ' · ' + String(a.uuid || '').slice(0, 8);
      meta.appendChild(nm);
      meta.appendChild(sub);

      const ops = document.createElement('div');
      ops.className = 'acc-ops';
      if (a.uuid !== activeId) {
        const use = document.createElement('button');
        use.className = 'ghost-btn';
        use.textContent = T("pg.L1511C238", null, '切换');
        use.onclick = () => {
          if (st.switchAccount) st.switchAccount(a.uuid);
          if (st.updateAccountUI) st.updateAccountUI();
          st.setStatus(T("pg.L1515C239", null, '已切换到账户: ') + (a.name || a.uuid), '');
          refreshAccounts();
        };
        ops.appendChild(use);
      } else {
        const cur = document.createElement('span');
        cur.className = 'chip ok';
        cur.textContent = T("pg.L1522C240", null, '当前');
        ops.appendChild(cur);
      }
      const del = document.createElement('button');
      del.className = 'ghost-btn danger';
      del.textContent = T("pg.L1527C241", null, '删除');
      del.onclick = () => {
        if (!confirm(T("pg.L1529C242", null, '删除账户「') + (a.name || '') + T("pg.L1529C243", null, '」？登录状态会一并清除。'))) return;
        if (st.removeAccount) st.removeAccount(a.uuid);
        st.appendLog(T("pg.L1531C244", null, '[账户] 已删除 ') + (a.name || a.uuid));
        refreshAccounts();
        if (st.updateAccountUI) st.updateAccountUI();
      };
      ops.appendChild(del);

      card.appendChild(face);
      card.appendChild(meta);
      card.appendChild(ops);
      box.appendChild(card);
    }
    // 头像走主进程抓取（CSP 不允许渲染层直连外域），拿到后把首字母方块换成图
    try {
      const map = await window.api.avBatch(list, 48, 'head');
      for (const a of list) {
        const el = box.querySelector('[data-face="' + a.uuid + '"]');
        if (!el || !map[a.uuid]) continue;
        const img = document.createElement('img');
        img.className = 'acc-face-img';
        img.alt = '';
        img.src = map[a.uuid];
        el.textContent = '';
        el.appendChild(img);
      }
    } catch { /* 头像失败不影响使用 */ }
  }

  async function refreshMulti() {
    const box = $('ml-list');
    if (!box) return;
    let items = [];
    try { const r = await window.api.mlList(); items = (r && r.items) || []; } catch { items = []; }
    box.innerHTML = '';
    if (!items.length) {
      box.innerHTML = T("pg.L1565C245", null, '<div class="empty">没有正在运行的游戏<br /><small>回到启动页正常开游戏，或换实例 + 账户再开一个</small></div>');
      return;
    }
    for (const e of items) {
      const row = document.createElement('div');
      row.className = 'item ml-row';
      const t = document.createElement('div');
      t.className = 't';
      t.textContent = (e.accountName || T("pg.L1573C246", null, '未知账户')) + ' · ' + (e.version || T("pg.L1573C247", null, '未知版本'));
      const s = document.createElement('div');
      s.className = 's';
      s.textContent = [e.instanceName || T("pg.L1576C248", null, '当前目录'), 'PID ' + e.pid, T("pg.L1576C249", null, '运行 ') + (e.uptime || '')].join(' · ');
      const body = document.createElement('div');
      body.appendChild(t);
      body.appendChild(s);

      const kill = document.createElement('button');
      kill.className = 'ghost-btn danger';
      kill.textContent = T("pg.L1583C250", null, '结束');
      kill.onclick = async () => {
        const r = await window.api.mlStop(e.key);
        if (!r.ok) S().setStatus(T("pg.L1586C251", null, '结束失败: ') + r.error, 'err');
        else S().setStatus(T("pg.L1587C252", null, '已结束 ') + (e.accountName || '') + T("pg.L1587C253", null, ' 的游戏进程'), '');
        refreshMulti();
      };
      row.appendChild(body);
      row.appendChild(kill);
      box.appendChild(row);
    }
  }

  /* ============ JVM A/B 调优实验室 ============ */
  let LAB = { presets: [], busy: false, abort: false, timer: null };

  async function initLab() {
    if (!$('lab-a')) return;
    let java = S().javaInfo;
    if (!java) { try { java = await window.api.detectJava(S().cfg.mcDir, 0); } catch { java = null; } }
    const major = java && java.major ? java.major : 0;
    if (!$('lab-a').options.length) {
      const r = await window.api.labPresets(major);
      LAB.presets = (r && r.presets) || [];
      for (const sel of [$('lab-a'), $('lab-b')]) {
        sel.innerHTML = '';
        for (const p of LAB.presets) {
          const o = document.createElement('option');
          o.value = p.id;
          o.textContent = p.supported ? `${p.name}（${p.tag}）` : T("pg.L1612C254", null, `${p.name}（需 Java ${p.minJava}+）`);
          o.disabled = !p.supported;
          sel.appendChild(o);
        }
      }
      $('lab-a').value = 'default';
      $('lab-b').value = LAB.presets.some(p => p.id === 'g1-balanced' && p.supported) ? 'g1-balanced' : 'default';
      // 带上次的配置
      try {
        const last = JSON.parse(localStorage.getItem('pl-lab') || 'null');
        if (last) {
          if (last.a) $('lab-a').value = last.a;
          if (last.b) $('lab-b').value = last.b;
          if (last.memGB) $('lab-mem').value = last.memGB;
          if (last.rounds) $('lab-rounds').value = last.rounds;
          if (last.quietMs) $('lab-quiet').value = Math.round(last.quietMs / 1000);
          if (last.holdMs) $('lab-hold').value = Math.round(last.holdMs / 1000);
        }
      } catch { /* 配置坏了就用默认值 */ }
    }
    const adv = await window.api.labMemAdvice();
    if (adv && adv.ok) {
      $('lab-advice').innerHTML = '';
      const line = document.createElement('div');
      line.className = 'lab-line';
      line.textContent = T("pg.L1637C255", null, `本机物理内存 ${adv.totalGB} GB，建议 -Xmx ${adv.recommendGB} GB（${adv.note}）。`);
      const line2 = document.createElement('div');
      line2.className = 'lab-line dim';
      line2.textContent = java
        ? T("pg.L1641C256", null, `将使用 ${java.version}（${java.path}）`)
        : T("pg.L1642C257", null, '未检测到 Java，测试时会按版本自动挑选。');
      $('lab-advice').appendChild(line);
      $('lab-advice').appendChild(line2);
      if (!$('lab-mem').dataset.touched) $('lab-mem').value = adv.recommendGB;
      $('lab-mem-hint').textContent = T("pg.L1646C258", null, `上限建议 ${adv.saneMaxGB} GB（超过一半物理内存没有意义）`);
    }
    if (!$('btn-lab-run').dataset.bound) {
      $('btn-lab-run').dataset.bound = '1';
      $('btn-lab-run').onclick = runLab;
      $('btn-lab-abort').onclick = () => {
        LAB.abort = true;
        S().setStatus(T("pg.L1653C259", null, '正在中止…（当前这一轮跑完就停）'), 'warn');
      };
      $('lab-mem').oninput = () => { $('lab-mem').dataset.touched = '1'; };
      $('btn-lab-refresh').onclick = refreshLabHistory;
      $('btn-lab-clear').onclick = async () => {
        if (!confirm(T("pg.L1658C260", null, '清空全部调优历史？'))) return;
        await window.api.labClear();
        refreshLabHistory();
        $('lab-result').innerHTML = '';
      };
    }
    if (S().selectedVersion && !$('btn-lab-run').dataset.hint) {
      $('btn-lab-run').dataset.hint = '1';
    }
  }

  function setLabStatus(text, mode) {
    const el = $('lab-status');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'lab-status' + (mode ? ' ' + mode : '');
  }

  async function runLab() {
    const st = S();
    if (LAB.busy) return;
    const idA = $('lab-a').value;
    const idB = $('lab-b').value;
    if (!idA || !idB) { st.setStatus(T("pg.L1681C261", null, '请先选择 A / B 两组预设'), 'err'); return; }
    if (idA === idB) { st.setStatus(T("pg.L1682C262", null, 'A / B 不能是同一个预设'), 'err'); return; }
    if (!st.selectedVersion) { st.setStatus(T("pg.L1683C263", null, '请先选一个游戏版本'), 'err'); return; }
    let acc = st.account;
    if (!acc) {
      const name = (st.cfg.playerName || '').trim();
      if (!name) { st.setStatus(T("pg.L1687C264", null, '请先登录或填写玩家名'), 'err'); return; }
      acc = await window.api.accountOffline(name);
      if (st.upsertAccount) st.upsertAccount(acc);
    }

    const memGB = Math.max(2, Math.min(64, parseInt($('lab-mem').value, 10) || 4));
    const rounds = Math.max(1, Math.min(5, parseInt($('lab-rounds').value, 10) || 2));
    const quietMs = Math.max(3, Math.min(30, parseInt($('lab-quiet').value, 10) || 6)) * 1000;
    const holdMs = Math.max(0, Math.min(60, parseInt($('lab-hold').value, 10) || 8)) * 1000;

    LAB.busy = true; LAB.abort = false;
    $('btn-lab-run').disabled = true;
    try {
      const order = [];
      // 交替跑 ABAB 而不是 AAABBB：机器发热/后台抖动会随时间累积，交替可以摊平系统性偏差
      for (let i = 0; i < rounds; i++) { order.push(idA, idB); }
      localStorage.setItem('pl-lab', JSON.stringify({ a: idA, b: idB, memGB, rounds, quietMs, holdMs }));
      for (let i = 0; i < order.length; i++) {
        if (LAB.abort) break;
        const pidLabel = order[i] === idA ? 'A' : 'B';
        setLabStatus(T("pg.L1707C265", null, `第 ${Math.floor(i / 2) + 1}/${rounds} 轮 · ${pidLabel} 组启动中…`), 'run');
        st.setStatus(T("pg.L1708C266", null, `[实验室] ${pidLabel} 组启动中（第 ${Math.floor(i / 2) + 1}/${rounds} 轮）`), 'run');
        const r = await window.api.labRun({
          presetId: order[i], version: st.selectedVersion,
          mcDir: st.cfg.mcDir, gameDir: gameDir(), account: acc,
          memMB: memGB * 1024, javaPath: st.javaAuto ? '' : st.cfg.javaPath,
          quietMs, holdMs, authlibInjector: st.cfg.authlibJar,
          width: st.cfg.winW, height: st.cfg.winH
        });
        if (!r.ok) {
          setLabStatus(T("pg.L1717C267", null, '失败: ') + r.error, 'err');
          st.appendLog(T("pg.L1718C268", null, '[实验室] ') + r.error);
          break;
        }
        st.appendLog(T("pg.L1721C269", null, `[实验室] ${pidLabel} 组完成：就绪 ${r.run.readyMs == null ? '未判定' : r.run.readyMs + 'ms'}，`) +
          T("pg.L1722C270", null, `GC ${r.run.pauseCount} 次 / ${r.run.totalPauseMs}ms，峰值 ${r.run.peakMemMB}MB`));
        if (window.Pages.refreshMulti) refreshMulti();
      }
      await showLabResult(idA, idB);
      await refreshLabHistory();
      setLabStatus(LAB.abort ? T("pg.L1727C271", null, '已中止') : T("pg.L1727C272", null, '测试完成'), LAB.abort ? 'warn' : 'ok');
    } finally {
      LAB.busy = false;
      $('btn-lab-run').disabled = false;
    }
  }

  async function showLabResult(idA, idB) {
    const box = $('lab-result');
    if (!box) return;
    const r = await window.api.labCompare(idA, idB);
    if (!r || !r.ok) { box.innerHTML = T("pg.L1738C273", null, '<div class="empty">还没有可对比的数据</div>'); return; }
    box.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'lab-verdict';
    head.textContent = r.verdict;
    box.appendChild(head);

    const table = document.createElement('div');
    table.className = 'lab-table';
    const row0 = document.createElement('div');
    row0.className = 'lab-tr head';
    row0.innerHTML = T("pg.L1749C274", null, `<span>指标</span><span>${esc(r.nameA)}</span><span>${esc(r.nameB)}</span><span>结论</span>`);
    table.appendChild(row0);
    for (const m of r.rows) {
      const tr = document.createElement('div');
      tr.className = 'lab-tr';
      const fmt = (v) => v == null ? '—' : (v >= 1000 ? new Intl.NumberFormat().format(Math.round(v)) : v);
      let badge = T("pg.L1755C275", null, '数据不足');
      let cls = 'dim';
      if (m.winner !== 'na') {
        const betterName = m.winner === 'a' ? r.nameA : (m.winner === 'b' ? r.nameB : T("pg.L1758C276", null, '持平'));
        badge = m.winner === 'tie' ? T("pg.L1759C277", null, '持平') : T("pg.L1759C278", null, `${betterName} 优 ${Math.abs(m.deltaPct)}%`);
        cls = m.winner === 'tie' ? 'tie' : 'ok';
      }
      tr.innerHTML = `<span>${esc(m.metric)}<small>${m.unit ? ' · ' + esc(m.unit) : ''}</small></span>` +
        `<span>${esc(fmt(m.a))}</span><span>${esc(fmt(m.b))}</span>` +
        `<span class="${cls}">${esc(badge)}</span>`;
      table.appendChild(tr);
    }
    box.appendChild(table);
    const tip = document.createElement('p');
    tip.className = 'tip';
    tip.textContent = T("pg.L1770C279", null, '差异 3% 以内按噪声处理。想更准就把每组轮数加到 3 次以上。');
    box.appendChild(tip);
  }

  async function refreshLabHistory() {
    const box = $('lab-history');
    if (!box) return;
    const r = await window.api.labSummary();
    const rows = (r && r.rows) || [];
    box.innerHTML = '';
    if (!rows.length) { box.innerHTML = T("pg.L1780C280", null, '<div class="empty">还没有测试数据<br /><small>选好 A/B 预设点上面的按钮</small></div>'); return; }
    for (const row of rows) {
      const d = document.createElement('div');
      d.className = 'item';
      d.innerHTML = `<div><div class="t">${esc(row.presetName)}</div>` +
        T("pg.L1785C281", null, `<div class="s">${row.runs} 次 · 就绪 ${row.readyMs == null ? '未判定' : row.readyMs + 'ms'}`) +
        T("pg.L1786C282", null, ` · GC 共 ${row.totalPauseMs == null ? '—' : row.totalPauseMs + 'ms'}（${row.pauseCount == null ? '—' : row.pauseCount} 次）`) +
        T("pg.L1787C283", null, ` · 峰值 ${row.peakMemMB == null ? '—' : row.peakMemMB + 'MB'} · ${esc((row.mems || []).map(m => m / 1024 + 'G').join('/') || '内存未知')}</div></div>`);
      box.appendChild(d);
    }
  }

  /* ============ 世界页（V4 第一组 + 第二组） ============ */
  const wapi = window.api;
  const wd = { verDir: '', mapDir: '', mergeFrom: '', mergeTo: '', dbDir: '', selCommit: null };
  const num = (id) => { const v = parseFloat($(id) && $(id).value); return Number.isFinite(v) ? v : 0; };

  function wtabSwitch(name) {
    document.querySelectorAll('#world-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.wtab === name));
    document.querySelectorAll('#page-world .wtab').forEach((p) => p.classList.toggle('active', p.id === 'wtab-' + name));
  }

  /* ---- 版本控制 ---- */
  async function wvPick() { const dir = await wapi.pickDirectory(); if (!dir) return; $('wv-dir').value = dir; wd.verDir = dir; wvRefresh(); }
  async function wvRefresh() {
    const dir = $('wv-dir').value.trim();
    if (!dir) { $('wv-status').textContent = T('world.ver.needDir', null, '请先选择存档目录'); return; }
    wd.verDir = dir;
    const st = await wapi.worldVerStatus(dir);
    if (!st || st.error) { $('wv-status').textContent = T('world.err', null, '错误: ') + (st && st.error || ''); return; }
    renderVerStatus(st);
    const log = await wapi.worldVerLog(dir);
    renderVerLog(log);
    const br = await wapi.worldVerBranches(dir);
    renderVerBranches(br);
  }
  function renderVerStatus(st) {
    const el = $('wv-status');
    if (!st.tracked) { el.innerHTML = T('world.ver.untracked', null, '这个存档还没有纳入版本控制。点「纳入跟踪」开始记录版本历史。'); return; }
    el.innerHTML = T('world.ver.tracked', null, `分支 <b>${esc(st.branch)}</b> · HEAD <code>${esc(st.head || '')}</code><br>改动: +${st.changes.add} ~${st.changes.change} -${st.changes.del}（共 ${st.changes.total} 区块）<br>区块总数 ${st.chunks}`);
  }
  function renderVerLog(log) {
    const box = $('wv-log'); box.innerHTML = '';
    if (!log || !log.length) { box.innerHTML = T('world.ver.nohistory', null, '<div class="empty">还没有提交</div>'); return; }
    for (const c of log) {
      const d = document.createElement('div');
      d.className = 'item' + (c.isHead ? ' selected' : '');
      const autoTag = c.auto ? T('world.ver.auto', null, ' · 自动') : '';
      d.innerHTML = T('world.ver.logrow', null, `<div><div class="t">${esc(c.message || '')}</div><div class="s">${esc(c.id)} · ${fmtTime(c.time)} · ${c.changed.total} 区块变动${autoTag}</div></div>`);
      d.onclick = () => { wd.selCommit = c.id; [...box.children].forEach((x) => x.classList.remove('selected')); d.classList.add('selected'); };
      box.appendChild(d);
    }
  }
  function renderVerBranches(br) {
    const sel = $('wv-branch'); sel.innerHTML = '';
    for (const b of (br || [])) {
      const o = document.createElement('option');
      o.value = b.name; o.textContent = b.name + (b.current ? T('world.branch.current', null, '（当前）') : '');
      sel.appendChild(o);
    }
  }
  async function wvTrack() {
    const dir = $('wv-dir').value.trim(); if (!dir) { $('wv-status').textContent = T('world.ver.needDir', null, '请先选择存档目录'); return; }
    const r = await wapi.worldVerTrack(dir, T('world.ver.initmsg', null, '开始跟踪'));
    if (!r || r.error) { $('wv-status').textContent = T('world.err', null, '错误: ') + (r && r.error); return; }
    wvRefresh();
  }
  async function wvCommit() {
    const dir = $('wv-dir').value.trim(); if (!dir) return;
    const r = await wapi.worldVerCommit(dir, $('wv-msg').value.trim(), null);
    if (!r || r.error) { $('wv-status').textContent = T('world.err', null, '错误: ') + (r && r.error); return; }
    $('wv-status').textContent = r.unchanged ? T('world.ver.nothing', null, '没有变化，无需提交') : T('world.ver.committed', null, '已提交 ') + r.id;
    wvRefresh();
  }
  async function wvCheckout() {
    const dir = $('wv-dir').value.trim(); if (!dir) return;
    const id = wd.selCommit; if (!id) { $('wv-status').textContent = T('world.ver.selCommit', null, '先在历史里点选一个提交'); return; }
    if (!confirm(T('world.ver.confirmRollback', null, '回滚会改写存档目录（自动先打快照）。确定？'))) return;
    const r = await wapi.worldVerCheckout(dir, id, true);
    if (!r || r.error) { $('wv-status').textContent = T('world.err', null, '错误: ') + (r && r.error); return; }
    $('wv-status').textContent = T('world.ver.rolled', null, `已回滚到 ${id}，写入 ${r.written} 区块，删除 ${r.deleted} 区块`) + (r.safety ? T('world.ver.safety', null, '（已自动快照）') : '');
    wvRefresh();
  }
  async function wvBranchCreate() {
    const dir = $('wv-dir').value.trim(); if (!dir) return;
    const name = $('wv-newbranch').value.trim(); if (!name) return;
    const r = await wapi.worldVerBranchCreate(dir, name, $('wv-branch').value);
    if (!r || r.error) { $('wv-status').textContent = T('world.err', null, '错误: ') + (r && r.error); return; }
    $('wv-newbranch').value = ''; wvRefresh();
  }
  async function wvBranchSwitch() {
    const dir = $('wv-dir').value.trim(); if (!dir) return;
    const name = $('wv-branch').value; if (!name) return;
    const r = await wapi.worldVerBranchSwitch(dir, name);
    if (!r || r.error) { $('wv-status').textContent = T('world.err', null, '错误: ') + (r && r.error); return; }
    $('wv-status').textContent = T('world.ver.switched', null, '已切到分支 ') + name; wvRefresh();
  }
  async function wvGc() {
    const dir = $('wv-dir').value.trim(); if (!dir) return;
    const r = await wapi.worldVerGc(dir);
    if (!r || r.error) { $('wv-status').textContent = T('world.err', null, '错误: ') + (r && r.error); return; }
    $('wv-status').textContent = T('world.ver.gc', null, `清理 ${r.removed} 个孤儿对象，释放 ${fmtSize(r.freed)}`);
  }

  /* ---- 区域搬运 ---- */
  async function wmPick(which) {
    const dir = await wapi.pickDirectory(); if (!dir) return;
    if (which === 'from') { $('wm-from').value = dir; wd.mergeFrom = dir; }
    else { $('wm-to').value = dir; wd.mergeTo = dir; }
  }
  function wmPlanObj() {
    return {
      from: $('wm-from').value.trim(), to: $('wm-to').value.trim(), dim: 'overworld',
      x1: num('wm-x1'), z1: num('wm-z1'), x2: num('wm-x2'), z2: num('wm-z2'),
      mode: $('wm-mode').value, syncEntities: $('wm-ent').checked
    };
  }
  async function wmPlan() { const r = await wapi.worldMergePlan(wmPlanObj()); renderMerge(r, false); }
  async function wmApply() {
    if (!confirm(T('world.merge.confirm', null, '执行搬运前会自动给目标存档打快照。确定执行？'))) return;
    const r = await wapi.worldMergeApply(wmPlanObj()); renderMerge(r, true);
  }
  function renderMerge(r, applied) {
    const box = $('wm-result');
    if (!r || r.error) { box.innerHTML = T('world.err', null, '错误: ') + (r && r.error || ''); return; }
    if (applied) {
      box.innerHTML = T('world.merge.done', null, `执行完成：写入 ${r.written} 区块，删除 ${r.deleted} 区块，涉及 ${r.files} 个文件`)
        + (r.safety ? T('world.merge.safety', null, `<br>已自动打快照 ${r.safety}`) : '')
        + (r.verification && !r.verification.ok ? T('world.merge.verfail', null, '<br>⚠ 复验有不一致，请检查') : T('world.merge.verok', null, '<br>复验通过'));
      return;
    }
    const L = [];
    L.push(T('world.merge.box', null, `区域：${r.box.block.x1},${r.box.block.z1} ~ ${r.box.block.x2},${r.box.block.z2}（${r.box.chunks} 区块）`));
    L.push(T('world.merge.source', null, `源：命中 ${r.source.present} / 缺失 ${r.source.missing} 区块，${fmtSize(r.source.bytes)}，实体 ${r.source.entities}`));
    L.push(T('world.merge.target', null, `目标：新建 ${r.target.create} / 相同 ${r.target.same} / 冲突 ${r.target.conflict}`));
    L.push(T('world.merge.plan', null, `待写入 ${r.write.chunks} 区块（相同 ${r.write.same}，跳过 ${r.write.skipped}）`));
    for (const w of (r.warnings || [])) L.push(T('world.merge.warn', null, '⚠ ') + esc(w));
    if (r.hotspots && r.hotspots.length) L.push(T('world.merge.hotspots', null, `实体热点 ${r.hotspots.length} 个，最多 ${r.hotspots[0].entities} 个/区块`));
    box.innerHTML = L.join('<br>');
  }

  /* ---- 地图预览 ---- */
  let wmpCells = null, wmpBounds = null, wmpHot = null, wmpZoom = 1, wmpOffX = 0, wmpOffY = 0, wmpDrag = null;
  async function wmpPick() { const dir = await wapi.pickDirectory(); if (!dir) return; $('wmp-dir').value = dir; wd.mapDir = dir; }
  async function wmpScan() {
    const dir = $('wmp-dir').value.trim();
    if (!dir) { $('wmp-info').textContent = T('world.map.needDir', null, '请先选择存档目录'); return; }
    const r = await wapi.worldMapScan(dir, 'overworld', $('wmp-layer').value);
    if (!r || r.error) { $('wmp-info').textContent = T('world.err', null, '错误: ') + (r && r.error); return; }
    if (!r.cells || !r.cells.length) { $('wmp-info').textContent = T('world.map.empty', null, '没有扫描到区块'); wmpCells = null; return; }
    wmpCells = r.cells; wmpBounds = r.bounds; wmpHot = new Map();
    for (const h of (r.entityHotspots || [])) wmpHot.set(h.cx + ',' + h.cz, h.count);
    wmpZoom = 1; wmpOffX = 0; wmpOffY = 0;
    $('wmp-info').textContent = T('world.map.scanned', null, `扫描到 ${r.cells.length} 区块`) + (r.entityMax ? T('world.map.entmax', null, `，单区块最多 ${r.entityMax} 实体`) : '');
    wmpDraw();
  }
  function wmpDraw() {
    const cv = $('wmp-canvas'); if (!cv || !wmpCells || !wmpBounds) return;
    const ctx = cv.getContext('2d');
    const W = cv.clientWidth || 600, H = cv.clientHeight || 360;
    if (cv.width !== W) cv.width = W; if (cv.height !== H) cv.height = H;
    ctx.fillStyle = '#0e1014'; ctx.fillRect(0, 0, W, H);
    const b = wmpBounds;
    const cols = (b.maxCx - b.minCx + 1), rows = (b.maxCz - b.minCz + 1);
    const base = Math.max(1, Math.floor(Math.min(W / cols, H / rows)));
    const cs = Math.max(1, Math.floor(base * wmpZoom));
    const layer = $('wmp-layer').value, showHot = $('wmp-hot').checked;
    for (const c of wmpCells) {
      const x = (c.cx - b.minCx) * cs + wmpOffX, y = (c.cz - b.minCz) * cs + wmpOffY;
      const col = layer === 'height' ? c.cHeight : layer === 'biome' ? c.cBiome : c.cBlocks;
      ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
      ctx.fillRect(x, y, cs, cs);
      if (showHot && wmpHot.has(c.cx + ',' + c.cz)) { ctx.strokeStyle = '#ff4d4d'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, cs - 1), Math.max(1, cs - 1)); }
    }
  }
  function wmpHover(e) {
    const cv = $('wmp-canvas'); if (!cv || !wmpCells || !wmpBounds) { $('wmp-tip').textContent = ''; return; }
    const rect = cv.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const b = wmpBounds;
    const cols = (b.maxCx - b.minCx + 1), rows = (b.maxCz - b.minCz + 1);
    const base = Math.max(1, Math.floor(Math.min(cv.width / cols, cv.height / rows)));
    const cs = Math.max(1, Math.floor(base * wmpZoom));
    const cx = b.minCx + Math.floor((mx - wmpOffX) / cs), cz = b.minCz + Math.floor((my - wmpOffY) / cs);
    const cell = wmpCells.find((c) => c.cx === cx && c.cz === cz);
    if (!cell) { $('wmp-tip').textContent = ''; return; }
    const hot = wmpHot.get(cx + ',' + cz);
    $('wmp-tip').textContent = T('world.map.tip', null, `区块 (${cx}, ${cz})`) + (cell.topName ? ' · ' + cell.topName : '') + (cell.topY != null ? ' · y=' + cell.topY : '') + (hot ? T('world.map.ent', null, ' · 实体 ') + hot : '');
  }
  function wmpZoomEv(e) { e.preventDefault(); wmpZoom *= e.deltaY < 0 ? 1.2 : 0.8; wmpZoom = Math.max(0.2, Math.min(20, wmpZoom)); wmpDraw(); }

  /* ---- 全局检索 ---- */
  /** @type {any} */
  let wdbTimer = 0;
  async function wdbPick() { const dir = await wapi.pickDirectory(); if (!dir) return; $('wdb-dir').value = dir; wd.dbDir = dir; }
  async function wdbIndex() {
    const dir = $('wdb-dir').value.trim(); if (!dir) { $('wdb-info').textContent = T('world.db.needDir', null, '请先选择 .minecraft 目录'); return; }
    const r = await wapi.worldDbIndex(dir);
    if (!r || r.error) { $('wdb-info').textContent = T('world.err', null, '错误: ') + (r && r.error); return; }
    renderDbStats(r.stats); $('wdb-info').textContent = T('world.db.indexed', null, `已索引 ${r.count} 个存档`);
  }
  async function wdbDoSearch() {
    const dir = $('wdb-dir').value.trim(); if (!dir) { $('wdb-info').textContent = T('world.db.needDir', null, '请先选择 .minecraft 目录'); return; }
    const r = await wapi.worldDbSearch(dir, $('wdb-q').value.trim());
    if (!r || r.error) { $('wdb-info').textContent = T('world.err', null, '错误: ') + (r && r.error); return; }
    renderDbStats(r.stats); renderDbResults(r.results);
    $('wdb-info').textContent = T('world.db.found', null, `命中 ${r.results.length} 条`);
  }
  function renderDbStats(s) {
    if (!s) { $('wdb-stats').textContent = ''; return; }
    $('wdb-stats').innerHTML = T('world.db.stats', null, `存档 ${s.saves} 个 · 容器 ${s.totalContainers} 个 · 命名实体 ${s.totalNamedEntities} 个 · 总游戏时长 ${s.playHours} 小时`);
  }
  function renderDbResults(res) {
    const box = $('wdb-results'); box.innerHTML = '';
    if (!res || !res.length) { box.innerHTML = T('world.db.noresult', null, '<div class="empty">没有匹配</div>'); return; }
    for (const r of res) {
      const d = document.createElement('div'); d.className = 'item';
      if (r.kind === 'container') {
        const items = (r.items || []).map((it) => esc(it.zh) + (it.enchanted ? '✨' : '') + '×' + it.count).join('、');
        d.innerHTML = `<div><div class="t">${esc(r.save)} · ${esc(r.type)} <small>(${r.x},${r.y},${r.z})</small></div><div class="s">${items}</div></div>`;
      } else {
        d.innerHTML = T('world.db.entrow', null, `<div><div class="t">${esc(r.save)} · 实体 ${esc(r.type)} <small>(${r.x},${r.y},${r.z})</small></div><div class="s">${esc(r.name || '')}</div></div>`);
      }
      box.appendChild(d);
    }
  }

  async function initWorld() {
    document.querySelectorAll('#world-tabs .tab').forEach((t) => { t.onclick = () => wtabSwitch(t.dataset.wtab); });
    $('wv-browse').onclick = wvPick; $('wv-refresh').onclick = wvRefresh;
    $('wv-track').onclick = wvTrack; $('wv-commit').onclick = wvCommit;
    $('wv-checkout').onclick = wvCheckout; $('wv-gc').onclick = wvGc;
    $('wv-branch-create').onclick = wvBranchCreate; $('wv-branch-switch').onclick = wvBranchSwitch;
    $('wm-from-browse').onclick = () => wmPick('from'); $('wm-to-browse').onclick = () => wmPick('to');
    $('wm-plan').onclick = wmPlan; $('wm-apply').onclick = wmApply;
    $('wmp-browse').onclick = wmpPick; $('wmp-scan').onclick = wmpScan;
    const cv = $('wmp-canvas');
    cv.onmousemove = wmpHover; cv.onwheel = wmpZoomEv;
    cv.onmousedown = (e) => { wmpDrag = { x: e.clientX, y: e.clientY, ox: wmpOffX, oy: wmpOffY }; };
    window.addEventListener('mouseup', () => { wmpDrag = null; });
    window.addEventListener('mousemove', (e) => { if (!wmpDrag) return; wmpOffX = wmpDrag.ox + (e.clientX - wmpDrag.x); wmpOffY = wmpDrag.oy + (e.clientY - wmpDrag.y); wmpDraw(); });
    $('wmp-layer').onchange = () => { if (wmpCells) wmpDraw(); };
    $('wmp-hot').onchange = () => { if (wmpCells) wmpDraw(); };
    $('wdb-browse').onclick = wdbPick; $('wdb-index').onclick = wdbIndex;
    $('wdb-search').onclick = wdbDoSearch;
    $('wdb-q').oninput = () => { clearTimeout(wdbTimer); wdbTimer = setTimeout(wdbDoSearch, 300); };
    if (wmpCells) setTimeout(wmpDraw, 50);
  }

  /* ============ 性能页（V4 第三组） ============ */
  const pd = { gameDir: '', saveDir: '', lastTune: null };

  function ptabSwitch(name) {
    document.querySelectorAll('#perf-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.ptab === name));
    document.querySelectorAll('#page-perf .wtab').forEach((p) => p.classList.toggle('active', p.id === 'ptab-' + name));
  }

  /** 严重度 → 徽标文案与颜色类 */
  function sevLabel(sev) {
    return {
      fatal: T('perf.sev.fatal', null, '致命'),
      error: T('perf.sev.error', null, '错误'),
      warn: T('perf.sev.warn', null, '警告'),
      info: T('perf.sev.info', null, '提示')
    }[sev] || sev;
  }
  function gradeLabel(g) {
    return {
      good: T('perf.grade.good', null, '良好'),
      fair: T('perf.grade.fair', null, '一般'),
      poor: T('perf.grade.poor', null, '较差'),
      bad: T('perf.grade.bad', null, '很差')
    }[g] || g;
  }

  async function pdRun() {
    const box = $('pd-findings');
    $('pd-summary').textContent = T('perf.diag.running', null, '正在读取日志与存档…');
    box.innerHTML = '';
    const res = await wapi.perfDiagnose({
      gameDir: $('pd-gamedir').value.trim(),
      saveDir: $('pd-savedir').value.trim(),
      javaMajor: num('pd-java') || 0,
      xmxMB: num('pd-xmx') || 0
    });
    if (!res || res.error) { $('pd-summary').textContent = T('world.err', null, '错误: ') + (res && res.error || ''); return; }
    renderPerfProfile(res.sources && res.sources.profile, res.sources);
    renderPerfFindings(res);
  }

  function renderPerfProfile(prof, sources) {
    const el = $('pd-profile');
    if (!prof) { el.textContent = T('perf.diag.noprofile', null, '未读取到配置信息。'); return; }
    const src = sources || {};
    const logInfo = src.logPath
      ? T('perf.diag.logfrom', { n: Math.round((src.logBytes || 0) / 1024) }, `日志：${esc(src.logPath)}（读取 ${Math.round((src.logBytes || 0) / 1024)} KB）`)
      : T('perf.diag.nolog', null, '未找到 latest.log（可手动在下方提示中指定游戏目录）');
    const jvm = src.jvm || {};
    const jvmInfo = jvm.xmxMB
      ? T('perf.diag.jvmnow', { m: jvm.xmxMB, gc: jvm.gc || T('perf.diag.gcunknown', null, '未识别') }, `当前参数：-Xmx${jvm.xmxMB}MB · GC ${jvm.gc || '未识别'}`)
      : T('perf.diag.jvmnone', null, '当前参数：未从日志识别到');
    const size = src.size || {};
    el.innerHTML = T('perf.diag.profile', null,
      `物理内存 ${prof.totalGB}G（空闲 ${prof.freeGB}G） · ${prof.cpuCores} 核心<br>${esc(prof.cpuModel)}<br>${logInfo}<br>${jvmInfo}<br>存档规模：${size.saveChunks || 0} 区块 · 实体峰值 ${size.entityMax || 0} · 容器 ${size.containerCount || 0}`);
  }

  function renderPerfFindings(res) {
    const box = $('pd-findings');
    box.innerHTML = '';
    $('pd-summary').textContent = res.summary || '';
    $('pd-score').innerHTML = T('perf.diag.score', { s: res.score, g: gradeLabel(res.grade) }, `评分 <b>${res.score}</b>/100 · ${gradeLabel(res.grade)}`);
    const list = res.findings || [];
    if (!list.length) {
      box.innerHTML = T('perf.diag.clean', null, '<div class="empty">没发现明显的性能问题，配置看起来是合理的。</div>');
      return;
    }
    for (const f of list) {
      const d = document.createElement('div');
      d.className = 'item sev-' + f.severity;
      const advice = (f.advice || []).map((a) => `<li>${esc(a)}</li>`).join('');
      d.innerHTML = T('perf.diag.row', null,
        `<div><div class="t">[${sevLabel(f.severity)}] ${esc(f.name)}</div>` +
        `<div class="s">${esc(f.evidence || '')}</div>` +
        (advice ? `<ul class="advice">${advice}</ul>` : '') + `</div>`);
      box.appendChild(d);
    }
  }

  async function ptRun() {
    $('pt-args').textContent = T('perf.tune.running', null, '正在生成建议…');
    const res = await wapi.perfAutotune({
      saveDir: $('pt-savedir').value.trim(),
      javaMajor: num('pt-java') || 0
    });
    if (!res || res.error) { $('pt-args').textContent = T('world.err', null, '错误: ') + (res && res.error || ''); return; }
    renderTune(res.tune, res.size);
  }

  function renderTune(t, size) {
    pd.lastTune = t;
    const info = size
      ? T('perf.tune.size', { c: size.saveChunks || 0, e: size.entityMax || 0 }, `按存档规模：${size.saveChunks || 0} 区块 · 实体峰值 ${size.entityMax || 0}`)
      : T('perf.tune.nosize', null, '未提供存档目录，按通用配置建议');
    $('pt-args').textContent = `${t.args}\n\n${t.tier ? t.tier.label : ''} · ${t.gc}\n${info}`;
    $('pt-reasons').innerHTML = T('perf.tune.reasons', null, `<b>依据：</b><br>` + (t.reasons || []).map((r) => '· ' + esc(r)).join('<br>'));
    $('pt-warnings').innerHTML = (t.warnings && t.warnings.length)
      ? T('perf.tune.warn', null, `<b>注意：</b><br>` + t.warnings.map((w) => '· ' + esc(w)).join('<br>'))
      : '';
  }

  async function ptCopy() {
    if (!pd.lastTune) return;
    await wapi.copyText(pd.lastTune.args);
    $('pt-args').textContent = pd.lastTune.args + '\n\n' + T('perf.tune.copied', null, '（已复制到剪贴板）');
  }

  async function prLoad() {
    const box = $('pr-list');
    const rules = await wapi.perfRules();
    box.innerHTML = '';
    if (!rules || !rules.length) { box.innerHTML = T('perf.rules.empty', null, '<div class="empty">规则库为空</div>'); return; }
    for (const r of rules) {
      const d = document.createElement('div');
      d.className = 'item';
      d.innerHTML = T('perf.rules.row', null, `<div><div class="t">[${sevLabel(r.severity)}] ${esc(r.name)}</div><div class="s">${esc(r.id)} · ${esc(r.category)}</div></div>`);
      box.appendChild(d);
    }
  }

  async function initPerf() {
    document.querySelectorAll('#perf-tabs .tab').forEach((t) => { t.onclick = () => ptabSwitch(t.dataset.ptab); });
    $('pd-run').onclick = pdRun;
    $('pd-gamedir-browse').onclick = async () => { const d = await wapi.pickDirectory(); if (d) { $('pd-gamedir').value = d; } };
    $('pd-savedir-browse').onclick = async () => { const d = await wapi.pickDirectory(); if (d) { $('pd-savedir').value = d; } };
    $('pt-run').onclick = ptRun;
    $('pt-savedir-browse').onclick = async () => { const d = await wapi.pickDirectory(); if (d) { $('pt-savedir').value = d; } };
    $('pt-copy').onclick = ptCopy;
    $('pr-load').onclick = prLoad;
  }

  /* ============ Mod 工具页（V4 第四组） ============ */

  const mkState = {
    update: null,       // 更新评估结果
    l10n: null,         // 汉化扫描结果
    packCand: null,     // 整合包候选清单
    packCheck: null,    // 整合包检查结果
    picked: new Set()   // 勾选的 mod（用文件名，避免同名不同版本混淆）
  };

  function mkTabSwitch(name) {
    document.querySelectorAll('#mk-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.mktab === name));
    document.querySelectorAll('#page-modkit .wtab').forEach((p) => p.classList.toggle('active', p.id === 'mktab-' + name));
  }

  /** 风险等级 → 文案与颜色类（与 perf 的 sev-* 复用同一套 CSS） */
  function riskLabel(score) {
    if (score >= 90) return { key: 'safe', text: T('mk.risk.safe', null, '安全'), cls: 'sev-info' };
    if (score >= 70) return { key: 'caution', text: T('mk.risk.caution', null, '谨慎'), cls: 'sev-warn' };
    if (score >= 40) return { key: 'risky', text: T('mk.risk.risky', null, '有风险'), cls: 'sev-error' };
    return { key: 'danger', text: T('mk.risk.danger', null, '危险'), cls: 'sev-fatal' };
  }

  /* ---------- ① 更新风险评估 ---------- */

  function hasPicked() { return mkState.picked.size > 0; }

  async function mkUpdateRun() {
    const box = $('mu-list');
    const modsDir = $('mu-modsdir').value.trim();
    const incomingDir = $('mu-incdir').value.trim();
    if (!modsDir || !incomingDir) {
      $('mu-summary').textContent = T('mk.update.needdir', null, '请先指定两个目录。');
      return;
    }
    $('mu-summary').textContent = T('mk.update.running', null, '正在对比…');
    box.innerHTML = '';
    const res = await wapi.modkitUpdateAssess({ modsDir, incomingDir });
    mkRenderUpdate(res);
  }

  async function mkUpdateCompare() {
    const oldPath = $('mu-old').value.trim();
    const newPath = $('mu-new').value.trim();
    if (!oldPath || !newPath) {
      $('mu-summary').textContent = T('mk.update.needjar', null, '请指定新旧两个 jar。');
      return;
    }
    $('mu-summary').textContent = T('mk.update.running', null, '正在对比…');
    $('mu-list').innerHTML = '';
    const res = await wapi.modkitUpdateCompare({ oldPath, newPath });
    mkRenderUpdate(res, true);
  }

  function mkRenderUpdate(res, single) {
    const box = $('mu-list');
    box.innerHTML = '';
    if (!res || res.error) {
      $('mu-summary').textContent = T('world.err', null, '错误: ') + ((res && res.error) || '');
      return;
    }

    if (single) {
      const r = riskLabel(res.score);
      $('mu-summary').textContent = T('mk.update.single', { s: res.score, lv: r.text }, `风险分 ${res.score}/100 · ${r.text}`);
      const d = document.createElement('div');
      d.className = 'item ' + r.cls;
      d.innerHTML = mkUpdateBody(res);
      box.appendChild(d);
      return;
    }

    const upd = res.updates || [];
    $('mu-summary').textContent = T('mk.update.summary', {
      n: res.count || 0, f: res.freshCount || 0, r: res.risky || 0
    }, `${res.count || 0} 个更新 · ${res.freshCount || 0} 个新装 · ${res.risky || 0} 个有风险`);

    if (!upd.length) {
      box.innerHTML = T('mk.update.none', null, '<div class="empty">没有可更新的 mod（新目录里的都是没装过的）。</div>');
    }
    for (const u of upd) {
      const r = riskLabel(u.score);
      const d = document.createElement('div');
      d.className = 'item ' + r.cls;
      d.innerHTML = mkUpdateBody(u);
      box.appendChild(d);
    }
  }

  /** 一个更新项的正文（单 jar 与列表项共用） */
  function mkUpdateBody(u) {
    const r = riskLabel(u.score);
    const head = T('mk.update.itemhead', {
      name: esc(u.name || u.id || u.file || ''),
      from: esc(u.oldVersion || '?'), to: esc(u.newVersion || '?'), lv: r.text
    }, `<b>${esc(u.name || u.id || u.file || '')}</b> ${esc(u.oldVersion || '?')} → ${esc(u.newVersion || '?')}
        <span class="badge ${r.cls}">${r.text} ${u.score}</span>`);

    const finds = (u.findings || []).map((f) => {
      const lv = { error: T('mk.sev.error', null, '严重'), warn: T('mk.sev.warn', null, '注意'), info: T('mk.sev.info', null, '提示') }[f.severity] || f.severity;
      return T('mk.update.finding', { lv, sev: f.severity, t: esc(f.title), d: esc(f.detail || '') },
        `<div class="s"><span class="badge sev-${f.severity}">${lv}</span> ${esc(f.title)}<br><span class="dim">${esc(f.detail || '')}</span></div>`);
    }).join('');
    return T('mk.update.body', { head, finds },
      `<div><div class="t">${head}</div>${finds || `<div class="s dim">${T('mk.update.nofind', null, '未发现明显风险。')}</div>`}</div>`);
  }

  /* ---------- ② 汉化补全 ---------- */

  async function mkL10nScan() {
    const modsDir = $('ml-modsdir').value.trim();
    if (!modsDir) { $('ml-summary').textContent = T('mk.l10n.needdir', null, '请先指定 mods 目录。'); return; }
    const box = $('ml-list');
    $('ml-summary').textContent = T('mk.l10n.scanning', null, '正在扫描…');
    box.innerHTML = '';
    const res = await wapi.modkitL10nAnalyzeDir({
      modsDir, useDict: $('ml-dict').checked, target: 'zh_cn'
    });
    mkState.l10n = res;
    mkRenderL10n(res);
  }

  function mkRenderL10n(res) {
    const box = $('ml-list');
    box.innerHTML = '';
    if (!res || res.error) {
      $('ml-summary').textContent = T('world.err', null, '错误: ') + ((res && res.error) || '');
      return;
    }
    const a = res.agg || {};
    $('ml-summary').textContent = T('mk.l10n.summary', {
      n: res.count || 0, c: a.coverage || 0, m: a.stillMissing || 0
    }, `${res.count || 0} 个 mod · 覆盖率 ${a.coverage || 0}% · 仍缺 ${a.stillMissing || 0} 条`);

    if (!res.count) {
      box.innerHTML = T('mk.l10n.none', null, '<div class="empty">这些 mod 里没有可补全的语言条目。</div>');
      return;
    }
    for (const j of res.jars) {
      const s = j.stats || {};
      const d = document.createElement('div');
      d.className = 'item' + (s.stillMissing > 0 ? ' sev-warn' : ' sev-info');
      d.innerHTML = T('mk.l10n.row', {
        file: esc(j.file), ns: esc(j.ns || ''), total: s.total || 0,
        auto: s.autoFilled || 0, miss: s.stillMissing || 0
      }, `<div><div class="t">${esc(j.file)}</div>
        <div class="s">命名空间 ${esc(j.ns || '—')} · 共 ${s.total || 0} 条 · 词典补 ${s.autoFilled || 0} 条 · 仍缺 ${s.stillMissing || 0} 条</div></div>`);
      box.appendChild(d);
    }
  }

  async function mkL10nExport() {
    const modsDir = $('ml-modsdir').value.trim();
    if (!modsDir) { $('ml-summary').textContent = T('mk.l10n.needdir', null, '请先指定 mods 目录。'); return; }
    let out = $('ml-out').value.trim();
    if (!out) {
      out = await wapi.saveFile('pebble-l10n-pack.zip', [{ name: T('mk.l10n.zipname', null, '资源包'), extensions: ['zip'] }]);
      if (!out) return;
      $('ml-out').value = out;
    }
    $('ml-summary').textContent = T('mk.l10n.building', null, '正在生成资源包…');
    const res = await wapi.modkitL10nBuildPack({
      modsDir, outZip: out, includeTranslated: $('ml-all').checked, useDict: $('ml-dict').checked
    });
    if (!res || res.error) $('ml-summary').textContent = T('world.err', null, '错误: ') + ((res && res.error) || '');
    else $('ml-summary').textContent = T('mk.l10n.built', { n: res.jars, f: res.files, s: fmtSize(res.size) },
      `已生成：${res.jars} 个 mod · ${res.files} 个语言文件 · ${fmtSize(res.size)} → ${out}`);
  }

  async function mkL10nTranslate() {
    const input = $('ml-tr-in').value;
    if (!input.trim()) return;
    const res = await wapi.modkitL10nTranslate(input);
    const methodText = {
      phrase: T('mk.tr.phrase', null, '整句命中'),
      words: T('mk.tr.words', null, '逐词替换'),
      partial: T('mk.tr.partial', null, '部分命中'),
      miss: T('mk.tr.miss', null, '未命中')
    }[res.method] || res.method;
    $('ml-tr-out').innerHTML = res.method === 'miss'
      ? T('mk.tr.nomatch', { m: methodText }, `<b>${esc(methodText)}</b> —— 词典里没有，会进待翻译清单。`)
      : T('mk.tr.hit', { t: esc(res.text), m: methodText }, `→ <b>${esc(res.text)}</b>（${methodText}）`);
  }

  /* ---------- ③ 资源包与光影预览 ---------- */

  async function mkPackScan() {
    const gameDir = $('mp-gamedir').value.trim();
    if (!gameDir) { $('mp-rp-count').textContent = T('mk.preview.needdir', null, '请先指定游戏目录。'); return; }
    $('mp-rp-count').textContent = T('mk.preview.scanning', null, '扫描中…');
    $('mp-sh-count').textContent = '';
    const res = await wapi.modkitPackScan(gameDir);
    if (!res || res.error) { $('mp-rp-count').textContent = T('world.err', null, '错误: ') + ((res && res.error) || ''); return; }
    mkRenderPacks('rp', res.resourcepacks);
    mkRenderPacks('sh', res.shaderpacks);
  }

  function mkRenderPacks(prefix, items) {
    const box = $(prefix === 'rp' ? 'mp-rp-list' : 'mp-sh-list');
    const cnt = $(prefix === 'rp' ? 'mp-rp-count' : 'mp-sh-count');
    box.innerHTML = '';
    cnt.textContent = T('mk.preview.count', { n: (items || []).length }, `${(items || []).length} 个`);
    if (!items || !items.length) {
      box.innerHTML = T('mk.preview.empty', null, '<div class="empty">这个目录下没有找到包。</div>');
      return;
    }
    for (const it of items) {
      box.appendChild(mkPackCard(it));
    }
  }

  /** 一张包卡片：图标 + 名称 + 描述 + 版本区间 */
  function mkPackCard(it) {
    const d = document.createElement('div');
    d.className = 'mk-card';
    if (!it.ok) d.classList.add('bad');

    const icon = it.icon
      ? `<img class="mk-icon" src="${it.icon}" alt="" />`
      : `<div class="mk-icon mk-noicon">${it.isDir ? '📁' : '📦'}</div>`;

    const mc = it.mc ? T('mk.preview.mc', { v: esc(String(it.mc)) }, `支持 ${esc(String(it.mc))}`) : '';
    const fmt = it.format !== null && it.format !== undefined
      ? T('mk.preview.fmt', { n: it.format }, `格式 ${it.format}`) : '';
    const meta = [mc, fmt].filter(Boolean).join(' · ');
    const desc = it.desc ? esc(it.desc) : (it.note ? esc(it.note) : '');
    const sh = it.shaderFiles !== null && it.shaderFiles !== undefined
      ? T('mk.preview.shaders', { n: it.shaderFiles }, `${it.shaderFiles} 个着色器文件`) : '';

    d.innerHTML = T('mk.preview.card', null,
      `${icon}<div class="mk-card-body"><div class="mk-card-name" title="${esc(it.name || '')}">${esc(it.name || '')}</div>` +
      (meta ? `<div class="mk-card-meta">${meta}</div>` : '') +
      (desc ? `<div class="mk-card-desc">${desc}</div>` : '') +
      (sh ? `<div class="mk-card-meta">${sh}</div>` : '') +
      `</div>`);
    d.onclick = () => mkPackDetail(it.path, it.kind);
    return d;
  }

  async function mkPackDetail(p, kind) {
    const res = await wapi.modkitPackDetail({ path: p, kind: kind || 'rps' });
    if (!res || res.error) { S().setStatus(T('world.err', null, '错误: ') + ((res && res.error) || ''), 'bad'); return; }
    openModal(res.name || T('mk.preview.detail', null, '包详情'), (body) => {
      body.innerHTML = T('mk.preview.detailbody', null,
        (res.icon ? `<div class="mk-detail-icon"><img src="${res.icon}" alt="" /></div>` : '') +
        `<div class="kv"><span>${T('mk.preview.path', null, '路径')}</span><code>${esc(res.path)}</code></div>` +
        `<div class="kv"><span>${T('mk.preview.format', null, '数据包格式')}</span>${res.format === null || res.format === undefined ? '—' : res.format}</div>` +
        `<div class="kv"><span>${T('mk.preview.mcver', null, '支持版本')}</span>${esc(res.mc ? String(res.mc) : '—')}</div>` +
        `<div class="kv"><span>${T('mk.preview.isdir', null, '形态')}</span>${res.isDir ? T('mk.preview.dir', null, '文件夹') : T('mk.preview.zip', null, 'zip 压缩包')}</div>` +
        (res.desc ? `<div class="mk-detail-desc">${esc(res.desc)}</div>` : '') +
        (res.note ? `<div class="tip">${esc(res.note)}</div>` : ''));
    });
  }

  /* ---------- ④ 整合包创建向导 ---------- */

  async function mkPackScanCands() {
    const modsDir = $('mk-modsdir').value.trim();
    if (!modsDir) { $('mk-count').textContent = T('mk.pack.needdir', null, '请先指定 mods 目录。'); return; }
    $('mk-count').textContent = T('mk.pack.loading', null, '读取中…');
    $('mk-list').innerHTML = '';
    const res = await wapi.modkitPackCandidates({
      modsDir, mcVersion: $('mk-mc').value.trim(), loader: $('mk-loader').value
    });
    mkState.packCand = res;
    mkRenderCands(res);
  }

  function mkRenderCands(res) {
    const box = $('mk-list');
    box.innerHTML = '';
    if (!res || res.error) { $('mk-count').textContent = T('world.err', null, '错误: ') + ((res && res.error) || ''); return; }
    const items = res.items || [];
    $('mk-count').textContent = T('mk.pack.count', {
      n: items.length, s: mkState.picked.size, sz: fmtSize((res.stats && res.stats.totalBytes) || 0)
    }, `${items.length} 个可选 · 已勾 ${mkState.picked.size} · 合计 ${fmtSize((res.stats && res.stats.totalBytes) || 0)}`);

    if (!items.length) { box.innerHTML = T('mk.pack.none', null, '<div class="empty">这个目录里没有 mod。</div>'); return; }

    for (const it of items) {
      const d = document.createElement('label');
      d.className = 'mk-cand' + (it.library ? ' is-lib' : '') + (it.mcOk === false ? ' bad' : '');
      const tags = [];
      if (it.library) tags.push(T('mk.pack.taglib', null, '基础库'));
      if (it.unknown) tags.push(T('mk.pack.tagunk', null, '元数据未知'));
      if (it.mcOk === false) tags.push(T('mk.pack.tagmc', { v: esc(it.mcRange || '') }, `不支持 ${esc(it.mcRange || '')}`));
      if (it.deps && it.deps.length) tags.push(T('mk.pack.tagdep', { n: it.deps.length }, `依赖 ${it.deps.length} 项`));

      d.innerHTML = T('mk.pack.cand', null,
        `<input type="checkbox" ${mkState.picked.has(it.file) ? 'checked' : ''} />` +
        `<div class="mk-cand-body"><div class="mk-cand-name">${esc(it.name || it.file)}</div>` +
        `<div class="mk-cand-meta">${esc(it.id || '?')} ${esc(it.version || '')} · ${esc(it.loader || '?')} · ${fmtSize(it.size || 0)}</div>` +
        (tags.length ? `<div class="mk-tags">${tags.map((t) => `<span class="mk-tag">${t}</span>`).join('')}</div>` : '') +
        `</div>`);
      const cb = d.querySelector('input');
      cb.onchange = () => {
        if (cb.checked) mkState.picked.add(it.file); else mkState.picked.delete(it.file);
        mkPackCheck();
      };
      box.appendChild(d);
    }
  }

  function mkSelectedFiles() { return Array.from(mkState.picked); }

  async function mkPackCheck() {
    const modsDir = $('mk-modsdir').value.trim();
    if (!modsDir) return;
    const res = await wapi.modkitPackCheck({
      modsDir, selected: mkSelectedFiles(),
      mcVersion: $('mk-mc').value.trim(), loader: $('mk-loader').value
    });
    mkState.packCheck = res;
    mkRenderIssues(res);
  }

  function mkRenderIssues(res) {
    const box = $('mk-problem');
    box.innerHTML = '';
    if (!res || res.error) { $('mk-issues').textContent = T('world.err', null, '错误: ') + ((res && res.error) || ''); return; }

    const issues = res.issues || [];
    $('mk-issues').textContent = T('mk.pack.issuestat', {
      e: res.errorCount || 0, w: res.warnCount || 0
    }, `${res.errorCount || 0} 个错误 · ${res.warnCount || 0} 个警告`);

    // 一键补齐提示
    if (res.suggestAdd && res.suggestAdd.length) {
      const d = document.createElement('div');
      d.className = 'item sev-info';
      d.innerHTML = T('mk.pack.sugadd', { n: res.suggestAdd.length, list: esc(res.suggestAdd.join('、')) },
        `<div><div class="t">${T('mk.pack.sugtitle', null, '可以补齐的依赖')}</div><div class="s">本地已有但没勾：${esc(res.suggestAdd.join('、'))}</div></div>`);
      box.appendChild(d);
    }

    if (!issues.length) {
      if (res.count) box.innerHTML += T('mk.pack.issueclean', null, '<div class="empty">检查通过，可以导出了。</div>');
      else box.innerHTML = T('mk.pack.notpicked', null, '<div class="empty">还没勾选 mod。</div>');
      return;
    }

    const lvText = { error: T('mk.sev.error', null, '错误'), warn: T('mk.sev.warn', null, '警告'), info: T('mk.sev.info', null, '提示') };
    for (const i of issues) {
      const d = document.createElement('div');
      d.className = 'item sev-' + i.level;
      d.innerHTML = T('mk.pack.issue', null,
        `<div><div class="t"><span class="badge sev-${i.level}">${lvText[i.level] || i.level}</span> ${esc(i.title)}</div>` +
        `<div class="s">${esc(i.detail)}</div><div class="dim">${esc(i.code)}</div></div>`);
      box.appendChild(d);
    }
  }

  async function mkPackExport() {
    const modsDir = $('mk-modsdir').value.trim();
    if (!modsDir) { S().setStatus(T('mk.pack.needdir', null, '请先指定 mods 目录。'), 'bad'); return; }
    if (!hasPicked()) { S().setStatus(T('mk.pack.notpicked', null, '还没勾选 mod。'), 'bad'); return; }

    let out = $('mk-out').value.trim();
    if (!out) {
      const stem = ($('mk-name').value.trim() || 'pebble-pack') + '.zip';
      out = await wapi.saveFile(stem, [{ name: T('mk.pack.zipname', null, '整合包'), extensions: ['zip'] }]);
      if (!out) return;
      $('mk-out').value = out;
    }

    const payload = {
      modsDir, selected: mkSelectedFiles(), outZip: out,
      mode: $('mk-mode').value,
      name: $('mk-name').value.trim(), author: $('mk-author').value.trim(),
      mcVersion: $('mk-mc').value.trim(), loader: $('mk-loader').value,
      loaderVersion: $('mk-loaderver').value.trim(), note: $('mk-note').value.trim()
    };
    S().setStatus(T('mk.pack.exporting', null, '正在导出…'), '');
    let res = await wapi.modkitPackExport(payload);
    delete payload.overwrite;
    if (res && res.exists) {
      // 已存在 → 问一次再覆盖
      const yes = confirm(T('mk.pack.overwrite', { p: out }, `文件已存在：\n${out}\n\n要覆盖它吗？`));
      if (!yes) { S().setStatus(T('mk.pack.canceled', null, '已取消。'), ''); return; }
      res = await wapi.modkitPackExport(Object.assign({}, payload, { overwrite: true }));
    }
    if (!res || !res.ok) {
      S().setStatus(T('world.err', null, '错误: ') + ((res && res.error) || ''), 'bad');
      if (res && res.issues) mkRenderIssues(Object.assign({ count: 1 }, res));
      return;
    }
    S().setStatus(T('mk.pack.done', { n: res.count, s: fmtSize(res.size), m: res.mode }, `已导出 ${res.count} 个 mod（${res.mode}）· ${fmtSize(res.size)} → ${out}`), 'ok');
    $('mk-issues').textContent = T('mk.pack.exported', null, '已导出');
  }

  async function mkPackInspect() {
    const f = await wapi.pickFile([{ name: T('mk.pack.zipname', null, '整合包'), extensions: ['zip'] }]);
    if (!f) return;
    const res = await wapi.modkitPackInspect(f);
    if (!res || res.error) { S().setStatus(T('world.err', null, '错误: ') + ((res && res.error) || ''), 'bad'); return; }
    openModal(T('mk.pack.inspect', null, '整合包检查'), (body) => {
      if (!res.isPack) {
        body.innerHTML = T('mk.pack.notpack', null, '<div class="empty">这个 zip 里没有 manifest.json —— 可能不是本工具导出的整合包。</div>');
        return;
      }
      const m = res.manifest;
      body.innerHTML = T('mk.pack.inspectbody', { n: res.files }, 
        `<div class="kv"><span>${T('mk.pack.namelbl', null, '包名')}</span>${esc(m.name || '')}</div>` +
        `<div class="kv"><span>${T('mk.pack.authorlbl', null, '作者')}</span>${esc(m.author || '—')}</div>` +
        `<div class="kv"><span>${T('mk.pack.mclbl', null, 'MC 版本')}</span>${esc((m.game && m.game.minecraft) || '—')}</div>` +
        `<div class="kv"><span>${T('mk.pack.loaderlbl', null, '载入器')}</span>${esc((m.game && m.game.loader) || '—')} ${esc((m.game && m.game.loaderVersion) || '')}</div>` +
        `<div class="kv"><span>${T('mk.pack.modlbl', null, 'Mod 数')}</span>${(m.mods || []).length}</div>` +
        (res.mods.length ? `<div class="tip">${T('mk.pack.attached', { n: res.mods.length }, `自带 ${res.mods.length} 个 mod 文件`)}</div>` : '') +
        `<div class="mk-modlist">${(m.mods || []).map((x) => `<div>${esc(x.name || x.id)} <span class="dim">${esc(x.version || '')}</span></div>`).join('')}</div>`);
    });
  }

  async function mkAddSuggest() {
    const res = mkState.packCheck;
    if (!res || !res.suggestAdd || !res.suggestAdd.length) {
      S().setStatus(T('mk.pack.nosug', null, '当前没有可补齐的依赖。'), '');
      return;
    }
    const cand = mkState.packCand && mkState.packCand.items ? mkState.packCand.items : [];
    for (const id of res.suggestAdd) {
      const hit = cand.find((c) => c.id && c.id.toLowerCase() === id.toLowerCase());
      if (hit) mkState.picked.add(hit.file);
    }
    mkRenderCands(mkState.packCand);
    await mkPackCheck();
  }

  function mkSelAll(v) {
    const res = mkState.packCand;
    if (!res || !res.items) return;
    mkState.picked.clear();
    if (v) for (const it of res.items) if (!it.unknown) mkState.picked.add(it.file);
    mkRenderCands(res);
    mkPackCheck();
  }

  async function initModkit() {
    document.querySelectorAll('#mk-tabs .tab').forEach((t) => { t.onclick = () => mkTabSwitch(t.dataset.mktab); });

    /* ① 更新风险 */
    $('mu-run').onclick = mkUpdateRun;
    $('mu-cmp').onclick = mkUpdateCompare;
    $('mu-modsdir-browse').onclick = async () => { const d = await wapi.pickDirectory(); if (d) $('mu-modsdir').value = d; };
    $('mu-incdir-browse').onclick = async () => { const d = await wapi.pickDirectory(); if (d) $('mu-incdir').value = d; };
    $('mu-old-browse').onclick = async () => { const f = await wapi.pickFile([{ name: 'JAR', extensions: ['jar'] }]); if (f) $('mu-old').value = f; };
    $('mu-new-browse').onclick = async () => { const f = await wapi.pickFile([{ name: 'JAR', extensions: ['jar'] }]); if (f) $('mu-new').value = f; };

    /* ② 汉化补全 */
    $('ml-scan').onclick = mkL10nScan;
    $('ml-export').onclick = mkL10nExport;
    $('ml-tr-go').onclick = mkL10nTranslate;
    $('ml-tr-in').onkeydown = (e) => { if (e.key === 'Enter') mkL10nTranslate(); };
    $('ml-modsdir-browse').onclick = async () => { const d = await wapi.pickDirectory(); if (d) $('ml-modsdir').value = d; };
    $('ml-out-browse').onclick = async () => {
      const f = await wapi.saveFile('pebble-l10n-pack.zip', [{ name: T('mk.l10n.zipname', null, '资源包'), extensions: ['zip'] }]);
      if (f) $('ml-out').value = f;
    };

    /* ③ 资源包预览 */
    $('mp-scan').onclick = mkPackScan;
    $('mp-gamedir-browse').onclick = async () => { const d = await wapi.pickDirectory(); if (d) $('mp-gamedir').value = d; };
    $('mp-detail').onclick = () => S().setStatus(T('mk.preview.hint', null, '点任意卡片看详情。'), '');

    /* ④ 整合包向导 */
    $('mk-scan').onclick = mkPackScanCands;
    $('mk-addsug').onclick = mkAddSuggest;
    $('mk-selall').onclick = () => mkSelAll(true);
    $('mk-selnone').onclick = () => mkSelAll(false);
    $('mk-export').onclick = mkPackExport;
    $('mk-inspect').onclick = mkPackInspect;
    $('mk-modsdir-browse').onclick = async () => { const d = await wapi.pickDirectory(); if (d) $('mk-modsdir').value = d; };
    $('mk-out-browse').onclick = async () => {
      const f = await wapi.saveFile(($('mk-name').value.trim() || 'pebble-pack') + '.zip', [{ name: T('mk.pack.zipname', null, '整合包'), extensions: ['zip'] }]);
      if (f) $('mk-out').value = f;
    };
    ['mk-mc', 'mk-loader'].forEach((id) => { const el = $(id); if (el) el.onchange = () => { if (hasPicked()) mkPackCheck(); }; });
  }

  window.Pages = {
    refreshInstalled, versionOp, downloadOfficial, loadLoaderVersions, installLoader,
    refreshRes, refreshSaves, refreshShots, organizeShots, refreshLogs, resDir, fmtSize, fmtTime, esc,
    /* 新增：Mod 守卫 / 存档时光机 */
    refreshModGuard, modSnapshot, modTimeMachine, saveHealth, saveTimeMachine, openModal, closeModal,
    /* 实例 / 迁移 */
    refreshInstances, initInstancePage, syncActiveGameDir, activateInstance, gameDir, insState, migDetect,
    /* 账户多开 + JVM 调优实验室 */
    refreshAccounts, refreshMulti, initLab, runLab, showLabResult, refreshLabHistory,
    /* 世界页（V4 第一组 + 第二组） */
    initWorld,
    /* 性能页（V4 第三组） */
    initPerf,
    /* Mod 工具页（V4 第四组） */
    initModkit
  };
})();
