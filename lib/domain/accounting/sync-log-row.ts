import type { Prisma } from '@/app/generated/prisma/client'
import { accountingPostingKeyForRow } from '@/lib/accounting/posting-key'
import { withSavepoint } from '@/lib/db/savepoint'
import { HELD_SHADOW_SETTLEMENT_BASIS } from '@/lib/domain/accounting/sync-row-settlement'
import { xeroProducerSeamVerdict, type XeroSeamVerdict } from '@/lib/domain/accounting/xero-producer-seam'
import { attachShadowSyncLog, recordOutboundShadow } from '@/lib/domain/outbound-shadow/record'
import { clearAccountingPostingRefusal, type PostingRefusalClient } from '@/lib/domain/accounting/posting-refusal-inbox'
import {
  HandPostDeferralUnrecordableError,
  lockPostingKey,
  readPostingSuppression,
  recordHandPostDeferral,
  reportSuppressedPosting,
  type PostingSuppressionClient,
} from '@/lib/domain/accounting/posting-suppression'

/**
 * o3d-j625 r6 (review H3) — THE ONE PLACE AN ACCOUNTING SYNC ROW IS CREATED, AND THEREFORE THE ONE PLACE A
 * REFUSED POSTING IS CLEARED.
 *
 * r5 cleared an outstanding refusal from the two facade enqueues only. Rows are also written by the
 * connector queues, the daily batches and — the finding — the follow-up enqueues in both sync processors.
 * The supplier-credit-note allocation sweep recorded a refusal "keyed exactly as the allocation's own
 * enqueue", and that enqueue is `enqueueFollowUpSyncLog`, which never cleared anything: a row that could
 * not clear, under inbox copy saying it would.
 *
 * So the clear moved to the write. Every `accountingSyncLog.create` in app/ and lib/ goes through this
 * function (tests/accounting/sync-log-row-primitive.test.ts fails on one that does not), and this function
 * clears the refusal whose key the new row carries — derived from the row's own fields by
 * `accountingPostingKeyForRow`, which equals the key the enqueue's params produce. Whatever path queues a
 * posting, its outstanding row clears, and a row that is unclearable by construction cannot recur.
 *
 * IN THE SAME CLIENT, UNDER A SAVEPOINT. The clear commits or rolls back with the row it is about (a clear
 * that survived a rolled-back create would mark the debt paid over a posting never written), and a failure
 * in it cannot abort the caller's transaction (25P02) — see posting-refusal-inbox.ts. On an autocommit
 * client the savepoint helper simply runs the statement.
 */
export type SyncLogRowClient = {
  accountingSyncLog: { create(args: { data: Prisma.AccountingSyncLogUncheckedCreateInput }): Promise<{ id: string }> }
}

/**
 * ── o3d-j625 r18 (Codex round 17, HIGH 1) — THE ANSWER IS NO LONGER `T | null` ──
 *
 * r7 returned `null` for "marked handled — posted by hand", and r16 made the SAME `null` also mean "an
 * operator is posting it by hand right now", on the argument that the answer this function has to give is
 * identical: write nothing. Round 17 showed what that costs one level up. The four callers turn this answer
 * into an enqueue OUTCOME, and for a completed hand posting the right outcome is `{ queued: true }` — a
 * counterpart exists, stop retrying — while for a live claim it is the opposite: nothing exists, the posting
 * is still owed, and on a REUSED posting key the thing being postponed may be a DIFFERENT, LATER edit. One
 * `null` could not carry both, so every caller answered `handled-by-hand` and the later edit was lost with no
 * sync row, no refusal and no debt.
 *
 * So the two are told apart HERE, in a shape no caller can read as the row: `{ row, suppressed }`. A `if
 * (!created)` on the old return would have compiled and silently become always-false; this does not compile
 * at all until each site says what it means to do, which is the point of changing the shape rather than
 * adding a field.
 *
 *   { row, suppressed: null }                 written.
 *   { row: null, suppressed: 'handled_by_hand' }  a human already put it in the ledger. Nothing is owed.
 *   { row: null, suppressed: 'hand_post_claim' }  a human is in the ledger NOW. Still owed, and POSTPONED:
 *                                                 the postponement is recorded on the refusal row before
 *                                                 this returns, so the act that ends the claim can discharge
 *                                                 it. See recordHandPostDeferral.
 *
 * THROWS `PostingSuppressionUnreadableError` when whether it was marked handled cannot be READ (o3d-j625
 * r8), and `HandPostDeferralUnrecordableError` when a postponement cannot be RECORDED (r18). Both are a
 * third answer rather than a `row: null`: nothing is written, nothing is asserted, and the caller may retry.
 */
export type CreateAccountingSyncLogRowResult<T> =
  | { row: T; suppressed: null; shadowed?: undefined }
  | { row: null; suppressed: 'handled_by_hand' | 'hand_post_claim'; shadowed?: undefined }
  /**
   * THE PRODUCER-SIDE HOLD SAID SHADOW (lib/security/producer-disposition.ts): the posting is recorded as a shadow and
   * NOTHING IS QUEUED. `shadowed` is the CANCELLED shadow row that carries it (an existing one when the same work was
   * produced before). `row` is null on purpose: a caller that goes on to schedule an outbox job or mirror an event for
   * `row` does not compile, and every caller must say what a shadow means to it. A shadow has no outbox job, no
   * accounting event and no live claim on the posting.
   */
  | { row: null; suppressed: null; shadowed: T }

export async function createAccountingSyncLogRow<T extends { id: string }>(
  client: SyncLogRowClient,
  data: Prisma.AccountingSyncLogUncheckedCreateInput,
  options?: {
    /**
     * Wrap the INSERT itself in a savepoint — for a caller that expects a unique-index collision and handles
     * it (the in-transaction enqueue does). The clear always runs in its own.
     */
    createInSavepoint?: boolean
  },
): Promise<CreateAccountingSyncLogRowResult<T>> {
  const key = accountingPostingKeyForRow({
    type: String(data.type),
    referenceType: data.referenceType,
    referenceId: data.referenceId,
    payload: data.payload,
  })
  // o3d-j625 r7: the mark-handled suppression, read under the same per-key lock the mark takes.
  //
  // o3d-j625 r8 (Codex HIGH): and a read that CANNOT be made throws out of here, before the create —
  // deliberately not caught. r7 let an unreadable suppression mean "not suppressed", so a lookup that
  // failed after the posting was marked handled wrote a PENDING row for it and the connector posted it a
  // second time. The caller's transaction rolls back and the operation is retried; see the reasoning in
  // posting-suppression.ts, including why refusing just this enqueue was the worse of the two answers.
  await lockPostingKey(client as unknown as PostingSuppressionClient, key)
  const suppression = await readPostingSuppression(client as unknown as PostingSuppressionClient, key)
  if (suppression.suppressed) {
    /**
     * o3d-j625 r18 — A LIVE CLAIM IS RECORDED AS A POSTPONEMENT BEFORE THIS RETURNS, OR NOTHING IS RETURNED.
     *
     * The read above happened under this key's advisory lock, and so does this write, so `'no-claim'` here
     * means the claim was given back between them by a transaction that could not have been serialised with
     * this one (a client that cannot take the lock: a structural test double). The honest response is to
     * PROCEED — there is no claim, so there is nothing to postpone and the row should be written — never to
     * postpone against a claim nobody holds. `'unrecordable'` throws: an unrecorded postponement is
     * indistinguishable from the lost edit this round is about.
     */
    if (suppression.basis === 'hand_post_claim') {
      const recorded = await recordHandPostDeferral(client as unknown as PostingSuppressionClient, key, new Date())
      if (recorded === 'unrecordable') throw new HandPostDeferralUnrecordableError(key)
      if (recorded === 'recorded') {
        await reportSuppressedPosting(key, suppression)
        return { row: null, suppressed: 'hand_post_claim' }
      }
    } else {
      await reportSuppressedPosting(key, suppression)
      return { row: null, suppressed: 'handled_by_hand' }
    }
  }
  // THE PRODUCER SEAM. After the suppression read on purpose: a posting marked handled by hand, or held by an operator's
  // claim, is answered above whatever the hold says, so a shadow can never discharge or postpone a claim.
  const verdict = xeroProducerSeamVerdict({ connector: String(data.connector), type: String(data.type), payload: data.payload })
  let rowData = data
  let shadow: PreparedShadow | null = null
  if (verdict.kind === 'shadow') {
    const prepared = await prepareShadow(client, data, verdict)
    // The same work was shadowed before and its row still stands: count the repeat, write nothing.
    if (prepared.existingSyncLogId) return { row: null, suppressed: null, shadowed: { id: prepared.existingSyncLogId } as T }
    shadow = prepared
    rowData = prepared.data
  }
  // THE ONE INSERT of an accounting sync row (tests/accounting/sync-log-row-primitive.test.ts holds this file to exactly one):
  // a live row, or the shadow row prepared above.
  const create = () => client.accountingSyncLog.create({ data: rowData }) as Promise<T>
  const row = options?.createInSavepoint ? await withSavepoint(client, create) : await create()
  if (shadow) {
    await linkShadow(client, shadow.recordId, row.id)
    // A shadow discharges no refusal: it is not a posting, and an outstanding refusal still describes a debt IMS has not paid.
    return { row: null, suppressed: null, shadowed: row }
  }
  await clearAccountingPostingRefusal(
    client as unknown as PostingRefusalClient,
    key,
    { withSavepoint: <R,>(fn: () => Promise<R>) => withSavepoint(client, fn) },
  )
  return { row, suppressed: null }
}

type PreparedShadow = {
  /** The CANCELLED / HELD_SHADOW row to INSERT in place of the live one. */
  data: Prisma.AccountingSyncLogUncheckedCreateInput
  /** The `outbound_shadow_writes` row counting this work, or null when recording it failed. */
  recordId: string | null
  existingSyncLogId: string | null
}

/**
 * The shadow of a posting IMS would have queued: a CANCELLED row, basis HELD_SHADOW, no document id, created in
 * stamping custody with no remote attempt (so it reads SHADOW_NOT_SENT_BY_IMS, ledger-standing.ts row 5a: not sent by IMS, and NOT proof of absence), carrying
 * the single-sourced operator sentence as its error message; plus the `outbound_shadow_writes` row that counts repeats.
 *
 * REPEATS DO NOT MAKE ROWS. The shadow table's unique key (destination, operation, subject, payload digest) decides:
 * the same work produced again, which the recreate sweeps and a retried action do every tick while the hold is on,
 * counts an occurrence and names the sync-log row that already carries it. If that row has been deleted by
 * retention, a new one is written and the shadow points at it.
 *
 * A shadow write that FAILS is lost evidence, never lost work: it is rolled back to its savepoint and the sync-log row
 * (the durable shadow) is still written, so the caller's transaction is never aborted by the record-keeping. The only
 * thing lost is the dedupe for that one call.
 */
async function prepareShadow(
  client: SyncLogRowClient,
  data: Prisma.AccountingSyncLogUncheckedCreateInput,
  verdict: Extract<XeroSeamVerdict, { kind: 'shadow' }>,
): Promise<PreparedShadow> {
  let recorded: Awaited<ReturnType<typeof recordOutboundShadow>> | null = null
  try {
    recorded = await withSavepoint(client, () => recordOutboundShadow(client, {
      destination: verdict.destination,
      operation: verdict.operation,
      subjectType: String(data.referenceType),
      subjectId: String(data.referenceId),
      payload: { type: String(data.type), payload: data.payload },
      summary: { type: String(data.type), connector: String(data.connector) },
      decision: verdict.decision,
    }))
  } catch (error) {
    console.error(`[producer-hold] could not record the shadow of ${String(data.type)} ${String(data.referenceType)} ${String(data.referenceId)}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return {
    data: {
      ...data,
      status: 'CANCELLED',
      settlementBasis: HELD_SHADOW_SETTLEMENT_BASIS,
      abandonedBeforeRemoteCall: true,
      externalTransactionId: null,
      errorMessage: verdict.notice,
    },
    recordId: recorded?.id ?? null,
    existingSyncLogId: recorded?.accountingSyncLogId ?? null,
  }
}

async function linkShadow(client: SyncLogRowClient, recordId: string | null, syncLogId: string): Promise<void> {
  if (recordId === null) return
  try {
    await withSavepoint(client, () => attachShadowSyncLog(client, recordId, syncLogId))
  } catch (error) {
    console.error(`[producer-hold] could not link shadow ${recordId} to sync row ${syncLogId}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
