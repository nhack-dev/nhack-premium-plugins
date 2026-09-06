import { describe, expect, test } from 'bun:test'
import {
  calculateWorkload,
  isValidRequest,
  PLAN_DAILY_MESSAGES,
  TASK_MESSAGE_COST,
  THRESHOLD,
} from './workload-check-server'

describe('calculateWorkload', () => {
  test('枯渇が起きた型 (Pro, リプ15件/日) → blocked', () => {
    const result = calculateWorkload({
      client_id: 'sample-client',
      plan: 'pro',
      workload_items: [{ kind: 'reply', count: 15 }],
    })
    expect(result.allowed).toBe(false)
    expect(result.percent_consumed).toBeGreaterThan(THRESHOLD)
    expect(result.used_messages).toBe(15 * TASK_MESSAGE_COST.reply)
    expect(result.budget_messages).toBe(PLAN_DAILY_MESSAGES.pro)
    expect(result.recommendation).toContain('reply')
    expect(result.recommendation).toContain('15件')
  })

  test('aimin型 (Pro, リプ9件/日) → allowed', () => {
    const result = calculateWorkload({
      client_id: 'aimin',
      plan: 'pro',
      workload_items: [{ kind: 'reply', count: 9 }],
    })
    expect(result.allowed).toBe(true)
    expect(result.percent_consumed).toBeLessThanOrEqual(THRESHOLD)
    expect(result.used_messages).toBe(9 * TASK_MESSAGE_COST.reply)
  })

  test('Max plan (リプ15件/日) は余裕で通る', () => {
    const result = calculateWorkload({
      client_id: 'maxuser',
      plan: 'max',
      workload_items: [{ kind: 'reply', count: 15 }],
    })
    expect(result.allowed).toBe(true)
    expect(result.percent_consumed).toBeLessThan(0.2)
  })

  test('複合タスク (Pro, リプ5+投稿2+記事0) → allowed', () => {
    const result = calculateWorkload({
      client_id: 'mixed',
      plan: 'pro',
      workload_items: [
        { kind: 'reply', count: 5 },
        { kind: 'post', count: 2 },
        { kind: 'article', count: 0 },
      ],
    })
    expect(result.allowed).toBe(true)
    // 5*6 + 2*12 + 0*50 = 54 msg
    expect(result.used_messages).toBe(54)
  })

  test('境界: Pro で article 2件 (100msg=100%) → blocked', () => {
    const result = calculateWorkload({
      client_id: 'edge',
      plan: 'pro',
      workload_items: [{ kind: 'article', count: 2 }],
    })
    expect(result.allowed).toBe(false)
    expect(result.recommendation).toContain('article')
  })

  test('減量提案が現実的な数字を返す', () => {
    const result = calculateWorkload({
      client_id: 'sample-client',
      plan: 'pro',
      workload_items: [{ kind: 'reply', count: 15 }],
    })
    // budget=100, threshold=80, reply=6msg → target=80msg → 13件まで(13*6=78)
    expect(result.recommendation).toMatch(/reply 15件 → \d+件/)
    const m = /→ (\d+)件/.exec(result.recommendation)
    expect(m).not.toBeNull()
    const newCount = Number(m![1])
    expect(newCount).toBeLessThan(15)
    expect(newCount * TASK_MESSAGE_COST.reply).toBeLessThanOrEqual(
      PLAN_DAILY_MESSAGES.pro * THRESHOLD,
    )
  })

  test('空 workload は 0% で allowed', () => {
    const result = calculateWorkload({
      client_id: 'empty',
      plan: 'pro',
      workload_items: [],
    })
    expect(result.allowed).toBe(true)
    expect(result.percent_consumed).toBe(0)
    expect(result.used_messages).toBe(0)
  })
})

describe('isValidRequest', () => {
  test('正常リクエスト → true', () => {
    expect(
      isValidRequest({
        client_id: 'x',
        plan: 'pro',
        workload_items: [{ kind: 'reply', count: 1 }],
      }),
    ).toBe(true)
  })

  test('plan が不正 → false', () => {
    expect(
      isValidRequest({
        client_id: 'x',
        plan: 'free',
        workload_items: [],
      }),
    ).toBe(false)
  })

  test('kind が不正 → false', () => {
    expect(
      isValidRequest({
        client_id: 'x',
        plan: 'pro',
        workload_items: [{ kind: 'lecture', count: 1 }],
      }),
    ).toBe(false)
  })

  test('count が負 → false', () => {
    expect(
      isValidRequest({
        client_id: 'x',
        plan: 'pro',
        workload_items: [{ kind: 'reply', count: -1 }],
      }),
    ).toBe(false)
  })

  test('client_id 空 → false', () => {
    expect(
      isValidRequest({
        client_id: '',
        plan: 'pro',
        workload_items: [],
      }),
    ).toBe(false)
  })

  test('null → false', () => {
    expect(isValidRequest(null)).toBe(false)
  })
})
