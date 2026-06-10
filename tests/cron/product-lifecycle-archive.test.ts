import assert from 'node:assert/strict'
import test from 'node:test'

import { GET, handleProductLifecycleArchiveCron } from '@/app/api/cron/product-lifecycle-archive/route'
import { getAllCronJobs } from '@/lib/cron-jobs'
import type { ArchiveExhaustedEolProductsResult } from '@/lib/domain/inventory/product-lifecycle-archive'
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
  return new Request('https://ims.example.com/api/cron/product-lifecycle-archive', { headers })
}

test('product lifecycle archive cron rejects requests without the cron secret', async () => {
  await withCronEnv({ CRON_SECRET: 'secret-token', NODE_ENV: 'production' }, async () => {
    const response = await GET(cronRequest())

    assert.equal(response.status, 401)
  })
})

test('product lifecycle archive is registered as a daily scheduled system cron job', () => {
  const job = getAllCronJobs().find((entry) => entry.slug === 'product-lifecycle-archive')

  assert.ok(job)
  assert.equal(job.settingKey, 'product_lifecycle_archive')
  assert.equal(job.module, 'system')
  assert.equal(job.defaultSchedule, '30 0 * * *')
  assert.equal(job.defaultEnabled, true)
})

test('product lifecycle archive cron logs archive counts', async () => {
  await withCronEnv({ CRON_SECRET: 'secret-token', NODE_ENV: 'production' }, async () => {
    const logs: CronRunLog[] = []
    const archiveCalls: Array<{ now?: Date }> = []
    const result: ArchiveExhaustedEolProductsResult = {
      scanned: 3,
      archived: 1,
      skippedWithStock: 1,
      skippedWithIncoming: 1,
    }

    const response = await handleProductLifecycleArchiveCron(
      cronRequest('Bearer secret-token'),
      {
        now: () => new Date('2026-06-10T00:35:00.000Z'),
        createRunId: () => 'run-product-lifecycle-archive-test',
        writeLog: async (log) => {
          logs.push(log)
        },
        checkCronRateLimit: async () => ({ allowed: true, retryAfterSec: 0, remaining: 0 }),
        getMaintenanceResponse: async () => null,
        archiveProducts: async (options = {}) => {
          archiveCalls.push({ now: options.now })
          return result
        },
      },
    )

    assert.equal(response.status, 200)
    assert.deepEqual(archiveCalls.map((call) => call.now?.toISOString()), [
      '2026-06-10T00:35:00.000Z',
    ])
    assert.equal(logs.length, 1)
    assert.equal(logs[0]?.runId, 'run-product-lifecycle-archive-test')
    assert.equal(logs[0]?.jobName, 'product-lifecycle-archive')
    assert.deepEqual(logs[0]?.counts, result)
    assert.equal(
      logs[0]?.statusReason,
      'Scanned 3 EOL product(s); archived 1; skipped 1 with stock; skipped 1 with incoming stock',
    )

    const payload = await response.json() as ArchiveExhaustedEolProductsResult & { runId: string }
    assert.deepEqual(payload, {
      ...result,
      runId: 'run-product-lifecycle-archive-test',
    })
  })
})
