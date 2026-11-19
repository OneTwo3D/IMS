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

test('LATEST EDIT WINS: an IMS edit newer than the WooCommerce change stands; a WooCommerce change after it wins; no baseline means IMS wins', async () => {
  const edited = new Date('2026-11-19T09:00:00Z')
  const base = new Map([[77, 5]])
  // WooCommerce changed the line (5 -> 3) AFTER the IMS edit: WooCommerce wins.
  assert.equal(planWcOrderAmendment(wc(3, '2026-11-19T10:00:00'), diffs, facts({ editedInImsAt: edited, baselineQtyByExternalLineId: base })).reductions.length, 1)
  // WooCommerce's modified time moved but its line equals the baseline (an IMS status write bumped it; IMS edited the qty up): IMS wins.
  const same = planWcOrderAmendment(wc(5, '2026-11-19T10:00:00'), diffs, facts({ editedInImsAt: edited, baselineQtyByExternalLineId: base, lines: [{ ...line, qty: 8 }] }))
  assert.equal(same.reductions.length, 0)
  assert.equal(same.imsWins.length, 1)
  // WooCommerce changed the line BEFORE the IMS edit: IMS is the later edit.
  assert.equal(planWcOrderAmendment(wc(3, '2026-11-19T08:00:00'), diffs, facts({ editedInImsAt: edited, baselineQtyByExternalLineId: base })).reductions.length, 0)
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
