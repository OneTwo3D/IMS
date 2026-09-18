import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ALWAYS_REFUSED_DATABASE,
  SCRATCH_DATABASE_OPT_IN_ENV,
  expectedScratchDatabaseMarker,
  scratchDatabaseVerdict,
  type ScratchDatabaseFacts,
} from './concurrency/scratch-database-guard'
import { refuseToStamp } from '../scripts/stamp-scratch-database'
import {
  INSTALLATION_EVIDENCE_TABLE_NAMES,
  MIGRATION_SEEDED_TABLE_NAMES,
  buildPopulatedTableProbe,
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
  // Review L-1, and M-5: this tests the statement the server is sent, not an injected array.
  const relations = [
    { schema: 'public', name: '_prisma_migrations', kind: 'r' },
    { schema: 'public', name: 'settings', kind: 'r' },
    { schema: 'public', name: 'shopping_status_mappings', kind: 'r' },
    { schema: 'public', name: 'products', kind: 'r' },
    { schema: 'tenant', name: 'settings', kind: 'r' },
    { schema: 'tenant', name: 'products', kind: 'p' },
    { schema: 'public', name: 'report_cache', kind: 'm' },
    { schema: 'public', name: 'remote_orders', kind: 'f' },
    { schema: 'we"ird', name: "o'dd", kind: 'r' },
  ]
  const probe = buildPopulatedTableProbe(relations, 'public')
  assert.deepEqual(probe.exempted, ['public._prisma_migrations', 'public.settings', 'public.shopping_status_mappings'])
  // `tenant.settings` is PROBED — round 7 exempted the bare name in every schema.
  assert.deepEqual(probe.probed, ['public.products', 'tenant.settings', 'tenant.products', 'public.report_cache', `we"ird.o'dd`])
  // A foreign table is reported, never read.
  assert.deepEqual(probe.foreign, ['public.remote_orders'])
  assert.doesNotMatch(String(probe.sql), /remote_orders/)
  // Identifiers and labels are quoted.
  assert.match(String(probe.sql), /FROM "we""ird"\."o'dd"/)
  assert.match(String(probe.sql), /'we"ird\.o''dd'/)

  // Under a non-public application schema the exemption moves with it.
  const ims = buildPopulatedTableProbe(
    [{ schema: 'ims', name: 'settings', kind: 'r' }, { schema: 'public', name: 'settings', kind: 'r' }],
    'ims',
  )
  assert.deepEqual(ims.exempted, ['ims.settings'])
  assert.deepEqual(ims.probed, ['public.settings'])

  // Nothing to probe → no statement.
  assert.equal(buildPopulatedTableProbe([], 'public').sql, null)
})
