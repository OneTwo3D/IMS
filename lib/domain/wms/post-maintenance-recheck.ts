import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getEnabledWmsConnectorId } from '@/lib/connectors/wms/active-connector'
import { enqueueMintsoftBookedInRecheckForAsn } from '@/lib/jobs/wms/process-mintsoft-booked-in-event'
import { MAINTENANCE_ENABLED_KEY, WMS_BOOKED_IN_RECHECK_DUE_KEY } from '@/lib/maintenance-mode'
import { clearPostMaintenanceRecheckMarker } from '@/lib/domain/system/maintenance-recovery'
import type { WmsConnectorId } from '@/lib/connectors/wms/types'

/**
 * o3d-hl8l r4 (Codex r3 finding 1) — AUTOMATIC RECOVERY FOR CALLBACKS THE MAINTENANCE FENCE REFUSED.
 *
 * WHAT WAS WRONG. The fence's defence for refusing a booked-in callback rather than persisting it is
 * that the trigger can be RECREATED. It can — `enqueueMintsoftBookedInRecheckForAsn` does exactly
 * that — but until now nothing recreated it on its own. The three bounds rounds 1–3 claimed were all
 * conditional, and the conditions do not hold on a default installation:
 *
 *   • the SENDER retrying — Mintsoft's behaviour, not ours, and the 503's `Retry-After` is a hint;
 *   • the OPERATOR pressing "Re-check" — which existed on the purchase-order ASN table only, so a
 *     stock-transfer ASN going through the same callback processor had no control at all;
 *   • the WATCHDOG alerting — a cron registered `defaultEnabled: false`, and even enabled it is a
 *     days-scale detector (ETA + 24h, or 7 days without an ETA).
 *
 * Their intersection was an ASN left IN_TRANSIT with its destination stock never applied, and no
 * exception, no alert and no row anywhere saying so. This closes it without depending on any of the
 * three: the window's end is stamped (see `WMS_BOOKED_IN_RECHECK_DUE_KEY`) and this drains the stamp
 * from the Mintsoft webhook sweeper — a job that is `defaultEnabled: true` and runs every five
 * minutes, so recovery is minutes and needs nobody to have configured anything.
 *
 * WHY RE-CHECKING EVERY OPEN ASN IS SOUND, and not a blunt instrument. The refusal is unrecordable
 * by construction (the fence runs before signature verification, and rows written into the window
 * are replayed over), so there is no set of "the ones that were refused" to target — the choice is
 * every open ASN or nothing. It is safe because a re-check reconstructs the TRIGGER only:
 * `processBookedInEvent` re-fetches the ASN from the WMS and applies just the delta over each line's
 * `lastProcessedReceivedQty`. An ASN with nothing outstanding books nothing in. The cost of the
 * false positives is one WMS read each, which is why it is bounded and why the stamp is cleared.
 *
 * BOTH ASN KINDS. The candidates come from `wms_asn_maps` with no `sourceType` filter, so
 * STOCK_TRANSFER ASNs are covered by the same pass as PURCHASE_ORDER ones. That is deliberate and is
 * the half that had no recovery at all: it is a table query, not a screen, so it cannot drift out of
 * step with which pages happen to have a button.
 *
 * THE STAMP IS CLEARED ONLY AFTER EVERY CANDIDATE WAS ATTEMPTED. A crash or a throw part-way leaves
 * it set and the next tick re-runs the whole pass — re-checking an already-recovered ASN is a no-op,
 * whereas clearing early would abandon the ones not yet reached. If there are more open ASNs than
 * the page size the stamp is deliberately KEPT, so the remainder are picked up next tick rather than
 * silently dropped; that is the one case where the pass is not complete in a single run.
 */

/** Bound on how many ASNs one tick will re-check, so a large backlog cannot stall the sweeper. */
export const POST_MAINTENANCE_RECHECK_PAGE_SIZE = 100

export type PostMaintenanceRecheckResult = {
  /** No marker — no maintenance window has closed since the last drain. */
  skipped: boolean
  /** Open ASNs the pass attempted. */
  attempted: number
  /** Attempts that threw; the marker is kept so they are retried. */
  failed: number
  /** True when the marker was cleared (every open ASN was attempted this tick). */
  drained: boolean
  windowEndedAt?: string
  /**
   * o3d-hl8l r6: named when the pass stopped or declined to clear because a maintenance window was
   * in force. Never bare — an operator seeing "0 attempted" has to be able to tell "nothing was
   * owed" from "a restore is running".
   */
  refusal?: 'maintenance_mode_on' | 'window_reopened' | 'recheck_marker_moved' | 'no_recheck_due'
}

/**
 * o3d-hl8l r6 (Codex r5 finding 2) — A CLAIM IS NOT A LEASE.
 *
 * The manual path took a locked claim and then ran the pass in a separate transaction, and the
 * automatic path did not check maintenance mode at all — it read the marker with an unlocked
 * `findUnique` and went. Both left the same hole: a restore starting after the read, and the pass
 * then issuing WMS reads and enqueueing booked-in work into a window whose entire purpose is to keep
 * writers out. The claim proved SOMEONE held the marker; it proved nothing about whether a restore
 * was in flight, and nothing at all about the minutes the pass takes.
 *
 * The gate is now read at three points, each because a different thing goes wrong without it:
 *
 *   • BEFORE THE PASS — so a re-check issued into a live window does no WMS work at all;
 *   • BEFORE EACH CANDIDATE — so a window opening mid-pass stops it at the next ASN rather than
 *     running to the end of a hundred-ASN page. One settings row read against one WMS round trip per
 *     candidate is not a cost worth reasoning about, and the alternative — checking every N — is a
 *     bound chosen for no reason;
 *   • BEFORE CLEARING THE MARKER — see `clearPostMaintenanceRecheckMarker`, which re-decides it
 *     under the lock together with "is this still the marker we drained".
 *
 * A pass stopped this way KEEPS THE MARKER and reports `window_reopened`, so the next tick after the
 * window closes repeats it. Re-checking an ASN with nothing outstanding books nothing in, so the
 * repeat is cheap and the abandonment it prevents is not.
 */
async function isMaintenanceModeOn(): Promise<boolean> {
  const row = await db.setting.findUnique({ where: { key: MAINTENANCE_ENABLED_KEY } })
  return row?.value === 'true'
}

export type PostMaintenanceRecheckDeps = {
  recheckAsn: (externalAsnId: string, options: { reason: string }) => Promise<unknown>
}

export async function runPostMaintenanceBookedInRecheck(
  connectorId: WmsConnectorId,
  deps: PostMaintenanceRecheckDeps,
  options: { pageSize?: number } = {},
): Promise<PostMaintenanceRecheckResult> {
  const marker = await db.setting.findUnique({ where: { key: WMS_BOOKED_IN_RECHECK_DUE_KEY } })
  const windowEndedAt = marker?.value?.trim()
  if (!windowEndedAt) return { skipped: true, attempted: 0, failed: 0, drained: false }

  // A window in force here means a restore is running (or held). Every write this pass would cause
  // is being replayed over, and the WMS reads are wasted, so it does not start.
  if (await isMaintenanceModeOn()) {
    return { skipped: true, attempted: 0, failed: 0, drained: false, windowEndedAt, refusal: 'maintenance_mode_on' }
  }

  const pageSize = options.pageSize ?? POST_MAINTENANCE_RECHECK_PAGE_SIZE
  // Open ASNs only, and NOT the ones that were never verifiably created in the WMS — a synthetic
  // external id has nothing to re-read, so a re-check would fetch a shipment that does not exist.
  // Same exclusion, and the same reason, as the watchdog's overdue query.
  const openAsns = await db.wmsAsnMap.findMany({
    where: {
      connector: connectorId,
      closedAt: null,
      status: { notIn: ['CREATE_PENDING', 'CREATE_IN_FLIGHT'] },
    },
    // Oldest first: if the page truncates, the ASNs that have been waiting longest go first rather
    // than whichever the planner happened to return.
    orderBy: { createdAt: 'asc' },
    take: pageSize + 1,
    select: { externalAsnId: true },
  })

  const truncated = openAsns.length > pageSize
  const candidates = truncated ? openAsns.slice(0, pageSize) : openAsns

  let failed = 0
  let attempted = 0
  let reopened = false
  for (const asn of candidates) {
    // Re-read per candidate: a restore that starts mid-pass must stop it at the NEXT ASN, not at
    // the end of the page. The read is one settings row against one WMS round trip per candidate.
    if (await isMaintenanceModeOn()) {
      reopened = true
      console.warn(
        '[wms-post-maintenance-recheck] a maintenance window opened while the pass was running — '
          + `stopping after ${attempted} of ${candidates.length} ASN(s) and keeping the marker`,
      )
      break
    }
    attempted += 1
    try {
      await deps.recheckAsn(asn.externalAsnId, {
        reason: `automatic re-check after maintenance window ended ${windowEndedAt}`,
      })
    } catch (error) {
      failed += 1
      console.error(`[wms-post-maintenance-recheck] re-check failed for ${asn.externalAsnId}:`, error)
    }
  }

  // Keep the marker when anything is still owed — a truncated page, an attempt that threw, or a
  // window that reopened. The next tick repeats the pass; a re-check of an ASN with nothing
  // outstanding books nothing in, so repeating is cheap and losing an ASN is not.
  const complete = !truncated && failed === 0 && !reopened
  let drained = false
  let refusal: PostMaintenanceRecheckResult['refusal'] = reopened ? 'window_reopened' : undefined
  if (complete) {
    // Not a bare delete: the marker is only ours to clear if no window opened during the pass AND
    // it is still the same marker we drained. See `clearPostMaintenanceRecheckMarker`.
    const cleared = await db.$transaction((tx) => clearPostMaintenanceRecheckMarker(tx, { windowEndedAt }))
    drained = cleared.cleared
    if (!cleared.cleared) {
      refusal = cleared.reason === 'maintenance_mode_on'
        ? 'window_reopened'
        : cleared.reason === 'recheck_marker_moved'
          ? 'recheck_marker_moved'
          : 'no_recheck_due'
      console.warn(
        `[wms-post-maintenance-recheck] the pass finished but the marker was not cleared (${cleared.reason}) — `
          + 'it describes a window this pass did not establish anything about',
      )
    }
  }

  if (attempted > 0 || reopened) {
    await logActivity({
      entityType: 'SYNC',
      tag: 'sync',
      action: 'wms_post_maintenance_recheck',
      level: failed > 0 || refusal ? 'WARNING' : 'INFO',
      description:
        `Re-checked ${attempted} open ASN(s) after a maintenance window ended ${windowEndedAt}`
        + (failed > 0 ? ` — ${failed} could not be re-checked and will be retried` : '')
        + (reopened ? ' — a maintenance window opened mid-pass, so the rest were left for the next tick' : '')
        + (refusal === 'recheck_marker_moved' ? ' — the marker moved during the pass and was left alone' : '')
        + (truncated ? ' — more remain and will be re-checked next tick' : ''),
      metadata: { connector: connectorId, windowEndedAt, attempted, failed, truncated, refusal: refusal ?? null },
      resolveUser: false,
    })
  }

  return { skipped: false, attempted, failed, drained, windowEndedAt, ...(refusal ? { refusal } : {}) }
}

/**
 * o3d-hl8l r5 (Codex r4 finding 1) — THE SAME DRAIN, RESOLVED AGAINST THE ACTIVE CONNECTOR.
 *
 * The automatic pass is wired by a connector-named cron route, which is where a connector literal
 * belongs. The OPERATOR path is not connector-named — it is a button on the connector-agnostic
 * exception inbox — so the resolution lives here, behind the WMS boundary, rather than in
 * `app/actions/sync-exceptions.ts` where naming a connector would be exactly the leak
 * `scripts/check-wms-connector-boundary.mjs` exists to stop.
 *
 * Returns `null` when no connector that can perform a booked-in re-check is enabled. The marker is
 * deliberately left alone in that case: it is still owed, and it will be drained when the connector
 * that owes it is back.
 */
export async function runPostMaintenanceRecheckForActiveConnector(
  options: { pageSize?: number } = {},
): Promise<(PostMaintenanceRecheckResult & { connector: WmsConnectorId }) | null> {
  const connectorId = await getEnabledWmsConnectorId()
  // Only the Mintsoft connector implements a booked-in re-check; ShipHero's inbound path does not go
  // through this trigger at all, so there is nothing to reconstruct for it.
  if (connectorId !== 'mintsoft') return null

  const result = await runPostMaintenanceBookedInRecheck(connectorId, {
    recheckAsn: (externalAsnId, recheckOptions) => enqueueMintsoftBookedInRecheckForAsn(externalAsnId, recheckOptions),
  }, options)
  return { ...result, connector: connectorId }
}
