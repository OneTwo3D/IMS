/**
 * o3d-alnk r22 — A LANE DATABASE IS ONE THIS RUN MARKED, ASKED OF THE SERVER.
 *
 * =========================================================================================
 * WHY THIS MODULE EXISTS: FIVE ROUNDS OF RECOGNISING PRODUCTION, AND THE INVERSION THAT ENDS IT.
 *
 * `processPendingEmailOutbox` is a SWEEP over the globally oldest queued customer emails. A
 * harness that hands it a FAKE sender and a REAL client stamps genuine customer rows SENT with
 * nothing delivered. Round 18 closed the "which CLIENT is this" half of that by MINTING: the
 * drain accepts only a client `createEmailOutboxHarnessClient` built, so no wrapper of `db` can
 * pass by resembling something. What it left open was the other half — a minted client whose
 * delegates are a REAL Prisma client on the LIVE database — and rounds 18 to 21 each tried to
 * close THAT by RECOGNISING the live database from the outside:
 *
 *   r18  compare `writesTo.url`'s PATH with `DATABASE_URL`'s path.
 *   r19  a pathless URL has no path and pg connects it to the database named by the USER, so the
 *        live URL spelled `postgresql://ims:pw@host` walked straight through. Fixed by resolving
 *        both sides through `new pg.Client({ connectionString })` and comparing the driver's answer.
 *   r21  found TWO more, and they are the ones that end the approach rather than extend it:
 *        (A) when `DATABASE_URL` is unset or empty there is NOTHING to compare against, and the
 *            comparison was SKIPPED — yet the app's own pool still connects, via `PGDATABASE`,
 *            `PGUSER` or the OS-user fallback. A client on the live queue was mintable with no
 *            `DATABASE_URL` set at all.
 *        (B) `PgClient.database` is the STARTUP database name, not verified server identity. A
 *            connection POOLER maps a configured alias onto a backend database of another name, so
 *            two URLs that reach THE SAME QUEUE compare UNEQUAL and the mint accepts one of them.
 *            This repository has been bitten by pooler semantics before — advisory locks are not
 *            exclusive behind a transaction pooler however exclusive they look on a bare connection.
 *
 * Every one of those is the same defect: a NAME is a claim ABOUT a database, made by the client,
 * before anything has asked the database. Aliases, environment fallbacks, poolers and whatever
 * spelling comes next are all ways for the claim and the destination to come apart, and the list
 * of them is not closed. A guard that must recognise production is a blacklist, and this surface
 * has now spent ten HIGHs learning what blacklists do here.
 *
 * =========================================================================================
 * SO THE QUESTION IS INVERTED, THE SAME WAY r18 INVERTED IT ONE LEVEL DOWN.
 *
 * A harness database is not "one whose name differs from production". IT IS ONE THIS RUN CREATED.
 * That is a POSITIVE property, it is not a property of any string, and — crucially — the only
 * party who can answer it is THE DATABASE ITSELF:
 *
 *   `createLaneDatabase` ISSUES THE `CREATE DATABASE` ITSELF and mints a `LaneDatabaseCreation`
 *   only when the server answers that statement with success. That object is the whole of this
 *   module's authority to write: it is minted nowhere else, it cannot be spelled, copied or
 *   forged, and there is no argument by which a caller can ask for one over a database that
 *   already exists — PostgreSQL answers `CREATE DATABASE` on a name that is taken with `42P04`.
 *
 *   `markLaneDatabase` takes that creation — not a NAME — and writes a marker row into the
 *   database it names, carrying a secret drawn once per process from `randomBytes` and never
 *   exported, written down, logged or sent anywhere else.
 *
 *   `attestLaneDatabase` CONNECTS with the very connection string the harness client will use,
 *   ASKS the backend it actually reaches for that marker, and mints an attestation only if the
 *   secret comes back equal.
 *
 * WHAT THAT BUYS, AND WHY IT IS NOT ONE MORE SPELLING CLOSED:
 *
 *   - THE BURDEN IS REVERSED. An unknown database is REFUSED BY DEFAULT instead of admitted by
 *     default. There is no enumeration to maintain, because nothing is enumerated: `PGDATABASE`,
 *     `PGUSER`, the OS-user fallback, a percent-encoded path, a host alias, a second port and
 *     every future spelling all fail closed for one reason — the database they reach has no
 *     marker. They do not each need a case.
 *   - `DATABASE_URL` IS NOT CONSULTED AT ALL, so HIGH A has nothing to skip. Unset, empty,
 *     unparseable or absent: none of it changes the answer, because the answer does not come from
 *     the configuration.
 *   - A POOLER IS ANSWERED BY THE BACKEND IT ROUTES TO (HIGH B). The attestation is not a
 *     comparison of two names; it is a READ over the same route. An alias that a pooler maps onto
 *     production reaches production, production carries no marker, and the attestation is refused
 *     — and `current_database()` in the same round trip reports the name the SERVER uses, not the
 *     one the client asked for, so what the refusal NAMES is the real destination too.
 *   - PRODUCTION CANNOT ACQUIRE THE PROPERTY BY ACCIDENT. The secret is 256 bits of
 *     `randomBytes`, minted per process, held in one module-private constant and written only by
 *     `markLaneDatabase`.
 *
 * =========================================================================================
 * WHERE THE CHECK GOES, GIVEN THAT ASKING A SERVER IS A ROUND TRIP.
 *
 * It CANNOT go inside `createEmailOutboxHarnessClient`: that is a synchronous mint, and making it
 * async would push a promise into every call site including the ones that build in-memory
 * fixtures. So the round trip happens EARLIER, at PROVISIONING TIME, and what the synchronous
 * mint checks is the ATTESTATION OBJECT the round trip produced — a `WeakSet` membership, exactly
 * the mechanism r18 used for the client, for exactly the same reason: it cannot be read off an
 * object, copied onto another, forged by a `Proxy` trap or survive a spread.
 *
 * THAT POINT IS EARLY ENOUGH, and the reason is structural rather than a matter of ordering luck:
 *
 *   1. the attestation is a PREREQUISITE of the mint, and the mint is a prerequisite of the drain,
 *      so no drain against a database can happen without the round trip having already SUCCEEDED;
 *   2. the round trip is strictly earlier than the drain's first query, because it is earlier than
 *      the CLIENT the drain would use;
 *   3. it costs one connect per LANE rather than one per mint or one per row, so nothing is
 *      tempted to skip it for speed.
 *
 * AND THE CEREMONY IS NONE. `provisionThrowawayDatabase` marks and attests a lane it created and
 * hands the attestation back ON THE HANDLE. A lane writes `writesTo: { kind: 'database',
 * attestation: lane.database.attestation }` and does nothing else; there is no URL for it to spell
 * correctly and no environment for it to arrange.
 *
 * =========================================================================================
 * WHY THIS LIVES IN `lib/` AND NOT IN `tests/`.
 *
 * The guard has to live with the thing it guards. `lib/email-outbox.ts` is what refuses an
 * unattested destination, and it cannot import from `tests/` — so the attestation it consults is
 * here, next to it, for the same reason `createEmailOutboxHarnessClient` is in `lib/` rather than
 * in the harness that calls it. Nothing in the application's own code path imports this module.
 *
 * =========================================================================================
 * WHAT IS STILL NOT CLOSED, SAID PLAINLY RATHER THAN IMPLIED.
 *
 *   1. A CLUSTER THAT RESTARTS BETWEEN THE CREATE AND THE MARK IS REFUSED. The creation carries the
 *      server's `pg_postmaster_start_time()`, and `markLaneDatabase` requires the lane connection to
 *      report the same one — which is how the creation is pinned to a CLUSTER and not merely to a
 *      NAME. A restart in that millisecond-wide window therefore fails a provision closed. That is
 *      the safe direction and it is stated rather than discovered.
 *   2. A NAME THAT IS FREE ON THIS CLUSTER CAN BE CREATED. If production's database did not exist,
 *      `createLaneDatabase` could create a database of its name — and it would then be an EMPTY
 *      database this run made, not production. What cannot happen is acquiring authority over a
 *      database that is ALREADY THERE, which is what every real production database is.
 *   3. DROPPING IS NOT THIS MODULE'S BUSINESS. `CREATE DATABASE` is the only DDL here; the
 *      throwaway helper owns `DROP DATABASE` and its own rules about when one is licensed.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * The marker a lane database carries. One table, one row.
 *
 * NAMED, NOT GUESSED AT: if an operator ever finds this table in a database that matters, the name
 * says where it came from and this file says what it is for.
 */
export const LANE_RUN_MARKER_TABLE = 'ims_lane_run_marker'

/**
 * THIS RUN'S SECRET. 256 bits, drawn once when this module is first loaded, module-private, and
 * never exported, logged, serialised or put in an error message.
 *
 * It leaves the process exactly once — into a database this process has just watched itself create
 * — and the only thing it is ever compared against is what comes back out of one.
 */
const RUN_MARKER_SECRET = randomBytes(32).toString('hex')

export class LaneDatabaseAttestationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LaneDatabaseAttestationError'
  }
}

function refuse(detail: string): never {
  throw new LaneDatabaseAttestationError(detail)
}

declare const LANE_DATABASE_ATTESTATION_BRAND: unique symbol

/**
 * PROOF THAT A ROUND TRIP HAPPENED AND THE DATABASE ANSWERED YES.
 *
 * The brand is declare-only: it exists in the type system and on no runtime object, so a caller
 * cannot spell it and cannot copy it off an attestation either. The runtime authority is the
 * `WeakSet` below; this is the compile-time half of the same rule.
 */
export type LaneDatabaseAttestation = {
  /** The name the SERVER gave for the database that answered — `current_database()`, not the URL. */
  readonly database: string
  readonly [LANE_DATABASE_ATTESTATION_BRAND]: 'minted by attestLaneDatabase'
}

/**
 * THE ATTESTATION REGISTER. Module-private and a `WeakSet`, so membership is not a property of the
 * object: it cannot be read off one, copied onto another, forged by a `Proxy` trap, or survive a
 * spread. Same mechanism as `MINTED_HARNESS_CLIENTS` in lib/email-outbox.ts, same reason.
 */
const MINTED_ATTESTATIONS = new WeakSet<object>()

/** Is this an attestation THIS RUN minted? The only question `createEmailOutboxHarnessClient` asks. */
export function isLaneDatabaseAttestation(value: unknown): value is LaneDatabaseAttestation {
  return typeof value === 'object' && value !== null && MINTED_ATTESTATIONS.has(value)
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** The slice of `pg.Client` this module uses, so a proof can drive it against a fake server. */
type LaneSqlClient = {
  connect(): Promise<void>
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
  end(): Promise<void>
}

/**
 * OPEN THE CONNECTION THE HARNESS CLIENT WOULD OPEN — and this is where the r21 LOW about
 * `new pg.Client` belongs, now that it is the only place this module builds one.
 *
 * CONSTRUCTING A `pg.Client` IS NOT I/O-FREE, and round 20's comment said it was. With the
 * installed `pg` 8.20.0 and `pg-connection-string` 2.12.0, the constructor parses the connection
 * string eagerly and pg-connection-string performs SYNCHRONOUS FILESYSTEM READS for the `sslcert`,
 * `sslkey` and `sslrootcert` query parameters (`fs.readFileSync`). No socket and no DNS — that part
 * of the old claim was true — but a file read is I/O, and it can:
 *
 *   THROW, on a path that does not exist or cannot be read (`ENOENT`, `EACCES`). Caught here and
 *   turned into a refusal, because a destination this module cannot even construct a client for is
 *   not a destination it can attest.
 *
 *   BLOCK, on a path whose filesystem is slow to answer — a dead NFS mount, a FIFO. Nothing in
 *   process can prevent that, and it is why the construction is HERE: inside an async function
 *   whose entire purpose is a round trip, rather than inside the synchronous mint where round 20
 *   put it on the strength of the "no I/O" claim. A slow read now delays a provisioning step that
 *   is already waiting on a server; it no longer stalls a constructor that promised not to wait.
 *
 * The path comes from the connection string this module is handed, which in the only shipped call
 * path is built by `provisionThrowawayDatabase` out of the configured `DATABASE_URL`. It is
 * therefore operator-controlled and not attacker-controlled — but it is not TRUSTED either, which
 * is why it is wrapped rather than argued about.
 */
async function openLaneConnection(url: unknown, what: string): Promise<LaneSqlClient> {
  if (typeof url !== 'string' || url.trim() === '') {
    refuse(`${what}: a connection string is required; received ${typeof url === 'string' ? 'an empty string' : typeof url}`)
  }

  const { default: pg } = await import('pg')
  let client: LaneSqlClient
  try {
    client = new pg.Client({ connectionString: url }) as unknown as LaneSqlClient
  } catch (error) {
    refuse(
      `${what}: node-postgres could not build a client for that connection string (${String(error)}). `
      + 'Construction reads `sslcert`/`sslkey`/`sslrootcert` off the filesystem, so a bad path fails '
      + 'here; a destination that cannot be connected to cannot be attested',
    )
  }

  try {
    await client.connect()
  } catch (error) {
    refuse(
      `${what}: could not connect (${String(error)}). An unreachable destination is REFUSED, never `
      + 'assumed safe — this module answers "is this a database this run created" and a connection '
      + 'that never opened has not answered it',
    )
  }
  return client
}

async function withLaneConnection<T>(
  url: unknown,
  what: string,
  run: (client: LaneSqlClient, reached: LaneDestination) => Promise<T>,
): Promise<T> {
  const client = await openLaneConnection(url, what)

  try {
    const reached = await destinationIdentityOf(client, what)
    return await run(client, reached)
  } finally {
    // A failed socket close cannot retract a statement the server already answered, so it is not
    // allowed to turn a completed round trip into a refusal (the same reasoning as the throwaway
    // helper's confirmed-DROP teardown).
    try {
      await client.end()
    } catch {
      // deliberately ignored — see above
    }
  }
}

/**
 * WHERE A CONNECTION LANDED, IN THE SERVER'S OWN WORDS. TWO FACTS, ONE ROUND TRIP.
 *
 * `current_database()` is the BACKEND's answer, which is the whole point of HIGH B: a pooler can
 * present one name to the client and route to another, and the client-side startup parameter is
 * the name that was ASKED for. This is the name that was GOT.
 *
 * `pg_postmaster_start_time()` is WHICH SERVER answered, to the microsecond it booted. A database
 * NAME is unique only within one cluster, so a creation that carried a name alone would license a
 * mark on a same-named database on ANY other reachable cluster. Pinning the cluster is what makes
 * `markLaneDatabase` a statement about the database this run created rather than about its name.
 * It is `pg_postmaster_start_time()` and not `pg_control_system()` because the latter is REVOKEd
 * from PUBLIC and a lane runs as an ordinary application role.
 */
type LaneDestination = {
  /** The name the SERVER gave — `current_database()`, not the URL. */
  readonly database: string
  /** The cluster that answered, as `pg_postmaster_start_time()` renders it. */
  readonly clusterStartedAt: string
}

const DESTINATION_IDENTITY_SQL =
  'SELECT current_database() AS database, pg_postmaster_start_time()::text AS cluster_started_at'

async function destinationIdentityOf(client: LaneSqlClient, what: string): Promise<LaneDestination> {
  let rows: Record<string, unknown>[]
  try {
    ;({ rows } = await client.query(DESTINATION_IDENTITY_SQL))
  } catch (error) {
    refuse(`${what}: the server would not say which database this connection reached (${String(error)})`)
  }
  const reached = rows[0]?.database
  if (typeof reached !== 'string' || reached === '') {
    refuse(`${what}: the server answered no database name for this connection`)
  }
  const clusterStartedAt = rows[0]?.cluster_started_at
  if (typeof clusterStartedAt !== 'string' || clusterStartedAt === '') {
    refuse(`${what}: the server answered no start time, so which CLUSTER answered is unestablished`)
  }
  return Object.freeze({ database: reached, clusterStartedAt })
}

/** The same fact, read off a connection that is not pointed at the database in question. */
const CLUSTER_IDENTITY_SQL = 'SELECT pg_postmaster_start_time()::text AS cluster_started_at'

async function clusterIdentityOf(client: LaneSqlClient, what: string): Promise<string> {
  let rows: Record<string, unknown>[]
  try {
    ;({ rows } = await client.query(CLUSTER_IDENTITY_SQL))
  } catch (error) {
    refuse(`${what}: the server would not say which cluster this connection reached (${String(error)})`)
  }
  const clusterStartedAt = rows[0]?.cluster_started_at
  if (typeof clusterStartedAt !== 'string' || clusterStartedAt === '') {
    refuse(`${what}: the server answered no start time, so which CLUSTER answered is unestablished`)
  }
  return clusterStartedAt
}

/** Constant-time, and length-safe: `timingSafeEqual` throws on a length mismatch. */
function secretMatchesThisRun(candidate: string): boolean {
  const mine = Buffer.from(RUN_MARKER_SECRET, 'utf8')
  const theirs = Buffer.from(candidate, 'utf8')
  if (mine.length !== theirs.length) return false
  return timingSafeEqual(mine, theirs)
}

declare const LANE_DATABASE_CREATION_BRAND: unique symbol

/**
 * PROOF THAT *THIS MODULE* ISSUED A `CREATE DATABASE` AND THE SERVER SAID YES.
 *
 * THE ONE FACT THAT REPLACES A CALLER'S WORD (r24, Codex HIGH). Until r24 the marker writer took a
 * `createdDatabaseName` STRING and checked it against `current_database()`. That check is sound and
 * it establishes THE DESTINATION'S NAME — not that the caller created the destination. So
 * `markLaneDatabase({ url: productionUrl, createdDatabaseName: 'onetwo3d_ims_dev' })` wrote this
 * run's secret INTO production, and `attestLaneDatabase` then minted a perfectly valid capability
 * over it: the exported minting authority could be aimed at anything the caller could name.
 *
 * A NAME CHECK IS NOT THE FIX, ONLY A NARROWER VOCABULARY — it still takes the caller's word about
 * WHICH database, just from a shorter list. What ends it is that the authority to write is no longer
 * something a caller can describe. `createLaneDatabase` is the only mint, it mints ONLY when the
 * server answered its own `CREATE DATABASE` with success, and PostgreSQL answers `CREATE DATABASE`
 * on a name that is already taken with `42P04`. A database that EXISTS therefore cannot be the
 * subject of a creation — and every production database exists.
 *
 * The brand is declare-only and the runtime authority is a module-private `WeakSet`, so a creation
 * cannot be spelled, read off another object, copied by a spread, or faked by a `Proxy` — the same
 * mechanism as the attestation register below, for the same reason.
 */
export type LaneDatabaseCreation = {
  /** The name this module passed to `CREATE DATABASE` and the server accepted. */
  readonly database: string
  readonly [LANE_DATABASE_CREATION_BRAND]: 'minted by createLaneDatabase'
}

const MINTED_CREATIONS = new WeakSet<object>()

/**
 * WHICH CLUSTER EACH CREATION WAS MADE ON. Held beside the creation rather than on it, so the
 * public shape stays one field and nothing can be re-pointed by handing back an edited copy.
 */
const CREATION_CLUSTERS = new WeakMap<object, string>()

/** Is this a creation THIS RUN minted? The only question `markLaneDatabase` asks. */
export function isLaneDatabaseCreation(value: unknown): value is LaneDatabaseCreation {
  return typeof value === 'object' && value !== null && MINTED_CREATIONS.has(value)
}

/**
 * WHAT THE SERVER SAID ABOUT A `CREATE DATABASE` THIS MODULE ISSUED.
 *
 * The three answers are the throwaway helper's `CreateOutcome`, reported as a VALUE rather than as
 * thrown-versus-returned, because the difference between them decides whether a `DROP DATABASE` is
 * licensed and that decision must not rest on reading an exception. `created-but-failed` is the
 * fourth shape and it is not a fourth answer: the CREATE COMPLETED and the teardown afterwards did
 * not, which is the r9 case — a completed CREATE survives a failed `client.end()`.
 */
export type LaneDatabaseCreateResult =
  | { outcome: 'created'; creation: LaneDatabaseCreation }
  | { outcome: 'created-but-failed'; creation: LaneDatabaseCreation; error: unknown }
  | { outcome: 'not-created'; error: unknown }
  | { outcome: 'answer-unknown'; error: unknown }

/**
 * ISSUE THE `CREATE DATABASE`, AND MINT AUTHORITY OVER WHAT IT CREATED.
 *
 * WHY THIS IS HERE AND NOT IN THE HELPER THAT CALLS IT. The rule this module rests on is the one
 * round 10 of the throwaway helper established — "this process SAW ITS OWN `CREATE DATABASE`
 * COMPLETE" — and a module cannot rest on a fact it was TOLD. It has to have watched. So the
 * statement is issued here, over a connection this function opened, and the creation it hands back
 * is minted on that statement's success and on nothing else.
 *
 * IT CANNOT BE AIMED AT PRODUCTION, and the reason is PostgreSQL's rather than ours: `CREATE
 * DATABASE` on a name that exists is rejected with SQLSTATE `42P04`, so a call naming the live
 * database returns `answer-unknown`/`not-created` carrying that rejection and mints nothing. There
 * is no argument to this function that names an EXISTING database and comes back with authority
 * over it. What it can do is create a database — which is the act the throwaway helper's own name
 * guard, register and drop rules govern, and which leaves an empty database rather than reaching
 * into a full one.
 *
 * THE TEARDOWN IS NOT SWALLOWED, unlike `withLaneConnection`'s. A CREATE that completed and a
 * `client.end()` that then failed is a real database on the server, and reporting it as "not
 * created" is exactly the leak round 9 caught. It comes back as `created-but-failed` so the caller
 * can drop what it now owns.
 */
export async function createLaneDatabase(request: {
  maintenanceUrl: string
  name: string
}): Promise<LaneDatabaseCreateResult> {
  const maintenanceUrl = request.maintenanceUrl // THE ONLY READ.
  const name = request.name // THE ONLY READ.
  if (typeof name !== 'string' || name.trim() === '') {
    return {
      outcome: 'not-created',
      error: new LaneDatabaseAttestationError(
        'createLaneDatabase: `name` must be the database to CREATE; this function does not take an '
        + 'existing database and never acquires authority over one',
      ),
    }
  }

  let client: LaneSqlClient
  try {
    client = await openLaneConnection(maintenanceUrl, 'createLaneDatabase')
  } catch (error) {
    // Nothing was issued, so nothing was created. The strongest true statement.
    return { outcome: 'not-created', error }
  }

  let creation: LaneDatabaseCreation | null = null
  let result: LaneDatabaseCreateResult | null = null
  try {
    // WHICH CLUSTER, ASKED BEFORE THE CREATE. It has to be read over the connection that issues the
    // statement, because that is the server the database comes into existence on; reading it later,
    // over the lane's own connection, would be reading it off the thing being checked.
    const clusterStartedAt = await clusterIdentityOf(client, 'createLaneDatabase')
    let answered = false
    try {
      await client.query(`CREATE DATABASE ${quoteIdentifier(name)}`)
      answered = true
    } catch (error) {
      // The statement was ISSUED and this process does not know whether it ran. `42P04` arrives
      // here too, and the caller keys on the SQLSTATE: this module does not interpret it, because
      // what it means for a DROP is the throwaway helper's rule and not this one's.
      result = { outcome: 'answer-unknown', error }
    }
    if (answered) {
      const minted = Object.freeze({ database: name })
      MINTED_CREATIONS.add(minted)
      CREATION_CLUSTERS.set(minted, clusterStartedAt)
      creation = minted as unknown as LaneDatabaseCreation
      result = { outcome: 'created', creation }
    }
  } catch (error) {
    // The cluster read refused, so the CREATE was never issued.
    result = { outcome: 'not-created', error }
  }

  try {
    await client.end()
  } catch (closeError) {
    // A COMPLETED CREATE SURVIVES A FAILED TEARDOWN (the r9 rule). Reporting this as "not created"
    // is what leaked a freshly created database, so the creation is handed back WITH the failure.
    if (creation !== null) return { outcome: 'created-but-failed', creation, error: closeError }
    // Nothing was created, so a failed close is just a failed call — except where the CREATE's own
    // answer was already lost, which is the stronger fact and is kept.
    if (result !== null && result.outcome === 'answer-unknown') return result
    return { outcome: 'not-created', error: closeError }
  }
  return result ?? {
    outcome: 'not-created',
    error: new LaneDatabaseAttestationError('createLaneDatabase: no outcome was recorded for the CREATE'),
  }
}

/**
 * WRITE THIS RUN'S MARKER INTO A DATABASE THIS MODULE CREATED.
 *
 * THE SUBJECT IS THE CREATION, NOT A NAME (r24, Codex HIGH). There is no `createdDatabaseName`
 * parameter any more, because a parameter is a caller's word and the whole finding was that the
 * exported minting authority would act on it. The only way to name a database here is to hold the
 * `LaneDatabaseCreation` `createLaneDatabase` minted for it — which requires a `CREATE DATABASE`
 * this module issued and the server accepted, and therefore requires that the database did not
 * exist a moment ago.
 *
 * AND THE CREATION IS CHECKED FROM THE OTHER SIDE TOO. The marker is written only if
 * `current_database()` — the SERVER's answer over this very connection — equals the created name
 * AND `pg_postmaster_start_time()` equals the cluster the CREATE ran on. So a pooler cannot be used
 * to mark through an alias, and a same-named database on a DIFFERENT reachable cluster is not the
 * database this creation is about.
 *
 * THE TABLE IS CREATED WITHOUT `IF NOT EXISTS`, deliberately. A database that already carries a
 * marker is not a database this call has just created, and the `42P07` that comes back says so
 * rather than silently overwriting somebody else's evidence with ours.
 */
export async function markLaneDatabase(creation: LaneDatabaseCreation, laneUrl: string): Promise<void> {
  if (!isLaneDatabaseCreation(creation)) {
    refuse(
      'markLaneDatabase: the first argument is not a creation this run minted. This function no '
      + 'longer takes the NAME of a database the caller says it created — a name is a claim, and '
      + 'acting on it let an exported entry point write this run\'s secret into ANY database the '
      + 'caller could spell, production included. Obtain a `LaneDatabaseCreation` from '
      + '`createLaneDatabase`, which mints one only for a `CREATE DATABASE` this module issued and '
      + 'the server accepted (o3d-alnk r24)',
    )
  }
  const created = (creation as unknown as { database: string }).database
  const createdOnCluster = CREATION_CLUSTERS.get(creation as unknown as object)
  if (typeof createdOnCluster !== 'string') {
    refuse('markLaneDatabase: that creation carries no cluster, so which server it was made on is unestablished')
  }

  await withLaneConnection(laneUrl, 'markLaneDatabase', async (client, reached) => {
    if (reached.database !== created) {
      refuse(
        `markLaneDatabase: this connection reaches ${reached.database}, not ${created}. The marker is `
        + 'written ONLY into the database this process watched itself CREATE, so a connection that '
        + 'lands somewhere else — through a pooler alias, a PG* fallback, or a mistyped URL — is '
        + 'refused rather than marked',
      )
    }
    if (reached.clusterStartedAt !== createdOnCluster) {
      refuse(
        `markLaneDatabase: ${reached.database} is on a DIFFERENT server from the one this run created `
        + `${created} on (the cluster that answered started at ${reached.clusterStartedAt}). A database `
        + 'NAME is unique only within one cluster, so a same-named database somewhere else is not the '
        + 'database this creation is about',
      )
    }

    try {
      await client.query(
        `CREATE TABLE ${quoteIdentifier(LANE_RUN_MARKER_TABLE)} (`
        + ' sole boolean PRIMARY KEY DEFAULT true CHECK (sole),'
        + ' secret text NOT NULL,'
        + ' marked_by_pid integer NOT NULL,'
        + ' marked_at timestamptz NOT NULL DEFAULT now()'
        + ')',
      )
    } catch (error) {
      refuse(
        `markLaneDatabase: could not create ${LANE_RUN_MARKER_TABLE} in ${reached.database} (${String(error)}). `
        + 'If the table is already there, this database was marked before and is NOT one this call '
        + 'just created',
      )
    }

    try {
      await client.query(
        `INSERT INTO ${quoteIdentifier(LANE_RUN_MARKER_TABLE)} (sole, secret, marked_by_pid) VALUES (true, $1, $2)`,
        [RUN_MARKER_SECRET, process.pid],
      )
    } catch (error) {
      refuse(`markLaneDatabase: could not write the marker row into ${reached.database} (${String(error)})`)
    }
  })
}

/**
 * ASK THE DATABASE THIS CONNECTION STRING REACHES WHETHER IT CARRIES THIS RUN'S MARKER, AND MINT
 * AN ATTESTATION ONLY IF IT DOES.
 *
 * READ-ONLY, AND THAT IS LOAD-BEARING. If this function wrote anything, pointing it at production
 * would MAKE production attestable — the guard would manufacture the property it is checking for.
 * Every statement here is a `SELECT`.
 *
 * EVERY OTHER ANSWER IS A REFUSAL. No marker table, no row, more than one row, a row whose secret
 * is another process's: all of them mean the same thing — this is not a database this run created —
 * and none of them is a case that had to be anticipated.
 */
export async function attestLaneDatabase(url: string): Promise<LaneDatabaseAttestation> {
  return withLaneConnection(url, 'attestLaneDatabase', async (client, reached) => {
    let rows: Record<string, unknown>[]
    try {
      ;({ rows } = await client.query(`SELECT secret FROM ${quoteIdentifier(LANE_RUN_MARKER_TABLE)}`))
    } catch (error) {
      refuse(
        `attestLaneDatabase: the database this connection string REACHES (${reached.database}) does not carry a `
        + `readable ${LANE_RUN_MARKER_TABLE} (${String(error)}), so it is not a database this run created. `
        + 'Provision one with tests/helpers/throwaway-database.ts and use the attestation on its handle',
      )
    }
    if (rows.length !== 1) {
      refuse(
        `attestLaneDatabase: ${reached.database} carries ${rows.length} marker rows, not 1, so nothing here `
        + 'establishes which run created it',
      )
    }
    const secret = rows[0]?.secret
    if (typeof secret !== 'string' || !secretMatchesThisRun(secret)) {
      refuse(
        `attestLaneDatabase: ${reached.database} carries a lane marker THIS RUN DID NOT WRITE. The secret is drawn `
        + 'once per process, so a marker from another run — or from another process still running — is '
        + 'not evidence that THIS run may drain that database',
      )
    }

    // FRESH, FROZEN, AND THE OBJECT THAT IS REGISTERED. A copy of it is not an attestation.
    const attestation = Object.freeze({ database: reached.database })
    MINTED_ATTESTATIONS.add(attestation)
    return attestation as unknown as LaneDatabaseAttestation
  })
}
