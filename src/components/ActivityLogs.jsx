import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

const EMPTY_FILTERS = {
  search: '',
  role: '',
  module: '',
  action: '',
  startDate: '',
  endDate: '',
  status: '',
}

const ROLE_LABELS = {
  administrator: 'Administrator',
  librarian: 'Librarian',
  member: 'Member',
  system: 'System',
  unknown: 'Unknown',
}

const MODULE_LABELS = {
  authentication: 'Authentication',
  books: 'Books',
  copies: 'Physical Copies',
  reservations: 'Reservations',
  borrowing: 'Borrowing & Returns',
  members: 'Members',
  administration: 'Administration',
  inventory: 'Inventory',
}

const ACTION_LABELS = {
  account_created: 'Account created',
  account_updated: 'Account updated',
  account_deactivated: 'Account deactivated',
  account_permissions_updated: 'Account permissions updated',
  password_changed: 'Password changed',
  login_success: 'Successful login',
  failed_login: 'Failed login',
  logout: 'Logout',
  book_added: 'Book added',
  book_updated: 'Book edited',
  book_deleted: 'Book deleted',
  copy_added: 'Physical copy added',
  copy_updated: 'Physical copy updated',
  copy_removed: 'Physical copy removed',
  reservation_created: 'Reservation created',
  reservation_updated: 'Reservation updated',
  reservation_cancelled: 'Reservation cancelled',
  reservation_completed: 'Reservation completed',
  reservation_expired: 'Reservation expired',
  reservation_ready: 'Reservation ready for pickup',
  book_borrowed: 'Book borrowed',
  book_returned: 'Book returned',
  due_date_updated: 'Due date updated',
  overdue_status_changed: 'Overdue status changed',
  borrowing_status_changed: 'Borrowing status changed',
  borrowing_transaction_cancelled: 'Borrowing transaction cancelled',
  member_registered: 'Member registered',
  member_updated: 'Member information updated',
  member_deactivated: 'Member account deactivated',
  card_verification_changed: 'Library card verification changed',
  user_role_changed: 'User role changed',
  system_setting_changed: 'System settings changed',
  recovery_invitation_consumed: 'Recovery invitation used',
  reservation_access_pin_reset: 'Reservation access reset',
  book_request_recorded: 'Book request recorded',
  book_request_updated: 'Book request updated',
  inventory_audit_completed: 'Stock audit completed',
  inventory_audit_started: 'Inventory audit started',
}

function formatLabel(value, labels = {}) {
  return labels[value] || (value || 'Unknown').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function formatDateTime(value) {
  if (!value) return 'Not recorded'
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

function formatCount(value) {
  return Number(value || 0).toLocaleString()
}

function safeValueEntries(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return []
  return Object.entries(values).filter(([key]) => !/(password|token|credential|secret|pin|email|phone|school.?id|card.?number)/i.test(key))
}

function ActivityDetailDialog({ record, onClose }) {
  useEffect(() => {
    const closeOnEscape = (event) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  if (!record) return null
  const oldValues = safeValueEntries(record.old_values)
  const newValues = safeValueEntries(record.new_values)

  return <div className="activity-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="activity-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="activity-detail-title">
      <header>
        <div><span className="eyebrow">Activity record</span><h2 id="activity-detail-title">{formatLabel(record.action, ACTION_LABELS)}</h2></div>
        <button type="button" onClick={onClose} aria-label="Close activity details">×</button>
      </header>
      <p className="activity-detail-description">{record.description}</p>
      <dl className="activity-detail-grid">
        <div><dt>Activity ID</dt><dd>{record.id}</dd></div>
        <div><dt>User name</dt><dd>{record.actor_name_snapshot || 'Unknown user'}</dd></div>
        <div><dt>User role</dt><dd>{formatLabel(record.actor_role_snapshot, ROLE_LABELS)}</dd></div>
        <div><dt>Action performed</dt><dd>{formatLabel(record.action, ACTION_LABELS)}</dd></div>
        <div><dt>Affected module</dt><dd>{formatLabel(record.module, MODULE_LABELS)}</dd></div>
        <div><dt>Date and time</dt><dd>{formatDateTime(record.created_at)}</dd></div>
        <div><dt>Status</dt><dd><span className={`activity-status ${record.status}`}>{record.status === 'failure' ? 'Failed' : 'Success'}</span></dd></div>
        <div><dt>Related record ID</dt><dd>{record.entity_id || 'Not recorded'}</dd></div>
        {record.ip_address && <div><dt>IP address</dt><dd>{record.ip_address}</dd></div>}
      </dl>
      {(oldValues.length > 0 || newValues.length > 0) && <div className="activity-value-columns">
        {oldValues.length > 0 && <div><h3>Previous values</h3><dl>{oldValues.map(([key, value]) => <div key={key}><dt>{formatLabel(key)}</dt><dd>{String(value ?? '—')}</dd></div>)}</dl></div>}
        {newValues.length > 0 && <div><h3>Updated values</h3><dl>{newValues.map(([key, value]) => <div key={key}><dt>{formatLabel(key)}</dt><dd>{String(value ?? '—')}</dd></div>)}</dl></div>}
      </div>}
      <footer><button type="button" className="secondary-button" onClick={onClose}>Close</button></footer>
    </section>
  </div>
}

export function ActivityLogs() {
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [page, setPage] = useState(0)
  const [result, setResult] = useState(null)
  const [selectedRecord, setSelectedRecord] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    let active = true
    const loadActivity = async () => {
      if (!supabase) {
        if (active) { setLoading(false); setError('The library database is not configured.') }
        return
      }
      setLoading(true)
      setError('')
      try {
        const { data, error: requestError } = await supabase.rpc('admin_activity_logs', {
          p_search: filters.search.trim(),
          p_role: filters.role,
          p_module: filters.module,
          p_action: filters.action,
          p_start_date: filters.startDate || null,
          p_end_date: filters.endDate || null,
          p_status: filters.status,
          p_page: page,
        })
        if (requestError) throw requestError
        if (active) setResult(data)
      } catch (loadError) {
        if (active) {
          setError(loadError.message || 'Unable to load activity logs.')
          setResult(null)
        }
      } finally {
        if (active) setLoading(false)
      }
    }
    void loadActivity()
    return () => { active = false }
  }, [filters, page, retryKey])

  const records = result?.records || []
  const total = Number(result?.total || 0)
  const totalPages = Math.ceil(total / 10)
  const visiblePages = useMemo(() => {
    if (!totalPages) return []
    const first = Math.max(0, Math.min(page - 2, totalPages - 5))
    return Array.from({ length: Math.min(5, totalPages) }, (_, index) => first + index)
  }, [page, totalPages])
  const summary = result?.summary || {}
  const from = total === 0 ? 0 : page * 10 + 1
  const to = Math.min((page + 1) * 10, total)

  const updateFilter = (key, value) => {
    setFilters((current) => ({ ...current, [key]: value }))
    setPage(0)
  }
  const clearFilters = () => {
    setFilters(EMPTY_FILTERS)
    setPage(0)
  }

  return <section className="content-section activity-logs-page">
    <header className="activity-page-header">
      <span className="eyebrow">System monitoring</span>
      <h2>Activity Logs</h2>
      <p>Monitor user activities and track important actions across the library system.</p>
    </header>

    <div className="staff-summary-grid activity-summary-grid" aria-label="Activity summary">
      <article className="staff-summary-card"><span>Total Activities</span><strong>{loading && !result ? '—' : formatCount(summary.total)}</strong></article>
      <article className="staff-summary-card"><span>Today's Activities</span><strong>{loading && !result ? '—' : formatCount(summary.today)}</strong></article>
      <article className="staff-summary-card"><span>Successful Logins</span><strong>{loading && !result ? '—' : formatCount(summary.successful_logins)}</strong></article>
      <article className="staff-summary-card"><span>Failed Login Attempts</span><strong>{loading && !result ? '—' : formatCount(summary.failed_logins)}</strong></article>
    </div>

    {error && <div className="inline-error with-action" role="alert"><span>{error}</span><button type="button" className="retry-button" onClick={() => setRetryKey((key) => key + 1)}>Try again</button></div>}

    <section className="activity-log-card" aria-label="Activity records and filters">
      <div className="activity-filter-grid">
        <label className="activity-filter-field activity-search-field"><span>Search user or activity</span><input type="search" value={filters.search} onChange={(event) => updateFilter('search', event.target.value)} placeholder="Name or activity" /></label>
        <label className="activity-filter-field"><span>User role</span><select value={filters.role} onChange={(event) => updateFilter('role', event.target.value)}><option value="">All roles</option>{(result?.roles || []).map((role) => <option key={role} value={role}>{formatLabel(role, ROLE_LABELS)}</option>)}</select></label>
        <label className="activity-filter-field"><span>Module</span><select value={filters.module} onChange={(event) => updateFilter('module', event.target.value)}><option value="">All modules</option>{(result?.modules || []).map((module) => <option key={module} value={module}>{formatLabel(module, MODULE_LABELS)}</option>)}</select></label>
        <label className="activity-filter-field"><span>Activity type</span><select value={filters.action} onChange={(event) => updateFilter('action', event.target.value)}><option value="">All activity types</option>{(result?.actions || []).map((action) => <option key={action} value={action}>{formatLabel(action, ACTION_LABELS)}</option>)}</select></label>
        <label className="activity-filter-field"><span>From date</span><input type="date" value={filters.startDate} onChange={(event) => updateFilter('startDate', event.target.value)} /></label>
        <label className="activity-filter-field"><span>To date</span><input type="date" value={filters.endDate} onChange={(event) => updateFilter('endDate', event.target.value)} /></label>
        <label className="activity-filter-field"><span>Status</span><select value={filters.status} onChange={(event) => updateFilter('status', event.target.value)}><option value="">All statuses</option><option value="success">Success</option><option value="failure">Failed</option></select></label>
        <div className="activity-filter-actions"><button type="button" className="secondary-button" onClick={clearFilters} disabled={Object.values(filters).every((value) => !value)}>Clear filters</button></div>
      </div>

      <div className="activity-table-heading"><div><h3>Activity history</h3><p>Newest activities appear first.</p></div><span>{loading ? 'Loading…' : `${formatCount(total)} ${total === 1 ? 'activity' : 'activities'}`}</span></div>
      {loading && <div className="empty-state loading-state">Loading activity records…</div>}
      {!loading && !error && records.length === 0 && <div className="empty-state large">No activity records match these filters.</div>}
      {!loading && !error && records.length > 0 && <>
        <div className="table-wrap activity-table-wrap"><table>
          <thead><tr><th>Date &amp; Time</th><th>User</th><th>Role</th><th>Activity</th><th>Module</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>{records.map((record) => <tr key={record.id}>
            <td><time dateTime={record.created_at}>{formatDateTime(record.created_at)}</time></td>
            <td><strong>{record.actor_name_snapshot || 'Unknown user'}</strong></td>
            <td>{formatLabel(record.actor_role_snapshot, ROLE_LABELS)}</td>
            <td><strong>{formatLabel(record.action, ACTION_LABELS)}</strong><small className="activity-description">{record.description}</small></td>
            <td>{formatLabel(record.module, MODULE_LABELS)}</td>
            <td><span className={`activity-status ${record.status}`}>{record.status === 'failure' ? 'Failed' : 'Success'}</span></td>
            <td><button type="button" className="table-action" onClick={() => setSelectedRecord(record)}>View details</button></td>
          </tr>)}</tbody>
        </table></div>
        <footer className="activity-pagination">
          <span>Showing {from}–{to} of {formatCount(total)} activities</span>
          <nav aria-label="Activity pages">
            <button type="button" onClick={() => setPage((current) => Math.max(current - 1, 0))} disabled={page === 0}>Previous</button>
            {visiblePages.map((pageIndex) => <button type="button" key={pageIndex} className={page === pageIndex ? 'active' : ''} aria-current={page === pageIndex ? 'page' : undefined} onClick={() => setPage(pageIndex)}>{pageIndex + 1}</button>)}
            <button type="button" onClick={() => setPage((current) => Math.min(current + 1, totalPages - 1))} disabled={page >= totalPages - 1}>Next</button>
          </nav>
        </footer>
      </>}
    </section>
    <ActivityDetailDialog record={selectedRecord} onClose={() => setSelectedRecord(null)} />
  </section>
}
