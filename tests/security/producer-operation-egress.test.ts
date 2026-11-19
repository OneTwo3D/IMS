import assert from 'node:assert/strict'
import test from 'node:test'

import { wooDrainHold, wooEgressHold } from '../../lib/connectors/woocommerce/producer-egress.ts'
import { xeroRowDeliveryHold } from '../../lib/domain/accounting/xero-producer-seam.ts'
import { producerEgressVerdict, producerOperationEgressVerdict } from '../../lib/security/producer-seam.ts'
import { explainProducerDisposition } from '../../lib/security/producer-disposition.ts'

/**
 * THE DRAIN, THE CLAIM BOUNDARY AND THE WRITER FLOOR ARE PER OPERATION (review of #1051, MEDIUM).
 *
 * The destination-level gate (producerEgressVerdict, wooEgressHold) opens as soon as ANY step that writes to the destination is live: it is only the
 * earliest-open transport barrier. The drains and the claim boundary ask for the operation they carry, so a destination opened by step M does not let
 * the stock, invoice-note and invoice-document rows out. Almost every other fixture sets all three live-from values to one instant, which cannot tell the
 * variables apart; these set ONE step's variable and no other.
 * Mutation: make wooDrainHold ignore its operation (the destination-level answer) => the "only step M" arm goes red.
 */

const NOW = new Date('2026-12-20T00:00:00Z')
const AT = '2026-12-01T00:00:00Z'
const base = {
  PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'all',
  XERO_WRITE_ALLOWED_TENANT: '4f7f0c6e-1111-4222-8333-944455556666',
  WC_WRITEBACK_ALLOWED_ORIGIN: 'https://shop.example.test',
  MINTSOFT_WRITE_ALLOWED: 'https://api.example.test|89',
}
const onlyM = { ...base, MINTSOFT_WRITES_LIVE_FROM: AT }
const onlyW = { ...base, WC_WRITES_LIVE_FROM: AT }
const onlyX = { ...base, XERO_WRITES_LIVE_FROM: AT }
const BOTH_CONFIRMED = new Set(['qoblex-xero-stopped', 'qoblex-stock-push-stopped'])

const STEP_M_WOO = ['order.status', 'order.tracking', 'order.partial-shipment', 'order.trackship-refire', 'order.wms-status-meta', 'product.meta'] as const
const STEP_W_WOO = ['stock', 'webhooks'] as const
const STEP_X_WOO = ['order.invoice-note', 'order.invoice-document'] as const

test('ONLY step M live (the Mintsoft instant, nothing else): completions, tracking and the other bridge writeback go out; stock, the invoice note and the invoice document stay HELD', () => {
  const context = { env: onlyM, now: NOW, attestations: BOTH_CONFIRMED }
  for (const operation of STEP_M_WOO) assert.equal(wooDrainHold(context, operation).held, false, `${operation} is open`)
  for (const operation of [...STEP_W_WOO, ...STEP_X_WOO]) assert.equal(wooDrainHold(context, operation).held, true, `${operation} stays held even with the confirmations on record`)
  // The destination-level gate and the transport barrier are open (an earlier step is live): they are NOT what keeps the later steps' rows in.
  assert.equal(wooDrainHold(context).held, false)
  assert.equal(wooEgressHold(context).held, false)
  assert.equal(producerEgressVerdict('woocommerce', context).kind, 'open')
  // The claim boundary of a queued accounting row: the invoice note is held, a Xero row is held (Xero is not live), and a row's confirmation is irrelevant while its step is not live.
  assert.ok(xeroRowDeliveryHold({ type: 'WC_INVOICE_NOTE', ...context }) !== null)
  assert.ok(xeroRowDeliveryHold({ type: 'PURCHASE_INVOICE', ...context }) !== null)
  // The producer decision for those operations is SHADOW (their own step is not live), with the reason of their own step.
  for (const operation of [...STEP_W_WOO, ...STEP_X_WOO]) {
    const d = explainProducerDisposition('woocommerce', operation as never, NOW, context)
    assert.equal(d.disposition, 'SHADOW', operation)
  }
})

test('ONLY step W live (the WooCommerce instant): stock and webhooks open once the Qoblex stock confirmation is on record; the bridge writeback and the note stay held', () => {
  const confirmed = { env: onlyW, now: NOW, attestations: BOTH_CONFIRMED }
  for (const operation of STEP_W_WOO) assert.equal(wooDrainHold(confirmed, operation).held, false, operation)
  for (const operation of [...STEP_M_WOO, ...STEP_X_WOO]) assert.equal(wooDrainHold(confirmed, operation).held, true, operation)
  // Without the confirmation the STOCK push is held (webhooks are not): wc_stock_sync_enabled being on is not a way round it.
  const unconfirmed = { env: onlyW, now: NOW, attestations: new Set<string>() }
  const stock = wooDrainHold(unconfirmed, 'stock')
  assert.equal(stock.held, true)
  assert.equal(stock.held && stock.reason, 'attestation_missing')
  assert.equal(wooDrainHold(unconfirmed, 'webhooks').held, false)
})

test('ONLY step X live (the Xero instant): the invoice note and document and the Xero rows open once the Qoblex Xero confirmation is on record; stock and the bridge writeback stay held', () => {
  const confirmed = { env: onlyX, now: NOW, attestations: BOTH_CONFIRMED }
  for (const operation of STEP_X_WOO) assert.equal(wooDrainHold(confirmed, operation).held, false, operation)
  for (const operation of [...STEP_M_WOO, ...STEP_W_WOO]) assert.equal(wooDrainHold(confirmed, operation).held, true, operation)
  assert.equal(xeroRowDeliveryHold({ type: 'WC_INVOICE_NOTE', ...confirmed }), null)
  assert.equal(xeroRowDeliveryHold({ type: 'DAILY_BATCH_GROUP_B', ...confirmed }), null)
  const unconfirmed = { env: onlyX, now: NOW, attestations: new Set<string>() }
  assert.equal(wooDrainHold(unconfirmed, 'order.invoice-document').held, true)
  assert.ok(xeroRowDeliveryHold({ type: 'WC_INVOICE_NOTE', ...unconfirmed })?.awaiting)
  assert.ok(xeroRowDeliveryHold({ type: 'DAILY_BATCH_GROUP_B', ...unconfirmed })?.awaiting)
})

test('a step in the FUTURE is not live: its operations stay held, and the earlier live step does not drag them open', () => {
  const env = { ...base, MINTSOFT_WRITES_LIVE_FROM: AT, WC_WRITES_LIVE_FROM: '2027-01-01T00:00:00Z', XERO_WRITES_LIVE_FROM: '2027-01-04T00:00:00Z' }
  const context = { env, now: NOW, attestations: BOTH_CONFIRMED }
  assert.equal(wooDrainHold(context, 'order.status').held, false)
  assert.equal(wooDrainHold(context, 'stock').held, true)
  assert.equal(wooDrainHold(context, 'order.invoice-note').held, true)
  assert.equal(producerOperationEgressVerdict('woocommerce', 'stock', context).kind, 'held')
})

test('the hold is not enforced: no operation waits (legacy, byte for byte)', () => {
  const context = { env: { ...onlyM, PRODUCER_HOLD_ENFORCED_DESTINATIONS: '' }, now: NOW }
  for (const operation of [...STEP_M_WOO, ...STEP_W_WOO, ...STEP_X_WOO]) assert.equal(wooDrainHold(context, operation).held, false, operation)
})
