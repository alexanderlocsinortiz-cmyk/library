import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TransactionHistory } from './TransactionHistory'

const mock = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../lib/supabase', () => ({ supabase: { rpc: mock.rpc } }))

function transaction(id, overrides = {}) {
  return {
    transaction_id: `transaction-${id}`,
    action: 'cancel',
    transaction_at: '2026-10-09T03:25:00.000Z',
    entity_type: 'reservation',
    entity_id: `reservation-${id}`,
    member_name: 'Sander Ortiz',
    verified_school_id: null,
    book_title: 'Criminal Justice: A Brief Introduction',
    barcode: 'IBA-000123',
    internal_copy_id: 'd3082d6a-122d-45a9-9f1a-837112d0d87e',
    actor_id: 'member-user',
    actor_name: 'Sander Ortiz',
    actor_type: 'member_self_service',
    current_record_status: 'cancelled',
    reservation_date: '2026-10-08',
    queue_position: null,
    pickup_deadline: null,
    pickup_deadline_is_current: false,
    reservation_status: 'cancelled',
    reservation_status_is_current: true,
    cancellation_date: '2026-10-09T03:25:00.000Z',
    cancellation_reason: null,
    cancellation_actor_name: 'Sander Ortiz',
    cancellation_actor_type: 'member_self_service',
    ...overrides,
  }
}

const records = [
  transaction('1'),
  transaction('2', {
    action: 'checkout',
    entity_type: 'loan',
    entity_id: 'loan-2',
    actor_name: 'Temporary Administrator',
    actor_type: 'administrator',
    current_record_status: 'borrowed',
    checkout_date: '2026-10-09T03:20:00.000Z',
    due_date: '2026-10-12T03:20:00.000Z',
    due_date_is_current: false,
    return_status: 'borrowed',
    reservation_date: null,
    reservation_status: null,
  }),
  ...Array.from({ length: 6 }, (_, index) => transaction(String(index + 3))),
]

function responseFor(args) {
  const filtered = args.p_action ? records.filter((record) => record.action === args.p_action) : records
  const start = args.p_page * 6
  const items = filtered.slice(start, start + 6)
  return { total: filtered.length, page: args.p_page, page_size: args.p_size, items }
}

beforeEach(() => {
  mock.rpc.mockImplementation((_name, args) => Promise.resolve({ data: responseFor(args), error: null }))
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('TransactionHistory', () => {
  it('loads six rows and expands complete, correctly labeled cancellation details', async () => {
    render(<TransactionHistory />)

    expect(await screen.findByText('Showing 1-6 of 8 transactions')).toBeInTheDocument()
    expect(screen.getAllByRole('row')).toHaveLength(7)
    expect(mock.rpc).toHaveBeenLastCalledWith('transaction_history', expect.objectContaining({
      p_page: 0,
      p_size: 6,
      p_action: '',
      p_sort: 'newest',
    }))

    const firstRow = screen.getAllByRole('row')[1]
    expect(firstRow).toHaveTextContent('Member (Self-Service)')
    expect(firstRow).not.toHaveTextContent('Staff')
    fireEvent.click(firstRow.querySelector('button'))

    expect(await screen.findByText('transaction-1')).toBeInTheDocument()
    expect(await screen.findByText('Cancellation reason')).toBeInTheDocument()
    expect(screen.getByText('Copy barcode')).toBeInTheDocument()
    expect(screen.getByText('Internal Copy ID')).toBeInTheDocument()
    expect(screen.getByText('IBA-000123')).toBeInTheDocument()
    expect(screen.getByText('d3082d6a-122d-45a9-9f1a-837112d0d87e')).toBeInTheDocument()
    expect(screen.getByText('Cancellation performed by')).toBeInTheDocument()
    expect(screen.queryByText('UNVERIFIED-SCHOOL-ID')).not.toBeInTheDocument()
  })

  it('filters by action, sorts chronologically, and paginates on the server', async () => {
    render(<TransactionHistory />)
    await screen.findByText('Showing 1-6 of 8 transactions')

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by action' }), { target: { value: 'cancel' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort transactions by date' }), { target: { value: 'oldest' } })
    await waitFor(() => expect(mock.rpc).toHaveBeenLastCalledWith('transaction_history', expect.objectContaining({
      p_page: 0,
      p_size: 6,
      p_action: 'cancel',
      p_sort: 'oldest',
    })))
    expect(await screen.findByText('Showing 1-6 of 7 transactions')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(mock.rpc).toHaveBeenLastCalledWith('transaction_history', expect.objectContaining({
      p_page: 1,
      p_size: 6,
      p_action: 'cancel',
      p_sort: 'oldest',
    })))
    expect(await screen.findByText('Showing 7-7 of 7 transactions')).toBeInTheDocument()
  })
})
