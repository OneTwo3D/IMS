import assert from 'node:assert/strict'
import test, { mock } from 'node:test'


/**
 * o3d-mu0a: the GTIN/MPN identifier split on the Mintsoft side.
 *
 * The split changes what IMS WRITES to a live warehouse, so it sits behind `product_identifier_split_enabled`
 * (default off). The load-bearing claim of this file is that with the flag OFF the outbound payload, the options
 * handed to the connector and the product payload hash are exactly what they were before the split existed.
 */

type Row = Record<string, unknown>
const state = {
  flag: undefined as string | undefined,
  product: {} as Row,
  wmsRaw: null as Row | null,
  upserts: [] as Array<{ dto: Row; options: Row }>,
  seamPayloads: [] as Row[],
  productUpdates: [] as Row[],
  discrepancyCreates: [] as Row[],
}

const baseProduct = (over: Row): Row => ({
  id: 'prod-1', sku: 'SKU-1', name: 'Widget', barcode: null, mpn: null, hsCode: null, countryOfOrigin: null,
  customsDescription: null, weight: null, widthCm: null, heightCm: null, depthCm: null, imageUrl: null,
  type: 'SIMPLE', lifecycleStatus: 'ACTIVE', content: null,
  wmsProductLinks: [{
    id: 'link-1', externalProductId: '168', payloadHash: null, lastKnownBarcode: null, lastSyncedAt: null, lastError: null,
    contentSyncState: null,
  }],
  ...over,
})

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: {
        findUnique: async ({ where }: { where: { key: string } }) =>
          where.key === 'product_identifier_split_enabled' && state.flag !== undefined ? { value: state.flag } : null,
      },
      externalWmsBinding: { findMany: async () => [{ warehouseId: 'wh-1', warehouse: { code: 'MAIN' } }] },
      product: {
        findUnique: async () => state.product,
        findFirst: async () => null,
        update: async ({ data }: { data: Row }) => { state.productUpdates.push(data); return {} },
      },
      wmsSyncJob: { create: async () => ({ id: 'job-1' }), update: async () => ({}) },
      wmsSyncLog: { createMany: async ({ data }: { data: Row[] }) => ({ count: data.length }) },
      wmsProductLink: { upsert: async ({ create }: { create: Row }) => create, updateMany: async () => ({ count: 1 }), update: async () => ({}) },
      wmsStockDiscrepancy: {
        updateMany: async () => ({ count: 0 }),
        create: async ({ data }: { data: Row }) => { state.discrepancyCreates.push(data); return {} },
        createMany: async () => ({ count: 0 }),
      },
    },
  },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/domain/wms/mutation-audit', { namedExports: { recordWmsMutationEvent: async () => {} } })
mock.module('../lib/connectors/mintsoft/producer-seam.ts', {
  namedExports: {
    mintsoftProducerSeam: async (input: { operation: string; payload: Row }) => {
      if (input.operation !== 'product.upsert') return { proceed: false, shadowed: true, notice: 'skipped in test', reason: 'test', recorded: true, occurrences: 1 }
      state.seamPayloads.push(input.payload)
      return { proceed: true, clearance: {} }
    },
  },
})
mock.module('@/lib/connectors/wms/registry', {
  namedExports: {
    getWmsConnector: () => ({
      async fetchProduct() { return state.wmsRaw ? { externalId: '168', sku: 'SKU-1', barcode: null, raw: state.wmsRaw } : null },
      async fetchProductBySku() { return state.wmsRaw ? { externalId: '168', sku: 'SKU-1', barcode: null, raw: state.wmsRaw } : null },
      async upsertProduct(dto: Row, options: Row) {
        state.upserts.push({ dto, options })
        return { externalId: '168', sku: 'SKU-1', barcode: null, raw: {} }
      },
    }),
  },
})

function reset(over: { flag?: string; product?: Row; wms?: Row | null }) {
  state.flag = over.flag
  state.product = baseProduct(over.product ?? {})
  state.wmsRaw = over.wms === undefined ? { ProductId: 168, SKU: 'SKU-1' } : over.wms
  state.upserts.length = 0
  state.seamPayloads.length = 0
  state.productUpdates.length = 0
  state.discrepancyCreates.length = 0
}

// Loaded AFTER the mocks above: a static import would be hoisted above them and bind the real database.
async function loadModules() {
  const client = await import('@/lib/connectors/mintsoft/api/client')
  const normalizers = await import('@/lib/connectors/mintsoft/api/normalizers')
  const productSync = await import('@/lib/connectors/mintsoft/sync/product-sync')
  return {
    buildMintsoftProductUpsertRequest: client.buildMintsoftProductUpsertRequest,
    classifyMintsoftProductRecord: normalizers.classifyMintsoftProductRecord,
    buildMintsoftProductDto: productSync.buildMintsoftProductDto,
    hashMintsoftProductDto: productSync.hashMintsoftProductDto,
    resolveMintsoftIdentifierPlan: productSync.resolveMintsoftIdentifierPlan,
  }
}

async function run() {
  const mod = await import('@/lib/connectors/mintsoft/sync/product-sync')
  return mod.runMintsoftProductSyncForProduct('prod-1', 'test')
}

const GTIN = '4006381333931'

test('flag OFF: a part number in Product.barcode is pushed exactly as before, and nothing identifier-split leaks into any outbound shape', async () => {
  const { buildMintsoftProductUpsertRequest } = await loadModules()
  // Even with an mpn on the product: with the flag off IMS neither reads it nor sends it.
  reset({ product: { barcode: 'LN00000287', mpn: 'LN00000282' } })
  await run()

  assert.equal(state.upserts.length, 1)
  const { dto, options } = state.upserts[0]!
  assert.equal(dto.barcode, 'LN00000287')
  assert.equal('mpn' in dto, false, 'the dto has no mpn key, so the payload hash cannot move')
  assert.deepEqual(options, { externalProductId: '168', omitBarcode: false }, 'no omitMpn key')
  assert.deepEqual(Object.keys(state.seamPayloads[0]!).sort(), ['externalProductId', 'omitBarcode', 'product'])

  const request = buildMintsoftProductUpsertRequest(dto as never, options as never)
  assert.equal(
    request.body,
    '{"ID":168,"SKU":"SKU-1","Name":"Widget","EAN":"LN00000287","CountryOfManufacture":{"Code":"CN"}}',
    'EAN = barcode and no UPC, byte for byte',
  )
  assert.equal(state.productUpdates.length, 0, 'nothing is backfilled into IMS')
})

test('flag OFF with any non-true value reads as off', async () => {
  for (const value of ['false', '', 'TRUE', '1', 'yes', ' true']) {
    reset({ flag: value, product: { barcode: 'LN00000287', mpn: 'LN00000282' } })
    await run()
    assert.equal('mpn' in state.upserts[0]!.dto, false, `flag value ${JSON.stringify(value)}`)
  }
})

test('flag OFF: the product payload hash is the legacy hash (no mpn key in the hashed object)', async () => {
  const { buildMintsoftProductDto, hashMintsoftProductDto } = await loadModules()
  const dto = buildMintsoftProductDto({
    id: 'p', sku: 'S', name: 'N', barcode: 'LN1', mpn: 'LN2', hsCode: null, countryOfOrigin: null, customsDescription: null,
    weight: null, widthCm: null, heightCm: null, depthCm: null, imageUrl: null, type: 'SIMPLE', lifecycleStatus: 'ACTIVE', wmsProductLinks: [],
  } as never)
  assert.equal('mpn' in dto, false)
  assert.equal(
    hashMintsoftProductDto(dto),
    hashMintsoftProductDto({ ...dto }),
  )
})

test('client: UPC is written only when the dto carries an mpn and omitMpn is not set', async () => {
  const { buildMintsoftProductUpsertRequest } = await loadModules()
  const dto = { sku: 'S', name: 'N', customsDescription: null, barcode: GTIN, mpn: 'LN00000282', commodityCode: null, countryOfManufacture: null, weightKg: null, heightCm: null, widthCm: null, depthCm: null, imageUrl: null }
  assert.equal(buildMintsoftProductUpsertRequest(dto).body, `{"SKU":"S","Name":"N","EAN":"${GTIN}","UPC":"LN00000282"}`)
  assert.equal(buildMintsoftProductUpsertRequest(dto, { omitMpn: true }).body, `{"SKU":"S","Name":"N","EAN":"${GTIN}"}`)
  assert.equal(buildMintsoftProductUpsertRequest(dto, { omitBarcode: true }).body, '{"SKU":"S","Name":"N","UPC":"LN00000282"}')
  const legacy: Record<string, unknown> = { ...dto }
  delete legacy.mpn
  assert.equal(buildMintsoftProductUpsertRequest(legacy as typeof dto).body, `{"SKU":"S","Name":"N","EAN":"${GTIN}"}`)
})

test('flag ON: the GTIN goes to EAN and the part number to UPC, classified by shape', async () => {
  const { buildMintsoftProductUpsertRequest } = await loadModules()
  // Stored the wrong way round on purpose: Product.barcode holds the part number, Product.mpn the GTIN.
  reset({ flag: 'true', product: { barcode: 'LN00000287', mpn: GTIN } })
  await run()

  const { dto, options } = state.upserts[0]!
  assert.equal(dto.barcode, GTIN)
  assert.equal(dto.mpn, 'LN00000287')
  assert.deepEqual(options, { externalProductId: '168', omitBarcode: false, omitMpn: false })
  assert.equal(
    buildMintsoftProductUpsertRequest(dto as never, options as never).body,
    `{"ID":168,"SKU":"SKU-1","Name":"Widget","EAN":"${GTIN}","UPC":"LN00000287","CountryOfManufacture":{"Code":"CN"}}`,
  )
})

test('flag ON: a zero-padded counter in barcode is an MPN and never reaches EAN', async () => {
  reset({ flag: 'true', product: { barcode: '00000287', mpn: null } })
  await run()
  const { dto, options } = state.upserts[0]!
  assert.equal(dto.barcode, null)
  assert.equal(dto.mpn, '00000287')
  assert.equal(options.omitBarcode, true)
  assert.equal(options.omitMpn, false)
})

test('flag ON: bead example SKU 74928122361-04 (EAN=LN00000059, UPC=LN00000282) classifies the UPC as the MPN, reports the EAN as a leftover, and backfills nothing while it is open', async () => {
  reset({ flag: 'true', product: {}, wms: { ProductId: 168, SKU: 'SKU-1', EAN: 'LN00000059', UPC: 'LN00000282' } })
  await run()

  assert.deepEqual(state.productUpdates, [], 'no backfill while a leftover is open')
  const conflict = state.discrepancyCreates.find((row) => row.category === 'BARCODE_CONFLICT')
  assert.ok(conflict, 'the leftover is raised through the BARCODE_CONFLICT discrepancy')
  assert.match(String(conflict.message), /unplaced LN00000059/)
  assert.match(String(conflict.wmsValue), /MPN LN00000282/)
  const { options } = state.upserts[0]!
  assert.equal(options.omitBarcode, true, 'nothing is written to either Mintsoft field while a leftover is open')
  assert.equal(options.omitMpn, true)
})

test('flag ON: a GTIN conflict holds BOTH Mintsoft fields (the other write could overwrite the code in conflict)', async () => {
  reset({ flag: 'true', product: { barcode: GTIN, mpn: 'LN00000282' }, wms: { ProductId: 168, SKU: 'SKU-1', UPC: '036000291452' } })
  await run()
  const { options } = state.upserts[0]!
  assert.equal(options.omitBarcode, true)
  assert.equal(options.omitMpn, true)
  assert.ok(state.discrepancyCreates.some((row) => row.category === 'BARCODE_CONFLICT'))
})

test('flag ON: a GTIN held by Mintsoft in UPC is backfilled and then written to its canonical field, EAN', async () => {
  reset({ flag: 'true', product: {}, wms: { ProductId: 168, SKU: 'SKU-1', UPC: GTIN } })
  await run()
  assert.deepEqual(state.productUpdates, [{ barcode: GTIN }])
  const { dto, options } = state.upserts[0]!
  assert.equal(dto.barcode, GTIN)
  assert.equal(options.omitBarcode, false)
  assert.equal(options.omitMpn, true)
})

test('classifyMintsoftProductRecord reads every spelling of the EAN and UPC keys', async () => {
  const { classifyMintsoftProductRecord } = await loadModules()
  assert.deepEqual(classifyMintsoftProductRecord({ EAN: GTIN, UPC: 'LN1' }), { gtin: GTIN, mpn: 'LN1', leftover: '' })
  assert.deepEqual(classifyMintsoftProductRecord({ ean: GTIN, upc: 'LN1' }), { gtin: GTIN, mpn: 'LN1', leftover: '' })
  assert.deepEqual(classifyMintsoftProductRecord({ Barcode: GTIN }), { gtin: GTIN, mpn: '', leftover: '' })
  assert.deepEqual(classifyMintsoftProductRecord({ EANCode: 'LN9' }), { gtin: '', mpn: 'LN9', leftover: '' })
  assert.deepEqual(classifyMintsoftProductRecord({ EAN: 4006381333931 }), { gtin: GTIN, mpn: '', leftover: '' })
  assert.deepEqual(classifyMintsoftProductRecord(null), { gtin: '', mpn: '', leftover: '' })
  assert.deepEqual(classifyMintsoftProductRecord({}), { gtin: '', mpn: '', leftover: '' })
})

test('resolveMintsoftIdentifierPlan: per-slot state machine, GTIN-13/14 as one code, leftover as conflict', async () => {
  const { resolveMintsoftIdentifierPlan } = await loadModules()
  const none = { gtin: '', mpn: '', leftover: '' }
  const plan = resolveMintsoftIdentifierPlan
  assert.equal(plan(none, none).kind, 'noop')
  assert.equal(plan({ gtin: GTIN, mpn: '', leftover: '' }, none).kind, 'fill_wms_barcode')
  assert.equal(plan(none, { gtin: GTIN, mpn: '', leftover: '' }).kind, 'backfill')
  assert.equal(plan({ gtin: GTIN, mpn: 'A', leftover: '' }, { gtin: GTIN, mpn: 'A', leftover: '' }).kind, 'match')
  assert.equal(plan({ gtin: GTIN, mpn: '', leftover: '' }, { gtin: '036000291452', mpn: '', leftover: '' }).kind, 'conflict')
  assert.equal(plan({ gtin: '', mpn: 'A', leftover: '' }, { gtin: '', mpn: 'B', leftover: '' }).kind, 'conflict')
  assert.equal(plan({ gtin: '6975415158407', mpn: '', leftover: '' }, { gtin: '06975415158407', mpn: '', leftover: '' }).kind, 'match', '13 and 14 are one code')
  const withLeftover = plan(none, { gtin: '', mpn: 'B', leftover: 'A' })
  assert.equal(withLeftover.kind, 'conflict')
  assert.deepEqual(withLeftover.leftover, { ims: '', wms: 'A' })
  assert.equal(plan({ gtin: '', mpn: '', leftover: 'X' }, none).kind, 'conflict')
  // mixed: GTIN to backfill, MPN to push
  const mixed = plan({ gtin: '', mpn: 'A', leftover: '' }, { gtin: GTIN, mpn: '', leftover: '' })
  assert.equal(mixed.kind, 'fill_wms_barcode')
  assert.equal(mixed.omitBarcode, false)
  assert.equal(mixed.omitMpn, false)
})

test('flag ON: part number A in barcode, Mintsoft EAN a GTIN and UPC a different part number B: nothing is backfilled, A survives', async () => {
  reset({ flag: 'true', product: { barcode: 'LN00000059', mpn: null }, wms: { ProductId: 168, SKU: 'SKU-1', EAN: GTIN, UPC: 'LN00000282' } })
  await run()
  assert.deepEqual(state.productUpdates, [], 'no backfill while the plan conflicts')
  assert.ok(state.discrepancyCreates.some((row) => row.category === 'BARCODE_CONFLICT'))
  const { options } = state.upserts[0]!
  assert.equal(options.omitBarcode, true)
  assert.equal(options.omitMpn, true)
})

test('flag ON: a GTIN backfill over a part number in Product.barcode moves that part number to mpn in the same update', async () => {
  reset({ flag: 'true', product: { barcode: 'LN00000059', mpn: null }, wms: { ProductId: 168, SKU: 'SKU-1', EAN: GTIN } })
  await run()
  assert.deepEqual(state.productUpdates, [{ barcode: GTIN, mpn: 'LN00000059' }])
  const { dto } = state.upserts[0]!
  assert.equal(dto.barcode, GTIN)
  assert.equal(dto.mpn, 'LN00000059')
})
