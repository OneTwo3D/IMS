/**
 * MARK A DATABASE AS DISPOSABLE, so the concurrency tier's guard will use it.
 *
 *   npm run db:stamp-scratch   -- <database-name>     # stamp it
 *   npm run db:unstamp-scratch -- <database-name>     # take the stamp off again
 *
 * The guard (tests/concurrency/scratch-database-guard.ts) refuses to seed anything into a database
 * unless, among other facts it asks the server for, the database carries this stamp:
 * `COMMENT ON DATABASE <db> IS '<marker naming that database>'`. The stamp lives outside every
 * schema (so the schema-drift gate cannot see it) and survives `prisma migrate deploy`.
 *
 * WHAT THE STAMP IS, AND IS NOT (o3d-zzgp r9, review MEDIUM-4, agreeing with the guard's r8 M-2
 * correction). It is a SENTENCE an owner of the database wrote, naming the database. It is not
 * proof that this script ran, nor that the database was empty: the marker text is a constant in
 * this repository and one hand-written `COMMENT ON DATABASE` produces the same sentence without any
 * of the checks below. What this script adds is that the ACCIDENTAL path — a wrong DATABASE_URL, a
 * tenant host, an inherited `.env.local` — does not produce a stamp: it must be given the name, and
 * it refuses a database that holds application data, is a replica, a template, a subscriber, wired
 * to another server, or named in the belt.
 *
 * WHY IT TAKES THE NAME AS AN ARGUMENT (r7). Round 6's stamper read DATABASE_URL, took no argument,
 * never looked at what the database held, and printed the export line to paste — so it stamped a
 * live tenant-shaped database full of rows and the guard then accepted it. The argument must equal
 * `current_database()`, which a copy-pasted URL does not supply.
 *
 * NOT OWNERSHIP. provision-ims-tenant.sh hands every tenant database to the role in its own
 * DATABASE_URL, so "only an owner can set it" excludes nobody who can read a `.env`.
 *
 * HOW IT TALKS TO THE SERVER (r9, corrected r10):
 *   · BOTH connections start with the data probe's PROBE_SESSION_OPTIONS — `row_security=off`
 *     and `standard_conforming_strings=on` — and send one statement per call over the extended
 *     protocol. The reader also defaults to read-only. The probe's rules 1–3 keep catalogue TEXT
 *     from becoming SQL (review r9 MEDIUM-1 reproduced a write through the read-only default with
 *     `COMMIT; BEGIN READ WRITE; …` smuggled in a catalogue name, so the default is a second layer).
 *     Rule 4, `row_security=off`, is what keeps a table's POLICY from running: r10's review planted
 *     a policy calling a function that creates a table whenever the transaction is read-write, and
 *     r9's writer, re-running the probe in the transaction that commits, executed it.
 *   · the single COMMENT runs on a second connection, inside a transaction that FIRST re-checks
 *     it reached the same SERVER and the same DATABASE the facts came from (oid, postmaster start
 *     time, server address and port — review MEDIUM-3) and that the comment it is about to replace
 *     is still the one the reader saw (r10 LOW-4), then RE-RUNS the data and installation checks
 *     (review L7) inside a SAVEPOINT made read-only with `SET LOCAL transaction_read_only = on` and
 *     rolled back before the COMMENT (r10 MEDIUM-1) — so the re-check runs under read-only
 *     transaction semantics even on the writing connection, and the COMMENT is the only statement
 *     that runs read-write. The re-check is not a lock: rows another session commits between it
 *     and COMMIT are not seen.
 *   · `--unstamp` reads only the name, the server identity and the comment. It never runs the data
 *     probe (review L6), and it decides on the comment the WRITER re-reads (r10 LOW-4).
 */

import { pathToFileURL } from 'node:url'

import {
  ALWAYS_REFUSED_DATABASE,
  expectedScratchDatabaseMarker,
} from '../tests/concurrency/scratch-database-guard'
import {
  PROBE_SESSION_OPTIONS,
  readDataFacts,
  readInstallationEvidence,
  RowSecurityPolicyPresent,
  type ExtendedQueryClient,
} from '../tests/concurrency/scratch-database-data-probe'

/**
 * The two marker forms this script has ever written — `ims-scratch-database(<name>): …` since r7 and
 * `ims-scratch-database: …` in r6 — matched EXACTLY on their opening, not by a bare prefix (review
 * L8), so `--unstamp` cannot remove some other comment that merely starts with the same word.
 */
const MARKER_OPENINGS = ['ims-scratch-database(', 'ims-scratch-database:'] as const

export function isScratchMarker(comment: string | null): comment is string {
  return comment !== null && MARKER_OPENINGS.some((opening) => comment.startsWith(opening))
}

type PgClient = ExtendedQueryClient & { connect: () => Promise<void>; end: () => Promise<void> }

/**
 * Who answered: the database by name AND oid, and the server by postmaster start time, address and
 * port (review M3). This is this script's OWN identity, not the one lib/db/database-url-schema.mjs
 * records for a backend (that is address, port, server_version, server_encoding and datctype — r10
 * LOW-3 corrected a comment that said they were the same). The oid and the postmaster start time
 * are what that one lacks and this needs: a database dropped and recreated under the same name, or
 * a server restarted or failed over behind the same address, changes one of them. Through a Unix
 * socket the address and port read `local-socket` on both connections, so there the oid and start
 * time carry the comparison.
 */
type Identity = {
  name: string
  oid: string
  postmasterStart: string
  serverAddr: string
  serverPort: string
  comment: string | null
}

const IDENTITY_SQL = `
  SELECT pg_catalog.current_database() AS name,
         d.oid::text AS oid,
         pg_catalog.pg_postmaster_start_time()::text AS postmaster_start,
         COALESCE(pg_catalog.inet_server_addr()::text, 'local-socket') AS server_addr,
         COALESCE(pg_catalog.inet_server_port()::text, 'local-socket') AS server_port,
         pg_catalog.shobj_description(d.oid, 'pg_database') AS comment
    FROM pg_catalog.pg_database d
   WHERE d.datname = pg_catalog.current_database()`

async function ask<T>(client: ExtendedQueryClient, text: string): Promise<T[]> {
  const { rows } = await client.query({ text, values: [], queryMode: 'extended' })
  return rows as T[]
}

async function readIdentity(client: ExtendedQueryClient): Promise<Identity> {
  const [row] = await ask<{
    name: string; oid: string; postmaster_start: string; server_addr: string; server_port: string; comment: string | null
  }>(client, IDENTITY_SQL)
  if (!row) throw new Error('the server returned no row for the connected database')
  return {
    name: String(row.name ?? ''),
    oid: row.oid,
    postmasterStart: row.postmaster_start,
    serverAddr: row.server_addr,
    serverPort: row.server_port,
    comment: row.comment ?? null,
  }
}

export function sameServerAndDatabase(a: Identity, b: Identity): boolean {
  return a.name === b.name && a.oid === b.oid && a.postmasterStart === b.postmasterStart
    && a.serverAddr === b.serverAddr && a.serverPort === b.serverPort
}

type Facts = {
  identity: Identity
  inRecovery: boolean
  isTemplate: boolean
  /** null when the catalogue could not be read — a REFUSAL here, see `refuseToStamp`. */
  subscriptionCount: number | null
  populatedTables: string[]
  foreignTables: string[]
}

async function readStampFacts(client: ExtendedQueryClient, appSchema: string): Promise<Facts> {
  const identity = await readIdentity(client)
  const [state] = await ask<{ in_recovery: boolean; is_template: boolean }>(client, `
    SELECT pg_catalog.pg_is_in_recovery() AS in_recovery, d.datistemplate AS is_template
      FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()`)
  let subscriptionCount: number | null = null
  try {
    const [row] = await ask<{ count: string }>(client, `
      SELECT pg_catalog.count(*)::text AS count FROM pg_catalog.pg_subscription
       WHERE subdbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())`)
    subscriptionCount = Number(row!.count)
  } catch {
    subscriptionCount = null
  }
  const data = await readDataFacts(client, appSchema)
  return {
    identity,
    inRecovery: state?.in_recovery === true,
    isTemplate: state?.is_template === true,
    subscriptionCount,
    populatedTables: data.populated,
    foreignTables: data.foreign,
  }
}

/**
 * The reasons a stamp must never be APPLIED, whoever asks (removing one, `--unstamp`, is deliberately
 * not gated by these — see main()). Pure, so the unit table can cover every one without a server.
 */
export function refuseToStamp(input: {
  database: string
  requestedName: string | undefined
  inRecovery: boolean
  isTemplate: boolean
  subscriptionCount: number | null
  populatedTables: string[]
  foreignTables?: string[]
}): string | null {
  if (!input.database) return 'the server reported no database name'
  if (input.requestedName === undefined) {
    return 'no database name was given. Name the database you mean as an argument — '
      + 'npm run db:stamp-scratch -- <database-name> — so that stamping is a decision about a '
      + 'database rather than a consequence of whatever DATABASE_URL happens to be set to'
  }
  if (input.requestedName !== input.database) {
    // DOES NOT NAME THE DATABASE THE URL REACHED (review L-5): echoing current_database() here
    // made the argument one guided retry away — the refusal would tell the operator exactly what
    // to type next. Whoever set DATABASE_URL knows what it points at; the refusal need not.
    return `the name given ("${input.requestedName}") is not the database this DATABASE_URL reaches`
  }
  if (ALWAYS_REFUSED_DATABASE.test(input.database)) {
    return `the name matches ${ALWAYS_REFUSED_DATABASE}, which is a real or server-owned database`
  }
  if (input.inRecovery) return 'the server is in recovery, so this is a replica'
  if (input.isTemplate) return 'it is a template database'
  // FAILS CLOSED, unlike the guard (review LOW-4). The guard may treat an unreadable
  // pg_subscription as "no evidence" because the stamp is what excludes a copy for it; here the
  // stamp is what is being HANDED OUT, so an unanswerable question is a refusal.
  if (input.subscriptionCount === null) {
    return 'whether this database is a logical-replication subscriber could not be read '
      + '(pg_subscription is not readable to this role), and a database that might be a copy of '
      + 'another one must not be marked disposable'
  }
  if (input.subscriptionCount > 0) {
    return `it is the target of ${input.subscriptionCount} logical-replication subscription(s), so it is a copy of another database`
  }
  if ((input.foreignTables ?? []).length > 0) {
    return `it has foreign tables (${input.foreignTables!.slice(0, 3).join(', ')}), so it is wired to another `
      + 'server; a database created for a test run is self-contained'
  }
  if (input.populatedTables.length > 0) {
    const shown = input.populatedTables.slice(0, 5).join(', ')
    const more = input.populatedTables.length > 5 ? ` (and ${input.populatedTables.length - 5} more)` : ''
    return `it holds application data — rows in ${shown}${more}. A database created for a test run has `
      + 'none, so this is a database in use'
  }
  return null
}

/**
 * THE ONE PLACE CATALOGUE TEXT ENTERS A STRING LITERAL, and why it is allowed (r10 LOW-2). The
 * probe module's rule 1 keeps catalogue-derived text out of string literals, because a literal's
 * quoting changes with `standard_conforming_strings`. The marker in the COMMENT below contains
 * `current_database()`, so it is an exception to that rule, and it is safe for two reasons that
 * both hold here: the writer's startup options pin `standard_conforming_strings=on`, so a backslash
 * is an ordinary character and doubling `'` is the complete escape; and the statement goes through
 * the extended protocol, so even a mis-quoted literal could not start a second statement. The
 * reviewer checked it with a database named `q'\` on a database with the setting forced off.
 * `COMMENT … IS` accepts only a literal (no bind parameter), which is why it is not a parameter.
 */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/**
 * Both connections: sanitised URL and PROBE_SESSION_OPTIONS (row_security=off, conforming strings
 * on); the reader is also read-only by default.
 */
export function connectionOptions(readOnly: boolean): string {
  return `${readOnly ? '-c default_transaction_read_only=on ' : ''}${PROBE_SESSION_OPTIONS}`
}

/**
 * ONLY the integration test passes this (tests/concurrency/stamp-scratch-database.test.ts). It runs
 * after the reader has closed and before the writer opens — the window the writer's checks exist
 * for — so the test can change the database there (recreate it, add a row, change its comment) and
 * show each check refusing. It widens nothing: whatever it does is done by the test's own
 * connection, and every check below still runs.
 */
export type StampHooks = { betweenReadAndWrite?: () => Promise<void> }

export async function main(argv: string[], hooks: StampHooks = {}): Promise<number> {
  const unstamp = argv.includes('--unstamp')
  const requestedName = argv.find((arg) => !arg.startsWith('--'))

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set; point it at the database you created for this test run')
    return 2
  }
  const { databaseUrlSchema, sanitisedProbeConnectionString } = await import('../lib/db/database-url-schema.mjs')
  const connectionString = sanitisedProbeConnectionString(databaseUrl)
  if (connectionString === null) {
    console.error('DATABASE_URL is not a URL, so its connection parameters cannot be sanitised')
    return 2
  }
  // The schema the APPLICATION resolves from this URL — the only schema in which the three
  // migration-seeded tables are exempt from the data check.
  const appSchema = databaseUrlSchema(databaseUrl) ?? 'public'

  const { default: pg } = await import('pg')
  const open = async (readOnly: boolean): Promise<PgClient> => {
    const client = new pg.Client({
      connectionString,
      options: connectionOptions(readOnly),
      application_name: 'o3d-stamp-scratch-database',
    }) as unknown as PgClient
    await client.connect()
    return client
  }

  // ---------------------------------------------------------------- --unstamp (review L6)
  // Reads the name, the identity and the comment — nothing else, never the data probe. It is
  // deliberately NOT behind the refusal table: removing a marker only makes the guard stricter,
  // and gating it would block the clean-up that matters most (a hand-written marker on a real
  // database). It still requires the exact name.
  if (unstamp) {
    const reader = await open(true)
    let identity: Identity
    try {
      identity = await readIdentity(reader)
    } finally {
      await reader.end().catch(() => {})
    }
    if (requestedName !== identity.name) {
      console.error('REFUSING to unstamp: the name given is not the database this DATABASE_URL reaches')
      return 1
    }
    if (identity.comment === null) {
      console.log(`"${identity.name}" carries no database comment; nothing to remove.`)
      return 0
    }
    if (!isScratchMarker(identity.comment)) {
      console.error(`REFUSING to unstamp "${identity.name}": its comment is not a scratch marker, and this script `
        + 'will not remove a comment it did not write')
      return 1
    }
    await hooks.betweenReadAndWrite?.()
    const writer = await open(false)
    try {
      await ask(writer, 'BEGIN')
      const seen = await readIdentity(writer)
      if (!sameServerAndDatabase(identity, seen)) {
        await ask(writer, 'ROLLBACK')
        console.error('REFUSING to unstamp: the writing connection reached a different server or database')
        return 1
      }
      // DECIDED ON WHAT THE WRITER SEES (r10 LOW-4): r9 re-read the comment here and ignored it.
      if (seen.comment !== identity.comment || !isScratchMarker(seen.comment)) {
        await ask(writer, 'ROLLBACK')
        console.error(`REFUSING to unstamp "${identity.name}": its comment changed after it was read`)
        return 1
      }
      await ask(writer, `COMMENT ON DATABASE ${quoteIdentifier(identity.name)} IS NULL`)
      await ask(writer, 'COMMIT')
    } finally {
      await writer.end().catch(() => {})
    }
    console.log(`Removed the scratch marker from "${identity.name}".`)
    return 0
  }

  // ---------------------------------------------------------------- stamp
  const reader = await open(true)
  let facts: Facts
  try {
    facts = await readStampFacts(reader, appSchema)
  } catch (error) {
    if (error instanceof RowSecurityPolicyPresent) {
      console.error(`REFUSING to stamp: ${error.message}`)
      return 1
    }
    throw error
  } finally {
    await reader.end().catch(() => {})
  }

  const refusal = refuseToStamp({
    database: facts.identity.name,
    requestedName,
    inRecovery: facts.inRecovery,
    isTemplate: facts.isTemplate,
    subscriptionCount: facts.subscriptionCount,
    populatedTables: facts.populatedTables,
    foreignTables: facts.foreignTables,
  })
  if (refusal) {
    console.error(`REFUSING to stamp "${facts.identity.name || '<unknown>'}": ${refusal}`)
    return 1
  }

  const marker = expectedScratchDatabaseMarker(facts.identity.name)
  if (facts.identity.comment === marker) {
    console.log(`"${facts.identity.name}" is already stamped disposable.`)
    return 0
  }
  if (facts.identity.comment !== null) {
    console.error(
      `REFUSING to stamp "${facts.identity.name}": it already carries a different database comment `
      + `("${facts.identity.comment}"), which a database created for a test run does not have`,
    )
    return 1
  }

  await hooks.betweenReadAndWrite?.()
  const writer = await open(false)
  try {
    await ask(writer, 'BEGIN')
    const seen = await readIdentity(writer)
    // SAME SERVER, SAME DATABASE (review M3) — not just the same name.
    if (!sameServerAndDatabase(facts.identity, seen)) {
      await ask(writer, 'ROLLBACK')
      console.error('REFUSING to stamp: the writing connection reached a different server or database than the checks')
      return 1
    }
    // THE COMMENT THIS WILL REPLACE IS STILL THE ONE THE READER SAW — none (r10 LOW-4).
    if (seen.comment !== facts.identity.comment) {
      await ask(writer, 'ROLLBACK')
      console.error(`REFUSING to stamp "${facts.identity.name}": its database comment changed after it was read`)
      return 1
    }
    // RE-CHECKED ON THE WRITER, IN THIS TRANSACTION, IMMEDIATELY BEFORE THE COMMENT (review L7),
    // under READ-ONLY transaction semantics (r10 MEDIUM-1): the savepoint is made read-only and
    // rolled back, which restores read-write for the COMMENT alone. row_security=off (startup
    // options) is what stops a policy running at all; the savepoint is the layer under it, twice
    // over — anything the re-check did run could not write, and a transactional write that got
    // through would be discarded by the rollback to the savepoint (measured by mutation: with
    // row_security on and the read-only line removed, the policy's table was still gone; with the
    // whole savepoint removed — r9's shape — it survived). Not a lock: a row another session
    // commits after this read and before COMMIT is not seen.
    let data: Awaited<ReturnType<typeof readDataFacts>>
    let installation: Awaited<ReturnType<typeof readInstallationEvidence>>
    try {
      await ask(writer, 'SAVEPOINT stamp_recheck')
      await ask(writer, 'SET LOCAL transaction_read_only = on')
      data = await readDataFacts(writer, appSchema)
      installation = await readInstallationEvidence(writer)
      await ask(writer, 'ROLLBACK TO SAVEPOINT stamp_recheck')
      await ask(writer, 'RELEASE SAVEPOINT stamp_recheck')
    } catch (error) {
      await ask(writer, 'ROLLBACK').catch(() => {})
      if (error instanceof RowSecurityPolicyPresent) {
        console.error(`REFUSING to stamp "${facts.identity.name}" at the last moment: ${error.message}`)
        return 1
      }
      throw error
    }
    const late = refuseToStamp({
      database: facts.identity.name,
      requestedName,
      inRecovery: facts.inRecovery,
      isTemplate: facts.isTemplate,
      subscriptionCount: facts.subscriptionCount,
      populatedTables: [...data.populated, ...installation.evidence],
      foreignTables: data.foreign,
    })
    if (late) {
      await ask(writer, 'ROLLBACK')
      console.error(`REFUSING to stamp "${facts.identity.name}" at the last moment: ${late}`)
      return 1
    }
    await ask(writer, `COMMENT ON DATABASE ${quoteIdentifier(facts.identity.name)} IS ${quoteLiteral(marker)}`)
    await ask(writer, 'COMMIT')
  } finally {
    await writer.end().catch(() => {})
  }
  // DELIBERATELY NOT A PASTE-READY EXPORT LINE (review r7 LOW-3).
  console.log(`Stamped "${facts.identity.name}" disposable. docs/development.md, "Database-backed tiers", `
    + 'has the rest of the setup.')
  return 0
}

// Only when RUN, never when imported: the unit table imports `refuseToStamp` from here.
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 2
    })
}
