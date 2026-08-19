import { db } from '@/lib/db'

/**
 * o3d-0m56 round 9 (Codex HIGH) — WHAT `remoteAttemptedAt IS NULL` PROVES, AND SINCE WHEN.
 *
 * Round 8 made a money row's payload evidence: `planFollowUpEnqueue` will not recycle a FAILED
 * row that ever made a remote call, because overwriting it rotates that attempt's token and
 * discards the anchors, amount and date the ledger's mark has to be matched against. The test
 * for "ever made a remote call" is the `remoteAttemptedAt` stamp, claimed by `authoriseMoneyPost`
 * immediately before the call. So the rule rests on one premise:
 *
 *   AN UNSTAMPED MONEY ROW IS PROOF THAT NO CALL EVER LEFT IT.
 *
 * THE PREMISE HAS A DEPLOYMENT-SHAPED HOLE. The migration `20260818090000` backfills every
 * pre-existing money row, on the reasoning that a row this code has never seen may already have
 * reached the ledger. That is sound for the rows that existed WHEN IT RAN. It says nothing about
 * the rows created AFTER it and BEFORE the stamping binary is live — and there is a window, it is
 * minutes long, and `scripts/deploy.sh` opens it by design:
 *
 *   1. the migration step             <- the backfill commits here
 *   2. `npm run build`               <- minutes; THE OLD BINARY IS STILL SERVING
 *   3. stop the old server
 *   4. start the new one             <- stamping begins here
 *
 * Everything the old binary posts in steps 1–3 lands unstamped, after the backfill has already
 * been and gone. The new binary then reads those rows as "never attempted", recycles their
 * payloads, and destroys exactly the evidence round 8 exists to keep — a lost-response payment
 * against invoice A, recycled into a request for invoice B, and the next enqueue for A finds no
 * attempt, rotates a token and pays it twice. `authoriseMoneyPost`'s rival-attempt query has the
 * same premise (`remoteAttemptedAt: { not: null }`) and goes blind to the same rows.
 *
 * THE FIX: A BACKFILL THAT RUNS AFTER THE OLD BINARY IS GONE — AUTOMATICALLY, AND ONCE PER
 * DATABASE. The migration cannot do it, because a migration by definition runs before the binary
 * it ships with. The running binary can: the first time a stamping process needs the premise, it
 * stamps every money row that already exists and records the instant it did so. From then on
 * "unstamped" means "created after that instant", i.e. created by a binary that stamps.
 *
 * WHY NOT AN OPERATOR STEP. "Run this SQL after the deploy" is a fix that is applied by
 * remembering. Forgetting it is silent, and what it costs is a duplicate payment weeks later.
 * This runs itself, is idempotent, and is one `findUnique` per process after the first time.
 *
 * WHY THE EPOCH IS PERSISTED AND NOT THE PROCESS START TIME. Process start would also be a sound
 * cutoff, but it MOVES: after every restart, every money row created before it stops being
 * recyclable, so the rows the rule is meant to tidy up accumulate for ever and the fence acquires
 * a growing set of rows it cannot classify. A value written once and never rewritten makes the
 * untrusted set exactly what it should be — the rows that existed before stamping began — and
 * that set never grows.
 *
 * WHAT THE OPERATOR MUST DO. Nothing, for a normal deploy — but the DEPLOY ORDER is now
 * load-bearing and is documented as such in `docs/installation.md`, `CLAUDE.md` and the header of
 * `scripts/deploy.sh`:
 *
 *   THE OLD PROCESS MUST BE FULLY STOPPED BEFORE THE NEW ONE IS STARTED. Never run two binaries
 *   against one database at once (no rolling or blue/green overlap).
 *
 * `scripts/deploy.sh` already does this — it kills the old server and refuses to continue until
 * the port is free — but that check was there for EADDRINUSE, and it is now the thing that makes
 * the epoch true. If an overlap ever happens (or an operator is unsure), the recovery is one
 * statement, and it is safe to run at any time:
 *
 *   DELETE FROM settings WHERE key = 'accounting.money-attempt-stamping-since';
 *
 * The next money operation re-establishes the epoch and re-stamps everything created before that
 * moment. Being wrong in that direction costs one extra ledger GET per row, which is the same
 * trade the original backfill made.
 */

/** The `settings` key holding the instant from which an unstamped money row proves anything. */
export const MONEY_ATTEMPT_STAMPING_SINCE_KEY = 'accounting.money-attempt-stamping-since'

/**
 * The types `authoriseMoneyPost` stamps — `MONEY_MOVING_SYNC_TYPES` in followup-retry-guard.ts,
 * repeated rather than imported because that module imports this one's sibling and a cycle here
 * would be resolved at runtime inside a money path. Pinned to the fence's own set by a test: a
 * money type missing from here is a type whose deploy-window rows are never repaired.
 */
export const STAMPED_MONEY_TYPES = ['INVOICE_PAYMENT', 'BILL_PAYMENT', 'PURCHASE_CREDIT_NOTE_ALLOCATION'] as const

/**
 * The two database operations the epoch needs, named rather than passed as a Prisma client so the
 * decision logic can be tested without one. The concrete implementation is `prismaEpochStore`.
 */
export type StampingEpochStore = {
  /** The recorded epoch, or null when stamping has never been established on this database. */
  read: () => Promise<Date | null>
  /**
   * ATOMICALLY: record `epoch`, then stamp every money row created before it that is still
   * unstamped. Records first, so a lost race rolls the whole thing back before it writes.
   *
   * Returns the epoch that is now recorded — which is the WINNER's when this call lost a race,
   * not `epoch`. Reporting our own would let a caller trust rows the winner's backfill has
   * already judged untrustworthy.
   */
  establish: (epoch: Date) => Promise<Date>
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
}

export const prismaEpochStore: StampingEpochStore = {
  read: async () => {
    const row = await db.setting.findUnique({ where: { key: MONEY_ATTEMPT_STAMPING_SINCE_KEY }, select: { value: true } })
    if (!row) return null
    const parsed = new Date(row.value)
    // A key someone has hand-edited into nonsense must not read as "the epoch is 1970", which
    // would trust every row on the database. Unparseable is unknown, and unknown fails closed.
    return Number.isNaN(parsed.getTime()) ? null : parsed
  },
  establish: async (epoch) => {
    try {
      return await db.$transaction(async (tx) => {
        await tx.setting.create({
          data: { key: MONEY_ATTEMPT_STAMPING_SINCE_KEY, value: epoch.toISOString() },
        })
        // The same conservative value the migration's backfill used: the best lower bound the row
        // itself carries, never `now()`, which would claim an attempt happened at deploy time.
        // `updateMany` cannot express a per-row COALESCE, hence raw SQL; the only interpolation is
        // the epoch, as a bound parameter.
        //
        // The type list is the CONSTANT, not a second copy of it written out in SQL: a literal
        // list here could silently fall out of step with the set the fence actually stamps, and
        // a money type missing from it would be a type this whole mechanism skips. `::text` casts
        // the enum so it can be compared with a bound text array.
        await tx.$executeRaw`
          UPDATE "accounting_sync_logs"
             SET "remoteAttemptedAt" = COALESCE("syncedAt", "processingStartedAt", "createdAt")
           WHERE "type"::text = ANY(${[...STAMPED_MONEY_TYPES]}::text[])
             AND "remoteAttemptedAt" IS NULL
             AND "createdAt" < ${epoch}
        `
        return epoch
      })
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      // The key exists, so someone recorded an epoch between our read and our write — normally the
      // other process in a start-up race, whose backfill is the one that actually ran.
      const winner = await prismaEpochStore.read()
      if (winner) return winner
      // The key exists but does not parse. Refusing is the only safe answer: an unreadable epoch
      // cannot say which rows are trustworthy, and inventing one would trust rows the deploy window
      // may have left unstamped. The recovery is to DELETE the key and let it re-establish.
      throw new Error(
        `The setting "${MONEY_ATTEMPT_STAMPING_SINCE_KEY}" holds a value that is not a timestamp, so IMS `
        + 'cannot tell which accounting money rows predate attempt stamping. Delete the row and the next '
        + 'money operation will re-establish it (see docs/installation.md, "Deploy order").',
      )
    }
  },
}

/**
 * Resolve the epoch, establishing it if this database has never had one. Exported uncached so the
 * decision can be tested against a fake store; production goes through
 * `moneyAttemptStampingSince`.
 */
export async function resolveMoneyAttemptStampingSince(
  store: StampingEpochStore,
  now: () => Date = () => new Date(),
): Promise<Date> {
  return (await store.read()) ?? store.establish(now())
}

/**
 * Cached for the life of the process — the epoch is written once per DATABASE and never rewritten,
 * so re-reading it on every follow-up enqueue would be a query that can only ever return the same
 * answer.
 *
 * A FAILURE IS NOT CACHED. A transient error must not pin "unknown" for the life of the process:
 * unknown fails closed, and a fence that has failed closed for ever is a fence nobody can deploy
 * past.
 */
let inFlight: Promise<Date> | null = null

export async function moneyAttemptStampingSince(store: StampingEpochStore = prismaEpochStore): Promise<Date> {
  // The cache belongs to the REAL store. A caller that supplies its own is answered without it, so
  // an injected store can never be handed production's cached value — nor leave its own behind for
  // production to read.
  if (store !== prismaEpochStore) return resolveMoneyAttemptStampingSince(store)
  if (!inFlight) {
    inFlight = resolveMoneyAttemptStampingSince(store).catch((error) => {
      inFlight = null
      throw error
    })
  }
  return inFlight
}

/**
 * The epoch, or null when it could not be established.
 *
 * For callers that must not FAIL because of it. `planFollowUpEnqueue` treats null as "nothing is
 * proof", which costs an extra row and never a duplicate payment — whereas throwing out of a
 * follow-up enqueue would fail the parent entry that has already posted its invoice.
 *
 * Not a silent-only path: the same resolution is made at the top of every sync run, where it is NOT
 * swallowed, so a database that cannot answer surfaces there rather than degrading unnoticed here.
 */
export async function moneyAttemptStampingSinceOrNull(
  store: StampingEpochStore = prismaEpochStore,
): Promise<Date | null> {
  try {
    return await moneyAttemptStampingSince(store)
  } catch {
    return null
  }
}
