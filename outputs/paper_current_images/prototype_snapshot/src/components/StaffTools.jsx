import { CirculationHealth } from './CirculationHealth'
import { usePagination } from './Pagination'
import { fetchAllRows } from '../lib/paging'
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { defaultCirculationPolicy, formatFine, normalizeCirculationPolicy } from '../lib/circulation'
import { ConfirmDialog } from './ConfirmDialog'

const emptyBook = { title: '', author: '', isbn: '', category: '', course_subject: '', publication_year: '' }

function ToolHeader({ eyebrow, title, description, onBack }) {
  return (
    <div className="section-heading page-header">
      <div>
        {onBack && <button type="button" className="back-button" onClick={onBack}>Back to dashboard</button>}
        <span className="eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
        <p className="muted">{description}</p>
      </div>
    </div>
  )
}

export function StaffCatalogManager({ onBack, view = 'books' }) {
  const [books, setBooks] = useState([])
  const [book, setBook] = useState(emptyBook)
  const [editingBookId, setEditingBookId] = useState('')
  const [copy, setCopy] = useState({ book_id: '', barcode: '', location: '', condition: 'good' })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [pendingDelete, setPendingDelete] = useState(null)
  const copyCount = books.reduce((total, item) => total + (item.book_copies?.length ?? 0), 0)

  const loadBooks = async () => {
    if (!supabase) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    try {
      const { data, error: loadError } = await fetchAllRows(() => supabase
        .from('books')
        .select('id, title, author, isbn, category, course_subject, publication_year, book_copies(id, barcode, status, location)')
        .order('title', { ascending: true }))
      if (loadError) setError('Unable to load catalog records. Please try again.')
      setBooks(data ?? [])
    } catch (loadError) {
      if (import.meta.env.DEV) console.error('[staff catalog] books failed', loadError)
      setError('Unable to load catalog records. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadBooks() }, [])

  const addBook = async (event) => {
    event.preventDefault()
    setSaving(true)
    setMessage('')
    setError('')
    const payload = {
      ...book,
      publication_year: book.publication_year ? Number(book.publication_year) : null,
    }
    try {
      const result = editingBookId
        ? await supabase.from('books').update({ ...payload, updated_at: new Date().toISOString() }).eq('id', editingBookId)
        : await supabase.from('books').insert(payload)
      if (result.error) setError('Unable to save the book. Please check the form and try again.')
      else {
        setMessage(editingBookId ? 'Book details updated.' : 'Book added to the catalog.')
        setBook(emptyBook)
        setEditingBookId('')
        await loadBooks()
      }
    } catch (saveError) {
      if (import.meta.env.DEV) console.error('[staff catalog] save book failed', saveError)
      setError('Unable to save the book. Please check the form and try again.')
    } finally {
      setSaving(false)
    }
  }

  const startEditing = (item) => {
    setEditingBookId(item.id)
    setBook({ title: item.title || '', author: item.author || '', isbn: item.isbn || '', category: item.category || '', course_subject: item.course_subject || '', publication_year: item.publication_year || '' })
    setMessage('Editing this book record.')
    setError('')
  }

  const cancelEditing = () => {
    setEditingBookId('')
    setBook(emptyBook)
    setMessage('')
  }

  const deleteBook = async (bookId) => {
    setSaving(true)
    setMessage('')
    setError('')
    try {
      const { error: deleteError } = await supabase.rpc('delete_book_record', { p_book_id: bookId })
      if (deleteError) setError('Unable to delete this book. Loan history or active reservations may still exist.')
      else {
        setMessage('Book deleted from the catalog.')
        if (editingBookId === bookId) cancelEditing()
        await loadBooks()
      }
    } catch (deleteError) {
      if (import.meta.env.DEV) console.error('[staff catalog] delete book failed', deleteError)
      setError('Unable to delete this book. Please try again.')
    } finally {
      setSaving(false)
      setPendingDelete(null)
    }
  }

  const addCopy = async (event) => {
    event.preventDefault()
    setSaving(true)
    setMessage('')
    setError('')
    try {
      const { error: insertError } = await supabase.from('book_copies').insert(copy)
      if (insertError) setError('Unable to add the physical copy. Check the barcode and try again.')
      else {
        setMessage('Physical copy added.')
        setCopy({ book_id: '', barcode: '', location: '', condition: 'good' })
        await loadBooks()
      }
    } catch (saveError) {
      if (import.meta.env.DEV) console.error('[staff catalog] save copy failed', saveError)
      setError('Unable to add the physical copy. Check the barcode and try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="content-section">
      <ToolHeader
        eyebrow={view === 'copies' ? 'Library inventory' : 'Catalog management'}
        title={view === 'copies' ? 'Physical copies' : 'Books'}
        description={view === 'copies' ? 'Register physical copies and review their current status.' : 'Create book records and register physical copies.'}
        onBack={onBack}
      />
      {(message || error) && <div role={error ? 'alert' : 'status'} className={error ? 'inline-error with-action' : 'inline-success'}><span>{error || message}</span>{error && <button type="button" className="retry-button" onClick={loadBooks}>Try again</button>}</div>}
      <div className={view === 'books' ? 'form-grid two-column' : 'form-grid one-column'}>
        {view === 'books' && (
        <form className="tool-form" onSubmit={addBook}>
          <h3>{editingBookId ? 'Edit book title' : 'Add book title'}</h3>
          <label>Edit existing record <span className="label-note">optional</span><select value={editingBookId} onChange={(event) => event.target.value ? startEditing(books.find((item) => item.id === event.target.value)) : cancelEditing()}><option value="">Create a new book</option>{books.map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label>
          <label>Title<input value={book.title} onChange={(event) => setBook({ ...book, title: event.target.value })} required /></label>
          <label>Author<input value={book.author} onChange={(event) => setBook({ ...book, author: event.target.value })} required /></label>
          <label>ISBN<input value={book.isbn} onChange={(event) => setBook({ ...book, isbn: event.target.value })} /></label>
          <div className="form-row">
            <label>Category<input value={book.category} onChange={(event) => setBook({ ...book, category: event.target.value })} /></label>
            <label>Publication year<input type="number" value={book.publication_year} onChange={(event) => setBook({ ...book, publication_year: event.target.value })} /></label>
          </div>
          <label>Course / subject tags<input value={book.course_subject} onChange={(event) => setBook({ ...book, course_subject: event.target.value })} maxLength={200} placeholder="e.g. Accounting, Business Management" /><small className="form-helper">Enter the course or subject names students would search for.</small></label>
          <div className="form-actions"><button className="primary-button" disabled={saving}>{editingBookId ? 'Save changes' : 'Add book'}</button>{editingBookId && <button className="secondary-button" type="button" onClick={cancelEditing}>Cancel</button>}</div>
        </form>
        )}
        <form className="tool-form" onSubmit={addCopy}>
          <h3>Add physical copy</h3>
          <label>Book
            <select value={copy.book_id} onChange={(event) => setCopy({ ...copy, book_id: event.target.value })} required>
              <option value="">Select a book</option>
              {books.map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}
            </select>
          </label>
          <label>Barcode<input value={copy.barcode} onChange={(event) => setCopy({ ...copy, barcode: event.target.value })} required /></label>
          <div className="form-row">
            <label>Location<input value={copy.location} onChange={(event) => setCopy({ ...copy, location: event.target.value })} placeholder="Library shelf" /></label>
            <label>Condition<select value={copy.condition} onChange={(event) => setCopy({ ...copy, condition: event.target.value })}><option>good</option><option>new</option><option>worn</option></select></label>
          </div>
          <button className="primary-button" disabled={saving || books.length === 0}>Add copy</button>
        </form>
      </div>
      <div className="table-wrap tool-table">
        {loading ? <div className="empty-state loading-state">Loading catalog...</div> : books.length === 0 || (view === 'copies' && copyCount === 0) ? <div className="empty-state">{view === 'copies' ? 'No physical copies have been added yet.' : 'No books have been added yet.'}</div> : view === 'books' ? (
          <table>
            <thead><tr><th>Title</th><th>Author</th><th>Course / subject</th><th>Copies</th><th>Available</th><th>Action</th></tr></thead>
            <tbody>{books.map((item) => {
              const copies = item.book_copies ?? []
              return <tr key={item.id}><td><strong>{item.title}</strong></td><td>{item.author}</td><td>{item.course_subject || item.category || 'Not tagged'}</td><td>{copies.length}</td><td>{copies.filter((itemCopy) => itemCopy.status === 'available').length}</td><td><button type="button" className="table-action danger-action" onClick={() => setPendingDelete(item)} disabled={saving}>Delete</button></td></tr>
            })}</tbody>
          </table>
        ) : (
          <table>
            <thead><tr><th>Book</th><th>Copy ID</th><th>Location</th><th>Status</th></tr></thead>
            <tbody>{books.flatMap((item) => (item.book_copies ?? []).map((itemCopy) => <tr key={itemCopy.id}><td><strong>{item.title}</strong><small className="table-subtext">{item.author}</small></td><td>{itemCopy.barcode || 'Not recorded'}</td><td>{itemCopy.location || 'Not recorded'}</td><td><span className="table-status" data-status={itemCopy.status}>{itemCopy.status?.replaceAll('_', ' ') || 'Unknown'}</span></td></tr>))}</tbody>
          </table>
        )}
      </div>
      <ConfirmDialog open={Boolean(pendingDelete)} title="Delete this catalog record?" description={`Delete “${pendingDelete?.title || 'this book'}”? The database will block deletion when loan history or active reservations exist.`} confirmLabel="Delete book" danger busy={Boolean(saving && pendingDelete)} onCancel={() => setPendingDelete(null)} onConfirm={() => { if (pendingDelete) void deleteBook(pendingDelete.id) }} />
    </section>
  )
}

export function AdminPanel({ onBack, userId }) {
  const [profiles, setProfiles] = useState([])
  const [policy, setPolicy] = useState(defaultCirculationPolicy)
  const [loading, setLoading] = useState(true)
  const [policyLoading, setPolicyLoading] = useState(true)
  const [policySaving, setPolicySaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const loadProfiles = async () => {
    if (!supabase) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    try {
      const { data, error: profilesError } = await fetchAllRows(() => supabase.from('profiles').select('id, full_name, school_id, role, created_at').order('created_at', { ascending: false }))
      if (profilesError) setError('Unable to load users. Please try again.')
      setProfiles(data ?? [])
    } catch (loadError) {
      if (import.meta.env.DEV) console.error('[admin] users failed', loadError)
      setError('Unable to load users. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadProfiles() }, [])

  const loadPolicy = async () => {
    if (!supabase) {
      setPolicyLoading(false)
      return
    }
    try {
      const { data, error: policyError } = await supabase.from('system_settings').select('key, value').in('key', Object.keys(defaultCirculationPolicy))
      if (policyError) {
        setError('Unable to load circulation policy. Please run the latest database migration.')
        return
      }
      const values = Object.fromEntries((data ?? []).map((item) => [item.key, item.value]))
      setPolicy(normalizeCirculationPolicy({ ...defaultCirculationPolicy, ...values }))
    } catch (policyError) {
      if (import.meta.env.DEV) console.error('[admin] policy load failed', policyError)
      setError('Unable to load circulation policy. Please try again.')
    } finally {
      setPolicyLoading(false)
    }
  }

  useEffect(() => { loadPolicy() }, [])

  const updateRole = async (id, role) => {
    setMessage('')
    setError('')
    try {
      const { error: updateError } = await supabase.rpc('change_member_role', { p_member_id: id, p_role: role })
      if (updateError) setError(updateError.message)
      else {
        setMessage('Role updated. The user must sign in again to refresh access.')
        await loadProfiles()
      }
    } catch (updateError) {
      if (import.meta.env.DEV) console.error('[admin] role update failed', updateError)
      setError('Unable to update this role. Please try again.')
    }
  }

  const savePolicy = async (event) => {
    event.preventDefault()
    if (!supabase) return
    setPolicySaving(true)
    setError('')
    setMessage('')
    try {
      const rows = Object.entries(policy).map(([key, value]) => ({ key, value, updated_by: userId || null }))
      const { error: policyError } = await supabase.from('system_settings').upsert(rows, { onConflict: 'key' })
      if (policyError) setError('Unable to save circulation policy. Please check the values and try again.')
      else setMessage('Circulation policy saved.')
    } catch (policyError) {
      if (import.meta.env.DEV) console.error('[admin] policy save failed', policyError)
      setError('Unable to save circulation policy. Please try again.')
    } finally {
      setPolicySaving(false)
    }
  }

  const { pageItems, pagination } = usePagination(profiles, '')


  return (
    <section className="content-section">
      <ToolHeader eyebrow="Administrator tools" title="User roles" description="Manage the three approved roles. Users must sign in again after a role change." onBack={onBack} />
      {(message || error) && <div role={error ? 'alert' : 'status'} className={error ? 'inline-error with-action' : 'inline-success'}><span>{error || message}</span>{error && <button type="button" className="retry-button" onClick={loadProfiles}>Try again</button>}</div>}
      <div className="table-wrap tool-table">
        {loading ? <div className="empty-state loading-state">Loading users...</div> : profiles.length === 0 ? <div className="empty-state">No users found.</div> : (
          <table>
            <thead><tr><th>Name</th><th>School ID</th><th>User ID</th><th>Role</th><th>Created</th></tr></thead>
            <tbody>{pageItems.map((profile) => <tr key={profile.id}>
              <td>{profile.full_name || 'Unnamed user'}</td>
              <td>{profile.school_id || 'Not set'}</td>
              <td><code>{profile.id.slice(0, 8)}...</code></td>
              <td><label className="sr-only" htmlFor={`role-${profile.id}`}>Role for {profile.full_name || 'this user'}</label><select id={`role-${profile.id}`} value={profile.role} onChange={(event) => updateRole(profile.id, event.target.value)}><option value="member">Member</option><option value="librarian">Librarian</option><option value="administrator">Administrator</option></select></td>
              <td>{new Date(profile.created_at).toLocaleDateString()}</td>
            </tr>)}</tbody>
          </table>
        )}
      </div>
      <CirculationHealth />
      <form className="tool-form policy-form" onSubmit={savePolicy}>
        <h3>Circulation policy</h3>
        <p className="muted">These values are enforced by the database after all database migrations are applied.</p>
        {policyLoading ? <div className="empty-state loading-state">Loading policy...</div> : <>
          <div className="form-row three-column">
            <label>Loan period (1–3 days)<input type="number" min="1" max="3" value={policy.loan_period_days} onChange={(event) => setPolicy({ ...policy, loan_period_days: Number(event.target.value) })} required /></label>
            <label>Max active loans<input type="number" min="1" value={policy.max_active_loans} onChange={(event) => setPolicy({ ...policy, max_active_loans: Number(event.target.value) })} required /></label>
            <label>Due-soon window (days)<input type="number" min="0" value={policy.due_soon_days} onChange={(event) => setPolicy({ ...policy, due_soon_days: Number(event.target.value) })} required /></label>
          </div>
          <div className="form-row three-column">
            <label>Max renewals<input type="number" min="0" value={policy.max_renewals} onChange={(event) => setPolicy({ ...policy, max_renewals: Number(event.target.value) })} required /></label>
            <label>Pickup hold (days)<input type="number" min="1" value={policy.pickup_hold_days} onChange={(event) => setPolicy({ ...policy, pickup_hold_days: Number(event.target.value) })} required /></label>
            <label>Fine per overdue day<input type="number" min="0" step="0.01" value={policy.fine_per_day} onChange={(event) => setPolicy({ ...policy, fine_per_day: Number(event.target.value) })} required /></label>
          </div>
          <label className="checkbox-field"><input type="checkbox" checked={policy.notifications_enabled} onChange={(event) => setPolicy({ ...policy, notifications_enabled: event.target.checked })} /> Enable in-app notifications</label>
          <button className="primary-button" disabled={policySaving}>{policySaving ? 'Saving policy...' : 'Save policy'}</button>
        </>}
      </form>
    {pagination}</section>
  )
}

export function StaffCirculation({ onBack }) {
  const [members, setMembers] = useState([])
  const [copies, setCopies] = useState([])
  const [loans, setLoans] = useState([])
  const [policy, setPolicy] = useState(defaultCirculationPolicy)
  const [memberQuery, setMemberQuery] = useState('')
  const [barcode, setBarcode] = useState('')
  const [returnBarcode, setReturnBarcode] = useState('')
  const [receipt, setReceipt] = useState(null)
  const [memberId, setMemberId] = useState('')
  const [copyId, setCopyId] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [pendingClose, setPendingClose] = useState(null)

  const loadData = async () => {
    if (!supabase) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    try {
      const { error: refreshError } = await supabase.rpc('refresh_circulation_statuses')
      if (refreshError) throw refreshError
      const [membersResult, copiesResult, loansResult, policyResult] = await Promise.all([
        fetchAllRows(() => supabase.from('library_members').select('id, full_name, library_card_number, school_id').eq('is_active', true).not('library_card_number', 'is', null).order('full_name')),
        fetchAllRows(() => supabase.from('book_copies').select('id, barcode, location, status, books(title)').in('status', ['available', 'reserved']).order('barcode')),
        fetchAllRows(() => supabase.from('loans').select('id, status, checked_out_at, due_at, fine_amount, book_copies(books(title), barcode), member:library_members!loans_member_id_fkey(full_name, library_card_number)').in('status', ['borrowed', 'overdue']).order('created_at', { ascending: false })),
        supabase.rpc('get_circulation_policy'),
      ])
      const failed = [membersResult, copiesResult, loansResult, policyResult].find((result) => result.error)
      if (failed?.error) throw failed.error
      setMembers(membersResult.data ?? [])
      setCopies(copiesResult.data ?? [])
      setLoans(loansResult.data ?? [])
      if (!policyResult.error) setPolicy(normalizeCirculationPolicy(policyResult.data))
    } catch (loadError) {
      if (import.meta.env.DEV) console.error('[circulation] records failed', loadError)
      setMembers([]); setCopies([]); setLoans([])
      setError('Circulation refresh failed. Records are unavailable until refresh succeeds.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadData() }, [])

  const checkout = async (event) => {
    event.preventDefault()
    setSaving(true)
    setMessage('')
    setError('')
    try {
      const { data: loanId, error: checkoutError } = await supabase.rpc('checkout_copy', { p_copy_id: copyId, p_member_id: memberId })
      if (checkoutError) setError(checkoutError.message)
      else {
        setMessage('Book checked out successfully.')
        const { data: issued, error: receiptError } = await supabase.from('loans').select('id, due_at, fine_daily_rate').eq('id', loanId).single()
        setReceipt({ id: loanId, title: copies.find((item) => item.id === copyId)?.books?.title, barcode: copies.find((item) => item.id === copyId)?.barcode, member: members.find((item) => item.id === memberId)?.full_name, card: members.find((item) => item.id === memberId)?.library_card_number, due_at: issued?.due_at })
        if (receiptError) setMessage(`Checkout completed. Receipt ID: ${loanId}; due date unavailable.`)
        setBarcode('')
        setMemberId('')
        setCopyId('')
        await loadData()
      }
    } catch (checkoutError) {
      if (import.meta.env.DEV) console.error('[circulation] checkout failed', checkoutError)
      setError('Unable to check out this copy. Verify the selections and try again.')
    } finally {
      setSaving(false)
    }
  }

  const returnLoan = async (loanId) => {
    setSaving(true)
    setMessage('')
    setError('')
    try {
      const { error: returnError } = await supabase.rpc('return_loan', { p_loan_id: loanId })
      if (returnError) setError(returnError.message)
      else {
        const { data: closed } = await supabase.from('loans').select('fine_amount').eq('id', loanId).single()
        setMessage(`Book returned. Final fine: ${closed ? formatFine(closed.fine_amount) : 'see transaction history'}.`)
        setReturnBarcode('')
        await loadData()
      }
    } catch (returnError) {
      if (import.meta.env.DEV) console.error('[circulation] return failed', returnError)
      setError('Unable to process this return. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const closeLoan = async (loanId, status) => {
    setSaving(true)
    setMessage('')
    setError('')
    try {
      const { error: closeError } = await supabase.rpc('close_loan_with_status', { p_loan_id: loanId, p_status: status })
      if (closeError) setError(`Unable to mark this loan ${status}. Please try again.`)
      else {
        setMessage(`Loan marked ${status}.`)
        await loadData()
      }
    } catch (closeError) {
      if (import.meta.env.DEV) console.error(`[circulation] ${status} loan failed`, closeError)
      setError(`Unable to mark this loan ${status}. Please try again.`)
    } finally {
      setSaving(false)
      setPendingClose(null)
    }
  }

  const visibleMembers = members.filter((member) => `${member.full_name || ''} ${member.library_card_number || ''} ${member.school_id || ''} ${member.id}`.toLowerCase().includes(memberQuery.toLowerCase()))
  const visibleLoans = loans.filter((loan) => !returnBarcode || loan.book_copies?.barcode.toLowerCase().includes(returnBarcode.toLowerCase()))
  const { pageItems, pagination } = usePagination(visibleLoans, returnBarcode)
  const scanCopy = (value) => {
    setBarcode(value)
    setCopyId(copies.find((copy) => copy.barcode === value.trim())?.id || '')
  }

  return (
    <section className="content-section">
      <ToolHeader eyebrow="Circulation desk" title="Borrow / Return" description="Check out available copies and process returns using the current library records." onBack={onBack} />
      {(message || error) && <div role={error ? 'alert' : 'status'} className={error ? 'inline-error with-action' : 'inline-success'}><span>{error || message}</span>{error && <button type="button" className="retry-button" onClick={loadData}>Try again</button>}</div>}
      <form className="tool-form checkout-form" onSubmit={checkout}>
        <h3>Check out a book</h3>
        <label>Scan library card or find member<input value={memberQuery} onChange={(event) => { const value = event.target.value; setMemberQuery(value); const match = members.find((member) => member.library_card_number?.toLowerCase() === value.trim().toLowerCase()); setMemberId(match?.id || '') }} onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault() }} placeholder="Scan card number or search name" /></label>
        <label>Scan copy barcode<input value={barcode} onChange={(event) => scanCopy(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault() }} placeholder="Scan or type the exact barcode" /></label>
        {barcode && !copyId && <p role="status">No available or held copy matches this barcode.</p>}
        <div className="form-row two-column">
          <label>1. Member<select value={memberId} onChange={(event) => setMemberId(event.target.value)} required><option value="">Select member</option>{visibleMembers.map((member) => <option key={member.id} value={member.id}>{member.full_name} · {member.library_card_number}</option>)}</select></label>
          <label>2. Copy (available or assigned hold)<select value={copyId} onChange={(event) => { setCopyId(event.target.value); setBarcode(copies.find((item) => item.id === event.target.value)?.barcode || '') }} required><option value="">Select copy</option>{copies.map((copy) => <option key={copy.id} value={copy.id}>{copy.books?.title || 'Unknown'} · {copy.barcode}</option>)}</select></label>
        </div>
        <small className="form-helper">The due date is set automatically from the configured loan period and enforced by the database.</small>
        {(members.length === 0 || copies.length === 0) && !loading && <small className="form-helper">{members.length === 0 ? 'No active members with verified library cards are available. Register or update the member record first.' : 'No available copies are listed.'}</small>}
        <small className="form-helper">Default loan period: {policy.loan_period_days} days · Maximum active loans: {policy.max_active_loans}</small>
        <button className="primary-button" disabled={saving || loading || !copyId || !memberId}>Check out</button>
      </form>
      {receipt && <div className="inline-success" role="status"><strong>Checkout receipt</strong><p>{receipt.member} · Card {receipt.card} · {receipt.title} · {receipt.barcode}</p><p>Due: {receipt.due_at ? new Date(receipt.due_at).toLocaleString() : 'See loan record'}</p><code>{receipt.id}</code></div>}
      <form className="tool-form" onSubmit={(event) => { event.preventDefault(); const loan = loans.find((item) => item.book_copies?.barcode === returnBarcode.trim()); if (loan) void returnLoan(loan.id); else setError('No active loan matches this barcode.') }}>
        <label>Return by barcode<input value={returnBarcode} onChange={(event) => setReturnBarcode(event.target.value)} placeholder="Scan or type barcode" required /></label>
        <button disabled={saving || loading}>Return scanned copy</button>
      </form>
      <div className="table-wrap tool-table">
        {loading ? <div className="empty-state loading-state">Loading borrowing records...</div> : loans.length === 0 ? <div className="empty-state">No active loans.</div> : (
          <table>
            <thead><tr><th>Book</th><th>Member</th><th>Borrowed</th><th>Status</th><th>Due</th><th>Fine</th><th>Action</th></tr></thead>
            <tbody>{pageItems.map((loan) => <tr key={loan.id}>
              <td>{loan.book_copies?.books?.title || 'Unknown'}<small className="table-subtext">{loan.book_copies?.barcode || ''}</small></td>
              <td>{loan.member?.full_name || 'Unknown member'}</td>
              <td>{loan.checked_out_at ? new Date(loan.checked_out_at).toLocaleDateString() : 'Not recorded'}</td>
              <td><span className="table-status" data-status={loan.status}>{loan.status}</span></td>
              <td>{loan.due_at ? new Date(loan.due_at).toLocaleDateString() : 'Not set'}</td>
              <td>{formatFine(loan.fine_amount)}</td>
              <td><div className="table-actions"><button type="button" className="table-action" onClick={() => returnLoan(loan.id)} disabled={saving}>Return</button><button type="button" className="table-action danger-action" onClick={() => setPendingClose({ loanId: loan.id, status: 'lost' })} disabled={saving}>Lost</button><button type="button" className="table-action danger-action" onClick={() => setPendingClose({ loanId: loan.id, status: 'damaged' })} disabled={saving}>Damaged</button></div></td>
            </tr>)}</tbody>
          </table>
        )}
      </div>
      {pagination}
      <ConfirmDialog open={Boolean(pendingClose)} title={`Mark loan ${pendingClose?.status || 'closed'}?`} description="This closes the loan and changes the physical copy status. The action is recorded in the audit log." confirmLabel={`Mark ${pendingClose?.status || 'closed'}`} danger busy={Boolean(saving && pendingClose)} onCancel={() => setPendingClose(null)} onConfirm={() => { if (pendingClose) void closeLoan(pendingClose.loanId, pendingClose.status) }} />
    </section>
  )
}
