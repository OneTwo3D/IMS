import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ERASURE_CLASSIFICATION, classifiedColumns } from '../lib/domain/erasure/erasure-classification.ts'

/**
 * FAIL-CLOSED: every String or Json column on a table that hangs off a customer or an order must be
 * classified (erased / retained / not-personal) in lib/domain/erasure/erasure-classification.ts. A column
 * added later, with no verdict, fails here instead of quietly surviving every erasure.
 */

const SCHEMA = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8')

type ParsedModel = { name: string; textColumns: string[]; fkColumns: Set<string>; fkTargets: Set<string> }

function parseModels(): Map<string, ParsedModel> {
  const out = new Map<string, ParsedModel>()
  const bodies = new Map<string, string>()
  for (const [, name, body] of SCHEMA.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) bodies.set(name!, body!)
  for (const [name, body] of bodies) {
    const textColumns: string[] = []
    const fkColumns = new Set<string>()
    const fkTargets = new Set<string>()
    for (const raw of body.split('\n')) {
      const line = raw.split('//')[0]!.trim()
      const col = /^(\w+)\s+(String|Json)(\[\])?(\?)?(\s|$)/.exec(line)
      if (col) textColumns.push(col[1]!)
      const rel = /^(\w+)\s+(\w+)(\[\])?\??\s+.*@relation\(.*fields:\s*\[([^\]]*)\]/.exec(line)
      if (rel && bodies.has(rel[2]!)) {
        fkTargets.add(rel[2]!)
        for (const c of rel[4]!.split(',')) fkColumns.add(c.trim())
      }
    }
    out.set(name, { name, textColumns, fkColumns, fkTargets })
  }
  return out
}

/** Every model with a relation path (a foreign key, transitively) to Customer or SalesOrder, discovered from the schema. */
function modelsLinkedToCustomerOrOrder(): string[] {
  const models = parseModels()
  const linked = new Set(['Customer', 'SalesOrder'])
  for (let changed = true; changed;) {
    changed = false
    for (const m of models.values()) {
      if (!linked.has(m.name) && [...m.fkTargets].some((t) => linked.has(t))) { linked.add(m.name); changed = true }
    }
  }
  return [...linked].sort()
}

/** The two tables that point at an order only by a reference id (referenceType / referenceId, an action url), so no relation finds them. */
const LINKED_BY_REFERENCE_ID = ['EmailOutbox', 'Notification', 'EmailSuppression', 'WmsMutationEvent', 'WmsSyncLog', 'StorefrontOrderErasureObligation', 'StorefrontCustomerErasureTombstone', 'ShoppingWebhookEvent', 'ShoppingSyncLog', 'AccountingSyncLog', 'AccountingEvent', 'AccountingEventLog']

test('every table with a relation path to Customer or SalesOrder is classified, column by column, and a new linked table fails here', () => {
  const models = parseModels()
  const linked = modelsLinkedToCustomerOrOrder()
  assert.ok(linked.length >= 20, `PRECONDITION: the discovery found the linked tables (${linked.length})`)
  const unclassifiedModels = linked.filter((m) => !ERASURE_CLASSIFICATION[m])
  assert.deepEqual(unclassifiedModels, [], `classify these tables in lib/domain/erasure/erasure-classification.ts: ${unclassifiedModels.join(', ')}`)
  const missing: string[] = []
  for (const name of [...linked, ...LINKED_BY_REFERENCE_ID]) {
    const parsed = models.get(name)!
    const classified = new Set(classifiedColumns(name))
    for (const column of parsed.textColumns) {
      if (column === 'id' || parsed.fkColumns.has(column)) continue
      if (!classified.has(column)) missing.push(`${name}.${column}`)
    }
  }
  assert.deepEqual(missing, [], `classify these columns in lib/domain/erasure/erasure-classification.ts: ${missing.join(', ')}`)
  // Nothing is classified that the discovery does not account for, so a table dropped from the relation graph is noticed.
  const extra = Object.keys(ERASURE_CLASSIFICATION).filter((m) => !linked.includes(m) && !LINKED_BY_REFERENCE_ID.includes(m))
  assert.deepEqual(extra, [])
})

test('no classification entry names a column that no longer exists (a stale entry would mask a rename)', () => {
  const models = parseModels()
  const stale: string[] = []
  for (const model of Object.keys(ERASURE_CLASSIFICATION)) {
    const present = new Set(models.get(model)?.textColumns ?? [])
    for (const column of classifiedColumns(model)) if (!present.has(column)) stale.push(`${model}.${column}`)
  }
  assert.deepEqual(stale, [])
  const dupes = Object.keys(ERASURE_CLASSIFICATION).flatMap((m) => classifiedColumns(m).filter((c, i, a) => a.indexOf(c) !== i).map((c) => `${m}.${c}`))
  assert.deepEqual(dupes, [], 'a column has exactly one verdict')
})

test('the classification is not vacuous: personal columns are classified erased, the decided retentions are retained', () => {
  const erased = (m: string, c: string) => assert.ok(ERASURE_CLASSIFICATION[m].erased.includes(c), `${m}.${c}`)
  for (const c of ['customerName', 'customerEmail', 'customerVatNumber', 'billingAddress', 'shippingAddress', 'notes', 'internalNotes', 'trackingNumber']) erased('SalesOrder', c)
  for (const c of ['firstName', 'lastName', 'email', 'phone', 'company', 'taxNumber', 'billingAddress', 'shippingAddress', 'notes']) erased('Customer', c)
  erased('Shipment', 'trackingNumber')
  erased('EmailOutbox', 'toEmail')
  erased('Notification', 'message')
  const retained = (m: string, c: string) => assert.ok((ERASURE_CLASSIFICATION[m].retained[c] ?? '').length > 10, `${m}.${c} must carry a retention reason`)
  retained('SalesOrder', 'invoicePdfPath')
  retained('SalesOrderRefund', 'reason')
})

test('the schema parser sees the erasure marker column, so the test would notice a rename', () => {
  assert.match(SCHEMA, /erasedAt\s+DateTime\?/)
})

/**
 * CENSUS OF THE COLUMNS THAT STORE A STOREFRONT, WAREHOUSE OR LEDGER CUSTOMER / CONTACT / ACCOUNT IDENTIFIER, found by name in
 * the schema, so a new one fails here until it is decided. The rule:
 *
 *   erased     a raw identifier of the PERSON'S ACCOUNT in a system we do not control (the storefront customer id resolves to the live
 *              account): the storefront link row is DELETED and the customer's integer is cleared. A later order from the same account
 *              finds no link and no email on the erased row, so it is given a FRESH customer.
 *   retained   the ledger contact id and the invoice and credit-note ids, which reconcile money; and the surrogate foreign key.
 *   not here   storefront and warehouse ORDER ids and numbers (shopping order link, order number, warehouse order refs): needed to
 *              reconcile money and the warehouse, and they name an order, not a person's account.
 */
const IDENTIFIER_COLUMNS: Record<string, 'erased' | 'retained' | 'surrogate' | 'not-customer'> = {
  'Customer.externalCustomerId': 'erased',
  'ShoppingCustomerLink.externalCustomerId': 'erased',
  'Customer.accountingContactId': 'retained',
  'SalesOrder.accountingInvoiceId': 'retained',
  'SalesOrderRefund.accountingCreditNoteId': 'retained',
  'SalesOrder.customerId': 'surrogate',
  'ShoppingCustomerLink.customerId': 'surrogate',
  // not customer data: suppliers, products, ledger accounts, staff users, purchasing documents
  'Product.accountingItemId': 'not-customer',
  'Supplier.accountingContactId': 'not-customer',
  'PurchaseInvoice.accountingInvoiceId': 'not-customer',
  'PurchaseInvoice.paymentAccountId': 'not-customer',
  'SupplierCreditNote.accountingCreditNoteId': 'not-customer',
  'AccountingAccount.externalAccountId': 'not-customer',
  'AccountingAccountBalanceSnapshot.externalAccountId': 'not-customer',
  'AccountingEventLog.accountingEventId': 'not-customer',
  'AccountingOperatorLedgerCheck.checkedByUserId': 'not-customer',
  'OutboundShadowWrite.accountingSyncLogId': 'not-customer',
  'Passkey.userId': 'not-customer',
  'Session.userId': 'not-customer',
  'ActivityLog.userId': 'not-customer',
  'Notification.userId': 'not-customer',
  'NotificationReadReceipt.userId': 'not-customer',
}

test('every column that stores a customer / contact / account identifier is decided, and the erased ones are erased', () => {
  const found: string[] = []
  for (const [, model, body] of SCHEMA.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    for (const raw of body.split('\n')) {
      const line = raw.split('//')[0].trim()
      const col = /^(\w+)\s+(String|Int|BigInt)(\[\])?\??(\s|$)/.exec(line)
      if (col && col[1] !== 'id' && /(customer|contact|account|client|buyer|shopper|user)\w*(id|ref|key)$/i.test(col[1])) found.push(`${model}.${col[1]}`)
    }
  }
  assert.deepEqual(found.sort(), Object.keys(IDENTIFIER_COLUMNS).sort())
  for (const [key, verdict] of Object.entries(IDENTIFIER_COLUMNS)) {
    if (verdict !== 'erased' || key === 'Customer.externalCustomerId') continue // an Int column: not in the String/Json classification; the erasure sets it to null (asserted below)
    const [model, column] = key.split('.') as [string, string]
    assert.ok(ERASURE_CLASSIFICATION[model]!.erased.includes(column), `${key} is classified erased`)
  }
})

test('the erasure deletes the storefront account link rows and does not keep the storefront id', () => {
  const src = readFileSync(new URL('../lib/domain/erasure/erase-personal-data.ts', import.meta.url), 'utf8')
  assert.match(src, /tx\.shoppingCustomerLink\.deleteMany\(\{ where: \{ customerId \} \}\)/)
  assert.match(src, /externalCustomerId: null/)
})
