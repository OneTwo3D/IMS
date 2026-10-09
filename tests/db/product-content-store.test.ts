import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import { applyIncomingProductContent } from '../../lib/domain/product-content/store'
import { normalizeImageRefs } from '../../lib/domain/product-content/snapshot'

/**
 * PRODUCT CONTENT STORAGE AGAINST A REAL DATABASE.
 *
 * The fakes in tests/ prove the rules; what they cannot show is that the migration made the schema they assume: the
 * product_contents table with one row per product, the cascade, the JSON picture column, the nullable
 * contentSyncState column on wms_product_links, and the new `shadow` value on wms_sync_logs.action. Every arm runs in
 * a transaction that is ROLLED BACK, ALWAYS, with fixtures unique per run.
 *
 * GATED on RUN_DB_RETENTION_TESTS with the REQUIRE_DB_RETENTION_TESTS tripwire (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1: tests/db/product-content-store.test.ts would have been skipped.')
}

class RollbackProbe extends Error {}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any

async function getDb() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  return (await import('../../lib/db')).db
}

async function withRollback<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const db = await getDb()
  let captured: T | undefined
  try {
    await db.$transaction(async (tx: unknown) => {
      captured = await fn(tx as Tx)
      throw new RollbackProbe()
    }, { timeout: 60_000, maxWait: 30_000 })
  } catch (error) {
    if (!(error instanceof RollbackProbe)) throw error
  }
  return captured as T
}

const incoming = (short: string | null, long: string | null, urls: string[]) => ({
  shortDescription: short,
  longDescription: long,
  images: normalizeImageRefs(urls.map((src, index) => ({ id: index + 1, src }))),
})

test('content is stored once per product, changed field by field, and an empty source keeps the stored value', { skip }, async () => {
  const outcome = await withRollback(async (tx: Tx) => {
    const sku = `CONTENT-${randomUUID()}`
    const product = await tx.product.create({ data: { sku, name: 'Content fixture' }, select: { id: true } })

    const first = await applyIncomingProductContent(tx, { productId: product.id, incoming: incoming('Short', 'Long', ['https://shop.example.test/a.jpg']), sourceModifiedAt: new Date('2026-10-01T09:00:00Z') })
    const stored1 = await tx.productContent.findUnique({ where: { productId: product.id } })

    const same = await applyIncomingProductContent(tx, { productId: product.id, incoming: incoming('Short', 'Long', ['https://shop.example.test/a.jpg']) })
    const stored2 = await tx.productContent.findUnique({ where: { productId: product.id } })

    const moved = await applyIncomingProductContent(tx, { productId: product.id, incoming: incoming('Short v2', null, []) })
    const stored3 = await tx.productContent.findUnique({ where: { productId: product.id } })

    const rows = await tx.productContent.count({ where: { productId: product.id } })
    return { first, stored1, same, stored2, moved, stored3, rows }
  })
  console.log(`precondition: created=${outcome.first.created} changed=${outcome.first.changed.join(',')}; identical re-apply changed=${outcome.same.changed.length}; partial apply changed=${outcome.moved.changed.join(',')} kept=${outcome.moved.keptDespiteEmpty.join(',')}`)
  assert.equal(outcome.first.created, true)
  assert.deepEqual(outcome.first.changed, ['shortDescription', 'longDescription', 'images'])
  assert.equal(outcome.stored1.sourceSystem, 'woocommerce')
  assert.equal((outcome.stored1.images as Array<{ url: string; checksum: string }>)[0]!.url, 'https://shop.example.test/a.jpg')
  assert.equal(outcome.stored1.sourceModifiedAt.toISOString(), '2026-10-01T09:00:00.000Z')
  assert.deepEqual(outcome.same.changed, [])
  assert.equal(outcome.stored2.updatedAt.getTime(), outcome.stored1.updatedAt.getTime(), 'an identical re-apply writes nothing')
  assert.deepEqual(outcome.moved.changed, ['shortDescription'])
  assert.equal(outcome.stored3.shortDescription, 'Short v2')
  assert.equal(outcome.stored3.longDescription, 'Long', 'the field the source sent empty is kept')
  assert.equal((outcome.stored3.images as unknown[]).length, 1)
  assert.equal(outcome.rows, 1, 'one row per product')
})

test('the schema from the migration: cascade on product delete, the link state column and the shadow log action exist', { skip }, async () => {
  const outcome = await withRollback(async (tx: Tx) => {
    const sku = `CONTENT-${randomUUID()}`
    const product = await tx.product.create({ data: { sku, name: 'Content fixture' }, select: { id: true } })
    await applyIncomingProductContent(tx, { productId: product.id, incoming: incoming('S', null, []) })
    const link = await tx.wmsProductLink.create({
      data: { productId: product.id, connector: 'mintsoft', externalProductId: `ext-${randomUUID()}`, contentSyncState: { pushed: {}, shadowed: { description: 'h' } } },
      select: { id: true, contentSyncState: true },
    })
    const job = await tx.wmsSyncJob.create({ data: { connector: 'mintsoft', type: 'PRODUCT_SYNC', status: 'SUCCEEDED', startedAt: new Date() }, select: { id: true } })
    const log = await tx.wmsSyncLog.create({ data: { jobId: job.id, sku, productId: product.id, action: 'shadow', reason: 'fixture' }, select: { action: true } })
    const before = await tx.productContent.count({ where: { productId: product.id } })
    await tx.wmsProductLink.deleteMany({ where: { productId: product.id } })
    await tx.wmsSyncLog.deleteMany({ where: { productId: product.id } })
    await tx.product.delete({ where: { id: product.id } })
    const after = await tx.productContent.count({ where: { productId: product.id } })
    return { link, log, before, after }
  })
  console.log(`precondition: content rows before delete=${outcome.before}, after=${outcome.after}; log action=${outcome.log.action}`)
  assert.equal(outcome.before, 1)
  assert.equal(outcome.after, 0, 'deleting the product removes its content (ON DELETE CASCADE)')
  assert.equal(outcome.log.action, 'shadow')
  assert.deepEqual(outcome.link.contentSyncState, { pushed: {}, shadowed: { description: 'h' } })
})
