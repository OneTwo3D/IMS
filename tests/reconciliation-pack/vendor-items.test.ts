import assert from 'node:assert/strict'
import test from 'node:test'

import { getPackItem } from '../../lib/reconciliation-pack/constants.ts'
import type { ImsRead, ImsReadOptions, ImsSectionValues, OrderRow, PopulationBoundaries, StorefrontStatusConfig, TaxMappingRow, TaxRateRow } from '../../lib/reconciliation-pack/ims-readers.ts'
import { openStorefrontStatuses, runVendorItem, type VendorItemContext, type XeroTaxTypeList } from '../../lib/reconciliation-pack/vendor-items.ts'
import { WOO_BUILT_IN_STATUS_MAP } from '../../lib/reconciliation-pack/constants.ts'
import { readFileSync } from 'node:fs'
import { fakeStore, noSleep, order, type StoreData, type Tweak } from './woo-fixtures.ts'

/**
 * R9 AND R13 over doubles of the IMS read and of the WooCommerce port. Mutations are listed in the PR.
 */

const D = '2026-10-19'
const BOUNDARIES: PopulationBoundaries = { firstLoad: { state: 'verified', cutAt: '2026-09-01T00:00:00.000Z' }, storefrontImport: { state: 'completed', cutAt: '2026-09-01T00:00:00.000Z' }, retentionMonths: 0 }
const CONFIG: StorefrontStatusConfig = { configured: ['processing'], mappings: [] }
const cuid = (n: number) => `c${String(n).padStart(24, '0')}`

const imsOrder = (n: number, wooId: string | null, over: Partial<OrderRow> = {}): OrderRow => ({
  id: cuid(n), status: 'PROCESSING', currency: 'GBP', totalForeign: '12.50', externalCreatedAt: '2026-10-10T09:30:00.000Z', externalUpdatedAt: null,
  links: wooId === null ? [] : [{ connector: 'woocommerce', externalOrderId: wooId }], ...over,
})

type ImsFixture = { orders?: OrderRow[]; boundaries?: PopulationBoundaries; config?: StorefrontStatusConfig; rates?: TaxRateRow[]; mappings?: TaxMappingRow[]; fail?: 'read' | 'throws' | Partial<Record<keyof ImsSectionValues, 'CAP_EXCEEDED'>> }
function imsPort(fixture: ImsFixture = {}): { calls: ImsReadOptions[]; ims: NonNullable<VendorItemContext['ims']> } {
  const calls: ImsReadOptions[] = []
  return {
    calls,
    ims: async (options): Promise<ImsRead> => {
      calls.push(options)
      if (fixture.fail === 'throws') throw new Error('boom')
      if (fixture.fail === 'read') return { ok: false, reason: 'READ_INCOMPLETE' }
      const values: Record<string, unknown> = {
        boundaries: fixture.boundaries ?? BOUNDARIES, orders: fixture.orders ?? [], storefrontStatus: fixture.config ?? CONFIG,
        taxes: { rates: fixture.rates ?? [], mappings: fixture.mappings ?? [] },
      }
      const sections: Record<string, unknown> = {}
      for (const name of options.sections) {
        const failure = typeof fixture.fail === 'object' ? fixture.fail[name as keyof ImsSectionValues] : undefined
        sections[name] = failure ? { ok: false, reason: failure } : { ok: true, value: values[name] }
      }
      return { ok: true, snapshotId: '1:2:', sections } as ImsRead
    },
  }
}

const context = (fixture: ImsFixture, store: StoreData | ReturnType<typeof fakeStore>, over: Partial<VendorItemContext> = {}, tweak?: Tweak) => {
  const woo = 'calls' in store ? store : fakeStore(store, tweak)
  const ims = imsPort(fixture)
  return { woo, ims, ctx: { asOf: D, vendorReads: true, vendor: { woo }, ims: ims.ims, wooOptions: { sleep: noSleep }, ...over } satisfies VendorItemContext }
}
const keys = (item: { entries?: Partial<Record<string, readonly { key: string }[]>> }, bucket: string) => (item.entries?.[bucket] ?? []).map((e) => e.key)

const processing = (...ids: number[]) => ids.map((id) => order(id))

// ---- R9 -----------------------------------------------------------------------------------------

test('R9 passes when the open orders are the same set with the same totals, comparing the identities and naming both sources', async () => {
  const { ctx } = context({ orders: [imsOrder(1, '11'), imsOrder(2, '12'), imsOrder(3, '13', { status: 'PICKING' })] }, { orders: { processing: processing(11, 12, 13) } })
  const item = await runVendorItem('R9', ctx)
  assert.equal(item.outcome, 'pass')
  assert.deepEqual(item.reasons, [])
  assert.deepEqual(item.proof, { kind: 'compared' })
  assert.deepEqual(item.sources, [...getPackItem('R9').sources])
  assert.deepEqual(keys(item, 'bothEqual').sort(), ['11', '12', '13'])
})

test('IDENTITY SWAP: equal counts with one order id swapped is an onlyIms plus an onlyVendor and a fail, never a pass', async () => {
  const { ctx } = context({ orders: [imsOrder(1, '11'), imsOrder(2, '12'), imsOrder(3, '14')] }, { orders: { processing: processing(11, 12, 13) } })
  const item = await runVendorItem('R9', ctx)
  assert.equal(item.outcome, 'fail')
  assert.deepEqual(item.reasons, ['DIFFERENCES'])
  assert.deepEqual(keys(item, 'onlyIms'), ['14'])
  assert.deepEqual(keys(item, 'onlyVendor'), ['13'])
})

// [mutation: the minor-unit tolerance replaced by exact equality / by a wider limit; the currency of the order not used]
test('the value is within ONE MINOR UNIT of the order currency, inclusive: 0.01 for GBP, 1 for JPY, 0.001 for KWD; another currency is a difference', async () => {
  const cases: Array<[string, string, string, 'pass' | 'fail']> = [
    ['GBP', '12.50', '12.50', 'pass'], ['GBP', '12.50', '12.51', 'pass'], ['GBP', '12.50', '12.49', 'pass'], ['GBP', '12.50', '12.52', 'fail'], ['GBP', '12.50', '12.48', 'fail'], ['GBP', '12.50', '13.50', 'fail'],
    ['JPY', '1000', '1001', 'pass'], ['JPY', '1000', '1002', 'fail'], ['KWD', '1.000', '1.001', 'pass'], ['KWD', '1.000', '1.002', 'fail'],
  ]
  for (const [currency, imsTotal, wooTotal, expected] of cases) {
    const { ctx } = context({ orders: [imsOrder(1, '11', { currency, totalForeign: imsTotal })] }, { orders: { processing: [order(11, 'processing', { currency, total: wooTotal })] } })
    const item = await runVendorItem('R9', ctx)
    assert.equal(item.outcome, expected, `${currency} ${imsTotal} vs ${wooTotal}`)
    if (expected === 'fail') assert.deepEqual(keys(item, 'bothDiffer'), ['11'])
  }
  const other = context({ orders: [imsOrder(1, '11', { currency: 'GBP' })] }, { orders: { processing: [order(11, 'processing', { currency: 'EUR' })] } })
  const item = await runVendorItem('R9', other.ctx)
  assert.equal(item.outcome, 'fail')
  assert.deepEqual(keys(item, 'bothDiffer'), ['11'])
  const unknown = await runVendorItem('R9', context({ orders: [imsOrder(1, '11', { currency: 'XXX' })] }, { orders: { processing: processing(11) } }).ctx)
  assert.deepEqual([unknown.outcome, unknown.reasons], ['inconclusive', ['CURRENCY_UNKNOWN']])
})

// [mutation: classifyPopulation not used / both-sided identities classified too]
test('POPULATION from the recorded boundaries: a storefront order IMS lacks, older than the initial import or beyond retention, is listed out, never a finding; one at the boundary is in; an open IMS order is always judged', async () => {
  const wooOld = order(21, 'processing', { date_created_gmt: '2026-08-31T23:59:59' })
  const wooAtCut = order(22, 'processing', { date_created_gmt: '2026-09-01T00:00:00' })
  const item = await runVendorItem('R9', context({ orders: [imsOrder(1, '11')] }, { orders: { processing: [order(11), wooOld, wooAtCut] } }).ctx)
  assert.equal(item.outcome, 'fail')
  assert.deepEqual(keys(item, 'outOfPopulation'), ['21'])
  assert.deepEqual(keys(item, 'onlyVendor'), ['22'], 'an instant equal to the boundary is inside')
  // Only the old one: no finding, and the pass has something compared.
  const clean = await runVendorItem('R9', context({ orders: [imsOrder(1, '11')] }, { orders: { processing: [order(11), wooOld] } }).ctx)
  assert.equal(clean.outcome, 'pass')
  assert.deepEqual(keys(clean, 'outOfPopulation'), ['21'])
  // Retention: 1 month before 2026-10-19 is 2026-09-19.
  const retained = await runVendorItem('R9', context({ boundaries: { ...BOUNDARIES, retentionMonths: 1 }, orders: [imsOrder(1, '11')] }, { orders: { processing: [order(11), order(23, 'processing', { date_created_gmt: '2026-09-18T12:00:00' })] } }).ctx)
  assert.equal(retained.outcome, 'pass')
  assert.deepEqual(keys(retained, 'outOfPopulation'), ['23'])
  // An open IMS order the store does not list is ALWAYS judged, however old: IMS holding it proves it was imported, and an old one is the likeliest to be stale.
  const imsOld = await runVendorItem('R9', context({ boundaries: { ...BOUNDARIES, retentionMonths: 1 }, orders: [imsOrder(1, '11'), imsOrder(2, '12', { externalCreatedAt: '2026-01-01T00:00:00.000Z' })] }, { orders: { processing: processing(11) } }).ctx)
  assert.deepEqual([imsOld.outcome, keys(imsOld, 'onlyIms'), keys(imsOld, 'outOfPopulation')], ['fail', ['12'], []])
  // An identity on BOTH sides is judged whatever its age: an old pair that differs is a finding.
  const bothOld = await runVendorItem('R9', context({ orders: [imsOrder(1, '21', { totalForeign: '99.00', externalCreatedAt: '2026-01-01T00:00:00.000Z' })] }, { orders: { processing: [wooOld] } }).ctx)
  assert.deepEqual([bothOld.outcome, keys(bothOld, 'bothDiffer')], ['fail', ['21']])
})

// [mutation: an unknown verdict treated as in / as out]
test('a boundary with no record, or an identity with no creation instant, is NO_POPULATION_RECORD - never "in", never "out"', async () => {
  const noInstant = await runVendorItem('R9', context({ orders: [] }, { orders: { processing: [order(21, 'processing', { date_created_gmt: null })] } }).ctx)
  assert.deepEqual([noInstant.outcome, noInstant.reasons], ['inconclusive', ['NO_POPULATION_RECORD']])
  // An IMS-side identity needs no creation instant: it is judged.
  const imsNoInstant = await runVendorItem('R9', context({ orders: [imsOrder(1, '12', { externalCreatedAt: null })] }, { orders: { processing: [] } }).ctx)
  assert.deepEqual([imsNoInstant.outcome, keys(imsNoInstant, 'onlyIms')], ['fail', ['12']])
  const notImported = await runVendorItem('R9', context({ boundaries: { ...BOUNDARIES, storefrontImport: { state: 'not-completed' } }, orders: [] }, { orders: { processing: [order(21)] } }).ctx)
  assert.deepEqual([notImported.outcome, notImported.reasons], ['inconclusive', ['NO_POPULATION_RECORD']])
  // A pair needs no boundary: it is judged.
  const pair = await runVendorItem('R9', context({ boundaries: { ...BOUNDARIES, storefrontImport: { state: 'not-completed' } }, orders: [imsOrder(1, '11')] }, { orders: { processing: [order(11)] } }).ctx)
  assert.equal(pair.outcome, 'pass')
})

test('an open IMS order with no WooCommerce order id is listed as out of the population (never a finding, never a guess at an identity)', async () => {
  const item = await runVendorItem('R9', context({ orders: [imsOrder(1, '11'), imsOrder(2, null)] }, { orders: { processing: processing(11) } }).ctx)
  assert.equal(item.outcome, 'pass')
  assert.deepEqual(keys(item, 'outOfPopulation'), [cuid(2)])
  // A link of another connector is not a storefront identity.
  const other = await runVendorItem('R9', context({ orders: [imsOrder(1, null, { links: [{ connector: 'mintsoft', externalOrderId: '11' }] }), imsOrder(2, '11')] }, { orders: { processing: processing(11) } }).ctx)
  assert.deepEqual([other.outcome, keys(other, 'outOfPopulation')], ['pass', [cuid(1)]])
})

test('EMPTY needs a named proof: both sides empty passes only on per-status-total-zero; nothing enumerated, or a vendor list that is all out of population, is EMPTY_UNPROVEN', async () => {
  const empty = await runVendorItem('R9', context({ orders: [] }, { orders: {} }).ctx)
  assert.deepEqual([empty.outcome, empty.proof], ['pass', { kind: 'proven-empty', source: 'per-status-total-zero' }])
  const onlyUnlinked = await runVendorItem('R9', context({ orders: [imsOrder(1, null)] }, { orders: {} }).ctx)
  assert.deepEqual([onlyUnlinked.outcome, onlyUnlinked.proof], ['pass', { kind: 'proven-empty', source: 'per-status-total-zero' }])
  const nothingAdmitted = context({ orders: [], config: { configured: [], mappings: [] } }, { orders: {} })
  const none = await runVendorItem('R9', nothingAdmitted.ctx)
  assert.deepEqual([none.outcome, none.reasons], ['inconclusive', ['EMPTY_UNPROVEN']])
  assert.equal(nothingAdmitted.woo.calls.length, 0)
  const allOld = await runVendorItem('R9', context({ orders: [] }, { orders: { processing: [order(21, 'processing', { date_created_gmt: '2026-01-01T00:00:00' })] } }).ctx)
  assert.deepEqual([allOld.outcome, allOld.reasons], ['inconclusive', ['EMPTY_UNPROVEN']])
})

test('an IMS order with nothing at the vendor is onlyIms and a fail: an empty store is not an empty answer', async () => {
  const item = await runVendorItem('R9', context({ orders: [imsOrder(1, '11')] }, { orders: {} }).ctx)
  assert.deepEqual([item.outcome, keys(item, 'onlyIms')], ['fail', ['11']])
})

// [mutation: the per-status enumeration replaced by one request / the mapping not consulted / an unknown status defaulted]
test('the statuses walked are the ADMITTED statuses whose reading is an open IMS status, one request series each; an unknown status fails the whole item before any call', async () => {
  const both = context({ orders: [imsOrder(1, '11'), imsOrder(2, '12', { status: 'ON_HOLD' })], config: { configured: ['processing', 'on-hold', 'completed'], mappings: [] } }, { orders: { processing: processing(11), 'on-hold': [order(12, 'on-hold')], completed: [order(99, 'completed')] } })
  const item = await runVendorItem('R9', both.ctx)
  assert.equal(item.outcome, 'pass')
  assert.deepEqual([...new Set(both.woo.calls.map((c) => c.params.status))], ['processing', 'on-hold'], 'completed is admitted but not open')
  const unknown = context({ orders: [], config: { configured: ['processing', 'weird'], mappings: [] } }, { orders: {} })
  const refused = await runVendorItem('R9', unknown.ctx)
  assert.deepEqual([refused.outcome, refused.reasons], ['inconclusive', ['UNKNOWN_STATUS']])
  assert.equal(unknown.woo.calls.length, 0, 'no request before the statuses are decided')
  // A mapping row decides a custom status, and overrides the built-in reading.
  const mapped = context({ orders: [], config: { configured: ['weird', 'processing'], mappings: [{ externalStatus: 'wc-weird', imsStatus: 'ON_HOLD' }, { externalStatus: 'processing', imsStatus: 'COMPLETED' }] } }, { orders: { weird: [] } })
  const m = await runVendorItem('R9', mapped.ctx)
  assert.equal(m.outcome, 'pass')
  assert.deepEqual([...new Set(mapped.woo.calls.map((c) => c.params.status))], ['weird'], 'processing is remapped to a closed status, so it is not walked')
})

test('openStorefrontStatuses: the exact slug wins, agreeing rows are one, disagreeing rows are unknown, no reading is unknown; the built-in table is a copy of the connector\'s own', async () => {
  const open = (configured: string[], mappings: StorefrontStatusConfig['mappings']) => openStorefrontStatuses({ configured, mappings })
  assert.deepEqual(open(['pending', 'failed', 'on-hold', 'processing', 'refunded', 'completed', 'cancelled'], []), { ok: true, statuses: ['pending', 'failed', 'on-hold', 'processing', 'refunded'] })
  assert.deepEqual(open(['x'], [{ externalStatus: 'x', imsStatus: 'PICKING' }]), { ok: true, statuses: ['x'] })
  assert.deepEqual(open(['x'], [{ externalStatus: 'x', imsStatus: 'COMPLETED' }, { externalStatus: 'wc-x', imsStatus: 'PICKING' }]), { ok: true, statuses: [] }, 'the exact slug wins')
  assert.deepEqual(open(['x'], [{ externalStatus: 'wc-x', imsStatus: 'PICKING' }, { externalStatus: 'WC-X', imsStatus: 'PICKING' }]), { ok: true, statuses: ['x'] })
  assert.deepEqual(open(['x'], [{ externalStatus: 'wc-x', imsStatus: 'PICKING' }, { externalStatus: 'WC-X', imsStatus: 'COMPLETED' }]), { ok: false, reason: 'UNKNOWN_STATUS' })
  assert.deepEqual(open(['x'], []), { ok: false, reason: 'UNKNOWN_STATUS' })
  assert.deepEqual(open(['toString', 'constructor', '__proto__'], []), { ok: false, reason: 'UNKNOWN_STATUS' }, 'a status named like an object property has no reading')
  // The copy equals the connector's own table (the connector imports the application's database client, so the pack cannot).
  const { WC_BUILT_IN_STATUS_MAP } = await import('../../lib/connectors/woocommerce/sync/status-mapping.ts')
  assert.deepEqual({ ...WOO_BUILT_IN_STATUS_MAP }, { ...WC_BUILT_IN_STATUS_MAP })
})

test('every IMS failure is a closed reason and NO vendor request is made: a failed read, a section that failed, a throw, a bad link id', async () => {
  for (const [fixture, reason] of [[{ fail: 'read' }, 'READ_INCOMPLETE'], [{ fail: { orders: 'CAP_EXCEEDED' } }, 'CAP_EXCEEDED'], [{ fail: { boundaries: 'CAP_EXCEEDED' } }, 'CAP_EXCEEDED'], [{ fail: { storefrontStatus: 'CAP_EXCEEDED' } }, 'CAP_EXCEEDED'], [{ fail: 'throws' }, 'INTERNAL_ERROR']] as const) {
    const c = context(fixture as ImsFixture, { orders: { processing: processing(11) } })
    const item = await runVendorItem('R9', c.ctx)
    assert.deepEqual([item.outcome, item.reasons], ['inconclusive', [reason]], JSON.stringify(fixture))
    assert.equal(c.woo.calls.length, 0)
  }
  for (const id of ['abc', '007', '0', '-1', '1.5', ' 7', '99999999999999999999']) {
    const c = context({ orders: [imsOrder(1, id)] }, { orders: { processing: processing(11) } })
    const item = await runVendorItem('R9', c.ctx)
    assert.deepEqual([item.outcome, item.reasons], ['inconclusive', ['BAD_KEY']], id)
    assert.equal(c.woo.calls.length, 0)
  }
  assert.deepEqual((await runVendorItem('R9', { asOf: D, vendorReads: true, ims: imsPort().ims })).reasons, ['SOURCE_UNREADABLE'], 'no WooCommerce port')
  assert.deepEqual((await runVendorItem('R9', { asOf: D, vendorReads: true, vendor: { woo: fakeStore({}) } })).reasons, ['SOURCE_UNREADABLE'], 'no IMS read')
})

// [mutation: a vendor walk's failure turned into an empty or partial list]
test('every vendor failure is a closed reason with no entries: a lying store gives an inconclusive item, never a comparison', async () => {
  const data = { orders: { processing: processing(11, 12) } }
  const lies: Array<[string, Tweak, string]> = [
    ['a failed page', () => ({ ok: false }), 'SOURCE_UNREADABLE'],
    ['a total that is not the rows', (_c, _n, page) => ({ ...page, total: '3', totalPages: '1' }), 'VENDOR_READ_UNSTABLE'],
    ['a second read that differs', (_c, n, page) => n === 2 ? { ...page, body: [order(11), order(14)] } : undefined, 'VENDOR_READ_UNSTABLE'],
    ['no header', (_c, _n, page) => ({ ...page, total: null }), 'SOURCE_UNREADABLE'],
  ]
  for (const [name, tweak, reason] of lies) {
    const item = await runVendorItem('R9', context({ orders: [imsOrder(1, '11'), imsOrder(2, '12')] }, data, {}, tweak).ctx)
    assert.deepEqual([item.outcome, item.reasons, item.entries], ['inconclusive', [reason], undefined], name)
  }
  const capped = await runVendorItem('R9', context({ orders: [] }, data, { wooOptions: { sleep: noSleep, budget: 1 } }).ctx)
  assert.deepEqual(capped.reasons, ['CAP_EXCEEDED'])
})

test('a repeated IMS storefront id (two orders, one WooCommerce id) is DUPLICATE_KEY, never summed or picked between', async () => {
  const item = await runVendorItem('R9', context({ orders: [imsOrder(1, '11'), imsOrder(2, '11')] }, { orders: { processing: processing(11) } }).ctx)
  assert.deepEqual([item.outcome, item.reasons], ['inconclusive', ['DUPLICATE_KEY']])
})

// ---- the opt-in -----------------------------------------------------------------------------------

// [mutation: the opt-in test removed from runVendorItem]
test('WITHOUT THE OPT-IN nothing is touched: no IMS read, no vendor request, no credential - for anything but the boolean true', async () => {
  for (const flag of [false, undefined, 'true', 1, null] as unknown[]) {
    for (const id of ['R9', 'R13'] as const) {
      const c = context({ orders: [] }, { orders: {} }, { vendorReads: flag as boolean })
      let xeroAsked = 0
      c.ctx.vendor = { woo: c.woo, xeroTaxTypes: async () => { xeroAsked += 1; return null } }
      const item = await runVendorItem(id, c.ctx)
      assert.deepEqual([item.outcome, item.reasons, item.sources ?? []], ['inconclusive', ['VENDOR_READS_OFF'], []])
      assert.equal(c.woo.calls.length + c.ims.calls.length + xeroAsked, 0)
    }
  }
})

// ---- R13 ---------------------------------------------------------------------------------------

const rate = (id: string, over: Partial<TaxRateRow> = {}): TaxRateRow => ({ id, active: true, accountingTaxType: null, countryCode: 'GB', reportingCategory: null, ...over })
const mapping = (externalTaxRateId: string, taxRateId = 'r1', connector = 'woocommerce'): TaxMappingRow => ({ connector, externalTaxRateId, taxRateId })
const wooTaxes = (...ids: number[]): StoreData => ({ taxes: ids.map((id) => ({ id })) })
const xero = (...taxTypes: string[]): (() => Promise<XeroTaxTypeList | null>) => async () => ({ complete: true, taxTypes })

test('R13 with a clean WooCommerce leg is INCONCLUSIVE (VENDOR_LIST_UNPROVEN) while the Xero list is not proven complete: it can never pass on half of its claim', async () => {
  const c = context({ rates: [rate('r1')], mappings: [mapping('1'), mapping('2')] }, wooTaxes(1, 2))
  const item = await runVendorItem('R13', c.ctx)
  assert.deepEqual([item.outcome, item.reasons, item.proof ?? null, item.sources], ['inconclusive', ['VENDOR_LIST_UNPROVEN'], null, ['ims-database', 'woocommerce-api']])
  // Not proven: no port, a null, an incomplete list, a throw, a list that says complete in some other way.
  for (const xeroTaxTypes of [undefined, async () => null, async () => ({ complete: false, taxTypes: [] }), async () => { throw new Error('x') }, async () => ({ complete: 'yes', taxTypes: [] }), async () => ({ complete: true, taxTypes: 'OUTPUT2' })] as unknown[]) {
    const d = context({ rates: [rate('r1')], mappings: [mapping('1')] }, wooTaxes(1))
    d.ctx.vendor = { woo: d.woo, xeroTaxTypes: xeroTaxTypes as never }
    assert.deepEqual((await runVendorItem('R13', d.ctx)).reasons, ['VENDOR_LIST_UNPROVEN'])
  }
})

test('R13: an unmapped WooCommerce rate, or a mapping to a rate the store no longer has, is a finding - and a fail stands even though the Xero leg is unproven', async () => {
  const unmapped = await runVendorItem('R13', context({ mappings: [mapping('1')] }, wooTaxes(1, 2)).ctx)
  assert.deepEqual([unmapped.outcome, unmapped.reasons, keys(unmapped, 'onlyVendor'), keys(unmapped, 'bothEqual')], ['fail', ['DIFFERENCES', 'VENDOR_LIST_UNPROVEN'], ['woo-tax-rate|2'], ['woo-tax-rate|1']])
  const stale = await runVendorItem('R13', context({ mappings: [mapping('1'), mapping('3')] }, wooTaxes(1)).ctx)
  assert.deepEqual([stale.outcome, keys(stale, 'onlyIms')], ['fail', ['woo-tax-rate|3']])
  // IDENTITY SWAP: equal counts, one identity swapped.
  const swap = await runVendorItem('R13', context({ mappings: [mapping('1'), mapping('2')] }, wooTaxes(1, 3)).ctx)
  assert.deepEqual([swap.outcome, keys(swap, 'onlyIms'), keys(swap, 'onlyVendor')], ['fail', ['woo-tax-rate|2'], ['woo-tax-rate|3']])
  // Mappings of another connector are not the storefront's.
  const other = await runVendorItem('R13', context({ mappings: [mapping('1'), mapping('9', 'r1', 'xero')] }, wooTaxes(1)).ctx)
  assert.deepEqual(other.reasons, ['VENDOR_LIST_UNPROVEN'])
})

// [mutation: a bad external id turned into a skipped row]
test('R13: a mapping whose external id is not a plain numeric id, a read that fails and a vendor failure are inconclusive with their own reasons', async () => {
  for (const id of ['abc', '0', '01', '']) assert.deepEqual((await runVendorItem('R13', context({ mappings: [mapping(id)] }, wooTaxes(1)).ctx)).reasons, ['BAD_KEY'], id)
  assert.deepEqual((await runVendorItem('R13', context({ fail: { taxes: 'CAP_EXCEEDED' } }, wooTaxes(1)).ctx)).reasons, ['CAP_EXCEEDED'])
  assert.deepEqual((await runVendorItem('R13', context({ fail: 'read' }, wooTaxes(1)).ctx)).reasons, ['READ_INCOMPLETE'])
  const lying = await runVendorItem('R13', context({ mappings: [mapping('1')] }, wooTaxes(1), {}, (_c, _n, page) => ({ ...page, total: '2' })).ctx)
  assert.deepEqual([lying.outcome, lying.reasons], ['inconclusive', ['VENDOR_READ_UNSTABLE']])
})

test('R13 empty: no rates and no mappings is not a pass without proof, and the Xero leg is still needed', async () => {
  const item = await runVendorItem('R13', context({}, wooTaxes()).ctx)
  assert.deepEqual([item.outcome, item.reasons], ['inconclusive', ['VENDOR_LIST_UNPROVEN']])
  const d = context({}, wooTaxes())
  d.ctx.vendor = { woo: d.woo, xeroTaxTypes: xero() }
  const pass = await runVendorItem('R13', d.ctx)
  assert.deepEqual([pass.outcome, pass.proof, pass.sources], ['pass', { kind: 'proven-empty', source: 'vendor-total-zero' }, [...getPackItem('R13').sources]])
})

test('R13 WITH a proven Xero list: every Xero tax type held by an active IMS rate, and the reverse, passes naming all three sources; any difference fails', async () => {
  const rates = [rate('r1', { accountingTaxType: 'OUTPUT2' }), rate('r2', { accountingTaxType: 'OUTPUT2' }), rate('r3', { accountingTaxType: 'TAX001' }), rate('r4', { accountingTaxType: 'OLDRATE', active: false }), rate('r5')]
  const run = async (types: string[], woo = wooTaxes(1), mappings = [mapping('1')]) => {
    const c = context({ rates, mappings }, woo)
    c.ctx.vendor = { woo: c.woo, xeroTaxTypes: xero(...types) }
    return runVendorItem('R13', c.ctx)
  }
  const pass = await run(['OUTPUT2', 'TAX001'])
  assert.deepEqual([pass.outcome, pass.sources, keys(pass, 'bothEqual').sort()], ['pass', [...getPackItem('R13').sources], ['woo-tax-rate|1', 'xero-tax-type|OUTPUT2', 'xero-tax-type|TAX001']])
  const unmappedXero = await run(['OUTPUT2', 'TAX001', 'EXEMPTOUTPUT'])
  assert.deepEqual([unmappedXero.outcome, keys(unmappedXero, 'onlyVendor')], ['fail', ['xero-tax-type|EXEMPTOUTPUT']])
  const missingAtXero = await run(['OUTPUT2'])
  assert.deepEqual([missingAtXero.outcome, keys(missingAtXero, 'onlyIms')], ['fail', ['xero-tax-type|TAX001']])
  // IDENTITY SWAP on the Xero leg: same count, one type swapped.
  const swap = await run(['OUTPUT2', 'ZERORATED'])
  assert.deepEqual([swap.outcome, keys(swap, 'onlyIms'), keys(swap, 'onlyVendor')], ['fail', ['xero-tax-type|TAX001'], ['xero-tax-type|ZERORATED']])
  // The inactive rate's type is not held: Xero listing it is an unmapped Xero rate.
  assert.deepEqual(keys(await run(['OUTPUT2', 'TAX001', 'OLDRATE']), 'onlyVendor'), ['xero-tax-type|OLDRATE'])
  // A type that is not a plain code, or a repeated one, is never matched on a guess.
  assert.deepEqual((await run(['OUTPUT2', 'bad type'])).reasons, ['BAD_KEY'])
  assert.deepEqual((await run(['OUTPUT2', 'OUTPUT2'])).reasons, ['DUPLICATE_KEY'])
  // A WooCommerce finding still fails with the Xero leg proven.
  assert.equal((await run(['OUTPUT2', 'TAX001'], wooTaxes(1, 2))).outcome, 'fail')
})

test('the vendor items are the only ones this module runs, and an unexpected failure inside one is INTERNAL_ERROR with no text', async () => {
  const c = context({ orders: [] }, { orders: {} })
  c.ctx.vendor = { woo: { get: () => { throw new Error('hunter2') } } as never }
  c.ctx.wooOptions = { sleep: noSleep }
  const item = await runVendorItem('R9', c.ctx)
  assert.equal(item.outcome, 'inconclusive')
  assert.ok(!JSON.stringify(item).includes('hunter2'))
})

// ---- the importer's own lookup rule -------------------------------------------------------------

// [mutation: matching by normalised key (trim) instead of the connector's equals / wc- rule]
test('a stored mapping the importer would NOT match (padded, odd prefix) for an admitted status is AMBIGUOUS_STATUS_MAPPING: never used, never ignored, and no request is made', async () => {
  const open = (configured: string[], mappings: StorefrontStatusConfig['mappings']) => openStorefrontStatuses({ configured, mappings })
  for (const externalStatus of [' processing ', 'processing ', ' processing', '\tprocessing', ' wc-processing', 'WC-processing ', 'Processing\n']) {
    assert.deepEqual(open(['processing'], [{ externalStatus, imsStatus: 'COMPLETED' }]), { ok: false, reason: 'AMBIGUOUS_STATUS_MAPPING' }, JSON.stringify(externalStatus))
    const c = context({ orders: [], config: { configured: ['processing'], mappings: [{ externalStatus, imsStatus: 'COMPLETED' }] } }, { orders: {} })
    const item = await runVendorItem('R9', c.ctx)
    assert.deepEqual([item.outcome, item.reasons, c.woo.calls.length], ['inconclusive', ['AMBIGUOUS_STATUS_MAPPING'], 0], JSON.stringify(externalStatus))
  }
  // Even beside a row the importer WOULD match: the stray row still makes it ambiguous.
  assert.deepEqual(open(['processing'], [{ externalStatus: 'processing', imsStatus: 'PROCESSING' }, { externalStatus: ' processing ', imsStatus: 'COMPLETED' }]), { ok: false, reason: 'AMBIGUOUS_STATUS_MAPPING' })
  // A row for another status is not this status's business.
  assert.deepEqual(open(['processing'], [{ externalStatus: ' on-hold ', imsStatus: 'COMPLETED' }]), { ok: true, statuses: ['processing'] })
})

test('a mapping the importer WOULD match exactly (the slug, or wc- and the slug, in any case) is used as the importer uses it', () => {
  const open = (mappings: StorefrontStatusConfig['mappings']) => openStorefrontStatuses({ configured: ['processing'], mappings })
  assert.deepEqual(open([{ externalStatus: 'processing', imsStatus: 'COMPLETED' }]), { ok: true, statuses: [] })
  assert.deepEqual(open([{ externalStatus: 'wc-processing', imsStatus: 'COMPLETED' }]), { ok: true, statuses: [] })
  assert.deepEqual(open([{ externalStatus: 'WC-Processing', imsStatus: 'COMPLETED' }]), { ok: true, statuses: [] })
  assert.deepEqual(open([{ externalStatus: 'PROCESSING', imsStatus: 'COMPLETED' }]), { ok: true, statuses: [] })
  assert.deepEqual(open([{ externalStatus: 'wc-processing', imsStatus: 'COMPLETED' }, { externalStatus: 'processing', imsStatus: 'PICKING' }]), { ok: true, statuses: ['processing'] }, 'the exact slug wins')
  assert.deepEqual(open([{ externalStatus: 'wc-wc-processing', imsStatus: 'COMPLETED' }]), { ok: true, statuses: ['processing'] }, 'a key the importer does not match and that does not normalise to the slug is another status')
})

test('PIN: the pack copies the connector\'s lookup rule - the connector\'s source still says equals-the-slug-or-wc-slug, case-insensitive, exact wins, then the first match', () => {
  const source = readFileSync('lib/connectors/woocommerce/sync/status-mapping.ts', 'utf8')
  for (const needle of ["{ externalStatus: { equals: normalised, mode: 'insensitive' } }", "{ externalStatus: { equals: `wc-${normalised}`, mode: 'insensitive' } }", 'rows.find((row) => row.externalStatus === normalised)', 'rows.find((row) => normaliseWcOrderStatus(row.externalStatus) === normalised)', '?? rows[0]']) assert.ok(source.includes(needle), needle)
  assert.ok(!/trim\(\)/.test(source.slice(source.indexOf('export async function findWcStatusMapping'))), 'the lookup does not trim the stored key')
})

// [mutation: a walked status dropped from the list / the empty proof made without enumerating every admitted open status]
test('no admitted open status can be left out of the empty proof: every one is requested, in both sweeps, and the proof needs a zero total for each', async () => {
  const c = context({ orders: [], config: { configured: ['processing', 'on-hold', 'pending'], mappings: [] } }, { orders: {} })
  const item = await runVendorItem('R9', c.ctx)
  assert.deepEqual([item.outcome, item.proof], ['pass', { kind: 'proven-empty', source: 'per-status-total-zero' }])
  const asked = c.woo.calls.filter((call) => call.params.page === '1').map((call) => call.params.status)
  assert.deepEqual(asked, ['processing', 'on-hold', 'pending', 'processing', 'on-hold', 'pending'])
  // One status with an order: no empty proof.
  const one = await runVendorItem('R9', context({ orders: [], config: { configured: ['processing', 'on-hold'], mappings: [] } }, { orders: { 'on-hold': [order(9, 'on-hold')] } }).ctx)
  assert.deepEqual([one.outcome, one.proof ?? null], ['fail', null])
})
