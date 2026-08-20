import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

mock.module('@/lib/db', {
  namedExports: { db: { product: { findMany: async () => [] } } },
})

const orderImport = () => import('@/lib/connectors/woocommerce/sync/order-import')
const xeroInvoices = () => import('@/lib/connectors/xero/invoices')

import { settlementStatus } from '@/lib/domain/accounting/settlement-status'
import type { WcResolvedRateForDocument } from '@/lib/connectors/woocommerce/sync/order-import'

/**
 * o3d-cyn round 2 — SHIPPING NEED NOT CARRY THE GOODS' TAX RATE.
 *
 * The importer sent the shipping line on `accountingTaxType`, the order default derived from the
 * GOODS. A store charging a different rate on delivery therefore posted a document Xero totals
 * differently from `wcOrder.total` — and then registered a payment for `wcOrder.total` against it.
 *
 * The failure is quiet in the worst direction. Xero ACCEPTS a payment smaller than the invoice as a
 * PART payment, so the invoice sits AUTHORISED with a balance for ever, while IMS compares the amount
 * it sent (the order total) against `ledgerSalesInvoiceTotalForeign` (the order total) and prints
 * SETTLED. Every figure IMS checks agrees; the only one that disagrees is the ledger's.
 */

const OUTPUT2: WcResolvedRateForDocument = { accountingTaxType: 'OUTPUT2', taxRateValue: 0.2, source: 'mapped' }
const ZERO: WcResolvedRateForDocument = { accountingTaxType: 'ZERORATEDOUTPUT', taxRateValue: 0, source: 'mapped' }
/** Woo named a rate id; IMS has no mapping for it, so `resolveWcTaxRateById` substitutes a default. */
const UNMAPPED: WcResolvedRateForDocument = { accountingTaxType: 'OUTPUT2', taxRateValue: 0.2, source: 'default' }

const RATE_BY_ID = new Map<number, WcResolvedRateForDocument>([[1, OUTPUT2], [2, ZERO], [7, UNMAPPED]])

type XeroLine = { Quantity?: number; UnitAmount?: number; DiscountAmount?: number; Description?: string; TaxType?: string }

const penny = (v: number) => Math.round(v * 100) / 100

/** What Xero makes of an Exclusive payload when each line's TaxType carries its OWN rate. */
function xeroDocumentTotal(payload: Record<string, unknown>, rateByTaxType: Record<string, number>): number {
  assert.equal(payload.LineAmountTypes, 'Exclusive')
  return penny((payload.LineItems as XeroLine[]).reduce((sum, line) => {
    const net = penny((line.Quantity ?? 0) * (line.UnitAmount ?? 0) - (line.DiscountAmount ?? 0))
    return sum + net + penny(net * (rateByTaxType[line.TaxType ?? ''] ?? 0))
  }, 0))
}

async function buildDocument(input: { goodsNet: number; goodsTaxType: string; shippingNet: number; shippingTaxType: string }) {
  const { buildSalesInvoicePayload } = await xeroInvoices()
  return buildSalesInvoicePayload(
    {
      invoiceNumber: 'WC-INV-1',
      contactName: 'A Customer',
      date: '2026-08-20',
      currency: 'GBP',
      lines: [{ description: 'Widget', quantity: 1, unitAmount: input.goodsNet, accountCode: '200', taxType: input.goodsTaxType }],
      shippingAmount: input.shippingNet,
      shippingAccountCode: '425',
      shippingTaxType: input.shippingTaxType,
      lineAmountsIncludeTax: false,
    },
    'AUTHORISED',
    'contact-1',
    new Set<string>(),
  )
}

// --- the case that must now pass ---------------------------------------------------------------

test('zero-rated postage beside standard-rated goods posts a document that totals to the order (o3d-cyn r2)', async () => {
  // Woo: goods net 100.00 + 20.00 VAT; shipping net 10.00 + 0.00 VAT (rate id 2, a mapped 0% rate).
  // wcOrder.total = 100 + 20 + 10 + 0 = 130.00.
  const { resolveWcShippingTaxRate, reconcileWcDocumentTax, resolveWcInvoicePaymentAmount } = await orderImport()

  const shippingTax = resolveWcShippingTaxRate({
    shippingLines: [{ total_tax: '0.00', taxes: [{ id: 2, total: '0.00' }] }],
    shippingNetForeign: 10,
    rateById: RATE_BY_ID,
    orderDefault: OUTPUT2,
  })
  assert.equal(shippingTax.resolved, true)
  assert.equal(shippingTax.taxType, 'ZERORATEDOUTPUT', 'the shipping line carries the rate WooCommerce actually charged')
  assert.equal(shippingTax.rateValue, 0)

  const reconciliation = reconcileWcDocumentTax([
    { label: 'WIDGET', netForeign: 100, rateValue: 0.2, reportedTaxForeign: '20.00' },
    { label: 'Shipping', netForeign: 10, rateValue: shippingTax.rateValue, reportedTaxForeign: '0.00' },
  ])
  assert.deepEqual(reconciliation.disagreements, [])

  const payload = await buildDocument({ goodsNet: 100, goodsTaxType: 'OUTPUT2', shippingNet: 10, shippingTaxType: shippingTax.taxType! })
  assert.equal(
    xeroDocumentTotal(payload, { OUTPUT2: 0.2, ZERORATEDOUTPUT: 0 }),
    130,
    'invoice must total wcOrder.total 130.00; 132.00 is the pre-fix figure, taxing postage at the goods rate',
  )
  assert.equal(
    resolveWcInvoicePaymentAmount({ date_paid_gmt: '2026-08-20T10:00:00', total: '130.00' }, { totalsToTheOrder: true }),
    130,
    'and the gross payment settles it exactly, instead of part-paying a 132.00 invoice for ever',
  )
})

test('the mirror image — zero-rated goods with standard-rated delivery — totals to the order too', async () => {
  // Woo: goods net 100.00 + 0.00 VAT (zero-rated); shipping net 10.00 + 2.00 VAT. Order total 112.00.
  // Before, shipping took the goods' ZERO rate: a 110.00 invoice against which the 112.00 payment is
  // REFUSED by Xero outright — a different failure from the same defect.
  const { resolveWcShippingTaxRate } = await orderImport()
  const shippingTax = resolveWcShippingTaxRate({
    shippingLines: [{ total_tax: '2.00', taxes: [{ id: 1, total: '2.00' }] }],
    shippingNetForeign: 10,
    rateById: RATE_BY_ID,
    orderDefault: ZERO,
  })
  assert.equal(shippingTax.taxType, 'OUTPUT2')

  const payload = await buildDocument({ goodsNet: 100, goodsTaxType: 'ZERORATEDOUTPUT', shippingNet: 10, shippingTaxType: 'OUTPUT2' })
  assert.equal(xeroDocumentTotal(payload, { OUTPUT2: 0.2, ZERORATEDOUTPUT: 0 }), 112)
})

// --- the case that must still refuse -----------------------------------------------------------

test('a shipping rate IMS cannot explain refuses to register the payment rather than half-settling it', async () => {
  // Woo charged 0.50 on 10.00 of shipping — 5%. IMS has no mapping for rate id 7, and the order
  // default is 20%. Neither reproduces 0.50, so the tax type the document would carry is a guess.
  //
  // The arithmetic of guessing: order total 100 + 20 + 10 + 0.50 = 130.50, while the document Xero
  // builds at the order default is 100 + 20 + 10 + 2.00 = 132.00. A 130.50 payment PART-settles it
  // and leaves 1.50 outstanding, and IMS — comparing 130.50 against 130.50 — reports SETTLED.
  const { resolveWcShippingTaxRate, reconcileWcDocumentTax, resolveWcInvoicePaymentAmount } = await orderImport()

  const shippingTax = resolveWcShippingTaxRate({
    shippingLines: [{ total_tax: '0.50', taxes: [{ id: 7, total: '0.50' }] }],
    shippingNetForeign: 10,
    rateById: RATE_BY_ID,
    orderDefault: OUTPUT2,
  })
  assert.equal(shippingTax.resolved, false)
  assert.match(shippingTax.reason ?? '', /charged 0\.50 of tax on 10\.00 of shipping/)
  assert.match(shippingTax.reason ?? '', /neither the order's default rate of 20\.00%/)

  const reconciliation = reconcileWcDocumentTax([
    { label: 'WIDGET', netForeign: 100, rateValue: 0.2, reportedTaxForeign: '20.00' },
    { label: 'Shipping', netForeign: 10, rateValue: shippingTax.rateValue, reportedTaxForeign: '0.50' },
  ])
  assert.equal(reconciliation.reconciles, false)
  assert.deepEqual(reconciliation.disagreements, [
    { label: 'Shipping', modelledTax: 2, reportedTax: 0.5, difference: 1.5 },
  ])

  assert.equal(
    resolveWcInvoicePaymentAmount({ date_paid_gmt: '2026-08-20T10:00:00', total: '130.50' }, { totalsToTheOrder: false }),
    undefined,
    'registering 130.50 against a 132.00 document buys a green badge over a balance nobody is looking at',
  )

  // And what the operator is shown instead: the disagreement, not a settlement.
  const verdict = settlementStatus({ paidLocally: true, syncEnabled: true, documentPosted: true, payment: null, totalForeign: 130.5 })
  assert.equal(verdict.status, 'NOT_SENT')
  assert.equal(verdict.discrepancy, true)
})

test('a GOODS line whose mapped rate does not reproduce Woo\'s own line tax is caught too', async () => {
  const { reconcileWcDocumentTax } = await orderImport()
  // Woo charged 5.00 on a net-100 line; the mapped rate would make Xero charge 20.00.
  const reconciliation = reconcileWcDocumentTax([
    { label: 'WIDGET', netForeign: 100, rateValue: 0.2, reportedTaxForeign: '5.00' },
    { label: 'Shipping', netForeign: 0, rateValue: 0, reportedTaxForeign: '0' },
  ])
  assert.equal(reconciliation.reconciles, false)
  assert.equal(reconciliation.disagreements[0].label, 'WIDGET')
  assert.equal(reconciliation.disagreements[0].difference, 15)
})

// --- controls: the paths that were already right must not move -----------------------------------

test('an ordinary single-rate order is unchanged, even when its shipping rate id is unmapped', async () => {
  // The order default reproduces the shipping tax, which is what was always sent. PASSES BOTH WAYS
  // BY DESIGN — it is here to prove the fix did not start refusing the common case.
  const { resolveWcShippingTaxRate } = await orderImport()
  const resolution = resolveWcShippingTaxRate({
    shippingLines: [{ total_tax: '2.00', taxes: [{ id: 7, total: '2.00' }] }],
    shippingNetForeign: 10,
    rateById: RATE_BY_ID,
    orderDefault: OUTPUT2,
  })
  assert.equal(resolution.resolved, true)
  assert.equal(resolution.taxType, 'OUTPUT2')
  assert.equal(resolution.rateValue, 0.2)
})

test('an order with no shipping resolves trivially and never refuses', async () => {
  const { resolveWcShippingTaxRate } = await orderImport()
  const resolution = resolveWcShippingTaxRate({
    shippingLines: [], shippingNetForeign: 0, rateById: RATE_BY_ID, orderDefault: OUTPUT2,
  })
  assert.equal(resolution.resolved, true)
  assert.equal(resolution.rateValue, 0, 'no shipping line reaches the document, so nothing about it can be taxed wrongly')
})

test('rounded money, not rate fractions: 8.33 of shipping at 20% still reconciles', async () => {
  // 8.33 x 0.2 = 1.666 -> Woo charged 1.67. Comparing FRACTIONS (1.67/8.33 = 0.2005) would call the
  // standard rate a mismatch on ordinary orders; comparing the MONEY it produces does not.
  const { resolveWcShippingTaxRate, reconcileWcDocumentTax } = await orderImport()
  const resolution = resolveWcShippingTaxRate({
    shippingLines: [{ total_tax: '1.67', taxes: [{ id: 1, total: '1.67' }] }],
    shippingNetForeign: 8.33,
    rateById: RATE_BY_ID,
    orderDefault: OUTPUT2,
  })
  assert.equal(resolution.resolved, true)
  assert.equal(resolution.taxType, 'OUTPUT2')
  assert.equal(
    reconcileWcDocumentTax([{ label: 'Shipping', netForeign: 8.33, rateValue: 0.2, reportedTaxForeign: '1.67' }]).reconciles,
    true,
  )
})
