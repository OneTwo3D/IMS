/**
 * o3d-alnk r4 — A CONCURRENCY LANE PROVISIONS ITS OWN DATABASE AND REFUSES ONE IT DID NOT CREATE.
 *
 * WHY THIS EXISTS, AND WHAT IT REPLACES. Three rounds of Codex HIGHs on this branch were all the
 * same finding wearing different clothes: a database-backed proof was pointed at whatever
 * `DATABASE_URL` names — on this host, the LIVE-SERVED dev instance — and then made safe by
 * NARROWING what the code under test could reach. Round 2 narrowed the client's WHERE. Round 3
 * made the narrowing predicate unforgeable. Each fix was right about the case it addressed and
 * left another open, because "which rows may this sweep touch" is a claim over an open space:
 * every new seam (`now`, `prepareQueuedEmail`, a one-character prefix, a cast past the option
 * union) is another way to widen it, and the list of seams is not closed.
 *
 * SCOPING IS THE WRONG SHAPE FOR THE PROBLEM. `processPendingEmailOutbox` is a SWEEP: it selects
 * the globally oldest eligible rows, not any caller's rows. A test that hands it a FAKE sender
 * and a REAL database is destructive by construction — a genuine queued customer email caught in
 * the batch is stamped SENT with nothing delivered, and the row afterwards is indistinguishable
 * from a real delivery. No amount of scoping makes that call safe; it only makes it less likely
 * to hit something, and "less likely" is not a property a proof can rest on.
 *
 * PROVISIONING IS. A lane that CREATES its own database has no unrelated rows to reach. There is
 * nothing for a widened predicate to find, nothing for a future `now` to reclaim, nothing a cast
 * can combine a fake sender with. The safety property stops being a claim about the code under
 * test and becomes a claim about ONE STRING — the database name — which is closed, checkable, and
 * asserted below before a single statement is issued.
 *
 * THE SAME SHAPE FIXES LANES THAT HAVE NO SEAM AT ALL (see o3d-1q28). `purgeExpiredActivityLogs`
 * takes no client and no predicate; there is nothing to scope. Provisioning is the only answer
 * that works for it, which is a good sign it was the right answer here too.
 *
 * WHAT THIS MODULE REFUSES, AND WHY EACH REFUSAL IS SEPARATELY REACHABLE:
 *
 *   1. a PROTECTED name — `onetwo3d_ims_dev` above all, which is served live on :3000 — even if
 *      it somehow matched the mint pattern;
 *   2. the database named by the configured `DATABASE_URL`, whatever that happens to be, so a
 *      developer whose dev database IS the throwaway pattern is still protected;
 *   3. a name this module did not mint (anything not matching `THROWAWAY_DATABASE_NAME_RE`) —
 *      this is what "refuses a database it did not create" means at the level of the name;
 *   4. a name that ALREADY EXISTS — the same words at the level of the server. `CREATE DATABASE`
 *      is the authority: it cannot succeed against a database somebody else made.
 *
 * (1)-(3) are pure and are asserted by `tests/throwaway-database-guard.test.ts`, which runs on
 * every `npm run test:unit` with no database at all. (4) needs a server and is asserted by the
 * concurrency lane itself.
 *
 * AND THE DROP IS UNCONDITIONAL FROM THE CALLER'S SIDE. `drop()` re-runs the whole guard before
 * it issues `DROP DATABASE`, so a corrupted or hand-built handle cannot be used to drop something
 * real, and it is a no-op after the first call so a `finally` may always call it.
 *
 * WHICH ORPHANS THIS MODULE CAN LEAVE, ENUMERATED (o3d-alnk r6 LOW, r7 LOW). A caller's `finally`
 * only begins once it HAS a handle, so every failure before that has to be cleaned up in here:
 *
 *   1. the CREATE was ISSUED and the connection then failed before its response arrived — the
 *      database may exist and this process cannot tell. RECLAIMED (r7): the flag is set before the
 *      await and a fresh maintenance connection issues `DROP DATABASE IF EXISTS`.
 *   2. `prisma migrate deploy` failed. RECLAIMED: the same drop, then a refusal by name.
 *   3. a failure between provisioning and the caller's first query — the dynamic imports,
 *      `new PrismaClient`, `sql.connect()`. RECLAIMED by the caller-side `openLane` in the
 *      concurrency lane (r6), which is where those steps live.
 *   4. the process is SIGKILLed, OOM-killed or loses power. NOT RECLAIMABLE, and not pretended
 *      otherwise: no `catch`, no `finally` and no exit handler runs. The mitigation is the NAME —
 *      `ims_throwaway_<label>_<16 hex>` says which lane made the leftover, so it is safe to drop
 *      by hand. `tests/concurrency` DEMONSTRATES this hole with a child that kills itself.
 *
 * (1) and (4) are different in kind, which is the point of listing them together: one is a
 * catchable rejection and was therefore closed, the other is the absence of any further execution
 * and can only be named.
 */

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Resolved from this file, never from the caller's cwd. */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const PRISMA_BIN = fileURLToPath(new URL('../../node_modules/.bin/prisma', import.meta.url))

/** A refusal with a NAME, so a proof can assert on the refusal rather than on any error. */
export class ThrowawayDatabaseError extends Error {
  constructor(message: string) {
    super(`throwaway database: ${message}`)
    this.name = 'ThrowawayDatabaseError'
  }
}

/**
 * Databases this module may never name, whatever else is true.
 *
 * `onetwo3d_ims_dev` is the instance `ims-stage-dev.service` serves on :3000 from the main
 * working tree; `postgres`/`template0`/`template1` are the server's own. The list is a backstop
 * for the mint-pattern check rather than a substitute for it — a name has to pass BOTH.
 */
export const PROTECTED_DATABASE_NAMES: readonly string[] = [
  'postgres',
  'template0',
  'template1',
  'onetwo3d_ims_dev',
  'onetwo3d_ims_e2e',
  'ims_e2e',
]

/** The only shape of name this module mints, and therefore the only shape it will ever drop. */
export const THROWAWAY_DATABASE_NAME_RE = /^ims_throwaway_[a-z0-9]{1,32}_[0-9a-f]{16}$/

/**
 * Refuse any database name this module did not mint, or that names something real.
 *
 * Ordered so each refusal is separately reachable: a protected name is reported as protected
 * even though it would also fail the pattern, and the configured database is reported as the
 * configured one. A refusal that collapsed into "does not match the pattern" would still be
 * safe, but a proof could no longer show WHICH rule fired.
 */
export function assertThrowawayDatabaseName(candidate: string, configuredDatabase: string): void {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new ThrowawayDatabaseError('refused a blank database name')
  }
  if (PROTECTED_DATABASE_NAMES.includes(candidate)) {
    throw new ThrowawayDatabaseError(
      `refused ${candidate}: it is a PROTECTED database and is never a lane's to create or drop`,
    )
  }
  if (candidate === configuredDatabase) {
    throw new ThrowawayDatabaseError(
      `refused ${candidate}: it is the database named by the configured DATABASE_URL, so it holds `
      + 'rows this lane did not create',
    )
  }
  if (!THROWAWAY_DATABASE_NAME_RE.test(candidate)) {
    throw new ThrowawayDatabaseError(
      `refused ${candidate}: it is not a name this module minted (${String(THROWAWAY_DATABASE_NAME_RE)}), `
      + 'so it is a database the lane did not create',
    )
  }
}

/** Quote an identifier for DDL. The name is already pattern-checked; this is belt and braces. */
function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

export type ThrowawayDatabase = {
  /** The database this lane created. */
  readonly name: string
  /** A `DATABASE_URL` pointing at it, carrying the configured host, credentials and parameters. */
  readonly url: string
  /** The database the configured `DATABASE_URL` names — never touched. */
  readonly configuredDatabase: string
  /** Idempotent. Re-runs the full name guard before issuing DDL. */
  drop(): Promise<void>
}

type ProvisionOptions = {
  /** A short lane name, folded into the database name so a stray leftover says where it came from. */
  label: string
  /**
   * ONLY a test of this module overrides the minter, and it buys nothing: every name it returns
   * still has to pass `assertThrowawayDatabaseName` and still has to not exist on the server. It
   * exists so the two refusals that need a server — the configured database, and a name somebody
   * else already created — are reachable from a proof.
   */
  mintName?: () => string
  /** Milliseconds allowed for `prisma migrate deploy`. 263 migrations against an empty database. */
  migrateTimeoutMs?: number
}

function mintThrowawayName(label: string): string {
  if (!/^[a-z0-9]{1,32}$/.test(label)) {
    throw new ThrowawayDatabaseError(
      `refused the lane label ${JSON.stringify(label)}: it must be 1-32 lowercase alphanumerics`,
    )
  }
  return `ims_throwaway_${label}_${randomBytes(8).toString('hex')}`
}

/**
 * The maintenance URL: the same server, credentials AND connection parameters, pointed at
 * `postgres`.
 *
 * Only `schema` is dropped — it is a Prisma-only parameter naming a schema that does not exist in
 * the maintenance database. Everything else is KEPT on purpose: `sslmode`, `connect_timeout` and
 * friends decide whether the connection can be opened at all, and a maintenance client that
 * quietly drops them is one that works here and fails on any deployment that needs them.
 */
function maintenanceUrl(configured: URL): string {
  const url = new URL(configured.toString())
  url.pathname = '/postgres'
  url.searchParams.delete('schema')
  return url.toString()
}

async function withMaintenanceClient<T>(
  url: string,
  run: (client: { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }) => Promise<T>,
): Promise<T> {
  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return await run(client as never)
  } finally {
    await client.end()
  }
}

/**
 * Create and migrate a database that belongs to this lane alone.
 *
 * Throws `ThrowawayDatabaseError` — loudly, by name, before anything is created — rather than
 * falling back to the configured database. There is no degraded mode: a lane that cannot get its
 * own database does not run.
 */
export async function provisionThrowawayDatabase(options: ProvisionOptions): Promise<ThrowawayDatabase> {
  const configuredUrl = process.env.DATABASE_URL
  if (!configuredUrl) {
    throw new ThrowawayDatabaseError('DATABASE_URL is not set, so there is no server to create one on')
  }

  let configured: URL
  try {
    configured = new URL(configuredUrl)
  } catch {
    throw new ThrowawayDatabaseError('DATABASE_URL could not be parsed as a URL')
  }
  if (configured.protocol !== 'postgres:' && configured.protocol !== 'postgresql:') {
    throw new ThrowawayDatabaseError(`DATABASE_URL is not a Postgres URL (${configured.protocol})`)
  }

  const configuredDatabase = decodeURIComponent(configured.pathname.replace(/^\//, ''))
  const name = (options.mintName ?? (() => mintThrowawayName(options.label)))()
  assertThrowawayDatabaseName(name, configuredDatabase)

  const maintenance = maintenanceUrl(configured)

  /**
   * ONE DROP, USED BY EVERY PATH THAT NEEDS ONE — the caller's `drop()`, the migration failure,
   * and the lost-response reclaim below — so the name guard cannot be present on one route and
   * missing from another. It opens its OWN maintenance connection, which is what makes it usable
   * when the connection that issued the CREATE is the thing that just died.
   */
  const dropDatabase = async (): Promise<void> => {
    // The guard again, on the way out. A handle that was tampered with cannot drop something real.
    assertThrowawayDatabaseName(name, configuredDatabase)
    await withMaintenanceClient(maintenance, async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`)
    })
  }

  /**
   * THE LOST-RESPONSE ORPHAN (o3d-alnk r7, Codex LOW) — AND WHY IT IS NOT THE SIGKILL HOLE.
   *
   * `CREATE DATABASE` is issued over a socket. If the server EXECUTES it and the connection then
   * fails before the completion response arrives — a killed backend, a dropped TCP connection, a
   * proxy timing out, `client.end()` throwing in the `finally` — `client.query` REJECTS and this
   * function used to throw straight out. The database existed, nothing held its name, and the
   * `drop` closure had not been created yet. The cleanup added in r6 could not help: it starts
   * after the handle is built.
   *
   * That is a CATCHABLE failure, so it is closable, and it is closed here. The flag is set BEFORE
   * the await, not after it, because "did the server do it?" is exactly the question this process
   * cannot answer — the only thing it knows is that it ISSUED the statement, and that is the fact
   * the cleanup must key on. `DROP DATABASE IF EXISTS` makes both outcomes correct: a CREATE that
   * never landed is a no-op, a CREATE that landed is reclaimed.
   *
   * IT IS SAFE TO DROP ON THIS PATH AND ON NO OTHER. Two facts have already been established when
   * the flag is set: `assertThrowawayDatabaseName` passed, so the name is one this module minted
   * and is neither protected nor the configured database; and the existence probe found NOTHING,
   * so no database of that name belonged to anybody else. The `ALREADY EXISTS` refusal is raised
   * BEFORE the flag and therefore never reaches the cleanup — dropping there would destroy the
   * very database the refusal exists to protect.
   *
   * WHAT REMAINS IS THE SIGKILL HOLE AND ONLY THAT: a process that runs no more JavaScript runs no
   * cleanup either. That one is demonstrated, not asserted, in the concurrency lane.
   */
  let createIssued = false
  try {
    await withMaintenanceClient(maintenance, async (client) => {
      const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
      if (existing.rows.length > 0) {
        throw new ThrowawayDatabaseError(
          `refused ${name}: a database of that name ALREADY EXISTS, so this lane did not create it`,
        )
      }
      createIssued = true
      await client.query(`CREATE DATABASE ${quoteIdentifier(name)}`)
    })
  } catch (error) {
    // Nothing was issued, so there is nothing that could exist. Re-thrown UNCHANGED so the
    // refusals above keep the wording their proofs match on.
    if (!createIssued) throw error

    let reclaimFailure: unknown = null
    try {
      await dropDatabase()
    } catch (dropError) {
      reclaimFailure = dropError
    }
    throw new ThrowawayDatabaseError(
      reclaimFailure === null
        ? `could not create ${name}: ${String(error)}. The CREATE had already been ISSUED, so a `
          + 'database created without this process learning of it was reclaimed; nothing was left behind'
        : `could not create ${name}: ${String(error)}. The CREATE had already been ISSUED and the `
          + `reclaiming DROP ALSO FAILED (${String(reclaimFailure)}), so ${name} MAY still exist on the `
          + 'server and has to be dropped by hand',
    )
  }

  const laneUrl = new URL(configured.toString())
  laneUrl.pathname = `/${encodeURIComponent(name)}`

  let dropped = false
  const drop = async (): Promise<void> => {
    if (dropped) return
    await dropDatabase()
    // Set only on SUCCESS, so a drop that failed transiently can be re-driven rather than
    // silently marked done — which would leave the database behind for good.
    dropped = true
  }

  try {
    await execFileAsync(
      PRISMA_BIN,
      ['migrate', 'deploy'],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, DATABASE_URL: laneUrl.toString() },
        timeout: options.migrateTimeoutMs ?? 300_000,
        maxBuffer: 32 * 1024 * 1024,
      },
    )
  } catch (error) {
    await drop()
    throw new ThrowawayDatabaseError(
      `could not migrate ${name}, so the lane has no database to run against: ${String(error)}`,
    )
  }

  return { name, url: laneUrl.toString(), configuredDatabase, drop }
}
