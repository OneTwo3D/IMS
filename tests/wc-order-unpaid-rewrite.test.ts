import assert from 'node:assert/strict'
import test from 'node:test'
import { applyWcOrderAmendment, planWcOrderAmendment, wcChangedSinceBaseline, WC_PAID_INCREASE_GATE, WC_REWRITE_AFTER_PICKING_GATE, WC_REWRITE_REFUSED_GATE, type AmendmentDeps, type AmendmentFacts } from '@/lib/connectors/woocommerce/sync/order-amendment'
import { invoiceEvidence, planUnpaidRewrite, type RewriteInput, type RewriteOutcome, type RewritePlan, type RewriteRefusal } from '@/lib/connectors/woocommerce/sync/order-unpaid-rewrite'
import type { DivergenceDifference } from '@/lib/connectors/woocommerce/sync/order-divergence'
import type { WcFullOrder } from '@/lib/connectors/woocommerce/sync/types'

// o3d-zvec.7: the unpaid-order rewrite (owner ruling 2026-11-20) and the paid-order increase task. No network, no database: every dependency is injected.

type Item = { id: number; sku: string; pid: string | null; qty: number; subtotal: string; total: string; tax: string }
const round = (n: number, dp: number) => Number(n.toFixed(dp))

/** What mapWcLineItems makes of an item (unit price = subtotal / quantity to six places, discount = subtotal - total, tax as stated). */
function mapItem(i: Item) {
  const subtotal = Number(i.subtotal)
  const total = Number(i.total)
  return {
    productId: i.pid, sku: i.sku, description: `Desc ${i.sku}`, qty: i.qty, unitPriceForeign: round(subtotal / i.qty, 6), discountAmount: round(Math.max(0, subtotal - total), 4),
    discountStr: subtotal - total > 0 ? (subtotal - total).toFixed(2) : null, taxForeign: round(Number(i.tax), 4), externalTaxRateId: 5, externalLineItemId: i.id, wcCustomsUnitValue: null,
  }
}
const wcItem = (i: Item) => ({ id: i.id, name: `Desc ${i.sku}`, product_id: 1, variation_id: 0, quantity: i.qty, subtotal: i.subtotal, total: i.total, total_tax: i.tax, sku: i.sku, taxes: [], meta_data: [] })

const A: Item = { id: 11, sku: 'RED', pid: 'p-red', qty: 2, subtotal: '20.00', total: '20.00', tax: '4.00' }
const B: Item = { id: 12, sku: 'BLU', pid: 'p-blu', qty: 1, subtotal: '5.00', total: '5.00', tax: '1.00' }

const storedLine = (i: Item, id: string) => ({ id, externalLineItemId: i.id, productId: i.pid, sku: i.sku, qty: i.qty, unitPriceForeign: round(Number(i.subtotal) / i.qty, 6), discountAmount: round(Math.max(0, Number(i.subtotal) - Number(i.total)), 4), taxForeign: Number(i.tax), totalForeign: Number(i.total), taxRateId: 'rate-20' })

type Over = { items?: Item[]; shipping?: string; shippingTax?: string; total?: string; totalTax?: string; taxLines?: Array<{ tax_total: string; shipping_tax_total: string }>; currency?: string; orderLevelDiscount?: number; storedOver?: Partial<RewriteInput['stored']>; storeCredit?: number; fees?: number; blocked?: boolean; couponRefusal?: boolean; taxRateIds?: Array<string | null> }
function input(o: Over = {}): RewriteInput {
  const items = o.items ?? [A, B]
  const lineNet = items.reduce((s, i) => s + Number(i.total), 0)
  const lineTax = items.reduce((s, i) => s + Number(i.tax), 0)
  const shipping = Number(o.shipping ?? '4.00')
  const shippingTax = Number(o.shippingTax ?? '0.80')
  const totalTax = o.totalTax ?? (lineTax + shippingTax).toFixed(2)
  const total = o.total ?? (lineNet + shipping + Number(totalTax) - (o.orderLevelDiscount ?? 0)).toFixed(2)
  return {
    wc: {
      currency: o.currency ?? 'GBP', line_items: items.map(wcItem) as never, fee_lines: Array.from({ length: o.fees ?? 0 }, () => ({})) as never,
      shipping_lines: [{ id: 1, method_title: 'Flat', method_id: 'flat_rate', total: shipping.toFixed(2), total_tax: shippingTax.toFixed(2), taxes: [] }] as never,
      tax_lines: (o.taxLines ?? [{ tax_total: lineTax.toFixed(2), shipping_tax_total: shippingTax.toFixed(2) }]) as never,
      shipping_total: shipping.toFixed(2), total, total_tax: totalTax,
    },
    stored: {
      currency: 'GBP', fxRateToBase: 1, storeCreditForeign: o.storeCredit ?? 0, discountModel: 'LINE_ALLOCATED', editedInImsAt: null, totalForeign: '34.80', shippingForeign: '4.00', taxForeign: '5.80', discountAmount: 0,
      lines: [storedLine(A, 'l-red'), storedLine(B, 'l-blu')], ...o.storedOver,
    },
    mapped: items.map(mapItem),
    taxRateIds: o.taxRateIds ?? items.map(() => 'rate-20'),
    taxFallbackBlocked: o.blocked ?? false,
    header: { taxRateName: 'Standard', taxRatePercent: 0.2 },
    coupon: { refusal: o.couponRefusal ?? false, storeCreditForeign: 0, orderLevelDiscount: o.orderLevelDiscount ?? 0, unallocated: 0, discountStr: null },
    shipping: { shippingService: 'Flat', courierKey: null, shippingMethodId: 'flat_rate' },
  }
}
const ok = (r: RewritePlan | RewriteRefusal): RewritePlan => { assert.equal(r.ok, true, JSON.stringify(r)); return r as RewritePlan }
const refused = (r: RewritePlan | RewriteRefusal): RewriteRefusal => { assert.equal(r.ok, false, 'expected a refusal'); return r as RewriteRefusal }

test('an identical order is an echo: nothing to write', () => {
  const plan = ok(planUnpaidRewrite(input()))
  assert.equal(plan.unchanged, true)
  assert.equal(plan.lines.create.length + plan.lines.deleteIds.length, 0)
})

test('a quantity change: the line is updated in place with WooCommerce\'s own figures', () => {
  const edited: Item = { ...A, qty: 5, subtotal: '50.00', total: '50.00', tax: '10.00' }
  const plan = ok(planUnpaidRewrite(input({ items: [edited, B], shipping: '4.00', shippingTax: '0.80' })))
  assert.equal(plan.unchanged, false)
  assert.equal(plan.lines.update.length, 2)
  const u = plan.lines.update.find((l) => l.lineId === 'l-red')!
  assert.equal(u.data.qty, 5)
  assert.equal(u.data.totalForeign, 50)
  assert.equal(u.data.taxForeign, 10)
  assert.equal(plan.order.totalForeign, 70.8)
  assert.equal(plan.order.taxForeign, 11.8)
  assert.equal(plan.order.subtotalForeign, 55)
  assert.match(plan.summary.join(' '), /RED: quantity 2 to 5/)
})

test('a price change and a line add and a removal in one edit', () => {
  const repriced: Item = { ...A, subtotal: '30.00', total: '30.00', tax: '6.00' } // 15 each
  const added: Item = { id: 13, sku: 'GRN', pid: 'p-grn', qty: 1, subtotal: '8.00', total: '8.00', tax: '1.60' }
  const plan = ok(planUnpaidRewrite(input({ items: [repriced, added] }))) // B removed
  assert.deepEqual(plan.lines.deleteIds, ['l-blu'])
  assert.equal(plan.lines.create.length, 1)
  assert.equal(plan.lines.create[0]!.sku, 'GRN')
  assert.equal(plan.lines.create[0]!.productId, 'p-grn')
  const u = plan.lines.update[0]!
  assert.equal(u.lineId, 'l-red')
  assert.equal(u.data.unitPriceForeign, 15)
  assert.equal(plan.order.subtotalForeign, 38)
  assert.equal(plan.order.totalForeign, 50.4) // lines 38 + shipping 4 + tax (6 + 1.6 + 0.8)
  assert.match(plan.summary.join(' '), /added 1 x GRN/)
  assert.match(plan.summary.join(' '), /removed 1 x BLU/)
})

test('a tax and discount mix: the discount is WooCommerce\'s (subtotal - total) and the stored total is WooCommerce\'s total, never qty x unit - discount', () => {
  // 3 units, subtotal 10.00 (3.333333 each), coupon takes 1.00 off the line, so total 9.00; qty x unit (9.999999) would be re-pricing.
  const mixed: Item = { id: 11, sku: 'RED', pid: 'p-red', qty: 3, subtotal: '10.00', total: '9.00', tax: '1.80' }
  const plan = ok(planUnpaidRewrite(input({ items: [mixed], shipping: '0.00', shippingTax: '0.00' })))
  const d = plan.lines.update[0]!.data
  assert.equal(d.unitPriceForeign, 3.333333)
  assert.equal(d.discountAmount, 1)
  assert.equal(d.totalForeign, 9)
  assert.equal(d.taxForeign, 1.8)
  assert.equal(plan.order.totalForeign, 10.8)
  assert.deepEqual(plan.lines.deleteIds, ['l-blu'])
})

test('base amounts use the order\'s own booked rate', () => {
  const plan = ok(planUnpaidRewrite(input({ storedOver: { fxRateToBase: 1.25 } })))
  const same = plan.lines.update.find((l) => l.lineId === 'l-red')!.data
  assert.equal(same.totalBase, 16)
  assert.equal(plan.order.totalBase, 27.84)
})

test('REFUSED: a tax mismatch (the lines\' tax and WooCommerce\'s own tax total disagree) writes nothing', () => {
  const r = refused(planUnpaidRewrite(input({ totalTax: '6.30', total: '35.30' })))
  assert.equal(r.code, 'TAX_MISMATCH')
  const lines = refused(planUnpaidRewrite(input({ taxLines: [{ tax_total: '4.00', shipping_tax_total: '0.80' }] })))
  assert.equal(lines.code, 'TAX_MISMATCH', 'the tax lines say less than the tax total')
  assert.equal(refused(planUnpaidRewrite(input({ blocked: true }))).code, 'TAX_RATE_UNMAPPED')
})

test('REFUSED: a total that does not reconcile, a currency difference, an unknown SKU', () => {
  assert.equal(refused(planUnpaidRewrite(input({ total: '40.00' }))).code, 'TOTAL_MISMATCH')
  assert.equal(refused(planUnpaidRewrite(input({ currency: 'EUR' }))).code, 'CURRENCY')
  assert.equal(refused(planUnpaidRewrite(input({ currency: '' }))).code, 'CURRENCY')
  const unknown: Item = { ...A, pid: null }
  const r = refused(planUnpaidRewrite(input({ items: [unknown, B] })))
  assert.equal(r.code, 'UNKNOWN_SKU')
  assert.match(r.detail, /RED/)
})

test('REFUSED: everything else that cannot be mapped exactly', () => {
  assert.equal(refused(planUnpaidRewrite(input({ storedOver: { editedInImsAt: new Date() } }))).code, 'EDITED_IN_IMS')
  assert.equal(refused(planUnpaidRewrite(input({ storeCredit: 5 }))).code, 'STORE_CREDIT')
  assert.equal(refused(planUnpaidRewrite(input({ couponRefusal: true }))).code, 'COUPON')
  assert.equal(refused(planUnpaidRewrite(input({ fees: 1 }))).code, 'FEE_LINES')
  assert.equal(refused(planUnpaidRewrite(input({ items: [] }))).code, 'NO_LINES')
  assert.equal(refused(planUnpaidRewrite(input({ storedOver: { discountModel: null } }))).code, 'DISCOUNT_MODEL')
  const base = input()
  assert.equal(refused(planUnpaidRewrite({ ...base, stored: { ...base.stored, lines: [...base.stored.lines, { ...storedLine(B, 'l-fee'), externalLineItemId: null }] } })).code, 'UNMAPPED_LINE')
  assert.equal(refused(planUnpaidRewrite({ ...base, stored: { ...base.stored, lines: [...base.stored.lines, storedLine(B, 'l-dup')] } })).code, 'UNMAPPED_LINE')
  assert.equal(refused(planUnpaidRewrite({ ...base, stored: { ...base.stored, fxRateToBase: 0 } })).code, 'FX_RATE')
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// The step (applyWcOrderAmendment) with injected dependencies
// ---------------------------------------------------------------------------------------------------------------------------------------

const wcOrder = (modified = '2026-11-20T10:00:00'): WcFullOrder => ({ id: 9, number: '1009', date_modified_gmt: modified, line_items: [{ id: 77, quantity: 3, sku: 'RED' }] }) as unknown as WcFullOrder
const line = { id: 'l1', externalLineItemId: 77, productId: 'p1', sku: 'RED', description: 'Red', qty: 5, totalForeign: 50, totalBase: 40 }
const facts = (over: Partial<AmendmentFacts> = {}): AmendmentFacts => ({
  orderNumber: 'SO-9', status: 'PROCESSING', paidAt: null, editedInImsAt: null, baselineQtyByExternalLineId: null,
  lines: [line], refundedQtyByLineId: new Map(), shippedQtyByLineId: new Map(), ...over,
})
const diffs: DivergenceDifference[] = [{ field: 'LINE_QUANTITY', label: 'Quantity of RED changed in WooCommerce', woocommerce: '3', ims: '5' }]

function deps(f: AmendmentFacts | null, over: Partial<AmendmentDeps> & { rewrite?: RewriteOutcome; writeOn?: boolean; rewriteOn?: boolean; hasLink?: boolean } = {}) {
  const calls = { rewrites: [] as Array<string | null>, refusals: [] as Array<{ gate: string; action: string; detail?: string | null }>, resolved: [] as string[], tasks: [] as Array<Record<string, unknown>>, gate: 0, claims: 0, released: 0, refunds: 0, logs: [] as string[] }
  const { rewrite, writeOn, rewriteOn, hasLink, ...rest } = over
  const d: AmendmentDeps = {
    isEnabled: async () => writeOn ?? false,
    isUnpaidRewriteEnabled: async () => rewriteOn ?? true,
    rewriteUnpaid: async (_o, _w, expected) => { calls.rewrites.push(expected); return rewrite ?? { kind: 'rewritten', summary: ['x'], unallocatedQty: 0 } },
    recordRefusal: async (r) => { calls.refusals.push({ gate: r.gate, action: r.action, detail: r.detail }) },
    resolveRefusals: async (_o, _a, gate) => { calls.resolved.push(gate) },
    withOrderLock: async (_o, fn) => fn(),
    loadFacts: async () => f,
    claim: async () => { calls.claims += 1; return calls.claims === 1 },
    releaseClaim: async () => { calls.released += 1 },
    warehouseGate: async () => { calls.gate += 1; return { ok: true, externalOrderId: 'MS-1' } },
    warehouseLink: async () => (hasLink === false ? null : { connector: 'mintsoft', externalOrderId: 'MS-1', externalOrderNumber: 'W-1' }),
    createRefund: async () => { calls.refunds += 1; return { success: true } },
    raiseTask: async (task) => { calls.tasks.push(task as unknown as Record<string, unknown>); return true },
    log: async (e) => { calls.logs.push(e.action) },
    ...rest,
  }
  return { d, calls }
}

test('SWITCH OFF does nothing: with both switches off nothing is read, rewritten, refunded or raised', async () => {
  const { d, calls } = deps(facts(), { writeOn: false, rewriteOn: false, loadFacts: async () => { throw new Error('must not read') } })
  assert.deepEqual(await applyWcOrderAmendment('o1', wcOrder(), diffs, 'fp', d), { kind: 'off' })
  assert.equal(calls.rewrites.length + calls.tasks.length + calls.refunds + calls.claims, 0)
})

test('with the rewrite switch OFF an unpaid order is not rewritten (the old behaviour stands, behind the write switch)', async () => {
  const { d, calls } = deps(facts(), { writeOn: true, rewriteOn: false })
  assert.equal((await applyWcOrderAmendment('o1', wcOrder(), diffs, 'fp', d)).kind, 'skipped')
  assert.equal(calls.rewrites.length, 0)
  assert.equal(calls.refunds, 0)
})

test('the rewrite switch ON, order UNPAID, warehouse can still take a change: the order is rewritten, the claim is held, an earlier refusal is overtaken', async () => {
  const { d, calls } = deps(facts())
  assert.deepEqual(await applyWcOrderAmendment('o1', wcOrder(), diffs, 'fp', d), { kind: 'applied', refundedLines: 0, taskRaised: false })
  assert.deepEqual(calls.rewrites, ['MS-1'], 'the warehouse order the gate answered for is handed to the transaction')
  assert.equal(calls.gate, 1)
  assert.equal(calls.claims, 1)
  assert.equal(calls.released, 0)
  assert.ok(calls.resolved.includes(WC_REWRITE_REFUSED_GATE))
  assert.equal(calls.tasks.length, 0)
})

test('an order with no warehouse order yet is rewritten without asking the warehouse', async () => {
  const { d, calls } = deps(facts(), { hasLink: false })
  assert.equal((await applyWcOrderAmendment('o1', wcOrder(), diffs, 'fp', d)).kind, 'applied')
  assert.equal(calls.gate, 0)
  assert.deepEqual(calls.rewrites, [null])
})

test('AT PICKING (IMS status) and AFTER PICKING (the warehouse gate says closed): an operator task, never a rewrite', async () => {
  const picking = deps(facts({ status: 'PICKING' }))
  assert.deepEqual(await applyWcOrderAmendment('o1', wcOrder(), diffs, 'fp', picking.d), { kind: 'applied', refundedLines: 0, taskRaised: true })
  assert.equal(picking.calls.rewrites.length, 0)
  assert.equal(picking.calls.gate, 0, 'IMS already knows picking started')
  assert.equal(picking.calls.tasks[0]!.reason, 'WC_EDIT_AFTER_PICKING')
  assert.match(String(picking.calls.tasks[0]!.queryText), /Quantity of RED changed in WooCommerce: WooCommerce 3/)

  const closed = deps(facts(), { warehouseGate: async () => ({ ok: false, externalOrderId: null }) })
  assert.equal((await applyWcOrderAmendment('o1', wcOrder(), diffs, 'fp', closed.d)).kind, 'applied')
  assert.equal(closed.calls.rewrites.length, 0)
  assert.equal(closed.calls.tasks.length, 1)

  const noLink = deps(facts({ status: 'PICKING' }), { hasLink: false })
  await applyWcOrderAmendment('o1', wcOrder(), diffs, 'fp', noLink.d)
  assert.equal(noLink.calls.tasks.length, 0)
  assert.equal(noLink.calls.refusals[0]!.gate, WC_REWRITE_AFTER_PICKING_GATE, 'no warehouse order to carry a task: a visible refused action')
})

test('a gate that cannot be READ rewrites nothing, takes no claim and asks for a live re-read', async () => {
  const { d, calls } = deps(facts(), { warehouseGate: async () => ({ ok: false, externalOrderId: null, unreadable: true }) })
  const out = await applyWcOrderAmendment('o1', wcOrder(), diffs, 'fp', d)
  assert.equal(out.kind === 'skipped' && out.retry, true)
  assert.equal(calls.rewrites.length + calls.claims + calls.tasks.length, 0)
})

test('REFUSED by the rewrite: a refused action (Sync > Exceptions), the claim is released so a later delivery retries, nothing else happens', async () => {
  const { d, calls } = deps(facts(), { rewrite: { kind: 'refused', code: 'UNKNOWN_SKU', detail: 'IMS holds no product for the SKU RED' } })
  const out = await applyWcOrderAmendment('o1', wcOrder(), diffs, 'fp', d)
  assert.equal(out.kind, 'skipped')
  assert.equal(calls.refusals.length, 1)
  assert.equal(calls.refusals[0]!.gate, WC_REWRITE_REFUSED_GATE)
  assert.equal(calls.refusals[0]!.action, 'WC_ORDER_REWRITE')
  assert.match(String(calls.refusals[0]!.detail), /IMS holds no product for the SKU RED/)
  assert.equal(calls.released, 1)
  assert.equal(calls.refunds + calls.tasks.length, 0)
})

test('a paid order is never rewritten: with only the rewrite switch on, a paid order does nothing at all; with the write switch on it takes the paid-order path', async () => {
  const off = deps(facts({ paidAt: new Date('2026-11-18T00:00:00Z') }), { writeOn: false, rewriteOn: true })
  assert.deepEqual(await applyWcOrderAmendment('o1', wcOrder(), diffs, 'fp', off.d), { kind: 'off' })
  assert.equal(off.calls.rewrites.length + off.calls.refunds + off.calls.claims, 0)
  const on = deps(facts({ paidAt: new Date('2026-11-18T00:00:00Z') }), { writeOn: true, rewriteOn: true })
  await applyWcOrderAmendment('o1', wcOrder(), diffs, 'fp', on.d)
  assert.equal(on.calls.rewrites.length, 0)
  assert.equal(on.calls.refunds, 1, 'the paid reduction goes through the refund path, as before')
})

test('ECHO / STALE / SAME-SECOND: a stale delivery and a same-second conflict rewrite nothing; a repeated delivery of the same difference rewrites once', async () => {
  const stale = deps(facts({ externalUpdatedAt: new Date('2026-11-20T11:00:00Z') }))
  const out = await applyWcOrderAmendment('o1', wcOrder('2026-11-20T10:00:00'), diffs, 'fp', stale.d)
  assert.equal(out.kind, 'skipped')
  assert.equal(stale.calls.rewrites.length + stale.calls.claims, 0)

  const same = deps(facts())
  const sameOut = await applyWcOrderAmendment('o1', wcOrder(), diffs, 'fp', same.d, { sameSecondConflict: true })
  assert.equal(sameOut.kind === 'skipped' && sameOut.retry, true)
  assert.equal(same.calls.rewrites.length + same.calls.claims, 0)

  const echo = deps(facts())
  await applyWcOrderAmendment('o1', wcOrder(), diffs, 'fp', echo.d)
  assert.equal((await applyWcOrderAmendment('o1', wcOrder(), diffs, 'fp', echo.d)).kind, 'skipped', 'the second delivery loses the claim')
  assert.equal(echo.calls.rewrites.length, 1)
})

test('a thrown rewrite releases the claim and is swallowed (the delivery\'s real work is committed)', async () => {
  const { d, calls } = deps(facts(), { rewriteUnpaid: async () => { throw new Error('db down') } })
  const orig = console.error
  console.error = () => undefined
  try {
    assert.equal((await applyWcOrderAmendment('o1', wcOrder(), diffs, 'fp', d)).kind, 'skipped')
  } finally { console.error = orig }
  assert.equal(calls.released >= 1, true)
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// A PAID order INCREASE: IMS changes nothing; an operator task names the lines and the difference
// ---------------------------------------------------------------------------------------------------------------------------------------

const paid = new Date('2026-11-18T00:00:00Z')
const wcPaid = (qty: number): WcFullOrder => ({ id: 9, number: '1009', date_modified_gmt: '2026-11-20T10:00:00', line_items: [{ id: 77, quantity: qty, sku: 'RED' }] }) as unknown as WcFullOrder
const up: DivergenceDifference[] = [
  { field: 'LINE_QUANTITY', label: 'Quantity of RED changed in WooCommerce', woocommerce: '7', ims: '5' },
  { field: 'TOTAL', label: 'Order total (including tax) changed in WooCommerce', woocommerce: '84.00', ims: '60.00' },
]

test('PAID order, quantity UP: a task names the line and the difference; no refund, no rewrite, the order is untouched', async () => {
  const { d, calls } = deps(facts({ paidAt: paid }), { writeOn: true, rewriteOn: true })
  const out = await applyWcOrderAmendment('o1', wcPaid(7), up, 'fp', d)
  assert.deepEqual(out, { kind: 'applied', refundedLines: 0, taskRaised: true })
  assert.equal(calls.refunds, 0)
  assert.equal(calls.rewrites.length, 0)
  assert.equal(calls.tasks.length, 1)
  assert.equal(calls.tasks[0]!.reason, 'WC_PAID_INCREASE', 'its own reason: it is not a warehouse change')
  const text = String(calls.tasks[0]!.queryText)
  assert.match(text, /RED: quantity is 7 in WooCommerce against 5 in IMS \(2 more\)/)
  assert.match(text, /Order total \(including tax\) is 84\.00 in WooCommerce against 60\.00 in IMS \(24\.00 more\)/)
  assert.match(text, /IMS changed nothing/)
  assert.match(text, /collect the difference/)
  assert.doesNotMatch(text, /make the change there/, 'never tells the warehouse to apply it')
})

test('PAID order: an ADDED item and a HIGHER unit price are increases; a LOWER unit price is not', () => {
  const added: DivergenceDifference[] = [{ field: 'LINE_ADDED', label: 'Item GRN was added in WooCommerce', woocommerce: '1 x GRN at 8.00 each', ims: 'not on the order' }]
  assert.deepEqual(planWcOrderAmendment(wcPaid(5), added, facts({ paidAt: paid })).increases, ['Item GRN was added in WooCommerce: WooCommerce 1 x GRN at 8.00 each'])
  const higher: DivergenceDifference[] = [{ field: 'LINE_PRICE', label: 'Unit price (excluding tax) of RED changed in WooCommerce', woocommerce: '12.00', ims: '10.00' }]
  assert.equal(planWcOrderAmendment(wcPaid(5), higher, facts({ paidAt: paid })).increases.length, 1)
  const lower: DivergenceDifference[] = [{ field: 'LINE_PRICE', label: 'Unit price (excluding tax) of RED changed in WooCommerce', woocommerce: '8.00', ims: '10.00' }]
  assert.equal(planWcOrderAmendment(wcPaid(5), lower, facts({ paidAt: paid })).increases.length, 0)
  assert.equal(planWcOrderAmendment(wcPaid(5), [], facts({ paidAt: paid })).increases.length, 0)
  // An unpaid order's differences are never "paid increases" (the rewrite, or the list, handles them).
  assert.equal(planWcOrderAmendment(wcPaid(7), up, facts({ paidAt: null })).increases.length, 0)
})

test('PAID increase, picking started: the same task path (nothing is sent), and with no warehouse order a refused action makes it visible', async () => {
  const picking = deps(facts({ paidAt: paid, status: 'PICKING' }), { writeOn: true })
  await applyWcOrderAmendment('o1', wcPaid(7), up, 'fp', picking.d)
  assert.equal(picking.calls.tasks.length, 1)
  assert.equal(picking.calls.tasks[0]!.reason, 'WC_PAID_INCREASE', 'even when picking has started, an increase is never a "change it in the warehouse" task')
  assert.equal(picking.calls.refunds, 0)

  const noLink = deps(facts({ paidAt: paid }), { writeOn: true, hasLink: false })
  await applyWcOrderAmendment('o1', wcPaid(7), up, 'fp', noLink.d)
  assert.equal(noLink.calls.tasks.length, 0)
  assert.equal(noLink.calls.refusals.length, 1)
  assert.equal(noLink.calls.refusals[0]!.gate, WC_PAID_INCREASE_GATE)
  assert.match(String(noLink.calls.refusals[0]!.detail), /quantity is 7 in WooCommerce against 5/)
})

test('PAID increase with the write switch OFF does nothing', async () => {
  const { d, calls } = deps(facts({ paidAt: paid }), { writeOn: false, rewriteOn: false })
  assert.deepEqual(await applyWcOrderAmendment('o1', wcPaid(7), up, 'fp', d), { kind: 'off' })
  assert.equal(calls.tasks.length, 0)
})

test('PAID increase is raised once: the task dedupes on the lines, a repeat delivery loses the claim', async () => {
  const { d, calls } = deps(facts({ paidAt: paid }), { writeOn: true })
  await applyWcOrderAmendment('o1', wcPaid(7), up, 'fp', d)
  assert.equal((await applyWcOrderAmendment('o1', wcPaid(7), up, 'fp', d)).kind, 'skipped')
  assert.equal(calls.tasks.length, 1)
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// R1 review: paid in WooCommerce, invoice evidence, latest edit wins, mutants
// ---------------------------------------------------------------------------------------------------------------------------------------

const wcPaidDate = (qty: number): WcFullOrder => ({ ...(wcPaid(qty) as object), date_paid_gmt: '2026-11-20T09:00:00' }) as unknown as WcFullOrder

test('H1: paid in WooCommerce (a paid date) while IMS has no paid state: never rewritten; the increase is a task; with only the rewrite switch on nothing happens', async () => {
  const { d, calls } = deps(facts({ paidAt: null }), { writeOn: true, rewriteOn: true })
  await applyWcOrderAmendment('o1', wcPaidDate(7), up, 'fp', d)
  assert.equal(calls.rewrites.length, 0)
  assert.equal(calls.tasks.length, 1)
  assert.equal(calls.tasks[0]!.reason, 'WC_PAID_INCREASE')
  assert.equal(calls.refunds, 0, 'no refund: IMS has not recorded a payment')
  const rewriteOnly = deps(facts({ paidAt: null }), { writeOn: false, rewriteOn: true })
  assert.deepEqual(await applyWcOrderAmendment('o1', wcPaidDate(7), up, 'fp', rewriteOnly.d), { kind: 'off' })
  assert.equal(rewriteOnly.calls.rewrites.length + rewriteOnly.calls.claims, 0)
})

test('H1: an open paid-block obligation counts as paid too (the receipt is still to be recorded at the gateway\'s total)', async () => {
  const { d, calls } = deps(facts({ paidAt: null, paidBlockOpen: true }), { writeOn: true, rewriteOn: true })
  await applyWcOrderAmendment('o1', wcPaid(7), up, 'fp', d)
  assert.equal(calls.rewrites.length, 0)
  assert.equal(calls.tasks[0]!.reason, 'WC_PAID_INCREASE')
  const off = deps(facts({ paidAt: null, paidBlockOpen: true }), { writeOn: false, rewriteOn: true })
  assert.deepEqual(await applyWcOrderAmendment('o1', wcPaid(7), up, 'fp', off.d), { kind: 'off' })
})

test('M5: every piece of invoice evidence is exactly one refusal, and nothing else is', () => {
  const none: Parameters<typeof invoiceEvidence>[0] = { accountingInvoiceId: null, invoiceNumber: null, invoicedAt: null, salesInvoiceOwedAt: null, invoiceDocuments: 0, accountingSyncLogs: 0, heldInvoices: 0 }
  assert.equal(invoiceEvidence(none), null)
  const cases: Array<[Partial<Parameters<typeof invoiceEvidence>[0]>, RegExp]> = [
    [{ accountingInvoiceId: 'x' }, /posted/], [{ accountingSyncLogs: 1 }, /queued or posted/], [{ heldInvoices: 1 }, /held/], [{ salesInvoiceOwedAt: new Date() }, /owed/],
    [{ invoicedAt: new Date() }, /invoiced/], [{ invoiceNumber: 'INV-1' }, /invoiced/], [{ invoiceDocuments: 1 }, /document/],
  ]
  for (const [over, re] of cases) assert.match(invoiceEvidence({ ...none, ...over }) ?? '', re)
})

test('M2: an order edited in IMS is left alone quietly unless WooCommerce changed a line since the baseline', async () => {
  const baseline = new Map([[77, 3]])
  assert.equal(wcChangedSinceBaseline(wcOrder(), { baselineQtyByExternalLineId: baseline }), false, 'WooCommerce still shows what it showed at the IMS edit')
  assert.equal(wcChangedSinceBaseline(wcOrder(), { baselineQtyByExternalLineId: new Map([[77, 5]]) }), true, 'a quantity changed')
  assert.equal(wcChangedSinceBaseline(wcOrder(), { baselineQtyByExternalLineId: new Map([[77, 3], [78, 1]]) }), true, 'an item removed since')
  assert.equal(wcChangedSinceBaseline(wcOrder(), { baselineQtyByExternalLineId: new Map() }), true, 'an item added since')
  assert.equal(wcChangedSinceBaseline(wcOrder(), { baselineQtyByExternalLineId: null }), false, 'no baseline: IMS wins')
  const quiet = deps(facts({ editedInImsAt: new Date(), baselineQtyByExternalLineId: baseline }))
  const out = await applyWcOrderAmendment('o1', wcOrder(), diffs, 'fp', quiet.d)
  assert.equal(out.kind, 'skipped')
  assert.equal(quiet.calls.claims + quiet.calls.rewrites.length + quiet.calls.refusals.length + quiet.calls.gate, 0, 'no claim, no gate, no refused action')
  const changed = deps(facts({ editedInImsAt: new Date(), baselineQtyByExternalLineId: new Map([[77, 5]]) }))
  await applyWcOrderAmendment('o1', wcOrder(), diffs, 'fp', changed.d)
  assert.equal(changed.calls.rewrites.length, 1, 'WooCommerce changed after the IMS edit: the rewrite decides (and refuses an IMS-edited order)')
})

test('M6: the nothing-differs early return acts on nothing (no claim, no gate, no rewrite)', async () => {
  const { d, calls } = deps(facts())
  const out = await applyWcOrderAmendment('o1', wcOrder(), [], 'fp', d)
  assert.deepEqual(out, { kind: 'skipped', reason: 'nothing differs' })
  assert.equal(calls.claims + calls.gate + calls.rewrites.length, 0)
})

test('M6: latest edit wins on a paid quantity increase (IMS wins when WooCommerce is unchanged since the baseline)', () => {
  const edited = new Date('2026-11-19T09:00:00Z')
  assert.equal(planWcOrderAmendment(wcPaid(7), up, facts({ paidAt: paid, editedInImsAt: edited, baselineQtyByExternalLineId: new Map([[77, 7]]) })).increases.length, 0, 'baseline equals WooCommerce: IMS edit stands')
  assert.equal(planWcOrderAmendment(wcPaid(7), up, facts({ paidAt: paid, editedInImsAt: edited, baselineQtyByExternalLineId: new Map([[77, 5]]) })).increases.length >= 1, true)
})

test('M6: the WC_PAID_INCREASE refusal is resolved when a paid order no longer shows an increase, and not while it does', async () => {
  const none = deps(facts({ paidAt: paid }), { writeOn: true })
  await applyWcOrderAmendment('o1', wcPaid(3), diffs, 'fp', none.d)
  assert.ok(none.calls.resolved.includes(WC_PAID_INCREASE_GATE))
  assert.ok(none.calls.resolved.includes(WC_REWRITE_REFUSED_GATE), 'a paid order has left the rewrite\'s scope')
  const some = deps(facts({ paidAt: paid }), { writeOn: true })
  await applyWcOrderAmendment('o1', wcPaid(7), up, 'fp', some.d)
  assert.equal(some.calls.resolved.includes(WC_PAID_INCREASE_GATE), false)
})

test('M6: the tax-total check (items + shipping tax against WooCommerce\'s tax total) refuses on its own, with the tax lines agreeing with the total', () => {
  const r = refused(planUnpaidRewrite(input({ totalTax: '6.30', total: '35.30', taxLines: [{ tax_total: '5.50', shipping_tax_total: '0.80' }] })))
  assert.equal(r.code, 'TAX_MISMATCH')
  assert.match(r.detail, /items' and shipping's tax/)
})

test('M6: tax total with no tax lines; duplicate WooCommerce item ids; a mapped line that is not the payload item', () => {
  const noLines = refused(planUnpaidRewrite(input({ taxLines: [] })))
  assert.equal(noLines.code, 'TAX_MISMATCH')
  assert.match(noLines.detail, /no tax lines/)
  const dup = refused(planUnpaidRewrite(input({ items: [A, { ...B, id: A.id }] })))
  assert.equal(dup.code, 'BAD_LINE')
  const base = input()
  const swapped = refused(planUnpaidRewrite({ ...base, mapped: [{ ...base.mapped[0]!, externalLineItemId: 99 }, base.mapped[1]!] }))
  assert.equal(swapped.code, 'BAD_LINE')
  const zeroQty = refused(planUnpaidRewrite({ ...base, mapped: [{ ...base.mapped[0]!, qty: 0 }, base.mapped[1]!] }))
  assert.equal(zeroQty.code, 'BAD_LINE')
})

test('M3: a continued line whose product changed has its live pegs ended before the update (source pin; the peg service is exercised by its own tests)', async () => {
  const { readFile } = await import('node:fs/promises')
  const src = await readFile('lib/connectors/woocommerce/sync/order-unpaid-rewrite.ts', 'utf8')
  const pegs = src.indexOf('recordPegsRemovedWithLines(tx, { salesOrderLineIds: productChangedIds }')
  const update = src.indexOf('await tx.salesOrderLine.update({ where: { id: lineId }')
  assert.ok(pegs > 0 && update > pegs, 'pegs of product-changed lines are ended before the lines are updated')
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// o3d-ewe4y / o3d-9x6wk follow-ups: paid in WooCommerce only (wording, reductions), latest edit wins for paid additions, refusals after an IMS edit
// ---------------------------------------------------------------------------------------------------------------------------------------

const wcPaidTotal = (qty: number, total: string): WcFullOrder => ({ ...(wcPaidDate(qty) as object), total }) as unknown as WcFullOrder
const wcFacts = (over: Partial<AmendmentFacts> = {}) => facts({ paidAt: null, totalForeign: '60.00', currency: 'GBP', ...over })

test('MED-1: an order paid in WooCommerce only, increased: the task asks what the gateway charged (never just "collect the difference")', async () => {
  const { d, calls } = deps(wcFacts(), { writeOn: true })
  await applyWcOrderAmendment('o1', wcPaidTotal(7, '84.00'), up, 'fp', d)
  assert.equal(calls.tasks.length, 1)
  assert.equal(calls.tasks[0]!.reason, 'WC_PAID_INCREASE')
  const text = String(calls.tasks[0]!.queryText)
  assert.match(text, /WooCommerce shows it paid at 84\.00 GBP; IMS holds 60\.00 GBP and has not recorded the payment/)
  assert.match(text, /Check what the payment gateway charged\. If it charged the new total, edit the IMS order to match WooCommerce/)
  assert.match(text, /If it charged the old total, collect the difference from the customer or undo the edit/)
  assert.match(text, /RED: quantity is 7 in WooCommerce against 5 in IMS \(2 more\)/)
  assert.doesNotMatch(text, /Please collect the difference/)
  assert.match(String(calls.tasks[0]!.dedupeBasis), /^wc-paid-in-woo:/, 'a different dedupe family from the paid-in-IMS task')
  // An order paid in IMS keeps the original wording.
  const imsPaid = deps(facts({ paidAt: paid }), { writeOn: true })
  await applyWcOrderAmendment('o1', wcPaid(7), up, 'fp', imsPaid.d)
  assert.match(String(imsPaid.calls.tasks[0]!.queryText), /Please collect the difference from the customer, or undo the edit/)
  assert.match(String(imsPaid.calls.tasks[0]!.dedupeBasis), /^wc-paid-increase:/)
})

test('MED-1: a payment IMS holds that is not on the paid fields (no paid date on the update) is never rewritten, and its task is worded for the part payment (no gateway text)', async () => {
  const { d, calls } = deps(wcFacts({ imsPaymentUnrecorded: true, imsReceiptTotal: '30.00' }), { writeOn: true, rewriteOn: true })
  await applyWcOrderAmendment('o1', wcPaid(7), up, 'fp', d)
  assert.equal(calls.rewrites.length, 0, 'never rewritten')
  assert.equal(calls.tasks.length, 1)
  assert.match(String(calls.tasks[0]!.queryText), /IMS holds payments of 30\.00 GBP against a total of 60\.00 GBP/)
  assert.doesNotMatch(String(calls.tasks[0]!.queryText), /gateway/i)
  const rewriteOnly = deps(wcFacts({ imsPaymentUnrecorded: true }), { writeOn: false, rewriteOn: true })
  assert.deepEqual(await applyWcOrderAmendment('o1', wcPaid(7), up, 'fp', rewriteOnly.d), { kind: 'off' })
})

test('MED-2: a REDUCTION on an order paid in WooCommerce only is the same task (not "order not paid" left on the list), with the reduction wording and no refund', async () => {
  const plan = planWcOrderAmendment(wcPaidDate(3), diffs, wcFacts({ paidInWoo: true }))
  assert.deepEqual(plan.paidInWooReductions, ['RED: quantity is 3 in WooCommerce against 5 in IMS (2 fewer)'])
  assert.equal(plan.leftForPerson.some((t) => /order not paid/.test(t)), false)
  const { d, calls } = deps(wcFacts({ paidBlockOpen: true }), { writeOn: true })
  const out = await applyWcOrderAmendment('o1', wcPaidTotal(3, '36.00'), [...diffs, { field: 'TOTAL', label: 'Order total (including tax) changed in WooCommerce', woocommerce: '36.00', ims: '60.00' }], 'fp', d)
  assert.equal(out.kind, 'applied')
  assert.equal(calls.refunds, 0, 'IMS holds no payment to refund against')
  assert.equal(calls.rewrites.length, 0)
  assert.equal(calls.tasks.length, 1)
  assert.equal(calls.tasks[0]!.reason, 'WC_PAID_INCREASE')
  const text = String(calls.tasks[0]!.queryText)
  assert.match(text, /RED: quantity is 3 in WooCommerce against 5 in IMS \(2 fewer\)/)
  assert.match(text, /Order total \(including tax\) is 36\.00 in WooCommerce against 60\.00 in IMS \(24\.00 less\)/)
  assert.match(text, /If it charged the old total, refund the difference to the customer or undo the edit/)
  // With no warehouse order the same text is a refused action.
  const noLink = deps(wcFacts({ paidBlockOpen: true }), { writeOn: true, hasLink: false })
  await applyWcOrderAmendment('o1', wcPaidTotal(3, '36.00'), diffs, 'fp', noLink.d)
  assert.equal(noLink.calls.refusals[0]!.gate, WC_PAID_INCREASE_GATE)
  assert.match(String(noLink.calls.refusals[0]!.detail), /Check what the payment gateway charged/)
  // The refusal is not resolved while the reduction stands.
  assert.equal(noLink.calls.resolved.includes(WC_PAID_INCREASE_GATE), false)
})

test('MED-2: a LOWER unit price on an order paid in WooCommerce only is the task; on an order paid in IMS it stays on the list', () => {
  const lower: DivergenceDifference[] = [{ field: 'LINE_PRICE', label: 'Unit price (excluding tax) of RED changed in WooCommerce', woocommerce: '8.00', ims: '10.00' }]
  assert.equal(planWcOrderAmendment(wcPaidDate(5), lower, wcFacts({ paidInWoo: true })).paidInWooReductions.length, 1)
  const imsPaid = planWcOrderAmendment(wcPaid(5), lower, facts({ paidAt: paid }))
  assert.equal(imsPaid.paidInWooReductions.length + imsPaid.increases.length, 0)
})

test('9x6wk L1: latest edit wins for a paid ADDED item and a higher price: after an IMS edit only an item the baseline did not show counts, and a price never does', () => {
  const edited = new Date('2026-11-19T09:00:00Z')
  const added = (id: number): DivergenceDifference[] => [{ field: 'LINE_ADDED', label: 'Item GRN was added in WooCommerce', woocommerce: '1 x GRN at 8.00 each', ims: 'not on the order', externalLineItemId: id }]
  // WooCommerce showed item 88 at the IMS edit (IMS removed it since): not a WooCommerce increase.
  assert.equal(planWcOrderAmendment(wcPaid(5), added(88), facts({ paidAt: paid, editedInImsAt: edited, baselineQtyByExternalLineId: new Map([[77, 5], [88, 1]]) })).increases.length, 0)
  // An item the baseline did not hold: WooCommerce added it after the IMS edit.
  assert.equal(planWcOrderAmendment(wcPaid(5), added(99), facts({ paidAt: paid, editedInImsAt: edited, baselineQtyByExternalLineId: new Map([[77, 5], [88, 1]]) })).increases.length, 1)
  // No baseline, or no item id on the difference: IMS wins.
  assert.equal(planWcOrderAmendment(wcPaid(5), added(99), facts({ paidAt: paid, editedInImsAt: edited, baselineQtyByExternalLineId: null })).increases.length, 0)
  assert.equal(planWcOrderAmendment(wcPaid(5), [{ ...added(99)[0]!, externalLineItemId: undefined }], facts({ paidAt: paid, editedInImsAt: edited, baselineQtyByExternalLineId: new Map([[77, 5]]) })).increases.length, 0)
  // An order nobody edited in IMS: unchanged behaviour.
  assert.equal(planWcOrderAmendment(wcPaid(5), added(99), facts({ paidAt: paid })).increases.length, 1)
  const higher: DivergenceDifference[] = [{ field: 'LINE_PRICE', label: 'Unit price (excluding tax) of RED changed in WooCommerce', woocommerce: '12.00', ims: '10.00' }]
  assert.equal(planWcOrderAmendment(wcPaid(5), higher, facts({ paidAt: paid, editedInImsAt: edited, baselineQtyByExternalLineId: new Map([[77, 5]]) })).increases.length, 0, 'a price has no baseline: after an IMS edit it cannot be attributed to WooCommerce')
  assert.equal(planWcOrderAmendment(wcPaid(5), higher, facts({ paidAt: paid })).increases.length, 1)
})

test('MED-3: an unpaid order edited in IMS that now differs in price, shipping or discount is REFUSED visibly (a tax or total difference alone, or quantities WooCommerce did not change, stay quiet)', async () => {
  const baseline = new Map([[77, 3]])
  const imsEdited = () => facts({ editedInImsAt: new Date(), baselineQtyByExternalLineId: baseline })
  for (const field of ['LINE_PRICE', 'SHIPPING', 'DISCOUNT', 'LINE_PRODUCT'] as const) {
    const { d, calls } = deps(imsEdited())
    const out = await applyWcOrderAmendment('o1', wcOrder(), [{ field, label: `The ${field} changed in WooCommerce`, woocommerce: '9.00', ims: '7.00' }], 'fp', d)
    assert.equal(out.kind, 'skipped', field)
    assert.equal(calls.refusals.length, 1, `${field} is refused`)
    assert.equal(calls.refusals[0]!.gate, WC_REWRITE_REFUSED_GATE)
    assert.equal(calls.refusals[0]!.action, 'WC_ORDER_REWRITE')
    assert.match(String(calls.refusals[0]!.detail), /cannot tell whether WooCommerce changed them afterwards/)
    assert.equal(calls.rewrites.length, 0, 'nothing written')
    assert.equal(calls.claims, 1, 'only the once-per-difference marker is taken (o3d-0ged2 LOW 4), not a rewrite claim')
  }
  for (const field of ['TAX', 'TOTAL', 'LINE_QUANTITY'] as const) {
    const { d, calls } = deps(imsEdited())
    await applyWcOrderAmendment('o1', wcOrder(), [{ field, label: 'x', woocommerce: '9.00', ims: '7.00' }], 'fp', d)
    assert.equal(calls.refusals.length + calls.claims + calls.rewrites.length, 0, `${field} alone is quiet`)
  }
})

test('M2 (killing): an item WooCommerce added since the baseline counts as a change even at quantity 0 (the added-item line is not redundant with the quantity comparison)', () => {
  const withZero = { line_items: [{ id: 77, quantity: 3 }, { id: 99, quantity: 0 }] } as unknown as WcFullOrder
  assert.equal(wcChangedSinceBaseline(withZero, { baselineQtyByExternalLineId: new Map([[77, 3]]) }), true)
  assert.equal(wcChangedSinceBaseline({ line_items: [{ id: 77, quantity: 3 }] } as unknown as WcFullOrder, { baselineQtyByExternalLineId: new Map([[77, 3]]) }), false)
  // An item removed since: a baseline id WooCommerce no longer shows, with the rest unchanged.
  assert.equal(wcChangedSinceBaseline({ line_items: [{ id: 77, quantity: 3 }] } as unknown as WcFullOrder, { baselineQtyByExternalLineId: new Map([[77, 3], [88, 0]]) }), true)
})

test('9x6wk L3: a line total ABOVE its subtotal (the importer would clamp the discount to 0 and the figures would disagree) is refused beyond half a minor unit', () => {
  const over: Item = { ...A, subtotal: '20.00', total: '21.00', tax: '4.20' }
  const r = refused(planUnpaidRewrite(input({ items: [over, B] })))
  assert.equal(r.code, 'BAD_LINE')
  assert.match(r.detail, /above its subtotal/)
  const rounding: Item = { ...A, subtotal: '20.00', total: '20.004', tax: '4.00' }
  assert.notEqual((planUnpaidRewrite(input({ items: [rounding, B] })) as { code?: string }).code, 'BAD_LINE', 'under half a penny is rounding')
})

test('9x6wk L4: with no shipping line on the payload the shipping method fields are cleared, not left stale', () => {
  const noShipping = { ...input({ shipping: '0.00', shippingTax: '0.00' }), shipping: null }
  const plan = ok(planUnpaidRewrite(noShipping))
  assert.equal(plan.order.shippingService, null)
  assert.equal(plan.order.courierKey, null)
  assert.equal(plan.order.shippingMethodId, null)
  const withShipping = ok(planUnpaidRewrite(input()))
  assert.equal(withShipping.order.shippingService, 'Flat')
})
