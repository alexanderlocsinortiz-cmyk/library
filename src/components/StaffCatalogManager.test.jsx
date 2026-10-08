import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ books: [], insertError: null, from: vi.fn(), insert: vi.fn() }))

vi.mock('../lib/paging', () => ({ fetchAllRows: async (query) => query() }))
vi.mock('../lib/supabase', () => ({ supabase: { from: mock.from } }))
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

function fillCopyForm({ barcode = 'IBA-100', location = 'Shelf A1', condition = 'good' } = {}) {
  fireEvent.change(screen.getByRole('combobox', { name: 'Book' }), { target: { value: 'book-1' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Barcode' }), { target: { value: barcode } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Location' }), { target: { value: location } })
  fireEvent.change(screen.getByRole('combobox', { name: 'Condition' }), { target: { value: condition } })
}

function submitCopyForm() {
  fireEvent.submit(screen.getByRole('button', { name: 'Save Copy' }).closest('form'))
}

beforeEach(() => {
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
  mock.from.mockImplementation((table) => table === 'books'
    ? { select: () => ({ order: async () => ({ data: mock.books, error: null }) }) }
    : { insert: mock.insert })
})

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('Books page Add Copy dialog', () => {
  it('requires a book and barcode before inserting a copy', async () => {
    render(<StaffCatalogManager />)
    await screen.findByText('Example book')
    openCopyDialog()

    submitCopyForm()

    expect(await screen.findByRole('alert')).toHaveTextContent('Select a book and enter a barcode')
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
    fillCopyForm({ barcode: ' IBA-100 ', location: ' Shelf A1 ', condition: 'new' })

    fireEvent.click(screen.getByRole('button', { name: 'Save Copy' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(mock.insert).toHaveBeenCalledWith({ book_id: 'book-1', barcode: 'IBA-100', location: 'Shelf A1', condition: 'new' })
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
})
