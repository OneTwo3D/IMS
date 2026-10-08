import assert from 'node:assert/strict'
import test from 'node:test'

import {
  READ_SYNC_FIRST_EVALUATED_SETTING,
  READ_SYNC_STREAMS,
  readSyncAlertedSettingKey,
  type ReadSyncStreamId,
} from '../../lib/ops/read-sync-liveness-constants.ts'
import {
  runReadSyncLivenessAlarm,
  type ReadSyncAlarmDb,
  type ReadSyncAlarmTx,
} from '../../lib/ops/read-sync-liveness-alarm.ts'
import type { ReadSyncInputs } from '../../lib/ops/read-sync-status.ts'

/**
 * THE ALARM, PROVEN ABLE TO FIRE - AND ABLE TO STAY QUIET.
 *
 * An in-memory settings table stands in for the database; delivery is a recording double that can be
 * made to throw like notifyActiveAdmins does when no admin can be told. $transaction snapshots the
 * table and restores it when the callback throws, so "claimed and delivered in ONE transaction" is
 * observable: a failed delivery leaves NO dedupe stamp.
 *
 * Mutations (each verified red, see the PR): (1) the stale test in the alarm weakened so a stale
 * feed is skipped => "[fires]" fails; (2) the dedupe comparison removed => "[once per breach]" fails;
 * (3) the stamp written outside the transaction => "[one transaction]" fails.
 */

const NOW = new Date('2026-10-08T12:00:00.000Z')
const HOUR = 3_600_000
const ago = (ms: number) => new Date(NOW.getTime() - ms)

class Harness {
  settings = new Map<string, string>()
  delivered: Array<{ title: string; message: string; actionUrl: string }> = []
  warnings: Array<{ stream: ReadSyncStreamId; description: string }> = []
  failDelivery = false
  /** The inputs as they stand at a given clock: fresh feeds stay 30 minutes old however far the clock moves. */
  build: (at: Date) => ReadSyncInputs

  constructor(build: ReadSyncInputs | ((at: Date) => ReadSyncInputs)) {
    this.build = typeof build === 'function' ? build : () => build
  }

  db: ReadSyncAlarmDb = {
    setting: {
      findMany: async ({ where }) => where.key.in.filter((key) => this.settings.has(key)).map((key) => ({ key, value: this.settings.get(key)! })),
      upsert: async ({ where, create, update }) => {
        this.settings.set(where.key, this.settings.has(where.key) ? update.value : create.value)
      },
      deleteMany: async ({ where }) => {
        this.settings.delete(where.key)
      },
    },
    $transaction: async <T>(fn: (tx: ReadSyncAlarmTx) => Promise<T>) => {
      const snapshot = new Map(this.settings)
      const tx: ReadSyncAlarmTx = {
        setting: { upsert: async ({ where, create, update }) => { this.settings.set(where.key, this.settings.has(where.key) ? update.value : create.value) } },
      }
      try {
        return await fn(tx)
      } catch (error) {
        this.settings = snapshot
        throw error
      }
    },
  }

  run(now: Date = NOW) {
    return runReadSyncLivenessAlarm({
      db: this.db,
      now,
      readInputs: async () => this.build(now),
      notifyAdmins: async (_tx, title, message, actionUrl) => {
        if (this.failDelivery) throw new Error('no active ADMIN users to notify')
        this.delivered.push({ title, message, actionUrl })
      },
      logWarning: async (entry) => { this.warnings.push({ stream: entry.stream, description: entry.description }) },
    })
  }
}

function inputs(overrides: Partial<ReadSyncInputs> = {}, stale: Partial<Record<ReadSyncStreamId, Date | null>> = {}, at: Date = NOW): ReadSyncInputs {
  const fresh = () => new Date(at.getTime() - HOUR / 2)
  const settings = new Map<string, string>([['wc_sync_enabled', 'true']])
  const cronEnabled: Record<string, boolean> = {}
  for (const def of READ_SYNC_STREAMS) {
    if (def.source.kind === 'setting') {
      const override = def.id in stale ? stale[def.id] : undefined
      if (override !== null) settings.set(def.source.key, (override ?? fresh()).toISOString())
    }
    if (def.cronSlug) cronEnabled[def.cronSlug] = true
  }
  return {
    settings,
    pluginEnabled: { woocommerce: true, mintsoft: true, xero: true },
    xeroConnected: true,
    cronEnabled,
    bindings: [{ id: 'b1', warehouseCode: 'MS1', syncFrequencyMinutes: 60, lastStockSyncSuccessAt: new Date(at.getTime() - 10 * HOUR) }],
    lastDispatchSuccessAt: stale['mintsoft-dispatch-poll'] === undefined ? fresh() : stale['mintsoft-dispatch-poll'],
    ...overrides,
  }
}

test('[fires] a stopped feed raises one notification and one WARNING, naming the feed and its last success', async () => {
  const harness = new Harness(inputs({}, { 'woocommerce-order-sweep': ago(100 * HOUR) }))
  const result = await harness.run()
  console.log(`precondition: evaluated ${result.evaluated} streams, alerted ${JSON.stringify(result.alerted)}`)
  assert.deepEqual(result.alerted, ['woocommerce-order-sweep'])
  assert.equal(result.status, 'SUCCEEDED')
  assert.equal(harness.delivered.length, 1)
  assert.match(harness.delivered[0]!.title, /WooCommerce order sweep/)
  assert.match(harness.delivered[0]!.message, new RegExp(ago(100 * HOUR).toISOString()))
  assert.equal(harness.warnings.length, 1)
  assert.equal(harness.settings.get(readSyncAlertedSettingKey('woocommerce-order-sweep')), `stale:${ago(100 * HOUR).toISOString()}`)
})

test('[fires] every alarmed stream can fire, one at a time (the Mintsoft stock sync is the watchdog\'s)', async () => {
  let fired = 0
  const elsewhere = new Set<ReadSyncStreamId>()
  for (const def of READ_SYNC_STREAMS) {
    if (def.alarm === 'wms-watchdog') { elsewhere.add(def.id); continue }
    const harness = new Harness(inputs({}, { [def.id]: ago(1000 * HOUR) }))
    const result = await harness.run()
    assert.deepEqual(result.alerted, [def.id], def.id)
    assert.equal(harness.delivered.length, 1, def.id)
    fired += 1
  }
  console.log(`precondition: ${fired} streams fired individually, ${[...elsewhere].join()} left to the watchdog`)
  assert.equal(fired, READ_SYNC_STREAMS.length - 1)
  assert.deepEqual([...elsewhere], ['mintsoft-stock-sync'])
  // The stale stock-sync binding in the inputs above is NOT alerted by this job.
  const harness = new Harness(inputs())
  assert.deepEqual((await harness.run()).alerted, [])
})

test('[quiet] a fresh install raises nothing and records the first-evaluated anchor', async () => {
  const harness = new Harness(inputs())
  const result = await harness.run()
  assert.deepEqual(result.alerted, [])
  assert.equal(harness.delivered.length, 0)
  assert.equal(harness.warnings.length, 0)
  assert.equal(harness.settings.get(READ_SYNC_FIRST_EVALUATED_SETTING), NOW.toISOString())
  assert.ok(result.evaluated >= 5, `evaluated ${result.evaluated}`)
})

test('[quiet] a feed one millisecond inside its limit is quiet; at the limit it fires', async () => {
  const def = READ_SYNC_STREAMS.find((candidate) => candidate.id === 'xero-tax-rates')!
  const max = def.maxAge.kind === 'fixed' ? def.maxAge.ms : 0
  assert.ok(max > 0)
  const inside = new Harness(inputs({}, { 'xero-tax-rates': ago(max - 1) }))
  assert.deepEqual((await inside.run()).alerted, [])
  const at = new Harness(inputs({}, { 'xero-tax-rates': ago(max) }))
  assert.deepEqual((await at.run()).alerted, ['xero-tax-rates'])
})

test('[once per breach] a continuing breach does not repeat; healing clears it; a renewed breach alerts again', async () => {
  const harness = new Harness((at) => inputs({}, { 'xero-balance-snapshots': ago(100 * HOUR) }, at))
  assert.deepEqual((await harness.run()).alerted, ['xero-balance-snapshots'])
  assert.deepEqual((await harness.run(new Date(NOW.getTime() + HOUR))).alerted, [], 'same breach, no repeat')
  assert.equal(harness.delivered.length, 1)

  harness.build = (at) => inputs({}, {}, at)
  assert.deepEqual((await harness.run(new Date(NOW.getTime() + 2 * HOUR))).alerted, [])
  assert.equal(harness.settings.has(readSyncAlertedSettingKey('xero-balance-snapshots')), false, 'healed: the dedupe stamp is cleared')

  harness.build = (at) => inputs({}, { 'xero-balance-snapshots': ago(200 * HOUR) }, at)
  assert.deepEqual((await harness.run(new Date(NOW.getTime() + 3 * HOUR))).alerted, ['xero-balance-snapshots'], 'renewed breach')
  assert.equal(harness.delivered.length, 2)
})

test('[one transaction] a delivery that cannot reach anyone leaves no dedupe stamp, fails the run, and is retried', async () => {
  const harness = new Harness((at) => inputs({}, { 'mintsoft-order-status': ago(100 * HOUR) }, at))
  harness.failDelivery = true
  const failed = await harness.run()
  assert.equal(failed.status, 'FAILED')
  assert.equal(failed.deliveryFailures, 1)
  assert.deepEqual(failed.alerted, [])
  assert.equal(harness.settings.has(readSyncAlertedSettingKey('mintsoft-order-status')), false, 'the claim rolled back with the delivery')
  assert.equal(harness.warnings.length, 0)

  harness.failDelivery = false
  const retried = await harness.run(new Date(NOW.getTime() + HOUR))
  assert.equal(retried.status, 'SUCCEEDED')
  assert.deepEqual(retried.alerted, ['mintsoft-order-status'])
})

test('never succeeded: quiet inside the first limit since tracking began, alarmed after it, once', async () => {
  const harness = new Harness((at) => inputs({}, { 'xero-tax-rates': null }, at))
  assert.deepEqual((await harness.run()).alerted, [], 'tracking only just began: a first scheduled run may not have happened yet')
  const limit = 6 * HOUR
  assert.deepEqual((await harness.run(new Date(NOW.getTime() + limit - 1))).alerted, [])
  const after = await harness.run(new Date(NOW.getTime() + limit))
  assert.deepEqual(after.alerted, ['xero-tax-rates'])
  assert.match(harness.delivered[0]!.message, /No successful run .* has been recorded since liveness tracking began on 2026-10-08/)
  assert.deepEqual((await harness.run(new Date(NOW.getTime() + limit + HOUR))).alerted, [])
  assert.equal(harness.delivered.length, 1)
})

test('a feed that is switched off is not alarmed, and forgets an earlier breach', async () => {
  const harness = new Harness((at) => inputs({}, { 'xero-tax-rates': ago(100 * HOUR) }, at))
  assert.deepEqual((await harness.run()).alerted, ['xero-tax-rates'])
  harness.build = (at) => inputs({ xeroConnected: false }, { 'xero-tax-rates': ago(100 * HOUR) }, at)
  assert.deepEqual((await harness.run(new Date(NOW.getTime() + HOUR))).alerted, [])
  assert.equal(harness.settings.has(readSyncAlertedSettingKey('xero-tax-rates')), false)
})
