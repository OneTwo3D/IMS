import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { WMS_CONNECTOR_IDS } from '@/lib/connectors/wms/types'


/**
 * Connector-agnostic WMS watchdog (q66in.4.6): alerts on SILENT failure modes
 * that no incremental sweep surfaces on its own —
 *
 *  1. ASN overdue      — an open ASN past its ETA (or, with no ETA recorded,
 *                        old with no callback at all): the booked-in webhook
 *                        was dropped or the shipment stalled. Stale alignment
 *                        credits on such an ASN silently SUPPRESS real PO
 *                        receipts, so the alert names them.
 *  2. Stale stock sync — an active binding whose stock sync hasn't completed
 *                        within a multiple of its own configured cadence: the
 *                        cron is dead and drift accumulates undetected.
 *
 * Each breach alerts ONCE (WARNING activity + individual admin bell), deduped
 * by a stamp on the entity that clears when the condition heals (a fresh
 * callback / close for ASNs, a successful sync for bindings) so a RENEWED
 * breach re-alerts.
 */

/** Grace after the ETA before an open ASN counts as overdue. */
export const ASN_OVERDUE_GRACE_MS = 24 * 60 * 60 * 1000
/** Without an ETA, an open ASN with NO callback at all is overdue after this age. */
export const ASN_NO_ETA_FALLBACK_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** A binding is stale after this many of its own sync intervals... */
export const BINDING_STALE_INTERVALS = 3
/** ...but never sooner than this floor. */
export const BINDING_STALE_FLOOR_MS = 60 * 60 * 1000

/**
 * Pure: is an open ASN overdue for its booked-in callback?
 * Silence is measured from the LAST sign of life:
 *  - had a (partial) callback → renewed silence for the fallback window while
 *    still open is a fresh breach (Codex r4: a partial receipt must not make
 *    the ASN unwatchable forever);
 *  - never called back, with an ETA → past the ETA + grace;
 *  - never called back, no ETA → completely silent since creation for the
 *    fallback window.
 */
export function isAsnOverdue(
  asn: { eta: Date | null; lastCallbackAt: Date | null; createdAt: Date },
  now: Date,
): boolean {
  if (asn.lastCallbackAt) {
    return now.getTime() - asn.lastCallbackAt.getTime() >= ASN_NO_ETA_FALLBACK_AGE_MS
  }
  if (asn.eta) {
    return now.getTime() - asn.eta.getTime() >= ASN_OVERDUE_GRACE_MS
  }
  return now.getTime() - asn.createdAt.getTime() >= ASN_NO_ETA_FALLBACK_AGE_MS
}

/** Pure: has this binding's stock sync been silent past its own cadence? */
export function isBindingSyncStale(
  binding: { lastStockSyncAt: Date | null; syncFrequencyMinutes: number; createdAt: Date },
  now: Date,
): boolean {
  const interval = Math.max(binding.syncFrequencyMinutes, 1) * 60_000
  const staleAfter = Math.max(interval * BINDING_STALE_INTERVALS, BINDING_STALE_FLOOR_MS)
  const anchor = binding.lastStockSyncAt ?? binding.createdAt
  return now.getTime() - anchor.getTime() >= staleAfter
}

export type WmsWatchdogResult = {
  status: 'SKIPPED' | 'SUCCEEDED'
  overdueAsnAlerts: number
  staleBindingAlerts: number
  skippedReason?: string
}

/**
 * Durable admin notification — deliberately NOT lib/notifications.notify(),
 * which swallows insert failures: the watchdog's dedupe stamp must only stick
 * when the alert verifiably persisted (Codex), so this THROWS on failure and
 * the caller reverts the stamp.
 */
async function notifyAdminsDurably(title: string, message: string): Promise<void> {
  const admins = await db.user.findMany({ where: { role: 'ADMIN', active: true }, select: { id: true } })
  if (admins.length === 0) return
  await db.notification.createMany({
    data: admins.map((admin) => ({
      userId: admin.id,
      type: 'warning',
      title,
      message,
      actionUrl: '/sync',
    })),
  })
}

export async function runWmsWatchdog(): Promise<WmsWatchdogResult> {
  const state = await getIntegrationPluginState()
  const connectorId = WMS_CONNECTOR_IDS.find((id) => state[id])
  if (!connectorId) return { status: 'SKIPPED', overdueAsnAlerts: 0, staleBindingAlerts: 0, skippedReason: 'No WMS connector enabled' }

  const now = new Date()
  let overdueAsnAlerts = 0
  let staleBindingAlerts = 0

  // 1 — overdue ASNs. The overdue shape is pushed into SQL (Codex: an
  // unordered take before the predicate let 200 newer non-overdue rows shadow
  // a real breach forever) and ordered oldest-first; CREATE_PENDING
  // reservations are excluded — they were never created in the WMS (synthetic
  // external id), so an overdue-shipment alert would be misleading. The
  // lastCallbackAt-vs-ETA refinement stays in isAsnOverdue (not expressible as
  // a column comparison in Prisma).
  const openAsns = await db.wmsAsnMap.findMany({
    where: {
      connector: connectorId,
      closedAt: null,
      sloAlertedAt: null,
      // Reservations not yet (verifiably) created in the WMS — pending AND
      // in-flight (Codex r3: a crashed claim sits CREATE_IN_FLIGHT with a
      // synthetic external id) — are not overdue SHIPMENTS.
      status: { notIn: ['CREATE_PENDING', 'CREATE_IN_FLIGHT'] },
      OR: [
        { lastCallbackAt: { lt: new Date(now.getTime() - ASN_NO_ETA_FALLBACK_AGE_MS) } },
        { lastCallbackAt: null, eta: { lt: new Date(now.getTime() - ASN_OVERDUE_GRACE_MS) } },
        { lastCallbackAt: null, eta: null, createdAt: { lt: new Date(now.getTime() - ASN_NO_ETA_FALLBACK_AGE_MS) } },
      ],
    },
    take: 200,
    orderBy: [{ eta: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
    select: {
      id: true,
      externalAsnId: true,
      eta: true,
      lastCallbackAt: true,
      createdAt: true,
      warehouse: { select: { code: true } },
      lines: { select: { sku: true, qtyAccountedViaSnapshot: true, lastProcessedReceivedQty: true } },
    },
  })
  for (const asn of openAsns) {
    if (!isAsnOverdue(asn, now)) continue
    // CAS the dedupe stamp: a concurrent run must not double-alert, and the
    // callback state is pinned to the snapshot (Codex) — a booked-in callback
    // landing mid-sweep heals the ASN, and stamping over it would alert from
    // stale data AND re-suppress the healed entity.
    const stamped = await db.wmsAsnMap.updateMany({
      where: { id: asn.id, sloAlertedAt: null, closedAt: null, lastCallbackAt: asn.lastCallbackAt },
      data: { sloAlertedAt: now },
    })
    if (stamped.count === 0) continue

    try {

    const creditLines = asn.lines.filter((line) => Number(line.qtyAccountedViaSnapshot) > Number(line.lastProcessedReceivedQty))
    const creditNote = creditLines.length > 0
      ? ` ${creditLines.length} line(s) carry unreconciled alignment credits (e.g. ${creditLines[0].sku}) — until the booked-in callback arrives, REAL receipts for those lines are silently suppressed.`
      : ''
    const anchor = asn.eta ? `its ETA (${asn.eta.toISOString().slice(0, 10)})` : `${Math.round((now.getTime() - asn.createdAt.getTime()) / 86_400_000)} days with no callback`
    // Deliver the THROWING notification FIRST (Codex r3): logActivity swallows
    // insert failures, so the stamp's keep/revert decision must ride on the
    // notification insert. The activity line is best-effort colour.
    await notifyAdminsDurably(
      'WMS ASN overdue',
      `ASN ${asn.externalAsnId} (${asn.warehouse.code}) is past ${anchor} with no booked-in callback.${creditNote} Chase the shipment / callback in the WMS.`,
    )
    await logActivity({
      entityType: 'SYNC',
      entityId: asn.id,
      tag: 'sync',
      action: 'wms_asn_overdue',
      description: `ASN ${asn.externalAsnId} (${asn.warehouse.code}) is past ${anchor} with no booked-in callback.${creditNote}`,
      metadata: {
        asnMapId: asn.id,
        externalAsnId: asn.externalAsnId,
        connector: connectorId,
        eta: asn.eta?.toISOString() ?? null,
        lastCallbackAt: asn.lastCallbackAt?.toISOString() ?? null,
        creditLineCount: creditLines.length,
      },
      level: 'WARNING',
      resolveUser: false,
    })
    overdueAsnAlerts += 1
    } catch (deliveryError) {
      // Delivery failed — un-stamp so the next sweep retries the alert
      // (a stuck stamp would suppress it permanently; Codex).
      await db.wmsAsnMap.updateMany({
        where: { id: asn.id, sloAlertedAt: now },
        data: { sloAlertedAt: null },
      }).catch(() => {})
      console.error(`[wms-watchdog] overdue-ASN alert delivery failed for ${asn.externalAsnId}:`, deliveryError)
    }
  }

  // 2 — stale binding stock sync.
  const bindings = await db.externalWmsBinding.findMany({
    where: {
      connector: connectorId,
      active: true,
      connection: { active: true },
      stockSyncMode: { not: 'DISABLED' },
      staleSyncAlertedAt: null,
    },
    select: {
      id: true,
      lastStockSyncAt: true,
      syncFrequencyMinutes: true,
      createdAt: true,
      warehouse: { select: { code: true } },
    },
  })
  for (const binding of bindings) {
    if (!isBindingSyncStale(binding, now)) continue
    // Pin the snapshot freshness (Codex): a sync completing mid-sweep refreshes
    // lastStockSyncAt and clears the stamp — alerting over it would be false
    // and would re-suppress the recovered binding.
    const stamped = await db.externalWmsBinding.updateMany({
      where: { id: binding.id, staleSyncAlertedAt: null, lastStockSyncAt: binding.lastStockSyncAt },
      data: { staleSyncAlertedAt: now },
    })
    if (stamped.count === 0) continue

    try {

    const last = binding.lastStockSyncAt ? binding.lastStockSyncAt.toISOString() : 'never'
    await notifyAdminsDurably(
      'WMS stock sync stale',
      `Stock sync for ${binding.warehouse.code} has not completed since ${last} — check the scheduler and the WMS connection.`,
    )
    await logActivity({
      entityType: 'SYNC',
      entityId: binding.id,
      tag: 'sync',
      action: 'wms_stock_sync_stale',
      description: `Stock sync for ${binding.warehouse.code} has not completed since ${last} (cadence ${binding.syncFrequencyMinutes}m) — the sync cron may be dead; stock drift accumulates undetected.`,
      metadata: {
        bindingId: binding.id,
        connector: connectorId,
        lastStockSyncAt: binding.lastStockSyncAt?.toISOString() ?? null,
        syncFrequencyMinutes: binding.syncFrequencyMinutes,
      },
      level: 'WARNING',
      resolveUser: false,
    })
    staleBindingAlerts += 1
    } catch (deliveryError) {
      await db.externalWmsBinding.updateMany({
        where: { id: binding.id, staleSyncAlertedAt: now },
        data: { staleSyncAlertedAt: null },
      }).catch(() => {})
      console.error(`[wms-watchdog] stale-sync alert delivery failed for ${binding.warehouse.code}:`, deliveryError)
    }
  }

  return { status: 'SUCCEEDED', overdueAsnAlerts, staleBindingAlerts }
}
