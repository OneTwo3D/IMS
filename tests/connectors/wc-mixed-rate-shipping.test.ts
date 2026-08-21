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

// ---------------------------------------------------------------------------------------------
// o3d-cyn ROUND 3 — A BLENDED SHIPPING LINE, AND WHAT A DOCUMENT IMS KNOWS IS WRONG MAY DO.
//
// Round 2 picks the shipping rate by ARITHMETIC: a candidate is accepted only if applying it to the
// shipping net reproduces the tax Woo charged. That is sound whenever ONE rate explains the charge —
// and a shipping line can be taxed at several at once (`shipping_lines[].taxes` is a LIST), in which
// case no single rate reproduces it unless the blend happens to SUM to one IMS holds.
//
// What round 2 then did with that answer was withhold the PAYMENT and post the invoice anyway. The
// payment is the recoverable half. Round 3 withholds the DOCUMENT.
// ---------------------------------------------------------------------------------------------

/** A 5% regional surcharge Woo can levy ALONGSIDE the standard rate on the same line. */
const OUTPUT5: WcResolvedRateForDocument = { accountingTaxType: 'OUTPUT5', taxRateValue: 0.05, source: 'mapped' }
/** A 15% rate, so a 15+5 blend SUMS to the 20% the order default already carries. */
const OUTPUT15: WcResolvedRateForDocument = { accountingTaxType: 'OUTPUT15', taxRateValue: 0.15, source: 'mapped' }
const BLEND_RATE_BY_ID = new Map<number, WcResolvedRateForDocument>([
  [1, OUTPUT2], [2, ZERO], [3, OUTPUT5], [4, OUTPUT15], [7, UNMAPPED],
])

test('a blended-rate shipping line names the BLEND, and refuses to give the line a tax type', async () => {
  // Woo: goods net 100.00 + 20.00 VAT. Shipping net 10.00 taxed TWICE — standard 20% (2.00) and a
  // 5% regional surcharge (0.50) — so Woo charged 2.50 on shipping and wcOrder.total is 132.50.
  // No single tax type produces 2.50 on 10.00: 20% gives 2.00, 5% gives 0.50.
  const { resolveWcShippingTaxRate, reconcileWcDocumentTax } = await orderImport()

  const shippingTax = resolveWcShippingTaxRate({
    shippingLines: [{ total_tax: '2.50', taxes: [{ id: 1, total: '2.00' }, { id: 3, total: '0.50' }] }],
    shippingNetForeign: 10,
    rateById: BLEND_RATE_BY_ID,
    orderDefault: OUTPUT2,
  })

  assert.equal(shippingTax.resolved, false)
  assert.equal(shippingTax.contributingRateCount, 2)
  assert.match(shippingTax.reason ?? '', /applied 2 tax rates to this shipping line, together charging 2\.50 on 10\.00/)
  assert.match(shippingTax.reason ?? '', /carries ONE tax type on shipping/)
  // The operator's next move differs between the two failures, so the message must not conflate them.
  assert.doesNotMatch(shippingTax.reason ?? '', /nor any WooCommerce shipping rate mapped in IMS/,
    'sending someone to hunt for a mapping would waste the trip — no mapping expresses a blend')

  // And the document it WOULD have posted, which is the amount half of the defect: shipping taxed at
  // the order default gives a 132.00 invoice for a 132.50 order.
  const reconciliation = reconcileWcDocumentTax([
    { label: 'WIDGET', netForeign: 100, rateValue: 0.2, reportedTaxForeign: '20.00' },
    { label: 'Shipping', netForeign: 10, rateValue: shippingTax.rateValue, reportedTaxForeign: '2.50' },
  ])
  assert.deepEqual(reconciliation.disagreements, [
    { label: 'Shipping', modelledTax: 2, reportedTax: 2.5, difference: -0.5 },
  ])
})

test('a blend that SUMS to a rate IMS holds still resolves — the arithmetic keeps its win', async () => {
  // The same two-rate shipping line, but 15% + 5%: Woo charged 2.00 on 10.00, which the order's own
  // 20% reproduces EXACTLY. There is a tax type that produces the right invoice, so the blend is not
  // a refusal — order total 132.00, document 132.00, and it settles.
  const { resolveWcShippingTaxRate, resolveWcInvoicePaymentAmount } = await orderImport()

  const shippingTax = resolveWcShippingTaxRate({
    shippingLines: [{ total_tax: '2.00', taxes: [{ id: 4, total: '1.50' }, { id: 3, total: '0.50' }] }],
    shippingNetForeign: 10,
    rateById: BLEND_RATE_BY_ID,
    orderDefault: OUTPUT2,
  })

  assert.equal(shippingTax.resolved, true, 'counting the rates must not pre-empt reproducing the charge')
  assert.equal(shippingTax.taxType, 'OUTPUT2')
  assert.equal(shippingTax.rateValue, 0.2)
  assert.equal(shippingTax.contributingRateCount, 2, 'it IS a blend; it is simply one a single rate explains')

  const payload = await buildDocument({ goodsNet: 100, goodsTaxType: 'OUTPUT2', shippingNet: 10, shippingTaxType: 'OUTPUT2' })
  assert.equal(xeroDocumentTotal(payload, { OUTPUT2: 0.2 }), 132)
  assert.equal(
    resolveWcInvoicePaymentAmount({ date_paid_gmt: '2026-08-20T10:00:00', total: '132.00' }, { totalsToTheOrder: true }),
    132,
  )
})

test('a rate listed at 0.00 alongside a charging one is NOT a blend', async () => {
  // Zero-rated postage beside a standard rate is one rate charging. Counting rate IDS rather than
  // CONTRIBUTIONS would call this a blend and refuse an order that resolves perfectly well.
  const { resolveWcShippingTaxRate } = await orderImport()
  const shippingTax = resolveWcShippingTaxRate({
    shippingLines: [{ total_tax: '2.00', taxes: [{ id: 1, total: '2.00' }, { id: 2, total: '0.00' }] }],
    shippingNetForeign: 10,
    rateById: BLEND_RATE_BY_ID,
    orderDefault: OUTPUT2,
  })
  assert.equal(shippingTax.resolved, true)
  assert.equal(shippingTax.taxType, 'OUTPUT2')
  assert.equal(shippingTax.contributingRateCount, 1)
})

// --- the document that will not total to its order does not reach the ledger --------------------

test('a stamped document is REFUSED at the poster, with the reason and the remedy on the refusal', async () => {
  const { buildUnreconciledTaxMarker, refuseUnreconciledDocument, UNRECONCILED_TAX_PAYLOAD_KEY } =
    await import('@/lib/domain/accounting/document-tax-reconciliation')

  const stamped = {
    invoiceNumber: 'WC-INV-1',
    shippingTaxType: 'OUTPUT2',
    [UNRECONCILED_TAX_PAYLOAD_KEY]: buildUnreconciledTaxMarker(
      'WooCommerce applied 2 tax rates to this shipping line, together charging 2.50 on 10.00 of shipping.',
    ),
  }
  const refusal = refuseUnreconciledDocument(stamped)
  assert.equal(refusal.post, false)
  assert.match(refusal.post === false ? refusal.reason : '', /NOTHING WAS SENT/)
  assert.match(refusal.post === false ? refusal.reason : '', /applied 2 tax rates/)
  assert.match(refusal.post === false ? refusal.reason : '', /re-import the order/)
})

test('an ordinary document is untouched by the guard — no key, no refusal', async () => {
  const { refuseUnreconciledDocument } = await import('@/lib/domain/accounting/document-tax-reconciliation')
  assert.deepEqual(refuseUnreconciledDocument({ invoiceNumber: 'WC-INV-1', shippingTaxType: 'OUTPUT2' }), { post: true })
})

test('a stamp that did not survive the round trip still refuses', async () => {
  // The marker travels through a Json column. Reading it back as a string, a null, or an empty object
  // means the reason is lost — it does NOT mean the document became right.
  const { refuseUnreconciledDocument, UNRECONCILED_TAX_PAYLOAD_KEY } =
    await import('@/lib/domain/accounting/document-tax-reconciliation')

  for (const mangled of ['a string', null, {}, { reason: 42 }]) {
    const refusal = refuseUnreconciledDocument({ [UNRECONCILED_TAX_PAYLOAD_KEY]: mangled })
    assert.equal(refusal.post, false, `a ${JSON.stringify(mangled)} marker must still refuse`)
    assert.match(refusal.post === false ? refusal.reason : '', /could not be read back/)
  }
})

test('the refused document leaves a verdict that points at the DOCUMENT, not the payment', async () => {
  // Nothing posted, so nothing settles — and the settlement verdict says which of the two to chase.
  const verdict = settlementStatus({ paidLocally: true, syncEnabled: true, documentPosted: false, payment: null, totalForeign: 132.5 })
  assert.equal(verdict.status, 'NOT_APPLICABLE')
  assert.match(verdict.detail, /document sync is what to chase, not the payment/)
  // What must NOT happen: a payment for the order total registered against a 132.00 invoice, which
  // Xero accepts as a PART payment and IMS reports as settled.
  assert.notEqual(verdict.status, 'SETTLED')
})

// --- the seam ----------------------------------------------------------------------------------
//
// The rules above are pure and unit-tested. What they cannot see is whether the importer STAMPS and
// the poster CONSULTS — one expression each, in the middle of a 1,600-line importer and a switch in
// the Xero processor, neither reachable without a database and a live ledger. Pinned at the source,
// the same way tests/connectors/wc-invoice-number-wiring.test.ts pins its own seam.

/** Block and line comments removed, so a commented-out call cannot satisfy a source scan. */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

test('the comment stripper actually strips — the scan below is worthless otherwise', () => {
  const stripped = withoutComments('/**\n * queueAccountingSync({\n */\nconst x = 1 // queueAccountingSync({\n')
  assert.doesNotMatch(stripped, /queueAccountingSync/)
  assert.match(stripped, /const x = 1/)
  assert.match(withoutComments("const url = 'https://x.test/a'"), /https:\/\/x\.test\/a/, 'a URL is not a comment')
})

test('the importer stamps the document it computed will not total to the order', async () => {
  const { readFileSync } = await import('node:fs')
  const src = withoutComments(readFileSync('lib/connectors/woocommerce/sync/order-import.ts', 'utf8'))

  assert.match(src, /const unreconciledReason = !documentTotalsToTheOrder/,
    'the reason must be derived from the reconciliation, not re-decided at the payload')
  assert.match(
    src,
    /\.\.\.\(unreconciledReason\s*\n?\s*\? \{ \[UNRECONCILED_TAX_PAYLOAD_KEY\]: buildUnreconciledTaxMarker\(unreconciledReason\) \}/,
    'the stamp must ride on the queued accounting payload, or the poster has nothing to refuse',
  )
  // Round 2's gate: the warning fired only for a PAID order, so an unpaid one posted a wrong document
  // in silence and was paid against it later.
  assert.doesNotMatch(src, /if \(!documentTotalsToTheOrder && wcOrder\.date_paid_gmt\)/,
    'the refusal must not be conditioned on the order already being paid')
  assert.match(src, /action: 'wc_invoice_tax_does_not_reconcile',\s*\n\s*tag: 'accounting',\s*\n\s*level: 'ERROR',/,
    'a document that will never post is an ERROR, not a WARNING attached to one that did')
})

test('the Xero poster refuses a stamped document before it reads or sends anything', async () => {
  const { readFileSync } = await import('node:fs')
  const src = withoutComments(readFileSync('lib/connectors/xero/sync-processor.ts', 'utf8'))

  const createCase = src.slice(src.indexOf("case 'SALES_INVOICE': {"), src.indexOf("case 'SALES_INVOICE_UPDATE': {"))
  const guard = createCase.indexOf('refuseUnreconciledDocument(payload)')
  const cancelledGuard = createCase.indexOf('guardCancelledSalesOrderInvoice(')
  const push = createCase.indexOf('pushSalesInvoice({')
  assert.ok(guard > 0, 'the create must consult the guard')
  assert.ok(guard < cancelledGuard && guard < push, 'it must run before any read and before the post')
  assert.match(createCase, /if \(!reconciled\.post\) return \{ success: false, error: reconciled\.reason \}/,
    'a refusal must return as an ordinary sync failure, so the row is visible with the reason on it')

  const updateCase = src.slice(src.indexOf("case 'SALES_INVOICE_UPDATE': {"), src.indexOf("case 'PURCHASE_INVOICE': {"))
  const updateGuard = updateCase.indexOf('refuseUnreconciledDocument(payload)')
  // `indexOf` returns -1 for ABSENT, and -1 is less than every real index — so "before the post"
  // must be asserted as PRESENT AND before, or deleting the guard passes.
  assert.ok(updateGuard > 0, 'the UPDATE must consult the guard — overwriting a good document with the stamped one is the same damage')
  assert.ok(updateGuard < updateCase.indexOf('updateSalesInvoice('), 'and before it posts')
})

test('the supplier credit-note poster is told whether a create was ever dispatched', async () => {
  const { readFileSync } = await import('node:fs')
  const src = withoutComments(readFileSync('lib/connectors/xero/sync-processor.ts', 'utf8'))
  const creditCase = src.slice(
    src.indexOf("case 'PURCHASE_CREDIT_NOTE': {"),
    src.indexOf("case 'PURCHASE_CREDIT_NOTE_ALLOCATION': {"),
  )
  const attempt = creditCase.indexOf('await isFirstPurchaseCreditNoteAttempt(entryId, referenceType, referenceId)')
  const push = creditCase.indexOf('pushPurchaseCreditNote({')
  assert.ok(attempt > 0 && attempt < push, 'the attempt must be established before the poster is called')
  assert.match(creditCase, /if \(!attempt\.ok\) return \{ success: false, error: attempt\.error \}/,
    'a count that cannot be read must refuse, never read as "first attempt"')
  assert.match(creditCase, /firstAttempt: attempt\.firstAttempt,/, 'and the answer must actually be passed')
})
