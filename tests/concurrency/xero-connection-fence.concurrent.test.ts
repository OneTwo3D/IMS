import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, mock } from 'node:test'
import { config } from 'dotenv'

import { backendPid, waitUntilParkedBehind } from '../helpers/lock-wait-observer'

/**
 * o3d-6thk1 round 2 (Codex HIGH 2) — "FETCH FROM XERO, WRITE LATER" MUST NOT WRITE ACROSS A REBIND.
 *
 * `syncChartOfAccounts` fetched the chart and upserted it with no lock and no connection check, so a refresh
 * that fetched organisation A before a rebind to B could write A's chart AFTER the binding's clear committed,
 * and the Sync page then offered A's accounts for B's re-map. The same shape sat in the tax-rate drift
 * snapshot writer, the tax-type auto-link / generate / single-rate writers and the balance snapshot writer.
 * They now remember the connection BEFORE the fetch and refuse the write, under the mapping lock the binding
 * takes, when it moved (lib/connectors/xero/connection-fence.ts).
 *
 * REAL POSTGRES, REAL ACTIONS, NO SLEEPS. The Xero fetch is a hook the test holds open (a promise), so the
 * refresh is PARKED between its fetch and its write while a rebind commits; a second arm instead holds the
 * rebind's transaction open and observes the refresh parked behind the advisory lock via pg_blocking_pids.
 * Each refusal arm has a CONTROL with no rebind that proves the write really happens when nothing moved.
 */
const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const TX = { timeout: 30_000, maxWait: 20_000 }

type Hook = (path: string) => Promise<unknown>
let fetchHook: Hook = async () => { throw new Error('no fetch hook installed') }

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireFreshPermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    freshAuthFailureResult: () => null,
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {}, unstable_rethrow: () => {} } })

config({ path: '.env.local', quiet: true })
config({ quiet: true })

const MAP_KEY = 'accounting_payment_account_map'
const STAMP_KEY = 'xero_account_mapping_tenant_id'
const SNAPSHOT_KEY = 'xero_tax_rate_drift_current'
const CHECKED_KEY = 'xero_tax_rate_drift_last_checked_at'
const PLUGIN_KEY = 'plugin_xero_enabled'

let depsPromise: ReturnType<typeof loadDepsOnce> | null = null
/** Loaded ONCE: a module can only be mocked once per process. */
function loadDeps() { return (depsPromise ??= loadDepsOnce()) }
async function loadDepsOnce() {
  const realApi = await import('../../lib/connectors/xero/api.ts')
  mock.module('@/lib/connectors/xero/api', {
    namedExports: {
      ...realApi,
      xeroGet: async (path: string) => ({ ok: true, status: 200, data: await fetchHook(path) }),
      xeroGetCached: async (path: string) => ({ ok: true, status: 200, data: await fetchHook(path) }),
    },
  })
  const [{ db }, rebind, lock, accounts, drift, settingsActions] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../lib/connectors/xero/account-mapping-rebind.ts'),
    import('../../lib/integration-plugin-selection-lock.ts'),
    import('../../lib/connectors/xero/accounts.ts'),
    import('../../lib/connectors/xero/tax-rate-drift-sweeper.ts'),
    import('../../app/actions/settings.ts'),
  ])
  return { db, rebind, lock, accounts, drift, settingsActions }
}
type Deps = Awaited<ReturnType<typeof loadDepsOnce>>

const createdRates: string[] = []

async function wipe(db: Deps['db']) {
  await db.setting.deleteMany({ where: { key: { in: [MAP_KEY, STAMP_KEY, 'xero_sync_enabled', SNAPSHOT_KEY, CHECKED_KEY, PLUGIN_KEY] } } })
  await db.accountingToken.deleteMany({ where: { connector: 'xero' } })
  await db.accountingAccount.deleteMany({ where: { connector: 'xero' } })
}

/** Bound to org A with A's mapping and A's cached chart, stamped as A's, Xero plugin on. */
async function seedBoundTo(db: Deps['db'], tenantA: string, run: string) {
  await wipe(db)
  await db.accountingToken.create({ data: { connector: 'xero', accessToken: 'a', expiresAt: new Date(Date.now() + 3600_000), tenantId: tenantA, tenantName: `Org A ${run}`, connectionGeneration: `gen-A-${run}` } })
  await db.setting.create({ data: { key: MAP_KEY, value: JSON.stringify({ 'card:GBP': `OLD-${run}` }) } })
  await db.setting.create({ data: { key: STAMP_KEY, value: tenantA } })
  await db.setting.create({ data: { key: PLUGIN_KEY, value: 'true' } })
  await db.accountingAccount.create({ data: { connector: 'xero', externalAccountId: `A-old-${run}`, code: '100', name: 'Org A old account', type: 'REVENUE' } })
}

/** The mapping part of bindXeroTenant (lock, read previous, new token + generation, reset), held open until released. */
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
      create: { connector: 'xero', accessToken: 'b', expiresAt: new Date(Date.now() + 3600_000), tenantId: tenantB, tenantName: `Org B ${run}`, connectionGeneration: `gen-B-${run}` },
      update: { tenantId: tenantB, tenantName: `Org B ${run}`, connectionGeneration: `gen-B-${run}` },
    })
    const outcome = await deps.rebind.resetAccountMappingForOrganisationChange(tx as never, { previous, newTenantId: tenantB, connector: 'xero' })
    held()
    await gate
    return outcome
  }, TX)
  await heldPromise
  return { pid, release, done }
}

/** A fetch that is entered, announces it, and then waits to be released. Returns what to await and how to let it go. */
function parkedFetch(payload: unknown) {
  let entered!: () => void
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  fetchHook = async () => { entered(); await gate; return payload }
  return { entered: enteredPromise, release }
}
const immediateFetch = (payload: unknown) => { fetchHook = async () => payload }

const chartRows = async (db: Deps['db']) => db.accountingAccount.count({ where: { connector: 'xero' } })
const accountsPayload = (run: string) => ({
  Accounts: [1, 2, 3].map((n) => ({ AccountID: `A-new-${n}-${run}`, Code: `20${n}`, Name: `Org A account ${n}`, Type: 'REVENUE', TaxType: 'NONE', Status: 'ACTIVE', Class: 'REVENUE' })),
})

after(async () => {
  if (!RUN) return
  const { db } = await loadDeps()
  await wipe(db)
  if (createdRates.length) {
    await db.taxRateComponent.deleteMany({ where: { taxRateId: { in: createdRates } } })
    await db.taxRate.deleteMany({ where: { id: { in: createdRates } } })
  }
})

test('[o3d-6thk1] CHART: a refresh parked between its fetch and its write while a rebind commits is REFUSED, and the chart stays cleared', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const run = randomUUID().slice(0, 8)
  const [A, B] = [`tenant-A-${run}`, `tenant-B-${run}`]
  await seedBoundTo(deps.db, A, run)
  assert.equal(await chartRows(deps.db), 1, 'PRECONDITION: the previous organisation\'s chart is cached')

  const fetch = parkedFetch(accountsPayload(run))
  const refresh = deps.accounts.syncChartOfAccounts()
  await fetch.entered // the refresh has FETCHED (under organisation A) and is parked before its write
  const binding = await startBinding(deps, B, run)
  binding.release()
  const outcome = await binding.done
  assert.equal(outcome.kind, 'cleared', 'PRECONDITION: the binding cleared the old organisation\'s mapping and chart')
  assert.equal(await chartRows(deps.db), 0, 'PRECONDITION: the cache is empty after the rebind')

  fetch.release()
  const result = await refresh
  console.log(`# o3d-6thk1 chart fence: result=${JSON.stringify(result)}, rows after=${await chartRows(deps.db)}`)
  assert.equal(result.synced, 0)
  assert.match(result.errors[0] ?? '', /connected Xero organisation changed/)
  assert.equal(await chartRows(deps.db), 0, 'organisation A\'s chart did NOT come back after the rebind')
})

test('[o3d-6thk1] CHART: a refresh that reaches its write while the rebind is still in flight parks behind the mapping lock, then is refused', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const run = randomUUID().slice(0, 8)
  const [A, B] = [`tenant-A-${run}`, `tenant-B-${run}`]
  await seedBoundTo(deps.db, A, run)
  immediateFetch(accountsPayload(run))

  const binding = await startBinding(deps, B, run)
  const refresh = deps.accounts.syncChartOfAccounts() // fetches at once, then its write meets the held lock
  const parked = await waitUntilParkedBehind(deps.db as never, { holderPid: binding.pid, waitingOn: /pg_advisory_xact_lock/, describe: 'chart write vs the binding' })
  console.log(`# o3d-6thk1 chart fence: write parked behind binding pid ${binding.pid} after ${parked.observedAfterMs}ms`)
  binding.release()
  await binding.done
  const result = await refresh

  assert.equal(result.synced, 0)
  assert.match(result.errors[0] ?? '', /connected Xero organisation changed/)
  assert.equal(await chartRows(deps.db), 0)
})

test('[o3d-6thk1] CHART control: with no rebind the refresh writes the chart', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const run = randomUUID().slice(0, 8)
  await seedBoundTo(deps.db, `tenant-A-${run}`, run)
  immediateFetch(accountsPayload(run))

  const result = await deps.accounts.syncChartOfAccounts()

  assert.deepEqual([result.synced, result.errors.length], [3, 0])
  assert.equal(await chartRows(deps.db), 4, 'the three fetched accounts plus the old one, now deactivated')
})

test('[o3d-6thk1] DRIFT SNAPSHOT: a sweep whose fetch straddles a rebind does not write the previous organisation\'s snapshot', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const run = randomUUID().slice(0, 8)
  const [A, B] = [`tenant-A-${run}`, `tenant-B-${run}`]
  const snapshotNow = async () => (await deps.db.setting.findUnique({ where: { key: SNAPSHOT_KEY } }))?.value ?? null
  const checkedNow = async () => (await deps.db.setting.findUnique({ where: { key: CHECKED_KEY } }))?.value ?? null

  // Control first: no rebind, the snapshot and the last-checked stamp are written.
  await seedBoundTo(deps.db, A, run)
  immediateFetch({ TaxRates: [] })
  await deps.drift.runXeroTaxRateDriftSweep()
  assert.notEqual(await snapshotNow(), null, 'CONTROL: the snapshot is written when nothing moved')
  assert.notEqual(await checkedNow(), null)

  await seedBoundTo(deps.db, A, run)
  // The sweep only fetches when IMS has a rate with an active component to compare, so give it one.
  const driftRate = await deps.db.taxRate.create({ data: { name: `drift-${run}`, rate: '0.2', components: { create: [{ name: 'c', rate: '0.2' }] } }, select: { id: true } })
  createdRates.push(driftRate.id)
  const fetch = parkedFetch({ TaxRates: [] })
  const sweep = deps.drift.runXeroTaxRateDriftSweep()
  await fetch.entered
  const binding = await startBinding(deps, B, run)
  binding.release()
  await binding.done
  fetch.release()
  await sweep

  assert.equal(await snapshotNow(), null, 'no snapshot of the previous organisation\'s rates after the rebind')
  assert.equal(await checkedNow(), null, 'and the last-checked stamp was not advanced')
})

async function seedUnmappedRate(deps: Deps, run: string) {
  const rate = await deps.db.taxRate.create({ data: { name: `fence-${run}`, rate: '0.2' }, select: { id: true } })
  createdRates.push(rate.id)
  return rate.id
}
const rateType = async (deps: Deps, id: string) => (await deps.db.taxRate.findUniqueOrThrow({ where: { id }, select: { accountingTaxType: true } })).accountingTaxType

test('[o3d-6thk1] TAX-TYPE AUTO-LINK: a link whose Xero read straddles a rebind writes no tax type onto the IMS rate', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const run = randomUUID().slice(0, 8)
  const [A, B] = [`tenant-A-${run}`, `tenant-B-${run}`]
  const xeroRates = { TaxRates: [{ TaxType: `OUT-A-${run}`, Name: `fence-${run}`, EffectiveRate: 20, Status: 'ACTIVE' }] }

  await seedBoundTo(deps.db, A, run)
  const controlId = await seedUnmappedRate(deps, run)
  immediateFetch(xeroRates)
  const control = await deps.settingsActions.autoLinkXeroTaxRates()
  assert.equal(await rateType(deps, controlId), `OUT-A-${run}`, `CONTROL: with no rebind the type is linked (${JSON.stringify(control).slice(0, 160)})`)

  await seedBoundTo(deps.db, A, run)
  await deps.db.taxRate.update({ where: { id: controlId }, data: { accountingTaxType: null } })
  const fetch = parkedFetch(xeroRates)
  const link = deps.settingsActions.autoLinkXeroTaxRates()
  await fetch.entered
  const binding = await startBinding(deps, B, run)
  binding.release()
  await binding.done
  fetch.release()
  const result = await link

  console.log(`# o3d-6thk1 auto-link fence: success=${result.success}, type after=${await rateType(deps, controlId)}`)
  assert.equal(result.success, false)
  assert.equal(await rateType(deps, controlId), null, 'the previous organisation\'s tax type did NOT land on the IMS rate')
})

test('[o3d-6thk1] TAX-TYPE SINGLE WRITE (updateTaxRate): validated against organisation A, refused if the instance is rebound before the write', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const run = randomUUID().slice(0, 8)
  const [A, B] = [`tenant-A-${run}`, `tenant-B-${run}`]
  const xeroRates = { TaxRates: [{ TaxType: `OUT-A-${run}`, Name: 'x', EffectiveRate: 20, Status: 'ACTIVE' }] }
  await seedBoundTo(deps.db, A, run)
  const id = await seedUnmappedRate(deps, run)

  immediateFetch(xeroRates)
  const control = await deps.settingsActions.updateTaxRate(id, { accountingTaxType: `OUT-A-${run}` })
  assert.equal(control.success, true, `CONTROL: ${JSON.stringify(control)}`)
  assert.equal(await rateType(deps, id), `OUT-A-${run}`)
  await deps.db.taxRate.update({ where: { id }, data: { accountingTaxType: null } })

  await seedBoundTo(deps.db, A, run)
  const fetch = parkedFetch(xeroRates)
  const write = deps.settingsActions.updateTaxRate(id, { accountingTaxType: `OUT-A-${run}` })
  await fetch.entered // validated (live) under organisation A; parked before the write
  const binding = await startBinding(deps, B, run)
  binding.release()
  await binding.done
  fetch.release()
  const result = await write

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /connected Xero organisation changed/)
  assert.equal(await rateType(deps, id), null)
})

test('[o3d-6thk1] CHART: a re-consent to the SAME organisation mints a new connection generation, and the refresh fetched under the old one is refused too', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const run = randomUUID().slice(0, 8)
  await seedBoundTo(deps.db, `tenant-A-${run}`, run)
  const fetch = parkedFetch(accountsPayload(run))
  const refresh = deps.accounts.syncChartOfAccounts()
  await fetch.entered
  await deps.db.$transaction(async (tx) => {
    await deps.lock.lockAccountingMappingSelection(tx as never, 'xero')
    await tx.accountingToken.update({ where: { connector: 'xero' }, data: { connectionGeneration: `gen-A2-${run}` } })
  }, TX)
  fetch.release()
  const result = await refresh

  assert.equal(result.synced, 0, 'the same tenant is not proof the data was fetched under the connection now bound')
  assert.match(result.errors[0] ?? '', /connected Xero organisation changed/)
  assert.equal(await deps.db.accountingAccount.count({ where: { connector: 'xero', externalAccountId: { startsWith: 'A-new-' } } }), 0)
})
