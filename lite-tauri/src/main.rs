//! Pebble Lunchar Lite —— Rust + WebView2 版启动器。
//!
//! 与 Electron 版的分工不变：这一层只负责「读版本 JSON → 拼启动命令 → 起进程」，
//! 界面仍然是 HTML/CSS，跑在系统自带的 WebView2 里。
//!
//! 体积上的差别来自运行时归属：Electron 要自带一整套 Chromium（解包 172 MB），
//! 这里用的是 Windows 10/11 已经预装的 WebView2，所以最终只剩一个几 MB 的 exe。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod java;
mod launch;
mod mc;
mod store;

use serde::Serialize;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

/// 免得每个拉起子进程的地方都写一遍；也避免出现一个一闪而过的黑色控制台窗口。
#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct AppState {
    app_data: PathBuf,
    /// 正在跑的游戏进程 pid
    pid: Mutex<Option<u32>>,
}

fn mc_dir_of(s: &store::Settings) -> PathBuf {
    let raw = if s.mc_dir.trim().is_empty() {
        store::default_mc_dir()
    } else {
        s.mc_dir.clone()
    };
    // 归一化一次，后面所有拼出来的路径（assets、libraries、natives）都跟着整齐
    PathBuf::from(store::normalize_dir(&raw))
}

// ---------------------------------------------------------------- 基础信息

/// 返回给界面的结构统一用 camelCase 序列化。
///
/// Tauri 只对**入参**做 camelCase → snake_case 的自动转换，**返回值不会**，
/// 原样按 Rust 字段名输出。前端是 JS，读的自然都是 `info.defaultMcDir` 这种写法，
/// 所以这里必须显式声明，否则界面上会静默显示 undefined —— 不报错、不崩溃，
/// 只是内容空着，非常难发现。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    name: String,
    version: String,
    runtime: String,
    default_mc_dir: String,
    data_dir: String,
}

#[tauri::command]
fn app_info(state: State<AppState>) -> AppInfo {
    AppInfo {
        name: "Pebble Lunchar Lite".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        runtime: format!("Rust {} · WebView2", rustc_version_hint()),
        default_mc_dir: store::default_mc_dir(),
        data_dir: state.app_data.to_string_lossy().to_string(),
    }
}

/// 不引入额外依赖，够界面显示即可。
fn rustc_version_hint() -> &'static str {
    "edition2021"
}

// ---------------------------------------------------------------- 设置

#[tauri::command]
fn settings_get(state: State<AppState>) -> store::Settings {
    store::load_settings(&state.app_data)
}

#[tauri::command]
fn settings_save(state: State<AppState>, settings: store::Settings) -> Result<(), String> {
    store::save_settings(&state.app_data, &settings)
}

#[tauri::command]
fn default_mcdir() -> String {
    store::default_mc_dir()
}

/// 界面启动自检信标（见 ui/app.js 的 `selfCheck`）。
///
/// 平时是空操作；只有设置了环境变量 `PEBBLE_LITE_BOOT_LOG=<文件路径>` 才落盘。
/// 排「界面白屏 / 一直转圈」这类问题时，这是唯一能拿到页面内部实测值的通道
/// —— WebView2 的合成表面从外部截屏抓不到内容，截图只会骗人。
#[tauri::command]
fn ui_ready(diag: serde_json::Value) {
    let Ok(path) = std::env::var("PEBBLE_LITE_BOOT_LOG") else {
        return;
    };
    if path.trim().is_empty() {
        return;
    }
    let text = serde_json::to_string_pretty(&diag).unwrap_or_else(|_| diag.to_string());
    let _ = std::fs::write(path, text);
}

// ---------------------------------------------------------------- 版本

#[tauri::command]
fn list_versions(mc_dir: Option<String>) -> Vec<mc::VersionEntry> {
    let dir = match mc_dir {
        Some(d) if !d.trim().is_empty() => PathBuf::from(d),
        _ => PathBuf::from(store::default_mc_dir()),
    };
    mc::scan_versions(&dir)
}

/// 列出某个版本要用到的关键信息，界面上「详情」用。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VersionDetail {
    id: String,
    main_class: String,
    inherits: Option<String>,
    java_major: Option<u32>,
    library_count: usize,
    missing_libraries: usize,
    has_assets_index: bool,
    asset_index: String,
}

#[tauri::command]
fn version_detail(mc_dir: String, version_id: String) -> Result<VersionDetail, String> {
    let base = PathBuf::from(store::normalize_dir(&mc_dir));
    let json = base
        .join("versions")
        .join(&version_id)
        .join(format!("{version_id}.json"));
    let (vj, _, _) = mc::read_version(&json)?;
    let lib_root = base.join("libraries");
    let mut missing = 0usize;
    for l in vj.libraries.iter() {
        if !mc::lib_applies(l) || mc::natives_host_mismatch(l) {
            continue;
        }
        if let Some(rel) = mc::artifact_relpath(l) {
            if !lib_root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR)).exists() {
                missing += 1;
            }
        }
    }
    let asset_index = vj
        .asset_index
        .as_ref()
        .and_then(|a| a.id.clone())
        .or_else(|| vj.assets.clone())
        .unwrap_or_else(|| "legacy".into());
    let has_idx = base
        .join("assets")
        .join("indexes")
        .join(format!("{asset_index}.json"))
        .exists();
    Ok(VersionDetail {
        id: vj.id.clone(),
        main_class: vj.main_class.clone().unwrap_or_default(),
        inherits: vj.inherits_from.clone(),
        java_major: launch::required_java_major(&vj),
        library_count: vj.libraries.len(),
        missing_libraries: missing,
        has_assets_index: has_idx,
        asset_index,
    })
}

// ---------------------------------------------------------------- Java

fn detect_java_impl(
    app_data: &std::path::Path,
    mc_dir: Option<&std::path::Path>,
    extra: Option<String>,
) -> Vec<java::JavaInfo> {
    let mut list: Vec<String> = Vec::new();
    if let Some(e) = extra {
        if !e.trim().is_empty() {
            list.push(e);
        }
    }
    // 启动器自带的运行时（将来做「一键装 Java」时落在这里）
    list.push(app_data.join("runtime").to_string_lossy().to_string());
    // 官方启动器下载的 JRE 落在 .minecraft/runtime/<组件名>/，直接复用 ——
    // 玩家为了玩 MC 多半已经有一份，没必要让人再装一遍
    if let Some(mc) = mc_dir {
        let rt = mc.join("runtime");
        if let Ok(rd) = std::fs::read_dir(&rt) {
            for e in rd.flatten() {
                let bin = e.path().join("bin").join("java.exe");
                if bin.exists() {
                    list.push(bin.to_string_lossy().to_string());
                }
            }
        }
    }
    java::detect_all(&list)
}

#[tauri::command]
fn detect_java(state: State<AppState>, extra: Option<String>) -> Vec<java::JavaInfo> {
    let s = store::load_settings(&state.app_data);
    let mc = mc_dir_of(&s);
    detect_java_impl(&state.app_data, Some(&mc), extra)
}

// ---------------------------------------------------------------- 账户

#[tauri::command]
fn accounts_list(state: State<AppState>) -> Vec<store::Account> {
    store::load_accounts(&state.app_data)
}

#[tauri::command]
fn account_add_offline(
    state: State<AppState>,
    name: String,
) -> Result<Vec<store::Account>, String> {
    let n = name.trim().to_string();
    if n.is_empty() {
        return Err("玩家名不能为空".into());
    }
    if n.chars().count() > 16 {
        return Err("玩家名最多 16 个字符".into());
    }
    let uuid = mc::offline_uuid(&n);
    let mut list = store::load_accounts(&state.app_data);
    if !list.iter().any(|a| a.uuid == uuid) {
        list.push(store::Account {
            id: uuid.clone(),
            name: n.clone(),
            kind: "offline".into(),
            uuid: uuid.clone(),
        });
        store::save_accounts(&state.app_data, &list)?;
    }
    // 顺手设成当前账户，并同步到设置里的玩家名
    let mut s = store::load_settings(&state.app_data);
    s.active_account = uuid;
    s.player_name = n;
    store::save_settings(&state.app_data, &s)?;
    Ok(list)
}

#[tauri::command]
fn account_set_active(state: State<AppState>, id: String) -> Result<(), String> {
    let list = store::load_accounts(&state.app_data);
    let acc = list.iter().find(|a| a.id == id).ok_or("账户不存在")?;
    let mut s = store::load_settings(&state.app_data);
    s.active_account = acc.id.clone();
    s.player_name = acc.name.clone();
    store::save_settings(&state.app_data, &s)
}

#[tauri::command]
fn account_remove(state: State<AppState>, id: String) -> Result<Vec<store::Account>, String> {
    let mut list = store::load_accounts(&state.app_data);
    list.retain(|a| a.id != id);
    store::save_accounts(&state.app_data, &list)?;
    let mut s = store::load_settings(&state.app_data);
    if s.active_account == id {
        s.active_account = list.first().map(|a| a.id.clone()).unwrap_or_default();
        s.player_name = list.first().map(|a| a.name.clone()).unwrap_or_default();
        store::save_settings(&state.app_data, &s)?;
    }
    Ok(list)
}

/// 「演练」的结果。
///
/// 这一份**故意保持 snake_case**：它是给人和脚本读的诊断产物
/// （`--dry-run` 写文件、`verify-lite.js` 断言都按 snake_case 取字段），
/// 不直接面向界面，所以不跟着上面那批走 camelCase。
#[derive(Serialize)]
struct DryRun {
    java: String,
    java_note: String,
    cwd: String,
    natives_dir: String,
    classpath_count: usize,
    args: Vec<String>,
    warnings: Vec<String>,
}

/// 「演练」：把最终要执行的命令行拼出来但不执行。
///
/// 存在的意义有两个 ——
/// 1. 给玩家看：启动失败时能直接看命令，不用猜；
/// 2. 给开发用：机器上没装 Java 时也能验证参数拼装是否正确。
#[tauri::command]
fn dry_run_launch(
    state: State<AppState>,
    version_id: String,
    player_name: Option<String>,
) -> Result<DryRun, String> {
    let mut s = store::load_settings(&state.app_data);
    if let Some(n) = player_name {
        if !n.trim().is_empty() {
            s.player_name = n.trim().to_string();
        }
    }
    if s.player_name.trim().is_empty() {
        s.player_name = "Player".into();
    }
    let mc_dir = mc_dir_of(&s);
    let javas = detect_java_impl(&state.app_data, Some(&mc_dir), Some(s.java_path.clone()));
    let j = match javas.first() {
        Some(j) => j.clone(),
        None => java::JavaInfo {
            path: "<未检测到 Java — 这里是占位路径>".into(),
            version: "-".into(),
            major: 0,
            source: "占位".into(),
        },
    };

    build_dry_run(&mc_dir, &version_id, &s.player_name, &s, &j)
}

/// 两个入口（Tauri 命令 / 命令行 `--dry-run`）共用同一套拼装与体检逻辑。
fn build_dry_run(
    mc_dir: &std::path::Path,
    version_id: &str,
    player_name: &str,
    settings: &store::Settings,
    j: &java::JavaInfo,
) -> Result<DryRun, String> {
    let json = mc_dir
        .join("versions")
        .join(version_id)
        .join(format!("{version_id}.json"));
    let (vj, _, _) = mc::read_version(&json)?;
    let plan = launch::build_plan(mc_dir, version_id, j, player_name, settings)?;

    let lib_root = mc_dir.join("libraries");
    let mut missing = Vec::new();
    for l in vj.libraries.iter() {
        if !mc::lib_applies(l) || mc::natives_host_mismatch(l) {
            continue;
        }
        if let Some(rel) = mc::artifact_relpath(l) {
            if !lib_root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR)).exists() {
                missing.push(l.name.clone());
            }
        }
    }
    let mut warnings = Vec::new();
    if !missing.is_empty() {
        warnings.push(format!(
            "有 {} 个库文件不在磁盘上，游戏很可能起不来",
            missing.len()
        ));
        for m in missing.iter().take(6) {
            warnings.push(format!("  缺 {m}"));
        }
    }
    let idx = vj
        .asset_index
        .as_ref()
        .and_then(|a| a.id.clone())
        .or_else(|| vj.assets.clone())
        .unwrap_or_else(|| "legacy".into());
    if !mc_dir
        .join("assets")
        .join("indexes")
        .join(format!("{idx}.json"))
        .exists()
    {
        warnings.push(format!(
            "assets/indexes/{idx}.json 缺失：能进游戏，但没声音、没语言文件"
        ));
    }
    let cp_count = plan
        .args
        .iter()
        .position(|a| a == "-cp")
        .and_then(|i| plan.args.get(i + 1))
        .map(|s| s.split(';').count())
        .unwrap_or(0);

    Ok(DryRun {
        java: plan.java,
        java_note: j.source.clone(),
        cwd: plan.cwd,
        natives_dir: plan.natives_dir,
        classpath_count: cp_count,
        args: plan.args,
        warnings,
    })
}

/// `--dry-run <游戏目录> <版本 id> <输出文件>`：不开界面，把命令行写进文件。
///
/// release 构建是 windows_subsystem="windows"，没有控制台，只能写文件。
/// 这条路径是给自动化核验用的（机器上没装 Java 也能验证参数拼装）。
fn cli_dry_run() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    let i = args.iter().position(|a| a == "--dry-run")?;
    let (mc, vid, out) = (args.get(i + 1)?, args.get(i + 2)?, args.get(i + 3)?);
    let mc_dir = PathBuf::from(store::normalize_dir(mc));

    let settings = store::Settings {
        memory_gb: 4,
        win_w: 854,
        win_h: 480,
        player_name: "DryRunPlayer".into(),
        ..Default::default()
    };
    let javas = detect_java_impl(&mc_dir, Some(&mc_dir), None);
    let j = javas.first().cloned().unwrap_or(java::JavaInfo {
        path: "<未检测到 Java — 占位路径>".into(),
        version: "-".into(),
        major: 0,
        source: "占位".into(),
    });

    let payload = match build_dry_run(&mc_dir, vid, "DryRunPlayer", &settings, &j) {
        Ok(d) => serde_json::to_string_pretty(&d).unwrap_or_else(|e| format!("{{\"error\":\"{e}\"}}")),
        Err(e) => format!("{{\"error\":{}}}", serde_json::to_string(&e).unwrap_or_default()),
    };
    let _ = std::fs::write(out, payload);
    Some(0)
}

// ---------------------------------------------------------------- 启动

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchResult {
    pid: u32,
    java: String,
    java_major: u32,
    preview: String,
}

#[tauri::command]
fn launch_game(
    app: AppHandle,
    state: State<AppState>,
    version_id: String,
    player_name: Option<String>,
) -> Result<LaunchResult, String> {
    if state.pid.lock().map(|p| p.is_some()).unwrap_or(false) {
        return Err("已经有一个游戏在运行了，先关掉再启动".into());
    }
    let mut s = store::load_settings(&state.app_data);
    if let Some(n) = player_name {
        if !n.trim().is_empty() {
            s.player_name = n.trim().to_string();
            let _ = store::save_settings(&state.app_data, &s);
        }
    }
    if s.player_name.trim().is_empty() {
        return Err("还没填玩家名。先去「账户」加一个离线账户。".into());
    }
    let mc_dir = mc_dir_of(&s);
    if !mc_dir.exists() {
        return Err(format!("游戏目录不存在：{}", mc_dir.display()));
    }

    // 挑 Java：优先用户指定的，其次自带的 runtime，再其次系统装的
    let javas = detect_java_impl(&state.app_data, Some(&mc_dir), Some(s.java_path.clone()));
    if javas.is_empty() {
        return Err("没检测到可用的 Java。去「设置」里指定 java.exe，或装一个 Java 21。".into());
    }
    let json = mc_dir
        .join("versions")
        .join(&version_id)
        .join(format!("{version_id}.json"));
    let (vj, _, _) = mc::read_version(&json)?;
    let need = launch::required_java_major(&vj);
    let picked = java::pick(&javas, need)
        .cloned()
        .ok_or("没有满足版本要求的 Java")?;

    let plan = launch::build_plan(&mc_dir, &version_id, &picked, &s.player_name, &s)?;

    let _ = app.emit(
        "game-log",
        format!("[启动器] Java {} → {}", picked.version, picked.path),
    );
    let _ = app.emit(
        "game-log",
        format!("[启动器] 版本 {version_id} · 玩家 {} · 共 {} 个启动参数", s.player_name, plan.args.len()),
    );

    let mut cmd = Command::new(&plan.java);
    cmd.args(&plan.args)
        .current_dir(&plan.cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("拉起 Java 失败：{e}（检查 Java 路径是否正确）"))?;
    let pid = child.id();

    let out = child.stdout.take();
    let err = child.stderr.take();
    let a1 = app.clone();
    let a2 = app.clone();
    if let Some(o) = out {
        std::thread::spawn(move || pump(o, a1));
    }
    if let Some(e) = err {
        std::thread::spawn(move || pump(e, a2));
    }

    *state.pid.lock().unwrap() = Some(pid);

    let a3 = app.clone();
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|st| st.code());
        let _ = a3.emit("game-exit", code.unwrap_or(-1));
    });

    Ok(LaunchResult {
        pid,
        java: plan.java,
        java_major: picked.major,
        preview: plan.preview,
    })
}

/// 逐行读子进程输出并推给界面。
///
/// 不能按 UTF-8 切行 —— 中文 Windows 上老版本 MC 的输出是 GBK，遇到非法字节
/// 直接丢整行会让人以为「游戏没输出」。这里按字节读到换行再 lossy 转换。
fn pump<R: Read + Send + 'static>(r: R, app: AppHandle) {
    let mut reader = BufReader::new(r);
    let mut buf: Vec<u8> = Vec::with_capacity(512);
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(_) => {
                while matches!(buf.last(), Some(b'\n') | Some(b'\r')) {
                    buf.pop();
                }
                let line = String::from_utf8_lossy(&buf).to_string();
                if !line.trim().is_empty() {
                    let _ = app.emit("game-log", line);
                }
            }
            Err(_) => break,
        }
    }
}

#[tauri::command]
fn kill_game(state: State<AppState>) -> Result<(), String> {
    let pid = state.pid.lock().unwrap().take();
    match pid {
        Some(p) => {
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill")
                    .args(["/PID", &p.to_string(), "/T", "/F"])
                    .creation_flags(CREATE_NO_WINDOW)
                    .status();
            }
            Ok(())
        }
        None => Err("当前没有在跑的游戏".into()),
    }
}

#[tauri::command]
fn game_running(state: State<AppState>) -> bool {
    state.pid.lock().map(|p| p.is_some()).unwrap_or(false)
}

// ---------------------------------------------------------------- 文件 / 窗口

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("路径不存在：{path}"));
    }
    Command::new("explorer")
        .arg(p.as_os_str())
        .spawn()
        .map_err(|e| format!("打开失败：{e}"))?;
    Ok(())
}

#[tauri::command]
async fn pick_dir(app: AppHandle) -> Option<String> {
    let a = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        a.dialog()
            .file()
            .blocking_pick_folder()
            .map(|p| p.to_string())
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
async fn pick_file(app: AppHandle, filter_name: String, extensions: Vec<String>) -> Option<String> {
    let a = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // `exts` 必须在闭包内部构造：它借用 `extensions`，而 spawn_blocking 要求
        // 闭包是 'static 的，在外面建好就会被生命周期检查拦下。
        let exts: Vec<&str> = extensions.iter().map(|s| s.as_str()).collect();
        a.dialog()
            .file()
            .add_filter(&filter_name, &exts)
            .blocking_pick_file()
            .map(|p| p.to_string())
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
fn win_min(window: tauri::Window) {
    let _ = window.minimize();
}

#[tauri::command]
fn win_max(window: tauri::Window) {
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
}

#[tauri::command]
fn win_close(window: tauri::Window) {
    let _ = window.close();
}

// ---------------------------------------------------------------- 入口

fn main() {
    if let Some(code) = cli_dry_run() {
        std::process::exit(code);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            let _ = std::fs::create_dir_all(&dir);
            app.manage(AppState {
                app_data: dir,
                pid: Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            settings_get,
            settings_save,
            default_mcdir,
            ui_ready,
            list_versions,
            version_detail,
            detect_java,
            accounts_list,
            account_add_offline,
            account_set_active,
            account_remove,
            launch_game,
            dry_run_launch,
            kill_game,
            game_running,
            open_path,
            pick_dir,
            pick_file,
            win_min,
            win_max,
            win_close,
        ])
        .run(tauri::generate_context!())
        .expect("Pebble Lunchar Lite 启动失败");
}
