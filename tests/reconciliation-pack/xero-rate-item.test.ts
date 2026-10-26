import assert from 'node:assert/strict'
import test from 'node:test'

import { R16_XERO_REQUEST_BUDGET } from '../../lib/reconciliation-pack/constants.ts'
import { buildRateRows, runXeroRateCheck, runXeroRateItem, summariseRateCheck } from '../../lib/reconciliation-pack/xero-rate-item.ts'
import type { XeroRateDocument } from '../../lib/reconciliation-pack/xero-rate-source.ts'
import { ASOF, FX_ROWS, binding, context, creditNoteRow, invoiceRow, noSleep, paymentRow, postedRow, uuid, type XeroTweak } from './xero-rate-fixtures.ts'

/**
 * R16, THE XERO RATE CHECK: what the item concludes from a fake Xero and a fake IMS read. Mutations are listed in the PR.
 * 1 GBP = 1.25 EUR, so Xero's CurrencyRate for a euro document dated 2026-09-10 or later (within the table) must be 0.8.
 */

const SEP = '2026-09-10'
const eur = (n: number, rate: number | string | null, date = SEP, over: Partial<Parameters<typeof invoiceRow>[0]> = {}) => invoiceRow({ n, date, currency: 'EUR', rate, ...over })
const keyOf = (kind: string, n: number) => `xero-rate|${kind}|${uuid(n)}`
type Entry = { key: string; ims: string | null; vendor: string | null }
const entries = (item: Awaited<ReturnType<typeof runXeroRateItem>>, bucket: string): Entry[] => ((item.entries ?? {}) as Record<string, Entry[]>)[bucket] ?? []

// [mutation: the rate not rounded / rounded at another place / tolerance loosened]
test('an equal rate passes: the euro invoice at 0.8 against 1 GBP = 1.25 EUR, with the proof of a comparison and exactly the catalogue sources', async () => {
  const { ctx, xero } = context({ invoices: [eur(1, 0.8)] })
  const item = await runXeroRateItem('R16', ctx)
  assert.equal(item.outcome, 'pass')
  assert.deepEqual(item.reasons, [])
  assert.deepEqual(item.proof, { kind: 'compared' })
  assert.deepEqual([...(item.sources ?? [])].sort(), ['ims-database', 'xero-api'])
  assert.deepEqual(entries(item, 'bothEqual').map((e) => [e.key, e.ims, e.vendor]), [[keyOf('sales-invoice', 1), '0.8', '0.8']])
  // One organisation read, and each of the three lists read twice: all GET-shaped reads to the four allowed resources.
  assert.deepEqual(xero.calls.map((c) => c.resource), ['Organisation', 'Invoices', 'Invoices', 'CreditNotes', 'CreditNotes', 'Payments', 'Payments'])
})

// [mutation: Xero's rate rounded half down / truncated / not rounded; the IMS rate not converted]
test('SIX DECIMAL PLACES: a Xero rate within half a millionth of the IMS rate is equal (rounded half up), one beyond it differs', async () => {
  const cases: Array<[string, number, 'pass' | 'fail']> = [
    ['0.8000004 rounds to 0.800000', 0.8000004, 'pass'],
    ['0.8000005 rounds up to 0.800001', 0.8000005, 'fail'],
    ['0.7999995 rounds up to 0.800000', 0.7999995, 'pass'],
    ['0.79999949 rounds to 0.799999', 0.79999949, 'fail'],
    ['0.800001 is one millionth away', 0.800001, 'fail'],
    ['0.799999 is one millionth away', 0.799999, 'fail'],
    ['twelve places of the same rate', 0.800000000001, 'pass'],
  ]
  for (const [name, rate, expected] of cases) {
    const { ctx } = context({ invoices: [eur(1, rate)] })
    assert.equal((await runXeroRateItem('R16', ctx)).outcome, expected, name)
  }
})

test('THE IMS RATE IS CONVERTED to Xero\'s convention and rounded to six places by the connector\'s own function: 1.3 is 0.769231 and 3 is 0.333333', async () => {
  const rows = [{ currency: 'USD', rate: '1.3', fetchedAt: '2026-09-01T00:00:00.000Z', manualOverride: false }, { currency: 'SEK', rate: '3', fetchedAt: '2026-09-01T00:00:00.000Z', manualOverride: false }]
  const good = context({ invoices: [invoiceRow({ n: 1, date: SEP, currency: 'USD', rate: 0.769231 }), invoiceRow({ n: 2, date: SEP, currency: 'SEK', rate: 0.333333 })] }, { ims: { rows } })
  const item = await runXeroRateItem('R16', good.ctx)
  assert.equal(item.outcome, 'pass')
  assert.deepEqual(entries(item, 'bothEqual').map((e) => e.ims), ['0.769231', '0.333333'])
  // The unrounded reciprocal (0.76923077...) written to Xero is not what IMS sends: the six-place figure is.
  const bad = context({ invoices: [invoiceRow({ n: 1, date: SEP, currency: 'USD', rate: 0.769232 })] }, { ims: { rows } })
  assert.equal((await runXeroRateItem('R16', bad.ctx)).outcome, 'fail')
})

// [mutation: the pair judged equal whatever the values / XERO_RATE_DIFFERS dropped]
test('a differing rate is a finding with XERO_RATE_DIFFERS: both rates are listed, the item fails', async () => {
  const { ctx } = context({ invoices: [eur(1, 0.8), eur(2, 0.81)] })
  const item = await runXeroRateItem('R16', ctx)
  assert.equal(item.outcome, 'fail')
  assert.deepEqual([...item.reasons].sort(), ['DIFFERENCES', 'XERO_RATE_DIFFERS'])
  assert.deepEqual(entries(item, 'bothDiffer').map((e) => [e.key, e.ims, e.vendor]), [[keyOf('sales-invoice', 2), '0.8', '0.81']])
  assert.equal(entries(item, 'bothEqual').length, 1)
  assert.equal(item.proof, null)
})

// [mutation: a missing IMS rate treated as equal / defaulted to 1 / the lookup's reason left out]
test('a missing IMS rate is IMS_RATE_MISSING with the lookup\'s own reason in the identity, listed under the Xero rate', async () => {
  const rows = [
    ...FX_ROWS,
    { currency: 'CHF', rate: '0', fetchedAt: '2026-09-01T00:00:00.000Z', manualOverride: false },
    { currency: 'NOK', rate: '10', fetchedAt: '2026-09-01T00:00:00.000Z', manualOverride: false },
    { currency: 'NOK', rate: '11', fetchedAt: '2026-09-01T00:00:00.000Z', manualOverride: false },
    { currency: 'IDR', rate: '10000000', fetchedAt: '2026-09-01T00:00:00.000Z', manualOverride: false }, // positive, but its reciprocal rounds to nothing at six places
  ]
  const { ctx } = context({
    invoices: [
      eur(1, 0.8, '2026-09-09'), // the EUR row was fetched on the 10th: nothing on or before the 9th
      invoiceRow({ n: 2, date: SEP, currency: 'JPY', rate: 0.005 }), // no row for the currency at all
      invoiceRow({ n: 3, date: SEP, currency: 'CHF', rate: 1.1 }), // a stored rate that is not positive
      invoiceRow({ n: 4, date: SEP, currency: 'NOK', rate: 0.1 }), // two rows at one instant that disagree
      eur(5, 0.8),
      invoiceRow({ n: 6, date: SEP, currency: 'IDR', rate: 0.000001 }),
    ],
  }, { ims: { rows } })
  const item = await runXeroRateItem('R16', ctx)
  assert.equal(item.outcome, 'fail')
  assert.deepEqual([...item.reasons].sort(), ['DIFFERENCES', 'IMS_RATE_MISSING'])
  assert.deepEqual(entries(item, 'onlyVendor').map((e) => [e.key, e.ims, e.vendor]), [
    [`${keyOf('sales-invoice', 1)}|ims-rate-missing|no-rate`, null, '0.8'],
    [`${keyOf('sales-invoice', 2)}|ims-rate-missing|no-rate`, null, '0.005'],
    [`${keyOf('sales-invoice', 3)}|ims-rate-missing|non-positive-rate`, null, '1.1'],
    [`${keyOf('sales-invoice', 4)}|ims-rate-missing|ambiguous-rate`, null, '0.1'],
    [`${keyOf('sales-invoice', 6)}|ims-rate-missing|non-positive-rate`, null, '0.000001'],
  ])
  assert.equal(entries(item, 'onlyIms').length, 0)
  assert.equal(entries(item, 'bothEqual').length, 1)
})

// [mutation: the date rule changed to the start of the day / the next day]
test('THE DOCUMENT DATE IS THE END OF THAT DAY (UTC): a rate fetched during the day is the day\'s rate, one fetched at the next midnight is not', async () => {
  const rows = (fetchedAt: string) => [{ currency: 'EUR', rate: '1.25', fetchedAt, manualOverride: false }]
  const at = async (fetchedAt: string) => runXeroRateItem('R16', context({ invoices: [eur(1, 0.8, SEP)] }, { ims: { rows: rows(fetchedAt) } }).ctx)
  assert.equal((await at('2026-09-10T23:59:59.999Z')).outcome, 'pass', 'the last millisecond of the day counts')
  assert.equal((await at('2026-09-10T00:00:00.000Z')).outcome, 'pass', 'the first millisecond of the day counts')
  assert.deepEqual((await at('2026-09-11T00:00:00.000Z')).reasons, ['DIFFERENCES', 'IMS_RATE_MISSING'], 'the next midnight does not')
  // The latest row on or before that instant wins over an older one.
  const two = context({ invoices: [eur(1, 0.8, SEP)] }, { ims: { rows: [{ currency: 'EUR', rate: '1.5', fetchedAt: '2026-09-01T00:00:00.000Z', manualOverride: false }, ...rows('2026-09-10T12:00:00.000Z')] } })
  assert.equal((await runXeroRateItem('R16', two.ctx)).outcome, 'pass')
})

// [mutation: base-currency documents judged / the base-currency skip dropped]
test('BASE-CURRENCY DOCUMENTS ARE OUT OF SCOPE: whatever rate a GBP document carries, it is neither compared nor listed; all-GBP passes only on the named empty proof', async () => {
  const { ctx } = context({
    invoices: [invoiceRow({ n: 1, date: SEP, currency: 'GBP', rate: 1 }), invoiceRow({ n: 2, date: SEP, currency: 'GBP', rate: 7 }), invoiceRow({ n: 3, date: SEP, currency: 'GBP', rate: null })],
    creditNotes: [creditNoteRow({ n: 4, date: SEP, currency: 'GBP', rate: 1 })],
    payments: [paymentRow({ n: 5, date: SEP, currency: 'GBP', rate: 1 })],
  })
  const item = await runXeroRateItem('R16', ctx)
  assert.equal(item.outcome, 'pass')
  assert.deepEqual(item.proof, { kind: 'proven-empty', source: 'no-foreign-currency-documents' })
  for (const bucket of ['bothEqual', 'bothDiffer', 'onlyVendor', 'onlyIms']) assert.equal(entries(item, bucket).length, 0, bucket)
  const run = await runXeroRateCheck(ctx)
  assert.equal(run.summary?.baseCurrency, 5)
  assert.equal(run.summary?.compared, 0)
  // Mixed with a foreign document, the foreign one is judged and the GBP ones still are not.
  const mixed = await runXeroRateItem('R16', context({ invoices: [invoiceRow({ n: 1, date: SEP, currency: 'GBP', rate: 7 }), eur(2, 0.8)] }).ctx)
  assert.equal(mixed.outcome, 'pass')
  assert.deepEqual(entries(mixed, 'bothEqual').map((e) => e.key), [keyOf('sales-invoice', 2)])
})

// [mutation: a partial or unproven list accepted / the double scan dropped / a failed resource ignored]
test('A XERO READ THAT IS INCOMPLETE OR UNPROVEN IS INCONCLUSIVE, NEVER A PASS, whichever of the three lists it is, and nothing is listed', async () => {
  const lists = { invoices: [eur(1, 0.8), eur(2, 0.8), eur(3, 0.8)], creditNotes: [creditNoteRow({ n: 4, date: SEP, currency: 'EUR', rate: 0.8 })], payments: [paymentRow({ n: 5, date: SEP, currency: 'EUR', rate: 0.8 })] }
  const onResource = (resource: string, change: (body: Record<string, unknown>, call: number) => unknown, only?: number): XeroTweak => (call, n, page) => (call.resource === resource && (only === undefined || n === only) ? { ...page, body: change(page.body as Record<string, unknown>, n) } as typeof page : undefined)
  const cases: Array<[string, XeroTweak, string]> = [
    ['invoices: no pagination object', onResource('Invoices', (b) => ({ Invoices: b.Invoices })), 'SOURCE_UNREADABLE'],
    ['credit notes: no pagination object', onResource('CreditNotes', (b) => ({ CreditNotes: b.CreditNotes })), 'SOURCE_UNREADABLE'],
    ['payments: no pagination object', onResource('Payments', (b) => ({ Payments: b.Payments })), 'SOURCE_UNREADABLE'],
    ['payments: the list is missing', onResource('Payments', (b) => ({ pagination: b.pagination })), 'SOURCE_UNREADABLE'],
    ['invoices: page count wrong', onResource('Invoices', (b) => ({ ...b, pagination: { ...(b.pagination as object), pageCount: 3 } })), 'VENDOR_READ_UNSTABLE'],
    ['invoices: a short page', onResource('Invoices', (b) => ({ ...b, Invoices: (b.Invoices as unknown[]).slice(1) })), 'VENDOR_READ_UNSTABLE'],
    ['credit notes: the item count does not match the rows', onResource('CreditNotes', (b) => ({ ...b, pagination: { ...(b.pagination as object), itemCount: 2, pageCount: 1 } })), 'VENDOR_READ_UNSTABLE'],
    ['payments: the second scan differs (a rate changed between scans)', (call, n, page) => (call.resource === 'Payments' && n === 7 ? { ...page, body: { ...(page.body as object), Payments: [paymentRow({ n: 5, date: SEP, currency: 'EUR', rate: 0.81 })] } } as typeof page : undefined), 'VENDOR_READ_UNSTABLE'],
    ['a non-200 answer', (call, _n, page) => (call.resource === 'Payments' ? { ok: true, status: 503, body: page.body } : undefined), 'SOURCE_UNREADABLE'],
    ['a failed request', (call) => (call.resource === 'CreditNotes' ? { ok: false } : undefined), 'SOURCE_UNREADABLE'],
    ['a row outside the window that was asked for', onResource('Invoices', (b) => ({ ...b, Invoices: [eur(1, 0.8, '2026-12-25'), ...(b.Invoices as unknown[]).slice(1)] })), 'SOURCE_UNREADABLE'],
    ['a row of the wrong type', onResource('Invoices', (b) => ({ ...b, Invoices: [{ ...(b.Invoices as Array<Record<string, unknown>>)[0], Type: 'ACCRECCREDIT' }, ...(b.Invoices as unknown[]).slice(1)] })), 'SOURCE_UNREADABLE'],
    ['an invoice in a status this code does not know', onResource('Invoices', (b) => ({ ...b, Invoices: [{ ...(b.Invoices as Array<Record<string, unknown>>)[0], Status: 'ARCHIVED' }, ...(b.Invoices as unknown[]).slice(1)] })), 'SOURCE_UNREADABLE'],
    ['a credit note in a status this code does not know', onResource('CreditNotes', (b) => ({ ...b, CreditNotes: [{ ...(b.CreditNotes as Array<Record<string, unknown>>)[0], Status: 'ARCHIVED' }, ...(b.CreditNotes as unknown[]).slice(1)] })), 'SOURCE_UNREADABLE'],
    ['an invoice with no status', onResource('Invoices', (b) => ({ ...b, Invoices: [{ ...(b.Invoices as Array<Record<string, unknown>>)[0], Status: undefined }, ...(b.Invoices as unknown[]).slice(1)] })), 'SOURCE_UNREADABLE'],
    ['an identity that is not an identifier', onResource('Payments', (b) => ({ ...b, Payments: [{ ...(b.Payments as Array<Record<string, unknown>>)[0], PaymentID: 'not-an-id' }] })), 'SOURCE_UNREADABLE'],
  ]
  for (const [name, tweak, reason] of cases) {
    const { ctx } = context(lists, { double: { tweak } })
    const item = await runXeroRateItem('R16', ctx)
    assert.deepEqual([item.outcome, item.reasons], ['inconclusive', [reason]], name)
    assert.equal(item.entries, undefined, `${name}: nothing is listed`)
    assert.equal(item.proof ?? null, null, name)
  }
  // The budget is a cap, never a shorter list.
  const capped = context(lists, { context: { xeroOptions: { sleep: noSleep, budget: 4 } } })
  assert.deepEqual((await runXeroRateItem('R16', capped.ctx)).reasons, ['CAP_EXCEEDED'])
  assert.ok(R16_XERO_REQUEST_BUDGET > 40, 'three double-scanned lists need more than the R12 budget')
  const big = context({ invoices: Array.from({ length: 9 }, (_, i) => eur(i + 1, 0.8)) }, { double: { pageSize: 2 }, context: { xeroOptions: { sleep: noSleep, maxRows: 5 } } })
  assert.deepEqual((await runXeroRateItem('R16', big.ctx)).reasons, ['CAP_EXCEEDED'])
})

// [mutation: the three resources collapsed into one / the payment currency read from the wrong place / a deleted payment judged]
test('PAYMENTS AND DOCUMENTS: invoices, bills, credit notes and payments are each judged on their own rate and each filed under its own kind', async () => {
  const { ctx } = context({
    invoices: [eur(1, 0.8), eur(2, 0.9, SEP, { type: 'ACCPAY' })],
    creditNotes: [creditNoteRow({ n: 3, date: SEP, currency: 'EUR', rate: 0.8 }), creditNoteRow({ n: 4, date: SEP, currency: 'EUR', rate: 0.7, type: 'ACCPAYCREDIT' })],
    payments: [
      paymentRow({ n: 5, date: SEP, currency: 'EUR', rate: 0.8 }),
      paymentRow({ n: 6, date: SEP, currency: 'EUR', rate: 0.79 }),
      paymentRow({ n: 7, date: SEP, currency: 'GBP', rate: 1 }), // a payment of a sterling invoice: out of scope
      paymentRow({ n: 8, date: SEP, currency: 'EUR', rate: 0.5, status: 'DELETED' }), // deleted: books nothing
      paymentRow({ n: 9, date: SEP, currency: 'USD', rate: 0.769231, holder: 'CreditNote' }),
    ],
  })
  const run = await runXeroRateCheck(ctx)
  const item = run.item
  assert.equal(item.outcome, 'fail')
  assert.deepEqual([...item.reasons].sort(), ['DIFFERENCES', 'XERO_RATE_DIFFERS'])
  assert.deepEqual(entries(item, 'bothEqual').map((e) => e.key).sort(), [keyOf('payment', 5), keyOf('payment', 9), keyOf('sales-cn', 3), keyOf('sales-invoice', 1)].sort())
  assert.deepEqual(entries(item, 'bothDiffer').map((e) => [e.key, e.ims, e.vendor]).sort(), [
    [keyOf('payment', 6), '0.8', '0.79'],
    [keyOf('purchase-bill', 2), '0.8', '0.9'],
    [keyOf('purchase-cn', 4), '0.8', '0.7'],
  ].sort())
  assert.deepEqual(run.summary, { periods: ['2026-08', '2026-09'], read: { invoices: 2, creditNotes: 2, payments: 5 }, deletedPayments: 1, setAsideDocuments: 0, outsidePeriod: 0, baseCurrency: 1, compared: 7, equal: 4, xeroRateDiffers: 3, imsRateMissing: 0, documentUnreadable: 0, imsPosted: 0, postedRateNotTableRate: 0, postingUnreadable: 0, postedTableNotChecked: 0 })
  // A payment is judged on its own rate, not on its invoice's: the same euro invoice at 0.8 does not rescue a payment at 0.79 (asserted above), and a payment
  // that names no document has no currency to judge.
  const orphan = await runXeroRateItem('R16', context({ payments: [paymentRow({ n: 1, date: SEP, currency: 'EUR', rate: 0.8, holder: 'none' })] }).ctx)
  assert.deepEqual([orphan.outcome, orphan.reasons], ['fail', ['DIFFERENCES', 'DOCUMENT_UNREADABLE']])
})

// [mutation: DOCUMENT_UNREADABLE dropped / a missing rate read as 1 / a rate that rounds to zero accepted]
test('A DOCUMENT THAT CANNOT BE JUDGED is DOCUMENT_UNREADABLE (listed with the value 0), never a pass and never a rate of 1', async () => {
  const lists = {
    invoices: [
      eur(1, null), // a foreign document with no CurrencyRate
      eur(2, 0), // a rate of zero
      eur(3, -0.8), // a negative rate
      invoiceRow({ n: 4, date: SEP, currency: 'ZZZ', rate: 0.8 }), // a currency that is not one
      eur(5, 0.8, SEP, { over: { DateString: 'tomorrow' } }), // a date that cannot be read
      eur(6, 0.0000004), // a rate that rounds to nothing at six places
      eur(7, 0.8),
    ],
  }
  const { ctx } = context(lists)
  const item = await runXeroRateItem('R16', ctx)
  assert.equal(item.outcome, 'fail')
  assert.deepEqual([...item.reasons].sort(), ['DIFFERENCES', 'DOCUMENT_UNREADABLE'])
  assert.deepEqual(entries(item, 'onlyVendor').map((e) => [e.key, e.ims, e.vendor]), [1, 2, 3, 4, 5, 6].map((n) => [`${keyOf('sales-invoice', n)}|document-unreadable`, null, '0']))
  assert.equal(entries(item, 'bothEqual').length, 1)
  // A document in the base currency whose rate is missing is not unreadable: it is out of scope.
  const base = await runXeroRateItem('R16', context({ invoices: [invoiceRow({ n: 1, date: SEP, currency: 'GBP', rate: null })] }).ctx)
  assert.equal(base.outcome, 'pass')
})

test('THE PERIOD: only the closed months are judged; a day of margin in the request is read and set aside, a row beyond it is an unreadable list', async () => {
  const early = { ims: { rows: [{ currency: 'EUR', rate: '1.25', fetchedAt: '2026-07-01T00:00:00.000Z', manualOverride: false }] } }
  const { ctx, xero } = context({ invoices: [eur(1, 0.8, '2026-07-31'), eur(2, 0.5, '2026-10-01'), eur(3, 0.8, '2026-08-01'), eur(4, 0.8, '2026-09-30'), eur(5, 0.8, '2026-10-02')] }, early)
  const run = await runXeroRateCheck(ctx)
  // The asked-for window is August and September, widened by one day each side: 2026-07-31 <= date < 2026-10-02.
  assert.equal(xero.calls[1]!.params.where, 'Date>=DateTime(2026, 7, 31) AND Date<DateTime(2026, 10, 2)')
  assert.equal(run.item.outcome, 'inconclusive', '2026-10-02 is outside what was asked for')
  assert.deepEqual(run.item.reasons, ['SOURCE_UNREADABLE'])
  const inside = await runXeroRateCheck(context({ invoices: [eur(1, 0.8, '2026-07-31'), eur(2, 0.5, '2026-10-01'), eur(3, 0.8, '2026-08-01'), eur(4, 0.8, '2026-09-30')] }, early).ctx)
  assert.equal(inside.item.outcome, 'pass')
  assert.equal(inside.summary?.outsidePeriod, 2, 'the two margin days are read and not judged (the 0.5 on 2026-10-01 would otherwise differ)')
  assert.deepEqual(entries(inside.item, 'bothEqual').map((e) => e.key), [keyOf('sales-invoice', 3), keyOf('sales-invoice', 4)])
})

test('every request is a read of one of the four resources, with the status filter on the document lists and none on the payments', async () => {
  const { ctx, xero } = context({ invoices: [eur(1, 0.8)], creditNotes: [creditNoteRow({ n: 2, date: SEP, currency: 'EUR', rate: 0.8 })], payments: [paymentRow({ n: 3, date: SEP, currency: 'EUR', rate: 0.8 })] })
  await runXeroRateItem('R16', ctx)
  for (const call of xero.calls) {
    if (call.resource === 'Organisation') assert.deepEqual(call.params, {})
    else if (call.resource === 'Payments') assert.deepEqual(Object.keys(call.params).sort(), ['page', 'where'])
    else assert.deepEqual([Object.keys(call.params).sort(), call.params.Statuses], [['Statuses', 'page', 'where'], 'DRAFT,SUBMITTED,AUTHORISED,PAID,VOIDED,DELETED'])
  }
  assert.equal(xero.calls.length, 7)
})

// [mutation: the opt-in not required / a port touched before the check]
test('WITHOUT THE OPT-IN nothing is read: no port is touched, no IMS read is made, the only reason is VENDOR_READS_OFF', async () => {
  for (const vendorReads of [undefined, false, 'true' as unknown as boolean, 1 as unknown as boolean]) {
    const { ctx, xero, ims } = context({ invoices: [eur(1, 0.8)] }, { context: { vendorReads } })
    const item = await runXeroRateItem('R16', ctx)
    assert.deepEqual(item, { id: 'R16', outcome: 'inconclusive', reasons: ['VENDOR_READS_OFF'] })
    assert.equal(xero.calls.length, 0)
    assert.equal(ims.calls.length, 0)
  }
})

test('the IMS side is read first and in one snapshot: an unreadable one makes no request to Xero at all, and a base currency that is not GBP compares nothing', async () => {
  for (const fail of ['throws', 'read', 'section'] as const) {
    const { ctx, xero } = context({ invoices: [eur(1, 0.8)] }, { ims: { fail } })
    const item = await runXeroRateItem('R16', ctx)
    assert.equal(item.outcome, 'inconclusive', fail)
    assert.equal(xero.calls.length, 0, `${fail}: no request`)
  }
  const section = await runXeroRateItem('R16', context({}, { ims: { fail: 'section' } }).ctx)
  assert.deepEqual(section.reasons, ['CAP_EXCEEDED'])
  const imsBase = context({ invoices: [eur(1, 0.8)] }, { ims: { base: 'EUR' } })
  assert.deepEqual((await runXeroRateItem('R16', imsBase.ctx)).reasons, ['BASE_CURRENCY_NOT_GBP'])
  assert.equal(imsBase.xero.calls.length, 0)
  const xeroBase = context({ invoices: [eur(1, 0.8)] }, { double: { baseCurrency: 'EUR' } })
  assert.deepEqual((await runXeroRateItem('R16', xeroBase.ctx)).reasons, ['BASE_CURRENCY_NOT_GBP'])
  assert.equal(xeroBase.xero.calls.length, 1, 'only the organisation was read')
  const one = context({})
  await runXeroRateItem('R16', one.ctx)
  assert.deepEqual(one.ims.calls, [{ sections: ['baseCurrency', 'fxRates', 'xeroPostedRates'] }])
})

// [mutation: the connection not checked at the start / at the end]
test('the stored connection must be usable at the start and the same at the end of the walk', async () => {
  const lists = { invoices: [eur(1, 0.8)] }
  const run = (b: () => Promise<{ tenantId: string; connectionGeneration: string | null } | null>) => { const c = context(lists); return runXeroRateItem('R16', { ...c.ctx, vendor: { xero: { port: c.xero, binding: b } } }) }
  assert.deepEqual((await run(async () => null)).reasons, ['XERO_CONNECTION_UNUSABLE'])
  let n = 0
  assert.deepEqual((await run(async () => (n++ === 0 ? { tenantId: 'a', connectionGeneration: 'g' } : null))).reasons, ['XERO_CONNECTION_UNUSABLE'])
  n = 0
  assert.deepEqual((await run(async () => (n++ === 0 ? null : { tenantId: 'a', connectionGeneration: 'g' }))).reasons, ['XERO_CONNECTION_UNUSABLE'], 'unusable at the start, usable at the end')
  n = 0
  assert.deepEqual((await run(async () => ({ tenantId: n++ === 0 ? 'a' : 'b', connectionGeneration: 'g' }))).reasons, ['XERO_CONNECTION_UNUSABLE'])
  n = 0
  assert.deepEqual((await run(async () => ({ tenantId: 'a', connectionGeneration: n++ === 0 ? 'g1' : 'g2' }))).reasons, ['XERO_CONNECTION_UNUSABLE'])
  assert.equal((await run(async () => ({ tenantId: 'a', connectionGeneration: 'g' }))).outcome, 'pass')
  // A port that throws and an input that is not a date are inconclusive, never a throw.
  const c = context(lists)
  const thrown = await runXeroRateItem('R16', { ...c.ctx, vendor: { xero: { port: { get: async () => { throw new Error('boom') } }, binding: binding() } } })
  assert.deepEqual(thrown.reasons, ['XERO_CONNECTION_UNUSABLE'])
  assert.deepEqual((await runXeroRateItem('R16', { ...c.ctx, asOf: 'yesterday' })).reasons, ['STALE_BASIS'])
  assert.deepEqual((await runXeroRateItem('R16', { ...c.ctx, vendor: {} })).reasons, ['SOURCE_UNREADABLE'])
  assert.deepEqual((await runXeroRateItem('R16', { ...c.ctx, ims: undefined })).reasons, ['SOURCE_UNREADABLE'])
})

// [mutation: the sort removed / the key built from something that varies]
test('THE ROWS ARE DETERMINISTIC: the order Xero lists them in does not change a byte of the result, and the identity is the kind and the Xero id only', async () => {
  const docs: XeroRateDocument[] = [1, 2, 3, 4].map((n) => ({ readable: true, kind: n % 2 === 0 ? 'payment' : 'sales-invoice', id: uuid(n), date: SEP, currency: 'EUR', rate: n === 3 ? '0.9' : '0.8' }))
  const base = { read: { invoices: 2, creditNotes: 0, payments: 2 }, deletedPayments: 0, setAsideDocuments: 0, base: 'GBP', fxRows: FX_ROWS, posted: [], periods: ['2026-08', '2026-09'] }
  const forward = buildRateRows({ ...base, documents: docs })
  const backward = buildRateRows({ ...base, documents: [...docs].reverse() })
  assert.deepEqual(forward, backward)
  assert.deepEqual(forward.ims.map((r) => (r.key as unknown as Array<{ raw: string }>).map((p) => p.raw)), [['xero-rate', 'payment', uuid(2)], ['xero-rate', 'payment', uuid(4)], ['xero-rate', 'sales-invoice', uuid(1)], ['xero-rate', 'sales-invoice', uuid(3)]])
  // The same inputs in two runs give the same item, byte for byte.
  const a = JSON.stringify(await runXeroRateItem('R16', context({ invoices: [eur(1, 0.8), eur(2, 0.9)], payments: [paymentRow({ n: 3, date: SEP, currency: 'EUR', rate: 0.8 })] }).ctx))
  const b = JSON.stringify(await runXeroRateItem('R16', context({ invoices: [eur(2, 0.9), eur(1, 0.8)], payments: [paymentRow({ n: 3, date: SEP, currency: 'EUR', rate: 0.8 })] }, { double: { pageSize: 1 } }).ctx))
  assert.equal(a, b)
})

// [mutation: the status filter narrowed back to AUTHORISED,PAID / VOIDED or DELETED judged / an unknown status accepted]
test('EVERY STATUS IS READ: a differing DRAFT invoice and a differing SUBMITTED credit note are findings, and VOIDED and DELETED documents are counted and set aside', async () => {
  const run = await runXeroRateCheck(context({
    invoices: [eur(1, 0.9, SEP, { status: 'DRAFT' }), eur(2, 0.8, SEP, { status: 'DRAFT' }), eur(3, 0.9, SEP, { status: 'VOIDED' }), eur(4, 0.9, SEP, { status: 'DELETED' }), eur(5, 0.8, SEP, { status: 'PAID' })],
    creditNotes: [creditNoteRow({ n: 6, date: SEP, currency: 'EUR', rate: 0.7, status: 'SUBMITTED' }), creditNoteRow({ n: 7, date: SEP, currency: 'EUR', rate: 0.7, status: 'VOIDED' })],
  }).ctx)
  assert.deepEqual([run.item.outcome, [...run.item.reasons].sort()], ['fail', ['DIFFERENCES', 'XERO_RATE_DIFFERS']])
  assert.deepEqual(entries(run.item, 'bothDiffer').map((e) => e.key).sort(), [keyOf('sales-cn', 6), keyOf('sales-invoice', 1)].sort())
  assert.deepEqual(entries(run.item, 'bothEqual').map((e) => e.key).sort(), [keyOf('sales-invoice', 2), keyOf('sales-invoice', 5)].sort())
  assert.deepEqual([run.summary?.read, run.summary?.setAsideDocuments, run.summary?.compared], [{ invoices: 5, creditNotes: 2, payments: 0 }, 3, 4])
  // A voided document alone, at a rate that would differ, is not a finding: it is out of scope and says so in the summary.
  const voided = await runXeroRateCheck(context({ invoices: [eur(1, 0.9, SEP, { status: 'VOIDED' })] }).ctx)
  assert.equal(voided.item.outcome, 'pass')
  assert.equal(voided.summary?.setAsideDocuments, 1)
  // A status that is not one of the six makes the run inconclusive, never a pass (even when the only row would otherwise be equal).
  const unknown = await runXeroRateItem('R16', context({ invoices: [eur(1, 0.8, SEP, { status: 'ARCHIVED' })] }).ctx)
  assert.deepEqual([unknown.outcome, unknown.reasons], ['inconclusive', ['SOURCE_UNREADABLE']])
})

// [mutation: a count left out / counted twice]
test('THE SUMMARY says what was read and how each row was judged', async () => {
  const run = await runXeroRateCheck(context({
    invoices: [eur(1, 0.8), eur(2, 0.9), eur(3, null), eur(4, 0.8, '2026-09-09'), invoiceRow({ n: 5, date: SEP, currency: 'GBP', rate: 1 }), eur(6, 0.8, '2026-10-01')],
    creditNotes: [creditNoteRow({ n: 8, date: SEP, currency: 'EUR', rate: 0.1, status: 'VOIDED' }), creditNoteRow({ n: 9, date: SEP, currency: 'EUR', rate: 0.1, status: 'DELETED' })],
    payments: [paymentRow({ n: 7, date: SEP, currency: 'EUR', rate: 0.8, status: 'DELETED' })],
  }).ctx)
  assert.deepEqual(run.summary, { periods: ['2026-08', '2026-09'], read: { invoices: 6, creditNotes: 2, payments: 1 }, deletedPayments: 1, setAsideDocuments: 2, outsidePeriod: 1, baseCurrency: 1, compared: 2, equal: 1, xeroRateDiffers: 1, imsRateMissing: 1, documentUnreadable: 1, imsPosted: 0, postedRateNotTableRate: 0, postingUnreadable: 0, postedTableNotChecked: 0 })
  assert.equal(summariseRateCheck(run.summary!), 'periods 2026-08,2026-09; read 6 invoices and bills, 2 credit notes, 1 payments (1 deleted payments, 2 voided or deleted documents set aside as out of scope); 1 outside the periods, 1 in the base currency (out of scope); 2 foreign compared (1 equal, 1 differ), 1 without an IMS rate, 1 unreadable; 0 posted by IMS (held to the rate the posting carried; 0 not the table rate, 0 posting unreadable, 0 with no table rule)')
  assert.equal(ASOF, '2026-10-19')
  assert.equal((await runXeroRateCheck({ ...context({}).ctx, vendorReads: true, ims: undefined })).summary, null)
})

test('an empty population with every list proven passes only on the named proof', async () => {
  const item = await runXeroRateItem('R16', context({}).ctx)
  assert.deepEqual([item.outcome, item.proof], ['pass', { kind: 'proven-empty', source: 'no-foreign-currency-documents' }])
})

// ---- IMS POSTINGS (Codex round 2): a record IMS posted is held to the rate its posting carried -----------------------------------------------------

const LATER = [...FX_ROWS, { currency: 'EUR', rate: '1.3', fetchedAt: '2026-09-10T18:00:00.000Z', manualOverride: false }]
const pair = (item: Awaited<ReturnType<typeof runXeroRateItem>>, bucket: string) => entries(item, bucket).map((e) => [e.key, e.ims, e.vendor])

// [mutation: the posted rate replaced by the table lookup / the Xero rate compared with the later table row]
test('A PAYMENT IMS POSTED AT 1.25, WITH A 1.30 ROW ARRIVING LATER THAT DAY: Xero holding 1/1.30 is a finding against the posting, not a pass against the later row', async () => {
  const lists = { payments: [paymentRow({ n: 1, date: SEP, currency: 'EUR', rate: 0.769231 })] }
  const posted = [postedRow(1, 'INVOICE_PAYMENT', { rate: '1.25' })]
  const item = await runXeroRateItem('R16', context(lists, { ims: { rows: LATER, posted } }).ctx)
  assert.deepEqual([item.outcome, [...item.reasons].sort()], ['fail', ['DIFFERENCES', 'XERO_RATE_DIFFERS']])
  assert.deepEqual(pair(item, 'bothDiffer'), [[`xero-rate|payment|${uuid(1)}|ims-posting|log1`, '0.8', '0.769231']])
  // The same Xero rate for a record IMS did NOT post is reconstructed against the table, as before, and passes.
  const manual = await runXeroRateItem('R16', context(lists, { ims: { rows: LATER, posted: [postedRow(2, 'INVOICE_PAYMENT')] } }).ctx)
  assert.equal(manual.outcome, 'pass')
  // Xero holding what the posting carried passes, whatever the table says later, and the record kind has no table rule here (counted).
  const equal = await runXeroRateCheck(context({ payments: [paymentRow({ n: 1, date: SEP, currency: 'EUR', rate: 0.8 })] }, { ims: { rows: LATER, posted } }).ctx)
  assert.equal(equal.item.outcome, 'pass')
  assert.deepEqual([equal.summary?.imsPosted, equal.summary?.postedTableNotChecked, equal.summary?.equal], [1, 1, 1])
})

// [mutation: the table check removed / the table rule widened to accept any rate / the order rate alternative dropped]
test('A POSTED RATE THAT IS NOT THE TABLE RATE under the record\'s date rule is IMS_POSTED_RATE_NOT_TABLE_RATE; the stored rate and the table rate are listed', async () => {
  // A storefront invoice: the order rate must be a central rate in force on the order's day (1.25 from 06:00, 1.30 from 18:00).
  const invoice = (rate: string, xero: number) => context({ invoices: [eur(1, xero)] }, { ims: { rows: LATER, posted: [postedRow(1, 'SALES_INVOICE', { rate, wooOrder: true })] } }).ctx
  for (const [rate, xero] of [['1.25', 0.8], ['1.3', 0.769231]] as const) assert.equal((await runXeroRateItem('R16', invoice(rate, xero))).outcome, 'pass', rate)
  const off = await runXeroRateItem('R16', invoice('1.4', 0.714286))
  assert.deepEqual([off.outcome, [...off.reasons].sort()], ['fail', ['DIFFERENCES', 'IMS_POSTED_RATE_NOT_TABLE_RATE']])
  assert.deepEqual(pair(off, 'bothDiffer'), [[`xero-rate|sales-invoice|${uuid(1)}|posted-vs-table|log1`, '0.769231', '0.714286']])
  // The rate in force at the START of the order's day (the previous day's last row) is a table rate for an order placed early that day.
  const early = [{ currency: 'EUR', rate: '1.2', fetchedAt: '2026-09-09T06:00:00.000Z', manualOverride: false }, ...LATER]
  assert.equal((await runXeroRateItem('R16', context({ invoices: [eur(1, 0.833333)] }, { ims: { rows: early, posted: [postedRow(1, 'SALES_INVOICE', { rate: '1.2', wooOrder: true })] } }).ctx)).outcome, 'pass')
  // A record that is not a storefront one has no table rule: checked against Xero alone and counted.
  const plain = await runXeroRateCheck(context({ invoices: [eur(1, 0.714286)] }, { ims: { rows: LATER, posted: [postedRow(1, 'SALES_INVOICE', { rate: '1.4' })] } }).ctx)
  assert.deepEqual([plain.item.outcome, plain.summary?.postedTableNotChecked, plain.summary?.postedRateNotTableRate], ['pass', 1, 0])
  // A storefront receipt: the order's own rate (paid the day it was ordered) or the central rate at the end of the payment day.
  const receipt = (rate: string, orderRate: string | null, xero: number) => context({ payments: [paymentRow({ n: 1, date: SEP, currency: 'EUR', rate: xero })] }, { ims: { rows: LATER, posted: [postedRow(1, 'INVOICE_PAYMENT', { rate, orderRate, wooReceipt: true })] } }).ctx
  assert.equal((await runXeroRateItem('R16', receipt('1.2', '1.2', 0.833333))).outcome, 'pass', 'the order rate, same day')
  assert.equal((await runXeroRateItem('R16', receipt('1.3', '1.2', 0.769231))).outcome, 'pass', 'the central rate at the end of the payment day')
  const wrong = await runXeroRateItem('R16', receipt('1.2', '1.25', 0.833333))
  assert.deepEqual([wrong.outcome, [...wrong.reasons].sort()], ['fail', ['DIFFERENCES', 'IMS_POSTED_RATE_NOT_TABLE_RATE']])
  // No central rate on the day at all: IMS_RATE_MISSING, never a pass.
  const none = await runXeroRateItem('R16', context({ invoices: [eur(1, 0.8)] }, { ims: { rows: [], posted: [postedRow(1, 'SALES_INVOICE', { wooOrder: true })] } }).ctx)
  assert.deepEqual([none.outcome, [...none.reasons].sort()], ['fail', ['DIFFERENCES', 'IMS_RATE_MISSING']])
})

// [mutation: an unreadable posting passed / treated as not posted / the link kind or currency not checked / an ambiguous link taken]
test('A BROKEN LINK IS A FINDING, never a pass: gone payload, no rate, an unusable rate, a currency or kind that disagrees with Xero, two records naming one id, a storefront record with no date', async () => {
  const cases: Array<[string, ReturnType<typeof postedRow>[]]> = [
    ['payload gone', [postedRow(1, 'SALES_INVOICE', { noPayload: true, rate: null, currency: null, date: null })]],
    ['no rate', [postedRow(1, 'SALES_INVOICE', { rate: null })]],
    ['rate zero', [postedRow(1, 'SALES_INVOICE', { rate: '0' })]],
    ['rate not a number', [postedRow(1, 'SALES_INVOICE', { rate: 'abc' })]],
    ['no currency', [postedRow(1, 'SALES_INVOICE', { currency: null })]],
    ['currency disagrees', [postedRow(1, 'SALES_INVOICE', { currency: 'USD' })]],
    ['kind disagrees', [postedRow(1, 'CREDIT_NOTE')]],
    ['two records', [postedRow(1, 'SALES_INVOICE'), { ...postedRow(1, 'SALES_INVOICE'), id: 'log1b' }]],
    ['invoice with no date', [postedRow(1, 'SALES_INVOICE', { wooOrder: true, date: null })]],
    ['payload gone, the other fields still present', [postedRow(1, 'SALES_INVOICE', { noPayload: true })]],
    ['rate so large that Xero\'s convention rounds to zero', [postedRow(1, 'SALES_INVOICE', { rate: '10000000' })]],
  ]
  for (const [name, posted] of cases) {
    const item = await runXeroRateItem('R16', context({ invoices: [eur(1, 0.8)] }, { ims: { posted } }).ctx)
    assert.deepEqual([item.outcome, [...item.reasons].sort()], ['fail', ['DIFFERENCES', 'IMS_POSTING_UNREADABLE']], name)
    assert.equal(entries(item, 'onlyVendor').length, 1, name)
  }
  // A storefront receipt (a payment) with no payment date: its table rule cannot be applied, so it is a finding, not a pass (the rate itself agrees with Xero).
  const undated = await runXeroRateItem('R16', context({ payments: [paymentRow({ n: 1, date: SEP, currency: 'EUR', rate: 0.8 })] }, { ims: { posted: [postedRow(1, 'INVOICE_PAYMENT', { wooReceipt: true, orderRate: '1.25', date: null })] } }).ctx)
  assert.deepEqual([undated.outcome, [...undated.reasons].sort()], ['fail', ['DIFFERENCES', 'IMS_POSTING_UNREADABLE']])
  // The posted-rates section failing to read is inconclusive, and nothing is requested from Xero first.
  const failing = context({ invoices: [eur(1, 0.8)] }, { ims: { fail: 'posted' } })
  const item = await runXeroRateItem('R16', failing.ctx)
  assert.deepEqual([item.outcome, item.reasons], ['inconclusive', ['CAP_EXCEEDED']])
  assert.equal(failing.xero.calls.length, 0)
})
