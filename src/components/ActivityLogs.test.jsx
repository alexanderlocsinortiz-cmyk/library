import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActivityLogs } from './ActivityLogs'

const mock = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../lib/supabase', () => ({ supabase: { rpc: mock.rpc } }))

function responseFor(page) {
  const firstIndex = page * 10
  const count = page === 0 ? 10 : 1
  return {
    total: 11,
    page,
    page_size: 10,
    summary: { total: 31, today: 4, successful_logins: 8, failed_logins: 2 },
    roles: ['administrator', 'librarian'],
    modules: ['books', 'authentication'],
    actions: ['book_added', 'login_success', 'failed_login'],
    records: Array.from({ length: count }, (_, offset) => ({
      id: `activity-${firstIndex + offset + 1}`,
      actor_user_id: 'user-1',
      actor_name_snapshot: 'Library Staff',
      actor_role_snapshot: 'librarian',
      action: 'book_added',
      module: 'books',
      description: 'Added a book.',
      entity_type: 'book',
      entity_id: `book-${firstIndex + offset + 1}`,
      status: 'success',
      old_values: null,
      new_values: { title: 'Sample title', password: 'never display this' },
      ip_address: null,
      created_at: '2026-10-08T04:00:00.000Z',
    })),
  }
}

beforeEach(() => {
  mock.rpc.mockImplementation((_name, args) => Promise.resolve({ data: responseFor(args.p_page), error: null }))
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('ActivityLogs', () => {
  it('combines filters, requests ten-row pages, and hides sensitive detail keys', async () => {
    render(<ActivityLogs />)
    await screen.findByText('Activity history')
    expect(await screen.findByText('Showing 1–10 of 11 activities')).toBeInTheDocument()
    expect(screen.getByText('31')).toBeInTheDocument()
    expect(screen.getAllByRole('row')).toHaveLength(11)

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search user or activity' }), { target: { value: 'Library Staff' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'User role' }), { target: { value: 'librarian' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Module' }), { target: { value: 'books' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Activity type' }), { target: { value: 'book_added' } })
    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-10-01' } })
    fireEvent.change(screen.getByLabelText('To date'), { target: { value: '2026-10-08' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'failure' } })
    await waitFor(() => expect(mock.rpc).toHaveBeenLastCalledWith('admin_activity_logs', expect.objectContaining({
      p_search: 'Library Staff',
      p_role: 'librarian',
      p_module: 'books',
      p_action: 'book_added',
      p_start_date: '2026-10-01',
      p_end_date: '2026-10-08',
      p_status: 'failure',
      p_page: 0,
    })))

    fireEvent.click(screen.getAllByRole('button', { name: 'View details' })[0])
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Sample title')).toBeInTheDocument()
    expect(screen.queryByText('never display this')).not.toBeInTheDocument()
  }, 10000)

  it('uses backend pagination and renders the active page', async () => {
    render(<ActivityLogs />)
    await screen.findByText('Showing 1–10 of 11 activities')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(mock.rpc).toHaveBeenLastCalledWith('admin_activity_logs', expect.objectContaining({ p_page: 1 })))
    expect(await screen.findByText('Showing 11–11 of 11 activities')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '2' })).toHaveAttribute('aria-current', 'page')
  })
})
