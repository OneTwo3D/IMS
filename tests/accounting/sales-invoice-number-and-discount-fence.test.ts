import assert from 'node:assert/strict'
import test from 'node:test'
import { toDecimal } from '@/lib/domain/math/decimal'

/**
 * o3d-hqvrp.69 / .323, pure and source-shape checks (no network, no database).
 *   .69  an order whose invoice is queued adopts the queued number instead of minting a second one, except for a deleted invoice's.
 *   .323 the server-derived discount reversal is refused when it would post at a rate other than the order's header rate.
 */

test('[.69] a queued invoice number is adopted; with none queued a number is minted', async () => {
  const { resolveInvoiceNumberToRecord } = await import('@/lib/domain/accounting/sales-invoice-number')
  const o = { orderAccountingInvoiceId: null, deletedExternalIds: [] as string[] }
  assert.deepEqual(resolveInvoiceNumberToRecord({ ...o, queuedInvoices: [{ invoiceNumber: ' INV-SO1 ', externalId: null }] }), { action: 'adopt-queued', invoiceNumber: 'INV-SO1' })
  for (const none of [null, undefined, '', '  ']) assert.deepEqual(resolveInvoiceNumberToRecord({ ...o, queuedInvoices: [{ invoiceNumber: none, externalId: null }] }), { action: 'mint' })
  assert.deepEqual(resolveInvoiceNumberToRecord({ ...o, queuedInvoices: [] }), { action: 'mint' })
})

test('[.69] a row that has posted but is not back-referenced yet (order link still null) is adopted', async () => {
  const { resolveInvoiceNumberToRecord } = await import('@/lib/domain/accounting/sales-invoice-number')
  assert.deepEqual(resolveInvoiceNumberToRecord({ orderAccountingInvoiceId: null, deletedExternalIds: [], queuedInvoices: [{ invoiceNumber: 'INV-00042', externalId: 'x-1' }] }), { action: 'adopt-queued', invoiceNumber: 'INV-00042' })
})

test('[.69] the number of a deleted/voided invoice (recorded deletion) is never adopted', async () => {
  const { resolveInvoiceNumberToRecord } = await import('@/lib/domain/accounting/sales-invoice-number')
  assert.deepEqual(resolveInvoiceNumberToRecord({ orderAccountingInvoiceId: null, deletedExternalIds: ['x-1'], queuedInvoices: [{ invoiceNumber: 'INV-00042', externalId: 'x-1' }] }), { action: 'mint' })
  // A newer pending row beats the stale deleted one.
  assert.deepEqual(resolveInvoiceNumberToRecord({ orderAccountingInvoiceId: null, deletedExternalIds: ['x-1'], queuedInvoices: [{ invoiceNumber: 'INV-NEW', externalId: null }, { invoiceNumber: 'INV-00042', externalId: 'x-1' }] }), { action: 'adopt-queued', invoiceNumber: 'INV-NEW' })
  // The order links a different document: the row is not its invoice.
  assert.deepEqual(resolveInvoiceNumberToRecord({ orderAccountingInvoiceId: 'x-2', deletedExternalIds: [], queuedInvoices: [{ invoiceNumber: 'INV-00042', externalId: 'x-1' }] }), { action: 'mint' })
  assert.deepEqual(resolveInvoiceNumberToRecord({ orderAccountingInvoiceId: 'x-1', deletedExternalIds: [], queuedInvoices: [{ invoiceNumber: 'INV-00042', externalId: 'x-1' }] }), { action: 'adopt-queued', invoiceNumber: 'INV-00042' })
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
