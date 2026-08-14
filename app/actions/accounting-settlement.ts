'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { freshAuthFailureResult, requireFreshPermission, requirePermission } from '@/lib/auth/server'
import { logActivityInTransaction } from '@/lib/activity-log'
import {
  mirroredAccountingEventIdempotencyKeys,
  updateMirroredAccountingEventStatus,
} from '@/lib/domain/accounting/accounting-event-mirror'
import {
  MIRROR_OWNING_SYNC_STATUSES,
  buildSettlementData,
  buildSettlementWhere,
  buildStrandedSyncRowWhere,
  describeLostSettlementCas,
  describeMirrorOwnershipSkip,
  describeSettlementUniqueConflict,
  describeStrandedSyncRow,
  describeUnsettleableStatus,
  findMirrorOwnershipConflict,
  isSettleableAccountingSyncStatus,
  refuseSettlement,
  settlementMirrorExternalId,
  settlementMirrorStatus,
  settlementNote,
  type MirrorOwnershipConflict,
  type SettlementAssertion,
  type StrandedSyncRow,
} from '@/lib/domain/accounting/sync-row-settlement'
import type { FreshAuthFailureResult } from '@/lib/auth/session-gates'

// ---------------------------------------------------------------------------
// ONE audited per-row settlement action for AccountingSyncLog rows the system cannot resolve
// itself, plus the loader that makes those rows visible in the first place.
//
// SCOPE — what this file closes and what it does NOT.
//
//   o3d-nf9i  CLOSED. A FAILED row that must NOT be retried, because FAILED does not prove
//             nothing posted (o3d-ju8t: the remote call precedes the writeback). FAILED is also
//             the only status it is SAFE to settle: it is terminal, so no worker holds the row
//             and no remote call is outstanding against it.
//
//   o3d-osl8  ITEM 1 ONLY. Its stranded rows — including PROCESSING rows on a retired connector
//             — are now VISIBLE with identifying detail instead of being one integer in a
//             banner. That is the whole of item 1 and it ships. The rest of o3d-osl8 stays open.
//
// WHY PROCESSING IS NOT SETTLEABLE. The settleable set is FAILED and nothing else. A CAS on
// `status = 'PROCESSING'` proves only that the row still SAYS PROCESSING; it cannot prove the
// claimed remote call has finished, nor that the operator is settling the same attempt that is
// running. The interleaving is ordinary: worker claims -> worker issues the call -> operator
// looks in the ledger, correctly sees nothing yet -> asserts NOT_POSTED -> row CANCELLED ->
// delete guard stops blocking -> order hard-deleted -> the call lands. That is exactly the
// stranded document the guard exists to prevent, and exactly why o3d-sref stopped the orphan
// sweep retiring unprovable claims. Making it safe needs an immutable claim GENERATION on the
// row that the connectors' writeback also compare-and-sets on, so a settlement fences ONE
// attempt and a late writeback loses. That is connector work under o3d-osl8, not action work.
// A PROCESSING row is therefore listed, flagged not-settleable, and refused with that reason.
//
// DAILY_BATCH_* rows are refused whatever their status: see isSettleableAccountingSyncType —
// CANCELLED reads as "never posted" to BOTH the batch recreators and the delete guard, so
// settling one opens a recreate-vs-delete race that puts a deleted order's value into a posted
// journal.
//
// The decision content lives in lib/domain/accounting/sync-row-settlement.ts as pure functions;
// this file is the guard, the transaction, and the I/O.
//
// WHY A NEW FILE and not app/actions/accounting-sync.ts:
//  - tests/accounting-orphan-cancel-inflight.test.ts greps that file's `updateMany` block and
//    asserts no `status: 'PROCESSING'` literal appears in it (the o3d-sref guarantee that the
//    orphan sweep never retires an unprovable claim). A second status-driven updateMany in that
//    file would sit inside the grepped region and is far too easy to break that guard with.
//  - that file is blanket-allowlisted in tests/security/server-action-guard-coverage.test.ts as
//    a "connector facade". These are not facades; they carry their own guards and should be
//    checked like any other action, which a new file gets for free.
// ---------------------------------------------------------------------------

/**
 * `code` is present only on the failures a caller might want to distinguish:
 *   'live_row_conflict'  the POSTED branch hit a partial-unique-index collision with a LIVE row.
 */
type MutationResult =
  | { success: boolean; error?: string; code?: 'live_row_conflict' }
  | FreshAuthFailureResult

/**
 * The operator's assertion, plus the status they were SHOWN.
 *
 * `observedStatus` is the CAS fence. It is passed in rather than re-read at write time on
 * purpose: the point is to detect that the row moved between the operator forming a judgement
 * and this write landing, and a value the server re-reads for itself cannot detect that.
 */
export type SettleAccountingSyncRowInput = {
  observedStatus: string
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
 * Record an operator's verified outcome for ONE stranded AccountingSyncLog row.
 *
 *   { outcome: 'POSTED', externalTransactionId }  ->  SYNCED, external id recorded
 *   { outcome: 'NOT_POSTED', reason? }            ->  CANCELLED, external id left NULL
 *
 * This is an assertion of a fact the system cannot verify, NEVER an automatic
 * reclassification. Nothing here infers the outcome — see the module comment in
 * lib/domain/accounting/sync-row-settlement.ts for why inference from errorMessage, age or
 * retry count is unsound (o3d-h2wx).
 *
 * Permission mirrors the per-row operator actions in app/actions/sync-exceptions.ts
 * (replayDeadReceiptEvent, clearPennyMismatchFlag): `requireFreshPermission('sync')`, so a
 * ledger-affecting assertion needs a session re-verified in the last 15 minutes — NOT the
 * weaker requirePermission the retryFailed* actions use, because a retry re-attempts work the
 * system already decided to do, whereas this records a new fact on a human's word alone.
 */
export async function settleAccountingSyncRow(
  syncLogId: string,
  input: SettleAccountingSyncRowInput,
): Promise<MutationResult> {
  try {
    const session = await requireFreshPermission('sync')

    const assertion = normalizeAssertion(input)
    if (!assertion) return { success: false, error: 'Unrecognised settlement outcome.' }

    const observedStatus = input.observedStatus
    if (!isSettleableAccountingSyncStatus(observedStatus)) {
      // Refused on the SHOWN status, before the row is even read. describeUnsettleableStatus
      // gives PROCESSING its own honest wording rather than a generic "not settleable": the
      // operator can SEE the row (o3d-osl8 item 1 ships), and is owed the reason they cannot act.
      return { success: false, error: describeUnsettleableStatus(observedStatus) }
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
        // Needed by the mirror: buildMirroredAccountingEventIdempotencyKey prefers the
        // payload's own `_idempotencyKey` before falling back to the sync-log id.
        payload: true,
      },
    })
    if (!row) return { success: false, error: describeLostSettlementCas(null) }

    // Domain refusals first — PENDING / PROCESSING / already-terminal / a DAILY_BATCH_* type /
    // a POSTED assertion with no external id / an assertion that contradicts post evidence the
    // row already carries.
    const refusal = refuseSettlement(row, assertion)
    if (refusal) return { success: false, error: refusal.message }
    // The row moved between the operator's view and this read. Reported here rather than left
    // to the CAS purely so the operator gets the specific message; the CAS below is still the
    // only thing that actually fences the write.
    if (row.status !== observedStatus) return { success: false, error: describeLostSettlementCas(row.status) }

    const now = new Date()
    const priorStatus = row.status
    const externalTransactionId = settlementMirrorExternalId(assertion)
    // Every mirrored-event key updateMirroredAccountingEventStatus would try for THIS row.
    // Empty means the type is not mirrored at all (INVOICE_PAYMENT, the attachment/PDF
    // follow-ups o3d-nf9i's part-payment case is about), in which case there is no mirror to
    // own, resolve, or write.
    const mirrorKeys = mirroredAccountingEventIdempotencyKeys({
      connector: row.connector,
      syncLogId,
      type: row.type,
      referenceType: row.referenceType,
      referenceId: row.referenceId,
      payload: row.payload,
    })

    // The P2002 catch is wrapped tightly around the transaction, and consulted only for the
    // POSTED branch, so the message it produces is provably about the collision it names:
    // FAILED -> SYNCED is the ONLY move settlement makes that re-enters the partial unique
    // indexes (their predicate is `status IN ('PENDING','PROCESSING','SYNCED')`, so the
    // NOT_POSTED/CANCELLED branch LEAVES them instead). A unique violation raised anywhere
    // else is not this failure and must not be dressed up as it.
    let outcome: { settled: true } | { settled: false; error: string }
    try {
      outcome = await db.$transaction(async (tx) => {
        // 1. THE CAS. `where: { id, status: <what the operator was shown> }`. Count 0 means the
        //    row moved and the assertion was made against a stale view, so NOTHING is written —
        //    no status change, no audit row, no mirror update — and the failure names the
        //    PERSISTED state, not the stale one. Same contract the retry paths pin in
        //    tests/accounting/main-sync-failure-retry-concurrency.test.ts and
        //    tests/accounting/sync-followup-retry-concurrency.test.ts.
        const updated = await tx.accountingSyncLog.updateMany({
          where: buildSettlementWhere(syncLogId, observedStatus),
          data: buildSettlementData(assertion, now),
        })
        if (updated.count === 0) {
          const persisted = await tx.accountingSyncLog.findUnique({ where: { id: syncLogId }, select: { status: true } })
          return { settled: false as const, error: describeLostSettlementCas(persisted?.status ?? null) }
        }

        // 2. WHOSE MIRROR IS IT? Resolved BEFORE the audit so the audit can record the answer.
        //
        //    Mirror identity is LOGICAL, not per-row: two attempts at the same document share an
        //    idempotency key (the payload's `_idempotencyKey` is preferred over the sync-log id,
        //    and the legacy `<connector>:<type>:<ref>:<date>` fallback is shared by construction).
        //    A FAILED row can legitimately coexist with a LIVE replacement, because both partial
        //    unique indexes exclude FAILED. So terminalising the mirror unconditionally can VOID —
        //    and clear the externalId of — an event that now belongs to a live or already-POSTED
        //    replacement. updateMirroredAccountingEventStatus has no ownership CAS of its own.
        //
        //    Scoped to the same connector/type/reference: both key forms are derived from those,
        //    and an event whose logical identity spanned different references would already be a
        //    different bug. The read is inside the transaction so it sees the same snapshot as the
        //    CAS above.
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

        // 3. THE AUDIT, in the SAME transaction and BEFORE the mirror.
        //
        //    logActivity() swallows its own errors (lib/activity-log.ts ~L86-88) so that logging
        //    can never break its caller. For an operator assertion that is the ONLY record of who
        //    changed a ledger-affecting status, best-effort is too weak — the status change would
        //    commit with nobody's name on it and nothing would ever say so. logActivityInTransaction
        //    applies the identical redaction/sanitisation but writes through the caller's
        //    transaction and does not catch, so audit and status change are one atomic fact.
        //
        //    Ordered before the mirror deliberately: if the mirror write throws, the audit row
        //    rolls back with the status change rather than surviving as a record of something
        //    that did not happen.
        await logActivityInTransaction(tx, {
          entityType: 'SYNC',
          entityId: syncLogId,
          action: 'accounting_sync_row_settled',
          tag: 'sync',
          // WARNING, not INFO: this is a human overriding what the system could determine, on a
          // money path. It belongs in the level-filtered audit views alongside the connectors'
          // own `*_followup_enqueue_refused` warnings.
          level: 'WARNING',
          description:
            `Operator settled ${row.connector} ${row.type} for ${row.referenceType} ${row.referenceId} `
            + `from ${priorStatus}. ${settlementNote(assertion)}`
            // A skipped mirror write goes in the DESCRIPTION, not only the metadata: the activity
            // feed shows descriptions without expanding metadata, and "this settlement did less
            // than settlements normally do" is the kind of thing that must not need digging for.
            + (mirrorConflict ? ` ${describeMirrorOwnershipSkip(mirrorConflict)}` : ''),
          // userId in the metadata explicitly, per the sync-exceptions.ts convention — the column
          // is nullable and SetNull on user delete, so the id is also carried where it survives.
          metadata: {
            syncLogId,
            connector: row.connector,
            type: row.type,
            referenceType: row.referenceType,
            referenceId: row.referenceId,
            priorStatus,
            outcome: assertion.outcome,
            externalTransactionId,
            userId: session.user.id,
            // Beyond the fields o3d-nf9i lists: the POSTED patch nulls errorMessage to match the
            // processors' own success write, so without this the failure that made the row need
            // settling would be destroyed by the act of settling it.
            priorErrorMessage: row.errorMessage,
            // What happened to the shared mirror, always stated — a skip that is not recorded is
            // indistinguishable from a mirror that was never there.
            mirrorUpdate: mirrorKeys.length === 0
              ? 'not_mirrored'
              : mirrorConflict
                ? 'skipped_owned_by_another_row'
                : 'applied',
            mirrorConflictSyncLogId: mirrorConflict?.syncLogId ?? null,
            mirrorConflictStatus: mirrorConflict?.status ?? null,
          },
          userId: session.user.id,
        })

        // 4. THE MIRROR, in step — UNLESS another row owns it. Both connectors and
        //    cancel-order-invoice-sync.ts (~L56-60) terminalise the mirrored accounting event
        //    whenever they terminalise a sync row, because a PENDING mirror left behind reads to
        //    reconciliation as work still owed. Skipping it unconditionally would move the
        //    stranding one table across instead of ending it.
        //
        //    But when step 2 found a live or already-posted row sharing this mirror, writing here
        //    would corrupt THAT attempt's record, which is strictly worse than leaving a mirror
        //    that its real owner will terminalise itself. The row's own settlement still stands:
        //    it is genuinely settled, and only the shared event is left alone.
        //
        //    A no-op for non-mirrorable types (mirrorKeys empty), which the call would handle
        //    itself anyway — skipped here so the audit's `not_mirrored` and the absent call agree.
        if (mirrorKeys.length > 0 && !mirrorConflict) {
          await updateMirroredAccountingEventStatus(tx, {
            connector: row.connector,
            syncLogId,
            type: row.type,
            referenceType: row.referenceType,
            referenceId: row.referenceId,
            payload: row.payload,
            status: settlementMirrorStatus(assertion.outcome),
            externalId: externalTransactionId,
            message: settlementNote(assertion),
          })
        }

        return { settled: true as const }
      })
    } catch (error) {
      // A P2002 out of the CAS update: moving FAILED -> SYNCED re-enters both partial unique
      // indexes and collides with a LIVE row for the same identity. The transaction has already
      // rolled back — nothing is half-written — but the raw exception would reach the client as
      // a rejected promise and leave the dialog spinning with no explanation at all. Translate
      // it into a result the operator can act on, and do NOT auto-cancel the conflicting row:
      // it may be a real attempt still in flight, and retiring it silently as a side effect of
      // settling a DIFFERENT row is exactly the unfenced retirement o3d-sref removed from the
      // orphan sweep.
      const uniqueConflict = assertion.outcome === 'POSTED' ? describeSettlementUniqueConflict(error) : null
      if (uniqueConflict) return { success: false, error: uniqueConflict, code: 'live_row_conflict' }
      throw error
    }

    if (!outcome.settled) return { success: false, error: outcome.error }

    revalidatePath('/sync')
    return { success: true }
  } catch (error) {
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    throw error
  }
}

// ---------------------------------------------------------------------------
// o3d-osl8 item 1 — the stranded-row loader.
// ---------------------------------------------------------------------------

// NOTE: StrandedSyncRow is deliberately NOT re-exported from here. This module is 'use server',
// and Turbopack registers every export of such a module in the server-actions manifest — including
// a type-only re-export, which then fails to resolve at build time with "The export
// StrandedSyncRow was not found". tsc does not catch it, because to tsc the re-export is sound.
// Consumers import the type straight from lib/domain/accounting/sync-row-settlement instead.

/**
 * Mirrors the private getActiveConnector in app/actions/accounting-sync.ts. Duplicated rather
 * than exported from there because that module is 'use server': exporting it would mint a new
 * RPC endpoint for a four-line plugin-state read.
 */
async function resolveActiveAccountingConnector(): Promise<string | null> {
  if (await isIntegrationPluginEnabled('xero')) return 'xero'
  if (await isIntegrationPluginEnabled('quickbooks')) return 'quickbooks'
  return null
}

/**
 * Unresolved accounting sync rows on a connector that is NOT the active one — WITH the detail
 * needed to act on them: connector, type, reference, status, age, and the last error.
 *
 * o3d-osl8 is explicit that an aggregate count is not a remedy; that was the specific
 * criticism. Every existing accounting log view is scoped to the active connector
 * (getAccountingSyncLogs resolves it; getXeroSyncLogs / getQuickBooksSyncLogs hard-filter), so
 * a row left behind on a retired connector is visible ONLY as the integer in the orphan
 * banner. This loader is deliberately NOT connector-scoped, which is the whole point of it.
 *
 * Oldest first — the longest-stuck row is the one most likely to be blocking a delete.
 * Served by @@index([connector, status, createdAt]) on AccountingSyncLog.
 *
 * GUARDED ON `sync`, NOT merely on being logged in. This is an exported server action, so it is
 * a callable RPC endpoint for ANY authenticated session — and what it returns is not a summary:
 * sync-log ids, the referenced entity ids, external transaction ids, and raw connector error
 * text, across connectors the caller has nothing to do with. requireAuth would hand all of that
 * to WAREHOUSE, FINANCE, READONLY and SUPPLIER sessions. `sync` is the permission that already
 * gates every other accounting-sync read and the settlement action this loader feeds, so it is
 * the same boundary rather than a new one.
 */
export async function getStrandedAccountingSyncRows(limit = 50): Promise<StrandedSyncRow[]> {
  await requirePermission('sync')
  const activeConnector = await resolveActiveAccountingConnector()
  // Client-supplied bound; clamp rather than trust.
  const take = Math.min(Math.max(Math.trunc(Number(limit) || 50), 1), 200)
  const rows = await db.accountingSyncLog.findMany({
    where: buildStrandedSyncRowWhere(activeConnector),
    orderBy: { createdAt: 'asc' },
    take,
    select: {
      id: true,
      connector: true,
      type: true,
      status: true,
      referenceType: true,
      referenceId: true,
      externalTransactionId: true,
      errorMessage: true,
      createdAt: true,
    },
  })
  const now = new Date()
  return rows.map((row) => describeStrandedSyncRow(row, now))
}
