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
 * real. It is a NO-OP once the server has ANSWERED a DROP, so a `finally` may always call it; it
 * is a REFUSAL once a DROP has been ISSUED and not answered, because the handle has by then spent
 * the one statement it is ever allowed to issue. See the r11 rule below for why that is not a
 * matter of tidiness.
 *
 * ===========================================================================================
 * THE CLEANUP RULE (o3d-alnk r10). ONE SENTENCE, AND IT IS THE WHOLE OF IT:
 *
 *   THIS MODULE ISSUES `DROP DATABASE` ONLY FOR A NAME IT MINTED IN THIS PROCESS AND FOR WHICH
 *   THIS PROCESS SAW ITS OWN `CREATE DATABASE` COMPLETE. EVERY OTHER OUTCOME LEAVES THE DATABASE
 *   WHERE IT IS AND NAMES IT IN THE REFUSAL.
 *
 * Nothing here infers ownership after the fact. There is no re-probe, no ownership stamp and no
 * advisory lock, because every one of those decides "is this mine?" from evidence a third party
 * can also produce, and four consecutive rounds of review found a new way for each to be wrong:
 *
 *   r7  closed a lost-response orphan by RECLAIMING it — `DROP DATABASE IF EXISTS` on the grounds
 *       that the statement is harmless whether or not the database is there.
 *   r8  found that it is not harmless: the answer that never arrived might have been the `42P04`,
 *       in which case the reclaim drops the WINNER's database. Fixed by giving `42P04` its own
 *       state, and left the LOST `42P04` open.
 *   r9  closed that with a session advisory lock spanning the probe, the CREATE and the decision,
 *       plus a `CONNECTION LIMIT 4242` ownership stamp for creators that do not take the lock.
 *   r10 found that the stamp is a CONVENTION, not provenance — any caller may legitimately set
 *       that limit — and that reading it and dropping are two statements with a window between
 *       them, which a cooperative lock does not close against a non-participant.
 *
 * Each round closed the previous round's reclaim with a better guess at ownership. The reclaim is
 * the only thing in this module that ever violated its own stated principle — IT ACCEPTS LEAKING
 * A DATABASE AND NEVER DESTROYS ONE — so r10 deletes the reclaim rather than guessing a fifth
 * time. The entire class of finding goes with it: there is no inference left to be wrong about.
 *
 * WHAT THAT COSTS, STATED PLAINLY. A `CREATE DATABASE` whose answer never arrives leaks ONE
 * database. It is disk space with a name nobody else will mint — `ims_throwaway_<label>_<16 hex>`
 * is 64 bits of `randomBytes`, freshly drawn per provision — and the refusal that comes out of
 * this module NAMES it and says it has to be dropped by hand. That is a nuisance an operator can
 * see and act on; dropping somebody else's database is not.
 *
 * WHICH ORPHANS THIS MODULE CAN LEAVE, ENUMERATED (o3d-alnk r6 LOW, r7 LOW, r10). A caller's
 * `finally` only begins once it HAS a handle, so everything before that is settled in here:
 *
 *   1. the CREATE was ISSUED and no answer arrived — the database may exist and this process
 *      cannot tell. LEFT, and named in the refusal (r10). This is the case r7 through r9 kept
 *      trying to reclaim.
 *   2. `prisma migrate deploy` failed. DROPPED, with no inference of any kind: this path is only
 *      reachable once the CREATE has COMPLETED, so the database is provably this process's. If
 *      that DROP itself fails, the database is LEFT and the refusal names it.
 *   3. a failure between provisioning and the caller's first query — the dynamic imports,
 *      `new PrismaClient`, `sql.connect()`. Dropped by the caller-side `openLane` in the
 *      concurrency lane (r6), through the handle's `drop()`, which is again a COMPLETED create.
 *   4. the process is SIGKILLed, OOM-killed or loses power. NOT RECLAIMABLE, and not pretended
 *      otherwise: no `catch`, no `finally` and no exit handler runs. `tests/concurrency`
 *      DEMONSTRATES this hole with a child that kills itself.
 *
 * (1) and (4) now have the SAME mitigation — the name — and that is the point. One is a catchable
 * rejection and the other is the absence of any further execution, but neither can establish who
 * owns a database after the fact, so neither pretends to.
 *
 * ===========================================================================================
 * THE RECORD-BEFORE-THE-OPERATION RULE (o3d-alnk r11). THIS IS THE GENERAL FORM OF ALL OF THE
 * ABOVE, AND IT IS WHY THE SAME FINDING KEPT COMING BACK WEARING A DIFFERENT STATEMENT:
 *
 *   A FACT ABOUT A STATEMENT IS RECORDED BEFORE THE STATEMENT IS SENT, NEVER AFTER IT RETURNS.
 *   THE ONLY THING A PROCESS CAN KNOW ABOUT A STATEMENT IS THAT IT ISSUED IT; whether the server
 *   executed it is an answer that may never arrive. A fact recorded AFTER the operation is a fact
 *   a lost response DELETES, and a deleted fact reads as "it did not happen" — which is exactly
 *   the reading that licenses doing it AGAIN, against a name that may no longer be this lane's.
 *
 * THE ONE THING THAT MAY BE RECORDED AFTERWARDS is a NARROWING of what was already recorded, and
 * only where the value recorded beforehand is the CONSERVATIVE one — so that a lost answer leaves
 * the pessimistic reading standing rather than the permissive one. `'answer-unknown'` narrowing to
 * `'created'` is such a narrowing; so is a DROP's `'answer-unknown'` narrowing to `'dropped'`.
 *
 * EVERY PLACE IN THIS FILE WHERE THE RULE BITES, ENUMERATED SO THE NEXT ROUND DOES NOT HAVE TO
 * REDISCOVER IT ONE SITE AT A TIME:
 *
 *   CREATE (r9, r10). `outcome = 'answer-unknown'` is set BEFORE `client.query`. Before that fix
 *   a lost response read as "nothing was created", which is the reading that leaked, then — once
 *   r7 acted on it — the reading that dropped a stranger's database.
 *
 *   DROP (r11). `dropOutcome = 'answer-unknown'` is set BEFORE `client.query`, SYNCHRONOUSLY, in
 *   the same tick as the call that spends the handle. Before that fix `dropped = true` was set
 *   only after the DROP RETURNED, so (a) a lost DROP response read as "not dropped yet" and left
 *   the handle retryable — and another provisioner may by then have recreated the visible name,
 *   so the retry destroys a database this process did not create — and (b) two concurrent
 *   `drop()` calls both read `dropped === false` and both issued one. It is the CREATE defect
 *   mirrored, and it is closed the same way: A HANDLE ISSUES AT MOST ONE `DROP DATABASE`, EVER.
 *
 *   THE EXISTENCE PROBE. Records nothing and licenses nothing; it can only report absence at the
 *   instant it ran, which is why `CREATE DATABASE` and its `42P04` are the authority.
 *
 *   `prisma migrate deploy`. Its answer is read AFTER it returns, and that is sound rather than an
 *   exception: a lost answer reads as "the migration failed", whose consequence is a DROP of a
 *   database whose own CREATE this process watched complete. Nothing about a third party's
 *   database rests on it, so there is no destructive statement for a lost answer to license.
 *
 *   THE `42P04` STEP-BACK. `outcome = 'not-created'` is recorded after the server ANSWERED, and it
 *   is safe in both directions: it moves from one non-dropping state to another, so a lost answer
 *   leaves `'answer-unknown'` standing and nothing is dropped on either reading.
 *
 *   `client.connect()`, `client.end()` AND THE `dropFailure` LOCALS. No fact about a statement is
 *   recorded around the first two — a lost `connect` answer can leak a socket in a process that is
 *   already failing, and licenses nothing. `dropFailure` records a rejection that has ALREADY
 *   happened, which is the only ordering it can have.
 *
 * That is the whole file. Every site is above; there is no other place where a fact is recorded
 * after the operation it describes, and a fifth round looking for one should start by finding a
 * NEW await rather than re-reading these.
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
 * returns false and the caller falls back to the answer-unknown path — which LEAVES the database,
 * so the degraded behaviour is a leak rather than a wrong drop.
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
 * WHAT THE SERVER TOLD THIS PROCESS ABOUT ITS OWN `CREATE DATABASE` — and nothing else.
 *
 * This is deliberately NOT a claim about who owns the database. It is a record of which of the
 * three things that can happen to a statement happened to this one, and the cleanup rule reads
 * exactly this and never goes looking for corroboration (o3d-alnk r10).
 */
type CreateOutcome =
  /**
   * Nothing was issued, or the server REFUSED the CREATE as `42P04`. Either way this process did
   * not create anything: there is nothing there, or there is something that is somebody else's.
   * The refusal is re-thrown UNCHANGED and no DDL is issued.
   */
  | 'not-created'
  /**
   * The CREATE was issued and no answer came back. This process does not know whether the server
   * executed it, and — since r10 — does not try to find out: the database is LEFT and NAMED.
   */
  | 'answer-unknown'
  /**
   * The CREATE COMPLETED. This is the ONLY state in which this module issues a `DROP DATABASE`,
   * because it is the only one in which the server itself said this process created the database.
   */
  | 'created'

/**
 * WHAT THIS PROCESS KNOWS ABOUT ITS OWN `DROP DATABASE` — the mirror of `CreateOutcome`, and kept
 * deliberately in the same three shapes so the symmetry is visible rather than argued (r11).
 *
 * A HANDLE MOVES THROUGH THESE ONCE AND NEVER BACKWARDS. There is no path from `'answer-unknown'`
 * to `'not-issued'`, because that transition IS the defect: it would say a DROP that was issued
 * had not been, and license issuing another one.
 */
type DropOutcome =
  /** No `DROP DATABASE` has been issued for this database by this process. */
  | 'not-issued'
  /**
   * A `DROP DATABASE` was ISSUED and this process did not see it complete. The database MAY be
   * gone. The handle is SPENT: any further `drop()` is refused by name, because the name may since
   * have been recreated by another provisioner and a retry would destroy THAT database.
   */
  | 'answer-unknown'
  /** The server ANSWERED the DROP. The database is gone and further calls are a no-op. */
  | 'dropped'

export type ThrowawayDatabase = {
  /** The database this lane created. */
  readonly name: string
  /** A `DATABASE_URL` pointing at it, carrying the configured host, credentials and parameters. */
  readonly url: string
  /** The database the configured `DATABASE_URL` names — never touched. */
  readonly configuredDatabase: string
  /**
   * ISSUES AT MOST ONE `DROP DATABASE`, EVER. Re-runs the full name guard before issuing DDL, is a
   * no-op once the server has answered the DROP, and REFUSES BY NAME once one has been issued
   * without an answer — see the r11 rule at the top of this file.
   */
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
   * ONLY a test of this module replaces the migrator, and — like `mintName` — it buys nothing that
   * could widen what this module touches. WHICH database is created, WHICH is dropped and WHEN a
   * DROP is licensed are all decided BEFORE this runs, by the name guard and by the `CreateOutcome`
   * the server itself answered; a migrator cannot reach any of them. What it buys is that the
   * HANDLE this function returns — and therefore its one-shot `drop()` — is reachable from a proof
   * that has no Postgres, which is where the r11 finding lives. No lane passes it; the default is
   * the real `prisma migrate deploy` and `tests/throwaway-database-guard.test.ts` still exercises
   * that default.
   */
  runMigrations?: (laneDatabaseUrl: string) => Promise<void>
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
   * ONE DROP, USED BY EVERY PATH THAT NEEDS ONE — the caller's `drop()` and the migration failure
   * — so the name guard cannot be present on one route and missing from another. It opens its OWN
   * maintenance connection, because the connection that issued the CREATE has already been closed
   * by then.
   *
   * EVERY CALLER OF THIS IS DOWNSTREAM OF A COMPLETED `CREATE DATABASE`. That is the invariant the
   * r10 rule rests on, and it is structural rather than checked: this closure is only reachable
   * from the `'created'` branch below and from the handle that branch returns.
   *
   * AND IT ISSUES AT MOST ONE `DROP DATABASE`, EVER (r11). The state moves to `'answer-unknown'`
   * SYNCHRONOUSLY, before the first `await` of the first call — which is what makes two concurrent
   * calls impossible rather than merely unlikely: the second caller runs its checks in a later
   * tick and finds the handle already spent. See the r11 rule at the top of this file.
   */
  let dropOutcome: DropOutcome = 'not-issued'
  const dropDatabase = async (): Promise<void> => {
    // ANSWERED ALREADY. The database is gone, so a `finally` that always calls `drop()` is free.
    if (dropOutcome === 'dropped') return
    // ISSUED ALREADY AND NEVER ANSWERED. This is the whole of the r11 fix: the handle is SPENT.
    // Re-issuing would be this process acting on "it did not happen" when what it actually knows
    // is "I do not know" — and in the interval another provisioner may have minted and created
    // this very name, so the second DROP would destroy a database this process never created.
    if (dropOutcome === 'answer-unknown') {
      throw new ThrowawayDatabaseError(
        `refused to issue a SECOND DROP DATABASE for ${name}: this handle had already ISSUED one `
        + 'and never saw the server answer it, so this process does not know whether that DROP ran. '
        + 'A handle issues AT MOST ONE DROP: by now another provisioner may have created a database '
        + 'of this name, and a retry would destroy THAT database rather than this lane\'s. '
        + `${name} MAY STILL BE PRESENT ON THE SERVER and has to be inspected and dropped by hand`,
      )
    }
    // The guard again, on the way out. A handle that was tampered with cannot drop something real.
    // BEFORE the state moves, so a refused name leaves the handle unspent and the refusal repeats.
    assertThrowawayDatabaseName(name, configuredDatabase)
    // BEFORE the first await, deliberately and synchronously: from here until an answer arrives,
    // "the DROP may have run" is the most this process can honestly claim, and a second caller
    // reaching this function can only reach it after this assignment.
    dropOutcome = 'answer-unknown'
    await withMaintenanceClient(maintenance, async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`)
      // The server answered. Recorded HERE rather than after `withMaintenanceClient` returns, so a
      // failing `client.end()` cannot un-record a DROP the server had already confirmed — the same
      // reasoning that makes a completed CREATE survive a failed teardown.
      dropOutcome = 'dropped'
    })
  }

  /**
   * THE THREE ANSWERS `CREATE DATABASE` CAN GIVE (r7 LOW, r8 HIGH, r9 HIGH, r10 HIGH).
   *
   *   COMPLETED -> `created`. The server said this process created it. Anything that fails after
   *   that — the `client.end()` in the maintenance `finally`, for instance — still leaves a
   *   database whose creation this process WITNESSED, which is the one case a drop is licensed by.
   *
   *   `42P04` -> `not-created`. The server answered, and its answer was that the name was ALREADY
   *   TAKEN when the CREATE ran. Positive proof this call did not create the database.
   *
   *   NO ANSWER -> `answer-unknown`. A killed backend, a dropped TCP connection, a proxy timing
   *   out. `client.query` REJECTS and this process does not know which of the two answers it
   *   missed. It therefore drops NOTHING and names the database it may have left; see the
   *   cleanup rule at the top of this file for the three rounds that tried to do better.
   */
  // TYPED AS THE UNION, not narrowed to its initial member. It is reassigned inside the callback
  // below, and TypeScript's control-flow analysis does not account for that: left to narrow, it
  // decides the initial value is the only one and reports the `'created'` and `'answer-unknown'`
  // branches in the catch as impossible comparisons.
  let outcome = 'not-created' as CreateOutcome

  try {
    await withMaintenanceClient(maintenance, async (client) => {
      const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
      if (existing.rows.length > 0) {
        throw new ThrowawayDatabaseError(
          `refused ${name}: a database of that name ALREADY EXISTS, so this lane did not create it`,
        )
      }
      // BEFORE the await, deliberately: from here until an answer arrives, "may exist" is the
      // most this process can honestly claim, and it is the most it will ever claim.
      outcome = 'answer-unknown'
      try {
        await client.query(`CREATE DATABASE ${quoteIdentifier(name)}`)
      } catch (createError) {
        if (isDuplicateDatabaseError(createError)) {
          // The answer arrived and it was somebody else's name. Step BACK to not-created so this
          // is re-thrown unchanged: the same refusal the probe makes, arriving one statement later
          // because somebody else took the name in between.
          outcome = 'not-created'
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
      outcome = 'created'
    })
  } catch (error) {
    if (outcome === 'created') {
      // THE ONLY DROP ON A FAILED PROVISION, AND IT ASKS NOTHING. The server said yes; what failed
      // was afterwards. No probe, no stamp, no lock — there is nothing left to establish.
      let dropFailure: unknown = null
      try {
        await dropDatabase()
      } catch (dropError) {
        dropFailure = dropError
      }
      throw new ThrowawayDatabaseError(
        dropFailure === null
          ? `could not create ${name}: ${String(error)}. The CREATE had already been ISSUED and had `
            + 'SUCCEEDED, so the database this lane created was dropped; nothing was left behind'
          : `could not create ${name}: ${String(error)}. The CREATE had already been ISSUED and had `
            + `SUCCEEDED, and the DROP that would have cleaned it up ALSO FAILED (${String(dropFailure)}), `
            + `so ${name} IS LEFT ON THE SERVER and has to be dropped by hand`,
      )
    }

    if (outcome === 'answer-unknown') {
      // THE LEAK THIS MODULE ACCEPTS, SURFACED RATHER THAN GUESSED AT (r10).
      throw new ThrowawayDatabaseError(
        `could not create ${name}: ${String(error)}. The CREATE had already been ISSUED and NO ANSWER `
        + 'CAME BACK, so this process never learned whether the server executed it. NOTHING WAS '
        + 'DROPPED — this module drops only a CREATE it saw COMPLETE, because every way of deciding '
        + 'ownership after the fact can be satisfied by a database somebody else made — so '
        + `${name} MAY BE LEFT ON THE SERVER and has to be inspected and dropped by hand`,
      )
    }

    // `not-created` covers both refusals — the probe's and the `42P04` one — and every failure
    // before the CREATE was issued. Re-thrown UNCHANGED so those refusals keep the wording their
    // proofs match on, and, more to the point, WITHOUT ISSUING A DROP.
    throw error
  }

  const laneUrl = new URL(configured.toString())
  laneUrl.pathname = `/${encodeURIComponent(name)}`

  // NO SECOND WRAPPER AROUND `dropDatabase` (r11). There used to be one here, holding a `dropped`
  // flag it set only AFTER the drop returned — "so a drop that failed transiently can be
  // re-driven". That retry is the defect: a DROP whose answer was lost may already have run, the
  // name may already belong to somebody else's provision, and re-driving it destroys their
  // database. The one-shot state lives in `dropDatabase` itself, so the migration-failure path
  // below and the handle returned at the end share it and cannot each get a turn.

  try {
    if (options.runMigrations) await options.runMigrations(laneUrl.toString())
    else await execFileAsync(
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
    // Licensed by the SAME rule: getting here means the CREATE completed, so this is a drop of a
    // database this process watched itself create.
    let dropFailure: unknown = null
    try {
      await dropDatabase()
    } catch (dropError) {
      dropFailure = dropError
    }
    throw new ThrowawayDatabaseError(
      dropFailure === null
        ? `could not migrate ${name}, so the lane has no database to run against: ${String(error)}. `
          + 'The database this lane created was dropped; nothing was left behind'
        : `could not migrate ${name}, so the lane has no database to run against: ${String(error)}. `
          + `The DROP that would have cleaned it up ALSO FAILED (${String(dropFailure)}), so ${name} `
          + 'IS LEFT ON THE SERVER and has to be dropped by hand',
    )
  }

  return { name, url: laneUrl.toString(), configuredDatabase, drop: dropDatabase }
}
