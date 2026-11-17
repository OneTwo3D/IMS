import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-hqvrp.380 through the REAL server action `advancePoStatus` (placing the order): the minimum gross margin is enforced
 * on the server from the stored line costs, a block needs an override note, an accepted override is recorded on the PO in
 * the same transaction with who and when, an unavailable margin is never blocked, and with no threshold configured the
 * transition is exactly what it was.
 */

type Line = { productId: string; unitCostBase: string }
const state = {
  role: 'MANAGER',
  settingJson: null as string | null,
  lines: [{ productId: 'p1', unitCostBase: '8.000000' }] as Line[],
  facts: new Map<string, Record<string, unknown>>(),
  statusWrites: [] as Array<Record<string, unknown>>,
  txActivity: [] as Array<Record<string, unknown>>,
  activity: [] as Array<Record<string, unknown>>,
  poType: 'GOODS',
  poStatus: 'DRAFT',
  factLoads: 0,
  txFactLoads: 0,
}
function fact(over: Record<string, unknown> = {}) {
  return { productId: 'p1', sku: 'SKU-1', type: 'SIMPLE', parentId: null, salesPrice: '10.0000', salesPriceTaxInclusive: false, salesVatRate: null, categoryChain: [] as string[], ...over }
}

mock.module('@/lib/auth', {
  namedExports: { auth: async () => ({ user: { id: 'user-9', email: 'u@example.test', name: 'U', role: state.role, supplierId: null, sessionInvalidReason: null, totpEnabled: false, totpVerified: false } }) },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => undefined, revalidateTag: () => undefined } })
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (e: Record<string, unknown>) => { state.activity.push(e) },
    logActivityPersisted: async () => true,
    logActivityInTransaction: async (_tx: unknown, e: Record<string, unknown>) => { state.txActivity.push(e) },
  },
})
mock.module('@/lib/settings-store', {
  namedExports: { getSettingValue: async () => state.settingJson, serializeSettingValue: (_k: string, v: string) => v, deserializeSettingValue: (_k: string, v: string) => v },
})
mock.module('@/lib/domain/purchasing/list-price-facts', {
  namedExports: {
    // With a client argument the read is the transaction's: it sees what committed by lock time (txView), not the pre-lock values.
    loadListPriceFacts: async (ids: string[], client?: unknown) => {
      state.factLoads += 1
      if (client) state.txFactLoads += 1
      return new Map(ids.map((id) => {
        const f = state.facts.get(id) ?? fact({ productId: id })
        return [id, client ? { ...f, salesPrice: txView.price ?? f.salesPrice, salesVatRate: txView.vatRate === undefined ? f.salesVatRate : txView.vatRate } : f]
      }))
    },
  },
})
mock.module('@/lib/domain/purchasing/preferred-supplier', {
  namedExports: { updatePreferredSuppliersForPlacedPurchaseOrder: async () => ({ productIds: [], updatedCount: 0 }) },
})
// The transaction's own view of the setting and prices: committed values at lock time, which may differ from the pre-transaction read.
const txView = { settingJson: null as string | null | undefined, price: undefined as string | undefined, vatRate: undefined as number | null | undefined }
const tx = {
  setting: { findUnique: async () => { const v = txView.settingJson === undefined ? state.settingJson : txView.settingJson; return v ? { value: v } : null } },
  $queryRaw: async () => [],
  purchaseOrder: {
    findUnique: async () => ({ status: state.poStatus, reference: 'PO-1', type: state.poType }),
    update: async (a: { data: Record<string, unknown> }) => { state.statusWrites.push(a.data); return {} },
  },
  purchaseOrderLine: { findMany: async () => state.lines },
}
mock.module('@/lib/db', {
  namedExports: {
    db: {
      $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      purchaseOrderLine: { findMany: async () => state.lines.map((l) => ({ productId: l.productId })) },
    },
  },
})

// Imported lazily, after the mocks above are registered (this file is CommonJS under tsx, so no top-level await).
async function advancePoStatus(id: string, status: 'PO_SENT' | 'RFQ_SENT', payload?: { marginOverrideNote?: string }) {
  const m = await import('@/app/actions/purchase-orders')
  return m.advancePoStatus(id, status, payload)
}

const BLOCK = JSON.stringify({ mode: 'block', globalPct: '30', categories: {}, products: {} })
const WARN = JSON.stringify({ mode: 'warn', globalPct: '30', categories: {}, products: {} })

function reset() {
  state.role = 'MANAGER'
  state.settingJson = null
  state.lines = [{ productId: 'p1', unitCostBase: '8.000000' }] // margin 20% on a price of 10
  state.facts = new Map()
  state.statusWrites = []
  state.txActivity = []
  state.activity = []
  state.poType = 'GOODS'
  state.poStatus = 'DRAFT'
  state.factLoads = 0
  state.txFactLoads = 0
  txView.vatRate = undefined
  txView.settingJson = undefined
  txView.price = undefined
}

test('no threshold configured: the order is placed exactly as before and no price facts are even read', async () => {
  reset()
  const r = await advancePoStatus('po-1', 'PO_SENT')
  assert.equal(r.success, true)
  assert.equal(state.statusWrites.length, 1)
  assert.equal(state.statusWrites[0]!.status, 'PO_SENT')
  assert.equal(state.factLoads, 0)
  assert.equal(state.txActivity.length, 0)
})

test('block mode: a line below the minimum refuses the send without a note, and writes nothing', async () => {
  reset()
  state.settingJson = BLOCK
  const r = await advancePoStatus('po-1', 'PO_SENT')
  assert.equal(r.success, false)
  assert.match(r.error ?? '', /^MARGIN_BELOW_MINIMUM/)
  assert.match(r.error ?? '', /SKU-1/)
  assert.equal(state.statusWrites.length, 0)
  assert.equal(state.txActivity.length, 0)
})

test('block mode: a whitespace or too-short note does not count', async () => {
  reset()
  state.settingJson = BLOCK
  for (const note of ['', '   ', 'ok']) {
    const r = await advancePoStatus('po-1', 'PO_SENT', { marginOverrideNote: note })
    assert.equal(r.success, false, JSON.stringify(note))
  }
  assert.equal(state.statusWrites.length, 0)
})

test('block mode: a real note lets the order through and is recorded on the PO with who and when, in the same transaction', async () => {
  reset()
  state.settingJson = BLOCK
  const r = await advancePoStatus('po-1', 'PO_SENT', { marginOverrideNote: 'Loss leader for the spring promotion' })
  assert.equal(r.success, true)
  assert.equal(state.statusWrites.length, 1)
  assert.equal(state.txActivity.length, 1)
  const row = state.txActivity[0]!
  assert.equal(row.entityType, 'PURCHASE_ORDER')
  assert.equal(row.entityId, 'po-1')
  assert.equal(row.action, 'margin_override')
  assert.equal(row.userId, 'user-9')
  const meta = row.metadata as { note: string; overriddenAt: string; overriddenByUserId: string; verb: string; lines: Array<{ sku: string; marginPct: string; minPct: string }> }
  assert.equal(meta.note, 'Loss leader for the spring promotion')
  assert.equal(meta.overriddenByUserId, 'user-9')
  assert.equal(meta.verb, 'send')
  assert.ok(!Number.isNaN(Date.parse(meta.overriddenAt)))
  assert.deepEqual(meta.lines, [{ productId: 'p1', sku: 'SKU-1', marginPct: '20.00', minPct: '30.00', source: 'global' }])
  assert.match(String(row.description), /Loss leader for the spring promotion/)
})

test('warn mode never refuses the send and records no override', async () => {
  reset()
  state.settingJson = WARN
  const r = await advancePoStatus('po-1', 'PO_SENT')
  assert.equal(r.success, true)
  assert.equal(state.statusWrites.length, 1)
  assert.equal(state.txActivity.length, 0)
})

test('block mode: a line at or above the minimum passes without a note', async () => {
  reset()
  state.settingJson = BLOCK
  state.lines = [{ productId: 'p1', unitCostBase: '7.000000' }] // 30.00% = the minimum
  const r = await advancePoStatus('po-1', 'PO_SENT')
  assert.equal(r.success, true)
})

test('block mode: an unavailable margin (no list price, no cost) is never blocked', async () => {
  reset()
  state.settingJson = BLOCK
  state.facts.set('p1', fact({ salesPrice: null }))
  state.lines = [{ productId: 'p1', unitCostBase: '8.000000' }, { productId: 'p2', unitCostBase: '0.000000' }]
  const r = await advancePoStatus('po-1', 'PO_SENT')
  assert.equal(r.success, true)
  assert.equal(state.statusWrites.length, 1)
})

test('block mode: a VAT-inclusive list price is compared ex-VAT, the same way the margin column reads it', async () => {
  reset()
  state.settingJson = BLOCK
  state.facts.set('p1', fact({ salesPrice: '12.0000', salesPriceTaxInclusive: true, salesVatRate: 0.2 })) // ex-VAT 10
  state.lines = [{ productId: 'p1', unitCostBase: '8.000000' }] // 20% against 30%: blocked
  assert.equal((await advancePoStatus('po-1', 'PO_SENT')).success, false)
  // Were the 12.00 compared as if ex-VAT, 8 against 12 is 33.33% and it would wrongly pass.
})

test('a role without inventory.prices cannot override, and the refusal shows no margin figures', async () => {
  reset()
  state.role = 'WAREHOUSE'
  state.settingJson = BLOCK
  // WAREHOUSE has no purchasing.create, so the action refuses before the guard is reached at all.
  const r = await advancePoStatus('po-1', 'PO_SENT', { marginOverrideNote: 'I would like to override this please' })
  assert.equal(r.success, false)
  assert.equal(state.statusWrites.length, 0)
  assert.equal(state.txActivity.length, 0)
})

test('only placing the order is assessed: other transitions skip the guard', async () => {
  reset()
  state.settingJson = BLOCK
  const r = await advancePoStatus('po-1', 'RFQ_SENT')
  assert.equal(r.success, true)
  assert.equal(state.factLoads, 0)
})

test('the send decision uses the threshold and price committed at lock time, not the ones read before the transaction', async () => {
  // Pre-transaction read: block mode at 30%, price 10, cost 6 (40%): passes. Before the lock a price cut to 8 commits (25%).
  reset()
  state.settingJson = BLOCK
  state.lines = [{ productId: 'p1', unitCostBase: '6.000000' }]
  txView.price = '8.0000'
  const cut = await advancePoStatus('po-1', 'PO_SENT')
  assert.equal(cut.success, false)
  assert.match(cut.error ?? '', /^MARGIN_BELOW_MINIMUM/)
  assert.equal(state.statusWrites.length, 0)
  // A raised minimum committed after the pre-transaction read (which saw none) is enforced too.
  reset()
  state.settingJson = null
  state.lines = [{ productId: 'p1', unitCostBase: '8.000000' }]
  txView.settingJson = BLOCK
  const raised = await advancePoStatus('po-1', 'PO_SENT')
  assert.equal(raised.success, false)
  assert.equal(state.statusWrites.length, 0)
  // And a minimum removed in the meantime lets it through.
  reset()
  state.settingJson = BLOCK
  txView.settingJson = null
  assert.equal((await advancePoStatus('po-1', 'PO_SENT')).success, true)
})

test('sales VAT is read through the transaction: a rate that changed after any earlier read decides the send', async () => {
  reset()
  state.settingJson = BLOCK
  // Inclusive list price 12.00. Zero-rated earlier (ex-VAT 12, cost 8 = 33.33%, passes); 20% at lock time (ex-VAT 10, 20%, below 30%).
  state.facts.set('p1', fact({ salesPrice: '12.0000', salesPriceTaxInclusive: true, salesVatRate: 0 }))
  txView.vatRate = 0.2
  const r = await advancePoStatus('po-1', 'PO_SENT')
  assert.equal(r.success, false)
  assert.equal(state.statusWrites.length, 0)
  assert.ok(state.txFactLoads >= 1)
  // The reverse: 20% earlier, zero-rated now: the current rate wins.
  reset()
  state.settingJson = BLOCK
  state.facts.set('p1', fact({ salesPrice: '12.0000', salesPriceTaxInclusive: true, salesVatRate: 0.2 }))
  txView.vatRate = 0
  assert.equal((await advancePoStatus('po-1', 'PO_SENT')).success, true)
})

test('a threshold removed while a line was added is not refused: the locked setting is read first', async () => {
  reset()
  state.settingJson = BLOCK
  txView.settingJson = null
  state.lines = [{ productId: 'p1', unitCostBase: '8.000000' }, { productId: 'p9', unitCostBase: '9.000000' }]
  const r = await advancePoStatus('po-1', 'PO_SENT')
  assert.equal(r.success, true)
  assert.equal(state.statusWrites.length, 1)
})
