# 業務量上限ガード (workload-limit-guard) — nhack-premium v1.6.0 ⑤

## 目的
クライアントの Claude Pro/Max プラン上限を超える業務量 cron 登録を物理ブロックする。

## 経緯
 Claude の枯渇連鎖（リプ 15件/日 = 朝5+昼5+夕5）が
Pro plan の 5時間ウィンドウ上限を超過 → ご利用者業務停止。
真因: エージェント が cron 登録時に Claude 上限を見積もる仕組みが無かった。
本ガードでこの再発を物理的に防ぐ。

## アーキテクチャ
- 独立 Bun サーバー（既存 `server.ts` は1行も触らない / 既存壊さない4原則）
- Optin式: エージェント が cron 登録時のみ POST する
- サーバー側の検査

```
エージェント ──POST──▶ workload-check-server :8787
   │                  │
   │                  └─ allowed=false → エージェント が cron 登録をキャンセル
   │
   └─ 並列でサーバー側の検査
```

## 起動

```bash
bun <プラグインの置き場>/scripts/workload-check-server.ts
# → :8787 でリッスン
# 環境変数 WORKLOAD_CHECK_PORT で変更可
```

ヘルスチェック:
```bash
curl -s http://localhost:8787/health
# → {"ok":true,"version":"1.6.0","service":"workload-check"}
```

## エンドポイント

### POST `/guild/workload-check`

**入力**:
```json
{
  "client_id": "sample-client",
  "plan": "pro",
  "workload_items": [
    { "kind": "reply", "count": 15 }
  ]
}
```

**出力**:
```json
{
  "allowed": false,
  "percent_consumed": 0.9,
  "recommendation": "reply 15件 → 13件 にすれば 80% 以内に収まります（現在 90.0%）",
  "budget_messages": 100,
  "used_messages": 90,
  "threshold": 0.8
}
```

**フィールド説明**:
| key | type | 説明 |
|---|---|---|
| `client_id` | string | クライアント識別子（ログ用） |
| `plan` | `"pro"` \| `"max"` | Claude プラン |
| `workload_items[].kind` | `"reply"` \| `"post"` \| `"article"` | タスク種別 |
| `workload_items[].count` | number | 1日あたりの件数 |
| `allowed` | bool | 80% 以内なら true |
| `percent_consumed` | number | 0-1+ の消費率 |
| `recommendation` | string | 減量案 or OK メッセージ |

### GET `/health`
`{ "ok": true, "version": "1.6.0", "service": "workload-check" }` を返す。

## 算出根拠

### プラン別 1日メッセージ予算

| プラン | 5h ウィンドウ上限 | 実効日次予算 | 算出 |
|---|---|---|---|
| Pro ($20/mo) | 45 msg / 5h | 100 msg/日 | 45 × ~2.2 effective windows（週次上限・睡眠帯考慮） |
| Max 5x ($200/mo) | 225 msg / 5h | 600 msg/日 | 225 × ~2.7 effective windows |

⚠️ Anthropic 公式の上限値は時々変わる。`PLAN_DAILY_MESSAGES` 定数を定期見直し。

### タスク別メッセージ消費量

| タスク | Claude メッセージ消費 | 内訳 |
|---|---|---|
| `reply` | 6 msg | research → draft → review → send → record |
| `post` | 12 msg | theme → research → draft × N → image → send → verify |
| `article` | 50 msg | outline → research → draft × N → review → publish |

新規タスク種別を追加する場合は `TASK_MESSAGE_COST` に追記。

### しきい値
- **80%** で警告・拒否（保守的）
- 残り 20% は突発業務・オーナー指示用の余裕

## テスト

```bash
bun test <プラグインの置き場>/scripts/workload-check.test.ts
```

主要ケース:
| ケース | 期待結果 |
|---|---|
| 枯渇が起きた型 (Pro, リプ 15件/日) | `allowed: false` ✓ |
| aimin型 (Pro, リプ 9件/日) | `allowed: true` ✓ |
| Max plan (リプ 15件/日) | `allowed: true` ✓ |
| 複合 (リプ5+投稿2+記事0) | `allowed: true` ✓ |
| 境界 (Pro article 2件 = 100%) | `allowed: false` ✓ |
| 減量提案の妥当性 | 提案後の値が 80% 以内 ✓ |
| 空 workload | `allowed: true`, 0% ✓ |

## サーバー側との連携

エージェント からの利用例（ご利用者側 `~/.claude/CLAUDE.md` に記載予定）:

```bash
# cron 登録前に必ず叩く
curl -s -X POST http://localhost:8787/guild/workload-check \
  -H 'Content-Type: application/json' \
  -d '{
    "client_id": "sample-client",
    "plan": "pro",
    "workload_items": [{"kind":"reply","count":15}]
  }' | jq

# allowed=false なら cron 登録をやめて recommendation を採用
```

サーバー側の検査。

## 注意
- ⚠️ 既存壊さない4原則: `server.ts` は1行も変更していない
- ⚠️ Optin式のため、エージェント が叩かなければ判定されない（サーバー側 rin-guard が補完）
- ⚠️ Anthropic 公式上限は時々変わる → 定数を定期見直し
- ⚠️ 算出は保守的（80% で警告・突発業務枠を確保）
