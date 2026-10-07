export const defaultCirculationPolicy = Object.freeze({
  loan_period_days: 3,
  max_active_loans: 5,
  due_soon_days: 3,
  max_renewals: 1,
  pickup_hold_days: 3,
  fine_per_day: 0,
  notifications_enabled: true,
})

export function normalizeCirculationPolicy(value = {}) {
  return Object.fromEntries(Object.entries(defaultCirculationPolicy).map(([key, fallback]) => {
    const nextValue = value[key]
    if (typeof fallback === 'boolean') return [key, typeof nextValue === 'boolean' ? nextValue : fallback]
    const numberValue = Number(nextValue)
    if (!Number.isFinite(numberValue) || numberValue < 0) return [key, fallback]
    if (key === 'loan_period_days') return [key, Math.max(1, Math.min(3, numberValue))]
    return [key, numberValue]
  }))
}

export function getLoanDueState(dueAt, dueSoonDays = defaultCirculationPolicy.due_soon_days, now = new Date()) {
  if (!dueAt) return 'no-due-date'
  const dueTime = new Date(dueAt).getTime()
  if (!Number.isFinite(dueTime)) return 'no-due-date'
  const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime()
  if (dueTime <= nowTime) return 'overdue'
  if (dueTime - nowTime <= dueSoonDays * 24 * 60 * 60 * 1000) return 'due-soon'
  return 'on-time'
}

export function formatFine(value) {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) return 'No fine'
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'PHP' }).format(amount)
}
