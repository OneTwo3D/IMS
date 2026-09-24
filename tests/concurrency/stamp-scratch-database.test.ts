import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes } from 'node:crypto'

import {
  assertScratchDatabaseBeforeAnyWrite,
  checkScratchDatabase,
  expectedScratchDatabaseMarker,
  NotAScratchDatabaseError,
} from './scratch-database-guard'
import { PROBE_SESSION_OPTIONS } from './scratch-database-data-probe'

/**
 * o3d-zzgp r10 — THE STAMPER'S WRITER, END TO END (review LOW-5 and MEDIUM-1).
 *
 * Round 9 added three checks to scripts/stamp-scratch-database.ts that no test reached: the writer
 * re-checks it reached the same server and database (M3), re-runs the data check just before the
 * COMMENT (L7), and `--unstamp` removes only a comment that opens like a scratch marker (L8). The
 * unit table covers `refuseToStamp`, which is pure; these checks live in `main()`, between two
 * connections, so only a real server can show them refusing. Each case below changes the database
 * in the window between the reader closing and the writer opening (the `betweenReadAndWrite` seam)
 * and asserts the database was left as it was. Deleting any one check turns its case red.
 *
 * MEDIUM-1: r9's writer re-ran the data probe inside the read-write transaction that commits, and a
 * table's row-level-security policy is evaluated by that probe — the reviewer's policy called a
 * function that created a table whenever the transaction was read-write, and it did. The two
 * row-security cases need a role that is SUBJECT to row-level security: a superuser or a BYPASSRLS
 * role never evaluates a policy and sees every row, so for it there is nothing to show, and those
 * cases SKIP and say so rather than pass. (CI's fresh-db-drift job connects as `postgres`, a
 * superuser, so there they skip; a developer's non-superuser role runs them.) Policies are made to
 * apply to the table's OWNER with FORCE ROW LEVEL SECURITY, so no second role has to be created.
 *
 * Every database this creates is a sibling of the declared scratch database, named
 * `ims_scratch_stamptest_<random>`, and dropped in `finally`. The declared database is checked by
 * the guard FIRST and is never written.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'

type Client = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
  end: () => Promise<void>
}

async function connect(url: string): Promise<Client> {
  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString: url, application_name: 'o3d-zzgp-r10-stamp-test' })
  await client.connect()
  return client as unknown as Client
}

function urlFor(database: string): string {
  const url = new URL(process.env.DATABASE_URL!)
  url.pathname = `/${database}`
  return url.toString()
}

/** A throwaway sibling database, created empty and dropped in `finally` — whatever the body does. */
async function withSiblingDatabase(body: (name: string, url: string) => Promise<void>): Promise<void> {
  await assertScratchDatabaseBeforeAnyWrite()
  const name = `ims_scratch_stamptest_${randomBytes(6).toString('hex')}`
  const admin = await connect(process.env.DATABASE_URL!)
  try {
    await admin.query(`CREATE DATABASE "${name}"`)
    try {
      await body(name, urlFor(name))
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    }
  } finally {
    await admin.end()
  }
}

async function sql(url: string, text: string): Promise<Array<Record<string, unknown>>> {
  const client = await connect(url)
  try {
    return (await client.query(text)).rows
  } finally {
    await client.end()
  }
}

async function commentOn(url: string): Promise<string | null> {
  const [row] = await sql(url, `SELECT pg_catalog.shobj_description(
    (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()), 'pg_database') AS c`)
  return (row?.c as string | null) ?? null
}

/** Run the stamper's main() against `url`, output silenced; returns its exit code. */
async function runStamper(
  url: string,
  argv: string[],
  betweenReadAndWrite?: () => Promise<void>,
  onStatement?: (sql: string) => void,
): Promise<number> {
  const { main } = await import('../../scripts/stamp-scratch-database')
  const saved = { url: process.env.DATABASE_URL, log: console.log, error: console.error }
  const said: string[] = []
  process.env.DATABASE_URL = url
  console.log = (...args: unknown[]) => { said.push(args.join(' ')) }
  console.error = (...args: unknown[]) => { said.push(args.join(' ')) }
  try {
    const code = await main(argv, { betweenReadAndWrite, onStatement })
    lastOutput = said.join('\n')
    return code
  } finally {
    process.env.DATABASE_URL = saved.url
    console.log = saved.log
    console.error = saved.error
  }
}

/** A pg.Client on `url` carrying explicit startup `options` (e.g. a search_path pin, or none). */
async function connectWithOptions(url: string, options: string): Promise<Client> {
  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString: url, options, application_name: 'o3d-zzgp-followup-pintest' })
  await client.connect()
  return client as unknown as Client
}
let lastOutput = ''

/** Why row-security cases cannot show anything for this role, or null when they can. */
async function rowSecurityBypassReason(url: string): Promise<string | null> {
  const [row] = await sql(url, `SELECT rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user`)
  if (row?.rolsuper === true) return 'the connecting role is a superuser, which never evaluates a row-level policy'
  if (row?.rolbypassrls === true) return 'the connecting role has BYPASSRLS, which never evaluates a row-level policy'
  return null
}

test('control: an empty database is stamped, and --unstamp removes the stamp', { skip }, async () => {
  await withSiblingDatabase(async (name, url) => {
    assert.equal(await runStamper(url, [name]), 0, lastOutput)
    assert.equal(await commentOn(url), expectedScratchDatabaseMarker(name))
    assert.equal(await runStamper(url, [name, '--unstamp']), 0, lastOutput)
    assert.equal(await commentOn(url), null)
  })
})

test('M3: the writer refuses when the database was dropped and recreated under the same name', { skip }, async () => {
  await assertScratchDatabaseBeforeAnyWrite()
  const name = `ims_scratch_stamptest_${randomBytes(6).toString('hex')}`
  const url = urlFor(name)
  const admin = await connect(process.env.DATABASE_URL!)
  try {
    await admin.query(`CREATE DATABASE "${name}"`)
    const code = await runStamper(url, [name], async () => {
      // Same name, same server, a DIFFERENT database: only the oid tells them apart.
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)
      await admin.query(`CREATE DATABASE "${name}"`)
    })
    assert.equal(code, 1, lastOutput)
    assert.match(lastOutput, /different server or database/)
    assert.equal(await commentOn(url), null, 'the recreated database must not carry a stamp')
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    await admin.end()
  }
})

test('L7: a row that appears after the reader closed is caught by the writer\'s re-check', { skip }, async () => {
  await withSiblingDatabase(async (name, url) => {
    const code = await runStamper(url, [name], async () => {
      await sql(url, 'CREATE TABLE late_arrival (id int); INSERT INTO late_arrival VALUES (1)')
    })
    assert.equal(code, 1, lastOutput)
    assert.match(lastOutput, /at the last moment: .*late_arrival/)
    assert.equal(await commentOn(url), null)
  })
})

test('LOW-4: stamping refuses when the database comment changed after it was read', { skip }, async () => {
  await withSiblingDatabase(async (name, url) => {
    const code = await runStamper(url, [name], async () => {
      await sql(url, `COMMENT ON DATABASE "${name}" IS 'someone else wrote this'`)
    })
    assert.equal(code, 1, lastOutput)
    assert.equal(await commentOn(url), 'someone else wrote this', 'the other comment must be kept')
  })
})

test('L8: --unstamp keeps a comment that only resembles a marker', { skip }, async () => {
  await withSiblingDatabase(async (name, url) => {
    // Starts with the marker PREFIX but opens with neither exact marker opening.
    await sql(url, `COMMENT ON DATABASE "${name}" IS 'ims-scratch-databases are listed in the wiki'`)
    assert.equal(await runStamper(url, [name, '--unstamp']), 1, lastOutput)
    assert.equal(await commentOn(url), 'ims-scratch-databases are listed in the wiki')
  })
})

test('LOW-4: --unstamp decides on the comment the writer re-reads', { skip }, async () => {
  await withSiblingDatabase(async (name, url) => {
    await sql(url, `COMMENT ON DATABASE "${name}" IS '${expectedScratchDatabaseMarker(name)}'`)
    const code = await runStamper(url, [name, '--unstamp'], async () => {
      await sql(url, `COMMENT ON DATABASE "${name}" IS 'replaced by an operator'`)
    })
    assert.equal(code, 1, lastOutput)
    assert.equal(await commentOn(url), 'replaced by an operator')
  })
})

test('MEDIUM-1: a row-level policy planted before the writer runs is neither executed nor trusted', { skip }, async (t) => {
  const reason = await rowSecurityBypassReason(process.env.DATABASE_URL!)
  if (reason) {
    t.skip(reason)
    return
  }
  await withSiblingDatabase(async (name, url) => {
    const code = await runStamper(url, [name], async () => {
      // The reviewer's shape: the policy's function writes whenever the transaction is read-write,
      // and returns false so the table's row is hidden from the data check.
      await sql(url, `
        CREATE SCHEMA s;
        CREATE FUNCTION s.evil() RETURNS boolean LANGUAGE plpgsql AS $f$
        BEGIN
          IF pg_catalog.current_setting('transaction_read_only') = 'off' THEN
            EXECUTE 'CREATE TABLE s.pwned_rls_' || pg_catalog.pg_backend_pid()::text || ' ()';
          END IF;
          RETURN false;
        END $f$;
        CREATE TABLE s.t (x int); INSERT INTO s.t VALUES (1);
        ALTER TABLE s.t ENABLE ROW LEVEL SECURITY; ALTER TABLE s.t FORCE ROW LEVEL SECURITY;
        CREATE POLICY p ON s.t USING (s.evil())`)
    })
    const [pwned] = await sql(url, `SELECT pg_catalog.count(*)::int AS n FROM pg_catalog.pg_class WHERE relname LIKE 'pwned_rls_%'`)
    assert.equal(pwned?.n, 0, 'the policy function must not have run read-write')
    assert.equal(code, 1, lastOutput)
    assert.match(lastOutput, /row-level-security policy/)
    assert.equal(await commentOn(url), null, 'a database holding a hidden row must not be stamped')
  })
})

test('MEDIUM-1: the guard refuses a users row hidden by a USING (false) policy', { skip }, async (t) => {
  const reason = await rowSecurityBypassReason(process.env.DATABASE_URL!)
  if (reason) {
    t.skip(reason)
    return
  }
  await withSiblingDatabase(async (name, url) => {
    await sql(url, `
      CREATE SCHEMA a; CREATE TABLE a.users (id text); INSERT INTO a.users VALUES ('real-user');
      ALTER TABLE a.users ENABLE ROW LEVEL SECURITY; ALTER TABLE a.users FORCE ROW LEVEL SECURITY;
      CREATE POLICY hide ON a.users USING (false);
      COMMENT ON DATABASE "${name}" IS '${expectedScratchDatabaseMarker(name)}'`)
    // Precondition, so this cannot pass vacuously: the row really is hidden from this role.
    const [visible] = await sql(url, 'SELECT pg_catalog.count(*)::int AS n FROM a.users')
    assert.equal(visible?.n, 0, 'precondition: the policy hides the row from an ordinary read')
    await assert.rejects(
      checkScratchDatabase(url, name),
      (error: unknown) => error instanceof NotAScratchDatabaseError && /row-level-security policy/.test(error.message),
    )
  })
})

// ---------------------------------------------------------------------------------------------
// o3d-zzgp r11, review HIGH-1 (CVE-2018-1058). A database owner sets the DB search_path and plants
// operators; without the search_path pin they resolve to the owner's functions. All three run as
// the ordinary (non-superuser) role the suite already uses, which is the tenant-owner case; the
// COPY-TO-PROGRAM / superuser-escalation variant needs a superuser connection this suite does not
// have, and is proved out of band (mut/r11/attacks.sh) — see docs/development.md "Database-backed
// tiers". Each sets ALTER DATABASE search_path so a missing pin would be exploited; the fix pins
// search_path=pg_catalog in the startup options, which outranks ALTER DATABASE.

/** Point the sibling DB's default search_path at a hostile schema, as an owner may. */
async function setHostileSearchPath(name: string): Promise<void> {
  await sql(process.env.DATABASE_URL!, `ALTER DATABASE "${name}" SET search_path = s, pg_catalog`)
}

test('HIGH-1(a): a planted operator that neutralises the data filter does not get a DB with rows stamped', { skip }, async () => {
  await withSiblingDatabase(async (name, url) => {
    await setHostileSearchPath(name)
    await sql(url, `
      CREATE SCHEMA s;
      CREATE FUNCTION s.evil_nmatch(name, name) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT false $$;
      CREATE OPERATOR s.!~ (LEFTARG = name, RIGHTARG = name, FUNCTION = s.evil_nmatch);
      CREATE TABLE s.products (x int); INSERT INTO s.products VALUES (1)`)
    const code = await runStamper(url, [name])
    assert.equal(code, 1, `must refuse a DB holding s.products, not stamp it: ${lastOutput}`)
    assert.equal(await commentOn(url), null, 'a DB holding rows must not be stamped')
  })
})

test('HIGH-1(c): a planted = operator cannot run read-write on the stamper writer', { skip }, async () => {
  await withSiblingDatabase(async (name, url) => {
    await setHostileSearchPath(name)
    await sql(url, `
      CREATE SCHEMA s;
      CREATE FUNCTION s.evil_eq(name, name) RETURNS boolean LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('transaction_read_only') = 'off' THEN
          EXECUTE 'CREATE TABLE IF NOT EXISTS s.pwned_rw_marker ()';
        END IF;
        RETURN $1 OPERATOR(pg_catalog.=) $2;
      END $$;
      CREATE OPERATOR s.= (LEFTARG = name, RIGHTARG = name, FUNCTION = s.evil_eq)`)
    await runStamper(url, [name])
    const [pwned] = await sql(url, `SELECT pg_catalog.count(*)::pg_catalog.int4 AS n FROM pg_catalog.pg_class WHERE relname OPERATOR(pg_catalog.=) 'pwned_rw_marker'`)
    assert.equal(pwned?.n, 0, 'the planted = operator must never run, still less create a table read-write')
  })
})

test('HIGH-1(d): the guard refuses a users row hidden by a planted = operator', { skip }, async () => {
  await withSiblingDatabase(async (name, url) => {
    await setHostileSearchPath(name)
    await sql(url, `
      CREATE SCHEMA s;
      CREATE FUNCTION s.evil_eqt(name, text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT false $$;
      CREATE OPERATOR s.= (LEFTARG = name, RIGHTARG = text, FUNCTION = s.evil_eqt);
      CREATE TABLE s.users (id text); INSERT INTO s.users VALUES ('real-user');
      COMMENT ON DATABASE "${name}" IS '${expectedScratchDatabaseMarker(name)}'`)
    await assert.rejects(
      checkScratchDatabase(url, name),
      (error: unknown) => error instanceof NotAScratchDatabaseError && /installed application|users/.test(error.message),
    )
  })
})

test('LOW-2: the search_path pin ALONE stops a planted operator on an unqualified statement', { skip }, async () => {
  // The HIGH-1 integration tests pass even with the pin removed, because the qualified operators
  // hold on their own. This isolates the OTHER layer: with operators DISABLED (an unqualified
  // `name = name`), the pin alone must stop the planted operator resolving. Control: without the
  // pin the same statement fires it.
  await withSiblingDatabase(async (name, url) => {
    await setHostileSearchPath(name)
    await sql(url, `
      CREATE SCHEMA s;
      CREATE FUNCTION s.evil_eq(name, name) RETURNS boolean LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('transaction_read_only') = 'off' THEN
          EXECUTE 'CREATE TABLE IF NOT EXISTS s.pinproof ()';
        END IF;
        RETURN $1 OPERATOR(pg_catalog.=) $2;
      END $$;
      CREATE OPERATOR s.= (LEFTARG = name, RIGHTARG = name, FUNCTION = s.evil_eq)`)
    // An UNQUALIFIED name = name comparison — this is the test's own probe, not the guard's.
    const UNQUALIFIED = `SELECT 1 FROM pg_catalog.pg_database WHERE datname = current_database()`

    const unpinned = await connectWithOptions(url, '-c standard_conforming_strings=on')
    try { await unpinned.query(UNQUALIFIED) } finally { await unpinned.end() }
    const [ctl] = await sql(url, `SELECT pg_catalog.count(*)::pg_catalog.int4 AS n FROM pg_catalog.pg_class WHERE relname OPERATOR(pg_catalog.=) 'pinproof'`)
    assert.equal(ctl?.n, 1, 'control: without the pin, the unqualified = resolves the planted operator and it writes')
    await sql(url, 'DROP TABLE IF EXISTS s.pinproof')

    // The SAME options the guard and the stamper connect with — so removing the pin there reds this.
    const pinned = await connectWithOptions(url, PROBE_SESSION_OPTIONS)
    try { await pinned.query(UNQUALIFIED) } finally { await pinned.end() }
    const [res] = await sql(url, `SELECT pg_catalog.count(*)::pg_catalog.int4 AS n FROM pg_catalog.pg_class WHERE relname OPERATOR(pg_catalog.=) 'pinproof'`)
    assert.equal(res?.n, 0, 'with search_path=pg_catalog the unqualified = resolves pg_catalog.= and the operator never runs')
  })
})

test('LOW-3: the writer re-reads identity and re-checks INSIDE a read-only savepoint (statement order)', { skip }, async () => {
  await withSiblingDatabase(async (name, url) => {
    const stmts: string[] = []
    const code = await runStamper(url, [name], undefined, (sql) => stmts.push(sql))
    assert.equal(code, 0, lastOutput)
    const iSavepoint = stmts.findIndex((q) => /^\s*SAVEPOINT stamp_recheck/.test(q))
    const iReadOnly = stmts.findIndex((q) => /SET LOCAL transaction_read_only = on/.test(q))
    // The WRITER's identity re-read — the first one AFTER the read-only savepoint opens (the reader's
    // own identity read at the start of the run is deliberately not the one under test).
    const iIdentity = stmts.findIndex((q, idx) => idx > iReadOnly && iReadOnly >= 0 && /pg_postmaster_start_time/.test(q))
    const iRollback = stmts.findIndex((q) => /ROLLBACK TO SAVEPOINT stamp_recheck/.test(q))
    const iComment = stmts.findIndex((q) => /COMMENT ON DATABASE/.test(q))
    const order = `savepoint=${iSavepoint} readOnly=${iReadOnly} identity=${iIdentity} rollback=${iRollback} comment=${iComment}`
    assert.ok(iSavepoint >= 0, `SAVEPOINT stamp_recheck must be sent — ${order}`)
    assert.ok(iReadOnly > iSavepoint, `SET LOCAL read-only must follow the SAVEPOINT — ${order}`)
    assert.ok(iIdentity > iReadOnly, `the identity re-read must run under the read-only savepoint — ${order}`)
    assert.ok(iRollback > iIdentity, `the savepoint must be rolled back after the re-check — ${order}`)
    assert.ok(iComment > iRollback, `the COMMENT must run only after the savepoint is rolled back — ${order}`)

    // --unstamp (follow-up LOW-5): the same shape on its writer.
    const un: string[] = []
    assert.equal(await runStamper(url, [name, '--unstamp'], undefined, (sql) => un.push(sql)), 0, lastOutput)
    const uSave = un.findIndex((q) => /^\s*SAVEPOINT unstamp_recheck/.test(q))
    const uRo = un.findIndex((q, idx) => idx > uSave && uSave >= 0 && /SET LOCAL transaction_read_only = on/.test(q))
    const uId = un.findIndex((q, idx) => idx > uRo && uRo >= 0 && /pg_postmaster_start_time/.test(q))
    const uRb = un.findIndex((q) => /ROLLBACK TO SAVEPOINT unstamp_recheck/.test(q))
    const uCom = un.findIndex((q) => /COMMENT ON DATABASE/.test(q))
    const uOrder = `savepoint=${uSave} readOnly=${uRo} identity=${uId} rollback=${uRb} comment=${uCom}`
    assert.ok(uSave >= 0 && uRo > uSave && uId > uRo && uRb > uId && uCom > uRb, `--unstamp writer order — ${uOrder}`)
  })
})
