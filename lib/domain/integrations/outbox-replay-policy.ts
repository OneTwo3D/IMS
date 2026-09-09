/**
 * WHAT A STALE-LOCK RECLAIM ACTUALLY GRANTS, AND WHY THAT IS A PER-EFFECT QUESTION (o3d-8td2).
 *
 * `claimIntegrationOutboxWork` re-grants a PROCESSING row whose `lockedAt` is older than
 * `staleLockMs`. The handover itself is sound: the claim update compare-and-sets on the exact
 * `lockedAt` and `lockedBy` the candidate was read with (under the same status and attempt-cap
 * checks), so exactly one worker wins it, and every `markIntegrationOutbox*` helper fences on that
 * same (lockedBy, lockedAt) pair — a previous holder that comes back cannot complete, fail or retry
 * a row it no longer owns. Two workers can never disagree about who holds the ROW.
 *
 * THAT IS NOT THE QUESTION. A lease expiry is a statement about TIME, not about OUTCOME — the same
 * sentence `lib/domain/wms/create-replay-policy.ts` was written to say about the WMS create claim.
 * `lockedAt < now - staleLockMs` cannot distinguish a holder that DIED from one that is merely
 * SLOW: a process stopped rather than dead (SIGSTOP, a frozen VM, a host paused mid-syscall) resumes
 * and finishes its work with no bound at all, and `lockedBy` is a per-drain CONSTANT rather than a
 * per-process identity, so it names the duty and not the incumbent. So the reclaim hands a second
 * worker the row while the first may still be executing the operation's EFFECT, and the CAS says
 * nothing whatever about what that first holder already did.
 *
 * TWO SEPARATE PROPERTIES, AND ROUND 1 OF THIS FILE CONFLATED THEM (Codex round 2, both HIGHs).
 *
 *   IDEMPOTENCE asks: if this effect happens TWICE, is the end state the same as once?
 *   ORDERING     asks: if the two executions land in the WRONG ORDER, is the end state still right?
 *
 * An ABSOLUTE assignment answers the first and NOT the second. Writing `stock_quantity = 10` twice
 * leaves 10; but a value computed by the slow worker BEFORE the pause and delivered AFTER the fresh
 * worker's value overwrites the fresher one with an older one, and the end state is a quantity IMS
 * stopped believing minutes ago. Repetition-safe is not order-safe, and the reclaim is precisely a
 * machine for producing out-of-order deliveries: it exists to let a second worker overtake a first
 * that has not finished. Every answer below must therefore be justified against BOTH questions.
 *
 * A CLAIM PROOF TAKEN BEFORE THE EFFECT ANSWERS NEITHER ON ITS OWN. Re-proving ownership immediately
 * before the socket narrows the window between "I still hold this" and "it has landed"; it cannot
 * close it, because the effect and the completion are not one atomic act. What closes it is evidence
 * that OUTLIVES the worker: a record written before the effect that the next attempt reads, a
 * uniqueness key the second insert collides with, or a completion that commits in the same
 * transaction as the effect itself.
 *
 * AND THE DECLARATION'S KEY MUST BE THE EFFECT, NOT A PROXY FOR SEVERAL. `xero/accounting.post` is
 * one outbox operation multiplexing every `AccountingSyncType`: a sales invoice, a payment, a PDF
 * download, a customer email. One verdict over that set is an AVERAGE, and an average reads as an
 * answer while asserting nothing about the member that matters. See {@link OutboxEffectScope}: an
 * entry has to say whether its operation IS its effect, and one that admits it is not cannot be
 * declared replay-safe at all — neither by hand nor by {@link resolveOutboxReplaySafety}, which
 * folds it to `unsafe-to-replay` at runtime whatever the `replay` field says.
 *
 * Whether any of this matters therefore depends entirely on WHAT THE EFFECT IS, which is a property
 * of the operation and of nothing in this subsystem. It was written down nowhere until this file
 * existed, and a registry entry with two fields let a new operation be added — one has been, since
 * o3d-8td2 was filed — with nobody having answered it.
 *
 * The declaration lives ON the registry entry rather than in a parallel table keyed by the registry,
 * because the failure this repository keeps hitting is one rule with several readers where only one
 * gets updated. A parallel `Record` can be exhaustive and still be edited apart from the schema it
 * describes; a required field cannot be. `tsc` refuses a new registered operation until somebody has
 * chosen one of the answers below.
 */
export type OutboxReplaySafety =
  /**
   * NOTHING LEAVES THE PROCESS, and the local effect carries its own exclusion.
   *
   * "No remote write" is NOT on its own an answer — a purely local effect can be just as
   * non-repeatable as a remote one (re-running allocation is the standing example). What makes this
   * value true of an operation is a named local guard that a SECOND, CONCURRENT execution runs into
   * — a row lock, a uniqueness key, or a completion that commits inside the same transaction as the
   * effect.
   *
   * THE GUARD HAS TO SIT BETWEEN THE RESUME AND THE EFFECT, not between the claim and the effect.
   * That is what makes it answer the ORDERING question as well as the idempotence one: a slow
   * worker that wakes after a reclaim re-enters the guard before it can do anything, and finds the
   * fresher worker's work already there. A check performed once at the top of the job and trusted
   * afterwards is not this value.
   *
   * The guard has to be named in the registry entry's own comment, so this value can be checked
   * against the code rather than taken on trust.
   */
  | 'local-only-guarded'
  /**
   * A REMOTE WRITE THAT NEITHER A REPEAT NOR A REORDERING CAN MAKE WRONG.
   *
   * BOTH halves are required, and the second is the one round 1 of this file got wrong. An ABSOLUTE
   * assignment recomputed from IMS state satisfies the first: two pushes writing the same field
   * leave the field holding one of them, nothing accumulates and nothing is minted. It does NOT
   * satisfy the second: if the sender computes the value, and the remote write lands after a
   * fresher worker's, the remote is left holding the OLDER value with nothing queued to correct it.
   *
   * So this value additionally asserts an ORDERING GUARANTEE THE REMOTE ENFORCES: a generation or
   * version the receiver compares and rejects a regression on, a conditional write, or an equivalent
   * protocol under which an older computed value cannot land last. A local compare-and-set before
   * the send is NOT that guarantee — it narrows the pause window and leaves the hazard.
   *
   * An operation that CREATES a remote document, appends, increments, or sends a message is never
   * this, whatever its own retry story.
   *
   * NOTHING IS DECLARED THIS TODAY. `woocommerce/stock.push` was, and the WooCommerce products
   * batch endpoint carries no such token, which is what disqualified it.
   */
  | 'remote-write-idempotent'
  /**
   * A REMOTE WRITE THAT A REPEAT WOULD DAMAGE, MADE SAFE BY A FENCE THE CONSUMER TAKES ITSELF.
   *
   * The outbox lease is NOT that fence and must not be mistaken for it. Nor is a claim renewal on
   * its own: re-proving ownership immediately before the socket says the row was still this
   * worker's a moment ago, and says nothing at all about whether the effect then landed, because
   * the effect and the completion are separate acts and a pause can fall between them.
   *
   * What this value asserts is DURABLE DISPATCH EVIDENCE, written before the effect, in the same
   * statement that re-proves the claim, and READ BY THE NEXT ATTEMPT — so a second worker that
   * reclaims the row finds the record of the first worker's send and does not repeat it. The fence
   * and the evidence must both be named in the registry entry's comment. An operation whose fence
   * proves ownership but records nothing has narrowed a window, not closed one, and is
   * `unsafe-to-replay`.
   */
  | 'remote-write-fenced-by-consumer'
  /**
   * NEITHER. A second execution can do real damage and nothing stands in its way.
   *
   * An operation declared this way is NOT handed to a second worker on a stale lock: the row stays
   * PROCESSING and an operator resolves it, which is the same trade
   * `wmsAmbiguousCreateMayBeReplayed` makes — a stalled row somebody has to look at, against a
   * duplicate nobody notices. The exit exists: `permanentlyFailIntegrationOutboxAdminRow` will
   * dead-letter a PROCESSING row precisely once its lock has gone stale, so the park is a park and
   * not a leak.
   *
   * THE PARK HAS ITS OWN COST and declaring it is not free. A row nobody reclaims is a row whose
   * work does not happen until a human acts, and for an operation whose enqueue path folds new work
   * into the existing row rather than creating another, that means the work keeps NOT happening.
   * `woocommerce/stock.push` is exactly that shape (o3d-8td2 follow-up); the trade was still taken,
   * because a parked row is visible in the outbox admin and an unrecallable wrong quantity at
   * WooCommerce is not.
   */
  | 'unsafe-to-replay'

/**
 * IS THIS OPERATION ITS OWN EFFECT, OR A KEY STANDING IN FOR SEVERAL? (o3d-8td2 round 2.)
 *
 * The reclaim predicate is a query over `IntegrationOutbox`, so the finest grain it can decide at is
 * the (connector, operation) pair the row carries. When an operation's real effects vary by
 * something the ROW does not carry — `xero/accounting.post` discriminates on the
 * `AccountingSyncType` of the `AccountingSyncLog` its payload points at — the declaration's key is a
 * PROXY, and any single verdict silently averages over the set.
 *
 * Rather than let that average be written, the type refuses it: an entry whose effects are keyed by
 * a sub-operation may only be declared `unsafe-to-replay`, and {@link resolveOutboxReplaySafety}
 * folds it there at runtime as well, so neither a hand edit nor a future caller can route around it.
 *
 * TO MAKE SUCH AN OPERATION RECLAIMABLE, one of two things has to happen first, and both are
 * deliberate, reviewed acts rather than an edit to a verdict string:
 *   1. put the discriminator ON the outbox row, and register one operation per effect; or
 *   2. establish the weakest answer for EVERY member of the discriminator's domain, exhaustively
 *      (the `Record<AccountingSyncType, …>` idiom `POST_EFFECT` already uses), and widen this type
 *      to carry that table.
 */
export type OutboxEffectScope =
  /** The row's operation IS the effect: one registered operation, one kind of thing done. */
  | { keyedBy: 'operation' }
  /**
   * The row multiplexes several kinds of effect, discriminated by a field the outbox row does not
   * carry. `discriminator` names it; `weakestKnownEffect` names the member that set the verdict, so
   * the reason survives in the code rather than only in a review thread.
   */
  | { keyedBy: 'sub-operation'; discriminator: string; weakestKnownEffect: string }

/** Every answer, exported so a test can assert the registry only ever uses these. */
export const OUTBOX_REPLAY_SAFETY_VALUES = [
  'local-only-guarded',
  'remote-write-idempotent',
  'remote-write-fenced-by-consumer',
  'unsafe-to-replay',
] as const

/**
 * The answer that actually governs, which is not always the one written down.
 *
 * A multiplexing operation cannot carry a single verdict (see {@link OutboxEffectScope}). `tsc`
 * already refuses to let one be declared safe; this fold is the same rule at runtime, so a registry
 * built dynamically, cast, or edited past the type still cannot hand such a row to a second worker.
 */
export function resolveOutboxReplaySafety(declaration: {
  replay: OutboxReplaySafety
  effects: OutboxEffectScope
}): OutboxReplaySafety {
  return declaration.effects.keyedBy === 'operation' ? declaration.replay : 'unsafe-to-replay'
}

/**
 * May a row for an operation with this policy be taken from a holder whose lock has merely gone
 * stale? Every answer but the last one says yes, and says WHY in its own documentation.
 */
export function outboxReplayPolicyGrantsStaleReclaim(policy: OutboxReplaySafety): boolean {
  return policy !== 'unsafe-to-replay'
}
