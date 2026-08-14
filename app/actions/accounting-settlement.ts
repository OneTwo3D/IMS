'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { freshAuthFailureResult, requireAuth, requireFreshPermission } from '@/lib/auth/server'
import { logActivityInTransaction } from '@/lib/activity-log'
import { updateMirroredAccountingEventStatus } from '@/lib/domain/accounting/accounting-event-mirror'
import {
  buildSettlementData,
  buildSettlementWhere,
  buildStrandedSyncRowWhere,
  describeLostSettlementCas,
  describeStrandedSyncRow,
  isSettleableAccountingSyncStatus,
  refuseSettlement,
  settlementMirrorExternalId,
  settlementMirrorStatus,
  settlementNote,
  type SettlementAssertion,
  type StrandedSyncRow,
} from '@/lib/domain/accounting/sync-row-settlement'
import type { FreshAuthFailureResult } from '@/lib/auth/session-gates'

// ---------------------------------------------------------------------------
// o3d-nf9i + o3d-osl8 — ONE audited per-row settlement action for AccountingSyncLog rows the
// system cannot resolve itself, plus the loader that makes those rows visible in the first
// place.
//
// Both bd issues say explicitly that this must be ONE mechanism, not two. They describe the
// same shape of stranding from opposite ends:
//
//   o3d-nf9i  a FAILED row that must NOT be retried, because FAILED does not prove nothing
//             posted (o3d-ju8t: the remote call precedes the writeback).
//   o3d-osl8  a PROCESSING row on a RETIRED connector, which since o3d-sref the orphan sweep
//             correctly refuses to retire, so it stays PROCESSING forever.
//
// In both, the missing thing is identical: a human who has looked in the accounting system and
// can state what is actually there. The decision content lives in
// lib/domain/accounting/sync-row-settlement.ts as pure functions; this file is the guard, the
// transaction, and the I/O.
//
// WHY A NEW FILE and not app/actions/accounting-sync.ts:
//  - tests/accounting-orphan-cancel-inflight.test.ts greps that file's `updateMany` block and
//    asserts no `status: 'PROCESSING'` literal appears in it (the o3d-sref guarantee that the
//    orphan sweep never retires an unprovable claim). A second updateMany there — this one
//    legitimately naming PROCESSING — would break a real guard test for no reason.
//  - that file is blanket-allowlisted in tests/security/server-action-guard-coverage.test.ts as
//    a "connector facade". These are not facades; they carry their own guards and should be
//    checked like any other action, which a new file gets for free.
// ---------------------------------------------------------------------------

type MutationResult = { success: boolean; error?: string } | FreshAuthFailureResult

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
      return {
        success: false,
        error: `Status ${observedStatus} cannot be settled by hand. Only FAILED and PROCESSING rows can.`,
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
        // Needed by the mirror: buildMirroredAccountingEventIdempotencyKey prefers the
        // payload's own `_idempotencyKey` before falling back to the sync-log id.
        payload: true,
      },
    })
    if (!row) return { success: false, error: describeLostSettlementCas(null) }

    // Domain refusals first — PENDING / already-terminal / a POSTED assertion with no external
    // id / an assertion that contradicts post evidence the row already carries.
    const refusal = refuseSettlement(row, assertion)
    if (refusal) return { success: false, error: refusal.message }
    // The row moved between the operator's view and this read. Reported here rather than left
    // to the CAS purely so the operator gets the specific message; the CAS below is still the
    // only thing that actually fences the write.
    if (row.status !== observedStatus) return { success: false, error: describeLostSettlementCas(row.status) }

    const now = new Date()
    const priorStatus = row.status
    const externalTransactionId = settlementMirrorExternalId(assertion)

    const outcome = await db.$transaction(async (tx) => {
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

      // 2. THE AUDIT, in the SAME transaction and BEFORE the mirror.
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
          + `from ${priorStatus}. ${settlementNote(assertion)}`,
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
        },
        userId: session.user.id,
      })

      // 3. THE MIRROR, in step. Both connectors and cancel-order-invoice-sync.ts (~L56-60)
      //    terminalise the mirrored accounting event whenever they terminalise a sync row,
      //    because a PENDING mirror left behind reads to reconciliation as work still owed.
      //    Skipping it here would move the stranding one table across instead of ending it.
      //
      //    A no-op for non-mirrorable types (the INVOICE_PAYMENT / attachment / PDF follow-ups
      //    o3d-nf9i's part-payment case is about are not mirrored):
      //    buildMirroredAccountingEventIdempotencyKey returns null and the call returns early.
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

      return { settled: true as const }
    })

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
 */
export async function getStrandedAccountingSyncRows(limit = 50): Promise<StrandedSyncRow[]> {
  await requireAuth()
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
