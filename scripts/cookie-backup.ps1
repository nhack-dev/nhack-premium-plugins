# nhack-premium v1.6.0 — Cookie backup (Windows PowerShell)
# Chrome ProfileのCookieをSQLite hot backup方式で日次バックアップする。
# オプトイン式: CLAUDE.md に `enable_cookie_persist: true` を書いた時のみ発動。
#
# あるお客様の環境で起きた Cookie 消失（午前中の投稿が全失敗）の真因対策。
#
# 設定（CLAUDE.md or %USERPROFILE%\.cookie-persist.conf）:
#   enable_cookie_persist: true
#   chrome_profile_name: "Default"
#   chrome_user_data_dir: "C:\Users\<user>\AppData\Local\Google\Chrome\User Data"
#   cookie_backup_dir: "C:\Users\<user>\.nhack\cookie-backups"
#   cookie_backup_keep_days: 7
#   discord_webhook_url: "https://discord.com/api/webhooks/..."
#
# ログ: $env:TEMP\cookie-backup.log
# 既存壊さない4原則: 既存ファイルは1行も触らない。新規追加のみ。

$ErrorActionPreference = 'Continue'
Set-StrictMode -Version 3.0

$ConfigUser   = Join-Path $env:USERPROFILE '.cookie-persist.conf'
$ConfigClaude = if ($env:COOKIE_PERSIST_CLAUDE_MD) { $env:COOKIE_PERSIST_CLAUDE_MD } else { Join-Path $env:USERPROFILE 'CLAUDE.md' }
$LogFile      = if ($env:COOKIE_BACKUP_LOG) { $env:COOKIE_BACKUP_LOG } else { Join-Path $env:TEMP 'cookie-backup.log' }

function Write-CookieLog {
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
$enable = Get-Config -Key 'enable_cookie_persist' -Default 'false'
if ($enable -ne 'true') {
  exit 0
}

$ChromeProfile      = Get-Config -Key 'chrome_profile_name' -Default 'Default'
$DefaultUserDataDir = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
$ChromeUserDataDir  = Get-Config -Key 'chrome_user_data_dir' -Default $DefaultUserDataDir
$DefaultBackupDir   = Join-Path $env:USERPROFILE '.nhack\cookie-backups'
$BackupDir          = Get-Config -Key 'cookie_backup_dir' -Default $DefaultBackupDir
$KeepDaysRaw        = Get-Config -Key 'cookie_backup_keep_days' -Default '7'
[int]$KeepDays      = 7
[void][int]::TryParse($KeepDaysRaw, [ref]$KeepDays)
$DiscordWebhook     = Get-Config -Key 'discord_webhook_url' -Default ''

# Chrome 80以降は Network\Cookies に移動。なければレガシーパス。
$CookieFileNetwork = Join-Path $ChromeUserDataDir (Join-Path $ChromeProfile 'Network\Cookies')
$CookieFileLegacy  = Join-Path $ChromeUserDataDir (Join-Path $ChromeProfile 'Cookies')
if (Test-Path -LiteralPath $CookieFileNetwork) {
  $SrcCookie = $CookieFileNetwork
} elseif (Test-Path -LiteralPath $CookieFileLegacy) {
  $SrcCookie = $CookieFileLegacy
} else {
  Write-CookieLog "ERROR: Cookies file not found under '$ChromeUserDataDir\$ChromeProfile'"
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
    Write-CookieLog "WARN: discord webhook failed: $($_.Exception.Message)"
  }
}

# ────────────────────────────────────────────
# sqlite3.exe の場所を解決
# 優先順位: PATH → Chromeの同梱（無い）→ なければ Copy-Item フォールバック
# ────────────────────────────────────────────
function Get-Sqlite3Path {
  $cmd = Get-Command -Name 'sqlite3.exe' -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Path }
  $cmd = Get-Command -Name 'sqlite3' -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Path }
  return $null
}

# ────────────────────────────────────────────
# バックアップ実行
# ────────────────────────────────────────────
function Backup-Cookies {
  param([Parameter(Mandatory = $true)][string]$DateTag)

  if (-not (Test-Path -LiteralPath $BackupDir)) {
    New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
  }
  $dest = Join-Path $BackupDir ('{0}-{1}-Cookies' -f $DateTag, $ChromeProfile)

  $sqlite = Get-Sqlite3Path
  if ($sqlite) {
    # SQLite hot backup（Chrome実行中もOK）
    # quote escaping: SQLite側は シングルクォートで包んで内部の ' は '' に
    $escapedDest = $dest -replace "'", "''"
    $backupCmd = ".backup '$escapedDest'"
    try {
      & $sqlite $SrcCookie $backupCmd 2>&1 | Add-Content -Path $LogFile
      if ($LASTEXITCODE -ne 0) {
        throw "sqlite3 exit code $LASTEXITCODE"
      }
      Write-CookieLog "OK: sqlite3 hot backup -> $dest"
    } catch {
      Write-CookieLog "WARN: sqlite3 .backup failed ($($_.Exception.Message)), falling back to Copy-Item"
      try {
        Copy-Item -LiteralPath $SrcCookie -Destination $dest -Force -ErrorAction Stop
      } catch {
        Write-CookieLog "ERROR: Copy-Item failed: $($_.Exception.Message)"
        return $false
      }
    }
  } else {
    try {
      Copy-Item -LiteralPath $SrcCookie -Destination $dest -Force -ErrorAction Stop
      Write-CookieLog "OK: Copy-Item backup (sqlite3 unavailable) -> $dest"
    } catch {
      Write-CookieLog "ERROR: Copy-Item failed: $($_.Exception.Message)"
      return $false
    }
  }

  # 整合性チェック
  if ($sqlite) {
    try {
      $check = & $sqlite $dest 'PRAGMA integrity_check;' 2>&1 | Select-Object -First 1
      if ($check -ne 'ok') {
        Write-CookieLog "ERROR: integrity_check failed for ${dest}: $check"
        Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue
        return $false
      }
    } catch {
      Write-CookieLog "WARN: integrity_check exception: $($_.Exception.Message)"
    }
  }

  return $true
}

# ────────────────────────────────────────────
# 古いバックアップ削除
# ────────────────────────────────────────────
function Invoke-RotateBackups {
  if (-not (Test-Path -LiteralPath $BackupDir)) { return }
  $cutoff = (Get-Date).AddDays(-1 * $KeepDays)
  $removed = 0
  Get-ChildItem -LiteralPath $BackupDir -File -Filter "*-$ChromeProfile-Cookies" -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt $cutoff } |
    ForEach-Object {
      try {
        Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop
        $removed++
      } catch {
        Write-CookieLog "WARN: failed to remove $($_.FullName): $($_.Exception.Message)"
      }
    }
  if ($removed -gt 0) {
    Write-CookieLog "ROTATE: removed $removed backup(s) older than $KeepDays days"
  }
}

# ────────────────────────────────────────────
# メイン
# ────────────────────────────────────────────
$DateTag = Get-Date -Format 'yyyyMMdd'

if (Backup-Cookies -DateTag $DateTag) {
  Invoke-RotateBackups
  Write-CookieLog "DONE: backup ok (profile=$ChromeProfile, date=$DateTag)"
  exit 0
}

Write-CookieLog "FAIL: backup failed (profile=$ChromeProfile, date=$DateTag)"
Send-DiscordNotification -Message "🚨 [cookie-backup] バックアップ失敗 (profile=$ChromeProfile). ログ: $LogFile"
exit 1
