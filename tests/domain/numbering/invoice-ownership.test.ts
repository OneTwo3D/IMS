import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { DOCUMENT_TYPE_SPECS, NUMBERED_DOCUMENT_TYPES, isNumberedDocumentType } from '../../../lib/domain/numbering/document-types.ts'
import { describeSalesInvoiceNumberOwner } from '../../../lib/domain/numbering/invoice-number-owner.ts'
import { ownershipRowFor } from '../../../lib/security/writer-ownership-map.ts'

/**
 * SALES INVOICE NUMBERS STAY UNCONFIGURABLE WHILE THE INCUMBENT OWNS THEM. Nothing in this feature may change how a
 * sales invoice is numbered: not the settings, not the code path that mints a manual order's invoice number.
 */
const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')

test('the ownership map still says the incumbent owns sales invoices in both phases, and the screen says so', () => {
  const row = ownershipRowFor('xero', 'sales.invoice')
  assert.equal(row?.owners.P1, 'xeroom')
  assert.equal(row?.owners.P2, 'xeroom')
  const owner = describeSalesInvoiceNumberOwner()
  assert.equal(owner.owner, 'xeroom')
  assert.equal(owner.ownerLabel, 'Xeroom')
  assert.equal(owner.configurable, false)
  assert.match(owner.message, /belong to Xeroom/)
  assert.match(owner.message, /does not change how they are numbered/)
})

test('no invoice type is in the configurable registry, and none can be named to the actions', () => {
  assert.deepEqual([...NUMBERED_DOCUMENT_TYPES].sort(), ['credit_note', 'purchase_order', 'sales_order', 'shipment'])
  for (const name of ['sales_invoice', 'invoice', 'inv', 'INVOICE', 'sales_order ', '__proto__', 'constructor', '']) {
    assert.equal(isNumberedDocumentType(name), false, name)
  }
  for (const type of NUMBERED_DOCUMENT_TYPES) assert.doesNotMatch(String(DOCUMENT_TYPE_SPECS[type].prefixKey), /inv/)
})

test('the numbering module never touches the invoice number column or the invoice prefix', () => {
  for (const file of ['lib/domain/numbering/mint.ts', 'lib/domain/numbering/document-types.ts', 'lib/domain/numbering/pattern.ts', 'app/actions/document-numbering.ts']) {
    const text = read(file).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
    assert.doesNotMatch(text, /invoiceNumber|inv_prefix|document_counter:invoice/, file)
  }
})

test('generateInvoiceNumber still mints from the invoice prefix and its own counter, exactly as before', () => {
  const sales = read('app/actions/sales.ts')
  const body = sales.slice(sales.indexOf('export async function generateInvoiceNumber'), sales.indexOf('// Payments'))
  assert.match(body, /nextDocumentNumber\(tx, \{\s*key: 'invoice',\s*prefix: numbering\.inv_prefix,\s*\}\)/)
  assert.doesNotMatch(body, /mintDocumentNumber|mintRequiredDocumentNumber/)
  // the order of the guard that refuses a storefront-supplied number is untouched
  assert.ok(body.indexOf('invoiceNumberIsExternallySupplied') < body.indexOf('nextDocumentNumber(tx'))
})

test('the Xero invoice number is still the persisted one, falling back to the prefix and the order reference', () => {
  const resolver = read('lib/domain/accounting/sales-invoice-number.ts')
  assert.match(resolver, /return \{ invoiceNumber: `\$\{params\.fallbackPrefix\}\$\{params\.orderReference\}`, source: 'derived' \}/)
})
