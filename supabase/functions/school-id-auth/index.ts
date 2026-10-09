import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function normalizeSchoolId(value: unknown) {
  return String(value ?? '').trim().toUpperCase().replace(/\s+/g, '')
}

function isValidSchoolId(value: string) {
  return /^[A-Z0-9][A-Z0-9._-]{2,31}$/.test(value)
}

function maskSchoolId(value: string) {
  const normalized = normalizeSchoolId(value)
  if (normalized.length < 3) return '***'
  return `${normalized.slice(0, 2)}***${normalized.slice(-2)}`
}

function isCredentialRejection(error: { status?: number; code?: string } | null | undefined) {
  return Boolean(error && (
    [400, 401, 422].includes(error.status ?? 0)
    || ['invalid_credentials', 'email_not_confirmed'].includes(error.code ?? '')
  ))
}

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ ok: false, error: { message: 'Only POST requests are supported.' } }, 405)

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return json({ ok: false, error: { message: 'School ID authentication is not configured on the server.' } }, 500)
  }

  try {
    const body = await request.json()
    const action = body?.action
    if (action === 'sign-up') return json({ ok: false, error: { message: 'Use email registration to create an account. This service only signs in verified School ID accounts.' } }, 403)
    if (!['sign-in', 'recover'].includes(action)) return json({ ok: false, error: { message: 'Invalid action.' } }, 400)
    const schoolId = normalizeSchoolId(body?.schoolId)
    const password = String(body?.password ?? '')
    const invitation = String(body?.invitation ?? '')
    if (action === 'recover' && !/^[a-f0-9]{64}$/.test(invitation)) {
      return json({ ok: false, error: { message: 'A valid staff-issued invitation is required. Contact the library to verify your identity.' } })
    }

    if (!isValidSchoolId(schoolId)) {
      return json({ ok: false, error: { message: 'Enter a valid school ID using 3-32 letters, numbers, dots, underscores, or hyphens.' } })
    }
    if (action === 'sign-in' && (password.length < 6 || password.length > 128)) {
      return json({ ok: false, error: { message: 'Invalid email, School ID, or password.' } })
    }
    if (action === 'recover' && (password.length < 8 || password.length > 12)) {
      return json({ ok: false, error: { message: 'New passwords must contain 8–12 characters.' } })
    }
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const auth = createClient(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const recordActivity = async (
      activity: 'login_success' | 'failed_login' | 'password_changed',
      userId?: string,
    ) => {
      let actorName = 'Unknown account'
      let actorRole = 'unknown'
      if (userId) {
        const { data: profile, error: profileError } = await admin.from('profiles')
          .select('full_name, role').eq('id', userId).maybeSingle()
        if (profileError) console.error('[school-id-auth] activity profile lookup failed', profileError.code ?? 'unknown')
        actorName = profile?.full_name || 'Library user'
        actorRole = profile?.role || 'unknown'
      }
      const description = activity === 'failed_login'
        ? `Failed login attempt for School ID ${maskSchoolId(schoolId)}.`
        : activity === 'password_changed'
          ? 'Changed an account password through recovery.'
          : 'Signed in successfully with a School ID.'
      const { error: logError } = await admin.from('activity_logs').insert({
        actor_user_id: userId ?? null,
        actor_name_snapshot: actorName,
        actor_role_snapshot: actorRole,
        action: activity,
        module: 'authentication',
        description,
        entity_type: 'account',
        entity_id: userId ?? null,
        status: activity === 'failed_login' ? 'failure' : 'success',
      })
      if (logError) console.error('[school-id-auth] activity write failed', logError.code ?? 'unknown')
    }
    const { data: allowed, error: limitError } = await admin.rpc('allow_school_auth', { p_school_id: schoolId })
    if (limitError || !allowed) {
      if (action === 'sign-in') {
        // Log the attempt once the server has applied the School ID throttle.
        const { error: logError } = await admin.from('activity_logs').insert({
          actor_name_snapshot: 'Unknown account', actor_role_snapshot: 'unknown',
          action: 'failed_login', module: 'authentication',
          description: `Failed login attempt for School ID ${maskSchoolId(schoolId)}.`,
          entity_type: 'account', status: 'failure',
        })
        if (logError) console.error('[school-id-auth] activity write failed', logError.code ?? 'unknown')
      }
      return json({ ok: false, error: { message: 'Too many attempts or authentication unavailable. Try again in 15 minutes.' } }, 429)
    }

    let signInEmail = ''
    if (action === 'recover') {
      const { data: userId, error: recoveryError } = await admin.rpc('consume_school_recovery', { p_school_id: schoolId, p_token: invitation })
      if (recoveryError || !userId) return json({ ok: false, error: { message: 'Invalid or expired recovery invitation.' } })
      const { error: resetError } = await admin.auth.admin.updateUserById(userId, { password })
      if (resetError) return json({ ok: false, error: { message: 'Recovery failed. Ask staff for a new invitation.' } })
      await recordActivity('password_changed', userId)
      const { data: userResult, error: userError } = await admin.auth.admin.getUserById(userId)
      if (userError || !userResult.user?.email) return json({ ok: false, error: { message: 'Recovery failed. Ask staff for a new invitation.' } })
      signInEmail = userResult.user.email
    } else {
      const { data: resolvedEmail, error: resolveError } = await admin.rpc('school_login_email', { p_school_id: schoolId })
      if (resolveError) {
        console.error('[school-id-auth] account lookup failed', resolveError.code ?? 'unknown')
        return json({ ok: false, error: { message: 'School ID authentication could not be completed.' } }, 503)
      }
      if (typeof resolvedEmail !== 'string' || !resolvedEmail) {
        await recordActivity('failed_login')
        return json({ ok: false, error: { message: 'Invalid email, School ID, or password.' } })
      }
      signInEmail = resolvedEmail
    }

    const { data, error: signInError } = await auth.auth.signInWithPassword({
      email: signInEmail,
      password,
    })

    if (signInError) {
      if (signInError.status === 429) {
        return json({ ok: false, error: { message: 'Too many sign-in attempts. Try again in 15 minutes.' } }, 429)
      }
      if (isCredentialRejection(signInError)) {
        await recordActivity('failed_login')
        return json({ ok: false, error: { message: 'Invalid email, School ID, or password.' } })
      }
      console.error('[school-id-auth] password verification service failed', signInError.status ?? 'unknown', signInError.code ?? 'unknown')
      return json({ ok: false, error: { message: 'School ID authentication could not be completed.' } }, 503)
    }
    if (!data.session) {
      console.error('[school-id-auth] password verification returned no session')
      return json({ ok: false, error: { message: 'School ID authentication could not be completed.' } }, 503)
    }

    await recordActivity('login_success', data.user.id)

    if (action === 'recover') {
      const { error: revokeError } = await admin.auth.admin.signOut(data.session.access_token, 'others')
      if (revokeError) return json({ ok: false, error: { message: 'Password changed, but other sessions could not be revoked. Contact library staff.' } }, 500)
    }

    return json({
      ok: true,
      session: data.session,
      userId: data.user.id,
    })
  } catch (error) {
    console.error('[school-id-auth] request failed', error instanceof Error ? error.name : 'UnknownError')
    return json({ ok: false, error: { message: 'School ID authentication could not be completed.' } }, 500)
  }
})
