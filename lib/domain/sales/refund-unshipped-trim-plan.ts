import { Prisma } from '@/app/generated/prisma/client'
import { toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { floorFulfillmentQty } from '@/lib/products/fulfillment-coverage'

/**
 * Pure planning for the shipment-safe trim of a refund's UNSHIPPED reservation.
 *
 * A refund removes units from what an order still has to ship. When the order has no shipment the allocator simply
 * rebuilds its rows from the reduced demand. Once ANY shipment exists that rebuild refuses (rewriting rows under a
 * commitment is the original hazard), so the refunded units' reservation used to stay held. This plan answers one
 * question without rewriting anything: how many units may each allocation row give back?
 *
 * THE RULE, per sales line and per component (a kit allocates one row per component and warehouse):
 *
 *   target   = factor * max(0, lineQty - refundedQty)           (0 when the order has no demand left at all)
 *   current  = the line's allocation rows for that component, summed. Dispatch RETAINS a row and only lowers the stock
 *              level's reserved quantity, so `current` includes the units already shipped.
 *   floor    = what committed shipments (any status but PENDING) already cover, so a picked or packed shipment keeps
 *              the rows it needs.
 *   trim     = current - max(target, floor), never below zero.
 *
 * Refunded units come out of the UNSHIPPED part first (owner ruling): the trim never goes below what shipped, and a
 * refund larger than the unshipped part is simply clamped, never taken from shipped rows.
 *
 * IDEMPOTENT by construction: the answer is computed from the rows as they stand, so a replay finds `current` already at
 * `target` and trims nothing. A line whose rows name a component its requirements do not know is skipped whole: a stale
 * pin must never be read as "no demand".
 *
 * WHAT THIS DELIBERATELY DOES NOT TOUCH: the rows' cost-layer snapshots and the order's posted allocation amount. The
 * refund's own cost reversal already consumed the refunded units from those records (and later refunds replay that
 * consumption), so shrinking them here would count the same units twice.
 */
export type TrimLine = {
  id: string
  qty: DecimalInput
  /** Per-unit requirement of each component (a SIMPLE product requires itself at factor 1). */
  requirements: ReadonlyArray<{ productId: string; factor: Prisma.Decimal }>
}

export type TrimRow = { lineId: string; productId: string; warehouseId: string; qty: DecimalInput }

export type TrimCommittedRow = { lineId: string; productId: string; warehouseId: string; qty: DecimalInput }

export type TrimStep = { lineId: string; productId: string; warehouseId: string; qty: Prisma.Decimal }

const EPSILON = new Prisma.Decimal('0.000001')
const rowKey = (row: { lineId: string; productId: string; warehouseId: string }) => `${row.lineId}\u0000${row.productId}\u0000${row.warehouseId}`

export function planUnshippedTrim(input: {
  lines: readonly TrimLine[]
  rows: readonly TrimRow[]
  committed: readonly TrimCommittedRow[]
  refundedByLine: ReadonlyMap<string, DecimalInput>
  /** The order is cancelled or refunded in full: it has no demand, whatever the quantities say. */
  noDemand: boolean
}): TrimStep[] {
  const committedAtRow = new Map<string, Prisma.Decimal>()
  for (const row of input.committed) {
    committedAtRow.set(rowKey(row), (committedAtRow.get(rowKey(row)) ?? new Prisma.Decimal(0)).add(toDecimal(row.qty)))
  }
  const steps: TrimStep[] = []
  for (const line of input.lines) {
    const lineRows = input.rows.filter((row) => row.lineId === line.id)
    if (lineRows.length === 0) continue
    const factorByProduct = new Map<string, Prisma.Decimal>()
    for (const requirement of line.requirements) {
      factorByProduct.set(requirement.productId, (factorByProduct.get(requirement.productId) ?? new Prisma.Decimal(0)).add(requirement.factor))
    }
    // A row for a component the requirements do not name: the recipe is not what the rows were written from.
    if (lineRows.some((row) => !factorByProduct.has(row.productId))) continue

    const refunded = toDecimal(input.refundedByLine.get(line.id) ?? 0)
    const remainingUnits = input.noDemand ? new Prisma.Decimal(0) : Prisma.Decimal.max(0, toDecimal(line.qty).sub(refunded))

    for (const [productId, factor] of factorByProduct) {
      const rows = lineRows.filter((row) => row.productId === productId)
      if (rows.length === 0) continue
      const current = rows.reduce((sum, row) => sum.add(toDecimal(row.qty)), new Prisma.Decimal(0))
      const floor = rows.reduce((sum, row) => sum.add(committedAtRow.get(rowKey(row)) ?? 0), new Prisma.Decimal(0))
      const keep = Prisma.Decimal.max(factor.mul(remainingUnits), floor)
      // Floored to the column scale: a trim must never take more than the arithmetic allows.
      let excess = floorFulfillmentQty(current.sub(keep))
      if (excess.lte(EPSILON)) continue

      const trimmable = rows
        .map((row) => ({
          row,
          room: toDecimal(row.qty).sub(committedAtRow.get(rowKey(row)) ?? 0),
        }))
        .filter((entry) => entry.room.gt(EPSILON))
        .sort((a, b) => b.room.comparedTo(a.room) || a.row.warehouseId.localeCompare(b.row.warehouseId))
      for (const { row, room } of trimmable) {
        if (excess.lte(EPSILON)) break
        const take = Prisma.Decimal.min(excess, room)
        steps.push({ lineId: row.lineId, productId: row.productId, warehouseId: row.warehouseId, qty: take })
        excess = excess.sub(take)
      }
    }
  }
  return steps
}
