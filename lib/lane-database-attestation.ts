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
 *   `markLaneDatabase` writes a marker row into a database THIS PROCESS HAS JUST WATCHED ITSELF
 *   CREATE, carrying a secret drawn once per process from `randomBytes` and never exported,
 *   written down, logged or sent anywhere else.
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
 *   1. `markLaneDatabase` WRITES. A caller who points it at production, and who also tells it that
 *      production's database name is the name it just created, gets a marker table in production
 *      and can then attest it. That is not preventable in process — no connection can prove it was
 *      opened moments after a `CREATE DATABASE` — and it is not the same hazard as the one this
 *      module removes. The default moved: it used to be that an unrecognised spelling was ADMITTED
 *      and the guard had to catch it; it is now that an unmarked database is REFUSED and a caller
 *      has to deliberately write a table called `ims_lane_run_marker` INTO PRODUCTION, naming
 *      production, at one greppable call site, to change that. It also leaves evidence an operator
 *      can find afterwards, which a spelling never did.
 *   2. THE DELEGATES CAN STILL LIE. A minted client's `emailOutbox` delegate is whatever the caller
 *      passed; an attested destination says nothing about it, because a Prisma delegate does not
 *      know which database it writes to. That is the r18 residue, unchanged, and it is filed as
 *      o3d-dhhd rather than papered over.
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
async function withLaneConnection<T>(
  url: unknown,
  what: string,
  run: (client: LaneSqlClient, reachedDatabase: string) => Promise<T>,
): Promise<T> {
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

  try {
    const reached = await currentDatabaseOf(client, what)
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
 * WHAT THE SERVER CALLS THE DATABASE THIS CONNECTION ACTUALLY REACHED.
 *
 * `current_database()` is the BACKEND's answer, which is the whole point of HIGH B: a pooler can
 * present one name to the client and route to another, and the client-side startup parameter is
 * the name that was ASKED for. This is the name that was GOT.
 */
async function currentDatabaseOf(client: LaneSqlClient, what: string): Promise<string> {
  let rows: Record<string, unknown>[]
  try {
    ;({ rows } = await client.query('SELECT current_database() AS database'))
  } catch (error) {
    refuse(`${what}: the server would not say which database this connection reached (${String(error)})`)
  }
  const reached = rows[0]?.database
  if (typeof reached !== 'string' || reached === '') {
    refuse(`${what}: the server answered no database name for this connection`)
  }
  return reached
}

/** Constant-time, and length-safe: `timingSafeEqual` throws on a length mismatch. */
function secretMatchesThisRun(candidate: string): boolean {
  const mine = Buffer.from(RUN_MARKER_SECRET, 'utf8')
  const theirs = Buffer.from(candidate, 'utf8')
  if (mine.length !== theirs.length) return false
  return timingSafeEqual(mine, theirs)
}

/**
 * WRITE THIS RUN'S MARKER INTO A DATABASE THIS PROCESS HAS JUST WATCHED ITSELF CREATE.
 *
 * `createdDatabaseName` is not decoration and it is not trust: the marker is written only if
 * `current_database()` — the SERVER's answer over this very connection — equals it. So a pooler
 * cannot be used to mark through an alias either, and a caller who wants to mark something other
 * than what it created has to type that something's real name in as the name it created. The one
 * shipped call site passes a name that has already been through `assertThrowawayDatabaseName`,
 * which refuses every protected name and the configured database besides.
 *
 * THE TABLE IS CREATED WITHOUT `IF NOT EXISTS`, deliberately. A database that already carries a
 * marker is not a database this call has just created, and the `42P07` that comes back says so
 * rather than silently overwriting somebody else's evidence with ours.
 */
export async function markLaneDatabase(lane: { url: string; createdDatabaseName: string }): Promise<void> {
  const url = lane.url // THE ONLY READ.
  const createdDatabaseName = lane.createdDatabaseName // THE ONLY READ.
  if (typeof createdDatabaseName !== 'string' || createdDatabaseName === '') {
    refuse('markLaneDatabase: `createdDatabaseName` must be the name of the database this process created')
  }

  await withLaneConnection(url, 'markLaneDatabase', async (client, reached) => {
    if (reached !== createdDatabaseName) {
      refuse(
        `markLaneDatabase: this connection reaches ${reached}, not ${createdDatabaseName}. The marker is `
        + 'written ONLY into the database this process watched itself CREATE, so a connection that '
        + 'lands somewhere else — through a pooler alias, a PG* fallback, or a mistyped URL — is '
        + 'refused rather than marked',
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
        `markLaneDatabase: could not create ${LANE_RUN_MARKER_TABLE} in ${reached} (${String(error)}). `
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
      refuse(`markLaneDatabase: could not write the marker row into ${reached} (${String(error)})`)
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
        `attestLaneDatabase: the database this connection string REACHES (${reached}) does not carry a `
        + `readable ${LANE_RUN_MARKER_TABLE} (${String(error)}), so it is not a database this run created. `
        + 'Provision one with tests/helpers/throwaway-database.ts and use the attestation on its handle',
      )
    }
    if (rows.length !== 1) {
      refuse(
        `attestLaneDatabase: ${reached} carries ${rows.length} marker rows, not 1, so nothing here `
        + 'establishes which run created it',
      )
    }
    const secret = rows[0]?.secret
    if (typeof secret !== 'string' || !secretMatchesThisRun(secret)) {
      refuse(
        `attestLaneDatabase: ${reached} carries a lane marker THIS RUN DID NOT WRITE. The secret is drawn `
        + 'once per process, so a marker from another run — or from another process still running — is '
        + 'not evidence that THIS run may drain that database',
      )
    }

    // FRESH, FROZEN, AND THE OBJECT THAT IS REGISTERED. A copy of it is not an attestation.
    const attestation = Object.freeze({ database: reached })
    MINTED_ATTESTATIONS.add(attestation)
    return attestation as unknown as LaneDatabaseAttestation
  })
}
