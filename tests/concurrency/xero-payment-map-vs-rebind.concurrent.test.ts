import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, mock } from 'node:test'
import { config } from 'dotenv'

import { backendPid, waitUntilParkedBehind } from '../helpers/lock-wait-observer'

/**
 * o3d-6thk1 round 1 (Codex MEDIUM) — A PAYMENT-MAP SAVE AROUND A REBIND MUST NOT PUT THE PREVIOUS
 * ORGANISATION'S MAP BACK.
 *
 * `savePaymentAccountMap` used to be a bare upsert with no lock, so a save that started around the
 * binding could commit AFTER the binding had cleared `accounting_payment_account_map`, restoring bank
 * account ids chosen for the old organisation. It now takes the mapping lock the binding takes, and
 * refuses a page rendered against a different organisation.
 *
 * REAL POSTGRES, REAL SERVER ACTION, NO SLEEPS. The binding side is a transaction that does exactly the
 * mapping part of `bindXeroTenant` (lock, read the previous organisation, write the new token row, apply
 * the reset) and is then HELD OPEN; the save is observed PARKED behind it through
 * pg_stat_activity/pg_blocking_pids (tests/helpers/lock-wait-observer.ts) before the binding commits.
 *
 * ARMS: (1) save composed for the OLD organisation parks behind the binding, then is REFUSED and the map
 * stays cleared; (2) ISOLATING arm: the same save WITHOUT the page's organisation parks behind the lock
 * too but is accepted, and the old map comes back — so it is the organisation check, not the ordering,
 * that stops (1), and the arm shows the rig can see the restore; (3) a save composed for the NEW
 * organisation is accepted and owned by it; (4) a save that finished first is cleared by the binding.
 */
const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const TX = { timeout: 30_000, maxWait: 20_000 }

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireFreshPermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    freshAuthFailureResult: () => null,
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })

config({ path: '.env.local', quiet: true })
config({ quiet: true })

const MAP_KEY = 'accounting_payment_account_map'
const STAMP_KEY = 'xero_account_mapping_tenant_id'

async function loadDeps() {
  const [{ db }, rebind, lock, accounting] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../lib/connectors/xero/account-mapping-rebind.ts'),
    import('../../lib/integration-plugin-selection-lock.ts'),
    import('../../app/actions/accounting.ts'),
  ])
  return { db, rebind, lock, savePaymentAccountMap: accounting.savePaymentAccountMap }
}
type Deps = Awaited<ReturnType<typeof loadDeps>>

const oldMap = (run: string) => JSON.stringify({ 'card:GBP': `OLD-ORG-BANK-${run}` })

async function wipe(db: Deps['db']) {
  await db.setting.deleteMany({ where: { key: { in: [MAP_KEY, STAMP_KEY, 'xero_sync_enabled', 'xero_sales_account', 'xero_shipping_account', 'xero_discount_account', 'xero_transit_account', 'xero_inventory_account', 'xero_allocated_inventory_account', 'xero_cogs_account', 'xero_unearned_revenue_account', 'xero_accounts_receivable_account', 'xero_accounts_payable_account', 'xero_realised_fx_gain_loss_account', 'xero_unrealised_fx_gain_loss_account'] } } })
  await db.accountingToken.deleteMany({ where: { connector: 'xero' } })
}

/** An instance bound to org A with A's map, stamped as A's, sync on. */
async function seedBoundTo(db: Deps['db'], tenantA: string, run: string) {
  await wipe(db)
  await db.accountingToken.create({ data: { connector: 'xero', accessToken: 'a', expiresAt: new Date(Date.now() + 3600_000), tenantId: tenantA, tenantName: `Org A ${run}` } })
  await db.setting.create({ data: { key: MAP_KEY, value: oldMap(run) } })
  await db.setting.create({ data: { key: STAMP_KEY, value: tenantA } })
  await db.setting.create({ data: { key: 'xero_sync_enabled', value: 'true' } })
}

/** The mapping part of bindXeroTenant, held open until `release()` is called. Resolves with how to finish it. */
async function startBinding(deps: Deps, tenantB: string, run: string) {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let pid = 0
  let held!: () => void
  const heldPromise = new Promise<void>((resolve) => { held = resolve })
  const done = deps.db.$transaction(async (tx) => {
    pid = await backendPid(tx as never)
    await deps.lock.lockAccountingMappingSelection(tx as never, 'xero')
    const previous = await deps.rebind.readPreviousMappingOrganisation(tx as never, 'xero')
    await tx.accountingToken.upsert({
      where: { connector: 'xero' },
      create: { connector: 'xero', accessToken: 'b', expiresAt: new Date(Date.now() + 3600_000), tenantId: tenantB, tenantName: `Org B ${run}` },
      update: { tenantId: tenantB, tenantName: `Org B ${run}` },
    })
    const outcome = await deps.rebind.resetAccountMappingForOrganisationChange(tx as never, { previous, newTenantId: tenantB, connector: 'xero' })
    held()
    await gate
    return outcome
  }, TX)
  await heldPromise
  return { pid, release, done }
}

const mapNow = async (db: Deps['db']) => (await db.setting.findUnique({ where: { key: MAP_KEY } }))?.value ?? null
const stampNow = async (db: Deps['db']) => (await db.setting.findUnique({ where: { key: STAMP_KEY } }))?.value ?? null

after(async () => {
  if (!RUN) return
  const { db } = await loadDeps()
  await wipe(db)
})

test('[o3d-6thk1] a save composed for the OLD organisation parks behind the binding, is refused, and the map stays cleared', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const run = randomUUID().slice(0, 8)
  const [A, B] = [`tenant-A-${run}`, `tenant-B-${run}`]
  await seedBoundTo(deps.db, A, run)
  assert.equal(await mapNow(deps.db), oldMap(run), 'PRECONDITION: the old organisation\'s map is stored')

  const binding = await startBinding(deps, B, run)
  const save = deps.savePaymentAccountMap(oldMap(run), A)
  const parked = await waitUntilParkedBehind(deps.db as never, { holderPid: binding.pid, waitingOn: /pg_advisory_xact_lock/, describe: 'savePaymentAccountMap vs the binding' })
  console.log(`# o3d-6thk1 race: save parked behind binding pid ${binding.pid} (observed after ${parked.observedAfterMs}ms), map during hold=${await mapNow(deps.db)}`)
  binding.release()
  const outcome = await binding.done
  const result = await save

  assert.equal(outcome.kind, 'cleared', 'PRECONDITION: the binding cleared the old organisation\'s mapping')
  assert.equal(result.success, false, 'the save for the old organisation is refused')
  assert.equal(await mapNow(deps.db), null, 'and the previous organisation\'s map did NOT come back')
  assert.equal(await stampNow(deps.db), B)
})

test('[o3d-6thk1] ISOLATING: the same save with NO page organisation also parks, but is accepted and restores the old map (the organisation check is what refuses)', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const run = randomUUID().slice(0, 8)
  const [A, B] = [`tenant-A-${run}`, `tenant-B-${run}`]
  await seedBoundTo(deps.db, A, run)
  const binding = await startBinding(deps, B, run)
  const save = deps.savePaymentAccountMap(oldMap(run))
  await waitUntilParkedBehind(deps.db as never, { holderPid: binding.pid, waitingOn: /pg_advisory_xact_lock/, describe: 'unscoped save vs the binding' })
  binding.release()
  await binding.done
  const result = await save

  assert.equal(result.success, true)
  assert.equal(await mapNow(deps.db), oldMap(run), 'ordering alone does not stop a stale value: it is written after the clear')
})

test('[o3d-6thk1] a save composed for the NEW organisation is accepted after the binding and is owned by it', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const run = randomUUID().slice(0, 8)
  const [A, B] = [`tenant-A-${run}`, `tenant-B-${run}`]
  await seedBoundTo(deps.db, A, run)
  const binding = await startBinding(deps, B, run)
  const newMap = JSON.stringify({ 'card:GBP': `NEW-ORG-BANK-${run}` })
  const save = deps.savePaymentAccountMap(newMap, B)
  await waitUntilParkedBehind(deps.db as never, { holderPid: binding.pid, waitingOn: /pg_advisory_xact_lock/, describe: 'new-organisation save vs the binding' })
  binding.release()
  await binding.done
  const result = await save

  assert.equal(result.success, true)
  assert.equal(await mapNow(deps.db), newMap)
  assert.equal(await stampNow(deps.db), B, 'owned by the bound organisation')
})

test('[o3d-6thk1] a save that FINISHED before the binding is cleared by it', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const run = randomUUID().slice(0, 8)
  const [A, B] = [`tenant-A-${run}`, `tenant-B-${run}`]
  await seedBoundTo(deps.db, A, run)
  const edited = JSON.stringify({ 'card:GBP': `EDITED-A-${run}` })
  const result = await deps.savePaymentAccountMap(edited, A)
  assert.equal(result.success, true, 'PRECONDITION: the save for the bound organisation is accepted')
  assert.equal(await mapNow(deps.db), edited)

  const binding = await startBinding(deps, B, run)
  binding.release()
  const outcome = await binding.done

  assert.equal(outcome.kind, 'cleared')
  assert.equal(await mapNow(deps.db), null)
})

test('[o3d-6thk1] READINESS: an unstamped mapping on a bound organisation reports unconfirmed until the audited confirmation, which records who', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const run = randomUUID().slice(0, 8)
  const A = `tenant-A-${run}`
  await seedBoundTo(deps.db, A, run)
  await deps.db.setting.delete({ where: { key: STAMP_KEY } })
  const { getXeroSyncReadiness, confirmXeroAccountMappingOwnership } = await import('../../app/actions/xero-sync.ts')

  const before = await getXeroSyncReadiness()
  console.log(`# o3d-6thk1 readiness before confirm: state=${before.mappingOwnership.state}, bound=${before.mappingOwnership.boundTenantName}`)
  assert.equal(before.mappingOwnership.state, 'unconfirmed')
  const wrongPage = await confirmXeroAccountMappingOwnership(`someone-else-${run}`)
  assert.equal(wrongPage.success, false, 'a confirmation made on a page for another organisation is refused')
  assert.equal(await stampNow(deps.db), null)

  const confirmed = await confirmXeroAccountMappingOwnership(A)
  assert.equal(confirmed.success, true)
  const after = await getXeroSyncReadiness()
  assert.equal(after.mappingOwnership.state, 'owned')
  assert.equal(await stampNow(deps.db), A)
  const logged = await deps.db.activityLog.findFirst({ where: { action: 'xero_account_mapping_confirmed' }, orderBy: { createdAt: 'desc' }, select: { entityId: true, metadata: true } })
  assert.equal(logged?.entityId, 'test-user', 'who')
  assert.equal((logged?.metadata as { tenantId?: string } | null)?.tenantId, A, 'for which organisation')
})

test('[o3d-6thk1] the ACCOUNT-ROLE save (saveXeroSettings) obeys the same lock and organisation check, and stamps ownership', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const run = randomUUID().slice(0, 8)
  const [A, B] = [`tenant-A-${run}`, `tenant-B-${run}`]
  await seedBoundTo(deps.db, A, run)
  const { saveXeroSettings } = await import('../../app/actions/xero-sync.ts')
  const salesNow = async () => (await deps.db.setting.findUnique({ where: { key: 'xero_sales_account' } }))?.value ?? null

  const binding = await startBinding(deps, B, run)
  const stale = saveXeroSettings({ xero_sales_account: `OLD-ORG-SALES-${run}` }, A)
  await waitUntilParkedBehind(deps.db as never, { holderPid: binding.pid, waitingOn: /pg_advisory_xact_lock/, describe: 'saveXeroSettings vs the binding' })
  binding.release()
  await binding.done
  const staleResult = await stale
  assert.equal(staleResult.success, false, 'a page composed for the old organisation is refused')
  assert.equal(await salesNow(), null, 'and its account code is not written over the cleared mapping')

  const fresh = await saveXeroSettings({ xero_sales_account: `NEW-ORG-SALES-${run}` }, B)
  console.log(`# o3d-6thk1 role save: stale=${staleResult.success}, fresh=${fresh.success}, stamp=${await stampNow(deps.db)}`)
  assert.equal(fresh.success, true)
  assert.equal(await salesNow(), `NEW-ORG-SALES-${run}`)
  assert.equal(await stampNow(deps.db), B, 'owned by the bound organisation')
})
