import { Fragment, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const PAGE_SIZE = 6
const ACTION_FILTERS = [
  ['checkout', 'Checkout'],
  ['return', 'Return'],
  ['renew', 'Renewal'],
  ['reserve', 'Reservation'],
  ['cancel', 'Cancellation'],
  ['reservation_approved', 'Reservation approved'],
  ['walk_in_reservation_create', 'Walk-in reservation'],
  ['pickup_assigned_pending_confirmation', 'Copy assigned'],
  ['pickup_ready', 'Pickup ready'],
  ['reservation_pickup_confirmed', 'Pickup confirmed'],
  ['expired', 'Reservation expired'],
  ['lost', 'Marked lost'],
  ['damaged', 'Marked damaged'],
]

function actionLabel(action) {
  if (!action) return 'Not recorded'
  return action.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function formatDate(value, dateOnly = false) {
  if (!value) return 'Not recorded'
  const parsed = new Date(dateOnly && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value)
  if (Number.isNaN(parsed.getTime())) return String(value)
  return parsed.toLocaleString(undefined, dateOnly
    ? { dateStyle: 'medium' }
    : { dateStyle: 'medium', timeStyle: 'short' })
}

function formatActorType(type) {
  switch (type) {
    case 'administrator': return 'Administrator'
    case 'librarian': return 'Librarian'
    case 'member_self_service': return 'Member (Self-Service)'
    case 'system_automated': return 'System (Automated)'
    default: return 'Not recorded'
  }
}

function formatStatus(status) {
  return status ? actionLabel(status) : 'Not recorded'
}

function valueOrNotRecorded(value) {
  return value === null || value === undefined || value === '' ? 'Not recorded' : value
}

function DetailField({ label, value, date = false, dateOnly = false, status = false }) {
  let displayValue = valueOrNotRecorded(value)
  if (date && value) displayValue = formatDate(value, dateOnly)
  if (typeof value === 'boolean') displayValue = value ? 'Yes' : 'No'
  if (status && value) displayValue = formatStatus(value)

  return <div className="transaction-detail-field">
    <dt>{label}</dt>
    <dd>{status && value
      ? <span className="transaction-detail-status" data-status={value}>{displayValue}</span>
      : displayValue}</dd>
  </div>
}

function ActorCell({ item }) {
  const category = formatActorType(item.actor_type)
  return <div className="transaction-actor">
    <span className="transaction-actor-badge" data-actor-type={item.actor_type || 'not_recorded'}>{category}</span>
    {item.actor_name && item.actor_name !== category && <small className="table-subtext">{item.actor_name}</small>}
  </div>
}

function TransactionDetails({ item }) {
  const isLoan = item.entity_type === 'loan'
  const isReservation = item.entity_type === 'reservation'
  const isCheckout = item.action === 'checkout'
  const isReturn = item.action === 'return'
  const isCancellation = item.action === 'cancel'
  const actor = [formatActorType(item.actor_type), item.actor_name && item.actor_name !== formatActorType(item.actor_type) ? item.actor_name : null]
    .filter(Boolean).join(' / ')

  return <div className="transaction-detail-panel">
    <dl className="transaction-detail-grid">
      <DetailField label="Transaction ID" value={item.transaction_id} />
      <DetailField label="Action" value={item.action} status />
      <DetailField label="Timestamp" value={item.transaction_at} date />
      <DetailField label="Member" value={item.member_name} />
      <DetailField label="Verified School ID" value={item.verified_school_id} />
      <DetailField label="Book title" value={item.book_title} />
      <DetailField label="Copy barcode" value={item.barcode} />
      <DetailField label="Internal Copy ID" value={item.internal_copy_id} />
      <DetailField label="Actual actor" value={actor} />
      <DetailField label="Current linked-record status" value={item.current_record_status} status />
      {isCheckout && <>
        <DetailField label="Checkout date" value={item.checkout_date} date />
        <DetailField label={item.due_date_is_current ? 'Due date (current loan record)' : 'Due date recorded at checkout'} value={item.due_date} date />
        <DetailField label="Return status (current loan record)" value={item.return_status} status />
      </>}
      {isReturn && <>
        <DetailField label="Return date" value={item.return_date} date />
        <DetailField label="Overdue at return" value={item.overdue_at_return} />
        <DetailField label="Fine recorded on event" value={item.recorded_fine_amount} />
      </>}
      {isLoan && item.action === 'renew' && <DetailField label={item.due_date_is_current ? 'Due date (current loan record)' : 'Due date recorded at renewal'} value={item.due_date} date />}
      {isReservation && <>
        <DetailField label="Reservation date" value={item.reservation_date} date dateOnly />
        <DetailField label="Queue position recorded" value={item.queue_position} />
        <DetailField
          label={item.pickup_deadline_is_current ? 'Pickup deadline (current record)' : 'Pickup deadline recorded'}
          value={item.pickup_deadline}
          date
        />
        <DetailField label={item.reservation_status_is_current ? 'Reservation status (current record)' : 'Reservation status at event'} value={item.reservation_status} status />
      </>}
      {isCancellation && <>
        <DetailField label="Cancellation date" value={item.cancellation_date} date />
        <DetailField label="Cancellation reason" value={item.cancellation_reason} />
        <DetailField label="Cancellation performed by" value={actor} />
      </>}
    </dl>
    <p className="transaction-detail-note">Missing historical event data is shown as "Not recorded." Current linked-record values are labeled.</p>
  </div>
}

export function TransactionHistory() {
  const [query, setQuery] = useState('')
  const [actionFilter, setActionFilter] = useState('')
  const [sortOrder, setSortOrder] = useState('newest')
  const [page, setPage] = useState(0)
  const [openTransaction, setOpenTransaction] = useState(null)
  const [result, setResult] = useState({ items: [], total: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    const timer = setTimeout(async () => {
      try {
        const { data, error: loadError } = await supabase.rpc('transaction_history', {
          p_query: query.trim(),
          p_page: page,
          p_size: PAGE_SIZE,
          p_action: actionFilter,
          p_sort: sortOrder,
        })
        if (loadError) throw loadError
        if (active) {
          const total = Number(data?.total || 0)
          if (total > 0 && page * PAGE_SIZE >= total) {
            setPage(Math.max(0, Math.ceil(total / PAGE_SIZE) - 1))
          } else {
            setResult({ items: Array.isArray(data?.items) ? data.items : [], total })
          }
        }
      } catch (loadError) {
        if (active) setError(loadError.message || 'Unable to load transaction history.')
      } finally {
        if (active) setLoading(false)
      }
    }, 200)
    return () => { active = false; clearTimeout(timer) }
  }, [page, query, actionFilter, sortOrder, retryKey])

  const changeFilter = (setter) => (event) => {
    setter(event.target.value)
    setPage(0)
    setOpenTransaction(null)
  }
  const pageCount = Math.max(1, Math.ceil(result.total / PAGE_SIZE))
  const firstResult = result.total ? page * PAGE_SIZE + 1 : 0
  const lastResult = Math.min((page + 1) * PAGE_SIZE, result.total)

  return <section className="content-section transaction-history-section">
    <div className="section-heading page-header">
      <div><span className="eyebrow">Circulation</span><h2>Transaction history</h2><p className="muted">Review recorded checkouts, returns, reservations, and cancellations.</p></div>
    </div>
    <div className="transaction-toolbar">
      <label className="transaction-search">
        <span>Search transactions</span>
        <input
          type="search"
          value={query}
          maxLength={200}
          onChange={changeFilter(setQuery)}
          placeholder="Member, School ID, title, barcode, or transaction ID"
        />
      </label>
      <label className="transaction-filter">
        <span>Action</span>
        <select aria-label="Filter by action" value={actionFilter} onChange={changeFilter(setActionFilter)}>
          <option value="">All actions</option>
          {ACTION_FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label className="transaction-filter">
        <span>Sort by date</span>
        <select aria-label="Sort transactions by date" value={sortOrder} onChange={changeFilter(setSortOrder)}>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
      </label>
    </div>
    {error && <div className="inline-error with-action" role="alert"><span>Unable to load transaction history. Please try again.</span><button type="button" className="retry-button" onClick={() => setRetryKey((current) => current + 1)}>Try again</button></div>}
    {loading ? <div className="empty-state loading-state" role="status">Loading transaction history...</div> : !error && <>
      <p className="catalog-result-count" aria-live="polite">Showing {firstResult}-{lastResult} of {result.total} {result.total === 1 ? 'transaction' : 'transactions'}</p>
      {result.items.length === 0
        ? <div className="empty-state large">{query.trim() || actionFilter ? 'No transactions match these search and filter settings.' : 'No transactions have been recorded yet.'}<p>Checkouts, returns, reservations, and cancellations will appear here.</p></div>
        : <div className="table-wrap">
          <table className="transactions-table">
            <thead><tr><th>Date</th><th>Action</th><th>Member</th><th>Book / copy</th><th>Staff / actor</th><th>Details</th></tr></thead>
            <tbody>{result.items.map((item) => <Fragment key={item.transaction_id}>
              <tr>
                <td>{formatDate(item.transaction_at)}</td>
                <td><span className="table-status" data-status={item.action}>{actionLabel(item.action)}</span></td>
                <td>{valueOrNotRecorded(item.member_name)}{item.verified_school_id && <small className="table-subtext">Verified School ID: {item.verified_school_id}</small>}</td>
                <td>{valueOrNotRecorded(item.book_title)}{item.barcode && <small className="table-subtext">Barcode: {item.barcode}</small>}</td>
                <td><ActorCell item={item} /></td>
                <td><button
                  type="button"
                  className="transaction-details-toggle"
                  aria-expanded={openTransaction === item.transaction_id}
                  aria-controls={`transaction-details-${item.transaction_id}`}
                  onClick={() => setOpenTransaction((current) => current === item.transaction_id ? null : item.transaction_id)}
                >{openTransaction === item.transaction_id ? 'Hide details' : 'Record details'}</button></td>
              </tr>
              {openTransaction === item.transaction_id && <tr className="transaction-expanded-row">
                <td colSpan={6}><div id={`transaction-details-${item.transaction_id}`}><TransactionDetails item={item} /></div></td>
              </tr>}
            </Fragment>)}</tbody>
          </table>
        </div>}
    </>}
    {!loading && !error && result.total > PAGE_SIZE && <nav className="pagination transaction-pagination" aria-label="Transaction history pages">
      <button type="button" disabled={page === 0} onClick={() => { setPage(page - 1); setOpenTransaction(null) }}>Previous</button>
      <span aria-live="polite">Page {page + 1} of {pageCount}</span>
      <button type="button" disabled={page + 1 >= pageCount} onClick={() => { setPage(page + 1); setOpenTransaction(null) }}>Next</button>
    </nav>}
  </section>
}
