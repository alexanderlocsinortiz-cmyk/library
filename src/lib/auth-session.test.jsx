import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider, useAuth } from './auth'

const mock = vi.hoisted(() => ({ listener: null, lookups: new Map(), getSession: vi.fn(), from: vi.fn(), rpc: vi.fn(), invoke: vi.fn(), setSession: vi.fn(), signOut: vi.fn(), signUp: vi.fn(), signInWithPassword: vi.fn() }))
vi.mock('./supabase', () => ({
  hasSupabaseConfig: true,
  supabase: {
    auth: { getSession: mock.getSession, setSession: mock.setSession, signUp: mock.signUp, signInWithPassword: mock.signInWithPassword, onAuthStateChange: (listener) => { mock.listener = listener; return { data: { subscription: { unsubscribe() {} } } } },
      signOut: mock.signOut,
    },
    from: mock.from,
    rpc: mock.rpc,
    functions: { invoke: mock.invoke },
  },
}))
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
function Probe() {
  const { session, profile, loading, error } = useAuth()
  return <div data-testid="auth">{JSON.stringify({ user: session?.user?.id, role: profile?.role, memberLinked: profile?.member_linked, loading, error })}</div>
}
function AuthActions() {
  const { createMemberAccount, signIn, signOut } = useAuth()
  return <div>
    <button onClick={() => createMemberAccount({ fullName: 'Student Example', email: 'STUDENT@EXAMPLE.EDU', schoolId: 'stu-123', password: 'long-password-value' })}>Register test student</button>
    <button onClick={() => signIn('STUDENT@example.edu', 'long-password-value')}>Sign in by email</button>
    <button onClick={() => signIn(' stu-123 ', 'long-password-value')}>Sign in by School ID</button>
    <button onClick={() => signOut()}>Sign out test account</button>
  </div>
}
beforeEach(() => {
  mock.lookups.clear()
  mock.getSession.mockResolvedValue({ data: { session: { user: { id: 'A' } } }, error: null })
  mock.from.mockImplementation(() => ({ select: () => ({ eq: (_column, id) => ({ maybeSingle: () => mock.lookups.get(id).promise }) }) }))
  mock.rpc.mockResolvedValue({ data: true, error: null })
  mock.invoke.mockResolvedValue({ data: { session: { user: { id: 'A' } } }, error: null })
  mock.setSession.mockResolvedValue({ data: { session: { user: { id: 'A' } } }, error: null })
  mock.signUp.mockResolvedValue({ data: { user: null, session: null }, error: null })
  mock.signInWithPassword.mockResolvedValue({ data: { user: { id: 'A' }, session: { user: { id: 'A' } } }, error: null })
  mock.signOut.mockResolvedValue({ error: null })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('session/profile races', () => {
  it('ignores the old administrator profile after switching accounts', async () => {
    const a = deferred(); const b = deferred()
    mock.lookups.set('A', a); mock.lookups.set('B', b)
    render(<AuthProvider><Probe /></AuthProvider>)
    await waitFor(() => expect(mock.from).toHaveBeenCalledTimes(1))
    act(() => mock.listener('SIGNED_IN', { user: { id: 'B' } }))
    await waitFor(() => expect(mock.from).toHaveBeenCalledTimes(2))
    await act(async () => b.resolve({ data: { id: 'B', role: 'member' }, error: null }))
    await act(async () => a.resolve({ data: { id: 'A', role: 'administrator' }, error: null }))
    expect(JSON.parse(screen.getByTestId('auth').textContent)).toMatchObject({ user: 'B', role: 'member', loading: false })
  })
  it('does not restore a profile when sign-out occurs during lookup', async () => {
    const a = deferred(); mock.lookups.set('A', a)
    render(<AuthProvider><Probe /></AuthProvider>)
    await waitFor(() => expect(mock.from).toHaveBeenCalled())
    act(() => mock.listener('SIGNED_OUT', null))
    await act(async () => a.resolve({ data: { id: 'A', role: 'administrator' }, error: null }))
    expect(JSON.parse(screen.getByTestId('auth').textContent)).not.toHaveProperty('role')
  })
  it('reports a missing profile explicitly', async () => {
    const a = deferred(); mock.lookups.set('A', a)
    render(<AuthProvider><Probe /></AuthProvider>)
    await waitFor(() => expect(mock.from).toHaveBeenCalled())
    await act(async () => a.resolve({ data: null, error: null }))
    expect(JSON.parse(screen.getByTestId('auth').textContent)).toMatchObject({ loading: false, error: 'Your library profile is missing. Contact staff.' })
  })
  it('keeps an unlinked member behind the member-account verification gate', async () => {
    const a = deferred(); mock.lookups.set('A', a); mock.rpc.mockResolvedValue({ data: false, error: null })
    render(<AuthProvider><Probe /></AuthProvider>)
    await waitFor(() => expect(mock.from).toHaveBeenCalled())
    await act(async () => a.resolve({ data: { id: 'A', role: 'member', school_id: 'UNVERIFIED-CLAIM' }, error: null }))
    expect(JSON.parse(screen.getByTestId('auth').textContent)).toMatchObject({ role: 'member', memberLinked: false, loading: false })
    expect(mock.rpc).toHaveBeenCalledWith('current_user_has_active_library_member')
  })
  it('registers with normalized email and keeps the School ID as untrusted candidate metadata', async () => {
    mock.getSession.mockResolvedValue({ data: { session: null }, error: null })
    render(<AuthProvider><AuthActions /></AuthProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Register test student' }))
    await waitFor(() => expect(mock.signUp).toHaveBeenCalled())
    const [credentials] = mock.signUp.mock.calls[0]
    expect(credentials.email).toBe('student@example.edu')
    expect(credentials.options.data).toEqual({ full_name: 'Student Example', registration_school_id: 'STU-123' })
  })
  it('automatically routes an email identifier through the email auth function', async () => {
    mock.getSession.mockResolvedValue({ data: { session: null }, error: null })
    render(<AuthProvider><AuthActions /></AuthProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in by email' }))
    await waitFor(() => expect(mock.invoke).toHaveBeenCalledWith('email-auth', {
      body: { email: 'student@example.edu', password: 'long-password-value' },
    }))
    expect(mock.setSession).toHaveBeenCalledWith({ user: { id: 'A' } })
  })
  it('automatically routes a School ID through the server-side School ID auth function', async () => {
    mock.getSession.mockResolvedValue({ data: { session: null }, error: null })
    render(<AuthProvider><AuthActions /></AuthProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in by School ID' }))
    await waitFor(() => expect(mock.invoke).toHaveBeenCalledWith('school-id-auth', {
      body: { action: 'sign-in', schoolId: 'stu-123', password: 'long-password-value', invitation: '' },
    }))
    expect(mock.setSession).toHaveBeenCalledWith({ user: { id: 'A' } })
  })
  it('still ends the session when the logout audit request fails', async () => {
    const a = deferred(); mock.lookups.set('A', a)
    render(<AuthProvider><AuthActions /></AuthProvider>)
    await waitFor(() => expect(mock.from).toHaveBeenCalled())
    await act(async () => a.resolve({ data: { id: 'A', role: 'administrator' }, error: null }))
    mock.rpc.mockRejectedValueOnce(new Error('network unavailable'))
    fireEvent.click(screen.getByRole('button', { name: 'Sign out test account' }))
    await waitFor(() => expect(mock.signOut).toHaveBeenCalled())
  })
  it('keeps the current profile mounted when Supabase republishes the same user session', async () => {
    const a = deferred(); mock.lookups.set('A', a)
    render(<AuthProvider><Probe /></AuthProvider>)
    await waitFor(() => expect(mock.from).toHaveBeenCalledTimes(1))
    await act(async () => a.resolve({ data: { id: 'A', role: 'administrator' }, error: null }))

    for (const event of ['TOKEN_REFRESHED', 'SIGNED_IN']) {
      act(() => mock.listener(event, { user: { id: 'A' } }))
      expect(JSON.parse(screen.getByTestId('auth').textContent)).toMatchObject({ user: 'A', role: 'administrator', loading: false })
    }

    expect(mock.from).toHaveBeenCalledTimes(1)
  })
})
