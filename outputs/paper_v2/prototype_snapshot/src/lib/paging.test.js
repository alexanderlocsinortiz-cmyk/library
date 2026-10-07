import { describe, expect, it, vi } from 'vitest'
import { fetchAllRows } from './paging'

describe('API pagination', () => {
  it('continues past a server cap lower than the requested page size', async () => {
    const all = Array.from({ length: 7 }, (_, id) => ({ id }))
    const range = vi.fn(async (start) => ({ data: all.slice(start, start + 2), error: null }))
    const makeQuery = () => ({ order: () => ({ range }) })
    expect((await fetchAllRows(makeQuery)).data).toEqual(all)
    expect(range.mock.calls.map(([start]) => start)).toEqual([0, 2, 4, 6, 7])
  })
  it('does not present partial results as the full collection on a later-page failure', async () => {
    const failure = { message: 'Network failure' }
    const range = vi.fn().mockResolvedValueOnce({ data: [{ id: 1 }], error: null }).mockResolvedValueOnce({ data: null, error: failure })
    expect(await fetchAllRows(() => ({ order: () => ({ range }) }))).toEqual({ data: null, error: failure })
  })
})
