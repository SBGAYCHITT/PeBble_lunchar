// 干跑排障工具：用本机真实 .minecraft 组装某个版本的启动命令，不 spawn 进程。
// 用法： node scripts/launch-dryrun.js [versionId=26.3-forge-66.0.4]
// 结果写到项目根 _forge_dryrun.txt（含逐项断言），便于确认 jar 解析与参数拼接是否正常。
const path = require('path');
const L = require('../launcher');

const mcDir = path.join(process.env.APPDATA, '.minecraft');
const version = process.argv[2] || '26.3-forge-66.0.4';

(async () => {
  const lines = [];
  const log = (s) => lines.push(s);

  const r = await L.launchGame({
    version, mcDir,
    javaPath: process.execPath,   // 只为通过「java 路径有效」校验；dryRun 不会真的启动
    maxMemMB: 4096,
    dryRun: true,
    account: { type: 'offline', name: 'Steve' },
    width: 1280, height: 720
  }, log);

  lines.push('');
  lines.push('=== 结果 ===');
  if (!r.ok) { lines.push('失败: ' + r.error); }
  else {
    lines.push('mainClass : ' + r.mainClass);
    lines.push('clientJar : ' + r.clientJar);
    const a = r.args;
    const idxCp = a.lastIndexOf('-cp');
    lines.push('cp 项数    : ' + (idxCp >= 0 ? a[idxCp + 1].split(';').length : 0));
    lines.push('-cp 出现次数: ' + (a.indexOf('-cp') === a.lastIndexOf('-cp') ? 1 : 2 + '（重复！）'));
    lines.push('');
    lines.push('=== 关键参数检查 ===');
    const has = (s) => a.some((x) => String(x).includes(s));
    const checks = [
      ['客户端 jar 指向父版本 26.3', String(r.clientJar).endsWith('26.3' + path.sep + '26.3.jar')],
      ['mainClass 是 Forge 的', r.mainClass === 'net.minecraftforge.bootstrap.ForgeBootstrap'],
      ['--launchTarget forge_client', a.includes('--launchTarget') && a.includes('forge_client')],
      ['--username Steve（父版本参数没丢）', a.includes('--username') && a.includes('Steve')],
      ['--gameDir', has('--gameDir')],
      ['--assetsDir', has('--assetsDir')],
      ['--assetIndex 34', a.includes('--assetIndex') && a.includes('34')],
      ['--uuid', a.includes('--uuid')],
      ['-Djava.library.path=...+java', a.some((x) => x.startsWith('-Djava.library.path=') && x.endsWith('/java'))],
      ['-Dminecraft.launcher.version=3.0.0', a.includes('-Dminecraft.launcher.version=3.0.0')],
      ['--add-exports（父版本 jvm 没丢）', has('--add-exports')],
      ['无残留 ${ 占位符', !a.some((x) => String(x).includes('${'))],
      ['无重复 -cp', a.indexOf('-cp') === a.lastIndexOf('-cp')],
      ['-cp 在 mainClass 之前', a.indexOf('-cp') < a.indexOf(r.mainClass)]
    ];
    for (const [name, ok] of checks) lines.push((ok ? '  OK   ' : '  FAIL ') + name);
    lines.push('');
    lines.push('缺库警告: ' + ((lines.find((l) => l.includes('警告: 缺少'))) || '无'));
  }
  lines.push('');
  lines.push('--- 启动器日志（上面）---');

  require('fs').writeFileSync(path.join(__dirname, '..', '_forge_dryrun.txt'), lines.join('\n'), 'utf8');
  console.log('done ok=' + r.ok);
})();
