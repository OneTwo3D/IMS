import assert from 'node:assert/strict'
import test from 'node:test'

import { getPackItem } from '../../lib/reconciliation-pack/constants.ts'
import { bindingSignature, classifyWmsBindings, runWmsItem } from '../../lib/reconciliation-pack/wms-items.ts'
import { runVendorItem, type VendorItemContext } from '../../lib/reconciliation-pack/vendor-items.ts'
import type { ItemInput } from '../../lib/reconciliation-pack/report.ts'
import type { CarriedDifference } from '../../lib/reconciliation-pack/compare.ts'
import { carryFrom, S1, S2, S3 } from './settling-fixtures.ts'
import {
  binding, binding6, equalEstate, fakeWms, imsFor, link, noSleep, pair, product, PROBE_WH5, PROBE_WH6, toStockRow,
  type Estate, type FakeWmsData, type WmsTweak,
} from './wms-fixtures.ts'

/**
 * ITEM R1 over doubles of the IMS read and of the warehouse-system port, with the probe rows of the live tenant.
 * Mutations are listed in the PR.
 */

const keys = (item: ItemInput, bucket: string) => ((item.entries as Record<string, Array<{ key: string }>> | undefined)?.[bucket] ?? []).map((e) => e.key).sort()

function setup(estate: Estate, wms: FakeWmsData, tweak?: WmsTweak) {
  const port = fakeWms(wms, tweak)
  const ims = imsFor(estate)
  const ctx: VendorItemContext = { asOf: '2026-10-19', vendorReads: true, vendor: { wms: port }, ims: ims.ims, wmsOptions: { sleep: noSleep } }
  return { port, ims, ctx }
}

/** One run under a carried state and stamp; `runSettled` runs until nothing is unsettled (at most three distinct stamps). */
const once = (ctx: VendorItemContext, carried: ReadonlyMap<string, CarriedDifference>, stamp: string | null, usable = true) => runVendorItem('R1', { ...ctx, settling: { carried, usable, stamp } })
async function runSettled(ctx: VendorItemContext): Promise<ItemInput> {
  let carried: ReadonlyMap<string, CarriedDifference> = new Map()
  let last: ItemInput | null = null
  for (const stamp of [S1, S2, S3]) {
    last = await once(ctx, carried, stamp)
    if ((last.entries?.unsettled ?? []).length === 0) return last
    carried = carryFrom(last)
  }
  return last!
}

test('R1 passes when IMS holds Mintsoft\'s ON-HAND figure in every bound warehouse: Level (available) differs on two rows and is never compared', async () => {
  const { estate, wms } = equalEstate()
  const { ctx, port } = setup(estate, wms)
  const item = await runSettled(ctx)
  assert.equal(item.outcome, 'pass', JSON.stringify(item.reasons))
  assert.deepEqual(item.proof, { kind: 'compared' })
  assert.deepEqual(item.sources, [...getPackItem('R1').sources])
  // 10 comparable products x 2 warehouses, keyed by (warehouse, SKU); the bundle rows and the zero rows are not findings.
  assert.equal(keys(item, 'bothEqual').length, 20)
  assert.ok(keys(item, 'bothEqual').includes('MIL1|129552751'))
  assert.equal(PROBE_WH6.find((r) => r.SKU === '129552751')!.Level, 28, 'precondition: Level is 28 and on hand is 36')
  assert.deepEqual(keys(item, 'outOfPopulation'), ['EAR2|6878843248-23', 'EAR2|6878843248-24', 'MIL1|6878843248-23', 'MIL1|6878843248-24'], 'the bundle rows, derived stock, listed and not compared')
  assert.ok(port.calls.length > 0)
})

// [mutation: the available figure (Level) compared instead of the on-hand figure]
test('ON HAND, NOT AVAILABLE: IMS at Level (28) instead of TotalStockLevel (36) is a difference', async () => {
  const { estate, wms } = equalEstate()
  const p = estate.products.find((x) => x.sku === '129552751')!
  estate.stock = estate.stock.map((s) => (s.productId === p.id && s.warehouseCode === 'MIL1' ? { ...s, quantity: '28' } : s))
  const item = await runSettled(setup(estate, wms).ctx)
  assert.equal(item.outcome, 'fail')
  assert.deepEqual(item.reasons, ['DIFFERENCES'])
  assert.deepEqual(keys(item, 'bothDiffer'), ['MIL1|129552751'])
})

test('R1 SETTLES (D7): a difference first seen is UNSETTLED, never a failure; still there after two LATER distinct stamps it fails; a difference that goes away is dropped; stock that stays absent never settles without carried state', async () => {
  const { estate, wms } = equalEstate()
  const p = estate.products.find((x) => x.sku === '54524161462-01')!
  estate.stock = estate.stock.map((s) => (s.productId === p.id && s.warehouseCode === 'MIL1' ? { ...s, quantity: '2' } : s))
  const { ctx } = setup(estate, wms)
  assert.equal(getPackItem('R1').settles, true)
  const first = await once(ctx, new Map(), S1)
  assert.equal(first.outcome, 'inconclusive')
  assert.deepEqual(first.reasons, ['UNSETTLED_PENDING'])
  assert.deepEqual(keys(first, 'unsettled'), ['MIL1|54524161462-01'])
  const second = await once(ctx, carryFrom(first), S2)
  assert.deepEqual([second.outcome, second.reasons], ['inconclusive', ['UNSETTLED_PENDING']])
  const repeated = await once(ctx, carryFrom(second), S2)
  assert.deepEqual([repeated.outcome, repeated.reasons], ['inconclusive', ['UNSETTLED_PENDING']], 'a repeated stamp makes no progress')
  const third = await once(ctx, carryFrom(second), S3)
  assert.deepEqual([third.outcome, third.reasons], ['fail', ['DIFFERENCES']])
  assert.deepEqual(keys(third, 'bothDiffer'), ['MIL1|54524161462-01'])
  // The stock moved back in IMS: nothing is carried, nothing is listed.
  const healed = equalEstate()
  const gone = await once(setup(healed.estate, healed.wms).ctx, carryFrom(second), S3)
  assert.equal(gone.outcome, 'pass')
  // No usable carried state: SETTLING_STATE_UNUSABLE beside UNSETTLED_PENDING, never a failure, never a pass.
  const unusable = await once(ctx, new Map(), S3, false)
  assert.deepEqual(unusable.reasons, ['UNSETTLED_PENDING', 'SETTLING_STATE_UNUSABLE'])
  // Without the run's settling input at all there is no stamp to settle under: STALE_BASIS.
  assert.deepEqual((await runVendorItem('R1', ctx)).reasons, ['STALE_BASIS'])
})

test('a value that changes between runs is a NEW difference (first seen now), not a continuation', async () => {
  const { estate, wms } = equalEstate()
  const p = estate.products.find((x) => x.sku === '54524161462-01')!
  const setQuantity = (quantity: string) => { estate.stock = estate.stock.map((s) => (s.productId === p.id && s.warehouseCode === 'MIL1' ? { ...s, quantity } : s)) }
  setQuantity('2')
  const first = await once(setup(estate, wms).ctx, new Map(), S1)
  const second = await once(setup(estate, wms).ctx, carryFrom(first), S2)
  setQuantity('1')
  const changed = await once(setup(estate, wms).ctx, carryFrom(second), S3)
  assert.deepEqual([changed.outcome, changed.reasons], ['inconclusive', ['UNSETTLED_PENDING']])
})

test('ONLY ONE SIDE: a linked product Mintsoft does not list at all is onlyIms; Mintsoft stock for a SKU no IMS product carries is onlyVendor when positive and out of the population when zero', async () => {
  const { estate, wms } = equalEstate()
  const ghost = product(50, 'GHOST-1')
  estate.products.push(ghost)
  estate.links.push(link(ghost, '987654'))
  estate.stock.push(pair(ghost, estate.bindings[0]!, '4'))
  const extra = { sku: 'STRANGER-1', productId: '424242', onHand: 7, bundle: false }
  const zero = { sku: 'STRANGER-0', productId: '424243', onHand: 0, bundle: false }
  wms.stock['5'] = [...wms.stock['5']!, extra, zero]
  wms.stock['6'] = [...wms.stock['6']!, { ...extra }, { ...zero }]
  const item = await runSettled(setup(estate, wms).ctx)
  assert.equal(item.outcome, 'fail')
  assert.deepEqual(keys(item, 'onlyIms'), ['EAR2|GHOST-1', 'MIL1|GHOST-1'], 'the ghost is linked in IMS (4 in EAR2, none in MIL1) and absent from Mintsoft')
  assert.deepEqual(keys(item, 'onlyVendor'), ['EAR2|STRANGER-1', 'MIL1|STRANGER-1'])
  assert.ok(keys(item, 'outOfPopulation').includes('EAR2|STRANGER-0') && keys(item, 'outOfPopulation').includes('MIL1|STRANGER-0'))
})

test('IDENTITY SWAP: equal counts with two SKUs exchanged is two differences, never equal; and a product id swap between two linked SKUs is IDENTITY_CONFLICT', async () => {
  const { estate, wms } = equalEstate()
  const a = estate.products.find((x) => x.sku === '129552751')!
  const b = estate.products.find((x) => x.sku === '41352158742')!
  // IMS holds the OTHER SKU's quantity under each: 36 <-> 200 in MIL1. Counts agree; identities do not.
  estate.stock = estate.stock.map((s) => (s.warehouseCode === 'MIL1' && s.productId === a.id ? { ...s, quantity: '200' } : s.warehouseCode === 'MIL1' && s.productId === b.id ? { ...s, quantity: '36' } : s))
  const swapped = await runSettled(setup(estate, wms).ctx)
  assert.equal(swapped.outcome, 'fail')
  assert.deepEqual(keys(swapped, 'bothDiffer'), ['MIL1|129552751', 'MIL1|41352158742'])
  // The recorded vendor ids exchanged: SKU A is linked to B's id and the other way round.
  const links = equalEstate()
  const la = links.estate.links.find((l) => l.productId === a.id)!
  const lb = links.estate.links.find((l) => l.productId === b.id)!
  ;[la.externalProductId, lb.externalProductId] = [lb.externalProductId, la.externalProductId]
  const conflict = await runSettled(setup(links.estate, links.wms).ctx)
  assert.deepEqual([conflict.outcome, conflict.reasons], ['inconclusive', ['IDENTITY_CONFLICT']])
  // The stock list calls the SKU by another id than IMS recorded.
  const other = equalEstate()
  other.wms.stock['6'] = other.wms.stock['6']!.map((r) => (r.sku === '129552751' ? { ...r, productId: '5555' } : r))
  other.wms.stock['5'] = other.wms.stock['5']!.map((r) => (r.sku === '129552751' ? { ...r, productId: '5555' } : r))
  other.wms.census = [...new Map([...other.wms.stock['6']!, ...other.wms.stock['5']!].map((r) => [r.productId, { id: r.productId, sku: r.sku }] as const)).values()]
  assert.deepEqual((await runSettled(setup(other.estate, other.wms).ctx)).reasons, ['IDENTITY_CONFLICT'])
})

// [mutation: the census check removed, so a product the census lists but the stock list omits is read as a zero]
test('A PRODUCT THE CENSUS LISTS BUT THE STOCK LIST OMITS cannot be told from a zero: READ_INCOMPLETE for the whole item', async () => {
  const { estate, wms } = equalEstate()
  wms.census = [...new Map(Object.values(wms.stock).flat().map((r) => [r.productId, { id: r.productId, sku: r.sku }] as const)).values()]
  wms.stock['6'] = wms.stock['6']!.filter((r) => r.sku !== '22771122402-01')
  const item = await runSettled(setup(estate, wms).ctx)
  assert.deepEqual([item.outcome, item.reasons], ['inconclusive', ['READ_INCOMPLETE']])
})

test('LINKED OR LISTED: an unlinked product is compared when the census lists its SKU, and is out (listed, never a finding) when Mintsoft does not know it', async () => {
  const { estate, wms } = equalEstate()
  // 75641124454 loses its link (Mintsoft still lists it); a brand-new IMS product has neither a link nor a listing.
  const unlinked = estate.products.find((x) => x.sku === '75641124454')!
  estate.links = estate.links.filter((l) => l.productId !== unlinked.id)
  estate.stock = estate.stock.map((s) => (s.productId === unlinked.id && s.warehouseCode === 'MIL1' ? { ...s, quantity: '15' } : s))
  const fresh = product(60, 'ONLY-IN-IMS-1')
  estate.products.push(fresh)
  estate.stock.push(pair(fresh, estate.bindings[1]!, '9'))
  const item = await runSettled(setup(estate, wms).ctx)
  assert.equal(item.outcome, 'fail')
  assert.deepEqual(keys(item, 'bothDiffer'), ['MIL1|75641124454'], 'the missing link did not hide the stock Mintsoft holds (16 against 15)')
  assert.ok(keys(item, 'outOfPopulation').includes('MIL1|ONLY-IN-IMS-1'), 'no link and not listed: out, listed, not a finding')
  assert.ok(!keys(item, 'onlyIms').includes('MIL1|ONLY-IN-IMS-1'))
})

test('BUNDLES AND KITS: a KIT and a Mintsoft bundle row are set aside on both sides (derived stock, even where the figures differ); a kind mismatch either way is IDENTITY_CONFLICT', async () => {
  const { estate, wms } = equalEstate()
  const kit = product(70, '6878843248-24', 'KIT')
  estate.products.push(kit)
  estate.links.push(link(kit, '264466'))
  estate.stock.push(pair(kit, estate.bindings[1]!, '1')) // MIL1: Mintsoft's bundle row says 5
  const item = await runSettled(setup(estate, wms).ctx)
  assert.equal(item.outcome, 'pass', JSON.stringify(item.reasons))
  assert.ok(keys(item, 'outOfPopulation').includes('MIL1|6878843248-24'))
  assert.ok(!keys(item, 'bothDiffer').includes('MIL1|6878843248-24'), 'derived stock is not compared')
  // A plain IMS product the vendor lists as a bundle.
  const plain = equalEstate()
  plain.wms.stock['6'] = plain.wms.stock['6']!.map((r) => (r.sku === '129552751' ? { ...r, bundle: true } : r))
  plain.wms.stock['5'] = plain.wms.stock['5']!.map((r) => (r.sku === '129552751' ? { ...r, bundle: true } : r))
  assert.deepEqual((await runSettled(setup(plain.estate, plain.wms).ctx)).reasons, ['IDENTITY_CONFLICT'])
  // A KIT the vendor lists as a plain product.
  const asKit = equalEstate()
  asKit.estate.products = asKit.estate.products.map((p) => (p.sku === '129552751' ? { ...p, type: 'KIT' } : p))
  assert.deepEqual((await runSettled(setup(asKit.estate, asKit.wms).ctx)).reasons, ['IDENTITY_CONFLICT'])
  // Types that are not stock-tracked take no part, and a type this build does not know is unreadable.
  const types = equalEstate()
  types.estate.products.push(product(80, 'SERVICE-1', 'NON_INVENTORY'), product(81, 'PARENT-1', 'VARIABLE'))
  assert.equal((await runSettled(setup(types.estate, types.wms).ctx)).outcome, 'pass')
  types.estate.products.push(product(82, 'ODD-1', 'MYSTERY'))
  assert.deepEqual((await runSettled(setup(types.estate, types.wms).ctx)).reasons, ['SOURCE_UNREADABLE'])
})

// [mutation: alignmentState ignored, so a confirmed warehouse is read; or the confirmed/unconfirmed test inverted]
test('F5 POPULATION BY ALIGNMENT: NOTIFICATION_ONLY and ALIGN_TO_WMS without a confirmation are IN; a confirmed alignment, DISABLED and an inactive binding are OUT, never read from Mintsoft and listed with their IMS stock', async () => {
  const rows = (b: ReturnType<typeof binding>) => classifyWmsBindings([b])
  assert.deepEqual(rows(binding({ stockSyncMode: 'NOTIFICATION_ONLY', alignmentConfirmed: true }))!.inPopulation.length, 1, 'NOTIFICATION_ONLY is unconfirmed whatever the stamp says')
  assert.equal(rows(binding({ stockSyncMode: 'ALIGN_TO_WMS', alignmentConfirmed: false }))!.inPopulation.length, 1)
  assert.equal(rows(binding({ stockSyncMode: 'ALIGN_TO_WMS', alignmentConfirmed: true }))!.confirmed.length, 1)
  assert.equal(rows(binding({ stockSyncMode: 'DISABLED' }))!.notActive.length, 1)
  assert.equal(rows(binding({ active: false }))!.notActive.length, 1)
  assert.equal(rows(binding({ connector: 'other-wms' }))!.inPopulation.length + rows(binding({ connector: 'other-wms' }))!.confirmed.length + rows(binding({ connector: 'other-wms' }))!.notActive.length, 0, 'another connector is not this claim')
  // End to end: EAR2 is confirmed, MIL1 is not. Mintsoft is asked about MIL1 alone, and EAR2's wrong figure is never judged.
  const { estate, wms } = equalEstate([binding({ stockSyncMode: 'ALIGN_TO_WMS', alignmentConfirmed: true }), binding6()])
  estate.stock = estate.stock.map((s) => (s.warehouseCode === 'EAR2' ? { ...s, quantity: '99999' } : s))
  const { ctx, port } = setup(estate, wms)
  const item = await runSettled(ctx)
  assert.equal(item.outcome, 'pass', JSON.stringify(item.reasons))
  assert.deepEqual([...new Set(port.calls.filter((c) => c.kind === 'stock').map((c) => (c as { warehouse: string }).warehouse))], ['6'])
  assert.ok(keys(item, 'outOfPopulation').some((k) => k.startsWith('EAR2|')) && keys(item, 'bothEqual').every((k) => k.startsWith('MIL1|')))
  // Unknown states fail closed.
  for (const bad of [{ stockSyncMode: 'SOMETHING' }, { alignmentConfirmed: 'yes' }, { active: 1 }, { externalWarehouseId: 5 }]) {
    const broken = equalEstate([binding(bad as never), binding6()])
    assert.deepEqual((await runVendorItem('R1', { ...setup(broken.estate, broken.wms).ctx, settling: { carried: new Map(), usable: true, stamp: S1 } })).reasons, ['SOURCE_UNREADABLE'], JSON.stringify(bad))
  }
})

// [mutation: the alignment-confirmed empty proof granted when no binding exists, or the vendor port still called]
test('EVERY ALIGNMENT CONFIRMED: R1 passes on the named proof alignment-confirmed, names only the IMS source and asks Mintsoft nothing; no binding at all (or only disabled ones) is NO_POPULATION_RECORD', async () => {
  const { estate, wms } = equalEstate([binding({ stockSyncMode: 'ALIGN_TO_WMS', alignmentConfirmed: true }), binding6({ stockSyncMode: 'ALIGN_TO_WMS', alignmentConfirmed: true })])
  const { ctx, port, ims } = setup(estate, wms)
  const item = await runSettled(ctx)
  assert.equal(item.outcome, 'pass')
  assert.deepEqual(item.proof, { kind: 'proven-empty', source: 'alignment-confirmed' })
  assert.deepEqual(item.sources, ['ims-database'])
  assert.equal(port.calls.length, 0, 'nothing was asked of the vendor')
  assert.equal(ims.calls.length, 2 * 1, 'the snapshot and the second read of the bindings')
  const none = equalEstate([])
  const noneItem = await runSettled(setup(none.estate, none.wms).ctx)
  assert.deepEqual([noneItem.outcome, noneItem.reasons], ['inconclusive', ['NO_POPULATION_RECORD']])
  const off = equalEstate([binding({ stockSyncMode: 'DISABLED' }), binding6({ active: false })])
  assert.deepEqual((await runSettled(setup(off.estate, off.wms).ctx)).reasons, ['NO_POPULATION_RECORD'])
  const mixed = equalEstate([binding({ stockSyncMode: 'DISABLED' }), binding6({ stockSyncMode: 'ALIGN_TO_WMS', alignmentConfirmed: true })])
  assert.equal((await runSettled(setup(mixed.estate, mixed.wms).ctx)).outcome, 'pass', 'one confirmed and the rest not active: retired')
})

// [mutation: the second read of the bindings removed]
test('A BINDING THAT CHANGED WHILE MINTSOFT WAS BEING READ (confirmed, re-pointed, disabled, activated) is BASIS_MOVED, in the vendor path and in the retired path', async () => {
  const moves: Array<[string, (b: ReturnType<typeof binding>) => ReturnType<typeof binding>]> = [
    ['confirmed', (b) => ({ ...b, stockSyncMode: 'ALIGN_TO_WMS', alignmentConfirmed: true })],
    ['re-pointed', (b) => ({ ...b, externalWarehouseId: '55' })],
    ['disabled', (b) => ({ ...b, stockSyncMode: 'DISABLED' })],
    ['deactivated', (b) => ({ ...b, active: false })],
  ]
  for (const [label, move] of moves) {
    const { estate, wms } = equalEstate()
    estate.bindingsAfter = [move(estate.bindings[0]!), estate.bindings[1]!]
    const item = await runSettled(setup(estate, wms).ctx)
    assert.deepEqual([item.outcome, item.reasons], ['inconclusive', ['BASIS_MOVED']], label)
  }
  const retired = equalEstate([binding({ stockSyncMode: 'ALIGN_TO_WMS', alignmentConfirmed: true })])
  retired.estate.bindingsAfter = [binding()]
  assert.deepEqual((await runSettled(setup(retired.estate, retired.wms).ctx)).reasons, ['BASIS_MOVED'])
  assert.equal(bindingSignature([binding()]), bindingSignature([binding()]))
  assert.notEqual(bindingSignature([binding()]), bindingSignature([binding({ alignmentConfirmed: true })]))
})

test('EXACT: an IMS quantity that is not a whole number is BAD_VALUE (it cannot equal a whole number, and 0.0001 must not absorb it); a product with no stock row holds 0 and equals Mintsoft\'s 0', async () => {
  const { estate, wms } = equalEstate()
  const p = estate.products.find((x) => x.sku === '129552751')!
  estate.stock = estate.stock.map((s) => (s.productId === p.id && s.warehouseCode === 'MIL1' ? { ...s, quantity: '36.0001' } : s))
  assert.deepEqual((await runSettled(setup(estate, wms).ctx)).reasons, ['BAD_VALUE'])
  const whole = equalEstate()
  whole.estate.stock = whole.estate.stock.map((s) => (s.productId === p.id && s.warehouseCode === 'MIL1' ? { ...s, quantity: '36.0000' } : s))
  assert.equal((await runSettled(setup(whole.estate, whole.wms).ctx)).outcome, 'pass', 'a stored 36.0000 is 36')
  const zero = equalEstate()
  const z = zero.estate.products.find((x) => x.sku === '22771122402-01')!
  zero.estate.stock = zero.estate.stock.filter((s) => s.productId !== z.id)
  assert.equal((await runSettled(setup(zero.estate, zero.wms).ctx)).outcome, 'pass', 'no row is zero, as the sync reads it')
})

test('R1 IS TOTAL AND OPT-IN: without the flag nothing is read and no port or IMS read is touched; a missing port or IMS read, a failing read, a throwing read and every failed section are closed reasons', async () => {
  const { estate, wms } = equalEstate()
  const off = setup(estate, wms)
  for (const vendorReads of [undefined, false, 'true', 1] as const) {
    const item = await runVendorItem('R1', { ...off.ctx, vendorReads: vendorReads as never })
    assert.deepEqual([item.outcome, item.reasons], ['inconclusive', ['VENDOR_READS_OFF']])
    assert.equal(item.sources, undefined)
  }
  assert.equal(off.port.calls.length, 0)
  assert.equal(off.ims.calls.length, 0)
  // The module guards itself too (the dispatcher's own check is a second, independent one).
  for (const vendorReads of [undefined, false, 'true', 1] as const) {
    const direct = await runWmsItem({ vendorReads: vendorReads as never, wms: off.ctx.vendor!.wms!, ims: off.ctx.ims, wmsOptions: { sleep: noSleep }, settling: { carried: new Map(), usable: true, stamp: S1 } })
    assert.deepEqual([direct.outcome, direct.reasons], ['inconclusive', ['VENDOR_READS_OFF']])
  }
  assert.equal(off.port.calls.length, 0)
  assert.equal(off.ims.calls.length, 0)
  const settling = { carried: new Map(), usable: true, stamp: S1 }
  assert.deepEqual((await runVendorItem('R1', { ...off.ctx, settling, vendor: {} })).reasons, ['SOURCE_UNREADABLE'])
  assert.deepEqual((await runVendorItem('R1', { ...off.ctx, settling, ims: undefined })).reasons, ['SOURCE_UNREADABLE'])
  for (const fail of ['read', 'throws'] as const) {
    const broken = equalEstate()
    broken.estate.fail = fail
    const item = await runVendorItem('R1', { ...setup(broken.estate, broken.wms).ctx, settling })
    assert.deepEqual(item.reasons, fail === 'read' ? ['READ_INCOMPLETE'] : ['INTERNAL_ERROR'])
  }
  for (const section of ['wmsBindings', 'wmsProductLinks', 'products', 'stock'] as const) {
    const broken = equalEstate()
    broken.estate.fail = { [section]: 'CAP_EXCEEDED' }
    const item = await runVendorItem('R1', { ...setup(broken.estate, broken.wms).ctx, settling })
    assert.deepEqual([item.outcome, item.reasons], ['inconclusive', ['CAP_EXCEEDED']], section)
  }
  const port = fakeWms(wms, () => ({ ok: false, reason: 'VENDOR_AUTH_REFUSED' }))
  const refused = await runVendorItem('R1', { ...setup(estate, wms).ctx, vendor: { wms: port }, settling })
  assert.deepEqual([refused.outcome, refused.reasons], ['inconclusive', ['VENDOR_AUTH_REFUSED']])
  const unstable = fakeWms(wms, (call, n) => (call.kind === 'stock' && n === 3 ? { ok: true, value: wms.stock['5']!.slice(1) } : undefined))
  assert.deepEqual((await runVendorItem('R1', { ...setup(estate, wms).ctx, vendor: { wms: unstable }, settling })).reasons, ['VENDOR_READ_UNSTABLE'])
})

test('EMPTY ESTATE: an unconfirmed binding with no products, no stock rows and an empty census passes only on the named proof vendor-total-zero; with Mintsoft rows nothing of IMS\'s it is not a proof', async () => {
  const { estate } = equalEstate()
  estate.products = []; estate.links = []; estate.stock = []
  const proven = await runSettled(setup(estate, { stock: { '5': [], '6': [] }, census: [] }).ctx)
  assert.equal(proven.outcome, 'pass')
  assert.deepEqual(proven.proof, { kind: 'proven-empty', source: 'vendor-total-zero' })
  assert.deepEqual(proven.sources, [...getPackItem('R1').sources])
  const zeros = await runSettled(setup(estate, { stock: { '5': PROBE_WH5.map(toStockRow).filter((r) => r.bundle), '6': PROBE_WH6.map(toStockRow).filter((r) => r.bundle) } }).ctx)
  assert.deepEqual([zeros.outcome, zeros.reasons], ['inconclusive', ['EMPTY_UNPROVEN']], 'only set-aside rows were read: nothing was compared and nothing proves empty')
})

// [mutation: the census-wide stock-row requirement removed]
test('EVERY NON-BUNDLE CENSUS PRODUCT NEEDS A STOCK ROW IN EVERY BOUND WAREHOUSE, IMS has it or not: a census SKU absent from IMS and from one warehouse\'s stock list is READ_INCOMPLETE; a bundle is exempt', async () => {
  const stranger = { sku: 'CENSUS-ONLY-1', productId: '777777', onHand: 0, bundle: false }
  const censusOf = (wms: FakeWmsData) => [...new Map(Object.values(wms.stock).flat().map((r) => [r.productId, { id: r.productId, sku: r.sku }] as const)).values()]
  // In warehouse 5 only: otherwise everything is equal, and IMS knows nothing of it.
  const missing = equalEstate()
  missing.wms.stock['5'] = [...missing.wms.stock['5']!, stranger]
  missing.wms.census = censusOf(missing.wms)
  const item = await runSettled(setup(missing.estate, missing.wms).ctx)
  assert.deepEqual([item.outcome, item.reasons], ['inconclusive', ['READ_INCOMPLETE']])
  // Present (as zero) in both: fine, it is out of the population.
  const both = equalEstate()
  both.wms.stock['5'] = [...both.wms.stock['5']!, stranger]
  both.wms.stock['6'] = [...both.wms.stock['6']!, { ...stranger }]
  both.wms.census = censusOf(both.wms)
  assert.equal((await runSettled(setup(both.estate, both.wms).ctx)).outcome, 'pass')
  // A bundle listed in one warehouse only is derived stock: exempt from the requirement.
  const bundle = equalEstate()
  bundle.wms.stock['5'] = [...bundle.wms.stock['5']!, { ...stranger, bundle: true }]
  bundle.wms.census = censusOf(bundle.wms)
  assert.equal((await runSettled(setup(bundle.estate, bundle.wms).ctx)).outcome, 'pass')
  // A census product with no stock row anywhere is just as unproven.
  const nowhere = equalEstate()
  nowhere.wms.census = [...censusOf(nowhere.wms), { id: '888888', sku: 'NOWHERE-1' }]
  assert.deepEqual((await runSettled(setup(nowhere.estate, nowhere.wms).ctx)).reasons, ['READ_INCOMPLETE'])
})
