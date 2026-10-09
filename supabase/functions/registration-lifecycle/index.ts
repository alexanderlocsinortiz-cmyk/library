import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type Json = Record<string, unknown>
type AdminClient = any
type RegistrationStatus = { status: string; expires_at?: string }

function json(body: Json, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function normalizeEmail(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase().slice(0, 320) : ''
}

function normalizeSchoolId(value: unknown) {
  return typeof value === 'string' ? value.trim().toUpperCase().replace(/\s+/g, '').slice(0, 32) : ''
}

function validEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function validSchoolId(schoolId: string) {
  return !schoolId || /^[A-Z0-9][A-Z0-9._-]{2,31}$/.test(schoolId)
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function sameSecret(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left)
  const rightBytes = new TextEncoder().encode(right)
  if (leftBytes.length !== rightBytes.length) return false
  let difference = 0
  for (let index = 0; index < leftBytes.length; index += 1) difference |= leftBytes[index] ^ rightBytes[index]
  return difference === 0
}

function isMissingAuthUser(error: { status?: number; code?: string } | null | undefined) {
  return error?.status === 404 || error?.code === 'user_not_found' || error?.code === 'not_found'
}

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const cleanupSecret = Deno.env.get('REGISTRATION_CLEANUP_SECRET') ?? ''

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ ok: false, error: { code: 'method_not_allowed', message: 'Only POST requests are supported.' } }, 405)
  if (!supabaseUrl || !serviceRoleKey) return json({ ok: false, error: { code: 'server_unavailable', message: 'Registration services are temporarily unavailable.' } }, 503)

  const admin: AdminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  try {
    const body = await request.json().catch(() => ({})) as Json
    const action = typeof body.action === 'string' ? body.action : ''

    if (action === 'cleanup') {
      if (!cleanupSecret) return json({ ok: false, error: { code: 'server_unavailable', message: 'Cleanup is not configured.' } }, 503)
      const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? ''
      if (!sameSecret(bearer, cleanupSecret)) return json({ ok: false, error: { code: 'unauthorized', message: 'Unauthorized.' } }, 401)
      return await cleanupExpiredRegistrations(admin)
    }

    const email = normalizeEmail(body.email)
    const schoolId = normalizeSchoolId(body.schoolId)
    if (!validEmail(email)) {
      return json({ ok: false, error: { code: 'invalid_email', message: 'Enter a valid email address, such as name@example.com.' } }, 400)
    }
    if (!validSchoolId(schoolId)) {
      return json({ ok: false, error: { code: 'invalid_registration', message: 'Enter a School ID using 3–32 letters, numbers, dots, underscores, or hyphens. It is stored for registration information only.' } }, 400)
    }

    const clientAddress = request.headers.get('cf-connecting-ip')
      || request.headers.get('x-real-ip')
      || 'unknown-client'
    const actionKey = await sha256(`registration:${action}:${clientAddress}:${email}:${schoolId}`)
    const ipKey = await sha256(`registration:${action}:${clientAddress}`)
    const [ipLimit, accountLimit] = await Promise.all([
      admin.rpc('consume_registration_public_rate_limit', { p_rate_key: ipKey, p_limit: 50, p_window_seconds: 3600 }),
      admin.rpc('consume_registration_public_rate_limit', { p_rate_key: actionKey, p_limit: 10, p_window_seconds: 3600 }),
    ])
    if (ipLimit.error || accountLimit.error) {
      console.error('[registration-lifecycle] rate limit check failed', ipLimit.error?.code ?? accountLimit.error?.code ?? 'unknown')
      return json({ ok: false, error: { code: 'server_unavailable', message: 'Registration services are temporarily unavailable.' } }, 503)
    }
    if (!ipLimit.data || !accountLimit.data) {
      return json({ ok: false, error: { code: 'rate_limited', message: 'Too many attempts. Wait before trying again.' } }, 429)
    }

    if (action === 'cancel') {
      const password = typeof body.password === 'string' ? body.password : ''
      if (!anonKey) return json({ ok: false, error: { code: 'server_unavailable', message: 'Registration cancellation is temporarily unavailable.' } }, 503)
      if (password.length < 1 || password.length > 128) {
        return json({ ok: false, error: { code: 'invalid_cancellation', message: 'Enter the password used for this registration.' } }, 400)
      }

      // A password check is required because email and School ID are not
      // sufficient proof to authorize deleting another person's pending account.
      const verifier = createClient(supabaseUrl, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      })
      const { error: credentialError } = await verifier.auth.signInWithPassword({ email, password })
      const passwordMatchesUnconfirmedAccount = credentialError?.code === 'email_not_confirmed'
        || credentialError?.message?.toLowerCase().includes('email not confirmed')
      if (!passwordMatchesUnconfirmedAccount) {
        if (!credentialError) await verifier.auth.signOut({ scope: 'local' })
        return json({ ok: false, error: { code: 'cancellation_rejected', message: 'Registration could not be cancelled. Check the password and registration details.' } }, 400)
      }

      const { data: userId, error: claimError } = await admin.rpc('claim_member_registration_cancellation', {
        p_email: email,
        p_school_id: schoolId,
      })
      if (claimError) {
        console.error('[registration-lifecycle] cancellation claim failed', claimError.code ?? 'unknown')
        return json({ ok: false, error: { code: 'server_unavailable', message: 'Registration cancellation is temporarily unavailable.' } }, 503)
      }
      if (!userId) {
        return json({ ok: false, error: { code: 'cancellation_rejected', message: 'Registration could not be cancelled. Check the password and registration details.' } }, 409)
      }

      const releaseClaim = async (errorCode: string) => {
        const { error } = await admin.rpc('finish_member_registration_cancellation', {
          p_user_id: userId,
          p_deleted: false,
          p_error_code: errorCode,
        })
        if (error) console.error('[registration-lifecycle] cancellation release failed', error.code ?? 'unknown')
        return error
      }

      const { data: currentUser, error: lookupError } = await admin.auth.admin.getUserById(userId)
      if (lookupError && isMissingAuthUser(lookupError)) {
        const { error } = await admin.rpc('finish_member_registration_cancellation', {
          p_user_id: userId, p_deleted: true, p_error_code: null,
        })
        if (error) console.error('[registration-lifecycle] cancellation completion failed', error.code ?? 'unknown')
        return json({ ok: true, status: 'cancelled', message: 'The pending registration was cancelled.' })
      }
      const currentAuthUser = currentUser?.user
      if (lookupError || !currentAuthUser || currentAuthUser.email_confirmed_at || currentAuthUser.email?.toLowerCase() !== email) {
        await releaseClaim(lookupError?.code ?? (currentAuthUser?.email_confirmed_at ? 'email_confirmed' : 'email_changed'))
        return json({ ok: false, error: { code: 'cancellation_rejected', message: 'Registration could not be cancelled. Check the password and registration details.' } }, 409)
      }

      const { data: safeToDelete, error: safetyError } = await admin.rpc('validate_member_registration_cancellation', {
        p_user_id: userId,
        p_email: email,
        p_school_id: schoolId,
      })
      if (safetyError || safeToDelete !== true) {
        if (safetyError) console.error('[registration-lifecycle] cancellation safety check failed', safetyError.code ?? 'unknown')
        await releaseClaim(safetyError?.code ?? 'safety_check_failed')
        return json({ ok: false, error: { code: 'cancellation_rejected', message: 'Registration could not be cancelled. Check the password and details, or request staff help.' } }, 409)
      }

      const { error: deleteError } = await admin.auth.admin.deleteUser(userId)
      if (deleteError) {
        const { error: latestLookupError } = await admin.auth.admin.getUserById(userId)
        if (latestLookupError && isMissingAuthUser(latestLookupError)) {
          const { error } = await admin.rpc('finish_member_registration_cancellation', {
            p_user_id: userId, p_deleted: true, p_error_code: null,
          })
          if (error) console.error('[registration-lifecycle] cancellation completion failed', error.code ?? 'unknown')
          return json({ ok: true, status: 'cancelled', message: 'The pending registration was cancelled.' })
        }
        await releaseClaim(deleteError.code ?? 'auth_delete_failed')
        console.error('[registration-lifecycle] account cancellation failed', deleteError.code ?? 'unknown')
        return json({ ok: false, error: { code: 'cancellation_failed', message: 'The pending registration could not be cancelled right now. Try again.' } }, 503)
      }

      const { error: finishError } = await admin.rpc('finish_member_registration_cancellation', {
        p_user_id: userId,
        p_deleted: true,
        p_error_code: null,
      })
      if (finishError) console.error('[registration-lifecycle] cancellation completion failed', finishError.code ?? 'unknown')
      return json({ ok: true, status: 'cancelled', message: 'The pending registration was cancelled.' })
    }

    if (action === 'status') {
      const { data, error } = await admin.rpc('get_member_registration_status', {
        p_email: email,
        p_school_id: schoolId,
      })
      if (error) {
        console.error('[registration-lifecycle] status lookup failed', error.code ?? 'unknown')
        return json({ ok: false, error: { code: 'server_unavailable', message: 'Registration status could not be checked.' } }, 503)
      }
      return json({ ok: true, ...(data as Json) })
    }

    if (action === 'prepare') {
      const firstStatus = await getStatus(admin, email, schoolId)
      if (firstStatus.error) return json({ ok: false, error: { code: 'server_unavailable', message: 'Registration status could not be checked.' } }, 503)
      if (firstStatus.status !== 'expired') return json({ ok: true, ...firstStatus })

      const { data: claimedUserId, error: claimError } = await admin.rpc('claim_expired_registration_for_signup', {
        p_email: email,
        p_school_id: schoolId,
      })
      if (claimError) {
        console.error('[registration-lifecycle] expired registration claim failed', claimError.code ?? 'unknown')
        return json({ ok: false, error: { code: 'server_unavailable', message: 'Expired registration could not be safely cleared. Try again shortly.' } }, 503)
      }
      if (claimedUserId) {
        const cleanup = await deleteClaimedRegistration(admin, claimedUserId, email)
        if (!cleanup.ok) {
          const latestStatus = await getStatus(admin, email, schoolId)
          if (latestStatus.status !== 'expired_protected') {
            return json({ ok: false, error: { code: 'cleanup_retry', message: 'The expired registration could not be cleared safely. Try again shortly.' } }, 503)
          }
        }
      }

      const latestStatus = await getStatus(admin, email, schoolId)
      if (latestStatus.status === 'not_found') return json({ ok: true, status: 'ready' })
      if (latestStatus.status === 'verified') return json({ ok: true, ...latestStatus })
      if (latestStatus.status === 'expired_protected') {
        return json({ ok: false, error: { code: 'registration_preserved', message: 'This expired account is linked to library records and was preserved. Contact library staff for help.' } }, 409)
      }
      if (latestStatus.status === 'expired') {
        return json({ ok: false, error: { code: 'cleanup_retry', message: 'Registration expired. Please create your account again.' } }, 410)
      }
      return json({ ok: true, ...latestStatus })
    }

    if (action === 'resend') {
      const { data, error } = await admin.rpc('authorize_registration_otp_resend', {
        p_email: email,
        p_school_id: schoolId,
      })
      if (error) {
        console.error('[registration-lifecycle] resend authorization failed', error.code ?? 'unknown')
        return json({ ok: false, error: { code: 'server_unavailable', message: 'The verification email could not be sent. Try again later.' } }, 503)
      }
      const authorization = data as { status?: string; retry_after_seconds?: number; email?: string }
      if (authorization.status === 'not_found' || authorization.status === 'verified') {
        return json({ ok: true, status: authorization.status, message: 'If a matching pending registration exists, a verification email has been sent.' })
      }
      if (authorization.status === 'expired') {
        return json({ ok: false, status: 'expired', error: { code: 'registration_expired', message: 'Registration expired. Please create your account again.' } }, 410)
      }
      if (authorization.status === 'preserved') {
        return json({ ok: false, status: 'expired_protected', error: { code: 'registration_preserved', message: 'This expired account is linked to library records and was preserved. Contact library staff for help.' } }, 409)
      }
      if (authorization.status === 'cooldown' || authorization.status === 'rate_limited') {
        const seconds = Math.max(1, Number(authorization.retry_after_seconds) || 60)
        return json({ ok: false, status: authorization.status, retryAfterSeconds: seconds, error: {
          code: authorization.status,
          message: authorization.status === 'cooldown'
            ? `Wait ${seconds} seconds before requesting another verification email.`
            : 'The maximum number of verification email requests has been reached. Try again in an hour.',
        } }, 429)
      }
      if (authorization.status !== 'allowed' || authorization.email !== email) {
        return json({ ok: false, error: { code: 'registration_unavailable', message: 'This registration is not available for another verification email. Check the email address or contact library staff.' } }, 409)
      }

      let emailRedirectTo: string | undefined
      const requestOrigin = request.headers.get('origin')
      if (requestOrigin) {
        try {
          const parsedOrigin = new URL(requestOrigin)
          if (parsedOrigin.origin === requestOrigin && ['http:', 'https:'].includes(parsedOrigin.protocol)) {
            emailRedirectTo = parsedOrigin.origin
          }
        } catch { /* Supabase will use its configured Site URL when Origin is invalid. */ }
      }
      const { error: resendError } = await admin.auth.resend({
        type: 'signup',
        email,
        options: emailRedirectTo ? { emailRedirectTo } : {},
      })
      if (resendError) {
        console.error('[registration-lifecycle] verification email resend failed', resendError.code ?? 'unknown')
        return json({ ok: false, error: { code: 'verification_email_delivery_failed', message: 'Supabase could not send the verification email. Wait for the cooldown, then try again.' } }, 429)
      }
      return json({ ok: true, status: 'sent', message: 'A new verification email has been sent.' })
    }

    return json({ ok: false, error: { code: 'invalid_action', message: 'Unsupported registration action.' } }, 400)
  } catch (error) {
    console.error('[registration-lifecycle] request failed', error instanceof Error ? error.message : 'unknown')
    return json({ ok: false, error: { code: 'server_error', message: 'Registration services could not complete the request. Try again.' } }, 500)
  }
})

async function getStatus(admin: AdminClient, email: string, schoolId: string): Promise<RegistrationStatus & { error?: unknown }> {
  const { data, error } = await admin.rpc('get_member_registration_status', {
    p_email: email,
    p_school_id: schoolId,
  })
  if (error) {
    console.error('[registration-lifecycle] status lookup failed', error.code ?? 'unknown')
    return { status: 'unavailable', error }
  }
  return data as RegistrationStatus
}

async function deleteClaimedRegistration(
  admin: AdminClient,
  userId: string,
  expectedEmail?: string,
) {
  // The SQL claim already rechecked expiration, email confirmation, assistance,
  // active-member links, and every loan/reservation. Read Auth immediately
  // before the Admin delete as a second independent confirmation check.
  const { data, error } = await admin.auth.admin.getUserById(userId)
  if (error && isMissingAuthUser(error)) {
    const { error: finishError } = await admin.rpc('finish_expired_member_registration_cleanup', {
      p_user_id: userId,
      p_deleted: true,
      p_error_code: null,
    })
    return { ok: !finishError, error: finishError }
  }
  if (error || !data.user) {
    const { error: releaseError } = await admin.rpc('finish_expired_member_registration_cleanup', {
      p_user_id: userId,
      p_deleted: false,
      p_error_code: error?.code ?? 'auth_lookup_failed',
    })
    return { ok: false, error: releaseError ?? error }
  }
  const authUser = data.user
  if (authUser.email_confirmed_at || (expectedEmail && authUser.email?.toLowerCase() !== expectedEmail)) {
    const { error: releaseError } = await admin.rpc('finish_expired_member_registration_cleanup', {
      p_user_id: userId,
      p_deleted: false,
      p_error_code: authUser.email_confirmed_at ? 'email_confirmed' : 'email_changed',
    })
    return { ok: false, error: releaseError ?? new Error('Registration state changed during cleanup.') }
  }

  const { data: safeToDelete, error: safetyError } = await admin.rpc('validate_member_registration_cleanup', {
    p_user_id: userId,
  })
  if (safetyError) {
    // Leave the short lease in place. The scheduled worker can retry after the
    // lease expires, and no Auth deletion occurs without this second DB check.
    console.error('[registration-lifecycle] final safety check failed', safetyError.code ?? 'unknown')
    return { ok: false, error: safetyError }
  }
  if (safeToDelete !== true) return { ok: false, error: new Error('Registration safety conditions changed.') }

  const { error: deleteError } = await admin.auth.admin.deleteUser(userId)
  if (deleteError) {
    const { data: recheck, error: recheckError } = await admin.auth.admin.getUserById(userId)
    if (recheckError && isMissingAuthUser(recheckError)) {
      const { error: finishError } = await admin.rpc('finish_expired_member_registration_cleanup', {
        p_user_id: userId,
        p_deleted: true,
        p_error_code: null,
      })
      return { ok: !finishError, error: finishError }
    }
    const errorCode = deleteError.code ?? 'admin_delete_failed'
    const { error: releaseError } = await admin.rpc('finish_expired_member_registration_cleanup', {
      p_user_id: userId,
      p_deleted: false,
      p_error_code: errorCode,
    })
    if (!recheckError && recheck.user?.email_confirmed_at) {
      return { ok: false, error: releaseError ?? new Error('The account was confirmed during cleanup and was preserved.') }
    }
    return { ok: false, error: releaseError ?? deleteError }
  }

  const { error: finishError } = await admin.rpc('finish_expired_member_registration_cleanup', {
    p_user_id: userId,
    p_deleted: true,
    p_error_code: null,
  })
  return { ok: !finishError, error: finishError }
}

async function cleanupExpiredRegistrations(admin: AdminClient) {
  const { data: candidates, error } = await admin.rpc('list_expired_member_registrations', { p_limit: 50 })
  if (error) {
    console.error('[registration-lifecycle] cleanup scan failed', error.code ?? 'unknown')
    return json({ ok: false, error: { code: 'cleanup_scan_failed', message: 'Cleanup scan failed.' } }, 500)
  }

  let claimed = 0
  let removed = 0
  let preservedOrDeferred = 0
  for (const candidate of (candidates ?? []) as Array<{ user_id: string }>) {
    const { data: didClaim, error: claimError } = await admin.rpc('claim_expired_member_registration', {
      p_user_id: candidate.user_id,
    })
    if (claimError) {
      console.error('[registration-lifecycle] cleanup claim failed', claimError.code ?? 'unknown')
      preservedOrDeferred += 1
      continue
    }
    if (!didClaim) {
      preservedOrDeferred += 1
      continue
    }
    claimed += 1
    const result = await deleteClaimedRegistration(admin, candidate.user_id)
    if (result.ok) removed += 1
    else preservedOrDeferred += 1
  }
  return json({ ok: true, scanned: candidates?.length ?? 0, claimed, removed, preservedOrDeferred })
}
