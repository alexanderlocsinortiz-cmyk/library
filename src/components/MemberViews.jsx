import { usePagination } from './Pagination'
import { fetchAllRows } from '../lib/paging'
import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { ConfirmDialog } from './ConfirmDialog'
import { BookCoverArt } from './BookCoverArt'
import { defaultCirculationPolicy, formatFine, getLoanDueState, normalizeCirculationPolicy } from '../lib/circulation'
import { getBookCategories } from '../lib/book-categories'

const formatDate = (value) => value ? new Date(value).toLocaleDateString() : 'Not set'
const CATALOG_PAGE_SIZE = 12

function describeReservationError(message) {
  const normalized = (message || '').toLowerCase()
  if (normalized.includes('not linked') || normalized.includes('verified card')) {
    return 'Your account is not linked to an active library member with a verified library card. Ask library staff to link your account or place the hold at the circulation desk.'
  }
  if (normalized.includes('no physical copies')) return 'The library has no physical copy of this title yet. Ask staff to record an acquisition request.'
  if (normalized.includes('no copies of this title are available or circulating')) return 'There are no usable copies to hold right now. Ask library staff for help.'
  return 'Unable to create the reservation. Please try again or ask library staff for help.'
}

function PageHeader({ eyebrow, title, description, onBack }) {
  return (
    <header className="book-page-header-card member-page-header">
      <div className="book-page-header-copy">
        <span className="eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
        <p className="muted">{description}</p>
      </div>
      {onBack && <button type="button" className="book-page-header-back" onClick={onBack}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /><path d="M20 12H9" /></svg>
        <span>Back to dashboard</span>
      </button>}
    </header>
  )
}

function BookCover({ book }) {
  return <BookCoverArt book={book} className="book-cover compact-cover" externalLookup />
}

function MemberBookThumbnail({ book }) {
  return <BookCoverArt book={book} className="member-book-thumbnail" externalLookup />
}

function CatalogBookCover({ book }) {
  return <BookCoverArt book={book} className="catalog-book-cover" externalLookup />
}

function StatusBadge({ value, reservation }) {
  const reservationLabel = reservation?.status === 'waiting'
    ? reservation.staff_approved_at || reservation.staff_approved ? 'Waiting for a copy' : 'Pending staff approval'
    : reservation?.status === 'ready_for_pickup'
      ? reservation.pickup_confirmed_at || reservation.pickup_confirmed ? 'Ready for pickup' : 'Staff verifying copy'
      : null
  const label = reservationLabel || ({ 'due-soon': 'Due soon', ready_for_pickup: 'Ready for pickup' })[value] || value?.replaceAll('_', ' ') || 'Unknown'
  const danger = ['overdue', 'lost', 'damaged'].includes(value)
  const warning = value === 'due-soon' || value === 'ready_for_pickup'
  return <span className={danger ? 'table-status danger' : warning ? 'table-status warning' : 'table-status'} data-status={value}>{label}</span>
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
    <summary><span>Check or cancel an existing reservation</span><small>Use your library card and staff-issued PIN here. Sign in or register to place a new reservation.</small></summary>
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
        <StatusBadge value={reservation.status} reservation={reservation} />
        <p>{reservation.status === 'waiting'
          ? reservation.staff_approved ? `Queue position ${reservation.queue_position ?? 'pending'}` : 'Waiting for library staff approval'
          : reservation.pickup_confirmed ? `Collect by ${new Date(reservation.pickup_expires_at).toLocaleString()}` : 'Staff is verifying the assigned copy'}</p>
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

export function CatalogPage({ onBack, onSignIn, role, initialSearch = '', initialBookId = '', onInitialBookOpened }) {
  const [books, setBooks] = useState([])
  const [search, setSearch] = useState(initialSearch)
  const [availability, setAvailability] = useState('all')
  const [category, setCategory] = useState('all')
  const [author, setAuthor] = useState('all')
  const [sortBy, setSortBy] = useState('title-asc')
  const [page, setPage] = useState(1)
  const [selectedBookId, setSelectedBookId] = useState(initialBookId)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [message, setMessage] = useState('')
  const [reservingId, setReservingId] = useState('')
  const [reservedBookIds, setReservedBookIds] = useState(() => new Set())
  const catalogPageSize = role === 'member' ? 6 : CATALOG_PAGE_SIZE

  useEffect(() => {
    let active = true
    const loadBooks = async (initialLoad = false) => {
      if (!supabase) {
        if (active) setLoading(false)
        return
      }
      if (initialLoad && active) setLoading(true)
      try {
        const { data, error: booksError } = await fetchAllRows(() => supabase.from('books').select('id, title, author, isbn, category, course_subject, description, publication_year, cover_url, cover_image_path, book_copies(id, status, location)').order('title', { ascending: true }))
        if (!active) return
        if (booksError) setError(booksError.message)
        else setError('')
        setBooks(data ?? [])
      } catch (loadError) {
        if (import.meta.env.DEV) console.error('[catalog] books failed', loadError)
        if (active) setError('Unable to load the catalog. Please try again.')
      } finally {
        if (initialLoad && active) setLoading(false)
      }
    }
    void loadBooks(true)
    const refreshOnFocus = () => { void loadBooks() }
    const refreshOnVisible = () => {
      if (document.visibilityState === 'visible') void loadBooks()
    }
    window.addEventListener('focus', refreshOnFocus)
    document.addEventListener('visibilitychange', refreshOnVisible)
    const channel = supabase?.channel?.('library-catalog-books')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'books' }, () => { void loadBooks() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'book_copies' }, () => { void loadBooks() })
      .subscribe()
    return () => {
      active = false
      window.removeEventListener('focus', refreshOnFocus)
      document.removeEventListener('visibilitychange', refreshOnVisible)
      if (channel) void supabase.removeChannel(channel)
    }
  }, [])

  useEffect(() => {
    if (role !== 'public') return
    setSearch(initialSearch)
    setAvailability('all')
    setCategory('all')
    setAuthor('all')
    setSortBy('title-asc')
  }, [initialSearch, role])

  useEffect(() => {
    if (!selectedBookId) return
    document.documentElement.scrollTop = 0
    document.body.scrollTop = 0
  }, [selectedBookId])

  useEffect(() => {
    if (!initialBookId) return
    setSelectedBookId(initialBookId)
    onInitialBookOpened?.()
  }, [initialBookId, onInitialBookOpened])

  const categories = getBookCategories(books)
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

  const pageCount = Math.max(1, Math.ceil(filteredBooks.length / catalogPageSize))
  const activePage = Math.min(page, pageCount)
  const pageStartIndex = (activePage - 1) * catalogPageSize
  const pageItems = filteredBooks.slice(pageStartIndex, pageStartIndex + catalogPageSize)
  const firstBookNumber = filteredBooks.length === 0 ? 0 : pageStartIndex + 1
  const lastBookNumber = Math.min(pageStartIndex + catalogPageSize, filteredBooks.length)
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
      else {
        setReservedBookIds((current) => new Set(current).add(bookId))
        setMessage('Request submitted. Library staff must approve it before a copy is held.')
      }
    } catch (reservationError) {
      if (import.meta.env.DEV) console.error('[catalog] reservation failed', reservationError)
      setActionError(describeReservationError(reservationError?.message))
    } finally {
      setReservingId('')
    }
  }

  if (selectedBookId) return <BookDetailsView bookId={selectedBookId} role={role} onBack={() => setSelectedBookId('')} onSignIn={onSignIn} />

  return (
    <section className={role === 'member' ? 'content-section catalog-page member-catalog-page' : 'content-section catalog-page'}>
      <header className="book-page-header-card catalog-page-header">
        <div className="book-page-header-copy">
          <span className="eyebrow">Library catalog</span>
          <h2>Browse Books</h2>
          <p>Discover books available in the college library.</p>
        </div>
        {onBack && <button type="button" className="book-page-header-back" onClick={onBack}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /><path d="M20 12H9" /></svg>
          <span>{role === 'public' ? 'Back to home' : 'Back to dashboard'}</span>
        </button>}
      </header>
      <div className="catalog-results-card">
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
      {message && <div className="inline-success catalog-feedback" role="status">{message}</div>}
      {error && <div className="inline-error catalog-feedback" role="alert">Unable to load the catalog. Please try again.</div>}
      {actionError && <div className="inline-error catalog-feedback" role="alert">{actionError}</div>}
      {loading && <div className="catalog-grid catalog-skeleton-grid" role="status" aria-label="Loading catalog books" aria-busy="true">
        <span className="sr-only">Loading catalog...</span>
        {Array.from({ length: catalogPageSize }, (_, index) => <div className="catalog-skeleton-card" key={index} aria-hidden="true"><div className="catalog-skeleton-cover" /><div className="catalog-skeleton-line title-line" /><div className="catalog-skeleton-line author-line" /><div className="catalog-skeleton-pill" /></div>)}
      </div>}
      {!loading && !error && filteredBooks.length === 0 && <div className="empty-state large catalog-empty-state">
        <div><strong>{books.length === 0 ? 'The catalog is empty right now' : 'No books match your search'}</strong><p>{books.length === 0 ? 'Library staff have not added any titles yet. Please ask at the circulation desk.' : 'Try a different search or clear your filters to see more of the collection.'}</p>{books.length > 0 && hasActiveCatalogFilters && <button type="button" className="secondary-button" onClick={clearCatalogFilters}>Clear Filters</button>}</div>
      </div>}
      {!loading && !error && filteredBooks.length > 0 && <div className="catalog-grid">{pageItems.map((book) => {
        const copies = book.book_copies || []
        const availableCopies = copies.filter((copy) => copy.status === 'available').length
        const availableLocations = [...new Set(copies.filter((copy) => copy.status === 'available').map((copy) => copy.location).filter(Boolean))]
        const hasCirculatingCopies = copies.some((copy) => ['borrowed', 'overdue', 'reserved'].includes(copy.status))
        const canReserve = availableCopies > 0 || hasCirculatingCopies
        const subject = book.course_subject || book.category
        return <article className="book-card" key={book.id}>
          <button type="button" className="catalog-card-main" onClick={() => setSelectedBookId(book.id)} aria-label={`View details for ${book.title}`}>
            <CatalogBookCover book={book} />
            <span className="book-info">
              <span className="catalog-card-title" role="heading" aria-level="3">{book.title}</span>
              <span className="book-author">{book.author || 'Author not recorded'}</span>
              <span className={availableCopies > 0 ? 'availability available' : 'availability unavailable'}>{availableCopies > 0 ? `Available · ${availableCopies} / ${copies.length}` : `Unavailable · 0 / ${copies.length}`}</span>
              {subject && <span className="catalog-card-subject" title={subject}>{subject}</span>}
              {availableLocations.length > 0 && <span className="catalog-card-location" title={`Shelf: ${availableLocations.join(', ')}`}>Shelf: {availableLocations.join(', ')}</span>}
            </span>
          </button>
          {role === 'member' && canReserve && <button type="button" className="catalog-card-reserve" onClick={() => reserve(book.id)} disabled={reservingId === book.id || reservedBookIds.has(book.id)}>{reservingId === book.id ? 'Saving...' : reservedBookIds.has(book.id) ? 'Hold placed' : 'Reserve'}</button>}
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
      </div>
      {role === 'public' && <PublicReservationManager />}
    </section>
  )
}

export function MemberBooks({ userId, onBack }) {
  const [loans, setLoans] = useState([])
  const [policy, setPolicy] = useState(defaultCirculationPolicy)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
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
        if (active) { setLoading(false); setError('Your account is not available. Please sign in again.') }
        return
      }
      setLoading(true)
      setError('')
      try {
        const [loansResult, policyResult] = await Promise.all([
          fetchAllRows(() => supabase
            .from('loans')
            .select('id, status, checked_out_at, due_at, returned_at, renewal_count, fine_amount, book_copies(barcode, books(title, author, isbn, cover_url, cover_image_path, category))')
            .in('status', ['borrowed', 'overdue'])
            .order('created_at', { ascending: false })),
          supabase.rpc('get_circulation_policy'),
        ])
        if (!active) return
        if (loansResult.error) throw loansResult.error
        setLoans(loansResult.data ?? [])
        if (!policyResult.error) setPolicy(normalizeCirculationPolicy(policyResult.data))
      } catch (loadError) {
        if (import.meta.env.DEV) console.error('[member books] load failed', loadError)
        if (active) { setLoans([]); setError('Unable to load your books. Please try again.') }
      } finally {
        if (active) setLoading(false)
      }
    }
    loadLoans()
    return () => { active = false }
  }, [userId, refreshKey])

  const filteredLoans = loans.filter((loan) => {
    const book = loan.book_copies?.books
    const searchable = `${book?.title || ''} ${book?.author || ''} ${book?.category || ''} ${loan.book_copies?.barcode || ''}`.toLowerCase()
    const dueState = getLoanDueState(loan.due_at, policy.due_soon_days)
    return searchable.includes(query.trim().toLowerCase())
      && (statusFilter === 'all' || (statusFilter === 'overdue' ? dueState === 'overdue' : statusFilter === 'due-soon' ? dueState === 'due-soon' : dueState === 'on-time'))
  })
  const { pageItems, pagination } = usePagination(filteredLoans, `${userId}:${query.trim()}:${statusFilter}`, 6, { numbered: true, always: true, label: 'borrowed books' })
  const clearFilters = () => { setQuery(''); setStatusFilter('all') }

  return (
    <section className="content-section member-page member-records-page">
      <PageHeader eyebrow="Member library" title="My Books" description="Keep track of the books currently checked out to your account." onBack={onBack} />
      {actionMessage && <div className="inline-success" role="status">{actionMessage}</div>}
      {actionError && <div className="inline-error" role="alert">{actionError}</div>}
      <section className="member-record-card" aria-labelledby="member-books-heading">
        <header className="member-record-card-heading"><div><h3 id="member-books-heading">Current Borrowings</h3><p>Due dates, remaining time, and renewal options for your checked-out books.</p></div><span>{loading ? 'Loading...' : error ? 'Unavailable' : `${filteredLoans.length} ${filteredLoans.length === 1 ? 'book' : 'books'}`}</span></header>
        <div className="member-record-toolbar">
          <label className="member-record-search"><span>Search borrowed books</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, author, subject, or barcode" aria-label="Search borrowed books" /></label>
          <label><span>Status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Filter borrowed books by status"><option value="all">All statuses</option><option value="borrowed">On time</option><option value="due-soon">Due soon</option><option value="overdue">Overdue</option></select></label>
          <button type="button" className="member-clear-filters" onClick={clearFilters} disabled={!query && statusFilter === 'all'}>Clear Filters</button>
        </div>
        {error && <div className="inline-error member-record-error" role="alert"><span>{error}</span><button type="button" className="retry-button" onClick={() => setRefreshKey((current) => current + 1)}>Try again</button></div>}
        <div className="table-wrap member-record-table-wrap">
          {loading ? <div className="empty-state compact loading-state member-record-state">Loading your borrowed books...</div>
            : error ? <div className="empty-state compact member-record-state">Borrowing records are unavailable right now.</div>
              : loans.length === 0 ? <div className="empty-state compact member-record-state">You do not have any books checked out.</div>
                : filteredLoans.length === 0 ? <div className="empty-state compact member-record-state">No borrowed books match these filters.</div>
                  : <table className="member-record-table"><thead><tr><th>Book</th><th>Borrowed</th><th>Due date</th><th>Time remaining</th><th>Status</th><th>Fine</th><th>Action</th></tr></thead><tbody>{pageItems.map((loan) => {
                    const book = loan.book_copies?.books
                    const dueState = getLoanDueState(loan.due_at, policy.due_soon_days)
                    const millisecondsRemaining = new Date(loan.due_at).getTime() - Date.now()
                    const days = Number.isFinite(millisecondsRemaining) ? Math.max(1, Math.ceil(Math.abs(millisecondsRemaining) / 86400000)) : null
                    const displayedStatus = dueState === 'overdue' ? 'overdue' : dueState === 'due-soon' ? 'due-soon' : loan.status
                    return <tr key={loan.id}>
                      <td><span className="member-table-book"><MemberBookThumbnail book={book} /><span><strong>{book?.title || 'Unknown book'}</strong><small>{book?.author || 'Unknown author'}</small><small>Copy {loan.book_copies?.barcode || 'not recorded'}</small></span></span></td>
                      <td>{formatDate(loan.checked_out_at)}</td><td>{formatDate(loan.due_at)}</td>
                      <td>{days === null ? 'Not available' : dueState === 'overdue' ? `${days} ${days === 1 ? 'day' : 'days'} overdue` : `${days} ${days === 1 ? 'day' : 'days'} left`}</td>
                      <td><StatusBadge value={displayedStatus} /></td><td>{formatFine(loan.fine_amount)}</td>
                      <td>{loan.status === 'borrowed' && dueState !== 'overdue' && loan.renewal_count < policy.max_renewals && <button type="button" className="table-action" onClick={() => renewLoan(loan.id)} disabled={renewingId === loan.id}>{renewingId === loan.id ? 'Renewing...' : `Renew (${policy.max_renewals - loan.renewal_count} left)`}</button>}</td>
                    </tr>
                  })}</tbody></table>}
        </div>
        {!loading && !error && filteredLoans.length > 0 && pagination}
      </section>
      <p className="member-policy-note"><strong>Borrowing rules:</strong> Renewal limits, due dates, borrowing limits, and fines follow the library policy.</p>
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

export function MemberReservations({ userId, onBack }) {
  const [reservations, setReservations] = useState([])
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [cancellingId, setCancellingId] = useState('')
  const [confirmingReservation, setConfirmingReservation] = useState(null)

  const loadReservations = useCallback(async () => {
    if (!supabase || !userId) {
      setLoading(false)
      setLoadError('Your account is not available. Please sign in again.')
      return
    }
    setLoading(true)
    setLoadError('')
    setActionError('')
    try {
      const { data, error: reservationsError } = await fetchAllRows(() => supabase
        .from('reservations')
        .select('id, status, created_at, updated_at, pickup_expires_at, staff_approved_at, pickup_confirmed_at, book_copies(barcode), books(title, author, isbn, cover_url, cover_image_path)')
        .order('created_at', { ascending: false }))
      if (reservationsError) throw reservationsError
      const { data: positions, error: positionsError } = await supabase.rpc('my_reservation_positions')
      if (positionsError) throw positionsError
      const queue = new Map((positions ?? []).map((item) => [item.id, item.queue_position]))
      setReservations((data ?? []).map((item) => ({ ...item, queue_position: queue.get(item.id) })))
    } catch (loadError) {
      if (import.meta.env.DEV) console.error('[member reservations] load failed', loadError)
      setReservations([])
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

  const filteredReservations = reservations.filter((reservation) => {
    const searchable = `${reservation.books?.title || ''} ${reservation.books?.author || ''} ${reservation.status || ''} ${reservation.book_copies?.barcode || ''}`.toLowerCase()
    return searchable.includes(query.trim().toLowerCase()) && (statusFilter === 'all' || reservation.status === statusFilter)
  })
  const { pageItems, pagination } = usePagination(filteredReservations, `${userId}:${query.trim()}:${statusFilter}`, 6, { numbered: true, always: true, label: 'reservations' })
  const clearFilters = () => { setQuery(''); setStatusFilter('all') }

  return (
    <section className="content-section member-page member-records-page">
      <PageHeader eyebrow="Member library" title="Reservations" description="View pickup holds and queue requests, then cancel an active reservation when needed." onBack={onBack} />
      <section className="member-record-card" aria-labelledby="member-reservations-heading">
        <header className="member-record-card-heading"><div><h3 id="member-reservations-heading">My Reservations</h3><p>Pickup holds, queue position, deadlines, and reservation status.</p></div><span>{loading ? 'Loading...' : loadError ? 'Unavailable' : `${filteredReservations.length} ${filteredReservations.length === 1 ? 'reservation' : 'reservations'}`}</span></header>
        <div className="member-record-toolbar">
          <label className="member-record-search"><span>Search reservations</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Book title, author, or barcode" aria-label="Search reservations" /></label>
          <label><span>Status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Filter reservations by status"><option value="all">All statuses</option><option value="waiting">Waiting</option><option value="ready_for_pickup">Ready for pickup</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option><option value="expired">Expired</option></select></label>
          <button type="button" className="member-clear-filters" onClick={clearFilters} disabled={!query && statusFilter === 'all'}>Clear Filters</button>
        </div>
        {(loadError || actionError) && <div className="inline-error with-action member-record-error" role="alert"><span>{actionError ? 'Unable to update reservations. Please try again.' : 'Unable to load reservations. Please try again.'}</span><button type="button" className="retry-button" onClick={loadReservations}>Try again</button></div>}
        <div className="table-wrap member-record-table-wrap">
          {loading ? <div className="empty-state compact loading-state member-record-state">Loading reservations...</div>
            : loadError ? <div className="empty-state compact member-record-state">Your reservations are unavailable right now.</div>
              : reservations.length === 0 ? <div className="empty-state compact member-record-state">You have no reservations.</div>
                : filteredReservations.length === 0 ? <div className="empty-state compact member-record-state">No reservations match these filters.</div>
                  : <table className="member-record-table"><thead><tr><th>Book</th><th>Reserved</th><th>Status</th><th>Queue / pickup</th><th>Action</th></tr></thead><tbody>{pageItems.map((reservation) => <tr key={reservation.id}>
                    <td><span className="member-table-book"><MemberBookThumbnail book={reservation.books} /><span><strong>{reservation.books?.title || 'Unknown book'}</strong><small>{reservation.books?.author || 'Unknown author'}</small></span></span></td>
                    <td>{formatDate(reservation.created_at)}</td>
                    <td><StatusBadge value={reservation.status} reservation={reservation} /></td>
                    <td>{reservation.status === 'waiting'
                      ? reservation.staff_approved_at ? `Position ${reservation.queue_position ?? 'pending'}` : 'Waiting for staff approval'
                      : reservation.pickup_confirmed_at ? reservation.book_copies?.barcode || 'Copy assigned' : 'Staff verifying copy'}<small className="table-subtext">{reservation.pickup_confirmed_at && reservation.pickup_expires_at ? `Collect by ${new Date(reservation.pickup_expires_at).toLocaleString()}` : ''}</small></td>
                    <td>{['waiting', 'ready_for_pickup'].includes(reservation.status) ? <button type="button" className="table-action" onClick={() => setConfirmingReservation(reservation)} disabled={cancellingId === reservation.id}>{cancellingId === reservation.id ? 'Cancelling...' : 'Cancel'}</button> : <span className="muted">No action</span>}</td>
                  </tr>)}</tbody></table>}
        </div>
        {!loading && !loadError && filteredReservations.length > 0 && pagination}
      </section>
      <p className="member-policy-note"><strong>Pickup holds and queue order:</strong> Library staff approve reservation requests. Approved requests are served in order; after a copy is assigned, staff verifies it before marking it ready and starting your pickup deadline.</p>
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
    </section>
  )
}

export function MemberHistory({ userId, onBack }) {
  const [history, setHistory] = useState([])
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    let active = true
    const loadHistory = async () => {
      if (!supabase || !userId) {
        if (active) { setLoading(false); setError('Your account is not available. Please sign in again.') }
        return
      }
      setLoading(true)
      setError('')
      try {
        const { data, error: historyError } = await fetchAllRows(() => supabase
          .from('loans')
          .select('id, status, checked_out_at, due_at, returned_at, book_copies(books(title, author))')
          .in('status', ['returned', 'lost', 'damaged'])
          .order('created_at', { ascending: false }))
        if (!active) return
        if (historyError) throw historyError
        setHistory(data ?? [])
      } catch (loadError) {
        if (import.meta.env.DEV) console.error('[member history] load failed', loadError)
        if (active) { setHistory([]); setError('Unable to load your history. Please try again.') }
      } finally {
        if (active) setLoading(false)
      }
    }
    loadHistory()
    return () => { active = false }
  }, [userId, retryKey])

  const filtered = history.filter((loan) => `${loan.book_copies?.books?.title || ''} ${loan.book_copies?.books?.author || ''} ${loan.status || ''}`.toLowerCase().includes(query.trim().toLowerCase())
    && (statusFilter === 'all' || loan.status === statusFilter))
  const { pageItems, pagination } = usePagination(filtered, `${userId}:${query.trim()}:${statusFilter}`, 6, { numbered: true, always: true, label: 'history records' })
  const clearFilters = () => { setQuery(''); setStatusFilter('all') }

  return (
    <section className="content-section member-page member-records-page">
      <PageHeader eyebrow="Member library" title="History" description="Review completed and closed borrowing transactions. Historical records cannot be edited." onBack={onBack} />
      <section className="member-record-card" aria-labelledby="member-history-heading">
        <header className="member-record-card-heading"><div><h3 id="member-history-heading">Borrowing History</h3><p>Completed, lost, and damaged borrowing transactions.</p></div><span>{loading ? 'Loading...' : error ? 'Unavailable' : `${filtered.length} ${filtered.length === 1 ? 'record' : 'records'}`}</span></header>
        <div className="member-record-toolbar">
          <label className="member-record-search"><span>Search history</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Book title, author, or status" aria-label="Search borrowing history" /></label>
          <label><span>Status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Filter history by status"><option value="all">All statuses</option><option value="returned">Returned</option><option value="lost">Lost</option><option value="damaged">Damaged</option></select></label>
          <button type="button" className="member-clear-filters" onClick={clearFilters} disabled={!query && statusFilter === 'all'}>Clear Filters</button>
        </div>
        {error && <div className="inline-error member-record-error" role="alert"><span>{error}</span><button type="button" className="retry-button" onClick={() => setRetryKey((current) => current + 1)}>Try again</button></div>}
        <div className="table-wrap member-record-table-wrap">
          {loading ? <div className="empty-state compact loading-state member-record-state">Loading borrowing history...</div>
            : error ? <div className="empty-state compact member-record-state">Your history is unavailable right now.</div>
              : history.length === 0 ? <div className="empty-state compact member-record-state">No borrowing history is available yet.</div>
                : filtered.length === 0 ? <div className="empty-state compact member-record-state">No history records match these filters.</div>
                  : <table className="member-record-table"><thead><tr><th>Book</th><th>Borrowed</th><th>Due</th><th>Returned</th><th>Status</th></tr></thead><tbody>{pageItems.map((loan) => <tr key={loan.id}>
                    <td><strong>{loan.book_copies?.books?.title || 'Unknown book'}</strong><small className="table-subtext">{loan.book_copies?.books?.author || 'Unknown author'}</small></td><td>{formatDate(loan.checked_out_at)}</td><td>{formatDate(loan.due_at)}</td><td>{formatDate(loan.returned_at)}</td><td><StatusBadge value={loan.status} /></td>
                  </tr>)}</tbody></table>}
        </div>
        {!loading && !error && filtered.length > 0 && pagination}
      </section>
    </section>
  )
}

export function MemberNotifications({ userId, onBack }) {
  const [notifications, setNotifications] = useState([])
  const [query, setQuery] = useState('')
  const [readFilter, setReadFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [retryKey, setRetryKey] = useState(0)

  const loadNotifications = useCallback(async () => {
    if (!supabase || !userId) {
      setLoading(false)
      setLoadError('Your account is not available. Please sign in again.')
      return
    }
    setLoading(true)
    setLoadError('')
    setActionError('')
    try {
      const { data, error: notificationsError } = await fetchAllRows(() => supabase.from('notifications').select('id, title, message, read_at, created_at').eq('member_id', userId).order('created_at', { ascending: false }))
      if (notificationsError) throw notificationsError
      setNotifications(data ?? [])
    } catch (loadError) {
      if (import.meta.env.DEV) console.error('[member notifications] load failed', loadError)
      setNotifications([])
      setLoadError('Unable to load notifications. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => { void loadNotifications() }, [loadNotifications, retryKey])

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

  const filteredNotifications = notifications.filter((notification) => `${notification.title || ''} ${notification.message || ''}`.toLowerCase().includes(query.trim().toLowerCase())
    && (readFilter === 'all' || (readFilter === 'unread' ? !notification.read_at : Boolean(notification.read_at))))
  const { pageItems, pagination } = usePagination(filteredNotifications, `${userId}:${query.trim()}:${readFilter}`, 6, { numbered: true, always: true, label: 'notifications' })
  const clearFilters = () => { setQuery(''); setReadFilter('all') }


  return (
    <section className="content-section member-page member-records-page">
      <PageHeader eyebrow="Member library" title="Notifications" description="Stay informed about your reservations and borrowing activity." onBack={onBack} />
      <section className="member-record-card" aria-labelledby="member-notifications-heading">
        <header className="member-record-card-heading"><div><h3 id="member-notifications-heading">Inbox</h3><p>Updates stored for your member account.</p></div><span>{loading ? 'Loading...' : loadError ? 'Unavailable' : `${filteredNotifications.length} ${filteredNotifications.length === 1 ? 'notification' : 'notifications'}`}</span></header>
        <div className="member-record-toolbar">
          <label className="member-record-search"><span>Search notifications</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title or message" aria-label="Search notifications" /></label>
          <label><span>Read status</span><select value={readFilter} onChange={(event) => setReadFilter(event.target.value)} aria-label="Filter notifications by read status"><option value="all">All notifications</option><option value="unread">Unread</option><option value="read">Read</option></select></label>
          <button type="button" className="member-clear-filters" onClick={clearFilters} disabled={!query && readFilter === 'all'}>Clear Filters</button>
        </div>
        {(loadError || actionError) && <div className="inline-error with-action member-record-error" role="alert"><span>{actionError ? 'Unable to update notifications. Please try again.' : 'Unable to load notifications. Please try again.'}</span><button type="button" className="retry-button" onClick={() => { if (loadError) setRetryKey((current) => current + 1); else void loadNotifications() }}>Try again</button></div>}
        <div className="member-notification-list">
          {loading ? <div className="empty-state compact loading-state member-record-state">Loading notifications...</div>
            : loadError ? <div className="empty-state compact member-record-state">Your notifications are unavailable right now.</div>
              : notifications.length === 0 ? <div className="empty-state compact member-record-state">No notifications yet.</div>
                : filteredNotifications.length === 0 ? <div className="empty-state compact member-record-state">No notifications match these filters.</div>
                  : pageItems.map((notification) => <article className={notification.read_at ? 'notification-item' : 'notification-item unread'} key={notification.id}>
                    <div><span className="member-activity-date">{formatDate(notification.created_at)}</span><h3>{notification.title}</h3><p>{notification.message}</p></div>
                    {!notification.read_at && <button type="button" className="text-button" onClick={() => markRead(notification)}>Mark as read</button>}
                  </article>)}
        </div>
        {!loading && !loadError && filteredNotifications.length > 0 && pagination}
        <p className="member-policy-note"><strong>Notification delivery:</strong> These are the messages currently stored for your account.</p>
      </section>
    </section>
  )
}

export function MemberProfile({ userId, session, profile, onBack }) {
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
    <section className="content-section member-page">
      <PageHeader eyebrow="Account" title="Profile" description="Your library account details and access level." onBack={onBack} />
      <div className="profile-card"><div className="profile-avatar">{(profile?.full_name || profile?.school_id || session?.user?.email || 'U').slice(0, 1).toUpperCase()}</div><div className="profile-fields"><div><span>Full name</span><strong>{profile?.full_name || 'Not provided'}</strong></div><div><span>{profile?.school_id ? 'School ID' : 'Email'}</span><strong>{profile?.school_id || session?.user?.email || 'Not available'}</strong></div><div><span>Member ID</span><strong><code>{userId?.slice(0, 12) || 'Not available'}...</code></strong></div><div><span>Role</span><strong>{profile?.role || 'member'}</strong></div><div><span>Account status</span><strong>{session?.user?.confirmed_at ? 'Confirmed' : 'Pending confirmation'}</strong></div><div><span>Date joined</span><strong>{loading ? 'Loading...' : formatDate(joinedAt)}</strong></div></div></div>
      <div className="requirement-note"><strong>Profile information:</strong> Account details are read-only in the current system.</div>
    </section>
  )
}

export function BookDetailsView({ bookId, role, onBack, onSignIn }) {
  const [book, setBook] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const [reservationPlaced, setReservationPlaced] = useState(false)

  useEffect(() => {
    let active = true
    const loadBook = async () => {
      if (!supabase || !bookId) {
        if (active) setLoading(false)
        return
      }
      try {
        const copyColumns = role === 'public' ? 'id, status, location' : 'id, barcode, status, location, condition'
        const { data, error: bookError } = await supabase.from('books').select(`id, title, author, isbn, category, course_subject, description, publication_year, cover_url, cover_image_path, created_at, book_copies(${copyColumns})`).eq('id', bookId).maybeSingle()
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
    if (!supabase || !book || role !== 'member') return
    setSaving(true)
    setMessage('')
    setError('')
    try {
      const { error: reservationError } = await supabase.rpc('reserve_book', { p_book_id: book.id })
      if (reservationError) setError(describeReservationError(reservationError.message))
      else {
        setReservationPlaced(true)
        setMessage('Request submitted. Library staff must approve it before a copy is held.')
      }
    } catch (reservationError) {
      if (import.meta.env.DEV) console.error('[book details] reservation failed', reservationError)
      setError(describeReservationError(reservationError?.message))
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <section className="content-section"><button type="button" className="catalog-detail-back-button" onClick={onBack}><span aria-hidden="true">←</span> Back to catalog</button><div className="empty-state loading-state">Loading book details...</div></section>
  if (!book) return <section className="content-section"><button type="button" className="catalog-detail-back-button" onClick={onBack}><span aria-hidden="true">←</span> Back to catalog</button><div className="inline-error" role="alert">This book could not be loaded. Please try again.</div></section>

  const copies = book.book_copies ?? []
  const availableCopies = copies.filter((copy) => copy.status === 'available').length
  const availableLocations = [...new Set(copies.filter((copy) => copy.status === 'available').map((copy) => copy.location).filter(Boolean))]
  const hasCirculatingCopies = copies.some((copy) => ['borrowed', 'overdue', 'reserved'].includes(copy.status))
  const canReserve = availableCopies > 0 || hasCirculatingCopies

  return (
    <section className="content-section">
      <button type="button" className="catalog-detail-back-button" onClick={onBack}><span aria-hidden="true">←</span> Back to catalog</button>
      {message && <div className="inline-success" role="status">{message}</div>}
      {error && <div className="inline-error" role="alert">{error}</div>}
      <article className="book-detail-card">
        <div className="book-detail-cover"><BookCover book={book} /></div>
        <div className="book-detail-content"><span className={availableCopies > 0 ? 'availability available' : 'availability unavailable'}>{availableCopies > 0 ? 'Available' : 'Unavailable'}</span><h2>{book.title}</h2><p className="book-detail-author">{book.author}</p><p className="book-detail-description">{book.description || 'No description has been added to the catalog yet.'}</p><dl className="detail-list detail-list-wide"><div><dt>ISBN</dt><dd>{book.isbn || 'Not recorded'}</dd></div><div><dt>Course / subject</dt><dd>{book.course_subject || 'Not tagged'}</dd></div><div><dt>Category</dt><dd>{book.category || 'Uncategorized'}</dd></div><div><dt>Publication year</dt><dd>{book.publication_year || 'Not recorded'}</dd></div><div><dt>Total copies</dt><dd>{copies.length}</dd></div><div><dt>Available copies</dt><dd>{availableCopies}</dd></div><div><dt>Shelf location</dt><dd>{availableLocations.join(', ') || 'Ask at the circulation desk'}</dd></div></dl>{role === 'member' && canReserve && <><button className="primary-button detail-action" onClick={reserveBook} disabled={saving || reservationPlaced}>{saving ? 'Submitting...' : reservationPlaced ? 'Request submitted' : 'Reserve for pickup'}</button><p className="requirement-note">A librarian or administrator must approve your request and confirm the copy before it is marked ready for pickup.</p></>}
          {role === 'public' && copies.length > 0 && canReserve && <div className="requirement-note public-reservation-signin">
            <strong>Sign in to reserve this book</strong>
            <p>Create a member account or sign in to request a pickup hold. Staff approve each request and confirm the assigned copy before you are asked to collect it.</p>
            <button type="button" className="primary-button" onClick={onSignIn}>Sign in or create an account</button>
          </div>}
          {role === 'public' && copies.length > 0 && !canReserve && <p className="requirement-note">There are no usable copies to reserve online right now. Ask library staff for help.</p>}
          {role === 'member' && copies.length > 0 && !canReserve && <p className="requirement-note">There are no usable copies to reserve online right now. Ask library staff for help.</p>}</div>
      </article>
      {role !== 'public' && <div className="requirement-note"><strong>Catalog note:</strong> See Reservations for your queue position, assigned copy, and pickup deadline.</div>}
    </section>
  )
}
