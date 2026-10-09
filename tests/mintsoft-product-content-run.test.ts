import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { normalizeImageRefs } from '../lib/domain/product-content/snapshot.ts'
import { producerDisposition } from '../lib/security/producer-disposition.ts'

/**
 * THE PRODUCT VERIFY RUN WITH THE CONTENT STEP, ON FAKES: what an operator's run does when IMS is not the live writer.
 *
 * Drives runMintsoftProductSyncForProduct end to end against a recording database and a recording connector. The
 * claim: with no outbound-write grant in the environment, the content step records a `shadow` sync-log row and the
 * job summary says so, and the connector's content method is NEVER called. The product-meta upsert is the existing
 * path and is allowed to run on the fake; it is not what is being proved.
 *
 * Named mutations (each shown red in the PR, restored from a copy, md5-verified):
 *  m6  skip-disposition  (shared with tests/mintsoft-product-content.test.ts)
 *  m18 chunk-drops-content  processMintsoftProductChunk does not log the content outcome
 *  m19 content-error-hidden a content failure is swallowed instead of counted and logged
 */

type Row = Record<string, unknown>
const state = {
  logs: [] as Row[],
  jobUpdates: [] as Row[],
  activity: [] as Row[],
  contentCalls: [] as Row[],
  metaUpserts: 0,
  failContentWith: null as string | null,
}

const PRODUCT = {
  id: 'prod-1', sku: 'SKU-1', name: 'Widget', barcode: null, hsCode: null, countryOfOrigin: null, customsDescription: null,
  weight: null, widthCm: null, heightCm: null, depthCm: null, imageUrl: null, type: 'SIMPLE', lifecycleStatus: 'ACTIVE',
  content: {
    shortDescription: 'Short copy', longDescription: 'Long copy',
    images: normalizeImageRefs([{ id: 1, src: 'https://shop.example.test/p.jpg' }]),
  },
  wmsProductLinks: [{
    id: 'link-1', externalProductId: '168', payloadHash: null, lastKnownBarcode: null, lastSyncedAt: null, lastError: null,
    contentSyncState: null,
  }],
}

const linkWrites: Row[] = []

mock.module('@/lib/db', {
  namedExports: {
    db: {
      externalWmsBinding: { findMany: async () => [{ warehouseId: 'wh-1', warehouse: { code: 'MAIN' } }] },
      product: { findUnique: async () => PRODUCT },
      wmsSyncJob: {
        create: async () => ({ id: 'job-1' }),
        update: async ({ data }: { data: Row }) => { state.jobUpdates.push(data); return {} },
      },
      wmsSyncLog: { createMany: async ({ data }: { data: Row[] }) => { state.logs.push(...data); return { count: data.length } } },
      wmsProductLink: {
        upsert: async ({ create }: { create: Row }) => { state.metaUpserts += 1; return create },
        updateMany: async () => ({ count: 1 }),
        update: async ({ data }: { data: Row }) => { linkWrites.push(data); return {} },
      },
      wmsStockDiscrepancy: { updateMany: async () => ({ count: 0 }), create: async () => ({}), createMany: async () => ({ count: 0 }) },
    },
  },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async (entry: Row) => { state.activity.push(entry) } } })
mock.module('@/lib/domain/wms/mutation-audit', { namedExports: { recordWmsMutationEvent: async () => {} } })
mock.module('@/lib/connectors/wms/registry', {
  namedExports: {
    getWmsConnector: () => ({
      async fetchProduct() { return { externalId: '168', sku: 'SKU-1', barcode: null, raw: {} } },
      async fetchProductBySku() { return { externalId: '168', sku: 'SKU-1', barcode: null, raw: {} } },
      async upsertProduct() { return { externalId: '168', sku: 'SKU-1', barcode: null, raw: {} } },
      async updateProductContent(update: Row) {
        state.contentCalls.push(update)
        if (state.failContentWith) throw new Error(state.failContentWith)
        return { sent: true }
      },
    }),
  },
})

async function run() {
  const mod = await import('@/lib/connectors/mintsoft/sync/product-sync')
  return mod.runMintsoftProductSyncForProduct('prod-1', 'test')
}

function reset() {
  state.logs.length = 0
  state.jobUpdates.length = 0
  state.activity.length = 0
  state.contentCalls.length = 0
  state.metaUpserts = 0
  state.failContentWith = null
  linkWrites.length = 0
}

test('no grant in the environment: the run shadows the content, calls nothing, and says so in the log, summary and activity', async () => {
  reset()
  const disposition = producerDisposition('mintsoft', 'product.content')
  console.log(`precondition: process environment disposition=${disposition}; product has 3 content fields and a Mintsoft link`)
  assert.equal(disposition, 'SHADOW', 'the test must run with no Mintsoft grant in the environment')

  const result = await run()

  assert.equal(result.status, 'SUCCEEDED')
  assert.equal(state.metaUpserts > 0, true, 'the meta path ran (existing behaviour, on the fake)')
  assert.equal(state.contentCalls.length, 0, 'the connector content method was never called')
  const shadow = state.logs.filter((row) => row.action === 'shadow')
  console.log(`precondition reached: sync-log rows=${state.logs.length} shadow rows=${shadow.length} content counters=${JSON.stringify(result.content)}`)
  assert.equal(shadow.length, 1)
  assert.match(String(shadow[0]!.reason), /NOT sent \(recorded only\)/)
  assert.deepEqual(result.content, { sent: 0, shadowed: 1, held: 0, errors: 0 })
  const summary = state.jobUpdates.at(-1)!.summary as Row
  assert.deepEqual(summary.content, { sent: 0, shadowed: 1, held: 0, errors: 0 })
  assert.deepEqual((linkWrites.at(-1)!.contentSyncState as { pushed: object }).pushed, {}, 'nothing is recorded as pushed')
  assert.match(String(state.activity.at(-1)!.description), /recorded but NOT sent/)
})

test('a content failure is its own error line and counted; the meta result is not undone', async () => {
  reset()
  // The run uses the real environment (no grant, so SHADOW): there is no connector call to fail, so the failure is
  // injected where the shadow is recorded, the content step's own state save.
  const { db } = await import('@/lib/db')
  const original = db.wmsProductLink.update
  ;(db.wmsProductLink as unknown as { update: unknown }).update = async () => { throw new Error('state save failed') }
  try {
    const result = await run()
    console.log(`precondition: the content state save throws; run status=${result.status} errors=${result.errors} content=${JSON.stringify(result.content)}`)
    assert.equal(result.status, 'PARTIAL')
    assert.equal(result.content?.errors, 1)
    const errorRow = state.logs.find((row) => row.action === 'error')
    assert.ok(errorRow, 'an error row is logged')
    assert.match(String(errorRow.reason), /Content sync failed: state save failed/)
    assert.equal(state.metaUpserts > 0, true, 'the meta step still completed')
  } finally {
    ;(db.wmsProductLink as unknown as { update: unknown }).update = original
  }
})
