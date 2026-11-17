import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'

/**
 * o3d-hqvrp.381 through the REAL server actions: the list-price edit from the PO margin column is gated on inventory.prices, writes the
 * product row through the normal product update mechanics (SKU write lock, one transaction, an activity row in it) and then ONLY the
 * normal product sync dispatchers, never a connector, and the margin is recomputed from the new price afterwards.
 */

const state = {
  role: 'MANAGER',
  price: '10.0000' as string | null,
  inclusive: false,
  vatRate: null as number | null,
  type: 'SIMPLE',
  sku: 'SKU-1',
  writes: [] as Array<Record<string, unknown>>,
  txActivity: [] as Array<Record<string, unknown>>,
  locks: 0,
  pushes: [] as string[],
  wmsSyncs: [] as string[],
  txCount: 0,
  settingJson: null as string | null,
  txLoads: 0,
  txVatRate: undefined as number | null | undefined,
}

mock.module('@/lib/auth', {
  namedExports: { auth: async () => ({ user: { id: 'user-3', email: 'u@example.test', name: 'U', role: state.role, supplierId: null, sessionInvalidReason: null, totpEnabled: false, totpVerified: false } }) },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => undefined, revalidateTag: () => undefined } })
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async () => undefined,
    logActivityPersisted: async () => true,
    logActivityInTransaction: async (_tx: unknown, e: Record<string, unknown>) => { state.txActivity.push(e) },
  },
})
mock.module('@/lib/settings-store', { namedExports: { getSettingValue: async () => state.settingJson, serializeSettingValue: (_k: string, v: string) => v } })
mock.module('@/lib/domain/purchasing/list-price-facts', {
  namedExports: {
    loadListPriceFacts: async (ids: string[], client?: unknown) => {
      if (client) state.txLoads += 1
      return new Map(ids.filter((id) => id === 'p1').map((id) => [id, {
        productId: id, sku: state.sku, type: state.type, parentId: null, salesPrice: state.price, salesPriceTaxInclusive: state.inclusive,
        // The transaction's read sees a rate that changed after the first one.
        salesVatRate: client && state.txVatRate !== undefined ? state.txVatRate : state.vatRate, categoryChain: [] as string[],
      }]))
    },
  },
})
mock.module('@/lib/shopping', { namedExports: { pushProductMetadata: async (id: string) => { state.pushes.push(id); return { success: true } }, enqueueStockSync: async () => undefined } })
mock.module('@/lib/domain/wms/product-sync-dispatch', {
  namedExports: { scheduleWmsProductSync: (id: string) => { state.wmsSyncs.push(id) }, isAnyWmsConnectorEnabled: async () => true },
})
const tx = {
  $queryRaw: async () => { state.locks += 1; return [{ lock_id: 1 }] },
  $executeRaw: async () => 1,
  product: {
    findUnique: async () => ({ sku: state.sku, type: state.type, salesPriceBase: state.price, salesPriceTaxInclusive: state.inclusive }),
    update: async (a: { data: { salesPriceBase: string } }) => { state.writes.push(a.data); state.price = a.data.salesPriceBase; return {} },
  },
}
mock.module('@/lib/db', {
  namedExports: {
    db: {
      $transaction: async (fn: (t: unknown) => Promise<unknown>) => { state.txCount += 1; return fn(tx) },
      costLayer: { findMany: async () => [] },
    },
  },
})

// Imported lazily, after the mocks above are registered (this file is CommonJS under tsx, so no top-level await).
async function updateProductListPrice(input: { productId: string; exVatPrice: string }) {
  const m = await import('@/app/actions/product-list-price')
  return m.updateProductListPrice(input)
}
async function previewPoLineMargins(input: { pricesIncludeVat: boolean; fxRate: number | null; lines: Array<{ key: string; productId: string; qty: number; unitCost: number; discount: string; purchaseUnitFactor: number; taxRate: number }> }) {
  const m = await import('@/app/actions/purchase-order-margin')
  return m.previewPoLineMargins(input)
}

function reset() {
  state.role = 'MANAGER'
  state.price = '10.0000'
  state.inclusive = false
  state.vatRate = null
  state.type = 'SIMPLE'
  state.writes = []
  state.txActivity = []
  state.locks = 0
  state.pushes = []
  state.wmsSyncs = []
  state.txCount = 0
  state.settingJson = null
  state.txLoads = 0
  state.txVatRate = undefined
}

const previewLine = { key: 'l1', productId: 'p1', qty: 10, unitCost: 6, discount: '', purchaseUnitFactor: 1, taxRate: 0 }
async function marginPct(): Promise<string | null> {
  const r = await previewPoLineMargins({ pricesIncludeVat: false, fxRate: 1, lines: [previewLine] })
  assert.equal(r.success, true)
  if (!r.success) return null
  const row = r.lines[0]!
  return row.result.kind === 'ok' ? row.result.marginPct : null
}

test('permission denied: a role without inventory.prices cannot edit, and nothing is written or synced', async () => {
  reset()
  state.role = 'WAREHOUSE'
  await assert.rejects(() => updateProductListPrice({ productId: 'p1', exVatPrice: '12' }), /missing permission inventory\.prices/)
  assert.equal(state.txCount, 0)
  assert.deepEqual(state.writes, [])
  assert.deepEqual(state.pushes, [])
  assert.deepEqual(state.wmsSyncs, [])
})

test('FINANCE (inventory.prices without inventory.edit) is refused: no write, no sync, and the margin row offers no edit', async () => {
  reset()
  state.role = 'FINANCE'
  await assert.rejects(() => updateProductListPrice({ productId: 'p1', exVatPrice: '12' }), /missing permission inventory\.edit/)
  assert.equal(state.txCount, 0)
  assert.deepEqual(state.writes, [])
  assert.deepEqual(state.pushes, [])
  assert.deepEqual(state.wmsSyncs, [])
  const preview = await previewPoLineMargins({ pricesIncludeVat: false, fxRate: 1, lines: [previewLine] })
  assert.ok(preview.success && preview.lines[0]!.listPriceEditable === false)
  state.role = 'MANAGER'
  const manager = await previewPoLineMargins({ pricesIncludeVat: false, fxRate: 1, lines: [previewLine] })
  assert.ok(manager.success && manager.lines[0]!.listPriceEditable === true)
})

test('the edit goes through the normal product update: SKU lock, one transaction, only salesPriceBase written, audit row in the same transaction', async () => {
  reset()
  const r = await updateProductListPrice({ productId: 'p1', exVatPrice: '12.5' })
  assert.equal(r.success, true)
  assert.equal(state.txCount, 1)
  assert.equal(state.locks, 1)
  assert.deepEqual(state.writes, [{ salesPriceBase: '12.5000' }])
  assert.equal(state.txActivity.length, 1)
  const row = state.txActivity[0]!
  assert.equal(row.entityType, 'PRODUCT')
  assert.equal(row.entityId, 'p1')
  assert.equal(row.action, 'list_price_updated')
  assert.equal(row.userId, 'user-3')
  assert.deepEqual((row.metadata as Record<string, unknown>).from, '10.0000')
  assert.deepEqual((row.metadata as Record<string, unknown>).to, '12.5000')
})

test('the vendors are reached only through the normal product sync dispatchers, after the commit', async () => {
  reset()
  const r = await updateProductListPrice({ productId: 'p1', exVatPrice: '12.5' })
  assert.equal(r.success, true)
  assert.deepEqual(state.pushes, ['p1'])
  assert.deepEqual(state.wmsSyncs, ['p1'])
  // A role holding inventory.prices but not inventory.edit (FINANCE) is refused outright: see the permission test above.
})

test('no direct connector call: the action imports no connector or HTTP client, and no module-level fetch', () => {
  const src = readFileSync('app/actions/product-list-price.ts', 'utf8')
  assert.doesNotMatch(src, /from '@\/lib\/connectors/)
  assert.doesNotMatch(src, /from '[^']*(woocommerce|mintsoft|xero)[^']*'/i)
  assert.doesNotMatch(src, /\bfetch\(|axios|undici/)
  const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
  assert.deepEqual(imports.filter((i) => i!.startsWith('@/lib/shopping') || i!.includes('product-sync-dispatch')).sort(), ['@/lib/domain/wms/product-sync-dispatch', '@/lib/shopping'])
})

test('the margin is recomputed from the new price after the edit', async () => {
  reset()
  assert.equal(await marginPct(), '40.00') // price 10, cost 6
  const r = await updateProductListPrice({ productId: 'p1', exVatPrice: '15' })
  assert.equal(r.success, true)
  assert.equal(await marginPct(), '60.00') // price 15, cost 6
})

test('a VAT-inclusive product stores the price VAT-inclusive and the margin reads the ex-VAT price back', async () => {
  reset()
  state.inclusive = true
  state.vatRate = 0.2
  state.price = '12.0000'
  const r = await updateProductListPrice({ productId: 'p1', exVatPrice: '15' })
  assert.deepEqual(r, { success: true, storedPrice: '18.0000', exVatPrice: '15', syncNote: null })
  assert.deepEqual(state.writes, [{ salesPriceBase: '18.0000' }])
  assert.equal(await marginPct(), '60.00')
})

test('refusals write nothing and sync nothing: unresolved VAT, variable parent, bad price, unknown product', async () => {
  reset()
  state.inclusive = true
  state.vatRate = null
  const noVat = await updateProductListPrice({ productId: 'p1', exVatPrice: '15' })
  assert.equal(noVat.success, false)
  reset()
  state.type = 'VARIABLE'
  const variable = await updateProductListPrice({ productId: 'p1', exVatPrice: '15' })
  assert.equal(variable.success, false)
  assert.match(variable.success ? '' : variable.error, /variations/)
  reset()
  for (const bad of ['0', '-3', 'abc', '1.23456', '']) assert.equal((await updateProductListPrice({ productId: 'p1', exVatPrice: bad })).success, false, bad)
  assert.equal((await updateProductListPrice({ productId: 'nope', exVatPrice: '5' })).success, false)
  assert.equal(state.txCount, 0)
  assert.deepEqual(state.writes, [])
  assert.deepEqual(state.pushes, [])
})

test('the action is gated on inventory.prices before it reads anything', () => {
  const src = readFileSync('app/actions/product-list-price.ts', 'utf8')
  const gate = src.indexOf("requirePermission('inventory.edit')")
  assert.ok(gate > 0 && src.indexOf("requirePermission('inventory.prices')") > gate)
  assert.ok(gate < src.indexOf('loadListPriceFacts('))
  assert.ok(gate < src.indexOf('db.$transaction'))
})

test('the VAT rate and price convention are read again under the lock: a rate that changed after the first read prices the edit', async () => {
  reset()
  state.inclusive = true
  state.vatRate = 0.2
  state.txVatRate = 0.25
  const r = await updateProductListPrice({ productId: 'p1', exVatPrice: '10' })
  assert.equal(state.txLoads, 1)
  assert.deepEqual(state.writes, [{ salesPriceBase: '12.5000' }])
  assert.equal(r.success && r.storedPrice, '12.5000')
  // A rate that disappeared under the lock refuses; nothing is written.
  reset()
  state.inclusive = true
  state.vatRate = 0.2
  state.txVatRate = null
  assert.equal((await updateProductListPrice({ productId: 'p1', exVatPrice: '10' })).success, false)
  assert.deepEqual(state.writes, [])
  assert.deepEqual(state.pushes, [])
})
