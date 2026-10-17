import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { OUTBOUND_GRANT_ENV } from '../lib/security/outbound-write-hold-constants.ts'
import { PRODUCER_CUTOFF_ENV, PRODUCER_HOLD_ENFORCED_ENV } from '../lib/security/producer-disposition-constants.ts'

/**
 * THE MINTSOFT PRODUCT, BUNDLE, CONTENT AND ASN WRITERS UNDER THE PRODUCER-SIDE HOLD.
 *
 * Each writer is driven through its real entry point with the switch OFF (the legacy behaviour: the control that proves the doubles
 * can see a write) and ON with no grant (nothing may be sent and no state may change). The database is a recording fake whose
 * shadow store counts records; the connector is a double that records its calls and the clearance each received. Mintsoft is LIVE
 * and is never contacted (tests/no-outbound-network.cjs fails the file if anything tried to leave the box).
 *
 * Named mutations (shown red in the PR, restored from a copy, md5-verified):
 *  a  upsert-stamps-a-shadow    the product writer stamps the payload hash for a shadowed upsert: the "no link write" arm goes red
 *  b  bundle-claims-first       the bundle writer takes its claim slot before asking: the "no claim row" arm goes red
 *  c  asn-reserves-first        the ASN button creates its sync job before asking: the "no job" arm goes red
 *  d  content-ignores-switch    the content writer ignores the enforcement switch: the "enforced, no grant" arm still shadows but the
 *                               "enforced for another destination" arm hands out a clearance it should not have needed
 */

const ORIGIN = 'https://wms.example.test'
const ENV_KEYS = [PRODUCER_HOLD_ENFORCED_ENV, OUTBOUND_GRANT_ENV.mintsoft, PRODUCER_CUTOFF_ENV.mintsoft]
const ON = { [PRODUCER_HOLD_ENFORCED_ENV]: 'mintsoft' }

function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of ENV_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(values)) if (value !== undefined) process.env[key] = value
  return fn().finally(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

// ───────────────────────── a recording database ─────────────────────────

const calls: string[] = []
const shadows: Array<{ operation: string; subjectId: string }> = []
const WRITE_METHODS = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'])
const productRow = {
  id: 'p-1', sku: 'SKU-1', name: 'Widget', barcode: null, hsCode: null, countryOfOrigin: 'GB', customsDescription: 'Widget', weight: null,
  widthCm: null, heightCm: null, depthCm: null, imageUrl: null, type: 'SIMPLE', lifecycleStatus: 'ACTIVE', content: null,
  wmsProductLinks: [] as Array<Record<string, unknown>>,
}
const kitRow = {
  id: 'k-1', sku: 'KIT-1', name: 'Kit', type: 'KIT', lifecycleStatus: 'ACTIVE',
  productComponents: [{ qty: 2, component: { id: 'c-1', sku: 'COMP-1', wmsProductLinks: [{ externalProductId: 'ext-c1' }] } }],
  wmsProductLinks: [{ externalProductId: 'ext-k1' }],
  wmsBundleLinks: [] as Array<Record<string, unknown>>,
}

function modelProxy(name: string) {
  return new Proxy({}, {
    get: (_target, method: string) => async () => {
      calls.push(`${name}.${method}`)
      if (name === 'externalWmsBinding' && method === 'findMany') return [{ warehouseId: 'wh-1', bundleSyncDirection: 'IMS_TO_WMS', warehouse: { code: 'WH1' } }]
      if (name === 'product' && method === 'findUnique') return productFixture
      if (name === 'product' && method === 'count') return 1
      switch (method) {
        case 'findMany': return []
        case 'findUnique': case 'findFirst': return null
        case 'count': return 0
        case 'updateMany': case 'deleteMany': return { count: 1 }
        case 'create': return { id: `${name}-1` }
        default: return {}
      }
    },
  })
}
let productFixture: unknown = productRow
const fakeDb: object = new Proxy({}, {
  get: (_target, prop: string) => {
    if (prop === 'then') return undefined
    if (prop === '$queryRaw') {
      return async (query: { strings?: readonly string[]; values?: readonly unknown[] }) => {
        const text = (query.strings ?? []).join('?')
        if (!text.includes('outbound_shadow_writes')) return []
        const values = query.values ?? []
        shadows.push({ operation: String(values[1]), subjectId: String(values[3]) })
        return [{ id: `shadow-${shadows.length}`, inserted: true, occurrences: 1, accounting_sync_log_id: null, sync_row_exists: false }]
      }
    }
    if (prop === '$executeRaw') return async () => 1
    if (prop === '$executeRawUnsafe') return undefined
    if (prop === '$transaction') return async (fn: (tx: object) => unknown) => fn(fakeDb)
    return modelProxy(prop)
  },
})
mock.module('@/lib/db', { namedExports: { db: fakeDb } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined, logActivityPersisted: async () => true } })
mock.module('@/lib/domain/wms/mutation-audit', { namedExports: { recordWmsMutationEvent: async () => undefined } })

// ───────────────────────── a connector double ─────────────────────────

const connectorCalls: string[] = []
const clearances: unknown[] = []
const connectorDouble = {
  id: 'mintsoft',
  fetchProduct: async () => null,
  fetchProductBySku: async () => null,
  fetchBundle: async () => null,
  upsertProduct: async (dto: { sku: string }, _options: unknown, clearance: unknown) => {
    connectorCalls.push(`upsertProduct:${dto.sku}`); clearances.push(clearance)
    return { externalId: 'ext-new', sku: dto.sku, barcode: null, raw: {} }
  },
  createBundle: async (dto: { sku: string }, _options: unknown, clearance: unknown) => {
    connectorCalls.push(`createBundle:${dto.sku}`); clearances.push(clearance)
    return { externalBundleId: 'bundle-1', sku: dto.sku, name: null, components: [], raw: {} }
  },
  updateProductContent: async (_update: unknown, clearance: unknown) => {
    connectorCalls.push('updateProductContent'); clearances.push(clearance)
    return { sent: true as const }
  },
}
mock.module('@/lib/connectors/wms/registry', { namedExports: { getWmsConnector: () => connectorDouble } })

function reset() {
  calls.length = 0
  shadows.length = 0
  connectorCalls.length = 0
  clearances.length = 0
  productFixture = productRow
}
const writes = () => calls.filter((call) => WRITE_METHODS.has(call.split('.')[1] ?? ''))

// ───────────────────────── product upsert ─────────────────────────

test('PRODUCT UPSERT, OFF (the control): the product is sent with a clearance, the link is stamped, and the result has no `shadowed` key', async () => {
  const { runMintsoftProductSyncForProduct } = await import('../lib/connectors/mintsoft/sync/product-sync.ts')
  await withEnv({}, async () => {
    reset()
    const result = await runMintsoftProductSyncForProduct('p-1', 'manual')
    console.log(`# OFF: connector=${JSON.stringify(connectorCalls)} link writes=${JSON.stringify(calls.filter((c) => c.startsWith('wmsProductLink.')))} result=${JSON.stringify(result)}`)
    assert.deepEqual(connectorCalls, ['upsertProduct:SKU-1'])
    assert.ok(clearances.every((c) => c !== undefined && c !== null))
    assert.ok(calls.includes('wmsProductLink.upsert'), 'the link was stamped with the payload hash')
    assert.equal(result.corrected, 1)
    assert.equal('shadowed' in result, false, 'byte-identical result: the key is absent')
    assert.equal(shadows.length, 0)
  })
})

test('PRODUCT UPSERT, ON and no grant: nothing is sent, the link is not stamped (so the product is offered again), one shadow is kept, and the run says so', async () => {
  const { runMintsoftProductSyncForProduct } = await import('../lib/connectors/mintsoft/sync/product-sync.ts')
  await withEnv(ON, async () => {
    reset()
    const result = await runMintsoftProductSyncForProduct('p-1', 'manual')
    console.log(`# ON: connector=${JSON.stringify(connectorCalls)} link calls=${JSON.stringify(calls.filter((c) => c.startsWith('wmsProductLink.')))} shadows=${JSON.stringify(shadows)} result=${JSON.stringify(result)}`)
    assert.deepEqual(connectorCalls, [], 'no connector write of any kind')
    assert.equal(calls.filter((c) => c.startsWith('wmsProductLink.')).length, 0, 'no payload hash, no sync time, no link error: nothing to stop the next run offering it again')
    assert.equal(result.shadowed, 1)
    assert.equal(result.corrected, 0, 'a shadow is not an update')
    assert.equal(result.errors, 0, 'and not a failure')
    assert.deepEqual(shadows, [{ operation: 'product.upsert', subjectId: 'p-1' }])
    assert.ok(calls.includes('wmsSyncLog.createMany'), 'the run log still records the line, as a shadow')
  })
})

test('PRODUCT UPSERT: the verify button message says how many products were NOT sent, and says nothing when none were', async () => {
  const { describeShadowedProducts, describeShadowedBundles } = await import('../lib/connectors/mintsoft/operator-action-seam.ts')
  assert.equal(describeShadowedProducts(undefined), '')
  assert.equal(describeShadowedProducts(0), '')
  assert.match(describeShadowedProducts(3), /3 products NOT sent to Mintsoft: writes are held on this installation/)
  assert.match(describeShadowedProducts(1), /1 product NOT sent/)
  assert.equal(describeShadowedBundles(undefined), '')
  assert.match(describeShadowedBundles(2), /2 bundles NOT created in Mintsoft/)
})

// ───────────────────────── bundle create ─────────────────────────

test('BUNDLE CREATE, OFF (the control): the claim slot is taken, the bundle is created with a clearance', async () => {
  const { runBundleSyncForProduct } = await import('../lib/connectors/mintsoft/sync/bundle-sync.ts')
  await withEnv({}, async () => {
    reset()
    productFixture = kitRow
    const result = await runBundleSyncForProduct('k-1', 'manual')
    console.log(`# OFF bundle: ${JSON.stringify({ status: result.status, action: result.action })} connector=${JSON.stringify(connectorCalls)} writes=${JSON.stringify(writes())}`)
    assert.ok(calls.includes('wmsBundleLink.create'), 'the claim slot was taken before the request')
    assert.deepEqual(connectorCalls, ['createBundle:KIT-1'])
    assert.ok(clearances.every((c) => c !== undefined && c !== null))
    assert.equal(shadows.length, 0)
  })
})

test('BUNDLE CREATE, ON and no grant: the claim slot is NEVER taken (a shadow leaves no "a create may be on its way" trace), nothing is sent, one shadow is kept', async () => {
  const { runBundleSyncForProduct } = await import('../lib/connectors/mintsoft/sync/bundle-sync.ts')
  await withEnv(ON, async () => {
    reset()
    productFixture = kitRow
    const result = await runBundleSyncForProduct('k-1', 'manual')
    console.log(`# ON bundle: ${JSON.stringify({ status: result.status, action: result.action })} connector=${JSON.stringify(connectorCalls)} writes=${JSON.stringify(writes())} shadows=${JSON.stringify(shadows)}`)
    assert.equal(result.status, 'SKIPPED')
    assert.equal(result.action, 'shadowed')
    assert.match(result.reason, /^Not sent by IMS: writes to Mintsoft are held on this installation/)
    assert.deepEqual(connectorCalls, [])
    assert.equal(calls.filter((c) => c.startsWith('wmsBundleLink.')).length, 0, 'no claim row, no update, no delete')
    assert.deepEqual(shadows, [{ operation: 'product.bundle', subjectId: 'k-1' }])
  })
})

// ───────────────────────── product content ─────────────────────────

test('PRODUCT CONTENT: enforced and LIVE sends with a clearance; enforced and held is a shadow with no connector call; enforced for another destination changes nothing', async () => {
  const { syncMintsoftProductContent } = await import('../lib/connectors/mintsoft/sync/product-content-sync.ts')
  const { MINTSOFT_CONTENT_WIRE } = await import('../lib/connectors/mintsoft/api/product-content.ts')
  const verified = Object.fromEntries(Object.keys(MINTSOFT_CONTENT_WIRE).map((field) => [field, { verified: true }])) as never
  const content = { shortDescription: 'Short', longDescription: 'Long', images: [] } as never
  const link = { id: 'l-1', externalProductId: 'ext-1', contentSyncState: null }
  const run = async (env: Record<string, string>) => {
    reset()
    const saved: unknown[] = []
    const result = await syncMintsoftProductContent({
      product: { id: 'p-1', sku: 'SKU-1' }, link, content, connector: connectorDouble as never, context: { env }, wireContract: verified,
      saveState: async (_id, state) => { saved.push(state) },
    })
    return { result, saved }
  }
  const live = { [OUTBOUND_GRANT_ENV.mintsoft]: `${ORIGIN}|89`, [PRODUCER_CUTOFF_ENV.mintsoft]: '2020-01-01T00:00:00Z' }
  const unenforced = await run(live)
  assert.equal(unenforced.result.kind, 'sent', 'CONTROL: the decision is LIVE and the switch is off')
  assert.deepEqual(connectorCalls, ['updateProductContent'])
  assert.ok(clearances.every((c) => c !== undefined && c !== null))
  const enforcedLive = await run({ ...live, [PRODUCER_HOLD_ENFORCED_ENV]: 'mintsoft' })
  assert.equal(enforcedLive.result.kind, 'sent', 'enforced and LIVE: the seam agrees with the decision and clears the write')
  assert.deepEqual(connectorCalls, ['updateProductContent'])
  const enforcedHeld = await run({ [PRODUCER_HOLD_ENFORCED_ENV]: 'mintsoft' })
  assert.equal(enforcedHeld.result.kind, 'shadow')
  assert.deepEqual(connectorCalls, [], 'no connector call')
  assert.equal(enforcedHeld.saved.length, 1, 'the content state records the shadow so an unchanged value is not recorded again')
  const other = await run({ ...live, [PRODUCER_HOLD_ENFORCED_ENV]: 'xero' })
  assert.equal(other.result.kind, 'sent')
})

test('PRODUCT CONTENT: a decision that is LIVE but whose seam has been told otherwise (enforced, grant, future instant) is a shadow, never a send', async () => {
  const { syncMintsoftProductContent } = await import('../lib/connectors/mintsoft/sync/product-content-sync.ts')
  const { MINTSOFT_CONTENT_WIRE } = await import('../lib/connectors/mintsoft/api/product-content.ts')
  const verified = Object.fromEntries(Object.keys(MINTSOFT_CONTENT_WIRE).map((field) => [field, { verified: true }])) as never
  reset()
  const result = await syncMintsoftProductContent({
    product: { id: 'p-1', sku: 'SKU-1' },
    link: { id: 'l-1', externalProductId: 'ext-1', contentSyncState: null },
    content: { shortDescription: 'Short', longDescription: 'Long', images: [] } as never,
    connector: connectorDouble as never,
    context: { env: { [PRODUCER_HOLD_ENFORCED_ENV]: 'mintsoft', [OUTBOUND_GRANT_ENV.mintsoft]: `${ORIGIN}|89`, [PRODUCER_CUTOFF_ENV.mintsoft]: '2999-01-01T00:00:00Z' } },
    wireContract: verified,
    saveState: async () => undefined,
  })
  assert.equal(result.kind, 'shadow')
  assert.deepEqual(connectorCalls, [])
})
