import assert from 'node:assert/strict'
import test from 'node:test'

import {
  appendCronRunId,
  inferCronRunOutcome,
  runCronWithLogging,
  type CronRunLog,
} from '../../lib/ops/cron-run.ts'

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
    status: 'completed',
    counts: {
      updated: 3,
      pushed: 2,
    },
    errorSummary: null,
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
  assert.equal(logs[0]?.errorSummary, 'disabled')
  assert.equal(logs[1]?.status, 'failed')
  assert.equal(logs[1]?.errorSummary, 'Backup creation failed')
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
  assert.equal(logs[0]?.errorSummary, 'connector unavailable')
})

test('cron run helper appends run id to JSON response bodies', () => {
  assert.deepEqual(appendCronRunId({ ok: true }, 'run-1'), {
    ok: true,
    runId: 'run-1',
  })
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
      errorSummary: 'inventory failed',
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
  assert.equal(outcome.errorSummary, 'orders: Order sync failed; stock.sync: Stock push failed')
})

test('cron run helper treats nested skipped sections as non-fatal', () => {
  assert.deepEqual(
    inferCronRunOutcome({
      orders: { imported: 3 },
      stock: { skipped: true, reason: 'No stock mappings queued' },
    }),
    {
      status: 'completed',
      counts: null,
      errorSummary: null,
    },
  )
})
