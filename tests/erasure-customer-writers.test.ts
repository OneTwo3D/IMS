import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'

/**
 * CENSUS OF EVERY WRITER OF THE CUSTOMER TABLE, each with a verdict, so a new writer fails here until it is classified.
 *
 *   refuses       writes only WHERE gdprAnonymisedAt IS NULL (or never matches an anonymised row), so an erased customer
 *                 cannot be changed by a stale read
 *   new-row       creates a row; nothing existing is touched
 *   non-identity  writes no identifying column (an archive flag, a ledger contact id)
 *   erasure       the erasure itself
 *   reset         the factory reset, which empties the database
 */
const CENSUS: Record<string, { calls: number; verdict: string }> = {
  'app/actions/customers.ts': { calls: 4, verdict: 'refuses (updateCustomer, CSV update) / new-row (createCustomer, CSV create)' },
  'app/actions/reset.ts': { calls: 1, verdict: 'reset' },
  'lib/connectors/woocommerce/sync/field-mapping.ts': { calls: 1, verdict: 'new-row; an anonymised match is refused before any link or return' },
  'lib/connectors/xero/auth.ts': { calls: 1, verdict: 'non-identity (disconnect clears the ledger contact id)' },
  'lib/connectors/xero/contacts.ts': { calls: 1, verdict: 'non-identity (stores the ledger contact id)' },
  'lib/data-retention.ts': { calls: 1, verdict: 'non-identity (archive flag)' },
  'lib/domain/erasure/erase-personal-data.ts': { calls: 1, verdict: 'erasure' },
}

test('every writer of the customer table is in the census', () => {
  const out = execFileSync('git', ['grep', '-n', '-E', '\\.customer\\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\\(', '--', 'app', 'lib', ':!app/generated', ':!*.test.ts'], {
    encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname,
  }).trim().split('\n').filter(Boolean)
  const found: Record<string, number> = {}
  for (const line of out) { const file = line.split(':')[0]!; found[file] = (found[file] ?? 0) + 1 }
  assert.deepEqual(found, Object.fromEntries(Object.entries(CENSUS).map(([f, v]) => [f, v.calls])))
})

test('the edit writers in customers.ts are conditional updateMany calls, never an unconditional update', () => {
  const src = readFileSync(new URL('../app/actions/customers.ts', import.meta.url), 'utf8')
  assert.ok(!/\.customer\.update\(/.test(src), 'an unconditional update by id would let a stale read write onto an erased customer')
  const conditional = src.match(/customer\.updateMany\(\{\s*where: \{ id(?:: existing\.id)?, gdprAnonymisedAt: null \}/g) ?? []
  assert.equal(conditional.length, 2, 'both the single edit and the CSV update carry the condition')
})

/**
 * CENSUS OF THE WRITERS OF THE THREE ORDER/SHIPMENT COLUMNS THE ERASURE CLEARS BY HAND (order notes, internal notes, tracking
 * numbers), scanned as: any salesOrder/shipment create/update/upsert whose next 22 lines assign one of them, or an
 * assignment to `data.trackingNumber`. A new writer fails here until it is classified.
 *
 *   refuses       reads erasedAt under the order lock and refuses
 *   marker-guard  the storefront importer, which withholds identity columns on an erased order
 *   erasure       the erasure itself
 *   despatch      the fulfilment path of an OPEN order (shipping it writes the tracking number the carrier issued). Not guarded:
 *                 an erased order is normally closed, and propagating an erasure to the warehouse and carrier for orders still
 *                 open is its own piece of work. Stated limit.
 */
const ORDER_CENSUS: Record<string, { writers: number; verdict: string }> = {
  'app/actions/allocation.ts': { writers: 2, verdict: 'refuses (updateShipmentTracking: shipment + order tracking, one transaction under the order lock)' },
  'app/actions/sales.ts': { writers: 2, verdict: 'refuses (updateSalesOrderNotes) / despatch (status transition to SHIPPED with a tracking number)' },
  'lib/connectors/woocommerce/sync/order-import.ts': { writers: 2, verdict: 'marker-guard (update path) / payment note row, not customer data' },
  'lib/domain/erasure/erase-personal-data.ts': { writers: 2, verdict: 'erasure' },
  'lib/domain/sales/shipment-service.ts': { writers: 3, verdict: 'despatch' },
}

test('every writer of order notes, internal notes and tracking numbers is in the census', () => {
  const cwd = new URL('..', import.meta.url).pathname
  const files = execFileSync('git', ['grep', '-lE', '(salesOrder|shipment)\\.(update|updateMany|create|createMany|upsert)\\(', '--', 'app', 'lib', ':!app/generated', ':!*.test.ts'], { encoding: 'utf8', cwd }).trim().split('\n').filter(Boolean)
  const found: Record<string, number> = {}
  for (const file of files) {
    const lines = readFileSync(`${cwd}${file}`, 'utf8').split('\n')
    lines.forEach((line, i) => {
      const statement = /(salesOrder|shipment)\.(update|updateMany|create|createMany|upsert)\(/.test(line)
        && /\b(trackingNumber|internalNotes|notes)\s*:/.test(lines.slice(i, i + 22).join('\n'))
      const assignment = /\bdata\.trackingNumber\s*=/.test(line)
      if (statement || assignment) found[file] = (found[file] ?? 0) + 1
    })
  }
  assert.deepEqual(found, Object.fromEntries(Object.entries(ORDER_CENSUS).map(([f, v]) => [f, v.writers])))
})

/**
 * CENSUS OF THE WRITERS OF shopping_sync_logs, the table whose `payload` stores raw WooCommerce entities and parked accounting
 * payloads. A new writer fails here until it is classified.
 *
 *   scrubbed      the erasure scrubs this family (held sales-invoice parks: lib/domain/erasure `scrubHeldInvoicePayloads`) and the
 *                 release path checks the erasure marker under the order lock before it copies
 *   raw-woo       stores the raw WooCommerce order, refund or tracking payload: personal data that the erasure does NOT yet reach.
 *                 This is the raw-payload scrub (scope of the payload-scrub work), reported as an unmet erasure obligation, listed
 *                 in the PR description
 *   no-identity   writes a status, a note or a payload with no customer data (product, stock and order-status pushes), or only
 *                 updates the status of an existing row
 */
const SYNC_LOG_CENSUS: Record<string, { writers: number; verdict: string }> = {
  'app/actions/sync-exceptions.ts': { writers: 5, verdict: 'no-identity (operator resolution: status updateMany)' },
  'lib/connectors/woocommerce/sync/order-admission.ts': { writers: 4, verdict: 'raw-woo (the refusal queue parks the raw order)' },
  'lib/connectors/woocommerce/sync/order-import.ts': { writers: 24, verdict: 'scrubbed (held sales invoice: the EU treatment and order-changed rewrites keep the parked payload as is and the release scrubs it under the order lock) / raw-woo (pending-FX queue and paid-block rows) / no-identity (status writes)' },
  'lib/connectors/woocommerce/sync/order-status.ts': { writers: 1, verdict: 'no-identity (status push record)' },
  'lib/connectors/woocommerce/sync/product-sync.ts': { writers: 4, verdict: 'no-identity (products)' },
  'lib/connectors/woocommerce/sync/refund-sync.ts': { writers: 6, verdict: 'raw-woo (refund parks carry the raw refund and its free-text reason)' },
  'lib/connectors/woocommerce/sync/stock-sync.ts': { writers: 2, verdict: 'no-identity (stock)' },
  'lib/connectors/woocommerce/sync/tracking-sync.ts': { writers: 4, verdict: 'raw-woo (outbound tracking items carry tracking numbers)' },
  'lib/domain/sales/refund-service.ts': { writers: 1, verdict: 'no-identity (status updateMany)' },
}

test('every writer of shopping_sync_logs is in the census', () => {
  const cwd = new URL('..', import.meta.url).pathname
  const out = execFileSync('git', ['grep', '-cE', 'shoppingSyncLog\\.(create|update|upsert|createMany|updateMany)\\(', '--', 'app', 'lib', ':!app/generated', ':!*.test.ts'], { encoding: 'utf8', cwd }).trim().split('\n').filter(Boolean)
  const found = Object.fromEntries(out.map((line) => { const i = line.lastIndexOf(':'); return [line.slice(0, i), Number(line.slice(i + 1))] }))
  assert.deepEqual(found, Object.fromEntries(Object.entries(SYNC_LOG_CENSUS).map(([f, v]) => [f, v.writers])))
})

/**
 * CENSUS OF EVERY PATH THAT LINKS A CUSTOMER TO A SALES ORDER (any salesOrder create/update whose data assigns `customerId`).
 * An order linked to an anonymised customer carries fresh personal data under an erased identity and escapes the erasure.
 *
 *   refuses     locks the customer row and re-reads gdprAnonymisedAt inside the create transaction, and REFUSES (a manual path:
 *               the operator chooses another customer)
 *   unlinks     the storefront importer, which has no operator: creates the order unlinked and records it
 *
 * There is no quote, B2B, CSV order import or customer-changing order edit in this codebase: the only order creators are the
 * three below, and no update assigns a customer.
 */
const CUSTOMER_LINK_CENSUS: Record<string, { writers: number; verdict: string }> = {
  'app/actions/sales.ts': { writers: 2, verdict: 'refuses (createSalesOrder, cloneSalesOrder)' },
  'lib/connectors/woocommerce/sync/order-import.ts': { writers: 1, verdict: 'unlinks (importWcOrder create transaction)' },
  // Not a link: it SETS customerId to null. An order erased while its customer stays live (another live order) is unlinked in the erasure's transaction.
  'lib/domain/erasure/erase-personal-data.ts': { writers: 1, verdict: 'unlinks (the erasure of an order whose customer stays live)' },
}

test('every path that links a customer to a sales order is in the census', () => {
  const cwd = new URL('..', import.meta.url).pathname
  const files = execFileSync('git', ['grep', '-lE', 'salesOrder\\.(create|createMany|upsert|update|updateMany)\\(', '--', 'app', 'lib', ':!app/generated', ':!*.test.ts'], { encoding: 'utf8', cwd }).trim().split('\n').filter(Boolean)
  const found: Record<string, number> = {}
  for (const file of files) {
    const lines = readFileSync(`${cwd}${file}`, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (!/salesOrder\.(create|createMany|upsert|update|updateMany)\(/.test(line)) return
      const window = lines.slice(i, i + 30).join('\n')
      if (/\bcustomerId\s*:/.test(window) && !/where:\s*\{[^}]*customerId/.test(window.split('data')[0])) found[file] = (found[file] ?? 0) + 1
    })
  }
  assert.deepEqual(found, Object.fromEntries(Object.entries(CUSTOMER_LINK_CENSUS).map(([f, v]) => [f, v.writers])))
})

/**
 * CENSUS OF THE CODE THAT COPIES A CUSTOMER'S CONTACT NAME OR EMAIL INTO AN ACCOUNTING PAYLOAD (customer side only; the
 * purchasing builders carry a supplier). Every one of them is covered by the CENTRAL gate in createAccountingSyncLogRow, which
 * scrubs the contact block of a row for an erased order or customer at the one place the row is written, under the caller's
 * order lock. The importer's invoice enqueue and hold park additionally take the lock and read the marker themselves.
 */
const CONTACT_COPY_CENSUS: Record<string, number> = {
  'app/actions/sales.ts': 2, // the manual order's invoice payload, and the refund's credit note payload
  'lib/connectors/woocommerce/sync/order-import.ts': 1, // the storefront order's invoice payload (also the hold's accountingPayload)
}

test('every customer-side accounting payload that copies a contact name or email is in the census', () => {
  const cwd = new URL('..', import.meta.url).pathname
  const out = execFileSync('git', ['grep', '-nE', 'contactName\\s*:', '--', 'app', 'lib', ':!app/generated', ':!*.test.ts'], { encoding: 'utf8', cwd }).trim().split('\n').filter(Boolean)
  const found: Record<string, number> = {}
  for (const line of out) {
    const file = line.split(':')[0]!
    if (/purchas|supplier|first-load|connectors\/xero\/|types\.ts|invoice-number-ownership|accounting-document-event-builder|settings\.ts|\.tsx$|stock\.ts|api\/|erasure\//.test(file)) continue
    found[file] = (found[file] ?? 0) + 1
  }
  assert.deepEqual(found, CONTACT_COPY_CENSUS)
})

test('the central gate runs before the insert in the one primitive that writes accounting sync rows', () => {
  const src = readFileSync(new URL('../lib/domain/accounting/sync-log-row.ts', import.meta.url), 'utf8')
  const fn = src.slice(src.indexOf('export async function createAccountingSyncLogRow'))
  assert.match(fn, /const data = await gateAccountingPayloadContact\(client, rawData\)[\s\S]*accountingSyncLog\.create/)
})

/**
 * CENSUS OF EVERY WRITER OF AN email_outbox ROW, and what ties each to the erasure. A SalesOrder-linked email carries the
 * order's address, read by the caller before it enqueues; the enqueue itself must therefore take the order lock, read the
 * order's and the customer's erasure markers and insert, in one transaction, refusing when either is set.
 *
 *   queueEmail    the single enqueue function (order confirmation, invoice, accounting invoice): gated centrally
 *   dispatch      the dispatch email, which has its own transaction: it already locks the order, and reads the markers there
 */
const OUTBOX_WRITERS: Record<string, { writers: number; verdict: string }> = {
  'lib/dispatch-email.ts': { writers: 1, verdict: 'dispatch (own transaction: order lock + markers read before the insert)' },
  'lib/email-outbox.ts': { writers: 2, verdict: 'queueEmail (gated: order-locked transaction for SalesOrder rows) / the harness-only client path' },
}

test('every writer of email_outbox rows is in the census, and the SalesOrder enqueue is gated under the order lock', () => {
  const cwd = new URL('..', import.meta.url).pathname
  const out = execFileSync('git', ['grep', '-cE', 'emailOutbox\\.create(Many)?\\(', '--', 'app', 'lib', ':!app/generated', ':!*.test.ts'], { encoding: 'utf8', cwd }).trim().split('\n').filter(Boolean)
  const found = Object.fromEntries(out.map((line) => { const i = line.lastIndexOf(':'); return [line.slice(0, i), Number(line.slice(i + 1))] }))
  assert.deepEqual(found, Object.fromEntries(Object.entries(OUTBOX_WRITERS).map(([f, v]) => [f, v.writers])))
  const q = readFileSync(new URL('../lib/email-outbox.ts', import.meta.url), 'utf8')
  const fn = q.slice(q.indexOf('export async function queueEmail'))
  assert.match(fn, /FOR UPDATE[\s\S]*erasedAt[\s\S]*gdprAnonymisedAt[\s\S]*tx\.emailOutbox\.create\(\{ data \}\)/)
  assert.match(fn, /reason: 'recipient_erased'/)
  const d = readFileSync(new URL('../lib/dispatch-email.ts', import.meta.url), 'utf8')
  assert.match(d, /lockSalesOrder\(tx, orderId\)[\s\S]*erasedAt[\s\S]*gdprAnonymisedAt[\s\S]*tx\.emailOutbox\.create/)
})

/**
 * CENSUS OF EVERY WRITER OF ShoppingCustomerLink (the row that holds a raw storefront customer id). A link must never land on an
 * erased customer, so each writer that follows a lookup takes the customer row lock and re-reads gdprAnonymisedAt before the insert.
 *
 *   locked      field-mapping `upsertCustomer`, the existing-customer branch: FOR UPDATE + re-read, then the insert
 *   new-row     the same function's nested create on a brand-new customer (no one else knows its id, so nothing can erase it first)
 *   erasure     deleteMany inside the erasure (and the healing delete in `upsertCustomer` for a matched erased row)
 *   reset       the factory reset
 */
test('every writer of storefront customer links is in the census, and the lookup-then-insert writer locks the customer first', () => {
  const cwd = new URL('..', import.meta.url).pathname
  const out = execFileSync('git', ['grep', '-nE', 'shoppingCustomerLink\\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\\(|shoppingLinks:\\s*\\{\\s*create', '--', 'app', 'lib', ':!app/generated', ':!*.test.ts'], { encoding: 'utf8', cwd }).trim().split('\n').filter(Boolean)
  const found: Record<string, number> = {}
  for (const line of out) { const file = line.split(':')[0]!; found[file] = (found[file] ?? 0) + 1 }
  // (the healing delete and the guarded create in upsertCustomer; the erasure's delete; the reset's delete)
  assert.deepEqual(found, { 'lib/connectors/woocommerce/sync/field-mapping.ts': 2, 'lib/domain/erasure/erase-personal-data.ts': 1, 'app/actions/reset.ts': 1 })
  const src = readFileSync(new URL('../lib/connectors/woocommerce/sync/field-mapping.ts', import.meta.url), 'utf8')
  const fn = src.slice(src.indexOf('export async function upsertCustomer'))
  // the one multi-line nested create, on a brand-new customer
  assert.equal((fn.match(/shoppingLinks: \{\s*create: \{/g) ?? []).length, 1)
  assert.match(fn, /FROM "customers" WHERE "id" = \$\{matchedId\} FOR UPDATE[\s\S]*gdprAnonymisedAt[\s\S]*tx\.shoppingCustomerLink\.create/)
})

/**
 * CENSUS OF EVERY WRITER OF Payment ROWS and what keeps free text off an erased order's payments. The payment always records (money
 * must post and reconcile); only the free-text note is dropped, and the reference is kept for reconciliation.
 *
 *   gated    addPayment: notes pass through paymentNotesForOrder under the order lock (blank for an erased order)
 *   system   the storefront importer's receipts: fixed sentences with no identity, which the importer recognises by prefix
 */
const PAYMENT_WRITERS: Record<string, number> = {
  'app/actions/sales.ts': 1,
  'lib/connectors/woocommerce/sync/order-import.ts': 2,
  'lib/domain/erasure/erase-personal-data.ts': 1, // the erasure's own erase of the free-text note
}

test('every writer of payments is in the census; the manual one blanks free text for an erased order', () => {
  const cwd = new URL('..', import.meta.url).pathname
  const out = execFileSync('git', ['grep', '-cE', 'payment\\.(create|createMany|update|updateMany|upsert)\\(', '--', 'app', 'lib', ':!app/generated', ':!*.test.ts'], { encoding: 'utf8', cwd }).trim().split('\n').filter(Boolean)
  const found = Object.fromEntries(out.map((line) => { const i = line.lastIndexOf(':'); return [line.slice(0, i), Number(line.slice(i + 1))] }))
  assert.deepEqual(found, PAYMENT_WRITERS)
  const sales = readFileSync(new URL('../app/actions/sales.ts', import.meta.url), 'utf8')
  assert.match(sales, /notes: await paymentNotesForOrder\(tx, input\.orderId, input\.notes\)/)
  const importer = readFileSync(new URL('../lib/connectors/woocommerce/sync/order-import.ts', import.meta.url), 'utf8')
  // The importer writes the exact sentences from the shared constants and no literal of its own.
  assert.match(importer, /notes: existing\.length > 0\s*\? WC_RECEIPT_NOTE_PAID_LATER_PARTIAL\s*: WC_RECEIPT_NOTE_PAID_LATER/)
  assert.match(importer, /notes: WC_RECEIPT_NOTE_IMPORTED_PAID/)
  assert.ok(!/notes: '(Recorded|Imported) from WooCommerce/.test(importer))
})

test('both manual order creators lock and re-read the customer inside the create transaction, before the create', () => {
  const src = readFileSync(new URL('../app/actions/sales.ts', import.meta.url), 'utf8')
  const start = src.indexOf('export async function createSalesOrder')
  const create = src.slice(start, start + 24000)
  assert.match(create, /lockCustomerForOrderLink\(tx, input\.customerId\)\s*return tx\.salesOrder\.create\(/)
  assert.match(create, /instanceof CustomerAnonymisedError\) return \{ success: false, error: e\.message \}/)
  const clone = src.slice(src.indexOf('export async function cloneSalesOrder'))
  assert.match(clone, /lockCustomerForOrderLink\(tx, so\.customerId\)\s*await lockSalesOrder\(tx, id\)[\s\S]*return tx\.salesOrder\.create\(/)
})

test('the held-invoice release reads the marker, builds the payload and inserts inside ONE order-locked transaction, with no after-the-fact scrub', () => {
  const src = readFileSync(new URL('../lib/connectors/woocommerce/sync/order-import.ts', import.meta.url), 'utf8')
  const release = src.slice(src.indexOf('async function releaseHeldWcSalesInvoice'))
  assert.match(release, /db\.\$transaction\(async \(tx\) => \{\s*await lockSalesOrder\(tx, orderId\)[\s\S]*erasedAt[\s\S]*scrubContactInAccountingPayload\(heldNow\.accountingPayload\)[\s\S]*queueAccountingSyncTxWithOutcome\(tx,/)
  assert.ok(!/scrubErasedOrderAccountingPayloads|isOrderErasedUnderLock/.test(src), 'the read-then-scrub-afterwards shape is gone')
})

test('the two edit actions take the order lock and read erasedAt inside the transaction before writing', () => {
  const sales = readFileSync(new URL('../app/actions/sales.ts', import.meta.url), 'utf8')
  const notes = sales.slice(sales.indexOf('export async function updateSalesOrderNotes'))
  assert.match(notes.slice(0, 1200), /lockSalesOrder\(tx, id\)[\s\S]*erasedAt[\s\S]*tx\.salesOrder\.update/)
  const allocation = readFileSync(new URL('../app/actions/allocation.ts', import.meta.url), 'utf8')
  const tracking = allocation.slice(allocation.indexOf('export async function updateShipmentTracking'))
  assert.match(tracking.slice(0, 2600), /lockSalesOrder\(tx, shipment\.orderId\)[\s\S]*erasedAt[\s\S]*tx\.shipment\.update[\s\S]*tx\.salesOrder\.update/)
  assert.ok(!/db\.shipment\.update\(/.test(tracking.slice(0, 2600)), 'no unlocked shipment write remains in the edit')
})

test('the Xero processor posts sales invoices, invoice updates and credit notes through the erasure contact gate', () => {
  const src = readFileSync(new URL('../lib/connectors/xero/sync-processor.ts', import.meta.url), 'utf8')
  assert.match(src, /pushSalesInvoice\(\{\s*invoiceNumber: payload\.invoiceNumber as string,\s*contactName: postContact\.contactName,\s*contactEmail: postContact\.contactEmail/)
  assert.match(src, /updateSalesInvoice\(accountingInvoiceId, \{\s*invoiceNumber: payload\.invoiceNumber as string,\s*contactName: postContact\.contactName,\s*contactEmail: postContact\.contactEmail/)
  assert.match(src, /pushCreditNote\(\{\s*creditNoteNumber: payload\.creditNoteNumber as string,\s*contactName: creditContact\.contactName,\s*contactEmail: creditContact\.contactEmail/)
})

// ---------------------------------------------------------------- behaviour, with a recording database double.
const calls: Array<{ op: string; where: Record<string, unknown> }> = []
const existsAnonymised = true
mock.module('@/lib/db', {
  namedExports: {
    db: {
      // The edit and its activity row run in one transaction; the double hands the same client to the callback.
      $transaction: async function (this: unknown, fn: (tx: unknown) => Promise<unknown>) { return fn(this) },
      customer: {
        updateMany: async ({ where }: { where: Record<string, unknown> }) => { calls.push({ op: 'updateMany', where }); return { count: 0 } },
        findUnique: async () => ({ gdprAnonymisedAt: existsAnonymised ? new Date() : null }),
        findMany: async () => [{ id: 'c1', email: null, firstName: 'GDPR', lastName: 'Anonymised', company: null, billingAddress: null, shippingAddress: null, gdprAnonymisedAt: new Date() }],
        update: async () => { throw new Error('an unconditional update must not be used') },
      },
    },
  },
})
mock.module('@/lib/auth/server', { namedExports: { requirePermission: async () => ({ user: { id: 'u1' } }), requireInternalUser: async () => ({ user: { id: 'u1' } }) } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined, logActivityInTransaction: async () => undefined } })
mock.module('next/cache', { namedExports: { revalidatePath: () => undefined } })

test('updateCustomer writes only where gdprAnonymisedAt is null, and refuses an anonymised customer', async () => {
  const { updateCustomer } = await import('@/app/actions/customers')
  const result = await updateCustomer('c1', { firstName: 'New', email: 'x@example.test' })
  assert.equal(result.success, false)
  assert.match(String(result.error), /anonymised/)
  assert.deepEqual(calls[0]!.where, { id: 'c1', gdprAnonymisedAt: null })
})

test('a CSV row naming an anonymised customer by id is refused and skipped, never written', async () => {
  const { importContactsCsv } = await import('@/app/actions/customers')
  calls.length = 0
  const form = new FormData()
  form.set('file', new File(['customerId,firstName,email\nc1,New,x@example.test\n'], 'c.csv', { type: 'text/csv' }))
  const result = await importContactsCsv(form) as { errors?: string[]; updated?: number; skipped?: number }
  assert.equal(calls.length, 0, 'no write was attempted')
  assert.ok((result.errors ?? []).some((e) => /anonymised/.test(e)), JSON.stringify(result))
  assert.equal(result.updated ?? 0, 0)
})
