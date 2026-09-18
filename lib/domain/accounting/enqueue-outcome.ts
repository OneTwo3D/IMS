import type { ActivityEntityType } from '@/app/generated/prisma/client'
import { logActivity } from '@/lib/activity-log'
import { recordAccountingPostingRefusal, type PostingRefusalClient } from '@/lib/domain/accounting/posting-refusal-inbox'
import type { PostingRefusalKind } from '@/lib/domain/accounting/posting-refusal-kinds'

/**
 * o3d-j625 r3 (Codex HIGH 1, MEDIUM) — A REFUSAL ON A PATH THAT DISCARDS THE RESULT IS A SILENT
 * NON-POSTING.
 *
 * r2 gave the enqueues a way to say `refused` — "this particular call declined and the posting is
 * still owed" — and then left the result on the floor at most of the sites that can now receive it. A
 * census of the 26 production enqueue call sites found 13 that discarded the return value entirely and
 * 10 more that read only its truthiness, and the consequences are not uniformly harmless:
 *
 *   lib/cost-layers.ts        recorded the COGS SUBLEDGER movement and returned `true`, so its caller
 *                             removed the delta from the compensating landed-cost COGS journal. THE GL
 *                             RECEIVED NEITHER POSTING WHILE THE SUBLEDGER CLAIMED IT DID. That is the
 *                             worst outcome in the issue: the two ledgers disagree and nothing says so.
 *   accounting-fx-revaluation `reversed += 1` / `revalued += 1` after a refusal, so the run reported a
 *                             reversal that never happened and a later run's "already revalued" read
 *                             agreed with it.
 *   everything else           committed a receipt / return / bill / cancellation / manufacturing order
 *                             and reported `{ success: true }` with nothing queued and no warning.
 *
 * WHAT "HANDLING IT" MEANS HERE, and it is deliberately NOT "roll everything back". A retired chart
 * must not be able to stop a warehouse receiving stock or an operator saving a bill edit — that trades a
 * silent non-posting for a denial of service on the core workflow, which is a worse failure and a
 * harder one to notice. So the rule applied across the sweep is:
 *
 *   1. NEVER report success, settle an obligation, increment a count, or remove a delta from a
 *      compensating journal on an enqueue that did not queue. Where a local write's only purpose was to
 *      mirror the GL posting (a subledger row), it does not happen either.
 *   2. Where the local state claimed by the same transaction would be a LIE without the posting —
 *      a bill marked PAID, a credit note marked POSTED — roll back. Those sites already do.
 *   3. Otherwise keep the local state and REPORT, at ERROR, naming what stands in IMS, what the ledger
 *      does not have, and what a human has to do. That is what this module is for.
 *
 * THE SHAPE OF THE REPORT IS SHARED so the 13 sites cannot drift into 13 different half-descriptions of
 * the same condition, which is how the `refused`/`not-configured` distinction ended up invisible at
 * every site that had its own wording.
 */

/**
 * The part of an enqueue outcome this module reads. Structural on purpose: both
 * `AccountingEnqueueOutcome` (the facade and the `WithOutcome` adapter) and a hand-built
 * `{ queued }` from the boolean in-transaction enqueue satisfy it, so a site that has only the boolean
 * can still report correctly instead of being excused for having less information.
 */
export type EnqueueOutcomeLike = {
  queued: boolean
  reason?: 'not-configured' | 'refused' | 'already-queued'
  connector?: string | null
  /**
   * o3d-j625 r5 (review HIGH 1/2/3) — THE POSTING KEY, FROM THE ENQUEUE'S OWN PARAMS.
   *
   * r4 had every reporting site hand-write this beside the enqueue, and three of fourteen disagreed with
   * what the CLEAR matches: one row could never clear, one shared a key with a different posting (so a
   * successful cancellation resolved a reversal that was never written), and payments were keyed per
   * document where the obligation is per receipt. The enqueue now reports the key it derived, so a
   * reporting site cannot key its row on anything else.
   */
  posting?: { type: string; referenceType: string; referenceId: string; scope: string }
  /** The active connector as the refusal saw it (review L-7), not as a later report re-reads it. */
  activeConnector?: string | null
  /** True when the enqueue already wrote the outstanding row — this report then MERGES (review M-5). */
  refusalRecorded?: boolean
}

/**
 * Is this posting STILL OWED?
 *
 * `queued: true`                 no — a sync row is durable (this call wrote it, or found one standing).
 * `queued: false, not-configured` no — there is no connector, or it does not post this type, so no GL
 *                                counterpart will ever exist and nothing is outstanding.
 * `queued: false, refused`       YES.
 * `queued: false`, no reason     YES, and that is the answer the boolean in-transaction enqueue gives.
 *                                A bare `false` cannot tell the two apart, so it is read the SAFE way:
 *                                treating an unknown as `not-configured` would settle an obligation on
 *                                a refusal, which is the exact mistake this module exists to stop. A
 *                                site that needs the distinction uses `queueAccountingSyncTxWithOutcome`.
 */
export function postingIsOwed(outcome: EnqueueOutcomeLike): boolean {
  if (outcome.queued) return false
  return outcome.reason !== 'not-configured'
}

/**
 * Report a posting that IMS owes the ledger and did not queue, next to the local state that stands
 * anyway.
 *
 * `committed` and `remedy` are REQUIRED, and that is the point of the function. An enqueue that
 * declined is only interesting because something else DID happen — the receipt is booked, the order is
 * complete, the delta is in a journal that is not going to be written — and a report that does not say
 * what stands is one an operator cannot act on. Making both mandatory means a new site cannot log a
 * bare "not queued" and consider the refusal handled.
 *
 * Never throws: it is the LAST thing a site does about a decline, and a failed audit write must not
 * turn a reported divergence into an unreported exception. It is `logActivity`, not
 * `logActivityPersisted`, deliberately — no caller here makes a decision on the strength of having
 * warned, so there is nothing for the stronger signal to change.
 */
export async function reportPostingNotQueued(params: {
  entityType: ActivityEntityType
  entityId?: string | null
  /** The activity-log action, e.g. `manufacturing_journal_not_queued`. */
  action: string
  /**
   * o3d-j625 r6 (review H4) — WHICH KIND OF SITE THIS IS (posting-refusal-kinds.ts). Required: it decides
   * whether the inbox row clears itself when the posting is queued or is closed by someone marking it handled.
   */
  kind: PostingRefusalKind
  /** The posting that is owed, as an operator would name it: "the COGS reversal for shipment X". */
  posting: string
  /** What IMS committed regardless, and therefore what the ledger now disagrees with. */
  committed: string
  /** What a human has to do. */
  remedy: string
  outcome: EnqueueOutcomeLike
  metadata?: Record<string, unknown>
  /**
   * o3d-j625 r6 (review M3) — THE CALLER'S TRANSACTION, for a site that reports from INSIDE one. The row is
   * then written through it (under a savepoint), so it rolls back with the change it is about: a batch
   * that later throws leaves no outstanding row for a stock movement that never existed. Omitted, the row
   * is written through the pool, which is right for a site that reports after its commit.
   */
  inTransaction?: { client: PostingRefusalClient; withSavepoint: <T>(fn: () => Promise<T>) => Promise<T> }
}): Promise<void> {
  await logActivity({
    entityType: params.entityType,
    entityId: params.entityId ?? null,
    action: params.action,
    tag: 'accounting',
    level: 'ERROR',
    description:
      `NOTHING WAS QUEUED for ${params.posting}, but ${params.committed}. The accounting connector was `
      + `not told, nothing retries this on its own, and the ledger and IMS now disagree. ${params.remedy}`,
    metadata: {
      ...params.metadata,
      enqueueQueued: params.outcome.queued,
      // `undefined` where the site only had the boolean — recorded as the absence it is rather than
      // guessed at, so a report cannot claim a reason the enqueue never gave.
      enqueueReason: params.outcome.reason ?? null,
      enqueueConnector: params.outcome.connector ?? null,
    },
  }).catch(() => { /* a report that cannot be written must not become the site's exception */ })
  // o3d-j625 r4: and the same thing, durably, where an operator will find it without going looking.
  //
  // o3d-j625 r5 — THE KEY IS THE ENQUEUE'S OWN (review HIGH 1/2/3). An outcome that carries no key came
  // from a double or from a path that never reached an enqueue; there is nothing honest to key a row on, so
  // none is written and the omission is reported rather than guessed at.
  const posting = params.outcome.posting
  if (!posting) {
    await logActivity({
      entityType: params.entityType,
      entityId: params.entityId ?? null,
      action: 'accounting_posting_refusal_not_recorded',
      tag: 'accounting',
      level: 'ERROR',
      description:
        `The ${params.posting} was not queued and could not be recorded as outstanding work: the enqueue `
        + 'reported no posting key, so the exception inbox will not list it.',
      metadata: { ...params.metadata },
    }).catch(() => { /* nothing else to try */ })
    return
  }
  const client = params.inTransaction?.client ?? (await import('@/lib/db')).db as unknown as PostingRefusalClient
  await recordAccountingPostingRefusal(
    client,
    posting,
    {
      kind: params.kind,
      chartConnector: (params.metadata?.chartConnector as string | undefined) ?? null,
      // review L-7: the connector the REFUSAL saw, where the enqueue reported it. A read taken now would be
      // a different moment's answer.
      activeConnector: params.outcome.activeConnector ?? await activeAccountingConnectorForReport(),
      reason: params.outcome.reason ?? 'refused',
      committed: params.committed,
      remedy: params.remedy,
      detail: { enqueueConnector: params.outcome.connector ?? null, ...params.metadata },
    },
    // review M-5: the facade already wrote this row with the SPECIFIC reason. Merging adds what only this
    // site knows (what stands in IMS, the remedy) without counting the refusal twice or degrading its reason.
    { mergeOnly: params.outcome.refusalRecorded === true, withSavepoint: params.inTransaction?.withSavepoint },
  )
}

/**
 * The connector active at the moment of the report — used only when the enqueue reported none.
 * Display-only (the inbox row's "active" column); never a routing input. Never throws, including when a
 * test double of `@/lib/accounting` does not provide the resolver.
 */
export async function activeAccountingConnectorForReport(): Promise<string | null> {
  try {
    const { getActiveAccountingConnectorInfo } = await import('@/lib/accounting')
    return (await getActiveAccountingConnectorInfo())?.id ?? null
  } catch {
    return null
  }
}
