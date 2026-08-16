import type { Prisma } from '@/app/generated/prisma/client'

/**
 * REFUSE A COMPONENT-GRAPH EDIT THAT WOULD RETROACTIVELY INVALIDATE COMMITTED SALES WORK
 * (o3d-4kfh r4, Codex finding 1).
 *
 * IMS has no immutable per-order-line fulfilment snapshot: every consumer — allocation, the draft
 * builder, the dispatch cap, the reservation census, the fulfilment analytics — expands a sales
 * line's product through the CURRENT `ProductComponent` graph. So editing a KIT's recipe silently
 * rewrites what every in-flight order for that kit is deemed to require, after the fact.
 *
 * The concrete corruption: a KIT requires 2xA + 1xB; an order is allocated and its shipment is
 * PICKING, both holding A=2 / B=1. The kit is re-composed to 2xA + 2xB. Nothing objects —
 *   - the flat committed-coverage backstop (`allocation_committed_shipment_uncovered`, both the
 *     TS and SQL invariant branches) sees each committed quantity exactly covered by its
 *     allocation row, because it compares per (line, warehouse, product) and never expands
 *     the graph;
 *   - the per-leaf dispatch cap accepts A=2 / B=1 because neither leaf EXCEEDS demand;
 *   - `calculateDecimalCoverageByLine` credits WHOLE kits, so the half-kit that ships is credited
 *     as half a kit and the shortfall shows up nowhere.
 * IMS dispatches an incomplete kit and reports nothing.
 *
 * TWO OPTIONS EXIST AND THIS IS THE SECOND ONE. The durable fix is a persisted, immutable
 * fulfilment-requirement snapshot per sales line, so a later graph edit cannot reach backwards at
 * all. That is a genuinely large change — fourteen modules expand the live graph today, and a
 * partial rollout (some readers snapshot-aware, some not) is strictly worse than none, because the
 * two populations would then disagree about the same order. Blocking the mutation is the bounded
 * fix that closes the same hole at its source, and it composes with the graph-aware
 * committed-coverage check now running at every shipment transition INCLUDING dispatch
 * (`validateCommittedShipmentCoverage` in shipment-service), which is the backstop for anything
 * that reaches the graph by another route (CSV import, direct SQL).
 *
 * WHAT COUNTS AS AFFECTED. `expandFulfillmentRequirementsDecimal` recurses through a component
 * ONLY when that component's product type is KIT; a BOM is a fulfilment LEAF. So editing product P
 * changes the requirements of a sales line if and only if the line's product is P itself, or is a
 * KIT that reaches P through a chain of KIT-typed components. That ancestor walk is what this
 * computes — narrowing the block to orders that can actually be corrupted, rather than freezing
 * every recipe in the catalogue whenever any order is open.
 */

/**
 * Thrown by paths that report failures by throwing (`updateProduct`). NOT a
 * `ProductStructureChangedError`: nothing raced, nothing is stale, and telling the operator to
 * reload and retry would send them round a loop that can never succeed.
 */
export class ComponentGraphInFlightSalesError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ComponentGraphInFlightSalesError'
  }
}

export type ComponentGraphEditBlocker = {
  orderId: string
  orderRef: string
  lineId: string
  lineLabel: string
  /** The order line's own product — P itself, or the KIT ancestor that reaches it. */
  productId: string
  /** `committed_shipment` outranks `allocation`: it is the one that can already be picked. */
  reason: 'allocation' | 'committed_shipment'
}

type GuardClient = Pick<Prisma.TransactionClient, 'productComponent' | 'salesOrderLine'>

/**
 * Every product whose FULFILMENT REQUIREMENTS change when `productId`'s component list (or its
 * own KIT-ness) changes: itself, plus its KIT-typed ancestors, transitively.
 *
 * Cycle-safe by the visited set — `detectComponentCycle` is what stops cycles being created, but
 * this must not hang on one that already exists.
 */
export async function collectFulfillmentAffectedRootProducts(
  client: GuardClient,
  productId: string,
): Promise<string[]> {
  const affected = new Set<string>([productId])
  let frontier = [productId]

  while (frontier.length > 0) {
    const parents = await client.productComponent.findMany({
      where: { componentId: { in: frontier } },
      select: { productId: true, product: { select: { type: true } } },
    })
    const next: string[] = []
    for (const parent of parents) {
      // A BOM parent is a fulfilment leaf: its own components are never expanded, so a change
      // below it cannot alter what a sales line for it requires. Walking through it would block
      // edits that are provably harmless.
      if (parent.product.type !== 'KIT') continue
      if (affected.has(parent.productId)) continue
      affected.add(parent.productId)
      next.push(parent.productId)
    }
    frontier = next
  }

  return [...affected]
}

/**
 * The sales work a component-graph edit on `productId` would retroactively invalidate: order lines
 * on an affected root product that already hold an allocation or a committed (non-PENDING)
 * shipment line.
 *
 * A PENDING draft alone is deliberately NOT a blocker — it commits nothing, and the four mutation
 * paths that touch allocations already reconcile drafts against their backing rows
 * (`reconcilePendingShipments`). Blocking on a draft would make the guard fire on orders that can
 * still be rebuilt cleanly.
 *
 * The caller MUST run this inside the same transaction (and under the same component-graph
 * advisory lock) as the write it guards; checking outside is check-then-act and an allocation
 * committing in the window would slip straight through.
 */
export async function findComponentGraphEditBlockers(
  client: GuardClient,
  productId: string,
): Promise<ComponentGraphEditBlocker[]> {
  const affectedProductIds = await collectFulfillmentAffectedRootProducts(client, productId)

  const lines = await client.salesOrderLine.findMany({
    where: {
      productId: { in: affectedProductIds },
      OR: [
        { allocations: { some: {} } },
        { shipmentLines: { some: { shipment: { status: { not: 'PENDING' } } } } },
      ],
    },
    select: {
      id: true,
      orderId: true,
      productId: true,
      sku: true,
      description: true,
      order: { select: { orderNumber: true, externalOrderNumber: true } },
      allocations: { select: { id: true }, take: 1 },
      shipmentLines: {
        where: { shipment: { status: { not: 'PENDING' } } },
        select: { id: true },
        take: 1,
      },
    },
  })

  return lines.map((line) => ({
    orderId: line.orderId,
    orderRef: line.order.orderNumber ?? line.order.externalOrderNumber ?? line.orderId.slice(0, 8),
    lineId: line.id,
    lineLabel: line.sku ?? line.description,
    productId: line.productId!,
    reason: line.shipmentLines.length > 0 ? 'committed_shipment' as const : 'allocation' as const,
  }))
}

/** The operator-facing refusal. Names the orders, so the operator knows what to clear first. */
export function describeComponentGraphEditBlockers(
  blockers: ComponentGraphEditBlocker[],
): string {
  const committed = blockers.filter((blocker) => blocker.reason === 'committed_shipment')
  const orderRefs = [...new Set(blockers.map((blocker) => blocker.orderRef))].sort()
  const shown = orderRefs.slice(0, 10).join(', ')
  const overflow = orderRefs.length > 10 ? ` and ${orderRefs.length - 10} more` : ''
  return 'Cannot change these components while sales orders are in flight against them: '
    + `${orderRefs.length} order(s) (${shown}${overflow}) already hold allocations`
    + (committed.length > 0 ? ` or picked/packed/shipped shipments (${committed.length} line(s))` : '')
    + ' for this product or a kit that contains it. IMS expands the CURRENT component graph '
    + 'everywhere — allocation, shipment drafts, the dispatch cap, the reservation census — so '
    + 'editing it now would silently change what those orders are deemed to require and let an '
    + 'incomplete kit ship. Deallocate or dispatch those orders first, or clone this product and '
    + 'change the new one.'
}
