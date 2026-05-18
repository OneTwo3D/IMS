import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '../../app/generated/prisma/client.ts'
import {
  appendCronRunId,
  cronRunResponseInit,
  findCronRunByRunId,
  inferCronRunOutcome,
  listRecentCronRuns,
  persistCronRunLog,
  runCronWithLogging,
  type CronRunRecord,
  type CronRunLog,
  type CronRunPersistenceClient,
} from '../../lib/ops/cron-run.ts'
import { purgeExpiredCronRuns } from '../../lib/activity-log-cleanup.ts'

function cronRunRecord(overrides: Partial<CronRunRecord> = {}): CronRunRecord {
  return {
    id: 'cron-run-1',
    runId: 'run-1',
    jobName: 'fx-rates',
    startedAt: new Date('2026-04-28T12:00:00.000Z'),
    finishedAt: new Date('2026-04-28T12:00:05.000Z'),
    durationMs: 5000,
    status: 'completed',
    countsJson: { updated: 3 },
    statusReason: null,
    createdAt: new Date('2026-04-28T12:00:05.000Z'),
    ...overrides,
  }
}

function createCronRunPersistenceClient(options: {
  cronRunCreate?: (args: unknown) => Promise<unknown>
  activityLogCreate?: (args: unknown) => Promise<unknown>
  findUnique?: (args: unknown) => Promise<CronRunRecord | null>
  findMany?: (args: unknown) => Promise<CronRunRecord[]>
} = {}): { client: CronRunPersistenceClient; creates: Array<{ table: string; args: unknown }> } {
  const creates: Array<{ table: string; args: unknown }> = []
  const client: CronRunPersistenceClient = {
    cronRun: {
      async create(args: unknown) {
        creates.push({ table: 'cronRun', args })
        return options.cronRunCreate?.(args)
      },
      async findUnique(args: unknown) {
        return options.findUnique?.(args) ?? null
      },
      async findMany(args: unknown) {
        return options.findMany?.(args) ?? []
      },
    },
    activityLog: {
      async create(args: unknown) {
        creates.push({ table: 'activityLog', args })
        return options.activityLogCreate?.(args)
      },
    },
    async $transaction(fn) {
      return fn({
        cronRun: client.cronRun,
        activityLog: client.activityLog,
      })
    },
  }
  return { client, creates }
}

test('cron run helper persists run id and structured completion fields', async () => {
  const logs: CronRunLog[] = []
  const dates = [
    new Date('2026-04-28T12:00:00.000Z'),
    new Date('2026-04-28T12:00:05.000Z'),
  ]

  const result = await runCronWithLogging({
    jobName: 'fx-rates',
    createRunId: () => 'run-1',
    now: () => dates.shift() ?? new Date('2026-04-28T12:00:05.000Z'),
    writeLog: async (log) => {
      logs.push(log)
    },
    run: async ({ runId }) => ({
      runId,
      updated: 3,
      pushed: 2,
    }),
  })

  assert.equal(result.runId, 'run-1')
  assert.deepEqual(result.result, { runId: 'run-1', updated: 3, pushed: 2 })
  assert.equal(logs.length, 1)
  assert.deepEqual(logs[0], {
    runId: 'run-1',
    jobName: 'fx-rates',
    startedAt: '2026-04-28T12:00:00.000Z',
    finishedAt: '2026-04-28T12:00:05.000Z',
    durationMs: 5000,
    status: 'completed',
    counts: {
      updated: 3,
      pushed: 2,
    },
    statusReason: null,
  })
})

test('cron run helper logs skipped and failed outcomes without changing result bodies', async () => {
  const logs: CronRunLog[] = []

  const skipped = await runCronWithLogging({
    jobName: 'backup',
    createRunId: () => 'run-skip',
    writeLog: async (log) => {
      logs.push(log)
    },
    run: async () => ({ skipped: true, reason: 'disabled' }),
  })

  const failed = await runCronWithLogging({
    jobName: 'backup',
    createRunId: () => 'run-fail',
    getOutcome: () => ({ responseStatus: 500 }),
    writeLog: async (log) => {
      logs.push(log)
    },
    run: async () => ({ error: 'Backup creation failed' }),
  })

  assert.deepEqual(skipped.result, { skipped: true, reason: 'disabled' })
  assert.equal(failed.responseStatus, 500)
  assert.deepEqual(failed.result, { error: 'Backup creation failed' })
  assert.equal(logs[0]?.status, 'skipped')
  assert.equal(logs[0]?.statusReason, 'disabled')
  assert.equal(logs[1]?.status, 'failed')
  assert.equal(logs[1]?.statusReason, 'Backup creation failed')
})

test('cron run helper persists failure summaries before rethrowing unexpected errors', async () => {
  const logs: CronRunLog[] = []

  await assert.rejects(
    runCronWithLogging({
      jobName: 'wc-reconcile',
      createRunId: () => 'run-error',
      writeLog: async (log) => {
        logs.push(log)
      },
      run: async () => {
        throw new Error('connector unavailable')
      },
    }),
    /connector unavailable/,
  )

  assert.equal(logs.length, 1)
  assert.equal(logs[0]?.runId, 'run-error')
  assert.equal(logs[0]?.status, 'failed')
  assert.equal(logs[0]?.statusReason, 'connector unavailable')
  assert.equal(logs[0]?.durationMs, 0)
})

test('cron run helper clamps wall-clock backward durations to zero', async () => {
  const logs: CronRunLog[] = []
  const dates = [
    new Date('2026-04-28T12:00:05.000Z'),
    new Date('2026-04-28T12:00:00.000Z'),
  ]

  await runCronWithLogging({
    jobName: 'fx-rates',
    createRunId: () => 'run-1',
    now: () => dates.shift() ?? new Date('2026-04-28T12:00:00.000Z'),
    writeLog: async (log) => {
      logs.push(log)
    },
    run: async () => ({ updated: 1 }),
  })

  assert.equal(logs[0]?.durationMs, 0)
})

test('cron run helper surfaces structured persistence failures for successful runs', async () => {
  await assert.rejects(
    runCronWithLogging({
      jobName: 'fx-rates',
      createRunId: () => 'run-1',
      writeLog: async () => {
        throw new Error('cron run unavailable')
      },
      run: async () => ({ updated: 1 }),
    }),
    /cron run unavailable/,
  )
})

test('cron run helper persists CronRun row and preserves ActivityLog write', async () => {
  const { client, creates } = createCronRunPersistenceClient()

  await persistCronRunLog({
    runId: 'run-1',
    jobName: 'fx-rates',
    startedAt: '2026-04-28T12:00:00.000Z',
    finishedAt: '2026-04-28T12:00:05.000Z',
    durationMs: 5000,
    status: 'completed',
    counts: { updated: 3, nested: { skipped: 1, dryRun: false } },
    statusReason: null,
  }, client)

  assert.equal(creates.length, 2)
  assert.equal(creates[0].table, 'cronRun')
  assert.deepEqual((creates[0].args as { data: Record<string, unknown> }).data, {
    runId: 'run-1',
    jobName: 'fx-rates',
    startedAt: new Date('2026-04-28T12:00:00.000Z'),
    finishedAt: new Date('2026-04-28T12:00:05.000Z'),
    durationMs: 5000,
    status: 'completed',
    countsJson: { updated: 3, nested: { skipped: 1, dryRun: false } },
    statusReason: null,
  })
  assert.equal(creates[1].table, 'activityLog')
  assert.equal((creates[1].args as { data: Record<string, unknown> }).data.action, 'cron_run')
})

test('cron run persistence treats CronRun as canonical and does not mirror when insert fails', async () => {
  const { client, creates } = createCronRunPersistenceClient({
    cronRunCreate: async () => {
      throw new Error('cron run unavailable')
    },
  })

  await assert.rejects(
    persistCronRunLog({
      runId: 'run-1',
      jobName: 'fx-rates',
      startedAt: '2026-04-28T12:00:00.000Z',
      finishedAt: '2026-04-28T12:00:05.000Z',
      durationMs: 5000,
      status: 'failed',
      counts: null,
      statusReason: 'connector unavailable',
    }, client),
    /cron run unavailable/,
  )

  assert.equal(creates.length, 1)
  assert.equal(creates[0].table, 'cronRun')
})

test('cron run persistence preserves duplicate runId rejection before ActivityLog mirror', async () => {
  const duplicateRunIdError = Object.assign(new Error('Unique constraint failed on the fields: (`runId`)'), {
    code: 'P2002',
  })
  const { client, creates } = createCronRunPersistenceClient({
    cronRunCreate: async () => {
      throw duplicateRunIdError
    },
  })

  await assert.rejects(
    persistCronRunLog({
      runId: 'run-1',
      jobName: 'fx-rates',
      startedAt: '2026-04-28T12:00:00.000Z',
      finishedAt: '2026-04-28T12:00:05.000Z',
      durationMs: 5000,
      status: 'completed',
      counts: { updated: 3 },
      statusReason: null,
    }, client),
    (error) => error === duplicateRunIdError,
  )

  assert.deepEqual(creates.map((create) => create.table), ['cronRun'])
})

test('cron run persistence fails atomically when the ActivityLog mirror fails', async () => {
  const { client, creates } = createCronRunPersistenceClient({
    activityLogCreate: async () => {
      throw new Error('activity log unavailable')
    },
  })

  await assert.rejects(
    persistCronRunLog({
      runId: 'run-1',
      jobName: 'fx-rates',
      startedAt: '2026-04-28T12:00:00.000Z',
      finishedAt: '2026-04-28T12:00:05.000Z',
      durationMs: 5000,
      status: 'failed',
      counts: null,
      statusReason: 'connector unavailable',
    }, client),
    /activity log unavailable/,
  )

  assert.deepEqual(creates.map((create) => create.table), ['cronRun', 'activityLog'])
})

test('cron run persistence rejects non-object counts payloads at the boundary', async () => {
  const { client, creates } = createCronRunPersistenceClient()

  await assert.rejects(
    persistCronRunLog({
      runId: 'run-1',
      jobName: 'fx-rates',
      startedAt: '2026-04-28T12:00:00.000Z',
      finishedAt: '2026-04-28T12:00:05.000Z',
      durationMs: 5000,
      status: 'completed',
      counts: [1, 2, 3] as unknown as CronRunLog['counts'],
      statusReason: null,
    }, client),
    /cron run counts must be a JSON object, got array/,
  )

  assert.equal(creates.length, 0)
})

test('cron run persistence translates null counts to Prisma.JsonNull at the boundary', async () => {
  const { client, creates } = createCronRunPersistenceClient()

  await persistCronRunLog({
    runId: 'run-null-counts',
    jobName: 'backup',
    startedAt: '2026-04-28T12:00:00.000Z',
    finishedAt: '2026-04-28T12:00:05.000Z',
    durationMs: 5000,
    status: 'failed',
    counts: null,
    statusReason: 'Backup creation failed',
  }, client)

  assert.equal(creates.length, 2)
  assert.equal(creates[0].table, 'cronRun')
  const cronRunData = (creates[0].args as { data: Record<string, unknown> }).data
  assert.equal(cronRunData.countsJson, Prisma.JsonNull)
})

test('cron run query helpers use the structured CronRun table', async () => {
  const calls: unknown[] = []
  const expected = cronRunRecord()
  const { client } = createCronRunPersistenceClient({
    findUnique: async (args) => {
      calls.push(args)
      return expected
    },
    findMany: async (args) => {
      calls.push(args)
      return [expected]
    },
  })

  assert.equal(await findCronRunByRunId('run-1', client), expected)
  assert.deepEqual(await listRecentCronRuns({ jobName: 'fx-rates', status: 'completed', limit: 250 }, client), [expected])
  assert.deepEqual(calls[0], { where: { runId: 'run-1' } })
  assert.deepEqual(calls[1], {
    where: { jobName: 'fx-rates', status: 'completed' },
    orderBy: { startedAt: 'desc' },
    take: 100,
  })
})

test('cron run cleanup deletes records older than retention window', async () => {
  const calls: unknown[] = []

  const result = await purgeExpiredCronRuns({
    now: new Date('2026-05-01T00:00:00.000Z'),
    retentionDays: 90,
    client: {
      cronRun: {
        async deleteMany(args: unknown) {
          calls.push(args)
          return { count: 7 }
        },
      },
    },
  })

  assert.deepEqual(result, { deleted: 7, retentionDays: 90 })
  assert.deepEqual(calls[0], {
    where: {
      startedAt: { lt: new Date('2026-01-31T00:00:00.000Z') },
    },
  })
})

test('cron run migration constrains status values online', () => {
  const sql = readFileSync('prisma/migrations/20260517204500_cron_runs_status_check/migration.sql', 'utf8')

  assert.match(sql, /"cron_runs_status_check"[\s\S]+CHECK \("status" IN \('completed', 'failed', 'skipped'\)\) NOT VALID/)
  assert.match(sql, /VALIDATE CONSTRAINT "cron_runs_status_check"/)
})

test('cron run migration renames outcome text to statusReason', () => {
  const sql = readFileSync('prisma/migrations/20260517210500_cron_runs_status_reason/migration.sql', 'utf8')

  assert.match(sql, /RENAME COLUMN "errorSummary" TO "statusReason"/)
})

test('cron run helper appends run id to JSON response bodies', () => {
  assert.deepEqual(appendCronRunId({ ok: true }, 'run-1'), {
    ok: true,
    runId: 'run-1',
  })
})

test('cron run helper builds no-store response init without losing status or headers', () => {
  const init = cronRunResponseInit({
    status: 500,
    headers: {
      'X-Test': 'present',
    },
  })

  const headers = new Headers(init.headers)
  assert.equal(init.status, 500)
  assert.equal(headers.get('Cache-Control'), 'no-store')
  assert.equal(headers.get('X-Test'), 'present')
})

test('cron run helper infers invariant summaries and error arrays', () => {
  assert.deepEqual(
    inferCronRunOutcome({
      status: 'partial_failure',
      summary: { total: { total: 1, warning: 0, critical: 1, info: 0 } },
      errors: [{ message: 'inventory failed' }],
    }),
    {
      status: 'failed',
      counts: { total: { total: 1, warning: 0, critical: 1, info: 0 } },
      statusReason: 'inventory failed',
    },
  )
})

test('cron run helper infers nested WooCommerce section failures', () => {
  const outcome = inferCronRunOutcome({
    orders: { success: false, error: 'Order sync failed' },
    products: { imported: 2 },
    stock: { sync: { errors: ['Stock push failed'] } },
  })

  assert.equal(outcome.status, 'failed')
  assert.equal(outcome.statusReason, 'orders: Order sync failed; stock.sync: Stock push failed')
})

test('cron run helper infers non-empty failed arrays as failures', () => {
  assert.deepEqual(
    inferCronRunOutcome({
      success: true,
      updated: ['EUR'],
      failed: ['USD', 'CAD'],
    }),
    {
      status: 'failed',
      counts: { success: true },
      statusReason: 'failed: USD, CAD',
    },
  )
})

test('cron run helper preserves nested WooCommerce reconcile counts', () => {
  assert.deepEqual(
    inferCronRunOutcome({
      orders: { synced: 4, skipped: 1, errors: [] },
      products: { synced: 2, skipped: 0, errors: [] },
      stock: {
        queued: { processed: 3, synced: 3, failed: 0, errors: [] },
        sync: { synced: 8, skipped: 2, errors: [] },
      },
    }),
    {
      status: 'completed',
      counts: {
        orders: { synced: 4, skipped: 1 },
        products: { synced: 2, skipped: 0 },
        stock: {
          queued: { processed: 3, synced: 3, failed: 0 },
          sync: { synced: 8, skipped: 2 },
        },
      },
      statusReason: null,
    },
  )
})

test('cron run helper treats nested skipped sections as non-fatal', () => {
  assert.deepEqual(
    inferCronRunOutcome({
      orders: { imported: 3 },
      stock: { skipped: true, reason: 'No stock mappings queued' },
    }),
    {
      status: 'completed',
      counts: { orders: { imported: 3 }, stock: { skipped: true } },
      statusReason: null,
    },
  )
})
