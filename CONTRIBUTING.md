# Contributing — nhack-premium-plugins

本リポジトリの開発ブランチ運用と本番配布フローを記載する。

## ブランチ戦略

| ブランチ | 役割 | 配布 |
|---------|------|-----|
| `main` | 統合テスト・テストBot検証フェーズ | **しない** |
| `stable` | 本番配布用。クライアント環境が pull する | **する** |
| `dev/*` | 機能開発ブランチ。PR で `main` にマージする | しない |

- `main` は開発統合ブランチ。テストBot(`CLAUDE_CONFIG_DIR=~/.claude-test`) で検証する用途。
- `stable` は本番配布用。ここにマージされた時点で全クライアント(`/plugin update`)に反映される。
- **のりさんGO なしに `stable` を更新してはならない。**

## リリースフロー

```
dev/<feature>  ──PR──▶  main  ──(のりさんGO)──▶  stable  ──▶  全クライアント配布
     (開発)           (統合テスト)              (本番)
```

### 手順

1. `dev/<feature>` ブランチで機能開発
2. `.claude-plugin/plugin.json` と `package.json` のバージョンを上げる
3. PR を作成し `main` にマージする
4. テストBot で動作確認(DM送受信・Channel投稿・reaction・回帰テスト)
5. `.github/pull_request_template.md` のチェックリストを全て満たす
6. **のりさんに GO を確認**
7. GO が出たら `stable` に手動マージ:
   ```bash
   git checkout stable
   git pull origin stable
   git merge --ff-only main       # fast-forward のみ許可
   git push origin stable
   ```
8. `stable` に `vX.Y.Z` タグを付与:
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
9. 全クライアントへ `/plugin update` を案内

## 禁止事項

- ❌ `main` を直接 `stable` に fast-forward 以外でマージする
- ❌ のりさんGO なしに `stable` を push / force-push する
- ❌ `stable` ブランチを直接編集する(必ず `main` 経由)
- ❌ `dev/*` から `stable` へ直接マージする

## 既存クライアントの stable 追跡切り替え

既存クライアントは現在 `main` を追跡している可能性がある。`stable` 運用に完全移行する場合、以下のいずれかが必要:

1. **GitHub デフォルトブランチを `stable` に変更**(新規インストール先に影響)
2. 既存クライアント側で `git -C ~/.claude/plugins/marketplaces/nhack-premium-plugins checkout stable` を実行する案内を出す

→ のりさんの判断待ち。

## 参照

- `.github/pull_request_template.md` — PR 時のチェックリスト
- `.claude-plugin/plugin.json` — プラグインメタデータ
