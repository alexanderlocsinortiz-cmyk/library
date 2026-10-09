import { describe, expect, it } from 'vitest'
import { friendlyAuthError } from './auth-errors'

describe('friendlyAuthError', () => {
  it('explains the secure confirmation steps on a generic credential rejection', () => {
    const message = friendlyAuthError('Invalid email, School ID, or password.')
    expect(message).toContain('confirm their email')
    expect(message).toContain('linked library record')
  })

  it('keeps rate-limit guidance specific', () => {
    expect(friendlyAuthError('Too many sign-in attempts')).toContain('Wait a few minutes')
  })
})
