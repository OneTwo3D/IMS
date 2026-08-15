import type { AccountingSyncType } from '@/app/generated/prisma/client'
import {
  applyBackReference,
  backReferenceIsMissing,
  resolvePurchaseOrderBackReference,
  syncTypeWritesBackReference,
  type BackReferenceDeps,
  type PurchaseOrderAttribution,
} from './back-reference'

// ---------------------------------------------------------------------------
// Connector-agnostic back-reference repair sweep (audit-H3, fixed by o3d-9kek)
//
// Finds sync rows that posted to the accounting connector (they carry an
// externalTransactionId) but whose source document never received that id — the
// process died between marking the row SYNCED and writing the back-reference, or the
// back-reference retries were exhausted to FAILED. It re-applies the id from the stored
// external id AND re-enqueues the follow-ups (PDF / payment / attachment) that never
// ran, so no document is permanently orphaned. Idempotent; safe to run from cron and on
// demand.
//
// TWO DEFECTS THIS SHAPE EXISTS TO AVOID (o3d-9kek):
//
// 1. STARVATION. The sweep used to take the oldest 200 eligible rows every run. A row
//    probed and found already linked was skipped but stayed ELIGIBLE — nothing recorded
//    that it had been checked — so once 200 ordinary historical rows existed, every cron
//    cycle re-selected and re-probed exactly those 200 and a newly-broken row beyond the
//    boundary was NEVER examined, until retention deleted its sync log. Fixed by two
//    things together: rows the sweep reaches a verdict on are stamped
//    (backReferenceCheckedAt) and leave the candidate set for good, and the scan
//    keyset-paginates across the whole population instead of re-reading its head, so
//    rows it cannot settle (a transient failure) never block the rows behind them.
//
// 2. PAGE-LOCAL AMBIGUITY. The old PO guard counted PurchaseOrder-keyed rows WITHIN the
//    capped page, so a second row for the same PO one row past the boundary — or a PO
//    with several unlinked bills but only one sync row — passed the check and the id was
//    written onto the wrong bill. Ambiguity is now decided from the actual population
//    for that PO (see resolvePurchaseOrderBackReference).
//
// The sweep must keep refusing to guess: failing to repair is acceptable, repairing onto
// the wrong bill is not.
// ---------------------------------------------------------------------------

/** Sync types that can carry a back-reference. Matches syncTypeWritesBackReference's pairs. */
export const BACK_REFERENCE_SWEEP_TYPES = ['SALES_INVOICE', 'CREDIT_NOTE', 'PURCHASE_INVOICE'] as const

/** Rows examined per run, across all pages. */
export const DEFAULT_BACK_REFERENCE_SWEEP_LIMIT = 200
/** Rows fetched per query. Several small pages, not one big head-read. */
export const DEFAULT_BACK_REFERENCE_SWEEP_PAGE_SIZE = 50

export type BackReferenceSweepRow = {
  id: string
  type: AccountingSyncType
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  status: string
  payload: unknown
  createdAt: Date
}

/** The columns the sweep reads. `as const` so the Prisma client's row type resolves. */
export const BACK_REFERENCE_CANDIDATE_SELECT = {
  id: true,
  type: true,
  referenceType: true,
  referenceId: true,
  externalTransactionId: true,
  status: true,
  payload: true,
  createdAt: true,
} as const

export type BackReferenceCandidateQuery = {
  where: Record<string, unknown>
  select: typeof BACK_REFERENCE_CANDIDATE_SELECT
  orderBy: Array<{ createdAt?: 'asc' | 'desc'; id?: 'asc' | 'desc' }>
  take: number
}

export type BackReferenceSweepClient = BackReferenceDeps & {
  accountingSyncLog: {
    findMany(args: BackReferenceCandidateQuery): Promise<BackReferenceSweepRow[]>
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>
  }
}

export type BackReferenceSweepActivity = {
  entityType: 'SYSTEM'
  action: string
  tag: string
  level: 'INFO' | 'WARNING'
  description: string
  metadata: Record<string, unknown>
}

export type BackReferenceSweepDeps = {
  db: BackReferenceSweepClient
  /** AccountingSyncLog.connector value this sweep owns, e.g. 'xero'. */
  connector: string
  /** Human name used in activity-log descriptions, e.g. 'Xero'. */
  connectorLabel: string
  /** Activity action prefix, e.g. 'xero' → 'xero_backreference_repaired'. */
  activityActionPrefix: string
  logActivity: (entry: BackReferenceSweepActivity) => Promise<unknown>
  enqueueFollowUps: (
    entryId: string,
    type: AccountingSyncType,
    referenceType: string,
    referenceId: string,
    payload: Record<string, unknown>,
    syncResult: { externalId?: string; invoiceNumber?: string },
  ) => Promise<void>
  now?: () => Date
}

export type BackReferenceRepairResult = {
  /** Rows the sweep looked at this run — the pagination's unit of work. */
  scanned: number
  /** Rows whose document was confirmed still missing its id (i.e. needed repair). */
  checked: number
  /** Rows whose back-reference was successfully re-applied. */
  repaired: number
  /** Rows that errored during probe or repair. Deliberately left unstamped, so they retry. */
  failed: number
  /** Legacy PO-keyed rows whose bill could not be attributed; logged for manual linking. */
  skippedAmbiguous: number
}

export type BackReferenceCandidateCursor = { createdAt: Date; id: string }

/**
 * The candidate query. Pure, and exported so a test can assert the predicates the sweep
 * depends on rather than trusting a double to honour them.
 *
 * `backReferenceCheckedAt: null` is the marker that makes the set shrink; the keyset
 * clause on (createdAt, id) is what walks the population instead of re-reading its head.
 */
export function buildBackReferenceCandidateQuery(params: {
  connector: string
  after: BackReferenceCandidateCursor | null
  take: number
}): BackReferenceCandidateQuery {
  const where: Record<string, unknown> = {
    connector: params.connector,
    status: { in: ['SYNCED', 'FAILED'] },
    externalTransactionId: { not: null },
    type: { in: [...BACK_REFERENCE_SWEEP_TYPES] },
    backReferenceCheckedAt: null,
  }
  if (params.after) {
    where.OR = [
      { createdAt: { gt: params.after.createdAt } },
      { AND: [{ createdAt: params.after.createdAt }, { id: { gt: params.after.id } }] },
    ]
  }
  return {
    where,
    select: BACK_REFERENCE_CANDIDATE_SELECT,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: params.take,
  }
}

export async function repairAccountingBackReferences(
  deps: BackReferenceSweepDeps,
  options: { limit?: number; pageSize?: number } = {},
): Promise<BackReferenceRepairResult> {
  const limit = options.limit ?? DEFAULT_BACK_REFERENCE_SWEEP_LIMIT
  const pageSize = Math.max(1, Math.min(options.pageSize ?? DEFAULT_BACK_REFERENCE_SWEEP_PAGE_SIZE, limit))
  const now = deps.now ?? (() => new Date())
  const { connector, connectorLabel, activityActionPrefix: prefix } = deps

  const result: BackReferenceRepairResult = { scanned: 0, checked: 0, repaired: 0, failed: 0, skippedAmbiguous: 0 }

  /**
   * Record a verdict: this row needs nothing further, so it leaves the candidate set.
   * NEVER called for a transient failure — such a row must stay eligible.
   */
  const markChecked = async (id: string, extra?: Record<string, unknown>) => {
    await deps.db.accountingSyncLog.update({
      where: { id },
      data: { backReferenceCheckedAt: now(), ...extra },
    })
  }

  let after: BackReferenceCandidateCursor | null = null
  while (result.scanned < limit) {
    const take = Math.min(pageSize, limit - result.scanned)
    const page = await deps.db.accountingSyncLog.findMany(
      buildBackReferenceCandidateQuery({ connector, after, take }),
    )
    if (page.length === 0) break

    for (const row of page) {
      // Advance the cursor for EVERY row read, settled or not — a row this run cannot
      // settle (probe threw, follow-ups deferred) stays a candidate, and without the
      // keyset it would be re-read as the head of the next page forever.
      after = { createdAt: row.createdAt, id: row.id }
      result.scanned++

      try {
        if (!row.externalTransactionId || !syncTypeWritesBackReference(row.type, row.referenceType)) {
          // Structurally incapable of carrying a back-reference. It would otherwise sit in
          // the candidate set for the row's whole retention life, consuming a slot.
          await markChecked(row.id)
          continue
        }

        const payload = (row.payload ?? {}) as Record<string, unknown>
        const invoiceNumber = typeof payload.invoiceNumber === 'string' ? payload.invoiceNumber : undefined
        const params = {
          connector,
          type: row.type,
          referenceType: row.referenceType,
          referenceId: row.referenceId,
          externalId: row.externalTransactionId,
          invoiceNumber,
        }

        // A PO-keyed row is attributed from the whole population for that PO, not from
        // this page. `applyParams` names the resolved BILL, so the apply cannot fall back
        // to a heuristic.
        let applyParams = params
        let missing: boolean
        if (row.type === 'PURCHASE_INVOICE' && row.referenceType === 'PurchaseOrder') {
          let attribution: PurchaseOrderAttribution
          try {
            attribution = await resolvePurchaseOrderBackReference(deps.db, { connector, purchaseOrderId: row.referenceId })
          } catch (attributionError) {
            console.error(`${prefix}: back-reference PO attribution failed`, row.id, attributionError)
            result.failed++
            continue
          }
          if (attribution.outcome === 'ambiguous') {
            result.skippedAmbiguous++
            await deps.logActivity({
              entityType: 'SYSTEM',
              action: `${prefix}_backreference_repair_ambiguous`,
              tag: 'sync',
              level: 'WARNING',
              description: `Skipped ${connectorLabel} back-reference repair for PO ${row.referenceId}: `
                + (attribution.reason === 'MULTIPLE_SYNC_ROWS'
                  ? `${attribution.syncRowCount} posted bill sync rows reference this PO, so which bill this external id belongs to cannot be determined.`
                  : 'the PO has several bills with no external id, so which one this external id belongs to cannot be determined.')
                + ' Link them manually.',
              metadata: {
                syncLogId: row.id,
                referenceId: row.referenceId,
                reason: attribution.reason,
                syncRowCount: attribution.syncRowCount,
                unlinkedBillCount: attribution.unlinkedBillCount,
              },
            })
            // Verdict reached: it will not become attributable on its own, and re-logging
            // the same warning every cron cycle is noise. A manual link clears the bill's
            // null id, which is the state this row is waiting on anyway.
            await markChecked(row.id)
            continue
          }
          // 'none' → every bill already linked; nothing to apply, but a FAILED row may
          // still owe its follow-ups, so fall through to the shared path below.
          missing = attribution.outcome === 'unique'
          if (attribution.outcome === 'unique') {
            applyParams = { ...params, referenceType: 'PurchaseInvoice', referenceId: attribution.purchaseInvoiceId }
          }
        } else {
          try {
            missing = await backReferenceIsMissing(deps.db, params)
          } catch (probeError) {
            console.error(`${prefix}: back-reference probe failed`, row.id, probeError)
            result.failed++
            continue
          }
        }

        // A row whose back-reference is already applied but is STILL FAILED is precisely the
        // "back-reference done, follow-ups not enqueued" state a previous pass can leave behind.
        // Skipping it on `!missing` meant those follow-ups were never retried — leaving the row
        // FAILED accomplished nothing (Codex r7 #2).
        const followUpsOnly = !missing && row.status === 'FAILED'
        if (!missing && !followUpsOnly) {
          // Linked and SYNCED: reconciled. Stamped, so it never occupies a slot again.
          await markChecked(row.id)
          continue
        }
        // Counted as CHECKED either way, but a follow-ups-only pass is not a repair: nothing was
        // re-applied, so it must not inflate `repaired` (Codex review, r8).
        result.checked++

        try {
          if (!followUpsOnly) {
            const applied = await applyBackReference(deps.db, applyParams)
            if (applied.outcome !== 'applied') {
              // The population changed under us between resolving and applying. Do not stamp
              // — the next run re-resolves from fresh state.
              console.error(`${prefix}: back-reference apply declined`, row.id, applied.outcome)
              result.failed++
              continue
            }
          }
          // The follow-ups (PDF, payment, attachment) never ran on the original failed pass —
          // enqueue them now. The connector's own idempotency makes this safe to repeat.
          let followUpsEnqueued = true
          try {
            await deps.enqueueFollowUps(row.id, row.type, row.referenceType, row.referenceId, payload, {
              externalId: row.externalTransactionId,
              invoiceNumber,
            })
          } catch (followUpError) {
            followUpsEnqueued = false
            console.error(`${prefix}: back-reference follow-up enqueue failed`, row.id, followUpError)
            await deps.logActivity({
              entityType: 'SYSTEM',
              action: `${prefix}_backreference_followup_deferred`,
              tag: 'sync',
              level: 'WARNING',
              description: `Applied the ${connectorLabel} back-reference for ${row.referenceType} ${row.referenceId} but could not `
                + `enqueue its follow-ups: ${String(followUpError)}. The row stays FAILED so the next sweep retries them.`,
              metadata: { syncLogId: row.id, referenceType: row.referenceType, referenceId: row.referenceId },
            })
          }
          // A FAILED row whose back-reference is now applied is fully reconciled — but ONLY if
          // its follow-ups were actually enqueued. Marking it SYNCED regardless retired the one
          // source that would retry them, so a transient enqueue failure lost the payment or PDF
          // permanently (Codex review, r6). Leaving it FAILED is what makes the retry durable —
          // and leaving it UNSTAMPED is what makes the next sweep look at it again.
          if (followUpsEnqueued) {
            await markChecked(row.id, row.status === 'FAILED' ? { status: 'SYNCED', errorMessage: null } : undefined)
          }

          if (followUpsOnly) {
            // Nothing was repaired — this pass existed only to retry the follow-ups. Reporting it
            // as a repair would overstate what the sweep did.
            if (followUpsEnqueued) {
              await deps.logActivity({
                entityType: 'SYSTEM',
                action: `${prefix}_backreference_followups_recovered`,
                tag: 'sync',
                level: 'INFO',
                description: `Enqueued the outstanding ${connectorLabel} follow-ups for ${row.referenceType} ${row.referenceId}; its `
                  + 'back-reference was already applied by an earlier pass.',
                metadata: { syncLogId: row.id, type: row.type, referenceType: row.referenceType, referenceId: row.referenceId },
              })
            }
            continue
          }
          result.repaired++
          await deps.logActivity({
            entityType: 'SYSTEM',
            action: `${prefix}_backreference_repaired`,
            tag: 'sync',
            level: 'INFO',
            description: `Re-applied missing ${connectorLabel} back-reference for ${applyParams.referenceType} ${applyParams.referenceId} `
              + `(external id ${row.externalTransactionId}).`,
            metadata: {
              syncLogId: row.id,
              type: row.type,
              referenceType: applyParams.referenceType,
              referenceId: applyParams.referenceId,
            },
          })
        } catch (repairError) {
          result.failed++
          console.error(`${prefix}: back-reference repair failed`, row.id, repairError)
        }
      } catch (rowError) {
        // Anything the per-row handling did not anticipate (e.g. the marker write itself
        // failing). Unstamped, so it is retried rather than silently dropped.
        result.failed++
        console.error(`${prefix}: back-reference sweep row failed`, row.id, rowError)
      }
    }

    if (page.length < take) break
  }

  return result
}
