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
const NEEDED = ['read-sync-liveness', 'wc-reconcile', 'wms-order-status', 'account-balance-snapshot', 'xero-tax-rate-drift', 'mintsoft-stock-sync', 'wms-watchdog']

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
  const deps = {
    db: {
      setting: {
        findMany: async ({ where }: { where: { key: { in: string[] } } }) => where.key.in.filter((k) => settings.has(k)).map((key) => ({ key, value: settings.get(key)! })),
        upsert: async () => undefined,
        deleteMany: async ({ where }: { where: { key: string } }) => { settings.delete(where.key) },
      },
      $transaction: async <T>(fn: (tx: ReadSyncAlarmTx) => Promise<T>) => {
        const snapshot = new Map(settings)
        try {
          return await fn({
            setting: {
              createMany: async ({ data }: { data: Array<{ key: string; value: string }> }) => { let count = 0; for (const r of data) if (!settings.has(r.key)) { settings.set(r.key, r.value); count += 1 } return { count } },
              updateMany: async ({ where, data }: { where: { key: string; value: string }; data: { value: string } }) => { if (settings.get(where.key) !== where.value) return { count: 0 }; settings.set(where.key, data.value); return { count: 1 } },
            },
          })
        } catch (e) { settings.clear(); for (const [k, v] of snapshot) settings.set(k, v); throw e }
      },
    },
    notifyAdmins: async (_tx: ReadSyncAlarmTx, title: string, message: string) => { delivered.push({ title, message }) },
    logWarning: async (_tx: ReadSyncAlarmTx, entry: { description: string }) => { logged.push(entry.description) },
  }
  return { settings, delivered, logged, deps }
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

test('[guard] everything in place raises nothing and forgets an earlier breach; an unreadable crontab raises nothing', async () => {
  const r = rig()
  r.settings.set(READ_SYNC_SCHEDULER_ALERTED_SETTING, 'scheduler:old')
  const ok = await runSchedulerCoverageGuard({ ...r.deps, readInputs: async () => inputs(block(NEEDED)) })
  assert.equal(ok.status, 'OK')
  assert.equal(r.delivered.length, 0)
  assert.equal(r.settings.has(READ_SYNC_SCHEDULER_ALERTED_SETTING), false)
  const unreadable = await runSchedulerCoverageGuard({ ...r.deps, readInputs: async () => inputs(null) })
  assert.equal(unreadable.status, 'NOT_EXAMINED')
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

// ---- the route: the job that is scheduled everywhere calls the guard, and cannot be broken by it ----
let guardCalls = 0
mock.module('@/lib/cron-auth', { namedExports: { verifyCron: async () => null } })
mock.module('@/lib/cron-rate-limit', { namedExports: { enforceCronRateLimit: async () => null, CRON_RATE_LIMIT_FIFTEEN_MINUTE_MAX: 4 } })
mock.module('@/lib/maintenance-mode', { namedExports: { getMaintenanceModeResponse: async () => null } })
mock.module('@/lib/trackship', { namedExports: { checkDeliveryStatus: async () => ({ checked: 0 }) } })
mock.module('@/lib/ops/read-sync-scheduler-guard', {
  namedExports: { runSchedulerCoverageGuardSafely: async () => { guardCalls += 1; return { status: 'OK', problems: [] } } },
})

test('[route] delivery-status runs the scheduler guard after its own work and still answers', async () => {
  guardCalls = 0
  const { GET } = await import('../../app/api/cron/delivery-status/route.ts')
  const response = await GET(new Request('http://localhost/api/cron/delivery-status'))
  console.log(`precondition: status=${response.status} guardCalls=${guardCalls}`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { checked: 0 })
  assert.equal(guardCalls, 1)
})
