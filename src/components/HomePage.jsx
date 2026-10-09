import { useEffect, useState } from 'react'
import { fetchAllRows } from '../lib/paging'
import { supabase } from '../lib/supabase'
import { BookCoverArt } from './BookCoverArt'

const COLLECTIONS = [
  { name: 'Filipiniana', search: 'Filipiniana', detail: 'Books that preserve and explore Philippine stories, culture, and history.', mark: 'PH' },
  { name: 'Thesis', search: 'Thesis', detail: 'Research and academic work from the IBA College community.', mark: 'RE' },
  { name: 'General Circulation', search: 'General Circulation', detail: 'Browse titles for coursework, reference, and everyday reading.', mark: 'GC' },
  { name: 'Fiction', search: 'Fiction', detail: 'Stories and imaginative worlds from the library shelves.', mark: 'FI' },
]

const INITIAL_STATS = { books: null, availableCopies: null, categories: null }

function formatCount(value) {
  return value === null || value === undefined ? '—' : Number(value).toLocaleString()
}

function InternalLink({ href, onNavigate, className, children, ...props }) {
  const handleClick = (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    onNavigate(href)
  }

  return <a href={href} className={className} onClick={handleClick} {...props}>{children}</a>
}

function BookArtwork({ book }) {
  return <BookCoverArt book={book} className="home-book-artwork" loading="eager" />
}

function FeaturedBook({ book, onNavigate }) {
  const available = (book.book_copies || []).filter((copy) => copy.status === 'available').length

  return <article className="home-featured-book">
    <BookCoverArt book={book} className="home-featured-cover" />
    <div className="home-featured-copy">
      <span className="home-featured-category">{book.category || 'Library title'}</span>
      <h3>{book.title}</h3>
      <p>{book.author || 'Author not recorded'}</p>
      <span className={available > 0 ? 'home-availability is-available' : 'home-availability'}>
        <i aria-hidden="true" />{available > 0 ? `${available} available` : 'Currently unavailable'}
      </span>
      <InternalLink href="/catalog" onNavigate={onNavigate} className="home-book-link" aria-label={`Browse the catalog for ${book.title}`}>
        View in catalog <span aria-hidden="true">↗</span>
      </InternalLink>
    </div>
  </article>
}

export function HomePage({ onNavigate }) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [stats, setStats] = useState(INITIAL_STATS)
  const [featuredBooks, setFeaturedBooks] = useState([])
  const [loading, setLoading] = useState(true)
  const [catalogError, setCatalogError] = useState('')

  useEffect(() => {
    let active = true
    const loadHomepageCatalog = async () => {
      if (!supabase) {
        if (active) {
          setCatalogError('Catalog data is unavailable until the library database is configured.')
          setLoading(false)
        }
        return
      }

      const [booksCount, availableCount, categoryRows, featuredResult] = await Promise.all([
        supabase.from('books').select('id', { count: 'exact', head: true }),
        supabase.from('book_copies').select('id', { count: 'exact', head: true }).eq('status', 'available'),
        fetchAllRows(() => supabase.from('books').select('id, category').not('category', 'is', null)),
        supabase.from('books')
          .select('id, title, author, category, cover_url, cover_image_path, created_at, book_copies(id, status)')
          .order('created_at', { ascending: false, nullsFirst: false })
          .limit(4),
      ])

      if (!active) return
      const hasError = Boolean(booksCount.error || availableCount.error || categoryRows.error || featuredResult.error)
      const categories = categoryRows.data
        ? new Set(categoryRows.data.map((book) => book.category?.trim()).filter(Boolean))
        : null
      setStats({
        books: booksCount.error ? null : booksCount.count ?? 0,
        availableCopies: availableCount.error ? null : availableCount.count ?? 0,
        categories: categories?.size ?? null,
      })
      setFeaturedBooks(featuredResult.error ? [] : featuredResult.data ?? [])
      setCatalogError(hasError ? 'Some live catalog information could not be loaded. Please try again later.' : '')
      setLoading(false)
    }

    loadHomepageCatalog().catch(() => {
      if (active) {
        setCatalogError('Catalog information could not be loaded. Please try again later.')
        setLoading(false)
      }
    })
    return () => { active = false }
  }, [])

  return <div className="public-homepage">
    <div className="home-topline"><span>IBA COLLEGE</span><span>READ · LEARN · GROW</span></div>
    <header className="home-header">
      <InternalLink href="/" onNavigate={onNavigate} className="brand-mark home-brand" aria-label="IBA College Library home">
        <span>IBA</span><strong>College Library</strong>
      </InternalLink>
      <button type="button" className="home-menu-toggle" aria-label={mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'} aria-expanded={mobileMenuOpen} onClick={() => setMobileMenuOpen((open) => !open)}>
        <span /><span /><span />
      </button>
      <nav className={mobileMenuOpen ? 'home-nav is-open' : 'home-nav'} aria-label="Main navigation">
        <InternalLink href="/" onNavigate={onNavigate} aria-current="page">Home</InternalLink>
        <InternalLink href="/catalog" onNavigate={onNavigate}>Browse Catalog</InternalLink>
        <InternalLink href="/#about" onNavigate={onNavigate}>About</InternalLink>
        <InternalLink href="/login" onNavigate={onNavigate} className="home-nav-signin">Sign In <span aria-hidden="true">↗</span></InternalLink>
      </nav>
    </header>

    <main>
      <section className="home-hero">
        <div className="home-hero-copy">
          <span className="home-eyebrow"><i aria-hidden="true" /> A PLACE FOR EVERY QUESTION</span>
          <h1>Welcome to <em>IBA College Library</em></h1>
          <p>Find the books, research, and ideas that move your learning forward. Explore the collection and see what’s available on our shelves.</p>
          <div className="home-hero-actions">
            <InternalLink href="/catalog" onNavigate={onNavigate} className="home-button home-button-primary">Browse Books <span aria-hidden="true">↗</span></InternalLink>
            <InternalLink href="/login" onNavigate={onNavigate} className="home-button home-button-secondary">Sign In <span aria-hidden="true">→</span></InternalLink>
          </div>
          <div className="home-hero-note"><span className="home-note-icon" aria-hidden="true">◎</span><span><strong>Open to explore</strong><small>Browse titles and availability without an account.</small></span></div>
        </div>
        <div className="home-hero-visual" role="img" aria-label={featuredBooks[0] ? `A featured book from the library catalog: ${featuredBooks[0].title}` : 'Illustration of a book from the college library'}>
          <div className="home-visual-sun" />
          <div className="home-visual-orbit orbit-one" />
          <div className="home-visual-orbit orbit-two" />
          <div className="home-visual-caption"><span>DISCOVER SOMETHING NEW</span><i aria-hidden="true">✳</i></div>
          <div className="home-visual-shelf" />
          <div className="home-hero-book-shadow" />
          <div className="home-hero-book">
            <BookArtwork book={featuredBooks[0]} />
            <div className="home-hero-book-spine" />
          </div>
          <div className="home-floating-note"><span className="home-floating-spark" aria-hidden="true">✦</span><span><strong>{featuredBooks.length ? 'A good place to begin' : 'Make room for curiosity'}</strong><small>{featuredBooks[0]?.author || 'Explore the IBA collection'}</small></span></div>
          <div className="home-visual-index">IBA <span>LIBRARY / 01</span></div>
        </div>
      </section>

      <section className="home-stats" aria-label="Live library statistics">
        <div className="home-stats-intro"><span>THE COLLECTION</span><strong>Knowledge,<br />ready to explore.</strong></div>
        <div className="home-stat"><span className="home-stat-mark">01</span><span className="home-stat-value">{loading ? '—' : formatCount(stats.books)}</span><span className="home-stat-label">Book titles</span></div>
        <div className="home-stat"><span className="home-stat-mark">02</span><span className="home-stat-value">{loading ? '—' : formatCount(stats.availableCopies)}</span><span className="home-stat-label">Available copies</span></div>
        <div className="home-stat"><span className="home-stat-mark">03</span><span className="home-stat-value">{loading ? '—' : formatCount(stats.categories)}</span><span className="home-stat-label">Book categories</span></div>
        <div className="home-stats-rule" />
      </section>
      {catalogError && <p className="home-data-note" role="status">{catalogError}</p>}

      <section className="home-section home-featured-section" id="featured">
        <div className="home-section-heading">
          <div><span className="home-section-kicker">ON THE SHELVES</span><h2>Recently added</h2><p>Take a look at titles from the current library catalog.</p></div>
          <InternalLink href="/catalog" onNavigate={onNavigate} className="home-text-link">Explore the catalog <span aria-hidden="true">↗</span></InternalLink>
        </div>
        {loading && <div className="home-featured-grid" role="status" aria-label="Loading featured books"><div className="home-featured-skeleton" /><div className="home-featured-skeleton" /><div className="home-featured-skeleton" /><div className="home-featured-skeleton" /></div>}
        {!loading && featuredBooks.length > 0 && <div className="home-featured-grid">{featuredBooks.map((book) => <FeaturedBook key={book.id} book={book} onNavigate={onNavigate} />)}</div>}
        {!loading && featuredBooks.length === 0 && <div className="home-empty-featured"><span aria-hidden="true">✳</span><strong>{catalogError ? 'Featured titles are temporarily unavailable.' : 'The catalog is ready for its next chapter.'}</strong><p>{catalogError ? 'Please browse the catalog or visit again later.' : 'Visit again as library titles are added.'}</p></div>}
      </section>

      <section className="home-collections-section" id="collections">
        <div className="home-collections-inner">
          <div className="home-section-heading home-collections-heading">
            <div><span className="home-section-kicker">FIND YOUR NEXT READ</span><h2>Explore our collections</h2><p>Start with a subject, follow a question, or wander somewhere unexpected.</p></div>
            <span className="home-collection-count">FOUR WAYS TO BEGIN <i aria-hidden="true">✳</i></span>
          </div>
          <div className="home-collection-grid">{COLLECTIONS.map((collection, index) => <InternalLink key={collection.name} href={`/catalog?search=${encodeURIComponent(collection.search)}`} onNavigate={onNavigate} className={`home-collection-card collection-${index + 1}`}>
            <span className="home-collection-mark" aria-hidden="true">{collection.mark}</span>
            <span className="home-collection-index">0{index + 1} / COLLECTION</span>
            <strong>{collection.name}</strong>
            <span className="home-collection-detail">{collection.detail}</span>
            <span className="home-collection-arrow" aria-hidden="true">↗</span>
          </InternalLink>)}</div>
        </div>
      </section>

      <section className="home-section home-how-section" id="how-it-works">
        <div className="home-how-heading"><span className="home-section-kicker">YOUR NEXT STEP</span><h2>From search to shelf.</h2><p>A simple path from finding a title to borrowing it at the library.</p></div>
        <div className="home-how-grid">
          <article className="home-how-card"><span className="home-how-number">01</span><span className="home-how-icon" aria-hidden="true">⌕</span><h3>Search the catalog</h3><p>Look up a title, author, or subject and discover books in the IBA collection.</p></article>
          <article className="home-how-card"><span className="home-how-number">02</span><span className="home-how-icon" aria-hidden="true">◉</span><h3>Check availability</h3><p>See how many copies are available and find their listed shelf locations.</p></article>
          <article className="home-how-card"><span className="home-how-number">03</span><span className="home-how-icon" aria-hidden="true">↗</span><h3>Visit the library</h3><p>Bring your library card to the circulation desk to borrow an available copy.</p></article>
        </div>
      </section>

      <section className="home-about-section" id="about">
        <div className="home-about-ornament" aria-hidden="true"><span>IBA</span><i /><i /><i /></div>
        <div className="home-about-copy"><span className="home-section-kicker">ABOUT THE LIBRARY</span><h2>A welcoming space for learning and discovery.</h2><p>IBA College Library connects students and faculty with books, research, and practical support for study. Browse the catalog online, then visit the library to explore the collection and borrow at the desk.</p></div>
        <div className="home-about-services"><span className="home-section-kicker">HERE TO HELP</span><h3>Library services</h3><ul><li>Catalog search and copy availability</li><li>Borrowing and returns at the library desk</li><li>Member account and reservation assistance</li></ul><div className="home-contact-note"><span>CONTACT</span><p>For current hours and circulation support, speak with library staff at the IBA College Library desk.</p></div></div>
      </section>

      <section className="home-cta-band">
        <div><span className="home-section-kicker">YOUR NEXT GOOD READ IS OUT THERE</span><h2>Let curiosity lead.</h2><p>Start with the catalog and see where your next question takes you.</p></div>
        <InternalLink href="/catalog" onNavigate={onNavigate} className="home-button home-button-light">Explore the Catalog <span aria-hidden="true">↗</span></InternalLink>
        <span className="home-cta-star" aria-hidden="true">✳</span>
      </section>
    </main>

    <footer className="home-footer">
      <InternalLink href="/" onNavigate={onNavigate} className="brand-mark home-brand home-footer-brand"><span>IBA</span><strong>College Library</strong></InternalLink>
      <p>Supporting learning, research, and discovery.</p>
      <nav aria-label="Footer navigation"><InternalLink href="/" onNavigate={onNavigate}>Home</InternalLink><InternalLink href="/catalog" onNavigate={onNavigate}>Browse Catalog</InternalLink><InternalLink href="/#about" onNavigate={onNavigate}>About</InternalLink><InternalLink href="/login" onNavigate={onNavigate}>Sign In</InternalLink></nav>
      <small>© {new Date().getFullYear()} IBA College Library</small>
    </footer>
  </div>
}
