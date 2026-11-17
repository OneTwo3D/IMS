import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-zvec.20: Mintsoft product sync parity (fitted names, CostPrice, parent inheritance).
 *
 * Mintsoft is LIVE, so every changed outbound behaviour sits behind `mintsoft_product_parity_enabled` (default off). The load-bearing
 * claim of this file is that with the setting OFF the product payload, its hash and the options handed to the connector are exactly
 * what they were before the setting existed, and that nothing about cost is even READ. With it ON each behaviour is proven, and the
 * cost is shown not to reach any log. No test here (or the code under test) can reach Mintsoft: the connector is a fake and the
 * suite runs under tests/no-outbound-network.cjs.
 */

type Row = Record<string, unknown>
const state = {
  flags: {} as Record<string, string>,
  product: {} as Row,
  upserts: [] as Array<{ dto: Row; options: Row }>,
  seamPayloads: [] as Row[],
  costLayerReads: 0,
  componentReads: 0,
  layers: [] as Row[],
  components: [] as Row[],
  syncLogs: [] as Row[],
  activities: [] as unknown[],
  mutationEvents: [] as unknown[],
  linkWrites: [] as Row[],
  echo: {} as Row,
  shadow: false,
}

const PARENT = 'Mandala Rose Works FireThorn Flex Plate with ThornGrip Textured PEI'

const baseProduct = (over: Row): Row => ({
  id: 'prod-1', sku: 'SKU-1', name: 'Widget', barcode: null, mpn: null, hsCode: null, countryOfOrigin: null,
  customsDescription: null, weight: null, widthCm: null, heightCm: null, depthCm: null, imageUrl: null,
  type: 'SIMPLE', lifecycleStatus: 'ACTIVE', content: null, parent: null,
  wmsProductLinks: [{ id: 'link-1', externalProductId: '168', payloadHash: null, lastKnownBarcode: null, lastSyncedAt: null, lastError: null, contentSyncState: null }],
  ...over,
})

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: { findUnique: async ({ where }: { where: { key: string } }) => (where.key in state.flags ? { value: state.flags[where.key] } : null) },
      externalWmsBinding: { findMany: async () => [{ warehouseId: 'wh-1', warehouse: { code: 'MAIN' } }] },
      product: { findUnique: async () => state.product, findFirst: async () => null, update: async () => ({}), updateMany: async () => ({ count: 1 }) },
      costLayer: { findMany: async () => { state.costLayerReads += 1; return state.layers } },
      productComponent: { findMany: async () => { state.componentReads += 1; return state.components } },
      wmsSyncJob: { create: async () => ({ id: 'job-1' }), update: async () => ({}) },
      wmsSyncLog: { createMany: async ({ data }: { data: Row[] }) => { state.syncLogs.push(...data); return { count: data.length } } },
      wmsProductLink: { upsert: async (args: Row) => { state.linkWrites.push(args); return {} }, updateMany: async () => ({ count: 1 }), update: async () => ({}) },
      wmsStockDiscrepancy: { updateMany: async () => ({ count: 0 }), create: async () => ({}), createMany: async () => ({ count: 0 }) },
    },
  },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async (entry: unknown) => { state.activities.push(entry) } } })
mock.module('@/lib/domain/wms/mutation-audit', { namedExports: { recordWmsMutationEvent: async (event: unknown) => { state.mutationEvents.push(event) } } })
mock.module('../lib/connectors/mintsoft/producer-seam.ts', {
  namedExports: {
    mintsoftProducerSeam: async (input: { operation: string; payload: Row }) => {
      if (state.shadow || input.operation !== 'product.upsert') return { proceed: false, shadowed: true, notice: 'skipped in test', reason: 'test', recorded: true, occurrences: 1 }
      state.seamPayloads.push(input.payload)
      return { proceed: true, clearance: {} }
    },
  },
})
mock.module('@/lib/connectors/wms/registry', {
  namedExports: {
    getWmsConnector: () => ({
      async fetchProduct() { return { externalId: '168', sku: 'SKU-1', barcode: null, raw: { ProductId: 168, SKU: 'SKU-1' } } },
      async fetchProductBySku() { return { externalId: '168', sku: 'SKU-1', barcode: null, raw: { ProductId: 168, SKU: 'SKU-1' } } },
      async upsertProduct(dto: Row, options: Row) {
        state.upserts.push({ dto, options })
        return { externalId: '168', sku: 'SKU-1', barcode: null, raw: { ID: 168, SKU: 'SKU-1', ...state.echo } }
      },
    }),
  },
})

function reset(over: { flags?: Record<string, string>; product?: Row; layers?: Row[]; components?: Row[]; echo?: Row }) {
  state.flags = over.flags ?? {}
  state.product = baseProduct(over.product ?? {})
  state.layers = over.layers ?? []
  state.components = over.components ?? []
  state.echo = over.echo ?? {}
  state.shadow = false
  state.upserts.length = 0
  state.seamPayloads.length = 0
  state.costLayerReads = 0
  state.componentReads = 0
  state.syncLogs.length = 0
  state.activities.length = 0
  state.mutationEvents.length = 0
  state.linkWrites.length = 0
}

async function loadModules() {
  const client = await import('@/lib/connectors/mintsoft/api/client')
  const productSync = await import('@/lib/connectors/mintsoft/sync/product-sync')
  const parity = await import('@/lib/connectors/mintsoft/sync/product-parity')
  return { client, productSync, parity }
}

async function run() {
  const mod = await import('@/lib/connectors/mintsoft/sync/product-sync')
  return mod.runMintsoftProductSyncForProduct('prod-1', 'test')
}

const VARIANT_OVER: Row = {
  type: 'VARIANT',
  sku: 'SKU-1',
  name: `${PARENT} — Voron 2.4/Trident 350 (355 x 355mm)`,
  weight: null, widthCm: null, heightCm: '12.5', depthCm: null,
  parent: { name: PARENT, weight: '1.2500', widthCm: '30.00', heightCm: '99.00', depthCm: '20.00' },
}
const LAYERS = [
  { remainingQty: '10', unitCostBase: '2.000000' },
  { remainingQty: '30', unitCostBase: '4.000000' },
]

test('flag OFF (absent): payload, hash and options are byte-identical to before; cost is not even read', async () => {
  const { client, productSync } = await loadModules()
  reset({ product: VARIANT_OVER, layers: LAYERS })
  await run()

  assert.equal(state.upserts.length, 1)
  const { dto, options } = state.upserts[0]!
  // Exactly what buildMintsoftProductDto produced before the setting existed.
  const expectedDto = productSync.buildMintsoftProductDto(state.product as never)
  assert.deepEqual(dto, expectedDto)
  assert.equal(productSync.hashMintsoftProductDto(dto as never), productSync.hashMintsoftProductDto(expectedDto), 'the payload hash cannot move')
  assert.equal('costPrice' in dto, false, 'no costPrice key')
  assert.deepEqual(options, { externalProductId: '168', omitBarcode: true }, 'no barcode on either side: the existing noop plan; no omitMpn key')
  assert.deepEqual(Object.keys(state.seamPayloads[0]!).sort(), ['externalProductId', 'omitBarcode', 'product'])
  assert.equal(dto.name, VARIANT_OVER.name, 'the unfitted name, even though it is over 99 characters')
  assert.ok(String(dto.name).length > 99)
  assert.equal(dto.weightKg, null, 'no inheritance of weight')
  assert.equal(dto.widthCm, null)
  assert.equal(dto.heightCm, 12.5, 'its own value')

  const request = client.buildMintsoftProductUpsertRequest(dto as never, options as never)
  assert.equal(
    request.body,
    `{"ID":168,"SKU":"SKU-1","Name":${JSON.stringify(VARIANT_OVER.name)},"Height":12.5,"CountryOfManufacture":{"Code":"CN"}}`,
    'byte for byte: no CostPrice, no inherited Weight/Width/Depth, name uncut',
  )
  assert.equal(state.costLayerReads + state.componentReads, 0, 'cost layers are not read while the setting is off')
})

test('flag OFF with any non-true value reads as off', async () => {
  for (const value of ['false', '', 'TRUE', '1', 'yes', ' true']) {
    reset({ flags: { mintsoft_product_parity_enabled: value }, product: VARIANT_OVER, layers: LAYERS })
    await run()
    const { dto } = state.upserts[0]!
    assert.equal('costPrice' in dto, false, `value ${JSON.stringify(value)}`)
    assert.equal(dto.name, VARIANT_OVER.name)
    assert.equal(state.costLayerReads, 0)
  }
})

test('flag ON: the name is fitted to 99, cut at a word boundary, the variant suffix kept whole', async () => {
  reset({ flags: { mintsoft_product_parity_enabled: 'true' }, product: VARIANT_OVER, layers: LAYERS })
  await run()
  const name = String(state.upserts[0]!.dto.name)
  assert.ok(name.length <= 99, name)
  assert.equal(name, 'Mandala Rose Works FireThorn Flex Plate with ThornGrip... — Voron 2.4/Trident 350 (355 x 355mm)')
})

test('flag ON: CostPrice is the IMS weighted average cost, to four places, and appears in the request body', async () => {
  const { client } = await loadModules()
  reset({ flags: { mintsoft_product_parity_enabled: 'true' }, product: VARIANT_OVER, layers: LAYERS })
  await run()
  const { dto, options } = state.upserts[0]!
  assert.equal(dto.costPrice, 3.5, '(10 x 2 + 30 x 4) / 40')
  const body = JSON.parse(client.buildMintsoftProductUpsertRequest(dto as never, options as never).body) as Row
  assert.equal(body.CostPrice, 3.5)
})

test('flag ON: no cost layers (or a zero cost) means no CostPrice key at all', async () => {
  reset({ flags: { mintsoft_product_parity_enabled: 'true' }, product: VARIANT_OVER, layers: [] })
  await run()
  assert.equal('costPrice' in state.upserts[0]!.dto, false)
  reset({ flags: { mintsoft_product_parity_enabled: 'true' }, product: VARIANT_OVER, layers: [{ remainingQty: '5', unitCostBase: '0' }] })
  await run()
  assert.equal('costPrice' in state.upserts[0]!.dto, false)
})

test('cost: a KIT costs its components (quantity x each component\'s average); decimals do not drift', async () => {
  const { parity } = await loadModules()
  assert.equal(parity.componentsUnitCost([
    { qty: '2', layers: [{ remainingQty: '1', unitCostBase: '0.1' }, { remainingQty: '2', unitCostBase: '0.2' }] },
    { qty: '1', layers: [{ remainingQty: '3', unitCostBase: '0.3' }] },
  ])?.toFixed(6), '0.633333', '2 x (0.5/3) + 0.3: the average is exact decimal arithmetic, not float')
  assert.equal(parity.componentsUnitCost([{ qty: '1', layers: [] }]), null)
  assert.equal(parity.weightedAverageUnitCost([{ remainingQty: '0', unitCostBase: '9' }]), null)

  reset({ flags: { mintsoft_product_parity_enabled: 'true' }, product: { type: 'KIT' }, components: [{ qty: '2', component: { costLayers: LAYERS } }] })
  await run()
  assert.equal(state.upserts[0]!.dto.costPrice, 7, '2 x 3.5')
  assert.equal(state.componentReads, 1)
})

test('flag ON: a variation inherits the parent weight and dimensions per field where its own are missing, and keeps its own', async () => {
  reset({ flags: { mintsoft_product_parity_enabled: 'true' }, product: VARIANT_OVER })
  await run()
  const { dto } = state.upserts[0]!
  assert.equal(dto.weightKg, 1.25, 'inherited')
  assert.equal(dto.widthCm, 30, 'inherited')
  assert.equal(dto.depthCm, 20, 'inherited')
  assert.equal(dto.heightCm, 12.5, 'its own value is kept, not the parent\'s 99')
})

test('inheritance applies to a VARIANT only: a simple product with a (stale) parent link inherits nothing; zero is a value, not missing', async () => {
  const { parity } = await loadModules()
  const dto = { sku: 'S', name: 'N', customsDescription: null, barcode: null, commodityCode: null, countryOfManufacture: 'CN', weightKg: 0, heightCm: null, widthCm: null, depthCm: null, imageUrl: null }
  const parent = { name: 'P', weight: '3', widthCm: '4', heightCm: '5', depthCm: '6' }
  const simple = parity.applyMintsoftProductParity(dto, { sku: 'S', name: 'N', type: 'SIMPLE', parent }, null)
  assert.equal(simple.widthCm, null)
  const variant = parity.applyMintsoftProductParity(dto, { sku: 'S', name: 'N', type: 'VARIANT', parent }, null)
  assert.equal(variant.weightKg, 0, 'a recorded zero is the variation\'s own value')
  assert.equal(variant.widthCm, 4)
  assert.equal('costPrice' in variant, false)
})

test('cost is never logged: not in the sync log payload, the activity log, the audit events or the seam payload digest keys', async () => {
  reset({
    flags: { mintsoft_product_parity_enabled: 'true' },
    product: VARIANT_OVER,
    layers: LAYERS,
    echo: { CostPrice: 3.5, Name: 'echo' },
  })
  const consoleCalls: unknown[] = []
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => mock.method(console, m, (...args: unknown[]) => { consoleCalls.push(args) }))
  try {
    await run()
  } finally {
    spies.forEach((s) => s.mock.restore())
  }
  assert.ok(state.syncLogs.length > 0)
  const logged = JSON.stringify([state.syncLogs, state.activities, state.mutationEvents, consoleCalls])
  assert.equal(logged.includes('CostPrice'), false, 'the Mintsoft echo is redacted before it is kept in the sync log')
  assert.equal(/\b3\.5\b/.test(logged), false, 'the cost figure appears in no log')
  // The link keeps the Mintsoft echo (the stored ref the dry run compares with); it is not a log.
  assert.ok(JSON.stringify(state.linkWrites).includes('CostPrice'))
})

test('with the setting OFF the sync log keeps the echo exactly as before (redaction is a parity-only change)', async () => {
  reset({ product: VARIANT_OVER, echo: { CostPrice: 3.5 } })
  await run()
  assert.ok(JSON.stringify(state.syncLogs).includes('CostPrice'))
})

test('metadata confirmation (parent-deletion proof): a LIVE upsert stamps the link with the run id; a shadowed one writes no link at all', async () => {
  reset({ product: VARIANT_OVER })
  await run()
  const live = state.linkWrites.at(-1) as { create: { metadata: Row } }
  assert.deepEqual((live.create.metadata as Row)._imsMetadataConfirmed, { runId: 'job-1' })

  reset({ product: VARIANT_OVER })
  state.shadow = true
  await run()
  assert.equal(state.upserts.length, 0)
  assert.equal(JSON.stringify(state.linkWrites).includes('_imsMetadataConfirmed'), false, 'a shadow confirms nothing')
})
