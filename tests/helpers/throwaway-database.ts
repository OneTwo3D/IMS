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
 *      is the authority: it cannot succeed against a database somebody else made, and its `42P04`
 *      is the ONLY thing that establishes who owns the name. The probe that runs before it is a
 *      courtesy, not a claim: it can only report absence at the instant it ran.
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
 *      database may exist and this process cannot tell. RECLAIMED (r7), but only once ownership
 *      has been ESTABLISHED rather than assumed (r9): a session advisory lock held on a SEPARATE
 *      maintenance connection spans the probe, the CREATE and the cleanup decision, and the
 *      database this module creates carries an ownership stamp. See the lock commentary at
 *      `takeProvisionLock` and the verdict table at `resolveLostCreate`. What the reclaim must
 *      NOT swallow is a CREATE the server REFUSED as `42P04` — that answer proves the database is
 *      somebody else's, and r8 gives it its own state (`definitely-not-mine`) so it can never
 *      reach a drop.
 *   2. `prisma migrate deploy` failed. RECLAIMED: the same drop, then a refusal by name. Ownership
 *      is not inferred here — this path is only reachable once the CREATE has COMPLETED.
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
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { THROWAWAY_DATABASE_PROVISION_LOCK_NAMESPACE } from '@/lib/db/advisory-locks'

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

/**
 * THE OWNERSHIP STAMP (o3d-alnk r9).
 *
 * `CREATE DATABASE x CONNECTION LIMIT 4242` writes 4242 into `pg_database.datconnlimit`, where
 * any later maintenance connection can read it back. That is the ONLY thing a `CREATE DATABASE`
 * lets this module write about itself — there is no comment, no label and no owner field that
 * distinguishes two databases created by the same role — and it is what turns "a database of that
 * name exists" into "a database THIS MODULE created exists".
 *
 * It is never binding: 4242 is far above any `max_connections` a lane will meet, so the limit
 * cannot refuse a connection the lane needs. A database that does NOT carry it was created by
 * something that is not this module, and is therefore never dropped by this module.
 *
 * VERIFIED ON THE SERVER (PostgreSQL 17.11): the stamp survives the CREATE and reads back as
 * `datconnlimit = 4242`; the default for a database created without it is -1.
 */
export const THROWAWAY_DATABASE_CONNECTION_LIMIT = 4242

/**
 * The `objid` half of the provisioning lock, derived from the database NAME.
 *
 * Computed here rather than with the server's `hashtext`, because two provisioners have to derive
 * the same id from the same name without depending on an internal function's stability. Positive
 * int32: `pg_advisory_lock(int4, int4)` takes signed 32-bit arguments and `pg_locks` reports them
 * back as `oid`, so a negative id would have to be compared as its unsigned bit pattern. Dropping
 * the sign bit costs one bit of a 32-bit id and makes the held-check a plain comparison.
 *
 * Two lanes with different names hash to different ids and never contend; two provisioners of the
 * SAME name contend, which is the entire point.
 */
export function provisionLockId(name: string): number {
  return createHash('sha256').update(name).digest().readUInt32BE(0) & 0x7fff_ffff
}

/** Quote an identifier for DDL. The name is already pattern-checked; this is belt and braces. */
function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/**
 * `duplicate_database`. PostgreSQL raises exactly this SQLSTATE when `CREATE DATABASE` names a
 * database that already exists — which is the one answer that proves THIS call did not create it.
 */
const DUPLICATE_DATABASE_SQLSTATE = '42P04'

/**
 * Is this rejection the server saying "that name is already taken"?
 *
 * Keyed on the SQLSTATE and on nothing else. `pg` puts the server's five-character code on
 * `error.code` verbatim, and a message-text fallback would be a guess in a place where a guess
 * decides whether a `DROP DATABASE` is issued. If a future driver stops setting `code`, this
 * returns false and the caller falls back to the possibly-created path — the same behaviour as
 * before this check existed, which is the failure mode to prefer over a wrong `true`.
 */
function isDuplicateDatabaseError(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === DUPLICATE_DATABASE_SQLSTATE
  )
}

/**
 * WHAT THIS PROCESS KNOWS ABOUT WHO CREATED THE DATABASE — three states, because there are three
 * answers and a boolean can only hold two (o3d-alnk r8, Codex HIGH).
 *
 * The r7 flag conflated the last two: it recorded that the CREATE had been ISSUED, and every
 * outcome other than "not issued" was treated as "might be mine, so reclaim it". That is right
 * for a response that never arrives and WRONG for a response that arrives saying somebody else
 * got there first — and the wrong one dropped their database.
 */
type CreateOwnership =
  /**
   * Nothing was issued, or the server REFUSED the CREATE as `42P04`. Either way this call did not
   * create the database. NEVER cleaned up: there is either nothing there, or something that is
   * somebody else's.
   */
  | 'definitely-not-mine'
  /**
   * The CREATE was issued and no answer came back, so this process does not know WHICH answer it
   * missed — the completion, or a `42P04`.
   *
   * r7 dropped here on the grounds that `DROP DATABASE IF EXISTS` is correct whether or not the
   * database exists. It is not: it is also correct-looking when the database exists and belongs to
   * SOMEBODY ELSE. This state therefore decides nothing on its own — `resolveLostCreate` goes and
   * looks, under a lock that makes what it finds mean something.
   */
  | 'possibly-created'
  /** The CREATE COMPLETED. The database exists and it is this lane's to drop. */
  | 'created'

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
  /**
   * Milliseconds the provisioning lock may wait for another provisioner holding the SAME name.
   * Only reachable when `mintName` forces a collision; two minted names never contend.
   */
  lockTimeoutMs?: number
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
 * A session advisory lock held on a maintenance connection of its OWN, for as long as the name
 * needs holding (o3d-alnk r9, Codex HIGH).
 *
 * WHAT WAS WRONG BEFORE, IN ONE SENTENCE: r8 recorded that closing the lost-`42P04` residue
 * "needs a lock Postgres does not offer for `CREATE DATABASE`", and that is FALSE. The
 * prohibition it was thinking of is `CREATE DATABASE cannot run inside a transaction block`
 * (SQLSTATE 25001), which is a statement about TRANSACTIONS, not about locks. Session-level
 * advisory locks are not transactional and are exactly what this needs.
 *
 * VERIFIED AGAINST THE SERVER (PostgreSQL 17.11, this host), not argued:
 *
 *   • `SELECT pg_advisory_lock(ns, id)` outside any transaction block returns, and `pg_locks`
 *     shows `locktype = 'advisory'`, `granted = t` for that backend;
 *   • `CREATE DATABASE` on THAT SAME SESSION succeeds while the lock is held, and the lock is
 *     still held afterwards;
 *   • `BEGIN; CREATE DATABASE ...` fails with `ERROR: 25001: CREATE DATABASE cannot run inside a
 *     transaction block` — the real prohibition, and the reason `pg_advisory_xact_lock` is
 *     unusable here: it would need the transaction block the CREATE cannot be in;
 *   • a SECOND session's `pg_try_advisory_lock` on the same key returns `f` while the first
 *     holds it, and `t` the instant the first backend is terminated;
 *   • `lock_timeout` bounds the wait for an advisory lock (`ERROR: canceling statement due to
 *     lock timeout`), so the wait below cannot hang forever.
 *
 * WHY A SEPARATE CONNECTION, AND NOT THE ONE THAT ISSUES THE CREATE. The case being closed is
 * "the CREATE was issued and the connection then died". A lock taken on that same connection is
 * released by PostgreSQL at exactly the moment it is needed — the fifth bullet above is the proof
 * of that, and it is why the lock lives here instead.
 *
 * WHAT THE LOCK COVERS. Between `pg_advisory_lock` and the release, no OTHER PROVISIONER THAT
 * TAKES THIS LOCK can probe, create or drop that name. So the probe's "absent" stops being a fact
 * about the instant it ran and becomes a fact about the whole window, and a database that appears
 * in that window was not put there by a participant.
 *
 * WHAT IT DOES NOT COVER, stated plainly rather than left to be discovered:
 *
 *   1. NON-PARTICIPANTS. Advisory locks are cooperative; PostgreSQL does not enforce them on DDL.
 *      Anything that runs `CREATE DATABASE` without taking this lock still races, and the `42P04`
 *      branch still exists for it. What the lock does NOT do is make such a database look like
 *      ours — that is what the CONNECTION LIMIT stamp is for.
 *   2. THE LOCK SESSION DYING. If this connection fails, PostgreSQL frees the lock immediately
 *      (bullet four). `stillHeld()` exists so the cleanup can ASK rather than assume, and a
 *      cleanup that cannot prove the lock was held does not drop anything.
 *   3. SIGKILL of this process, which runs no cleanup at all and takes the lock down with the
 *      socket. Unchanged, and still only mitigated by the name.
 *   4. A DIFFERENT SERVER, OR A DIFFERENT MAINTENANCE DATABASE. Advisory locks are scoped to the
 *      database the session is connected to — verified: the same key taken from `postgres` was
 *      freely acquirable from `onetwo3d_ims_dev` on the same cluster. Every participant reaches
 *      the lock through `maintenanceUrl()`, which always points at `/postgres`, so they share a
 *      scope; a future change that pointed it elsewhere would silently un-exclude them.
 */
type ProvisionLock = {
  /** The `objid` half, for messages and for proofs. */
  readonly id: number
  /**
   * Does THIS session still hold the lock, right now? Answers `false` rather than throwing when
   * the session has died — "the lock is gone" is what a dead session MEANS, and the caller has to
   * be able to act on it rather than have it arrive as an exception from somewhere else.
   */
  stillHeld(): Promise<boolean>
  /** Ends the session, which is what releases the lock. Never throws. */
  release(): Promise<void>
}

async function takeProvisionLock(url: string, name: string, timeoutMs: number): Promise<ProvisionLock> {
  const id = provisionLockId(name)
  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString: url })
  // A pg client that fails while idle emits 'error', and an unhandled one takes the process down.
  // It is also the event that says the lock is gone, which is why `stillHeld` reads the flag.
  let failed = false
  client.on('error', () => { failed = true })
  await client.connect()
  try {
    // BOUNDED. Without this, a provisioner whose peer wedged mid-CREATE waits forever instead of
    // failing, and a test fixture that hangs is worse than one that refuses.
    await client.query('SELECT set_config($1, $2, false)', [
      'lock_timeout',
      `${Math.max(1, Math.trunc(timeoutMs))}ms`,
    ])
    await client.query('SELECT pg_advisory_lock($1, $2)', [THROWAWAY_DATABASE_PROVISION_LOCK_NAMESPACE, id])
  } catch (error) {
    try { await client.end() } catch { /* the session is going away either way */ }
    throw new ThrowawayDatabaseError(
      `could not take the provisioning lock ${THROWAWAY_DATABASE_PROVISION_LOCK_NAMESPACE}/${id} for `
      + `${name}, so the probe and the CREATE could not be made exclusive and NOTHING WAS CREATED: `
      + String(error),
    )
  }
  return {
    id,
    async stillHeld(): Promise<boolean> {
      if (failed) return false
      try {
        const held = await client.query(
          'SELECT count(*)::int AS held FROM pg_locks WHERE locktype = $1 AND classid = $2::oid '
          + 'AND objid = $3::oid AND objsubid = 2 AND pid = pg_backend_pid() AND granted',
          ['advisory', THROWAWAY_DATABASE_PROVISION_LOCK_NAMESPACE, id],
        )
        return Number(held.rows[0]?.held ?? 0) > 0
      } catch {
        // The session that would have to be holding it cannot even be asked.
        return false
      }
    },
    async release(): Promise<void> {
      // Ending the session releases every session lock it holds; an explicit unlock would be a
      // second way to get this wrong for no gain.
      try { await client.end() } catch { /* already gone, and so is the lock */ }
    },
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
   * Read the OWNERSHIP STAMP off whatever currently holds the name, on a connection of its own.
   *
   * `null` means there is no database of that name. A number means there is one, and whether it
   * equals `THROWAWAY_DATABASE_CONNECTION_LIMIT` is the whole of "is it ours".
   */
  const readOwnershipStamp = async (): Promise<number | null> =>
    withMaintenanceClient(maintenance, async (client) => {
      const found = await client.query('SELECT datconnlimit FROM pg_database WHERE datname = $1', [name])
      if (found.rows.length === 0) return null
      return Number(found.rows[0].datconnlimit)
    })

  /**
   * THE THREE ANSWERS `CREATE DATABASE` CAN GIVE, AND THE FOURTH THING THAT CAN HAPPEN TO THEM
   * (r7 LOW, r8 HIGH, r9 HIGH).
   *
   *   COMPLETED -> `created`. The database exists and it is this lane's. Anything that fails
   *   afterwards — the `client.end()` in the maintenance `finally`, for instance — still leaves a
   *   database this lane owns, so it is reclaimed with no further questions asked.
   *
   *   `42P04` -> `definitely-not-mine`. The server answered, and its answer was that the name was
   *   ALREADY TAKEN when the CREATE ran. Positive proof this call did not create the database, so
   *   it is the one outcome that must never reach the drop.
   *
   *   NO ANSWER -> `possibly-created`. A killed backend, a dropped TCP connection, a proxy timing
   *   out. `client.query` REJECTS and this process does not know which of the two answers it
   *   missed. r7 dropped here unconditionally; r8 pointed out that the missed answer might have
   *   been the `42P04`, and left the residue open on the claim that closing it "needs a lock
   *   Postgres does not offer for `CREATE DATABASE`".
   *
   * THAT CLAIM WAS WRONG, AND THIS IS WHERE IT IS PAID FOR. Postgres offers session-level
   * advisory locks, they are not transactional, and one is held across the probe, the CREATE and
   * this decision on a connection that the dying one cannot take down (`takeProvisionLock`). The
   * missed answer is therefore no longer a guess — see the verdict table in `resolveLostCreate`.
   */
  let ownership: CreateOwnership = 'definitely-not-mine'

  const lock = await takeProvisionLock(maintenance, name, options.lockTimeoutMs ?? 30_000)

  /**
   * WHAT TO DO ABOUT A CREATE WHOSE ANSWER NEVER ARRIVED — decided from evidence, never assumed.
   *
   *   lock NOT still held      -> LEAVE. The exclusion window was open, so a participant could
   *                               have taken the name and there is nothing that says the database
   *                               is this lane's. Leaking is the failure this module accepts;
   *                               dropping somebody else's data is not.
   *   re-probe finds nothing   -> LEAVE, and there is nothing to leave: under the still-held lock
   *                               no participant could have created-and-dropped it in between, so
   *                               absent means the server never executed the CREATE.
   *   stamp is NOT ours        -> LEAVE. Something that does not take this lock created a database
   *                               under this name. It is not ours and it is not dropped.
   *   stamp IS ours            -> DROP. The lock rules out every participant; the stamp rules out
   *                               everything that does not carry it. What is left is this lane's
   *                               own CREATE, which succeeded without this process being told.
   *
   * THE RESIDUE, NAMED. Something that neither takes this lock NOR is this module, that creates a
   * database whose name is this lane's 64 bits of freshly minted randomness, AND stamps it with
   * CONNECTION LIMIT 4242, would be dropped. That is not a race — it is a guess at a random name
   * combined with a matching stamp — and it is the only case left.
   */
  const resolveLostCreate = async (): Promise<{ drop: false; reason: string } | { drop: true; provenance: string }> => {
    if (!await lock.stillHeld()) {
      return {
        drop: false,
        reason:
          'The CREATE had already been ISSUED, and by the time the cleanup ran the provisioning '
          + `lock ${THROWAWAY_DATABASE_PROVISION_LOCK_NAMESPACE}/${lock.id} was NO LONGER HELD — so `
          + `another provisioner could have taken the name in between and ${name} cannot be shown to `
          + `be this lane's. NOTHING WAS DROPPED; if ${name} exists on the server it has to be `
          + 'inspected and dropped by hand',
      }
    }

    let stamp: number | null
    try {
      stamp = await readOwnershipStamp()
    } catch (probeError) {
      return {
        drop: false,
        reason:
          'The CREATE had already been ISSUED and the re-probe that would have established whether '
          + `${name} is this lane's ALSO FAILED (${String(probeError)}), so NOTHING WAS DROPPED and `
          + `${name} MAY still exist on the server and has to be dropped by hand`,
      }
    }

    if (stamp === null) {
      return {
        drop: false,
        reason:
          'The CREATE had already been ISSUED, and a re-probe under the STILL-HELD provisioning lock '
          + `found no database called ${name} at all — the server never executed it. NOTHING WAS `
          + 'DROPPED because there was nothing there',
      }
    }

    if (stamp !== THROWAWAY_DATABASE_CONNECTION_LIMIT) {
      return {
        drop: false,
        reason:
          'The CREATE had already been ISSUED, and a re-probe under the STILL-HELD provisioning lock '
          + `found a database called ${name} whose CONNECTION LIMIT is ${stamp}, not the `
          + `${THROWAWAY_DATABASE_CONNECTION_LIMIT} this module stamps on every database it creates. `
          + 'It was therefore created by something that does not take this lock, and it is SOMEBODY '
          + "ELSE'S. NOTHING WAS DROPPED",
      }
    }

    return {
      drop: true,
      provenance:
        'The CREATE had already been ISSUED, and a re-probe under the STILL-HELD provisioning lock '
        + `found ${name} carrying this module's own ownership stamp (CONNECTION LIMIT `
        + `${THROWAWAY_DATABASE_CONNECTION_LIMIT}), so a database created without this process `
        + 'learning of it was',
    }
  }

  try {
    try {
      await withMaintenanceClient(maintenance, async (client) => {
        const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
        if (existing.rows.length > 0) {
          throw new ThrowawayDatabaseError(
            `refused ${name}: a database of that name ALREADY EXISTS, so this lane did not create it`,
          )
        }
        // BEFORE the await, deliberately: from here until an answer arrives, "may exist" is the
        // most this process can honestly claim without going and looking.
        ownership = 'possibly-created'
        try {
          await client.query(
            `CREATE DATABASE ${quoteIdentifier(name)} CONNECTION LIMIT ${THROWAWAY_DATABASE_CONNECTION_LIMIT}`,
          )
        } catch (createError) {
          if (isDuplicateDatabaseError(createError)) {
            // The answer arrived and it was somebody else's name. Step BACK to definitely-not-mine
            // so the cleanup below cannot run: this is the same refusal the probe makes, arriving
            // one statement later because a NON-PARTICIPANT took the name in between.
            ownership = 'definitely-not-mine'
            throw new ThrowawayDatabaseError(
              `refused ${name}: the CREATE was REJECTED with SQLSTATE ${DUPLICATE_DATABASE_SQLSTATE} `
              + '(duplicate_database), which is positive proof another provisioner created that database '
              + "between this lane's existence probe and its CREATE. NOTHING WAS DROPPED: the database "
              + 'of that name belongs to whoever won the race, and this lane never owned it',
            )
          }
          throw createError
        }
        // The server answered, and the answer was yes.
        ownership = 'created'
      })
    } catch (error) {
      // `definitely-not-mine` covers both refusals — the probe's and the `42P04` one — and every
      // failure before the CREATE was issued. Re-thrown UNCHANGED so those refusals keep the
      // wording their proofs match on, and, more to the point, WITHOUT ISSUING A DROP.
      if (ownership === 'definitely-not-mine') throw error

      const verdict = ownership === 'created'
        // Ownership is not in question here: the server said yes. This is the `client.end()`
        // that failed after a successful CREATE, and the database it left is this lane's.
        ? {
            drop: true as const,
            provenance: 'The CREATE had already been ISSUED and had SUCCEEDED, so the database this lane owns was',
          }
        : await resolveLostCreate()

      if (!verdict.drop) {
        throw new ThrowawayDatabaseError(`could not create ${name}: ${String(error)}. ${verdict.reason}`)
      }

      let reclaimFailure: unknown = null
      try {
        await dropDatabase()
      } catch (dropError) {
        reclaimFailure = dropError
      }
      throw new ThrowawayDatabaseError(
        reclaimFailure === null
          ? `could not create ${name}: ${String(error)}. ${verdict.provenance} reclaimed; nothing was left behind`
          : `could not create ${name}: ${String(error)}. The CREATE had already been ISSUED and the `
            + `reclaiming DROP ALSO FAILED (${String(reclaimFailure)}), so ${name} MAY still exist on the `
            + 'server and has to be dropped by hand',
      )
    }
  } finally {
    // RELEASED HERE, and not later. The lock's job is to make the probe, the CREATE and the
    // cleanup decision one indivisible window; everything after this point either owns the
    // database outright (the migration, the caller's `drop()`) or has already refused. Holding it
    // across `prisma migrate deploy` would pin a maintenance connection for the whole run and buy
    // nothing: once the CREATE has COMPLETED, ownership is settled by the CREATE itself.
    await lock.release()
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
