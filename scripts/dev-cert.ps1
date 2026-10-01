#requires -version 5.1
<#
.SYNOPSIS
  Pebble Lunchar 开发/内测用自签名代码签名证书的生成、信任与清理。

.DESCRIPTION
  生成一张自签名代码签名证书，并把它装进信任存储，让「装了这张证书的机器」认可用它签出来的 exe。

  【必须先看清楚的事实】
  自签名证书不是 CA 签发的，微软官方对 Smart App Control 的口径是：只放行「根证书在
  Microsoft Trusted Root Program 里的 CA」签发的证书 —— 自签名不在其中。
  本脚本提供的是一条民间做法：把自签根证书装进「受信任的根证书颁发机构」，寄希望于本机的
  代码完整性校验能找到一条可信链。到底管不管用请用 scripts/sac-probe.ps1 实测，别当保票。

    它对内测有用、对发行没用：
      · 有效范围 = 你手动装过这张根证书的机器（你自己 + 愿意配合的朋友）
      · 对普通用户的机器一律无效，发行仍然只能买 OV/EV 证书或走 SignPath Foundation

.USAGE
  # A. 生成证书 + 信任到「当前用户」（无需管理员）
  powershell -ExecutionPolicy Bypass -File scripts\dev-cert.ps1

  # B. 再信任到「本机」（SAC 走内核代码完整性校验，真正需要的是这一层，必须管理员）
  powershell -ExecutionPolicy Bypass -File scripts\dev-cert.ps1 -Machine

  # C. 查看状态
  powershell -ExecutionPolicy Bypass -File scripts\dev-cert.ps1 -Status

  # D. 删干净（证书 + 四个存储里的根 + .signing 目录）
  powershell -ExecutionPolicy Bypass -File scripts\dev-cert.ps1 -Remove
#>
param(
  [switch]$Machine,
  [switch]$Remove,
  [switch]$Status,
  [string]$Subject = 'CN=Pebble Lunchar Dev, O=Felix, C=CN',
  [int]$Years = 3
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root       = Split-Path -Parent $PSScriptRoot
$SigningDir = Join-Path $Root '.signing'
$CerPath    = Join-Path $SigningDir 'dev-cert.cer'
$ThumbPath  = Join-Path $SigningDir 'dev-thumbprint.txt'
$InfoPath   = Join-Path $SigningDir 'dev-cert-info.txt'

function Is-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-DevCert {
  Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
    Where-Object { ($_.Subject -eq $Subject) -and $_.HasPrivateKey } |
    Sort-Object NotAfter -Descending | Select-Object -First 1
}

function Test-Rooted($Thumb, [string]$Store, [string]$Location) {
  try {
    return [bool](Get-ChildItem "Cert:\$Location\$Store" -ErrorAction SilentlyContinue |
      Where-Object { $_.Thumbprint -eq $Thumb })
  } catch { return $false }
}

function Add-Store([string]$Store, [string]$Location, [string]$Path) {
  # 两个坑：
  #  1) 不能用 $args（PowerShell 自动变量），换名。
  #  2) certutil 把正常输出写到 stderr，在 $ErrorActionPreference='Stop' 下用 2>&1 重定向
  #     会被转成 NativeCommandError 终止错误 —— 命令其实执行成功了，脚本却挂掉。
  #     所以这里临时把 EAP 调回 Continue，只认 $LASTEXITCODE。
  $cargs = @()
  if ($Location -ne 'LocalMachine') { $cargs += '-user' }
  $cargs += @('-addstore', '-f', $Store, $Path)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $out = (& certutil @cargs 2>&1 | Out-String)
  $rc = $LASTEXITCODE
  $ErrorActionPreference = $prev
  if ($rc -ne 0) { throw "certutil 添加 $Location\$Store 失败 (rc=$rc): $($out.Trim())" }
}

function Remove-Store([string]$Store, [string]$Location, [string]$Thumb) {
  $target = Get-ChildItem "Cert:\$Location\$Store" -ErrorAction SilentlyContinue |
    Where-Object { $_.Thumbprint -eq $Thumb }
  if ($target) { Remove-Item -LiteralPath $target.PSPath -Force -ErrorAction SilentlyContinue }
}

# ---------------------------------------------------------------- Status
function Show-Status {
  Write-Output '== 开发证书状态 =='
  $cert = Get-DevCert
  if (-not $cert) {
    Write-Output '  证书 : 未生成（跑本脚本不带参数即可生成）'
  } else {
    Write-Output "  证书 : $($cert.Subject)"
    Write-Output "  指纹 : $($cert.Thumbprint)"
    Write-Output "  有效期: $($cert.NotBefore.ToString('yyyy-MM-dd')) ~ $($cert.NotAfter.ToString('yyyy-MM-dd'))"
  }
  Write-Output ('  管理员: ' + (Is-Admin))
  if ($cert) {
    $t = $cert.Thumbprint
    Write-Output "  信任位置:"
    foreach ($loc in @('CurrentUser', 'LocalMachine')) {
      foreach ($store in @('Root', 'TrustedPublisher')) {
        $ok = Test-Rooted $t $store $loc
        Write-Output ("    {0,-14} {1,-16} {2}" -f $loc, $store, $(if ($ok) { '已信任' } else { '未信任' }))
      }
    }
  }
  try {
    $sac = (Get-MpComputerStatus).SmartAppControlState
    Write-Output "  Smart App Control: $sac"
  } catch {
    Write-Output '  Smart App Control: 读取失败'
  }
}

# ---------------------------------------------------------------- Create
function New-DevCert {
  New-Item -ItemType Directory -Force -Path $SigningDir | Out-Null
  $cert = Get-DevCert
  if ($cert) {
    Write-Output "已有证书，复用: $($cert.Thumbprint)"
  } else {
    Write-Output '生成自签名代码签名证书…'
    $cert = New-SelfSignedCertificate `
      -Type CodeSigningCert `
      -Subject $Subject `
      -CertStoreLocation 'Cert:\CurrentUser\My' `
      -KeyUsage DigitalSignature `
      -KeyExportPolicy Exportable `
      -KeyAlgorithm RSA -KeyLength 3072 `
      -HashAlgorithm SHA256 `
      -NotAfter (Get-Date).AddYears($Years)
    Write-Output "  已生成: $($cert.Thumbprint)"
  }

  Export-Certificate -Cert $cert -FilePath $CerPath -Type CERT | Out-Null
  Set-Content -Path $ThumbPath -Value $cert.Thumbprint -Encoding ascii

  $lines = @(
    "Subject    : $($cert.Subject)"
    "Thumbprint : $($cert.Thumbprint)"
    "NotBefore  : $($cert.NotBefore.ToString('o'))"
    "NotAfter   : $($cert.NotAfter.ToString('o'))"
    "CertFile   : $CerPath"
    ''
    '给别人用：把 dev-cert.cer 发过去，对方双击 → 安装证书 → 本地计算机 → 受信任的根证书颁发机构。'
    '或者对方管理员跑：certutil -addstore Root dev-cert.cer'
  )
  Set-Content -Path $InfoPath -Value $lines -Encoding utf8

  Write-Output ''
  Write-Output '信任到「当前用户」…'
  Add-Store 'Root' 'CurrentUser' $CerPath
  Add-Store 'TrustedPublisher' 'CurrentUser' $CerPath
  Write-Output '  完成'
}

# ---------------------------------------------------------------- Machine
function Add-MachineTrust {
  if (-not (Test-Path $CerPath)) { throw '还没生成证书，先跑一次不带参数的脚本' }
  if (-not (Is-Admin)) {
    Write-Output '需要管理员权限才能写入「本机」信任存储。'
    Write-Output '请右键「Windows 终端(管理员)」或「PowerShell(管理员)」后重跑：'
    Write-Output "  powershell -ExecutionPolicy Bypass -File `"$PSScriptRoot\dev-cert.ps1`" -Machine"
    exit 3
  }
  Write-Output '信任到「本机」（SAC 真正看这一层）…'
  Add-Store 'Root' 'LocalMachine' $CerPath
  Add-Store 'TrustedPublisher' 'LocalMachine' $CerPath
  Write-Output '  完成'
  Add-Content -Path $InfoPath -Encoding utf8 -Value "MachineTrust: $(Get-Date -Format o)"
}

# ---------------------------------------------------------------- Remove
function Remove-All {
  $cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
    Where-Object { $_.Subject -eq $Subject }
  if ($cert) {
    foreach ($c in $cert) {
      $t = $c.Thumbprint
      foreach ($store in @('Root', 'TrustedPublisher')) {
        Remove-Store $store 'CurrentUser' $t
        if (Is-Admin) { Remove-Store $store 'LocalMachine' $t }
      }
      Remove-Item -LiteralPath $c.PSPath -Force
      Write-Output "已删除: $t"
    }
  } else {
    Write-Output '没有找到匹配的证书'
  }
  if (Test-Path $SigningDir) { Remove-Item $SigningDir -Recurse -Force; Write-Output '已删除 .signing 目录' }
}

# ---------------------------------------------------------------- 入口
if ($Status) { Show-Status; exit 0 }
if ($Remove) { Remove-All; exit 0 }
if ($Machine) { Add-MachineTrust; Show-Status; exit 0 }
New-DevCert
Write-Output ''
Show-Status
