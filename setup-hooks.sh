#!/bin/bash
# GitHubクローン後にhooksを有効化するセットアップ
ln -sf ../../hooks/pre-commit .git/hooks/pre-commit
echo "✅ pre-commit hook 設定完了"
