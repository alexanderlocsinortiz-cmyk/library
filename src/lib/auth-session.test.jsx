import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider, useAuth } from './auth'

const mock = vi.hoisted(() => ({ listener: null, lookups: new Map(), getSession: vi.fn(), from: vi.fn() }))
vi.mock('./supabase', () => ({
  hasSupabaseConfig: true,
  supabase: {
    auth: { getSession: mock.getSession, onAuthStateChange: (listener) => { mock.listener = listener; return { data: { subscription: { unsubscribe() {} } } } } },
    from: mock.from,
  },
}))
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
function Probe() {
  const { session, profile, loading, error } = useAuth()
  return <div data-testid="auth">{JSON.stringify({ user: session?.user?.id, role: profile?.role, loading, error })}</div>
}
beforeEach(() => {
  mock.lookups.clear()
  mock.getSession.mockResolvedValue({ data: { session: { user: { id: 'A' } } }, error: null })
  mock.from.mockImplementation(() => ({ select: () => ({ eq: (_column, id) => ({ maybeSingle: () => mock.lookups.get(id).promise }) }) }))
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
