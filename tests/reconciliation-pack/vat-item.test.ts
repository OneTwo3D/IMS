import assert from 'node:assert/strict'
import test from 'node:test'

import { R12_CLOSE_LAG_DAYS, R12_VERIFIED_CATEGORIES, getPackItem, itemNeedsVendor } from '../../lib/reconciliation-pack/constants.ts'
import { R12_LEGS, r12ClosedPeriods, runVatItem } from '../../lib/reconciliation-pack/vat-item.ts'
import { buildDiscountTaxSplit, invoiceDiscountParts } from '../../lib/domain/sales/discount-tax-split.ts'
import {
  BOUNDARIES, wooTotalTax, MAPPINGS, noSleep, REPORT_TYPES, R_DE_OSS, R_GB, R_IE, TENANT, binding, invoice, provenStore, rate, sale, standard, wooOrder, type ImsFixture,
} from './vat-fixtures.ts'

/**
 * R12 over doubles of the IMS read, the Xero port and the WooCommerce port. Each test names the mutation it is the guard for.
 */

const keys = (item: { entries?: Partial<Record<string, readonly { key: string }[]>> }, bucket: string) => (item.entries?.[bucket] ?? []).map((e) => e.key)
const run = (ctx: Parameters<typeof runVatItem>[1]) => runVatItem('R12', ctx)
const reasons = (item: { outcome: string; reasons: readonly string[] }) => [item.outcome, ...item.reasons]

test('R12 passes when the three systems agree per key: three legs, six compared keys, the three catalogue sources named', async () => {
  const { ctx } = standard()
  const item = await run(ctx)
  assert.deepEqual(reasons(item), ['pass'])
  assert.deepEqual(item.proof, { kind: 'compared' })
  assert.deepEqual([...item.sources!].sort(), [...getPackItem('R12').sources].sort())
  assert.deepEqual(keys(item, 'bothEqual').sort(), [
    'ims-woo|2026-08|GB|domestic', 'ims-woo|2026-09|GB|domestic', 'ims-xero|2026-08|GB|domestic', 'ims-xero|2026-09|GB|domestic', 'xero-woo|2026-08|GB|domestic', 'xero-woo|2026-09|GB|domestic',
  ])
  for (const bucket of ['onlyIms', 'onlyVendor', 'bothDiffer', 'unsettled']) assert.deepEqual(keys(item, bucket), [])
})

// [mutation: the vendorReads check removed / loosened to truthy]
test('FLAG OFF: anything but the boolean true reads nothing - no IMS read, no Xero request, no Woo request', async () => {
  for (const flag of [undefined, false, 'true', 1, null]) {
    const { ctx, ims, xero, woo } = standard({ context: { vendorReads: flag as never } })
    const item = await run(ctx)
    assert.deepEqual([item.outcome, item.reasons], ['inconclusive', ['VENDOR_READS_OFF']], String(flag))
    assert.deepEqual([ims.calls.length, xero.calls.length, woo.calls.length], [0, 0, 0], String(flag))
  }
  assert.equal(itemNeedsVendor('R12'), true, 'the run loop skips it before liveness when the flag is off')
})

test('a missing port is SOURCE_UNREADABLE and nothing is requested', async () => {
  const { ctx, xero, woo } = standard()
  for (const vendor of [{ woo: ctx.vendor!.woo }, { xero: ctx.vendor!.xero }, {}, undefined]) {
    const item = await run({ ...ctx, vendor })
    assert.deepEqual([item.outcome, item.reasons], ['inconclusive', ['SOURCE_UNREADABLE']])
  }
  assert.deepEqual([xero.calls.length, woo.calls.length], [0, 0])
  const noIms = await run({ ...ctx, ims: undefined })
  assert.deepEqual(reasons(noIms), ['inconclusive', 'SOURCE_UNREADABLE'])
})

// ---- period ------------------------------------------------------------------------------------

// [mutation: the close lag removed or counted from the first of the month; the window not clipped to closed months]
test('A PERIOD IS CLOSED only once the cycle date is the lag after its end: the 8th of the next month is closed, the 7th is not', () => {
  assert.equal(R12_CLOSE_LAG_DAYS, 7)
  assert.deepEqual(r12ClosedPeriods('2026-10-07'), ['2026-07', '2026-08'])
  assert.deepEqual(r12ClosedPeriods('2026-10-08'), ['2026-08', '2026-09'])
  assert.deepEqual(r12ClosedPeriods('2026-10-19'), ['2026-08', '2026-09'])
  assert.deepEqual(r12ClosedPeriods('2026-01-08'), ['2025-11', '2025-12'])
  assert.deepEqual(r12ClosedPeriods('2026-01-07'), ['2025-10', '2025-11'])
  assert.deepEqual(r12ClosedPeriods('2026-03-08'), ['2026-01', '2026-02'])
  assert.deepEqual(r12ClosedPeriods('2026-10-08', 1, 0), ['2026-09'])
  for (const bad of ['2026-02-30', '2026-13-01', '26-10-01', '', '2026-10-1', 'x']) assert.equal(r12ClosedPeriods(bad), null, bad)
})

test('UNCLOSED PERIOD EXCLUDED: October data present in all three systems on a 19 October cycle date is never asked for and never counted', async () => {
  const { ctx, ims, xero, woo } = standard({
    ims: { sales: [sale('2026-09', 'rGB', '100.00'), sale('2026-08', 'rGB', '50.00'), sale('2026-10', 'rGB', '999.00')] },
    xero: [invoice(1, '2026-09-05', [{ type: 'OUTPUT2', tax: 100 }]), invoice(3, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }])],
    woo: { processing: [wooOrder(101, '2026-09-10T09:30:00', [[11, '100.00']]), wooOrder(103, '2026-08-12T10:00:00', [[11, '50.00']])] },
  })
  const item = await run(ctx)
  assert.deepEqual(reasons(item), ['pass'])
  // The IMS window is the two closed months, and the vendors are asked for that window widened, never for October.
  assert.deepEqual(ims.calls[0]!.vatWindow, { from: '2026-08-01', toExclusive: '2026-10-01' })
  assert.match(xero.calls.find((c) => c.resource === 'Invoices')!.params.where!, /Date>=DateTime\(2026, 7, 31\) AND Date<DateTime\(2026, 10, 2\)$/)
  assert.deepEqual([woo.calls[0]!.params.after, woo.calls[0]!.params.before], ['2026-07-30', '2026-10-03'])
  // A vendor row in the widened margin but outside the closed months (1 October) is cut, not counted.
  const inMargin = standard({
    xero: [invoice(1, '2026-09-05', [{ type: 'OUTPUT2', tax: 100 }]), invoice(3, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }]), invoice(4, '2026-10-01', [{ type: 'OUTPUT2', tax: 7 }]), invoice(5, '2026-07-31', [{ type: 'OUTPUT2', tax: 3 }])],
    woo: { processing: [wooOrder(101, '2026-09-10T09:30:00', [[11, '100.00']]), wooOrder(103, '2026-08-12T10:00:00', [[11, '50.00']]), wooOrder(104, '2026-10-01T00:00:00', [[11, '5.00']]), wooOrder(105, '2026-07-31T22:59:59', [[11, '5.00']])] },
  })
  assert.deepEqual(reasons(await run(inMargin.ctx)), ['pass'])
})

// [mutation: month boundary compared with <= instead of the period string / the GMT date not used / the UTC month used instead of the London month]
// o3d-oe1b0: the month is the LONDON month, the calendar the Xero invoice dates and the IMS side use. September is BST (UTC+1), so 22:59:59 GMT on 30 September is
// still September in London and 23:00:00 GMT is 00:00 on 1 October. Bucketed by the UTC month, order 102 would land in September and order 101's neighbour in October.
test('a month boundary is the LONDON month: an order created at 22:59:59 GMT on 30 September (BST) counts in September, one at 23:00:00 GMT is already 1 October and does not', async () => {
  const edge = standard({
    ims: { sales: [sale('2026-09', 'rGB', '10.00'), sale('2026-08', 'rGB', '50.00')] },
    xero: [invoice(1, '2026-09-30', [{ type: 'OUTPUT2', tax: 10 }]), invoice(3, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }])],
    woo: { processing: [wooOrder(101, '2026-09-30T22:59:59', [[11, '10.00']]), wooOrder(102, '2026-09-30T23:00:00', [[11, '77.00']]), wooOrder(103, '2026-08-12T10:00:00', [[11, '50.00']])] },
  })
  assert.deepEqual(reasons(await run(edge.ctx)), ['pass'])
})

test('o3d-oe1b0: a BST month-end order created at 23:30 GMT is October in London, so September IMS and Xero tax is not matched by it', async () => {
  const edge = standard({
    ims: { sales: [sale('2026-09', 'rGB', '10.00'), sale('2026-08', 'rGB', '50.00')] },
    xero: [invoice(1, '2026-09-30', [{ type: 'OUTPUT2', tax: 10 }]), invoice(3, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }])],
    woo: { processing: [wooOrder(101, '2026-09-30T23:30:00', [[11, '10.00']]), wooOrder(103, '2026-08-12T10:00:00', [[11, '50.00']])] },
  })
  assert.notEqual((await run(edge.ctx)).outcome, 'pass')
})

// [mutation: classifyPopulation not consulted]
test('POPULATION: a month before the recorded first load or storefront import is left out; an unrecorded boundary is NO_POPULATION_RECORD; nothing left is EMPTY_UNPROVEN', async () => {
  const cut = { ...BOUNDARIES, firstLoad: { state: 'verified' as const, cutAt: '2026-08-31T23:00:00.000Z' } }
  const noAug = standard({
    ims: { boundaries: cut, sales: [sale('2026-09', 'rGB', '100.00'), sale('2026-08', 'rGB', '1000.00')] },
  })
  // August is out of IMS's population: the 1000 in IMS is not read, and the vendors' August figures are cut too, so September alone decides.
  assert.deepEqual(reasons(await run(noAug.ctx)), ['pass'])
  assert.deepEqual(keys(await run(standard({ ims: { boundaries: cut, sales: [sale('2026-09', 'rGB', '100.00')] } }).ctx), 'bothEqual').filter((k) => k.includes('2026-08')), [])
  for (const boundaries of [{ ...BOUNDARIES, firstLoad: { state: 'absent' as const } }, { ...BOUNDARIES, firstLoad: { state: 'unverified' as const } }, { ...BOUNDARIES, storefrontImport: { state: 'not-completed' as const } }]) {
    const { ctx, xero, woo } = standard({ ims: { boundaries } })
    assert.deepEqual(reasons(await run(ctx)), ['inconclusive', 'NO_POPULATION_RECORD'])
    assert.deepEqual([xero.calls.length, woo.calls.length], [0, 0], 'decided before any vendor request')
  }
  const none = standard({ ims: { boundaries: { ...BOUNDARIES, firstLoad: { state: 'verified', cutAt: '2026-11-01T00:00:00.000Z' } } } })
  assert.deepEqual(reasons(await run(none.ctx)), ['inconclusive', 'EMPTY_UNPROVEN'])
  assert.equal(none.xero.calls.length, 0)
  const retained = standard({ ims: { boundaries: { ...BOUNDARIES, retentionMonths: 1 } } })
  assert.deepEqual(reasons(await run(retained.ctx)), ['inconclusive', 'EMPTY_UNPROVEN'])
})

// [mutation: the period start taken as the UTC month start instead of London midnight]
test('POPULATION BOUNDARY is London midnight: a cut at 23:30Z on 31 July (00:30 BST on 1 August) leaves August out, a cut at 23:00Z exactly keeps it', async () => {
  const partial = { ...BOUNDARIES, firstLoad: { state: 'verified' as const, cutAt: '2026-07-31T23:30:00.000Z' } }
  const out = standard({ ims: { boundaries: partial, sales: [sale('2026-09', 'rGB', '100.00'), sale('2026-08', 'rGB', '1000.00')] } })
  assert.deepEqual(keys(await run(out.ctx), 'bothEqual').filter((k) => k.includes('2026-08')), [], 'August began before the cut: not wholly held, so not compared')
  const whole = { ...BOUNDARIES, firstLoad: { state: 'verified' as const, cutAt: '2026-07-31T23:00:00.000Z' } }
  const kept = standard({ ims: { boundaries: whole, sales: [sale('2026-09', 'rGB', '100.00'), sale('2026-08', 'rGB', '50.00')] } })
  assert.ok(keys(await run(kept.ctx), 'bothEqual').some((k) => k.includes('2026-08')))
})

// ---- tolerance and set -----------------------------------------------------------------------

// [mutation: the tolerance limit changed, made exclusive, or the absolute rule replaced]
test('GBP 0.05 IS INCLUSIVE: a key off by exactly 0.05 agrees, by 0.06 it is a difference (every leg that touches it)', async () => {
  const cases: Array<[string, 'pass' | 'fail']> = [['100.00', 'pass'], ['100.05', 'pass'], ['99.95', 'pass'], ['100.06', 'fail'], ['99.94', 'fail']]
  for (const [imsValue, expected] of cases) {
    const { ctx } = standard({ ims: { sales: [sale('2026-09', 'rGB', imsValue), sale('2026-08', 'rGB', '50.00')] } })
    const item = await run(ctx)
    assert.equal(item.outcome, expected, imsValue)
    if (expected === 'fail') assert.deepEqual(keys(item, 'bothDiffer').sort(), ['ims-woo|2026-09|GB|domestic', 'ims-xero|2026-09|GB|domestic'], 'the two legs of IMS differ, the vendors still agree with each other')
  }
  // Rounding is half up to the penny before the comparison: 100.054 is 100.05 (agrees), 100.055 is 100.06 (does not).
  assert.equal((await run(standard({ ims: { sales: [sale('2026-09', 'rGB', '100.054'), sale('2026-08', 'rGB', '50.00')] } }).ctx)).outcome, 'pass')
  assert.equal((await run(standard({ ims: { sales: [sale('2026-09', 'rGB', '100.055'), sale('2026-08', 'rGB', '50.00')] } }).ctx)).outcome, 'fail')
})

// [mutation: the legs collapsed into one so a key on one side only is not an identity of its leg]
test('SET EXACTNESS: a key on one side only is a finding of its leg; a zero is not a key (provably nothing)', async () => {
  // IE VAT in IMS only.
  const onlyIms = standard({ ims: { sales: [sale('2026-09', 'rGB', '100.00'), sale('2026-08', 'rGB', '50.00'), sale('2026-09', 'rIE', '12.00')] } })
  const a = await run(onlyIms.ctx)
  assert.equal(a.outcome, 'fail')
  assert.deepEqual(keys(a, 'onlyIms').sort(), ['ims-woo|2026-09|IE|domestic', 'ims-xero|2026-09|IE|domestic'])
  // IE VAT in Xero only: ims-xero onlyVendor, xero-woo onlyIms.
  const onlyXero = standard({ xero: [invoice(1, '2026-09-05', [{ type: 'OUTPUT2', tax: 100 }, { type: 'OUTPUT9', tax: 12 }]), invoice(3, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }])] })
  const b = await run(onlyXero.ctx)
  assert.equal(b.outcome, 'fail')
  assert.deepEqual([keys(b, 'onlyVendor'), keys(b, 'onlyIms')], [['ims-xero|2026-09|IE|domestic'], ['xero-woo|2026-09|IE|domestic']])
  // A zero on one side and nothing on the other is the same thing.
  const zero = standard({ ims: { sales: [sale('2026-09', 'rGB', '100.00'), sale('2026-08', 'rGB', '50.00'), sale('2026-09', 'rIE', '0.00', 4)] }, xero: [invoice(1, '2026-09-05', [{ type: 'OUTPUT2', tax: 100 }, { type: 'OUTPUT9', tax: 0 }]), invoice(3, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }])] })
  assert.deepEqual(reasons(await run(zero.ctx)), ['pass'])
  // A value that rounds to zero is not a key either (0.004).
  const tiny = standard({ ims: { sales: [sale('2026-09', 'rGB', '100.00'), sale('2026-08', 'rGB', '50.00'), sale('2026-09', 'rIE', '0.004')] } })
  assert.deepEqual(reasons(await run(tiny.ctx)), ['pass'])
})

// [mutation: counts compared instead of identities]
test('IDENTITY SWAP: the same total under another country is an onlyIms plus an onlyVendor, never a pass', async () => {
  const swapped = standard({ ims: { sales: [sale('2026-09', 'rIE', '100.00'), sale('2026-08', 'rGB', '50.00')] } })
  const item = await run(swapped.ctx)
  assert.equal(item.outcome, 'fail')
  assert.deepEqual(item.reasons, ['DIFFERENCES'])
  assert.deepEqual(keys(item, 'onlyIms').sort(), ['ims-woo|2026-09|IE|domestic', 'ims-xero|2026-09|IE|domestic'])
  assert.deepEqual(keys(item, 'onlyVendor').sort(), ['ims-woo|2026-09|GB|domestic', 'ims-xero|2026-09|GB|domestic'])
})

// [mutation: any leg's operand replaced by the other leg's source]
test('THE THREE LEGS compare three different pairs: the table names two different sources per leg and exactly {ims,xero}, {ims,woo}, {xero,woo}; its labels match the printed identities', () => {
  for (const leg of R12_LEGS) assert.notEqual(leg.left, leg.right, leg.label)
  assert.deepEqual(R12_LEGS.map((leg) => [...new Set([leg.left, leg.right])].sort().join('+')).sort(), ['ims+woo', 'ims+xero', 'woo+xero'])
  assert.deepEqual(R12_LEGS.map((leg) => leg.label), ['ims-xero', 'ims-woo', 'xero-woo'])
  assert.equal(R12_LEGS.length, 3)
})

// [mutation: the xero-woo leg compares one vendor with itself]
test('VENDORS ON OPPOSITE SIDES OF IMS: IMS 100.00, Xero 100.05, Woo 99.95 each agree with IMS within 0.05 but differ 0.10 from each other, so R12 FAILS on the xero-woo leg alone', async () => {
  const s = standard({
    xero: [invoice(1, '2026-09-05', [{ type: 'OUTPUT2', tax: 100.05 }]), invoice(3, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }])],
    woo: { processing: [wooOrder(101, '2026-09-10T09:30:00', [[11, '99.95']]), wooOrder(103, '2026-08-12T10:00:00', [[11, '50.00']])] },
  })
  const item = await run(s.ctx)
  assert.equal(item.outcome, 'fail')
  assert.deepEqual(keys(item, 'bothDiffer'), ['xero-woo|2026-09|GB|domestic'])
  assert.deepEqual(keys(item, 'bothEqual').filter((k) => k.startsWith('ims-')).sort(), ['ims-woo|2026-08|GB|domestic', 'ims-woo|2026-09|GB|domestic', 'ims-xero|2026-08|GB|domestic', 'ims-xero|2026-09|GB|domestic'])
  const entry = item.entries!.bothDiffer![0]!
  assert.deepEqual([entry.ims, entry.vendor, entry.delta], ['100.05', '99.95', '0.1'])
})

// [mutation: a leg's operand replaced; each leg is caught by data only it can see]
test('PER-LEG IDENTITY SWAP: swapping a key between two countries in ONE system is caught by the two legs that touch that system, and the third leg stays equal', async () => {
  const base = {
    sales: [sale('2026-09', 'rGB', '100.00', 3), sale('2026-09', 'rIE', '20.00', 1), sale('2026-08', 'rGB', '50.00', 2)],
    xero: (gb: number, iev: number) => [invoice(1, '2026-09-05', [{ type: 'OUTPUT2', tax: gb }, { type: 'OUTPUT9', tax: iev }]), invoice(3, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }])],
    woo: (gb: string, iev: string) => ({ processing: [wooOrder(101, '2026-09-10T09:30:00', [[11, gb], [12, iev]]), wooOrder(103, '2026-08-12T10:00:00', [[11, '50.00']])] }),
  }
  const agree = await run(standard({ ims: { sales: base.sales }, xero: base.xero(100, 20), woo: base.woo('100.00', '20.00') }).ctx)
  assert.deepEqual(reasons(agree), ['pass'])
  // Only Xero's two countries swapped (GB 20, IE 100): ims-xero and xero-woo see it; ims-woo is equal.
  const xeroSwap = await run(standard({ ims: { sales: base.sales }, xero: base.xero(20, 100), woo: base.woo('100.00', '20.00') }).ctx)
  assert.equal(xeroSwap.outcome, 'fail')
  assert.deepEqual(keys(xeroSwap, 'bothDiffer').map((k) => k.split('|')[0]).sort(), ['ims-xero', 'ims-xero', 'xero-woo', 'xero-woo'])
  // Only Woo swapped: ims-woo and xero-woo see it; ims-xero is equal.
  const wooSwap = await run(standard({ ims: { sales: base.sales }, xero: base.xero(100, 20), woo: base.woo('20.00', '100.00') }).ctx)
  assert.equal(wooSwap.outcome, 'fail')
  assert.deepEqual(keys(wooSwap, 'bothDiffer').map((k) => k.split('|')[0]).sort(), ['ims-woo', 'ims-woo', 'xero-woo', 'xero-woo'])
  // Only IMS swapped: ims-xero and ims-woo see it; xero-woo is equal.
  const imsSwap = await run(standard({ ims: { sales: [sale('2026-09', 'rGB', '20.00', 3), sale('2026-09', 'rIE', '100.00', 1), sale('2026-08', 'rGB', '50.00', 2)] }, xero: base.xero(100, 20), woo: base.woo('100.00', '20.00') }).ctx)
  assert.equal(imsSwap.outcome, 'fail')
  assert.deepEqual(keys(imsSwap, 'bothDiffer').map((k) => k.split('|')[0]).sort(), ['ims-woo', 'ims-woo', 'ims-xero', 'ims-xero'])
  assert.ok(keys(imsSwap, 'bothEqual').some((k) => k.startsWith('xero-woo|')))
})

test('two rates of one key are summed; two Woo rate ids of one IMS rate are summed', async () => {
  const second = rate('rGB2', { accountingTaxType: 'OUTPUT5', countryCode: 'GB', reportingCategory: 'domestic' })
  const types = [...REPORT_TYPES, { taxType: 'OUTPUT5', reportTaxType: 'OUTPUT' }]
  const s = standard({
    ims: { rates: [R_GB, R_IE, R_DE_OSS, second], reportTypes: types, store: provenStore(types.map((t) => t.taxType)), mappings: [...MAPPINGS, { connector: 'woocommerce', externalTaxRateId: '14', taxRateId: 'rGB2', externalClass: null }], sales: [sale('2026-09', 'rGB', '60.00'), sale('2026-09', 'rGB2', '40.00'), sale('2026-08', 'rGB', '50.00')] },
    xero: [invoice(1, '2026-09-05', [{ type: 'OUTPUT2', tax: 60 }, { type: 'OUTPUT5', tax: 40 }]), invoice(3, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }])],
    woo: { processing: [wooOrder(101, '2026-09-10T09:30:00', [[11, '60.00'], [14, '40.00']]), wooOrder(103, '2026-08-12T10:00:00', [[11, '50.00']])] },
  })
  assert.deepEqual(reasons(await run(s.ctx)), ['pass'])
})

// ---- U8 and the mapping --------------------------------------------------------------------------

// [mutation: R12_VERIFIED_CATEGORIES widened, or the unverified check made only on the IMS side]
test('U8: THE VERIFIED CATEGORIES ARE DOMESTIC ONLY - any non-zero OSS, EC sales, reverse-charge or uncategorised VAT in IMS is VAT_MAPPING_UNVERIFIED before any vendor request', async () => {
  assert.deepEqual([...R12_VERIFIED_CATEGORIES], ['domestic'])
  const cases: Array<[string, ReturnType<typeof rate>]> = [
    ['oss', R_DE_OSS],
    ['ec sales', rate('rX', { accountingTaxType: 'ECOUT', countryCode: 'FR', reportingCategory: 'EC_SALES' })],
    ['reverse charge', rate('rX', { accountingTaxType: 'REVCHG', countryCode: 'GB', reportingCategory: 'REVERSE_CHARGE' })],
    ['no category', rate('rX', { accountingTaxType: 'OUTPUT7', countryCode: 'GB', reportingCategory: null })],
    ['an unknown category', rate('rX', { accountingTaxType: 'OUTPUT7', countryCode: 'GB', reportingCategory: 'IOSS' })],
  ]
  for (const [name, bad] of cases) {
    const types = [...REPORT_TYPES.filter((t) => t.taxType !== bad.accountingTaxType), { taxType: bad.accountingTaxType!, reportTaxType: 'OUTPUT' }]
    const { ctx, xero, woo } = standard({ ims: { rates: [R_GB, R_IE, bad], reportTypes: types, store: provenStore(types.map((t) => t.taxType)), sales: [sale('2026-09', 'rGB', '100.00'), sale('2026-08', 'rGB', '50.00'), sale('2026-09', bad.id, '5.00')] } })
    const item = await run(ctx)
    assert.deepEqual(reasons(item), ['inconclusive', 'VAT_MAPPING_UNVERIFIED'], name)
    assert.equal(item.entries, undefined, `${name}: nothing was compared`)
    assert.deepEqual([xero.calls.length, woo.calls.length], [0, 0], `${name}: decided before any vendor request`)
  }
})

test('U8: a ZERO figure on an unverified rate depends on nothing and is ignored', async () => {
  const { ctx } = standard({ ims: { sales: [sale('2026-09', 'rGB', '100.00'), sale('2026-08', 'rGB', '50.00'), sale('2026-09', 'rDE', '0.00', 9)] } })
  assert.deepEqual(reasons(await run(ctx)), ['pass'])
})

// [mutation: any one of the rate checks removed]
test('U8: a domestic rate needs a country, its own Xero tax type, and that type in the PROVEN list with the verified report type', async () => {
  const base = (over: Partial<ReturnType<typeof rate>>, extra: ImsFixture = {}) => standard({ ims: { rates: [{ ...R_GB, ...over }, R_IE], sales: [sale('2026-09', 'rGB', '100.00'), sale('2026-08', 'rGB', '50.00')], ...extra } })
  const cases: Array<[string, ReturnType<typeof base>]> = [
    ['no country', base({ countryCode: null })],
    ['lower-case-only country text', base({ countryCode: 'GBR' })],
    ['no Xero tax type', base({ accountingTaxType: null })],
    ['a type another rate also carries', standard({ ims: { rates: [R_GB, { ...R_IE, accountingTaxType: 'OUTPUT2' }], sales: [sale('2026-09', 'rGB', '100.00'), sale('2026-08', 'rGB', '50.00')] } })],
    ['a type absent from the proven list', base({}, { reportTypes: REPORT_TYPES.filter((t) => t.taxType !== 'OUTPUT2'), store: provenStore(['OUTPUT9', 'MOSS1']) })],
    ['a report type that is not OUTPUT', base({}, { reportTypes: REPORT_TYPES.map((t) => (t.taxType === 'OUTPUT2' ? { ...t, reportTaxType: 'EXEMPTOUTPUT' } : t)) })],
    ['a null report type', base({}, { reportTypes: REPORT_TYPES.map((t) => (t.taxType === 'OUTPUT2' ? { ...t, reportTaxType: null } : t)) })],
    ['a line with no rate at all', standard({ ims: { sales: [sale('2026-09', 'rGB', '100.00'), sale('2026-08', 'rGB', '50.00'), sale('2026-09', null, '1.00')] } })],
    ['a line whose rate IMS does not hold', standard({ ims: { sales: [sale('2026-09', 'rGB', '100.00'), sale('2026-08', 'rGB', '50.00'), sale('2026-09', 'rGONE', '1.00')] } })],
  ]
  for (const [name, s] of cases) {
    const item = await run(s.ctx)
    assert.deepEqual(reasons(item), ['inconclusive', 'VAT_MAPPING_UNVERIFIED'], name)
    assert.equal(s.xero.calls.length, 0, name)
  }
})

test('U8 on the vendor sides: Xero VAT on a type no single IMS rate carries, on an unverified rate, or WooCommerce VAT on an unmapped or unverified rate, is VAT_MAPPING_UNVERIFIED', async () => {
  const xeroUnknown = standard({ xero: [invoice(1, '2026-09-05', [{ type: 'OUTPUT2', tax: 100 }, { type: 'TAX999', tax: 1 }]), invoice(3, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }])] })
  assert.deepEqual(reasons(await run(xeroUnknown.ctx)), ['inconclusive', 'VAT_MAPPING_UNVERIFIED'])
  assert.equal(xeroUnknown.woo.calls.length, 0, 'Xero was decided first; WooCommerce was not read')
  const xeroOss = standard({ xero: [invoice(1, '2026-09-05', [{ type: 'OUTPUT2', tax: 100 }, { type: 'MOSS1', tax: 4 }]), invoice(3, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }])] })
  assert.deepEqual(reasons(await run(xeroOss.ctx)), ['inconclusive', 'VAT_MAPPING_UNVERIFIED'])
  const wooUnmapped = standard({ woo: { processing: [wooOrder(101, '2026-09-10T09:30:00', [[11, '100.00'], [99, '2.00']]), wooOrder(103, '2026-08-12T10:00:00', [[11, '50.00']])] } })
  assert.deepEqual(reasons(await run(wooUnmapped.ctx)), ['inconclusive', 'VAT_MAPPING_UNVERIFIED'])
  const wooOss = standard({ woo: { processing: [wooOrder(101, '2026-09-10T09:30:00', [[11, '100.00'], [13, '2.00']]), wooOrder(103, '2026-08-12T10:00:00', [[11, '50.00']])] } })
  assert.deepEqual(reasons(await run(wooOss.ctx)), ['inconclusive', 'VAT_MAPPING_UNVERIFIED'])
  // A zero line of an unknown type is nothing.
  const zeroUnknown = standard({ xero: [invoice(1, '2026-09-05', [{ type: 'OUTPUT2', tax: 100 }, { type: 'NONE', tax: 0 }]), invoice(2, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }, { type: 'TAX999', tax: 0 }])] })
  assert.deepEqual(reasons(await run(zeroUnknown.ctx)), ['pass'])
})

// [mutation: verification decided on the aggregate / zero lines skipped before the mapping check / Woo lines merged in the reader]
test('NETTING: a +x and a -x line on an UNVERIFIED rate cancel to zero but are still two non-zero lines: VAT_MAPPING_UNVERIFIED in IMS, in Xero and in WooCommerce, with matching verified keys beside them', async () => {
  // IMS: the reader reports the sum (0.00) and counts two non-zero lines.
  const ims = standard({ ims: { sales: [sale('2026-09', 'rGB', '100.00', 3), sale('2026-08', 'rGB', '50.00', 2), sale('2026-09', 'rDE', '0.00', 2, 2)] } })
  assert.deepEqual(reasons(await run(ims.ctx)), ['inconclusive', 'VAT_MAPPING_UNVERIFIED'])
  assert.deepEqual([ims.xero.calls.length, ims.woo.calls.length], [0, 0])
  // An unmapped rate (no rate at all) too.
  const none = standard({ ims: { sales: [sale('2026-09', 'rGB', '100.00', 3), sale('2026-08', 'rGB', '50.00', 2), sale('2026-09', null, '0.00', 2, 2)] } })
  assert.deepEqual(reasons(await run(none.ctx)), ['inconclusive', 'VAT_MAPPING_UNVERIFIED'])
  // Xero: two lines of the OSS type, +4 and -4, in one invoice.
  const xero = standard({ xero: [invoice(1, '2026-09-05', [{ type: 'OUTPUT2', tax: 100 }, { type: 'MOSS1', tax: 4 }, { type: 'MOSS1', tax: -4 }]), invoice(3, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }])] })
  assert.deepEqual(reasons(await run(xero.ctx)), ['inconclusive', 'VAT_MAPPING_UNVERIFIED'])
  // Xero: two unknown-type lines that cancel across two invoices.
  const unknown = standard({ xero: [invoice(1, '2026-09-05', [{ type: 'OUTPUT2', tax: 100 }, { type: 'TAX999', tax: 3 }]), invoice(2, '2026-09-06', [{ type: 'TAX999', tax: -3 }]), invoice(3, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }])] })
  assert.deepEqual(reasons(await run(unknown.ctx)), ['inconclusive', 'VAT_MAPPING_UNVERIFIED'])
  // WooCommerce: +2 and -2 on the OSS rate in ONE order (the reader must not merge them), and on an unmapped rate id.
  const wooOss = standard({ woo: { processing: [wooOrder(101, '2026-09-10T09:30:00', [[11, '100.00'], [13, '2.00'], [13, '-2.00']]), wooOrder(103, '2026-08-12T10:00:00', [[11, '50.00']])] } })
  assert.deepEqual(reasons(await run(wooOss.ctx)), ['inconclusive', 'VAT_MAPPING_UNVERIFIED'])
  const wooUnmapped = standard({ woo: { processing: [wooOrder(101, '2026-09-10T09:30:00', [[11, '100.00'], [99, '2.00'], [99, '-2.00']]), wooOrder(103, '2026-08-12T10:00:00', [[11, '50.00']])] } })
  assert.deepEqual(reasons(await run(wooUnmapped.ctx)), ['inconclusive', 'VAT_MAPPING_UNVERIFIED'])
})

// [mutation: the zero-key drop made one-sided]
test('NETTING of VERIFIED keys is one rule on all three sides: a key that nets to zero from non-zero lines is not a key; against a non-zero value elsewhere it is a finding, against nothing it is equal', async () => {
  // IE nets to zero in IMS (+5, -5) and in Xero (+3, -3): equal, no key. Woo has no IE line.
  const allZero = standard({
    ims: { sales: [sale('2026-09', 'rGB', '100.00', 3), sale('2026-08', 'rGB', '50.00', 2), sale('2026-09', 'rIE', '0.00', 2, 2)] },
    xero: [invoice(1, '2026-09-05', [{ type: 'OUTPUT2', tax: 100 }, { type: 'OUTPUT9', tax: 3 }, { type: 'OUTPUT9', tax: -3 }]), invoice(3, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }])],
  })
  assert.deepEqual(reasons(await run(allZero.ctx)), ['pass'])
  // IE nets to zero in IMS but Xero holds a real +5: the Xero legs see an onlyVendor / onlyIms difference.
  const differ = standard({
    ims: { sales: [sale('2026-09', 'rGB', '100.00', 3), sale('2026-08', 'rGB', '50.00', 2), sale('2026-09', 'rIE', '0.00', 2, 2)] },
    xero: [invoice(1, '2026-09-05', [{ type: 'OUTPUT2', tax: 100 }, { type: 'OUTPUT9', tax: 5 }]), invoice(3, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }])],
  })
  const item = await run(differ.ctx)
  assert.equal(item.outcome, 'fail')
  assert.deepEqual(keys(item, 'onlyVendor'), ['ims-xero|2026-09|IE|domestic'])
  assert.deepEqual(keys(item, 'onlyIms'), ['xero-woo|2026-09|IE|domestic'])
})

test('the stored Xero list must be PROVEN and be the organisation whose report types were read beside it, else VENDOR_LIST_UNPROVEN before any request', async () => {
  const unproven = standard({ ims: { store: { state: 'unproven', cause: 'DIGEST_MISMATCH' } } })
  assert.deepEqual(reasons(await run(unproven.ctx)), ['inconclusive', 'VENDOR_LIST_UNPROVEN'])
  const otherTenant = standard({ ims: { xeroTenantId: 'another-tenant' } })
  assert.deepEqual(reasons(await run(otherTenant.ctx)), ['inconclusive', 'VENDOR_LIST_UNPROVEN'])
  const noTenant = standard({ ims: { xeroTenantId: null, reportTypes: [] } })
  assert.deepEqual(reasons(await run(noTenant.ctx)), ['inconclusive', 'VENDOR_LIST_UNPROVEN'])
  const extraType = standard({ ims: { reportTypes: [...REPORT_TYPES, { taxType: 'SNEAKY', reportTaxType: 'OUTPUT' }] } })
  assert.deepEqual(reasons(await run(extraType.ctx)), ['inconclusive', 'VENDOR_LIST_UNPROVEN'])
  for (const s of [unproven, otherTenant, noTenant, extraType]) assert.deepEqual([s.xero.calls.length, s.woo.calls.length], [0, 0])
})

// ---- currency ------------------------------------------------------------------------------------

// [mutation: the base currency check removed]
test('BASE CURRENCY: an IMS or Xero base currency other than GBP compares nothing', async () => {
  const ims = standard({ ims: { baseCurrency: 'EUR' } })
  assert.deepEqual(reasons(await run(ims.ctx)), ['inconclusive', 'BASE_CURRENCY_NOT_GBP'])
  assert.deepEqual([ims.xero.calls.length, ims.woo.calls.length], [0, 0])
  const xero = standard({ xeroOptions: { baseCurrency: 'EUR' } })
  assert.deepEqual(reasons(await run(xero.ctx)), ['inconclusive', 'BASE_CURRENCY_NOT_GBP'])
  assert.deepEqual([xero.xero.calls.length, xero.woo.calls.length], [1, 0], 'only the organisation read was made')
})

// [mutation: Xero's rate multiplied instead of divided / the Woo rate multiplied instead of divided]
// GOLDEN VALUES CHANGED DELIBERATELY: this arm pinned the inverted reading (Xero CurrencyRate 0.8 GBP per EUR, multiplied). Xero's
// CurrencyRate is foreign per base, the same convention as fxRateToBase (verified on the live organisation, lib/connectors/xero/fx.ts),
// so the Xero side is DIVIDED by it, exactly as the Woo side is divided by fxRateToBase.
test('FX: a foreign Xero invoice is put in GBP by DIVIDING Xero\'s CurrencyRate (1 base = X document-currency, connectors/xero/fx.ts) and a foreign Woo order by DIVIDING the fxRateToBase IMS recorded (1 base = X foreign)', async () => {
  // A realistic EUR order. IMS records fxRateToBase 1.25 (1 GBP = 1.25 EUR); the connector posts Xero CurrencyRate 1.25 as is.
  // EUR 50 of VAT is GBP 40 in all three places.
  const s = standard({
    xero: [
      invoice(1, '2026-09-05', [{ type: 'OUTPUT2', tax: 60 }]),
      invoice(2, '2026-09-20', [{ type: 'OUTPUT2', tax: 50 }], { CurrencyCode: 'EUR', CurrencyRate: 1.25 }),
      invoice(3, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }]),
    ],
    woo: { processing: [wooOrder(101, '2026-09-10T09:30:00', [[11, '60.00']]), wooOrder(102, '2026-09-21T10:00:00', [[11, '50.00']], { currency: 'EUR' }), wooOrder(103, '2026-08-12T10:00:00', [[11, '50.00']])] },
    ims: { wooFx: [{ externalOrderId: '102', currency: 'EUR', fxRateToBase: '1.25' }] },
  })
  assert.deepEqual(reasons(await run(s.ctx)), ['pass'])
  // An inverted rate on the Xero invoice (0.8, GBP per EUR) puts EUR 50 at GBP 62.50, not 40: a finding, never a pass.
  const reversed = standard({ xero: [invoice(1, '2026-09-05', [{ type: 'OUTPUT2', tax: 60 }]), invoice(2, '2026-09-20', [{ type: 'OUTPUT2', tax: 50 }], { CurrencyCode: 'EUR', CurrencyRate: 0.8 }), invoice(3, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }])] })
  const item = await run(reversed.ctx)
  assert.equal(item.outcome, 'fail')
  assert.deepEqual(keys(item, 'bothDiffer').sort(), ['ims-xero|2026-09|GB|domestic', 'xero-woo|2026-09|GB|domestic'])
  const entry = item.entries!.bothDiffer!.find((e) => e.key === 'ims-xero|2026-09|GB|domestic')!
  assert.equal(entry.vendor, '122.5', '60 + 50 / 0.8')
})

test('FX: a foreign Woo order with no linked IMS rate, a different currency, or a non-positive rate is CURRENCY_UNKNOWN; a foreign zero-tax order needs none', async () => {
  const foreign = (fx: Array<{ externalOrderId: string; currency: string; fxRateToBase: string }>) => standard({
    woo: { processing: [wooOrder(101, '2026-09-10T09:30:00', [[11, '100.00']]), wooOrder(102, '2026-09-21T10:00:00', [[11, '4.00']], { currency: 'EUR' }), wooOrder(103, '2026-08-12T10:00:00', [[11, '50.00']])] },
    ims: { wooFx: fx },
  })
  for (const fx of [[], [{ externalOrderId: '102', currency: 'USD', fxRateToBase: '1.2' }], [{ externalOrderId: '102', currency: 'EUR', fxRateToBase: '0' }], [{ externalOrderId: '999', currency: 'EUR', fxRateToBase: '1.2' }]]) {
    assert.deepEqual(reasons(await run(foreign(fx).ctx)), ['inconclusive', 'CURRENCY_UNKNOWN'])
  }
  const zero = standard({ woo: { processing: [wooOrder(101, '2026-09-10T09:30:00', [[11, '100.00']]), wooOrder(102, '2026-09-21T10:00:00', [[11, '0.00']], { currency: 'EUR' }), wooOrder(103, '2026-08-12T10:00:00', [[11, '50.00']])] } })
  assert.deepEqual(reasons(await run(zero.ctx)), ['pass'])
})

// ---- shipping ----------------------------------------------------------------------------------------

// [mutation: the shipping-account cut removed]
test('SHIPPING VAT IS OUT: Xero lines on the configured shipping account are not counted, and WooCommerce\'s shipping tax and fee_lines are read only as a fee-tax check', async () => {
  const s = standard({
    ims: { shippingAccount: '260' },
    xero: [invoice(1, '2026-09-05', [{ type: 'OUTPUT2', tax: 60 }, { type: 'OUTPUT2', tax: 1.5, account: '260' }]), invoice(2, '2026-09-20', [{ type: 'OUTPUT2', tax: 40, account: '200' }]), invoice(3, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }])],
  })
  assert.deepEqual(reasons(await run(s.ctx)), ['pass'])
  assert.ok(s.woo.calls.every((c) => c.params._fields === 'id,status,currency,date_created_gmt,total_tax,tax_lines,fee_lines'))
  // The standard double puts 99.00 of SHIPPING tax on every Woo tax line: counting it would have failed the pass above.
})

// [mutation: the shipping-account guard removed / loosened]
test('SHIPPING MUST BE RELIABLY SEPARATED: an unconfigured shipping account, one missing from the chart, or one shared with the sales or discount account cannot pass, and nothing is requested', async () => {
  // The regression: IMS and Woo hold 100.00 of product VAT; Xero holds 99.00 of product VAT and 1.00 of SHIPPING VAT. With no shipping account
  // the shipping line is counted, every leg reads 100.00, and the old code passed although the in-scope Xero figure is 99.00.
  const xero = [invoice(1, '2026-09-05', [{ type: 'OUTPUT2', tax: 59 }, { type: 'OUTPUT2', tax: 1, account: '260' }]), invoice(2, '2026-09-20', [{ type: 'OUTPUT2', tax: 40 }]), invoice(3, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }])]
  const cases: Array<[string, ImsFixture]> = [
    ['unconfigured', { shippingAccount: '' }],
    ['not in the chart', { shippingAccountInChart: false }],
    ['the sales account', { shippingAccount: '200' }],
    ['the discount account', { discountAccount: '260' }],
  ]
  for (const [name, ims] of cases) {
    const s = standard({ ims, xero })
    const item = await run(s.ctx)
    assert.deepEqual(reasons(item), ['inconclusive', 'VAT_MAPPING_UNVERIFIED'], name)
    assert.deepEqual([s.xero.calls.length, s.woo.calls.length], [0, 0], `${name}: decided before any request`)
  }
  // Properly separated, the same data is a FAILURE: Xero's in-scope figure is 99.00 against 100.00.
  const separated = await run(standard({ xero }).ctx)
  assert.equal(separated.outcome, 'fail')
  assert.deepEqual(keys(separated, 'bothDiffer').sort(), ['ims-xero|2026-09|GB|domestic', 'xero-woo|2026-09|GB|domestic'])
})

// [mutation: an uncoded or unrecognised taxable line counted / the sales-account requirement removed]
test('A TAXABLE XERO LINE COUNTS ONLY WITH A PROVEN CLASSIFICATION: no account code or an unrecognised account is VAT_MAPPING_UNVERIFIED (whatever it nets to); zero-tax uncoded lines are harmless; sales, discount and shipping accounts are classified', async () => {
  // The regression: IMS and Woo hold 100.00; Xero holds 99.00 of product VAT and 1.00 of UNCODED (really shipping) VAT. Counted, every leg read 100.00.
  const regression = standard({ xero: [invoice(1, '2026-09-05', [{ type: 'OUTPUT2', tax: 59 }, { type: 'OUTPUT2', tax: 1, account: null }]), invoice(2, '2026-09-20', [{ type: 'OUTPUT2', tax: 40 }]), invoice(3, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }])] })
  assert.deepEqual(reasons(await run(regression.ctx)), ['inconclusive', 'VAT_MAPPING_UNVERIFIED'])
  // Uncoded +1 and -1 that net to zero are still two unclassified taxable lines.
  const netting = standard({ xero: [invoice(1, '2026-09-05', [{ type: 'OUTPUT2', tax: 60 }, { type: 'OUTPUT2', tax: 1, account: null }, { type: 'OUTPUT2', tax: -1, account: null }]), invoice(2, '2026-09-20', [{ type: 'OUTPUT2', tax: 40 }]), invoice(3, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }])] })
  assert.deepEqual(reasons(await run(netting.ctx)), ['inconclusive', 'VAT_MAPPING_UNVERIFIED'])
  // An unrecognised account.
  const unknown = standard({ xero: [invoice(1, '2026-09-05', [{ type: 'OUTPUT2', tax: 60 }, { type: 'OUTPUT2', tax: 0.5, account: '999' }]), invoice(2, '2026-09-20', [{ type: 'OUTPUT2', tax: 40 }]), invoice(3, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }])] })
  assert.deepEqual(reasons(await run(unknown.ctx)), ['inconclusive', 'VAT_MAPPING_UNVERIFIED'])
  // A zero-tax uncoded line and a zero-tax line on an unknown account are harmless; a discount-account line counts.
  const harmless = standard({ ims: { discountAccount: '270' }, xero: [invoice(1, '2026-09-05', [{ type: 'OUTPUT2', tax: 70 }, { type: 'NONE', tax: 0, account: null }, { type: 'NONE', tax: 0, account: '999' }, { type: 'OUTPUT2', tax: -10, account: '270' }]), invoice(2, '2026-09-20', [{ type: 'OUTPUT2', tax: 40 }]), invoice(3, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }])] })
  assert.deepEqual(reasons(await run(harmless.ctx)), ['pass'])
  // With no discount account configured, a taxable line on any other account is unrecognised.
  const noDiscount = standard({ xero: [invoice(1, '2026-09-05', [{ type: 'OUTPUT2', tax: 60 }, { type: 'OUTPUT2', tax: 1, account: '270' }]), invoice(2, '2026-09-20', [{ type: 'OUTPUT2', tax: 40 }]), invoice(3, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }])] })
  assert.deepEqual(reasons(await run(noDiscount.ctx)), ['inconclusive', 'VAT_MAPPING_UNVERIFIED'])
  // The sales account must be configured (before any request).
  const noSales = standard({ ims: { salesAccount: '' } })
  assert.deepEqual(reasons(await run(noSales.ctx)), ['inconclusive', 'VAT_MAPPING_UNVERIFIED'])
  assert.deepEqual([noSales.xero.calls.length, noSales.woo.calls.length], [0, 0])
})

// [mutation: the Xero or WooCommerce reconciliation of an order against its own total removed]
test('A MISSING VAT AMOUNT CANNOT HIDE: a Xero invoice with TotalTax 20 and no lines, or a store order whose tax lines do not add up to its total_tax, makes the item unreadable, never a pass', async () => {
  const xero = standard({ xero: [invoice(1, '2026-09-05', [{ type: 'OUTPUT2', tax: 60 }]), invoice(2, '2026-09-20', [{ type: 'OUTPUT2', tax: 40 }]), invoice(4, '2026-09-25', [], { TotalTax: 20, SubTotal: 0, Total: 20 }), invoice(3, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }])] })
  assert.deepEqual(reasons(await run(xero.ctx)), ['inconclusive', 'SOURCE_UNREADABLE'])
  assert.equal(xero.woo.calls.length, 0)
  // Woo: an order reports total_tax 20 more than its tax lines (a line was dropped) - and one whose tax lines exceed it.
  for (const extra of ['20.00', '-20.00']) {
    const woo = standard({ woo: { processing: [wooOrder(101, '2026-09-10T09:30:00', [[11, '100.00']], { total_tax: (Number(wooTotalTax([[11, '100.00']])) + Number(extra)).toFixed(2) }), wooOrder(103, '2026-08-12T10:00:00', [[11, '50.00']])] } })
    assert.deepEqual(reasons(await run(woo.ctx)), ['inconclusive', 'SOURCE_UNREADABLE'], extra)
  }
})

// [mutation: the line-amount reconciliation removed]
test('OFFSETTING OMITTED LINES: Xero drops a +10 line on a verified rate and a -10 line on an unverified rate; the tax total still agrees but the amounts do not, so the item is unreadable and cannot pass', async () => {
  const dropped = invoice(1, '2026-09-05', [{ type: 'OUTPUT2', tax: 60 }], { TotalTax: 60, SubTotal: 150, Total: 210 })
  const s = standard({ xero: [dropped, invoice(2, '2026-09-20', [{ type: 'OUTPUT2', tax: 40 }]), invoice(3, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }])] })
  assert.deepEqual(reasons(await run(s.ctx)), ['inconclusive', 'SOURCE_UNREADABLE'])
  assert.equal(s.woo.calls.length, 0)
})

// [mutation: the fee-line tax check removed]
test('FEE-LINE TAX is not proven to be counted alike: a WooCommerce order with a non-zero fee-line tax in a closed month is VAT_MAPPING_UNVERIFIED; zero fee tax and orders outside the months are not', async () => {
  const fee = (total: string) => ({ fee_lines: [{ total_tax: total }] })
  const withFee = (created: string, total: string) => standard({ woo: { processing: [wooOrder(101, '2026-09-10T09:30:00', [[11, '100.00']], created === 'in' ? fee(total) : {}), wooOrder(103, '2026-08-12T10:00:00', [[11, '50.00']]), ...(created === 'out' ? [wooOrder(104, '2026-10-02T10:00:00', [[11, '1.00']], fee(total))] : [])] } })
  assert.deepEqual(reasons(await run(withFee('in', '1.50').ctx)), ['inconclusive', 'VAT_MAPPING_UNVERIFIED'])
  assert.deepEqual(reasons(await run(withFee('in', '-0.40').ctx)), ['inconclusive', 'VAT_MAPPING_UNVERIFIED'])
  assert.deepEqual(reasons(await run(withFee('in', '0.00').ctx)), ['pass'])
  assert.deepEqual(reasons(await run(withFee('out', '2.00').ctx)), ['pass'], 'October is not a closed month')
})

// ---- the order discount booked under the per-rate split ---------------------------------------------------

/** One entry of a stored SalesOrder.discountTaxSplit as the write model builds it (GBP, so base = foreign): the discount's NET on a rate and its VAT at 4dp. */
const entryOf = (taxRateId: string | null, rate: number, net: number, accountingTaxType: string | null = null) => ({ taxRateId, accountingTaxType, reverseCharge: false, rate, netForeign: net, taxForeign: Math.round(net * rate * 1e4) / 1e4, netBase: net, taxBase: Math.round(net * rate * 1e4) / 1e4 })
const splitJson = (entries: Array<{ taxRateId: string | null; rate: number; net: number }>) => JSON.stringify(entries.map((e) => entryOf(e.taxRateId, e.rate, e.net)))
/** September: GBP 100.00 of GB line VAT and 20.00 of IE line VAT before the discount; the order discount of 26.00 is GB net 20.00 (VAT 4.00) and IE net 6.00 (VAT 1.38), posted to Xero as two parts on the discount account. */
function discounted(splits: NonNullable<ImsFixture['discountSplits']>, xeroDiscount: Array<{ type: string; tax: number }> = [{ type: 'OUTPUT2', tax: -4 }, { type: 'OUTPUT9', tax: -1.38 }]) {
  return standard({
    ims: { sales: [sale('2026-09', 'rGB', '100.00', 3), sale('2026-09', 'rIE', '20.00', 1), sale('2026-08', 'rGB', '50.00', 2)], discountAccount: '270', discountSplits: splits },
    xero: [
      invoice(1, '2026-09-05', [{ type: 'OUTPUT2', tax: 60 }, { type: 'OUTPUT9', tax: 20 }, ...xeroDiscount.map((d) => ({ ...d, account: '270' }))]),
      invoice(2, '2026-09-20', [{ type: 'OUTPUT2', tax: 40 }]),
      invoice(3, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }]),
    ],
    woo: { processing: [wooOrder(101, '2026-09-10T09:30:00', [[11, '56.00'], [12, '18.62']]), wooOrder(102, '2026-09-21T10:00:00', [[11, '40.00']]), wooOrder(103, '2026-08-12T10:00:00', [[11, '50.00']])] },
  })
}
const SPLIT = splitJson([{ taxRateId: 'rGB', rate: 0.2, net: 20 }, { taxRateId: 'rIE', rate: 0.23, net: 6 }, { taxRateId: null, rate: 0, net: 0 }])

// [mutation: the discount-split loop removed / its sign flipped / the share placed by the header rate]
test('AN ORDER BOOKED UNDER THE PER-RATE DISCOUNT SPLIT: each part\'s VAT comes off its own rate on the IMS side, matching the per-code discount parts Xero holds; a no-rate 0% group is harmless', async () => {
  const item = await run(discounted([{ period: '2026-09', orderId: 'so-1', discount: '26.0000', split: SPLIT }]).ctx)
  assert.deepEqual(reasons(item), ['pass'])
  assert.ok(keys(item, 'bothEqual').includes('ims-xero|2026-09|IE|domestic'))
  // Without the split (the header-rate treatment) the IMS side carries no discount VAT, so the same ledger is a difference on both rates.
  const header = await run(discounted([]).ctx)
  assert.equal(header.outcome, 'fail')
  assert.deepEqual(keys(header, 'bothDiffer').filter((k) => k.startsWith('ims-xero')).sort(), ['ims-xero|2026-09|GB|domestic', 'ims-xero|2026-09|IE|domestic'])
  // Every part is placed by its own rate: put all of it on GB and both keys differ.
  const misplaced = await run(discounted([{ period: '2026-09', orderId: 'so-1', discount: '26.0000', split: splitJson([{ taxRateId: 'rGB', rate: 0.2, net: 26 }]) }]).ctx)
  assert.deepEqual(keys(misplaced, 'bothDiffer').filter((k) => k.startsWith('ims-xero')).sort(), ['ims-xero|2026-09|GB|domestic', 'ims-xero|2026-09|IE|domestic'])
})

test('THE SPLIT IS READ AS THE INVOICE READS IT: an unreadable split, a discount that rounds to no penny, or a month outside the window is the header-rate treatment (nothing taken off); a part with VAT on an unverified rate is VAT_MAPPING_UNVERIFIED; a bad discount, rate or non-adding split is BAD_VALUE', async () => {
  // Xero holds the single header-rate treatment (no parts), so "nothing taken off" is exactly the item of the same estate with no split row at all.
  const asHeader = async (splits: NonNullable<ImsFixture['discountSplits']>, label: string) => {
    assert.deepEqual(await run(discounted(splits, []).ctx), await run(discounted([], []).ctx), label)
  }
  for (const split of ['not json', JSON.stringify([{ taxRateId: 'rGB' }]), JSON.stringify([]), JSON.stringify({ taxRateId: 'rGB' })]) await asHeader([{ period: '2026-09', orderId: 'so-1', discount: '26.0000', split }], split)
  await asHeader([{ period: '2026-09', orderId: 'so-1', discount: '0.0049', split: SPLIT }], 'a discount that rounds to no penny posts no parts')
  await asHeader([{ period: '2026-10', orderId: 'so-1', discount: '26.0000', split: SPLIT }], 'October is not a closed month')
  // And the control: a readable split in the window DOES change the item.
  assert.notDeepEqual(await run(discounted([{ period: '2026-09', orderId: 'so-1', discount: '26.0000', split: SPLIT }], []).ctx), await run(discounted([], []).ctx))
  const oss = await run(discounted([{ period: '2026-09', orderId: 'so-1', discount: '31.0000', split: splitJson([{ taxRateId: 'rGB', rate: 0.2, net: 20 }, { taxRateId: 'rIE', rate: 0.23, net: 6 }, { taxRateId: 'rDE', rate: 0.19, net: 5 }]) }]).ctx)
  assert.deepEqual(reasons(oss), ['inconclusive', 'VAT_MAPPING_UNVERIFIED'])
  const zeroElsewhere = await run(discounted([{ period: '2026-09', orderId: 'so-1', discount: '31.0000', split: splitJson([{ taxRateId: 'rGB', rate: 0.2, net: 20 }, { taxRateId: 'rIE', rate: 0.23, net: 6 }, { taxRateId: 'rDE', rate: 0, net: 5 }]) }]).ctx)
  assert.deepEqual(reasons(zeroElsewhere), ['pass'])
  assert.deepEqual(reasons(await run(discounted([{ period: '2026-09', orderId: 'so-1', discount: 'x', split: SPLIT }]).ctx)), ['inconclusive', 'BAD_VALUE'])
  assert.deepEqual(reasons(await run(discounted([{ period: '2026-09', orderId: 'so-1', discount: '26.0000', split: SPLIT, fxRateToBase: '0' }]).ctx)), ['inconclusive', 'BAD_VALUE'], 'no usable order rate')
  assert.deepEqual(reasons(await run(discounted([{ period: '2026-09', orderId: 'so-1', discount: '40.0000', split: SPLIT }]).ctx)), ['inconclusive', 'BAD_VALUE'], 'a split 14 short of the discount: the invoice would refuse it, so no invoice exists to compare')
})

// [mutation: the LOW-8 skip follows the per-entry figures instead of the merged parts]
test('A PART THE INVOICE POSTS NO LINE FOR (its merged amount rounds to no positive penny) is not taken off: a tiny share on an unverified rate is harmless, a real one is VAT_MAPPING_UNVERIFIED; entries on one code are judged MERGED, as the invoice posts them', async () => {
  const withDe = (net: number) => splitJson([{ taxRateId: 'rGB', rate: 0.2, net: 20 }, { taxRateId: 'rIE', rate: 0.23, net: 6 }, { taxRateId: 'rDE', rate: 0.19, net }])
  // 0.004 net rounds to 0.00: invoiceDiscountParts drops it and Xero holds no such discount line.
  assert.deepEqual(reasons(await run(discounted([{ period: '2026-09', orderId: 'so-1', discount: '26.0000', split: withDe(0.004) }]).ctx)), ['pass'])
  // 0.10 net is a part the invoice posts, with VAT 0.02 on a rate R12 cannot place.
  assert.deepEqual(reasons(await run(discounted([{ period: '2026-09', orderId: 'so-1', discount: '26.1000', split: withDe(0.1) }]).ctx)), ['inconclusive', 'VAT_MAPPING_UNVERIFIED'])
  // Three entries on ONE verified code (19.996, 0.004, 0.004) post as ONE part of 20.00, the way the invoice merges them: the item is judged on the merged part, not on each entry.
  const merged = JSON.stringify([entryOf('rGB', 0.2, 19.996), entryOf('rGB', 0.2, 0.004), entryOf('rGB', 0.2, 0.004), entryOf('rIE', 0.23, 6)])
  assert.deepEqual(reasons(await run(discounted([{ period: '2026-09', orderId: 'so-1', discount: '26.0000', split: merged }]).ctx)), ['pass'])
})

// [mutation: the VAT-inclusive basis ignored / the order's rate ignored]
test('THE BASES: VAT-inclusive lines take the part\'s VAT OUT of its gross amount at 2dp, and a foreign order is put in base by its own rate, exactly as Xero\'s document is', async () => {
  // Inclusive GBP: the discount parts are gross (net + VAT): GB 24.00 (20.00 + 4.00) and IE 7.38 (6.00 + 1.38), 31.38 in all; Xero takes 24.00 x 0.2 / 1.2 = 4.00 and 7.38 x 0.23 / 1.23 = 1.38.
  const inclusive = await run(discounted([{ period: '2026-09', orderId: 'so-1', discount: '31.3800', split: SPLIT, amountsIncludeVat: true }]).ctx)
  assert.deepEqual(reasons(inclusive), ['pass'])
  // Foreign (EUR at 1.25 = 1 GBP): the split holds EUR, Xero's lines are EUR and its document is divided by its CurrencyRate; the same GBP VAT is taken off.
  const eur = JSON.stringify([{ ...entryOf('rGB', 0.2, 25), netBase: 20, taxBase: 4 }, { ...entryOf('rIE', 0.23, 7.5), netBase: 6, taxBase: 1.38 }])
  const foreignEstate = standard({
    ims: { sales: [sale('2026-09', 'rGB', '100.00', 3), sale('2026-09', 'rIE', '20.00', 1), sale('2026-08', 'rGB', '50.00', 2)], discountAccount: '270', discountSplits: [{ period: '2026-09', orderId: 'so-1', discount: '32.5000', split: eur, fxRateToBase: '1.25000000' }] },
    xero: [
      invoice(1, '2026-09-05', [{ type: 'OUTPUT2', tax: 75 }, { type: 'OUTPUT9', tax: 25 }, { type: 'OUTPUT2', tax: -5, account: '270' }, { type: 'OUTPUT9', tax: -1.73, account: '270' }], { CurrencyCode: 'EUR', CurrencyRate: 1.25 }),
      invoice(2, '2026-09-20', [{ type: 'OUTPUT2', tax: 40 }]),
      invoice(3, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }]),
    ],
    woo: { processing: [wooOrder(101, '2026-09-10T09:30:00', [[11, '56.00'], [12, '18.62']]), wooOrder(102, '2026-09-21T10:00:00', [[11, '40.00']]), wooOrder(103, '2026-08-12T10:00:00', [[11, '50.00']])] },
  })
  const item = await run(foreignEstate.ctx)
  // EUR 5.00 / 1.25 = GBP 4.00 on GB; the IE part is EUR 7.50 x 23% = 1.725, which Xero rounds to 1.73 (GBP 1.384), the same figure IMS takes off.
  assert.ok(keys(item, 'bothEqual').includes('ims-xero|2026-09|GB|domestic'), JSON.stringify(item))
  assert.ok(!keys(item, 'bothDiffer').some((k) => k.startsWith('ims-xero')), JSON.stringify(item))
})

test('END TO END FROM THE INVOICE PARTS: a split built by the write model, posted as invoiceDiscountParts with Xero working out each part\'s VAT at 2dp, reconciles on R12 with no rounding residue (the IMS side prices the parts the same way)', async () => {
  // A 26.00 discount over GB goods at 20% and IE goods at 23%, shares 17.3333 and 8.6667 (the write model's allocation), GBP, exclusive.
  const split = buildDiscountTaxSplit({
    lines: [{ taxRateId: 'rGB', accountingTaxType: 'OUTPUT2', reverseCharge: false, rate: 0.2 }, { taxRateId: 'rIE', accountingTaxType: 'OUTPUT9', reverseCharge: false, rate: 0.23 }],
    shares: ['17.3333', '8.6667'], fxRate: 1, totalNetForeign: 26, totalTaxForeign: 5.46, totalNetBase: 26, totalTaxBase: 5.46,
  })
  const parts = invoiceDiscountParts({ split, lineAmountsIncludeTax: false, totalAmount: 26, taxTypeOf: (e) => e.accountingTaxType })!
  assert.deepEqual(parts.map((p) => [p.taxType, p.amount]), [['OUTPUT2', 17.33], ['OUTPUT9', 8.67]])
  // Xero prices each exclusive discount line itself, rounded to the penny: 3.466 -> 3.47 and 1.9941 -> 1.99 (IMS holds 3.4667 and 1.9933).
  const xeroDiscount = parts.map((p) => ({ type: p.taxType!, tax: -Number((Math.round(p.amount * (p.taxType === 'OUTPUT2' ? 20 : 23)) / 100).toFixed(2)) }))
  assert.deepEqual(xeroDiscount.map((d) => d.tax), [-3.47, -1.99])
  // The estate: the sale rows stay 100.00 / 20.00 of goods VAT, Xero holds the discount lines above, WooCommerce reports the net of them (60 - 3.47 = 56.53, 20 - 1.99 = 18.01).
  const item = await standard({
    ims: { sales: [sale('2026-09', 'rGB', '100.00', 3), sale('2026-09', 'rIE', '20.00', 1), sale('2026-08', 'rGB', '50.00', 2)], discountAccount: '270', discountSplits: [{ period: '2026-09', orderId: 'so-1', discount: '26.0000', split: JSON.stringify(split) }] },
    xero: [
      invoice(1, '2026-09-05', [{ type: 'OUTPUT2', tax: 60 }, { type: 'OUTPUT9', tax: 20 }, ...xeroDiscount.map((d) => ({ ...d, account: '270' }))]),
      invoice(2, '2026-09-20', [{ type: 'OUTPUT2', tax: 40 }]),
      invoice(3, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }]),
    ],
    woo: { processing: [wooOrder(101, '2026-09-10T09:30:00', [[11, '56.53'], [12, '18.01']]), wooOrder(102, '2026-09-21T10:00:00', [[11, '40.00']]), wooOrder(103, '2026-08-12T10:00:00', [[11, '50.00']])] },
  }).ctx
  const result = await run(item)
  assert.deepEqual(reasons(result), ['pass'], JSON.stringify(result))
  assert.ok(keys(result, 'bothEqual').includes('ims-xero|2026-09|GB|domestic'), JSON.stringify(result))
  assert.ok(keys(result, 'bothEqual').includes('ims-xero|2026-09|IE|domestic'), JSON.stringify(result))
})

// [mutation: the IMS side back on the 4dp taxBase of the split]
test('MANY SPLIT ORDERS ON ONE KEY STAY INSIDE THE TOLERANCE: 200 orders of the same 26.00 discount in one month, each priced as Xero prices it, leave no residue (the 4dp taxBase would be GBP 0.66 out on GB alone)', async () => {
  const N = 200
  const split = buildDiscountTaxSplit({
    lines: [{ taxRateId: 'rGB', accountingTaxType: 'OUTPUT2', reverseCharge: false, rate: 0.2 }, { taxRateId: 'rIE', accountingTaxType: 'OUTPUT9', reverseCharge: false, rate: 0.23 }],
    shares: ['17.3333', '8.6667'], fxRate: 1, totalNetForeign: 26, totalTaxForeign: 5.46, totalNetBase: 26, totalTaxBase: 5.46,
  })
  // What the old IMS side would have taken off these N orders against what Xero holds (3.47 + 1.99 per order): the drift this fix removes.
  const oldGb = split[0]!.taxBase * N
  assert.ok(Math.abs(oldGb - N * 3.47) > 0.05, `the 4dp figures drift ${Math.abs(oldGb - N * 3.47).toFixed(4)} on GB over ${N} orders, which is the failure being fixed`)
  const rows = Array.from({ length: N }, (_, i) => ({ period: '2026-09', orderId: `so-${i}`, discount: '26.0000', split: JSON.stringify(split) }))
  const invoices = Array.from({ length: N }, (_, i) => invoice(i + 1, '2026-09-05', [{ type: 'OUTPUT2', tax: 20 }, { type: 'OUTPUT9', tax: 5 }, { type: 'OUTPUT2', tax: -3.47, account: '270' }, { type: 'OUTPUT9', tax: -1.99, account: '270' }]))
  // IMS goods VAT: GB 20.00 and IE 5.00 per order. WooCommerce reports the net of the discount, summed over the month in one order (its legs are not under test).
  const gb = (N * (20 - 3.47)).toFixed(2)
  const ie = (N * (5 - 1.99)).toFixed(2)
  const s = standard({
    ims: { sales: [sale('2026-09', 'rGB', (N * 20).toFixed(2), N), sale('2026-09', 'rIE', (N * 5).toFixed(2), N), sale('2026-08', 'rGB', '50.00', 2)], discountAccount: '270', discountSplits: rows },
    xero: [...invoices, invoice(N + 1, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }])],
    woo: { processing: [wooOrder(101, '2026-09-10T09:30:00', [[11, gb], [12, ie]]), wooOrder(103, '2026-08-12T10:00:00', [[11, '50.00']])] },
  })
  const item = await run(s.ctx)
  assert.deepEqual(reasons(item), ['pass'], JSON.stringify(item))
  assert.ok(keys(item, 'bothEqual').includes('ims-xero|2026-09|GB|domestic'))
})

// ---- empty ----------------------------------------------------------------------------------------------

test('NOTHING COMPARED passes only on the named proof (both vendors reported nothing at all), else EMPTY_UNPROVEN', async () => {
  const empty = standard({ ims: { sales: [] }, xero: [], woo: { processing: [] } })
  const item = await run(empty.ctx)
  assert.deepEqual(reasons(item), ['pass'])
  assert.deepEqual(item.proof, { kind: 'proven-empty', source: 'vendor-total-zero' })
  // Invoices exist but carry no VAT: nothing was compared and nothing proves empty is the whole truth.
  const zeroOnly = standard({ ims: { sales: [sale('2026-09', 'rGB', '0.00')] }, xero: [invoice(1, '2026-09-05', [{ type: 'OUTPUT2', tax: 0 }])], woo: { processing: [] } })
  assert.deepEqual(reasons(await run(zeroOnly.ctx)), ['inconclusive', 'EMPTY_UNPROVEN'])
  // Xero holds an invoice (with no VAT) and nothing else holds anything: Xero's total is not zero, so the empty proof is not named.
  const xeroHasInvoices = standard({ ims: { sales: [] }, xero: [invoice(1, '2026-09-05', [{ type: 'OUTPUT2', tax: 0 }])], woo: { processing: [] } })
  assert.deepEqual(reasons(await run(xeroHasInvoices.ctx)), ['inconclusive', 'EMPTY_UNPROVEN'])
  // WooCommerce holds an order (with no VAT) and nothing else holds anything.
  const wooHasOrders = standard({ ims: { sales: [] }, xero: [], woo: { processing: [wooOrder(101, '2026-09-10T09:30:00', [[11, '0.00']])] } })
  assert.deepEqual(reasons(await run(wooHasOrders.ctx)), ['inconclusive', 'EMPTY_UNPROVEN'])
  // IMS has VAT the vendors lack: not empty, a finding.
  const imsOnly = standard({ xero: [], woo: { processing: [] } })
  assert.deepEqual(reasons(await run(imsOnly.ctx)), ['fail', 'DIFFERENCES'])
})

// ---- the Xero connection ----------------------------------------------------------------------------------

// [mutation: the binding checks removed or compared with the wrong field]
test('XERO_CONNECTION_UNUSABLE: no binding, another organisation than the proven list, a connection that changed during the walk, or a first request that finds no usable token', async () => {
  const mk = (b: () => Promise<{ tenantId: string; connectionGeneration: string | null } | null>) => { const s = standard(); return { s, ctx: { ...s.ctx, vendor: { woo: s.woo, xero: { port: s.xero, binding: b } } } } }
  const noBinding = mk(async () => null)
  assert.deepEqual(reasons(await run(noBinding.ctx)), ['inconclusive', 'XERO_CONNECTION_UNUSABLE'])
  assert.equal(noBinding.s.xero.calls.length, 0)
  const wrongTenant = mk(binding({ tenantId: 'someone-else' }))
  assert.deepEqual(reasons(await run(wrongTenant.ctx)), ['inconclusive', 'XERO_CONNECTION_UNUSABLE'])
  assert.equal(wrongTenant.s.xero.calls.length, 0)
  for (const moved of [{ tenantId: 'someone-else' }, { connectionGeneration: 'gen-2' }, { connectionGeneration: null }]) {
    let n = 0
    const changing = mk(async () => ({ tenantId: TENANT, connectionGeneration: 'gen-1', ...(++n >= 2 ? moved : {}) }))
    assert.deepEqual(reasons(await run(changing.ctx)), ['inconclusive', 'XERO_CONNECTION_UNUSABLE'], JSON.stringify(moved))
    assert.equal(changing.s.woo.calls.length, 0, 'a moved connection is decided before WooCommerce is read')
  }
  let ended = 0
  const vanishing = mk(async () => (++ended >= 2 ? null : { tenantId: TENANT, connectionGeneration: 'gen-1' }))
  assert.deepEqual(reasons(await run(vanishing.ctx)), ['inconclusive', 'XERO_CONNECTION_UNUSABLE'])
  const s = standard()
  const noToken = { ...s.ctx, vendor: { woo: s.woo, xero: { port: { get: async () => ({ ok: false as const }) }, binding: binding() } } }
  assert.deepEqual(reasons(await run(noToken)), ['inconclusive', 'XERO_CONNECTION_UNUSABLE'])
})

// ---- budget and completeness (through the item) ----------------------------------------------------

// [mutation: the budget check removed / the cap turned into a shorter list]
test('BUDGET: a Xero walk that would exceed the request budget is CAP_EXCEEDED and no figure at all; so is a Woo walk', async () => {
  for (const budget of [1, 2]) {
    const s = standard({ context: { xeroOptions: { sleep: noSleep, budget } } })
    const item = await run(s.ctx)
    assert.deepEqual(reasons(item), ['inconclusive', 'CAP_EXCEEDED'], String(budget))
    assert.equal(item.entries, undefined)
    assert.ok(s.xero.calls.length <= budget, `never more than ${budget} requests`)
    assert.equal(s.woo.calls.length, 0)
  }
  // The exact need: the organisation, then two sweeps of one page each.
  const exact = standard({ context: { xeroOptions: { sleep: noSleep, budget: 3 } }, xero: [invoice(1, '2026-09-05', [{ type: 'OUTPUT2', tax: 100 }]), invoice(3, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }])] })
  assert.deepEqual(reasons(await run(exact.ctx)), ['pass'])
  assert.equal(exact.xero.calls.length, 3)
  const wooCap = standard({ context: { wooOptions: { sleep: noSleep, budget: 2 } } })
  assert.deepEqual(reasons(await run(wooCap.ctx)), ['inconclusive', 'CAP_EXCEEDED'])
  // The walk cap on the reported item count.
  const big = standard({ context: { xeroOptions: { sleep: noSleep, maxRows: 2 } } })
  assert.deepEqual(reasons(await run(big.ctx)), ['inconclusive', 'CAP_EXCEEDED'])
})

test('PACING: a pause before every request after the first, both vendors', async () => {
  const slept: number[] = []
  const s = standard({ context: { xeroOptions: { sleep: async (ms) => { slept.push(ms) } }, wooOptions: { sleep: async (ms) => { slept.push(ms) } } } })
  assert.equal((await run(s.ctx)).outcome, 'pass')
  const requests = s.xero.calls.length + s.woo.calls.length
  assert.equal(slept.length, (s.xero.calls.length - 1) + (s.woo.calls.length - 1))
  assert.ok(requests > 6 && slept.filter((ms) => ms === 2000).length === s.xero.calls.length - 1)
})

test('a multi-page Xero walk (page size 2 over five invoices) and a multi-page Woo walk are read in full and agree', async () => {
  const invoices = [1, 2, 3, 4, 5].map((n) => invoice(n, '2026-09-10', [{ type: 'OUTPUT2', tax: 20 }]))
  const s = standard({
    xero: [...invoices, invoice(9, '2026-08-11', [{ type: 'OUTPUT2', tax: 50 }])], xeroOptions: { pageSize: 2 },
    woo: { processing: [1, 2, 3, 4, 5].map((n) => wooOrder(100 + n, '2026-09-10T09:30:00', [[11, '20.00']])).concat([wooOrder(109, '2026-08-12T10:00:00', [[11, '50.00']])]) },
    context: { wooOptions: { sleep: noSleep, perPage: 4 } },
  })
  assert.deepEqual(reasons(await run(s.ctx)), ['pass'])
  assert.equal(s.xero.calls.filter((c) => c.resource === 'Invoices').length, 2 * 3, 'three pages, read twice')
})

test('every Xero request is the organisation (no parameter) or the invoice list with exactly where, Statuses and page', async () => {
  const s = standard()
  await run(s.ctx)
  for (const call of s.xero.calls) {
    if (call.resource === 'Organisation') assert.deepEqual(call.params, {})
    else assert.deepEqual(Object.keys(call.params).sort(), ['Statuses', 'page', 'where'])
  }
  assert.ok(s.xero.calls.every((c) => c.resource === 'Organisation' || c.params.Statuses === 'AUTHORISED,PAID'))
})

// ---- totality -----------------------------------------------------------------------------------------------

test('the module is total: an IMS read that fails, a section that fails, a throw anywhere, or a bad cycle date is an inconclusive item, never a throw', async () => {
  const failing = standard({ ims: { fail: 'read' } })
  assert.deepEqual(reasons(await run(failing.ctx)), ['inconclusive', 'READ_INCOMPLETE'])
  for (const section of ['boundaries', 'taxes', 'xeroTaxRates', 'vat'] as const) {
    const s = standard({ ims: { fail: { section, reason: 'CAP_EXCEEDED' } } })
    assert.deepEqual(reasons(await run(s.ctx)), ['inconclusive', 'CAP_EXCEEDED'], section)
    assert.equal(s.xero.calls.length, 0)
  }
  const throwing = standard({ ims: { fail: 'throws' } })
  assert.deepEqual(reasons(await run(throwing.ctx)), ['inconclusive', 'INTERNAL_ERROR'])
  const badDate = standard({ context: { asOf: '2026-02-30' } })
  assert.deepEqual(reasons(await run(badDate.ctx)), ['inconclusive', 'STALE_BASIS'])
  const portThrows = standard()
  const thrown = { ...portThrows.ctx, vendor: { woo: portThrows.woo, xero: { port: { get: async () => { throw new Error('boom') } }, binding: binding() } } }
  assert.deepEqual(reasons(await run(thrown)), ['inconclusive', 'XERO_CONNECTION_UNUSABLE'])
})
