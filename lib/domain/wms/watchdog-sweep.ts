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

/**
 * o3d-hl8l r3 (Codex r2 finding 1): the alert has to name the REMEDY, not just the breach.
 *
 * A booked-in callback refused by the maintenance-mode fence (or dropped by a sender that does not
 * retry) leaves no receipt-event row at all, so the exception inbox — which re-drives rows that
 * exist — cannot reach it, and "chase the callback in the WMS" sends the reader looking for
 * something that is not there. `enqueueMintsoftBookedInRecheckForAsn`, surfaced as "Re-check" on the
 * ASN table of the purchase order, reconstructs the TRIGGER and re-reads the quantities from the
 * warehouse, so it is the action this alert is asking for. This alert is the only push that a
 * refused callback ever produces, so it is the only place the remedy can be said.
 */
/**
 * o3d-hl8l r4 (Codex r3 finding 1): the remedy has to name a control the reader can actually REACH.
 *
 * The single sentence above said "purchase order → ASNs" for every breach, and this processor serves
 * stock-transfer ASNs too — for which that screen does not exist, and (until this round) neither did
 * any Re-check control. An operator following the alert for a transfer ASN was sent to a page that
 * has nothing to do with it, which is worse than saying nothing: it reads as though the remedy had
 * been tried and failed. The remedy and the notification's `actionUrl` are now both derived from the
 * ASN's own `sourceType`, so they cannot drift apart from which screens carry the button.
 */
export function describeAsnRecheckRemedy(sourceType: string): { remedy: string; actionUrl: string } {
  const transfer = sourceType.startsWith('STOCK_TRANSFER')
  const where = transfer ? 'stock transfer → WMS ASN' : 'purchase order → ASNs'
  return {
    remedy: ` If no callback is coming, use "Re-check" on this ASN (${where}):`
      + ' it re-reads the receipt from the WMS and books in only what is still outstanding.',
    actionUrl: transfer ? '/stock-control/transfers' : '/purchase-orders',
  }
}

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

/**
 * Pure: has this binding's stock sync been silent past its own cadence?
 * Anchored on the last SUCCESSFUL sync (Codex r5): lastStockSyncAt advances on
 * FAILED attempts too, so a binding failing every cadence would never go stale
 * and the first alert would never fire.
 */
export function isBindingSyncStale(
  binding: { lastStockSyncSuccessAt: Date | null; syncFrequencyMinutes: number; createdAt: Date },
  now: Date,
): boolean {
  const interval = Math.max(binding.syncFrequencyMinutes, 1) * 60_000
  const staleAfter = Math.max(interval * BINDING_STALE_INTERVALS, BINDING_STALE_FLOOR_MS)
  const anchor = binding.lastStockSyncSuccessAt ?? binding.createdAt
  return now.getTime() - anchor.getTime() >= staleAfter
}

export type WmsWatchdogResult = {
  /** FAILED = one or more breaches could not be alerted; the cron route maps it to HTTP 500. */
  status: 'SKIPPED' | 'SUCCEEDED' | 'FAILED'
  overdueAsnAlerts: number
  staleBindingAlerts: number
  deliveryFailures?: number
  reason?: string
}

/** Thrown when delivery finds zero recipients — the sweep aborts on the first one (Codex r8). */
class NoActiveAdminsError extends Error {}

/**
 * Insert a warning notification for every CURRENTLY active admin, inside the
 * caller's claim transaction — deliberately NOT lib/notifications.notify(),
 * which swallows insert failures. Recipients are queried at delivery time
 * (Codex r7: a run-start snapshot kept notifying admins demoted or
 * deactivated mid-sweep) and zero recipients THROWS so the transaction rolls
 * the claim back for retry.
 */
async function notifyActiveAdmins(
  tx: Pick<typeof db, 'user' | 'notification'>,
  title: string,
  message: string,
  actionUrl = '/sync',
): Promise<void> {
  const admins = await tx.user.findMany({ where: { role: 'ADMIN', active: true }, select: { id: true } })
  if (admins.length === 0) throw new NoActiveAdminsError('no active ADMIN users to notify')
  await tx.notification.createMany({
    data: admins.map((admin) => ({
      userId: admin.id,
      type: 'warning',
      title,
      message,
      actionUrl,
    })),
  })
}

/**
 * Pure: the two halves of an overdue-ASN alert's text.
 *
 * Describe the ACTUAL breach (Codex r5): a renewed-silence breach is "no further callback since the
 * last one" — anchoring its text on the ETA produced materially false incident context (even "past
 * its ETA" while the ETA was still in the future).
 */
export function describeAsnOverdueBreach(
  asn: { eta: Date | null; lastCallbackAt: Date | null; createdAt: Date },
  creditLines: Array<{ sku: string }>,
  now: Date,
): { breach: string; creditNote: string } {
  const daysSince = (from: Date) => Math.round((now.getTime() - from.getTime()) / 86_400_000)
  return {
    creditNote: creditLines.length > 0
      ? ` ${creditLines.length} line(s) carry unreconciled alignment credits (e.g. ${creditLines[0].sku}) — until the booked-in callback arrives, REAL receipts for those lines are silently suppressed.`
      : '',
    breach: asn.lastCallbackAt
      ? `is still open with no further booked-in callback for ${daysSince(asn.lastCallbackAt)} days (last callback ${asn.lastCallbackAt.toISOString().slice(0, 10)})`
      : asn.eta
        ? `is past its ETA (${asn.eta.toISOString().slice(0, 10)}) with no booked-in callback`
        : `has been open for ${daysSince(asn.createdAt)} days with no booked-in callback`,
  }
}

/** The full notification text an overdue open ASN produces — breach, blast radius, and remedy. */
export function buildAsnOverdueAlertMessage(input: {
  externalAsnId: string
  warehouseCode: string
  breach: string
  creditNote: string
  sourceType: string
}): string {
  const { remedy } = describeAsnRecheckRemedy(input.sourceType)
  return `ASN ${input.externalAsnId} (${input.warehouseCode}) ${input.breach}.${input.creditNote}${remedy}`
}

export async function runWmsWatchdog(): Promise<WmsWatchdogResult> {
  const state = await getIntegrationPluginState()
  const connectorId = WMS_CONNECTOR_IDS.find((id) => state[id])
  if (!connectorId) return { status: 'SKIPPED', overdueAsnAlerts: 0, staleBindingAlerts: 0, reason: 'No WMS connector enabled' }

  // Zero active admins is NOT delivery (Codex r5/r6): claiming breaches with
  // nowhere to send them would either lose alerts or (rolled back per entity)
  // re-claim up to 200 ASNs every run in a write/log storm. Fail the whole run
  // up front — the cron goes red until an admin exists. (Delivery re-checks
  // recipients per transaction; this is only the storm guard.)
  const admins = await db.user.count({ where: { role: 'ADMIN', active: true } })
  if (admins === 0) {
    console.error('[wms-watchdog] no active ADMIN users — breach alerts are undeliverable')
    return { status: 'FAILED', overdueAsnAlerts: 0, staleBindingAlerts: 0, reason: 'No active ADMIN users to notify' }
  }

  const now = new Date()
  let overdueAsnAlerts = 0
  let staleBindingAlerts = 0
  let deliveryFailures = 0

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
      sourceType: true,
      eta: true,
      lastCallbackAt: true,
      createdAt: true,
      warehouse: { select: { code: true } },
      lines: { select: { sku: true, qtyAccountedViaSnapshot: true, lastProcessedReceivedQty: true } },
    },
  })
  for (const asn of openAsns) {
    if (!isAsnOverdue(asn, now)) continue
    const creditLines = asn.lines.filter((line) => Number(line.qtyAccountedViaSnapshot) > Number(line.lastProcessedReceivedQty))
    const { creditNote, breach } = describeAsnOverdueBreach(asn, creditLines, now)

    // Claim the dedupe stamp AND insert the notifications in ONE transaction
    // (Codex r6): stamping first and delivering second left a crash window in
    // which the stamp committed with no alert — permanently suppressing the
    // breach — and the compensating un-stamp could itself fail. The CAS pins
    // the callback snapshot (a booked-in callback landing mid-sweep heals the
    // ASN; stamping over it would alert from stale data AND re-suppress it)
    // and dedupes concurrent runs. A callback landing AFTER commit clears the
    // stamp again — at worst one spurious alert, never a suppressed one.
    let claimed = false
    try {
      claimed = await db.$transaction(async (tx) => {
        const stamped = await tx.wmsAsnMap.updateMany({
          where: { id: asn.id, sloAlertedAt: null, closedAt: null, lastCallbackAt: asn.lastCallbackAt },
          data: { sloAlertedAt: now },
        })
        if (stamped.count === 0) return false
        await notifyActiveAdmins(
          tx,
          'WMS ASN overdue',
          buildAsnOverdueAlertMessage({
            externalAsnId: asn.externalAsnId,
            warehouseCode: asn.warehouse.code,
            breach,
            creditNote,
            sourceType: asn.sourceType,
          }),
          // The alert links to the screen that carries THIS ASN's Re-check control, not a blanket
          // /sync that has none.
          describeAsnRecheckRemedy(asn.sourceType).actionUrl,
        )
        return true
      })
    } catch (deliveryError) {
      deliveryFailures += 1
      console.error(`[wms-watchdog] overdue-ASN alert delivery failed for ${asn.externalAsnId}:`, deliveryError)
      // The up-front storm guard is TOCTOU (Codex r8): if the last admins
      // vanished mid-sweep, every remaining breach would claim/roll back/log.
      // Abort on the first zero-recipient failure — nothing later can deliver.
      if (deliveryError instanceof NoActiveAdminsError) {
        return { status: 'FAILED', overdueAsnAlerts, staleBindingAlerts, deliveryFailures, reason: 'No active ADMIN users to notify' }
      }
      continue
    }
    if (!claimed) continue

    // The activity line is best-effort colour (logActivity swallows failures);
    // the stamp's fate rides on the transaction above, not on this.
    await logActivity({
      entityType: 'SYNC',
      entityId: asn.id,
      tag: 'sync',
      action: 'wms_asn_overdue',
      description: `ASN ${asn.externalAsnId} (${asn.warehouse.code}) ${breach}.${creditNote}`,
      metadata: {
        asnMapId: asn.id,
        externalAsnId: asn.externalAsnId,
        sourceType: asn.sourceType,
        connector: connectorId,
        eta: asn.eta?.toISOString() ?? null,
        lastCallbackAt: asn.lastCallbackAt?.toISOString() ?? null,
        creditLineCount: creditLines.length,
      },
      level: 'WARNING',
      resolveUser: false,
    })
    overdueAsnAlerts += 1
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
      lastStockSyncSuccessAt: true,
      lastStockSyncStatus: true,
      syncFrequencyMinutes: true,
      createdAt: true,
      warehouse: { select: { code: true } },
    },
  })
  for (const binding of bindings) {
    if (!isBindingSyncStale(binding, now)) continue
    const last = binding.lastStockSyncSuccessAt ? binding.lastStockSyncSuccessAt.toISOString() : 'never'
    const failing = binding.lastStockSyncStatus === 'FAILED' ? ' Recent attempts are FAILING.' : ''

    // Same one-transaction claim+deliver contract as the ASN path (Codex r6).
    // The CAS pins the success snapshot (a sync completing mid-sweep refreshes
    // lastStockSyncSuccessAt and clears the stamp — alerting over it would be
    // false and would re-suppress the recovered binding) AND re-checks the
    // selection predicates (Codex r6: a binding disabled between selection and
    // stamping must not receive a stamp it would carry back on re-enable,
    // suppressing the genuine alert).
    let claimed = false
    try {
      claimed = await db.$transaction(async (tx) => {
        const stamped = await tx.externalWmsBinding.updateMany({
          where: {
            id: binding.id,
            staleSyncAlertedAt: null,
            lastStockSyncSuccessAt: binding.lastStockSyncSuccessAt,
            active: true,
            connection: { active: true },
            stockSyncMode: { not: 'DISABLED' },
          },
          data: { staleSyncAlertedAt: now },
        })
        if (stamped.count === 0) return false
        await notifyActiveAdmins(
          tx,
          'WMS stock sync stale',
          `Stock sync for ${binding.warehouse.code} has not completed successfully since ${last}.${failing} Check the scheduler and the WMS connection.`,
        )
        return true
      })
    } catch (deliveryError) {
      deliveryFailures += 1
      console.error(`[wms-watchdog] stale-sync alert delivery failed for ${binding.warehouse.code}:`, deliveryError)
      // Same first-zero-recipient abort as the ASN path (Codex r8).
      if (deliveryError instanceof NoActiveAdminsError) {
        return { status: 'FAILED', overdueAsnAlerts, staleBindingAlerts, deliveryFailures, reason: 'No active ADMIN users to notify' }
      }
      continue
    }
    if (!claimed) continue

    await logActivity({
      entityType: 'SYNC',
      entityId: binding.id,
      tag: 'sync',
      action: 'wms_stock_sync_stale',
      description: `Stock sync for ${binding.warehouse.code} has not completed successfully since ${last} (cadence ${binding.syncFrequencyMinutes}m).${failing} The sync cron may be dead or failing; stock drift accumulates undetected.`,
      metadata: {
        bindingId: binding.id,
        connector: connectorId,
        lastStockSyncSuccessAt: binding.lastStockSyncSuccessAt?.toISOString() ?? null,
        lastStockSyncStatus: binding.lastStockSyncStatus,
        syncFrequencyMinutes: binding.syncFrequencyMinutes,
      },
      level: 'WARNING',
      resolveUser: false,
    })
    staleBindingAlerts += 1
  }

  // Any undelivered breach fails the run (Codex r6): the cron route maps
  // FAILED to HTTP 500, so scheduler monitoring goes red instead of reporting
  // a healthy watchdog that alerted no one. Un-claimed breaches retry next run.
  if (deliveryFailures > 0) {
    return { status: 'FAILED', overdueAsnAlerts, staleBindingAlerts, deliveryFailures, reason: `${deliveryFailures} breach alert(s) could not be delivered` }
  }
  return { status: 'SUCCEEDED', overdueAsnAlerts, staleBindingAlerts }
}
