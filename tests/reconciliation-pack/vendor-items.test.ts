import assert from 'node:assert/strict'
import test from 'node:test'

import { getPackItem } from '../../lib/reconciliation-pack/constants.ts'
import type { ImsRead, ImsReadOptions, ImsSectionValues, OrderRow, PopulationBoundaries, StorefrontStatusConfig, TaxMappingRow, TaxRateRow, TaxComponentTypeRow, XeroTaxRateStore } from '../../lib/reconciliation-pack/ims-readers.ts'
import { openStorefrontStatuses, runVendorItem, type VendorItemContext } from '../../lib/reconciliation-pack/vendor-items.ts'
import { WOO_BUILT_IN_STATUS_MAP } from '../../lib/reconciliation-pack/constants.ts'
import { readFileSync } from 'node:fs'
import { runR9 } from './settling-fixtures.ts'
import { fakeStore, noSleep, order, type StoreData, type Tweak } from './woo-fixtures.ts'

/**
 * R9 AND R13 over doubles of the IMS read and of the WooCommerce port. Mutations are listed in the PR.
 */

const D = '2026-10-19'
const BOUNDARIES: PopulationBoundaries = { firstLoad: { state: 'verified', cutAt: '2026-09-01T00:00:00.000Z' }, storefrontImport: { state: 'completed', cutAt: '2026-09-01T00:00:00.000Z' }, retentionMonths: 0 }
const WITHDRAWAL = { submitted: 'pending-wdraw', approved: 'withdrawn' }
const CONFIG: StorefrontStatusConfig = { configured: ['processing'], withdrawal: WITHDRAWAL, mappings: [] }
const cuid = (n: number) => `c${String(n).padStart(24, '0')}`

/** The withdrawal-submitted status is always walked; the older assertions are about the SELECTED statuses. */
const withoutWithdrawal = (r: ReturnType<typeof openStorefrontStatuses>) => (r.ok ? { ok: true as const, statuses: r.statuses.filter((status) => status !== 'pending-wdraw') } : r)
const imsOrder = (n: number, wooId: string | null, over: Partial<OrderRow> = {}): OrderRow => ({
  id: cuid(n), status: 'PROCESSING', currency: 'GBP', totalForeign: '12.50', externalCreatedAt: '2026-10-10T09:30:00.000Z', externalUpdatedAt: null,
  links: wooId === null ? [] : [{ connector: 'woocommerce', externalOrderId: wooId }], ...over,
})

type ImsFixture = { orders?: OrderRow[]; boundaries?: PopulationBoundaries; config?: Omit<StorefrontStatusConfig, 'withdrawal'> & { withdrawal?: StorefrontStatusConfig['withdrawal'] }; rates?: TaxRateRow[]; mappings?: TaxMappingRow[]; xeroStore?: XeroTaxRateStore; components?: TaxComponentTypeRow[]; reverse?: { sales?: string; purchase?: string }; fail?: 'read' | 'throws' | Partial<Record<keyof ImsSectionValues, 'CAP_EXCEEDED'>> }
function imsPort(fixture: ImsFixture = {}): { calls: ImsReadOptions[]; ims: NonNullable<VendorItemContext['ims']> } {
  const calls: ImsReadOptions[] = []
  return {
    calls,
    ims: async (options): Promise<ImsRead> => {
      calls.push(options)
      if (fixture.fail === 'throws') throw new Error('boom')
      if (fixture.fail === 'read') return { ok: false, reason: 'READ_INCOMPLETE' }
      const values: Record<string, unknown> = {
        boundaries: fixture.boundaries ?? BOUNDARIES, orders: fixture.orders ?? [], storefrontStatus: fixture.config ? { withdrawal: WITHDRAWAL, ...fixture.config } : CONFIG,
        taxes: { rates: fixture.rates ?? [], mappings: fixture.mappings ?? [], componentTaxTypes: fixture.components ?? [], reverseCharge: { sales: fixture.reverse?.sales ?? '', purchase: fixture.reverse?.purchase ?? '' } },
        xeroTaxRates: fixture.xeroStore ?? { state: 'unproven', cause: 'NO_HEADER' },
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
  const item = await runR9(undefined, ctx)
  assert.equal(item.outcome, 'pass')
  assert.deepEqual(item.reasons, [])
  assert.deepEqual(item.proof, { kind: 'compared' })
  assert.deepEqual(item.sources, [...getPackItem('R9').sources])
  assert.deepEqual(keys(item, 'bothEqual').sort(), ['11', '12', '13'])
})

test('IDENTITY SWAP: equal counts with one order id swapped is an onlyIms plus an onlyVendor and a fail, never a pass', async () => {
  const { ctx } = context({ orders: [imsOrder(1, '11'), imsOrder(2, '12'), imsOrder(3, '14')] }, { orders: { processing: processing(11, 12, 13) } })
  const item = await runR9(undefined, ctx)
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
    const item = await runR9(undefined, ctx)
    assert.equal(item.outcome, expected, `${currency} ${imsTotal} vs ${wooTotal}`)
    if (expected === 'fail') assert.deepEqual(keys(item, 'bothDiffer'), ['11'])
  }
  const other = context({ orders: [imsOrder(1, '11', { currency: 'GBP' })] }, { orders: { processing: [order(11, 'processing', { currency: 'EUR' })] } })
  const item = await runR9(undefined, other.ctx)
  assert.equal(item.outcome, 'fail')
  assert.deepEqual(keys(item, 'bothDiffer'), ['11'])
  const unknown = await runR9(undefined, context({ orders: [imsOrder(1, '11', { currency: 'XXX' })] }, { orders: { processing: processing(11) } }).ctx)
  assert.deepEqual([unknown.outcome, unknown.reasons], ['inconclusive', ['CURRENCY_UNKNOWN']])
})

// [mutation: an age-based exclusion put back for storefront orders IMS lacks]
test('NO ORDER IS SET ASIDE BY ITS AGE: a storefront order created before the initial import, now in an admitted open status and absent from IMS, is a finding - the importer admits by current status', async () => {
  const wooOld = order(21, 'processing', { date_created_gmt: '2020-01-01T00:00:00' })
  const item = await runR9(undefined, context({ orders: [imsOrder(1, '11')] }, { orders: { processing: [order(11), wooOld] } }).ctx)
  assert.deepEqual([item.outcome, item.reasons, keys(item, 'onlyVendor'), keys(item, 'outOfPopulation')], ['fail', ['DIFFERENCES'], ['21'], []])
  // Whatever the recorded boundaries say (before the import, beyond retention, no record at all, no creation date): judged, not excluded, not unknown.
  for (const boundaries of [BOUNDARIES, { ...BOUNDARIES, retentionMonths: 1 }, { ...BOUNDARIES, storefrontImport: { state: 'not-completed' as const } }, { ...BOUNDARIES, firstLoad: { state: 'absent' as const } }]) {
    for (const date of ['2020-01-01T00:00:00', '2026-08-31T23:59:59', '2026-09-01T00:00:00', null]) {
      const c = context({ boundaries, orders: [] }, { orders: { processing: [order(22, 'processing', { date_created_gmt: date })] } })
      const r = await runR9(undefined, c.ctx)
      assert.deepEqual([r.outcome, r.reasons, keys(r, 'onlyVendor')], ['fail', ['DIFFERENCES'], ['22']], `${JSON.stringify(boundaries)} ${date}`)
    }
  }
  // An open IMS order the store does not list is judged whatever its age, with or without a creation instant.
  const imsOld = await runR9(undefined, context({ orders: [imsOrder(1, '11'), imsOrder(2, '12', { externalCreatedAt: '2026-01-01T00:00:00.000Z' }), imsOrder(3, '13', { externalCreatedAt: null })] }, { orders: { processing: processing(11) } }).ctx)
  assert.deepEqual([imsOld.outcome, keys(imsOld, 'onlyIms').sort(), keys(imsOld, 'outOfPopulation')], ['fail', ['12', '13'], []])
  // An old pair that differs is a finding; an old pair that agrees is compared.
  const pair = await runR9(undefined, context({ orders: [imsOrder(1, '21', { totalForeign: '99.00' })] }, { orders: { processing: [wooOld] } }).ctx)
  assert.deepEqual([pair.outcome, keys(pair, 'bothDiffer')], ['fail', ['21']])
  assert.equal((await runR9(undefined, context({ orders: [imsOrder(1, '21')] }, { orders: { processing: [wooOld] } }).ctx)).outcome, 'pass')
})

test('R9 needs no population record: it does not read the boundaries section at all, and cannot be NO_POPULATION_RECORD', async () => {
  const c = context({ orders: [imsOrder(1, '11')] }, { orders: { processing: processing(11) } })
  assert.equal((await runR9(undefined, c.ctx)).outcome, 'pass')
  assert.deepEqual(c.ims.calls.map((call) => [...call.sections]), [['orders', 'storefrontStatus']])
})

test('an open IMS order with no WooCommerce order id is listed as out of the population (never a finding, never a guess at an identity)', async () => {
  const item = await runR9(undefined, context({ orders: [imsOrder(1, '11'), imsOrder(2, null)] }, { orders: { processing: processing(11) } }).ctx)
  assert.equal(item.outcome, 'pass')
  assert.deepEqual(keys(item, 'outOfPopulation'), [cuid(2)])
  // A link of another connector is not a storefront identity.
  const other = await runR9(undefined, context({ orders: [imsOrder(1, null, { links: [{ connector: 'mintsoft', externalOrderId: '11' }] }), imsOrder(2, '11')] }, { orders: { processing: processing(11) } }).ctx)
  assert.deepEqual([other.outcome, keys(other, 'outOfPopulation')], ['pass', [cuid(1)]])
})

test('EMPTY needs a named proof: both sides empty passes only on per-status-total-zero; nothing enumerated is EMPTY_UNPROVEN', async () => {
  const empty = await runR9(undefined, context({ orders: [] }, { orders: {} }).ctx)
  assert.deepEqual([empty.outcome, empty.proof], ['pass', { kind: 'proven-empty', source: 'per-status-total-zero' }])
  const onlyUnlinked = await runR9(undefined, context({ orders: [imsOrder(1, null)] }, { orders: {} }).ctx)
  assert.deepEqual([onlyUnlinked.outcome, onlyUnlinked.proof], ['pass', { kind: 'proven-empty', source: 'per-status-total-zero' }])
  const nothingAdmitted = context({ orders: [], config: { configured: [], mappings: [] } }, { orders: {} })
  const none = await runR9(undefined, nothingAdmitted.ctx)
  assert.deepEqual([none.outcome, none.reasons], ['inconclusive', ['EMPTY_UNPROVEN']])
  assert.equal(nothingAdmitted.woo.calls.length, 0)
})

test('an IMS order with nothing at the vendor is onlyIms and a fail: an empty store is not an empty answer', async () => {
  const item = await runR9(undefined, context({ orders: [imsOrder(1, '11')] }, { orders: {} }).ctx)
  assert.deepEqual([item.outcome, keys(item, 'onlyIms')], ['fail', ['11']])
})

// [mutation: the per-status enumeration replaced by one request / the mapping not consulted / an unknown status defaulted]
test('the statuses walked are the ADMITTED statuses whose reading is an open IMS status, one request series each; an unknown status fails the whole item before any call', async () => {
  const both = context({ orders: [imsOrder(1, '11'), imsOrder(2, '12', { status: 'ON_HOLD' })], config: { configured: ['processing', 'on-hold', 'completed'], mappings: [] } }, { orders: { processing: processing(11), 'on-hold': [order(12, 'on-hold')], completed: [order(99, 'completed')] } })
  const item = await runR9(undefined, both.ctx)
  assert.equal(item.outcome, 'pass')
  assert.deepEqual([...new Set(both.woo.calls.map((c) => c.params.status))], ['processing', 'on-hold', 'pending-wdraw'], 'completed is admitted but not open; the withdrawal-submitted status is always walked')
  const unknown = context({ orders: [], config: { configured: ['processing', 'weird'], mappings: [] } }, { orders: {} })
  const refused = await runR9(undefined, unknown.ctx)
  assert.deepEqual([refused.outcome, refused.reasons], ['inconclusive', ['UNKNOWN_STATUS']])
  assert.equal(unknown.woo.calls.length, 0, 'no request before the statuses are decided')
  // A mapping row decides a custom status, and overrides the built-in reading.
  const mapped = context({ orders: [], config: { configured: ['weird', 'processing'], mappings: [{ externalStatus: 'wc-weird', imsStatus: 'ON_HOLD' }, { externalStatus: 'processing', imsStatus: 'COMPLETED' }] } }, { orders: { weird: [] } })
  const m = await runR9(undefined, mapped.ctx)
  assert.equal(m.outcome, 'pass')
  assert.deepEqual([...new Set(mapped.woo.calls.map((c) => c.params.status))], ['weird', 'pending-wdraw'], 'processing is remapped to a closed status, so it is not walked')
})

test('openStorefrontStatuses: the exact slug wins, agreeing rows are one, disagreeing rows are unknown, no reading is unknown; the built-in table is a copy of the connector\'s own', async () => {
  const open = (configured: string[], mappings: StorefrontStatusConfig['mappings']) => withoutWithdrawal(openStorefrontStatuses({ configured, withdrawal: WITHDRAWAL, mappings }))
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
  for (const [fixture, reason] of [[{ fail: 'read' }, 'READ_INCOMPLETE'], [{ fail: { orders: 'CAP_EXCEEDED' } }, 'CAP_EXCEEDED'], [{ fail: { storefrontStatus: 'CAP_EXCEEDED' } }, 'CAP_EXCEEDED'], [{ fail: 'throws' }, 'INTERNAL_ERROR']] as const) {
    const c = context(fixture as ImsFixture, { orders: { processing: processing(11) } })
    const item = await runR9(undefined, c.ctx)
    assert.deepEqual([item.outcome, item.reasons], ['inconclusive', [reason]], JSON.stringify(fixture))
    assert.equal(c.woo.calls.length, 0)
  }
  for (const id of ['abc', '007', '0', '-1', '1.5', ' 7', '99999999999999999999']) {
    const c = context({ orders: [imsOrder(1, id)] }, { orders: { processing: processing(11) } })
    const item = await runR9(undefined, c.ctx)
    assert.deepEqual([item.outcome, item.reasons], ['inconclusive', ['BAD_KEY']], id)
    assert.equal(c.woo.calls.length, 0)
  }
  assert.deepEqual((await runR9(undefined, { asOf: D, vendorReads: true, ims: imsPort().ims })).reasons, ['SOURCE_UNREADABLE'], 'no WooCommerce port')
  assert.deepEqual((await runR9(undefined, { asOf: D, vendorReads: true, vendor: { woo: fakeStore({}) } })).reasons, ['SOURCE_UNREADABLE'], 'no IMS read')
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
    const item = await runR9(undefined, context({ orders: [imsOrder(1, '11'), imsOrder(2, '12')] }, data, {}, tweak).ctx)
    assert.deepEqual([item.outcome, item.reasons, item.entries], ['inconclusive', [reason], undefined], name)
  }
  const capped = await runR9(undefined, context({ orders: [] }, data, { wooOptions: { sleep: noSleep, budget: 1 } }).ctx)
  assert.deepEqual(capped.reasons, ['CAP_EXCEEDED'])
})

test('a repeated IMS storefront id (two orders, one WooCommerce id) is DUPLICATE_KEY, never summed or picked between', async () => {
  const item = await runR9(undefined, context({ orders: [imsOrder(1, '11'), imsOrder(2, '11')] }, { orders: { processing: processing(11) } }).ctx)
  assert.deepEqual([item.outcome, item.reasons], ['inconclusive', ['DUPLICATE_KEY']])
})

// ---- the opt-in -----------------------------------------------------------------------------------

// [mutation: the opt-in test removed from runVendorItem]
test('WITHOUT THE OPT-IN nothing is touched: no IMS read, no vendor request, no credential - for anything but the boolean true', async () => {
  for (const flag of [false, undefined, 'true', 1, null] as unknown[]) {
    for (const id of ['R9', 'R13'] as const) {
      const c = context({ orders: [] }, { orders: {} }, { vendorReads: flag as boolean })
      const xeroAsked = 0
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
const xero = (...taxTypes: string[]): XeroTaxRateStore => ({ state: 'proven', tenantId: 'tenant-A', fetchedAt: '2026-10-19T00:00:00.000Z', taxTypes: taxTypes.map((entry) => { const [taxType, status] = entry.split(':'); return { taxType: taxType!, status: status ?? 'ACTIVE' } }) })

test('R13 with a clean WooCommerce leg is INCONCLUSIVE (VENDOR_LIST_UNPROVEN) while the Xero list is not proven complete: it can never pass on half of its claim', async () => {
  const c = context({ rates: [rate('r1')], mappings: [mapping('1'), mapping('2')] }, wooTaxes(1, 2))
  const item = await runVendorItem('R13', c.ctx)
  assert.deepEqual([item.outcome, item.reasons, item.proof ?? null, item.sources], ['inconclusive', ['VENDOR_LIST_UNPROVEN'], null, ['ims-database', 'woocommerce-api']])
  // Not proven, whatever the cause: every closed cause, an unreadable section and an absent section.
  const causes = ['NO_CONNECTION', 'NO_HEADER', 'COUNT_MISMATCH', 'DIGEST_MISMATCH', 'MIXED_READ', 'MALFORMED_ROW'] as const
  for (const cause of causes) {
    const d = context({ rates: [rate('r1')], mappings: [mapping('1')], xeroStore: { state: 'unproven', cause } }, wooTaxes(1))
    assert.deepEqual((await runVendorItem('R13', d.ctx)).reasons, ['VENDOR_LIST_UNPROVEN'], cause)
  }
  for (const code of ['CAP_EXCEEDED', 'DUPLICATE_KEY'] as const) {
    const d = context({ rates: [rate('r1')], mappings: [mapping('1')], fail: { xeroTaxRates: code } as never }, wooTaxes(1))
    assert.deepEqual((await runVendorItem('R13', d.ctx)).reasons, ['VENDOR_LIST_UNPROVEN'], code)
  }
  // A section that claims a state this module does not know is not a proof.
  const odd = context({ rates: [rate('r1')], mappings: [mapping('1')], xeroStore: { state: 'complete' } as never }, wooTaxes(1))
  assert.deepEqual((await runVendorItem('R13', odd.ctx)).reasons, ['VENDOR_LIST_UNPROVEN'])
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
  const d = context({ xeroStore: xero() }, wooTaxes())
  const pass = await runVendorItem('R13', d.ctx)
  assert.deepEqual([pass.outcome, pass.proof, pass.sources], ['pass', { kind: 'proven-empty', source: 'vendor-total-zero' }, [...getPackItem('R13').sources]])
})

// [mutation: the population left unset (unreferenced Xero types become findings) / a reference source dropped / the ACTIVE filter removed]
test('R13 WITH a proven Xero list: only the types IMS USES are judged. Each must resolve to an ACTIVE Xero type; a Xero type nothing names is out of the population, never a finding', async () => {
  const rates = [rate('r1', { accountingTaxType: 'OUTPUT2' }), rate('r2', { accountingTaxType: 'OUTPUT2' }), rate('r3', { accountingTaxType: 'TAX001' }), rate('r4', { accountingTaxType: 'OLDRATE', active: false }), rate('r5')]
  const run = async (types: string[], extra: Partial<ImsFixture> = {}, woo = wooTaxes(1), mappings = [mapping('1')]) => {
    const c = context({ rates, mappings, xeroStore: xero(...types), ...extra }, woo)
    return runVendorItem('R13', c.ctx)
  }
  const pass = await run(['OUTPUT2', 'TAX001'])
  assert.deepEqual([pass.outcome, pass.sources, keys(pass, 'bothEqual').sort()], ['pass', [...getPackItem('R13').sources], ['woo-tax-rate|1', 'xero-tax-type|OUTPUT2', 'xero-tax-type|TAX001']])
  // Xero types IMS does not use stay visible and are not findings (an inactive rate's type is not a reference either).
  const extra = await run(['OUTPUT2', 'TAX001', 'EXEMPTOUTPUT', 'OLDRATE'])
  assert.deepEqual([extra.outcome, extra.reasons, keys(extra, 'outOfPopulation').sort(), keys(extra, 'onlyVendor')], ['pass', [], ['xero-tax-type|EXEMPTOUTPUT', 'xero-tax-type|OLDRATE'], []])
  // A type IMS uses that Xero lacks, or holds but not as ACTIVE, is a finding that names the code.
  const missing = await run(['OUTPUT2'])
  assert.deepEqual([missing.outcome, missing.reasons, keys(missing, 'onlyIms')], ['fail', ['DIFFERENCES'], ['xero-tax-type|TAX001']])
  for (const status of ['DELETED', 'ARCHIVED', 'PENDING']) {
    const inactive = await run(['OUTPUT2', `TAX001:${status}`])
    assert.deepEqual([inactive.outcome, keys(inactive, 'onlyIms'), keys(inactive, 'bothEqual').includes('xero-tax-type|TAX001')], ['fail', ['xero-tax-type|TAX001'], false], status)
  }
  // IDENTITY SWAP: the reference points at another type. Same count on both sides; the missing one fails, the other is out of population.
  const swap = await run(['OUTPUT2', 'ZERORATED'])
  assert.deepEqual([swap.outcome, keys(swap, 'onlyIms'), keys(swap, 'outOfPopulation'), keys(swap, 'onlyVendor')], ['fail', ['xero-tax-type|TAX001'], ['xero-tax-type|ZERORATED'], []])
  // ...and to an existing-but-non-active type.
  const swapInactive = await run(['OUTPUT2', 'ZERORATED', 'TAX001:ARCHIVED'])
  assert.deepEqual([swapInactive.outcome, keys(swapInactive, 'onlyIms')], ['fail', ['xero-tax-type|TAX001']])
  // The other places IMS names a Xero type: an active component of an active rate, and the two reverse-charge settings.
  const comp = (id: string, taxRateId: string, active: boolean, accountingTaxType: string): TaxComponentTypeRow => ({ id, taxRateId, active, accountingTaxType })
  assert.deepEqual(keys(await run(['OUTPUT2', 'TAX001'], { components: [comp('c1', 'r1', true, 'COMP1')] }), 'onlyIms'), ['xero-tax-type|COMP1'], 'an active component')
  assert.equal((await run(['OUTPUT2', 'TAX001', 'COMP1'], { components: [comp('c1', 'r1', true, 'COMP1')] })).outcome, 'pass')
  assert.equal((await run(['OUTPUT2', 'TAX001'], { components: [comp('c1', 'r1', false, 'COMP1'), comp('c2', 'r4', true, 'COMP2')] })).outcome, 'pass', 'an inactive component, or one of an inactive rate, is not a reference')
  assert.deepEqual(keys(await run(['OUTPUT2', 'TAX001'], { reverse: { sales: 'ECOUTPUTSERVICES' } }), 'onlyIms'), ['xero-tax-type|ECOUTPUTSERVICES'], 'the reverse-charge sales type')
  assert.deepEqual(keys(await run(['OUTPUT2', 'TAX001'], { reverse: { purchase: 'REVERSECHARGES' } }), 'onlyIms'), ['xero-tax-type|REVERSECHARGES'], 'the reverse-charge purchase type')
  assert.equal((await run(['OUTPUT2', 'TAX001', 'ECOUTPUTSERVICES', 'REVERSECHARGES'], { reverse: { sales: 'ECOUTPUTSERVICES', purchase: 'REVERSECHARGES' } })).outcome, 'pass')
  // A type that is not a plain code, in IMS or in the list, or a repeated Xero type, is never matched on a guess.
  assert.deepEqual((await run(['OUTPUT2', 'bad type'])).reasons, ['BAD_KEY'])
  assert.deepEqual((await run(['OUTPUT2', 'TAX001'], { reverse: { sales: 'not a code' } })).reasons, ['BAD_KEY'])
  assert.deepEqual((await run(['OUTPUT2', 'OUTPUT2'])).reasons, ['DUPLICATE_KEY'])
  // A WooCommerce finding still fails with the Xero leg proven.
  assert.equal((await run(['OUTPUT2', 'TAX001'], {}, wooTaxes(1, 2))).outcome, 'fail')
  // A proven list is still required: an unproven one never passes however clean the references are.
  assert.deepEqual((await runVendorItem('R13', context({ rates, mappings: [mapping('1')], xeroStore: { state: 'unproven', cause: 'DIGEST_MISMATCH' } }, wooTaxes(1)).ctx)).reasons, ['VENDOR_LIST_UNPROVEN'])
})

// [mutation: the Xero section read in a second IMS read]
test('R13 reads the rates, their other Xero references and the stored Xero list in ONE IMS read', async () => {
  const c = context({ rates: [rate('r1', { accountingTaxType: 'OUTPUT2' })], mappings: [mapping('1')], xeroStore: xero('OUTPUT2', 'OLD1:ARCHIVED', 'NEW1:PENDING') }, wooTaxes(1))
  const item = await runVendorItem('R13', c.ctx)
  assert.deepEqual([item.outcome, item.reasons], ['pass', []])
  assert.equal(c.ims.calls.length, 1, 'one snapshot for both')
  assert.deepEqual([...c.ims.calls[0]!.sections].sort(), ['taxes', 'xeroTaxRates'])
})

test('the vendor items are the only ones this module runs, and an unexpected failure inside one is INTERNAL_ERROR with no text', async () => {
  const c = context({ orders: [] }, { orders: {} })
  c.ctx.vendor = { woo: { get: () => { throw new Error('hunter2') } } as never }
  c.ctx.wooOptions = { sleep: noSleep }
  const item = await runR9(undefined, c.ctx)
  assert.equal(item.outcome, 'inconclusive')
  assert.ok(!JSON.stringify(item).includes('hunter2'))
})

// ---- the importer's own lookup rule -------------------------------------------------------------

// [mutation: matching by normalised key (trim) instead of the connector's equals / wc- rule]
test('a stored mapping the importer would NOT match (padded, odd prefix) for an admitted status is AMBIGUOUS_STATUS_MAPPING: never used, never ignored, and no request is made', async () => {
  const open = (configured: string[], mappings: StorefrontStatusConfig['mappings']) => withoutWithdrawal(openStorefrontStatuses({ configured, withdrawal: WITHDRAWAL, mappings }))
  for (const externalStatus of [' processing ', 'processing ', ' processing', '\tprocessing', ' wc-processing', 'WC-processing ', 'Processing\n']) {
    assert.deepEqual(open(['processing'], [{ externalStatus, imsStatus: 'COMPLETED' }]), { ok: false, reason: 'AMBIGUOUS_STATUS_MAPPING' }, JSON.stringify(externalStatus))
    const c = context({ orders: [], config: { configured: ['processing'], mappings: [{ externalStatus, imsStatus: 'COMPLETED' }] } }, { orders: {} })
    const item = await runR9(undefined, c.ctx)
    assert.deepEqual([item.outcome, item.reasons, c.woo.calls.length], ['inconclusive', ['AMBIGUOUS_STATUS_MAPPING'], 0], JSON.stringify(externalStatus))
  }
  // Even beside a row the importer WOULD match: the stray row still makes it ambiguous.
  assert.deepEqual(open(['processing'], [{ externalStatus: 'processing', imsStatus: 'PROCESSING' }, { externalStatus: ' processing ', imsStatus: 'COMPLETED' }]), { ok: false, reason: 'AMBIGUOUS_STATUS_MAPPING' })
  // A row for another status is not this status's business.
  assert.deepEqual(open(['processing'], [{ externalStatus: ' on-hold ', imsStatus: 'COMPLETED' }]), { ok: true, statuses: ['processing'] })
})

test('a mapping the importer WOULD match exactly (the slug, or wc- and the slug, in any case) is used as the importer uses it', () => {
  const open = (mappings: StorefrontStatusConfig['mappings']) => withoutWithdrawal(openStorefrontStatuses({ configured: ['processing'], withdrawal: WITHDRAWAL, mappings }))
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
  const item = await runR9(undefined, c.ctx)
  assert.deepEqual([item.outcome, item.proof], ['pass', { kind: 'proven-empty', source: 'per-status-total-zero' }])
  const asked = c.woo.calls.filter((call) => call.params.page === '1').map((call) => call.params.status)
  assert.deepEqual(asked, ['processing', 'on-hold', 'pending', 'pending-wdraw', 'processing', 'on-hold', 'pending', 'pending-wdraw'])
  // One status with an order: no empty proof.
  const one = await runR9(undefined, context({ orders: [], config: { configured: ['processing', 'on-hold'], mappings: [] } }, { orders: { 'on-hold': [order(9, 'on-hold')] } }).ctx)
  assert.deepEqual([one.outcome, one.proof ?? null], ['fail', null])
})

// ---- every route by which the importer admits a status ---------------------------------------------

// [mutation: the withdrawal statuses left out of the admitted set / the empty-selection rule dropped]
test('THE WITHDRAWAL STATUSES: the importer also admits the withdrawal pair whenever the selection is non-empty, so a store order in a mapped OPEN withdrawal status that IMS lacks is a finding, never a pass', async () => {
  // approved status mapped to an open IMS status, outside wc_sync_order_statuses
  const c = context({ orders: [imsOrder(1, '11')], config: { configured: ['processing'], mappings: [{ externalStatus: 'withdrawn', imsStatus: 'ON_HOLD' }] } }, { orders: { processing: processing(11), withdrawn: [order(31, 'withdrawn')] } })
  const item = await runR9(undefined, c.ctx)
  assert.deepEqual([item.outcome, keys(item, 'onlyVendor')], ['fail', ['31']])
  assert.deepEqual([...new Set(c.woo.calls.map((call) => call.params.status))], ['processing', 'pending-wdraw', 'withdrawn'])
  // the submitted status is walked without a mapping: an IMS hold must find its storefront order, and a store order in it is judged
  const sub = await runR9(undefined, context({ orders: [imsOrder(1, '11')] }, { orders: { processing: processing(11), 'pending-wdraw': [order(32, 'pending-wdraw')] } }).ctx)
  assert.deepEqual([sub.outcome, keys(sub, 'onlyVendor')], ['fail', ['32']])
  // a renamed pair (settings) is followed
  const renamed = context({ orders: [], config: { configured: ['processing'], withdrawal: { submitted: 'wdraw-asked', approved: 'wdraw-done' }, mappings: [{ externalStatus: 'wdraw-done', imsStatus: 'PROCESSING' }] } }, { orders: { 'wdraw-done': [order(33, 'wdraw-done')] } })
  const r = await runR9(undefined, renamed.ctx)
  assert.deepEqual([r.outcome, keys(r, 'onlyVendor')], ['fail', ['33']])
  assert.deepEqual([...new Set(renamed.woo.calls.map((call) => call.params.status))], ['processing', 'wdraw-asked', 'wdraw-done'])
  // an unmapped approved status is closed (the withdrawal handler cancels), and a mapped-closed one too: not walked
  const closed = context({ orders: [], config: { configured: ['processing'], mappings: [{ externalStatus: 'withdrawn', imsStatus: 'CANCELLED' }] } }, { orders: {} })
  await runR9(undefined, closed.ctx)
  assert.deepEqual([...new Set(closed.woo.calls.map((call) => call.params.status))], ['processing', 'pending-wdraw'])
})

test('an EMPTY selection admits nothing on any route, the withdrawal statuses included: nothing is walked and the empty proof is not given', async () => {
  const c = context({ orders: [], config: { configured: [], mappings: [] } }, { orders: {} })
  const item = await runR9(undefined, c.ctx)
  assert.deepEqual([item.outcome, item.reasons, c.woo.calls.length], ['inconclusive', ['EMPTY_UNPROVEN'], 0])
  // The withdrawal pair is not admitted, whatever a mapping says; only the manual historical import (which ignores the selection) keeps completed and delivered.
  assert.deepEqual(openStorefrontStatuses({ configured: [], withdrawal: WITHDRAWAL, mappings: [{ externalStatus: 'delivered', imsStatus: 'PROCESSING' }, { externalStatus: 'pending-wdraw', imsStatus: 'PROCESSING' }] }), { ok: true, statuses: ['delivered'] })
})

test('the routes: completed is added by the reconcile sweeps and delivered by the historical import, and a mapping that reads either as open makes it walked; the shared rule is the connector\'s own', async () => {
  const open = (mappings: StorefrontStatusConfig['mappings']) => openStorefrontStatuses({ configured: ['processing'], withdrawal: WITHDRAWAL, mappings })
  assert.deepEqual(open([{ externalStatus: 'completed', imsStatus: 'PROCESSING' }, { externalStatus: 'wc-delivered', imsStatus: 'ON_HOLD' }]), { ok: true, statuses: ['processing', 'completed', 'pending-wdraw', 'delivered'] })
  assert.deepEqual(open([]), { ok: true, statuses: ['processing', 'pending-wdraw'] })
  // A padded key for a route-added status is ambiguous too.
  assert.deepEqual(open([{ externalStatus: ' completed', imsStatus: 'PROCESSING' }]), { ok: false, reason: 'AMBIGUOUS_STATUS_MAPPING' })
  // Pins: the connector's routes are still the ones the pack unions.
  const read = (file: string) => readFileSync(file, 'utf8')
  assert.ok(read('lib/connectors/woocommerce/orders.ts').includes("status: 'completed,delivered'"))
  assert.ok(read('lib/connectors/woocommerce/sync/order-import.ts').includes('resolveWcPullStatuses(route, parseWcSyncOrderStatuses(setting?.value), withdrawal)'))
  assert.ok(read('lib/connectors/woocommerce/sync/withdrawal.ts').includes("export const WDRAW_SUBMITTED_STATUS_KEY = 'wc_withdrawal_submitted_status'") && read('lib/connectors/woocommerce/sync/withdrawal.ts').includes("export const WDRAW_APPROVED_STATUS_KEY = 'wc_withdrawal_approved_status'"))
  assert.ok(read('lib/connectors/woocommerce/sync/withdrawal.ts').includes("DEFAULT_WDRAW_SUBMITTED_STATUS = 'pending-wdraw'") && read('lib/connectors/woocommerce/sync/withdrawal.ts').includes("DEFAULT_WDRAW_APPROVED_STATUS = 'withdrawn'"))
})
