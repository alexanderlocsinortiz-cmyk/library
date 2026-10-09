import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ books: [], from: vi.fn(), rpc: vi.fn() }))

vi.mock('../lib/paging', () => ({ fetchAllRows: async (query) => query() }))
vi.mock('../lib/supabase', () => ({ supabase: { from: mock.from, rpc: mock.rpc } }))
vi.mock('./ConfirmDialog', () => ({ ConfirmDialog: () => null }))

import { CatalogPage } from './MemberViews'

function makeBooks(count = 25) {
  return Array.from({ length: count }, (_, index) => ({
    id: `book-${index}`,
    title: `Title ${String(index).padStart(2, '0')}`,
    author: `Author ${index % 4}`,
    isbn: `978-000-${String(index).padStart(4, '0')}`,
    category: index % 2 === 0 ? 'Accounting' : 'Business',
    course_subject: index % 2 === 0 ? 'Finance' : 'Management',
    description: 'A catalog test description.',
    publication_year: 2000 + index,
    cover_url: index === 1 ? '/covers/example.jpg' : null,
    book_copies: [{ id: `copy-${index}`, status: index % 2 === 0 ? 'available' : 'borrowed', location: 'Shelf A' }],
  }))
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ docs: [] }) }))
  mock.books = makeBooks()
  mock.rpc.mockResolvedValue({ data: true, error: null })
  mock.from.mockImplementation(() => ({
    select: () => ({
      order: async () => ({ data: mock.books, error: null }),
      eq: (_column, id) => ({ maybeSingle: async () => ({ data: mock.books.find((book) => book.id === id) || null, error: null }) }),
    }),
  }))
})

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('CatalogPage browsing', () => {
  it('shows six compact cards per member page with a numbered range summary', async () => {
    render(<CatalogPage role="member" onBack={vi.fn()} />)
    await screen.findByRole('heading', { name: 'Browse Books' })
    await screen.findByRole('button', { name: 'View details for Title 00' })

    expect(screen.getAllByRole('article')).toHaveLength(6)
    expect(screen.getByText('Showing 1–6 of 25 books')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Page 1' })).toHaveAttribute('aria-current', 'page')

    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }))
    expect(await screen.findByRole('button', { name: 'View details for Title 06' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'View details for Title 00' })).not.toBeInTheDocument()
    expect(screen.getByText('Showing 7–12 of 25 books')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByRole('button', { name: 'View details for Title 12' })).toBeInTheDocument()
    expect(screen.getByText('Showing 13–18 of 25 books')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Page 5' }))
    expect(await screen.findByRole('button', { name: 'View details for Title 24' })).toBeInTheDocument()
    expect(screen.getByText('Showing 25–25 of 25 books')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
  })

  it('combines search, availability, category, and author filters, then clears them', async () => {
    render(<CatalogPage role="member" />)
    await screen.findByRole('button', { name: 'View details for Title 00' })
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }))
    await screen.findByRole('button', { name: 'View details for Title 06' })

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search library' }), { target: { value: 'Title 10' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter availability' }), { target: { value: 'available' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter category' }), { target: { value: 'Accounting' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter author' }), { target: { value: 'Author 2' } })

    expect(await screen.findByRole('button', { name: 'View details for Title 10' })).toBeInTheDocument()
    expect(screen.getAllByRole('article')).toHaveLength(1)
    expect(screen.getByText('1 matching book')).toBeInTheDocument()
    expect(screen.getByText('Showing 1–1 of 1 book')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Clear Filters' }))
    expect(await screen.findByRole('button', { name: 'View details for Title 00' })).toBeInTheDocument()
    expect(screen.getByRole('searchbox', { name: 'Search library' })).toHaveValue('')
    expect(screen.getByRole('combobox', { name: 'Filter availability' })).toHaveValue('all')
    expect(screen.getAllByRole('article')).toHaveLength(6)
  })

  it('resets the current page after changing sort order', async () => {
    render(<CatalogPage role="member" />)
    await screen.findByRole('button', { name: 'View details for Title 00' })
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }))
    await screen.findByRole('button', { name: 'View details for Title 06' })

    fireEvent.change(screen.getByRole('combobox', { name: 'Sort catalog' }), { target: { value: 'newest' } })

    expect(await screen.findByRole('button', { name: 'View details for Title 24' })).toBeInTheDocument()
    expect(screen.getByText('Showing 1–6 of 25 books')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Page 1' })).toHaveAttribute('aria-current', 'page')
  })

  it('opens the existing details view from the book card and returns to the grid', async () => {
    render(<CatalogPage role="member" />)
    await screen.findByRole('button', { name: 'View details for Title 00' })

    fireEvent.click(screen.getByRole('button', { name: 'View details for Title 00' }))

    expect(await screen.findByRole('heading', { name: 'Title 00' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back to catalog' }))
    expect(await screen.findByRole('heading', { name: 'Browse Books' })).toBeInTheDocument()
  })

  it('opens a requested book directly from the member dashboard handoff', async () => {
    const onInitialBookOpened = vi.fn()
    render(<CatalogPage role="member" initialBookId="book-13" onInitialBookOpened={onInitialBookOpened} />)

    expect(await screen.findByRole('heading', { name: 'Title 13' })).toBeInTheDocument()
    expect(onInitialBookOpened).toHaveBeenCalledOnce()
  })

  it('lets a member place a pickup hold on an available copy', async () => {
    render(<CatalogPage role="member" />)
    await screen.findByRole('button', { name: 'View details for Title 00' })

    fireEvent.click(screen.getAllByRole('button', { name: 'Reserve' })[0])

    await waitFor(() => expect(mock.rpc).toHaveBeenCalledWith('reserve_book', { p_book_id: 'book-0' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Reservation request placed')
  })

  it('offers the pickup hold action in book details when a copy is available', async () => {
    render(<CatalogPage role="member" />)
    fireEvent.click(await screen.findByRole('button', { name: 'View details for Title 00' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Reserve for pickup' }))

    await waitFor(() => expect(mock.rpc).toHaveBeenCalledWith('reserve_book', { p_book_id: 'book-0' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Reservation request placed')
  })

  it('shows cover placeholders and the loading skeleton accessibly', async () => {
    let resolveBooks
    mock.from.mockImplementation(() => ({ select: () => ({ order: () => new Promise((resolve) => { resolveBooks = resolve }) }) }))
    render(<CatalogPage role="public" />)

    expect(screen.getByRole('status', { name: 'Loading catalog books' })).toHaveAttribute('aria-busy', 'true')
    expect(document.querySelectorAll('.catalog-skeleton-card')).toHaveLength(12)

    await act(async () => resolveBooks({ data: makeBooks(1), error: null }))
    expect(await screen.findByText('IBA COLLEGE LIBRARY')).toBeInTheDocument()
    expect(screen.getAllByText('Title 00')).toHaveLength(2)
  })
})
