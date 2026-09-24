import type { Prisma } from '@/app/generated/prisma/client'
import { ACCOUNTING_POSTING_SUPPRESSION_LOCK_NAMESPACE } from '@/lib/db/advisory-locks'
import { isClientInsideTransaction, withSavepoint } from '@/lib/db/savepoint'
import type { PostingRefusalKey } from '@/lib/domain/accounting/posting-refusal-inbox'

/**
 * o3d-j625 r7 (owner decision 2026-09-19, "Handled + stop retry") — A POSTING SOMEONE POSTED BY HAND IS
 * NEVER POSTED BY IMS.
 *
 * Marking a refused posting handled is an operator's assertion: "I posted this, by hand, in the ledger".
 * Several refused postings are ALSO retried by IMS (a sweep, the landed-cost outbox, a refund retry, a
 * follow-up). Before r7 the two could both happen, and a hand-posted journal was then posted a second
 * time by the retry. So the mark sets `accounting_posting_refusals.suppressedAt` for the EXACT posting key
 * (lib/accounting/posting-key.ts), and this module is how every writer of an accounting sync row asks
 * about it — createAccountingSyncLogRow calls it before every create, so no path can post around it.
 *
 * SERIALISED WITH THE MARK. Both sides take the same transaction-scoped advisory lock on the posting key
 * (ACCOUNTING_POSTING_SUPPRESSION_LOCK_NAMESPACE) before they read or write: the mark cancels any
 * unposted row and sets the suppression under it, and a create reads the suppression under it, so a row
 * cannot be written between the mark's cancellation and its commit. On a client that is not in a
 * transaction the lock is released at once; every production caller of the primitive is in one.
 *
 * ── o3d-j625 r8 (Codex HIGH) — A READ THAT FAILS REFUSES. IT USED TO MEAN "NOT SUPPRESSED". ──
 *
 * r7 logged a failed lookup and returned `{ suppressed: false }`, and `createAccountingSyncLogRow` then
 * created a PENDING sync row for the posting. So a lookup that failed AFTER an operator marked the
 * posting handled — while the insert itself succeeded — queued, durably, exactly the posting the
 * "Handled + stop retry" decision exists to stop IMS posting. Measured against a real Postgres
 * transaction with the failure injected on that one query: one PENDING row, committed. The savepoint
 * this read runs under is what made it survivable enough to reach the insert.
 *
 * r7's argument for the degrade was that the only realistic failure is code running ahead of
 * `migrate deploy`, when nothing can be suppressed yet, so refusing would be an outage for a guard with
 * nothing to guard. THAT PREMISE IS FALSE FOR THIS DEPLOYMENT. scripts/deploy.sh builds, then STOPS the
 * application, and only then migrates (the order is asserted in tests/scripts/deploy-order.test.ts:
 * "deploy.sh builds and validates before it stops anything, and migrates only once stopped"), precisely
 * so that no binary ever serves against a schema it disagrees with. A read that fails at runtime is
 * therefore not a schema that has not caught up; it is a state that cannot be read — a lost connection,
 * a lock timeout, a statement timeout, an aborted transaction — and "cannot be read" is not "nothing was
 * marked".
 *
 * It throws {@link PostingSuppressionUnreadableError}, and NOTHING here catches it:
 *
 *   • The caller's transaction rolls back. Nothing commits — not the sync row, and not the business
 *     writes it was queued alongside — so IMS and the ledger stay in step and there is nothing to
 *     reconcile afterwards. Whatever drives the operation (a sweep, the landed-cost outbox, a follow-up,
 *     an operator re-submitting) tries again, which is the right response to a transient read failure.
 *   • THE ALTERNATIVE — refusing just this enqueue with `{ queued: false, reason: 'refused' }` and letting
 *     the caller commit — was rejected. It converts an infrastructure blip into durable operator work;
 *     the record of that work is an upsert into the very table that has just proved unreadable
 *     (recordAccountingPostingRefusal reads `suppressedAt` first), so in the realistic failure mode the
 *     refusal is not recorded at all and only logged; and it leaves IMS-side state committed against a
 *     ledger that never got the posting. A refusal has to be visible and retryable; this one would be
 *     neither.
 *   • WHAT IT MUST NEVER BECOME is `{ queued: true, reason: 'handled-by-hand' }`. That answer means "a
 *     counterpart exists in the ledger, stop retrying": `postingIsOwed()` reads it as nothing owed and the
 *     landed-cost outbox stops re-driving. It is reachable ONLY from a positive `suppressed: true` read
 *     (lib/accounting.ts, and the `null` return of createAccountingSyncLogRow, which only a positive read
 *     produces). An unreadable state can no longer reach it, because it no longer returns at all.
 *
 * The failure is still logged before it is thrown — the exception surfaces where the call was made, the
 * activity entry says which posting could not be checked.
 */
export type PostingSuppressionClient = {
  $executeRaw?: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>
  accountingPostingRefusal?: {
    findUnique(args: {
      where: { type_referenceType_referenceId_scope: PostingRefusalKey }
      select: { suppressedAt: true; resolvedBy: true }
    }): Promise<{ suppressedAt: Date | null; resolvedBy: string | null } | null>
  }
}

/**
 * o3d-j625 r8 — WHY THE TWO OPTIONAL MEMBERS ABOVE ARE NOT A SECOND WAY TO FAIL OPEN.
 *
 * `readPostingSuppression` answers "not suppressed" when the client carries no `accountingPostingRefusal`
 * delegate, and `lockPostingKey` returns without a lock when it carries no `$executeRaw`. Both are
 * capability checks for TEST DOUBLES — a structural double that implements only `accountingSyncLog` — and
 * both would be a failure treated as permission if a REAL client could take them.
 *
 * It cannot, and this is the proof rather than the assertion: every production caller passes a Prisma
 * client or an interactive transaction client, and this type error fires if either member ever stops
 * being present on one. It costs nothing at runtime (a type-only import) and is checked by `tsc`.
 */
type AssertTrue<T extends true> = T
export type PrismaClientCanAlwaysReadTheSuppression = AssertTrue<
  Prisma.TransactionClient extends {
    $executeRaw: (query: TemplateStringsArray, ...values: never[]) => unknown
    accountingPostingRefusal: { findUnique: (args: never) => unknown }
  } ? true : false
>
/**
 * o3d-j625 r9 — and the same proof for the contention probe. `runUnderPostingKeyLock` answers
 * `{ held: false, reason: 'unlockable' }` when the client cannot run `pg_try_advisory_xact_lock`; this
 * fires if a real transaction client ever stops being able to, so that answer stays a statement about
 * TEST DOUBLES and never becomes a way for production to write the inbox unserialised.
 */
export type PrismaClientCanAlwaysTakeThePostingKeyLock = AssertTrue<
  Prisma.TransactionClient extends {
    $queryRaw: (query: TemplateStringsArray, ...values: never[]) => unknown
  } ? true : false
>

/**
 * THROWN when the suppression state could not be read, so nothing may be posted (o3d-j625 r8, Codex HIGH).
 *
 * Retryable in the strict sense: it is raised BEFORE any write this module's callers make, so a caller
 * that sees it has queued nothing, changed nothing and may simply attempt the same enqueue again.
 */
export class PostingSuppressionUnreadableError extends Error {
  /** For a caller deciding whether to re-drive: nothing happened, so re-driving is safe. */
  readonly retryable = true
  readonly posting: PostingRefusalKey
  /** The underlying failure, kept for the caller's own logging. */
  readonly reason: string

  constructor(key: PostingRefusalKey, cause: unknown) {
    const reason = describeSuppressionReadFailure(cause)
    super(
      `IMS could not read whether ${key.type} for ${key.referenceType} ${key.referenceId} had already been `
      + 'posted by hand, so it refused to queue it rather than risk posting it twice. Nothing was written; '
      + `this can be retried. Cause: ${reason}`,
    )
    this.name = 'PostingSuppressionUnreadableError'
    this.posting = key
    this.reason = reason
  }
}

/**
 * What went wrong, in one line that is never blank.
 *
 * `message` alone is not enough: measured against `@prisma/adapter-pg`, a raw-query failure inside a
 * transaction arrives as an Error whose `message` is the EMPTY STRING, so the r8 refusal's first draft
 * read "Cause: " and named nothing. The error code is where the information actually is (o3d-5od is the
 * same lesson about `meta.target`), so it leads, and the class name stands in when there is no text.
 */
function describeSuppressionReadFailure(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause)
  const code = (cause as { code?: unknown }).code
  const driverCode = (cause as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } } })
    .meta?.driverAdapterError?.cause?.originalCode
  const text = cause.message.trim() || cause.name
  const codes = [code, driverCode].filter((value) => typeof value === 'string' && value.length > 0)
  return codes.length > 0 ? `${codes.join('/')}: ${text}` : text
}

/** A stable 32-bit id for a posting key, for the lock's second argument. */
export function postingKeyLockId(key: PostingRefusalKey): number {
  const value = [key.type, key.referenceType, key.referenceId, key.scope].join('|')
  let hash = 0
  for (let i = 0; i < value.length; i++) hash = (Math.imul(31, hash) + value.charCodeAt(i)) | 0
  return hash
}

export async function lockPostingKey(client: PostingSuppressionClient, key: PostingRefusalKey): Promise<void> {
  if (typeof client.$executeRaw !== 'function') return
  await client.$executeRaw`SELECT pg_advisory_xact_lock(${ACCOUNTING_POSTING_SUPPRESSION_LOCK_NAMESPACE}, ${postingKeyLockId(key)})`
}

/**
 * ── o3d-j625 r9 (Codex HIGH) — THE REFUSAL INBOX'S OWN WRITES TAKE THIS LOCK TOO ──
 *
 * r7 and r8 serialised the two paths that decide whether IMS may POST: the mark, and every creation of
 * an accounting sync row. `recordAccountingPostingRefusal` was left outside, reading `suppressedAt`
 * before its upsert and taking no lock at all. So a mark committing between that read and that upsert
 * left the row REOPENED — outstanding again, `suppressedAt` intact — and the exception inbox then
 * presented a posting an operator had already posted BY HAND as work still owed, with a remedy that
 * asks them to post it. The same shape lands a refusal after a successful enqueue has cleared the row,
 * leaving a debt that is not owed. Measured, both of them, in
 * tests/concurrency/posting-refusal-record-race.concurrent.test.ts.
 *
 * So EVERY write to `accounting_posting_refusals` now happens while holding this key's lock: the mark
 * (posting-mark-handled.ts), the clear (through the row-creating primitive, or through this helper),
 * and the record. That makes the row's state a thing a writer can READ and act on, which is what the
 * r7 read was pretending to be.
 *
 * ── HOW IT INTERACTS WITH THE CALLER'S TRANSACTION, AND WHY IT CANNOT DEADLOCK ──
 *
 * A refusal is recorded from two kinds of caller, and the two get different treatment BECAUSE the
 * deadlock argument is different for each:
 *
 *  • THROUGH THE POOL (the facade's own refusal, the sweeps, the sites that report after their commit).
 *    An advisory `xact` lock taken on an autocommit connection is released by the implicit commit of
 *    the statement that took it, so it serialises NOTHING there. This helper therefore opens its own
 *    short transaction and holds the lock for the read and the write. It may WAIT for the lock, and
 *    waiting is safe here by construction: it holds nothing when it starts to wait — no advisory lock,
 *    no row lock, no connection but its own — so it cannot be part of a wait cycle. `lock_timeout`
 *    bounds the wait anyway, and a timeout degrades to the logged "could not record" below.
 *
 *  • INSIDE THE CALLER'S TRANSACTION (`withSavepoint` given: a goods receipt, a bill, an MO completion
 *    reporting its own refusal). That transaction may already hold anything — stock-level locks, the
 *    sales-order row lock, another posting key's lock — so WAITING here could close a cycle against a
 *    transaction that wants one of those. It therefore NEVER waits: `pg_try_advisory_xact_lock` only.
 *    A transaction that already holds this key's lock (it queued this same posting) is granted it
 *    again — advisory locks are re-entrant within a transaction — so the ordinary case never fails.
 *    A genuine failure to take it means ANOTHER transaction is settling this exact posting right now,
 *    which is precisely when this refusal is not the newest word on it: nothing is recorded and the
 *    activity log says so. That is the same fail-closed direction as r8's unreadable suppression.
 *
 * Either way a failure here is still contained: review M-14's savepoint is unchanged, so a failed
 * record cannot abort the caller's transaction.
 */
export type PostingKeyLockClient = PostingSuppressionClient & {
  $queryRaw?: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>
  $transaction?: (
    fn: (client: never) => Promise<unknown>,
    options?: { timeout?: number; maxWait?: number },
  ) => Promise<unknown>
}

/**
 * Whether the posting key's lock is held for the work about to run, and — when it is — whether it had
 * to be WAITED for.
 *
 * `contended` is not bookkeeping. It is the only clock-free evidence available that ANOTHER transaction
 * was settling this posting while this refusal was being decided, which is exactly what makes the
 * refusal stale (see `recordAccountingPostingRefusal`).
 */
export type PostingKeyLock =
  | { held: true; contended: boolean }
  /** `busy`: another transaction holds it and this caller may not wait. `unlockable`: a test double. */
  | { held: false; reason: 'busy' | 'unlockable' }

/** How long a POOLED writer will wait for the key before giving up and reporting it (ms). */
const POOLED_LOCK_TIMEOUT_MS = 10_000
/** Generous enough that the wait above, not this, is what ends a contended pooled write. */
const POOLED_TRANSACTION = { timeout: 20_000, maxWait: 15_000 }

/**
 * `true` taken, `false` another transaction holds it, `null` this client did not actually run the
 * function — a structural test double. The THIRD answer matters: a double whose `$queryRaw` returns `[]`
 * to everything would otherwise read as "another transaction holds the key", and every in-transaction
 * refusal in the unit suite would silently stop being recorded. A real PostgreSQL connection always
 * returns exactly one row with a boolean in it.
 */
async function tryLockPostingKey(client: PostingKeyLockClient, key: PostingRefusalKey): Promise<boolean | null> {
  if (typeof client.$queryRaw !== 'function') return null
  const rows = await client.$queryRaw`SELECT pg_try_advisory_xact_lock(${ACCOUNTING_POSTING_SUPPRESSION_LOCK_NAMESPACE}, ${postingKeyLockId(key)}) AS got` as Array<{ got?: unknown }> | undefined
  const got = rows?.[0]?.got
  return typeof got === 'boolean' ? got : null
}

/**
 * Run `fn` holding the posting key's lock, opening a transaction for it when the client is not already
 * in one. `fn` is told what it got: it must not treat `{ held: false }` as permission.
 *
 * `callerTransaction` is the CONTRACT half — a caller that passed `withSavepoint` has said it is inside
 * its own transaction. It is not trusted alone: when it is not set the database is ASKED
 * (`isClientInsideTransaction`), because Prisma's transaction client is not distinguishable from the
 * pooled one by looking at it (lib/db/savepoint.ts), and calling `$transaction` on a transaction client
 * would open a SECOND connection inside the first — a self-deadlock waiting to happen.
 */
export async function runUnderPostingKeyLock<T>(
  client: PostingKeyLockClient,
  key: PostingRefusalKey,
  options: { callerTransaction: boolean },
  fn: (client: PostingKeyLockClient, lock: PostingKeyLock) => Promise<T>,
): Promise<T> {
  // STATICALLY imported, so `tsc` is what guarantees the probe exists in production; the `typeof` check
  // can only be false under a MODULE DOUBLE of lib/db/savepoint that supplies `withSavepoint` alone (four
  // test files do), and such a double is treated exactly like a client with no raw escape hatch.
  const probe: unknown = isClientInsideTransaction
  const inTransaction = options.callerTransaction
    ? true
    : typeof probe === 'function' ? await isClientInsideTransaction(client) : null
  // No raw escape hatch at all: a structural test double. It could never have been serialised and this
  // is not the round that changes that — it is told `held: false`, and says so.
  if (inTransaction === null) return fn(client, { held: false, reason: 'unlockable' })
  if (inTransaction) {
    const got = await tryLockPostingKey(client, key)
    if (got === null) return fn(client, { held: false, reason: 'unlockable' })
    return fn(client, got ? { held: true, contended: false } : { held: false, reason: 'busy' })
  }
  if (typeof client.$transaction !== 'function') return fn(client, { held: false, reason: 'unlockable' })
  return await client.$transaction(async (raw) => {
    const tx = raw as unknown as PostingKeyLockClient
    // Bounds the wait below without touching the session or any other transaction: `set_config(…, true)`
    // is SET LOCAL, undone by this transaction's own commit. Parameterised rather than assembled, so
    // this module stays off the runtime-assembled-SQL inventory (tests/accounting/plugin-selection-lock).
    if (typeof tx.$executeRaw === 'function') {
      await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${POOLED_LOCK_TIMEOUT_MS}ms`}, true)`
    }
    const got = await tryLockPostingKey(tx, key)
    if (got === null) return fn(tx, { held: false, reason: 'unlockable' })
    if (got) return fn(tx, { held: true, contended: false })
    // Contended. Safe to wait: this transaction holds nothing yet (see the header), and a timeout
    // raises 55P03, which the caller reports rather than swallows.
    // Called as a METHOD (Prisma binds its client methods); the assertion only erases the optionality
    // the structural type carries for doubles, which `got === null` above has already ruled out.
    await tx.$executeRaw!`SELECT pg_advisory_xact_lock(${ACCOUNTING_POSTING_SUPPRESSION_LOCK_NAMESPACE}, ${postingKeyLockId(key)})`
    return fn(tx, { held: true, contended: true })
  }, POOLED_TRANSACTION) as T
}

export type PostingSuppression = { suppressed: false } | { suppressed: true; at: Date; by: string | null }

export async function readPostingSuppression(
  client: PostingSuppressionClient,
  key: PostingRefusalKey,
): Promise<PostingSuppression> {
  const table = client.accountingPostingRefusal
  if (!table || typeof table.findUnique !== 'function') return { suppressed: false }
  try {
    // The savepoint is still here, and its job is unchanged: a failed statement inside a Postgres
    // transaction aborts it (25P02), so without it the caller could not even roll back cleanly, and the
    // error that reached them would be an opaque one about a later statement. It makes the failure
    // REPORTABLE; it is not permission to carry on past it.
    const row = await withSavepoint(client, () => table.findUnique({
      where: { type_referenceType_referenceId_scope: key },
      select: { suppressedAt: true, resolvedBy: true },
    }))
    return row?.suppressedAt ? { suppressed: true, at: row.suppressedAt, by: row.resolvedBy } : { suppressed: false }
  } catch (error) {
    const { logActivity } = await import('@/lib/activity-log')
    await logActivity({
      entityType: 'SYSTEM',
      action: 'accounting_posting_suppression_unreadable',
      tag: 'accounting',
      level: 'ERROR',
      description:
        `Could not read whether ${key.type} for ${key.referenceType} ${key.referenceId} was posted by hand, so `
        + `IMS did NOT queue it: an unreadable suppression is not permission to post. Nothing was written and `
        + `this can be retried. Cause: ${error instanceof Error ? error.message : String(error)}`,
      metadata: { ...key },
    }).catch(() => { /* nothing else to try — and a failed report must not soften the refusal below */ })
    throw new PostingSuppressionUnreadableError(key, error)
  }
}

/** The activity entry every refused automatic enqueue of a hand-posted posting writes. */
export async function reportSuppressedPosting(key: PostingRefusalKey, suppression: Extract<PostingSuppression, { suppressed: true }>): Promise<void> {
  const { logActivity } = await import('@/lib/activity-log')
  await logActivity({
    entityType: 'SYSTEM',
    action: 'accounting_posting_suppressed_handled_by_hand',
    tag: 'accounting',
    level: 'INFO',
    description:
      `IMS did NOT post ${key.type} for ${key.referenceType} ${key.referenceId}: it was marked handled — posted `
      + `by hand in the ledger — on ${suppression.at.toISOString()}, so posting it again would post it twice.`,
    metadata: { ...key, suppressedAt: suppression.at.toISOString(), markedBy: suppression.by },
  }).catch(() => { /* a report that cannot be written must not turn a suppression into a post */ })
}
