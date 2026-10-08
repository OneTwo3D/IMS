import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import test from 'node:test'
import { config } from 'dotenv'

import { backendPid, waitUntilParkedBehind } from '../helpers/lock-wait-observer'
import { READ_SYNC_FIRST_EVALUATED_SETTING, readSyncAlertedSettingKey, XERO_TAX_RATE_LAST_SUCCESS_SETTING } from '@/lib/ops/read-sync-liveness-constants'

/**
 * THE ALARM'S CLAIM AGAINST A REAL POSTGRES: TWO RUNS OVER ONE BREACH DELIVER ONCE.
 *
 * Two hourly runs can overlap (a slow run, a retried request). Each reads the dedupe stamp, sees no
 * recorded breach (or the same older one) and decides to alert. The claim must therefore be a
 * conditional write whose RESULT decides delivery, not a write followed by delivery:
 *
 *   run A  claims (uncommitted), then parks inside its transaction before it commits;
 *   run B  reads the same state, issues its claim, and is blocked on A's row/insert;
 *   A      is released and commits; B's conditional write now matches nothing and B delivers nothing.
 *
 * The park is OBSERVED in pg_stat_activity (pg_blocking_pids names A's backend and B's statement is the
 * claim) before A is released - no sleeps order anything. Both claim shapes are exercised: the
 * insert-if-absent (no breach recorded yet) and the conditional update (a renewed breach).
 *
 * Mutation (see the PR): replace the claim with an unconditional upsert and deliver regardless => both
 * arms see two deliveries (and the parked state is never reached, which the observer reports).
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1: `npm run test:concurrency`.
 */
const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
}

const HOUR = 3_600_000
const STREAM = 'xero-tax-rates' as const

async function scenario(priorValue: string | null) {
  loadEnv()
  const { db } = await import('@/lib/db')
  const { runReadSyncLivenessAlarm } = await import('@/lib/ops/read-sync-liveness-alarm')
  const stampKey = readSyncAlertedSettingKey(STREAM)
  const cleanup = () => db.setting.deleteMany({ where: { key: { in: [stampKey, READ_SYNC_FIRST_EVALUATED_SETTING] } } })
  await cleanup()
  if (priorValue !== null) await db.setting.create({ data: { key: stampKey, value: priorValue } })
  // The anchor is written up front so neither run races to create it (that is not what is under test).
  await db.setting.create({ data: { key: READ_SYNC_FIRST_EVALUATED_SETTING, value: new Date(Date.now() - 1000 * HOUR).toISOString() } })

  const now = new Date()
  const lastSuccess = new Date(now.getTime() - 100 * HOUR)
  const inputs = {
    settings: new Map([[XERO_TAX_RATE_LAST_SUCCESS_SETTING, lastSuccess.toISOString()]]),
    pluginEnabled: { woocommerce: false, mintsoft: false, xero: true },
    xeroConnected: true,
    cronEnabled: { 'xero-tax-rate-drift': true } as Record<string, boolean>,
    bindings: [],
    lastDispatchSuccessAt: null,
  }

  const deliveries: string[] = []
  let releaseA!: () => void
  const gateA = new Promise<void>((resolve) => { releaseA = resolve })
  let holderPid = 0
  let aClaimed!: () => void
  const aHasClaimed = new Promise<void>((resolve) => { aClaimed = resolve })

  const common = { db: db as never, now, readInputs: async () => inputs, logWarning: async () => undefined }
  try {
    const runA = runReadSyncLivenessAlarm({
      ...common,
      notifyAdmins: async (tx, title) => {
        deliveries.push(`A:${title}`)
        holderPid = await backendPid(tx as never)
        aClaimed()
        await gateA // A holds its claim, uncommitted
      },
    })
    await aHasClaimed

    const runB = runReadSyncLivenessAlarm({
      ...common,
      notifyAdmins: async (_tx, title) => { deliveries.push(`B:${title}`) },
    })
    const parked = await waitUntilParkedBehind(db as never, {
      holderPid,
      waitingOn: /settings/i,
      describe: `read-sync alarm run B (${priorValue === null ? 'insert-if-absent' : 'conditional update'})`,
    })
    console.log(`precondition (${priorValue === null ? 'insert' : 'update'}): A pid ${holderPid} holds the claim; B pid ${parked.pid} parked after ${parked.observedAfterMs}ms on: ${parked.query.slice(0, 80)}`)
    assert.equal(deliveries.length, 1, 'only A has delivered while B is parked')

    releaseA()
    const [a, b] = await Promise.all([runA, runB])
    const row = await db.setting.findUnique({ where: { key: stampKey } })
    assert.deepEqual(a.alerted, [STREAM], 'A won the claim')
    assert.deepEqual(b.alerted, [], 'B lost it')
    assert.equal(b.status, 'SUCCEEDED', 'losing is not a failure')
    assert.deepEqual(deliveries.filter((entry) => entry.startsWith('B:')), [], 'B delivered nothing')
    assert.equal(deliveries.length, 1)
    assert.equal(row?.value, `stale:${lastSuccess.toISOString()}`)
  } finally {
    releaseA?.()
    await cleanup()
  }
}

test('[claim] two overlapping runs over a fresh breach: insert-if-absent delivers once', { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' }, async () => {
  await scenario(null)
})

test('[claim] two overlapping runs over a renewed breach: conditional update delivers once', { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' }, async () => {
  await scenario('stale:2026-01-01T00:00:00.000Z')
})

test('[claim] a failed activity write rolls the claim and the notification back in the real database', { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' }, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const { runReadSyncLivenessAlarm } = await import('@/lib/ops/read-sync-liveness-alarm')
  const { notifyActiveAdmins } = await import('@/lib/domain/wms/watchdog-sweep')
  const stampKey = readSyncAlertedSettingKey(STREAM)
  const email = `claim-${process.pid}-${Date.now()}@example.test`
  await db.setting.deleteMany({ where: { key: { in: [stampKey, READ_SYNC_FIRST_EVALUATED_SETTING] } } })
  await db.setting.create({ data: { key: READ_SYNC_FIRST_EVALUATED_SETTING, value: new Date(Date.now() - 1000 * HOUR).toISOString() } })
  const admin = await db.user.create({ data: { email, name: 'claim fixture', role: 'ADMIN', active: true, passwordHash: 'x' }, select: { id: true } })
  const now = new Date()
  const inputs = {
    settings: new Map([[XERO_TAX_RATE_LAST_SUCCESS_SETTING, new Date(now.getTime() - 100 * HOUR).toISOString()]]),
    pluginEnabled: { woocommerce: false, mintsoft: false, xero: true },
    xeroConnected: true,
    cronEnabled: { 'xero-tax-rate-drift': true } as Record<string, boolean>,
    bindings: [],
    lastDispatchSuccessAt: null,
  }
  try {
    const run = (failActivity: boolean) => runReadSyncLivenessAlarm({
      db: db as never,
      now,
      readInputs: async () => inputs,
      notifyAdmins: (tx, title, message, actionUrl) => notifyActiveAdmins(tx as never, title, message, actionUrl),
      logWarning: async (tx, entry) => {
        if (failActivity) throw new Error('fault injected: activity_logs insert failed')
        await (tx as never as { activityLog: { create(a: unknown): Promise<unknown> } }).activityLog.create({
          data: { entityType: 'SYNC', action: 'read_sync_stream_stale', tag: 'sync', level: 'WARNING', description: entry.description },
        })
      },
    })
    const failed = await run(true)
    const mine = () => db.notification.count({ where: { userId: admin.id } })
    console.log(`precondition: fault run status=${failed.status} notifications=${await mine()} stamp=${JSON.stringify((await db.setting.findUnique({ where: { key: stampKey } }))?.value ?? null)}`)
    assert.equal(failed.status, 'FAILED')
    assert.equal(await mine(), 0, 'the notification rolled back with the claim')
    assert.equal(await db.setting.findUnique({ where: { key: stampKey } }), null, 'no claim survives: the breach will be retried')

    const retried = await run(false)
    assert.equal(retried.status, 'SUCCEEDED')
    assert.deepEqual(retried.alerted, [STREAM])
    assert.equal(await mine(), 1)
  } finally {
    await db.user.delete({ where: { id: admin.id } }).catch(() => undefined)
    await db.setting.deleteMany({ where: { key: { in: [stampKey, READ_SYNC_FIRST_EVALUATED_SETTING] } } })
  }
})
