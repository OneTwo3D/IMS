import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// o3d-k26m.1 — the seam, not the helper.
//
// `resolveWcAccountingInvoiceNumber` can be perfect and the ledger still wrong: what decides the
// document number is which expression ends up on the payload the accounting connector receives,
// and whether the importer posts at all when there is no number. Both are single lines in the
// middle of a 1,100-line importer, and no other test in this repo drives `importWcOrder` end to
// end (its db surface is the whole import), so they are asserted at the source — the same way
// tests/woocommerce-withdrawal.test.ts pins its own wiring at this seam.
// ---------------------------------------------------------------------------

const ORDER_IMPORT = 'lib/connectors/woocommerce/sync/order-import.ts'
const SALES_ACTIONS = 'app/actions/sales.ts'

function source(path: string): string {
  return readFileSync(path, 'utf8')
}

function importWcOrderBody(): string {
  const src = source(ORDER_IMPORT)
  const start = src.indexOf('export async function importWcOrder(')
  assert.ok(start > 0, 'importWcOrder must exist')
  const end = src.indexOf('\nexport function isQueuedWcOrderPayload', start)
  assert.ok(end > start, 'importWcOrder body must be delimited')
  return src.slice(start, end)
}

test('the queued sales invoice carries WooCommerce’s number, not a derived one', () => {
  const body = importWcOrderBody()
  assert.ok(
    body.includes('invoiceNumber: invoiceNumberResolution.invoiceNumber,'),
    'the accounting payload must take the number resolved from _wcpdf_invoice_number',
  )
  // The regression: `INWC-164981` where xeroom posted `164981`, which both breaks the sequence
  // against 14,415 historical documents and stops a cutover double-post looking like a duplicate.
  assert.ok(
    !/invoiceNumber:\s*`\$\{wcInvPrefix\}/.test(body),
    'the invoice number must not be built from the connector invoice prefix',
  )
  assert.ok(
    !body.includes('invPrefix: wcInvPrefix'),
    'woocommerce_inv_prefix must no longer participate in the accounting invoice number',
  )
})

test('the order row records the same number the connector is sent', () => {
  const body = importWcOrderBody()
  assert.ok(
    body.includes('...(invoiceNumberResolution.ok ? { invoiceNumber: invoiceNumberResolution.invoiceNumber } : {}),'),
    'the resolved number must be persisted on the SalesOrder so a later re-queue posts the SAME document',
  )
})

test('no number means NO accounting post — the importer must not invent one', () => {
  const body = importWcOrderBody()
  const guard = body.indexOf('if (!invoiceNumberResolution.ok) {')
  const enqueue = body.indexOf('queueAccountingSync({')
  assert.ok(guard > 0, 'the importer must refuse to queue when WooCommerce has not numbered the invoice')
  assert.ok(guard < enqueue, 'the refusal must come BEFORE the enqueue, not after it')
  const refusal = body.slice(guard, enqueue)
  assert.ok(
    refusal.includes("action: 'sales_invoice_number_unavailable'"),
    'the refusal must be visible as a WARNING an operator can act on',
  )
  assert.ok(
    refusal.includes('return await finishWithoutAccounting(reason)'),
    'the refusal must return without queueing anything',
  )
})

test('a redelivery captures the number once WooCommerce assigns it, and never overwrites one', () => {
  const src = source(ORDER_IMPORT)
  const start = src.indexOf('async function updateExistingWcOrderFromPayload(')
  const body = src.slice(start, src.indexOf('\n}\n', start))
  assert.ok(body.includes('resolveWcAccountingInvoiceNumber(wcOrder)'), 'the redelivery path must look for the number')
  assert.ok(
    body.includes('where: { id: orderId, invoiceNumber: null },'),
    'the backfill must be guarded on invoiceNumber: null so a posted document’s number is never rewritten',
  )
})

test('the IMS-side queue posts the number the order already carries', () => {
  const src = source(SALES_ACTIONS)
  const start = src.indexOf('async function queueSalesInvoiceForOrder(')
  const body = src.slice(start, src.indexOf('\nexport async function updateSalesOrderStatus', start))
  assert.ok(body.includes('resolveSalesInvoiceNumberForPost({'), 'must resolve through the shared helper')
  assert.ok(body.includes('persistedInvoiceNumber: so.invoiceNumber,'), 'must feed it the persisted number')
  assert.ok(body.includes('invoiceNumber: accountingInvoiceNumber,'), 'must post the resolved number')
  // The regression: `INV-164981` from this path for an order the importer already posted as
  // 164981 — two Xero documents for one order, because the create upserts on InvoiceNumber.
  assert.ok(
    !/invoiceNumber:\s*`\$\{manualPrefix\}\$\{orderNumber\}`/.test(body),
    'the number must not be derived here when the order already carries one',
  )
  assert.ok(body.includes('invoiceNumber: true,'), 'the order read must select invoiceNumber')
})

test('the chargeback discount decision is taken from the posted document', () => {
  const src = source(SALES_ACTIONS)
  const start = src.indexOf('export async function raiseChargebackForReversedOrder(')
  const body = src.slice(start, src.indexOf('\n/**', start + 100))
  assert.ok(
    body.includes('readPostedSalesInvoiceDiscountForOrder(db.accountingEvent, orderId)'),
    'the chargeback must read what the invoice actually posted',
  )
  assert.ok(body.includes('decideChargebackDiscountLine({'), 'and route it through the shared decision')
  // The regression (o3d-356o): `if (!cbSettings?.discountAccount)` used alone as a proxy for
  // "the invoice posted a discount line".
  assert.ok(
    !body.includes('if (!cbSettings?.discountAccount) {'),
    'the live setting must not be the sole proxy for what the document carries',
  )
})

test('generateInvoiceNumber refuses to mint over a storefront-supplied number', () => {
  const src = source(SALES_ACTIONS)
  const start = src.indexOf('export async function generateInvoiceNumber(')
  const body = src.slice(start, src.indexOf('\nexport async function', start + 10))
  assert.ok(
    body.includes('if (invoiceNumberIsExternallySupplied(so.shoppingLinks.map((l) => l.connector))) {'),
    'must check whether the storefront supplies the number before minting one — unconditionally',
  )
  assert.ok(
    body.includes('externallySupplied: true as const'),
    'the refusal must short-circuit BEFORE nextDocumentNumber writes to the column',
  )
  assert.ok(
    body.indexOf('externallySupplied: true as const') < body.indexOf('nextDocumentNumber(tx, {'),
    'the check must precede the mint',
  )
})
