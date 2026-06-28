import { db } from '@/lib/db'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { WMS_CONNECTOR_IDS } from '@/lib/connectors/wms/types'
import { getWmsConnector } from '@/lib/connectors/wms/registry'
import type { WmsConnector, WmsOrderAddress, WmsOrderPushInput, WmsOrderPushLine } from '@/lib/connectors/wms/types'

/**
 * Connector-agnostic outbound order-push sweep (Phase 8). Pushes IMS sales
 * orders to the active WMS for fulfilment and propagates cancellations.
 *
 * Eligibility (create): ship-from warehouse bound to the active WMS connector,
 * status ready-to-fulfil (PROCESSING/ALLOCATED), and paid. Idempotent via the
 * WmsOrderPushLink (orderId unique); failed pushes retry up to MAX_ATTEMPTS then
 * dead-letter. Inbound dispatch→tracking already flows via applyExternalFulfillmentUpdate.
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
  shippingAddress: unknown
  shippingService: string | null
  shippingForeign: unknown
  taxForeign: unknown
  discountAmount: unknown
  lines: CandidateLine[]
  refunds?: Array<{ lines: Array<{ salesOrderLineId: string | null; qty: unknown }> }>
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

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
  shippingAddress: true,
  shippingService: true,
  shippingForeign: true,
  taxForeign: true,
  discountAmount: true,
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
}

export type WmsPushCandidate = OrderForPush & { shipFromWarehouseId: string | null; pushAttempts: number }
export type WmsPushUpdateLink = { id: string; externalOrderId: string | null; order: OrderForPush & { shipFromWarehouseId: string | null } }
export type WmsPushLinkRef = { id: string; externalOrderId: string | null }

export interface WmsOrderPushPort {
  activeBindings(connector: string): Promise<Array<{ warehouseId: string; externalWarehouseId: string }>>
  /** HELD links whose order is back in a ready+paid state. */
  releasableHeldOrders(connector: string, limit: number): Promise<Array<{ id: string }>>
  /** Ready+paid orders for bound warehouses with no link or a PENDING_CREATE link. */
  createCandidates(connector: string, boundWarehouseIds: string[], limit: number): Promise<WmsPushCandidate[]>
  /** SYNCED links for ready orders changed since the last push (updatedAt > pushedAt). */
  updatableLinks(connector: string, limit: number): Promise<WmsPushUpdateLink[]>
  /** SYNCED links whose order is ON_HOLD. */
  holdableLinks(connector: string, limit: number): Promise<WmsPushLinkRef[]>
  /** SYNCED links whose order is CANCELLED in IMS. */
  cancellableLinks(connector: string, limit: number): Promise<WmsPushLinkRef[]>
  upsertByOrder(orderId: string, create: LinkWrite & { connector: string }, update: LinkWrite): Promise<void>
  updateLink(id: string, data: LinkWrite): Promise<void>
}

type PushConnector = Pick<WmsConnector, 'pushOrder' | 'updateOrder' | 'cancelOrder'>

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

  const bindings = await port.activeBindings(connectorId)
  const externalWarehouseByWarehouse = new Map(bindings.map((b) => [b.warehouseId, b.externalWarehouseId]))

  // --- Release pass: a HELD order back in a ready+paid state re-enters the
  // create queue (its WMS order was cancelled when held, so it re-creates). ---
  for (const link of await port.releasableHeldOrders(connectorId, batchSize)) {
    await port.updateLink(link.id, { state: 'PENDING_CREATE', externalOrderId: null, externalOrderNumber: null, attempts: 0, lastError: null, cancelledAt: null }).catch(() => {})
    result.released += 1
  }

  // --- Create pass ---
  if (externalWarehouseByWarehouse.size > 0) {
    const candidates = await port.createCandidates(connectorId, [...externalWarehouseByWarehouse.keys()], batchSize)
    for (const order of candidates) {
      const externalWarehouseId = order.shipFromWarehouseId ? externalWarehouseByWarehouse.get(order.shipFromWarehouseId) : undefined
      if (!externalWarehouseId) continue

      const ts = now()
      try {
        const push = await connector.pushOrder!(buildPushInput(order, externalWarehouseId))
        await port.upsertByOrder(
          order.id,
          { connector: connectorId, externalOrderId: push.externalOrderId, externalOrderNumber: push.externalOrderNumber, state: 'SYNCED', attempts: 0, pushedAt: ts, lastAttemptAt: ts },
          { connector: connectorId, externalOrderId: push.externalOrderId, externalOrderNumber: push.externalOrderNumber, state: 'SYNCED', lastError: null, pushedAt: ts, lastAttemptAt: ts, cancelledAt: null },
        )
        result.created += 1
      } catch (error) {
        const attempts = order.pushAttempts + 1
        const dead = attempts >= MAX_ATTEMPTS
        const message = error instanceof Error ? error.message : 'WMS order push failed'
        if (dead) result.deadLettered += 1
        else result.failed += 1
        const state: PushState = dead ? 'DEAD_LETTER' : 'PENDING_CREATE'
        await port
          .upsertByOrder(order.id, { connector: connectorId, state, attempts, lastError: message, lastAttemptAt: ts }, { state, attempts, lastError: message, lastAttemptAt: ts })
          .catch(() => {})
      }
    }
  }

  // --- Update pass: amend already-pushed orders changed since the last push ---
  if (connector.updateOrder && externalWarehouseByWarehouse.size > 0) {
    for (const link of await port.updatableLinks(connectorId, batchSize)) {
      const externalWarehouseId = link.order.shipFromWarehouseId ? externalWarehouseByWarehouse.get(link.order.shipFromWarehouseId) : undefined
      if (!externalWarehouseId || !link.externalOrderId) continue

      const ts = now()
      try {
        const update = await connector.updateOrder(link.externalOrderId, buildPushInput(link.order, externalWarehouseId))
        // Bump pushedAt either way so we don't re-attempt until the next change;
        // a non-NEW WMS order can no longer be amended (inbound webhooks aside).
        await port.updateLink(link.id, { pushedAt: ts, lastAttemptAt: ts, lastError: update.updated ? null : `Amendment not propagated (WMS status ${update.status})` })
        if (update.updated) result.updated += 1
      } catch (error) {
        result.failed += 1
        await port.updateLink(link.id, { lastError: error instanceof Error ? error.message : 'WMS order update failed', lastAttemptAt: ts }).catch(() => {})
      }
    }
  }

  // --- Hold pass: an IMS-held order that was pushed is pulled back from the WMS
  // (cancelled) and parked as HELD so a later release re-pushes it. ---
  if (connector.cancelOrder) {
    for (const link of await port.holdableLinks(connectorId, batchSize)) {
      if (!link.externalOrderId) continue
      const ts = now()
      try {
        const cancel = await connector.cancelOrder(link.externalOrderId)
        if (cancel.cancelled || cancel.status === 'NOT_FOUND') {
          await port.updateLink(link.id, { state: 'HELD', cancelledAt: ts, lastError: null, lastAttemptAt: ts })
          result.held += 1
        } else {
          result.deadLettered += 1
          await port.updateLink(link.id, { state: 'DEAD_LETTER', lastError: `Held in IMS but WMS order past NEW (status ${cancel.status}) — raise a cancellation query in the WMS`, lastAttemptAt: ts })
        }
      } catch (error) {
        result.failed += 1
        await port.updateLink(link.id, { lastError: error instanceof Error ? error.message : 'WMS hold/cancel failed', lastAttemptAt: ts }).catch(() => {})
      }
    }
  }

  // --- Cancel pass: IMS-cancelled and fully-refunded orders that were pushed (SYNCED) ---
  if (connector.cancelOrder) {
    for (const link of await port.cancellableLinks(connectorId, batchSize)) {
      if (!link.externalOrderId) continue
      const ts = now()
      try {
        const cancel = await connector.cancelOrder(link.externalOrderId)
        if (cancel.cancelled || cancel.status === 'NOT_FOUND') {
          await port.updateLink(link.id, { state: 'CANCELLED', cancelledAt: ts, lastError: null, lastAttemptAt: ts })
          result.cancelled += 1
        } else {
          // Past NEW in the WMS — already being fulfilled despite the IMS cancel/full
          // refund. Only NEW orders auto-cancel; surface a dead-letter conflict so an
          // operator raises a cancellation query in the WMS rather than retrying forever.
          result.deadLettered += 1
          await port.updateLink(link.id, { state: 'DEAD_LETTER', lastError: `WMS order past NEW (status ${cancel.status}) — raise a cancellation query in the WMS`, lastAttemptAt: ts })
        }
      } catch (error) {
        result.failed += 1
        await port.updateLink(link.id, { lastError: error instanceof Error ? error.message : 'WMS cancel failed', lastAttemptAt: ts }).catch(() => {})
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
        select: { id: true },
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
        select: { id: true, externalOrderId: true },
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
        select: { id: true, externalOrderId: true },
        take: limit,
      }),
    async upsertByOrder(orderId, create, update) {
      await db.wmsOrderPushLink.upsert({ where: { orderId }, create: { orderId, ...create }, update })
    },
    async updateLink(id, data) {
      await db.wmsOrderPushLink.update({ where: { id }, data })
    },
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
