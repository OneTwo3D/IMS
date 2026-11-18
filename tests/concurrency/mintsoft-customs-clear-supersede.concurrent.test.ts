import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * THE LOST-REFILL INTERLEAVING, against a real PostgreSQL (scratch database) and a fake Mintsoft with real state.
 *
 * Run A (a cron sweep) plans a commodity-code clear. While A's slow clear request is in flight, the editor refills the code and run
 * B pushes the refilled value to Mintsoft; THEN A's request lands and blanks it. A finds its marker gone at the recheck. Whatever
 * hash either run stores, Mintsoft must end holding the refilled value: A recovers by pushing the product's CURRENT values from a
 * fresh read as a full upsert, which is the last write at Mintsoft, and stores the hash of that payload.
 */
const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'

type Row = Record<string, unknown>
const mintsoft = { code: null as string | null, pushes: [] as Array<{ code: string | null; clears: string[] }>, onClearPost: null as null | (() => Promise<void>), mode: 'land' as 'land' | 'refuse' | 'timeout' }

function remoteRaw(sku: string): Row {
  return {
    ProductId: 42, SKU: sku, CustomsDescription: '',
    CommodityCode: mintsoft.code ? { Code: mintsoft.code } : null,
    CountryOfManufacture: { Code: 'CN' }, CountryOfManufactureId: 1,
  }
}

mock.module('../../lib/connectors/mintsoft/producer-seam.ts', {
  namedExports: { mintsoftProducerSeam: async () => ({ proceed: true, clearance: {} }) },
})

async function load() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const { db } = await import('@/lib/db')
  const client = await import('@/lib/connectors/mintsoft/api/client')
  const sync = await import('@/lib/connectors/mintsoft/sync/product-sync')
  const connector = {
    async fetchProduct() { return null },
    async fetchProductBySku(sku: string) { return { externalId: '42', sku, barcode: null, raw: remoteRaw(sku) } },
    async upsertProduct(dto: Row, options: Row) {
      const push = { code: (dto.commodityCode as string | null) ?? null, clears: [] as string[] }
      // an ordinary upsert writes the code when IMS has one and leaves Mintsoft's alone when it has none
      if (dto.commodityCode) mintsoft.code = dto.commodityCode as string
      let clearOutcome
      const fields = (options.clearFields as Array<'commodityCode'> | undefined) ?? []
      if (fields.length) {
        push.clears = [...fields]
        clearOutcome = await client.sendMintsoftProductClears(dto as never, fields, options as never, {
          post: async (_path: string, init: { body: string }) => {
            // the request is slow: other things happen before it lands
            if (mintsoft.onClearPost) await mintsoft.onClearPost()
            if (mintsoft.mode === 'refuse') return { data: { Success: false, Message: 'refused' } }
            if (mintsoft.mode === 'timeout') return { data: null, error: 'The operation was aborted due to timeout' }
            if (JSON.parse(init.body).CommodityCode?.Code === '') mintsoft.code = null
            return { data: { Success: true, Message: 'ok' } }
          },
          readBack: async () => remoteRaw(dto.sku as string),
        })
      }
      mintsoft.pushes.push(push)
      return { externalId: '42', sku: dto.sku as string, barcode: null, raw: remoteRaw(dto.sku as string), ...(clearOutcome ? { clearOutcome } : {}) }
    },
  }
  return { db, sync, connector }
}

const X = '85011099'

test('B pushes the refilled code between A\'s send and A\'s recheck: Mintsoft still ends with the refilled code', { skip }, async () => {
  const { db, sync, connector } = await load()
  const warehouse = await db.warehouse.create({ data: { code: `SUP${randomUUID().slice(0, 8)}`, name: 'Supersede probe' } })
  const product = await db.product.create({ data: { sku: `SUP-${randomUUID()}`, name: 'Supersede probe', hsCode: X, countryOfOrigin: 'CN' } })
  try {
    await db.wmsProductLink.create({ data: { productId: product.id, connector: 'mintsoft', externalProductId: '42', payloadHash: 'old' } })
    await db.product.update({ where: { id: product.id }, data: { hsCode: null } })
    mintsoft.code = X // Mintsoft still holds the code IMS emptied
    mintsoft.pushes.length = 0
    mintsoft.onClearPost = async () => {
      // the editor refills, and run B pushes it, all before A's request lands
      await db.product.update({ where: { id: product.id }, data: { hsCode: X } })
      mintsoft.code = X
      mintsoft.pushes.push({ code: X, clears: [] })
      await db.wmsProductLink.updateMany({ where: { productId: product.id }, data: { payloadHash: 'run-B-hash' } })
    }
    const candidate = await sync.getProductSyncCandidate(product.id)
    assert.equal(candidate?.customsClears?.length, 1)
    const result = await sync.syncOneMintsoftProduct({
      product: candidate!,
      scopes: [{ warehouseId: warehouse.id, warehouseCode: warehouse.code }],
      connector: connector as never,
    })
    assert.equal(result.remoteUpdated, true)
    assert.equal(mintsoft.code, X, 'Mintsoft ends with the refilled value')
    const last = mintsoft.pushes[mintsoft.pushes.length - 1]
    assert.equal(last.code, X, 'the LAST write at Mintsoft is the full upsert of the current values')
    assert.deepEqual(last.clears, [], 'and it carries no clear')
    const link = await db.wmsProductLink.findFirstOrThrow({ where: { productId: product.id } })
    assert.ok(link.payloadHash && !link.payloadHash.endsWith(':clear-pending'), 'the stored hash is the fresh payload\'s, whatever run B wrote')
    assert.notEqual(link.payloadHash, 'run-B-hash')
    assert.equal(await db.productCustomsClear.count({ where: { productId: product.id } }), 0)
  } finally {
    mintsoft.onClearPost = null
    await db.wmsMutationEvent.deleteMany({ where: { entityId: product.id } })
    await db.wmsStockDiscrepancy.deleteMany({ where: { productId: product.id } })
    await db.product.delete({ where: { id: product.id } })
    await db.warehouse.delete({ where: { id: warehouse.id } })
  }
})

async function runOnce(db: Awaited<ReturnType<typeof load>>['db'], sync: Awaited<ReturnType<typeof load>>['sync'], connector: unknown, productId: string, warehouse: { id: string; code: string }) {
  const candidate = await sync.getProductSyncCandidate(productId)
  await sync.syncOneMintsoftProduct({ product: candidate!, scopes: [{ warehouseId: warehouse.id, warehouseCode: warehouse.code }], connector: connector as never })
}

test('a clear Mintsoft keeps ANSWERING no (Success:false) reaches the cap of 5 and opens the manual discrepancy; no clear is sent after', { skip }, async () => {
  const { db, sync, connector } = await load()
  const warehouse = await db.warehouse.create({ data: { code: `CAP${randomUUID().slice(0, 8)}`, name: 'Cap probe' } })
  const product = await db.product.create({ data: { sku: `CAP-${randomUUID()}`, name: 'Cap probe', hsCode: X, countryOfOrigin: 'CN' } })
  try {
    await db.wmsProductLink.create({ data: { productId: product.id, connector: 'mintsoft', externalProductId: '42', payloadHash: 'old' } })
    await db.product.update({ where: { id: product.id }, data: { hsCode: null } })
    mintsoft.code = X
    mintsoft.mode = 'refuse'
    mintsoft.pushes.length = 0
    for (let run = 0; run < sync.CUSTOMS_CLEAR_MAX_ATTEMPTS; run += 1) await runOnce(db, sync, connector, product.id, warehouse)
    assert.equal(mintsoft.pushes.filter((p) => p.clears.length).length, sync.CUSTOMS_CLEAR_MAX_ATTEMPTS)
    const marker = await db.productCustomsClear.findFirstOrThrow({ where: { productId: product.id } })
    assert.equal(marker.attempts, sync.CUSTOMS_CLEAR_MAX_ATTEMPTS)
    await runOnce(db, sync, connector, product.id, warehouse)
    assert.equal(mintsoft.pushes.filter((p) => p.clears.length).length, sync.CUSTOMS_CLEAR_MAX_ATTEMPTS, 'no sixth clear request')
    const open = await db.wmsStockDiscrepancy.findMany({ where: { productId: product.id, category: 'CUSTOMS_CLEAR_MANUAL', status: 'OPEN' } })
    assert.equal(open.length, 1)
    assert.match(open[0].wmsValue ?? '', /commodity code/)
  } finally {
    mintsoft.mode = 'land'
    await db.wmsMutationEvent.deleteMany({ where: { entityId: product.id } })
    await db.wmsStockDiscrepancy.deleteMany({ where: { productId: product.id } })
    await db.product.delete({ where: { id: product.id } })
    await db.warehouse.delete({ where: { id: warehouse.id } })
  }
})

test('unanswered clears (timeouts) spend the separate cap of 20 and then also open the discrepancy', { skip }, async () => {
  const { db, sync, connector } = await load()
  const warehouse = await db.warehouse.create({ data: { code: `UNV${randomUUID().slice(0, 8)}`, name: 'Unverified probe' } })
  const product = await db.product.create({ data: { sku: `UNV-${randomUUID()}`, name: 'Unverified probe', hsCode: X, countryOfOrigin: 'CN' } })
  try {
    await db.wmsProductLink.create({ data: { productId: product.id, connector: 'mintsoft', externalProductId: '42', payloadHash: 'old' } })
    await db.product.update({ where: { id: product.id }, data: { hsCode: null } })
    mintsoft.code = X
    mintsoft.mode = 'timeout'
    mintsoft.pushes.length = 0
    await runOnce(db, sync, connector, product.id, warehouse)
    let marker = await db.productCustomsClear.findFirstOrThrow({ where: { productId: product.id } })
    assert.equal(marker.attempts, 0, 'a timeout is not an answer')
    assert.equal(marker.unverifiedAttempts, 1)
    // five more timeouts still send (the answered cap is untouched)
    for (let run = 0; run < 5; run += 1) await runOnce(db, sync, connector, product.id, warehouse)
    assert.equal(mintsoft.pushes.filter((p) => p.clears.length).length, 6)
    await db.productCustomsClear.updateMany({ where: { productId: product.id }, data: { unverifiedAttempts: sync.CUSTOMS_CLEAR_MAX_UNVERIFIED_ATTEMPTS - 1 } })
    await runOnce(db, sync, connector, product.id, warehouse)
    marker = await db.productCustomsClear.findFirstOrThrow({ where: { productId: product.id } })
    assert.equal(marker.unverifiedAttempts, sync.CUSTOMS_CLEAR_MAX_UNVERIFIED_ATTEMPTS)
    await runOnce(db, sync, connector, product.id, warehouse)
    assert.equal(mintsoft.pushes.filter((p) => p.clears.length).length, 7, 'no clear once the cap is spent')
    const open = await db.wmsStockDiscrepancy.findMany({ where: { productId: product.id, category: 'CUSTOMS_CLEAR_MANUAL', status: 'OPEN' } })
    assert.equal(open.length, 1)
  } finally {
    mintsoft.mode = 'land'
    await db.wmsMutationEvent.deleteMany({ where: { entityId: product.id } })
    await db.wmsStockDiscrepancy.deleteMany({ where: { productId: product.id } })
    await db.product.delete({ where: { id: product.id } })
    await db.warehouse.delete({ where: { id: warehouse.id } })
  }
})
