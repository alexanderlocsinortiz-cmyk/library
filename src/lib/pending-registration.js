const STORAGE_KEY = 'iba-library.pending-registration'

function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase()
}

function normalizeSchoolId(schoolId) {
  return String(schoolId ?? '').trim().toUpperCase().replace(/\s+/g, '')
}

export function savePendingRegistration({ email, schoolId, expiresAt = null }, storage = globalThis.localStorage) {
  const normalizedEmail = normalizeEmail(email)
  const normalizedSchoolId = normalizeSchoolId(schoolId)
  if (!normalizedEmail || !normalizedSchoolId || !storage) return false
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({
      email: normalizedEmail,
      schoolId: normalizedSchoolId,
      expiresAt: typeof expiresAt === 'string' ? expiresAt : null,
    }))
    return true
  } catch {
    return false
  }
}

export function readPendingRegistration(storage = globalThis.localStorage) {
  if (!storage) return null
  try {
    const value = JSON.parse(storage.getItem(STORAGE_KEY) || 'null')
    if (!value || typeof value.email !== 'string' || typeof value.schoolId !== 'string') return null
    const email = normalizeEmail(value.email)
    const schoolId = normalizeSchoolId(value.schoolId)
    if (!email || !schoolId) return null
    return {
      email,
      schoolId,
      expiresAt: typeof value.expiresAt === 'string' ? value.expiresAt : null,
    }
  } catch {
    return null
  }
}

export function clearPendingRegistration(storage = globalThis.localStorage) {
  if (!storage) return
  try {
    storage.removeItem(STORAGE_KEY)
  } catch {
    // Storage may be disabled; the server remains authoritative.
  }
}
