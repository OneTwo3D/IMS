import type { AccountingLinkSource, AccountingSyncStatus, AccountingSyncType } from '@/app/generated/prisma/client'
import {
  BACK_REFERENCE_REPAIRABLE_STATUSES,
  BACK_REFERENCE_TYPES,
  applyBackReference,
  backReferenceIsMissing,
  followUpObligationClaim,
  isExternalDocumentIdConflict,
  recoverPostedBusinessDate,
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
// ONE MORE, FOUND IN ROUND 3:
//
// 4. THE CURSOR RESET. The keyset walked the population within a run but started at the head on
//    every invocation, and the budget counts rows SCANNED — including rows left eligible by a
//    failure. A persistently failing oldest `limit` rows therefore ate every run's budget and the
//    row behind them was never reached: starvation for a third time. The cursor is now persisted
//    between runs and rotates, so the next run resumes BEHIND the rows this one could not settle —
//    which is what makes it work for exactly the rows about which nothing can be recorded.
//
// AND ONE MORE, FOUND IN ROUND 4:
//
// 5. RETENTION RETIRING REPAIR WORK. Round 3 replaced retention's open-ended exemption with a
//    compacted tombstone, and then excluded tombstones from the candidate set — which made
//    RETENTION, a clock, the thing that decided a row would never be repaired. Compaction happens by
//    AGE and says nothing about repairability, so an ambiguity that cleared after the horizon was
//    never reconsidered and a back-reference that was merely failing transiently at the cutoff was
//    never retried. That is deferred-not-retired broken by a fourth route, and keeping the claimant
//    evidence did not compensate: evidence prevents a WRONG guess, it does not recover a missing
//    link. A tombstone is now a full candidate for the ID write, which needs nothing the
//    compaction removed. Only the payload-dependent FOLLOW-UPS are genuinely unrecoverable, and
//    those are discarded under an explicit terminal policy that warns before it settles the row.
//
// AND ONE MORE, FOUND IN ROUND 9:
//
// 6. A TRANSIENT FOLLOW-UP FAILURE ON A **SYNCED** ROW. "This row still owes its follow-ups" was
//    inferred from `status === 'FAILED'`. That is the Xero shape — the refusal propagates and the
//    retries exhaust — but it is NOT the crash-after-post shape this sweep primarily exists for: that
//    row is SYNCED, carries an external id, and has no back-reference because the process died
//    between the two. Once the sweep wrote the link, a TRANSIENT enqueue failure left the row
//    unstamped (correctly) with nothing at all recording the outstanding work; the next sweep found a
//    linked SYNCED row, judged it reconciled and stamped it. The payment, PDF or attachment was gone,
//    silently, and re-running changed nothing. Deferred-not-retired broken for the fifth time, and
//    the third time in this file that "this attempt failed" was allowed to mean "this row is
//    finished". The obligation is now a COLUMN (backReferenceFollowUpsPendingAt), written BEFORE the
//    repair touches anything and cleared only by a successful enqueue.
//
// DELIBERATELY NOT IN SCOPE: connector-TENANT isolation — AND THAT IS WHY THIS SWEEP IS BOUND FOR
// XERO ONLY (r6 finding 1).
//
// This module is connector-agnostic, but its candidate query is scoped by `connector` and nothing
// else. External ids are TENANT-owned, so what that scope means differs sharply by connector:
//
//   • XERO: organisation and document ids are GUIDs. An id issued by a previously connected
//     organisation cannot collide with one of the current organisation's documents — it resolves to
//     nothing, loudly. There is no cross-tenant attribution to make.
//   • QUICKBOOKS: document ids are small per-company integers, and company B routinely reissues an
//     integer company A used. Disconnecting clears the expected-realm pin, so after reconnecting to
//     company B an unresolved company-A row is still a candidate and this sweep would write company
//     A's integer onto a live document; payment polling then acts on it as current.
//
// The global unique index on purchase_invoices.accounting_invoice_id does NOT close that: it only
// stops a SECOND local row taking an id another row already holds. After a realm switch no local
// row holds the orphaned id, so the write succeeds and the wrong-document link is created rather
// than refused. (Where a local row DOES hold it, the index is what turns the collision into a
// refused repair with a loud error, which is the acceptable failure.)
//
// So there is no QuickBooks binding, on purpose — failing to repair is acceptable, repairing onto
// the wrong document is not. Namespacing the id per connection was tried and reverted: it lets both
// bills exist, which moves the problem to ~190 call sites that read a naked external id, on models
// that have no provenance column at all. o3d-gt8r carries that design and its findings; o3d-s36z is
// the realm-isolation work that a QuickBooks binding is waiting on.
//
// The sweep must keep refusing to guess: failing to repair is acceptable, repairing onto
// the wrong bill is not.
// ---------------------------------------------------------------------------

/**
 * Sync types that can carry a back-reference — DERIVED from BACK_REFERENCE_PAIRS, never restated
 * (o3d-9kek r6 finding 2).
 *
 * This used to be a hand-written `['SALES_INVOICE', 'CREDIT_NOTE', 'PURCHASE_INVOICE']` whose
 * comment claimed it matched syncTypeWritesBackReference's pairs. It did not: PURCHASE_CREDIT_NOTE
 * was missing, and the shared writer has supported it since audit-g5u2 (Xero posts ACCPAYCREDIT and
 * writes SupplierCreditNote.accountingCreditNoteId). The omission cost two things at once, because
 * retention reads the same list:
 *
 *   • a supplier credit note whose post succeeded and whose id write failed was NEVER a repair
 *     candidate — its retries exhausted to FAILED and nothing ever came back to it;
 *   • it was never retention-protected either, so the only row that knew an external credit note
 *     existed with no local link was DELETED by age rather than compacted to a tombstone.
 *
 * Nothing in the sweep needed changing for it: PURCHASE_CREDIT_NOTE/SupplierCreditNote goes down the
 * generic backReferenceIsMissing → applyBackReference path (the PO-attribution branch is scoped to
 * PURCHASE_INVOICE/PurchaseOrder), and Xero's enqueueFollowUps already routes the type to its
 * allocation follow-up. The defect was ONLY the restated list, which is why it is now derived.
 */
export const BACK_REFERENCE_SWEEP_TYPES: readonly AccountingSyncType[] = BACK_REFERENCE_TYPES

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
 *   • every QuickBooks row is unstamped forever, because no QuickBooks sweep runs — deliberately,
 *     see the tenant note below and lib/connectors/quickbooks/sync-processor.ts.
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
  // Read, not restated (o3d-9kek r8). The operator release path asks the SAME question of the SAME
  // column — "is this row's external id a durable record of a post that may still need linking?" —
  // and the two answering differently is how a class of row becomes repairable by one route and
  // invisible to the other. r6 finding 2 was that mistake with a type list.
  status: { in: [...BACK_REFERENCE_REPAIRABLE_STATUSES] },
  type: { in: [...BACK_REFERENCE_SWEEP_TYPES] },
}

/**
 * The TOMBSTONE an expired-but-unresolved row is compacted to (o3d-9kek r3 finding 3).
 *
 * WHAT IT KEEPS, and why each column is load-bearing: connector + type + referenceType +
 * referenceId + externalTransactionId + status. That is exactly the set the PurchaseOrder resolver
 * counts to decide "does more than one posted row claim this order's bill".
 * Keeping it is what stops retention converting an ambiguity into a confident wrong answer.
 *
 * WHAT IT DELIBERATELY DOES NOT KEEP:
 *   • `payload` — the document as sent: customer and supplier names, email addresses, delivery
 *     addresses, line descriptions and amounts. This is the bulk AND the personal data, and it is
 *     the reason the old exemption could not simply be left alone.
 *   • `errorMessage` — free text echoing connector responses, which routinely quote the payload.
 *
 * WHAT THE TOMBSTONE IS STILL GOOD FOR, and the r4 finding 3 correction. An earlier revision said a
 * tombstoned row "can no longer be REPAIRED… it is evidence, not work", and took it out of the
 * sweep's candidate set entirely. That was too broad, and it broke the deferred-not-retired property
 * this whole sweep exists to preserve:
 *
 *   • an AMBIGUITY that clears after the retention horizon — a competing sibling is cancelled, a
 *     human links one of several bills — would never be reconsidered, because the row it would have
 *     been reconsidered from had been excluded permanently;
 *   • a back-reference that was failing TRANSIENTLY at the cutoff would never be repaired either,
 *     for the same reason. Compaction is scheduled by AGE; it says nothing about repairability.
 *
 * Retention retiring unresolved repair work is the starvation bug wearing a third disguise, and the
 * fact that the row keeps its claimant evidence does not help: that prevents a WRONG guess, it does
 * not recover the missing link.
 *
 * So the split is by DEPENDENCY, not by row. Everything the ID write needs — externalTransactionId,
 * referenceType, referenceId — is kept, and a tombstone remains a
 * full candidate for that write. Only the FOLLOW-UPS (PDF, payment, attachment) are payload-
 * dependent and therefore genuinely unrecoverable, and they are discarded under an explicit terminal
 * policy: the sweep warns, once, naming the document, and settles the row. That obeys the governing
 * principle — failing to repair is acceptable, repairing onto the wrong bill is not — without
 * throwing away the repair that is still perfectly possible.
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
  /**
   * When retention compacted this row to an attribution-only tombstone. NULL = payload intact.
   *
   * Read, not filtered on (r4 finding 3): a tombstone is still a candidate for the id write and only
   * its payload-dependent follow-ups are lost. The sweep needs to KNOW which it is holding, because
   * `payload` on a tombstone is `{}` — indistinguishable from a genuinely empty payload — and
   * enqueueing follow-ups from it would silently enqueue nothing while reporting success.
   */
  backReferenceEvidenceCompactedAt: Date | null
  /**
   * The row's back-reference is written but its FOLLOW-UPS have not been enqueued yet. NULL = none
   * known to be outstanding (Codex r9 finding 1).
   *
   * Read for exactly one reason: "does this row still owe follow-ups?" used to be `status ===
   * 'FAILED'`, which is the Xero shape and not the crash-after-post shape. See
   * `owesFollowUps` in the loop below.
   */
  backReferenceFollowUpsPendingAt: Date | null
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
  backReferenceEvidenceCompactedAt: true,
  backReferenceFollowUpsPendingAt: true,
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
  /**
   * Tombstoned rows whose id was repaired (or was already right) but whose follow-ups could not be
   * rebuilt, because retention had compacted the payload away (r4 finding 3). Counted separately
   * from `repaired` because it is a repair WITH a permanent loss attached, and a number that only
   * ever went up in the `repaired` column would hide that entirely.
   */
  followUpsDiscarded: number
}

export type BackReferenceCandidateCursor = { createdAt: Date; id: string }

/**
 * What each refusal means, in the operator's terms, and what they are being asked to do. Every
 * one of them ends in a MANUAL action: the sweep has decided it cannot attribute the id safely,
 * and no amount of re-running changes that on its own.
 */
/**
 * What the BLOCKING bill's link provenance means for the person being asked to resolve the conflict
 * (o3d-wf86). Reported, never acted on: telling an operator which candidate to check first is a
 * different act from IMS deciding, and deciding needs the remote document, which this sweep does
 * not read.
 */
const BLOCKING_LINK_PROVENANCE: Record<AccountingLinkSource | 'UNRECORDED', string> = {
  BILL_KEYED_SYNC: 'That link was written by a sync row that named that bill directly, so it is the authoritative one and THIS row\'s '
    + 'reference is the more likely mistake.',
  PO_KEYED_REPAIR: 'That link was DEDUCED by an earlier repair from the purchase order\'s population, not reported by the ledger, so it '
    + 'is a candidate for being the wrong one — check the remote bill against both before choosing.',
  MANUAL: 'That link was set by an operator who confirmed it by hand, so treat it as correct unless you know why that decision changed.',
  UNRECORDED: 'How that link was written was never recorded (it predates link provenance), so neither claim is proven — check the remote '
    + 'bill against both.',
}

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
    + 'so it cannot also belong to a bill of this one. Either that link or this sync row is wrong — resolve it manually. '
    // o3d-wf86: SAYS WHICH OF THE TWO IS UNPROVEN, which is the whole point of recording provenance.
    // The refusal is unchanged — IMS still cannot adjudicate this without reading the remote bill —
    // but "resolve it manually" with no indication of where to start is a instruction nobody can
    // act on, and the blocking link having been a GUESS is the single most useful thing to know.
    + BLOCKING_LINK_PROVENANCE[a.linkedAccountingInvoiceIdSource ?? 'UNRECORDED'],
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
 *
 * WHAT THE ROW MUST BE, IS NOW A DISJUNCTION (o3d-p5j3). It used to be one thing — "a posted
 * back-reference row" — expressed as `type IN (back-reference types) AND externalTransactionId IS
 * NOT NULL`. r10 then started CLAIMING `backReferenceFollowUpsPendingAt` on the SYNCED write of
 * EVERY sync type, in both connectors, while this query still admitted only that one shape. The
 * marker was therefore written truthfully onto rows this sweep could never select, and stranded:
 *
 *   • INVOICE_PDF is the one that loses real work. Its own follow-ups are NESTED — a successful
 *     PDF enqueues INVOICE_EMAIL and WC_INVOICE_NOTE — and the row fails BOTH old predicates at
 *     once: INVOICE_PDF is not a back-reference type, and the PDF call returns no external id, so
 *     the row is SYNCED with `externalTransactionId` NULL. A crash between the SYNCED commit and
 *     the enqueue left a row that says "follow-ups owed" for ever, and the customer's invoice
 *     email and WooCommerce note simply never happened.
 *   • INVOICE_EMAIL, WC_INVOICE_NOTE, INVOICE_PAYMENT, BILL_PAYMENT, BILL_ATTACHMENT and the
 *     journal types owe NOTHING to enqueueFollowUps, so their marker is a FALSE obligation. It is
 *     harmless in the money direction but it is still a row asserting outstanding work, and while
 *     nothing could select it, "which rows still owe follow-ups?" had no truthful answer at all.
 *
 * So the marker is now a candidate reason IN ITS OWN RIGHT. A row is examined when it is
 * back-reference evidence OR when it says it owes follow-ups. The false markers drain (the
 * enqueue is a no-op for their type and the row is stamped), and the real one — the PDF's nested
 * pair — is finally rebuilt. Dropping the marker for PDF work was the alternative, and it is
 * explicitly rejected: a row that owes work and says so beats one that owes work silently.
 *
 * The status predicate is deliberately NOT widened with it. PENDING/PROCESSING mean a sync is in
 * flight that will run the follow-ups itself; only a settled row's obligation is this sweep's.
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
    // The same one definition the evidence predicate above reads (o3d-9kek r8).
    status: { in: [...BACK_REFERENCE_REPAIRABLE_STATUSES] },
    // Either reason is sufficient on its own (o3d-p5j3). Kept as two named clauses rather than a
    // flattened condition because they are different questions about different populations, and a
    // future edit that collapses them re-strands the marker.
    OR: [
      { type: { in: [...BACK_REFERENCE_SWEEP_TYPES] }, externalTransactionId: { not: null } },
      { backReferenceFollowUpsPendingAt: { not: null } },
    ],
    backReferenceCheckedAt: null,
    // NO PREDICATE ON backReferenceEvidenceCompactedAt, and that absence is deliberate (r4 finding
    // 3). Filtering tombstones out — which an earlier revision did — let RETENTION permanently
    // retire unresolved repair work: an ambiguity that cleared after the retention horizon was never
    // reconsidered, and a transiently failing back-reference was never repaired, because compaction
    // is scheduled by age and says nothing about whether the row is repairable. A tombstone still
    // carries every column the id write reads, so it stays a candidate for that write;
    // only its payload-dependent follow-ups are gone, and the loop handles that explicitly.
    // Nested under AND because the top-level OR slot is taken by the candidate-reason disjunction
    // above, and the keyset clause below needs a slot of its own too.
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

  const result: BackReferenceRepairResult = { scanned: 0, checked: 0, repaired: 0, failed: 0, skippedAmbiguous: 0, followUpsDiscarded: 0 }
  // One cutoff for the whole run, so every page of the scan agrees on which deferred rows
  // are due — a per-page `new Date()` would let a row fall on both sides of the boundary.
  const ambiguityRecheckBefore = new Date(now().getTime() - BACK_REFERENCE_AMBIGUITY_RECHECK_INTERVAL_MS)

  /**
   * Record a verdict: this row needs nothing further, so it leaves the candidate set.
   * NEVER called for a transient failure, and never for an AMBIGUOUS PO row — both can
   * become repairable, and a row excluded before that happens is starved for good.
   *
   * Clears backReferenceFollowUpsPendingAt in the same write (Codex r9 finding 1). The obligation
   * and the verdict are opposites — a row cannot both be settled and still owe follow-ups — so
   * leaving the marker behind would make the two columns contradict each other on every settled row,
   * and any future reader of "which rows still owe follow-ups" would have to know to also check
   * whether the row had been stamped. One write, one consistent state.
   */
  const markChecked = async (id: string, extra?: Record<string, unknown>) => {
    await deps.db.accountingSyncLog.update({
      where: { id },
      data: { backReferenceCheckedAt: now(), backReferenceFollowUpsPendingAt: null, ...extra },
    })
  }

  /**
   * DECLARE THE FOLLOW-UPS OWED, BEFORE ANYTHING IS WRITTEN (Codex r9 finding 1).
   *
   * The obligation is recorded as an INTENT, not as a report of a failure. Writing it only in the
   * enqueue's catch block would leave the identical hole one layer down: the marker write is itself a
   * database call that can fail transiently, and if it does, the row is once again linked with
   * nothing recording that its follow-ups never ran. Writing it first makes the ordering safe in the
   * only direction that matters — a row can never reach "linked" without a durable record that
   * follow-ups are outstanding, and the worst case is a marker on a row whose follow-ups then
   * succeed, which costs one extra idempotent re-enqueue on a later sweep.
   *
   * Returns false if the marker could not be persisted, and the caller then does NOTHING ELSE to the
   * row: nothing has been written yet, `missing` is still true, and the next sweep retries the whole
   * repair from scratch.
   */
  const claimFollowUpObligation = async (row: BackReferenceSweepRow): Promise<boolean> => {
    if (row.backReferenceFollowUpsPendingAt !== null) return true
    try {
      // The SAME fragment the connectors merge into their SYNCED write (r10 finding 1). They can
      // claim it for free because they have a transaction to ride; the sweep has none, so it pays
      // for a write of its own — but the value written is one definition, not two.
      await deps.db.accountingSyncLog.update({
        where: { id: row.id },
        data: followUpObligationClaim(now()),
      })
      return true
    } catch (pendingError) {
      console.error(`${prefix}: could not record that follow-ups are owed; leaving the repair for the next sweep`, row.id, pendingError)
      return false
    }
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
  const warnAndDefer = async (
    row: BackReferenceSweepRow,
    build: (previouslyLoggedAt: Date | null) => { action: string; description: string; metadata: Record<string, unknown> },
  ) => {
    const previouslyLoggedAt = row.backReferenceAmbiguousLoggedAt
    const observedAt = now()
    // The candidate query already filtered on this, from the same cutoff. Re-asserted
    // here so "at most one warning per interval" holds on the row itself and not only
    // on a query a future edit could loosen.
    const dueToReport = previouslyLoggedAt === null || previouslyLoggedAt < ambiguityRecheckBefore
    if (!dueToReport) return

    const entry = build(previouslyLoggedAt)
    const persisted = await deps.logActivity({
      entityType: 'SYSTEM',
      action: entry.action,
      tag: 'sync',
      level: 'WARNING',
      description: entry.description
        + (previouslyLoggedAt === null ? '' : ` Still unresolved since this was last reported at ${previouslyLoggedAt.toISOString()}.`),
      metadata: { ...entry.metadata, previouslyLoggedAt: previouslyLoggedAt?.toISOString() ?? null },
    })
    if (!persisted) {
      // The warning did not reach the log. Leave the row immediately eligible: the next run
      // re-probes and tries to report again. Deferring an unreported refusal is the one
      // combination that helps nobody.
      console.error(`${prefix}: back-reference refusal warning was not persisted; leaving row eligible`, row.id)
      return
    }
    // A DEFERRAL, deliberately NOT backReferenceCheckedAt: neither an ambiguity nor an id conflict
    // is a verdict — a sibling can be cancelled or post, several unlinked bills can shrink to one,
    // and the manual link these warnings ask for changes the answer. Stamping it as checked
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
      console.error(`${prefix}: could not defer back-reference refusal`, row.id, deferralError)
    }
  }

  const reportAmbiguity = async (row: BackReferenceSweepRow, attribution: AmbiguousPurchaseOrderAttribution) => {
    result.skippedAmbiguous++
    await warnAndDefer(row, () => ({
      action: `${prefix}_backreference_repair_ambiguous`,
      description: `Skipped ${connectorLabel} back-reference repair for PO ${row.referenceId}: `
        + AMBIGUITY_EXPLANATIONS[attribution.reason](attribution),
      metadata: {
        syncLogId: row.id,
        referenceId: row.referenceId,
        reason: attribution.reason,
        syncRowCount: attribution.syncRowCount,
        unlinkedBillCount: attribution.unlinkedBillCount,
        linkedPurchaseInvoiceId: attribution.linkedPurchaseInvoiceId ?? null,
        linkedPurchaseOrderId: attribution.linkedPurchaseOrderId ?? null,
        // NULL means "never recorded", which is a different claim from "unknown to this report" —
        // it is the answer for every bill linked before o3d-wf86 and it is deliberately not
        // backfilled into a confident value.
        linkedAccountingInvoiceIdSource: attribution.linkedAccountingInvoiceIdSource ?? null,
      },
    }))
  }

  /**
   * The unique index REFUSED the id write (o3d-9kek r6 finding 3).
   *
   * The sales-side columns are globally unique now too, so a SalesOrder / SalesOrderRefund /
   * SupplierCreditNote write can be rejected the way a bill write already could — and unlike the
   * PO-keyed path, which classifies its own P2002 and returns `ambiguous`, these arrive here as a
   * thrown error. Left in the generic catch they were a `console.error` and a `failed++`: a
   * permanent, human-only-fixable condition reported to nobody, re-attempted every five minutes
   * forever. That is exactly the defect r2 finding 1 fixed for the PO path, so it gets the same
   * treatment — warn once per interval, then defer.
   *
   * DEFERRED, not stamped: the conflict is resolvable by hand (unlink the wrong record), and a row
   * excluded for good would never be re-examined afterwards. Still counted in `failed`, because
   * nothing was repaired and the number must not quietly improve.
   */
  const reportExternalIdConflict = async (row: BackReferenceSweepRow, error: unknown) => {
    await warnAndDefer(row, () => ({
      action: `${prefix}_backreference_id_conflict`,
      description: `Refused the ${connectorLabel} back-reference repair for ${row.referenceType} ${row.referenceId}: `
        + `external id ${row.externalTransactionId} is already held by another local record, so it cannot also belong to this one. `
        + 'Nothing was overwritten. Resolve it by hand — this will keep being refused until you do. '
        // NAMES THE ROUTE (r7 finding 1). "Resolve it by hand" is not, on its own, an instruction
        // anyone can follow: the same unique index refuses a manual link for exactly the reason it
        // refused this one, so the holder's claim has to come off first. Releasing a LIVE link is
        // worse than the refusal, which is why the command requires the holder to be named.
        + 'Once you have identified the record carrying that id and confirmed it is stale, release it with '
        + `\`tsx scripts/release-accounting-external-id-claim.ts --sync-log ${row.id} --holder <id> --apply\`. `
        + `Underlying error: ${String(error)}`,
      metadata: {
        syncLogId: row.id,
        type: row.type,
        referenceType: row.referenceType,
        referenceId: row.referenceId,
        externalId: row.externalTransactionId,
      },
    }))
  }

  /**
   * THE TERMINAL POLICY for a tombstone's follow-ups (r4 finding 3).
   *
   * Retention compacts an expired-but-unresolved row to attribution only, which keeps everything the
   * id write needs and drops the payload the FOLLOW-UPS are built from. The id is still
   * repaired — that is the correction r4 forced, and it is why a tombstone is still a candidate —
   * but the PDF, payment or attachment that never ran cannot be reconstructed from `{}` and never
   * will be. That is a real loss, and it is announced rather than absorbed: an operator can re-drive
   * a payment by hand if they know one is missing, and cannot if they do not.
   *
   * Returns whether the warning was PERSISTED, and the caller settles the row only when it was. Same
   * asymmetry as the ambiguity warning: repeating a warning is noise, losing it is silence — and
   * unlike an ambiguity, this discard cannot be undone by a later run, so stamping past a failed
   * write would destroy the work and the notice in one step.
   */
  const reportDiscardedFollowUps = async (
    row: BackReferenceSweepRow,
    phase: 'repaired' | 'already-applied',
  ): Promise<boolean> => {
    result.followUpsDiscarded++
    const preamble = phase === 'repaired'
      ? `Re-applied the ${connectorLabel} back-reference for ${row.referenceType} ${row.referenceId}, but`
      : `The ${connectorLabel} back-reference for ${row.referenceType} ${row.referenceId} is already applied, but`
    const persisted = await deps.logActivity({
      entityType: 'SYSTEM',
      action: `${prefix}_backreference_followups_discarded`,
      tag: 'sync',
      level: 'WARNING',
      description: `${preamble} its outstanding follow-ups (invoice PDF, payment registration or bill attachment) can no longer be `
        + 'enqueued: this sync row outlived the retention period unresolved, so its payload was compacted away. The document is linked '
        + `to external id ${row.externalTransactionId}; check whether its PDF, payment or attachment is missing and re-drive it manually.`,
      metadata: {
        syncLogId: row.id,
        type: row.type,
        referenceType: row.referenceType,
        referenceId: row.referenceId,
        externalId: row.externalTransactionId,
        compactedAt: row.backReferenceEvidenceCompactedAt?.toISOString() ?? null,
        phase,
      },
    })
    if (!persisted) {
      console.error(`${prefix}: back-reference follow-up discard warning was not persisted; leaving row eligible`, row.id)
    }
    return persisted
  }

  /**
   * MAY THIS REPAIR BE SETTLED, GIVEN WHAT IT COULD RECOVER ABOUT THE INVOICE DATE? (o3d-r5pj.)
   *
   * Only the SALES_INVOICE / SalesOrder pair writes `invoicedAt` at all, so every other pair
   * settles unconditionally. For that one, a recovered business date means the repair reproduced
   * the original write and there is nothing to report; a missing one means the sale now carries an
   * accounting invoice id and NO invoice date.
   *
   * That is deliberately not treated as an acceptable end state. The old behaviour — `new Date()`
   * — put the sale in the WRONG period; writing nothing puts it in NO period. Both are wrong, and
   * the only thing that makes the second acceptable is that it is ANNOUNCED. So this follows the
   * same terminal policy the discarded follow-ups do, for the same reason: warn naming the
   * document, and settle only once the warning is CONFIRMED PERSISTED. Stamping past a failed
   * activity write would freeze a sale out of every VAT return with nothing anywhere saying so, and
   * a stamped row is never looked at again.
   *
   * It settles rather than deferring for ever because the remedy is not something this sweep can
   * observe: the operator sets the invoice date from the document in the ledger, on the ORDER, and
   * nothing about the sync row changes when they do. Re-reporting daily for ever would be noise
   * that never clears itself, which is how a warning stops being read.
   */
  const businessDateSettled = async (row: BackReferenceSweepRow, businessDate: Date | null): Promise<boolean> => {
    if (row.type !== 'SALES_INVOICE' || row.referenceType !== 'SalesOrder') return true
    if (businessDate !== null) return true
    const persisted = await deps.logActivity({
      entityType: 'SYSTEM',
      action: `${prefix}_backreference_invoice_date_unrecoverable`,
      tag: 'sync',
      level: 'WARNING',
      description: `Linked ${connectorLabel} invoice ${row.externalTransactionId} to sales order ${row.referenceId}, but this sync row `
        + 'no longer records the date the invoice was posted with, so NO invoice date was written. A repair must not invent one: '
        + 'stamping the time the repair ran would move the sale into whichever VAT period this sweep happened to run in. Until the '
        + 'invoice date is set from the document in the ledger, this sale is in NO reporting period.',
      metadata: {
        syncLogId: row.id,
        type: row.type,
        referenceType: row.referenceType,
        referenceId: row.referenceId,
        externalId: row.externalTransactionId,
        compactedAt: row.backReferenceEvidenceCompactedAt?.toISOString() ?? null,
      },
    })
    if (!persisted) {
      console.error(`${prefix}: unrecoverable invoice-date warning was not persisted; leaving row eligible`, row.id)
    }
    return persisted
  }

  /**
   * DISCHARGE A FOLLOW-UP OBLIGATION ON A ROW WITH NO BACK-REFERENCE OF ITS OWN (o3d-p5j3).
   *
   * There is no id to repair here — the row's type writes no back-reference, or the call returned
   * no external id — so the ONLY outstanding work is the enqueue itself. That is the whole point:
   * `backReferenceFollowUpsPendingAt` was being claimed on every connector SYNCED write while this
   * sweep could select only back-reference evidence, so the obligation was recorded and then never
   * consumed. INVOICE_PDF is the row where that cost real work: its follow-ups are NESTED
   * (INVOICE_EMAIL and WC_INVOICE_NOTE), and it carries no external id, so it could never be a
   * candidate under either half of the old predicate.
   *
   * Returns whether the row may now be STAMPED. Deliberately never touches `status`: unlike the
   * repair path there is nothing here that turns a FAILED row into a successful one, and flipping
   * a genuinely failed INVOICE_EMAIL to SYNCED because its marker was discharged would retire a
   * failure nobody fixed.
   *
   * For most types the enqueue is a no-op — the connector's own dispatch has no branch for them —
   * and that is the correct outcome rather than a special case: the marker was a FALSE obligation,
   * calling the one function that decides what a type owes is how we find that out truthfully, and
   * the row is then stamped and drains out of the column for good.
   */
  const settleOutstandingFollowUpsOnly = async (row: BackReferenceSweepRow): Promise<boolean> => {
    if (row.backReferenceFollowUpsPendingAt === null) return true
    result.checked++
    // A compacted payload cannot rebuild anything, and enqueueing from `{}` would report success
    // while doing nothing — the silent version of the loss. Same terminal policy as the linked
    // case: warn, and settle only if the warning landed.
    if (row.backReferenceEvidenceCompactedAt !== null) return reportDiscardedFollowUps(row, 'already-applied')
    try {
      await deps.enqueueFollowUps(
        row.id,
        row.type,
        row.referenceType,
        row.referenceId,
        (row.payload ?? {}) as Record<string, unknown>,
        { externalId: row.externalTransactionId ?? undefined },
      )
    } catch (followUpError) {
      result.failed++
      console.error(`${prefix}: outstanding follow-up enqueue failed`, row.id, followUpError)
      await deps.logActivity({
        entityType: 'SYSTEM',
        action: `${prefix}_backreference_followup_deferred`,
        tag: 'sync',
        level: 'WARNING',
        description: `Could not enqueue the outstanding ${connectorLabel} follow-ups recorded against ${row.type} for `
          + `${row.referenceType} ${row.referenceId}: ${String(followUpError)}. The row is left unsettled and still marked as `
          + 'owing them, so the next sweep retries them.',
        metadata: { syncLogId: row.id, type: row.type, referenceType: row.referenceType, referenceId: row.referenceId },
      })
      return false
    }
    await deps.logActivity({
      entityType: 'SYSTEM',
      action: `${prefix}_backreference_followups_recovered`,
      tag: 'sync',
      level: 'INFO',
      description: `Enqueued the outstanding ${connectorLabel} follow-ups recorded against ${row.type} for `
        + `${row.referenceType} ${row.referenceId}; this row carries no back-reference of its own.`,
      metadata: { syncLogId: row.id, type: row.type, referenceType: row.referenceType, referenceId: row.referenceId },
    })
    return true
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
      buildBackReferenceCandidateQuery({ connector, after, ambiguityRecheckBefore, take }),
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
          //
          // BUT IT CAN STILL OWE FOLLOW-UPS (o3d-p5j3), and stamping it here would clear the
          // marker in the same write — destroying the obligation instead of discharging it, and
          // doing so on exactly the row the widened candidate query was opened to reach. An
          // INVOICE_PDF row is the case that costs real work: no external id, not a back-reference
          // type, and a nested INVOICE_EMAIL + WC_INVOICE_NOTE pair that only the enqueue rebuilds.
          if (!(await settleOutstandingFollowUpsOnly(row))) continue
          await markChecked(row.id)
          continue
        }

        const payload = (row.payload ?? {}) as Record<string, unknown>
        const invoiceNumber = typeof payload.invoiceNumber === 'string' ? payload.invoiceNumber : undefined
        // THE POSTED DOCUMENT'S OWN BUSINESS DATE, recovered from the request that was sent
        // (o3d-r5pj). Passed EXPLICITLY on every repair — as a Date when it is known and as `null`
        // when it is not — so the repair can never fall through to applyBackReference's live-path
        // default of `new Date()` by simply omitting the field. That default is correct for a post
        // happening now and wrong for a reconstruction of one that happened months ago: VAT and
        // currency reporting select on `invoicedAt`, so repair time moves the sale into a period it
        // was never invoiced in.
        const businessDate = recoverPostedBusinessDate(payload)
        const params = {
          connector,
          type: row.type,
          referenceType: row.referenceType,
          referenceId: row.referenceId,
          externalId: row.externalTransactionId,
          invoiceNumber,
          invoicedAt: businessDate,
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

        // A TOMBSTONE (r4 finding 3): retention cleared the payload, so the ID write below is still
        // exactly as possible as it ever was, and the FOLLOW-UPS are gone for good. Everything from
        // here on branches on that distinction rather than on the row as a whole, which is the
        // difference between discarding unrecoverable work and retiring recoverable work.
        const evidenceOnly = row.backReferenceEvidenceCompactedAt !== null

        /**
         * DOES THIS ROW STILL OWE ITS FOLLOW-UPS? (Codex r9 finding 1.)
         *
         * Two markers, because there are two shapes and only one of them used to be recognised:
         *
         *   • `status === 'FAILED'` — the XERO shape. The back-reference refusal propagates,
         *     markSyncLogForFollowUpRetry retries, and the row exhausts to FAILED still carrying the
         *     external id. This is also what the sweep itself leaves behind when it repairs a FAILED
         *     row whose follow-ups then fail to enqueue. It covers rows written before this branch,
         *     which have no pending marker at all.
         *   • `backReferenceFollowUpsPendingAt` — the CRASH-AFTER-POST shape, and the reason the
         *     column exists. That row is SYNCED with an external id and no back-reference, so nothing
         *     about its status ever says "follow-ups outstanding". The sweep repaired the link and, if
         *     the enqueue then failed TRANSIENTLY, left the row unstamped so it would be retried — but
         *     the next pass saw a linked SYNCED row, judged it reconciled and stamped it. The
         *     follow-ups were retired by a failure that was never a verdict.
         *
         * A tombstone is excluded from the follow-ups-only PASS because its follow-ups cannot be
         * rebuilt at all: running it on `{}` would enqueue nothing and then report the row
         * reconciled, which is the silent version of the same loss. It is NOT excluded from the
         * question — a tombstone that owes follow-ups still gets the terminal warning below.
         */
        const owesFollowUps = row.status === 'FAILED' || row.backReferenceFollowUpsPendingAt !== null
        const followUpsOnly = !missing && owesFollowUps && !evidenceOnly
        if (!missing && !followUpsOnly) {
          if (evidenceOnly && owesFollowUps) {
            // Linked, but its follow-ups never ran — and the payload that would let them run is
            // gone. This is the terminal case, and it is settled ONLY once someone has been told,
            // for the same reason an ambiguity is: the discard is irreversible, so stamping it after
            // a failed warning would destroy the work and the notice together.
            //
            // Reached by a SYNCED row too, via the pending marker (Codex r9 finding 1). Before that
            // marker existed the condition was `status === 'FAILED'`, so a SYNCED row whose
            // follow-ups were outstanding when retention compacted it was stamped in silence: the
            // one case where the loss is BOTH permanent and unannounced.
            if (!(await reportDiscardedFollowUps(row, 'already-applied'))) continue
          }
          // Linked, nothing outstanding: reconciled. Stamped, so it never occupies a slot again.
          await markChecked(row.id)
          continue
        }
        // Counted as CHECKED either way, but a follow-ups-only pass is not a repair: nothing was
        // re-applied, so it must not inflate `repaired` (Codex review, r8).
        result.checked++

        // THE OBLIGATION IS RECORDED BEFORE THE REPAIR IS ATTEMPTED (Codex r9 finding 1), and only
        // when the follow-ups are actually rebuildable — a tombstone's are not, and marking a
        // discard as "pending" would promise a retry that can never happen. If it cannot be
        // persisted, nothing else is done to the row: the link is still missing, so the next sweep
        // repeats this pass from the top rather than linking a document whose outstanding work
        // nothing records.
        if (!evidenceOnly && !(await claimFollowUpObligation(row))) {
          result.failed++
          continue
        }

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
          //
          // Unless this is a tombstone, in which case they CANNOT be rebuilt (r4 finding 3): the
          // payload they are constructed from was cleared at the retention cutoff. Calling
          // enqueueFollowUps with `{}` would not fail — it would enqueue nothing and return
          // normally, and the row would then be stamped reconciled with the payment or PDF silently
          // missing. The terminal policy is stated instead of simulated: warn, naming what was
          // discarded, and settle only if the warning landed.
          let followUpsEnqueued = true
          if (evidenceOnly) {
            if (!(await reportDiscardedFollowUps(row, 'repaired'))) followUpsEnqueued = false
          } else {
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
                  + `enqueue its follow-ups: ${String(followUpError)}. The row is left unsettled and marked as still owing them, `
                  + 'so the next sweep retries them.',
                metadata: { syncLogId: row.id, referenceType: row.referenceType, referenceId: row.referenceId },
              })
            }
          }
          // A row whose back-reference is now applied is fully reconciled — but ONLY if its
          // follow-ups were actually enqueued. Stamping it regardless retired the one source that
          // would retry them, so a transient enqueue failure lost the payment or PDF permanently
          // (Codex review, r6). Leaving it UNSTAMPED is what makes the next sweep look at it again,
          // and the pending marker written before the repair is what tells that sweep the follow-ups
          // are still owed — a linked SYNCED row says nothing about them on its own, which is how
          // exactly this failure survived into r9 finding 1 for the non-FAILED half of the
          // population. `markChecked` clears the marker on the way out.
          //
          // A tombstone is stamped CHECKED but never flipped to SYNCED: its id write succeeded, so
          // there is nothing left for any future sweep to do, but its follow-ups were discarded
          // rather than done and calling that SYNCED would erase the only trace of it (r4 finding 3).
          //
          // AND ONLY IF THE SALE ENDED UP IN A REPORTING PERIOD (o3d-r5pj). The repair now refuses
          // to invent `invoicedAt`, so a row whose posted date could not be recovered leaves the
          // sale with no invoice date at all — out of EVERY VAT and currency period rather than in
          // the wrong one. Stamping that is the worse half of the original defect: the row would
          // become non-repairable at the same moment it became invisible to reporting, and nothing
          // downstream ever asks why an order has an accounting invoice id and no date. So it is
          // warned about and DEFERRED — never a verdict, because a human setting the date makes the
          // row settle by itself on the next lap.
          if (followUpsEnqueued && await businessDateSettled(row, businessDate)) {
            await markChecked(row.id, row.status === 'FAILED' && !evidenceOnly ? { status: 'SYNCED', errorMessage: null } : undefined)
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
          // An external id already attributed to another local record is NOT a transient failure —
          // no number of retries clears it, only a human does — so it is reported and throttled
          // rather than left as a console line the next run repeats (r6 finding 3). Everything else
          // stays exactly as it was: transient failures are silent-but-counted on purpose, because
          // they are expected to succeed on their own.
          if (isExternalDocumentIdConflict(repairError)) await reportExternalIdConflict(row, repairError)
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
