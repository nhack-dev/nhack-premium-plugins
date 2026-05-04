#!/usr/bin/env bun
/**
 * workload-check-server.ts (nhack-premium v1.6.0 ⑤)
 *
 * 業務量上限ガード — クラAIのcron登録時、Claude Pro/Max上限超過を物理ブロック。
 *
 * 経緯: 2026-05-03 yukari Claude枯渇連鎖（リプ15件/日 = 朝5+昼5+夕5）が
 * Pro plan の 5時間ウィンドウ上限を超過 → 業務停止。再発防止のため
 * 別サーバーとして独立稼働（既存 server.ts は1行も触らない）。
 *
 * Optin式: クラAIが cron登録時のみ POST する。凛側 rin-guard.sh の
 * PHASE_ORDER_VIOLATION と並列で動く（二重防御）。
 */

import { serve } from 'bun'

export type Plan = 'pro' | 'max'
export type WorkloadKind = 'reply' | 'post' | 'article'

export interface WorkloadItem {
  kind: WorkloadKind
  count: number
}

export interface CheckRequest {
  client_id: string
  plan: Plan
  workload_items: WorkloadItem[]
}

export interface CheckResponse {
  allowed: boolean
  percent_consumed: number
  recommendation: string
  budget_messages: number
  used_messages: number
  threshold: number
}

// 1日あたりのClaudeメッセージ予算。Anthropic公式の 5時間ウィンドウ上限を
// 実効ウィンドウ数（睡眠帯除外・週次上限考慮）で日次換算。
// 公式値は時々変わるので docs/workload-limit-guard.md と合わせて定期見直し。
export const PLAN_DAILY_MESSAGES: Record<Plan, number> = {
  pro: 100, // 45 msg/5h × ~2.2 effective windows
  max: 600, // 225 msg/5h × ~2.7 effective windows (Max 5x相当)
}

// タスク種別ごとのClaudeメッセージ消費量（pipeline実装ベースの実測平均）。
// reply  = task-x-reply（research → draft → review → send → record）
// post   = task-x-post-writer + image生成 + send + verify
// article = task-x-article 全pipeline
export const TASK_MESSAGE_COST: Record<WorkloadKind, number> = {
  reply: 6,
  post: 12,
  article: 50,
}

// 80% で警告・拒否（保守的）。残り20%は突発業務・オーナー指示用の余裕。
export const THRESHOLD = 0.8 as const

export function calculateWorkload(req: CheckRequest): CheckResponse {
  const budget = PLAN_DAILY_MESSAGES[req.plan]
  const used = req.workload_items.reduce(
    (sum, item) => sum + TASK_MESSAGE_COST[item.kind] * item.count,
    0,
  )
  const percent = budget > 0 ? used / budget : 1
  const allowed = percent <= THRESHOLD

  let recommendation: string
  if (allowed) {
    recommendation = `OK: ${(percent * 100).toFixed(1)}% 消費（上限 ${THRESHOLD * 100}%）`
  } else {
    const targetMessages = Math.floor(budget * THRESHOLD)
    const overMessages = used - targetMessages
    // 一番消費の大きいタスクから減らす提案を組み立てる
    const sorted = [...req.workload_items]
      .filter(it => it.count > 0)
      .sort(
        (a, b) =>
          b.count * TASK_MESSAGE_COST[b.kind] - a.count * TASK_MESSAGE_COST[a.kind],
      )
    const top = sorted[0]
    if (top) {
      const reduceCount = Math.ceil(overMessages / TASK_MESSAGE_COST[top.kind])
      const newCount = Math.max(0, top.count - reduceCount)
      recommendation = `${top.kind} ${top.count}件 → ${newCount}件 にすれば ${THRESHOLD * 100}% 以内に収まります（現在 ${(percent * 100).toFixed(1)}%）`
    } else {
      recommendation = `${(percent * 100).toFixed(1)}% 消費。業務量を減らしてください`
    }
  }

  return {
    allowed,
    percent_consumed: Number(percent.toFixed(4)),
    recommendation,
    budget_messages: budget,
    used_messages: used,
    threshold: THRESHOLD,
  }
}

export function isValidRequest(body: unknown): body is CheckRequest {
  if (!body || typeof body !== 'object') return false
  const r = body as Record<string, unknown>
  if (typeof r.client_id !== 'string' || r.client_id.length === 0) return false
  if (r.plan !== 'pro' && r.plan !== 'max') return false
  if (!Array.isArray(r.workload_items)) return false
  for (const item of r.workload_items) {
    if (!item || typeof item !== 'object') return false
    const it = item as Record<string, unknown>
    if (it.kind !== 'reply' && it.kind !== 'post' && it.kind !== 'article') return false
    if (typeof it.count !== 'number' || it.count < 0 || !Number.isFinite(it.count)) return false
  }
  return true
}

const PORT = Number(process.env.WORKLOAD_CHECK_PORT ?? 8787)

if (import.meta.main) {
  serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url)

      if (url.pathname === '/guild/workload-check' && req.method === 'POST') {
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
                'invalid request: requires client_id (string), plan ("pro"|"max"), workload_items[] of {kind:"reply"|"post"|"article", count:number}',
            },
            { status: 400 },
          )
        }
        return Response.json(calculateWorkload(body))
      }

      if (url.pathname === '/health' && req.method === 'GET') {
        return Response.json({ ok: true, version: '1.6.0', service: 'workload-check' })
      }

      return new Response('not found', { status: 404 })
    },
  })
  process.stderr.write(`workload-check-server listening on :${PORT}\n`)
}
