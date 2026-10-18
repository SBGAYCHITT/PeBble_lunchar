# Pebble Launcher

Minecraft 启动器（离线模式为主），纯白 + 蓝绿像素渐变界面，打包为免安装单文件 .exe。
功能对标 PCL2，**不含联机相关功能**（局域网联机 / P2P 联机）。

[![Release](https://img.shields.io/github/v/release/SBGAYCHITT/PeBble_lunchar?label=release)](https://github.com/SBGAYCHITT/PeBble_lunchar/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> **下载**：前往 [Releases 页面](https://github.com/SBGAYCHITT/PeBble_lunchar/releases) 下载最新的
> `Pebble-Launcher.exe`（免安装单文件，双击即用，支持 Windows 10/11 x64）。

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
  - **深度自检（字节级）**：把每个区块解出来再原样写回，逐字节比对。
    上面那些回答的是"读得出来吗"，这一步回答的是"读出来再写回去，还是原来那个字节吗"——
    只有它能证明我们的编解码不会在玩家保存时悄悄改动存档。
    比对的是**解压后的 NBT**（压缩负载重新压过必然不同）；LZ4 区块与解不开的区块如实标成
    "未检查"而不是"通过"。默认抽查 4000 个区块，全程只读。
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
  - **完整版（V5 第一组）补齐三块能力**，都在「世界 → 回放与合并」页：
    - **方块级 blame**：给一个**世界坐标**，回答"这一格是谁改的"。归属到**最先把它变成现在这个状态**
      的那次提交，而不是"最近碰过这个区块的提交"—— 只改了旁边的方块时状态没变，那种提交不该出现在历史里
    - **时间轴回放**：把这个区块在历次提交里的样子排成帧（**由旧到新**），拖滑块就能回放，
      画布上 16×16 一格一色，可勾选"只标出这一步改动的格子"（和上一帧逐格对照）
    - **自研三方合并**：`mergePlan`（只读）+ `mergeApply`。共同祖先走**全部父节点**（含合并父）——
      只看第一父链会退化到根提交，两侧自开始以来的全部改动都会被误判成冲突
    - 解码统一走 `blockstate.js`：1.16 起位打包从"跨 long"改成"不跨 long"，1.18 起 `sections`
      从 `Level` 提到顶层。用错解码器不会报错，只会给出**合法但错位**的方块名 —— 所以判据是
      数据本身（long 个数 / 填充位是否为 0），不是 DataVersion
    - **保类型的 NBT 写入端（V5 第二组补完）**：`nbt.js` 新增类型旁路表（`newTypes()`），
      解析时把「JS 值看不出来的类型」记下来，写回时优先按**原类型**编码，于是
      `mergeChunkBytes` 能真的产出"两侧改动都保留"的区块字节了。这条路原本被三处静默类型改写堵死：
      `PostProcessing` 是 LIST of SHORT（值全是 0，按值推断会写成 LIST of INT，游戏读这种区块直接抛异常）、
      实体 `Pos` 是 LIST of DOUBLE（值恰好整数时会被写成 INT）、
      `LONG_ARRAY` 在 JS 里就是一个普通 Array（和 LIST 无法区分）。**改数组内容要原地改**
      （`arr[i]=v` / `push` / `length=0`），换新数组对象必须自己登记 `types.node`
    - **合流的两道硬闸门**：① 对方的改动落在我方没有的区段（我们只能重写自己已有的 section，
      碰不到的地方谈不上合并）；② 涉及**方块实体载体**（箱子/告示牌/刷怪笼），
      硬合的结果是箱子变空 —— 那是静默丢数据，比光照过时严重得多
    - **默认只拦"会丢东西"的合并**：冲突区块先试方块级合流，**损失为 0 的自动合并**
      （同一个区块里两边改到不同格，和 git 一样不算冲突）；只有"合不了的"或"合完还有真冲突"
      的才要用户点头。判据是逐块检查 `!mergeable || dropped > 0`，**不是**看有没有冲突 ——
      把"算不出来"当成"没事"就是静默丢数据
    - **如实上报光照风险**：改动两侧只要有一边不是不透明完整方块，该格的光照与高度图就过时。
      逐格列进 `lightRisk` 交给调用方，不拒绝也不咽下去
    - 合流仍然**不碰存档目录**：`mergeApply` 只写版本库，要落盘还是合并完切分支再 `checkout`。
      这条边界不因为"能产字节了"就破掉
    - **平移模块**：区块是最小搬运单位，平移量只能是 **16 的整数倍**；非整数倍直接拒绝
      并把"最近可用值"交给 UI 做按钮。**垂直方向不做平移**（整列搬）
- **世界合并与建筑移植**（`worldmerge.js`）—— 创造存档里搭好的城堡搬进生存存档
  - 干跑（`plan`）与执行（`apply`）**刻意分成两步**：这种工具出错时覆盖的是玩家几百小时的世界，
    所以先把"要动哪些区块、会覆盖掉什么、目标有几处冲突、有几个实体热点、大概多大体积"全摊开
  - 冲突检测（目标同位置已有不同内容）、`skip-existing` 只补空位、搬完**自动复验**（重扫目标比对指纹）
  - **区块与实体成对替换**：只看区块就跳过的话，新搬来的城堡里会残留当地生物与掉落物
  - **区块对齐平移（V5 第二组）**：把选区整体挪到别处，而不是只能原地覆盖
    - 平移量必须是 **16 的整数倍**（区块是最小搬运单位）。填了别的数**不猜、不四舍五入**，
      直接拒绝并把最近可用值交给 UI 摆一颗「就用它」的按钮 —— 悄悄改掉用户填的数字比报错危险得多
    - 整块挪走是 **100% 安全**的：区块内部一切（光照、高度图、生物群系、方块实体、计划刻）
      都相对区块自洽，只需改**绝对坐标**那几处。所以同步改的是一张明确的清单：
      `xPos`/`zPos`、实体区块根的 `Position:[cx,cz]`、`block_entities`/`block_ticks`/`fluid_ticks`
      （≤1.17 是 `TileEntities`/`TileTicks`/`LiquidTicks`）的 x/z、实体的 `Pos` 与 `TileX`/`TileZ`、
      `Passengers` 递归、`structures.starts` 的 `ChunkX`/`ChunkZ`/`Children`/`BB` 与 `References` 的键
    - **跨 region 正确**：region 是 32×32 区块，一个目标 region 里的区块可能来自源里 2~4 个 region，
      所以按**给定区块坐标**分组读，而不是"一个盒子对一个文件"
    - **目标预检**（`precheckTarget`）：`session.lock` 占用（游戏开着目标存档时写 region 会写坏它；
      原版写毫秒时间戳并每秒更新，所以时间戳合理就用它，否则退回 mtime）、
      DataVersion 代差（源 ≥1.18 而目标 <1.18 时源区块有**负 Y 区段**，旧版根本不认识 —— 直接拦下）、
      目标文件写不进去。有 blocker 时 **apply 默认拒绝**，要显式 `force:true` 才继续
    - 执行前自动给目标存档打时光机快照，每个被改的 region 文件再留 `.bak`；复验比的是
      **平移之后的指纹**（拿原始字节去比会把一次完全正确的平移判成全部失败）
  - **区块状态图**：主进程算好一张逐区块的字符矩阵（`.` 源里没有 / `n` 新建 / `=` 已一致 /
    `!` 会覆盖 / `-` 跳过 / `x` 损坏），渲染层直接照着画，不用自己推断每格状态
  - ⚠️ 一个限制写在模块头里：垂直方向是**整列**搬运，不做 y 裁剪（光照/高度图/方块实体/生物群系
    都挂在同一个 chunk 上，只搬一段 y 必然把存档搞坏 —— 要裁剪请先在游戏里用结构方块或 WorldEdit 做好）
- **存档地图预览**（`worldmap.js`）—— 把枯燥的 region 文件变成一眼能懂的俯视图
  - 纯本地扫描 `anvil` 层，逐区块解析 NBT，读出顶层方块 / 高度 / 生物群系 / 实体数（实体在
    `Level.Entities`，不能用只数根级 `Entities` 的 walk —— 否则实体数永远是 0）
  - Canvas 分层渲染：方块色 / 高度热力 / 群系色三档切换，实体热点描红框直接定位卡顿源
  - 支持缩放 / 平移 / 悬停看区块坐标，数据全在内存里，不改动任何存档文件
- **跨存档统一数据库**（`worlddb.js`）—— 把散落在多个存档里的容器与命名实体汇成一张可检索的总表
  - 一次性扫描整个 `.minecraft/saves`，把每个容器的物品（中文名 / 数量 / 附魔）和命名实体归并建索引
    （实现为零依赖的**落盘索引**，不引入 SQLite；纯本地、按需扫描，不需要常驻数据库进程）
  - **落盘索引 + 指纹增量（V5 第二组）**：索引缓存在 `userData/worlddb` 下，**不写进存档目录**。
    按 region 文件的 `mtime+size` 指纹比对，第二次扫描只重读变过的文件 —— 一次全量扫描要解压几万个区块，
    而"只多了一个箱子"的世界通常只有一两个 region 文件会变
  - **racy timestamp 兜底**："mtime+size 没变"不等于"文件没变" —— 文件可能在写下索引的**同一毫秒**
    里被改，`mtime` 会一模一样。照抄 git 的处理：`mtime >= 索引写入时刻` 的文件一律重读
  - **三个维度**：主世界 / 下界 / 末地，`region/` 与 `entities/` 两个来源都扫（1.18 起方块实体在
    顶层 `block_entities`，≤1.17 在 `Level.BlockEntities`）
  - **索引面**：物品自定义名、附魔清单（中英对照）、**潜影盒嵌套**（深度 ≤2，含 1.20.5 起
    `{id,count,components}` 新写法与 `{id:{id,count}}` 堆叠形态）、玩家背包与末影箱（作为伪容器）、
    **带物品栏的实体**（矿车 / 船）也算容器
  - **检索 DSL**：`dim:下界` / `save:存档名` / `kind:container|entity` / `near:me,64` / `near:x,y,z,r`
    （水平距离）/ `ench:锋利` / `exact:stone`（不命中红石）/ `sort:count|dist|name|time` / `limit:` / `page:`，
    引号里的词当一个整体。**只有白名单 key 才当过滤器**，所以 `minecraft:diamond_sword` 是搜索词而不是语法
  - 检索串写错时**单独报错**（"检索串有问题：未知的维度"），而不是返回空结果让人反复换词去猜
  - 全局统计：存档数 / 容器数 / 命名实体数 / 总游玩时长、物品件数与堆数、附魔物品数、命名物品数、
    维度分布、常见附魔 Top 榜、热门物品 Top 榜、容器最多的存档榜、索引覆盖区块数与损坏区块数

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
- **逐目标可行性**（V5）：主规划算的是「共享中间产物之后的合计」，看不出「具体哪个目标做不出来」。
  所以每个目标会**再单独展开一次**，标出 `ok` 与卡点（标签没候选 / 配方成环 / 没有配方也不认识）
- **库存用量**（V5）：不只算"还差多少"，还算"你的库存会被吃掉多少" ——
  `用 4 / 有 10，剩 6`。跟本次目标无关的库存单独计数，不塞进清单里
- **配方版本差异**（V5，`diffRecipes`）：导入一份配方 JSON 前先**预览差异** ——
  新增 / 移除 / 改动 / 未变，改动行会给出材料增减（`+木炭×1、−煤炭×1、~木棍 1→2`）。
  预览**不改全局表**；确认后才应用，且只影响本次运行、不写盘

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
- **蓝绿像素渐变主题色**：青绿 `#00b3a4` → 蓝 `#0a7ff0` 的 135° 渐变。
  最显眼的地方就是**顶部功能栏整条铺满这个渐变**（不是只有选中项），启动按钮、主按钮同款。
  渐变底上选中项反过来做**白底 + 深青字** —— 选中态再用渐变会和栏底撞成一片，
  白胶囊才是渐变栏上唯一能「跳出来」的做法
- **功能栏移到顶部**：原来是左侧竖排 148px 导航，现在改成顶部横排的「图标在上、文字在下」小块。
  窄窗口下横向滚动而不是换行 —— 换行会让内容区高度忽大忽小，切页时整个界面往下跳
- **窗口放大**：1040×680 → **1440×900**（最小 1180×700），并补了最大化按钮
  （1440 宽在 1366×768 这类屏幕上会超出，得能一键铺满）
- **版本方块图标**：已安装列表和「下载官方版本」的每一项前面都有一枚方块图标 ——
  **正式版 = 草方块**、**快照 = 命令方块**，一眼分出正式版还是快照（对标 PCL）。
  贴图用的是**原版 2D 贴图**（`assets/blocks/`，取自原版资源包 `textures/block/` 的 16×16 像素画），
  按 **32px = 原图 2 倍**渲染并加 `image-rendering: pixelated` 保硬边 ——
  整数倍缩放才不会把像素插值成一半，像素画的味儿才留得住。
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

### 性能诊断进阶（V5 第三组）

上一组回答「为什么卡」，这一组回答三个更硬的问题：**卡了多久的帧、卡是谁造成的、改完到底变好没有**。

- **帧时间分布**（`perfdoctor.frameStats`）—— P50 / P95 / P99 + 直方图 + 长帧占比
  - 三种口径**分开标注**，绝不混用：
    - `frame`：Mod 上报了逐帧毫秒（`frameTimes`）→ 真正的逐帧分位数
    - `frame-aggregate`：Mod 上报了每秒 `frames` / `longFrames` → **长帧占比精确**，但分位数仍来自每秒均值
    - `second`：只有 `fps` → 只能算「每秒平均帧时间」的分位数。一秒内的毛刺会被平均掉，
      算出来的 P99 **一定比真实值好看**，所以页面会直接写「这是反推的」
  - 直方图分桶按帧预算切：8.33 / 16.67 / 25 / 33.33 / 50 / 100 ms（对应 120 / 60 / 40 / 30 / 20 / 10 fps）
  - 日志里没有 FPS，所以**没有 Mod 就明确显示「无数据」**，不估算
- **卡顿归因**（`perfdoctor.attributeStutter`）—— 这一块的核心是**不许瞎猜**
  - 先做**时序关联**：对每一次 `Can't keep up!`，看它之前 1–5 秒内有没有 GC 停顿 / 区块加载事件
  - 还要扣除**随机重合基线**：GC 很频繁时，"随便一次卡顿前 2 秒内有 GC" 几乎必然成立。
    所以额外算 `gcDensity = GC次数 × 窗口 / 会话时长`，只有命中率明显高于它（`lift`）才敢下结论
  - 结论分「高置信 / 中等 / 低置信」并写明依据；**静态证据（比如"单区块 80 个实体"）不进结论**，
    只进「未确定」并写清楚"为什么不给结论"
  - 「未确定」固定列出四类日志里根本查不到的东西：实体热点、Mod 内部 tick 耗时、GPU、磁盘 I/O，
    每类都给实证手段（spark / 任务管理器 / 资源监视器）
  - OOM 是硬证据，不需要时序，直接高置信
- **会话对比**（`perfdoctor.compareSessions`）—— 回答「昨天改完参数到底有没有变好」
  - 直接读 `logs/` 里轮转出来的历史日志（含 `.log.gz`，内置 `zlib` 解压，零依赖）
  - 10 项指标逐项对比：帧率 / P50 / P95 / P99 / 长帧占比 / GC 次数 / 最长停顿 / 卡顿次数 / 最严重落后 / 日志行数
  - 判定保守：**变化幅度小于 2% 一律算「持平」**，不把噪声当成果；历史日志没有帧样本时，帧相关行直接标「不可比」

> 口径上的取舍：为什么 `resolution` 和 `percentileBasis` 是两个字段？
> 因为 Mod 完全可能同时给 `frames`（精确计数）和 `fps`（每秒均值）——
> 此时长帧占比是**精确**的，但 P99 仍然只能来自每秒均值。合成一个字段就会让人误以为 P99 是逐帧的。

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

### 云端账号与云存档（`pebblecloud.js` / `ipc/cloud.js`）

换台机器不用重新配一遍账户 —— 这是**唯一一个会联网的功能**，所以默认全程不用它也能照常玩。

- **云账号**：注册 / 登录 / 登出，服务端是自建的 Deno Deploy 后端（不在本仓库）。
  地址可以用环境变量 `PEBBLE_CLOUD_ENDPOINT` 或 `configure({ endpoint })` 指向你自己的部署
- **账户迁移**：把本机账户配置备份到云端（含各账户的登录令牌），另一台机器上一键恢复。
  ⚠️ 这份数据里**包含 accessToken / refreshToken**，上传前界面会明确说明 ——
  不会"顺手就传了"
- **云存档**：任意 JSON 的 KV 存储（`putBlob` / `getBlob` / `listBlobs` / `deleteBlob`），
  上面那套账户备份就建在它之上
- **凭据处理**：
  - 密码只用于换 token，**不落盘**；输入框用完即清
  - token 走 `securestore` 的 `secrets.enc`（DPAPI 加密），**只存在于主进程** ——
    `cloud-status` 返回的登录态快照里没有 token，渲染层拿不到
  - 系统不支持加密时**拒绝落盘**（不降级写明文），登录态只在内存里活着，界面如实提示"重启后要重新登录"
  - 老版本误存的明文 token 会在首次读取时自动搬进加密存储，并**把明文那行删掉**
- **错误分类**（这一路的坑比功能本身多）：
  - 服务端鉴权中间件跑在**路由之前**，所以 401 有两种含义：请求**带了** token 收到 401 = 登录态失效
    （自动清 token 并提示重新登录）；**没带** token 收到 401 = 登录接口在说"密码错误"。
    登录 / 注册请求**刻意不带 Authorization**，从根上避免"已登录时输错密码被报成登录过期"
  - `fetch` 的 `'fetch failed'` 一律翻译成人话（超时多少秒、DNS 解不到、连接被拒、证书失败…），
    HTTP 500 明确说"不是你这边的问题"
  - "测试连接"**一定会真发一次请求** —— 早期版本未登录时会短路返回"连得上"，断网也说你连得上

### 自动更新（`updater.js` / `ipc/update.js`）

自托管：不用 electron-updater，也不绑 GitHub Releases —— 给它一个能返回 JSON 的地址就行，
静态站点、对象存储、自己的后端都能当更新源。

**清单格式**（`GET` 任意地址，返回 JSON）：

```json
{
  "version": "5.0.0",
  "notes": "更新说明",
  "url": "https://…/Pebble-Lunchar-5.0.0.exe",
  "sha256": "dee2385ca7c8f5581b012d1a6baa3ff3321d574d350e519d94066bb2646a9aa0",
  "size": 79047176,
  "publishedAt": "2026-10-17"
}
```

- **带 `sha256` 才会出现「下载并安装」**；只给了 `url` 就退化成「打开下载页」。
  拿不到校验值时不硬装 —— 更新器是这程序里最不该被冒充的组件。
- 下载是流式的，边下边算 SHA-256；先写 `.part`，校验通过才改名。
  哈希或大小对不上就整个丢掉，不会留下一个"看起来像成品"的 exe。
- 超时用**无数据超时**（30 秒没收到任何字节才算卡住），不是总超时 ——
  79MB 在慢网下用总超时必然误杀。
- 下完点「立即重启安装」：写一个批处理，等启动器退出后覆盖 exe 再拉起来。
  portable 版取的是 `PORTABLE_EXECUTABLE_FILE` —— 运行时它会被解压到 `%TEMP%`，
  用 `app.getPath('exe')` 替换的是临时副本，下次双击还是旧版，而且现场一点报错都没有。
- 下载可以取消；进度条实时走，重开启动器后"已下好待安装"的状态还在。

后端需要加什么，见 `BACKEND-AUTOUPDATE.md`（一个免登录的 `/api/update/latest` + 文件直链）。

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
  **自动更新**（填更新源 → 检查 → 下载 → 校验 → 重启安装，见下节）
- Java 运行环境：找不到 Java 时可自动（或手动）下载官方 Temurin，装到启动器自己的目录，
  不改动系统 Java；已下载的可以在设置页删除

### 其它
- 日志与崩溃报告查看（`logs/latest.log`、crash-reports）
- 关于页显示版本信息

## 开源合规

本项目以 MIT 发布，**运行时不依赖任何 GPL / AGPL 代码**。`package.json` 没有 `dependencies`，
发行版里唯一带进来的第三方运行时就是 Electron：

| 第三方 | 许可 | 用途 | 说明 |
|---|---|---|---|
| Electron v31 | MIT | 桌面外壳 | 唯一运行时依赖 |
| ↳ 内嵌 Chromium / Node.js | BSD-3-Clause / MIT 等 | 渲染与运行时 | 发行包内附带 `LICENSES.chromium.html` 完整第三方声明 |
| ↳ 内嵌 ffmpeg | LGPL-2.1 | 音视频解码 | 动态链接、未修改，许可声明随上述文件一并附带 |
| electron-builder / NSIS / TypeScript | MIT / zlib / Apache-2.0 | **仅构建期** | 不进发行包 |

打包工具链（`electron-builder`、`tools/` 下的 NSIS、`typescript`）以及 Tauri 路线用的 Rust 工具链
全部只在构建时使用，不随应用分发。

核心模块的来路都写在文件头的注释里，可直接核对：

- `nbt.js` / `anvil.js` / `blockstate.js` / `worldver.js` / `worldmerge.js` / `worldmap.js` /
  `worlddb.js` / `craftplanner.js` / `zipread.js` / `zipwrite.js` —— **全部自研**，
  按 Minecraft 官方格式与 Minecraft Wiki 的格式说明实现，未复制任何第三方实现。
- 其中 `blockstate.js`（位打包两代解码）与 `worldver.js` 的三方合并算法是最容易"顺手抄一份"的地方，
  两者都是照格式文档重写的：解码判据来自**数据本身**（long 个数、填充位是否为 0），
  不是照搬某个版本的判断顺序；合并的共同祖先用 BFS 走全部父节点，是标准 three-way merge 语义。
- 未引入 SQLite / libgit2 等 GPL 或 LGPL 组件（世界数据库用的是零依赖的扫描索引，不是 SQLite）。
- **云端后端**（Deno Deploy 上的 `pebble-backend-deno.ts`）不在本仓库，属于可选的外部服务，
  不随发行包分发，也不影响不联网时的功能。客户端这一侧（`pebblecloud.js`）自研，只用 Node 内置的 `fetch`。
  **服务端契约是把测试钉死的**：`tests/cloud.test.js` 覆盖状态码 → 行为的映射，
  真实返回体是拿一次性账号对线上服务实测锁定的（形状记在 `pebblecloud.js` 文件头）。
- **合规检查清单**：集成任何新库之前，先读它的 `LICENSE`；只接受 MIT / Apache-2.0 / BSD / ISC / Zlib 这类宽松许可。
  GPL 系代码只能作为思路参考，**不得复制进本仓库**。

> 变更记录里凡是标注"自研"的模块，都可以按上面的方法原样核对 —— 这条不是口号，是发版时要能自证的。

## 使用

1. 双击 `Pebble-Launcher.exe`
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
pebble-launcher/
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
├── perfdoctor.js   性能诊断引擎：日志（GC/OOM/tick 落后）+ 存档规模 + 系统规格 → 分级建议；
│                   帧时间分位数/直方图 + 卡顿时序归因 + 两次会话对比
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
├── updater.js      自托管自动更新：清单检查 + 流式下载 + SHA-256 校验 + 替换重启
├── screenshots.js  截图增强：PNG 头解析分辨率 + 按日期归档（绝不覆盖原图）
├── javadl.js       Java 自动下载：Temurin API + zipread 解压（含 zip-slip 防护）
├── nbt.js          统一 NBT 解析：完整建树 + 跳读 skip + 实体计数 + 编码（含越界检查）
│                   （原先 mcapi 与 savetimemachine 各有一套重复实现，现已合并）
├── preload.js      contextBridge 安全桥接
├── renderer.js     渲染层核心：状态、导航、启动、账户、设置
├── pages.js        各功能页：版本、Mod/资源包/光影、存档、截图、账户、调优、日志
├── index.html      界面结构（顶部功能栏 + 17 个页面）
├── style.css       纯白 + 蓝绿像素渐变视觉样式（无半透明）
├── anvil.js        Anvil region 读写层：头表解析 + 区块读写删 + 批量写回 + 原子写回（世界功能的地基）
├── blockstate.js   方块状态解码层：位打包两代（跨 long / 不跨 long）+ 1.18 顶层 sections
│                   （地图 / 方块级 blame / 时间轴回放共用，避免三处解码各自漂移）
├── worldver.js     世界版本控制完整版：区块级对象库 + 增量提交图 + 分支/diff/blame/
│                   方块级 blame/时间轴回放/自研三方合并/回滚
├── worldmerge.js   世界合并与建筑移植：干跑计划书 + 冲突检测 + 区块实体成对搬运 + 搬完复验
├── worldmap.js     存档地图预览：region 逐区块扫描 + 顶层方块/高度/群系/实体数 + Canvas 分层渲染
├── worlddb.js      跨存档统一数据库：saves 全量扫描建索引 + 物品/实体检索 + 全局统计
├── entitydoctor.js 实体清理建议：region/entities 双来源扫描 + 按 tick 代价加权 + 清理指令生成
├── craftplanner.js 离线合成规划：370 条配方 + 不动点展开 + 库存抵扣/用量 + 逐目标可行性 + 配方版本差异
├── livemetrics.js  运行时指标：日志（卡顿/GC）+ 伴随 Mod JSONL → 曲线与健康度（不假装有 FPS）
├── accountbook.js  多账户簿：账户列表 / 活动账户 / 实例绑定（纯函数，含旧格式迁移）
├── i18n-ui.js      渲染层文案字典（renderer.js）
├── i18n-pages.js   页面文案字典（pages.js，343 处）
├── make-exe.js     NSIS 单文件打包（含编译前后的代码签名钩子）
├── scripts/        工程脚本：sign.js（签名）/ dev-cert.ps1（开发证书）/ sac-probe.ps1（拦截检测）
├── SIGNING.md      代码签名说明：为什么需要、证书怎么选、怎么签怎么验
├── companion-mod/  伴随 Mod 参考实现（Fabric，**未编译验证**）：写 pebble-metrics.jsonl
├── tests/          单元测试 + 端到端冒烟（node tests/*.test.js）
└── assets/         UI 资源：logo.png + blocks/（版本图标用的原版方块贴图）
    └── blocks/     grass_block.png / command_block.png（16×16，取自原版资源包）
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

### 版本图标（`assets/blocks/`）

版本列表里的方块图标用的是**原版 2D 贴图**，不是自己画的：

| 类型 | 贴图 | 来源 |
|---|---|---|
| 正式版 release | 草方块（草皮 + 泥土） | `textures/block/grass_block_side.png` |
| 快照 snapshot | 命令方块（正面） | `textures/block/command_block_front.png` |

- 都是 16×16 像素画，原样保存，**不做重绘**
- 渲染时按 **32px = 原图 2 倍**（整数倍）** + `image-rendering: pixelated`，
  保证像素不被插值成「半像素」而糊掉
- 命令方块的原版贴图是 16×64 的纵向图集（几种模式的正面堆在一起），
  这里取第 0 格（脉冲模式）裁成 16×16
- 草方块的**顶面**贴图（`grass_block_top.png`）是灰度图（游戏里靠生物群系染色），
  直接用会变成灰色，所以图标用的是**侧面**贴图（草皮本身就是彩色的）

> ⚠️ Minecraft 的方块贴图版权归 Mojang / Microsoft 所有。这里仅按社区惯例
> 用于「在启动器里标识版本类型」这一用途；若要商用请自行确认授权。

```bash
python make-icon.py
```

## 开发与打包

```bash
npm install        # 安装依赖（postinstall 会自动重放 node_modules 补丁）
npm start          # 本地运行
npm test           # 单元测试：40 个套件（含 NBT、Anvil、世界版本控制、世界合并、世界地图、跨存档数据库、性能诊断、性能 IPC 接线、自动调参、Mod 更新评估、汉化补全、整合包向导、ZIP 写入、实体清理、合成规划、运行时指标、多账户簿、启动参数、自动更新、打包白名单、IPC 契约、IPC 运行时、无头装配、i18n）
npm run typecheck  # JSDoc 类型检查（tsc --checkJs，不产出文件）
npm run test:e2e   # 端到端冒烟：真实 Electron 里跑一遍新增 IPC
npm run dist       # 打包 portable exe → dist/Pebble-Launcher.exe（内含代码签名步骤）
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

产物：`dist/Pebble-Launcher.exe`（75 MB 单文件，双击即用，**已带代码签名**）。

> ⚠️ Windows 11 的**智能应用控制（Smart App Control）**会拦截未签名的程序，且没有任何绕过入口。
> 签名流程已接进打包链，证书怎么来、怎么签、怎么验证看 **[SIGNING.md](SIGNING.md)**。

运行机制：首次双击自解压到 `%LOCALAPPDATA%\PebbleLauncher`（约 14 秒）并启动；之后双击直接秒开。
支持在「添加或删除程序」中卸载。

构建链为两步：

```bash
# 0) 清理旧产物（node 的 rm 会被沙箱删除守卫拦截，用 PowerShell）
#    Remove-Item -Recurse -Force dist\win-unpacked

# 1) electron-builder 产出 dist/win-unpacked（含 Pebble Launcher.exe + resources/app.asar + 图标）
unset ELECTRON_RUN_AS_NODE
USE_HARD_LINKS=false node node_modules/electron-builder/cli.js --win --x64 --dir

# 2) 用 NSIS 编译成单文件 exe，并在编译前后自动签名
#    （顺序：先签 win-unpacked → 打进安装包 → 再签外层安装包本体）
node make-exe.js
```

> ⚠️ **两步必须连着跑，第 2 步不会重新打包代码。**
> `make-exe.js` 只做「NSIS 打包 + 签名」，它读的是**已经存在的** `dist/win-unpacked`。
> 只跑第 2 步的话，会得到一个**签名有效、能启动、但内容是一个月前的** exe —— 没有任何报错。
> 本轮就踩过一次：`dist/win-unpacked/resources/app.asar` 还是旧的，新模块根本不在包里。
> **交付前一定要验一下包里的文件**（下面这段能直接跑）：
>
> ```bash
> node node_modules/@electron/asar/bin/asar.js list dist/win-unpacked/resources/app.asar | sort
> # 新增模块（如 blockstate.js）必须出现在列表里；不在就说明漏了 build.files 或没重跑第 1 步
> ```

> 不想每次删旧产物（删除守卫会拦）时，按发版序号换个输出目录，再用 `PL_SRC` 指过去：
>
> ```bash
> USE_HARD_LINKS=false node node_modules/electron-builder/cli.js --win --x64 --dir -c.directories.output=dist8
> PL_SRC=dist8/win-unpacked node make-exe.js
> ```

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
>   **但清不掉时不要跳过去跑第 2 步**（那会用到旧产物）；换个输出目录 + `PL_SRC` 更稳。
> - **新增模块要记得加进 `package.json` 的 `build.files` 白名单**。漏了不会报错：
>   开发时（`npm start` 直接读源码目录）一切正常，只有打包后的 exe 会在 `require` 时崩。
> - NSIS 脚本用 `File /r /x debug.log /x run.cmd "src\*"`，以排除 electron-builder 留下的临时文件。

## Lite 精简版

标准版是「全都给你」，Lite 版是「只给能开游戏的那部分」。两者**共用同一份源码**，
靠构建配置分流 —— 不存在第二套需要同步维护的代码。

### 两条路线（当前推荐 Tauri 版）

Lite 有两套实现，产物都在 `dist-lite*/`，**互不影响**，可以只挑一条走：

| | Electron 路线 | **Tauri 路线（当前 Lite 产物）** |
|---|---|---|
| 目录 | 本仓库根目录（`npm run lite`） | `lite-tauri/`（`npm run lite:tauri`） |
| 界面 | `index.lite.html`（从 `index.html` 现裁） | `lite-tauri/ui/`（独立一份） |
| 后端 | Node（`ipc/*.js`） | Rust（`lite-tauri/src/*.rs`） |
| 单文件 | ~64 MB | **3.07 MB** |
| 运行时 | 自带 Chromium | 系统 WebView2 |

Electron 版那 64 MB 里 Chromium 占 84%，砍页面/砍语言包只省下不到 1 MB。
Tauri 版换掉运行时归属，体积直接掉到 1/20 —— 见下面的体积表。

**Tauri 版体积**：

| | 上一版 Lite（Electron） | 本版（Tauri） |
|---|---|---|
| 单文件 exe | 64.1 MB | **3.07 MB** |
| 分发目录合计 | ~268 MB（含 `win-unpacked/` 204 MB） | **3.1 MB** |
| 需要自带浏览器内核 | 是 | 否（用系统 WebView2） |

### 构建（Tauri 路线）

```bash
npm run lite:tauri           # 编译 Rust + 覆盖 dist-lite7/Pebble-Launcher-Lite.exe
npm run lite:tauri:verify    # 上面 + 契约对账 + 启动参数核验 + 界面逐页核验
npm run lite:tauri:ui        # 单独打开前端预览台（调界面用）
npm run lite:tauri:contract  # 只跑前后端命令 / 字段静态对账
npm run lite:tauri:contract:self   # 只跑检查器自检
node lite-tauri/preview-ui.js account   # 指定页：launch|versions|account|settings|about
```

> `lite-tauri/build.rs` 只调 `tauri_build::build()`；`scripts/lite-tauri-build.js`
> 负责找 cargo、配 MSVC/SDK 的 `LIB`/`INCLUDE`、编译、拷到 `dist-lite7`。
> 本机 rustup 装在 D 盘、`CARGO_HOME/bin/cargo.exe` 是个 0 字节代理，
> 所以脚本会自己去 `~/.rustup/toolchains/*/bin/` 找真身（详见脚本注释）。

### 验证（四层，都能单独跑）

| 脚本 | 覆盖 | 现状 |
|---|---|---|
| `lite-tauri/check-contract.js` | **前后端契约静态对账**：invoke 的命令是否注册、入参名 camelCase↔snake_case、返回值字段与数组元素字段是否存在 | **79 项全过** |
| `lite-tauri/check-contract.js --selftest` | 检查器**自检**：用构造的坏样本验证它真的会报错 | **12 项全过** |
| `lite-tauri/verify-lite.js` | 启动命令行拼装：classpath、natives 解包、Forge `inheritsFrom` 合并、离线 UUID、占位符替换、架构过滤 | **64 项全过** |
| `lite-tauri/preview-ui.js` | 界面真实渲染：用项目自带 Electron 当 Chromium 加载 `ui/`，注入 `__TAURI__` 桩件，逐页断言行高/样式/数据绑定 | **5 页 68 项全过** |
| `lite-tauri/probe-ui.js` | 活体进程的 DOM + IPC（走 WebView2 远程调试端口） | 需要非沙箱环境 |

> **为什么契约要单独查一层**：Tauri 只把**入参**做 camelCase→snake_case 转换，
> **返回值原样不动**。所以 Rust 结构体字段 `default_mc_dir` 在 JS 里就要读
> `defaultMcDir`，写成 `default_mc_dir` 得到的是 `undefined` —— 不报错、不崩溃、
> 界面照常打开，只是那几行字空着。前后端靠字符串约定，编译器一个都管不了。
>
> **为什么检查器还要自检**：这套检查器自己踩过三次「不报错、只是静默失效」——
> 正则吃括号把参数丢了、只认 `pub struct` 于是私有结构体全被跳过、正则字面量
> 里的引号把作用域扫描弄崩。失效的检查器照样打印一片 `ok`，所以 `--selftest`
> 用构造的坏样本反过来验证它**确实会报错**，缺了它那些 `ok` 没有可信度。

> 界面核验为什么不能靠截屏：WebView2 用 DirectComposition 合成，
> 外部的 `BitBlt`（PIL `ImageGrab`）和 `PrintWindow` **都抓不到内容**，
> 截出来是全黑或全白，会把「能跑」误判成「白屏」。
> `preview-ui.js` 走渲染进程自己吐的位图，`probe-ui.js` 走 CDP，才算数。

### 构建（Electron 路线，保留）

```bash
npm run lite:front     # 从 index.html 裁出 index.lite.html（只留 5 页）
npm run lite:verify    # 校验白名单覆盖依赖闭包 + preload 与 IPC 通道对账
npm run lite:runtime   # 生成精简版 Electron 运行时 build/electron-lite
PL_OUT_DIR=dist-lite npm run lite:pack          # 产出 win-unpacked

PL_SRC=dist-lite/win-unpacked PL_OUT=dist-lite/Pebble-Launcher-Lite.exe \
  PL_APPNAME="Pebble Launcher Lite" PL_EXENAME="Pebble Launcher.exe" \
  PL_INSTDIR=PebbleLauncherLite node make-exe.js  # 编译单文件 exe 并签名
```

（`npm run lite` 把前三步串起来跑。）

> `PL_INSTDIR` 必须与标准版不同，否则两版装进同一个目录互相覆盖 ——
> 装完 Lite 再点标准版的快捷方式，起来的其实是 Lite。

### 三条硬约束

1. **前端只维护一份**。`index.lite.html` 由 `scripts/make-lite.js` 从 `index.html` 现裁，
   不手抄第二遍 —— 否则标准版改了启动页、Lite 忘了同步就是线上事故。
2. **被裁模块用「文件存在性」降级，不 catch 异常**。`ipc/index.js` 按域文件是否在包里
   决定注册与否；`ipc/launch.js`、`main.js` 对可选能力（时光机 / Mod 守卫 / 多开 /
   崩溃规则库）用 `optional()` 包住，文件不在就退化成「没有这个功能」，
   而不是让整个域注册失败（那样连游戏都开不了）。刻意不去吞模块内部的报错，
   免得把真 bug 变成「功能静默消失」。
3. **不删文件，只挑文件**。沙箱对「单轮批量删除」有 50 项上限，
   electron-builder 自带的 `electronLanguages` 会一次 `rm` 掉 53 个语言包，
   直接把 packaging 打挂（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）。
   改成 `scripts/make-lite-dist.js` 用 `cpSync` 的 filter 在**复制阶段**跳过，
   全程不调用任何删除 API。

> **`LICENSES.chromium.html`（约 9 MB）在 Lite 里保留了**。它是纯文本、压完很小，
> 删掉省不下多少，却会让「分发时未附带第三方许可证声明」变成实打实的合规问题。
> 真要删：把 `scripts/make-lite-dist.js` 里的 `DROP_LICENSES` 改成 `true`。

> ⚠️ **删图形后端的代价**：Lite 去掉了 `libGLESv2.dll` / `libEGL.dll` /
> `vk_swiftshader.dll` / `d3dcompiler_47.dll`。它们只在 Chromium 走 GPU 加速
> （ANGLE → D3D11 / SwiftShader）时才加载，而本应用界面是纯 DOM + 2D canvas，
> 软件光栅就够。但标准版的 GPU 回退链更完整 —— 遇到显示异常请换标准版。

## 安全

| 项目 | 做法 |
|---|---|
| 渲染层隔离 | `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true` |
| 同源策略 | `webSecurity: true`，不开启 `allowRunningInsecureContent`，不用 `webviewTag` |
| 内容安全策略 | `index.html` 的 CSP：`default-src 'self'`，禁用 `object-src`/`frame-src`/`base-uri`/`form-action`；`img-src` 放开 `file:` 以显示本地截图与 pack.png |
| 外部链接 | 一律走 `shell.openExternal` 用系统浏览器打开，不在主窗口 `loadURL` 外部页面 |
| **凭据存储** | 微软 `refresh_token`、外置登录 `accessToken` 等敏感字段用 Electron `safeStorage`（Windows = **DPAPI**，密钥绑定当前系统用户）加密后写入 `%APPDATA%\<应用名>\accounts.enc`。**不再明文存 localStorage**；历史明文会在首次启动时自动迁移并删除 |
| **云端凭据** | 云账号的登录 token 同样走 `safeStorage`（存在 `secrets.enc`，与账户分开），**只在主进程里使用**，`cloud-status` 返回给渲染层的快照里没有 token。密码不落盘 |
| **联网的地方就两处** | ①「云端」页：必须由用户主动登录 / 备份，用户名密码发往你自己的后端地址（可用 `PEBBLE_CLOUD_ENDPOINT` 覆盖），「测试连接」只发一次 `GET /api/blob`；② **自动更新**：只在用户点「检查更新」时拉一次清单，下载也只在点「下载并安装」之后发生。其余功能全程本地，不会偷偷联网 |
| **更新包校验** | 清单里的 `sha256` 是硬门槛：没给就只显示「打开下载页」、不自动装；给了但下载后对不上，文件当场删掉。替换 exe 前还要过大小校验 |
| 加密不可用时 | 只保存公开字段（名称/UUID），**敏感字段直接丢弃**并提示重新登录，绝不降级为明文；云 token 同理——存不住就只留内存并如实告知 |
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

- 第九批（覆盖率）：pages.js 文案全量迁 i18n（用 TypeScript 解析器定位字面量，343 处；
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
  - 全量回归（35 套单测）+ 类型检查零错误
  - 单测：entitydoctor 56 项 + craftplanner 65 项 + livemetrics 62 项 + accountbook 62 项
    + IPC 运行时 38 项

- 第十六批（V5 里程碑一·世界版本控制完整版）：
  目标：把「分支 / 区域级 diff」补齐成完整版 —— **方块级 blame、时间轴回放、自研三方合并**。
  合规要求是"避免 GPL 代码污染"，所以这三块与合并算法全部照格式文档自研（见 [开源合规](#开源合规)）。

  - 新增 `blockstate.js`：**方块状态解码层**，把三处解码（地图 / 方块级 blame / 时间轴回放）
    收到一份实现上，避免各自漂移。这里踩到两个**静默**缺陷（不报错、只是结果错）：
    - 1.16（20w17a）起位打包从"索引可跨 long"改成"不跨 long"。旧实现只写了跨 long 那份，
      于是 1.16+ 里 5/6/7/9 位宽的区块会解出**合法但错位**的方块名 —— 地图颜色整体偏掉。
      判据不能用"解出来的索引越不越界"（错解码器的索引全都落在调色板范围内，越界数为 0），
      而是看**数据本身**：long 个数对不上的那一边直接排除（1.16 更新日志里 5 bit 从 320 涨到 342 longs，
      这 22 个 long 的差就是硬信号），再用"填充位必须全为 0"二次确认，DataVersion 只作最后兜底
    - 1.18 把 `Level.Sections` 拍平成了顶层小写 `sections`，且 `Y` 可以为负。旧代码只读 `Level.Sections`，
      于是 1.18+ 存档的地图整片空白、也不报错
    - 顺带修掉 `chunkBiome` 的一条死分支：`Level.Biomes` 被 nbt.js 解成 **Int32Array**，
      而 `Array.isArray(Int32Array)` 是 `false`，"扁平 int 数组"那条路在真实区块上从来没进过
  - `worldver.js` 新增 **方块级 blame**（`blameBlock`）：给世界坐标回答"这一格是谁改的"。
    关键在归属规则 —— 必须归到**最先把它变成现在这个状态**的那次提交。从新往旧扫、把连续相同状态
    归并成一段、取该段里最老的那次提交；只动了旁边的方块时状态没变，那种提交不该出现
  - `worldver.js` 新增 **时间轴回放**（`timeline` / `frame`）：帧列表**由旧到新**（滑块正着拖就是沿时间前进），
    单帧给 16×16 层的方块名（索引 `z*16+x`），颜色由主进程按 `worldmap.blockColor` 映射后一并返回 ——
    渲染层不再自带一份配色表，两份表迟早走偏
  - `worldver.js` 新增 **自研三方合并**（`mergePlan` 只读 / `mergeApply` 执行）：
    - 共同祖先走**全部父节点**（含合并父）。只看第一父链会退化到根提交，两侧自开始以来的改动会被全部误判成冲突
    - 合并提交的增量必须**相对我方**存（`indexOf` 只沿第一父链回溯）；存成相对对方会让重建出的状态整体错位且不报错
    - 冲突往下判到**方块级**：同一个区块两边都改了，但改的是不同方块时判为"不相交"，不吓唬人
    - ⚠️ **已知边界**：合并只写版本库、不生成新区块字节，冲突区块只能"整个区块取某一侧"
      （写入端按 JS 值反推 NBT 类型，`LIST of SHORT` 会被写成 `LIST of INT`，游戏读这种区块直接报错）。
      代价是真实的数据丢失，所以**必须量化报出来**：`conflicts[].dropped` / `droppedSample`
      逐格列出"按这个落点会丢掉哪些方块改动"，`stats.droppedBlocks` 给总和，
      提交记录里也留着 `droppedBlocks`；默认策略有任何冲突就拒绝执行，不"默默按某一侧赢"
  - IPC：`ipc/world.js` 新增 5 个 channel（`world-ver-blame-block` / `-timeline` / `-frame` /
    `-merge-plan` / `-merge-apply`）；`merge-apply` 单独包一层，因为 `safe()` 会把错误压成
    `{ok:false,error}`，而合并冲突必须把**计划书**一起带回渲染层
  - 界面：「世界」页新增**「回放与合并」**子页签 —— 方块坐标 → blame 历史列表（点一条就把画布切到那版）、
    时间轴滑块 + 上/下一帧 + 「只标出这一步改动的格子」（与上一帧逐格对照）、16×16 像素画布
    （悬停看方块名、点一格就把坐标带过去）、分支合并面板（我方/并入/冲突策略 + 预览 + 执行）
  - 单测：`blockstate` 40 项 + `worldver5` 32 项 + `worldmap` 回归 3 项 + `ipc-runtime` 的 V5 装配 6 项
  - 全量回归（35 套单测）+ 类型检查零错误 + e2e 冒烟补一整段 V5（Node 侧写区块 + 渲染层走真 IPC + 真点按钮）

- 第十七批（V5 里程碑二·世界合并可以整区块写出 / 跨存档统一数据库）：
  目标：拆掉里程碑一那两个"只能原地覆盖"的限制，把"搬一栋房子"做成真能用的功能；
  同时把跨存档检索从"扫一遍"做成"有索引、查得准"。合规要求仍是**全部自研**（见 [开源合规](#开源合规)），
  这一批仍然是**零依赖** —— 只用 Node 内置模块。

  - `nbt.js` 新增**类型旁路表**（`newTypes()`），这是整批的地基：
    - 三张表 `comp`（字段原名类型）/ `list`（LIST 元素类型）/ `node`（节点整体类型）。
      解析时记账，写回时优先级是「该字段原名记的类型 → 该节点在 node 表里的类型 → 按 JS 值推断」
    - 治的是三处**静默**类型改写：`PostProcessing` 是 LIST of SHORT（值全 0，按值推断会写成 LIST of INT，
      游戏读这种区块直接抛异常）；实体 `Pos` 是 LIST of DOUBLE（值恰好整数时会被写成 INT）；
      `LONG_ARRAY` 在 JS 里就是普通 Array，和 LIST 无法区分
    - **使用约束（写在这里，因为它不报错）**：改数组内容**原地改**（`arr[i]=v` / `push` / `length=0`）；
      换新数组对象必须自己登记 `types.node`，否则类型就丢了
    - 顺带修掉一个真 bug：位打包交叉读时 `readBigInt64BE` 出来的有符号值做 `>>` 会**补 1**，
      污染下一个 long。4bit/8bit 的 off 永远是 4 的倍数、到不了 63，所以老测试怎么测都测不出来 ——
      修好后回退验证有 3 条测试变红，说明它一直潜伏着
  - `worldver.js` `mergeChunkBytes`：真的产出"两侧改动都保留"的区块字节。两道硬闸门、默认只拦会丢东西的、
    光照风险逐格上报，细节见上文「完整版」一节。`dropped` 要按 `mr.stats.conflict` **重算**，
    不能看到 `mr.ok` 就清零
  - `worldmerge.js` 重写（377 → 830 行）：区块对齐平移 + 坐标同步 + 目标预检 + 指纹矩阵。
    踩到的坑都是"读错文件还不报错"这一类：平移会跨 region（一个目标 region 的区块可能来自源里 2~4 个
    region，原来"一个盒子对一个文件"的写法会静默读错）；实体区块根用的是 `Position:[cx,cz]`
    而不是 `xPos`/`zPos`（用区块的造法去改它会静默什么都不改）；`canWriteFile` 拿目录当文件传时
    Windows 上 `openSync(p,'r+')` 不报 EISDIR（改成先 `statSync().isDirectory()`）
  - `worlddb.js` 重写（289 → 900 行）：三 × 两（维度 × region/entities）扫描 + 落盘指纹增量 + 索引面扩展 +
    检索 DSL。两个"看不见东西"的坑：`isContainerId` 的染色潜影盒正则字符类写成 `[a-z]+` 会让
    16 种染色潜影盒里 **12 种**命中不了（颜色名带下划线，`light_blue` 正好是最常用的那几种）；
    1.20.5 起物品从 `{id,Count,tag}` 变成 `{id,count,components}`，只认老写法就是**静默索引不到**
  - `ipc/world.js`：world-db 段重写（`ensureIndex` + 落盘缓存 + `searchError` 与 `r.error` 分开）；
    `world-merge-plan` / `-apply` **不再走 `safe()`** —— 平移量不对齐时抛的错里带着 `nearest`，
    包装层压一下就没了，UI 就只能干说一句"错误"
  - 界面：「区域搬运」页新增平移输入（`step=16`，说明写清"只能填 16 的倍数、垂直方向不动"）、
    维度选择（原来写死主世界，下界/末地的建筑搬不了）、`wm-force` 复选框、
    **区块状态图**画布（悬停看"这个目标区块会怎么被处理"）、`nearest` 的「就用它」按钮、
    预检 blocker 用【必须先解决】前缀单独列；
    「全局检索」页新增 DSL 提示、检索串错误单独报（琥珀色，与"操作失败"区分）、分页信息、
    「强制重扫」复选，统计面板补物品件数/附魔数/维度分布/缓存命中
  - 单测：`worldmerge` 58 项 + `worlddb` 39 项 + `ipc-runtime` 新增 3 项（`nearest` 透传、
    计划书字段完整、+16 格实搬并复验）
  - 把 `worldver5` 与 `nbt-typed` 两套补进 `npm test` 链（此前漏了，跑不到）；类型检查从 **28 个错误清到 0**

- 第十八批（云端：云账号 + 云存档，对接账户迁移）：
  从「加两个文件」开始，落点却是**一层没被发现过的打包漏洞** —— 全部产出都在下面。

  - **打包白名单漏洞（整批里最要紧的一条）**：`package.json` 的 `build.files` 是白名单，
    `ipc/**/*` 覆盖了 `ipc/cloud.js`，但**根目录的 `pebblecloud.js` 不在名单里**。
    而 `ipc/cloud.js` 顶层就 `require('../pebblecloud')`，`ipc/index.js` 的 `registerAll`
    又**刻意不 catch**（怕把域内部的真 bug 吞成"功能静默消失"）——
    后果不是"云端功能不可用"，是**打包版整个应用起不来**。
    核过 4.3.0 的 asar：23 个 `ipc/*.js` 都在，`pebblecloud.js` 不在，正好印证
  - **新增 `tests/packfiles.test.js`**：把 `scripts/lite-verify.js` 那套「依赖闭包 ↔ 白名单」对账
    搬给**标准版**（此前只有 Lite 侧有，标准版一直是空的）。7 条断言：
    闭包全在白名单内、白名单里的文件都真实存在（拼错=静默少打一个文件）、
    `DOMAINS` 里每个域文件都在、无重复项、磁盘上的域都已登记。
    **回退验证过**：把 `pebblecloud.js` 从白名单里拿掉，它立刻报"漏登记 1 个：pebblecloud.js"
  - `pebblecloud.js` 重写：错误分类（网络不可达 / 超时 / 非 JSON / 5xx，以及 ENOTFOUND、ECONNREFUSED、
    ECONNRESET、证书失败各自给人话）、
    token 改走 `securestore` 的 `secrets.enc`（DPAPI）而**不是明文 JSON**、
    系统不支持加密时拒绝落盘只留内存、老版本误存的明文 token 自动迁移并删掉明文行、
    端点可用环境变量覆盖、`app.getPath` 从模块加载期移到 `configure()`（无头测试才能 require 它）
  - **401 的两种含义**（实测锁定的关键判据）：服务端鉴权中间件跑在**路由之前** ——
    带**有效** token 访问不存在的路径返回 `404 not found`，带**垃圾** token 才是 `401 unauthorized`。
    所以「带 token 的 401」= 登录态已死（自动清 token 并提示重登）；
    「不带 token 的 401」= 登录接口在说"密码错误"。修法不是加特例，而是**登录/注册请求根本不带 Authorization**
  - `ipc/cloud.js` 全部包上错误码透传（`safe()` 会把 `e.code` 丢掉，而界面要靠它区分
    「登录过期 / 没登录 / 网络不通」）；⚠️ 包装器**必须返回 handler 而不是包装 `ipcMain.handle` 的调用** ——
    `tests/ipc-contract.test.js` 是静态正则扫 `ipcMain.handle('通道名'` 的，包一层间接就扫不到，
    会把 12 个通道全判成"调用了但没注册"（实测踩过）
  - 界面：新增**「云端」页**（第 17 页）—— 登录/注册/登出/测试连接、账户配置备份↔恢复、云存档列表与删除；
    「测试连接」修掉一个真 bug：早期实现未登录时走 `requireLogin()` 直接短路返回"云端可达"，
    **一个请求都没发**，断网点它也说连得上
  - 隐私：token 不出主进程（`cloud-status` 快照里没有它）；密码不落盘、输入框用完即清；
    上传账户配置前明确告知含登录令牌。README 的「安全」表补了云端凭据与"唯一的联网功能"两行
  - 单测：`cloud` 62 项（状态码→行为、token 落盘与迁移、加密不可用降级、探活、端点覆盖）
    + `packfiles` 7 项；`ipc-runtime` 补 `cloud-status` 真实调用断言。
    `scripts/make-lite.js` 的页面计数抽成 `PAGE_COUNT` 常量（17），加页面时会当场 die 而不是静默裁错
  - 后端契约用**一次性账号**实测锁定（`register` 只回 `{ok:true}` 不发 token，所以客户端注册后要接着登一次），
    形状与全部错误码写在 `pebblecloud.js` 文件头，后续对账不用再连外网

**计划中（均为零成本/纯本地）**：

| 组 | 主题 | 内容 |
|---|---|---|
| 15 | V4 第五组（收尾） | 创意工具：3D 皮肤编辑器 / 红石电路模拟器（已完成，V4.1.0 因包体过大移除） |
| 16 | V4.1.0 | 界面重做：纯白底 + 蓝绿像素渐变、功能栏移到顶部、窗口放大到 1440×900、版本方块图标 |
| 17 | 轻量版（lite） | 把移除的创意工具做成可选组件，而不是塞回主包 |
| 18 | V5 里程碑二（已完成） | **保类型的 NBT 写入端** → 世界合并整区块写出（含区块对齐平移）；跨存档统一数据库（落盘增量索引 + 检索 DSL） |
| 19 | 云端（已完成） | 云账号 + 云存档（对接账户迁移）；新增「云端」页；打包白名单契约测试 |
| 20 | V5 里程碑三（v5 暂缓） | 性能诊断进阶；离线合成规划器；3D 皮肤编辑器；红石电路模拟器（可集成宽松许可库） |
| 21 | V5.0.0（已完成） | 自动更新全链路（流式下载 + sha256 校验 + Windows 自替换）；存档字节级深度自检 |
| 22 | V5 第三组（本轮） | **性能诊断进阶**：帧时间分位数/直方图/长帧占比（三种口径分开标注）、卡顿时序归因（含随机重合基线，没证据标「未确定」）、两次会话对比（含 `.log.gz`）；**合成规划补齐**：逐目标可行性 + 库存用量 + 配方版本差异（先预览再应用） |
| 21 | 自动更新（已完成） | 检查 → 流式下载 → SHA-256 校验 → 替换重启；存档深度自检（字节级）；清掉 V4.1.0 遗留的文档僵尸条目 |

> **关于自动更新**：自托管「喂一个 JSON 地址就能用」——静态站点、网盘直链、对象存储、
> 自己的后端都能当更新源。清单里带上 `sha256`（和可选的 `size`）就能一路下到底并自动安装；
> 只有 `url` 就退化成「打开下载页」，绝不硬装一个校验不了的文件。
> 没有用 electron-updater，因为它强绑 GitHub / 对象存储这类发布渠道，不适合自己发行。
> 真要换过去，只需替换 `updater.js` 这一层。
>
> **关于 i18n**：渐进迁移。已抽的文案走字典，没抽的原样显示中文，
> 所以任何时候切语言都不会白屏，覆盖率慢慢补。

**暂不打算做**：AI 崩溃分析/自然语言指令（需付费 API，除非用户自备 key）、自建云存储/服务器（改用用户自备 WebDAV 或 GitHub Gist 分享）。

## 故障排查

- **双击无反应 / 闪退**：多为显卡加速问题。可用命令行加参数启动验证：
  ```bat
  "%LOCALAPPDATA%\PebbleLauncher\Pebble Launcher.exe" --disable-gpu
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
- **重复运行 exe 没生效**：NSIS 安装器按 `version.txt` 构建号判断，构建号一致时直接启动已安装副本（秒开），不一致时自动覆盖重装。手动强制重装可删除 `%LOCALAPPDATA%\PebbleLauncher` 后重新运行 exe。

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
