import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import type { BillData, CreditNoteData, InvoiceData } from '@/lib/connectors/types'

/**
 * unitdp=4 and TAX. The rounding adjustment is sized from the whole document Xero will hold, tax included, not from the line amounts:
 * a tax-exclusive 20% line of 1,000 x 0.333333 is 400.00 in IMS, but Xero holds 1,000 x 0.3333 = 333.30 plus tax 66.66 = 399.96, and an UNTAXED
 * line of the 0.03 line-amount gap leaves it at 399.99, a document a full payment cannot settle. The adjustment here is 0.04 (400.00 - 399.96).
 * Every figure below is checked against an independent re-statement of Xero's arithmetic, `xeroTotal`, not against the code under test.
 * Xero is never contacted: the transport, the stored tax-rate list and the settings are faked at the module boundary.
 */

const sent: Array<{ url: string; body: Record<string, unknown> }> = []
const ok = {
  ok: true, status: 200,
  data: { Invoices: [{ InvoiceID: 'inv-1', Status: 'AUTHORISED' }], CreditNotes: [{ CreditNoteID: 'cn-1', Status: 'AUTHORISED' }] },
}
const RATES: Record<string, number> = { OUTPUT2: 20, INPUT2: 20, ZERORATEDOUTPUT: 0, REDUCED5: 5, NONE: 0 }
const rateOf = (taxType: string): number | null => RATES[taxType] ?? null
let rateList: { ok: true; rateOf: typeof rateOf } | { ok: false; error: string } = { ok: true, rateOf }
let roundingAccount = '860'

mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP', resolveBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroGet: async () => ({ ok: true, status: 200, data: { CreditNotes: [] } }),
    xeroPost: async (path: string, body: Record<string, unknown>) => { sent.push({ url: path, body }); return ok },
    xeroPut: async (path: string, body: Record<string, unknown>) => { sent.push({ url: path, body }); return ok },
  },
})
mock.module('@/lib/connectors/xero/contacts', { namedExports: { findOrCreateContact: async () => ({ success: true, contactId: 'contact-1' }) } })
mock.module('@/lib/connectors/xero/items', { namedExports: { findOrCreateItem: async (code: string) => ({ success: true, itemId: `item-${code}`, isTracked: false }) } })
mock.module('@/lib/connectors/xero/settings', { namedExports: { getXeroSettings: async () => ({ xero_rounding_difference_account: roundingAccount }) } })
mock.module('@/lib/connectors/xero/tax-rate-lookup', { namedExports: { loadStoredXeroRateOf: async () => rateList } })

test.beforeEach(() => { sent.length = 0; rateList = { ok: true, rateOf }; roundingAccount = '860' })

type Wire = { Description?: string; Quantity: number; UnitAmount: number; AccountCode?: string; TaxType?: string; DiscountAmount?: number }

/** Xero's total, restated independently with plain integer pennies: line = round(q x unit x 100 - discount), tax = round(line x rate), per line. */
function xeroTotal(items: Wire[], inclusive: boolean): number {
  let pennies = 0
  for (const l of items) {
    const line = Math.round(l.Quantity * l.UnitAmount * 100 + 1e-7 * Math.sign(l.Quantity * l.UnitAmount)) - Math.round((l.DiscountAmount ?? 0) * 100)
    pennies += line
    if (!inclusive) pennies += Math.round(line * (RATES[l.TaxType ?? ''] ?? 0) / 100 + 1e-7 * Math.sign(line))
  }
  return pennies / 100
}

const line = (over: Partial<InvoiceData['lines'][number]> = {}) => ({ description: 'Widget', quantity: 1000, unitAmount: 0.333333, accountCode: '200', taxType: 'OUTPUT2', ...over })
const invoiceOf = (lines: InvoiceData['lines'], extra: Partial<InvoiceData> = {}) =>
  ({ invoiceNumber: 'INV-1', contactName: 'C', date: '2026-08-20', currency: 'GBP', lines, ...extra }) as InvoiceData
const billOf = (lines: BillData['lines']) => ({ invoiceNumber: 'B-1', contactName: 'S', date: '2026-08-20', currency: 'GBP', lines }) as BillData
const creditOf = (lines: CreditNoteData['lines'], extra: Partial<CreditNoteData> = {}) =>
  ({ creditNoteNumber: 'CN-1', contactName: 'C', date: '2026-08-20', currency: 'GBP', lines, ...extra }) as CreditNoteData

async function builders() {
  const { buildSalesInvoicePayload } = await import('@/lib/connectors/xero/invoices')
  const { buildPurchaseBillPayload } = await import('@/lib/connectors/xero/bills')
  const { buildXeroPurchaseCreditNote } = await import('@/lib/connectors/xero/credit-notes')
  return { buildSalesInvoicePayload, buildPurchaseBillPayload, buildXeroPurchaseCreditNote }
}

test('1,000 x 0.333333 at 20% exclusive: Xero would hold 399.96, the adjustment is 0.04 untaxed, and the predicted total is 400.00 (invoice, bill, credit note, supplier credit note)', async () => {
  const b = await builders()
  const { predictXeroDocumentTotal } = await import('@/lib/connectors/xero/write-path')
  const docs: Array<[string, Record<string, unknown>]> = [
    ['invoice', b.buildSalesInvoicePayload(invoiceOf([line()]), 'AUTHORISED', 'c1', new Set(), 'GBP', '860', rateOf)],
    ['bill', b.buildPurchaseBillPayload(billOf([line({ taxType: 'INPUT2' })]), 'AUTHORISED', 'c1', 'GBP', '860', rateOf)],
    ['supplier credit note', b.buildXeroPurchaseCreditNote(creditOf([line({ taxType: 'INPUT2' })]), 'AUTHORISED', 'c1', 'GBP', '860', rateOf)],
  ]
  for (const [name, doc] of docs) {
    const items = doc.LineItems as Wire[]
    assert.equal(items.length, 2, name)
    assert.equal(xeroTotal([items[0]!], false), 399.96, `${name}: what Xero holds without the adjustment`)
    assert.deepEqual(items[1], { Description: 'Rounding adjustment', Quantity: 1, UnitAmount: 0.04, AccountCode: '860', TaxType: 'NONE' }, name)
    assert.equal(xeroTotal(items, false), 400, `${name}: the document totals the order`)
    const predicted = predictXeroDocumentTotal(items.map((l) => ({ quantity: l.Quantity, unitAmount: l.UnitAmount, taxType: l.TaxType })), false, rateOf)
    assert.equal(predicted.ok && predicted.total.toFixed(2), '400.00', name)
  }
  // The sales credit note goes through its poster (it has no exported builder).
  const { pushCreditNote } = await import('@/lib/connectors/xero/credit-notes')
  assert.equal((await pushCreditNote(creditOf([line()]), 'AUTHORISED')).success, true)
  assert.equal(xeroTotal(sent[0]!.body.LineItems as Wire[], false), 400, 'sales credit note')
})

test('tax-INCLUSIVE 1,000 x 0.333333: the total is the sum of the line amounts, so the adjustment is the 0.03 line gap and the document totals 333.33', async () => {
  const b = await builders()
  const doc = b.buildSalesInvoicePayload(invoiceOf([line()], { lineAmountsIncludeTax: true }), 'AUTHORISED', 'c1', new Set(), 'GBP', '860', rateOf)
  const items = doc.LineItems as Wire[]
  assert.equal(doc.LineAmountTypes, 'Inclusive')
  assert.equal(items.length, 2)
  assert.deepEqual(items[1], { Description: 'Rounding adjustment', Quantity: 1, UnitAmount: 0.03, AccountCode: '860', TaxType: 'NONE' })
  assert.equal(xeroTotal(items, true), 333.33)
  // An inclusive document needs no tax rate: no stored list is consulted for it.
  const noRates = b.buildSalesInvoicePayload(invoiceOf([line()], { lineAmountsIncludeTax: true }), 'AUTHORISED', 'c1', new Set(), 'GBP', '860')
  assert.equal((noRates.LineItems as Wire[])[1]!.UnitAmount, 0.03)
  const credit = invoiceOf([line()], { lineAmountsIncludeTax: true })
  assert.equal(((await import('@/lib/connectors/xero/write-path')).planXeroRoundingLine({ lines: credit.lines, lineAmountsIncludeTax: true, account: '860', what: 'x' }) as Wire).UnitAmount, 0.03)
})

test('zero-rated 1,000 x 0.333333: no tax to carve, the adjustment is the 0.03 line gap and the total is 333.33', async () => {
  const b = await builders()
  const doc = b.buildSalesInvoicePayload(invoiceOf([line({ taxType: 'ZERORATEDOUTPUT' })]), 'AUTHORISED', 'c1', new Set(), 'GBP', '860', rateOf)
  const items = doc.LineItems as Wire[]
  assert.equal(items[1]!.UnitAmount, 0.03)
  assert.equal(items[1]!.TaxType, 'NONE')
  assert.equal(xeroTotal(items, false), 333.33)
})

test('a multi-line mix with shipping and an order discount: every document totals what IMS totals, and shipping/discount lines are untouched', async () => {
  const b = await builders()
  const lines = [
    line({ description: 'A', quantity: 1000, unitAmount: 0.333333 }),
    line({ description: 'B', quantity: 300, unitAmount: 1.234567, taxType: 'REDUCED5' }),
    line({ description: 'C', quantity: 7, unitAmount: 9.990001, taxType: 'ZERORATEDOUTPUT' }),
    line({ description: 'D', quantity: 3, unitAmount: 33.3333, discountAmount: 1.1 }),
  ]
  const data = invoiceOf(lines, { shippingAmount: 4.5, shippingAccountCode: '300', shippingTaxType: 'OUTPUT2', discountAmount: 2.25, discountAccountCode: '310', discountTaxType: 'OUTPUT2' })
  const doc = b.buildSalesInvoicePayload(data, 'AUTHORISED', 'c1', new Set(), 'GBP', '860', rateOf)
  const items = doc.LineItems as Wire[]
  assert.equal(items.length, 7, '4 lines + shipping + discount + rounding')
  assert.equal(items[4]!.UnitAmount, 4.5)
  assert.equal(items[5]!.UnitAmount, -2.25)
  assert.equal(items[6]!.Description, 'Rounding adjustment')
  // IMS: each line at its full-precision price, per-line rounded amounts and tax, the same shipping and discount.
  const imsItems: Wire[] = [
    { Quantity: 1000, UnitAmount: 0.333333, TaxType: 'OUTPUT2' }, { Quantity: 300, UnitAmount: 1.234567, TaxType: 'REDUCED5' },
    { Quantity: 7, UnitAmount: 9.990001, TaxType: 'ZERORATEDOUTPUT' }, { Quantity: 3, UnitAmount: 33.3333, TaxType: 'OUTPUT2', DiscountAmount: 1.1 },
    { Quantity: 1, UnitAmount: 4.5, TaxType: 'OUTPUT2' }, { Quantity: 1, UnitAmount: -2.25, TaxType: 'OUTPUT2' },
  ]
  assert.equal(xeroTotal(items, false), xeroTotal(imsItems, false))
  // The same document built with the adjustment dropped is what Xero would NOT settle.
  assert.notEqual(xeroTotal(items.slice(0, 6), false), xeroTotal(imsItems, false))
})

test('a document no adjustment can reconcile is refused: an unknown tax rate, no stored list, a total that stays wrong after the adjustment', async () => {
  const b = await builders()
  const { planXeroRoundingLine, XeroRoundingUnreconcilableError } = await import('@/lib/connectors/xero/write-path')
  // 1. A tax type the stored list does not carry (or that has several components): Xero's tax cannot be predicted.
  assert.throws(() => b.buildSalesInvoicePayload(invoiceOf([line({ taxType: 'MYSTERY' })]), 'AUTHORISED', 'c1', new Set(), 'GBP', '860', rateOf), XeroRoundingUnreconcilableError)
  assert.throws(() => b.buildSalesInvoicePayload(invoiceOf([line()]), 'AUTHORISED', 'c1', new Set(), 'GBP', '860'), /tax rate of tax type OUTPUT2 is not known/)
  // 2. After the adjustment the prediction is made again and must equal the IMS total: a model that disagrees with itself is refused.
  let calls = 0
  const drifting = (taxType: string) => (++calls <= 3 ? rateOf(taxType) : 25)
  assert.throws(
    () => planXeroRoundingLine({ lines: [{ quantity: 1000, unitAmount: 0.333333, taxType: 'OUTPUT2' }], lineAmountsIncludeTax: false, rateOf: drifting, account: '860', what: 'Sales invoice X' }),
    /would still total it .* against the order's 400\.00/,
  )
  // The pure predictor also refuses an unknown rate instead of guessing.
  const { predictXeroDocumentTotal } = await import('@/lib/connectors/xero/write-path')
  assert.equal(predictXeroDocumentTotal([{ quantity: 1, unitAmount: 1, taxType: 'MYSTERY' }], false, rateOf).ok, false)
  assert.equal(predictXeroDocumentTotal([{ quantity: 1, unitAmount: 1, taxType: 'MYSTERY' }], true, rateOf).ok, true, 'inclusive needs no rate')

  // The posters refuse BEFORE a contact, an item or a request: nothing is sent.
  const { pushSalesInvoice } = await import('@/lib/connectors/xero/invoices')
  const { pushPurchaseBill } = await import('@/lib/connectors/xero/bills')
  const { pushCreditNote } = await import('@/lib/connectors/xero/credit-notes')
  const unknown = await pushSalesInvoice(invoiceOf([line({ taxType: 'MYSTERY' })]), 'AUTHORISED')
  assert.equal(unknown.success, false)
  assert.match(String(unknown.error), /Sales invoice INV-1 cannot be posted: the tax rate of tax type MYSTERY is not known.*Nothing was sent/)
  rateList = { ok: false, error: 'the stored Xero tax-rate list cannot be relied on (XERO_LIST_STALE: too old), so the tax Xero will compute cannot be predicted.' }
  for (const result of [
    await pushSalesInvoice(invoiceOf([line()]), 'AUTHORISED'),
    await pushPurchaseBill(billOf([line({ taxType: 'INPUT2' })]), 'AUTHORISED'),
    await pushCreditNote(creditOf([line()]), 'AUTHORISED'),
  ]) {
    assert.equal(result.success, false)
    assert.match(String(result.error), /XERO_LIST_STALE.*Nothing was sent/)
  }
  assert.equal(sent.length, 0, 'nothing was sent')
  // With no gap (prices Xero keeps exactly) the list is not even read, so a stale list never blocks an ordinary document.
  assert.equal((await pushSalesInvoice(invoiceOf([line({ quantity: 3, unitAmount: 33.3333 })]), 'AUTHORISED')).success, true)
})

test('the poster sends the reconciled document: invoice with 6dp prices posts line, rounding line on 860 and totals the order', async () => {
  const { pushSalesInvoice } = await import('@/lib/connectors/xero/invoices')
  assert.equal((await pushSalesInvoice(invoiceOf([line()]), 'AUTHORISED')).success, true)
  const items = sent[0]!.body.LineItems as Wire[]
  assert.equal(xeroTotal(items, false), 400)
  roundingAccount = ''
  sent.length = 0
  const refused = await pushSalesInvoice(invoiceOf([line()]), 'AUTHORISED')
  assert.equal(refused.success, false)
  assert.match(String(refused.error), /rounding adjustment of 0\.04.*Map a Rounding account/)
  assert.equal(sent.length, 0)
})

// ---- offsetting line gaps: a zero SUM of the gaps must not skip the prediction ---------------------------------------------------------

const lineA = () => line({ description: 'A', quantity: 1000, unitAmount: 0.333333 }) // 333.33 -> Xero 333.30: +0.03
const lineB = (taxType: string) => line({ description: 'B', quantity: 1000, unitAmount: 0.333267, taxType }) // 333.27 -> Xero 333.30: -0.03

test('offsetting gaps at DIFFERENT rates (+0.03 at 20%, -0.03 at 0%): the prediction still runs, the adjustment is 0.01 and the document totals 733.27 (builder and preflight)', async () => {
  const b = await builders()
  const { unitDpLineGap, unitDpChangesAnyLine } = await import('@/lib/connectors/xero/write-path')
  const lines = [lineA(), lineB('ZERORATEDOUTPUT')]
  assert.equal(unitDpLineGap(lines).toNumber(), 0, 'the summed gap is zero')
  assert.equal(unitDpChangesAnyLine(lines), true, 'but 4dp changes a line')
  const items = b.buildSalesInvoicePayload(invoiceOf(lines), 'AUTHORISED', 'c1', new Set(), 'GBP', '860', rateOf).LineItems as Wire[]
  assert.equal(items.length, 3)
  assert.deepEqual(items[2], { Description: 'Rounding adjustment', Quantity: 1, UnitAmount: 0.01, AccountCode: '860', TaxType: 'NONE' })
  assert.equal(xeroTotal(items.slice(0, 2), false), 733.26, 'Xero without the adjustment')
  assert.equal(xeroTotal(items, false), 733.27)
  // Without a rate for the 20% line the builder cannot skip: it refuses rather than posting 733.26.
  assert.throws(() => b.buildSalesInvoicePayload(invoiceOf(lines), 'AUTHORISED', 'c1', new Set(), 'GBP', '860'), /not known/)
  // The preflight (the poster) does the same, before anything is sent.
  const { pushSalesInvoice } = await import('@/lib/connectors/xero/invoices')
  assert.equal((await pushSalesInvoice(invoiceOf(lines), 'AUTHORISED')).success, true)
  assert.equal(xeroTotal(sent[0]!.body.LineItems as Wire[], false), 733.27)
  sent.length = 0
  rateList = { ok: false, error: 'the stored Xero tax-rate list cannot be relied on (XERO_LIST_STALE: too old), so the tax Xero will compute cannot be predicted.' }
  const refused = await pushSalesInvoice(invoiceOf(lines), 'AUTHORISED')
  assert.equal(refused.success, false, 'the preflight ran although the summed gap is zero')
  assert.match(String(refused.error), /XERO_LIST_STALE.*Nothing was sent/)
  assert.equal(sent.length, 0)
  roundingAccount = ''
  rateList = { ok: true, rateOf }
  const noAccount = await pushSalesInvoice(invoiceOf(lines), 'AUTHORISED')
  assert.equal(noAccount.success, false)
  assert.match(String(noAccount.error), /rounding adjustment of 0\.01.*Map a Rounding account/)
})

test('offsetting gaps at the SAME rate: tax cancels too, the prediction runs (the list is read), no adjustment line is added and it posts', async () => {
  const b = await builders()
  const lines = [lineA(), lineB('OUTPUT2')]
  let asked = 0
  const spy = (t: string) => { asked++; return rateOf(t) }
  const items = b.buildSalesInvoicePayload(invoiceOf(lines), 'AUTHORISED', 'c1', new Set(), 'GBP', '860', spy).LineItems as Wire[]
  assert.ok(asked > 0, 'the prediction ran')
  assert.equal(items.length, 2, 'no rounding line')
  assert.equal(xeroTotal(items, false), 799.92)
  assert.equal(xeroTotal([{ Quantity: 1000, UnitAmount: 0.333333, TaxType: 'OUTPUT2' }, { Quantity: 1000, UnitAmount: 0.333267, TaxType: 'OUTPUT2' }], false), 799.92, 'IMS total is the same')
  // Needs no Rounding account, because no adjustment is needed.
  roundingAccount = ''
  const { pushSalesInvoice } = await import('@/lib/connectors/xero/invoices')
  assert.equal((await pushSalesInvoice(invoiceOf(lines), 'AUTHORISED')).success, true)
  assert.equal((sent[0]!.body.LineItems as Wire[]).length, 2)
})

// ---- the EU VAT shadow report --------------------------------------------------------------------------------------------------------

test('the shadow comparator names the appended rounding line (kind rounding), and the built invoice compares equal to a Xero invoice that carries it', async () => {
  const { buildSalesInvoicePayload } = await import('@/lib/connectors/xero/invoices')
  const { comparableFromBuiltPayload, compareComparableInvoices } = await import('@/lib/domain/accounting/eu-vat-shadow-compare')
  const data = invoiceOf([line()], { shippingAmount: 4.5, shippingAccountCode: '300', shippingTaxType: 'OUTPUT2' })
  const built = buildSalesInvoicePayload(data, 'DRAFT', 'shadow-contact', new Set(), 'GBP', '860', rateOf)
  const mine = comparableFromBuiltPayload(built, data.lines, rateOf, 'GBP')
  assert.ok(mine.ok)
  assert.deepEqual(mine.invoice.lines.map((l) => l.kind), ['goods', 'shipping', 'rounding'])
  assert.equal(mine.invoice.lines[2]!.taxType, 'NONE')
  assert.equal(mine.invoice.lines[2]!.lineAmount, '0.04')
  assert.equal(mine.invoice.total, '405.40', 'the comparator totals the document with the adjustment, as Xero does')
  // The invoice as Xero holds it once posted with the same builder.
  const xeroLines = (built.LineItems as Wire[]).map((l) => {
    const amount = Math.round(l.Quantity * l.UnitAmount * 100) / 100
    return { LineAmount: amount, TaxAmount: Math.round(amount * (RATES[l.TaxType ?? ''] ?? 0)) / 100, AccountCode: l.AccountCode, TaxType: l.TaxType }
  })
  const { comparableFromXeroInvoice } = await import('@/lib/domain/accounting/eu-vat-shadow-compare')
  const theirs = comparableFromXeroInvoice({ CurrencyCode: 'GBP', Status: 'AUTHORISED', LineAmountTypes: 'Exclusive', LineItems: xeroLines, Total: 405.4 })
  assert.ok(theirs.ok)
  assert.equal(compareComparableInvoices(mine.invoice, theirs.invoice).verdict, 'match')
})

test('the live shadow port builds an invoice that needs a rounding line instead of failing as builder_failed', async () => {
  const wcOrder = { id: 1 }
  const payload = { ...invoiceOf([line()]), currencyRateToBase: undefined }
  mock.module('@/lib/db', {
    namedExports: {
      db: {
        setting: { findUnique: async ({ where }: { where: { key: string } }) => (where.key === 'xero_rounding_difference_account' ? (roundingAccount ? { value: roundingAccount } : null) : null) },
        accountingToken: { findUnique: async () => ({ tenantId: 't1' }) },
      },
    },
  })
  mock.module('@/lib/tax/purchase-tax-import', {
    namedExports: { readStoredXeroList: async () => ({ ok: true, list: { tenantId: 't1', fetchedAt: new Date(), rows: [{ taxType: 'OUTPUT2', effectiveRate: '20.000000', components: [] }, { taxType: 'NONE', effectiveRate: '0.000000', components: [] }] } }) },
  })
  mock.module('@/lib/connectors/woocommerce/sync/order-import', {
    namedExports: { buildShadowWcSalesInvoice: async () => ({ kind: 'built', payload, warnings: [], stampSource: 'none' }) },
  })
  mock.module('@/lib/connectors/woocommerce/sync/invoice-number', { namedExports: { resolveWcAccountingInvoiceNumber: () => ({ ok: false }) } })
  mock.module('@/lib/tax/eu-vat-shadow-http', { namedExports: { readShadowWcCredentials: async () => ({ ok: false, code: 'x' }), readShadowXeroGrant: async () => ({ ok: false, code: 'x' }), wcReadOnlyGetOrder: async () => ({ ok: false, code: 'x' }), xeroReadOnlyGet: async () => ({ ok: false, code: 'x' }) } })
  const { createLiveShadowPorts } = await import('@/lib/tax/eu-vat-shadow-live')
  const ports = await createLiveShadowPorts(new Date())
  const ref = { orderId: 'o1', externalOrderId: '1', orderNumber: '1' }
  const built = await ports.buildIms(ref, { destination: 'GB', invoiceNumber: 'INV-1', order: wcOrder } as never)
  assert.equal(built.kind, 'built', JSON.stringify(built))
  if (built.kind !== 'built') return
  assert.deepEqual(built.invoice.lines.map((l) => l.kind), ['goods', 'rounding'])
  assert.equal(built.invoice.total, '400.00')
  // With no Rounding account mapped the real poster would refuse; the shadow builder reports the same (a closed code, never a sentence).
  roundingAccount = ''
  const ports2 = await createLiveShadowPorts(new Date())
  const refused = await ports2.buildIms(ref, { destination: 'GB', invoiceNumber: 'INV-1', order: wcOrder } as never)
  assert.deepEqual(refused, { kind: 'refused', code: 'builder_failed' })
})
