import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import '../../lib/cron-jobs/index.ts'
import { getAllCronJobs } from '../../lib/cron-registry.ts'
import { buildOtiCrontabBlock } from '../../lib/crontab-sync.ts'
import { READ_SYNC_STREAMS } from '../../lib/ops/read-sync-liveness-constants.ts'
import type { ReadSyncInputs } from '../../lib/ops/read-sync-status.ts'
import { runSchedulerCoverageGuard, READ_SYNC_SCHEDULER_ALERTED_SETTING } from '../../lib/ops/read-sync-scheduler-guard.ts'
import type { ReadSyncAlarmTx } from '../../lib/ops/read-sync-liveness-alarm.ts'

/**
 * THE ALARM OF THE ALARM. `delivery-status` is in the installer's bootstrap crontab, so it runs on an
 * upgraded installation where the new alarm job is not yet scheduled; it calls this guard, which raises
 * ONE admin notification when a job the liveness report depends on is switched off or not really in the
 * crontab, and nothing when everything is in place.
 *
 * Mutations (see the PR): guard never alerts => "[guard] raises" red; dedupe removed => "[guard] once"
 * red; the route not calling the guard => "[route]" red.
 */

const defs = getAllCronJobs().map((job) => ({ slug: job.slug, settingKey: job.settingKey, label: job.label, defaultSchedule: job.defaultSchedule, defaultEnabled: job.defaultEnabled, legacyEnabledKey: job.legacyEnabledKey }))
const NEEDED = ['read-sync-liveness', 'wc-reconcile', 'mintsoft-dispatch-sync', 'wms-order-status', 'account-balance-snapshot', 'xero-tax-rate-drift', 'mintsoft-stock-sync', 'wms-watchdog']

function block(slugs: string[]): string {
  const jobs = defs.filter((job) => slugs.includes(job.slug))
  const built = buildOtiCrontabBlock({ jobs, settings: new Map(jobs.map((job) => [`cron_${job.settingKey}_enabled`, 'true'])), secretRef: { kind: 'env-file', envFilePath: '/opt/ims/.env' }, baseUrl: 'https://ims.example.com' })
  assert.ok(built.ok)
  return built.lines.join('\n') + '\n'
}

function inputs(text: string | null, over: Partial<ReadSyncInputs> = {}): ReadSyncInputs {
  const cronEnabled: Record<string, boolean> = { 'read-sync-liveness': true, 'wms-watchdog': true }
  for (const def of READ_SYNC_STREAMS) if (def.cronSlug) cronEnabled[def.cronSlug] = true
  return {
    settings: new Map(), pluginEnabled: { woocommerce: true, mintsoft: true, xero: true }, xeroConnected: true, cronEnabled,
    bindings: [{ id: 'b', warehouseCode: 'W', syncFrequencyMinutes: 60, lastStockSyncSuccessAt: null }], lastDispatchSuccessAt: null,
    cronJobDefs: defs, cronSchedules: {},
    crontab: text === null ? { resolved: false, reason: 'crontab -l failed' } : { resolved: true, text },
    ...over,
  }
}

function rig() {
  const settings = new Map<string, string>()
  const delivered: Array<{ title: string; message: string }> = []
  const logged: string[] = []
  const sql: string[] = []
  const order: string[] = []
  const makeTx = (): ReadSyncAlarmTx => ({
    $executeRawUnsafe: async (statement: string) => { sql.push(statement); order.push('sql') },
    setting: {
      findMany: async ({ where }) => { order.push('read'); return where.key.in.filter((k) => settings.has(k)).map((key) => ({ key, value: settings.get(key)! })) },
      deleteMany: async ({ where }) => { settings.delete(where.key) },
      createMany: async ({ data }) => { let count = 0; for (const r of data) if (!settings.has(r.key)) { settings.set(r.key, r.value); count += 1 } return { count } },
      updateMany: async ({ where, data }) => { if (settings.get(where.key) !== where.value) return { count: 0 }; settings.set(where.key, data.value); return { count: 1 } },
    },
  })
  const deps = {
    db: {
      setting: {
        findMany: async () => { throw new Error('the guard must not read outside a bounded transaction') },
        upsert: async () => undefined,
        updateMany: async () => ({ count: 0 }),
        deleteMany: async () => { throw new Error('the guard must not write outside a bounded transaction') },
      },
      $transaction: async <T>(fn: (tx: ReadSyncAlarmTx) => Promise<T>) => {
        const snapshot = new Map(settings)
        try { return await fn(makeTx()) } catch (e) { settings.clear(); for (const [k, v] of snapshot) settings.set(k, v); throw e }
      },
    },
    readCrontab: async () => ({ resolved: true as const, text: '' }),
    notifyAdmins: async (_tx: ReadSyncAlarmTx, title: string, message: string) => { delivered.push({ title, message }) },
    logWarning: async (_tx: ReadSyncAlarmTx, entry: { description: string }) => { logged.push(entry.description) },
  }
  return { settings, delivered, logged, sql, order, deps }
}

test('[guard] an upgraded installation (block present, alarm job missing) raises one notification naming the remedy', async () => {
  const r = rig()
  const result = await runSchedulerCoverageGuard({ ...r.deps, readInputs: async () => inputs(block(NEEDED.filter((s) => s !== 'read-sync-liveness'))) })
  console.log(`precondition: ${JSON.stringify(result)} delivered=${r.delivered.length}`)
  assert.equal(result.status, 'ALERTED')
  assert.equal(r.delivered.length, 1)
  assert.match(r.delivered[0]!.message, /enabled but not scheduled: read-sync-liveness/)
  assert.match(r.delivered[0]!.message, /Save & Apply/)
  assert.match(r.delivered[0]!.message, /may not be reported/, 'hedged: it does not claim a feed has stopped')
  assert.equal(r.logged.length, 1)
})

test('[guard] a missing watchdog while the stock sync is in play, and a switched-off one, are both raised', async () => {
  const noWatchdog = rig()
  assert.equal((await runSchedulerCoverageGuard({ ...noWatchdog.deps, readInputs: async () => inputs(block(NEEDED.filter((s) => s !== 'wms-watchdog'))) })).status, 'ALERTED')
  assert.match(noWatchdog.delivered[0]!.message, /wms-watchdog/)
  const off = rig()
  const base = inputs(block(NEEDED))
  assert.equal((await runSchedulerCoverageGuard({ ...off.deps, readInputs: async () => ({ ...base, cronEnabled: { ...base.cronEnabled, 'wms-watchdog': false } }) })).status, 'ALERTED')
  assert.match(off.delivered[0]!.message, /switched off: wms-watchdog/)
})

test('[guard] everything in place raises nothing and forgets an earlier breach; an unexamined scheduler raises nothing', async () => {
  const r = rig()
  r.settings.set(READ_SYNC_SCHEDULER_ALERTED_SETTING, 'scheduler:old')
  const ok = await runSchedulerCoverageGuard({ ...r.deps, readInputs: async () => inputs(block(NEEDED)) })
  assert.equal(ok.status, 'OK')
  assert.equal(r.delivered.length, 0)
  assert.equal(r.settings.has(READ_SYNC_SCHEDULER_ALERTED_SETTING), false)
  const noCrontabInput = await runSchedulerCoverageGuard({ ...r.deps, readInputs: async () => inputs(null, { crontab: undefined }) })
  assert.equal(noCrontabInput.status, 'NOT_EXAMINED', 'no crontab was examined at all: nothing to say')
  assert.equal(r.delivered.length, 0)
})

test('[guard] once per distinct problem; a changed problem alerts again', async () => {
  const r = rig()
  const missingAlarm = () => inputs(block(NEEDED.filter((s) => s !== 'read-sync-liveness')))
  assert.equal((await runSchedulerCoverageGuard({ ...r.deps, readInputs: async () => missingAlarm() })).status, 'ALERTED')
  assert.equal((await runSchedulerCoverageGuard({ ...r.deps, readInputs: async () => missingAlarm() })).status, 'ALREADY_ALERTED')
  assert.equal(r.delivered.length, 1)
  assert.equal((await runSchedulerCoverageGuard({ ...r.deps, readInputs: async () => inputs(block(NEEDED.filter((s) => s !== 'read-sync-liveness' && s !== 'wc-reconcile'))) })).status, 'ALERTED')
  assert.equal(r.delivered.length, 2)
})

test('[bounded] every database read of the guard runs after SET LOCAL statement_timeout, inside a transaction; the crontab is read outside it', async () => {
  const r = rig()
  r.deps.readCrontab = async () => { r.order.push('crontab'); return { resolved: true as const, text: '' } }
  const readInputs = async (client: ReadSyncAlarmTx) => {
    assert.equal(typeof client.$executeRawUnsafe, 'function', 'readInputs is handed the bounded client')
    r.order.push('readInputs')
    return inputs(block(NEEDED))
  }
  const result = await runSchedulerCoverageGuard({ ...r.deps, readInputs })
  console.log(`precondition: ${JSON.stringify(result)} order=${JSON.stringify(r.order)} sql=${JSON.stringify(r.sql)}`)
  assert.equal(result.status, 'OK')
  assert.deepEqual(r.order.slice(0, 3), ['crontab', 'sql', 'readInputs'], 'crontab first, outside; then the timeout is set; then the reads')
  assert.ok(r.sql.every((statement) => /^SET LOCAL statement_timeout = 5000$/.test(statement)), 'the single-sourced 5000 ms bound')
  assert.ok(r.sql.length >= 1)
})

test('[observers] two observers alternating healthy and unreadable raise at most one notice each per UTC day, and never clear one another', async () => {
  const r = rig()
  const clock = new Date('2026-10-08T10:00:00Z')
  const as = (observer: string, readable: boolean) => runSchedulerCoverageGuard({
    ...r.deps, observer, now: () => clock,
    readInputs: async () => inputs(readable ? block(NEEDED) : null),
  })
  // A cannot read, B can; they alternate through the day.
  const outcomes: string[] = []
  for (let i = 0; i < 4; i += 1) {
    outcomes.push(`A:${(await as('aaaaaaaa', false)).status}`)
    outcomes.push(`B:${(await as('bbbbbbbb', true)).status}`)
  }
  console.log(`precondition: ${JSON.stringify(outcomes)} notifications=${r.delivered.length}`)
  assert.equal(r.delivered.length, 1, 'A alerted once; B (healthy) neither alerts nor clears A')
  assert.equal(outcomes.filter((o) => o === 'A:ALERTED').length, 1)
  assert.equal(r.settings.get('read_sync_scheduler_alerted_unverified_aaaaaaaa'), 'unverified:2026-10-08', "B never deleted A's reminder state")
  // Now B loses its crontab too: one notice for B; A stays quiet the same day.
  for (let i = 0; i < 3; i += 1) { await as('bbbbbbbb', false); await as('aaaaaaaa', false) }
  assert.equal(r.delivered.length, 2, 'one per observer per UTC day')
  assert.notEqual(r.delivered[0]!.message, undefined)
})

test('[suppression] the documented setting silences the unverifiable reminder for a known structural limitation, and only that', async () => {
  const r = rig()
  r.settings.set('read_sync_scheduler_guard_expect_unreadable', 'true')
  const quiet = await runSchedulerCoverageGuard({ ...r.deps, observer: 'cccccccc', readInputs: async () => inputs(null) })
  assert.equal(quiet.status, 'NOT_EXAMINED')
  assert.equal(r.delivered.length, 0)
  // A readable crontab with a real problem is still raised.
  const real = await runSchedulerCoverageGuard({ ...r.deps, observer: 'cccccccc', readInputs: async () => inputs(block(NEEDED.filter((slug) => slug !== 'read-sync-liveness'))) })
  assert.equal(real.status, 'ALERTED')
})

// ---- the route: the job that is scheduled everywhere starts the guard FIRST and cannot be delayed by it ----
const events: string[] = []
let coreGate: Promise<void> = Promise.resolve()
let guardPromise: () => Promise<unknown> = async () => ({ status: 'OK', problems: [] })
mock.module('@/lib/cron-auth', { namedExports: { verifyCron: async () => null } })
mock.module('@/lib/cron-rate-limit', { namedExports: { enforceCronRateLimit: async () => null, CRON_RATE_LIMIT_FIFTEEN_MINUTE_MAX: 4 } })
mock.module('@/lib/maintenance-mode', { namedExports: { getMaintenanceModeResponse: async () => null } })
mock.module('@/lib/trackship', { namedExports: { checkDeliveryStatus: async () => { events.push('core:start'); await coreGate; events.push('core:end'); return { checked: 0 } } } })
mock.module('@/lib/ops/read-sync-scheduler-guard', {
  namedExports: {
    startSchedulerCoverageGuard: () => { events.push('guard:start'); return guardPromise() },
  },
})

test('[route] a STALLED delivery poll cannot prevent the guard: it has already started', async () => {
  events.length = 0
  let release!: () => void
  coreGate = new Promise<void>((resolve) => { release = resolve })
  guardPromise = async () => ({ status: 'OK', problems: [] })
  const { GET } = await import('../../app/api/cron/delivery-status/route.ts')
  const pending = GET(new Request('http://localhost/api/cron/delivery-status'))
  await new Promise((resolve) => setTimeout(resolve, 50)) // let the handler reach the stalled poll
  console.log(`precondition: events while the core poll is still stalled = ${JSON.stringify(events)}`)
  assert.deepEqual(events, ['guard:start', 'core:start'], 'the guard started before the core work, and the core work is still stalled')
  release()
  const response = await pending
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { checked: 0 })
})

test('[route] the guard is NEVER awaited: a slow guard adds nothing to the response, a failing guard changes nothing', async () => {
  const { GET } = await import('../../app/api/cron/delivery-status/route.ts')
  const answer = async () => {
    const startedAt = Date.now()
    const response = await GET(new Request('http://localhost/api/cron/delivery-status'))
    return { elapsed: Date.now() - startedAt, response }
  }

  events.length = 0; coreGate = Promise.resolve()
  guardPromise = () => new Promise((resolve) => setTimeout(() => resolve({ status: 'OK', problems: [] }), 2_000)) // slow guard
  const slow = await answer()
  console.log(`precondition: answered in ${slow.elapsed}ms with a guard that takes 2000ms`)
  assert.equal(slow.response.status, 200)
  assert.deepEqual(await slow.response.json(), { checked: 0 })
  assert.ok(slow.elapsed < 500, `the response was not delayed by the guard (${slow.elapsed}ms)`)

  guardPromise = () => Promise.reject(new Error('guard exploded')) // rejecting promise: no unhandled rejection, same answer
  const rejecting = await answer()
  assert.equal(rejecting.response.status, 200)
  assert.deepEqual(await rejecting.response.json(), { checked: 0 })

  guardPromise = () => { throw new Error('guard threw synchronously') }
  const throwing = await answer()
  assert.equal(throwing.response.status, 200)
  assert.deepEqual(await throwing.response.json(), { checked: 0 })
})

test('[guard] an unreadable crontab raises ONE distinct "could not be verified" reminder per UTC day, not per run', async () => {
  const r = rig()
  let clock = new Date('2026-10-08T10:00:00Z')
  const run = () => runSchedulerCoverageGuard({ ...r.deps, now: () => clock, readInputs: async () => inputs(null) })
  const first = await run()
  console.log(`precondition: ${JSON.stringify(first)} delivered=${r.delivered.length}`)
  assert.equal(first.status, 'ALERTED')
  assert.equal(r.delivered[0]!.title, 'Scheduler coverage could not be verified')
  assert.match(r.delivered[0]!.message, /npm run read-sync:status/)
  assert.match(r.delivered[0]!.message, /at most once a day/)
  clock = new Date('2026-10-08T23:59:00Z')
  assert.equal((await run()).status, 'ALREADY_ALERTED')
  assert.equal(r.delivered.length, 1, 'same day: no repeat')
  clock = new Date('2026-10-09T00:01:00Z')
  assert.equal((await run()).status, 'ALERTED')
  assert.equal(r.delivered.length, 2, 'next day: one reminder')
  // Once readable and healthy the reminder state is forgotten.
  const ok = await runSchedulerCoverageGuard({ ...r.deps, now: () => clock, readInputs: async () => inputs(block(NEEDED)) })
  assert.equal(ok.status, 'OK')
  assert.equal(r.settings.has(READ_SYNC_SCHEDULER_ALERTED_SETTING), false)
  assert.equal([...r.settings.keys()].some((key) => key.includes('_unverified_')), false, 'this observer\'s own reminder state was forgotten')
})
