import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { hasSupabaseConfig, supabase } from './supabase'

const AuthContext = createContext(null)
export const AUTH_REQUEST_TIMEOUT_MS = 8000
const EMAIL_IDENTIFIER_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function detectAuthIdentifierType(identifier) {
  return EMAIL_IDENTIFIER_PATTERN.test(String(identifier ?? '').trim()) ? 'email' : 'school_id'
}

function normalizeAuthIdentifier(identifier, identifierType) {
  const value = identifier.trim()
  if (identifierType === 'phone') return value.replace(/[\s()-]/g, '')
  return value.toLowerCase()
}

export function withAuthTimeout(request, action) {
  let timeoutId

  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const timeoutError = new Error(`${action} timed out. Check the Supabase URL and network connection.`)
      timeoutError.code = 'AUTH_REQUEST_TIMEOUT'
      reject(timeoutError)
    }, AUTH_REQUEST_TIMEOUT_MS)
  })

  return Promise.race([request, timeout]).finally(() => clearTimeout(timeoutId))
}

function logAuthFailure(action, authError) {
  if (!authError || !import.meta.env.DEV) return

  console.error(`[auth] ${action} failed`, {
    message: authError.message,
    code: authError.code,
    status: authError.status,
    details: authError.details,
    hint: authError.hint,
  })
}

async function authenticateWithSchoolId(action, schoolId, password, setError, invitation = '') {
  if (!supabase) return { error: new Error('Supabase is not configured.') }

  try {
    const { data, error: invokeError } = await withAuthTimeout(
      supabase.functions.invoke('school-id-auth', {
        body: { action, schoolId: schoolId.trim(), password, invitation },
      }),
      'School ID authentication',
    )

    const responseError = data?.error?.message
      ? new Error(data.error.message)
      : invokeError

    if (responseError) {
      logAuthFailure('school ID authentication', responseError)
      setError(responseError.message)
      return { error: responseError }
    }

    if (!data?.session) {
      const sessionError = new Error('The school ID authentication service did not return a session.')
      logAuthFailure('school ID authentication', sessionError)
      setError(sessionError.message)
      return { error: sessionError }
    }

    const sessionResult = await withAuthTimeout(
      supabase.auth.setSession(data.session),
      'School ID session setup',
    )
    if (sessionResult.error) {
      logAuthFailure('school ID session setup', sessionResult.error)
      setError(sessionResult.error.message)
      return sessionResult
    }

    return sessionResult
  } catch (authError) {
    logAuthFailure('school ID authentication', authError)
    setError(authError.message)
    return { error: authError }
  }
}

async function authenticateWithEmail(identifier, password, setError, identifierType = 'email') {
  if (!supabase) return { error: new Error('Supabase is not configured.') }

  try {
    const { data, error: invokeError } = await withAuthTimeout(
      supabase.functions.invoke('email-auth', {
        body: {
          ...(identifierType === 'phone'
            ? { phone: identifier }
            : { email: identifier.trim().toLowerCase() }),
          password,
        },
      }),
      'Email authentication',
    )
    const responseError = data?.error?.message
      ? new Error(data.error.message)
      : invokeError

    if (responseError) {
      logAuthFailure('email authentication', responseError)
      setError(responseError.message)
      return { error: responseError }
    }
    if (!data?.session) {
      const sessionError = new Error('The email authentication service did not return a session.')
      logAuthFailure('email authentication', sessionError)
      setError(sessionError.message)
      return { error: sessionError }
    }

    const sessionResult = await withAuthTimeout(
      supabase.auth.setSession(data.session),
      'Email session setup',
    )
    if (sessionResult.error) {
      logAuthFailure('email session setup', sessionResult.error)
      setError(sessionResult.error.message)
      return sessionResult
    }
    return sessionResult
  } catch (authError) {
    logAuthFailure('email authentication', authError)
    setError(authError.message)
    return { error: authError }
  }
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(hasSupabaseConfig)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!supabase) {
      setLoading(false)
      return undefined
    }

    let mounted = true
    let version = 0
    let activeUserId = null
    const applySession = async (nextSession, requestVersion) => {
      if (!mounted || requestVersion !== version) return
      activeUserId = nextSession?.user?.id ?? null
      setSession(nextSession)
      setProfile(null)
      setError('')
      if (!nextSession?.user) { setLoading(false); return }
      setLoading(true)
      try {
        const { data, error: profileError } = await withAuthTimeout(
          supabase.from('profiles').select('id, full_name, role, school_id').eq('id', nextSession.user.id).maybeSingle(),
          'Profile lookup',
        )
        if (!mounted || requestVersion !== version) return
        if (profileError || !data) throw profileError || new Error('Your library profile is missing. Contact staff.')
        if (data.role === 'member') {
          const { data: linked, error: linkError } = await withAuthTimeout(
            supabase.rpc('current_user_has_active_library_member'),
            'Member account verification',
          )
          if (linkError) throw linkError
          if (!mounted || requestVersion !== version) return
          setProfile({ ...data, member_linked: linked === true })
        } else {
          setProfile({ ...data, member_linked: true })
        }
      } catch (profileError) {
        if (mounted && requestVersion === version) setError(profileError.message)
      } finally {
        if (mounted && requestVersion === version) setLoading(false)
      }
    }
    const initialVersion = version
    withAuthTimeout(supabase.auth.getSession(), 'Session lookup').then(({ data, error: sessionError }) => {
      if (!mounted || version !== initialVersion) return
      if (sessionError) throw sessionError
      return applySession(data.session, initialVersion)
    }).catch((sessionError) => {
      if (mounted && version === initialVersion) { setError(sessionError.message); setLoading(false) }
    })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      // Supabase republishes an existing session as SIGNED_IN when a hidden tab
      // becomes visible. Keep the loaded profile and mounted workspace for the
      // same user; otherwise the active section resets and the full-screen
      // loader flashes whenever the browser returns to this tab.
      if (nextSession?.user?.id && nextSession.user.id === activeUserId) {
        setSession(nextSession)
        return
      }

      const requestVersion = ++version
      activeUserId = nextSession?.user?.id ?? null
      setSession(nextSession)
      setProfile(null)
      setLoading(Boolean(nextSession))
      setTimeout(() => { void applySession(nextSession, requestVersion) }, 0)
    })
    return () => { mounted = false; version++; listener.subscription.unsubscribe() }

  }, [])

  const value = useMemo(
    () => ({
      session,
      profile,
      loading,
      error,
      configured: hasSupabaseConfig,
      clearError: () => setError(''),
      signIn: async (identifier, password, identifierType = 'auto') => {
        if (!supabase) return { error: new Error('Supabase is not configured.') }
        setError('')
        const resolvedIdentifierType = identifierType === 'auto' ? detectAuthIdentifierType(identifier) : identifierType
        if (resolvedIdentifierType === 'school_id') return authenticateWithSchoolId('sign-in', identifier, password, setError)
        const normalizedIdentifier = normalizeAuthIdentifier(identifier, resolvedIdentifierType)
        return authenticateWithEmail(normalizedIdentifier, password, setError, resolvedIdentifierType)
      },
      createMemberAccount: async ({ fullName, email, schoolId, password }) => {
        if (!supabase) return { error: new Error('Supabase is not configured.') }
        setError('')
        try {
          const result = await withAuthTimeout(
            supabase.auth.signUp({
              email: email.trim().toLowerCase(),
              password,
              options: {
                emailRedirectTo: window.location.origin,
                data: {
                  full_name: fullName.trim(),
                  // This is an unverified claim, not an authorization field.
                  // The database links it only after email and card/PIN checks.
                  registration_school_id: schoolId.trim().toUpperCase().replace(/\s+/g, ''),
                },
              },
            }),
            'Account registration',
          )
          if (result.error) {
            logAuthFailure('account registration', result.error)
            setError(result.error.message)
          }
          return result
        } catch (authError) {
          logAuthFailure('account registration', authError)
          setError(authError.message)
          return { error: authError }
        }
      },
      completeMemberAccountRegistration: async (schoolId, cardNumber, pin) => {
        if (!supabase) return { error: new Error('Supabase is not configured.') }
        try {
          return await withAuthTimeout(
            supabase.rpc('complete_member_account_registration', {
              p_school_id: schoolId,
              p_card_number: cardNumber,
              p_pin: pin,
            }),
            'Library account verification',
          )
        } catch (authError) {
          return { error: authError }
        }
      },
      refreshProfile: async () => {
        if (!supabase || !session?.user?.id) return { error: new Error('No signed-in account is available.') }
        try {
          const result = await withAuthTimeout(
            supabase.from('profiles').select('id, full_name, role, school_id').eq('id', session.user.id).maybeSingle(),
            'Profile refresh',
          )
          if (result.error || !result.data) {
            const refreshError = result.error || new Error('Your library profile is missing.')
            setError(refreshError.message)
            return { error: refreshError }
          }
          if (result.data.role === 'member') {
            const { data: linked, error: linkError } = await withAuthTimeout(
              supabase.rpc('current_user_has_active_library_member'),
              'Member account verification',
            )
            if (linkError) throw linkError
            setProfile({ ...result.data, member_linked: linked === true })
          } else {
            setProfile({ ...result.data, member_linked: true })
          }
          setError('')
          return result
        } catch (refreshError) {
          setError(refreshError.message)
          return { error: refreshError }
        }
      },
      recoverSchoolId: (schoolId, password, invitation) => authenticateWithSchoolId('recover', schoolId, password, setError, invitation),
      signOut: async () => {
        if (!supabase) return
        try {
          if (session?.user?.id) {
            try {
              const { error: activityError } = await withAuthTimeout(
                supabase.rpc('record_activity_logout'),
                'Logout activity recording',
              )
              if (activityError && import.meta.env.DEV) console.error('[activity] logout recording failed', activityError)
            } catch (activityError) {
              // Audit delivery must never prevent the user from ending a session.
              if (import.meta.env.DEV) console.error('[activity] logout recording failed', activityError)
            }
          }
          const result = await withAuthTimeout(supabase.auth.signOut(), 'Sign out')
          if (result.error) {
            logAuthFailure('sign out', result.error)
            setError(result.error.message)
          }
        } catch (authError) {
          logAuthFailure('sign out', authError)
          setError(authError.message)
        }
      },
    }),
    [error, loading, profile, session],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside AuthProvider')
  return value
}
