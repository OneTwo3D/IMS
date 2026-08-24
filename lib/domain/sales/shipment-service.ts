import { Prisma } from '@/app/generated/prisma/client'
import type { db } from '@/lib/db'
import { cogsEntryDataFromConsumed, consumeFifoLayersStrict, refreshSalesOrderLineCogs } from '@/lib/cost-layers'
import { serializeCostLayerSnapshot } from '@/lib/cost-layer-snapshots'
import { addMoney, roundQuantity, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import {
  validateSalesOrderStatusTransition,
  validateShipmentStatusTransition,
} from '@/lib/domain/workflows/action-guards'
import type { SalesOrderStatus } from '@/lib/domain/workflows/status-types'
import {
  lockSalesOrder,
  lockStockLevels,
  validateAllocationIntegrity,
  validateCommittedShipmentCoverage,
} from '@/lib/domain/sales/allocation-service'
import {
  isStockMovementIdempotencyConflict,
  saleDispatchMovementKey,
} from '@/lib/domain/inventory/stock-movement-idempotency'
import { buildStockMovementValueFieldsFromConsumed } from '@/lib/domain/inventory/stock-movement-value'
import { loadFulfillmentProductGraph } from '@/lib/products/kit-fulfillment'
import { lineFulfillmentRequirementQuantities } from '@/lib/products/fulfillment-requirement-snapshot'
import { UNCOMMITTED_SHIPMENT_STATUS } from '@/lib/domain/inventory/reservation-residual'
import { withSavepoint } from '@/lib/db/savepoint'

export const SHIPMENT_TX_OPTIONS = { maxWait: 5000, timeout: 20000 }
const SHIPMENT_QTY_EPSILON_DECIMAL = new Prisma.Decimal('0.000001')

/**
 * Deliberate call-site boundary for this number-shaped shipment service contract.
 * Do not treat this as Decimal-internal arithmetic.
 */
function shipmentBoundaryNumber(value: DecimalInput): number {
  return toDecimal(value).toNumber()
}

export type ShipmentServiceClient = Prisma.TransactionClient | typeof db

export type ConfirmShipmentsResult = {
  orderNumber: string | null
  shipmentCount: number
  deletedPendingCount: number
  createdShipments: Array<{ id: string; warehouseId: string; lineCount: number; totalQty: number }>
}

export type ShipmentTransitionContext = {
  id: string
  orderId: string
  warehouseId: string
  status: string
  warehouse: { code: string }
  order: { id: string; orderNumber: string | null; externalOrderNumber: string | null; status: string }
  lines: Array<{
    id: string
    lineId: string
    productId: string
    qty: DecimalInput
    product: { sku: string }
  }>
}

export type ShipmentTransitionResult =
  | { success: false; error: string }
  | {
      success: true
      transitioned: boolean
      dispatched: boolean
      shipment: ShipmentTransitionContext
      targetStatus: string
      previousStatus: string
      stockSyncProductIds: string[]
    }

/**
 * WHO DECIDES that the ORDER — not this one shipment — is fulfilled (o3d-0i5y r2).
 *
 * There are exactly two fulfilment paths in this system and they answer that question from
 * different evidence, so the answer has to be declared by the caller rather than guessed at here:
 *
 *  - `IMS` — the warehouse works the order inside IMS and dispatches shipment by shipment. The
 *    shipment rows ARE the fulfilment record, so "is the order done?" is derived from them:
 *    `findOrderShipmentShortfall` compares shipped leaf units against ordered-minus-refunded, and
 *    an order that shipped short is held open. This is the default, and the only path that has
 *    the evidence to make that comparison mean anything.
 *
 *  - `EXTERNAL` — a storefront or WMS/3PL fulfilled the order and is telling us so after the fact
 *    (`applyExternalFulfillmentUpdate`). THAT system owns completion and has already decided it:
 *    the WooCommerce completion flow treats Woo as "the dispatch authority for external storefront
 *    orders", and the WMS dispatch sweep reaches its own verdict per WMS part in
 *    `reconcileSplitOrder`, only applying a dispatch once EVERY part has despatched. IMS shipment
 *    rows on such an order are a back-filled projection of a decision taken elsewhere — auto-
 *    allocated and confirmed on the spot by `applyExternalFulfillmentUpdate`, and capped by
 *    whatever IMS stock happened to be on hand — so they routinely under-cover the ordered qty for
 *    reasons that say nothing about what the 3PL actually shipped.
 *
 * Re-deriving completion from those rows would therefore CONTRADICT the owner: it would hold the
 * order open, suppress the storefront completion push (and with it the customer despatch email),
 * and log a `shipped_short` WARNING on every external dispatch — training operators to ignore the
 * one signal that means something. So the shortfall check does not run when the caller declares
 * `EXTERNAL`; it is not that WMS is a special case of the check, it is that the check is IMS's
 * answer to a question already answered.
 */
export type OrderCompletionAuthority = 'IMS' | 'EXTERNAL'

export type ShipmentReconciliationResult = {
  shouldGenerateInvoice: boolean
  orderId: string
  /**
   * o3d-0i5y: present only when every shipment on the order has SHIPPED but the order still owes
   * quantity, in which case the order was deliberately NOT promoted to SHIPPED. Absent on the
   * ordinary path, so a caller that ignores it is unchanged.
   *
   * NEVER present under `EXTERNAL` completion authority — the shortfall is not evaluated there at
   * all, because a different mechanism has already decided the order is complete.
   */
  shortfall?: OrderShipmentShortfallLine[]
}

function canRunTransaction(
  client: ShipmentServiceClient,
): client is typeof db {
  return typeof (client as typeof db).$transaction === 'function'
}

async function runInTransaction<T>(
  client: ShipmentServiceClient,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return canRunTransaction(client)
    ? client.$transaction(callback, SHIPMENT_TX_OPTIONS)
    : callback(client)
}

async function loadShipmentTransitionContext(
  client: ShipmentServiceClient,
  shipmentId: string,
): Promise<ShipmentTransitionContext | null> {
  return client.shipment.findUnique({
    where: { id: shipmentId },
    include: {
      order: { select: { id: true, orderNumber: true, externalOrderNumber: true, status: true } },
      lines: { select: { id: true, lineId: true, productId: true, qty: true, product: { select: { sku: true } } } },
      warehouse: { select: { code: true } },
    },
  }) as Promise<ShipmentTransitionContext | null>
}

function shipmentLineDispatchFingerprint(line: ShipmentTransitionContext['lines'][number]): string {
  return [
    line.id,
    line.lineId,
    line.productId,
    shipmentBoundaryNumber(line.qty),
  ].join('|')
}

function hasSameShipmentLines(
  currentLines: ShipmentTransitionContext['lines'],
  lockedLines: ShipmentTransitionContext['lines'],
): boolean {
  if (currentLines.length !== lockedLines.length) return false
  const currentFingerprints = currentLines.map(shipmentLineDispatchFingerprint).sort()
  const lockedFingerprints = lockedLines.map(shipmentLineDispatchFingerprint).sort()
  return currentFingerprints.every((fingerprint, index) => fingerprint === lockedFingerprints[index])
}

/**
 * The order's quantities resolved to LEAF (component) units and keyed `${orderLineId}|${productId}`,
 * which is the only basis on which shipment rows, ordered qty and refunded qty are comparable.
 *
 * Extracted so the dispatch cap (`validateActiveShipmentTotalsWithinOrder`, "may this shipment go
 * out?") and the completion check (`findOrderShipmentShortfall`, "has everything gone out?") read
 * the SAME numbers from the SAME statements. They are two halves of one question and previously only
 * the first existed; computing the second independently is how the two would come to disagree about
 * what a kit line or a refund means (o3d-0i5y).
 */
type OrderLeafQuantities = {
  /** Order line id -> the SKU/description an operator will recognise. */
  lineLabelById: Map<string, string>
  orderedByLeaf: Map<string, Prisma.Decimal>
  refundedByLeaf: Map<string, Prisma.Decimal>
  /** Leaf qty on SHIPPED shipments — historical, and the only thing that counts as fulfilled. */
  shippedByLeaf: Map<string, Prisma.Decimal>
  /** Leaf qty on PICKING/PACKED shipments — committed, but not yet out of the door. */
  plannedByLeaf: Map<string, { lineId: string; plannedQty: Prisma.Decimal }>
}

async function loadOrderLeafQuantities(
  client: ShipmentServiceClient,
  orderId: string,
): Promise<OrderLeafQuantities> {
  // Non-PENDING shipment lines are already committed to the order's fulfilment
  // plan, so this check intentionally includes PICKING/PACKED rows as well as
  // SHIPPED rows. That makes concurrent dispatches race-safe for total-qty
  // validation: both transactions see the same active planned shipment set.
  const [orderLines, activeShipmentLines, refundLines] = await Promise.all([
    client.salesOrderLine.findMany({
      where: { orderId },
      // o3d-kouj: `fulfillmentRequirements` is the line's PINNED recipe — see the note below on
      // which graph this cap is judged against.
      select: {
        id: true,
        productId: true,
        qty: true,
        sku: true,
        description: true,
        fulfillmentRequirements: true,
      },
    }),
    client.shipmentLine.findMany({
      where: { shipment: { orderId, status: { not: 'PENDING' } } },
      select: { lineId: true, productId: true, qty: true, shipment: { select: { status: true } } },
    }),
    // o3d-339: refunded units must never be dispatched. A PENDING shipment built BEFORE a refund lands
    // is not rebuilt on refund — releaseReservationsAfterRefund refuses the reservation release while a
    // shipment exists (post-refund-release.ts) and defers — so without netting refunds here that stale,
    // now-PACKED shipment could ship goods the customer was refunded for. confirmSalesOrderShipments
    // already nets refunds at BUILD time; this is the dispatch-time backstop for a shipment that
    // predates the refund. Runs under the order lock (transitionShipmentStatus), so a concurrent refund
    // is serialized.
    client.salesOrderRefundLine.findMany({
      where: { refund: { orderId } },
      select: { salesOrderLineId: true, productId: true, qty: true },
    }),
  ])

  // Shipment lines are LEAF-product rows: a kit order line expands to its component products, so a kit
  // line can have several shipment lines (one per component) under the same lineId. All quantities must
  // therefore be compared in leaf-product units keyed by (orderLineId, productId) — expand each order
  // line's ordered qty AND each refund's refunded qty through the kit/BOM graph, exactly as
  // confirmSalesOrderShipments nets refunds at build time. Comparing component shipment qty against
  // parent-kit ordered/refunded qty would let a fractional-component kit slip refunded units past the
  // cap (e.g. two kits needing 0.1 of a component ship 0.2, but a per-kit cap of 1 would pass it).
  //
  // o3d-kouj: THE CAP IS NOW JUDGED AGAINST THE RECIPE THE ORDER WAS ALLOCATED FROM, not the
  // current one. `lineFulfillmentRequirementQuantities` returns the line's pinned per-unit
  // requirement set scaled by the quantity asked about, and falls back to expanding the current
  // graph only for a line that has never been allocated — which is the pre-snapshot behaviour, and
  // for such a line there is nothing in flight for a graph edit to drift.
  //
  // What that removes is the drift this comment used to describe: a kit re-composed BETWEEN packing
  // and dispatch changed what `orderedByLeaf` said the customer had bought, so a packed set could
  // become over- or under-shipped without anyone touching the order. The two bounded mitigations
  // that stood in for it remain and are still doing their own jobs — the component-graph edit guard
  // (`findComponentGraphEditBlockers`) stops the edit reaching an order mid-pick at all, and
  // `validateCommittedShipmentCoverage` still demands a COMPLETE PROPORTIONAL component set at every
  // transition including the dispatch below, which this per-leaf cap cannot see on its own
  // (A=2/B=1 against a 2xA+2xB kit exceeds neither leaf).
  //
  // Refund lines are expanded through THE ORDER LINE they refund, not through their own product:
  // refunding N units of a line reverses N times what that LINE requires, and the line is the thing
  // carrying the pinned recipe. A refund line whose product disagrees with the line it names is a
  // data anomaly with no pinned answer, so it falls back to expanding its own product.
  const productIds = [...new Set([
    ...orderLines.map((line) => line.productId).filter((id): id is string => !!id),
    ...refundLines.map((refundLine) => refundLine.productId).filter((id): id is string => !!id),
  ])]
  const graph = productIds.length > 0 ? await loadFulfillmentProductGraph(client, productIds) : new Map()

  const orderLineById = new Map(orderLines.map((line) => [line.id, line]))
  const lineLabelById = new Map<string, string>()
  const orderedByLeaf = new Map<string, Prisma.Decimal>()
  for (const line of orderLines) {
    lineLabelById.set(line.id, line.sku ?? line.description ?? line.id)
    if (!line.productId) continue // a description-only line has no product to ship
    for (const [componentId, componentQty] of lineFulfillmentRequirementQuantities(line, toDecimal(line.qty), graph)) {
      const key = `${line.id}|${componentId}`
      orderedByLeaf.set(key, (orderedByLeaf.get(key) ?? new Prisma.Decimal(0)).add(componentQty))
    }
  }

  const refundedByLeaf = new Map<string, Prisma.Decimal>()
  for (const refundLine of refundLines) {
    // An unmatched external refund (no order line / no product) can't be attributed to a leaf — skip it.
    if (!refundLine.salesOrderLineId || !refundLine.productId) continue
    const refundedLine = orderLineById.get(refundLine.salesOrderLineId)
    const refundedResolvable = refundedLine?.productId === refundLine.productId
      ? refundedLine
      : { id: refundLine.salesOrderLineId, productId: refundLine.productId }
    for (const [componentId, componentQty] of lineFulfillmentRequirementQuantities(refundedResolvable, toDecimal(refundLine.qty), graph)) {
      const key = `${refundLine.salesOrderLineId}|${componentId}`
      refundedByLeaf.set(key, (refundedByLeaf.get(key) ?? new Prisma.Decimal(0)).add(componentQty))
    }
  }

  // Split active leaf qty into ALREADY-SHIPPED (historical, cannot be un-shipped) and STILL-PLANNED
  // (PICKING/PACKED — what a dispatch is about to send). A POST-shipment refund (a return) legitimately
  // pushes already-shipped qty above ordered-minus-refunded; counting SHIPPED rows in the dispatch cap
  // would then wedge every future dispatch on the order (line A shipped-then-refunded fails the recheck,
  // blocking an unrelated PACKED line B). So only the still-planned qty is capped, against what remains
  // to ship after refunds AND after what already shipped (o3d-339).
  const shippedByLeaf = new Map<string, Prisma.Decimal>()
  const plannedByLeaf = new Map<string, { lineId: string; plannedQty: Prisma.Decimal }>()
  for (const shipmentLine of activeShipmentLines) {
    const key = `${shipmentLine.lineId}|${shipmentLine.productId}`
    if (shipmentLine.shipment.status === 'SHIPPED') {
      shippedByLeaf.set(key, (shippedByLeaf.get(key) ?? new Prisma.Decimal(0)).add(toDecimal(shipmentLine.qty)))
    } else {
      const entry = plannedByLeaf.get(key) ?? { lineId: shipmentLine.lineId, plannedQty: new Prisma.Decimal(0) }
      entry.plannedQty = entry.plannedQty.add(toDecimal(shipmentLine.qty))
      plannedByLeaf.set(key, entry)
    }
  }

  return { lineLabelById, orderedByLeaf, refundedByLeaf, shippedByLeaf, plannedByLeaf }
}

async function validateActiveShipmentTotalsWithinOrder(
  client: ShipmentServiceClient,
  orderId: string,
): Promise<string | null> {
  const {
    lineLabelById,
    orderedByLeaf,
    refundedByLeaf,
    shippedByLeaf,
    plannedByLeaf,
  } = await loadOrderLeafQuantities(client, orderId)

  for (const [key, { lineId, plannedQty }] of plannedByLeaf) {
    const label = lineLabelById.get(lineId)
    if (!label) {
      return `Shipment line ${lineId} no longer belongs to this order. Reload and retry.`
    }
    const orderedQty = orderedByLeaf.get(key) ?? new Prisma.Decimal(0)
    const refundedQty = refundedByLeaf.get(key) ?? new Prisma.Decimal(0)
    const shippedQty = shippedByLeaf.get(key) ?? new Prisma.Decimal(0)
    // Still shippable = ordered − refunded − already-shipped, never below zero. Only the not-yet-shipped
    // planned quantity is checked against it, so a historical post-ship refund doesn't fail the order.
    // Quantised to the Decimal(12,4) boundary the shipment rows persist at (o3d-odu), so a single
    // fractional component (0.5 kit x 0.3333 = 0.16665, persisted 0.1667) isn't rejected by a
    // rounding ulp — the false-reject that made every fractional kit dispatch fail. Rounded AFTER
    // the whole subtraction, not per term: rounding three terms separately lets half-ulp errors
    // compound. Kept exact (epsilon-only) beyond that, so nothing can be over-shipped.
    let shippableQty = roundQuantity(orderedQty.sub(refundedQty).sub(shippedQty), 4)
    if (shippableQty.lt(0)) shippableQty = new Prisma.Decimal(0)
    if (plannedQty.gt(shippableQty.add(SHIPMENT_QTY_EPSILON_DECIMAL))) {
      if (refundedQty.gt(0)) {
        // o3d-2k5: the remedy is now a control that exists, and the message names the three steps in
        // the order they must happen. Before this it said "unpack or cancel this shipment" and neither
        // was buildable: confirmSalesOrderShipments only replaces PENDING shipments, the transition map
        // is forward-only, and a per-shipment delete demanded a CANCELLED order. `reopenShipmentForRepack`
        // is the way back; the physical un-pack is the operator's own step in between, which is why it is
        // stated rather than implied.
        return `Shipment for line ${label} would ship more than remains after refunds — it was packed before the refund landed. `
          + 'Use "Reopen for repack" on this shipment (Sales → the order → Shipments), physically remove the refunded units from the parcel, '
          + 'then "Create Shipments" in the Stock Allocation panel to rebuild it to what remains.'
      }
      return `Shipment quantity for line ${label} exceeds ordered quantity. Reload and retry.`
    }
  }

  return null
}

/** One order line that has shipped less than it was ordered, net of refunds. */
export type OrderShipmentShortfallLine = {
  lineId: string
  /** SKU (or description) of the ORDER line, so the operator can find it on the order. */
  label: string
  /** The LEAF product actually short — for a kit line this is a component, not the kit. */
  productId: string
  orderedQty: number
  refundedQty: number
  shippedQty: number
  outstandingQty: number
}

/**
 * o3d-0i5y — "every shipment we raised has shipped" is NOT "the order is complete".
 *
 * Partial fulfilment is a deliberate workflow here: PICKING needs only that SOME allocation exists,
 * "Create Shipments" is offered whenever an ALLOCATED order has any allocation, and
 * `confirmSalesOrderShipments` emits lines only for the allocations that exist. The stated intent is
 * that you ship what you have and the rest stays outstanding. It did not: `reconcileOrderAfterShipment`
 * promoted the order to SHIPPED as soon as every EXISTING shipment reached SHIPPED, and SHIPPED only
 * goes on to COMPLETED/DELIVERED — so the unshipped remainder was declared complete and never revisited.
 *
 * Returns the lines still owed, or null when the order has shipped everything it owes.
 *
 * THE BASIS IS ORDERED MINUS REFUNDED, matching `selectOrdersNeedingAllocation` (o3d-jby) and the
 * dispatch cap above, because those are what decide whether anything more will ever be allocated or
 * dispatched. Comparing against GROSS ordered qty would make a partly-refunded order read as
 * permanently short and never close — the exact mistake o3d-jby fixed in the coverage selector.
 *
 * A FULL refund is UNCONDITIONAL zero demand, short-circuited on `refundStatus` rather than netted,
 * for the same reason `selectOrdersNeedingAllocation` does it: a monetary-only or shipping-only
 * refund line nets nothing per-line, so a fully refunded order would otherwise read as short forever.
 *
 * Only SHIPPED quantity counts as fulfilled. A PICKING/PACKED shipment is committed but has not left,
 * so it is still outstanding — which is the answer this function must give, since it exists to decide
 * whether the order is DONE.
 */
export async function findOrderShipmentShortfall(
  client: ShipmentServiceClient,
  orderId: string,
): Promise<OrderShipmentShortfallLine[] | null> {
  const order = await client.salesOrder.findUnique({
    where: { id: orderId },
    select: { refundStatus: true },
  })
  if (order?.refundStatus === 'FULL') return null

  const { lineLabelById, orderedByLeaf, refundedByLeaf, shippedByLeaf } =
    await loadOrderLeafQuantities(client, orderId)

  const shortfall: OrderShipmentShortfallLine[] = []
  for (const [key, orderedQty] of orderedByLeaf) {
    const separator = key.lastIndexOf('|')
    const lineId = key.slice(0, separator)
    const productId = key.slice(separator + 1)
    const refundedQty = refundedByLeaf.get(key) ?? new Prisma.Decimal(0)
    const shippedQty = shippedByLeaf.get(key) ?? new Prisma.Decimal(0)
    // Quantised to the Decimal(12,4) boundary the shipment rows persist at, and rounded AFTER the
    // whole subtraction, exactly as the dispatch cap does (o3d-odu) — otherwise a fractional kit
    // component reads as short by a rounding ulp on every order it appears on, and no such order
    // could ever be completed automatically.
    const outstandingQty = roundQuantity(orderedQty.sub(refundedQty).sub(shippedQty), 4)
    if (outstandingQty.lte(SHIPMENT_QTY_EPSILON_DECIMAL)) continue
    shortfall.push({
      lineId,
      label: lineLabelById.get(lineId) ?? lineId,
      productId,
      orderedQty: shipmentBoundaryNumber(orderedQty),
      refundedQty: shipmentBoundaryNumber(refundedQty),
      shippedQty: shipmentBoundaryNumber(shippedQty),
      outstandingQty: shipmentBoundaryNumber(outstandingQty),
    })
  }
  return shortfall.length > 0 ? shortfall : null
}

/**
 * Order statuses that already stand AT OR BEYOND `ALLOCATED` in the fulfilment progression.
 *
 * The status write at the end of `confirmSalesOrderShipments` is a FLOOR — "shipments exist for this
 * order, so it is at least allocated" — not a move. Applied to an order that is already further
 * along it is a DEMOTION, and `SALES_ORDER_TRANSITIONS` rightly has no PICKING/PACKING -> ALLOCATED
 * edge, so the guard threw and took the whole confirm down with it.
 *
 * o3d-0i5y r3 — THAT REFUSAL HAD NO REMEDY BEHIND IT. Since r1 an order that ships short is no
 * longer promoted to SHIPPED; it is deliberately left in whatever pre-shipment status it already
 * holds, and the operator is told to "allocate and ship the remainder". That advice worked from
 * ALLOCATED and from nowhere else: from PICKING or PACKING the residual allocation could be built,
 * but the confirm that turns it into shipments died on this line, so the order was stranded with no
 * route forward and no way back (PICKING/PACKING cannot return to ALLOCATED either). A refusal
 * without a remedy is the defect r1 set out to avoid, so the floor is now a floor.
 *
 * SHIPPED / COMPLETED / DELIVERED are deliberately NOT in the set. The r1 hold can never leave an
 * order in one of them — the promotion it declines is the only thing that writes them here — so
 * they are outside this fix, and they keep today's behaviour (the transition guard below refuses
 * them). Confirming fresh shipments onto an order the business already calls shipped is a separate
 * question with a separate blast radius; it is flagged, not smuggled in.
 */
const ORDER_STATUSES_AT_OR_BEYOND_ALLOCATED: ReadonlySet<string> = new Set<SalesOrderStatus>([
  'ALLOCATED',
  'PICKING',
  'PACKING',
])

export async function confirmSalesOrderShipments(
  client: ShipmentServiceClient,
  orderId: string,
): Promise<ConfirmShipmentsResult> {
  return runInTransaction(client, async (tx) => {
    await lockSalesOrder(tx, orderId)
    const so = await tx.salesOrder.findUnique({
      where: { id: orderId },
      select: { orderNumber: true, externalOrderNumber: true, status: true },
    })
    if (!so) throw new Error('Order not found')

    // Refused HERE, in words, and BEFORE the first write — not as a side effect of the status floor
    // below failing its transition check. A cancelled sale must never grow new shipments: they would
    // be picked, dispatched and their COGS recognised against an order that will not be invoiced,
    // which is the same irreversible harm `SHIPMENT_TRANSITION_REFUSING_ORDER_STATUSES` refuses for
    // the shipments already on it. Making the floor a floor (o3d-0i5y r3) removed the accidental cover this used to
    // get from `CANCELLED -> ALLOCATED` being an illegal transition, so it is now stated outright.
    if (so.status === 'CANCELLED') {
      throw new Error(
        'Cannot create shipments for a cancelled order. Discard the shipments still on it, or raise a new order if the goods are still to go out.',
      )
    }

    const allocs = await tx.orderAllocation.findMany({
      where: { orderId },
      select: { lineId: true, productId: true, warehouseId: true, qty: true },
    })
    if (!allocs.length) throw new Error('No allocations to confirm')

    const activeShipmentLines = await tx.shipmentLine.findMany({
      where: {
        shipment: { orderId, status: { not: 'PENDING' } },
      },
      select: { lineId: true, productId: true, shipment: { select: { warehouseId: true } }, qty: true },
    })
    const committedByAllocationKey = new Map<string, number>()
    for (const shipmentLine of activeShipmentLines) {
      const key = `${shipmentLine.lineId}|${shipmentLine.shipment.warehouseId}|${shipmentLine.productId}`
      committedByAllocationKey.set(
        key,
        (committedByAllocationKey.get(key) ?? 0) + shipmentBoundaryNumber(shipmentLine.qty),
      )
    }

    const allocAfterShipments = allocs.map((alloc) => {
      const key = `${alloc.lineId}|${alloc.warehouseId}|${alloc.productId}`
      const committed = committedByAllocationKey.get(key) ?? 0
      const effectiveQty = Math.max(0, shipmentBoundaryNumber(alloc.qty) - committed)
      return { ...alloc, qty: effectiveQty }
    }).filter((alloc) => alloc.qty > 0)

    // Refunded units must not ship even if stale allocation rows still reserve them
    // (refund state is orthogonal now and a refund does not delete allocations).
    // Allocations are leaf-product rows, so a refunded sales line is expanded to its
    // component requirements (kit/BOM aware) before reducing the matching allocations.
    const shipmentRefundLines = await tx.salesOrderRefundLine.findMany({
      where: { refund: { orderId } },
      select: { salesOrderLineId: true, productId: true, qty: true },
    })
    const refundProductIds = [...new Set(
      shipmentRefundLines.map((refundLine) => refundLine.productId).filter((id): id is string => !!id),
    )]
    const refundGraph = refundProductIds.length > 0
      ? await loadFulfillmentProductGraph(tx, refundProductIds)
      : new Map()
    // o3d-kouj: netted against the ORDER LINE's pinned recipe, for the same reason the dispatch cap
    // is. This build-time netting and `validateActiveShipmentTotalsWithinOrder` must agree unit for
    // unit — the cap is the backstop for a shipment that predates the refund, so if the two expanded
    // different recipes the backstop would refuse shipments this builder had just written.
    const refundedOrderLines = shipmentRefundLines.some((refundLine) => refundLine.salesOrderLineId)
      ? await tx.salesOrderLine.findMany({
        where: { orderId },
        select: { id: true, productId: true, fulfillmentRequirements: true },
      })
      : []
    const refundedOrderLineById = new Map(refundedOrderLines.map((line) => [line.id, line]))
    for (const refundLine of shipmentRefundLines) {
      if (!refundLine.salesOrderLineId || !refundLine.productId || shipmentBoundaryNumber(refundLine.qty) <= 0) continue
      const refundedLine = refundedOrderLineById.get(refundLine.salesOrderLineId)
      const requirements = lineFulfillmentRequirementQuantities(
        refundedLine?.productId === refundLine.productId
          ? refundedLine
          : { id: refundLine.salesOrderLineId, productId: refundLine.productId },
        toDecimal(refundLine.qty),
        refundGraph,
      )
      for (const [componentId, componentQty] of requirements) {
        let remaining = shipmentBoundaryNumber(componentQty)
        for (const alloc of allocAfterShipments) {
          if (remaining <= 0) break
          if (alloc.lineId !== refundLine.salesOrderLineId || alloc.productId !== componentId) continue
          const take = Math.min(remaining, alloc.qty)
          alloc.qty -= take
          remaining -= take
        }
      }
    }
    const effectiveAllocs = allocAfterShipments.filter((alloc) => alloc.qty > 0)

    if (!effectiveAllocs.length) {
      throw new Error('All allocated lines are already covered by active shipments or refunds')
    }

    const integrityError = await validateAllocationIntegrity(tx, orderId)
    if (integrityError) throw new Error(integrityError)

    const pendingShipmentMetadata = await tx.shipment.findMany({
      where: { orderId, status: 'PENDING' },
      select: { warehouseId: true, trackingNumber: true, shippingService: true },
    })
    const pendingMetadataByWarehouse = new Map(
      pendingShipmentMetadata.map((shipment) => [shipment.warehouseId, shipment]),
    )

    const deletedPending = await tx.shipment.deleteMany({ where: { orderId, status: 'PENDING' } })

    const byWarehouse = new Map<string, typeof effectiveAllocs>()
    for (const allocation of effectiveAllocs) {
      const group = byWarehouse.get(allocation.warehouseId) ?? []
      group.push(allocation)
      byWarehouse.set(allocation.warehouseId, group)
    }

    const createdShipments: ConfirmShipmentsResult['createdShipments'] = []
    for (const [warehouseId, whAllocs] of byWarehouse) {
      const pendingMetadata = pendingMetadataByWarehouse.get(warehouseId)
      const created = await tx.shipment.create({
        data: {
          orderId,
          warehouseId,
          status: 'PENDING',
          trackingNumber: pendingMetadata?.trackingNumber ?? null,
          shippingService: pendingMetadata?.shippingService ?? null,
          lines: {
            create: whAllocs.map((allocation) => ({
              lineId: allocation.lineId,
              productId: allocation.productId,
              qty: allocation.qty,
            })),
          },
        },
        select: { id: true },
      })
      createdShipments.push({
        id: created.id,
        warehouseId,
        lineCount: whAllocs.length,
        totalQty: whAllocs.reduce((sum, allocation) => sum + shipmentBoundaryNumber(allocation.qty), 0),
      })
    }

    // A FLOOR, not a move — see ORDER_STATUSES_AT_OR_BEYOND_ALLOCATED. An order already at or past
    // ALLOCATED keeps the status it has, so the residual shipments an order held short at PICKING or
    // PACKING needs can actually be created; only an order BEHIND the floor is raised to it.
    if (!ORDER_STATUSES_AT_OR_BEYOND_ALLOCATED.has(so.status)) {
      const transition = validateSalesOrderStatusTransition(so.status, 'ALLOCATED')
      if (!transition.success) throw new Error(transition.error)
      await tx.salesOrder.update({
        where: { id: orderId },
        data: { status: 'ALLOCATED' },
      })
    }

    return {
      orderNumber: so.orderNumber ?? so.externalOrderNumber,
      shipmentCount: byWarehouse.size,
      deletedPendingCount: deletedPending.count,
      createdShipments,
    }
  })
}

/**
 * Order statuses from which NO shipment may move any further (o3d-4kfh r6, Codex finding 4).
 *
 * CANCELLED only, and deliberately so. A cancelled order is a sale that will not happen; letting a
 * shipment on it advance — up to and including dispatch — ships goods for it and recognises the
 * COGS, which no later act reverses. `cancelSalesOrderFulfillmentState` deletes the order's
 * PENDING/PICKING/PACKED shipments in the same transaction as the cancel, so this only bites when a
 * shipment reached a cancelled order by some other route; but "should not be reachable" is not a
 * guard, and the harm if it is reached is irreversible.
 *
 * SHIPPED / COMPLETED / DELIVERED are NOT included. They mean the sale happened, and an order can
 * legitimately carry one straggling PACKED shipment while its status has already moved on (the
 * status is written by the storefront status mapping as well as by IMS). Refusing there would
 * strand real goods with no repair path — which is precisely the r4 mistake this round is undoing,
 * not one to repeat in the other direction.
 */
const SHIPMENT_TRANSITION_REFUSING_ORDER_STATUSES = new Set(['CANCELLED'])

function terminalOrderTransitionError(orderStatus: string): string {
  return `This order is ${orderStatus} — its shipments cannot be advanced or dispatched. `
    + 'Dispatching would ship goods for a cancelled sale and recognise COGS that nothing reverses. '
    + 'Use "Discard shipments" on the order to delete its remaining non-dispatched shipments '
    + '(already-dispatched ones are kept — reverse those with a refund instead).'
}

export type DiscardedCancelledShipment = {
  id: string
  status: string
  warehouseId: string
  trackingNumber: string | null
  shippingService: string | null
  lineCount: number
}

/**
 * THE REPAIR PATH for a cancelled order that still carries non-dispatched shipments (o3d-4kfh r6,
 * Codex finding 4).
 *
 * r5 advertised dispatch as the exit for a PICKING/PACKED shipment blocking a component-graph edit,
 * and its test explicitly relied on dispatch not requiring an open order. On a CANCELLED order that
 * advice was to ship goods for a cancelled sale — worse than the block it resolved — and the
 * alternative it named (cancel the order) is not a transition CANCELLED has, so there was no exit
 * at all. This is the exit: it removes the shipments instead of fulfilling them.
 *
 * PROPERTIES:
 *   - refuses unless the order really is CANCELLED (this is not a general per-shipment cancel;
 *     o3d-q8r6 remains open);
 *   - NEVER touches a SHIPPED shipment. Those are dispatch evidence the accounting sub-ledger and
 *     any refund reversal resolve through; the remedy for one of those is a refund;
 *   - IDEMPOTENT. A cancelled order with nothing left to discard writes nothing at all and returns
 *     an empty list, so a retry, a double-click or a re-run of the same repair is a no-op;
 *   - moves NO reservation. `reservedQty` is decremented only on the transition to SHIPPED, so a
 *     PENDING/PICKING/PACKED shipment holds none of its own; the cancel that produced this state
 *     already released the order's allocations.
 *   - writes its audit row through the SAME client, BEFORE the delete, carrying each shipment's
 *     tracking number — same reasoning as `reconcilePendingShipments`: a purchased label that IMS
 *     no longer references has to stay correlatable.
 *
 * The caller MUST already hold the order's row lock (`lockSalesOrder`).
 */
export async function discardCancelledOrderShipmentsInTx(
  tx: Prisma.TransactionClient,
  orderId: string,
  audit: { userId?: string | null } = {},
): Promise<{ discarded: DiscardedCancelledShipment[] }> {
  const order = await tx.salesOrder.findUnique({
    where: { id: orderId },
    select: { status: true, orderNumber: true, externalOrderNumber: true },
  })
  if (!order) throw new Error('Order not found')
  if (!SHIPMENT_TRANSITION_REFUSING_ORDER_STATUSES.has(String(order.status))) {
    throw new Error(
      `Only a cancelled order's shipments can be discarded; this order is ${order.status}. `
      + 'Cancel the order instead — that deletes its pending, picking and packed shipments in one '
      + 'transaction with the reservation release.',
    )
  }

  const doomed = await tx.shipment.findMany({
    where: { orderId, status: { in: ['PENDING', 'PICKING', 'PACKED'] } },
    select: {
      id: true,
      status: true,
      warehouseId: true,
      trackingNumber: true,
      shippingService: true,
      lines: { select: { id: true } },
    },
  })
  if (doomed.length === 0) return { discarded: [] }

  const discarded: DiscardedCancelledShipment[] = doomed.map((shipment) => ({
    id: shipment.id,
    status: String(shipment.status),
    warehouseId: shipment.warehouseId,
    trackingNumber: shipment.trackingNumber ?? null,
    shippingService: shipment.shippingService ?? null,
    lineCount: shipment.lines.length,
  }))
  const orderRef = order.orderNumber ?? order.externalOrderNumber ?? orderId.slice(0, 8)
  const carryingLabels = discarded.filter((row) => row.trackingNumber).length

  await tx.activityLog.create({
    data: {
      userId: audit.userId ?? null,
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'cancelled_order_shipments_discarded',
      tag: 'sales',
      level: 'WARNING',
      description: `Discarded ${discarded.length} non-dispatched shipment(s) left on cancelled order ${orderRef}`
        + (carryingLabels > 0
          ? ` — ${carryingLabels} carried a tracking number that IMS no longer references, cancel the label(s) with the carrier if unused`
          : ''),
      metadata: {
        discardedShipmentCount: discarded.length,
        discardedShipments: discarded,
        discardedTrackingNumbers: discarded
          .map((row) => row.trackingNumber)
          .filter((value): value is string => !!value),
      },
    },
  })
  await tx.shipment.deleteMany({ where: { id: { in: discarded.map((row) => row.id) } } })
  return { discarded }
}

export type ReopenShipmentForRepackResult =
  | { success: false; error: string }
  | {
      success: true
      orderId: string
      orderRef: string
      previousStatus: string
      trackingNumber: string | null
      shippingService: string | null
      lineCount: number
    }

/**
 * o3d-2k5 — THE WAY BACK FROM A COMMITTED SHIPMENT THAT MAY NO LONGER SHIP.
 *
 * `validateActiveShipmentTotalsWithinOrder` refuses to dispatch a PACKED shipment that would ship
 * more than remains after a refund (o3d-339). That refusal is the money fix and is not weakened
 * here. What it did not have was an exit: `confirmSalesOrderShipments` only ever REPLACES PENDING
 * shipments, `SHIPMENT_TRANSITIONS` is forward-only, and the only deletes of a non-PENDING shipment
 * demand a CANCELLED order (`discardCancelledOrderShipmentsInTx`) or take the whole order down
 * (`cancelSalesOrderFulfillmentState`). So the refusal named "unpack or cancel this shipment" and
 * neither control existed. This is that control.
 *
 * WHY REVERT RATHER THAN DELETE. `confirmSalesOrderShipments` already knows how to replace a
 * PENDING draft, and `reconcilePendingShipments` already knows how to retire one the allocation
 * rows no longer back, reporting the tracking number it was carrying. Reverting therefore reuses
 * the entire rebuild path with no new write protocol, and PRESERVES `trackingNumber` /
 * `shippingService` — a purchased label with a real carrier record behind it — which a delete
 * destroys. The hard sub-question, what happens to a JOURNALLED shipment, does not arise: the
 * daily Group B batch stages `status: 'SHIPPED'` (lib/connectors/xero/daily-sync.ts), so a PICKING
 * or PACKED shipment can never carry a journal date, and nothing in scope has been posted.
 *
 * WHY NOTHING IS RE-RESERVED HERE. `reservedQty` is decremented EXCLUSIVELY on the transition to
 * SHIPPED, and the OrderAllocation row is RETAINED through pick and pack — so a PACKED shipment has
 * released nothing and there is nothing to put back. What the revert moves is the DEMAND NETTING:
 * `allocateSalesOrder` nets non-PENDING shipments out of demand and re-adds them to the persisted
 * row, so the reverted quantity simply moves from the committed half of that claim to the
 * outstanding half and the row total is unchanged by construction. Any version of this that touched
 * `reservedQty` would double-count. That is also why the reallocation is the CALLER's step
 * (app/actions/allocation.ts) rather than this function's: `allocateSalesOrder` takes the same
 * order lock, so it cannot run inside this transaction.
 *
 * WHY NOT A REVERSE EDGE IN `SHIPMENT_TRANSITIONS`. A PACKED -> PENDING edge in that map is
 * reachable from `updateShipmentStatus`, which would let a caller revert a shipment WITHOUT the
 * reallocation and outbox resolution that make the revert mean anything — leaving the order with a
 * draft nothing has re-netted and a refund backstop row still deferred. The map stays forward-only
 * and this is the only door, so the three steps cannot be performed one-third of the way. It also
 * leaves `state-machines.test.ts`'s key-set assertion and the generated workflow docs describing a
 * lifecycle that is still, for every generic caller, forward-only.
 *
 * PHYSICAL, NOT ONLY DATA. A PACKED shipment has been picked and packed in the warehouse. This
 * reverts the RECORD; the units still have to come out of the box. The activity-log row below is
 * deliberately WARNING level and says so, because it is the only durable trace that a human owes
 * the warehouse an action.
 */
export async function reopenShipmentForRepack(
  client: ShipmentServiceClient,
  shipmentId: string,
  audit: { userId?: string | null } = {},
): Promise<ReopenShipmentForRepackResult> {
  // The order id is needed to take the lock, and it can only come from an unlocked read. Everything
  // decided on is re-read INSIDE the lock below; this read decides nothing.
  const located = await client.shipment.findUnique({
    where: { id: shipmentId },
    select: { orderId: true },
  })
  if (!located) return { success: false, error: 'Shipment not found' }

  return runInTransaction(client, async (tx) => {
    await lockSalesOrder(tx, located.orderId)
    const shipment = await tx.shipment.findUnique({
      where: { id: shipmentId },
      select: {
        id: true,
        orderId: true,
        status: true,
        trackingNumber: true,
        shippingService: true,
        lines: { select: { id: true } },
        order: { select: { status: true, orderNumber: true, externalOrderNumber: true } },
      },
    })
    if (!shipment) return { success: false as const, error: 'Shipment not found' }
    // The shipment moved to a different order between the two reads — the lock we hold is the wrong
    // one, so decide nothing.
    if (shipment.orderId !== located.orderId) {
      return { success: false as const, error: 'This shipment moved to another order. Reload and retry.' }
    }
    // SHIPPED is terminal, and deliberately so: the goods have gone, stock movements and COGS have
    // been written against them, and a dispatch is reversed by a refund or a return — which relieve
    // cost basis through the very rows a rollback would delete.
    if (shipment.status === 'SHIPPED') {
      return {
        success: false as const,
        error: 'This shipment has already been dispatched, so it cannot be reopened. '
          + 'Reverse a dispatch with a refund or a return, which relieve the cost of the goods that actually left.',
      }
    }
    if (shipment.status === UNCOMMITTED_SHIPMENT_STATUS) {
      return {
        success: false as const,
        error: 'This shipment is already a pending draft — nothing has been committed to it. '
          + 'Use "Create Shipments" in the Stock Allocation panel to rebuild it against what remains on the order.',
      }
    }
    // A cancelled order has its own repair, which DELETES rather than reopens: reopening would leave
    // a draft on an order that will never be invoiced, and confirmSalesOrderShipments refuses to
    // build shipments for a cancelled order anyway — so the rebuild step would dead-end.
    if (SHIPMENT_TRANSITION_REFUSING_ORDER_STATUSES.has(String(shipment.order.status))) {
      return { success: false as const, error: terminalOrderTransitionError(String(shipment.order.status)) }
    }

    const previousStatus = String(shipment.status)
    const orderRef = shipment.order.orderNumber ?? shipment.order.externalOrderNumber ?? shipment.orderId.slice(0, 8)
    await tx.shipment.update({
      where: { id: shipmentId },
      // Status ONLY. trackingNumber and shippingService are deliberately untouched — see the note
      // above on why a revert beats a delete — and shippedAt is null on any non-SHIPPED shipment,
      // so there is nothing to clear.
      data: { status: UNCOMMITTED_SHIPMENT_STATUS },
    })
    await tx.activityLog.create({
      data: {
        userId: audit.userId ?? null,
        entityType: 'SALES_ORDER',
        entityId: shipment.orderId,
        action: 'shipment_reopened_for_repack',
        tag: 'sales',
        level: 'WARNING',
        description: `Reopened a ${previousStatus} shipment on order ${orderRef} so it can be rebuilt to what remains`
          + ` — the goods for this shipment are physically picked/packed and must be unpacked in the warehouse`
          + (shipment.trackingNumber
            ? `. It carries tracking number ${shipment.trackingNumber}, which is kept on the draft; cancel the label with the carrier if the rebuild does not use it`
            : ''),
        metadata: {
          shipmentId,
          orderRef,
          previousStatus,
          trackingNumber: shipment.trackingNumber ?? null,
          shippingService: shipment.shippingService ?? null,
          lineCount: shipment.lines.length,
        },
      },
    })
    return {
      success: true as const,
      orderId: shipment.orderId,
      orderRef,
      previousStatus,
      trackingNumber: shipment.trackingNumber ?? null,
      shippingService: shipment.shippingService ?? null,
      lineCount: shipment.lines.length,
    }
  })
}

export async function transitionShipmentStatus(
  client: ShipmentServiceClient,
  input: {
    shipmentId: string
    targetStatus: string
    extra?: { trackingNumber?: string; shippingService?: string }
  },
): Promise<ShipmentTransitionResult> {
  const { shipmentId, targetStatus, extra } = input
  const shipment = await loadShipmentTransitionContext(client, shipmentId)
  if (!shipment) return { success: false, error: 'Shipment not found' }

  const stockSyncProductIds = [...new Set(shipment.lines.map((line) => line.productId))]
  if (shipment.status === targetStatus) {
    return {
      success: true,
      transitioned: false,
      dispatched: false,
      shipment,
      targetStatus,
      previousStatus: shipment.status,
      stockSyncProductIds,
    }
  }

  const transition = validateShipmentStatusTransition(shipment.status, targetStatus)
  if (!transition.success) {
    return { success: false, error: transition.error }
  }

  const data: Record<string, unknown> = { status: targetStatus }
  if (extra?.trackingNumber) data.trackingNumber = extra.trackingNumber
  if (extra?.shippingService) data.shippingService = extra.shippingService

  if (targetStatus === 'SHIPPED') {
    data.shippedAt = new Date()

    const dispatchResult = await runInTransaction(client, async (tx) => {
      await lockSalesOrder(tx, shipment.orderId)
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM "shipments" WHERE id = ${shipmentId} FOR UPDATE`,
      )

      // o3d-e1yb [wdraw]: the LAST line of defence for an approved EU
      // withdrawal, and the only one that is atomic with the irreversible act.
      //
      // Guards further up (the status transition, the WooCommerce completion
      // flow) are all check-then-act across separate transactions: an approval
      // committing after their read and before this dispatch would still
      // consume stock, and the approval retry would then see dispatch evidence
      // and permanently convert the withdrawal into a return. Checking HERE,
      // under the order lock the approval also takes, is what makes them
      // mutually exclusive. It covers the manual shipment paths too.
      const withdrawn = await tx.salesOrder.findUnique({
        where: { id: shipment.orderId },
        select: { withdrawalApprovedAt: true, withdrawalHoldAt: true, status: true },
      })
      if (withdrawn?.withdrawalApprovedAt) {
        throw new Error(
          'This order\u2019s EU withdrawal request was approved; its shipments cannot be dispatched.',
        )
      }
      // o3d-rbyg round 2, Codex finding 5: THE SIXTH FULFILMENT PATH \u2014 a SUBMITTED withdrawal.
      //
      // Only the APPROVED marker was checked here, so every manual dispatch (the shipment screen,
      // the label-purchase flow, any repair that walks a shipment to SHIPPED) went straight through
      // a hold that is still being decided. The WMS paths never hit it because a hold pulls the
      // order back out of the warehouse \u2014 but the manual paths do not go through the warehouse at
      // all, and this transaction is the only place that sees them.
      //
      // A submitted withdrawal means the customer has asked for the goods NOT to go, and the whole
      // point of the hold is that they stay put until a person decides. That is exactly the same
      // reason the approval is refused above; the difference is only that this one is reversible \u2014
      // so it is REFUSED rather than thrown, and the refusal names the remedy: an operator releases
      // the hold on the order (Sales -> the order -> Release withdrawal hold) and dispatches again.
      // Read under the order lock, like the approval, so a hold committing between the caller's
      // read and this dispatch is still honoured rather than raced past.
      if (withdrawn?.withdrawalHoldAt) {
        return {
          success: false as const,
          error: 'This order is under an EU right-of-withdrawal hold, so its shipments cannot be dispatched. '
            + 'Release the withdrawal hold on the order once the request has been decided, then dispatch again.',
        }
      }
      // o3d-4kfh r6 (Codex finding 4): NOT ON A CANCELLED ORDER. Read under the same order lock the
      // cancel takes, so a cancel committing between the caller's read and this dispatch is honoured.
      // Returned rather than thrown so a WMS-driven dispatch gets a clean, actionable failure that
      // names the repair path instead of an exception.
      if (withdrawn && SHIPMENT_TRANSITION_REFUSING_ORDER_STATUSES.has(String(withdrawn.status))) {
        return {
          success: false as const,
          error: terminalOrderTransitionError(String(withdrawn.status)),
        }
      }

      const lockedShipment = await loadShipmentTransitionContext(tx, shipmentId)
      if (!lockedShipment) throw new Error('Shipment not found')
      if (lockedShipment.status !== shipment.status) {
        return {
          success: false as const,
          error: `Shipment status changed from ${shipment.status} to ${lockedShipment.status}. Reload and retry.`,
        }
      }
      if (!hasSameShipmentLines(shipment.lines, lockedShipment.lines)) {
        return {
          success: false as const,
          error: 'Shipment lines changed. Reload and retry.',
        }
      }

      const lockedTransition = validateShipmentStatusTransition(lockedShipment.status, targetStatus)
      if (!lockedTransition.success) throw new Error(lockedTransition.error)

      if (lockedShipment.lines.length === 0) {
        return {
          success: false as const,
          error: 'Shipment has no lines to dispatch',
        }
      }
      const shipmentTotalError = await validateActiveShipmentTotalsWithinOrder(tx, lockedShipment.orderId)
      if (shipmentTotalError) {
        return {
          success: false as const,
          error: shipmentTotalError,
        }
      }

      // o3d-4kfh r4: THE GRAPH-AWARE COMMITTED-COVERAGE CHECK RUNS AT DISPATCH TOO.
      //
      // In r3 this check ran ONLY at the PENDING -> PICKING seam, which is not reachable from the
      // mutation that creates the corruption. A KIT requiring 2xA + 1xB, allocated and PICKING with
      // A=2/B=1, re-composed to 2xA + 2xB by the component editor, crosses no PENDING seam ever
      // again: PICKING -> PACKED skipped the check entirely, and the per-leaf cap in
      // `validateActiveShipmentTotalsWithinOrder` above accepts A=2/B=1 because neither leaf
      // EXCEEDS its (now larger) demand. An incomplete kit shipped, and because
      // `calculateDecimalCoverageByLine` credits whole kits, the census reported nothing.
      //
      // `findUncoveredCommittedShipment` is the only check that expands the fulfilment graph and
      // asks whether the committed components are a COMPLETE, PROPORTIONAL set. Running it here,
      // under the order lock and immediately before the irreversible act, is what makes the
      // proportional half reachable from every route into dispatch — including a WMS-driven one.
      // Scoped to this shipment's own sales lines so an unrelated pre-existing problem elsewhere on
      // the order cannot wedge a correct dispatch.
      const dispatchCoverageError = await validateCommittedShipmentCoverage(
        tx,
        lockedShipment.orderId,
        [...new Set(lockedShipment.lines.map((line) => line.lineId))],
      )
      if (dispatchCoverageError) {
        return {
          success: false as const,
          error: dispatchCoverageError,
        }
      }

      const lockedProductIds = [...new Set(lockedShipment.lines.map((line) => line.productId))]

      await tx.shipment.update({ where: { id: shipmentId }, data })
      const updatedShipment = await loadShipmentTransitionContext(tx, shipmentId)
      if (!updatedShipment) throw new Error('Shipment not found')

      await lockStockLevels(tx, lockedProductIds, [lockedShipment.warehouseId])
      let totalShipmentCogs = toDecimal(0)
      for (const line of lockedShipment.lines) {
        const qty = shipmentBoundaryNumber(line.qty)
        const qtyForDb = String(line.qty ?? 0)
        const idempotencyKey = saleDispatchMovementKey(line.id)
        let movement: { id: string } | null = null
        try {
          // o3d-slrn: the catch below falls through to tx.stockMovement.findUnique on the SAME
          // client, so the failing insert must be savepointed or that recovery hits a 25P02.
          movement = await withSavepoint(tx, () => tx.stockMovement.create({
            data: {
              type: 'SALE_DISPATCH',
              productId: line.productId,
              fromWarehouseId: lockedShipment.warehouseId,
              qty,
              note: `Dispatched for order — shipment from ${lockedShipment.warehouse.code}`,
              referenceType: 'SalesOrder',
              referenceId: lockedShipment.orderId,
              shipmentLineId: line.id,
              idempotencyKey,
            },
            select: { id: true },
          }))
        } catch (error) {
          if (!isStockMovementIdempotencyConflict(error)) throw error
        }
        if (!movement) {
          movement = await tx.stockMovement.findUnique({
            where: { idempotencyKey },
            select: { id: true },
          })
          if (!movement) throw new Error('Dispatched stock movement was not persisted')
          continue
        }

        const updatedStock = await tx.stockLevel.updateMany({
          where: {
            productId: line.productId,
            warehouseId: lockedShipment.warehouseId,
            quantity: { gte: qtyForDb },
            reservedQty: { gte: qtyForDb },
          },
          data: {
            quantity: { decrement: qtyForDb },
            reservedQty: { decrement: qtyForDb },
          },
        })
        if (updatedStock.count !== 1) {
          throw new Error(`Insufficient physical or reserved stock to dispatch ${line.product.sku}`)
        }

        const { consumed, totalCost } = await consumeFifoLayersStrict(
          tx, line.productId, lockedShipment.warehouseId, qty,
        )
        totalShipmentCogs = addMoney(totalShipmentCogs, totalCost)
        await tx.stockMovement.update({
          where: { id: movement.id },
          data: buildStockMovementValueFieldsFromConsumed(consumed, qty),
        })
        if (consumed.length > 0) {
          await tx.cogsEntry.createMany({
            data: consumed.map((entry) => cogsEntryDataFromConsumed(movement.id, entry)),
          })
          // Decorate the dispatch snapshot with its order allocation (one per
          // line+warehouse+product) so the Group B daily batch can relieve the
          // Allocated-Inventory contra for the shipped units (cogs-audit scjz.18).
          // The contra is relieved by QTY against the allocation's pinned layers
          // (scjz.21), so this works even though dispatch consumed FIFO-oldest
          // layers that may differ from the allocation's pinned ones.
          const allocation = await tx.orderAllocation.findUnique({
            where: {
              lineId_warehouseId_productId: {
                lineId: line.lineId,
                warehouseId: lockedShipment.warehouseId,
                productId: line.productId,
              },
            },
            select: { id: true },
          })
          const allocationId = allocation?.id
          await tx.shipmentLine.update({
            where: { id: line.id },
            data: {
              costLayerSnapshot: serializeCostLayerSnapshot(consumed.map((entry) => ({
                costLayerId: entry.costLayerId,
                qty: entry.qty,
                unitCostBase: entry.unitCostBase,
                shipmentLineId: line.id,
                ...(allocationId ? { orderAllocationId: allocationId, source: 'shipment' as const } : {}),
              }))),
            },
          })
        }
      }

      if (totalShipmentCogs.gt(0)) {
        await tx.shipment.update({
          where: { id: shipmentId },
          data: { cogsBatchAmount: roundQuantity(totalShipmentCogs, 2).toNumber() },
        })
      }

      await refreshSalesOrderLineCogs(
        tx,
        lockedShipment.lines.map((line) => line.lineId),
      )

      return {
        success: true as const,
        shipment: updatedShipment,
        stockSyncProductIds: lockedProductIds,
      }
    })

    if (!dispatchResult.success) {
      return dispatchResult
    }

    return {
      success: true,
      transitioned: true,
      dispatched: true,
      shipment: dispatchResult.shipment,
      targetStatus,
      previousStatus: shipment.status,
      stockSyncProductIds: dispatchResult.stockSyncProductIds,
    }
  }

  const transitioned = await runInTransaction(client, async (tx) => {
    // o3d-4kfh r3: THE ORDER LOCK, taken before the shipment row lock so this path acquires locks
    // in the SAME order as the dispatch branch above.
    //
    // PENDING -> PICKING is a COMMITMENT: from that moment the shipment counts against
    // `OrderAllocation.qty` in every consumer (the residual, confirmSalesOrderShipments, the
    // accounting sub-ledger) and can no longer be rewritten or deleted by any path IMS has. It used
    // to lock nothing but the shipment row, so it could commit concurrently with the deallocation,
    // re-allocation or manual edit that removed the very rows meant to back it — and, because a
    // PENDING shipment is deliberately NOT a commitment, those paths were all entitled to ignore it
    // while it was still pending.
    await lockSalesOrder(tx, shipment.orderId)
    // o3d-4kfh r6 (Codex finding 4): a cancelled order's shipments do not advance either. Blocking
    // only the dispatch would leave PENDING -> PICKING -> PACKED free to run on a cancelled sale,
    // which is how a PICKING shipment ends up on a CANCELLED order in the first place — the state
    // the component-graph guard then blocks on with no non-harmful exit.
    const lockedOrder = await tx.salesOrder.findUnique({
      where: { id: shipment.orderId },
      select: { status: true },
    })
    if (lockedOrder && SHIPMENT_TRANSITION_REFUSING_ORDER_STATUSES.has(String(lockedOrder.status))) {
      throw new Error(terminalOrderTransitionError(String(lockedOrder.status)))
    }
    await tx.$queryRaw`SELECT id FROM shipments WHERE id = ${shipmentId} FOR UPDATE`
    const locked = await tx.shipment.findUnique({
      where: { id: shipmentId },
      select: { status: true, orderId: true },
    })
    if (!locked) throw new Error('Shipment not found')
    if (locked.status === targetStatus) return false
    const lockedTransition = validateShipmentStatusTransition(locked.status, targetStatus)
    if (!lockedTransition.success) throw new Error(lockedTransition.error)
    await tx.shipment.update({ where: { id: shipmentId }, data })

    // Verified AFTER the update on purpose: the check reads the non-PENDING set from the
    // database, so updating first is what makes THIS shipment part of the commitment being
    // validated. Scoped to the shipment's own sales lines so an unrelated pre-existing problem
    // elsewhere on the order cannot block the warehouse from starting a pick.
    //
    // o3d-4kfh r4: EVERY transition, not just the PENDING -> PICKING one. Gating on
    // `locked.status === PENDING` meant a shipment that was ALREADY committed could never be
    // re-checked, so a KIT re-composed by the component editor while a shipment sat in PICKING
    // sailed through PICKING -> PACKED and on to dispatch without the proportionality half ever
    // running. The check is idempotent and reads only committed rows, so re-running it on a
    // healthy order is free.
    const lockedLines = await tx.shipmentLine.findMany({
      where: { shipmentId },
      select: { lineId: true },
    })
    const coverageError = await validateCommittedShipmentCoverage(
      tx,
      locked.orderId,
      [...new Set(lockedLines.map((line) => line.lineId))],
    )
    // THROWN, not returned: a `return { success: false }` out of a transaction callback commits
    // whatever it has already written, and this one has already flipped the status.
    if (coverageError) throw new Error(coverageError)
    return true
  })

  return {
    success: true,
    transitioned,
    dispatched: false,
    shipment,
    targetStatus,
    previousStatus: shipment.status,
    stockSyncProductIds,
  }
}

export async function reconcileOrderAfterShipment(
  client: ShipmentServiceClient,
  shipment: { orderId: string },
  extra?: { trackingNumber?: string },
  options?: {
    /**
     * Who owns the "is this order fulfilled?" decision — see `OrderCompletionAuthority`.
     * Defaults to `IMS`, which is the path every in-app dispatch takes; only
     * `applyExternalFulfillmentUpdate` declares `EXTERNAL`.
     */
    completionAuthority?: OrderCompletionAuthority
  },
): Promise<ShipmentReconciliationResult> {
  const completionAuthority: OrderCompletionAuthority = options?.completionAuthority ?? 'IMS'
  const allShipments = await client.shipment.findMany({
    where: { orderId: shipment.orderId },
    select: { id: true, status: true },
  })
  const allShipped = allShipments.every((row) => row.status === 'SHIPPED')
  if (!allShipped) {
    return { shouldGenerateInvoice: false, orderId: shipment.orderId }
  }

  const shippedShipments = await client.shipment.findMany({
    where: { orderId: shipment.orderId },
    select: { trackingNumber: true },
  })
  const trackingNumbers = shippedShipments
    .map((row) => row.trackingNumber)
    .filter(Boolean)
    .join(', ')

  const shortfall = await runInTransaction(client, async (tx) => {
    await lockSalesOrder(tx, shipment.orderId)
    const currentOrder = await tx.salesOrder.findUnique({
      where: { id: shipment.orderId },
      select: { status: true },
    })
    if (!currentOrder) return null
    if (['SHIPPED', 'COMPLETED', 'DELIVERED', 'CANCELLED'].includes(currentOrder.status)) return null

    // o3d-0i5y: DO NOT let "all known shipments shipped" silently mean "order complete".
    //
    // Read under the order lock, alongside the status, so a shipment or refund committing between a
    // caller's earlier read and this promotion is honoured — the same reason the status is re-read here.
    //
    // The order is deliberately left in whatever pre-shipment status it already holds (ALLOCATED /
    // PICKING / PACKING) rather than moved to a new PARTIALLY_SHIPPED status or marked with a flag:
    //
    //  - those statuses already mean "in fulfilment, not out of the door", which is the truth, and they
    //    are what the fulfilment queues already select on;
    //  - a denormalised flag would be a second copy of a fact that is fully derivable from the shipment
    //    and refund rows, so it could go stale against them. `findOrderShipmentShortfall` is derived,
    //    so it cannot;
    //  - and the schema deliberately RETIRED composite lifecycle statuses (see the note on
    //    SalesOrderStatus where PARTIALLY_REFUNDED was replaced by the orthogonal refundStatus).
    //    Reintroducing one would reopen that, and it would have to be threaded through every status
    //    map, badge, filter, storefront mapping and state-machine table in the codebase.
    //
    // Closing an order short therefore remains possible, but only as an EXPLICIT operator decision:
    // ALLOCATED/PICKING/PACKING -> SHIPPED are all legal manual transitions via updateSalesOrderStatus
    // (permission `sales.process`). What is no longer possible is the system deciding it silently.
    //
    // NOTE the practical consequence, because it is the reason this is reported rather than merely
    // skipped: nothing re-allocates such an order on its own. `selectOrdersNeedingAllocation`'s callers
    // both pre-exclude orders that hold shipments (the sweep excludes ANY shipment, the backorder
    // allocator any committed one), precisely because rebuilding allocations under a live ShipmentLine
    // is unsafe. So a shipped-short order waits for a human, and the caller logs a WARNING saying so.
    //
    // ...but only where IMS is the one deciding. Under `EXTERNAL` authority the storefront/WMS has
    // already completed this order by its own reckoning, and these shipment rows are a projection of
    // that decision rather than the evidence for it, so re-deriving completion from them would
    // second-guess the owner and report a correctly-fulfilled order as short. See
    // `OrderCompletionAuthority`.
    const outstanding = completionAuthority === 'IMS'
      ? await findOrderShipmentShortfall(tx, shipment.orderId)
      : null
    if (outstanding) return outstanding

    const transition = validateSalesOrderStatusTransition(currentOrder.status, 'SHIPPED')
    if (!transition.success) throw new Error(transition.error)
    await tx.salesOrder.update({
      where: { id: shipment.orderId },
      data: {
        status: 'SHIPPED',
        shippedAt: new Date(),
        trackingNumber: trackingNumbers || (extra?.trackingNumber ?? null),
      },
    })
    return null
  })

  const trigger = await client.setting.findUnique({ where: { key: 'invoice_trigger' } })
  return {
    // An order held short is not shipped, so the on_shipped invoice trigger must not fire for it:
    // invoicing it would bill the customer for units that have not left and are still owed.
    shouldGenerateInvoice: !shortfall && trigger?.value === 'on_shipped',
    orderId: shipment.orderId,
    ...(shortfall ? { shortfall } : {}),
  }
}
