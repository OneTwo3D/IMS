import assert from 'node:assert/strict'
import test from 'node:test'
import * as productSyncNs from '../lib/connectors/mintsoft/sync/product-sync.ts'

const productSync = 'default' in productSyncNs
  ? productSyncNs.default as typeof import('../lib/connectors/mintsoft/sync/product-sync.ts')
  : productSyncNs

/**
 * o3d-hqvrp.122: a product renamed in IMS must not become a second Mintsoft product. The lookup reports the rename
 * (link points at a Mintsoft product with the old SKU, nothing under the new one) so the sync raises a discrepancy and
 * creates nothing. Fully mocked connector: no network.
 */
function context(links: Array<{ externalProductId: string }>, remote: Record<string, { externalId: string; sku: string }>) {
  const calls: string[] = []
  return {
    calls,
    ctx: {
      product: { id: 'p1', sku: 'ABC-01', wmsProductLinks: links },
      connector: {
        fetchProduct: async (id: string) => { calls.push(`id:${id}`); return Object.values(remote).find((r) => r.externalId === id) ?? null },
        fetchProductBySku: async (sku: string) => { calls.push(`sku:${sku}`); return remote[sku] ?? null },
      },
    } as never,
  }
}

test('a renamed SKU with no Mintsoft product under the new SKU is reported as a rename, not left to create', async () => {
  const { ctx } = context([{ externalProductId: '77' }], { 'ABC-1': { externalId: '77', sku: 'ABC-1' } })
  const found = await productSync.fetchAuthoritativeMintsoftProduct(ctx)
  assert.equal(found.product, null)
  assert.deepEqual(found.renamedFrom, { externalProductId: '77', sku: 'ABC-1' })
})

test('once the warehouse renamed the product, the new SKU resolves and there is no rename', async () => {
  const { ctx } = context([{ externalProductId: '77' }], { 'ABC-01': { externalId: '77', sku: 'ABC-01' } })
  const found = await productSync.fetchAuthoritativeMintsoftProduct(ctx)
  assert.equal(found.product?.externalId, '77')
  assert.equal(found.renamedFrom, null)
})

test('a never-linked product and a link to a deleted Mintsoft product are not renames', async () => {
  const unlinked = context([], {})
  assert.equal((await productSync.fetchAuthoritativeMintsoftProduct(unlinked.ctx)).renamedFrom, null)
  const gone = context([{ externalProductId: '77' }], {})
  assert.equal((await productSync.fetchAuthoritativeMintsoftProduct(gone.ctx)).renamedFrom, null)
})
