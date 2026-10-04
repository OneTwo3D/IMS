import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import {
  XERO_ACCOUNT_MAPPING_KEYS,
  XERO_ACCOUNT_MAPPING_TENANT_KEY,
  readPreviousMappingOrganisation,
  resetAccountMappingForOrganisationChange,
} from '../../lib/connectors/xero/account-mapping-rebind'
import { lockAccountingMappingSelection } from '../../lib/integration-plugin-selection-lock'

/**
 * o3d-6thk1 — THE REBIND RULE AGAINST A REAL `settings` TABLE.
 *
 * The doubled tests (tests/connectors/xero-connect-tenant-guard.test.ts) prove the callback path. What a
 * double cannot show is the statements themselves: the real mapping lock (which MATERIALISES the
 * inventory and transit rows as empty strings, so "an empty row is not a mapping" is load-bearing), a
 * real `DELETE ... WHERE key IN`, and the primary key under the stamp. ROLLED BACK, ALWAYS.
 *
 * GATED on RUN_DB_RETENTION_TESTS with the REQUIRE_DB_RETENTION_TESTS tripwire (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error(
    'REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in '
    + 'tests/db/xero-account-mapping-rebind.test.ts would have been skipped in an environment that '
    + 'promised a migrated database. Fix the invocation (npm run test:db).',
  )
}

class RollbackProbe extends Error {}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any

async function withRollback<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('../../lib/db')
  let captured: T | undefined
  try {
    await db.$transaction(async (tx: unknown) => {
      captured = await fn(tx as Tx)
      throw new RollbackProbe()
    }, { timeout: 60_000, maxWait: 30_000 })
  } catch (error) {
    if (!(error instanceof RollbackProbe)) throw error
  }
  return captured as T
}

async function seedMapping(tx: Tx, owner: string, stampedFor: string | null) {
  await tx.setting.deleteMany({ where: { key: { in: [...XERO_ACCOUNT_MAPPING_KEYS, 'xero_sync_enabled', XERO_ACCOUNT_MAPPING_TENANT_KEY] } } })
  for (const key of XERO_ACCOUNT_MAPPING_KEYS) {
    const value = key === 'accounting_payment_account_map' ? JSON.stringify({ 'card:GBP': `bank-${owner}` }) : `code-${owner}-${key}`
    await tx.setting.create({ data: { key, value } })
  }
  await tx.setting.create({ data: { key: 'xero_sync_enabled', value: 'true' } })
  if (stampedFor) await tx.setting.create({ data: { key: XERO_ACCOUNT_MAPPING_TENANT_KEY, value: stampedFor } })
}

const rowsLeft = async (tx: Tx) =>
  (await tx.setting.findMany({ where: { key: { in: [...XERO_ACCOUNT_MAPPING_KEYS] } }, select: { key: true } })).length as number

test('o3d-6thk1 (real table): a different organisation clears all sixteen mapping rows and the sync toggle, nothing else', async () => {
  const run = randomUUID().slice(0, 8)
  const observed = await withRollback(async (tx) => {
    await lockAccountingMappingSelection(tx, 'xero')
    await seedMapping(tx, `A-${run}`, `tenant-A-${run}`)
    await tx.setting.create({ data: { key: `unrelated_${run}`, value: 'keep' } })
    const before = await rowsLeft(tx)
    const previous = await readPreviousMappingOrganisation(tx, 'xero')
    const outcome = await resetAccountMappingForOrganisationChange(tx, { previous, newTenantId: `tenant-B-${run}` })
    return {
      before, previous, outcome, after: await rowsLeft(tx),
      sync: await tx.setting.findUnique({ where: { key: 'xero_sync_enabled' } }),
      stamp: (await tx.setting.findUnique({ where: { key: XERO_ACCOUNT_MAPPING_TENANT_KEY } }))?.value,
      unrelated: (await tx.setting.findUnique({ where: { key: `unrelated_${run}` } }))?.value,
    }
  })
  console.log(`# o3d-6thk1 db: mapping keys=${XERO_ACCOUNT_MAPPING_KEYS.length}, rows before=${observed.before}, after=${observed.after}, previous=${observed.previous.tenantId} (${observed.previous.basis})`)
  assert.equal(XERO_ACCOUNT_MAPPING_KEYS.length, 16, 'PRECONDITION: fifteen roles plus the payment map')
  assert.equal(observed.before, 16, 'PRECONDITION: all present before')
  assert.equal(observed.previous.tenantId, `tenant-A-${run}`)
  assert.equal(observed.outcome.reset, true)
  assert.equal(observed.after, 0)
  assert.equal(observed.sync, null)
  assert.equal(observed.stamp, `tenant-B-${run}`)
  assert.equal(observed.unrelated, 'keep')
})

test('o3d-6thk1 (real table): the SAME organisation changes nothing', async () => {
  const run = randomUUID().slice(0, 8)
  const observed = await withRollback(async (tx) => {
    await lockAccountingMappingSelection(tx, 'xero')
    await seedMapping(tx, `A-${run}`, `tenant-A-${run}`)
    const previous = await readPreviousMappingOrganisation(tx, 'xero')
    const outcome = await resetAccountMappingForOrganisationChange(tx, { previous, newTenantId: `tenant-A-${run}` })
    return { outcome, after: await rowsLeft(tx), sync: (await tx.setting.findUnique({ where: { key: 'xero_sync_enabled' } }))?.value }
  })
  assert.equal(observed.outcome.reset, false)
  assert.equal(observed.after, 16)
  assert.equal(observed.sync, 'true')
})

test('o3d-6thk1 (real table): the lock\'s own empty inventory/transit rows are not a mapping', async () => {
  const run = randomUUID().slice(0, 8)
  const observed = await withRollback(async (tx) => {
    await tx.setting.deleteMany({ where: { key: { in: [...XERO_ACCOUNT_MAPPING_KEYS, 'xero_sync_enabled', XERO_ACCOUNT_MAPPING_TENANT_KEY] } } })
    await lockAccountingMappingSelection(tx, 'xero') // materialises xero_inventory_account / xero_transit_account as ''
    const materialised = await rowsLeft(tx)
    await tx.setting.create({ data: { key: 'xero_sync_enabled', value: 'true' } })
    const outcome = await resetAccountMappingForOrganisationChange(tx, { previous: { tenantId: `tenant-A-${run}`, basis: 'stamp' }, newTenantId: `tenant-B-${run}` })
    return { materialised, outcome, sync: (await tx.setting.findUnique({ where: { key: 'xero_sync_enabled' } }))?.value }
  })
  console.log(`# o3d-6thk1 db: rows materialised by the lock=${observed.materialised}`)
  assert.equal(observed.materialised, 2, 'PRECONDITION: the lock materialised exactly the two empty rows')
  assert.equal(observed.outcome.reset, false)
  assert.equal(observed.sync, 'true', 'nothing to clear, so the toggle is not touched')
})
