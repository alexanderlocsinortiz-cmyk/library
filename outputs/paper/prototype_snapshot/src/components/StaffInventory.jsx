import { useEffect, useState } from 'react'
import { usePagination } from './Pagination'
import { ConfirmDialog } from './ConfirmDialog'
import { fetchAllRows } from '../lib/paging'
import { supabase } from '../lib/supabase'

const requestStatuses = ['new', 'reviewing', 'ordered', 'acquired', 'declined']

function PageHeader({ eyebrow, title, description }) {
  return <div className="section-heading page-header"><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2><p className="muted">{description}</p></div></div>
}

function formattedDate(value) {
  return value ? new Date(value).toLocaleString() : 'Not recorded'
}

function statusLabel(value) {
  return (value || 'unknown').replaceAll('_', ' ')
}

export function StaffBookRequests() {
  const [requests, setRequests] = useState([])
  const [members, setMembers] = useState([])
  const [draft, setDraft] = useState({ requested_title: '', requested_author: '', course_subject: '', member_id: '' })
  const [edits, setEdits] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savingId, setSavingId] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const load = async () => {
    if (!supabase) { setLoading(false); return }
    setLoading(true)
    setError('')
    try {
      const [requestResult, memberResult] = await Promise.all([
        fetchAllRows(() => supabase.from('book_requests')
          .select('id, requested_title, requested_author, course_subject, member_id, status, staff_notes, created_at, updated_at, member:library_members!book_requests_member_id_fkey(full_name, library_card_number)')
          .order('created_at', { ascending: false })),
        fetchAllRows(() => supabase.from('library_members')
          .select('id, full_name, library_card_number').eq('is_active', true).order('full_name')),
      ])
      const failed = [requestResult, memberResult].find((result) => result.error)
      if (failed?.error) throw failed.error
      setRequests(requestResult.data ?? [])
      setMembers(memberResult.data ?? [])
    } catch (loadError) {
      if (import.meta.env.DEV) console.error('[book requests] load failed', loadError)
      setError('Unable to load book requests. Check the database migration and try again.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const recordRequest = async (event) => {
    event.preventDefault()
    if (!supabase) return
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const { error: saveError } = await supabase.rpc('record_book_request', {
        p_requested_title: draft.requested_title,
        p_requested_author: draft.requested_author || null,
        p_course_subject: draft.course_subject,
        p_member_id: draft.member_id || null,
      })
      if (saveError) throw saveError
      setDraft({ requested_title: '', requested_author: '', course_subject: '', member_id: '' })
      setMessage('Book request recorded for staff review.')
      await load()
    } catch (saveError) {
      if (import.meta.env.DEV) console.error('[book requests] save failed', saveError)
      setError(saveError.message || 'Unable to record this book request.')
    } finally {
      setSaving(false)
    }
  }

  const saveRequest = async (request) => {
    if (!supabase) return
    const edit = edits[request.id] ?? { status: request.status, staff_notes: request.staff_notes || '' }
    setSavingId(request.id)
    setError('')
    setMessage('')
    try {
      const { error: updateError } = await supabase.rpc('update_book_request', {
        p_request_id: request.id,
        p_status: edit.status,
        p_staff_notes: edit.staff_notes,
      })
      if (updateError) throw updateError
      setMessage('Updated request for "' + request.requested_title + '".')
      setEdits((current) => { const next = { ...current }; delete next[request.id]; return next })
      await load()
    } catch (updateError) {
      if (import.meta.env.DEV) console.error('[book requests] update failed', updateError)
      setError(updateError.message || 'Unable to update this book request.')
    } finally {
      setSavingId('')
    }
  }

  const { pageItems, pagination } = usePagination(requests, requests.length + ':' + (requests[0]?.updated_at || ''))

  return <section className="content-section">
    <PageHeader eyebrow="Collection development" title="Book requests" description="Record titles the library does not own and review demand by course or subject. A request is a demand record, not a promise that the library will purchase the title." />
    {(error || message) && <div className={error ? 'inline-error' : 'inline-success'} role={error ? 'alert' : 'status'}>{error || message}</div>}
    <form className="tool-form" onSubmit={recordRequest}>
      <h3>Record a requested book</h3>
      <div className="form-row">
        <label>Requested title<input value={draft.requested_title} onChange={(event) => setDraft({ ...draft, requested_title: event.target.value })} maxLength={200} required /></label>
        <label>Author <span className="label-note">optional</span><input value={draft.requested_author} onChange={(event) => setDraft({ ...draft, requested_author: event.target.value })} maxLength={200} /></label>
      </div>
      <div className="form-row">
        <label>Course / subject<input value={draft.course_subject} onChange={(event) => setDraft({ ...draft, course_subject: event.target.value })} maxLength={200} /></label>
        <label>Requester <span className="label-note">optional</span><select value={draft.member_id} onChange={(event) => setDraft({ ...draft, member_id: event.target.value })}><option value="">No member record selected</option>{members.map((member) => <option key={member.id} value={member.id}>{member.full_name} · {member.library_card_number || 'No card recorded'}</option>)}</select></label>
      </div>
      <button className="primary-button" disabled={saving}>{saving ? 'Recording...' : 'Record request'}</button>
      <small className="form-helper">Staff record requests made at the desk. Students do not need accounts or email addresses.</small>
    </form>
    <div className="section-heading"><div><h3>Requests for staff review</h3><p className="muted">Move requests from new to reviewing, then to ordered, acquired, or declined.</p></div></div>
    {loading ? <div className="empty-state loading-state">Loading requests...</div> : error && requests.length === 0 ? null : requests.length === 0 ? <div className="empty-state large">No book requests have been recorded.</div> : <div className="table-wrap"><table>
      <thead><tr><th>Requested book</th><th>Course / subject</th><th>Requester</th><th>Requested</th><th>Status</th><th>Staff notes</th><th>Action</th></tr></thead>
      <tbody>{pageItems.map((request) => {
        const edit = edits[request.id] ?? { status: request.status, staff_notes: request.staff_notes || '' }
        const closed = ['acquired', 'declined'].includes(request.status)
        return <tr key={request.id}>
          <td><strong>{request.requested_title}</strong><small className="table-subtext">{request.requested_author || 'Author not provided'}</small></td>
          <td>{request.course_subject || 'Not recorded'}</td>
          <td>{request.member?.full_name || 'Not recorded'}<small className="table-subtext">{request.member?.library_card_number || ''}</small></td>
          <td>{formattedDate(request.created_at)}</td>
          <td>{closed ? <span className="table-status" data-status={request.status}>{statusLabel(request.status)}</span> : <select aria-label={'Status for ' + request.requested_title} value={edit.status} onChange={(event) => setEdits({ ...edits, [request.id]: { ...edit, status: event.target.value } })}>{requestStatuses.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}</select>}</td>
          <td>{closed ? request.staff_notes || '—' : <textarea aria-label={'Staff notes for ' + request.requested_title} rows={2} maxLength={2000} value={edit.staff_notes} onChange={(event) => setEdits({ ...edits, [request.id]: { ...edit, staff_notes: event.target.value } })} />}</td>
          <td>{closed ? 'Closed' : <button type="button" className="table-action" onClick={() => void saveRequest(request)} disabled={savingId === request.id}>{savingId === request.id ? 'Saving...' : 'Save'}</button>}</td>
        </tr>
      })}</tbody>
    </table></div>}
    {pagination}
  </section>
}

const auditResultLabels = {
  not_scanned: 'Not scanned yet',
  found: 'Found',
  wrong_location: 'Wrong shelf location',
  status_changed: 'Status changed during audit',
  multiple_mismatches: 'Status and location differ',
  not_found: 'Not found — verify physically',
  not_in_snapshot: 'Not in starting inventory',
  unknown_barcode: 'Barcode not in catalog',
}

export function StaffInventoryAudit() {
  const [audit, setAudit] = useState(null)
  const [items, setItems] = useState([])
  const [latestAudit, setLatestAudit] = useState(null)
  const [barcode, setBarcode] = useState('')
  const [location, setLocation] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [showComplete, setShowComplete] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const load = async () => {
    if (!supabase) { setLoading(false); return }
    setLoading(true)
    setError('')
    try {
      const { data: activeAudit, error: auditError } = await supabase.from('inventory_audits')
        .select('id, status, started_at')
        .eq('status', 'in_progress').maybeSingle()
      if (auditError) throw auditError
      setAudit(activeAudit)
      if (activeAudit) {
        const { data, error: itemsError } = await fetchAllRows(() => supabase.from('inventory_audit_items')
          .select('id, barcode, title_snapshot, expected_status, expected_location, observed_location, result, scanned_at')
          .eq('audit_id', activeAudit.id).order('barcode', { ascending: true }))
        if (itemsError) throw itemsError
        setItems(data ?? [])
        setLatestAudit(null)
      } else {
        setItems([])
        const { data: completed, error: completedError } = await supabase.from('inventory_audits')
          .select('id, started_at, completed_at, summary').eq('status', 'completed')
          .order('completed_at', { ascending: false }).limit(1).maybeSingle()
        if (completedError) throw completedError
        setLatestAudit(completed)
      }
    } catch (loadError) {
      if (import.meta.env.DEV) console.error('[inventory audit] load failed', loadError)
      setError('Unable to load inventory audit. Check the database migration and try again.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const startAudit = async () => {
    if (!supabase) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const { error: startError } = await supabase.rpc('start_inventory_audit')
      if (startError) throw startError
      setMessage('Audit started. Scan copies expected to be on library shelves.')
      await load()
      document.getElementById('inventory-audit-barcode')?.focus()
    } catch (startError) {
      if (import.meta.env.DEV) console.error('[inventory audit] start failed', startError)
      setError(startError.message || 'Unable to start an inventory audit.')
      await load()
    } finally {
      setBusy(false)
    }
  }

  const scanCopy = async (event) => {
    event.preventDefault()
    if (!supabase || !audit) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const { data, error: scanError } = await supabase.rpc('scan_inventory_audit_copy', {
        p_audit_id: audit.id,
        p_barcode: barcode,
        p_observed_location: location,
      })
      if (scanError) throw scanError
      setBarcode('')
      setMessage(auditResultLabels[data] || ('Scan recorded: ' + statusLabel(data) + '.'))
      await load()
      document.getElementById('inventory-audit-barcode')?.focus()
    } catch (scanError) {
      if (import.meta.env.DEV) console.error('[inventory audit] scan failed', scanError)
      setError(scanError.message || 'Unable to record this barcode.')
    } finally {
      setBusy(false)
    }
  }

  const finishAudit = async () => {
    if (!supabase || !audit) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const { data, error: completeError } = await supabase.rpc('complete_inventory_audit', { p_audit_id: audit.id })
      if (completeError) throw completeError
      setMessage('Audit completed. ' + (data?.not_found ?? 0) + ' expected copies were not scanned; verify those books physically before changing their records.')
      setShowComplete(false)
      await load()
    } catch (completeError) {
      if (import.meta.env.DEV) console.error('[inventory audit] complete failed', completeError)
      setError(completeError.message || 'Unable to complete this audit.')
    } finally {
      setBusy(false)
    }
  }

  const { pageItems, pagination } = usePagination(items, (audit?.id || '') + ':' + items.length)
  const expectedCount = items.filter((item) => item.expected_status).length
  const scannedCount = items.filter((item) => item.scanned_at).length

  return <section className="content-section">
    <PageHeader eyebrow="Physical inventory" title="Stock audit" description="Compare scanned shelf copies with the catalog. A discrepancy is a review flag; the audit never marks a book lost automatically." />
    {(error || message) && <div className={error ? 'inline-error' : 'inline-success'} role={error ? 'alert' : 'status'}>{error || message}</div>}
    {loading ? <div className="empty-state loading-state">Loading stock audit...</div> : audit ? <>
      <div className="section-heading"><div><h3>Audit in progress</h3><p className="muted">Started {formattedDate(audit.started_at)} · {scannedCount} of {expectedCount} expected copies scanned.</p></div><button type="button" className="primary-button" onClick={() => setShowComplete(true)} disabled={busy}>Finish audit</button></div>
      <form className="tool-form" onSubmit={scanCopy}>
        <h3>Scan a physical copy</h3>
        <div className="form-row">
          <label>Copy barcode<input id="inventory-audit-barcode" value={barcode} onChange={(event) => setBarcode(event.target.value)} maxLength={100} required autoComplete="off" placeholder="Scan barcode, then press Enter" /></label>
          <label>Observed shelf / location<input value={location} onChange={(event) => setLocation(event.target.value)} maxLength={100} required placeholder="e.g. Shelf B-2" /></label>
        </div>
        <button className="primary-button" disabled={busy}>{busy ? 'Saving...' : 'Record scan'}</button>
      </form>
      {items.length === 0 ? <div className="empty-state">No copies were on shelves when this audit started. Scanned barcodes will still be checked for unexpected records.</div> : <div className="table-wrap">
        <table><thead><tr><th>Book / barcode</th><th>Expected location</th><th>Observed location</th><th>Expected status</th><th>Audit result</th></tr></thead>
          <tbody>{pageItems.map((item) => <tr key={item.id}><td><strong>{item.title_snapshot || 'Unknown copy'}</strong><small className="table-subtext">{item.barcode}</small></td><td>{item.expected_location || 'Not recorded'}</td><td>{item.observed_location || '—'}</td><td>{item.expected_status || 'Not in snapshot'}</td><td><span className="table-status" data-status={item.result}>{auditResultLabels[item.result] || statusLabel(item.result)}</span></td></tr>)}</tbody>
        </table>
      </div>}
      {pagination}
    </> : <>
      {latestAudit && <div className="section-heading"><div><h3>Latest completed audit</h3><p className="muted">Completed {formattedDate(latestAudit.completed_at)}. Unscanned copies were flagged for physical verification; copy records were not automatically changed.</p></div></div>}
      {latestAudit && <div className="form-row">
        {Object.entries(latestAudit.summary || {}).map(([label, count]) => <div className="stat-card" key={label}><span>{statusLabel(label)}</span><strong>{count}</strong></div>)}
      </div>}
      <div className="tool-form">
        <h3>Start a stock audit</h3>
        <p className="muted">The audit snapshots copies marked available, reserved, maintenance, or damaged. Borrowed and overdue copies are excluded. Only one audit can be open at a time.</p>
        <p className="requirement-note">When finished, unscanned copies are flagged for checking. They are never automatically marked lost or otherwise changed.</p>
        <button type="button" className="primary-button" onClick={() => void startAudit()} disabled={busy}>{busy ? 'Starting...' : 'Start audit'}</button>
      </div>
    </>}
    <ConfirmDialog open={showComplete} title="Finish this stock audit?" description="Unscanned shelf copies will be flagged for physical verification. Their inventory status will not be changed automatically." confirmLabel="Finish audit" busy={busy} onCancel={() => setShowComplete(false)} onConfirm={() => void finishAudit()} />
  </section>
}

