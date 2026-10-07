import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { hasSupabaseConfig, supabase } from './supabase'

const AuthContext = createContext(null)
export const AUTH_REQUEST_TIMEOUT_MS = 8000

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
    const applySession = async (nextSession, requestVersion) => {
      if (!mounted || requestVersion !== version) return
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
        setProfile(data)
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
      const requestVersion = ++version
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
      signIn: async (identifier, password, identifierType = 'email') => {
        if (!supabase) return { error: new Error('Supabase is not configured.') }
        setError('')
        if (identifierType === 'school_id') return authenticateWithSchoolId('sign-in', identifier, password, setError)
        try {
          const normalizedIdentifier = normalizeAuthIdentifier(identifier, identifierType)
          const credentials = identifierType === 'phone'
            ? { phone: normalizedIdentifier, password }
            : { email: normalizedIdentifier, password }
          const result = await withAuthTimeout(
            supabase.auth.signInWithPassword(credentials),
            'Sign in',
          )
          if (result.error) {
            logAuthFailure('sign in', result.error)
            setError(result.error.message)
          }
          return result
        } catch (authError) {
          logAuthFailure('sign in', authError)
          setError(authError.message)
          return { error: authError }
        }
      },
      recoverSchoolId: (schoolId, password, invitation) => authenticateWithSchoolId('recover', schoolId, password, setError, invitation),
      signOut: async () => {
        if (!supabase) return
        try {
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
