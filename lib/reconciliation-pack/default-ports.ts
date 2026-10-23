/**
 * THE REAL PORTS OF THE COMMAND: the liveness reader and the as-of basis, wired so that neither touches the application's
 * database client.
 *
 * Why not: the invariant run of the same command binds the application's `db` (lib/db) to ONE snapshot transaction, which only
 * works if nothing imported lib/db before it, and leaves `db` a spent transaction client after it
 * (lib/reconciliation-pack/invariant-snapshot.ts). The liveness bracket has to be read before the items and again after them, and
 * the basis has to be read in between and settled after, so neither may use `db`, before or after.
 *
 *   - LIVENESS is read by a CHILD PROCESS: `npm run --silent read-sync:status -- --json`, the command the readiness gate already runs
 *     the same way, with the same whitelisted environment. Its output is a claim; reduceStatusReport checks it against itself and
 *     anything that is not exactly the report's shape is an unreadable read (every item inconclusive). The child's exit code is NOT
 *     the verdict (it is non-zero whenever a stream is stale, and the report says so in its own fields); only a report that parses
 *     and reduces counts, and a child that timed out, was killed or printed nothing is a failed read.
 *   - THE BASIS is read through a client of its own, built the way the invariant snapshot builds its client (a single-connection
 *     Prisma client from DATABASE_URL), one per transaction and always disconnected. The modules it imports do not import lib/db
 *     (a test loads them in a fresh process and checks that nothing created the application's client).
 *
 * No vendor is contacted and nothing is written: the child reads the database and the crontab, the basis runs in a
 * READ ONLY REPEATABLE READ transaction (read-tx.ts).
 */

import { READ_SYNC_STATUS_SCRIPT } from '@/lib/ops/readiness-gate-constants'
import { buildChildEnv, runNpmScript, READ_SYNC_TIMEOUT_MS, type ChildResult, type ChildSpec } from '@/lib/ops/readiness-gate-collect'
import { readAsOfBasis, settleAsOfBasis, type BasisTx } from '@/lib/reconciliation-pack/basis'
import { reduceStatusReport } from '@/lib/reconciliation-pack/liveness'
import { createSnapshotClient } from '@/lib/reconciliation-pack/invariant-snapshot'
import { withReadOnlySnapshot } from '@/lib/reconciliation-pack/read-tx'
import type { BasisPort, LivenessPort } from '@/lib/reconciliation-pack/run'

export type LivenessChildDeps = {
  runScript?: (spec: ChildSpec) => Promise<ChildResult>
  env?: Record<string, string | undefined>
  cwd: string
}

/** The liveness port: one child process per read. A failure of any kind is `{ ok: false }` with nothing about the cause kept. */
export function childLivenessPort(deps: LivenessChildDeps): LivenessPort {
  const runScript = deps.runScript ?? runNpmScript
  return {
    async read() {
      try {
        const run = await runScript({ script: READ_SYNC_STATUS_SCRIPT, silent: true, args: ['--json'], env: buildChildEnv(deps.env ?? process.env), cwd: deps.cwd, timeoutMs: READ_SYNC_TIMEOUT_MS })
        if (run.timedOut || run.exitCode === null) return { ok: false }
        return reduceStatusReport(JSON.parse(run.stdout))
      } catch {
        return { ok: false }
      }
    },
  }
}

export type BasisClientDeps = {
  /** Test seam: runs `fn` in the one read transaction. The default builds a client of its own. */
  run?: <T>(fn: (tx: BasisTx) => Promise<T>) => Promise<T>
}

/** The basis port over a client of its own (never the application's `db`). Each transaction gets a fresh single-connection client and always disconnects it. */
export function ownClientBasisPort(deps: BasisClientDeps = {}): BasisPort {
  const run = deps.run ?? (async <T,>(fn: (tx: BasisTx) => Promise<T>): Promise<T> => {
    const client = createSnapshotClient()
    try {
      return await withReadOnlySnapshot(fn as never, { client: client as never }) as T
    } finally {
      await client.$disconnect().catch(() => undefined)
    }
  })
  return {
    read: (asOf) => readAsOfBasis(asOf, { run }),
    settle: (read, bracket) => settleAsOfBasis(read, bracket, { run }),
  }
}
