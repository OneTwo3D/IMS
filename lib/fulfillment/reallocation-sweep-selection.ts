import type { Prisma, SalesOrderStatus } from '@/app/generated/prisma/client'

/**
 * THE reallocation sweep's selection predicate, in ONE place (o3d-z82a, Codex review r5).
 *
 * WHY THIS MODULE EXISTS. "The order is back in the sweep's eligible set" is only a resolution
 * of an open coverage obligation if the sweep would ACTUALLY pick the order up. An earlier
 * revision asserted that from a copy of the sweep's status list, pinned to the original by a
 * parity test. Matching a list is not being eligible: the sweep selects on status AND on having
 * no shipments, so an ALLOCATED order that already has a shipment matches the list exactly and
 * is never selected — the obligation was handed to nobody, which is the failure mode the handoff
 * was introduced to end.
 *
 * So there is no copy any more. The sweep's own page query is built from
 * `REALLOCATION_SWEEP_SELECTION`, and anything asking "will the sweep take this order?" asks the
 * database with that same fragment. A clause added to the sweep's selection is automatically a
 * clause in the eligibility answer; drift is not something a test has to catch, because there is
 * nothing to drift.
 *
 * It is a leaf module ON PURPOSE: types only, no runtime imports. `reallocation-sweep.ts` pulls
 * in `@/lib/shopping`, and the WooCommerce order importer imports the consumer of this predicate
 * — importing the sweep itself from there would put the shopping facade (and, through the
 * connector registry, the importer) on its own import graph.
 */

/**
 * The statuses the sweep selects on, and the `requireStatusUnderLock` guard it passes to the
 * allocator — they must agree exactly: a wider guard would permit a write the selector never
 * intended, a narrower one would skip every candidate.
 *
 * It must also match the replenishment allocator's BACKORDER_ELIGIBLE_STATUSES. That path selects
 * PROCESSING *and* ALLOCATED, and a skip there consumes a one-shot stock trigger. ON_HOLD ->
 * ALLOCATED is a legal transition (sales-order-state.ts), so a sweep that only scanned PROCESSING
 * would leave an order returned to ALLOCATED permanently outside its own backstop.
 */
export const REALLOCATION_ELIGIBLE_STATUSES = [
  'PROCESSING',
  'ALLOCATED',
] as const satisfies readonly SalesOrderStatus[]

/**
 * Everything that decides whether the sweep will take an order, and nothing that decides WHEN.
 *
 * The keyset cursor and the per-cycle watermark are deliberately NOT here. They bound which
 * orders a given TICK sees; every eligible order is reached within one rotation, so they are a
 * schedule, not eligibility. `shipments: { none: {} }` is the opposite: it is permanent for an
 * order that has shipped anything, and it is exactly what a status list cannot express —
 * reallocating such an order would decrement stock against committed ShipmentLines, so the sweep
 * excludes it for good.
 */
export const REALLOCATION_SWEEP_SELECTION = {
  status: { in: [...REALLOCATION_ELIGIBLE_STATUSES] },
  shipments: { none: {} },
} satisfies Prisma.SalesOrderWhereInput

/** The narrow client shape this needs, so a caller inside a transaction can pass its `tx`. */
export type SweepSelectionClient = {
  salesOrder: {
    findFirst(args: {
      where: Prisma.SalesOrderWhereInput
      select: { id: true }
    }): Promise<{ id: string } | null>
  }
}

/**
 * Would the reallocation sweep select THIS order? Asked of the database with the sweep's own
 * predicate, not inferred from any property of the order.
 *
 * Answers "eventually", not "on the next tick": the cursor may have to rotate first. That is the
 * guarantee the handoff needs — something WILL revisit this order — and it is the strongest one
 * available, because a tick-level answer would go stale the moment the cursor moved.
 */
export async function isSelectedByReallocationSweep(
  tx: SweepSelectionClient,
  orderId: string,
): Promise<boolean> {
  const row = await tx.salesOrder.findFirst({
    where: { id: orderId, ...REALLOCATION_SWEEP_SELECTION },
    select: { id: true },
  })
  return row !== null
}
