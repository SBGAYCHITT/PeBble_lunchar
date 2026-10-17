//! Java 定位与版本探测。
//!
//! 不去读注册表（要额外的 crate 和权限），走「路径枚举 + 实际跑一次 `java -version`」
//! 这条路：结果最可靠，而且能顺便拿到真正的主版本号 —— 版本 JSON 里写的
//! `javaVersion.majorVersion` 只是「最低要求」，机器上装的经常不是那个。

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct JavaInfo {
    pub path: String,
    /// 完整版本串，如 `21.0.5`
    pub version: String,
    /// 主版本号，如 21 / 17 / 8
    pub major: u32,
    /// 来自哪里（用于界面提示）
    pub source: String,
}

/// 候选路径来源：环境变量、常见安装目录、启动器自带的 runtime。
fn candidates(extra: &[String]) -> Vec<(PathBuf, String)> {
    let mut out: Vec<(PathBuf, String)> = Vec::new();

    if let Ok(jh) = std::env::var("JAVA_HOME") {
        if !jh.trim().is_empty() {
            out.push((PathBuf::from(jh).join("bin/java.exe"), "JAVA_HOME".into()));
        }
    }

    // 常见厂商安装根目录
    let roots = [
        r"C:\Program Files\Java",
        r"C:\Program Files (x86)\Java",
        r"C:\Program Files\Eclipse Adoptium",
        r"C:\Program Files\Microsoft",
        r"C:\Program Files\Zulu",
        r"C:\Program Files\BellSoft",
        r"C:\Program Files\Amazon Corretto",
        r"C:\Program Files\Semeru",
        r"D:\Program Files\Java",
        r"D:\Java",
        r"D:\dev\java",
    ];
    for r in roots {
        let rd = match std::fs::read_dir(r) {
            Ok(x) => x,
            Err(_) => continue,
        };
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            let cand = p.join("bin/java.exe");
            if cand.exists() {
                out.push((cand, "已安装".into()));
            }
        }
    }

    // PATH 里的 java
    if let Ok(paths) = std::env::var("PATH") {
        for seg in std::env::split_paths(&paths) {
            let cand = seg.join("java.exe");
            if cand.exists() {
                out.push((cand, "PATH".into()));
            }
        }
    }

    // 启动器自己下载/用户手工指定的
    for e in extra {
        if e.trim().is_empty() {
            continue;
        }
        let p = PathBuf::from(e);
        if p.is_file() {
            out.push((p, "指定".into()));
        } else if p.is_dir() {
            let cand = p.join("bin/java.exe");
            if cand.exists() {
                out.push((cand, "指定".into()));
            }
        }
    }

    out
}

/// 跑一次 `java -version` 拿真实版本。
pub fn probe(java: &Path, source: &str) -> Option<JavaInfo> {
    if !java.exists() {
        return None;
    }
    let out = Command::new(java).arg("-version").output().ok()?;
    // java 的版本信息一律打在 stderr
    let text = String::from_utf8_lossy(&out.stderr).to_string()
        + &String::from_utf8_lossy(&out.stdout);
    let version = parse_version(&text)?;
    let major = version
        .split('.')
        .next()
        .and_then(|x| x.parse::<u32>().ok())
        .unwrap_or(0);
    // Java 8 报的是 1.8.0_xxx，主版本要取第二个数
    let major = if major == 1 {
        version.split('.').nth(1).and_then(|x| x.parse::<u32>().ok()).unwrap_or(1)
    } else {
        major
    };
    Some(JavaInfo {
        path: java.to_string_lossy().to_string(),
        version,
        major,
        source: source.to_string(),
    })
}

/// 从 `openjdk version "21.0.5" 2025-01-21` 里抠版本号。
fn parse_version(text: &str) -> Option<String> {
    for line in text.lines() {
        if let Some(i) = line.find("version \"") {
            let rest = &line[i + 9..];
            if let Some(j) = rest.find('"') {
                return Some(rest[..j].to_string());
            }
        }
    }
    None
}

/// 全量探测，按主版本降序去重返回。
pub fn detect_all(extra: &[String]) -> Vec<JavaInfo> {
    let mut found: Vec<JavaInfo> = Vec::new();
    for (p, src) in candidates(extra) {
        let key = p.to_string_lossy().to_lowercase();
        if found.iter().any(|f| f.path.to_lowercase() == key) {
            continue;
        }
        if let Some(info) = probe(&p, &src) {
            found.push(info);
        }
    }
    found.sort_by(|a, b| b.major.cmp(&a.major));
    found
}

/// 按版本要求挑一个最合适的 Java。
///
/// 原则：**不低于要求的主版本，且尽量接近** —— 用 Java 21 跑只要求 Java 8 的
/// 1.12.2 会让部分老 Forge 直接崩，所以「够用的最小那个」才是对的。
pub fn pick<'a>(list: &'a [JavaInfo], need_major: Option<u32>) -> Option<&'a JavaInfo> {
    let need = need_major.unwrap_or(8);
    let mut ok: Vec<&JavaInfo> = list.iter().filter(|j| j.major >= need).collect();
    ok.sort_by_key(|j| j.major);
    if let Some(best) = ok.first() {
        return Some(best);
    }
    // 没有达标的，退而求其次给最高版本，让游戏自己报错（比不启动更容易排查）
    list.first()
}
