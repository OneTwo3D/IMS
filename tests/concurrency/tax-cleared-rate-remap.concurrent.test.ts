import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, mock } from 'node:test'
import { config } from 'dotenv'

import { backendPid, waitUntilParkedBehind } from '../helpers/lock-wait-observer'

/**
 * A RATE A TAX RE-KEY CLEARED: ITS MARKER IS PERMANENT; A BINDING TO IT IS ADMITTED ONLY ON ITS CURRENT VALID LIVE CODE, SENT EXACTLY. Committed, against a real database.
 *
 * The re-key records each CLEAR replacement in the setting `tax_rekey_cleared_rates`. The guard used to refuse every payload bound to one whatever the rate carried NOW (so the documented remedy -
 * mapping the rate in Settings > Accounting > Tax - changed nothing). It then admitted any payload once the rate had a code, including one built BEFORE the remap from the order default's code, and
 * a writer that deleted the marker left a later clearing edit unguarded. Now:
 *   - nothing deletes the marker; the guard, under the connector-selection lock, admits a binding to a marked rate only when the rate's current code is valid and live AND the tax type sent beside the
 *     binding is that code (a stale, default or missing type is refused as tax_code_not_current, and the producer rebuilds);
 *   - every edit of accountingTaxType (setting it OR clearing it) takes the same lock first and holds it to commit, so the verdict stands through the producer's commit.
 * The world is seeded by hand (the marker in the exact shape the re-key writes it: tests/concurrency/tax-rekey.concurrent.test.ts drives the real CLEAR); the Xero fetch is a hook.
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
const DEFAULT_CODE = 'OUTPUT2'

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

// [mutation: the guard refuses a cleared rate whatever it carries now -> the "admitted" arms fail; mutation: the marker is deleted on a remap -> the marker-kept arms fail]
test('CLEAR -> remap through the TAX-RATE EDITOR -> a rebuilt payload is enqueued; the marker STAYS', { skip: !RUN }, async () => {
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
  assert.equal((await markerIds(deps.db)).includes(id), true, 'the marker is the rate\'s permanent identity: a remap does not delete it')
  assert.equal(await enqueue(deps, id, live, run), 'admitted', 'the invoice, bill or credit rebuilt on the remapped rate is queued')
})

// [mutation: no lock/no effect in link-by-name -> the mapping arm fails]
test('CLEAR -> remap through the XERO MAPPING (link by name) -> a rebuilt payload is enqueued; the marker STAYS', { skip: !RUN }, async () => {
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
  assert.equal((await markerIds(deps.db)).includes(id), true)
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

// [mutation: a retired / unlisted code is accepted as valid -> the retired arm fails]
test('a remap to an INVALID or RETIRED code leaves the rate refused', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const run = randomUUID().slice(0, 8)
  const live = `LIVE-${run}`
  const staleDemo = `OLD-${run}`
  await seedXero(deps.db, `tenant-${run}`, run, [live])
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

  // The retired demo code, written straight onto the rate (nothing validated it).
  await deps.db.taxRate.update({ where: { id }, data: { accountingTaxType: staleDemo } })
  assert.equal(await enqueue(deps, id, staleDemo, run), 'missing_tax_code', 'a retired code')

  // And once the code IS live the same rate is admitted: the control for the arms above.
  await deps.db.taxRate.update({ where: { id }, data: { accountingTaxType: live } })
  assert.equal(await enqueue(deps, id, live, run), 'admitted')
})

// [mutation: the payload's tax type is not compared with the rate's code -> the stale payload is admitted; mutation: it is compared with the order default's code -> the rebuilt payload is refused]
test('a payload BUILT BEFORE a remap and enqueued AFTER it is refused; the rebuilt one is admitted', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const run = randomUUID().slice(0, 8)
  const live = `LIVE-${run}`
  await seedXero(deps.db, `tenant-${run}`, run, [live])
  const id = await seedClearedRate(deps.db, run, `cleared-stale-${run}`)
  xeroBody = xeroList({ code: live, name: 'Live' })

  // The producer reads the cleared line (no code), falls back to the order default's code, then PAUSES.
  let resume!: () => void
  const paused = new Promise<void>((resolve) => { resume = resolve })
  let built!: () => void
  const builtP = new Promise<void>((resolve) => { built = resolve })
  const producer = (async () => {
    const readCode = await codeOf(deps.db, id)
    const typeSent = readCode ?? DEFAULT_CODE
    built()
    await paused
    return enqueue(deps, id, typeSent, run)
  })()
  await builtP
  const remap = await deps.settingsActions.updateTaxRate(id, { accountingTaxType: live })
  assert.equal(remap.success, true, JSON.stringify(remap))
  resume()
  assert.equal(await producer, 'tax_code_not_current', 'the stale payload (the default\'s code, built before the remap) is refused')
  assert.equal(await enqueue(deps, id, null, run), 'tax_code_not_current', 'and so is one with no type')
  assert.equal(await enqueue(deps, id, live, run), 'admitted', 'the rebuild from the rate as it is now is admitted')
})

// [mutation: the marker is deleted on a remap -> the cleared-again arm admits]
test('remap, then CLEAR again, then enqueue is refused: the marker survived the remap', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const run = randomUUID().slice(0, 8)
  const live = `LIVE-${run}`
  await seedXero(deps.db, `tenant-${run}`, run, [live])
  const id = await seedClearedRate(deps.db, run, `cleared-again-${run}`)
  xeroBody = xeroList({ code: live, name: 'Live' })
  assert.equal((await deps.settingsActions.updateTaxRate(id, { accountingTaxType: live })).success, true)
  assert.equal(await enqueue(deps, id, live, run), 'admitted')
  const cleared = await deps.settingsActions.updateTaxRate(id, { accountingTaxType: '' })
  assert.equal(cleared.success, true, JSON.stringify(cleared))
  assert.equal(await codeOf(deps.db, id), null)
  assert.equal(await enqueue(deps, id, null, run), 'missing_tax_code')
  assert.equal(await enqueue(deps, id, live, run), 'missing_tax_code', 'even with the old code in the payload')
})

/** A producer transaction that passes the guard and stays open (holding the selection lock) until released. */
async function heldEnqueue(deps: Deps, rateId: string, code: string, run: string) {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let held!: () => void
  const heldP = new Promise<void>((resolve) => { held = resolve })
  let pid = 0
  const done = deps.db.$transaction(async (tx) => {
    pid = await backendPid(tx as never)
    const made = await deps.row.createAccountingSyncLogRow(tx as never, { connector: 'xero', type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: `cleared-${run}-${n++}`, payload: { lines: [{ description: 'x', taxType: code, taxRateId: rateId }] } as never })
    if (made.row) createdLogs.push(made.row.id)
    held()
    await gate
    return made.row ? 'admitted' : 'no-row'
  }, TX)
  await heldP
  return { pid, release, done }
}

// [mutation: the clearing edit takes no selection lock -> it does not park behind the producer (order A) and queues ahead of nothing (order B)]
test('a CLEARING edit racing an enqueue: in both commit orders nothing is admitted without a valid matching code at the commit', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const run = randomUUID().slice(0, 8)
  const live = `LIVE-${run}`
  await seedXero(deps.db, `tenant-${run}`, run, [live])
  xeroBody = xeroList({ code: live, name: 'Live' })
  const lockWait = /pg_advisory_xact_lock/

  // ORDER A: the producer passed the guard and has not committed. The clearing edit cannot take the lock until it does, so the code stays valid through the producer's commit.
  const a = await seedClearedRate(deps.db, run, `cleared-clear-a-${run}`)
  await deps.db.taxRate.update({ where: { id: a }, data: { accountingTaxType: live } })
  const producer = await heldEnqueue(deps, a, live, run)
  const clearA = deps.settingsActions.updateTaxRate(a, { accountingTaxType: '' })
  await waitUntilParkedBehind(deps.db as never, { holderPid: producer.pid, waitingOn: lockWait, describe: 'the clearing edit (order A)' })
  assert.equal(await codeOf(deps.db, a), live, 'the code is still valid while the producer has not committed')
  producer.release()
  assert.equal(await producer.done, 'admitted', 'order A: admitted - the rate had a valid matching code at the commit')
  const clearedA = await clearA
  assert.equal(clearedA.success, true, JSON.stringify(clearedA))
  assert.equal(await codeOf(deps.db, a), null)

  // ORDER B: the clearing edit holds the lock first (queued behind a holder, ahead of the producer). The producer then reads the cleared rate and is refused.
  const b = await seedClearedRate(deps.db, run, `cleared-clear-b-${run}`)
  await deps.db.taxRate.update({ where: { id: b }, data: { accountingTaxType: live } })
  const gate = await holdSelectionLock(deps)
  const clearB = deps.settingsActions.updateTaxRate(b, { accountingTaxType: '' })
  await waitUntilParkedBehind(deps.db as never, { holderPid: gate.pid, waitingOn: lockWait, describe: 'the clearing edit (order B)' })
  const enqB = enqueue(deps, b, live, run)
  await waitUntilTwoParked(deps, gate.pid, 'the clearing edit and the enqueue (order B)')
  gate.release()
  await gate.done
  const clearedB = await clearB
  assert.equal(clearedB.success, true, JSON.stringify(clearedB))
  assert.equal(await enqB, 'missing_tax_code', 'order B: the clear committed first; the enqueue reads no code and is refused')
  assert.equal(await codeOf(deps.db, b), null)
})

// [mutation: the guard reads the rate before the lock / ignores the current code -> one of the orders fails]
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
  // (The remap here is the editor's own transaction written out - lock, update - because a refusal records its inbox row on the pooled client, which waits out a lock the enqueue's own transaction
  // holds on the posting key (a quirk of the refusal path, not of this change); that stall is longer than the editor's 5 s transaction timeout and would expire it. The other orders use the real editor.)
  const edit1 = deps.db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${deps.locks.ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY})`
    await tx.taxRate.update({ where: { id: first }, data: { accountingTaxType: live } })
    return { success: true }
  }, TX)
  await waitUntilTwoParked(deps, gate1.pid, 'the enqueue and the remap (order 1)')
  gate1.release()
  await gate1.done
  assert.equal(await enq1, 'missing_tax_code', 'order 1: the enqueue ran before the remap committed, on a rate with no code')
  assert.equal((await edit1).success, true)
  assert.equal(await codeOf(deps.db, first), live)

  // ORDER 2: the remap reaches the lock first and holds it to its commit; the enqueue queues behind it and reads the committed code.
  const second = await seedClearedRate(deps.db, run, `cleared-race2-${run}`)
  const gate2 = await holdSelectionLock(deps)
  const edit2 = deps.settingsActions.updateTaxRate(second, { accountingTaxType: live })
  await waitUntilParkedBehind(deps.db as never, { holderPid: gate2.pid, waitingOn: lockWait, describe: 'the remap (order 2)' })
  const enq2 = enqueue(deps, second, live, run)
  await waitUntilTwoParked(deps, gate2.pid, 'the remap and the enqueue (order 2)')
  gate2.release()
  await gate2.done
  const e2 = await edit2
  assert.equal(e2.success, true, JSON.stringify(e2))
  assert.equal(await enq2, 'admitted', 'order 2: the remap committed first, the enqueue sees the code')

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
    held()
    await abortGate
    throw new Error('rollback')
  }, TX).catch((e: Error) => e.message)
  await heldP
  const enq3 = enqueue(deps, third, live, run)
  await waitUntilParkedBehind(deps.db as never, { holderPid: pid, waitingOn: lockWait, describe: 'the enqueue (rolled-back remap)' })
  abort()
  assert.equal(await aborted, 'rollback')
  assert.equal(await enq3, 'missing_tax_code', 'the uncommitted code was never visible')
  assert.equal(await codeOf(deps.db, third), null)
})
