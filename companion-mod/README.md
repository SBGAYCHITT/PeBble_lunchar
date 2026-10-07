# Pebble Lunchar 伴随指标 Mod（参考实现）

把游戏运行时的 **FPS / TPS / MSPT / 堆内存 / 实体数 / 区块数** 每秒写一行 JSON，
追加到游戏目录下的 `pebble-metrics.jsonl`，供 Pebble Lunchar 启动器实时读取并画曲线；
同时提供一个可用 **F9** 开关的游戏内悬浮窗。

## ⚠️ 重要：这份代码**没有编译验证过**

仓库的构建环境里**没有 JDK**（`java` / `javac` 都不存在），所以这份源码是
**未经编译、未经运行**的参考实现。它对应的是启动器侧 `livemetrics.js` 里的协议定义：

- 协议（JSON 字段名、文件名、写入节奏）是**稳定**的，启动器按它解析；
- 但 Mod 里用到的 Minecraft / Fabric API 名字**可能与你实际的游戏版本对不上**
  （Fabric 的客户端 API 在不同 MC 版本间会改名）。对不上时改那几处调用即可。

**好消息：启动器侧的功能不依赖这个 Mod。** 没有它也能用 —— 详见下一节。

## 启动器的两层数据源

| 数据源 | 需要装 Mod | 能看到 |
|---|---|---|
| **A. 日志** | ❌ 不需要 | 卡顿（落后）记录、GC 堆用量、会话起止 |
| **B. 本 Mod** | ✅ 需要 | FPS、TPS、MSPT、内存、实体数、区块数、维度 |

也就是说：**开过游戏就有数据**。装了这个 Mod 才有精确的帧率与 tick 率。

## 构建

需要 **JDK 21** 和能联网的 Gradle（首次构建要下载 Minecraft 与映射文件，比较慢）。

1. 打开 `gradle.properties`，把**四个版本号**换成你的目标 MC 版本对应的值。
   查询地址：<https://fabricmc.net/develop/>
   （选好 Minecraft 版本后，页面会直接给出 `yarn_mappings` / `loader_version` / `fabric_version`）

   > 仓库里预填的 `1.21.4` 一组值只是**占位示例**，直接用大概率对不上你的游戏版本。

2. 构建：

   ```bash
   cd companion-mod
   ./gradlew build          # Linux / macOS / Git Bash
   gradlew.bat build        # Windows cmd / PowerShell
   ```

3. 产物在 `build/libs/pebble-metrics-<版本>.jar`。

4. 把 jar 丢进 `mods/` 文件夹（需要同时装 **Fabric API**）。

## 输出文件长什么样

`<游戏目录>/pebble-metrics.jsonl`，每行一个 JSON：

```json
{"t":1696000000000,"fps":142,"tps":20.00,"mspt":12.30,"mem":1234567890,"memMax":4294967296,"entities":1234,"chunks":441,"players":1,"dim":"overworld"}
```

- 每秒一行；字段全部可选，缺的按 `null` 处理。
- 文件超过 **5 MB** 会被清空重写，防止长时间挂机写满磁盘。

## 为什么写到游戏目录而不是让启动器传路径

Fabric 提供了 `MinecraftClient.runDirectory`（就是游戏目录），Mod 自己就能定位，
**不需要启动器额外注入 JVM 参数** —— 这样启动器不必改启动参数组装逻辑，
也不会因为参数拼错而起不来。

## 文件说明

```
companion-mod/
├── build.gradle                  Fabric Loom 构建脚本
├── settings.gradle               仓库源（Fabric maven）
├── gradle.properties             ← 改这里填版本号
└── src/main/
    ├── java/com/pebble/lunchar/metrics/PebbleMetricsClient.java   采集 + HUD
    └── resources/
        ├── fabric.mod.json       Mod 元数据与入口点
        └── assets/pebble-metrics/lang/{zh_cn,en_us}.json          按键名翻译
```

## 已知未验证的地方

以下几处最可能因 MC 版本不同而需要微调，都在 `PebbleMetricsClient.java` 里：

| 位置 | 说明 |
|---|---|
| `HudRenderCallback` 的 lambda 签名 | 不同版本 `drawContext` 的类型/参数个数变过 |
| `client.world.getChunkManager().getLoadedChunkCount()` | 方法名在个别版本里叫法不同 |
| `world.getRegularEntityCount()` | 同上；也可以用 `Iterable` 遍历自行计数 |
| `drawContext.drawTextWithShadow` | 老版本叫 `drawTextWithShadow`，更老的是 `drawText` |
| `KeyBinding` 构造参数 | 新版本多了一个分类 `Category` 对象参数 |

改这些**不影响协议**，启动器侧不用跟着动。
