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
  assert.deepEqual(resolveInvoiceNumberToRecord({ queuedInvoiceNumber: ' INV-SO1 ' }), { action: 'adopt-queued', invoiceNumber: 'INV-SO1' })
  for (const none of [null, undefined, '', '  ']) assert.deepEqual(resolveInvoiceNumberToRecord({ queuedInvoiceNumber: none }), { action: 'mint' })
})

test('[.69] generateInvoiceNumber consults the queued invoice before minting', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync('app/actions/sales.ts', 'utf8')
  const fn = src.slice(src.indexOf('export async function generateInvoiceNumber'))
  const read = fn.indexOf("type: 'SALES_INVOICE', referenceType: 'SalesOrder'")
  const mint = fn.indexOf('nextDocumentNumber(tx')
  assert.ok(read > 0 && mint > read, 'the sync-log read precedes the mint')
})

test('[.323] a discount reversal posting at another rate than the order charged is refused', async () => {
  const { orderDiscountReversalRateRefusal } = await import('@/lib/domain/sales/refund-posted-tax-identity')
  const base = { label: 'The order discount reversal' }
  assert.equal(orderDiscountReversalRateRefusal({ ...base, postedRate: toDecimal('0.2'), chargedRatePercent: '20' }), null)
  assert.match(orderDiscountReversalRateRefusal({ ...base, postedRate: toDecimal('0.25'), chargedRatePercent: '20' }) ?? '', /charged at 20%/)
  assert.match(orderDiscountReversalRateRefusal({ ...base, postedRate: toDecimal('0'), chargedRatePercent: 20 }) ?? '', /post at 0%/)
  // No header rate stated: nothing to compare against.
  assert.equal(orderDiscountReversalRateRefusal({ ...base, postedRate: toDecimal('0.25'), chargedRatePercent: null }), null)
  assert.equal(orderDiscountReversalRateRefusal({ ...base, postedRate: toDecimal('0.25'), chargedRatePercent: 0 }), null)
})

test('[.323] the fence calls the discount check on the public path only', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync('lib/domain/sales/refund-service.ts', 'utf8')
  assert.match(src, /input\.deriveSaleLineNetsFromStoredBalance && !input\.chargeback && !creditsNothing\(refundLine\)/)
})
