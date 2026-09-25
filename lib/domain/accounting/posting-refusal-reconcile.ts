import {
  DEFAULT_INTEGRATION_OUTBOX_MAX_ATTEMPTS,
  claimIntegrationOutboxWork,
  markIntegrationOutboxRetryableFailure,
  markIntegrationOutboxSuccess,
  type IntegrationOutboxRow,
} from '@/lib/domain/integrations/outbox'
import { AccountingPostingRefusalProvisionalPayloadSchema } from '@/lib/domain/integrations/outbox-registry'
import {
  PROVISIONAL_POSTING_REFUSAL_CONNECTOR,
  PROVISIONAL_POSTING_REFUSAL_OPERATION,
  PROVISIONAL_POSTING_REFUSAL_WORKER,
  provisionalPayloadToRecord,
} from '@/lib/domain/accounting/posting-refusal-provisional'
import {
  recordAccountingPostingRefusal,
  type PostingRefusalClient,
  type RefusalRecordOutcome,
} from '@/lib/domain/accounting/posting-refusal-inbox'

/**
 * o3d-j625 r10 (Codex round 9, HIGH) — WHO RECONCILES A PROVISIONAL REFUSAL, AND WHAT IT IS ALLOWED TO DO
 * THAT THE CALLER WAS NOT.
 *
 * One thing, and it is the whole point: THIS RUNS FROM THE POOL, so it may WAIT for the posting key's
 * lock. The refusal is replayed exactly as it was decided — same key, same record, same `decidedAt`, same
 * merge shape — and `recordAccountingPostingRefusal` then answers the questions the in-transaction call
 * could not: under the key, is this posting suppressed (someone posted it by hand), was it queued while
 * this refusal was in flight, or is it genuinely still owed?
 *
 * `queuedWhenShutOut` is the one piece of knowledge the claim carries forward, and since r11 it is a
 * BASELINE rather than a flag. The original refusal lost a race with a transaction that was settling this
 * exact posting; by the time this replay runs that transaction has ended and the key is free, so the
 * replay cannot see the race it is recovering from. What it can see is a sync row that was NOT there when
 * the original call was refused the key — which is that transaction's own evidence that it committed.
 *
 * r10 carried a boolean (`contendedWhenDecided`) and let any live row for the key stand for the holder's
 * enqueue. Codex executed the consequence: successive edits of one invoice share a posting key, so edit
 * 1's row — live for ever — settled a claim whose holder had ROLLED BACK, and the owed posting reached
 * nothing. A pre-existing row can no longer satisfy the claim, because the claim knows which rows already
 * existed.
 *
 * SO THE TWO OUTCOMES CODEX ASKED ABOUT ARE BOTH REACHED HERE:
 *   • the lock holder QUEUED the posting → a live sync row whose id was NOT in the claim's baseline →
 *     nothing is recorded, an INFO entry says the posting was queued while the refusal was being decided,
 *     and the claim SUCCEEDS.
 *   • the lock holder ROLLED BACK (or never queued, or was marking rather than queueing) → every live row
 *     is one the baseline already knew about → the refusal is RECORDED and the posting is outstanding in
 *     the exception inbox, which is what r9 lost and what r10 gave back to any posting type whose
 *     successive edits share a key.
 *
 * FAILURE IS NEVER SUCCESS. The replay RETURNS its outcome rather than throwing on a write that did not
 * land (`recordAccountingPostingRefusal` reports and contains its own failures, review L-1 / M-14), so a
 * claim is only completed on an outcome that is terminal: recorded, suppressed, or queued. Anything else
 * — a write that failed, a lock this drain could not take within its timeout — is a retryable failure with
 * the outbox's own backoff, and exhausts to `PERMANENT_FAILED`, which the exception inbox lists.
 */

export type ReconcileProvisionalPostingRefusalsResult = {
  claimed: number
  /** Replays that ended in a refusal row being written — the debt this round exists to keep. */
  recorded: number
  /** Replays that found the posting settled after all (queued concurrently, or posted by hand). */
  settled: number
  failed: number
}

export type ProvisionalRefusalReconcileDeps = {
  claimWork: typeof claimIntegrationOutboxWork
  record: (
    client: PostingRefusalClient,
    key: Parameters<typeof recordAccountingPostingRefusal>[1],
    record: Parameters<typeof recordAccountingPostingRefusal>[2],
    options: Parameters<typeof recordAccountingPostingRefusal>[3],
  ) => Promise<RefusalRecordOutcome>
  markSuccess: (options: Parameters<typeof markIntegrationOutboxSuccess>[0]) => Promise<unknown>
  markRetry: (options: Parameters<typeof markIntegrationOutboxRetryableFailure>[0]) => Promise<unknown>
  /** The POOLED client the replay records through — never a caller's transaction. */
  postingRefusalClient: () => Promise<PostingRefusalClient>
}

const defaultDeps = (): ProvisionalRefusalReconcileDeps => ({
  claimWork: claimIntegrationOutboxWork,
  record: recordAccountingPostingRefusal,
  markSuccess: markIntegrationOutboxSuccess,
  markRetry: markIntegrationOutboxRetryableFailure,
  postingRefusalClient: async () => (await import('@/lib/db')).db as unknown as PostingRefusalClient,
})

export async function reconcileProvisionalPostingRefusals(
  deps: ProvisionalRefusalReconcileDeps = defaultDeps(),
  limit = 50,
): Promise<ReconcileProvisionalPostingRefusalsResult> {
  const claims = await deps.claimWork({
    connector: PROVISIONAL_POSTING_REFUSAL_CONNECTOR,
    operation: PROVISIONAL_POSTING_REFUSAL_OPERATION,
    workerId: PROVISIONAL_POSTING_REFUSAL_WORKER,
    limit,
    maxAttempts: DEFAULT_INTEGRATION_OUTBOX_MAX_ATTEMPTS,
  })
  const result: ReconcileProvisionalPostingRefusalsResult = { claimed: claims.length, recorded: 0, settled: 0, failed: 0 }
  for (const claim of claims) await reconcileOne(claim, deps, result)
  return result
}

async function reconcileOne(
  claim: IntegrationOutboxRow,
  deps: ProvisionalRefusalReconcileDeps,
  result: ReconcileProvisionalPostingRefusalsResult,
): Promise<void> {
  // A claim with no lock stamp was not really claimed; completing it would fence nothing.
  if (!claim.lockedAt) { result.failed++; return }
  try {
    const payload = AccountingPostingRefusalProvisionalPayloadSchema.parse(claim.payloadJson)
    const client = await deps.postingRefusalClient()
    const outcome = await deps.record(
      client,
      payload.key,
      provisionalPayloadToRecord(payload),
      {
        // THE MOMENT THE REFUSAL WAS DECIDED, carried from the claim. Replacing it with "now" would make
        // every staleness comparison in the replay true and swallow the debt this claim exists to keep.
        decidedAt: new Date(payload.decidedAt),
        mergeOnly: payload.mergeOnly,
        // No `withSavepoint`: this is the POOL. That is also what tells `runUnderPostingKeyLock` it may
        // open its own transaction and WAIT for the key.
        //
        // The baseline, verbatim. `undefined` on a claim written before r11 — and then the key is
        // PASSED ANYWAY as undefined, which leaves the replay with the decision-time comparison alone:
        // the direction that keeps a debt. Never rewritten to "nothing was queued", which would let any
        // live row discharge it — r10's finding exactly.
        queuedWhenShutOut: payload.queuedWhenShutOut,
      },
    )
    if (outcome.recorded) result.recorded++
    else if (outcome.because === 'suppressed' || outcome.because === 'queued') result.settled++
    else {
      // 'contended' cannot happen from the pool (it waits); 'failed' is a write that did not land. Either
      // way the obligation is NOT discharged, so the claim must not be completed.
      throw new Error(
        `the provisional refusal for ${payload.key.type} ${payload.key.referenceType} ${payload.key.referenceId} `
        + `was not reconciled (${outcome.because}); it is still owed and will be retried`,
      )
    }
    await deps.markSuccess({ id: claim.id, workerId: PROVISIONAL_POSTING_REFUSAL_WORKER, lockedAt: claim.lockedAt })
  } catch (error) {
    await deps.markRetry({
      id: claim.id,
      workerId: PROVISIONAL_POSTING_REFUSAL_WORKER,
      lockedAt: claim.lockedAt,
      error,
      attemptsBeforeFailure: claim.attempts,
      maxAttempts: DEFAULT_INTEGRATION_OUTBOX_MAX_ATTEMPTS,
    })
    result.failed++
  }
}
