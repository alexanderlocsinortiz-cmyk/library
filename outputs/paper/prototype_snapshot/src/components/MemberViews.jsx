import { usePagination } from './Pagination'
import { fetchAllRows } from '../lib/paging'
import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { ConfirmDialog } from './ConfirmDialog'
import { defaultCirculationPolicy, formatFine, getLoanDueState, normalizeCirculationPolicy } from '../lib/circulation'

const formatDate = (value) => value ? new Date(value).toLocaleDateString() : 'Not set'

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

function StatusBadge({ value }) {
  const label = value?.replaceAll('_', ' ') || 'Unknown'
  const danger = ['overdue', 'lost', 'damaged'].includes(value)
  return <span className={danger ? 'table-status danger' : 'table-status'} data-status={value}>{label}</span>
}

export function CatalogPage({ onBack, role }) {
  const [books, setBooks] = useState([])
  const [search, setSearch] = useState('')
  const [availability, setAvailability] = useState('all')
  const [category, setCategory] = useState('all')
  const [author, setAuthor] = useState('all')
  const [sortBy, setSortBy] = useState('title-asc')
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

  const categories = [...new Set(books.map((book) => book.category).filter(Boolean))].sort()
  const authors = [...new Set(books.map((book) => book.author).filter(Boolean))].sort()
  const filteredBooks = books.filter((book) => {
    const query = `${book.title} ${book.author} ${book.isbn || ''} ${book.category || ''} ${book.course_subject || ''}`.toLowerCase()
    const availableCopies = (book.book_copies || []).filter((copy) => copy.status === 'available').length
    return query.includes(search.trim().toLowerCase())
      && (availability === 'all' || (availability === 'available' && availableCopies > 0) || (availability === 'unavailable' && availableCopies === 0))
      && (category === 'all' || book.category === category)
      && (author === 'all' || book.author === author)
  }).sort((left, right) => {
    if (sortBy === 'title-desc') return right.title.localeCompare(left.title)
    if (sortBy === 'newest') return (right.publication_year || 0) - (left.publication_year || 0)
    return left.title.localeCompare(right.title)
  })

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

  const { pageItems, pagination } = usePagination(filteredBooks, [search, availability, category, author, sortBy].join('|'))


  if (selectedBookId) return <BookDetailsView bookId={selectedBookId} role={role} onBack={() => setSelectedBookId('')} />

  return (
    <section className="content-section">
      <PageHeader eyebrow="Library catalog" title="Search library" description="Find books by title, author, course or subject, and live availability." />
      <div className="catalog-toolbar catalog-filters">
        <label className="toolbar-field"><span>Search catalog</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Title, author, or ISBN" aria-label="Search library" /></label>
        <label className="toolbar-field"><span>Availability</span><select value={availability} onChange={(event) => setAvailability(event.target.value)} aria-label="Filter availability"><option value="all">All availability</option><option value="available">Available</option><option value="unavailable">Unavailable</option></select></label>
        <label className="toolbar-field"><span>Category</span><select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Filter category"><option value="all">All categories</option>{categories.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label className="toolbar-field"><span>Author</span><select value={author} onChange={(event) => setAuthor(event.target.value)} aria-label="Filter author"><option value="all">All authors</option>{authors.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label className="toolbar-field"><span>Sort by</span><select value={sortBy} onChange={(event) => setSortBy(event.target.value)} aria-label="Sort catalog"><option value="title-asc">Title A-Z</option><option value="title-desc">Title Z-A</option><option value="newest">Newest publication</option></select></label>
      </div>
      <p className="catalog-result-count" aria-live="polite">{loading ? 'Loading catalog...' : `${filteredBooks.length} ${filteredBooks.length === 1 ? 'title' : 'titles'} shown`}</p>
      {message && <div className="inline-success" role="status">{message}</div>}
      {error && <div className="inline-error" role="alert">Unable to load the catalog. Please try again.</div>}
      {actionError && <div className="inline-error" role="alert">{actionError}</div>}
      {loading && <div className="empty-state loading-state">Loading catalog...</div>}
      {!loading && !error && filteredBooks.length === 0 && <div className="empty-state large">No books match these filters.</div>}
      {!loading && !error && filteredBooks.length > 0 && <div className="catalog-grid">{pageItems.map((book) => {
        const copies = book.book_copies || []
        const availableCopies = copies.filter((copy) => copy.status === 'available').length
        const status = availableCopies > 0 ? 'Available' : copies.some((copy) => copy.status === 'reserved') ? 'Reserved' : copies.length > 0 ? 'Borrowed' : 'Unavailable'
        return <article className="book-card" key={book.id}><div className="book-cover">{book.cover_url ? <img src={book.cover_url} alt={`Cover of ${book.title}`} /> : <span>BOOK</span>}</div><div className="book-info"><span className={availableCopies > 0 ? 'availability available' : 'availability unavailable'}>{status}{availableCopies > 0 ? ` / ${availableCopies} available` : ''}</span><h3>{book.title}</h3><p className="book-author">{book.author}</p><small>{book.course_subject || book.category || 'Uncategorized'}{book.isbn ? ` / ISBN ${book.isbn}` : ''}</small><div className="book-card-actions"><button className="card-action" onClick={() => setSelectedBookId(book.id)}>View details</button>{role === 'member' && availableCopies === 0 && <button className="card-action" onClick={() => reserve(book.id)} disabled={reservingId === book.id}>{reservingId === book.id ? 'Saving...' : 'Reserve'}</button>}</div></div></article>
      })}</div>}
      <button className="back-button catalog-back" onClick={onBack}>{role === 'public' ? 'Back to sign in' : '← Dashboard'}</button>
    {pagination}</section>
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
      {!loading && !error && loans.length === 0 && <div className="empty-state large">You do not have any active loans.</div>}
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
      <div className="requirement-note"><strong>Circulation policy:</strong> Renewal limits, due-soon status, loan limits, and fines follow the administrator-configured policy.</div>
    </section>
  )

  async function renewLoan(loanId) {
    if (!supabase) return
    setRenewingId(loanId)
    setActionError('')
    setActionMessage('')
    try {
      const { error: renewError } = await supabase.rpc('renew_loan', { p_loan_id: loanId })
      if (renewError) setActionError('Unable to renew this loan. Please check the circulation policy and try again.')
      else {
        setActionMessage('Loan renewed successfully.')
        setRefreshKey((current) => current + 1)
      }
    } catch (renewError) {
      if (import.meta.env.DEV) console.error('[member books] renewal failed', renewError)
      setActionError('Unable to renew this loan. Please try again.')
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

  const reserveBook = async () => {
    if (!supabase || !book) return
    setSaving(true)
    setMessage('')
    setError('')
    try {
      const { error: reservationError } = await supabase.rpc('reserve_book', { p_book_id: book.id })
      if (reservationError) setError(describeReservationError(reservationError.message))
      else setMessage('Reservation successfully created or already active.')
    } catch (reservationError) {
      if (import.meta.env.DEV) console.error('[book details] reservation failed', reservationError)
      setError(describeReservationError(reservationError?.message))
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <section className="content-section"><button type="button" className="back-button" onClick={onBack}>Back to catalog</button><div className="empty-state loading-state">Loading book details...</div></section>
  if (!book) return <section className="content-section"><button type="button" className="back-button" onClick={onBack}>Back to catalog</button><div className="inline-error" role="alert">This book could not be loaded. Please try again.</div></section>

  const copies = book.book_copies ?? []
  const availableCopies = copies.filter((copy) => copy.status === 'available').length
  const reservedCopies = copies.filter((copy) => copy.status === 'reserved').length
  const availableLocations = [...new Set(copies.filter((copy) => copy.status === 'available').map((copy) => copy.location).filter(Boolean))]
  const unavailableLabel = reservedCopies > 0 ? 'Reserved' : copies.some((copy) => copy.status === 'borrowed' || copy.status === 'overdue') ? 'Borrowed' : 'Unavailable'

  return (
    <section className="content-section">
      <button type="button" className="back-button" onClick={onBack}>Back to catalog</button>
      {message && <div className="inline-success" role="status">{message}</div>}
      {error && <div className="inline-error" role="alert">{error}</div>}
      <article className="book-detail-card">
        <div className="book-detail-cover"><BookCover book={book} /></div>
        <div className="book-detail-content"><span className={availableCopies > 0 ? 'availability available' : 'availability unavailable'}>{availableCopies > 0 ? 'Available' : unavailableLabel}</span><h2>{book.title}</h2><p className="book-detail-author">{book.author}</p><p className="book-detail-description">{book.description || 'No description has been added to the catalog yet.'}</p><dl className="detail-list detail-list-wide"><div><dt>ISBN</dt><dd>{book.isbn || 'Not recorded'}</dd></div><div><dt>Course / subject</dt><dd>{book.course_subject || 'Not tagged'}</dd></div><div><dt>Category</dt><dd>{book.category || 'Uncategorized'}</dd></div><div><dt>Publication year</dt><dd>{book.publication_year || 'Not recorded'}</dd></div><div><dt>Total copies</dt><dd>{copies.length}</dd></div><div><dt>Available copies</dt><dd>{availableCopies}</dd></div><div><dt>Shelf location</dt><dd>{availableLocations.join(', ') || 'Ask at the circulation desk'}</dd></div></dl>{role === 'member' && availableCopies === 0 && <button className="primary-button detail-action" onClick={reserveBook} disabled={saving}>{saving ? 'Saving reservation...' : 'Reserve book'}</button>}</div>
      </article>
      {role !== 'public' && <div className="requirement-note"><strong>Catalog note:</strong> See Reservations for your queue position, assigned copy, and pickup deadline.</div>}
    </section>
  )
}
