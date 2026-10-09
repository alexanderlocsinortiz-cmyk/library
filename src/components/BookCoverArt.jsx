import { useEffect, useRef, useState } from 'react'
import { findVerifiedExternalBookCover, getBookCoverLookupKey, getBookCoverUrl, getBundledCatalogBookCoverUrl, getDirectIsbnCoverUrl } from '../lib/book-covers'

function LibraryCoverPlaceholder({ title }) {
  return <span className="library-cover-placeholder catalog-cover-placeholder">
    <small>IBA COLLEGE LIBRARY</small>
    <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <path d="M24 13c-5-4-11-4-17-2v23c6-2 12-2 17 2m0-23c5-4 11-4 17-2v23c-6-2-12-2-17 2m0-23v23" />
      <path d="M11 17c4-1 7 0 10 2m16-2c-4-1-7 0-10 2M11 23c4-1 7 0 10 2m16-2c-4-1-7 0-10 2" />
    </svg>
    <strong>{title || 'Library collection'}</strong>
  </span>
}

export function BookCoverArt({ book, className, srcOverride, loading = 'lazy', decorative = false, externalLookup = false, suppressSavedCover = false, coverSize = 'M' }) {
  const coverElementRef = useRef(null)
  const [imageFailed, setImageFailed] = useState(false)
  const [failedDirectLookupKey, setFailedDirectLookupKey] = useState('')
  const savedCoverUrl = suppressSavedCover ? '' : getBookCoverUrl(book) || getBundledCatalogBookCoverUrl(book)
  const candidateLookupKey = externalLookup && !srcOverride && !savedCoverUrl ? getBookCoverLookupKey(book) : ''
  const [visibleLookupKey, setVisibleLookupKey] = useState('')
  const lookupKey = visibleLookupKey === candidateLookupKey ? candidateLookupKey : ''
  const lookupTitle = book?.title || ''
  const lookupAuthor = book?.author || ''
  const lookupIsbn = book?.isbn || ''
  const directIsbnCoverUrl = lookupKey && failedDirectLookupKey !== lookupKey ? getDirectIsbnCoverUrl(book, coverSize) : ''
  const [externalCover, setExternalCover] = useState({ key: '', url: '' })
  const externalCoverUrl = externalCover.key === lookupKey ? externalCover.url : ''
  const imageUrl = srcOverride || savedCoverUrl || directIsbnCoverUrl || externalCoverUrl

  useEffect(() => {
    setVisibleLookupKey('')
    if (!candidateLookupKey) return undefined

    const element = coverElementRef.current
    if (!element || typeof IntersectionObserver === 'undefined') {
      setVisibleLookupKey(candidateLookupKey)
      return undefined
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisibleLookupKey(candidateLookupKey)
        observer.disconnect()
      }
    }, { rootMargin: '300px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [candidateLookupKey])

  useEffect(() => {
    let active = true
    if (!lookupKey || directIsbnCoverUrl) {
      setExternalCover({ key: '', url: '' })
      return () => { active = false }
    }
    setExternalCover({ key: lookupKey, url: '' })
    findVerifiedExternalBookCover({ title: lookupTitle, author: lookupAuthor, isbn: lookupIsbn }, coverSize).then((url) => {
      if (active) setExternalCover({ key: lookupKey, url })
    })
    return () => { active = false }
  }, [coverSize, directIsbnCoverUrl, lookupAuthor, lookupIsbn, lookupKey, lookupTitle])

  useEffect(() => setImageFailed(false), [imageUrl])

  return <span className={className} ref={coverElementRef}>
    {imageUrl && !imageFailed
      ? <img src={imageUrl} alt={decorative ? '' : `Cover of ${book?.title || 'book'}`} loading={loading} decoding="async" onError={() => {
        if (directIsbnCoverUrl && imageUrl === directIsbnCoverUrl) setFailedDirectLookupKey(lookupKey)
        else setImageFailed(true)
      }} />
      : <LibraryCoverPlaceholder title={decorative ? '' : book?.title} />}
  </span>
}
