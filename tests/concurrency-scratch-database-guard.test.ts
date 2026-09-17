import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ALWAYS_REFUSED_DATABASE,
  SCRATCH_DATABASE_OPT_IN_ENV,
  scratchDatabaseVerdict,
} from './concurrency/scratch-database-guard'

/**
 * o3d-zzgp round 4 (Codex HIGH-2) and round 5. The guard establishes "this database was
 * created for this run and is disposable" from one of two pieces of evidence — an explicit
 * declaration naming the exact database, or the local `ims_scratch_*` convention — and
 * refuses this estate's own databases however they are declared.
 */

test('refuses the live-served development database even when it is named in the opt-in', () => {
  const verdict = scratchDatabaseVerdict({ connectedDatabase: 'onetwo3d_ims_dev', optIn: 'onetwo3d_ims_dev' })
  assert.equal(verdict.ok, false)
  assert.match(verdict.ok === false ? verdict.reason : '', /no value of IMS_CONCURRENCY_SCRATCH_DB makes one of these acceptable/)
})

test('refuses every real or production-shaped database, declared or not', () => {
  for (const name of [
    'onetwo3d_ims_dev', 'onetwo3d_ims_e2e', 'onetwo3d_ims', 'onetwo3d_ims_onboarding_20260419',
    'postgres', 'template0', 'template1',
    'ims_prod', 'production', 'prod_ims', 'ims_live', 'live_ims',
  ]) {
    assert.equal(scratchDatabaseVerdict({ connectedDatabase: name, optIn: name }).ok, false, `${name} must be refused when declared`)
    assert.equal(scratchDatabaseVerdict({ connectedDatabase: name, optIn: undefined }).ok, false, `${name} must be refused undeclared`)
    assert.equal(ALWAYS_REFUSED_DATABASE.test(name), true, `${name} must be in the always-refused set`)
  }
})

test('refuses a database it cannot tell about: no declaration and no scratch-shaped name', () => {
  // `ims_ci` is CI's own disposable database — acceptable ONLY once the run declares it.
  assert.equal(scratchDatabaseVerdict({ connectedDatabase: 'ims_ci', optIn: undefined }).ok, false)
  assert.equal(scratchDatabaseVerdict({ connectedDatabase: 'ims_ci', optIn: 'ims_scratch_other' }).ok, false)
  assert.equal(scratchDatabaseVerdict({ connectedDatabase: 'ims_e2e', optIn: undefined }).ok, false)
  assert.equal(scratchDatabaseVerdict({ connectedDatabase: 'ims_acctmoney_conc', optIn: undefined }).ok, false)
})

test('accepts a database the run declares by its exact name (the CI shape)', () => {
  assert.deepEqual(scratchDatabaseVerdict({ connectedDatabase: 'ims_ci', optIn: 'ims_ci' }), { ok: true })
  assert.equal(SCRATCH_DATABASE_OPT_IN_ENV, 'IMS_CONCURRENCY_SCRATCH_DB')
})

test('accepts the local scratch convention with nothing exported, and still wants an exact match otherwise', () => {
  assert.deepEqual(scratchDatabaseVerdict({ connectedDatabase: 'ims_scratch_zzgp_r5_1789', optIn: undefined }), { ok: true })
  assert.deepEqual(
    scratchDatabaseVerdict({ connectedDatabase: 'ims_scratch_zzgp_r5_1789', optIn: 'ims_scratch_zzgp_r5_1789' }),
    { ok: true },
  )
  // A scratch-named database is fine on its name alone, so a wrong opt-in does not veto it;
  // what an opt-in can never do is admit something in the always-refused set above.
  assert.deepEqual(scratchDatabaseVerdict({ connectedDatabase: 'ims_scratch_a', optIn: 'ims_scratch_b' }), { ok: true })
})
