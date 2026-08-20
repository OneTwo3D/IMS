'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { freshAuthFailureResult, requireFreshPermission } from '@/lib/auth/server'
import { logActivityInTransaction } from '@/lib/activity-log'
import {
  mirroredAccountingEventIdempotencyKeys,
  updateMirroredAccountingEventStatus,
  type MirroredEventUpdateOutcome,
} from '@/lib/domain/accounting/accounting-event-mirror'
import {
  applyFencedAttemptDecision,
  type AttemptFenceRefusalReason,
} from '@/lib/domain/accounting/sync-log-attempt'
import {
  MIRROR_OWNING_SYNC_STATUSES,
  buildSettlementData,
  describeMirrorOwnershipSkip,
  describeSettlementUniqueConflict,
  describeUnsettleableStatus,
  findMirrorOwnershipConflict,
  isSettleableAccountingSyncStatus,
  refuseSettlement,
  settlementMirrorExternalId,
  settlementMirrorGuard,
  settlementMirrorStatus,
  settlementNote,
  type MirrorOwnershipConflict,
  type SettlementAssertion,
  type SettlementRefusalCode,
  type SettlementUniqueConflictKind,
} from '@/lib/domain/accounting/sync-row-settlement'
import type { FreshAuthFailureResult } from '@/lib/auth/session-gates'

// ---------------------------------------------------------------------------
// o3d-nf9i + o3d-osl8 item 2 — ONE audited per-row settlement action for AccountingSyncLog rows
// the system cannot resolve for itself.
//
// WHAT AN OPERATOR CAN NOW DO, AND EXACTLY WHAT IT ASSERTS.
//
//   "This DID post, here is the document id"  -> the row becomes SYNCED and records that id.
//   "This did NOT post"                       -> the row becomes CANCELLED and records no id.
//
// Both are assertions about the ACCOUNTING SYSTEM, made by a named human, stored with their user id
// and the time. Neither is an inference: this action never reads errorMessage, age or retryCount to
// decide anything, because none of them carries provenance (o3d-h2wx). Where the fact cannot be
// computed, the action records the operator's statement of it — and says so in the audit — rather
// than asserting it on their behalf.
//
// WHAT IT IS FENCED ON, AND WHY THAT IS THE WHOLE STORY.
//
// The two previous attempts (branch o3d-nf9i-settlement-action, two Codex no-ships) both died on the
// same defect: a CAS on (id, status) cannot identify an ATTEMPT, because every path returns a row to
// a status it already held. `retryFailed*` drives FAILED -> PENDING -> FAILED; the stale-claim
// reclaim drives PROCESSING -> PROCESSING. An operator's conclusion about attempt N therefore lands
// on attempt N+1, cancelling a still-ambiguous attempt and removing the order's delete protection.
//
// o3d-e2mz supplies the missing identity, and this action is its operator-facing caller.
// `applyFencedAttemptDecision` (lib/domain/accounting/sync-log-attempt.ts) compare-and-swaps on
// `attemptRevision` AND status, bumps the revision as it lands, and owns the entire refusal
// vocabulary for the attempt dimension: ROW_MISSING / UNFENCED_ATTEMPT / ATTEMPT_MOVED /
// STATUS_MOVED. Nothing here re-derives it.
//
// THE DEPENDENCY IS REAL AND UNMERGED. The fence's other half — the processors bumping the revision
// on every claim and CASing their writeback on it — lives on branch o3d-e2mz-attempt-revision. Until
// that lands, every AccountingSyncLog row is at revision 0, and revision 0 is `UNFENCED_ATTEMPT`:
// this action refuses all of them. That is the correct behaviour, not a defect. It also means the
// rows stranded RIGHT NOW cannot be settled until o3d-e2mz merges, which is exactly what the fence's
// author documented.
//
// QUICKBOOKS ROWS ARE REFUSED PERMANENTLY, for the same reason and by the same mechanism: that
// processor stamps no attempt revision, so its rows stay at 0. Out of scope by owner instruction,
// and not a regression — a QuickBooks row cannot be settled today either.
//
// The decision content lives in lib/domain/accounting/sync-row-settlement.ts as pure functions; this
// file is the guard, the transaction, the audit and the I/O.
//
// WHY A NEW FILE and not app/actions/accounting-sync.ts:
//  - tests/accounting/orphan-cancel-fence.test.ts and its siblings read that file's `updateMany`
//    block and assert no `status: 'PROCESSING'` literal appears in it (the o3d-sref guarantee that
//    the orphan sweep never retires an unprovable claim). A second status-driven write in that file
//    would sit inside the grepped region and is far too easy to break that guard with.
//  - that file is blanket-allowlisted in tests/security/server-action-guard-coverage.test.ts as a
//    "connector facade". This is not a facade; it carries its own guard and should be checked like
//    any other action, which a new file gets for free.
// ---------------------------------------------------------------------------

/**
 * `code` is present only on failures a caller might want to distinguish:
 *   - the attempt fence's own reasons, so the client can tell "reload and look again"
 *     (ATTEMPT_MOVED / STATUS_MOVED) from "this row can never be settled" (UNFENCED_ATTEMPT);
 *   - the two unique-index collisions, which have different remedies;
 *   - the domain refusals, so a test can assert on the specific reason rather than bare failure.
 */
export type SettlementFailureCode =
  | AttemptFenceRefusalReason
  | SettlementUniqueConflictKind
  | SettlementRefusalCode
  | 'unrecognised_outcome'

export type SettleAccountingSyncRowResult =
  | {
    success: true
    /** What the row is now. */
    settledStatus: 'SYNCED' | 'CANCELLED'
    /** The attempt revision the decision landed as — the row has MOVED ON from what was shown. */
    attemptRevision: number
    /** What actually happened to the shared mirrored accounting event. Never assumed. */
    mirror: MirrorAuditOutcome
  }
  | { success: false; error: string; code: SettlementFailureCode }
  | FreshAuthFailureResult

/**
 * What the settlement did to the mirrored AccountingEvent — recorded, never assumed.
 *
 * ROUND 2, FINDING 4: the previous attempt wrote `mirrorUpdate: 'applied'` into its audit metadata
 * BEFORE calling the updater, and the updater returned silently when neither the primary nor the
 * legacy key matched an event. A missing mirror is a SUPPORTED state (the queue paths swallow mirror
 * failures and keep the sync row), so settlement could commit an audit asserting a mirror update
 * that never happened. The updater now REPORTS, it is called before the audit is built, and this is
 * what gets written down.
 */
export type MirrorAuditOutcome =
  /** This sync type is not mirrored at all — there is no event to touch. */
  | 'not_mirrored'
  /** Written. */
  | 'updated'
  /** No event matched either idempotency key. */
  | 'not_found'
  /** The event's own guard declined: it is already POSTED, or already names a document. */
  | 'refused'
  /** Another sync row owns the shared event, so it was deliberately left alone. */
  | 'skipped_owned_by_another_row'

/**
 * The operator's assertion, plus the exact view they were looking at when they made it.
 *
 * `observedStatus` and `observedAttemptRevision` are the FENCE. They are passed in rather than
 * re-read at write time on purpose: the point is to detect that the row moved between the operator
 * forming a judgement and this write landing, and a value the server re-reads for itself cannot
 * detect that.
 */
export type SettleAccountingSyncRowInput = {
  observedStatus: string
  observedAttemptRevision: number
} & (
  | { outcome: 'POSTED'; externalTransactionId: string }
  | { outcome: 'NOT_POSTED'; reason?: string }
)

/** Server actions take untrusted arguments; narrow to the domain union or reject. */
function normalizeAssertion(input: SettleAccountingSyncRowInput): SettlementAssertion | null {
  if (input.outcome === 'POSTED') {
    return typeof input.externalTransactionId === 'string'
      ? { outcome: 'POSTED', externalTransactionId: input.externalTransactionId }
      : null
  }
  if (input.outcome === 'NOT_POSTED') {
    return typeof input.reason === 'string' || input.reason === undefined
      ? { outcome: 'NOT_POSTED', ...(input.reason ? { reason: input.reason } : {}) }
      : null
  }
  return null
}

/**
 * Record an operator's verified outcome for ONE attempt of ONE AccountingSyncLog row.
 *
 * PERMISSION mirrors the per-row operator actions in app/actions/sync-exceptions.ts
 * (replayDeadReceiptEvent, clearPennyMismatchFlag): `requireFreshPermission('sync')`, so a
 * ledger-affecting assertion needs a session re-verified in the last 15 minutes — NOT the weaker
 * `requirePermission` the retryFailed* actions use. A retry re-attempts work the system already
 * decided to do; this records a NEW fact on a human's word alone.
 *
 * A 'use server' export is a public HTTP endpoint: this guard is the only thing between an
 * authenticated WAREHOUSE/FINANCE/READONLY/SUPPLIER session and a write that terminalises a
 * money-path row. It runs before anything is read, and it throws rather than returning, which is why
 * the whole body is wrapped for freshAuthFailureResult.
 */
export async function settleAccountingSyncRow(
  syncLogId: string,
  input: SettleAccountingSyncRowInput,
): Promise<SettleAccountingSyncRowResult> {
  try {
    const session = await requireFreshPermission('sync')

    const assertion = normalizeAssertion(input)
    if (!assertion) {
      return { success: false, error: 'Unrecognised settlement outcome.', code: 'unrecognised_outcome' }
    }

    // Server actions take untrusted arguments, and this one goes straight into a `where` clause. A
    // non-integer would reach Prisma as a query error rather than a refusal — and NaN in particular
    // would be an unexplained 500 on a money path. Forging a HIGHER revision is already handled by
    // the fence itself (the CAS matches nothing, and the explanatory read reports the real state),
    // so only the shape needs checking here.
    if (!Number.isSafeInteger(input.observedAttemptRevision) || input.observedAttemptRevision < 0) {
      return {
        success: false,
        code: 'unrecognised_outcome',
        error: 'The attempt this settlement was made about was not supplied correctly, so nothing was recorded. '
          + 'Reload the sync log and settle from what it shows.',
      }
    }

    const observedStatus = input.observedStatus
    if (!isSettleableAccountingSyncStatus(observedStatus)) {
      // Refused on the SHOWN status, before the row is even read. PENDING and the two terminal
      // statuses each get their own wording — the operator can SEE the row (o3d-osl8 item 1 shipped)
      // and is owed the reason they cannot act on it.
      return {
        success: false,
        error: describeUnsettleableStatus(observedStatus),
        code: observedStatus === 'PENDING'
          ? 'pending_not_settleable'
          : observedStatus === 'SYNCED' || observedStatus === 'CANCELLED'
            ? 'already_terminal'
            : 'status_not_settleable',
      }
    }

    const row = await db.accountingSyncLog.findUnique({
      where: { id: syncLogId },
      select: {
        id: true,
        connector: true,
        type: true,
        status: true,
        referenceType: true,
        referenceId: true,
        externalTransactionId: true,
        errorMessage: true,
        attemptRevision: true,
        // Needed by the mirror: buildMirroredAccountingEventIdempotencyKey prefers the payload's own
        // `_idempotencyKey` before falling back to the sync-log id.
        payload: true,
      },
    })
    if (!row) {
      return {
        success: false,
        code: 'ROW_MISSING',
        error: `Accounting sync row ${syncLogId} no longer exists, so nothing was settled. Reload the sync log.`,
      }
    }

    // Domain refusals — evaluated against the row AS READ, which is what the operator was shown:
    // PENDING / already-terminal / a DAILY_BATCH_* type / a POSTED assertion with no document id /
    // an assertion that contradicts post evidence the row already carries. None of these are about
    // WHICH ATTEMPT the decision lands on; that is the fence's job, below.
    const refusal = refuseSettlement(row, assertion)
    if (refusal) return { success: false, error: refusal.message, code: refusal.code }

    const now = new Date()
    const priorStatus = row.status
    const priorAttemptRevision = row.attemptRevision
    const externalTransactionId = settlementMirrorExternalId(assertion)
    const settledStatus = assertion.outcome === 'POSTED' ? 'SYNCED' as const : 'CANCELLED' as const

    // Every mirrored-event key updateMirroredAccountingEventStatus would try for THIS row. Empty
    // means the type is not mirrored at all (INVOICE_PAYMENT and the attachment/PDF follow-ups
    // o3d-nf9i's part-payment case is about), so there is no mirror to own, resolve or write.
    const mirrorKeys = mirroredAccountingEventIdempotencyKeys({
      connector: row.connector,
      syncLogId,
      type: row.type,
      referenceType: row.referenceType,
      referenceId: row.referenceId,
      payload: row.payload,
    })

    let outcome:
      | { settled: true; attemptRevision: number; mirror: MirrorAuditOutcome }
      | { settled: false; error: string; code: SettlementFailureCode }
    try {
      outcome = await db.$transaction(async (tx) => {
        // 1. THE FENCE. Nothing else in this transaction runs unless the decision landed on the
        //    exact attempt the operator judged. On refusal the fence's own message names what moved
        //    — a later attempt, or the same attempt having reached an outcome — and NOTHING is
        //    written: no status change, no audit row, no mirror update.
        const decision = await applyFencedAttemptDecision(tx, {
          id: syncLogId,
          expectedAttemptRevision: input.observedAttemptRevision,
          expectedStatus: observedStatus,
          data: buildSettlementData(assertion, now),
        })
        if (!decision.ok) {
          return { settled: false as const, error: decision.message, code: decision.reason }
        }

        // 2. WHOSE MIRROR IS IT? Resolved before the write so the audit can record the answer.
        //
        //    Mirror identity is LOGICAL, not per-row: two attempts at the same document share an
        //    idempotency key. A FAILED row can legitimately coexist with a LIVE replacement, because
        //    both partial unique indexes on AccountingSyncLog exclude FAILED. So terminalising the
        //    mirror unconditionally could VOID — and clear the externalId of — an event that now
        //    belongs to a live or already-POSTED replacement.
        //
        //    This read is an EXPLANATION, not a lock; a sibling can still commit after it. What makes
        //    a stale answer harmless is settlementMirrorGuard(), the CAS on the mirror write itself.
        let mirrorConflict: MirrorOwnershipConflict | null = null
        if (mirrorKeys.length > 0) {
          const siblings = await tx.accountingSyncLog.findMany({
            where: {
              id: { not: syncLogId },
              connector: row.connector,
              type: row.type,
              referenceType: row.referenceType,
              referenceId: row.referenceId,
              // Live (may still post) OR carrying post evidence of its own — a FAILED row with an
              // external id is a document that exists (o3d-ju8t), so it owns its mirror too.
              OR: [
                { status: { in: [...MIRROR_OWNING_SYNC_STATUSES] } },
                { externalTransactionId: { not: null } },
              ],
            },
            select: { id: true, status: true, externalTransactionId: true, payload: true },
          })
          mirrorConflict = findMirrorOwnershipConflict(
            mirrorKeys,
            siblings.map((sibling) => ({
              id: sibling.id,
              status: sibling.status,
              externalTransactionId: sibling.externalTransactionId,
              mirrorKeys: mirroredAccountingEventIdempotencyKeys({
                connector: row.connector,
                syncLogId: sibling.id,
                type: row.type,
                referenceType: row.referenceType,
                referenceId: row.referenceId,
                payload: sibling.payload,
              }),
            })),
          )
        }

        // 3. THE MIRROR, BEFORE THE AUDIT — so the audit records what happened rather than what was
        //    intended (round 2, finding 4). Both connectors and cancel-order-invoice-sync.ts
        //    terminalise the mirrored event whenever they terminalise a sync row, because a PENDING
        //    mirror left behind reads to reconciliation as work still owed.
        //
        //    Guarded, so a sibling that posts between step 2's read and this write keeps its record:
        //    the guard requires the event to be PENDING/FAILED and to name no document.
        let mirror: MirrorAuditOutcome
        if (mirrorKeys.length === 0) {
          mirror = 'not_mirrored'
        } else if (mirrorConflict) {
          mirror = 'skipped_owned_by_another_row'
        } else {
          const mirrorResult: MirroredEventUpdateOutcome = await updateMirroredAccountingEventStatus(tx, {
            connector: row.connector,
            syncLogId,
            type: row.type,
            referenceType: row.referenceType,
            referenceId: row.referenceId,
            payload: row.payload,
            status: settlementMirrorStatus(assertion.outcome),
            externalId: externalTransactionId,
            message: settlementNote(assertion),
            guard: settlementMirrorGuard(),
          })
          mirror = mirrorResult
        }

        // 4. THE AUDIT, in the SAME transaction and DURABLE.
        //
        //    logActivity() swallows its own errors so that logging can never break its caller. For an
        //    operator assertion that is the ONLY record of who changed a ledger-affecting status,
        //    best-effort is too weak — the status change would commit with nobody's name on it and
        //    nothing would ever say so. logActivityInTransaction applies the identical
        //    redaction/sanitisation but writes through this transaction and does NOT catch, so the
        //    audit and the status change are one atomic fact.
        await logActivityInTransaction(tx, {
          entityType: 'SYNC',
          entityId: syncLogId,
          action: 'accounting_sync_row_settled',
          tag: 'sync',
          // WARNING, not INFO: a human overriding what the system could determine, on a money path.
          // It belongs in the level-filtered audit views alongside the connectors' own
          // `*_followup_enqueue_refused` warnings.
          level: 'WARNING',
          description:
            `Operator settled ${row.connector} ${row.type} for ${row.referenceType} ${row.referenceId} `
            + `from ${priorStatus} (attempt ${input.observedAttemptRevision} -> ${decision.attemptRevision}). `
            + `${settlementNote(assertion)}`
            // A skipped or refused mirror write goes in the DESCRIPTION, not only the metadata: the
            // activity feed shows descriptions without expanding metadata, and "this settlement did
            // less than settlements normally do" must not need digging for.
            + (mirrorConflict ? ` ${describeMirrorOwnershipSkip(mirrorConflict)}` : '')
            + (mirror === 'refused'
              ? ' The mirrored accounting event was left untouched: it already records a posted document.'
              : '')
            + (mirror === 'not_found' && mirrorKeys.length > 0
              ? ' No mirrored accounting event matched this row, so none was updated.'
              : ''),
          metadata: {
            syncLogId,
            connector: row.connector,
            type: row.type,
            referenceType: row.referenceType,
            referenceId: row.referenceId,
            priorStatus,
            settledStatus,
            // Both ends of the fence, so the audit says which attempt was judged and which attempt
            // the decision became. Without them "the operator settled this row" is unanchored.
            observedAttemptRevision: input.observedAttemptRevision,
            priorAttemptRevision,
            attemptRevision: decision.attemptRevision,
            outcome: assertion.outcome,
            externalTransactionId,
            userId: session.user.id,
            // The POSTED patch replaces errorMessage, so without this the failure that made the row
            // need settling would be destroyed by the act of settling it.
            priorErrorMessage: row.errorMessage,
            // What actually happened to the shared mirror. Always stated: an outcome that is not
            // recorded is indistinguishable from a mirror that was never there.
            mirrorUpdate: mirror,
            mirrorConflictSyncLogId: mirrorConflict?.syncLogId ?? null,
            mirrorConflictStatus: mirrorConflict?.status ?? null,
          },
          userId: session.user.id,
        })

        return { settled: true as const, attemptRevision: decision.attemptRevision, mirror }
      })
    } catch (error) {
      // A P2002 from inside the transaction. The transaction has already rolled back — nothing is
      // half-written — but the raw exception would reach the client as a rejected promise and leave
      // the dialog spinning with no explanation at all.
      //
      // TWO DIFFERENT COLLISIONS live in here and they are NOT interchangeable (round 2, finding 3):
      // an AccountingSyncLog partial index (a live sibling row holds this identity) and
      // accounting_events (externalSystem, externalId) (that document id is already mirrored
      // elsewhere). describeSettlementUniqueConflict tells them apart from the constraint the
      // database named, and returns null for anything it does not recognise — which is rethrown
      // rather than dressed up as either.
      //
      // Nothing here auto-cancels a conflicting live row: it may be a real attempt still running,
      // and retiring it silently as a side effect of settling a DIFFERENT row is exactly the
      // unfenced retirement o3d-sref removed from the orphan sweep.
      const uniqueConflict = describeSettlementUniqueConflict(error)
      if (uniqueConflict) return { success: false, error: uniqueConflict.message, code: uniqueConflict.kind }
      throw error
    }

    if (!outcome.settled) return { success: false, error: outcome.error, code: outcome.code }

    revalidatePath('/sync')
    return {
      success: true,
      settledStatus,
      attemptRevision: outcome.attemptRevision,
      mirror: outcome.mirror,
    }
  } catch (error) {
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    throw error
  }
}
