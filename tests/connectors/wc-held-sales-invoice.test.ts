import assert from 'node:assert/strict'
import test from 'node:test'

import { decideStoredInvoiceNumberUpdate } from '@/lib/connectors/woocommerce/sync/invoice-number'
import {
  buildHeldSalesInvoicePayload,
  buildReleasedSalesInvoicePayload,
  heldSalesInvoiceQueueWhere,
  isHeldSalesInvoicePayload,
  MISSING_INVOICE_NUMBER_QUEUE_REASON,
} from '@/lib/connectors/woocommerce/sync/held-sales-invoice'

// ---------------------------------------------------------------------------
// o3d-k26m.6 — the invoice held back for a number has to come BACK.
// o3d-k26m.7 — and a number captured before anything posted has to stay correctable.
//
// Round 1 refused to post without `_wcpdf_invoice_number` (right: under an upserting create a
// stand-in cannot be corrected later) and told operators to re-import once WooCommerce numbers
// the order. The re-import captured the number and queued nothing, so the advertised remedy ran
// to completion and produced no invoice. Separately, the capture was guarded on
// `invoiceNumber: null`, which protects a POSTED document's number — and also froze a number
// captured before any post, so a storefront correction could never reach IMS.
// ---------------------------------------------------------------------------

const ACCOUNTING_PAYLOAD = {
  contactName: 'A Customer',
  date: '2026-08-01',
  currency: 'GBP',
  lines: [{ description: 'Widget', quantity: 1, unitAmount: 100, accountCode: '200' }],
  _registerPayment: true,
  _paymentMethod: 'stripe',
  _paymentAmount: 120,
}

function held() {
  return buildHeldSalesInvoicePayload({
    externalOrderId: '9001',
    externalOrderNumber: '164981',
    salesOrderId: 'so-1',
    orderNumber: 'WC-164981',
    metaKey: '_wcpdf_invoice_number',
    accountingPayload: ACCOUNTING_PAYLOAD,
  })
}

// ---------------------------------------------------------------------------
// Parking the payload
// ---------------------------------------------------------------------------

test('the held payload carries the import’s own decisions, so the released invoice is the one the import would have posted', () => {
  const payload = held()
  assert.equal(payload.reason, MISSING_INVOICE_NUMBER_QUEUE_REASON)
  assert.equal(payload.salesOrderId, 'so-1')
  assert.equal(payload.metaKey, '_wcpdf_invoice_number')
  // The fields that CANNOT be rebuilt from the SalesOrder row later: the WooCommerce order's own
  // date, and the payment-registration block. Rebuilding would silently post a different invoice
  // for an order that happened to be held than for one that was not.
  assert.equal(payload.accountingPayload.date, '2026-08-01')
  assert.equal(payload.accountingPayload._registerPayment, true)
  assert.equal(payload.accountingPayload._paymentAmount, 120)
})

test('a parked payload never carries an invoice number — that is what it is waiting for', () => {
  const payload = buildHeldSalesInvoicePayload({
    externalOrderId: '9001',
    externalOrderNumber: '164981',
    salesOrderId: 'so-1',
    orderNumber: 'WC-164981',
    metaKey: '_wcpdf_invoice_number',
    accountingPayload: { ...ACCOUNTING_PAYLOAD, invoiceNumber: 'SOMETHING-INVENTED' },
  })
  assert.equal('invoiceNumber' in payload.accountingPayload, false)
  assert.equal(isHeldSalesInvoicePayload(payload), true)
})

test('a stored payload carrying a number is NOT releasable — it did not come through the hold', () => {
  const payload = held()
  const contaminated = {
    ...payload,
    accountingPayload: { ...payload.accountingPayload, invoiceNumber: 'SOMETHING-INVENTED' },
  }
  assert.equal(isHeldSalesInvoicePayload(contaminated), false)
})

test('an unrecognisable stored payload is not releasable', () => {
  for (const value of [null, 'string', 42, [], {}, { reason: 'missing_fx_rate' }, { ...held(), salesOrderId: 7 }]) {
    assert.equal(isHeldSalesInvoicePayload(value), false, `${JSON.stringify(value)} must not validate`)
  }
})

test('the release adds the number and nothing else, and the payload cannot override it', () => {
  const released = buildReleasedSalesInvoicePayload(held(), '164981')
  assert.equal(released.invoiceNumber, '164981')
  assert.equal(released.date, '2026-08-01')
  assert.equal(released._paymentAmount, 120)
  // Everything else is byte-for-byte the parked payload: a settings change between hold and
  // release must not quietly alter what posts.
  const { invoiceNumber, ...rest } = released
  assert.deepEqual(rest, held().accountingPayload)
})

test('held rows are PENDING and reason-scoped, so the FX queue and FAILED dashboards never see them', () => {
  const where = heldSalesInvoiceQueueWhere({ salesOrderId: 'so-1' })
  assert.equal(where.status, 'PENDING')
  assert.equal(where.entityId, 'so-1')
  assert.equal(where.connector, 'woocommerce')
  assert.deepEqual(where.payload, { path: ['reason'], equals: MISSING_INVOICE_NUMBER_QUEUE_REASON })
  // Without the reason filter this selector would also match the pending-FX queue's rows and
  // release orders that are waiting for an exchange rate, not a number.
  assert.notEqual(MISSING_INVOICE_NUMBER_QUEUE_REASON, 'missing_fx_rate')
})

// ---------------------------------------------------------------------------
// When a captured number may be corrected
// ---------------------------------------------------------------------------

test('nothing stored yet: capture it', () => {
  const decision = decideStoredInvoiceNumberUpdate({
    storedInvoiceNumber: null,
    incomingInvoiceNumber: '164981',
    accountingInvoiceId: null,
    salesInvoiceSyncRowCount: 0,
  })
  assert.deepEqual(decision, { action: 'capture', to: '164981' })
})

test('the same number again is a no-op', () => {
  const decision = decideStoredInvoiceNumberUpdate({
    storedInvoiceNumber: '164981',
    incomingInvoiceNumber: '164981',
    accountingInvoiceId: null,
    salesInvoiceSyncRowCount: 0,
  })
  assert.deepEqual(decision, { action: 'unchanged', stored: '164981' })
})

test('a storefront correction REACHES IMS while nothing has committed to the old number', () => {
  const decision = decideStoredInvoiceNumberUpdate({
    storedInvoiceNumber: '164981',
    incomingInvoiceNumber: '164982',
    accountingInvoiceId: null,
    salesInvoiceSyncRowCount: 0,
  })
  assert.deepEqual(decision, { action: 'correct', from: '164981', to: '164982' })
})

test('once a ledger document exists the number is FROZEN, and the refusal says why', () => {
  const decision = decideStoredInvoiceNumberUpdate({
    storedInvoiceNumber: '164981',
    incomingInvoiceNumber: '164982',
    accountingInvoiceId: 'xero-id-1',
    salesInvoiceSyncRowCount: 0,
  })
  assert.equal(decision.action, 'refuse-correction')
  assert.equal(decision.action === 'refuse-correction' && decision.from, '164981')
  assert.equal(decision.action === 'refuse-correction' && decision.to, '164982')
  const reason = decision.action === 'refuse-correction' ? decision.reason : ''
  assert.match(reason, /xero-id-1/)
  assert.match(reason, /already posted for this order under 164981/)
  // The actual mechanism, not a generic "already invoiced": the create is update-or-create on the
  // number, and the UPDATE sends the order's number against the document — so a new number either
  // adds a document or renumbers a live one.
  assert.match(reason, /add a SECOND document or renumber a live one/)
})

test('a sync row already carrying the old number freezes it too — a FAILED post is not proof nothing posted', () => {
  const decision = decideStoredInvoiceNumberUpdate({
    storedInvoiceNumber: '164981',
    incomingInvoiceNumber: '164982',
    accountingInvoiceId: null,
    salesInvoiceSyncRowCount: 1,
  })
  assert.equal(decision.action, 'refuse-correction')
  const reason = decision.action === 'refuse-correction' ? decision.reason : ''
  assert.match(reason, /already queued under 164981, carrying its own number in its payload/)
  assert.match(reason, /not proof that nothing reached the ledger/)
})

test('a held order has no sync row, so its number is still correctable before release', () => {
  // This is the case the whole correction window exists for: held back for want of a number,
  // WooCommerce reports one, then renumbers before anything is queued.
  const decision = decideStoredInvoiceNumberUpdate({
    storedInvoiceNumber: '164981',
    incomingInvoiceNumber: '164982',
    accountingInvoiceId: null,
    salesInvoiceSyncRowCount: 0,
  })
  assert.equal(decision.action, 'correct')
  assert.equal(buildReleasedSalesInvoicePayload(held(), '164982').invoiceNumber, '164982')
})

test('blank stored values are treated as nothing stored, not as a correction', () => {
  const decision = decideStoredInvoiceNumberUpdate({
    storedInvoiceNumber: '   ',
    incomingInvoiceNumber: '164981',
    accountingInvoiceId: null,
    salesInvoiceSyncRowCount: 0,
  })
  assert.deepEqual(decision, { action: 'capture', to: '164981' })
})

// ---------------------------------------------------------------------------
// o3d-k26m.5, the "ALSO IN SCOPE" half: an EMPTY column is not evidence that nothing has posted.
//
// Every WooCommerce order invoiced before o3d-k26m.1 has an empty `invoiceNumber` — the importer
// did not persist one, and the back-reference only fills it from the posting response — and a live
// Xero document numbered `INWC-…`. Writing WooCommerce's `164981` in looks like an innocent
// backfill; the next SALES_INVOICE_UPDATE would then send `164981` against that document and try to
// renumber a live invoice onto the number xeroom is using.
// ---------------------------------------------------------------------------

test('an order that already has a ledger document is NOT backfilled, even with an empty column', () => {
  const decision = decideStoredInvoiceNumberUpdate({
    storedInvoiceNumber: null,
    incomingInvoiceNumber: '164981',
    accountingInvoiceId: 'xero-id-legacy',
    salesInvoiceSyncRowCount: 1,
  })
  assert.equal(decision.action, 'refuse-capture')
  assert.equal(decision.action === 'refuse-capture' && decision.to, '164981')
  const reason = decision.action === 'refuse-capture' ? decision.reason : ''
  assert.match(reason, /xero-id-legacy/)
  assert.match(reason, /renumber a live one/)
  // With nothing stored there is no "under <number>" to name — the whole point is that IMS does
  // not know what number the existing document carries.
  assert.doesNotMatch(reason, / under /)
})

test('an order with a queued sales invoice is not backfilled either', () => {
  const decision = decideStoredInvoiceNumberUpdate({
    storedInvoiceNumber: null,
    incomingInvoiceNumber: '164981',
    accountingInvoiceId: null,
    salesInvoiceSyncRowCount: 1,
  })
  assert.equal(decision.action, 'refuse-capture')
  assert.match(
    decision.action === 'refuse-capture' ? decision.reason : '',
    /already queued, carrying its own number in its payload/,
  )
})

test('the ledger document outranks the sync row in the explanation an operator reads', () => {
  const withDoc = decideStoredInvoiceNumberUpdate({
    storedInvoiceNumber: '164981',
    incomingInvoiceNumber: '164982',
    accountingInvoiceId: 'xero-id-1',
    salesInvoiceSyncRowCount: 3,
  })
  assert.match(withDoc.action === 'refuse-correction' ? withDoc.reason : '', /already posted for this order under 164981/)
})
