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
 * HOW IT TALKS TO THE SERVER (r9, corrected r10 and r11):
 *   · BOTH connections start with the data probe's PROBE_SESSION_OPTIONS — `row_security=off`,
 *     `standard_conforming_strings=on` and `search_path=pg_catalog` — and, before any catalog
 *     statement, call `assertProbeSessionSafe`, which refuses (UnsafeProbeSession) if row_security
 *     is not off or search_path is not exactly `pg_catalog`. Each statement is one call over the
 *     extended protocol, every FUNCTION, OPERATOR and CAST it names is pg_catalog-qualified, and the
 *     reader also defaults to read-only. Rules 1–3 keep catalogue TEXT from becoming SQL (r9 M-1);
 *     rule 4 (`row_security=off`) keeps a table POLICY from running (r10 M-1); rule 5 (the pin plus
 *     the qualified operators) keeps a planted OPERATOR/CAST from being resolved (r11 HIGH-1,
 *     CVE-2018-1058 — reproduced four ways, incl. `COPY … TO PROGRAM` under a superuser stamper).
 *   · the single COMMENT runs on a second connection. It FIRST opens a SAVEPOINT, makes it
 *     read-only with `SET LOCAL transaction_read_only = on`, and — INSIDE that read-only savepoint —
 *     re-reads the identity, re-runs the data check and re-runs the installation check (r11 M-2
 *     moved the identity re-read in here too, so NO catalog read runs read-write). It then rolls the
 *     savepoint back, restoring read-write for the COMMENT alone, and only then compares that it
 *     reached the same SERVER and DATABASE the facts came from (oid, postmaster start time, address,
 *     port — M-3) and that the comment it will replace is still the one the reader saw (r10 LOW-4).
 *     The read-write statements are therefore exactly BEGIN, SAVEPOINT, SET LOCAL, ROLLBACK/RELEASE
 *     and the COMMENT — none of which resolves a search_path name. Not a lock: rows another session
 *     commits between the re-check and COMMIT are not seen.
 *   · `--unstamp` reads only the name, the server identity and the comment. It never runs the data
 *     probe (review L6), pins the session on both connections, and decides on the comment the WRITER
 *     re-reads (r10 LOW-4).
 *
 * SUPERUSER (r11, review LOW-4 item 4). The stamper does NOT hard-refuse to run as a superuser: CI
 * stamps `ims_ci` as `postgres`, and a refusal would break it. A superuser is the WORST case for
 * catalog-resolution attacks (it can use any planted operator, and COPY TO PROGRAM is code on the
 * host), so run it as the OWNING NON-SUPERUSER role wherever possible; the search_path pin plus the
 * qualified operators are what make the superuser run safe, and the stamper prints a warning when it
 * is a superuser so the operator sees the recommendation.
 */

import { pathToFileURL } from 'node:url'

import {
  ALWAYS_REFUSED_DATABASE,
  expectedScratchDatabaseMarker,
} from '../tests/concurrency/scratch-database-guard'
import {
  assertProbeSessionSafe,
  PROBE_SESSION_OPTIONS,
  readDataFacts,
  readInstallationEvidence,
  UnsafeProbeSession,
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
         d.oid::pg_catalog.text AS oid,
         pg_catalog.pg_postmaster_start_time()::pg_catalog.text AS postmaster_start,
         COALESCE(pg_catalog.inet_server_addr()::pg_catalog.text, 'local-socket') AS server_addr,
         COALESCE(pg_catalog.inet_server_port()::pg_catalog.text, 'local-socket') AS server_port,
         pg_catalog.shobj_description(d.oid, 'pg_database') AS comment
    FROM pg_catalog.pg_database d
   WHERE d.datname OPERATOR(pg_catalog.=) pg_catalog.current_database()`

async function ask<T>(client: ExtendedQueryClient, text: string): Promise<T[]> {
  const { rows } = await client.query({ text, values: [], queryMode: 'extended' })
  return rows as T[]
}

/**
 * Print the recommendation, once, when this run connects as a superuser (r11 review LOW-4 item 4).
 * Not a refusal: CI stamps as `postgres`. A superuser is the worst case for catalog-resolution
 * attacks, so the operator should prefer the owning non-superuser role.
 */
async function warnIfSuperuser(client: ExtendedQueryClient): Promise<void> {
  try {
    const [row] = await ask<{ is_superuser: string }>(
      client, `SELECT pg_catalog.current_setting('is_superuser') AS is_superuser`,
    )
    if (row?.is_superuser === 'on') {
      console.warn('NOTE: stamping as a SUPERUSER. The search_path pin and qualified operators keep this '
        + 'safe, but a superuser is the worst case for catalog-resolution attacks — prefer running as the '
        + 'database\'s owning non-superuser role.')
    }
  } catch {
    // A warning must never fail the run.
  }
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
  // FIRST statement on the reader: row_security=off AND search_path=pg_catalog, before IDENTITY_SQL
  // (whose `=` would otherwise resolve through a hostile search_path) runs (r11 review HIGH-1).
  await assertProbeSessionSafe(client)
  await warnIfSuperuser(client)
  const identity = await readIdentity(client)
  const [state] = await ask<{ in_recovery: boolean; is_template: boolean }>(client, `
    SELECT pg_catalog.pg_is_in_recovery() AS in_recovery, d.datistemplate AS is_template
      FROM pg_catalog.pg_database d WHERE d.datname OPERATOR(pg_catalog.=) pg_catalog.current_database()`)
  let subscriptionCount: number | null = null
  try {
    const [row] = await ask<{ count: string }>(client, `
      SELECT pg_catalog.count(*)::pg_catalog.text AS count FROM pg_catalog.pg_subscription
       WHERE subdbid OPERATOR(pg_catalog.=) (SELECT oid FROM pg_catalog.pg_database WHERE datname OPERATOR(pg_catalog.=) pg_catalog.current_database())`)
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
      // Pin proof first, even though --unstamp runs no data probe: IDENTITY_SQL's `=` still
      // resolves through search_path, so it must be pinned before that statement (r11 HIGH-1).
      await assertProbeSessionSafe(reader)
      await warnIfSuperuser(reader)
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
      // Pin proof on the writer too. IDENTITY_SQL's operators are all pg_catalog-qualified, so this
      // read is safe read-write; the assertion is the belt for a session that lost its options.
      try {
        await assertProbeSessionSafe(writer)
      } catch (error) {
        await ask(writer, 'ROLLBACK').catch(() => {})
        if (error instanceof UnsafeProbeSession) {
          console.error(`REFUSING to unstamp "${identity.name}": ${error.message}`)
          return 1
        }
        throw error
      }
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
    if (error instanceof UnsafeProbeSession) {
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
    // EVERY CATALOG READ ON THE WRITER RUNS INSIDE A READ-ONLY SAVEPOINT (r10 MEDIUM-1, extended in
    // r11 MEDIUM-2). The savepoint is opened and made read-only FIRST, then the identity re-read,
    // the data check and the installation check all run under `transaction_read_only = on`; the
    // rollback to the savepoint restores read-write for the COMMENT alone. So — with search_path
    // pinned and every operator qualified (r11 HIGH-1) — the only statements that run read-write are
    // BEGIN, SAVEPOINT, SET LOCAL, ROLLBACK/RELEASE and the COMMENT, none of which resolves a
    // search_path operator. r10's version read the identity BEFORE the savepoint, so its `=` ran
    // read-write, which review MEDIUM-2 showed a planted operator could exploit. Not a lock: a row
    // another session commits between this read and COMMIT is not seen.
    let seen: Identity
    let data: Awaited<ReturnType<typeof readDataFacts>>
    let installation: Awaited<ReturnType<typeof readInstallationEvidence>>
    try {
      await ask(writer, 'SAVEPOINT stamp_recheck')
      await ask(writer, 'SET LOCAL transaction_read_only = on')
      // FIRST read inside the savepoint: prove the session is still pinned (r11).
      await assertProbeSessionSafe(writer)
      seen = await readIdentity(writer)
      data = await readDataFacts(writer, appSchema)
      installation = await readInstallationEvidence(writer)
      await ask(writer, 'ROLLBACK TO SAVEPOINT stamp_recheck')
      await ask(writer, 'RELEASE SAVEPOINT stamp_recheck')
    } catch (error) {
      await ask(writer, 'ROLLBACK').catch(() => {})
      if (error instanceof UnsafeProbeSession) {
        console.error(`REFUSING to stamp "${facts.identity.name}" at the last moment: ${error.message}`)
        return 1
      }
      throw error
    }
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
