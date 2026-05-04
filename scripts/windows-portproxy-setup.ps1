# nhack-premium v1.6.0 — Windows portproxy セットアップ
# WSL内 Claude Code から Windows 側 Chrome (CDP) への接続を可能にする。
#
# 何をするスクリプト?
#   Windows Chrome は CDP（--remote-debugging-port=18801）を 127.0.0.1 でしか listen しないため、
#   WSL2 からそのままでは到達できない。netsh portproxy で Windows 側の 0.0.0.0:18801 を
#   127.0.0.1:18801 に転送し、WSL から $env:COMPUTERNAME:18801 で繋がるようにする。
#
# Optin式: クラの info.md に `os: windows` フラグを立てた時のみ凛が案内する。
# 既存壊さない4原則: 既存ファイルは1行も触らない。netsh portproxy 設定のみ追加。
#
# 必須: 管理者 PowerShell（一般 PowerShell では netsh interface portproxy 不可）。
#
# 使い方:
#   # 標準（WSL→Windows、127.0.0.1 へ転送）
#   .\windows-portproxy-setup.ps1
#
#   # ポート変更
#   .\windows-portproxy-setup.ps1 -Port 18802
#
#   # 転送先を明示（WSL 内 Chrome に向けたい等の特殊ケース）
#   .\windows-portproxy-setup.ps1 -ConnectAddress 172.21.224.1

[CmdletBinding()]
param(
  [int]$Port = 18801,
  [string]$ListenAddress = '0.0.0.0',
  [string]$ConnectAddress = '127.0.0.1',
  [int]$ConnectPort = 0,
  [switch]$SkipFirewall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

if ($ConnectPort -eq 0) { $ConnectPort = $Port }

function Write-Info  { param([string]$Message) Write-Host "[INFO]  $Message" -ForegroundColor Cyan }
function Write-Ok    { param([string]$Message) Write-Host "[OK]    $Message" -ForegroundColor Green }
function Write-Warn2 { param([string]$Message) Write-Host "[WARN]  $Message" -ForegroundColor Yellow }
function Write-Err   { param([string]$Message) Write-Host "[ERROR] $Message" -ForegroundColor Red }

# ────────────────────────────────────────────
# 1. 管理者権限チェック
# ────────────────────────────────────────────
$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Err '管理者 PowerShell で実行してください。'
  Write-Err 'スタートメニュー → "PowerShell" を右クリック → 「管理者として実行」。'
  exit 1
}
Write-Ok '管理者権限を確認しました。'

# ────────────────────────────────────────────
# 2. IPv6 有効化（portproxy v4tov4 の前提）
# ────────────────────────────────────────────
try {
  $null = Get-NetAdapterBinding -ComponentID ms_tcpip6 -ErrorAction SilentlyContinue
} catch {
  Write-Warn2 "IPv6 状態の確認に失敗しました（続行します）: $($_.Exception.Message)"
}

# ────────────────────────────────────────────
# 3. 既存 portproxy 設定の確認・削除（上書き運用）
# ────────────────────────────────────────────
Write-Info "既存 portproxy 設定を確認します（listen $ListenAddress`:$Port）。"
$existing = & netsh interface portproxy show v4tov4 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Err 'netsh interface portproxy が利用できません。Windows 機能の不足の可能性があります。'
  exit 1
}

$existingMatch = $existing | Select-String -SimpleMatch -Pattern ("{0}" -f $Port)
if ($existingMatch) {
  Write-Warn2 "ポート $Port の既存設定を検出。削除して上書きします。"
  & netsh interface portproxy delete v4tov4 listenport=$Port listenaddress=$ListenAddress 2>&1 | Out-Null
}

# ────────────────────────────────────────────
# 4. portproxy 追加
# ────────────────────────────────────────────
Write-Info "portproxy を追加します: $ListenAddress`:$Port -> $ConnectAddress`:$ConnectPort"
& netsh interface portproxy add v4tov4 `
    listenport=$Port `
    listenaddress=$ListenAddress `
    connectport=$ConnectPort `
    connectaddress=$ConnectAddress 2>&1 | Out-Null

if ($LASTEXITCODE -ne 0) {
  Write-Err "portproxy の追加に失敗しました（exit=$LASTEXITCODE）。"
  Write-Err '既存ルールが残っている可能性があります。windows-portproxy-uninstall.ps1 で全削除してから再実行してください。'
  exit 1
}
Write-Ok 'portproxy を追加しました。'

# ────────────────────────────────────────────
# 5. ファイアウォール許可（受信）
# ────────────────────────────────────────────
if (-not $SkipFirewall) {
  $ruleName = "nhack-premium CDP portproxy ($Port)"
  try {
    $existingRule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    if ($existingRule) {
      Write-Info "ファイアウォール規則 '$ruleName' は既に存在します。"
    } else {
      New-NetFirewallRule -DisplayName $ruleName `
        -Direction Inbound -Protocol TCP -LocalPort $Port `
        -Action Allow -Profile Any -ErrorAction Stop | Out-Null
      Write-Ok "ファイアウォール規則 '$ruleName' を追加しました（TCP $Port 受信許可）。"
    }
  } catch {
    Write-Warn2 "ファイアウォール規則の追加に失敗しました（続行します）: $($_.Exception.Message)"
    Write-Warn2 'アンチウイルスソフト（McAfee/Norton/ESET 等）が干渉している可能性があります。'
  }
} else {
  Write-Info '-SkipFirewall 指定のためファイアウォール設定をスキップしました。'
}

# ────────────────────────────────────────────
# 6. 動作確認（現在の設定を表示）
# ────────────────────────────────────────────
Write-Info '現在の portproxy 設定:'
& netsh interface portproxy show all

Write-Host ''
Write-Ok 'セットアップ完了。WSL から接続テストできます。'
Write-Host ''
Write-Host '  # WSL 内で:' -ForegroundColor DarkGray
Write-Host "  WIN_HOST=`$(ip route show default | awk '{print `$3}')" -ForegroundColor DarkGray
Write-Host "  curl -s http://`$WIN_HOST`:$Port/json/version" -ForegroundColor DarkGray
Write-Host ''
Write-Host 'Chrome が CDP で起動していれば JSON が返ります。' -ForegroundColor DarkGray
exit 0
