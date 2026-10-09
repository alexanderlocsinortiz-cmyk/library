export function friendlyAuthError(error) {
  const message = typeof error === 'string' ? error : error?.message
  const code = typeof error === 'object' && error ? String(error.code || '') : ''
  const status = typeof error === 'object' && error ? Number(error.status || 0) : 0
  const normalized = `${code} ${message || ''}`.toLowerCase()

  if (normalized.includes('user_already_exists') || normalized.includes('email_exists') || normalized.includes('user already registered') || normalized.includes('already been registered')) {
    return 'An account with this email already exists. Sign in, or use Forgot Password if you cannot access it.'
  }
  if (normalized.includes('invalid_registration') || normalized.includes('invalid school id')) {
    return 'Enter a School ID using 3–32 letters, numbers, dots, underscores, or hyphens. It is not checked against library records.'
  }
  if (normalized.includes('weak_password') || normalized.includes('password should be at least') || normalized.includes('password must be at least')) {
    return 'Choose a password that meets the 8–12 character limit.'
  }
  if (normalized.includes('invalid_email') || normalized.includes('email_address_invalid') || normalized.includes('unable to validate email address') || normalized.includes('invalid email address') || normalized.includes('email address is invalid')) {
    return 'Enter a valid email address, such as name@example.com.'
  }
  if (normalized.includes('over_email_send_rate_limit') || normalized.includes('email rate limit')) {
    return 'Supabase is limiting verification emails. Wait a few minutes, then try again.'
  }
  if (normalized.includes('error sending confirmation email') || normalized.includes('confirmation email') && (normalized.includes('smtp') || normalized.includes('delivery') || normalized.includes('send'))) {
    return 'The account could not be created because Supabase could not send the verification email. Check the project email/SMTP settings, then try again.'
  }
  if (normalized.includes('database error saving new user') || normalized.includes('database_error') || normalized.includes('trigger')) {
    return 'Supabase could not save the new account. Check that the latest database migrations and profile-creation triggers are installed.'
  }
  if (normalized.includes('unexpected_failure') || normalized.includes('internal server error') || status >= 500) {
    return 'Supabase returned a server error while creating the account. Check the Supabase Auth and Postgres logs for the exact cause.'
  }
  if (normalized.includes('signup_disabled') || normalized.includes('signups not allowed') || normalized.includes('signup is disabled')) {
    return 'Registration is disabled in Supabase Auth. Enable email sign-ups in the project settings.'
  }
  if (normalized.includes('failed to fetch') || normalized.includes('timed out') || normalized.includes('network') || normalized.includes('functions_fetch_error')) {
    return 'The library service could not be reached. Check your internet connection and Supabase URL, then try again.'
  }
  if (normalized.includes('registration cancellation is temporarily unavailable') || normalized.includes('could not be cancelled right now')) {
    return 'Registration cancellation is temporarily unavailable. Try again in a moment.'
  }
  if (normalized.includes('registration could not be cancelled')) {
    return 'Cancellation failed. Check the password and registration details. Only an unverified registration can be cancelled.'
  }
  if (normalized.includes('already verified')) {
    return 'This email is already verified. Sign in with this email address.'
  }
  if (normalized.includes('edge function') || normalized.includes('function not found') || normalized.includes('not configured on the server')) {
    return 'The registration service is unavailable. Check that the registration-lifecycle function is deployed, then try again.'
  }
  if (normalized.includes('invalid email, school id, or password') || normalized.includes('invalid login credentials') || normalized.includes('school id or password') || normalized.includes('email or password') || normalized.includes('email not confirmed')) {
    return 'Sign-in failed. Check your email or School ID and password. New accounts must confirm their email first; School ID sign-in requires a linked library record.'
  }
  if (normalized.includes('expired') || normalized.includes('otp_expired') || normalized.includes('token has expired')) {
    return 'That code has expired. Request a new six-digit code and try again.'
  }
  if (normalized.includes('invalid otp') || normalized.includes('invalid token') || normalized.includes('otp is invalid') || normalized.includes('token is invalid')) {
    return 'That code is not valid. Check the latest email and enter its six-digit code.'
  }
  if (normalized.includes('rate limit') || normalized.includes('too many sign-in attempts')) {
    return 'Too many attempts were made. Wait a few minutes, then try again.'
  }

  // Preserve useful Supabase/Edge Function details when the cause has no
  // dedicated message, instead of hiding it behind a generic error.
  const readableMessage = String(message || '').trim().replace(/\s+/g, ' ')
  if (readableMessage && readableMessage.length <= 240) return readableMessage
  if (readableMessage) return `${readableMessage.slice(0, 237)}…`
  return 'Registration failed without an error message. Check the browser console and Supabase Auth logs for details.'
}
