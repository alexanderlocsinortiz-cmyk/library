import { useState } from 'react'

export function usePagination(items, resetKey = '', pageSize = 25) {
  const [selection, setSelection] = useState({ key: resetKey, page: 0 })
  const pages = Math.max(1, Math.ceil(items.length / pageSize))
  const page = selection.key === resetKey ? Math.min(selection.page, pages - 1) : 0
  const select = (value) => setSelection({ key: resetKey, page: value })
  return {
    pageItems: items.slice(page * pageSize, (page + 1) * pageSize),
    pagination: items.length > pageSize && <nav className="pagination" aria-label="Results pages">
      <button type="button" disabled={page === 0} onClick={() => select(page - 1)}>Previous</button>
      <span aria-live="polite">Page {page + 1} of {pages} · {items.length} records</span>
      <button type="button" disabled={page + 1 >= pages} onClick={() => select(page + 1)}>Next</button>
    </nav>,
  }
}
