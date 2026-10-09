import { beforeEach, describe, expect, it } from 'vitest'
import { clearPendingRegistration, readPendingRegistration, savePendingRegistration } from './pending-registration'

describe('pending registration persistence', () => {
  beforeEach(() => localStorage.clear())

  it('persists only the email, School ID, and server deadline needed to resume OTP', () => {
    expect(savePendingRegistration({
      email: ' STUDENT@IBA.EDU ',
      schoolId: ' iba 001 ',
      expiresAt: '2026-10-09T02:30:00.000Z',
      password: 'never-store-this',
      otp: '123456',
    })).toBe(true)

    expect(readPendingRegistration()).toEqual({
      email: 'student@iba.edu',
      schoolId: 'IBA001',
      expiresAt: '2026-10-09T02:30:00.000Z',
    })
    expect(localStorage.getItem('iba-library.pending-registration')).not.toContain('never-store-this')
    expect(localStorage.getItem('iba-library.pending-registration')).not.toContain('123456')
  })

  it('ignores malformed storage and can remove interrupted-registration state', () => {
    localStorage.setItem('iba-library.pending-registration', '{broken')
    expect(readPendingRegistration()).toBeNull()
    savePendingRegistration({ email: 'a@iba.edu', schoolId: 'IBA123' })
    clearPendingRegistration()
    expect(readPendingRegistration()).toBeNull()
  })
})
