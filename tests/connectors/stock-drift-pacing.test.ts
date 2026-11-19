import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

mock.module('@/lib/db', { namedExports: { db: {} } })
mock.module('@/lib/connectors/woocommerce/api', { namedExports: { wcFetch: async () => ({ data: [], totalPages: 1 }) } })

test('the catalogue read is PACED: a pause before every storefront request after the first (pages and per-product variation reads alike)', async () => {
  const { readWcCatalogueStock } = await import('@/lib/connectors/woocommerce/stock-drift')
  const at: number[] = []
  const get = async (path: string, params: Record<string, string>) => {
    at.push(Date.now())
    if (path === '/products') return { data: params.page === '1' ? [{ id: 1, type: 'variable', manage_stock: false }] : [{ id: 2, type: 'simple', manage_stock: true, stock_quantity: 3 }], totalPages: 2 }
    return { data: [{ id: 11, manage_stock: true, stock_quantity: 4 }], totalPages: 1 }
  }
  const rows = await readWcCatalogueStock(get, 40)
  assert.equal(rows.length, 2)
  assert.equal(at.length, 3)
  for (let i = 1; i < at.length; i += 1) assert.ok(at[i]! - at[i - 1]! >= 35, `read ${i} came ${at[i]! - at[i - 1]!} ms after the one before`)
})
