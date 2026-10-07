import { describe, expect, it } from 'vitest'
import { defaultCirculationPolicy, formatFine, getLoanDueState, normalizeCirculationPolicy } from './circulation'

describe('circulation policy helpers', () => {
  it('falls back safely when policy values are missing or invalid', () => {
    expect(normalizeCirculationPolicy({ loan_period_days: '21', fine_per_day: 12.5, max_renewals: -1 })).toMatchObject({
      loan_period_days: 3,
      fine_per_day: 12.5,
      max_renewals: defaultCirculationPolicy.max_renewals,
    })
  })

  it('keeps loan periods within the interview policy of one to three days', () => {
    expect(normalizeCirculationPolicy({ loan_period_days: 1 }).loan_period_days).toBe(1)
    expect(normalizeCirculationPolicy({ loan_period_days: 2 }).loan_period_days).toBe(2)
    expect(normalizeCirculationPolicy({ loan_period_days: 4 }).loan_period_days).toBe(3)
    expect(defaultCirculationPolicy.loan_period_days).toBe(3)
  })

  it('classifies due dates consistently', () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    expect(getLoanDueState('2025-12-31T23:59:59.000Z', 3, now)).toBe('overdue')
    expect(getLoanDueState('2026-01-02T00:00:00.000Z', 3, now)).toBe('due-soon')
    expect(getLoanDueState('2026-01-10T00:00:00.000Z', 3, now)).toBe('on-time')
    expect(getLoanDueState(null, 3, now)).toBe('no-due-date')
  })

  it('formats positive fines and suppresses empty fines', () => {
    expect(formatFine(0)).toBe('No fine')
    expect(formatFine(25)).toContain('25')
  })
})
