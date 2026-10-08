import { fetchAllRows } from './lib/paging'
import { TransactionHistory } from './components/TransactionHistory'
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { Alert, Button, IconButton, InputAdornment, Paper, TextField } from '@mui/material'
import { detectAuthIdentifierType, useAuth } from './lib/auth'
import { supabase } from './lib/supabase'
import { defaultCirculationPolicy, getLoanDueState, normalizeCirculationPolicy } from './lib/circulation'

const lazyNamed = (loader, exportName) => lazy(() => loader().then((module) => ({ default: module[exportName] })))
const AdminPanel = lazyNamed(() => import('./components/StaffTools'), 'AdminPanel')
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
  'user-management': 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M5 21a7 7 0 0 1 14 0 M18 8h3 M19.5 6.5v3',
  'my-books': 'M5 4h9a5 5 0 0 1 5 5v11H10a5 5 0 0 0-5 0V4z',
  history: 'M5 12a7 7 0 1 0 2-5 M5 5v4h4 M12 8v5l3 2',
  'activity-logs': 'M5 12a7 7 0 1 0 2-5 M5 5v4h4 M12 8v5l3 2',
  notifications: 'M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M10 21h4',
  profile: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M5 21a7 7 0 0 1 14 0',
}

function NavigationIcon({ id }) {
  return <svg className="navigation-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={navigationIconPaths[id] || navigationIconPaths.dashboard} /></svg>
}

export function friendlyAuthError(message) {
  const normalized = (message || '').toLowerCase()
  if (normalized.includes('failed to fetch') || normalized.includes('timed out') || normalized.includes('network')) return 'The library service could not be reached. Verify the Supabase URL and your internet connection, then try again.'
  if (normalized.includes('rate limit')) return 'Too many sign-in attempts were made. Wait a few minutes, then try again.'
  if (normalized.includes('edge function') || normalized.includes('function not found') || normalized.includes('not configured on the server')) return 'The sign-in service is unavailable. Please try again later.'
  if (normalized.includes('invalid email, school id, or password') || normalized.includes('invalid login credentials') || normalized.includes('school id or password') || normalized.includes('email or password') || normalized.includes('email not confirmed')) return 'Invalid email, School ID, or password.'
  if (normalized.includes('signups not allowed')) return 'Student registration is disabled in Supabase Auth. Enable email sign-ups and email confirmation in the project settings.'
  return 'We could not complete that request. Check your details and try again.'
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

function AuthForm({ onBrowseCatalog }) {
  const { signIn, recoverSchoolId, createMemberAccount, error: authError, clearError } = useAuth()
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [invitation, setInvitation] = useState('')
  const [recovering, setRecovering] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [registering, setRegistering] = useState(false)
  const [registration, setRegistration] = useState({ fullName: '', email: '', schoolId: '', password: '', confirmPassword: '' })
  const [registrationMessage, setRegistrationMessage] = useState('')
  const [submitError, setSubmitError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const identifierType = detectAuthIdentifierType(identifier)

  const switchMode = (nextMode) => {
    setRegistering(nextMode)
    setRecovering(false)
    setInvitation('')
    setPassword('')
    setSubmitError('')
    setRegistrationMessage('')
    clearError()
  }

  const submit = async (event) => {
    event.preventDefault()
    setSubmitting(true)
    setSubmitError('')
    clearError()

    try {
      if (registering) {
        if (registration.password !== registration.confirmPassword) {
          setSubmitError('The passwords do not match.')
          return
        }
        const result = await createMemberAccount(registration)
        if (result.error) setSubmitError(result.error.message)
        else {
          setRegistrationMessage('If this email can be registered, a confirmation message has been sent. Confirm your email, sign in, then verify your library card and PIN to link your library record.')
          setRegistering(false)
          setIdentifier(registration.email.trim())
          setRegistration((current) => ({ ...current, password: '', confirmPassword: '' }))
        }
      } else if (recovering) {
        if (identifierType !== 'school_id') {
          setSubmitError('Enter the School ID verified by library staff to use account recovery.')
          return
        }
        const result = await recoverSchoolId(identifier, password, invitation)
        if (result.error) setSubmitError(result.error.message)
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

  const primaryButtonSx = { minHeight: '3.1rem', marginTop: '.1rem', borderRadius: '.55rem', backgroundColor: '#a40000', '&:hover': { backgroundColor: '#820000' }, '&:focus-visible': { outline: '3px solid rgba(164, 0, 0, .24)', outlineOffset: '2px' } }
  const secondaryButtonSx = { minHeight: '3rem', marginTop: '.5rem', borderRadius: '.55rem', borderColor: '#a40000', color: '#8d0000', '&:hover': { borderColor: '#820000', backgroundColor: '#fff7f7' } }

  return (
    <Paper component="section" className="auth-card" elevation={0} sx={{ backgroundColor: '#fff', border: '1px solid #e6d9d8', borderRadius: '1.1rem', boxShadow: '0 1rem 2.5rem rgba(0, 38, 61, .08)' }}>
      <div className="card-heading">
        <span className="eyebrow">Library access</span>
        <h2>{registering ? 'Create member account' : 'Sign In'}</h2>
        <p>{registering
          ? 'Register with your email and School ID. After email confirmation, verify your library card to connect your library record.'
          : 'Access your IBA College Library account.'}</p>
      </div>
      {registrationMessage && <Alert severity="success" variant="outlined" role="status" sx={authFeedbackSx}>{registrationMessage}</Alert>}
      {registering ? <form onSubmit={submit} aria-busy={submitting}>
        <TextField id="register-full-name" label="Full name" value={registration.fullName} onChange={(event) => setRegistration({ ...registration, fullName: event.target.value })} autoComplete="name" inputProps={{ maxLength: 160 }} required fullWidth sx={authFieldSx} />
        <TextField id="register-email" label="Email address" type="email" value={registration.email} onChange={(event) => setRegistration({ ...registration, email: event.target.value })} autoComplete="email" required fullWidth sx={authFieldSx} />
        <TextField id="register-school-id" label="School ID" value={registration.schoolId} onChange={(event) => setRegistration({ ...registration, schoolId: event.target.value })} autoComplete="off" inputProps={{ maxLength: 32, pattern: '[A-Za-z0-9][A-Za-z0-9._-]{2,31}' }} helperText="Use the School ID already recorded by library staff." required fullWidth sx={authFieldSx} />
        <TextField id="register-password" label="Create password" type="password" value={registration.password} onChange={(event) => setRegistration({ ...registration, password: event.target.value })} autoComplete="new-password" inputProps={{ minLength: 12, maxLength: 128 }} helperText="Use at least 12 characters." required fullWidth sx={authFieldSx} />
        <TextField id="register-confirm-password" label="Confirm password" type="password" value={registration.confirmPassword} onChange={(event) => setRegistration({ ...registration, confirmPassword: event.target.value })} autoComplete="new-password" inputProps={{ minLength: 12, maxLength: 128 }} required fullWidth sx={authFieldSx} />
        <div className="account-registration-note"><strong>To finish setup:</strong> confirm the email, then enter your library card number and private reservation PIN. Ask library staff to set a PIN if you do not have one.</div>
        {(submitError || authError) && <Alert severity="error" variant="outlined" role="alert" sx={authFeedbackSx}>{friendlyAuthError(submitError || authError)}</Alert>}
        <Button type="submit" fullWidth variant="contained" disabled={submitting} sx={primaryButtonSx}>{submitting ? 'Creating account...' : 'Create account'}</Button>
        <Button type="button" fullWidth variant="outlined" onClick={() => switchMode(false)} sx={secondaryButtonSx}>Back to sign in</Button>
      </form> : <form className="auth-form" onSubmit={submit} aria-busy={submitting}>
        <TextField
          id="auth-identifier"
          name="username"
          type="text"
          label="Email or School ID"
          placeholder="Enter your email or School ID"
          autoComplete="username"
          inputProps={{ maxLength: 320 }}
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
          required
          fullWidth
          sx={authFieldSx}
        />
        <TextField
          id="auth-password"
          name="password"
          type={showPassword ? 'text' : 'password'}
          label={recovering ? 'New password' : 'Password'}
          autoComplete={recovering ? 'new-password' : 'current-password'}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          inputProps={{ minLength: recovering ? 12 : 6, maxLength: 128 }}
          required
          fullWidth
          sx={authFieldSx}
          InputProps={{
            endAdornment: <InputAdornment position="end"><IconButton
              type="button"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              onClick={() => setShowPassword((visible) => !visible)}
              edge="end"
              size="small"
            >{showPassword ? 'Hide password' : 'Show password'}</IconButton></InputAdornment>,
          }}
        />
        {recovering && (identifierType === 'school_id'
          ? <TextField label="Staff recovery code" type="password" value={invitation} onChange={(event) => setInvitation(event.target.value.trim())} required fullWidth helperText="Ask library staff for a one-time code after they verify your identity." sx={authFieldSx} />
          : <p className="auth-recovery-note">School ID recovery uses the ID verified by library staff and a staff-issued recovery code.</p>)}
        {(submitError || authError) && <Alert severity="error" variant="outlined" role="alert" sx={authFeedbackSx}>{friendlyAuthError(submitError || authError)}</Alert>}
        <Button type="submit" fullWidth variant="contained" disabled={submitting || (recovering && identifierType !== 'school_id')} sx={primaryButtonSx}>{submitting ? recovering ? 'Resetting password...' : 'Signing in...' : recovering ? 'Reset Password' : 'Sign In'}</Button>
        <button type="button" className="auth-text-link" aria-expanded={recovering} onClick={() => { setRecovering((value) => !value); setInvitation(''); setPassword(''); setSubmitError(''); clearError() }}>{recovering ? 'Back to Sign In' : 'Forgot Password?'}</button>
        {!recovering && <Button type="button" fullWidth variant="outlined" onClick={() => switchMode(true)} sx={secondaryButtonSx}>Create Member Account</Button>}
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
      <p>Browse without an account. Members can use a library card and PIN for online holds; staff record checkouts and returns at the desk.</p>
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
        <Button type="button" variant="outlined" onClick={onBackToSignIn} sx={{ borderColor: '#a40000', color: '#8d0000', '&:hover': { borderColor: '#820000', backgroundColor: '#fff7f7' } }}>Staff sign in</Button>
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

function MemberAccountLink({ session, profile }) {
  const { completeMemberAccountRegistration, refreshProfile, signOut } = useAuth()
  const [schoolId, setSchoolId] = useState(session?.user?.user_metadata?.registration_school_id || '')
  const [cardNumber, setCardNumber] = useState('')
  const [pin, setPin] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')

  const submit = async (event) => {
    event.preventDefault()
    setSubmitting(true)
    setMessage('')
    try {
      const result = await completeMemberAccountRegistration(schoolId.trim(), cardNumber.trim(), pin.trim())
      if (result.error) throw result.error
      if (!result.data?.verified) {
        setMessage('We could not verify those details. Check your School ID, library card, and PIN, or ask library staff to update your member record.')
        return
      }
      const profileResult = await refreshProfile()
      if (profileResult.error) throw profileResult.error
    } catch (error) {
      setMessage(error.message || 'We could not link your library record. Please try again or ask library staff for help.')
    } finally {
      setSubmitting(false)
    }
  }

  return <AuthPage>
    <Paper component="section" className="auth-card" elevation={0} sx={{ backgroundColor: '#fff', border: '1px solid #e6d9d8', borderRadius: '1.1rem', boxShadow: '0 1rem 2.5rem rgba(0, 38, 61, .08)' }}>
      <div className="card-heading">
        <span className="eyebrow">One-time verification</span>
        <h2>Link your library record</h2>
        <p>Welcome{profile?.full_name ? `, ${profile.full_name}` : ''}. Confirm your School ID and verify the library card and PIN registered by library staff to access member features.</p>
      </div>
      <form onSubmit={submit} aria-busy={submitting}>
        <TextField id="link-school-id" label="School ID" value={schoolId} onChange={(event) => setSchoolId(event.target.value)} autoComplete="username" inputProps={{ maxLength: 32, pattern: '[A-Za-z0-9][A-Za-z0-9._-]{2,31}' }} required fullWidth sx={authFieldSx} />
        <TextField id="link-library-card" label="Library card number" value={cardNumber} onChange={(event) => setCardNumber(event.target.value)} autoComplete="off" inputProps={{ maxLength: 100 }} required fullWidth sx={authFieldSx} />
        <TextField id="link-reservation-pin" label="Library PIN" type="password" value={pin} onChange={(event) => setPin(event.target.value)} autoComplete="off" inputProps={{ inputMode: 'numeric', pattern: '[0-9]{6,12}', minLength: 6, maxLength: 12 }} helperText="Enter the 6–12 digit PIN issued by library staff." required fullWidth sx={authFieldSx} />
        {message && <Alert severity="error" variant="outlined" role="alert" sx={authFeedbackSx}>{message}</Alert>}
        <div className="account-registration-note"><strong>Need a card or PIN?</strong> Visit the library desk. Staff must register your member record and verify your identity before linking it.</div>
        <Button type="submit" fullWidth variant="contained" disabled={submitting} sx={{ minHeight: '3.1rem', borderRadius: '.55rem', backgroundColor: '#a40000', '&:hover': { backgroundColor: '#820000' } }}>{submitting ? 'Verifying...' : 'Verify and continue'}</Button>
        <Button type="button" fullWidth variant="outlined" onClick={signOut} sx={{ minHeight: '3rem', borderRadius: '.55rem', borderColor: '#a40000', color: '#8d0000' }}>Sign out</Button>
      </form>
    </Paper>
  </AuthPage>
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
  { id: 'user-management', label: 'User Management', roles: ['administrator'] },
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
      { id: 'user-management', label: 'User Management', roles: ['administrator'] },
    ],
  },
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

function StaffSidebar({ role, activeSection, open, onNavigate, onClose }) {
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
    <aside id="staff-sidebar" className={open ? 'staff-sidebar open' : 'staff-sidebar'} aria-label="Staff navigation" aria-expanded={open}>
      <div className="staff-sidebar-brand">
        <div className="brand-mark"><span>IBA</span> College Library</div>
        <button type="button" className="staff-sidebar-close" onClick={onClose} aria-label="Close navigation">Close</button>
      </div>
      <nav className="staff-sidebar-nav">
        {staffNavigationGroups.map((group) => {
          const items = group.items.filter((item) => item.roles.includes(role))
          if (items.length === 0) return null
          return <div className="staff-nav-group" key={group.label}>
            <span className="staff-nav-label">{group.label}</span>
            {items.map((item) => <button type="button" key={item.id} aria-current={activeSection === item.id ? 'page' : undefined} className={activeSection === item.id ? 'staff-nav-item active' : 'staff-nav-item'} onClick={() => onNavigate(item.id)}><NavigationIcon id={item.id} /><span>{item.label}</span></button>)}
          </div>
        })}
      </nav>
      <div className="staff-sidebar-footer"><span className="eyebrow">Access level</span><strong>{roleLabels[role]}</strong></div>
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

function StaffAccountMenu({ name, role, email, onProfile, onSignOut }) {
  return <details className="account-menu">
    <summary className="account-summary"><span className="account-avatar" aria-hidden="true">{getInitials(name)}</span><span className="account-summary-copy"><strong>{name}</strong><small>{roleLabels[role] ?? role}</small></span><span className="account-chevron" aria-hidden="true">More</span></summary>
    <div className="account-menu-panel">
      <small className="account-email">{email}</small>
      <button type="button" className="account-menu-action" onClick={onProfile}>Profile</button>
      <button type="button" className="account-menu-action sign-out-action" onClick={onSignOut}>Sign out</button>
    </div>
  </details>
}

function StaffTopHeader({ role, name, email, pageTitle, menuOpen, onToggleMenu, onProfile, onSignOut }) {
  return <header className="staff-topbar">
    <div className="staff-header-title">
      <button type="button" className="staff-menu-toggle" onClick={onToggleMenu} aria-expanded={menuOpen} aria-controls="staff-sidebar"><span aria-hidden="true">Menu</span><span className="sr-only">Toggle navigation</span></button>
      <div><span className="eyebrow">{roleLabels[role]} workspace</span><h1>{pageTitle}</h1></div>
    </div>
    <div className="account-area"><StaffAccountMenu name={name} role={role} email={email} onProfile={onProfile} onSignOut={onSignOut} /></div>
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

function AdministratorDashboardOverview({ userId, displayName, onOpenSection }) {
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
          .select('id, status, created_at, books(title), member:library_members!reservations_member_id_fkey(full_name)')
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
                <thead><tr><th>Book</th><th>Member · Requested</th><th>Status</th><th>Action</th></tr></thead>
                <tbody>{attentionReservations.map((reservation) => (
                  <tr key={reservation.id}>
                    <td>{reservation.books?.title || 'Unknown book'}</td>
                    <td>{reservation.member?.full_name || 'Unnamed member'}<small className="table-subtext">{formatDashboardDate(reservation.created_at)}</small></td>
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
          <button type="button" className="quick-action-card" onClick={() => onOpenSection('copies')}><span className="quick-action-icon"><DashboardIcon name="copies" /></span><span className="quick-action-copy"><strong>Manage copies</strong><span>Register physical copies</span></span></button>
          <button type="button" className="quick-action-card" onClick={() => onOpenSection('members')}><span className="quick-action-icon"><DashboardIcon name="members" /></span><span className="quick-action-copy"><strong>Find member</strong><span>Open the member directory</span></span></button>
          <button type="button" className="quick-action-card" onClick={() => onOpenSection('circulation')}><span className="quick-action-icon"><DashboardIcon name="circulation" /></span><span className="quick-action-copy"><strong>Borrow / Return</strong><span>Open the circulation desk</span></span></button>
          <button type="button" className="quick-action-card" onClick={() => onOpenSection('reports')}><span className="quick-action-icon"><DashboardIcon name="reports" /></span><span className="quick-action-copy"><strong>View reports</strong><span>Review live summaries</span></span></button>
        </div>
      </section>
    </div>
  )
}

function DashboardOverview({ role, userId, displayName, onOpenFeatures, onOpenSection }) {
  const [stats, setStats] = useState({
    first: null,
    second: null,
    third: null,
    fourth: null,
    unread: null,
  })
  const [loans, setLoans] = useState([])
  const [reservations, setReservations] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [cancellingId, setCancellingId] = useState('')
  const [recentActivity, setRecentActivity] = useState([])
  const [recentBooks, setRecentBooks] = useState([])
  const [policy, setPolicy] = useState(defaultCirculationPolicy)

  const isStaff = role === 'librarian' || role === 'administrator'

  const loadOverview = useCallback(async () => {
    if (!supabase || !userId) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')

    try {
      if (isStaff) {
        const { error: refreshError } = await supabase.rpc('refresh_circulation_statuses')
      if (refreshError) throw refreshError
      }
      const commonStats = await Promise.all([
        supabase.from('books').select('id', { count: 'exact', head: true }),
        supabase.from('book_copies').select('id', { count: 'exact', head: true }).eq('status', 'available'),
        supabase.from('loans').select('id', { count: 'exact', head: true }).in('status', ['borrowed', 'overdue']),
        supabase.from('reservations').select('id', { count: 'exact', head: true }).in('status', ['waiting', 'ready_for_pickup']),
      ])

      if (isStaff) {
        const failed = commonStats.find((result) => result.error)
        if (failed?.error) setError('Some dashboard data could not load. Please try again.')
        setStats({
          first: commonStats[0].error ? null : commonStats[0].count ?? 0,
          second: commonStats[1].error ? null : commonStats[1].count ?? 0,
          third: commonStats[2].error ? null : commonStats[2].count ?? 0,
          fourth: commonStats[3].error ? null : commonStats[3].count ?? 0,
          unread: null,
        })
        return
      }

      const [memberLoans, memberReservations, unreadNotifications, recentLoans, recentReservations, recentCatalog, policyResult] = await Promise.all([
        fetchAllRows(() => supabase.from('loans').select('id, status, due_at, checked_out_at, book_copies(books(title))').in('status', ['borrowed', 'overdue']).order('created_at', { ascending: false })),
        fetchAllRows(() => supabase.from('reservations').select('id, status, created_at, books(title)').in('status', ['waiting', 'ready_for_pickup']).order('created_at', { ascending: false })),
        supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('member_id', userId).is('read_at', null),
        supabase.from('loans').select('id, status, created_at, returned_at, book_copies(books(title))').order('created_at', { ascending: false }).limit(5),
        supabase.from('reservations').select('id, status, created_at, books(title)').order('created_at', { ascending: false }).limit(5),
        supabase.from('books').select('id, title, author, category, cover_url, created_at, book_copies(status)').order('created_at', { ascending: false }).limit(4),
        supabase.rpc('get_circulation_policy'),
      ])

      const failed = [...commonStats, memberLoans, memberReservations, unreadNotifications, recentLoans, recentReservations, recentCatalog].find((result) => result.error)
      if (failed?.error) setError('Some account activity could not load. Please try again.')
      setStats({
        first: memberLoans.data?.filter((loan) => ['borrowed', 'overdue'].includes(loan.status)).length ?? 0,
        second: memberReservations.data?.length ?? 0,
        third: memberLoans.data?.filter((loan) => getLoanDueState(loan.due_at, policyResult.error ? defaultCirculationPolicy.due_soon_days : normalizeCirculationPolicy(policyResult.data).due_soon_days) === 'due-soon').length ?? 0,
        fourth: memberLoans.data?.filter((loan) => new Date(loan.due_at) < new Date()).length ?? 0,
        unread: unreadNotifications.count ?? 0,
      })
      if (!policyResult.error) setPolicy(normalizeCirculationPolicy(policyResult.data))
      setLoans((memberLoans.data ?? []).slice(0, 4))
      setReservations((memberReservations.data ?? []).slice(0, 4))
      setRecentActivity([
        ...(recentLoans.data ?? []).map((loan) => ({ id: `loan-${loan.id}`, label: loan.status === 'returned' ? `Returned ${loan.book_copies?.books?.title || 'a book'}` : `Borrowed ${loan.book_copies?.books?.title || 'a book'}`, status: loan.status, created_at: loan.returned_at || loan.created_at })),
        ...(recentReservations.data ?? []).map((reservation) => ({ id: `reservation-${reservation.id}`, label: `Reserved ${reservation.books?.title || 'a book'}`, status: reservation.status, created_at: reservation.created_at })),
      ].sort((left, right) => new Date(right.created_at) - new Date(left.created_at)).slice(0, 6))
      setRecentBooks(recentCatalog.data ?? [])
    } catch (loadError) {
      if (import.meta.env.DEV) console.error('[dashboard] overview failed', loadError)
      setError(isStaff ? 'Some dashboard data could not load. Please try again.' : 'Some account activity could not load. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [isStaff, userId])

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

  const firstName = displayName.split(' ')[0]
  const metric = (value) => loading ? 'Loading' : value === null ? 'Not available' : value

  return (
    <>
      <div className="welcome-row">
        <div>
          <span className="eyebrow">{roleLabels[role] ?? 'User'} dashboard</span>
          <h1>{getGreeting()}, {firstName}.</h1>
          <p className="muted">{isStaff ? 'Keep the collection, circulation desk, and access controls moving.' : 'Find what you need, reserve unavailable books, and track the books you borrow.'}</p>
        </div>
        <div className="status-pill"><span /> Live library overview</div>
      </div>

      <div className="dashboard-actions">
        <button type="button" className="primary-button" onClick={onOpenFeatures}>{isStaff ? 'Open catalog tools' : 'Browse the catalog'}</button>
        {isStaff && <button type="button" className="secondary-button" onClick={() => onOpenSection('transactions')}>View transactions</button>}
        {!isStaff && stats.unread > 0 && <span className="action-note">{stats.unread} unread notification{stats.unread === 1 ? '' : 's'}</span>}
      </div>

      <div className="stat-grid">
        {isStaff ? <>
          <article className="stat-card accent-red"><span>Catalog titles</span><strong>{metric(stats.first)}</strong><small>Book records in the system</small></article>
          <article className="stat-card accent-gold"><span>Available copies</span><strong>{metric(stats.second)}</strong><small>Ready to be borrowed</small></article>
          <article className="stat-card accent-navy"><span>Books checked out</span><strong>{metric(stats.third)}</strong><small>Currently borrowed</small></article>
          <article className="stat-card"><span>Open reservations</span><strong>{metric(stats.fourth)}</strong><small>Waiting or ready for pickup</small></article>
        </> : <>
          <article className="stat-card accent-red"><span>Books borrowed</span><strong>{metric(stats.first)}</strong><small>Currently checked out</small></article>
          <article className="stat-card accent-gold"><span>Active reservations</span><strong>{metric(stats.second)}</strong><small>Waiting or ready for pickup</small></article>
          <article className="stat-card accent-navy"><span>Due soon</span><strong>{metric(stats.third)}</strong><small>Due within {policy.due_soon_days} days</small></article>
          <article className="stat-card"><span>Overdue</span><strong>{metric(stats.fourth)}</strong><small>Explicitly marked overdue</small></article>
        </>}
      </div>

      {error && <div className="inline-error with-action" role="alert"><span>{error}</span><button type="button" className="retry-button" onClick={loadOverview}>Try again</button></div>}

      {isStaff ? <section className="role-panel workspace-panel">
        <div>
          <span className="eyebrow">Staff workspace</span>
          <h2>Library operations</h2>
          <p>Use the navigation to manage catalog records, process checkouts and returns, and review access roles.</p>
        </div>
        <div className="workspace-links">
          <button type="button" className="card-action" onClick={onOpenFeatures}>Open tools</button>
          <button type="button" className="card-action" onClick={() => onOpenSection('reports')}>Open reports</button>
        </div>
      </section> : <section className="activity-grid">
        <div className="activity-panel">
          <div className="panel-heading"><div><span className="eyebrow">Borrowing</span><h2>Books I have borrowed</h2></div><button type="button" className="text-button" onClick={onOpenFeatures}>Browse catalog</button></div>
          {loading ? <div className="empty-state compact loading-state">Loading your books...</div> : loans.length === 0 ? <div className="empty-state compact">No books are currently checked out to you.</div> : <div className="activity-list">{loans.map((loan) => <div className="activity-item" key={loan.id}><div><strong>{loan.book_copies?.books?.title || 'Unknown book'}</strong><small>Checked out {new Date(loan.checked_out_at).toLocaleDateString()}</small></div><span className={loan.status === 'overdue' ? 'table-status danger' : 'table-status'} data-status={loan.status}>{loan.status}</span></div>)}</div>}
        </div>
        <div className="activity-panel">
          <div className="panel-heading"><div><span className="eyebrow">Reservations</span><h2>My queue</h2></div><button type="button" className="text-button" onClick={onOpenFeatures}>Find a book</button></div>
          {loading ? <div className="empty-state compact loading-state">Loading your reservations...</div> : reservations.length === 0 ? <div className="empty-state compact">No active reservations yet.</div> : <div className="activity-list">{reservations.map((reservation) => <div className="activity-item" key={reservation.id}><div><strong>{reservation.books?.title || 'Unknown book'}</strong><small>Requested {new Date(reservation.created_at).toLocaleDateString()}</small></div><div className="activity-actions"><span className="table-status" data-status={reservation.status}>{reservation.status.replaceAll('_', ' ')}</span><button type="button" className="icon-button" onClick={() => cancelReservation(reservation.id)} disabled={cancellingId === reservation.id} aria-label="Cancel reservation">{cancellingId === reservation.id ? '...' : 'Cancel'}</button></div></div>)}</div>}
        </div>
      </section>}
      {!isStaff && <section className="activity-lower-grid">
        <div className="activity-panel">
          <div className="panel-heading"><div><span className="eyebrow">Timeline</span><h2>Recent activity</h2></div></div>
          {loading ? <div className="empty-state compact loading-state">Loading recent activity...</div> : recentActivity.length === 0 ? <div className="empty-state compact">Your recent activity will appear here.</div> : <div className="activity-list">{recentActivity.map((item) => <div className="activity-item" key={item.id}><div><strong>{item.label}</strong><small>{new Date(item.created_at).toLocaleString()}</small></div><span className="table-status" data-status={item.status}>{item.status.replaceAll('_', ' ')}</span></div>)}</div>}
        </div>
        <div className="activity-panel">
          <div className="panel-heading"><div><span className="eyebrow">Discover</span><h2>Recently added</h2></div><button type="button" className="text-button" onClick={onOpenFeatures}>View catalog</button></div>
          {loading ? <div className="empty-state compact">Loading catalog highlights...</div> : recentBooks.length === 0 ? <div className="empty-state compact">New catalog items will appear here.</div> : <div className="mini-book-list">{recentBooks.map((book) => { const available = (book.book_copies || []).filter((copy) => copy.status === 'available').length; return <div className="mini-book-item" key={book.id}><div className="mini-book-cover">{book.cover_url ? <img src={book.cover_url} alt="" /> : <span>BOOK</span>}</div><div><strong>{book.title}</strong><small>{book.author}</small><span className={available > 0 ? 'availability available' : 'availability unavailable'}>{available > 0 ? `${available} available` : 'Unavailable'}</span></div></div> })}</div>}
        </div>
      </section>}
    </>
  )
}


function Reports() {
  const [stats, setStats] = useState({ books: null, copies: null, availableCopies: null, activeLoans: null, openReservations: null, overdueLoans: null })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    let active = true
    const loadStats = async () => {
      if (!supabase) {
        if (active) setLoading(false)
        return
      }
      setLoading(true)
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
        if (active) setLoading(false)
      }
    }
    loadStats()
    return () => { active = false }
  }, [retryKey])

  const reportValue = (value, label) => loading ? 'Loading' : value === null ? 'Not available' : `${value} ${label}`

  return (
    <section className="content-section">
      <div className="section-heading page-header">
        <div>
          <span className="eyebrow">Insights</span>
          <h2>Reports</h2>
          <p className="muted">Live summaries of the current collection, circulation, and reservation records.</p>
        </div>
      </div>
      <div className="report-grid staff-report-grid">
        <article className="section-panel"><span>Catalog titles</span><strong>{reportValue(stats.books, 'titles')}</strong><small>Distinct book records.</small></article>
        <article className="section-panel"><span>Physical copies</span><strong>{reportValue(stats.copies, 'copies')}</strong><small>All registered copy records.</small></article>
        <article className="section-panel"><span>Available copies</span><strong>{reportValue(stats.availableCopies, 'available')}</strong><small>Copies ready to check out.</small></article>
        <article className="section-panel"><span>Books checked out</span><strong>{reportValue(stats.activeLoans, stats.activeLoans === 1 ? 'book' : 'books')}</strong><small>Currently borrowed or overdue.</small></article>
        <article className="section-panel"><span>Open reservations</span><strong>{reportValue(stats.openReservations, 'holds')}</strong><small>Waiting or ready for pickup.</small></article>
        <article className="section-panel"><span>Overdue books</span><strong>{reportValue(stats.overdueLoans, stats.overdueLoans === 1 ? 'book' : 'books')}</strong><small>Borrowed books past their due date.</small></article>
      </div>
      {error && <div className="inline-error with-action" role="alert"><span>{error}</span><button type="button" className="retry-button" onClick={() => setRetryKey((current) => current + 1)}>Try again</button></div>}
      <p className="report-footnote">These are live counts from the current library records; they do not include archived or deleted data.</p>
    </section>
  )
}


function NotificationBell({ userId, onOpen }) {
  const [unread, setUnread] = useState(0)

  useEffect(() => {
    let active = true
    const loadUnread = async () => {
      if (!supabase || !userId) return
      try {
        const { count, error: unreadError } = await supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('member_id', userId).is('read_at', null)
        if (unreadError && import.meta.env.DEV) console.error('[notifications] unread count failed', unreadError)
        if (active) setUnread(count ?? 0)
      } catch (loadError) {
        if (import.meta.env.DEV) console.error('[notifications] unread count failed', loadError)
      }
    }
    loadUnread()
    return () => { active = false }
  }, [userId])

  return <button className="header-link notification-button" onClick={onOpen} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>Notifications{unread > 0 && <span className="notification-count">{unread > 9 ? '9+' : unread}</span>}</button>
}

function Dashboard() {
  const { profile, session, signOut } = useAuth()
  const [activeSection, setActiveSection] = useState('dashboard')
  const [menuOpen, setMenuOpen] = useState(false)
  const role = profile?.role ?? 'member'
  const isStaff = role === 'librarian' || role === 'administrator'
  const isAdministrator = role === 'administrator'
  const accountIdentifier = profile?.school_id ? `School ID: ${profile.school_id}` : session?.user?.email
  const name = isStaff ? profile?.full_name || roleLabels[role] : profile?.full_name || accountIdentifier || 'Library user'
  const visibleSections = isStaff
    ? staffNavigationGroups.flatMap((group) => group.items).filter((section) => section.roles.includes(role))
    : dashboardSections.filter((section) => section.roles.includes(role))
  const activeSectionIsAllowed = visibleSections.some((section) => section.id === activeSection)
  const staffProfileIsOpen = isStaff && activeSection === 'profile'
  const displayedSection = activeSectionIsAllowed || staffProfileIsOpen ? activeSection : 'dashboard'
  const pageTitle = displayedSection === 'dashboard'
    ? `${roleLabels[role]} Dashboard`
    : visibleSections.find((section) => section.id === displayedSection)?.label || 'Profile'

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

  return (
    <div className={isStaff ? 'dashboard-shell staff-shell' : 'dashboard-shell'}>
      {isStaff && <StaffSidebar role={role} activeSection={displayedSection} open={menuOpen} onNavigate={(section) => { setActiveSection(section); setMenuOpen(false) }} onClose={() => setMenuOpen(false)} />}
      <div className={isStaff ? 'staff-main' : ''}>
      {isStaff && <StaffTopHeader
        role={role}
        name={name}
        email={accountIdentifier}
        pageTitle={pageTitle}
        menuOpen={menuOpen}
        onToggleMenu={() => setMenuOpen((open) => !open)}
        onProfile={() => { setActiveSection('profile'); setMenuOpen(false) }}
        onSignOut={signOut}
      />}
      <header className={isStaff ? 'topbar staff-legacy-topbar' : 'topbar'}>
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
            <div>
              <strong>{name}</strong>
              <small>{roleLabels[role] ?? role}</small>
            </div>
            {role === 'member' && <NotificationBell userId={session?.user?.id} onOpen={() => setActiveSection('notifications')} />}
            <button type="button" className="header-link" onClick={() => setActiveSection('profile')}>Profile</button>
            <button type="button" className="secondary-button" onClick={signOut}>Sign out</button>
          </>}
        </div>
      </header>
      <button type="button" className="mobile-menu-button" onClick={() => setMenuOpen((open) => !open)} aria-expanded={menuOpen} aria-controls="library-navigation">{menuOpen ? 'Close menu' : 'Menu'}</button>
      <nav id="library-navigation" className={menuOpen ? 'dashboard-nav open' : 'dashboard-nav'} aria-label="Library sections">
        <div className="dashboard-nav-inner">
          {visibleSections.map((section) => (
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
      <main className={isStaff ? 'dashboard-content staff-content' : 'dashboard-content'}>
        <Suspense fallback={<div className="empty-state loading-state">Loading workspace...</div>}>
        {displayedSection === 'dashboard' && (isAdministrator ? <AdministratorDashboardOverview
          userId={session?.user?.id}
          displayName={name}
          onOpenSection={setActiveSection}
        /> : <DashboardOverview
          role={role}
          userId={session?.user?.id}
          displayName={name}
          onOpenFeatures={() => setActiveSection(role === 'member' ? 'catalog' : 'books')}
          onOpenSection={setActiveSection}
        />)}
        {displayedSection === 'catalog' && <CatalogPage onBack={() => setActiveSection('dashboard')} role={role} />}
        {displayedSection === 'my-books' && <MemberBooks userId={session?.user?.id} />}
        {displayedSection === 'reservations' && (role === 'member' ? <MemberReservations userId={session?.user?.id} /> : <StaffReservations onBack={() => setActiveSection('dashboard')} />)}
        {displayedSection === 'history' && <MemberHistory userId={session?.user?.id} />}
        {displayedSection === 'notifications' && <MemberNotifications userId={session?.user?.id} />}
        {displayedSection === 'profile' && <MemberProfile userId={session?.user?.id} session={session} profile={profile} />}
        {displayedSection === 'books' && <StaffCatalogManager view="books" onBack={() => setActiveSection('dashboard')} />}
        {displayedSection === 'copies' && <StaffCatalogManager view="copies" onBack={() => setActiveSection('dashboard')} />}
        {displayedSection === 'members' && <StaffMembers />}
        {displayedSection === 'requests' && <StaffBookRequests />}
        {displayedSection === 'audit' && <StaffInventoryAudit />}
        {displayedSection === 'circulation' && <StaffCirculation onBack={() => setActiveSection('dashboard')} />}
        {displayedSection === 'overdue' && <StaffOverdue />}
        {displayedSection === 'user-management' && <AdminPanel userId={session?.user?.id} onBack={() => setActiveSection('dashboard')} />}
        {displayedSection === 'activity-logs' && isAdministrator && <ActivityLogs />}
        {displayedSection === 'reports' && <Reports />}
        {displayedSection === 'transactions' && <TransactionHistory />}
        </Suspense>
      </main>
      </div>
    </div>
  )
}

function App() {
  const { configured, loading, session, profile, error, signOut } = useAuth()
  const [browsingCatalog, setBrowsingCatalog] = useState(false)

  if (loading) return <div className="loading-screen">Loading library system…</div>

  if (!configured) {
    return <AuthPage><SetupNotice /></AuthPage>
  }

  if (session && !profile) return <div className="empty-state" role="alert"><p>{error || 'Unable to load your library profile.'}</p><button onClick={() => window.location.reload()}>Retry</button><button onClick={signOut}>Sign out</button></div>

  if (session && profile?.role === 'member' && !profile.member_linked) return <MemberAccountLink session={session} profile={profile} />

  if (session) return <Dashboard />

  return <AuthPage
    browsingCatalog={browsingCatalog}
    onBackToSignIn={() => setBrowsingCatalog(false)}
  >
    {browsingCatalog
      ? <Suspense fallback={<div className="empty-state loading-state">Loading catalog...</div>}>
          <CatalogPage role="public" onBack={() => setBrowsingCatalog(false)} />
        </Suspense>
      : <AuthForm onBrowseCatalog={() => setBrowsingCatalog(true)} />}
  </AuthPage>
}

export default App
