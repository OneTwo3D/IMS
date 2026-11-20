import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { creditNoteDocumentDay, originalSalesInvoiceDay, salesInvoiceDocumentDay } from '@/lib/domain/accounting/document-date'

/**
 * The documents IMS sends keep their ORIGINAL document day on a retry or an update (o3d-z5shj). The credit-note and invoice builders live in the 'use server' file
 * app/actions/sales.ts, whose queueing needs the whole accounting stack, so this file proves (a) the day each rule yields and (b) that the call sites use the rule.
 */

test('a refund raised 30 Sep (23:30 BST) is dated 30 Sep however late a retry runs', () => {
  const createdAt = new Date('2026-09-30T22:30:00Z')
  assert.equal(creditNoteDocumentDay(createdAt), '2026-09-30')
  assert.notEqual(creditNoteDocumentDay(new Date('2026-10-02T10:00:00Z')), '2026-09-30', 'the clock on the retry day would say 2 Oct')
})

test('an invoice created 30 Sep and edited 2 Oct keeps 30 Sep: the creation day, else the stored stamp (written from the sent date), else today', () => {
  const edited = new Date('2026-10-02T10:00:00Z')
  assert.equal(originalSalesInvoiceDay({ externalCreatedAt: new Date('2026-09-30T22:50:00Z'), invoicedAt: new Date('2026-09-30T23:30:00Z'), now: edited }), '2026-09-30')
  assert.equal(originalSalesInvoiceDay({ externalCreatedAt: new Date('2026-09-30T22:50:00Z'), invoicedAt: null, now: edited }), salesInvoiceDocumentDay(new Date('2026-09-30T22:50:00Z')))
  assert.equal(originalSalesInvoiceDay({ externalCreatedAt: null, invoicedAt: new Date('2026-09-30T00:00:00Z'), now: edited }), '2026-09-30', 'a manual order: the day its first post was sent with')
  assert.equal(originalSalesInvoiceDay({ externalCreatedAt: null, invoicedAt: null, now: edited }), '2026-10-02', 'nothing posted: today (a first post)')
})

test('call sites: the update arm uses the original day, the credit note uses the refund row, the live stamp uses the payload date', () => {
  const sales = readFileSync('app/actions/sales.ts', 'utf8')
  assert.match(sales, /date: so\.accountingInvoiceId \? originalInvoiceDay : businessDateYmd\(new Date\(\)\)/)
  assert.match(sales, /date: creditNoteDocumentDay\(refundRow\?\.createdAt \?\? new Date\(\)\)/)
  assert.doesNotMatch(sales, /date: creditNoteDocumentDay\(new Date\(\)\)/)
  const processor = readFileSync('lib/connectors/xero/sync-processor.ts', 'utf8')
  assert.match(processor, /recoverPostedBusinessDate\(postedPayload as Record<string, unknown>\)/)
  const po = readFileSync('app/actions/purchase-orders.ts', 'utf8')
  assert.match(po, /postedAt: creditNotePostedAt/)
})
