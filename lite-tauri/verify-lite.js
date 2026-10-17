/* Pebble Lunchar Lite（Tauri 版）产物核验
 *
 * 为什么要这么写：这台机器上没有任何可用的 Java（.minecraft/runtime 里的 java.exe 是
 * 0 字节占位），所以「真的把游戏拉起来」这一步无法验证。退一步核验两件确定的事：
 *   1. 启动命令行拼得对不对（读 --dry-run 的输出，逐条断言）
 *   2. natives 有没有真解出来（直接查文件系统）
 * 参数拼装是整个启动器唯一「错了就闪退、且难查」的地方，这两项正好覆盖它。
 *
 * 用法（在 lite-tauri/ 下）：
 *   target/release/pebble-lunchar-lite.exe --dry-run <游戏目录> <版本 id> target/dry-<版本>.json
 *   node verify-lite.js
 * 注意：本脚本不自己去 spawn exe —— 沙箱会拦 node 的子进程调用（EBUSY）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const MCD = path.join(os.homedir(), 'AppData/Roaming/.minecraft');
// 相对脚本自身而不是 cwd：否则在仓库根目录跑会报「exe 不存在」，
// 看起来像产物没编出来，其实只是找错了地方。
const EXE = path.join(__dirname, 'target', 'release', 'pebble-lunchar-lite.exe');

let pass = 0, fail = 0;
const ok = (m) => { console.log('  ok   ' + m); pass++; };
const no = (m) => { console.log('  FAIL ' + m); fail++; };
const chk = (c, m) => (c ? ok(m) : no(m));

// ---------- 产物本身 ----------
console.log('=== 产物 ===');
if (!fs.existsSync(EXE)) {
  no('exe 不存在: ' + EXE + '（先 npm run lite:tauri）');
  process.exit(1);
}
const size = fs.statSync(EXE).size;
// dist-lite7/Pebble-Lunchar-Lite.exe —— 上一版 Electron 版 Lite，这才是要对比的对象。
// （不要拿 dist7/Pebble-Lunchar.exe 的 78.9 MB 比，那是全功能版。）
const LITE_OLD = 67209968;
chk(size < 15 * 1048576, 'exe ' + (size / 1048576).toFixed(2) + ' MB（< 15 MB）');
console.log('  对比      上一版 Lite（Electron）' + (LITE_OLD / 1048576).toFixed(1)
  + ' MB → 本版 ' + (size / 1048576).toFixed(2) + ' MB，缩小到 '
  + (size / LITE_OLD * 100).toFixed(1) + '%');
console.log('');

// ---------- 逐个版本 ----------
const TARGET = path.join(__dirname, 'target');
const files = fs.readdirSync(TARGET).filter((f) => /^dry-.*\.json$/.test(f)).sort();
if (!files.length) { no('没有 dry-*.json，先按注释里的命令生成'); process.exit(1); }

for (const f of files) {
  const vid = f.replace(/^dry-/, '').replace(/\.json$/, '');
  console.log('=== ' + vid + ' ===');
  const d = JSON.parse(fs.readFileSync(path.join(TARGET, f), 'utf8'));
  if (d.error) { no('启动器报错: ' + d.error); console.log(''); continue; }

  const args = d.args || [];
  const has = (s) => args.includes(s);
  const idxOf = (s) => args.indexOf(s);
  const after = (s) => (idxOf(s) >= 0 ? args[idxOf(s) + 1] : undefined);

  chk(args.length > 30, '参数 ' + args.length + ' 条');
  chk(d.classpath_count > 5, 'classpath ' + d.classpath_count + ' 项');
  chk(has('-Xmx4G'), '内存参数 -Xmx4G');

  const isForge = vid.includes('forge');
  const mc = isForge ? 'net.minecraftforge.bootstrap.ForgeBootstrap'
                     : 'net.minecraft.client.main.Main';
  chk(has(mc), '主类 ' + mc);
  // 关键回归：Forge 的 arguments 是增量，要拼接而不是替换。
  // 一旦丢父版本参数，-cp 就会消失（或跑到主类后面），游戏必然闪退。
  chk(idxOf('-cp') >= 0 && idxOf('-cp') < idxOf(mc), '-cp 存在且在主类之前');

  for (const flag of ['--username', '--version', '--gameDir', '--assetsDir',
                      '--assetIndex', '--uuid', '--accessToken', '--versionType']) {
    chk(has(flag), flag + (has(flag) ? ' = ' + String(after(flag)).slice(0, 44) : ''));
  }
  chk(after('--username') === 'DryRunPlayer', '--username = DryRunPlayer');
  const uuid = after('--uuid') || '';
  chk(/^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid),
    '离线 UUID 为合法变体 3: ' + uuid);
  chk(after('--gameDir') === MCD, '--gameDir 指向 ' + MCD);
  chk(after('--assetIndex') === '34', '--assetIndex = 34（与 JSON 的 assetIndex.id 一致）');
  chk(args.filter((a) => a === '--assetIndex').length === 1, '--assetIndex 没有重复');

  if (isForge) {
    chk(after('--launchTarget') === 'forge_client', 'Forge 增量参数 --launchTarget forge_client 已追加');
    chk(has('-XX:+UseCompactObjectHeaders'), 'Forge 增量 JVM 开关已追加');
    chk(has('-Djava.net.preferIPv6Addresses=system'), '父版本 JVM 参数未丢失');
  }

  chk(!has('--quickPlayMultiplayer'), 'features 条件参数已跳过（quickPlay）');
  chk(!args.some((a) => /\$\{/.test(a)), '没有残留未替换的 ${} 占位符');
  chk(!args.some((a) => /natives-(macos|linux)/.test(a)), '没有混入非 Windows 的 natives');

  // 关键回归 2：Mojang 的 rules 只写 `os.name == windows`，不写 `os.arch`，
  // 所以 `natives-windows-arm64` 在 x64 机器上也会「通过检查」。若不过滤，
  // 它解出来的同名 DLL 会压过 x64 版本 → 游戏 UnsatisfiedLinkError。
  const cpStr = after('-cp') || '';
  const armInCp = cpStr.split(';').filter((x) => /arm64/i.test(x));
  chk(armInCp.length === 0, 'classpath 里没有 arm64 natives（实为 '
    + armInCp.length + ' 条' + (armInCp.length ? '：' + armInCp[0].split('\\').pop() : '') + '）');
  chk(has('--width') && has('--height'), '分辨率参数已补');

  if (d.warnings && d.warnings.length) console.log('  warn ' + d.warnings.join('\n         '));

  // natives 实解结果
  const nd = d.natives_dir;
  if (!fs.existsSync(nd)) { no('natives 目录不存在: ' + nd); console.log(''); continue; }
  const walk = (dir) => {
    let n = 0; const names = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { const r = walk(path.join(dir, e.name)); n += r.n; names.push(...r.names); }
      else if (/\.dll$/i.test(e.name)) { n++; names.push(e.name); }
    }
    return { n, names };
  };
  const r = walk(nd);
  chk(r.n > 5, '解出 ' + r.n + ' 个 dll：' + r.names.slice(0, 6).join(', '));
  for (const sub of ['java', 'jna', 'lwjgl', 'netty']) {
    const p = path.join(nd, sub);
    const c = fs.existsSync(p) ? fs.readdirSync(p).filter((x) => /\.dll$/i.test(x)).length : -1;
    chk(c > 5, 'natives/' + sub + ' 里 ' + c + ' 个 dll（新版 -D 参数指向它）');
  }
  // 非本机架构的残留子目录（windows/arm64）不该存在
  const osDirs = ['windows', 'macos', 'linux'].filter((x) => fs.existsSync(path.join(nd, x)));
  let foreign = [];
  for (const od of osDirs) {
    for (const e of fs.readdirSync(path.join(nd, od), { withFileTypes: true })) {
      if (e.isDirectory() && /^(arm64|x86|amd64)$/i.test(e.name)) foreign.push(od + '/' + e.name);
    }
  }
  chk(foreign.length === 0, '没留下非本机架构的 natives 目录'
    + (foreign.length ? '（残留 ' + foreign.join(', ') + '）' : ''));

  // 最直接的证据：扁平目录里的 DLL 必须全是 x64（读 PE 头 Machine 字段）。
  // 这一条才是真正证明「架构过滤生效」的断言。
  const machineOf = (p) => {
    const b = Buffer.alloc(4); const fd = fs.openSync(p, 'r');
    try {
      fs.readSync(fd, b, 0, 4, 0x3c); const pe = b.readUInt32LE(0);
      fs.readSync(fd, b, 0, 2, pe + 4); return b.readUInt16LE(0);
    } finally { fs.closeSync(fd); }
  };
  const archName = { 0x8664: 'x64', 0xaa64: 'ARM64', 0x14c: 'x86' };
  const flat = path.join(nd, 'lwjgl');
  if (fs.existsSync(flat)) {
    const tally = {};
    for (const f of fs.readdirSync(flat).filter((x) => /\.dll$/i.test(x))) {
      const m = machineOf(path.join(flat, f));
      const a = archName[m] || ('0x' + m.toString(16));
      (tally[a] = tally[a] || []).push(f);
    }
    const bad = Object.keys(tally).filter((a) => a !== 'x64');
    chk(bad.length === 0, 'lwjgl/ 里 ' + Object.values(tally).flat().length
      + ' 个 dll 全是 x64' + (bad.length ? '（混入了 ' + bad.join('/') + '：'
        + tally[bad[0]].slice(0, 3).join(', ') + '）' : ''));
  }
  console.log('');
}

console.log('============================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
