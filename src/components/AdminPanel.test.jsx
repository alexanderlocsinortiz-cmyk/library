import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mock = vi.hoisted(() => ({
  profiles: [],
  profileError: false,
  rpcError: false,
  from: vi.fn(),
  rpc: vi.fn(),
}))

vi.mock('../lib/supabase', () => ({ supabase: { from: mock.from, rpc: mock.rpc } }))
vi.mock('../lib/paging', () => ({ fetchAllRows: (makeQuery) => makeQuery() }))
vi.mock('./CirculationHealth', () => ({ CirculationHealth: () => null }))
vi.mock('./ConfirmDialog', () => ({
  ConfirmDialog: ({ open, title, description, confirmLabel, onCancel, onConfirm }) => open ? <div role="alertdialog" aria-label={title}><h2>{title}</h2><p>{description}</p><button onClick={onCancel}>Cancel</button><button onClick={onConfirm}>{confirmLabel}</button></div> : null,
}))
vi.mock('@mui/material', () => ({
  Dialog: ({ open, children, ...props }) => open ? <div role="dialog" aria-labelledby={props['aria-labelledby']}>{children}</div> : null,
  DialogContent: ({ children }) => <div>{children}</div>,
  DialogTitle: ({ children, id }) => <h2 id={id}>{children}</h2>,
  Menu: ({ open, children }) => open ? <div role="menu">{children}</div> : null,
  MenuItem: ({ children, disabled, onClick, ...props }) => <button role="menuitem" disabled={disabled} onClick={onClick} {...props}>{children}</button>,
}))

import { AdminPanel } from './StaffTools'

function makeProfiles(count = 7) {
  return Array.from({ length: count }, (_, index) => ({
    id: `user-${index + 1}`,
    full_name: `Account ${String(index + 1).padStart(2, '0')}`,
    school_id: index === 0 ? 'IBA-001' : null,
    registration_school_id: index === 0 ? null : `IBA-${String(index + 1).padStart(3, '0')}`,
    role: index === 0 ? 'administrator' : index === 1 ? 'librarian' : 'member',
    created_at: '2026-10-01T00:00:00.000Z',
    email: `account${index + 1}@iba.edu`,
    email_confirmed_at: index === 0 ? '2026-10-01T00:00:00.000Z' : null,
    last_sign_in_at: index === 0 ? '2026-10-08T00:00:00.000Z' : null,
    account_active: true,
  }))
}

beforeEach(() => {
  mock.profiles = makeProfiles()
  mock.profileError = false
  mock.rpcError = false
  mock.from.mockImplementation((table) => {
    if (table === 'library_members') {
      const query = { eq: () => query, not: () => query, order: async () => ({ data: [], error: null }) }
      return { select: () => query }
    }
    return { select: () => ({ in: async () => ({ data: [], error: null }) }) }
  })
  mock.rpc.mockImplementation(async (name) => {
    if (name === 'admin_user_management_rows') return mock.profileError
      ? { data: null, error: { message: 'permission denied', code: '42501' } }
      : { data: mock.profiles, error: null }
    if (name === 'admin_member_verification_requests' && mock.rpcError) return { data: null, error: { message: 'function unavailable', code: 'PGRST202' } }
    return { data: [], error: null }
  })
})

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('AdminPanel user management', () => {
  it('navigates the four settings tabs with accessible keyboard controls', async () => {
    render(<AdminPanel />)
    expect(await screen.findByText('7 accounts')).toBeInTheDocument()

    const accountsTab = screen.getByRole('tab', { name: 'Accounts & Access' })
    const circulationTab = screen.getByRole('tab', { name: 'Circulation Policy' })
    fireEvent.keyDown(accountsTab, { key: 'ArrowRight' })
    expect(circulationTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Fine per overdue day')

    fireEvent.click(screen.getByRole('tab', { name: 'Registration & Verification' }))
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Required for new member accounts')
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Minutes to complete email verification')

    fireEvent.click(screen.getByRole('tab', { name: 'Scheduled Circulation' }))
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Background processing')
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Scheduled circulation')
    expect(accountsTab).toHaveAttribute('aria-selected', 'false')
  })

  it('filters accounts by role and email status, paginates, and shows safe user details', async () => {
    render(<AdminPanel />)

    expect(await screen.findByText('7 accounts')).toBeInTheDocument()
    expect(screen.getAllByRole('row')).toHaveLength(7) // header plus six account rows
    expect(screen.getByText(/Showing 1–6 of 7 users/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findAllByText('Account 07')).toHaveLength(2)
    expect(screen.queryByText('Account 01')).not.toBeInTheDocument()

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search users' }), { target: { value: 'account2@iba.edu' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Role' }), { target: { value: 'librarian' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Email verification' }), { target: { value: 'pending' } })
    expect(screen.getAllByText('Account 02')).toHaveLength(2)
    expect(screen.getAllByRole('row')[1].querySelector('td:nth-child(3)')).toHaveTextContent('Pending')
    fireEvent.click(screen.getAllByRole('button', { name: 'View Account 02 details' })[0])
    expect(screen.getByRole('dialog', { name: 'User details' })).toBeInTheDocument()
    expect(screen.getByText('user-2')).toBeInTheDocument()
    expect(screen.getAllByText('account2@iba.edu')).toHaveLength(3)

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    await waitFor(() => expect(screen.getByText(/Showing 1–6 of 7 users/)).toBeInTheDocument())
  })

  it('does not show zero totals after the admin RPC fails and Try Again reloads', async () => {
    mock.profileError = true
    render(<AdminPanel />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load users')
    expect(screen.queryByText('0')).not.toBeInTheDocument()

    mock.profileError = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('7 accounts')).toBeInTheDocument()
  })

  it('does not load or display student identity review for email-only accounts', async () => {
    mock.rpcError = true
    render(<AdminPanel />)

    expect(await screen.findByText('7 accounts')).toBeInTheDocument()
    expect(mock.rpc).toHaveBeenCalledWith('admin_user_management_rows')
    expect(mock.rpc).not.toHaveBeenCalledWith('admin_member_verification_requests')
    expect(screen.queryByText('Identity verification assistance')).not.toBeInTheDocument()
    const userRows = screen.getAllByRole('row').slice(1)
    expect(userRows).toHaveLength(6)
    expect(userRows[0].querySelector('td:nth-child(3)')?.textContent).toBe('Verified')
    expect(userRows.slice(1).every((row) => row.querySelector('td:nth-child(3)')?.textContent === 'Pending')).toBe(true)
    expect(screen.getAllByText('Account 01')).toHaveLength(2)
  })

  it('offers a compact actions menu and prevents deleting the only active administrator', async () => {
    render(<AdminPanel userId="user-2" />)

    fireEvent.click((await screen.findAllByRole('button', { name: 'More actions for Account 01' }))[0])
    expect(screen.getByRole('menuitem', { name: 'Delete Account' })).toBeDisabled()

    fireEvent.click(screen.getAllByRole('button', { name: 'More actions for Account 02' })[0])
    expect(screen.getByRole('menuitem', { name: 'Delete Account' })).toBeDisabled()

    fireEvent.click(screen.getAllByRole('button', { name: 'More actions for Account 03' })[0])
    expect(screen.getByRole('menuitem', { name: 'Delete Account' })).toBeEnabled()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete Account' }))
    expect(screen.getByRole('alertdialog', { name: 'Delete this sign-in account?' })).toBeInTheDocument()
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Activity logs, library member records, borrowing history, and reservations are retained')
  })
})
