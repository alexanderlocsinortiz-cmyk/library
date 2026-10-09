import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  books: [],
  insertError: null,
  from: vi.fn(),
  insert: vi.fn(),
  insertBook: vi.fn(),
  updateBook: vi.fn(),
  storageFrom: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
  getPublicUrl: vi.fn(),
}))

vi.mock('../lib/paging', () => ({ fetchAllRows: async (query) => query() }))
vi.mock('../lib/supabase', () => ({ supabase: { from: mock.from, storage: { from: mock.storageFrom } } }))
vi.mock('./CirculationHealth', () => ({ CirculationHealth: () => null }))
vi.mock('./ConfirmDialog', () => ({ ConfirmDialog: () => null }))
vi.mock('@mui/material', () => ({
  Dialog: ({ open, children, ...props }) => open ? <div role="dialog" aria-labelledby={props['aria-labelledby']}>{children}</div> : null,
  DialogContent: ({ children }) => <div>{children}</div>,
  DialogTitle: ({ children, id }) => <h2 id={id}>{children}</h2>,
}))

import { StaffCatalogManager } from './StaffTools'

function openCopyDialog() {
  fireEvent.click(screen.getByRole('button', { name: 'Add Copy' }))
  return screen.getByRole('dialog', { name: 'Add Physical Copy' })
}

function fillCopyForm({ barcode = 'IBA-100', location = 'Filipiniana', condition = 'good' } = {}) {
  fireEvent.change(screen.getByRole('combobox', { name: 'Book' }), { target: { value: 'book-1' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Barcode' }), { target: { value: barcode } })
  fireEvent.change(screen.getByRole('combobox', { name: 'Shelf Location' }), { target: { value: location } })
  fireEvent.change(screen.getByRole('combobox', { name: 'Condition' }), { target: { value: condition } })
}

function submitCopyForm() {
  fireEvent.submit(screen.getByRole('button', { name: 'Save Copy' }).closest('form'))
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ docs: [] }) }))
  mock.books = [{
    id: 'book-1',
    title: 'Example book',
    author: 'Example author',
    isbn: '9780000000000',
    category: 'Reference',
    course_subject: 'Library Science',
    publication_year: 2024,
    book_copies: [],
  }]
  mock.insertError = null
  mock.insert.mockImplementation(async (copy) => {
    if (mock.insertError) return { error: mock.insertError }
    mock.books = mock.books.map((book) => book.id === copy.book_id
      ? { ...book, book_copies: [...book.book_copies, { ...copy, id: 'copy-1', status: 'available' }] }
      : book)
    return { error: null }
  })
  mock.upload.mockResolvedValue({ error: null })
  mock.remove.mockResolvedValue({ error: null })
  mock.getPublicUrl.mockImplementation((path) => ({ data: { publicUrl: `https://covers.example.org/${path}` } }))
  mock.storageFrom.mockImplementation(() => ({ upload: mock.upload, remove: mock.remove, getPublicUrl: mock.getPublicUrl }))
  mock.insertBook.mockImplementation(async (newBook) => {
    if (mock.insertError) return { error: mock.insertError }
    mock.books = [...mock.books, { ...newBook, book_copies: [] }]
    return { error: null }
  })
  mock.updateBook.mockImplementation(async (id, payload) => {
    if (mock.insertError) return { error: mock.insertError }
    mock.books = mock.books.map((book) => book.id === id ? { ...book, ...payload } : book)
    return { error: null }
  })
  mock.from.mockImplementation((table) => table === 'books'
    ? {
      select: () => ({ order: async () => ({ data: mock.books, error: null }) }),
      insert: mock.insertBook,
      update: (payload) => ({ eq: (_column, id) => mock.updateBook(id, payload) }),
    }
    : { insert: mock.insert })
})

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('Books page Add Copy dialog', () => {
  it('requires a book and barcode before inserting a copy', async () => {
    render(<StaffCatalogManager />)
    await screen.findByText('Example book')
    openCopyDialog()

    submitCopyForm()

    expect(await screen.findByRole('alert')).toHaveTextContent('choose a shelf')
    expect(mock.insert).not.toHaveBeenCalled()
  })

  it('blocks a duplicate barcode without calling the insert API', async () => {
    mock.books[0].book_copies = [{ id: 'existing-copy', barcode: 'iba-100', status: 'available' }]
    render(<StaffCatalogManager />)
    await screen.findByText('Example book')
    openCopyDialog()
    fillCopyForm({ barcode: 'IBA-100' })

    submitCopyForm()

    expect(await screen.findByRole('alert')).toHaveTextContent('barcode already exists')
    expect(mock.insert).not.toHaveBeenCalled()
  })

  it('saves a copy, closes the dialog, and refreshes copy availability', async () => {
    render(<StaffCatalogManager />)
    await screen.findByText('Example book')
    openCopyDialog()
    fillCopyForm({ barcode: ' IBA-100 ', location: 'Filipiniana', condition: 'new' })

    fireEvent.click(screen.getByRole('button', { name: 'Save Copy' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(mock.insert).toHaveBeenCalledWith({ book_id: 'book-1', barcode: 'IBA-100', location: 'Filipiniana', condition: 'new' })
    expect(await screen.findByRole('status')).toHaveTextContent('Physical copy added.')
    await waitFor(() => {
      const row = screen.getByText('Example book').closest('tr')
      expect(row).toHaveTextContent('1')
    })
  })

  it('keeps the dialog open and reports a database duplicate error', async () => {
    mock.insertError = { code: '23505', message: 'duplicate key value violates unique constraint' }
    render(<StaffCatalogManager />)
    await screen.findByText('Example book')
    openCopyDialog()
    fillCopyForm()

    fireEvent.click(screen.getByRole('button', { name: 'Save Copy' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('barcode already exists')
    expect(screen.getByRole('dialog', { name: 'Add Physical Copy' })).toBeInTheDocument()
  })

  it('lets administrators preview a validated image before saving it', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:cover-preview')
    URL.revokeObjectURL = vi.fn()
    render(<StaffCatalogManager role="administrator" />)
    await screen.findByText('Example book')
    fireEvent.click(screen.getByRole('button', { name: 'Add Book' }))

    const image = new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'cover.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText('Book cover image'), { target: { files: [image] } })

    expect(await screen.findByText('Selected cover preview')).toBeInTheDocument()
    expect(screen.getByAltText('Cover of Book cover preview')).toHaveAttribute('src', 'blob:cover-preview')
  })

  it('uploads the cover and stores its path with the new book', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:cover-preview')
    URL.revokeObjectURL = vi.fn()
    render(<StaffCatalogManager role="administrator" />)
    await screen.findByText('Example book')
    fireEvent.click(screen.getByRole('button', { name: 'Add Book' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'New cover test' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Author' }), { target: { value: 'Library author' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Book description' }), { target: { value: 'An overview of the topic.' } })

    const image = new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'cover.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText('Book cover image'), { target: { files: [image] } })
    await screen.findByText('Selected cover preview')
    fireEvent.click(screen.getByRole('button', { name: 'Add book' }))

    await waitFor(() => expect(mock.insertBook).toHaveBeenCalledTimes(1))
    expect(mock.upload).toHaveBeenCalledTimes(1)
    const [uploadedPath, uploadedFile, uploadOptions] = mock.upload.mock.calls[0]
    expect(uploadedPath).toMatch(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.png$/i)
    expect(uploadedFile).toBe(image)
    expect(uploadOptions).toMatchObject({ contentType: 'image/png', upsert: false })
    expect(mock.insertBook.mock.calls[0][0]).toMatchObject({ title: 'New cover test', description: 'An overview of the topic.', cover_image_path: uploadedPath, cover_url: null })
    expect(await screen.findByRole('status')).toHaveTextContent('Cover saved.')
  })

  it('loads and saves the description when editing an existing book', async () => {
    mock.books[0].description = 'Old summary.'
    render(<StaffCatalogManager />)
    await screen.findByText('Example book')
    fireEvent.click(screen.getByRole('button', { name: 'Edit Example book' }))

    expect(screen.getByRole('textbox', { name: 'Book description' })).toHaveValue('Old summary.')
    fireEvent.change(screen.getByRole('textbox', { name: 'Book description' }), { target: { value: 'Updated accurate summary.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(mock.updateBook).toHaveBeenCalledWith('book-1', expect.objectContaining({ description: 'Updated accurate summary.' })))
    expect(await screen.findByRole('status')).toHaveTextContent('Book details updated.')
  })

  it('lets librarians upload and preview book covers', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:librarian-cover-preview')
    URL.revokeObjectURL = vi.fn()
    render(<StaffCatalogManager role="librarian" />)
    await screen.findByText('Example book')
    fireEvent.click(screen.getByRole('button', { name: 'Add Book' }))

    const image = new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'cover.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText('Book cover image'), { target: { files: [image] } })

    expect(await screen.findByText('Selected cover preview')).toBeInTheDocument()
    expect(screen.getByAltText('Cover of Book cover preview')).toHaveAttribute('src', 'blob:librarian-cover-preview')
  })
})
