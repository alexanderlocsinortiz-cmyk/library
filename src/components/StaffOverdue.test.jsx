import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ loans: [], from: vi.fn(), rpc: vi.fn() }))

vi.mock('../lib/paging', () => ({ fetchAllRows: async (query) => query() }))
vi.mock('../lib/supabase', () => ({ supabase: { from: mock.from, rpc: mock.rpc } }))
vi.mock('./SchoolInvitations', () => ({ SchoolInvitations: () => null }))

import { StaffOverdue } from './StaffViews'

const makeLoan = (index, daysOverdue, fine = daysOverdue, overrides = {}) => ({
  id: `loan-${index}`,
  status: 'overdue',
  checked_out_at: new Date(Date.now() - (daysOverdue + 5) * 86400000).toISOString(),
  due_at: new Date(Date.now() - daysOverdue * 86400000).toISOString(),
  fine_amount: fine,
  book_copies: { barcode: `BC-${index}`, books: { title: `Book ${index}` } },
  member: { full_name: `Borrower ${index}`, library_card_number: `CARD-${index}`, school_id: `SCHOOL-${index}` },
  ...overrides,
})

const defaultLoans = () => [
  makeLoan(1, 1, 0),
  makeLoan(2, 3),
  makeLoan(3, 6),
  makeLoan(4, 9),
  makeLoan(5, 15),
  makeLoan(6, 25),
  makeLoan(7, 40),
  makeLoan(8, -1, 100),
]

beforeEach(() => {
  mock.loans = defaultLoans()
  mock.rpc.mockResolvedValue({ data: null, error: null })
  mock.from.mockImplementation((table) => {
    const query = {
      select: () => query,
      eq: () => query,
      lt: () => query,
      order: async () => ({ data: table === 'loans' ? mock.loans : [], error: null }),
    }
    return query
  })
})

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('StaffOverdue', () => {
  it('loads current overdue loans, totals database fines, and paginates six records', async () => {
    const onBack = vi.fn()
    render(<StaffOverdue onBack={onBack} />)

    expect(await screen.findByRole('heading', { name: 'Overdue Records' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Overdue Books' })).toBeInTheDocument()
    expect(screen.getByText('7', { selector: '.overdue-summary-card strong' })).toBeInTheDocument()
    const fineTotal = document.querySelectorAll('.overdue-summary-card strong')[2]
    expect(fineTotal.textContent).toBe(new Intl.NumberFormat(undefined, { style: 'currency', currency: 'PHP' }).format(98))
    expect(screen.getByText(/Showing 1.*6 of 7 overdue records/)).toBeInTheDocument()
    expect(screen.getByText('Book 7')).toBeInTheDocument()
    expect(screen.queryByText('Book 1')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
    expect(mock.rpc).toHaveBeenCalledWith('refresh_circulation_statuses')

    fireEvent.click(screen.getByRole('button', { name: /Back to Dashboard/ }))
    expect(onBack).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }))

    expect(screen.getByText(/Showing 7.*7 of 7 overdue records/)).toBeInTheDocument()
    expect(screen.getByText('Book 1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
  })

  it('combines search with overdue duration and clears filters back to page one', async () => {
    render(<StaffOverdue />)
    await screen.findByRole('heading', { name: 'Overdue Records' })
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }))

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by overdue duration' }), { target: { value: 'month' } })
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search overdue books' }), { target: { value: 'Book 4' } })

    expect(screen.getByText('Book 4')).toBeInTheDocument()
    expect(screen.getByText(/Showing 1.*1 of 1 overdue record/)).toBeInTheDocument()
    expect(screen.queryByText('Book 5')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Clear Filters' }))
    expect(screen.getByRole('searchbox', { name: 'Search overdue books' })).toHaveValue('')
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Filter by overdue duration' })).toHaveValue('all'))
    expect(screen.getByText(/Showing 1.*6 of 7 overdue records/)).toBeInTheDocument()
  })

  it('shows transaction details without exposing account credentials', async () => {
    render(<StaffOverdue />)
    await screen.findByRole('heading', { name: 'Overdue Records' })
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }))
    fireEvent.click(within(screen.getByText('Book 1').closest('tr')).getByRole('button', { name: 'View Details' }))

    const dialog = screen.getByRole('dialog', { name: 'Book 1' })
    expect(within(dialog).getByText('CARD-1')).toBeInTheDocument()
    expect(within(dialog).getByText('SCHOOL-1')).toBeInTheDocument()
    expect(within(dialog).getByText('No fine')).toBeInTheDocument()
    expect(within(dialog).queryByText(/password|credential|session/i)).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close overdue details' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows the compact empty state when there are no overdue records', async () => {
    mock.loans = [makeLoan(1, -2, 0, { status: 'borrowed' })]
    render(<StaffOverdue />)

    expect(await screen.findByText('No overdue books')).toBeInTheDocument()
    expect(screen.getByText('All borrowed books are currently within their borrowing period.')).toBeInTheDocument()
    expect(screen.getByText('0', { selector: '.overdue-summary-card strong' })).toBeInTheDocument()
  })
})
