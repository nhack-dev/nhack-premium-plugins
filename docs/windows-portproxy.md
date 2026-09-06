# Windows portproxy セットアップ手順（WSL ⇔ Windows CDP 接続）

nhack-premium v1.6.0 ⑥ Windows portproxy 対応の導入手順です。

## 何のためのスクリプト?

WSL2 内の Claude Code から Windows 側 Chrome の CDP（Chrome DevTools Protocol＝AI がブラウザを自動操作するための通信規格）に繋ぐためのネットワーク橋渡し設定です。

Windows 側の Chrome は CDP（`--remote-debugging-port=18801`）を **127.0.0.1 でしか listen しません**（Chrome のセキュリティ制約）。そのため WSL2 から直接アクセスできず、Windows ご利用者（kamio・hydeto・choro 等）が Phase 1 セットアップで詰まる典型箇所でした。

`netsh interface portproxy` で Windows 側の `0.0.0.0:18801` を `127.0.0.1:18801` に転送することで、WSL から Windows ホスト IP 経由で Chrome の CDP に接続できるようになります。

## 既存壊さない4原則

- 既存ファイル（`server.ts`、各種スクリプト）は1行も触りません
- **オプトイン式**: 設定ファイル に `os: windows` フラグを立てた時のみこちらから案内します
- フラグなし＝何もしない（Mac/Linux ご利用者には影響ゼロ）
- 不具合時は `windows-portproxy-uninstall.ps1` を1回実行するだけで完全ロールバック

---

## 前提

| 項目 | 値 |
|---|---|
| OS | Windows 10 / 11（WSL2 有効化済み） |
| 権限 | **管理者 PowerShell**（一般 PowerShell では `netsh interface portproxy` が動作しません） |
| Chrome | Windows 側にインストール済み・CDP 起動可能 |
| ポート | デフォルト `18801`（変更可） |

> ⚠️ **アンチウイルスソフト**（McAfee、Norton、ESET、ウイルスバスター等）が `netsh portproxy` やファイアウォール変更をブロックする場合があります。エラーが出る場合は AV ソフトを一時的に無効化するか、IT 管理者に相談してください。

---

## セットアップ手順

### 1. PowerShell を管理者として起動

スタートメニュー → 「PowerShell」を右クリック → 「**管理者として実行**」。

タイトルバーに「管理者: Windows PowerShell」と表示されていることを確認してください。

### 2. 実行ポリシー確認

```powershell
Get-ExecutionPolicy
```

`Restricted` の場合は次を実行:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

### 3. portproxy セットアップ

```powershell
& "C:\path\to\nhack-premium\scripts\windows-portproxy-setup.ps1"
```

成功すると以下が表示されます:

```
[OK]    管理者権限を確認しました。
[INFO]  既存 portproxy 設定を確認します（listen 0.0.0.0:18801）。
[INFO]  portproxy を追加します: 0.0.0.0:18801 -> 127.0.0.1:18801
[OK]    portproxy を追加しました。
[OK]    ファイアウォール規則 'nhack-premium CDP portproxy (18801)' を追加しました（TCP 18801 受信許可）。
[INFO]  現在の portproxy 設定:

ipv4 をリッスンする: ipv4 に接続する:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
0.0.0.0         18801       127.0.0.1       18801

[OK]    セットアップ完了。WSL から接続テストできます。
```

### 4. 動作確認（WSL 側で実行）

WSL2 のターミナルを開いて:

```bash
# Windows ホスト IP を取得（WSL2 のデフォルト gateway = Windows ホスト）
WIN_HOST=$(ip route show default | awk '{print $3}')
echo "Windows host: $WIN_HOST"

# CDP に接続テスト
curl -s "http://${WIN_HOST}:18801/json/version"
```

Chrome が CDP で起動していれば以下のような JSON が返ります:

```json
{
   "Browser": "Chrome/...",
   "Protocol-Version": "1.3",
   "User-Agent": "Mozilla/5.0 ...",
   "V8-Version": "...",
   "WebKit-Version": "...",
   "webSocketDebuggerUrl": "ws://..."
}
```

JSON が返らない場合は「トラブルシューティング」を参照してください。

---

## オプション

### ポートを変える

```powershell
& "C:\path\to\nhack-premium\scripts\windows-portproxy-setup.ps1" -Port 18802
```

### ファイアウォール設定をスキップ（社内ポリシーで自動設定不可な場合等）

```powershell
& "C:\path\to\nhack-premium\scripts\windows-portproxy-setup.ps1" -SkipFirewall
```

### 転送先を明示（特殊ケース）

通常は `127.0.0.1`（Windows 側 Chrome）で十分ですが、WSL 内 Chrome に向けたい等の特殊ケースでは:

```powershell
& "C:\path\to\nhack-premium\scripts\windows-portproxy-setup.ps1" -ConnectAddress 172.21.224.1
```

---

## アンインストール

```powershell
& "C:\path\to\nhack-premium\scripts\windows-portproxy-uninstall.ps1"
```

portproxy 設定とファイアウォール規則を削除します。`-KeepFirewall` でファイアウォール規則だけ残せます。

別ポートでセットアップした場合は同じ `-Port` を渡してください:

```powershell
& "C:\path\to\nhack-premium\scripts\windows-portproxy-uninstall.ps1" -Port 18802
```

---

## トラブルシューティング

### `netsh interface portproxy` が「要求されたエラーが返ってきました」

- IPv6 機能が無効化されている可能性。`Get-NetAdapterBinding -ComponentID ms_tcpip6` で確認
- AV ソフトが `netsh` をブロックしている可能性
- 一度 `windows-portproxy-uninstall.ps1` で全削除してから再実行

### `New-NetFirewallRule` でアクセス拒否

- 管理者 PowerShell で実行しているか再確認
- グループポリシーでファイアウォール規則の追加が禁止されている場合は `-SkipFirewall` で進めて、IT 管理者に手動許可を依頼

### WSL から `curl` しても接続拒否

- Chrome が `--remote-debugging-port=18801` で起動しているか確認:
  ```powershell
  netstat -ano | Select-String ":18801"
  ```
  `127.0.0.1:18801` が `LISTENING` になっているはず
- portproxy 設定の確認:
  ```powershell
  netsh interface portproxy show all
  ```
- WSL 側で取得した Windows IP が正しいか:
  ```bash
  cat /etc/resolv.conf | grep nameserver
  ip route show default
  ```
  WSL2 の場合、ネットワークモードによって取得方法が変わります（mirrored mode では `127.0.0.1` で直接到達可能）

### WSL2 を mirrored networking mode にしている場合

`%USERPROFILE%\.wslconfig` で `networkingMode=mirrored` を設定している環境では、WSL から Windows の `localhost:18801` に直接到達できるため、本 portproxy 設定は **不要** です。`curl http://localhost:18801/json/version` で繋がるか先に確認してください。

### アンチウイルスソフトでブロックされる

- McAfee、Norton、ESET、ウイルスバスター等は `netsh portproxy` 追加・ファイアウォール変更を不審な動作と判定する場合があります
- AV ソフトの「保護履歴」「検疫」を確認
- 一時的に AV を無効化して実行 → 成功したら除外設定に `windows-portproxy-setup.ps1` を追加
- 社内端末で AV 設定を変更できない場合は IT 管理者に相談

---

## 関連ファイル

| ファイル | 役割 |
|---|---|
| `scripts/windows-portproxy-setup.ps1` | portproxy + ファイアウォール規則 追加 |
| `scripts/windows-portproxy-uninstall.ps1` | portproxy + ファイアウォール規則 削除 |
| `scripts/cdp-watchdog.ps1` | Windows 側 Chrome 本体の watchdog（独立機能） |
| `docs/cdp-watchdog-setup.md` | watchdog の導入手順 |

`windows-portproxy-setup.ps1` と `cdp-watchdog.ps1` は **疎結合**です。portproxy はネットワーク橋渡し、watchdog は Chrome 本体の生死監視と役割が分かれています。両方使うご利用者もいれば、片方だけのご利用者もいます。

---

## ロールバック手順

不具合検知時は1コマンドで即時ロールバック可能:

```powershell
& "C:\path\to\nhack-premium\scripts\windows-portproxy-uninstall.ps1"
```

`server.ts` 等の既存実装には一切手を入れていないため、副作用はありません。
