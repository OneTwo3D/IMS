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
const mintsoft = { code: null as string | null, pushes: [] as Array<{ code: string | null; clears: string[] }>, onClearPost: null as null | (() => Promise<void>) }

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
