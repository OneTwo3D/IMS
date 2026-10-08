import assert from 'node:assert/strict'
import test from 'node:test'

import '../../lib/cron-jobs/index.ts'
import { getAllCronJobs } from '../../lib/cron-registry.ts'
import {
  evaluateReadSyncStream,
  parseReadSyncStamp,
  READ_SYNC_FUTURE_TOLERANCE_MS,
} from '../../lib/ops/read-sync-liveness.ts'
import {
  BINDING_STALE_FLOOR_MS,
  BINDING_STALE_INTERVALS,
  READ_SYNC_STATUS_EXIT_CODES,
  READ_SYNC_STREAMS,
  READ_SYNC_STREAM_IDS,
  bindingStaleAfterMs,
  buildReadSyncAlert,
  type ReadSyncStreamId,
} from '../../lib/ops/read-sync-liveness-constants.ts'
import {
  assembleReadSyncReport,
  readSyncStatusExitCode,
  renderReadSyncStatusText,
  type ReadSyncInputs,
} from '../../lib/ops/read-sync-status.ts'
import { isBindingSyncStale } from '../../lib/domain/wms/watchdog-sweep.ts'
import { runReadSyncStatusCli } from '../../scripts/read-sync-status.ts'

/**
 * READ-SYNC LIVENESS - THE RULE, THE STREAM TABLE, THE REPORT AND THE EXIT CODES.
 *
 * Mutations (each verified red, see the PR): (1) the boundary `>=` in evaluateReadSyncStream turned
 * into `>` => "[boundary]" and "[every stream]" fail; (2) assembleReadSyncReport skipping one stream
 * => "[report names every stream]" fails; (3) the stale row of the exit-code precedence removed =>
 * "[exit code]" fails.
 */

const NOW = new Date('2026-10-08T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms)
const HOUR = 3_600_000

function allOnInputs(overrides: Partial<ReadSyncInputs> = {}): ReadSyncInputs {
  const settings = new Map<string, string>([['wc_sync_enabled', 'true']])
  for (const def of READ_SYNC_STREAMS) {
    if (def.source.kind === 'setting') settings.set(def.source.key, ago(HOUR / 2).toISOString())
  }
  const cronEnabled: Record<string, boolean> = {}
  for (const def of READ_SYNC_STREAMS) if (def.cronSlug) cronEnabled[def.cronSlug] = true
  return {
    settings,
    pluginEnabled: { woocommerce: true, mintsoft: true, xero: true },
    xeroConnected: true,
    cronEnabled,
    bindings: [{ id: 'b1', warehouseCode: 'MS1', syncFrequencyMinutes: 60, lastStockSyncSuccessAt: ago(HOUR / 2) }],
    lastDispatchSuccessAt: ago(HOUR / 2),
    ...overrides,
  }
}

test('[boundary] fresh one millisecond under the limit, stale exactly at it, stale over it', () => {
  const max = 10 * HOUR
  const under = evaluateReadSyncStream('xero-tax-rates', ago(max - 1), NOW, max)
  const at = evaluateReadSyncStream('xero-tax-rates', ago(max), NOW, max)
  const over = evaluateReadSyncStream('xero-tax-rates', ago(max + 1), NOW, max)
  console.log(`precondition: ages ${under.ageMs}, ${at.ageMs}, ${over.ageMs} ms against a ${max} ms limit`)
  assert.equal(under.state, 'fresh')
  assert.equal(at.state, 'stale', 'the boundary is stale, matching the watchdog >=')
  assert.equal(over.state, 'stale')
})

test('[every stream] each stream with a fixed limit is fresh at limit-1ms and stale at the limit', () => {
  let examined = 0
  for (const def of READ_SYNC_STREAMS) {
    if (def.maxAge.kind !== 'fixed') continue
    examined += 1
    assert.equal(evaluateReadSyncStream(def.id, ago(def.maxAge.ms - 1), NOW, def.maxAge.ms).state, 'fresh', def.id)
    assert.equal(evaluateReadSyncStream(def.id, ago(def.maxAge.ms), NOW, def.maxAge.ms).state, 'stale', def.id)
  }
  console.log(`precondition: ${examined} fixed-limit streams examined of ${READ_SYNC_STREAMS.length}`)
  assert.equal(examined, READ_SYNC_STREAMS.filter((def) => def.maxAge.kind === 'fixed').length)
  assert.ok(examined >= 5)
})

test('never: no success recorded, or a stored value that is not a time', () => {
  assert.equal(evaluateReadSyncStream('xero-tax-rates', null, NOW, HOUR).state, 'never')
  assert.equal(evaluateReadSyncStream('xero-tax-rates', new Date('nonsense'), NOW, HOUR).state, 'never')
  assert.equal(parseReadSyncStamp('not a time'), null)
  assert.equal(parseReadSyncStamp(''), null)
  assert.equal(parseReadSyncStamp(undefined), null)
  assert.equal(parseReadSyncStamp('2026-10-08T11:00:00Z')?.toISOString(), '2026-10-08T11:00:00.000Z')
})

test('a success dated in the future of the clock is not believed (it would keep a stopped feed fresh)', () => {
  const skew = evaluateReadSyncStream('xero-tax-rates', new Date(NOW.getTime() + READ_SYNC_FUTURE_TOLERANCE_MS - 1), NOW, HOUR)
  const future = evaluateReadSyncStream('xero-tax-rates', new Date(NOW.getTime() + READ_SYNC_FUTURE_TOLERANCE_MS + 1), NOW, HOUR)
  assert.equal(skew.state, 'fresh', 'ordinary clock skew between processes is tolerated')
  assert.equal(future.state, 'stale')
  assert.equal(future.futureTimestamp, true)
})

test('a non-positive limit is a programming error, not a verdict', () => {
  assert.throws(() => evaluateReadSyncStream('xero-tax-rates', NOW, NOW, 0))
  assert.throws(() => evaluateReadSyncStream('xero-tax-rates', NOW, NOW, Number.NaN))
})

test('the stream table: ids unique, each source and limit well formed, each registered job exists', () => {
  assert.deepEqual([...new Set(READ_SYNC_STREAMS.map((def) => def.id))].sort(), [...READ_SYNC_STREAM_IDS].sort())
  assert.equal(READ_SYNC_STREAMS.length, READ_SYNC_STREAM_IDS.length)
  const slugs = new Set(getAllCronJobs().map((job) => job.slug))
  let checked = 0
  for (const def of READ_SYNC_STREAMS) {
    if (def.cronSlug) {
      checked += 1
      assert.ok(slugs.has(def.cronSlug), `${def.id} names the scheduled job ${def.cronSlug}, which is not registered`)
    }
    assert.ok(def.maxAge.kind === 'binding-cadence' || def.maxAge.ms > 0, def.id)
  }
  console.log(`precondition: ${checked} stream jobs found in the registry of ${slugs.size}`)
  assert.ok(checked >= 4)
  assert.ok(slugs.has('read-sync-liveness'), 'the alarm job is registered')
  assert.equal(getAllCronJobs().find((job) => job.slug === 'read-sync-liveness')?.defaultEnabled, true)
})

test('the stock-sync verdict equals the watchdog verdict for every cadence and age in a table', () => {
  let compared = 0
  for (const minutes of [1, 5, 15, 60, 120, 1440]) {
    const limit = bindingStaleAfterMs(minutes)
    for (const age of [0, limit - 1, limit, limit + 1, limit * 2]) {
      const last = ago(age)
      const watchdogStale = isBindingSyncStale({ lastStockSyncSuccessAt: last, syncFrequencyMinutes: minutes, createdAt: ago(1e9) }, NOW)
      const ours = evaluateReadSyncStream('mintsoft-stock-sync', last, NOW, limit).state === 'stale'
      assert.equal(ours, watchdogStale, `${minutes}m cadence at age ${age}`)
      compared += 1
    }
  }
  console.log(`precondition: ${compared} cadence/age pairs compared`)
  assert.equal(compared, 30)
  assert.equal(bindingStaleAfterMs(5), BINDING_STALE_FLOOR_MS)
  assert.equal(bindingStaleAfterMs(60), BINDING_STALE_INTERVALS * HOUR)
})

test('[report names every stream] a fully fresh install reports every stream fresh and exits 0', () => {
  const report = assembleReadSyncReport(allOnInputs(), NOW)
  const seen = new Set(report.entries.map((entry) => entry.stream))
  console.log(`precondition: ${report.entries.length} entries covering ${seen.size} of ${READ_SYNC_STREAM_IDS.length} streams`)
  for (const id of READ_SYNC_STREAM_IDS) assert.ok(seen.has(id), `the report ignores ${id}`)
  assert.equal(report.counts.fresh, report.entries.length)
  assert.equal(readSyncStatusExitCode(report), 0)
  assert.match(renderReadSyncStatusText(report), /^CURRENT:/)
})

test('[report names every stream] stopping each stream in turn turns the report stale for exactly that stream', () => {
  let exercised = 0
  for (const def of READ_SYNC_STREAMS) {
    const base = allOnInputs()
    let inputs: ReadSyncInputs
    if (def.source.kind === 'setting') {
      const settings = new Map(base.settings)
      settings.set(def.source.key, ago((def.maxAge.kind === 'fixed' ? def.maxAge.ms : 0) + 1000).toISOString())
      inputs = { ...base, settings }
    } else if (def.source.kind === 'binding-column') {
      inputs = { ...base, bindings: [{ id: 'b1', warehouseCode: 'MS1', syncFrequencyMinutes: 60, lastStockSyncSuccessAt: ago(bindingStaleAfterMs(60) + 1000) }] }
    } else {
      inputs = { ...base, lastDispatchSuccessAt: ago(2 * HOUR + 1000) }
    }
    const report = assembleReadSyncReport(inputs, NOW)
    const stale = report.entries.filter((entry) => entry.state === 'stale').map((entry) => entry.stream)
    assert.deepEqual(stale, [def.id], `stopping ${def.id}`)
    assert.equal(readSyncStatusExitCode(report), 1, def.id)
    exercised += 1
  }
  console.log(`precondition: ${exercised} streams stopped one at a time`)
  assert.equal(exercised, READ_SYNC_STREAMS.length)
})

test('never, off and the exit-code precedence', () => {
  const base = allOnInputs()
  const noStamp = new Map(base.settings)
  noStamp.delete('xero_balance_snapshot_last_success_at')
  const never = assembleReadSyncReport({ ...base, settings: noStamp }, NOW)
  assert.deepEqual(never.entries.filter((e) => e.state === 'never').map((e) => e.stream), ['xero-balance-snapshots'])
  assert.equal(readSyncStatusExitCode(never), 2)

  const off = assembleReadSyncReport({ ...base, pluginEnabled: { woocommerce: true, mintsoft: true, xero: false } }, NOW)
  assert.deepEqual(off.entries.filter((e) => e.state === 'off').map((e) => e.stream).sort(), ['xero-balance-snapshots', 'xero-tax-rates'])
  assert.equal(readSyncStatusExitCode(off), 4)
  assert.match(renderReadSyncStatusText(off), /OFF .*Xero plugin|plugin is disabled/i)

  // Precedence: stale beats never beats off.
  const staleSettings = new Map(noStamp)
  staleSettings.set('xero_tax_rate_drift_last_checked_at', ago(7 * HOUR).toISOString())
  const mixed = assembleReadSyncReport({ ...base, settings: staleSettings, pluginEnabled: { ...base.pluginEnabled, woocommerce: false } }, NOW)
  assert.ok(mixed.counts.stale > 0 && mixed.counts.never > 0 && mixed.counts.off > 0)
  assert.equal(readSyncStatusExitCode(mixed), 1)
  const neverAndOff = assembleReadSyncReport({ ...base, settings: noStamp, pluginEnabled: { ...base.pluginEnabled, woocommerce: false } }, NOW)
  assert.ok(neverAndOff.counts.stale === 0 && neverAndOff.counts.never > 0 && neverAndOff.counts.off > 0)
  assert.equal(readSyncStatusExitCode(neverAndOff), 2)
})

test('off reasons: disabled job, wc sync off, not connected, no binding, unreadable stamp is noted', () => {
  const base = allOnInputs()
  const jobOff = assembleReadSyncReport({ ...base, cronEnabled: { ...base.cronEnabled, 'wms-order-status': false } }, NOW)
  assert.match(jobOff.entries.find((e) => e.stream === 'mintsoft-order-status')?.detail ?? '', /wms-order-status scheduled job is disabled/)
  const wcOff = assembleReadSyncReport({ ...base, settings: new Map([...base.settings, ['wc_sync_enabled', 'false']]) }, NOW)
  assert.equal(wcOff.entries.find((e) => e.stream === 'woocommerce-order-sweep')?.state, 'off')
  const xeroDisconnected = assembleReadSyncReport({ ...base, xeroConnected: false }, NOW)
  assert.match(xeroDisconnected.entries.find((e) => e.stream === 'xero-tax-rates')?.detail ?? '', /not connected/)
  const noBinding = assembleReadSyncReport({ ...base, bindings: [] }, NOW)
  assert.match(noBinding.entries.find((e) => e.stream === 'mintsoft-stock-sync')?.detail ?? '', /no active Mintsoft stock-sync binding/)
  const garbage = assembleReadSyncReport({ ...base, settings: new Map([...base.settings, ['xero_tax_rate_drift_last_checked_at', 'garbage']]) }, NOW)
  const entry = garbage.entries.find((e) => e.stream === 'xero-tax-rates')
  assert.equal(entry?.state, 'never')
  assert.match(entry?.detail ?? '', /not a time/)
})

test('one entry per active binding, each judged on its own cadence', () => {
  const base = allOnInputs({
    bindings: [
      { id: 'a', warehouseCode: 'FAST', syncFrequencyMinutes: 5, lastStockSyncSuccessAt: ago(70 * 60_000) },
      { id: 'b', warehouseCode: 'SLOW', syncFrequencyMinutes: 240, lastStockSyncSuccessAt: ago(70 * 60_000) },
    ],
  })
  const entries = assembleReadSyncReport(base, NOW).entries.filter((entry) => entry.stream === 'mintsoft-stock-sync')
  assert.deepEqual(entries.map((entry) => [entry.instance, entry.state]), [['FAST', 'stale'], ['SLOW', 'fresh']])
})

test('exit-code table: unique codes, every name used by the code, array order is precedence', async () => {
  const codes = READ_SYNC_STATUS_EXIT_CODES.map((row) => row.code)
  assert.equal(new Set(codes).size, codes.length)
  assert.deepEqual([...codes].sort(), [0, 1, 2, 3, 4, 5])
  const names = READ_SYNC_STATUS_EXIT_CODES.map((row) => row.name)
  assert.deepEqual(names.slice(0, 5), ['failed', 'usage', 'stale', 'never', 'off'])
  assert.equal(names[names.length - 1], 'ok')
})

test('[exit code] the CLI returns the table codes: 0, 1, 3 (usage) and 5 (failure), and prints the report', async () => {
  const lines: string[] = []
  const errors: string[] = []
  const common = { stdout: { log: (m: string) => { lines.push(m) } }, stderr: { error: (m: string) => { errors.push(m) } }, disconnect: async () => undefined }
  const fresh = await runReadSyncStatusCli({ ...common, argv: [], build: async () => assembleReadSyncReport(allOnInputs(), NOW) })
  assert.equal(fresh, 0)
  assert.match(lines.join('\n'), /Exit code 0\./)

  const staleInputs = allOnInputs({ lastDispatchSuccessAt: ago(5 * HOUR) })
  const stale = await runReadSyncStatusCli({ ...common, argv: ['--json'], build: async () => assembleReadSyncReport(staleInputs, NOW) })
  assert.equal(stale, 1)
  const json = JSON.parse(lines[lines.length - 1]!) as { exitCode: number; entries: Array<{ stream: string; state: string }> }
  assert.equal(json.exitCode, 1)
  assert.equal(json.entries.filter((e) => e.state === 'stale').map((e) => e.stream).join(), 'mintsoft-dispatch-poll')

  assert.equal(await runReadSyncStatusCli({ ...common, argv: ['--bogus'], build: async () => { throw new Error('must not run') } }), 3)
  assert.match(errors.join('\n'), /Unknown argument/)

  const failed = await runReadSyncStatusCli({ ...common, argv: [], build: async () => { throw new Error('db down') } })
  assert.equal(failed, 5)
  assert.match(errors.join('\n'), /db down/)
})

test('alert text says only what the stamp shows, names no unconditional action, and is single-sourced per stream', () => {
  const forbidden = /\b(nothing was|no data was lost|you must (reverse|void|delete|re-?post|credit)|re-?post|void it|delete it)\b/i
  let texts = 0
  for (const id of READ_SYNC_STREAM_IDS as readonly ReadSyncStreamId[]) {
    const max = id === 'mintsoft-stock-sync' ? 3 * HOUR : 36 * HOUR
    const stale = buildReadSyncAlert({ stream: id, state: 'stale', lastSuccessAt: '2026-10-06T00:00:00.000Z', maxAgeMs: max, trackedSince: null })
    const never = buildReadSyncAlert({ stream: id, state: 'never', lastSuccessAt: null, maxAgeMs: max, trackedSince: '2026-10-01T00:00:00.000Z' })
    for (const alert of [stale, never]) {
      texts += 1
      assert.doesNotMatch(alert.message, forbidden, id)
      assert.match(alert.message, /may be out of date/, id)
      assert.match(alert.message, /read-sync:status/, id)
    }
    assert.match(stale.message, /last recorded a successful run at 2026-10-06T00:00:00.000Z/)
    assert.match(never.message, /No successful run .* has been recorded since liveness tracking began on 2026-10-01/)
  }
  console.log(`precondition: ${texts} alert texts checked`)
  assert.equal(texts, READ_SYNC_STREAM_IDS.length * 2)
  const future = buildReadSyncAlert({ stream: 'xero-tax-rates', state: 'stale', lastSuccessAt: '2027-01-01T00:00:00.000Z', maxAgeMs: 6 * HOUR, trackedSince: null, futureTimestamp: true })
  assert.match(future.message, /later than the clock/)
})
