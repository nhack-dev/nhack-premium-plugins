#!/usr/bin/env bash
# build-hook.sh ── 雛形から【配る版】と【試す版】を作る
#   ロジックは雛形1つだけ。差は下の2行だけなので、ずれようがない。
set -eu
cd "$(dirname "$0")"
T=nhack-hook.template.sh
OUT_DIST=../nhack-hook.sh          # 配る版（外の設定を読まない）
OUT_TEST=../../.hook-test/nhack-hook-test.sh   # 試す版（配らない）

mkdir -p "$(dirname "$OUT_TEST")"

# 配る版: 送り先は定数、トークンは環境から（トークンは体ごとに違うので定数にできない）
sed -e 's|@@ENDPOINT@@|https://nhack-skill-server.sam-254.workers.dev|' \
    -e 's|@@TOKEN_EXPR@@|${NHACK_BOT_TOKEN:-${DISCORD_BOT_TOKEN:-}}|' \
    "$T" > "$OUT_DIST"

# 試す版: 送り先も環境から差し替えられる（検証用・配らない）
sed -e 's|@@ENDPOINT@@|${SKILL_SERVER_URL:-https://nhack-skill-server.sam-254.workers.dev}|' \
    -e 's|@@TOKEN_EXPR@@|${NHACK_BOT_TOKEN:-${DISCORD_BOT_TOKEN:-}}|' \
    "$T" > "$OUT_TEST"

chmod +x "$OUT_DIST" "$OUT_TEST"
echo "配る版: $OUT_DIST"
echo "試す版: $OUT_TEST"
