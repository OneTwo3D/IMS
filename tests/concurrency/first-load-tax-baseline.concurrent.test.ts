import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * THE FIRST LOAD'S TAX BASELINE IS ONE POINT-IN-TIME VIEW. Both tax tables are read, and the fact written, in one REPEATABLE READ transaction (attribution.ts captureTaxBaseline), so a
 * component edited while the capture runs is either entirely in the baseline (committed before the snapshot) or counted as foreign afterwards: never absorbed as the starting value.
 */
const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
config({ path: '.env.local', quiet: true })
config({ quiet: true })
const TAG = `ZQTB${randomUUID().slice(0, 8)}`

// [mutation: the two reads taken outside one snapshot transaction (pooled client, no isolation level) -> the edited-mid-capture arm is red]
test('a component edited between the capture\'s two reads is counted as foreign, never absorbed; one edited before the capture is in the baseline', { skip: !RUN }, async () => {
  const [{ db }, attribution] = await Promise.all([import('../../lib/db/index.ts'), import('../../lib/first-load/apply/db/attribution.ts')])
  const holds = async () => attribution.ATTRIBUTION_RULES.tax_rate_components!({} as never)
  const reset = async () => { await db.$executeRaw`DELETE FROM first_load_apply_runs` }
  const cleanup = async () => { await reset(); await db.taxRateComponent.deleteMany({ where: { name: { startsWith: TAG } } }); await db.taxRate.deleteMany({ where: { name: { startsWith: TAG } } }) }
  const startRun = async () => { await db.$executeRaw`INSERT INTO first_load_apply_runs (id, singleton, version, manifest_digest, run_id, status, steps, facts) VALUES (${`r-${TAG}`}, true, 1, ${'f'.repeat(64)}, 'tb', 'RUNNING', '{}'::jsonb, '{}'::jsonb)` }
  try {
    await cleanup()
    const rate = await db.taxRate.create({ data: { name: `${TAG} rate`, rate: '0.2', usedFor: 'BOTH', active: true } })
    const comp = await db.taxRateComponent.create({ data: { taxRateId: rate.id, name: `${TAG} c`, rate: '0.2', sortOrder: 0 } })
    const edit = (value: string) => db.$executeRaw`UPDATE tax_rate_components SET rate = ${value}::numeric WHERE id = ${comp.id}`
    // Edited BEFORE the snapshot: it is the starting state.
    await startRun()
    await edit('0.1')
    assert.equal(await attribution.captureTaxBaseline(), true)
    assert.equal(await holds(), 0, 'before the snapshot: in the baseline')
    // Edited AFTER the rates were read, before the components were: outside the snapshot, so foreign.
    await reset(); await startRun(); await edit('0.2')
    let edited = false
    assert.equal(await attribution.captureTaxBaseline(async () => { await edit('0.3'); edited = true }), true)
    assert.equal(edited, true, 'control: the edit ran between the reads')
    assert.equal(await holds(), 2, 'after the snapshot: counted (new content and missing old content), not absorbed')
  } finally { await cleanup() }
})
