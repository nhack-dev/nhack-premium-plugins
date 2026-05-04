#!/usr/bin/env bash
# nhack-premium v1.6.0 — Cookie restore (Mac/Linux)
# cookie-backup.sh が取ったバックアップから Chrome Profile の Cookies を復元する。
# オプトイン式: CLAUDE.md に `enable_cookie_persist: true` が必要。
#
# 使い方:
#   cookie-restore.sh                       # 最新バックアップから復元
#   cookie-restore.sh --date 20260503       # 指定日付（YYYYMMDD）から復元
#   cookie-restore.sh --profile "Default"   # プロファイル指定（CLAUDE.mdより優先）
#   cookie-restore.sh --list                # バックアップ一覧表示のみ
#   cookie-restore.sh --force               # Chrome実行中でも強制復元
#
# Chrome実行中の復元は破損リスクあり → デフォルトはChromeが動いてたら中断。
# 復元前の現Cookiesは Cookies.before-restore.<timestamp> にバックアップ。

set -uo pipefail

readonly CONFIG_USER="${HOME}/.cookie-persist.conf"
readonly CONFIG_CLAUDE="${COOKIE_PERSIST_CLAUDE_MD:-${HOME}/CLAUDE.md}"
readonly LOG_FILE="${COOKIE_RESTORE_LOG:-/tmp/cookie-restore.log}"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG_FILE"
}

read_config_value() {
  local key="$1"
  local file="$2"
  [[ -f "$file" ]] || return 1
  local raw
  raw="$(grep -E "^[[:space:]]*${key}[[:space:]]*:" "$file" 2>/dev/null | head -1 | sed -E "s/^[[:space:]]*${key}[[:space:]]*:[[:space:]]*//; s/[[:space:]]*#.*$//; s/^[\"']//; s/[\"']$//")"
  [[ -n "$raw" ]] && printf '%s' "$raw"
}

config_get() {
  local key="$1"
  local default="${2:-}"
  local v
  v="$(read_config_value "$key" "$CONFIG_USER" 2>/dev/null)" || true
  if [[ -z "$v" ]]; then
    v="$(read_config_value "$key" "$CONFIG_CLAUDE" 2>/dev/null)" || true
  fi
  printf '%s' "${v:-$default}"
}

usage() {
  cat <<'USAGE'
Usage: cookie-restore.sh [options]

Options:
  --date YYYYMMDD     指定日付のバックアップから復元（省略時は最新）
  --profile NAME      Chromeプロファイル名（省略時は設定ファイルの値）
  --list              バックアップ一覧を表示して終了
  --force             Chrome実行中でも復元を強行（破損リスクあり）
  -h, --help          このヘルプ
USAGE
}

# ────────────────────────────────────────────
# 引数パース
# ────────────────────────────────────────────
ARG_DATE=""
ARG_PROFILE=""
ARG_LIST=0
ARG_FORCE=0
while (( $# > 0 )); do
  case "$1" in
    --date)    ARG_DATE="${2:-}"; shift 2 ;;
    --profile) ARG_PROFILE="${2:-}"; shift 2 ;;
    --list)    ARG_LIST=1; shift ;;
    --force)   ARG_FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# ────────────────────────────────────────────
# オプトイン判定
# ────────────────────────────────────────────
ENABLE="$(config_get 'enable_cookie_persist' 'false')"
if [[ "$ENABLE" != "true" ]]; then
  echo "ERROR: enable_cookie_persist が true になっていません。CLAUDE.md または ~/.cookie-persist.conf に設定してください。" >&2
  exit 1
fi

CHROME_PROFILE="${ARG_PROFILE:-$(config_get 'chrome_profile_name' 'Default')}"
case "$(uname -s)" in
  Darwin) DEFAULT_USER_DATA_DIR="${HOME}/Library/Application Support/Google/Chrome" ;;
  Linux)  DEFAULT_USER_DATA_DIR="${HOME}/.config/google-chrome" ;;
  *)      echo "ERROR: unsupported OS $(uname -s)" >&2; exit 1 ;;
esac
CHROME_USER_DATA_DIR="$(config_get 'chrome_user_data_dir' "$DEFAULT_USER_DATA_DIR")"
BACKUP_DIR="$(config_get 'cookie_backup_dir' "${HOME}/.nhack/cookie-backups")"

CHROME_USER_DATA_DIR="${CHROME_USER_DATA_DIR/#\~/$HOME}"
BACKUP_DIR="${BACKUP_DIR/#\~/$HOME}"

if [[ ! -d "$BACKUP_DIR" ]]; then
  echo "ERROR: バックアップディレクトリがありません: $BACKUP_DIR" >&2
  exit 1
fi

# ────────────────────────────────────────────
# バックアップ一覧
# ────────────────────────────────────────────
list_backups() {
  # 新しい順で出力。出力フォーマット: <date> <path>
  # ファイル名は YYYYMMDD-<profile>-Cookies の前提。lexicographic sort = 日付ソート。
  find "$BACKUP_DIR" -maxdepth 1 -type f -name "*-${CHROME_PROFILE}-Cookies" -print 2>/dev/null \
    | sort -r
}

if (( ARG_LIST == 1 )); then
  echo "Profile: ${CHROME_PROFILE}"
  echo "Backup dir: ${BACKUP_DIR}"
  echo "----"
  list_backups | while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    bn="$(basename "$f")"
    sz="$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f" 2>/dev/null)"
    printf '%s\t%s bytes\n' "$bn" "$sz"
  done
  exit 0
fi

# ────────────────────────────────────────────
# 復元元バックアップを決定
# ────────────────────────────────────────────
if [[ -n "$ARG_DATE" ]]; then
  SRC_BACKUP="${BACKUP_DIR}/${ARG_DATE}-${CHROME_PROFILE}-Cookies"
  if [[ ! -f "$SRC_BACKUP" ]]; then
    echo "ERROR: 指定日付のバックアップが見つかりません: $SRC_BACKUP" >&2
    echo "利用可能なバックアップ: cookie-restore.sh --list" >&2
    exit 1
  fi
else
  SRC_BACKUP="$(list_backups | head -1)"
  if [[ -z "$SRC_BACKUP" ]]; then
    echo "ERROR: バックアップが1件もありません: ${BACKUP_DIR}/*-${CHROME_PROFILE}-Cookies" >&2
    exit 1
  fi
fi

log "RESTORE: src=${SRC_BACKUP}"

# ────────────────────────────────────────────
# Chrome実行中チェック
# ────────────────────────────────────────────
if pgrep -f -i "Google Chrome" >/dev/null 2>&1 || pgrep -f -i "chrome" >/dev/null 2>&1; then
  if (( ARG_FORCE == 0 )); then
    echo "ERROR: Chromeが実行中です。終了してから再実行するか --force を付けてください。" >&2
    exit 1
  fi
  log "WARN: Chrome実行中だが --force 指定により続行"
fi

# ────────────────────────────────────────────
# 復元先を決定（Chrome 80以降は Network/Cookies）
# ────────────────────────────────────────────
DEST_NETWORK="${CHROME_USER_DATA_DIR}/${CHROME_PROFILE}/Network/Cookies"
DEST_LEGACY="${CHROME_USER_DATA_DIR}/${CHROME_PROFILE}/Cookies"
if [[ -f "$DEST_NETWORK" ]]; then
  DEST_COOKIE="$DEST_NETWORK"
elif [[ -f "$DEST_LEGACY" ]]; then
  DEST_COOKIE="$DEST_LEGACY"
elif [[ -d "${CHROME_USER_DATA_DIR}/${CHROME_PROFILE}/Network" ]]; then
  DEST_COOKIE="$DEST_NETWORK"
elif [[ -d "${CHROME_USER_DATA_DIR}/${CHROME_PROFILE}" ]]; then
  DEST_COOKIE="$DEST_LEGACY"
else
  echo "ERROR: 復元先のプロファイルディレクトリが存在しません: ${CHROME_USER_DATA_DIR}/${CHROME_PROFILE}" >&2
  exit 1
fi

mkdir -p "$(dirname "$DEST_COOKIE")"

# ────────────────────────────────────────────
# 復元前バックアップ（巻き戻し用）
# ────────────────────────────────────────────
if [[ -f "$DEST_COOKIE" ]]; then
  BEFORE_RESTORE="${DEST_COOKIE}.before-restore.$(date '+%Y%m%d-%H%M%S')"
  cp -p "$DEST_COOKIE" "$BEFORE_RESTORE" || { log "ERROR: 復元前バックアップ失敗: $BEFORE_RESTORE"; exit 1; }
  log "BACKUP_BEFORE_RESTORE: ${BEFORE_RESTORE}"
fi

# ────────────────────────────────────────────
# 復元
# ────────────────────────────────────────────
cp -p "$SRC_BACKUP" "$DEST_COOKIE" || { log "ERROR: 復元コピー失敗"; exit 1; }

# 復元先の整合性チェック
if command -v sqlite3 >/dev/null 2>&1; then
  check="$(sqlite3 "$DEST_COOKIE" 'PRAGMA integrity_check;' 2>>"$LOG_FILE" | head -1)"
  if [[ "$check" != "ok" ]]; then
    log "ERROR: 復元後整合性チェック失敗: ${check}"
    exit 1
  fi
fi

log "DONE: restore ok (profile=${CHROME_PROFILE}, src=${SRC_BACKUP}, dest=${DEST_COOKIE})"
echo "✅ 復元完了: ${SRC_BACKUP} → ${DEST_COOKIE}"
exit 0
