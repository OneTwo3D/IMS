/**
 * THE REAL PORTS of the legacy bridge import: IMS's database (the only thing it writes), the WooCommerce read client (GET only) and the
 * Mintsoft order read (GET only, and only for `--verify-mintsoft`). Kept apart from run.ts so the decision runs without any of them.
 */
import { db } from '@/lib/db'
import { logActivityPersisted } from '@/lib/activity-log'
import { getShoppingConnectorPrefixes } from '@/lib/connectors/shopping-registry'
import { MAX_WC_PAGE_WALK_PAGES, describeUnendedWcPageWalk, describeUnreadWcPage, wcFetch } from '@/lib/connectors/woocommerce/api'
import { flagDoublePostageForMergedLink } from '@/lib/domain/wms/double-postage'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { resolveEnabledWmsConnector, wmsResolutionSkipReason } from '@/lib/connectors/wms/enabled-connector'
import { WMS_CONNECTOR_IDS } from '@/lib/connectors/wms/types'
import {
  decideLink,
  type DesiredLink,
  type ExistingLink,
} from './state'
import { walkWcOrderPages } from './wc-read'
import type { ImsOrderContext, LegacyImportPorts, WcReadResult, WriteOutcome } from './run'

const LINK_SELECT = { id: true, connector: true, state: true, externalOrderId: true, externalOrderNumber: true, attempts: true, lastAttemptAt: true, pushedAt: true } as const

/** The fields the import needs, nothing else: no billing, shipping or customer data leaves WooCommerce into this tool. */
const WC_FIELDS = 'id,number,status,meta_data'

function readWcOrders(statuses: readonly string[]): Promise<WcReadResult> {
  return walkWcOrderPages(
    (page) => wcFetch('/orders', { status: statuses.join(','), per_page: '100', page: String(page), orderby: 'id', order: 'asc', _fields: WC_FIELDS }),
    {
      maxPages: MAX_WC_PAGE_WALK_PAGES,
      describeUnread: (page, error) => describeUnreadWcPage('order', page, error),
      describeUnended: (pagesRead) => describeUnendedWcPageWalk('order', pagesRead),
    },
  )
}

async function loadIms(wcOrderIds: readonly string[], connector: string): Promise<Map<string, ImsOrderContext>> {
  const out = new Map<string, ImsOrderContext>()
  for (let i = 0; i < wcOrderIds.length; i += 500) {
    const slice = wcOrderIds.slice(i, i + 500)
    const links = await db.shoppingOrderLink.findMany({
      where: { connector: 'woocommerce', externalOrderId: { in: slice } },
      select: { externalOrderId: true, order: { select: { id: true, orderNumber: true, shipFromWarehouseId: true, wmsOrderPush: { select: LINK_SELECT } } } },
    })
    for (const row of links) {
      if (!row.order) continue
      out.set(row.externalOrderId, {
        orderId: row.order.id,
        orderNumber: row.order.orderNumber,
        shipFromWarehouseId: row.order.shipFromWarehouseId,
        link: row.order.wmsOrderPush as ExistingLink | null,
      })
    }
  }
  void connector
  return out
}

async function readOpenMergeState(connector: string) {
  const [holds, tasks] = await Promise.all([
    db.wmsMergeHold.findMany({
      where: { connector, state: { in: ['HOLDING', 'HELD', 'UNKNOWN'] } },
      select: { orderId: true, state: true, externalOrderId: true, heldAt: true, order: { select: { orderNumber: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    db.wmsOperatorTask.findMany({
      where: { connector, status: 'OPEN', reason: { in: ['MERGE_CANDIDATE', 'MERGE_HOLD', 'MERGE_HOLD_OVERDUE', 'MERGE_HOLD_WITHDRAWAL'] } },
      select: { orderId: true, reason: true, externalOrderId: true, order: { select: { orderNumber: true } } },
      orderBy: { createdAt: 'asc' },
    }),
  ])
  return {
    holds: holds.map((h) => ({ orderId: h.orderId, orderNumber: h.order.orderNumber, state: h.state, externalOrderId: h.externalOrderId, heldAt: h.heldAt ? h.heldAt.toISOString() : null })),
    tasks: tasks.map((t) => ({ orderId: t.orderId, orderNumber: t.order.orderNumber, reason: t.reason, externalOrderId: t.externalOrderId })),
  }
}

/**
 * Write one link under the order's row lock (the lock the push sweep's claim and the hard delete take), re-deciding against the link as
 * it is at that instant. A link that appeared or changed since the read is a conflict, never an overwrite.
 */
async function writeLink(input: { orderId: string; connector: string; shipFromWarehouseId: string | null; desired: DesiredLink; now: Date }): Promise<WriteOutcome> {
  const { orderId, connector, desired, now } = input
  if (desired.kind !== 'link' && desired.kind !== 'dead-letter') return 'unchanged'
  const outcome = await db.$transaction(async (tx): Promise<WriteOutcome> => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM sales_orders WHERE id = ${orderId} FOR UPDATE`
    if (locked.length === 0) return 'gone'
    const existing = await tx.wmsOrderPushLink.findUnique({ where: { orderId }, select: LINK_SELECT })
    const decision = decideLink(desired, existing as ExistingLink | null, connector)
    if (decision.action === 'unchanged') return 'unchanged'
    if (decision.action === 'conflict') return 'conflict'
    const data = desired.kind === 'link'
      ? {
          connector,
          pushWarehouseId: input.shipFromWarehouseId,
          externalOrderId: desired.externalOrderId,
          externalOrderNumber: desired.externalOrderNumber,
          state: desired.state,
          attempts: 0,
          lastError: desired.lastError,
          pushedAt: now,
          lastAttemptAt: now,
          cancelledAt: null,
          courierPending: false,
          // The bridge never told IMS the warehouse's line ids, so the recorded snapshot cannot be trusted: a merged-order line removal
          // falls back to the operator notice until an amendment stores a verified one (the same mark a create with no read-back carries).
          lineSnapshotUnsafeAt: now,
        }
      : {
          connector,
          pushWarehouseId: input.shipFromWarehouseId,
          externalOrderId: null,
          externalOrderNumber: null,
          state: 'DEAD_LETTER' as const,
          attempts: desired.attempts,
          lastError: desired.lastError,
          pushedAt: null,
          lastAttemptAt: now,
        }
    if (decision.action === 'create') {
      await tx.wmsOrderPushLink.create({ data: { orderId, ...data } })
      return 'created'
    }
    // Compare-and-set: still the same unclaimed placeholder.
    const won = await tx.wmsOrderPushLink.updateMany({
      where: { id: decision.existing.id, state: 'PENDING_CREATE', externalOrderId: null, lastAttemptAt: null, pushedAt: null, attempts: 0 },
      data,
    })
    return won.count === 1 ? 'adopted' : 'conflict'
  }, { timeout: 30_000 })
  if ((outcome === 'created' || outcome === 'adopted') && desired.kind === 'link' && desired.state === 'MERGED') {
    const link = await db.wmsOrderPushLink.findUnique({ where: { orderId }, select: { id: true } })
    if (link) await flagDoublePostageForMergedLink(link.id)
  }
  return outcome
}

export function createLegacyImportPorts(options: { verifyMintsoft?: boolean; connector?: string } = {}): LegacyImportPorts {
  const ports: LegacyImportPorts = {
    readWcOrders,
    async readOrderPrefix() {
      return (await getShoppingConnectorPrefixes('woocommerce')).orderPrefix
    },
    async readConnectorId() {
      if (options.connector) {
        if (!(WMS_CONNECTOR_IDS as readonly string[]).includes(options.connector)) throw new Error(`Unknown WMS connector "${options.connector}".`)
        return options.connector
      }
      const resolution = resolveEnabledWmsConnector(await getIntegrationPluginState())
      if (resolution.kind !== 'one') throw new Error(`${wmsResolutionSkipReason(resolution)}. Enable exactly one WMS connector, or pass --connector.`)
      return resolution.id
    },
    loadIms,
    readOpenMergeState,
    writeLink,
    async recordApply(entry) {
      return logActivityPersisted({
        entityType: 'SYSTEM',
        action: 'legacy_bridge_import_applied',
        tag: 'cutover',
        description: `Legacy bridge import applied (connector ${entry.connector}); bridge-stopped attested: ${entry.bridgeStopped ? 'yes' : 'no'}.`,
        metadata: { connector: entry.connector, bridgeStopped: entry.bridgeStopped, orderPrefix: entry.orderPrefix, statuses: entry.statuses, applied: entry.applied, generatedAt: entry.generatedAt },
        resolveUser: false,
      })
    },
  }
  if (options.verifyMintsoft) {
    ports.verifyMintsoftOrder = async (mintsoftOrderId) => {
      try {
        const { fetchMintsoftOrderById } = await import('../api/orders')
        const { getMintsoftSettings, parseMintsoftPositiveId } = await import('../settings/schema')
        const settings = await getMintsoftSettings()
        const row = await fetchMintsoftOrderById(mintsoftOrderId, parseMintsoftPositiveId(settings.mintsoft_client_id))
        if (row === null) return { found: false }
        const number = (row as Record<string, unknown>).OrderNumber
        return { found: true, orderNumber: typeof number === 'string' ? number : null }
      } catch (error) {
        return { error: error instanceof Error ? error.message.slice(0, 200) : 'read failed' }
      }
    }
  }
  return ports
}
