import assert from 'node:assert/strict'
import test from 'node:test'

import { GET, handleInventorySnapshotCron } from '@/app/api/cron/inventory-snapshot/route'
import { getAllCronJobs } from '@/lib/cron-jobs'
import { previousUtcDate } from '@/lib/domain/inventory/inventory-snapshot'

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
  return new Request('https://ims.example.com/api/cron/inventory-snapshot', { headers })
}

test('inventory snapshot cron rejects requests without the cron secret', async () => {
  await withCronEnv({ CRON_SECRET: 'secret-token', NODE_ENV: 'production' }, async () => {
    const response = await GET(cronRequest())

    assert.equal(response.status, 401)
  })
})

test('inventory snapshot is registered as a daily scheduled system cron job', () => {
  const job = getAllCronJobs().find((entry) => entry.slug === 'inventory-snapshot')

  assert.ok(job)
  assert.equal(job.settingKey, 'inventory_snapshot')
  assert.equal(job.module, 'system')
  assert.equal(job.defaultSchedule, '0 5 * * *')
  assert.equal(job.defaultEnabled, false)
})

test('inventory snapshot cron snapshots the previous UTC day', async () => {
  await withCronEnv({ CRON_SECRET: 'secret-token', NODE_ENV: 'production' }, async () => {
    const snapshotDates: string[] = []
    const response = await handleInventorySnapshotCron(
      cronRequest('Bearer secret-token'),
      {
        now: () => new Date('2026-05-28T00:05:00.000Z'),
        createRunId: () => 'run-inventory-snapshot-test',
        writeLog: async () => {},
        getMaintenanceResponse: async () => null,
        writeSnapshot: async (options = {}) => {
          const { snapshotDate } = options
          assert.ok(snapshotDate instanceof Date)
          snapshotDates.push(snapshotDate.toISOString())
          return {
            snapshotDate: snapshotDate.toISOString().slice(0, 10),
            snapshotsWritten: 1,
            driftCount: 0,
            driftTruncated: false,
            drift: [],
          }
        },
      },
    )

    assert.equal(response.status, 200)
    assert.deepEqual(snapshotDates, ['2026-05-27T00:00:00.000Z'])
    assert.equal((await response.json() as { runId: string }).runId, 'run-inventory-snapshot-test')
  })
})

test('previousUtcDate normalizes to UTC midnight before subtracting a day', () => {
  assert.equal(
    previousUtcDate(new Date('2026-05-28T23:59:59.999Z')).toISOString(),
    '2026-05-27T00:00:00.000Z',
  )
})
