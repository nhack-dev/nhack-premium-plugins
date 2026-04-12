#!/bin/bash
# GitHubクローン後にhooksを有効化するセットアップ（1回実行するだけ）
ln -sf ../../hooks/pre-commit .git/hooks/pre-commit
ln -sf ../../hooks/pre-push .git/hooks/pre-push
echo "✅ pre-commit + pre-push hook 設定完了"
