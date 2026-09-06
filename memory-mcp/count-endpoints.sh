#!/usr/bin/env bash
# 口の数を数える。数え方をここに固定する。
#
# なぜ道具にするか（）
#   数え方を 変えるたびに 数が 増えた（8 → 11）。
#   手で grep すると、探す型が毎回変わる。増えたのか、前回見落としたのか分からない。
#   → 数え方を1本にして、差分だけ見る形にする。
#
# 数え方（★これが全部ではないと明記する）
#   ① fetch( の引数に SKILL_SERVER_URL が入っている行
#   ② テンプレート文字列 `${SKILL_SERVER_URL}/...` の /... 部分
#   ★拾えないもの: 変数に組み立ててから渡す形／fetch 以外のHTTP手段
#
# 終了コード  0 数えた ／ 2 対象が読めない（★0件を合格にしない）
set -uo pipefail
ROOT="${1:-}"
[ -z "$ROOT" ] && { echo "使い方: count-endpoints.sh <調べる場所>"; exit 2; }
[ -e "$ROOT" ] || { echo "測れませんでした ── 場所がありません: $ROOT"; exit 2; }

FILES=$(find "$ROOT" \( -name '*.ts' -o -name '*.mjs' -o -name '*.js' \) \
        -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null)
[ -z "$FILES" ] && { echo "測れませんでした ── 対象のファイルが0本です"; exit 2; }
N_FILES=$(echo "$FILES" | wc -l | tr -d ' ')

# 口を抜く
HITS=$(echo "$FILES" | xargs grep -hoE '\$\{SKILL_SERVER_URL\}/[a-zA-Z0-9/_-]+' 2>/dev/null \
       | sed 's|${SKILL_SERVER_URL}||' | sort -u)
N=$(echo "$HITS" | grep -c . || true)

# 組み立ててから渡している形が無いか（★拾えない形の存在だけ知らせる）
VAR=$(echo "$FILES" | xargs grep -cE 'fetch\([^`"'"'"']*\)' 2>/dev/null | awk -F: '{s+=$2} END{print s+0}')

echo "見たファイル ${N_FILES}本"
echo
echo "口 ${N}個"
echo "$HITS" | grep . | sed 's/^/  /'
echo
echo "🟡 この数え方で拾えないもの"
echo "  ・変数に組み立ててから fetch に渡す形（★該当しうる fetch: ${VAR}箇所）"
echo "  ・fetch 以外のHTTP手段"
echo "  → ★「${N}個で全部」ではありません。「この数え方では ${N}個」です"
exit 0
