import { db } from '@/lib/db'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { WMS_CONNECTOR_IDS } from '@/lib/connectors/wms/types'
import { getWmsConnector } from '@/lib/connectors/wms/registry'
import type { WmsConnector, WmsOrderAddress, WmsOrderPushInput, WmsOrderPushLine } from '@/lib/connectors/wms/types'
import { scrubWmsError } from './error-scrub'
import { recordWmsMutationEvent, type WmsMutationEventInput } from './mutation-audit'

/**
 * Connector-agnostic outbound order-push sweep (Phase 8). Pushes IMS sales
 * orders to the active WMS for fulfilment and propagates cancellations.
 *
 * Eligibility (create): ship-from warehouse bound to the active WMS connector,
 * status ready-to-fulfil (PROCESSING/ALLOCATED), and paid. Idempotent via the
 * WmsOrderPushLink (orderId unique); failed pushes retry up to MAX_ATTEMPTS then
 * dead-letter. The reverse direction — inbound dispatch→tracking — flows via the
 * connector-agnostic dispatch sweep (lib/domain/wms/dispatch-sweep.ts), which feeds
 * applyExternalFulfillmentUpdate once the WMS reports the order despatched.
 */

const READY_STATUSES = ['PROCESSING', 'ALLOCATED'] as const
/** Lifecycle statuses where the WMS order is already dispatched. A (full) refund on a
 *  dispatched order is a returns/financial matter — never a WMS cancellation. Under the
 *  orthogonal refund model a fully-refunded order keeps its lifecycle status, so this set
 *  is what distinguishes "pull it from the WMS" from "goods already gone". */
const POST_DISPATCH_STATUSES = ['SHIPPED', 'COMPLETED', 'DELIVERED'] as const
const MAX_ATTEMPTS = 5
const DEFAULT_BATCH_SIZE = 25

export type WmsOrderPushSweepResult = {
  skipped?: string
  created: number
  updated: number
  cancelled: number
  held: number
  released: number
  failed: number
  deadLettered: number
}

type OrderForPush = {
  id: string
  orderNumber: string | null
  externalOrderNumber: string | null
  currency: string
  customerName: string | null
  customerEmail: string | null
  customerVatNumber: string | null
  shippingAddress: unknown
  shippingService: string | null
  subtotalForeign: unknown
  shippingForeign: unknown
  taxForeign: unknown
  taxRatePercent: unknown
  pricesIncludeVat: boolean
  discountAmount: unknown
  totalForeign: unknown
  lines: CandidateLine[]
  refunds?: Array<{ lines: Array<{ salesOrderLineId: string | null; qty: unknown }> }>
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * G6 (vn92.5) penny-precision guard. Returns the absolute drift, in pence, between an
 * order's declared total and the total re-derived from its own component fields
 * (subtotal + tax + shipping − discount). For a VAT-inclusive order the stored discount
 * is gross, so its embedded VAT must be added back (IMS computes tax on the discounted
 * net): validated against real orders — a £12 gross discount on a 20% order reconciles
 * only once its £2 VAT is added back. The effective rate is taken from taxRatePercent,
 * falling back to tax/(total−tax) when the named rate is absent.
 *
 * This is advisory only: the caller records the drift on the push link for operator
 * review but still pushes the order (a mis-derived formula must never block fulfilment).
 */
export function orderTotalDriftPence(order: {
  subtotalForeign: unknown
  taxForeign: unknown
  taxRatePercent: unknown
  shippingForeign: unknown
  discountAmount: unknown
  totalForeign: unknown
  pricesIncludeVat: boolean
}): number {
  const subtotal = num(order.subtotalForeign)
  const tax = num(order.taxForeign)
  const shipping = num(order.shippingForeign)
  const discount = num(order.discountAmount)
  const total = num(order.totalForeign)

  let discountVat = 0
  if (order.pricesIncludeVat && discount > 0) {
    const named = num(order.taxRatePercent)
    const rate = named > 0 ? named : total > tax ? tax / (total - tax) : 0
    if (rate > 0) discountVat = (discount * rate) / (1 + rate)
  }

  const computed = subtotal + tax + shipping - discount + discountVat
  return Math.round(Math.abs(computed - total) * 100)
}

/**
 * Rounded-pence drift ABOVE this is surfaced for review. orderTotalDriftPence rounds to
 * whole pence, so with `> 1` the effective trigger is ≥2p (a raw drift up to ~1.5p rounds
 * to 1 and is tolerated) — a rounded penny of slack, deliberately lenient for an advisory
 * flag so ordinary sub-penny VAT rounding never trips it.
 */
const TOTAL_DRIFT_TOLERANCE_PENCE = 1

export function readAddress(raw: unknown, customerName: string | null): WmsOrderAddress {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const str = (...keys: string[]): string => {
    for (const key of keys) {
      const v = a[key]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
    return ''
  }
  const [firstName, ...rest] = (customerName ?? '').trim().split(/\s+/).filter(Boolean)
  return {
    firstName: firstName ?? '',
    lastName: rest.join(' '),
    company: str('company'),
    address1: str('line1', 'address1', 'address_1'),
    address2: str('line2', 'address2', 'address_2'),
    town: str('city', 'town'),
    county: str('county', 'state'),
    postCode: str('postcode', 'postCode', 'postal_code'),
    country: str('country'),
  }
}

type CandidateLine = {
  id?: string
  sku: string | null
  qty: unknown
  taxForeign: unknown
  totalForeign: unknown
  description: string
}

export function buildLines(lines: CandidateLine[], refundedByLine?: Map<string, number>): WmsOrderPushLine[] {
  const pushLines: WmsOrderPushLine[] = []
  for (const line of lines) {
    // A line with no SKU can't be fulfilled by the WMS — fail the whole order
    // (caught → retried → dead-lettered) rather than silently dropping the line.
    if (!line.sku) throw new Error('Sales order has a line with no SKU; cannot push to WMS')
    const orderedQty = num(line.qty) || 1
    // Refunded units must not be pushed to the WMS for fulfilment (refund state is
    // orthogonal to the lifecycle status now). Net by the line's refunded qty; a fully
    // refunded line is dropped from the payload entirely.
    const refunded = (line.id && refundedByLine?.get(line.id)) || 0
    const quantity = Math.max(0, orderedQty - refunded)
    if (quantity <= 0) continue
    // IMS stores SalesOrderLine.totalForeign as NET (ex-VAT) in both tax-inclusive
    // and tax-exclusive cases; taxForeign is the line VAT. Unit prices are per the
    // ORIGINAL qty so they stay correct when the shipped quantity is reduced.
    const total = num(line.totalForeign)
    const tax = num(line.taxForeign)
    pushLines.push({
      sku: line.sku,
      quantity,
      unitPriceExVat: total / orderedQty,
      unitPriceVat: tax / orderedQty,
      description: line.description || null,
    })
  }
  return pushLines
}

// Fields the push payload needs; shared by the create and update passes.
const ORDER_PUSH_SELECT = {
  id: true,
  orderNumber: true,
  externalOrderNumber: true,
  currency: true,
  customerName: true,
  customerEmail: true,
  customerVatNumber: true,
  shippingAddress: true,
  shippingService: true,
  subtotalForeign: true,
  shippingForeign: true,
  taxForeign: true,
  taxRatePercent: true,
  pricesIncludeVat: true,
  discountAmount: true,
  totalForeign: true,
  lines: { select: { id: true, sku: true, qty: true, taxForeign: true, totalForeign: true, description: true } },
  refunds: { select: { lines: { select: { salesOrderLineId: true, qty: true } } } },
} as const

function buildPushInput(order: OrderForPush, externalWarehouseId: string): WmsOrderPushInput {
  return {
    orderNumber: order.orderNumber ?? order.externalOrderNumber ?? order.id,
    externalReference: order.id,
    externalWarehouseId,
    currency: order.currency,
    shippingAddress: readAddress(order.shippingAddress, order.customerName),
    email: order.customerEmail,
    phone: null,
    vatNumber: order.customerVatNumber,
    comments: null,
    courierService: order.shippingService,
    totalVat: num(order.taxForeign),
    shippingExVat: num(order.shippingForeign),
    shippingVat: 0,
    discountExVat: num(order.discountAmount),
    discountVat: 0,
    lines: buildLines(order.lines, refundedQtyByLine(order)),
  }
}

// Sum refunded quantity per sales-order line so the WMS payload can exclude it.
function refundedQtyByLine(order: { refunds?: Array<{ lines: Array<{ salesOrderLineId: string | null; qty: unknown }> }> }): Map<string, number> {
  const map = new Map<string, number>()
  for (const refund of order.refunds ?? []) {
    for (const line of refund.lines) {
      if (!line.salesOrderLineId) continue
      map.set(line.salesOrderLineId, (map.get(line.salesOrderLineId) ?? 0) + num(line.qty))
    }
  }
  return map
}

// --- Testability boundary -------------------------------------------------
// The sweep's data access is behind a port so the state machine can be unit
// tested with an in-memory fake (see tests/wms-order-push-sweep-state.test.ts),
// mirroring the repository pattern used by the shopping webhook inbox.

type PushState = 'PENDING_CREATE' | 'SYNCED' | 'PENDING_CANCEL' | 'CANCELLED' | 'DEAD_LETTER' | 'HELD'
type LinkWrite = {
  connector?: string
  externalOrderId?: string | null
  externalOrderNumber?: string | null
  state?: PushState
  attempts?: number
  lastError?: string | null
  pushedAt?: Date | null
  lastAttemptAt?: Date | null
  cancelledAt?: Date | null
  courierPending?: boolean
  totalMismatchPence?: number | null
  dispatchFailureCount?: number
  dispatchLastError?: string | null
  dispatchDeadLetteredAt?: Date | null
  reconcileCheckedAt?: Date | null
}

/**
 * 6oyu.2 (Codex): whenever the link starts pointing at a NEW WMS order (release
 * re-create, create-pass success), the previous order's dispatch dead-letter
 * state must not carry over — a stale dispatchDeadLetteredAt would permanently
 * suppress dispatch polling for the fresh order.
 */
const RESET_DISPATCH_FAILURES = {
  dispatchFailureCount: 0,
  dispatchLastError: null,
  dispatchDeadLetteredAt: null,
  // Same rationale for the reconcile stamp: the recency belonged to the OLD
  // WMS order; the fresh one must rotate to the front of verification.
  reconcileCheckedAt: null,
} satisfies LinkWrite

export type WmsPushCandidate = OrderForPush & { shipFromWarehouseId: string | null; pushAttempts: number }
export type WmsPushUpdateLink = { id: string; externalOrderId: string | null; order: OrderForPush & { shipFromWarehouseId: string | null } }
export type WmsPushLinkRef = { id: string; orderId: string; externalOrderId: string | null }

export interface WmsOrderPushPort {
  activeBindings(connector: string): Promise<Array<{ warehouseId: string; externalWarehouseId: string }>>
  /** HELD links whose order is back in a ready+paid state. */
  releasableHeldOrders(connector: string, limit: number): Promise<WmsPushLinkRef[]>
  /** Ready+paid orders for bound warehouses with no link or a PENDING_CREATE link. */
  createCandidates(connector: string, boundWarehouseIds: string[], limit: number): Promise<WmsPushCandidate[]>
  /**
   * o3d-5r8 — claim a candidate for the remote create, under the order's row lock.
   *
   * The create pass used to call the WMS with NOTHING in IMS recording that a remote
   * create was in flight: the WmsOrderPushLink was written only AFTER pushOrder returned.
   * A concurrent hard delete (deleteSalesOrder) could therefore remove the order while the
   * create was on the wire, the link write would then fail on the missing order, and the
   * WMS would be left holding an order IMS has no record of.
   *
   * Claiming writes the PENDING_CREATE link BEFORE the remote call, under the same row
   * lock deleteSalesOrder takes — so the deleter either sees the link and refuses, or
   * commits first and this claim finds the order gone and returns false.
   *
   * Returns false when the order no longer exists or already has a non-PENDING_CREATE
   * link (another worker got there first); the caller must then skip the candidate
   * without calling the WMS.
   */
  claimForCreate(orderId: string, connector: string, attemptedAt: Date): Promise<boolean>
  /** SYNCED links for ready orders changed since the last push (updatedAt > pushedAt). */
  updatableLinks(connector: string, limit: number): Promise<WmsPushUpdateLink[]>
  /** SYNCED links whose order is ON_HOLD. */
  holdableLinks(connector: string, limit: number): Promise<WmsPushLinkRef[]>
  /** SYNCED links whose order is CANCELLED in IMS. */
  cancellableLinks(connector: string, limit: number): Promise<WmsPushLinkRef[]>
  upsertByOrder(orderId: string, create: LinkWrite & { connector: string }, update: LinkWrite): Promise<void>
  updateLink(id: string, data: LinkWrite): Promise<void>
  /** q66in.4.6: audit-grade timeline row for a connector mutation — must never throw. */
  recordEvent(event: WmsMutationEventInput): Promise<void>
}

/** PII-free projection of a push input for the audit timeline: what IMS asked the WMS to hold. */
function pushIntentSummary(input: WmsOrderPushInput) {
  return {
    orderNumber: input.orderNumber,
    externalWarehouseId: input.externalWarehouseId,
    currency: input.currency,
    courierService: input.courierService,
    totalVat: input.totalVat,
    shippingExVat: input.shippingExVat,
    shippingVat: input.shippingVat,
    discountExVat: input.discountExVat,
    discountVat: input.discountVat,
    lines: input.lines.map((line) => ({ sku: line.sku, quantity: line.quantity, unitPriceExVat: line.unitPriceExVat, unitPriceVat: line.unitPriceVat })),
  }
}

type PushConnector = Pick<WmsConnector, 'pushOrder' | 'updateOrder' | 'cancelOrder' | 'addOrderComment'>

/**
 * Testable core of the order-push sweep — operates purely on the injected
 * connector + port. The production entry point (runWmsOrderPushSweep) wires the
 * active connector and the Prisma-backed port.
 */
export async function runWmsOrderPushSweepCore(
  connector: PushConnector,
  connectorId: string,
  port: WmsOrderPushPort,
  options?: { batchSize?: number; now?: () => Date },
): Promise<WmsOrderPushSweepResult> {
  const result: WmsOrderPushSweepResult = { created: 0, updated: 0, cancelled: 0, held: 0, released: 0, failed: 0, deadLettered: 0 }
  if (!connector.pushOrder) return { ...result, skipped: 'Active WMS connector has no order-push support' }

  const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE
  const now = options?.now ?? (() => new Date())

  // q66in.4.6 audit timeline: one event per remote mutation (attempted or
  // succeeded), best-effort — an audit failure must never fail the sweep.
  const audit = async (event: Omit<WmsMutationEventInput, 'connector' | 'direction' | 'triggeredBy'>) => {
    try {
      await port.recordEvent({ connector: connectorId, direction: 'OUTBOUND', triggeredBy: 'order-push-sweep', ...event })
    } catch (error) {
      console.error('[wms-order-push] failed to record audit event', error)
    }
  }

  // Best-effort warehouse-visible note when IMS can't propagate a hold/cancel
  // because the WMS order is already past NEW. Mirrors the refund-conflict comment
  // (onetwo3d-ims-ql59); never fail the sweep on a comment error.
  const postConflictComment = async (externalOrderId: string, comment: string, orderId?: string) => {
    if (!connector.addOrderComment) return
    try {
      await connector.addOrderComment(externalOrderId, comment)
      await audit({
        action: 'order_comment', outcome: 'SUCCEEDED', entityType: 'SALES_ORDER', entityId: orderId ?? null, externalId: externalOrderId,
        summary: 'Warehouse-visible note posted on WMS order', after: { comment },
      })
    } catch (error) {
      console.error('[wms-order-push] failed to post conflict comment', error)
      await audit({
        action: 'order_comment', outcome: 'FAILED', entityType: 'SALES_ORDER', entityId: orderId ?? null, externalId: externalOrderId,
        summary: 'Failed to post warehouse-visible note on WMS order', after: { comment }, error: scrubWmsError(error, 'WMS comment failed'),
      })
    }
  }

  const bindings = await port.activeBindings(connectorId)
  const externalWarehouseByWarehouse = new Map(bindings.map((b) => [b.warehouseId, b.externalWarehouseId]))

  // --- Release pass: a HELD order back in a ready+paid state re-enters the
  // create queue (its WMS order was cancelled when held, so it re-creates). ---
  for (const link of await port.releasableHeldOrders(connectorId, batchSize)) {
    // Only a release that actually PERSISTED counts and is audited (Codex r1:
    // swallowing the write error while recording SUCCEEDED forged the timeline).
    try {
      await port.updateLink(link.id, { state: 'PENDING_CREATE', externalOrderId: null, externalOrderNumber: null, attempts: 0, lastError: null, cancelledAt: null, ...RESET_DISPATCH_FAILURES })
    } catch (error) {
      console.error('[wms-order-push] release link update failed', link.id, error)
      continue
    }
    result.released += 1
    await audit({
      action: 'order_release', outcome: 'SUCCEEDED', entityType: 'SALES_ORDER', entityId: link.orderId, externalId: link.externalOrderId,
      summary: 'Held order back in a ready+paid state — re-queued for WMS create',
      before: { state: 'HELD', externalOrderId: link.externalOrderId },
      after: { state: 'PENDING_CREATE', externalOrderId: null },
    })
  }

  // --- Create pass ---
  if (externalWarehouseByWarehouse.size > 0) {
    const candidates = await port.createCandidates(connectorId, [...externalWarehouseByWarehouse.keys()], batchSize)
    for (const order of candidates) {
      const externalWarehouseId = order.shipFromWarehouseId ? externalWarehouseByWarehouse.get(order.shipFromWarehouseId) : undefined
      if (!externalWarehouseId) continue

      const ts = now()
      const beforeCreate = { state: order.pushAttempts > 0 ? 'PENDING_CREATE' : null, attempts: order.pushAttempts }

      // o3d-92fu: BUILD BEFORE CLAIMING. buildPushInput used to run after the claim, so a purely
      // local validation failure — a line with no SKU, say — left the link as PENDING_CREATE and
      // eventually DEAD_LETTER, even though pushOrder was never invoked and no remote side effect
      // was possible. The delete guard blocks on EVERY WMS link and DEAD_LETTER is no longer a
      // create candidate, so the order became permanently impossible to hard-delete because of a
      // local data error. Nothing is persisted for this failure now; the order stays deletable and
      // the audit records why it cannot be pushed.
      let input: WmsOrderPushInput
      try {
        input = buildPushInput(order, externalWarehouseId)
      } catch (error) {
        result.failed += 1
        const message = scrubWmsError(error, 'WMS order payload could not be built')
        await audit({
          action: 'order_create', outcome: 'FAILED', entityType: 'SALES_ORDER', entityId: order.id, externalId: null,
          summary: `WMS create skipped for order ${order.orderNumber ?? order.id}: ${message}`,
          before: beforeCreate,
          after: { state: beforeCreate.state, attempts: order.pushAttempts, localValidationFailure: true },
        })
        continue
      }

      // o3d-5r8: claim immediately before the remote call. A claim failure means the order was
      // deleted or another worker owns it — skip WITHOUT touching the WMS. A claim
      // error is not the order's fault either, so it is logged and retried next sweep
      // rather than counted against the order's push attempts.
      let claimed = false
      try {
        claimed = await port.claimForCreate(order.id, connectorId, ts)
      } catch (error) {
        console.error('[wms-order-push] create claim failed', order.id, error)
      }
      if (!claimed) continue

      // Hoisted so the catch can tell "remote create failed" from "remote
      // create SUCCEEDED but recording the link failed" (Codex r1) — the audit
      // outcome must mirror the remote mutation, not the local bookkeeping.
      let push: Awaited<ReturnType<NonNullable<PushConnector['pushOrder']>>> | null = null
      try {
        push = await connector.pushOrder!(input)
        const courierPending = push.courierFallback ?? false
        // Penny-precision guard (G6): record (never block) when the order's own totals
        // don't reconcile to the penny, so an operator can investigate a mis-totalled order.
        const driftPence = orderTotalDriftPence(order)
        const totalMismatchPence = driftPence > TOTAL_DRIFT_TOLERANCE_PENCE ? driftPence : null
        if (totalMismatchPence !== null) {
          console.warn(`[wms-order-push] order ${order.orderNumber ?? order.id} total mismatch: ${totalMismatchPence}p drift vs derived total (pushed, flagged for review)`)
        }
        await port.upsertByOrder(
          order.id,
          { connector: connectorId, externalOrderId: push.externalOrderId, externalOrderNumber: push.externalOrderNumber, state: 'SYNCED', attempts: 0, pushedAt: ts, lastAttemptAt: ts, courierPending, totalMismatchPence },
          { connector: connectorId, externalOrderId: push.externalOrderId, externalOrderNumber: push.externalOrderNumber, state: 'SYNCED', lastError: null, pushedAt: ts, lastAttemptAt: ts, cancelledAt: null, courierPending, totalMismatchPence, ...RESET_DISPATCH_FAILURES },
        )
        result.created += 1
        await audit({
          action: 'order_create', outcome: 'SUCCEEDED', entityType: 'SALES_ORDER', entityId: order.id, externalId: push.externalOrderId,
          summary: `Order ${order.orderNumber ?? order.id} created in WMS as ${push.externalOrderNumber ?? push.externalOrderId}`,
          before: beforeCreate,
          after: { state: 'SYNCED', externalOrderId: push.externalOrderId, externalOrderNumber: push.externalOrderNumber, courierPending, totalMismatchPence, intent: pushIntentSummary(input) },
        })
        // Courier-pending (G6c): the shipping service didn't resolve and the WMS used a
        // default courier — flag it on the WMS order so the warehouse verifies before despatch.
        if (courierPending) {
          await postConflictComment(
            push.externalOrderId,
            `IMS: shipping method '${order.shippingService ?? '—'}' did not map to a WMS courier, so a default courier was used. Please verify the courier before despatch.`,
            order.id,
          )
        }
      } catch (error) {
        const attempts = order.pushAttempts + 1
        const dead = attempts >= MAX_ATTEMPTS
        const message = scrubWmsError(error, 'WMS order push failed')
        if (dead) result.deadLettered += 1
        else result.failed += 1
        const state: PushState = dead ? 'DEAD_LETTER' : 'PENDING_CREATE'
        await port
          .upsertByOrder(order.id, { connector: connectorId, state, attempts, lastError: message, lastAttemptAt: ts }, { state, attempts, lastError: message, lastAttemptAt: ts })
          .catch(() => {})
        await audit({
          action: 'order_create', outcome: push ? 'SUCCEEDED' : 'FAILED', entityType: 'SALES_ORDER', entityId: order.id, externalId: push?.externalOrderId ?? null,
          summary: push
            ? `Order ${order.orderNumber ?? order.id} created in WMS as ${push.externalOrderNumber ?? push.externalOrderId}, but recording the link failed`
            : `WMS create failed for order ${order.orderNumber ?? order.id}${dead ? ' — dead-lettered' : ''}`,
          before: beforeCreate,
          after: push
            ? { state: 'SYNCED', externalOrderId: push.externalOrderId, externalOrderNumber: push.externalOrderNumber, linkPersistFailed: true, ...(input ? { intent: pushIntentSummary(input) } : {}) }
            : { state, attempts },
          error: message,
        })
      }
    }
  }

  // --- Update pass: amend already-pushed orders changed since the last push ---
  if (connector.updateOrder && externalWarehouseByWarehouse.size > 0) {
    for (const link of await port.updatableLinks(connectorId, batchSize)) {
      const externalWarehouseId = link.order.shipFromWarehouseId ? externalWarehouseByWarehouse.get(link.order.shipFromWarehouseId) : undefined
      if (!externalWarehouseId || !link.externalOrderId) continue

      const ts = now()
      let update: Awaited<ReturnType<NonNullable<PushConnector['updateOrder']>>> | null = null
      try {
        const input = buildPushInput(link.order, externalWarehouseId)
        update = await connector.updateOrder(link.externalOrderId, input)
        // Bump pushedAt either way so we don't re-attempt until the next change;
        // a non-NEW WMS order can no longer be amended (inbound webhooks aside).
        await port.updateLink(link.id, { pushedAt: ts, lastAttemptAt: ts, lastError: update.updated ? null : `Amendment not propagated (WMS status ${update.status})` })
        if (update.updated) result.updated += 1
        await audit({
          action: 'order_update', outcome: update.updated ? 'SUCCEEDED' : 'FAILED', entityType: 'SALES_ORDER', entityId: link.order.id, externalId: link.externalOrderId,
          summary: update.updated
            ? `Order ${link.order.orderNumber ?? link.order.id} amendment propagated to WMS`
            : `Order ${link.order.orderNumber ?? link.order.id} amendment NOT propagated — WMS order past NEW (status ${update.status})`,
          before: { state: 'SYNCED', externalOrderId: link.externalOrderId },
          after: { propagated: update.updated, wmsStatus: update.status, intent: pushIntentSummary(input) },
          error: update.updated ? null : `Amendment not propagated (WMS status ${update.status})`,
        })
      } catch (error) {
        const message = scrubWmsError(error, 'WMS order update failed')
        result.failed += 1
        await port.updateLink(link.id, { lastError: message, lastAttemptAt: ts }).catch(() => {})
        await audit({
          action: 'order_update', outcome: update?.updated ? 'SUCCEEDED' : 'FAILED', entityType: 'SALES_ORDER', entityId: link.order.id, externalId: link.externalOrderId,
          summary: update
            ? `Order ${link.order.orderNumber ?? link.order.id} amendment ${update.updated ? 'propagated to WMS' : `not propagated (WMS status ${update.status})`}, but recording the link failed`
            : `WMS update failed for order ${link.order.orderNumber ?? link.order.id}`,
          before: { state: 'SYNCED', externalOrderId: link.externalOrderId },
          after: update ? { propagated: update.updated, wmsStatus: update.status, linkPersistFailed: true } : undefined,
          error: message,
        })
      }
    }
  }

  // --- Hold pass: an IMS-held order that was pushed is pulled back from the WMS
  // (cancelled) and parked as HELD so a later release re-pushes it. ---
  if (connector.cancelOrder) {
    for (const link of await port.holdableLinks(connectorId, batchSize)) {
      if (!link.externalOrderId) continue
      const ts = now()
      let cancel: Awaited<ReturnType<NonNullable<PushConnector['cancelOrder']>>> | null = null
      try {
        cancel = await connector.cancelOrder(link.externalOrderId)
        if (cancel.cancelled || cancel.status === 'NOT_FOUND') {
          // reconcileCheckedAt reset (q66in.4.4): a freshly held/cancelled link
          // must rotate to the FRONT of the reconcile's safety check, not
          // inherit its pre-transition verification recency.
          await port.updateLink(link.id, { state: 'HELD', cancelledAt: ts, lastError: null, lastAttemptAt: ts, reconcileCheckedAt: null })
          result.held += 1
          await audit({
            action: 'order_hold', outcome: 'SUCCEEDED', entityType: 'SALES_ORDER', entityId: link.orderId, externalId: link.externalOrderId,
            summary: 'IMS-held order pulled back from the WMS (cancelled remotely, parked HELD)',
            before: { state: 'SYNCED', externalOrderId: link.externalOrderId },
            after: { state: 'HELD', wmsCancelStatus: cancel.status },
          })
        } else {
          result.deadLettered += 1
          await port.updateLink(link.id, { state: 'DEAD_LETTER', lastError: `Held in IMS but WMS order past NEW (status ${cancel.status}) — raise a cancellation query in the WMS`, lastAttemptAt: ts })
          await audit({
            action: 'order_hold', outcome: 'FAILED', entityType: 'SALES_ORDER', entityId: link.orderId, externalId: link.externalOrderId,
            summary: 'IMS hold could not cancel the WMS order (past NEW) — dead-lettered for operator action',
            before: { state: 'SYNCED', externalOrderId: link.externalOrderId },
            after: { state: 'DEAD_LETTER', wmsStatus: cancel.status },
            error: `WMS order past NEW (status ${cancel.status})`,
          })
          await postConflictComment(link.externalOrderId, `IMS: This order has been placed ON HOLD in IMS but is already being fulfilled here (status ${cancel.status}) and could not be auto-cancelled. Please pause it if possible, or raise a cancellation query.`, link.orderId)
        }
      } catch (error) {
        const message = scrubWmsError(error, 'WMS hold/cancel failed')
        result.failed += 1
        await port.updateLink(link.id, { lastError: message, lastAttemptAt: ts }).catch(() => {})
        const remoteCancelled = cancel ? cancel.cancelled || cancel.status === 'NOT_FOUND' : false
        await audit({
          action: 'order_hold', outcome: remoteCancelled ? 'SUCCEEDED' : 'FAILED', entityType: 'SALES_ORDER', entityId: link.orderId, externalId: link.externalOrderId,
          summary: remoteCancelled ? 'WMS order cancelled for hold, but recording the link failed' : 'WMS hold/cancel call failed',
          before: { state: 'SYNCED', externalOrderId: link.externalOrderId },
          after: cancel ? { wmsCancelStatus: cancel.status, linkPersistFailed: true } : undefined,
          error: message,
        })
      }
    }
  }

  // --- Cancel pass: IMS-cancelled and fully-refunded orders that were pushed (SYNCED) ---
  if (connector.cancelOrder) {
    for (const link of await port.cancellableLinks(connectorId, batchSize)) {
      if (!link.externalOrderId) continue
      const ts = now()
      let cancel: Awaited<ReturnType<NonNullable<PushConnector['cancelOrder']>>> | null = null
      try {
        cancel = await connector.cancelOrder(link.externalOrderId)
        if (cancel.cancelled || cancel.status === 'NOT_FOUND') {
          await port.updateLink(link.id, { state: 'CANCELLED', cancelledAt: ts, lastError: null, lastAttemptAt: ts , reconcileCheckedAt: null })
          result.cancelled += 1
          await audit({
            action: 'order_cancel', outcome: 'SUCCEEDED', entityType: 'SALES_ORDER', entityId: link.orderId, externalId: link.externalOrderId,
            summary: 'IMS-cancelled/fully-refunded order cancelled in the WMS',
            before: { state: 'SYNCED', externalOrderId: link.externalOrderId },
            after: { state: 'CANCELLED', wmsCancelStatus: cancel.status },
          })
        } else {
          // Past NEW in the WMS — already being fulfilled despite the IMS cancel/full
          // refund. Only NEW orders auto-cancel; surface a dead-letter conflict so an
          // operator raises a cancellation query in the WMS rather than retrying forever.
          result.deadLettered += 1
          await port.updateLink(link.id, { state: 'DEAD_LETTER', lastError: `WMS order past NEW (status ${cancel.status}) — raise a cancellation query in the WMS`, lastAttemptAt: ts })
          await audit({
            action: 'order_cancel', outcome: 'FAILED', entityType: 'SALES_ORDER', entityId: link.orderId, externalId: link.externalOrderId,
            summary: 'IMS cancel could not cancel the WMS order (past NEW) — dead-lettered for operator action',
            before: { state: 'SYNCED', externalOrderId: link.externalOrderId },
            after: { state: 'DEAD_LETTER', wmsStatus: cancel.status },
            error: `WMS order past NEW (status ${cancel.status})`,
          })
          await postConflictComment(link.externalOrderId, `IMS: This order has been cancelled / fully refunded in IMS but is already being fulfilled here (status ${cancel.status}) and could not be auto-cancelled. Please raise a cancellation query.`, link.orderId)
        }
      } catch (error) {
        const message = scrubWmsError(error, 'WMS cancel failed')
        result.failed += 1
        await port.updateLink(link.id, { lastError: message, lastAttemptAt: ts }).catch(() => {})
        const remoteCancelled = cancel ? cancel.cancelled || cancel.status === 'NOT_FOUND' : false
        await audit({
          action: 'order_cancel', outcome: remoteCancelled ? 'SUCCEEDED' : 'FAILED', entityType: 'SALES_ORDER', entityId: link.orderId, externalId: link.externalOrderId,
          summary: remoteCancelled ? 'WMS order cancelled, but recording the link failed' : 'WMS cancel call failed',
          before: { state: 'SYNCED', externalOrderId: link.externalOrderId },
          after: cancel ? { wmsCancelStatus: cancel.status, linkPersistFailed: true } : undefined,
          error: message,
        })
      }
    }
  }

  return result
}

/** Prisma-backed port — the exact queries the sweep used before the extraction. */
export function createPrismaWmsOrderPushPort(): WmsOrderPushPort {
  return {
    activeBindings: (connector) =>
      db.externalWmsBinding.findMany({
        where: { connector, active: true, connection: { active: true } },
        select: { warehouseId: true, externalWarehouseId: true },
      }),
    releasableHeldOrders: (connector, limit) =>
      db.wmsOrderPushLink.findMany({
        where: { connector, state: 'HELD', order: { status: { in: [...READY_STATUSES] }, paidAt: { not: null }, refundStatus: { not: 'FULL' } } },
        select: { id: true, orderId: true, externalOrderId: true },
        take: limit,
      }),
    async createCandidates(connector, boundWarehouseIds, limit) {
      const rows = await db.salesOrder.findMany({
        where: {
          status: { in: [...READY_STATUSES] },
          paidAt: { not: null },
          refundStatus: { not: 'FULL' },
          shipFromWarehouseId: { in: boundWarehouseIds },
          OR: [{ wmsOrderPush: { is: null } }, { wmsOrderPush: { state: 'PENDING_CREATE' } }],
        },
        select: { ...ORDER_PUSH_SELECT, shipFromWarehouseId: true, wmsOrderPush: { select: { attempts: true } } },
        take: limit,
        orderBy: { updatedAt: 'asc' },
      })
      return rows.map(({ wmsOrderPush, ...order }) => ({ ...order, pushAttempts: wmsOrderPush?.attempts ?? 0 }))
    },
    async claimForCreate(orderId, connector, attemptedAt) {
      return db.$transaction(async (tx) => {
        // Same row lock deleteSalesOrder takes — this is what makes the claim and the
        // delete mutually exclusive rather than merely racing.
        const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM sales_orders WHERE id = ${orderId} FOR UPDATE`
        if (locked.length === 0) return false
        const existing = await tx.wmsOrderPushLink.findUnique({ where: { orderId }, select: { state: true } })
        if (existing && existing.state !== 'PENDING_CREATE') return false
        await tx.wmsOrderPushLink.upsert({
          where: { orderId },
          create: { orderId, connector, state: 'PENDING_CREATE', lastAttemptAt: attemptedAt },
          update: { lastAttemptAt: attemptedAt },
        })
        return true
      })
    },
    async updatableLinks(connector, limit) {
      // "order changed since push" is a two-column comparison Prisma can't express.
      const dueRows = await db.$queryRaw<Array<{ id: string }>>`
        SELECT l.id
        FROM wms_order_push_links l
        JOIN sales_orders o ON o.id = l."orderId"
        WHERE l.connector = ${connector}
          AND l.state::text = 'SYNCED'
          AND l."externalOrderId" IS NOT NULL
          AND o.status::text IN ('PROCESSING', 'ALLOCATED')
          AND o."refundStatus"::text <> 'FULL'
          AND o."updatedAt" > COALESCE(l."pushedAt", to_timestamp(0))
        ORDER BY o."updatedAt" ASC
        LIMIT ${limit}
      `
      const dueIds = dueRows.map((row) => row.id)
      if (!dueIds.length) return []
      return db.wmsOrderPushLink.findMany({
        where: { id: { in: dueIds } },
        select: { id: true, externalOrderId: true, order: { select: { ...ORDER_PUSH_SELECT, shipFromWarehouseId: true } } },
      })
    },
    holdableLinks: (connector, limit) =>
      db.wmsOrderPushLink.findMany({
        where: { connector, state: 'SYNCED', externalOrderId: { not: null }, order: { status: 'ON_HOLD' } },
        select: { id: true, orderId: true, externalOrderId: true },
        take: limit,
      }),
    cancellableLinks: (connector, limit) =>
      db.wmsOrderPushLink.findMany({
        where: {
          connector,
          state: 'SYNCED',
          externalOrderId: { not: null },
          order: {
            OR: [
              { status: 'CANCELLED' },
              // A fully-refunded order that has not yet dispatched must be pulled from the
              // WMS too; it keeps its lifecycle status under the orthogonal refund model,
              // so refundStatus (not status) is what flags it for cancellation.
              { refundStatus: 'FULL', status: { notIn: [...POST_DISPATCH_STATUSES, 'CANCELLED'] } },
            ],
          },
        },
        select: { id: true, orderId: true, externalOrderId: true },
        take: limit,
      }),
    async upsertByOrder(orderId, create, update) {
      await db.wmsOrderPushLink.upsert({ where: { orderId }, create: { orderId, ...create }, update })
    },
    async updateLink(id, data) {
      await db.wmsOrderPushLink.update({ where: { id }, data })
    },
    recordEvent: (event) => recordWmsMutationEvent(event),
  }
}

export async function runWmsOrderPushSweep(
  options?: { batchSize?: number },
): Promise<WmsOrderPushSweepResult> {
  const empty: WmsOrderPushSweepResult = { created: 0, updated: 0, cancelled: 0, held: 0, released: 0, failed: 0, deadLettered: 0 }

  const state = await getIntegrationPluginState()
  const connectorId = WMS_CONNECTOR_IDS.find((id) => state[id])
  if (!connectorId) return { ...empty, skipped: 'No WMS connector enabled' }

  const connector = getWmsConnector(connectorId)
  if (!connector.pushOrder) return { ...empty, skipped: 'Active WMS connector has no order-push support' }

  return runWmsOrderPushSweepCore(connector, connectorId, createPrismaWmsOrderPushPort(), options)
}
