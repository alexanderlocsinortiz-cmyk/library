import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type DeletionPreflight = {
  allowed: boolean
  code?: string
  target_name?: string
  target_role?: string
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: { message: 'Use POST for account deletion.' } }, 405)

  const authorization = request.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) {
    return json({ error: { message: 'Administrator sign-in is required.' } }, 401)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    console.error('[admin-delete-user] required server configuration is missing')
    return json({ error: { message: 'Account deletion is temporarily unavailable.' } }, 500)
  }

  try {
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    })
    const { data: callerData, error: callerError } = await callerClient.auth.getUser()
    if (callerError || !callerData.user) {
      return json({ error: { message: 'Your administrator session is invalid or expired. Sign in again.' } }, 401)
    }

    let body: { targetUserId?: unknown }
    try {
      body = await request.json()
    } catch {
      return json({ error: { message: 'Choose a valid user account.' } }, 400)
    }
    const targetUserId = typeof body.targetUserId === 'string' ? body.targetUserId : ''
    if (!uuidPattern.test(targetUserId)) {
      return json({ error: { message: 'Choose a valid user account.' } }, 400)
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    })
    const { data: callerProfile, error: callerProfileError } = await admin.from('profiles')
      .select('full_name, role').eq('id', callerData.user.id).maybeSingle()
    if (callerProfileError || callerProfile?.role !== 'administrator') {
      return json({ error: { message: 'Administrator access is required.' } }, 403)
    }

    const { data: preflightData, error: preflightError } = await admin.rpc('admin_user_deletion_preflight', {
      p_actor_user_id: callerData.user.id,
      p_target_user_id: targetUserId,
    })
    if (preflightError) {
      console.error('[admin-delete-user] deletion preflight failed', preflightError.code ?? 'unknown')
      return json({ error: { message: 'The account could not be checked safely. Try again.' } }, 500)
    }

    const preflight = preflightData as DeletionPreflight | null
    if (!preflight?.allowed) {
      const messages: Record<string, string> = {
        admin_required: 'Administrator access is required.',
        cannot_delete_self: 'You cannot delete the administrator account you are currently using.',
        account_not_found: 'This account no longer exists. Refresh the user list.',
        last_administrator_required: 'The last active administrator cannot be deleted.',
        library_history_exists: 'This account has borrowing or reservation history. The account is preserved so that history remains intact.',
        verification_assistance_open: 'This account has an open verification assistance request. Resolve it before deleting the account.',
        deletion_in_progress: 'Another administrator is already deleting this account. Refresh the user list shortly.',
      }
      const code = preflight?.code || 'deletion_not_allowed'
      const status = code === 'admin_required' ? 403 : code === 'account_not_found' ? 404 : 409
      return json({ error: { code, message: messages[code] || 'This account cannot be deleted safely.' } }, status)
    }

    const targetName = preflight.target_name || 'Unnamed user'
    const targetRole = preflight.target_role || 'unknown'
    const { error: deleteError } = await admin.auth.admin.deleteUser(targetUserId)
    if (!deleteError) {
      return json({
        ok: true,
        message: `${targetName}'s sign-in account was deleted. Library records and audit history were retained.`,
      })
    }

    // Auth Admin requests can time out after the database has committed. Check
    // Auth once before declaring failure; the database trigger records success
    // atomically with deletion and removes only transient OTP state.
    const { data: targetCheck, error: targetCheckError } = await admin.auth.admin.getUserById(targetUserId)
    if (!targetCheckError && !targetCheck.user) {
      return json({
        ok: true,
        message: `${targetName}'s sign-in account was deleted. Library records and audit history were retained.`,
      })
    }
    if (targetCheckError && /not found|does not exist|404/i.test(targetCheckError.message)) {
      return json({
        ok: true,
        message: `${targetName}'s sign-in account was deleted. Library records and audit history were retained.`,
      })
    }

    const { error: auditError } = await admin.rpc('record_admin_user_deletion_failure', {
      p_actor_user_id: callerData.user.id,
      p_target_user_id: targetUserId,
    })
    if (auditError) console.error('[admin-delete-user] failure audit could not be recorded', auditError.code ?? 'unknown')
    if (targetCheckError) {
      return json({ error: { message: 'Deletion status could not be confirmed. Refresh the user list before trying again.' } }, 503)
    }
    console.error('[admin-delete-user] Auth Admin rejected deletion', deleteError.code ?? 'unknown')
    return json({ error: { message: 'The account was not deleted. It may still be linked to protected library records.' } }, 409)
  } catch (error) {
    console.error('[admin-delete-user] request failed', error instanceof Error ? error.message : 'unknown')
    return json({ error: { message: 'Account deletion could not be completed. Refresh the user list and try again.' } }, 500)
  }
})
