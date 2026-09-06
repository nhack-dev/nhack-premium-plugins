# CDP watchdog セットアップ手順

nhack-premium v1.6.0 ① CDP watchdog の導入手順です。

## 何をするスクリプト?

CDP（Chrome DevTools Protocol＝AIがブラウザを自動操作するための通信規格）の接続が切れた時に、Chromeを自動で再起動して1分以内に復旧させるスクリプトです。

X自動投稿などCDP経由の業務が深夜・不在時に止まった場合でも、watchdog が検知して復旧させます。

## 既存壊さない4原則

- 既存ファイルは1行も触りません（追加のみ）
- **オプトイン式**: `enable_cdp_watchdog: true` を書いた時のみ発動
- フラグなし＝何もしない（既存環境に影響ゼロ）
- 不具合検知時は cron を外すだけで即停止

---

## Mac/Linux 手順

### 1. 設定ファイル作成

ホームディレクトリに `~/.cdp-watchdog.conf` を作成します（または `~/CLAUDE.md` の末尾に追記）。

```yaml
enable_cdp_watchdog: true
cdp_port: 18801
chrome_profile_name: "Default"
chrome_user_data_dir: "~/Library/Application Support/Google/Chrome"
discord_webhook_url: ""
```

| 項目 | 必須 | 説明 |
|---|---|---|
| `enable_cdp_watchdog` | ✅ | `true` 以外は何もせず終了 |
| `cdp_port` | | CDPポート。デフォルト `18801` |
| `chrome_profile_name` | | Chromeプロファイル名。デフォルト `Default`。CDP専用プロファイル推奨 |
| `chrome_user_data_dir` | | Chromeデータディレクトリ |
| `discord_webhook_url` | | 通知用Discord webhook URL（空ならスキップ） |

### 2. 実行権限付与

```bash
chmod +x /path/to/nhack-premium/scripts/cdp-watchdog.sh
```

### 3. 動作確認（手動実行）

```bash
# 一度実行してみる。CDPが生きていればログだけ更新、死んでいれば復旧を試みる
/path/to/nhack-premium/scripts/cdp-watchdog.sh

# ログ確認
tail -20 /tmp/cdp-watchdog.log
```

### 4. cron登録（1分ごと実行）

```bash
crontab -e
```

以下を追記:

```cron
* * * * * /path/to/nhack-premium/scripts/cdp-watchdog.sh >/dev/null 2>&1
```

### 5. 復旧テスト

CDP用Chromeを意図的に殺して、1分以内に復旧することを確認:

```bash
# CDPポートを使ってるChromeを kill
pkill -f -- "--remote-debugging-port=18801"

# 1分待つ
sleep 65

# 復旧確認
curl -s http://localhost:18801/json/version | head -3

# ログ確認
tail /tmp/cdp-watchdog.log
```

---

## Windows 手順

### 1. 設定ファイル作成

`%USERPROFILE%\.cdp-watchdog.conf` を作成（または `%USERPROFILE%\CLAUDE.md` に追記）:

```yaml
enable_cdp_watchdog: true
cdp_port: 18801
chrome_profile_name: "Default"
chrome_user_data_dir: "C:\Users\<your-name>\AppData\Local\Google\Chrome\User Data"
discord_webhook_url: ""
```

### 2. 実行ポリシー確認

PowerShell（管理者として実行）で:

```powershell
Get-ExecutionPolicy
# Restricted の場合は:
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

### 3. 動作確認

```powershell
& "C:\path\to\nhack-premium\scripts\cdp-watchdog.ps1"

# ログ確認
Get-Content $env:TEMP\cdp-watchdog.log -Tail 20
```

### 4. タスクスケジューラ登録（1分ごと）

PowerShell（管理者）で1回だけ実行:

```powershell
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\path\to\nhack-premium\scripts\cdp-watchdog.ps1"'

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 1)

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries

Register-ScheduledTask -TaskName 'cdp-watchdog' `
  -Action $action -Trigger $trigger -Settings $settings -Force
```

### 5. WSL→Windows のCDP接続を使う場合

WSL内のClaude CodeからWindows側Chromeに接続するには portproxy が必要です。
これは別スクリプト `windows-portproxy-setup.ps1`（v1.6.0 改修⑥）の担当範囲なので、本watchdogとは独立して設定してください。

---

## 通知

Discord webhook URL を設定すると、以下のタイミングで通知されます:

| イベント | 通知内容 |
|---|---|
| ✅ 復旧成功 | `[cdp-watchdog] CDP復旧完了 (port XXXX, host XXXX). 投稿リトライ可能。` |
| ⚠️ 復旧失敗（1〜2回連続） | `[cdp-watchdog] CDP復旧失敗 N/3 (port XXXX, host XXXX)` |
| 🚨 連続失敗3回（致命級） | `[cdp-watchdog] CRITICAL: CDP復旧失敗が N回連続 ... 手動対応必要。` |

### Webhook URL の取得方法

1. Discord サーバー設定 → 連携サービス → ウェブフック → 新しいウェブフック
2. チャンネル指定（例: 通知専用チャンネル）
3. 「ウェブフック URL をコピー」して `discord_webhook_url` に設定

### メインサポートBot にDM送りたい場合

Webhook 方式ではユーザーDM はできないので、以下のいずれか:
- サポート通知用のチャンネルに webhook を作成して、そこに通知を流す
- メインサーバー側で webhook を購読して、必要に応じてサポートBot からDM転送する

---

## トラブルシューティング

### スクリプトを実行しても何も起きない

`enable_cdp_watchdog: true` がない or `false` の場合、何もせず exit 0 します（仕様）。
設定ファイルの読み込み順は `~/.cdp-watchdog.conf` → `~/CLAUDE.md` です。

### Chrome が複数起動して困る

`chrome_profile_name` が普段使いプロファイル（`Default`）になってる場合、watchdogが復旧時に同プロファイルを起動します。
**CDP専用プロファイルを別途作成**してそちらを指すよう変更してください（`chrome_profile_name: "CDP-Profile"` など）。

```bash
# CDP専用プロファイルの作り方（Mac）
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir="$HOME/.sns-chrome-profile" \
  --remote-debugging-port=18801 \
  --remote-allow-origins='*'
```

### ログが肥大化する

`/tmp/cdp-watchdog.log` は再起動でクリアされます。Linuxサーバー等で長期稼働する場合は logrotate を使ってください。

### 連続失敗3回で復旧しない

- Chrome本体がインストールされてるか
- `chrome_user_data_dir` のパスが正しいか
- 該当プロファイルが破損していないか
- ポートが他プロセスに占有されていないか（`lsof -i :18801`）

を確認してください。

---

## 既存 v1.5.0 との関係

- v1.5.0 の heartbeat（5分間隔）は変更なし
- 本watchdog は heartbeat より高頻度（1分間隔）で動作する独立した監視機構
- watchdog → 復旧成功 → heartbeat も自動再開
- watchdog 停止しても heartbeat は影響を受けない（疎結合）

## ロールバック手順

不具合検知時は5分以内に v1.5.0 へ戻せます:

```bash
# Mac/Linux
crontab -l | grep -v cdp-watchdog | crontab -

# Windows
Unregister-ScheduledTask -TaskName 'cdp-watchdog' -Confirm:$false
```

設定ファイルや配置ファイルは残してOK（`enable_cdp_watchdog: false` でも無効化可能）。

---

## 参考


- 関連横展開ノウハウ: 「CDP専用Chrome+launchd常駐」（aimin/sora/neo learnings.md）
