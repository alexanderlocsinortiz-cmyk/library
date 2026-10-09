import { useEffect, useState } from 'react'
import { fetchAllRows } from '../lib/paging'
import { supabase } from '../lib/supabase'
import { ConfirmDialog } from './ConfirmDialog'

const statusLabels = {
  waiting: 'Waiting',
  ready_for_pickup: 'Staff verifying copy',
  completed: 'Completed',
  cancelled: 'Cancelled',
  expired: 'Expired',
}
const getReservationStatusLabel = (reservation) => {
  if (reservation.status === 'waiting' && !reservation.staff_approved_at) return 'Pending staff approval'
  if (reservation.status === 'waiting') return 'Waiting for available copy'
  if (reservation.status === 'ready_for_pickup' && !reservation.pickup_confirmed_at) return 'Staff verifying copy'
  if (reservation.status === 'ready_for_pickup') return 'Ready for Pickup'
  return statusLabels[reservation.status] || reservation.status.replaceAll('_', ' ')
}
const borrowerTypes = [
  { value: 'student', label: 'Student' },
  { value: 'faculty', label: 'Faculty' },
  { value: 'staff', label: 'Staff' },
  { value: 'visitor', label: 'Visitor' },
]
const reservableCopyStatuses = new Set(['available', 'borrowed', 'overdue', 'reserved'])
const approvalReservationSelect = 'id, book_id, member_id, borrower_type, borrower_full_name, student_employee_id, contact_number, email_address, reservation_date, expected_pickup_date, status, notes, created_by, created_at, updated_at, pickup_expires_at, staff_approved_at, staff_approved_by, pickup_confirmed_at, pickup_confirmed_by, copy_id, book_copies(barcode), books(title, author), member:library_members!reservations_member_id_fkey(full_name, library_card_number, email_only)'
const todayValue = () => {
  const today = new Date()
  return today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0')
}
const dateValue = (value) => value ? String(value).slice(0, 10) : ''
const isValidContactNumber = (value) => {
  if (!value.trim()) return true
  const digits = value.replace(/\D/g, '').length
  return digits >= 7 && digits <= 15 && /^[0-9+().\s-]+$/.test(value)
}
const formatReservationDate = (value) => {
  if (!value) return '—'
  const date = new Date(String(value).length === 10 ? value + 'T00:00:00' : value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString()
}
const createEmptyDraft = () => ({
  borrower_type: 'student',
  borrower_full_name: '',
  student_employee_id: '',
  contact_number: '',
  email_address: '',
  book_id: '',
  reservation_date: todayValue(),
  expected_pickup_date: '',
  notes: '',
})

function ReservationBookPicker({ books, selectedBookId, onSelect, disabled = false, label = 'Select Book', resetKey = 0 }) {
  const selectedBook = books.find((book) => book.id === selectedBookId)
  const [query, setQuery] = useState(selectedBook?.title || '')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  useEffect(() => {
    if (selectedBookId) setQuery(books.find((book) => book.id === selectedBookId)?.title || '')
  }, [selectedBookId, books])
  useEffect(() => {
    setQuery('')
    setOpen(false)
  }, [resetKey])
  const normalizedQuery = query.trim().toLowerCase()
  const results = books.filter((book) =>
    [book.title, book.author, book.isbn || '', book.course_subject || ''].join(' ').toLowerCase().includes(normalizedQuery)
  ).slice(0, 30)
  const chooseBook = (book) => {
    if (!book.has_reservable_inventory) return
    setQuery(book.title)
    onSelect(book.id)
    setOpen(false)
    setActiveIndex(0)
  }

  return <label className="walkin-book-picker">
    <span>{label} <span className="required-field-mark" aria-hidden="true">*</span></span>
    <div className="walkin-book-picker-control">
      <input
        type="search"
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls="walkin-book-options"
        aria-activedescendant={open && results[activeIndex] ? 'walkin-book-option-' + results[activeIndex].id : undefined}
        autoComplete="off"
        value={query}
        placeholder="Search book title, author, or ISBN"
        disabled={disabled}
        onFocus={() => { setOpen(true); setActiveIndex(0) }}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onChange={(event) => {
          setQuery(event.target.value)
          onSelect('')
          setActiveIndex(0)
          setOpen(true)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && results.length) {
            event.preventDefault()
            setOpen(true)
            setActiveIndex((index) => Math.min(index + 1, results.length - 1))
          } else if (event.key === 'ArrowUp' && results.length) {
            event.preventDefault()
            setActiveIndex((index) => Math.max(index - 1, 0))
          } else if (event.key === 'Enter' && open && results.length) {
            event.preventDefault()
            chooseBook(results[activeIndex] || results[0])
          } else if (event.key === 'Escape') {
            setOpen(false)
          }
        }}
      />
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      {open && !disabled && <div className="walkin-book-options" id="walkin-book-options" role="listbox" aria-label="Matching books">
        {results.length ? results.map((book, index) => <button
          type="button" role="option" id={'walkin-book-option-' + book.id}
          aria-selected={index === activeIndex}
          className={index === activeIndex ? 'active' : ''}
          key={book.id}
          disabled={!book.has_reservable_inventory}
          aria-disabled={!book.has_reservable_inventory}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => setActiveIndex(index)}
          onClick={() => chooseBook(book)}
        >
          <span><strong>{book.title}</strong><small>{book.author}{book.isbn ? ' · ISBN ' + book.isbn : ''}</small></span>
          <em>{book.available_copies} available{!book.has_reservable_inventory ? (book.total_copies === 0 ? ' · No copies recorded' : ' · No usable copies') : ''}</em>
        </button>) : <p className="walkin-book-no-results">No matching books have physical copies eligible for reservation.</p>}
      </div>}
    </div>
  </label>
}

export function StaffReservations({ onBack }) {
  const [reservations, setReservations] = useState([])
  const [books, setBooks] = useState([])
  const [filter, setFilter] = useState('active')
  const [borrowerTypeFilter, setBorrowerTypeFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [savingId, setSavingId] = useState('')
  const [savingReservation, setSavingReservation] = useState(false)
  const [bookPickerResetKey, setBookPickerResetKey] = useState(0)
  const [draft, setDraft] = useState(createEmptyDraft)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [message, setMessage] = useState('')
  const [pendingAction, setPendingAction] = useState(null)
  const [dialogReservation, setDialogReservation] = useState(null)
  const [dialogMode, setDialogMode] = useState('view')
  const [editDraft, setEditDraft] = useState(null)

  const loadReservations = async () => {
    if (!supabase) {
      setLoading(false)
      return
    }
    setLoading(true)
    setLoadError('')
    setActionError('')
    try {
      const { error: refreshError } = await supabase.rpc('refresh_circulation_statuses')
      if (refreshError) throw refreshError
      const booksRequest = fetchAllRows(() => supabase.from('books')
          .select('id, title, author, isbn, course_subject, book_copies(id, status)')
          .order('title'))
      const reservationsResult = await fetchAllRows(() => supabase.from('reservations')
        .select(approvalReservationSelect)
        .order('created_at', { ascending: true }))
      const booksResult = await booksRequest
      if (booksResult.error) throw booksResult.error
      if (reservationsResult.error) throw reservationsResult.error
      setReservations(reservationsResult.data ?? [])
      setBooks((booksResult.data ?? []).map((book) => {
        const copies = book.book_copies ?? []
        return {
          ...book,
          available_copies: copies.filter((copy) => copy.status === 'available').length,
          total_copies: copies.length,
          has_reservable_inventory: copies.some((copy) => reservableCopyStatuses.has(copy.status)),
        }
      }))
    } catch (error) {
      if (import.meta.env.DEV) console.error('[staff reservations] load failed', error)
      setLoadError(/staff_approved_at|staff_approved_by|pickup_confirmed_at|pickup_confirmed_by|schema cache/i.test(error.message || '')
        ? 'Reservation approvals are not installed in the database yet. Apply migration 040 before managing reservations.'
        : 'Unable to load reservations. Please try again.')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void loadReservations() }, [])
  useEffect(() => {
    if (!dialogReservation) return undefined
    const closeOnEscape = (event) => {
      if (event.key === 'Escape' && !savingId) {
        setDialogReservation(null)
        setEditDraft(null)
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [dialogReservation, savingId])

  const reservableBooks = books.filter((book) => book.has_reservable_inventory)
  const selectedBook = books.find((book) => book.id === draft.book_id)

  const clearForm = () => {
    setDraft(createEmptyDraft())
    setBookPickerResetKey((current) => current + 1)
    setActionError('')
    setMessage('')
  }
  const updateDraftField = (field, value) => {
    setDraft((current) => ({ ...current, [field]: value }))
  }

  const createReservation = async (event) => {
    event.preventDefault()
    if (loadError) {
      setActionError(loadError)
      return
    }
    if (!supabase || !draft.borrower_full_name.trim() || !draft.book_id || !draft.reservation_date) {
      setActionError('Enter the borrower name and select a book before saving.')
      return
    }
    if (!isValidContactNumber(draft.contact_number)) {
      setActionError('Enter a valid contact number with 7 to 15 digits, or leave it blank.')
      return
    }
    setSavingReservation(true)
    setActionError('')
    setMessage('')
    try {
      const { error: saveError } = await supabase.rpc('staff_create_reservation', {
        p_book_id: draft.book_id,
        p_member_id: null,
        p_borrower_type: draft.borrower_type,
        p_borrower_full_name: draft.borrower_full_name.trim(),
        p_student_employee_id: draft.student_employee_id.trim() || null,
        p_contact_number: draft.contact_number.trim() || null,
        p_email_address: draft.email_address.trim() || null,
        p_reservation_date: draft.reservation_date,
        p_expected_pickup_date: draft.expected_pickup_date || null,
        p_notes: draft.notes.trim() || null,
      })
      if (saveError) throw saveError
      setMessage('Reservation created and approved by staff. Confirm the assigned copy is ready before pickup.')
      setDraft(createEmptyDraft())
      setBookPickerResetKey((current) => current + 1)
      await loadReservations()
    } catch (error) {
      if (import.meta.env.DEV) console.error('[staff reservations] create failed', error)
      setActionError(error.message || 'Unable to create this reservation. Check the borrower and book details.')
    } finally {
      setSavingReservation(false)
    }
  }

  const openReservation = (reservation, mode = 'view') => {
    setDialogReservation(reservation)
    setDialogMode(mode)
    if (mode === 'edit') {
      setEditDraft({
        member_id: reservation.member_id || '',
        borrower_type: reservation.borrower_type || 'visitor',
        borrower_full_name: reservation.borrower_full_name || reservation.member?.full_name || '',
        student_employee_id: reservation.student_employee_id || '',
        contact_number: reservation.contact_number || '',
        email_address: reservation.email_address || '',
        book_id: reservation.book_id,
        reservation_date: dateValue(reservation.reservation_date),
        expected_pickup_date: dateValue(reservation.expected_pickup_date),
        notes: reservation.notes || '',
      })
    } else {
      setEditDraft(null)
    }
  }
  const saveEdit = async (event) => {
    event.preventDefault()
    if (!supabase || !dialogReservation || !editDraft) return
    if (!editDraft.borrower_full_name.trim() || !editDraft.book_id || !editDraft.reservation_date) {
      setActionError('Enter the borrower name, reservation date, and book before saving.')
      return
    }
    if (!isValidContactNumber(editDraft.contact_number)) {
      setActionError('Enter a valid contact number with 7 to 15 digits, or leave it blank.')
      return
    }
    setSavingId(dialogReservation.id)
    setActionError('')
    setMessage('')
    try {
      const { error: updateError } = await supabase.rpc('staff_update_reservation', {
        p_reservation_id: dialogReservation.id,
        p_book_id: editDraft.book_id,
        p_member_id: editDraft.member_id || null,
        p_borrower_type: editDraft.borrower_type,
        p_borrower_full_name: editDraft.borrower_full_name.trim(),
        p_student_employee_id: editDraft.student_employee_id.trim() || null,
        p_contact_number: editDraft.contact_number.trim() || null,
        p_email_address: editDraft.email_address.trim() || null,
        p_reservation_date: editDraft.reservation_date,
        p_expected_pickup_date: editDraft.expected_pickup_date || null,
        p_notes: editDraft.notes.trim() || null,
      })
      if (updateError) throw updateError
      setMessage('Reservation updated successfully.')
      setDialogReservation(null)
      setEditDraft(null)
      await loadReservations()
    } catch (error) {
      if (import.meta.env.DEV) console.error('[staff reservations] edit failed', error)
      setActionError(error.message || 'Unable to update this reservation.')
    } finally {
      setSavingId('')
    }
  }

  const performAction = async () => {
    if (!supabase || !pendingAction) return
    const { reservation, action } = pendingAction
    setSavingId(reservation.id)
    setActionError('')
    setMessage('')
    try {
      let result
      if (action === 'cancel') result = await supabase.rpc('cancel_reservation', { p_reservation_id: reservation.id })
      else if (action === 'approve') result = await supabase.rpc('staff_approve_reservation_request', { p_reservation_id: reservation.id })
      else if (action === 'confirm_ready') result = await supabase.rpc('staff_confirm_reservation_pickup', { p_reservation_id: reservation.id })
      else if (!reservation.copy_id) throw new Error('This reservation has no physical copy assigned yet.')
      else if (reservation.member_id) result = await supabase.rpc('checkout_copy', { p_copy_id: reservation.copy_id, p_member_id: reservation.member_id })
      else result = await supabase.rpc('staff_complete_walkin_reservation', { p_reservation_id: reservation.id })
      if (result.error) throw result.error
      setMessage(action === 'cancel'
        ? 'Reservation cancelled successfully.'
        : action === 'complete'
          ? 'Checkout completed and the reservation is now complete.'
        : action === 'approve'
            ? 'Reservation approved. Any available copy was assigned for staff verification.'
            : action === 'confirm_ready'
              ? 'Copy confirmed. The member can now see the pickup deadline and notification.'
              : 'Reservation queue processed in request order.')
      setPendingAction(null)
      await loadReservations()
    } catch (error) {
      if (import.meta.env.DEV) console.error('[staff reservations] action failed', error)
      setActionError(error.message || 'Unable to update this reservation. Please try again.')
      setPendingAction(null)
    } finally {
      setSavingId('')
    }
  }

  const searchValue = search.trim().toLowerCase()
  const visible = reservations.filter((reservation) => {
    const searchText = [
      reservation.borrower_full_name, reservation.student_employee_id,
      reservation.contact_number, reservation.email_address, reservation.books?.title,
    ].filter(Boolean).join(' ').toLowerCase()
    const matchesStatus = filter === 'all'
      || (filter === 'active' && ['waiting', 'ready_for_pickup'].includes(reservation.status))
      || reservation.status === filter
    const matchesBorrowerType = borrowerTypeFilter === 'all' || reservation.borrower_type === borrowerTypeFilter
    return matchesStatus && matchesBorrowerType && searchText.includes(searchValue)
  })
  const filtersActive = Boolean(searchValue) || !['active', 'all'].includes(filter) || borrowerTypeFilter !== 'all'
  useEffect(() => { setPage(1) }, [search, filter, borrowerTypeFilter])
  const pageSize = 6
  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize))
  const activePage = Math.min(page, pageCount)
  const pageStart = (activePage - 1) * pageSize
  const pageItems = visible.slice(pageStart, pageStart + pageSize)
  const firstItemNumber = visible.length ? pageStart + 1 : 0
  const lastItemNumber = Math.min(pageStart + pageSize, visible.length)
  const firstPageButton = Math.max(1, Math.min(activePage - 2, pageCount - 4))
  const pageButtons = Array.from({ length: Math.min(pageCount, 5) }, (_, index) => firstPageButton + index)
  const clearFilters = () => { setSearch(''); setFilter('all'); setBorrowerTypeFilter('all') }
  const modalBookId = editDraft?.book_id || ''
  const isReadyEdit = dialogMode === 'edit' && dialogReservation?.status === 'ready_for_pickup'

  return <section className="content-section reservations-page">
    <header className="book-page-header-card reservations-page-header">
      <div className="book-page-header-copy"><span className="eyebrow">Library circulation</span><h2>Manual Book Reservations</h2><p>Create and manage book reservations for walk-in students, faculty, and visitors.</p></div>
      {onBack && <button type="button" className="book-page-header-back" onClick={onBack}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M19 12H5m7 7-7-7 7-7" /></svg><span>Back to Dashboard</span></button>}
    </header>
    {(message || actionError || loadError) && <div className={actionError || loadError ? 'inline-error with-action' : 'inline-success'} role={actionError || loadError ? 'alert' : 'status'}><span>{actionError || loadError || message}</span>{(actionError || loadError) && <button type="button" className="retry-button" onClick={() => void loadReservations()}>Try again</button>}</div>}

    <form className="tool-form reservation-create-card walkin-reservation-form" onSubmit={createReservation}>
      <div className="reservation-section-heading"><h3>Create Walk-In Reservation</h3><p>Enter the borrower&apos;s details and select the book they want to reserve.</p></div>
      <fieldset className="walkin-form-section"><legend>Borrower Information</legend><div className="walkin-form-grid">
        <label>Borrower Type <span className="required-field-mark" aria-hidden="true">*</span><select value={draft.borrower_type} onChange={(event) => updateDraftField('borrower_type', event.target.value)} required aria-label="Borrower type">{borrowerTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select></label>
        <label>Full Name <span className="required-field-mark" aria-hidden="true">*</span><input value={draft.borrower_full_name} onChange={(event) => updateDraftField('borrower_full_name', event.target.value)} maxLength={160} autoComplete="name" required aria-label="Full name" /></label>
        <label>Student/Employee ID <span className="optional-field-mark">Optional</span><input value={draft.student_employee_id} onChange={(event) => updateDraftField('student_employee_id', event.target.value)} maxLength={100} aria-label="Student or employee ID" /></label>
        <label>Contact Number <span className="optional-field-mark">Optional</span><input type="tel" value={draft.contact_number} onChange={(event) => setDraft((current) => ({ ...current, contact_number: event.target.value }))} maxLength={40} autoComplete="tel" aria-label="Contact number" /></label>
        <label>Email Address <span className="optional-field-mark">Optional</span><input type="email" value={draft.email_address} onChange={(event) => setDraft((current) => ({ ...current, email_address: event.target.value }))} maxLength={254} autoComplete="email" aria-label="Email address" /></label>
      </div></fieldset>
      <fieldset className="walkin-form-section"><legend>Book Information</legend><div className="walkin-form-grid book-information-grid">
        <ReservationBookPicker books={books} selectedBookId={draft.book_id} onSelect={(bookId) => setDraft((current) => ({ ...current, book_id: bookId }))} resetKey={bookPickerResetKey} />
        <label>Available Copies<input type="number" value={selectedBook ? selectedBook.available_copies : ''} readOnly placeholder="Select a book" aria-label="Available copies" /></label>
        <label><span>Reservation Date <span className="required-field-mark" aria-hidden="true">*</span></span><input type="date" value={draft.reservation_date} max={todayValue()} onChange={(event) => setDraft((current) => ({ ...current, reservation_date: event.target.value, expected_pickup_date: current.expected_pickup_date && current.expected_pickup_date < event.target.value ? '' : current.expected_pickup_date }))} required aria-label="Reservation date" /></label>
        <label>Expected Pickup Date <span className="optional-field-mark">Optional</span><input type="date" value={draft.expected_pickup_date} min={draft.reservation_date} onChange={(event) => setDraft((current) => ({ ...current, expected_pickup_date: event.target.value }))} aria-label="Expected pickup date" /></label>
        <label className="walkin-notes-field">Notes <span className="optional-field-mark">Optional</span><textarea value={draft.notes} onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))} maxLength={2000} rows={2} aria-label="Reservation notes" /></label>
      </div></fieldset>
      <div className="walkin-form-footer"><p>Walk-in reservations can be created without a library account.</p><div>
        <button type="button" className="secondary-button" onClick={clearForm} disabled={savingReservation}>Clear Form</button>
        <button type="submit" className="primary-button" disabled={savingReservation || loading || Boolean(loadError) || !draft.borrower_full_name.trim() || !draft.book_id || !draft.reservation_date}>{savingReservation ? 'Saving reservation...' : 'Save Reservation'}</button>
      </div></div>
      {!loading && reservableBooks.length === 0 && books.length > 0 && <small className="reservation-form-empty-help">No titles have an available or circulating physical copy. Register or check in a physical copy to enable reservations.</small>}
      {!loading && books.length === 0 && <small className="reservation-form-empty-help">No book titles are currently listed in the catalog.</small>}
    </form>

    <section className="book-management-card reservation-records-card" aria-labelledby="reservation-records-title">
      <header className="book-management-card-header reservation-records-header"><div><h3 id="reservation-records-title">Reservation Records</h3><p>View and manage book reservations.</p></div></header>
      <div className="reservation-filter-toolbar walkin-record-filters">
        <label className="reservation-search-field"><span>Search reservations</span><span className="reservation-search-control"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 5 5" /></svg><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Borrower name, ID, or book title" aria-label="Search by borrower name, ID, or book title" /></span></label>
        <label><span>Reservation status</span><select value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filter reservations by status"><option value="active">Active reservations</option><option value="all">All statuses</option><option value="waiting">Pending</option><option value="ready_for_pickup">Ready for Pickup</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option><option value="expired">Expired</option></select></label>
        <label><span>Borrower type</span><select value={borrowerTypeFilter} onChange={(event) => setBorrowerTypeFilter(event.target.value)} aria-label="Filter by borrower type"><option value="all">All borrower types</option>{borrowerTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select></label>
      </div>
      <div className="reservation-results-meta"><span>{visible.length} matching {visible.length === 1 ? 'reservation' : 'reservations'}</span>{filtersActive && <button type="button" className="reservation-clear-filters" onClick={clearFilters}>Clear Filters</button>}</div>
      {loading && <div className="reservation-loading" role="status" aria-live="polite"><span className="reservation-loading-bar" /><span>Loading reservations...</span></div>}
      {!loading && !loadError && visible.length === 0 && <div className="reservation-empty-state"><span className="reservation-empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3.5" y="5" width="17" height="16" rx="2" /><path d="M7.5 3v4M16.5 3v4M3.5 10h17M8 14h3m-3 3h6" /></svg></span><div><strong>{reservations.length === 0 ? 'No reservations yet' : 'No matching reservations'}</strong><p>{reservations.length === 0 ? 'Reservations created by library staff will appear here.' : 'Try changing your search or filters.'}</p></div></div>}
      {!loading && !loadError && visible.length > 0 && <div className="table-wrap reservation-table-wrap walkin-reservation-table"><table>
        <thead><tr><th>Borrower Name</th><th>Borrower Type</th><th>Book Title</th><th>Reservation Date</th><th>Pickup Date</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>{pageItems.map((reservation) => {
          const borrowerName = reservation.borrower_full_name || reservation.member?.full_name || 'Unknown borrower'
          return <tr key={reservation.id}>
            <td><strong>{borrowerName}</strong><small className="table-subtext">{reservation.member?.email_only ? `Confirmed email: ${reservation.email_address || 'not recorded'}; student status not verified` : reservation.student_employee_id || reservation.contact_number || reservation.email_address || ''}</small></td>
            <td><span className="reservation-borrower-type">{borrowerTypes.find((type) => type.value === reservation.borrower_type)?.label || 'Visitor'}</span></td>
            <td><strong>{reservation.books?.title || 'Unknown book'}</strong><small className="table-subtext">{reservation.books?.author || ''}</small>{reservation.book_copies?.barcode && <small className="table-subtext">Copy {reservation.book_copies.barcode}</small>}</td>
            <td>{formatReservationDate(reservation.reservation_date || reservation.created_at)}</td>
            <td>{reservation.expected_pickup_date ? formatReservationDate(reservation.expected_pickup_date) : '—'}{reservation.pickup_expires_at && <small className="table-subtext">Pickup deadline {formatReservationDate(reservation.pickup_expires_at)}</small>}</td>
            <td><span className="table-status reservation-status-badge" data-status={reservation.status}>{getReservationStatusLabel(reservation)}</span></td>
            <td><div className="reservation-row-actions">
              <button type="button" className="reservation-row-action" aria-label={'View details for ' + borrowerName} onClick={() => openReservation(reservation, 'view')}>View Details</button>
              {['waiting', 'ready_for_pickup'].includes(reservation.status) && <button type="button" className="reservation-row-action" aria-label={'Edit reservation for ' + borrowerName} onClick={() => openReservation(reservation, 'edit')}>Edit</button>}
              {reservation.status === 'waiting' && !reservation.staff_approved_at && <button type="button" className="reservation-row-action" onClick={() => setPendingAction({ reservation, action: 'approve' })}>Approve Request</button>}
              {reservation.status === 'ready_for_pickup' && !reservation.pickup_confirmed_at && <button type="button" className="reservation-row-action" onClick={() => setPendingAction({ reservation, action: 'confirm_ready' })} disabled={!reservation.copy_id} title={!reservation.copy_id ? 'A physical copy must be assigned before pickup can be confirmed.' : undefined}>Confirm Copy Ready</button>}
              {reservation.status === 'ready_for_pickup' && reservation.pickup_confirmed_at && <button type="button" className="reservation-row-action" onClick={() => setPendingAction({ reservation, action: 'complete' })} disabled={!reservation.copy_id} title={!reservation.copy_id ? 'A physical copy must be assigned before checkout.' : undefined}>Complete Reservation</button>}
              {['waiting', 'ready_for_pickup'].includes(reservation.status) && <button type="button" className="reservation-row-action danger" onClick={() => setPendingAction({ reservation, action: 'cancel' })}>Cancel Reservation</button>}
            </div></td>
          </tr>
        })}</tbody>
      </table></div>}
      <footer className="reservation-pagination-footer"><span className="reservation-page-summary">Showing {firstItemNumber}–{lastItemNumber} of {visible.length} {visible.length === 1 ? 'reservation' : 'reservations'}</span><nav className="reservation-pagination" aria-label="Reservation pages">
        <button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={activePage <= 1}>Previous</button>
        {pageButtons.map((pageNumber) => <button type="button" key={pageNumber} className={activePage === pageNumber ? 'active' : ''} aria-current={activePage === pageNumber ? 'page' : undefined} aria-label={'Page ' + pageNumber} onClick={() => setPage(pageNumber)}>{pageNumber}</button>)}
        <button type="button" onClick={() => setPage((current) => Math.min(pageCount, current + 1))} disabled={activePage >= pageCount}>Next</button>
      </nav></footer>
    </section>

    <aside className="reservation-rules-note walkin-rules-note">
      <span className="reservation-rules-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21z" /><path d="M4 5.5v15M8 7h8M8 10h7" /></svg></span>
      <div><strong>How Book Reservations Work</strong><p>Member requests need staff approval. Staff-created walk-in reservations are approved by the staff member who creates them. Approved requests are served in first-come, first-served order; staff must verify the assigned copy is physically present and usable before the member receives a pickup deadline. At pickup, staff records the checkout; a walk-in borrower does not need an account or library card.</p></div>
    </aside>

    {dialogReservation && <div className="reservation-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) { setDialogReservation(null); setEditDraft(null) } }}>
      <section className="reservation-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="reservation-dialog-title">
        <header><div><span className="eyebrow">{dialogMode === 'edit' ? 'Reservation record' : 'Reservation details'}</span><h2 id="reservation-dialog-title">{dialogMode === 'edit' ? 'Edit Reservation' : 'Reservation Details'}</h2></div><button type="button" aria-label="Close reservation dialog" onClick={() => { setDialogReservation(null); setEditDraft(null) }}>×</button></header>
        {dialogMode === 'view' && <div className="reservation-detail-grid">
          <div><span>Borrower</span><strong>{dialogReservation.borrower_full_name || dialogReservation.member?.full_name || 'Unknown borrower'}</strong></div>
          <div><span>Borrower type</span><strong>{borrowerTypes.find((type) => type.value === dialogReservation.borrower_type)?.label || 'Visitor'}</strong></div>
          <div><span>Student/Employee ID</span><strong>{dialogReservation.student_employee_id || '—'}</strong></div>
          <div><span>Contact number</span><strong>{dialogReservation.contact_number || '—'}</strong></div>
          <div><span>Email address</span><strong>{dialogReservation.email_address || '—'}</strong></div>
          <div><span>Book</span><strong>{dialogReservation.books?.title || 'Unknown book'}</strong></div>
          <div><span>Reservation date</span><strong>{formatReservationDate(dialogReservation.reservation_date || dialogReservation.created_at)}</strong></div>
          <div><span>Expected pickup</span><strong>{formatReservationDate(dialogReservation.expected_pickup_date)}</strong></div>
          <div><span>Status</span><strong>{getReservationStatusLabel(dialogReservation)}</strong></div>
          <div><span>Assigned copy</span><strong>{dialogReservation.book_copies?.barcode || 'Not assigned'}</strong></div>
          <div><span>Staff approval</span><strong>{dialogReservation.staff_approved_at ? formatReservationDate(dialogReservation.staff_approved_at) : 'Pending'}</strong></div>
          <div><span>Pickup confirmation</span><strong>{dialogReservation.pickup_confirmed_at ? formatReservationDate(dialogReservation.pickup_confirmed_at) : 'Pending'}</strong></div>
          <div className="reservation-detail-notes"><span>Notes</span><strong>{dialogReservation.notes || '—'}</strong></div>
        </div>}
        {dialogMode === 'edit' && editDraft && <form className="reservation-edit-form" onSubmit={saveEdit}>
          <div className="walkin-form-grid">
            <label>Borrower Type<select value={editDraft.borrower_type} onChange={(event) => setEditDraft((current) => ({ ...current, borrower_type: event.target.value, member_id: '' }))} disabled={isReadyEdit}>{borrowerTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select></label>
            <label>Full Name<input value={editDraft.borrower_full_name} onChange={(event) => setEditDraft((current) => ({ ...current, borrower_full_name: event.target.value, member_id: '' }))} maxLength={160} required disabled={isReadyEdit} /></label>
            <label>Student/Employee ID<input value={editDraft.student_employee_id} onChange={(event) => setEditDraft((current) => ({ ...current, student_employee_id: event.target.value, member_id: '' }))} maxLength={100} disabled={isReadyEdit} /></label>
            <label>Contact Number<input type="tel" value={editDraft.contact_number} onChange={(event) => setEditDraft((current) => ({ ...current, contact_number: event.target.value }))} maxLength={40} /></label>
            <label>Email Address<input type="email" value={editDraft.email_address} onChange={(event) => setEditDraft((current) => ({ ...current, email_address: event.target.value }))} maxLength={254} /></label>
            <ReservationBookPicker books={books} selectedBookId={modalBookId} onSelect={(bookId) => setEditDraft((current) => ({ ...current, book_id: bookId }))} disabled={isReadyEdit} label="Select Book" />
            <label>Reservation Date<input type="date" value={editDraft.reservation_date} max={todayValue()} onChange={(event) => setEditDraft((current) => ({ ...current, reservation_date: event.target.value, expected_pickup_date: current.expected_pickup_date && current.expected_pickup_date < event.target.value ? '' : current.expected_pickup_date }))} required /></label>
            <label>Expected Pickup Date<input type="date" value={editDraft.expected_pickup_date} min={editDraft.reservation_date} onChange={(event) => setEditDraft((current) => ({ ...current, expected_pickup_date: event.target.value }))} /></label>
            <label className="walkin-notes-field">Notes<textarea value={editDraft.notes} onChange={(event) => setEditDraft((current) => ({ ...current, notes: event.target.value }))} maxLength={2000} rows={2} /></label>
          </div>
          <footer><button type="button" className="secondary-button" onClick={() => { setDialogReservation(null); setEditDraft(null) }} disabled={savingId === dialogReservation.id}>Cancel</button><button type="submit" className="primary-button" disabled={savingId === dialogReservation.id || !editDraft.borrower_full_name.trim() || !editDraft.book_id}>{savingId === dialogReservation.id ? 'Saving...' : 'Save Changes'}</button></footer>
        </form>}
        {dialogMode === 'view' && <footer className="reservation-detail-footer"><button type="button" className="secondary-button" onClick={() => setDialogReservation(null)}>Close</button>{['waiting', 'ready_for_pickup'].includes(dialogReservation.status) && <button type="button" className="primary-button" onClick={() => openReservation(dialogReservation, 'edit')}>Edit Reservation</button>}</footer>}
      </section>
    </div>}

    <ConfirmDialog
      open={Boolean(pendingAction)}
      title={pendingAction?.action === 'cancel' ? 'Cancel this reservation?' : pendingAction?.action === 'complete' ? 'Check out this reservation?' : pendingAction?.action === 'approve' ? 'Approve this reservation request?' : 'Confirm this copy is ready?'}
      description={pendingAction?.action === 'cancel'
        ? 'The reservation will be cancelled and any assigned copy returned to the next eligible borrower.'
        : pendingAction?.action === 'complete'
          ? pendingAction.reservation.member_id
            ? 'This uses the normal checkout process. The reservation is completed only if checkout succeeds.'
            : 'This records the walk-in borrower in circulation history and checks out the assigned copy. It does not create an online account or library card.'
          : pendingAction?.action === 'approve'
            ? 'This request joins the staff-approved queue. If a copy is available, the system assigns it for staff verification; the member will not be told to collect it yet.'
          : 'Confirm the assigned physical copy is present and in usable condition. This starts the pickup deadline and tells the member it is ready.'}
      confirmLabel={pendingAction?.action === 'cancel' ? 'Cancel Reservation' : pendingAction?.action === 'complete' ? 'Complete Reservation' : pendingAction?.action === 'approve' ? 'Approve Request' : 'Confirm Copy Ready'}
      danger={pendingAction?.action === 'cancel'}
      busy={Boolean(pendingAction && savingId === pendingAction.reservation.id)}
      onCancel={() => setPendingAction(null)}
      onConfirm={() => { void performAction() }}
    />
  </section>
}
