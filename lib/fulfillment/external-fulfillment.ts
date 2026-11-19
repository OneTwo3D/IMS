import { ORDER_STATUSES_NOT_READY_TO_DISPATCH } from '@/lib/domain/workflows/sales-order-state'
import type { ShipmentServiceClient } from '@/lib/domain/sales/shipment-service'
import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity, logActivityPersisted } from '@/lib/activity-log'
import { roundQuantity, toDecimal } from '@/lib/domain/math/decimal'
import { isStockTrackedProductType } from '@/lib/domain/inventory/backorder-policy'
import { loadFulfillmentProductGraph } from '@/lib/products/kit-fulfillment'
import {
  lineFulfillmentRequirementQuantities,
  refundLineResolvableLine,
} from '@/lib/products/fulfillment-requirement-snapshot'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import type { ShoppingConnectorId } from '@/lib/connectors/shopping-registry'
import type { WmsConnectorId } from '@/lib/connectors/wms/types'
import { isShoppingConnectorId, shoppingOrderLookupSkipReason } from '@/lib/fulfillment/shopping-order-lookup'
import { isWmsConnectorId, resolveWmsOrderLookupConnector } from '@/lib/connectors/wms/order-lookup'
import { isMixedWarehousePushEnabled } from '@/lib/domain/wms/mixed-scope-flag'
import { loadMixedScopeForOrder } from '@/lib/domain/wms/mixed-scope-loader'
import { sameScopeLines, warehouseShipmentsMatchAllocations } from '@/lib/domain/wms/scoped-despatch-checks'

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
  /**
   * The storefront order is ALREADY completed (a fresh read-only look at it, at verification time, showed it `completed` after
   * the latest despatch). THE CONTRACT: this path writes NO ORDER-LEVEL storefront data - no `order.complete` job, no tracking,
   * no order note, no status - because each would be a write to an order that is already complete. Its ONLY storefront effect
   * is IMS's ordinary stock-level sync for the stock the shipment consumed: after cutover IMS is the stock master and that push
   * sets an absolute level, so it duplicates nothing the earlier writer did (owner ruling). Set only when EVERY despatched part
   * was verified; a mixed order completes normally.
   */
  storefrontAlreadyCompleted?: boolean
  /**
   * With `storefrontAlreadyCompleted`: re-checked inside the transaction that ships the order, under the order lock. A non-null answer
   * refuses the dispatch (what the verification proved no longer holds), so nothing is shipped on a stale proof.
   */
  shipFence?: (tx: ShipmentServiceClient) => Promise<string | null>
}

/**
 * WHY THE FAILURE HAS A SHAPE AND NOT JUST A STRING (o3d-xnwu).
 *
 * `applyExternalFulfillmentUpdate` refuses for two quite different kinds of reason, and a caller
 * that only sees `{ success: false, error }` cannot tell them apart:
 *
 *   - A BUSINESS REFUSAL. The order, as IMS holds it, may not be promoted to SHIPPED — the
 *     shipment lines under-cover ordered-net-of-refunds demand (o3d-okbd), or the order is on
 *     backorder so there is no physical stock to consume. Nothing about the request is wrong and
 *     nothing failed; the answer is "no".
 *   - A FAILURE. Auto-allocation, shipment creation or a shipment status transition returned an
 *     error, or the order could not be resolved at all.
 *
 * The distinction matters at the WooCommerce webhook boundary, where `permanent` decides between
 * acknowledging the delivery (o3d-bx9) and answering 5xx so it is redelivered (o3d-i0y).
 */
export type ExternalFulfillmentRefusal =
  | 'order_not_found'
  | 'auto_allocation_failed'
  | 'insufficient_physical_stock'
  | 'shipment_creation_failed'
  | 'coverage_shortfall'
  | 'order_not_ready_to_ship'
  | 'shipment_status_transition_failed'
  | 'despatch_review_not_recorded'
  | 'wms_other_warehouse_shipments'
  /** Mixed-warehouse scope: the part the warehouse was sent no longer matches what IMS holds for it (or the warehouse's shipments do not match it). Retryable; not a connector failure. */
  | 'wms_scope_mismatch'
  /** Mixed-warehouse scope: the store reported the order completed while the warehouse's part is still open. Ignored (nothing is shipped); permanent, so the delivery is acknowledged and an exception is raised. */
  | 'wms_part_open'

export type ExternalFulfillmentOutcome =
  | {
      success: true
      /**
       * Set when the warehouse's despatch was RECORDED against an order that is DRAFT / ON_HOLD / PENDING_PAYMENT: the
       * shipment, stock and COGS are booked, but the order was left as it was and no storefront completion was queued.
       */
      despatchedWhileNotReady?: string
      /** The despatch was already applied (mixed-warehouse scope, settled link): nothing was done and nothing is to be recorded again. */
      noop?: true
    }
  | {
      success: false
      error: string
      refusal: ExternalFulfillmentRefusal
      /**
       * `true` when re-running this identical request would reach the identical answer, so a
       * caller should record it and move on rather than retry.
       *
       * Only `coverage_shortfall` qualifies. It is computed entirely from committed IMS state —
       * the order's own lines, its refunds and its shipment lines — so a redelivery of the same
       * storefront event re-reads the same rows and refuses again.
       *
       * THAT IS TRUE ONLY ONCE THE ORDER'S REFUNDS ARE IN, and it is the CALLER'S job to know
       * whether they are (o3d-xnwu r2, Codex HIGH). Committed state is not the same as settled
       * state: the WooCommerce order webhook runs this via the status sync and sweeps the order's
       * refunds AFTERWARDS, so a completion reaching here mid-delivery is answered from a state
       * that is committed and STALE. Eight shipped of ten ordered with two refunded in the same
       * delivery is a complete dispatch, and it is refused — and recorded as permanent, which
       * buries it — moments before the refunds that would have netted the demand arrive. So this
       * flag says what it has always said, and `externalFulfillmentRefusalAwaitsRefunds` below
       * says which refusals a caller must not ACT on until it has finished reading refunds.
       *
       * `insufficient_physical_stock` is deliberately NOT permanent, on the same reasoning that
       * keeps a P2002 on `sku` transient in product-sync-errors.ts: it is a statement about IMS
       * stock at this instant, not about the request, and it clears the moment a receipt lands —
       * so the retry is not merely safe, it is the fix.
       */
      permanent: boolean
    }

/** The refusals a retry can never resolve. Everything unlisted stays retryable, which is the safe direction. */
const PERMANENT_EXTERNAL_FULFILLMENT_REFUSALS: ReadonlySet<ExternalFulfillmentRefusal> = new Set([
  'coverage_shortfall',
  // A storefront completion echo for a mixed order whose warehouse part is still open is ignored for good: the warehouse's own despatch is the evidence that completes it.
  'wms_part_open',
])

/**
 * The refusals whose answer a refund that has not been read yet can still change (o3d-xnwu r2).
 *
 * `coverage_shortfall` is computed against ordered-net-of-refunds demand, so every refund the store
 * holds and IMS has not yet applied moves the line it is compared against — DOWNWARDS, i.e. towards
 * the shipment covering it. A caller that reaches this refusal while it still has refunds to sweep
 * has not been told "no"; it has been told "not with what you have read so far", and must re-ask
 * once the sweep is complete rather than record a permanent refusal.
 *
 * The set is separate from PERMANENT_EXTERNAL_FULFILLMENT_REFUSALS rather than replacing it, and
 * `coverage_shortfall` is deliberately in BOTH: once the refunds ARE in, the original reasoning
 * holds exactly as it did and the refusal is permanent. Demoting it to transient instead would
 * restore the endless-retry behaviour this branch exists to remove.
 */
const REFUSALS_AWAITING_REFUNDS: ReadonlySet<ExternalFulfillmentRefusal> = new Set([
  'coverage_shortfall',
])

/**
 * Would reading the order's outstanding refunds change this refusal? Asked by callers that sync
 * refunds AFTER fulfilment, so they can hold the verdict instead of recording a stale one.
 */
export function externalFulfillmentRefusalAwaitsRefunds(
  refusal: ExternalFulfillmentRefusal | undefined,
): boolean {
  return refusal !== undefined && REFUSALS_AWAITING_REFUNDS.has(refusal)
}

/** Marks that the operator review event for a recorded despatch on an unreleased order has been raised. */
const NOT_READY_DESPATCH_ACTION = 'external_despatch_recorded_order_not_ready'

function refuseExternalFulfillment(
  refusal: ExternalFulfillmentRefusal,
  error: string,
): ExternalFulfillmentOutcome {
  return { success: false, error, refusal, permanent: PERMANENT_EXTERNAL_FULFILLMENT_REFUSALS.has(refusal) }
}

type ResolvedOrder = {
  id: string
  orderNumber: string | null
  externalOrderNumber: string | null
  status: string
}

/**
 * o3d-r5uk (Codex round 2 HIGH 2) — A WAREHOUSE POINTED AT AN ARCHIVED STOREFRONT FAILS CLOSED HERE,
 * AND SAYS SO ONCE PER EVENT.
 *
 * `WmsConnection.orderLookupConnector` is a plain String and can still say `shopify`. Returning
 * `null` is the fail-closed answer — `resolveOrderForExternalFulfillment` finds no order and
 * `applyExternalFulfillmentUpdate` refuses with `order_not_found` — but `order_not_found` is a
 * misleading thing to tell an operator about a misconfiguration, and this path has been bitten by a
 * silent refusal before (o3d-xnwu, forty lines down). So the unsupported case is logged with the
 * offending value.
 *
 * NOT a new `ExternalFulfillmentRefusal` member: the refusal would have to be threaded out through
 * `resolveOrderForExternalFulfillment`'s `ResolvedOrder | null` return, which two connectors and the
 * WooCommerce completion flow read, and widening that union changes what
 * `PERMANENT_EXTERNAL_FULFILLMENT_REFUSALS` and `REFUSALS_AWAITING_REFUNDS` are total over. The
 * misread — answering WooCommerce for a Shopify-configured warehouse — is what had to stop; the
 * refusal code it lands on is a separate question, filed rather than smuggled in here.
 */
async function resolveShoppingConnectorForSource(
  source: ExternalFulfillmentSource,
): Promise<ShoppingConnectorId | null> {
  if (isShoppingConnectorId(source)) return source
  if (isWmsConnectorId(source)) {
    const resolution = await resolveWmsOrderLookupConnector(source)
    if (resolution.kind === 'one') return resolution.connector
    if (resolution.kind === 'unsupported') {
      await logActivity({
        entityType: 'SYNC',
        action: 'external_fulfillment_order_lookup_unsupported',
        tag: 'sync',
        level: 'WARNING',
        description: `${source} fulfilment could not resolve a storefront to look the order up in: `
          + shoppingOrderLookupSkipReason(resolution),
        metadata: { source, connectors: [...resolution.connectors], from: resolution.from },
        resolveUser: false,
      })
    }
    return null
  }
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
        // o3d-4gw0: the pin. The shortfall is judged against the recipe the order was allocated and
        // will be dispatched from (shipment-service reads the same column), never the current graph.
        fulfillmentRequirements: true,
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
  const orderLineById = new Map(orderLines.map((line) => [line.id, line]))

  const demandByLeaf = new Map<string, Prisma.Decimal>()
  const labelByLine = new Map<string, string>()
  for (const line of shippableLines) {
    labelByLine.set(line.id, line.sku ?? line.description ?? line.id)
    for (const [componentId, componentQty] of lineFulfillmentRequirementQuantities(line, toDecimal(line.qty), graph)) {
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
    // o3d-4gw0: through the line the refund names, so it nets against the SAME pinned recipe the
    // demand above was built from (see `refundLineResolvableLine`).
    const refundedResolvable = refundLineResolvableLine(
      { salesOrderLineId: refundLine.salesOrderLineId, productId: refundLine.productId },
      orderLineById,
    )
    for (const [componentId, componentQty] of lineFulfillmentRequirementQuantities(refundedResolvable, toDecimal(refundLine.qty), graph)) {
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

/**
 * o3d-hqvrp.78: A WMS DISPATCH IS EVIDENCE ABOUT THE WMS WAREHOUSE ONLY. Allocation can place part (or all) of an order in a warehouse the
 * WMS never served, and driving that shipment to SHIPPED would take stock out of a warehouse the goods never left. A shipment IMS holds in a
 * different warehouse is therefore never driven by the WMS: the dispatch is refused (retryable, visible on the sync exceptions inbox) until
 * an operator reallocates the order to the WMS warehouse or ships the other warehouse by hand.
 *
 * The WMS warehouse is the one the WMS order was PUSHED for (the push link's `pushWarehouseId`), so a later change of the order's ship-from
 * warehouse cannot turn the real WMS shipments into "foreign" ones. A link with none (created before the column) falls back to the order's
 * current ship-from warehouse; with neither, nothing is refused.
 */
async function refuseWmsForeignWarehouseShipments(
  update: ExternalFulfillmentUpdate,
  orderId: string,
  orderRef: string,
  shipments: Array<{ id: string; warehouseId: string | null }>,
): Promise<ExternalFulfillmentOutcome | null> {
  if (update.targetShipmentStatus !== 'SHIPPED' || !isWmsConnectorId(update.source)) return null
  const [link, wmsOrder] = await Promise.all([
    db.wmsOrderPushLink.findUnique({ where: { orderId }, select: { pushWarehouseId: true } }),
    db.salesOrder.findUnique({ where: { id: orderId }, select: { shipFromWarehouseId: true } }),
  ])
  const wmsWarehouseId = link?.pushWarehouseId ?? wmsOrder?.shipFromWarehouseId ?? null
  const foreign = wmsWarehouseId
    ? shipments.filter((shipment) => shipment.warehouseId && shipment.warehouseId !== wmsWarehouseId)
    : []
  if (foreign.length === 0) return null
  const error = `${update.source} despatched order ${orderRef}, but IMS holds ${foreign.length} unshipped shipment(s) in a warehouse other than the one `
    + `${update.source} serves, so the despatch was not applied to them (the goods did not leave that warehouse). Reallocate the order to the `
    + 'WMS warehouse or ship the other warehouse by hand, then replay the despatch.'
  await logActivity({
    entityType: 'SALES_ORDER',
    entityId: orderId,
    action: 'external_fulfillment_other_warehouse_shipments',
    tag: 'sync',
    level: 'WARNING',
    description: error,
    metadata: { source: update.source, wmsWarehouseId, shipmentIds: foreign.map((shipment) => shipment.id), warehouseIds: [...new Set(foreign.map((shipment) => shipment.warehouseId))] },
    resolveUser: false,
  })
  return refuseExternalFulfillment('wms_other_warehouse_shipments', error)
}


/** The order's push link as a despatch needs it (scope mode, version, the warehouse pushed for, whether the part is settled or frozen). Null when there is none. */
type DespatchLink = { id: string; scopeMode: 'FULL' | 'MIXED' | null; scopeVersion: number; pushWarehouseId: string | null; despatchSettledAt: Date | null; scopeFrozenAt: Date | null; state: string }
type MixedDespatchLink = DespatchLink

async function readDespatchLink(orderId: string): Promise<DespatchLink | null> {
  const link = await db.wmsOrderPushLink.findUnique({
    where: { orderId },
    select: { id: true, scopeMode: true, scopeVersion: true, pushWarehouseId: true, despatchSettledAt: true, scopeFrozenAt: true, state: true },
  })
  return link ?? null
}

/**
 * A storefront (WooCommerce) 'completed' echo for a MIXED order whose warehouse part is still open (owner answer Q6). The warehouse's own despatch completes the
 * order; the storefront cannot, because applying it would ship the OTHER warehouse's shipments on the word of a status. It is ignored: nothing is shipped, the
 * refusal is permanent (the delivery is acknowledged) and the caller raises the exception row on Sync > Exceptions, cleared when the order is fulfilled.
 */
async function refuseCompletionEchoOnOpenMixedPart(update: ExternalFulfillmentUpdate, orderId: string, orderRef: string): Promise<ExternalFulfillmentOutcome> {
  const error = `${update.source} reported order ${orderRef} completed, but the order is split across warehouses and the warehouse's part has not been applied in IMS yet (it has not despatched, or its despatch is held on a mismatch that is listed under Exceptions), `
    + 'so the completion was ignored and no shipment was marked shipped. The warehouse despatch completes its part (a held one is cleared by shipping the warehouse\'s shipment in IMS by hand); ship the other warehouse\'s part in IMS when it leaves.'
  await logActivity({
    entityType: 'SALES_ORDER',
    entityId: orderId,
    action: 'external_fulfillment_completion_echo_ignored',
    tag: 'sync',
    level: 'WARNING',
    description: error,
    metadata: { source: update.source },
    resolveUser: false,
  })
  return refuseExternalFulfillment('wms_part_open', error)
}

/**
 * THE SCOPED WAREHOUSE DESPATCH (mixed-warehouse scope, flag on, link MIXED). The warehouse despatched the part IMS sent it; only the warehouse's OWN shipments
 * are shipped and the other warehouses' are left exactly as they are.
 *
 *  - APPLIED ONCE PER SCOPE VERSION: an application row keyed by (link, scope version) is written in the same transaction that stamps the link settled, so a
 *    replayed despatch finds it and ships nothing, and a crash between the shipments and the row simply repeats (a shipped shipment is not shipped again).
 *  - EXACT MATCH OR NOTHING: the scope IMS would send now must carry the units that were sent, and the warehouse's open shipments must hold exactly the
 *    allocations in the warehouse. Otherwise the despatch is refused as `wms_scope_mismatch` (retryable, raised for a person, never counted as a connector
 *    failure): shipping a different set of goods than the warehouse picked would book the wrong stock and cost.
 *  - The order is promoted (and the storefront completed) only when EVERY shipment has shipped, exactly as for any partial despatch.
 */
async function applyScopedWmsDespatch(
  update: ExternalFulfillmentUpdate,
  order: ResolvedOrder,
  orderRef: string,
  link: MixedDespatchLink,
): Promise<ExternalFulfillmentOutcome> {
  const idempotencyKey = `${link.id}:${link.scopeVersion}`
  const alreadyApplied = !!link.despatchSettledAt
    || (await db.wmsDespatchApplication.findUnique({ where: { idempotencyKey }, select: { id: true } })) !== null
  if (alreadyApplied) return { success: true, noop: true }

  const mismatch = (why: string) => scopeMismatchRefusal(update, order.id, orderRef, why, link.scopeVersion)

  const wmsWarehouseId = link.pushWarehouseId
  if (!wmsWarehouseId) return mismatch('the warehouse order records no IMS warehouse')
  const { confirmAllocations, updateShipmentStatus } = await import('@/app/actions/allocation')
  const readShipments = () => db.shipment.findMany({
    where: { orderId: order.id },
    select: { id: true, status: true, warehouseId: true, lines: { select: { lineId: true, productId: true, qty: true } } },
    orderBy: { createdAt: 'asc' },
  })
  let shipments = await readShipments()

  // THE WAY OUT OF A MISMATCH: every shipment the warehouse holds in IMS is already shipped (by hand). There is nothing left to ship, so nothing can be
  // shipped twice; the despatch is recorded as applied and the link settles.
  const settledByHand = shipments.filter((shipment) => shipment.warehouseId === wmsWarehouseId)
  if (settledByHand.length > 0 && settledByHand.every((shipment) => shipment.status === 'SHIPPED')) {
    return recordScopedApplication(db, link, idempotencyKey, [], update, order, orderRef)
  }

  const [current, sentLines] = await Promise.all([
    loadMixedScopeForOrder(db, order.id, wmsWarehouseId),
    db.wmsOrderPushScopeLine.findMany({ where: { linkId: link.id, scopeVersion: link.scopeVersion }, select: { orderLineId: true, quantity: true } }),
  ])
  if (!current || current.mode !== 'MIXED') return mismatch('the order is no longer split the way it was when it was sent to the warehouse')
  if (!sameScopeLines(sentLines.map((line) => ({ lineId: line.orderLineId, quantity: line.quantity.toString() })), current.lines.map((line) => ({ lineId: line.lineId, quantity: line.quantity })))) {
    return mismatch('the units IMS holds for the warehouse differ from the units it was sent')
  }

  if (shipments.length === 0) {
    const created = await confirmAllocations(order.id, { internalBypassToken: INTERNAL_ACTION_BYPASS })
    if (!created.success) return refuseExternalFulfillment('shipment_creation_failed', created.error ?? 'Shipment creation failed')
    shipments = await readShipments()
  }
  const wmsShipments = shipments.filter((shipment) => shipment.warehouseId === wmsWarehouseId)
  const wmsAllocations = await db.orderAllocation.findMany({ where: { orderId: order.id, warehouseId: wmsWarehouseId }, select: { lineId: true, productId: true, qty: true } })
  const difference = warehouseShipmentsMatchAllocations(
    wmsShipments.flatMap((shipment) => shipment.lines.map((row) => ({ lineId: row.lineId, productId: row.productId, qty: row.qty.toString() }))),
    wmsAllocations.map((row) => ({ lineId: row.lineId, productId: row.productId, qty: row.qty.toString() })),
  )
  if (difference) return mismatch(difference)

  const shortfalls = await findExternalFulfillmentShortfall(order.id)
  if (shortfalls.length > 0) {
    const error = describeExternalFulfillmentShortfall(shortfalls)
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: order.id,
      action: 'external_fulfillment_short',
      tag: 'sync',
      level: 'WARNING',
      description: `${update.source} dispatch for order ${orderRef} was refused: the IMS shipment lines do not cover everything ordered`,
      metadata: { source: update.source, shortfalls },
      resolveUser: false,
    })
    return refuseExternalFulfillment('coverage_shortfall', error)
  }

  const open = wmsShipments.filter((shipment) => shipment.status !== 'SHIPPED')
  // The partial-shipment e-mail (storefront switch) is judged ONCE, after the whole batch is applied, never shipment by shipment (see queueStorefrontPartialShipmentEmailsAfterBatch).
  const processedInBatch: string[] = []
  const flushPartialEmails = async (): Promise<void> => {
    const { queueStorefrontPartialShipmentEmailsAfterBatch } = await import('@/lib/storefront-customer-email')
    await queueStorefrontPartialShipmentEmailsAfterBatch(processedInBatch)
  }
  const discardPartialEmails = (): void => { processedInBatch.length = 0 }
  for (let index = 0; index < open.length; index++) {
    const shipment = open[index]
    const tracking = update.tracking?.[index] ?? (update.tracking?.length === 1 ? update.tracking[0] : undefined)
    for (const target of statusesToApply(shipment.status as ExternalShipmentStatus, 'SHIPPED')) {
      const result = await updateShipmentStatus(
        shipment.id,
        target,
        target === 'SHIPPED' && tracking ? { trackingNumber: tracking.trackingNumber, shippingService: tracking.shippingService ?? undefined } : undefined,
        {
          internalBypassToken: INTERNAL_ACTION_BYPASS,
          completionAuthority: 'EXTERNAL',
          allowRecordWhenNotReady: true,
          // The completion job is enqueued WITH the order flip, which happens only when every shipment has shipped (see promoteOrderIfFulfilledInTx).
          storefrontCompletion: update.storefrontAlreadyCompleted !== true,
          skipStorefrontPush: update.storefrontAlreadyCompleted === true,
          ...(update.storefrontAlreadyCompleted === true && update.shipFence ? { shipFence: update.shipFence } : {}),
          deferStorefrontPartialEmail: true,
        },
      )
      if (result.success && target === 'SHIPPED') processedInBatch.push(shipment.id)
      if (!result.success) {
        // A failed batch judges NO partial e-mail when the failing shipment is the LAST one: the failure may be the fence refusing the order flip AFTER it
        // shipped, in which case the order is still PROCESSING while the store / WMS reported the whole order despatched, so "the rest will follow" would be
        // false. The retry either flips the order (dispatched e-mail, no partial) or ends in a terminal refusal.
        // When a LATER shipment of the batch is still unshipped the order genuinely owes more (the partial rule re-checks the order under its lock), and the
        // shipments already shipped would never be judged again (the retry's open list excludes them), so their partial e-mails are flushed now. One e-mail
        // per shipment (the kind carries the shipment id), so nothing can go out twice.
        if (index < open.length - 1) await flushPartialEmails()
        else discardPartialEmails()
        await logActivity({
          entityType: 'SALES_ORDER',
          entityId: order.id,
          action: 'external_fulfillment_failed',
          tag: 'sync',
          level: 'WARNING',
          description: `${update.source} fulfillment update failed at ${target} for order ${orderRef}`,
          metadata: { source: update.source, shipmentId: shipment.id, target, error: result.error },
          resolveUser: false,
        })
        return refuseExternalFulfillment('shipment_status_transition_failed', result.error ?? `Failed to update shipment to ${target}`)
      }
    }
  }

  await flushPartialEmails()
  return recordScopedApplication(db, link, idempotencyKey, open.map((shipment) => shipment.id), update, order, orderRef)
}

/** Write the application row and settle the link in ONE transaction. A concurrent apply that wrote the row first is the outcome wanted (P2002 is a success). */
async function recordScopedApplication(
  client: typeof db,
  link: DespatchLink,
  idempotencyKey: string,
  shipmentIds: string[],
  update: ExternalFulfillmentUpdate,
  order: ResolvedOrder,
  orderRef: string,
): Promise<ExternalFulfillmentOutcome> {
  try {
    await client.$transaction(async (tx) => {
      await tx.wmsDespatchApplication.create({ data: { linkId: link.id, scopeVersion: link.scopeVersion, idempotencyKey, shipmentIds } })
      await tx.wmsOrderPushLink.update({ where: { id: link.id }, data: { despatchSettledAt: new Date() } })
    })
  } catch (error) {
    if ((error as { code?: string } | null)?.code !== 'P2002') {
      return refuseExternalFulfillment('shipment_status_transition_failed', `The warehouse's part was shipped but the despatch could not be recorded; it will be retried: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
  }
  await logActivity({
    entityType: 'SALES_ORDER',
    entityId: order.id,
    action: 'external_fulfillment_applied',
    tag: 'sync',
    level: 'INFO',
    description: `Applied ${update.source} fulfillment update to SHIPPED for the warehouse's part of order ${orderRef} (${shipmentIds.length} shipment(s); other warehouses' shipments left open)`,
    metadata: { source: update.source, targetShipmentStatus: 'SHIPPED', shipmentsProcessed: shipmentIds.length, scoped: true, scopeVersion: link.scopeVersion },
    resolveUser: false,
  })
  return { success: true }
}

/** A scope mismatch: nothing is shipped, a person is told what actually clears it, and the despatch is retried. */
async function scopeMismatchRefusal(update: ExternalFulfillmentUpdate, orderId: string, orderRef: string, why: string, scopeVersion: number): Promise<ExternalFulfillmentOutcome> {
  const error = `${update.source} despatched order ${orderRef}, but ${why}. Nothing was shipped. To clear this, ship the warehouse's shipment(s) for the order in IMS by hand (the despatch then records itself), `
    + 'or reallocate the order so it matches what was sent to the warehouse; it is retried on every pass.'
  await logActivity({
    entityType: 'SALES_ORDER',
    entityId: orderId,
    action: 'external_fulfillment_scope_mismatch',
    tag: 'sync',
    level: 'WARNING',
    description: error,
    metadata: { source: update.source, scopeVersion },
    resolveUser: false,
  })
  return refuseExternalFulfillment('wms_scope_mismatch', error)
}

/**
 * A warehouse despatch for a link that was NOT pushed as a part (single-warehouse, FULL or unscoped), flag on: it is refused while the link is frozen (a scope
 * change the warehouse could not take) or the order is now split, and a shipment of the warehouse is still open, because the warehouse was sent a different set of
 * goods than IMS now holds for it and shipping the rest would count units twice. Null: the ordinary path runs.
 */
async function guardUnscopedDespatch(update: ExternalFulfillmentUpdate, order: ResolvedOrder, orderRef: string, link: DespatchLink): Promise<ExternalFulfillmentOutcome | null> {
  const [shipments, orderRow] = await Promise.all([
    db.shipment.findMany({ where: { orderId: order.id }, select: { id: true, status: true, warehouseId: true } }),
    db.salesOrder.findUnique({ where: { id: order.id }, select: { shipFromWarehouseId: true } }),
  ])
  const wmsWarehouseId = link.pushWarehouseId ?? orderRow?.shipFromWarehouseId ?? null
  if (!wmsWarehouseId) return null
  const open = shipments.filter((shipment) => shipment.warehouseId === wmsWarehouseId && shipment.status !== 'SHIPPED')
  if (open.length === 0) return null
  const current = link.scopeFrozenAt ? null : await loadMixedScopeForOrder(db, order.id, wmsWarehouseId)
  if (!link.scopeFrozenAt && current?.mode === 'FULL') return null
  return scopeMismatchRefusal(update, order.id, orderRef, link.scopeFrozenAt ? 'a change to the order after it was sent could not be applied in the warehouse (it was already past New)' : 'the order is now split across warehouses although the warehouse was sent the whole order', link.scopeVersion)
}

export async function applyExternalFulfillmentUpdate(
  update: ExternalFulfillmentUpdate,
): Promise<ExternalFulfillmentOutcome> {
  const order = await resolveOrderForExternalFulfillment(update.source, update.lookup)
  if (!order) {
    return refuseExternalFulfillment('order_not_found', 'Order not found for external fulfillment update')
  }

  const { autoAllocateOrder, confirmAllocations, updateShipmentStatus } = await import('@/app/actions/allocation')

  // A WAREHOUSE DESPATCH FOR AN ORDER IMS HAS NOT RELEASED (DRAFT / ON_HOLD / PENDING_PAYMENT). The goods have physically
  // left, so a despatch that can be recorded exactly is recorded (shipment, stock, FIFO, COGS) - but the order is left
  // as it is: not promoted, hold not cleared, no storefront completion. Allocating or creating shipments here would
  // finalise a draft or lift the hold as a side effect, so when the order has no shipment yet there is nothing IMS can
  // record without doing that, and the despatch is refused as an unreconciled despatch for an operator (the ordinary
  // stuck-despatch path: retried, then dead-lettered into the exception inbox with a bell notice).
  const orderNotReady = update.targetShipmentStatus === 'SHIPPED' && ORDER_STATUSES_NOT_READY_TO_DISPATCH.has(String(order.status))
  const orderRef = order.externalOrderNumber ?? order.orderNumber ?? order.id
  if (orderNotReady) {
    const existingShipments = await db.shipment.count({ where: { orderId: order.id } })
    if (order.status === 'DRAFT' || existingShipments === 0) {
      const error = `${update.source} despatched order ${orderRef} but IMS has not released it (${String(order.status)})`
        + ' and holds no shipment for it, so the despatch was not recorded. It is listed under Sync > Exceptions: finalise or release the order'
        + ' there first, then replay the despatch.'
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: order.id,
        action: 'external_fulfillment_order_not_ready',
        tag: 'sync',
        level: 'WARNING',
        description: error,
        metadata: { source: update.source, orderStatus: order.status, shipments: existingShipments },
        resolveUser: false,
      })
      return refuseExternalFulfillment('order_not_ready_to_ship', error)
    }
  }

  // MIXED-WAREHOUSE SCOPE. Driven by the link's own data (a link pushed as a part stays scoped even if the flag is later turned off); the flag only adds the
  // guard for links that were not pushed as a part. A link with no scope data (every link while the feature has never been on) reads nothing here.
  if (update.targetShipmentStatus === 'SHIPPED') {
    const despatchLink = await readDespatchLink(order.id)
    if (despatchLink) {
      const mixed = despatchLink.scopeMode === 'MIXED'
      if (isWmsConnectorId(update.source)) {
        // The warehouse's part was already applied (whatever the flag says): nothing to do, and nothing to record again.
        if (despatchLink.despatchSettledAt) return { success: true, noop: true }
        if (mixed) {
          if (orderNotReady) {
            // Fail closed: the scoped checks run on a released order only.
            return refuseExternalFulfillment('order_not_ready_to_ship', `${update.source} despatched order ${orderRef}, which is split across warehouses and is held in IMS (${String(order.status)}). Release the order, then the despatch is applied.`)
          }
          return applyScopedWmsDespatch(update, order, orderRef, despatchLink)
        }
        if (!orderNotReady && (await isMixedWarehousePushEnabled())) {
          const guarded = await guardUnscopedDespatch(update, order, orderRef, despatchLink)
          if (guarded) return guarded
        }
      } else if (mixed && !despatchLink.despatchSettledAt && (despatchLink.state === 'SYNCED' || despatchLink.state === 'MERGED')) {
        // Only while the warehouse still holds a live part: a held or cancelled warehouse order has no open part, so the storefront completion is the ordinary one.
        return refuseCompletionEchoOnOpenMixedPart(update, order.id, orderRef)
      }
    }
  }

  // o3d-hqvrp.78: the refusal comes BEFORE any side effect (allocation, shipment creation) for shipments that already exist.
  if (update.targetShipmentStatus === 'SHIPPED' && isWmsConnectorId(update.source)) {
    const existing = await db.shipment.findMany({ where: { orderId: order.id, status: { not: update.targetShipmentStatus } }, select: { id: true, warehouseId: true } })
    const refusedEarly = await refuseWmsForeignWarehouseShipments(update, order.id, orderRef, existing)
    if (refusedEarly) return refusedEarly
  }

  const allocationCount = await db.orderAllocation.count({ where: { orderId: order.id } })
  if (allocationCount === 0 && !orderNotReady) {
    const result = await autoAllocateOrder(order.id, { internalBypassToken: INTERNAL_ACTION_BYPASS })
    if (!result.success) {
      return refuseExternalFulfillment('auto_allocation_failed', result.error ?? 'Auto-allocation failed')
    }
    if ((result.allocationCount ?? 0) === 0 && (result.unallocatedQty ?? 0) > 0) {
      // o3d-xnwu: this refusal produced literally no record until now — the WooCommerce caller
      // discarded the result and nothing was logged here either, so an order the store had marked
      // completed simply never became an IMS shipment and no surface said so.
      const error = `External fulfillment requires physical stock — order has ${result.unallocatedQty} unit(s) on backorder`
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: order.id,
        action: 'external_fulfillment_backordered',
        tag: 'sync',
        level: 'WARNING',
        description: `${update.source} dispatch for order ${order.externalOrderNumber ?? order.orderNumber ?? order.id} `
          + `was refused: IMS has no physical stock to consume for ${result.unallocatedQty} unit(s), so the `
          + 'order cannot be promoted to SHIPPED. It clears by itself once the stock is received.',
        metadata: { source: update.source, unallocatedQty: result.unallocatedQty },
        resolveUser: false,
      })
      return refuseExternalFulfillment('insufficient_physical_stock', error)
    }
  }

  const shipmentCount = await db.shipment.count({ where: { orderId: order.id } })
  if (shipmentCount === 0 && !orderNotReady) {
    const result = await confirmAllocations(order.id, { internalBypassToken: INTERNAL_ACTION_BYPASS })
    if (!result.success) {
      return refuseExternalFulfillment('shipment_creation_failed', result.error ?? 'Shipment creation failed')
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
      return refuseExternalFulfillment('coverage_shortfall', error)
    }
  }

  const shipments = await db.shipment.findMany({
    where: { orderId: order.id, status: { not: update.targetShipmentStatus } },
    select: { id: true, status: true, warehouseId: true },
    orderBy: { createdAt: 'asc' },
  })

  // o3d-hqvrp.78: re-checked here as well, because the allocation above may just have created shipments in another warehouse.
  const refusedForeign = await refuseWmsForeignWarehouseShipments(update, order.id, orderRef, shipments)
  if (refusedForeign) return refusedForeign

  // The unreleased status the dispatch transaction itself found under the order lock (set only when it recorded without promoting).
  let lockedNotReadyStatus: string | null = null
  // The partial-shipment e-mail (storefront switch) is judged ONCE, after the whole batch is applied, never shipment by shipment (see queueStorefrontPartialShipmentEmailsAfterBatch).
  const shippedInBatch: string[] = []
  const flushPartialEmails = async (): Promise<void> => {
    const { queueStorefrontPartialShipmentEmailsAfterBatch } = await import('@/lib/storefront-customer-email')
    await queueStorefrontPartialShipmentEmailsAfterBatch(shippedInBatch)
  }
  const discardPartialEmails = (): void => { shippedInBatch.length = 0 }
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
          // The goods have already left: if the order is found unreleased UNDER THE ORDER LOCK the dispatch is recorded
          // without promotion (and reported back); if it was released meanwhile it promotes normally. The pre-read above
          // only decides whether IMS may allocate / create shipments, never whether the order is promoted.
          allowRecordWhenNotReady: true,
          // o3d-zvec.15: a WMS dispatch is the thing that completes the storefront order, so the
          // durable completion job is enqueued WITH the flip (tracking first, then the status; retried
          // by the cron; held for orders WooCommerce no longer has in flight). A storefront-sourced
          // completion must never push back, as it would only echo.
          storefrontCompletion: isWmsConnectorId(update.source) && update.storefrontAlreadyCompleted !== true,
          skipStorefrontPush: update.storefrontAlreadyCompleted === true,
          ...(update.storefrontAlreadyCompleted === true && update.shipFence ? { shipFence: update.shipFence } : {}),
          deferStorefrontPartialEmail: true,
        },
      )

      if (result.success && result.despatchedWhileNotReady) lockedNotReadyStatus = result.despatchedWhileNotReady
      if (result.success && target === 'SHIPPED') shippedInBatch.push(shipment.id)

      if (!result.success) {
        // A failed batch judges NO partial e-mail when the failing shipment is the LAST one: the failure may be the fence refusing the order flip AFTER it
        // shipped, in which case the order is still PROCESSING while the store / WMS reported the whole order despatched, so "the rest will follow" would be
        // false. The retry either flips the order (dispatched e-mail, no partial) or ends in a terminal refusal.
        // When a LATER shipment of the batch is still unshipped the order genuinely owes more (the partial rule re-checks the order under its lock), and the
        // shipments already shipped would never be judged again (the retry's open list excludes them), so their partial e-mails are flushed now. One e-mail
        // per shipment (the kind carries the shipment id), so nothing can go out twice.
        if (index < shipments.length - 1) await flushPartialEmails()
        else discardPartialEmails()
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
        return refuseExternalFulfillment(
          'shipment_status_transition_failed',
          result.error ?? `Failed to update shipment to ${target}`,
        )
      }
    }
  }

  // The whole batch is applied: only now is "the order still owes more" a fact (an order that reached SHIPPED in the batch gets the dispatched e-mail, not a partial one).
  await flushPartialEmails()

  // RETRY OF A COMPLETION THAT LEFT THE ORDER UNFLIPPED. Every shipment may already be SHIPPED while the order itself was not
  // promoted: a verification fence refused at the order flip after the shipment committed, or (SHP-H1) the promotion failed or
  // was interrupted after the dispatch had committed. No shipment is left to transition, so `updateShipmentStatus` (the only
  // other place the order is reconciled) is never reached: reconcile the order here instead, under the order lock and with the
  // FRESH fence when there is one, with no shipment transition and no stock work. Success is reported only once the order is
  // flipped or already complete; a refusal is an apply error and the next sweep tries again. This applies to the unfenced WMS
  // path too: it used to log success on every tick for an order that never reached SHIPPED.
  if (update.targetShipmentStatus === 'SHIPPED' && shipments.length === 0 && !orderNotReady) {
    const { reconcileOrderAfterShipment } = await import('@/lib/domain/sales/shipment-service')
    const fencedRetry = update.storefrontAlreadyCompleted === true && !!update.shipFence
    const reconciliation = await reconcileOrderAfterShipment(db, { orderId: order.id }, undefined, {
      completionAuthority: 'EXTERNAL',
      // The durable storefront-completion job is enqueued WITH the flip, exactly as the first dispatch would have done.
      storefrontCompletion: !fencedRetry && isWmsConnectorId(update.source) && update.storefrontAlreadyCompleted !== true,
      ...(fencedRetry && update.shipFence ? { fence: update.shipFence } : {}),
    })
    if (reconciliation.fenceRefused) {
      return refuseExternalFulfillment('shipment_status_transition_failed', reconciliation.fenceRefused)
    }
    if (reconciliation.orderReachedShipped !== true) {
      // Not flipped by this call: it must already BE shipped or complete. An order that became CANCELLED (or any other status that cannot
      // be shipped) between selection and this retry is a mismatch to surface, never a recorded success.
      const current = await db.salesOrder.findUnique({ where: { id: order.id }, select: { status: true } })
      if (!current || !['SHIPPED', 'COMPLETED', 'DELIVERED'].includes(String(current.status))) {
        return refuseExternalFulfillment(
          'shipment_status_transition_failed',
          `The order could not be completed after verification: it is ${current ? String(current.status) : 'missing'}, not shipped`,
        )
      }
    }
  }

  // Which status to review: the one the dispatch transaction found under the lock, else (a retry with nothing left to
  // transition) the pre-read one.
  const reviewStatus = lockedNotReadyStatus ?? (orderNotReady && shipments.length === 0 ? String(order.status) : null)
  if (reviewStatus) {
    // The review event is ENSURED, not just written: this runs after the despatch committed, so a crash between the
    // commit and the notice would otherwise leave the retry (no open shipment left) reporting a quiet success with
    // nobody told. The marker is the activity row, written LAST and ONLY once every notice has persisted; the retry
    // raises the event again unless the row exists.
    const alreadyRaised = lockedNotReadyStatus === null
      ? await db.activityLog.findFirst({
        where: { entityType: 'SALES_ORDER', entityId: order.id, action: NOT_READY_DESPATCH_ACTION },
        select: { id: true },
      })
      : null
    if (!alreadyRaised) {
      const notice = `${update.source} despatched order ${orderRef} while IMS holds it as ${reviewStatus}. The despatch, stock and`
        + ' cost have been recorded, but the order has NOT been marked shipped, its status is unchanged and no completion was sent to the'
        + ' storefront. Review the order: finalise or release it, then set it to Shipped if it should be closed.'
      let noticesPersisted = false
      try {
        const { notifyPersisted } = await import('@/lib/notifications')
        const admins = await db.user.findMany({ where: { role: 'ADMIN', active: true }, select: { id: true } })
        const persisted = await Promise.all(admins.map((admin) => notifyPersisted({
          userId: admin.id,
          type: 'error',
          title: 'Despatch on an order that is not ready to ship',
          message: notice,
          actionUrl: `/sales/${order.id}`,
        })))
        // With no active admin there is nobody to tell: `[].every(Boolean)` is true, so require at least one persisted notice.
        noticesPersisted = persisted.length > 0 && persisted.every(Boolean)
      } catch (noticeError) {
        console.error('[external-fulfillment] not-ready despatch notice failed:', noticeError)
      }
      const markerPersisted = noticesPersisted && await logActivityPersisted({
        entityType: 'SALES_ORDER',
        entityId: order.id,
        action: NOT_READY_DESPATCH_ACTION,
        tag: 'sync',
        level: 'WARNING',
        description: notice,
        metadata: { source: update.source, orderStatus: reviewStatus, shipmentsProcessed: shipments.length },
        resolveUser: false,
      })
      if (!markerPersisted) {
        // The despatch itself is recorded; only the review event is not. Retryable: the next tick finds nothing left to ship
        // and raises the event again (no marker exists).
        return refuseExternalFulfillment(
          'despatch_review_not_recorded',
          'The despatch was recorded but the review notice for the not-ready order could not be saved (no active admin, or a notice/marker write failed); it will be retried',
        )
      }
    }
    return { success: true, despatchedWhileNotReady: reviewStatus }
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

  // The storefront completion for a WMS dispatch (SHIPPED -> WooCommerce "completed", which fires the
  // customer despatch email) is no longer pushed from here. It is a durable `woocommerce/order.complete`
  // job enqueued inside the transaction that flips the order (storefrontCompletion above), so a failed
  // push is retried instead of being lost for good (o3d-zvec.15).

  return { success: true }
}
