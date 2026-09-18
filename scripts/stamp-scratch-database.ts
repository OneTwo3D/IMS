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
 * HOW IT TALKS TO THE SERVER (r9):
 *   · every fact is read on a connection that defaults to read-only, with
 *     `standard_conforming_strings` pinned on, through the data probe's own rules (no catalogue
 *     text in string literals; one statement per call, extended protocol only). The read-only
 *     default is a second layer, not the barrier: review MEDIUM-1 reproduced a write THROUGH it
 *     with `COMMIT; BEGIN READ WRITE; …` smuggled in a catalogue name;
 *   · the single COMMENT runs on a second connection, inside a transaction that FIRST re-checks
 *     it reached the same SERVER and the same DATABASE the facts came from (oid, postmaster start
 *     time, server address and port — review MEDIUM-3), and then RE-RUNS the data and installation
 *     checks immediately before writing (review L7). That re-check is not a lock: rows another
 *     session commits between it and COMMIT are not seen.
 *   · `--unstamp` reads only the name, the server identity and the comment. It never runs the data
 *     probe (review L6).
 */

import { pathToFileURL } from 'node:url'

import {
  ALWAYS_REFUSED_DATABASE,
  expectedScratchDatabaseMarker,
} from '../tests/concurrency/scratch-database-guard'
import {
  readDataFacts,
  readInstallationEvidence,
  type ExtendedQueryClient,
} from '../tests/concurrency/scratch-database-data-probe'

/**
 * The two marker forms this script has ever written — `ims-scratch-database(<name>): …` since r7 and
 * `ims-scratch-database: …` in r6 — matched EXACTLY on their opening, not by a bare prefix (review
 * L8), so `--unstamp` cannot remove some other comment that merely starts with the same word.
 */
const MARKER_OPENINGS = ['ims-scratch-database(', 'ims-scratch-database:'] as const

type PgClient = ExtendedQueryClient & { connect: () => Promise<void>; end: () => Promise<void> }

/**
 * Who answered: the database by name AND oid, and the server by postmaster start time, address and
 * port — the same identity lib/db/database-url-schema.mjs pins a lock connection to (review M3).
 * A DATABASE_URL that resolves differently the second time (DNS, a pooler, a failover) changes at
 * least one of these.
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

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/** Both connections: sanitised URL, conforming strings pinned; the reader is also read-only. */
function connectionOptions(readOnly: boolean): string {
  return `${readOnly ? '-c default_transaction_read_only=on ' : ''}-c standard_conforming_strings=on`
}

async function main(argv: string[]): Promise<number> {
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
    if (!MARKER_OPENINGS.some((opening) => identity.comment!.startsWith(opening))) {
      console.error(`REFUSING to unstamp "${identity.name}": its comment is not a scratch marker, and this script `
        + 'will not remove a comment it did not write')
      return 1
    }
    const writer = await open(false)
    try {
      await ask(writer, 'BEGIN')
      if (!sameServerAndDatabase(identity, await readIdentity(writer))) {
        await ask(writer, 'ROLLBACK')
        console.error('REFUSING to unstamp: the writing connection reached a different server or database')
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

  const writer = await open(false)
  try {
    await ask(writer, 'BEGIN')
    // SAME SERVER, SAME DATABASE (review M3) — not just the same name.
    if (!sameServerAndDatabase(facts.identity, await readIdentity(writer))) {
      await ask(writer, 'ROLLBACK')
      console.error('REFUSING to stamp: the writing connection reached a different server or database than the checks')
      return 1
    }
    // RE-CHECKED ON THE WRITER, IN THIS TRANSACTION, IMMEDIATELY BEFORE THE COMMENT (review L7).
    // Not a lock: a row another session commits after this read and before COMMIT is not seen.
    const data = await readDataFacts(writer, appSchema)
    const installation = await readInstallationEvidence(writer)
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
