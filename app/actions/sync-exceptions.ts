'use server'

import { revalidatePath } from 'next/cache'
import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { mergeStuckDispatchRows } from '@/lib/domain/wms/exception-inbox'
import {
  buildMaintenanceRecoveryState,
  claimPostMaintenanceRecheck,
  countMaintenanceRecovery,
  endMaintenanceHold,
  MAINTENANCE_RECOVERY_REFUSALS,
  type MaintenanceHoldIdentity,
  type MaintenanceRecoveryState,
} from '@/lib/domain/system/maintenance-recovery'
import {
  MAINTENANCE_ENABLED_KEY,
  MAINTENANCE_HOLD_KEY,
  WMS_BOOKED_IN_RECHECK_DUE_KEY,
} from '@/lib/maintenance-mode'
import { runPostMaintenanceRecheckForActiveConnector } from '@/lib/domain/wms/post-maintenance-recheck'
import { eligibleCohortDigest, isolatableLinkWhere, loadUnresolvedDriftIncidents, readRawDriftState, unresolvedDriftStateKey } from '@/lib/domain/wms/unresolved-drift'
import { INTEGRATION_PLUGIN_SETTING_KEYS } from '@/lib/integration-plugins'
import { withDispatchSweepLockOrSkip } from '@/lib/domain/wms/dispatch-sweep-lock'
import { logActivity } from '@/lib/activity-log'
import { freshAuthFailureResult, requireFreshPermission, requirePermission } from '@/lib/auth/server'
import {
  IntegrationOutboxAdminError,
  listIntegrationOutboxAdminRows,
  replayIntegrationOutboxAdminRow,
} from '@/lib/domain/integrations/outbox-admin'
import { INTEGRATION_OUTBOX_STATUS } from '@/lib/domain/integrations/outbox'
import {
  DEAD_RECEIPT_EVENT_STATUS,
  buildDeadReceiptEventReplayData,
  buildDeadReceiptEventReplayWhere,
} from '@/lib/domain/wms/exception-inbox'
import { syncRefundsForOrder } from '@/lib/connectors/woocommerce/sync/refund-sync'
import { wcFetch } from '@/lib/connectors/woocommerce/api'
import {
  RECOVERABLE_REFUND_PARK_STATUSES,
  buildRefundParkDismissData,
  buildRefundParkReassignData,
  describeRefundParkRecoverability,
  describeRefundReadDisagreement,
  normalizeRefundParkRecoveryAssertion,
  refundParkRecoveryNote,
  refuseDismiss,
  refuseOnLookupFailure,
  refuseReassign,
  refuseUnstableRefundList,
  type RefundParkRecoveryOutcome,
  type RefundParkRecoveryRefusal,
  type RefundParkRecoveryRefusalCode,
  type RefundParkView,
  type WcOrderRefundEvidence,
} from '@/lib/domain/sales/refund-park-recovery'
// o3d-w00 (Codex r7 #3): the pure payload→order-line link, imported from its own module rather than
// through the sync — the inbox needs the link, not a WooCommerce client.
import { refundedOrderLineId } from '@/lib/connectors/woocommerce/sync/refund-line-link'
import type { WcRefundLineItem } from '@/lib/connectors/woocommerce/sync/types'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import { roundQuantity, toDecimal, type Decimal } from '@/lib/domain/math/decimal'
import {
  buildTaxTypeRateIndex,
  chargedRateFromLineSnapshot,
  chargedRateFromShippingSnapshot,
  resolveOrderUniformTaxIdentity,
  resolvePostedRefundTaxIdentity,
  type TaxTypeRateIndex,
} from '@/lib/domain/sales/refund-posted-tax-identity'
import {
  findOverAllocatedRefundTarget,
  overAllocatedRefundTargetMessage,
} from '@/lib/domain/sales/refund-target-balances'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { getWmsConnector } from '@/lib/connectors/wms/registry'
import { createPrismaDispatchDeps, reconcileOneOrder } from '@/lib/domain/wms/dispatch-sweep'
import { bindWmsStatusToCandidate } from '@/lib/domain/wms/status-binding'
import { releaseWithdrawalHold } from '@/app/actions/sales'
import { getEnabledWmsConnectorId } from '@/lib/connectors/wms/active-connector'
import { WMS_CONNECTOR_IDS } from '@/lib/connectors/wms/types'
import type { FreshAuthFailureResult } from '@/lib/auth/session-gates'

// q66in.4.2: the dead-letter / exception inbox. One aggregated read model over
// every terminal failure state that previously had no (or a buried) surface:
// WMS order-push dead-letters, integration-outbox failures, DEAD receipt
// events, parked WooCommerce refund-sync rows, stuck dispatch reconciliations,
// and the advisory order-total penny-mismatch flags. Replay actions reuse the
// existing domain transitions so the original payload + idempotency key are
// preserved — a replay re-attempts the SAME work, never forges a new attempt.

const SECTION_LIMIT = 50

/**
 * How many of a drift cohort's orders the page RENDERS.
 *
 * Only a rendering bound — the digest Isolate is bound to always covers the
 * complete eligible set, and the page states the true count whenever this cap
 * bites, so a truncated list can never be mistaken for the blast radius.
 */
const DRIFT_COHORT_PREVIEW_LIMIT = 200

/**
 * Rolls the isolate transaction back with a message fit to show an operator.
 *
 * Thrown from INSIDE the transaction on purpose: these are the conditions that
 * must undo the quarantine rather than report alongside it, so they cannot be
 * `return`s.
 */
class DriftIsolationAborted extends Error {}

/**
 * Half a currency minor unit. Used twice in the hand-recorded refund path (o3d-w00 Codex r2 #2): the
 * allocation must add up to the parked WooCommerce refund, and no part of the order may be allocated
 * more than it has left to refund. Both are penny comparisons on figures an operator typed at 2dp, so
 * anything larger would be slack the invariant does not have, and anything smaller would trip on the
 * order's own stored rounding.
 */
const REFUND_ALLOCATION_EPSILON = 0.005

/**
 * o3d-w00 (Codex r3 #1): everything needed to work out the rate a hand-recorded allocation will
 * ACTUALLY be re-grossed at when its credit note posts — not the rate its order line nominally carries.
 * Loaded once and shared by the dialog loader and the recording action, so the figure the operator is
 * shown and the figure the conversion uses can never be two different numbers.
 */
type RefundPostingTaxContext = {
  reverseChargeSalesTaxType: string
  rateByTaxType: TaxTypeRateIndex
  /**
   * accountingTaxType of the ACTIVE TaxRate with this name — the order-default identity, resolved
   * exactly as createSalesOrderRefund resolves it (`{ name, active: true }`, no usedFor filter).
   */
  activeTaxTypeByName: Map<string, string | null>
}

/**
 * o3d-w00 (Codex r6 #3): whether this order's `taxForeign` is the plain SUM of its components' VAT,
 * with nothing netted off it for an order-level discount — which is what makes
 * `taxForeign − Σ line.taxForeign` shipping's VAT even on a discounted order.
 *
 * The WooCommerce importer builds it that way (computeWcOrderForeignTotals sums the line tax it writes
 * and the shipping tax lines, and allocates coupon money INTO the lines — o3d-y14), and a WC-imported
 * order is created WITH its ShoppingOrderLink in the same write, so the link's presence is the writer's
 * own mark. `createSalesOrder` instead SUBTRACTS the order discount's VAT from the same total, and it
 * creates no link — the same discriminator the Xero/QuickBooks payment pollers read as "a manual order"
 * (`shoppingLinks: { none: {} }`).
 *
 * Fails closed: any other provenance (no link, or a link from a connector whose import arithmetic is
 * not known to be a plain sum) keeps the conservative reading and a discounted order is still refused.
 */
function orderTaxIsSumOfComponents(shoppingLinks: readonly { connector: string }[]): boolean {
  return shoppingLinks.some((link) => link.connector === 'woocommerce')
}

async function loadRefundPostingTaxContext(): Promise<RefundPostingTaxContext> {
  const [taxRates, accountingSettings] = await Promise.all([
    db.taxRate.findMany({ select: { name: true, rate: true, accountingTaxType: true, active: true, usedFor: true } }),
    // A missing/unreadable settings row must not be read as "reverse charge is configured" — the empty
    // string is what disables the swap, and resolvePostedRefundTaxIdentity refuses on that rather than
    // guessing a rate.
    import('@/lib/accounting').then((accounting) => accounting.getAccountingSettings()).catch(() => null),
  ])
  const activeTaxTypeByName = new Map<string, string | null>()
  for (const taxRate of taxRates) {
    if (!taxRate.active || activeTaxTypeByName.has(taxRate.name)) continue
    activeTaxTypeByName.set(taxRate.name, taxRate.accountingTaxType ?? null)
  }
  return {
    reverseChargeSalesTaxType: accountingSettings?.reverseChargeSalesTaxType ?? '',
    // Only SALES-usable rates price a SALES tax code; an INPUT code sharing a string with an OUTPUT one
    // would otherwise look like an ambiguous mapping.
    rateByTaxType: buildTaxTypeRateIndex(taxRates.filter((taxRate) => taxRate.usedFor !== 'PURCHASE')),
    activeTaxTypeByName,
  }
}

export type WmsPushDeadLetterRow = {
  orderId: string
  orderNumber: string | null
  connector: string
  attempts: number
  lastError: string | null
  lastAttemptAt: string | null
}

export type PennyMismatchRow = {
  orderId: string
  orderNumber: string | null
  connector: string
  totalMismatchPence: number
  externalOrderNumber: string | null
}

export type OutboxFailureRow = {
  id: string
  connector: string
  operation: string
  status: string
  attempts: number
  lastError: string | null
  updatedAt: string
}

export type DeadReceiptEventRow = {
  id: string
  connector: string
  /** booked-in = wms_inbound_receipt_events (ASN goods-in); webhook = wms_webhook_events (order/inventory). */
  kind: 'booked-in' | 'webhook'
  externalEventId: string
  /** ASN id for booked-in rows; the event type for webhook rows. */
  reference: string | null
  processingAttempts: number
  lastError: string | null
  deadLetteredAt: string | null
}

/**
 * Somewhere the refunded money can have come from, offered to the operator in the Record-manually
 * dialog. o3d-w00 (Codex r2 #3): SHIPPING is one of them. The dialog used to list order lines only, so a
 * refund that included postage could not be described at all — the operator could only leave the park
 * open or push shipping money onto a goods line, which posts to the wrong account at the wrong VAT.
 *
 * `vatRate` is the rate this target will be RE-GROSSED at when the credit note posts — resolved from the
 * accounting tax IDENTITY the refund line will carry (o3d-w00 Codex r3 #1), not from the order line's
 * nominal `TaxRate.rate`. The two diverge exactly where it costs money: a line whose TaxRate has no
 * accounting tax code posts under the ORDER-DEFAULT identity, so a nominally 0% line on a 20% order
 * posts at 20% and a "reconciled" £100 allocation would raise a £120 credit note.
 *
 * `unrecordableReason` is set when that identity cannot be established (or does not carry the rate the
 * customer was charged). The target cannot be allocated to until it is fixed, and the reason names the
 * fix — this is the same refusal the server action raises, surfaced before the operator types anything.
 */
export type RefundParkAllocationTarget = {
  /** The order line, or null for the order's shipping charge. */
  lineId: string | null
  kind: 'sale' | 'shipping'
  description: string
  sku: string | null
  taxRateName: string | null
  /** A fraction, e.g. "0.2" for 20%. The rate the credit note will post at. */
  vatRate: string
  /** Still refundable on this target, after any earlier refunds — net, and the gross that implies. */
  remainingNetForeign: string
  remainingGrossForeign: string
  /** Why this target cannot be allocated to, or null when it can. */
  unrecordableReason: string | null
}

export type RefundSyncParkRow = {
  id: string
  status: string
  externalRefundId: string | null
  orderId: string | null
  orderNumber: string | null
  /**
   * o3d-54p: the WooCommerce order this park's IMS order is linked to, or null when it has no link.
   * Shown because a cross-order park is only recognisable by comparing the refund against the order
   * it claims to belong to — and because a park whose order has NO WooCommerce link cannot be
   * dismissed (the dismissal is verified against that order's own refund list), so the control has
   * to be able to say so before it is clicked rather than after.
   */
  wcOrderId: string | null
  errorMessage: string | null
  createdAt: string
  /**
   * o3d-w00 (Codex r1 #3): everything the Record-manually completion path needs, so a QUARANTINED park
   * has a route to resolution instead of only a Retry that re-runs the decision that refused it.
   *
   * Codex r2 #2: `refundGrossForeign` is the figure the allocation is RECONCILED to, not a hint. Null
   * means the park predates the payload being retained, and then the path is closed — with a remedy that
   * opens it: Retry re-reads the refund from WooCommerce and re-parks it with the payload.
   */
  manuallyRecordable: boolean
  currency: string | null
  refundGrossForeign: string | null
  allocationTargets: RefundParkAllocationTarget[]
}

export type StuckDispatchRow = {
  orderId: string
  orderNumber: string | null
  externalOrderNumber: string | null
  connector: string
  failureCount: number
  reason: string | null
  deadLetteredAt: string | null
  /**
   * o3d-bjc.9: WHY the link left the sweep. 'dead-letter' — the reconcile kept
   * ERRORING (transport, apply). 'unresolved' — the WMS answered but its record
   * could not be turned into a dispatch state, so the link was quarantined to
   * stop it pinning the delta watermark. Different causes, same remedy here:
   * fix it in the WMS, then replay.
   */
  kind: 'dead-letter' | 'unresolved'
  /** o3d-rbyg round 2: the order's lifecycle status — which remedy applies depends on it. */
  orderStatus: string
  /** o3d-rbyg round 2: a withdrawal stands against this order, so Replay is NOT the remedy. */
  withdrawalStanding: boolean
}

export type ProductStructureConflictRow = {
  id: string
  /** The IMS product the WooCommerce object was paired with. */
  productId: string | null
  sku: string | null
  productName: string | null
  productType: string | null
  /** The WooCommerce product id. */
  externalProductId: string | null
  detail: string | null
  foundAt: string
}

export type OrderReconcileDriftRow = {
  orderId: string
  orderNumber: string | null
  externalOrderNumber: string | null
  category: string
  detail: string | null
  foundAt: string | null
}

/**
 * o3d-bjc.12: a CONNECTOR-level exception, not an order-level one.
 *
 * The dispatch sweep will not mass-quarantine a cohort it cannot prove is
 * record-local — with no healthy control, "these records are broken" and "this
 * connector is broken" look identical, and guessing takes a tenant out of sync
 * for a fault one fix would clear. It holds the cursor and alerts instead. This
 * row is how that decision reaches a human who CAN tell the difference.
 */
export type UnresolvedDriftRow = {
  connector: string
  /** Binds a click to the cohort the page actually showed (o3d-bjc.12). */
  version: string
  linkCount: number
  touched: number
  consecutivePasses: number
  stableFor: number
  firstSeenAt: string | null
  reason: string | null
  /**
   * The orders Isolate would quarantine, capped for rendering
   * (DRIFT_COHORT_PREVIEW_LIMIT). `eligibleCount` is the true size — when the
   * two differ the page says so, because the action takes ALL of them.
   */
  orders: { linkId: string; orderNumber: string | null; externalOrderNumber: string | null }[]
  /** Digest of the COMPLETE eligible set — what Isolate actually writes (o3d-0gzr). */
  eligibleVersion: string
  eligibleCount: number
}

export type ExceptionInboxSummary = {
  /**
   * o3d-hl8l r5: a held maintenance window, and/or a booked-in re-check that a closed one still
   * owes. Counted in the inbox total because a refusal nobody can see is a silent failure, and
   * these are the only surface a refused warehouse callback has.
   */
  maintenanceRecovery: number
  wmsPushDeadLetters: number
  outboxFailures: number
  deadReceiptEvents: number
  refundSyncParks: number
  stuckDispatches: number
  pennyMismatches: number
  orderReconcileDrift: number
  productStructureConflicts: number
  unresolvedDrift: number
  total: number
}

export type ExceptionInboxData = {
  summary: ExceptionInboxSummary
  maintenanceRecovery: MaintenanceRecoveryState
  wmsPushDeadLetters: WmsPushDeadLetterRow[]
  outboxFailures: OutboxFailureRow[]
  deadReceiptEvents: DeadReceiptEventRow[]
  refundSyncParks: RefundSyncParkRow[]
  stuckDispatches: StuckDispatchRow[]
  pennyMismatches: PennyMismatchRow[]
  orderReconcileDrift: OrderReconcileDriftRow[]
  productStructureConflicts: ProductStructureConflictRow[]
  unresolvedDrift: UnresolvedDriftRow[]
}

// Codex r4: only PERMANENT_FAILED rows are actionable exceptions — a
// RETRYABLE_FAILED row is still on the processor's automatic retry ladder and
// either recovers or lands here as PERMANENT_FAILED. Listing mid-backoff rows
// would surface self-resolving noise, and "acknowledging" them (flipping to
// PERMANENT_FAILED) would not have removed them from this same list.
const OUTBOX_FAILURE_STATUSES = [
  INTEGRATION_OUTBOX_STATUS.PERMANENT_FAILED,
]

// Codex P2: order-import writes FROM_CONNECTOR/SalesOrder rows too (failed
// imports have NO entityId; the missing-FX queue rows have NO entityId and a
// payload.reason marker). Refund-sync rows always carry entityId = the IMS
// order id, so require it — and exclude the FX-queue marker defensively so a
// future entityId-carrying FX row can never be "retried" as a refund. The
// exclusion must explicitly admit SQL-NULL payloads (refund-sync's FAILED rows
// carry none): a JSON-path NOT predicate silently drops NULL rows.
const REFUND_PARK_WHERE = {
  connector: 'woocommerce',
  direction: 'FROM_CONNECTOR' as const,
  entityType: 'SalesOrder',
  // QUARANTINED (o3d-w00 #2/#5 / o3d-iup): a monetary-only refund deliberately parked because the order
  // isn't uniformly taxed. It has no SalesOrderRefund and the sweep skips it, so the exception inbox is
  // the ONLY way an operator sees and recovers it — it must appear here alongside PENDING/FAILED.
  status: { in: ['PENDING' as const, 'FAILED' as const, 'QUARANTINED' as const] },
  entityId: { not: null },
  OR: [
    { payload: { equals: Prisma.DbNull } },
    { NOT: { payload: { path: ['reason'], equals: 'missing_fx_rate' } } },
  ],
}

/**
 * Stuck dispatch reconciliations have no first-class entity (dispatch-sweep.ts
 * "re-errors each run"): derive them from the error logs of the most recent
 * finished DISPATCH_SYNC sweep. Anything listed here failed on the latest run
 * and will keep failing until an operator intervenes.
 */
// 6oyu.2: stuck dispatches are now first-class — the dispatch sweep dead-letters
// a link after DISPATCH_MAX_CONSECUTIVE_FAILURES consecutive reconcile errors
// (dispatchDeadLetteredAt set, link leaves the sweep's candidate set).
// Scoped to the sweep's own candidate states (Codex r4): a link that later goes
// HELD/CANCELLED/push-DEAD_LETTER is no longer a dispatch question — those
// surface through their own flows — so it must not linger here as an exception.
// o3d-bjc.9: a QUARANTINED link belongs here for the same reason a dead-lettered
// one does — it has left the sweep and only an operator can bring it back. It was
// missing, and the quarantine notification points at this page, so the advertised
// workflow simply did not exist for it.
const STUCK_DISPATCH_STATES = {
  state: { in: ['SYNCED' as const, 'MERGED' as const] },
}

const STUCK_DISPATCH_WHERE = {
  ...STUCK_DISPATCH_STATES,
  OR: [
    { dispatchDeadLetteredAt: { not: null } },
    { dispatchUnresolvedAt: { not: null } },
  ],
}

function countStuckDispatches(): Promise<number> {
  return db.wmsOrderPushLink.count({ where: STUCK_DISPATCH_WHERE })
}

async function loadStuckDispatches(): Promise<StuckDispatchRow[]> {
  // Two queries, each capped, then merged and re-capped on the EFFECTIVE held
  // timestamp. A single ordered query cannot do this: sorting by
  // dispatchDeadLetteredAt first puts every dead letter ahead of every
  // unresolved-only row (nulls last), so 50 existing dead letters would hide
  // every new quarantine from the page its own notification links to.
  const select = {
    orderId: true,
    connector: true,
    externalOrderNumber: true,
    dispatchFailureCount: true,
    dispatchLastError: true,
    dispatchDeadLetteredAt: true,
    dispatchUnresolvedCount: true,
    dispatchUnresolvedError: true,
    dispatchUnresolvedAt: true,
    order: { select: { orderNumber: true, status: true } },
  } as const

  const [deadLettered, quarantined] = await Promise.all([
    db.wmsOrderPushLink.findMany({
      where: { ...STUCK_DISPATCH_STATES, dispatchDeadLetteredAt: { not: null } },
      orderBy: { dispatchDeadLetteredAt: 'desc' },
      take: SECTION_LIMIT,
      select,
    }),
    db.wmsOrderPushLink.findMany({
      // Dead-lettered rows are reported by the query above (the dead-letter is
      // the stronger statement), so exclude them here rather than de-duplicating.
      where: { ...STUCK_DISPATCH_STATES, dispatchUnresolvedAt: { not: null }, dispatchDeadLetteredAt: null },
      orderBy: { dispatchUnresolvedAt: 'desc' },
      take: SECTION_LIMIT,
      select,
    }),
  ])

  const rows = mergeStuckDispatchRows([...deadLettered, ...quarantined], SECTION_LIMIT)

  // o3d-rbyg round 2, Codex finding 3: say WHY, and only then can the page offer the right remedy.
  //
  // A link parked by the withdrawal fence looks exactly like a link parked by five failed
  // reconciles, and the one action on offer — Replay — is the wrong one for it: the screen still
  // sees the withdrawal, so a replay re-parks it, for ever. Screened through the SAME local
  // evidence the sweep's fence reads, so the page cannot claim a reason the fence would not.
  const { screenLocalWithdrawalEvidence } = await import('@/lib/connectors/woocommerce/sync/withdrawal')
  const standing = await screenLocalWithdrawalEvidence(rows.map((row) => row.orderId))
  return rows.map((row) => (standing.has(row.orderId) ? { ...row, withdrawalStanding: true } : row))
}

/**
 * o3d-y89x / o3d-fjqk: a WooCommerce product and its IMS twin DISAGREE about the row's shape,
 * so part of the payload could not be applied. One rule, both directions (o3d-y89x r3):
 *
 *   - WooCommerce says VARIABLE and the IMS row cannot be a parent (a KIT, a row that is
 *     itself somebody's child, a live row the editor would refuse to transform): the
 *     variations exist nowhere in IMS;
 *   - WooCommerce says SIMPLE and the IMS row is a VARIABLE parent: its type and price go
 *     unwritten and its IMS variants stay standing;
 *   - or a single variation SKU resolves to an IMS row belonging to a different parent.
 *
 * The connector refuses to flatten the IMS side in every case, because the structure it would
 * destroy is IMS-owned and WooCommerce never asked for it to go. An IMS KIT paired with a
 * WooCommerce SIMPLE product is NOT here: both sides agree the row is not a parent, so nothing
 * went unapplied and that ordinary bundle pairing stays silent.
 *
 * Written by the product sync itself, deduplicated to ONE open row per pairing, and DELETED
 * by the next sync that completes cleanly — so this list is live rather than a log, and the
 * rows need no acknowledge action: resolving the conflict is what removes them. The product
 * reconcile cursor does not advance past a conflicted product, so the retry is automatic.
 */
const PRODUCT_STRUCTURE_CONFLICT_WHERE = {
  connector: 'woocommerce',
  direction: 'FROM_CONNECTOR' as const,
  entityType: 'Product',
  status: 'QUARANTINED' as const,
}

function countProductStructureConflicts(): Promise<number> {
  return db.shoppingSyncLog.count({ where: PRODUCT_STRUCTURE_CONFLICT_WHERE })
}

async function loadProductStructureConflicts(): Promise<ProductStructureConflictRow[]> {
  const rows = await db.shoppingSyncLog.findMany({
    where: PRODUCT_STRUCTURE_CONFLICT_WHERE,
    orderBy: { createdAt: 'desc' },
    take: SECTION_LIMIT,
    select: { id: true, entityId: true, externalId: true, errorMessage: true, createdAt: true },
  })

  const productIds = rows.map((row) => row.entityId).filter((id): id is string => Boolean(id))
  const products = productIds.length > 0
    ? await db.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, sku: true, name: true, type: true },
      })
    : []
  const productById = new Map(products.map((product) => [product.id, product]))

  return rows.map((row) => {
    const product = row.entityId ? productById.get(row.entityId) : undefined
    return {
      id: row.id,
      productId: row.entityId,
      sku: product?.sku ?? null,
      productName: product?.name ?? null,
      productType: product?.type ?? null,
      externalProductId: row.externalId,
      detail: row.errorMessage,
      foundAt: row.createdAt.toISOString(),
    }
  })
}

/**
 * q66in.4.4: drift findings are DURABLE wms_order_discrepancies rows — the
 * capped sweep upserts them and resolves a row only when that specific order
 * re-verifies clean, so a newer (necessarily partial) run never clears truth.
 */
const ORDER_DRIFT_WHERE = { status: 'OPEN' }

function countOrderReconcileDrift(): Promise<number> {
  return db.wmsOrderDiscrepancy.count({ where: ORDER_DRIFT_WHERE })
}

async function loadOrderReconcileDrift(): Promise<OrderReconcileDriftRow[]> {
  const rows = await db.wmsOrderDiscrepancy.findMany({
    where: ORDER_DRIFT_WHERE,
    orderBy: [{ category: 'asc' }, { firstSeenAt: 'asc' }],
    take: SECTION_LIMIT,
    select: {
      orderId: true,
      category: true,
      detail: true,
      externalOrderNumber: true,
      lastSeenAt: true,
      order: { select: { orderNumber: true } },
    },
  })
  return rows.map((row) => ({
    orderId: row.orderId,
    orderNumber: row.order.orderNumber,
    externalOrderNumber: row.externalOrderNumber,
    category: row.category,
    detail: row.detail,
    foundAt: row.lastSeenAt.toISOString(),
  }))
}

/**
 * o3d-hl8l r5: the maintenance-recovery state, read unlocked because this is a render. Both actions
 * re-read every one of these rows `FOR UPDATE` before acting, so a stale page can only ever cause a
 * refusal — never a wrong write.
 */
async function loadMaintenanceRecoveryState(): Promise<MaintenanceRecoveryState> {
  const rows = await db.setting.findMany({
    where: { key: { in: [MAINTENANCE_ENABLED_KEY, MAINTENANCE_HOLD_KEY, WMS_BOOKED_IN_RECHECK_DUE_KEY] } },
    select: { key: true, value: true },
  })
  return buildMaintenanceRecoveryState(new Map(rows.map((row) => [row.key, row.value])))
}

/** True per-source totals — never capped by the display limit (Codex r3/r5). */
async function loadExceptionCounts(): Promise<ExceptionInboxSummary> {
  const [wmsPushDeadLetters, outboxFailures, deadReceipts, deadWebhooks, refundSyncParks, pennyMismatches, stuckDispatches, orderReconcileDrift, productStructureConflicts, driftIncidents] = await Promise.all([
    db.wmsOrderPushLink.count({ where: { state: 'DEAD_LETTER' } }),
    db.integrationOutbox.count({ where: { status: { in: OUTBOX_FAILURE_STATUSES } } }),
    db.wmsInboundReceiptEvent.count({ where: { processingStatus: DEAD_RECEIPT_EVENT_STATUS } }),
    db.wmsWebhookEvent.count({ where: { processingStatus: DEAD_RECEIPT_EVENT_STATUS } }),
    db.shoppingSyncLog.count({ where: REFUND_PARK_WHERE }),
    db.wmsOrderPushLink.count({ where: { totalMismatchPence: { not: null } } }),
    countStuckDispatches(),
    countOrderReconcileDrift(),
    countProductStructureConflicts(),
    // Only the ACTIVE connector: a disabled one's leftover incident is not
    // blocking anything, and showing it would invite an isolate on stale
    // evidence (o3d-bjc.12).
    getEnabledWmsConnectorId().then((id) => (id ? loadUnresolvedDriftIncidents([id]) : [])),
  ])

  const maintenanceRecovery = countMaintenanceRecovery(await loadMaintenanceRecoveryState())
  const deadReceiptEvents = deadReceipts + deadWebhooks
  return {
    maintenanceRecovery,
    wmsPushDeadLetters,
    outboxFailures,
    deadReceiptEvents,
    refundSyncParks,
    stuckDispatches,
    pennyMismatches,
    orderReconcileDrift,
    productStructureConflicts,
    unresolvedDrift: driftIncidents.length,
    total: maintenanceRecovery + wmsPushDeadLetters + outboxFailures + deadReceiptEvents + refundSyncParks
      + stuckDispatches + pennyMismatches + orderReconcileDrift + productStructureConflicts + driftIncidents.length,
  }
}

export async function getExceptionInboxSummary(): Promise<ExceptionInboxSummary> {
  // Codex P1: failure rows carry order ids, connector errors and refund ids —
  // gate reads on the sync permission (READONLY/SUPPLIER must not see them).
  //
  // The /sync banner loader no longer swallows this into a hidden banner: /sync now requires
  // `sync` at the page boundary, so a role without it never gets here, and a denial that DID
  // reach the page is fatal there rather than being rendered as an unavailable panel.
  await requirePermission('sync')
  return loadExceptionCounts()
}

/**
 * o3d-w00 (Codex r1 #3 / r2 #2): the gross amount of the parked WooCommerce refund, read out of the
 * stored payload. This is the figure the hand-recorded allocation is RECONCILED to — the operator's
 * amounts are gross and must add up to it — not merely a hint displayed alongside. Returns null for a
 * park with no payload rather than guessing a number; the action then refuses and points at Retry,
 * which re-reads the refund from WooCommerce and re-parks it with the payload.
 */
function readParkedRefundGross(payload: unknown): string | null {
  if (payload == null || typeof payload !== 'object') return null
  const amount = (payload as { amount?: unknown }).amount
  if (typeof amount === 'string' && amount.trim()) return amount.trim()
  if (typeof amount === 'number' && Number.isFinite(amount)) return String(amount)
  return null
}

/**
 * o3d-w00 (Codex r7 #3): the UNITS the parked WooCommerce refund returned, keyed by the ORDER line item
 * they came off.
 *
 * A quarantine stops the refund BEFORE `createRefund`, so the restock the itemised route would have
 * performed never happens — and until now the Record-manually path that resolves the quarantine sent
 * `qty: 0` for every allocation and no return warehouse, so the units were not merely un-restocked but
 * unrecorded: nothing on the refund, nothing in the activity log, no way to find them afterwards. The
 * refusal was therefore not a refusal at all for the inventory half of the refund, it was a silent
 * write-off — and it now happens on more refunds, because the posted-VAT fence quarantines itemised
 * refunds, which are exactly the ones that carry quantities.
 *
 * The payload is the refund WooCommerce sent, so the quantities are read from it rather than typed in:
 * they are the same figures the automatic route would have restocked (`refundedOrderLineId` resolves
 * the `_refunded_item_id` meta, since Woo mints a fresh item id per refund line). The operator still
 * attributes the MONEY; the units are a fact of the payload, not an opinion.
 */
function readParkedRefundedQuantities(payload: unknown): Map<number, number> {
  const quantities = new Map<number, number>()
  if (payload == null || typeof payload !== 'object') return quantities
  const lineItems = (payload as { line_items?: unknown }).line_items
  if (!Array.isArray(lineItems)) return quantities
  for (const lineItem of lineItems) {
    if (lineItem == null || typeof lineItem !== 'object') continue
    const quantity = Math.abs(Number((lineItem as { quantity?: unknown }).quantity ?? 0))
    if (!Number.isFinite(quantity) || quantity <= 0) continue
    const orderLineId = refundedOrderLineId(lineItem as WcRefundLineItem)
    if (!Number.isFinite(orderLineId) || orderLineId <= 0) continue
    quantities.set(orderLineId, (quantities.get(orderLineId) ?? 0) + quantity)
  }
  return quantities
}

export async function getExceptionInboxData(): Promise<ExceptionInboxData> {
  await requirePermission('sync')

  const counts = await loadExceptionCounts()
  const [pushLinks, outbox, deadReceiptRows, deadWebhookRows, refundLogs, stuckDispatches, mismatchLinks, orderReconcileDrift, productStructureConflicts, driftIncidents] = await Promise.all([
    db.wmsOrderPushLink.findMany({
      where: { state: 'DEAD_LETTER' },
      orderBy: { lastAttemptAt: 'desc' },
      take: SECTION_LIMIT,
      select: {
        orderId: true,
        connector: true,
        attempts: true,
        lastError: true,
        lastAttemptAt: true,
        order: { select: { orderNumber: true } },
      },
    }),
    // The admin list filter takes a single status, so query each failure status
    // and merge — filtering one mixed recent page would hide failures older
    // than the newest 50 rows of ANY status.
    Promise.all(OUTBOX_FAILURE_STATUSES.map((status) => listIntegrationOutboxAdminRows({ status, limit: SECTION_LIMIT })))
      .then((results) => results
        .flatMap((result) => result.rows)
        .sort((left, right) => new Date(right.updatedAt as never).getTime() - new Date(left.updatedAt as never).getTime())
        .slice(0, SECTION_LIMIT)),
    db.wmsInboundReceiptEvent.findMany({
      where: { processingStatus: DEAD_RECEIPT_EVENT_STATUS },
      orderBy: { deadLetteredAt: 'desc' },
      take: SECTION_LIMIT,
      select: {
        id: true,
        connector: true,
        externalEventId: true,
        externalAsnId: true,
        processingAttempts: true,
        lastError: true,
        deadLetteredAt: true,
      },
    }),
    // Codex r5: order/inventory webhooks dead-letter in their own table
    // (wms_webhook_events) with the same retry machinery — include them.
    db.wmsWebhookEvent.findMany({
      where: { processingStatus: DEAD_RECEIPT_EVENT_STATUS },
      orderBy: { deadLetteredAt: 'desc' },
      take: SECTION_LIMIT,
      select: {
        id: true,
        connector: true,
        eventType: true,
        externalEventId: true,
        processingAttempts: true,
        lastError: true,
        deadLetteredAt: true,
      },
    }),
    db.shoppingSyncLog.findMany({
      where: REFUND_PARK_WHERE,
      orderBy: { createdAt: 'desc' },
      take: SECTION_LIMIT,
      select: {
        id: true,
        status: true,
        entityId: true,
        externalId: true,
        errorMessage: true,
        createdAt: true,
        // o3d-w00 (Codex r1 #3): the parked WcRefund. Its gross `amount` is what the operator has to
        // allocate across the order lines in the Record-manually path.
        payload: true,
      },
    }),
    loadStuckDispatches(),
    db.wmsOrderPushLink.findMany({
      where: { totalMismatchPence: { not: null } },
      orderBy: { lastAttemptAt: 'desc' },
      take: SECTION_LIMIT,
      select: {
        orderId: true,
        connector: true,
        totalMismatchPence: true,
        externalOrderNumber: true,
        order: { select: { orderNumber: true } },
      },
    }),
    loadOrderReconcileDrift(),
    loadProductStructureConflicts(),
    // Only the ACTIVE connector: a disabled one's leftover incident is not
    // blocking anything, and showing it would invite an isolate on stale
    // evidence (o3d-bjc.12).
    getEnabledWmsConnectorId().then((id) => (id ? loadUnresolvedDriftIncidents([id]) : [])),
  ])

  const refundOrderIds = refundLogs.map((log) => log.entityId).filter((id): id is string => Boolean(id))
  // o3d-w00 (Codex r1 #3 / r2 #3): the QUARANTINED rows are the ones with no automatic route out, so they
  // carry everything the Record-manually dialog needs to describe the refund — the order's LINES and its
  // SHIPPING charge, each with the VAT rate its credit will be posted at and what is left to refund on
  // it. A refund attributed to the real parts of the order is exactly what both refusals (undeterminable
  // basis, non-uniform tax) are waiting for.
  const [refundOrders, priorRefundLines, postingTaxContext] = await Promise.all([
    refundOrderIds.length > 0
      ? db.salesOrder.findMany({
          where: { id: { in: refundOrderIds } },
          select: {
            id: true,
            orderNumber: true,
            currency: true,
            taxRateName: true,
            shippingForeign: true,
            shippingService: true,
            // Codex r6 #3: WHO wrote this order's totals. A WooCommerce-imported order is created with
            // its ShoppingOrderLink in the same write, and its taxForeign is the plain sum of the
            // component VAT figures — nothing is netted off it for an order-level discount, the way
            // createSalesOrder does. Without this the shipping derivation refused every WC order
            // carrying an unallocated coupon residual.
            shoppingLinks: { select: { connector: true } },
            // o3d-w00 (Codex r5 #1): shipping's CHARGED rate is derived from the order's own money —
            // the VAT it records over and above its lines, on the net shipping charge. taxRatePercent
            // is deliberately NOT read: it is the order's header default, which is shipping's rate only
            // on a uniformly taxed order. discountAmount is read because an order-level discount's VAT
            // is netted off the same total and would otherwise be mistaken for shipping's.
            taxForeign: true,
            discountAmount: true,
            lines: {
              select: {
                id: true,
                description: true,
                sku: true,
                // The line's own money snapshot: the NET it was sold at and the VAT taken on it. Codex
                // r4 #1 — this, not the live TaxRate.rate, is what the line was CHARGED at.
                totalForeign: true,
                taxForeign: true,
                // accountingTaxType (o3d-w00 Codex r3 #1): the identity the credit note posts under, and
                // therefore the rate the operator's gross is really converted at. `rate` is deliberately
                // NOT read — it is today's rate, not the one this order was billed under.
                taxRate: { select: { name: true, reverseCharge: true, accountingTaxType: true } },
              },
            },
          },
        })
      : Promise.resolve([]),
    // What each part of the order has ALREADY been credited, so the dialog offers what is left rather
    // than the original amount — and the action refuses anything above it.
    refundOrderIds.length > 0
      ? db.salesOrderRefundLine.findMany({
          where: { refund: { orderId: { in: refundOrderIds } } },
          select: { salesOrderLineId: true, lineKind: true, totalForeign: true, refund: { select: { orderId: true } } },
        })
      : Promise.resolve([]),
    loadRefundPostingTaxContext(),
  ])
  const refundOrderById = new Map(refundOrders.map((order) => [order.id, order]))
  // o3d-54p: which WooCommerce order each parked order is linked to. Read for the whole page in one
  // query rather than per row.
  const refundOrderLinks = refundOrderIds.length > 0
    ? await db.shoppingOrderLink.findMany({
        where: { connector: 'woocommerce', orderId: { in: refundOrderIds } },
        select: { orderId: true, externalOrderId: true },
      })
    : []
  const wcOrderIdByOrderId = new Map(refundOrderLinks.map((link) => [link.orderId, link.externalOrderId]))
  const priorRefundedByLineId = new Map<string, Decimal>()
  const priorRefundedShippingByOrderId = new Map<string, Decimal>()
  for (const refundLine of priorRefundLines) {
    if (refundLine.salesOrderLineId) {
      priorRefundedByLineId.set(
        refundLine.salesOrderLineId,
        (priorRefundedByLineId.get(refundLine.salesOrderLineId) ?? toDecimal(0)).add(toDecimal(refundLine.totalForeign)),
      )
    } else if (refundLine.lineKind === 'shipping') {
      const orderId = refundLine.refund.orderId
      priorRefundedShippingByOrderId.set(
        orderId,
        (priorRefundedShippingByOrderId.get(orderId) ?? toDecimal(0)).add(toDecimal(refundLine.totalForeign)),
      )
    }
  }
  const buildAllocationTargets = (order: typeof refundOrders[number] | undefined): RefundParkAllocationTarget[] => {
    if (!order) return []
    // The order-default identity, resolved exactly as createSalesOrderRefund resolves it: the ACTIVE
    // TaxRate named on the order. A deactivated/renamed default leaves shipping with no identity at all,
    // which is a refusal, not a zero.
    const orderDefaultTaxType = order.taxRateName
      ? postingTaxContext.activeTaxTypeByName.get(order.taxRateName) ?? null
      : null
    // The identity an UNLINKED sale amount posts under — what refund-service falls back to for a line
    // with no TaxRate row of its own (Codex r4 #2). Resolved from the whole order, once.
    const orderUniform = resolveOrderUniformTaxIdentity({
      lines: order.lines,
      reverseChargeSalesTaxType: postingTaxContext.reverseChargeSalesTaxType,
    })
    // What the ORDER says its shipping leg was charged (Codex r5 #1): the net shipping charge, and the
    // VAT the order records over and above every one of its lines. IMS has no shipping-VAT column.
    const chargedShipping = {
      currency: order.currency,
      netForeign: order.shippingForeign,
      orderTaxForeign: order.taxForeign,
      lineTaxForeign: order.lines.map((line) => line.taxForeign),
      orderDiscountAmount: order.discountAmount,
      orderTaxIsSumOfComponents: orderTaxIsSumOfComponents(order.shoppingLinks),
    }
    const targets: RefundParkAllocationTarget[] = order.lines.map((line) => {
      // o3d-w00 (Codex r3 #1): the rate the credit note will RE-GROSS this line at, resolved from the
      // accounting tax identity it will post under — NOT the line's nominal TaxRate.rate. Where the two
      // disagree (an unmapped line rate falling back to the order default, an unconfigured reverse-charge
      // swap) the target is refused rather than shown a rate that will not be used.
      const identity = resolvePostedRefundTaxIdentity({
        kind: 'sale',
        lineTaxRate: line.taxRate,
        chargedLine: { currency: order.currency, netForeign: line.totalForeign, taxForeign: line.taxForeign },
        orderDefaultTaxType,
        orderUniform,
        reverseChargeSalesTaxType: postingTaxContext.reverseChargeSalesTaxType,
        rateByTaxType: postingTaxContext.rateByTaxType,
        label: line.description || `line ${line.id}`,
      })
      // Unresolvable: show what the customer was charged — read off the line's OWN money (Codex r4 #1),
      // so the row still reads truthfully — and say why it cannot be allocated to.
      const vatRate = identity.ok
        ? identity.vatRate
        : (chargedRateFromLineSnapshot({ currency: order.currency, netForeign: line.totalForeign, taxForeign: line.taxForeign }) ?? toDecimal(0))
      const remainingNet = toDecimal(line.totalForeign).sub(priorRefundedByLineId.get(line.id) ?? toDecimal(0))
      return {
        lineId: line.id,
        kind: 'sale' as const,
        description: line.description,
        sku: line.sku,
        taxRateName: line.taxRate?.name ?? null,
        vatRate: vatRate.toString(),
        remainingNetForeign: remainingNet.toFixed(2),
        remainingGrossForeign: remainingNet.mul(toDecimal(1).add(vatRate)).toFixed(2),
        unrecordableReason: identity.ok ? null : identity.reason,
      }
    })
    const shippingForeign = toDecimal(order.shippingForeign)
    if (shippingForeign.gt(0)) {
      // An unlinked shipping refund line is posted under the ORDER-DEFAULT VAT identity (refund-service
      // resolveRefundLineTaxIdentity), the same identity the invoice charged shipping under — so that is
      // the rate the operator's gross must be converted at, whatever the goods lines carry.
      const identity = resolvePostedRefundTaxIdentity({
        kind: 'shipping',
        orderDefaultTaxType,
        chargedShipping,
        reverseChargeSalesTaxType: postingTaxContext.reverseChargeSalesTaxType,
        rateByTaxType: postingTaxContext.rateByTaxType,
        label: 'Shipping',
      })
      // Unresolvable: show what the ORDER says shipping was charged (Codex r5 #1), not the order's
      // header default rate — a different figure whenever shipping was taxed unlike the goods.
      const vatRate = identity.ok
        ? identity.vatRate
        : (chargedRateFromShippingSnapshot(chargedShipping) ?? toDecimal(0))
      const remainingNet = shippingForeign.sub(priorRefundedShippingByOrderId.get(order.id) ?? toDecimal(0))
      targets.push({
        lineId: null,
        kind: 'shipping',
        description: order.shippingService ? `Shipping — ${order.shippingService}` : 'Shipping',
        sku: null,
        taxRateName: order.taxRateName ?? null,
        vatRate: vatRate.toString(),
        remainingNetForeign: remainingNet.toFixed(2),
        remainingGrossForeign: remainingNet.mul(toDecimal(1).add(vatRate)).toFixed(2),
        unrecordableReason: identity.ok ? null : identity.reason,
      })
    }
    return targets
  }

  // The cohort's orders, for the operator to review before isolating (o3d-51du).
  // Read through the same eligibility predicate the isolate action writes
  // through, so the list is what WOULD be quarantined rather than what the sweep
  // happened to record on an earlier pass.
  const driftCohortOrders = new Map<string, { linkId: string; orderNumber: string | null; externalOrderNumber: string | null }[]>()
  const driftCohortDigests = new Map<string, string>()
  const driftCohortEligible = new Map<string, number>()
  for (const incident of driftIncidents) {
    // The digest covers the WHOLE eligible set; the rendered list is bounded
    // (o3d-0gzr r3). These are different jobs. Binding must be complete or the
    // action is not bound to what it does; rendering must be bounded or the very
    // failure this page exists to recover from — a connector-wide outage, so
    // potentially every open order — makes the page that recovers it unusable.
    // So: ids for the digest (cheap, unbounded), rows for display (capped, and
    // the page says when it capped).
    const eligibleIds = await db.wmsOrderPushLink.findMany({
      where: isolatableLinkWhere(incident),
      select: { id: true },
      orderBy: { pushedAt: 'asc' },
    })
    driftCohortDigests.set(incident.connector, eligibleCohortDigest(eligibleIds.map((row) => row.id)))
    driftCohortEligible.set(incident.connector, eligibleIds.length)

    const links = await db.wmsOrderPushLink.findMany({
      where: { id: { in: eligibleIds.slice(0, DRIFT_COHORT_PREVIEW_LIMIT).map((row) => row.id) } },
      select: { id: true, externalOrderNumber: true, order: { select: { orderNumber: true } } },
      orderBy: { pushedAt: 'asc' },
    })
    driftCohortOrders.set(
      incident.connector,
      links.map((link) => ({
        linkId: link.id,
        orderNumber: link.order.orderNumber,
        externalOrderNumber: link.externalOrderNumber,
      })),
    )
  }

  const data: Omit<ExceptionInboxData, 'summary' | 'maintenanceRecovery'> = {
    wmsPushDeadLetters: pushLinks.map((link) => ({
      orderId: link.orderId,
      orderNumber: link.order.orderNumber,
      connector: link.connector,
      attempts: link.attempts,
      lastError: link.lastError,
      lastAttemptAt: link.lastAttemptAt?.toISOString() ?? null,
    })),
    outboxFailures: outbox.map((row) => ({
      id: row.id,
      connector: row.connector,
      operation: row.operation,
      status: row.status,
      attempts: row.attempts,
      lastError: row.lastError,
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
    })),
    deadReceiptEvents: [
      ...deadReceiptRows.map((event) => ({
        id: event.id,
        connector: event.connector,
        kind: 'booked-in' as const,
        externalEventId: event.externalEventId,
        reference: event.externalAsnId,
        processingAttempts: event.processingAttempts,
        lastError: event.lastError,
        deadLetteredAt: event.deadLetteredAt?.toISOString() ?? null,
      })),
      ...deadWebhookRows.map((event) => ({
        id: event.id,
        connector: event.connector,
        kind: 'webhook' as const,
        externalEventId: event.externalEventId,
        reference: event.eventType,
        processingAttempts: event.processingAttempts,
        lastError: event.lastError,
        deadLetteredAt: event.deadLetteredAt?.toISOString() ?? null,
      })),
    ]
      .sort((left, right) => (right.deadLetteredAt ?? '').localeCompare(left.deadLetteredAt ?? ''))
      .slice(0, SECTION_LIMIT),
    refundSyncParks: refundLogs.map((log) => {
      const order = log.entityId ? refundOrderById.get(log.entityId) : undefined
      const payloadAmount = readParkedRefundGross(log.payload)
      return {
        id: log.id,
        status: log.status,
        externalRefundId: log.externalId,
        orderId: log.entityId,
        orderNumber: order?.orderNumber ?? null,
        wcOrderId: log.entityId ? wcOrderIdByOrderId.get(log.entityId) ?? null : null,
        errorMessage: log.errorMessage,
        createdAt: log.createdAt.toISOString(),
        // Only a QUARANTINED park is a deliberate, non-retryable refusal. PENDING/FAILED rows are
        // ordinary retryable failures whose remedy is Retry (usually after fixing the amount in the
        // storefront) — offering a manual credit note for those would invite a duplicate.
        manuallyRecordable: log.status === 'QUARANTINED' && Boolean(log.entityId) && Boolean(log.externalId),
        currency: order?.currency ?? null,
        refundGrossForeign: payloadAmount,
        allocationTargets: buildAllocationTargets(order),
      }
    }),
    stuckDispatches,
    pennyMismatches: mismatchLinks.map((link) => ({
      orderId: link.orderId,
      orderNumber: link.order.orderNumber,
      connector: link.connector,
      totalMismatchPence: link.totalMismatchPence ?? 0,
      externalOrderNumber: link.externalOrderNumber,
    })),
    orderReconcileDrift,
    productStructureConflicts,
    unresolvedDrift: driftIncidents.map((incident) => ({
      connector: incident.connector,
      version: incident.version,
      linkCount: incident.linkCount,
      touched: incident.touched,
      consecutivePasses: incident.consecutivePasses,
      stableFor: incident.stableFor,
      firstSeenAt: incident.firstSeenAt,
      reason: incident.reason,
      // WHICH orders (o3d-51du). The digest guarantees the operator acts on the
      // same set the page showed them — which is worth nothing if the page
      // showed only a count. Isolate is a bulk quarantine; the orders it will
      // take have to be on screen before it is clicked.
      orders: driftCohortOrders.get(incident.connector) ?? [],
      // What Isolate is bound to. `version` still guards the stored incident;
      // this guards the actual write set.
      eligibleVersion: driftCohortDigests.get(incident.connector) ?? eligibleCohortDigest([]),
      eligibleCount: driftCohortEligible.get(incident.connector) ?? 0,
    })),
  }

  return {
    ...data,
    maintenanceRecovery: await loadMaintenanceRecoveryState(),
    // Codex r5: real totals, not the capped list lengths — the client renders
    // "showing N of M" when a section is capped at SECTION_LIMIT.
    summary: counts,
  }
}

type MutationResult = { success: boolean; error?: string } | FreshAuthFailureResult

/**
 * Replay a failed integration-outbox row (accounting post / WC stock push /
 * booked-in / landed-cost journal). Resets to PENDING with the ORIGINAL payload
 * and idempotency key — the compare-and-set inside the domain transition 409s
 * if the row changed underneath the operator.
 */
export async function replayOutboxException(id: string): Promise<MutationResult> {
  try {
    const session = await requireFreshPermission('sync')
    const result = await replayIntegrationOutboxAdminRow({ id })
    await logActivity({
      entityType: 'SYNC',
      entityId: id,
      tag: 'sync',
      action: 'integration_outbox_replay',
      description: `Re-queued integration outbox row (${result.row.connector}/${result.row.operation}) from ${result.priorStatus} via the exception inbox`,
      metadata: { outboxId: id, priorStatus: result.priorStatus, priorLastError: result.priorLastError, userId: session.user.id },
    })
    revalidatePath('/sync/exceptions')
    return { success: true }
  } catch (error) {
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    if (error instanceof IntegrationOutboxAdminError) return { success: false, error: error.message }
    throw error
  }
}

/**
 * Replay a DEAD (retry-exhausted) inbound receipt event: compare-and-set back
 * to PENDING so the webhook sweeper re-processes it with the ORIGINAL payload
 * and externalEventId idempotency. Attempts reset so the retry ladder restarts.
 */
export async function replayDeadReceiptEvent(id: string): Promise<MutationResult> {
  try {
    const session = await requireFreshPermission('sync')
    const updated = await db.wmsInboundReceiptEvent.updateMany({
      where: buildDeadReceiptEventReplayWhere(id),
      data: buildDeadReceiptEventReplayData(),
    })
    if (updated.count === 0) {
      return { success: false, error: 'The receipt event is no longer dead-lettered (already replayed or processed).' }
    }
    await logActivity({
      entityType: 'SYNC',
      entityId: id,
      tag: 'sync',
      action: 'wms_receipt_event_replay',
      description: 'Re-queued a dead-lettered WMS receipt event via the exception inbox',
      metadata: { receiptEventId: id, userId: session.user.id },
    })
    revalidatePath('/sync/exceptions')
    return { success: true }
  } catch (error) {
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    throw error
  }
}

/**
 * Replay a DEAD order/inventory webhook event (wms_webhook_events): same
 * compare-and-set reset as the booked-in replay; the webhook sweeper
 * re-processes the ORIGINAL payload under its externalEventId idempotency, and
 * the monotonic status-rank guard makes a stale replay a no-op.
 */
export async function replayDeadWebhookEvent(id: string): Promise<MutationResult> {
  try {
    const session = await requireFreshPermission('sync')
    const updated = await db.wmsWebhookEvent.updateMany({
      where: buildDeadReceiptEventReplayWhere(id),
      data: buildDeadReceiptEventReplayData(),
    })
    if (updated.count === 0) {
      return { success: false, error: 'The webhook event is no longer dead-lettered (already replayed or processed).' }
    }
    await logActivity({
      entityType: 'SYNC',
      entityId: id,
      tag: 'sync',
      action: 'wms_webhook_event_replay',
      description: 'Re-queued a dead-lettered WMS webhook event via the exception inbox',
      metadata: { webhookEventId: id, userId: session.user.id },
    })
    revalidatePath('/sync/exceptions')
    return { success: true }
  } catch (error) {
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    throw error
  }
}

/**
 * Retry a parked WooCommerce refund-sync row by re-running refund sync for the
 * whole order — a FRESH fetch from WooCommerce (already-synced refunds dedupe by
 * externalRefundId), so a since-corrected refund now applies instead of
 * replaying the stale parked payload. The row is marked SYNCED only when the
 * specific refund verifiably landed.
 */
export async function retryRefundSyncPark(id: string): Promise<MutationResult & { synced?: boolean }> {
  try {
    const session = await requireFreshPermission('sync')
    const row = await db.shoppingSyncLog.findFirst({
      where: { id, ...REFUND_PARK_WHERE },
      // o3d-w00 (Codex r1 #3): status + errorMessage are read so a quarantine that this retry
      // temporarily downgraded can be RESTORED if the re-fetch never got as far as re-deciding it.
      select: { id: true, entityId: true, externalId: true, status: true, errorMessage: true },
    })
    if (!row || !row.entityId) {
      return { success: false, error: 'The sync log row is no longer pending (already resolved or removed).' }
    }

    const orderLink = await db.shoppingOrderLink.findFirst({
      where: { orderId: row.entityId, connector: 'woocommerce' },
      select: { externalOrderId: true },
    })
    if (!orderLink) {
      return { success: false, error: 'The order has no WooCommerce link, so its refunds cannot be re-fetched.' }
    }

    // o3d-w00 #2/#5 / o3d-iup: a QUARANTINED park makes the sweep dedup skip this refund. An explicit
    // operator retry must let the re-fetch re-attempt it — but we must NOT delete the park before the
    // fallible fetch, or a fetch error / a refund missing from the response would leave nothing behind and
    // strand the refund. Instead TRANSITION the quarantine to PENDING atomically: the row stays durable
    // and visible in the inbox, and PENDING is not skipped by the dedup, so the re-fetch re-attempts it.
    // The refund then lands (post-processing marks it SYNCED), or re-parks as a fresh QUARANTINED (the
    // duplicate-dedup below keeps exactly one), or — if the fetch fails — remains a visible PENDING park to
    // retry again. Scoped to this refund's externalId.
    // o3d-7yf: every refund lookup and park transition here MUST be scoped to THIS park's order
    // (entityId = row.entityId). externalRefundId is globally unique and the park index is keyed by
    // (connector, externalId), so an externalId-only query would let another order's refund resolve — and
    // erase — this order's park (and its deletion/rebind guard).
    if (row.externalId && row.entityId) {
      await db.shoppingSyncLog.updateMany({
        where: { ...REFUND_PARK_WHERE, externalId: row.externalId, entityId: row.entityId, status: 'QUARANTINED' },
        data: { status: 'PENDING' },
      })
    }

    const refundSweep = await syncRefundsForOrder(Number(orderLink.externalOrderId))

    const refundLanded = row.externalId
      ? await db.salesOrderRefund.findFirst({
          where: { externalRefundId: Number(row.externalId), orderId: row.entityId },
          select: { id: true },
        })
      : null

    // o3d-ecbj r5: "the refund did not land" is a statement about the STORE'S list, and a list read
    // only in part cannot make it. If the walk was short, the refund may simply be on a page nobody
    // read — so say the store could not be read completely rather than reporting a not-applied
    // outcome the operator would read as WooCommerce's answer. The park stays PENDING and visible,
    // so the retry button is still the whole recovery.
    if (!refundLanded && !refundSweep.complete) {
      return {
        success: false,
        error: `WooCommerce's refund list for that order could not be read in full (${refundSweep.error ?? 'unknown error'}), `
          + 'so this refund cannot be confirmed missing. The park is still open — retry it once the store responds.',
      }
    }

    if (refundLanded) {
      // Codex r6: repeated webhook deliveries can have parked the SAME refund
      // several times — resolve every park row for this refund AND this order, not just the
      // clicked one, so stale duplicates don't linger as actionable exceptions.
      await db.shoppingSyncLog.updateMany({
        where: row.externalId ? { ...REFUND_PARK_WHERE, externalId: row.externalId, entityId: row.entityId } : { id: row.id },
        data: { status: 'SYNCED', syncedAt: new Date(), errorMessage: null },
      })
    } else if (row.externalId) {
      // o3d-7yf: the refund did not land for THIS order. If a refund with this id exists on ANOTHER order,
      // this is a cross-order anomaly — fail closed WITHOUT resolving the clicked park with a foreign refund.
      const foreignRefund = await db.salesOrderRefund.findFirst({
        where: { externalRefundId: Number(row.externalId), orderId: { not: row.entityId } },
        select: { orderId: true },
      })
      if (foreignRefund) {
        return { success: false, error: `Refund ${row.externalId} belongs to a different order (${foreignRefund.orderId}); this park cannot be resolved by it.` }
      }
      // Codex P2: a still-failing retry re-parks the SAME refund as a fresh row
      // (refund-sync always creates). Keep only the newest park per refund+order —
      // delete the older duplicates so the inbox shows one actionable row with
      // the current error instead of accumulating copies on every retry.
      const parks = await db.shoppingSyncLog.findMany({
        where: { ...REFUND_PARK_WHERE, externalId: row.externalId, entityId: row.entityId },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      })
      const staleIds = parks.slice(1).map((park) => park.id)
      if (staleIds.length > 0) {
        await db.shoppingSyncLog.deleteMany({ where: { id: { in: staleIds } } })
      }

      // o3d-w00 (Codex r1 #3): put the quarantine BACK if the re-fetch never re-decided this refund.
      // The transition above is only safe because the sync normally re-parks the row (as QUARANTINED
      // again, or SYNCED); when the WooCommerce fetch itself fails, or the refund is absent from the
      // response, nothing rewrites it and the row is stranded as PENDING — carrying the original
      // deliberate-refusal message, but no longer offering the ONE action that can resolve it
      // (Record manually is scoped to QUARANTINED, because hand-recording a retryable park would race
      // its retry into a duplicate credit note). Detected by the row being untouched: still PENDING,
      // still carrying the same error text it had before the transition.
      if (row.status === 'QUARANTINED') {
        await db.shoppingSyncLog.updateMany({
          where: {
            ...REFUND_PARK_WHERE,
            externalId: row.externalId,
            entityId: row.entityId,
            status: 'PENDING',
            errorMessage: row.errorMessage,
          },
          data: { status: 'QUARANTINED' },
        })
      }
    }

    await logActivity({
      entityType: 'SYNC',
      entityId: row.entityId,
      tag: 'sync',
      action: 'wc_refund_sync_retry',
      description: refundLanded
        ? `Retried parked WooCommerce refund ${row.externalId} via the exception inbox — refund applied`
        : `Retried parked WooCommerce refund ${row.externalId} via the exception inbox — still not applied (see the row's error)`,
      metadata: { shoppingSyncLogId: row.id, externalRefundId: row.externalId, userId: session.user.id },
      level: refundLanded ? undefined : 'WARNING',
    })
    revalidatePath('/sync/exceptions')
    return { success: true, synced: Boolean(refundLanded) }
  } catch (error) {
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    throw error
  }
}


/**
 * o3d-w00 (Codex r1 #3): COMPLETE a quarantined WooCommerce refund by recording it by hand.
 *
 * A QUARANTINED refund park is a deliberate, non-transient refusal: either the monetary-only gross→net
 * basis could not be established, or the order is not uniformly taxed so an unattributed monetary amount
 * could not be posted under one VAT identity. The money has ALREADY been returned in WooCommerce and no
 * credit note exists. Retry cannot help — it re-runs the identical decision against the identical order —
 * so before this action the park had no end state at all: it kept counting in the exception inbox and
 * kept blocking order deletion / store rebinding forever, and a human who reconciled it in the ledger had
 * no way to say so.
 *
 * What makes this resolvable rather than merely dismissible: the operator supplies the ONE thing IMS
 * cannot derive — which parts of the order the refunded money covered, and how much of it each took.
 * With that, the credit note is raised through the ordinary refund path, LINE-LINKED, so every refund
 * line carries its own line's VAT identity; the non-uniform-tax refusal does not apply to a line-linked
 * refund, and no header rate has to be guessed. The refund is stamped with the WooCommerce refund id, so
 * a later redelivery of the same refund dedups against it instead of raising a second credit note.
 *
 * Codex r2 #2 — the allocation is RECONCILED to the parked refund, not merely accepted. The action reads
 * the WooCommerce refund off the park, and the operator's amounts are GROSS: they must add up to the
 * gross the storefront returned, or the recording is refused. Anything else made this path a way to book
 * a figure nobody checked — £1 entered against a £100 storefront refund cleared the exception forever
 * and left the ledger £99 short, which is the same silent mis-crediting the automatic route was
 * quarantined for. Gross is also the only figure an operator HAS: it is what the storefront shows, and
 * asking for net would mean hand-dividing by each line's rate until the total happened to match.
 *
 * Codex r2 #3 — SHIPPING is an allocation target. The dialog used to offer order lines only, so a refund
 * that included postage could not be expressed at all: the operator's choices were to leave the park open
 * forever or to misattribute shipping money to a goods line (wrong account, wrong VAT). Shipping is
 * emitted as an unlinked `lineKind: 'shipping'` refund line — the same shape a chargeback uses — and is
 * grossed/posted under the ORDER-DEFAULT VAT identity, which is exactly what the invoice charged it under
 * and what createSalesOrderRefund will post it under.
 *
 * Deliberately NOT a "dismiss" button. Marking the park resolved without a credit note would leave the
 * order's ledger short by the refunded amount, which is precisely the silent over-credit this epic exists
 * to prevent. If the amounts cannot be attributed, the honest outcome is that the row stays open.
 *
 * Permissions: `sync` to act on the inbox AND fresh `sales.refund` to raise the credit note — ADMIN and
 * MANAGER hold both, so an operator who can reach this screen can complete it. (FINANCE holds
 * `sales.refund` but not `sync`, so it never sees the inbox; that separation is intentional.)
 */
export type RefundParkAllocationInput = {
  /** The order line the money came off, or null together with `lineKind: 'shipping'`. */
  lineId: string | null
  lineKind: 'sale' | 'shipping'
  /** GROSS (tax-inclusive) amount in the ORDER's currency — the figure the storefront refunded. */
  grossAmountForeign: number
}

export async function recordRefundParkManually(
  parkId: string,
  allocations: RefundParkAllocationInput[],
  reason: string,
): Promise<MutationResult> {
  try {
    await requirePermission('sync')
    const session = await requireFreshPermission('sales.refund')

    if (!reason.trim()) {
      return { success: false, error: 'A reason is required — it is the audit record for a hand-recorded refund.' }
    }
    const cleaned = allocations
      .filter((allocation) => Number.isFinite(allocation.grossAmountForeign) && allocation.grossAmountForeign > 0)
      .map((allocation) => ({
        lineId: allocation.lineKind === 'shipping' ? null : allocation.lineId,
        lineKind: allocation.lineKind === 'shipping' ? ('shipping' as const) : ('sale' as const),
        grossAmountForeign: allocation.grossAmountForeign,
      }))
    if (cleaned.length === 0) {
      return { success: false, error: 'Allocate the refunded amount across at least one order line or the shipping charge (GROSS, tax-inclusive).' }
    }
    // Two rows for the same target would each pass their own balance check and together exceed it, and
    // the audit record would no longer say where the money went.
    const targetKeys = cleaned.map((allocation) => allocation.lineKind === 'shipping' ? 'shipping' : `line:${allocation.lineId}`)
    if (new Set(targetKeys).size !== targetKeys.length) {
      return { success: false, error: 'Each order line (and the shipping charge) may be allocated only once — combine the duplicates into a single amount.' }
    }
    if (cleaned.some((allocation) => allocation.lineKind === 'sale' && !allocation.lineId)) {
      return { success: false, error: 'An order-line allocation must name the line it covers.' }
    }

    // Scoped to a QUARANTINED park: PENDING/FAILED rows are ordinary retryable failures whose remedy is
    // Retry, and hand-recording one would race the retry into a duplicate credit note.
    const park = await db.shoppingSyncLog.findFirst({
      where: { id: parkId, ...REFUND_PARK_WHERE, status: 'QUARANTINED' },
      // The parked WooCommerce refund itself (Codex r2 #2): its gross `amount` is the figure the credit
      // note has to come to. Without it there is nothing to reconcile against.
      select: { id: true, entityId: true, externalId: true, payload: true },
    })
    if (!park?.entityId || !park.externalId) {
      return { success: false, error: 'This refund is no longer quarantined (already resolved, retried, or removed).' }
    }
    const externalRefundId = Number(park.externalId)
    if (!Number.isSafeInteger(externalRefundId) || externalRefundId <= 0) {
      return { success: false, error: `The parked row has no usable WooCommerce refund id (${park.externalId}).` }
    }
    const parkedGrossText = readParkedRefundGross(park.payload)
    if (parkedGrossText == null) {
      // A park written before the payload was retained. Refusing is not a dead end: Retry re-fetches the
      // refund from WooCommerce and re-parks it WITH the payload (and restores the quarantine if the
      // fetch fails), after which this action can reconcile against it.
      return {
        success: false,
        error:
          'This park does not carry the WooCommerce refund it came from, so the amount recorded here ' +
          'could not be checked against the refund it settles. Use Retry on this row first — that ' +
          're-reads the refund from WooCommerce and stores it — then record it manually.',
      }
    }
    const parkedGross = toDecimal(parkedGrossText).abs()
    if (!parkedGross.isFinite() || parkedGross.lte(0)) {
      return { success: false, error: `The parked WooCommerce refund has no usable amount (${parkedGrossText}).` }
    }

    // externalRefundId is GLOBALLY unique. If the refund has meanwhile landed — here or on another order
    // — raising a second credit note for it would double-credit, so fail closed instead.
    const alreadyLanded = await db.salesOrderRefund.findFirst({
      where: { externalRefundId },
      select: { orderId: true, creditNoteNumber: true },
    })
    if (alreadyLanded) {
      return {
        success: false,
        error: alreadyLanded.orderId === park.entityId
          ? `Refund ${park.externalId} has already been recorded (credit note ${alreadyLanded.creditNoteNumber ?? 'pending'}). Retry this row to close it.`
          : `Refund ${park.externalId} already exists on a different order (${alreadyLanded.orderId}); it cannot be recorded here.`,
      }
    }

    const order = await db.salesOrder.findUnique({
      where: { id: park.entityId },
      select: {
        id: true,
        currency: true,
        fxRateToBase: true,
        // The order-default VAT identity: what the invoice charged shipping under, and what
        // createSalesOrderRefund posts an unlinked shipping refund line under. taxRateName is how that
        // identity is RESOLVED (the ACTIVE TaxRate of that name); what shipping was CHARGED is derived
        // from the order's own money below, and the two must agree before a gross may be divided by
        // either (o3d-w00 Codex r3 #1 / r5 #1). taxRatePercent is deliberately NOT read: it is the
        // order's header default rate, not the shipping leg's.
        taxRateName: true,
        shippingForeign: true,
        // Shipping's own VAT, which IMS stores in no column of its own: the VAT the order records over
        // and above its lines. discountAmount is read because an order-level discount's VAT is netted
        // off that same total and would otherwise be counted as shipping's.
        taxForeign: true,
        discountAmount: true,
        // Codex r6 #3: the writer's own mark — see orderTaxIsSumOfComponents.
        shoppingLinks: { select: { connector: true } },
        lines: {
          select: {
            id: true,
            productId: true,
            description: true,
            // o3d-w00 (Codex r7 #3): how the parked payload's refunded QUANTITIES are matched back to
            // IMS lines — the same link the automatic itemised route matches on.
            externalLineItemId: true,
            // The line's own money snapshot — what it was sold at and the VAT taken on it. Codex r4 #1:
            // the CHARGED rate is read from these, never from the live TaxRate row, which an admin can
            // edit at any time and which would then make the divergence check compare today's rate
            // against today's rate.
            totalForeign: true,
            taxForeign: true,
            taxRate: { select: { reverseCharge: true, accountingTaxType: true } },
          },
        },
      },
    })
    if (!order) {
      return { success: false, error: 'The order this refund belongs to no longer exists.' }
    }
    const orderLineById = new Map(order.lines.map((line) => [line.id, line]))
    const unknown = cleaned.find((allocation) => allocation.lineKind === 'sale' && !orderLineById.has(allocation.lineId!))
    if (unknown) {
      return { success: false, error: `Line ${unknown.lineId} is not on this order.` }
    }
    const orderShippingForeign = toDecimal(order.shippingForeign)
    if (cleaned.some((allocation) => allocation.lineKind === 'shipping') && orderShippingForeign.lte(0)) {
      return { success: false, error: 'This order carries no shipping charge, so a shipping refund cannot be recorded against it.' }
    }

    // -----------------------------------------------------------------------------------------------
    // o3d-w00 (Codex r7 #3): the UNITS the quarantined refund returned come back with it.
    //
    // Recording the money by hand used to send `qty: 0` and no return warehouse, on the reasoning that a
    // hand-recorded MONETARY refund must not invent an inventory movement. That reasoning is right for a
    // monetary-only park and wrong for an itemised one: WooCommerce stated a refunded quantity per line,
    // the automatic route would have restocked exactly those units, and the quarantine is the only
    // reason it did not. Dropping them here made the sole remedy for a quarantine a permanent, silent
    // inventory loss — and the posted-VAT fence quarantines itemised refunds, so it would have made
    // that loss commoner.
    //
    // So the units are carried through from the payload, matched to IMS lines the same way the automatic
    // route matches them, and restocked to the default return warehouse. A monetary-only park states no
    // quantities and is unaffected — it still records as money alone.
    // -----------------------------------------------------------------------------------------------
    const refundedQtyByExternalLineId = readParkedRefundedQuantities(park.payload)
    const refundedQtyByLineId = new Map<string, number>()
    for (const line of order.lines) {
      const qty = line.externalLineItemId == null ? 0 : refundedQtyByExternalLineId.get(line.externalLineItemId) ?? 0
      if (qty > 0) refundedQtyByLineId.set(line.id, qty)
    }
    // o3d-w00 (Codex r8 #2): EVERY matched quantity, not only the ones the operator put money against.
    //
    // r7 restocked only lines that also received a positive monetary allocation, on the reasoning that
    // an allocation is what says this part of the order is being refunded. It is not: the PAYLOAD says
    // what came back. WooCommerce reports a returned quantity on lines that carry no refundable money
    // at all — a fully discounted item, a free gift, a line whose value was credited on a different
    // refund — and the automatic route restocks those units regardless, because a returned unit is a
    // physical fact and its value is a separate question. Filtering by allocation therefore reproduced
    // the exact defect this block was added to end, on a narrower set of lines: the units are recorded
    // nowhere, and the park closes.
    //
    // Quantities that match NO IMS line are carried in the audit record rather than refused: the
    // automatic route cannot restock them either (there is no product to move), so refusing here would
    // be a dead end for a case that has no remedy, not a safeguard.
    const restockedLineIds = [...refundedQtyByLineId.keys()]
    const matchedExternalLineIds = new Set(
      order.lines
        .filter((line) => line.externalLineItemId != null && refundedQtyByExternalLineId.has(line.externalLineItemId))
        .map((line) => line.externalLineItemId!),
    )
    const unmatchedRefundedQty = [...refundedQtyByExternalLineId.entries()]
      .filter(([externalLineItemId]) => !matchedExternalLineIds.has(externalLineItemId))
      .map(([externalLineItemId, qty]) => ({ externalLineItemId, qty }))
    let returnWarehouseId: string | undefined
    if (restockedLineIds.length > 0) {
      const returnWarehouse = await db.warehouse.findFirst({
        where: { defaultReturnWarehouse: true, active: true },
        select: { id: true },
      })
      if (!returnWarehouse) {
        // Refuse rather than record the money and drop the units — that is the data loss this block
        // exists to end, and it would be indistinguishable from a correct recording afterwards. The
        // remedy is one setting, and the park stays QUARANTINED and recordable once it is made.
        return {
          success: false,
          error:
            `This refund returned ${restockedLineIds
              .reduce((sum, lineId) => sum + (refundedQtyByLineId.get(lineId) ?? 0), 0)} unit(s), but no ` +
            'active default return warehouse is configured, so they cannot be brought back into stock. ' +
            'Set one in Settings → Warehouses, then record this refund.',
        }
      }
      returnWarehouseId = returnWarehouse.id
    }

    // What is still refundable, per target. createSalesOrderRefund caps the ORDER total; it does not stop
    // one line absorbing money that came off another, which would post the refund to the wrong account
    // and the wrong VAT even though the total reconciled.
    //
    // Codex r3 #2: this read is OUTSIDE the refund transaction, so it can only be a pre-flight — two
    // concurrent recordings against one order would both pass it. The AUTHORITATIVE cap is re-taken
    // inside createSalesOrderRefund under the order lock (enforcePerTargetBalances below), using this
    // same helper. Keeping it here as well is what gives the operator the named-target refusal
    // immediately, before anything is created.
    const [priorRefundLines, postingTaxContext] = await Promise.all([
      db.salesOrderRefundLine.findMany({
        where: { refund: { orderId: order.id } },
        select: { salesOrderLineId: true, lineKind: true, totalForeign: true },
      }),
      loadRefundPostingTaxContext(),
    ])

    const fxRate = toDecimal(order.fxRateToBase).gt(0) ? toDecimal(order.fxRateToBase) : toDecimal(1)
    // The order-default identity, resolved exactly as createSalesOrderRefund resolves it.
    const orderDefaultTaxType = order.taxRateName
      ? postingTaxContext.activeTaxTypeByName.get(order.taxRateName) ?? null
      : null
    // The identity an UNLINKED sale amount posts under, resolved from the whole order exactly as
    // createSalesOrderRefund resolves it (Codex r4 #2) — so a line with no TaxRate row of its own is
    // priced here the same way it will be posted, rather than by a second, different rule.
    const orderUniform = resolveOrderUniformTaxIdentity({
      lines: order.lines,
      reverseChargeSalesTaxType: postingTaxContext.reverseChargeSalesTaxType,
    })
    // What the ORDER says its shipping leg was charged (Codex r5 #1) — its own money, not the header
    // default rate, which is shipping's rate only on a uniformly taxed order.
    const chargedShipping = {
      currency: order.currency,
      netForeign: order.shippingForeign,
      orderTaxForeign: order.taxForeign,
      lineTaxForeign: order.lines.map((line) => line.taxForeign),
      orderDiscountAmount: order.discountAmount,
      orderTaxIsSumOfComponents: orderTaxIsSumOfComponents(order.shoppingLinks),
    }
    const refundLines: {
      lineId: string | null
      productId: string | null
      description: string
      qty: number
      totalForeign: number
      totalBase: number
      lineKind: 'sale' | 'shipping'
      grossForeign: number
    }[] = []
    // Codex r4 #2: the identity every allocation was CONVERTED at, carried into the refund transaction
    // so the posting can be fenced to it. Conversion happens here (it has to — the net lines are the
    // input to the ledger call) and the posting identity is resolved again inside the transaction from
    // its own locked read. Two independent reads can disagree — an admin remapping a tax rate, renaming
    // or deactivating the order default, or setting/clearing the reverse-charge code in between — and
    // the credit note would then post under an identity the gross was never divided by. That is exactly
    // the disagreement the reconciliation exists to prevent, so the ledger refuses instead.
    const expectedTaxIdentities: {
      lineId: string | null
      lineKind: 'sale' | 'shipping'
      accountingTaxType: string
      reverseCharge: boolean
      vatRate: string
    }[] = []
    for (const allocation of cleaned) {
      const gross = toDecimal(allocation.grossAmountForeign)
      const line = allocation.lineKind === 'sale' ? orderLineById.get(allocation.lineId!)! : null
      // o3d-w00 (Codex r3 #1): the rate the credit note will RE-GROSS this line at is the rate of the
      // accounting tax IDENTITY it posts under, resolved here the same way createSalesOrderRefund
      // resolves it — NOT the line's nominal TaxRate.rate. Converting with the nominal rate let a park
      // be "reconciled" to a figure the credit note would never come to: a 0%-nominal line with no
      // accounting tax code falls back to a 20% order default, so £100 gross stored as £100 net posts a
      // £120 credit note against a £100 storefront refund. Where the identity cannot be established, or
      // does not carry the rate the customer was charged, the recording is REFUSED — with the fix named
      // — rather than reconciled against a rate that will not be used.
      const identity = resolvePostedRefundTaxIdentity({
        kind: allocation.lineKind,
        lineTaxRate: line?.taxRate ?? null,
        chargedLine: line ? { currency: order.currency, netForeign: line.totalForeign, taxForeign: line.taxForeign } : null,
        chargedShipping,
        orderDefaultTaxType,
        orderUniform,
        reverseChargeSalesTaxType: postingTaxContext.reverseChargeSalesTaxType,
        rateByTaxType: postingTaxContext.rateByTaxType,
        label: line ? (line.description || `line ${line.id}`) : 'The shipping charge',
      })
      if (!identity.ok) {
        return { success: false, error: identity.reason }
      }
      expectedTaxIdentities.push({
        lineId: line?.id ?? null,
        lineKind: allocation.lineKind,
        accountingTaxType: identity.accountingTaxType,
        reverseCharge: identity.reverseCharge,
        // The rate the gross was DIVIDED by. The fence re-prices the code under the order lock and
        // compares against this, so a rate edited between the two reads is caught as well as a remap.
        vatRate: identity.vatRate.toString(),
      })
      const net = roundQuantity(gross.div(toDecimal(1).add(identity.vatRate)), 4)
      refundLines.push({
        lineId: line?.id ?? null,
        productId: line?.productId ?? null,
        description: line?.description ?? 'Shipping refund',
        // o3d-w00 (Codex r7 #3): the units the storefront refund returned on THIS line, as WooCommerce
        // stated them. Zero for a monetary allocation — an amount that returns no goods — and
        // createSalesOrderRefund keeps amount-only lines (its filter is qty > 0 OR totalBase > 0) and
        // derives a 0 unit price for them.
        qty: line ? refundedQtyByLineId.get(line.id) ?? 0 : 0,
        totalForeign: net.toNumber(),
        totalBase: roundQuantity(net.div(fxRate), 4).toNumber(),
        lineKind: allocation.lineKind,
        grossForeign: roundQuantity(gross, 4).toNumber(),
      })
    }

    // o3d-w00 (Codex r8 #2): the returned units on lines the operator credited NOTHING against. They
    // are carried as their own zero-value refund lines — createSalesOrderRefund keeps a line on qty > 0
    // OR totalBase > 0, and its posted-VAT fence skips a line that credits nothing, so the units come
    // back into stock and appear on the refund without inventing money or a tax identity for them.
    const allocatedLineIds = new Set(
      refundLines.filter((refundLine) => refundLine.lineKind === 'sale' && refundLine.lineId).map((refundLine) => refundLine.lineId!),
    )
    for (const [lineId, qty] of refundedQtyByLineId) {
      if (allocatedLineIds.has(lineId)) continue
      const line = orderLineById.get(lineId)!
      refundLines.push({
        lineId,
        productId: line.productId,
        description: line.description,
        qty,
        totalForeign: 0,
        totalBase: 0,
        lineKind: 'sale',
        grossForeign: 0,
      })
    }

    const overAllocated = findOverAllocatedRefundTarget({
      order: { shippingForeign: order.shippingForeign, lines: order.lines },
      priorRefundLines,
      allocations: refundLines.map((refundLine) => ({
        lineId: refundLine.lineId,
        lineKind: refundLine.lineKind,
        netForeign: refundLine.totalForeign,
      })),
      epsilon: REFUND_ALLOCATION_EPSILON,
    })
    if (overAllocated) {
      return { success: false, error: overAllocatedRefundTargetMessage(overAllocated) }
    }

    // Codex r2 #2: the credit note must SETTLE the parked refund, not merely be smaller than the order.
    // Every allocation was converted at the rate its own posting will re-gross it by, so the sum of the
    // grosses IS what the credit note will come to — and it has to be what WooCommerce returned.
    const allocatedGross = cleaned.reduce((sum, allocation) => sum.add(toDecimal(allocation.grossAmountForeign)), toDecimal(0))
    if (allocatedGross.sub(parkedGross).abs().gt(REFUND_ALLOCATION_EPSILON)) {
      return {
        success: false,
        error:
          `The allocation comes to ${allocatedGross.toFixed(2)} gross but WooCommerce refunded ` +
          `${parkedGross.toFixed(2)}. Record the refund that was actually made: the amounts are GROSS ` +
          '(tax-inclusive) and must add up to the storefront figure exactly.',
      }
    }

    const restockedUnits = refundLines.reduce((sum, line) => sum + line.qty, 0)
    const { createRefund } = await import('@/app/actions/sales')
    const result = await createRefund(
      order.id,
      // `grossForeign` is carried alongside for the audit record only — the ledger takes net.
      refundLines.map((line) => ({
        lineId: line.lineId,
        productId: line.productId,
        description: line.description,
        qty: line.qty,
        totalForeign: line.totalForeign,
        totalBase: line.totalBase,
        lineKind: line.lineKind,
      })),
      reason.trim(),
      // o3d-w00 (Codex r7 #3): set only when the parked refund states returned QUANTITIES on the lines
      // being credited — the units the automatic route would have restocked, which a quarantine
      // otherwise loses for good. A monetary-only park states none, so it still records with no return
      // warehouse: nothing physically came back, and a hand-recorded monetary refund must not invent an
      // inventory movement.
      returnWarehouseId,
      {
        internalBypassToken: INTERNAL_ACTION_BYPASS,
        externalRefundId,
        // Codex r3 #2: re-take the per-target caps under the refund transaction's order lock, so two
        // concurrent recordings against this order cannot both pass their own pre-flight and jointly
        // over-refund one line.
        enforcePerTargetBalances: true,
        // Codex r4 #2: and fence the POSTING identity to the one the gross was converted at. The
        // ledger re-resolves and re-prices each target under the same lock and refuses the whole
        // credit note if either has moved, so the two reads can never disagree in a committed refund.
        expectedTaxIdentities,
      },
    )
    if (!result.success) {
      // The park stays QUARANTINED and visible — the operator can fix the allocation and try again.
      return { success: false, error: result.error ?? 'The refund could not be recorded.' }
    }

    // The credit note exists and owns the WooCommerce refund id, so the park's premise (an unresolved
    // storefront refund) is no longer true. Resolve EVERY actionable park for this refund + order, not
    // just the clicked one, so repeated deliveries do not leave stale rows behind.
    await db.shoppingSyncLog.updateMany({
      where: { ...REFUND_PARK_WHERE, externalId: park.externalId, entityId: park.entityId },
      data: { status: 'SYNCED', syncedAt: new Date(), errorMessage: null },
    })

    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: order.id,
      tag: 'sync',
      action: 'wc_refund_park_recorded_manually',
      level: 'WARNING',
      description:
        `WooCommerce refund ${park.externalId} could not be converted automatically and was recorded by hand ` +
        `against ${cleaned.length} part(s) of the order, reconciled to the ${parkedGross.toFixed(2)} ` +
        `${order.currency ?? ''} the storefront refunded: ${reason.trim()}` +
        // o3d-w00 (Codex r7 #3): say what happened to the GOODS as well as the money. A hand-recorded
        // itemised refund now brings its units back; the reader has to be able to tell that from a
        // monetary one that brought none back, without opening the metadata.
        (restockedUnits > 0
          ? ` ${restockedUnits} unit(s) were returned to stock.`
          : ' No units were returned (monetary refund).')
      .replace(/\s+/g, ' '),
      // The evidence: exactly which parts of the order the operator attributed the money to, gross and
      // net, the units returned against each, and the storefront figure they were checked against.
      metadata: {
        shoppingSyncLogId: park.id,
        externalRefundId,
        userId: session.user.id,
        parkedGrossForeign: parkedGross.toFixed(2),
        returnWarehouseId: returnWarehouseId ?? null,
        restockedUnits,
        // o3d-w00 (Codex r8 #2): units WooCommerce says came back on a line IMS cannot identify. Nobody
        // can restock these — the automatic route cannot either — so they are recorded here rather than
        // silently dropped or used to refuse a refund that has no other problem.
        unmatchedRefundedQty,
        allocations: refundLines.map((line) => ({
          lineId: line.lineId,
          lineKind: line.lineKind,
          qty: line.qty,
          grossForeign: line.grossForeign,
          totalForeign: line.totalForeign,
          totalBase: line.totalBase,
        })),
      },
      resolveUser: false,
    })
    revalidatePath('/sync/exceptions')
    revalidatePath(`/sales/${order.id}`)
    return { success: true }
  } catch (error) {
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    throw error
  }
}

/**
 * o3d-54p — OPERATOR RECOVERY for a STALE CROSS-ORDER refund park.
 *
 * WHY RETRY IS NOT ENOUGH, AND WHY THIS IS A SEPARATE ACTION.
 *
 * retryRefundSyncPark re-fetches the refunds of THE PARK'S OWN RECORDED ORDER. For a park sitting on
 * the wrong order that fetch cannot contain the refund, so the retry can never resolve it — and it
 * deliberately refuses to resolve the park with a refund belonging to another order. Meanwhile
 * createSalesOrderRefund and syncWcRefund both fail CLOSED on the foreign park (o3d-ee9/o3d-7yf), so
 * the TRUE owner's refund, credit note and restock are blocked; the park is retention-exempt; and
 * both orders are undeletable. Nothing an operator could do changed any of it.
 *
 * WHAT THIS ASSERTS, AND WHAT VERIFIES IT. WooCommerce is the authority on which order a refund
 * belongs to, so this action does not take the operator's word for the ownership fact — it takes
 * their word for WHICH ORDER TO ASK ABOUT, asks WooCommerce FRESH, and refuses when the answer
 * contradicts them. The decision (move it, or write it off) stays theirs and is recorded with their
 * name on it; the ownership is evidence, not an assertion. The decision vocabulary — every refusal
 * and every patch — lives in lib/domain/sales/refund-park-recovery.ts as pure functions.
 *
 * THE AUDIT. logActivity is best-effort (it swallows its own errors), which is why the recovery note
 * is written onto the PARK ROW ITSELF in the same transaction as the status change: the fact that a
 * human recovered this park, and what WooCommerce said when they did, survives a logging failure.
 * o3d-batch-settle adds logActivityInTransaction for exactly this problem; when that lands, this
 * activity write should move inside the transaction rather than being duplicated here.
 */
export type RecoverRefundSyncParkInput = { observedOrderId: string } & (
  | { outcome: 'REASSIGN'; wcOrderId: number }
  | { outcome: 'DISMISS'; reason?: string }
)

export type RecoverRefundSyncParkResult =
  | { success: true; outcome: RefundParkRecoveryOutcome; targetOrderId: string | null }
  | { success: false; error: string; code: RefundParkRecoveryRefusalCode }
  | FreshAuthFailureResult

/**
 * EVERY refund WooCommerce lists on an order, or a REFUSAL — never a list that might be short.
 *
 * WHY THIS READ IS HELD TO A HIGHER STANDARD THAN THE SWEEP'S. `fetchAllWcRefundsForOrder` in the
 * refund sweep may hand back a partial list with an error attached, because syncing nine of ten
 * refunds is better than syncing none and the next sweep re-reads from the start. THIS read cannot
 * do that. Its output is EVIDENCE, and specifically evidence of ABSENCE: "WooCommerce does not list
 * refund N on this order" is the whole of what authorises a dismissal, and a dismissal writes off a
 * refund whose money has already left the business. A list that merely FAILED TO INCLUDE something
 * is indistinguishable from one that PROVES it is not there — so an answer that cannot be shown to
 * be complete must refuse rather than resolve.
 *
 * WHAT "COMPLETE" MEANS HERE, and why `x-wp-totalpages` cannot supply it. `wcFetch` parses that
 * header as `parseInt(header ?? '1')`, so a store that does not send it at all is INDISTINGUISHABLE
 * from one reporting a single page — both arrive as `totalPages: 1`. Ending the walk on that number
 * would take "the store said nothing" for "the store said there is no more", which is the exact
 * shape of the defect this function exists to avoid, moved one layer out. So the header is never
 * trusted to end the walk: completeness is established from the RESPONSE BODY.
 *
 * AND ONLY ONE THING IN A BODY PROVES AN ENDING: A PAGE WITH NOTHING ON IT.
 *
 * That is Codex round 3's first finding, and it is the third and last time this rule has had to be
 * loosened. Round 1 ended the walk on "shorter than the hundred we asked for", which ended it on the
 * first page of every store that caps `per_page` lower. Round 2 ended it on "shorter than the first
 * page this store filled", which learns the size the server actually granted instead of assuming it.
 * BUT A GRANTED SIZE IS NOT A PROMISE, AND NOTHING MAKES IT STABLE ACROSS REQUESTS. A proxy trims one
 * response; a rate-limited security plugin sheds load mid-walk; a host lowers a filter between two
 * calls. Page one comes back with a hundred, page two with forty, and "shorter than a page this same
 * store filled" reads the forty as the end of the collection — a false complete, on the one code path
 * whose output authorises writing a refund off.
 *
 * So an ending is no longer INFERRED from a length at all:
 *
 *   • AN EMPTY PAGE ENDS THE WALK. Whatever size the store served on any request before it, a page
 *     with nothing on it lies past the end of the collection, so everything the collection holds has
 *     already been banked. This is the ONLY unconditional proof of an ending available to a client.
 *   • A NON-EMPTY PAGE — of ANY length, short or full — ADVANCES. A short page is exactly as
 *     consistent with a trimmed response as with the last page of a collection, and the response
 *     itself cannot tell them apart. Only the next request can.
 *
 * WHAT THAT COSTS, stated plainly because it is paid on every recovery: ONE EXTRA REQUEST for any
 * order whose refunds do not happen to fill their last page. An order with no refunds still costs
 * one request (the first page is the empty one); an order inside a single page costs two, exactly as
 * it did before, because page one could never end the walk on its own length either. Only orders
 * spanning several pages pay the difference, and they pay one request. That is the whole price of
 * not guessing, and a refusal is recoverable in a way a dismissal is not.
 *
 * AND WHAT THE STORE SAYS IT HAS IS CHECKED AGAINST WHAT IT ACTUALLY SERVED. `x-wp-total` cannot END
 * the walk — a store that omits it arrives as 0, and a header cannot prove a body — but a MISMATCH
 * is proof of the opposite, and it is the one thing that catches a page trimmed BETWEEN two full
 * ones, where no rule about lengths can help: the rows in the gap are simply never served, the walk
 * terminates cleanly on a later empty page, and the list it returns is quietly missing the refund
 * that would have contradicted the dismissal. So if the store ever states a total and fewer rows than
 * that were banked, this refuses. The SMALLEST total stated across the walk is the one used, because
 * a refund created while the walk is running raises the total on later pages and a list one row short
 * of the newest claim is not evidence of anything.
 *
 * The `x-wp-totalpages` header is still read for the one thing it CAN do: fail fast and cheaply when
 * the store says up front there is more here than this check will read.
 *
 * AND NONE OF THAT IS ABOUT THE COLLECTION — only about the pages cut out of it. That is Codex round
 * 4's first finding, and the last thing a positional pager gets wrong. `?page=N&per_page=100` asks
 * for "rows 100N to 100N+99 OF WHATEVER IS THERE WHEN YOU ASK", so a refund DELETED behind the cursor
 * shifts every later row down one place and the row that was going to open the next page is served to
 * nobody. Every page is full, the walk ends on an empty one, and the list is one row short.
 *
 * THE STATED-TOTAL GUARD CANNOT SEE THAT, and it is worth being exact about why, because it looks as
 * though it should: the list still carries the id of the row that was DELETED — banked before the
 * delete — so it is one id too long by precisely the amount it is one id too short. The count balances
 * because two errors of one cancel. Deleting two rows cancels twice. No arithmetic over a single walk
 * recovers the difference, and the walk terminates honestly the whole time.
 *
 * SO THE WALK NO LONGER CLAIMS COMPLETENESS BY ITSELF. It reports what it read and what the store
 * said, and TWO further things decide whether that may be used as evidence of ABSENCE:
 *
 *   • A REPEATED ID INSIDE ONE WALK REFUSES, here. A stable collection cannot serve one row on two
 *     pages — the offsets do not overlap — so a repeat is proof the collection moved. It is what a
 *     CREATED refund looks like (newest first, so the new row takes offset 0 and pushes a row we have
 *     read onto the next page). That direction loses nothing, but the trace it leaves is not wasted:
 *     the same motion running the other way is the one that loses a row in silence.
 *   • AND THE DISMISSAL PATH RUNS THE WHOLE WALK TWICE, requiring the two answers to agree — see
 *     `readConfirmedWcOrderRefundIds`. The row a deletion hides is hidden BECAUSE another row was
 *     deleted, and that row is still in the first list; the store cannot serve it again, so the second
 *     read comes back without it and the lists differ.
 *
 * AND AN UNREADABLE ROW REFUSES TOO. An entry whose `id` is not a usable integer used to be dropped
 * silently, which is the same error in miniature: a list with a row we cannot read cannot establish
 * that a particular refund is missing from it.
 */
const WC_REFUND_PAGE_SIZE = 100
const WC_REFUND_MAX_PAGES = 10

/** Why a read could not produce a usable list. `moved` = WooCommerce answered, but the list shifted. */
type WcRefundReadFailure = { error: string; moved?: boolean }

async function readWcOrderRefundIds(
  wcOrderId: number,
): Promise<{ evidence: WcOrderRefundEvidence; statedTotal: number | null } | WcRefundReadFailure> {
  const ids: number[] = []
  // Every id banked so far, so a REPEATED one is caught. See the note above: a repeat is not a
  // WooCommerce quirk, it is the signature of a collection that shifted under a positional read.
  const seen = new Set<number>()
  // The SMALLEST refund count the store stated anywhere in this walk, or null if it never stated one
  // (a store that omits `x-wp-total` arrives here as 0, which is not a claim about anything).
  let statedTotal: number | null = null
  for (let page = 1; page <= WC_REFUND_MAX_PAGES; page += 1) {
    const { data, totalPages: reported, totalItems, error } = await wcFetch(
      `/orders/${wcOrderId}/refunds`,
      { per_page: String(WC_REFUND_PAGE_SIZE), page: String(page) },
    )
    if (error) return { error }
    if (!Array.isArray(data)) return { error: 'WooCommerce returned an unexpected response for this order\'s refunds.' }
    // Cheap early refusal: the store itself says the collection is bigger than this walk. Checked
    // BEFORE the page is banked so an oversized order costs one request rather than ten.
    if (Number.isFinite(reported) && reported > WC_REFUND_MAX_PAGES) {
      return { error: `that order reports ${reported} pages of refunds, more than this check will read` }
    }
    if (Number.isFinite(totalItems) && totalItems > 0) {
      statedTotal = statedTotal === null ? totalItems : Math.min(statedTotal, totalItems)
    }
    for (const entry of data) {
      const candidate = (entry as { id?: unknown }).id
      if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate)) {
        return { error: 'WooCommerce listed a refund on that order with no readable id, so this check cannot say which refunds it holds' }
      }
      // THE SAME REFUND TWICE. A stable collection cannot serve one row on two pages: the offsets do
      // not overlap. It happens when a refund is CREATED mid-walk — WooCommerce lists refunds newest
      // first, so the new row takes offset 0 and pushes the row we have already read onto the next
      // page. Nothing is lost in that direction, but the same shift running the other way (a DELETE)
      // loses a row silently and leaves no trace at all, so the trace that DOES exist is not spent.
      if (seen.has(candidate)) {
        return {
          moved: true,
          error: `WooCommerce served refund ${candidate} twice, on different pages, so its refund list `
            + 'moved between two requests of this read',
        }
      }
      seen.add(candidate)
      ids.push(candidate)
    }
    // THE ONLY PROOF OF AN ENDING. Checked first, so an order with no refunds at all still costs one
    // request. A non-empty page — however short — falls through and asks for the next one.
    if (data.length === 0) {
      // The walk ended cleanly, which says nothing about whether every row was served on the way.
      if (statedTotal !== null && ids.length < statedTotal) {
        return {
          error: `WooCommerce says that order has ${statedTotal} refunds but served only ${ids.length} of them, `
            + 'so this check cannot say which refunds it holds',
        }
      }
      return { evidence: { wcOrderId, refundIds: ids, fetchedAt: new Date() }, statedTotal }
    }
  }
  // The list never ended. It is not known to be complete and must not be used to prove a refund
  // absent. Counted from what was actually read rather than from pages × requested size — under a
  // capped store those differ, and quoting the size we asked for would put a number in front of the
  // operator that never existed.
  return {
    error: `this check read ${ids.length} refunds over ${WC_REFUND_MAX_PAGES} pages of that order without `
      + 'reaching the end of the list, which is more than this check will read',
  }
}

/**
 * The read a DISMISSAL is made on: the same walk, run TWICE, with both answers required to agree.
 *
 * WHY A SECOND READ AND NOT A BETTER FIRST ONE. There is no better first one. Every property of a
 * positional page has now been used — an empty page to end the walk, no length rule at all, and the
 * store's own count against what it served — and a refund deleted behind the cursor defeats all of
 * them at once, because the id it removes was already banked and pays for the row it hides. The
 * arithmetic of a single walk simply cannot see it.
 *
 * WHAT THE SECOND READ ADDS. The row that goes missing goes missing BECAUSE some other row was
 * deleted, and that deleted row is sitting in the first read's list. The store cannot serve it
 * again, so the second read comes back without it and the two lists differ — refusing exactly the
 * case that no single walk can detect. It also catches the ordinary version of the same hazard: an
 * order being refunded WHILE an operator is deciding whether to write a refund off.
 *
 * WHAT IT COSTS. Twice the requests on the dismissal path — four for the ordinary order with a page
 * or less of refunds, where it was two. Paid because a refusal is retryable and a dismissal is not.
 *
 * WHAT IT IS NOT. It is not a snapshot and does not claim to be one. Two agreeing reads say the
 * collection was not changing across them, which is the strongest statement available to a client of
 * a collection it can only address by position.
 */
async function readConfirmedWcOrderRefundIds(
  wcOrderId: number,
): Promise<{ evidence: WcOrderRefundEvidence } | WcRefundReadFailure> {
  const first = await readWcOrderRefundIds(wcOrderId)
  if ('error' in first) return first
  const second = await readWcOrderRefundIds(wcOrderId)
  if ('error' in second) return second
  const disagreement = describeRefundReadDisagreement(
    { refundIds: first.evidence.refundIds, statedTotal: first.statedTotal },
    { refundIds: second.evidence.refundIds, statedTotal: second.statedTotal },
  )
  if (disagreement) return { moved: true, error: disagreement }
  // The SECOND read's evidence: same ids by construction, and the later `fetchedAt` is the honest
  // one to record — it is the moment the answer was last confirmed, not first guessed.
  return { evidence: second.evidence }
}

/** A read failure as the refusal an operator sees: a store that could not answer, or one that moved. */
function refuseOnRefundReadFailure(wcOrderId: number, failure: WcRefundReadFailure): RefundParkRecoveryRefusal {
  return failure.moved
    ? refuseUnstableRefundList(wcOrderId, failure.error)
    : refuseOnLookupFailure(wcOrderId, failure.error)
}

export async function recoverRefundSyncPark(
  id: string,
  input: RecoverRefundSyncParkInput,
): Promise<RecoverRefundSyncParkResult> {
  try {
    // Same guard as retryRefundSyncPark: `sync` is not held by READONLY or SUPPLIER, and a recovery
    // that moves a refund between orders is at least as ledger-affecting as a retry, so it takes the
    // FRESH variant too. A 'use server' export is a public HTTP endpoint; this is the only thing
    // between an authenticated session and a write that reassigns refund evidence.
    const session = await requireFreshPermission('sync')

    const assertion = normalizeRefundParkRecoveryAssertion(input)
    if (!assertion) {
      return {
        success: false,
        code: 'unrecognised_outcome',
        error: 'That recovery was not supplied correctly, so nothing was changed. Reload the exception '
          + 'inbox and recover from what it shows.',
      }
    }
    if (typeof input.observedOrderId !== 'string' || !input.observedOrderId) {
      return {
        success: false,
        code: 'unrecognised_outcome',
        error: 'The order this recovery was made about was not supplied, so nothing was changed. Reload '
          + 'the exception inbox and recover from what it shows.',
      }
    }

    const row = await db.shoppingSyncLog.findFirst({
      where: { id, ...REFUND_PARK_WHERE },
      select: { id: true, status: true, entityId: true, externalId: true },
    })
    const recoverability = describeRefundParkRecoverability(row ?? { status: 'SYNCED', entityId: null, externalId: null })
    if (!row || !recoverability.recoverable) {
      return {
        success: false,
        code: 'park_not_actionable',
        error: row
          ? recoverability.notRecoverableReason ?? 'This park cannot be recovered.'
          : 'That refund park no longer exists or is already resolved, so nothing was changed. Reload the '
            + 'exception inbox.',
      }
    }
    // Non-null by describeRefundParkRecoverability, which refuses a park with no order or no refund id.
    const parkedOrderId = row.entityId as string
    const externalRefundId = Number(row.externalId)
    if (!Number.isSafeInteger(externalRefundId) || externalRefundId <= 0) {
      return {
        success: false,
        code: 'park_not_actionable',
        error: `This park records "${row.externalId}" as its WooCommerce refund id, which is not a refund `
          + 'id WooCommerce can be asked about. Nothing was changed.',
      }
    }
    // The fence's first half, checked before WooCommerce is troubled: the operator judged a park
    // sitting on a particular order, and a park that has since moved is a different question.
    if (parkedOrderId !== input.observedOrderId) {
      return {
        success: false,
        code: 'park_moved',
        error: 'This park is no longer on the order it was shown against, so the recovery you asked for '
          + 'was not made. Reload the exception inbox and look again.',
      }
    }

    const park: RefundParkView = { id: row.id, status: row.status, entityId: parkedOrderId, externalId: row.externalId as string }

    // The refund as IMS currently records it, wherever it landed. Read again INSIDE the transaction
    // under the per-refund lock — this copy only lets a refusal be reported before WooCommerce is
    // asked and before any lock is taken.
    const landedBefore = await db.salesOrderRefund.findFirst({
      where: { externalRefundId },
      select: { orderId: true },
    })

    let refusal: RefundParkRecoveryRefusal | null = null
    let evidence: WcOrderRefundEvidence
    let targetOrderId: string | null = null

    if (assertion.outcome === 'REASSIGN') {
      // ONE walk, and the asymmetry is deliberate. A reassign is authorised by PRESENCE — WooCommerce
      // lists this refund on the order the operator named — and an incomplete list cannot manufacture
      // presence, only withhold it. The worst a short read does here is refuse a reassign that should
      // have been allowed, which the operator retries. A DISMISS is authorised by ABSENCE, where a
      // short list IS the wrong answer, so that path pays for a confirmed read and this one does not.
      const lookup = await readWcOrderRefundIds(assertion.wcOrderId)
      if ('error' in lookup) {
        const refused = refuseOnRefundReadFailure(assertion.wcOrderId, lookup)
        return { success: false, error: refused.message, code: refused.code }
      }
      evidence = lookup.evidence
      const targetLink = await db.shoppingOrderLink.findFirst({
        where: { connector: 'woocommerce', externalOrderId: String(assertion.wcOrderId) },
        select: { orderId: true },
      })
      targetOrderId = targetLink?.orderId ?? null
      refusal = refuseReassign({
        park,
        externalRefundId,
        targetEvidence: evidence,
        targetOrderId,
        landedOnOrderId: landedBefore?.orderId ?? null,
      })
    } else {
      const parkedLink = await db.shoppingOrderLink.findFirst({
        where: { orderId: parkedOrderId, connector: 'woocommerce' },
        select: { externalOrderId: true },
      })
      const parkedWcOrderId = parkedLink ? Number(parkedLink.externalOrderId) : NaN
      let parkedEvidence: WcOrderRefundEvidence | null = null
      if (parkedLink && Number.isSafeInteger(parkedWcOrderId) && parkedWcOrderId > 0) {
        // TWICE, and both answers must agree. This list is about to be read as EVIDENCE OF ABSENCE and
        // a dismissal writes a refund off, so it is the one place where "the collection may have moved
        // under the pager" is not an acceptable residual risk.
        const lookup = await readConfirmedWcOrderRefundIds(parkedWcOrderId)
        if ('error' in lookup) {
          const refused = refuseOnRefundReadFailure(parkedWcOrderId, lookup)
          return { success: false, error: refused.message, code: refused.code }
        }
        parkedEvidence = lookup.evidence
      }
      refusal = refuseDismiss({
        park,
        externalRefundId,
        parkedEvidence,
        landedOnOrderId: landedBefore?.orderId ?? null,
      })
      // refuseDismiss returns parked_order_not_linked when there is no evidence, so past it the
      // evidence is present.
      evidence = parkedEvidence as WcOrderRefundEvidence
    }
    if (refusal) return { success: false, error: refusal.message, code: refusal.code }

    const now = new Date()
    const note = refundParkRecoveryNote(assertion, evidence, externalRefundId)

    const applied = await db.$transaction(async (tx) => {
      // o3d-ee9's key, and its ordering: the per-refund advisory lock FIRST, then any order row lock,
      // matching createSalesOrderRefund and upsertRefundPark so none of the three can deadlock. Held
      // to commit, so a refund create for this id either happens entirely before this recovery (and
      // is seen by the re-read below) or entirely after it (and sees the recovered park).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`wc_refund:${externalRefundId}`}))`

      // Re-read under the lock. Between the WooCommerce fetch above and this transaction the refund
      // may have landed — on this park's order (the park is then a leftover, not a foreign one) or on
      // another. Both are refusals with their own remedy, not something to write through.
      const landed = await tx.salesOrderRefund.findFirst({ where: { externalRefundId }, select: { orderId: true } })
      const lateRefusal = assertion.outcome === 'REASSIGN'
        ? refuseReassign({ park, externalRefundId, targetEvidence: evidence, targetOrderId, landedOnOrderId: landed?.orderId ?? null })
        : refuseDismiss({ park, externalRefundId, parkedEvidence: evidence, landedOnOrderId: landed?.orderId ?? null })
      if (lateRefusal) return { ok: false as const, refusal: lateRefusal }

      if (assertion.outcome === 'REASSIGN') {
        // The same FOR UPDATE re-verify upsertRefundPark does before writing a park, and for the same
        // reason: deleteSalesOrder takes this lock, so without it the target order could be deleted
        // between the link lookup and this write, leaving an orphaned park on a gone order that
        // retryRefundSyncPark could never resolve.
        const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "sales_orders" WHERE id = ${targetOrderId as string} FOR UPDATE`
        if (rows.length === 0) {
          return {
            ok: false as const,
            refusal: {
              code: 'target_order_missing' as const,
              message: 'The order you named was deleted while this recovery was being made, so nothing was '
                + 'changed — a park must never be written onto an order that no longer exists.',
            },
          }
        }
      }

      // The fence's second half, and the only write. Conditioned on the park still being on the order
      // the operator judged AND still actionable, so a concurrent resolve, retry or re-park is not
      // overwritten by a conclusion formed about the row as it was.
      const updated = await tx.shoppingSyncLog.updateMany({
        where: {
          id: park.id,
          connector: 'woocommerce',
          direction: 'FROM_CONNECTOR',
          entityType: 'SalesOrder',
          externalId: park.externalId,
          entityId: park.entityId,
          status: { in: [...RECOVERABLE_REFUND_PARK_STATUSES] },
        },
        data: assertion.outcome === 'REASSIGN'
          ? buildRefundParkReassignData(targetOrderId as string, note, now)
          : buildRefundParkDismissData(note, now),
      })
      if (updated.count !== 1) {
        return {
          ok: false as const,
          refusal: {
            code: 'park_moved' as const,
            message: 'This park changed while the recovery was being made — it was resolved, retried or '
              + 'moved by something else — so nothing was changed. Reload the exception inbox and look again.',
          },
        }
      }
      return { ok: true as const }
    })

    if (!applied.ok) return { success: false, error: applied.refusal.message, code: applied.refusal.code }

    await logActivity({
      entityType: 'SYNC',
      entityId: parkedOrderId,
      tag: 'sync',
      action: 'wc_refund_park_recovered',
      // WARNING, not INFO: a human correcting an order association on a refund whose money has
      // already left the business, on evidence the system could not act on by itself.
      level: 'WARNING',
      description: assertion.outcome === 'REASSIGN'
        ? `Reassigned parked WooCommerce refund ${externalRefundId} from order ${parkedOrderId} to order `
          + `${targetOrderId} after WooCommerce confirmed it on WC order ${evidence.wcOrderId}`
        : `Dismissed the parked WooCommerce refund ${externalRefundId} on order ${parkedOrderId} after `
          + `WooCommerce order ${evidence.wcOrderId} did not list it`,
      metadata: {
        shoppingSyncLogId: park.id,
        externalRefundId,
        outcome: assertion.outcome,
        parkedOrderId,
        targetOrderId,
        // What was asked, and what came back — so the recovery can be re-judged later against the
        // evidence it was actually made on rather than against WooCommerce as it is by then.
        wcOrderId: evidence.wcOrderId,
        wcRefundIds: [...evidence.refundIds],
        wcFetchedAt: evidence.fetchedAt.toISOString(),
        // How many complete walks the evidence had to survive. A dismissal is made on two that agreed;
        // a reassign on one, because presence cannot be produced by a short list. Recorded so the
        // recovery can be re-judged later on the standard of proof it was actually held to.
        wcEvidenceReads: assertion.outcome === 'DISMISS' ? 2 : 1,
        priorStatus: park.status,
        userId: session.user.id,
      },
    })
    revalidatePath('/sync/exceptions')
    return { success: true, outcome: assertion.outcome, targetOrderId }
  } catch (error) {
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    throw error
  }
}

/**
 * Replay a dispatch reconciliation the sweep gave up on: clear the marker and
 * the streak so the next sweep retries the order. Use after fixing the
 * underlying cause — typically the order's IMS stock position (dead-letter), or
 * the WMS record itself (o3d-bjc.9 quarantine).
 */
export async function replayStuckDispatch(orderId: string): Promise<MutationResult> {
  try {
    const session = await requireFreshPermission('sync')
    const updated = await db.wmsOrderPushLink.updateMany({
      where: {
        orderId,
        OR: [{ dispatchDeadLetteredAt: { not: null } }, { dispatchUnresolvedAt: { not: null } }],
      },
      // BOTH streaks: a link can hold an unresolved quarantine and a dead-letter
      // at once, and replaying one while the other still excludes it from the
      // candidate set would report success and change nothing.
      data: {
        dispatchDeadLetteredAt: null,
        dispatchFailureCount: 0,
        dispatchLastError: null,
        dispatchUnresolvedAt: null,
        dispatchUnresolvedCount: 0,
        dispatchUnresolvedError: null,
      },
    })
    if (updated.count === 0) {
      return { success: false, error: 'The dispatch is no longer held back (already replayed).' }
    }
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      tag: 'sync',
      action: 'wms_dispatch_replay',
      description: 'Re-queued a dead-lettered dispatch reconciliation via the exception inbox',
      metadata: { orderId, userId: session.user.id },
    })
    revalidatePath('/sync/exceptions')
    return { success: true }
  } catch (error) {
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    throw error
  }
}

/**
 * o3d-rbyg round 2, Codex finding 3: THE REMEDY FOR GOODS THAT HAVE ALREADY GONE.
 *
 * Round 1 flagged this against itself: a withdrawn order the warehouse has ALREADY despatched is
 * refused by the dispatch fence and parked — goods gone, IMS showing it unshipped, stock still on
 * the shelf in the sub-ledger — "until an operator acts". The inbox then offered exactly one
 * action, Replay, which re-runs the same screen, hits the same standing withdrawal and re-parks the
 * link. A refusal whose only offered remedy cannot work is a refusal with no remedy.
 *
 * This is that remedy. It is deliberately NOT a bypass flag on the fence:
 *
 *   - THE WMS MUST SAY THE GOODS WENT. The operator's claim is verified against the warehouse
 *     before anything irreversible happens, exactly as the sweep verifies it. If the WMS does not
 *     report the order despatched, this refuses and the link stays parked.
 *   - THE HOLD IS RELEASED, NOT IGNORED. Recording a despatch against a live withdrawal hold is a
 *     decision about the customer's request — the goods have left, so it is a RETURN now, not a
 *     withheld shipment — so it goes through `releaseWithdrawalHold`, with its generation guard and
 *     its audit row, rather than around it. A hold raised again after the page was rendered fails
 *     that guard and this action stops.
 *   - THE TOMBSTONE IS NOT TOUCHED. It is retired only by the quiescence protocol, never by an
 *     ad-hoc decision. It does not need to be: once the order is SHIPPED it is outside
 *     `dispatchCandidateWhere` altogether, so a standing tombstone fences nothing that can still
 *     happen.
 *   - THE FULFILMENT IS THE SWEEP'S OWN. `reconcileOneOrder` does the work — split parts, merge
 *     repointing, tracking, the despatch email — so this action cannot drift from what a normal
 *     dispatch does, and it takes the sweep's lock so it cannot run beside one.
 *
 * An APPROVED withdrawal is refused here on purpose: that order is CANCELLED, IMS will not record a
 * shipment against a cancelled order (nor should it), and the parcel in flight is a return. That
 * case gets `dismissWithdrawnDispatch` instead.
 */
export async function recordWithdrawnDespatch(orderId: string): Promise<MutationResult> {
  try {
    const session = await requireFreshPermission('sync')
    const connectorId = await getEnabledWmsConnectorId()
    if (!connectorId) {
      return { success: false, error: 'No WMS connector is enabled, so there is no warehouse to confirm the despatch against.' }
    }

    const outcome = await withDispatchSweepLockOrSkip(connectorId, async (): Promise<MutationResult> => {
      // Everything below is re-read UNDER the lock: the page may have been open for a while, and
      // the sweep itself may have resolved, replayed or re-parked this link since it rendered.
      const link = await db.wmsOrderPushLink.findUnique({
        where: { orderId },
        select: {
          id: true,
          connector: true,
          state: true,
          externalOrderId: true,
          externalOrderNumber: true,
          dispatchDeadLetteredAt: true,
          // o3d-rbyg r4: the hold GENERATION as it stands under the sweep lock, carried to
          // `releaseWithdrawalHold` so the release is guarded on the request this action decided
          // about rather than on whatever the release re-reads for itself moments later.
          order: {
            select: {
              status: true, orderNumber: true, withdrawalHoldAt: true, withdrawalApprovedAt: true,
              withdrawalHoldGeneration: true,
            },
          },
        },
      })
      if (!link || link.connector !== connectorId) {
        return { success: false, error: 'This order has no link on the enabled WMS connector.' }
      }
      if (!link.dispatchDeadLetteredAt) {
        return { success: false, error: 'This dispatch is no longer held back — the sweep has it again (already resolved).' }
      }
      if (link.state !== 'SYNCED' && link.state !== 'MERGED') {
        return { success: false, error: `This link is ${link.state}, so it is not waiting on a dispatch. Resolve it from the order instead.` }
      }
      if (!link.externalOrderNumber) {
        return { success: false, error: 'This link has no WMS order number, so its despatch cannot be confirmed.' }
      }
      if (link.order.withdrawalApprovedAt || link.order.status === 'CANCELLED') {
        return {
          success: false,
          error: 'This order’s withdrawal was APPROVED and the order cancelled, so IMS cannot record a shipment '
            + 'against it. The parcel that left is a return: book the goods back in when they arrive (or write the '
            + 'stock off if they do not), then use Dismiss to clear this row.',
        }
      }

      // This action exists for ONE situation, and it checks that the situation is real rather than
      // trusting the button that was clicked: the page decides which control to show from the same
      // local evidence, but a server action that took the client's word for it would be a general
      // "dispatch this link anyway" — and that is not a decision anyone made here.
      const { screenLocalWithdrawalEvidence } = await import('@/lib/connectors/woocommerce/sync/withdrawal')
      const standing = await screenLocalWithdrawalEvidence([orderId])
      if (!standing.has(orderId)) {
        return {
          success: false,
          error: 'No withdrawal stands against this order any more, so there is nothing for this action to decide. '
            + 'Replay it instead — the sweep will dispatch it normally.',
        }
      }

      // Confirm with the warehouse BEFORE anything is released or applied. A split order's primary
      // row can read undespatched while its parts have shipped, so a split is passed through to the
      // per-part reconcile below, which is the only thing that can answer for it.
      const connector = getWmsConnector(connectorId)
      const deps = createPrismaDispatchDeps(connectorId, connector)
      const status = await deps.fetchOrderStatus(link.externalOrderNumber)
      if (!status) {
        return { success: false, error: `The WMS did not return order ${link.externalOrderNumber}, so its despatch cannot be confirmed. Nothing was changed.` }
      }

      // o3d-rbyg r4 (Codex r3 finding 2). THE ANSWER MUST BE ABOUT *THIS* LINK'S WMS ORDER.
      // `fetchOrderStatus` takes an order NUMBER, and a number is a lookup key rather than an
      // identity — renameable at the WMS, reusable, and answered under a combined number by a merge
      // survivor. Reading "despatched" off an unbound record and then dispatching on it consumes
      // stock and sends a despatch email for a parcel that may be someone else's. The binding rule
      // is the sweep's own (`bindWmsStatusToCandidate`), called rather than copied, and the same
      // claimant count the sweep uses decides whether a merge claim can be trusted at all.
      const claimants = await deps.countLinksByOrderNumber?.([link.externalOrderNumber])
      const mergeNumberUnique = claimants
        ? (claimants.get(link.externalOrderNumber) === undefined ? undefined : claimants.get(link.externalOrderNumber) === 1)
        : undefined
      const binding = bindWmsStatusToCandidate(
        status,
        { externalOrderNumber: link.externalOrderNumber, externalOrderId: link.externalOrderId },
        mergeNumberUnique,
        // This record came from a BY-NUMBER lookup a line above, so when the link carries no stable
        // id the number is the only binding left and it has to be the same number. The sweep does
        // not pass this: its rows are preloaded by stable id, where a RENAMED order legitimately
        // answers under a number the link has never heard of.
        { lookedUpByNumber: true },
      )
      if (!binding.bound) {
        return {
          success: false,
          error: `The WMS answered for ${link.externalOrderNumber} with a record that is not this link's order — ${binding.reason}. `
            + 'Nothing was changed. Check the order at the warehouse (it may have been renamed, merged, or its number reused) '
            + 'before recording a despatch against it.',
        }
      }

      if (!status.dispatched && !status.isSplit) {
        return {
          success: false,
          error: `The WMS reports ${link.externalOrderNumber} as "${status.status || 'unknown'}", not despatched — there is nothing to record. `
            + 'Cancel it at the WMS while the withdrawal stands; this row clears itself once the order is cancelled.',
        }
      }

      // The customer's request outlives the goods: released here as an explicit operator decision,
      // audited, and only because the warehouse has just said the parcel is gone.
      if (link.order.withdrawalHoldAt) {
        const released = await releaseWithdrawalHold(
          orderId,
          // o3d-rbyg r4 (Codex r3 finding 1): the generation READ UNDER THE SWEEP LOCK, before the
          // warehouse round trip. Round 3 was careful that the release goes THROUGH the generation
          // guard rather than around it — but the guard compared the value the release had just
          // fetched for itself against itself, which is satisfied by construction. A customer who
          // files a NEW withdrawal while the WMS call is in flight had their request cleared by a
          // decision taken before it existed.
          { generation: link.order.withdrawalHoldGeneration },
          'The warehouse had already despatched this order when the withdrawal was found. The hold is released so '
          + 'the despatch can be recorded; the request is handled as a return.',
        )
        if (!released.success) {
          return { success: false, error: released.error ?? 'The withdrawal hold could not be released, so nothing was recorded.' }
        }
      }

      const candidate = {
        linkId: link.id,
        orderId,
        externalOrderNumber: link.externalOrderNumber,
        externalOrderId: link.externalOrderId,
      }
      // The stable id and the claimant count go THROUGH, so the sweep's own identity guard applies
      // to the dispatch as well as to the confirmation above. Passing neither — which is what this
      // call did — disabled that guard on the one path a person had just authorised.
      const reconciled = await reconcileOneOrder(
        deps,
        candidate,
        status,
        link.externalOrderId ?? undefined,
        false,
        mergeNumberUnique,
      )
      if (reconciled.action !== 'dispatched') {
        // The hold, if there was one, has been released and is NOT silently re-applied: re-writing
        // a customer's withdrawal marker from a failed repair would fabricate a request state
        // nobody asked for, and the release is already on the order's timeline. The link stays
        // parked, so nothing fulfils behind this failure.
        return {
          success: false,
          error: `The despatch could not be recorded: ${reconciled.reason}. The link is still held back, and the `
            + 'withdrawal hold (if there was one) has been released and logged on the order.',
        }
      }

      // Only now is the park cleared — the order is SHIPPED, so the link has left the candidate set
      // anyway and this is bookkeeping that stops the row lingering in the inbox.
      await db.wmsOrderPushLink.updateMany({
        where: { id: link.id, dispatchDeadLetteredAt: { not: null } },
        data: { dispatchDeadLetteredAt: null, dispatchFailureCount: 0, dispatchLastError: null },
      })
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: orderId,
        tag: 'sync',
        action: 'wms_dispatch_withdrawn_despatch_recorded',
        level: 'WARNING',
        description: `Operator recorded the despatch of ${link.order.orderNumber ?? orderId} (WMS ${link.externalOrderNumber}) `
          + 'after a withdrawal was found against it: the warehouse confirmed the goods had already gone, so the shipment, '
          + 'the stock relief and the despatch notification were applied and the request becomes a return.',
        metadata: { orderId, connector: connectorId, externalOrderNumber: link.externalOrderNumber, userId: session.user.id },
        resolveUser: false,
      })
      revalidatePath('/sync/exceptions')
      revalidatePath(`/sales/${orderId}`)
      return { success: true }
    })
    if ('lockSkipped' in outcome) {
      return { success: false, error: 'A dispatch sweep is running right now — try again in a moment.' }
    }
    return outcome
  } catch (error) {
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    throw error
  }
}

/**
 * o3d-rbyg round 2: the other half of finding 3 — clear a withheld row whose order is TERMINAL.
 *
 * When the withdrawal was approved the order is CANCELLED, and a cancelled order is outside
 * `dispatchCandidateWhere` entirely: clearing the park cannot let anything fulfil, because there is
 * nothing left for the sweep to select. That is what makes this safe here and refused everywhere
 * else — on a live order, clearing the park just hands the link back to a screen that will re-park
 * it, which is the loop this whole finding is about.
 *
 * It resolves the INBOX ROW, not the goods. Whatever left the warehouse is a return, and the
 * activity row says so, so nobody later reads a cleared exception as evidence the stock came back.
 */
export async function dismissWithdrawnDispatch(orderId: string): Promise<MutationResult> {
  try {
    const session = await requireFreshPermission('sync')
    const link = await db.wmsOrderPushLink.findUnique({
      where: { orderId },
      select: {
        id: true,
        externalOrderNumber: true,
        dispatchDeadLetteredAt: true,
        dispatchUnresolvedAt: true,
        order: { select: { status: true, orderNumber: true } },
      },
    })
    if (!link) return { success: false, error: 'This order has no WMS link.' }
    if (!link.dispatchDeadLetteredAt && !link.dispatchUnresolvedAt) {
      return { success: false, error: 'This dispatch is no longer held back (already resolved).' }
    }
    if (link.order.status !== 'CANCELLED') {
      return {
        success: false,
        error: `Dismiss only applies to a CANCELLED order — this one is ${link.order.status}, so clearing the hold-back `
          + 'would simply hand it to the same screen and it would be held back again. Record the despatch if the goods '
          + 'have gone, or resolve the withdrawal on the order and replay.',
      }
    }

    const cleared = await db.wmsOrderPushLink.updateMany({
      where: {
        id: link.id,
        OR: [{ dispatchDeadLetteredAt: { not: null } }, { dispatchUnresolvedAt: { not: null } }],
      },
      data: {
        dispatchDeadLetteredAt: null,
        dispatchFailureCount: 0,
        dispatchLastError: null,
        dispatchUnresolvedAt: null,
        dispatchUnresolvedCount: 0,
        dispatchUnresolvedError: null,
      },
    })
    if (cleared.count === 0) {
      return { success: false, error: 'This dispatch is no longer held back (already resolved).' }
    }
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      tag: 'sync',
      action: 'wms_dispatch_withdrawn_dismissed',
      level: 'WARNING',
      description: `Operator dismissed the withheld dispatch for cancelled order ${link.order.orderNumber ?? orderId} `
        + `(WMS ${link.externalOrderNumber ?? '—'}). The order stays CANCELLED and IMS records no shipment for it; `
        + 'anything the warehouse despatched is handled as a return, and this clears only the exception row.',
      metadata: { orderId, userId: session.user.id },
      resolveUser: false,
    })
    revalidatePath('/sync/exceptions')
    return { success: true }
  } catch (error) {
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    throw error
  }
}

/**
 * Re-create a WMS order the WMS no longer knows (MISSING_IN_WMS reconcile
 * finding): compare-and-set the SYNCED/MERGED link back to PENDING_CREATE so
 * the next push sweep re-pushes it. The sweep's own eligibility still applies,
 * so a no-longer-eligible order simply won't re-push.
 */
export async function repushMissingWmsOrder(orderId: string): Promise<MutationResult> {
  try {
    const session = await requireFreshPermission('sync')

    // Codex r17: the durable row may be STALE (order restored/recreated in the
    // WMS since the sweep ran) — a reset would then make the push sweep create
    // a DUPLICATE. Revalidate absence live, and only for the active connector.
    const pluginState = await getIntegrationPluginState()
    const activeConnectorId = WMS_CONNECTOR_IDS.find((id) => pluginState[id])
    const openFinding = await db.wmsOrderDiscrepancy.findFirst({
      where: { orderId, category: 'MISSING_IN_WMS', status: 'OPEN' },
      select: { connector: true },
    })
    if (!openFinding) {
      return { success: false, error: 'No open missing-in-WMS finding for this order (already resolved or re-verified).' }
    }
    if (!activeConnectorId || openFinding.connector !== activeConnectorId) {
      return { success: false, error: 'This finding belongs to a connector that is no longer active — the next reconcile run retires it.' }
    }
    const connector = getWmsConnector(activeConnectorId)
    if (!connector.probeOrderPresence) {
      return { success: false, error: 'The active WMS connector cannot verify order absence, so a safe re-push is not possible.' }
    }
    // Codex r30 P1: the push sweep's create pass only selects ready
    // (PROCESSING/ALLOCATED), paid, not-fully-refunded orders — resetting the
    // link for e.g. a PICKING/PACKING order would resolve the finding while the
    // order is never re-created and silently never fulfils. Refuse; the
    // operator must return the order to a ready status first.
    const order = await db.salesOrder.findUnique({
      where: { id: orderId },
      select: { status: true, paidAt: true, refundStatus: true },
    })
    if (!order || !['PROCESSING', 'ALLOCATED'].includes(order.status) || !order.paidAt || order.refundStatus === 'FULL') {
      return {
        success: false,
        error: `The push sweep only re-creates paid, ready (Processing/Allocated) orders — this order is ${order?.status ?? 'missing'}. Return it to a ready status (or resolve it manually in the WMS); the finding stays open meanwhile.`,
      }
    }
    const link = await db.wmsOrderPushLink.findUnique({
      where: { orderId },
      select: { externalOrderNumber: true },
    })
    const presence = link?.externalOrderNumber
      ? await connector.probeOrderPresence(link.externalOrderNumber)
      : 'MISSING'
    if (presence === 'FOUND') {
      // The WMS knows the order again — the finding is stale; resolve it instead.
      await db.wmsOrderDiscrepancy.updateMany({
        where: { orderId, category: 'MISSING_IN_WMS', status: 'OPEN' },
        data: { status: 'RESOLVED', resolvedAt: new Date() },
      })
      return { success: false, error: 'The WMS knows this order again — the finding was stale and has been resolved. No re-push needed.' }
    }
    if (presence === 'AMBIGUOUS') {
      return { success: false, error: 'The WMS returned an ambiguous match for this order — re-pushing could create a duplicate. Resolve the ambiguity in the WMS first.' }
    }

    // Codex: an OPEN finding is the AUTHORIZATION for this reset, and the two
    // writes are one transaction — if the link reset doesn't apply, the finding
    // stays OPEN (it must not vanish from the inbox with the order unfixed).
    const outcome = await db.$transaction(async (tx) => {
      const finding = await tx.wmsOrderDiscrepancy.updateMany({
        where: { orderId, category: 'MISSING_IN_WMS', status: 'OPEN' },
        data: { status: 'RESOLVED', resolvedAt: new Date() },
      })
      if (finding.count === 0) {
        return { ok: false as const, error: 'No open missing-in-WMS finding for this order (already resolved or re-verified).' }
      }
      const updated = await tx.wmsOrderPushLink.updateMany({
        // CAS on the exact WMS reference that was probed absent (Codex r20): a
        // concurrent merge repoint changes externalOrderNumber, and clearing
        // the NEW survivor reference off a stale probe would let the push
        // sweep duplicate it.
        where: { orderId, state: { in: ['SYNCED', 'MERGED'] }, externalOrderNumber: link?.externalOrderNumber ?? null },
        data: {
          state: 'PENDING_CREATE',
          externalOrderId: null,
          externalOrderNumber: null,
          attempts: 0,
          lastError: null,
          dispatchFailureCount: 0,
          dispatchLastError: null,
          dispatchDeadLetteredAt: null,
          // The recency belonged to the MISSING order — the replacement must
          // rotate to the front of verification, not inherit it (Codex r9).
          reconcileCheckedAt: null,
        },
      })
      if (updated.count === 0) {
        // Rolls back the finding resolution.
        throw new Error('REPUSH_LINK_NOT_RESETTABLE')
      }
      return { ok: true as const }
    }).catch((error) => {
      if (error instanceof Error && error.message === 'REPUSH_LINK_NOT_RESETTABLE') {
        return { ok: false as const, error: 'The push link is no longer in a re-pushable state.' }
      }
      throw error
    })
    if (!outcome.ok) {
      return { success: false, error: outcome.error }
    }
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      tag: 'sync',
      action: 'wms_order_repush',
      description: 'Re-queued a WMS-missing order for re-push via the exception inbox',
      metadata: { orderId, userId: session.user.id },
    })
    revalidatePath('/sync/exceptions')
    return { success: true }
  } catch (error) {
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    throw error
  }
}

/**
 * Clear the advisory order-total penny-mismatch flag once an operator has
 * reviewed the order (the push itself already went through; the flag only
 * records that IMS and WMS totals drifted by more than a penny).
 */
export async function clearPennyMismatchFlag(orderId: string): Promise<{ success: boolean; error?: string }> {
  const session = await requirePermission('sync')
  const updated = await db.wmsOrderPushLink.updateMany({
    where: { orderId, totalMismatchPence: { not: null } },
    data: { totalMismatchPence: null },
  })
  if (updated.count === 0) {
    return { success: false, error: 'The flag was already cleared.' }
  }
  await logActivity({
    entityType: 'SYNC',
    entityId: orderId,
    tag: 'sync',
    action: 'wms_push_total_mismatch_cleared',
    description: 'Cleared the WMS push order-total mismatch flag via the exception inbox',
    metadata: { orderId, userId: session.user.id },
  })
  revalidatePath('/sync/exceptions')
  return { success: true }
}

/**
 * o3d-bjc.12: isolate the orders in an indeterminate drift cohort.
 *
 * THE OPERATOR'S CALL, deliberately. The sweep refuses to take it: with no
 * healthy control to compare against, "these records are broken" and "this
 * connector is broken" are indistinguishable, and guessing wrong quarantines a
 * whole tenant for a fault one fix would have cleared. A human who has looked at
 * the WMS can tell, and this is how they say so.
 *
 * It applies the SAME quarantine the sweep would have: the links leave the
 * candidate set (so the delta watermark is released for everyone else) and each
 * one appears in this inbox as an ordinary replayable row.
 */
export async function isolateUnresolvedDriftCohort(connector: string, version: string, eligibleVersion: string): Promise<MutationResult> {
  try {
    const session = await requireFreshPermission('sync')
    // The ACTIVE connector, not merely a registered one (o3d-bjc.12). A
    // connector that has since been switched off leaves its last incident
    // behind; acting on that would quarantine dormant links on evidence nothing
    // is refreshing.
    const enabledConnector = await getEnabledWmsConnectorId()
    if (!enabledConnector || connector !== enabledConnector) {
      return { success: false, error: 'That WMS connector is not enabled — its incident is no longer being updated by any sweep.' }
    }
    // The SAME lock the sweep takes (o3d-bjc.12). Without it this reads cohort A
    // while a sweep commits cohort B, then deletes B's incident — isolating one
    // set of orders and silently retracting the offer for another.
    const outcome = await withDispatchSweepLockOrSkip(connector, async (): Promise<MutationResult> => {
      // Re-read UNDER the lock (o3d-0gzr). The check above happened before we
      // held anything, and connector enablement is not serialized by this lock,
      // so it can flip in between. Reading it again here shrinks the window to
      // the transaction, and the transaction closes the rest.
      const stillEnabled = await getEnabledWmsConnectorId()
      if (stillEnabled !== connector) {
        return { success: false, error: 'That WMS connector was switched off while this page was open — nothing was isolated.' }
      }
      const raw = await readRawDriftState(connector)
      const [incident] = await loadUnresolvedDriftIncidents([connector])
      if (!incident || !raw) {
        return { success: false, error: 'That connector is no longer reporting an unresolved cohort — nothing to isolate.' }
      }
      // The decision was taken against what the PAGE showed. A sweep can replace
      // the cohort between render and click, and isolating whatever happens to
      // be current would quarantine orders nobody reviewed.
      if (incident.version !== version) {
        return { success: false, error: 'These orders changed since the page loaded — reload and review the current set before isolating.' }
      }
      const isolatedAt = new Date()
      const reason = `Isolated by an operator: ${incident.linkCount} order(s) unreadable on ${connector} since `
        + `${incident.firstSeenAt ?? 'an earlier pass'}${incident.reason ? ` — ${incident.reason}` : ''}`

      // ONE transaction: quarantining the links and retracting the incident are
      // the same decision. Split across two commits, a failure between them
      // leaves orders quarantined while the action reports failure and the
      // stale offer stays on screen.
      let isolated: number
      try {
        isolated = await db.$transaction(async (tx) => {
          // Enablement is part of the WRITE (o3d-0gzr), and reading it is not
          // enough (r2): under READ COMMITTED a plain SELECT takes no lock, so a
          // disable can commit between this read and our own commit and nothing
          // ever conflicts. Lock the row FOR UPDATE — a concurrent disable then
          // blocks until this transaction ends, and sees the quarantine.
          const pluginKey = INTEGRATION_PLUGIN_SETTING_KEYS[connector as keyof typeof INTEGRATION_PLUGIN_SETTING_KEYS]
          const pluginRows = await tx.$queryRaw<{ value: string }[]>`
            SELECT value FROM settings WHERE key = ${pluginKey} FOR UPDATE
          `
          if (pluginRows[0]?.value !== 'true') {
            throw new DriftIsolationAborted('That WMS connector was switched off while this page was open — nothing was isolated.')
          }
          // The set the operator reviewed must still be the set we are about to
          // write (o3d-0gzr r2). `version` guards the STORED cohort; eligibility
          // is re-evaluated here and can have moved without the store changing,
          // which would quarantine an order nobody saw.
          const eligibleNow = await tx.wmsOrderPushLink.findMany({
            where: isolatableLinkWhere(incident),
            select: { id: true },
          })
          if (eligibleCohortDigest(eligibleNow.map((row) => row.id)) !== eligibleVersion) {
            throw new DriftIsolationAborted('These orders changed since the page loaded — reload and review the current set before isolating.')
          }
          // An empty eligible set is not "isolate nothing", it is "isolate
          // whatever the predicate matches by the time the write runs"
          // (o3d-0gzr r3). The action is directly invocable, so refuse it here
          // rather than relying on the UI not to offer it.
          if (eligibleNow.length === 0) {
            throw new DriftIsolationAborted('Those orders have already resolved, shipped or been isolated — nothing left to do.')
          }
          const reviewedIds = eligibleNow.map((row) => row.id)
          // Write the ids we MATERIALISED, not the predicate again (o3d-0gzr r3).
          // Re-running the predicate looks equivalent and is not: these are two
          // statements in a READ COMMITTED transaction, so they see different
          // snapshots, and a link that becomes eligible in between would be
          // quarantined without ever appearing in the digest or on the page.
          // Naming the ids removes the second evaluation entirely.
          const updated = await tx.wmsOrderPushLink.updateMany({
            where: { ...isolatableLinkWhere(incident), id: { in: reviewedIds } },
            data: { dispatchUnresolvedAt: isolatedAt, dispatchUnresolvedError: reason },
          })
          // ...and the set must not have SHRUNK under us either: fewer rows than
          // reviewed means something changed mid-write, which is a re-review,
          // not a partial success.
          if (updated.count !== reviewedIds.length) {
            throw new DriftIsolationAborted('These orders changed while the isolation was being applied — reload and review the current set.')
          }
          {
            // Compare-and-set: only retract the incident we actually acted on. A
            // sweep that wrote a NEWER one while we worked keeps its offer.
            const retracted = await tx.setting.deleteMany({ where: { key: unresolvedDriftStateKey(connector), value: raw } })
            // ...and the CAS has to be able to FAIL the whole thing (o3d-0gzr).
            // Ignoring this count is what made "one transaction" only half true:
            // a sweep that replaced the state between our read and this delete
            // matches zero rows, and the quarantine would still commit — orders
            // isolated against an offer that no longer existed, reported as
            // success, with the newer incident still on screen. Rolling back is
            // the only outcome consistent with the claim.
            if (retracted.count !== 1) {
              throw new DriftIsolationAborted('That incident was replaced while you were deciding — reload and review the current set.')
            }
          }
          return updated.count
        })
      } catch (error) {
        // A rolled-back isolation is a normal outcome here, not a crash: the
        // operator's offer went stale mid-write. Nothing was quarantined.
        if (error instanceof DriftIsolationAborted) return { success: false, error: error.message }
        throw error
      }

      if (isolated === 0) {
        return { success: false, error: 'Those orders have already resolved, shipped or been isolated — nothing left to do.' }
      }
      await logActivity({
        entityType: 'SYSTEM',
        tag: 'sync',
        action: 'wms_dispatch_drift_isolated',
        description: `Operator isolated ${isolated} unreadable ${connector} order(s) from the dispatch sweep`,
        metadata: { connector, requested: incident.linkCount, isolated, userId: session.user.id, reason },
        level: 'WARNING',
        resolveUser: false,
      })
      revalidatePath('/sync/exceptions')
      return { success: true }
    })
    if ('lockSkipped' in outcome) {
      return { success: false, error: 'A dispatch sweep is running right now — try again in a moment.' }
    }
    return outcome
  } catch (error) {
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    throw error
  }
}

/**
 * o3d-bjc.12: drop the drift state so the next sweep re-evaluates from scratch.
 *
 * For the other half of the decision — "I fixed the connector". It clears the
 * incident and the escalation counter WITHOUT touching any link, so nothing is
 * isolated and the next pass either finds everything readable (and the cursor
 * moves) or raises the incident again with a fresh first-seen.
 */
export async function retryUnresolvedDriftCohort(connector: string, version: string): Promise<MutationResult> {
  try {
    const session = await requireFreshPermission('sync')
    // The ACTIVE connector, not merely a registered one (o3d-bjc.12). A
    // connector that has since been switched off leaves its last incident
    // behind; acting on that would quarantine dormant links on evidence nothing
    // is refreshing.
    const enabledConnector = await getEnabledWmsConnectorId()
    if (!enabledConnector || connector !== enabledConnector) {
      return { success: false, error: 'That WMS connector is not enabled — its incident is no longer being updated by any sweep.' }
    }
    const outcome = await withDispatchSweepLockOrSkip(connector, async (): Promise<MutationResult> => {
      const raw = await readRawDriftState(connector)
      if (!raw) {
        return { success: false, error: 'That connector is no longer reporting an unresolved cohort.' }
      }
      const [current] = await loadUnresolvedDriftIncidents([connector])
      if (!current || current.version !== version) {
        return { success: false, error: 'The incident changed since the page loaded — reload and check the new one.' }
      }
      // Compare-and-set for the same reason as isolate: a sweep that raised a
      // NEWER incident while we worked must keep it, or the operator would be
      // told "cleared" about evidence they never saw.
      const deleted = await db.setting.deleteMany({
        where: { key: unresolvedDriftStateKey(connector), value: raw },
      })
      if (deleted.count === 0) {
        return { success: false, error: 'The incident changed while you were looking at it — reload and check the new one.' }
      }
      await logActivity({
        entityType: 'SYSTEM',
        tag: 'sync',
        action: 'wms_dispatch_drift_retry',
        description: `Operator cleared the ${connector} unresolved-drift incident for re-evaluation`,
        metadata: { connector, userId: session.user.id },
        level: 'INFO',
        resolveUser: false,
      })
      revalidatePath('/sync/exceptions')
      return { success: true }
    })
    if ('lockSkipped' in outcome) {
      return { success: false, error: 'A dispatch sweep is running right now — try again in a moment.' }
    }
    return outcome
  } catch (error) {
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    throw error
  }
}

// -------------------------------------------------------------------------------------------------
// o3d-hl8l r5 (Codex r4 finding 1) — WHAT AN OPERATOR CAN DO ABOUT A REFUSED CALLBACK.
//
// The maintenance fence refuses inbound booked-in callbacks with a 503 and writes no row, which is
// deliberate and unavoidable: it runs before signature verification, and rows written into the
// window are being replayed over. Round 4 made the ordinary window recover itself — the close is
// stamped and a five-minute cron drains the stamp by re-checking every open ASN. But the branch the
// fence exists FOR, a restore whose backend could not be confirmed gone, never closes that way: it
// holds the flag, never calls `disableMaintenanceMode`, and so never stamps anything. The remedy was
// an UPDATE typed at a database prompt by hand, which ends the window and schedules nothing.
// (Deliberately not naming the client binary: tests/accounting/plugin-selection-lock.test.ts scans
// for that name to find files that SHELL OUT to it, and this file does not — every statement here
// runs inside an app transaction. Classifying it there would assert a database-execution path that
// does not exist.)
//
// These two actions are that branch's remedy, and neither trusts the button that invoked it: each
// re-reads the settings rows `FOR UPDATE` and refuses, by name, when the precondition it depends on
// does not hold at the moment of the click.
// -------------------------------------------------------------------------------------------------

/** Human wording for each refusal, so the operator is told what to do rather than what failed. */
const MAINTENANCE_REFUSAL_MESSAGES: Record<string, string> = {
  [MAINTENANCE_RECOVERY_REFUSALS.notInMaintenance]:
    'Maintenance mode is already off — the window has been ended already (possibly by someone else). Nothing was changed.',
  [MAINTENANCE_RECOVERY_REFUSALS.noHoldRecorded]:
    'Maintenance mode is on but no held restore was recorded, which is what a restore that is still RUNNING looks like. '
    + 'Ending it now would let scheduled jobs and webhooks write into a live restore. Nothing was changed.',
  [MAINTENANCE_RECOVERY_REFUSALS.holdUnreadable]:
    'The recorded hold does not name a database backend, so there is nothing to verify before clearing the flag. '
    + 'Confirm by hand that the restore backend is gone, then clear `system_maintenance_mode` in `settings`.',
  [MAINTENANCE_RECOVERY_REFUSALS.backendStillRunning]:
    'The restore’s database backend is STILL ATTACHED — it may still be writing. Terminate it and try again. Nothing was changed.',
  [MAINTENANCE_RECOVERY_REFUSALS.backendIndeterminate]:
    'Could not determine whether the restore’s database backend is still attached, so the hold was left in place. Nothing was changed.',
  [MAINTENANCE_RECOVERY_REFUSALS.maintenanceModeOn]:
    'Maintenance mode is still on. A re-check run now is fenced at the same gate the callbacks were, so it would do nothing. '
    + 'End the maintenance window first.',
  [MAINTENANCE_RECOVERY_REFUSALS.noRecheckDue]:
    'No maintenance window is waiting to be re-checked — either none has closed since the last run, or the re-check has already drained.',
  [MAINTENANCE_RECOVERY_REFUSALS.holdSuperseded]:
    'The held restore recorded now is NOT the one this page showed you — another restore has been recorded since. '
    + 'Nothing was changed. Reload the exception inbox and read the new hold before ending it.',
  [MAINTENANCE_RECOVERY_REFUSALS.recheckMarkerMoved]:
    'The re-check ran, but the window it was recorded against changed while it was running, so the marker was left in '
    + 'place for the newer window. Nothing was lost — the next run re-checks it.',
}

/**
 * END A HELD MAINTENANCE WINDOW.
 *
 * Refuses unless, re-read under the lock: the flag is on, a hold really was recorded, the record
 * names a backend, and that backend is GONE from `pg_stat_activity` by `(pid, backend_start)` — the
 * same pair the restore endpoint identified it by, because a pid alone is reused and
 * `application_name` is a GUC the replayed SQL can change.
 *
 * When it does clear the flag it stamps `wms_booked_in_recheck_due_since` in the SAME transaction,
 * so this window finally gets the automatic re-check every normally-closed one has had since round
 * 4. That is the half a hand-written UPDATE always missed, and it is why this action exists at all
 * rather than a line of documentation telling someone which row to edit.
 */
export async function endHeldMaintenanceWindow(
  /**
   * o3d-hl8l r6: WHICH hold the operator was looking at. Not a convenience — without it the action
   * ends whatever hold happens to be recorded at the moment of the click, which after a second
   * restore is a different window with a different backend and a different reason.
   */
  shown: MaintenanceHoldIdentity,
): Promise<MutationResult & { recheckDueSince?: string }> {
  try {
    const session = await requireFreshPermission('sync')

    // Server actions take their arguments over the wire, so the shape is checked here rather than
    // assumed from the component that renders the button.
    const expected: MaintenanceHoldIdentity | null =
      shown
        && typeof shown.backendPid === 'number'
        && Number.isInteger(shown.backendPid)
        && shown.backendPid > 0
        && typeof shown.backendStart === 'string'
        && shown.backendStart.trim() !== ''
        && typeof shown.heldAt === 'string'
        ? { backendPid: shown.backendPid, backendStart: shown.backendStart, heldAt: shown.heldAt }
        : null
    if (!expected) {
      return {
        success: false,
        error: 'The hold this page was showing could not be identified, so nothing was changed. Reload the exception inbox and try again.',
      }
    }

    const result = await db.$transaction(async (tx) => endMaintenanceHold(tx, {
      isRestoreBackendAttached: async ({ pid, backendStart }) => {
        try {
          // Matched on the pair, and on `backend_start` as TEXT: the restore endpoint captured the
          // server's own rendering of it and never parsed it into a Date, precisely so this
          // comparison cannot be lost to a timezone or a rounded microsecond.
          const rows = await tx.$queryRaw<Array<{ pid: number }>>`
            SELECT pid FROM pg_stat_activity WHERE pid = ${pid} AND backend_start::text = ${backendStart}`
          return rows.length > 0
        } catch (error) {
          console.error('[maintenance-recovery] could not read pg_stat_activity:', error)
          return null
        }
      },
    }, expected))

    if (!result.ended) {
      return {
        success: false,
        error: MAINTENANCE_REFUSAL_MESSAGES[result.reason]
          ?? `The maintenance hold was not ended (${result.reason}). Nothing was changed.`,
      }
    }

    await logActivity({
      entityType: 'SYSTEM',
      tag: 'system',
      action: 'maintenance_hold_ended',
      level: 'WARNING',
      description:
        `Ended the held maintenance window from the exception inbox — restore backend pid ${result.hold.backendPid} `
        + `(started ${result.hold.backendStart}) confirmed gone; a warehouse booked-in re-check is now due`,
      metadata: {
        userId: session.user.id,
        backendPid: result.hold.backendPid,
        backendStart: result.hold.backendStart,
        applicationName: result.hold.applicationName,
        heldAt: result.hold.heldAt,
        recheckDueSince: result.recheckDueSince,
      },
      resolveUser: false,
    })
    revalidatePath('/sync/exceptions')
    return { success: true, recheckDueSince: result.recheckDueSince }
  } catch (error) {
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    throw error
  }
}

/**
 * RUN THE POST-MAINTENANCE BOOKED-IN RE-CHECK NOW.
 *
 * The automatic drain lives on the warehouse webhook sweeper's five-minute cron. That cron is
 * `defaultEnabled: true`, but an installation that has disabled it — or whose scheduler is down,
 * which is not a rare state on the day a restore was needed — has no other way to run it, and "wait
 * five minutes and see" is not something an operator can verify.
 *
 * Refuses while maintenance mode is on (a re-check issued into the window is stopped at the same
 * gate the callbacks were) and when no window is actually pending. The marker is NOT cleared by the
 * claim: `runPostMaintenanceBookedInRecheck` clears it only once every open ASN has been attempted,
 * so claiming it here would drop the retry a truncated page depends on.
 */
export async function runPostMaintenanceRecheckNow(): Promise<MutationResult & {
  attempted?: number
  failed?: number
  drained?: boolean
}> {
  try {
    const session = await requireFreshPermission('sync')

    const claim = await db.$transaction((tx) => claimPostMaintenanceRecheck(tx))
    if (!claim.due) {
      return {
        success: false,
        error: MAINTENANCE_REFUSAL_MESSAGES[claim.reason] ?? `The re-check did not run (${claim.reason}).`,
      }
    }

    // Resolved behind the WMS boundary: null means no enabled connector performs a booked-in
    // re-check, in which case the marker is left alone because it is still owed.
    const result = await runPostMaintenanceRecheckForActiveConnector()
    if (!result) {
      return {
        success: false,
        error: 'No enabled warehouse connector performs a booked-in re-check, so nothing was run. '
          + 'The re-check is still recorded as due.',
      }
    }

    // o3d-hl8l r6: the claim above proved a re-check was owed at the instant of the click and
    // nothing about the minutes the pass takes. The pass re-reads the gate as it goes and names why
    // it stopped; reporting "done" over that would tell an operator the window was recovered when a
    // restore had just fenced it.
    if (result.refusal === 'maintenance_mode_on' || result.refusal === 'window_reopened') {
      return {
        success: false,
        error: `A maintenance window is in force, so the re-check ${result.attempted > 0 ? `stopped after ${result.attempted} ASN(s)` : 'did not start'}. `
          + 'It is still recorded as due and will run once the window ends. Nothing was lost.',
      }
    }

    await logActivity({
      entityType: 'SYNC',
      tag: 'sync',
      action: 'wms_post_maintenance_recheck_manual',
      level: result.failed > 0 ? 'WARNING' : 'INFO',
      description:
        `Ran the post-maintenance warehouse re-check by hand for the window that ended ${claim.windowEndedAt} — `
        + `${result.attempted} open ASN(s) attempted`
        + (result.failed > 0 ? `, ${result.failed} failed and will be retried` : '')
        + (result.drained ? '' : ' — more remain and the marker was kept'),
      metadata: {
        userId: session.user.id,
        connector: result.connector,
        windowEndedAt: claim.windowEndedAt,
        attempted: result.attempted,
        failed: result.failed,
        drained: result.drained,
      },
      resolveUser: false,
    })
    revalidatePath('/sync/exceptions')
    return { success: true, attempted: result.attempted, failed: result.failed, drained: result.drained }
  } catch (error) {
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    throw error
  }
}
