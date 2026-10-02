/**
 * o3d-ohrk3 — OBSERVE THE PARKED STATE, DO NOT SLEEP FOR IT.
 *
 * The fence tests race an enqueue against a connector switch and need ONE thing to be true before the
 * lock holder lets go: the other side is already BLOCKED behind it. They used to establish that with a
 * fixed wall-clock hold (`HOLD_MS`, 300-500ms) — "the holder keeps the lock for half a second, so the
 * waiter has surely arrived". Under host load the waiter's pooled pre-checks, connection checkout and
 * transaction start can take longer than that, the holder commits first, and the waiter then runs
 * UNCONTENDED against the already-switched selection: it answers `not-configured` where `refused` was
 * asserted (PR #724, 688ms against a 500ms hold), or finds a row the test said could not exist. The
 * assertion was right and the premise ("it is parked by now") was a guess.
 *
 * `waitUntilParkedBehind` replaces the guess with the server's own account of it: a backend whose
 * `pg_blocking_pids` contains the holder's pid and whose statement is the lock acquisition. It polls
 * with a generous ceiling and FAILS LOUD with a diagnostic if the state is never observed — it never
 * returns quietly and lets the caller proceed as though the waiter had parked. That also makes it the
 * guard's own precondition: an enqueue that stops taking the fence is no longer "fast and wrong", it is
 * "never parked", and the test goes red with that sentence.
 */

/** Anything with a Prisma-shaped tagged `$queryRaw` (the pooled client, or a transaction client). */
export type RawQueryable = {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>
}

/** Generous but BELOW every enclosing transaction timeout (20-30s), so the diagnostic fires, not a tx expiry. Only bounds a FAILURE: a healthy run observes the park in tens of ms. */
export const PARK_OBSERVATION_BUDGET_MS = 10_000
const POLL_MS = 10

/** The backend serving `tx`, so another transaction can be asked "are you blocked by that one". */
export async function backendPid(tx: RawQueryable): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`
  return Number(rows[0]!.pid)
}

export type ParkedBackend = {
  /** The blocked backend. */
  pid: number
  /** The statement it is stuck on. */
  query: string
  /** How long the observation took, from the call. NOT an assertion input — a diagnostic. */
  observedAfterMs: number
}

type BlockedRow = { pid: number; query: string; wait_event: string | null }

/**
 * Resolve once a backend blocked BY `holderPid`, whose current statement matches `waitingOn`, is
 * visible in pg_stat_activity. Reject, with what WAS visible, if none appears within `budgetMs`.
 *
 * `probe` must be a connection that is neither the holder nor the waiter (the pooled client).
 */
export async function waitUntilParkedBehind(
  probe: RawQueryable,
  params: { holderPid: number; waitingOn: RegExp; describe: string; budgetMs?: number },
): Promise<ParkedBackend> {
  const startedAt = Date.now()
  const deadline = startedAt + (params.budgetMs ?? PARK_OBSERVATION_BUDGET_MS)
  let lastSeen: BlockedRow[] = []
  for (;;) {
    const rows = await probe.$queryRaw<BlockedRow[]>`
      SELECT a.pid::int AS pid, a.query AS query, a.wait_event AS wait_event
        FROM pg_stat_activity a
       WHERE a.datname = current_database()
         AND a.pid <> pg_backend_pid()
         AND a.wait_event_type = 'Lock'
         AND ${params.holderPid}::int = ANY (pg_blocking_pids(a.pid))
       ORDER BY a.pid`
    lastSeen = rows
    const match = rows.find((row) => params.waitingOn.test(String(row.query)))
    if (match) {
      return { pid: Number(match.pid), query: String(match.query), observedAfterMs: Date.now() - startedAt }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${params.describe}: no backend blocked by holder pid ${params.holderPid} was waiting on `
        + `${params.waitingOn} within ${params.budgetMs ?? PARK_OBSERVATION_BUDGET_MS}ms. The side under `
        + 'test never PARKED behind the lock, so everything this test would assert about "it waited for '
        + 'the fence" is unestablished. Backends visibly blocked by that holder: '
        + `${lastSeen.length === 0 ? 'none' : JSON.stringify(lastSeen.map((row) => ({ pid: row.pid, wait_event: row.wait_event, query: String(row.query).slice(0, 120) })))}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}
