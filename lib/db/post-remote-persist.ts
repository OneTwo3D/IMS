import { writeSync } from 'node:fs'

/**
 * RECORDING A WRITE THAT HAS ALREADY LEFT FOR THE LEDGER (o3d-xl63 round 2, finding 2).
 *
 * `DB_POOL_ACQUISITION_TIMEOUT_MS` bounds how long a caller may queue for a connection. That bound is
 * right for a PRE-FLIGHT wait — nothing has happened yet, so failing fast sheds load and the work is
 * simply re-driven later. It is exactly WRONG for the acquisition a worker makes AFTER posting to
 * Xero, whose only purpose is to write down what it just did:
 *
 *   POST /Payments  ->  200, PaymentID  ->  db.$transaction(record SYNCED + externalTransactionId)
 *                                            ^ this connection
 *
 * Under pool pressure that second acquisition now FAILS where it previously waited. The payment is
 * in the ledger; the row that proves it is not. The next attempt sees a FAILED row with no external
 * id, re-posts, and — because Xero forgets an Idempotency-Key after six minutes and every automatic
 * retry is scheduled minutes later (see `idempotency-retention.ts`) — the ledger takes a SECOND
 * payment. A bound meant to protect a sweep's tick budget would have manufactured a duplicate.
 *
 * So the two acquisitions are distinguished HERE rather than in the pool: the pool keeps its single
 * fail-fast bound, and a persist that follows a completed remote write is RE-DRIVEN across it until
 * a connection comes free or the deadline its CLAIM allows is reached.
 *
 * ONLY A FAILURE TO START IS RETRIED, and that restriction is the whole soundness argument. A caller
 * whose transaction never started provably ran no statement, so re-driving it cannot double-apply
 * anything. Any other failure — a unique violation, a serialization failure, a statement timeout —
 * may have executed some or all of the transaction, and blindly repeating it for minutes would be a
 * second defect. Those rethrow immediately, exactly as before.
 *
 * AND IT IS STILL BOUNDED. Waiting for ever is what o3d-xl63 removed, and it is not coming back
 * through this door: past the deadline the persist gives up and throws — but throws something that
 * NAMES the hazard, so the sync row's errorMessage says a remote write went unrecorded instead of
 * reporting a generic connection error that reads like nothing happened.
 */

/**
 * WHAT THE PRODUCTION STACK ACTUALLY RAISES (round 3, finding 1 — measured, not reasoned).
 *
 * Round 2 matched pg-pool's `timeout exceeded when trying to connect` and walked `cause` for it. Its
 * tests drove a raw `pg.Pool`, so that is exactly what they saw. PRODUCTION DOES NOT GO THROUGH
 * `pool.connect()`; it goes through `db.$transaction(async (tx) => ...)` on a PrismaClient built with
 * the `@prisma/adapter-pg` config form, and an interactive transaction carries Prisma's OWN
 * start-timeout — `maxWait`, default 2000ms — which is FIVE TIMES SHORTER than the 10s pool bound and
 * therefore always fires first. Driven against @prisma/client 7.7.0 + @prisma/adapter-pg 7.7.0 with
 * the real `dbPoolConfig()` and the pool exhausted, the three shapes are:
 *
 *   db.$transaction(async tx => ...)            settles after 2002ms
 *     PrismaClientKnownRequestError  code P2028
 *     "Transaction API error: Unable to start a transaction in the given time."
 *     cause: NONE.                              <- round 2's matcher returns FALSE
 *
 *   db.$transaction(..., { maxWait: 5000 })     settles after 5000ms — same P2028, same absent cause
 *
 *   plain db.model.update(...)                  settles after 10022ms
 *     Error "timeout exceeded when trying to connect"   <- the only shape round 2 matched, and the
 *     cause: NONE (the pg text is the error's OWN message, not a `cause`)
 *
 * Two corrections follow, and the fix is both of them. First, P2028-unable-to-start IS an acquisition
 * failure and must be re-driven: `$transaction` throws it BEFORE it ever invokes the callback, so the
 * persist body provably did not run — the same soundness argument, reached a different way, and
 * `tests/db/post-remote-persist.test.ts` asserts the callback ran zero times against the real client.
 * Second, the pg text arrives as the error's own message with no `cause` at all, so the chain walk was
 * never the thing carrying it; it is kept because a wrapped shape costs nothing to tolerate.
 *
 * P2028 IS NOT MATCHED ON CODE ALONE. Prisma reuses P2028 for "Transaction already closed" and
 * "Transaction not found", which describe a transaction that HAD started and so may have executed
 * statements. Only the start-timeout message is re-driven; the rest rethrow.
 */

/**
 * The ceiling on a post-remote persist, whatever the claim allows.
 *
 * Two minutes: comfortably longer than any pre-flight bound (10s pool acquisition, 5s Prisma
 * `maxWait`), so genuine pool pressure has time to clear, and short enough that one row cannot eat a
 * sweep tick on its own. It is a CEILING, not the deadline — the deadline is derived from the claim
 * this worker holds, and is shorter whenever the claim has less than this left (see
 * `postRemotePersistDeadlineMs`).
 */
export const POST_REMOTE_PERSIST_MAX_DEADLINE_MS = 2 * 60 * 1000

/**
 * How much of the claim is kept back for the give-up path (round 3, finding 2).
 *
 * The persist must be finished AND its terminal evidence written while this worker still owns the
 * row, because the moment the claim goes stale another worker may reclaim it, see no
 * `externalTransactionId`, and post the document a second time. So the deadline stops short of the
 * claim expiry by this much, which has to cover: the attempt in flight when the deadline passes (at
 * most one `maxWait`/pool acquisition, ~10s), the single-statement recovery write that follows it
 * (at most one pool acquisition, ~10s), and clock skew between this worker and the next.
 */
export const CLAIM_SAFETY_MARGIN_MS = 60 * 1000

/** How long to wait between attempts. Short: the pool frees a connection on any release. */
export const POST_REMOTE_PERSIST_RETRY_DELAY_MS = 250

/**
 * The claim that makes a re-drive safe: this worker owns the row from `heldFrom` until
 * `heldFrom + staleAfterMs`, after which any worker may take it.
 */
export type PersistClaim = {
  /** When the claim was taken — the sync log's `processingStartedAt`, not "now". */
  heldFrom: Date | number
  /** How long a claim survives before another worker may treat it as stale. */
  staleAfterMs: number
}

/**
 * How long this persist may keep trying, ANCHORED TO THE CLAIM rather than chosen (round 3, #2).
 *
 * Round 2 picked two minutes and said it was "keyed to" the 15-minute stale-claim cutoff. Nothing
 * enforced that: the two numbers never met, and the claim can have far less than two minutes left by
 * the time a persist starts — the Xero post that precedes it can itself sit on rate-limit waits for
 * minutes. Here the relationship is arithmetic. The result is what the CLAIM allows, capped by the
 * ceiling, and it is 0 when the claim has already lapsed (in which case another worker may already be
 * on this row, so re-driving is no longer provably safe and the give-up path runs immediately).
 */
export function postRemotePersistDeadlineMs(
  claim: PersistClaim,
  now: number = Date.now(),
  maxDeadlineMs: number = POST_REMOTE_PERSIST_MAX_DEADLINE_MS,
): number {
  const heldFrom = claim.heldFrom instanceof Date ? claim.heldFrom.getTime() : claim.heldFrom
  if (!Number.isFinite(heldFrom) || !Number.isFinite(claim.staleAfterMs)) return 0
  const remaining = heldFrom + claim.staleAfterMs - CLAIM_SAFETY_MARGIN_MS - now
  return Math.max(0, Math.min(maxDeadlineMs, remaining))
}

/**
 * The messages a failure-to-START arrives as, lowercased.
 *
 * - `unable to start a transaction in the given time` — Prisma P2028, the interactive-transaction
 *   `maxWait` expiring. THE PRODUCTION SHAPE (see the block above).
 * - `timeout exceeded when trying to connect` — pg-pool's `connectionTimeoutMillis`. What a plain,
 *   non-transactional statement raises, which is the path the terminal recovery write takes.
 * - `timed out fetching a new connection from the connection pool` — Prisma's own pool bound, from
 *   the Rust engine. Not reachable with a driver adapter; kept so a future engine swap is covered.
 *
 * All three mean the same thing and only that thing: no transaction started, therefore no statement
 * ran, therefore nothing to be idempotent about.
 */
const START_TIMEOUT_MARKERS = [
  'unable to start a transaction in the given time',
  'timeout exceeded when trying to connect',
  'timed out fetching a new connection from the connection pool',
] as const

function messagesOf(error: unknown, depth = 0): string[] {
  if (depth > 5 || error == null) return []
  if (typeof error === 'string') return [error]
  if (typeof error !== 'object') return []
  const record = error as { message?: unknown; cause?: unknown }
  const own = typeof record.message === 'string' ? [record.message] : []
  return [...own, ...messagesOf(record.cause, depth + 1)]
}

/**
 * Did this error mean "no statement was ever executed"? Only then is a re-drive provably safe.
 *
 * Named for what it now covers: the connection was never acquired, OR the transaction never started.
 * Both are decided by the message, because P2028 also labels failures of a transaction that HAD
 * started and those must not be repeated.
 */
export function isConnectionAcquisitionTimeout(error: unknown): boolean {
  return messagesOf(error).some((message) => {
    const lower = message.toLowerCase()
    return START_TIMEOUT_MARKERS.some((marker) => lower.includes(marker))
  })
}

/**
 * The reason a persist is refused OUTRIGHT rather than attempted (round 4, finding 2).
 *
 * Not a database failure at all: the claim this worker holds no longer covers the write, so another
 * worker may already own the row.
 */
export const LAPSED_CLAIM_REASON =
  'the claim on this row no longer covers a persist, so another worker may already own it'

/** Thrown when the record of a completed remote write could not be persisted at all. */
export class UnrecordedRemoteWriteError extends Error {
  readonly attempts: number
  readonly elapsedMs: number
  readonly deadlineMs: number

  constructor(what: string, attempts: number, elapsedMs: number, deadlineMs: number, cause: unknown) {
    super(
      (attempts === 0
        ? `A completed remote write (${what}) was NOT recorded locally and was NOT ATTEMPTED: the `
          + `deadline derived from this worker's claim was 0 (deadline ${deadlineMs}ms, set by how much `
          + `of this worker's claim was left), so the claim had already lapsed — or had only the safety `
          + `margin left — by the time the record was reached. The ordinary persist updates the row by `
          + `id with no claim fence, so running it here could trample a row another worker has already `
          + `taken and is posting under. `
        : `A completed remote write (${what}) could NOT be recorded locally: no database transaction `
          + `could be started after ${attempts} attempt(s) over ${elapsedMs}ms (deadline ${deadlineMs}ms, `
          + `set by how much of this worker's claim was left). `)
        + `The remote system holds the document; this system `
        + `does not know its id. Check the connector before re-driving this row. `
        + `Cause: ${messagesOf(cause)[0] ?? String(cause)}`,
      { cause },
    )
    this.name = 'UnrecordedRemoteWriteError'
    this.attempts = attempts
    this.elapsedMs = elapsedMs
    this.deadlineMs = deadlineMs
  }
}

export type PostRemotePersistOptions = {
  /**
   * REQUIRED. The claim this worker holds on the row being recorded. The deadline is derived from it,
   * so a caller cannot pick a duration that outlives its own exclusivity — which is the double-post
   * this whole helper exists to prevent.
   */
  claim: PersistClaim
  /** Ceiling on the derived deadline. Tests narrow it; production takes the default. */
  maxDeadlineMs?: number
  retryDelayMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  onRetry?: (detail: { what: string; attempts: number; elapsedMs: number; deadlineMs: number }) => void
}

/**
 * Run a persist that records an ALREADY-COMPLETED remote write, re-driving it across failures to
 * start a transaction until the deadline its claim allows.
 *
 * `what` names the write in the error an operator will read, so pass something identifying (the sync
 * log id and the operation), not a category.
 */
export async function persistAfterRemoteWrite<T>(
  what: string,
  persist: () => Promise<T>,
  options: PostRemotePersistOptions,
): Promise<T> {
  const retryDelayMs = options.retryDelayMs ?? POST_REMOTE_PERSIST_RETRY_DELAY_MS
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const onRetry = options.onRetry ?? ((detail) => {
    console.error(
      `[post-remote-persist] ${detail.what}: no transaction for the record of a completed remote write `
        + `(attempt ${detail.attempts}, ${detail.elapsedMs}ms elapsed of ${detail.deadlineMs}ms) — retrying `
        + `rather than losing it`,
    )
  })

  const startedAt = now()
  const deadlineMs = postRemotePersistDeadlineMs(options.claim, startedAt, options.maxDeadlineMs)

  // ZERO MEANS ZERO ATTEMPTS, NOT ONE (round 4, finding 2).
  //
  // Round 3 made the deadline arithmetic — `Math.max(0, ...)` — and wrote down what 0 means: "the
  // claim has already lapsed, another worker may already be on this row, so re-driving is no longer
  // provably safe and the give-up path runs immediately". The loop below did not implement that. It
  // attempts FIRST and only compares elapsed against the deadline in the CATCH, so a deadline of 0
  // bought exactly one execution of the persist — the one execution the clamp existed to prevent.
  //
  // That single attempt is not harmless, because the persist it runs is not claim-fenced: the Xero
  // one is `accountingSyncLog.update({ where: { id } })`, which will happily flip a row that another
  // worker has re-claimed and is at that moment posting under, to SYNCED with THIS worker's external
  // id. Two documents in the ledger, one id recorded, and the row says it is finished.
  //
  // The give-up path is strictly better here and always was: its terminal write is a single statement
  // fenced on `processingStartedAt`, so it records the id when the claim is genuinely still ours and
  // does nothing at all when it is not — and it says which of the two happened. So a lapsed claim goes
  // straight there, with the id, having touched nothing.
  if (deadlineMs <= 0) {
    throw new UnrecordedRemoteWriteError(what, 0, 0, deadlineMs, new Error(LAPSED_CLAIM_REASON))
  }

  let attempts = 0
  for (;;) {
    attempts += 1
    try {
      return await persist()
    } catch (error) {
      if (!isConnectionAcquisitionTimeout(error)) throw error
      const elapsedMs = now() - startedAt
      if (elapsedMs >= deadlineMs) {
        throw new UnrecordedRemoteWriteError(what, attempts, elapsedMs, deadlineMs, error)
      }
      onRetry({ what, attempts, elapsedMs, deadlineMs })
      // Never sleep past the deadline: the give-up path needs the margin it was promised.
      await sleep(Math.min(retryDelayMs, deadlineMs - elapsedMs))
    }
  }
}

/**
 * EVIDENCE THAT DOES NOT DEPEND ON THE THING THAT FAILED (round 3, finding 3).
 *
 * When the re-drive gives up, what must survive is the external id of a document the remote system
 * already holds. Round 2 left that to the caller's ordinary failure handling, which is a
 * `db.$transaction` — a connection from the pool that has just spent the entire deadline refusing to
 * give one out. In precisely the case where the evidence matters most, the evidence could not be
 * written, and the throw propagated out of the sweep instead.
 *
 * So the FIRST record of an unrecorded write is written here, to a sink whose only precondition is
 * the one fact it is protecting: that this process is still holding the id. `writeSync` to fd 2 —
 * no pool, no connection, no queue, no async flush that a dying process can lose. It is one line,
 * prefixed with a fixed marker so it can be grepped and alerted on, and it carries the id itself
 * rather than a pointer to a row that does not have it.
 *
 * A database record is still attempted afterwards by the caller, because a row an operator can see
 * beats a log line — but it is attempted AFTER this, never instead of it, and `recorded: false` says
 * so out loud when it fails too.
 */
export const UNRECORDED_REMOTE_WRITE_MARKER = '[UNRECORDED-REMOTE-WRITE]'

export type UnrecordedRemoteWriteReport = {
  /** The identifying name passed to `persistAfterRemoteWrite`. */
  what: string
  /** THE EVIDENCE: the remote document's id, if the caller knows it. */
  externalId: string | null
  /** Anything else that identifies the row and the document (sync log id, type, reference). */
  detail?: Record<string, unknown>
  attempts: number
  elapsedMs: number
  /** Whether a durable (database) record of this was achieved. `false` means this line is all there is. */
  recorded: boolean
  /** Why the persist gave up, and — when `recorded` is false — why the fallback write failed too. */
  reason: string
}

function writeStderrLine(line: string): void {
  try {
    // Synchronous, straight at fd 2. `console.error` would do in the ordinary case, but the case
    // this exists for is a process under enough pressure to be killed or to exit before an async
    // stream flush completes — and then the only record of the document's id would be gone.
    writeSync(2, line.endsWith('\n') ? line : `${line}\n`)
  } catch {
    console.error(line)
  }
}

/**
 * Emit the unrecorded-write record. Never throws: a reporter that can fail is not a reporter.
 */
export function reportUnrecordedRemoteWrite(
  report: UnrecordedRemoteWriteReport,
  write: (line: string) => void = writeStderrLine,
): void {
  let line: string
  try {
    line = `${UNRECORDED_REMOTE_WRITE_MARKER} ${JSON.stringify({
      at: new Date().toISOString(),
      ...report,
    })}`
  } catch {
    line = `${UNRECORDED_REMOTE_WRITE_MARKER} what=${report.what} externalId=${report.externalId} `
      + `recorded=${report.recorded} reason=${report.reason}`
  }
  try {
    write(line)
  } catch {
    // Nothing left to try. Losing the process is not worse than losing the line, but it is not better.
  }
}
