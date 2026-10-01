# 代码签名

## 为什么需要

Windows 11 的 **智能应用控制（Smart App Control, SAC）** 会拦截未签名的程序，而且
**没有任何「仍要运行」的绕过入口** —— 双击即拒，弹出框里只有「确定」和「从 Microsoft Store 获取应用」。

它和 SmartScreen 不是一回事：

| | SmartScreen | Smart App Control |
|---|---|---|
| 触发条件 | 文件带「来自 Internet」标记（MOTW） | 无签名 / 签名不可信 / 信誉不足 |
| 能否绕过 | 能，点「更多信息 → 仍要运行」 | **不能**，一个按钮都没有 |
| 关闭后 | 可随时重开 | **关掉就回不去**，除非重置或重装系统 |

SAC 的判定依据（本机 CodeIntegrity 事件日志里的原始字段）：

```
DefenderTrust          = 0xFF000000   ← 不可信
IsUnfriendlyFile       = false        ← 并不是被判定为恶意软件
DefenderCloudHTTPCode  = 0xc8000000   ← 云信誉查询没拿到结论
DefenderCalled         = true
```

也就是说：**它不是觉得你的程序坏，而是「查不到你的信誉，又没有可信签名」，所以拒了。**
微软官方口径很明确 —— 这种情况下要放行，只能靠**受信任 CA 签发的代码签名证书**。

## 本机实测结论（2026-09-27 → 2026-10-01 修正）

**自签名开发证书无法稳定通过 SAC。** 9/27 当时 SAC 处于 Evaluation（评估）阶段、放行较松，
装了 `CurrentUser\Root`+`TrustedPublisher` 后看似能装能跑；但事件日志里 9/27 14:36 与 10/1 14:20
**都明确出现 `3118 Smart App Control Block`**。根因：SAC 走内核级 CI 信任（系统受信任根 + 微软云信誉），
`CurrentUser` 里的自签名根**不被 SAC 认可**，且自签名证书没有任何云信誉。结论：**重签名没用**，
分发要过 SAC 必须上真正受信任的 CA（买 OV，或开源走 SignPath）。

> **内外层都会被拦**：`make-exe.js` 先签 win-unpacked 再打包，所以内层 `dist/win-unpacked/Pebble Lunchar.exe`
> **也是自签名**（不是未签名），SAC 同样拦；"绿色版 zip 免拦 / 内层免拦"不成立——SAC 拦的是任何不满足
> 「受信任 CA 链 + 云信誉」的可执行文件，与是否 zip、是否带 MOTW 无关。本机调试要么关 SAC，要么上真证书。

验证方式：`scripts/sac-probe.ps1` 走 `explorer.exe` 启动（等价双击），
再用 `Microsoft-Windows-CodeIntegrity/Operational` 事件日志对签名前后做 A/B。

## 三条路

### 1. 自签名开发证书（免费，仅本机 / 内测）

```bash
npm run devcert            # 生成证书 + 信任到「当前用户」
npm run devcert:status     # 看状态
npm run sign:dev           # 用这张证书签 dist 产物
```

**只对「手动装过这张根证书的机器」有效**，对普通用户无效。适合：自己开发调试、
发给愿意配合的测试者（把 `.signing/dev-cert.cer` 一并发过去）。

微软官方口径是自签名**不满足** SAC 的信任要求（它只认根证书在
Microsoft Trusted Root Program 里的 CA）。**实测已确认自签名过不了 SAC**：
SAC 处于 Evaluation（评估）阶段时放行较松，看似能用；转 ON（强制）后一律拦
（本机 9/27 14:36 与 10/1 14:20 事件日志均有 `3118 Smart App Control Block`）。
所以自签名**只适合本机开发调试**（配合临时关闭 SAC），**不要用于分发**。

**需要管理员的那一步**：SAC 走内核代码完整性校验，真正生效的是「本机」信任存储。
如果 `npm run sac` 显示仍被拦，用**管理员** PowerShell 再跑一次：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev-cert.ps1 -Machine
```

### 2. 买证书（发行唯一正解）

必须是**根证书在 Microsoft Trusted Root Program 里**的 CA 签发。2026 年国内可买到的价位：

| 品牌 | 类型 | 参考价（元/年） | 说明 |
|---|---|---|---|
| Certum | OV | **约 500–1200** | 性价比最高，**支持云签名**（不用等 UKey 邮寄） |
| GlobalSign | OV | 约 1800–2800 | 老牌，国内寄 UKey |
| Sectigo (Comodo) | OV | 约 3200 | 签发量大 |
| DigiCert | OV | 约 2000–4400 | 兼容性标杆 |
| Certum | EV | 约 1150–1600 | 硬件令牌存私钥 |

- **SAC / SmartScreen 只要求「受信任 CA 签发」，不强制 EV**，所以 OV 够用。
- 2023-06 起 CA/B 规范要求 OV 私钥必须存在**硬件令牌或云 HSM** 里。选**支持云签名**的
  省事（不用等国际物流寄 UKey，CI 里也能直接签）。
- 材料：个人需身份证 + 地址证明；企业需营业执照 + 法人身份证。审核 1–3 个工作日。
- 落地后用法：`npm run sign -- --pfx 证书.pfx --password 密码`，或把证书装进存储后用
  `--thumbprint <SHA1>`（硬件令牌场景）。

### 3. SignPath Foundation（开源项目免费）✅ 推荐走这条

`https://signpath.org` —— 给符合条件（OSI 认可开源协议 + 公开仓库 + 活跃维护 + 已发布）的开源项目
免费签发 **OV 级**证书（证书主体是 SignPath Foundation，私钥在他们 HSM 上）。SignPath 是知名发行方、
其证书有现成信誉，**分发时 SAC / SmartScreen 都能放行**，比个人新买的 OV 更稳。

**硬性前提（缺一不可）**：
- 公开仓库（GitHub/GitLab 等）+ **OSI 许可证**，且不能有私有/双授权/专有组件
- 项目已发布（你有构建产物，满足）
- 下载页/商店页有功能说明
- 每次签名请求都要**人工点一次批准**（OSS 条款强制）
- 下载页必须带合规声明：*"Free code signing provided by SignPath.io, certificate by SignPath Foundation"*，
  并写明 Authors / Reviewers / Approvers

**申请与接入步骤**：
1. 把仓库公开，加 OSI 许可证（本项目已加 `LICENSE`，MIT）
2. 去 signpath.org 申请，等审核（几天到几周）
3. 后台建项目，建**签名策略**（`signingPolicySlug`）和**构件配置**（`artifactConfigurationSlug`，
   类型选 **Zip**，配置「对全部 `.exe` / `.dll` 签名」——因为要一次签内层 6 个文件 + 外层安装包）
4. 拿到 **API token**（CI 用户）和 **organizationId**
5. 本地用环境变量喂给打包流程：
   ```bash
   set SIGNPATH=1
   set SIGNPATH_API_TOKEN=xxxx
   set SIGNPATH_ORG_ID=yyyy
   set SIGNPATH_PROJECT_SLUG=pebble-lunchar
   set SIGNPATH_POLICY_SLUG=release-signing
   set SIGNPATH_ARTIFACT_CONFIG_SLUG=zip-authenticode   # 可选，不填用项目默认
   npm run dist        # make-exe.js 检测到 SIGNPATH=1 会自动走 SignPath，不再本地自签名
   ```
   背后做的事（`scripts/signpath-sign.js`，纯 Node 实现，无需额外依赖）：
   - 把 `win-unpacked` 打成 zip → 提交 `SigningRequests/SubmitWithArtifact` → 轮询状态
     （卡在 `WaitingForApproval` 时去后台点 Approve）→ 下载签名后的 zip 解压覆盖
   - 再把外层 `Pebble-Lunchar.exe` 打成 zip → 同样流程签一遍
6. 想看脚本干到哪一步：`node scripts/signpath-sign.js` 会打印提交 / 状态 / 下载全过程

**在 GitHub Actions 里自动签（推荐）** —— 仓库已含 `.github/workflows/release.yml`：
打一个 `v*` tag（或手动触发 workflow）就会自动「构建 → 打包 → SignPath 签名 → 发布 Release」。

需要在仓库 **Settings → Secrets and variables → Actions** 里配这几个 Secret：

| Secret 名 | 值 |
|---|---|
| `SIGNPATH_API_TOKEN` | SignPath 后台签发的 API token（CI 用户） |
| `SIGNPATH_ORG_ID` | 你的 organizationId |
| `SIGNPATH_PROJECT_SLUG` | 项目 slug（如 `pebble-lunchar`） |
| `SIGNPATH_POLICY_SLUG` | 签名策略 slug（如 `release-signing`） |
| `SIGNPATH_ARTIFACT_CONFIG_SLUG` | 构件配置 slug（可选，不填用项目默认） |

> ⚠️ 工作流里 `SKIP_SIGN=1` + `SIGNPATH=1`：跳过本地自签名，只走 SignPath，
> 避免最终产物被自签名"污染"（自签名对分发是负作用）。
> ⚠️ SignPath OSS 每次签名都要**人工批准**，CI 会轮询等待（最长 30 分钟）——
> 触发后请尽快去 SignPath 后台 Signing Requests 点 **Approve**，否则该步会超时失败。

> 注意：SignPath 给的是 **OV（非 EV）**。对 SAC 来说 OV 需要信誉，但 SignPath Foundation 本身是被
> 广泛使用的发行方，其证书通常已有足够信誉；若极早期个别机器仍报，多分发几次、积累信誉后即稳定。
> 这与自签名有本质区别——自签名在任何机器都过不了 SAC，SignPath 是受信任 CA 链。

### 4. ~~Azure 工件签名（原 Trusted Signing）~~

$9.99/月、免硬件令牌，看起来很合适 —— **但个人开发者仅限美国和加拿大，组织限美/加/欧/英，
中国大陆主体不可用**。不用考虑了。

## 用法

```bash
# 签名（证书来源按优先级自动探测：--pfx → --thumbprint → --dev → 环境变量 → 开发证书）
npm run sign                      # 自动探测；没证书就打印指引并跳过（不阻塞打包）
npm run sign -- --pfx my.pfx --password ***
npm run sign -- --thumbprint A1B2C3...   # 证书在存储里（USB 令牌 / 云 HSM）
npm run sign -- --dry                    # 只看计划不签
npm run sign -- --force                  # 已有签名的也重签
```

环境变量也可以：`SIGN_PFX` / `SIGN_PFX_PASSWORD` / `SIGN_THUMBPRINT` /
`SIGN_TIMESTAMP_URL` / `SIGNTOOL`。

### 打包时会自动签

`npm run dist`（= `node make-exe.js`）内部已经接好，顺序是**刻意设计**的：

```
① 签 dist/win-unpacked 里的 exe/dll
        ↓
② makensis 把它们打进安装包
        ↓
③ 签外层 dist/Pebble-Lunchar.exe
```

`①` 必须在 `②` 之前 —— 否则打进安装包的是未签名副本。跳过签名用 `SKIP_SIGN=1`。

### 检测某个产物会不会被拦

```bash
npm run sac                        # 默认测 dist/Pebble-Lunchar.exe
npm run sac -- -Target "路径\xxx.exe" -WaitSec 60
```

它会：打印签名状态 → 用资源管理器启动（等价双击）→ 等一会儿 → 查 CodeIntegrity
新增拦截事件 → 给判定。**等待时间给足**，259 MB 的包解压要近一分钟，等太短会误判成「没反应」。

## 会一并签名的文件

打包产物里有 7 个 exe/dll，其中 `d3dcompiler_47.dll` 是微软签的（跳过），
剩下 6 个都需要签：

```
Pebble Lunchar.exe        ← 我们的应用主体
ffmpeg.dll                ← Electron 官方发布，本来就是未签名的
libEGL.dll                ← 同上
libGLESv2.dll             ← 同上
vk_swiftshader.dll        ← 同上
vulkan-1.dll              ← 同上
```

> 这不是我们打包打错了 —— **Electron 官方发布的 electron.exe 和这几个 dll 本身就是未签名的**
> （已在本机 `node_modules/electron/dist` 里实测确认）。所以任何 Electron 应用要过 SAC，
> 都得把这些一起签掉。签名工具默认就会处理，不用手动挑。

## 坑

| 现象 | 原因与处理 |
|---|---|
| `SignTool Error: The file is being used by another process.` | 程序正在运行，文件被锁。**打包前先退出启动器和已安装的副本** |
| `spawnSync ... EBUSY` | 受限环境拒绝为子进程建 stdin 管道。`stdio` 必须显式写成 `['ignore','pipe','pipe']` |
| `字典中已添加了相同的键: 'HTTP_PROXY'` | 环境块里有只有大小写不同的重复变量（`PATH`/`Path`）。用 `Start-Process -RedirectStandardOutput` 会踩到；改用退出码 / 事件日志判断 |
| 时间戳失败 | `sign.js` 会依次回退 digicert → sectigo → globalsign → starfield；全失败则降级为不带时间戳（能签，但证书过期后签名会失效） |
| `.ps1` 里的中文变成乱码导致解析失败 | Windows PowerShell 5.1 按 ANSI 读 `.ps1`，**必须带 UTF-8 BOM**。用编辑器另存时要选「UTF-8 with BOM」 |
| `exit` 让整个终端退出 | 在会话里用 `& script.ps1` 跑脚本时，脚本内的 `exit` 会连宿主会话一起结束。要单独跑用 `powershell -File` |

## 换证书时要改什么

基本不用改代码 —— 证书来源是运行期探测的。只有两种特殊情况：

- **换 Azure 工件签名**：需要 `dotnet tool install -g --prerelease sign`，
  并设 `SIGN_AZURE_ENDPOINT` / `SIGN_AZURE_ACCOUNT` / `SIGN_AZURE_PROFILE` 三个变量。
- **想在 CI 里签**：把 PFX 以 base64 放进 secret，或把云签名服务的凭据配成环境变量。
  注意 `scripts/sign.js` 不依赖任何 npm 包，CI 里只要有 node + signtool 就能跑。
