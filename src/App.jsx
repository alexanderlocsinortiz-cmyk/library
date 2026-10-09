import { fetchAllRows } from './lib/paging'
import { TransactionHistory } from './components/TransactionHistory'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Paper, TextField } from '@mui/material'
import { detectAuthIdentifierType, isValidNewPassword, useAuth } from './lib/auth'
import { friendlyAuthError } from './lib/auth-errors'
export { friendlyAuthError } from './lib/auth-errors'
import { supabase } from './lib/supabase'
import { defaultCirculationPolicy, formatFine, getLoanDueState, normalizeCirculationPolicy } from './lib/circulation'
import { HomePage } from './components/HomePage'
import { BookCoverArt } from './components/BookCoverArt'
import { PasswordField } from './components/PasswordField'
import { clearPendingRegistration } from './lib/pending-registration'

const lazyNamed = (loader, exportName) => lazy(() => loader().then((module) => ({ default: module[exportName] })))
const SystemSettings = lazyNamed(() => import('./components/StaffTools'), 'SystemSettings')
const StaffCatalogManager = lazyNamed(() => import('./components/StaffTools'), 'StaffCatalogManager')
const StaffCirculation = lazyNamed(() => import('./components/StaffTools'), 'StaffCirculation')
const CatalogPage = lazyNamed(() => import('./components/MemberViews'), 'CatalogPage')
const MemberBooks = lazyNamed(() => import('./components/MemberViews'), 'MemberBooks')
const MemberHistory = lazyNamed(() => import('./components/MemberViews'), 'MemberHistory')
const MemberNotifications = lazyNamed(() => import('./components/MemberViews'), 'MemberNotifications')
const MemberProfile = lazyNamed(() => import('./components/MemberViews'), 'MemberProfile')
const MemberReservations = lazyNamed(() => import('./components/MemberViews'), 'MemberReservations')
const StaffMembers = lazyNamed(() => import('./components/StaffViews'), 'StaffMembers')
const StaffOverdue = lazyNamed(() => import('./components/StaffViews'), 'StaffOverdue')
const StaffReservations = lazyNamed(() => import('./components/StaffViews'), 'StaffReservations')
const StaffBookRequests = lazyNamed(() => import('./components/StaffInventory'), 'StaffBookRequests')
const StaffInventoryAudit = lazyNamed(() => import('./components/StaffInventory'), 'StaffInventoryAudit')
const AnalyticsSection = lazyNamed(() => import('./components/AnalyticsSection'), 'AnalyticsSection')
const ReportsExplorer = lazyNamed(() => import('./components/ReportsExplorer'), 'ReportsExplorer')
const ActivityLogs = lazyNamed(() => import('./components/ActivityLogs'), 'ActivityLogs')

const roleLabels = {
  member: 'Member',
  librarian: 'Librarian',
  administrator: 'Administrator',
}

const navigationIconPaths = {
  dashboard: 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z',
  catalog: 'M5 5h14v14H5z M8 9h8 M8 13h8 M8 17h5',
  books: 'M5 4h9a5 5 0 0 1 5 5v11H10a5 5 0 0 0-5 0V4z M5 18h14',
  copies: 'M5 7h14v12H5z M8 4h11v3 M8 11h8 M8 15h5',
  reservations: 'M6 5h12a2 2 0 0 1 2 2v12H4V7a2 2 0 0 1 2-2z M8 3v4 M16 3v4 M7 11h10 M7 15h6',
  circulation: 'M7 7h10l-3-3 M17 7l-3 3 M17 17H7l3 3 M7 17l3-3',
  transactions: 'M6 5h12 M6 10h12 M6 15h8 M4 5h.01 M4 10h.01 M4 15h.01',
  overdue: 'M12 6v6l4 2 M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0z',
  members: 'M16 20v-1a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v1 M10 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M16 11a3 3 0 0 0 0-6',
  requests: 'M6 4h12v16H6z M9 8h6 M9 12h6 M9 16h4',
  audit: 'M4 5h16v14H4z M8 9l2 2 5-5 M8 15h8',
  reports: 'M5 19V9 M12 19V5 M19 19v-7',
  'system-settings': 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.7 2.9-.2-.1a1.7 1.7 0 0 0-1.8.1l-.2.1h-3.4l-.1-.2a1.7 1.7 0 0 0-1.5-1l-.2-.1-2.9-1.7.1-.2a1.7 1.7 0 0 0-.1-1.8l-.1-.2v-3.4l.2-.1a1.7 1.7 0 0 0 1-1.5l.1-.2 1.7-2.9.2.1a1.7 1.7 0 0 0 1.8-.1l.2-.1h3.4l.1.2a1.7 1.7 0 0 0 1.5 1l.2.1 2.9 1.7-.1.2a1.7 1.7 0 0 0 .1 1.8l.1.2z',
  'my-books': 'M5 4h9a5 5 0 0 1 5 5v11H10a5 5 0 0 0-5 0V4z',
  history: 'M5 12a7 7 0 1 0 2-5 M5 5v4h4 M12 8v5l3 2',
  'activity-logs': 'M5 12a7 7 0 1 0 2-5 M5 5v4h4 M12 8v5l3 2',
  notifications: 'M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M10 21h4',
  profile: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M5 21a7 7 0 0 1 14 0',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  signout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9',
}

function NavigationIcon({ id }) {
  return <svg className="navigation-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={navigationIconPaths[id] || navigationIconPaths.dashboard} /></svg>
}

function SetupNotice() {
  return (
    <section className="setup-card">
      <span className="eyebrow">Local setup</span>
      <h2>Connect Supabase to start</h2>
      <p>
        Copy <code>.env.example</code> to <code>.env.local</code>, add your Supabase
        project URL and publishable key, then restart the development server.
      </p>
      <ol>
        <li>Create a Supabase project.</li>
        <li>Run the SQL migrations in <code>supabase/migrations</code> in order.</li>
        <li>Start the app with <code>npm run dev</code>.</li>
      </ol>
    </section>
  )
}

const authFieldSx = {
  '& .MuiOutlinedInput-root': {
    minHeight: '3.05rem',
    borderRadius: '.55rem',
    backgroundColor: '#fff',
    '& fieldset': { borderColor: '#d5dfe4' },
    '&:hover fieldset': { borderColor: '#aebfc9' },
    '&.Mui-focused fieldset': { borderColor: '#a40000', borderWidth: '1px' },
  },
  '& .MuiInputBase-input': {
    minHeight: 'unset',
    padding: '.78rem .85rem',
    color: '#00263d',
    fontSize: '.9rem',
  },
  '& .MuiInputLabel-root': {
    color: '#5d6d76',
    fontSize: '.84rem',
  },
  '& .MuiInputLabel-root.Mui-focused': { color: '#a40000' },
}

const authFeedbackSx = {
  borderRadius: '.65rem',
  fontSize: '.78rem',
  lineHeight: 1.45,
  '& .MuiAlert-icon': { paddingTop: '.1rem' },
}

function AuthForm({ onBrowseCatalog, onBackToHomepage }) {
  const {
    signIn,
    createMemberAccount,
    getRegistrationStatus,
    resendRegistrationEmail,
    requestPasswordResetOtp,
    completePasswordReset,
    error: authError,
    clearError,
  } = useAuth()
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [recovering, setRecovering] = useState(false)
  const [recoveryStep, setRecoveryStep] = useState('request')
  const [recoveryEmail, setRecoveryEmail] = useState('')
  const [recoveryOtp, setRecoveryOtp] = useState('')
  const [recoveryPassword, setRecoveryPassword] = useState('')
  const [recoveryConfirmPassword, setRecoveryConfirmPassword] = useState('')
  const [registering, setRegistering] = useState(false)
  const [verificationPending, setVerificationPending] = useState(false)
  const [verificationEmail, setVerificationEmail] = useState('')
  const [verificationNotice, setVerificationNotice] = useState('')
  const [registrationStatus, setRegistrationStatus] = useState('')
  const [registrationDeadline, setRegistrationDeadline] = useState('')
  const [registrationExpired, setRegistrationExpired] = useState(false)
  const [statusChecking, setStatusChecking] = useState(false)
  const [resendAvailableAt, setResendAvailableAt] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [registration, setRegistration] = useState({ fullName: '', email: '', schoolId: '', password: '', confirmPassword: '' })
  const [registrationMessage, setRegistrationMessage] = useState('')
  const [submitError, setSubmitError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const identifierType = detectAuthIdentifierType(identifier)
  const resendSeconds = Math.max(0, Math.ceil((resendAvailableAt - now) / 1000))
  const deadlineCheckKey = useRef('')

  const showExpiredRegistration = useCallback((email, schoolId) => {
    clearPendingRegistration()
    setVerificationPending(false)
    setRegistering(true)
    setRegistrationExpired(true)
    setRegistrationStatus('expired')
    setRegistrationDeadline('')
    setVerificationNotice('')
    setSubmitError('')
    setRegistrationMessage('')
    setRegistration((current) => ({ ...current, email, schoolId, password: '', confirmPassword: '' }))
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    // Clear the legacy resume marker. Verification is shown after registration
    // or an explicit retry, not automatically restored after a page refresh.
    clearPendingRegistration()
  }, [])

  useEffect(() => {
    const checkKey = `${verificationEmail}|${registration.schoolId}|${registrationDeadline}`
    if (!verificationPending || !registrationDeadline || Date.parse(registrationDeadline) > now || statusChecking || deadlineCheckKey.current === checkKey) return
    deadlineCheckKey.current = checkKey
    setStatusChecking(true)
    void getRegistrationStatus(verificationEmail, registration.schoolId).then((result) => {
      if (result.error) {
        setRegistrationStatus('unavailable')
        setSubmitError('Registration deadline reached, but the current status could not be checked. Try again.')
        return
      }
      const status = result.data?.status
      setRegistrationStatus(status || 'unavailable')
      if (status === 'expired') {
        showExpiredRegistration(verificationEmail, registration.schoolId)
      } else if (status === 'expired_protected') {
        setSubmitError('This expired account is linked to library records and was preserved. Contact library staff for help.')
      } else if (status === 'assistance_pending') {
        setRegistrationDeadline(result.data?.expires_at || registrationDeadline)
      } else if (status === 'verified') {
        clearPendingRegistration()
        setVerificationPending(false)
        setRegistering(false)
        setIdentifier(verificationEmail)
        setRegistrationMessage('Email verified. Sign in to continue to your library account.')
      }
    }).catch(() => {
      setRegistrationStatus('unavailable')
      setSubmitError('Registration deadline reached, but the current status could not be checked. Try again.')
    }).finally(() => setStatusChecking(false))
  }, [getRegistrationStatus, now, registration.schoolId, registrationDeadline, showExpiredRegistration, statusChecking, verificationEmail, verificationPending])

  const switchMode = (nextMode) => {
    setRegistering(nextMode)
    setRecovering(false)
    setVerificationPending(false)
    setRecoveryStep('request')
    setPassword('')
    setSubmitError('')
    setVerificationNotice('')
    setRegistrationMessage('')
    setRegistrationExpired(false)
    clearError()
  }

  const beginEmailVerification = (email, schoolId = '', options = {}) => {
    const normalizedEmail = email.trim().toLowerCase()
    const normalizedSchoolId = schoolId || registration.schoolId
    setVerificationEmail(normalizedEmail)
    setRegistration((current) => ({ ...current, email: normalizedEmail, schoolId: normalizedSchoolId }))
    setVerificationPending(true)
    setRegistering(false)
    setRegistrationExpired(false)
    setVerificationNotice('')
    setRegistrationStatus(options.status || 'pending_email_verification')
    setRegistrationDeadline(options.expiresAt || '')
    setResendAvailableAt(options.cooldown === true ? Date.now() + 60_000 : 0)
  }

  const submit = async (event) => {
    event.preventDefault()
    setSubmitting(true)
    setSubmitError('')
    clearError()

    try {
      if (registering) {
        if (!isValidNewPassword(registration.password)) {
          setSubmitError('Password must be 8–12 characters.')
          return
        }
        if (registration.password !== registration.confirmPassword) {
          setSubmitError('The passwords do not match.')
          return
        }
        // Never persist passwords, verification codes, or session tokens.
        const result = await createMemberAccount(registration)
        if (result.error) {
          if (result.error.message === 'Registration expired. Please create your account again.') {
            showExpiredRegistration(registration.email.trim().toLowerCase(), registration.schoolId.trim().toUpperCase().replace(/\s+/g, ''))
          } else {
            setSubmitError(friendlyAuthError(result.error))
          }
        }
        else {
          const existingPending = result.data?.existingPending === true
          setRegistrationMessage(existingPending
            ? 'A registration is already pending. Open the verification link in your email, or request a new link below.'
            : `We sent a verification link to ${registration.email.trim()}. Open it to confirm your email; no code is needed.`)
          beginEmailVerification(registration.email, registration.schoolId, {
            expiresAt: result.data?.registrationDeadline || result.data?.expiresAt || '',
            status: result.data?.status || result.data?.registrationStatus?.status || 'pending_email_verification',
            cooldown: !existingPending,
          })
          setRegistration((current) => ({ ...current, password: '', confirmPassword: '' }))
        }
      } else if (recovering) {
        if (recoveryStep === 'request') {
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recoveryEmail.trim())) {
            setSubmitError('Enter the email address registered to your account.')
            return
          }
          const result = await requestPasswordResetOtp(recoveryEmail)
          if (result.error) setSubmitError(friendlyAuthError(result.error.message))
          else {
            setRecoveryStep('verify')
            setResendAvailableAt(Date.now() + 60_000)
            setRegistrationMessage('If an account uses that email, a six-digit password recovery code has been sent. It expires in one hour.')
          }
        } else {
          if (!isValidNewPassword(recoveryPassword)) {
            setSubmitError('Password must be 8–12 characters.')
            return
          }
          if (recoveryPassword !== recoveryConfirmPassword) {
            setSubmitError('The new passwords do not match.')
            return
          }
          const result = await completePasswordReset(recoveryEmail, recoveryOtp, recoveryPassword)
          if (result.error) setSubmitError(friendlyAuthError(result.error.message))
          else {
            setRecovering(false)
            setRecoveryStep('request')
            setIdentifier(recoveryEmail)
            setRecoveryOtp('')
            setRecoveryPassword('')
            setRecoveryConfirmPassword('')
            setRegistrationMessage('Your password has been reset. Sign in with your email or verified School ID and the new password.')
          }
        }
      } else {
        const result = await signIn(identifier, password)
        if (result.error) setSubmitError(result.error.message)
      }
    } catch (requestError) {
      setSubmitError(requestError.message || 'The request could not be completed.')
    } finally {
      setSubmitting(false)
    }
  }

  const resendAuthEmail = async () => {
    if (resendSeconds > 0 || submitting) return
    setSubmitting(true)
    setSubmitError('')
    try {
      const result = recovering
        ? await requestPasswordResetOtp(recoveryEmail)
        : await resendRegistrationEmail(verificationEmail, registration.schoolId)
      if (result.error) {
        if (result.data?.status === 'expired' || result.error.message.includes('Registration expired')) {
          showExpiredRegistration(verificationEmail, registration.schoolId)
        } else setSubmitError(friendlyAuthError(result.error.message))
      } else if (result.data?.status === 'not_found' || result.data?.status === 'verified') {
        setSubmitError('No pending registration was found for this email. Sign in if your email is already verified.')
      } else {
        setResendAvailableAt(Date.now() + 60_000)
        if (recovering) {
          setRegistrationMessage('A new password recovery code has been sent if the account uses that email.')
        } else {
          setVerificationNotice('A new verification link has been sent. Use the latest email from IBA College Library.')
        }
      }
    } catch (requestError) {
      setSubmitError(friendlyAuthError(requestError.message))
    } finally {
      setSubmitting(false)
    }
  }

  const checkVerificationLink = async () => {
    setStatusChecking(true)
    setSubmitError('')
    setVerificationNotice('')
    try {
      const result = await getRegistrationStatus(verificationEmail, registration.schoolId)
      if (result.error) {
        setSubmitError('Registration status could not be checked. Try again.')
        return
      }

      const status = result.data?.status
      setRegistrationStatus(status || 'unavailable')
      if (status === 'verified') {
        clearPendingRegistration()
        setVerificationPending(false)
        setRegistering(false)
        setIdentifier(verificationEmail)
        setRegistrationDeadline('')
        setRegistrationMessage('Your email is verified. Sign in to continue.')
      } else if (status === 'expired') {
        showExpiredRegistration(verificationEmail, registration.schoolId)
      } else if (status === 'expired_protected') {
        setSubmitError('This expired account is linked to library records and was preserved. Contact library staff for help.')
      } else {
        setVerificationNotice('Email is not verified yet. Open the latest verification link from your inbox, then check again.')
      }
    } catch (requestError) {
      setSubmitError(friendlyAuthError(requestError.message))
    } finally {
      setStatusChecking(false)
    }
  }

  const primaryButtonSx = { minHeight: '3.1rem', marginTop: '.1rem', borderRadius: '.55rem', backgroundColor: '#a40000', '&:hover': { backgroundColor: '#820000' }, '&:focus-visible': { outline: '3px solid rgba(164, 0, 0, .24)', outlineOffset: '2px' } }
  const secondaryButtonSx = { minHeight: '3rem', marginTop: '.5rem', borderRadius: '.55rem', borderColor: '#a40000', color: '#8d0000', '&:hover': { borderColor: '#820000', backgroundColor: '#fff7f7' } }

  return (
    <Paper component="section" className="auth-card" elevation={0} sx={{ backgroundColor: '#fff', border: '1px solid #e6d9d8', borderRadius: '1.1rem', boxShadow: '0 1rem 2.5rem rgba(0, 38, 61, .08)' }}>
      <button type="button" className="auth-home-link" onClick={onBackToHomepage}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m14 18-6-6 6-6"/><path d="M8 12h12"/></svg>
        <span>Back to Homepage</span>
      </button>
      <div className="card-heading">
        <span className="eyebrow">Library access</span>
        <h2>{verificationPending ? 'Check your email' : recovering ? 'Reset your password' : registering ? 'Create member account' : 'Sign In'}</h2>
        <p>{verificationPending
          ? 'Click the verification link in your email to confirm your address. You do not need to enter a code.'
          : recovering
            ? 'Verify a code sent to your registered email before choosing a new password.'
            : registering
              ? 'Register with your name and email. Confirm your email by clicking the link we send you.'
              : 'Access your IBA College Library account. Sign in with your email and password.'}</p>
      </div>
      {registrationMessage && <Alert severity="success" variant="outlined" role="status" sx={authFeedbackSx}>{registrationMessage}</Alert>}
      {registrationExpired && registering && !verificationPending && <Alert severity="error" variant="outlined" role="alert" sx={authFeedbackSx}>Registration expired. Please create your account again.</Alert>}
      {verificationPending ? <>
        <div className="auth-form" aria-busy={submitting || statusChecking}>
          <TextField id="verification-email" label="Verification email sent to" type="email" value={verificationEmail} autoComplete="email" slotProps={{ htmlInput: { readOnly: true } }} fullWidth sx={authFieldSx} />
          <Alert severity="info" variant="outlined" role="status" sx={authFeedbackSx}>Open the latest email from IBA College Library and click its verification link. No code is required.</Alert>
          {verificationNotice && <Alert severity="info" variant="outlined" role="status" sx={authFeedbackSx}>{verificationNotice}</Alert>}
          {registrationDeadline && Date.parse(registrationDeadline) > now && <Alert severity="info" variant="outlined" role="status" sx={authFeedbackSx}>Pending Email Verification · Complete registration in {Math.floor((Date.parse(registrationDeadline) - now) / 60000)}:{String(Math.floor(((Date.parse(registrationDeadline) - now) % 60000) / 1000)).padStart(2, '0')}.</Alert>}
          {registrationDeadline && Date.parse(registrationDeadline) <= now && registrationStatus !== 'assistance_pending' && <Alert severity="warning" variant="outlined" role="status" sx={authFeedbackSx}>{statusChecking ? 'Checking registration status...' : 'Registration deadline reached. Checking the latest status...'}</Alert>}
          {(submitError || authError) && <Alert severity="error" variant="outlined" role="alert" sx={authFeedbackSx}>{friendlyAuthError(submitError || authError)}</Alert>}
          {registrationStatus === 'unavailable' && <Button type="button" fullWidth variant="outlined" disabled={statusChecking} onClick={() => { setRegistrationDeadline(new Date(0).toISOString()); setStatusChecking(false) }} sx={secondaryButtonSx}>Check registration status</Button>}
          <Button type="button" fullWidth variant="contained" disabled={submitting || statusChecking} onClick={checkVerificationLink} sx={primaryButtonSx}>{statusChecking ? 'Checking...' : 'I verified my email'}</Button>
          <Button type="button" fullWidth variant="outlined" disabled={submitting || resendSeconds > 0} onClick={resendAuthEmail} sx={secondaryButtonSx}>{resendSeconds > 0 ? `Resend email in ${resendSeconds}s` : 'Resend verification email'}</Button>
        </div>
      </> : registering ? <form onSubmit={submit} aria-busy={submitting}>
        <TextField id="register-full-name" label="Full name" value={registration.fullName} onChange={(event) => setRegistration({ ...registration, fullName: event.target.value })} autoComplete="name" slotProps={{ htmlInput: { maxLength: 160 } }} required fullWidth sx={authFieldSx} />
        <TextField id="register-email" label="Email address" type="email" value={registration.email} onChange={(event) => setRegistration({ ...registration, email: event.target.value })} autoComplete="email" required fullWidth sx={authFieldSx} />
        <TextField id="register-school-id" label="School ID" value={registration.schoolId} onChange={(event) => setRegistration({ ...registration, schoolId: event.target.value })} autoComplete="off" slotProps={{ htmlInput: { maxLength: 32 } }} helperText="For registration information only. It is not checked against student or library records." required fullWidth sx={authFieldSx} />
        <PasswordField id="register-password" name="new-password" label="Create password" value={registration.password} onChange={(event) => setRegistration({ ...registration, password: event.target.value })} autoComplete="new-password" inputProps={{ minLength: 8, maxLength: 12 }} helperText="Use 8–12 characters." required fullWidth sx={authFieldSx} />
        <PasswordField id="register-confirm-password" name="confirm-password" label="Confirm password" value={registration.confirmPassword} onChange={(event) => setRegistration({ ...registration, confirmPassword: event.target.value })} autoComplete="new-password" inputProps={{ minLength: 8, maxLength: 12 }} required fullWidth sx={authFieldSx} />
        {(submitError || authError) && <Alert severity="error" variant="outlined" role="alert" sx={authFeedbackSx}>{friendlyAuthError(submitError || authError)}</Alert>}
        <Button type="submit" fullWidth variant="contained" disabled={submitting} sx={primaryButtonSx}>{submitting ? 'Creating account...' : 'Create account'}</Button>
        <Button type="button" fullWidth variant="outlined" onClick={() => switchMode(false)} sx={secondaryButtonSx}>Back to sign in</Button>
      </form> : recovering ? <form className="auth-form" onSubmit={submit} aria-busy={submitting}>
        {recoveryStep === 'request' ? <>
          <TextField id="recovery-email" label="Registered email address" type="email" value={recoveryEmail} onChange={(event) => setRecoveryEmail(event.target.value)} autoComplete="email" required fullWidth sx={authFieldSx} />
          <p className="auth-recovery-note">Password recovery codes are sent to the account’s registered email. If you sign in with School ID, enter the linked email address here.</p>
          {(submitError || authError) && <Alert severity="error" variant="outlined" role="alert" sx={authFeedbackSx}>{friendlyAuthError(submitError || authError)}</Alert>}
          <Button type="submit" fullWidth variant="contained" disabled={submitting} sx={primaryButtonSx}>{submitting ? 'Sending code...' : 'Send recovery code'}</Button>
        </> : <>
          <TextField id="recovery-email-locked" label="Registered email address" type="email" value={recoveryEmail} onChange={(event) => setRecoveryEmail(event.target.value)} autoComplete="email" required fullWidth sx={authFieldSx} />
          <TextField id="recovery-otp" label="Six-digit recovery code" value={recoveryOtp} onChange={(event) => setRecoveryOtp(event.target.value.replace(/\D/g, '').slice(0, 6))} autoComplete="one-time-code" slotProps={{ htmlInput: { inputMode: 'numeric', pattern: '[0-9]{6}', maxLength: 6 } }} required fullWidth sx={authFieldSx} />
          <PasswordField id="recovery-new-password" name="new-password" label="New password" value={recoveryPassword} onChange={(event) => setRecoveryPassword(event.target.value)} autoComplete="new-password" inputProps={{ minLength: 8, maxLength: 12 }} helperText="Use 8–12 characters." required fullWidth sx={authFieldSx} />
          <PasswordField id="recovery-confirm-password" name="confirm-new-password" label="Confirm new password" value={recoveryConfirmPassword} onChange={(event) => setRecoveryConfirmPassword(event.target.value)} autoComplete="new-password" inputProps={{ minLength: 8, maxLength: 12 }} required fullWidth sx={authFieldSx} />
          {(submitError || authError) && <Alert severity="error" variant="outlined" role="alert" sx={authFeedbackSx}>{friendlyAuthError(submitError || authError)}</Alert>}
          <Button type="submit" fullWidth variant="contained" disabled={submitting || recoveryOtp.length !== 6} sx={primaryButtonSx}>{submitting ? 'Resetting password...' : 'Verify code and reset password'}</Button>
          <Button type="button" fullWidth variant="outlined" disabled={submitting || resendSeconds > 0} onClick={resendAuthEmail} sx={secondaryButtonSx}>{resendSeconds > 0 ? `Resend code in ${resendSeconds}s` : 'Resend code'}</Button>
        </>}
      </form> : <form className="auth-form" onSubmit={submit} aria-busy={submitting}>
        <TextField
          id="auth-identifier"
          name="username"
          type="text"
          label="Email or School ID"
          placeholder="Enter your email or School ID"
          autoComplete="username"
          slotProps={{ htmlInput: { maxLength: 320 } }}
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
          required
          fullWidth
          sx={authFieldSx}
        />
        <PasswordField
          key="login-password"
          id="auth-password"
          name="password"
          label="Password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          inputProps={{ minLength: 6, maxLength: 128 }}
          required
          fullWidth
          sx={authFieldSx}
        />
        {(submitError || authError) && <Alert severity="error" variant="outlined" role="alert" sx={authFeedbackSx}>{friendlyAuthError(submitError || authError)}</Alert>}
        <Button type="submit" fullWidth variant="contained" disabled={submitting} sx={primaryButtonSx}>{submitting ? 'Signing in...' : 'Sign In'}</Button>
        <button type="button" className="auth-text-link" onClick={() => { setRecovering(true); setRecoveryStep('request'); setRecoveryEmail(identifierType === 'email' ? identifier.trim() : ''); setPassword(''); setSubmitError(''); clearError() }}>Forgot Password?</button>
        <button type="button" className="auth-text-link" disabled={identifierType !== 'email'} onClick={() => { beginEmailVerification(identifier.trim()); setRegistering(false); setSubmitError('') }}>Need to verify your email?</button>
        <Button type="button" fullWidth variant="outlined" onClick={() => switchMode(true)} sx={secondaryButtonSx}>Create Member Account</Button>
      </form>}
      <Button type="button" fullWidth variant="outlined" onClick={onBrowseCatalog} sx={{ minHeight: '3rem', marginTop: '1rem', borderRadius: '.55rem', borderColor: '#a40000', color: '#8d0000', '&:hover': { borderColor: '#820000', backgroundColor: '#fff7f7' } }}>
        Browse Catalog Without an Account
      </Button>
    </Paper>
  )
}

function LibraryInfoPanel() {
  return (
    <aside className="library-info" aria-labelledby="library-info-title">
      <div className="info-visual" aria-hidden="true">
        <span className="info-visual-book book-one" />
        <span className="info-visual-book book-two" />
        <span className="info-visual-book book-three" />
        <span className="info-visual-shelf" />
      </div>
      <span className="eyebrow">College library</span>
      <h1 id="library-info-title">Your library,<br />organized.</h1>
      <p>Browse without an account. Use an email-verified account to place online holds; staff record checkouts and returns at the desk.</p>
      <ul className="library-info-list">
        <li>Search the library collection</li>
        <li>See availability and shelf locations</li>
        <li>Use your library card at the circulation desk</li>
      </ul>
    </aside>
  )
}

function AuthPage({ children, browsingCatalog = false, onBackToSignIn }) {
  if (browsingCatalog) {
    return <div className="public-catalog-landing">
      <header className="public-catalog-header">
        <div className="brand-mark"><span>IBA</span><strong>College Library</strong></div>
        <Button type="button" variant="outlined" onClick={onBackToSignIn} sx={{ borderColor: '#a40000', color: '#8d0000', '&:hover': { borderColor: '#820000', backgroundColor: '#fff7f7' } }}>Sign In</Button>
      </header>
      <main className="public-catalog-content">{children}</main>
    </div>
  }

  return (
    <div className="landing">
      <main className="auth-layout">
        <div className="auth-column">
          <header className="brand-mark"><span>IBA</span><strong>College Library</strong></header>
          {children}
        </div>
        <LibraryInfoPanel />
      </main>
    </div>
  )
}

const dashboardSections = [
  { id: 'dashboard', label: 'Dashboard', roles: ['member', 'librarian', 'administrator'] },
  { id: 'catalog', label: 'Catalog', roles: ['member', 'librarian', 'administrator'] },
  { id: 'my-books', label: 'My Books', roles: ['member'] },
  { id: 'reservations', label: 'Reservations', roles: ['member', 'librarian', 'administrator'] },
  { id: 'history', label: 'History', roles: ['member'] },
  { id: 'notifications', label: 'Notifications', roles: ['member'] },
  { id: 'profile', label: 'Profile', roles: ['member', 'librarian', 'administrator'] },
  { id: 'books', label: 'Books', roles: ['librarian', 'administrator'] },
  { id: 'copies', label: 'Copies', roles: ['librarian', 'administrator'] },
  { id: 'members', label: 'Members', roles: ['librarian', 'administrator'] },
  { id: 'requests', label: 'Book Requests', roles: ['librarian', 'administrator'] },
  { id: 'audit', label: 'Stock Audit', roles: ['librarian', 'administrator'] },
  { id: 'circulation', label: 'Borrow / Return', roles: ['librarian', 'administrator'] },
  { id: 'overdue', label: 'Overdue', roles: ['librarian', 'administrator'] },
  { id: 'reports', label: 'Reports', roles: ['librarian', 'administrator'] },
  { id: 'transactions', label: 'Transactions', roles: ['librarian', 'administrator'] },
  { id: 'system-settings', label: 'System Settings', roles: ['administrator'] },
]

const staffNavigationGroups = [
  {
    label: 'Overview',
    items: [{ id: 'dashboard', label: 'Dashboard', roles: ['librarian', 'administrator'] }],
  },
  {
    label: 'Library',
    items: [
      { id: 'catalog', label: 'Catalog', roles: ['librarian', 'administrator'] },
      { id: 'books', label: 'Books', roles: ['librarian', 'administrator'] },
      { id: 'reservations', label: 'Reservations', roles: ['librarian', 'administrator'] },
    ],
  },
  {
    label: 'Circulation',
    items: [
      { id: 'circulation', label: 'Borrow / Return', roles: ['librarian', 'administrator'] },
      { id: 'transactions', label: 'Transactions', roles: ['librarian', 'administrator'] },
      { id: 'overdue', label: 'Overdue', roles: ['librarian', 'administrator'] },
    ],
  },
  {
    label: 'Management',
    items: [
      { id: 'members', label: 'Members', roles: ['librarian', 'administrator'] },
      { id: 'requests', label: 'Book Requests', roles: ['librarian', 'administrator'] },
      { id: 'audit', label: 'Stock Audit', roles: ['librarian', 'administrator'] },
      { id: 'activity-logs', label: 'Activity Logs', roles: ['administrator'] },
      { id: 'reports', label: 'Reports', roles: ['librarian', 'administrator'] },
      { id: 'system-settings', label: 'System Settings', roles: ['administrator'] },
    ],
  },
]

const memberNavigationGroups = [
  { label: 'Overview', items: [{ id: 'dashboard', label: 'Dashboard', roles: ['member'] }] },
  { label: 'Library', items: [
    { id: 'catalog', label: 'Catalog', roles: ['member'] },
    { id: 'my-books', label: 'My Books', roles: ['member'] },
    { id: 'reservations', label: 'Reservations', roles: ['member'] },
  ] },
  { label: 'Activity', items: [
    { id: 'history', label: 'History', roles: ['member'] },
    { id: 'notifications', label: 'Notifications', roles: ['member'] },
  ] },
  { label: 'Account', items: [{ id: 'profile', label: 'My Profile', roles: ['member'] }] },
]

function getGreeting() {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

function formatDashboardDate(value) {
  if (!value) return 'Not set'
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatDashboardDateTime(value) {
  if (!value) return 'Not recorded'
  return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function formatStatus(value) {
  return value ? value.replaceAll('_', ' ') : 'Unknown'
}

function StaffSidebar({ role, activeSection, open, onNavigate, onClose, groups = staffNavigationGroups, accessLevel = roleLabels[role], ariaLabel = 'Staff navigation', member = false }) {
  useEffect(() => {
    if (!open) return undefined
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose()
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose, open])

  return <>
    {open && <button type="button" className="staff-sidebar-backdrop" onClick={onClose} aria-label="Close navigation" />}
    <aside id="staff-sidebar" className={`${open ? 'staff-sidebar open' : 'staff-sidebar'}${member ? ' member-sidebar' : ''}`} aria-label={ariaLabel} aria-expanded={open}>
      <div className="staff-sidebar-brand">
        <div className="brand-mark"><span>IBA</span> College Library</div>
        <button type="button" className="staff-sidebar-close" onClick={onClose} aria-label="Close navigation">Close</button>
      </div>
      <nav className="staff-sidebar-nav">
        {groups.map((group) => {
          const items = group.items.filter((item) => item.roles.includes(role))
          if (items.length === 0) return null
          return <div className="staff-nav-group" key={group.label}>
            <span className="staff-nav-label">{group.label}</span>
            {items.map((item) => <button type="button" key={item.id} aria-current={activeSection === item.id ? 'page' : undefined} className={activeSection === item.id ? 'staff-nav-item active' : 'staff-nav-item'} onClick={() => onNavigate(item.id)}><NavigationIcon id={item.id} /><span>{item.label}</span></button>)}
          </div>
        })}
      </nav>
      <div className="staff-sidebar-footer"><span className="eyebrow">Access level</span><strong>{accessLevel}</strong></div>
    </aside>
  </>
}

function getInitials(name) {
  return (name || 'User')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('')
}

function StaffAccountMenu({ name, role, email, onProfile, onNotifications, onSignOut, profileLabel = 'Profile' }) {
  return <details className="account-menu">
    <summary className="account-summary"><span className="account-avatar" aria-hidden="true">{getInitials(name)}</span><span className="account-summary-copy"><strong>{name}</strong><small>{roleLabels[role] ?? role}</small></span><span className="account-chevron" aria-hidden="true">More</span></summary>
    <div className="account-menu-panel">
      <small className="account-email">{email}</small>
      <button type="button" className="account-menu-action" onClick={(event) => { onProfile?.(); event.currentTarget.closest('details')?.removeAttribute('open') }}>{profileLabel}</button>
      {onNotifications && <button type="button" className="account-menu-action" onClick={(event) => { onNotifications(); event.currentTarget.closest('details')?.removeAttribute('open') }}>Notifications</button>}
      <button type="button" className="account-menu-action sign-out-action" onClick={onSignOut}>Sign out</button>
    </div>
  </details>
}

function StaffTopHeader({ role, name, email, pageTitle, menuOpen, onToggleMenu, onProfile, onNotifications, onSignOut, member = false }) {
  return <header className={`staff-topbar${member ? ' member-topbar' : ''}`}>
    <div className="staff-header-title">
      <button type="button" className="staff-menu-toggle" onClick={onToggleMenu} aria-expanded={menuOpen} aria-controls="staff-sidebar"><span aria-hidden="true">Menu</span><span className="sr-only">Toggle navigation</span></button>
      <div><span className="eyebrow">{roleLabels[role]} workspace</span><h1>{pageTitle}</h1></div>
    </div>
    <div className="account-area"><StaffAccountMenu name={name} role={role} email={email} onProfile={onProfile} onNotifications={onNotifications} onSignOut={onSignOut} profileLabel={member ? 'My Profile' : 'Profile'} /></div>
  </header>
}

const dashboardIconPaths = {
  catalog: 'M5 4h9a5 5 0 0 1 5 5v11H10a5 5 0 0 0-5 0V4z M5 18h14 M8 8h7 M8 12h7',
  copies: 'M7 5h12v14H7z M4 8v12h12 M10 9h6 M10 13h6',
  available: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M8 12l2.5 2.5L16 9',
  loans: 'M5 4h9a5 5 0 0 1 5 5v11H10a5 5 0 0 0-5 0V4z M5 18h14',
  reservations: 'M6 5h12a2 2 0 0 1 2 2v12H4V7a2 2 0 0 1 2-2z M8 3v4 M16 3v4 M7 11h10 M7 15h6',
  overdue: 'M12 6v6l4 2 M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0z',
  add: 'M12 5v14 M5 12h14',
  circulation: 'M7 7h10l-3-3 M17 7l-3 3 M17 17H7l3 3 M7 17l3-3',
  members: 'M16 20v-1a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v1 M10 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M16 11a3 3 0 0 0 0-6',
  reports: 'M5 19V9 M12 19V5 M19 19v-7',
}

function DashboardIcon({ name }) {
  return <svg className="dashboard-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={dashboardIconPaths[name] || dashboardIconPaths.catalog} /></svg>
}

function MobileBottomNavigation({ visibleSections, activeSection, onNavigate, role, onSignOut }) {
  const [moreOpen, setMoreOpen] = useState(false)
  const navigationRef = useRef(null)
  const primaryOrder = role === 'member'
    ? ['dashboard', 'catalog', 'my-books', 'reservations']
    : ['dashboard', 'catalog', 'books', 'circulation', 'reservations', 'my-books', 'history']
  const primarySections = primaryOrder
    .map((id) => visibleSections.find((section) => section.id === id))
    .filter(Boolean)
    .slice(0, 5)
  const primaryIds = new Set(primarySections.map((section) => section.id))
  const moreSections = visibleSections.filter((section) => !primaryIds.has(section.id))
  const moreIsActive = moreSections.some((section) => section.id === activeSection)
  const mobileLabel = (section) => ({ dashboard: 'Home', circulation: 'Circulation' }[section.id] || section.label)

  useEffect(() => {
    if (!moreOpen) return undefined
    const closeOnOutside = (event) => {
      if (!navigationRef.current?.contains(event.target)) setMoreOpen(false)
    }
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setMoreOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [moreOpen])

  const navigate = (sectionId) => {
    setMoreOpen(false)
    onNavigate(sectionId)
  }

  return <nav ref={navigationRef} className="mobile-bottom-nav" aria-label="Mobile library navigation">
    {primarySections.map((section) => <button
      key={section.id}
      type="button"
      aria-current={activeSection === section.id ? 'page' : undefined}
      className={activeSection === section.id ? 'mobile-nav-item active' : 'mobile-nav-item'}
      onClick={() => navigate(section.id)}
    ><NavigationIcon id={section.id} /><span>{mobileLabel(section)}</span></button>)}
    {moreSections.length > 0 && <button
      type="button"
      aria-expanded={moreOpen}
      aria-controls="mobile-more-menu"
      className={moreIsActive || moreOpen ? 'mobile-nav-item active' : 'mobile-nav-item'}
      onClick={() => setMoreOpen((open) => !open)}
    ><NavigationIcon id="more" /><span>More</span></button>}
    {moreOpen && <div id="mobile-more-menu" className="mobile-more-menu">
      {moreSections.map((section) => <button
        key={section.id}
        type="button"
        aria-current={activeSection === section.id ? 'page' : undefined}
        className={activeSection === section.id ? 'mobile-more-item active' : 'mobile-more-item'}
        onClick={() => navigate(section.id)}
      ><NavigationIcon id={section.id} /><span>{section.label}</span></button>)}
      {role === 'member' && <button type="button" className="mobile-more-item mobile-more-signout" onClick={() => { setMoreOpen(false); onSignOut?.() }}><NavigationIcon id="signout" /><span>Sign Out</span></button>}
    </div>}
  </nav>
}

function StaffDashboardOverview({ userId, displayName, onOpenSection }) {
  const [stats, setStats] = useState({
    catalogTitles: null,
    totalCopies: null,
    availableCopies: null,
    activeLoans: null,
    openReservations: null,
    overdueLoans: null,
  })
  const [transactions, setTransactions] = useState([])
  const [attentionReservations, setAttentionReservations] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadAdminOverview = useCallback(async (isActive = () => true) => {
    if (!supabase || !userId) {
      if (isActive()) setLoading(false)
      return
    }

    setLoading(true)
    setError('')

    try {
      const { error: refreshError } = await supabase.rpc('refresh_circulation_statuses')
      if (refreshError) throw refreshError
      const [catalogTitles, totalCopies, availableCopies, activeLoans, openReservations, overdueLoans, recentTransactions, reservations] = await Promise.all([
        supabase.from('books').select('id', { count: 'exact', head: true }),
        supabase.from('book_copies').select('id', { count: 'exact', head: true }),
        supabase.from('book_copies').select('id', { count: 'exact', head: true }).eq('status', 'available'),
        supabase.from('loans').select('id', { count: 'exact', head: true }).in('status', ['borrowed', 'overdue']),
        supabase.from('reservations').select('id', { count: 'exact', head: true }).in('status', ['waiting', 'ready_for_pickup']),
        supabase.from('loans').select('id', { count: 'exact', head: true }).eq('status', 'overdue'),
        supabase
          .from('loans')
          .select('id, status, checked_out_at, returned_at, created_at, book_copies(books(title)), member:library_members!loans_member_id_fkey(full_name)')
          .order('created_at', { ascending: false })
          .limit(6),
        supabase
          .from('reservations')
          .select('id, status, created_at, borrower_full_name, books(title), member:library_members!reservations_member_id_fkey(full_name)')
          .in('status', ['waiting', 'ready_for_pickup'])
          .order('created_at', { ascending: true })
          .limit(6),
      ])

      if (!isActive()) return

      const results = [catalogTitles, totalCopies, availableCopies, activeLoans, openReservations, overdueLoans, recentTransactions, reservations]
      const errors = results.filter((result) => result.error)
      if (errors.length > 0) setError('Some dashboard data could not load. Please try again.')

      const countValue = (result) => result.error ? null : result.count ?? 0
      setStats({
        catalogTitles: countValue(catalogTitles),
        totalCopies: countValue(totalCopies),
        availableCopies: countValue(availableCopies),
        activeLoans: countValue(activeLoans),
        openReservations: countValue(openReservations),
        overdueLoans: countValue(overdueLoans),
      })
      setTransactions(recentTransactions.error ? [] : recentTransactions.data ?? [])
      setAttentionReservations(reservations.error ? [] : reservations.data ?? [])
    } catch (requestError) {
      if (import.meta.env.DEV) console.error('[dashboard] administrator overview failed', requestError)
      if (isActive()) setError('Some dashboard data could not load. Please try again.')
    } finally {
      if (isActive()) setLoading(false)
    }
  }, [userId])

  useEffect(() => {
    let active = true
    void loadAdminOverview(() => active)
    return () => { active = false }
  }, [loadAdminOverview])

  const statCards = [
    { key: 'catalog', label: 'Catalog titles', value: stats.catalogTitles, note: 'Book records' },
    { key: 'copies', label: 'Total copies', value: stats.totalCopies, note: 'Physical copies' },
    { key: 'available', label: 'Available copies', value: stats.availableCopies, note: 'Ready to borrow' },
    { key: 'loans', label: 'Books checked out', value: stats.activeLoans, note: 'Currently borrowed' },
    { key: 'reservations', label: 'Open reservations', value: stats.openReservations, note: 'Waiting or ready' },
    { key: 'overdue', label: 'Overdue books', value: stats.overdueLoans, note: 'Past the due date' },
  ]

  const renderStatValue = (value, label) => loading
    ? <span className="stat-skeleton" aria-label={`Loading ${label}`} />
    : value === null ? 'Not available' : value

  return (
    <div className="admin-dashboard">
      <div className="welcome-row admin-welcome">
        <div className="admin-welcome-copy">
          <h1>{getGreeting()}, {displayName}</h1>
          <p className="muted">Here's what's happening in the library today.</p>
        </div>
        <div className="admin-hero-actions">
          <button type="button" className="primary-button" onClick={() => onOpenSection('books')}><DashboardIcon name="add" />Add book</button>
          <button type="button" className="secondary-button" onClick={() => onOpenSection('circulation')}><DashboardIcon name="circulation" />Borrow / Return</button>
        </div>
      </div>

      <div className="stat-grid admin-stat-grid">
        {statCards.map((stat, index) => (
          <article className={`stat-card admin-stat-card metric-tone-${index + 1} ${index % 3 === 0 ? 'accent-red' : index % 3 === 1 ? 'accent-gold' : 'accent-navy'}`} key={stat.label}>
            <span className="admin-stat-icon"><DashboardIcon name={stat.key} /></span>
            <div className="admin-stat-copy"><span className="admin-stat-label">{stat.label}</span><strong>{renderStatValue(stat.value, stat.label)}</strong><small>{stat.note}</small></div>
          </article>
        ))}
      </div>

      <AnalyticsSection userId={userId} />

      {error && <div className="inline-error with-action" role="alert"><span>{error}</span><button type="button" className="retry-button" onClick={() => void loadAdminOverview()}>Try again</button></div>}

      <div className="admin-dashboard-grid">
        <section className="activity-panel admin-dashboard-panel">
          <div className="panel-heading">
            <div><span className="eyebrow">Circulation</span><h2>Recent transactions</h2></div>
            <button type="button" className="text-button" onClick={() => onOpenSection('transactions')}>View all</button>
          </div>
          {loading ? <div className="admin-list-loading">Loading recent transactions...</div> : transactions.length === 0 ? (
            <div className="empty-state compact"><strong>No transactions yet.</strong><span>Borrowing and return activity will appear here.</span></div>
          ) : (
            <div className="table-wrap admin-table-wrap">
              <table className="admin-dashboard-table transactions-table">
                <thead><tr><th>Date &amp; time</th><th>Type</th><th>Book</th><th>Member</th><th>Status</th></tr></thead>
                <tbody>{transactions.map((transaction) => {
                  const date = transaction.returned_at || transaction.checked_out_at || transaction.created_at
                  return <tr key={transaction.id}>
                    <td>{formatDashboardDateTime(date)}</td>
                    <td>{transaction.status === 'returned' ? 'Return' : ['lost', 'damaged'].includes(transaction.status) ? transaction.status : 'Borrow'}</td>
                    <td>{transaction.book_copies?.books?.title || 'Unknown book'}</td>
                    <td>{transaction.member?.full_name || 'Unnamed member'}</td>
                    <td><span className={transaction.status === 'overdue' ? 'table-status danger' : 'table-status'} data-status={transaction.status}>{formatStatus(transaction.status)}</span></td>
                  </tr>
                })}</tbody>
              </table>
            </div>
          )}
        </section>

        <section className="activity-panel admin-dashboard-panel">
          <div className="panel-heading">
            <div><span className="eyebrow">Reservations</span><h2>Requiring attention</h2></div>
            <button type="button" className="text-button" onClick={() => onOpenSection('reservations')}>View all</button>
          </div>
          {loading ? <div className="admin-list-loading">Loading reservations...</div> : attentionReservations.length === 0 ? (
            <div className="empty-state compact">No reservations currently require attention.</div>
          ) : (
            <div className="table-wrap admin-table-wrap reservation-table-wrap">
              <table className="admin-dashboard-table">
                <thead><tr><th>Book</th><th>Borrower · Requested</th><th>Status</th><th>Action</th></tr></thead>
                <tbody>{attentionReservations.map((reservation) => (
                  <tr key={reservation.id}>
                    <td>{reservation.books?.title || 'Unknown book'}</td>
                    <td>{reservation.borrower_full_name || reservation.member?.full_name || 'Unnamed borrower'}<small className="table-subtext">{formatDashboardDate(reservation.created_at)}</small></td>
                    <td><span className="table-status" data-status={reservation.status}>{formatStatus(reservation.status)}</span></td>
                    <td><button type="button" className="reservation-review-button" onClick={() => onOpenSection('reservations')}>Review</button></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <section className="activity-panel admin-quick-actions">
        <div className="panel-heading"><div><span className="eyebrow">Shortcuts</span><h2>Quick actions</h2></div></div>
        <div className="admin-action-grid">
          <button type="button" className="quick-action-card" onClick={() => onOpenSection('books')}><span className="quick-action-icon"><DashboardIcon name="catalog" /></span><span className="quick-action-copy"><strong>Add book</strong><span>Create a catalog title</span></span></button>
          <button type="button" className="quick-action-card" onClick={() => onOpenSection('books')}><span className="quick-action-icon"><DashboardIcon name="copies" /></span><span className="quick-action-copy"><strong>Manage copies</strong><span>Register copies from Books</span></span></button>
          <button type="button" className="quick-action-card" onClick={() => onOpenSection('members')}><span className="quick-action-icon"><DashboardIcon name="members" /></span><span className="quick-action-copy"><strong>Find member</strong><span>Open the member directory</span></span></button>
          <button type="button" className="quick-action-card" onClick={() => onOpenSection('circulation')}><span className="quick-action-icon"><DashboardIcon name="circulation" /></span><span className="quick-action-copy"><strong>Borrow / Return</strong><span>Open the circulation desk</span></span></button>
          <button type="button" className="quick-action-card" onClick={() => onOpenSection('reports')}><span className="quick-action-icon"><DashboardIcon name="reports" /></span><span className="quick-action-copy"><strong>View reports</strong><span>Review live summaries</span></span></button>
        </div>
      </section>
    </div>
  )
}

function DashboardOverview({ userId, displayName, onOpenFeatures, onOpenSection, onOpenBook }) {
  const [stats, setStats] = useState({
    first: null,
    second: null,
    third: null,
    fourth: null,
  })
  const [loans, setLoans] = useState([])
  const [reservations, setReservations] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [cancellingId, setCancellingId] = useState('')
  const [recentActivity, setRecentActivity] = useState([])
  const [recentBooks, setRecentBooks] = useState([])
  const [policy, setPolicy] = useState(defaultCirculationPolicy)
  const [policyAvailable, setPolicyAvailable] = useState(false)
  const [sectionErrors, setSectionErrors] = useState({ loans: false, reservations: false, activity: false, catalog: false })
  const [selectedRecord, setSelectedRecord] = useState(null)

  const loadOverview = useCallback(async () => {
    if (!supabase || !userId) {
      setLoading(false)
      setError('Your account is not available. Please sign in again.')
      return
    }
    setLoading(true)
    setError('')

    try {
      const [memberLoans, memberReservations, positionsResult, recentLoans, recentReturns, recentReservations, recentCatalog, policyResult] = await Promise.all([
        fetchAllRows(() => supabase.from('loans').select('id, status, due_at, checked_out_at, returned_at, renewal_count, fine_amount, book_copies(barcode, books(id, title, author, isbn, category, cover_url, cover_image_path))').in('status', ['borrowed', 'overdue']).order('created_at', { ascending: false })),
        fetchAllRows(() => supabase.from('reservations').select('id, status, created_at, updated_at, pickup_expires_at, staff_approved_at, pickup_confirmed_at, book_copies(barcode), books(id, title, author, isbn, cover_url, cover_image_path)').in('status', ['waiting', 'ready_for_pickup']).order('created_at', { ascending: false })),
        supabase.rpc('my_reservation_positions'),
        supabase.from('loans').select('id, status, created_at, due_at, returned_at, book_copies(books(title))').in('status', ['borrowed', 'overdue', 'lost', 'damaged']).order('created_at', { ascending: false }).limit(10),
        supabase.from('loans').select('id, status, created_at, returned_at, book_copies(books(title))').not('returned_at', 'is', null).order('returned_at', { ascending: false }).limit(10),
        supabase.from('reservations').select('id, status, created_at, updated_at, pickup_confirmed_at, books(title)').order('updated_at', { ascending: false }).limit(10),
        supabase.from('books').select('id, title, author, isbn, category, cover_url, cover_image_path, created_at, book_copies(status)').order('created_at', { ascending: false }).limit(5),
        supabase.rpc('get_circulation_policy'),
      ])

      const nextPolicyAvailable = !policyResult.error
      const nextPolicy = nextPolicyAvailable ? normalizeCirculationPolicy(policyResult.data) : defaultCirculationPolicy
      const loanRows = memberLoans.data ?? []
      const reservationRows = memberReservations.data ?? []
      const queuePositions = new Map((positionsResult.data ?? []).map((item) => [item.id, item.queue_position]))
      const nextSectionErrors = {
        loans: Boolean(memberLoans.error),
        reservations: Boolean(memberReservations.error),
        activity: Boolean(recentLoans.error || recentReturns.error || recentReservations.error),
        catalog: Boolean(recentCatalog.error),
      }
      setSectionErrors(nextSectionErrors)
      if (Object.values(nextSectionErrors).some(Boolean) || positionsResult.error || policyResult.error) setError('Some account activity could not load. Please try again.')
      setPolicy(nextPolicy)
      setPolicyAvailable(nextPolicyAvailable)
      setStats({
        first: memberLoans.error ? null : loanRows.length,
        second: memberReservations.error ? null : reservationRows.length,
        third: memberLoans.error || !nextPolicyAvailable ? null : loanRows.filter((loan) => getLoanDueState(loan.due_at, nextPolicy.due_soon_days) === 'due-soon').length,
        fourth: memberLoans.error ? null : loanRows.filter((loan) => getLoanDueState(loan.due_at, 0) === 'overdue').length,
      })
      setLoans(loanRows.slice(0, 3))
      setReservations(reservationRows.slice(0, 3).map((reservation) => ({ ...reservation, queue_position: queuePositions.get(reservation.id) })))
      const activityEntries = [
        ...(recentLoans.data ?? []).map((loan) => ({
          id: `loan-${loan.id}`,
          type: loan.status === 'lost' || loan.status === 'damaged' ? 'closed' : loan.status === 'overdue' ? 'overdue' : 'borrow',
          label: `${loan.status === 'lost' ? 'Marked lost' : loan.status === 'damaged' ? 'Marked damaged' : loan.status === 'overdue' ? 'Now overdue' : 'Borrowed'} ${loan.book_copies?.books?.title || 'a book'}`,
          status: loan.status,
          created_at: loan.status === 'overdue' ? loan.due_at || loan.created_at : loan.created_at,
        })),
        ...(recentReturns.data ?? []).map((loan) => ({ id: `return-${loan.id}`, type: 'return', label: `Returned ${loan.book_copies?.books?.title || 'a book'}`, status: 'returned', created_at: loan.returned_at })),
        ...(recentReservations.data ?? []).map((reservation) => {
          const title = reservation.books?.title || 'a book'
          const eventDate = reservation.status === 'waiting' ? reservation.created_at : reservation.updated_at || reservation.created_at
          const descriptions = {
            waiting: `Reserved ${title}`,
            ready_for_pickup: reservation.pickup_confirmed_at ? `${title} is ready for pickup` : `Staff is verifying ${title}`,
            completed: `Picked up ${title}`,
            cancelled: `Cancelled reservation for ${title}`,
            expired: `Reservation expired for ${title}`,
          }
          return { id: `reservation-${reservation.id}-${reservation.status}`, type: reservation.status === 'cancelled' ? 'cancel' : 'reservation', label: descriptions[reservation.status] || `Updated reservation for ${title}`, status: reservation.status, created_at: eventDate }
        }),
      ].filter((item) => Number.isFinite(Date.parse(item.created_at || '')))
      setRecentActivity(activityEntries.sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at)).slice(0, 5))
      setRecentBooks(recentCatalog.data ?? [])
    } catch (loadError) {
      if (import.meta.env.DEV) console.error('[dashboard] overview failed', loadError)
      setSectionErrors({ loans: true, reservations: true, activity: true, catalog: true })
      setStats({ first: null, second: null, third: null, fourth: null })
      setLoans([])
      setReservations([])
      setRecentActivity([])
      setRecentBooks([])
      setPolicyAvailable(false)
      setError('Some account activity could not load. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => {
    void loadOverview()
  }, [loadOverview])

  const cancelReservation = async (reservationId) => {
    if (!supabase) return
    setCancellingId(reservationId)
    setError('')
    try {
      const { error: cancelError } = await supabase.rpc('cancel_reservation', { p_reservation_id: reservationId })
      if (cancelError) setError('Unable to cancel this reservation. Please try again.')
      else await loadOverview()
    } catch (cancelError) {
      if (import.meta.env.DEV) console.error('[dashboard] reservation cancellation failed', cancelError)
      setError('Unable to cancel this reservation. Please try again.')
    } finally {
      setCancellingId('')
    }
  }

  const rawName = String(displayName || '').trim()
  const firstName = !rawName || rawName.includes('@') || /^school id:/i.test(rawName) ? 'there' : rawName.split(/\s+/)[0]
  const metric = (value) => loading ? 'Loading' : value === null ? 'Not available' : value
  const loanDueState = (loan) => getLoanDueState(loan.due_at, policy.due_soon_days)
  const getRemainingLabel = (loan) => {
    const dueTime = Date.parse(loan.due_at || '')
    if (!Number.isFinite(dueTime)) return 'Due date not recorded'
    const state = getLoanDueState(loan.due_at, policy.due_soon_days)
    const days = Math.max(1, Math.ceil(Math.abs(dueTime - Date.now()) / 86400000))
    return state === 'overdue' ? `${days} ${days === 1 ? 'day' : 'days'} overdue` : `${days} ${days === 1 ? 'day' : 'days'} left`
  }
  const displayedLoanStatus = (loan) => {
    const dueState = loanDueState(loan)
    return dueState === 'overdue' || loan.status === 'overdue' ? 'overdue' : policyAvailable && dueState === 'due-soon' ? 'due-soon' : loan.status
  }
  const activityIcon = { borrow: 'loans', return: 'circulation', overdue: 'overdue', reservation: 'reservations', cancel: 'copies', closed: 'circulation' }
  const closeDetailsOnEscape = useCallback((event) => {
    if (event.key === 'Escape') setSelectedRecord(null)
  }, [])
  useEffect(() => {
    if (!selectedRecord) return undefined
    window.addEventListener('keydown', closeDetailsOnEscape)
    return () => window.removeEventListener('keydown', closeDetailsOnEscape)
  }, [selectedRecord, closeDetailsOnEscape])

  return (
    <div className="overview-dashboard member-dashboard">
      <header className="member-welcome-card">
        <div className="member-welcome-copy"><span className="eyebrow">Member dashboard</span><h1>{getGreeting()}, {firstName}.</h1><p>Explore books, manage reservations, and track your borrowing activity.</p></div>
        <div className="member-welcome-actions"><span className="member-live-status"><i aria-hidden="true" /> Live library overview</span><button type="button" className="primary-button" onClick={onOpenFeatures}>Browse Catalog</button></div>
      </header>

      <div className="stat-grid member-stat-grid" aria-label="Your library statistics">
        <article className="stat-card accent-red member-stat-card"><span className="member-stat-icon"><DashboardIcon name="loans" /></span><div><span>Books Borrowed</span><strong>{metric(stats.first)}</strong><small>Currently checked out</small></div></article>
        <article className="stat-card accent-gold member-stat-card"><span className="member-stat-icon"><DashboardIcon name="reservations" /></span><div><span>Active Reservations</span><strong>{metric(stats.second)}</strong><small>Waiting or ready for pickup</small></div></article>
        <article className="stat-card accent-navy member-stat-card"><span className="member-stat-icon"><DashboardIcon name="available" /></span><div><span>Due Soon</span><strong>{metric(stats.third)}</strong><small>{policyAvailable ? `Due within ${policy.due_soon_days} days` : 'Circulation policy unavailable'}</small></div></article>
        <article className="stat-card member-stat-card"><span className="member-stat-icon overdue-stat-icon"><DashboardIcon name="overdue" /></span><div><span>Overdue Books</span><strong>{metric(stats.fourth)}</strong><small>Active loans past due date</small></div></article>
      </div>

      {error && <div className="inline-error with-action member-dashboard-error" role="alert"><span>{error}</span><button type="button" className="retry-button" onClick={() => void loadOverview()}>Try again</button></div>}

      <section className="activity-grid member-dashboard-panels" aria-label="Borrowings and reservations">
        <article className="activity-panel member-dashboard-panel">
          <div className="panel-heading"><div><span className="eyebrow">Borrowing</span><h2>My Borrowed Books</h2></div><button type="button" className="text-button" onClick={() => onOpenSection('my-books')}>View All</button></div>
          {loading ? <div className="empty-state compact loading-state member-dashboard-empty">Loading your books...</div>
            : sectionErrors.loans ? <div className="empty-state compact member-dashboard-empty">Your borrowing records could not be loaded.</div>
              : loans.length === 0 ? <div className="empty-state compact member-dashboard-empty"><strong>No books checked out</strong><span>Books you borrow will appear here.</span><button type="button" className="text-button" onClick={onOpenFeatures}>Browse the catalog</button></div>
                : <div className="member-dashboard-record-list">{loans.map((loan) => {
                  const book = loan.book_copies?.books
                  const status = displayedLoanStatus(loan)
                  return <article className="member-dashboard-record" key={loan.id}>
                    <BookCoverArt book={book} className="member-dashboard-cover" externalLookup />
                    <div className="member-dashboard-record-copy"><strong title={book?.title}>{book?.title || 'Unknown book'}</strong><small>{book?.author || 'Author not recorded'}</small><span>Borrowed {formatDashboardDate(loan.checked_out_at)}</span><span>Due {formatDashboardDate(loan.due_at)} · {getRemainingLabel(loan)}</span><StatusBadgeForDashboard status={status} /></div>
                    <button type="button" className="member-dashboard-details-button" onClick={() => setSelectedRecord({ kind: 'loan', record: loan, status })}>View Details</button>
                  </article>
                })}</div>}
        </article>
        <article className="activity-panel member-dashboard-panel">
          <div className="panel-heading"><div><span className="eyebrow">Reservations</span><h2>My Reservations</h2></div><button type="button" className="text-button" onClick={() => onOpenSection('reservations')}>View All</button></div>
          {loading ? <div className="empty-state compact loading-state member-dashboard-empty">Loading your reservations...</div>
            : sectionErrors.reservations ? <div className="empty-state compact member-dashboard-empty">Your reservations could not be loaded.</div>
              : reservations.length === 0 ? <div className="empty-state compact member-dashboard-empty"><strong>No active reservations</strong><span>Place a pickup hold or join a queue to track a book here.</span><button type="button" className="text-button" onClick={onOpenFeatures}>Find a book</button></div>
                : <div className="member-dashboard-record-list">{reservations.map((reservation) => {
                  const book = reservation.books
                  const canCancel = ['waiting', 'ready_for_pickup'].includes(reservation.status)
                  const reservationProgress = reservation.status === 'waiting'
                    ? reservation.staff_approved_at ? `Queue position ${reservation.queue_position ?? 'pending'}` : 'Awaiting staff approval'
                    : reservation.pickup_confirmed_at ? `Collect by ${formatDashboardDate(reservation.pickup_expires_at)}` : 'Staff is verifying the assigned copy'
                  return <article className="member-dashboard-record" key={reservation.id}>
                    <BookCoverArt book={book} className="member-dashboard-cover" externalLookup />
                    <div className="member-dashboard-record-copy"><strong title={book?.title}>{book?.title || 'Unknown book'}</strong><small>{book?.author || 'Author not recorded'}</small><span>Requested {formatDashboardDate(reservation.created_at)}</span><span>{reservationProgress}</span><StatusBadgeForDashboard status={reservation.status} reservation={reservation} /></div>
                    <div className="member-dashboard-record-actions"><button type="button" className="member-dashboard-details-button" onClick={() => setSelectedRecord({ kind: 'reservation', record: reservation, status: reservation.status })}>View Details</button>{canCancel && <button type="button" className="member-dashboard-cancel-button" onClick={() => void cancelReservation(reservation.id)} disabled={cancellingId === reservation.id}>{cancellingId === reservation.id ? 'Cancelling...' : 'Cancel'}</button>}</div>
                  </article>
                })}</div>}
        </article>
      </section>

      <section className="activity-lower-grid member-dashboard-lower">
        <article className="activity-panel member-dashboard-panel">
          <div className="panel-heading"><div><span className="eyebrow">Timeline</span><h2>Recent Activity</h2></div><button type="button" className="text-button" onClick={() => onOpenSection('history')}>View History</button></div>
          {loading ? <div className="empty-state compact loading-state member-dashboard-empty">Loading recent activity...</div>
            : sectionErrors.activity ? <div className="empty-state compact member-dashboard-empty">Recent activity could not be loaded.</div>
              : recentActivity.length === 0 ? <div className="empty-state compact member-dashboard-empty"><strong>No recent activity</strong><span>Your recent library activity will appear here.</span></div>
                : <div className="member-recent-activity-list">{recentActivity.map((item) => <article className="member-recent-activity" key={item.id}><span className={`member-activity-icon ${item.type}`} aria-hidden="true"><DashboardIcon name={activityIcon[item.type] || 'catalog'} /></span><div><strong>{item.label}</strong><small>{formatDashboardDateTime(item.created_at)}</small></div><StatusBadgeForDashboard status={item.status} /></article>)}</div>}
        </article>
        <article className="activity-panel member-dashboard-panel">
          <div className="panel-heading"><div><span className="eyebrow">Discover</span><h2>Recently Added Books</h2></div><button type="button" className="text-button" onClick={onOpenFeatures}>View Catalog</button></div>
          {loading ? <div className="empty-state compact loading-state member-dashboard-empty">Loading catalog highlights...</div>
            : sectionErrors.catalog ? <div className="empty-state compact member-dashboard-empty">Recently added books could not be loaded.</div>
              : recentBooks.length === 0 ? <div className="empty-state compact member-dashboard-empty"><strong>No new books yet</strong><span>New catalog titles will appear here.</span></div>
                : <div className="mini-book-list member-recent-books-list">{recentBooks.map((book) => {
                  const available = (book.book_copies || []).filter((copy) => copy.status === 'available').length
                  return <article className="mini-book-item member-recent-book" key={book.id}>
                    <BookCoverArt book={book} className="mini-book-cover" externalLookup />
                    <div><strong title={book.title}>{book.title}</strong><small>{book.author || 'Author not recorded'}</small><span className={available > 0 ? 'availability available' : 'availability unavailable'}>{available > 0 ? `${available} available` : 'Unavailable'}</span></div>
                    <button type="button" className="member-dashboard-details-button" onClick={() => onOpenBook(book.id)}>View Book</button>
                  </article>
                })}</div>}
        </article>
      </section>
      {selectedRecord && <MemberDashboardDetailsDialog selection={selectedRecord} onClose={() => setSelectedRecord(null)} />}
    </div>
  )
}

function StatusBadgeForDashboard({ status, reservation }) {
  const reservationLabel = reservation?.status === 'waiting'
    ? reservation.staff_approved_at ? 'Waiting for a copy' : 'Pending staff approval'
    : reservation?.status === 'ready_for_pickup'
      ? reservation.pickup_confirmed_at ? 'Ready for pickup' : 'Staff verifying copy'
      : null
  const label = reservationLabel || ({ 'due-soon': 'Due soon', ready_for_pickup: 'Ready for pickup' })[status] || String(status || 'Unknown').replaceAll('_', ' ')
  const danger = ['overdue', 'lost', 'damaged'].includes(status)
  const warning = ['due-soon', 'ready_for_pickup'].includes(status)
  return <span className={danger ? 'table-status danger' : warning ? 'table-status warning' : 'table-status'} data-status={status}>{label}</span>
}

function MemberDashboardDetailsDialog({ selection, onClose }) {
  const isLoan = selection.kind === 'loan'
  const record = selection.record
  const book = isLoan ? record.book_copies?.books : record.books
  const title = book?.title || 'Book details'
  const status = selection.status || record.status
  return <div className="member-details-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="member-details-dialog" role="dialog" aria-modal="true" aria-labelledby="member-details-title">
      <header><div><span className="eyebrow">{isLoan ? 'Borrowing record' : 'Reservation record'}</span><h2 id="member-details-title">{title}</h2></div><button type="button" className="member-details-close" aria-label="Close details" onClick={onClose}>&times;</button></header>
      <div className="member-details-book"><BookCoverArt book={book} className="member-dashboard-cover" externalLookup /><div><strong>{book?.title || 'Unknown book'}</strong><span>{book?.author || 'Author not recorded'}</span><StatusBadgeForDashboard status={status} reservation={!isLoan ? record : undefined} /></div></div>
      <dl className="member-details-grid">
        {isLoan ? <><div><dt>Borrowed</dt><dd>{formatDashboardDate(record.checked_out_at)}</dd></div><div><dt>Due date</dt><dd>{formatDashboardDate(record.due_at)}</dd></div><div><dt>Remaining time</dt><dd>{(() => { const dueTime = Date.parse(record.due_at || ''); if (!Number.isFinite(dueTime)) return 'Not recorded'; const days = Math.max(1, Math.ceil(Math.abs(dueTime - Date.now()) / 86400000)); return dueTime < Date.now() ? `${days} ${days === 1 ? 'day' : 'days'} overdue` : `${days} ${days === 1 ? 'day' : 'days'} left` })()}</dd></div><div><dt>Copy barcode</dt><dd>{record.book_copies?.barcode || 'Not recorded'}</dd></div><div><dt>Fine</dt><dd>{formatFine(record.fine_amount)}</dd></div></>
          : <><div><dt>Reserved</dt><dd>{formatDashboardDateTime(record.created_at)}</dd></div><div><dt>Queue position</dt><dd>{record.status === 'waiting' ? record.staff_approved_at ? record.queue_position ?? 'In queue' : 'Pending staff approval' : 'Not waiting'}</dd></div><div><dt>Assigned copy</dt><dd>{record.pickup_confirmed_at ? record.book_copies?.barcode || 'Copy assigned' : record.status === 'ready_for_pickup' ? 'Staff verifying copy' : 'Not assigned'}</dd></div><div><dt>Pickup deadline</dt><dd>{record.pickup_confirmed_at && record.pickup_expires_at ? formatDashboardDateTime(record.pickup_expires_at) : 'Not set'}</dd></div></>}
      </dl>
      <footer><button type="button" className="secondary-button" onClick={onClose}>Close</button></footer>
    </section>
  </div>
}


function Reports() {
  const [stats, setStats] = useState({ books: null, copies: null, availableCopies: null, activeLoans: null, openReservations: null, overdueLoans: null })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    let active = true
    const loadStats = async (showLoading = true) => {
      if (!active) return
      if (!supabase) {
        if (active) setLoading(false)
        return
      }
      if (showLoading) setLoading(true)
      setError('')
      try {
        const [books, copies, availableCopies, loans, openReservations, overdueLoans] = await Promise.all([
          supabase.from('books').select('id', { count: 'exact', head: true }),
          supabase.from('book_copies').select('id', { count: 'exact', head: true }),
          supabase.from('book_copies').select('id', { count: 'exact', head: true }).eq('status', 'available'),
          supabase.from('loans').select('id', { count: 'exact', head: true }).in('status', ['borrowed', 'overdue']),
          supabase.from('reservations').select('id', { count: 'exact', head: true }).in('status', ['waiting', 'ready_for_pickup']),
          supabase.from('loans').select('id', { count: 'exact', head: true }).eq('status', 'overdue'),
        ])
        if (!active) return
        const failed = [books, copies, availableCopies, loans, openReservations, overdueLoans].find((result) => result.error)
        if (failed?.error) setError('Unable to load report data. Please try again.')
        setStats({
          books: books.error ? null : books.count ?? 0,
          copies: copies.error ? null : copies.count ?? 0,
          availableCopies: availableCopies.error ? null : availableCopies.count ?? 0,
          activeLoans: loans.error ? null : loans.count ?? 0,
          openReservations: openReservations.error ? null : openReservations.count ?? 0,
          overdueLoans: overdueLoans.error ? null : overdueLoans.count ?? 0,
        })
      } catch (loadError) {
        if (import.meta.env.DEV) console.error('[dashboard] reports failed', loadError)
        if (active) setError('Unable to load report data. Please try again.')
      } finally {
        if (active && showLoading) setLoading(false)
      }
    }
    loadStats()
    const interval = window.setInterval(() => loadStats(false), 60_000)
    const refreshOnFocus = () => { if (document.visibilityState === 'visible') loadStats(false) }
    window.addEventListener('focus', refreshOnFocus)
    return () => { active = false; window.clearInterval(interval); window.removeEventListener('focus', refreshOnFocus) }
  }, [retryKey])

  const reportValue = (value, label) => loading ? 'Loading' : value === null ? 'Not available' : `${value} ${label}`

  return (
    <section className="content-section reports-page">
      <div className="section-heading page-header reports-page-heading">
        <div>
          <span className="eyebrow">Insights</span>
          <h2>Reports</h2>
          <p className="muted">Live summaries of the current collection, circulation, and reservation records.</p>
        </div>
      </div>
      <div className="report-grid staff-report-grid">
        <article className="section-panel"><span>Catalog Titles</span><strong>{reportValue(stats.books, 'titles')}</strong><small>Distinct book records.</small></article>
        <article className="section-panel"><span>Physical Copies</span><strong>{reportValue(stats.copies, 'copies')}</strong><small>All registered copy records.</small></article>
        <article className="section-panel"><span>Available Copies</span><strong>{reportValue(stats.availableCopies, 'available')}</strong><small>Copies ready to check out.</small></article>
        <article className="section-panel"><span>Books Checked Out</span><strong>{reportValue(stats.activeLoans, stats.activeLoans === 1 ? 'book' : 'books')}</strong><small>Currently borrowed or overdue.</small></article>
        <article className="section-panel"><span>Open Reservations</span><strong>{reportValue(stats.openReservations, 'holds')}</strong><small>Waiting or ready for pickup.</small></article>
        <article className="section-panel"><span>Overdue Books</span><strong>{reportValue(stats.overdueLoans, stats.overdueLoans === 1 ? 'book' : 'books')}</strong><small>Borrowed books past their due date.</small></article>
      </div>
      {error && <div className="inline-error with-action" role="alert"><span>{error}</span><button type="button" className="retry-button" onClick={() => setRetryKey((current) => current + 1)}>Try again</button></div>}
      <p className="report-footnote">These are live counts from the current library records; they do not include archived or deleted data.</p>
      <Suspense fallback={<div className="empty-state loading-state">Loading detailed reports…</div>}><ReportsExplorer summaryStats={stats} summaryLoading={loading} /></Suspense>
    </section>
  )
}


function Dashboard() {
  const { profile, session, signOut } = useAuth()
  const [activeSection, setActiveSection] = useState('dashboard')
  const [systemSettingsInitialTab, setSystemSettingsInitialTab] = useState('accounts')
  const [catalogTargetBookId, setCatalogTargetBookId] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const role = profile?.role ?? 'member'
  const isStaff = role === 'librarian' || role === 'administrator'
  const isMember = role === 'member'
  const isWorkspace = isStaff || isMember
  const isAdministrator = role === 'administrator'
  const accountIdentifier = profile?.school_id ? `School ID: ${profile.school_id}` : session?.user?.email
  const name = isStaff ? profile?.full_name || roleLabels[role] : profile?.full_name || accountIdentifier || 'Library user'
  const visibleSections = isStaff
    ? staffNavigationGroups.flatMap((group) => group.items).filter((section) => section.roles.includes(role))
    : dashboardSections.filter((section) => section.roles.includes(role))
  const memberSections = memberNavigationGroups.flatMap((group) => group.items).filter((section) => section.roles.includes(role))
  const navigationSections = isStaff ? visibleSections : isMember ? memberSections : visibleSections.filter((section) => section.id !== 'profile')
  const activeSectionIsAllowed = visibleSections.some((section) => section.id === activeSection)
  const staffProfileIsOpen = isStaff && activeSection === 'profile'
  const displayedSection = activeSectionIsAllowed || staffProfileIsOpen ? activeSection : 'dashboard'
  const pageTitle = displayedSection === 'dashboard'
    ? isMember ? 'Dashboard' : `${roleLabels[role]} Dashboard`
    : navigationSections.find((section) => section.id === displayedSection)?.label || visibleSections.find((section) => section.id === displayedSection)?.label || 'Profile'
  const openDashboardBook = useCallback((bookId) => {
    setCatalogTargetBookId(bookId)
    setActiveSection('catalog')
  }, [])
  const clearCatalogTargetBook = useCallback(() => setCatalogTargetBookId(''), [])

  useEffect(() => {
    // Support old saved/in-flight navigation state from the retired section id.
    if (activeSection === 'user-management') {
      setSystemSettingsInitialTab('accounts')
      setActiveSection('system-settings')
    }
  }, [activeSection])

  useEffect(() => {
    // The app swaps workspace pages in place, so preserve the expected page start
    // instead of leaving a newly selected section halfway down the old scroll.
    document.documentElement.scrollTop = 0
    document.body.scrollTop = 0
  }, [displayedSection])

  useEffect(() => {
    if (!menuOpen) return undefined
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [menuOpen])

  useEffect(() => {
    const closeDrawerAtBottomNavBreakpoint = () => {
      if (window.matchMedia('(max-width: 768px)').matches) setMenuOpen(false)
    }
    window.addEventListener('resize', closeDrawerAtBottomNavBreakpoint)
    return () => window.removeEventListener('resize', closeDrawerAtBottomNavBreakpoint)
  }, [])

  return (
    <div className={isWorkspace ? `dashboard-shell staff-shell${isMember ? ' member-shell' : ''}` : 'dashboard-shell'}>
      {isWorkspace && <StaffSidebar role={role} activeSection={displayedSection} open={menuOpen} groups={isMember ? memberNavigationGroups : staffNavigationGroups} accessLevel={isMember ? 'Member' : roleLabels[role]} ariaLabel={isMember ? 'Member navigation' : 'Staff navigation'} member={isMember} onNavigate={(section) => { setActiveSection(section); setMenuOpen(false) }} onClose={() => setMenuOpen(false)} />}
      <div className={isWorkspace ? 'staff-main' : ''}>
      {isWorkspace && <StaffTopHeader
        role={role}
        name={name}
        email={accountIdentifier}
        pageTitle={pageTitle}
        menuOpen={menuOpen}
        onToggleMenu={() => setMenuOpen((open) => !open)}
        onProfile={() => { setActiveSection('profile'); setMenuOpen(false) }}
        onNotifications={isMember ? () => { setActiveSection('notifications'); setMenuOpen(false) } : undefined}
        onSignOut={signOut}
        member={isMember}
      />}
      <header className={isWorkspace ? 'topbar staff-legacy-topbar' : 'topbar'}>
        <div className="brand-mark"><span>IBA</span> College Library</div>
        <div className="account-area">
          {isAdministrator ? <details className="account-menu">
            <summary className="account-summary"><span><strong>{name}</strong><small>Administrator</small></span><span className="account-chevron" aria-hidden="true">More</span></summary>
            <div className="account-menu-panel">
              <small className="account-email">{accountIdentifier}</small>
              <button type="button" className="account-menu-action" onClick={() => setActiveSection('profile')}>Profile</button>
              <button type="button" className="account-menu-action sign-out-action" onClick={signOut}>Sign out</button>
            </div>
          </details> : <>
            {role === 'member' ? <details className="account-menu member-account-menu">
              <summary className="account-summary"><span><strong>{name}</strong><small>Member account</small></span><span className="account-chevron" aria-hidden="true">Account actions</span></summary>
              <div className="account-menu-panel">
                <small className="account-email">{accountIdentifier}</small>
                <button type="button" className="account-menu-action" onClick={(event) => { setActiveSection('profile'); event.currentTarget.closest('details')?.removeAttribute('open') }}>Profile</button>
                <button type="button" className="account-menu-action sign-out-action" onClick={signOut}>Sign out</button>
              </div>
            </details> : <>
              <div><strong>{name}</strong><small>{roleLabels[role] ?? role}</small></div>
              <button type="button" className="header-link" onClick={() => setActiveSection('profile')}>Profile</button>
              <button type="button" className="secondary-button" onClick={signOut}>Sign out</button>
            </>}
          </>}
        </div>
      </header>
      <button type="button" className="mobile-menu-button" onClick={() => setMenuOpen((open) => !open)} aria-expanded={menuOpen} aria-controls="library-navigation">{menuOpen ? 'Close menu' : 'Menu'}</button>
      <nav id="library-navigation" className={menuOpen ? 'dashboard-nav open' : 'dashboard-nav'} aria-label="Library sections">
        <div className="dashboard-nav-inner">
          {navigationSections.map((section) => (
            <button
              key={section.id}
              type="button"
              aria-current={displayedSection === section.id ? 'page' : undefined}
              className={displayedSection === section.id ? 'nav-button active' : 'nav-button'}
              onClick={() => { setActiveSection(section.id); setMenuOpen(false) }}
            >
              <NavigationIcon id={section.id} />
              <span>{section.label}</span>
            </button>
          ))}
        </div>
      </nav>
      <main className={isWorkspace ? `dashboard-content staff-content${isMember ? ' member-dashboard-content' : ''}` : 'dashboard-content'}>
        <Suspense fallback={<div className="empty-state loading-state">Loading workspace...</div>}>
        {displayedSection === 'dashboard' && (isStaff ? <StaffDashboardOverview
          userId={session?.user?.id}
          displayName={name}
          onOpenSection={setActiveSection}
        /> : <DashboardOverview
          userId={session?.user?.id}
          displayName={name}
          onOpenFeatures={() => setActiveSection(role === 'member' ? 'catalog' : 'books')}
          onOpenSection={setActiveSection}
          onOpenBook={openDashboardBook}
        />)}
        {displayedSection === 'catalog' && <CatalogPage onBack={() => setActiveSection('dashboard')} role={role} initialBookId={catalogTargetBookId} onInitialBookOpened={clearCatalogTargetBook} />}
        {displayedSection === 'my-books' && <MemberBooks userId={session?.user?.id} onBack={() => setActiveSection('dashboard')} />}
        {displayedSection === 'reservations' && (role === 'member' ? <MemberReservations userId={session?.user?.id} onBack={() => setActiveSection('dashboard')} /> : <StaffReservations onBack={() => setActiveSection('dashboard')} />)}
        {displayedSection === 'history' && <MemberHistory userId={session?.user?.id} onBack={() => setActiveSection('dashboard')} />}
        {displayedSection === 'notifications' && <MemberNotifications userId={session?.user?.id} onBack={() => setActiveSection('dashboard')} />}
        {displayedSection === 'profile' && <MemberProfile userId={session?.user?.id} session={session} profile={profile} onBack={() => setActiveSection('dashboard')} />}
        {displayedSection === 'books' && <StaffCatalogManager view="books" role={role} onBack={() => setActiveSection('dashboard')} />}
        {displayedSection === 'copies' && <StaffCatalogManager view="copies" role={role} onBack={() => setActiveSection('dashboard')} />}
        {displayedSection === 'members' && <StaffMembers />}
        {displayedSection === 'requests' && <StaffBookRequests />}
        {displayedSection === 'audit' && <StaffInventoryAudit />}
        {displayedSection === 'circulation' && <StaffCirculation onBack={() => setActiveSection('dashboard')} />}
        {displayedSection === 'overdue' && <StaffOverdue onBack={() => setActiveSection('dashboard')} />}
        {displayedSection === 'system-settings' && isAdministrator && <SystemSettings userId={session?.user?.id} onBack={() => setActiveSection('dashboard')} initialTab={systemSettingsInitialTab} />}
        {displayedSection === 'activity-logs' && isAdministrator && <ActivityLogs />}
        {displayedSection === 'reports' && <Reports />}
        {displayedSection === 'transactions' && <TransactionHistory />}
        </Suspense>
      </main>
      <MobileBottomNavigation visibleSections={navigationSections} activeSection={displayedSection} onNavigate={setActiveSection} role={role} onSignOut={signOut} />
      </div>
    </div>
  )
}

function currentBrowserLocation() {
  return {
    pathname: window.location.pathname.replace(/\/+$/, '') || '/',
    search: window.location.search,
    hash: window.location.hash,
  }
}

function App() {
  const { configured, loading, session, profile, error, signOut } = useAuth()
  const [browserLocation, setBrowserLocation] = useState(currentBrowserLocation)
  const routePath = browserLocation.pathname
  const navigate = useCallback((path) => {
    const destination = new URL(path, window.location.origin)
    const nextLocation = {
      pathname: destination.pathname.replace(/\/+$/, '') || '/',
      search: destination.search,
      hash: destination.hash,
    }
    window.history.pushState({}, '', `${destination.pathname}${destination.search}${destination.hash}`)
    setBrowserLocation(nextLocation)
  }, [])

  useEffect(() => {
    const syncLocation = () => setBrowserLocation(currentBrowserLocation())
    window.addEventListener('popstate', syncLocation)
    return () => window.removeEventListener('popstate', syncLocation)
  }, [])

  useEffect(() => {
    if (session && routePath !== '/') {
      window.history.replaceState({}, '', '/')
      setBrowserLocation({ pathname: '/', search: '', hash: '' })
    }
  }, [routePath, session])

  useEffect(() => {
    if (browserLocation.hash) {
      const targetId = decodeURIComponent(browserLocation.hash.slice(1))
      requestAnimationFrame(() => document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth' }))
    } else {
      window.scrollTo({ top: 0, behavior: 'auto' })
    }
  }, [browserLocation])

  if (loading) return <div className="loading-screen">Loading library system…</div>

  if (!configured) {
    if (routePath === '/login') return <AuthPage><SetupNotice /></AuthPage>
    if (routePath === '/catalog') return <AuthPage browsingCatalog onBackToSignIn={() => navigate('/login')}><SetupNotice /></AuthPage>
    return <HomePage onNavigate={navigate} />
  }

  if (session && !profile) return <div className="empty-state" role="alert"><p>{error || 'Unable to load your library profile.'}</p><button onClick={() => window.location.reload()}>Retry</button><button onClick={signOut}>Sign out</button></div>

  if (session) return <Dashboard />

  if (routePath === '/login') return <AuthPage><AuthForm onBrowseCatalog={() => navigate('/catalog')} onBackToHomepage={() => navigate('/')} /></AuthPage>

  if (routePath === '/catalog') {
    const initialSearch = new URLSearchParams(browserLocation.search).get('search') || ''
    return <AuthPage browsingCatalog onBackToSignIn={() => navigate('/login')}>
      <Suspense fallback={<div className="empty-state loading-state">Loading catalog...</div>}>
        <CatalogPage role="public" initialSearch={initialSearch} onBack={() => navigate('/')} onSignIn={() => navigate('/login')} />
      </Suspense>
    </AuthPage>
  }

  return <HomePage onNavigate={navigate} />
}

export default App
