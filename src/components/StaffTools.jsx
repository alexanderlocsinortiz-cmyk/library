import { CirculationHealth } from './CirculationHealth'
import { usePagination } from './Pagination'
import { fetchAllRows } from '../lib/paging'
import { useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogTitle, Menu, MenuItem } from '@mui/material'
import { supabase } from '../lib/supabase'
import { BOOK_COVERS_BUCKET, getBookCoverExtension, getBookCoverUrl, optimizeBookCoverFile, validateBookCoverFile } from '../lib/book-covers'
import { BookCoverArt } from './BookCoverArt'
import { defaultCirculationPolicy, formatFine, normalizeCirculationPolicy } from '../lib/circulation'
import { ConfirmDialog } from './ConfirmDialog'
import { getBookCategories } from '../lib/book-categories'
import { SHELF_LOCATIONS } from '../lib/shelf-locations'
import { CameraBarcodeScanner } from './CameraBarcodeScanner'

const emptyBook = { title: '', author: '', isbn: '', category: '', course_subject: '', publication_year: '', description: '' }
const emptyCopy = { book_id: '', barcode: '', location: '', condition: 'good' }

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

function PhysicalCopyFields({ books, copy, setCopy, editing = false }) {
  return <>
    <label>Book
      <select value={copy.book_id} onChange={(event) => setCopy((current) => ({ ...current, book_id: event.target.value }))} required disabled={editing}>
        <option value="">Select a book</option>
        {books.map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}
      </select>
    </label>
    <label>Barcode<input value={copy.barcode} onChange={(event) => setCopy((current) => ({ ...current, barcode: event.target.value }))} required /></label>
    <div className="form-row">
      <label>Shelf Location
        <select value={copy.location} onChange={(event) => setCopy((current) => ({ ...current, location: event.target.value }))} required>
          <option value="">Select a shelf</option>
          {SHELF_LOCATIONS.map((shelf) => <option value={shelf} key={shelf}>{shelf}</option>)}
        </select>
      </label>
      <label>Condition<select value={copy.condition} onChange={(event) => setCopy((current) => ({ ...current, condition: event.target.value }))}><option value="good">Good</option><option value="new">New</option><option value="worn">Worn</option></select></label>
    </div>
  </>
}

export function StaffCatalogManager({ onBack, view = 'books', role }) {
  const [books, setBooks] = useState([])
  const [book, setBook] = useState(emptyBook)
  const [editingBookId, setEditingBookId] = useState('')
  const [editingBookRecord, setEditingBookRecord] = useState(null)
  const [coverFile, setCoverFile] = useState(null)
  const [removeCover, setRemoveCover] = useState(false)
  const [bookDialogOpen, setBookDialogOpen] = useState(false)
  const [copyDialogOpen, setCopyDialogOpen] = useState(false)
  const [bookSearch, setBookSearch] = useState('')
  const [bookAvailability, setBookAvailability] = useState('all')
  const [bookPage, setBookPage] = useState(1)
  const [copy, setCopy] = useState(emptyCopy)
  const [copyEditingId, setCopyEditingId] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [pendingDelete, setPendingDelete] = useState(null)
  const canManageCovers = role === 'administrator' || role === 'librarian'
  const [coverPreviewUrl, setCoverPreviewUrl] = useState('')
  const coverPreviewUrlRef = useRef('')
  const copyCount = books.reduce((total, item) => total + (item.book_copies?.length ?? 0), 0)
  const bookCategories = getBookCategories(books)
  const filteredBookTitles = books.filter((item) => {
    const searchText = `${item.title || ''} ${item.author || ''} ${item.isbn || ''} ${item.course_subject || ''} ${item.category || ''}`.toLowerCase()
    const available = (item.book_copies || []).some((itemCopy) => itemCopy.status === 'available')
    return searchText.includes(bookSearch.trim().toLowerCase())
      && (bookAvailability === 'all' || (bookAvailability === 'available' && available) || (bookAvailability === 'unavailable' && !available))
  })
  const bookPageSize = 6
  const bookPageCount = Math.max(1, Math.ceil(filteredBookTitles.length / bookPageSize))
  const activeBookPage = Math.min(bookPage, bookPageCount)
  const firstBookIndex = (activeBookPage - 1) * bookPageSize
  const bookPageItems = filteredBookTitles.slice(firstBookIndex, firstBookIndex + bookPageSize)
  const firstBookNumber = filteredBookTitles.length === 0 ? 0 : firstBookIndex + 1
  const lastBookNumber = Math.min(activeBookPage * bookPageSize, filteredBookTitles.length)
  const firstVisiblePage = Math.max(1, Math.min(activeBookPage - 2, bookPageCount - 4))
  const visibleBookPages = Array.from(
    { length: Math.min(bookPageCount, 5) },
    (_, index) => firstVisiblePage + index,
  )
  const bookFiltersActive = Boolean(bookSearch.trim()) || bookAvailability !== 'all'
  const clearBookFilters = () => {
    setBookSearch('')
    setBookAvailability('all')
  }

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
        .select('id, title, author, isbn, category, course_subject, publication_year, description, cover_url, cover_image_path, book_copies(id, book_id, barcode, status, location, condition)')
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
  useEffect(() => { setBookPage(1) }, [bookSearch, bookAvailability])
  useEffect(() => () => {
    if (coverPreviewUrlRef.current) URL.revokeObjectURL(coverPreviewUrlRef.current)
  }, [])

  const changeCoverFile = (file) => {
    if (coverPreviewUrlRef.current) URL.revokeObjectURL(coverPreviewUrlRef.current)
    const nextPreviewUrl = file ? URL.createObjectURL(file) : ''
    coverPreviewUrlRef.current = nextPreviewUrl
    setCoverPreviewUrl(nextPreviewUrl)
    setCoverFile(file)
  }

  const chooseCoverFile = async (event) => {
    const input = event.currentTarget
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    setError('')
    try {
      const validFile = await validateBookCoverFile(file)
      changeCoverFile(await optimizeBookCoverFile(validFile))
      setRemoveCover(false)
    } catch (validationError) {
      setError(validationError.message)
    }
  }

  const addBook = async (event) => {
    event.preventDefault()
    setSaving(true)
    setMessage('')
    setError('')
    const payload = {
      ...book,
      publication_year: book.publication_year ? Number(book.publication_year) : null,
    }
    let uploadedCoverPath = ''
    try {
      if (coverFile) {
        if (!canManageCovers || !supabase?.storage) {
          setError('Only administrators and librarians can upload book covers.')
          return
        }
        const bookIdForCover = editingBookId || crypto.randomUUID()
        const extension = getBookCoverExtension(coverFile.type)
        uploadedCoverPath = `${bookIdForCover}/${crypto.randomUUID()}.${extension}`
        const { error: uploadError } = await supabase.storage.from(BOOK_COVERS_BUCKET).upload(uploadedCoverPath, coverFile, {
          cacheControl: '31536000',
          contentType: coverFile.type,
          upsert: false,
        })
        if (uploadError) {
          const { error: cleanupError } = await supabase.storage.from(BOOK_COVERS_BUCKET).remove([uploadedCoverPath])
          if (cleanupError && import.meta.env.DEV) console.error('[staff catalog] failed upload cleanup', cleanupError)
          setError('Unable to upload this cover. Check the file and your administrator access, then try again.')
          return
        }
      }

      const coverPayload = coverFile
        ? { cover_image_path: uploadedCoverPath, cover_url: null }
        : removeCover
          ? { cover_image_path: null, cover_url: null }
          : {}
      const recordPayload = { ...payload, ...coverPayload }
      const result = editingBookId
        ? await supabase.from('books').update({ ...recordPayload, updated_at: new Date().toISOString() }).eq('id', editingBookId)
        : await supabase.from('books').insert({ ...(coverFile ? { id: uploadedCoverPath.split('/')[0] } : {}), ...recordPayload })

      if (result.error) {
        if (uploadedCoverPath) {
          const { error: cleanupError } = await supabase.storage.from(BOOK_COVERS_BUCKET).remove([uploadedCoverPath])
          if (cleanupError && import.meta.env.DEV) console.error('[staff catalog] failed upload cleanup', cleanupError)
        }
        setError('Unable to save the book. Please check the form and try again.')
        return
      }

      const previousCoverPath = editingBookRecord?.cover_image_path
      let cleanupWarning = ''
      if (previousCoverPath && (coverFile || removeCover)) {
        const { error: cleanupError } = await supabase.storage.from(BOOK_COVERS_BUCKET).remove([previousCoverPath])
        if (cleanupError) {
          if (removeCover && !coverFile) {
            const { error: restoreError } = await supabase.from('books').update({
              cover_image_path: previousCoverPath,
              cover_url: editingBookRecord.cover_url || null,
            }).eq('id', editingBookId)
            await loadBooks()
            if (!restoreError) setRemoveCover(false)
            setError(restoreError
              ? 'The cover reference was removed, but its image could not be deleted from storage.'
              : 'Unable to remove the stored cover. The existing cover has been restored.')
            return
          }
          cleanupWarning = ' The previous image could not be removed from storage.'
        }
      }

      setMessage(`${editingBookId ? 'Book details updated.' : 'Book added to the catalog.'}${coverFile ? ' Cover saved.' : removeCover ? ' Cover removed.' : ''}${cleanupWarning}`)
      setBook(emptyBook)
      setEditingBookId('')
      setEditingBookRecord(null)
      changeCoverFile(null)
      setRemoveCover(false)
      setBookDialogOpen(false)
      setBookPage(1)
      await loadBooks()
    } catch (saveError) {
      if (uploadedCoverPath) {
        const { error: cleanupError } = await supabase.storage.from(BOOK_COVERS_BUCKET).remove([uploadedCoverPath])
        if (cleanupError && import.meta.env.DEV) console.error('[staff catalog] failed upload cleanup', cleanupError)
      }
      if (import.meta.env.DEV) console.error('[staff catalog] save book failed', saveError)
      setError('Unable to save the book. Please check the form and try again.')
    } finally {
      setSaving(false)
    }
  }

  const startEditing = (item) => {
    setEditingBookId(item.id)
    setEditingBookRecord(item)
    setBook({ title: item.title || '', author: item.author || '', isbn: item.isbn || '', category: item.category || '', course_subject: item.course_subject || '', publication_year: item.publication_year || '', description: item.description || '' })
    changeCoverFile(null)
    setRemoveCover(false)
    setBookDialogOpen(true)
    setMessage('')
    setError('')
  }

  const cancelEditing = () => {
    setEditingBookId('')
    setEditingBookRecord(null)
    setBook(emptyBook)
    changeCoverFile(null)
    setRemoveCover(false)
    setBookDialogOpen(false)
    setMessage('')
  }

  const openAddBook = () => {
    setEditingBookId('')
    setEditingBookRecord(null)
    setBook(emptyBook)
    changeCoverFile(null)
    setRemoveCover(false)
    setMessage('')
    setError('')
    setBookDialogOpen(true)
  }

  const openAddCopy = () => {
    setCopyEditingId('')
    setCopy(emptyCopy)
    setMessage('')
    setError('')
    setCopyDialogOpen(true)
  }

  const cancelAddCopy = () => {
    setCopyEditingId('')
    setCopy(emptyCopy)
    setCopyDialogOpen(false)
    setError('')
  }

  const startEditingCopy = (bookItem, copyItem) => {
    setCopyEditingId(copyItem.id)
    setCopy({
      book_id: copyItem.book_id || bookItem.id,
      barcode: copyItem.barcode || '',
      location: SHELF_LOCATIONS.includes(copyItem.location) ? copyItem.location : '',
      condition: copyItem.condition || 'good',
    })
    setError('')
    setMessage('')
  }

  const deleteBook = async (bookId) => {
    setSaving(true)
    setMessage('')
    setError('')
    try {
      const { error: deleteError } = await supabase.rpc('delete_book_record', { p_book_id: bookId })
      if (deleteError) setError('Unable to delete this book. Borrowing history or active reservations may still exist.')
      else {
        setMessage('Book deleted from the catalog.')
        setBookPage(1)
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

  const saveCopy = async (event) => {
    event.preventDefault()
    const barcode = copy.barcode.trim()
    const location = copy.location.trim()
    if (!copy.book_id || !barcode || !SHELF_LOCATIONS.includes(location)) {
      setError('Select a book, enter a barcode, and choose a shelf for this copy.')
      return
    }
    const normalizedBarcode = barcode.toLocaleLowerCase()
    const duplicateBarcode = books.some((item) => (item.book_copies || []).some((itemCopy) => itemCopy.id !== copyEditingId && (itemCopy.barcode || '').trim().toLocaleLowerCase() === normalizedBarcode))
    if (duplicateBarcode) {
      setError('A physical copy with this barcode already exists.')
      return
    }
    setSaving(true)
    setMessage('')
    setError('')
    try {
      const copyPayload = { barcode, location, condition: copy.condition }
      const result = copyEditingId
        ? await supabase.from('book_copies').update({ ...copyPayload, updated_at: new Date().toISOString() }).eq('id', copyEditingId)
        : await supabase.from('book_copies').insert({ ...copyPayload, book_id: copy.book_id })
      if (result.error) {
        const duplicateError = result.error.code === '23505' || /duplicate|unique/i.test(result.error.message || '')
        setError(duplicateError ? 'A physical copy with this barcode already exists.' : `Unable to ${copyEditingId ? 'update' : 'add'} the physical copy. Check the form and try again.`)
      }
      else {
        setMessage(copyEditingId ? 'Physical copy updated.' : 'Physical copy added.')
        setCopyEditingId('')
        setCopy(emptyCopy)
        if (view === 'books') setCopyDialogOpen(false)
        await loadBooks()
      }
    } catch (saveError) {
      if (import.meta.env.DEV) console.error('[staff catalog] save copy failed', saveError)
      setError(`Unable to ${copyEditingId ? 'update' : 'add'} the physical copy. Check the form and try again.`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className={view === 'books' ? 'content-section book-management-section' : 'content-section'}>
      {view === 'books' ? <header className="book-page-header-card">
        <div className="book-page-header-copy">
          <span className="eyebrow">Catalog management</span>
          <h2>Books</h2>
          <p>Manage book titles in the library catalog.</p>
        </div>
        {onBack && <button type="button" className="book-page-header-back" onClick={onBack}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /><path d="M20 12H9" /></svg>
          <span>Back to dashboard</span>
        </button>}
      </header> : <ToolHeader
        eyebrow="Library inventory"
        title="Physical copies"
        description="Register physical copies and review their current status."
        onBack={onBack}
      />}
      {(message || (error && !bookDialogOpen && !copyDialogOpen)) && <div role={error ? 'alert' : 'status'} className={error ? 'inline-error with-action' : 'inline-success'}><span>{error || message}</span>{error && !bookDialogOpen && !copyDialogOpen && <button type="button" className="retry-button" onClick={loadBooks}>Try again</button>}</div>}
      {view === 'books' && <Dialog
        open={bookDialogOpen}
        onClose={() => { if (!saving) cancelEditing() }}
        fullWidth
        maxWidth="sm"
        aria-labelledby="book-title-dialog-heading"
        sx={{ '& .MuiDialog-paper': { borderRadius: '1rem' } }}
      >
        <DialogTitle id="book-title-dialog-heading">{editingBookId ? 'Edit book title' : 'Add a book'}</DialogTitle>
        <DialogContent dividers>
          <form className="tool-form book-title-dialog-form" onSubmit={addBook}>
            {error && <div className="inline-error" role="alert">{error}</div>}
            <label>Title<input value={book.title} onChange={(event) => setBook({ ...book, title: event.target.value })} required /></label>
            <label>Author<input value={book.author} onChange={(event) => setBook({ ...book, author: event.target.value })} required /></label>
            <label>ISBN<input value={book.isbn} onChange={(event) => setBook({ ...book, isbn: event.target.value })} /></label>
            <label>Book description<textarea aria-label="Book description" value={book.description} onChange={(event) => setBook({ ...book, description: event.target.value })} rows={4} maxLength={2000} placeholder="Summarize the subjects and ideas covered in this book." /><small className="form-helper">Use a concise, accurate overview. You can revise it when editing this book.</small></label>
            {canManageCovers && <div className="book-cover-editor">
              <div className="book-cover-editor-preview">
                <BookCoverArt
                  book={{ ...(editingBookRecord || {}), ...book, title: book.title || 'Book cover preview' }}
                  className="book-cover-preview"
                  srcOverride={coverFile ? coverPreviewUrl : ''}
                  loading="eager"
                  externalLookup
                  suppressSavedCover={removeCover}
                />
                <small>{coverFile ? 'Selected cover preview' : removeCover ? 'Saved cover will be removed; a verified external cover may still appear' : editingBookRecord && getBookCoverUrl(editingBookRecord) ? 'Current saved cover' : 'Open Library suggestions require matching ISBN, title, and author'}</small>
              </div>
              <div className="book-cover-editor-controls">
                <label>Book cover image<input type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" onChange={chooseCoverFile} disabled={saving} /></label>
                <small className="form-helper">JPG, PNG, or WebP up to 5 MB. Large covers are resized and compressed before upload.</small>
                {coverFile
                  ? <button className="secondary-button" type="button" onClick={() => changeCoverFile(null)} disabled={saving}>Clear selected image</button>
                  : editingBookRecord?.cover_image_path || editingBookRecord?.cover_url
                    ? removeCover
                      ? <button className="secondary-button" type="button" onClick={() => setRemoveCover(false)} disabled={saving}>Keep existing cover</button>
                      : <button className="secondary-button" type="button" onClick={() => setRemoveCover(true)} disabled={saving}>Remove existing cover</button>
                    : null}
              </div>
            </div>}
            <div className="form-row">
              <label>Category<select value={book.category} onChange={(event) => setBook({ ...book, category: event.target.value })}>
                <option value="">Select a category</option>
                {bookCategories.map((category) => <option value={category} key={category}>{category}</option>)}
              </select></label>
              <label>Publication year<input type="number" value={book.publication_year} onChange={(event) => setBook({ ...book, publication_year: event.target.value })} /></label>
            </div>
            <label>Course / subject tags<input value={book.course_subject} onChange={(event) => setBook({ ...book, course_subject: event.target.value })} maxLength={200} placeholder="e.g. Accounting, Business Management" /><small className="form-helper">Enter the course or subject names students would search for.</small></label>
            <div className="form-actions">
              <button className="primary-button" disabled={saving}>{saving ? 'Saving...' : editingBookId ? 'Save changes' : 'Add book'}</button>
              <button className="secondary-button" type="button" onClick={cancelEditing} disabled={saving}>Cancel</button>
            </div>
          </form>
        </DialogContent>
      </Dialog>}
      {view === 'books' && <Dialog
        open={copyDialogOpen}
        onClose={() => { if (!saving) cancelAddCopy() }}
        fullWidth
        maxWidth="sm"
        aria-labelledby="physical-copy-dialog-heading"
        sx={{ '& .MuiDialog-paper': { borderRadius: '1rem' } }}
      >
      <DialogTitle id="physical-copy-dialog-heading">Add Physical Copy</DialogTitle>
        <DialogContent dividers>
          <form className="tool-form book-title-dialog-form" onSubmit={saveCopy}>
            {copyDialogOpen && error && <div className="inline-error" role="alert">{error}</div>}
            {loading ? <p className="form-helper" role="status">Loading catalog titles...</p> : books.length === 0 && <p className="form-helper" role="status">Add a book to the catalog before registering a physical copy.</p>}
            <PhysicalCopyFields books={books} copy={copy} setCopy={setCopy} />
            <div className="form-actions">
              <button className="primary-button" disabled={saving || loading || books.length === 0}>{saving ? 'Saving...' : 'Save Copy'}</button>
              <button className="secondary-button" type="button" onClick={cancelAddCopy} disabled={saving}>Cancel</button>
            </div>
          </form>
        </DialogContent>
      </Dialog>}
      {view === 'books' && <div className="book-management-card">
        <header className="book-management-card-header">
          <div><h3>Catalog Titles</h3><p>Manage book records in the library catalog.</p></div>
          <div className="book-header-actions">
            <button type="button" className="book-add-copy-button" onClick={openAddCopy}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              <span>Add Copy</span>
            </button>
            <button type="button" className="primary-button book-add-button" onClick={openAddBook}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              <span>Add Book</span>
            </button>
          </div>
        </header>
        <div className="book-filter-toolbar">
          <label className="book-filter-field book-search-field"><span>Search titles</span><span className="book-search-input-wrap">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
            <input type="search" value={bookSearch} onChange={(event) => setBookSearch(event.target.value)} placeholder="Search title, author, ISBN, or subject" aria-label="Search book titles" />
          </span></label>
          <label className="book-filter-field"><span>Availability</span><select value={bookAvailability} onChange={(event) => setBookAvailability(event.target.value)} aria-label="Filter titles by availability"><option value="all">All availability</option><option value="available">Available copies</option><option value="unavailable">No available copies</option></select></label>
        </div>
        <div className="book-list-meta">
          <span>{filteredBookTitles.length} matching {filteredBookTitles.length === 1 ? 'book' : 'books'}</span>
          {bookFiltersActive && <button type="button" className="book-clear-filters" onClick={clearBookFilters}>Clear Filters</button>}
        </div>
        <div className="book-table-scroll">
          {loading ? <div className="empty-state loading-state">Loading catalog...</div> : books.length === 0 ? <div className="empty-state">No books have been added yet.</div> : filteredBookTitles.length === 0 ? <div className="empty-state">No titles match these filters. Clear filters to see all books.</div> : (
            <table className="book-management-table">
              <colgroup><col className="book-title-column" /><col className="book-author-column" /><col className="book-subject-column" /><col className="book-count-column" /><col className="book-count-column" /><col className="book-actions-column" /></colgroup>
              <thead><tr><th scope="col">Title</th><th scope="col">Author</th><th scope="col">Course / Subject</th><th scope="col" className="book-number-cell">Copies</th><th scope="col" className="book-number-cell">Available</th><th scope="col" className="book-actions-heading">Actions</th></tr></thead>
              <tbody>{bookPageItems.map((item) => {
                const copies = item.book_copies ?? []
                const available = copies.filter((itemCopy) => itemCopy.status === 'available').length
                return <tr key={item.id}>
                  <td className="book-title-cell"><div className="book-title-content"><BookCoverArt book={item} className="book-management-cover" decorative externalLookup coverSize="S" /><strong>{item.title}</strong></div></td>
                  <td className="book-author-cell">{item.author}</td>
                  <td className="book-subject-cell">{item.course_subject || item.category || 'Not tagged'}</td>
                  <td className="book-number-cell">{copies.length}</td>
                  <td className="book-number-cell">{available}</td>
                  <td><div className="book-row-actions">
                    <button type="button" className="book-row-action" onClick={() => startEditing(item)} disabled={saving} aria-label={`Edit ${item.title}`} title={`Edit ${item.title}`}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" /></svg><span>Edit</span>
                    </button>
                    <button type="button" className="book-row-action book-row-delete" onClick={() => setPendingDelete(item)} disabled={saving} aria-label={`Delete ${item.title}`} title={`Delete ${item.title}`}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="m19 6-1 14H6L5 6" /><path d="M10 11v6M14 11v6" /></svg><span>Delete</span>
                    </button>
                  </div></td>
                </tr>
              })}</tbody>
            </table>
          )}
        </div>
        <footer className="book-pagination-footer">
          <span className="book-pagination-summary">Showing {firstBookNumber}–{lastBookNumber} of {filteredBookTitles.length} {filteredBookTitles.length === 1 ? 'book' : 'books'}</span>
          <nav className="book-pagination-nav" aria-label="Book pages">
            <span className="book-page-status">Page {activeBookPage} of {bookPageCount}</span>
            <button type="button" className="book-page-arrow" onClick={() => setBookPage((page) => Math.max(1, page - 1))} disabled={activeBookPage === 1} aria-label="Previous page">Previous</button>
            {visibleBookPages.map((pageNumber) => <button type="button" key={pageNumber} className={activeBookPage === pageNumber ? 'book-page-number active' : 'book-page-number'} onClick={() => setBookPage(pageNumber)} aria-current={activeBookPage === pageNumber ? 'page' : undefined} aria-label={`Page ${pageNumber}`}>{pageNumber}</button>)}
            <button type="button" className="book-page-arrow" onClick={() => setBookPage((page) => Math.min(bookPageCount, page + 1))} disabled={activeBookPage === bookPageCount} aria-label="Next page">Next</button>
          </nav>
        </footer>
      </div>}
      {view === 'copies' && <div className="form-grid one-column">
        <form className="tool-form" onSubmit={saveCopy}>
          <h3>{copyEditingId ? 'Edit physical copy' : 'Add physical copy'}</h3>
          <PhysicalCopyFields books={books} copy={copy} setCopy={setCopy} editing={Boolean(copyEditingId)} />
          <div className="form-actions">
            <button className="primary-button" disabled={saving || books.length === 0}>{saving ? 'Saving...' : copyEditingId ? 'Save changes' : 'Add copy'}</button>
            {copyEditingId && <button className="secondary-button" type="button" onClick={cancelAddCopy} disabled={saving}>Cancel</button>}
          </div>
        </form>
      </div>}
      {view === 'copies' && <div className="table-wrap tool-table">
        {loading ? <div className="empty-state loading-state">Loading catalog...</div> : copyCount === 0 ? <div className="empty-state">No physical copies have been added yet.</div> : (
          <table>
            <thead><tr><th>Book</th><th>Copy ID</th><th>Shelf Location</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>{books.flatMap((item) => (item.book_copies ?? []).map((itemCopy) => <tr key={itemCopy.id}><td><strong>{item.title}</strong><small className="table-subtext">{item.author}</small></td><td>{itemCopy.barcode || 'Not recorded'}</td><td>{itemCopy.location || 'Not recorded'}</td><td><span className="table-status" data-status={itemCopy.status}>{itemCopy.status?.replaceAll('_', ' ') || 'Unknown'}</span></td><td><div className="book-row-actions"><button type="button" className="book-row-action" onClick={() => startEditingCopy(item, itemCopy)} disabled={saving} aria-label={`Edit copy ${itemCopy.barcode || itemCopy.id}`}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" /></svg><span>Edit</span></button></div></td></tr>))}</tbody>
          </table>
        )}
      </div>}
      <ConfirmDialog open={Boolean(pendingDelete)} title="Delete this catalog record?" description={`Delete “${pendingDelete?.title || 'this book'}”? The database will block deletion when borrowing history or active reservations exist.`} confirmLabel="Delete book" danger busy={Boolean(saving && pendingDelete)} onCancel={() => setPendingDelete(null)} onConfirm={() => { if (pendingDelete) void deleteBook(pendingDelete.id) }} />
    </section>
  )
}

export function SystemSettings({ onBack, userId, initialTab = 'accounts' }) {
  const [activeTab, setActiveTab] = useState(initialTab)
  const [profiles, setProfiles] = useState(null)
  const [emailVerification, setEmailVerification] = useState(null)
  const [userSearch, setUserSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState('all')
  const [emailStatusFilter, setEmailStatusFilter] = useState('all')
  const [selectedProfile, setSelectedProfile] = useState(null)
  const [userMenu, setUserMenu] = useState({ anchor: null, profile: null })
  const [userToDelete, setUserToDelete] = useState(null)
  const [deletingUserId, setDeletingUserId] = useState('')
  const [policy, setPolicy] = useState(defaultCirculationPolicy)
  const [registrationMinutes, setRegistrationMinutes] = useState(30)
  const [loading, setLoading] = useState(true)
  const [policyLoading, setPolicyLoading] = useState(true)
  const [policySaving, setPolicySaving] = useState(false)
  const [registrationSaving, setRegistrationSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const loadProfiles = async () => {
    if (!supabase) {
      setError('The database connection is not configured. Check the application settings and try again.')
      setProfiles(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setProfiles(null)
    setError('')
    try {
      const { data, error: profilesError } = await supabase.rpc('admin_user_management_rows')
      if (profilesError) throw profilesError
      const accountRows = data ?? []
      setEmailVerification(Object.fromEntries(accountRows.map((row) => [row.id, row.email_confirmed_at])))
      setProfiles(accountRows)
    } catch (loadError) {
      if (import.meta.env.DEV) console.error('[admin] users failed', loadError)
      setError('Unable to load users. Please try again.')
      setProfiles(null)
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
      const { data, error: policyError } = await supabase.from('system_settings').select('key, value').in('key', [...Object.keys(defaultCirculationPolicy), 'registration_completion_minutes'])
      if (policyError) {
        setError('Unable to load circulation policy. Please run the latest database migration.')
        return
      }
      const values = Object.fromEntries((data ?? []).map((item) => [item.key, item.value]))
      setPolicy(normalizeCirculationPolicy({ ...defaultCirculationPolicy, ...values }))
      setRegistrationMinutes(Number(values.registration_completion_minutes) || 30)
    } catch (policyError) {
      if (import.meta.env.DEV) console.error('[admin] policy load failed', policyError)
      setError('Unable to load circulation policy. Please try again.')
    } finally {
      setPolicyLoading(false)
    }
  }

  useEffect(() => { loadPolicy() }, [])

  useEffect(() => {
    if (['accounts', 'circulation', 'registration', 'scheduled'].includes(initialTab)) setActiveTab(initialTab)
  }, [initialTab])

  const reloadSettings = async () => {
    await Promise.all([loadProfiles(), loadPolicy()])
  }

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

  const deleteUserAccount = async (profile) => {
    if (!supabase || !profile) return
    setDeletingUserId(profile.id)
    setError('')
    setMessage('')
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('admin-delete-user', {
        body: { targetUserId: profile.id },
      })
      if (invokeError) {
        let edgeMessage = invokeError.message
        try {
          const response = invokeError.context instanceof Response ? invokeError.context.clone() : null
          const edgeBody = response ? await response.json() : null
          edgeMessage = edgeBody?.error?.message || edgeMessage
        } catch { /* Keep the SDK message when the response has no JSON body. */ }
        throw new Error(edgeMessage)
      }
      if (data?.error) throw new Error(data.error.message || 'The account could not be deleted.')
      setUserToDelete(null)
      setMessage(data?.message || 'The sign-in account was deleted. Library and audit history were retained.')
      await loadProfiles()
    } catch (deleteError) {
      if (import.meta.env.DEV) console.error('[admin] account deletion failed', deleteError.code ?? 'unknown')
      setUserToDelete(null)
      setError(deleteError.message || 'The account could not be deleted. Please try again.')
    } finally {
      setDeletingUserId('')
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

  const saveRegistrationDeadline = async (event) => {
    event.preventDefault()
    if (!supabase || !Number.isInteger(registrationMinutes) || registrationMinutes < 5 || registrationMinutes > 1440) {
      setError('Registration completion must be a whole number between 5 and 1,440 minutes.')
      return
    }
    setRegistrationSaving(true)
    setError('')
    setMessage('')
    try {
      const { error: saveError } = await supabase.from('system_settings').upsert({
        key: 'registration_completion_minutes',
        value: registrationMinutes,
        description: 'Minutes allowed to complete a new member registration by email confirmation.',
        updated_by: userId || null,
      }, { onConflict: 'key' })
      if (saveError) setError('Unable to save the registration completion deadline. Please try again.')
      else setMessage('Registration completion deadline saved. It applies to new registrations.')
    } catch (saveError) {
      if (import.meta.env.DEV) console.error('[admin] registration deadline save failed', saveError.code ?? 'unknown')
      setError('Unable to save the registration completion deadline. Please try again.')
    } finally {
      setRegistrationSaving(false)
    }
  }

  const profileRows = profiles ?? []
  const emailStatusFor = (profileId) => {
    if (emailVerification === null || !Object.prototype.hasOwnProperty.call(emailVerification, profileId)) return 'unavailable'
    return emailVerification[profileId] ? 'verified' : 'pending'
  }
  const filteredProfiles = profileRows.filter((profile) => {
    const emailStatus = emailStatusFor(profile.id)
    const normalizedQuery = userSearch.trim().toLowerCase()
    const searchable = `${profile.full_name || ''} ${profile.email || ''} ${profile.school_id || ''} ${profile.registration_school_id || ''}`.toLowerCase()
    return (!normalizedQuery || searchable.includes(normalizedQuery))
      && (roleFilter === 'all' || profile.role === roleFilter)
      && (emailStatusFilter === 'all' || emailStatus === emailStatusFilter)
  })
  const filterKey = `${userSearch}|${roleFilter}|${emailStatusFilter}`
  const { pageItems, pagination } = usePagination(filteredProfiles, filterKey, 6, { numbered: true, always: true, label: 'users' })
  const activeAdministratorCount = profileRows.filter((profile) => profile.role === 'administrator' && profile.account_active).length
  const cannotDeleteUser = (profile) => profile.id === userId
    || Boolean(deletingUserId)
    || (profile.role === 'administrator' && profile.account_active && activeAdministratorCount <= 1)
  const deletionDisabledReason = (profile) => profile.id === userId
    ? 'You cannot delete the administrator account currently in use.'
    : profile.role === 'administrator' && profile.account_active && activeAdministratorCount <= 1
      ? 'The last active administrator cannot be deleted.'
      : 'Delete this sign-in account'
  const renderUserActions = (profile) => <div className="user-row-actions">
    <button type="button" className="user-view-button" onClick={() => setSelectedProfile(profile)} aria-label={`View ${profile.full_name || 'user'} details`}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg><span>View</span>
    </button>
    <button type="button" className="user-more-button" aria-label={`More actions for ${profile.full_name || 'user'}`} aria-haspopup="menu" aria-expanded={userMenu.profile?.id === profile.id} onClick={(event) => setUserMenu({ anchor: event.currentTarget, profile })}>
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>
    </button>
  </div>
  const roleCounts = {
    administrators: profileRows.filter((profile) => profile.role === 'administrator').length,
    librarians: profileRows.filter((profile) => profile.role === 'librarian').length,
    members: profileRows.filter((profile) => profile.role === 'member').length,
  }


  const tabs = [
    { id: 'accounts', label: 'Accounts & Access', icon: 'M16 20v-1a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v1 M10 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M16 11h5 M18.5 8.5v5' },
    { id: 'circulation', label: 'Circulation Policy', icon: 'M5 4h14v16H5z M8 8h8 M8 12h8 M8 16h5' },
    { id: 'registration', label: 'Registration & Verification', icon: 'M12 3 5 6v5c0 4.4 2.9 8.4 7 10 4.1-1.6 7-5.6 7-10V6z M9 12l2 2 4-4' },
    { id: 'scheduled', label: 'Scheduled Circulation', icon: 'M12 8v4l2.5 2 M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0z' },
  ]
  const handleTabKeyDown = (event, index) => {
    let nextIndex = index
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = tabs.length - 1
    else return
    event.preventDefault()
    setActiveTab(tabs[nextIndex].id)
    event.currentTarget.parentElement?.querySelectorAll('[role="tab"]')[nextIndex]?.focus()
  }

  return (
    <section className="content-section system-settings-page">
      <header className="system-settings-header">
        <div className="system-settings-title-row">
          <div><span className="eyebrow">Administrator tools</span><h1>System Settings</h1><p className="muted">Manage accounts, circulation rules, registration, and scheduled processing.</p></div>
          {onBack && <button type="button" className="secondary-button system-settings-back" onClick={onBack}>Back to dashboard</button>}
        </div>
        <div className="system-settings-tabs" role="tablist" aria-label="System settings sections">
          {tabs.map((tab, index) => <button key={tab.id} id={`system-settings-tab-${tab.id}`} type="button" role="tab" aria-selected={activeTab === tab.id} aria-controls={`system-settings-panel-${tab.id}`} tabIndex={activeTab === tab.id ? 0 : -1} className={activeTab === tab.id ? 'system-settings-tab active' : 'system-settings-tab'} onClick={() => setActiveTab(tab.id)} onKeyDown={(event) => handleTabKeyDown(event, index)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={tab.icon} /></svg><span>{tab.label}</span>
          </button>)}
        </div>
      </header>
      {(message || error) && <div role={error ? 'alert' : 'status'} className={error ? 'inline-error with-action' : 'inline-success'}><span>{error || message}</span>{error && <button type="button" className="retry-button" onClick={() => void reloadSettings()}>Try again</button>}</div>}
      <div id={`system-settings-panel-${activeTab}`} className="system-settings-panel" role="tabpanel" aria-labelledby={`system-settings-tab-${activeTab}`}>
      {activeTab === 'accounts' && <>
      <div className="staff-summary-grid user-role-summary" aria-label="User totals by role">
        <article className="staff-summary-card"><span>All accounts</span><strong>{loading || profiles === null ? '—' : profiles.length}</strong></article>
        <article className="staff-summary-card"><span>Administrators</span><strong>{loading || profiles === null ? '—' : roleCounts.administrators}</strong></article>
        <article className="staff-summary-card"><span>Librarians</span><strong>{loading || profiles === null ? '—' : roleCounts.librarians}</strong></article>
        <article className="staff-summary-card"><span>Members</span><strong>{loading || profiles === null ? '—' : roleCounts.members}</strong></article>
      </div>
      <div className="staff-list-heading"><div><h3>Accounts and access</h3><p className="muted">Role changes apply after the user signs in again.</p></div><span>{loading ? 'Loading…' : profiles === null ? 'Accounts unavailable' : `${filteredProfiles.length} ${filteredProfiles.length === 1 ? 'account' : 'accounts'}`}</span></div>
      <section className="user-management-card" aria-label="Accounts and access">
        <div className="user-management-toolbar" aria-label="User filters">
          <label className="toolbar-field user-search-field"><span>Search users</span><input type="search" value={userSearch} onChange={(event) => setUserSearch(event.target.value)} placeholder="Name, email, or School ID" /></label>
          <label className="toolbar-field"><span>Role</span><select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}><option value="all">All roles</option><option value="administrator">Administrator</option><option value="librarian">Librarian</option><option value="member">Member</option></select></label>
          <label className="toolbar-field"><span>Email verification</span><select value={emailStatusFilter} onChange={(event) => setEmailStatusFilter(event.target.value)}><option value="all">All statuses</option><option value="verified">Verified</option><option value="pending">Pending</option></select></label>
          <button type="button" className="user-clear-filters" onClick={() => { setUserSearch(''); setRoleFilter('all'); setEmailStatusFilter('all') }}>Clear filters</button>
        </div>
        <div className="table-wrap user-management-table-wrap">
          {loading ? <div className="empty-state loading-state">Loading users...</div> : profiles === null ? <div className="empty-state">User records are unavailable. Use Try again to reload.</div> : filteredProfiles.length === 0 ? <div className="empty-state">No users match these filters.</div> : (
            <table className="user-management-table">
              <thead><tr><th>Name</th><th>School ID</th><th>Email status</th><th>Role</th><th>Created date</th><th>Actions</th></tr></thead>
              <tbody>{pageItems.map((profile) => {
                const emailStatus = emailStatusFor(profile.id)
                return <tr key={profile.id}>
                  <td className="user-name-cell"><strong>{profile.full_name || 'Unnamed user'}</strong><small>{profile.email || 'Email not recorded'}</small></td>
                  <td>{profile.school_id || profile.registration_school_id || <span className="user-not-set">Not set</span>}</td>
                  <td><span className="table-status" data-status={emailStatus === 'verified' ? 'available' : emailStatus === 'pending' ? 'pending' : 'unknown'}>{emailStatus === 'verified' ? 'Verified' : emailStatus === 'pending' ? 'Pending' : 'Unavailable'}</span></td>
                  <td><label className="sr-only" htmlFor={`role-${profile.id}`}>Role for {profile.full_name || 'this user'}</label><select className="user-role-select" id={`role-${profile.id}`} value={profile.role} onChange={(event) => updateRole(profile.id, event.target.value)}><option value="member">Member</option><option value="librarian">Librarian</option><option value="administrator">Administrator</option></select></td>
                  <td>{new Date(profile.created_at).toLocaleDateString()}</td>
                  <td>{renderUserActions(profile)}</td>
                </tr>
              })}</tbody>
            </table>
          )}
        </div>
        <div className="user-management-mobile-list">
          {loading ? <div className="empty-state loading-state">Loading users...</div> : profiles === null ? <div className="empty-state">User records are unavailable. Use Try again to reload.</div> : filteredProfiles.length === 0 ? <div className="empty-state">No users match these filters.</div> : pageItems.map((profile) => {
            const emailStatus = emailStatusFor(profile.id)
            return <article className="user-management-mobile-card" key={profile.id}>
              <div className="user-management-mobile-heading"><div><strong>{profile.full_name || 'Unnamed user'}</strong><small>{profile.email || 'Email not recorded'}</small></div>{renderUserActions(profile)}</div>
              <div className="user-management-mobile-meta"><span><small>School ID</small><strong>{profile.school_id || profile.registration_school_id || 'Not set'}</strong></span><span><small>Created</small><strong>{new Date(profile.created_at).toLocaleDateString()}</strong></span></div>
              <div className="user-management-mobile-status"><span className="table-status" data-status={emailStatus === 'verified' ? 'available' : emailStatus === 'pending' ? 'pending' : 'unknown'}>Email: {emailStatus === 'verified' ? 'Verified' : emailStatus === 'pending' ? 'Pending' : 'Unavailable'}</span></div>
              <label className="user-mobile-role"><span>Role</span><select className="user-role-select" value={profile.role} onChange={(event) => updateRole(profile.id, event.target.value)} aria-label={`Role for ${profile.full_name || 'this user'}`}><option value="member">Member</option><option value="librarian">Librarian</option><option value="administrator">Administrator</option></select></label>
            </article>
          })}
        </div>
        {profiles !== null && pagination}
      </section>
      <Dialog open={Boolean(selectedProfile)} onClose={() => setSelectedProfile(null)} fullWidth maxWidth="sm" aria-labelledby="admin-user-details-title">
        {selectedProfile && <>
          <DialogTitle id="admin-user-details-title">User details</DialogTitle>
          <DialogContent dividers>
            <dl className="admin-user-details-list">
              <div><dt>Full name</dt><dd>{selectedProfile.full_name || 'Unnamed user'}</dd></div>
              <div><dt>School ID</dt><dd>{selectedProfile.school_id || selectedProfile.registration_school_id || 'Not set'}</dd></div>
              <div><dt>Email</dt><dd>{selectedProfile.email || 'Not recorded'}</dd></div>
              <div><dt>Role</dt><dd>{selectedProfile.role}</dd></div>
              <div><dt>Email verification</dt><dd>{emailStatusFor(selectedProfile.id) === 'verified' ? 'Verified' : emailStatusFor(selectedProfile.id) === 'pending' ? 'Pending' : 'Unavailable'}</dd></div>
              <div><dt>Account created</dt><dd>{selectedProfile.created_at ? new Date(selectedProfile.created_at).toLocaleString() : 'Not recorded'}</dd></div>
              <div><dt>Last login</dt><dd>{selectedProfile.last_sign_in_at ? new Date(selectedProfile.last_sign_in_at).toLocaleString() : 'Not recorded'}</dd></div>
              <div><dt>Profile ID</dt><dd><code>{selectedProfile.id}</code></dd></div>
            </dl>
          </DialogContent>
        </>}
      </Dialog>
      <Menu anchorEl={userMenu.anchor} open={Boolean(userMenu.anchor)} onClose={() => setUserMenu({ anchor: null, profile: null })} MenuListProps={{ 'aria-label': 'User actions' }}>
        {userMenu.profile && <MenuItem
          disabled={cannotDeleteUser(userMenu.profile)}
          className="user-delete-menu-item"
          title={deletionDisabledReason(userMenu.profile)}
          onClick={() => { const profile = userMenu.profile; setUserMenu({ anchor: null, profile: null }); setUserToDelete(profile) }}
        >Delete Account</MenuItem>}
      </Menu>
      <ConfirmDialog
        open={Boolean(userToDelete)}
        title="Delete this sign-in account?"
        description={`Permanently remove ${userToDelete?.full_name || 'this user'}'s sign-in account and application profile. Activity logs, library member records, borrowing history, and reservations are retained. Accounts with loans or reservations cannot be deleted. An administrator can be deleted only when another active administrator will remain.`}
        confirmLabel="Delete account"
        danger
        busy={Boolean(userToDelete && deletingUserId === userToDelete.id)}
        onCancel={() => setUserToDelete(null)}
        onConfirm={() => { if (userToDelete) void deleteUserAccount(userToDelete) }}
      />
      </>}
      {activeTab === 'circulation' && <>
      <form className="tool-form policy-form" onSubmit={savePolicy}>
        <h3>Circulation policy</h3>
        <p className="muted">These values are enforced by the database after all database migrations are applied.</p>
        {policyLoading ? <div className="empty-state loading-state">Loading policy...</div> : <>
          <div className="form-row three-column">
            <label>Borrowing period (1–3 days)<input type="number" min="1" max="3" value={policy.loan_period_days} onChange={(event) => setPolicy({ ...policy, loan_period_days: Number(event.target.value) })} required /></label>
            <label>Maximum books checked out per member<input type="number" min="1" value={policy.max_active_loans} onChange={(event) => setPolicy({ ...policy, max_active_loans: Number(event.target.value) })} required /></label>
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
      </>}
      {activeTab === 'registration' && <>
      <form className="tool-form policy-form" onSubmit={saveRegistrationDeadline}>
        <h3>Account registration deadline</h3>
        <p className="muted">Unconfirmed member registrations expire after this period. Password recovery code expiry is configured separately in Supabase Auth.</p>
        {policyLoading ? <div className="empty-state loading-state">Loading registration setting...</div> : <>
          <label>Minutes to complete email verification<input type="number" min="5" max="1440" step="1" value={registrationMinutes} onChange={(event) => setRegistrationMinutes(event.target.value === '' ? '' : Number(event.target.value))} required /></label>
          <button className="primary-button" disabled={registrationSaving}>{registrationSaving ? 'Saving deadline...' : 'Save registration deadline'}</button>
        </>}
      </form>
      <section className="system-settings-info-card" aria-label="Email verification configuration">
        <div><span className="eyebrow">Email verification</span><h2>Required for new member accounts</h2><p>Account confirmation is enforced by Supabase Auth and the registration workflow. Verification status for existing accounts is shown in Accounts &amp; Access.</p></div>
        <span className="table-status" data-status="available">Required</span>
      </section>
      <section className="system-settings-info-card" aria-label="Registration expiration information">
        <div><span className="eyebrow">Registration expiration</span><h2>{policyLoading ? 'Loading expiration period…' : `${registrationMinutes} minutes`}</h2><p>Pending registrations expire after the configured completion period. Expiration and cleanup are handled by the existing registration lifecycle.</p></div>
      </section>
      </>}
      {activeTab === 'scheduled' && <section className="system-settings-scheduled-card">
        <div><span className="eyebrow">Background processing</span><h2>Scheduled circulation</h2><p className="muted">Processes overdue loans and pickup-hold expirations in the background. Status refreshes automatically.</p></div>
        <CirculationHealth />
      </section>}
      </div>
    </section>
  )
}

// Keep the historic component export for existing callers while the route and
// navigation use the System Settings name.
export function AdminPanel(props) {
  return <SystemSettings {...props} initialTab={props.initialTab || 'accounts'} />
}

function CirculationStatIcon({ type }) {
  const paths = {
    copies: <><path d="M4 6.5h12a2 2 0 0 1 2 2v10H6a2 2 0 0 1-2-2z" /><path d="M8 4h12a2 2 0 0 1 2 2v11" /><path d="M8 11h6M8 14.5h6" /></>,
    members: <><circle cx="9" cy="8" r="3" /><path d="M3.5 20v-1.4a5.5 5.5 0 0 1 11 0V20z" /><path d="M16 5.5a3 3 0 0 1 0 5.8M18 15a4.5 4.5 0 0 1 2.5 4v1" /></>,
    loans: <><path d="M5 4h14v16H5z" /><path d="M8 8h8M8 12h8M8 16h5" /><path d="m15 17 2 2 4-4" /></>,
  }
  return <svg className="circulation-stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[type]}</svg>
}

const formatCirculationDate = (value, includeTime = false) => value
  ? new Date(value).toLocaleString(undefined, includeTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' })
  : 'Not recorded'

export function StaffCirculation({ onBack }) {
  const [members, setMembers] = useState([])
  const [memberRecordCount, setMemberRecordCount] = useState(0)
  const [activeMemberRecordCount, setActiveMemberRecordCount] = useState(0)
  const [readyReservations, setReadyReservations] = useState([])
  const [copies, setCopies] = useState([])
  const [loans, setLoans] = useState([])
  const [policy, setPolicy] = useState(defaultCirculationPolicy)
  const [memberQuery, setMemberQuery] = useState('')
  const [copyQuery, setCopyQuery] = useState('')
  const [loanQuery, setLoanQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [barcode, setBarcode] = useState('')
  const [returnBarcode, setReturnBarcode] = useState('')
  const [receipt, setReceipt] = useState(null)
  const [memberId, setMemberId] = useState('')
  const [copyId, setCopyId] = useState('')
  const [selectedLoan, setSelectedLoan] = useState(null)
  const [loading, setLoading] = useState(true)
  const [dataLoadFailed, setDataLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [pendingClose, setPendingClose] = useState(null)

  const loadData = async () => {
    if (!supabase) { setLoading(false); setDataLoadFailed(true); setError('Supabase is not configured. Check the application connection before using circulation.'); return }
    setLoading(true); setDataLoadFailed(false); setError('')
    try {
      const { error: refreshError } = await supabase.rpc('refresh_circulation_statuses')
      if (refreshError) throw refreshError
      const [membersResult, copiesResult, loansResult, reservationsResult, policyResult] = await Promise.all([
        fetchAllRows(() => supabase.from('library_members').select('id, full_name, library_card_number, school_id, is_active, email_only').order('full_name')),
        fetchAllRows(() => supabase.from('book_copies').select('id, barcode, location, status, books(title)').in('status', ['available', 'reserved']).order('barcode')),
        fetchAllRows(() => supabase.from('loans').select('id, member_id, status, checked_out_at, due_at, fine_amount, book_copies(books(title), barcode), member:library_members!loans_member_id_fkey(full_name, library_card_number, school_id)').in('status', ['borrowed', 'overdue']).order('created_at', { ascending: false })),
        fetchAllRows(() => supabase.from('reservations').select('id, member_id, copy_id').eq('status', 'ready_for_pickup')),
        supabase.rpc('get_circulation_policy'),
      ])
      const failed = [membersResult, copiesResult, loansResult, reservationsResult, policyResult].find((result) => result.error)
      if (failed?.error) throw failed.error
      const allMembers = membersResult.data ?? []
      const activeMembers = allMembers.filter((member) => member.is_active)
      setMemberRecordCount(allMembers.length); setActiveMemberRecordCount(activeMembers.length)
      setMembers(allMembers)
      setCopies(copiesResult.data ?? []); setLoans(loansResult.data ?? []); setReadyReservations(reservationsResult.data ?? [])
      setDataLoadFailed(false)
      if (!policyResult.error) setPolicy(normalizeCirculationPolicy(policyResult.data))
    } catch (loadError) {
      if (import.meta.env.DEV) console.error('[circulation] records failed', loadError)
      setMembers([]); setMemberRecordCount(0); setActiveMemberRecordCount(0); setCopies([]); setLoans([]); setReadyReservations([])
      setDataLoadFailed(true)
      setError('Circulation refresh failed. Records are unavailable until refresh succeeds.')
    } finally { setLoading(false) }
  }

  useEffect(() => { loadData() }, [])

  const checkout = async (event) => {
    event.preventDefault(); setMessage(''); setError('')
    const borrower = members.find((member) => member.id === memberId)
    if (!borrower?.is_active) { setError('Select an active library member before checking out a book.'); return }
    setSaving(true)
    try {
      const { data: loanId, error: checkoutError } = await supabase.rpc('checkout_copy', { p_copy_id: copyId, p_member_id: memberId })
      if (checkoutError) setError(checkoutError.message)
      else {
        setMessage('Book checked out successfully.')
        const { data: issued, error: receiptError } = await supabase.from('loans').select('id, due_at, fine_daily_rate').eq('id', loanId).single()
        setReceipt({ id: loanId, title: copies.find((item) => item.id === copyId)?.books?.title, barcode: copies.find((item) => item.id === copyId)?.barcode, member: borrower.full_name, card: borrower.library_card_number, emailOnly: borrower.email_only, due_at: issued?.due_at })
        if (receiptError) setMessage('Checkout completed. Receipt ID: ' + loanId + '; due date unavailable.')
        setBarcode(''); setMemberId(''); setCopyId(''); setMemberQuery(''); setCopyQuery('')
        await loadData()
      }
    } catch (checkoutError) {
      if (import.meta.env.DEV) console.error('[circulation] checkout failed', checkoutError)
      setError('Unable to check out this copy. Verify the selections and try again.')
    } finally { setSaving(false) }
  }

  const returnLoan = async (loanId) => {
    setSaving(true); setMessage(''); setError('')
    try {
      const { error: returnError } = await supabase.rpc('return_loan', { p_loan_id: loanId })
      if (returnError) setError(returnError.message)
      else {
        const { data: closed } = await supabase.from('loans').select('fine_amount').eq('id', loanId).single()
        setMessage('Book returned. Final fine: ' + (closed ? formatFine(closed.fine_amount) : 'see transaction history') + '.')
        setReturnBarcode(''); setSelectedLoan(null)
        await loadData()
      }
    } catch (returnError) {
      if (import.meta.env.DEV) console.error('[circulation] return failed', returnError)
      setError('Unable to process this return. Please try again.')
    } finally { setSaving(false) }
  }

  const closeLoan = async (loanId, status) => {
    setSaving(true); setMessage(''); setError('')
    try {
      const { error: closeError } = await supabase.rpc('close_loan_with_status', { p_loan_id: loanId, p_status: status })
      if (closeError) setError('Unable to mark this book ' + status + '. Please try again.')
      else { setMessage('Book marked ' + status + '.'); await loadData() }
    } catch (closeError) {
      if (import.meta.env.DEV) console.error('[circulation] ' + status + ' loan failed', closeError)
      setError('Unable to mark this book ' + status + '. Please try again.')
    } finally { setSaving(false); setPendingClose(null) }
  }

  const normalizedMemberQuery = memberQuery.trim().toLowerCase()
  const visibleMembers = members.filter((member) => (member.full_name + ' ' + (member.library_card_number || '') + ' ' + (member.school_id || '') + ' ' + member.id + ' ' + (member.email_only ? 'email account' : '')).toLowerCase().includes(normalizedMemberQuery))
  const normalizedLoanQuery = loanQuery.trim().toLowerCase()
  const visibleLoans = loans.filter((loan) => {
    const searchable = (loan.book_copies?.books?.title || '') + ' ' + (loan.member?.full_name || '') + ' ' + (loan.member?.library_card_number || '') + ' ' + (loan.book_copies?.barcode || '')
    return (statusFilter === 'all' || loan.status === statusFilter) && searchable.toLowerCase().includes(normalizedLoanQuery)
  })
  const { pageItems, pagination } = usePagination(visibleLoans, normalizedLoanQuery + ':' + statusFilter, 6, { numbered: true, always: true, label: 'records' })
  const selectedMember = members.find((member) => member.id === memberId)
  const selectedCopy = copies.find((copy) => copy.id === copyId)
  const memberOpenLoans = selectedMember ? loans.filter((loan) => loan.member_id === selectedMember.id).length : 0
  const estimatedDueDate = new Date(Date.now() + Number(policy.loan_period_days || 0) * 86400000)
  const availableCopyCount = copies.filter((copy) => copy.status === 'available').length
  const checkoutEligibleCopies = copies.filter((copy) => copy.status === 'available' || (
    copy.status === 'reserved' && selectedMember && readyReservations.some((reservation) => reservation.member_id === selectedMember.id && reservation.copy_id === copy.id)
  ))
  const visibleCopies = checkoutEligibleCopies.filter((copy) => ((copy.books?.title || '') + ' ' + (copy.barcode || '') + ' ' + (copy.location || '') + ' ' + (copy.status || '')).toLowerCase().includes(copyQuery.trim().toLowerCase()))
  const scanCopy = (value) => {
    setBarcode(value)
    const match = checkoutEligibleCopies.find((copy) => copy.barcode?.trim().toLowerCase() === value.trim().toLowerCase())
    setCopyId(match?.id || '')
    if (match) setCopyQuery('')
  }
  const memberReadiness = memberRecordCount === 0
    ? 'No library member records exist yet. Add or register a borrower in Management → Members before checkout.'
    : activeMemberRecordCount === 0
      ? 'There are no active library members. Reactivate the correct member record in Management → Members before checkout.'
      : ''
  const matchingReturnLoan = loans.find((loan) => loan.book_copies?.barcode?.trim().toLowerCase() === returnBarcode.trim().toLowerCase())

  return (
    <section className="content-section circulation-page">
      <header className="book-page-header-card circulation-page-header">
        <div className="book-page-header-copy"><span className="eyebrow">Circulation desk</span><h2>Borrow / Return</h2><p>Check out copies, process returns, and review open loans.</p></div>
        {onBack && <button type="button" className="book-page-header-back" onClick={onBack}><span aria-hidden="true">&larr;</span> Back to Dashboard</button>}
      </header>
      {(message || error) && <div role={error ? 'alert' : 'status'} className={error ? 'inline-error with-action' : 'inline-success'}><span>{error || message}</span>{error && <button type="button" className="retry-button" onClick={loadData}>Try again</button>}</div>}
      <div className="staff-summary-grid circulation-summary" aria-label="Circulation totals">
        <article className="staff-summary-card circulation-summary-card"><CirculationStatIcon type="copies" /><div><span>Available copies</span><strong>{loading || dataLoadFailed ? '—' : availableCopyCount}</strong></div></article>
        <article className="staff-summary-card circulation-summary-card"><CirculationStatIcon type="members" /><div><span>Active members</span><strong>{loading || dataLoadFailed ? '—' : activeMemberRecordCount}</strong></div></article>
        <article className="staff-summary-card circulation-summary-card"><CirculationStatIcon type="loans" /><div><span>Books checked out</span><strong>{loading || dataLoadFailed ? '—' : loans.length}</strong></div></article>
      </div>
      <div className="circulation-workflow-grid">
        <form className="tool-form checkout-form" onSubmit={checkout}>
          <h3>Check Out Book</h3>
          <label>Find member by name, card, or School ID<input type="search" value={memberQuery} onChange={(event) => { const value = event.target.value; setMemberQuery(value); const normalized = value.trim().toLowerCase(); const exact = members.filter((member) => member.is_active && [member.full_name, member.library_card_number, member.school_id].some((identity) => identity?.trim().toLowerCase() === normalized) && normalized); setMemberId(exact.length === 1 ? exact[0].id : ''); setCopyId(''); setBarcode('') }} onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault() }} placeholder="Name, card number, or School ID" />{normalizedMemberQuery && <small className="form-helper" role="status">{visibleMembers.length ? `${visibleMembers.length} matching member${visibleMembers.length === 1 ? '' : 's'}. Select one below.` : 'No members match. Check the name, card number, or School ID.'}</small>}</label>
          <label>Member<select value={memberId} onChange={(event) => { setMemberId(event.target.value); setMemberQuery(''); setCopyId(''); setBarcode(''); setCopyQuery('') }} required><option value="">Select a registered member</option>{visibleMembers.map((member) => {
            const identity = member.library_card_number || (member.school_id ? `ID ${member.school_id}` : member.email_only ? 'Email account' : 'Registered account')
            return <option key={member.id} value={member.id} disabled={!member.is_active}>{member.full_name} · {identity}{!member.is_active ? ' · Inactive' : ''}</option>
          })}</select></label>
          <label>Search books and copies<input type="search" value={copyQuery} onChange={(event) => { setCopyQuery(event.target.value); const match = checkoutEligibleCopies.find((copy) => copy.barcode?.trim().toLowerCase() === event.target.value.trim().toLowerCase()); setCopyId(match?.id || '') }} placeholder="Title, barcode, or shelf" />{copyQuery.trim() && <small className="form-helper" role="status">{visibleCopies.length ? `${visibleCopies.length} matching cop${visibleCopies.length === 1 ? 'y' : 'ies'}. Choose one from Book / copy below.` : `No available or assigned copies match “${copyQuery.trim()}”. Try a title, barcode, or shelf.`}</small>}</label>
          <label>Book / copy<select value={copyId} onChange={(event) => { const selected = copies.find((item) => item.id === event.target.value); setCopyId(event.target.value); setBarcode(selected?.barcode || ''); setCopyQuery('') }} required><option value="">Select available copy or assigned hold</option>{visibleCopies.map((copy) => <option key={copy.id} value={copy.id}>{copy.books?.title || 'Unknown book'} · {copy.barcode} · {copy.status}</option>)}</select></label>
          <div className="barcode-entry"><label htmlFor="checkout-copy-barcode">Scan or enter copy barcode</label><div className="barcode-entry-controls"><input id="checkout-copy-barcode" value={barcode} onChange={(event) => scanCopy(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !memberId) event.preventDefault() }} placeholder="Barcode from the physical copy" /><CameraBarcodeScanner onScan={scanCopy} /></div></div>
          {barcode && !copyId && <p className="circulation-validation" role="status">No available or reserved copy matches this barcode.</p>}
          {selectedMember && <div className="circulation-selection-card"><strong>Borrower</strong><span>{selectedMember.full_name}</span><small>{selectedMember.email_only ? 'Email-confirmed registered account' : selectedMember.library_card_number ? `Registered member · card ${selectedMember.library_card_number}` : 'Registered library member'}{selectedMember.school_id ? ' · School ID ' + selectedMember.school_id : ''}</small><small>Open loans · {memberOpenLoans} of {policy.max_active_loans}</small></div>}
          {selectedCopy && <div className="circulation-selection-card"><strong>Selected copy</strong><span>{selectedCopy.books?.title || 'Unknown book'}</span><small>Barcode · {selectedCopy.barcode} · {selectedCopy.location || 'Shelf not recorded'}</small><small>Copy status · {selectedCopy.status}</small></div>}
          {selectedMember && memberOpenLoans >= policy.max_active_loans && <p className="circulation-validation" role="status">This borrower has reached the configured limit of {policy.max_active_loans} active loans. The database will enforce this limit at checkout.</p>}
          {selectedCopy?.status === 'reserved' && <p className="circulation-validation" role="status">This copy is held for a reservation. The database will allow checkout only to the assigned borrower.</p>}
          {memberReadiness && !loading && !dataLoadFailed && <p className="circulation-guidance" role="status">{memberReadiness}</p>}
          {copies.length === 0 && !loading && !dataLoadFailed && <p className="circulation-guidance" role="status">No available or reserved copies are listed. Add or update physical copies in Books Management.</p>}
          {availableCopyCount === 0 && copies.length > 0 && !selectedCopy && !dataLoadFailed && <p className="circulation-guidance" role="status">No copies are marked available. Reserved copies can only be checked out by the borrower assigned to that hold.</p>}
          <div className="circulation-form-footnote"><small className="form-helper">Estimated due date · {formatCirculationDate(estimatedDueDate.toISOString())} ({policy.loan_period_days}-day loan)</small><small className="form-helper">Reservations, member eligibility, and loan limits are validated by the database.</small></div>
          <button className="primary-button" disabled={saving || loading || !copyId || !memberId}>{saving ? 'Checking out…' : 'Check Out Book'}</button>
        </form>
        <form className="tool-form return-form" onSubmit={(event) => { event.preventDefault(); if (matchingReturnLoan) void returnLoan(matchingReturnLoan.id); else setError('No active checkout matches this barcode.') }}>
          <div><h3>Return Book</h3><p className="muted">Scan or enter the barcode after receiving the physical copy.</p></div>
          <div className="barcode-entry"><label htmlFor="return-copy-barcode">Copy barcode</label><div className="barcode-entry-controls"><input id="return-copy-barcode" value={returnBarcode} onChange={(event) => { setReturnBarcode(event.target.value); setError('') }} placeholder="Scan or type barcode" required /><CameraBarcodeScanner onScan={(value) => { setReturnBarcode(value); setError('') }} /></div></div>
          {matchingReturnLoan && <div className="circulation-selection-card"><strong>Active checkout found</strong><span>{matchingReturnLoan.book_copies?.books?.title || 'Unknown book'}</span><small>{matchingReturnLoan.member?.full_name || 'Unknown borrower'} · Due {formatCirculationDate(matchingReturnLoan.due_at)}</small></div>}
          {returnBarcode && !matchingReturnLoan && <p className="circulation-validation" role="status">No open loan matches this barcode. Check the barcode and confirm the copy has not already been returned.</p>}
          <button className="primary-button" disabled={saving || loading || !returnBarcode.trim()}>{saving ? 'Processing return…' : 'Return scanned copy'}</button>
        </form>
        {receipt && <div className="inline-success circulation-receipt" role="status"><div><strong>Checkout receipt</strong><p>{receipt.member}{receipt.emailOnly ? ' · Email account' : receipt.card ? ` · Card ${receipt.card}` : ''} · {receipt.title} · {receipt.barcode}</p><p>Due: {receipt.due_at ? formatCirculationDate(receipt.due_at, true) : 'See borrowing record'}</p><code>{receipt.id}</code></div></div>}
      </div>
      <section className="circulation-loans-card" aria-labelledby="circulation-loans-heading">
        <div className="circulation-loans-header"><div><h3 id="circulation-loans-heading">Currently Borrowed Books</h3><p>Search active checkouts, review details, or process a return.</p></div><span>{loading ? 'Loading…' : visibleLoans.length + (visibleLoans.length === 1 ? ' record' : ' records')}</span></div>
        <div className="circulation-loans-filters">
          <label className="circulation-filter-field"><span>Search records</span><input type="search" value={loanQuery} onChange={(event) => setLoanQuery(event.target.value)} placeholder="Book, borrower, or barcode" aria-label="Search borrowed books" /></label>
          <label className="circulation-filter-field"><span>Status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Filter borrowed books by status"><option value="all">All statuses</option><option value="borrowed">Borrowed</option><option value="overdue">Overdue</option></select></label>
        </div>
        <div className="table-wrap tool-table circulation-table-wrap">
          {loading ? <div className="empty-state loading-state">Loading borrowing records…</div> : dataLoadFailed ? <div className="empty-state">Borrowing records are unavailable until the connection is restored.</div> : loans.length === 0 ? <div className="empty-state">No books are currently checked out.</div> : visibleLoans.length === 0 ? <div className="empty-state">No current loans match these filters.</div> : (
            <table className="circulation-table">
              <thead><tr><th>Book Title</th><th>Borrower</th><th>Barcode</th><th>Borrow Date</th><th>Due Date</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>{pageItems.map((loan) => <tr key={loan.id}>
                <td><strong>{loan.book_copies?.books?.title || 'Unknown book'}</strong></td><td>{loan.member?.full_name || 'Unknown member'}</td><td><code>{loan.book_copies?.barcode || 'Not recorded'}</code></td><td>{formatCirculationDate(loan.checked_out_at)}</td><td>{formatCirculationDate(loan.due_at)}</td><td><span className="table-status" data-status={loan.status}>{loan.status}</span></td>
                <td><div className="table-actions circulation-row-actions"><button type="button" className="table-action" onClick={() => setSelectedLoan(loan)}>View Details</button><button type="button" className="table-action" onClick={() => returnLoan(loan.id)} disabled={saving}>Return</button><button type="button" className="table-action danger-action" onClick={() => setPendingClose({ loanId: loan.id, status: 'lost' })} disabled={saving}>Lost</button><button type="button" className="table-action danger-action" onClick={() => setPendingClose({ loanId: loan.id, status: 'damaged' })} disabled={saving}>Damaged</button></div></td>
              </tr>)}</tbody>
            </table>
          )}
        </div>
        {pagination}
      </section>
      <Dialog open={Boolean(selectedLoan)} onClose={() => setSelectedLoan(null)} fullWidth maxWidth="sm" aria-labelledby="circulation-loan-details-title">
        {selectedLoan && <><DialogTitle id="circulation-loan-details-title">Borrowing details</DialogTitle><DialogContent dividers>
          <dl className="circulation-details-grid">
            <div><dt>Book title</dt><dd>{selectedLoan.book_copies?.books?.title || 'Unknown book'}</dd></div><div><dt>Borrower</dt><dd>{selectedLoan.member?.full_name || 'Unknown member'}</dd></div><div><dt>Library card</dt><dd>{selectedLoan.member?.library_card_number || 'Not recorded'}</dd></div><div><dt>School ID</dt><dd>{selectedLoan.member?.school_id || 'Not recorded'}</dd></div><div><dt>Copy barcode</dt><dd>{selectedLoan.book_copies?.barcode || 'Not recorded'}</dd></div><div><dt>Status</dt><dd><span className="table-status" data-status={selectedLoan.status}>{selectedLoan.status}</span></dd></div><div><dt>Borrow date</dt><dd>{formatCirculationDate(selectedLoan.checked_out_at, true)}</dd></div><div><dt>Due date</dt><dd>{formatCirculationDate(selectedLoan.due_at, true)}</dd></div><div><dt>Current fine</dt><dd>{formatFine(selectedLoan.fine_amount)}</dd></div>
          </dl>
          <div className="circulation-detail-actions"><button type="button" className="primary-button" onClick={() => void returnLoan(selectedLoan.id)} disabled={saving}>{saving ? 'Processing…' : 'Return this book'}</button><button type="button" className="secondary-button" onClick={() => setSelectedLoan(null)} disabled={saving}>Close</button></div>
        </DialogContent></>}
      </Dialog>
      <ConfirmDialog open={Boolean(pendingClose)} title={'Mark book ' + (pendingClose?.status || 'closed') + '?'} description="This closes the borrowing record and changes the physical copy status. The action is recorded in the audit log." confirmLabel={'Mark ' + (pendingClose?.status || 'closed')} danger busy={Boolean(saving && pendingClose)} onCancel={() => setPendingClose(null)} onConfirm={() => { if (pendingClose) void closeLoan(pendingClose.loanId, pendingClose.status) }} />
    </section>
  )
}
