# nhack-premium v1.6.0 — Cookie restore (Windows PowerShell)
# cookie-backup.ps1 が取ったバックアップから Chrome Profile の Cookies を復元する。
# オプトイン式: CLAUDE.md に `enable_cookie_persist: true` が必要。
#
# 使い方:
#   .\cookie-restore.ps1                       # 最新バックアップから復元
#   .\cookie-restore.ps1 -Date 20260503        # 指定日付（YYYYMMDD）から復元
#   .\cookie-restore.ps1 -Profile "Default"    # プロファイル指定（CLAUDE.mdより優先）
#   .\cookie-restore.ps1 -List                 # バックアップ一覧表示のみ
#   .\cookie-restore.ps1 -Force                # Chrome実行中でも強制復元
#
# Chrome実行中の復元は破損リスクあり → デフォルトはChromeが動いてたら中断。
# 復元前の現Cookiesは Cookies.before-restore.<timestamp> にバックアップ。

[CmdletBinding()]
param(
  [string]$Date = '',
  [string]$Profile = '',
  [switch]$List,
  [switch]$Force
)

$ErrorActionPreference = 'Continue'
Set-StrictMode -Version 3.0

$ConfigUser   = Join-Path $env:USERPROFILE '.cookie-persist.conf'
$ConfigClaude = if ($env:COOKIE_PERSIST_CLAUDE_MD) { $env:COOKIE_PERSIST_CLAUDE_MD } else { Join-Path $env:USERPROFILE 'CLAUDE.md' }
$LogFile      = if ($env:COOKIE_RESTORE_LOG) { $env:COOKIE_RESTORE_LOG } else { Join-Path $env:TEMP 'cookie-restore.log' }

function Write-RestoreLog {
  param([Parameter(Mandatory = $true)][string]$Message)
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Add-Content -Path $LogFile -Value $line -ErrorAction SilentlyContinue
  Write-Host $line
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
  Write-Error "ERROR: enable_cookie_persist が true になっていません。CLAUDE.md または ~\.cookie-persist.conf に設定してください。"
  exit 1
}

if ([string]::IsNullOrEmpty($Profile)) {
  $ChromeProfile = Get-Config -Key 'chrome_profile_name' -Default 'Default'
} else {
  $ChromeProfile = $Profile
}
$DefaultUserDataDir = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
$ChromeUserDataDir  = Get-Config -Key 'chrome_user_data_dir' -Default $DefaultUserDataDir
$DefaultBackupDir   = Join-Path $env:USERPROFILE '.nhack\cookie-backups'
$BackupDir          = Get-Config -Key 'cookie_backup_dir' -Default $DefaultBackupDir

if (-not (Test-Path -LiteralPath $BackupDir)) {
  Write-Error "ERROR: バックアップディレクトリがありません: $BackupDir"
  exit 1
}

function Get-BackupList {
  Get-ChildItem -LiteralPath $BackupDir -File -Filter "*-$ChromeProfile-Cookies" -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending
}

# ────────────────────────────────────────────
# --List モード
# ────────────────────────────────────────────
if ($List) {
  Write-Host "Profile: $ChromeProfile"
  Write-Host "Backup dir: $BackupDir"
  Write-Host "----"
  Get-BackupList | ForEach-Object {
    Write-Host ("{0}`t{1} bytes" -f $_.Name, $_.Length)
  }
  exit 0
}

# ────────────────────────────────────────────
# 復元元バックアップ決定
# ────────────────────────────────────────────
if (-not [string]::IsNullOrEmpty($Date)) {
  $SrcBackup = Join-Path $BackupDir ('{0}-{1}-Cookies' -f $Date, $ChromeProfile)
  if (-not (Test-Path -LiteralPath $SrcBackup)) {
    Write-Error "ERROR: 指定日付のバックアップが見つかりません: $SrcBackup"
    Write-Error "利用可能なバックアップ: cookie-restore.ps1 -List"
    exit 1
  }
} else {
  $first = Get-BackupList | Select-Object -First 1
  if (-not $first) {
    Write-Error "ERROR: バックアップが1件もありません: $BackupDir\*-$ChromeProfile-Cookies"
    exit 1
  }
  $SrcBackup = $first.FullName
}

Write-RestoreLog "RESTORE: src=$SrcBackup"

# ────────────────────────────────────────────
# Chrome実行中チェック
# ────────────────────────────────────────────
$chromeProcs = Get-Process -Name 'chrome' -ErrorAction SilentlyContinue
if ($chromeProcs -and -not $Force) {
  Write-Error "ERROR: Chromeが実行中です。終了してから再実行するか -Force を付けてください。"
  exit 1
}
if ($chromeProcs -and $Force) {
  Write-RestoreLog "WARN: Chrome実行中だが -Force 指定により続行"
}

# ────────────────────────────────────────────
# 復元先決定
# ────────────────────────────────────────────
$DestNetwork = Join-Path $ChromeUserDataDir (Join-Path $ChromeProfile 'Network\Cookies')
$DestLegacy  = Join-Path $ChromeUserDataDir (Join-Path $ChromeProfile 'Cookies')
if (Test-Path -LiteralPath $DestNetwork) {
  $DestCookie = $DestNetwork
} elseif (Test-Path -LiteralPath $DestLegacy) {
  $DestCookie = $DestLegacy
} elseif (Test-Path -LiteralPath (Join-Path $ChromeUserDataDir (Join-Path $ChromeProfile 'Network'))) {
  $DestCookie = $DestNetwork
} elseif (Test-Path -LiteralPath (Join-Path $ChromeUserDataDir $ChromeProfile)) {
  $DestCookie = $DestLegacy
} else {
  Write-Error "ERROR: 復元先のプロファイルディレクトリが存在しません: $ChromeUserDataDir\$ChromeProfile"
  exit 1
}

$destDir = Split-Path -Parent $DestCookie
if (-not (Test-Path -LiteralPath $destDir)) {
  New-Item -ItemType Directory -Path $destDir -Force | Out-Null
}

# ────────────────────────────────────────────
# 復元前バックアップ
# ────────────────────────────────────────────
if (Test-Path -LiteralPath $DestCookie) {
  $beforeStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $beforeRestore = "$DestCookie.before-restore.$beforeStamp"
  try {
    Copy-Item -LiteralPath $DestCookie -Destination $beforeRestore -Force -ErrorAction Stop
    Write-RestoreLog "BACKUP_BEFORE_RESTORE: $beforeRestore"
  } catch {
    Write-RestoreLog "ERROR: 復元前バックアップ失敗: $($_.Exception.Message)"
    exit 1
  }
}

# ────────────────────────────────────────────
# 復元
# ────────────────────────────────────────────
try {
  Copy-Item -LiteralPath $SrcBackup -Destination $DestCookie -Force -ErrorAction Stop
} catch {
  Write-RestoreLog "ERROR: 復元コピー失敗: $($_.Exception.Message)"
  exit 1
}

# 整合性チェック
$sqlite = Get-Command -Name 'sqlite3.exe' -ErrorAction SilentlyContinue
if (-not $sqlite) { $sqlite = Get-Command -Name 'sqlite3' -ErrorAction SilentlyContinue }
if ($sqlite) {
  try {
    $check = & $sqlite.Path $DestCookie 'PRAGMA integrity_check;' 2>&1 | Select-Object -First 1
    if ($check -ne 'ok') {
      Write-RestoreLog "ERROR: 復元後整合性チェック失敗: $check"
      exit 1
    }
  } catch {
    Write-RestoreLog "WARN: integrity_check exception: $($_.Exception.Message)"
  }
}

Write-RestoreLog "DONE: restore ok (profile=$ChromeProfile, src=$SrcBackup, dest=$DestCookie)"
Write-Host "✅ 復元完了: $SrcBackup -> $DestCookie"
exit 0
