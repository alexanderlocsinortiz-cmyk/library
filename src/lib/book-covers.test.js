import { afterEach, describe, expect, it, vi } from 'vitest'
import { findVerifiedExternalBookCover, MAX_BOOK_COVER_SIZE, getBookCoverUrl, validateBookCoverFile } from './book-covers'

function imageFile(type, bytes, name = 'cover') {
  return new File([Uint8Array.from(bytes)], name, { type })
}

describe('book cover handling', () => {
  it.each([
    ['image/jpeg', [0xff, 0xd8, 0xff, 0x00]],
    ['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    ['image/webp', [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]],
  ])('accepts a %s image with matching file signature', async (type, bytes) => {
    await expect(validateBookCoverFile(imageFile(type, bytes))).resolves.toBeInstanceOf(File)
  })

  it('rejects a spoofed image type and an oversized file', async () => {
    await expect(validateBookCoverFile(imageFile('image/png', [0x3c, 0x73, 0x76, 0x67, 0x3e]))).rejects.toThrow('not a valid')
    const tooLarge = new File([new Uint8Array(MAX_BOOK_COVER_SIZE + 1)], 'large.png', { type: 'image/png' })
    await expect(validateBookCoverFile(tooLarge)).rejects.toThrow('up to 5 MB')
  })

  it('keeps first-party legacy cover paths and rejects unverified remote or executable URLs', () => {
    expect(getBookCoverUrl({ cover_url: '/covers/example.jpg' })).toBe('/covers/example.jpg')
    expect(getBookCoverUrl({ cover_url: 'https://covers.example.org/book.jpg' })).toBe('')
    expect(getBookCoverUrl({ cover_url: 'javascript:alert(1)' })).toBe('')
    expect(getBookCoverUrl({ cover_url: '//unsafe.example.org/book.jpg' })).toBe('')
    expect(getBookCoverUrl({ cover_url: 'data:image/png;base64,AAAA' })).toBe('')
  })

  it('prioritizes an ISBN match but still verifies its title and author', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const url = new URL(input)
      if (url.searchParams.has('isbn')) return {
        ok: true,
        json: async () => ({ docs: [
          { isbn: ['9780140328721'], title: 'A different book', author_name: ['Someone Else'], cover_i: 10 },
          { isbn: ['978-0-14-032872-1'], title: 'Fantastic Mr. Fox', author_name: ['Roald Dahl'], cover_i: 11 },
        ] }),
      }
      return { ok: true, json: async () => ({ docs: [] }) }
    }))

    await expect(findVerifiedExternalBookCover({
      isbn: '978-0-14-032872-1',
      title: 'Fantastic Mr Fox',
      author: 'Dahl, Roald',
    })).resolves.toBe('https://covers.openlibrary.org/b/id/11-M.jpg?default=false')
  })

  it('uses title and author only as an exact fallback and rejects mismatched results', async () => {
    const fetchMock = vi.fn(async (input) => {
      const url = new URL(input)
      return url.searchParams.has('isbn')
        ? { ok: true, json: async () => ({ docs: [] }) }
        : { ok: true, json: async () => ({ docs: [
          { title: 'The Wrong Book', author_name: ['Library author'], cover_i: 99 },
        ] }) }
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(findVerifiedExternalBookCover({
      isbn: '9780140328721',
      title: 'A Unique Catalog Title',
      author: 'A Unique Catalog Author',
    })).resolves.toBe('')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('finds a verified title-and-author cover when the ISBN is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ docs: [
        { title: 'Exact Fallback Title', author_name: ['Exact Author'], cover_i: 1234 },
      ] }),
    })))

    await expect(findVerifiedExternalBookCover({
      isbn: '',
      title: 'Exact Fallback Title',
      author: 'Exact Author',
    })).resolves.toBe('https://covers.openlibrary.org/b/id/1234-M.jpg?default=false')
  })

  it('matches comma-separated coauthors and provider subtitles, but rejects incomplete author metadata', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ docs: [
        {
          title: 'Computer Networking, A Top-Down Approach Featuring the Internet Book',
          author_name: ['James F. Kurose', 'Keith W. Ross'],
          cover_i: 193126,
        },
      ] }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(findVerifiedExternalBookCover({
      title: 'Computer Networking: A Top-Down Approach',
      author: 'James F. Kurose, Keith W. Ross',
    })).resolves.toBe('https://covers.openlibrary.org/b/id/193126-M.jpg?default=false')

    const incompleteAuthorFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ docs: [
        { title: 'Computer Networking', author_name: ['James F. Kurose'], cover_i: 193127 },
      ] }),
    }))
    vi.stubGlobal('fetch', incompleteAuthorFetch)
    await expect(findVerifiedExternalBookCover({
      title: 'Computer Networking: A Top-Down Approach',
      author: 'James F. Kurose, Keith W. Ross II',
    })).resolves.toBe('')
  })

  afterEach(() => vi.unstubAllGlobals())
})
