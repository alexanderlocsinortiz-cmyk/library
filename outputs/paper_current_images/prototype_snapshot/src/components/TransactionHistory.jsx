import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export function TransactionHistory() {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [result, setResult] = useState({ items: [], total: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    const timer = setTimeout(async () => {
      try {
        const { data, error: loadError } = await supabase.rpc('transaction_history', { p_query: query, p_page: page, p_size: 25 })
        if (loadError) throw loadError
        if (active) setResult(data)
      } catch (loadError) { if (active) setError(loadError.message) }
      finally { if (active) setLoading(false) }
    }, 200)
    return () => { active = false; clearTimeout(timer) }
  }, [page, query])
  return <section className="content-section">
    <div className="section-heading page-header"><div><span className="eyebrow">Circulation</span><h2>Transaction history</h2><p className="muted">Search recorded checkouts, returns, reservations, and staff actions.</p></div></div>
    <label className="transaction-search"><span>Search transactions</span><input type="search" value={query} maxLength={200} onChange={(event) => { setQuery(event.target.value); setPage(0) }} placeholder="Member, title, action, or barcode" /></label>
    {error && <div className="inline-error" role="alert">Unable to load transaction history. Please try again.</div>}
    {loading ? <div className="empty-state loading-state" role="status">Loading transaction history...</div> : !error && <>
      <p className="catalog-result-count" aria-live="polite">{result.total} matching {result.total === 1 ? 'event' : 'events'}</p>
      <div className="table-wrap"><table><thead><tr><th>Date</th><th>Action</th><th>Member</th><th>Book / copy</th><th>Staff</th><th>Details</th></tr></thead>
        <tbody>{result.items.map((item) => <tr key={item.id}><td>{item.created_at ? new Date(item.created_at).toLocaleString() : 'Not recorded'}</td><td><span className="table-status" data-status={item.action}>{item.action.replaceAll('_', ' ')}</span></td><td>{item.member_name || '—'}{item.school_id && <small className="table-subtext">{item.school_id}</small>}</td><td>{item.title || item.entity_type}{item.barcode && <small className="table-subtext">{item.barcode}</small>}</td><td>{item.actor_name || 'Scheduled / system'}</td><td><details><summary>Record details</summary><code className="transaction-details">{JSON.stringify(item.details)}</code></details></td></tr>)}</tbody>
      </table></div>
    </>}
    {result.total > 25 && <nav className="pagination" aria-label="History pages"><button type="button" disabled={loading || page === 0} onClick={() => setPage(page - 1)}>Previous</button><span aria-live="polite">Page {page + 1} of {Math.ceil(result.total / 25)}</span><button type="button" disabled={loading || (page + 1) * 25 >= result.total} onClick={() => setPage(page + 1)}>Next</button></nav>}
  </section>
}
