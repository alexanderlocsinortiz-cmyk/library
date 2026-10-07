import { usePagination } from './Pagination'
import { SchoolInvitations } from './SchoolInvitations'
import { fetchAllRows } from '../lib/paging'
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { ConfirmDialog } from './ConfirmDialog'

const formatDate = (value) => value ? new Date(value).toLocaleDateString() : 'Not set'

function PageHeader({ eyebrow, title, description }) {
  return <div className="section-heading page-header"><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2><p className="muted">{description}</p></div></div>
}

export function StaffMembers() {
  const [members, setMembers] = useState([])
  const [accounts, setAccounts] = useState([])
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState({ id: '', full_name: '', library_card_number: '', school_id: '', member_type: 'student', is_active: true })
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
          .select('id, full_name, library_card_number, school_id, member_type, is_active, auth_user_id, created_at')
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
      setMessage(editing ? 'Library member updated.' : 'Library member registered. No online account is required to borrow at the desk.')
      setDraft({ id: '', full_name: '', library_card_number: '', school_id: '', member_type: 'student', is_active: true })
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
    })
    setEditing(true)
    setError('')
    setMessage('Editing this library record.')
  }

  const cancelEdit = () => {
    setDraft({ id: '', full_name: '', library_card_number: '', school_id: '', member_type: 'student', is_active: true })
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


  return <section className="content-section">
    <PageHeader eyebrow="Staff directory" title="Library members" description="Register verified borrowers by their physical library card. Accounts are optional; link one only after verifying the cardholder and matching School ID." />
    {(message || error) && <div className={error ? 'inline-error' : 'inline-success'} role={error ? 'alert' : 'status'}>{error || message}</div>}
    <form className="tool-form" onSubmit={saveMember}>
      <h3>{editing ? 'Update library member' : 'Register a library member'}</h3>
      <div className="form-row three-column">
        <label>Full name<input value={draft.full_name} onChange={(event) => setDraft({ ...draft, full_name: event.target.value })} maxLength="160" required /></label>
        <label>Library card number<input value={draft.library_card_number} onChange={(event) => setDraft({ ...draft, library_card_number: event.target.value })} maxLength="100" required={!editing} /></label>
        <label>School ID <span className="label-note">optional</span><input value={draft.school_id} onChange={(event) => setDraft({ ...draft, school_id: event.target.value })} maxLength="100" /></label>
      </div>
      <div className="form-row three-column">
        <label>Member type<select value={draft.member_type} onChange={(event) => setDraft({ ...draft, member_type: event.target.value })}><option value="student">Student</option><option value="teacher">Teacher</option><option value="other">Other</option></select></label>
        {editing && <label className="checkbox-field"><input type="checkbox" checked={draft.is_active} onChange={(event) => setDraft({ ...draft, is_active: event.target.checked })} /> Active library member</label>}
      </div>
      <div className="table-actions"><button className="primary-button" disabled={saving}>{saving ? 'Saving...' : editing ? 'Save member' : 'Register member'}</button>{editing && <button type="button" className="secondary-button" onClick={cancelEdit} disabled={saving}>Cancel edit</button>}</div>
      {editing && !draft.library_card_number && <small className="form-helper">This older account has no verified library card number. Add the real card number before using it for checkout.</small>}
    </form>
    <SchoolInvitations />
    <div className="catalog-toolbar single-search"><label className="toolbar-field"><span>Search members</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, card number, school ID" aria-label="Search members" /></label></div>
    {loading && <div className="empty-state loading-state">Loading members...</div>}
    {!loading && !error && filteredMembers.length === 0 && <div className="empty-state large">No members match your search.</div>}
    {!loading && !error && filteredMembers.length > 0 && <div className="table-wrap"><table><thead><tr><th>Name</th><th>Library card</th><th>School ID</th><th>Type</th><th>Account</th><th>Status</th><th>Action</th></tr></thead><tbody>{pageItems.map((member) => <tr key={member.id}>
      <td><strong>{member.full_name}</strong></td><td>{member.library_card_number || 'Needs card verification'}</td><td>{member.school_id || 'Not recorded'}</td><td>{member.member_type}</td><td>{member.auth_user_id ? 'Optional account linked' : (() => { const account = accounts.find((item) => item.school_id && member.school_id && item.school_id.toLowerCase() === member.school_id.toLowerCase()); return account && member.is_active && member.library_card_number ? <button type="button" className="table-action" onClick={() => void linkAccount(member, account)} disabled={linkingMemberId === member.id}>{linkingMemberId === member.id ? 'Linking...' : 'Link verified account'}</button> : 'Desk access only' })()}</td><td><span className="table-status" data-status={member.is_active ? 'active' : 'inactive'}>{member.is_active ? 'Active' : 'Inactive'}</span></td><td><button type="button" className="table-action" onClick={() => editMember(member)}>Edit</button></td>
    </tr>)}</tbody></table></div>}
    {pagination}
  </section>
}

export function StaffReservations() {
  const [reservations, setReservations] = useState([])
  const [members, setMembers] = useState([])
  const [books, setBooks] = useState([])
  const [filter, setFilter] = useState('active')
  const [loading, setLoading] = useState(true)
  const [savingId, setSavingId] = useState('')
  const [savingHold, setSavingHold] = useState(false)
  const [holdMemberId, setHoldMemberId] = useState('')
  const [holdBookId, setHoldBookId] = useState('')
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [message, setMessage] = useState('')
  const [pendingUpdate, setPendingUpdate] = useState(null)

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
      const [reservationsResult, membersResult, booksResult] = await Promise.all([
        fetchAllRows(() => supabase.from('reservations').select('id, book_id, member_id, status, created_at, updated_at, pickup_expires_at, book_copies(barcode), books(title, author), member:library_members!reservations_member_id_fkey(full_name, library_card_number)').order('created_at', { ascending: true })),
        fetchAllRows(() => supabase.from('library_members').select('id, full_name, library_card_number').eq('is_active', true).not('library_card_number', 'is', null).order('full_name')),
        fetchAllRows(() => supabase.from('books').select('id, title, author, book_copies(status)').order('title')),
      ])
      const failed = [reservationsResult, membersResult, booksResult].find((result) => result.error)
      if (failed?.error) throw failed.error
      setReservations(reservationsResult.data ?? [])
      setMembers(membersResult.data ?? [])
      setBooks((booksResult.data ?? []).filter((book) => book.book_copies?.length > 0 && !book.book_copies.some((copy) => copy.status === 'available')))
    } catch (loadError) {
      if (import.meta.env.DEV) console.error('[staff reservations] load failed', loadError)
      setLoadError('Unable to load reservations. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadReservations() }, [])

  const createHold = async (event) => {
    event.preventDefault()
    if (!supabase || !holdMemberId || !holdBookId) return
    setSavingHold(true)
    setActionError('')
    setMessage('')
    try {
      const { error: holdError } = await supabase.rpc('staff_reserve_book', { p_book_id: holdBookId, p_member_id: holdMemberId })
      if (holdError) throw holdError
      setMessage('Hold added to the title queue. If a copy is available, the system assigns it in queue order.')
      setHoldMemberId('')
      setHoldBookId('')
      await loadReservations()
    } catch (holdError) {
      if (import.meta.env.DEV) console.error('[staff reservations] create failed', holdError)
      setActionError(holdError.message || 'Unable to create this hold. Please check the selected member and title.')
    } finally {
      setSavingHold(false)
    }
  }

  const updateStatus = async (reservation, status) => {
    if (!supabase) return
    setSavingId(reservation.id)
    setActionError('')
    setMessage('')
    try {
      const { error: updateError } = await supabase.rpc(status === 'cancelled' ? 'cancel_reservation' : 'promote_next_reservation', status === 'cancelled' ? { p_reservation_id: reservation.id } : { p_book_id: reservation.book_id })
      if (updateError) setActionError(updateError.message)
      else {
        setMessage(status === 'cancelled' ? 'Reservation cancelled; the copy was released.' : 'Available copies assigned in queue order. Requests without available stock remain waiting.')
        await loadReservations()
      }
    } catch (updateError) {
      if (import.meta.env.DEV) console.error('[staff reservations] update failed', updateError)
      setActionError('Unable to update reservations. Please try again.')
    } finally {
      setSavingId('')
      setPendingUpdate(null)
    }
  }

  const visible = reservations.filter((reservation) => filter === 'all' || (filter === 'active' && ['waiting', 'ready_for_pickup'].includes(reservation.status)) || reservation.status === filter)

  const { pageItems, pagination } = usePagination(visible, filter)


  return <section className="content-section">
    <PageHeader eyebrow="Circulation desk" title="Reservations" description="Staff record card-verified requests. The database keeps the queue in first-come-first-served order." />
    {(message || actionError || loadError) && <div className={actionError || loadError ? 'inline-error with-action' : 'inline-success'} role={actionError || loadError ? 'alert' : 'status'}><span>{actionError || loadError || message}</span>{(actionError || loadError) && <button type="button" className="retry-button" onClick={loadReservations}>Try again</button>}</div>}
    <form className="tool-form" onSubmit={createHold}>
      <h3>Add a member to a hold queue</h3>
      <div className="form-row two-column">
        <label>Member<select value={holdMemberId} onChange={(event) => setHoldMemberId(event.target.value)} required><option value="">Select card-verified member</option>{members.map((member) => <option key={member.id} value={member.id}>{member.full_name} · {member.library_card_number}</option>)}</select></label>
        <label>Book title<select value={holdBookId} onChange={(event) => setHoldBookId(event.target.value)} required><option value="">Select title</option>{books.map((book) => <option key={book.id} value={book.id}>{book.title} · {book.author}</option>)}</select></label>
      </div>
      <button className="primary-button" disabled={savingHold || loading || !holdMemberId || !holdBookId}>{savingHold ? 'Adding hold...' : 'Add to queue'}</button>
      {members.length === 0 && !loading && <small className="form-helper">Register a member and record their card number before adding holds.</small>}
    </form>
    <div className="catalog-toolbar single-search"><label className="toolbar-field"><span>Filter reservations</span><select value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filter reservations"><option value="active">Active reservations</option><option value="all">All statuses</option><option value="waiting">Waiting</option><option value="ready_for_pickup">Ready for pickup</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option><option value="expired">Expired</option></select></label></div>
    {loading && <div className="empty-state loading-state">Loading reservations...</div>}
    {!loading && !loadError && visible.length === 0 && <div className="empty-state large">No reservations match this filter.</div>}
    {!loading && !loadError && visible.length > 0 && <div className="table-wrap"><table><thead><tr><th>Book</th><th>Member</th><th>Requested</th><th>Status</th><th>Pickup</th><th>Next action</th></tr></thead><tbody>{pageItems.map((reservation) => <tr key={reservation.id}><td><strong>{reservation.books?.title || 'Unknown book'}</strong><small className="table-subtext">{reservation.books?.author || 'Unknown author'}</small></td><td>{reservation.member?.full_name || 'Unknown member'}<small className="table-subtext">{reservation.member?.library_card_number || ''}</small></td><td>{formatDate(reservation.created_at)}</td><td><span className="table-status" data-status={reservation.status}>{reservation.status.replaceAll('_', ' ')}</span></td><td>{reservation.book_copies?.barcode || 'Unassigned'}<small className="table-subtext">{reservation.pickup_expires_at ? `Collect by ${formatDate(reservation.pickup_expires_at)}` : ''}</small></td><td>{reservation.status === 'waiting' ? <button type="button" className="table-action" onClick={() => setPendingUpdate({ reservation, status: 'ready_for_pickup' })} disabled={savingId === reservation.id}>Allocate next in queue</button> : reservation.status === 'ready_for_pickup' ? <button type="button" className="table-action" onClick={() => setPendingUpdate({ reservation, status: 'cancelled' })} disabled={savingId === reservation.id}>Cancel hold</button> : <span className="muted">No action</span>}</td></tr>)}</tbody></table></div>}
    <div className="requirement-note"><strong>Queue and pickup:</strong> Holds are placed in request order and assigned to a physical copy. Checkout completes a hold; cancellation or expiry releases the copy.</div>
    <ConfirmDialog open={Boolean(pendingUpdate)} title="Update reservation status?" description={`Change this reservation to ${pendingUpdate?.status?.replaceAll('_', ' ')}?`} confirmLabel={pendingUpdate?.status === 'cancelled' ? 'Cancel hold' : 'Allocate copies'} busy={Boolean(pendingUpdate && savingId === pendingUpdate.reservation.id)} onCancel={() => setPendingUpdate(null)} onConfirm={() => { if (pendingUpdate) void updateStatus(pendingUpdate.reservation, pendingUpdate.status) }} />
    {pagination}
  </section>
}

export function StaffOverdue() {
  const [loans, setLoans] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    const loadOverdue = async () => {
      if (!supabase) {
        if (active) setLoading(false)
        return
      }
      try {
        const { error: refreshError } = await supabase.rpc('refresh_circulation_statuses')
      if (refreshError) throw refreshError
        const { data, error: loansError } = await fetchAllRows(() => supabase.from('loans').select('id, status, checked_out_at, due_at, book_copies(barcode, books(title)), member:library_members!loans_member_id_fkey(full_name, library_card_number)').eq('status', 'overdue').order('due_at', { ascending: true }))
        if (!active) return
        if (loansError) setError(loansError.message)
        setLoans(data ?? [])
      } catch (loadError) {
        if (import.meta.env.DEV) console.error('[staff overdue] load failed', loadError)
        if (active) setError('Unable to load overdue loans. Please try again.')
      } finally {
        if (active) setLoading(false)
      }
    }
    loadOverdue()
    return () => { active = false }
  }, [])

  const { pageItems, pagination } = usePagination(loans, '')


  return <section className="content-section"><PageHeader eyebrow="Circulation risk" title="Overdue books" description="Review loans explicitly marked overdue by the current circulation records." />{error && <div className="inline-error" role="alert">Unable to load overdue loans. Please try again.</div>}{loading && <div className="empty-state loading-state">Loading overdue loans...</div>}{!loading && !error && loans.length === 0 && <div className="empty-state large">No loans are currently marked overdue.</div>}{!loading && !error && loans.length > 0 && <div className="table-wrap"><table><thead><tr><th>Book</th><th>Member</th><th>Borrowed</th><th>Due date</th><th>Copy</th><th>Status</th></tr></thead><tbody>{pageItems.map((loan) => <tr key={loan.id}><td>{loan.book_copies?.books?.title || 'Unknown book'}</td><td>{loan.member?.full_name || 'Unknown member'}</td><td>{formatDate(loan.checked_out_at)}</td><td>{formatDate(loan.due_at)}</td><td>{loan.book_copies?.barcode || 'Not recorded'}</td><td><span className="table-status danger" data-status="overdue">Overdue</span></td></tr>)}</tbody></table></div>}<div className="requirement-note"><strong>Overdue status:</strong> This page displays loans already marked overdue in the current records.</div>{pagination}</section>
}
