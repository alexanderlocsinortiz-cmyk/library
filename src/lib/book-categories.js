export const BOOK_CATEGORY_PRESETS = ['Fiction']

export function getBookCategories(books = []) {
  return [...new Set([
    ...BOOK_CATEGORY_PRESETS,
    ...books
      .map((book) => book.category)
      .filter((category) => typeof category === 'string' && category.trim()),
  ])].sort((left, right) => left.localeCompare(right))
}
