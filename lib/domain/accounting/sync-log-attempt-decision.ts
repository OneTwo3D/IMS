import type { AccountingSyncStatus, Prisma } from '@/app/generated/prisma/client'
import { lockOrdersOfInvoiceRows, recomputeInvoicingStateForSyncLogs } from '@/lib/domain/sales/invoicing-state-sites'
import {
  UNCLAIMED_ATTEMPT_REVISION,
  nextAttemptRevision,
  type AttemptDecisionOutcome,
} from '@/lib/domain/accounting/sync-log-attempt'

/** SERVER ONLY: the per-attempt decision fence (see sync-log-attempt.ts for the attempt identity it rests on). Split out so sync-log-attempt.ts stays client-safe. */

/**
 * Apply an operator decision to ONE attempt of a sync row.
 *
 * `expectedAttemptRevision` / `expectedStatus` are what the operator was looking at when they
 * decided. The decision lands only if both are still current, and it bumps the revision as it
 * lands — which is what makes an in-flight worker's writeback CAS fail rather than silently undo it.
 *
 * On refusal the message states what moved and what the operator can do about it. It prescribes no
 * outcome for the document: this fence knows only that the row moved, never whether anything posted.
 *
 * Runs whatever client it is given — pass a transaction client to commit the decision atomically
 * with whatever else it records (audit rows, order state).
 */
export async function applyFencedAttemptDecision(
  client: Pick<Prisma.TransactionClient, 'accountingSyncLog'>,
  params: {
    id: string
    expectedAttemptRevision: number
    expectedStatus: AccountingSyncStatus
    /** The decision itself. `attemptRevision` is set by the fence and must not be passed. */
    data: Omit<Prisma.AccountingSyncLogUpdateManyMutationInput, 'attemptRevision'>
    /**
     * ADOPT a row that has never been fence-claimed, instead of refusing it (o3d-nf9i r3).
     *
     * Default false, and that default is the safe one: revision 0 means no attempt has ever been
     * identified, so a compare-and-swap on (id, status) is the exact defect this module exists to
     * remove — every path returns a row to a status it already held, so the decision can land on a
     * LATER attempt than the one that was judged.
     *
     * It is sound in TWO cases, and the caller must have established one of them. Both exist because
     * without a door the per-row remedy does not exist for the very population it was built for, and a
     * refusal that names a claim which is never coming is a refusal with no remedy.
     *
     *  1. NOTHING THAT PARTICIPATES IN THE FENCE CAN EVER CLAIM THIS ROW — a row on a connector that
     *     is not the active one, which no processor and no retry path touches (o3d-nf9i r3;
     *     app/actions/accounting-settlement.ts). Such a row has exactly one attempt, ever, so there is
     *     no later attempt for the decision to land on.
     *
     *  2. THE REVISION ITSELF IS THE FENCE (o3d-psvi r2; app/actions/accounting-sync.ts). Revision 0
     *     is not merely "unidentified": `nextAttemptRevision` is the only writer and it only ever
     *     ADDS, so a row that is still at 0 when the swap evaluates is a row nothing has claimed in
     *     the meantime. `(id, expectedStatus, revision 0)` is then STRICTLY STRONGER than the
     *     `(id, expectedStatus)` identity check adoption is accused of degrading to: it refuses
     *     everything that would refuse, plus every row that has since been claimed. What the caller
     *     must establish for this reading is that its DECISION does not rest on anything the revision
     *     would have to testify about — i.e. that it re-reads the row's shape inside the transaction
     *     that writes, rather than trusting a snapshot taken outside it.
     *
     * The adoption is still a CAS — (id, revision 0, expectedStatus) — so a second operator, or a
     * sweep that moves the status first, loses and is told which. It bumps to 1 exactly as a
     * processor's first claim would, so a connector that is later re-activated finds a fenced row
     * rather than an unfenced one.
     */
    adoptUnfencedAttempt?: boolean
  },
): Promise<AttemptDecisionOutcome> {
  if (params.expectedAttemptRevision === UNCLAIMED_ATTEMPT_REVISION && !params.adoptUnfencedAttempt) {
    return {
      ok: false,
      reason: 'UNFENCED_ATTEMPT',
      message: unfencedAttemptMessage(params.id, params.expectedStatus),
    }
  }

  const nextRevision = nextAttemptRevision(params.expectedAttemptRevision)
  // Canonical lock order (order row, then sync row) for a decision on a sales invoice row; a no-op when the caller already holds the order lock.
  await lockOrdersOfInvoiceRows(client, { id: params.id })
  const applied = await client.accountingSyncLog.updateMany({
    where: {
      id: params.id,
      attemptRevision: params.expectedAttemptRevision,
      status: params.expectedStatus,
    },
    data: { ...params.data, attemptRevision: nextRevision },
  })
  if (applied.count > 0) {
    // Every operator decision on a row lands here, and one of them can settle a sales invoice posted or not posted: the order follows it.
    await recomputeInvoicingStateForSyncLogs(client, { id: params.id })
    return { ok: true, attemptRevision: nextRevision }
  }

  // Lost — read the row purely to say WHAT moved. The CAS above, not this read, decided the
  // outcome, so a further change between the two only makes the explanation slightly stale; it
  // cannot let a decision land on the wrong attempt.
  const current = await client.accountingSyncLog.findUnique({
    where: { id: params.id },
    select: { attemptRevision: true, status: true },
  })
  if (!current) {
    return {
      ok: false,
      reason: 'ROW_MISSING',
      message: `Accounting sync row ${params.id} no longer exists, so the decision was not recorded. `
        + 'Reload the sync log; if the row is gone, nothing on it can be settled.',
    }
  }
  // A row still at 0 after an ADOPTION lost its CAS did not lose it on the revision — the revision
  // is what the adoption expected. Reporting UNFENCED_ATTEMPT there would tell the operator the row
  // can never be settled, when in truth its STATUS moved and their remedy is to reload and look.
  if (current.attemptRevision === UNCLAIMED_ATTEMPT_REVISION && !params.adoptUnfencedAttempt) {
    return { ok: false, reason: 'UNFENCED_ATTEMPT', message: unfencedAttemptMessage(params.id, current.status) }
  }
  if (current.attemptRevision !== params.expectedAttemptRevision) {
    return {
      ok: false,
      reason: 'ATTEMPT_MOVED',
      message: `Accounting sync row ${params.id} has moved on to attempt ${current.attemptRevision}; the decision was `
        + `made about attempt ${params.expectedAttemptRevision}, so it was NOT recorded. Reload the sync log and judge `
        + 'the attempt shown there.',
    }
  }
  return {
    ok: false,
    reason: 'STATUS_MOVED',
    message: `Accounting sync row ${params.id} is now ${current.status}; the decision was made about a `
      + `${params.expectedStatus} row on the same attempt ${params.expectedAttemptRevision}, so it was NOT recorded. `
      + 'Reload the sync log and judge what it shows.',
  }
}

function unfencedAttemptMessage(id: string, status: AccountingSyncStatus | string): string {
  return `Accounting sync row ${id} (${status}) carries no attempt revision, so a decision cannot be tied to the `
    + 'attempt it was made about and was NOT recorded. Rows predating the attempt fence, and rows belonging to a '
    + 'connector whose processor does not stamp one, stay at revision 0 permanently. Reload the sync log: if it '
    + 'still shows no attempt, this row cannot be settled per-attempt.'
}
