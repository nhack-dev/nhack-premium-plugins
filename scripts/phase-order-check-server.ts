#!/usr/bin/env bun
/**
 * phase-order-check-server.ts (nhack-premium v1.6.0 ④)
 *
 * Phase順序ガード — エージェントがPhase未完なのに業務cron登録しようとしたら物理ブロック。
 *
 * 経緯:  あるお客様の環境で起きた「Phase 1未完で業務量9件/日設計→13時間連鎖」の真因対策。
 * Phase 1〜3 が未完（unchecked_items > 0）の状態で業務系アクション
 * （register-business-cron / enable-reply-automation 等）を試みると BLOCK。
 * Phase 4 完了（unchecked = 0）まで業務自動化を物理的に止める。
 *
 * Optin式: エージェントが cron 登録時のみ POST する。サーバー側の検査
 * PHASE_ORDER_VIOLATION と並列で動く（二重防御）。
 *
 * 既存壊さない4原則: server.ts / workload-check-server.ts は1行も触らない。
 */

import { serve } from 'bun'

export type Phase = 'Phase 1' | 'Phase 2' | 'Phase 3' | 'Phase 4'

export type AttemptedAction =
  | 'register-business-cron'
  | 'enable-reply-automation'
  | 'enable-post-automation'
  | 'enable-article-automation'
  | 'register-scheduled-broadcast'

export interface CheckRequest {
  client_id: string
  current_phase: Phase
  unchecked_items_count: number
  attempted_action: AttemptedAction
}

export interface CheckResponse {
  allowed: boolean
  reason: string
  required_phase: Phase
}

export const VALID_PHASES: readonly Phase[] = [
  'Phase 1',
  'Phase 2',
  'Phase 3',
  'Phase 4',
] as const

// 業務自動化系アクション。Phase 4 完了前は全て BLOCK 対象。
export const BUSINESS_ACTIONS: readonly AttemptedAction[] = [
  'register-business-cron',
  'enable-reply-automation',
  'enable-post-automation',
  'enable-article-automation',
  'register-scheduled-broadcast',
] as const

// 業務自動化に到達するために必要な最終Phase。
export const REQUIRED_PHASE: Phase = 'Phase 4'

export function isBusinessAction(action: string): action is AttemptedAction {
  return (BUSINESS_ACTIONS as readonly string[]).includes(action)
}

export function evaluatePhaseOrder(req: CheckRequest): CheckResponse {
  const isBusiness = isBusinessAction(req.attempted_action)
  const phaseComplete = req.current_phase === REQUIRED_PHASE && req.unchecked_items_count === 0

  if (!isBusiness) {
    return {
      allowed: true,
      reason: `非業務系アクション (${req.attempted_action}) のため Phase 順序ガード対象外`,
      required_phase: REQUIRED_PHASE,
    }
  }

  if (phaseComplete) {
    return {
      allowed: true,
      reason: `Phase 4 完了済み (残り 0 項目)。業務自動化 ${req.attempted_action} を許可`,
      required_phase: REQUIRED_PHASE,
    }
  }

  // BLOCK ケース: Phase 1〜3、または Phase 4 でも unchecked > 0
  const remaining = req.unchecked_items_count
  const reason =
    `${req.current_phase} が未完です（残り ${remaining} 項目）。` +
    `Phase 完成→次 Phase 進行→Phase 4 業務自動化の順序で稼働してください`

  return {
    allowed: false,
    reason,
    required_phase: REQUIRED_PHASE,
  }
}

export function isValidRequest(body: unknown): body is CheckRequest {
  if (!body || typeof body !== 'object') return false
  const r = body as Record<string, unknown>
  if (typeof r.client_id !== 'string' || r.client_id.length === 0) return false
  if (typeof r.current_phase !== 'string') return false
  if (!(VALID_PHASES as readonly string[]).includes(r.current_phase)) return false
  if (
    typeof r.unchecked_items_count !== 'number' ||
    r.unchecked_items_count < 0 ||
    !Number.isFinite(r.unchecked_items_count) ||
    !Number.isInteger(r.unchecked_items_count)
  ) {
    return false
  }
  if (typeof r.attempted_action !== 'string' || r.attempted_action.length === 0) return false
  return true
}

const PORT = Number(process.env.PHASE_ORDER_CHECK_PORT ?? 8788)

if (import.meta.main) {
  serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url)

      if (url.pathname === '/guild/phase-order-check' && req.method === 'POST') {
        let body: unknown
        try {
          body = await req.json()
        } catch {
          return Response.json({ error: 'invalid JSON body' }, { status: 400 })
        }
        if (!isValidRequest(body)) {
          return Response.json(
            {
              error:
                'invalid request: requires client_id (string), current_phase ("Phase 1"|"Phase 2"|"Phase 3"|"Phase 4"), unchecked_items_count (non-negative integer), attempted_action (string)',
            },
            { status: 400 },
          )
        }
        return Response.json(evaluatePhaseOrder(body))
      }

      if (url.pathname === '/health' && req.method === 'GET') {
        return Response.json({ ok: true, version: '1.6.0', service: 'phase-order-check' })
      }

      return new Response('not found', { status: 404 })
    },
  })
  process.stderr.write(`phase-order-check-server listening on :${PORT}\n`)
}
