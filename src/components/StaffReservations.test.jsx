import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ data: {}, from: vi.fn(), rpc: vi.fn(), unsupportedApprovalFields: false }))

vi.mock('../lib/paging', () => ({ fetchAllRows: async (query) => query() }))
vi.mock('../lib/supabase', () => ({ supabase: { from: mock.from, rpc: mock.rpc } }))
vi.mock('./ConfirmDialog', () => ({
  ConfirmDialog: ({ open, title, description, confirmLabel, onConfirm, onCancel }) => open
    ? <div role="dialog" aria-label={title}><p>{description}</p><button type="button" onClick={onCancel}>Back</button><button type="button" data-testid="confirm-reservation-action" onClick={onConfirm}>{confirmLabel}</button></div>
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
  pickup_expires_at: null,
  staff_approved_at: null,
  pickup_confirmed_at: null,
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
  mock.unsupportedApprovalFields = false
  mock.rpc.mockResolvedValue({ data: null, error: null })
  mock.from.mockImplementation((table) => {
    let selectedColumns = ''
    const query = {
      select: (columns) => { selectedColumns = columns; return query },
      eq: () => query,
      not: () => query,
      order: async () => ({
        data: mock.data[table] || [],
        error: table === 'reservations' && mock.unsupportedApprovalFields && selectedColumns.includes('staff_approved_at')
          ? { message: "Could not find the 'staff_approved_at' column of 'reservations' in the schema cache" }
          : null,
      }),
    }
    return query
  })
})

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('StaffReservations', () => {
  it('shows six reservations per page and reports the correct page range', async () => {
    const onBack = vi.fn()
    render(<StaffReservations onBack={onBack} />)

    expect(await screen.findByRole('heading', { name: 'Manual Book Reservations' })).toBeInTheDocument()
    expect(screen.getByText('Create Walk-In Reservation')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Reservation Records' })).toBeInTheDocument()
    expect(screen.getByText(/Showing 1.*6 of 8 reservations/)).toBeInTheDocument()
    expect(screen.getByText('Borrower 5')).toBeInTheDocument()
    expect(screen.queryByText('Borrower 6')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Back to Dashboard' }))
    expect(onBack).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }))

    expect(screen.getByText(/Showing 7.*8 of 8 reservations/)).toBeInTheDocument()
    expect(screen.getByText('Borrower 6')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
  })

  it('combines search, status, and borrower type filters and resets pagination', async () => {
    mock.data.reservations[7] = makeReservation(7, 'ready_for_pickup', { staff_approved_at: '2026-10-09T08:00:00.000Z', pickup_confirmed_at: '2026-10-09T09:00:00.000Z', pickup_expires_at: '2026-10-15T00:00:00.000Z' })
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
    expect(screen.queryByLabelText('Search registered members')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Registered member')).not.toBeInTheDocument()
    const submit = screen.getByRole('button', { name: 'Save Reservation' })
    expect(submit).toBeDisabled()

    fireEvent.change(screen.getByRole('combobox', { name: 'Borrower type' }), { target: { value: 'visitor' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Full name' }), { target: { value: 'Walk-In Guest' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Student or employee ID' }), { target: { value: 'VIS-001' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Contact number' }), { target: { value: '+63 912 345 6789' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Email address' }), { target: { value: 'guest@example.edu' } })
    const bookInput = screen.getByRole('combobox', { name: 'Select Book' })
    fireEvent.focus(bookInput)
    fireEvent.click(await screen.findByRole('option', { name: /A Reserved Book/ }))
    expect(screen.getByRole('spinbutton', { name: 'Available copies' })).toHaveValue(0)
    fireEvent.change(screen.getByLabelText('Reservation date'), { target: { value: '2026-10-08' } })
    fireEvent.change(screen.getByLabelText('Expected pickup date'), { target: { value: '2026-10-09' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Reservation notes' }), { target: { value: 'Please call on arrival.' } })
    expect(submit).toBeEnabled()
    fireEvent.click(submit)

    await waitFor(() => expect(mock.rpc).toHaveBeenCalledWith('staff_create_reservation', expect.objectContaining({
      p_book_id: 'book-1',
      p_member_id: null,
      p_borrower_type: 'visitor',
      p_borrower_full_name: 'Walk-In Guest',
      p_student_employee_id: 'VIS-001',
      p_contact_number: '+63 912 345 6789',
      p_email_address: 'guest@example.edu',
      p_reservation_date: '2026-10-08',
      p_expected_pickup_date: '2026-10-09',
      p_notes: 'Please call on arrival.',
    })))
    expect(await screen.findByText('Reservation created and approved by staff. Confirm the assigned copy is ready before pickup.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Select Book' })).toHaveValue(''))
    expect(screen.getByRole('textbox', { name: 'Full name' })).toHaveValue('')
    expect(screen.getByRole('textbox', { name: 'Contact number' })).toHaveValue('')
    expect(screen.getByRole('textbox', { name: 'Email address' })).toHaveValue('')
    expect(screen.getByLabelText('Expected pickup date')).toHaveValue('')
    expect(screen.getByRole('textbox', { name: 'Reservation notes' })).toHaveValue('')
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

  it('rejects malformed optional contact numbers before calling the database', async () => {
    render(<StaffReservations />)
    await screen.findByText('Borrower 0')
    fireEvent.change(screen.getByRole('textbox', { name: 'Full name' }), { target: { value: 'Walk-In Borrower' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Contact number' }), { target: { value: 'phone-number' } })
    const picker = screen.getByRole('combobox', { name: 'Select Book' })
    fireEvent.focus(picker)
    fireEvent.click(await screen.findByRole('option', { name: /A Reserved Book/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save Reservation' }))
    expect(await screen.findByText('Enter a valid contact number with 7 to 15 digits, or leave it blank.')).toBeInTheDocument()
    expect(mock.rpc).not.toHaveBeenCalledWith('staff_create_reservation', expect.anything())
  })

  it('selects a book from the searchable picker with the keyboard', async () => {
    render(<StaffReservations />)
    await screen.findByText('Borrower 0')
    const picker = screen.getByRole('combobox', { name: 'Select Book' })
    fireEvent.focus(picker)
    fireEvent.keyDown(picker, { key: 'ArrowDown' })
    fireEvent.keyDown(picker, { key: 'Enter' })
    expect(screen.getByRole('spinbutton', { name: 'Available copies' })).toHaveValue(0)
    expect(picker).toHaveValue('A Reserved Book')
  })

  it('clears all reservation fields without affecting reservations already in the records', async () => {
    render(<StaffReservations />)
    await screen.findByText('Borrower 0')

    fireEvent.change(screen.getByRole('textbox', { name: 'Full name' }), { target: { value: 'Draft Borrower' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Contact number' }), { target: { value: '+63 912 345 6789' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Email address' }), { target: { value: 'draft@example.edu' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clear Form' }))

    expect(screen.getByRole('textbox', { name: 'Full name' })).toHaveValue('')
    expect(screen.getByRole('textbox', { name: 'Contact number' })).toHaveValue('')
    expect(screen.getByRole('textbox', { name: 'Email address' })).toHaveValue('')
    expect(screen.getByText('Borrower 0')).toBeInTheDocument()
    expect(mock.rpc).not.toHaveBeenCalledWith('staff_create_reservation', expect.anything())
  })

  it('runs queue allocation and cancellation through the established RPCs', async () => {
    mock.data.books[0].book_copies = [{ id: 'copy-1', status: 'available' }]
    render(<StaffReservations />)
    await screen.findByText('Borrower 0')

    fireEvent.click(screen.getAllByRole('button', { name: 'Approve Request' })[0])
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('confirm-reservation-action'))
    await waitFor(() => expect(mock.rpc).toHaveBeenCalledWith('staff_approve_reservation_request', { p_reservation_id: 'reservation-0' }))

    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel Reservation' })[0])
    fireEvent.click(screen.getByTestId('confirm-reservation-action'))
    await waitFor(() => expect(mock.rpc).toHaveBeenCalledWith('cancel_reservation', { p_reservation_id: 'reservation-0' }))
  })

  it('fails closed when the approval migration is not deployed', async () => {
    mock.unsupportedApprovalFields = true
    render(<StaffReservations />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Apply migration 040')
    expect(screen.queryByText('Borrower 0')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve Request' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mark Ready for Pickup' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save Reservation' })).toBeDisabled()
  })

  it('completes a ready reservation only through the existing checkout process', async () => {
    mock.data.reservations[0] = makeReservation(0, 'ready_for_pickup', { staff_approved_at: '2026-10-09T08:00:00.000Z', pickup_confirmed_at: '2026-10-09T09:00:00.000Z', pickup_expires_at: '2026-10-15T00:00:00.000Z' })
    render(<StaffReservations />)
    await screen.findByText('Borrower 0')
    fireEvent.click(screen.getByRole('button', { name: 'Complete Reservation' }))
    fireEvent.click(screen.getByTestId('confirm-reservation-action'))
    await waitFor(() => expect(mock.rpc).toHaveBeenCalledWith('checkout_copy', { p_copy_id: 'copy-0', p_member_id: 'member-1' }))
  })

  it('completes an unlinked walk-in through the staff-only checkout RPC', async () => {
    mock.data.reservations[0] = makeReservation(0, 'ready_for_pickup', { member_id: null, member: null, staff_approved_at: '2026-10-09T08:00:00.000Z', pickup_confirmed_at: '2026-10-09T09:00:00.000Z', pickup_expires_at: '2026-10-15T00:00:00.000Z' })
    render(<StaffReservations />)
    await screen.findByText('Borrower 0')
    expect(screen.getByRole('button', { name: 'Complete Reservation' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Complete Reservation' }))
    expect(screen.getByText(/does not create an online account or library card/)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('confirm-reservation-action'))
    await waitFor(() => expect(mock.rpc).toHaveBeenCalledWith('staff_complete_walkin_reservation', { p_reservation_id: 'reservation-0' }))
  })

  it('requires staff confirmation of an assigned copy before checkout is offered', async () => {
    mock.data.reservations[0] = makeReservation(0, 'ready_for_pickup', { staff_approved_at: '2026-10-09T08:00:00.000Z' })
    render(<StaffReservations />)
    await screen.findByText('Borrower 0')

    expect(screen.getByText('Staff verifying copy')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Complete Reservation' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Copy Ready' }))
    expect(screen.getByRole('dialog', { name: 'Confirm this copy is ready?' })).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('confirm-reservation-action'))
    await waitFor(() => expect(mock.rpc).toHaveBeenCalledWith('staff_confirm_reservation_pickup', { p_reservation_id: 'reservation-0' }))
  })

  it('supports reservation details, editing all fields, saving, and closing the dialog', async () => {
    render(<StaffReservations />)
    await screen.findByText('Borrower 0')
    fireEvent.click(screen.getByRole('button', { name: 'View details for Borrower 0' }))
    expect(screen.getByRole('dialog', { name: 'Reservation Details' })).toBeInTheDocument()
    expect(within(screen.getByRole('dialog', { name: 'Reservation Details' })).getByText('A Reserved Book')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit Reservation' }))
    expect(screen.getByRole('heading', { name: 'Edit Reservation' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Registered member for edit')).not.toBeInTheDocument()
    const editDialog = screen.getByRole('dialog', { name: 'Edit Reservation' })
    fireEvent.change(within(editDialog).getByLabelText('Full Name'), { target: { value: 'Edited Borrower' } })
    fireEvent.change(within(editDialog).getByLabelText('Student/Employee ID'), { target: { value: 'EDIT-001' } })
    fireEvent.change(within(editDialog).getByLabelText('Contact Number'), { target: { value: '+63 912 345 6789' } })
    fireEvent.change(within(editDialog).getByLabelText('Email Address'), { target: { value: 'edited@example.edu' } })
    fireEvent.change(within(editDialog).getByLabelText('Reservation Date'), { target: { value: '2026-10-08' } })
    fireEvent.change(within(editDialog).getByLabelText('Expected Pickup Date'), { target: { value: '2026-10-10' } })
    fireEvent.change(within(editDialog).getByLabelText('Notes'), { target: { value: 'Updated note' } })
    fireEvent.click(within(editDialog).getByRole('button', { name: 'Save Changes' }))
    await waitFor(() => expect(mock.rpc).toHaveBeenCalledWith('staff_update_reservation', expect.objectContaining({
      p_reservation_id: 'reservation-0',
      p_borrower_full_name: 'Edited Borrower',
      p_student_employee_id: 'EDIT-001',
      p_contact_number: '+63 912 345 6789',
      p_email_address: 'edited@example.edu',
      p_reservation_date: '2026-10-08',
      p_expected_pickup_date: '2026-10-10',
      p_notes: 'Updated note',
    })))
    expect(await screen.findByText('Reservation updated successfully.')).toBeInTheDocument()
  })

  it('cancels a pending action from the confirmation dialog', async () => {
    render(<StaffReservations />)
    await screen.findByText('Borrower 0')
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel Reservation' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(mock.rpc).not.toHaveBeenCalledWith('cancel_reservation', expect.anything())
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
