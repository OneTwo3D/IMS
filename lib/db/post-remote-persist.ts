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
 * a connection comes free or a much longer deadline is reached.
 *
 * ONLY AN ACQUISITION TIMEOUT IS RETRIED, and that restriction is the whole soundness argument. A
 * caller that never got a connection provably ran no statement, so re-driving it cannot double-apply
 * anything. Any other failure — a unique violation, a serialization failure, a statement timeout —
 * may have executed some or all of the transaction, and blindly repeating it for two minutes would be
 * a second defect. Those rethrow immediately, exactly as before.
 *
 * AND IT IS STILL BOUNDED. Waiting for ever is what o3d-xl63 removed, and it is not coming back
 * through this door: past the deadline the persist gives up and throws — but throws something that
 * NAMES the hazard, so the sync row's errorMessage says a remote write went unrecorded instead of
 * reporting a generic connection error that reads like nothing happened.
 */

/**
 * How long a post-remote persist may keep trying for a connection.
 *
 * Two minutes: comfortably longer than any pre-flight bound (10s pool acquisition, 5s Prisma
 * `maxWait`), so genuine pool pressure has time to clear, and comfortably INSIDE the accounting
 * processor's 15-minute stale-claim cutoff (`CLAIM_STALE_MS`), so a worker still trying to record its
 * own post can never be overtaken by another worker reclaiming the row and posting it again.
 */
export const POST_REMOTE_PERSIST_DEADLINE_MS = 2 * 60 * 1000

/** How long to wait between attempts. Short: the pool frees a connection on any release. */
export const POST_REMOTE_PERSIST_RETRY_DELAY_MS = 250

/**
 * The messages a failure-to-ACQUIRE arrives as, lowercased.
 *
 * - pg-pool throws `timeout exceeded when trying to connect` when `connectionTimeoutMillis` fires;
 *   that is the exact string the round-1 bound produces (tests/db/pool-acquisition-bound.test.ts).
 * - Prisma's own pool bound says `Timed out fetching a new connection from the connection pool`.
 *
 * Both mean the same thing and only that thing: no connection, therefore no statement, therefore
 * nothing to be idempotent about. Matched on the message because a driver-adapter error reaches the
 * caller wrapped, with the driver's text carried in the message or in `cause`.
 */
const ACQUISITION_TIMEOUT_MARKERS = [
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
 * Did this error mean "no connection was ever handed out"? Only then is a re-drive provably safe.
 */
export function isConnectionAcquisitionTimeout(error: unknown): boolean {
  return messagesOf(error).some((message) => {
    const lower = message.toLowerCase()
    return ACQUISITION_TIMEOUT_MARKERS.some((marker) => lower.includes(marker))
  })
}

/** Thrown when the record of a completed remote write could not be persisted at all. */
export class UnrecordedRemoteWriteError extends Error {
  readonly attempts: number
  readonly elapsedMs: number

  constructor(what: string, attempts: number, elapsedMs: number, cause: unknown) {
    super(
      `A completed remote write (${what}) could NOT be recorded locally: no database connection was `
        + `available after ${attempts} attempt(s) over ${elapsedMs}ms. The remote system holds the `
        + `document; this system does not know its id. Check the connector before re-driving this row. `
        + `Cause: ${messagesOf(cause)[0] ?? String(cause)}`,
      { cause },
    )
    this.name = 'UnrecordedRemoteWriteError'
    this.attempts = attempts
    this.elapsedMs = elapsedMs
  }
}

export type PostRemotePersistOptions = {
  deadlineMs?: number
  retryDelayMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  onRetry?: (detail: { what: string; attempts: number; elapsedMs: number }) => void
}

/**
 * Run a persist that records an ALREADY-COMPLETED remote write, re-driving it across pool-acquisition
 * timeouts until `deadlineMs`.
 *
 * `what` names the write in the error an operator will read, so pass something identifying (the sync
 * log id and the operation), not a category.
 */
export async function persistAfterRemoteWrite<T>(
  what: string,
  persist: () => Promise<T>,
  options: PostRemotePersistOptions = {},
): Promise<T> {
  const deadlineMs = options.deadlineMs ?? POST_REMOTE_PERSIST_DEADLINE_MS
  const retryDelayMs = options.retryDelayMs ?? POST_REMOTE_PERSIST_RETRY_DELAY_MS
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const onRetry = options.onRetry ?? ((detail) => {
    console.error(
      `[post-remote-persist] ${detail.what}: no connection for the record of a completed remote write `
        + `(attempt ${detail.attempts}, ${detail.elapsedMs}ms elapsed) — retrying rather than losing it`,
    )
  })

  const startedAt = now()
  let attempts = 0
  for (;;) {
    attempts += 1
    try {
      return await persist()
    } catch (error) {
      if (!isConnectionAcquisitionTimeout(error)) throw error
      const elapsedMs = now() - startedAt
      if (elapsedMs >= deadlineMs) throw new UnrecordedRemoteWriteError(what, attempts, elapsedMs, error)
      onRetry({ what, attempts, elapsedMs })
      await sleep(retryDelayMs)
    }
  }
}
