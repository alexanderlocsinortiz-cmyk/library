import { usePagination } from './Pagination'
import { SchoolInvitations } from './SchoolInvitations'
import { fetchAllRows } from '../lib/paging'
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { formatFine } from '../lib/circulation'

const formatDate = (value) => value ? new Date(value).toLocaleDateString() : 'Not set'

function PageHeader({ eyebrow, title, description }) {
  return <div className="section-heading page-header"><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2><p className="muted">{description}</p></div></div>
}

export function StaffMembers() {
  const [members, setMembers] = useState([])
  const [accounts, setAccounts] = useState([])
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState({ id: '', full_name: '', library_card_number: '', school_id: '', member_type: 'student', is_active: true, reservation_pin: '' })
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [linkingMemberId, setLinkingMemberId] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const loadMembers = async () => {
    if (!supabase) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    try {
      const [membersResult, accountsResult] = await Promise.all([
        fetchAllRows(() => supabase.from('library_members')
          .select('id, full_name, library_card_number, school_id, member_type, is_active, email_only, auth_user_id, created_at')
          .order('full_name', { ascending: true })),
        fetchAllRows(() => supabase.from('profiles').select('id, full_name, school_id').eq('role', 'member')),
      ])
      const failed = [membersResult, accountsResult].find((result) => result.error)
      if (failed?.error) throw failed.error
      const nextMembers = membersResult.data ?? []
      setMembers(nextMembers)
      setAccounts((accountsResult.data ?? []).filter((account) => !nextMembers.some((member) => member.auth_user_id === account.id)))
    } catch (loadError) {
      if (import.meta.env.DEV) console.error('[staff members] load failed', loadError)
      setError('Unable to load library members. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadMembers() }, [])

  const saveMember = async (event) => {
    event.preventDefault()
    if (!supabase) return
    setSaving(true)
    setError('')
    setMessage('')
    const params = {
      p_full_name: draft.full_name,
      p_library_card_number: draft.library_card_number.trim() || null,
      p_school_id: draft.school_id.trim() || null,
      p_member_type: draft.member_type,
    }
    try {
      const result = editing
        ? await supabase.rpc('update_library_member', { p_member_id: draft.id, ...params, p_is_active: draft.is_active })
        : await supabase.rpc('register_library_member', params)
      if (result.error) throw result.error
      const memberId = editing ? draft.id : result.data
      if (draft.reservation_pin) {
        const { error: pinError } = await supabase.rpc('set_library_card_reservation_pin', {
          p_member_id: memberId,
          p_pin: draft.reservation_pin,
        })
        if (pinError) {
          setDraft((current) => ({ ...current, reservation_pin: '' }))
          setError(`Member record saved, but the online reservation PIN was not set: ${pinError.message}`)
          await loadMembers()
          return
        }
      }
      setMessage(editing
        ? draft.reservation_pin ? 'Member updated and reservation PIN set or reset.' : 'Member record updated. Leave the PIN blank to keep existing PIN access.'
        : draft.reservation_pin ? 'Member registered. Give the cardholder their private reservation PIN.' : 'Member registered for desk checkout. A PIN is optional for account-free reservation lookup.')
      setDraft({ id: '', full_name: '', library_card_number: '', school_id: '', member_type: 'student', is_active: true, reservation_pin: '' })
      setEditing(false)
      await loadMembers()
    } catch (saveError) {
      if (import.meta.env.DEV) console.error('[staff members] save failed', saveError)
      setError(saveError.message || 'Unable to save this member. Check the card number and try again.')
    } finally {
      setSaving(false)
    }
  }

  const editMember = (member) => {
    setDraft({
      id: member.id,
      full_name: member.full_name || '',
      library_card_number: member.library_card_number || '',
      school_id: member.school_id || '',
      member_type: member.member_type || 'other',
      is_active: member.is_active,
      reservation_pin: '',
    })
    setEditing(true)
    setError('')
    setMessage('Editing this library record.')
  }

  const cancelEdit = () => {
    setDraft({ id: '', full_name: '', library_card_number: '', school_id: '', member_type: 'student', is_active: true, reservation_pin: '' })
    setEditing(false)
    setError('')
    setMessage('')
  }

  const linkAccount = async (member, account) => {
    if (!supabase) return
    setLinkingMemberId(member.id)
    setError('')
    setMessage('')
    try {
      const { error: linkError } = await supabase.rpc('link_library_member_account', { p_member_id: member.id, p_profile_id: account.id })
      if (linkError) throw linkError
      setMessage(`Optional account linked for ${member.full_name}.`)
      await loadMembers()
    } catch (linkError) {
      if (import.meta.env.DEV) console.error('[staff members] account link failed', linkError)
      setError(linkError.message || 'Unable to link this account. Verify the cardholder and matching School ID.')
    } finally {
      setLinkingMemberId('')
    }
  }

  const filteredMembers = members.filter((member) => `${member.full_name || ''} ${member.library_card_number || ''} ${member.school_id || ''} ${member.id}`.toLowerCase().includes(query.trim().toLowerCase()))

  const { pageItems, pagination } = usePagination(filteredMembers, query)
  const memberStats = {
    active: members.filter((member) => member.is_active).length,
    cardVerified: members.filter((member) => Boolean(member.library_card_number)).length,
    accountLinked: members.filter((member) => Boolean(member.auth_user_id)).length,
  }


  return <section className="content-section">
    <PageHeader eyebrow="Staff directory" title="Library members" description="Manage physical borrower records and email-only online accounts. Email confirmation does not verify student status or link an account to an existing borrower record." />
    <div className="staff-summary-grid member-summary" aria-label="Member totals">
      <article className="staff-summary-card"><span>All records</span><strong>{loading ? '—' : members.length}</strong></article>
      <article className="staff-summary-card"><span>Active members</span><strong>{loading ? '—' : memberStats.active}</strong></article>
      <article className="staff-summary-card"><span>Card verified</span><strong>{loading ? '—' : memberStats.cardVerified}</strong></article>
      <article className="staff-summary-card"><span>Optional accounts linked</span><strong>{loading ? '—' : memberStats.accountLinked}</strong></article>
    </div>
    {(message || error) && <div className={error ? 'inline-error' : 'inline-success'} role={error ? 'alert' : 'status'}>{error || message}</div>}
    <form className="tool-form member-registration-form" onSubmit={saveMember}>
      <h3>{editing ? 'Update library member' : 'Register a library member'}</h3>
      <div className="form-row three-column">
        <label>Full name<input value={draft.full_name} onChange={(event) => setDraft({ ...draft, full_name: event.target.value })} maxLength="160" required /></label>
        <label>Library card number<input value={draft.library_card_number} onChange={(event) => setDraft({ ...draft, library_card_number: event.target.value })} maxLength="100" required={!editing} /></label>
        <label><span className="member-form-label-copy">School ID <span className="label-note">optional</span></span><input value={draft.school_id} onChange={(event) => setDraft({ ...draft, school_id: event.target.value })} maxLength="100" /></label>
      </div>
      <div className="form-row three-column">
        <label>Member type<select value={draft.member_type} onChange={(event) => setDraft({ ...draft, member_type: event.target.value })}><option value="student">Student</option><option value="teacher">Teacher</option><option value="other">Other</option></select></label>
        {editing && <label className="checkbox-field"><input type="checkbox" checked={draft.is_active} onChange={(event) => setDraft({ ...draft, is_active: event.target.checked })} /> Active library member</label>}
        <label>Reservation PIN<input type="password" inputMode="numeric" autoComplete="new-password" value={draft.reservation_pin} onChange={(event) => setDraft({ ...draft, reservation_pin: event.target.value.replace(/\D/g, '').slice(0, 12) })} minLength="6" maxLength="12" pattern="[0-9]{6,12}" placeholder={editing ? 'Leave blank to keep current PIN' : '6–12 digits'} /><small className="form-helper">Optional. A PIN supports account-free reservation lookup. Email accounts use their confirmed sign-in; the PIN is stored as a hash.</small></label>
      </div>
      <div className="table-actions"><button className="primary-button" disabled={saving}>{saving ? 'Saving...' : editing ? 'Save member' : 'Register member'}</button>{editing && <button type="button" className="secondary-button" onClick={cancelEdit} disabled={saving}>Cancel edit</button>}</div>
      {editing && !draft.library_card_number && <small className="form-helper">This older account has no verified library card number. Add the real card number before using it for checkout.</small>}
    </form>
    <details className="secondary-tool-disclosure">
      <summary><span>Optional account recovery</span><small>For an existing account only, after checking the person's school ID.</small></summary>
      <SchoolInvitations />
    </details>
    <div className="staff-list-heading"><div><h3>Member directory</h3><p className="muted">Search verified borrowers and manage their circulation records.</p></div><span>{loading ? 'Loading…' : `${filteredMembers.length} ${filteredMembers.length === 1 ? 'member' : 'members'}`}</span></div>
    <div className="catalog-toolbar single-search"><label className="toolbar-field"><span>Search members</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, card number, school ID" aria-label="Search members" /></label></div>
    {loading && <div className="empty-state loading-state">Loading members...</div>}
    {!loading && !error && filteredMembers.length === 0 && <div className="empty-state large">No members match your search.</div>}
    {!loading && !error && filteredMembers.length > 0 && <div className="table-wrap"><table><thead><tr><th>Name</th><th>Library card</th><th>School ID</th><th>Type</th><th>Account</th><th>Status</th><th>Action</th></tr></thead><tbody>{pageItems.map((member) => <tr key={member.id}>
      <td><strong>{member.full_name}</strong></td><td>{member.library_card_number || 'Needs card verification'}</td><td>{member.school_id || 'Not recorded'}</td><td>{member.member_type}</td><td>{member.auth_user_id ? (member.email_only ? 'Email-only account' : 'Optional account linked') : (() => { const account = accounts.find((item) => item.school_id && member.school_id && item.school_id.toLowerCase() === member.school_id.toLowerCase()); return account && member.is_active && member.library_card_number ? <button type="button" className="table-action" onClick={() => void linkAccount(member, account)} disabled={linkingMemberId === member.id}>{linkingMemberId === member.id ? 'Linking...' : 'Link verified account'}</button> : 'Desk access only' })()}</td><td><span className="table-status" data-status={member.is_active ? 'active' : 'inactive'}>{member.is_active ? 'Active' : 'Inactive'}</span></td><td><button type="button" className="table-action" onClick={() => editMember(member)}>Edit</button></td>
    </tr>)}</tbody></table></div>}
    {pagination}
  </section>
}

export { StaffReservations } from './StaffReservations'

export function StaffOverdue({ onBack }) {
  const [loans, setLoans] = useState([])
  const [query, setQuery] = useState('')
  const [duration, setDuration] = useState('all')
  const [sortOrder, setSortOrder] = useState('oldest')
  const [selectedLoan, setSelectedLoan] = useState(null)
  const [retryKey, setRetryKey] = useState(0)
  const [loading, setLoading] = useState(true)
  const [dataLoadFailed, setDataLoadFailed] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    const loadOverdue = async () => {
      if (!supabase) {
        if (active) {
          setLoading(false)
          setDataLoadFailed(true)
          setError('The library database is not configured.')
        }
        return
      }
      if (active) {
        setLoading(true)
        setDataLoadFailed(false)
        setError('')
      }
      try {
        const { error: refreshError } = await supabase.rpc('refresh_circulation_statuses')
        if (refreshError) throw refreshError
        const { data, error: loansError } = await fetchAllRows(() => supabase
          .from('loans')
          .select('id, status, checked_out_at, due_at, fine_amount, book_copies(barcode, books(title)), member:library_members!loans_member_id_fkey(full_name, library_card_number, school_id)')
          .eq('status', 'overdue')
          .lt('due_at', new Date().toISOString())
          .order('due_at', { ascending: true }))
        if (loansError) throw loansError
        if (!active) return
        const now = Date.now()
        const actualOverdue = (data ?? []).filter((loan) => {
          const dueTime = new Date(loan.due_at).getTime()
          return loan.status === 'overdue' && Number.isFinite(dueTime) && dueTime < now
        })
        setLoans(actualOverdue)
        setDataLoadFailed(false)
      } catch (loadError) {
        if (import.meta.env.DEV) console.error('[staff overdue] load failed', loadError)
        if (active) {
          setLoans([])
          setDataLoadFailed(true)
          setError('Unable to load overdue books. Please try again.')
        }
      } finally {
        if (active) setLoading(false)
      }
    }
    loadOverdue()
    return () => { active = false }
  }, [retryKey])

  useEffect(() => {
    if (!selectedLoan) return undefined
    const closeOnEscape = (event) => { if (event.key === 'Escape') setSelectedLoan(null) }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [selectedLoan])

  const now = Date.now()
  const daysOverdue = (dueAt) => {
    const dueTime = new Date(dueAt).getTime()
    return Number.isFinite(dueTime) && dueTime < now ? Math.max(1, Math.ceil((now - dueTime) / 86400000)) : 0
  }
  const normalizedQuery = query.trim().toLowerCase()
  const filteredLoans = loans.filter((loan) => {
    const searchable = [
      loan.book_copies?.books?.title || '',
      loan.member?.full_name || '',
      loan.member?.library_card_number || '',
      loan.member?.school_id || '',
      loan.book_copies?.barcode || '',
    ].join(' ').toLowerCase()
    const days = daysOverdue(loan.due_at)
    const matchesDuration = duration === 'all'
      || (duration === 'week' && days <= 7)
      || (duration === 'month' && days >= 8 && days <= 30)
      || (duration === 'older' && days >= 31)
    return searchable.includes(normalizedQuery) && matchesDuration
  }).sort((left, right) => {
    const difference = new Date(left.due_at).getTime() - new Date(right.due_at).getTime()
    return sortOrder === 'oldest' ? difference : -difference
  })
  const oldestDueAt = loans.reduce((oldest, loan) => !oldest || new Date(loan.due_at) < new Date(oldest) ? loan.due_at : oldest, null)
  const totalFines = loans.reduce((total, loan) => total + Math.max(0, Number(loan.fine_amount) || 0), 0)
  const filtersChanged = Boolean(query.trim()) || duration !== 'all' || sortOrder !== 'oldest'
  const { pageItems, pagination } = usePagination(filteredLoans, normalizedQuery + ':' + duration + ':' + sortOrder, 6, { numbered: true, always: true, label: 'overdue records' })
  const clearFilters = () => { setQuery(''); setDuration('all'); setSortOrder('oldest') }

  return <section className="content-section overdue-page">
    <header className="book-page-header-card overdue-page-header">
      <div className="book-page-header-copy">
        <span className="eyebrow">Circulation risk</span>
        <h2>Overdue Books</h2>
        <p>Monitor overdue borrowings, due dates, and outstanding returns.</p>
      </div>
      {onBack && <button type="button" className="book-page-header-back" onClick={onBack}><span aria-hidden="true">&larr;</span> Back to Dashboard</button>}
    </header>

    <div className="staff-summary-grid overdue-summary" aria-label="Overdue summary">
      <article className="staff-summary-card overdue-summary-card">
        <span className="overdue-summary-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21z" /><path d="M4 5.5v13A2.5 2.5 0 0 1 6.5 16H20M8 7h8M8 10h6" /></svg></span>
        <div><span>Total Overdue Books</span><strong>{loading || dataLoadFailed ? '—' : loans.length}</strong></div>
      </article>
      <article className="staff-summary-card overdue-summary-card">
        <span className="overdue-summary-icon calendar-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="5" width="17" height="16" rx="2" /><path d="M7.5 3v4M16.5 3v4M3.5 9h17M8 13h3M8 16h6" /></svg></span>
        <div><span>Oldest Due Date</span><strong className="summary-date">{loading || dataLoadFailed ? '—' : oldestDueAt ? formatDate(oldestDueAt) : '—'}</strong></div>
      </article>
      <article className="staff-summary-card overdue-summary-card">
        <span className="overdue-summary-icon fine-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M15.5 8.5c-.7-.8-1.7-1.2-3-1.2-1.6 0-2.7.8-2.7 2s1 1.8 2.7 2.3 2.7 1 2.7 2.3-1.1 2.2-2.9 2.2c-1.3 0-2.4-.5-3.3-1.4M12 5.8v12.4" /></svg></span>
        <div><span>Total Outstanding Fines</span><strong className="summary-date">{loading || dataLoadFailed ? '—' : formatFine(totalFines)}</strong></div>
      </article>
    </div>

    <section className="overdue-records-card" aria-labelledby="overdue-records-heading">
      <div className="overdue-records-header">
        <div><h3 id="overdue-records-heading">Overdue Records</h3><p>Active loans past their due date, refreshed from the circulation database.</p></div>
        <span>{loading ? 'Loading…' : dataLoadFailed ? 'Unavailable' : filteredLoans.length + (filteredLoans.length === 1 ? ' record' : ' records')}</span>
      </div>
      <div className="overdue-filter-toolbar">
        <label className="overdue-filter-field overdue-search-field"><span>Search records</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Book, borrower, card, School ID, or barcode" aria-label="Search overdue books" /></label>
        <label className="overdue-filter-field"><span>Overdue duration</span><select value={duration} onChange={(event) => setDuration(event.target.value)} aria-label="Filter by overdue duration"><option value="all">Any duration</option><option value="week">1–7 days</option><option value="month">8–30 days</option><option value="older">31+ days</option></select></label>
        <label className="overdue-filter-field"><span>Sort by due date</span><select value={sortOrder} onChange={(event) => setSortOrder(event.target.value)} aria-label="Sort overdue books by due date"><option value="oldest">Oldest due first</option><option value="newest">Newest due first</option></select></label>
        <button type="button" className="overdue-clear-button" onClick={clearFilters} disabled={!filtersChanged}>Clear Filters</button>
      </div>
      {error && <div className="inline-error overdue-load-error" role="alert"><span>{error}</span><button type="button" className="retry-button" onClick={() => setRetryKey((current) => current + 1)}>Try again</button></div>}
      <div className="table-wrap overdue-table-wrap">
        {loading ? <div className="empty-state loading-state overdue-empty-state">Loading overdue books…</div>
          : dataLoadFailed ? <div className="empty-state overdue-empty-state">Overdue records are unavailable until the database connection is restored.</div>
            : loans.length === 0 ? <div className="overdue-empty-state"><span className="overdue-empty-icon" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7a3 3 0 0 1 3-3h18v23H7a3 3 0 0 0-3 3z" /><path d="M4 7v20a3 3 0 0 1 3-3h18M10 9h10M10 13h8" /><path d="m17 19 2.5 2.5L25 16" /></svg></span><strong>No overdue books</strong><p>All borrowed books are currently within their borrowing period.</p></div>
              : filteredLoans.length === 0 ? <div className="overdue-empty-state filtered-empty-state"><strong>No overdue books match these filters</strong><p>Adjust the search or duration filter to see more records.</p><button type="button" className="table-action" onClick={clearFilters}>Clear Filters</button></div>
                : <table className="overdue-table">
                  <thead><tr><th>Book Title</th><th>Borrower</th><th>Library Card / School ID</th><th>Copy Barcode</th><th>Due Date</th><th>Days Overdue</th><th>Fine</th><th>Status</th><th>Actions</th></tr></thead>
                  <tbody>{pageItems.map((loan) => {
                    const days = daysOverdue(loan.due_at)
                    return <tr key={loan.id}>
                      <td><strong>{loan.book_copies?.books?.title || 'Unknown book'}</strong></td>
                      <td>{loan.member?.full_name || 'Unknown borrower'}</td>
                      <td><span>{loan.member?.library_card_number || 'Card not recorded'}</span>{loan.member?.school_id && <small className="table-subtext">School ID · {loan.member.school_id}</small>}</td>
                      <td><code>{loan.book_copies?.barcode || 'Not recorded'}</code></td>
                      <td>{formatDate(loan.due_at)}</td>
                      <td><strong>{days}</strong> {days === 1 ? 'day' : 'days'}</td>
                      <td>{formatFine(loan.fine_amount)}</td>
                      <td><span className="table-status" data-status="overdue">Overdue</span></td>
                      <td><button type="button" className="table-action overdue-details-button" onClick={() => setSelectedLoan(loan)}>View Details</button></td>
                    </tr>
                  })}</tbody>
                </table>}
      </div>
      {pagination}
    </section>

    {selectedLoan && <div className="overdue-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedLoan(null) }}>
      <section className="overdue-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="overdue-detail-title">
        <header><div><span className="eyebrow">Overdue transaction</span><h2 id="overdue-detail-title">{selectedLoan.book_copies?.books?.title || 'Unknown book'}</h2></div><button type="button" className="overdue-dialog-close" onClick={() => setSelectedLoan(null)} aria-label="Close overdue details">&times;</button></header>
        <dl className="overdue-detail-grid">
          <div><dt>Borrower</dt><dd>{selectedLoan.member?.full_name || 'Unknown borrower'}</dd></div>
          <div><dt>Library card</dt><dd>{selectedLoan.member?.library_card_number || 'Not recorded'}</dd></div>
          <div><dt>School ID</dt><dd>{selectedLoan.member?.school_id || 'Not recorded'}</dd></div>
          <div><dt>Copy barcode</dt><dd>{selectedLoan.book_copies?.barcode || 'Not recorded'}</dd></div>
          <div><dt>Borrow date</dt><dd>{formatDate(selectedLoan.checked_out_at)}</dd></div>
          <div><dt>Due date</dt><dd>{formatDate(selectedLoan.due_at)}</dd></div>
          <div><dt>Days overdue</dt><dd>{daysOverdue(selectedLoan.due_at)}</dd></div>
          <div><dt>Outstanding fine</dt><dd>{formatFine(selectedLoan.fine_amount)}</dd></div>
          <div><dt>Status</dt><dd><span className="table-status" data-status="overdue">Overdue</span></dd></div>
        </dl>
        <footer><button type="button" className="secondary-button" onClick={() => setSelectedLoan(null)}>Close</button></footer>
      </section>
    </div>}
  </section>
}
