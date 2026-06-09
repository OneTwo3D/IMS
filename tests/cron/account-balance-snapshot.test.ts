import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GET,
  handleAccountBalanceSnapshotCron,
  previousAccountBalanceSnapshotDate,
} from '@/app/api/cron/account-balance-snapshot/route'
import { getAllCronJobs } from '@/lib/cron-jobs'
import type { CronRunLog } from '@/lib/ops/cron-run'

type CronEnv = {
  CRON_SECRET?: string
  NODE_ENV?: string
}

const ENV_KEYS = ['CRON_SECRET', 'NODE_ENV'] as const

async function withCronEnv(env: CronEnv, fn: () => Promise<void>): Promise<void> {
  const mutableEnv = process.env as Record<string, string | undefined>
  const previous = Object.fromEntries(
    ENV_KEYS.map((key) => [key, mutableEnv[key]]),
  ) as Record<(typeof ENV_KEYS)[number], string | undefined>

  try {
    for (const key of ENV_KEYS) {
      if (env[key] === undefined) {
        delete mutableEnv[key]
      } else {
        mutableEnv[key] = env[key]
      }
    }
    await fn()
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) {
        delete mutableEnv[key]
      } else {
        mutableEnv[key] = previous[key]
      }
    }
  }
}

function cronRequest(authorization?: string): Request {
  const headers = new Headers({ host: 'ims.example.com' })
  if (authorization) headers.set('authorization', authorization)
  return new Request('https://ims.example.com/api/cron/account-balance-snapshot', { headers })
}

test('account balance snapshot cron rejects requests without the cron secret', async () => {
  await withCronEnv({ CRON_SECRET: 'secret-token', NODE_ENV: 'production' }, async () => {
    const response = await GET(cronRequest())

    assert.equal(response.status, 401)
  })
})

test('account balance snapshot is registered as a daily scheduled accounting cron job', () => {
  const job = getAllCronJobs().find((entry) => entry.slug === 'account-balance-snapshot')

  assert.ok(job)
  assert.equal(job.settingKey, 'xero_account_balance_snapshot')
  assert.equal(job.module, 'accounting')
  assert.equal(job.defaultSchedule, '0 1 * * *')
  assert.equal(job.defaultEnabled, true)
})

test('account balance snapshot cron syncs the previous UTC day', async () => {
  await withCronEnv({ CRON_SECRET: 'secret-token', NODE_ENV: 'production' }, async () => {
    const calls: Array<{ balanceDate?: Date | string; syncRunId?: string }> = []
    const logs: CronRunLog[] = []
    const response = await handleAccountBalanceSnapshotCron(
      cronRequest('Bearer secret-token'),
      {
        now: () => new Date('2026-06-02T00:05:00.000Z'),
        createRunId: () => 'run-account-balance-snapshot-test',
        writeLog: async (log) => {
          logs.push(log)
        },
        checkCronRateLimit: async () => ({ allowed: true, retryAfterSec: 0, remaining: 0 }),
        getMaintenanceResponse: async () => null,
        syncSnapshots: async (options = {}) => {
          calls.push(options)
          return { fetched: 4, persisted: 2, skipped: 0, errors: [] }
        },
      },
    )

    assert.equal(response.status, 200)
    assert.deepEqual(calls, [{ balanceDate: '2026-06-01', syncRunId: 'run-account-balance-snapshot-test' }])
    assert.equal(logs.length, 1)
    assert.deepEqual(logs[0]?.counts, { fetched: 4, persisted: 2, skipped: 0, errors: 0 })
    const payload = await response.json() as { balanceDate: string; runId: string; persisted: number }
    assert.deepEqual(payload, {
      balanceDate: '2026-06-01',
      fetched: 4,
      persisted: 2,
      skipped: 0,
      errors: [],
      runId: 'run-account-balance-snapshot-test',
    })
  })
})

test('account balance snapshot cron records connector errors as failed runs', async () => {
  await withCronEnv({ CRON_SECRET: 'secret-token', NODE_ENV: 'production' }, async () => {
    const logs: CronRunLog[] = []
    const response = await handleAccountBalanceSnapshotCron(
      cronRequest('Bearer secret-token'),
      {
        now: () => new Date('2026-06-02T00:05:00.000Z'),
        createRunId: () => 'run-account-balance-snapshot-error-test',
        writeLog: async (log) => {
          logs.push(log)
        },
        checkCronRateLimit: async () => ({ allowed: true, retryAfterSec: 0, remaining: 0 }),
        getMaintenanceResponse: async () => null,
        syncSnapshots: async () => ({ fetched: 0, persisted: 0, skipped: 0, errors: ['Xero Trial Balance unavailable'] }),
      },
    )

    assert.equal(response.status, 500)
    assert.equal(logs[0]?.status, 'failed')
    assert.equal(logs[0]?.statusReason, 'Xero Trial Balance unavailable')
  })
})

test('previousAccountBalanceSnapshotDate normalizes to UTC midnight before subtracting a day', () => {
  assert.equal(previousAccountBalanceSnapshotDate(new Date('2026-06-02T23:59:59.999Z')), '2026-06-01')
})
