// Fetch every API page for screens whose filters operate on the full collection.
// Continue even when the server's configured row cap is below our page size.
export async function fetchAllRows(makeQuery) {
  const rows = []
  for (;;) {
    const { data, error } = await makeQuery().order('id').range(rows.length, rows.length + 199)
    if (error) return { data: null, error }
    if (!data?.length) return { data: rows, error: null }
    rows.push(...data)
  }
}
