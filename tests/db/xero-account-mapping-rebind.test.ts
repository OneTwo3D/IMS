import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import {
  XERO_ACCOUNT_MAPPING_KEYS,
  XERO_ACCOUNT_MAPPING_TENANT_KEY,
  confirmMappingOwnership,
  gateMappingSave,
  readMappingOwnership,
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

const DERIVED = ['xero_tax_rate_drift_current', 'xero_tax_rate_drift_last_checked_at']

/** A clean slate, then a full mapping: settings, tax types on real rate rows, a cached chart row, sync on. */
async function seedMapping(tx: Tx, owner: string, stampedFor: string | null, run: string) {
  await tx.setting.deleteMany({ where: { key: { in: [...XERO_ACCOUNT_MAPPING_KEYS, ...DERIVED, 'xero_sync_enabled', XERO_ACCOUNT_MAPPING_TENANT_KEY] } } })
  await tx.accountingToken.deleteMany({ where: { connector: 'xero' } })
  for (const key of XERO_ACCOUNT_MAPPING_KEYS) {
    const value = key === 'accounting_payment_account_map' ? JSON.stringify({ 'card:GBP': `bank-${owner}` }) : `code-${owner}-${key}`
    await tx.setting.create({ data: { key, value } })
  }
  for (const key of DERIVED) await tx.setting.create({ data: { key, value: `derived-${owner}` } })
  await tx.setting.create({ data: { key: 'xero_sync_enabled', value: 'true' } })
  if (stampedFor) await tx.setting.create({ data: { key: XERO_ACCOUNT_MAPPING_TENANT_KEY, value: stampedFor } })
  await tx.taxRate.updateMany({ data: { accountingTaxType: null } })
  const rate = await tx.taxRate.create({ data: { name: `j-${run}`, rate: '0.2', accountingTaxType: `OUTPUT-${owner}` } })
  await tx.taxRateComponent.create({ data: { taxRateId: rate.id, name: `c-${run}`, rate: '0.2', accountingTaxType: `COMP-${owner}` } })
  await tx.accountingAccount.deleteMany({ where: { connector: 'xero' } })
  await tx.accountingAccount.create({ data: { connector: 'xero', externalAccountId: `acc-${run}`, code: '200', name: 'Sales', type: 'REVENUE' } })
}

async function bindTo(tx: Tx, tenantId: string, tenantName = 'Bound Org') {
  await tx.accountingToken.create({ data: { connector: 'xero', accessToken: 'a', expiresAt: new Date(Date.now() + 3600_000), tenantId, tenantName } })
}

const counts = async (tx: Tx) => ({
  settings: (await tx.setting.findMany({ where: { key: { in: [...XERO_ACCOUNT_MAPPING_KEYS] } }, select: { key: true, value: true } }))
    .filter((r: { key: string; value: string }) => r.value.trim() !== '' && r.value.trim() !== '{}').length as number,
  derived: await tx.setting.count({ where: { key: { in: DERIVED } } }) as number,
  rateTypes: await tx.taxRate.count({ where: { accountingTaxType: { not: null } } }) as number,
  componentTypes: await tx.taxRateComponent.count({ where: { accountingTaxType: { not: null } } }) as number,
  chart: await tx.accountingAccount.count({ where: { connector: 'xero' } }) as number,
  sync: (await tx.setting.findUnique({ where: { key: 'xero_sync_enabled' } }))?.value as string | undefined,
  stamp: (await tx.setting.findUnique({ where: { key: XERO_ACCOUNT_MAPPING_TENANT_KEY } }))?.value as string | undefined,
})

test('o3d-6thk1 (real tables): KNOWN DIFFERENT organisation clears 18 mapping settings, derived drift, tax-type mappings, the cached chart and the toggle, nothing else', { skip }, async () => {
  const run = randomUUID().slice(0, 8)
  const observed = await withRollback(async (tx) => {
    await lockAccountingMappingSelection(tx, 'xero')
    await seedMapping(tx, `A-${run}`, `tenant-A-${run}`, run)
    await tx.setting.create({ data: { key: `unrelated_${run}`, value: 'keep' } })
    const before = await counts(tx)
    const previous = await readPreviousMappingOrganisation(tx, 'xero')
    const outcome = await resetAccountMappingForOrganisationChange(tx, { previous, newTenantId: `tenant-B-${run}`, connector: 'xero' })
    return { before, previous, outcome, after: await counts(tx), unrelated: (await tx.setting.findUnique({ where: { key: `unrelated_${run}` } }))?.value }
  })
  console.log(`# o3d-6thk1 db known-different: before=${JSON.stringify(observed.before)} after=${JSON.stringify(observed.after)} previous=${observed.previous.tenantId} (${observed.previous.basis})`)
  assert.equal(XERO_ACCOUNT_MAPPING_KEYS.length, 18, 'PRECONDITION: 15 roles + payment map + 2 reverse-charge types')
  assert.deepEqual([observed.before.settings, observed.before.derived, observed.before.rateTypes, observed.before.componentTypes, observed.before.chart], [18, 2, 1, 1, 1], 'PRECONDITION: all of it present before')
  assert.equal(observed.outcome.kind, 'cleared')
  assert.deepEqual([observed.after.settings, observed.after.derived, observed.after.rateTypes, observed.after.componentTypes, observed.after.chart], [0, 0, 0, 0, 0])
  assert.equal(observed.after.sync, undefined)
  assert.equal(observed.after.stamp, `tenant-B-${run}`)
  assert.equal(observed.unrelated, 'keep')
})

test('o3d-6thk1 (real tables): the SAME organisation changes nothing', { skip }, async () => {
  const run = randomUUID().slice(0, 8)
  const observed = await withRollback(async (tx) => {
    await lockAccountingMappingSelection(tx, 'xero')
    await seedMapping(tx, `A-${run}`, `tenant-A-${run}`, run)
    const previous = await readPreviousMappingOrganisation(tx, 'xero')
    const outcome = await resetAccountMappingForOrganisationChange(tx, { previous, newTenantId: `tenant-A-${run}`, connector: 'xero' })
    return { outcome, after: await counts(tx) }
  })
  assert.equal(observed.outcome.kind, 'none')
  assert.deepEqual([observed.after.settings, observed.after.rateTypes, observed.after.chart, observed.after.sync], [18, 1, 1, 'true'])
})

test('o3d-6thk1 (real tables): UNKNOWN provenance with a mapping keeps it, turns sync off, stamps nothing; confirmation then owns it (idempotently)', { skip }, async () => {
  const run = randomUUID().slice(0, 8)
  const observed = await withRollback(async (tx) => {
    await lockAccountingMappingSelection(tx, 'xero')
    await seedMapping(tx, `A-${run}`, null, run)
    const previous = await readPreviousMappingOrganisation(tx, 'xero')
    await bindTo(tx, `tenant-A-${run}`, `Org A ${run}`)
    const outcome = await resetAccountMappingForOrganisationChange(tx, { previous, newTenantId: `tenant-A-${run}`, connector: 'xero' })
    const after = await counts(tx)
    const before = await readMappingOwnership(tx, 'xero')
    const wrong = await confirmMappingOwnership(tx, { connector: 'xero', expectedTenantId: `someone-else-${run}` })
    const confirmed = await confirmMappingOwnership(tx, { connector: 'xero', expectedTenantId: `tenant-A-${run}` })
    const owned = await readMappingOwnership(tx, 'xero')
    const again = await confirmMappingOwnership(tx, { connector: 'xero', expectedTenantId: `tenant-A-${run}` })
    return { previous, outcome, after, before, wrong, confirmed, owned, again, stampAfter: (await counts(tx)).stamp }
  })
  console.log(`# o3d-6thk1 db unknown: previous=${observed.previous.basis}, outcome=${observed.outcome.kind}, kept settings=${observed.after.settings}, sync=${observed.after.sync}, stamp=${observed.after.stamp}, ownership ${observed.before.state} -> ${observed.owned.state}`)
  assert.equal(observed.previous.basis, 'unknown', 'PRECONDITION: no stamp and no token row')
  assert.equal(observed.outcome.kind, 'unconfirmed')
  assert.deepEqual([observed.after.settings, observed.after.rateTypes, observed.after.chart], [18, 1, 0], 'mapping kept; the unattributable chart CACHE cleared')
  assert.equal(observed.after.sync, undefined, 'sync off')
  assert.equal(observed.after.stamp, undefined, 'nothing stamped')
  assert.equal(observed.before.state, 'unconfirmed')
  assert.equal(observed.wrong.ok, false, 'a confirmation for a page rendered against another organisation is refused')
  assert.equal(observed.confirmed.ok && observed.confirmed.changed, true)
  assert.equal(observed.owned.state, 'owned')
  assert.equal(observed.stampAfter, `tenant-A-${run}`)
  assert.equal(observed.again.ok && observed.again.changed, false, 'idempotent')
})

test('o3d-6thk1 (real tables): the lock\'s own empty inventory/transit rows are not a mapping', { skip }, async () => {
  const run = randomUUID().slice(0, 8)
  const observed = await withRollback(async (tx) => {
    await tx.setting.deleteMany({ where: { key: { in: [...XERO_ACCOUNT_MAPPING_KEYS, ...DERIVED, 'xero_sync_enabled', XERO_ACCOUNT_MAPPING_TENANT_KEY] } } })
    await tx.taxRate.updateMany({ data: { accountingTaxType: null } })
    await tx.taxRateComponent.updateMany({ data: { accountingTaxType: null } })
    await lockAccountingMappingSelection(tx, 'xero') // materialises xero_inventory_account / xero_transit_account as ''
    const materialised = (await tx.setting.findMany({ where: { key: { in: [...XERO_ACCOUNT_MAPPING_KEYS] } } })).length as number
    await tx.setting.create({ data: { key: 'xero_sync_enabled', value: 'true' } })
    const outcome = await resetAccountMappingForOrganisationChange(tx, { previous: { tenantId: `tenant-A-${run}`, basis: 'stamp' }, newTenantId: `tenant-B-${run}`, connector: 'xero' })
    return { materialised, outcome, sync: (await tx.setting.findUnique({ where: { key: 'xero_sync_enabled' } }))?.value }
  })
  console.log(`# o3d-6thk1 db: rows materialised by the lock=${observed.materialised}`)
  assert.equal(observed.materialised, 2, 'PRECONDITION: the lock materialised exactly the two empty rows')
  assert.equal(observed.outcome.kind, 'none')
  assert.equal(observed.sync, 'true', 'nothing to clear, so the toggle is not touched')
})

test('o3d-6thk1 (real tables): a mapping SAVE is refused for a page rendered against another organisation, and stamps only when ownership is not in doubt', { skip }, async () => {
  const run = randomUUID().slice(0, 8)
  const observed = await withRollback(async (tx) => {
    await lockAccountingMappingSelection(tx, 'xero')
    // (a) owned: stamp == bound
    await seedMapping(tx, `A-${run}`, `tenant-B-${run}`, run)
    await bindTo(tx, `tenant-B-${run}`)
    const owned = await gateMappingSave(tx, { connector: 'xero', expectedTenantId: `tenant-B-${run}` })
    const staleTab = await gateMappingSave(tx, { connector: 'xero', expectedTenantId: `tenant-A-${run}` })
    const noPage = await gateMappingSave(tx, { connector: 'xero' })
    // (b) unconfirmed: a mapping with no stamp. A save cannot confirm values it did not write.
    await tx.setting.deleteMany({ where: { key: { in: [XERO_ACCOUNT_MAPPING_TENANT_KEY] } } })
    const unconfirmed = await gateMappingSave(tx, { connector: 'xero', expectedTenantId: `tenant-B-${run}` })
    // (c) nothing mapped yet, no stamp: the first save owns it.
    await tx.setting.deleteMany({ where: { key: { in: [...XERO_ACCOUNT_MAPPING_KEYS] } } })
    await tx.taxRate.updateMany({ data: { accountingTaxType: null } })
    await tx.taxRateComponent.updateMany({ data: { accountingTaxType: null } })
    const first = await gateMappingSave(tx, { connector: 'xero', expectedTenantId: `tenant-B-${run}` })
    return { owned, staleTab, noPage, unconfirmed, first }
  })
  console.log(`# o3d-6thk1 db save gate: owned=${JSON.stringify(observed.owned)} stale=${observed.staleTab.ok} unconfirmed=${JSON.stringify(observed.unconfirmed)} first=${JSON.stringify(observed.first)}`)
  assert.deepEqual(observed.owned, { ok: true, boundTenantId: `tenant-B-${run}`, stampAfterWrite: true })
  assert.equal(observed.staleTab.ok, false, 'a tab left open across a rebind cannot write the previous organisation\'s values')
  assert.equal(observed.noPage.ok, true)
  assert.deepEqual(observed.unconfirmed, { ok: true, boundTenantId: `tenant-B-${run}`, stampAfterWrite: false })
  assert.deepEqual(observed.first, { ok: true, boundTenantId: `tenant-B-${run}`, stampAfterWrite: true })
})

test('o3d-6thk1 (real tables): the HOLD is persisted, and a token row created while it is active is NEVER read as the mapping owner', { skip }, async () => {
  const run = randomUUID().slice(0, 8)
  const observed = await withRollback(async (tx) => {
    await lockAccountingMappingSelection(tx, 'xero')
    await seedMapping(tx, `A-${run}`, null, run)
    const holdRow = async () => (await tx.setting.findUnique({ where: { key: 'xero_account_mapping_unconfirmed' } }))?.value as string | undefined

    // First reconnect: no stamp, no token row -> unknown -> held.
    const previous1 = await readPreviousMappingOrganisation(tx, 'xero')
    await bindTo(tx, `tenant-A-${run}`, `Org A ${run}`)
    const first = await resetAccountMappingForOrganisationChange(tx, { previous: previous1, newTenantId: `tenant-A-${run}`, connector: 'xero' })
    const afterFirst = { hold: await holdRow(), counts: await counts(tx) }

    // Second consent to the SAME organisation, now with a token row that names it: used to stamp as owned.
    const previous2 = await readPreviousMappingOrganisation(tx, 'xero')
    const second = await resetAccountMappingForOrganisationChange(tx, { previous: previous2, newTenantId: `tenant-A-${run}`, connector: 'xero' })
    const afterSecond = { hold: await holdRow(), counts: await counts(tx) }

    // A consent to a DIFFERENT organisation while held: kept, not cleared (unknown is not proof).
    const previous3 = await readPreviousMappingOrganisation(tx, 'xero')
    const third = await resetAccountMappingForOrganisationChange(tx, { previous: previous3, newTenantId: `tenant-B-${run}`, connector: 'xero' })
    const afterThird = { hold: await holdRow(), counts: await counts(tx) }

    const ownershipHeld = await readMappingOwnership(tx, 'xero')
    const confirmed = await confirmMappingOwnership(tx, { connector: 'xero', expectedTenantId: `tenant-A-${run}` })
    const afterConfirm = { hold: await holdRow(), counts: await counts(tx), ownership: await readMappingOwnership(tx, 'xero') }
    return { previous1, first, afterFirst, previous2, second, afterSecond, previous3, third, afterThird, ownershipHeld, confirmed, afterConfirm }
  })
  console.log(`# o3d-6thk1 db hold: previous ${observed.previous1.basis} -> ${observed.previous2.basis} -> ${observed.previous3.basis}; outcomes ${observed.first.kind}/${observed.second.kind}/${observed.third.kind}; hold ${observed.afterFirst.hold}/${observed.afterSecond.hold}/${observed.afterThird.hold}`)
  assert.equal(observed.previous1.basis, 'unknown')
  assert.equal(observed.first.kind, 'unconfirmed')
  assert.equal(observed.afterFirst.hold, 'true', 'the hold is persisted')
  assert.equal(observed.previous2.basis, 'hold', 'with a token row now present the previous organisation is STILL the hold, not the token\'s tenant')
  assert.equal(observed.second.kind, 'unconfirmed')
  assert.equal(observed.afterSecond.counts.stamp, undefined, 'nothing stamped by the second consent')
  assert.equal(observed.afterSecond.counts.settings, 18)
  assert.equal(observed.third.kind, 'unconfirmed', 'a different organisation while held keeps the mapping too')
  assert.deepEqual([observed.afterThird.counts.settings, observed.afterThird.counts.rateTypes, observed.afterThird.counts.chart], [18, 1, 0])
  assert.equal(observed.afterThird.counts.stamp, undefined)
  assert.equal(observed.ownershipHeld.state, 'unconfirmed')
  assert.equal(observed.confirmed.ok, true)
  assert.equal(observed.afterConfirm.hold, undefined, 'only the confirmation ends the hold')
  assert.equal(observed.afterConfirm.counts.stamp, `tenant-A-${run}`)
  assert.equal(observed.afterConfirm.ownership.state, 'owned')
})

/**
 * ONE ROW PER BRANCH of resetAccountMappingForOrganisationChange, over EVERY store it can touch (Codex round 3:
 * the `!presence.any` branch returned before clearing the chart cache, and nothing noticed because each test
 * looked at the stores its own branch was about). A branch that skips a store now fails its own row.
 *
 *   previous   how the previous organisation is known: stamp | token (no stamp) | unknown | hold
 *   mapped     whether any mapping (roles, map, reverse-charge types, tax types) is saved
 *   to         'same' (the previous organisation) or 'other'
 * Stores, after: chart cache, tax types, reverse-charge types, drift snapshot, payment map, account roles,
 * sync toggle, stamp, hold.
 */
type Post = { chart: number; taxTypes: number; rcTypes: number; drift: number; payMap: number; roles: number; sync: string | undefined; stamp: 'prev' | 'new' | undefined; hold: boolean }
const KEPT_ALL = (mapped: boolean): Pick<Post, 'taxTypes' | 'rcTypes' | 'payMap' | 'roles'> => mapped ? { taxTypes: 2, rcTypes: 2, payMap: 1, roles: 15 } : { taxTypes: 0, rcTypes: 0, payMap: 0, roles: 0 }
const BRANCHES: Array<{ name: string; previous: 'stamp' | 'token' | 'unknown' | 'hold'; mapped: boolean; to: 'same' | 'other'; kind: string; expect: Post }> = [
  { name: 'known same (stamp), mapped', previous: 'stamp', mapped: true, to: 'same', kind: 'none', expect: { chart: 1, ...KEPT_ALL(true), drift: 2, sync: 'true', stamp: 'prev', hold: false } },
  { name: 'known same (token row), mapped', previous: 'token', mapped: true, to: 'same', kind: 'none', expect: { chart: 1, ...KEPT_ALL(true), drift: 2, sync: 'true', stamp: 'prev', hold: false } },
  { name: 'known same (stamp), nothing mapped', previous: 'stamp', mapped: false, to: 'same', kind: 'none', expect: { chart: 1, ...KEPT_ALL(false), drift: 2, sync: 'true', stamp: 'prev', hold: false } },
  { name: 'known different (stamp), mapped', previous: 'stamp', mapped: true, to: 'other', kind: 'cleared', expect: { chart: 0, taxTypes: 0, rcTypes: 0, payMap: 0, roles: 0, drift: 0, sync: undefined, stamp: 'new', hold: false } },
  { name: 'known different (token row), mapped', previous: 'token', mapped: true, to: 'other', kind: 'cleared', expect: { chart: 0, taxTypes: 0, rcTypes: 0, payMap: 0, roles: 0, drift: 0, sync: undefined, stamp: 'new', hold: false } },
  { name: 'known different (stamp), NOTHING mapped (round-3 HIGH)', previous: 'stamp', mapped: false, to: 'other', kind: 'none', expect: { chart: 0, ...KEPT_ALL(false), drift: 0, sync: 'true', stamp: 'new', hold: false } },
  { name: 'known different (token row), NOTHING mapped', previous: 'token', mapped: false, to: 'other', kind: 'none', expect: { chart: 0, ...KEPT_ALL(false), drift: 0, sync: 'true', stamp: 'new', hold: false } },
  { name: 'unknown, mapped', previous: 'unknown', mapped: true, to: 'same', kind: 'unconfirmed', expect: { chart: 0, ...KEPT_ALL(true), drift: 0, sync: undefined, stamp: undefined, hold: true } },
  { name: 'hold, mapped (second consent, same organisation)', previous: 'hold', mapped: true, to: 'same', kind: 'unconfirmed', expect: { chart: 0, ...KEPT_ALL(true), drift: 0, sync: undefined, stamp: undefined, hold: true } },
  { name: 'hold, mapped (different organisation)', previous: 'hold', mapped: true, to: 'other', kind: 'unconfirmed', expect: { chart: 0, ...KEPT_ALL(true), drift: 0, sync: undefined, stamp: undefined, hold: true } },
  { name: 'unknown, NOTHING mapped (round-3 HIGH)', previous: 'unknown', mapped: false, to: 'other', kind: 'none', expect: { chart: 0, ...KEPT_ALL(false), drift: 0, sync: 'true', stamp: 'new', hold: false } },
  { name: 'hold, mapping gone: the hold is retired', previous: 'hold', mapped: false, to: 'other', kind: 'none', expect: { chart: 0, ...KEPT_ALL(false), drift: 0, sync: 'true', stamp: 'new', hold: false } },
]

test('o3d-6thk1 (real tables): EVERY branch x EVERY store, table-driven', { skip }, async () => {
  const run = randomUUID().slice(0, 8)
  const results: Array<{ name: string; kind: string; pre: Post; post: Post }> = []
  for (const branch of BRANCHES) {
    const prevT = `tenant-P-${run}`
    const newT = branch.to === 'same' ? prevT : `tenant-N-${run}`
    const observed = await withRollback(async (tx) => {
      await lockAccountingMappingSelection(tx, 'xero')
      // A clean slate, then every store populated; mapping stores only when `mapped`.
      await tx.setting.deleteMany({ where: { key: { in: [...XERO_ACCOUNT_MAPPING_KEYS, ...DERIVED, 'xero_sync_enabled', XERO_ACCOUNT_MAPPING_TENANT_KEY, 'xero_account_mapping_unconfirmed'] } } })
      await tx.accountingToken.deleteMany({ where: { connector: 'xero' } })
      await tx.taxRate.updateMany({ data: { accountingTaxType: null } })
      await tx.taxRateComponent.updateMany({ data: { accountingTaxType: null } })
      await tx.accountingAccount.deleteMany({ where: { connector: 'xero' } })
      if (branch.mapped) {
        for (const key of XERO_ACCOUNT_MAPPING_KEYS) await tx.setting.create({ data: { key, value: key === 'accounting_payment_account_map' ? '{"card:GBP":"b"}' : `v-${key}` } })
        const rate = await tx.taxRate.create({ data: { name: `t-${run}`, rate: '0.2', accountingTaxType: 'OUT' } })
        await tx.taxRateComponent.create({ data: { taxRateId: rate.id, name: 'c', rate: '0.2', accountingTaxType: 'COMP' } })
      }
      for (const key of DERIVED) await tx.setting.create({ data: { key, value: 'd' } })
      await tx.setting.create({ data: { key: 'xero_sync_enabled', value: 'true' } })
      await tx.accountingAccount.create({ data: { connector: 'xero', externalAccountId: `acc-${run}`, code: '200', name: 'Sales', type: 'REVENUE' } })
      if (branch.previous === 'stamp') await tx.setting.create({ data: { key: XERO_ACCOUNT_MAPPING_TENANT_KEY, value: prevT } })
      if (branch.previous === 'hold') await tx.setting.create({ data: { key: 'xero_account_mapping_unconfirmed', value: 'true' } })
      if (branch.previous === 'token') await bindTo(tx, prevT)

      const snapshot = async (): Promise<Post> => {
        const roleKeys = XERO_ACCOUNT_MAPPING_KEYS.filter((k) => k.startsWith('xero_') && k.endsWith('_account'))
        const rows = await tx.setting.findMany({ where: { key: { in: [...XERO_ACCOUNT_MAPPING_KEYS, ...DERIVED, 'xero_sync_enabled', XERO_ACCOUNT_MAPPING_TENANT_KEY, 'xero_account_mapping_unconfirmed'] } } }) as Array<{ key: string; value: string }>
        const has = (k: string) => rows.some((r) => r.key === k && r.value.trim() !== '' && r.value.trim() !== '{}')
        const stamp = rows.find((r) => r.key === XERO_ACCOUNT_MAPPING_TENANT_KEY)?.value
        return {
          chart: await tx.accountingAccount.count({ where: { connector: 'xero' } }) as number,
          taxTypes: (await tx.taxRate.count({ where: { accountingTaxType: { not: null } } }) as number) + (await tx.taxRateComponent.count({ where: { accountingTaxType: { not: null } } }) as number),
          rcTypes: rows.filter((r) => r.key.startsWith('accounting_reverse_charge') && has(r.key)).length,
          drift: rows.filter((r) => DERIVED.includes(r.key)).length,
          payMap: has('accounting_payment_account_map') ? 1 : 0,
          roles: roleKeys.filter(has).length,
          sync: rows.find((r) => r.key === 'xero_sync_enabled')?.value,
          stamp: stamp === undefined ? undefined : (stamp === prevT ? 'prev' : 'new'),
          hold: rows.some((r) => r.key === 'xero_account_mapping_unconfirmed' && r.value === 'true'),
        }
      }
      const pre = await snapshot()
      const previous = await readPreviousMappingOrganisation(tx, 'xero')
      const outcome = await resetAccountMappingForOrganisationChange(tx, { previous, newTenantId: newT, connector: 'xero' })
      return { pre, previous, outcome, post: await snapshot() }
    })
    results.push({ name: branch.name, kind: observed.outcome.kind, pre: observed.pre, post: observed.post })
    assert.equal(observed.previous.basis, branch.previous, `${branch.name}: PRECONDITION: the previous organisation is known by ${branch.previous}`)
    assert.equal(observed.pre.chart, 1, `${branch.name}: PRECONDITION: a chart is cached`)
    assert.equal(observed.pre.drift, 2, `${branch.name}: PRECONDITION: a drift snapshot exists`)
    assert.equal(observed.pre.sync, 'true', `${branch.name}: PRECONDITION: sync is on`)
    assert.equal(observed.pre.roles, branch.mapped ? 15 : 0, `${branch.name}: PRECONDITION: mapping ${branch.mapped ? 'present' : 'absent'}`)
    assert.equal(observed.outcome.kind, branch.kind, `${branch.name}: outcome`)
    assert.deepEqual(observed.post, branch.expect, `${branch.name}: post-state of every store`)
  }
  console.log(`# o3d-6thk1 branch x store: ${results.length} branches\n${results.map((r) => `#   ${r.name}: ${r.kind} -> ${JSON.stringify(r.post)}`).join('\n')}`)
  assert.equal(results.length, BRANCHES.length)
})
