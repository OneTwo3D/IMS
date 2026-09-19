import type { Prisma } from '@/app/generated/prisma/client'
import { accountingPostingKeyForRow } from '@/lib/accounting/posting-key'
import { SOURCE_CANCELLED_VOID_BASIS } from '@/lib/domain/accounting/accounting-event-void-basis'
import { updateMirroredAccountingEventStatus } from '@/lib/domain/accounting/accounting-event-mirror'
import { POSTING_REFUSAL_KINDS, postingRefusalMarkable, type PostingRefusalKind } from '@/lib/domain/accounting/posting-refusal-kinds'
import { lockPostingKey, type PostingSuppressionClient } from '@/lib/domain/accounting/posting-suppression'
import { UNCLAIMED_ATTEMPT_REVISION } from '@/lib/domain/accounting/sync-log-attempt'
import { settlementMirrorGuard } from '@/lib/domain/accounting/sync-row-settlement'

/**
 * o3d-j625 r7 (owner decision 2026-09-19, "Handled + stop retry") — MARK A REFUSED POSTING HANDLED, AND
 * MAKE SURE IMS NEVER POSTS IT.
 *
 * "Handled" is the operator's assertion that they posted THIS posting BY HAND in the ledger. For a posting
 * IMS also retries (the `retried` kinds, posting-refusal-kinds.ts), that assertion is only safe if IMS then
 * never posts it itself — otherwise the ledger gets it twice. So, in ONE transaction, under the per-key
 * lock every row-creating path also takes (posting-suppression.ts):
 *
 *   1. REFUSE if IMS may ALREADY have posted it, or may be posting it now: any sync row for this exact
 *      posting key that is PROCESSING, SYNCED, FAILED (sent or not is unknowable in general), carries an
 *      external id, or is PENDING but has been claimed by a processor before (it may have been sent and
 *      put back for a retry). Those are settled in the accounting sync log first — the mark cannot know
 *      whether the ledger already has the posting, and guessing is how it would be posted twice.
 *   2. CANCEL every remaining row for the key: PENDING and never claimed (revision 0, no external id),
 *      i.e. provably never sent. Conditional on exactly that, so a processor claiming one between the read
 *      and the write makes the mark refuse rather than cancel a row in flight. Their mirrored accounting
 *      events are voided as SOURCE-CANCELLED (never revivable) under the settlement guard.
 *   3. RESOLVE the refusal row as `handled_manually`, recording who and the note, and set `suppressedAt`,
 *      which the primitive reads from then on. Conditional on the row still being outstanding and of a
 *      markable kind, so two submits resolve it once.
 *
 * REOPENING: a posting marked handled stays handled. A later refusal of the same key is reported and not
 * recorded (recordAccountingPostingRefusal), and every later automatic enqueue of it is refused as already
 * handled by hand, so there is no second debt to reopen.
 */
export type MarkHandledClient = PostingSuppressionClient & {
  accountingPostingRefusal: {
    findUnique(args: { where: { id: string }; select: Record<string, true> }): Promise<{
      id: string; type: string; referenceType: string; referenceId: string; scope: string
      kind: string | null; resolvedAt: Date | null
    } | null>
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>
  }
  accountingSyncLog: {
    findMany(args: { where: Record<string, unknown>; select: Record<string, true> }): Promise<Array<{
      id: string; connector: string; status: string; attemptRevision: number | null
      externalTransactionId: string | null; payload: unknown
    }>>
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>
  }
}

export type MarkHandledResult =
  | { ok: true; cancelledSyncRows: string[]; kind: PostingRefusalKind }
  | { ok: false; code: 'not_found' | 'already_resolved' | 'not_markable' | 'may_be_posted'; message: string }

/**
 * THROWN (not returned) when the state moved under the mark after it had started writing — so the caller's
 * transaction ROLLS BACK and no row is left half-cancelled. Every other refusal happens before any write
 * and is returned.
 */
export class MarkHandledRaceError extends Error {
  constructor() {
    super('This posting changed while it was being marked (it was resolved, or IMS picked it up). Refresh and look again.')
    this.name = 'MarkHandledRaceError'
  }
}

export async function markPostingHandled(
  tx: MarkHandledClient,
  params: { id: string; userId: string; note: string | null; now?: Date },
): Promise<MarkHandledResult> {
  const now = params.now ?? new Date()
  const row = await tx.accountingPostingRefusal.findUnique({
    where: { id: params.id },
    select: { id: true, type: true, referenceType: true, referenceId: true, scope: true, kind: true, resolvedAt: true },
  })
  if (!row) return { ok: false, code: 'not_found', message: 'This refused posting no longer exists.' }
  if (row.resolvedAt) return { ok: false, code: 'already_resolved', message: 'This refused posting is already resolved.' }
  if (!postingRefusalMarkable(row.kind)) {
    return {
      ok: false,
      code: 'not_markable',
      message: row.kind && row.kind in POSTING_REFUSAL_KINDS
        ? `IMS clears this row itself when the posting is queued, so it cannot be marked handled. ${POSTING_REFUSAL_KINDS[row.kind as PostingRefusalKind].how}`
        : 'This row does not say which kind of refusal it is, so it cannot be marked handled.',
    }
  }
  const key = { type: row.type, referenceType: row.referenceType, referenceId: row.referenceId, scope: row.scope }
  await lockPostingKey(tx, key)

  const candidates = (await tx.accountingSyncLog.findMany({
    where: { type: key.type, referenceType: key.referenceType, referenceId: key.referenceId, status: { not: 'CANCELLED' } },
    select: { id: true, connector: true, status: true, attemptRevision: true, externalTransactionId: true, payload: true },
  })).filter((sync) => accountingPostingKeyForRow({ ...key, payload: sync.payload }).scope === key.scope)

  const provablyUnsent = (sync: (typeof candidates)[number]) =>
    sync.status === 'PENDING' && sync.attemptRevision === UNCLAIMED_ATTEMPT_REVISION && !sync.externalTransactionId
  const blocking = candidates.filter((sync) => !provablyUnsent(sync))
  if (blocking.length > 0) {
    return {
      ok: false,
      code: 'may_be_posted',
      message:
        'IMS may already have posted this, or be posting it now — accounting sync '
        + `${blocking.map((sync) => `row ${sync.id} is ${sync.status}${sync.externalTransactionId ? ` with document ${sync.externalTransactionId}` : ''}`).join('; ')}. `
        + 'Check the ledger and settle that row in the accounting sync log first; marking this handled now could '
        + 'post it twice.',
    }
  }

  const cancelIds = candidates.map((sync) => sync.id)
  const note = `Cancelled: marked handled — posted by hand${params.note ? ` (${params.note})` : ''}.`
  if (cancelIds.length > 0) {
    const cancelled = await tx.accountingSyncLog.updateMany({
      where: { id: { in: cancelIds }, status: 'PENDING', attemptRevision: UNCLAIMED_ATTEMPT_REVISION, externalTransactionId: null },
      data: { status: 'CANCELLED', errorMessage: note, processingStartedAt: null },
    })
    if (cancelled.count !== cancelIds.length) throw new MarkHandledRaceError()
    for (const sync of candidates) {
      const mirror = await updateMirroredAccountingEventStatus(tx as unknown as Prisma.TransactionClient, {
        connector: sync.connector,
        syncLogId: sync.id,
        type: key.type,
        referenceType: key.referenceType,
        referenceId: key.referenceId,
        payload: sync.payload,
        status: 'VOID',
        voidBasis: SOURCE_CANCELLED_VOID_BASIS,
        message: note,
        guard: settlementMirrorGuard(),
      })
      if (mirror === 'refused') throw new MarkHandledRaceError()
    }
  }
  const markableKinds = (Object.keys(POSTING_REFUSAL_KINDS) as PostingRefusalKind[]).filter((kind) => postingRefusalMarkable(kind))
  const resolved = await tx.accountingPostingRefusal.updateMany({
    where: { id: row.id, resolvedAt: null, kind: { in: markableKinds } },
    data: {
      resolvedAt: now,
      resolution: 'handled_manually',
      resolvedBy: params.userId,
      resolutionNote: params.note,
      suppressedAt: now,
    },
  })
  if (resolved.count === 0) throw new MarkHandledRaceError()
  return { ok: true, cancelledSyncRows: cancelIds, kind: row.kind as PostingRefusalKind }
}
