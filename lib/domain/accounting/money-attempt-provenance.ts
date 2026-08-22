
/**
 * o3d-0m56 round 10 (Codex HIGH x3) — WHAT `remoteAttemptedAt IS NULL` PROVES, AND HOW THE ROW
 * ITSELF SAYS SO.
 *
 * Round 8 made a money row's payload evidence: `planFollowUpEnqueue` will not recycle a FAILED
 * row that ever made a remote call, because overwriting it rotates that attempt's token and
 * discards the anchors, amount and date the ledger's mark has to be matched against. The test for
 * "ever made a remote call" is the `remoteAttemptedAt` stamp, claimed by `authoriseMoneyPost`
 * immediately before the call. So the rule rests on one premise:
 *
 *   AN UNSTAMPED MONEY ROW IS PROOF THAT NO CALL EVER LEFT IT.
 *
 * That premise is only true of a row every binary that ever handled it stamps. Round 9 tried to
 * establish it with a single global instant — an epoch written once to `settings`, with a backfill
 * under it — and Codex round 10 took that apart three ways, all of them the same shape: the thing
 * that made the premise true lived OUTSIDE the row.
 *
 *   1. THE BOUNDARY CROSSED CLOCKS. It compared a row's `createdAt` (PostgreSQL's clock, via
 *      `@default(now())`) with an epoch built from `new Date()` in the app process. Two clocks a
 *      few seconds apart put a row on the wrong side of the boundary, and the wrong side here is
 *      an attempted row read as never-attempted.
 *   2. THE DOCUMENTED RECOVERY DID NOT RECOVER. `DELETE FROM settings WHERE key = …` was
 *      advertised as safe at any time, but the epoch was cached for the life of the process: a
 *      running server never saw the delete, so an operator following the runbook believed they had
 *      reset something they had not.
 *   3. A ROLLBACK DEFEATED IT. The epoch is established once, so rolling the binary BACK posts
 *      unstamped rows AFTER it, which the rule reads as never-attempted. The no-overlap deploy
 *      order round 9 leaned on does not help: a rollback is a sequential deploy, so the order is
 *      satisfied and the property still breaks.
 *
 * THE ANSWER IS TO MAKE THE PREMISE SELF-EVIDENCING — CARRIED BY THE ROW, NOT BY AN INSTANT.
 *
 * `accounting_sync_logs.attemptStampingCustodyAt` is that carrier. It is written by binaries that
 * stamp `remoteAttemptedAt` before every money call, and only by them:
 *
 *   - at CREATE, by every `accountingSyncLog.create` in this codebase (`stampingCustodyOnCreate`);
 *   - at CLAIM and at every other write that moves `processingStartedAt` forward
 *     (`stampingCustodyOnClaim`), because a claim is what precedes a post.
 *
 * and it is TAKEN AWAY, by the database itself, from any row a binary that does not know about it
 * claims. The trigger `accounting_sync_logs_forfeit_stamping_custody` (migration 20260819090000)
 * nulls the column on any UPDATE that starts a claim without re-asserting custody in the same
 * statement — where re-asserting means writing custody EQUAL TO THE CLAIM INSTANT, which is the
 * pair `stampingCustodyOnClaim` returns. A binary that has never heard of the column cannot write
 * it at all, so:
 *
 *   attemptStampingCustodyAt IS NOT NULL  ->  every binary that has created or claimed this row
 *                                             stamps before it posts, so a NULL stamp is proof.
 *   attemptStampingCustodyAt IS NULL      ->  something else had it. The NULL stamp proves nothing.
 *
 * WHAT THIS BUYS, FINDING BY FINDING.
 *
 *   1. NO CLOCK IS CONSULTED. The test is a NULL check on one column. Two clocks disagreeing can
 *      no longer move a row across a boundary, because there is no boundary. The column's VALUE is
 *      never compared with anything — only its presence is read (it is a timestamp rather than a
 *      boolean solely so the trigger's "did this statement re-assert custody?" test has something
 *      that changes on every write, and so an operator can see WHEN custody was taken).
 *   2. NOTHING IS CACHED, SO THERE IS NOTHING TO INVALIDATE. There is no settings key, no
 *      process-lifetime memo and no runbook step whose effect a running process could miss. The
 *      repair below re-runs at the top of every sync run.
 *   3. A ROLLBACK IS SELF-DECLARING. The rolled-back binary creates rows without the column (the
 *      default is NULL) and claims existing ones through the trigger (which nulls it). Both
 *      populations are then exactly the untrusted set, discovered from the rows themselves — no
 *      deploy order, no operator action, and no need to know a rollback happened at all.
 *
 * AND THE SAME FACT REPAIRS THE FENCE. `authoriseMoneyPost`'s rival-attempt query is
 * `remoteAttemptedAt: { not: null }` — deliberately narrow, and the partial index
 * `accounting_sync_logs_money_attempted_idx` depends on it staying that way — so a money row a
 * non-stamping binary posted from is invisible to it, whatever the recycle rule believes.
 * `repairMoneyAttemptsOutsideStampingCustody` closes that by stamping every money row that is
 * OUTSIDE custody and still unstamped, conservatively, with the best lower bound the row itself
 * carries. Both processors run it before they claim anything, so:
 *
 *   - a deploy window, an accidental overlap or a rollback is healed at the next sync run;
 *   - being wrong costs one extra ledger GET for that row, the same trade the migration's original
 *     backfill made;
 *   - in steady state the statement matches nothing and is served by a partial index of its own.
 *
 * IT IS NOT MEMOISED, AND THAT IS THE POINT. Round 9 ran its backfill once per database, which is
 * why a rollback could get underneath it. A repair that runs every sync run cannot: whatever the
 * rolled-back binary left behind is stamped the first time the new binary sweeps, before it claims
 * a single row.
 *
 * WHY THE ROW-LEVEL FACT ALSO NEEDS THAT REPAIR TO BE STICKY. Custody is re-asserted by our own
 * claim, so a row the old binary claimed (custody NULL) would look trustworthy again the moment
 * this binary re-claimed it. It never does: the repair converts "outside custody" into a permanent
 * `remoteAttemptedAt`, and it runs BEFORE the claim, in the same function. That ordering is a
 * property of this code — `processPendingXeroSync` and `processPendingQuickBooksSync` call it on
 * their first line — not of how anything is deployed, and it is pinned by a test.
 */

/**
 * The types `authoriseMoneyPost` stamps — `MONEY_MOVING_SYNC_TYPES` in followup-retry-guard.ts,
 * repeated rather than imported because that module imports this one's sibling and a cycle here
 * would be resolved at runtime inside a money path. Pinned to the fence's own set by a test: a
 * money type missing from here is a type whose out-of-custody rows are never repaired.
 */
export const STAMPED_MONEY_TYPES = ['INVOICE_PAYMENT', 'BILL_PAYMENT', 'PURCHASE_CREDIT_NOTE_ALLOCATION'] as const

/** The two columns that, together, can prove a money row is PRE-CALL. Neither proves it alone. */
export type MoneyAttemptProvenance = {
  remoteAttemptedAt: Date | null
  attemptStampingCustodyAt: Date | null
}

/**
 * THE CANONICAL "THIS ROW NEVER MADE A REMOTE CALL" TEST — one definition, every reader.
 *
 * `planFollowUpEnqueue` has asked this question since round 10 and spelled the predicate out inline.
 * `guardInvoicePaymentCapacity` needs the same question answered, and two spellings of "nothing was
 * sent" is exactly the failure mode `invoice-payment-capacity.ts` already refuses for
 * `storedBodyMayHaveReachedTheLedger` — two guards with two definitions disagree about whether an
 * invoice has capacity, which is the whole question. So it lives here, beside the mechanism that
 * makes it true, and both readers call it.
 *
 * BOTH HALVES ARE POSITIVE STATEMENTS ABOUT WHAT THE ROW SAYS, and the direction matters:
 *
 *   attemptStampingCustodyAt present  every binary that created or claimed this row stamps
 *                                     `remoteAttemptedAt` before it posts (see the header above),
 *                                     so the absence of that stamp is evidence rather than silence.
 *   remoteAttemptedAt null            and it is absent, so nothing ever left this row.
 *
 * ABSENCE OF A STAMP IS NOT PROOF OF NO ATTEMPT. Custody null means something outside custody had
 * this row and a NULL `remoteAttemptedAt` proves nothing at all — so does a column the caller did
 * not select, which arrives `undefined`. Both return false: only a positive record that the row is
 * pre-call excludes it, everything else stays undetermined and the caller must fail closed.
 *
 * It is deliberately NOT a statement about the row's STATUS. A caller decides which statuses it
 * wants to ask about; this only answers whether a call left.
 */
export function attemptProvenNeverMade(row: MoneyAttemptProvenance): boolean {
  return row.remoteAttemptedAt === null && row.attemptStampingCustodyAt != null
}

/**
 * Custody for a row this binary is CREATING.
 *
 * Every `accountingSyncLog.create` in this codebase spreads this. A row created without it is a
 * row whose NULL `remoteAttemptedAt` can never be trusted again — safe, but it permanently gives
 * up the revival bookkeeping for that scope, so the omission is pinned by a source-scanning test
 * rather than left to reviewers.
 *
 * The value is only ever read as present/absent. It is `new Date()` rather than anything derived
 * from the row so that no caller has to have a timestamp to hand.
 */
export function stampingCustodyOnCreate(now: Date = new Date()): { attemptStampingCustodyAt: Date } {
  return { attemptStampingCustodyAt: now }
}

/**
 * Custody for a row this binary is CLAIMING — or re-gating, which is the same write with a future
 * timestamp (the retry backoff parks a row by moving `processingStartedAt` ahead).
 *
 * Returns BOTH fields so the pairing cannot be half-applied: the database's trigger reads a claim
 * whose custody does not EQUAL its own claim instant as one made by a binary that does not stamp,
 * and forfeits custody. That failure is deliberately the safe direction — a missed pairing
 * costs one ledger GET and one un-recycled row, never a lost attempt — but it is still a defect,
 * so the two values are produced together, from the same instant, by this function.
 */
export function stampingCustodyOnClaim(
  processingStartedAt: Date,
): { processingStartedAt: Date; attemptStampingCustodyAt: Date } {
  return { processingStartedAt, attemptStampingCustodyAt: processingStartedAt }
}

/**
 * Stamp every money row that is outside stamping custody and has no attempt recorded, so
 * `authoriseMoneyPost`'s rival query can see it. Returns how many rows that was — zero on every
 * run that follows an ordinary deploy.
 *
 * Called at the top of both sync processors, BEFORE anything is claimed. A non-zero count means a
 * binary that does not stamp has handled money rows on this database (a deploy window, an overlap,
 * or a rollback), which is worth an operator's attention, so the callers log it.
 */
export async function repairMoneyAttemptsOutsideStampingCustody(): Promise<number> {
  // The conservative value the migration's backfill used: the best lower bound the row itself
  // carries, never `now()`, which would claim an attempt happened at repair time. `updateMany`
  // cannot express a per-row COALESCE, hence raw SQL; the only interpolation is the type list, as
  // a bound parameter.
  //
  // The type list is the CONSTANT, not a second copy of it written out in SQL: a literal list here
  // could silently fall out of step with the set the fence actually stamps, and a money type
  // missing from it would be a type this whole mechanism skips. `::text` casts the enum so it can
  // be compared with a bound text array.
  //
  // `attemptStampingCustodyAt IS NULL` is the whole test, and it is the same predicate as the
  // partial index `accounting_sync_logs_money_attempt_uncustodied_idx`, so this statement is served
  // by an index that is empty in steady state rather than by a scan of every sync row ever written.
  // Imported HERE rather than at module scope so the two PURE helpers above —
  // `stampingCustodyOnCreate` and `stampingCustodyOnClaim` — can be reached without constructing a
  // Prisma client. `sync-claim-fence.ts` now uses the claim helper to keep custody across every
  // non-terminal release, and it is imported by modules whose tests build no database at all.
  const { db } = await import('@/lib/db')
  return db.$executeRaw`
    UPDATE "accounting_sync_logs"
       SET "remoteAttemptedAt" = COALESCE("syncedAt", "processingStartedAt", "createdAt")
     WHERE "remoteAttemptedAt" IS NULL
       AND "attemptStampingCustodyAt" IS NULL
       AND "type"::text = ANY(${[...STAMPED_MONEY_TYPES]}::text[])
  `
}
