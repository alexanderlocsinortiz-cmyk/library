import { usePagination } from './Pagination'
import { fetchAllRows } from '../lib/paging'
import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { ConfirmDialog } from './ConfirmDialog'
import { defaultCirculationPolicy, formatFine, getLoanDueState, normalizeCirculationPolicy } from '../lib/circulation'

const formatDate = (value) => value ? new Date(value).toLocaleDateString() : 'Not set'
const CATALOG_PAGE_SIZE = 12

function describeReservationError(message) {
  const normalized = (message || '').toLowerCase()
  if (normalized.includes('not linked') || normalized.includes('verified card')) {
    return 'Your account is not linked to an active library member with a verified library card. Ask library staff to link your account or place the hold at the circulation desk.'
  }
  if (normalized.includes('currently available')) return 'This title has an available copy. Ask staff to check it out at the circulation desk.'
  if (normalized.includes('no physical copies')) return 'The library has no physical copy of this title yet. Ask staff to record an acquisition request.'
  return 'Unable to create the reservation. Please try again or ask library staff for help.'
}

function PageHeader({ eyebrow, title, description }) {
  return (
    <div className="section-heading page-header">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
        <p className="muted">{description}</p>
      </div>
    </div>
  )
}

function BookCover({ book }) {
  return <div className="book-cover compact-cover">{book?.cover_url ? <img src={book.cover_url} alt={`Cover of ${book.title}`} /> : <span>BOOK</span>}</div>
}

function CatalogBookCover({ book }) {
  const [imageFailed, setImageFailed] = useState(false)
  return <span className="catalog-book-cover">
    {book?.cover_url && !imageFailed
      ? <img src={book.cover_url} alt={`Cover of ${book.title}`} loading="lazy" decoding="async" onError={() => setImageFailed(true)} />
      : <span className="catalog-cover-placeholder"><small>IBA COLLEGE LIBRARY</small><strong>{book?.title || 'Untitled book'}</strong></span>}
  </span>
}

function StatusBadge({ value }) {
  const label = value?.replaceAll('_', ' ') || 'Unknown'
  const danger = ['overdue', 'lost', 'damaged'].includes(value)
  return <span className={danger ? 'table-status danger' : 'table-status'} data-status={value}>{label}</span>
}

function describeCardReservationError(message) {
  const normalized = (message || '').toLowerCase()
  if (normalized.includes('card or pin')) return 'The card number or PIN could not be verified. Check both or ask library staff to reset the PIN.'
  if (normalized.includes('available now')) return 'A copy is available now. Please borrow it at the circulation desk.'
  if (normalized.includes('no physical copy')) return 'The library has no physical copy of this title yet. Ask staff about a book request.'
  if (normalized.includes('currently circulating')) return 'This title has no copies currently out or assigned to a hold, so it cannot be queued yet.'
  return 'The reservation could not be completed. Please try again or ask library staff for help.'
}

function PublicReservationManager() {
  const [cardNumber, setCardNumber] = useState('')
  const [pin, setPin] = useState('')
  const [reservations, setReservations] = useState(null)
  const [loading, setLoading] = useState(false)
  const [cancellingId, setCancellingId] = useState('')
  const [confirmingReservation, setConfirmingReservation] = useState(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const lookupReservations = async (event) => {
    event?.preventDefault()
    if (!supabase || !cardNumber.trim() || !pin) return
    setLoading(true)
    setError('')
    setMessage('')
    try {
      const { data, error: lookupError } = await supabase.rpc('card_reservation_status', {
        p_card_number: cardNumber.trim(),
        p_pin: pin,
      })
      if (lookupError) throw lookupError
      if (data?.verified === false) {
        setReservations(null)
        setError(describeCardReservationError('card or pin'))
        return
      }
      setReservations(data?.reservations ?? [])
    } catch (lookupError) {
      if (import.meta.env.DEV) console.error('[public reservations] lookup failed', lookupError)
      setReservations(null)
      setError(describeCardReservationError(lookupError?.message))
    } finally {
      setLoading(false)
    }
  }

  const cancelReservation = async (reservation) => {
    if (!supabase || !pin) return
    setCancellingId(reservation.reservation_id)
    setError('')
    setMessage('')
    try {
      const { data, error: cancelError } = await supabase.rpc('cancel_card_reservation', {
        p_card_number: cardNumber.trim(),
        p_pin: pin,
        p_reservation_id: reservation.reservation_id,
      })
      if (cancelError) throw cancelError
      if (data?.verified === false) throw new Error('Card or PIN was not verified')
      await lookupReservations()
      setMessage('Reservation cancelled. Any assigned copy has been released to the next person in line.')
    } catch (cancelError) {
      if (import.meta.env.DEV) console.error('[public reservations] cancellation failed', cancelError)
      setError(describeCardReservationError(cancelError?.message))
    } finally {
      setCancellingId('')
      setConfirmingReservation(null)
    }
  }

  return <details className="secondary-tool-disclosure public-reservation-manager">
    <summary><span>Check or cancel a reservation</span><small>Use your library card and the private PIN issued by library staff.</small></summary>
    <div className="public-reservation-content">
      <form className="tool-form" onSubmit={lookupReservations}>
        <h3>My reservations</h3>
        <div className="form-row two-column">
          <label>Library card number<input value={cardNumber} onChange={(event) => setCardNumber(event.target.value)} autoComplete="username" maxLength="100" required /></label>
          <label>Reservation PIN<input type="password" inputMode="numeric" autoComplete="current-password" value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 12))} minLength="6" maxLength="12" pattern="[0-9]{6,12}" required /></label>
        </div>
        <button type="submit" className="secondary-button" disabled={loading || !cardNumber.trim() || pin.length < 6}>{loading ? 'Checking...' : 'Check reservations'}</button>
      </form>
      {error && <div className="inline-error" role="alert">{error}</div>}
      {message && <div className="inline-success" role="status">{message}</div>}
      {reservations && reservations.length === 0 && <div className="empty-state">No active reservations were found for this card.</div>}
      {reservations?.length > 0 && <div className="reservation-lookup-list">{reservations.map((reservation) => <article className="reservation-lookup-card" key={reservation.reservation_id}>
        <div><strong>{reservation.book_title}</strong><small>{reservation.author || 'Author not recorded'}</small></div>
        <StatusBadge value={reservation.status} />
        <p>{reservation.status === 'waiting' ? `Queue position ${reservation.queue_position ?? 'pending'}` : `Collect by ${new Date(reservation.pickup_expires_at).toLocaleString()}`}</p>
        {['waiting', 'ready_for_pickup'].includes(reservation.status) && <button type="button" className="table-action" onClick={() => setConfirmingReservation(reservation)} disabled={cancellingId === reservation.reservation_id}>{cancellingId === reservation.reservation_id ? 'Cancelling...' : 'Cancel hold'}</button>}
      </article>)}</div>}
      <p className="form-helper">Check here for pickup status and deadlines. Ask library staff to set or reset your PIN after they verify your card. The library does not send reservation email.</p>
      <ConfirmDialog
        open={Boolean(confirmingReservation)}
        title="Cancel this hold?"
        description={`Cancel your reservation for “${confirmingReservation?.book_title || 'this book'}”? Your place in the queue will be released.`}
        confirmLabel="Cancel hold"
        danger
        busy={Boolean(confirmingReservation && cancellingId === confirmingReservation.reservation_id)}
        onCancel={() => setConfirmingReservation(null)}
        onConfirm={() => { if (confirmingReservation) void cancelReservation(confirmingReservation) }}
      />
    </div>
  </details>
}

export function CatalogPage({ onBack, role }) {
  const [books, setBooks] = useState([])
  const [search, setSearch] = useState('')
  const [availability, setAvailability] = useState('all')
  const [category, setCategory] = useState('all')
  const [author, setAuthor] = useState('all')
  const [sortBy, setSortBy] = useState('title-asc')
  const [page, setPage] = useState(1)
  const [selectedBookId, setSelectedBookId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [message, setMessage] = useState('')
  const [reservingId, setReservingId] = useState('')

  useEffect(() => {
    let active = true
    const loadBooks = async () => {
      if (!supabase) {
        if (active) setLoading(false)
        return
      }
      try {
        const { data, error: booksError } = await fetchAllRows(() => supabase.from('books').select('id, title, author, isbn, category, course_subject, description, publication_year, cover_url, book_copies(id, status)').order('title', { ascending: true }))
        if (!active) return
        if (booksError) setError(booksError.message)
        setBooks(data ?? [])
      } catch (loadError) {
        if (import.meta.env.DEV) console.error('[catalog] books failed', loadError)
        if (active) setError('Unable to load the catalog. Please try again.')
      } finally {
        if (active) setLoading(false)
      }
    }
    loadBooks()
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!selectedBookId) return
    document.documentElement.scrollTop = 0
    document.body.scrollTop = 0
  }, [selectedBookId])

  const categories = [...new Set(books.map((book) => book.category).filter(Boolean))].sort()
  const authors = [...new Set(books.map((book) => book.author).filter(Boolean))].sort()
  const hasActiveCatalogFilters = Boolean(search.trim()) || availability !== 'all' || category !== 'all' || author !== 'all' || sortBy !== 'title-asc'
  useEffect(() => { setPage(1) }, [search, availability, category, author, sortBy])
  const clearCatalogFilters = () => {
    setSearch('')
    setAvailability('all')
    setCategory('all')
    setAuthor('all')
    setSortBy('title-asc')
  }
  const filteredBooks = books.filter((book) => {
    const query = `${book.title} ${book.author} ${book.isbn || ''} ${book.category || ''} ${book.course_subject || ''}`.toLowerCase()
    const availableCopies = (book.book_copies || []).filter((copy) => copy.status === 'available').length
    return query.includes(search.trim().toLowerCase())
      && (availability === 'all' || (availability === 'available' && availableCopies > 0) || (availability === 'unavailable' && availableCopies === 0))
      && (category === 'all' || book.category === category)
      && (author === 'all' || book.author === author)
  }).sort((left, right) => {
    if (sortBy === 'title-desc') return (right.title || '').localeCompare(left.title || '')
    if (sortBy === 'newest') return (right.publication_year || 0) - (left.publication_year || 0)
    return (left.title || '').localeCompare(right.title || '')
  })

  const pageCount = Math.max(1, Math.ceil(filteredBooks.length / CATALOG_PAGE_SIZE))
  const activePage = Math.min(page, pageCount)
  const pageStartIndex = (activePage - 1) * CATALOG_PAGE_SIZE
  const pageItems = filteredBooks.slice(pageStartIndex, pageStartIndex + CATALOG_PAGE_SIZE)
  const firstBookNumber = filteredBooks.length === 0 ? 0 : pageStartIndex + 1
  const lastBookNumber = Math.min(pageStartIndex + CATALOG_PAGE_SIZE, filteredBooks.length)
  const firstVisiblePage = Math.max(1, Math.min(activePage - 2, pageCount - 4))
  const visiblePages = Array.from({ length: Math.min(pageCount, 5) }, (_, index) => firstVisiblePage + index)

  const reserve = async (bookId) => {
    if (!supabase) return
    setReservingId(bookId)
    setActionError('')
    setMessage('')
    try {
      const { error: reservationError } = await supabase.rpc('reserve_book', { p_book_id: bookId })
      if (reservationError) setActionError(describeReservationError(reservationError.message))
      else setMessage('Reservation successfully created or already active.')
    } catch (reservationError) {
      if (import.meta.env.DEV) console.error('[catalog] reservation failed', reservationError)
      setActionError(describeReservationError(reservationError?.message))
    } finally {
      setReservingId('')
    }
  }

  if (selectedBookId) return <BookDetailsView bookId={selectedBookId} role={role} onBack={() => setSelectedBookId('')} />

  return (
    <section className="content-section catalog-page">
      <header className="book-page-header-card catalog-page-header">
        <div className="book-page-header-copy">
          <span className="eyebrow">Library catalog</span>
          <h2>Browse Books</h2>
          <p>Discover books available in the college library.</p>
        </div>
        {onBack && <button type="button" className="book-page-header-back" onClick={onBack}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /><path d="M20 12H9" /></svg>
          <span>{role === 'public' ? 'Back to sign in' : 'Back to dashboard'}</span>
        </button>}
      </header>
      <div className="catalog-toolbar-panel">
        <div className="catalog-toolbar catalog-filters">
        <label className="toolbar-field catalog-search-field"><span>Search catalog</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Title, author, ISBN, course, or subject" aria-label="Search library" /></label>
        <label className="toolbar-field"><span>Availability</span><select value={availability} onChange={(event) => setAvailability(event.target.value)} aria-label="Filter availability"><option value="all">All availability</option><option value="available">Available</option><option value="unavailable">Unavailable</option></select></label>
        <label className="toolbar-field"><span>Category</span><select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Filter category"><option value="all">All categories</option>{categories.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label className="toolbar-field"><span>Author</span><select value={author} onChange={(event) => setAuthor(event.target.value)} aria-label="Filter author"><option value="all">All authors</option>{authors.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label className="toolbar-field"><span>Sort by</span><select value={sortBy} onChange={(event) => setSortBy(event.target.value)} aria-label="Sort catalog"><option value="title-asc">Title A-Z</option><option value="title-desc">Title Z-A</option><option value="newest">Newest publication</option></select></label>
        </div>
        <div className="catalog-toolbar-footer">
          <p className="catalog-result-count" aria-live="polite">{loading ? 'Loading catalog...' : `${filteredBooks.length} matching ${filteredBooks.length === 1 ? 'book' : 'books'}`}</p>
          {hasActiveCatalogFilters && <button type="button" className="catalog-clear-filters" onClick={clearCatalogFilters}>Clear Filters</button>}
        </div>
      </div>
      {message && <div className="inline-success" role="status">{message}</div>}
      {error && <div className="inline-error" role="alert">Unable to load the catalog. Please try again.</div>}
      {actionError && <div className="inline-error" role="alert">{actionError}</div>}
      {loading && <div className="catalog-grid catalog-skeleton-grid" role="status" aria-label="Loading catalog books" aria-busy="true">
        <span className="sr-only">Loading catalog...</span>
        {Array.from({ length: CATALOG_PAGE_SIZE }, (_, index) => <div className="catalog-skeleton-card" key={index} aria-hidden="true"><div className="catalog-skeleton-cover" /><div className="catalog-skeleton-line title-line" /><div className="catalog-skeleton-line author-line" /><div className="catalog-skeleton-pill" /></div>)}
      </div>}
      {!loading && !error && filteredBooks.length === 0 && <div className="empty-state large catalog-empty-state">
        <div><strong>{books.length === 0 ? 'The catalog is empty right now' : 'No books match your search'}</strong><p>{books.length === 0 ? 'Library staff have not added any titles yet. Please ask at the circulation desk.' : 'Try a different search or clear your filters to see more of the collection.'}</p>{books.length > 0 && hasActiveCatalogFilters && <button type="button" className="secondary-button" onClick={clearCatalogFilters}>Clear Filters</button>}</div>
      </div>}
      {!loading && !error && filteredBooks.length > 0 && <div className="catalog-grid">{pageItems.map((book) => {
        const copies = book.book_copies || []
        const availableCopies = copies.filter((copy) => copy.status === 'available').length
        const hasCirculatingCopies = copies.some((copy) => ['borrowed', 'overdue', 'reserved'].includes(copy.status))
        const subject = book.course_subject || book.category
        return <article className="book-card" key={book.id}>
          <button type="button" className="catalog-card-main" onClick={() => setSelectedBookId(book.id)} aria-label={`View details for ${book.title}`}>
            <CatalogBookCover book={book} />
            <span className="book-info">
              <span className="catalog-card-title" role="heading" aria-level="3">{book.title}</span>
              <span className="book-author">{book.author || 'Author not recorded'}</span>
              <span className={availableCopies > 0 ? 'availability available' : 'availability unavailable'}>{availableCopies > 0 ? `Available · ${availableCopies} / ${copies.length}` : `Unavailable · 0 / ${copies.length}`}</span>
              {subject && <span className="catalog-card-subject" title={subject}>{subject}</span>}
            </span>
          </button>
          {role === 'member' && availableCopies === 0 && hasCirculatingCopies && <button type="button" className="catalog-card-reserve" onClick={() => reserve(book.id)} disabled={reservingId === book.id}>{reservingId === book.id ? 'Saving...' : 'Reserve'}</button>}
        </article>
      })}</div>}
      {!loading && !error && filteredBooks.length > 0 && <footer className="catalog-pagination-footer">
        <span className="catalog-pagination-summary">Showing {firstBookNumber}–{lastBookNumber} of {filteredBooks.length} {filteredBooks.length === 1 ? 'book' : 'books'}</span>
        <nav className="catalog-pagination-nav" aria-label="Catalog pages">
          <button type="button" className="catalog-page-arrow" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={activePage === 1}>Previous</button>
          {visiblePages.map((pageNumber) => <button type="button" key={pageNumber} className={activePage === pageNumber ? 'catalog-page-number active' : 'catalog-page-number'} onClick={() => setPage(pageNumber)} aria-current={activePage === pageNumber ? 'page' : undefined} aria-label={`Page ${pageNumber}`}>{pageNumber}</button>)}
          <button type="button" className="catalog-page-arrow" onClick={() => setPage((current) => Math.min(pageCount, current + 1))} disabled={activePage === pageCount}>Next</button>
        </nav>
      </footer>}
      {role === 'public' && <PublicReservationManager />}
    </section>
  )
}

export function MemberBooks({ userId }) {
  const [loans, setLoans] = useState([])
  const [policy, setPolicy] = useState(defaultCirculationPolicy)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [actionMessage, setActionMessage] = useState('')
  const [actionError, setActionError] = useState('')
  const [renewingId, setRenewingId] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let active = true
    const loadLoans = async () => {
      if (!supabase || !userId) {
        if (active) setLoading(false)
        return
      }
      try {
        const [loansResult, policyResult] = await Promise.all([
          fetchAllRows(() => supabase
            .from('loans')
            .select('id, status, checked_out_at, due_at, returned_at, renewal_count, fine_amount, book_copies(barcode, books(title, author, cover_url, category))')
            .in('status', ['borrowed', 'overdue'])
            .order('created_at', { ascending: false })),
          supabase.rpc('get_circulation_policy'),
        ])
        if (!active) return
        if (loansResult.error) setError(loansResult.error.message)
        setLoans(loansResult.data ?? [])
        if (!policyResult.error) setPolicy(normalizeCirculationPolicy(policyResult.data))
      } catch (loadError) {
        if (import.meta.env.DEV) console.error('[member books] load failed', loadError)
        if (active) setError('Unable to load your books. Please try again.')
      } finally {
        if (active) setLoading(false)
      }
    }
    loadLoans()
    return () => { active = false }
  }, [userId, refreshKey])

  return (
    <section className="content-section">
      <PageHeader eyebrow="Member library" title="My books" description="Keep track of the books currently checked out to your account." />
      {actionMessage && <div className="inline-success" role="status">{actionMessage}</div>}
      {actionError && <div className="inline-error" role="alert">{actionError}</div>}
      {error && <div className="inline-error" role="alert">Unable to load your books. Please try again.</div>}
      {loading && <div className="empty-state loading-state">Loading your borrowed books...</div>}
      {!loading && !error && loans.length === 0 && <div className="empty-state large">You do not have any books checked out.</div>}
      {!loading && !error && loans.length > 0 && <div className="loan-grid">{loans.map((loan) => {
        const book = loan.book_copies?.books
        return <article className="loan-card" key={loan.id}>
          <BookCover book={book} />
            <div className="loan-card-content">
            <div className="loan-card-heading"><div><h3>{book?.title || 'Unknown book'}</h3><p>{book?.author || 'Unknown author'}</p></div><StatusBadge value={loan.status} /></div>
            <dl className="detail-list"><div><dt>Borrowed</dt><dd>{formatDate(loan.checked_out_at)}</dd></div><div><dt>Due date</dt><dd>{formatDate(loan.due_at)} {getLoanDueState(loan.due_at, policy.due_soon_days) === 'due-soon' && <span className="table-status warning">Due soon</span>}</dd></div><div><dt>Copy</dt><dd>{loan.book_copies?.barcode || 'Not recorded'}</dd></div><div><dt>Fine</dt><dd>{formatFine(loan.fine_amount)}</dd></div></dl>
            {loan.status === 'borrowed' && getLoanDueState(loan.due_at, policy.due_soon_days) !== 'overdue' && loan.renewal_count < policy.max_renewals && <button type="button" className="table-action" onClick={() => renewLoan(loan.id)} disabled={renewingId === loan.id}>{renewingId === loan.id ? 'Renewing...' : `Renew (${policy.max_renewals - loan.renewal_count} left)`}</button>}
          </div>
        </article>
      })}</div>}
      <div className="requirement-note"><strong>Borrowing rules:</strong> Renewal limits, due dates, borrowing limits, and fines follow the library policy.</div>
    </section>
  )

  async function renewLoan(loanId) {
    if (!supabase) return
    setRenewingId(loanId)
    setActionError('')
    setActionMessage('')
    try {
      const { error: renewError } = await supabase.rpc('renew_loan', { p_loan_id: loanId })
      if (renewError) setActionError('Unable to renew this book. Please check the library borrowing rules and try again.')
      else {
        setActionMessage('Book renewed successfully.')
        setRefreshKey((current) => current + 1)
      }
    } catch (renewError) {
      if (import.meta.env.DEV) console.error('[member books] renewal failed', renewError)
      setActionError('Unable to renew this book. Please try again.')
    } finally {
      setRenewingId('')
    }
  }
}

export function MemberReservations({ userId }) {
  const [reservations, setReservations] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [cancellingId, setCancellingId] = useState('')
  const [confirmingReservation, setConfirmingReservation] = useState(null)

  const loadReservations = useCallback(async () => {
    if (!supabase || !userId) {
      setLoading(false)
      return
    }
    setLoading(true)
    setLoadError('')
    setActionError('')
    try {
      const { data, error: reservationsError } = await fetchAllRows(() => supabase
        .from('reservations')
        .select('id, status, created_at, updated_at, pickup_expires_at, book_copies(barcode), books(title, author, cover_url)')
        .order('created_at', { ascending: false }))
      if (reservationsError) throw reservationsError
      const { data: positions, error: positionsError } = await supabase.rpc('my_reservation_positions')
      if (positionsError) throw positionsError
      const queue = new Map((positions ?? []).map((item) => [item.id, item.queue_position]))
      setReservations((data ?? []).map((item) => ({ ...item, queue_position: queue.get(item.id) })))
    } catch (loadError) {
      if (import.meta.env.DEV) console.error('[member reservations] load failed', loadError)
      setLoadError('Unable to load reservations. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => { void loadReservations() }, [loadReservations])

  const cancelReservation = async (reservation) => {
    if (!supabase) return
    setCancellingId(reservation.id)
    setActionError('')
    try {
      const { error: cancelError } = await supabase.rpc('cancel_reservation', { p_reservation_id: reservation.id })
      if (cancelError) setActionError(cancelError.message)
      else await loadReservations()
    } catch (cancelError) {
      if (import.meta.env.DEV) console.error('[member reservations] cancellation failed', cancelError)
      setActionError('Unable to cancel this reservation. Please try again.')
    } finally {
      setCancellingId('')
      setConfirmingReservation(null)
    }
  }

  const { pageItems, pagination } = usePagination(reservations, userId)


  return (
    <section className="content-section">
      <PageHeader eyebrow="Member library" title="Reservations" description="View your queue requests and cancel an active reservation when permitted." />
      {(loadError || actionError) && <div className="inline-error with-action" role="alert"><span>{actionError ? 'Unable to update reservations. Please try again.' : 'Unable to load reservations. Please try again.'}</span><button type="button" className="retry-button" onClick={loadReservations}>Try again</button></div>}
      {loading && <div className="empty-state loading-state">Loading reservations...</div>}
      {!loading && !loadError && reservations.length === 0 && <div className="empty-state large">You have no reservations.</div>}
      {!loading && !loadError && reservations.length > 0 && <div className="table-wrap"><table><thead><tr><th>Book</th><th>Reserved</th><th>Status</th><th>Queue / pickup</th><th>Action</th></tr></thead><tbody>{pageItems.map((reservation) => <tr key={reservation.id}>
        <td><strong>{reservation.books?.title || 'Unknown book'}</strong><small className="table-subtext">{reservation.books?.author || 'Unknown author'}</small></td>
        <td>{formatDate(reservation.created_at)}</td>
        <td><StatusBadge value={reservation.status} /></td>
        <td>{reservation.status === 'waiting' ? `Position ${reservation.queue_position ?? 'pending'}` : reservation.book_copies?.barcode || '?'}<small className="table-subtext">{reservation.pickup_expires_at ? `Collect by ${new Date(reservation.pickup_expires_at).toLocaleString()}` : ''}</small></td>
        <td>{['waiting', 'ready_for_pickup'].includes(reservation.status) ? <button type="button" className="table-action" onClick={() => setConfirmingReservation(reservation)} disabled={cancellingId === reservation.id}>{cancellingId === reservation.id ? 'Cancelling...' : 'Cancel'}</button> : <span className="muted">No action</span>}</td>
      </tr>)}</tbody></table></div>}
      <div className="requirement-note"><strong>Queue position and expiration:</strong> Waiting positions follow request order. Ready holds show the assigned copy and collection deadline.</div>
      <ConfirmDialog
        open={Boolean(confirmingReservation)}
        title="Cancel reservation?"
        description={`Cancel your reservation for "${confirmingReservation?.books?.title || 'this book'}"?`}
        confirmLabel="Cancel reservation"
        danger
        busy={Boolean(confirmingReservation && cancellingId === confirmingReservation.id)}
        onCancel={() => setConfirmingReservation(null)}
        onConfirm={() => {
          const reservation = confirmingReservation
          if (reservation) void cancelReservation(reservation)
        }}
      />
    {pagination}</section>
  )
}

export function MemberHistory({ userId }) {
  const [history, setHistory] = useState([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    const loadHistory = async () => {
      if (!supabase || !userId) {
        if (active) setLoading(false)
        return
      }
      try {
        const { data, error: historyError } = await fetchAllRows(() => supabase
          .from('loans')
          .select('id, status, checked_out_at, due_at, returned_at, book_copies(books(title, author))')
          .in('status', ['returned', 'lost', 'damaged'])
          .order('created_at', { ascending: false }))
        if (!active) return
        if (historyError) setError(historyError.message)
        setHistory(data ?? [])
      } catch (loadError) {
        if (import.meta.env.DEV) console.error('[member history] load failed', loadError)
        if (active) setError('Unable to load your history. Please try again.')
      } finally {
        if (active) setLoading(false)
      }
    }
    loadHistory()
    return () => { active = false }
  }, [userId])

  const filtered = history.filter((loan) => `${loan.book_copies?.books?.title || ''} ${loan.book_copies?.books?.author || ''}`.toLowerCase().includes(query.trim().toLowerCase()))

  const { pageItems, pagination } = usePagination(filtered, '')


  return (
    <section className="content-section">
      <PageHeader eyebrow="Member library" title="Borrowing history" description="Review completed and closed borrowing transactions. Historical records cannot be edited." />
      <div className="catalog-toolbar single-search"><label className="toolbar-field"><span>Search history</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Book title or author" aria-label="Search borrowing history" /></label></div>
      {error && <div className="inline-error" role="alert">Unable to load your history. Please try again.</div>}
      {loading && <div className="empty-state loading-state">Loading borrowing history...</div>}
      {!loading && !error && filtered.length === 0 && <div className="empty-state large">No matching borrowing history.</div>}
      {!loading && !error && filtered.length > 0 && <div className="table-wrap"><table><thead><tr><th>Book</th><th>Borrowed</th><th>Due</th><th>Returned</th><th>Status</th></tr></thead><tbody>{pageItems.map((loan) => <tr key={loan.id}>
        <td><strong>{loan.book_copies?.books?.title || 'Unknown book'}</strong><small className="table-subtext">{loan.book_copies?.books?.author || 'Unknown author'}</small></td><td>{formatDate(loan.checked_out_at)}</td><td>{formatDate(loan.due_at)}</td><td>{formatDate(loan.returned_at)}</td><td><StatusBadge value={loan.status} /></td>
      </tr>)}</tbody></table></div>}
    {pagination}</section>
  )
}

export function MemberNotifications({ userId }) {
  const [notifications, setNotifications] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')

  const loadNotifications = useCallback(async () => {
    if (!supabase || !userId) {
      setLoading(false)
      return
    }
    setLoading(true)
    setLoadError('')
    setActionError('')
    try {
      const { data, error: notificationsError } = await fetchAllRows(() => supabase.from('notifications').select('id, title, message, read_at, created_at').eq('member_id', userId).order('created_at', { ascending: false }))
      if (notificationsError) setLoadError(notificationsError.message)
      setNotifications(data ?? [])
    } catch (loadError) {
      if (import.meta.env.DEV) console.error('[member notifications] load failed', loadError)
      setLoadError('Unable to load notifications. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => { void loadNotifications() }, [loadNotifications])

  const markRead = async (notification) => {
    if (!supabase || notification.read_at) return
    setActionError('')
    try {
      const readAt = new Date().toISOString()
      const { error: updateError } = await supabase.from('notifications').update({ read_at: readAt }).eq('id', notification.id)
      if (updateError) setActionError(updateError.message)
      else setNotifications((items) => items.map((item) => item.id === notification.id ? { ...item, read_at: readAt } : item))
    } catch (updateError) {
      if (import.meta.env.DEV) console.error('[member notifications] mark read failed', updateError)
      setActionError('Unable to update this notification. Please try again.')
    }
  }

  const { pageItems, pagination } = usePagination(notifications, userId)


  return (
    <section className="content-section">
      <PageHeader eyebrow="Member library" title="Notifications" description="Stay informed about your reservations and borrowing activity." />
      {(loadError || actionError) && <div className="inline-error with-action" role="alert"><span>{actionError ? 'Unable to update notifications. Please try again.' : 'Unable to load notifications. Please try again.'}</span><button type="button" className="retry-button" onClick={loadNotifications}>Try again</button></div>}
      {loading && <div className="empty-state loading-state">Loading notifications...</div>}
      {!loading && !loadError && notifications.length === 0 && <div className="empty-state large">No notifications yet.</div>}
      {!loading && !loadError && notifications.length > 0 && <div className="notification-list">{pageItems.map((notification) => <article className={notification.read_at ? 'notification-item' : 'notification-item unread'} key={notification.id}><div><span className="eyebrow">{formatDate(notification.created_at)}</span><h3>{notification.title}</h3><p>{notification.message}</p></div>{!notification.read_at && <button type="button" className="text-button" onClick={() => markRead(notification)}>Mark as read</button>}</article>)}</div>}
      <div className="requirement-note"><strong>Notification delivery:</strong> Notifications shown here are the messages currently stored for your account.</div>
    {pagination}</section>
  )
}

export function MemberProfile({ userId, session, profile }) {
  const [joinedAt, setJoinedAt] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    const loadProfile = async () => {
      if (!supabase || !userId) {
        if (active) setLoading(false)
        return
      }
      try {
        const { data } = await supabase.from('profiles').select('created_at').eq('id', userId).maybeSingle()
        if (active) setJoinedAt(data?.created_at || '')
      } catch (loadError) {
        if (import.meta.env.DEV) console.error('[member profile] load failed', loadError)
      } finally {
        if (active) setLoading(false)
      }
    }
    loadProfile()
    return () => { active = false }
  }, [userId])

  return (
    <section className="content-section">
      <PageHeader eyebrow="Account" title="Profile" description="Your library account details and access level." />
      <div className="profile-card"><div className="profile-avatar">{(profile?.full_name || profile?.school_id || session?.user?.email || 'U').slice(0, 1).toUpperCase()}</div><div className="profile-fields"><div><span>Full name</span><strong>{profile?.full_name || 'Not provided'}</strong></div><div><span>{profile?.school_id ? 'School ID' : 'Email'}</span><strong>{profile?.school_id || session?.user?.email || 'Not available'}</strong></div><div><span>Member ID</span><strong><code>{userId?.slice(0, 12) || 'Not available'}...</code></strong></div><div><span>Role</span><strong>{profile?.role || 'member'}</strong></div><div><span>Account status</span><strong>{session?.user?.confirmed_at ? 'Confirmed' : 'Pending confirmation'}</strong></div><div><span>Date joined</span><strong>{loading ? 'Loading...' : formatDate(joinedAt)}</strong></div></div></div>
      <div className="requirement-note"><strong>Profile information:</strong> Account details are read-only in the current system.</div>
    </section>
  )
}

export function BookDetailsView({ bookId, role, onBack }) {
  const [book, setBook] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const [cardNumber, setCardNumber] = useState('')
  const [reservationPin, setReservationPin] = useState('')

  useEffect(() => {
    let active = true
    const loadBook = async () => {
      if (!supabase || !bookId) {
        if (active) setLoading(false)
        return
      }
      try {
        const copyColumns = role === 'public' ? 'id, status, location' : 'id, barcode, status, location, condition'
        const { data, error: bookError } = await supabase.from('books').select(`id, title, author, isbn, category, course_subject, description, publication_year, cover_url, created_at, book_copies(${copyColumns})`).eq('id', bookId).maybeSingle()
        if (!active) return
        if (bookError) setError(bookError.message)
        setBook(data)
      } catch (loadError) {
        if (import.meta.env.DEV) console.error('[book details] load failed', loadError)
        if (active) setError('Unable to load this book. Please try again.')
      } finally {
        if (active) setLoading(false)
      }
    }
    loadBook()
    return () => { active = false }
  }, [bookId, role])

  const reserveBook = async (event) => {
    event?.preventDefault()
    if (!supabase || !book) return
    setSaving(true)
    setMessage('')
    setError('')
    try {
      if (role === 'public') {
        const { data, error: reservationError } = await supabase.rpc('reserve_book_by_card', {
          p_card_number: cardNumber.trim(),
          p_pin: reservationPin,
          p_book_id: book.id,
        })
        if (reservationError) throw reservationError
        if (data?.verified === false) {
          setError(describeCardReservationError('card or pin'))
          return
        }
        setMessage(data?.status === 'ready_for_pickup'
          ? `Your hold is ready. Collect it by ${data.pickup_expires_at ? new Date(data.pickup_expires_at).toLocaleString() : 'the deadline shown under My reservations'}.`
          : `Your hold is active at queue position ${data?.queue_position ?? 'pending'}. Check “My reservations” for updates and the pickup deadline.`)
        setReservationPin('')
      } else {
        const { error: reservationError } = await supabase.rpc('reserve_book', { p_book_id: book.id })
        if (reservationError) setError(describeReservationError(reservationError.message))
        else setMessage('Reservation successfully created or already active.')
      }
    } catch (reservationError) {
      if (import.meta.env.DEV) console.error('[book details] reservation failed', reservationError)
      setError(role === 'public' ? describeCardReservationError(reservationError?.message) : describeReservationError(reservationError?.message))
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <section className="content-section"><button type="button" className="back-button" onClick={onBack}>Back to catalog</button><div className="empty-state loading-state">Loading book details...</div></section>
  if (!book) return <section className="content-section"><button type="button" className="back-button" onClick={onBack}>Back to catalog</button><div className="inline-error" role="alert">This book could not be loaded. Please try again.</div></section>

  const copies = book.book_copies ?? []
  const availableCopies = copies.filter((copy) => copy.status === 'available').length
  const availableLocations = [...new Set(copies.filter((copy) => copy.status === 'available').map((copy) => copy.location).filter(Boolean))]
  const hasCirculatingCopies = copies.some((copy) => ['borrowed', 'overdue', 'reserved'].includes(copy.status))

  return (
    <section className="content-section">
      <button type="button" className="back-button" onClick={onBack}>Back to catalog</button>
      {message && <div className="inline-success" role="status">{message}</div>}
      {error && <div className="inline-error" role="alert">{error}</div>}
      <article className="book-detail-card">
        <div className="book-detail-cover"><BookCover book={book} /></div>
        <div className="book-detail-content"><span className={availableCopies > 0 ? 'availability available' : 'availability unavailable'}>{availableCopies > 0 ? 'Available' : 'Unavailable'}</span><h2>{book.title}</h2><p className="book-detail-author">{book.author}</p><p className="book-detail-description">{book.description || 'No description has been added to the catalog yet.'}</p><dl className="detail-list detail-list-wide"><div><dt>ISBN</dt><dd>{book.isbn || 'Not recorded'}</dd></div><div><dt>Course / subject</dt><dd>{book.course_subject || 'Not tagged'}</dd></div><div><dt>Category</dt><dd>{book.category || 'Uncategorized'}</dd></div><div><dt>Publication year</dt><dd>{book.publication_year || 'Not recorded'}</dd></div><div><dt>Total copies</dt><dd>{copies.length}</dd></div><div><dt>Available copies</dt><dd>{availableCopies}</dd></div><div><dt>Shelf location</dt><dd>{availableLocations.join(', ') || 'Ask at the circulation desk'}</dd></div></dl>{role === 'member' && availableCopies === 0 && hasCirculatingCopies && <button className="primary-button detail-action" onClick={reserveBook} disabled={saving}>{saving ? 'Saving reservation...' : 'Reserve book'}</button>}
          {role === 'public' && availableCopies === 0 && copies.length > 0 && hasCirculatingCopies && <form className="tool-form public-reserve-form" onSubmit={reserveBook}>
            <h3>Join the hold queue</h3>
            <p className="muted">Use your library card and the private reservation PIN issued by staff. Check My reservations in the catalog for queue updates and pickup deadlines.</p>
            <label>Library card number<input value={cardNumber} onChange={(event) => setCardNumber(event.target.value)} autoComplete="username" maxLength="100" required /></label>
            <label>Reservation PIN<input type="password" inputMode="numeric" autoComplete="current-password" value={reservationPin} onChange={(event) => setReservationPin(event.target.value.replace(/\D/g, '').slice(0, 12))} minLength="6" maxLength="12" pattern="[0-9]{6,12}" required /></label>
            <button className="primary-button" disabled={saving || !cardNumber.trim() || reservationPin.length < 6}>{saving ? 'Placing hold...' : 'Reserve this book'}</button>
          </form>}
          {role === 'public' && copies.length > 0 && availableCopies === 0 && !hasCirculatingCopies && <p className="requirement-note">No copies are currently circulating, so this title cannot be queued online. Ask library staff for help.</p>}</div>
      </article>
      {role !== 'public' && <div className="requirement-note"><strong>Catalog note:</strong> See Reservations for your queue position, assigned copy, and pickup deadline.</div>}
    </section>
  )
}
