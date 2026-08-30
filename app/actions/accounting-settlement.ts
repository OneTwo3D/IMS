'use server'

import { revalidatePath } from 'next/cache'
import type { Prisma } from '@/app/generated/prisma/client'
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
  OPERATOR_ASSERTION_SETTLEMENT_BASIS,
  buildCancelledSaleSettlementData,
  buildSettlementData,
  cancelledSaleSettlementNote,
  describeMirrorOwnershipSkip,
  describeSettlementUniqueConflict,
  describeUnsettleableStatus,
  findMirrorOwnershipConflict,
  isFencedAttemptRevision,
  isSaleScopedSettlementRow,
  isSettleableAccountingSyncStatus,
  refuseSettlement,
  refuseSettlementContradictedByMirror,
  settlementMirrorExternalId,
  settlementMirrorGuard,
  settlementMirrorStatus,
  settlementNote,
  type MirrorOwnershipConflict,
  type SettlementAssertion,
  type SettlementRefusal,
  type SettlementRefusalCode,
  type SettlementUniqueConflictKind,
} from '@/lib/domain/accounting/sync-row-settlement'
import { lockSalesOrder } from '@/lib/domain/sales/allocation-service'
import {
  accountingSyncEnabledSettingKey,
  describeStillClaimableStrandedRow,
  isStrandedRowUnclaimable,
} from '@/lib/domain/accounting/sync-row-claimability'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
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
  /**
   * The row is off the active connector but its connector's sync toggle is still on, so the
   * abandoned attempt is NOT the only attempt it can have — the manual Sync button would reclaim it
   * (round 5, Codex HIGH #1). Distinct from UNFENCED_ATTEMPT because the remedy is different and
   * performable: turn the toggle off. UNFENCED_ATTEMPT's own message says "this row cannot be
   * settled per-attempt", which would be a second wrong absolute in an operator's hands.
   */
  | 'CONNECTOR_STILL_CLAIMABLE'

export type SettleAccountingSyncRowResult =
  | {
    success: true
    /** What the row is now. */
    settledStatus: 'SYNCED' | 'CANCELLED'
    /** The attempt revision the decision landed as — the row has MOVED ON from what was shown. */
    attemptRevision: number
    /** What actually happened to the shared mirrored accounting event. Never assumed. */
    mirror: MirrorAuditOutcome
    /**
     * WHAT THIS RESULT RESTS ON. Always 'OPERATOR_ASSERTION' from this action, and stated rather
     * than left to be inferred: `settledStatus: 'SYNCED'` is byte-identical to what a connector
     * confirmation produces, and a caller that cannot name which it got will treat the two the same
     * (o3d-nf9i r3, Codex finding 1). It is also what is written to the row, so every downstream
     * reader gets the same answer this caller does.
     */
    basis: typeof OPERATOR_ASSERTION_SETTLEMENT_BASIS
    /**
     * The assertion was POSTED, but the SALE IS CANCELLED — so the document id was recorded and the
     * row was terminalised CANCELLED rather than SYNCED, keeping it out of the back-reference
     * sweep's candidate shape. `settledStatus` already says CANCELLED; this says WHY, because
     * "I said it posted and it came back cancelled" is otherwise unreadable (r3, Codex finding 4).
     */
    retiredForCancelledSale: boolean
    /** True when this row carried no attempt revision and the settlement MINTED one (r3, finding 3). */
    adoptedAttempt: boolean
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
   * The sale is cancelled, so the mirror was deliberately left as the cancellation left it. Flipping
   * it to POSTED is another way of telling the rest of the system this sale's work is live again —
   * the same mistake as promoting the row to SYNCED, one table over (o3d-e2mz r5, and r3 finding 4).
   */
  | 'skipped_cancelled_sale'

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

/**
 * Thrown to ROLL THE WHOLE TRANSACTION BACK on a refusal discovered after the fenced write landed
 * (o3d-nf9i r3, Codex finding 2).
 *
 * Returning a failure object from inside `db.$transaction` COMMITS everything the callback already
 * wrote — which is how round 2's contradicted mirror produced a settled row and a `success: true`
 * result at the same time. A refusal that is discovered late has to unwind, and in Prisma the only
 * way to unwind is to throw. Caught immediately outside the transaction and turned back into an
 * ordinary refusal, so the caller sees the same result shape as an early refusal.
 */
class SettlementRefusedError extends Error {
  constructor(readonly refusal: SettlementRefusal) {
    super(refusal.message)
    this.name = 'SettlementRefusedError'
  }
}

/**
 * Mirrors the private helper in app/actions/accounting-stranded-rows.ts (which in turn mirrors
 * getActiveConnector in app/actions/accounting-sync.ts). Duplicated rather than exported from
 * either, because both are 'use server': exporting it would mint a new RPC endpoint for a
 * four-line plugin-state read.
 */
async function resolveActiveAccountingConnector(): Promise<string | null> {
  if (await isIntegrationPluginEnabled('xero')) return 'xero'
  if (await isIntegrationPluginEnabled('quickbooks')) return 'quickbooks'
  return null
}

/**
 * The connector's sync toggle, read exactly as its own gates read it (round 5, Codex HIGH #1).
 *
 * This is the OTHER half of the adoption precondition, and it is the half neither round 3 nor round
 * 4 asked for. `triggerXeroSync` and `triggerQuickBooksSync` do `enabled?.value !== 'true'` on this
 * key and then run the processor — no plugin flag, no active-connector resolution — so a row whose
 * toggle is on is claimable however retired its connector looks.
 *
 * Returns null for a connector this codebase knows no claim path for, which
 * `isAccountingConnectorQuiesced` treats as "cannot be shown to be quiesced" rather than as off.
 */
async function readAccountingSyncEnabledValue(connector: string): Promise<string | null> {
  const key = accountingSyncEnabledSettingKey(connector)
  if (key === null) return null
  const setting = await db.setting.findUnique({ where: { key }, select: { value: true } })
  return setting?.value ?? null
}

/**
 * IS THE SALE THIS ROW BELONGS TO STILL THERE? Read UNDER THE ORDER'S ROW LOCK, inside the
 * transaction that writes (o3d-nf9i r3, Codex finding 4).
 *
 * o3d-e2mz stacks on this branch and gates its own fence-loss recovery on exactly this question,
 * taking exactly this lock, for exactly this reason: a row left `status IN (SYNCED, FAILED)` with an
 * externalTransactionId and no backReferenceCheckedAt IS `repairXeroBackReferences`' candidate
 * shape, and handing the sweep that shape for a cancelled order is handing it an instruction to
 * stamp the document id onto the cancelled sale and carry on with its work — back-reference, PDF,
 * email, storefront note, and PAYMENT. Cancellation exists to stop precisely that.
 *
 * Settling by hand writes the same shape, so settling outside the lock reopens what e2mz closed.
 * `cancelSalesOrderFulfillmentState` opens with `lockSalesOrder` on the same row, so taking it here
 * serialises the two: either the cancellation commits first and this read sees CANCELLED, or this
 * transaction holds the lock and the cancellation waits for the decision it is about to make.
 * e2mz r6 is the record of getting this wrong — reading the sale before the transaction left the
 * answer already history by the time it was used.
 *
 * THE LOCK IS TAKEN FIRST and the sync-log row is not touched until after the read, so the sync row
 * is never held while waiting on a slow order read (e2mz r5's reason for the ordering).
 *
 * A MISSING ORDER READS AS CANCELLED. Its work cannot be continued either and nothing downstream
 * would find it — the same call e2mz makes.
 */
async function readSaleCancellationStateUnderLock(
  tx: Prisma.TransactionClient,
  row: { referenceType: string; referenceId: string },
): Promise<'LIVE' | 'CANCELLED'> {
  if (!isSaleScopedSettlementRow(row.referenceType)) return 'LIVE'
  await lockSalesOrder(tx, row.referenceId)
  const sale = await tx.salesOrder.findUnique({ where: { id: row.referenceId }, select: { status: true } })
  if (!sale) return 'CANCELLED'
  return sale.status === 'CANCELLED' ? 'CANCELLED' : 'LIVE'
}

/**
 * Re-read the mirrored event and refuse when it CONTRADICTS the assertion (r3, Codex finding 2).
 *
 * Called on EVERY outcome once this row has a mirror at all, and it checks EVERY key — which is the
 * round-2 correction (r3 round 2, Codex finding 2).
 *
 * The obvious version checks only the paths where the mirror was not written, on the argument that a
 * written mirror cannot have been contradicting one: the guard holds only for an event that is
 * PENDING/FAILED and names no document. That reasoning covers the event that WAS written and no
 * other, and `mirroredAccountingEventIdempotencyKeys` yields up to two — the primary and the legacy,
 * syncLogId-less form that every attempt on the same day shares.
 * `updateMirroredAccountingEventStatus` writes the FIRST key that resolves and returns `'updated'`
 * without consulting the second, so a settlement could record document A over a legacy event that
 * already names document B and report success. This loop is what makes "no document IMS holds
 * contradicts this assertion" true of the whole key set rather than of one member of it.
 *
 * The read is inside the transaction and AFTER the write attempt, which is what makes it decisive
 * rather than advisory: a sibling that commits later loses the guarded write, not this refusal. It
 * is also what makes running it on the `updated` path harmless — the event just written reads back
 * as exactly what the assertion says, so it can only refuse on some OTHER document.
 */
async function refusalFromMirroredDocument(
  tx: Prisma.TransactionClient,
  mirrorKeys: readonly string[],
  assertion: SettlementAssertion,
): Promise<SettlementRefusal | null> {
  for (const key of mirrorKeys) {
    const event = await tx.accountingEvent.findUnique({
      where: { idempotencyKey: key },
      select: { status: true, externalId: true },
    })
    if (!event) continue
    const refusal = refuseSettlementContradictedByMirror(assertion, event)
    if (refusal) return refusal
  }
  return null
}

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

    // ADOPTION — the remedy for the rows that motivated this branch (r3, Codex finding 3).
    //
    // Every AccountingSyncLog row alive today is at revision 0, and revision 0 is UNFENCED_ATTEMPT.
    // Left there, this action refuses every single o3d-osl8 stranded row for ever: those rows sit on
    // a RETIRED connector, so no processor will ever claim one, so the revision never leaves 0. The
    // remedy would not exist for the population it was built for, and "wait for a claim that cannot
    // happen" is a refusal with no remedy the operator can perform.
    //
    // The precondition is narrow and it is checked HERE, against the installation rather than the
    // row: nothing that participates in the fence can ever claim a row whose connector is not the
    // active one. Such a row has exactly ONE attempt — the abandoned one in front of the operator —
    // so there is no later attempt for the decision to land on, which is the whole reason a CAS on
    // status is normally unsafe. A row on the ACTIVE connector is deliberately NOT adopted: it has a
    // route already (retry it, the fence-aware processor claims it and stamps attempt 1), and
    // offering a second way to do what the system does correctly by itself is the same objection
    // that keeps PENDING unsettleable.
    //
    // AND "NOT THE ACTIVE CONNECTOR" IS NOT THAT PRECONDITION (round 5, Codex HIGH #1). The active
    // connector is resolved from the PLUGIN flags, Xero-first; `triggerQuickBooksSync` and
    // `triggerXeroSync` — the manual Sync buttons, reachable by any holder of `sync` — gate on
    // `<connector>_sync_enabled` and never resolve the active connector at all. With Xero enabled
    // beside a still-enabled QuickBooks, this test alone would adopt a QuickBooks row that the very
    // next press of the QuickBooks Sync button reclaims: the operation replays and the worker's
    // write lands on top of the settlement. `isStrandedRowUnclaimable` is the whole rule, shared
    // verbatim with the read model that decides whether to OFFER the control.
    const activeConnector = await resolveActiveAccountingConnector()
    const wantsAdoption = !isFencedAttemptRevision(row.attemptRevision) && input.observedAttemptRevision === 0
    const adoptAttempt = wantsAdoption && isStrandedRowUnclaimable({
      connector: row.connector,
      activeConnector,
      syncEnabledValue: await readAccountingSyncEnabledValue(row.connector),
    })

    // REFUSED WITH THE LEVER, not with the fence's generic sentence. A row that is off the active
    // connector and STILL claimable would otherwise fall through to UNFENCED_ATTEMPT, whose message
    // ends "this row cannot be settled per-attempt" — the same absolute round 4 was raised to
    // remove, restated where the reader can act on it. Named here so the operator is told the one
    // thing that changes the answer.
    if (wantsAdoption && !adoptAttempt && activeConnector !== row.connector) {
      return {
        success: false,
        code: 'CONNECTOR_STILL_CLAIMABLE',
        error: describeStillClaimableStrandedRow(row.connector),
      }
    }

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
      | {
        settled: true
        attemptRevision: number
        mirror: MirrorAuditOutcome
        settledStatus: 'SYNCED' | 'CANCELLED'
        retiredForCancelledSale: boolean
      }
      | { settled: false; error: string; code: SettlementFailureCode }
    try {
      outcome = await db.$transaction(async (tx) => {
        // 0. IS THERE STILL A SALE FOR THIS WORK TO BELONG TO? Taken FIRST, under the order's row
        //    lock, before the sync row is touched — see readSaleCancellationStateUnderLock. o3d-e2mz
        //    gates its own recovery on the identical question under the identical lock, and settling
        //    outside that lock reopens exactly what it closed (r3, Codex finding 4).
        const sale = await readSaleCancellationStateUnderLock(tx, row)
        // A POSTED assertion on a CANCELLED sale still RECORDS the document — it is real evidence,
        // the delete guard reads externalTransactionId whatever the status, and discarding it would
        // strand the document — but it terminalises the row CANCELLED instead of SYNCED, keeping it
        // out of the back-reference sweep's candidate shape. NOT_POSTED already lands on CANCELLED,
        // so it needs no variant; it just needed the lock.
        const retiredForCancelledSale = sale === 'CANCELLED' && assertion.outcome === 'POSTED'
        const settledStatusNow = retiredForCancelledSale ? 'CANCELLED' as const : settledStatus

        // 1. THE FENCE. Nothing else in this transaction runs unless the decision landed on the
        //    exact attempt the operator judged. On refusal the fence's own message names what moved
        //    — a later attempt, or the same attempt having reached an outcome — and NOTHING is
        //    written: no status change, no audit row, no mirror update.
        const decision = await applyFencedAttemptDecision(tx, {
          id: syncLogId,
          expectedAttemptRevision: input.observedAttemptRevision,
          expectedStatus: observedStatus,
          adoptUnfencedAttempt: adoptAttempt,
          data: retiredForCancelledSale
            ? buildCancelledSaleSettlementData(assertion as Extract<SettlementAssertion, { outcome: 'POSTED' }>, now)
            : buildSettlementData(assertion, now),
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
        } else if (retiredForCancelledSale) {
          // The mirror is deliberately NOT flipped to POSTED for a cancelled sale. The cancellation
          // voided it, and re-POSTing it is another way of telling the rest of the system this
          // sale's work is live again — the same mistake as promoting the row to SYNCED, one table
          // over (o3d-e2mz r5's wording, and the same conclusion here).
          mirror = 'skipped_cancelled_sale'
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

        // 3b. A MIRROR THAT WAS NOT WRITTEN MAY BE CONTRADICTING THIS ASSERTION (r3, finding 2).
        //
        //     Round 2 recorded every non-write in the audit and returned `success: true` regardless
        //     — so an operator asserting document A over a mirrored event that already names
        //     document B was told their assertion had been accepted, and the two records were left
        //     disagreeing with nothing refusing. `taxinv` is the same shape: a wrong document that
        //     reported success, where the verdict half was worse than the figure.
        //
        //     EVERY OUTCOME IS CHECKED, INCLUDING `updated` (r3 round 2, Codex finding 2). Round 2
        //     checked only the three non-write outcomes, on the argument that "`updated` cannot be
        //     contradicting: the guard holds only for an event that is PENDING/FAILED and names no
        //     document". That is true OF THE EVENT THAT WAS WRITTEN — and there can be TWO.
        //
        //     `mirroredAccountingEventIdempotencyKeys` returns the PRIMARY key and the LEGACY,
        //     syncLogId-less one, and `updateMirroredAccountingEventStatus` stops at the first key
        //     that resolves: a primary event that is PENDING with no document id satisfies the guard
        //     and is written, and the function returns `'updated'` WITHOUT EVER LOOKING AT THE LEGACY
        //     KEY. If the legacy event — the same logical document, shared by every attempt on the
        //     same day — already names document B, the operator asserting document A was told their
        //     assertion had been accepted, the two records were left disagreeing, and nothing
        //     refused. That is the exact defect round 2 fixed, surviving on the second key.
        //
        //     So the check is unconditional on there being a mirror at all. It is safe on the
        //     `updated` path because the written event is SELF-CONSISTENT WITH THE ASSERTION BY
        //     CONSTRUCTION and this read happens after the write: a POSTED assertion sets
        //     `externalId` to the very id being asserted (equal id is a retried click, not a
        //     contradiction), and a NOT_POSTED assertion sets VOID with a null externalId, which
        //     contradicts nothing. Only a DIFFERENT document, under either key, refuses.
        if (mirrorKeys.length > 0) {
          const contradiction = await refusalFromMirroredDocument(tx, mirrorKeys, assertion)
          // THROWN, not returned. Returning here would COMMIT the fenced write above and then report
          // a failure — a settled row and a refusal in the same breath, which is worse than either.
          if (contradiction) throw new SettlementRefusedError(contradiction)
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
            + `from ${priorStatus} (attempt ${input.observedAttemptRevision} -> ${decision.attemptRevision}`
            + `${adoptAttempt ? ', ADOPTED: the row carried no attempt revision and nothing can ever claim it' : ''}). `
            + `${retiredForCancelledSale
              ? cancelledSaleSettlementNote(assertion as Extract<SettlementAssertion, { outcome: 'POSTED' }>)
              : settlementNote(assertion)}`
            // A skipped or refused mirror write goes in the DESCRIPTION, not only the metadata: the
            // activity feed shows descriptions without expanding metadata, and "this settlement did
            // less than settlements normally do" must not need digging for.
            + (mirrorConflict ? ` ${describeMirrorOwnershipSkip(mirrorConflict)}` : '')
            + (mirror === 'refused'
              ? ' The mirrored accounting event was left untouched: it already records a posted document.'
              : '')
            + (mirror === 'not_found' && mirrorKeys.length > 0
              ? ' No mirrored accounting event matched this row, so none was updated.'
              : '')
            + (mirror === 'skipped_cancelled_sale'
              ? ' The mirrored accounting event was left as the cancellation left it: re-posting it would tell '
                + 'the rest of the system this cancelled sale\'s work is live again.'
              : ''),
          metadata: {
            syncLogId,
            connector: row.connector,
            type: row.type,
            referenceType: row.referenceType,
            referenceId: row.referenceId,
            priorStatus,
            settledStatus: settledStatusNow,
            // The verdict's BASIS, on the audit row as well as on the sync row: an audit that says
            // only "settled" cannot be told apart from a connector confirmation either (r3).
            settlementBasis: OPERATOR_ASSERTION_SETTLEMENT_BASIS,
            // The two facts that make this settlement different from an ordinary one.
            adoptedAttempt: adoptAttempt,
            retiredForCancelledSale,
            saleState: isSaleScopedSettlementRow(row.referenceType) ? sale : null,
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

        return {
          settled: true as const,
          attemptRevision: decision.attemptRevision,
          mirror,
          settledStatus: settledStatusNow,
          retiredForCancelledSale,
        }
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
      // A LATE REFUSAL that rolled the whole transaction back on purpose (r3, finding 2). The
      // status change, the mirror write and the audit are all gone; this turns it back into the
      // ordinary refusal shape the caller already handles.
      if (error instanceof SettlementRefusedError) {
        return { success: false, error: error.refusal.message, code: error.refusal.code }
      }
      const uniqueConflict = describeSettlementUniqueConflict(error)
      if (uniqueConflict) return { success: false, error: uniqueConflict.message, code: uniqueConflict.kind }
      throw error
    }

    if (!outcome.settled) return { success: false, error: outcome.error, code: outcome.code }

    revalidatePath('/sync')
    return {
      success: true,
      // What the row IS, which is not always what the assertion asked for: a POSTED assertion on a
      // cancelled sale lands on CANCELLED with the document id recorded (r3, finding 4).
      settledStatus: outcome.settledStatus,
      attemptRevision: outcome.attemptRevision,
      mirror: outcome.mirror,
      // Stated, never inferred. This result is an ASSERTION being reported back, not a confirmation.
      basis: OPERATOR_ASSERTION_SETTLEMENT_BASIS,
      retiredForCancelledSale: outcome.retiredForCancelledSale,
      adoptedAttempt: adoptAttempt,
    }
  } catch (error) {
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    throw error
  }
}
