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

function maskIdentifier(value: string, isPhone: boolean) {
  if (isPhone) {
    const digits = value.replace(/\D/g, '')
    return `***${digits.slice(-2) || '**'}`
  }
  const [local = '', domain = ''] = value.trim().toLowerCase().split('@')
  const safeDomain = domain.replace(/[^a-z0-9.-]/g, '').slice(0, 120)
  return safeDomain
    ? `${local ? `${local.slice(0, 1)}***` : '***'}@${safeDomain}`
    : `${value.trim().slice(0, 1) || '*'}***`
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
    return json({ ok: false, error: { message: 'Email authentication is not configured on the server.' } }, 500)
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const auth = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const recordAuthActivity = async (action: 'login_success' | 'failed_login', identifier: string, isPhone: boolean, userId?: string) => {
    let actorName = 'Unknown account'
    let actorRole = 'unknown'
    if (userId) {
      const { data: profile, error: profileError } = await admin.from('profiles')
        .select('full_name, role').eq('id', userId).maybeSingle()
      if (profileError) console.error('[email-auth] activity profile lookup failed', profileError.code ?? 'unknown')
      actorName = profile?.full_name || maskIdentifier(identifier, isPhone) || 'Library user'
      actorRole = profile?.role || 'unknown'
    }
    const description = action === 'failed_login'
      ? `Failed login attempt for ${isPhone ? 'phone number' : 'account'} ${maskIdentifier(identifier, isPhone)}.`
      : 'Signed in successfully.'
    const { error: logError } = await admin.from('activity_logs').insert({
      actor_user_id: userId ?? null,
      actor_name_snapshot: actorName,
      actor_role_snapshot: actorRole,
      action,
      module: 'authentication',
      description,
      entity_type: 'account',
      entity_id: userId ?? null,
      status: action === 'failed_login' ? 'failure' : 'success',
    })
    if (logError) console.error('[email-auth] activity write failed', logError.code ?? 'unknown')
  }

  try {
    const body = await request.json()
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase().slice(0, 320) : ''
    const phone = typeof body?.phone === 'string' ? body.phone.trim().slice(0, 40) : ''
    const isPhone = !email && Boolean(phone)
    const identifier = email || phone
    const password = typeof body?.password === 'string' ? body.password : ''
    if (!identifier || !password || password.length > 128) {
      await recordAuthActivity('failed_login', identifier, isPhone)
      return json({ ok: false, error: { message: 'Invalid email, School ID, or password.' } }, 400)
    }

    const { data, error } = await auth.auth.signInWithPassword({ ...(isPhone ? { phone } : { email }), password })
    if (error) {
      if (error.status === 429) {
        return json({ ok: false, error: { message: 'Too many sign-in attempts. Try again in 15 minutes.' } }, 429)
      }
      if (isCredentialRejection(error)) {
        await recordAuthActivity('failed_login', identifier, isPhone)
        // Do not reveal whether an account exists, is confirmed, or uses a
        // different credential. Keep the response identical for login failures.
        return json({ ok: false, error: { message: 'Invalid email, School ID, or password.' } })
      }
      console.error('[email-auth] password verification service failed', error.status ?? 'unknown', error.code ?? 'unknown')
      return json({ ok: false, error: { message: 'Email authentication could not be completed.' } }, 503)
    }
    if (!data.session) {
      console.error('[email-auth] password verification returned no session')
      return json({ ok: false, error: { message: 'Email authentication could not be completed.' } }, 503)
    }

    await recordAuthActivity('login_success', identifier, isPhone, data.user.id)
    return json({ ok: true, session: data.session, userId: data.user.id })
  } catch (error) {
    console.error('[email-auth] request failed', error instanceof Error ? error.name : 'UnknownError')
    return json({ ok: false, error: { message: 'Email authentication could not be completed.' } }, 500)
  }
})
