import {
  INTEGRATION_OUTBOX_STATUS,
  buildOutboxIdempotencyKey,
  enqueueIntegrationOutbox,
  type IntegrationOutboxClient,
} from '@/lib/domain/integrations/outbox'
import {
  AccountingPostingRefusalProvisionalPayloadSchema,
  type AccountingPostingRefusalProvisionalPayload,
} from '@/lib/domain/integrations/outbox-registry'
import { POSTING_REFUSAL_KINDS, type PostingRefusalKind } from '@/lib/domain/accounting/posting-refusal-kinds'
import type {
  AccountingPostingRefusalRecord,
  PostingRefusalKey,
  QueuedPostingEvidence,
} from '@/lib/domain/accounting/posting-refusal-inbox'

/**
 * o3d-j625 r10 (Codex round 9, HIGH) — A REFUSAL THE CALLER'S TRANSACTION COULD NOT RECORD IS STILL
 * PERSISTED BY IT.
 *
 * ── THE FINDING ──
 *
 * An in-transaction refusal takes the posting key's lock with `pg_try_advisory_xact_lock` and NEVER waits
 * for it: the caller's transaction may already hold stock-level or sales-order locks, so a wait here is
 * where a deadlock against another business transaction comes from (posting-suppression.ts states the
 * argument in full). Round 9 therefore recorded NOTHING when the key was busy — and the caller's business
 * transaction committed regardless, by design (review M-14: a failed inbox write must not abort it). If the
 * transaction holding the key then ROLLED BACK, or failed to queue its posting, an OWED accounting posting
 * was absent from the exception inbox and the only trace was an activity-log WARNING. A WARNING is neither
 * a retry nor a durable work item, and r9's own concurrency test pinned that outcome as correct.
 *
 * ── WHY THIS SHAPE, AND WHAT THE ALTERNATIVE WOULD COST THE LEDGER ──
 *
 * The other available answer was to FAIL the caller's transaction when the key is busy and let whatever
 * drives it retry. Its ledger consequence is clean on paper — nothing commits in IMS and nothing posts, so
 * the two stay in step — and wrong in practice for this codebase:
 *
 *   • The refusal is reported from sites whose business work is already DONE and correct (a goods receipt,
 *     a bill, an MO completion whose stock movements are posted). Rolling that back because the
 *     BOOKKEEPING OF A REFUSAL could not take an advisory lock discards correct work for a reason that has
 *     nothing to do with it, and several of those drivers (an operator pressing a button, a WooCommerce
 *     import sweep that dead-letters on error) have no retry that would put it back.
 *   • It would reverse review M-14 for the one case M-14 is least ambiguous about: a transient,
 *     self-clearing contention.
 *
 * So the caller still commits, and it commits the refusal WITH its business writes — as ONE INSERT into
 * `integration_outbox`, a table no competing transaction here is touching, which is what makes it safe
 * where touching `accounting_posting_refusals` is not: any UPDATE of that row would BLOCK on the row lock
 * the mark / the clear holds until it commits, i.e. wait for exactly the transaction this path must never
 * wait for. An append-only INSERT waits for nothing.
 *
 * That satisfies both halves: M-14 (the caller commits) and this finding (nothing is lost).
 *
 * ── HOW IT IS RECONCILED, BY WHOM, AND WHAT IF THAT NEVER RUNS ──
 *
 * `reconcileProvisionalPostingRefusals` (posting-refusal-reconcile.ts) drains these rows from the POOL,
 * where waiting for the posting key IS allowed, and replays `recordAccountingPostingRefusal` with the
 * ORIGINAL `decidedAt`. It is called by `/api/cron/accounting-sync` on every tick — BEFORE that route's
 * connector gates, deliberately: the refusals that need reconciling are largely the ones where the
 * accounting connector is retired or unconfigured, so a drain inside the connector branch would be gated
 * off in exactly the situations that produce its work.
 *
 * IF THE RECONCILER NEVER RUNS the claim does not disappear quietly. Past
 * {@link PROVISIONAL_POSTING_REFUSAL_GRACE_MS} the exception inbox lists it in the refusal section as
 * UNCONFIRMED (app/actions/sync-exceptions.ts), with a remedy that says what it is and explicitly tells
 * the operator NOT to post it by hand yet — because while a claim is unreconciled the posting may still be
 * another transaction's, and "post this by hand" would be the one instruction that can cause a second
 * ledger post. It is structurally unmarkable: the row carries no `kind`, so `clearing` is `null`, the
 * Mark-as-handled affordance is not offered, and the server action would not find a refusal row under that
 * id anyway. A claim that the drain keeps failing exhausts to `PERMANENT_FAILED` and leaves this list for
 * the integration-outbox failures section, so one obligation is in exactly one place at every moment.
 */

export const PROVISIONAL_POSTING_REFUSAL_CONNECTOR = 'accounting'
export const PROVISIONAL_POSTING_REFUSAL_OPERATION = 'posting-refusal.provisional'
export const PROVISIONAL_POSTING_REFUSAL_WORKER = 'accounting-posting-refusal-reconcile'

/**
 * How long a claim may sit unreconciled before the exception inbox shows it.
 *
 * Three ticks of the 5-minute `accounting-sync` cron that drains it (docs/installation.md). Below that a
 * claim is ordinary latency, not an exception — the same reasoning as the landed-cost outbox's drain
 * grace, in the other direction.
 */
export const PROVISIONAL_POSTING_REFUSAL_GRACE_MS = 15 * 60 * 1000

/** Not SUCCEEDED, and not yet dead-lettered: the statuses in which a claim is still this section's. */
const UNRECONCILED_STATUSES = [
  INTEGRATION_OUTBOX_STATUS.PENDING,
  INTEGRATION_OUTBOX_STATUS.PROCESSING,
  INTEGRATION_OUTBOX_STATUS.RETRYABLE_FAILED,
] as const

/**
 * A blank part makes `buildOutboxIdempotencyKey` throw, and `scope: ''` — "the document IS the
 * obligation" — is the ordinary value, so it is spelled rather than omitted.
 */
const DOCUMENT_SCOPE = 'document'

/**
 * WHY THE KEY CARRIES A RANDOM PART, which is the opposite of what an idempotency key usually wants.
 *
 * A unique-index conflict on `integration_outbox.idempotencyKey` makes the INSERT WAIT for the
 * transaction that inserted the conflicting row — and that transaction is another caller's business
 * transaction, which may hold anything. Waiting for it is the deadlock this whole path exists to avoid, so
 * the key is made unique by construction and the claim NEVER blocks. Duplicate claims for one posting cost
 * nothing to reconcile: the replay's effect is "reopen this row if it is owed", which converges.
 */
function provisionalIdempotencyKey(key: PostingRefusalKey, decidedAt: Date, nonce: string): string {
  return buildOutboxIdempotencyKey(
    PROVISIONAL_POSTING_REFUSAL_CONNECTOR,
    PROVISIONAL_POSTING_REFUSAL_OPERATION,
    key.type,
    key.referenceType,
    key.referenceId,
    key.scope === '' ? DOCUMENT_SCOPE : key.scope,
    String(decidedAt.getTime()),
    nonce,
  )
}

export function buildProvisionalPostingRefusalPayload(
  key: PostingRefusalKey,
  record: AccountingPostingRefusalRecord,
  options: { decidedAt: Date; mergeOnly: boolean; queuedWhenShutOut?: QueuedPostingEvidence | null },
): AccountingPostingRefusalProvisionalPayload {
  return {
    key: { type: key.type, referenceType: key.referenceType, referenceId: key.referenceId, scope: key.scope },
    record: {
      kind: record.kind ?? null,
      chartConnector: record.chartConnector,
      activeConnector: record.activeConnector,
      reason: record.reason,
      committed: record.committed,
      remedy: record.remedy,
      ...(record.detail ? { detail: record.detail } : {}),
    },
    decidedAt: options.decidedAt.toISOString(),
    mergeOnly: options.mergeOnly,
    // o3d-j625 r11 (Codex round 10, HIGH 1) — WHAT WAS ALREADY QUEUED WHEN THE KEY WAS REFUSED.
    //
    // The replay's whole difficulty is that by the time it runs, the transaction that held the key has
    // ended: a holder that queued the posting and a holder that rolled back look identical from there, and
    // r10 resolved that by treating any live sync row as the holder's. For the types whose successive
    // edits SHARE a posting key, edit 1's row then discharged every later refusal for ever. This is the
    // baseline that makes the difference visible — a live row whose id is not in it was written by a
    // transaction that committed after the refusal was shut out.
    //
    // `null` is a VALUE here, not an omission: "this call was shut out and could not look", which the
    // replay must not read as "nothing was queued". An older claim, written before this field existed,
    // parses as `undefined` and the replay falls back to the decision-time comparison alone — which keeps
    // the debt rather than losing it.
    queuedWhenShutOut: options.queuedWhenShutOut === undefined ? null : options.queuedWhenShutOut,
  }
}

/**
 * Persist a refusal that could not take the posting key, IN THE CALLER'S OWN TRANSACTION.
 *
 * `client` is the caller's transaction client and nothing else: passing a pooled client would commit the
 * claim independently of the business writes it describes, so a rolled-back caller would leave a debt for
 * work that never happened. The one caller (`recordAccountingPostingRefusal`) has only the caller's client
 * to give it, and tests/accounting/posting-refusal-provisional.test.ts pins the rollback case.
 */
export async function enqueueProvisionalPostingRefusal(
  client: IntegrationOutboxClient,
  key: PostingRefusalKey,
  record: AccountingPostingRefusalRecord,
  options: { decidedAt: Date; mergeOnly: boolean; nonce: string; queuedWhenShutOut: QueuedPostingEvidence | null },
): Promise<void> {
  await enqueueIntegrationOutbox(
    {
      connector: PROVISIONAL_POSTING_REFUSAL_CONNECTOR,
      operation: PROVISIONAL_POSTING_REFUSAL_OPERATION,
      idempotencyKey: provisionalIdempotencyKey(key, options.decidedAt, options.nonce),
      payloadJson: buildProvisionalPostingRefusalPayload(key, record, options),
      // No grace: nothing races this drain (unlike the landed-cost backstop, there is no immediate
      // post-commit attempt), and the drain is allowed to WAIT for the key it could not take.
      nextAttemptAt: null,
    },
    { client },
  )
}

/** The record as `recordAccountingPostingRefusal` takes it, with the kind narrowed back to the closed set. */
export function provisionalPayloadToRecord(payload: AccountingPostingRefusalProvisionalPayload): AccountingPostingRefusalRecord {
  const kind = payload.record.kind
  return {
    // A kind this build does not know is carried as `null` — never markable — rather than asserted into
    // the union: the payload is data read back out of a table, and a kind removed since it was written
    // must not make a row the mark would then act on.
    kind: kind !== null && kind in POSTING_REFUSAL_KINDS ? kind as PostingRefusalKind : null,
    chartConnector: payload.record.chartConnector,
    activeConnector: payload.record.activeConnector,
    reason: payload.record.reason,
    committed: payload.record.committed,
    remedy: payload.record.remedy,
    ...(payload.record.detail && typeof payload.record.detail === 'object' && !Array.isArray(payload.record.detail)
      ? { detail: payload.record.detail as Record<string, unknown> }
      : {}),
  }
}

export type UnreconciledProvisionalPostingRefusal = {
  /** The outbox row's id. Deliberately NOT an `AccountingPostingRefusal` id — there is no row yet. */
  id: string
  key: PostingRefusalKey
  record: AccountingPostingRefusalRecord
  decidedAt: Date
  /**
   * o3d-j625 r11 — the postings already queued when the refusal was shut out of its key. `null` = it could
   * not be observed; `undefined` = a claim written before this field existed. Both leave the replay with
   * the decision-time comparison alone, which keeps the debt.
   */
  queuedWhenShutOut?: QueuedPostingEvidence | null
  /** How many reconciliation attempts have already failed; 0 while it is simply waiting for the drain. */
  attempts: number
  status: string
}

type ProvisionalListClient = {
  integrationOutbox: {
    findMany(args: unknown): Promise<Array<{
      id: string
      payloadJson: unknown
      attempts: number
      status: string
      createdAt: Date
    }>>
  }
}

type ProvisionalCountClient = { integrationOutbox: { count(args: unknown): Promise<number> } }

/** The predicate behind both the count and the list, so the badge and the rows cannot disagree. */
function unreconciledWhere(now: Date, graceMs: number): Record<string, unknown> {
  return {
    connector: PROVISIONAL_POSTING_REFUSAL_CONNECTOR,
    operation: PROVISIONAL_POSTING_REFUSAL_OPERATION,
    status: { in: [...UNRECONCILED_STATUSES] },
    createdAt: { lt: new Date(now.getTime() - graceMs) },
  }
}

export async function countUnreconciledProvisionalPostingRefusals(options: {
  client: ProvisionalCountClient
  now?: Date
  graceMs?: number
}): Promise<number> {
  return options.client.integrationOutbox.count({
    where: unreconciledWhere(options.now ?? new Date(), options.graceMs ?? PROVISIONAL_POSTING_REFUSAL_GRACE_MS),
  })
}

/**
 * Claims that have been waiting longer than the grace, oldest first — what the exception inbox shows so
 * that a reconciler which never runs is visible rather than silent.
 *
 * A row whose payload does not parse is left out: it cannot be described to an operator, and the drain
 * fails it to `PERMANENT_FAILED` where the integration-outbox section lists it. `limit` is the caller's
 * section cap.
 */
export async function listUnreconciledProvisionalPostingRefusals(options: {
  client: ProvisionalListClient
  now?: Date
  graceMs?: number
  limit?: number
}): Promise<UnreconciledProvisionalPostingRefusal[]> {
  const now = options.now ?? new Date()
  const graceMs = options.graceMs ?? PROVISIONAL_POSTING_REFUSAL_GRACE_MS
  const rows = await options.client.integrationOutbox.findMany({
    where: unreconciledWhere(now, graceMs),
    orderBy: { createdAt: 'asc' },
    ...(options.limit ? { take: options.limit } : {}),
    select: { id: true, payloadJson: true, attempts: true, status: true, createdAt: true },
  })
  const listed: UnreconciledProvisionalPostingRefusal[] = []
  for (const row of rows) {
    const parsed = AccountingPostingRefusalProvisionalPayloadSchema.safeParse(row.payloadJson)
    if (!parsed.success) continue
    listed.push({
      id: row.id,
      key: parsed.data.key,
      record: provisionalPayloadToRecord(parsed.data),
      decidedAt: new Date(parsed.data.decidedAt),
      ...(parsed.data.queuedWhenShutOut === undefined ? {} : { queuedWhenShutOut: parsed.data.queuedWhenShutOut }),
      attempts: row.attempts,
      status: row.status,
    })
  }
  return listed
}
