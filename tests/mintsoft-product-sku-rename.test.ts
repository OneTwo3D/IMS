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

// o3d-zz37l: an operator's Ignore suppresses only that rename OCCURRENCE.
type Row = { id: string; connector?: string; warehouseId: string; productId: string; category: string; status: string; imsValue: string | null; wmsValue: string | null; resolvedNote?: string }
function fakeDiscrepancies(rows: Row[]) {
  const matches = (row: Row, where: Record<string, unknown>) => Object.entries(where).every(([key, want]) => {
    const have = (row as Record<string, unknown>)[key]
    return want && typeof want === 'object' && 'in' in (want as object) ? ((want as { in: unknown[] }).in).includes(have) : have === want
  })
  return {
    wmsStockDiscrepancy: {
      findFirst: async (args: { where: Record<string, unknown> }) => rows.find((row) => matches(row, args.where)) ?? null,
      updateMany: async (args: { where: Record<string, unknown>; data: Partial<Row> }) => {
        const hit = rows.filter((row) => matches(row, args.where))
        for (const row of hit) Object.assign(row, args.data)
        return { count: hit.length }
      },
    },
  } as never
}
const rename = (over: Partial<Row>): Row => ({ id: 'r1', connector: 'mintsoft', warehouseId: 'wh-1', productId: 'p1', category: 'PRODUCT_SKU_RENAMED', status: 'OPEN', imsValue: 'B', wmsValue: 'A', ...over })
const pair = (ims: string, wms: string) => ({ productId: 'p1', category: 'PRODUCT_SKU_RENAMED' as const, imsValue: ims, wmsValue: wms })

test('an ignored rename suppresses the same pair, supersedes a stale OPEN row of another pair, and nothing else', async () => {
  const ignored = rename({ status: 'IGNORED' })
  const stale = rename({ id: 'r2', imsValue: 'C' })
  const rows = [ignored, stale]
  const client = fakeDiscrepancies(rows)
  assert.equal(await productSync.suppressIgnoredRename(client, 'wh-1', pair('B', 'A')), true)
  assert.equal(stale.status, 'RESOLVED', 'the stale OPEN row no longer holds orders')
  assert.equal(await productSync.suppressIgnoredRename(client, 'wh-1', pair('D', 'A')), false, 'another pair is a different rename')
  assert.equal(await productSync.suppressIgnoredRename(client, 'wh-2', pair('B', 'A')), false, 'another warehouse')
})

test('a later genuine rename to the same pair is NOT suppressed once the episode ended (renamed back)', async () => {
  const ignored = rename({ status: 'IGNORED' })
  const client = fakeDiscrepancies([ignored])
  assert.equal(await productSync.suppressIgnoredRename(client, 'wh-1', pair('B', 'A')), true)
  await productSync.retireIgnoredRenames(client, ['wh-1'], 'p1') // the SKUs match again: the no-rename branch
  assert.equal(ignored.status, 'RESOLVED')
  assert.equal(await productSync.suppressIgnoredRename(client, 'wh-1', pair('B', 'A')), false, 'the next A->B is a fresh occurrence: a new OPEN row is created')
})

test('retiring ignored renames touches only that product\'s IGNORED rename rows', async () => {
  const other = rename({ id: 'x', productId: 'p2', status: 'IGNORED' })
  const open = rename({ id: 'y' })
  await productSync.retireIgnoredRenames(fakeDiscrepancies([other, open]), ['wh-1'], 'p1')
  assert.equal(other.status, 'IGNORED')
  assert.equal(open.status, 'OPEN')
})

test('archiving (the ineligible branch) leaves the rename row OPEN: the order-push hold still applies', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../lib/connectors/mintsoft/sync/product-sync.ts', import.meta.url), 'utf8')
  const start = source.indexOf('if (!isMintsoftProductEligible(context.product)) {')
  const block = source.slice(start, source.indexOf('const existingLink', start))
  assert.ok(block.length > 0)
  assert.doesNotMatch(block, /resolveProductDiscrepancy\([^)]*PRODUCT_SKU_RENAMED/)
})
