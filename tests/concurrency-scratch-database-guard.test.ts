import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  SCRATCH_DATABASE_OPT_IN_ENV,
  scratchDatabaseVerdict,
} from './concurrency/scratch-database-guard'

/**
 * o3d-zzgp round 4, Codex HIGH-2: the scratch-database guard is an ALLOWLIST with two
 * halves. Each refusal below is a database round 3's name-only check would have let a
 * test seed and install DDL into — except the first, which it would have refused only
 * AFTER seeding.
 */

test('refuses the live-served development database even when it is named in the opt-in', () => {
  const verdict = scratchDatabaseVerdict({ connectedDatabase: 'onetwo3d_ims_dev', optIn: 'onetwo3d_ims_dev' })
  assert.equal(verdict.ok, false)
})

test('refuses any other shared database round 3 would have let through', () => {
  for (const name of ['onetwo3d_ims_e2e', 'ims_e2e', 'postgres', 'onetwo3d_ims', 'ims_acctmoney_conc']) {
    const verdict = scratchDatabaseVerdict({ connectedDatabase: name, optIn: name })
    assert.equal(verdict.ok, false, `${name} must be refused`)
  }
})

test('refuses a scratch-named database the operator did not name', () => {
  assert.equal(scratchDatabaseVerdict({ connectedDatabase: 'ims_scratch_zzgp_r4', optIn: undefined }).ok, false)
  assert.equal(scratchDatabaseVerdict({ connectedDatabase: 'ims_scratch_zzgp_r4', optIn: '1' }).ok, false)
  assert.equal(scratchDatabaseVerdict({ connectedDatabase: 'ims_scratch_zzgp_r4', optIn: 'ims_scratch_other' }).ok, false)
})

test('accepts only a scratch-named database named exactly in the opt-in', () => {
  assert.deepEqual(
    scratchDatabaseVerdict({ connectedDatabase: 'ims_scratch_zzgp_r4_1789', optIn: 'ims_scratch_zzgp_r4_1789' }),
    { ok: true },
  )
  assert.equal(SCRATCH_DATABASE_OPT_IN_ENV, 'IMS_CONCURRENCY_SCRATCH_DB')
})
