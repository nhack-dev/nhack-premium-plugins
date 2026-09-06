import { describe, expect, test } from 'bun:test'
import {
  BUSINESS_ACTIONS,
  evaluatePhaseOrder,
  isBusinessAction,
  isValidRequest,
  REQUIRED_PHASE,
  VALID_PHASES,
} from './phase-order-check-server'

describe('evaluatePhaseOrder', () => {
  test('連鎖が起きた型 (Phase 1, unchecked=6, register-business-cron) → BLOCK', () => {
    const result = evaluatePhaseOrder({
      client_id: 'sample-client',
      current_phase: 'Phase 1',
      unchecked_items_count: 6,
      attempted_action: 'register-business-cron',
    })
    expect(result.allowed).toBe(false)
    expect(result.required_phase).toBe('Phase 4')
    expect(result.reason).toContain('Phase 1')
    expect(result.reason).toContain('6')
    expect(result.reason).toContain('Phase 4')
  })

  test('aimin型 (Phase 4, unchecked=0, register-business-cron) → ALLOW', () => {
    const result = evaluatePhaseOrder({
      client_id: 'aimin',
      current_phase: 'Phase 4',
      unchecked_items_count: 0,
      attempted_action: 'register-business-cron',
    })
    expect(result.allowed).toBe(true)
    expect(result.required_phase).toBe('Phase 4')
    expect(result.reason).toContain('Phase 4 完了')
  })

  test('Phase 2 + unchecked=3 + register-business-cron → BLOCK', () => {
    const result = evaluatePhaseOrder({
      client_id: 'mid',
      current_phase: 'Phase 2',
      unchecked_items_count: 3,
      attempted_action: 'register-business-cron',
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('Phase 2')
  })

  test('Phase 3 + unchecked=1 + enable-reply-automation → BLOCK', () => {
    const result = evaluatePhaseOrder({
      client_id: 'late',
      current_phase: 'Phase 3',
      unchecked_items_count: 1,
      attempted_action: 'enable-reply-automation',
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('Phase 3')
    expect(result.reason).toContain('1')
  })

  test('Phase 4 + unchecked=2 + register-business-cron → BLOCK (Phase 4 でも未完なら止める)', () => {
    const result = evaluatePhaseOrder({
      client_id: 'phase4-incomplete',
      current_phase: 'Phase 4',
      unchecked_items_count: 2,
      attempted_action: 'register-business-cron',
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('Phase 4')
    expect(result.reason).toContain('2')
  })

  test('全業務系アクションが Phase 1 で BLOCK される', () => {
    for (const action of BUSINESS_ACTIONS) {
      const result = evaluatePhaseOrder({
        client_id: 'biz-actions',
        current_phase: 'Phase 1',
        unchecked_items_count: 5,
        attempted_action: action,
      })
      expect(result.allowed).toBe(false)
    }
  })

  test('非業務系アクションは Phase 1 でも ALLOW (対象外)', () => {
    const result = evaluatePhaseOrder({
      client_id: 'non-biz',
      current_phase: 'Phase 1',
      unchecked_items_count: 5,
      // 業務系リストに無い action は対象外
      attempted_action: 'manual-test-only' as never,
    })
    expect(result.allowed).toBe(true)
    expect(result.reason).toContain('対象外')
  })

  test('Phase 4 + unchecked=0 + 全業務系アクション → 全て ALLOW', () => {
    for (const action of BUSINESS_ACTIONS) {
      const result = evaluatePhaseOrder({
        client_id: 'phase4-done',
        current_phase: 'Phase 4',
        unchecked_items_count: 0,
        attempted_action: action,
      })
      expect(result.allowed).toBe(true)
    }
  })

  test('REQUIRED_PHASE は Phase 4', () => {
    expect(REQUIRED_PHASE).toBe('Phase 4')
  })
})

describe('isBusinessAction', () => {
  test('register-business-cron → true', () => {
    expect(isBusinessAction('register-business-cron')).toBe(true)
  })

  test('enable-reply-automation → true', () => {
    expect(isBusinessAction('enable-reply-automation')).toBe(true)
  })

  test('manual-test → false', () => {
    expect(isBusinessAction('manual-test')).toBe(false)
  })

  test('空文字列 → false', () => {
    expect(isBusinessAction('')).toBe(false)
  })
})

describe('isValidRequest', () => {
  test('正常リクエスト → true', () => {
    expect(
      isValidRequest({
        client_id: 'sample-client',
        current_phase: 'Phase 1',
        unchecked_items_count: 6,
        attempted_action: 'register-business-cron',
      }),
    ).toBe(true)
  })

  test('current_phase が不正 → false', () => {
    expect(
      isValidRequest({
        client_id: 'x',
        current_phase: 'Phase 5',
        unchecked_items_count: 0,
        attempted_action: 'register-business-cron',
      }),
    ).toBe(false)
  })

  test('unchecked_items_count が負 → false', () => {
    expect(
      isValidRequest({
        client_id: 'x',
        current_phase: 'Phase 1',
        unchecked_items_count: -1,
        attempted_action: 'register-business-cron',
      }),
    ).toBe(false)
  })

  test('unchecked_items_count が小数 → false', () => {
    expect(
      isValidRequest({
        client_id: 'x',
        current_phase: 'Phase 1',
        unchecked_items_count: 1.5,
        attempted_action: 'register-business-cron',
      }),
    ).toBe(false)
  })

  test('client_id 空 → false', () => {
    expect(
      isValidRequest({
        client_id: '',
        current_phase: 'Phase 1',
        unchecked_items_count: 0,
        attempted_action: 'register-business-cron',
      }),
    ).toBe(false)
  })

  test('attempted_action 空 → false', () => {
    expect(
      isValidRequest({
        client_id: 'x',
        current_phase: 'Phase 1',
        unchecked_items_count: 0,
        attempted_action: '',
      }),
    ).toBe(false)
  })

  test('null → false', () => {
    expect(isValidRequest(null)).toBe(false)
  })

  test('VALID_PHASES に全 Phase が含まれる', () => {
    expect(VALID_PHASES).toContain('Phase 1')
    expect(VALID_PHASES).toContain('Phase 2')
    expect(VALID_PHASES).toContain('Phase 3')
    expect(VALID_PHASES).toContain('Phase 4')
  })
})
