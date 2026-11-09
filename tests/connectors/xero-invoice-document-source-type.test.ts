import assert from 'node:assert/strict'
import test from 'node:test'

import { lookupInvoiceDocumentClaims, lookupSalesCreditNoteDocumentClaims } from '../../lib/connectors/xero/invoice-document-source.ts'

/**
 * Choosing a document to SHOW A CUSTOMER requires the ledger to say explicitly that it is a sales invoice (ACCREC) or a sales credit note
 * (ACCRECCREDIT). The ownership fence reads a row with no Type as a claim (an unknown document counts); this read path refuses instead.
 */
const invoiceGet = (rows: Array<Record<string, unknown>>) => async () => ({ ok: true, status: 200, tenantId: 'tenant-A', data: { Invoices: rows } as never })
const row = (over: Record<string, unknown> = {}) => ({ InvoiceID: 'i1', InvoiceNumber: 'INV-1', Status: 'AUTHORISED', Total: 100, CurrencyCode: 'GBP', Type: 'ACCREC', ...over })

test('an invoice row with an explicit ACCREC Type is a candidate', async () => {
  const result = await lookupInvoiceDocumentClaims('INV-1', { get: invoiceGet([row()]) as never })
  assert.equal(result.ok, true)
  assert.equal(result.ok && result.claims.length, 1)
})

test('an invoice row with NO Type is refused, not selected: no claim is returned and the answer is a lookup failure', async () => {
  const result = await lookupInvoiceDocumentClaims('INV-1', { get: invoiceGet([row({ Type: undefined })]) as never })
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.error, /without an explicit sales-invoice Type/)
  // Even beside a properly typed one: the answer cannot be trusted to name one document.
  const mixed = await lookupInvoiceDocumentClaims('INV-1', { get: invoiceGet([row(), row({ InvoiceID: 'i2', Type: undefined })]) as never })
  assert.equal(mixed.ok, false)
})

test('a purchase bill under the same number is not a claim on the sales sequence (as before)', async () => {
  const result = await lookupInvoiceDocumentClaims('INV-1', { get: invoiceGet([row({ Type: 'ACCPAY' })]) as never })
  assert.equal(result.ok, true)
  assert.equal(result.ok && result.claims.length, 0)
})

const creditGet = (rows: Array<Record<string, unknown>>) => async () => ({ ok: true, status: 200, tenantId: 'tenant-A', data: { CreditNotes: rows } as never })
const credit = (over: Record<string, unknown> = {}) => ({ CreditNoteID: 'c1', CreditNoteNumber: 'CN-1', Status: 'AUTHORISED', Type: 'ACCRECCREDIT', ...over })

test('a credit note needs the explicit ACCRECCREDIT Type; a missing one is refused, another type is skipped', async () => {
  const ok = await lookupSalesCreditNoteDocumentClaims('CN-1', { get: creditGet([credit()]) as never })
  assert.equal(ok.ok && ok.claims.length, 1)
  const missing = await lookupSalesCreditNoteDocumentClaims('CN-1', { get: creditGet([credit({ Type: undefined })]) as never })
  assert.equal(missing.ok, false)
  assert.match(missing.ok ? '' : missing.error, /without an explicit Type/)
  const other = await lookupSalesCreditNoteDocumentClaims('CN-1', { get: creditGet([credit({ Type: 'ACCPAYCREDIT' })]) as never })
  assert.equal(other.ok && other.claims.length, 0)
})
