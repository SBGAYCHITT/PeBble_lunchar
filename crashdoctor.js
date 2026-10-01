// Pebble Lunchar - 本地崩溃诊断规则库
// 设计原则：纯本地正则匹配，不联网、不调 LLM、零成本。
// 规则可众包扩展：往 RULES 里加一条即可，欢迎提 PR。
//
// 每条规则：{ id, name, severity, test: RegExp（对崩溃全文匹配）, advice: [建议文本] }
// severity: 'fatal' | 'error' | 'warn'

const RULES = [
  {
    id: 'java-version',
    name: 'Java 版本不匹配',
    severity: 'fatal',
    test: /Unsupported class file major version (\d+)|Unsupported\.?class\.?version|class file has wrong version/i,
    advice: [
      '这是 Java 版本与游戏版本不匹配（常见于用旧 Java 跑新版本 MC）。',
      'MC 1.20.5 及以上需要 Java 21；1.18–1.20.4 需要 Java 17；1.17 及以下需要 Java 8/16。',
      '到「设置 → Java 路径」指定正确版本的 javaw.exe，或让启动器自动下载对应运行时。'
    ]
  },
  {
    id: 'pixel-format',
    name: '显卡 / OpenGL 初始化失败',
    severity: 'fatal',
    test: /Pixel format not accelerated|Couldn't set pixel format|GLFW error 65543|WGL: The driver does not|Failed to create OpenGL|GLX: Failed to create context|no GL context/i,
    advice: [
      '游戏没能初始化 OpenGL，通常是显卡驱动问题，不是启动器的锅。',
      '请更新显卡驱动（NVIDIA/AMD/Intel 官网下载，不要用 Windows 自动安装的旧驱动）。',
      '集成显卡 + 独显的笔记本：试试在显卡控制面板里强制用高性能显卡运行 javaw.exe。',
      '临时绕过：到「设置」取消「全屏」，把窗口分辨率调小一些再启动。'
    ]
  },
  {
    id: 'out-of-memory',
    name: '内存不足 (OutOfMemoryError)',
    severity: 'fatal',
    test: /OutOfMemoryError|There is insufficient memory|Could not reserve enough space|GC overhead limit exceeded/i,
    advice: [
      '分配给游戏的内存不够，或系统物理内存已被占满。',
      '到「设置」把内存调到 2–4 GB（不要超过物理内存的 60%）。',
      '关掉浏览器等占内存的程序再试；32 位 Java 最多只能用到 1.5 GB，请换 64 位 Java。'
    ]
  },
  {
    id: 'mod-duplicate',
    name: 'Mod 重复 / 冲突',
    severity: 'error',
    test: /DuplicateModsFound|found duplicate mod|Mod ID .* is used by multiple|Duplicate mod|already registered|Conflicting versions found/i,
    advice: [
      '同一个 Mod 装了多份（或不同 Mod 使用了相同的 Mod ID）。',
      '到「Mod」页检查是否有同名/同功能的 Mod 重复，删掉多余的。',
      '特别注意：OptiFine 与 Sodium / Rubidium 类优化 Mod 互斥，不能共存。'
    ]
  },
  {
    id: 'mod-missing-dep',
    name: 'Mod 缺少前置依赖',
    severity: 'error',
    test: /ModResolutionException|Missing mod|requires? .* of version|No matching variant|NoClassDefFoundError|ClassNotFoundException|Mod \S+ requires/i,
    advice: [
      '有 Mod 需要的前置库没装，或装的版本不对。',
      '看日志里 "requires" 后面的名字，去装对应版本的依赖（如 Fabric API、Forge、Kotlin for Forge）。',
      '确认 Mod 的游戏版本与当前版本一致——1.20.1 的 Mod 不能用在 1.20.4 上。'
    ]
  },
  {
    id: 'forge-fabric-mix',
    name: '加载器混用',
    severity: 'error',
    test: /Cannot mix (forge|fabric|neoforge)|(fabric|forge).*loader.*already|KotlinAdapter|incompatible with (forge|fabric)/i,
    advice: [
      'Forge 与 Fabric/Quilt 的 Mod 不能混着装。',
      '确认当前版本只装了对应加载器的 Mod：Forge 版只放 Forge Mod，Fabric 版只放 Fabric Mod。'
    ]
  },
  {
    id: 'natives-missing',
    name: '本地库 (natives) 缺失',
    severity: 'error',
    test: /UnsatisfiedLinkError|no lwjgl.*in java\.library\.path|Failed to locate library|Can't load AMD 64-bit/i,
    advice: [
      '游戏的本地库文件缺失或损坏，通常是 natives 没解压成功。',
      '到「版本」页重新下载该版本，或删掉 versions/<版本>/natives-<版本> 目录让启动器重新解压。'
    ]
  },
  {
    id: 'corrupt-nbt',
    name: '存档 / NBT 数据损坏',
    severity: 'error',
    test: /Corrupt NBT tag|Invalid NBT|Failed to load chunk|Region file.*corrupt|net\.minecraft\.nbt\.NbtIo/i,
    advice: [
      '存档数据损坏了。',
      '先到「存档」页给该存档做个备份，再尝试删除损坏的 region 文件让游戏重新生成。',
      '如果只是单个区块损坏，可用存档健康检查定位具体文件。'
    ]
  },
  {
    id: 'quickplay',
    name: '启动参数冲突',
    severity: 'error',
    test: /Only one quick play option|Unrecognized option|Unrecognized VM option/i,
    advice: [
      '传给游戏的启动参数有冲突或不被识别。',
      '检查「设置 → JVM 参数」里有没有写错的自定义参数，清空后重试。'
    ]
  },
  {
    id: 'auth-failed',
    name: '登录状态失效',
    severity: 'warn',
    test: /Invalid session|AuthenticationException|Failed to verify username|Invalid credentials|401|ForbiddenOperationException/i,
    advice: [
      '账号登录状态过期或失效了。',
      '到「账户」页重新登录一次即可（离线账号则忽略此条，它本来就不能进正版验证服务器）。'
    ]
  },
  {
    id: 'disk-space',
    name: '磁盘空间不足',
    severity: 'fatal',
    test: /No space left on device|There is not enough space|磁盘空间不足/i,
    advice: [
      '磁盘空间不够了，清理一下再试。',
      '检查游戏目录所在盘符的剩余空间（至少要留 2 GB 以上）。'
    ]
  },
  {
    id: 'audio-device',
    name: '音频设备错误',
    severity: 'warn',
    // 注意：不能只匹配 OpenAL —— 正常启动日志里也会出现，必须要求带错误语义
    test: /Unable to open audio|Could not initialize audio|Failed to create OpenAL|OpenAL.*(failed|error)|AL lib:.*error|No audio device/i,
    advice: [
      '音频设备初始化失败，通常不影响进游戏，只是没声音。',
      '检查默认播放设备是否正常；插拔耳机后重启游戏。'
    ]
  }
];

/**
 * 诊断崩溃文本。
 * @param {string} text 崩溃报告全文（或游戏输出日志）
 * @returns {{matched: Array<{id,name,severity,advice:string[],evidence:string}>, primary: object|null, advice: string[]}}
 */
function diagnose(text) {
  const src = String(text || '');
  if (!src.trim()) return { matched: [], primary: null, advice: [] };

  const matched = [];
  for (const r of RULES) {
    const m = src.match(r.test);
    if (m) {
      // 取命中处前后各一行作为证据
      const idx = m.index || 0;
      const from = Math.max(0, src.lastIndexOf('\n', idx) + 1);
      const to = src.indexOf('\n', idx + m[0].length);
      const evidence = src.slice(from, to < 0 ? Math.min(src.length, from + 200) : to).trim();
      matched.push({ id: r.id, name: r.name, severity: r.severity, advice: r.advice, evidence });
    }
  }

  // 按严重度排序：fatal > error > warn
  const order = { fatal: 0, error: 1, warn: 2 };
  matched.sort((a, b) => order[a.severity] - order[b.severity]);

  const primary = matched[0] || null;
  const advice = [];
  const seen = new Set();
  for (const m of matched) for (const a of m.advice) {
    if (!seen.has(a)) { seen.add(a); advice.push(a); }
  }
  return { matched, primary, advice };
}

/**
 * 从崩溃报告里抽取结构化摘要（描述 + 异常首行 + 堆栈顶部若干帧）。
 */
function summarize(text) {
  const src = String(text || '');
  const desc = (src.match(/^Description:\s*(.+)$/m) || [])[1];
  const errLine = (src.split('\n').find((l) => /^[a-zA-Z0-9_.$]+(Exception|Error)\b/.test(l.trim())) || '').trim();
  const stack = src.split('\n')
    .filter((l) => /^\s+at\s+/.test(l))
    .slice(0, 6)
    .map((l) => l.trim());
  return { desc: desc ? desc.trim() : '', err: errLine, stack };
}

module.exports = { diagnose, summarize, RULES };
