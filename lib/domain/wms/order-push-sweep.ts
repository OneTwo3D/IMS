import { db } from '@/lib/db'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { WMS_CONNECTOR_IDS } from '@/lib/connectors/wms/types'
import { getWmsConnector } from '@/lib/connectors/wms/registry'
import type { WmsOrderAddress, WmsOrderPushInput, WmsOrderPushLine } from '@/lib/connectors/wms/types'

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
const MAX_ATTEMPTS = 5
const DEFAULT_BATCH_SIZE = 25

export type WmsOrderPushSweepResult = {
  skipped?: string
  created: number
  cancelled: number
  failed: number
  deadLettered: number
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

function readAddress(raw: unknown, customerName: string | null): WmsOrderAddress {
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
  sku: string | null
  qty: unknown
  taxForeign: unknown
  totalForeign: unknown
  description: string
}

function buildLines(lines: CandidateLine[]): WmsOrderPushLine[] {
  return lines.map((line) => {
    // A line with no SKU can't be fulfilled by the WMS — fail the whole order
    // (caught → retried → dead-lettered) rather than silently dropping the line.
    if (!line.sku) throw new Error('Sales order has a line with no SKU; cannot push to WMS')
    const qty = num(line.qty) || 1
    // IMS stores SalesOrderLine.totalForeign as NET (ex-VAT) in both tax-inclusive
    // and tax-exclusive cases; taxForeign is the line VAT.
    const total = num(line.totalForeign)
    const tax = num(line.taxForeign)
    return {
      sku: line.sku,
      quantity: qty,
      unitPriceExVat: total / qty,
      unitPriceVat: tax / qty,
      description: line.description || null,
    }
  })
}

export async function runWmsOrderPushSweep(
  options?: { batchSize?: number },
): Promise<WmsOrderPushSweepResult> {
  const result: WmsOrderPushSweepResult = { created: 0, cancelled: 0, failed: 0, deadLettered: 0 }

  const state = await getIntegrationPluginState()
  const connectorId = WMS_CONNECTOR_IDS.find((id) => state[id])
  if (!connectorId) return { ...result, skipped: 'No WMS connector enabled' }

  const connector = getWmsConnector(connectorId)
  if (!connector.pushOrder) return { ...result, skipped: 'Active WMS connector has no order-push support' }

  const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE

  const bindings = await db.externalWmsBinding.findMany({
    where: { connector: connectorId, active: true, connection: { active: true } },
    select: { warehouseId: true, externalWarehouseId: true },
  })
  const externalWarehouseByWarehouse = new Map(bindings.map((b) => [b.warehouseId, b.externalWarehouseId]))

  // --- Create pass ---
  if (externalWarehouseByWarehouse.size > 0) {
    const candidates = await db.salesOrder.findMany({
      where: {
        status: { in: [...READY_STATUSES] },
        paidAt: { not: null },
        shipFromWarehouseId: { in: [...externalWarehouseByWarehouse.keys()] },
        OR: [{ wmsOrderPush: { is: null } }, { wmsOrderPush: { state: 'PENDING_CREATE' } }],
      },
      select: {
        id: true,
        orderNumber: true,
        externalOrderNumber: true,
        currency: true,
        customerName: true,
        customerEmail: true,
        shippingAddress: true,
        shipFromWarehouseId: true,
        shippingService: true,
        shippingForeign: true,
        taxForeign: true,
        discountAmount: true,
        lines: { select: { sku: true, qty: true, taxForeign: true, totalForeign: true, description: true } },
        wmsOrderPush: { select: { attempts: true } },
      },
      take: batchSize,
      orderBy: { updatedAt: 'asc' },
    })

    for (const order of candidates) {
      const externalWarehouseId = order.shipFromWarehouseId
        ? externalWarehouseByWarehouse.get(order.shipFromWarehouseId)
        : undefined
      if (!externalWarehouseId) continue

      const now = new Date()
      try {
        const input: WmsOrderPushInput = {
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
          lines: buildLines(order.lines),
        }
        const push = await connector.pushOrder(input)
        await db.wmsOrderPushLink.upsert({
          where: { orderId: order.id },
          create: {
            orderId: order.id,
            connector: connectorId,
            externalOrderId: push.externalOrderId,
            externalOrderNumber: push.externalOrderNumber,
            state: 'SYNCED',
            attempts: 0,
            pushedAt: now,
            lastAttemptAt: now,
          },
          update: {
            connector: connectorId,
            externalOrderId: push.externalOrderId,
            externalOrderNumber: push.externalOrderNumber,
            state: 'SYNCED',
            lastError: null,
            pushedAt: now,
            lastAttemptAt: now,
          },
        })
        result.created += 1
      } catch (error) {
        const attempts = (order.wmsOrderPush?.attempts ?? 0) + 1
        const dead = attempts >= MAX_ATTEMPTS
        const message = error instanceof Error ? error.message : 'WMS order push failed'
        if (dead) result.deadLettered += 1
        else result.failed += 1
        await db.wmsOrderPushLink
          .upsert({
            where: { orderId: order.id },
            create: { orderId: order.id, connector: connectorId, state: dead ? 'DEAD_LETTER' : 'PENDING_CREATE', attempts, lastError: message, lastAttemptAt: now },
            update: { state: dead ? 'DEAD_LETTER' : 'PENDING_CREATE', attempts, lastError: message, lastAttemptAt: now },
          })
          .catch(() => {})
      }
    }
  }

  // --- Cancel pass: IMS-cancelled orders that were pushed (SYNCED) ---
  if (connector.cancelOrder) {
    const toCancel = await db.wmsOrderPushLink.findMany({
      where: { connector: connectorId, state: 'SYNCED', externalOrderId: { not: null }, order: { status: 'CANCELLED' } },
      select: { id: true, externalOrderId: true },
      take: batchSize,
    })

    for (const link of toCancel) {
      if (!link.externalOrderId) continue
      const now = new Date()
      try {
        const cancel = await connector.cancelOrder(link.externalOrderId)
        if (cancel.cancelled || cancel.status === 'NOT_FOUND') {
          await db.wmsOrderPushLink.update({
            where: { id: link.id },
            data: { state: 'CANCELLED', cancelledAt: now, lastError: null, lastAttemptAt: now },
          })
          result.cancelled += 1
        } else {
          // Past NEW in the WMS — already being fulfilled despite the IMS cancel.
          // Surface as a dead-letter conflict rather than retrying forever.
          result.deadLettered += 1
          await db.wmsOrderPushLink.update({
            where: { id: link.id },
            data: { state: 'DEAD_LETTER', lastError: `WMS order not cancellable (status ${cancel.status})`, lastAttemptAt: now },
          })
        }
      } catch (error) {
        result.failed += 1
        await db.wmsOrderPushLink
          .update({ where: { id: link.id }, data: { lastError: error instanceof Error ? error.message : 'WMS cancel failed', lastAttemptAt: now } })
          .catch(() => {})
      }
    }
  }

  return result
}
