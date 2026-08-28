#!/usr/bin/env node
// =============================================================================
// Fence the database against the application for the length of a migration.
// =============================================================================
// scripts/check-db-writers.mjs answers "is anything connected RIGHT NOW". That is a
// snapshot, and a snapshot is not a fence: it closes its connection, and the dump and
// the migration open theirs afterwards. Nothing in between stops a cron tick that the
// crontab fence missed, an operator's `psql`, or a `next dev` in a sibling worktree
// from connecting in the gap and writing across the migration.
//
// This script is the continuous part. It REVOKEs CONNECT on the database from EVERY
// grantee that holds it directly — the application role, PUBLIC (the default database ACL
// grants CONNECT to PUBLIC, so revoking from the role alone would change nothing), and any
// other role with a direct grant — then terminates what is already attached, and leaves the
// revocation standing until `--release`.
//
// EVERY GRANTEE, NOT TWO OF THEM (o3d-2sm1.5, Codex r4 HIGH). It used to revoke from PUBLIC
// and the application role and call the database held closed. A third role with a direct
// CONNECT grant — monitoring, BI, a backup job, a second application — was terminated by the
// drain and RECONNECTED IMMEDIATELY, for the whole length of the migration, while every
// header and every doc said the database was fenced. The revoke is now derived from the ACL
// itself: whatever holds CONNECT loses it, except the admin role this deploy is connected as
// (revoking from that would lock the deploy out of its own recovery). Each one is recorded,
// and `--release` restores exactly those.
//
//   --preflight            can this database be fenced AT ALL, asked while the predecessor
//                          is still up and a refusal costs nothing. Revokes nothing,
//                          terminates nothing, writes no state file. It exists because the
//                          callers' preflight used to check only that this FILE EXISTS —
//                          so a missing module (dotenv was a devDependency, and the
//                          documented manual upgrade runs `npm ci --omit=dev`) was
//                          discovered at drain-verify, AFTER the stop: an outage for a
//                          missing import. This mode runs the same imports, opens the same
//                          connection and asks the same questions.
//   --fence                revoke CONNECT, drain the existing backends, prove it is quiet.
//                          Exit 3 means NOTHING WAS REVOKED; exit 5 (EXIT_FENCE_STANDING) means
//                          the REVOKEs may be in force — committed and standing, or issued to a
//                          COMMIT whose acknowledgement was lost — and this run still cannot call
//                          the database fenced. The two must never be confused: the callers hold
//                          a sticky "this run raised a fence" flag, and the second is a fence.
//   --release              restore EXACTLY the grants that were revoked, and verify they are back.
//                          When there is no usable record to restore FROM, it does not report
//                          "nothing to release" — a record that was never written and one a
//                          power cut ate look identical from here. It asks the database, and
//                          NEITHER answer is a success (o3d-2sm1.5, Codex r11 and r12 HIGH):
//                          an application role WITHOUT CONNECT means a fence is standing whose
//                          record is gone (exit 1), and an application role WITH CONNECT proves
//                          only that — the same fence may still hold PUBLIC, monitoring, BI or
//                          a second application out, and doFence() leaves precisely that shape
//                          standing on purpose (exit 4, EXIT_FENCE_UNPROVEN). Only a record can
//                          license "released".
//   --print-migration-url  the admin URL with `options=-c role=<app role>` merged in — the
//                          connection the migration must run through. See "WHO THE
//                          MIGRATION RUNS AS" below. No database connection is opened.
//
// WHAT THIS CANNOT DO, said here rather than implied away:
//
//   * It cannot fence a role that is a SUPERUSER. Superusers bypass ACL checks, so a
//     revoke is decoration. It also cannot fence when the deploy has no connection of
//     its own that survives the revoke — revoking CONNECT from the role the migration
//     itself uses would lock the migration out, and no ACL can tell "the migration"
//     apart from "the application" when both log in as one role. Both cases exit 3
//     (NOT FENCED), and the caller is expected to say so OUT LOUD and abort.
//
//     A real fence therefore needs DEPLOY_ADMIN_DATABASE_URL: a connection as a
//     SEPARATE role that is a superuser or the database owner.
//
//   * WHO THE MIGRATION RUNS AS, WHICH IS NOT WHO IT CONNECTS AS (o3d-2sm1.5, Codex r4
//     CRITICAL). The connection that survives the fence is the ADMIN one, so for a while
//     this script told the operator to "point it at the role that owns the schema today"
//     — advice that is impossible to follow. scripts/install.sh makes the APPLICATION
//     role the database owner, and planConnectionFence() REFUSES outright when the admin
//     role IS the application role. The only fenceable configuration is therefore a
//     separate SUPERUSER admin, and every CREATE TABLE / INDEX / SEQUENCE a migration made
//     through it was owned by that superuser with no grant to the application role. The
//     drift check, the verification hook and pg_dump all ran on the same admin connection,
//     so nothing in the pipeline could see it: the deploy reported success and every
//     request touching the new table failed with `permission denied`.
//
//     So the migration CONNECTS as the admin and RUNS AS the application role:
//     buildMigrationConnectionString() adds `options=-c role=<app role>` to the admin URL,
//     which Postgres applies at connection start. Authentication — and therefore the
//     CONNECT check the fence revokes — happens as the admin, so the fence still holds;
//     everything the migration then creates is owned by the application role, exactly as
//     an unfenced migration would leave it. That is the whole point: the fenced path and
//     the unfenced path leave the database in the SAME state.
//
//     Why this and not the alternatives. ALTER DEFAULT PRIVILEGES fixes privileges but not
//     ownership, applies only to objects created afterwards by one specific role, and needs
//     a separate clause per object type — a repair that has to enumerate what it repairs is
//     one that silently misses the next object type Prisma emits. Transferring ownership
//     afterwards has the same enumeration problem plus a window in which the objects exist
//     and are unusable. Setting the role at connection start has no enumeration and no
//     window.
//
//     AND IT IS NOT TRUSTED. `--preflight` refuses before anything is stopped if the admin
//     cannot SET ROLE to the application role, and scripts/check-app-db-object-access.mjs
//     runs after every migration and FAILS THE DEPLOY if the application role cannot
//     actually use a table, sequence or view that now exists. A comment saying the
//     ownership is right is not evidence; asking the database is.
//
//   * It cannot revoke a grant that arrives through ROLE MEMBERSHIP. A REVOKE names a grantee, and
//     `imsapp` may hold CONNECT because it is a member of some other role that holds it — revoking
//     from `imsapp` and from PUBLIC then changes nothing an application would notice. Examining the
//     ACL entries this script itself just removed cannot see that, so after the revokes it ASKS THE
//     DATABASE: `has_database_privilege(appRole, current_database(), 'CONNECT')` must be false. If
//     it is still true the fence did NOT take and this exits 1 with the granting roles named. It
//     does not go on to revoke from those roles — they are shared with other principals and a deploy
//     has no business rewriting them — so the operator's fix is to make the application role's
//     CONNECT a direct grant, or to run the cutover with the writers stopped and no fence at all.
//     This is the same lesson as revoking from PUBLIC: ask the database what is true rather than
//     reasoning about what you changed.
//
//   * It cannot survive a power cut mid-window in the sense of undoing itself. If the
//     box dies while fenced, CONNECT stays revoked and the application cannot start
//     until `--release` runs. That is the intended failure direction — down, not
//     writing across a half-migrated schema — but it is why the state file records the
//     exact SQL to undo it by hand, and why the deploy scripts print that SQL on every
//     failure path.
//
//   * It cannot restore the GRANTOR. `--release` re-GRANTs CONNECT as the admin role, so a
//     grant originally made by someone else comes back recorded as `role=c/deployadmin`
//     rather than `role=c/postgres`. The privilege is identical and every caller sees the
//     same answer from has_database_privilege(); what changes is who may revoke it later.
//     Said here because the state file calls itself a restore of "exactly the grants".
//
// WHICH DATABASE ANY OF THIS IS ABOUT. Every mode above connects through
// DEPLOY_ADMIN_DATABASE_URL when it is set, and asks its questions of `current_database()` on
// that connection while taking the ROLE from DATABASE_URL. assessDatabaseIdentity() is what
// binds the two together — same host, same port, same database name, and the live connection
// attached to it — and no mode fences or releases without it (o3d-2sm1.5, Codex r13 CRITICAL).
// `--release` goes further on the path where it has no record: the claim "the application can
// connect" is made by CONNECTING AS THE APPLICATION, because a privilege read taken over the
// admin connection answers about the admin connection's database.
//
// THE STATE FILE is written BEFORE anything is revoked, and it records what each
// grantee held beforehand so that `--release` restores that and not "everything".
// `--fence` on an existing state file re-applies the revoke and re-drains but keeps
// the ORIGINAL recorded state, so a re-run after a failure restores the truth rather
// than the fenced snapshot.
// =============================================================================

import { randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

import { config as loadDotenv } from 'dotenv'
import pg from 'pg'

/**
 * THE OBJECT THAT DECIDES WHERE THE CONNECTION GOES (o3d-2sm1.5, Codex r16 CRITICAL).
 *
 * FOUR rounds on this file have now ended the same way: whatever this script used to work out
 * "where does DATABASE_URL actually go" was one layer short of what `pg` connects with.
 *
 *   r13/r14  a hand-rolled read of the URL -- wrong about authority-vs-query precedence, and
 *            wrong about `?user=` overriding the authority's username.
 *   r15      a hand-rolled read of the URL -- wrong about repeated parameters, because
 *            `URLSearchParams.get()` returns the FIRST value while pg-connection-string copies
 *            every entry into one config object, so the LAST one wins.
 *   r16      `pg-connection-string.parse()` -- the driver's own STRING PARSER, but still not the
 *            driver's connection. `pg/lib/connection-parameters.js` fills every value the URL
 *            omits from `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE` and its own defaults BEFORE
 *            connecting. With `PGPORT=6432` and an application URL that names no port, the
 *            parser says 5432 and the application connects to 6432 -- so the fence revokes
 *            CONNECT on one cluster while the application keeps writing to another, right
 *            through the migration.
 *
 * A fifth reimplementation would find a fifth gap. So identity is no longer RECONSTRUCTED at all:
 * it is READ OFF THE CLIENT OBJECT THE DRIVER WOULD OPEN. `new pg.Client({ connectionString })`
 * builds its `ConnectionParameters` in the constructor and touches the network only when
 * `.connect()` is called, which this never calls. `client.host` and `client.port` are literally
 * the two arguments handed to `Connection#connect()`, and `client.user` / `client.database` are
 * the values `getStartupConf()` puts in the startup packet. There is nothing left between these
 * four fields and the wire for a fifth round to find.
 *
 * Consequently this file holds NO opinion about how a URL resolves, and no fallback that could
 * hold one: a construction that throws is reported as "where it connects is unknown", which is
 * refused everywhere identity is required.
 *
 * The single deliberate subtraction is the OS-account fallback for the login role -- see the body.
 * It is subtracted rather than corrected, and it is DETECTED BY ASKING THE DRIVER, not by
 * re-reading the URL, so this is still not a reimplementation of anything.
 */
const OS_ACCOUNT_SENTINEL = ' fence-os-account-default '

export function resolveDriverIdentity(connectionString) {
  // NOT connected, and never connected: the constructor resolves ConnectionParameters and
  // allocates an unconnected socket, nothing more.
  const client = new pg.Client({ connectionString })

  // THE ONE COMPONENT THAT IS NOT SHARED CONFIGURATION. `PGHOST`, `PGPORT`, `PGUSER` and
  // `PGDATABASE` are deliberate settings that this script and the application read from the same
  // environment, so honouring them is the whole point of resolving through the driver. `pg`'s
  // LAST fallback for the login role is not a setting at all: it is `process.env.USER`, the OS
  // account of whichever process happens to be running. This script runs as the deploy account;
  // the application runs as its own. Taking the deploy's OS account for the application's login
  // role would revoke CONNECT from a role nobody connects as and report the door shut.
  //
  // Asked of the driver rather than inferred: re-resolve with `pg.defaults.user` swapped for a
  // sentinel, and if the answer moves, that field came from the OS account and from nothing else.
  // `ConnectionParameters` also falls the database back to the login role's name, so the same
  // swap reveals a database that is ambient for the same reason. Either one resolves to '' here,
  // which every caller already treats as "unidentified", and unidentified is refused.
  const previousDefault = pg.defaults.user
  let probe
  try {
    pg.defaults.user = OS_ACCOUNT_SENTINEL
    probe = new pg.Client({ connectionString })
  } finally {
    pg.defaults.user = previousDefault
  }

  return {
    host: client.host,
    port: client.port,
    user: probe.user === OS_ACCOUNT_SENTINEL ? '' : client.user,
    database: probe.database === OS_ACCOUNT_SENTINEL ? '' : client.database,
  }
}

export const EXIT_OK = 0
export const EXIT_ERROR = 1
export const EXIT_NOT_FENCEABLE = 3
/**
 * `--release` was asked to release a fence it has no record of, and the database says the
 * APPLICATION ROLE can connect. That is the only thing it proves, and it is NOT proof that no
 * fence is standing (o3d-2sm1.5, Codex r12 HIGH): a fence revokes CONNECT from every grantee
 * that held it directly, and the application can keep CONNECT through PUBLIC, through role
 * membership or through a manual grant while monitoring, backup, BI or a second application
 * stays revoked by that same fence. Non-zero, deliberately: the caller decides what to do with
 * "the application can connect and nothing else here is knowable", but nobody may read it as OK.
 */
export const EXIT_FENCE_UNPROVEN = 4
/**
 * `--fence` GOT PAST COMMIT AND STILL CANNOT CALL THE DATABASE FENCED (o3d-2sm1.5, Codex r13 HIGH).
 *
 * AN EXIT CODE IS NOT EVIDENCE ABOUT WHAT WAS COMMITTED, and for a while the callers read one as
 * if it were: `DB_FENCE_RAISED` was raised only on exit 0, so "the fence did not exit 0" was taken
 * for "no fence was raised". doFence() REVOKES IN A COMMITTED TRANSACTION and then asks whether
 * the door is actually shut; when the application keeps CONNECT through role membership, or the
 * room will not go quiet, it DELIBERATELY LEAVES THE REVOKES STANDING so nothing is half-applied
 * — and it used to report that with the same exit 1 a failure that revoked nothing produces. The
 * caller then treated a run that had locked PUBLIC, monitoring, BI and a second application out
 * as a run with no fence to its name, and a later `--release` exit 4 took the warning-success
 * branch and let the deploy record a release nobody performed.
 *
 * So every outcome from the moment the COMMIT IS ISSUED has its own code. It means exactly one
 * thing: THE REVOKES MAY BE IN FORCE RIGHT NOW. Usually they demonstrably are — the commit was
 * acknowledged and a later check failed. Once, and it is the case that matters most, the
 * acknowledgement itself was lost (o3d-2sm1.5, Codex r14 HIGH): the transaction's fate is
 * unknown, and unknown is reported here rather than as the not-committed case, because a fence
 * wrongly believed absent is an application locked out with nobody looking for it, while a fence
 * wrongly believed present costs one `--release` that grants back what nobody took.
 *
 * Whatever the caller does next, it owes the database a `--release`, and it must never again read
 * its own release's "unproven" verdict as permission to carry on.
 */
export const EXIT_FENCE_STANDING = 5

export const PUBLIC_GRANTEE = 'PUBLIC'

/** SQL identifier quoting. Role and database names reach these statements as text. */
export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`
}

/**
 * The role a connection string logs in as, or '' when it does not carry one.
 *
 * Derived from parseConnectionIdentity() rather than from `url.username`, because the username
 * in the authority is NOT necessarily the role node-postgres authenticates as: `?user=` overrides
 * it (o3d-2sm1.5, Codex r14 CRITICAL). A URL this function cannot read as one unambiguous role --
 * unparseable, or naming two different ones -- yields '', which every caller treats as "no role",
 * and no role is a refusal everywhere it matters.
 */
export function parseRoleFromConnectionString(connectionString) {
  const identity = parseConnectionIdentity(connectionString)
  return identity.ok ? identity.user : ''
}

// ---------------------------------------------------------------------------
// IS THE DATABASE THIS RUN IS TALKING TO THE DATABASE THE APPLICATION USES?
// (o3d-2sm1.5, Codex r13 CRITICAL)
//
// Every mode but --print-migration-url connects through DEPLOY_ADMIN_DATABASE_URL when it is
// set, and then asks its questions with `current_database()` — has_database_privilege(appRole,
// current_database(), 'CONNECT') above all. The ROLE NAME in those questions comes from
// DATABASE_URL; the DATABASE they are asked of comes from the admin connection. Nothing
// checked that the two were the same place.
//
// Point the admin URL at another database on which the application role happens to hold CONNECT
// — a copy, a `postgres` maintenance database, a staging URL left in the environment — and
// `--release` answers "the application can connect" about a database the application never uses,
// exits 4, and the caller permits startup while the REAL database still denies CONNECT. The
// health route does not connect to the database, so the deploy reports success with the
// application locked out. This is the same defect class as asking the right question of the
// wrong object.
//
// So the identity is PROVEN before anything is fenced or released, from two directions:
//
//   1. THE TWO URLS NAME THE SAME PLACE. Database name, server host and port, compared as
//      written. A loopback address, `localhost` and a unix-socket directory are the same
//      machine and are treated as such; anything else that differs is a refusal rather than a
//      guess, because "probably the same host by another name" is exactly the reasoning this
//      check exists to stop.
//   2. THE CONNECTION THAT WAS ACTUALLY OPENED IS ATTACHED TO IT. `current_database()`, read
//      from the live connection, must equal the database DATABASE_URL names. A URL comparison
//      alone cannot see an admin URL with no database in its path, which silently connects to
//      the admin role's own default database.
//   3. AND IT IS ATTACHED AS THE ROLE THE ADMIN URL NAMES (o3d-2sm1.5, Codex r14 CRITICAL).
//      The role half is asked the same way the database half is: `session_user` and
//      `current_user` are READ FROM THE CONNECTION rather than derived from the URL. A URL can
//      redirect the login role through `?user=` (parseConnectionIdentity() now resolves that,
//      but PGUSER, a .pgpass entry, an ident/peer map and `options=-c role=` are outside any URL
//      altogether), and the whole fence turns on knowing which role it is: CONNECT is a property
//      of the LOGIN role, the admin's own role is the one grantee deliberately NOT revoked, and
//      `--release` restores against it. A connection running as somebody other than it logged in
//      as -- `session_user` <> `current_user` -- is refused outright: the ACL answers below would
//      be about the assumed role while the CONNECT this script revokes belongs to the login one.
//
// Fail closed in every direction: no DATABASE_URL, no database name in it, a connection that will
// not say where it is attached, or one that will not say what it is attached as, are all
// "not proven", and not proven is refused.
// ---------------------------------------------------------------------------

/** Hosts that all mean "the machine this is running on", however they are spelled. */
const LOCAL_HOSTS = new Set(['', 'localhost', '127.0.0.1', '::1', '[::1]'])

/** Best-effort percent-decoding: a value that will not decode is compared as written. */
function decodeOrRaw(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * The query parameters that decide WHERE a connection lands and AS WHOM. Repeating any of these
 * is refused outright (see parseConnectionIdentity).
 */
const IDENTITY_PARAMS = ['host', 'port', 'user', 'dbname', 'database']

/**
 * Pure: the (login role, server, database) a libpq connection URL EFFECTIVELY names -- what
 * node-postgres will actually connect as and to, not what the URL's obvious components suggest.
 *
 * THE EFFECTIVE VALUES ARE THE DRIVER'S OWN (o3d-2sm1.5, Codex r16 CRITICAL). They are read off
 * `resolveDriverIdentity()` -- the `pg.Client` the driver would open -- rather than re-derived
 * here. THREE rounds running, something short of that client disagreed with it, and the fence
 * proved itself against a connection nobody uses:
 *
 *   r14  the authority was read first and the query consulted only as a fallback. The driver
 *        does the opposite -- it copies every query parameter into the config FIRST and fills
 *        `host`, `port` and `user` from the authority only `if` the query left them unset -- so
 *        `postgres://app@localhost:5432/appdb?host=remote.example&port=6432&user=actual` was
 *        classified as `app` at localhost:5432 while the application authenticated as `actual`
 *        against remote.example:6432.
 *   r15  the query was then read with `URLSearchParams.get()`, which returns the FIRST value.
 *        The driver iterates `searchParams.entries()` into one config object, so the LAST
 *        duplicate wins: `?host=local&host=remote&port=5432&port=6432&user=app&user=other` read
 *        here as local:5432/app and connected to remote:6432/other.
 *   r16  the driver's own string parser was then used -- and a string parser is not a
 *        connection. `pg/lib/connection-parameters.js` fills in `PGHOST`, `PGPORT`, `PGUSER`,
 *        `PGDATABASE` and its own defaults for everything the URL omits, so with `PGPORT=6432`
 *        `postgres://imsapp@localhost/imsdb` read here as (this host):5432 and connected to
 *        6432. An empty authority plus `PGHOST` moves the whole server the same way.
 *
 * So there are now two rules, both fail-closed, and neither of them re-implements libpq:
 *
 *   * A REPEATED IDENTITY PARAMETER IS REFUSED. Not resolved to the driver's answer -- refused.
 *     The driver's answer is knowable, but a URL that names two hosts is a URL whose reader and
 *     whose driver see different databases, and every ambiguity in this file is refused rather
 *     than resolved (an authority that disagrees with its own query string, below, is refused on
 *     exactly the same grounds). Refusal is also the one answer that cannot go stale if the
 *     driver's precedence changes again.
 *   * ANYTHING ELSE IS WHATEVER THE DRIVER SAYS IT IS. `host`, `port`, `user` and `database` are
 *     read off the `pg.Client` that would be opened, so `?host=` falling back to the authority,
 *     the `@/` empty-authority form, percent-decoding, the unconditional overwrite of `database`
 *     from the pathname, AND the environment defaults (`PGHOST`/`PGPORT`/`PGUSER`/`PGDATABASE`,
 *     port 5432, host `localhost`, and a database that falls back to the login role's own name)
 *     are the driver's behaviour by construction rather than by imitation. Nothing here merges
 *     a parser's output with the environment; that merge is the driver's, and it is done once.
 *
 * A URL that says one thing in its authority and a DIFFERENT thing in its query string is still
 * REFUSED rather than resolved. The driver would take the query value, but an environment that
 * disagrees with itself about which server or which role it means is not a thing to pick a
 * winner from -- and this check exists precisely to stop "probably what they meant".
 *
 * `?dbname=`/`?database=` are likewise refused when they name something other than the path: the
 * driver overwrites `config.database` from the pathname UNCONDITIONALLY, so such a parameter is a
 * statement about the database that the connection will not honour, and a false statement about
 * WHICH DATABASE is the entire subject of this section.
 */
export function parseConnectionIdentity(connectionString) {
  if (!connectionString) return { ok: false, reason: 'is not set' }
  //  `postgres://role@/db?host=/var/run/postgresql` — a login role with NO host in the authority —
  //  is a libpq form WHATWG URL rejects, and node-postgres accepts it by retrying with a dummy
  //  host and then treating the hostname as empty. Read it the same way or this refuses a URL the
  //  driver connects with, and a check that refuses valid configurations gets switched off.
  let url
  let emptyAuthorityHost = false
  try {
    url = new URL(connectionString)
  } catch {
    try {
      url = new URL(connectionString.replace('@/', '@___DUMMY___/'))
      emptyAuthorityHost = true
    } catch {
      return { ok: false, reason: 'cannot be parsed as a URL' }
    }
  }
  const params = url.searchParams

  // A repeated identity parameter, refused BEFORE anything is resolved.
  for (const name of IDENTITY_PARAMS) {
    const all = params.getAll(name)
    if (all.length > 1) {
      return {
        ok: false,
        reason: `carries ?${name}= ${all.length} times (${all.map((value) => JSON.stringify(value)).join(', ')}). node-postgres copies EVERY query parameter into one config object, so the LAST one is the one it connects with, while anything reading the URL a parameter at a time sees the first — which is how a URL passes a check here and opens somewhere else. Refusing to pick a winner; delete all but one`,
      }
    }
  }

  // The effective values, read off the client `pg` would open. Constructing it can throw — an
  // sslcert/sslkey/sslrootcert it cannot read, a uselibpqcompat conflict — and a URL the driver
  // will not build a connection from is a URL this cannot identify.
  let driver
  try {
    driver = resolveDriverIdentity(connectionString)
  } catch {
    return { ok: false, reason: 'cannot be resolved to a node-postgres connection (pg rejected it), so where it connects is unknown' }
  }

  const authorityHost = !emptyAuthorityHost && url.hostname ? decodeOrRaw(url.hostname) : ''
  const authorityPort = url.port || ''
  const authorityUser = url.username ? decodeOrRaw(url.username) : ''

  for (const [name, authority] of [
    ['host', authorityHost],
    ['port', authorityPort],
    ['user', authorityUser],
  ]) {
    const query = params.get(name) || ''
    if (query && authority && query !== authority) {
      return {
        ok: false,
        reason: `names the ${name} "${authority}" in its authority and "${query}" in its query string. node-postgres takes the QUERY value, so this URL does not connect where it appears to; refusing to guess which one was meant -- delete one of them`,
      }
    }
  }

  const database = String(driver.database ?? '')
  for (const name of ['dbname', 'database']) {
    const value = params.get(name)
    if (value && value !== database) {
      return {
        ok: false,
        reason: `carries ?${name}=${value}, which node-postgres IGNORES -- the database comes from the URL path (or, when the path is empty, from PGDATABASE and then from the login role's own name), and the connection this URL opens reaches "${database || '(nothing)'}". A parameter naming a different database from the one the connection actually reaches cannot be left standing here`,
      }
    }
  }

  const host = String(driver.host ?? '')
  // `ConnectionParameters` runs the port through `parseInt`, so a port that is not a number
  // reaches the driver as NaN and the server this URL opens is unknown rather than defaulted.
  if (!Number.isInteger(driver.port)) {
    return {
      ok: false,
      reason: `resolves to the port ${JSON.stringify(String(driver.port))}, which node-postgres cannot read as a port number, so which server it reaches is unknown`,
    }
  }
  const port = String(driver.port)
  const user = String(driver.user ?? '')
  const lowered = String(host).toLowerCase()
  const family = String(host).startsWith('/') || LOCAL_HOSTS.has(lowered) ? '(this host)' : lowered
  return { ok: true, reason: '', host, port, user, database, server: `${family}:${port}` }
}

/**
 * Pure: may this run treat the connection it opened as the application's own database, opened as
 * the role it was meant to be opened as?
 *
 * `connectedDatabase` is `current_database()` read from that connection — the live half, and the
 * only one that can catch an admin URL whose path is empty. `connectedLoginRole` is `session_user`
 * and `connectedEffectiveRole` is `current_user`, read from the same connection: the role half of
 * the same question, asked of the connection rather than inferred from the URL. `adminUrl` is
 * compared only when it is set, because without it the connection IS the application's URL and
 * there are not two things to bind together.
 */
export function assessDatabaseIdentity({
  adminUrl = '',
  appUrl = '',
  connectedDatabase = '',
  connectedLoginRole = '',
  connectedEffectiveRole = '',
}) {
  const app = parseConnectionIdentity(appUrl)
  if (!app.ok) {
    return {
      bound: false,
      reason: `DATABASE_URL ${app.reason}, so there is nothing to prove this deploy's connection is the application's own database. Every question this script asks is asked of current_database() on the connection it opened, and without the application's URL that database is unidentified.`,
    }
  }
  if (!app.database) {
    return {
      bound: false,
      reason: 'DATABASE_URL resolves to no database at all -- nothing in its path, no PGDATABASE, and no login role whose name node-postgres could fall back to -- so the database the application actually uses is unidentified and nothing can be bound to it.',
    }
  }
  if (adminUrl) {
    const admin = parseConnectionIdentity(adminUrl)
    if (!admin.ok) {
      return { bound: false, reason: `DEPLOY_ADMIN_DATABASE_URL ${admin.reason}, so it cannot be shown to name the same database as DATABASE_URL.` }
    }
    if (admin.database && admin.database !== app.database) {
      return {
        bound: false,
        reason: `DEPLOY_ADMIN_DATABASE_URL names the database "${admin.database}" and DATABASE_URL names "${app.database}". Everything this script asks — including whether the application role can connect — would be asked of "${admin.database}", and answered about a database the application does not use.`,
      }
    }
    if (admin.server !== app.server) {
      return {
        bound: false,
        reason: `DEPLOY_ADMIN_DATABASE_URL points at ${admin.server} and DATABASE_URL at ${app.server}. A privilege read on one server says nothing about the other, so this is refused rather than assumed to be the same host under another name. Make both URLs name the same host and port.`,
      }
    }
  }
  if (!connectedDatabase) {
    return {
      bound: false,
      reason: 'the open connection did not report which database it is attached to, so it cannot be shown to be the application\'s.',
    }
  }
  if (connectedDatabase !== app.database) {
    return {
      bound: false,
      reason: `the connection this run opened is attached to "${connectedDatabase}", and DATABASE_URL names "${app.database}". A connection string with no database in its path connects to PGDATABASE, or failing that to the login role's own name, which is how these come apart without either URL looking wrong.`,
    }
  }
  // THE ROLE HALF, ASKED OF THE CONNECTION (o3d-2sm1.5, Codex r14 CRITICAL). Everything below the
  // identity gate treats the admin's own role as the one grantee it must not revoke, and treats
  // CONNECT as a property of the role that logged in. Both of those are unanswerable if this run
  // does not know what it is attached as.
  if (!connectedLoginRole) {
    return {
      bound: false,
      reason: 'the open connection did not report which role it logged in as, so the role whose CONNECT this run would revoke, exclude and restore is unidentified. session_user is what answers that, and it was not asked or not answered.',
    }
  }
  if (connectedEffectiveRole && connectedEffectiveRole !== connectedLoginRole) {
    return {
      bound: false,
      reason: `the open connection logged in as "${connectedLoginRole}" and is running as "${connectedEffectiveRole}" (a SET ROLE, or options=-c role= on the connection string). CONNECT belongs to the role that logged in, and every ACL answer here would be given as the role it is running as, so the two must be the same role before anything is revoked or restored.`,
    }
  }
  if (adminUrl) {
    const admin = parseConnectionIdentity(adminUrl)
    if (admin.ok && admin.user && admin.user !== connectedLoginRole) {
      return {
        bound: false,
        reason: `DEPLOY_ADMIN_DATABASE_URL names the role "${admin.user}" and the connection it opened logged in as "${connectedLoginRole}". The URL is not what decides that -- PGUSER, a .pgpass entry and an ident or peer map all override it -- so the role this run would exclude from the revoke, and restore against, is not the role it is actually holding.`,
      }
    }
  }
  return { bound: true, reason: '' }
}

/**
 * Pure: split a `pg_database.datacl` text value into { grantee, privileges } entries.
 * An empty grantee is PUBLIC. Commas inside a quoted role name are not separators.
 */
export function parseAclEntries(datacl) {
  const text = String(datacl ?? '').trim().replace(/^\{/, '').replace(/\}$/, '')
  if (!text) return []

  const entries = []
  let current = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '"') {
      quoted = !quoted
      continue
    }
    if (character === ',' && !quoted) {
      entries.push(current)
      current = ''
      continue
    }
    current += character
  }
  entries.push(current)

  return entries
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const slash = entry.lastIndexOf('/')
      const body = slash === -1 ? entry : entry.slice(0, slash)
      const equals = body.indexOf('=')
      return {
        grantee: equals === -1 ? body : body.slice(0, equals),
        privileges: equals === -1 ? '' : body.slice(equals + 1),
      }
    })
}

/**
 * Pure: did `grantee` hold CONNECT before we touched anything?
 *
 * A NULL datacl is not "no privileges" — it is "the defaults", which grant CONNECT to
 * PUBLIC and everything to the owner. Reading NULL as empty is how a restore ends up
 * granting nothing back.
 */
export function granteeHasConnect(datacl, ownerRole, grantee) {
  const isPublic = grantee === PUBLIC_GRANTEE
  if (datacl === null || datacl === undefined || String(datacl).trim() === '') {
    return isPublic || grantee === ownerRole
  }
  return parseAclEntries(datacl).some((entry) => {
    const matches = isPublic ? entry.grantee === '' : entry.grantee === grantee
    return matches && entry.privileges.includes('c')
  })
}

/**
 * Pure: every named role holding CONNECT DIRECTLY on the database.
 *
 * PUBLIC is deliberately NOT in this list — it is not a role and the caller handles it
 * separately. A NULL datacl means "the defaults", which grant CONNECT to PUBLIC and
 * everything to the owner, so the owner is the only named grantee there.
 *
 * This is what turns "revoke from the two grantees we thought of" into "revoke from whatever
 * the database says holds it": a monitoring or BI role with its own grant is otherwise
 * terminated by the drain and back a moment later (o3d-2sm1.5).
 */
export function listDirectConnectGrantees(datacl, ownerRole) {
  if (datacl === null || datacl === undefined || String(datacl).trim() === '') {
    return ownerRole ? [ownerRole] : []
  }
  const seen = []
  for (const entry of parseAclEntries(datacl)) {
    if (entry.grantee === '' || !entry.privileges.includes('c')) continue
    if (!seen.includes(entry.grantee)) seen.push(entry.grantee)
  }
  return seen
}

/**
 * Pure: can this deploy actually fence the application out, and of whom?
 *
 * Returns the grantees to revoke CONNECT from, or a refusal with the reason to print.
 * The refusal cases are the ones where a revoke would either do nothing (a superuser
 * application role bypasses the ACL) or lock the deploy itself out (the migration
 * connects as the very role being fenced, with no privileged connection of its own).
 */
export function planConnectionFence(facts) {
  const {
    appRole,
    appRoleIsSuperuser,
    adminRole,
    adminIsSuperuser,
    adminIsOwner,
    publicHasConnect,
    appRoleHasConnect,
    appRoleHasEffectiveConnect,
    directConnectGrantees = [],
  } = facts

  if (!appRole) {
    return { fenceable: false, reason: 'DATABASE_URL carries no role name, so there is nothing to revoke CONNECT from.', revoke: [] }
  }
  if (appRoleIsSuperuser) {
    return {
      fenceable: false,
      reason: `the application role ${appRole} is a SUPERUSER, and superusers bypass database ACLs — revoking CONNECT from it would fence nothing.`,
      revoke: [],
    }
  }
  if (!adminIsSuperuser && !adminIsOwner) {
    return {
      fenceable: false,
      reason: `the deploy connects as ${adminRole}, which is neither a superuser nor the database owner, so it cannot revoke CONNECT (and would not survive the revoke).`,
      revoke: [],
    }
  }
  if (adminRole === appRole) {
    return {
      fenceable: false,
      reason: `the deploy connects as the application role ${appRole} itself; revoking CONNECT from it would lock the migration out. Set DEPLOY_ADMIN_DATABASE_URL to a separate superuser or owner connection.`,
      revoke: [],
    }
  }

  // EVERY GRANTEE THAT HOLDS CONNECT DIRECTLY, not the two we happened to think of.
  // `directConnectGrantees` comes from the database's own ACL, so a monitoring role, a BI
  // login or a second application is revoked too — otherwise the drain terminates it and it
  // reconnects a moment later, for the whole migration, while this script reports "fenced".
  // The admin role is the one exception: it is the connection this deploy and its recovery
  // run through, and revoking CONNECT from it would lock the deploy out of the database it
  // just fenced. (A superuser admin ignores the ACL anyway; an owner admin keeps its owner
  // entry, which Postgres materialises the moment anything is revoked.)
  const revoke = []
  if (publicHasConnect) revoke.push(PUBLIC_GRANTEE)
  for (const grantee of directConnectGrantees) {
    if (grantee === PUBLIC_GRANTEE || grantee === '') continue
    if (grantee === adminRole) continue
    if (!revoke.includes(grantee)) revoke.push(grantee)
  }
  if (appRoleHasConnect && !revoke.includes(appRole)) revoke.push(appRole)

  if (revoke.length === 0) {
    // Asked of the database, not of the ACL: a role can hold CONNECT with no ACL entry of its own.
    // The two answers are different refusals and must not be collapsed — one is a database already
    // closed, the other is one this script cannot close.
    if (appRoleHasEffectiveConnect) {
      return {
        fenceable: false,
        reason: `neither PUBLIC nor ${appRole} holds CONNECT DIRECTLY, yet ${appRole} can still connect — the grant reaches it through role membership, which a deploy must not revoke because those roles are shared. Make the application role's CONNECT a direct grant to make this fenceable.`,
        revoke: [],
      }
    }
    return {
      fenceable: false,
      reason: `neither PUBLIC nor ${appRole} holds CONNECT on this database already — nothing to revoke, and nothing this script can add.`,
      revoke: [],
    }
  }

  return { fenceable: true, reason: '', revoke }
}

/**
 * Pure: can the migration RUN AS the application role over the admin's connection?
 *
 * The fence forces the migration through the admin connection, and everything a migration
 * creates is owned by whoever ran it. Left as the admin, that is a superuser, and the
 * application role gets no grant on the new table at all — a deploy that reports success and
 * then fails every request that touches it (o3d-2sm1.5). `SET ROLE`, applied at connection
 * start, makes the fenced migration leave the database in exactly the state an unfenced one
 * would.
 *
 * A superuser may SET ROLE to anything. A non-superuser admin — the database-owner case —
 * may only do it if it is a member of the application role, and `pg_has_role(admin, app,
 * 'SET')` is the database's own answer to that. When it cannot, this is a REFUSAL rather
 * than a silent fall back to admin-owned objects: falling back is the defect.
 *
 * @param {{ adminRole: string, appRole: string, adminIsSuperuser: boolean, adminCanSetAppRole: boolean }} facts
 * @returns {{ usable: boolean, reason: string }}
 */
export function assessMigrationRole({ adminRole, appRole, adminIsSuperuser, adminCanSetAppRole }) {
  if (!appRole) {
    return { usable: false, reason: 'DATABASE_URL carries no role name, so the migration has no role to run as.' }
  }
  if (adminIsSuperuser || adminCanSetAppRole) return { usable: true, reason: '' }
  return {
    usable: false,
    reason: `the deploy connects as ${adminRole}, which is neither a superuser nor a member of ${appRole}, so the migration cannot SET ROLE to ${appRole}. Everything it created would be owned by ${adminRole} with no grant to the application, and the deploy would report success while every request touching a new table failed with "permission denied". Grant ${adminRole} membership of ${appRole} (GRANT ${appRole} TO ${adminRole}) and re-run.`,
  }
}

/**
 * Pure: the admin connection string with `options=-c role=<appRole>` merged in.
 *
 * Authentication still happens as the admin — which is what keeps the fence effective, since
 * CONNECT is checked against the role that logs in — and the session then runs as the
 * application role, so the objects a migration creates are owned by it.
 *
 * libpq splits `options` on spaces, so a space inside a role name is backslash-escaped; the
 * whole value is then percent-encoded, because `+` is NOT decoded as a space here and using
 * URLSearchParams would produce exactly that. An `options` already present is preserved and
 * appended to rather than overwritten -- the EFFECTIVE one, which for a repeated parameter is the
 * last, because that is the one the driver would have applied.
 *
 * IT THROWS RATHER THAN RETURNING THE INPUT (o3d-2sm1.5, Codex r5 MEDIUM). Returning the admin
 * URL unchanged on unparseable input produced a connection with NO `role=` at all — the
 * migration then ran as the admin, creating objects the application cannot use, while the
 * deploy log announced that it was running as the application role. That is precisely the
 * CRITICAL this whole mechanism exists to close, reached through its own fallback. Same for a
 * role name carrying a tab or a newline: libpq's option parser splits on those exactly as it
 * splits on a space, and the resulting `role=` would be silently truncated, so it is refused
 * rather than escaped-and-hoped.
 */
export function buildMigrationConnectionString(adminConnectionString, appRole) {
  if (!adminConnectionString) {
    throw new Error('No admin connection string to compose a migration URL from.')
  }
  if (!appRole) {
    throw new Error('No application role, so there is no role for the migration to run as.')
  }
  if (/[\t\n\r\f\v]/.test(String(appRole))) {
    throw new Error(
      `The application role name ${JSON.stringify(String(appRole))} contains whitespace that libpq's ` +
        'option parser treats as a separator, so `role=` would be silently truncated and the migration ' +
        'would run as the admin. Refusing to compose that URL.',
    )
  }
  let url
  try {
    url = new URL(adminConnectionString)
  } catch {
    throw new Error(
      'The admin connection string cannot be parsed as a URL, so `options=-c role=' +
        `${appRole}\` cannot be added to it. Returning it unchanged would run the migration AS THE ADMIN ` +
        'while the deploy announced the application role — the exact failure this composes a URL to avoid.',
    )
  }
  const escaped = String(appRole).replace(/([\\ '])/g, '\\$1')
  // The LAST `options=`, not the first (o3d-2sm1.5, Codex r15 CRITICAL, same shape). The driver
  // copies every query entry into one config object, so a repeated `options=` resolves to the
  // last; merging into the first would compose a URL that carries a startup setting the admin
  // connection never had, and drop the one it did.
  const allOptions = url.searchParams.getAll('options')
  const existing = allOptions.length > 0 ? allOptions[allOptions.length - 1] : null
  const merged = existing ? `${existing} -c role=${escaped}` : `-c role=${escaped}`
  url.searchParams.delete('options')
  const query = url.searchParams.toString()
  url.search = ''
  const rendered = url.toString().replace(/\?$/, '')
  const parts = []
  if (query) parts.push(query)
  parts.push(`options=${encodeURIComponent(merged)}`)
  return `${rendered}?${parts.join('&')}`
}

/**
 * Pure: did the revokes actually shut the application out?
 *
 * `stillConnects` is `has_database_privilege(appRole, current_database(), 'CONNECT')` read AFTER the
 * revokes committed. It accounts for membership, for PUBLIC and for superuser status, which is
 * exactly what an ACL diff cannot. A fence that reports armed while the application can still
 * connect is worse than none, because the whole deploy proceeds believing the door is shut.
 *
 * @param {{ appRole: string, stillConnects: boolean, grantingRoles?: string[] }} facts
 * @returns {{ fenced: boolean, reason: string }}
 */
export function assessEffectiveFence({ appRole, stillConnects, grantingRoles = [] }) {
  if (!stillConnects) return { fenced: true, reason: '' }
  const via = grantingRoles.length > 0
    ? ` The grant reaches it through: ${grantingRoles.join(', ')}.`
    : ' No role membership was identified, so the grant is held some other way (a superuser bit, or a grant made between the read and now).'
  return {
    fenced: false,
    reason: `THE FENCE DID NOT TAKE. CONNECT was revoked from every grantee that held it directly, and ${appRole} can STILL connect to this database.${via} A deploy must not revoke from a shared role, so this cannot be fixed from here.`,
  }
}

/** Pure: the exact statements a fence applies, and the ones that undo it. */
export function buildRevokeStatements(database, grantees) {
  return grantees.map((grantee) => `REVOKE CONNECT ON DATABASE ${quoteIdent(database)} FROM ${grantee === PUBLIC_GRANTEE ? 'PUBLIC' : quoteIdent(grantee)};`)
}

export function buildGrantStatements(database, grantees) {
  return grantees.map((grantee) => `GRANT CONNECT ON DATABASE ${quoteIdent(database)} TO ${grantee === PUBLIC_GRANTEE ? 'PUBLIC' : quoteIdent(grantee)};`)
}

/** Pure: the fence is released only when every grantee it revoked holds CONNECT again. */
export function verifyRelease(datacl, ownerRole, grantees) {
  const missing = grantees.filter((grantee) => !granteeHasConnect(datacl, ownerRole, grantee))
  return { released: missing.length === 0, missing }
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { mode: '', stateFile: '', appRole: '', timeoutSeconds: 30 }
  for (const arg of argv) {
    if (arg === '--fence' || arg === '--release' || arg === '--preflight' || arg === '--print-migration-url') options.mode = arg.slice(2)
    else if (arg.startsWith('--state-file=')) options.stateFile = arg.slice('--state-file='.length)
    else if (arg.startsWith('--app-role=')) options.appRole = arg.slice('--app-role='.length)
    else if (arg.startsWith('--timeout-seconds=')) options.timeoutSeconds = Number(arg.slice('--timeout-seconds='.length))
  }
  return options
}

// ---------------------------------------------------------------------------
// THE FENCE RECORD (o3d-2sm1.5, Codex r11 HIGH).
//
// THE ASYMMETRY IS THE WHOLE FINDING. The REVOKE is a committed PostgreSQL transaction: it
// is on the medium before COMMIT returns and it survives anything. The file that undoes it
// was a plain writeFileSync — no atomic replacement, no flush — and its return was allowed
// to permit that transaction. A power cut between the two preserves the revocations and
// loses or truncates the record, and `--release` then read `null`, reported "nothing to
// release" and exited 0 while the application and every other recorded grantee stayed
// locked out of the database.
//
// Two halves, and both are needed:
//
//   1. The record is PUBLISHED DURABLY BEFORE BEGIN — same-directory temporary, file fsync,
//      atomic rename, directory fsync — and a failure aborts WITHOUT revoking anything.
//   2. `--release` no longer reads absence as a negative. A record that was never written
//      and a record a power cut ate are indistinguishable from here, so a missing or
//      unusable record is not an answer at all: the database is asked instead. And the
//      answer it can give is bounded (r12) — has_database_privilege() speaks for ONE role,
//      while the fence revoked from every direct grantee, so "the application connects" is
//      never promoted to "no fence is standing". Both branches are non-zero.
// ---------------------------------------------------------------------------

/** The record is there and usable: released from it, exactly what was revoked comes back. */
export const STATE_PRESENT = 'present'
/**
 * Nothing at the path. THE AMBIGUOUS ONE, and the reason this enum exists: "no fence was
 * ever taken" and "the fence record was lost" look identical here. Never a proof of absence.
 */
export const STATE_ABSENT = 'absent'
/** Something is at the path but it could not be read at all (permissions, a directory, EIO). */
export const STATE_UNREADABLE = 'unreadable'
/** Something is at the path, it was read, and it is not a usable record of what to restore. */
export const STATE_CORRUPT = 'corrupt'

/**
 * Written LAST, so a record that parses without it was torn rather than finished.
 *
 * publish_durable_file()'s `marker_complete=1` in the deploy scripts is the same device for
 * the same reason. The atomic rename below should make a torn record unobservable at the
 * authoritative path; this is what catches the case where it is observable anyway — and a
 * record from a build that predates the sentinel is CORRUPT rather than present, which is
 * loud, recoverable, and much safer than releasing from a grantee list that may be short.
 */
export const STATE_COMPLETE_SENTINEL = 1

/** Pure: is this parsed object a record a release can actually be driven from? */
export function classifyStateShape(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'the record is not a JSON object'
  if (parsed.state_complete !== STATE_COMPLETE_SENTINEL) {
    return 'the record does not end with the completeness sentinel, so it was truncated or predates it'
  }
  if (typeof parsed.database !== 'string' || parsed.database.length === 0) return 'the record names no database'
  if (!Array.isArray(parsed.revoked) || parsed.revoked.some((grantee) => typeof grantee !== 'string')) {
    return 'the record carries no usable list of revoked grantees'
  }
  return ''
}

/**
 * Read the fence record, saying WHICH kind of nothing it found when it finds nothing.
 *
 * The old version returned `null` for "no file", "unreadable file" and "unparseable file"
 * alike, and every caller read that single null as "no fence is recorded".
 */
export function readState(stateFile) {
  let raw
  try {
    raw = readFileSync(stateFile, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { status: STATE_ABSENT, detail: 'no file at that path' }
    return { status: STATE_UNREADABLE, detail: error instanceof Error ? error.message : String(error) }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { status: STATE_CORRUPT, detail: `the record is not valid JSON (${error instanceof Error ? error.message : String(error)})` }
  }
  const problem = classifyStateShape(parsed)
  if (problem) return { status: STATE_CORRUPT, detail: problem }
  return { status: STATE_PRESENT, state: parsed }
}

/**
 * Publish the fence record so that a power cut leaves either the previous record or the
 * complete new one, and so that the bytes are on the medium before the caller is allowed to
 * revoke anything.
 *
 * Throws on any failure — including the directory flush AFTER the rename, where the new
 * record is already visible and its NAME is not yet proven. The caller must abort there
 * rather than read the file back: a read-back is satisfied by the page cache, which is the
 * exact state a power cut undoes.
 */
export function publishState(stateFile, state) {
  const dir = dirname(stateFile)
  mkdirSync(dir, { recursive: true })
  const tmp = `${stateFile}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  const body = `${JSON.stringify({ ...state, state_complete: STATE_COMPLETE_SENTINEL }, null, 2)}\n`
  try {
    const fd = openSync(tmp, 'wx', 0o600)
    try {
      writeFileSync(fd, body)
      // BARRIER 1: the data, before any name points at it.
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, stateFile)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      /* the temporary may never have been created; the failure being reported is the one above */
    }
    throw error
  }
  // BARRIER 2: the directory entry the rename created. Without it the reboot can find the
  // previous record, or neither, however well the data was written.
  const dirFd = openSync(dir, 'r')
  try {
    fsyncSync(dirFd)
  } finally {
    closeSync(dirFd)
  }
}

async function readFacts(client, appRole) {
  const { rows } = await client.query(
    `SELECT current_database()                                  AS database,
            current_user                                        AS admin_role,
            -- THE ROLE THIS CONNECTION LOGGED IN AS, which is not necessarily current_user and is
            -- not necessarily the URL's username either (o3d-2sm1.5, Codex r14 CRITICAL). CONNECT
            -- is checked against the login role, so this is the one the identity gate binds.
            session_user                                        AS admin_login_role,
            pg_catalog.pg_get_userbyid(d.datdba)                AS owner_role,
            d.datacl::text                                      AS datacl,
            (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS admin_is_superuser,
            (SELECT rolsuper FROM pg_roles WHERE rolname = $1)   AS app_role_is_superuser,
            (SELECT count(*)::int FROM pg_roles WHERE rolname = $1) AS app_role_exists,
            -- Can the admin SET ROLE to the application role? That is what decides whether the
            -- migration can create objects OWNED BY the application (o3d-2sm1.5). 'MEMBER' is the
            -- mode that answers "may SET ROLE", as opposed to 'USAGE' which only answers
            -- "inherits its privileges".
            (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
              OR COALESCE((SELECT pg_has_role(current_user, $1, 'MEMBER')
                             FROM pg_roles WHERE rolname = $1), false) AS admin_can_set_app_role
       FROM pg_database d
      WHERE d.datname = current_database()`,
    [appRole],
  )
  return rows[0]
}

/**
 * The only question that matters: can the application role connect RIGHT NOW? Postgres answers it
 * accounting for direct grants, PUBLIC, role membership and the superuser bit all at once, which is
 * why this is asked of the database instead of inferred from the ACL entries we removed.
 */
async function readEffectiveConnect(client, appRole) {
  if (!appRole) return { stillConnects: false, grantingRoles: [] }
  const { rows } = await client.query(
    `SELECT has_database_privilege($1, current_database(), 'CONNECT') AS still_connects`,
    [appRole],
  )
  const stillConnects = rows[0]?.still_connects === true
  if (!stillConnects) return { stillConnects: false, grantingRoles: [] }

  // Name the culprits so the operator has somewhere to go. A role the application is a member of
  // that holds CONNECT in its own right is the usual answer.
  const { rows: sources } = await client.query(
    `SELECT r.rolname
       FROM pg_roles r
      WHERE r.rolname <> $1
        AND pg_has_role($1, r.oid, 'USAGE')
        AND has_database_privilege(r.rolname, current_database(), 'CONNECT')
      ORDER BY r.rolname`,
    [appRole],
  )
  return { stillConnects: true, grantingRoles: sources.map((row) => row.rolname) }
}

async function otherClientBackends(client) {
  const { rows } = await client.query(
    `SELECT pid, COALESCE(application_name, '') AS application_name, COALESCE(usename, '') AS usename
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND backend_type = 'client backend'`,
  )
  return rows
}

/**
 * Everything the two read-only questions need, asked once: is this database fenceable, and
 * can the migration run as the application role over the admin's connection?
 *
 * `--preflight` and `--fence` ask exactly the same things of exactly the same database. That
 * is deliberate: a preflight that asks a DIFFERENT question is a preflight that passes and
 * then fails after the stop.
 */
async function assessFence(client, appRole) {
  const facts = await readFacts(client, appRole)
  const effective = await readEffectiveConnect(client, appRole)
  const plan = planConnectionFence({
    appRole,
    appRoleIsSuperuser: facts.app_role_is_superuser === true,
    adminRole: facts.admin_role,
    adminIsSuperuser: facts.admin_is_superuser === true,
    adminIsOwner: facts.admin_role === facts.owner_role,
    publicHasConnect: granteeHasConnect(facts.datacl, facts.owner_role, PUBLIC_GRANTEE),
    appRoleHasConnect: granteeHasConnect(facts.datacl, facts.owner_role, appRole),
    appRoleHasEffectiveConnect: effective.stillConnects,
    directConnectGrantees: listDirectConnectGrantees(facts.datacl, facts.owner_role),
  })
  const role = assessMigrationRole({
    adminRole: facts.admin_role,
    appRole,
    adminIsSuperuser: facts.admin_is_superuser === true,
    adminCanSetAppRole: facts.admin_can_set_app_role === true,
  })
  return { facts, plan, role }
}

/** Shared by --preflight and --fence: the admin URL is the ONLY connection either may use. */
function requireAdminUrl(what) {
  if (process.env.DEPLOY_ADMIN_DATABASE_URL) return true
  console.error(`NOT FENCED: DEPLOY_ADMIN_DATABASE_URL is not set, so this deploy has no privileged`)
  console.error(`connection that would survive revoking CONNECT from the application role, and ${what}`)
  console.error('cannot hold the database closed for the migration window.')
  return false
}

/**
 * Shared by every mode that connects: the connection in hand must be PROVEN to be the
 * application's own database before it is fenced, released, or believed about privileges.
 *
 * Printed as a refusal rather than returned, because there is exactly one thing to do with a
 * "not proven" here and every caller does it.
 */
function requireBoundDatabaseIdentity(attachment, prefix) {
  const verdict = assessDatabaseIdentity({
    adminUrl: process.env.DEPLOY_ADMIN_DATABASE_URL || '',
    appUrl: process.env.DATABASE_URL || '',
    connectedDatabase: attachment.database ?? '',
    connectedLoginRole: attachment.loginRole ?? '',
    connectedEffectiveRole: attachment.effectiveRole ?? '',
  })
  if (verdict.bound) return true
  console.error(`${prefix}: ${verdict.reason}`)
  console.error('This run cannot show that the database it is connected to is the one the application uses,')
  console.error('and that it is attached to it as the role it believes it is. Every answer it could give —')
  console.error('"the fence took", "the application can connect" — would be about whichever database it')
  console.error('reached, as whichever role it reached it as. Align DEPLOY_ADMIN_DATABASE_URL and DATABASE_URL')
  console.error('on the same host, port and database name, with a role each URL states plainly, and re-run.')
  return false
}

/** The live attachment, as the identity gate wants it: what this connection is, asked of itself. */
function attachmentOf(facts) {
  return { database: facts.database, loginRole: facts.admin_login_role, effectiveRole: facts.admin_role }
}

/**
 * The application's OWN connection, opened as the application: not a privilege read taken on
 * somebody else's connection (o3d-2sm1.5, Codex r13 CRITICAL).
 *
 * has_database_privilege() asked over the admin connection answers about the admin connection's
 * database. This opens DATABASE_URL itself and reports whether it got in and where it landed, so
 * "the application can connect" is an observation of the application connecting.
 *
 * Never throws: a refused connection is the answer, not an error.
 */
export async function probeApplicationConnection(connectionString) {
  if (!connectionString) {
    return { attempted: false, connected: false, database: '', error: 'DATABASE_URL is not set, so there is no application connection to test.' }
  }
  const probe = new pg.Client({ connectionString, application_name: 'ims-deploy-fence-app-probe' })
  try {
    await probe.connect()
    const { rows } = await probe.query('SELECT current_database() AS connected_database')
    return { attempted: true, connected: true, database: rows[0]?.connected_database ?? '', error: '' }
  } catch (error) {
    return { attempted: true, connected: false, database: '', error: error instanceof Error ? error.message : String(error) }
  } finally {
    await probe.end().catch(() => {})
  }
}

/**
 * --preflight: ask, before anything is stopped, every question that can be asked without
 * changing anything. It revokes nothing, terminates nothing and writes no state file.
 *
 * WHY IT EXISTS AT ALL (o3d-2sm1.5, Codex r4 HIGH). The callers' pre-stop check was
 * `[[ -f scripts/fence-db-connections.mjs ]]` — it checked that the file EXISTS and never
 * executed it. `dotenv` was a devDependency while the documented manual upgrade runs
 * `npm ci --omit=dev`, so the fence died with a missing module at drain-verify, AFTER the
 * predecessor had been stopped: an outage for an import. Running this mode executes the same
 * imports and opens the same connection as `--fence`, so anything that would kill the fence
 * kills the preflight instead, while the predecessor is still up.
 */
async function doPreflight(client, options) {
  const appRole = options.appRole || parseRoleFromConnectionString(process.env.DATABASE_URL)
  const { facts, plan, role } = await assessFence(client, appRole)

  // THE SAME QUESTIONS ARE ONLY THE SAME QUESTIONS IF THEY ARE ASKED OF THE SAME DATABASE.
  // Asked here as well as in --fence for the reason this whole mode exists: a preflight that
  // skips a check --fence performs is a preflight that passes and then fails after the stop.
  if (!requireBoundDatabaseIdentity(attachmentOf(facts), 'NOT FENCEABLE')) return EXIT_NOT_FENCEABLE

  if (appRole && !facts.app_role_exists) {
    console.error(`NOT FENCED: the role ${appRole} from DATABASE_URL does not exist on this server.`)
    return EXIT_NOT_FENCEABLE
  }
  if (!plan.fenceable) {
    console.error(`NOT FENCED: ${plan.reason}`)
    return EXIT_NOT_FENCEABLE
  }
  if (!role.usable) {
    console.error(`NOT FENCED: ${role.reason}`)
    return EXIT_NOT_FENCEABLE
  }

  console.log(`Preflight: ${facts.database} is fenceable.`)
  console.log(`  CONNECT would be revoked from: ${plan.revoke.join(', ')}`)
  console.log(`  the migration would connect as ${facts.admin_role} and RUN AS ${appRole}, so what it creates is owned by ${appRole}.`)
  console.log('  Nothing was revoked, terminated or written by this check.')
  return EXIT_OK
}

/**
 * The refusal that keeps the asymmetry from opening: the record could not be made durable, so
 * nothing is revoked. Nothing has changed in the database and nothing needs releasing.
 */
function refuseUnrecordedFence(stateFile, error, appeared = []) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`NOT FENCED: the fence record ${stateFile} could not be published durably (${message}).`)
  console.error('Refusing to revoke CONNECT. A REVOKE is a committed transaction that survives a power cut;')
  console.error('this file is the only thing that undoes it, and a revoke whose undo record may not survive')
  console.error('locks the application out of its database with nothing left to say how to let it back in.')
  if (appeared.length > 0) {
    console.error(`The fence already recorded stays exactly as it is; ${appeared.join(', ')} was NOT revoked.`)
  }
  console.error('Nothing has been revoked by this run. Fix the filesystem (space, permissions, mount) and re-run.')
  return EXIT_NOT_FENCEABLE
}

export async function doFence(client, options) {
  // The fence is only ever established through an EXPLICIT admin URL. Falling back to
  // DIRECT_URL here would let a fence engage while the caller has no idea which
  // connection survived it — and the caller has to run the migration through exactly
  // that connection.
  if (!requireAdminUrl('this deploy')) {
    console.error('The deploy may continue, but the database is NOT held closed for the migration')
    console.error('window: a client that connects between now and the end of the migration is not stopped.')
    return EXIT_NOT_FENCEABLE
  }

  const appRole = options.appRole || parseRoleFromConnectionString(process.env.DATABASE_URL)
  const { facts, plan: freshPlan, role } = await assessFence(client, appRole)

  // BEFORE ANYTHING IS REVOKED (o3d-2sm1.5, Codex r13 CRITICAL). A fence raised on a database
  // that is not the application's locks other people's clients out of somewhere else while the
  // application keeps writing across the migration, and every verification below — the ACL read,
  // the effective-CONNECT check, the drain — would be a truthful report about the wrong database.
  if (!requireBoundDatabaseIdentity(attachmentOf(facts), 'NOT FENCED')) return EXIT_NOT_FENCEABLE

  if (appRole && !facts.app_role_exists) {
    console.error(`NOT FENCED: the role ${appRole} from DATABASE_URL does not exist on this server.`)
    return EXIT_NOT_FENCEABLE
  }

  // Asked here as well as in --preflight, because a re-run may reach this with a state file
  // and never go through a preflight at all. An admin that cannot SET ROLE would migrate as
  // itself and leave every new object unusable by the application (o3d-2sm1.5).
  if (!role.usable) {
    console.error(`NOT FENCED: ${role.reason}`)
    return EXIT_NOT_FENCEABLE
  }

  // A RECORD THAT EXISTS AND CANNOT BE USED IS NOT "NO RECORD" (o3d-2sm1.5, Codex r11 HIGH).
  // The old read collapsed absent, unreadable and unparseable into one null, and this line
  // then took the "no existing fence" branch — which would publish a FRESH record over the
  // only surviving trace of what an earlier run revoked, and release would afterwards
  // restore the wrong set. Only a genuinely absent record starts a fresh fence.
  const read = options.stateFile ? readState(options.stateFile) : { status: STATE_ABSENT, detail: 'no --state-file was given' }
  if (read.status === STATE_UNREADABLE || read.status === STATE_CORRUPT) {
    console.error(`NOT FENCED: ${options.stateFile} holds a fence record this run cannot use (${read.status}: ${read.detail}).`)
    console.error('Refusing to revoke CONNECT over it: that record may be the only account of what an earlier')
    console.error('fence took away, and overwriting it would leave those grantees with nothing to restore them.')
    console.error(`Inspect ${options.stateFile}, restore the grants it describes by hand if it describes any, remove it, and re-run.`)
    return EXIT_NOT_FENCEABLE
  }
  const existing = read.status === STATE_PRESENT ? read.state : null
  const plan = existing ? { fenceable: true, reason: '', revoke: existing.revoked } : freshPlan

  if (!plan.fenceable) {
    console.error(`NOT FENCED: ${plan.reason}`)
    console.error('The deploy may continue, but the database is NOT held closed for the migration window:')
    console.error('a client that connects between now and the end of the migration will not be stopped.')
    return EXIT_NOT_FENCEABLE
  }

  const revokes = buildRevokeStatements(facts.database, plan.revoke)
  const grants = buildGrantStatements(facts.database, plan.revoke)

  // PUBLISHED DURABLY, AND BEFORE THE TRANSACTION THAT MAKES IT NECESSARY.
  //
  // The comment below used to say "written BEFORE the revoke", which was true of the CALL and
  // not of the BYTES: writeFileSync returns as soon as the kernel has the page, and the
  // REVOKE that follows is a committed transaction that survives a power cut the file does
  // not. So the ordering has to be a durability ordering, and a publication that cannot be
  // proven aborts the fence rather than permitting a revoke nothing records.
  if (options.stateFile && !existing) {
    try {
      publishState(options.stateFile, {
        database: facts.database,
        owner_role: facts.owner_role,
        app_role: appRole,
        admin_role: facts.admin_role,
        revoked: plan.revoke,
        datacl_before: facts.datacl ?? null,
        fenced_at: new Date().toISOString(),
        undo_sql: grants,
      })
    } catch (error) {
      return refuseUnrecordedFence(options.stateFile, error)
    }
  } else if (existing) {
    console.log(`Re-applying the fence recorded at ${existing.fenced_at} (grantees: ${existing.revoked.join(', ')}).`)
    // A grantee that appeared SINCE the fence was recorded would otherwise be revoked by
    // nothing: the state file is the authority on what to restore, not on what holds CONNECT
    // now. Anything new is revoked too and appended, so the release still puts it back —
    // and the appended record is published durably before those extra revokes run, for the
    // same reason the first one is.
    const appeared = freshPlan.revoke.filter((grantee) => !plan.revoke.includes(grantee))
    if (appeared.length > 0) {
      console.log(`  and revoking from ${appeared.join(', ')}, which has acquired CONNECT since the fence was recorded.`)
      plan.revoke.push(...appeared)
      try {
        publishState(options.stateFile, { ...existing, revoked: plan.revoke, undo_sql: buildGrantStatements(facts.database, plan.revoke) })
      } catch (error) {
        return refuseUnrecordedFence(options.stateFile, error, appeared)
      }
      revokes.push(...buildRevokeStatements(facts.database, appeared))
      grants.push(...buildGrantStatements(facts.database, appeared))
    }
  }

  // THE BOUNDARY IS THE COMMIT REQUEST, NOT ITS ACKNOWLEDGEMENT (o3d-2sm1.5, Codex r14 HIGH).
  //
  // The post-commit protection below used to begin only after `await client.query('COMMIT')`
  // RESOLVED. PostgreSQL can commit the REVOKEs and then lose the connection before the
  // acknowledgement reaches the client — a dropped TCP connection, a timeout, a server restart
  // an instant after the WAL flush. The promise rejects, and this code took the rejection for
  // "the transaction did not commit": it rolled back into thin air and threw, main() exited 1,
  // and all three entrypoints — which raise the sticky DB_FENCE_RAISED only on exit 0 and 5 —
  // recorded a run with no fence to its name over a database whose CONNECT may be revoked
  // for PUBLIC, monitoring, backup, BI and a second application.
  //
  // A LOST ACKNOWLEDGEMENT IS NOT A NEGATIVE ANSWER. Once COMMIT is on the wire the transaction's
  // fate is UNKNOWN, and the only safe reading of unknown is that the fence may be standing. So
  // the boundary is set before the await, and every failure past it reports EXIT_FENCE_STANDING
  // with the undo statements — the same outcome, and the same sticky flag, as a fence this run
  // knows it left up. Being told to release a fence that turned out not to exist costs a
  // `--release` that grants back grants nobody took away; the other way round costs an
  // application locked out of its own database with nobody looking for it.
  await client.query('BEGIN')
  let commitIssued = false
  try {
    for (const statement of revokes) await client.query(statement)
    commitIssued = true
    await client.query('COMMIT')
  } catch (error) {
    if (!commitIssued) {
      // Nothing was ever asked to commit, so the revokes are definitively not in force.
      await client.query('ROLLBACK').catch(() => {})
      throw error
    }
    // Deliberately NO ROLLBACK: a transaction that has been told to commit is not one this run
    // can take back, and issuing a rollback here would only make the log claim it undid
    // something. The state file stays exactly where it was published, because it is the only
    // account of what may now be revoked.
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`THE COMMIT WAS ISSUED AND NOT ACKNOWLEDGED, so the fence MAY BE STANDING: ${detail}`)
    console.error('The REVOKEs below were sent inside a transaction that was told to commit, and this run never')
    console.error('learned whether it did. Treat them as in force until the database says otherwise: CONNECT may')
    console.error('now be denied to every grantee listed, which can include PUBLIC, monitoring, backup, BI and a')
    console.error('second application. Nothing has been migrated.')
    console.error(`Check with:  SELECT datacl FROM pg_database WHERE datname = '${facts.database}';`)
    console.error('Then release it with --release, or run these by hand as a superuser or the database owner:')
    for (const statement of grants) console.error(`  ${statement}`)
    return EXIT_FENCE_STANDING
  }
  // FROM HERE THE REVOKES ARE ON THE MEDIUM (o3d-2sm1.5, Codex r13 HIGH).
  //
  // Everything below can still fail, and none of those failures undo the transaction that has
  // just committed. They used to be reported with EXIT_ERROR — the same code a failure that
  // revoked NOTHING returns — and the callers, which raise their sticky "this run fenced" flag
  // only on exit 0, therefore recorded a run that had locked PUBLIC, monitoring and BI out as
  // one with no fence to its name. So every outcome past this point is EXIT_FENCE_STANDING,
  // including a throw: an exception raised after COMMIT is still a database with a fence on it.
  try {
    return await completeFence(client, options, { facts, plan, grants, appRole, revokes })
  } catch (error) {
    console.error(`THE REVOKES ARE COMMITTED AND THE FENCE IS STANDING, and this run failed afterwards: ${error instanceof Error ? error.message : String(error)}`)
    console.error('CONNECT has been taken from the grantees below and nothing here has given it back.')
    console.error('Release it with --release, or run these by hand as a superuser or the database owner:')
    for (const statement of grants) console.error(`  ${statement}`)
    return EXIT_FENCE_STANDING
  }
}

/**
 * Everything doFence() does AFTER its revoking transaction has committed: prove the door is
 * actually shut, drain what was already inside, and prove the room stayed empty.
 *
 * Split out so that the caller can say one true thing about every way it ends — the fence is
 * standing. Its own returns say WHY it could not be called good; they never say "nothing
 * happened".
 */
async function completeFence(client, options, { facts, plan, grants, appRole, revokes }) {
  for (const statement of revokes) console.log(`  ${statement}`)

  // ASK THE DATABASE WHETHER THE DOOR IS SHUT. Everything above reasons about ACL entries, and an
  // ACL entry is not the whole answer: CONNECT can reach the application role through membership of
  // another role, in which case both revokes ran, both succeeded, and the application can still
  // connect. Reporting "fenced" there is the worst outcome available — the migration then runs
  // believing nothing else can attach. Draining is deliberately NOT attempted before this check:
  // terminating backends we cannot keep out is disruption without a fence.
  const effective = await readEffectiveConnect(client, appRole)
  const assessment = assessEffectiveFence({
    appRole,
    stillConnects: effective.stillConnects,
    grantingRoles: effective.grantingRoles,
  })
  if (!assessment.fenced) {
    console.error(assessment.reason)
    console.error('The fence is left standing so nothing is half-applied; undo it with --release before starting the application:')
    for (const statement of grants) console.error(`  ${statement}`)
    // EXIT_FENCE_STANDING, not EXIT_ERROR: the REVOKEs above are committed and are still in
    // force. This is the exact shape the r12 release text describes — an application that
    // connects through membership while PUBLIC, monitoring and BI stay shut out — and the
    // callers' sticky flag has to be able to see it (o3d-2sm1.5, Codex r13 HIGH).
    return EXIT_FENCE_STANDING
  }
  console.log(`Verified: has_database_privilege('${appRole}', current_database(), 'CONNECT') is false.`)

  // Revoking CONNECT stops NEW connections; the ones already open keep writing.
  //
  // THE TERMINATE AND THE CONFIRMING READ ARE BOTH UNCONDITIONAL (o3d-2sm1.5, Codex r4 HIGH).
  // This used to terminate only if the FIRST read found something and skip the settle loop
  // entirely when it did not — so a single empty sample, taken microseconds after the revoke
  // committed, was the whole proof. A backend mid-authentication when the revoke landed is
  // not in pg_stat_activity yet and is attached a moment later. Terminating costs nothing
  // when there is nothing to terminate, and the second read after a settle is what makes
  // "quiet" an observation rather than a coincidence.
  const deadline = Date.now() + Math.max(1, options.timeoutSeconds) * 1000
  try {
    await client.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND backend_type = 'client backend'`,
    )
  } catch (error) {
    console.error(`Could not terminate the attached backends: ${error instanceof Error ? error.message : String(error)}`)
  }
  let remaining = await otherClientBackends(client)
  if (remaining.length > 0) console.log(`Draining ${remaining.length} connection(s) already attached...`)
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    remaining = await otherClientBackends(client)
  }
  if (remaining.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    remaining = await otherClientBackends(client)
  }

  if (remaining.length > 0) {
    console.error(`Fence applied, but ${remaining.length} client backend(s) are still attached:`)
    for (const row of remaining) {
      console.error(`  - pid ${row.pid} user=${row.usename} app=${row.application_name || '(unnamed)'}`)
    }
    console.error('Refusing to call the database drained. The fence is left in place; release it with --release.')
    // The fence is IN PLACE, so this is not the code a fence that revoked nothing returns.
    return EXIT_FENCE_STANDING
  }

  console.log(`Database ${facts.database} is fenced: CONNECT revoked from ${plan.revoke.join(', ')}, no other client backends attached.`)
  return EXIT_OK
}

/**
 * Pure: what `--release` may conclude when the record cannot answer.
 *
 * "NOTHING TO RELEASE" IS A CLAIM ABOUT THE DATABASE, NOT ABOUT A FILE (o3d-2sm1.5, Codex r11
 * HIGH). A missing record is the shape a lost record takes, so it proves nothing on its own.
 * So the database is asked — and then the answer is not over-read (o3d-2sm1.5, Codex r12 HIGH).
 *
 * `has_database_privilege(appRole, ...)` speaks for exactly ONE role. The fence revokes CONNECT
 * from EVERY grantee that held it directly, so the application can be back inside — through
 * PUBLIC, through membership, through a manual grant — while monitoring, backup, BI or a second
 * application is still shut out by the same fence. doFence() produces that shape deliberately:
 * it rejects a fence the application survives through membership and leaves the revokes standing.
 * Without the record there is no baseline of the original grantees, and no ACL read reconstructs
 * one, so this function NEVER returns EXIT_OK and NEVER sets fenceProvenAbsent. It returns a
 * refusal with instructions in both directions; the only difference is which refusal.
 *
 * @param {{
 *   status: string,
 *   detail?: string,
 *   appRole: string,
 *   stateFile?: string,
 *   appStillConnects: boolean,
 *   appConnection?: { attempted: boolean, connected: boolean, database: string, error: string } | null,
 *   connectedDatabase?: string,
 * }} facts
 */
export function assessUnrecordedRelease({
  status,
  detail = '',
  appRole,
  stateFile,
  appStillConnects,
  appConnection = null,
  connectedDatabase = '',
}) {
  const where = stateFile || '<no --state-file was given>'
  const what = `${status}${detail ? `: ${detail}` : ''}`
  if (!appRole) {
    return {
      exitCode: EXIT_ERROR,
      fenceProvenAbsent: false,
      lines: [
        `No usable connection-fence record (${what}) at ${where}, and no application role to ask about:`,
        'DATABASE_URL carries no role name and --app-role was not given.',
        'Refusing to report "nothing to release": absence of a record is not absence of a fence, and',
        'without a role there is nothing to prove the database is open to. Pass --app-role=<role> and re-run.',
      ],
    }
  }
  if (appStillConnects) {
    // A PRIVILEGE READ ON SOMEBODY ELSE'S CONNECTION IS NOT THE APPLICATION CONNECTING
    // (o3d-2sm1.5, Codex r13 CRITICAL). `appStillConnects` is has_database_privilege() asked over
    // the ADMIN connection; the only thing that proves the application can reach its database is
    // the application's own URL reaching it. When the two disagree, the disagreement is the
    // finding, and it is fatal: the caller is about to start an application on the strength of
    // the weaker of the two answers.
    if (!appConnection || !appConnection.connected) {
      return {
        exitCode: EXIT_ERROR,
        fenceProvenAbsent: false,
        appRoleConnects: false,
        lines: [
          `No usable connection-fence record (${what}) at ${where}, AND THE TWO ANSWERS DISAGREE.`,
          `The connection this run opened${connectedDatabase ? ` (attached to "${connectedDatabase}")` : ''} says ${appRole} holds CONNECT.`,
          `DATABASE_URL itself CANNOT CONNECT: ${appConnection?.error || 'the application connection was never attempted'}`,
          'A privilege read is an answer about the database the reading connection is attached to. The',
          'application uses DATABASE_URL, and DATABASE_URL is being refused — so either a fence is still',
          'standing over the real database, or this run has been asking its questions somewhere else.',
          'Refusing to report anything but a failure. Fix the connection or restore CONNECT by hand:',
          '  SELECT datacl FROM pg_database WHERE datname = current_database();',
          `  GRANT CONNECT ON DATABASE <the application's database> TO ${appRole};`,
        ],
      }
    }
    if (connectedDatabase && appConnection.database && appConnection.database !== connectedDatabase) {
      return {
        exitCode: EXIT_ERROR,
        fenceProvenAbsent: false,
        appRoleConnects: true,
        lines: [
          `No usable connection-fence record (${what}) at ${where}, AND THE TWO CONNECTIONS ARE NOT THE SAME DATABASE.`,
          `This run is attached to "${connectedDatabase}"; DATABASE_URL lands on "${appConnection.database}".`,
          `Everything this run could say about ${appRole} — CONNECT included — is about "${connectedDatabase}",`,
          'and the application never uses it. Nothing here can speak for the database that matters.',
          'Align DEPLOY_ADMIN_DATABASE_URL with DATABASE_URL and re-run before this database is treated as open.',
        ],
      }
    }
    return {
      exitCode: EXIT_FENCE_UNPROVEN,
      fenceProvenAbsent: false,
      appRoleConnects: true,
      lines: [
        `No usable connection-fence record (${what}) at ${where}.`,
        `${appRole} holds CONNECT — proven by CONNECTING AS IT over DATABASE_URL to "${appConnection.database || connectedDatabase}",`,
        'not by a privilege read taken over another connection. THAT IS THE ONLY THING THIS RUN CAN PROVE.',
        'IT IS NOT PROOF THAT NO FENCE IS STANDING (o3d-2sm1.5, Codex r12 HIGH). A fence revokes CONNECT',
        'from EVERY grantee that held it directly — PUBLIC, monitoring, backup, BI, a second application —',
        `and ${appRole} can hold CONNECT through PUBLIC, through role membership or through a manual grant`,
        'while every one of those is still revoked by that same fence.',
        '--fence PRODUCES EXACTLY THIS SHAPE ON PURPOSE: when the application keeps CONNECT through role',
        'membership after the direct grantees have been revoked, doFence() rejects the fence as ineffective',
        'and DELIBERATELY LEAVES IT STANDING so nothing is half-applied. Lose the record from that state and',
        'this is what is left behind — an application that connects, and revocations nobody has undone.',
        'Without the record there is no baseline of who held CONNECT beforehand, and no ACL read can',
        'reconstruct one: a role that has no CONNECT now looks identical whether a fence took it or it never',
        'had it. So this is a REFUSAL, not a release. Audit the ACL and restore by hand before treating this',
        'database as open:',
        '  SELECT datacl FROM pg_database WHERE datname = current_database();',
        '  GRANT CONNECT ON DATABASE <this database> TO <every role that held it before and does not now>;',
        ...(status === STATE_ABSENT ? [] : [`The unusable record was left at ${where} for inspection.`]),
      ],
    }
  }
  return {
    exitCode: EXIT_ERROR,
    fenceProvenAbsent: false,
    lines: [
      `A CONNECTION FENCE IS STANDING AND ITS RECORD IS GONE (${what}) at ${where}.`,
      `${appRole} does NOT hold CONNECT on this database, so something revoked it — but the file that says`,
      'what was revoked, and from whom, is missing or unusable. This is the state a power cut between the',
      'REVOKE and the record produces: the transaction survives, the undo does not.',
      'Refusing to report "nothing to release". Restore CONNECT by hand as a superuser or the database owner:',
      `  GRANT CONNECT ON DATABASE <this database> TO ${appRole};`,
      'and check pg_database.datacl for any OTHER grantee the same fence took CONNECT from — a role that',
      'held it before the deploy and does not hold it now was revoked by this fence and is not in any record.',
    ],
  }
}

/**
 * The branch taken when the record cannot answer. Asks the database, which is where the
 * durable half of the fence lives, and reports what it can actually prove.
 */
async function releaseWithoutRecord(client, options, read, connectedDatabase = '') {
  const appRole = options.appRole || parseRoleFromConnectionString(process.env.DATABASE_URL)
  const effective = appRole ? await readEffectiveConnect(client, appRole) : { stillConnects: false }
  // Only when the privilege read says the application is back inside: that claim is the one this
  // run would let a caller act on, so it is the one that has to be observed rather than inferred.
  // The other branch already refuses, and an application that cannot connect to a fenced database
  // is what a fenced database means.
  const probe = options.probeApplication ?? probeApplicationConnection
  const appConnection = effective.stillConnects ? await probe(process.env.DATABASE_URL || '') : null
  const verdict = assessUnrecordedRelease({
    status: read.status,
    detail: read.detail,
    appRole,
    stateFile: options.stateFile,
    appStillConnects: effective.stillConnects,
    appConnection,
    connectedDatabase,
  })
  for (const line of verdict.lines) (verdict.exitCode === EXIT_OK ? console.log : console.error)(line)
  return verdict.exitCode
}

export async function doRelease(client, options) {
  // WHICH DATABASE IS THIS (o3d-2sm1.5, Codex r13 CRITICAL). A release GRANTs, and a release
  // that cannot show it is talking to the application's own database either grants CONNECT on
  // somebody else's or — worse, because it is silent — reports the application free while the
  // real database still refuses it.
  const { rows: attachment } = await client.query(
    `SELECT current_database() AS connected_database,
            session_user        AS connected_login_role,
            current_user        AS connected_effective_role`,
  )
  const connectedDatabase = attachment[0]?.connected_database ?? ''
  const released = {
    database: connectedDatabase,
    loginRole: attachment[0]?.connected_login_role ?? '',
    effectiveRole: attachment[0]?.connected_effective_role ?? '',
  }
  if (!requireBoundDatabaseIdentity(released, 'NOT RELEASED')) return EXIT_ERROR

  const read = options.stateFile ? readState(options.stateFile) : { status: STATE_ABSENT, detail: 'no --state-file was given' }
  if (read.status !== STATE_PRESENT) {
    return releaseWithoutRecord(client, options, read, connectedDatabase)
  }
  const state = read.state

  // The record names the database it fenced. If this connection is attached somewhere else, the
  // GRANTs below would name that database from a connection that has no business with it.
  if (connectedDatabase && state.database !== connectedDatabase) {
    console.error(`NOT RELEASED: the fence record at ${options.stateFile} was written for the database "${state.database}",`)
    console.error(`and this connection is attached to "${connectedDatabase}". Releasing from here would restore grants`)
    console.error('recorded somewhere else. Point DEPLOY_ADMIN_DATABASE_URL at the fenced database and re-run.')
    return EXIT_ERROR
  }

  const grants = buildGrantStatements(state.database, state.revoked)
  for (const statement of grants) {
    await client.query(statement)
    console.log(`  ${statement}`)
  }

  const { rows } = await client.query(
    `SELECT d.datacl::text AS datacl, pg_catalog.pg_get_userbyid(d.datdba) AS owner_role
       FROM pg_database d WHERE d.datname = $1`,
    [state.database],
  )
  const check = verifyRelease(rows[0]?.datacl, rows[0]?.owner_role, state.revoked)
  if (!check.released) {
    console.error(`Release did NOT take: ${check.missing.join(', ')} still lack CONNECT on ${state.database}.`)
    console.error('Run this by hand as a superuser before starting the application:')
    for (const statement of grants) console.error(`  ${statement}`)
    return EXIT_ERROR
  }

  rmSync(options.stateFile, { force: true })
  console.log(`Connection fence released: CONNECT restored to ${state.revoked.join(', ')} on ${state.database}.`)
  return EXIT_OK
}

async function main() {
  loadDotenv({ path: '.env.local', override: false, quiet: true })
  loadDotenv({ path: '.env', override: false, quiet: true })

  const options = parseArgs(process.argv.slice(2))
  const modes = ['fence', 'release', 'preflight', 'print-migration-url']
  if (!modes.includes(options.mode)) {
    console.error('Usage: node scripts/fence-db-connections.mjs (--preflight|--fence|--release|--print-migration-url) [--state-file=PATH] [--app-role=ROLE] [--timeout-seconds=N]')
    process.exit(EXIT_ERROR)
  }

  // Opens no connection: it is pure string work over two environment variables, and the
  // caller needs it BEFORE the migration runs, from a shell that cannot parse a URL safely.
  if (options.mode === 'print-migration-url') {
    if (!process.env.DEPLOY_ADMIN_DATABASE_URL) {
      console.error('DEPLOY_ADMIN_DATABASE_URL is not set — there is no privileged connection to compose a migration URL from.')
      process.exit(EXIT_ERROR)
    }
    const appRole = options.appRole || parseRoleFromConnectionString(process.env.DATABASE_URL)
    if (!appRole) {
      console.error('DATABASE_URL carries no role name, so the migration has no role to run as. Refusing to emit a URL that would create objects owned by the admin.')
      process.exit(EXIT_ERROR)
    }
    process.stdout.write(`${buildMigrationConnectionString(process.env.DEPLOY_ADMIN_DATABASE_URL, appRole)}\n`)
    return
  }

  // --preflight and --fence must BOTH be the admin connection or neither is meaningful: a
  // preflight that connected as the application role would prove nothing about the connection
  // the migration actually uses.
  const connectionString =
    options.mode === 'preflight'
      ? process.env.DEPLOY_ADMIN_DATABASE_URL
      : process.env.DEPLOY_ADMIN_DATABASE_URL || process.env.DIRECT_URL || process.env.DATABASE_URL
  if (!connectionString) {
    if (options.mode === 'preflight') {
      requireAdminUrl('this deploy')
      process.exit(EXIT_NOT_FENCEABLE)
    }
    console.error('Neither DEPLOY_ADMIN_DATABASE_URL nor DATABASE_URL is set — cannot fence or release anything.')
    process.exit(EXIT_ERROR)
  }

  const client = new pg.Client({ connectionString, application_name: 'ims-deploy-fence' })
  await client.connect()
  try {
    if (options.mode === 'preflight') process.exitCode = await doPreflight(client, options)
    else if (options.mode === 'fence') process.exitCode = await doFence(client, options)
    else process.exitCode = await doRelease(client, options)
  } finally {
    await client.end()
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`Connection fence failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(EXIT_ERROR)
  })
}
