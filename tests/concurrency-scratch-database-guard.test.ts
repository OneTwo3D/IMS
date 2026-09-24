import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ALWAYS_REFUSED_DATABASE,
  SCRATCH_DATABASE_OPT_IN_ENV,
  expectedScratchDatabaseMarker,
  scratchDatabaseVerdict,
  type ScratchDatabaseFacts,
} from './concurrency/scratch-database-guard'
import { connectionOptions, refuseToStamp, sameServerAndDatabase } from '../scripts/stamp-scratch-database'
import {
  INSTALLATION_EVIDENCE_TABLE_NAMES,
  MIGRATION_SEEDED_TABLE_NAMES,
  PROBE_SESSION_OPTIONS,
  RowSecurityPolicyPresent,
  SearchPathNotPinned,
  buildPopulatedTableProbe,
  readDataFacts,
  readInstallationEvidence,
} from './concurrency/scratch-database-data-probe'

/**
 * o3d-zzgp rounds 4-6. The guard accepts a database only on PROOF FROM THE SERVER that it
 * was created to be destroyed — the disposability stamp — AND an exact declaration, with a
 * name belt that outranks both.
 *
 * WHAT THIS TABLE IS FOR, and what round 5's was not. Round 5's list tested the names its
 * own regex was written from, so it agreed with itself; it omitted every shape the product
 * actually ships. The names below are taken from this repository: `onetwoinventory` is
 * .env.example's canonical database, `ims_<slug>` is what scripts/provision-ims-tenant.sh
 * names every tenant's LIVE database, `ims_e2e`/`ims_acctmoney_conc`/`ims_scratch_11rf_recon3`
 * exist on the development server right now, and `ims_ci` is the CI service container's.
 *
 * NON-VACUITY: `stamped()` below accepts, and accepts for `ims_ci` and `ims_scratch_*`
 * alike, so a blanket refusal would fail this file rather than pass it.
 */

const REAL_OR_SERVER_OWNED = [
  'onetwoinventory', 'onetwoinventory_staging',
  'onetwo3d_ims_dev', 'onetwo3d_ims_e2e', 'onetwo3d_ims',
  'postgres', 'postgres_backup', 'template0', 'template1', 'templatedb', 'template_ims', 'pg_temp_1',
  'ims-prod', 'ims_prod', 'imslive', 'ims-live', 'ims-production', 'prod_ims', 'ims_scratch_prod_restore',
]

/** Live tenant and shared databases a NAME rule cannot tell from a scratch one. */
const INDISTINGUISHABLE_BY_NAME = ['ims_acme', 'ims_e2e', 'ims_acctmoney_conc', 'ims_scratch_11rf_recon3']

function facts(overrides: Partial<ScratchDatabaseFacts> & { connectedDatabase: string }): ScratchDatabaseFacts {
  return {
    optIn: overrides.connectedDatabase,
    databaseComment: null,
    inRecovery: false,
    isTemplate: false,
    subscriptionCount: 0,
    installationEvidence: [],
    foreignTables: [],
    ...overrides,
  }
}

/** A database created for this run: declared by name and stamped disposable FOR THAT NAME. */
function stamped(connectedDatabase: string): ScratchDatabaseFacts {
  return facts({ connectedDatabase, databaseComment: expectedScratchDatabaseMarker(connectedDatabase) })
}

test('accepts a database that is declared by name AND stamped disposable', () => {
  // The positive control, and the non-vacuity control for every refusal below.
  assert.deepEqual(scratchDatabaseVerdict(stamped('ims_ci')), { ok: true })
  assert.deepEqual(scratchDatabaseVerdict(stamped('ims_scratch_zzgp_r6_1789')), { ok: true })
  assert.deepEqual(scratchDatabaseVerdict(stamped('throwaway_db_for_this_run')), { ok: true })
})

test('refuses a real or server-owned NAME however it is declared and stamped', () => {
  for (const name of REAL_OR_SERVER_OWNED) {
    assert.equal(ALWAYS_REFUSED_DATABASE.test(name), true, `${name} must be in the belt`)
    const verdict = scratchDatabaseVerdict(stamped(name))
    assert.equal(verdict.ok, false, `${name} must be refused even when declared AND stamped`)
    assert.match(verdict.ok === false ? verdict.reason : '', /real or server-owned database by name/, name)
    assert.equal(scratchDatabaseVerdict(facts({ connectedDatabase: name, optIn: undefined })).ok, false, `${name} undeclared`)
  }
})

test('refuses the tenant and shared databases a name rule cannot see — they carry no stamp', () => {
  // HIGH-1 of the round-6 review: `ims_acme` is a LIVE tenant database (provision-ims-tenant.sh
  // names it `ims_<slug>`), and round 5 accepted it the moment it was declared. It is
  // indistinguishable by name from CI's own `ims_ci`, so the belt cannot carry this — the
  // stamp does.
  for (const name of INDISTINGUISHABLE_BY_NAME) {
    const declared = scratchDatabaseVerdict(facts({ connectedDatabase: name }))
    assert.equal(declared.ok, false, `${name} must be refused when declared but unstamped`)
    assert.match(declared.ok === false ? declared.reason : '', /not marked disposable/, name)
    assert.equal(
      scratchDatabaseVerdict(facts({ connectedDatabase: name, optIn: undefined })).ok,
      false,
      `${name} must be refused undeclared`,
    )
    // And the belt genuinely does not cover them, which is why the stamp is the rule.
    assert.equal(ALWAYS_REFUSED_DATABASE.test(name), false, `${name} is not caught by the name belt`)
  }
})

test('refuses a stamped database the run did not declare, or declared as another database', () => {
  // MEDIUM-3: round 5 let a scratch-shaped NAME satisfy this on its own, so a mistyped URL
  // between two scratch databases sailed through. The conjunction is restored.
  const marker = { databaseComment: expectedScratchDatabaseMarker('ims_scratch_a') }
  assert.equal(scratchDatabaseVerdict(facts({ connectedDatabase: 'ims_scratch_a', optIn: undefined, ...marker })).ok, false)
  assert.equal(scratchDatabaseVerdict(facts({ connectedDatabase: 'ims_scratch_a', optIn: 'ims_scratch_b', ...marker })).ok, false)
  assert.equal(scratchDatabaseVerdict(facts({ connectedDatabase: 'ims_scratch_a', optIn: '1', ...marker })).ok, false)
  assert.equal(scratchDatabaseVerdict(facts({ connectedDatabase: 'ims_scratch_a', optIn: 'IMS_SCRATCH_A', ...marker })).ok, false)
})

test('refuses a declared database whose stamp is missing or is some other comment', () => {
  assert.match(
    (scratchDatabaseVerdict(facts({ connectedDatabase: 'ims_ci' })) as { reason: string }).reason,
    /is not marked disposable for THIS database: its database comment is unset/,
  )
  assert.match(
    (scratchDatabaseVerdict(facts({ connectedDatabase: 'ims_ci', databaseComment: 'tenant: acme' })) as { reason: string }).reason,
    /its database comment is "tenant: acme"/,
  )
  assert.equal(
    scratchDatabaseVerdict(facts({ connectedDatabase: 'ims_ci', databaseComment: `${expectedScratchDatabaseMarker('ims_ci')} ` })).ok,
    false,
    'the marker is matched exactly, not by prefix',
  )
})

test('refuses a database carrying a marker issued for ANOTHER name — a rename or a restore', () => {
  // Review MEDIUM-3, measured: a database comment is keyed to the OID, so `ALTER DATABASE …
  // RENAME` keeps it, and `pg_dump -C` carries it into a restore under another name. Binding the
  // name into the marker makes both invalid without needing anyone to remember to unstamp.
  const renamed = facts({
    connectedDatabase: 'ims_customer_rev7',
    databaseComment: expectedScratchDatabaseMarker('ims_scratch_rev7_src'),
  })
  const verdict = scratchDatabaseVerdict(renamed)
  assert.equal(verdict.ok, false)
  assert.match(verdict.ok === false ? verdict.reason : '', /issued for a DIFFERENT database name/)
  // And the positive control: the same database stamped for its own name is accepted.
  assert.deepEqual(scratchDatabaseVerdict(stamped('ims_customer_rev7')), { ok: true })
})

test('refuses on server state a name cannot show: replica, template, subscription target', () => {
  // A logical replica of production is invisible to every name rule, which is the point.
  assert.match(
    (scratchDatabaseVerdict({ ...stamped('ims_ci'), inRecovery: true }) as { reason: string }).reason,
    /server in recovery/,
  )
  assert.match(
    (scratchDatabaseVerdict({ ...stamped('ims_ci'), isTemplate: true }) as { reason: string }).reason,
    /template database/,
  )
  assert.match(
    (scratchDatabaseVerdict({ ...stamped('ims_ci'), subscriptionCount: 1 }) as { reason: string }).reason,
    /logical-replication subscription/,
  )
  // An unreadable catalog does not refuse on its own — the stamp is what excludes a copy.
  assert.deepEqual(scratchDatabaseVerdict({ ...stamped('ims_ci'), subscriptionCount: null }), { ok: true })
})

test('refuses when the server reports no name at all', () => {
  // LOW-6: the empty string used to satisfy an exact-match comparison against itself.
  assert.equal(scratchDatabaseVerdict(facts({ connectedDatabase: '', optIn: '', databaseComment: expectedScratchDatabaseMarker('') })).ok, false)
})

test('the stamper refuses every database a stamp must never be applied to — including one holding data', () => {
  // Review LOW-1: round 6's version was titled "exactly what a stamp must never be applied to"
  // while asserting nothing about the open question — a database holding rows. It does now, and
  // that case is the review's own HIGH-1 reproduction.
  const ok = { database: 'ims_ci', requestedName: 'ims_ci', inRecovery: false, isTemplate: false, subscriptionCount: 0, populatedTables: [] }
  assert.equal(refuseToStamp(ok), null, 'the positive control: an empty database, named, stamps')

  for (const name of REAL_OR_SERVER_OWNED) {
    assert.notEqual(refuseToStamp({ ...ok, database: name, requestedName: name }), null, name)
  }
  // HIGH-1: a live tenant database holding application data, named correctly, is refused.
  const withData = refuseToStamp({
    ...ok,
    database: 'ims_acme',
    requestedName: 'ims_acme',
    populatedTables: ['public.products', 'public.users', 'public.warehouses'],
  })
  assert.notEqual(withData, null)
  assert.match(String(withData), /holds application data — rows in public\.products/)

  // The name must be GIVEN, and must be the database this URL reaches.
  assert.match(String(refuseToStamp({ ...ok, requestedName: undefined })), /no database name was given/)
  const wrongName = String(refuseToStamp({ ...ok, requestedName: 'ims_other' }))
  assert.match(wrongName, /is not the database this DATABASE_URL reaches/)
  // Review L-5: it must not name the database the URL actually reached — that made the argument
  // one guided retry away.
  assert.doesNotMatch(wrongName, /ims_ci/)
  // A database wired to another server is refused on sight, never read.
  assert.match(String(refuseToStamp({ ...ok, foreignTables: ['public.remote_orders'] })), /foreign tables/)

  // Server state, with the subscription catalogue failing CLOSED here (review LOW-4).
  assert.notEqual(refuseToStamp({ ...ok, inRecovery: true }), null)
  assert.notEqual(refuseToStamp({ ...ok, isTemplate: true }), null)
  assert.notEqual(refuseToStamp({ ...ok, subscriptionCount: 2 }), null)
  assert.match(String(refuseToStamp({ ...ok, subscriptionCount: null })), /could not be read/)
  assert.notEqual(refuseToStamp({ ...ok, database: '', requestedName: '' }), null)
  assert.equal(SCRATCH_DATABASE_OPT_IN_ENV, 'IMS_CONCURRENCY_SCRATCH_DB')
})

test('the guard refuses a stamped, declared database that has been set up as an installed application', () => {
  // Review M-1: the stamp is checked for data only when it is ISSUED. The guard now refuses a
  // stamped database that has since acquired the marks of an installation — and ONLY those, because
  // the tier itself fills products/stock/warehouses (measured: 23 tables after one run), so those
  // rows cannot be evidence of anything.
  for (const table of INSTALLATION_EVIDENCE_TABLE_NAMES) {
    const verdict = scratchDatabaseVerdict({ ...stamped('ims_ci'), installationEvidence: [`public.${table}`] })
    assert.equal(verdict.ok, false, table)
    assert.match(verdict.ok === false ? verdict.reason : '', /set up as an installed application/, table)
  }
  // The positive control: the same stamped database with none of them is accepted.
  assert.deepEqual(scratchDatabaseVerdict(stamped('ims_ci')), { ok: true })
  // And the evidence set is disjoint from what migrations seed, or a fresh database would fail.
  for (const table of INSTALLATION_EVIDENCE_TABLE_NAMES) {
    assert.equal((MIGRATION_SEEDED_TABLE_NAMES as readonly string[]).includes(table), false, table)
  }
})

test('the data probe exempts the migration-seeded tables ONLY in the application schema', () => {
  // r8 review L-1: tests the statement the server is sent, not an injected array.
  const relations = [
    { schema: 'public', name: '_prisma_migrations', kind: 'r' },
    { schema: 'public', name: 'settings', kind: 'r' },
    { schema: 'public', name: 'shopping_status_mappings', kind: 'r' },
    { schema: 'public', name: 'products', kind: 'r' },
    { schema: 'tenant', name: 'settings', kind: 'r' },
    { schema: 'tenant', name: 'products', kind: 'p' },
    { schema: 'public', name: 'report_cache', kind: 'm' },
  ]
  const probe = buildPopulatedTableProbe(relations, 'public')
  assert.deepEqual(probe.exempted, ['public._prisma_migrations', 'public.settings', 'public.shopping_status_mappings'])
  assert.deepEqual(probe.probed, ['public.products', 'tenant.settings', 'tenant.products', 'public.report_cache'])
  const ims = buildPopulatedTableProbe(
    [{ schema: 'ims', name: 'settings', kind: 'r' }, { schema: 'public', name: 'settings', kind: 'r' }],
    'ims',
  )
  assert.deepEqual(ims.exempted, ['ims.settings'])
  assert.deepEqual(ims.probed, ['public.settings'])
  assert.equal(buildPopulatedTableProbe([], 'public').sql, null)
})

// ---------------------------------------------------------------------------------------------
// o3d-zzgp r9, review MEDIUM-1: SQL injection through catalogue names. The reviewer created
// `pwned` through round 8's READ-ONLY reader using this schema name with tables `\` and `zz`,
// after `ALTER DATABASE … SET standard_conforming_strings = off`. Reproduced live before the fix.
// ---------------------------------------------------------------------------------------------
const ATTACK_SCHEMA = ' z;COMMIT;BEGIN READ WRITE;CREATE TABLE pwned();COMMIT;--'

/** Remove every double-quoted identifier from a statement, so what is left is what the server PARSES. */
function withoutIdentifiers(sql: string): string {
  return sql.replace(/"(?:[^"]|"")*"/g, 'IDENT')
}

test('the probe carries catalogue names ONLY inside double-quoted identifiers — never in a string literal', () => {
  const probe = buildPopulatedTableProbe([
    { schema: ATTACK_SCHEMA, name: '\\', kind: 'r' },
    { schema: ATTACK_SCHEMA, name: 'zz', kind: 'r' },
    { schema: 'we"ird', name: "o'dd", kind: 'r' },
  ], 'public')
  const sql = String(probe.sql)
  // THE ROOT OF THE FINDING: round 8 labelled each probe with a single-quoted `'schema.table'`,
  // whose quoting a backslash can break under standard_conforming_strings=off. No literal at all:
  // (A quote INSIDE a double-quoted identifier — `"o'dd"` — is part of the name, not a literal.)
  const parsed = withoutIdentifiers(sql)
  assert.equal(parsed.includes("'"), false, `the probe must contain no string literal: ${parsed}`)
  // And once every identifier is removed, nothing of any catalogue name is left for the parser.
  for (const fragment of ['COMMIT', 'pwned', 'CREATE', 'READ WRITE', 'o\'dd', 'we']) {
    assert.equal(parsed.includes(fragment), false, `"${fragment}" reached the parser outside an identifier: ${parsed}`)
  }
  // Labels are the integers this code generated, mapped back to names in JS.
  assert.match(sql, /SELECT 0::pg_catalog\.int4 AS i WHERE EXISTS/)
  assert.match(sql, /SELECT 2::pg_catalog\.int4 AS i WHERE EXISTS/)
  assert.deepEqual(probe.probed, [`${ATTACK_SCHEMA}.\\`, `${ATTACK_SCHEMA}.zz`, `we"ird.o'dd`])
})

type Sent = { text: string; values: unknown; queryMode: unknown }

/** A client that answers the catalogue queries it recognises and records everything it is sent. */
function recordingClient(
  catalogue: { foreign: object[]; relations: object[] },
  server: { rowSecurity?: string; searchPath?: string; probeError?: { code: string; message: string } } = {},
) {
  const sent: Sent[] = []
  const client = {
    query: async (config: unknown) => {
      const text = typeof config === 'string' ? config : String((config as { text: string }).text)
      sent.push({
        text,
        values: typeof config === 'string' ? undefined : (config as { values?: unknown }).values,
        queryMode: typeof config === 'string' ? undefined : (config as { queryMode?: unknown }).queryMode,
      })
      if (/current_setting\('row_security'\)/.test(text)) return { rows: [{ row_security: server.rowSecurity ?? 'off', search_path: server.searchPath ?? 'pg_catalog' }] }
      if (server.probeError && /EXISTS/.test(text)) throw Object.assign(new Error(server.probeError.message), server.probeError)
      if (/relkind OPERATOR\(pg_catalog\.=\) 'f'/.test(text)) return { rows: catalogue.foreign }
      if (/relkind OPERATOR\(pg_catalog\.=\) ANY/.test(text)) return { rows: [...catalogue.relations, ...catalogue.foreign] }
      return { rows: [] }
    },
  }
  return { client, sent }
}

test('every statement the probe sends goes through the EXTENDED protocol', async () => {
  // The extended protocol's Parse accepts exactly ONE statement, so a `;…` tail is rejected by the
  // server rather than run. Round 8 sent plain strings over the simple protocol.
  const { client, sent } = recordingClient({ foreign: [], relations: [{ schema: 'public', name: 'products', kind: 'r' }] })
  await readDataFacts(client as never, 'public')
  assert.ok(sent.length >= 2, `precondition: statements were sent (${sent.length})`)
  for (const statement of sent) {
    assert.equal(statement.queryMode, 'extended', `sent over the simple protocol: ${statement.text.slice(0, 60)}`)
  }
  const evidence = recordingClient({ foreign: [], relations: [{ schema: 'public', name: 'users', kind: 'r' }] })
  await readInstallationEvidence(evidence.client as never)
  for (const statement of evidence.sent) {
    assert.equal(statement.queryMode, 'extended', `sent over the simple protocol: ${statement.text.slice(0, 60)}`)
  }
})

// ---------------------------------------------------------------------------------------------
// o3d-zzgp r9, review MEDIUM-2: "foreign tables are never read" was false. A foreign PARTITION
// was hidden by `NOT relispartition`, and a foreign CHILD was listed but its local parent probed
// first. Measured live with postgres_fdw before the fix: the remote tables' seq_scan went 0 → 1.
// ---------------------------------------------------------------------------------------------
test('a foreign table stops the data probe BEFORE any table is probed — partitions and children included', async () => {
  const catalogue = {
    // A foreign PARTITION of local `lp`, and a foreign CHILD inheriting local `lt`.
    foreign: [
      { schema: 'public', name: 'lp_remote', kind: 'f' },
      { schema: 'public', name: 'lt_remote', kind: 'f' },
    ],
    relations: [
      { schema: 'public', name: 'lp', kind: 'p' },
      { schema: 'public', name: 'lt', kind: 'r' },
    ],
  }
  const data = recordingClient(catalogue)
  const facts = await readDataFacts(data.client as never, 'public')
  // THE SUBSTANTIVE CHECK FIRST: nothing that could read the foreign tables was sent.
  assert.equal(data.sent.some((statement) => /EXISTS/.test(statement.text)), false,
    `no row probe may be sent while a foreign table exists: ${data.sent.map((statement) => statement.text.slice(0, 40)).join(' | ')}`)
  assert.deepEqual(facts.foreign, ['public.lp_remote', 'public.lt_remote'], 'the foreign PARTITION is listed too')
  assert.equal(facts.probed, false)

  const evidence = recordingClient(catalogue)
  const installation = await readInstallationEvidence(evidence.client as never)
  assert.equal(installation.probed, false)
  assert.equal(evidence.sent.some((statement) => /EXISTS/.test(statement.text)), false, 'the guard\'s probe stops too')

  // And both callers refuse on the list.
  assert.match(String(refuseToStamp({
    database: 'ims_ci', requestedName: 'ims_ci', inRecovery: false, isTemplate: false,
    subscriptionCount: 0, populatedTables: [], foreignTables: facts.foreign,
  })), /foreign tables/)
  assert.match(
    (scratchDatabaseVerdict({ ...stamped('ims_ci'), foreignTables: installation.foreign }) as { reason: string }).reason,
    /foreign tables/,
  )
})

test('installation evidence is searched in EVERY schema, with the table names as a bind parameter', async () => {
  // Review L5: round 8 looked only in the URL's schema.
  const { client, sent } = recordingClient({
    foreign: [],
    relations: [{ schema: 'tenant', name: 'users', kind: 'r' }, { schema: 'public', name: 'organisations', kind: 'r' }],
  })
  await readInstallationEvidence(client as never)
  const catalogueQuery = sent.find((statement) => /relname::pg_catalog\.text OPERATOR\(pg_catalog\.=\) ANY/.test(statement.text))
  assert.ok(catalogueQuery, 'the evidence catalogue query was sent')
  assert.doesNotMatch(catalogueQuery!.text, /nspname OPERATOR\(pg_catalog\.=\)/, 'not restricted to one schema')
  assert.deepEqual(catalogueQuery!.values, [[...INSTALLATION_EVIDENCE_TABLE_NAMES]])
  const probe = sent.find((statement) => /EXISTS/.test(statement.text))
  assert.match(String(probe?.text), /"tenant"\."users"/)
})

test('the writer must reach the same SERVER and DATABASE, not merely the same name', () => {
  // Review M3: round 8 compared current_database() only.
  const reader = { name: 'ims_ci', oid: '16384', postmasterStart: '2026-09-18 07:00:00+00', serverAddr: '10.0.0.5/32', serverPort: '5432', comment: null }
  assert.equal(sameServerAndDatabase(reader, { ...reader }), true)
  assert.equal(sameServerAndDatabase(reader, { ...reader, oid: '16999' }), false, 'same name, recreated database')
  assert.equal(sameServerAndDatabase(reader, { ...reader, postmasterStart: '2026-09-18 08:00:00+00' }), false, 'another server')
  assert.equal(sameServerAndDatabase(reader, { ...reader, serverAddr: '10.0.0.6/32' }), false, 'another host')
  assert.equal(sameServerAndDatabase(reader, { ...reader, serverPort: '6432' }), false, 'a pooler or another port')
})

// ---------------------------------------------------------------------------------------------
// o3d-zzgp r10, review MEDIUM-1: a table's row-level-security policy is EVALUATED by a probe — the
// reviewer's policy called a function that created a table on the stamper's read-write writer,
// and `USING (false)` hid a users row from the guard. Rule 4: every probe connection runs with
// row_security=off (the server then refuses, without evaluating the policy), the probe module
// checks that setting itself, and reports the refusal as RowSecurityPolicyPresent.
// ---------------------------------------------------------------------------------------------
test('PROBE_SESSION_OPTIONS pins row_security=off, standard_conforming_strings=on AND search_path=pg_catalog', () => {
  // review LOW-4: this must fail if the reviewer's surviving mutation — dropping BOTH the option and
  // the assertion — is reintroduced by dropping the option here.
  assert.match(PROBE_SESSION_OPTIONS, /(^| )-c row_security=off( |$)/)
  assert.match(PROBE_SESSION_OPTIONS, /(^| )-c standard_conforming_strings=on( |$)/)
  assert.match(PROBE_SESSION_OPTIONS, /(^| )-c search_path=pg_catalog( |$)/)
  for (const readOnly of [true, false]) {
    assert.ok(connectionOptions(readOnly).includes(PROBE_SESSION_OPTIONS),
      `the stamper's ${readOnly ? 'reader' : 'writer'} must carry PROBE_SESSION_OPTIONS: ${connectionOptions(readOnly)}`)
  }
  assert.match(connectionOptions(true), /default_transaction_read_only=on/)
})

test('the probe refuses to run on a connection where row security is on — before any probe', async () => {
  const catalogue = { foreign: [], relations: [{ schema: 'public', name: 'products', kind: 'r' }] }
  for (const read of [
    (client: never) => readDataFacts(client, 'public'),
    (client: never) => readInstallationEvidence(client),
  ]) {
    const { client, sent } = recordingClient(catalogue, { rowSecurity: 'on' })
    await assert.rejects(read(client as never), RowSecurityPolicyPresent)
    assert.equal(sent.some((statement) => /EXISTS/.test(statement.text)), false, 'no probe may run with row security on')
  }
})

test('a policy the server would not evaluate is reported as RowSecurityPolicyPresent, not a crash', async () => {
  const probeError = { code: '42501', message: 'query would be affected by row-level security policy for table "t"' }
  const data = recordingClient({ foreign: [], relations: [{ schema: 's', name: 't', kind: 'r' }] }, { probeError })
  await assert.rejects(readDataFacts(data.client as never, 'public'), RowSecurityPolicyPresent)
  const evidence = recordingClient({ foreign: [], relations: [{ schema: 'a', name: 'users', kind: 'r' }] }, { probeError })
  await assert.rejects(readInstallationEvidence(evidence.client as never), RowSecurityPolicyPresent)
  // Any OTHER 42501 (a plain permission failure) is not dressed up as a policy.
  const denied = recordingClient({ foreign: [], relations: [{ schema: 's', name: 't', kind: 'r' }] },
    { probeError: { code: '42501', message: 'permission denied for table t' } })
  await assert.rejects(readDataFacts(denied.client as never, 'public'),
    (error: unknown) => !(error instanceof RowSecurityPolicyPresent) && /permission denied/.test((error as Error).message))
})

// ---------------------------------------------------------------------------------------------
// o3d-zzgp r11, review HIGH-1: operator/cast resolution through an unpinned search_path
// (CVE-2018-1058). Every SQL string these three modules send must schema-qualify not only its
// FUNCTIONS but its OPERATORS and CASTS, and every probe connection must pin search_path=pg_catalog
// and assert it. These are lexical checks — able to fail — over the SQL literals themselves.
// ---------------------------------------------------------------------------------------------
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const MODULE_FILES = [
  'concurrency/scratch-database-data-probe.ts',
  'concurrency/scratch-database-guard.ts',
  '../scripts/stamp-scratch-database.ts',
].map((rel) => fileURLToPath(new URL(rel, import.meta.url)))

/** Every backtick or single-quoted chunk that looks like it carries SQL (has a SQL keyword). */
function sqlLiterals(source: string): string[] {
  // Strip block and line COMMENTS first: a docblock quotes example SQL in backticks (including old,
  // deliberately-unqualified forms), and only the SQL the modules actually SEND must pass these
  // checks. What remains are code template literals; keep those that are a real query.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
  const out: string[] = []
  for (const m of code.matchAll(/`([^`]*)`/g)) {
    const body = m[1]
    if (/\b(SELECT|COMMENT ON DATABASE)\b/.test(body)) out.push(body)
  }
  return out
}

/**
 * Reduce a SQL string to its RESIDUAL: remove every construct that is safe BY CONSTRUCTION, so that
 * anything left is a name/operator/cast/function that would be resolved through search_path. This is
 * a genuine check, not a spot-check of a few operator spellings (follow-up MEDIUM-1): the removals
 * are the exhaustive set of safe forms this code is allowed to use, and everything else is rejected.
 * Removed, in order: string literals; `OPERATOR(pg_catalog.…)`; `::pg_catalog.<type>` casts;
 * `pg_catalog.<name>` references (optionally an aggregate `(*)`); double-quoted identifiers (rule 1);
 * `$n` bind parameters; numbers; alias-qualified column refs `x.y`; and the structural keywords and
 * SQL-standard constructs that are NOT schema-resolved.
 */
// Keyword OPERATORS and casts that ARE search-path/grammar-sensitive and must never appear bare.
const FORBIDDEN_KEYWORD = /\b(LIKE|ILIKE|SIMILAR|BETWEEN|OVERLAPS|CAST|COLLATE)\b/i
const FORBIDDEN_KEYWORD_PHRASE = /\bIS\s+(NOT\s+)?DISTINCT\s+FROM\b|\bNOT\s+(LIKE|ILIKE|IN)\b|\bIN\s*\(/i

function sqlResidual(sql: string): string {
  return sql
    .replace(/\$\{[^}]*\}/g, ' INTERP ')                    // JS template interpolations (quoted idents / ints)
    .replace(/'(?:[^']|'')*'/g, ' ')                         // string literals
    .replace(/OPERATOR\(pg_catalog\.[^)]+\)/g, ' ')           // qualified operators
    .replace(/::\s*pg_catalog\.(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)(?:\s*\[\s*\])?/g, ' ') // qualified casts
    .replace(/pg_catalog\.[A-Za-z_][A-Za-z0-9_]*(?:\s*\(\s*\*\s*\))?/g, ' FUNC ')        // qualified names/aggregates
    .replace(/"(?:[^"]|"")*"/g, ' IDENT ')                    // double-quoted identifiers (rule 1)
    .replace(/\$\d+/g, ' PARAM ')                             // bind parameters
    .replace(/\b\d+\b/g, ' NUM ')                             // numbers
    .replace(/\b[a-z][a-z0-9_]*\.[a-z_][a-z0-9_]*\b/gi, ' COL ') // alias.column
    .replace(/[(),;.*]/g, ' ')                                // structural punctuation and aggregate star
}

test('the modules send only pg_catalog-qualified SQL — no operator, cast, function or catalog name resolves through search_path (follow-up MEDIUM-1)', () => {
  let checked = 0
  const OP_CHARS = /[-+/<>=~!@#%^&|?]/          // arithmetic/comparison/regex operator characters
  for (const file of MODULE_FILES) {
    for (const sql of sqlLiterals(readFileSync(file, 'utf8'))) {
      checked += 1
      const short = sql.replace(/\s+/g, ' ').slice(0, 110)
      const sqlNoInterp = sql.replace(/\$\{[^}]*\}/g, ' INTERP ')
      // 1. No search-path-sensitive KEYWORD operator or cast keyword survives.
      assert.ok(!FORBIDDEN_KEYWORD.test(sqlNoInterp), `forbidden keyword operator/cast in ${file}: ${short}`)
      assert.ok(!FORBIDDEN_KEYWORD_PHRASE.test(sqlNoInterp), `forbidden operator phrase (IS DISTINCT/NOT LIKE/IN (…)) in ${file}: ${short}`)
      // 2. No unqualified cast: every `::` must be `::pg_catalog.…` (removed by the residual).
      const residual = sqlResidual(sql)
      assert.ok(!residual.includes('::'), `unqualified cast (::) survives in ${file}: ${short}`)
      // 3. No operator CHARACTER survives — every real operator is OPERATOR(pg_catalog.…), removed above.
      const opLeft = residual.match(OP_CHARS)
      assert.equal(opLeft, null, `unqualified operator "${opLeft?.[0]}" survives in ${file}: residual="${residual.replace(/\s+/g,' ').trim().slice(0,90)}" sql=${short}`)
      // 4. Every FUNCTION CALL is pg_catalog-qualified or a grammar construct. Remove the safe forms
      //    from the raw SQL, then any `name(` left is an unqualified function whose name resolves
      //    through search_path.
      const deQualified = sql
        .replace(/\$\{[^}]*\}/g, ' INTERP ')
        .replace(/'(?:[^']|'')*'/g, ' ')
        .replace(/OPERATOR\(pg_catalog\.[^)]+\)/g, ' %OP% ')  // non-word: a following subquery '(' is not a call
        .replace(/::\s*pg_catalog\.(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)(?:\s*\[\s*\])?/g, ' ')
        .replace(/pg_catalog\.[A-Za-z_][A-Za-z0-9_]*/g, ' pg_catalog_ref ')  // keeps any following '('
        .replace(/"(?:[^"]|"")*"/g, ' IDENT ')
      const GRAMMAR_CALLS = new Set(['COALESCE', 'NULLIF', 'ARRAY', 'ANY', 'ALL', 'EXISTS'])
      for (const m of deQualified.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
        const name = m[1]
        if (name === 'pg_catalog_ref') continue
        if (GRAMMAR_CALLS.has(name.toUpperCase())) continue
        assert.fail(`unqualified function call "${name}(" in ${file}: ${short}`)
      }
      // 5. Every RELATION after FROM/JOIN is pg_catalog-qualified or a subquery.
      for (const m of deQualified.matchAll(/\b(?:FROM|JOIN)\s+([^\s(]+)/gi)) {
        const rel = m[1]
        // pg_catalog_ref = a pg_catalog relation; INTERP/IDENT = a runtime double-quoted identifier
        // (the user table being probed for rows — rule 1 covers its quoting).
        if (rel === 'pg_catalog_ref' || rel.startsWith('INTERP') || rel.startsWith('IDENT')) continue
        assert.fail(`unqualified relation after FROM/JOIN ("${rel}") in ${file}: ${short}`)
      }
      // 6. No bare pg_* token survives the residual (an unqualified catalog name used as a value).
      const pgLeft = residual.match(/\bpg_[A-Za-z0-9_]+\b/)
      assert.equal(pgLeft, null, `unqualified catalog name "${pgLeft?.[0]}" in ${file}: ${short}`)
    }
  }
  assert.ok(checked >= 6, `precondition: SQL literals were found and checked (${checked})`)
})

test('the probe refuses when search_path is not pinned to pg_catalog (r11 HIGH-1)', async () => {
  const catalogue = { foreign: [], relations: [{ schema: 'public', name: 'products', kind: 'r' }] }
  for (const read of [
    (client: never) => readDataFacts(client, 'public'),
    (client: never) => readInstallationEvidence(client),
  ]) {
    const { client, sent } = recordingClient(catalogue, { searchPath: 's, pg_catalog' })
    await assert.rejects(read(client as never), SearchPathNotPinned)
    assert.equal(sent.some((statement) => /EXISTS/.test(statement.text)), false,
      'no probe may run when search_path is not pinned')
  }
})

test('assertProbeSessionSafe is the FIRST statement every reader path sends (r11 LOW-4)', async () => {
  // If the assertion were removed from a read path, the first statement it sends would be a probe,
  // not the row_security/search_path query. This pins that the settings query comes first.
  for (const read of [
    (client: never) => readDataFacts(client, 'public'),
    (client: never) => readInstallationEvidence(client),
  ]) {
    const { client, sent } = recordingClient({ foreign: [], relations: [{ schema: 'public', name: 'products', kind: 'r' }] })
    await read(client as never)
    assert.ok(sent.length > 0, 'precondition: statements were sent')
    assert.match(sent[0]!.text, /current_setting\('row_security'\)[\s\S]*current_setting\('search_path'\)/,
      `the first statement must be the session-safety check, was: ${sent[0]!.text.slice(0, 80)}`)
  }
})
