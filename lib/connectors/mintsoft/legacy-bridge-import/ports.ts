/**
 * THE REAL PORTS of the legacy bridge import: IMS's database (the only thing it writes), the WooCommerce read client (GET only) and the
 * Mintsoft order read (GET only, and only for `--verify-mintsoft`). Kept apart from run.ts so the decision runs without any of them.
 */
import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivityPersisted } from '@/lib/activity-log'
import { getShoppingConnectorPrefixes } from '@/lib/connectors/shopping-registry'
import { MAX_WC_PAGE_WALK_PAGES, describeUnendedWcPageWalk, describeUnreadWcPage, wcFetch } from '@/lib/connectors/woocommerce/api'
import { raiseDoublePostageForMergedLink } from '@/lib/domain/wms/double-postage'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { resolveEnabledWmsConnector, wmsResolutionSkipReason } from '@/lib/connectors/wms/enabled-connector'
import { WMS_CONNECTOR_IDS } from '@/lib/connectors/wms/types'
import {
  RESOLUTION_DECISIONS,
  decideLink,
  type DesiredLink,
  type ExistingLink,
  type ResolutionDecision,
} from './state'
import { walkWcOrderPages } from './wc-read'
import type { ImsOrderContext, LegacyImportPorts, StoredHistoricResolution, StoredResolution, WcReadResult, WriteOutcome } from './run'

/** The activity-log action an operator decision (`--resolve`) is stored under. */
export const RESOLUTION_ACTION = 'legacy_bridge_import_resolved'
/** The activity-log action the ONE grouped decision for in-window historic cancelled / refunded orders is stored under. */
export const HISTORIC_RESOLUTION_ACTION = 'legacy_bridge_import_resolved_historic'
/** The audit action of a full `--apply` import run, and of a run limited to `--resolve` / `--resolve-all-historic-cancelled` (NOT the authoritative import). */
export const APPLY_ACTION = 'legacy_bridge_import_applied'
export const RESOLVE_APPLY_ACTION = 'legacy_bridge_import_resolve_applied'

const LINK_SELECT = { id: true, connector: true, state: true, externalOrderId: true, externalOrderNumber: true, attempts: true, lastAttemptAt: true, pushedAt: true } as const

/** The minimal field list the import asks for: no billing, shipping or customer data is returned to this tool. `_fields` only trims the RESPONSE: WooCommerce still loads each full order, and `meta_data` is every meta row, not only the `_mintsoft_*` ones. */
const WC_FIELDS = 'id,number,status,meta_data,date_modified_gmt'

async function walkStatuses(statuses: readonly string[], range: { modifiedAfter?: string; modifiedBefore?: string } | null, driftCheck = true): Promise<WcReadResult> {
  return walkWcOrderPages(
    async (page, pass) => {
      const params: Record<string, string> = pass === 'high'
        ? { status: statuses.join(','), per_page: '1', page: '1', orderby: 'id', order: 'desc', _fields: 'id' }
        : { status: statuses.join(','), per_page: '100', page: String(page), orderby: 'id', order: 'asc', _fields: pass === 'verify' ? 'id' : WC_FIELDS }
      if (range?.modifiedAfter !== undefined) { params.modified_after = range.modifiedAfter; params.dates_are_gmt = 'true' }
      if (range?.modifiedBefore !== undefined) { params.modified_before = range.modifiedBefore; params.dates_are_gmt = 'true' }
      const result = await wcFetch('/orders', params)
      return { data: result.data, error: result.error, retryAfterMs: result.retryAfterMs, totalItems: result.totalItemsPresent === true ? result.totalItems : undefined }
    },
    {
      maxPages: MAX_WC_PAGE_WALK_PAGES,
      // The id-set drift check: a second ids-only walk compared with the first (a new order mid-walk no longer fails the read), anchored on the set's
      // high-water id taken before the first walk. Skipped only for a read-only preview (`--no-drift-check`), which can never pass the gate.
      verifyPass: driftCheck,
      describeUnread: (page, error) => describeUnreadWcPage('order', page, error),
      describeUnended: (pagesRead) => describeUnendedWcPageWalk('order', pagesRead),
    },
  )
}

/**
 * The orders in `statuses`. With a window, cancelled / refunded (the history statuses) are read in their OWN walk with `modified_after`, so only recently
 * modified history is read; every other status is read in full. The number of history orders outside the window is counted (one request) for the preview.
 */
async function readWcOrders(statuses: readonly string[], window?: { historyStatuses: readonly string[]; modifiedAfter: string }, readOptions: { driftCheck?: boolean } = {}): Promise<WcReadResult> {
  const driftCheck = readOptions.driftCheck !== false
  if (!window) return walkStatuses(statuses, null, driftCheck)
  const history = statuses.filter((s) => window.historyStatuses.includes(s))
  const rest = statuses.filter((s) => !window.historyStatuses.includes(s))
  const restRead = rest.length > 0 ? await walkStatuses(rest, null, driftCheck) : { orders: [], pagesRead: 0, complete: true } as WcReadResult
  if (history.length === 0) return restRead
  const historyRead = await walkStatuses(history, { modifiedAfter: window.modifiedAfter }, driftCheck)
  let outside: number | null = null
  if (historyRead.complete) {
    const total = await wcFetch('/orders', { status: history.join(','), per_page: '1', page: '1', _fields: 'id' })
    if (total.error === undefined && total.totalItemsPresent === true) outside = Math.max(0, total.totalItems - historyRead.orders.length)
  }
  const notes = [restRead.note, historyRead.note].filter((n): n is string => Boolean(n))
  return {
    orders: [...restRead.orders, ...historyRead.orders],
    pagesRead: restRead.pagesRead + historyRead.pagesRead,
    complete: restRead.complete && historyRead.complete,
    ...(restRead.error ?? historyRead.error ? { error: restRead.error ?? historyRead.error } : {}),
    ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
    historyOutsideWindow: outside,
  }
}

/**
 * The cancelled / refunded orders OUTSIDE the history window, read ONLY to find a queued bridge action (`_mintsoft_sync_pending`, a verify id, a fence)
 * that the window would hide: such an order is never written again by the bridge, so its date_modified stays old. One sequential, paced walk
 * (300 ms between pages, 429 back-off, Retry-After honoured) with a minimal `_fields` list (a smaller response, not a lighter server-side load); the store's order set outside the
 * window cannot gain members (a modified order moves INTO the window), so the totals check is enough and no second walk is made.
 */
async function readOutsideWindowHistory(statuses: readonly string[], modifiedBefore: string): Promise<WcReadResult> {
  return walkStatuses(statuses, { modifiedBefore }, false)
}

async function loadIms(wcOrderIds: readonly string[], connector: string): Promise<Map<string, ImsOrderContext>> {
  const out = new Map<string, ImsOrderContext>()
  for (let i = 0; i < wcOrderIds.length; i += 500) {
    const slice = wcOrderIds.slice(i, i + 500)
    const links = await db.shoppingOrderLink.findMany({
      where: { connector: 'woocommerce', externalOrderId: { in: slice } },
      select: { externalOrderId: true, order: { select: { id: true, orderNumber: true, status: true, refundStatus: true, shipFromWarehouseId: true, wmsOrderPush: { select: LINK_SELECT } } } },
    })
    for (const row of links) {
      if (!row.order) continue
      out.set(row.externalOrderId, {
        orderId: row.order.id,
        orderNumber: row.order.orderNumber,
        shipFromWarehouseId: row.order.shipFromWarehouseId,
        status: row.order.status,
        refundStatus: row.order.refundStatus,
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
    if (decision.action === 'unchanged' || decision.action === 'advanced') return 'unchanged'
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
          cancelledAt: desired.state === 'CANCELLED' ? now : null,
          courierPending: false,
          // The bridge never told IMS the warehouse's line ids, so the recorded snapshot cannot be trusted: a merged-order line removal
          // falls back to the operator notice until an amendment stores a verified one (the same mark a create with no read-back carries).
          lineSnapshotUnsafeAt: now,
          // Adopted, not created by IMS: the SKUs it holds were never recorded (and any record on the placeholder described another order).
          sentLineSkus: Prisma.DbNull,
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
    // The double-postage flag of a MERGED link is raised in THIS transaction, so a crash between the link and the flag cannot leave a MERGED link
    // that a rerun reports as 'unchanged' and never flags (a failure here rolls the link back; the rerun writes both).
    const flagIfMerged = async (linkId: string) => {
      if (desired.kind === 'link' && desired.state === 'MERGED') await raiseDoublePostageForMergedLink(tx, linkId)
    }
    if (decision.action === 'create') {
      const created = await tx.wmsOrderPushLink.create({ data: { orderId, ...data }, select: { id: true } })
      await flagIfMerged(created.id)
      return 'created'
    }
    // Compare-and-set: still the same unclaimed placeholder.
    const won = await tx.wmsOrderPushLink.updateMany({
      where: { id: decision.existing.id, state: 'PENDING_CREATE', externalOrderId: null, lastAttemptAt: null, pushedAt: null, attempts: 0 },
      data,
    })
    if (won.count !== 1) return 'conflict'
    await flagIfMerged(decision.existing.id)
    return 'adopted'
  }, { timeout: 30_000 })
  return outcome
}

export function createLegacyImportPorts(options: { verifyMintsoft?: boolean; connector?: string } = {}): LegacyImportPorts {
  const ports: LegacyImportPorts = {
    readWcOrders,
    readOutsideWindowHistory,
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
    async readResolutions(connector) {
      const rows = await db.activityLog.findMany({
        where: { action: RESOLUTION_ACTION, entityType: 'SYSTEM' },
        orderBy: { createdAt: 'asc' },
        select: { entityId: true, metadata: true, createdAt: true },
      })
      const out = new Map<string, StoredResolution>()
      for (const row of rows) {
        const m = row.metadata as { connector?: unknown; wcOrderId?: unknown; decision?: unknown; signature?: unknown; kinds?: unknown; mintsoftRead?: { id?: unknown; orderNumber?: unknown; merged?: unknown } | null } | null
        if (!m || m.connector !== connector || typeof m.wcOrderId !== 'string' || typeof m.signature !== 'string') continue
        if (!(RESOLUTION_DECISIONS as readonly unknown[]).includes(m.decision)) continue
        // Rows are oldest first, so a later decision for the same order replaces an earlier one.
        const read = m.mintsoftRead
        // What the decision learned from Mintsoft (the id found by number for an order with no id, the number, the merge flag) is part of the decision: a later run builds the link from it.
        const found = read && typeof read === 'object' ? { id: typeof read.id === 'string' ? read.id : null, orderNumber: typeof read.orderNumber === 'string' ? read.orderNumber : null, merged: read.merged === true } : null
        out.set(m.wcOrderId, { wcOrderId: m.wcOrderId, decision: m.decision as ResolutionDecision, signature: m.signature, kinds: Array.isArray(m.kinds) ? m.kinds.map(String) : [], recordedAt: row.createdAt.toISOString(), found })
      }
      return out
    },
    async recordResolution(entry) {
      return logActivityPersisted({
        entityType: 'SYSTEM',
        entityId: entry.wcOrderId,
        action: RESOLUTION_ACTION,
        tag: 'cutover',
        description: `Legacy bridge import: operator decided WooCommerce order #${entry.wcNumber} (Mintsoft order ${entry.mintsoftOrderId ?? entry.verifyOrderId ?? entry.mintsoftRead?.id ?? 'none'}) is "${entry.decision}" after checking Mintsoft by hand (${entry.kinds.join(', ')}); bridge-stopped attested: ${entry.bridgeStopped ? 'yes' : 'no'}.`,
        metadata: { connector: entry.connector, wcOrderId: entry.wcOrderId, wcNumber: entry.wcNumber, decision: entry.decision, signature: entry.signature, kinds: entry.kinds, mintsoftOrderId: entry.mintsoftOrderId, verifyOrderId: entry.verifyOrderId, queued: entry.queued, bridgeStopped: entry.bridgeStopped, bridgeEntries: entry.bridgeEntries ?? [], mintsoftRead: entry.mintsoftRead ?? null },
        resolveUser: false,
      })
    },
    async readHistoricResolutions(connector) {
      const rows = await db.activityLog.findMany({
        where: { action: HISTORIC_RESOLUTION_ACTION, entityType: 'SYSTEM' },
        orderBy: { createdAt: 'asc' },
        select: { metadata: true, createdAt: true },
      })
      const out: StoredHistoricResolution[] = []
      for (const row of rows) {
        const m = row.metadata as { connector?: unknown; decision?: unknown; reason?: unknown; members?: unknown } | null
        if (!m || m.connector !== connector || m.decision !== 'cancelled' || typeof m.members !== 'object' || m.members === null || Array.isArray(m.members)) continue
        const members: Record<string, string> = {}
        for (const [id, signature] of Object.entries(m.members as Record<string, unknown>)) if (typeof signature === 'string') members[id] = signature
        out.push({ decision: 'cancelled', reason: typeof m.reason === 'string' ? m.reason : '', members, recordedAt: row.createdAt.toISOString() })
      }
      return out
    },
    async recordHistoricResolution(entry) {
      return logActivityPersisted({
        entityType: 'SYSTEM',
        action: HISTORIC_RESOLUTION_ACTION,
        tag: 'cutover',
        description: `Legacy bridge import: operator decided ${Object.keys(entry.members).length} in-window cancelled / refunded WooCommerce order(s) are "${entry.decision}" (each re-read in Mintsoft: cancelled or despatched); reason: ${entry.reason.slice(0, 300)}; bridge-stopped attested: ${entry.bridgeStopped ? 'yes' : 'no'}.`,
        metadata: { connector: entry.connector, decision: entry.decision, reason: entry.reason, members: entry.members, window: entry.window, bridgeStopped: entry.bridgeStopped },
        resolveUser: false,
      })
    },
    async recordApply(entry) {
      const resolveOnly = entry.resolveOnly !== null
      const fence = entry.bridgeFenceCleared !== null ? `; the bridge host's manual-reconcile fence and mint journal were attested resolved (every entry looked up in Mintsoft, then linked or cancelled) by ${entry.bridgeFenceCleared.by}` : '; the bridge host fence attestation was NOT given'
      const files = entry.bridgeFiles !== null ? `; bridge files read: minted_orders.json sha256 ${entry.bridgeFiles.journalSha256} (${entry.bridgeFiles.journalEntries} entries), manual_reconcile.json sha256 ${entry.bridgeFiles.fenceSha256} (${entry.bridgeFiles.fenceEntries} entries)` : '; the bridge host files were NOT given'
      return logActivityPersisted({
        entityType: 'SYSTEM',
        action: resolveOnly ? RESOLVE_APPLY_ACTION : APPLY_ACTION,
        tag: 'cutover',
        description: resolveOnly
          ? `Legacy bridge import: a --resolve run wrote only ${entry.resolveOnly!.length} resolved order link(s) (connector ${entry.connector}); this is NOT the full import; bridge-stopped attested: ${entry.bridgeStopped ? 'yes' : 'no'}${fence}${files}.`
          : `Legacy bridge import applied (connector ${entry.connector}); bridge-stopped attested: ${entry.bridgeStopped ? 'yes' : 'no'}${fence}${files}.`,
        metadata: { connector: entry.connector, bridgeStopped: entry.bridgeStopped, bridgeFenceCleared: entry.bridgeFenceCleared, orderPrefix: entry.orderPrefix, statuses: entry.statuses, applied: entry.applied, generatedAt: entry.generatedAt, resolveOnly: entry.resolveOnly, bridgeFiles: entry.bridgeFiles },
        resolveUser: false,
      })
    },
  }
  // The read-only Mintsoft lookup behind the `--resolve` guards and `--verify-mintsoft`: fetchMintsoftOrderById (GET, paced by the Mintsoft client).
  ports.readMintsoftOrder = async (mintsoftOrderId) => {
    try {
      const { fetchMintsoftOrderById, normalizeMintsoftOrderRow } = await import('../api/orders')
      const { getMintsoftSettings, parseMintsoftPositiveId } = await import('../settings/schema')
      const settings = await getMintsoftSettings()
      const row = await fetchMintsoftOrderById(mintsoftOrderId, parseMintsoftPositiveId(settings.mintsoft_client_id))
      if (row === null) return { found: false }
      const number = (row as Record<string, unknown>).OrderNumber
      const normalized = await normalizeMintsoftOrderRow(row).catch(() => null)
      const { mintsoftRowIsMergeFlagged } = await import('../api/orders')
      return { found: true, orderNumber: typeof number === 'string' ? number : null, status: normalized ? normalized.status.toUpperCase() || null : null, dispatched: normalized?.dispatched === true, merged: mintsoftRowIsMergeFlagged(row) }
    } catch (error) {
      return { error: error instanceof Error ? error.message.slice(0, 200) : 'read failed' }
    }
  }
  // The by-NUMBER presence probe (read only, paced by the Mintsoft client): a 404 on an id is not proof that the order is gone, the real one may sit under another id.
  ports.probeMintsoftOrderNumber = async (orderNumber) => {
    try {
      // `probeMintsoftOrderPresence`'s search, plus (when exactly one order carries the number) its id, status and merge flag read by id.
      const { lookupMintsoftOrderByNumber } = await import('../api/orders')
      const { getMintsoftSettings, parseMintsoftPositiveId } = await import('../settings/schema')
      const settings = await getMintsoftSettings()
      return await lookupMintsoftOrderByNumber(orderNumber, parseMintsoftPositiveId(settings.mintsoft_client_id))
    } catch (error) {
      return { error: error instanceof Error ? error.message.slice(0, 200) : 'probe failed' }
    }
  }
  if (options.verifyMintsoft) ports.verifyMintsoftOrder = ports.readMintsoftOrder
  return ports
}
