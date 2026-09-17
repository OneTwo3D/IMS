import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ALWAYS_REFUSED_DATABASE,
  SCRATCH_DATABASE_MARKER,
  SCRATCH_DATABASE_OPT_IN_ENV,
  scratchDatabaseVerdict,
  type ScratchDatabaseFacts,
} from './concurrency/scratch-database-guard'
import { refuseToStamp } from '../scripts/stamp-scratch-database'

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
    ...overrides,
  }
}

/** A database created for this run: declared by name and stamped disposable. */
function stamped(connectedDatabase: string): ScratchDatabaseFacts {
  return facts({ connectedDatabase, databaseComment: SCRATCH_DATABASE_MARKER })
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
  const marker = { databaseComment: SCRATCH_DATABASE_MARKER }
  assert.equal(scratchDatabaseVerdict(facts({ connectedDatabase: 'ims_scratch_a', optIn: undefined, ...marker })).ok, false)
  assert.equal(scratchDatabaseVerdict(facts({ connectedDatabase: 'ims_scratch_a', optIn: 'ims_scratch_b', ...marker })).ok, false)
  assert.equal(scratchDatabaseVerdict(facts({ connectedDatabase: 'ims_scratch_a', optIn: '1', ...marker })).ok, false)
  assert.equal(scratchDatabaseVerdict(facts({ connectedDatabase: 'ims_scratch_a', optIn: 'IMS_SCRATCH_A', ...marker })).ok, false)
})

test('refuses a declared database whose stamp is missing or is some other comment', () => {
  assert.match(
    (scratchDatabaseVerdict(facts({ connectedDatabase: 'ims_ci' })) as { reason: string }).reason,
    /is not marked disposable: its database comment is unset/,
  )
  assert.match(
    (scratchDatabaseVerdict(facts({ connectedDatabase: 'ims_ci', databaseComment: 'tenant: acme' })) as { reason: string }).reason,
    /not the scratch marker/,
  )
  assert.equal(
    scratchDatabaseVerdict(facts({ connectedDatabase: 'ims_ci', databaseComment: `${SCRATCH_DATABASE_MARKER} ` })).ok,
    false,
    'the marker is matched exactly, not by prefix',
  )
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
  assert.equal(scratchDatabaseVerdict(facts({ connectedDatabase: '', optIn: '', databaseComment: SCRATCH_DATABASE_MARKER })).ok, false)
})

test('the stamper refuses exactly what a stamp must never be applied to', () => {
  // The stamp is the capability, so the thing that hands it out has the same belt.
  for (const name of REAL_OR_SERVER_OWNED) {
    assert.notEqual(refuseToStamp({ database: name, inRecovery: false, isTemplate: false, subscriptionCount: 0 }), null, name)
  }
  assert.equal(refuseToStamp({ database: 'ims_ci', inRecovery: false, isTemplate: false, subscriptionCount: 0 }), null)
  assert.notEqual(refuseToStamp({ database: 'ims_ci', inRecovery: true, isTemplate: false, subscriptionCount: 0 }), null)
  assert.notEqual(refuseToStamp({ database: 'ims_ci', inRecovery: false, isTemplate: true, subscriptionCount: 0 }), null)
  assert.notEqual(refuseToStamp({ database: 'ims_ci', inRecovery: false, isTemplate: false, subscriptionCount: 2 }), null)
  assert.notEqual(refuseToStamp({ database: '', inRecovery: false, isTemplate: false, subscriptionCount: 0 }), null)
  assert.equal(SCRATCH_DATABASE_OPT_IN_ENV, 'IMS_CONCURRENCY_SCRATCH_DB')
})
