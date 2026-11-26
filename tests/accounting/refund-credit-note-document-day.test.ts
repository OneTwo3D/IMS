import assert from 'node:assert/strict'
import test from 'node:test'

import { creditNoteDocumentDay, originalDayDecision, originalSalesInvoiceDay, salesInvoiceDocumentDay } from '@/lib/domain/accounting/document-date'
import { postedInvoicedAt } from '@/lib/domain/accounting/posted-invoice-date'
import { SalesInvoiceNotQueuedError, SalesInvoiceOriginalDateUnknownError } from '@/lib/domain/sales/sales-invoice-reconciliation'
import { salesInvoiceUpdateDateDecision } from '@/lib/domain/accounting/document-date'
import { salesInvoiceUpdateSeamVerdict } from '@/lib/domain/accounting/xero-producer-seam'
import { WRITER_OWNERSHIP_MAP } from '@/lib/security/writer-ownership-map'
import { PRODUCER_CUTOFF_ENV, PRODUCER_HOLD_ENFORCED_ENV } from '@/lib/security/producer-disposition-constants'
import { OUTBOUND_GRANT_ENV } from '@/lib/security/outbound-write-hold-constants'

/**
 * The documents IMS sends keep their ORIGINAL document day on a retry or an update. Every rule here is a pure function exercised by its inputs; the
 * database-tier counterpart is tests/db/document-date-payload.test.ts.
 */

const edited = new Date('2026-10-02T10:00:00Z')

test('a refund raised 30 Sep (23:30 BST) is dated 30 Sep however late a retry runs', () => {
  const createdAt = new Date('2026-09-30T22:30:00Z')
  assert.equal(creditNoteDocumentDay(createdAt), '2026-09-30')
  assert.notEqual(creditNoteDocumentDay(edited), '2026-09-30', 'the clock on the retry day would say 2 Oct')
})

test('a FIRST post (no accounting invoice id yet) is dated today, whatever else the order stores', () => {
  assert.equal(originalSalesInvoiceDay({ accountingInvoiceId: null, externalCreatedAt: new Date('2026-09-30T10:00:00Z'), invoicedAt: new Date('2026-09-30T00:00:00Z'), now: edited }), '2026-10-02')
  assert.equal(originalSalesInvoiceDay({ accountingInvoiceId: undefined, externalCreatedAt: null, invoicedAt: null, now: edited }), '2026-10-02')
})

test('an UPDATE keeps the date the invoice already has: the posted payload date first, then the storefront creation day, then the stored stamp', () => {
  const posted = new Date('2026-09-30T00:00:00Z')
  // The payload date wins over a stored stamp that holds the post INSTANT (00:30 BST on 1 Oct = a day off) and over a creation day that differs.
  assert.equal(originalSalesInvoiceDay({ accountingInvoiceId: 'inv-1', postedPayloadDate: posted, externalCreatedAt: null, invoicedAt: new Date('2026-09-30T23:30:00Z'), now: edited }), '2026-09-30')
  assert.equal(originalSalesInvoiceDay({ accountingInvoiceId: 'inv-1', postedPayloadDate: posted, externalCreatedAt: new Date('2026-09-29T10:00:00Z'), invoicedAt: null, now: edited }), '2026-09-30')
  assert.equal(originalSalesInvoiceDay({ accountingInvoiceId: 'inv-1', postedPayloadDate: null, externalCreatedAt: new Date('2026-09-30T22:50:00Z'), invoicedAt: new Date('2026-09-30T23:30:00Z'), now: edited }), salesInvoiceDocumentDay(new Date('2026-09-30T22:50:00Z')))
  assert.equal(originalSalesInvoiceDay({ accountingInvoiceId: 'inv-1', postedPayloadDate: null, externalCreatedAt: null, invoicedAt: new Date('2026-09-30T00:00:00Z'), now: edited }), '2026-09-30', 'a manual order: the day its first post was sent with')
})

test('an UPDATE whose original date is unreadable is REFUSED (null), never today', () => {
  const day = originalSalesInvoiceDay({ accountingInvoiceId: 'inv-1', postedPayloadDate: null, externalCreatedAt: null, invoicedAt: null, now: edited })
  assert.equal(day, null)
  assert.notEqual(day, '2026-10-02')
})

test('the refusal is a not-queued refusal with a visible reason (every caller that refuses a declined invoice refuses it)', () => {
  const error = new SalesInvoiceOriginalDateUnknownError()
  assert.ok(error instanceof SalesInvoiceNotQueuedError)
  assert.equal(error.name, 'SalesInvoiceOriginalDateUnknownError')
  assert.match(error.message, /date IMS cannot read/)
  assert.match(error.message, /nothing was saved/)
})

test('the live stamp: a sales invoice of a SalesOrder is stamped with the payload date (UTC midnight of that day); anything else, or no readable date, is left to the caller', () => {
  assert.equal(postedInvoicedAt('SALES_INVOICE', 'SalesOrder', { date: '2026-09-30' })?.toISOString(), '2026-09-30T00:00:00.000Z')
  assert.equal(postedInvoicedAt('SALES_INVOICE', 'SalesOrder', { date: ' 2026-09-30 ' })?.toISOString(), '2026-09-30T00:00:00.000Z')
  assert.equal(postedInvoicedAt('SALES_INVOICE_UPDATE', 'SalesOrder', { date: '2026-09-30' }), undefined, 'an update is not a first post')
  assert.equal(postedInvoicedAt('CREDIT_NOTE', 'SalesOrderRefund', { date: '2026-09-30' }), undefined)
  assert.equal(postedInvoicedAt('SALES_INVOICE', 'PurchaseOrder', { date: '2026-09-30' }), undefined, 'only a sales order carries the stamp')
  assert.equal(postedInvoicedAt('SALES_INVOICE', 'SalesOrder', {}), undefined)
  assert.equal(postedInvoicedAt('SALES_INVOICE', 'SalesOrder', { date: 'not a date' }), undefined)
  assert.equal(postedInvoicedAt('SALES_INVOICE', 'SalesOrder', null), undefined)
  assert.equal(postedInvoicedAt('SALES_INVOICE', 'SalesOrder', 'x'), undefined)
})

test('with no readable date the update is refused when it would be sent, and only recorded (flagged unknown) when the producer hold shadows it', () => {
  assert.equal(originalDayDecision('2026-09-30', false), 'use')
  assert.equal(originalDayDecision('2026-09-30', true), 'use')
  assert.equal(originalDayDecision(null, false), 'refuse')
  assert.equal(originalDayDecision(null, true), 'shadow-unknown')
})

// ---- o3d-tqwjt: the update's date decision asks the facade's own question ----

const T_NOW = new Date('2026-06-01T12:00:00Z')
const T_ENFORCED = { [PRODUCER_HOLD_ENFORCED_ENV]: 'xero' }
const T_LIVE = { ...T_ENFORCED, [OUTBOUND_GRANT_ENV.xero]: '4f7f0c6e-1111-4222-8333-944455556666', [PRODUCER_CUTOFF_ENV.xero]: '2026-01-01T00:00:00Z' }
const unknownDay = (env: Record<string, string | undefined>, over: Partial<Parameters<typeof salesInvoiceUpdateDateDecision>[0]> = {}) =>
  salesInvoiceUpdateDateDecision({ documentDay: null, today: '2026-06-01', chartConnector: 'xero', documentConnector: 'xero', typeEnabled: true, env, now: T_NOW, ...over })

test('o3d-tqwjt: an unknown day under today\'s map and the enforced hold is a shadow-unknown; a known day is used', () => {
  assert.equal(unknownDay(T_ENFORCED), 'shadow-unknown')
  assert.equal(unknownDay(T_LIVE), 'shadow-unknown', 'Xeroom owns the update in P2 too')
  assert.equal(salesInvoiceUpdateDateDecision({ documentDay: '2026-05-01', today: '2026-06-01', chartConnector: 'xero', documentConnector: 'xero', typeEnabled: true, env: T_LIVE, now: T_NOW }), 'use')
})

test('o3d-tqwjt: a SIMULATED WRITER-MAP CHANGE (IMS owns sales.invoice-update in P2): the date check refuses where the old inputs said shadow, and agrees with the facade\'s verdict', () => {
  const target = (WRITER_OWNERSHIP_MAP as unknown as Array<{ destination: string; operation: string; owners: Record<string, string>; step: string }>).find((r) => r.destination === 'xero' && r.operation === 'sales.invoice-update')!
  const saved = { owners: { ...target.owners }, step: target.step }
  target.owners.P2 = 'IMS'
  target.step = 'xero'
  try {
    assert.equal(salesInvoiceUpdateSeamVerdict({ connector: 'xero', date: '2026-06-01', env: T_LIVE, now: T_NOW }).kind, 'live', 'precondition: the facade\'s inputs say LIVE')
    assert.equal(unknownDay(T_LIVE), 'refuse', 'the update would be sent with today\'s date, so the edit is refused')
  } finally {
    target.owners = saved.owners
    target.step = saved.step
  }
})

test('o3d-tqwjt: with the hold unset the refusal fires only when a live send would happen (Xero chart and document, type switched on)', () => {
  assert.equal(unknownDay({}), 'refuse', 'legacy and would be sent')
  assert.equal(unknownDay({}, { typeEnabled: false }), 'shadow-unknown', 'sync off: nothing would be sent')
  assert.equal(unknownDay({}, { chartConnector: 'retired-ledger' }), 'shadow-unknown', 'chart is not the Xero connector: nothing would be sent')
  assert.equal(unknownDay({}, { documentConnector: null }), 'shadow-unknown', 'the facade refuses an unattributable document: nothing is sent')
})
