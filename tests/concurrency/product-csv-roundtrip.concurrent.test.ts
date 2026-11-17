import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * Edit by CSV against a real Postgres: the set-based UPDATE ... FROM (VALUES ...) the unit tests only read as text.
 * Proves a blank cell and an absent column leave the stored value alone, the clear token nulls only nullable fields,
 * decimals and the lifecycle -> active derivation land correctly, rows the file did not name are untouched, and a
 * batch that violates a constraint rolls back whole.
 */
test(
  'product CSV round trip writes exactly the changed fields',
  { skip: process.env.RUN_DB_CONCURRENCY_TESTS !== '1' },
  async () => {
    config({ path: '.env.local', quiet: true })
    config({ quiet: true })
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')

    const { db } = await import('../../lib/db/index.ts')
    const { runProductCsvEdit } = await import('../../lib/products/csv-roundtrip/run.ts')
    const { createProductCsvStore } = await import('../../lib/products/csv-roundtrip/store.ts')

    const tag = `csvrt-${process.pid}-${Math.floor(performance.now())}`
    const sup = await db.supplier.create({ data: { name: `${tag} Supplier` } })
    const cat = await db.productCategory.create({ data: { name: `${tag}Cat`, nameNormalized: `${tag}cat`.toLowerCase() } })
    const mk = (n: string, extra: Record<string, unknown> = {}) =>
      db.product.create({ data: { sku: `${tag}-${n}`, name: `Name ${n}`, description: `Desc ${n}`, weight: '0.5', salesPriceBase: '9.99', ...extra } })
    const a = await mk('A', { mpn: 'M-A', preferredSupplierId: sup.id, categoryId: cat.id, barcode: `${tag}-bc` })
    const b = await mk('B')
    const bystander = await mk('C')
    const store = createProductCsvStore(db)
    const can = () => true

    try {
      const file = [
        'sku,name,description,mpn,weight,salesPriceBase,preferredSupplierName,category,lifecycleStatus,oversellAllowed',
        `${a.sku},Renamed A,,__CLEAR__,1.25,,__CLEAR__,__CLEAR__,archived,false`,
        `${b.sku},,,,,12.5,${sup.name},${cat.name},,`,
      ].join('\n')
      const result = await runProductCsvEdit({ mode: 'apply', text: file, canUse: can, store })
      assert.deepEqual(result.errors, [])
      assert.equal(result.written, 2)

      const [ra, rb, rc] = await Promise.all([a, b, bystander].map((p) => db.product.findUniqueOrThrow({ where: { id: p.id } })))
      assert.equal(ra.name, 'Renamed A')
      assert.equal(ra.description, `Desc A`, 'blank description is unchanged')
      assert.equal(ra.mpn, null, 'token cleared mpn')
      assert.equal(String(ra.weight), '1.25')
      assert.equal(String(ra.salesPriceBase), '9.99', 'blank price unchanged')
      assert.equal(ra.preferredSupplierId, null)
      assert.equal(ra.categoryId, null)
      assert.equal(ra.lifecycleStatus, 'ARCHIVED')
      assert.equal(ra.active, false)
      assert.equal(ra.oversellAllowed, false)
      assert.equal(ra.barcode, `${tag}-bc`, 'absent column untouched')
      assert.ok(ra.updatedAt > a.updatedAt)

      assert.equal(rb.name, 'Name B')
      assert.equal(String(rb.salesPriceBase), '12.5')
      assert.equal(rb.preferredSupplierId, sup.id)
      assert.ok(rb.preferredSupplierUpdatedAt)
      assert.equal(rb.categoryId, cat.id)
      assert.equal(rb.active, true)

      assert.equal(rc.updatedAt.getTime(), bystander.updatedAt.getTime(), 'a product the file did not name is untouched')

      // A batch that violates a constraint (duplicate barcode, raced past the preflight) rolls back whole.
      const before = await db.product.findUniqueOrThrow({ where: { id: b.id } })
      await assert.rejects(store.writeBatch([
        { id: b.id, sku: b.sku, expectedUpdatedAt: before.updatedAt, changes: [{ column: 'name', label: 'Name', field: 'name', from: '', to: 'X', value: 'X' }] },
        { id: bystander.id, sku: bystander.sku, expectedUpdatedAt: bystander.updatedAt, changes: [{ column: 'barcode', label: 'Barcode', field: 'barcode', from: '', to: `${tag}-bc`, value: `${tag}-bc` }] },
      ], [{ key: 'name', label: 'Name', group: 'Basics', kind: 'text', nullable: false, requires: null, field: 'name' }, { key: 'barcode', label: 'Barcode', group: 'Identifiers', kind: 'text', nullable: true, requires: null, field: 'barcode' }]))
      assert.equal((await db.product.findUniqueOrThrow({ where: { id: b.id } })).name, before.name)

      // The version guard: a row whose updatedAt moved on since the plan read it is skipped, not overwritten.
      const fresh = await db.product.findUniqueOrThrow({ where: { id: b.id } })
      const outcome = await store.writeBatch([
        { id: b.id, sku: b.sku, expectedUpdatedAt: new Date(fresh.updatedAt.getTime() - 5_000), changes: [{ column: 'name', label: 'Name', field: 'name', from: '', to: 'Stale', value: 'Stale' }] },
      ], [{ key: 'name', label: 'Name', group: 'Basics', kind: 'text', nullable: false, requires: null, field: 'name' }])
      assert.deepEqual(outcome, { written: 0, staleIds: [b.id] })
      assert.equal((await db.product.findUniqueOrThrow({ where: { id: b.id } })).name, before.name)
    } finally {
      await db.product.deleteMany({ where: { sku: { startsWith: tag } } })
      await db.productCategory.deleteMany({ where: { id: cat.id } })
      await db.supplier.deleteMany({ where: { id: sup.id } })
    }
  },
)
