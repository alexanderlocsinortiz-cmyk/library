import { useEffect, useState } from 'react'

export function usePagination(items, resetKey = '', pageSize = 25, options = {}) {
  const [selection, setSelection] = useState({ key: resetKey, page: 0 })
  useEffect(() => {
    setSelection((current) => current.key === resetKey ? current : { key: resetKey, page: 0 })
  }, [resetKey])
  const pages = Math.max(1, Math.ceil(items.length / pageSize))
  const page = selection.key === resetKey ? Math.min(selection.page, pages - 1) : 0
  const select = (value) => setSelection({ key: resetKey, page: value })
  if (options.numbered) {
    const first = items.length ? page * pageSize + 1 : 0
    const last = Math.min((page + 1) * pageSize, items.length)
    const visiblePages = new Set([0, pages - 1, page - 1, page, page + 1].filter((value) => value >= 0 && value < pages))
    const pageButtons = [...visiblePages].sort((a, b) => a - b)
    return {
      pageItems: items.slice(page * pageSize, (page + 1) * pageSize),
      pagination: options.always || items.length > pageSize ? <div className="pagination user-management-pagination">
        <span className="user-pagination-summary" aria-live="polite">{items.length ? `Showing ${first}–${last} of ${items.length} ${options.label || 'records'}` : `Showing 0 ${options.label || 'records'}`}</span>
        <nav aria-label="Results pages">
          <button type="button" disabled={page === 0} onClick={() => select(page - 1)}>Previous</button>
          {pageButtons.map((pageNumber, index) => <span className="user-pagination-page-slot" key={pageNumber}>
            {index > 0 && pageNumber - pageButtons[index - 1] > 1 && <span className="user-pagination-ellipsis" aria-hidden="true">…</span>}
            <button type="button" aria-label={`Page ${pageNumber + 1}`} aria-current={page === pageNumber ? 'page' : undefined} className={page === pageNumber ? 'active' : ''} onClick={() => select(pageNumber)}>{pageNumber + 1}</button>
          </span>)}
          <button type="button" disabled={page + 1 >= pages} onClick={() => select(page + 1)}>Next</button>
        </nav>
      </div> : null,
    }
  }
  return {
    pageItems: items.slice(page * pageSize, (page + 1) * pageSize),
    pagination: items.length > pageSize && <nav className="pagination" aria-label="Results pages">
      <button type="button" disabled={page === 0} onClick={() => select(page - 1)}>Previous</button>
      <span aria-live="polite">Page {page + 1} of {pages} · {items.length} records</span>
      <button type="button" disabled={page + 1 >= pages} onClick={() => select(page + 1)}>Next</button>
    </nav>,
  }
}
