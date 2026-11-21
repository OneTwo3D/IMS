import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { applyWcOrderAmendment, planWcOrderAmendment, type AmendmentDeps, type AmendmentFacts } from '@/lib/connectors/woocommerce/sync/order-amendment'
import { headerRateLockOptions, planUnpaidRewrite, type RewriteInput } from '@/lib/connectors/woocommerce/sync/order-unpaid-rewrite'
import { DRAIN_FAILED_WARNING, noteDrainOutcome, type DivergenceDifference } from '@/lib/connectors/woocommerce/sync/order-divergence'
import { raiseWcPaidIncreaseTask, wcPartPaymentChangedQuery, wmsOperatorTaskHash, WC_PAID_INCREASE_SUPERSEDED_ACTOR } from '@/lib/domain/wms/operator-tasks'
import { cronOutcomes } from '@/lib/ops/cron-outcomes'
import type { WcFullOrder } from '@/lib/connectors/woocommerce/sync/types'

// o3d-0ged2: the follow-ups to the WooCommerce order-edit work. No network, no database: every dependency is injected (the database-backed arms are tests/concurrency/wc-order-amendment-followups.concurrent.test.ts).

const line = { id: 'l1', externalLineItemId: 77, productId: 'p1', sku: 'RED', description: 'Red', qty: 5, totalForeign: 50, totalBase: 40 }
const facts = (over: Partial<AmendmentFacts> = {}): AmendmentFacts => ({
  orderNumber: 'SO-9', status: 'PROCESSING', paidAt: null, editedInImsAt: null, baselineQtyByExternalLineId: null, totalForeign: '60.00', currency: 'GBP',
  lines: [line], refundedQtyByLineId: new Map(), shippedQtyByLineId: new Map(), paidInWoo: true, ...over,
})
const wcOrder = (qty: number, extra: Record<string, unknown> = {}): WcFullOrder =>
  ({ id: 9, number: '1009', date_modified_gmt: '2026-11-20T10:00:00', date_paid_gmt: '2026-11-20T09:00:00', total: '60.00', line_items: [{ id: 77, quantity: qty, sku: 'RED' }], ...extra }) as unknown as WcFullOrder
const diff = (field: DivergenceDifference['field'], label: string, woocommerce: string, ims: string): DivergenceDifference => ({ field, label, woocommerce, ims })

type Calls = { tasks: Array<Record<string, unknown>>; refusals: number; claims: number; logs: string[]; gate: number }
function deps(f: AmendmentFacts, over: Partial<AmendmentDeps> & { claimOnce?: boolean; hasLink?: boolean } = {}) {
  const calls: Calls = { tasks: [], refusals: 0, claims: 0, logs: [], gate: 0 }
  const { claimOnce, hasLink, ...rest } = over
  const d: AmendmentDeps = {
    isEnabled: async () => true,
    isUnpaidRewriteEnabled: async () => true,
    rewriteUnpaid: async () => { throw new Error('not under test') },
    recordRefusal: async () => { calls.refusals += 1 },
    resolveRefusals: async () => undefined,
    withOrderLock: async (_o, fn) => fn(),
    loadFacts: async () => ({ ...f }),
    claim: async () => { calls.claims += 1; return claimOnce ? calls.claims === 1 : true },
    releaseClaim: async () => undefined,
    warehouseGate: async () => { calls.gate += 1; return { ok: true, externalOrderId: 'MS-1' } },
    warehouseLink: async () => (hasLink === false ? null : { connector: 'mintsoft', externalOrderId: 'MS-1', externalOrderNumber: 'W-1' }),
    createRefund: async () => ({ success: true }),
    raiseTask: async (task) => { calls.tasks.push(task as unknown as Record<string, unknown>); return true },
    log: async (e) => { calls.logs.push(e.action) },
    ...rest,
  }
  return { d, calls }
}
const reasons = (calls: Calls) => calls.tasks.map((t) => t.reason)

// ---- MED-1 wording ---------------------------------------------------------------------------------------------------------------------------------------

test('MED-1: the part-payment task states what IMS holds against its total and what WooCommerce shows, asks for a decision, and never mentions a gateway', () => {
  const text = wcPartPaymentChangedQuery('W-1', 'SO-9', ['RED: quantity is 7 in WooCommerce against 5 in IMS (2 more)'], { paid: '30.00', wcTotal: '84.00', imsTotal: '60.00', currency: 'GBP' })
  assert.match(text, /IMS holds payments of 30\.00 GBP against a total of 60\.00 GBP; WooCommerce now shows 84\.00 GBP\./)
  assert.match(text, /Decide whether to collect the difference from the customer, refund what is over, or edit the IMS order to match WooCommerce/)
  assert.match(text, /warehouse order W-1/)
  assert.doesNotMatch(text, /gateway|WooCommerce shows it paid/i)
  // Without usable figures it still says so, without inventing numbers.
  const bare = wcPartPaymentChangedQuery(null, 'SO-9', ['x'], { paid: null, wcTotal: null, imsTotal: null, currency: null })
  assert.match(bare, /IMS holds payments against this order that do not cover its total; WooCommerce now shows a changed order\./)
  assert.doesNotMatch(bare, /null|undefined/)
})

test('MED-1: the task for a deposit order uses the part-payment wording; WooCommerce saying paid (or an open paid-block) keeps the gateway wording', async () => {
  const diffs = [diff('LINE_QUANTITY', 'Quantity of RED changed in WooCommerce', '7', '5')]
  const deposit = deps(facts({ imsPaymentUnrecorded: true, imsReceiptTotal: '30.00' }))
  await applyWcOrderAmendment('o1', wcOrder(7, { date_paid_gmt: null, total: '84.00' }), diffs, 'fp', deposit.d)
  assert.match(String(deposit.calls.tasks[0]!.queryText), /IMS holds payments of 30\.00 GBP against a total of 60\.00 GBP; WooCommerce now shows 84\.00 GBP/)
  const woo = deps(facts({ imsPaymentUnrecorded: true, imsReceiptTotal: '30.00' }))
  await applyWcOrderAmendment('o1', wcOrder(7, { total: '84.00' }), diffs, 'fp', woo.d)
  assert.match(String(woo.calls.tasks[0]!.queryText), /WooCommerce shows it paid at 84\.00 GBP/)
  assert.match(String(woo.calls.tasks[0]!.queryText), /Check what the payment gateway charged/)
})

// ---- MED-2: the supersede/episode rule, against a fake task table -------------------------------------------------------------------------------------------

type Row = { id: string; connector: string; orderId: string; reason: string; contentHash: string; status: string; createdAt: number; doneBy?: string }
function fakeTaskTable() {
  const rows: Row[] = []
  let clock = 0
  const client = {
    wmsOperatorTask: {
      findMany: async (args: { where: { orderId: string; reason: string } }) => rows.filter((r) => r.orderId === args.where.orderId && r.reason === args.where.reason).sort((a, b) => b.createdAt - a.createdAt).map((r) => ({ contentHash: r.contentHash })),
      createMany: async (args: { data: Array<{ connector: string; orderId: string; reason: string; contentHash: string }> }) => {
        let count = 0
        for (const d of args.data) {
          if (rows.some((r) => r.orderId === d.orderId && r.reason === d.reason && r.contentHash === d.contentHash)) continue
          rows.push({ id: `t${rows.length + 1}`, connector: d.connector, orderId: d.orderId, reason: d.reason, contentHash: d.contentHash, status: 'OPEN', createdAt: ++clock })
          count += 1
        }
        return { count }
      },
      updateMany: async (args: { where: { orderId: string; reason: string; status: string; contentHash: { not: string } }; data: { status: string; doneBy: string } }) => {
        let count = 0
        for (const r of rows) {
          if (r.orderId === args.where.orderId && r.reason === args.where.reason && r.status === args.where.status && r.contentHash !== args.where.contentHash.not) { r.status = args.data.status; r.doneBy = args.data.doneBy; count += 1 }
        }
        return { count }
      },
    },
  }
  return { rows, client: client as never }
}
const task = (orderId: string, basis: string) => ({ connector: 'mintsoft', orderId, externalOrderId: 'E1', queryText: `text ${basis}`, dedupeBasis: basis })

test('MED-2: raising a paid-increase task closes the order\'s earlier open ones, with the system actor; other orders are untouched', async () => {
  const t = fakeTaskTable()
  assert.equal(await raiseWcPaidIncreaseTask(t.client, task('o1', 'A')), true)
  assert.equal(await raiseWcPaidIncreaseTask(t.client, task('o2', 'A')), true)
  assert.equal(await raiseWcPaidIncreaseTask(t.client, task('o1', 'B')), true)
  const o1 = t.rows.filter((r) => r.orderId === 'o1')
  assert.deepEqual(o1.map((r) => r.status), ['DONE', 'OPEN'])
  assert.equal(o1[0]!.doneBy, WC_PAID_INCREASE_SUPERSEDED_ACTOR)
  assert.equal(t.rows.find((r) => r.orderId === 'o2')!.status, 'OPEN')
})

test('MED-2: a state the order returns to, whose task is Done, raises a fresh task; the same state again raises nothing (open or done)', async () => {
  const t = fakeTaskTable()
  await raiseWcPaidIncreaseTask(t.client, task('o1', 'A'))
  assert.equal(await raiseWcPaidIncreaseTask(t.client, task('o1', 'A')), false, 'the same state, open: one task')
  await raiseWcPaidIncreaseTask(t.client, task('o1', 'B'))
  assert.equal(await raiseWcPaidIncreaseTask(t.client, task('o1', 'A')), true, 'back to A after B: a fresh task')
  assert.equal(t.rows.filter((r) => r.orderId === 'o1').length, 3)
  assert.deepEqual(t.rows.filter((r) => r.status === 'OPEN').map((r) => r.contentHash), [wmsOperatorTaskHash({ reason: 'WC_PAID_INCREASE', queryText: '', dedupeBasis: 'A|episode:1' })])
  assert.equal(await raiseWcPaidIncreaseTask(t.client, task('o1', 'A')), false, 'A again, nothing later: still one')
  t.rows[2]!.status = 'DONE'
  assert.equal(await raiseWcPaidIncreaseTask(t.client, task('o1', 'A')), false, 'a person closed the newest task: the same delivery does not re-raise it')
  assert.equal(await raiseWcPaidIncreaseTask(t.client, task('o1', 'B')), true, 'and a third round (B after A) is again fresh')
  assert.equal(await raiseWcPaidIncreaseTask(t.client, task('o1', 'A')), true)
  assert.equal(t.rows.length, 5)
})

// ---- LOW-7 and LOW-8 ----------------------------------------------------------------------------------------------------------------------------------------

test('LOW-7: a unit reduction on an order paid in WooCommerce only also tells the warehouse once picking has started; before picking, only the money task', async () => {
  const diffs = [diff('LINE_QUANTITY', 'Quantity of RED changed in WooCommerce', '3', '5')]
  const plan = planWcOrderAmendment(wcOrder(3), diffs, facts())
  assert.deepEqual(plan.wcChanges, ['RED quantity is now 3'])
  assert.equal(plan.paidInWooReductions.length, 1)
  const started = deps(facts({ status: 'PICKING' }))
  await applyWcOrderAmendment('o1', wcOrder(3), diffs, 'fp', started.d)
  assert.deepEqual(reasons(started.calls).sort(), ['WC_EDIT_AFTER_PICKING', 'WC_PAID_INCREASE'])
  const before = deps(facts())
  await applyWcOrderAmendment('o1', wcOrder(3), diffs, 'fp', before.d)
  assert.deepEqual(reasons(before.calls), ['WC_PAID_INCREASE'])
})

test('LOW-7: a warehouse that cannot be read does not hold the money task back: it is raised now, no claim is taken, and a re-read is asked for', async () => {
  const diffs = [diff('LINE_QUANTITY', 'Quantity of RED changed in WooCommerce', '3', '5')]
  const { d, calls } = deps(facts(), { warehouseGate: async () => ({ ok: false, externalOrderId: null, unreadable: true }) })
  const out = await applyWcOrderAmendment('o1', wcOrder(3), diffs, 'fp', d)
  assert.equal(out.kind, 'applied')
  assert.equal(out.kind === 'applied' && out.retry, true)
  assert.deepEqual(reasons(calls), ['WC_PAID_INCREASE'])
  assert.equal(calls.claims, 0, 'a claim would turn the re-read away as already acted on')
  // An order whose gate is unreadable and that has NO money task still waits (nothing to say yet).
  const plain = deps(facts({ paidInWoo: false, paidAt: new Date() }), { warehouseGate: async () => ({ ok: false, externalOrderId: null, unreadable: true }) })
  const waits = await applyWcOrderAmendment('o1', wcOrder(3), diffs, 'fp', plain.d)
  assert.deepEqual(waits, { kind: 'skipped', retry: true, reason: 'the warehouse state could not be read (retried by a live re-read)' })
})

test('LOW-8: on an order paid in WooCommerce only, a shipping, discount or tax change alone raises the money task, directed by what it does to the total', async () => {
  const shipping = [diff('SHIPPING', 'Shipping (excluding tax) changed in WooCommerce', '9.00', '5.00'), diff('TOTAL', 'Order total (including tax) changed in WooCommerce', '64.00', '60.00')]
  const plan = planWcOrderAmendment(wcOrder(5), shipping, facts())
  assert.equal(plan.increases[0], 'Shipping (excluding tax) changed in WooCommerce: WooCommerce 9.00, IMS 5.00')
  assert.match(plan.increases[1]!, /Order total \(including tax\) is 64\.00 in WooCommerce against 60\.00 in IMS \(4\.00 more\)/)
  const discount = planWcOrderAmendment(wcOrder(5), [diff('DISCOUNT', 'Discount (excluding tax) changed in WooCommerce', '10.00', '0.00')], facts())
  assert.equal(discount.paidInWooReductions.length, 1, 'a bigger discount means the customer pays less')
  const taxDown = planWcOrderAmendment(wcOrder(5), [diff('TAX', 'Tax total changed in WooCommerce', '1.00', '3.00')], facts())
  assert.equal(taxDown.paidInWooReductions.length, 1)
  const { d, calls } = deps(facts())
  const out = await applyWcOrderAmendment('o1', wcOrder(5, { total: '64.00' }), shipping, 'fp', d)
  assert.equal(out.kind, 'applied')
  assert.deepEqual(reasons(calls), ['WC_PAID_INCREASE'])
  assert.match(String(calls.tasks[0]!.queryText), /Shipping \(excluding tax\) changed in WooCommerce: WooCommerce 9\.00, IMS 5\.00/)
})

test('LOW-8: the same change raises nothing after an IMS edit (no baseline to attribute it), on an order paid in IMS, or on an unpaid one', () => {
  const ship = [diff('SHIPPING', 'Shipping (excluding tax) changed in WooCommerce', '9.00', '5.00')]
  for (const f of [facts({ editedInImsAt: new Date() }), facts({ paidAt: new Date(), paidInWoo: false }), facts({ paidInWoo: false })]) {
    const plan = planWcOrderAmendment(wcOrder(5), ship, f)
    assert.equal(plan.increases.length + plan.paidInWooReductions.length, 0)
  }
})

// ---- LOW-4: the edited-in-IMS refusal is recorded once per divergence fingerprint -------------------------------------------------------------------------

test('LOW-4: an unpaid order edited in IMS that differs in price/shipping/discount is refused and warned ONCE per fingerprint, not on every delivery', async () => {
  const f = facts({ paidAt: null, paidInWoo: false, editedInImsAt: new Date('2026-11-19T00:00:00Z'), baselineQtyByExternalLineId: new Map([[77, 5]]) })
  const diffs = [diff('SHIPPING', 'Shipping (excluding tax) changed in WooCommerce', '9.00', '5.00')]
  const { d, calls } = deps(f, { claimOnce: true })
  const wc = wcOrder(5, { date_paid_gmt: null })
  const first = await applyWcOrderAmendment('o1', wc, diffs, 'fp-1', d)
  assert.equal(first.kind, 'skipped')
  assert.equal(calls.refusals, 1)
  assert.equal(calls.logs.filter((l) => l === 'wc_order_unpaid_rewrite_refused').length, 1)
  for (let i = 0; i < 3; i++) await applyWcOrderAmendment('o1', wc, diffs, 'fp-1', d)
  assert.equal(calls.refusals, 1, 'redeliveries of the same difference record nothing more')
  assert.equal(calls.logs.filter((l) => l === 'wc_order_unpaid_rewrite_refused').length, 1)
  assert.equal(calls.claims, 4, 'each delivery asked; only the first was new')
})

// ---- LOW-6 ---------------------------------------------------------------------------------------------------------------------------------------------------

test('LOW-6: a payload that states no currency is refused as such (not as "the currency differs"); a stated different currency keeps its wording', () => {
  const base = (currency: unknown) => ({ wc: { currency }, stored: { editedInImsAt: null, currency: 'GBP' } }) as unknown as RewriteInput
  const none = planUnpaidRewrite(base(undefined))
  assert.equal('ok' in none && none.ok === false && none.code, 'CURRENCY')
  assert.match('detail' in none ? none.detail : '', /states no currency/)
  assert.doesNotMatch('detail' in none ? none.detail : '', /differs/)
  const other = planUnpaidRewrite(base('eur'))
  assert.match('detail' in other ? other.detail : '', /the currency differs \(WooCommerce EUR, IMS GBP\)/)
})

// ---- LOW-3 and LOW-12 -----------------------------------------------------------------------------------------------------------------------------------------

test('LOW-3: a failed drain puts a warning on the sweep result, keeping earlier warnings; a drain that did not fail adds none', () => {
  const failed: { warnings?: string[] } = { warnings: ['earlier'] }
  noteDrainOutcome(failed, { failed: true })
  assert.deepEqual(failed.warnings, ['earlier', DRAIN_FAILED_WARNING])
  const bare: { warnings?: string[] } = {}
  noteDrainOutcome(bare, { failed: true })
  assert.deepEqual(bare.warnings, [DRAIN_FAILED_WARNING])
  const ok: { warnings?: string[] } = {}
  noteDrainOutcome(ok, {})
  noteDrainOutcome(ok, { failed: false })
  assert.equal(ok.warnings, undefined)
})

test('LOW-3: the wc-reconcile cron outcome reads orders.warnings as a failed run (so it reaches the cron monitor and alerting); an empty or absent list stays ok', () => {
  const outcome = cronOutcomes['wc-reconcile']
  const withOrders = (orders: Record<string, unknown>) => outcome({ orders: { synced: 3, skipped: 0, errors: [], ...orders } } as never)
  assert.equal(withOrders({ warnings: [DRAIN_FAILED_WARNING] }), 'failed')
  assert.equal(withOrders({ warnings: [] }), 'ok')
  assert.equal(withOrders({}), 'ok')
  assert.equal(outcome({ orders: { skipped: true, reason: 'webhook_primary_active', reconciliationDue: false, lastReconciledAt: null } } as never), 'ok', 'a skipped orders section carries no warnings')
  assert.equal(outcome({ skipped: true, reason: 'WC sync disabled' } as never), 'skipped')
  assert.equal(outcome({} as never), 'ok')
})

test('LOW-12: the header tax-rate lock may miss only a rate name that matched no active rate when the payload was mapped', () => {
  assert.deepEqual(headerRateLockOptions(['r1', null], true), { lineRateIds: ['r1', null], allowMissing: false })
  assert.deepEqual(headerRateLockOptions([], false), { lineRateIds: [], allowMissing: true })
})

test('LOW-12: the order sweep reports the drain outcome on its own result, straight after the drain', () => {
  const src = readFileSync('lib/connectors/woocommerce/sync/order-import.ts', 'utf8')
  const drain = src.indexOf('const drained = await drainDeferredWcOrderDivergences()')
  assert.ok(drain > 0)
  assert.equal(src.split('noteDrainOutcome(result, drained)').length - 1, 1)
  assert.ok(src.indexOf('noteDrainOutcome(result, drained)') > drain, 'after the drain, on the sweep\'s own `result`')
})
