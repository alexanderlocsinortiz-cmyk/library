import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ data: {}, from: vi.fn(), rpc: vi.fn(), single: { data: null, error: null }, refreshError: null }))

vi.mock('../lib/paging', () => ({ fetchAllRows: async (query) => query() }))
vi.mock('../lib/supabase', () => ({ supabase: { from: mock.from, rpc: mock.rpc } }))
vi.mock('./CirculationHealth', () => ({ CirculationHealth: () => null }))
vi.mock('./ConfirmDialog', () => ({ ConfirmDialog: () => null }))
vi.mock('@mui/material', () => ({
  Dialog: ({ open, children, ...props }) => open ? <div role="dialog" aria-labelledby={props['aria-labelledby']}>{children}</div> : null,
  DialogContent: ({ children }) => <div>{children}</div>,
  DialogTitle: ({ children, id }) => <h2 id={id}>{children}</h2>,
}))

import { StaffCirculation } from './StaffTools'

const makeLoan = (index, status = 'borrowed') => ({
  id: `loan-${index}`,
  status,
  checked_out_at: `2026-10-0${(index % 8) + 1}T09:00:00.000Z`,
  due_at: '2026-10-20T09:00:00.000Z',
  fine_amount: 0,
  book_copies: { barcode: `BC-${index}`, books: { title: `Book ${index}` } },
  member: { full_name: 'Member One', library_card_number: 'CARD-001', school_id: 'S-001' },
})

const defaultData = () => ({
  library_members: [
    { id: 'member-1', full_name: 'Member One', library_card_number: 'CARD-001', school_id: 'S-001', is_active: true },
    { id: 'member-2', full_name: 'Needs Card', library_card_number: '  ', school_id: null, is_active: true },
    { id: 'member-3', full_name: 'Inactive Member', library_card_number: 'CARD-003', school_id: null, is_active: false },
  ],
  book_copies: [
    { id: 'copy-1', barcode: 'COPY-001', location: 'General Circulation', status: 'available', books: { title: 'Computer Networks' } },
    { id: 'copy-2', barcode: 'COPY-002', location: 'General Circulation', status: 'reserved', books: { title: 'Reserved Title' } },
  ],
  loans: Array.from({ length: 8 }, (_, index) => makeLoan(index, index === 7 ? 'overdue' : 'borrowed')),
})

beforeEach(() => {
  mock.data = defaultData()
  mock.single = { data: { id: 'new-loan', due_at: '2026-10-23T09:00:00.000Z' }, error: null }
  mock.refreshError = null
  mock.rpc.mockImplementation(async (name) => {
    if (name === 'refresh_circulation_statuses') return { data: null, error: mock.refreshError }
    if (name === 'get_circulation_policy') return { data: { loan_period_days: 14, max_active_loans: 5, due_soon_days: 2, max_renewals: 1, pickup_hold_days: 2, fine_per_day: 1, notifications_enabled: true }, error: null }
    if (name === 'checkout_copy') return { data: 'new-loan', error: null }
    return { data: null, error: null }
  })
  mock.from.mockImplementation((table) => {
    const query = {
      select: () => query,
      in: () => query,
      eq: () => query,
      order: async () => ({ data: mock.data[table] || [], error: null }),
      single: async () => mock.single,
    }
    return query
  })
})

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('StaffCirculation', () => {
  it('explains an empty member directory without substituting School ID or account verification', async () => {
    mock.data.library_members = []
    mock.data.book_copies = []
    mock.data.loans = []
    render(<StaffCirculation />)

    expect(await screen.findByText(/No library member records exist yet/)).toBeInTheDocument()
    expect(screen.getByText('Active members').parentElement).toHaveTextContent('0')
    expect(screen.getByRole('button', { name: 'Check Out Book' })).toBeDisabled()
  })

  it('does not report an empty directory when circulation loading failed', async () => {
    mock.refreshError = { message: 'refresh failed' }
    render(<StaffCirculation />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Circulation refresh failed')
    expect(screen.queryByText(/No library member records exist yet/)).not.toBeInTheDocument()
    expect(screen.getByText('Active members').parentElement).toHaveTextContent('—')
  })

  it('filters open loans, paginates six records, and shows borrowing details', async () => {
    render(<StaffCirculation />)

    expect(await screen.findByText('Book 0')).toBeInTheDocument()
    expect(screen.getByText(/Showing 1.*6 of 8 records/)).toBeInTheDocument()
    expect(screen.queryByText('Book 6')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }))
    expect(await screen.findByText('Book 6')).toBeInTheDocument()
    expect(screen.getByText(/Showing 7.*8 of 8 records/)).toBeInTheDocument()

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter borrowed books by status' }), { target: { value: 'overdue' } })
    expect(await screen.findByText('Book 7')).toBeInTheDocument()
    expect(screen.queryByText('Book 6')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'View Details' }))
    const dialog = screen.getByRole('dialog', { name: 'Borrowing details' })
    expect(within(dialog).getByText('Book 7')).toBeInTheDocument()
    expect(within(dialog).getByText('Member One')).toBeInTheDocument()
  })

  it('uses scanned card and copy barcodes, then calls the existing checkout RPC', async () => {
    render(<StaffCirculation />)
    await screen.findByText('Active members')

    fireEvent.change(screen.getByRole('searchbox', { name: 'Find member by name, card, or School ID' }), { target: { value: 'CARD-001' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Scan or enter copy barcode' }), { target: { value: 'copy-001' } })
    expect(screen.getByText('Computer Networks')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Check Out Book' }))

    expect(await screen.findByText('Checkout receipt')).toBeInTheDocument()
    expect(mock.rpc).toHaveBeenCalledWith('checkout_copy', { p_copy_id: 'copy-1', p_member_id: 'member-1' })
  })

  it('matches a scanned return barcode and calls the existing return RPC', async () => {
    render(<StaffCirculation />)
    await screen.findByText('Book 0')

    fireEvent.change(screen.getByRole('textbox', { name: 'Copy barcode' }), { target: { value: 'bc-0' } })
    expect(screen.getByText('Active checkout found')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Return scanned copy' }))

    await screen.findByText(/Book returned/)
    expect(mock.rpc).toHaveBeenCalledWith('return_loan', { p_loan_id: 'loan-0' })
  })
})
