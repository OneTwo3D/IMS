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
  warnings: Array<{ stream: ReadSyncStreamId | 'scheduler' | 'liveness-anchor'; description: string }> = []
  failDelivery = false
  failActivityWrite = false
  /** Called inside the claim transaction after the claim won and before delivery: lets a test interleave a rival run. */
  afterClaim: (() => Promise<void>) | null = null
  private pendingDelivered: Harness['delivered'] = []
  private pendingWarnings: Harness['warnings'] = []
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
      updateMany: async ({ where, data }) => {
        if (this.settings.get(where.key) !== where.value) return { count: 0 }
        this.settings.set(where.key, data.value)
        return { count: 1 }
      },
    },
    $transaction: async <T>(fn: (tx: ReadSyncAlarmTx) => Promise<T>) => {
      const snapshot = new Map(this.settings)
      this.pendingDelivered = []
      this.pendingWarnings = []
      const tx: ReadSyncAlarmTx = {
        setting: {
          findMany: async ({ where }) => where.key.in.filter((key) => this.settings.has(key)).map((key) => ({ key, value: this.settings.get(key)! })),
          deleteMany: async ({ where }) => { this.settings.delete(where.key) },
          createMany: async ({ data }) => {
            let count = 0
            for (const row of data) if (!this.settings.has(row.key)) { this.settings.set(row.key, row.value); count += 1 }
            return { count }
          },
          updateMany: async ({ where, data }) => {
            if (this.settings.get(where.key) !== where.value) return { count: 0 }
            this.settings.set(where.key, data.value)
            return { count: 1 }
          },
        },
      }
      try {
        const value = await fn(tx)
        this.delivered.push(...this.pendingDelivered)
        this.warnings.push(...this.pendingWarnings)
        return value
      } catch (error) {
        this.settings = snapshot
        throw error
      } finally {
        this.pendingDelivered = []
        this.pendingWarnings = []
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
        this.pendingDelivered.push({ title, message, actionUrl })
        if (this.afterClaim) await this.afterClaim()
      },
      logWarning: async (_tx, entry) => {
        if (this.failActivityWrite) throw new Error('activity_logs insert failed')
        this.pendingWarnings.push({ stream: entry.stream, description: entry.description })
      },
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

test('[claim] a run that lost the claim to a rival delivers nothing (conditional write, not read-then-write)', async () => {
  // Two runs read the same "no breach recorded" state; the rival's transaction commits its claim between
  // this run's read and this run's claim. Without a conditional claim both would deliver.
  const harness = new Harness((at) => inputs({}, { 'xero-tax-rates': ago(100 * HOUR) }, at))
  const key = readSyncAlertedSettingKey('xero-tax-rates')
  const stale = `stale:${ago(100 * HOUR).toISOString()}`
  const realFindMany = harness.db.setting.findMany
  harness.db.setting.findMany = async (args) => {
    const rows = await realFindMany(args)
    // The rival commits its claim AFTER this run has read the (empty) state.
    harness.settings.set(key, stale)
    return rows
  }
  const result = await harness.run()
  console.log(`precondition: rival row=${harness.settings.get(key)} delivered=${harness.delivered.length} alerted=${JSON.stringify(result.alerted)}`)
  assert.deepEqual(result.alerted, [])
  assert.equal(harness.delivered.length, 0, 'the loser delivers nothing')
  assert.equal(harness.warnings.length, 0)
  assert.equal(result.status, 'SUCCEEDED')

  // The same race over an UPDATE (a renewed breach): the rival moved the row between read and claim.
  const h2 = new Harness((at) => inputs({}, { 'xero-tax-rates': ago(100 * HOUR) }, at))
  h2.settings.set(key, 'stale:2026-01-01T00:00:00.000Z')
  const read2 = h2.db.setting.findMany
  h2.db.setting.findMany = async (args) => {
    const rows = await read2(args)
    h2.settings.set(key, stale)
    return rows
  }
  const r2 = await h2.run()
  assert.deepEqual(r2.alerted, [])
  assert.equal(h2.delivered.length, 0)
})

test('[activity] a failed activity write rolls the claim back with the notification: the breach is retried, not lost', async () => {
  const harness = new Harness((at) => inputs({}, { 'mintsoft-dispatch-poll': ago(100 * HOUR) }, at))
  harness.failActivityWrite = true
  const failed = await harness.run()
  console.log(`precondition: status=${failed.status} delivered=${harness.delivered.length} stamp=${harness.settings.get(readSyncAlertedSettingKey('mintsoft-dispatch-poll'))}`)
  assert.equal(failed.status, 'FAILED')
  assert.equal(harness.delivered.length, 0, 'the notification rolled back with the claim')
  assert.equal(harness.settings.has(readSyncAlertedSettingKey('mintsoft-dispatch-poll')), false)

  harness.failActivityWrite = false
  const retried = await harness.run(new Date(NOW.getTime() + HOUR))
  assert.equal(retried.status, 'SUCCEEDED')
  assert.deepEqual(retried.alerted, ['mintsoft-dispatch-poll'])
  assert.equal(harness.delivered.length, 1)
  assert.equal(harness.warnings.length, 1)
})

test('[anchor] an unparsable first-evaluation anchor is replaced ONCE, reported once, and the never-succeeded alarm then fires after the limit', async () => {
  const harness = new Harness((at) => inputs({}, { 'xero-tax-rates': null }, at))
  harness.settings.set(READ_SYNC_FIRST_EVALUATED_SETTING, 'not a time')
  const limit = 6 * HOUR

  const first = await harness.run()
  const replaced = harness.settings.get(READ_SYNC_FIRST_EVALUATED_SETTING)
  console.log(`precondition: run1 alerted=${JSON.stringify(first.alerted)} anchor now ${replaced} warnings=${harness.warnings.length}`)
  assert.equal(replaced, NOW.toISOString(), 'the bad value was replaced with now')
  assert.equal(harness.warnings.filter((w) => w.stream === 'liveness-anchor').length, 1, 'and the fault is reported')
  assert.deepEqual(first.alerted, [])

  // Later runs use the PERSISTED anchor: it is not rewritten, so the limit can be reached.
  await harness.run(new Date(NOW.getTime() + limit - 1))
  assert.equal(harness.settings.get(READ_SYNC_FIRST_EVALUATED_SETTING), NOW.toISOString(), 'not moved by later runs')
  assert.equal(harness.warnings.filter((w) => w.stream === 'liveness-anchor').length, 1, 'reported once per replacement, not per run')
  const after = await harness.run(new Date(NOW.getTime() + limit))
  assert.deepEqual(after.alerted, ['xero-tax-rates'], 'the feed that has never succeeded is alarmed once the limit has run')
})

test('[anchor] a rival that replaced the bad anchor first wins: this run writes nothing and uses the rival\'s value', async () => {
  const harness = new Harness((at) => inputs({}, { 'xero-tax-rates': null }, at))
  harness.settings.set(READ_SYNC_FIRST_EVALUATED_SETTING, 'not a time')
  const real = harness.db.setting.findMany
  let reads = 0
  harness.db.setting.findMany = async (args) => {
    const rows = await real(args)
    reads += 1
    if (reads === 1) harness.settings.set(READ_SYNC_FIRST_EVALUATED_SETTING, new Date(NOW.getTime() - 2 * HOUR).toISOString())
    return rows
  }
  await harness.run()
  assert.equal(harness.settings.get(READ_SYNC_FIRST_EVALUATED_SETTING), new Date(NOW.getTime() - 2 * HOUR).toISOString())
  assert.equal(harness.warnings.filter((w) => w.stream === 'liveness-anchor').length, 0)
})

test('[anchor] a FUTURE first-evaluation anchor (even year 275760) is invalid: replaced once, reported, and the alarm still fires; within tolerance it is kept', async () => {
  const limit = 6 * HOUR
  for (const future of ['+275760-09-13T00:00:00.000Z', new Date(NOW.getTime() + 10 * 60_000).toISOString(), '2099-01-01T00:00:00.000Z']) {
    const harness = new Harness((at) => inputs({}, { 'xero-tax-rates': null }, at))
    harness.settings.set(READ_SYNC_FIRST_EVALUATED_SETTING, future)
    await harness.run()
    console.log(`precondition (${future}): anchor now ${harness.settings.get(READ_SYNC_FIRST_EVALUATED_SETTING)} warnings=${harness.warnings.filter((w) => w.stream === 'liveness-anchor').length}`)
    assert.equal(harness.settings.get(READ_SYNC_FIRST_EVALUATED_SETTING), NOW.toISOString(), 'replaced by now')
    assert.equal(harness.warnings.filter((w) => w.stream === 'liveness-anchor').length, 1)
    assert.match(harness.warnings[0]!.description, /in the future/)
    const after = await harness.run(new Date(NOW.getTime() + limit))
    assert.deepEqual(after.alerted, ['xero-tax-rates'], 'a future anchor cannot silence the never-succeeded alarm')
    assert.equal(harness.warnings.filter((w) => w.stream === 'liveness-anchor').length, 1, 'once per replacement')
  }
  // Within the clock-skew tolerance the anchor is believed and left alone.
  const kept = new Harness((at) => inputs({}, { 'xero-tax-rates': null }, at))
  const skewed = new Date(NOW.getTime() + 4 * 60_000).toISOString()
  kept.settings.set(READ_SYNC_FIRST_EVALUATED_SETTING, skewed)
  await kept.run()
  assert.equal(kept.settings.get(READ_SYNC_FIRST_EVALUATED_SETTING), skewed)
  assert.equal(kept.warnings.filter((w) => w.stream === 'liveness-anchor').length, 0)
})
