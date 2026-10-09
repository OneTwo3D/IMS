/**
 * A recording stand-in for the `productContent` Prisma delegate, for the suites that fake the transaction client of
 * the WooCommerce product import.
 *
 * The import now stores a product's content (descriptions, picture references) beside the product it writes, so
 * every double of the transaction client needs a `productContent` delegate or the import throws before it writes
 * anything. Those suites are about other properties (structure, ownership, locks, failure classification); this
 * delegate keeps one row per product in memory and nothing more. The behaviour of the content step itself is
 * pinned in tests/wc-product-sync-content.test.ts, which has its own delegate.
 */

type Row = Record<string, unknown>

export function createProductContentDelegate() {
  const rows: Row[] = []
  return {
    rows,
    findUnique: async ({ where }: { where: { productId: string } }) =>
      rows.find((row) => row.productId === where.productId) ?? null,
    upsert: async ({ where, create, update }: { where: { productId: string }; create: Row; update: Row }) => {
      const row = rows.find((candidate) => candidate.productId === where.productId)
      if (row) {
        Object.assign(row, update)
        return row
      }
      const created = { id: `content-${rows.length + 1}`, ...create }
      rows.push(created)
      return created
    },
  }
}
