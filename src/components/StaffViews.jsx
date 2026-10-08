import { usePagination } from './Pagination'
import { SchoolInvitations } from './SchoolInvitations'
import { fetchAllRows } from '../lib/paging'
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

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
        ? draft.reservation_pin ? 'Member updated and online reservation PIN set or reset.' : 'Member record updated. Leave the PIN blank to keep existing online reservation access.'
        : draft.reservation_pin ? 'Member registered. Give the cardholder their private reservation PIN.' : 'Member registered for desk checkout. Set a reservation PIN if they should place holds online.')
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
    <PageHeader eyebrow="Staff directory" title="Library members" description="Register verified borrowers by their physical library card. Accounts are optional; link one only after verifying the cardholder and matching School ID." />
    <div className="staff-summary-grid member-summary" aria-label="Member totals">
      <article className="staff-summary-card"><span>All records</span><strong>{loading ? '—' : members.length}</strong></article>
      <article className="staff-summary-card"><span>Active members</span><strong>{loading ? '—' : memberStats.active}</strong></article>
      <article className="staff-summary-card"><span>Card verified</span><strong>{loading ? '—' : memberStats.cardVerified}</strong></article>
      <article className="staff-summary-card"><span>Optional accounts linked</span><strong>{loading ? '—' : memberStats.accountLinked}</strong></article>
    </div>
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
        <label>Online reservation PIN<input type="password" inputMode="numeric" autoComplete="new-password" value={draft.reservation_pin} onChange={(event) => setDraft({ ...draft, reservation_pin: event.target.value.replace(/\D/g, '').slice(0, 12) })} minLength="6" maxLength="12" pattern="[0-9]{6,12}" placeholder={editing ? 'Leave blank to keep current PIN' : '6–12 digits'} /><small className="form-helper">Optional. Set or reset a private PIN so this cardholder can place holds online. The PIN is stored as a hash.</small></label>
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
      <td><strong>{member.full_name}</strong></td><td>{member.library_card_number || 'Needs card verification'}</td><td>{member.school_id || 'Not recorded'}</td><td>{member.member_type}</td><td>{member.auth_user_id ? 'Optional account linked' : (() => { const account = accounts.find((item) => item.school_id && member.school_id && item.school_id.toLowerCase() === member.school_id.toLowerCase()); return account && member.is_active && member.library_card_number ? <button type="button" className="table-action" onClick={() => void linkAccount(member, account)} disabled={linkingMemberId === member.id}>{linkingMemberId === member.id ? 'Linking...' : 'Link verified account'}</button> : 'Desk access only' })()}</td><td><span className="table-status" data-status={member.is_active ? 'active' : 'inactive'}>{member.is_active ? 'Active' : 'Inactive'}</span></td><td><button type="button" className="table-action" onClick={() => editMember(member)}>Edit</button></td>
    </tr>)}</tbody></table></div>}
    {pagination}
  </section>
}

export { StaffReservations } from './StaffReservations'

export function StaffOverdue() {
  const [loans, setLoans] = useState([])
  const [query, setQuery] = useState('')
  const [retryKey, setRetryKey] = useState(0)
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
        if (active) setError('Unable to load overdue books. Please try again.')
      } finally {
        if (active) setLoading(false)
      }
    }
    loadOverdue()
    return () => { active = false }
  }, [retryKey])

  const normalizedQuery = query.trim().toLowerCase()
  const filteredLoans = loans.filter((loan) => `${loan.book_copies?.books?.title || ''} ${loan.member?.full_name || ''} ${loan.member?.library_card_number || ''} ${loan.book_copies?.barcode || ''}`.toLowerCase().includes(normalizedQuery))
  const oldestDueAt = loans.reduce((oldest, loan) => loan.due_at && (!oldest || new Date(loan.due_at) < new Date(oldest)) ? loan.due_at : oldest, null)
  const { pageItems, pagination } = usePagination(filteredLoans, query)


  return <section className="content-section">
    <PageHeader eyebrow="Circulation risk" title="Overdue books" description="Review borrowed books that are past their due date." />
    <div className="staff-summary-grid overdue-summary" aria-label="Overdue summary">
      <article className="staff-summary-card"><span>Overdue books</span><strong>{loading ? '—' : loans.length}</strong></article>
      <article className="staff-summary-card"><span>Oldest due date</span><strong className="summary-date">{loading ? '—' : oldestDueAt ? formatDate(oldestDueAt) : 'None'}</strong></article>
    </div>
    {error && <div className="inline-error with-action" role="alert"><span>Unable to load overdue books. Please try again.</span><button type="button" className="retry-button" onClick={() => setRetryKey((current) => current + 1)}>Try again</button></div>}
    <label className="transaction-search"><span>Search overdue books</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Book, member, library card, or barcode" /></label>
    {loading && <div className="empty-state loading-state">Loading overdue books...</div>}
    {!loading && !error && filteredLoans.length === 0 && <div className="empty-state large">{loans.length ? 'No overdue books match your search.' : 'No books are currently overdue.'}</div>}
    {!loading && !error && filteredLoans.length > 0 && <div className="table-wrap"><table><thead><tr><th>Book</th><th>Member</th><th>Borrowed</th><th>Due date</th><th>Copy</th><th>Status</th></tr></thead><tbody>{pageItems.map((loan) => <tr key={loan.id}><td><strong>{loan.book_copies?.books?.title || 'Unknown book'}</strong></td><td>{loan.member?.full_name || 'Unknown member'}<small className="table-subtext">{loan.member?.library_card_number || ''}</small></td><td>{formatDate(loan.checked_out_at)}</td><td>{formatDate(loan.due_at)}</td><td>{loan.book_copies?.barcode || 'Not recorded'}</td><td><span className="table-status danger" data-status="overdue">Overdue</span></td></tr>)}</tbody></table></div>}
    <div className="requirement-note"><strong>Overdue status:</strong> A book is listed here when its due date has passed.</div>
    {pagination}
  </section>
}
