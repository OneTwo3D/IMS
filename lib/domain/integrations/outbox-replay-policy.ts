/**
 * WHAT A STALE-LOCK RECLAIM ACTUALLY GRANTS, AND WHY THAT IS A PER-OPERATION QUESTION (o3d-8td2).
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
 * Whether that matters therefore depends entirely on WHAT THE EFFECT IS, which is a property of the
 * operation and of nothing in this subsystem. It was written down nowhere until this file existed,
 * and a registry entry with two fields let a new operation be added — one has been, since o3d-8td2
 * was filed — with nobody having answered it.
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
   * value true of an operation is a named local guard that a SECOND, CONCURRENT execution runs into:
   * a row lock, a uniqueness key, or a completion that commits inside the same transaction as the
   * effect. The guard has to be named in the registry entry's own comment, so this value can be
   * checked against the code rather than taken on trust.
   */
  | 'local-only-guarded'
  /**
   * A REMOTE WRITE THAT A REPEAT CANNOT MAKE WRONG.
   *
   * True only of an ABSOLUTE assignment whose value the sender recomputes from IMS state at push
   * time — two pushes racing write the same field, the later one wins, and the later one is the
   * fresher read. Nothing accumulates and nothing is minted. An operation that CREATES a remote
   * document, appends, increments, or sends a message is never this, whatever its own retry story.
   */
  | 'remote-write-idempotent'
  /**
   * A REMOTE WRITE THAT A REPEAT WOULD DAMAGE, MADE SAFE BY A FENCE THE CONSUMER TAKES ITSELF.
   *
   * The outbox lease is NOT that fence and must not be mistaken for it. This value asserts that the
   * consumer re-proves its claim immediately before the socket and records the dispatch before it,
   * so a reclaimed row cannot be re-posted by the loser — i.e. the operation is safe DESPITE the
   * reclaim, not BECAUSE of it. The fence must be named in the registry entry's comment.
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
   * Nothing registered today is this. It is here because the type must be able to express the
   * answer "no" — a policy vocabulary in which every value means "safe" would record agreement it
   * never obtained.
   */
  | 'unsafe-to-replay'

/** Every answer, exported so a test can assert the registry only ever uses these. */
export const OUTBOX_REPLAY_SAFETY_VALUES = [
  'local-only-guarded',
  'remote-write-idempotent',
  'remote-write-fenced-by-consumer',
  'unsafe-to-replay',
] as const

/**
 * May a row for an operation with this policy be taken from a holder whose lock has merely gone
 * stale? Every answer but the last one says yes, and says WHY in its own documentation.
 */
export function outboxReplayPolicyGrantsStaleReclaim(policy: OutboxReplaySafety): boolean {
  return policy !== 'unsafe-to-replay'
}
