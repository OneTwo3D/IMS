import assert from 'node:assert/strict'
import test from 'node:test'
import * as authNs from '../lib/connectors/mintsoft/api/auth.ts'
import * as normalizersNs from '../lib/connectors/mintsoft/api/normalizers.ts'
import * as stockSyncHelpersNs from '../lib/connectors/mintsoft/sync/stock-sync-helpers.ts'
import {
  resolveTransferLineLandedQty,
  resolveTransferLineResidualQty,
  resolveWmsAsnLineResidualQty,
  type TransferLineResidualQty,
} from '../lib/domain/inventory/transfer-landed-quantity.ts'

const auth = 'default' in authNs
  ? authNs.default as typeof import('../lib/connectors/mintsoft/api/auth.ts')
  : authNs
const normalizers = 'default' in normalizersNs
  ? normalizersNs.default as typeof import('../lib/connectors/mintsoft/api/normalizers.ts')
  : normalizersNs
const stockSyncHelpers = 'default' in stockSyncHelpersNs
  ? stockSyncHelpersNs.default as typeof import('../lib/connectors/mintsoft/sync/stock-sync-helpers.ts')
  : stockSyncHelpersNs

test('extractMintsoftArrayPayload handles both array and wrapped payload shapes', () => {
  assert.deepEqual(normalizers.extractMintsoftArrayPayload([{ id: 1 }]), [{ id: 1 }])
  assert.deepEqual(normalizers.extractMintsoftArrayPayload({ Warehouses: [{ id: 2 }] }), [{ id: 2 }])
  assert.deepEqual(normalizers.extractMintsoftArrayPayload({ data: [{ id: 3 }] }), [{ id: 3 }])
  assert.deepEqual(normalizers.extractMintsoftArrayPayload({}), [])
})

test('normalizeMintsoftWarehouse accepts common Mintsoft warehouse field variants', () => {
  assert.deepEqual(
    normalizers.normalizeMintsoftWarehouse({ WarehouseId: 17, WarehouseName: 'Main Warehouse' }),
    { externalId: '17', name: 'Main Warehouse' },
  )
  assert.deepEqual(
    normalizers.normalizeMintsoftWarehouse({ id: 'abc', label: 'Overflow' }),
    { externalId: 'abc', name: 'Overflow' },
  )
  assert.equal(normalizers.normalizeMintsoftWarehouse({ foo: 'bar' }), null)
})

test('normalizeMintsoftStockLine accepts common stock line field variants', () => {
  assert.deepEqual(
    normalizers.normalizeMintsoftStockLine({ SKU: 'ABC-1', FreeStock: '12.5' }),
    {
      sku: 'ABC-1',
      quantity: 12.5,
      raw: { SKU: 'ABC-1', FreeStock: '12.5' },
    },
  )
  assert.deepEqual(
    normalizers.normalizeMintsoftStockLine({ productCode: 'XYZ-2', stockLevel: 3 }),
    {
      sku: 'XYZ-2',
      quantity: 3,
      raw: { productCode: 'XYZ-2', stockLevel: 3 },
    },
  )
  assert.deepEqual(
    normalizers.normalizeMintsoftStockLine({ SKU: 'REALISTIC-3', Level: 9 }),
    {
      sku: 'REALISTIC-3',
      quantity: 9,
      raw: { SKU: 'REALISTIC-3', Level: 9 },
    },
  )
  assert.equal(normalizers.normalizeMintsoftStockLine({ productCode: 'XYZ-2' }), null)
})

test('extractMintsoftAuthToken accepts common Mintsoft auth response variants', () => {
  assert.equal(
    auth.extractMintsoftAuthToken({
      ApiKey: 'mintsoft-generated-key',
    }),
    'mintsoft-generated-key',
  )

  assert.equal(
    auth.extractMintsoftAuthToken('plain-text-token'),
    'plain-text-token',
  )

  assert.equal(auth.extractMintsoftAuthToken({ foo: 'bar' }), null)
})

test('sanitizeMintsoftThresholds normalizes values and drops empty configs', () => {
  assert.equal(stockSyncHelpers.sanitizeMintsoftThresholds(null), null)
  assert.deepEqual(
    stockSyncHelpers.sanitizeMintsoftThresholds({ absoluteDelta: -5, percentDelta: 10 }),
    { absoluteDelta: 0, percentDelta: 10 },
  )
  assert.deepEqual(
    stockSyncHelpers.parseMintsoftThresholds({ absoluteDelta: '2.5', percentDelta: 15 }),
    { absoluteDelta: 2.5, percentDelta: 15 },
  )
})

test('isMintsoftBindingDue and hasMintsoftThresholdBreach reflect phase 2 scheduling rules', () => {
  const now = new Date('2026-04-21T12:00:00.000Z')
  assert.equal(stockSyncHelpers.isMintsoftBindingDue(null, 60, now), true)
  assert.equal(stockSyncHelpers.isMintsoftBindingDue(new Date('2026-04-21T11:01:00.000Z'), 60, now), false)
  assert.equal(stockSyncHelpers.isMintsoftBindingDue(new Date('2026-04-21T10:59:00.000Z'), 60, now), true)

  assert.equal(
    stockSyncHelpers.hasMintsoftThresholdBreach(10, 14, { absoluteDelta: 5, percentDelta: null }),
    false,
  )
  assert.equal(
    stockSyncHelpers.hasMintsoftThresholdBreach(10, 15, { absoluteDelta: 5, percentDelta: null }),
    true,
  )
  assert.equal(
    stockSyncHelpers.hasMintsoftThresholdBreach(10, 12, { absoluteDelta: null, percentDelta: 15 }),
    true,
  )
})

test('consolidateMintsoftStockLines merges duplicate SKUs and keeps the latest raw payload', () => {
  assert.deepEqual(
    stockSyncHelpers.consolidateMintsoftStockLines([
      { sku: 'ABC', quantity: 2, raw: { first: true } },
      { sku: 'ABC', quantity: 3, raw: { second: true } },
      { sku: 'DEF', quantity: 1, raw: null },
    ]),
    [
      { sku: 'ABC', quantity: 5, raw: { second: true } },
      { sku: 'DEF', quantity: 1, raw: null },
    ],
  )
})

test('collectMissingInWmsCandidates keeps feed omissions visible without zero-zero noise', () => {
  assert.deepEqual(
    stockSyncHelpers.collectMissingInWmsCandidates({
      returnedSkus: ['LIVE-SKU'],
      snapshots: [
        { productId: 'p1', sku: 'MISSING-WITH-STOCK', externalQty: 4 },
        { productId: 'p2', sku: 'ZERO-ZERO', externalQty: 0 },
      ],
      stockLevels: [
        { productId: 'p1', sku: 'MISSING-WITH-STOCK', quantity: 2 },
        { productId: 'p2', sku: 'ZERO-ZERO', quantity: 0 },
        { productId: 'p3', sku: 'IMS-ONLY', quantity: 7 },
      ],
    }),
    [
      { productId: 'p3', sku: 'IMS-ONLY', imsQty: 7, lastExternalQty: null },
      { productId: 'p1', sku: 'MISSING-WITH-STOCK', imsQty: 2, lastExternalQty: 4 },
    ],
  )
})


// ---------------------------------------------------------------------------
// Alignment allocation planning: TWO caps, TWO scopes
//   · round 6 (HIGH-1) — a transfer line already received offers no capacity
//   · round 7 (HIGH-2) — but the LINE-wide figure must not be charged against each
//     ASN row individually
// ---------------------------------------------------------------------------

/** ASN SCOPE: `expectedQty` less this row's own credit. */
function asnResidue(input: {
  asnLineMapId: string
  expectedQty: number
  qtyAccountedViaSnapshot?: number
  lastProcessedReceivedQty?: number
}) {
  return resolveWmsAsnLineResidualQty({
    asnLineMapId: input.asnLineMapId,
    expectedQty: input.expectedQty,
    qtyAccountedViaSnapshot: input.qtyAccountedViaSnapshot ?? 0,
    lastProcessedReceivedQty: input.lastProcessedReceivedQty ?? 0,
  })
}

/**
 * LINE SCOPE: `line.qty` less everything landed on the line. Built through the real
 * landed-quantity constructor so these proofs exercise the same combinator the
 * production loader does.
 */
function lineResidue(input: {
  transferLineId: string
  lineQty: number
  qtyReceived?: number
  wmsAsnLines?: Array<{ qtyAccountedViaSnapshot: number; qtyAccountedViaReceipt: number }>
  /**
   * How much of the dispatch snapshot is still costable (Codex round-8 HIGH-1).
   * Defaults to the whole line quantity — a snapshot that records every unit it
   * shipped, which is the ordinary case and the one every test below was written
   * for. The round-8 test sets it lower on purpose.
   */
  costableRemainingQty?: number
}): TransferLineResidualQty {
  return resolveTransferLineResidualQty({
    lineQty: input.lineQty,
    landed: resolveTransferLineLandedQty({
      transferLineId: input.transferLineId,
      qtyReceived: input.qtyReceived ?? 0,
      wmsAsnLines: input.wmsAsnLines ?? [],
    }),
    costableRemainingQty: input.costableRemainingQty ?? input.lineQty,
  })
}

const NO_TRANSFER_LINES: ReadonlyMap<string, TransferLineResidualQty> = new Map()

test('planMintsoftAlignmentAllocations consumes the oldest open ASN capacity first', () => {
  assert.deepEqual(
    stockSyncHelpers.planMintsoftAlignmentAllocations({
      delta: 9,
      candidates: [
        {
          asnLineMapId: 'line-b',
          asnResidualQty: asnResidue({ asnLineMapId: 'line-b', expectedQty: 10, qtyAccountedViaSnapshot: 3 }),
          transferLineId: null,
          sortAt: '2026-04-22T10:05:00.000Z',
          sortId: 'line-b',
        },
        {
          asnLineMapId: 'line-a',
          asnResidualQty: asnResidue({ asnLineMapId: 'line-a', expectedQty: 5 }),
          transferLineId: null,
          sortAt: '2026-04-22T10:00:00.000Z',
          sortId: 'line-a',
        },
      ],
      transferLineResiduals: NO_TRANSFER_LINES,
    }),
    {
      allocations: [
        { asnLineMapId: 'line-a', qty: 5 },
        { asnLineMapId: 'line-b', qty: 4 },
      ],
      unallocatedQty: 0,
    },
  )

  assert.deepEqual(
    stockSyncHelpers.planMintsoftAlignmentAllocations({
      delta: 20,
      candidates: [
        {
          asnLineMapId: 'line-a',
          asnResidualQty: asnResidue({ asnLineMapId: 'line-a', expectedQty: 5, qtyAccountedViaSnapshot: 2 }),
          transferLineId: null,
          sortAt: '2026-04-22T10:00:00.000Z',
          sortId: 'line-a',
        },
      ],
      transferLineResiduals: NO_TRANSFER_LINES,
    }),
    {
      allocations: [
        { asnLineMapId: 'line-a', qty: 3 },
      ],
      unallocatedQty: 17,
    },
  )
})

test('planMintsoftAlignmentAllocations breaks same-timestamp ties by line id', () => {
  assert.deepEqual(
    stockSyncHelpers.planMintsoftAlignmentAllocations({
      delta: 3,
      candidates: [
        {
          asnLineMapId: 'line-b',
          asnResidualQty: asnResidue({ asnLineMapId: 'line-b', expectedQty: 5 }),
          transferLineId: null,
          sortAt: '2026-04-22T10:00:00.000Z',
          sortId: 'line-b',
        },
        {
          asnLineMapId: 'line-a',
          asnResidualQty: asnResidue({ asnLineMapId: 'line-a', expectedQty: 5 }),
          transferLineId: null,
          sortAt: '2026-04-22T10:00:00.000Z',
          sortId: 'line-a',
        },
      ],
      transferLineResiduals: NO_TRANSFER_LINES,
    }),
    {
      allocations: [
        { asnLineMapId: 'line-a', qty: 3 },
      ],
      unallocatedQty: 0,
    },
  )
})

test('an ASN line whose transfer line has already been received offers no capacity (Codex r6)', () => {
  // The two ASN counters are both zero here: a MANUAL receipt moves
  // stock_transfer_lines.qtyReceived and touches neither of them. Capacity computed
  // from the ASN row alone reports the full ten units as absorbable, and an
  // alignment would book stock in for units that were already received. The
  // LINE-scope cap is what stops it.
  assert.deepEqual(
    stockSyncHelpers.planMintsoftAlignmentAllocations({
      delta: 10,
      candidates: [
        {
          asnLineMapId: 'line-t',
          asnResidualQty: asnResidue({ asnLineMapId: 'line-t', expectedQty: 10 }),
          transferLineId: 'tl-1',
          sortAt: '2026-04-22T10:00:00.000Z',
          sortId: 'line-t',
        },
      ],
      transferLineResiduals: new Map([
        ['tl-1', lineResidue({ transferLineId: 'tl-1', lineQty: 10, qtyReceived: 10 })],
      ]),
    }),
    { allocations: [], unallocatedQty: 10 },
  )
})

test('a partly-landed transfer line offers only its genuine remainder (Codex r6 — not vacuous)', () => {
  // Proves the LINE cap narrows capacity rather than zeroing it: four of ten landed
  // still absorbs six.
  assert.deepEqual(
    stockSyncHelpers.planMintsoftAlignmentAllocations({
      delta: 10,
      candidates: [
        {
          asnLineMapId: 'line-t',
          asnResidualQty: asnResidue({ asnLineMapId: 'line-t', expectedQty: 10 }),
          transferLineId: 'tl-1',
          sortAt: '2026-04-22T10:00:00.000Z',
          sortId: 'line-t',
        },
      ],
      transferLineResiduals: new Map([
        ['tl-1', lineResidue({ transferLineId: 'tl-1', lineQty: 10, qtyReceived: 4 })],
      ]),
    }),
    { allocations: [{ asnLineMapId: 'line-t', qty: 6 }], unallocatedQty: 4 },
  )
})

test('a PURCHASE_ORDER_LINE candidate is unaffected — it has no transfer line (Codex r6 scope)', () => {
  // The landed quantity is a question about a TRANSFER line. A PO candidate carries
  // a null transferLineId and keeps the ASN-scope rule alone, so this change cannot
  // narrow PO alignment by accident.
  assert.deepEqual(
    stockSyncHelpers.planMintsoftAlignmentAllocations({
      delta: 10,
      candidates: [
        {
          asnLineMapId: 'line-p',
          asnResidualQty: asnResidue({ asnLineMapId: 'line-p', expectedQty: 10 }),
          transferLineId: null,
          sortAt: '2026-04-22T10:00:00.000Z',
          sortId: 'line-p',
        },
      ],
      transferLineResiduals: NO_TRANSFER_LINES,
    }),
    { allocations: [{ asnLineMapId: 'line-p', qty: 10 }], unallocatedQty: 0 },
  )
})

// --- Codex round-7 HIGH-2: the round-6 regression ---------------------------

test('a follow-up ASN absorbs its whole remainder after an earlier ASN closed (Codex r7 HIGH-2)', () => {
  // THE REGRESSION, exactly as reported. A ten-unit transfer line: three units were
  // absorbed on a FIRST ASN which is now closed (so it is not a candidate at all),
  // and the follow-up ASN was correctly raised for the remaining seven.
  //
  // Round 6 charged the LINE-wide landed three against that follow-up ASN's own
  // seven and exposed four, so a legitimate seven-unit Mintsoft delta was rejected
  // with three unallocated and IMS stock stayed seven short.
  //
  // Line residue is 10 − 3 = 7; the ASN residue is 7; the allocation is 7.
  const plan = stockSyncHelpers.planMintsoftAlignmentAllocations({
    delta: 7,
    candidates: [
      {
        asnLineMapId: 'asn-2',
        asnResidualQty: asnResidue({ asnLineMapId: 'asn-2', expectedQty: 7 }),
        transferLineId: 'tl-1',
        sortAt: '2026-04-23T10:00:00.000Z',
        sortId: 'asn-2',
      },
    ],
    transferLineResiduals: new Map([
      ['tl-1', lineResidue({
        transferLineId: 'tl-1',
        lineQty: 10,
        // The three landed units came in through the FIRST ASN's alignment credit,
        // which is why stock_transfer_lines.qtyReceived is still zero.
        qtyReceived: 0,
        wmsAsnLines: [{ qtyAccountedViaSnapshot: 3, qtyAccountedViaReceipt: 0 }],
      })],
    ]),
  })

  assert.deepEqual(plan, { allocations: [{ asnLineMapId: 'asn-2', qty: 7 }], unallocatedQty: 0 })
  // The postcondition that matters to IMS stock: nothing is left unallocated, so the
  // caller applies the delta instead of refusing it.
  assert.equal(plan.unallocatedQty, 0)
  assert.equal(plan.allocations.reduce((sum, a) => sum + a.qty, 0), 7)
})

test('two open ASNs on ONE transfer line share the line residue, they do not each get it (Codex r7 HIGH-2)', () => {
  // The other direction of the same confusion: the LINE cap must be depleted as the
  // plan allocates, or two open ASN rows on one line would each be allowed the full
  // line remainder and the alignment would over-book.
  const plan = stockSyncHelpers.planMintsoftAlignmentAllocations({
    delta: 12,
    candidates: [
      {
        asnLineMapId: 'asn-a',
        asnResidualQty: asnResidue({ asnLineMapId: 'asn-a', expectedQty: 6 }),
        transferLineId: 'tl-1',
        sortAt: '2026-04-22T10:00:00.000Z',
        sortId: 'asn-a',
      },
      {
        asnLineMapId: 'asn-b',
        asnResidualQty: asnResidue({ asnLineMapId: 'asn-b', expectedQty: 6 }),
        transferLineId: 'tl-1',
        sortAt: '2026-04-23T10:00:00.000Z',
        sortId: 'asn-b',
      },
    ],
    transferLineResiduals: new Map([
      ['tl-1', lineResidue({ transferLineId: 'tl-1', lineQty: 10, qtyReceived: 2 })],
    ]),
  })

  // Line residue 8: six on the older ASN, two on the newer, four unallocated.
  assert.deepEqual(plan, {
    allocations: [
      { asnLineMapId: 'asn-a', qty: 6 },
      { asnLineMapId: 'asn-b', qty: 2 },
    ],
    unallocatedQty: 4,
  })
})

test('THREE open ASNs on one transfer line share the line residue in ASN ORDER (Codex r8 LOW)', () => {
  // The two-ASN case above cannot tell a correct depletion from a lucky one: with two
  // rows, "oldest first" and "whatever order the input arrived in" agree, and the
  // second row is the only one left to take the remainder. Three rows and an input
  // in the WRONG order separate the two.
  //
  // Line residue is 9. In ASN-created order that is asn-a 4, asn-b 4, asn-c 1 — the
  // third row is capped by what the first two left, which is the assertion two rows
  // could not make.
  const plan = stockSyncHelpers.planMintsoftAlignmentAllocations({
    delta: 9,
    candidates: [
      // DELIBERATELY OUT OF ORDER: newest first, then oldest, then the middle one.
      // A missing or reversed sort re-orders the allocations and changes the third
      // row's quantity, so the sort is load-bearing for this assertion.
      {
        asnLineMapId: 'asn-c',
        asnResidualQty: asnResidue({ asnLineMapId: 'asn-c', expectedQty: 4 }),
        transferLineId: 'tl-1',
        sortAt: '2026-04-24T10:00:00.000Z',
        sortId: 'asn-c',
      },
      {
        asnLineMapId: 'asn-a',
        asnResidualQty: asnResidue({ asnLineMapId: 'asn-a', expectedQty: 4 }),
        transferLineId: 'tl-1',
        sortAt: '2026-04-22T10:00:00.000Z',
        sortId: 'asn-a',
      },
      {
        asnLineMapId: 'asn-b',
        asnResidualQty: asnResidue({ asnLineMapId: 'asn-b', expectedQty: 4 }),
        transferLineId: 'tl-1',
        sortAt: '2026-04-23T10:00:00.000Z',
        sortId: 'asn-b',
      },
    ],
    transferLineResiduals: new Map([
      ['tl-1', lineResidue({ transferLineId: 'tl-1', lineQty: 10, qtyReceived: 1 })],
    ]),
  })

  assert.deepEqual(plan, {
    allocations: [
      { asnLineMapId: 'asn-a', qty: 4 },
      { asnLineMapId: 'asn-b', qty: 4 },
      { asnLineMapId: 'asn-c', qty: 1 },
    ],
    unallocatedQty: 0,
  })
  // Stated separately, because the deepEqual above would also pass if the ORDER were
  // right and the depletion wrong in a compensating way.
  assert.deepEqual(plan.allocations.map((allocation) => allocation.asnLineMapId), ['asn-a', 'asn-b', 'asn-c'])
  assert.equal(plan.allocations.reduce((sum, a) => sum + a.qty, 0), 9, 'the line residue, not 12')
})

test('the ASN sort is by created-at, not input order — a reversed input allocates the same (Codex r8 LOW)', () => {
  // The other half of the same gap: every earlier input happened to arrive in
  // allocation order, so deleting the sort would not have failed any of them. Feed
  // three rows in exactly reverse order against a delta that only ONE of them can
  // satisfy, and the answer names the oldest.
  const candidates = [
    { asnLineMapId: 'asn-new', sortAt: '2026-04-24T10:00:00.000Z' },
    { asnLineMapId: 'asn-mid', sortAt: '2026-04-23T10:00:00.000Z' },
    { asnLineMapId: 'asn-old', sortAt: '2026-04-22T10:00:00.000Z' },
  ].map((row) => ({
    asnLineMapId: row.asnLineMapId,
    asnResidualQty: asnResidue({ asnLineMapId: row.asnLineMapId, expectedQty: 5 }),
    transferLineId: 'tl-1',
    sortAt: row.sortAt,
    sortId: row.asnLineMapId,
  }))

  const plan = stockSyncHelpers.planMintsoftAlignmentAllocations({
    delta: 3,
    candidates,
    transferLineResiduals: new Map([
      ['tl-1', lineResidue({ transferLineId: 'tl-1', lineQty: 10 })],
    ]),
  })

  assert.deepEqual(
    plan,
    { allocations: [{ asnLineMapId: 'asn-old', qty: 3 }], unallocatedQty: 0 },
    'the OLDEST ASN absorbs it, whatever order the candidates arrived in',
  )
})

test('the LINE residue is capped by what the dispatch snapshot can still cost (Codex r8 HIGH-1)', () => {
  // The round-8 half of the line cap. Ten units are outstanding on the line, but the
  // dispatch snapshot has only six costable units left — the source shipped legacy
  // stock with no FIFO layer behind it. Allocating ten would book ten units of stock
  // over six units of cost layer.
  const plan = stockSyncHelpers.planMintsoftAlignmentAllocations({
    delta: 10,
    candidates: [
      {
        asnLineMapId: 'asn-1',
        asnResidualQty: asnResidue({ asnLineMapId: 'asn-1', expectedQty: 10 }),
        transferLineId: 'tl-1',
        sortAt: '2026-04-22T10:00:00.000Z',
        sortId: 'asn-1',
      },
    ],
    transferLineResiduals: new Map([
      ['tl-1', lineResidue({ transferLineId: 'tl-1', lineQty: 10, costableRemainingQty: 6 })],
    ]),
  })

  assert.deepEqual(
    plan,
    { allocations: [{ asnLineMapId: 'asn-1', qty: 6 }], unallocatedQty: 4 },
    'only the costable six may be planned; the other four come back unallocated',
  )
  // And an unallocated remainder is what makes the caller refuse the whole delta, so
  // nothing is booked at all.
  assert.ok(plan.unallocatedQty > 0)
})

test('the costable cap does not bind when the snapshot is complete (Codex r8 — not vacuous)', () => {
  // If the cap were applied unconditionally, or the minimum taken the wrong way
  // round, every alignment would shrink. Same input, a snapshot covering all ten.
  assert.deepEqual(
    stockSyncHelpers.planMintsoftAlignmentAllocations({
      delta: 10,
      candidates: [
        {
          asnLineMapId: 'asn-1',
          asnResidualQty: asnResidue({ asnLineMapId: 'asn-1', expectedQty: 10 }),
          transferLineId: 'tl-1',
          sortAt: '2026-04-22T10:00:00.000Z',
          sortId: 'asn-1',
        },
      ],
      transferLineResiduals: new Map([
        ['tl-1', lineResidue({ transferLineId: 'tl-1', lineQty: 10, costableRemainingQty: 10 })],
      ]),
    }),
    { allocations: [{ asnLineMapId: 'asn-1', qty: 10 }], unallocatedQty: 0 },
  )
})

test('the ASN cap still binds when it is tighter than the line cap (Codex r7 — not vacuous)', () => {
  // Proves the ASN-scope residue is still applied and the fix did not simply replace
  // one cap with the other: the line has ten units outstanding, this ASN row expects
  // only two, and two is what it absorbs.
  assert.deepEqual(
    stockSyncHelpers.planMintsoftAlignmentAllocations({
      delta: 9,
      candidates: [
        {
          asnLineMapId: 'asn-small',
          asnResidualQty: asnResidue({ asnLineMapId: 'asn-small', expectedQty: 2 }),
          transferLineId: 'tl-1',
          sortAt: '2026-04-22T10:00:00.000Z',
          sortId: 'asn-small',
        },
      ],
      transferLineResiduals: new Map([
        ['tl-1', lineResidue({ transferLineId: 'tl-1', lineQty: 10 })],
      ]),
    }),
    { allocations: [{ asnLineMapId: 'asn-small', qty: 2 }], unallocatedQty: 7 },
  )
})

test('a transfer-backed candidate with no line residue supplied throws rather than allocating uncapped', () => {
  // "No entry" and "no cap" must not look alike — the failure mode this whole
  // finding is made of.
  assert.throws(
    () => stockSyncHelpers.planMintsoftAlignmentAllocations({
      delta: 5,
      candidates: [
        {
          asnLineMapId: 'asn-1',
          asnResidualQty: asnResidue({ asnLineMapId: 'asn-1', expectedQty: 5 }),
          transferLineId: 'tl-missing',
          sortAt: '2026-04-22T10:00:00.000Z',
          sortId: 'asn-1',
        },
      ],
      transferLineResiduals: NO_TRANSFER_LINES,
    }),
    /no line-scope residual quantity was loaded for transfer line tl-missing/,
  )
})

// --- Codex round-7 HIGH-2: the COMPILE-level proof --------------------------

test('the two residues are separate types — the line-wide figure cannot reach an ASN slot', () => {
  // The real proof is the `@ts-expect-error` below, which `npx tsc --noEmit` (the
  // merge gate) checks: if `TransferLineResidualQty` ever became assignable to
  // `WmsAsnLineResidualQty` the suppression would be unused and the build would FAIL
  // with TS2578. Round 6's substitution is now unrepresentable rather than merely
  // discouraged.
  const lineWide = lineResidue({ transferLineId: 'tl-1', lineQty: 10, qtyReceived: 3 })

  assert.throws(
    () => stockSyncHelpers.planMintsoftAlignmentAllocations({
      delta: 7,
      candidates: [
        {
          asnLineMapId: 'asn-2',
          // @ts-expect-error — a LINE-scope residue is not an ASN-scope residue (6oyu.19 Codex r7 HIGH-2)
          asnResidualQty: lineWide,
          transferLineId: 'tl-nope',
          sortAt: '2026-04-23T10:00:00.000Z',
          sortId: 'asn-2',
        },
      ],
      transferLineResiduals: NO_TRANSFER_LINES,
    }),
    /no line-scope residual quantity was loaded/,
  )
})

// A second, statement-level compile proof, so the guarantee does not rest on one
// suppression comment inside one call. Each alias is checked by `tsc --noEmit`
// whether or not anything reads it; collapsing the two brands makes `Assert` fail
// its `extends true` constraint.
type Assert<T extends true> = T
type NotAssignable<A, B> = [A] extends [B] ? false : true

export type ProofLineResidueIsNotAsnResidue = Assert<NotAssignable<
  ReturnType<typeof lineResidue>,
  ReturnType<typeof asnResidue>
>>
export type ProofAsnResidueIsNotLineResidue = Assert<NotAssignable<
  ReturnType<typeof asnResidue>,
  ReturnType<typeof lineResidue>
>>
export type ProofLandedIsNotAsnResidue = Assert<NotAssignable<
  ReturnType<typeof resolveTransferLineLandedQty>,
  ReturnType<typeof asnResidue>
>>
export type ProofPlainNumberIsNotAsnResidue = Assert<NotAssignable<number, ReturnType<typeof asnResidue>>>
