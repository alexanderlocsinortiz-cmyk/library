import { Fragment, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { fetchAllRows } from '../lib/paging'
import { supabase } from '../lib/supabase'

const SHELVES = ['Filipiniana', 'Thesis', 'General Circulation', 'Fiction']
const INVENTORY_PAGE_SIZE = 6
const REPORTS = [
  { id: 'inventory', label: 'Book Inventory Report', description: 'Current catalog and physical copy distribution by shelf.' },
  { id: 'circulation', label: 'Borrowing and Returning Report', description: 'Checkouts and returns recorded in the selected period.' },
  { id: 'overdue', label: 'Overdue Books Report', description: 'Active loans past their due date.' },
  { id: 'reservations', label: 'Reservation Report', description: 'Reservation requests created in the selected period.' },
  { id: 'members', label: 'Member Activity Report', description: 'Borrowing and return activity grouped by borrower.' },
  { id: 'popular', label: 'Most Borrowed Books Report', description: 'Titles ranked by recorded checkouts in the selected period.' },
  { id: 'audit', label: 'Stock Audit Report', description: 'Stock audit snapshots and recorded scan results.' },
]

const RESERVATION_LABELS = {
  waiting: 'Pending', ready_for_pickup: 'Ready for Pickup', completed: 'Completed',
  cancelled: 'Cancelled', expired: 'Expired',
}
const AUDIT_LABELS = {
  not_scanned: 'Not scanned', found: 'Found', wrong_location: 'Wrong location',
  status_changed: 'Status changed', multiple_mismatches: 'Multiple mismatches',
  not_found: 'Not found', not_in_snapshot: 'Not in snapshot', unknown_barcode: 'Unknown barcode',
}

const REPORT_SUMMARY_ITEMS = [
  { key: 'books', label: 'Catalog titles' },
  { key: 'copies', label: 'Physical copies' },
  { key: 'availableCopies', label: 'Available copies' },
  { key: 'activeLoans', label: 'Books checked out' },
  { key: 'openReservations', label: 'Open reservations' },
  { key: 'overdueLoans', label: 'Overdue books' },
]

const INVENTORY_COLUMN_WEIGHTS = {
  title: 16.5, author: 11.3, isbn: 9, subject: 12.5, total: 6.5, available: 6.3,
  filipiniana: 7.4, thesis: 5.5, general: 10.8, fiction: 5.5, other: 8.7,
}

const REPORT_COLUMN_WEIGHTS = {
  circulation: { date: 14, type: 8, borrower: 14, borrowerId: 11, book: 34, barcode: 19 },
  overdue: { borrower: 13, borrowerId: 10, book: 25, barcode: 12, borrowed: 10, due: 10, daysOverdue: 10, status: 10 },
  reservations: { date: 13, borrower: 18, borrowerType: 11, borrowerId: 12, book: 25, pickup: 11, status: 10 },
  members: { borrower: 23, borrowerId: 16, checkouts: 10, returns: 10, total: 12, lastActivity: 29 },
  popular: { book: 54, checkouts: 23, borrowers: 23 },
  audit: { auditDate: 12, auditStatus: 11, book: 24, barcode: 12, expectedStatus: 13, expectedShelf: 13, observedShelf: 13, result: 12 },
}

const NUMERIC_REPORT_COLUMNS = new Set([
  'total', 'available', 'filipiniana', 'thesis', 'general', 'fiction', 'other',
  'daysOverdue', 'checkouts', 'returns', 'borrowers',
])

function ReportPrintDocument({ host, activeReport, activeDefinition, columns, rows, summaryStats, startDate, endDate, reportSearch, generatedAt }) {
  if (!host || !generatedAt) return null
  const reportWeights = activeReport === 'inventory' ? INVENTORY_COLUMN_WEIGHTS : REPORT_COLUMN_WEIGHTS[activeReport] || {}
  const weights = columns.map((column) => reportWeights[column.key] || 100 / Math.max(columns.length, 1))
  const totalWeight = weights.reduce((sum, value) => sum + value, 0) || 1
  const isInventory = activeReport === 'inventory'
  const generatedDate = generatedAt.toLocaleDateString(undefined, { dateStyle: 'medium' })
  const generatedDateTime = generatedAt.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

  return <>
    {createPortal(<style>{`@media print {
      @page {
        size: A4 ${isInventory ? 'landscape' : 'portrait'};
        margin: 12mm 12mm 19mm;
        @bottom-right {
          content: "Page " counter(page) " of " counter(pages);
          color: #586b77;
          font: 8pt Arial, sans-serif;
        }
      }
    }`}</style>, document.head)}
    {createPortal(<article className={`report-print-document${isInventory ? ' is-landscape' : ''}`} aria-label="Printable library report">
      <header className="report-print-header">
        <div className="report-print-brand">
          <span className="report-print-logo">IBA</span>
          <span><strong>IBA College Library</strong><small>Library Management System</small></span>
        </div>
        <div className="report-print-heading">
          <span className="report-print-kicker">OFFICIAL LIBRARY REPORT</span>
          <h1>Library Management Report</h1>
        </div>
      </header>

      <section className="report-print-metadata" aria-label="Report information">
        <div><span>Report type</span><strong>{activeDefinition.label}</strong></div>
        <div><span>Reporting period</span><strong>{isInventory ? 'Current inventory snapshot' : `${dateText(startDate)} – ${dateText(endDate)}`}</strong></div>
        <div><span>Date generated</span><strong>{generatedDateTime}</strong></div>
        <div><span>Applied record filter</span><strong>{reportSearch.trim() || 'None'}</strong></div>
      </section>

      <section className="report-print-section report-print-summary">
        <div className="report-print-section-heading"><h2>Library at a glance</h2><span>Current database totals</span></div>
        <div className="report-print-summary-grid">
          {REPORT_SUMMARY_ITEMS.map(({ key, label }) => <div className="report-print-stat" key={key}>
            <span>{label}</span><strong>{Number.isFinite(summaryStats?.[key]) ? summaryStats[key].toLocaleString() : '—'}</strong>
          </div>)}
        </div>
        <p className="report-print-caption">Summary totals reflect current library records and are independent of the selected report period.</p>
      </section>

      <section className="report-print-section report-print-records">
        <div className="report-print-section-heading"><h2>{activeDefinition.label}</h2><span>{rows.length.toLocaleString()} {rows.length === 1 ? 'record' : 'records'}</span></div>
        <p className="report-print-description">{activeDefinition.description}{reportSearch.trim() ? ` Filtered by “${reportSearch.trim()}”.` : ''} All matching records are included.</p>
        {rows.length ? <table className="report-print-table">
          <colgroup>{columns.map((column, index) => <col key={column.key} style={{ width: `${weights[index] / totalWeight * 100}%` }} />)}</colgroup>
          <thead><tr>{columns.map((column) => <th key={column.key} className={NUMERIC_REPORT_COLUMNS.has(column.key) || column.align === 'center' ? 'is-numeric' : ''}>{column.label}</th>)}</tr></thead>
          <tbody>{rows.map((row, index) => <tr key={row.id || `${index}-${row.date || row.book || row.title || ''}`}>
            {columns.map((column) => {
              const value = row[column.key]
              return <td key={column.key} className={NUMERIC_REPORT_COLUMNS.has(column.key) || column.align === 'center' ? 'is-numeric' : ''}>{value == null || value === '' ? '—' : String(value)}</td>
            })}
          </tr>)}</tbody>
        </table> : <p className="report-print-empty">No records match this report and its selected filters.</p>}
      </section>

      <footer className="report-print-footer"><span>IBA College Library · Generated {generatedDate}</span><span>Library Management Report</span></footer>
    </article>, host)}
  </>
}

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function initialDateRange() {
  const end = new Date()
  const start = new Date(end)
  start.setDate(start.getDate() - 29)
  return { start: localDateKey(start), end: localDateKey(end) }
}

function dateKey(value) {
  if (!value) return ''
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  return localDateKey(new Date(value))
}

function dateText(value, includeTime = false) {
  if (!value) return '—'
  const date = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString(undefined, includeTime
    ? { dateStyle: 'medium', timeStyle: 'short' }
    : { dateStyle: 'medium' })
}

function dateBoundary(value, days = 0) {
  const date = new Date(`${value}T00:00:00`)
  date.setDate(date.getDate() + days)
  return date.toISOString()
}

function plural(value, single, multiple = `${single}s`) {
  return `${value} ${value === 1 ? single : multiple}`
}

function paginationPages(page, pageCount) {
  if (!pageCount) return []
  const pages = new Set([1, pageCount])
  for (let number = Math.max(1, page - 2); number <= Math.min(pageCount, page + 2); number += 1) pages.add(number)
  return [...pages].sort((left, right) => left - right)
}

function safeSpreadsheetValue(value) {
  const text = value == null ? '' : String(value)
  return /^[\s]*[-=+@]/.test(text) ? `'${text}` : text
}

function downloadCsv(filename, columns, rows) {
  const cell = (value) => `"${safeSpreadsheetValue(value).replaceAll('"', '""')}"`
  const lines = [columns.map((column) => cell(column.label)).join(','), ...rows.map((row) => columns.map((column) => cell(row[column.key])).join(','))]
  const blob = new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function ReportEmpty({ title, description }) {
  return <div className="report-empty-state"><span className="report-empty-mark" aria-hidden="true">—</span><strong>{title}</strong><p>{description}</p></div>
}

function InteractiveBars({ data, onSelect, formatter = (value) => value, color = 'maroon' }) {
  const max = Math.max(1, ...data.map((item) => Number(item.value) || 0))
  return <div className="report-chart" role="list">
    {data.map((item) => {
      const value = Number(item.value) || 0
      return <button className="report-chart-row" type="button" role="listitem" key={item.label} onClick={() => onSelect?.(item.label)} title={`Filter report by ${item.label}: ${formatter(value)}`}>
        <span className="report-chart-label">{item.label}</span>
        <span className="report-chart-track"><span className={`report-chart-fill ${color}`} style={{ width: `${value === 0 ? 0 : Math.max(3, value / max * 100)}%` }} /></span>
        <strong>{formatter(value)}</strong>
      </button>
    })}
  </div>
}

function ActivityTrend({ events, onSelect }) {
  const days = new Map()
  events.forEach((event) => {
    const key = dateKey(event.occurredAt)
    if (!key) return
    const bucket = days.get(key) || { label: key, checkouts: 0, returns: 0 }
    if (event.type === 'Checkout') bucket.checkouts += 1
    else bucket.returns += 1
    days.set(key, bucket)
  })
  const items = [...days.values()].sort((left, right) => left.label.localeCompare(right.label))
  if (!items.length) return <ReportEmpty title="No circulation activity" description="Checkouts and returns in this date range will appear here." />
  const max = Math.max(1, ...items.map((item) => Math.max(item.checkouts, item.returns)))
  const visible = items.length > 31 ? items.filter((_, index) => index % Math.ceil(items.length / 31) === 0 || index === items.length - 1) : items
  return <div className="report-trend-chart" role="list" aria-label="Checkouts and returns by day">
    {visible.map((item) => <button type="button" role="listitem" className="report-trend-row" key={item.label} onClick={() => onSelect(item.label)} title={`${dateText(item.label)}: ${item.checkouts} checkouts, ${item.returns} returns`}>
      <span>{dateText(item.label)}</span>
      <span className="report-trend-lines"><i><b className="checkout-fill" style={{ width: `${item.checkouts ? Math.max(3, item.checkouts / max * 100) : 0}%` }} /></i><i><b className="return-fill" style={{ width: `${item.returns ? Math.max(3, item.returns / max * 100) : 0}%` }} /></i></span>
      <strong>{item.checkouts} / {item.returns}</strong>
    </button>)}
    <div className="report-chart-legend"><span><i className="checkout-fill" />Checkouts</span><span><i className="return-fill" />Returns</span></div>
  </div>
}

function SearchableTable({ rows, columns, query, onQueryChange, resultCount = rows.length, inventoryPagination }) {
  const hasQuery = Boolean(query.trim())
  const inventoryTable = Boolean(inventoryPagination)
  const pageNumbers = inventoryTable ? paginationPages(inventoryPagination.page, inventoryPagination.pageCount) : []
  return <>
    <label className="report-search"><span>Search this report</span><input type="search" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Search report records" /></label>
    <p className="report-table-count" aria-live="polite">{plural(resultCount, 'record')} {hasQuery ? 'matching your search' : 'in this report'}</p>
    {rows.length === 0 ? <ReportEmpty title={hasQuery ? 'No matching records' : 'No records for this report'} description={hasQuery ? 'Try another search term.' : 'Records will appear here when they exist in the library database.'} /> : <div className={`report-table-wrap${inventoryTable ? ' inventory-report-table-wrap' : ''}`} role={inventoryTable ? 'region' : undefined} aria-label={inventoryTable ? 'Book inventory table. Scroll horizontally to view all columns.' : undefined} tabIndex={inventoryTable ? 0 : undefined}><table className={`report-table${inventoryTable ? ' inventory-report-table' : ''}`}>
      {inventoryTable && <colgroup>{columns.map((column) => <col key={column.key} style={{ width: `${column.width}px` }} />)}</colgroup>}
      <thead><tr>{columns.map((column) => <th scope="col" key={column.key} className={column.align === 'center' ? 'inventory-number-cell' : ''}>{column.label}</th>)}</tr></thead>
      <tbody>{rows.map((row, index) => <tr key={row.id || `${index}-${row.date || row.book || row.title || ''}`}>{columns.map((column) => {
        const value = row[column.key] ?? '—'
        const content = inventoryTable && column.truncate
          ? <span className="inventory-truncate" title={String(value)}>{value}</span>
          : value
        return <td key={column.key} className={column.align === 'center' ? 'inventory-number-cell' : ''}>{content}</td>
      })}</tr>)}</tbody>
    </table></div>}
    {inventoryPagination && <nav className="report-pagination" aria-label="Book inventory report pages">
      <p className="report-pagination-summary" aria-live="polite">Showing {inventoryPagination.rangeStart}–{inventoryPagination.rangeEnd} of {inventoryPagination.total} {inventoryPagination.total === 1 ? 'record' : 'records'}</p>
      <div className="report-pagination-controls">
        <button type="button" onClick={() => inventoryPagination.onPageChange(inventoryPagination.page - 1)} disabled={inventoryPagination.page <= 1}>Previous</button>
        <div className="report-pagination-pages" aria-label="Page numbers">
          {pageNumbers.map((page, index) => <Fragment key={page}>
            {index > 0 && page - pageNumbers[index - 1] > 1 && <span className="report-pagination-ellipsis" aria-hidden="true">…</span>}
            <button type="button" aria-current={page === inventoryPagination.page ? 'page' : undefined} className={page === inventoryPagination.page ? 'active' : ''} onClick={() => inventoryPagination.onPageChange(page)}>{page}</button>
          </Fragment>)}
        </div>
        <button type="button" onClick={() => inventoryPagination.onPageChange(inventoryPagination.page + 1)} disabled={inventoryPagination.page >= inventoryPagination.pageCount}>Next</button>
      </div>
    </nav>}
  </>
}

export function ReportsExplorer({ summaryStats, summaryLoading = false }) {
  const initialRange = initialDateRange()
  const [startDate, setStartDate] = useState(initialRange.start)
  const [endDate, setEndDate] = useState(initialRange.end)
  const [activeReport, setActiveReport] = useState(REPORTS[0].id)
  const [reportSearch, setReportSearch] = useState('')
  const [reportPage, setReportPage] = useState(1)
  const [snapshot, setSnapshot] = useState({ books: [], copies: [], loans: [], activeLoans: [], reservations: [], audits: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [generatedAt, setGeneratedAt] = useState(null)
  const [printHost] = useState(() => document.createElement('div'))
  const rangeValid = Boolean(startDate && endDate && startDate <= endDate)
  const activeDefinition = REPORTS.find((report) => report.id === activeReport) || REPORTS[0]
  const summaryReady = REPORT_SUMMARY_ITEMS.every(({ key }) => Number.isFinite(summaryStats?.[key]))
  const printReady = !loading && !summaryLoading && !error && rangeValid && summaryReady

  useEffect(() => {
    printHost.className = 'report-print-host'
    document.body.appendChild(printHost)
    return () => printHost.remove()
  }, [printHost])

  useEffect(() => {
    const resetGeneratedAt = () => setGeneratedAt(null)
    window.addEventListener('afterprint', resetGeneratedAt)
    return () => window.removeEventListener('afterprint', resetGeneratedAt)
  }, [])

  useEffect(() => {
    let active = true
    const load = async (showLoading = true) => {
      if (!supabase || !rangeValid) {
        if (active) setLoading(false)
        return
      }
      if (showLoading) setLoading(true)
      setError('')
      const start = dateBoundary(startDate)
      const end = dateBoundary(endDate, 1)
      const loanFields = 'id, copy_id, member_id, status, checked_out_at, due_at, returned_at, book_copies(barcode, book_id, location, books(title)), member:library_members!loans_member_id_fkey(full_name, library_card_number, school_id)'
      try {
        const results = await Promise.all([
          fetchAllRows(() => supabase.from('books').select('id, title, author, isbn, category, course_subject').order('title', { ascending: true })),
          fetchAllRows(() => supabase.from('book_copies').select('id, book_id, barcode, location, status, created_at').order('id')),
          fetchAllRows(() => supabase.from('loans').select(loanFields).gte('checked_out_at', start).lt('checked_out_at', end).order('id')),
          fetchAllRows(() => supabase.from('loans').select(loanFields).not('returned_at', 'is', null).gte('returned_at', start).lt('returned_at', end).order('id')),
          fetchAllRows(() => supabase.from('loans').select(loanFields).in('status', ['borrowed', 'overdue']).order('id')),
          fetchAllRows(() => supabase.from('reservations').select('id, book_id, member_id, borrower_type, borrower_full_name, student_employee_id, reservation_date, expected_pickup_date, status, created_at, books(title), member:library_members!reservations_member_id_fkey(full_name, library_card_number)').gte('reservation_date', startDate).lte('reservation_date', endDate).order('id')),
          fetchAllRows(() => supabase.from('inventory_audits').select('id, status, started_at, completed_at, summary, inventory_audit_items(id, barcode, title_snapshot, expected_status, expected_location, observed_location, result, scanned_at)').gte('started_at', start).lt('started_at', end).order('id')),
        ])
        if (!active) return
        const failure = results.find((result) => result.error)
        if (failure?.error) throw failure.error
        const loansInRange = new Map()
        ;[results[2].data, results[3].data].flat().forEach((loan) => loansInRange.set(loan.id, loan))
        setSnapshot({
          books: results[0].data || [], copies: results[1].data || [],
          loans: [...loansInRange.values()], activeLoans: results[4].data || [],
          reservations: results[5].data || [], audits: results[6].data || [],
        })
      } catch (loadError) {
        if (import.meta.env.DEV) console.error('[reports] records failed', loadError)
        if (active) setError('Unable to load report records. Please try again.')
      } finally {
        if (active && showLoading) setLoading(false)
      }
    }

    load()
    const interval = window.setInterval(() => load(false), 60_000)
    const refreshOnFocus = () => { if (document.visibilityState === 'visible') load(false) }
    window.addEventListener('focus', refreshOnFocus)
    return () => { active = false; window.clearInterval(interval); window.removeEventListener('focus', refreshOnFocus) }
  }, [startDate, endDate, rangeValid, refreshKey])

  const inventoryRows = useMemo(() => {
    const copiesByBook = new Map()
    snapshot.copies.forEach((copy) => {
      const values = copiesByBook.get(copy.book_id) || []
      values.push(copy)
      copiesByBook.set(copy.book_id, values)
    })
    return snapshot.books.map((book) => {
      const copies = copiesByBook.get(book.id) || []
      const shelfCounts = Object.fromEntries(SHELVES.map((shelf) => [shelf, copies.filter((copy) => copy.location === shelf).length]))
      const other = copies.filter((copy) => !SHELVES.includes(copy.location)).length
      const available = copies.filter((copy) => copy.status === 'available').length
      return {
        title: book.title, author: book.author, isbn: book.isbn || 'Not recorded', subject: book.course_subject || book.category || 'Not tagged',
        total: copies.length, available, filipiniana: shelfCounts.Filipiniana, thesis: shelfCounts.Thesis,
        general: shelfCounts['General Circulation'], fiction: shelfCounts.Fiction, other,
        shelfSearch: SHELVES.map((shelf) => `${shelf} ${shelfCounts[shelf]}`).join(' ') + ` Other / unassigned ${other}`,
      }
    })
  }, [snapshot.books, snapshot.copies])

  const circulationEvents = useMemo(() => {
    const start = startDate
    const end = endDate
    const events = []
    snapshot.loans.forEach((loan) => {
      const book = loan.book_copies?.books?.title || 'Unknown book'
      const borrower = loan.member?.full_name || 'Unknown borrower'
      const borrowerId = loan.member?.library_card_number || loan.member?.school_id || 'Not recorded'
      const borrowerKey = loan.member_id || borrowerId
      const barcode = loan.book_copies?.barcode || 'Not recorded'
      if (dateKey(loan.checked_out_at) >= start && dateKey(loan.checked_out_at) <= end) events.push({
        id: `${loan.id}-checkout`, occurredAt: loan.checked_out_at, date: dateText(loan.checked_out_at, true), day: dateKey(loan.checked_out_at), type: 'Checkout', book, borrower, borrowerId, borrowerKey, barcode,
      })
      if (loan.returned_at && dateKey(loan.returned_at) >= start && dateKey(loan.returned_at) <= end) events.push({
        id: `${loan.id}-return`, occurredAt: loan.returned_at, date: dateText(loan.returned_at, true), day: dateKey(loan.returned_at), type: 'Return', book, borrower, borrowerId, borrowerKey, barcode,
      })
    })
    return events.sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
  }, [snapshot.loans, startDate, endDate])

  const overdueRows = useMemo(() => {
    const now = Date.now()
    return snapshot.activeLoans.filter((loan) => !loan.returned_at && loan.due_at && new Date(loan.due_at).getTime() < now && dateKey(loan.due_at) >= startDate && dateKey(loan.due_at) <= endDate).map((loan) => {
      const days = Math.max(1, Math.ceil((now - new Date(loan.due_at).getTime()) / 86_400_000))
      const age = days <= 7 ? '1–7 days overdue' : days <= 30 ? '8–30 days overdue' : 'Over 30 days overdue'
      return {
        book: loan.book_copies?.books?.title || 'Unknown book', barcode: loan.book_copies?.barcode || 'Not recorded',
        borrower: loan.member?.full_name || 'Unknown borrower', borrowerId: loan.member?.library_card_number || loan.member?.school_id || 'Not recorded',
        borrowed: dateText(loan.checked_out_at), due: dateText(loan.due_at), daysOverdue: days, age, status: 'Overdue',
      }
    }).sort((left, right) => right.daysOverdue - left.daysOverdue)
  }, [snapshot.activeLoans, startDate, endDate])

  const reservationRows = useMemo(() => snapshot.reservations.map((reservation) => ({
    date: dateText(reservation.reservation_date), borrower: reservation.borrower_full_name || reservation.member?.full_name || 'Unknown borrower',
    borrowerType: reservation.borrower_type || 'Not recorded', borrowerId: reservation.student_employee_id || reservation.member?.library_card_number || 'Not recorded',
    book: reservation.books?.title || 'Unknown book', pickup: dateText(reservation.expected_pickup_date),
    status: RESERVATION_LABELS[reservation.status] || reservation.status,
  })), [snapshot.reservations])

  const memberRows = useMemo(() => {
    const members = new Map()
    circulationEvents.forEach((event) => {
      const key = event.borrowerKey
      const row = members.get(key) || { borrower: event.borrower, borrowerId: event.borrowerId, checkouts: 0, returns: 0, lastActivity: event.date, activitySearch: `${event.borrower} ${event.borrowerId}` }
      if (event.type === 'Checkout') row.checkouts += 1
      else row.returns += 1
      if (event.occurredAt > row._lastAt || !row._lastAt) { row._lastAt = event.occurredAt; row.lastActivity = event.date }
      members.set(key, row)
    })
    return [...members.values()].map(({ _lastAt, ...row }) => ({ ...row, total: row.checkouts + row.returns })).sort((left, right) => right.total - left.total)
  }, [circulationEvents])

  const popularRows = useMemo(() => {
    const titles = new Map()
    circulationEvents.filter((event) => event.type === 'Checkout').forEach((event) => {
      const row = titles.get(event.book) || { book: event.book, checkouts: 0, borrowers: new Set() }
      row.checkouts += 1
      row.borrowers.add(event.borrowerKey)
      titles.set(event.book, row)
    })
    return [...titles.values()].map((row) => ({ book: row.book, checkouts: row.checkouts, borrowers: row.borrowers.size })).sort((left, right) => right.checkouts - left.checkouts || left.book.localeCompare(right.book))
  }, [circulationEvents])

  const auditRows = useMemo(() => snapshot.audits.flatMap((audit) => {
    const items = audit.inventory_audit_items || []
    if (!items.length) return [{
      id: audit.id, auditDate: dateText(audit.started_at, true), auditStatus: audit.status === 'completed' ? 'Completed' : 'In progress',
      book: 'No items in this audit snapshot', barcode: '—', expectedStatus: '—', expectedShelf: '—', observedShelf: '—',
      result: audit.status === 'completed' ? 'Empty audit snapshot' : 'No items scanned',
    }]
    return items.map((item) => ({
      id: item.id, auditDate: dateText(audit.started_at, true), auditStatus: audit.status === 'completed' ? 'Completed' : 'In progress',
      book: item.title_snapshot || 'Unknown book', barcode: item.barcode || 'Not recorded', expectedStatus: item.expected_status || 'Not in snapshot',
      expectedShelf: item.expected_location || 'Not recorded', observedShelf: item.observed_location || 'Not scanned',
      result: AUDIT_LABELS[item.result] || item.result,
    }))
  }), [snapshot.audits])

  const reportModel = useMemo(() => {
    switch (activeReport) {
      case 'inventory': return {
        rows: inventoryRows,
        columns: [
          { key: 'title', label: 'Book Title', width: 270, truncate: true }, { key: 'author', label: 'Author', width: 185, truncate: true },
          { key: 'isbn', label: 'ISBN', width: 145, truncate: true }, { key: 'subject', label: 'Course/Subject', width: 205, truncate: true },
          { key: 'total', label: 'Total Copies', width: 105, align: 'center' }, { key: 'available', label: 'Available', width: 100, align: 'center' },
          { key: 'filipiniana', label: 'Filipiniana', width: 120, align: 'center' }, { key: 'thesis', label: 'Thesis', width: 90, align: 'center' },
          { key: 'general', label: 'General Circulation', width: 175, align: 'center' }, { key: 'fiction', label: 'Fiction', width: 90, align: 'center' },
          { key: 'other', label: 'Other/Unassigned', width: 140, align: 'center' },
        ],
      }
      case 'circulation': return { rows: circulationEvents.map(({ id, date, type, borrower, borrowerId, book, barcode }) => ({ id, date, type, borrower, borrowerId, book, barcode })), columns: [
        { key: 'date', label: 'Date and time' }, { key: 'type', label: 'Activity' }, { key: 'borrower', label: 'Borrower' }, { key: 'borrowerId', label: 'Card / ID' }, { key: 'book', label: 'Book title' }, { key: 'barcode', label: 'Barcode' },
      ] }
      case 'overdue': return { rows: overdueRows, columns: [
        { key: 'borrower', label: 'Borrower' }, { key: 'borrowerId', label: 'Card / ID' }, { key: 'book', label: 'Book title' }, { key: 'barcode', label: 'Barcode' },
        { key: 'borrowed', label: 'Borrowed' }, { key: 'due', label: 'Due date' }, { key: 'daysOverdue', label: 'Days overdue' }, { key: 'status', label: 'Status' },
      ] }
      case 'reservations': return { rows: reservationRows, columns: [
        { key: 'date', label: 'Reservation date' }, { key: 'borrower', label: 'Borrower' }, { key: 'borrowerType', label: 'Borrower type' }, { key: 'borrowerId', label: 'Borrower ID' },
        { key: 'book', label: 'Book title' }, { key: 'pickup', label: 'Expected pickup' }, { key: 'status', label: 'Status' },
      ] }
      case 'members': return { rows: memberRows, columns: [
        { key: 'borrower', label: 'Borrower' }, { key: 'borrowerId', label: 'Card / ID' }, { key: 'checkouts', label: 'Checkouts' },
        { key: 'returns', label: 'Returns' }, { key: 'total', label: 'Activity events' }, { key: 'lastActivity', label: 'Last activity' },
      ] }
      case 'popular': return { rows: popularRows, columns: [
        { key: 'book', label: 'Book title' }, { key: 'checkouts', label: 'Times borrowed' }, { key: 'borrowers', label: 'Unique borrowers' },
      ] }
      default: return { rows: auditRows, columns: [
        { key: 'auditDate', label: 'Audit started' }, { key: 'auditStatus', label: 'Audit status' }, { key: 'book', label: 'Book title' }, { key: 'barcode', label: 'Barcode' },
        { key: 'expectedStatus', label: 'Expected status' }, { key: 'expectedShelf', label: 'Expected shelf' }, { key: 'observedShelf', label: 'Observed shelf' }, { key: 'result', label: 'Result' },
      ] }
    }
  }, [activeReport, inventoryRows, circulationEvents, overdueRows, reservationRows, memberRows, popularRows, auditRows])

  const filteredRows = useMemo(() => {
    const term = reportSearch.trim().toLocaleLowerCase()
    if (!term) return reportModel.rows
    return reportModel.rows.filter((row) => Object.values(row).some((value) => String(value ?? '').toLocaleLowerCase().includes(term)))
  }, [reportModel, reportSearch])

  const chartData = useMemo(() => {
    const countBy = (rows, key) => {
      const counts = new Map()
      rows.forEach((row) => counts.set(row[key], (counts.get(row[key]) || 0) + 1))
      return [...counts].map(([label, value]) => ({ label, value })).sort((left, right) => right.value - left.value)
    }
    switch (activeReport) {
      case 'inventory': {
        if (!snapshot.books.length) return []
        const totals = SHELVES.map((shelf) => ({ label: shelf, value: inventoryRows.reduce((sum, row) => sum + Number(row[{ Filipiniana: 'filipiniana', Thesis: 'thesis', 'General Circulation': 'general', Fiction: 'fiction' }[shelf]]), 0) }))
        totals.push({ label: 'Other / unassigned', value: inventoryRows.reduce((sum, row) => sum + row.other, 0) })
        return totals
      }
      case 'overdue': return countBy(overdueRows, 'age')
      case 'reservations': return countBy(reservationRows, 'status')
      case 'members': return memberRows.slice(0, 8).map((row) => ({ label: row.borrower, value: row.total }))
      case 'popular': return popularRows.slice(0, 8).map((row) => ({ label: row.book, value: row.checkouts }))
      case 'audit': return countBy(auditRows, 'result')
      default: return []
    }
  }, [activeReport, inventoryRows, overdueRows, reservationRows, memberRows, popularRows, auditRows, snapshot.books.length])

  const updateReportSearch = (value) => {
    setReportSearch(value)
    setReportPage(1)
  }
  const chartSelect = (label) => updateReportSearch(/^\d{4}-\d{2}-\d{2}$/.test(label) ? dateText(label) : label)
  const inventoryPageCount = Math.ceil(filteredRows.length / INVENTORY_PAGE_SIZE)
  const currentInventoryPage = Math.min(reportPage, Math.max(inventoryPageCount, 1))
  const visibleRows = activeReport === 'inventory'
    ? filteredRows.slice((currentInventoryPage - 1) * INVENTORY_PAGE_SIZE, currentInventoryPage * INVENTORY_PAGE_SIZE)
    : filteredRows
  const inventoryPagination = activeReport === 'inventory' ? {
    page: currentInventoryPage,
    pageCount: inventoryPageCount,
    total: filteredRows.length,
    rangeStart: filteredRows.length ? (currentInventoryPage - 1) * INVENTORY_PAGE_SIZE + 1 : 0,
    rangeEnd: Math.min(currentInventoryPage * INVENTORY_PAGE_SIZE, filteredRows.length),
    onPageChange: setReportPage,
  } : undefined
  const exportReport = () => {
    const slug = activeReport.replaceAll(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')
    downloadCsv(`iba-library-${slug}-${startDate}-to-${endDate}.csv`, reportModel.columns, filteredRows)
  }
  const printReport = () => {
    if (!printReady) return
    setGeneratedAt(new Date())
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => window.print()))
  }

  return <>
    <section className="reports-explorer" aria-label="Detailed library reports">
    <header className="reports-explorer-heading"><div><span className="eyebrow">Detailed reports</span><h3>Library Reports</h3><p>Search, chart, print, and export live records from the library database.</p></div>
      <div className="report-export-actions"><button type="button" className="secondary-button" onClick={printReport} disabled={!printReady} title={!printReady ? 'Wait for the library report data to finish loading.' : undefined}>Print / Save PDF</button><button type="button" className="primary-button" onClick={exportReport} disabled={!filteredRows.length}>Download Excel CSV</button><button type="button" className="report-refresh-button" onClick={() => setRefreshKey((current) => current + 1)} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh data'}</button></div>
    </header>
    <div className="report-date-toolbar">
      <label><span>From</span><input type="date" value={startDate} max={endDate || undefined} onChange={(event) => { setStartDate(event.target.value); updateReportSearch('') }} /></label>
      <label><span>Through</span><input type="date" value={endDate} min={startDate || undefined} onChange={(event) => { setEndDate(event.target.value); updateReportSearch('') }} /></label>
      <p>Activity reports use this date range. Inventory is a current snapshot.</p>
    </div>
    <div className="report-tabs" role="tablist" aria-label="Library report types">{REPORTS.map((report) => <button type="button" role="tab" key={report.id} aria-selected={activeReport === report.id} className={activeReport === report.id ? 'active' : ''} onClick={() => { setActiveReport(report.id); updateReportSearch('') }}>{report.label}</button>)}</div>
    {!rangeValid && <div className="inline-error" role="alert">Choose a valid date range. The start date must be on or before the end date.</div>}
    {error && <div className="inline-error with-action" role="alert"><span>{error}</span><button type="button" className="retry-button" onClick={() => setRefreshKey((current) => current + 1)}>Try again</button></div>}
    {loading && !error ? <div className="empty-state loading-state" role="status">Loading report records…</div> : !error && rangeValid && <article className={`report-detail-card${activeReport === 'inventory' ? ' inventory-report-card' : ''}`} role="tabpanel">
      <header className="report-detail-heading"><div><h4>{activeDefinition.label}</h4><p>{activeDefinition.description}</p></div><span>{activeReport === 'inventory' ? 'Current snapshot' : `${dateText(startDate)} – ${dateText(endDate)}`}</span></header>
      {activeReport === 'circulation' && <section className="report-chart-panel"><h5>Checkouts and returns by day</h5><ActivityTrend events={circulationEvents} onSelect={chartSelect} /></section>}
      {activeReport !== 'circulation' && <section className="report-chart-panel"><h5>{activeReport === 'inventory' ? 'Copies by shelf category' : activeReport === 'overdue' ? 'Current overdue duration' : activeReport === 'reservations' ? 'Reservations by status' : activeReport === 'members' ? 'Most active borrowers' : activeReport === 'popular' ? 'Most borrowed titles' : 'Audit results'}</h5>{chartData.length ? <InteractiveBars data={chartData} onSelect={chartSelect} formatter={activeReport === 'inventory' ? (value) => plural(value, 'copy') : (value) => plural(value, 'record')} /> : <ReportEmpty title="No chart data" description="This chart will populate when matching records exist." />}</section>}
      {activeReport === 'overdue' && <p className="report-note">Overdue rows are active loans whose due date falls in the selected period.</p>}
      {activeReport === 'inventory' && <p className="report-note">Shelf totals include every registered copy, regardless of current circulation status. Other / unassigned includes legacy or blank shelf values.</p>}
      <div className="report-table-heading"><div><h5>Report records</h5><p>{plural(filteredRows.length, 'record')} shown</p></div>{reportSearch && <button type="button" className="report-clear-search" onClick={() => updateReportSearch('')}>Clear chart / search filter</button>}</div>
      <SearchableTable rows={visibleRows} columns={reportModel.columns} query={reportSearch} onQueryChange={updateReportSearch} resultCount={filteredRows.length} inventoryPagination={inventoryPagination} />
    </article>}
    <p className="report-live-note">Records refresh when the page regains focus and every minute while Reports is open.</p>
    </section>
    <ReportPrintDocument host={printHost} activeReport={activeReport} activeDefinition={activeDefinition} columns={reportModel.columns} rows={filteredRows} summaryStats={summaryStats} startDate={startDate} endDate={endDate} reportSearch={reportSearch} generatedAt={generatedAt} />
  </>
}
