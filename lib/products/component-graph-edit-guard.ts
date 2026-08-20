import type { Prisma, ProductType } from '@/app/generated/prisma/client'

/**
 * A BEST-EFFORT EARLY REFUSAL OF A COMPONENT-GRAPH EDIT THAT WOULD RETROACTIVELY INVALIDATE
 * IN-FLIGHT SALES WORK (o3d-4kfh r5; supersedes the r4 shape).
 *
 * READ THIS FIRST — WHAT THIS IS AND IS NOT.
 *
 * This is NOT the correctness boundary, and it is NOT atomic. r4 claimed both and neither was true:
 *
 *   - NOT A SERIALIZATION BOUNDARY (r5 Codex finding 2). The component writers take
 *     `COMPONENT_GRAPH_WRITE_LOCK_KEY`; `allocateSalesOrder`, `confirmSalesOrderShipments` and the
 *     PENDING -> PICKING commitment do NOT take it. Under Postgres' default READ COMMITTED / MVCC
 *     snapshotting, this query can therefore see an empty blocker set while a concurrent transaction
 *     is reading the OLD graph, committing old-graph allocations, even starting to pick — and then
 *     the edit commits on top. Nothing here detects that. Tests that assert local call ordering
 *     (guard inside the transaction, before the write) prove the ordering and nothing about the race.
 *
 *   - NOT THE THING THAT GUARANTEES CORRECTNESS. That is the GRAPH-VERSION CAS (r6 Codex finding 1):
 *     `bumpFulfillmentGraphVersions` below moves `Product.fulfillmentGraphVersion` for this product
 *     and every KIT above it in the same transaction as the edit; `allocateSalesOrder` stamps the
 *     version it expanded onto every `OrderAllocation` row; and `validateAllocationIntegrity` /
 *     `validateCommittedShipmentCoverage` refuse a commitment or a dispatch whose stamp no longer
 *     matches. That is what catches the race, in EITHER interleaving, and it is the only thing that
 *     can: proportionality against a mutable current graph cannot distinguish a uniform rescale
 *     (2xA+1xB -> 4xA+2xB, committed A=2/B=1) from a legitimate half shipment.
 *
 *   - The proportionality backstop (`findUncoveredCommittedShipment`) still runs at every shipment
 *     transition including dispatch and still catches NON-uniform edits. It is a second net, not the
 *     boundary; r5 claimed it was the boundary and that was wrong.
 *
 * What this IS: an early, cheap, operator-facing refusal that stops the ordinary (uncontended)
 * editor/import case from creating the corruption at all, so the dispatch-time check is a backstop
 * rather than the everyday experience.
 *
 * o3d-kouj — WHAT CHANGED UNDER THIS GUARD, AND WHY IT STILL EARNS ITS PLACE. The durable fix this
 * paragraph used to defer — a persisted immutable per-sales-line fulfilment-requirement snapshot —
 * now exists (`lib/products/fulfillment-requirement-snapshot.ts`). Every reader resolves through it,
 * so a line that has been allocated is no longer READ against the current graph at all, and the
 * corruption described below can no longer be created by an edit that slips past this query: the
 * order keeps requiring what it was allocated from.
 *
 * This guard is therefore no longer standing between an edit and a silent quantity error. What it
 * still does is keep the CATALOGUE and the IN-FLIGHT WORK from diverging where a human can see it —
 * an edit that lands while an order is being picked leaves the warehouse holding a pick list for a
 * recipe the product no longer has, which is confusing even when every number is right. Its value
 * is now operational rather than protective, and if it is ever relaxed the argument to make is that
 * one, not "the snapshot has it covered" (it does) — see the note on the CAS below for the shape of
 * the mistake that would be.
 *
 * NOT relaxed here, deliberately: this branch changed what the readers read, and loosening a
 * refusal in the same change would make any regression impossible to attribute.
 *
 * THE CORRUPTION IT REFUSES. A KIT requires 2xA + 1xB; an order is allocated and its shipment is
 * PICKING, both holding A=2 / B=1. The kit is re-composed to 2xA + 2xB. Every FLAT check still
 * passes — the committed-coverage backstop compares per (line, warehouse, product), the per-leaf
 * dispatch cap only rejects leaves that EXCEED demand, and `calculateDecimalCoverageByLine` credits
 * whole kits so the half-kit shows up nowhere.
 *
 * SCOPE: IN-FLIGHT WORK ONLY (r5 Codex finding 5). r4 counted EVERY allocation row and EVERY
 * non-PENDING shipment line with no lifecycle filter. Dispatch deliberately RETAINS allocation
 * rows, and a SHIPPED shipment has no deletion path — so the first order to ship froze that KIT and
 * its whole ancestor chain permanently, and the refusal message told the operator to dispatch,
 * which could not clear it. Cloning the product was the only escape. So:
 *
 *   - an allocation blocks only while its ORDER is still in flight (not SHIPPED / COMPLETED /
 *     DELIVERED / CANCELLED — none of which has a transition back into a picking state);
 *   - a committed shipment blocks only while it is PICKING or PACKED. SHIPPED is done.
 *
 * Both blockers have a real operator exit (see `describeComponentGraphEditBlockers`), which is the
 * property r4 lacked — and r6 fixed the second half of that property: the exit must not be HARMFUL
 * either. A PICKING shipment on a CANCELLED order still blocks (units are physically picked), but
 * the exit is the repair action that discards it, never "dispatch it".
 *
 * THE RESIDUAL THIS GUARD LEFT, AND WHERE IT WENT (o3d-kouj, now closed): completed history used to
 * read against the CURRENT graph, so a DELIVERED order's fulfilment analytics, its coverage figures
 * and any later report expanded today's recipe rather than the one it shipped under. That was never
 * fixable here — permanently freezing the catalogue to protect history was the r4 behaviour and was
 * strictly worse. It is fixed by the per-line snapshot instead: dispatch RETAINS the allocation
 * rows, so a shipped line can never be re-captured, and its recipe is frozen at the moment it
 * shipped for as long as the row exists.
 *
 * WHAT COUNTS AS AFFECTED. `expandFulfillmentRequirementsDecimal` recurses through a component ONLY
 * when that component's product type is KIT; a BOM is a fulfilment LEAF. So editing product P
 * changes a sales line's requirements iff the line's product is P itself, or is a KIT that reaches P
 * through a chain of KIT-typed components — the ancestor walk below.
 *
 * WHICH MUTATIONS CAN DO THAT AT ALL (r5 Codex finding 6). Two, and only two:
 *   - rewriting the component list of a product that IS a KIT;
 *   - changing a product's KIT-ness — KIT -> anything, or anything -> KIT.
 * A component-list edit on a BOM cannot: fulfilment never reads a BOM's component list. Refusing it
 * blocked manufacturing recipe maintenance for no fulfilment reason at all. A BOM -> SIMPLE change
 * likewise cannot (leaf before, leaf after). Callers pass what they are actually doing via
 * {@link ComponentGraphMutation} and the guard answers `[]` for the harmless kinds without touching
 * the database.
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

/**
 * What the caller is about to do to `productId`. Types are the ones read UNDER the caller's lock —
 * passing a pre-lock snapshot asks the guard a question about a state that may no longer exist.
 *
 *  - `components`: rewrite the component list, leaving the type alone (the editor's component
 *    panel, the CSV component pass).
 *  - `kitness`: change the product's type (the editor's detail form, the CSV type column). This is
 *    the mutation r4 missed entirely for KIT <-> BOM.
 */
export type ComponentGraphMutation =
  | { kind: 'components'; currentType: ProductType }
  | { kind: 'kitness'; currentType: ProductType; nextType: ProductType }

/**
 * Does this mutation change what any sales line is deemed to require?
 *
 *  - a component-list rewrite matters only on a KIT: fulfilment expansion treats a BOM as a leaf and
 *    never reads its component list (r5 Codex finding 6);
 *  - a type change matters exactly when KIT-NESS flips. KIT -> BOM turns recursively-expanded
 *    components into a fulfilment leaf; BOM -> KIT does the reverse. BOM -> SIMPLE is leaf-to-leaf
 *    and changes nothing, and a type change that is not a change at all (KIT -> KIT) is not a
 *    mutation — which is why the editor's ordinary "rename a kit" save must NOT run this guard.
 *
 * Exported because the answer is also the answer to "must the caller run the guard at all", and the
 * type-change paths need it BEFORE they write the new type (r5 Codex finding 1).
 */
export function componentGraphMutationAffectsFulfillment(mutation: ComponentGraphMutation): boolean {
  if (mutation.kind === 'components') return mutation.currentType === 'KIT'
  return (mutation.currentType === 'KIT') !== (mutation.nextType === 'KIT')
}

export type ComponentGraphEditBlocker = {
  orderId: string
  orderRef: string
  /**
   * The SALES ORDER's status. Carried because the exit an operator is given depends on it: a
   * PICKING shipment on a CANCELLED order must NOT be cleared by dispatching it (r6 Codex finding
   * 4 — that ships goods for a cancelled sale), and dispatch on a cancelled order is refused
   * outright now. See {@link describeComponentGraphEditBlockers}.
   */
  orderStatus: string
  lineId: string
  lineLabel: string
  /** The order line's own product — P itself, or the KIT ancestor that reaches it. */
  productId: string
  /** `committed_shipment` outranks `allocation`: it is the one already being physically handled. */
  reason: 'allocation' | 'committed_shipment'
}

type GuardClient = Pick<Prisma.TransactionClient, 'productComponent' | 'salesOrderLine'>
type GraphVersionClient = GuardClient & Pick<Prisma.TransactionClient, 'product'>

/**
 * Order statuses from which a line can still be picked, packed or re-allocated. The complement —
 * SHIPPED, COMPLETED, DELIVERED, CANCELLED — has no outgoing transition back into any of these
 * (see `SALES_ORDER_TRANSITIONS`), so a retained allocation row on such an order is history, not a
 * live claim, and must not freeze the catalogue.
 */
const IN_FLIGHT_ORDER_STATUSES = [
  'DRAFT',
  'PENDING_PAYMENT',
  'ON_HOLD',
  'PROCESSING',
  'ALLOCATED',
  'PICKING',
  'PACKING',
] as const

/**
 * Committed shipment statuses that are still in flight. PENDING is not committed at all (a draft
 * commits nothing and the four allocation mutation paths reconcile drafts against their backing
 * rows), and SHIPPED is finished — the units are gone and no later act reads the graph for them.
 */
const IN_FLIGHT_COMMITTED_SHIPMENT_STATUSES = ['PICKING', 'PACKED'] as const

/**
 * Every product whose FULFILMENT REQUIREMENTS change when `productId`'s component list — or its own
 * KIT-ness — changes: itself, plus its KIT-typed ancestors, transitively.
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
 * The IN-FLIGHT sales work a component-graph edit on `productId` would retroactively invalidate.
 *
 * Returns `[]` — without reading anything — for a mutation that cannot change any sales line's
 * requirements (a BOM recipe edit, a BOM <-> SIMPLE conversion).
 *
 * The caller SHOULD run this inside the same transaction as the write it guards, so at least its
 * own snapshot is consistent with what it is about to commit. That is NOT sufficient to serialize
 * against allocation and commitment writers, which take no component-graph lock — see the module
 * docstring. Treat a clean result as "no in-flight work was visible", never as "no in-flight work
 * exists".
 */
export async function findComponentGraphEditBlockers(
  client: GuardClient,
  productId: string,
  mutation: ComponentGraphMutation,
): Promise<ComponentGraphEditBlocker[]> {
  if (!componentGraphMutationAffectsFulfillment(mutation)) return []

  const affectedProductIds = await collectFulfillmentAffectedRootProducts(client, productId)

  const lines = await client.salesOrderLine.findMany({
    where: {
      productId: { in: affectedProductIds },
      OR: [
        {
          allocations: { some: {} },
          order: { status: { in: [...IN_FLIGHT_ORDER_STATUSES] } },
        },
        {
          shipmentLines: {
            some: { shipment: { status: { in: [...IN_FLIGHT_COMMITTED_SHIPMENT_STATUSES] } } },
          },
        },
      ],
    },
    select: {
      id: true,
      orderId: true,
      productId: true,
      sku: true,
      description: true,
      order: { select: { orderNumber: true, externalOrderNumber: true, status: true } },
      allocations: { select: { id: true }, take: 1 },
      shipmentLines: {
        where: { shipment: { status: { in: [...IN_FLIGHT_COMMITTED_SHIPMENT_STATUSES] } } },
        select: { id: true },
        take: 1,
      },
    },
  })

  return lines.map((line) => ({
    orderId: line.orderId,
    orderRef: line.order.orderNumber ?? line.order.externalOrderNumber ?? line.orderId.slice(0, 8),
    orderStatus: String(line.order.status),
    lineId: line.id,
    lineLabel: line.sku ?? line.description,
    productId: line.productId!,
    reason: line.shipmentLines.length > 0 ? 'committed_shipment' as const : 'allocation' as const,
  }))
}

/**
 * BUMP THE FULFILMENT GRAPH VERSION of `productId` and every KIT that reaches it (o3d-4kfh r6,
 * Codex finding 1).
 *
 * The bump set is exactly {@link collectFulfillmentAffectedRootProducts} — the same walk the guard
 * uses — because "whose expansion changed?" and "whose in-flight work is invalidated?" are the same
 * question. Bumping only the edited product would leave every KIT ABOVE it stamping an unchanged
 * version while its expansion moved, which is the nested-kit hole all over again.
 *
 * MUST run in the same transaction as the component/type write it describes, and AFTER it: a
 * version that moves without the graph moving is a spurious refusal, and a graph that moves without
 * the version moving is the defect this closes.
 *
 * Returns the product ids whose version was bumped.
 */
export async function bumpFulfillmentGraphVersions(
  client: GraphVersionClient,
  productId: string,
  mutation: ComponentGraphMutation,
): Promise<string[]> {
  // Same predicate as the guard: a BOM recipe edit and a BOM <-> SIMPLE conversion cannot change
  // any sales line's requirements, so bumping for them would refuse commitments for no reason.
  if (!componentGraphMutationAffectsFulfillment(mutation)) return []

  const affectedProductIds = await collectFulfillmentAffectedRootProducts(client, productId)
  if (affectedProductIds.length === 0) return []
  await client.product.updateMany({
    where: { id: { in: affectedProductIds } },
    data: { fulfillmentGraphVersion: { increment: 1 } },
  })
  return affectedProductIds
}

/** The order statuses from which nothing can be dispatched any more (r6 Codex finding 4). */
const TERMINAL_REFUSING_ORDER_STATUSES = new Set(['CANCELLED'])

/**
 * The operator-facing refusal.
 *
 * EVERY ACTION IT NAMES MUST ACTUALLY CLEAR THE BLOCKER, *AND* MUST NOT BE HARMFUL. Two rounds have
 * broken one half or the other:
 *
 *   - r4 told the operator to dispatch the orders when dispatch could not clear it, because the
 *     guard had no lifecycle filter and a shipped order blocked forever;
 *   - r5 (this message, before r6) named dispatch as the exit for a PICKING/PACKED shipment
 *     WITHOUT looking at the parent order. On a CANCELLED order that advised dispatching goods for
 *     a cancelled sale, which is worse than the block it resolves. An exit that resolves the block
 *     by doing something harmful is not an exit.
 *
 * So the exits are now split by the parent order's status:
 *
 *   - an ALLOCATION blocker clears when the order is deallocated, dispatched, or cancelled (all
 *     three either remove the rows or move the order to a terminal status). An allocation blocker
 *     can only exist on an in-flight order by construction (`IN_FLIGHT_ORDER_STATUSES`), so no
 *     cancelled-order case arises here;
 *   - a PICKING/PACKED SHIPMENT blocker on a LIVE order clears by DISPATCHING that shipment, or by
 *     cancelling the whole order — `cancelSalesOrderFulfillmentState` deletes PENDING/PICKING/PACKED
 *     shipments outright. `SHIPMENT_TRANSITIONS` is forward-only and IMS has no per-shipment cancel
 *     (o3d-tv1q), which is why the message must not offer one;
 *   - a PICKING/PACKED SHIPMENT blocker on a CANCELLED order clears ONLY through the repair action
 *     (`discardCancelledOrderShipments`), which deletes the order's remaining non-dispatched
 *     shipments. Dispatch is refused on a cancelled order now (`transitionShipmentStatus`), and
 *     cancelling again is not a transition CANCELLED has — which is exactly why r5's advice was a
 *     dead end as well as a harmful one.
 */
export function describeComponentGraphEditBlockers(
  blockers: ComponentGraphEditBlocker[],
): string {
  const committed = blockers.filter((blocker) => blocker.reason === 'committed_shipment')
  const cancelledCommitted = committed.filter(
    (blocker) => TERMINAL_REFUSING_ORDER_STATUSES.has(blocker.orderStatus),
  )
  const liveCommitted = committed.filter(
    (blocker) => !TERMINAL_REFUSING_ORDER_STATUSES.has(blocker.orderStatus),
  )
  const orderRefs = [...new Set(blockers.map((blocker) => blocker.orderRef))].sort()
  const cancelledRefs = [...new Set(cancelledCommitted.map((blocker) => blocker.orderRef))].sort()
  const shown = orderRefs.slice(0, 10).join(', ')
  const overflow = orderRefs.length > 10 ? ` and ${orderRefs.length - 10} more` : ''
  return 'Cannot change these components while sales orders are in flight against them: '
    + `${orderRefs.length} order(s) (${shown}${overflow}) still hold allocations`
    + (committed.length > 0 ? ` or picking/packed shipments (${committed.length} line(s))` : '')
    + ' for this product or a kit that contains it. IMS expands the CURRENT component graph '
    + 'everywhere — allocation, shipment drafts, the dispatch cap, the reservation census — so '
    + 'editing it now would silently change what those orders are deemed to require and let an '
    + 'incomplete kit ship. To clear this: deallocate, dispatch or cancel those orders'
    + (liveCommitted.length > 0
      ? '; a shipment already at picking/packed can only be cleared by dispatching it or cancelling '
        + 'its order (there is no route back to draft and no per-shipment cancel)'
      : '')
    + (cancelledRefs.length > 0
      ? `; the picking/packed shipment(s) on already-cancelled order(s) ${cancelledRefs.join(', ')} `
        + 'must NOT be dispatched — that would ship goods for a cancelled sale, and IMS refuses it — '
        + 'use "Discard shipments" on those cancelled orders, which deletes their remaining '
        + 'non-dispatched shipments'
      : '')
    + '. Orders that are already shipped, completed or delivered do NOT block — only work still in '
    + 'flight does. Alternatively, clone this product and change the copy.'
}
