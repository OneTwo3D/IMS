import assert from 'node:assert/strict'
import test from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import {
  FULFILLMENT_QTY_HALF_ULP,
  canonicalFulfillmentQty,
  findDisproportionateFulfillmentComponent,
  floorFulfillmentQty,
  fulfillmentCoverageQuantisationSlack,
} from '@/lib/products/fulfillment-coverage'

/**
 * o3d-i4qd — the arithmetic of "judged at the persisted scale", with no doubles at all.
 *
 * `ProductComponent.qty`, `SalesOrderLine.qty`, `OrderAllocation.qty` and `ShipmentLine.qty` are all
 * `Decimal(12,4)`, so an expanded requirement — a PRODUCT of those — is routinely not representable.
 * Every comparison between a computed requirement and a stored quantity has to happen at that scale.
 */

const requirement = (productId: string, factor: string) => ({
  productId,
  factor: new Prisma.Decimal(factor),
})
const quantities = (entries: Array<[string, string]>) =>
  new Map(entries.map(([productId, qty]) => [productId, new Prisma.Decimal(qty)]))

test('canonicalFulfillmentQty rounds half-up, once, after the whole multiplication', () => {
  // Postgres numeric(12,4) rounds half-up on write; the reader has to do the same or the two sides
  // are different numbers by construction.
  assert.equal(canonicalFulfillmentQty(new Prisma.Decimal('0.5').mul('0.3333')).toFixed(4), '0.1667')
  assert.equal(canonicalFulfillmentQty('0.11102224').toFixed(4), '0.1110')
  assert.equal(canonicalFulfillmentQty('0.00005').toFixed(4), '0.0001')
  // Rounding per TERM instead would give round(0.5) x round(0.3333) = 0.5 x 0.3333, a different
  // number entirely — the multiplication comes first.
  assert.equal(canonicalFulfillmentQty(new Prisma.Decimal('2').mul('0.000289')).toFixed(4), '0.0006')
})

test('a fractional KIT set the column rounded is proportional', () => {
  // 0.5 kits of (0.3333 x A + 1 x B): A's 0.16665 is stored as 0.1667, B's is exactly 0.5. The
  // bands [0.5, 0.50030) and [0.49995, 0.50005) share 0.5, so one coverage explains both rows.
  assert.equal(
    findDisproportionateFulfillmentComponent(
      [requirement('A', '0.3333'), requirement('B', '1')],
      quantities([['A', '0.1667'], ['B', '0.5']]),
    ),
    null,
  )
})

test('a nested KIT factor the column cannot hold is proportional too', () => {
  // 0.3332 x 0.3332 = 0.11102224 per kit, stored as 0.1110, beside an exact 0.5.
  assert.equal(
    findDisproportionateFulfillmentComponent(
      [requirement('A', '0.11102224'), requirement('B', '0.5')],
      quantities([['A', '0.1110'], ['B', '0.5']]),
    ),
    null,
  )
})

test('a uniformly rescaled kit — half a kit against the new recipe — is NOT proportional', () => {
  // The corruption the check exists for: rows A=2 / B=1 against a graph re-composed to 2xA + 2xB.
  // Bands [0.999975, 1.000025) and [0.499975, 0.500025) are disjoint by half a kit.
  assert.deepEqual(
    findDisproportionateFulfillmentComponent(
      [requirement('A', '2'), requirement('B', '2')],
      quantities([['A', '2'], ['B', '1']]),
    ),
    { productId: 'B', conflictsWithProductId: 'A' },
    'B is the short one, and it conflicts with A',
  )
})

test('the band is exactly one ulp wide — a whole ulp of disagreement is a breach', () => {
  // A stored 0.1667 stands for [0.16665, 0.16675) of requirement. A sibling that pins coverage at
  // a value implying 0.1668 for A is outside that, and must not be absorbed.
  assert.equal(
    findDisproportionateFulfillmentComponent(
      [requirement('A', '1'), requirement('B', '1')],
      quantities([['A', '0.1667'], ['B', '0.1668']]),
    ) === null,
    false,
    'one ulp apart at factor 1 is a breach',
  )
  assert.equal(
    findDisproportionateFulfillmentComponent(
      [requirement('A', '1'), requirement('B', '1')],
      quantities([['A', '0.1667'], ['B', '0.1667']]),
    ),
    null,
  )
})

test('a non-positive factor is reported as a breach, never silently satisfied', () => {
  assert.deepEqual(
    findDisproportionateFulfillmentComponent(
      [requirement('A', '0')],
      quantities([['A', '0']]),
    ),
    { productId: 'A', conflictsWithProductId: 'A' },
  )
})

test('an empty requirement set has nothing to disprove', () => {
  assert.equal(findDisproportionateFulfillmentComponent([], new Map()), null)
})

test('the coverage slack is half an ulp divided by the SMALLEST factor', () => {
  // coverage = min(qty / factor), so the error of the smallest factor's term dominates: at factor
  // 0.0001 a single ulp of that component is half a whole kit of inferred coverage.
  assert.equal(
    fulfillmentCoverageQuantisationSlack([requirement('A', '0.3333'), requirement('B', '1')])
      .toDecimalPlaces(8)
      .toString(),
    FULFILLMENT_QTY_HALF_ULP.div('0.3333').toDecimalPlaces(8).toString(),
  )
  assert.equal(
    fulfillmentCoverageQuantisationSlack([requirement('A', '0.0001')]).toString(),
    '0.5',
  )
  assert.equal(fulfillmentCoverageQuantisationSlack([]).toString(), '0')
})

/**
 * o3d-aqke (Codex r1 finding 1) — A SUM OF SEPARATELY ROUNDED ROWS IS NOT ONE ROUNDING.
 *
 * The band above describes ONE stored quantity: it stands for one half-up rounding of `c * f`, so
 * it is one ulp wide. A CUMULATIVE committed quantity is not that. Ship a kit in three partials and
 * each `ShipmentLine.qty` is rounded on its own write, so the total is `sum_k round(c_k * f, 4)` and
 * its distance from `(sum_k c_k) * f` is up to three half-ulps. Judged by the one-row band, a
 * perfectly legitimate sequence of partials is refused — at dispatch, on goods already picked and
 * packed, on an order that can then never be completed.
 */

test('o3d-aqke: three legitimate partial shipments of half a kit each are proportional', () => {
  // Kit = 0.3333 x A + 1 x B, shipped as 0.5 kits three times.
  // Each shipment stores A = round(0.5 x 0.3333, 4) = round(0.16665, 4) = 0.1667 and B = 0.5000.
  // Cumulative: A = 0.5001, B = 1.5000. The TRUE cumulative requirement for A is 1.5 x 0.3333 =
  // 0.49995, so the stored 0.5001 is three half-ulps above it — exactly the rounding the column
  // performed, three times.
  assert.equal(
    findDisproportionateFulfillmentComponent(
      [requirement('A', '0.3333'), requirement('B', '1')],
      quantities([['A', '0.5001'], ['B', '1.5']]),
      new Map([['A', 3], ['B', 3]]),
    ),
    null,
    'three roundings deep, one coverage explains both totals',
  )
})

test('o3d-aqke: the same three partials are FALSELY refused by the one-row band', () => {
  // The defect, pinned as an assertion rather than described. Without the count, A's band is
  // [0.50005/0.3333, 0.50015/0.3333) = [1.5003.., 1.5006..) and B's is [1.49995, 1.50005): disjoint
  // by three ten-thousandths of a kit, and A is named as the component that conflicts.
  assert.deepEqual(
    findDisproportionateFulfillmentComponent(
      [requirement('A', '0.3333'), requirement('B', '1')],
      quantities([['A', '0.5001'], ['B', '1.5']]),
    ),
    { productId: 'B', conflictsWithProductId: 'A' },
  )
})

test('o3d-aqke: ONE shipment of the same kit was always fine — the defect only appears cumulatively', () => {
  // Why this went unnoticed: a single partial passes. A = 0.1667 gives [0.5, 0.50030..) and B = 0.5
  // gives [0.49995, 0.50005), which share 0.5. Nothing about one shipment is wrong; the sum is what
  // the old band could not describe.
  assert.equal(
    findDisproportionateFulfillmentComponent(
      [requirement('A', '0.3333'), requirement('B', '1')],
      quantities([['A', '0.1667'], ['B', '0.5']]),
      new Map([['A', 1], ['B', 1]]),
    ),
    null,
  )
})

test('o3d-aqke: a widened band still refuses a uniformly rescaled kit', () => {
  // The widening must not buy permissiveness. Rows A=2 / B=1 against a 2xA + 2xB recipe are out by
  // HALF A KIT; even at a hundred roundings the bands [0.99750, 1.00250) and [0.49750, 0.50250)
  // stay disjoint. If this ever passed, the count would have become a tolerance.
  assert.deepEqual(
    findDisproportionateFulfillmentComponent(
      [requirement('A', '2'), requirement('B', '2')],
      quantities([['A', '2'], ['B', '1']]),
      new Map([['A', 100], ['B', 100]]),
    ),
    { productId: 'B', conflictsWithProductId: 'A' },
  )
})

test('o3d-aqke: an absent, zero or negative count never NARROWS the band below one rounding', () => {
  // A count is a widening, never a tightening: a single stored row is still one half-up rounding,
  // whatever a caller claims. The fractional set from the o3d-i4qd case above must stay accepted
  // under each of these.
  for (const counts of [
    undefined,
    new Map<string, number>(),
    new Map([['A', 0], ['B', 0]]),
    new Map([['A', -5], ['B', -5]]),
    new Map([['A', Number.NaN], ['B', Number.NaN]]),
  ]) {
    assert.equal(
      findDisproportionateFulfillmentComponent(
        [requirement('A', '0.3333'), requirement('B', '1')],
        quantities([['A', '0.1667'], ['B', '0.5']]),
        counts,
      ),
      null,
      `counts ${JSON.stringify(counts && [...counts])} must not narrow the single-row band`,
    )
  }
})

/**
 * o3d-aqke (Codex r1 finding 2) — A CEILING IS FLOORED, A COMPUTED QUANTITY IS ROUNDED.
 */

test('o3d-aqke: floorFulfillmentQty truncates, and a rounded value can never cross it', () => {
  // Stock is Decimal(14,6); an allocation row is Decimal(12,4). 1.000050 of available stock is
  // 1.0000 of allocatable stock, because 1.00005 half-up is 1.0001 — a row that does not exist.
  assert.equal(floorFulfillmentQty('1.000050').toFixed(4), '1.0000')
  assert.equal(canonicalFulfillmentQty('1.000050').toFixed(4), '1.0001')
  assert.equal(floorFulfillmentQty('0.99999999').toFixed(4), '0.9999')
  // The guarantee the allocator relies on: plan against the FLOORED ceiling and the canonical row
  // is inside the real availability, for every value at or below it.
  const available = new Prisma.Decimal('1.000050')
  const ceiling = floorFulfillmentQty(available)
  for (const planned of ['1.0000', '0.99999999', '0.5', '0.16665']) {
    const persisted = canonicalFulfillmentQty(Prisma.Decimal.min(new Prisma.Decimal(planned), ceiling))
    assert.equal(
      persisted.lte(available),
      true,
      `${planned} planned against the floored ceiling persists as ${persisted.toFixed(4)}, which must fit in ${available.toFixed(6)}`,
    )
  }
  // And the counter-example: planning against the RAW availability persists 1.0001 against 1.00005,
  // which is the row the stock_levels_reserved_qty_lte_quantity check constraint refuses.
  assert.equal(canonicalFulfillmentQty(available).gt(available), true)
})
