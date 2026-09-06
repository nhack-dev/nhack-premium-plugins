#!/usr/bin/env python3
"""送る直前に、鍵が混ざっていないかを数える。

送る範囲が広がるほど、移してはいけないもの（鍵）が混ざる。混ざったら取り返せない。
送る前に、実際に送る一覧に当てて数える。

終了コード  0 混ざっていない ／ 1 混ざっている（止める） ／ 2 測れなかった
★2 を 0 に混ぜない。「測れなかった」は「問題なし」ではない。
"""
import re
import sys
import pathlib

# ① 名前で分かるもの（中身を見るまでもない）
NAME = [
    (re.compile(r"(^|/)\.env(\.|$)"),        "環境変数のファイル"),
    (re.compile(r"\.(pem|key|p12|pfx)$"),    "鍵のファイル"),
    (re.compile(r"(^|/)id_(rsa|ed25519|ecdsa)$"), "SSH の秘密鍵"),
    (re.compile(r"(^|/)\.npmrc$"),           "パッケージ管理の認証"),
    (re.compile(r"(^|/)\.git-credentials$"), "git の認証"),
    (re.compile(r"credentials\.json$"),      "認証情報のファイル"),
]

# ② 中身で分かるもの（名前を変えられても見つかる）
BODY = [
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"), "秘密鍵の本体"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{20,}"),            "API の鍵"),
    (re.compile(r"\b(ghp|gho|ghs|ghu)_[A-Za-z0-9]{20,}"), "コード管理の鍵"),
    (re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}"),     "チャットの鍵"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"),               "クラウドの鍵"),
    (re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"),          "地図・検索の鍵"),
    (re.compile(r"\b[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,}"), "Bot の鍵"),
    (re.compile(r'"(token|password|secret|api_key)"\s*:\s*"[^"]{12,}"', re.I), "設定に直書きされた鍵"),
]

SKIP_DIR = {".git", "node_modules", "__pycache__", ".venv"}


def targets(root: pathlib.Path):
    if root.is_file():
        return [root]
    out = []
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        if SKIP_DIR & set(p.parts):
            continue
        out.append(p)
    return out


def scan(paths):
    hits, read, unread = [], 0, 0
    for p in paths:
        s = str(p)
        for rx, why in NAME:
            if rx.search(s):
                hits.append((s, 0, why, p.name))
        try:
            text = p.read_text(errors="strict")
        except Exception:
            unread += 1
            continue
        read += 1
        for n, line in enumerate(text.splitlines(), 1):
            for rx, why in BODY:
                m = rx.search(line)
                if m:
                    hits.append((s, n, why, m.group(0)[:12] + "…"))
    return hits, read, unread


def main():
    if len(sys.argv) < 2:
        print("使い方: pre-send-secret-check.py <送るファイル か フォルダ> ...", file=sys.stderr)
        return 2

    paths = []
    missing = []
    for a in sys.argv[1:]:
        p = pathlib.Path(a).expanduser()
        if not p.exists():
            missing.append(a)
            continue
        paths += targets(p)

    if missing:
        print(f"★測れませんでした ── 見つからない指定 {len(missing)}件: {', '.join(missing)}")
        return 2
    if not paths:
        print("★測れませんでした ── 対象のファイルが 0本です")
        return 2

    hits, read, unread = scan(paths)

    if unread and read == 0:
        print(f"★測れませんでした ── {unread}本すべて読めませんでした")
        return 2

    print(f"見たファイル {read}本" + (f"（読めなかったもの {unread}本）" if unread else ""))

    if hits:
        print(f"\n🔴 鍵が混ざっています ── {len(hits)}件。送るのを止めました\n")
        for s, n, why, ev in hits:
            print(f"  {why}")
            print(f"    {s}" + (f":{n}" if n else ""))
            print(f"    {ev}")
        print("\n鍵は送るものではありません。送る一覧から外してください。")
        return 1

    if unread:
        print(f"\n🟡 {unread}本を読めていません。その分は測れていません")
        return 2

    print("\n鍵は混ざっていません")
    return 0


if __name__ == "__main__":
    sys.exit(main())
