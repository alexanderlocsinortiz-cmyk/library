import { afterEach, describe, expect, it, vi } from 'vitest'
import { AUTH_REQUEST_TIMEOUT_MS, withAuthTimeout } from './auth'

describe('auth request timeout', () => {
  afterEach(() => vi.useRealTimers())

  it('returns the original request result', async () => {
    await expect(withAuthTimeout(Promise.resolve({ data: true }), 'Test request')).resolves.toEqual({ data: true })
  })

  it('rejects a request that never completes', async () => {
    vi.useFakeTimers()
    const request = withAuthTimeout(new Promise(() => {}), 'Test request')
    const assertion = expect(request).rejects.toMatchObject({ code: 'AUTH_REQUEST_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(AUTH_REQUEST_TIMEOUT_MS)
    await assertion
  })
})
