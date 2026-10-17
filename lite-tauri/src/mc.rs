//! Minecraft 版本 JSON 的模型与解析。
//!
//! 覆盖两代格式：
//! - 1.13 之前：`minecraftArguments` 是一整条字符串模板，库一律进 classpath
//! - 1.13 起：`arguments.game` / `arguments.jvm` 是数组，元素可以带 `rules`
//!
//! 还有一类特殊版本 JSON：加载器（Forge / Fabric / NeoForge）生成的 `inheritsFrom`，
//! 它只写增量，真正的主类和参数要从父版本继承。Lite 版不装加载器，但玩家自己
//! 用别的启动器装好后会留下这种 JSON，所以必须能解析。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize, Clone)]
pub struct VersionJson {
    pub id: String,
    #[serde(rename = "type")]
    pub vtype: Option<String>,
    #[serde(rename = "mainClass")]
    pub main_class: Option<String>,
    pub assets: Option<String>,
    #[serde(rename = "assetIndex")]
    pub asset_index: Option<AssetIndex>,
    #[serde(default)]
    pub libraries: Vec<Library>,
    pub arguments: Option<Arguments>,
    #[serde(rename = "minecraftArguments")]
    pub minecraft_arguments: Option<String>,
    #[serde(rename = "javaVersion")]
    pub java_version: Option<JavaVersion>,
    #[serde(rename = "inheritsFrom")]
    pub inherits_from: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct AssetIndex {
    pub id: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct JavaVersion {
    #[serde(rename = "majorVersion")]
    pub major_version: Option<u32>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct Arguments {
    #[serde(default)]
    pub game: Vec<ArgValue>,
    #[serde(default)]
    pub jvm: Vec<ArgValue>,
}

/// 参数元素：要么是裸字符串，要么是带 rules 的条件块。
#[derive(Debug, Deserialize, Clone)]
#[serde(untagged)]
pub enum ArgValue {
    Plain(String),
    Cond {
        #[serde(default)]
        rules: Vec<Rule>,
        value: ValueOrList,
    },
}

#[derive(Debug, Deserialize, Clone)]
#[serde(untagged)]
pub enum ValueOrList {
    One(String),
    Many(Vec<String>),
}

impl ValueOrList {
    fn iter(&self) -> Box<dyn Iterator<Item = &String> + '_> {
        match self {
            ValueOrList::One(s) => Box::new(std::iter::once(s)),
            ValueOrList::Many(v) => Box::new(v.iter()),
        }
    }
}

#[derive(Debug, Deserialize, Clone)]
pub struct Library {
    pub name: String,
    pub downloads: Option<LibDownloads>,
    pub natives: Option<HashMap<String, String>>,
    #[serde(default)]
    pub rules: Vec<Rule>,
    pub url: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct LibDownloads {
    pub artifact: Option<Artifact>,
    #[serde(default)]
    pub classifiers: HashMap<String, Artifact>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct Artifact {
    pub path: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct Rule {
    pub action: String,
    pub os: Option<OsRule>,
    pub features: Option<HashMap<String, bool>>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct OsRule {
    pub name: Option<String>,
    pub version: Option<String>,
    pub arch: Option<String>,
}

/// 本机形态：Windows x64。
const OS_NAME: &str = "windows";
/// Windows 10 / 11 都报 10.x —— `os.version` 规则里写的基本都是 `^10\.`
const OS_VERSION: &str = "10.0";

/// 判定一组 rules 是否放行。
///
/// 语义按官方规范：**规则为空 = 放行**；否则从「拒绝」起步，
/// 逐条按序求值，命中的最后一条决定结果（后面的能覆盖前面的）。
pub fn rules_allow(rules: &[Rule]) -> bool {
    if rules.is_empty() {
        return true;
    }
    let mut allow = false;
    for r in rules {
        let mut hit = true;
        if let Some(os) = &r.os {
            if let Some(n) = &os.name {
                if n != OS_NAME {
                    hit = false;
                }
            }
            // "x86" 指 32 位 JVM，我们这个形态是 64 位
            if let Some(a) = &os.arch {
                if a != "x86_64" && a != "amd64" {
                    hit = false;
                }
            }
            if let Some(v) = &os.version {
                if !version_prefix_matches(v, OS_VERSION) {
                    hit = false;
                }
            }
        }
        // 简化：所有 feature 一律视为 false（不启用演示模式、自定义分辨率等）
        if let Some(f) = &r.features {
            if f.values().any(|want| *want) {
                hit = false;
            }
        }
        if hit {
            allow = r.action == "allow";
        }
    }
    allow
}

/// 只支持 `^10\.` 这类「前缀锚定」写法 —— 官方版本 JSON 里 `os.version` 只用到这种。
fn version_prefix_matches(pattern: &str, actual: &str) -> bool {
    let p = pattern.trim_start_matches('^').trim_end_matches('$');
    let p = p.trim_end_matches("\\.").trim_end_matches('\\').replace("\\.", ".");
    if p.is_empty() {
        return true;
    }
    actual.starts_with(p.trim_end_matches('.'))
}

/// 从 Maven 坐标推库文件相对路径。
/// `org.ow2.asm:asm:9.3` → `org/ow2/asm/asm/9.3/asm-9.3.jar`
pub fn maven_relpath(name: &str) -> Option<String> {
    let (coord, ext) = match name.split_once('@') {
        Some((c, e)) => (c, e),
        None => (name, "jar"),
    };
    let parts: Vec<&str> = coord.split(':').collect();
    if parts.len() < 3 {
        return None;
    }
    let (g, a, v) = (parts[0], parts[1], parts[2]);
    let file = match parts.get(3) {
        Some(c) => format!("{a}-{v}-{c}.{ext}"),
        None => format!("{a}-{v}.{ext}"),
    };
    Some(format!("{}/{}/{}/{}", g.replace('.', "/"), a, v, file))
}

/// 一个库在磁盘上的落点。
pub fn artifact_relpath(lib: &Library) -> Option<String> {
    if let Some(d) = &lib.downloads {
        if let Some(art) = &d.artifact {
            if let Some(p) = &art.path {
                return Some(p.clone());
            }
        }
    }
    maven_relpath(&lib.name)
}

/// 该库在当前平台上要不要进 classpath。
pub fn lib_applies(lib: &Library) -> bool {
    rules_allow(&lib.rules)
}

/// 当前进程的 CPU 架构标签，写法与版本 JSON 里 natives 分类器保持一致。
fn host_arch_tag() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else if cfg!(target_arch = "x86") {
        "x86"
    } else {
        "x64"
    }
}

/// 这个目录名看起来像架构标签吗（用于清理 `windows/arm64` 这类残留）。
fn is_arch_tag(s: &str) -> bool {
    matches!(s, "x64" | "arm64" | "x86" | "amd64" | "x86_64")
}

/// 分类器里的架构标签跟当前进程一致吗。
///
/// 这里有个必须防的坑：Mojang 的版本 JSON 给 `natives-windows-arm64` 写的 rules
/// **只有 `os.name == windows`，没有 `os.arch`**，所以 x64 和 arm64 两套 natives
/// 都能通过 rules 检查。官方启动器把两套都留在 classpath 上无所谓 ——
/// LWJGL/JNA/netty 运行时是按 `os.arch` 去挑 classpath 里的资源路径
/// （`windows/x64/...` vs `windows/arm64/...`），天然不会拿错。
///
/// 但本启动器会**预先把 DLL 解包成扁平目录**（见 `extract_natives` 的说明）。
/// 两套 DLL 文件名完全一样，扁平之后就是互相覆盖 —— 谁后写谁赢。
/// 靠列表顺序侥幸赢一次不能算实现正确，所以这里直接按架构过滤掉。
fn classifier_arch_ok(cls: &str) -> bool {
    let host = host_arch_tag();
    for tok in cls.split('-') {
        match tok {
            "arm64" => return host == "arm64",
            "x86" => return host == "x86",
            "x64" | "amd64" | "x86_64" => return host == "x64",
            // 不带架构后缀的 `natives-windows` 是通用包，放行
            _ => {}
        }
    }
    true
}

/// 取出库名里的 natives 分类器，**不看架构**。
fn natives_classifier_any(lib: &Library) -> Option<String> {
    let coord = lib.name.split('@').next().unwrap_or(&lib.name);
    let parts: Vec<&str> = coord.split(':').collect();
    let cls = *parts.get(3)?;
    if cls.starts_with("natives-windows") {
        Some(cls.to_string())
    } else {
        None
    }
}

/// 新版版本 JSON（1.19 起）不再写 `natives` 映射，而是把 natives jar 当成普通库列出来，
/// 靠名字里的 `:natives-windows` 分类器区分。这类库**既要在 classpath 上**
/// （LWJGL 3 会从 classpath 里自解压 DLL），**又要解包**到 natives 目录。
/// 架构不符的那一套直接返回 None，classpath 和解包都不要它。
pub fn natives_classifier_in_name(lib: &Library) -> Option<String> {
    let cls = natives_classifier_any(lib)?;
    if classifier_arch_ok(&cls) {
        Some(cls)
    } else {
        None
    }
}

/// 这条库是 natives，但架构跟本机不符 —— 整条跳过。
pub fn natives_host_mismatch(lib: &Library) -> bool {
    match natives_classifier_any(lib) {
        Some(cls) => !classifier_arch_ok(&cls),
        None => false,
    }
}

/// 这条库是不是 natives（新旧两种写法都算）。
pub fn is_natives_lib(lib: &Library) -> bool {
    lib.natives.is_some() || natives_classifier_in_name(lib).is_some()
}

/// 该库在当前平台要解包哪个 natives 分类器（返回分类器名，如 `natives-windows`）。
pub fn native_classifier(lib: &Library) -> Option<String> {
    let nat = lib.natives.as_ref()?;
    let key = nat.get("windows")?;
    // 老写法用 `${arch}` 占位，官方只认 32/64 两种
    let arch = match host_arch_tag() {
        "x86" => "32",
        _ => "64",
    };
    Some(key.replace("${arch}", arch))
}

/// natives jar 的相对路径。
pub fn native_relpath(lib: &Library, classifier: &str) -> Option<String> {
    if let Some(d) = &lib.downloads {
        if let Some(art) = d.classifiers.get(classifier) {
            if let Some(p) = &art.path {
                return Some(p.clone());
            }
        }
    }
    // 老版本 JSON 里 natives 没有 downloads.classifiers，按坐标 + 分类器推
    let coord = lib.name.split('@').next().unwrap_or(&lib.name).to_string();
    maven_relpath(&format!("{coord}:{classifier}"))
}

/// 展开参数数组，把 rule 命中的值拍平成一维列表，并替换占位符。
pub fn flatten_args(args: &[ArgValue], vars: &HashMap<&str, String>) -> Vec<String> {
    let mut out = Vec::new();
    for a in args {
        match a {
            ArgValue::Plain(s) => out.push(subst(s, vars)),
            ArgValue::Cond { rules, value } => {
                if rules_allow(rules) {
                    for s in value.iter() {
                        out.push(subst(s, vars));
                    }
                }
            }
        }
    }
    out
}

/// 替换 `${...}` 占位符。`$${` 是官方规范里的转义写法，要还原成字面 `${`。
pub fn subst(s: &str, vars: &HashMap<&str, String>) -> String {
    if !s.contains('$') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let bytes: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == '$' && i + 1 < bytes.len() && bytes[i + 1] == '$' && i + 2 < bytes.len() && bytes[i + 2] == '{' {
            out.push_str("${");
            i += 3;
            continue;
        }
        if bytes[i] == '$' && i + 1 < bytes.len() && bytes[i + 1] == '{' {
            if let Some(end) = bytes[i + 2..].iter().position(|c| *c == '}') {
                let key: String = bytes[i + 2..i + 2 + end].iter().collect();
                if let Some(v) = vars.get(key.as_str()) {
                    out.push_str(v);
                } else {
                    // 未识别的占位符原样保留，方便排查
                    out.push_str(&format!("${{{key}}}"));
                }
                i += 2 + end + 1;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

/// 把字符串按空白切成参数（只给 `minecraftArguments` 用）。
pub fn split_legacy_args(s: &str) -> Vec<String> {
    s.split_whitespace().map(|x| x.to_string()).collect()
}

/// 离线模式的 UUID 算法：`UUID.nameUUIDFromBytes("OfflinePlayer:<name>")`，即 MD5 变体 3。
pub fn offline_uuid(name: &str) -> String {
    let digest = md5::compute(format!("OfflinePlayer:{name}").as_bytes());
    let mut b = digest.0;
    b[6] = (b[6] & 0x0f) | 0x30; // version 3
    b[8] = (b[8] & 0x3f) | 0x80; // variant IETF
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// 一个版本目录的描述，给前端列表用。
///
/// `rename_all = "camelCase"`：返回值不会像入参那样被 Tauri 自动转命名，
/// 不写这个前端拿到的是 `java_major`，而 JS 里读的是 `javaMajor`。
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VersionEntry {
    pub id: String,
    #[serde(rename = "type")]
    pub vtype: String,
    pub dir: String,
    pub inherits: Option<String>,
    pub java_major: Option<u32>,
    pub jar_size: u64,
    /// 解析失败时的原因；有值时前端会把这行标红
    pub error: Option<String>,
}

/// 扫 `versions/<id>/<id>.json`。
pub fn scan_versions(mc_dir: &Path) -> Vec<VersionEntry> {
    let root = mc_dir.join("versions");
    let mut out = Vec::new();
    let rd = match std::fs::read_dir(&root) {
        Ok(r) => r,
        Err(_) => return out,
    };
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let name = match p.file_name().and_then(|x| x.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let json = p.join(format!("{name}.json"));
        if !json.exists() {
            continue;
        }
        match read_version(&json) {
            Ok((vj, _, _)) => {
                let jar = p.join(format!("{name}.jar"));
                out.push(VersionEntry {
                    id: vj.id.clone(),
                    vtype: vj.vtype.clone().unwrap_or_else(|| "release".into()),
                    dir: p.to_string_lossy().to_string(),
                    inherits: vj.inherits_from.clone(),
                    java_major: vj.java_version.as_ref().and_then(|j| j.major_version),
                    jar_size: std::fs::metadata(&jar).map(|m| m.len()).unwrap_or(0),
                    error: None,
                });
            }
            Err(err) => out.push(VersionEntry {
                id: name,
                vtype: "broken".into(),
                dir: p.to_string_lossy().to_string(),
                inherits: None,
                java_major: None,
                jar_size: 0,
                error: Some(err),
            }),
        }
    }
    out.sort_by(|a, b| b.id.cmp(&a.id));
    out
}

/// 读版本 JSON，若带 `inheritsFrom` 则向上合并父版本。
/// 返回 (合并后的版本 JSON, 版本目录, 父链上的版本目录列表)
pub fn read_version(json_path: &Path) -> Result<(VersionJson, PathBuf, Vec<PathBuf>), String> {
    let text = std::fs::read_to_string(json_path).map_err(|e| format!("读取失败: {e}"))?;
    let mut vj: VersionJson =
        serde_json::from_str(&text).map_err(|e| format!("JSON 解析失败: {e}"))?;
    let dir = json_path
        .parent()
        .ok_or_else(|| "路径异常".to_string())?
        .to_path_buf();

    let mut chain = Vec::new();
    let mut guard = 0;
    while let Some(parent_id) = vj.inherits_from.clone() {
        guard += 1;
        if guard > 8 {
            return Err("继承链过深（可能成环）".into());
        }
        // 父版本就在同级 versions/ 里
        let versions_root = dir.parent().ok_or("路径异常")?;
        let pdir = versions_root.join(&parent_id);
        let pjson = pdir.join(format!("{parent_id}.json"));
        if !pjson.exists() {
            return Err(format!("缺少父版本 {parent_id}"));
        }
        let ptext = std::fs::read_to_string(&pjson).map_err(|e| format!("父版本读取失败: {e}"))?;
        let pvj: VersionJson =
            serde_json::from_str(&ptext).map_err(|e| format!("父版本 JSON 解析失败: {e}"))?;

        // 合并：父在前，子的非空字段覆盖
        vj = merge(pvj.clone(), vj.clone());
        chain.push(pdir);
        if pvj.inherits_from.is_none() {
            break;
        }
    }
    Ok((vj, dir, chain))
}

/// 子的非空字段覆盖父。
fn merge(mut parent: VersionJson, child: VersionJson) -> VersionJson {
    if child.main_class.is_some() {
        parent.main_class = child.main_class;
        parent.id = child.id;
        parent.vtype = child.vtype;
    }
    if !child.libraries.is_empty() {
        // 加载器会在自己的 JSON 里**重列**同名库以覆盖版本，这里就近覆盖：
        // 先按 name 去重（子的覆盖父的），再落进父的列表
        let child_names: Vec<String> = child.libraries.iter().map(|l| key_of(&l.name)).collect();
        let mut merged: Vec<Library> = child.libraries.clone();
        for l in parent.libraries.iter() {
            if !child_names.contains(&key_of(&l.name)) {
                merged.push(l.clone());
            }
        }
        parent.libraries = merged;
    }
    if let Some(mut a) = child.arguments {
        // 加载器的 `arguments` 是**增量**：Forge 那边只写 `--launchTarget forge_client`
        // 和三条 -D 开关，其余（含 `-cp ${classpath}`）全在父版本里。
        // 这里必须拼接而不是替换 —— 替换会让 classpath 整个丢掉，游戏连主类都找不到。
        match parent.arguments.take() {
            Some(mut p) => {
                p.jvm.append(&mut a.jvm);
                p.game.append(&mut a.game);
                parent.arguments = Some(p);
            }
            None => parent.arguments = Some(a),
        }
    }
    if child.minecraft_arguments.is_some() {
        parent.minecraft_arguments = child.minecraft_arguments;
    }
    if child.assets.is_some() {
        parent.assets = child.assets;
    }
    if child.asset_index.is_some() {
        parent.asset_index = child.asset_index;
    }
    if child.java_version.is_some() {
        parent.java_version = child.java_version;
    }
    parent
}

/// 库去重用的键：坐标去掉版本号，让加载器的覆盖能生效。
fn key_of(name: &str) -> String {
    let coord = name.split('@').next().unwrap_or(name);
    let parts: Vec<&str> = coord.split(':').collect();
    if parts.len() >= 2 {
        format!("{}:{}", parts[0], parts[1])
    } else {
        coord.to_string()
    }
}

/// 清掉上一次运行留下的、非本机架构的 natives 子目录（`windows/arm64` 之类）。
///
/// 为什么需要：早期实现没按架构过滤（Mojang 的 rules 也不按架构过滤），
/// 解出来过一份 arm64 的 DLL 树。那些残留在扁平子目录里可能压过正确架构的同名
/// DLL，而且因为是「文件已存在就跳过」的写法，不主动清就永远留着。
fn prune_foreign_arch(dest: &Path) {
    let host = host_arch_tag();
    for os in ["windows", "macos", "linux"] {
        let d = dest.join(os);
        if !d.is_dir() {
            continue;
        }
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            if !e.path().is_dir() {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if is_arch_tag(&name) && name != host {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
}

/// 把 natives jar 解到目标目录。
///
/// 三个要点，都不是教科书上写的：
/// 1. **保留 jar 内部路径**。新版的 natives jar 里是
///    `windows/x64/org/lwjgl/freetype/freetype.dll`，拍平了反而对不上。
/// 2. **再往 4 个约定子目录里各拷一份**。新版版本 JSON 的 JVM 参数写的是
///    `-Djava.library.path=${natives_directory}/java`、`-Djna.tmpdir=…/jna`、
///    `-Dorg.lwjgl.system.SharedLibraryExtractPath=…/lwjgl`、
///    `-Dio.netty.native.workdir=…/netty`；老版本写的是不带子目录的
///    `${natives_directory}`。两套都铺上，哪种都对得上，反正这些 DLL 一共才几 MB。
/// 3. **按大小判断要不要重写**。只判断「文件在不在」会留下换架构/换版本之前的旧
///    DLL；每次无条件重写又白拷几 MB。比对体积是最便宜的折中。
pub fn extract_natives(jars: &[PathBuf], dest: &Path) -> Result<usize, String> {
    const SUBS: [&str; 4] = ["java", "jna", "lwjgl", "netty"];
    std::fs::create_dir_all(dest).map_err(|e| format!("建 natives 目录失败: {e}"))?;
    for s in SUBS {
        let _ = std::fs::create_dir_all(dest.join(s));
    }
    prune_foreign_arch(dest);

    let mut dlls: Vec<(PathBuf, u64)> = Vec::new();
    let mut n = 0usize;

    for jar in jars {
        if !jar.exists() {
            continue;
        }
        let f = std::fs::File::open(jar).map_err(|e| format!("打开 {} 失败: {e}", jar.display()))?;
        let mut zf =
            zip::ZipArchive::new(f).map_err(|e| format!("解析 {} 失败: {e}", jar.display()))?;
        for i in 0..zf.len() {
            let mut entry = match zf.by_index(i) {
                Ok(x) => x,
                Err(_) => continue,
            };
            if entry.is_dir() {
                continue;
            }
            let rel = entry.name().to_string();
            // 签名信息和校验和不是要跑的东西
            if rel.starts_with("META-INF/") || rel.ends_with(".sha1") || rel.ends_with(".git") {
                continue;
            }
            let lower = rel.to_lowercase();
            let is_lib = lower.ends_with(".dll")
                || lower.ends_with(".so")
                || lower.ends_with(".dylib");
            if !is_lib {
                continue;
            }
            let out = dest.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            // `entry.size()` 是解压后的大小。对得上就认为内容一致，
            // 直接跳过解压 + 写盘 —— 每次启动能省掉好几 MB 的磁盘写。
            let want = entry.size();
            if let Ok(m) = std::fs::metadata(&out) {
                if m.len() == want {
                    dlls.push((out, want));
                    n += 1;
                    continue;
                }
            }
            if let Some(p) = out.parent() {
                let _ = std::fs::create_dir_all(p);
            }
            let mut buf = Vec::new();
            if std::io::Read::read_to_end(&mut entry, &mut buf).is_err() {
                continue;
            }
            if std::fs::write(&out, &buf).is_ok() {
                dlls.push((out, want));
                n += 1;
            }
        }
    }

    // 铺到约定子目录。体积一致就跳过；不一致（换架构、换版本的旧文件）才重写。
    for (d, want) in &dlls {
        let Some(fname) = d.file_name() else { continue };
        for s in SUBS {
            let target = dest.join(s).join(fname);
            let need = match std::fs::metadata(&target) {
                Ok(m) => m.len() != *want,
                Err(_) => true,
            };
            if need {
                let _ = std::fs::copy(d, &target);
            }
        }
    }

    Ok(n)
}
