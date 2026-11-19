import assert from 'node:assert/strict'
import test from 'node:test'
import { applyWcOrderAmendment, planWcOrderAmendment, type AmendmentDeps, type AmendmentFacts } from '@/lib/connectors/woocommerce/sync/order-amendment'
import type { DivergenceDifference } from '@/lib/connectors/woocommerce/sync/order-divergence'
import type { WcFullOrder } from '@/lib/connectors/woocommerce/sync/types'

// o3d-zvec.7 write step. No network, no database: every dependency is injected.

const wc = (qty: number | null, modified = '2026-11-19T10:00:00'): WcFullOrder =>
  ({ id: 9, number: '1009', date_modified_gmt: modified, line_items: qty === null ? [] : [{ id: 77, quantity: qty, sku: 'RED' }] }) as unknown as WcFullOrder

const line = { id: 'l1', externalLineItemId: 77, productId: 'p1', sku: 'RED', description: 'Red', qty: 5, totalForeign: 50, totalBase: 40 }
const facts = (over: Partial<AmendmentFacts> = {}): AmendmentFacts => ({
  orderNumber: 'SO-9', status: 'PROCESSING', paidAt: new Date('2026-11-18T00:00:00Z'), editedInImsAt: null, baselineQtyByExternalLineId: null,
  lines: [line], refundedQtyByLineId: new Map(), shippedQtyByLineId: new Map(), ...over,
})
const diffs: DivergenceDifference[] = [{ field: 'LINE_QUANTITY', label: 'Quantity of RED changed in WooCommerce', woocommerce: '3', ims: '5' }]

function deps(f: AmendmentFacts | null, over: Partial<AmendmentDeps> = {}) {
  const calls = { refunds: [] as Array<{ lines: unknown[]; reason: string }>, tasks: [] as Array<Record<string, unknown>>, gate: 0, claims: 0, released: 0, logs: [] as string[] }
  const d: AmendmentDeps = {
    isEnabled: async () => true,
    withOrderLock: async (_o, fn) => fn(),
    loadFacts: async () => f,
    claim: async () => { calls.claims += 1; return calls.claims === 1 },
    releaseClaim: async () => { calls.released += 1 },
    warehouseGate: async () => { calls.gate += 1; return { ok: true, externalOrderId: 'MS-1' } },
    warehouseLink: async () => ({ connector: 'mintsoft', externalOrderId: 'MS-1', externalOrderNumber: 'W-1' }),
    createRefund: async (_o, lines, reason) => { calls.refunds.push({ lines, reason }); return { success: true } },
    raiseTask: async (task) => { calls.tasks.push(task as unknown as Record<string, unknown>); return true },
    log: async (e) => { calls.logs.push(e.action) },
    ...over,
  }
  return { d, calls }
}

test('setting OFF: nothing is read, refunded or raised', async () => {
  const { d, calls } = deps(facts(), { isEnabled: async () => false, loadFacts: async () => { throw new Error('must not read') } })
  assert.deepEqual(await applyWcOrderAmendment('o1', wc(3), diffs, 'fp', d), { kind: 'off' })
  assert.equal(calls.refunds.length + calls.tasks.length, 0)
})

test('a reduction on a PAID order goes through the refund path: 2 unshipped units, pro-rata net, never an edit of the paid amount', async () => {
  const { d, calls } = deps(facts())
  const out = await applyWcOrderAmendment('o1', wc(3), diffs, 'fp', d)
  assert.equal(out.kind, 'applied')
  assert.equal(calls.refunds.length, 1)
  assert.deepEqual(calls.refunds[0]!.lines, [{ lineId: 'l1', productId: 'p1', description: 'Red', qty: 2, totalForeign: 20, totalBase: 16, lineKind: 'sale' }])
  assert.equal(calls.tasks.length, 0, 'the refund path raises its own warehouse note; no second task')
})

test('a line WooCommerce removed entirely is refunded in full (unshipped units)', async () => {
  const { d, calls } = deps(facts())
  await applyWcOrderAmendment('o1', wc(null), [{ field: 'LINE_REMOVED', label: 'x', woocommerce: 'not on the order', ims: '5 x RED' }], 'fp', d)
  assert.equal((calls.refunds[0]!.lines[0] as { qty: number }).qty, 5)
})

test('units a refund already explains are not refunded twice, and shipped units are never taken off', async () => {
  const refunded = deps(facts({ refundedQtyByLineId: new Map([['l1', 2]]) }))
  assert.equal((await applyWcOrderAmendment('o1', wc(3), diffs, 'fp', refunded.d)).kind, 'skipped')
  assert.equal(refunded.calls.refunds.length, 0)

  const shipped = deps(facts({ shippedQtyByLineId: new Map([['l1', 4]]) }))
  await applyWcOrderAmendment('o1', wc(3), diffs, 'fp', shipped.d)
  assert.equal((shipped.calls.refunds[0]!.lines[0] as { qty: number }).qty, 1, 'only the one unshipped unit goes through the refund path')
})

test('LATEST EDIT WINS: a line WooCommerce changed from the baseline wins; a line it never changed stays IMS\'s; no baseline means IMS wins; the modified time is not used', async () => {
  const edited = new Date('2026-11-19T09:00:00Z')
  const base = new Map([[77, 5]])
  // WooCommerce changed the line (5 -> 3): WooCommerce wins, WHATEVER the payload's modified time (IMS's own status / note write-backs bump it; the clocks differ).
  assert.equal(planWcOrderAmendment(wc(3, '2026-11-19T10:00:00'), diffs, facts({ editedInImsAt: edited, baselineQtyByExternalLineId: base })).reductions.length, 1)
  assert.equal(planWcOrderAmendment(wc(3, '2026-11-19T08:00:00'), diffs, facts({ editedInImsAt: edited, baselineQtyByExternalLineId: base })).reductions.length, 1)
  // WooCommerce's line equals the baseline (an IMS write bumped the modified time; IMS edited the qty up): IMS wins.
  const same = planWcOrderAmendment(wc(5, '2026-11-19T10:00:00'), diffs, facts({ editedInImsAt: edited, baselineQtyByExternalLineId: base, lines: [{ ...line, qty: 8 }] }))
  assert.equal(same.reductions.length, 0)
  assert.equal(same.imsWins.length, 1)
  // An IMS edit with no stored baseline is never overwritten.
  assert.equal(planWcOrderAmendment(wc(3), diffs, facts({ editedInImsAt: edited })).reductions.length, 0)
})

test('an UNPAID order is never rewritten; picking started (IMS status) raises the operator task and sends nothing', async () => {
  const idle = deps(facts({ paidAt: null }))
  assert.equal((await applyWcOrderAmendment('o1', wc(3), diffs, 'fp', idle.d)).kind, 'skipped')
  assert.equal(idle.calls.refunds.length, 0)
  assert.equal(idle.calls.gate, 1, 'the warehouse was asked whether it can still take a change')

  const picking = deps(facts({ paidAt: null, status: 'PICKING' }))
  const out = await applyWcOrderAmendment('o1', wc(3), diffs, 'fp', picking.d)
  assert.deepEqual(out, { kind: 'applied', refundedLines: 0, taskRaised: true })
  assert.equal(picking.calls.refunds.length, 0)
  assert.equal(picking.calls.gate, 0, 'IMS already knows picking started')
  const task = picking.calls.tasks[0]!
  assert.equal(task.reason, 'WC_EDIT_AFTER_PICKING')
  assert.equal(task.externalOrderId, 'MS-1')
  assert.match(String(task.queryText), /RED quantity is now 3/)
})

test('picking started at the WAREHOUSE (the amend gate refuses) raises the task even while IMS still says PROCESSING', async () => {
  const { d, calls } = deps(facts({ paidAt: null }), { warehouseGate: async () => ({ ok: false, externalOrderId: null }) })
  assert.equal((await applyWcOrderAmendment('o1', wc(3), diffs, 'fp', d)).kind, 'applied')
  assert.equal(calls.tasks.length, 1)
})

test('one set of differences is acted on once: the second delivery loses the claim; a failed refund releases it for a retry', async () => {
  const { d, calls } = deps(facts())
  await applyWcOrderAmendment('o1', wc(3), diffs, 'fp', d)
  assert.equal((await applyWcOrderAmendment('o1', wc(3), diffs, 'fp', d)).kind, 'skipped')
  assert.equal(calls.refunds.length, 1)

  const failing = deps(facts(), { createRefund: async () => ({ success: false, error: 'no' }) })
  assert.deepEqual(await applyWcOrderAmendment('o1', wc(3), diffs, 'fp', failing.d), { kind: 'refund-failed', error: 'no' })
  assert.equal(failing.calls.released, 1)
})

test('a shipped, cancelled or erased order is left alone', async () => {
  for (const status of ['SHIPPED', 'COMPLETED', 'CANCELLED', 'DELIVERED']) {
    const { d, calls } = deps(facts({ status }))
    assert.equal((await applyWcOrderAmendment('o1', wc(3), diffs, 'fp', d)).kind, 'skipped', status)
    assert.equal(calls.refunds.length, 0)
  }
  assert.equal((await applyWcOrderAmendment('o1', wc(3), diffs, 'fp', deps(null).d)).kind, 'skipped')
})

// ---- round 1 review fixes ----

const reduce3to2 = { ...line, qty: 3, totalForeign: 30, totalBase: 24 }

test('HIGH: a PAID order in PICKING reduced 3 -> 2 is NOT refunded: one WC_EDIT_AFTER_PICKING task, no refund', async () => {
  const { d, calls } = deps(facts({ status: 'PICKING', lines: [reduce3to2] }))
  const out = await applyWcOrderAmendment('o1', wc(2), diffs, 'fp', d)
  assert.deepEqual(out, { kind: 'applied', refundedLines: 0, taskRaised: true })
  assert.equal(calls.refunds.length, 0)
  assert.equal(calls.tasks.length, 1)
  assert.equal(calls.tasks[0]!.reason, 'WC_EDIT_AFTER_PICKING')
  assert.match(String(calls.tasks[0]!.queryText), /RED quantity is now 2/)
})

test('HIGH: a PAID order ALLOCATED in IMS whose Mintsoft order is past NEW is NOT refunded either: the gate is asked before the refund', async () => {
  const { d, calls } = deps(facts({ status: 'ALLOCATED', lines: [reduce3to2] }), { warehouseGate: async () => ({ ok: false, externalOrderId: null }) })
  const out = await applyWcOrderAmendment('o1', wc(2), diffs, 'fp', d)
  assert.equal(out.kind, 'applied')
  assert.equal(calls.refunds.length, 0)
  assert.equal(calls.tasks.length, 1)
})

test('HIGH: a gate that cannot be read fails CLOSED: no refund, the task is raised', async () => {
  for (const warehouseGate of [async () => { throw new Error('mintsoft down') }, async () => ({ ok: false as const, externalOrderId: null })]) {
    const { d, calls } = deps(facts({ lines: [reduce3to2] }), { warehouseGate })
    assert.equal((await applyWcOrderAmendment('o1', wc(2), diffs, 'fp', d)).kind, 'applied')
    assert.equal(calls.refunds.length, 0)
    assert.equal(calls.tasks.length, 1)
  }
})

test('a paid reduction with the warehouse still NEW (gate open) IS refunded, and the cap for the refund transaction is the reduction WooCommerce shows', async () => {
  const seen: unknown[] = []
  const { d, calls } = deps(facts({ lines: [reduce3to2] }), { createRefund: async (_o, lines, _r, caps) => { seen.push(caps); calls0.push(lines); return { success: true } } })
  const calls0: unknown[] = []
  assert.equal((await applyWcOrderAmendment('o1', wc(2), diffs, 'fp', d)).kind, 'applied')
  assert.deepEqual(seen, [[{ lineIds: ['l1'], maxQty: 1 }]])
  assert.equal(calls0.length, 1)
  assert.equal(calls.gate, 1)
})

/** A tiny in-memory order: refunds change what the next loadFacts reads, the lock is a real mutex, the claim follows the divergence row's fingerprint. */
function sim() {
  const state = { refunded: 0, fingerprint: 'fpA', claim: null as string | null, refunds: 0 }
  let tail: Promise<unknown> = Promise.resolve()
  const { d, calls } = deps(null, {
    withOrderLock: (_o, fn) => { const run = tail.then(() => fn()); tail = run.catch(() => undefined); return run as never },
    loadFacts: async () => { await new Promise((r) => setTimeout(r, 1)); return facts({ lines: [reduce3to2], refundedQtyByLineId: new Map([['l1', state.refunded]]) }) },
    claim: async (_o, fingerprint, key) => { if (state.fingerprint !== fingerprint || state.claim === key) return false; state.claim = key; return true },
    releaseClaim: async (_o, key) => { if (state.claim === key) state.claim = null },
    createRefund: async (_o, lines) => { await new Promise((r) => setTimeout(r, 1)); state.refunded += (lines[0] as { qty: number }).qty; state.refunds += 1; return { success: true } },
  })
  return { d, state, calls }
}

test('HIGH: two RACING deliveries with different fingerprints (reduce X, then change shipping) give exactly ONE refund', async () => {
  const { d, state } = sim()
  const shippingToo: DivergenceDifference[] = [...diffs, { field: 'SHIPPING', label: 'Shipping', woocommerce: '5', ims: '4' }]
  state.fingerprint = 'fpA'
  const a = applyWcOrderAmendment('o1', wc(2), diffs, 'fpA', d)
  state.fingerprint = 'fpB' // the divergence row now carries payload B's fingerprint, as it would after B's upsert
  const b = applyWcOrderAmendment('o1', wc(2), shippingToo, 'fpB', d)
  await Promise.all([a, b])
  assert.equal(state.refunds, 1)
  assert.equal(state.refunded, 1)
})

test('HIGH: the same reduction under a second fingerprint, run later, refunds nothing (the delta is computed from the committed refunds)', async () => {
  const { d, state } = sim()
  state.fingerprint = 'fpA'
  await applyWcOrderAmendment('o1', wc(2), diffs, 'fpA', d)
  state.fingerprint = 'fpB'
  const second = await applyWcOrderAmendment('o1', wc(2), diffs, 'fpB', d)
  assert.equal(second.kind, 'skipped')
  assert.equal(state.refunds, 1)
})

test('MEDIUM: a STALE delivery (older than the stored WooCommerce modified time) drives no refund', async () => {
  const { d, calls } = deps(facts({ lines: [reduce3to2], externalUpdatedAt: new Date('2026-11-19T12:00:00Z') }))
  const out = await applyWcOrderAmendment('o1', wc(2, '2026-11-19T10:00:00'), diffs, 'fp', d)
  assert.equal(out.kind, 'skipped')
  assert.match((out as { reason: string }).reason, /stale/)
  assert.equal(calls.refunds.length, 0)
  // The same delivery with an equal or older stored time is acted on.
  const fresh = deps(facts({ lines: [reduce3to2], externalUpdatedAt: new Date('2026-11-19T10:00:00Z') }))
  assert.equal((await applyWcOrderAmendment('o1', wc(2, '2026-11-19T10:00:00'), diffs, 'fp', fresh.d)).kind, 'applied')
})

test('MEDIUM: reduce THEN restore leaves the refund standing and raises an operator task for a person', async () => {
  const restored = deps(facts({ lines: [reduce3to2], refundedQtyByLineId: new Map([['l1', 1]]), amendmentRefundedQtyByLineId: new Map([['l1', 1]]) }))
  const out = await applyWcOrderAmendment('o1', wc(3), [], 'fp', restored.d)
  assert.equal(out.kind, 'applied')
  assert.equal(restored.calls.refunds.length, 0, 'nothing is refunded or reversed automatically')
  assert.equal(restored.calls.tasks.length, 1)
  assert.match(String(restored.calls.tasks[0]!.queryText), /RED: WooCommerce shows 3 again, IMS refunded 1 unit/)
  // An ordinary shop refund (not this step's) with WooCommerce unchanged is NOT a restore.
  const shop = deps(facts({ lines: [reduce3to2], refundedQtyByLineId: new Map([['l1', 1]]) }))
  assert.equal((await applyWcOrderAmendment('o1', wc(3), [], 'fp', shop.d)).kind, 'skipped')
})

test('LOW: IMS lines sharing one WooCommerce item id are added up: lines of 2 and 1, WooCommerce 3 -> 1, refunds 2 units in all', async () => {
  const a = { ...line, id: 'la', qty: 2, totalForeign: 20, totalBase: 16 }
  const b = { ...line, id: 'lb', qty: 1, totalForeign: 10, totalBase: 8 }
  const { d, calls } = deps(facts({ lines: [a, b] }))
  assert.equal((await applyWcOrderAmendment('o1', wc(1), diffs, 'fp', d)).kind, 'applied')
  const sent = calls.refunds[0]!.lines as Array<{ lineId: string; qty: number }>
  assert.equal(sent.reduce((sum, l) => sum + l.qty, 0), 2)
  assert.deepEqual(sent.map((l) => l.lineId), ['la'], 'spread over the lines in order')
})

test('LOW: a throw AFTER the claim was taken releases the claim, so the next delivery retries', async () => {
  const { d, calls } = deps(facts({ lines: [reduce3to2] }), { createRefund: async () => { throw new Error('import rejected') } })
  const origError = console.error
  console.error = () => undefined
  try {
    assert.equal((await applyWcOrderAmendment('o1', wc(2), diffs, 'fp', d)).kind, 'skipped')
  } finally { console.error = origError }
  assert.equal(calls.released, 1)
})

test('LOW: an order with an ORDER-LEVEL DISCOUNT is not refunded by the internal cut: an operator task instead', async () => {
  const { d, calls } = deps(facts({ lines: [reduce3to2], orderDiscount: 5 }))
  const out = await applyWcOrderAmendment('o1', wc(2), diffs, 'fp', d)
  assert.equal(out.kind, 'applied')
  assert.equal(calls.refunds.length, 0)
  assert.equal(calls.tasks.length, 1)
  assert.match(String(calls.tasks[0]!.queryText), /order-level discount/)
})
