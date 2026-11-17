import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-zvec.20: the bulk trade-data / country-of-origin CSV tools and the catalogue dry run.
 *
 * Proven: a dry run (the default) writes NOTHING and loads nothing it does not need; apply is refused without the explicit flag
 * AND the setting, before anything is read; apply writes per product by compare-and-set; the catalogue dry run is a pure comparison
 * (no db, no network) and hides cost. The suite runs under tests/no-outbound-network.cjs.
 */

type Row = Record<string, unknown>
const fakeDb: Row = {}
mock.module('@/lib/db', { namedExports: { db: fakeDb } })

const TRADE_CSV = [
  'SKU,customs description,EU 8 digit HS code',
  'A-1,Plastic cable clips,39269097',
  'A-2,Steel bolts,73181595',
  'A-3,Bad code,12345678',
  'A-4,,39269097',
  'A-1,Duplicate row,39269097',
  'NOPE,Not in IMS,39269097',
].join('\n')
const COO_CSV = ['SKU,coo', 'A-1,cn', 'A-2,Germany', 'A-3,ZZ', 'A-4,GB'].join('\n')

const state = { parity: false, loads: 0, applies: [] as Array<{ id: string | null; changes: unknown }>, applyOk: true }
const STATES = new Map<string, Row>([
  ['A-1', { id: 'p1', sku: 'A-1', hsCode: null, customsDescription: null, countryOfOrigin: 'CN', stored: null }],
  ['A-2', { id: 'p2', sku: 'A-2', hsCode: '73181595', customsDescription: 'Steel bolts', countryOfOrigin: 'DE', stored: { commodityCode: '73181595', customsDescription: 'Steel bolts', countryOfManufacture: 'DE' } }],
  ['A-4', { id: 'p4', sku: 'A-4', hsCode: null, customsDescription: null, countryOfOrigin: null, stored: null }],
])
const deps = {
  parityEnabled: async () => state.parity,
  loadStates: async () => { state.loads += 1; return STATES as never },
  applyOne: async (row: { productId: string | null }, changes: unknown) => { state.applies.push({ id: row.productId, changes }); return state.applyOk },
}
function reset(parity: boolean) { state.parity = parity; state.loads = 0; state.applies.length = 0; state.applyOk = true }

async function mod() { return import('@/lib/connectors/mintsoft/sync/bulk-product-data-run') }

test('trade CSV: invalid HS, blank description and duplicate rows are rejected with a reason; valid rows are kept', async () => {
  const { parseTradeCsv } = await import('@/lib/connectors/mintsoft/sync/bulk-product-data')
  const parsed = parseTradeCsv(TRADE_CSV)
  assert.deepEqual(parsed.rows.map((r) => r.sku), ['A-1', 'A-2', 'NOPE'])
  assert.deepEqual(parsed.rejected.map((r) => r.sku), ['A-3', 'A-4', 'A-1'])
  assert.match(parsed.rejected[0]!.reason, /^HS code 12345678 is not a declarable/)
  assert.match(parsed.rejected[1]!.reason, /^missing HS code or customs description/)
  assert.match(parsed.rejected[2]!.reason, /^duplicate SKU/)
  assert.throws(() => parseTradeCsv('SKU,x\nA,b'), /missing required column/)
})

test('COO CSV: names and aliases are canonicalised to ISO-2, an unassigned code is rejected', async () => {
  const { parseCooCsv } = await import('@/lib/connectors/mintsoft/sync/bulk-product-data')
  const parsed = parseCooCsv(COO_CSV)
  assert.deepEqual(parsed.rows.map((r) => [r.sku, r.countryOfOrigin]), [['A-1', 'CN'], ['A-2', 'DE'], ['A-4', 'GB']])
  assert.equal(parsed.rejected.length, 1)
})

test('DRY RUN (default) writes nothing: no apply call, a no-write comparison is printed, and apply was not asked for', async () => {
  const { runBulkProductData } = await mod()
  reset(false) // even with the setting off, a dry run runs
  const result = await runBulkProductData({ kind: 'trade', csvText: TRADE_CSV, apply: false }, deps)
  assert.equal(result.mode, 'dry-run')
  assert.deepEqual(state.applies, [], 'applyOne was never called')
  assert.equal(state.loads, 1)
  assert.equal(result.applied, 0)
  assert.match(result.report, /A-1: hsCode null -> "39269097"; customsDescription null -> "Plastic cable clips"/)
  assert.match(result.report, /NOPE: not an IMS product/)
  assert.match(result.report, /Nothing was written \(1 product\(s\) would change\)/)
  assert.match(result.report, /unchanged: 1/)
})

test('DRY RUN of the real wiring touches no write method of the database', async () => {
  const writes: string[] = []
  const trap = (name: string) => async () => { writes.push(name); return { count: 0 } }
  Object.assign(fakeDb, {
    setting: { findUnique: async () => null },
    product: { findMany: async () => [{ id: 'p1', sku: 'A-1', hsCode: null, customsDescription: null, countryOfOrigin: null, wmsProductLinks: [] }], updateMany: trap('product.updateMany'), update: trap('product.update'), create: trap('product.create') },
  })
  const { runBulkProductData } = await mod()
  const result = await runBulkProductData({ kind: 'coo', csvText: COO_CSV, apply: false })
  assert.equal(result.mode, 'dry-run')
  assert.deepEqual(writes, [])
})

test('APPLY is refused without the setting, before anything is read or written', async () => {
  const { runBulkProductData, BulkApplyRefusedError } = await mod()
  reset(false)
  await assert.rejects(() => runBulkProductData({ kind: 'trade', csvText: TRADE_CSV, apply: true }, deps), BulkApplyRefusedError)
  assert.equal(state.loads, 0)
  assert.deepEqual(state.applies, [])
})

test('APPLY with the setting writes each changed product once by compare-and-set; one that changed since is skipped and reported', async () => {
  const { runBulkProductData } = await mod()
  reset(true)
  const result = await runBulkProductData({ kind: 'coo', csvText: COO_CSV, apply: true }, deps)
  assert.deepEqual(state.applies.map((a) => a.id), ['p4'], 'only A-4 changes (A-1 and A-2 already hold their country)')
  assert.equal(result.applied, 1)

  reset(true)
  state.applyOk = false
  const stale = await runBulkProductData({ kind: 'coo', csvText: COO_CSV, apply: true }, deps)
  assert.deepEqual(stale.skippedChanged, ['A-4'])
  assert.equal(stale.applied, 0)
})

test('CATALOGUE DRY RUN: a pure comparison against the stored record; cost is hidden unless asked for; parity changes are listed', async () => {
  const { compareProductToStored, renderDryRun, summariseDryRun } = await import('@/lib/connectors/mintsoft/sync/catalogue-dry-run')
  const parent = 'Mandala Rose Works FireThorn Flex Plate with ThornGrip Textured PEI'
  const product = {
    id: 'p', sku: 'V-1', name: `${parent} — Voron 2.4/Trident 350 (355 x 355mm)`, barcode: null, mpn: null, hsCode: null, countryOfOrigin: 'CN',
    customsDescription: null, weight: null, widthCm: null, heightCm: null, depthCm: null, imageUrl: null, type: 'VARIANT', lifecycleStatus: 'ACTIVE',
    parent: { name: parent, weight: '1.25', widthCm: '30', heightCm: '10', depthCm: '20' },
    wmsProductLinks: [{ id: 'l', externalProductId: '168', payloadHash: 'x', lastKnownBarcode: null, lastSyncedAt: null, lastError: null }],
  }
  const stored = { ID: 168, SKU: 'V-1', Name: product.name, CountryOfManufacture: { Code: 'CN' } }
  const result = compareProductToStored({ product: product as never, storedRecord: stored, costPrice: 3.5 }, { split: false })
  assert.equal(result.todayDiffs.length, 0, 'what IMS sends today equals the stored record')
  assert.deepEqual(result.parityChangesVsToday.sort(), ['CostPrice', 'Depth', 'Height', 'Name', 'Weight', 'Width'].sort())
  const cost = result.parityDiffs.find((d) => d.field === 'CostPrice')
  assert.deepEqual(cost, { field: 'CostPrice', ims: '(hidden)', stored: '(hidden)' })
  const shown = compareProductToStored({ product: product as never, storedRecord: stored, costPrice: 3.5 }, { split: false, showCost: true })
  assert.equal(shown.parityDiffs.find((d) => d.field === 'CostPrice')?.ims, '3.5')
  const text = renderDryRun([result])
  assert.equal(text.includes('3.5'), false, 'the report does not print the cost')
  assert.match(text, /no write, no network call/)
  assert.equal(summariseDryRun([result]).parityChangesPayload, 1)
  const noRecord = compareProductToStored({ product: product as never, storedRecord: null, costPrice: null }, { split: false })
  assert.equal(noRecord.hasStoredRecord, false)
})
