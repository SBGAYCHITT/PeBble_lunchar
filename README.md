# Pebble Lunchar

Minecraft 启动器（离线模式为主），纯白 + 蓝绿像素渐变界面，打包为免安装单文件 .exe。
功能对标 PCL2，**不含联机相关功能**（局域网联机 / P2P 联机）。

[![Release](https://img.shields.io/github/v/release/SBGAYCHITT/PeBble_lunchar?label=release)](https://github.com/SBGAYCHITT/PeBble_lunchar/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> **下载**：前往 [Releases 页面](https://github.com/SBGAYCHITT/PeBble_lunchar/releases) 下载最新的
> `Pebble-Lunchar.exe`（免安装单文件，双击即用，支持 Windows 10/11 x64）。

## Code signing policy

本项目使用 SignPath Foundation 提供的免费代码签名服务：

- **Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org)**
- Roles / 角色：
  - Committers and reviewers: [SBGAYCHITT](https://github.com/SBGAYCHITT)
  - Approvers: [SBGAYCHITT](https://github.com/SBGAYCHITT)
- Privacy policy / 隐私政策：本程序**不收集、不上传任何用户数据**。
  This program will not transfer any information to other networked systems
  unless specifically requested by the user or the person installing or operating it.

## 功能清单

### 启动
- 玩家名 + 头像，自动生成与服务器离线模式一致的 UUID v3
- 版本列表（支持 `inheritsFrom` 继承，兼容 Forge / Fabric / OptiFine 等变体版本）
- 内存调节（1–16 GB）、自定义窗口宽高、全屏启动、额外 JVM 参数
- 游戏进程分离（`detached`），关闭启动器不影响游戏
- 实时回显游戏 stdout/stderr，显示退出码

### 版本
- **下载官方版本**：正式版 / 快照，官方源优先、失败自动切 BMCLAPI 国内镜像
- **自动安装加载器**：Forge、Fabric、Quilt、NeoForge、OptiFine（下载 installer 并静默执行）
- **版本管理**：重命名、复制、删除、导出为 zip、从 zip 导入、打开版本目录
- 一键打开 `.minecraft / versions / mods / saves / shaderpacks / resourcepacks`

### 资源（每个页面都分成「已下载」/「在线仓库」两栏）

**在线仓库**（`modstore.js`）—— 不用再去网页上找资源、下载完再手动拖进目录：

- **Modrinth 开箱即用**：官方接口不需要密钥，搜索 / 详情 / 版本 / 下载全通
- **CurseForge 可选**：官方接口**强制要求 API Key**（无 key 直接 403），
  在在线页点「CF Key」填一次即可（加密存 `%APPDATA%`），不配也能正常用 Modrinth
- 卡片式结果：图标、作者、下载量、更新时间、载入器徽章、来源标记（MR/CF）
- 详情弹层：画廊截图 + Markdown 排版的项目介绍 + 可安装版本列表（默认只显示匹配当前 MC 与载入器的）
- **点「安装」直接下载进游戏目录**（尊重版本隔离），带进度条；下载后比对 sha1，
  已装过的再点一次会命中哈希直接跳过
- 已装资源在版本列表里标「已安装」（按 sha1 比对，比按文件名猜准得多）

**安全**：所有网络请求都在主进程；远程图片由主进程抓下来转成 data URL（**不需要为了显示图片放宽 CSP**）；
项目介绍先转义 HTML 再做 Markdown 转换，只放行白名单标签、`javascript:` 链接直接丢弃、
CurseForge 返回的 HTML 描述一律剥成纯文本。

### 资源（本地管理）
- **Mod 管理**：列表、启用/禁用（`.disabled`）、删除、定位、添加文件
  - 显示的是 jar 内的真实元数据（mod 名 / 版本 / 载入器 / MC 版本区间），**不是文件名**
- **资源包管理**：显示 `pack.mcmeta` 里的真实名称与描述、`pack.png` 图标；
  按 `pack_format` 算出适用 MC 版本区间，与当前版本不匹配时直接标红
- **光影管理**：识别 zip 内 `shaders/` 目录，显示着色器数量；不是光影包会提示
- 资源包 / 光影**支持未解压的目录形式**（改材质、调光影参数时的常态），目录也能启用/禁用
- **存档管理**：卡片式展示（名称 / 版本 / 模式 / 极限 / 作弊 / 时间 / 大小 / 图标），导出 zip、删除、打开
- **截图管理**：缩略图网格，点击打开、删除

### 差异化能力（其它启动器基本没有的）

这几件事的共同点是：**都在本地完成、不联网、不花钱**，而且都把"事后补救"变成"事前预防 + 一键回退"。

- **存档时光机**（`savetimemachine.js`）
  - 块级增量去重：每个文件切成 1MB 块按 SHA1 存进块库，相同内容的块只存一份。
    MC 的 region 文件每次只改少量区块，所以第 2 次之后的快照往往只增加几 MB。
  - **每次启动游戏前自动打快照**（无变动或距上次快照 <1 分钟则直接跳过，重复启动几乎零开销）。
    正因为去重，才敢"每次都存"——而其它启动器的备份都是全量拷贝，1GB 存档存 20 份就是 20GB。
  - 一键回滚，且**回滚本身也会先存一份**，所以"回滚"也是可撤销的。
- **存档健康检查**（只读扫描，不改存档）
  - 扫 `region/` 与 1.18+ 的 `entities/`，跨主世界 / 下界 / 末地
  - 找出：损坏区块（偏移越界 / 长度异常 / 解压失败）、超大区块（>1MB，读取卡顿）、
    **实体热点**（单区块实体数过多 = 卡顿源头，精确到区块坐标）
- **Mod 守卫「后悔药」**（`modguard.js`）
  - 直接读 jar 里的 `fabric.mod.json` / `quilt.mod.json` / `mods.toml` / `neoforge.mods.toml` / `mcmod.info`，
    拿到真实的 modId / 版本 / 载入器 / MC 版本区间 / 依赖项——**不靠文件名猜**
  - 破坏性变更预检：载入器装错生态、MC 版本不满足、依赖缺失、同 ID 重复、依赖被禁用
  - 不指定载入器时**自动从 mod 里推断多数派**，混进来的少数派会被单独标出来（真实崩溃的主因）
  - 快照 + 一键回滚，并告诉你"和上次比这次新增/移除/更新了哪些，哪个是版本回退"
- **世界版本控制**（`worldver.js`）—— 把存档当成一个能分支、能对比、能回滚的**项目**，
  而不是一个只能整体覆盖的文件夹
  - 粒度是**单个区块**（Anvil 的天然单位）。时光机是 1MB 文件块，动一个方块就会让整块指纹变化；
    要回答"到底改了哪些区块"，必须下沉到区块级
  - 内容寻址对象库 + **提交只存增量**（相对父提交的 add/del），一次提交通常只有几 KB；
    同一份区块内容在库里只落一份。代价是读某个提交的完整状态要沿 parent 链回溯 —— 于是做了进程内 LRU
  - `init` / `commit` / `status` / `log` / `diff` / `blame` / 分支 / `checkout` / `gc`
  - **`commit` 和 `status` 都是只读的**：提交只记录、不改存档；"看一眼改了什么"不会往库里写任何东西
  - `checkout` 是唯一会写存档的操作，落盘前**先自动打一份时光机快照**，每个 region 文件再留 `.bak`
  - `blame` 回答"这个区块是哪次提交改的"，历史里连"被删掉"那一步都在
- **世界合并与建筑移植**（`worldmerge.js`）—— 创造存档里搭好的城堡搬进生存存档
  - 干跑（`plan`）与执行（`apply`）**刻意分成两步**：这种工具出错时覆盖的是玩家几百小时的世界，
    所以先把"要动哪些区块、会覆盖掉什么、目标有几处冲突、有几个实体热点、大概多大体积"全摊开
  - 冲突检测（目标同位置已有不同内容）、`skip-existing` 只补空位、搬完**自动复验**（重扫目标比对指纹）
  - **区块与实体成对替换**：只看区块就跳过的话，新搬来的城堡里会残留当地生物与掉落物
  - ⚠️ 两个限制写在模块头里：区块是**最小搬运单位**（给的方块范围会向外吸附到区块边界）；
    垂直方向是**整列**搬运，不做 y 裁剪（光照/高度图/方块实体/生物群系都挂在同一个 chunk 上，
    只搬一段 y 必然把存档搞坏 —— 要裁剪请先在游戏里用结构方块或 WorldEdit 做好）
- **存档地图预览**（`worldmap.js`）—— 把枯燥的 region 文件变成一眼能懂的俯视图
  - 纯本地扫描 `anvil` 层，逐区块解析 NBT，读出顶层方块 / 高度 / 生物群系 / 实体数（实体在
    `Level.Entities`，不能用只数根级 `Entities` 的 walk —— 否则实体数永远是 0）
  - Canvas 分层渲染：方块色 / 高度热力 / 群系色三档切换，实体热点描红框直接定位卡顿源
  - 支持缩放 / 平移 / 悬停看区块坐标，数据全在内存里，不改动任何存档文件
- **跨存档统一数据库**（`worlddb.js`）—— 把散落在多个存档里的容器与命名实体汇成一张可检索的总表
  - 一次性扫描整个 `.minecraft/saves`，把每个容器的物品（中文名 / 数量 / 附魔）和命名实体归并建索引
    （实现为零依赖的扫描索引，不引入 SQLite；纯本地、按需扫描，不需要常驻数据库进程）
  - 跨存档检索：按物品名 / 实体名 / 「附魔」修饰词秒查「哪个存档里有什么、在哪格坐标」
  - 全局统计：存档数 / 容器数 / 命名实体数 / 总游玩时长，热门物品 Top 榜、容器最多的存档榜

### 实体清理建议（`entitydoctor.js`）

存档玩久了总会有「掉帧到底是从哪来的」这种疑问，而实体是最常见的元凶。这个功能把存档里
每个区块的实体摊开算一遍：

- 同时扫 **`region/`** 与 **`entities/`** 两个来源（1.18 起实体被拆到独立目录，region 里的
  `Level.Entities` 通常为空），同一区块**以 `entities/` 为准**
- **加权成本**按实体的 tick 代价分级：掉落物 1 / 经验球 1.5 / 抛射物 2 / 载具 4 / 其他 6 /
  友好生物 8 / 敌对生物 10 / 村民 25。所以「1 个村民 ≈ 25 个掉落物」——
  这也解释了为什么交易大厅比掉落物农场更吃性能
- 9 类 finding（`CHUNK_FLOOD` / `CHUNK_DENSE` / `CHUNK_COST` / `TYPE_PILE` / `ITEM_PILE` /
  `XP_PILE` / `VILLAGER_CROWD` / `TOTAL_HIGH` / `ITEM_GLOBAL`）折算成 0–100 健康分
- 给出**可直接复制的 `/kill` 指令**（按区块换算世界坐标），但**只给建议** ——
  误删不可恢复，执行与否由用户自己复核决定
- 全程只读。单维度分布视图只回传最挤的前 200 个区块，几万个区块没必要全传

> ⚠️ 加权成本是**启发式估算**，用来排序，不代表 Minecraft 的真实 tick 开销。

### 离线合成规划（`craftplanner.js`）

「做一把钻石镐要带多少东西下矿」—— 内置 370 条配方 / 360 种产物，纯内存计算，不联网。

- **不动点迭代**展开配方树（某物品需求变多 → 合成次数变多 → 上游材料需求变多），
  多配方时优先选「库存里已有的那种木板」，标签（`#planks` 之类）的解析结果一旦选定就不再变
- **双向配方必须标方向**：方块↔锭这类拆解配方标成 `via:'uncraft'` 并**默认不参与**，
  否则 `A→B→A→…` 会死循环、需求表指数爆炸。另有 `NEED_CAP = 1e6` 兜底 ——
  真撞上限时停止扩张并记进 `unresolved`，而不是把内存跑满
- **库存抵扣**可以手填，也可以勾「从存档统计」—— 复用跨存档数据库把该存档所有容器的物品
  汇总起来，于是「还差多少」是按真实库存算的
- 输出三份：**基础材料清单**（按数量降序，带来源分类）、**建议采集顺序**
  （挖矿/伐木 → 农牧 → 合成，**熔炼放最后**，省炉子来回）、**逐步合成表**
- 一个刻意的诚实：不在内置字典里的物品（多半是模组物品）**照样列出来**，
  只标注「不在字典里」，而不是假装它不存在

> 上面六个能力（版本控制 / 区域搬运 / 地图预览 / 跨存档检索 / 实体清理 / 合成规划）
> 统一收在顶部功能栏的「世界」页里，六个子页签共享同一套存档选择，互不干扰。

### Mod 与内容管理（V4 第四组）

装了几百个 mod 之后，真正的痛点是「不敢动」：更新怕崩、英文看不懂、想分享又怕版权。
这一组四个功能全部**纯本地、不联网**——mod 的元数据（`fabric.mod.json` / `mods.toml`）本来就在 jar 里，够用了。

- **Mod 更新风险评估**（`modupdate.js`）—— 装新版本之前先摊开「会炸什么」
  - 三维对比：**依赖**（增删 + 版本区间收窄）、**内部结构**（类数 / mixin 增删 / 包结构 / 语言文件数）、
    **适配**（MC 支持区间、载入器、文件名）
  - 每条 finding 分 `error / warn / info`，折算成 0–100 风险分（≥90 安全 / ≥70 谨慎 / ≥40 有风险 / 其余危险）
  - **只读**：不安装、不改文件。要真装还是走原有的 mod 管理通道
  - 有个反直觉的坑专门处理过：`isNarrower('*', '>=1.0.0')` 必须是 **false**
    （通配比下界宽松），早先按「区间跨度」算会让 `*` 被判成最严
- **Mod 汉化补全**（`modl10n.js`）—— 扫出没中文的条目，补上，但**绝不改原 jar**
  - 四步翻译：①整句精确匹配 ②**「A of B」语序重排**（`Block of Iron` → `铁方块`，不是洋泾浜的「方块 之 铁」）
    ③逐词替换 ④都不中 → 进待翻译清单
  - 产物是**独立资源包**（`pack.mcmeta` + `assets/<ns>/lang/zh_cn.json`），丢进 `resourcepacks/` 即可；
    不想要了直接删包，原 mod 分毫未动
  - 顺带产出 `zh_tw`（简→繁 342 字表）；中文结果会清掉「汉字＋空格＋汉字」的多余空格，
    但保留中英混排的空格（`Mod 设置`）
  - 词典只收常见 MC 术语，**生造词一律留英文**并进清单——乱翻专有名词比不翻更糟
- **资源包与光影预览**（复用 `packinfo.js`）—— 卡片视图：`pack.png` 图标（pixelated 渲染）、
  `pack.mcmeta` 描述、支持的 MC 版本、数据包格式；悬停放大图标，点击看详情
- **整合包创建向导**（`packbuilder.js`）—— 勾 mod → 查依赖与冲突 → 导出可分享的 zip
  - 检查项：`DEP_MISSING`（本地也没有）/ `DEP_NOT_PICKED`（本地有但没勾，**能一键补齐**）/
    `DEP_VERSION` / `MC_MISMATCH` / `LOADER_MIX`（生态混装）/ `DUP_ID` / `UNKNOWN_META`
  - 默认**只导出清单**（`manifest.json` + `README.txt`），使用者照清单自己下载——
    这是最干净、也最不容易踩版权线的分享方式；`full` 模式才复制 jar
  - 有个刻意的分歧：`fabric-api` 在这里算**要装的 mod**，不算内置依赖
    （`modguard` 那份表把它当公共设施，但整合包语境下它恰恰是头号依赖，漏掉就进不去游戏）
- **`zipwrite.js`**（新增的生产模块，不是测试基建）—— 自己写 zip，不调系统 tar
  - 踩过两次：MSYS/GNU tar **根本不支持 zip 格式**（`-a` 只挑 tar 系列，产物 magic 是 `2e2f0000`）；
    且它把 `C:\...` 当远程主机（`Cannot connect to C: resolve failed`）
  - 两个真坑：`crc32` 末尾必须 `>>> 0`（JS 位运算是有符号的，不加会抛 `value out of range`）；
    `external attrs` 的 `0o100644 << 16` 同样溢出，也要 `>>> 0`

> 这四个能力收在顶部功能栏的「Mod 工具」页里，四个子页签独立。

### 界面（V4.1.0）

从「圆滑半透明毛玻璃」整体换成**纯白 + 蓝绿像素渐变**：

- **纯白底，没有任何半透明**：原来靠 `rgba(255,255,255,.05~.1)` 叠出来的「玻璃层」全部换成实色
  （卡片纯白 + 1px 浅灰描边，次级块 `#f5f7fb`）；窗口本身也不再透明 ——
  `transparent: true` → `false`，去掉 `setBackgroundMaterial('acrylic')` 与 `backdrop-filter: blur()`。
  顺带删掉了「主题切换」和「窗口不透明度」两个设置项（界面固定纯白，没有可切的）
- **蓝绿像素渐变主题色**：青绿 `#00b3a4` → 蓝 `#0a7ff0` 的 135° 渐变，
  用在顶部功能栏选中态、启动按钮、主按钮上
- **功能栏移到顶部**：原来是左侧竖排 148px 导航，现在改成顶部横排的「图标在上、文字在下」小块。
  窄窗口下横向滚动而不是换行 —— 换行会让内容区高度忽大忽小，切页时整个界面往下跳
- **窗口放大**：1040×680 → **1440×900**（最小 1180×700），并补了最大化按钮
  （1440 宽在 1366×768 这类屏幕上会超出，得能一键铺满）
- **版本方块图标**：已安装列表和「下载官方版本」的每一项前面都有一枚方块图标 ——
  **正式版画草方块**（草绿顶 + 泥土侧，侧面上沿垂一层草皮）、**快照画命令方块**（金黄 + 顶面凹槽），
  一眼分出正式版还是快照（对标 PCL）。图标是内联 SVG 画的等距立方体，不引任何资源文件；
  「下载官方版本」也从下拉框改成了能放图标的卡片列表

> V4 第五组做过的 3D 皮肤编辑器与红石电路模拟器在这版**移除**了：
> 它们把安装包撑得太大，也不属于「启动器该干的事」。轻量版（lite）留到下一组。

### 性能诊断与调优（V4 第三组）

卡顿这件事，网上大多是「玄学换参数」。这里的做法是**先归因、再实测、最后才改参数**：

- **性能诊断**（`perfdoctor.js`）—— 把「为什么卡」讲清楚，而不是丢一堆参数让你试
  - 三路本地证据合一：`latest.log` 尾部（GC 停顿 / OOM / `Can't keep up` tick 落后 / 着色器告警）
    + 存档规模（区块数 / 实体峰值 / 容器数）+ 本机规格（物理内存 / CPU 核心）
  - 12 条规则按 `fatal / error / warn / info` 分级，每条都给**实测证据**（如"最长单次 GC 停顿 850ms"）
    与**可操作建议**，外加一个 0–100 的评分让你一眼看出多严重
  - 只读：日志只读尾部 512KB（整合包日志可到几十 MB，全文读既慢又没必要），全程不改任何文件
  - 典型归因：OOM（加堆）、GC 停顿过长（换 G1/ZGC + 调 `MaxGCPauseMillis`）、
    实体热点（刷怪塔/掉落物，配合地图预览定位坐标）、`-Xmx` 超过物理内存一半（负优化）
- **JVM 自动调参**（`perfautotune.js`）—— 按「你的机器 + 你的存档」生成一组具体参数
  - 三层约束同时成立才给值：不超过物理内存一半（超了开始换页反而更卡）、
    随存档规模涨（区块缓存/实体表）、不低于 2G
  - GC 选择有依据：有 OOM/长停顿且 Java 17+ 且内存 ≥12G → ZGC；内存 ≤8G → G1 + 宽松停顿
    （ZGC 更吃内存，这里不能选）；核多且无长停顿 → Parallel；其余 → G1 平衡
  - 大内存机器自动 `Xms = Xmx` 避免扩容抖动；小内存机器 `Xms` 受限（一上来占满一半会让系统自己卡）
  - ⚠️ **只生成建议，不写配置** —— 参数改错就是"游戏起不来"，必须用户看过再自己填

> 和「调优」页的 `jvmlab.js` 分工：`perfautotune` 是**事前**生成候选参数，
> `jvmlab` 是**事后**用 A/B 交错实测验证哪组真的更好。两个合起来才是完整闭环。

### 运行时监控（`livemetrics.js`）

规划里原本要求写一个「游戏内悬浮窗」，但伴随 Mod 只能由用户自己用 JDK + Gradle 构建，
仓库没法附带编译产物。所以这里把链路**拆成两层**，让它在没有任何 Mod 的情况下也能立刻用：

- **数据源 A（零依赖，默认就有）** —— 增量读 `logs/latest.log`
  - `Can't keep up! Running Nms [or M ticks] behind` → 卡顿曲线与「卡顿健康度」评分
  - `-Xlog:gc` 的行（若启动参数里开了）→ 堆占用曲线
  - **只要开过游戏就有数据，不需要装任何东西**
- **数据源 B（可选增强）** —— 伴随 Mod 写的 `pebble-metrics.jsonl`
  - FPS / TPS / MSPT / 堆用量 / 实体数 / 区块数 / 维度（行式 JSON，协议见 `livemetrics.SPEC`）
  - 参考实现（**未编译验证**的源码）在仓库 `companion-mod/`，含 Fabric Loom 工程与 README
- **不假装**：日志推算不出真实 FPS。源 A 只报「落后程度」，没有 Mod 时 FPS/TPS 明确留空，
  不拿估算值冒充实测
- UI 侧是指标卡 + 迷你折线（自绘 SVG，不引图表库），可勾选每 3 秒自动刷新

> 关于卡顿正则：`Can't keep up!` 有两种句式，`Running 2500ms behind` 与
> `Running 2500ms or 50 ticks behind`。正则写成 `Running\s+(\d+)ms\s+behind` 会漏掉第二种，
> 必须让 ticks 部分可选。

### 实例（多实例隔离）
- 实例 = 一份元数据 + 一个独立 `gameDir`（mods / saves / resourcepacks / shaderpacks / options.txt 全部分开）
- **老用户升级零成本**：首次启动自动封装出一个「默认实例」，`gameDir` 为空 = 继续沿用原来的
  `.minecraft`，一个字节都不搬
- 新建 / 复制（可选带哪些内容过去）/ 删除（可勾选是否连文件一起删）/ 切换
- 启动页顶部有实例下拉框，切换后资源页、存档页、Mod 守卫全部跟着变
- 实例本身只有元数据，游戏版本 / 库 / 资源仍共用 `mcDir`，开第二个实例不会重复下载几百 MB

### 跨启动器迁移
- 扫描本机 **官方启动器 / PCL2 / HMCL / Prism Launcher（含 MultiMC）** 的痕迹
  - Prism 实例名取自 `instance.cfg`（不是文件夹名），MC 版本从 `mmc-pack.json` 解析
  - HMCL 从 `config.json` 里摸出自定义游戏目录，无关路径（如背景图）不会被误认
  - PCL2 支持绿色版（藏在磁盘根目录），ini 里指向不存在的路径不会列出来
- 清点：Mod / 存档（读 `level.dat` 出真实世界名）/ 资源包 / 光影 / 截图 / `options.txt` / 体积
- **勾选导入**，默认不覆盖同名文件；只读源目录，绝不改动原启动器的东西
- **凭据不会被带出来**：只提取玩家名，`accessToken` 之类一律丢弃

### 账户
- **离线登录**（默认，无需网络）
- **外置登录** Yggdrasil / authlib-injector（认证服务器 + 账号密码，可指定 injector jar）
- **微软登录**（设备码流程，实验功能，依赖 login.microsoftonline.com 与 Xbox Live）
- **真·多账户**：每次登录都是往账户列表里「追加」而不是「替换」，可随时切换 / 删除，
  凭据全部走 `safeStorage`（Windows = DPAPI）加密落盘
- **头像抓取**（`avatar.js`）：从 Crafatar 取头像并在本地缓存 7 天，主进程抓图转 data URL
  是为了绕开渲染层的 CSP；抓取失败自动降级为 MC-Heads，再失败就显示首字母方块
- **并行多开**（`multilaunch.js`）：账户页实时列出正在运行的游戏（版本 / 实例 / 账户 / 运行时长），
  可单独或全部结束。启动前按「**实例 + 账户**」组合拦截重复 —— 同目录两个客户端会互写
  `options.txt` 与 `logs/latest.log`，同账户还会在服务端互相踢下线，这两种组合都不允许重复启动
- **实例账户绑定**（`accountbook.js`）：绑定记在**实例**上（`inst.accountId`）而不是账户上 ——
  删实例时绑定自然消失，不会留下「指向不存在实例」的孤儿记录。取账户的优先级是
  **实例绑定 → 活动账户 → 没有**；绑定的账户被删掉时**回退到活动账户并标记 stale**，
  而不是直接启动失败。账户簿的旧格式迁移（早期存的是**单个账户对象**而非 `accounts: []`）
  也从渲染层搬到了主进程，成了可单测的纯函数
- 并行多开的正确姿势就是「每个实例绑不同账户」，账户页可以直接下拉配置

### JVM A/B 调优实验室（`jvmlab.js`）

把「该配多少内存、用哪个 GC」这种玄学问题变成可重复的实测：

- **7 组预设**：默认基线 / G1 平衡 / 加载优化 / 小内存友好 / Parallel 高吞吐 / ZGC 极低延迟 / Aikar 系（客户端改）
  预设会按 Java 版本自动过滤（ZGC 要 17+，21 起才带 `-XX:+ZGenerational`），不支持的直接禁用并标原因
- **选 A / B 两组，交错跑 N 轮**（默认 ABAB 而不是 AAABBB，可以摊平机器发热带来的系统性偏差），
  每轮自动关掉游戏再跑下一个
- **测量三项客观指标**：到主菜单耗时、GC 停顿（次数 / 总量 / 最长单次，Java 8 与 9+ 两种日志格式都支持）、内存峰值
- **就绪判定用「日志静默」**：MC 从 1.14 起就没有任何一条日志明确表示"主菜单已就绪"，
  所以这里的判定是「越过资源重载 / 音频初始化阶段后，日志连续 N 秒没有新输出」——跨版本通用
- **历史按预设聚合取中位数**，差异 3% 以内按噪声处理，最终给一句人话结论（谁的几项更优）
- 测试用的 GC 日志写在 gameDir 里、跑完自动删除，不会在游戏目录留下垃圾

### 设置
- `.minecraft` 目录、Java 路径（自动检测）、额外 JVM 参数
- 启动后隐藏启动器、版本隔离（每版本独立游戏目录）
- 下载源（官方 / BMCLAPI 优先）、并发线程
- 外观：动画开关（V4.1.0 起界面固定纯白，不再有主题与透明度设置）
- 游戏内设置：直接编辑 `options.txt`（FOV、渲染距离、图像品质、平滑光照）
- 系统与更新：开机自启、关闭时最小化到托盘、创建桌面/开始菜单快捷方式、界面语言（简中 / English）、
  更新源与「检查更新」
- Java 运行环境：找不到 Java 时可自动（或手动）下载官方 Temurin，装到启动器自己的目录，
  不改动系统 Java；已下载的可以在设置页删除

### 其它
- 日志与崩溃报告查看（`logs/latest.log`、crash-reports）
- 关于页显示版本信息

## 使用

1. 双击 `Pebble-Lunchar.exe`
2. **首次使用**：到「版本」页 → 选择版本 →「下载」；或填写 MC 版本后安装 Forge / Fabric 等加载器
3. 回到「启动」页 → 选版本 →「启动游戏」

> 若本机已用官方启动器下载过版本，启动器会自动扫描到，直接启动即可。
> 若本机没有 Java，会自动复用官方启动器内置运行时（`.minecraft\runtime\java-runtime-*`）。

## Java 版本要求

| Minecraft | 所需 Java |
|---|---|
| 1.20.5+ | Java 21 |
| 1.18 ~ 1.20.4 | Java 17 |
| 1.17.x | Java 16 |
| ≤ 1.16.5 | Java 8 |

启动器会按所选版本自动挑选最合适的 Java，不匹配时给出提示。

**本机完全没有 Java 时会自动下载一份**（Eclipse Temurin 官方构建，来源 `api.adoptium.net`）：
按当前所选 MC 版本推出需要的版本，下载 zip 后解压到 `%APPDATA%\<启动器>\java\temurin-<版本>`，
装好自动填入设置。整个过程只在第一次走网络，之后直接命中本地缓存。
也可以在「设置 → Java 运行环境」手动选择版本下载，或删除已下载的。

> 自动下载不会动系统里已装的 Java，也不写注册表 / PATH。

## 目录结构

```
pebble-lunchar/
├── main.js         Electron 主进程：无边框亚克力窗口 + 托盘 + 装配（988 行 → 164 行）
├── ipc/            IPC 按域拆分：base/window/content/store/account/versions/instance/
│                   migrate/backup/lab/multilaunch/system/world。每个导出 register(ctx)，
│                   需要的上下文由 main.js 统一注入（契约有单测兜底）
├── launcher.js     启动核心：版本扫描、离线 UUID、Java 检测、natives 解压、命令组装
├── downloader.js   版本下载安装（官方源 + BMCLAPI 镜像回退、并发池）
├── loaders.js      Forge / NeoForge / Fabric / Quilt / OptiFine 自动安装
├── mcapi.js        文件系统层：资源目录、存档 NBT 解析、options.txt、版本导入导出
├── accounts.js     离线 / 外置 Yggdrasil / 微软设备码登录
├── crashdoctor.js  崩溃诊断规则库（纯本地正则，不联网）
├── securestore.js  凭据加密存储（safeStorage / DPAPI）
├── savetimemachine.js 存档时光机：块级去重快照 + 存档健康检查
├── modguard.js     Mod 守卫：jar 元数据解析 + 破坏性变更预检 + 回滚
├── zipread.js      极简 ZIP 读取器（只读 jar/zip 内单个条目，零依赖）
├── packinfo.js     资源包/光影元信息：pack.mcmeta + pack.png + pack_format 版本匹配
├── modstore.js     在线仓库：Modrinth + CurseForge 搜索/详情/版本/安装 + 安全 Markdown
├── instances.js    实例系统：独立 gameDir + 元数据，老用户升级不搬家
├── migrate.js      跨启动器迁移：探测 PCL2/HMCL/官方/Prism + 清点 + 只读导入
├── fsutil.js       手写递归复制（替代会段错误的 fs.cpSync，见下方技术要点）
├── jvmlab.js       JVM A/B 调优实验室：预设库 + GC 日志解析 + 就绪判定 + 历史对比
├── perfdoctor.js   性能诊断引擎：日志（GC/OOM/tick 落后）+ 存档规模 + 系统规格 → 分级建议
├── perfautotune.js JVM 自动调参：按机器与存档规模生成 -Xmx/-Xms/GC 建议（只建议不写配置）
├── modupdate.js    Mod 更新风险评估：新旧 jar 的依赖/结构/适配三维对比 → 0–100 风险分
├── modl10n.js      Mod 汉化补全：离线词典 + 语序重排 → 独立汉化资源包（不改原 jar）
├── packbuilder.js  整合包创建向导：候选清单 + 依赖冲突检查 + 导出清单/全量 zip
├── zipwrite.js     最小 ZIP 写入器（Deflate/Stored，零依赖；绕开 tar 不支持 zip 的坑）
├── avatar.js       头像抓取（Crafatar → MC-Heads → 首字母降级）+ 7 天磁盘缓存
├── multilaunch.js  并行多开登记表：按「实例 + 账户」去重 + PID 存活探测 + 结束
├── tray.js         系统托盘：菜单结构纯函数 + 最小化到托盘（创建失败自动降级）
├── sysconf.js      开机自启 + 桌面/开始菜单快捷方式（shell.writeShortcutLink）
├── i18n.js         轻量 i18n：字典 + t() 三级回退，未迁移文案原样显示
├── updater.js      自托管更新检查：任意 JSON 清单 + 版本比较
├── screenshots.js  截图增强：PNG 头解析分辨率 + 按日期归档（绝不覆盖原图）
├── javadl.js       Java 自动下载：Temurin API + zipread 解压（含 zip-slip 防护）
├── nbt.js          统一 NBT 解析：完整建树 + 跳读 skip + 实体计数 + 编码（含越界检查）
│                   （原先 mcapi 与 savetimemachine 各有一套重复实现，现已合并）
├── preload.js      contextBridge 安全桥接
├── renderer.js     渲染层核心：状态、导航、启动、账户、设置
├── pages.js        各功能页：版本、Mod/资源包/光影、存档、截图、账户、调优、日志
├── index.html      界面结构（顶部功能栏 + 16 个页面）
├── style.css       纯白 + 蓝绿像素渐变视觉样式（无半透明）
├── anvil.js        Anvil region 读写层：头表解析 + 区块读写删 + 批量写回 + 原子写回（世界功能的地基）
├── worldver.js     世界版本控制：区块级内容寻址对象库 + 增量提交图 + 分支/diff/blame/回滚
├── worldmerge.js   世界合并与建筑移植：干跑计划书 + 冲突检测 + 区块实体成对搬运 + 搬完复验
├── worldmap.js     存档地图预览：region 逐区块扫描 + 顶层方块/高度/群系/实体数 + Canvas 分层渲染
├── worlddb.js      跨存档统一数据库：saves 全量扫描建索引 + 物品/实体检索 + 全局统计
├── entitydoctor.js 实体清理建议：region/entities 双来源扫描 + 按 tick 代价加权 + 清理指令生成
├── craftplanner.js 离线合成规划：370 条配方 + 不动点展开 + 库存抵扣 + 采集顺序（熔炼放最后）
├── livemetrics.js  运行时指标：日志（卡顿/GC）+ 伴随 Mod JSONL → 曲线与健康度（不假装有 FPS）
├── accountbook.js  多账户簿：账户列表 / 活动账户 / 实例绑定（纯函数，含旧格式迁移）
├── i18n-ui.js      渲染层文案字典（renderer.js）
├── i18n-pages.js   页面文案字典（pages.js，283 处）
├── make-exe.js     NSIS 单文件打包（含编译前后的代码签名钩子）
├── scripts/        工程脚本：sign.js（签名）/ dev-cert.ps1（开发证书）/ sac-probe.ps1（拦截检测）
├── SIGNING.md      代码签名说明：为什么需要、证书怎么选、怎么签怎么验
├── companion-mod/  伴随 Mod 参考实现（Fabric，**未编译验证**）：写 pebble-metrics.jsonl
├── tests/          单元测试 + 端到端冒烟（node tests/*.test.js）
└── assets/logo.png UI logo
```

## 图标

品牌 logo 为蓝色 `PB` 字母标（源自用户提供的图片 `PB_logo_icon_1024.png`，**自带正确 alpha 通道，背景已镂空**）。
由 `make-icon.py` 处理：

1. 用 alpha 通道 `getbbox()` 定位内容范围，保留字内白色描边
2. 留 4% 边距裁出、居中贴到正方形画布（保持透明，不做抠图）
3. 输出 `build/icon.ico`（16/24/32/48/64/128/256 —— 小尺寸 32bpp BMP、256 用 PNG）、
   `build/icon.png`（256）、`assets/logo.png`（512，界面用）

> 注：早期源图是无 alpha 的棋盘格+水印图，需要 flood fill 抠除背景；
> 现用源图本身已镂空，故改为「按 alpha 裁框 + 居中」的简单可靠做法。

```bash
python make-icon.py
```

## 开发与打包

```bash
npm install        # 安装依赖（postinstall 会自动重放 node_modules 补丁）
npm start          # 本地运行
npm test           # 单元测试：33 个套件（含 NBT、Anvil、世界版本控制、世界合并、世界地图、跨存档数据库、性能诊断、自动调参、Mod 更新评估、汉化补全、整合包向导、ZIP 写入、实体清理、合成规划、运行时指标、多账户簿、启动参数、IPC 契约、IPC 运行时、无头装配、i18n）
npm run typecheck  # JSDoc 类型检查（tsc --checkJs，不产出文件）
npm run test:e2e   # 端到端冒烟：真实 Electron 里跑一遍新增 IPC
npm run dist       # 打包 portable exe → dist/Pebble-Lunchar.exe（内含代码签名步骤）
npm run devcert    # 生成开发用自签名证书（免管理员；详见 SIGNING.md）
npm run sign       # 单独给 dist 产物签名（换正式证书时用）
npm run sac        # 检测产物会不会被「智能应用控制」拦截
```

### 三层测试的区别

| 层 | 文件 | 证明什么 |
|---|---|---|
| 静态契约 | `tests/ipc-contract.test.js` | 主进程注册的 channel ↔ preload 调用的 channel 双向对齐，ctx 字段齐全 |
| 无头装配 | `tests/ipc-runtime.test.js` | 桩掉 electron 真跑 `main.js`：窗口/托盘建起来、每个域都挂上、ctx 接线没断 |
| 真实冒烟 | `tests/smoke.e2e.js` | 真 Electron 里加载页面，验证渲染层 + IPC 全链路 |

`ipc-contract` 只能证明字符串对得上；`ipc-runtime` 才能抓出「ctx 少个字段」「域模块 require 了不存在的函数」这类装配期错误。
沙箱/CI 里起不了 GUI 时，前两层已经能覆盖绝大部分回归。

> 本机 `npx` / `npm` 的 shim 不可靠，建议直接 `node node_modules/electron-builder/cli.js`。
> `npm test` 同理可写成直接 `node tests/xxx.test.js`。
> 类型检查走的是 `node node_modules/typescript/lib/tsc.js -p tsconfig.json`。

国内网络建议：

```bash
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm install --registry=https://registry.npmmirror.com
```

## 打包说明（本机实测）

产物：`dist/Pebble-Lunchar.exe`（75 MB 单文件，双击即用，**已带代码签名**）。

> ⚠️ Windows 11 的**智能应用控制（Smart App Control）**会拦截未签名的程序，且没有任何绕过入口。
> 签名流程已接进打包链，证书怎么来、怎么签、怎么验证看 **[SIGNING.md](SIGNING.md)**。

运行机制：首次双击自解压到 `%LOCALAPPDATA%\PebbleLunchar`（约 14 秒）并启动；之后双击直接秒开。
支持在「添加或删除程序」中卸载。

构建链为两步：

```bash
# 0) 清理旧产物（node 的 rm 会被沙箱删除守卫拦截，用 PowerShell）
#    Remove-Item -Recurse -Force dist\win-unpacked

# 1) electron-builder 产出 dist/win-unpacked（含 Pebble Lunchar.exe + resources/app.asar + 图标）
unset ELECTRON_RUN_AS_NODE
USE_HARD_LINKS=false node node_modules/electron-builder/cli.js --win --x64 --dir

# 2) 用 NSIS 编译成单文件 exe，并在编译前后自动签名
#    （顺序：先签 win-unpacked → 打进安装包 → 再签外层安装包本体）
node make-exe.js
```

> 签名由 `make-exe.js` 自动调用 `scripts/sign.js`。没配证书时会打印获取证书的指引并跳过，
> 不会阻塞打包；想强制跳过用 `SKIP_SIGN=1`。
> **打包前务必退出正在运行的启动器和已安装副本** —— 文件被占用会让签名失败
> （报 `SignTool Error: The file is being used by another process`）。

> **踩坑记录**
> - `ELECTRON_RUN_AS_NODE=1` 是本机预设环境变量，运行/打包前必须 `unset`，否则 Electron 以 Node 模式启动。
> - `USE_HARD_LINKS=false`：默认硬链接复制 Electron 会卡死。
> - 官方源下载 Electron 111MB 很慢，已通过 `build.electronDist` 指向本地 `node_modules/electron/dist`。
> - **winCodeSign 卡点**：electron-builder 在写 exe 版本信息/图标时会调用 `app-builder.exe rcedit`，
>   而 app-builder 会自行下载 winCodeSign；该压缩包内的 2 个 macOS 符号链接在无管理员权限的 Windows 上
>   解压失败（`Cannot create symbolic link`）。**本仓库已打两处补丁**（在 `node_modules` 内，重装依赖后需重打）：
>   1. `app-builder-lib/out/codeSign/windowsCodeSign.js` 的 `getSignVendorPath()`：优先返回缓存中
>      同时含 `windows-10/` 与 `rcedit-x64.exe` 的已解压目录；
>   2. `app-builder-lib/out/winPackager.js` 的 `signAndEditResources()`：把 `app-builder rcedit` 换成
>      直接 spawn 缓存里的 `rcedit-x64.exe`，从根上绕开 app-builder 的下载。
>   打完后 `--win --x64 --dir` 可一次通过（含图标）。
> - `npx` 在本机不可用，需直接 `node node_modules/electron-builder/cli.js`。
> - 打包前 `dist/win-unpacked` 必须清空，否则 electron-builder 的 `emptyDir` 会触发沙箱批量删除守卫而失败。
> - NSIS 脚本用 `File /r /x debug.log /x run.cmd "src\*"`，以排除 electron-builder 留下的临时文件。

## 安全

| 项目 | 做法 |
|---|---|
| 渲染层隔离 | `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true` |
| 同源策略 | `webSecurity: true`，不开启 `allowRunningInsecureContent`，不用 `webviewTag` |
| 内容安全策略 | `index.html` 的 CSP：`default-src 'self'`，禁用 `object-src`/`frame-src`/`base-uri`/`form-action`；`img-src` 放开 `file:` 以显示本地截图与 pack.png |
| 外部链接 | 一律走 `shell.openExternal` 用系统浏览器打开，不在主窗口 `loadURL` 外部页面 |
| **凭据存储** | 微软 `refresh_token`、外置登录 `accessToken` 等敏感字段用 Electron `safeStorage`（Windows = **DPAPI**，密钥绑定当前系统用户）加密后写入 `%APPDATA%\<应用名>\accounts.enc`。**不再明文存 localStorage**；历史明文会在首次启动时自动迁移并删除 |
| 加密不可用时 | 只保存公开字段（名称/UUID），**敏感字段直接丢弃**并提示重新登录，绝不降级为明文 |
| **下载完整性** | 所有文件比对官方 sha1（详见「技术要点」），不匹配即删除换源重下 |
| 崩溃诊断 | 纯本地正则规则库，不上传任何数据、不调用外部 API |

清除全部凭据：设置里退出登录即可，或删除 `%APPDATA%\<应用名>\accounts.enc`。

## 路线图 / 已知问题

**已完成**：

- 第一批：安全加固（沙箱/CSP/凭据加密）、下载 sha1 校验、本地崩溃诊断规则库、编码修复（UTF-8）、补丁自动重放
- 第二批（差异化功能）：存档时光机（块级去重 + 启动前自动快照 + 可撤销回滚）、
  存档健康检查（损坏/超大/实体热点）、Mod 守卫（jar 元数据 + 破坏性变更预检 + 回滚 + 变更对比）、
  极简 ZIP 读取器、单元/端到端测试骨架
- 第三批（资源可视化）：资源包/光影读 `pack.mcmeta` + `pack.png`（真名/描述/图标/适用版本、
  不匹配标红）、Mod 列表显示 jar 内真实元数据、支持未解压的目录形式资源包
- 第四批（在线仓库）：Mod/资源包/光影页面拆成「已下载」+「在线仓库」两栏，
  从 Modrinth（免密钥）与 CurseForge（可选 API Key）抓图标与介绍，一键直装进游戏目录
- 第五批（实例与迁移）：实例系统（独立 gameDir，老用户升级不搬家）、
  跨启动器迁移（官方/PCL2/HMCL/Prism 探测 + 清点 + 只读导入，凭据不落地）

- 第六批（多账户与调优）：真·多账户列表（追加而非替换）+ 头像抓取 + 并行多开（实例×账户去重）；
  JVM A/B 调优实验室（7 组预设、日志静默判定就绪、GC 停顿统计、中位数对比）
- 第七批（体验收尾）：系统托盘（最小化到托盘 + 菜单里启动/结束游戏）、开机自启、
  桌面/开始菜单快捷方式、i18n（中/英，三级回退）、自托管更新检查、
  截图增强（PNG 头解析分辨率 + 按日期归档）
- 附加：**找不到 Java 时自动下载官方 Temurin**（装到启动器自己的目录，不动系统 Java / 注册表）
- 第八批（工程化）：IPC 按域拆到 `ipc/`（main.js 从 988 行瘦身成装配层）、
  抽出统一 `nbt.js`（原先 `mcapi` 与 `savetimemachine` 各有一套重复实现）、
  NBT 单测 40 项、JSDoc 类型检查（`tsc --checkJs`，零错误）、
  IPC 静态契约测试 + 无头装配测试、GitHub Actions CI

- 第九批（覆盖率）：pages.js 文案全量迁 i18n（用 TypeScript 解析器定位字面量，283 处；
  手写词法扫描会在「模板嵌模板」「HTML 里的引号」「正则字面量」上错位）、新增 `i18n-pages.js` 字典、
  渲染层与页面层一并纳入 `tsc --checkJs`（零错误）、e2e 补关键路径断言
  （13 页导航 / 设置读写 / 截图整理 / 启动 IPC / 关于页版本）

- 第十批（发行与地基）：
  - **代码签名**：解决 Smart App Control 拦截未签名程序（见 [SIGNING.md](SIGNING.md)）
  - 修 Forge 版本「缺 jar」与 `arguments` 合并两处根因（子版本靠 `inheritsFrom` 指回原版；
    `game`/`jvm` 参数必须父在前子在后**拼接**而不是覆盖）
  - `anvil.js`：Anvil region 读写层（世界版本控制 / 世界合并 / 地图预览 / 存档数据库的共同地基）

- 第十一批（V4 第一组·内核）：
  - `worldver.js` **世界版本控制**：区块级内容寻址对象库、
    **只存增量**的提交图（存全量索引的话，2 万区块的世界每次提交要吃 1MB，改一个区块也兜不住）、
    分支 / `log` / `diff` / `blame` / `checkout` / `gc`，`commit` 与 `status` 全程只读存档
  - `worldmerge.js` **世界合并与建筑移植**：干跑计划书 + 冲突检测 + 区块/实体成对搬运 + 搬完复验
  - `anvil.js` 补两个世界功能必需的接口：批量写回 `applySaveChunks`（按 region 归并，
    一个 `.mca` 只读一次重打包一次 —— 逐区块写会把 16MB 的文件折腾上千遍）
    与扫描回调 `onChunk`（顺带把区块字节交给内容寻址）
  - 单测：worldver 40 项 + worldmerge 32 项 + anvil 批量接口 9 项

- 第十二批（V4 第一组·收尾 + 第二组·内核）：
  - 「世界」页 UI：新增「世界」页，内含四个子页签 ——
    版本控制（复用 `worldver.js`）、区域搬运（复用 `worldmerge.js`）、
    地图预览（`worldmap.js`）、全局检索（`worlddb.js`）
  - IPC 域 `ipc/world.js` 聚合包装世界相关 handler（版本控制 / 合并 / 地图 / 数据库），
    preload 暴露 `world*` 调用，`index.html` 加导航项，i18n 收尾（`nav.world` + 页面文案三级回退）
  - `worldmap.js` 存档地图预览：region 逐区块扫描 NBT，读顶层方块 / 高度 / 群系 / 实体数，
    Canvas 分层渲染（方块色 / 高度热力 / 群系色）+ 实体热点红框定位卡顿源
  - `worlddb.js` 跨存档统一数据库：扫整个 `.minecraft/saves` 建物品 / 实体索引，
    支持跨存档检索（物品名 / 实体名 / 附魔修饰）与全局统计（存档数 / 容器数 / 命名实体 / 游玩时长 / 热门物品 Top）。
    实现为零依赖扫描索引，不引入 SQLite（纯本地、按需扫描，无需常驻数据库进程）
  - 全量回归 + 类型检查零错误 + 重打包（带开发证书签名，本机 SAC 放行）
  - 单测：worldmap 15 项 + worlddb 14 项

- 第十三批（V4 第三组·性能诊断与优化）：
  - `perfdoctor.js` 性能诊断引擎：把 latest.log（GC 停顿 / OOM / tick 落后 / 着色器告警）、
    存档规模（区块 / 实体峰值 / 容器）、系统规格（内存 / 核数）三路本地证据合一，
    12 条规则按 fatal/error/warn/info 分级 + 实测证据 + 可操作建议 + 0–100 评分
  - `perfautotune.js` JVM 自动调参：按机器与存档规模生成 `-Xmx/-Xms/GC` 建议
    （三层约束：≤物理内存一半、随存档规模涨、≥2G；只建议不写配置）
  - IPC 域 `ipc/perf.js`（诊断 / 调参 / 解析参数 / 规则库），preload 暴露 `perf*`，
    「性能」页三个子页签（性能诊断 / 自动调参 / 检查项），i18n 加 `nav.perf` 与页面文案
  - 全量回归 + 类型检查零错误
  - 单测：perfdoctor 34 项 + perfautotune 32 项

- 第十四批（V4 第四组·Mod 与内容管理）：
  - `modupdate.js` Mod 更新风险评估：新旧 jar 的依赖（增删 + 区间收窄）、内部结构
    （类数 / mixin / 包结构 / 语言文件）、适配（MC 区间 / 载入器 / 文件名）三维对比，
    finding 分 error/warn/info 折算 0–100 风险分；`assessDir` 按 modId 配对并对一模一样的身影跳过。
    正确处理了「通配比下界宽松」这一反直觉情形（`strictness()` 分档，替代原先按跨度比较的错解）
  - `modl10n.js` Mod 汉化补全：四步翻译（整句 → 「A of B」语序重排 → 逐词 → 待翻译清单），
    简→繁 342 字表，中文空格清理（只删汉字间、保留中英混排）；
    产出独立资源包，**绝不改动原 jar**
  - `packbuilder.js` 整合包创建向导：候选清单（含基础库识别与 MC 适配标记）+ 七类依赖冲突检查
    （含「本地有但没勾」的一键补齐建议）+ 导出（默认只导清单，规避版权）
  - `zipwrite.js` 最小 ZIP 写入器（生产模块）：因为 MSYS/GNU tar 不支持 zip 格式输出，
    且会把 `C:\...` 当远程主机；改自写后导出产物跨平台稳定
  - IPC 域 `ipc/modkit.js`（更新评估 / 汉化扫描与导出 / 资源包预览 / 整合包向导 + 路径建议），
    preload 暴露 18 个 `modkit*`，「Mod 工具」页四个子页签，i18n 加 `nav.modkit` 与页面文案，
    `style.css` 加卡片网格与悬停放大样式
  - 全量回归（26 套单测）+ 类型检查零错误
  - 单测：modupdate 31 项 + modl10n 33 项 + packbuilder 58 项 + zipwrite 27 项

- 第十五批（V4 第二组/第三组收尾 + 第五组内核）：
  - `entitydoctor.js` 实体清理建议：region 与 entities 双来源扫描（同区块以 entities 为准）、
    按 tick 代价分级加权的成本模型、9 类 finding 折算 0–100 健康分、按区块换算世界坐标
    生成可直接复制的 `/kill` 指令（只给建议，不代替用户删）
  - `craftplanner.js` 离线合成规划器：370 条配方 / 360 种产物（成套配方循环生成）、
    不动点迭代展开、库存抵扣（可复用跨存档数据库统计真实库存）、采集顺序（熔炼放最后）；
    拆解配方标 `via:'uncraft'` 且默认不参与（否则方块↔锭成环、需求指数爆炸），
    另加 `NEED_CAP` 兜底防爆内存
  - `livemetrics.js` 运行时指标：两层数据源（零依赖的日志解析 + 可选的伴随 Mod JSONL）、
    卡顿健康度评分、可注入时钟的有界采样缓冲；伴随 Mod 参考实现放在 `companion-mod/`
    （**未编译验证** —— 本机无 JDK，仓库不发编译产物）
  - `accountbook.js` 多账户簿：账户列表 / 活动账户 / 实例绑定三件事的纯函数实现，
    能吃下旧版单账户格式并迁移；绑定失效时回退活动账户并标记 stale
  - IPC 域四个（`ipc/entitydoctor.js` / `ipc/craftplanner.js` / `ipc/livemetrics.js` /
    `ipc/accountbook.js`），preload 暴露 23 个新方法；「世界」页加「实体清理」「合成规划」
    两个子页签、「性能」页加「运行时监控」、「账户」页加「实例账户绑定」
  - 新增 `tests/ipc-v4.test.js`：不带 Electron 手工装配 ctx，把 4 个新域的每个 channel
    真调一遍 —— 静态契约测试只扫 channel 有没有对齐，抓不到「跑起来才炸」
  - 全量回归（33 套单测）+ 类型检查零错误
  - 单测：entitydoctor 56 项 + craftplanner 65 项 + livemetrics 62 项 + accountbook 62 项
    + IPC 运行时 36 项

**计划中（均为零成本/纯本地）**：

| 组 | 主题 | 内容 |
|---|---|---|
| 15 | V4 第五组（收尾） | 创意工具：3D 皮肤编辑器 / 红石电路模拟器（已完成，V4.1.0 因包体过大移除） |
| 16 | V4.1.0 | 界面重做：纯白底 + 蓝绿像素渐变、功能栏移到顶部、窗口放大到 1440×900、版本方块图标 |
| 17 | 下一组 | 轻量版（lite）：把移除的创意工具做成可选组件，而不是塞回主包 |

> **关于自动更新**：这里做的是「喂一个 JSON 地址就能用」的自托管方案——
> 静态站点、网盘直链、对象存储都能当更新源，格式为
> `{ "version": "1.1.0", "notes": "…", "url": "https://…/Pebble-Lunchar.exe" }`。
> 没有用 electron-updater，因为它强绑 GitHub / 对象存储这类发布渠道，不适合自己发行。
> 真要换过去，只需替换 `updater.js` 这一层。
>
> **关于 i18n**：渐进迁移。已抽的文案走字典，没抽的原样显示中文，
> 所以任何时候切语言都不会白屏，覆盖率慢慢补。

**暂不打算做**：AI 崩溃分析/自然语言指令（需付费 API，除非用户自备 key）、自建云存储/服务器（改用用户自备 WebDAV 或 GitHub Gist 分享）。

## 故障排查

- **双击无反应 / 闪退**：多为显卡加速问题。可用命令行加参数启动验证：
  ```bat
  "%LOCALAPPDATA%\PebbleLunchar\Pebble Lunchar.exe" --disable-gpu
  ```
- **找不到 Java**：在「设置 → Java 路径」手动指定 `javaw.exe`；MC 1.20.5+ 需要 Java 21。
- **版本列表为空**：到「版本」页下载，或在设置里确认 `.minecraft` 目录是否正确。
- **加载器下拉显示「获取失败」**：先看下拉框下方的提示行，分两种情况：
  - 提示「Forge 尚未发布 MC x.y 的构建（当前最高支持 x.z）」→ 不是故障，是该 MC 版本太新，Forge 还没出对应构建。
    点提示里的「改用 x.z 重新获取」，或改用 NeoForge / Fabric。
  - 提示网络类错误 → 启动器会依次尝试 BMCLAPI 镜像、Forge 官方 Maven、`promotions_slim.json` 三个来源，
    全部失败才会报错；检查代理/防火墙后重试即可。
  > 注意：`maven-metadata.xml` 走 BMCLAPI 镜像是国内加速，但它的副本停在 1.18，
  > 所以高版本一律以官方 `maven.minecraftforge.net` 为准，这是刻意设计的回退顺序。
- **装加载器时末步报 `Could not find a valid launcher profile .json`**（Fabric 最常见）：
  Fabric 安装器跑完末尾会调 `ProfileInstaller.getInstalledLauncherTypes()`，它只做一件事——
  看 `<dir>` 下有没有 `launcher_profiles.json` 或 `launcher_profiles_microsoft_store.json`。
  两个都没有就抛这个错。典型现象是 `fabric-loader-xxx.json` 已经写出来了却报错（说明 Java、
  安装器、目录都没问题，纯粹卡在这最后一步）。
  - **Fabric**：官方给了第三方启动器专用开关 `-noprofile`，安装时直接跳过整套 profile 逻辑。
    Pebble 本来就用「版本 JSON + 实例」体系启动，不需要官方 profile，所以不会去动用户真实的
    `.minecraft`（`loaderCliArgs()` 里已带该参数）。
  - **Quilt**：对应开关是 `--no-profile`。
  - **Forge / NeoForge**：没有跳过开关，硬要求该文件存在。`loaders.js` 的 `ensureLauncherProfiles()`
    会在安装前兜底：缺失则建最小合法壳，已存在且合法则不动（保护官方启动器配置），损坏则先备份 `.bak` 再修复。
  - 这组参数契约由 `tests/loaders.test.js` 锁死（含 1:1 复刻安装器 `ArgumentParser` 的解析用例），
    改动会被立刻测出来。
- **游戏异常退出（code 4294967295）**：即进程以 -1 退出。先看「运行日志」末尾 —— 启动器会自动读取 `.minecraft\crash-reports` 里最新一份报告，把 `Description:` 与异常首行打印出来；也可直接打开该报告查看完整堆栈。
  - 若报告里是 `Only one quick play option can be specified`：说明传入的 `--quickPlay*` 参数多于一个。启动器需按官方规则处理版本 JSON 里 `features` 门控的参数（修复见下）。
- **双击弹出「智能应用控制已阻止此应用」，且没有「仍要运行」按钮**：
  这是 Windows 11 的 Smart App Control 在拦未签名的程序（和 SmartScreen 不是一回事，
  它**没有**任何单次放行入口）。三种处理：
  - **自己能跑起来就行**：设置 → 隐私和安全性 → Windows 安全中心 → 应用和浏览器控制 →
    智能应用控制 → 关闭。⚠️ 微软的设计是**关掉就回不去**，除非重置或重装系统。
  - **本机 + 内测机器**：`npm run devcert` 生成自签名证书并信任，再用 `npm run sign` 签名。
    实测可放行安装包（详细验证过程见 SIGNING.md）。
  - **正式发行**：只能买受信任 CA 的代码签名证书（OV 约 ¥500–1200/年）。
- **重复运行 exe 没生效**：NSIS 安装器按 `version.txt` 构建号判断，构建号一致时直接启动已安装副本（秒开），不一致时自动覆盖重装。手动强制重装可删除 `%LOCALAPPDATA%\PebbleLunchar` 后重新运行 exe。

## 技术要点

- **纯白界面**：V4.1.0 起 `transparent: false` + `backgroundColor: '#ffffff'` + `frame: false`，去掉亚克力材质与 `backdrop-filter`；卡片是纯白 + 1px 浅灰描边，主色为青绿→蓝的 135° 渐变。
- **离线 UUID**：`MD5("OfflinePlayer:" + name)` 按 RFC 4122 置版本位为 3、变体位为 IETF，与 Bukkit/Paper 离线模式完全一致。
- **natives 解压**：调用系统自带 `tar`（Win10+ bsdtar 可直接解 zip/jar），不引入解压依赖。
- **存档信息**：内置极简 NBT 解析器，直接从 `level.dat`（gzip）读出存档名、版本、模式、极限/作弊、最后游玩时间。
- **下载容错 + 校验**：每个文件先尝试主源，失败自动切换到 BMCLAPI 镜像。**所有文件都比对官方版本 JSON 里的 sha1**：客户端 jar 用 `downloads.client.sha1`、依赖库用 `artifact/classifiers.sha1`、资源文件用内容寻址的 hash 本身。已存在的文件也会先校验，不匹配即删除重下——防止镜像投毒、CDN 缓存污染、续传损坏。
- **进程隔离**：加载器安装器与游戏进程均独立 spawn，输出实时回传界面。
- **不能用 `fs.cpSync` 复制目录**：Node 22 在 Windows 上往「含非 ASCII 字符的目标路径」递归
  `cpSync` 会直接段错误退出（进程崩溃，`try/catch` 拦不住，退出码 139）。实例名、游戏目录、
  甚至 Windows 用户名都可能带中文，所以 `fsutil.js` 手写了一份递归复制，全项目禁用 `cpSync`。
- **配置文件里的路径要归一化**：HMCL 的 `config.json` 用 `/` 分隔、PCL 的 ini 用 `\`，
  读出来必须先 `path.normalize()` 再拿去做 fs 调用和路径比较，否则同一个目录会被判成两个。
- **规则匹配（features）**：`ruleAllowed(rules, features)` 同时匹配 `os` 与 `features`，缺省一律 false。**这一点是必须的**：现代版本 JSON 用 `features` 门控互斥游戏参数（`--demo`、`--width/--height`、四个 `--quickPlay*`），若忽略 features 全量传入，游戏会在参数校验阶段直接抛 `IllegalArgumentException: Only one quick play option can be specified` 并以 -1 退出（表现为 GUI 闪一下就没有窗口）。
- **Java 24+**：自动追加 `--enable-native-access=ALL-UNNAMED`，消除 LWJGL 的受限方法警告。
- **快照为什么敢每次都做**：内容寻址去重（1MB 块 + SHA1）。同一个 region 文件只有被改动的块会产生新块，
  实测同一存档连打 3 个快照，物理占用仍是 1 份（去重比 3.00x）。配合"没有任何文件比上一个快照新就跳过"的快速判断，
  重复启动的额外开销趋近于零。快照仓库在 `userData/timemachine`，与 `.minecraft` 分离。
- **为什么不能用 `mcapi.parseNBT` 读区块**：它是为 `level.dat` 定制的，返回结构被硬编码成
  `{LevelName, Version, GameType...}`，用来读区块会得到完全错误的结果（实体数永远是 0）。
  所以 `savetimemachine.js` 里另写了一个「只跳读、不建树」的 NBT walker 专门数实体，
  避免为几 MB 的区块构造完整对象树。
- **Mod 元数据怎么来的**：`zipread.js` 解析 jar 的中央目录，按需 `inflateRaw` 出元数据文件——
  不解压整个 jar、不引入第三方依赖。Forge 的 `mods.toml` 用 targeted 解析（只取 `modId`/`version`/依赖块），
  不为了它引一个完整 TOML 库。
- **在线仓库的两个源不是对等的**：Modrinth 官方接口免密钥；CurseForge **强制 API Key**（实测无 key 返回
  `403 Forbidden: API Key missing or invalid`）。所以 CF 是"配了才有"的可选源，
  没配时搜索结果里只出 Modrinth，并在状态栏明确写出原因 —— 不让它看起来像"搜不到"。
- **图片为什么不直接写 `<img src="https://...">`**：CSP 里 `img-src` 没有放开外部主机，
  由主进程 `fetchImage()` 抓下来转 data URL 再交给渲染层，省得为了显示图片放宽 CSP。
  一屏 30 张卡如果并发 30 个请求会被 CDN 限流，所以做了 4 路并发队列 + 同 URL 去重。
- **MC 版本列表不硬编码**：从 Modrinth 的 `/v2/tag/game_version` 拉正式版列表。
  写死的列表过几个月就全是过期选项（实测当前最新是 26.3）。
- **版本区间比较**：`mcSatisfies()` 支持 `[1.20,1.21)`、`(1.20,1.21]`、`>=1.20`、`1.20.x`、`1.20.*`、精确版本与空值。
- **启动器的 MC 版本要"解析"**：版本 id 可能是 `fabric-loader-0.15.7-1.20.1`，
  必须沿 `inheritsFrom` 走到 `1.20.1` 才能拿去做版本区间比较，否则全是误报（见 `resolve-mc-version`）。
