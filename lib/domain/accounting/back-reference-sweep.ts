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
// THREE DEFECTS THIS SHAPE EXISTS TO AVOID (o3d-9kek):
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
// 3. RESOLVE-THEN-APPLY. The sweep used to resolve a PO row to a bill and then issue an
//    UNCONDITIONAL update against it, with a comment claiming the apply could detect a
//    population change — it could not: `update` matches on the primary key alone. A normal
//    bill-keyed sync linking that bill in between had its valid id replaced by the legacy
//    row's. The apply is now a resolve-and-compare-and-swap inside ONE transaction, under a
//    per-PurchaseOrder advisory lock (see applyBackReference).
//
// WHAT IS STAMPED, AND WHAT IS NOT (o3d-9kek, Codex r9 #2). The marker is a VERDICT, and a
// verdict must be about something that cannot change. Stamped: a row structurally incapable
// of carrying a back-reference, and a row whose document is linked and whose follow-ups are
// done. NOT stamped: any transient failure, and — this is the correction — ANY ambiguous PO
// row. Both ambiguity inputs are mutable. A PENDING/PROCESSING/FAILED sibling can be
// cancelled or post; several unlinked bills shrink to one as their own bill-keyed syncs
// finish; and a human acting on the warning links a bill by hand, which is exactly what the
// warning asks for. Stamping any of those permanently excludes a row that has since become
// repairable — the starvation bug again, by a second route. An ambiguous row is instead
// DEFERRED: backReferenceAmbiguousLoggedAt takes it out of the candidate set for one recheck
// interval, so a backlog of unattributable legacy rows can neither spam the activity log nor
// re-fill the head of the scan, and it comes back on its own when the interval passes.
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

/**
 * How long an unresolved PO ambiguity is deferred before it is re-probed and re-reported.
 *
 * ONE interval doing two jobs, deliberately, because they are the same event. An ambiguous
 * row is NOT stamped as checked — it can become repairable, and excluding it before that
 * happens is the starvation this sweep exists to fix. But leaving it fully eligible means
 * re-probing it on every cron cycle and re-writing its WARNING every time; a backlog of them
 * would also re-fill the head of the scan and starve newer rows across runs. So it is
 * deferred for this interval, then looked at again.
 *
 * Not "log exactly once", which is what stamping gave: the warning names a MANUAL action,
 * and silence about a row nobody ever linked reads as "handled". The repeat carries
 * `previouslyLoggedAt` so it is visibly a repeat rather than a new problem.
 */
export const BACK_REFERENCE_AMBIGUITY_RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export type BackReferenceSweepRow = {
  id: string
  type: AccountingSyncType
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  status: string
  payload: unknown
  createdAt: Date
  /** When this row's PO ambiguity was last reported. NULL = never. */
  backReferenceAmbiguousLoggedAt: Date | null
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
  backReferenceAmbiguousLoggedAt: true,
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
  /**
   * Legacy PO-keyed rows whose bill could not be attributed. They stay ELIGIBLE (the
   * ambiguity can resolve), so this counts the same row on every run until it does — the
   * WARNING behind it is throttled, this number is not.
   */
  skippedAmbiguous: number
}

export type BackReferenceCandidateCursor = { createdAt: Date; id: string }

/**
 * The candidate query. Pure, and exported so a test can assert the predicates the sweep
 * depends on rather than trusting a double to honour them.
 *
 * Three predicates carry the anti-starvation design, and they are NOT interchangeable:
 *
 *   • `backReferenceCheckedAt: null` — the permanent verdict. A reconciled row leaves the
 *     candidate set for good, which is what stopped 200 ordinary historical rows filling
 *     the bounded page on every cron cycle forever.
 *   • the keyset on (createdAt, id) — walks the population instead of re-reading its head,
 *     so a row this run cannot settle never blocks the rows behind it WITHIN a run.
 *   • `backReferenceAmbiguousLoggedAt` older than the recheck cutoff — a DEFERRAL, not a
 *     verdict. Ambiguity can clear (a sibling is cancelled or posts, several unlinked bills
 *     shrink to one, a human links a bill), so the row must stay eligible; but re-probing
 *     it every cycle would let a backlog of unattributable legacy rows re-fill the head of
 *     the scan ACROSS runs and starve everything newer — the original bug wearing the
 *     other defect's clothes. Deferring it for the interval keeps both properties.
 */
export function buildBackReferenceCandidateQuery(params: {
  connector: string
  after: BackReferenceCandidateCursor | null
  /** Rows whose ambiguity was reported at or after this are deferred until it passes. */
  ambiguityRecheckBefore: Date
  take: number
}): BackReferenceCandidateQuery {
  const notRecentlyAmbiguous = {
    OR: [
      { backReferenceAmbiguousLoggedAt: null },
      { backReferenceAmbiguousLoggedAt: { lt: params.ambiguityRecheckBefore } },
    ],
  }
  const where: Record<string, unknown> = {
    connector: params.connector,
    status: { in: ['SYNCED', 'FAILED'] },
    externalTransactionId: { not: null },
    type: { in: [...BACK_REFERENCE_SWEEP_TYPES] },
    backReferenceCheckedAt: null,
    // Nested under AND because the keyset clause below also needs the top-level OR slot.
    AND: [notRecentlyAmbiguous],
  }
  if (params.after) {
    where.AND = [
      notRecentlyAmbiguous,
      {
        OR: [
          { createdAt: { gt: params.after.createdAt } },
          { AND: [{ createdAt: params.after.createdAt }, { id: { gt: params.after.id } }] },
        ],
      },
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
  // One cutoff for the whole run, so every page of the scan agrees on which deferred rows
  // are due — a per-page `new Date()` would let a row fall on both sides of the boundary.
  const ambiguityRecheckBefore = new Date(now().getTime() - BACK_REFERENCE_AMBIGUITY_RECHECK_INTERVAL_MS)

  /**
   * Record a verdict: this row needs nothing further, so it leaves the candidate set.
   * NEVER called for a transient failure, and never for an AMBIGUOUS PO row — both can
   * become repairable, and a row excluded before that happens is starved for good.
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
      buildBackReferenceCandidateQuery({ connector, after, ambiguityRecheckBefore, take }),
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

        // A PO-keyed row is attributed from the whole population for that PO, not from this
        // page. This probe only CLASSIFIES the row; the authoritative attribution is redone
        // inside applyBackReference's transaction, under the per-PO lock, so nothing decided
        // here can be acted on after the state it read has moved (o3d-9kek finding 3).
        let missing: boolean
        if (row.type === 'PURCHASE_INVOICE' && row.referenceType === 'PurchaseOrder') {
          let attribution: PurchaseOrderAttribution
          try {
            attribution = await resolvePurchaseOrderBackReference(deps.db, {
              connector,
              purchaseOrderId: row.referenceId,
              externalId: row.externalTransactionId,
            })
          } catch (attributionError) {
            console.error(`${prefix}: back-reference PO attribution failed`, row.id, attributionError)
            result.failed++
            continue
          }
          if (attribution.outcome === 'ambiguous') {
            result.skippedAmbiguous++
            const previouslyLoggedAt = row.backReferenceAmbiguousLoggedAt
            const observedAt = now()
            // The candidate query already filtered on this, from the same cutoff. Re-asserted
            // here so "at most one warning per interval" holds on the row itself and not only
            // on a query a future edit could loosen.
            const dueToReport = previouslyLoggedAt === null || previouslyLoggedAt < ambiguityRecheckBefore
            if (dueToReport) {
              await deps.logActivity({
                entityType: 'SYSTEM',
                action: `${prefix}_backreference_repair_ambiguous`,
                tag: 'sync',
                level: 'WARNING',
                description: `Skipped ${connectorLabel} back-reference repair for PO ${row.referenceId}: `
                  + (attribution.reason === 'MULTIPLE_SYNC_ROWS'
                    ? `${attribution.syncRowCount} posted bill sync rows reference this PO, so which bill this external id belongs to cannot be determined.`
                    : 'the PO has several bills with no external id, so which one this external id belongs to cannot be determined.')
                  + ' Link them manually.'
                  + (previouslyLoggedAt === null ? '' : ` Still unresolved since this was last reported at ${previouslyLoggedAt.toISOString()}.`),
                metadata: {
                  syncLogId: row.id,
                  referenceId: row.referenceId,
                  reason: attribution.reason,
                  syncRowCount: attribution.syncRowCount,
                  unlinkedBillCount: attribution.unlinkedBillCount,
                  previouslyLoggedAt: previouslyLoggedAt?.toISOString() ?? null,
                },
              })
              // A DEFERRAL, deliberately NOT backReferenceCheckedAt: ambiguity is not a
              // verdict — a sibling can be cancelled or post, several unlinked bills can
              // shrink to one, and the manual link this warning asks for changes the answer.
              // Stamping it as checked excluded a row that had since become repairable, which
              // is the starvation this sweep exists to prevent (Codex r9 #2). This takes the
              // row out of the candidate set for ONE interval and no longer.
              await deps.db.accountingSyncLog.update({
                where: { id: row.id },
                data: { backReferenceAmbiguousLoggedAt: observedAt },
              })
            }
            continue
          }
          // 'none' → every bill already linked; 'already-linked' → this row's own id is
          // where it belongs. Nothing to apply either way, but a FAILED row may still owe
          // its follow-ups, so fall through to the shared path below.
          missing = attribution.outcome === 'unique'
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

        // Where the write actually landed. For a PO-keyed row that is the bill the FENCED
        // attribution chose, which is the only attribution that ever reaches a write.
        let appliedTo = { referenceType: row.referenceType, referenceId: row.referenceId }
        try {
          if (!followUpsOnly) {
            // Passed with its ORIGINAL PurchaseOrder reference, not the bill this pass's
            // probe resolved: applyBackReference re-resolves under a per-PO advisory lock and
            // writes with a compare-and-swap on the bill still being unlinked, so the pair is
            // atomic. Handing it a pre-resolved bill id is what made the write unconditional
            // and let it clobber a concurrently linked bill (o3d-9kek finding 3).
            const applied = await applyBackReference(deps.db, params)
            if (applied.outcome !== 'applied') {
              // `contended` — a concurrent writer linked the bill first, so the swap matched
              // no row and nothing was overwritten. `ambiguous`/`nothing-to-apply`/
              // `already-linked` — the population moved between the probe and the fenced
              // re-resolve. Never stamp: the next run re-resolves from fresh state and will
              // settle it (typically as already-linked).
              console.error(`${prefix}: back-reference apply declined`, row.id, applied.outcome)
              result.failed++
              continue
            }
            appliedTo = { referenceType: applied.referenceType, referenceId: applied.referenceId }
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
            description: `Re-applied missing ${connectorLabel} back-reference for ${appliedTo.referenceType} ${appliedTo.referenceId} `
              + `(external id ${row.externalTransactionId}).`,
            metadata: {
              syncLogId: row.id,
              type: row.type,
              referenceType: appliedTo.referenceType,
              referenceId: appliedTo.referenceId,
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
