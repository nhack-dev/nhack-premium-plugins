## Summary
<!-- 変更内容を1-3行で -->

## 変更ファイル
- [ ] `server.ts`
- [ ] `.claude-plugin/plugin.json` (version bump済み)
- [ ] `package.json` (version bump済み)
- [ ] `skills/` (配布スキル追加・更新)
- [ ] その他（README等）

## Test plan（staging検証）

### テストBot起動確認
- [ ] `CLAUDE_CONFIG_DIR=~/.claude-test claude --dangerously-skip-permissions --dangerously-load-development-channels "plugin:nhack-premium@nhack-premium-plugins"` で起動成功
- [ ] `/mcp` で `plugin:nhack-premium:nhack-premium · ✔ connected` 表示
- [ ] 起動ログに `error` / `failed` なし

### 機能確認
- [ ] DM送受信動作（テストBot ↔ のりさんアカウント）
- [ ] Channel投稿・メンション・reaction
- [ ] Slash commands（該当変更がある場合）
- [ ] 既存機能 regression なし

### 回帰テスト
- [ ] `shardDisconnect` → `shardReady` で dmChannels 再fetch 動作（nhack独自）
- [ ] Unicode サニタイゼーション（合字絵文字でクラッシュしない）
- [ ] `unhandledRejection` / `uncaughtException` でプロセス死なない

## 本番反映後の確認
- [ ] 全クラに `/plugin update` 案内
- [ ] 24時間後に DM / channel 動作に異常なし
- [ ] エラーログ（Anthropic 側）なし

## 関連Issue / 背景
<!-- クライアントからの報告・のりさん指示・既知バグ等 -->

🤖 Generated with [Claude Code](https://claude.com/claude-code)
