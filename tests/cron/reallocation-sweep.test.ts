import assert from 'node:assert/strict'
import test from 'node:test'

import { GET } from '@/app/api/cron/reallocation-sweep/route'
import { getAllCronJobs } from '@/lib/cron-jobs'

const ENV_KEYS = ['CRON_SECRET', 'NODE_ENV'] as const

async function withCronEnv(
  env: { CRON_SECRET?: string; NODE_ENV?: string },
  fn: () => Promise<void>,
): Promise<void> {
  const mutableEnv = process.env as Record<string, string | undefined>
  const previous = Object.fromEntries(ENV_KEYS.map((k) => [k, mutableEnv[k]])) as Record<
    (typeof ENV_KEYS)[number],
    string | undefined
  >
  try {
    for (const key of ENV_KEYS) {
      if (env[key] === undefined) delete mutableEnv[key]
      else mutableEnv[key] = env[key]
    }
    await fn()
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete mutableEnv[key]
      else mutableEnv[key] = previous[key]
    }
  }
}

function cronRequest(authorization?: string): Request {
  const headers = new Headers({ host: 'ims.example.com' })
  if (authorization) headers.set('authorization', authorization)
  return new Request('https://ims.example.com/api/cron/reallocation-sweep', { headers })
}

test('reallocation sweep cron rejects requests without the cron secret (o3d-9lx)', async () => {
  await withCronEnv({ CRON_SECRET: 'secret-token', NODE_ENV: 'production' }, async () => {
    const response = await GET(cronRequest())
    assert.equal(response.status, 401)
  })
})

test('reallocation sweep is registered as a scheduled system cron job (o3d-9lx)', () => {
  const job = getAllCronJobs().find((entry) => entry.slug === 'reallocation-sweep')
  assert.ok(job, 'reallocation-sweep must be registered')
  assert.equal(job.settingKey, 'reallocation_sweep')
  assert.equal(job.module, 'system')
  assert.equal(job.defaultSchedule, '*/15 * * * *')
  assert.equal(job.defaultEnabled, true)
})
