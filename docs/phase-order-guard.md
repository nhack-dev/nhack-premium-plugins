# Phase順序ガード (phase-order-guard) — nhack-premium v1.6.0 ④

## 目的
エージェントが Phase 未完なのに業務 cron を登録しようとしたら物理ブロックする。

## 経緯
 「Phase 1 未完で業務量 9件/日設計 → 13時間連鎖」の真因対策。
Phase 1〜3 が未完（unchecked > 0）の状態で業務系アクション（register-business-cron 等）を
試みると BLOCK。Phase 4 完了（unchecked = 0）まで業務自動化を物理的に止める。

サポートがマニュアルを守らない問題対策（サーバー側の検査。

## アーキテクチャ
- 独立 Bun サーバー（既存 `server.ts` / `workload-check-server.ts` は1行も触らない / 既存壊さない4原則）
- Optin式: エージェント が cron 登録時のみ POST する
- サーバー側の検査

```
エージェント ──POST──▶ phase-order-check-server :8788
   │                  │
   │                  └─ allowed=false → エージェント が cron 登録をキャンセル
   │
   └─ 並列でサーバー側の検査
```

## 起動

```bash
bun <プラグインの置き場>/scripts/phase-order-check-server.ts
# → :8788 でリッスン
# 環境変数 PHASE_ORDER_CHECK_PORT で変更可
```

ヘルスチェック:
```bash
curl -s http://localhost:8788/health
# → {"ok":true,"version":"1.6.0","service":"phase-order-check"}
```

## エンドポイント

### POST `/guild/phase-order-check`

**入力**:
```json
{
  "client_id": "sample-client",
  "current_phase": "Phase 1",
  "unchecked_items_count": 6,
  "attempted_action": "register-business-cron"
}
```

**出力 (BLOCK)**:
```json
{
  "allowed": false,
  "reason": "Phase 1 が未完です（残り 6 項目）。Phase 完成→次 Phase 進行→Phase 4 業務自動化の順序で稼働してください",
  "required_phase": "Phase 4"
}
```

**出力 (ALLOW)**:
```json
{
  "allowed": true,
  "reason": "Phase 4 完了済み (残り 0 項目)。業務自動化 register-business-cron を許可",
  "required_phase": "Phase 4"
}
```

**フィールド説明**:
| key | type | 説明 |
|---|---|---|
| `client_id` | string | クライアント識別子（ログ用） |
| `current_phase` | `"Phase 1"`〜`"Phase 4"` | 現在の Phase（`clients/{name}/info.md` が正本） |
| `unchecked_items_count` | number (非負整数) | Phase 内チェックリストの未完項目数 |
| `attempted_action` | string | 試みているアクション。業務系なら判定対象 |
| `allowed` | bool | Phase 4 完了かつ unchecked=0 の時のみ true |
| `reason` | string | BLOCK 理由 / ALLOW 理由 |
| `required_phase` | string | 業務自動化に必要な Phase（常に "Phase 4"） |

### GET `/health`
`{ "ok": true, "version": "1.6.0", "service": "phase-order-check" }` を返す。

## 判定ロジック

| current_phase | unchecked | attempted_action | 結果 |
|---|---|---|---|
| Phase 1 | > 0 | 業務系 | **BLOCK** |
| Phase 2 | > 0 | 業務系 | **BLOCK** |
| Phase 3 | > 0 | 業務系 | **BLOCK** |
| Phase 4 | > 0 | 業務系 | **BLOCK**（Phase 4 でも未完なら止める） |
| Phase 4 | = 0 | 業務系 | **ALLOW** |
| 任意 | 任意 | 非業務系 | ALLOW（対象外） |

## 業務系アクション一覧（`BUSINESS_ACTIONS`）

`scripts/phase-order-check-server.ts` の `BUSINESS_ACTIONS` 定数で管理:

- `register-business-cron`
- `enable-reply-automation`
- `enable-post-automation`
- `enable-article-automation`
- `register-scheduled-broadcast`

新しい業務自動化アクションを追加する時はこの定数に追記する。

## テスト

```bash
bun test <プラグインの置き場>/scripts/phase-order-check.test.ts
```

主要ケース:
| ケース | 期待結果 |
|---|---|
| 連鎖が起きた型 (Phase 1, unchecked=6, register-business-cron) | `allowed: false` ✓ |
| aimin型 (Phase 4, unchecked=0, register-business-cron) | `allowed: true` ✓ |
| Phase 2 + unchecked=3 + business cron | `allowed: false` ✓ |
| Phase 3 + unchecked=1 + reply automation | `allowed: false` ✓ |
| Phase 4 + unchecked=2 + business cron | `allowed: false` ✓ |
| 全業務系アクションが Phase 1 で BLOCK | `allowed: false` ✓ |
| 非業務系アクションは Phase 1 でも ALLOW | `allowed: true` ✓ |
| 全業務系が Phase 4 完了で ALLOW | `allowed: true` ✓ |

## エージェント 向け実装手順

### 前提
- クライアント環境で nhack-premium :8788 が起動している
- `clients/{name}/info.md` の「現在のPhase: PhaseX」が正本（変更しない・読むだけ）
- Phase内チェックリスト未完項目数を数えられる（unchecked_items_count）

### cron 登録前に必ず叩く

```bash
# 例: Phase 1 未完で register-business-cron を試みる
curl -s -X POST http://localhost:8788/guild/phase-order-check \
  -H 'Content-Type: application/json' \
  -d '{
    "client_id": "sample-client",
    "current_phase": "Phase 1",
    "unchecked_items_count": 6,
    "attempted_action": "register-business-cron"
  }' | jq

# allowed=false なら cron 登録をやめて reason をユーザーに通知
# - サポートにエスカレーション
# - 「Phase 1 のチェックリストを先に完了させてください」と案内
```

### 推奨フロー (エージェント cron登録時)

```
1. clients/{name}/info.md から current_phase 取得
2. Phase 内チェックリストの未完項目数を集計 → unchecked_items_count
3. POST /guild/phase-order-check
4. allowed=false → 登録キャンセル + reason をオーナーに通知
5. allowed=true → cron 登録実行（その後 workload-check も叩く）
```

### 並列で workload-check も叩く（二重ガード）

Phase 順序 OK でも業務量上限超過なら BLOCK。
- Phase順序ガード (:8788) → Phase 4 完了確認
- 業務量ガード (:8787) → Claude メッセージ予算確認
- 両方 ALLOW で初めて cron 登録 OK

## 注意
- ⚠️ 既存壊さない4原則: `server.ts` / `workload-check-server.ts` は1行も変更していない
- ⚠️ Optin式のため、エージェント が叩かなければ判定されない（サーバー側 rin-guard が補完）
- ⚠️ `clients/{name}/info.md` の Phase 表記は本サーバーの判定対象外（読むだけ）
- ⚠️ Phase 4 完了でも unchecked > 0 なら BLOCK（チェックリスト最優先）
