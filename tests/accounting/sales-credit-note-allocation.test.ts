import assert from 'node:assert/strict'
import test, { beforeEach, mock } from 'node:test'
import { toDecimal } from '@/lib/domain/math/decimal'

/**
 * o3d-hqvrp.39 / .69 / .323, with Xero and the database doubled (no network).
 *   .39  a posted sales credit note is applied to its invoice, capped by what the note has left and the invoice owes; the setting that enables it is OFF by default.
 *   .69  an order whose invoice is queued adopts the queued number instead of minting a second one.
 *   .323 the server-derived discount reversal is refused when it would post at a rate the discount was not charged at.
 */

let xeroBodies: Record<string, unknown> = {}
let puts: Array<{ path: string; body: { Allocations: Array<{ Amount: number }> } }> = []

mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroGet: async (path: string) => (path in xeroBodies ? { ok: true, status: 200, data: xeroBodies[path] } : { ok: false, status: 404, error: 'not stubbed' }),
    xeroPost: async () => ({ ok: false, status: 500, error: 'not expected' }),
    xeroPut: async (path: string, body: { Allocations: Array<{ Amount: number; Invoice: { InvoiceID: string } }> }) => {
      puts.push({ path, body })
      return { ok: true, status: 200, data: { Allocations: body.Allocations } }
    },
  },
})
mock.module('@/lib/connectors/xero/contacts', { namedExports: { findOrCreateContact: async () => 'contact-1' } })

beforeEach(() => { xeroBodies = {}; puts = [] })

function stub(cn: Record<string, unknown>, inv: Record<string, unknown>) {
  xeroBodies = {
    'CreditNotes/cn-1': { CreditNotes: [{ CreditNoteID: 'cn-1', Status: 'AUTHORISED', Total: 30, RemainingCredit: 30, Allocations: [], ...cn }] },
    'Invoices/inv-1': { Invoices: [{ InvoiceID: 'inv-1', AmountDue: 100, ...inv }] },
  }
}
const P = { creditNoteId: 'cn-1', invoiceId: 'inv-1', date: '2026-11-18' }

test('[.39] a posted credit note is allocated in full to an invoice that owes more', async () => {
  const { allocateSalesCreditNoteToInvoice } = await import('@/lib/connectors/xero/credit-notes')
  stub({}, {})
  const r = await allocateSalesCreditNoteToInvoice(P)
  assert.equal(r.success, true, JSON.stringify(r))
  assert.equal(puts.length, 1)
  assert.equal(puts[0].path, 'CreditNotes/cn-1/Allocations')
  assert.equal(puts[0].body.Allocations[0].Amount, 30)
})

test('[.39] an invoice that owes less takes only what it owes, and that is a success', async () => {
  const { allocateSalesCreditNoteToInvoice } = await import('@/lib/connectors/xero/credit-notes')
  stub({}, { AmountDue: 12 })
  const r = await allocateSalesCreditNoteToInvoice(P)
  assert.equal(r.success, true, JSON.stringify(r))
  assert.equal(puts[0].body.Allocations[0].Amount, 12)
})

test('[.39] an invoice with nothing due (paid, then refunded) is refused and nothing is sent', async () => {
  const { allocateSalesCreditNoteToInvoice } = await import('@/lib/connectors/xero/credit-notes')
  stub({}, { AmountDue: 0 })
  const r = await allocateSalesCreditNoteToInvoice(P)
  assert.equal(r.success, false)
  assert.equal(puts.length, 0)
})

test('[.39] a credit note that is not AUTHORISED is not allocated', async () => {
  const { allocateSalesCreditNoteToInvoice } = await import('@/lib/connectors/xero/credit-notes')
  stub({ Status: 'DRAFT' }, {})
  const r = await allocateSalesCreditNoteToInvoice(P)
  assert.equal(r.success, false)
  assert.match(r.error ?? '', /not AUTHORISED/)
  assert.equal(puts.length, 0)
})

test('[.39] a re-run after a full allocation (credit note PAID, allocation to this invoice on it) is a quiet success', async () => {
  const { allocateSalesCreditNoteToInvoice } = await import('@/lib/connectors/xero/credit-notes')
  stub({ Status: 'PAID', RemainingCredit: 0, Allocations: [{ Amount: 30, Invoice: { InvoiceID: 'inv-1' } }] }, { AmountDue: 70 })
  const r = await allocateSalesCreditNoteToInvoice(P)
  assert.equal(r.success, true, JSON.stringify(r))
  assert.equal(puts.length, 0)
})

test('[.39] an invoice with nothing due is reported as benign (INFO), not as a failure to warn about', async () => {
  const { allocateSalesCreditNoteToInvoice } = await import('@/lib/connectors/xero/credit-notes')
  stub({}, { AmountDue: 0 })
  const r = await allocateSalesCreditNoteToInvoice(P)
  assert.equal(r.success, false)
  assert.equal(r.benign, true)
})

test('[.39] the allocation runs after the success is recorded, and only for an order with no receipts', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync('lib/connectors/xero/sync-processor.ts', 'utf8')
  const drain = src.indexOf("entry.type === 'CREDIT_NOTE' && entry.referenceType === 'SalesOrderRefund' && syncResult.externalId")
  const persist = src.indexOf('await persistPostedXeroDocument({\n          entry,')
  assert.ok(persist > 0 && drain > persist, 'after persistPostedXeroDocument')
  const fn = src.slice(src.indexOf('async function allocateSalesCreditNoteAfterPost'))
  assert.match(fn, /order\.paidAt !== null \|\| receipts > 0 \|\| queuedReceipts > 0/)
  assert.ok(fn.indexOf('receipts > 0') < fn.indexOf('allocateSalesCreditNoteToInvoice('), 'the receipts check precedes the Xero call')
})

test('[.39] the enabling setting is off by default and is a saveable setting key', async () => {
  const { XERO_SETTING_KEYS } = await import('@/lib/connectors/xero/settings')
  assert.ok(XERO_SETTING_KEYS.includes('xero_sales_credit_note_allocation_enabled'))
  const fs = await import('node:fs')
  const src = fs.readFileSync('lib/connectors/xero/settings.ts', 'utf8')
  assert.match(src, /xero_sales_credit_note_allocation_enabled: 'false'/)
  const proc = fs.readFileSync('lib/connectors/xero/sync-processor.ts', 'utf8')
  assert.match(proc, /enabled\?\.value !== 'true'\) return/, 'the processor sends nothing unless the setting is exactly true')
})

test('[.69] a queued invoice number is adopted; with none queued a number is minted', async () => {
  const { resolveInvoiceNumberToRecord } = await import('@/lib/domain/accounting/sales-invoice-number')
  const o = { orderAccountingInvoiceId: null }
  assert.deepEqual(resolveInvoiceNumberToRecord({ ...o, queuedInvoices: [{ invoiceNumber: ' INV-SO1 ', externalId: null }] }), { action: 'adopt-queued', invoiceNumber: 'INV-SO1' })
  for (const none of [null, undefined, '', '  ']) assert.deepEqual(resolveInvoiceNumberToRecord({ ...o, queuedInvoices: [{ invoiceNumber: none, externalId: null }] }), { action: 'mint' })
  assert.deepEqual(resolveInvoiceNumberToRecord({ ...o, queuedInvoices: [] }), { action: 'mint' })
})

test('[.69] the number of a deleted/voided invoice (row posted, order link cleared) is never adopted', async () => {
  const { resolveInvoiceNumberToRecord } = await import('@/lib/domain/accounting/sales-invoice-number')
  // Delete unwind: order.accountingInvoiceId cleared, the old row stays SYNCED with its external id.
  assert.deepEqual(resolveInvoiceNumberToRecord({ orderAccountingInvoiceId: null, queuedInvoices: [{ invoiceNumber: 'INV-00042', externalId: 'x-1' }] }), { action: 'mint' })
  // Still linked: adopt. A newer pending row beats a stale deleted one.
  assert.deepEqual(resolveInvoiceNumberToRecord({ orderAccountingInvoiceId: 'x-1', queuedInvoices: [{ invoiceNumber: 'INV-00042', externalId: 'x-1' }] }), { action: 'adopt-queued', invoiceNumber: 'INV-00042' })
  assert.deepEqual(resolveInvoiceNumberToRecord({ orderAccountingInvoiceId: null, queuedInvoices: [{ invoiceNumber: 'INV-NEW', externalId: null }, { invoiceNumber: 'INV-00042', externalId: 'x-1' }] }), { action: 'adopt-queued', invoiceNumber: 'INV-NEW' })
})

test('[.69] generateInvoiceNumber consults the queued invoice before minting', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync('app/actions/sales.ts', 'utf8')
  const fn = src.slice(src.indexOf('export async function generateInvoiceNumber'))
  const read = fn.indexOf("type: 'SALES_INVOICE', referenceType: 'SalesOrder'")
  const mint = fn.indexOf('nextDocumentNumber(tx')
  assert.ok(read > 0 && mint > read, 'the sync-log read precedes the mint')
})

test('[.323] taxRatePercent is a FRACTION: 0.2000 against a 20% code passes, against 17.5% is refused, a zero rate is skipped', async () => {
  const { orderDiscountReversalRateRefusal } = await import('@/lib/domain/sales/refund-posted-tax-identity')
  const base = { label: 'The order discount reversal' }
  assert.equal(orderDiscountReversalRateRefusal({ ...base, postedRate: toDecimal('0.2'), chargedRate: '0.2000' }), null)
  assert.equal(orderDiscountReversalRateRefusal({ ...base, postedRate: toDecimal('0.2'), chargedRate: 0.2 }), null)
  const refused = orderDiscountReversalRateRefusal({ ...base, postedRate: toDecimal('0.175'), chargedRate: '0.2000' })
  assert.match(refused ?? '', /post at 17\.5% but .* charged at 20%/)
  assert.equal(orderDiscountReversalRateRefusal({ ...base, postedRate: toDecimal('0.2'), chargedRate: '0' }), null)
  assert.equal(orderDiscountReversalRateRefusal({ ...base, postedRate: toDecimal('0.2'), chargedRate: null }), null)
  assert.match(orderDiscountReversalRateRefusal({ ...base, postedRate: toDecimal('0'), chargedRate: '0.2000' }) ?? '', /post at 0%/)
})

test('[.323] the fence calls the discount check on the public path only', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync('lib/domain/sales/refund-service.ts', 'utf8')
  assert.match(src, /input\.deriveSaleLineNetsFromStoredBalance && !input\.chargeback && !creditsNothing\(refundLine\)/)
})
