# Cookie永続化 セットアップ手順

nhack-premium v1.6.0 ③ Cookie永続化（バックアップ＋自動復元）の導入手順です。

## 何をするスクリプト?

Chrome ProfileのCookieを **1日1回・SQLite hot backup方式** で日次バックアップし、いつでも前日以前の状態に復元できるようにするスクリプトです。

5/3 yukari さんの「Cookie が朝起きたら消えて午前中の投稿が全失敗」事案の真因対策です。Cookie が何らかの理由で消失しても、前日のバックアップから1コマンドで復元して投稿を即時再開できます。

## 既存壊さない4原則

- 既存ファイルは1行も触りません（追加のみ）
- **オプトイン式**: `enable_cookie_persist: true` を書いた時のみ発動
- フラグなし＝何もしない（既存環境に影響ゼロ）
- `server.ts` 変更ゼロ
- 不具合検知時は cron / タスクスケジューラを外すだけで即停止

---

## 仕組み

### バックアップ

- ChromeのCookieは内部的にSQLiteファイル（`Cookies`）
- Chrome実行中はWALモードでロックされてる事が多い → 普通に `cp` するとロック競合 or 整合性破綻のリスク
- **解決策**: `sqlite3 .backup` コマンド（hot backup）を使う
  - SQLiteのオンラインバックアップAPI経由で、ロックを保持したまま整合性のあるコピーを取得
  - Chrome実行中でも安全にバックアップ可能
- `sqlite3` が無い環境では `cp` にフォールバック（Chrome停止中のみ整合性保証）
- バックアップ後に `PRAGMA integrity_check` で整合性検証
- 暗号化キー（macOS Keychain / Windows DPAPI）は **バックアップしません**（同マシン内の復元のみ想定。他マシンへの移行は対象外）

### 保持

- `~/.nhack/cookie-backups/{YYYYMMDD}-{profile}-Cookies` 形式で保存
- 7日経過した古いバックアップは自動削除（`cookie_backup_keep_days` で変更可）

### 復元

- 最新 or 指定日付のバックアップから Cookies ファイルを上書き
- 復元前の現Cookiesは `Cookies.before-restore.<timestamp>` に退避（巻き戻し用）
- Chrome実行中は **デフォルトで中断**（破損リスク回避） → `--force` で強制可

---

## Mac/Linux 手順

### 1. 設定ファイル作成

ホームディレクトリに `~/.cookie-persist.conf` を作成します（または `~/CLAUDE.md` の末尾に追記）。

```yaml
enable_cookie_persist: true
chrome_profile_name: "Default"
chrome_user_data_dir: "~/Library/Application Support/Google/Chrome"
cookie_backup_dir: "~/.nhack/cookie-backups"
cookie_backup_keep_days: 7
discord_webhook_url: ""
```

| 項目 | 必須 | 説明 |
|---|---|---|
| `enable_cookie_persist` | ✅ | `true` 以外は何もせず終了 |
| `chrome_profile_name` | | Chromeプロファイル名。デフォルト `Default` |
| `chrome_user_data_dir` | | Chromeデータディレクトリ |
| `cookie_backup_dir` | | バックアップ保存先。デフォルト `~/.nhack/cookie-backups` |
| `cookie_backup_keep_days` | | 保持日数。デフォルト `7` |
| `discord_webhook_url` | | バックアップ失敗時の通知用（空ならスキップ） |

### 2. 実行権限付与

```bash
chmod +x /path/to/nhack-premium/scripts/cookie-backup.sh
chmod +x /path/to/nhack-premium/scripts/cookie-restore.sh
```

### 3. 動作確認（手動実行）

```bash
# 一度実行してみる
/path/to/nhack-premium/scripts/cookie-backup.sh

# ログ確認
tail -20 /tmp/cookie-backup.log

# バックアップ生成確認
ls -la ~/.nhack/cookie-backups/
```

### 4. cron登録（1日1回・深夜実行推奨）

```bash
crontab -e
```

以下を追記（深夜3時に実行）:

```cron
0 3 * * * /path/to/nhack-premium/scripts/cookie-backup.sh >/dev/null 2>&1
```

X自動投稿の活動時間外に走らせるとロック競合が最小化されます。

### 5. 復元テスト

```bash
# バックアップ一覧
/path/to/nhack-premium/scripts/cookie-restore.sh --list

# Chromeを終了してから最新バックアップで復元
/path/to/nhack-premium/scripts/cookie-restore.sh

# 指定日付から復元
/path/to/nhack-premium/scripts/cookie-restore.sh --date 20260503
```

---

## Windows 手順

### 1. 設定ファイル作成

`%USERPROFILE%\.cookie-persist.conf` を作成（または `%USERPROFILE%\CLAUDE.md` に追記）:

```yaml
enable_cookie_persist: true
chrome_profile_name: "Default"
chrome_user_data_dir: "C:\Users\<your-name>\AppData\Local\Google\Chrome\User Data"
cookie_backup_dir: "C:\Users\<your-name>\.nhack\cookie-backups"
cookie_backup_keep_days: 7
discord_webhook_url: ""
```

### 2. sqlite3.exe の用意（推奨）

Windowsには標準で `sqlite3.exe` が入っていません。**hot backup を使うため強く推奨**:

1. https://www.sqlite.org/download.html から「sqlite-tools-win-x64-...zip」を取得
2. 展開して `sqlite3.exe` を `C:\Windows\System32\` などPATHの通った場所に配置
3. 確認:

```powershell
sqlite3 -version
```

`sqlite3.exe` が無くても動きますが、その場合は `Copy-Item` フォールバックになるためChrome終了が必須です。

### 3. 実行ポリシー確認

```powershell
Get-ExecutionPolicy
# Restricted の場合は:
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

### 4. 動作確認

```powershell
& "C:\path\to\nhack-premium\scripts\cookie-backup.ps1"

# ログ確認
Get-Content $env:TEMP\cookie-backup.log -Tail 20

# バックアップ生成確認
Get-ChildItem "$env:USERPROFILE\.nhack\cookie-backups"
```

### 5. タスクスケジューラ登録（1日1回・深夜3時）

PowerShell（管理者）で1回だけ実行:

```powershell
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\path\to\nhack-premium\scripts\cookie-backup.ps1"'

$trigger = New-ScheduledTaskTrigger -Daily -At 3am

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries

Register-ScheduledTask -TaskName 'cookie-backup' `
  -Action $action -Trigger $trigger -Settings $settings -Force
```

### 6. 復元テスト

```powershell
# バックアップ一覧
& "C:\path\to\nhack-premium\scripts\cookie-restore.ps1" -List

# Chromeを終了してから最新バックアップで復元
& "C:\path\to\nhack-premium\scripts\cookie-restore.ps1"

# 指定日付から復元
& "C:\path\to\nhack-premium\scripts\cookie-restore.ps1" -Date 20260503
```

---

## 復元シナリオ別フロー

### A. Cookieが消えた / X等から強制ログアウトされた

1. Chromeを完全終了
2. `cookie-restore.sh`（最新バックアップから自動）
3. Chrome起動 → ログイン状態が復旧していることを確認
4. 投稿リトライ

### B. 数日前の状態に戻したい

1. `cookie-restore.sh --list` で利用可能な日付を確認
2. `cookie-restore.sh --date 20260501` のように指定して復元

### C. 復元したけど元に戻したい

復元前のCookiesは `Cookies.before-restore.<timestamp>` に退避されています。手動で戻すか、最新バックアップを `--date` 指定で再復元できます。

---

## 通知

Discord webhook URL を設定すると、**バックアップ失敗時のみ** 通知されます:

| イベント | 通知内容 |
|---|---|
| 🚨 バックアップ失敗 | `[cookie-backup] バックアップ失敗 (profile=XXX, host XXX). ログ: /tmp/cookie-backup.log` |

復元はインタラクティブ実行を想定しているため、通知は飛ばしません（`echo` で stdout に結果出力）。

---

## トラブルシューティング

### スクリプトを実行しても何も起きない

`enable_cookie_persist: true` がない or `false` の場合、何もせず exit 0 します（仕様）。
設定ファイルの読み込み順は `~/.cookie-persist.conf` → `~/CLAUDE.md` です。

### `Cookies file not found` エラー

Chrome 80以降は Cookies の場所が変わっています:

- 新: `<UserDataDir>/<Profile>/Network/Cookies`
- 旧: `<UserDataDir>/<Profile>/Cookies`

スクリプトは両方を自動探索しますが、`chrome_profile_name` が間違っていると見つかりません。実際のプロファイル名を確認してください:

```bash
# Mac
ls "$HOME/Library/Application Support/Google/Chrome/" | grep -E '^(Default|Profile)'
```

```powershell
# Windows
Get-ChildItem "$env:LOCALAPPDATA\Google\Chrome\User Data" | Where-Object { $_.Name -match '^(Default|Profile)' }
```

### `sqlite3 .backup failed` で `cp` フォールバックされる

Chrome がCookiesを排他ロック中の可能性があります。再試行するか、深夜帯に動かすよう cron 時刻を変更してください。

### 復元したのにログイン状態が戻らない

- 復元先のChromeプロファイルが正しいか（`chrome_profile_name`）
- 復元時にChromeが起動していなかったか（起動中復元はSQLiteが破損する可能性）
- セッション期限切れ等、Cookie自体が無効化されているケースは復元で戻せません（X側で手動再ログインが必要）

### バックアップが7日分溜まらない

`cookie_backup_keep_days: 7` なのに5日分しかない場合、cronが動いていない可能性があります:

```bash
# Macの場合 cronが動いてるか確認
crontab -l | grep cookie-backup

# 直近のログ
tail -50 /tmp/cookie-backup.log
```

---

## ロールバック手順

不具合検知時は即時停止できます:

```bash
# Mac/Linux
crontab -l | grep -v cookie-backup | crontab -

# Windows
Unregister-ScheduledTask -TaskName 'cookie-backup' -Confirm:$false
```

設定ファイルや配置ファイルは残してOK（`enable_cookie_persist: false` でも無効化可能）。

既存のChromeやserver.tsには一切影響しません。

---

## 制限事項

- **同マシン内の復元のみ**: 暗号化キー（Keychain/DPAPI）はバックアップしないため、別マシンへ移行してもCookieは復号できません
- **セッション失効には対応不可**: サーバー側でCookie/セッションを失効させられた場合は復元しても無効
- **WALファイル非対応**: `Cookies-journal` `Cookies-wal` `Cookies-shm` はバックアップしません（hot backupで本体ファイルへ統合済み）
- **CDP専用プロファイル推奨**: 普段使いプロファイルだと不要なCookieもバックアップされます。X自動投稿用プロファイルを別建てして `chrome_profile_name` をそれに向けるのが理想

---

## 参考

- 仕様書: `~/rin/memory-v2/projects/nhack-premium-v160-spec.md`
- 真因分析: 5/3 yukari Cookie消失午前中投稿全失敗 5 Whys
- 関連: `cdp-watchdog-setup.md`（v1.6.0 ① CDP接続切断対策）
