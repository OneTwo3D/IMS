import assert from 'node:assert/strict'
import test from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import {
  canonicalAllocationQty,
  findUncoveredCommittedShipment,
  floorAvailableStockMapToCanonicalScale,
} from '@/lib/domain/sales/allocation-service'
import type { DecimalFulfillmentRequirement } from '@/lib/products/fulfillment-coverage'

/**
 * o3d-aqke (Codex r1 review) — THE TWO SCALES THE ALLOCATOR HAS TO KEEP STRAIGHT.
 *
 * Finding 1: a CUMULATIVE committed quantity is a sum of separately rounded rows, and judging it by
 * the band that describes ONE rounding refuses legitimate partial shipments — at dispatch, on goods
 * already picked, with no way back.
 *
 * Finding 2: `StockLevel` is `Decimal(14,6)` and `OrderAllocation` is `Decimal(12,4)`, so a plan
 * drawn against raw availability can persist a row half an ulp above it. `stock_levels` carries a
 * VALIDATED `reservedQty <= quantity` check constraint, so that row does not over-book — it aborts
 * the whole allocation transaction with a Postgres constraint name and no operator-facing reason.
 */

const requirement = (productId: string, factor: string): DecimalFulfillmentRequirement => ({
  productId,
  factor: new Prisma.Decimal(factor),
})

/** A KIT of 0.3333 x A + 0.6667 x B, ordered as 4.5 kits and shipped in three passes of 1.5. */
const FRACTIONAL_KIT = [requirement('component-a', '0.3333'), requirement('component-b', '0.6667')]
const REQUIREMENTS_BY_LINE = new Map([['line-1', FRACTIONAL_KIT]])
const LABELS = new Map([['line-1', 'KIT-1']])

const allocationRows = (componentA: string, componentB: string) => [
  { lineId: 'line-1', warehouseId: 'warehouse-1', productId: 'component-a', qty: new Prisma.Decimal(componentA) },
  { lineId: 'line-1', warehouseId: 'warehouse-1', productId: 'component-b', qty: new Prisma.Decimal(componentB) },
]

/**
 * Three separate committed shipments, each storing its own half-up rounding:
 *   A = round(1.5 x 0.3333, 4) = round(0.49995) = 0.5000
 *   B = round(1.5 x 0.6667, 4) = round(1.00005) = 1.0001
 * Totals A = 1.5000, B = 3.0003 against a true coverage of 4.5 kits.
 */
const threePartials = () => [
  { lineId: 'line-1', warehouseId: 'warehouse-1', productId: 'component-a', qty: new Prisma.Decimal('0.5') },
  { lineId: 'line-1', warehouseId: 'warehouse-1', productId: 'component-b', qty: new Prisma.Decimal('1.0001') },
  { lineId: 'line-1', warehouseId: 'warehouse-1', productId: 'component-a', qty: new Prisma.Decimal('0.5') },
  { lineId: 'line-1', warehouseId: 'warehouse-1', productId: 'component-b', qty: new Prisma.Decimal('1.0001') },
  { lineId: 'line-1', warehouseId: 'warehouse-1', productId: 'component-a', qty: new Prisma.Decimal('0.5') },
  { lineId: 'line-1', warehouseId: 'warehouse-1', productId: 'component-b', qty: new Prisma.Decimal('1.0001') },
]

test('o3d-aqke: three proportional partial shipments of a fractional KIT are accepted', () => {
  // As ONE rounding, A's band is [1.49995/0.3333, 1.50005/0.3333) = [4.50030.., 4.50060..) and B's
  // is [3.00025/0.6667, 3.00035/0.6667) = [4.50014.., 4.50029..) — disjoint, so the whole delivery
  // is refused. As the three roundings it is, A widens to [4.5, 4.50090..) and B to [4.5, 4.50044..),
  // which share the 4.5 kits that actually produced them.
  assert.equal(
    findUncoveredCommittedShipment(
      REQUIREMENTS_BY_LINE,
      LABELS,
      allocationRows('1.5', '3.0003'),
      threePartials(),
    ),
    null,
  )
})

test('o3d-aqke: ONE of those shipments on its own was never refused', () => {
  // Why the defect hid: nothing about a single partial is wrong. A = 0.5000 gives
  // [0.49995/0.3333, 0.50005/0.3333) = [1.49985.., 1.50015..) and B = 1.0001 gives
  // [1.00005/0.6667, 1.00015/0.6667) = [1.5, 1.50014..). They share 1.5. Only the SUM breaks.
  assert.equal(
    findUncoveredCommittedShipment(
      REQUIREMENTS_BY_LINE,
      LABELS,
      allocationRows('0.5', '1.0001'),
      threePartials().slice(0, 2),
    ),
    null,
  )
})

test('o3d-aqke: a committed set that really is short a component is still refused', () => {
  // The regression guard, on the same shape: the third pass shipped component-a but not
  // component-b, so 4.5 kits of A stand against 3 kits of B. Two roundings of slack is 0.0001;
  // this is a whole 1.0001 out.
  const shortSet = threePartials().filter((row, index) => index !== 5)
  assert.equal(
    findUncoveredCommittedShipment(
      REQUIREMENTS_BY_LINE,
      LABELS,
      allocationRows('1.5', '3.0003'),
      shortSet,
    ),
    'Shipments for sales line KIT-1 in warehouse warehouse-1 do not commit a complete component set',
  )
})

test('o3d-aqke: a commitment larger than its allocation row is still named, with both quantities', () => {
  // The downward half must not be softened by the widening: the band is about PROPORTION, and this
  // check is about BACKING. 1.5 committed against a row of 1.4 is 0.1 of stock nothing accounts for.
  assert.equal(
    findUncoveredCommittedShipment(
      REQUIREMENTS_BY_LINE,
      LABELS,
      allocationRows('1.4', '3.0003'),
      threePartials(),
    ),
    'Shipments for sales line KIT-1 in warehouse warehouse-1 commit 1.5 unit(s) but only 1.4 are allocated there'
    + ' — the allocation row is what the shipment, the reservation residual and the accounting sub-ledger net'
    + ' against, so it must cover what has been committed',
  )
})

/**
 * o3d-aqke (Codex r1 finding 2) — THE PLAN IS DRAWN AGAINST A CEILING THE ROW CAN HOLD.
 */

const stockMap = (entries: Array<[string, string, string]>) => {
  const map = new Map<string, Map<string, Prisma.Decimal>>()
  for (const [productId, warehouseId, qty] of entries) {
    const byWarehouse = map.get(productId) ?? new Map<string, Prisma.Decimal>()
    byWarehouse.set(warehouseId, new Prisma.Decimal(qty))
    map.set(productId, byWarehouse)
  }
  return map
}

test('o3d-aqke: availability is floored to the canonical scale before feasibility is decided', () => {
  // 1.000050 of stock is 1.0000 of ALLOCATABLE stock: the two decimals below Decimal(12,4) are real
  // in stock_levels and unrepresentable in an allocation row, and half-up would turn them into a
  // row of 1.0001 that exceeds the stock it was drawn from.
  const floored = floorAvailableStockMapToCanonicalScale(stockMap([
    ['component-a', 'warehouse-1', '1.000050'],
    ['component-b', 'warehouse-1', '3.999999'],
    ['component-c', 'warehouse-1', '7'],
  ]))

  assert.equal(floored.get('component-a')?.get('warehouse-1')?.toFixed(6), '1.000000')
  assert.equal(floored.get('component-b')?.get('warehouse-1')?.toFixed(6), '3.999900')
  assert.equal(floored.get('component-c')?.get('warehouse-1')?.toFixed(6), '7.000000', 'an exact figure is untouched')
})

test('o3d-aqke: planning against RAW availability persists a row the check constraint refuses', () => {
  // The defect, as arithmetic rather than prose. A leaf line for 10 units against 1.000050 of stock
  // allocates min(10, avail); canonicalAllocationQty then rounds it half-up — correctly, once,
  // after the whole multiplication — to 1.0001, which is 0.00005 more stock than exists.
  // `stock_levels_reserved_qty_lte_quantity` is VALIDATED, so the reserve raises a check violation
  // and the whole allocation transaction is rolled back.
  const available = new Prisma.Decimal('1.000050')
  const rawPlan = canonicalAllocationQty(Prisma.Decimal.min(new Prisma.Decimal(10), available))
  assert.equal(rawPlan.toFixed(4), '1.0001')
  assert.equal(rawPlan.gt(available), true, 'the persisted row exceeds the stock the plan was drawn from')

  const flooredCeiling = floorAvailableStockMapToCanonicalScale(
    stockMap([['component-a', 'warehouse-1', '1.000050']]),
  ).get('component-a')!.get('warehouse-1')!
  const safePlan = canonicalAllocationQty(Prisma.Decimal.min(new Prisma.Decimal(10), flooredCeiling))
  assert.equal(safePlan.toFixed(4), '1.0000')
  assert.equal(safePlan.lte(available), true, 'and the floored ceiling keeps the row inside real stock')
})

test('o3d-aqke: a KIT factor makes the same overshoot out of a leaf that IS representable', () => {
  // Not only a 6dp stock figure. A kit of 0.75 x A against 1.000075 of A proves 1.3334333.. kits
  // available; the requirement multiplies straight back to 1.000075, and half-up stores 1.0001.
  const availableA = new Prisma.Decimal('1.000075')
  const kitsAvailable = availableA.div('0.75')
  const rawRequirement = kitsAvailable.mul('0.75')
  assert.equal(canonicalAllocationQty(rawRequirement).toFixed(4), '1.0001')
  assert.equal(canonicalAllocationQty(rawRequirement).gt(availableA), true)

  const ceiling = floorAvailableStockMapToCanonicalScale(
    stockMap([['component-a', 'warehouse-1', '1.000075']]),
  ).get('component-a')!.get('warehouse-1')!
  const safeRequirement = ceiling.div('0.75').mul('0.75')
  assert.equal(canonicalAllocationQty(safeRequirement).lte(availableA), true)
})
