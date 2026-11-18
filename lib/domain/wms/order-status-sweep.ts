import { db } from '@/lib/db'
import { logActivityInTransaction } from '@/lib/activity-log'
import { getSettingValue } from '@/lib/settings-store'
import { orderNotFoundQuery, raiseWmsOperatorTask, warehouseOrderRef } from '@/lib/domain/wms/operator-tasks'
import { isOutboundWriteHeldText } from '@/lib/security/outbound-write-hold-constants'
import { lockSalesOrder } from '@/lib/domain/sales/allocation-service'
import type { Prisma } from '@/app/generated/prisma/client'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { resolveEnabledWmsConnector, wmsResolutionSkipReason } from '@/lib/connectors/wms/enabled-connector'
import { getWmsConnector, getWmsConnectorDef } from '@/lib/connectors/wms/registry'
import { resolveWmsOrderLookupConnector } from '@/lib/connectors/wms/order-lookup'
import { shoppingOrderLookupSkipReason } from '@/lib/fulfillment/shopping-order-lookup'
import { WMS_ORDER_STATUS_LAST_SUCCESS_SETTING } from '@/lib/ops/read-sync-liveness-constants'
import { mergeCandidateNote, runMergeCandidateDetectionSafe, type MergeCandidateNote } from '@/lib/domain/wms/merge-candidates'

/**
 * Connector-agnostic WMS order-status sweep. Refreshes the cached snapshot for
 * in-flight sales orders linked to the active WMS connector's order-lookup
 * connector, so the sales-list chips read cached status instead of making a live
 * call per row. The detail view stays live (getWmsOrderStatusForSalesOrder).
 */

// Sales orders past these IMS statuses no longer need WMS status polling.
const TERMINAL_SALES_STATUSES = ['COMPLETED', 'DELIVERED', 'CANCELLED'] as const
const DEFAULT_STALE_MINUTES = 30
const DEFAULT_BATCH_SIZE = 50
/** How many push error texts the result lists (display only: the counts above cover the whole batch). */
export const PUSH_ERRORS_DISPLAY_CAP = 20

/**
 * NOTFOUND: how many CONSECUTIVE status checks may find an order IMS pushed to the warehouse genuinely absent before the sweep marks the snapshot
 * NOTFOUND, stops polling the order and raises ONE operator task. Three, the bridge plugin's own threshold (its inbound not-found threshold).
 *
 * A strike is a lookup that returned nothing AND whose presence probe agreed the order is not there (`WMS_LOOKUP_CONFIRMED_ABSENT`), for an order
 * IMS has pushed (a SYNCED push link with a warehouse id): an order IMS has not pushed yet is expected to be absent. A lookup that FOUND the order,
 * or found it merged or ambiguous, resets the count. A lookup that FAILED (a thrown error, a probe that could not run) neither counts nor resets:
 * it proves nothing, and an outage must never be read as "the order is gone" (the plugin stamped an order NOTFOUND during a Mintsoft outage once).
 */
export const WMS_NOT_FOUND_THRESHOLD = 3
/** The snapshot status of an order the sweep stopped polling. */
export const WMS_STATUS_NOT_FOUND = 'NOTFOUND'
/** What the connector's by-id read answers when the warehouse itself returned 404 for the stored warehouse order id. */
const WMS_BY_ID_NOT_FOUND = 'NOT_FOUND'
/**
 * The switch for all of the NOTFOUND behaviour. OFF BY DEFAULT: only an explicit `true` turns it on. While it is off the sweep behaves exactly as it did
 * before NOTFOUND existed (probe, record "confirmed absent", keep polling), counts no strike, marks nothing and raises no task. An unreadable setting is off.
 */
export const WMS_NOT_FOUND_ENABLED_SETTING = 'wms_not_found_after_strikes_enabled'
async function isNotFoundHandlingEnabled(): Promise<boolean> {
  try {
    return (await getSettingValue(WMS_NOT_FOUND_ENABLED_SETTING)) === 'true'
  } catch {
    return false
  }
}
const WMS_STATUS_NOT_FOUND_LABEL = 'Not found in warehouse'

export type WmsOrderStatusSweepResult = {
  skipped?: string
  scanned: number
  updated: number
  failed: number
  /** PRESENT ONLY WHEN NON-EMPTY: storefront status pushes that failed (best-effort, retried next tick). A write the outbound hold refused carries the hold's text, so the cron exit status reads it as held. */
  errors?: string[]
  /** PRESENT ONLY WHEN NON-ZERO: storefront status pushes not attempted because no storefront connector is runnable (a state chosen on purpose, not a failure). */
  pushSkipped?: number
  /** PRESENT ONLY WHEN NON-ZERO: storefront status pushes that failed for a reason other than the outbound-write hold, counted over the WHOLE batch (`errors` is cut for display; this is what the cron exit status reads). */
  pushFailures?: number
  /** PRESENT ONLY WHEN NON-ZERO: storefront status pushes the outbound-write hold refused (nothing sent), counted over the whole batch. */
  pushHeld?: number
  /** Orders whose null fetch could not be settled because the presence probe THREW: a failed read, apart from the expected unresolved states (no probe, order present without a status) that only withhold the stamp. */
  probeFailures?: number
  /** PRESENT ONLY WHEN the merge-candidate pass (flag mode) failed or skipped: best-effort, never changes this sweep's outcome. */
  mergeCandidateDetection?: MergeCandidateNote
}

/**
 * The exact lastError a snapshot carries when an AUTHORITATIVE lookup found no such order.
 *
 * Exported because order-delete-guard has to tell that apart from a lookup ERROR, which also
 * writes an empty externalOrderId — and a shared literal is the only thing stopping the two files
 * drifting into disagreement about which placeholder means "safe to delete" (o3d-eu0r).
 */
export const WMS_LOOKUP_NOT_FOUND = 'Order not found in WMS'

/**
 * The marker the delete guard accepts as authoritative absence — deliberately DISTINCT from the
 * legacy WMS_LOOKUP_NOT_FOUND above (o3d-eu0r).
 *
 * Rows written before the presence probe existed recorded EVERY null fetch as the legacy literal,
 * including AMBIGUOUS ones. Accepting that literal would keep letting a genuine warehouse order be
 * deleted on the strength of a snapshot that never distinguished the two. A new marker is
 * unforgeable by old rows: anything still carrying the legacy string is treated as unresolved and
 * fails closed until the sweep re-resolves it.
 *
 * Refreshing is NOT a safe compatibility mechanism on its own — the sweep is optional and
 * batch-limited, so it may simply not have reached an order before someone tries to delete it.
 */
export const WMS_LOOKUP_CONFIRMED_ABSENT = 'Order confirmed absent in WMS (presence-probed)'

/**
 * The lastError written when the lookup could not decide — several WMS orders match this
 * reference (merged/split candidates), so "no single order" is NOT "no order" (o3d-x9nc).
 *
 * Kept distinct from WMS_LOOKUP_NOT_FOUND because the delete guard must fail CLOSED on this:
 * an ambiguous result means a real warehouse order probably exists, it just cannot be named.
 */
export const WMS_LOOKUP_AMBIGUOUS = 'WMS lookup ambiguous — several orders match this reference'

/**
 * The lookup could not read a status, but a presence probe says the order IS there. A
 * contradiction rather than an absence, and it blocks deletion for the obvious reason.
 */
export const WMS_LOOKUP_PRESENT_NO_STATUS = 'WMS holds this order but its status could not be read'

/**
 * The lastError of a snapshot written for an in-scope order whose storefront link carries a blank or
 * whitespace-only order number. There is nothing to look up, so the order's WMS status cannot be known:
 * that is UNRESOLVED (it withholds the read-sync stamp and is retried on every sweep), not "skip it".
 */
export const WMS_LOOKUP_NO_REFERENCE = 'The storefront link has no usable order number, so the WMS cannot be asked about this order'

/**
 * A snapshot row whose lookup did NOT resolve: it carries a `lastError` that is not one of the two
 * answers the warehouse itself gave about a missing order (confirmed absent, ambiguous). That covers a
 * presence probe that failed or could not run, a present order whose status was unreadable, a thrown
 * lookup, and the legacy "Order not found" literal (which never distinguished absence from ambiguity).
 *
 * The state is PERSISTED in the row on purpose. A snapshot written with a fresh `fetchedAt` otherwise
 * makes the order look resolved to the 30-minute exclusion in the next sweep, and a later sweep that
 * selects nothing else would then stamp the read-sync last-success time over an order nobody has been
 * able to read. So such rows are (a) selected on EVERY sweep regardless of age and (b) counted before the
 * stamp is written.
 */
export const WMS_RESOLVED_LOOKUP_ERRORS: readonly string[] = [WMS_LOOKUP_CONFIRMED_ABSENT, WMS_LOOKUP_AMBIGUOUS]

export function isUnresolvedLookupError(lastError: string | null | undefined): boolean {
  return lastError !== null && lastError !== undefined && !WMS_RESOLVED_LOOKUP_ERRORS.includes(lastError)
}

/** Prisma filter for `wmsOrderStatus: { is: ... }` matching the same rows as isUnresolvedLookupError. */
export const UNRESOLVED_SNAPSHOT_WHERE: Prisma.WmsOrderStatusSnapshotWhereInput = {
  AND: [{ lastError: { not: null } }, { lastError: { notIn: [...WMS_RESOLVED_LOOKUP_ERRORS] } }],
}

export async function runWmsOrderStatusSweep(
  options?: { batchSize?: number; staleMinutes?: number },
): Promise<WmsOrderStatusSweepResult> {
  const state = await getIntegrationPluginState()
  const resolution = resolveEnabledWmsConnector(state)
  if (resolution.kind !== 'one') {
    return { skipped: wmsResolutionSkipReason(resolution), scanned: 0, updated: 0, failed: 0 }
  }
  const connectorId = resolution.id

  const connector = getWmsConnector(connectorId)
  if (!connector.fetchOrderStatus) {
    return { skipped: 'Active WMS connector has no order-status support', scanned: 0, updated: 0, failed: 0 }
  }

  // o3d-r5uk: a warehouse connection can still name an ARCHIVED storefront, and this sweep is the
  // surface the Codex finding describes — it queries the 3PL by the resolved storefront's order
  // numbers, stores the answer against those orders and pushes the status back to that storefront.
  // So the refusal is reported with the value that caused it rather than folded into "none": an
  // operator reading "No order-lookup connector resolved" against a connection that very visibly
  // names one would go looking in the wrong place.
  const lookupResolution = await resolveWmsOrderLookupConnector(connectorId)
  if (lookupResolution.kind !== 'one') {
    return { skipped: shoppingOrderLookupSkipReason(lookupResolution), scanned: 0, updated: 0, failed: 0 }
  }
  const lookupConnector = lookupResolution.connector

  const staleMinutes = options?.staleMinutes ?? DEFAULT_STALE_MINUTES
  const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE
  const staleBefore = new Date(Date.now() - staleMinutes * 60_000)
  const connectorLabel = getWmsConnectorDef(connectorId).label

  const notFoundEnabled = await isNotFoundHandlingEnabled()
  const inScope = {
    status: { notIn: [...TERMINAL_SALES_STATUSES] },
    shoppingLinks: { some: { connector: lookupConnector, externalOrderNumber: { not: null } } },
    // An order already marked NOTFOUND is not polled again (an operator task asks a person to look): it is out of the batch and out of the unresolved count.
    ...(notFoundEnabled ? { NOT: { wmsOrderStatus: { is: { status: WMS_STATUS_NOT_FOUND } } } } : {}),
  }
  const orders = await db.salesOrder.findMany({
    where: {
      ...inScope,
      OR: [
        { wmsOrderStatus: { is: null } },
        { wmsOrderStatus: { fetchedAt: { lt: staleBefore } } },
        // An unresolved lookup is retried on every sweep, not once per staleness window.
        { wmsOrderStatus: { is: UNRESOLVED_SNAPSHOT_WHERE } },
      ],
    },
    select: {
      id: true,
      orderNumber: true,
      // Whether the warehouse is EXPECTED to hold this order (IMS pushed it and the push is settled): only then is an absent answer a strike.
      wmsOrderPush: { select: { externalOrderId: true, externalOrderNumber: true, state: true } },
      shoppingLinks: {
        where: { connector: lookupConnector },
        select: { externalOrderNumber: true },
        take: 1,
      },
      // Last status pushed to the storefront, to push only on change (G4). Tracked
      // separately from `status` so a failed push isn't masked by the change gate.
      wmsOrderStatus: { select: { wcPushedStatus: true } },
    },
    take: batchSize,
    orderBy: { updatedAt: 'desc' },
  })

  let updated = 0
  let failed = 0
  const pushErrors: string[] = []
  // Counted over the whole batch: `errors` below is cut for display, and a cron exit status decided from the cut list would read twenty held pushes
  // followed by a genuine failure as held.
  let pushFailures = 0
  let pushHeld = 0
  const notePushError = (text: string): void => {
    pushErrors.push(text)
    if (isOutboundWriteHeldText(text)) pushHeld += 1
    else pushFailures += 1
  }
  let pushSkipped = 0
  let probeFailures = 0
  let storefrontRunnable: boolean | undefined
  // Orders whose read did not RESOLVE even though nothing threw: a null fetch whose presence probe
  // failed, could not run, or found the order without being able to read its status. They are not
  // `failed` (the returned counters and the snapshot rows keep their meaning), but the read-sync
  // last-success stamp is withheld while any exists: the cache is not current for that order.
  let unresolvedReads = 0

  for (const order of orders) {
    const reference = order.shoppingLinks[0]?.externalOrderNumber?.trim()
    if (!reference) {
      // The scope only excludes a NULL order number, so a blank or whitespace one lands here. It is not
      // skipped silently: an unresolved snapshot is persisted (so it is retried every sweep and counted by
      // the stamp guard even when it is beyond this batch), and this run's stamp is withheld.
      unresolvedReads += 1
      await db.wmsOrderStatusSnapshot.upsert({
        where: { orderId: order.id },
        create: {
          orderId: order.id, connector: connectorId, connectorLabel, externalOrderId: '', externalOrderNumber: '',
          status: '', statusLabel: 'Unknown', lastError: WMS_LOOKUP_NO_REFERENCE,
        },
        update: { fetchedAt: new Date(), lastError: WMS_LOOKUP_NO_REFERENCE },
      })
      continue
    }

    try {
      // The snapshot as it stands BEFORE the lookup (flag on): the strike decision rests on this read, and the write is a compare-and-set against it.
      // Read after the lookup it would already include a concurrent sweep's write and the staleness could not be seen.
      const snapshotBeforeLookup = notFoundEnabled
        ? await db.wmsOrderStatusSnapshot.findUnique({ where: { orderId: order.id }, select: { externalOrderId: true, lastError: true, notFoundStrikes: true, fetchedAt: true } })
        : undefined
      const status = await connector.fetchOrderStatus(reference)
      const tracking = status?.tracking.find((entry) => entry.trackingNumber || entry.carrier)

      // fetchOrderStatus returns null for BOTH "no such order" and "several candidates match"
      // (merged/split references). Those are opposite conclusions for anything that acts on the
      // snapshot — the delete guard treats an authoritative MISSING as safe and must fail closed
      // on AMBIGUOUS — so resolve it with probeOrderPresence, which already reports the
      // distinction, rather than recording both as not-found (o3d-x9nc).
      //
      // Only on the null path, so a found order costs no extra call. A connector without
      // probeOrderPresence stays on the conservative reading: unresolved, so the guard blocks.
      //
      // COST: a connector re-runs the same underlying search inside the probe — Mintsoft repeats
      // Order/Search, and on a metered 3PL API that is billed — so a batch of missing orders would
      // otherwise double its remote requests every sweep, against a quota. An order already CONFIRMED absent and still absent has nothing new to learn, so it
      // is not re-probed; the steady state (a stable set of orders the WMS has never held) costs
      // one probe each, once, instead of one per sweep.
      //
      // The residual is deliberate: the FIRST sweep after an order goes missing still pays for a
      // probe, which is exactly when the answer is worth having.
      // Whether the warehouse is EXPECTED to hold this order: IMS pushed it and the push settled. Only then is an absent answer a strike.
      const pushedExternalId = order.wmsOrderPush?.state === 'SYNCED' ? (order.wmsOrderPush.externalOrderId ?? '') : ''
      let notFoundReason: string = WMS_LOOKUP_CONFIRMED_ABSENT
      let priorStrikes = 0
      // The snapshot's fetchedAt as read for the strike decision (null: there was no snapshot). The write below applies a strike only if it is unchanged.
      let knownFetchedAt: Date | null = null
      if (!status) {
        const known = snapshotBeforeLookup !== undefined
          ? snapshotBeforeLookup
          : await db.wmsOrderStatusSnapshot.findUnique({
            where: { orderId: order.id },
            select: { externalOrderId: true, lastError: true, notFoundStrikes: true, fetchedAt: true },
          })
        priorStrikes = known?.notFoundStrikes ?? 0
        knownFetchedAt = known?.fetchedAt ?? null
        // An order the warehouse SHOULD hold is probed on every lookup until it is marked NOTFOUND (at most WMS_NOT_FOUND_THRESHOLD probes, then it is no
        // longer polled): each strike needs a fresh answer, because the order may since have been merged, which the first absent answer could not know.
        const alreadyConfirmedAbsent = known
          && !(notFoundEnabled && pushedExternalId !== '')
          && !known.externalOrderId
          && known.lastError === WMS_LOOKUP_CONFIRMED_ABSENT

        if (alreadyConfirmedAbsent) {
          // Keep the existing verdict; nothing to re-resolve.
        } else if (!connector.probeOrderPresence) {
          notFoundReason = 'WMS lookup could not be confirmed — connector cannot probe presence'
          unresolvedReads += 1
        } else {
          try {
            const presence = await connector.probeOrderPresence(reference)
            if (presence === 'AMBIGUOUS') notFoundReason = WMS_LOOKUP_AMBIGUOUS
            // FOUND after a null fetch is a CONTRADICTION, not ambiguity: the order is there but
            // its status could not be read. Distinct marker so the reason stays truthful, and it
            // blocks for the same reason — the warehouse holds this order.
            else if (presence === 'FOUND') {
              notFoundReason = WMS_LOOKUP_PRESENT_NO_STATUS
              unresolvedReads += 1
            }
          } catch (probeError) {
            notFoundReason = `WMS presence probe failed: ${
              probeError instanceof Error ? probeError.message : String(probeError)
            }`
            unresolvedReads += 1
            probeFailures += 1
          }
        }
      }

      // THE NOT-FOUND COUNT. Found: reset. Confirmed absent for an order the warehouse should hold: one more strike. Merged, ambiguous or present with an
      // unreadable status: the order is there, reset. Anything unresolved (a probe that failed or could not run): left exactly as it was.
      let strikes: number | null = null
      if (!notFoundEnabled) strikes = null
      else if (status) strikes = 0
      else if (notFoundReason === WMS_LOOKUP_CONFIRMED_ABSENT && pushedExternalId !== '') {
        // A strike needs the absence confirmed BY IDENTITY, not by the number lookup alone: a warehouse rename can take the original number out of
        // Search while the order still exists under the id IMS stored. The id is read directly; only the warehouse's own 404 for that id (the marker
        // the delete guard trusts, plus this) counts. Present under the id (any status, merged or renamed): the order is there, so the count resets.
        // A read that failed, or a connector that cannot read by id, proves nothing: no strike, count left as it is.
        if (!connector.probeOrderAmendable) strikes = null
        else {
          try {
            const byId = await connector.probeOrderAmendable(pushedExternalId, order.wmsOrderPush?.externalOrderNumber ?? reference)
            strikes = !byId.amendable && byId.status === WMS_BY_ID_NOT_FOUND ? priorStrikes + 1 : 0
          } catch {
            // A failed by-id read proves nothing (no strike, count left as it is), but it is a failed read: counted, and the read-sync stamp is withheld.
            strikes = null
            probeFailures += 1
            unresolvedReads += 1
          }
        }
      }
      else if (notFoundReason === WMS_LOOKUP_AMBIGUOUS || notFoundReason === WMS_LOOKUP_PRESENT_NO_STATUS) strikes = 0
      const markNotFound = !status && strikes !== null && strikes >= WMS_NOT_FOUND_THRESHOLD

      const fields = status
        ? {
            connector: connectorId,
            connectorLabel,
            externalOrderId: status.externalOrderId,
            externalOrderNumber: status.externalOrderNumber,
            status: status.status,
            statusLabel: status.statusLabel,
            isSplit: status.isSplit,
            partCount: status.partCount,
            isMerged: status.isMerged,
            mergedOrderNumbers: status.mergedOrderNumbers,
            deepLinkUrl: status.deepLinkUrl,
            trackingNumber: tracking?.trackingNumber ?? null,
            carrier: tracking?.carrier ?? null,
            lastError: null,
            ...(notFoundEnabled ? { notFoundStrikes: 0, notFoundAt: null } : {}),
          }
        : {
            connector: connectorId,
            connectorLabel,
            externalOrderId: '',
            externalOrderNumber: reference,
            status: '',
            statusLabel: 'Unknown',
            isSplit: false,
            partCount: null,
            isMerged: false,
            mergedOrderNumbers: [],
            deepLinkUrl: null,
            trackingNumber: null,
            carrier: null,
            lastError: notFoundReason,
            ...(strikes !== null ? { notFoundStrikes: strikes } : {}),
            ...(markNotFound ? { status: WMS_STATUS_NOT_FOUND, statusLabel: WMS_STATUS_NOT_FOUND_LABEL, notFoundAt: new Date() } : {}),
          }

      // An erased order keeps its status in the cache but never its tracking number, carrier or deep link: the
      // warehouse still holds them, and writing them back would undo the erasure on the next sweep.
      //
      // THE MARKER IS READ HERE, UNDER THE ORDER LOCK, IN THE SAME TRANSACTION AS THE WRITE. The lookup above is a remote
      // call that can take seconds; `order.erasedAt` was read before it and an erasure can commit in between. The erasure
      // takes the same lock, so this write is either wholly before it (and is then scrubbed by it) or wholly after it
      // (and sees the marker).
      const erasedNow = await db.$transaction(async (tx) => {
        await lockSalesOrder(tx, order.id)
        const current = await tx.salesOrder.findUnique({ where: { id: order.id }, select: { erasedAt: true } })
        const erased = current?.erasedAt != null
        // COMPARE-AND-SET for the NOT-FOUND count. The absence answer (and the count it rests on) was read before this lock, across remote calls that can take
        // seconds. If another sweep wrote this snapshot since (it found the order, or counted a strike), this result is STALE: it is discarded whole, so it can
        // neither add a strike on a count that moved, nor mark NOTFOUND, nor overwrite a found status with "absent". The next sweep decides afresh.
        if (notFoundEnabled && !status) {
          const stored = await tx.wmsOrderStatusSnapshot.findUnique({ where: { orderId: order.id }, select: { fetchedAt: true } })
          if ((stored?.fetchedAt.getTime() ?? null) !== (knownFetchedAt?.getTime() ?? null)) return { erased, stale: true as const }
        }
        const storedFields = erased ? { ...fields, trackingNumber: null, carrier: null, deepLinkUrl: null } : fields
        await tx.wmsOrderStatusSnapshot.upsert({
          where: { orderId: order.id },
          create: { orderId: order.id, ...storedFields },
          update: { ...storedFields, fetchedAt: new Date() },
        })
        // NOTFOUND: ONE operator task, in the same transaction as the mark (an IMS task, never a warehouse or storefront note: the warehouse's staff
        // do not read notes). The task is deduplicated on the warehouse order, and the order leaves the batch once marked, so it is raised once.
        if (markNotFound) {
          const raised = await raiseWmsOperatorTask(tx, {
            connector: connectorId,
            orderId: order.id,
            externalOrderId: pushedExternalId,
            reason: 'ORDER_NOT_FOUND',
            queryText: orderNotFoundQuery(warehouseOrderRef(reference, pushedExternalId), order.orderNumber ?? order.id, strikes ?? WMS_NOT_FOUND_THRESHOLD),
            payload: { orderNumber: order.orderNumber, externalOrderNumber: reference },
            dedupeBasis: `not-found:${pushedExternalId}`,
          })
          if (raised) {
            await logActivityInTransaction(tx, {
              userId: null,
              entityType: 'SALES_ORDER',
              entityId: order.id,
              action: 'wms_order_not_found',
              tag: 'sync',
              level: 'WARNING',
              description: `${connectorLabel} did not have this order on ${strikes} status checks in a row. IMS marked its warehouse status NOTFOUND, stopped checking it, and raised a task under Sync > Exceptions for a person to look it up.`,
            })
          }
        }
        return { erased, stale: false as const }
      })
      if (erasedNow.stale) continue
      if (status) updated += 1

      // G6: clear the courier-pending review flag once the order is actually despatched
      // (a tracking NUMBER is present) — that's the point the courier is final and operator
      // verification is moot. Deliberately NOT keyed on carrier alone: the fallback default
      // courier yields a CourierServiceName immediately, so clearing on the name would drop
      // the flag while the order is still pre-despatch and still on the default courier.
      // updateMany is a no-op when there's no link or the flag is already clear.
      if (status && tracking?.trackingNumber) {
        await db.wmsOrderPushLink
          .updateMany({ where: { orderId: order.id, courierPending: true }, data: { courierPending: false } })
          .catch(() => {})
      }

      // G4: surface the WMS status in the storefront admin (the companion plugin renders
      // `_oti_wms_*` meta). Push only when it changed vs the LAST SUCCESSFUL push — so a
      // transient WC failure retries next tick instead of being permanently skipped.
      // Best-effort: a failed push must not fail the status sweep, but it is logged and
      // wcPushedStatus is left unchanged so it's re-attempted.
      if (status && status.status && !erasedNow.erased && status.status !== order.wmsOrderStatus?.wcPushedStatus) {
        try {
          // Re-read the marker immediately before the storefront push: an erasure that committed after the snapshot write
          // above must not be followed by a push built from the lookup.
          const beforePush = await db.salesOrder.findUnique({ where: { id: order.id }, select: { erasedAt: true } })
          if (beforePush?.erasedAt) continue
          const { pushWmsOrderStatusToShopping, listRunnableShoppingConnectorIds } = await import('@/lib/shopping')
          // No runnable storefront connector (the plugin is off, or sync is switched off) is a state chosen on purpose, not a failed push: nothing
          // is pushed, wcPushedStatus stays unchanged so the push happens once a connector runs, and it is counted as skipped, not as an error.
          storefrontRunnable ??= (await listRunnableShoppingConnectorIds()).length > 0
          if (!storefrontRunnable) {
            pushSkipped += 1
            continue
          }
          const pushResult = await pushWmsOrderStatusToShopping(order.id, {
            status: status.status,
            statusLabel: status.statusLabel,
            connectorLabel,
            deepLinkUrl: status.deepLinkUrl,
          })
          if (pushResult.success) {
            await db.wmsOrderStatusSnapshot.update({
              where: { orderId: order.id },
              data: { wcPushedStatus: status.status },
            }).catch(() => {})
          } else if (!pushResult.skipped && pushResult.shadowed !== true) {
            // A shadowed push (the producer-side hold) is neither pushed nor failed: wcPushedStatus stays unchanged so the
            // live phase's first tick pushes the then-current status, and nothing is logged as a failure.
            console.warn(`[wms-order-status-sweep] storefront WMS-status push failed for order ${order.id}: ${pushResult.error}`)
            notePushError(pushResult.error ?? 'Storefront WMS-status push failed')
          }
        } catch (pushError) {
          console.error('[wms-order-status-sweep] storefront WMS-status push errored', pushError)
          notePushError(pushError instanceof Error ? pushError.message : String(pushError))
        }
      }
    } catch (error) {
      failed += 1
      const message = error instanceof Error ? error.message : 'WMS order-status sweep failed'
      await db.wmsOrderStatusSnapshot
        .upsert({
          where: { orderId: order.id },
          create: {
            orderId: order.id,
            connector: connectorId,
            connectorLabel,
            externalOrderId: '',
            externalOrderNumber: reference,
            status: '',
            statusLabel: 'Unknown',
            lastError: message,
          },
          update: { fetchedAt: new Date(), lastError: message },
        })
        .catch(() => {})
    }
  }

  // The LAST-SUCCESS stamp (read-sync liveness). Reached only by a run that resolved a connector and a
  // lookup source (every skip above returned before here) and read every order it selected without an
  // error AND resolved every read: `failed` counts a lookup or snapshot write that threw, and
  // `unresolvedReads` counts a null fetch that the presence probe could not settle (probe threw, no
  // probe on the connector, or the order is present but its status unreadable). An AMBIGUOUS answer and a
  // confirmed absence ARE answers from the warehouse and count. A run that selected no orders because
  // none were stale counts - that is a sweep that legitimately found nothing to refresh. A run with any
  // failure does not, so one order that keeps failing keeps the stamp from advancing, which is the
  // honest reading: the cache is not being kept current for it.
  // Orders in scope whose stored snapshot is still unresolved - including any this run did not reach
  // (batch limit) - keep the stamp where it was.
  const outstandingUnresolved = failed === 0 && unresolvedReads === 0
    ? await db.salesOrder.count({ where: { ...inScope, wmsOrderStatus: { is: UNRESOLVED_SNAPSHOT_WHERE } } })
    : 0
  if (failed === 0 && unresolvedReads === 0 && outstandingUnresolved === 0) {
    const stampedAt = new Date().toISOString()
    await db.setting.upsert({
      where: { key: WMS_ORDER_STATUS_LAST_SUCCESS_SETTING },
      create: { key: WMS_ORDER_STATUS_LAST_SUCCESS_SETTING, value: stampedAt },
      update: { value: stampedAt },
    })
  }

  // Merge candidates (flag mode, default off): the snapshots just refreshed are what prove an order is still NEW. Database only; never throws, never affects this sweep.
  const mergeCandidateDetection = mergeCandidateNote(await runMergeCandidateDetectionSafe('the status sweep'))

  return { scanned: orders.length, updated, failed, ...(pushErrors.length > 0 ? { errors: pushErrors.slice(0, PUSH_ERRORS_DISPLAY_CAP) } : {}), ...(pushSkipped > 0 ? { pushSkipped } : {}), ...(pushFailures > 0 ? { pushFailures } : {}), ...(pushHeld > 0 ? { pushHeld } : {}), ...(probeFailures > 0 ? { probeFailures } : {}), ...(mergeCandidateDetection ? { mergeCandidateDetection } : {}) }
}
