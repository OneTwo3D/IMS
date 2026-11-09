import assert from 'node:assert/strict'
import test from 'node:test'

import { GET, handleXeroChartSyncCron } from '@/app/api/cron/xero-chart-sync/route'
import { getAllCronJobs } from '@/lib/cron-jobs'
import { XERO_LIVE_CRON_JOBS } from '@/lib/cron-rate-limit'
import type { CronRunLog } from '@/lib/ops/cron-run'
import { getReadSyncStream, XERO_CHART_OF_ACCOUNTS_LAST_SUCCESS_SETTING } from '@/lib/ops/read-sync-liveness-constants'

const ENV_KEYS = ['CRON_SECRET', 'NODE_ENV'] as const

async function withCronEnv(fn: () => Promise<void>): Promise<void> {
  const env = process.env as Record<string, string | undefined>
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, env[key]]))
  try {
    env.CRON_SECRET = 'secret-token'
    env.NODE_ENV = 'production'
    await fn()
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete env[key]
      else env[key] = previous[key]
    }
  }
}

function cronRequest(authorization?: string): Request {
  const headers = new Headers({ host: 'ims.example.com' })
  if (authorization) headers.set('authorization', authorization)
  return new Request('https://ims.example.com/api/cron/xero-chart-sync', { headers })
}

const baseOptions = (logs: CronRunLog[]) => ({
  now: () => new Date('2026-06-02T00:30:00.000Z'),
  createRunId: () => 'run-xero-chart-sync-test',
  writeLog: async (log: CronRunLog) => { logs.push(log) },
  checkCronRateLimit: async () => ({ allowed: true, retryAfterSec: 0, remaining: 0 }),
  getMaintenanceResponse: async () => null,
  isPluginEnabled: async () => true,
  isConnected: async () => true,
})

test('chart sync cron rejects requests without the cron secret', async () => {
  await withCronEnv(async () => {
    assert.equal((await GET(cronRequest())).status, 401)
  })
})

test('chart sync is a daily accounting job ahead of the 01:00 balance snapshot, counted as a live Xero job', () => {
  const job = getAllCronJobs().find((entry) => entry.slug === 'xero-chart-sync')
  assert.ok(job)
  assert.equal(job.module, 'accounting')
  assert.equal(job.defaultSchedule, '30 0 * * *')
  assert.equal(job.defaultEnabled, true)
  assert.ok(XERO_LIVE_CRON_JOBS.has('xero-chart-sync'))
})

test('chart sync is a read-sync stream driven by that job and its own stamp', () => {
  const stream = getReadSyncStream('xero-chart-of-accounts')
  assert.equal(stream.cronSlug, 'xero-chart-sync')
  assert.deepEqual(stream.source, { kind: 'setting', key: XERO_CHART_OF_ACCOUNTS_LAST_SUCCESS_SETTING })
  assert.equal(stream.alarm, 'read-sync-liveness')
})

test('chart sync cron runs the refresh as the scheduled one and records counts', async () => {
  await withCronEnv(async () => {
    const logs: CronRunLog[] = []
    const calls: unknown[] = []
    const response = await handleXeroChartSyncCron(cronRequest('Bearer secret-token'), {
      ...baseOptions(logs),
      syncChart: async (options) => { calls.push(options); return { synced: 42, errors: [] } },
    })
    assert.equal(response.status, 200)
    assert.deepEqual(calls, [{ recordScheduledSuccess: true }])
    assert.equal(logs[0]?.status, 'completed')
    assert.deepEqual(logs[0]?.counts, { synced: 42, errors: 0 })
  })
})

test('chart sync cron records a failed read as a failed run', async () => {
  await withCronEnv(async () => {
    const logs: CronRunLog[] = []
    const response = await handleXeroChartSyncCron(cronRequest('Bearer secret-token'), {
      ...baseOptions(logs),
      syncChart: async () => ({ synced: 0, errors: ['Xero Accounts unavailable'] }),
    })
    assert.equal(response.status, 500)
    assert.equal(logs[0]?.status, 'failed')
    assert.equal(logs[0]?.statusReason, 'Xero Accounts unavailable')
  })
})

test('chart sync cron skips, without calling Xero, when the plugin is off or Xero is not connected', async () => {
  await withCronEnv(async () => {
    for (const [label, over] of [
      ['plugin off', { isPluginEnabled: async () => false }],
      ['not connected', { isConnected: async () => false }],
    ] as const) {
      const logs: CronRunLog[] = []
      let called = false
      const response = await handleXeroChartSyncCron(cronRequest('Bearer secret-token'), {
        ...baseOptions(logs),
        ...over,
        syncChart: async () => { called = true; return { synced: 0, errors: [] } },
      })
      assert.equal(response.status, 200, label)
      assert.equal(called, false, label)
      assert.equal(logs[0]?.status, 'skipped', label)
    }
  })
})
