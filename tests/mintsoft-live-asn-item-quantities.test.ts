import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MINTSOFT_ASN_ITEM_ARRIVED_QTY_KEY,
  MINTSOFT_ASN_ITEM_BOOKED_QTY_KEY,
  MINTSOFT_ASN_ITEM_EXPECTED_QTY_KEY,
  MINTSOFT_ASN_RECEIPT_BASIS,
  readMintsoftAsnItemReceipt,
} from '@/lib/connectors/mintsoft/api/asn-quantities'
import { normalizeMintsoftAsn } from '@/lib/connectors/mintsoft/api/normalizers'
import { normalizeMintsoftAsnFetchByIdResult } from '@/lib/connectors/mintsoft/api/client'
import { buildBookedInDryRun, resolveRemoteBookedInQuantity } from '@/lib/domain/wms/asn-reconciliation'
import type { WmsAsnRef } from '@/lib/connectors/wms/types'
import * as fakeMintsoftRouteNs from '../app/api/e2e/mintsoft/[...slug]/route.ts'
import {
  IMAGINED_ASN_ITEM_QUANTITY_KEYS,
  LIVE_ASN_ITEM_QUANTITY_KEYS,
  LIVE_ASN_SOURCE_LINE_ID,
  liveAsnBody,
  liveAsnItem,
} from '@/tests/fixtures/mintsoft-live-asn-bodies'

const fakeMintsoftRoute = 'default' in fakeMintsoftRouteNs
  ? fakeMintsoftRouteNs.default as typeof import('../app/api/e2e/mintsoft/[...slug]/route.ts')
  : fakeMintsoftRouteNs

/**
 * o3d-btiw — BOOKED-IN READS THE QUANTITIES A LIVE MINTSOFT ASN ITEM ACTUALLY CARRIES.
 *
 * WHAT WAS WRONG. `normalizeMintsoftAsnLine` read one `quantity` over
 * `qty`/`Qty`/`quantity`/`Quantity`/`returnedQty`/`receivedQty`, and a live `ASNItem` carries NONE of
 * them — its quantities are `QuantityExpected`, `QuantityReceieved` (Mintsoft's own misspelling),
 * `QuantityBooked` and `OnOrder`, confirmed on 3098 of 3098 items over 223 ASNs on both
 * `GET /api/ASN/{id}` and `GET /api/ASN/List?IncludeASNItems=true` (read-only GETs, ClientId 89,
 * 2026-09-18 and 2026-09-24; recorded on bd o3d-vcw8 and o3d-btiw). So every live line normalized to
 * `quantity: null`, `booked-in-service.ts` read `Math.max(0, Number(null ?? 0))` = 0 received for
 * every line, applied nothing and reported itself PROCESSED; on a second callback it reported the
 * warehouse as having gone BACKWARDS (`remote_regression`).
 *
 * NO TEST HERE MAKES A MINTSOFT CALL. The wire shape is a recorded fixture
 * (tests/fixtures/mintsoft-live-asn-bodies.ts) precisely so that it never has to be re-probed. The
 * one thing in that fixture that is NOT a live observation is a NON-ZERO receipt quantity: every
 * readable live item had `QuantityReceieved` and `QuantityBooked` at 0, because a live book-in moves
 * stock and was never authorised. The KEY NAMES are fact; those two numbers are ours, and each test
 * below says so where it matters.
 */

const ASN_LINE_MAP_ID = 'asnlinemap-1'
const EXTERNAL_LINE_ID = '57449'

function normalizedLiveAsn(items: readonly Record<string, unknown>[], statusName = 'BOOKEDIN'): WmsAsnRef {
  const asn = normalizeMintsoftAsnFetchByIdResult('6117', {
    status: 200,
    data: liveAsnBody({ items, statusName }),
  })
  assert.ok(asn, 'PRECONDITION: the live ASN body must normalize at all')
  return asn
}

function dryRunOverRemote(remote: WmsAsnRef, options: {
  expectedQty: number
  lastProcessedReceivedQty?: number
  localReceivedQty?: number
}) {
  const remoteLine = remote.lines.find((line) => line.sourceLineId === LIVE_ASN_SOURCE_LINE_ID)
  const resolved = resolveRemoteBookedInQuantity(remoteLine)
  const lastProcessedReceivedQty = options.lastProcessedReceivedQty ?? 0
  // THE PRODUCTION EXPRESSION from lib/domain/wms/booked-in-service.ts, so this test and the service
  // cannot drift: a refusal pins the line to what is already processed, otherwise the booked quantity.
  const currentRemoteReceivedQty = resolved.refusal
    ? lastProcessedReceivedQty
    : Math.max(0, resolved.bookedIntoStockQty ?? 0)
  const dryRun = buildBookedInDryRun({
    externalAsnId: remote.externalAsnId,
    generatedAt: new Date('2026-09-24T10:00:00Z'),
    lines: [{
      asnLineMapId: ASN_LINE_MAP_ID,
      externalAsnLineId: EXTERNAL_LINE_ID,
      sourceType: 'PURCHASE_ORDER_LINE',
      sourceLineId: LIVE_ASN_SOURCE_LINE_ID,
      productId: 'prod-1',
      sku: '22771122402-02',
      expectedQty: options.expectedQty,
      currentRemoteReceivedQty,
      localReceivedQty: options.localReceivedQty ?? lastProcessedReceivedQty,
      lastProcessedReceivedQty,
      localLineExists: true,
      remoteQuantityRefusal: resolved.refusal,
      remoteArrivedQty: resolved.arrivedAtWarehouseQty,
      remoteQuantityBasis: resolved.basis,
    }],
  })
  return { resolved, dryRun, line: dryRun.lines[0]!, remoteLine }
}

// ---------------------------------------------------------------------------
// The premise, checked rather than asserted in prose
// ---------------------------------------------------------------------------

test('PREMISE: a live ASN item carries NONE of the quantity keys the old normalizer looked for', () => {
  const item = liveAsnItem()
  const keys = Object.keys(item)
  // UNIVERSAL, not existential: every imagined key must be absent. An `includes`-style check on one
  // of them would be satisfied while the others stood.
  const present = IMAGINED_ASN_ITEM_QUANTITY_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(item, key))
  assert.deepEqual(present, [], `the live item must carry none of ${IMAGINED_ASN_ITEM_QUANTITY_KEYS.join('/')}`)
  assert.equal(
    IMAGINED_ASN_ITEM_QUANTITY_KEYS.length,
    10,
    'PRECONDITION: all ten RETURN_QTY_KEYS must be under test, not a subset',
  )
  for (const key of LIVE_ASN_ITEM_QUANTITY_KEYS) {
    assert.ok(keys.includes(key), `the live item must carry ${key}`)
  }
  assert.equal(LIVE_ASN_ITEM_QUANTITY_KEYS.length, 4)
  assert.ok(keys.length >= 20, `NON-VACUITY: the fixture item examined ${keys.length} keys`)
})

// ---------------------------------------------------------------------------
// The fix: the booked quantity is read, and it is credited
// ---------------------------------------------------------------------------

test('a booked-in live ASN credits the QuantityBooked units (the o3d-btiw repro, now green)', () => {
  // CONSTRUCTED VALUES: 12 booked and 12 arrived. No authorised live read ever saw a non-zero receipt
  // quantity, so these two numbers are ours; every key they sit on is recorded live fact.
  const remote = normalizedLiveAsn([liveAsnItem({ expected: 12, received: 12, booked: 12, complete: true })])
  assert.equal(remote.lines.length, 1, 'PRECONDITION: the live body must yield exactly one line')

  const { resolved, line } = dryRunOverRemote(remote, { expectedQty: 12 })
  assert.equal(resolved.refusal, null)
  assert.equal(resolved.bookedIntoStockQty, 12)
  assert.equal(resolved.arrivedAtWarehouseQty, 12)
  assert.equal(resolved.basis, MINTSOFT_ASN_RECEIPT_BASIS)

  // BEFORE THE FIX this line read stockQtyToAdd 0 with NO warnings at all, i.e. `processed`.
  assert.equal(line.currentRemoteReceivedQty, 12)
  assert.equal(line.qtyReceived, 12)
  assert.equal(line.stockQtyToAdd, 12)
  assert.equal(line.wouldCreateCostLayer, true)
  assert.deepEqual(line.warnings, [])
})

test('the EXPECTED quantity comes from QuantityExpected, and it is not the receipt', () => {
  const remote = normalizedLiveAsn([liveAsnItem({ expected: 20, received: 0, booked: 0 })])
  const remoteLine = remote.lines[0]!
  assert.equal(remoteLine.expectedQty, 20, `must read ${MINTSOFT_ASN_ITEM_EXPECTED_QTY_KEY}`)
  assert.equal(remoteLine.receipt.kind, 'reported')
  assert.equal(remoteLine.receipt.kind === 'reported' && remoteLine.receipt.bookedIntoStockQty, 0)
  // ZERO BOOKED IS A MEASUREMENT: an ASN awaiting delivery really has had nothing booked in, so it
  // must NOT refuse — it must simply have nothing to apply.
  const { line, resolved } = dryRunOverRemote(remote, { expectedQty: 20 })
  assert.equal(resolved.refusal, null)
  assert.equal(line.stockQtyToAdd, 0)
  assert.deepEqual(line.warnings, [])
})

test('the ASN HEADER Quantity is a package count and is never read as a quantity of goods', () => {
  // Live fact: header Quantity equalled Σ Items.QuantityExpected on only 3 of 223 ASNs (6114: header
  // 1 against 76 units over 7 items).
  const body = liveAsnBody({ packageCount: 1, items: [liveAsnItem({ expected: 76, booked: 76 })] })
  assert.equal(body.Quantity, 1, 'PRECONDITION: the header must disagree with the item total')
  const asn = normalizeMintsoftAsn(body, { externalAsnIdFallback: '6114' })
  assert.ok(asn)
  assert.equal(asn.lines[0]!.expectedQty, 76)
  assert.equal(asn.lines[0]!.receipt.kind === 'reported' && asn.lines[0]!.receipt.bookedIntoStockQty, 76)
})

// ---------------------------------------------------------------------------
// The delta path
// ---------------------------------------------------------------------------

test('DELTA: a second callback applies only the new units and raises no regression', () => {
  const remote = normalizedLiveAsn([liveAsnItem({ expected: 12, received: 12, booked: 12, complete: true })])
  const { line } = dryRunOverRemote(remote, { expectedQty: 12, lastProcessedReceivedQty: 6, localReceivedQty: 6 })
  // BEFORE THE FIX this read currentRemoteReceivedQty 0 against 6 already processed, i.e.
  // `remote_regression` — "Mintsoft quantity decreased" — about a warehouse that had booked in all 12.
  assert.equal(line.currentRemoteReceivedQty, 12)
  assert.equal(line.qtyReceived, 6)
  assert.equal(line.stockQtyToAdd, 6)
  assert.ok(!line.warnings.includes('remote_regression'), `warnings were ${JSON.stringify(line.warnings)}`)
})

test('DELTA: a genuine remote decrease still raises remote_regression — the check is not disabled', () => {
  // The guard above must not have been bought by suppressing the warning outright.
  const remote = normalizedLiveAsn([liveAsnItem({ expected: 12, received: 4, booked: 4 })])
  const { line } = dryRunOverRemote(remote, { expectedQty: 12, lastProcessedReceivedQty: 9, localReceivedQty: 9 })
  assert.equal(line.currentRemoteReceivedQty, 4)
  assert.ok(line.warnings.includes('remote_regression'), `warnings were ${JSON.stringify(line.warnings)}`)
})

// ---------------------------------------------------------------------------
// Received vs booked: the decision, and the other number staying visible
// ---------------------------------------------------------------------------

test('RECEIVED vs BOOKED: IMS books QuantityBooked, and never the larger of the two', () => {
  // CONSTRUCTED: 10 arrived at the warehouse, 6 booked into its stock.
  const remote = normalizedLiveAsn([liveAsnItem({ expected: 12, received: 10, booked: 6 })])
  const { resolved, line } = dryRunOverRemote(remote, { expectedQty: 12 })
  assert.equal(resolved.bookedIntoStockQty, 6, 'the booked quantity is what IMS acts on')
  assert.equal(line.stockQtyToAdd, 6, 'six units of stock, not ten')
  // The other fact is CARRIED, not discarded: it lands on the dry run (and so on
  // wms_inbound_receipt_events.reviewDetails) and in the processed-event activity log.
  assert.equal(resolved.arrivedAtWarehouseQty, 10)
  assert.equal(line.remoteArrivedQty, 10)
  assert.equal(line.remoteQuantityBasis, MINTSOFT_ASN_RECEIPT_BASIS)
})

test('RECEIVED vs BOOKED: booked ABOVE arrived is still the booked quantity, so it is not a min either', () => {
  // Not a physical expectation, but it pins the rule as "read one field" rather than "pick an extreme".
  const remote = normalizedLiveAsn([liveAsnItem({ expected: 12, received: 3, booked: 9 })])
  const { resolved, line } = dryRunOverRemote(remote, { expectedQty: 12 })
  assert.equal(resolved.bookedIntoStockQty, 9)
  assert.equal(line.stockQtyToAdd, 9)
  assert.equal(line.remoteArrivedQty, 3)
})

test(`an unreadable ${MINTSOFT_ASN_ITEM_ARRIVED_QTY_KEY} does not make the booked quantity unusable`, () => {
  const remote = normalizedLiveAsn([liveAsnItem({ expected: 5, booked: 5, omit: [MINTSOFT_ASN_ITEM_ARRIVED_QTY_KEY] })])
  const { resolved, line } = dryRunOverRemote(remote, { expectedQty: 5 })
  assert.equal(resolved.refusal, null)
  assert.equal(resolved.arrivedAtWarehouseQty, null, 'null is "not reported", not "nothing arrived"')
  assert.equal(line.stockQtyToAdd, 5)
})

// ---------------------------------------------------------------------------
// Absent is not zero
// ---------------------------------------------------------------------------

const UNREADABLE_CASES: Array<{ name: string; item: Record<string, unknown> }> = [
  { name: 'the key is absent (shape drift)', item: liveAsnItem({ expected: 9, received: 9, omit: [MINTSOFT_ASN_ITEM_BOOKED_QTY_KEY] }) },
  { name: 'it is null', item: liveAsnItem({ expected: 9, received: 9, poison: { [MINTSOFT_ASN_ITEM_BOOKED_QTY_KEY]: null } }) },
  { name: 'it is a non-numeric string', item: liveAsnItem({ expected: 9, received: 9, poison: { [MINTSOFT_ASN_ITEM_BOOKED_QTY_KEY]: 'nine' } }) },
  { name: 'it is NaN (typeof number!)', item: liveAsnItem({ expected: 9, received: 9, poison: { [MINTSOFT_ASN_ITEM_BOOKED_QTY_KEY]: Number.NaN } }) },
  { name: 'it is Infinity (typeof number!)', item: liveAsnItem({ expected: 9, received: 9, poison: { [MINTSOFT_ASN_ITEM_BOOKED_QTY_KEY]: Number.POSITIVE_INFINITY } }) },
  { name: 'it is negative', item: liveAsnItem({ expected: 9, received: 9, poison: { [MINTSOFT_ASN_ITEM_BOOKED_QTY_KEY]: -3 } }) },
  { name: 'it is an object', item: liveAsnItem({ expected: 9, received: 9, poison: { [MINTSOFT_ASN_ITEM_BOOKED_QTY_KEY]: { Qty: 9 } } }) },
]

test('UNKNOWN IS NOT ZERO: an unreadable booked quantity refuses instead of applying nothing', () => {
  let examined = 0
  for (const { name, item } of UNREADABLE_CASES) {
    examined += 1
    const remote = normalizedLiveAsn([item])
    const { resolved, line } = dryRunOverRemote(remote, { expectedQty: 9, lastProcessedReceivedQty: 4, localReceivedQty: 4 })

    assert.equal(resolved.bookedIntoStockQty, null, name)
    assert.equal(resolved.refusal?.code, 'remote_quantity_unreadable', name)
    assert.match(String(resolved.refusal?.detail), /QuantityBooked/, name)

    // NOT ZERO: the line is pinned to what is already processed, so nothing is applied…
    assert.equal(line.currentRemoteReceivedQty, 4, name)
    assert.equal(line.stockQtyToAdd, 0, name)
    assert.equal(line.wouldCreateReceipt, false, name)
    // …and the reason is VISIBLE rather than implied by a zero.
    assert.ok(line.warnings.includes('remote_quantity_unreadable'), `${name}: ${JSON.stringify(line.warnings)}`)
    assert.equal(line.remoteQuantityRefusal?.code, 'remote_quantity_unreadable', name)
    // THE OTHER QUANTITY SURVIVES THE REFUSAL. `QuantityReceieved` is readable in every case here, and
    // a refusal is the last place to go quiet: it is the only number the warehouse served.
    assert.equal(resolved.arrivedAtWarehouseQty, 9, name)
    assert.equal(line.remoteArrivedQty, 9, name)
    // AND IT MUST NOT CLAIM THE WAREHOUSE WENT BACKWARDS. A fabricated 0 against 4 processed reads as
    // a regression, which renders to the operator as "Mintsoft quantity decreased" — a false statement
    // about a warehouse that said nothing at all.
    assert.ok(!line.warnings.includes('remote_regression'), `${name}: ${JSON.stringify(line.warnings)}`)
    assert.ok(!line.warnings.includes('received_over_expected'), `${name}: ${JSON.stringify(line.warnings)}`)
  }
  assert.equal(examined, 7, `NON-VACUITY: ${examined} unreadable shapes were examined`)
})

test('UNKNOWN IS NOT ZERO: a local ASN line with no remote item refuses too', () => {
  const remote = normalizedLiveAsn([liveAsnItem({ sourceLineId: 'someone-elses-line', id: 999 })])
  const resolved = resolveRemoteBookedInQuantity(
    remote.lines.find((line) => line.sourceLineId === LIVE_ASN_SOURCE_LINE_ID),
  )
  assert.equal(resolved.refusal?.code, 'missing_remote_line')
  const { line } = dryRunOverRemote(remote, { expectedQty: 9, lastProcessedReceivedQty: 4, localReceivedQty: 4 })
  assert.equal(line.currentRemoteReceivedQty, 4)
  assert.equal(line.stockQtyToAdd, 0)
  assert.ok(line.warnings.includes('missing_remote_line'), JSON.stringify(line.warnings))
  assert.ok(!line.warnings.includes('remote_regression'))
})

test('a refusal is honoured by buildBookedInDryRun even if the caller passes a quantity anyway', () => {
  // Defence in depth: the pin lives in the pure function too, so a future caller that forgets cannot
  // reintroduce the fabricated number.
  const dryRun = buildBookedInDryRun({
    externalAsnId: '6117',
    generatedAt: new Date('2026-09-24T10:00:00Z'),
    lines: [{
      asnLineMapId: ASN_LINE_MAP_ID,
      externalAsnLineId: EXTERNAL_LINE_ID,
      sourceType: 'PURCHASE_ORDER_LINE',
      sourceLineId: LIVE_ASN_SOURCE_LINE_ID,
      productId: 'prod-1',
      sku: 'SKU',
      expectedQty: 12,
      currentRemoteReceivedQty: 12,
      localReceivedQty: 3,
      lastProcessedReceivedQty: 3,
      localLineExists: true,
      remoteQuantityRefusal: { code: 'remote_quantity_unreadable', detail: 'test' },
    }],
  })
  assert.equal(dryRun.lines[0]!.currentRemoteReceivedQty, 3, 'the passed 12 must be ignored')
  assert.equal(dryRun.lines[0]!.stockQtyToAdd, 0)
  assert.deepEqual(dryRun.warnings, ['remote_quantity_unreadable'])
})

// ---------------------------------------------------------------------------
// The reader in isolation
// ---------------------------------------------------------------------------

test('readMintsoftAsnItemReceipt never falls back from QuantityBooked to QuantityReceieved', () => {
  const receipt = readMintsoftAsnItemReceipt(
    liveAsnItem({ expected: 9, received: 9, omit: [MINTSOFT_ASN_ITEM_BOOKED_QTY_KEY] }),
  )
  assert.equal(receipt.kind, 'unreadable')
  // The number IS there, on the other key. Any fallback or Math.max would have produced 9 as the
  // BOOKED quantity — but it is still reported as the ARRIVED one, which is not a substitute.
  assert.equal(receipt.kind === 'unreadable' && /\b9\b/.test(receipt.detail), false)
  assert.equal(receipt.kind === 'unreadable' && receipt.arrivedAtWarehouseQty, 9)
})

test('a numeric STRING quantity is accepted (int32 fields have come back as strings before)', () => {
  const receipt = readMintsoftAsnItemReceipt(liveAsnItem({ poison: { QuantityBooked: '7', QuantityReceieved: '8' } }))
  assert.deepEqual(receipt, {
    kind: 'reported',
    bookedIntoStockQty: 7,
    arrivedAtWarehouseQty: 8,
    basis: MINTSOFT_ASN_RECEIPT_BASIS,
  })
})

// ---------------------------------------------------------------------------
// The e2e fake
// ---------------------------------------------------------------------------

test('the e2e fake serves GET /api/ASN/{id} in the live ASN/ASNItem shape', () => {
  const body = fakeMintsoftRoute.fakeMintsoftAsnById({
    id: '6117',
    warehouseId: '6',
    reference: 'PO-FAKE-1',
    supplierReference: null,
    carrier: null,
    eta: null,
    callbackUrl: null,
    autoCallback: false,
    status: 'BOOKEDIN',
    createdAt: '2026-09-24T09:40:00.000Z',
    lines: [{ id: 'L1', sourceLineId: 'line-1', productId: '263881', sku: 'SKU-1', quantity: 12, receivedQuantity: 12, bookedQuantity: 12 }],
  } as never) as Record<string, unknown>

  // The invented shape is GONE — universal absence, not an existential "the new key is present".
  for (const invented of ['AsnId', 'Reference', 'Status', 'Lines', 'CallbackUrl', 'AutoCallback', 'ETA', 'SupplierReference', 'Carrier']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(body, invented), `the fake must not serve ${invented}`)
  }
  assert.equal(body.ID, 6117)
  assert.equal(body.POReference, 'PO-FAKE-1')
  assert.deepEqual(Object.keys(body.ASNStatus as object).sort(), ['Colour', 'ID', 'Name', 'TextColour'])

  const items = body.Items as Array<Record<string, unknown>>
  assert.equal(items.length, 1)
  for (const key of LIVE_ASN_ITEM_QUANTITY_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(items[0]!, key), `the fake item must carry ${key}`)
  }
  const stillImagined = IMAGINED_ASN_ITEM_QUANTITY_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(items[0]!, key))
  assert.deepEqual(stillImagined, [], 'the fake item must carry none of the imagined quantity keys')

  // AND THE REAL NORMALIZER MUST READ IT. A fake in the right shape that production cannot parse is
  // the same failure from the other side.
  const asn = normalizeMintsoftAsnFetchByIdResult('6117', { status: 200, data: body })
  assert.ok(asn, 'the fake body must normalize')
  assert.equal(asn.lines.length, 1)
  assert.equal(asn.lines[0]!.expectedQty, 12)
  assert.equal(asn.lines[0]!.receipt.kind === 'reported' && asn.lines[0]!.receipt.bookedIntoStockQty, 12)
})

test('the e2e fake can express an ASN that has arrived but is not booked in', () => {
  const body = fakeMintsoftRoute.fakeMintsoftAsnById({
    id: '6118',
    warehouseId: '6',
    reference: 'PO-FAKE-2',
    supplierReference: null,
    carrier: null,
    eta: null,
    callbackUrl: null,
    autoCallback: false,
    status: 'DELIVERED',
    createdAt: '2026-09-24T09:40:00.000Z',
    lines: [{ id: 'L1', sourceLineId: 'line-1', productId: '1', sku: 'SKU-1', quantity: 12, receivedQuantity: 12, bookedQuantity: 0 }],
  } as never) as Record<string, unknown>
  const item = (body.Items as Array<Record<string, unknown>>)[0]!
  assert.equal(item.QuantityReceieved, 12)
  assert.equal(item.QuantityBooked, 0)
  assert.equal(item.Complete, false)
  // Before o3d-btiw the fake had ONE quantity per line, so this state was not expressible at all and
  // no e2e run could reach the booked-in reconciliation.
  const asn = normalizeMintsoftAsnFetchByIdResult('6118', { status: 200, data: body })
  assert.ok(asn)
  const receipt = asn.lines[0]!.receipt
  assert.equal(receipt.kind === 'reported' && receipt.bookedIntoStockQty, 0)
  assert.equal(receipt.kind === 'reported' && receipt.arrivedAtWarehouseQty, 12)
})

/**
 * THE LIST ROW FAILS CLOSED TOO — `normalizeMintsoftAsnListRowForRecovery` (o3d-btiw, merge of
 * o3d-bhvu #701).
 *
 * `GET /api/ASN/List` is a SECOND wire shape for the same items, read by the duplicate-recovery path,
 * and it builds `WmsAsnLineRef`s of its own. Nothing consumes their `receipt` today — recovery
 * decides on `QuantityExpected` and on the status — so this is the test that keeps it true that a
 * list row cannot start claiming a booked quantity of zero the day something does read it. Zero there
 * is the assertion that nothing has been booked in, which is exactly the o3d-btiw defect in the other
 * direction.
 */
test('a LIST row with no QuantityBooked is unreadable, not zero (normalizeMintsoftAsnListRowForRecovery)', async () => {
  const { normalizeMintsoftAsnListRowForRecovery } = await import('@/lib/connectors/mintsoft/api/client')

  // The abridged list item live Mintsoft serves for an ASN's lines: an identity and an expectation.
  const abridged = normalizeMintsoftAsnListRowForRecovery({
    ID: 6117,
    POReference: 'PO-LIST-1',
    WarehouseId: 6,
    Items: [{ ID: 90001, SourceLineId: LIVE_ASN_SOURCE_LINE_ID, SKU: 'MS-SKU-1', QuantityExpected: 9 }],
  })
  assert.equal(abridged.lines.length, 1, 'PRECONDITION: the row yields exactly one line to examine')
  assert.equal(abridged.lines[0]!.expectedQty, 9, 'PRECONDITION: the EXPECTED quantity is readable, so the refusal below is about the booked one')
  assert.equal(abridged.lines[0]!.receipt.kind, 'unreadable')
  assert.match(
    abridged.lines[0]!.receipt.kind === 'unreadable' ? abridged.lines[0]!.receipt.detail : '',
    new RegExp(MINTSOFT_ASN_ITEM_BOOKED_QTY_KEY),
    'and the refusal names the field it could not read',
  )

  // NOT VACUOUS: a list row that DOES carry the field reads as a measurement, so the refusal above is
  // a property of the absent field and not of this code path.
  const full = normalizeMintsoftAsnListRowForRecovery({
    ID: 6118,
    POReference: 'PO-LIST-2',
    WarehouseId: 6,
    Items: [{
      ID: 90002,
      SourceLineId: LIVE_ASN_SOURCE_LINE_ID,
      SKU: 'MS-SKU-1',
      [MINTSOFT_ASN_ITEM_EXPECTED_QTY_KEY]: 9,
      [MINTSOFT_ASN_ITEM_ARRIVED_QTY_KEY]: 9,
      [MINTSOFT_ASN_ITEM_BOOKED_QTY_KEY]: 7,
    }],
  })
  assert.deepEqual(full.lines[0]!.receipt, {
    kind: 'reported',
    bookedIntoStockQty: 7,
    arrivedAtWarehouseQty: 9,
    basis: MINTSOFT_ASN_RECEIPT_BASIS,
  })
})
