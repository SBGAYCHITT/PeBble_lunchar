//! 启动命令的拼装与子进程管理。
//!
//! 这一段是整个启动器里唯一「错了就闪退、且很难查」的地方，所以严格按官方规范走：
//! 新旧两代参数格式分开处理，占位符逐类替换，classpath 顺序保持「库列表 → 版本 jar」。

use crate::java::JavaInfo;
use crate::mc::{self, VersionJson};
use crate::store::Settings;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub const LAUNCHER_NAME: &str = "PebbleLuncharLite";
pub const LAUNCHER_VERSION: &str = env!("CARGO_PKG_VERSION");

pub struct LaunchPlan {
    pub java: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub natives_dir: String,
    /// 给界面显示的一行命令预览（只显示前若干参数）
    pub preview: String,
}

/// 拼一条完整的启动命令。返回 Ok 表示「参数没问题」，不代表游戏一定能跑起来。
pub fn build_plan(
    mc_dir: &Path,
    version_id: &str,
    java: &JavaInfo,
    account_name: &str,
    settings: &Settings,
) -> Result<LaunchPlan, String> {
    let vdir = mc_dir.join("versions").join(version_id);
    let json_path = vdir.join(format!("{version_id}.json"));
    if !json_path.exists() {
        return Err(format!("版本 {version_id} 的 JSON 不存在"));
    }
    let (vj, child_dir, chain) = mc::read_version(&json_path)?;

    let main_class = vj
        .main_class
        .clone()
        .ok_or_else(|| "版本 JSON 里没有 mainClass（文件可能不完整）".to_string())?;

    let lib_root = mc_dir.join("libraries");
    // 目录名跟官方启动器保持一致（`natives-<版本>`），这样两边的解包结果能互相复用，
    // 不会在游戏目录里再堆一份几 MB 的 DLL
    let natives_dir = vdir.join(format!("natives-{version_id}"));
    std::fs::create_dir_all(&natives_dir).map_err(|e| format!("建 natives 目录失败: {e}"))?;

    // ---------- classpath ----------
    let mut cp: Vec<String> = Vec::new();
    let mut native_jars: Vec<PathBuf> = Vec::new();
    for lib in vj.libraries.iter() {
        if !mc::lib_applies(lib) {
            continue;
        }
        // 架构不符的 natives 整条跳过。Mojang 的 rules 只看 os.name 不看 os.arch，
        // arm64 那一套在 x64 机器上也会「通过检查」，留着只会在扁平目录里
        // 跟正确架构的同名 DLL 打架。
        if mc::natives_host_mismatch(lib) {
            continue;
        }
        // 老写法：natives 藏在下游的 classifiers 里，本体是普通库
        if let Some(cls) = mc::native_classifier(lib) {
            if let Some(rel) = mc::native_relpath(lib, &cls) {
                let p = lib_root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
                if p.exists() {
                    native_jars.push(p);
                }
            }
        }
        if let Some(rel) = mc::artifact_relpath(lib) {
            let p = lib_root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            if p.exists() {
                // 新写法：artifact 本身就是 natives jar。它要**同时**进 classpath
                // （LWJGL 3 从 classpath 自解压 DLL）和解包列表。
                if mc::natives_classifier_in_name(lib).is_some() {
                    native_jars.push(p.clone());
                }
                cp.push(p.to_string_lossy().to_string());
            }
        }
    }

    // 版本 jar：自己的优先，加载器版本（inheritsFrom）退回父版本的 jar
    let mut jar = child_dir.join(format!("{version_id}.jar"));
    if !jar.exists() {
        let mut found = false;
        for pdir in chain.iter() {
            if let Some(pid) = pdir.file_name().and_then(|x| x.to_str()) {
                let cand = pdir.join(format!("{pid}.jar"));
                if cand.exists() {
                    jar = cand;
                    found = true;
                    break;
                }
            }
        }
        if !found {
            jar = PathBuf::new();
        }
    }
    if jar.exists() {
        cp.push(jar.to_string_lossy().to_string());
    }

    if cp.is_empty() {
        return Err("classpath 为空：libraries 一个都没找到，游戏目录可能不完整".into());
    }

    // ---------- natives ----------
    if !native_jars.is_empty() {
        mc::extract_natives(&native_jars, &natives_dir)?;
    }

    // ---------- 变量表 ----------
    let asset_index = vj
        .asset_index
        .as_ref()
        .and_then(|a| a.id.clone())
        .or_else(|| vj.assets.clone())
        .unwrap_or_else(|| "legacy".into());
    let uuid = mc::offline_uuid(account_name);

    let mut vars: HashMap<&str, String> = HashMap::new();
    vars.insert("natives_directory", natives_dir.to_string_lossy().to_string());
    vars.insert("launcher_name", LAUNCHER_NAME.into());
    vars.insert("launcher_version", LAUNCHER_VERSION.into());
    vars.insert("classpath", cp.join(";"));
    vars.insert("classpath_separator", ";".into());
    vars.insert("library_directory", lib_root.to_string_lossy().to_string());
    vars.insert("version_name", vj.id.clone());
    vars.insert("version_type", vj.vtype.clone().unwrap_or_else(|| "release".into()));
    vars.insert("game_directory", mc_dir.to_string_lossy().to_string());
    vars.insert("assets_root", mc_dir.join("assets").to_string_lossy().to_string());
    vars.insert("assets_index_name", asset_index.clone());
    vars.insert("game_assets", mc_dir.join("assets").join("virtual").join("legacy").to_string_lossy().to_string());
    vars.insert("auth_player_name", account_name.to_string());
    vars.insert("auth_uuid", uuid.clone());
    vars.insert("auth_access_token", "0".into());
    vars.insert("auth_session", "-".into());
    vars.insert("user_type", "legacy".into());
    vars.insert("user_properties", "{}".into());
    vars.insert("clientid", String::new());
    vars.insert("auth_xuid", String::new());
    vars.insert("resolution_width", settings.win_w.to_string());
    vars.insert("resolution_height", settings.win_h.to_string());

    // ---------- JVM 参数 ----------
    let mut args: Vec<String> = Vec::new();
    let mem = settings.memory_gb.clamp(1, 64);
    // 只给 -Xmx。-Xms 顶到同一个值会让小内存机器启动时直接申请失败，
    // 而官方启动器也只设 -Xmx。
    args.push(format!("-Xmx{mem}G"));

    let jvm_from_json = vj.arguments.as_ref().map(|a| a.jvm.clone()).unwrap_or_default();
    if jvm_from_json.is_empty() {
        // 1.13 之前：这两条要自己补
        args.push(format!("-Djava.library.path={}", natives_dir.to_string_lossy()));
        args.push(format!("-Dminecraft.launcher.brand={LAUNCHER_NAME}"));
        args.push(format!("-Dminecraft.launcher.version={LAUNCHER_VERSION}"));
        args.push("-cp".into());
        args.push(cp.join(";"));
    } else {
        args.extend(mc::flatten_args(&jvm_from_json, &vars));
    }

    for extra in settings.jvm_args.split_whitespace() {
        if !extra.is_empty() {
            args.push(extra.to_string());
        }
    }
    if settings.fullscreen {
        // 新版靠 arguments 里的条件块，老版没有；显式加一条兜底会被忽略也无害
        args.push("--fullscreen".into());
    }

    args.push(main_class);

    // ---------- 游戏参数 ----------
    let game_from_json = vj.arguments.as_ref().map(|a| a.game.clone()).unwrap_or_default();
    if !game_from_json.is_empty() {
        args.extend(mc::flatten_args(&game_from_json, &vars));
    } else if let Some(legacy) = &vj.minecraft_arguments {
        for a in mc::split_legacy_args(legacy) {
            args.push(mc::subst(&a, &vars));
        }
    } else {
        return Err("版本 JSON 既没有 arguments.game 也没有 minecraftArguments".into());
    }

    // 老版本不会自带分辨率参数，这里补上（新版忽略重复项）
    if !args.iter().any(|a| a == "--width") && settings.win_w > 0 {
        args.push("--width".into());
        args.push(settings.win_w.to_string());
        args.push("--height".into());
        args.push(settings.win_h.to_string());
    }

    let preview = format!(
        "{} {} … {} 个参数",
        java.path,
        args.first().cloned().unwrap_or_default(),
        args.len()
    );

    Ok(LaunchPlan {
        java: java.path.clone(),
        args,
        cwd: mc_dir.to_string_lossy().to_string(),
        natives_dir: natives_dir.to_string_lossy().to_string(),
        preview,
    })
}

/// 给界面用的「这个版本需要哪个 Java」。
pub fn required_java_major(vj: &VersionJson) -> Option<u32> {
    vj.java_version.as_ref().and_then(|j| j.major_version)
}
