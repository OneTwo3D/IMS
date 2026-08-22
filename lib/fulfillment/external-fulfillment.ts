import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { roundQuantity, toDecimal } from '@/lib/domain/math/decimal'
import { isStockTrackedProductType } from '@/lib/domain/inventory/backorder-policy'
import { expandFulfillmentRequirementsDecimal, loadFulfillmentProductGraph } from '@/lib/products/kit-fulfillment'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import type { ShoppingConnectorId } from '@/lib/connectors/shopping-registry'
import type { WmsConnectorId } from '@/lib/connectors/wms/types'
import type { SalesOrderStatus } from '@/lib/domain/workflows/status-types'
import { isShoppingConnectorId } from '@/lib/fulfillment/shopping-order-lookup'
import { isWmsConnectorId, resolveWmsOrderLookupConnector } from '@/lib/connectors/wms/order-lookup'

// A fulfillment update originates from either a storefront (shopping) connector
// that owns the order's ShoppingOrderLink, or a WMS/3PL connector that
// references a storefront order. Derived from the connector registries so a new
// connector is included without editing this core flow.
export type ExternalFulfillmentSource = ShoppingConnectorId | WmsConnectorId
export type ExternalShipmentStatus = 'PENDING' | 'PICKING' | 'PACKED' | 'SHIPPED'

export type ExternalFulfillmentLookup =
  | { orderId: string }
  | { externalOrderId: number }
  | { externalOrderNumber: string }
  | { orderNumber: string }

export type ExternalFulfillmentUpdate = {
  source: ExternalFulfillmentSource
  lookup: ExternalFulfillmentLookup
  targetShipmentStatus: ExternalShipmentStatus
  tracking?: Array<{ trackingNumber: string; shippingService?: string | null }>
}

type ResolvedOrder = {
  id: string
  orderNumber: string | null
  externalOrderNumber: string | null
  status: string
}

async function resolveShoppingConnectorForSource(
  source: ExternalFulfillmentSource,
): Promise<ShoppingConnectorId | null> {
  if (isShoppingConnectorId(source)) return source
  if (isWmsConnectorId(source)) return resolveWmsOrderLookupConnector(source)
  return null
}

export async function resolveOrderForExternalFulfillment(
  source: ExternalFulfillmentSource,
  lookup: ExternalFulfillmentLookup,
): Promise<ResolvedOrder | null> {
  if ('orderId' in lookup) {
    return db.salesOrder.findUnique({
      where: { id: lookup.orderId },
      select: { id: true, orderNumber: true, externalOrderNumber: true, status: true },
    })
  }

  if ('externalOrderId' in lookup) {
    if (isWmsConnectorId(source)) {
      // WMS order IDs are the WMS's own internal identifiers, not the storefront
      // order IDs stored on shopping_order_links, so this lookup form is N/A.
      return null
    }

    const connector = await resolveShoppingConnectorForSource(source)
    if (!connector) return null

    const link = await db.shoppingOrderLink.findUnique({
      where: {
        connector_externalOrderId: {
          connector,
          externalOrderId: String(lookup.externalOrderId),
        },
      },
      select: {
        order: {
          select: { id: true, orderNumber: true, externalOrderNumber: true, status: true },
        },
      },
    })
    return link?.order ?? null
  }

  if ('externalOrderNumber' in lookup) {
    const connector = await resolveShoppingConnectorForSource(source)
    if (!connector) return null

    const link = await db.shoppingOrderLink.findFirst({
      where: {
        connector,
        externalOrderNumber: lookup.externalOrderNumber,
      },
      select: {
        order: {
          select: { id: true, orderNumber: true, externalOrderNumber: true, status: true },
        },
      },
    })
    return link?.order ?? null
  }

  return db.salesOrder.findFirst({
    where: { orderNumber: lookup.orderNumber },
    select: { id: true, orderNumber: true, externalOrderNumber: true, status: true },
  })
}

function statusesToApply(
  currentStatus: ExternalShipmentStatus,
  targetStatus: ExternalShipmentStatus,
): ExternalShipmentStatus[] {
  const flow: ExternalShipmentStatus[] = ['PENDING', 'PICKING', 'PACKED', 'SHIPPED']
  const start = flow.indexOf(currentStatus)
  const end = flow.indexOf(targetStatus)
  if (start === -1 || end === -1 || end <= start) return []
  return flow.slice(start + 1, end + 1)
}

/**
 * Whether to push the storefront status forward (→ "completed" for WooCommerce) after a
 * fulfilment update. Only for a WMS-sourced dispatch that just brought the order to
 * SHIPPED — a storefront-sourced update already has the storefront as the source of truth
 * (pushing back would echo), and a partial dispatch leaves the order pre-SHIPPED. This is
 * what makes the storefront fire its customer despatch email (e.g. AST on →completed).
 *
 * Restricted to SHIPPED (not COMPLETED/DELIVERED): those later states have no WC status
 * mapping (IMS_TO_WC) so a push would silently no-op — and a SHIPPED order has already
 * driven the WC completion, so there's nothing more to push.
 */
export function shouldPushStorefrontCompletion(
  source: ExternalFulfillmentSource,
  targetShipmentStatus: ExternalShipmentStatus,
  orderStatus: string,
): boolean {
  return targetShipmentStatus === 'SHIPPED'
    && isWmsConnectorId(source)
    && orderStatus === 'SHIPPED'
}

export type ExternalFulfillmentShortfall = {
  lineId: string
  productId: string
  label: string
  /** Ordered minus refunded, in leaf (component) units. */
  demandQty: string
  /** What the order's shipment lines actually cover, in the same units. */
  shipmentQty: string
  outstandingQty: string
}

/**
 * Quantity ULP tolerance, matching the Decimal(12,4) boundary shipment rows persist at
 * (o3d-odu). Rounded AFTER the whole subtraction, never per term, so half-ulp errors on a
 * fractional kit component cannot compound into a phantom shortfall.
 */
const EXTERNAL_FULFILLMENT_QTY_EPSILON = new Prisma.Decimal('0.000001')

/**
 * Does the order's SHIPMENT plan actually cover what was ordered? (o3d-okbd)
 *
 * On the external path this is not the same question the operator flow asks. An operator
 * shipping short is a real workflow — you send what you have and the rest stays outstanding.
 * A 3PL dispatch is a REPORT that goods have already gone. If IMS only ever allocated 4 of
 * 10 units, marking the order shipped books four units of stock movement, four units of COGS
 * and a full deferred-revenue true-up for a dispatch of ten. The remaining six sit on hand in
 * IMS forever, and the discrepancy surfaces at a stocktake months later with no trail back.
 *
 * `applyExternalFulfillmentUpdate` could reach that state two ways, and neither was checked:
 * `autoAllocateOrder` is only run (and only refused) when the order has NO allocations at
 * all, so a PARTIAL auto-allocation passed, and an order that already held partial
 * allocations skipped the allocator — and therefore the refusal — entirely.
 *
 * BASIS. Ordered minus refunded, in LEAF (component) units keyed (orderLineId, productId) —
 * the same basis `validateActiveShipmentTotalsWithinOrder` caps dispatches against, so "may
 * this ship?" and "has everything shipped?" cannot disagree.
 *
 * A FULL refund is NOT a short-circuit here, and that is the one place this deliberately parts
 * company with `selectOrdersNeedingAllocation` and `allocateSalesOrder`. Those ask a
 * PROSPECTIVE question — what still needs allocating or shipping — and for that a fully
 * refunded order is dead: zero demand is right, and skipping it is also what stops the o3d-jby
 * rewrite loop. This asks a RETROSPECTIVE one. The 3PL has already dispatched; a refund is a
 * monetary event and cannot un-ship goods that left the warehouse.
 *
 * `refundStatus` reaches FULL on a monetary-only refund — store credit, a shipping-only
 * refund, an unlinked external refund — with no quantity returned on any line. Treating that
 * as zero demand skipped the coverage check on precisely the orders that DID dispatch, which
 * is the under-booking this function exists to catch.
 *
 * A refund that genuinely cancels goods — one whose line quantities describe goods that never
 * moved — still nets to zero, one leaf at a time, through the per-line subtraction below: that
 * is what quantity-bearing refund lines are for. A refund that returned no quantities leaves
 * demand standing, and so do the units whose own record says the goods already left — a restock
 * measured by its RETURN_INBOUND movements, or a chargeback (see `refundEvidencesGoodsLeft` and
 * `refundGoodsLeftIsUnmeasured`, which are the same retrospective reasoning applied per PRODUCT
 * rather than per refund). Either way the shipment lines have to cover the demand or the
 * dispatch is refused. Nothing loops on that refusal — this gate runs once, on an inbound
 * dispatch, not on a rotating selector.
 *
 * WHICH LINES COUNT. Only stock-tracked lines with a product. A description-only line has no
 * product to ship (the same exclusion `validateActiveShipmentTotalsWithinOrder` makes), and
 * NON_INVENTORY / VARIABLE lines can never receive shipment coverage at all — including
 * either would refuse every external dispatch, forever, on any order carrying one.
 */
/**
 * Does this refund itself say the goods have already left the warehouse? (o3d-okbd round 3)
 *
 * Round 2 stopped a FULL refund short-circuiting the coverage check, on the ground that a
 * refund is a monetary event and cannot un-ship goods, and that a refund which genuinely
 * cancels goods nets to zero one leaf at a time through the per-line subtraction. The second
 * half of that was only true for refunds that cancel goods which never moved. It was not
 * carried to the PARTIAL, quantity-bearing refunds that RETURN goods, and those are the same
 * retrospective question the full case was:
 *
 *   Order 10. IMS only ever allocated 6, so shipment A covers 6 and dispatches. The customer
 *   sends those 6 back and the refund restocks them. The 3PL then reports the remaining 4
 *   dispatched, and IMS builds shipment B with nothing allocated to put on it. Netting the
 *   refund gives demand 10 - 6 = 4 against coverage 6, no shortfall, and the order is promoted
 *   SHIPPED having booked four units of stock movement it never made.
 *
 * A restock is POSITIVE evidence in the other direction. Goods can only be received back if
 * they went out: `buildRefundFallbackReturnRows` refuses to restock a line with no SHIPPED
 * shipment behind it, and the return books an INBOUND movement for those units. Netting them
 * out of demand lets the matching OUTBOUND be skipped, so stock rises by the returned quantity
 * with nothing to account for it — the mirror image of the under-booking this check exists to
 * catch, and it lands on the same orders.
 *
 * A chargeback is the same fact stated the other way round: scjz.70 suppresses restock and
 * COGS reversal precisely because the customer KEEPS the goods. They left too.
 *
 * What still nets, and must: a quantity-bearing refund with neither mark. That is the ordinary
 * cancellation of a line that never shipped — no return warehouse because there is nothing to
 * receive back — and it is what round 2's "nets to zero, one leaf at a time" was describing.
 *
 * ROUND 5: A REFUND-LEVEL MARK CANNOT ANSWER A LINE-LEVEL QUESTION.
 *
 * `returnWarehouseId` is a column on the REFUND, and one refund routinely mixes goods that went out
 * with goods that never did: the customer returns the two units that shipped and cancels the three
 * that were still on back-order, on one WooCommerce "Refund" press. Reading the mark per refund
 * classified all five the same way, and in this direction the error is not a missed under-booking
 * but a PERMANENT REFUSAL — the three cancelled units stay in demand, no shipment line can ever
 * cover them, and every redelivery of the 3PL dispatch is refused for goods nobody ever shipped.
 *
 * `buildRefundFallbackReturnRows` already draws the line this needs, and it draws it PER PRODUCT: it
 * refuses to restock a line with no SHIPPED shipment behind it, caps the rest at what was dispatched
 * less what earlier refunds took back, and `applyReturnInboundStockTx` books a RETURN_INBOUND
 * movement for exactly the units that survived. Those movements are the record of WHICH GOODS CAME
 * BACK, at the granularity the question is asked — so they, not the column, are what a restocking
 * refund is measured by here. Units of such a refund BEYOND its return movements were never
 * received back, so they are the ordinary cancellation above and net as one.
 *
 * TWO CASES DELIBERATELY STAY REFUND-LEVEL, because for them the mark IS the line-level fact:
 *
 *   • A CHARGEBACK. scjz.70 suppresses restock precisely because the customer keeps the goods, so
 *     there is no return movement to measure and none is expected. The whole refunded quantity is
 *     goods that left.
 *   • A RESTOCK WHOSE RETURN IS STILL OWED (`accountingRetryRequired`). The movement is written in a
 *     later transaction when accounting staging failed first (refund-service.ts), so an empty
 *     measurement there means "not yet", not "nothing came back". Treating the mark as covering the
 *     whole refund holds demand up and refuses — which is the recoverable direction, and clears
 *     itself when the retry writes the movements.
 */
type RefundGoodsLeftMarks = {
  returnWarehouseId: string | null
  chargeback: boolean
  accountingRetryRequired: boolean
}

/** Does this refund's OWN record say goods left, before any per-product measurement? */
function refundEvidencesGoodsLeft(refund: RefundGoodsLeftMarks | null): boolean {
  if (!refund) return false
  return refund.returnWarehouseId !== null || refund.chargeback
}

/**
 * Is the mark the whole answer for this refund, or only the beginning of one?
 *
 * True means every refunded unit is goods that left (chargeback, or a restock whose movements have
 * not been written yet). False means the units that left are exactly the ones with a RETURN_INBOUND
 * movement behind them, and the remainder is a cancellation.
 */
function refundGoodsLeftIsUnmeasured(refund: RefundGoodsLeftMarks): boolean {
  return refund.chargeback || refund.accountingRetryRequired
}

export async function findExternalFulfillmentShortfall(
  orderId: string,
): Promise<ExternalFulfillmentShortfall[]> {
  const [orderLines, shipmentLines, refundLines] = await Promise.all([
    db.salesOrderLine.findMany({
      where: { orderId },
      select: {
        id: true,
        productId: true,
        qty: true,
        sku: true,
        description: true,
        product: { select: { type: true } },
      },
    }),
    // Every shipment on the order counts, whatever stage it is at: this update is about to
    // drive all of them to SHIPPED, and already-SHIPPED rows are coverage that was banked on
    // an earlier dispatch. Restricting to one status would report a second partial dispatch
    // as short by the amount the first one already sent.
    db.shipmentLine.findMany({
      where: { shipment: { orderId } },
      select: { lineId: true, productId: true, qty: true },
    }),
    db.salesOrderRefundLine.findMany({
      where: { refund: { orderId } },
      // Round 5: a RETURN_INBOUND movement names a product, not a refund LINE, so when one refund
      // refunds the same product on two order lines they share one measured budget and the order it
      // is drawn down in decides which line is credited with the return. A stable order at least
      // makes that decision REPRODUCIBLE — the total netted quantity is the same either way, and
      // the only way to get it wrong is to hold demand up on the wrong line, which refuses a
      // dispatch (recoverable) rather than under-booking one (not).
      orderBy: { id: 'asc' },
      select: {
        salesOrderLineId: true,
        productId: true,
        qty: true,
        // Which refund this line belongs to, so its return movements can be found (round 5).
        refundId: true,
        // What the refund itself says about where the goods are (o3d-okbd round 3). Set by the
        // refund writer at creation, never by a caller, so this is a lookup rather than a
        // reconstruction — the same reason `totalsBasis` is persisted.
        refund: {
          select: {
            returnWarehouseId: true,
            chargeback: true,
            // Round 5: true while the return movements are still owed to a later transaction.
            accountingRetryRequired: true,
          },
        },
      },
    }),
  ])

  // WHICH GOODS ACTUALLY CAME BACK, per refund and per product (round 5). Only asked for refunds
  // that claim a restock AND have finished writing it — a chargeback books no return movement by
  // design, and a refund still owing one would read as zero and be mistaken for a cancellation.
  const measurableRestockRefundIds = [...new Set(
    refundLines
      .filter((line) => line.refund
        && !refundGoodsLeftIsUnmeasured(line.refund)
        && refundEvidencesGoodsLeft(line.refund))
      .map((line) => line.refundId),
  )]
  const returnedMovements = measurableRestockRefundIds.length > 0
    ? await db.stockMovement.findMany({
      where: {
        type: 'RETURN_INBOUND',
        referenceType: 'SalesOrderRefund',
        referenceId: { in: measurableRestockRefundIds },
      },
      select: { referenceId: true, productId: true, qty: true },
    })
    : []

  const shippableLines = orderLines.filter(
    (line): line is typeof line & { productId: string } =>
      !!line.productId && isStockTrackedProductType(line.product?.type),
  )
  if (shippableLines.length === 0) return []

  const productIds = [...new Set([
    ...shippableLines.map((line) => line.productId),
    ...refundLines.map((line) => line.productId).filter((id): id is string => !!id),
  ])]
  const graph = await loadFulfillmentProductGraph(db, productIds)

  const key = (lineId: string, productId: string) => `${lineId}|${productId}`

  const demandByLeaf = new Map<string, Prisma.Decimal>()
  const labelByLine = new Map<string, string>()
  for (const line of shippableLines) {
    labelByLine.set(line.id, line.sku ?? line.description ?? line.id)
    for (const [componentId, componentQty] of expandFulfillmentRequirementsDecimal(line.productId, toDecimal(line.qty), graph)) {
      const leafKey = key(line.id, componentId)
      demandByLeaf.set(leafKey, (demandByLeaf.get(leafKey) ?? new Prisma.Decimal(0)).add(componentQty))
    }
  }

  // Units a MEASURED restocking refund is still entitled to claim as goods that left, keyed by
  // refund and product and drawn down as its lines are read. Movements are aggregated per
  // (refund, product) — `applyReturnInboundStockTx` writes them per refund LINE but the row itself
  // carries no line id — so several refund lines for one product share this budget, which is right:
  // between them they can only have returned what came back.
  const returnedBudget = new Map<string, Prisma.Decimal>()
  for (const movement of returnedMovements) {
    const budgetKey = key(movement.referenceId ?? '', movement.productId)
    returnedBudget.set(budgetKey, (returnedBudget.get(budgetKey) ?? new Prisma.Decimal(0)).add(toDecimal(movement.qty)))
  }

  for (const refundLine of refundLines) {
    // An unmatched external refund (no order line, or no product) cannot be attributed to a
    // leaf. Netting it against an arbitrary line would understate demand and hide a real
    // shortfall, so it nets nothing.
    if (!refundLine.salesOrderLineId || !refundLine.productId) continue
    const marked = refundEvidencesGoodsLeft(refundLine.refund)
    // A chargeback, or a restock whose movements are still owed: the mark stands for the whole
    // refund, so none of it nets (round 3's rule, kept where it is still the best evidence).
    if (marked && refundLine.refund && refundGoodsLeftIsUnmeasured(refundLine.refund)) continue
    for (const [componentId, componentQty] of expandFulfillmentRequirementsDecimal(refundLine.productId, toDecimal(refundLine.qty), graph)) {
      const leafKey = key(refundLine.salesOrderLineId, componentId)
      const current = demandByLeaf.get(leafKey)
      if (current === undefined) continue
      let netQty = componentQty
      if (marked) {
        // Only the units with a return movement behind them are goods that left. The rest of this
        // line was cancelled before it ever shipped, and still nets — that is the whole of round 5.
        const budgetKey = key(refundLine.refundId, componentId)
        const budget = returnedBudget.get(budgetKey) ?? new Prisma.Decimal(0)
        const cameBack = componentQty.gt(0) && budget.gt(0)
          ? (budget.gte(componentQty) ? componentQty : budget)
          : new Prisma.Decimal(0)
        returnedBudget.set(budgetKey, budget.sub(cameBack))
        netQty = componentQty.sub(cameBack)
      }
      demandByLeaf.set(leafKey, current.sub(netQty))
    }
  }

  const coverageByLeaf = new Map<string, Prisma.Decimal>()
  for (const shipmentLine of shipmentLines) {
    const leafKey = key(shipmentLine.lineId, shipmentLine.productId)
    coverageByLeaf.set(leafKey, (coverageByLeaf.get(leafKey) ?? new Prisma.Decimal(0)).add(toDecimal(shipmentLine.qty)))
  }

  const shortfalls: ExternalFulfillmentShortfall[] = []
  for (const [leafKey, rawDemand] of demandByLeaf) {
    const [lineId, productId] = leafKey.split('|')
    // Over-refunding a line is zero demand, never negative demand.
    let demand = roundQuantity(rawDemand, 4)
    if (demand.lt(0)) demand = new Prisma.Decimal(0)
    const covered = coverageByLeaf.get(leafKey) ?? new Prisma.Decimal(0)
    const outstanding = roundQuantity(demand.sub(covered), 4)
    if (outstanding.gt(EXTERNAL_FULFILLMENT_QTY_EPSILON)) {
      shortfalls.push({
        lineId,
        productId,
        label: labelByLine.get(lineId) ?? lineId,
        demandQty: demand.toString(),
        shipmentQty: covered.toString(),
        outstandingQty: outstanding.toString(),
      })
    }
  }

  return shortfalls
}

export function describeExternalFulfillmentShortfall(
  shortfalls: ExternalFulfillmentShortfall[],
): string {
  const detail = shortfalls
    .map((entry) => `${entry.label} (${entry.outstandingQty} of ${entry.demandQty} uncovered)`)
    .join(', ')
  return 'External fulfillment would mark this order shipped without covering everything ordered: '
    + `${detail}. The goods have already left the warehouse, so recording the smaller quantity would `
    + 'under-book stock movement and COGS permanently. Allocate and add the missing units to a '
    + 'shipment, or close the order short deliberately.'
}

export async function applyExternalFulfillmentUpdate(
  update: ExternalFulfillmentUpdate,
): Promise<{ success: boolean; error?: string }> {
  const order = await resolveOrderForExternalFulfillment(update.source, update.lookup)
  if (!order) {
    return { success: false, error: 'Order not found for external fulfillment update' }
  }

  const { autoAllocateOrder, confirmAllocations, updateShipmentStatus } = await import('@/app/actions/allocation')

  const allocationCount = await db.orderAllocation.count({ where: { orderId: order.id } })
  if (allocationCount === 0) {
    const result = await autoAllocateOrder(order.id, { internalBypassToken: INTERNAL_ACTION_BYPASS })
    if (!result.success) {
      return { success: false, error: result.error ?? 'Auto-allocation failed' }
    }
    if ((result.allocationCount ?? 0) === 0 && (result.unallocatedQty ?? 0) > 0) {
      return {
        success: false,
        error: `External fulfillment requires physical stock — order has ${result.unallocatedQty} unit(s) on backorder`,
      }
    }
  }

  const shipmentCount = await db.shipment.count({ where: { orderId: order.id } })
  if (shipmentCount === 0) {
    const result = await confirmAllocations(order.id, { internalBypassToken: INTERNAL_ACTION_BYPASS })
    if (!result.success) {
      return { success: false, error: result.error ?? 'Shipment creation failed' }
    }
  }

  // o3d-okbd: the shipments now exist (built above, or already present). Before driving them
  // to SHIPPED — the irreversible step that books stock movement and COGS and promotes the
  // order — check that they actually cover what was ordered. Refusing is the right answer
  // here rather than shipping short: the 3PL has already sent the goods, so there is no
  // outstanding remainder for a later shipment to carry, and a refused external update is
  // visible on the WMS exception path whereas a silent short promotion is visible nowhere.
  //
  // Only for SHIPPED. A PICKING/PACKED update is a progress report on an unfinished
  // dispatch; withholding it would just stall the order short of the check that matters.
  if (update.targetShipmentStatus === 'SHIPPED') {
    const shortfalls = await findExternalFulfillmentShortfall(order.id)
    if (shortfalls.length > 0) {
      const error = describeExternalFulfillmentShortfall(shortfalls)
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: order.id,
        action: 'external_fulfillment_short',
        tag: 'sync',
        level: 'WARNING',
        description: `${update.source} dispatch for order ${order.externalOrderNumber ?? order.orderNumber ?? order.id} `
          + 'was refused: the IMS shipment lines do not cover everything ordered, so accepting it '
          + 'would book less stock movement than left the warehouse',
        metadata: { source: update.source, shortfalls },
        resolveUser: false,
      })
      return { success: false, error }
    }
  }

  const shipments = await db.shipment.findMany({
    where: { orderId: order.id, status: { not: update.targetShipmentStatus } },
    select: { id: true, status: true },
    orderBy: { createdAt: 'asc' },
  })

  for (let index = 0; index < shipments.length; index++) {
    const shipment = shipments[index]
    const transitions = statusesToApply(shipment.status as ExternalShipmentStatus, update.targetShipmentStatus)
    // Use matched tracking entry for this shipment; only fall back to the
    // first entry when the array has exactly one element (single tracking
    // number for all shipments). When there are multiple tracking entries
    // but fewer than shipments, leave unmatched shipments without tracking
    // rather than silently reusing an arbitrary entry.
    const tracking = update.tracking?.[index]
      ?? (update.tracking?.length === 1 ? update.tracking[0] : undefined)

    for (const target of transitions) {
      const result = await updateShipmentStatus(
        shipment.id,
        target,
        target === 'SHIPPED' && tracking
          ? {
              trackingNumber: tracking.trackingNumber,
              shippingService: tracking.shippingService ?? undefined,
            }
          : undefined,
        {
          internalBypassToken: INTERNAL_ACTION_BYPASS,
          // o3d-0i5y r2: THE EXTERNAL SYSTEM OWNS COMPLETION on this path, so IMS must not
          // re-derive it. Everything that reaches here has already decided the order is fulfilled
          // and is reporting it: the WooCommerce completion flow only runs on a WC order that went
          // to "completed" ("WooCommerce is treated as the dispatch authority for external
          // storefront orders"), and the WMS dispatch sweep only applies a dispatch once the WMS
          // says the order — or, for a split order, every one of its parts — has despatched
          // (`reconcileSplitOrder`).
          //
          // The shipment rows this function drives to SHIPPED are a projection of that decision,
          // not the evidence for it: they were auto-allocated and confirmed a few lines above from
          // whatever IMS stock happened to be on hand, so they can under-cover the ordered qty
          // while the 3PL shipped the lot. Letting the IMS shortfall check run over them would
          // hold the order out of SHIPPED, suppress the storefront completion push below (and the
          // customer despatch email it exists to fire), and raise a `shipped_short` WARNING on
          // every external dispatch. See `OrderCompletionAuthority`.
          completionAuthority: 'EXTERNAL',
        },
      )

      if (!result.success) {
        await logActivity({
          entityType: 'SALES_ORDER',
          entityId: order.id,
          action: 'external_fulfillment_failed',
          tag: 'sync',
          level: 'WARNING',
          description: `${update.source} fulfillment update failed at ${target} for order ${order.externalOrderNumber ?? order.orderNumber ?? order.id}`,
          metadata: { source: update.source, shipmentId: shipment.id, target, error: result.error },
          resolveUser: false,
        })
        return { success: false, error: result.error ?? `Failed to update shipment to ${target}` }
      }
    }
  }

  await logActivity({
    entityType: 'SALES_ORDER',
    entityId: order.id,
    action: 'external_fulfillment_applied',
    tag: 'sync',
    level: 'INFO',
    description: `Applied ${update.source} fulfillment update to ${update.targetShipmentStatus} for order ${order.externalOrderNumber ?? order.orderNumber ?? order.id}`,
    metadata: { source: update.source, targetShipmentStatus: update.targetShipmentStatus, shipmentsProcessed: shipments.length },
    resolveUser: false,
  })

  // When a WMS dispatch has fully shipped the order, push the storefront status
  // forward (SHIPPED → WooCommerce "completed") so the storefront fires its customer
  // despatch email — e.g. Advanced Shipment Tracking emails the tracking on the
  // →completed transition, not on a raw tracking-meta write. Writing the tracking meta
  // alone (above) leaves the WC order in its prior status and the customer un-emailed.
  // Gated to WMS sources: a storefront-sourced fulfilment already has the storefront as
  // the source of truth, so pushing status back would just echo.
  if (update.targetShipmentStatus === 'SHIPPED' && isWmsConnectorId(update.source)) {
    const current = await db.salesOrder.findUnique({ where: { id: order.id }, select: { status: true } })
    if (current && shouldPushStorefrontCompletion(update.source, update.targetShipmentStatus, current.status)) {
      // Best-effort: the shipment + tracking are already applied; a failed status push
      // must not fail the dispatch. But log it — a missed completion = a missed customer
      // despatch email, which would otherwise be invisible.
      const logCompletionPushFailure = (detail: string) =>
        logActivity({
          entityType: 'SALES_ORDER',
          entityId: order.id,
          action: 'wc_completion_push_failed',
          tag: 'sync',
          level: 'WARNING',
          description: `Storefront completion push failed for despatched order ${order.externalOrderNumber ?? order.orderNumber ?? order.id}: ${detail} — customer despatch email may not have fired`,
          metadata: { source: update.source },
          resolveUser: false,
        }).catch(() => {})
      try {
        const { pushSalesOrderStatus } = await import('@/lib/shopping')
        const pushResult = await pushSalesOrderStatus(order.id, current.status as SalesOrderStatus)
        if (!pushResult.success) await logCompletionPushFailure(pushResult.error ?? 'unknown error')
      } catch (error) {
        await logCompletionPushFailure(error instanceof Error ? error.message : 'unexpected error')
      }
    }
  }

  return { success: true }
}
