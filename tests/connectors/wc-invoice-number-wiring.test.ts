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
  // The enqueue is reachable ONLY through the resolution's ok branch; the other branch parks the
  // payload (o3d-k26m.6) instead of sending it.
  const branch = body.indexOf('if (invoiceNumberResolution.ok) {')
  const enqueue = body.indexOf('await queueAccountingSync({')
  const hold = body.indexOf('await holdWcSalesInvoiceForMissingNumber({')
  assert.ok(branch > 0, 'the importer must branch on whether WooCommerce numbered the invoice')
  assert.ok(branch < enqueue, 'the enqueue must sit INSIDE the ok branch, not before it')
  assert.ok(enqueue < hold, 'the else branch must be the hold, not a second enqueue')
  assert.ok(
    body.includes("action: 'sales_invoice_number_unavailable'"),
    'the refusal must be visible as a WARNING an operator can act on',
  )
  assert.ok(
    body.includes('return await finishWithoutAccounting(heldReason)'),
    'the refusal must return without queueing anything',
  )
  // The regression this replaces: `invoiceNumber: <anything we made up>`. There is exactly one
  // expression that may reach the payload's invoice number on this path.
  assert.ok(
    body.includes('payload: { invoiceNumber: invoiceNumberResolution.invoiceNumber, ...accountingPayload }'),
    'the only number the importer may post is the resolved one',
  )
})

test('the held payload is PARKED, not discarded, so the advertised recovery can complete', () => {
  const body = importWcOrderBody()
  // o3d-k26m.6: round 1 held the invoice back and dropped the payload. The warning told operators
  // to re-import; the re-import captured the number and queued nothing, so the remedy produced no
  // invoice. The payload the import WOULD have sent is now stored against the order.
  assert.ok(
    body.includes('const accountingPayload: Record<string, unknown> = {'),
    'the payload must be built once, without a number, so held and posted paths cannot diverge',
  )
  const built = body.indexOf('const accountingPayload: Record<string, unknown> = {')
  assert.ok(built < body.indexOf('await holdWcSalesInvoiceForMissingNumber({'), 'the hold must park the built payload')
  assert.ok(
    body.includes('metaKey: invoiceNumberResolution.metaKey,'),
    'the parked row must say which meta key it is waiting for',
  )
})

test('a redelivery captures the number, may correct it before anything posts, and releases the held invoice', () => {
  const src = source(ORDER_IMPORT)
  const start = src.indexOf('async function updateExistingWcOrderFromPayload(')
  const body = src.slice(start, src.indexOf('\n}\n', start))
  assert.ok(body.includes('resolveWcAccountingInvoiceNumber(wcOrder)'), 'the redelivery path must look for the number')
  assert.ok(
    body.includes('await applyResolvedWcInvoiceNumber(orderId, wcOrder, resolvedInvoiceNumber.invoiceNumber)'),
    'the capture must go through the decision that knows when a number may still be corrected (o3d-k26m.7)',
  )
  // The regression (o3d-k26m.6): capturing the number and queueing nothing, leaving the order
  // numbered, PROCESSING and permanently un-invoiced.
  assert.ok(
    body.includes('await releaseHeldWcSalesInvoice(orderId, wcOrder, usableInvoiceNumber)'),
    'capturing the number must RELEASE the invoice that was held back for it',
  )
  assert.ok(
    body.includes('if (so.accountingInvoiceId) return'),
    'an order that already has a ledger document has nothing held, and must never be released into a second post',
  )
  // The blanket `invoiceNumber: null` guard is what froze a pre-post number; the decision replaces it.
  assert.ok(
    !body.includes('where: { id: orderId, invoiceNumber: null },'),
    'the blanket null guard must be gone — it froze numbers captured before anything posted',
  )
})

test('a refused capture writes nothing and releases nothing', () => {
  // o3d-k26m.5, the "ALSO IN SCOPE" half: an EMPTY invoiceNumber is not evidence that nothing has
  // posted — it is the state of every WooCommerce order invoiced before o3d-k26m.1, each of which
  // has a live Xero document numbered `INWC-...`.
  const src = source(ORDER_IMPORT)
  const start = src.indexOf('async function applyResolvedWcInvoiceNumber(')
  assert.ok(start > 0, 'the capture/correction wiring must exist')
  const body = src.slice(start, src.indexOf('\n}\n', start))
  const refusal = body.indexOf("if (decision.action === 'refuse-capture') {")
  assert.ok(refusal > 0, 'a refused capture must be handled, not fall through to the write')
  const tail = body.slice(refusal)
  assert.ok(
    tail.includes("action: 'sales_invoice_number_capture_refused'"),
    'a refused capture must be visible as a WARNING naming both the order and the storefront number',
  )
  assert.ok(
    tail.indexOf('return { usable: false }') < tail.indexOf('return { usable: true'),
    'a refused capture must return unusable, so nothing is released under a number IMS did not record',
  )
})

test('the release enqueues BEFORE it marks the row, so a crash cannot strand the invoice', () => {
  const src = source(ORDER_IMPORT)
  const start = src.indexOf('async function releaseHeldWcSalesInvoice(')
  assert.ok(start > 0, 'the release must exist')
  const body = src.slice(start, src.indexOf('\n}\n', start))
  const enqueue = body.indexOf('await queueAccountingSync({')
  const mark = body.indexOf("status: 'SYNCED',")
  assert.ok(enqueue > 0 && mark > enqueue, 'the queue row must be marked SYNCED only AFTER the enqueue succeeds')
  assert.ok(
    body.includes('const idempotencyKey = `wc-held-sales-invoice:${orderId}:${invoiceNumber}`'),
    'the enqueue must be deduplicable, so a repeated release adds nothing',
  )
  assert.ok(
    body.includes('buildReleasedSalesInvoicePayload(held, invoiceNumber)'),
    'the release must post the parked payload plus the number, not a rebuilt one',
  )
})

test('the release CONFIRMS the sync row exists before it calls the invoice released', () => {
  // Codex round 3, HIGH: queueAccountingSync returns void and returns EARLY, without throwing,
  // when no connector is active, when the connector's sync is off, when SALES_INVOICE posting is
  // off, or when the order was deleted. Round 2's catch could not see any of them, so the hold was
  // marked SYNCED with "the sales invoice was queued" for an invoice that will never post — and
  // the one row that knew the order was waiting had just been closed.
  const src = source(ORDER_IMPORT)
  const start = src.indexOf('async function releaseHeldWcSalesInvoice(')
  const body = src.slice(start, src.indexOf('\n}\n', start))
  const confirm = body.indexOf('releasedSalesInvoiceQueueWhere({ salesOrderId: orderId, idempotencyKey })')
  const mark = body.indexOf("status: 'SYNCED',")
  assert.ok(confirm > 0, 'the release must ask the database whether the sync row is really there')
  assert.ok(confirm < mark, 'the confirmation must happen BEFORE the hold is marked released')
  const unqueued = body.indexOf('if (!queued) {')
  assert.ok(unqueued > 0, 'a missing sync row must be handled explicitly')
  assert.ok(unqueued < mark, 'an unqueued invoice must return before the hold is closed')
  assert.ok(
    body.includes("action: 'sales_invoice_release_not_queued'"),
    'a silent no-op must become a WARNING naming the order and the number',
  )
  assert.ok(
    body.includes('accounting connector is disconnected, its sync is switched off'),
    'the warning must name the ordinary causes, or the operator has nowhere to start',
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

// ---------------------------------------------------------------------------
// o3d-k26m.5 — the fence, at the seam where the irreversible write happens.
//
// The rule is unit-tested in tests/accounting/invoice-number-ownership.test.ts and the lookup in
// tests/connectors/xero-invoice-number-claim.test.ts. What neither can see is whether the
// sales-invoice create actually CONSULTS them, which is one line in the middle of a switch — and
// Xero is live, so it cannot be exercised end to end here.
// ---------------------------------------------------------------------------

const XERO_PROCESSOR = 'lib/connectors/xero/sync-processor.ts'

function salesInvoiceCase(): string {
  const src = source(XERO_PROCESSOR)
  const start = src.indexOf("    case 'SALES_INVOICE': {")
  assert.ok(start > 0, 'the SALES_INVOICE case must exist')
  const end = src.indexOf("    case 'SALES_INVOICE_UPDATE': {", start)
  assert.ok(end > start, 'the SALES_INVOICE case must be delimited')
  return src.slice(start, end)
}

test('the sales-invoice CREATE asks who owns the number before it sends anything', () => {
  const body = salesInvoiceCase()
  const fence = body.indexOf('await guardSalesInvoiceNumberOwnership(entryId, referenceType, referenceId, payload)')
  const push = body.indexOf('await pushSalesInvoice({')
  assert.ok(fence > 0, 'the create must consult the ownership fence')
  assert.ok(fence < push, 'the fence must run BEFORE the post, not after it')
  assert.ok(
    body.includes('if (!numberFence.post) return numberFence.result'),
    'a refusal must return without posting',
  )
})

test('the UPDATE is not fenced — it addresses a document by an id we recorded ourselves', () => {
  const src = source(XERO_PROCESSOR)
  const start = src.indexOf("    case 'SALES_INVOICE_UPDATE': {")
  const body = src.slice(start, src.indexOf("    case 'PURCHASE_INVOICE': {", start))
  assert.ok(body.includes('await updateSalesInvoice(accountingInvoiceId, {'), 'the update posts to an id')
  assert.ok(
    !body.includes('guardSalesInvoiceNumberOwnership('),
    'fencing the update would spend a call re-proving ownership the id already establishes',
  )
})

function ownershipFenceBody(): string {
  const src = source(XERO_PROCESSOR)
  const start = src.indexOf('async function guardSalesInvoiceNumberOwnership(')
  assert.ok(start > 0, 'the fence must exist')
  return src.slice(start, src.indexOf('\nasync function processEntry(', start))
}

test('the attempt is written BEFORE the post, and a failure to write it blocks the post', () => {
  const body = ownershipFenceBody()
  const guard = body.indexOf('if (decision.recordAttempt && invoiceNumber) {')
  const write = body.indexOf('data: { attemptedInvoiceNumber: invoiceNumber, attemptedInvoiceNumberAt: new Date() },')
  const allow = body.lastIndexOf('return { post: true }')
  assert.ok(guard > 0, 'the write must be reached whenever the decision asks for it')
  assert.ok(guard < write, 'and it must be the thing that reaches the write')
  assert.ok(write > 0, 'the number about to be posted must be recorded on the row first')
  assert.ok(write < allow, 'the record must be durable before the caller is allowed to post')
  // Not because the record licenses anything — because a create whose local record cannot be
  // written is a create whose OUTCOME cannot be written either.
  assert.ok(
    body.includes('Could not record the invoice-number attempt for ${invoiceNumber} on sync row ${entryId} before posting'),
    'failing to record the attempt must refuse the post, not proceed without it',
  )
  // Fails closed on an unreadable order, matching guardCancelledSalesOrderInvoice.
  assert.ok(
    body.includes('Sales order ${referenceId} not found before posting an invoice'),
    'a missing order must refuse, never read as "unowned"',
  )
})

test('the recorded attempt reaches the decision as MESSAGE material and nothing else', () => {
  // Codex round 3, CRITICAL: round 2 passed this as `ownClaimInvoiceNumber` and the rule posted on
  // it — "nobody held the number when this row set out, somebody holds it now, therefore ours".
  // The name and the parameter are both gone; what remains may only be quoted back to an operator.
  const body = ownershipFenceBody()
  assert.ok(
    body.includes('decideInvoiceNumberPost({ invoiceNumber, lookup, ownedInvoiceId, attemptedInvoiceNumber, orderLabel })'),
    'the fence must pass the recorded attempt under its honest name',
  )
  assert.ok(!body.includes('ownClaimInvoiceNumber'), 'no parameter may claim the attempt proves ownership')
  assert.ok(!body.includes('invoiceNumberClaim'), 'the claim column and its inference are retired')
})
