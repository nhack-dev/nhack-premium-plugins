# nhack-premium v1.6.0 — Windows portproxy アンインストール
# windows-portproxy-setup.ps1 で追加した portproxy 設定とファイアウォール規則を削除する。
#
# 使い方:
#   # 標準（ポート 18801 の portproxy とファイアウォール規則を削除）
#   .\windows-portproxy-uninstall.ps1
#
#   # 別ポートで設定した場合
#   .\windows-portproxy-uninstall.ps1 -Port 18802
#
# 必須: 管理者 PowerShell。

[CmdletBinding()]
param(
  [int]$Port = 18801,
  [string]$ListenAddress = '0.0.0.0',
  [switch]$KeepFirewall
)

$ErrorActionPreference = 'Continue'
Set-StrictMode -Version 3.0

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
  exit 1
}
Write-Ok '管理者権限を確認しました。'

# ────────────────────────────────────────────
# 2. portproxy 削除
# ────────────────────────────────────────────
Write-Info "portproxy 設定を削除します（listen $ListenAddress`:$Port）。"
& netsh interface portproxy delete v4tov4 listenport=$Port listenaddress=$ListenAddress 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
  Write-Ok 'portproxy を削除しました。'
} else {
  Write-Warn2 'portproxy の削除に失敗しました（既に削除済みの可能性）。'
}

# ────────────────────────────────────────────
# 3. ファイアウォール規則削除
# ────────────────────────────────────────────
if (-not $KeepFirewall) {
  $ruleName = "nhack-premium CDP portproxy ($Port)"
  try {
    $rule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    if ($rule) {
      Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction Stop
      Write-Ok "ファイアウォール規則 '$ruleName' を削除しました。"
    } else {
      Write-Info "ファイアウォール規則 '$ruleName' は存在しません。"
    }
  } catch {
    Write-Warn2 "ファイアウォール規則の削除に失敗しました: $($_.Exception.Message)"
  }
} else {
  Write-Info '-KeepFirewall 指定のためファイアウォール規則を残します。'
}

# ────────────────────────────────────────────
# 4. 残存設定確認
# ────────────────────────────────────────────
Write-Info '現在の portproxy 設定:'
& netsh interface portproxy show all

Write-Host ''
Write-Ok 'アンインストール完了。'
exit 0
