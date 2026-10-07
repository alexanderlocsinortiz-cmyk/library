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
    <h2>Transaction and audit history</h2>
    <label>Search actions, member, school ID, title, barcode or record ID<input value={query} maxLength={200} onChange={(event) => { setQuery(event.target.value); setPage(0) }} /></label>
    {error && <p role="alert">{error}</p>}
    {loading ? <p role="status">Loading history…</p> : !error && <>
      <p>{result.total} matching events</p>
      <div className="table-wrap"><table><thead><tr><th>Date</th><th>Action</th><th>Member</th><th>Book / copy</th><th>Staff</th><th>Details</th></tr></thead>
        <tbody>{result.items.map((item) => <tr key={item.id}><td>{new Date(item.created_at).toLocaleString()}</td><td>{item.action.replaceAll('_', ' ')}</td><td>{item.member_name || '—'}<small>{item.school_id}</small></td><td>{item.title || item.entity_type}<small>{item.barcode}</small></td><td>{item.actor_name || 'Scheduled / system'}</td><td><details><summary>Record details</summary><code>{JSON.stringify(item.details)}</code></details></td></tr>)}</tbody>
      </table></div>
    </>}
    <nav className="pagination" aria-label="History pages"><button disabled={loading || page === 0} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page + 1}</span><button disabled={loading || (page + 1) * 25 >= result.total} onClick={() => setPage(page + 1)}>Next</button></nav>
  </section>
}
