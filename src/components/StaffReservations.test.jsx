import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ data: {}, from: vi.fn(), rpc: vi.fn() }))

vi.mock('../lib/paging', () => ({ fetchAllRows: async (query) => query() }))
vi.mock('../lib/supabase', () => ({ supabase: { from: mock.from, rpc: mock.rpc } }))
vi.mock('./ConfirmDialog', () => ({
  ConfirmDialog: ({ open, title, confirmLabel, onConfirm }) => open
    ? <div role="dialog" aria-label={title}><button type="button" data-testid="confirm-reservation-action" onClick={onConfirm}>{confirmLabel}</button></div>
    : null,
}))

import { StaffReservations } from './StaffViews'

const makeReservation = (index, status = 'waiting', overrides = {}) => ({
  id: `reservation-${index}`,
  book_id: 'book-1',
  member_id: status === 'ready_for_pickup' ? 'member-1' : null,
  borrower_type: index % 2 ? 'faculty' : 'student',
  borrower_full_name: `Borrower ${index}`,
  student_employee_id: `ID-${index}`,
  contact_number: null,
  email_address: null,
  reservation_date: `2026-09-${String(index + 1).padStart(2, '0')}`,
  expected_pickup_date: null,
  notes: null,
  status,
  created_at: `2026-09-${String(index + 1).padStart(2, '0')}T09:00:00.000Z`,
  updated_at: null,
  pickup_expires_at: status === 'ready_for_pickup' ? '2026-10-15T00:00:00.000Z' : null,
  copy_id: status === 'ready_for_pickup' ? `copy-${index}` : null,
  book_copies: status === 'ready_for_pickup' ? { barcode: `BC-${index}` } : null,
  books: { title: 'A Reserved Book', author: 'Library Author' },
  member: status === 'ready_for_pickup' ? { full_name: 'Member One', library_card_number: 'CARD-001' } : null,
  ...overrides,
})

const defaultData = () => ({
  reservations: Array.from({ length: 8 }, (_, index) => makeReservation(index)),
  library_members: [{ id: 'member-1', full_name: 'Member One', library_card_number: 'CARD-001', school_id: 'S-001', member_type: 'student' }],
  books: [{ id: 'book-1', title: 'A Reserved Book', author: 'Library Author', isbn: 'ISBN-001', course_subject: 'History', book_copies: [{ id: 'copy-1', status: 'borrowed' }] }],
})

beforeEach(() => {
  mock.data = defaultData()
  mock.rpc.mockResolvedValue({ data: null, error: null })
  mock.from.mockImplementation((table) => {
    const query = {
      select: () => query,
      eq: () => query,
      not: () => query,
      order: async () => ({ data: mock.data[table] || [], error: null }),
    }
    return query
  })
})

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('StaffReservations', () => {
  it('shows six reservations per page and reports the correct page range', async () => {
    render(<StaffReservations onBack={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: 'Manual Book Reservations' })).toBeInTheDocument()
    expect(screen.getByText('Create Walk-In Reservation')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Reservation Records' })).toBeInTheDocument()
    expect(screen.getByText(/Showing 1.*6 of 8 reservations/)).toBeInTheDocument()
    expect(screen.getByText('Borrower 5')).toBeInTheDocument()
    expect(screen.queryByText('Borrower 6')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }))

    expect(screen.getByText(/Showing 7.*8 of 8 reservations/)).toBeInTheDocument()
    expect(screen.getByText('Borrower 6')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
  })

  it('combines search, status, and borrower type filters and resets pagination', async () => {
    mock.data.reservations[7] = makeReservation(7, 'ready_for_pickup')
    render(<StaffReservations />)
    await screen.findByText('Borrower 0')
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }))

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search by borrower name, ID, or book title' }), { target: { value: 'ID-7' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter reservations by status' }), { target: { value: 'ready_for_pickup' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by borrower type' }), { target: { value: 'faculty' } })

    expect(screen.getByText('Borrower 7')).toBeInTheDocument()
    expect(within(screen.getByText('Borrower 7').closest('tr')).getByText('Ready for Pickup')).toBeInTheDocument()
    expect(screen.getByText('1 matching reservation')).toBeInTheDocument()
    expect(screen.getByText(/Showing 1.*1 of 1 reservation/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear Filters' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Clear Filters' }))
    expect(screen.getByRole('searchbox', { name: 'Search by borrower name, ID, or book title' })).toHaveValue('')
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Filter reservations by status' })).toHaveValue('all'))
    expect(screen.getByRole('combobox', { name: 'Filter by borrower type' })).toHaveValue('all')
    expect(screen.getByText(/Showing 1.*6 of 8 reservations/)).toBeInTheDocument()
  })

  it('creates a walk-in reservation with no member ID and clears the form after success', async () => {
    render(<StaffReservations />)
    await screen.findByRole('heading', { name: 'Create Walk-In Reservation' })
    expect(screen.getByText('Walk-in reservations can be created without a library account.')).toBeInTheDocument()
    const submit = screen.getByRole('button', { name: 'Save Reservation' })
    expect(submit).toBeDisabled()

    fireEvent.change(screen.getByRole('combobox', { name: 'Borrower type' }), { target: { value: 'visitor' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Full name' }), { target: { value: 'Walk-In Guest' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Student or employee ID' }), { target: { value: 'VIS-001' } })
    const bookInput = screen.getByRole('combobox', { name: 'Select Book' })
    fireEvent.focus(bookInput)
    fireEvent.click(await screen.findByRole('option', { name: /A Reserved Book/ }))
    expect(screen.getByRole('spinbutton', { name: 'Available copies' })).toHaveValue(0)
    expect(submit).toBeEnabled()
    fireEvent.click(submit)

    await waitFor(() => expect(mock.rpc).toHaveBeenCalledWith('staff_create_reservation', expect.objectContaining({
      p_book_id: 'book-1',
      p_member_id: null,
      p_borrower_type: 'visitor',
      p_borrower_full_name: 'Walk-In Guest',
      p_student_employee_id: 'VIS-001',
      p_reservation_date: expect.any(String),
      p_expected_pickup_date: null,
    })))
    expect(await screen.findByText('Book reservation created successfully.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Select Book' })).toHaveValue(''))
    expect(screen.getByRole('textbox', { name: 'Full name' })).toHaveValue('')
    expect(screen.getByRole('combobox', { name: 'Registered member' })).toHaveValue('')
  })

  it('offers available and borrowed titles, shows actual available-copy counts, and excludes unusable inventory', async () => {
    mock.data.books = [
      { id: 'book-available', title: 'Available Title', author: 'Author One', book_copies: [
        { id: 'available-1', status: 'available' }, { id: 'borrowed-1', status: 'borrowed' },
      ] },
      { id: 'book-borrowed', title: 'Borrowed Title', author: 'Author Two', book_copies: [
        { id: 'borrowed-2', status: 'overdue' },
      ] },
      { id: 'book-unusable', title: 'Unusable Title', author: 'Author Three', book_copies: [
        { id: 'damaged-1', status: 'damaged' },
      ] },
      { id: 'book-no-copies', title: 'No Copies Title', author: 'Author Four', book_copies: [] },
    ]
    render(<StaffReservations />)
    await screen.findByRole('heading', { name: 'Create Walk-In Reservation' })
    await screen.findByText('Borrower 0')

    const picker = screen.getByRole('combobox', { name: 'Select Book' })
    fireEvent.focus(picker)
    const availableOption = await screen.findByRole('option', { name: /Available Title/ })
    expect(within(availableOption).getByText('1 available')).toBeInTheDocument()
    const borrowedOption = screen.getByRole('option', { name: /Borrowed Title/ })
    expect(within(borrowedOption).getByText('0 available')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Unusable Title/ })).toBeDisabled()
    expect(screen.getByRole('option', { name: /No Copies Title/ })).toBeDisabled()

    fireEvent.click(screen.getByRole('option', { name: /Available Title/ }))
    expect(screen.getByRole('spinbutton', { name: 'Available copies' })).toHaveValue(1)
    fireEvent.change(screen.getByRole('textbox', { name: 'Full name' }), { target: { value: 'Walk-In Borrower' } })
    expect(screen.getByRole('button', { name: 'Save Reservation' })).toBeEnabled()

    fireEvent.change(picker, { target: { value: 'Borrowed Title' } })
    const borrowedOnlyOption = await screen.findByRole('option', { name: /Borrowed Title/ })
    expect(within(borrowedOnlyOption).getByText('0 available')).toBeInTheDocument()
    fireEvent.click(borrowedOnlyOption)
    expect(screen.getByRole('spinbutton', { name: 'Available copies' })).toHaveValue(0)
  })

  it('shows catalog titles with no copies as unselectable instead of implying inventory exists', async () => {
    mock.data.books = [{ id: 'book-no-copies', title: 'Catalog Only Title', author: 'Author', book_copies: [] }]
    render(<StaffReservations />)
    await screen.findByText('Borrower 0')

    fireEvent.focus(screen.getByRole('combobox', { name: 'Select Book' }))
    expect(screen.getByRole('option', { name: /Catalog Only Title.*No copies recorded/ })).toBeDisabled()
    expect(screen.getByText('No titles have an available or circulating physical copy. Register or check in a physical copy to enable reservations.')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'Full name' }), { target: { value: 'Walk-In Borrower' } })
    expect(screen.getByRole('button', { name: 'Save Reservation' })).toBeDisabled()
  })

  it('can autofill an optional registered member and clear those details', async () => {
    render(<StaffReservations />)
    await screen.findByText('Borrower 0')

    fireEvent.change(screen.getByRole('combobox', { name: 'Registered member' }), { target: { value: 'member-1' } })
    expect(screen.getByRole('textbox', { name: 'Full name' })).toHaveValue('Member One')
    expect(screen.getByRole('textbox', { name: 'Student or employee ID' })).toHaveValue('S-001')
    expect(screen.getByRole('combobox', { name: 'Borrower type' })).toHaveValue('student')

    fireEvent.change(screen.getByRole('textbox', { name: 'Full name' }), { target: { value: 'Different Walk-In' } })
    expect(screen.getByRole('combobox', { name: 'Registered member' })).toHaveValue('')
  })

  it('runs queue allocation and cancellation through the established RPCs', async () => {
    mock.data.books[0].book_copies = [{ id: 'copy-1', status: 'available' }]
    render(<StaffReservations />)
    await screen.findByText('Borrower 0')

    fireEvent.click(screen.getByRole('button', { name: 'Mark Ready for Pickup' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('confirm-reservation-action'))
    await waitFor(() => expect(mock.rpc).toHaveBeenCalledWith('promote_next_reservation', { p_book_id: 'book-1' }))

    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel Reservation' })[0])
    fireEvent.click(screen.getByTestId('confirm-reservation-action'))
    await waitFor(() => expect(mock.rpc).toHaveBeenCalledWith('cancel_reservation', { p_reservation_id: 'reservation-0' }))
  })

  it('completes a ready reservation only through the existing checkout process', async () => {
    mock.data.reservations[0] = makeReservation(0, 'ready_for_pickup')
    render(<StaffReservations />)
    await screen.findByText('Borrower 0')
    fireEvent.click(screen.getByRole('button', { name: 'Complete Reservation' }))
    fireEvent.click(screen.getByTestId('confirm-reservation-action'))
    await waitFor(() => expect(mock.rpc).toHaveBeenCalledWith('checkout_copy', { p_copy_id: 'copy-0', p_member_id: 'member-1' }))
  })

  it('shows distinct empty states for an empty queue and search with no results', async () => {
    mock.data.reservations = []
    const { unmount } = render(<StaffReservations />)
    expect(await screen.findByText('No reservations yet')).toBeInTheDocument()
    expect(screen.getByText('Reservations created by library staff will appear here.')).toBeInTheDocument()

    mock.data.reservations = [makeReservation(0, 'completed')]
    unmount()
    render(<StaffReservations />)
    await waitFor(() => expect(screen.queryByText('Borrower 0')).not.toBeInTheDocument())
    expect(screen.getByText('No matching reservations')).toBeInTheDocument()
    expect(screen.getByText('Try changing your search or filters.')).toBeInTheDocument()
  })
})
