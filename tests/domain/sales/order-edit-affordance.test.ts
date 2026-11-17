import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

import {
  SHOP_DESYNC_REFUSAL,
  SHOP_DESYNC_WARNING,
  paidOrderTotalChangeRefusal,
  resolveSalesOrderAddressEditBlock,
  resolveSalesOrderEditBlock,
  resolveSalesOrderEditScope,
  shopDesyncAcknowledgementRefusal,
} from '@/lib/domain/sales/order-edit-affordance'

/**
 * Owner ruling 2026-11-10: drafts are editable; a confirmed order is editable after the desync warning; after dispatch only addresses and notes; cancelled, closed and erased are blocked. The server action and the order page both
 * call these helpers, so the page disables Edit with the reason the action would give.
 * [mutation: drop any one check below from the helper: its arm is red]
 */
type EditInput = Parameters<typeof resolveSalesOrderEditBlock>[0]
const clean: EditInput = { status: 'DRAFT', allocations: 0, shipments: 0, accountingInvoiceId: null, wmsPush: false, hasExternalSource: false }
const confirmed = (over: Partial<EditInput> = {}): EditInput => ({ ...clean, status: 'PROCESSING', ...over })

test('a clean draft is editable', () => {
  assert.equal(resolveSalesOrderEditBlock({ ...clean }), null)
})

test('every pre-dispatch confirmed status is editable, with or without allocation, a posted invoice, a warehouse push, a shop link and money records', () => {
  for (const status of ['PENDING_PAYMENT', 'ON_HOLD', 'PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING']) {
    assert.equal(resolveSalesOrderEditBlock(confirmed({ status })), null, status)
  }
  const heavy = confirmed({ status: 'ALLOCATED', allocations: 3, shipments: 1, committedShipments: 0, accountingInvoiceId: 'INV-1', wmsPush: true, hasExternalSource: true, payments: 1, paid: true, storeCreditForeign: 5, invoiceRecords: 1, accountingSyncLogs: 2 })
  assert.equal(resolveSalesOrderEditBlock(heavy), null, 'allocation, a posted invoice, a push, a shop link, payment, an invoice number and sync rows are handled by the edit (or by the action), not refused here')
})

test('after dispatch the lines are closed but addresses and notes are open', () => {
  for (const status of ['SHIPPED', 'COMPLETED']) {
    assert.equal(resolveSalesOrderEditBlock(confirmed({ status }))?.code, 'DISPATCHED', status)
    assert.equal(resolveSalesOrderAddressEditBlock({ status }), null, status)
    assert.equal(resolveSalesOrderEditScope(confirmed({ status })).scope, 'ADDRESS_NOTES', status)
  }
  // Partly shipped: not SHIPPED, but a shipment has left.
  const partly = confirmed({ status: 'PICKING', shipments: 2, committedShipments: 2, shippedShipments: 1 })
  assert.equal(resolveSalesOrderEditBlock(partly)?.code, 'DISPATCHED')
  assert.equal(resolveSalesOrderEditScope(partly).scope, 'ADDRESS_NOTES')
  assert.match(resolveSalesOrderEditBlock(confirmed({ status: 'SHIPPED' }))!.reason, /Refund/)
})

test('cancelled, closed (delivered) and erased orders are blocked for both kinds of edit', () => {
  for (const [input, code] of [[confirmed({ status: 'CANCELLED' }), 'CANCELLED'], [confirmed({ status: 'DELIVERED' }), 'CLOSED'], [confirmed({ erased: true }), 'ERASED'], [{ ...clean, erased: true }, 'ERASED']] as const) {
    assert.equal(resolveSalesOrderEditBlock(input)?.code, code)
    assert.equal(resolveSalesOrderAddressEditBlock(input)?.code, code)
    assert.equal(resolveSalesOrderEditScope(input).scope, 'NONE')
  }
})

test('refusals that stay whatever the status: refunds, return expectations, a picked or packed shipment, a queued-but-unposted invoice, a picking warehouse, shop fee lines', () => {
  const cases: Array<[Partial<EditInput>, string, RegExp]> = [
    [{ refunds: 1 }, 'REFUND', /refunds/],
    [{ refundStatus: 'PARTIAL' }, 'REFUND', /refunds/],
    [{ returnExpectations: 1 }, 'RETURN_EXPECTATION', /return expectations/],
    [{ shipments: 1, committedShipments: 1 }, 'SHIPMENT', /picked or packed/],
    [{ invoiceNotPosted: true }, 'INVOICE_NOT_POSTED', /not been posted yet/],
    [{ status: 'PICKING', wmsPush: true }, 'WMS_PICKING', /already picking/],
    [{ status: 'PACKING', wmsPush: true }, 'WMS_PICKING', /already picking/],
    [{ productlessLines: 1 }, 'FEE_LINES', /fee lines/],
  ]
  for (const [over, code, reason] of cases) {
    const block = resolveSalesOrderEditBlock(confirmed(over))
    assert.equal(block?.code, code)
    assert.match(block!.reason, reason)
  }
  // A pending draft shipment is released by the edit, so it is not a blocker; a posted invoice means the queued-invoice rule does not apply.
  assert.equal(resolveSalesOrderEditBlock(confirmed({ shipments: 1, committedShipments: 0 })), null)
  assert.equal(resolveSalesOrderEditBlock(confirmed({ invoiceNotPosted: true, accountingInvoiceId: 'INV-1' })), null)
  assert.equal(resolveSalesOrderEditBlock(confirmed({ status: 'PICKING', wmsPush: false })), null)
})

test('each blocker on an otherwise clean DRAFT still refuses, with its own reason', () => {
  const cases: Array<[Partial<EditInput>, string, RegExp]> = [
    [{ allocations: 1 }, 'ALLOCATION', /Stock is allocated/],
    [{ shipments: 1 }, 'SHIPMENT', /shipment exists/],
    [{ accountingInvoiceId: 'INV-1' }, 'ACCOUNTING_INVOICE', /accounting invoice has already been posted/],
    [{ wmsPush: true }, 'WMS_PUSH', /sent to the warehouse/],
    [{ payments: 1 }, 'PAYMENT', /payment is recorded/],
    [{ paid: true }, 'PAYMENT', /payment is recorded/],
    [{ storeCreditForeign: 5 }, 'STORE_CREDIT', /Store credit/],
    [{ invoiceRecords: 1 }, 'INVOICE_RECORD', /invoice number or invoice document/],
    [{ accountingSyncLogs: 1 }, 'ACCOUNTING_SYNC', /accounting entry/],
    [{ refunds: 1 }, 'REFUND', /refunds/],
    [{ returnExpectations: 1 }, 'RETURN_EXPECTATION', /return expectations/],
  ]
  for (const [over, code, reason] of cases) {
    const block = resolveSalesOrderEditBlock({ ...clean, ...over })
    assert.equal(block?.code, code)
    assert.match(block!.reason, reason)
  }
  // A draft carrying a shop link is not a blocker any more: the edit needs the acknowledgement instead.
  assert.equal(resolveSalesOrderEditBlock({ ...clean, hasExternalSource: true }), null)
})

test('the desync acknowledgement is required, as exactly true, for a shop-linked order only', () => {
  assert.equal(shopDesyncAcknowledgementRefusal(false, undefined), null, 'a manual order needs none')
  assert.equal(shopDesyncAcknowledgementRefusal(true, true), null)
  for (const bad of [undefined, false, 'true', 1, null, {}]) assert.equal(shopDesyncAcknowledgementRefusal(true, bad), SHOP_DESYNC_REFUSAL, String(bad))
  assert.match(SHOP_DESYNC_WARNING, /will not change it in WooCommerce/)
  assert.match(SHOP_DESYNC_WARNING, /WooCommerce keeps the original/)
  assert.match(SHOP_DESYNC_REFUSAL, /WooCommerce keeps the original/)
})

test('a paid or store-credited confirmed order keeps its total and currency; a draft and an unpaid order are not held to it', () => {
  const base = { status: 'PROCESSING', payments: 1, paid: true, storeCreditForeign: 0, currencyBefore: 'GBP', currencyAfter: 'GBP', totalBefore: 100, totalAfter: 100 }
  assert.equal(paidOrderTotalChangeRefusal(base), null, 'same total: a swap is fine')
  assert.match(paidOrderTotalChangeRefusal({ ...base, totalAfter: 100.01 })!, /leave its total/)
  assert.match(paidOrderTotalChangeRefusal({ ...base, currencyAfter: 'EUR' })!, /leave its total/)
  assert.match(paidOrderTotalChangeRefusal({ ...base, payments: 0, paid: false, storeCreditForeign: 3, totalAfter: 50 })!, /leave its total/)
  assert.equal(paidOrderTotalChangeRefusal({ ...base, payments: 0, paid: false, totalAfter: 50 }), null, 'unpaid: free to change')
  assert.equal(paidOrderTotalChangeRefusal({ ...base, status: 'DRAFT', totalAfter: 50 }), null, 'a draft is held by the draft blockers instead')
})

test('the server action and the order page both go through the helpers (one rule, two callers); the form warns before saving a shop order; the importer honours the marker', async () => {
  const action = await readFile('app/actions/sales.ts', 'utf8')
  const page = await readFile('app/(dashboard)/sales/[id]/so-detail-client.tsx', 'utf8')
  const form = await readFile('app/(dashboard)/sales/so-form.tsx', 'utf8')
  assert.match(action, /resolveSalesOrderEditBlock\(\{/)
  assert.match(action, /resolveSalesOrderAddressEditBlock\(\{/)
  assert.match(action, /shopDesyncAcknowledgementRefusal\(/)
  assert.match(page, /resolveSalesOrderEditBlock\(/)
  assert.match(page, /resolveSalesOrderEditScope\(/)
  // The warning dialog: shown (and confirmed) before the server is called for a shop-linked order, with the one wording.
  assert.match(form, /SHOP_DESYNC_WARNING/)
  assert.match(form, /if \(shopLinked && !shopDesyncAcknowledged\) \{ setShowDesyncConfirm\(true\); return \}/)
  assert.match(form, /acknowledgeShopDesync: shopDesyncAcknowledged/)
  assert.match(page, /SHOP_DESYNC_WARNING/)
  // Webhook policy (b): the importer's update path reads the marker and guards each field the IMS edit can set.
  const importer = await readFile('lib/connectors/woocommerce/sync/order-import.ts', 'utf8')
  assert.match(importer, /select: \{ erasedAt: true, editedInImsAt: true \}/)
  assert.match(importer, /const keepImsEdit = erasure\?\.editedInImsAt != null/)
  assert.match(importer, /\.\.\.\(!keepImsEdit && Array\.isArray\(wcOrder\.shipping_lines\)/)
  assert.match(importer, /\.\.\.\(erased \|\| keepImsEdit\s*\?\s*\{\}/)
  // The refund and status-echo paths are untouched by the policy: only the importer's update path and the divergence comparison read the marker.
  const dir = 'lib/connectors/woocommerce/sync'
  const readers = (await readdir(dir)).filter((f) => f.endsWith('.ts'))
  const readersOfMarker: string[] = []
  for (const file of readers) if ((await readFile(`${dir}/${file}`, 'utf8')).includes('editedInImsAt')) readersOfMarker.push(file)
  assert.deepEqual(readersOfMarker.sort(), ['order-edit-drift.ts', 'order-import.ts'])
})
