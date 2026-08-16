import type { AccountingSyncStatus, AccountingSyncType } from '@/app/generated/prisma/client'
import {
  applyBackReference,
  backReferenceIsMissing,
  resolvePurchaseOrderBackReference,
  syncTypeWritesBackReference,
  type AmbiguousPurchaseOrderAttribution,
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
// TWO MORE, FOUND IN ROUND 3:
//
// 4. THE NAMESPACE. External ids are TENANT-OWNED, and QuickBooks realm ids are integers that
//    repeat across companies. A sweep that reasons about ids globally will take a row posted to
//    realm A and attribute its id under realm B, where the same integer is a different document.
//    The sweep therefore runs inside ONE namespace: `deps.provenance` is the connected
//    "<connector>:<tenantId>", the candidate query matches the row's own stored provenance against
//    it, and a run with no connected tenant does nothing at all.
//
// 5. THE CURSOR RESET. The keyset walked the population within a run but started at the head on
//    every invocation, and the budget counts rows SCANNED — including rows left eligible by a
//    failure. A persistently failing oldest `limit` rows therefore ate every run's budget and the
//    row behind them was never reached: starvation for a third time. The cursor is now persisted
//    between runs and rotates, so the next run resumes BEHIND the rows this one could not settle —
//    which is what makes it work for exactly the rows about which nothing can be recorded.
//
// The sweep must keep refusing to guess: failing to repair is acceptable, repairing onto
// the wrong bill is not.
// ---------------------------------------------------------------------------

/** Sync types that can carry a back-reference. Matches syncTypeWritesBackReference's pairs. */
export const BACK_REFERENCE_SWEEP_TYPES = ['SALES_INVOICE', 'CREDIT_NOTE', 'PURCHASE_INVOICE'] as const

/**
 * Rows that are still UNRESOLVED BACK-REFERENCE EVIDENCE, i.e. rows this sweep has not reached a
 * verdict on. Exported so data retention and the sweep cannot drift apart (o3d-9kek r2 finding 2).
 *
 * WHY RETENTION MUST NOT DELETE THESE. Retention deletes accounting_sync_logs by age alone, on its
 * own schedule, while the sweep reads its candidate page outside the transaction that later acts
 * on it. Deleting one of these rows destroys the only record that an external document exists
 * with no local link — and, worse, deleting a COMPETING sibling silently converts an ambiguity
 * into an apparent certainty: one unlinked bill, one surviving claimant, and the sweep attributes
 * a bill whose competitor it can no longer see. Neither the resolver's exactly-one-row rule nor
 * the unique index can detect that, because after the delete the state is genuinely
 * indistinguishable from an unambiguous one.
 *
 * WHY THIS IS NOT AN OPEN-ENDED EXEMPTION ANY MORE (o3d-9kek r3 finding 3). The earlier argument —
 * "the sweep stamps everything it settles, so this set drains" — was wrong, and provably so:
 *
 *   • a permanently ambiguous row is never stamped BY DESIGN (stamping it is the starvation bug);
 *   • rows of a connector that is later disconnected are never swept at all, so never stamped;
 *   • every QuickBooks invoice/bill row was unstamped forever, because no QuickBooks sweep ran.
 *
 * Full payload rows — customer names, emails, addresses, financial lines — could therefore survive
 * a configured retention policy indefinitely, and a retention policy that silently fails to delete
 * is worse than one that deletes too much. So the row is no longer EXEMPTED: at the cutoff it is
 * COMPACTED to an attribution-only tombstone (see backReferenceEvidenceTombstone), which keeps the
 * competing-claimant evidence and drops the content. This predicate now selects what to compact as
 * well as what not to delete, which is why the two can never disagree about the same row.
 */
export const UNRESOLVED_BACK_REFERENCE_EVIDENCE_WHERE: {
  backReferenceCheckedAt: null
  externalTransactionId: { not: null }
  status: { in: AccountingSyncStatus[] }
  type: { in: AccountingSyncType[] }
} = {
  backReferenceCheckedAt: null,
  externalTransactionId: { not: null },
  status: { in: ['SYNCED', 'FAILED'] },
  type: { in: [...BACK_REFERENCE_SWEEP_TYPES] },
}

/**
 * The TOMBSTONE an expired-but-unresolved row is compacted to (o3d-9kek r3 finding 3).
 *
 * WHAT IT KEEPS, and why each column is load-bearing: connector + provenance + type +
 * referenceType + referenceId + externalTransactionId + status. That is exactly the set the
 * PurchaseOrder resolver counts to decide "does more than one posted row claim this order's bill".
 * Keeping it is what stops retention converting an ambiguity into a confident wrong answer.
 *
 * WHAT IT DELIBERATELY DOES NOT KEEP:
 *   • `payload` — the document as sent: customer and supplier names, email addresses, delivery
 *     addresses, line descriptions and amounts. This is the bulk AND the personal data, and it is
 *     the reason the old exemption could not simply be left alone.
 *   • `errorMessage` — free text echoing connector responses, which routinely quote the payload.
 *
 * The cost, stated rather than hidden: a tombstoned row can no longer be REPAIRED, because the
 * follow-ups (PDF, payment, attachment) cannot be rebuilt without the payload. It is evidence, not
 * work. That is the right trade at the retention horizon — a row still unresolved months later is
 * one the sweep has already refused to attribute and warned a human about daily — and it obeys the
 * governing principle: failing to repair is acceptable, repairing onto the wrong bill is not.
 */
export function backReferenceEvidenceTombstone(now: Date): {
  payload: Record<string, never>
  errorMessage: null
  backReferenceEvidenceCompactedAt: Date
} {
  return { payload: {}, errorMessage: null, backReferenceEvidenceCompactedAt: now }
}

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

/**
 * Where the previous run stopped, persisted BETWEEN runs (o3d-9kek r3 finding 4).
 *
 * The in-memory keyset walked the population within a run but restarted at the head on every
 * invocation, and the run budget counts rows SCANNED — including rows left eligible because their
 * probe, apply, follow-up or activity-log write failed. So if the oldest `limit` rows fail
 * persistently (the sweep's own reason to exist: things that are broken tend to stay broken), every
 * run spends its entire budget on the same rows and row `limit + 1` is never reached. That is the
 * original starvation bug in a third form, and no per-row marker fixes it, because the rows in
 * question are precisely the ones that must NOT be marked.
 *
 * A persisted cursor fixes it independently of any per-row state: the next run RESUMES where this
 * one stopped, so the failing head is skipped whether or not anything about it could be recorded.
 *
 * The alternative — deferring every unsettled row with a retry timestamp — was rejected: it would
 * re-introduce the r2 finding 3 hole. An ambiguity whose WARNING could not be persisted is left
 * immediately eligible on purpose, because deferring a row nobody was told about is silence with
 * no notification behind it. Deferring it to fix starvation trades one defect for the other; the
 * cursor fixes starvation without touching that property at all.
 */
export type BackReferenceCandidateCursorStore = {
  load(): Promise<BackReferenceCandidateCursor | null>
  save(cursor: BackReferenceCandidateCursor | null): Promise<void>
}

/** The Setting row a connector's sweep cursor lives in. One per connector, never shared. */
export function backReferenceSweepCursorSettingKey(connector: string): string {
  return `${connector}_backreference_sweep_cursor`
}

/** The minimal Setting surface the cursor store needs — structural, so a test double satisfies it. */
export type BackReferenceCursorSettingClient = {
  setting: {
    findUnique(args: { where: { key: string } }): Promise<{ value: string } | null>
    upsert(args: {
      where: { key: string }
      create: { key: string; value: string }
      update: { value: string }
    }): Promise<unknown>
  }
}

/**
 * A cursor store backed by one Setting row, holding `{"createdAt":"…","id":"…"}`.
 *
 * NOT written through settings-store's serialize/deserialize: this is machine state, not a
 * configured value, it is not in RETENTION_KEYS or the settings UI, and it must never pick up an
 * env-var fallback. A malformed or unparseable value reads as "no cursor" — the sweep then starts
 * at the head, which is slower but never wrong.
 */
export function createBackReferenceSweepCursorStore(
  db: BackReferenceCursorSettingClient,
  connector: string,
): BackReferenceCandidateCursorStore {
  const key = backReferenceSweepCursorSettingKey(connector)
  return {
    async load() {
      const row = await db.setting.findUnique({ where: { key } })
      if (!row?.value) return null
      try {
        const parsed = JSON.parse(row.value) as { createdAt?: unknown; id?: unknown }
        if (typeof parsed.id !== 'string' || typeof parsed.createdAt !== 'string') return null
        const createdAt = new Date(parsed.createdAt)
        if (Number.isNaN(createdAt.getTime())) return null
        return { createdAt, id: parsed.id }
      } catch {
        return null
      }
    },
    async save(cursor) {
      const value = cursor === null ? '' : JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id })
      await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
    },
  }
}

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
  /**
   * "<connector>:<tenantId>" for the CURRENTLY CONNECTED tenant/realm (o3d-9kek r3 finding 1), or
   * null when that connector has no token.
   *
   * External bill ids are tenant-owned: QuickBooks realm ids are integers that repeat across
   * companies, so a row posted to realm A carries an id that means something entirely different in
   * realm B. The candidate query matches this against the row's own stored provenance, which makes
   * foreign-realm rows structurally invisible to the sweep instead of relying on a rule a future
   * edit can drop.
   *
   * NULL refuses the whole run rather than sweeping with an unknown namespace: there is no company
   * to attribute anything to, and every write would be a guess.
   */
  provenance: string | null
  /**
   * Where the last run stopped. Optional: a sweep without one still keyset-paginates WITHIN a run,
   * it just restarts at the head each time — which is the starvation described on
   * BackReferenceCandidateCursorStore, so every production binding passes one.
   */
  cursorStore?: BackReferenceCandidateCursorStore
  /** Human name used in activity-log descriptions, e.g. 'Xero'. */
  connectorLabel: string
  /** Activity action prefix, e.g. 'xero' → 'xero_backreference_repaired'. */
  activityActionPrefix: string
  /**
   * MUST report whether the entry was PERSISTED — `true` only if it reached the activity log.
   *
   * The production logActivity swallows persistence errors and resolves normally, so awaiting it
   * proves nothing (o3d-9kek r2 finding 3). That mattered here because the ambiguity warning and
   * the 24-hour deferral are stamped together: a transient activity-log failure suppressed BOTH
   * the operator's only notification AND any further repair attempt for a day. Connectors wire
   * this to logActivityPersisted, whose return value is the confirmation.
   */
  logActivity: (entry: BackReferenceSweepActivity) => Promise<boolean>
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
 * What each refusal means, in the operator's terms, and what they are being asked to do. Every
 * one of them ends in a MANUAL action: the sweep has decided it cannot attribute the id safely,
 * and no amount of re-running changes that on its own.
 */
const AMBIGUITY_EXPLANATIONS: Record<AmbiguousPurchaseOrderAttribution['reason'], (a: AmbiguousPurchaseOrderAttribution) => string> = {
  MULTIPLE_SYNC_ROWS: (a) =>
    `${a.syncRowCount} posted bill sync rows reference this PO, so which bill this external id belongs to cannot be determined. Link them manually.`,
  MULTIPLE_UNLINKED_BILLS: () =>
    'the PO has several bills with no external id, so which one this external id belongs to cannot be determined. Link them manually.',
  NO_LIVE_SYNC_ROW: () =>
    'no live posted sync row for this PO carries this external id any more — its record was deleted or cancelled while the repair was in flight, '
    + 'so there is no longer any evidence of which bill it posted. Check the accounting ledger and link the bill manually.',
  EXTERNAL_ID_LINKED_ELSEWHERE: (a) =>
    `this external id is already linked to bill ${a.linkedPurchaseInvoiceId ?? 'unknown'} on purchase order ${a.linkedPurchaseOrderId ?? 'unknown'}, `
    + 'so it cannot also belong to a bill of this one. Either that link or this sync row is wrong — resolve it manually.',
  EXTERNAL_ID_CLAIMED_CONCURRENTLY: () =>
    'another bill claimed this external id while the repair was being written, so it is already attributed and was not copied. '
    + 'Confirm the surviving link is the right one.',
}

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
  /** The ACTIVE connection's namespace. Rows issued by any other one are not candidates. */
  provenance: string
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
    // THE NAMESPACE (r3 finding 1). An exact match, so a row posted to a former QuickBooks realm —
    // or one whose issuing connection cannot be identified (NULL) — is never attributed under the
    // current one. Its integer external id means something else here, and copying it onto a bill of
    // this company is precisely the wrong-bill write the whole area exists to prevent.
    provenance: params.provenance,
    status: { in: ['SYNCED', 'FAILED'] },
    externalTransactionId: { not: null },
    type: { in: [...BACK_REFERENCE_SWEEP_TYPES] },
    backReferenceCheckedAt: null,
    // A tombstoned row (r3 finding 3) is evidence, not work: retention has cleared the payload, so
    // its follow-ups can no longer be rebuilt and there is nothing left for a repair to do.
    backReferenceEvidenceCompactedAt: null,
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
  // No live connection means no namespace to attribute within (r3 finding 1). Sweeping anyway
  // would take external ids issued by whatever company was connected before and write them onto
  // bills as if they belonged to the current one.
  const provenance = deps.provenance
  if (!provenance) {
    console.warn(`${prefix}: back-reference sweep skipped — no connected tenant/realm to attribute external ids to`)
    return result
  }
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

  /**
   * An attribution this run refuses to act on: count it, warn about it at most once per interval,
   * and defer it for that interval. Shared by the probe and by the fenced re-resolve inside the
   * apply, so a conflict that only surfaces at write time (the unique index rejecting an id
   * another bill acquired) is reported and throttled exactly like one the probe saw — instead of
   * being a bare console line counted as a generic failure (o3d-9kek r2 finding 1).
   *
   * THE WARNING AND THE DEFERRAL ARE NOT INDEPENDENT. The stamp is only written once the warning
   * is CONFIRMED PERSISTED, because the deferral's whole justification is that a human has been
   * told; stamping it after a failed write would hide the row for 24 hours and tell nobody
   * (r2 finding 3). The ordering makes the failure modes asymmetric on purpose: warning-then-stamp
   * can at worst repeat a warning if the stamp fails, which is noise, whereas stamp-then-warn can
   * lose the only notification, which is silence. That asymmetry is why a transaction around the
   * pair is not needed to make this safe.
   */
  const reportAmbiguity = async (row: BackReferenceSweepRow, attribution: AmbiguousPurchaseOrderAttribution) => {
    result.skippedAmbiguous++
    const previouslyLoggedAt = row.backReferenceAmbiguousLoggedAt
    const observedAt = now()
    // The candidate query already filtered on this, from the same cutoff. Re-asserted
    // here so "at most one warning per interval" holds on the row itself and not only
    // on a query a future edit could loosen.
    const dueToReport = previouslyLoggedAt === null || previouslyLoggedAt < ambiguityRecheckBefore
    if (!dueToReport) return

    const persisted = await deps.logActivity({
      entityType: 'SYSTEM',
      action: `${prefix}_backreference_repair_ambiguous`,
      tag: 'sync',
      level: 'WARNING',
      description: `Skipped ${connectorLabel} back-reference repair for PO ${row.referenceId}: `
        + AMBIGUITY_EXPLANATIONS[attribution.reason](attribution)
        + (previouslyLoggedAt === null ? '' : ` Still unresolved since this was last reported at ${previouslyLoggedAt.toISOString()}.`),
      metadata: {
        syncLogId: row.id,
        referenceId: row.referenceId,
        reason: attribution.reason,
        syncRowCount: attribution.syncRowCount,
        unlinkedBillCount: attribution.unlinkedBillCount,
        linkedPurchaseInvoiceId: attribution.linkedPurchaseInvoiceId ?? null,
        linkedPurchaseOrderId: attribution.linkedPurchaseOrderId ?? null,
        previouslyLoggedAt: previouslyLoggedAt?.toISOString() ?? null,
      },
    })
    if (!persisted) {
      // The warning did not reach the log. Leave the row immediately eligible: the next run
      // re-probes and tries to report again. Deferring an unreported ambiguity is the one
      // combination that helps nobody.
      console.error(`${prefix}: back-reference ambiguity warning was not persisted; leaving row eligible`, row.id)
      return
    }
    // A DEFERRAL, deliberately NOT backReferenceCheckedAt: ambiguity is not a verdict —
    // a sibling can be cancelled or post, several unlinked bills can shrink to one, and
    // the manual link this warning asks for changes the answer. Stamping it as checked
    // excluded a row that had since become repairable, which is the starvation this sweep
    // exists to prevent (Codex r9 #2). This takes the row out of the candidate set for ONE
    // interval and no longer.
    try {
      await deps.db.accountingSyncLog.update({
        where: { id: row.id },
        data: { backReferenceAmbiguousLoggedAt: observedAt },
      })
    } catch (deferralError) {
      // The row can legitimately be gone — retention, or a connector switch cancelling it —
      // between the candidate read and here. Nothing to defer, and nothing to retry: a row that
      // no longer exists cannot re-fill the head of the scan.
      console.error(`${prefix}: could not defer back-reference ambiguity`, row.id, deferralError)
    }
  }

  // RESUME where the previous run stopped (r3 finding 4). A cursor that reset to null every
  // invocation meant a persistently failing head — rows whose probe, apply, follow-up or activity
  // log write keeps failing, and which must therefore NOT be stamped — consumed the whole budget
  // on every run, so the row behind them was never reached. Resuming skips them without recording
  // anything about them, which is what makes it work for exactly the rows nothing can be recorded
  // about.
  //
  // A load failure degrades to a head-start scan rather than to no scan at all: the sweep is a
  // repair mechanism, and refusing to run because a bookmark could not be read would be worse than
  // re-examining rows it has already seen.
  let after: BackReferenceCandidateCursor | null = null
  if (deps.cursorStore) {
    try {
      after = await deps.cursorStore.load()
    } catch (cursorError) {
      console.error(`${prefix}: back-reference sweep cursor could not be read; starting from the oldest row`, cursorError)
    }
  }
  // The cursor ROTATES: when the scan runs off the end of the population it wraps to the start
  // once, so rows BEFORE the resume point (a deferral that has since expired, an ambiguity that
  // has cleared) are picked up on the next lap instead of waiting for new rows to push the cursor
  // around. At most one wrap per run, and none at all for a run that already started at the head,
  // so an exhausted population cannot spin.
  const startedAtHead = after === null
  let wrapped = startedAtHead
  while (result.scanned < limit) {
    const take = Math.min(pageSize, limit - result.scanned)
    const page = await deps.db.accountingSyncLog.findMany(
      buildBackReferenceCandidateQuery({ connector, provenance, after, ambiguityRecheckBefore, take }),
    )
    if (page.length === 0) {
      if (wrapped) break
      wrapped = true
      after = null
      continue
    }

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
          provenance,
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
              provenance,
              purchaseOrderId: row.referenceId,
              externalId: row.externalTransactionId,
            })
          } catch (attributionError) {
            console.error(`${prefix}: back-reference PO attribution failed`, row.id, attributionError)
            result.failed++
            continue
          }
          if (attribution.outcome === 'ambiguous') {
            await reportAmbiguity(row, attribution)
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
            if (applied.outcome === 'ambiguous') {
              // The fenced re-resolve refused, or the unique index refused the swap because
              // another bill had taken the id. Reported and throttled like any other refusal
              // rather than counted as a generic failure: an attribution conflict names a manual
              // action, and a bare console line names nobody (o3d-9kek r2 finding 1). Never
              // stamped as checked — the conflict can be resolved by hand.
              await reportAmbiguity(row, applied.attribution)
              continue
            }
            if (applied.outcome !== 'applied') {
              // `contended` — a concurrent writer linked the bill first, so the swap matched
              // no row and nothing was overwritten. `nothing-to-apply`/`already-linked` — the
              // population moved between the probe and the fenced re-resolve. Never stamp: the
              // next run re-resolves from fresh state and will settle it (typically as
              // already-linked).
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

    if (page.length < take) {
      if (wrapped) break
      wrapped = true
      after = null
    }
  }

  // Persist where this run stopped, so the next one starts BEHIND the rows this one could not
  // settle. Written after the loop rather than per page: a run that dies mid-scan re-examines the
  // rows it had already reached, which is wasteful but never wrong, whereas a cursor saved ahead
  // of the work would skip rows that were never actually looked at.
  if (deps.cursorStore) {
    try {
      await deps.cursorStore.save(after)
    } catch (cursorError) {
      console.error(`${prefix}: back-reference sweep cursor could not be saved; the next run restarts from the oldest row`, cursorError)
    }
  }

  return result
}
