# nhack-premium v1.6.0 — CDP watchdog (Windows PowerShell)
# CDP（Chrome DevTools Protocol）接続を監視し、切断時に自動復旧する。
# オプトイン式: CLAUDE.md に `enable_cdp_watchdog: true` を書いた時のみ発動。
#
# 設定（CLAUDE.md or %USERPROFILE%\.cdp-watchdog.conf）:
#   enable_cdp_watchdog: true
#   cdp_port: 18801
#   chrome_profile_name: "Default"
#   chrome_user_data_dir: "C:\Users\<user>\AppData\Local\Google\Chrome\User Data"
#   discord_webhook_url: "https://discord.com/api/webhooks/..."
#
# Windowsの場合 WSL→Windows のCDP接続には portproxy が別途必要（windows-portproxy-setup.ps1 参照）。
# 本スクリプトはWindows側Chrome本体のwatchdogのみを担当する。
#
# ログ: $env:TEMP\cdp-watchdog.log
# 失敗カウンタ: $env:TEMP\cdp-watchdog-fail-count.txt
# 既存壊さない4原則: 既存ファイルは1行も触らない。新規追加のみ。

$ErrorActionPreference = 'Continue'
Set-StrictMode -Version 3.0

$ConfigUser   = Join-Path $env:USERPROFILE '.cdp-watchdog.conf'
$ConfigClaude = if ($env:CDP_WATCHDOG_CLAUDE_MD) { $env:CDP_WATCHDOG_CLAUDE_MD } else { Join-Path $env:USERPROFILE 'CLAUDE.md' }
$LogFile      = if ($env:CDP_WATCHDOG_LOG) { $env:CDP_WATCHDOG_LOG } else { Join-Path $env:TEMP 'cdp-watchdog.log' }
$FailCountFile = if ($env:CDP_WATCHDOG_FAIL_COUNT) { $env:CDP_WATCHDOG_FAIL_COUNT } else { Join-Path $env:TEMP 'cdp-watchdog-fail-count.txt' }
$CriticalThreshold = 3

function Write-WatchdogLog {
  param([Parameter(Mandatory = $true)][string]$Message)
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Add-Content -Path $LogFile -Value $line -ErrorAction SilentlyContinue
}

function Read-ConfigValue {
  param(
    [Parameter(Mandatory = $true)][string]$Key,
    [Parameter(Mandatory = $true)][string]$File
  )
  if (-not (Test-Path -LiteralPath $File)) { return $null }
  $pattern = '^[ \t]*' + [regex]::Escape($Key) + '[ \t]*:[ \t]*(.+?)[ \t]*$'
  $match = Get-Content -LiteralPath $File -ErrorAction SilentlyContinue |
           Select-String -Pattern $pattern |
           Select-Object -First 1
  if (-not $match) { return $null }
  $value = $match.Matches[0].Groups[1].Value
  # コメント・引用符を除去
  $value = $value -replace '\s*#.*$', ''
  $value = $value -replace '^["'']', ''
  $value = $value -replace '["'']$', ''
  return $value.Trim()
}

function Get-Config {
  param(
    [Parameter(Mandatory = $true)][string]$Key,
    [string]$Default = ''
  )
  $v = Read-ConfigValue -Key $Key -File $ConfigUser
  if ([string]::IsNullOrEmpty($v)) {
    $v = Read-ConfigValue -Key $Key -File $ConfigClaude
  }
  if ([string]::IsNullOrEmpty($v)) { return $Default }
  return $v
}

# ────────────────────────────────────────────
# オプトイン判定
# ────────────────────────────────────────────
$enable = Get-Config -Key 'enable_cdp_watchdog' -Default 'false'
if ($enable -ne 'true') {
  exit 0
}

$CdpPort        = Get-Config -Key 'cdp_port' -Default '18801'
$ChromeProfile  = Get-Config -Key 'chrome_profile_name' -Default 'Default'
$DefaultUserDataDir = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
$ChromeUserDataDir = Get-Config -Key 'chrome_user_data_dir' -Default $DefaultUserDataDir
$DiscordWebhook = Get-Config -Key 'discord_webhook_url' -Default ''

# Chrome本体パス候補（標準インストール先）
# ProgramFiles(x86) は変数名に括弧が含まれるため [Environment] 経由で取得
$ProgramFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
$ChromeCandidates = @(
  (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe')
)
if ($ProgramFilesX86) {
  $ChromeCandidates += (Join-Path $ProgramFilesX86 'Google\Chrome\Application\chrome.exe')
}
$ChromeCandidates += (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
$ChromeBin = $ChromeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $ChromeBin) {
  Write-WatchdogLog "ERROR: Chrome not found in standard locations"
  exit 1
}

# ────────────────────────────────────────────
# 通知
# ────────────────────────────────────────────
function Send-DiscordNotification {
  param([Parameter(Mandatory = $true)][string]$Message)
  if ([string]::IsNullOrEmpty($DiscordWebhook)) { return }
  try {
    $body = @{ content = $Message } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri $DiscordWebhook -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 10 | Out-Null
  } catch {
    Write-WatchdogLog "WARN: discord webhook failed: $($_.Exception.Message)"
  }
}

# ────────────────────────────────────────────
# 死活確認
# ────────────────────────────────────────────
function Test-CdpAlive {
  try {
    $resp = Invoke-WebRequest -Uri ('http://localhost:{0}/json/version' -f $CdpPort) `
              -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
    return ($resp.StatusCode -eq 200)
  } catch {
    return $false
  }
}

# ────────────────────────────────────────────
# 復旧
# ────────────────────────────────────────────
function Restart-Chrome {
  Write-WatchdogLog "RESTART: killing CDP Chrome (port $CdpPort)"

  # CDP接続用のChromeプロセスのみ特定して停止
  # CommandLineにremote-debugging-portを含むものだけ
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
             Where-Object { $_.CommandLine -and $_.CommandLine -match "--remote-debugging-port=$CdpPort" }
    foreach ($p in $procs) {
      try {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
      } catch {}
    }
  } catch {
    Write-WatchdogLog "WARN: process enumeration failed: $($_.Exception.Message)"
  }

  Start-Sleep -Seconds 3

  Write-WatchdogLog "RESTART: launching Chrome profile='$ChromeProfile' port=$CdpPort"
  $args = @(
    "--remote-debugging-port=$CdpPort",
    '--remote-allow-origins=*',
    "--user-data-dir=$ChromeUserDataDir",
    "--profile-directory=$ChromeProfile"
  )
  try {
    Start-Process -FilePath $ChromeBin -ArgumentList $args -WindowStyle Minimized | Out-Null
  } catch {
    Write-WatchdogLog "ERROR: Start-Process failed: $($_.Exception.Message)"
    return $false
  }

  for ($i = 1; $i -le 15; $i++) {
    Start-Sleep -Seconds 1
    if (Test-CdpAlive) {
      Write-WatchdogLog "RESTART: success after ${i}s"
      return $true
    }
  }
  Write-WatchdogLog "RESTART: failed (CDP not responding after 15s)"
  return $false
}

# ────────────────────────────────────────────
# メイン
# ────────────────────────────────────────────
function Get-FailCount {
  if (Test-Path -LiteralPath $FailCountFile) {
    try { return [int](Get-Content -LiteralPath $FailCountFile -ErrorAction Stop) } catch { return 0 }
  }
  return 0
}

if (Test-CdpAlive) {
  if (Test-Path -LiteralPath $FailCountFile) {
    Remove-Item -LiteralPath $FailCountFile -ErrorAction SilentlyContinue
    Write-WatchdogLog "OK: CDP alive (recovered, counter reset)"
  }
  exit 0
}

$failCount = (Get-FailCount) + 1
Set-Content -LiteralPath $FailCountFile -Value "$failCount" -ErrorAction SilentlyContinue

Write-WatchdogLog "DOWN: CDP port $CdpPort not responding (consecutive failures: $failCount)"

if (Restart-Chrome) {
  Send-DiscordNotification -Message "✅ [cdp-watchdog] CDP復旧完了 (port $CdpPort, host $env:COMPUTERNAME). 投稿リトライ可能。"
  Remove-Item -LiteralPath $FailCountFile -ErrorAction SilentlyContinue
  exit 0
}

if ($failCount -ge $CriticalThreshold) {
  Send-DiscordNotification -Message "🚨 [cdp-watchdog] CRITICAL: CDP復旧失敗が${failCount}回連続 (port $CdpPort, host $env:COMPUTERNAME). 手動対応必要。ログ: $LogFile"
} else {
  Send-DiscordNotification -Message "⚠️ [cdp-watchdog] CDP復旧失敗 $failCount/$CriticalThreshold (port $CdpPort, host $env:COMPUTERNAME)"
}
exit 1
