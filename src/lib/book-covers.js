import { supabase } from './supabase'

export const BOOK_COVERS_BUCKET = 'book-covers'
export const MAX_BOOK_COVER_SIZE = 5 * 1024 * 1024
export const MAX_BOOK_COVER_WIDTH = 600
export const MAX_BOOK_COVER_HEIGHT = 900

const EXTERNAL_COVER_CACHE = new Map()
let openLibraryRequestQueue = Promise.resolve()
let lastOpenLibraryRequestAt = 0
const OPEN_LIBRARY_REQUEST_INTERVAL_MS = 500

const COVER_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const COVER_EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}
const STORAGE_COVER_PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/i

export function getBookCoverUrl(book) {
  if (typeof book?.cover_image_path === 'string' && STORAGE_COVER_PATH.test(book.cover_image_path) && supabase?.storage) {
    const { data } = supabase.storage.from(BOOK_COVERS_BUCKET).getPublicUrl(book.cover_image_path)
    return data?.publicUrl || ''
  }

  const legacyUrl = book?.cover_url?.trim()
  if (!legacyUrl) return ''

  // Keep first-party artwork, but do not trust arbitrary remote URLs. External
  // artwork must pass the ISBN/title/author lookup below.
  const hasControlCharacter = [...legacyUrl].some((character) => character.charCodeAt(0) < 0x20)
  if (legacyUrl.startsWith('/') && !legacyUrl.startsWith('//') && !legacyUrl.includes('\\') && !hasControlCharacter) return legacyUrl
  return ''
}

function normalizeIsbn(value) {
  const isbn = String(value || '').toUpperCase().replace(/[^0-9X]/g, '')
  if (/^\d{13}$/.test(isbn)) {
    const checksum = [...isbn.slice(0, 12)].reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0)
    return (10 - (checksum % 10)) % 10 === Number(isbn[12]) ? isbn : ''
  }
  if (/^\d{9}[\dX]$/.test(isbn)) {
    const checksum = [...isbn].reduce((total, digit, index) => total + (digit === 'X' ? 10 : Number(digit)) * (10 - index), 0)
    return checksum % 11 === 0 ? isbn : ''
  }
  return ''
}

export function getDirectIsbnCoverUrl(book, size = 'M') {
  const isbn = normalizeIsbn(book?.isbn)
  const imageSize = ['S', 'M', 'L'].includes(size) ? size : 'M'
  return isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-${imageSize}.jpg?default=false` : ''
}

function normalizeMatchText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function canonicalAuthor(value) {
  return normalizeMatchText(value).split(' ').filter(Boolean).sort().join(' ')
}

const BUNDLED_CATALOG_COVERS = [
  {
    title: 'developmentally appropriate practice in early childhood programs',
    author: 'national association for the education of young children',
    isbn: '9781938113956',
    url: '/book-covers/developmentally-appropriate-practice-fourth-edition-optimized.jpg',
  },
]

export function getBundledCatalogBookCoverUrl(book) {
  const title = normalizeMatchText(book?.title)
  const author = canonicalAuthor(book?.author)
  const isbn = normalizeIsbn(book?.isbn)
  const match = BUNDLED_CATALOG_COVERS.find((cover) => cover.title === title && cover.author === author)
  if (!match || (isbn && isbn !== match.isbn)) return ''
  return match.url
}

function hasMatchingAuthorName(requested, found) {
  const canonicalRequested = canonicalAuthor(requested)
  const canonicalFound = canonicalAuthor(found)
  if (canonicalRequested && canonicalRequested === canonicalFound) return true

  // Some provider records append a middle/maiden name to an otherwise exact
  // author. Requiring every requested name token avoids loose substring hits.
  const requestedTokens = new Set(normalizeMatchText(requested).split(' ').filter(Boolean))
  const foundTokens = new Set(normalizeMatchText(found).split(' ').filter(Boolean))
  return requestedTokens.size >= 2 && [...requestedTokens].every((token) => foundTokens.has(token))
}

function hasMatchingAuthor(bookAuthor, providerAuthors, requireEveryAuthor = false) {
  const requested = canonicalAuthor(bookAuthor)
  const foundAuthors = Array.isArray(providerAuthors) ? providerAuthors : []
  const wholeNameMatches = requested && foundAuthors.some((name) => hasMatchingAuthorName(bookAuthor, name))
  if (wholeNameMatches && !requireEveryAuthor) return true

  // Catalog records use commas between coauthors, while some single-author
  // records use "Last, First". Check the whole field first, then individual
  // names; a multi-author record must account for every listed author.
  const requestedAuthors = String(bookAuthor || '')
    .split(/\s+(?:and|&|\/|\|)\s+|\s*;\s*|\s*,\s*/i)
    .map((name) => name.trim())
    .filter(Boolean)
  const isReversedSingleName = requestedAuthors.length === 2
    && requestedAuthors.every((name) => normalizeMatchText(name).split(' ').length === 1)
  if (isReversedSingleName) {
    return foundAuthors.some((foundName) => hasMatchingAuthorName(bookAuthor, foundName))
  }
  const authorMatches = requestedAuthors.map((requestedName) => foundAuthors.some((foundName) => hasMatchingAuthorName(requestedName, foundName)))
  return requireEveryAuthor
    ? authorMatches.length > 0 && authorMatches.every(Boolean)
    : wholeNameMatches || authorMatches.some(Boolean)
}

function getTitleMatchType(bookTitle, providerTitle) {
  const requestedRaw = String(bookTitle || '').trim()
  const providerRaw = String(providerTitle || '').trim()
  const requested = normalizeMatchText(requestedRaw)
  const provider = normalizeMatchText(providerRaw)
  if (!requested) return ''
  if (requested === provider) return 'exact'

  // Some catalog titles include a subtitle while the provider lists only the
  // main title. This is safe only with an exact main-title match.
  const mainTitle = normalizeMatchText(requestedRaw.split(/[:–—]/u, 1)[0])
  if (mainTitle && mainTitle === provider) return 'main'

  // Editions often replace a colon with a comma and append their subtitle.
  // Require the complete catalog title at the start and a subtitle delimiter.
  if (provider.startsWith(`${requested} `)) {
    const prefix = providerRaw.slice(0, requestedRaw.length)
    const suffix = providerRaw.slice(requestedRaw.length)
    if (normalizeMatchText(prefix) === requested
      && /^\s*(?:[,:;–—-]\s*|(?:[0-9]{1,2}(?:st|nd|rd|th)?\s+)?(?:ed|edition)\b|(?:featuring|textbook|international|global|student|instructor|volume|for|part)\b)/iu.test(suffix)) return 'extended'
  }
  return ''
}

function hasCoverId(value) {
  return Number.isInteger(value) && value > 0
}

async function requestOpenLibrary(url) {
  const wait = Math.max(0, OPEN_LIBRARY_REQUEST_INTERVAL_MS - (Date.now() - lastOpenLibraryRequestAt))
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  lastOpenLibraryRequestAt = Date.now()

  const response = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!response.ok && [429, 502, 503].includes(response.status)) {
    await new Promise((resolve) => setTimeout(resolve, 1200))
    lastOpenLibraryRequestAt = Date.now()
    return fetch(url, { headers: { Accept: 'application/json' } })
  }
  return response
}

async function queryOpenLibrary(params) {
  const url = new URL('https://openlibrary.org/search.json')
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  const queuedRequest = openLibraryRequestQueue.then(async () => {
    const response = await requestOpenLibrary(url)
    if (!response.ok) return []
    const result = await response.json()
    return Array.isArray(result?.docs) ? result.docs : []
  })
  openLibraryRequestQueue = queuedRequest.then(() => undefined, () => undefined)
  return queuedRequest
}

async function findCoverFromOpenLibrary(book, size) {
  const title = String(book?.title || '').trim().slice(0, 300)
  const author = String(book?.author || '').trim().slice(0, 300)
  if (!title || !author) return ''

  const fields = 'title,author_name,isbn,cover_i'
  const isbn = normalizeIsbn(book?.isbn)
  if (isbn) {
    try {
      const isbnDocs = await queryOpenLibrary({ isbn, fields, limit: '20' })
      const isbnMatch = isbnDocs.find((item) => Array.isArray(item.isbn)
        && item.isbn.some((candidate) => normalizeIsbn(candidate) === isbn)
        && getTitleMatchType(title, item.title)
        && hasMatchingAuthor(author, item.author_name)
        && hasCoverId(item.cover_i))
      if (isbnMatch) return `https://covers.openlibrary.org/b/id/${isbnMatch.cover_i}-${size}.jpg?default=false`
    } catch {
      // Try the strict title-and-author fallback below if the ISBN service is unavailable.
    }
  }

  const mainTitle = title.split(/[:–—]/u, 1)[0].trim()
  const primaryAuthor = author.split(/\s*,\s*/, 1)[0].trim()
  const queries = [{ title, author }]
  if (mainTitle && (mainTitle !== title || primaryAuthor !== author)) {
    queries.push({ title: mainTitle, author: primaryAuthor || author })
  }
  const searched = new Set()
  for (const query of queries) {
    const queryKey = `${query.title}|${query.author}`
    if (searched.has(queryKey)) continue
    searched.add(queryKey)
    try {
      const titleDocs = await queryOpenLibrary({ ...query, fields, limit: '20' })
      const titleMatch = titleDocs.find((item) => {
        const titleMatchType = getTitleMatchType(title, item.title)
        return titleMatchType
          && hasMatchingAuthor(author, item.author_name, titleMatchType === 'main')
          && hasCoverId(item.cover_i)
      })
      if (titleMatch) return `https://covers.openlibrary.org/b/id/${titleMatch.cover_i}-${size}.jpg?default=false`
    } catch {
      // An unavailable metadata service should leave the standard library placeholder in place.
    }
  }
  return ''
}

export function getBookCoverLookupKey(book) {
  const title = normalizeMatchText(book?.title)
  const author = canonicalAuthor(book?.author)
  const isbn = normalizeIsbn(book?.isbn)
  if (!isbn && (!title || !author)) return ''
  return `${isbn}|${title}|${author}`
}

export function findVerifiedExternalBookCover(book, size = 'M') {
  const key = getBookCoverLookupKey(book)
  if (!key) return Promise.resolve('')
  const imageSize = ['S', 'M', 'L'].includes(size) ? size : 'M'
  const cacheKey = `${key}|${imageSize}`
  if (!EXTERNAL_COVER_CACHE.has(cacheKey)) {
    EXTERNAL_COVER_CACHE.set(cacheKey, findCoverFromOpenLibrary(book, imageSize))
  }
  return EXTERNAL_COVER_CACHE.get(cacheKey)
}

export function getBookCoverExtension(mimeType) {
  return COVER_EXTENSIONS[mimeType] || ''
}

async function readFileHeader(file) {
  const header = file.slice(0, 12)
  if (typeof header.arrayBuffer === 'function') return new Uint8Array(await header.arrayBuffer())

  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result))
    reader.onerror = () => reject(new Error('Unable to read the selected image.'))
    reader.readAsArrayBuffer(header)
  })
}

export async function validateBookCoverFile(file) {
  if (!file || !COVER_MIME_TYPES.has(file.type)) {
    throw new Error('Choose a JPG, PNG, or WebP image.')
  }
  if (file.size < 1 || file.size > MAX_BOOK_COVER_SIZE) {
    throw new Error('Book covers must be up to 5 MB.')
  }

  const bytes = await readFileHeader(file)
  const isJpeg = file.type === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  const isPng = file.type === 'image/png'
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  const isWebp = file.type === 'image/webp'
    && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'

  if (!isJpeg && !isPng && !isWebp) {
    throw new Error('The selected file is not a valid JPG, PNG, or WebP image.')
  }
  return file
}

export async function optimizeBookCoverFile(file) {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file

  let bitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return file
  }

  try {
    const scale = Math.min(1, MAX_BOOK_COVER_WIDTH / bitmap.width, MAX_BOOK_COVER_HEIGHT / bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (!context) return file
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.8))
    if (!blob || blob.size >= file.size) return file

    const filename = file.name.replace(/\.[^.]+$/, '') || 'book-cover'
    return new File([blob], `${filename}.webp`, { type: 'image/webp', lastModified: file.lastModified })
  } catch {
    return file
  } finally {
    bitmap.close?.()
  }
}
