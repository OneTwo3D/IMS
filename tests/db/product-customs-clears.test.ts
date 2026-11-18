import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * THE CUSTOMS CLEAR MARKER AGAINST A REAL DATABASE. A trigger on `products` records a populated -> empty change of
 * hsCode / countryOfOrigin / customsDescription in product_customs_clears (whatever wrote it: the editor, a CSV edit, the
 * WooCommerce import) and removes it when the field is populated again. A field that was never set records nothing.
 * Every arm runs in a transaction that is ROLLED BACK. GATED on RUN_DB_RETENTION_TESTS (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1: tests/db/product-customs-clears.test.ts would have been skipped.')
}

class RollbackProbe extends Error {}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any

async function withRollback(fn: (tx: Tx) => Promise<void>): Promise<void> {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('../../lib/db')
  try {
    await db.$transaction(async (tx: unknown) => {
      await fn(tx as Tx)
      throw new RollbackProbe()
    }, { timeout: 60_000, maxWait: 30_000 })
  } catch (error) {
    if (!(error instanceof RollbackProbe)) throw error
  }
}

const markers = async (tx: Tx, productId: string) =>
  (await tx.productCustomsClear.findMany({ where: { productId }, select: { field: true }, orderBy: { field: 'asc' } })).map((m: { field: string }) => m.field)

const make = (tx: Tx, data: Record<string, unknown>) =>
  tx.product.create({ data: { sku: `CLR-${randomUUID()}`, name: 'Clear probe', ...data } })

test('emptying a populated customs field records a marker; populating it again removes it', { skip }, async () => {
  await withRollback(async (tx) => {
    const p = await make(tx, { hsCode: '85011099', countryOfOrigin: 'CN', customsDescription: 'Motor' })
    assert.deepEqual(await markers(tx, p.id), [])
    await tx.product.update({ where: { id: p.id }, data: { countryOfOrigin: null } })
    assert.deepEqual(await markers(tx, p.id), ['countryOfOrigin'])
    await tx.product.update({ where: { id: p.id }, data: { hsCode: null, customsDescription: '  ' } })
    assert.deepEqual(await markers(tx, p.id), ['countryOfOrigin', 'customsDescription', 'hsCode'])
    await tx.product.update({ where: { id: p.id }, data: { countryOfOrigin: 'GB' } })
    assert.deepEqual(await markers(tx, p.id), ['customsDescription', 'hsCode'])
  })
})

test('a field that was never set records nothing, and an unrelated edit leaves markers alone', { skip }, async () => {
  await withRollback(async (tx) => {
    const p = await make(tx, { hsCode: '85011099' })
    await tx.product.update({ where: { id: p.id }, data: { countryOfOrigin: null, customsDescription: null, name: 'Renamed' } })
    assert.deepEqual(await markers(tx, p.id), [])
    await tx.product.update({ where: { id: p.id }, data: { hsCode: null } })
    await tx.product.update({ where: { id: p.id }, data: { name: 'Renamed again' } })
    assert.deepEqual(await markers(tx, p.id), ['hsCode'])
  })
})

test('WooCommerce import: an empty native value WITH the cleared-fields meta empties IMS and leaves a marker; WITHOUT it nothing changes', { skip }, async () => {
  const { extractWcCustomsFields } = await import('../../lib/connectors/woocommerce/sync/customs-fields')
  const { resolveWcTradeFieldUpdates } = await import('../../lib/connectors/woocommerce/sync/product-sync')
  await withRollback(async (tx) => {
    const p = await make(tx, { hsCode: '85011099', countryOfOrigin: 'CN', customsDescription: 'Motor' })
    const existing = { hsCode: p.hsCode, countryOfOrigin: p.countryOfOrigin, customsDescription: p.customsDescription }
    const apply = async (payload: Parameters<typeof extractWcCustomsFields>[0]) => {
      const c = extractWcCustomsFields(payload)
      const changes = resolveWcTradeFieldUpdates(existing, c, c.cleared)
      if (changes.length) await tx.product.update({ where: { id: p.id }, data: Object.fromEntries(changes.map((x) => [x.field, x.to])) })
      return changes
    }
    const empty = { customs_commodity_code: null, customs_country_of_origin: null, customs_description: null }
    assert.deepEqual(await apply(empty), [])
    assert.deepEqual(await markers(tx, p.id), [])
    const changes = await apply({ ...empty, meta_data: [{ key: '_customs_cleared_fields', value: { country_of_origin: '2026-11-18T10:00:00Z' } }] })
    assert.deepEqual(changes.map((c) => c.field), ['countryOfOrigin'])
    assert.deepEqual(await markers(tx, p.id), ['countryOfOrigin'])
    const row = await tx.product.findUniqueOrThrow({ where: { id: p.id } })
    assert.equal(row.countryOfOrigin, null)
    assert.equal(row.hsCode, '85011099')
  })
})
