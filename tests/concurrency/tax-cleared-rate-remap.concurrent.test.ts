import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, mock } from 'node:test'
import { config } from 'dotenv'

import { backendPid, waitUntilParkedBehind } from '../helpers/lock-wait-observer'

/**
 * A RATE A TAX RE-KEY CLEARED IS ENQUEUE-BLOCKED ONLY WHILE IT HAS NO VALID LIVE CODE, COMMITTED, AGAINST A REAL DATABASE.
 *
 * The re-key records each CLEAR replacement in the setting `tax_rekey_cleared_rates`. The enqueue guard used to refuse every payload bound to one of them whatever the rate carried NOW, and none of
 * the writers that give a rate a code removed the marker, so after the documented remedy (map the rate in Settings > Accounting > Tax) every invoice, bill and credit on it kept failing. Now:
 *   - the guard, under the connector-selection lock, refuses a cleared rate only while the rate STILL lacks a valid live code (a built-in or ACTIVE in the stored list of the connected organisation);
 *   - the writers (the tax-rate editor, link-by-name) drop the marker in the SAME transaction, under the same lock.
 * The world is seeded by hand (the marker in the exact shape the re-key writes it: tests/concurrency/tax-rekey.concurrent.test.ts drives the real CLEAR); the Xero fetch is a hook.
 *
 * Mutations (seen red, reverted; the list is in the PR): the guard ignoring the rate's current code; no marker drop in the editor; none in the link-by-name; the drop without the selection lock;
 * a retired code accepted as valid; the drop ignoring validity.
 */
const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const TX = { timeout: 30_000, maxWait: 20_000 }
const CLEARED = 'tax_rekey_cleared_rates'
const RETIRED = 'tax_rekey_retired_codes'
const PLUGIN_KEY = 'plugin_xero_enabled'

let xeroBody: unknown = { TaxRates: [] }

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

let depsPromise: ReturnType<typeof loadDepsOnce> | null = null
/** Loaded ONCE: a module can only be mocked once per process. */
function loadDeps() { return (depsPromise ??= loadDepsOnce()) }
async function loadDepsOnce() {
  const realApi = await import('../../lib/connectors/xero/api.ts')
  mock.module('@/lib/connectors/xero/api', {
    namedExports: {
      ...realApi,
      xeroGet: async () => ({ ok: true, status: 200, data: xeroBody }),
      xeroGetCached: async () => ({ ok: true, status: 200, data: xeroBody }),
    },
  })
  const [{ db }, guard, row, locks, settingsActions] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../lib/tax/retired-tax-code-guard.ts'),
    import('../../lib/domain/accounting/sync-log-row.ts'),
    import('../../lib/db/advisory-locks.ts'),
    import('../../app/actions/settings.ts'),
  ])
  return { db, guard, row, locks, settingsActions }
}
type Deps = Awaited<ReturnType<typeof loadDepsOnce>>

const createdRates: string[] = []
const createdLogs: string[] = []
const retiredCodesWritten: string[] = []

async function wipeXero(db: Deps['db']) {
  await db.setting.deleteMany({ where: { key: PLUGIN_KEY } })
  await db.accountingToken.deleteMany({ where: { connector: 'xero' } })
  await db.xeroTaxRateList.deleteMany({})
  await db.xeroTaxRate.deleteMany({})
}

async function removeOwnMarkers(db: Deps['db']) {
  const row = await db.setting.findUnique({ where: { key: CLEARED } })
  if (row) {
    const kept = Object.fromEntries(Object.entries(JSON.parse(row.value) as Record<string, unknown>).filter(([id]) => !createdRates.includes(id)))
    if (Object.keys(kept).length === 0) await db.setting.deleteMany({ where: { key: CLEARED } })
    else await db.setting.update({ where: { key: CLEARED }, data: { value: JSON.stringify(kept) } })
  }
  const retired = await db.setting.findUnique({ where: { key: RETIRED } })
  if (retired) {
    const kept = Object.fromEntries(Object.entries(JSON.parse(retired.value) as Record<string, unknown>).filter(([code]) => !retiredCodesWritten.includes(code)))
    if (Object.keys(kept).length === 0) await db.setting.deleteMany({ where: { key: RETIRED } })
    else await db.setting.update({ where: { key: RETIRED }, data: { value: JSON.stringify(kept) } })
  }
}

after(async () => {
  if (!RUN) return
  const { db } = await loadDeps()
  await db.accountingSyncLog.deleteMany({ where: { id: { in: createdLogs } } })
  await wipeXero(db)
  await removeOwnMarkers(db)
  if (createdRates.length) {
    await db.taxRateComponent.deleteMany({ where: { taxRateId: { in: createdRates } } })
    await db.taxRate.deleteMany({ where: { id: { in: createdRates } } })
  }
})

/** Connected to organisation `tenant`, Xero plugin on, and a stored live list holding `liveCodes` as ACTIVE. */
async function seedXero(db: Deps['db'], tenant: string, run: string, liveCodes: string[]) {
  await wipeXero(db)
  await db.accountingToken.create({ data: { connector: 'xero', accessToken: 'a', expiresAt: new Date(Date.now() + 3600_000), tenantId: tenant, tenantName: `Org ${run}`, connectionGeneration: `gen-${run}` } })
  await db.setting.create({ data: { key: PLUGIN_KEY, value: 'true' } })
  for (const taxType of liveCodes) {
    await db.xeroTaxRate.create({ data: { connector: 'xero', tenantId: tenant, taxType, name: `Live ${taxType}`, status: 'ACTIVE', components: [{ name: 'VAT', rate: '20.000000', compound: false, nonRecoverable: false }], fetchedAt: new Date() } })
  }
}

/** A rate with NO code that a re-key cleared: the marker in the shape the re-key writes it. */
async function seedClearedRate(db: Deps['db'], run: string, name: string) {
  const rate = await db.taxRate.create({ data: { name, rate: '0.2' }, select: { id: true } })
  createdRates.push(rate.id)
  const row = await db.setting.findUnique({ where: { key: CLEARED } })
  const value = JSON.stringify({ ...(row ? JSON.parse(row.value) as Record<string, unknown> : {}), [rate.id]: { at: new Date().toISOString() } })
  await db.setting.upsert({ where: { key: CLEARED }, create: { key: CLEARED, value }, update: { value } })
  return rate.id
}

const markerIds = async (db: Deps['db']) => Object.keys(JSON.parse((await db.setting.findUnique({ where: { key: CLEARED } }))?.value ?? '{}') as Record<string, unknown>)
const codeOf = async (db: Deps['db'], id: string) => (await db.taxRate.findUniqueOrThrow({ where: { id }, select: { accountingTaxType: true } })).accountingTaxType

let n = 0
/** The producer's enqueue, in a transaction (as the producers do): 'admitted' or the guard's refusal reason. */
async function enqueue(deps: Deps, rateId: string, code: string | null, run: string): Promise<string> {
  const payload = { lines: [{ description: 'x', ...(code === null ? {} : { taxType: code }), taxRateId: rateId }] }
  try {
    const made = await deps.db.$transaction((tx) => deps.row.createAccountingSyncLogRow(tx as never, { connector: 'xero', type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: `cleared-${run}-${n++}`, payload: payload as never }), TX)
    if (made.row) createdLogs.push(made.row.id)
    return made.row ? 'admitted' : 'no-row'
  } catch (e) {
    if (e instanceof Error && e.name === 'RetiredTaxCodeInPayloadError') return (e as Error & { reason: string }).reason
    throw e
  }
}

/** Holds the connector-selection lock in an open transaction until released. */
async function holdSelectionLock(deps: Deps) {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let held!: () => void
  const heldPromise = new Promise<void>((resolve) => { held = resolve })
  let pid = 0
  const done = deps.db.$transaction(async (tx) => {
    pid = await backendPid(tx as never)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${deps.locks.ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY})`
    held()
    await gate
  }, TX)
  await heldPromise
  return { pid, release, done }
}

/** Polls until at least two backends are blocked by `holderPid` (the first-arrived waiter is already established by waitUntilParkedBehind). */
async function waitUntilTwoParked(deps: Deps, holderPid: number, describe: string) {
  const deadline = Date.now() + 10_000
  for (;;) {
    const rows = await deps.db.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_stat_activity a WHERE a.datname = current_database() AND a.wait_event_type = 'Lock' AND ${holderPid}::int = ANY (pg_blocking_pids(a.pid))`
    if ((rows[0]?.n ?? 0) >= 2) return
    if (Date.now() > deadline) throw new Error(`${describe}: fewer than two backends parked behind pid ${holderPid}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const xeroList = (...codes: Array<{ code: string; name: string }>) => ({ TaxRates: codes.map((c) => ({ TaxType: c.code, Name: c.name, EffectiveRate: 20, Status: 'ACTIVE' })) })

// [mutation: the guard refuses a cleared rate whatever it carries now -> the "succeeds" arms fail; mutation: no marker drop in updateTaxRate -> the marker arm fails]
test('CLEAR -> remap through the TAX-RATE EDITOR -> enqueue succeeds, and the marker is gone', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const run = randomUUID().slice(0, 8)
  const live = `LIVE-${run}`
  await seedXero(deps.db, `tenant-${run}`, run, [live])
  const id = await seedClearedRate(deps.db, run, `cleared-edit-${run}`)
  xeroBody = xeroList({ code: live, name: 'Live' })

  assert.equal(await enqueue(deps, id, null, run), 'missing_tax_code', 'CONTROL: before the remap the document is refused')
  const result = await deps.settingsActions.updateTaxRate(id, { accountingTaxType: live })
  assert.equal(result.success, true, JSON.stringify(result))
  assert.equal(await codeOf(deps.db, id), live)
  assert.equal((await markerIds(deps.db)).includes(id), false, 'the cleared marker left with the code')
  assert.equal(await enqueue(deps, id, live, run), 'admitted', 'the invoice, bill or credit on the remapped rate is queued')
})

// [mutation: no marker drop in the Xero link-by-name -> the marker arm fails]
test('CLEAR -> remap through the XERO MAPPING (link by name) -> enqueue succeeds, and the marker is gone', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const run = randomUUID().slice(0, 8)
  const live = `LIVE-${run}`
  await seedXero(deps.db, `tenant-${run}`, run, [live])
  const name = `cleared-map-${run}`
  const id = await seedClearedRate(deps.db, run, name)
  xeroBody = xeroList({ code: live, name })

  assert.equal(await enqueue(deps, id, null, run), 'missing_tax_code', 'CONTROL')
  const result = await deps.settingsActions.autoLinkXeroTaxRates()
  assert.equal(result.success, true, JSON.stringify(result).slice(0, 300))
  assert.equal(await codeOf(deps.db, id), live, 'the mapping landed')
  assert.equal((await markerIds(deps.db)).includes(id), false, 'the cleared marker left with the code')
  assert.equal(await enqueue(deps, id, live, run), 'admitted')
})

test('CLEAR with NO remap -> enqueue is still refused (and the marker stays)', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const run = randomUUID().slice(0, 8)
  await seedXero(deps.db, `tenant-${run}`, run, [`LIVE-${run}`])
  const id = await seedClearedRate(deps.db, run, `cleared-none-${run}`)
  assert.equal(await enqueue(deps, id, null, run), 'missing_tax_code')
  assert.equal(await enqueue(deps, id, `LIVE-${run}`, run), 'missing_tax_code', 'the order default\'s code is no substitute')
  assert.equal((await markerIds(deps.db)).includes(id), true)
})

// [mutation: a retired code is accepted as a valid one -> the retired arm fails; mutation: the drop ignores validity -> the marker-kept arms fail]
test('a remap to an INVALID or RETIRED code leaves the rate refused and the marker in place', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const run = randomUUID().slice(0, 8)
  const live = `LIVE-${run}`
  const staleDemo = `OLD-${run}`
  await seedXero(deps.db, `tenant-${run}`, run, [live])
  // A code a re-key retired and the connected organisation does not carry.
  const retired = await deps.db.setting.findUnique({ where: { key: RETIRED } })
  retiredCodesWritten.push(staleDemo)
  const value = JSON.stringify({ ...(retired ? JSON.parse(retired.value) as Record<string, unknown> : {}), [staleDemo]: { rateId: 'gone', newCode: '', at: new Date().toISOString() } })
  await deps.db.setting.upsert({ where: { key: RETIRED }, create: { key: RETIRED, value }, update: { value } })
  const id = await seedClearedRate(deps.db, run, `cleared-bad-${run}`)

  // The editor accepts it (Xero, fetched live, lists it) but the stored list does not carry it: the rate does not have a valid live code yet.
  xeroBody = xeroList({ code: `NOTSTORED-${run}`, name: 'x' })
  const edited = await deps.settingsActions.updateTaxRate(id, { accountingTaxType: `NOTSTORED-${run}` })
  assert.equal(edited.success, true, JSON.stringify(edited))
  assert.equal(await enqueue(deps, id, `NOTSTORED-${run}`, run), 'missing_tax_code', 'a code the stored live list does not carry')
  assert.equal((await markerIds(deps.db)).includes(id), true, 'and the marker stays')

  // The retired demo code, written straight onto the rate (nothing validated it), then released: still refused, marker kept.
  await deps.db.taxRate.update({ where: { id }, data: { accountingTaxType: staleDemo } })
  assert.deepEqual(await deps.db.$transaction((tx) => deps.guard.releaseClearedRateMarkers(tx, [id]), TX), [], 'the drop ignores a rate with no valid code')
  assert.equal((await markerIds(deps.db)).includes(id), true)
  assert.equal(await enqueue(deps, id, staleDemo, run), 'missing_tax_code', 'a retired code')

  // And once the code IS live the same rate is admitted: the control for the arms above.
  await deps.db.taxRate.update({ where: { id }, data: { accountingTaxType: live } })
  assert.equal(await enqueue(deps, id, live, run), 'admitted')
})

// [mutation: the drop runs without the selection lock -> the release never parks behind the holder]
test('the marker drop takes the connector-selection lock: a release parks behind a holder and lands after it', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const run = randomUUID().slice(0, 8)
  const live = `LIVE-${run}`
  await seedXero(deps.db, `tenant-${run}`, run, [live])
  const id = await seedClearedRate(deps.db, run, `cleared-lock-${run}`)
  await deps.db.taxRate.update({ where: { id }, data: { accountingTaxType: live } })

  const holder = await holdSelectionLock(deps)
  let released = false
  const release = deps.db.$transaction(async (tx) => deps.guard.releaseClearedRateMarkers(tx, [id]), TX).then((dropped) => { released = true; return dropped })
  await waitUntilParkedBehind(deps.db as never, { holderPid: holder.pid, waitingOn: /pg_advisory_xact_lock/, describe: 'the marker drop' })
  assert.equal(released, false, 'parked, not through')
  assert.equal((await markerIds(deps.db)).includes(id), true, 'nothing dropped while the lock is held elsewhere')
  holder.release()
  await holder.done
  assert.deepEqual(await release, [id])
  assert.equal((await markerIds(deps.db)).includes(id), false)
})

// [mutation: the guard reads the rate before the lock / ignores the current code -> one of the two orders fails]
test('a remap RACING an enqueue: the verdict follows the commit order, and an enqueue is never admitted bound to a rate with no valid code at its commit', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const run = randomUUID().slice(0, 8)
  const live = `LIVE-${run}`
  await seedXero(deps.db, `tenant-${run}`, run, [live])
  xeroBody = xeroList({ code: live, name: 'Live' })
  const lockWait = /pg_advisory_xact_lock/

  // ORDER 1: the enqueue reaches the lock first; the remap queues behind it. The enqueue sees the rate as it is (no code) and is refused; the remap then lands.
  const first = await seedClearedRate(deps.db, run, `cleared-race1-${run}`)
  const gate1 = await holdSelectionLock(deps)
  const enq1 = enqueue(deps, first, live, run)
  await waitUntilParkedBehind(deps.db as never, { holderPid: gate1.pid, waitingOn: lockWait, describe: 'the enqueue (order 1)' })
  // (The remap here is the editor's own transaction written out - lock, update, marker drop - because a refusal records its inbox row on the pooled client, which waits out a lock the enqueue's own transaction
  // holds on the posting key (a quirk of the refusal path, not of this change); that stall is longer than the editor's 5 s transaction timeout and would expire it. Orders 2 and 3 use the real editor.)
  const edit1 = deps.db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${deps.locks.ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY})`
    await tx.taxRate.update({ where: { id: first }, data: { accountingTaxType: live } })
    await deps.guard.releaseClearedRateMarkers(tx, [first])
    return { success: true }
  }, TX)
  await waitUntilTwoParked(deps, gate1.pid, 'the enqueue and the remap (order 1)')
  gate1.release()
  await gate1.done
  assert.equal(await enq1, 'missing_tax_code', 'order 1: the enqueue ran before the remap committed, on a rate with no code')
  const e1 = await edit1
  assert.equal(e1.success, true, JSON.stringify(e1))
  assert.equal(await codeOf(deps.db, first), live)

  // ORDER 2: the remap reaches the lock first and holds it to its commit; the enqueue queues behind it and reads the committed code.
  const second = await seedClearedRate(deps.db, run, `cleared-race2-${run}`)
  const gate2 = await holdSelectionLock(deps)
  const edit2 = deps.settingsActions.updateTaxRate(second, { accountingTaxType: live })
  await waitUntilParkedBehind(deps.db as never, { holderPid: gate2.pid, waitingOn: lockWait, describe: 'the remap (order 2)' })
  const enq2 = enqueue(deps, second, live, run)
  await waitUntilParkedBehind(deps.db as never, { holderPid: gate2.pid, waitingOn: lockWait, describe: 'the enqueue (order 2)' })
  gate2.release()
  await gate2.done
  const e2 = await edit2
  assert.equal(e2.success, true, JSON.stringify(e2))
  assert.equal(await enq2, 'admitted', 'order 2: the remap committed first, the enqueue sees the code')
  assert.equal((await markerIds(deps.db)).includes(second), false)

  // A remap that ROLLS BACK never lets an enqueue through: the enqueue waits for the lock, then reads the rate as committed (no code).
  const third = await seedClearedRate(deps.db, run, `cleared-race3-${run}`)
  let abort!: () => void
  const abortGate = new Promise<void>((resolve) => { abort = resolve })
  let pid = 0
  let held!: () => void
  const heldP = new Promise<void>((resolve) => { held = resolve })
  const aborted = deps.db.$transaction(async (tx) => {
    pid = await backendPid(tx as never)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${deps.locks.ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY})`
    await tx.taxRate.update({ where: { id: third }, data: { accountingTaxType: live } })
    await deps.guard.releaseClearedRateMarkers(tx, [third])
    held()
    await abortGate
    throw new Error('rollback')
  }, TX).catch((e: Error) => e.message)
  await heldP
  const enq3 = enqueue(deps, third, live, run)
  await waitUntilParkedBehind(deps.db as never, { holderPid: pid, waitingOn: lockWait, describe: 'the enqueue (rolled-back remap)' })
  abort()
  assert.equal(await aborted, 'rollback')
  assert.equal(await enq3, 'missing_tax_code', 'the uncommitted code was never visible; the marker drop rolled back with it')
  assert.equal(await codeOf(deps.db, third), null)
  assert.equal((await markerIds(deps.db)).includes(third), true)
})
