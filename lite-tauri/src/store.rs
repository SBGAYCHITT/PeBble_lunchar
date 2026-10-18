//! 轻量配置持久化：设置 + 离线账户。
//!
//! 存储位置用 Tauri 的 `app_data_dir()`（Windows 上是
//! `%APPDATA%\com.sbgaychitt.pebblelauncher.lite\`），**不再往 %LOCALAPPDATA% 里
//! 塞一份 200 MB 的运行时副本** —— 这是旧 Electron 版被诟病的一点。
//!
//! 两个 JSON 分开存：设置是「单条记录，整存整取」，账户是「列表，按名字合并」，
//! 混在一个文件里容易互相覆盖。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    /// 留空 = 用默认的 `%APPDATA%\.minecraft`
    pub mc_dir: String,
    /// 留空 = 自动检测
    pub java_path: String,
    pub jvm_args: String,
    pub memory_gb: u32,
    pub win_w: u32,
    pub win_h: u32,
    pub fullscreen: bool,
    pub player_name: String,
    pub hide_after_launch: bool,
    /// 当前激活的账户 id（离线 uuid）
    pub active_account: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            mc_dir: String::new(),
            java_path: String::new(),
            jvm_args: String::new(),
            memory_gb: 4,
            win_w: 854,
            win_h: 480,
            fullscreen: false,
            player_name: String::new(),
            hide_after_launch: false,
            active_account: String::new(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Account {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub uuid: String,
}

pub fn config_dir(app_data: &Path) -> PathBuf {
    let d = app_data.to_path_buf();
    let _ = std::fs::create_dir_all(&d);
    d
}

fn settings_path(app_data: &Path) -> PathBuf {
    config_dir(app_data).join("settings.json")
}

fn accounts_path(app_data: &Path) -> PathBuf {
    config_dir(app_data).join("accounts.json")
}

pub fn load_settings(app_data: &Path) -> Settings {
    let mut s = std::fs::read_to_string(settings_path(app_data))
        .ok()
        .and_then(|t| serde_json::from_str::<Settings>(&t).ok())
        .unwrap_or_default();
    s.normalize();
    s
}

pub fn save_settings(app_data: &Path, s: &Settings) -> Result<(), String> {
    let mut s = s.clone();
    s.normalize();
    let p = settings_path(app_data);
    let text = serde_json::to_string_pretty(&s).map_err(|e| e.to_string())?;
    std::fs::write(&p, text).map_err(|e| format!("保存设置失败: {e}"))
}

pub fn load_accounts(app_data: &Path) -> Vec<Account> {
    std::fs::read_to_string(accounts_path(app_data))
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<Account>>(&t).ok())
        .unwrap_or_default()
}

pub fn save_accounts(app_data: &Path, a: &[Account]) -> Result<(), String> {
    let p = accounts_path(app_data);
    let text = serde_json::to_string_pretty(a).map_err(|e| e.to_string())?;
    std::fs::write(&p, text).map_err(|e| format!("保存账户失败: {e}"))
}

/// 把玩家手输或粘贴的目录归一化。
///
/// 设置框里很常见被粘进 `C:/Users/x/.minecraft` 这种正斜杠路径。直接丢给
/// `PathBuf::join` 之后会变成 `C:\Users\x/.minecraft\assets` —— 两种分隔符混在
/// 一条路径里。JVM 能吃下去，但界面上难看、日志里也不好比对，所以统一过来。
/// 顺便去掉末尾多余的分隔符（盘根 `C:\` 保留）。
pub fn normalize_dir(p: &str) -> String {
    let t = p.trim();
    if t.is_empty() {
        return String::new();
    }
    // Windows 的合法路径里不会出现正斜杠，直接换掉是安全的
    let mut s = t.replace('/', std::path::MAIN_SEPARATOR_STR);
    while s.len() > 3 && s.ends_with(std::path::MAIN_SEPARATOR_STR) {
        s.pop();
    }
    s
}

impl Settings {
    /// 把用户可编辑的路径字段过一遍归一化。load 和 save 两头都调，
    /// 这样老配置文件里的历史脏数据也会被顺手纠正。
    pub fn normalize(&mut self) {
        self.mc_dir = normalize_dir(&self.mc_dir);
        self.java_path = normalize_dir(&self.java_path);
    }
}

/// 默认游戏目录：`%APPDATA%\.minecraft`。
///
/// 注意这里**不跟着启动器自己的数据目录走** —— 官方启动器、HMCL、PCL 都读这里，
/// 共用才能让玩家已有的版本立刻出现在列表里。
pub fn default_mc_dir() -> String {
    if let Ok(appdata) = std::env::var("APPDATA") {
        return PathBuf::from(appdata)
            .join(".minecraft")
            .to_string_lossy()
            .to_string();
    }
    String::new()
}
