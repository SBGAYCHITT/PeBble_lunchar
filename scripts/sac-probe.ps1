#requires -version 5.1
<#
.SYNOPSIS
  判定「签名能不能让 Smart App Control 放行」，并以 SAC 自己的事件日志作为判据。

.DESCRIPTION
  为什么不用随便编译一个小程序来测：小的 .NET 程序 SAC 根本不评估（实测四格全部放行），
  结论不可外推。所以这里改用**和你产物同一族的原生二进制** —— Electron 自带的
  electron.exe（官方发布就是未签名的），复制两份，一份保持原样、一份用开发证书签，
  各跑一次，再用 CodeIntegrity 事件日志判断有没有被拦。

  判读：
    未签名被拦 + 已签名放行 → 自签名（在当前信任层级）有效
    两个都放行             → SAC 当前没拦这类程序；签名仍是发行必需品（用户体验/信任）
    两个都被拦             → 当前信任层级不够，需要管理员把根证书装进「本机」存储

.USAGE
  powershell -ExecutionPolicy Bypass -File scripts\sac-probe.ps1
#>
param(
  [string]$OutDir = (Join-Path $env:TEMP 'pl-sac-probe'),
  [int]$WaitMs = 15000
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Split-Path -Parent $PSScriptRoot
$Node = (Get-Content (Join-Path $Root '.signing\node-path.txt') -ErrorAction SilentlyContinue)
if (-not $Node) { $Node = 'node' }
$Electron = Join-Path $Root 'node_modules\electron\dist\electron.exe'

function Say($s) { Write-Output $s }

function Get-CiBaseline {
  try {
    return (Get-WinEvent -LogName 'Microsoft-Windows-CodeIntegrity/Operational' -MaxEvents 1 -ErrorAction Stop).RecordId
  } catch { return 0 }
}

function Get-CiNew([int]$Baseline) {
  try {
    return @(Get-WinEvent -FilterHashtable @{
        LogName = 'Microsoft-Windows-CodeIntegrity/Operational'
        Id      = 3077, 3033, 3118
      } -ErrorAction Stop | Where-Object { $_.RecordId -gt $Baseline })
  } catch { return @() }
}

function Invoke-Target([string]$Path, [int]$Ms) {
  $base = Get-CiBaseline
  $err = $null
  $code = $null
  # 不用 -RedirectStandardOutput：本机环境块里存在只有大小写不同的重复变量
  # （PATH/Path、HTTP_PROXY/http_proxy），重定向路径会因此报「字典中已添加了相同的键」。
  # 判据改用退出码 + CodeIntegrity 事件日志，足够。
  try {
    $p = Start-Process -FilePath $Path -ArgumentList '--version' -PassThru -Wait -ErrorAction Stop
    $code = $p.ExitCode
  } catch {
    $err = $_.Exception.Message.Split([char]10)[0]
  }
  Start-Sleep -Milliseconds 500
  $new = Get-CiNew $base
  return [pscustomobject]@{
    Exit   = $code
    Error  = $err
    Blocks = @($new | Where-Object { $_.Message -match [regex]::Escape((Split-Path $Path -Leaf)) })
  }
}

Say '== Smart App Control 判定（原生 Electron 二进制 + 事件日志） =='

if (-not (Test-Path $Electron)) {
  Say "  找不到 electron.exe: $Electron"
  Say '  先跑 npm install / npm run pack'
  exit 1
}
Say "  基准二进制: $Electron"

if (Test-Path $OutDir) { Remove-Item $OutDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$unsigned = Join-Path $OutDir 'pl-native-unsigned.exe'
$signed   = Join-Path $OutDir 'pl-native-signed.exe'
Copy-Item $Electron $unsigned -Force
Copy-Item $Electron $signed   -Force

$before = Get-AuthenticodeSignature $unsigned
Say "  未签名副本签名状态: $($before.Status)"

Say ''
Say '  用开发证书签名另一份（顺便验证 scripts/sign.js 可用）…'
$signLog = Join-Path $OutDir 'sign.txt'
& $Node (Join-Path $Root 'scripts\sign.js') --dev --targets $signed 2>&1 | Out-File -Encoding utf8 $signLog
Say "    sign.js 退出码: $LASTEXITCODE"
Get-Content $signLog -ErrorAction SilentlyContinue | ForEach-Object { Say ('    ' + $_) }
$after = Get-AuthenticodeSignature $signed
Say "    已签名副本签名状态: $($after.Status)"
if ($after.SignerCertificate) { Say "    签署者: $($after.SignerCertificate.Subject)" }

Say ''
Say '  运行未签名副本…'
$r0 = Invoke-Target $unsigned $WaitMs
Say ("    退出码=" + $r0.Exit  + "  新拦截事件=" + $r0.Blocks.Count)
if ($r0.Error) { Say ('    报错: ' + $r0.Error) }
foreach ($b in $r0.Blocks) { Say ("      id=" + $b.Id + " " + ($b.Message -replace "`r?`n", ' ').Substring(0, [Math]::Min(200, ($b.Message -replace "`r?`n", ' ').Length))) }

Say '  运行已签名副本…'
$r1 = Invoke-Target $signed $WaitMs
Say ("    退出码=" + $r1.Exit  + "  新拦截事件=" + $r1.Blocks.Count)
if ($r1.Error) { Say ('    报错: ' + $r1.Error) }
foreach ($b in $r1.Blocks) { Say ("      id=" + $b.Id + " " + ($b.Message -replace "`r?`n", ' ').Substring(0, [Math]::Min(200, ($b.Message -replace "`r?`n", ' ').Length))) }

$uOk = ($r0.Exit -eq 0) -and ($r0.Blocks.Count -eq 0)
$sOk = ($r1.Exit -eq 0) -and ($r1.Blocks.Count -eq 0)

Say ''
Say '== 判读 =='
Say ("  未签名 : " + $(if ($uOk) { '放行' } else { '被拦' }))
Say ("  已签名 : " + $(if ($sOk) { '放行' } else { '被拦' }))
Say ''
if ($uOk -and $sOk) {
  Say '  → 两者都放行：本机 SAC 当前不拦这类「本地生成、非下载」的原生程序。'
  Say '    也就是说本机能跑不代表用户机器能跑 —— 用户那份是「下载」来的，路径完全不同。'
  Say '    结论：签名对发行仍是必需的（消除未签名警告 + 建立发布者信誉），但别再指望它当本机的解法。'
} elseif (-not $uOk -and $sOk) {
  Say '  → 未签名被拦、自签名放行：【自签名在当前信任层级下有效】。'
  Say '    本机（以及手动装过 .signing\dev-cert.cer 的机器）可以开着 SAC 跑你的产物。'
} elseif (-not $uOk -and -not $sOk) {
  Say '  → 自签名也拦：当前信任层级不够。'
  Say '    管理员跑 scripts\dev-cert.ps1 -Machine 把根证书装进「本机」存储，再重测。'
} else {
  Say '  → 未签名放行、签名后被拦：签名本身可疑（吊销/链不完整），把上面的 sign.js 输出贴出来。'
}

Say ''
Say "  探针文件保留在: $OutDir"
