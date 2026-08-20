import assert from 'node:assert/strict'
import test from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import {
  FULFILLMENT_QTY_HALF_ULP,
  canonicalFulfillmentQty,
  findDisproportionateFulfillmentComponent,
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
