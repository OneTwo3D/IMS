import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { WMS_BOOKED_IN_RECHECK_DUE_KEY } from '@/lib/maintenance-mode'
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
  for (const asn of candidates) {
    try {
      await deps.recheckAsn(asn.externalAsnId, {
        reason: `automatic re-check after maintenance window ended ${windowEndedAt}`,
      })
    } catch (error) {
      failed += 1
      console.error(`[wms-post-maintenance-recheck] re-check failed for ${asn.externalAsnId}:`, error)
    }
  }

  // Keep the marker when anything is still owed — a truncated page, or an attempt that threw. The
  // next tick repeats the pass; a re-check of an ASN with nothing outstanding books nothing in, so
  // repeating is cheap and losing an ASN is not.
  const drained = !truncated && failed === 0
  if (drained) {
    await db.setting.deleteMany({ where: { key: WMS_BOOKED_IN_RECHECK_DUE_KEY } })
  }

  if (candidates.length > 0) {
    await logActivity({
      entityType: 'SYNC',
      tag: 'sync',
      action: 'wms_post_maintenance_recheck',
      level: failed > 0 ? 'WARNING' : 'INFO',
      description:
        `Re-checked ${candidates.length} open ASN(s) after a maintenance window ended ${windowEndedAt}`
        + (failed > 0 ? ` — ${failed} could not be re-checked and will be retried` : '')
        + (truncated ? ' — more remain and will be re-checked next tick' : ''),
      metadata: { connector: connectorId, windowEndedAt, attempted: candidates.length, failed, truncated },
      resolveUser: false,
    })
  }

  return { skipped: false, attempted: candidates.length, failed, drained, windowEndedAt }
}
