import assert from 'node:assert/strict'
import test from 'node:test'

import { buildOutboundStatusReport, outboundStatusExitCode, renderOutboundStatusText } from '../lib/ops/outbound-status'
import { runOutboundStatusCli } from '../scripts/outbound-status'
import { OUTBOUND_STATUS_EXIT_CODES } from '../lib/security/outbound-write-hold-constants'
import { derivePreCutoffTotal, type ProducerCountsRead, type ProducerDestinationCounts } from '../lib/ops/outbound-producer-status'

/** `outbound:status`: "is IMS writing to anything?" Environment and refusal log only; no network. */

const NOW = new Date('2026-10-04T12:00:00.000Z')
const TENANT = '4f7f0c6e-1111-4222-8333-944455556666'
const noRefusals = async () => []

async function report(env: Record<string, string | undefined>, rows: Array<{ createdAt: Date; metadata: unknown }> | 'throw' = []) {
  return buildOutboundStatusReport({
    env, now: NOW, readRefusals: rows === 'throw' ? async () => { throw new Error('db down') } : async () => rows,
  })
}

test('a fresh installation (no grant variables) reports HELD for every connector and exits 0', async () => {
  const r = await report({})
  console.log(`precondition (fresh): ${r.connectors.length} connectors, states ${r.connectors.map((c) => c.state).join(',')}`)
  assert.deepEqual(r.connectors.map((c) => c.state), ['held', 'held', 'held'])
  assert.equal(r.anyGranted, false)
  assert.equal(outboundStatusExitCode(r), 0)
  assert.match(renderOutboundStatusText(r), /^HELD: this installation may not write to WooCommerce, Mintsoft or Xero/)
  assert.equal(outboundStatusExitCode(r, { expectHeld: true }), 0)
})

test('a grant is reported as GRANTED with its destination, says it is not proof a writer is enabled, and fails --expect-held', async () => {
  const r = await report({ XERO_WRITE_ALLOWED_TENANT: TENANT, WC_WRITEBACK_ALLOWED_ORIGIN: 'https://stage.example.com' })
  assert.equal(r.anyGranted, true)
  const text = renderOutboundStatusText(r)
  assert.match(text, /WRITES MAY LEAVE for: WooCommerce \(https:\/\/stage\.example\.com\); Xero \(tenant /)
  assert.match(text, /does not show that any writer is enabled/)
  assert.equal(outboundStatusExitCode(r), 0)
  assert.equal(outboundStatusExitCode(r, { expectHeld: true }), 4)
})

test('an unreadable grant is held, named as unreadable, and exits 1', async () => {
  const r = await report({ MINTSOFT_WRITE_ALLOWED: 'https://a|1,https://b|2' })
  assert.equal(r.connectors[1]!.state, 'unreadable')
  assert.equal(r.anyGranted, false)
  assert.equal(outboundStatusExitCode(r), 1)
  assert.match(renderOutboundStatusText(r), /HELD, grant UNREADABLE/)
})

test('refusal counts weigh each logged entry as 1 plus the refusals it suppressed, per connector, inside the window', async () => {
  const at = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000)
  const r = await report({}, [
    { createdAt: at(5), metadata: { connector: 'xero', suppressedSinceLast: 41 } },
    { createdAt: at(70), metadata: { connector: 'xero', suppressedSinceLast: 0 } },
    { createdAt: at(10), metadata: { connector: 'woocommerce' } },
    { createdAt: at(10), metadata: { connector: 'unknown-connector', suppressedSinceLast: 9 } },
  ])
  const byConnector = Object.fromEntries(r.connectors.map((c) => [c.connector, c.refusalsInWindow]))
  assert.deepEqual(byConnector, { woocommerce: 1, mintsoft: 0, xero: 43 })
  assert.equal(r.connectors[2]!.lastRefusalAt, at(5).toISOString())
})

test('unreadable activity log: grant states are still reported, counts are unavailable, exit code 2; precedence follows the table', async () => {
  const r = await report({}, 'throw')
  assert.equal(r.countsAvailable, false)
  assert.equal(r.connectors[0]!.refusalsInWindow, null)
  assert.equal(outboundStatusExitCode(r), 2)
  const both = await report({ XERO_WRITE_ALLOWED_TENANT: 'true' }, 'throw')
  assert.equal(outboundStatusExitCode(both), 1, 'unreadable-grant outranks counts-unavailable')
  const worst = await report({ WC_WRITEBACK_ALLOWED_ORIGIN: 'https://stage.example.com' }, 'throw')
  assert.equal(outboundStatusExitCode(worst, { expectHeld: true }), 4, 'expected-held-violated outranks both')
  const order = OUTBOUND_STATUS_EXIT_CODES.map((row) => row.name)
  assert.ok(order.indexOf('expected-held-violated') < order.indexOf('unreadable-grant') && order.indexOf('unreadable-grant') < order.indexOf('counts-unavailable'))
})

test('the CLI prints the report, returns the table exit code, rejects unknown arguments with the usage code, and disconnects', async () => {
  const out: string[] = []
  const err: string[] = []
  let disconnected = 0
  const run = (argv: string[], env: Record<string, string | undefined> = {}) => runOutboundStatusCli({
    argv, stdout: { log: (m: string) => out.push(m) }, stderr: { error: (m: string) => err.push(m) },
    build: () => buildOutboundStatusReport({ env, now: NOW, readRefusals: noRefusals }),
    disconnect: async () => { disconnected += 1 },
  })
  assert.equal(await run([]), 0)
  assert.match(out.join('\n'), /^HELD:/)
  out.length = 0
  assert.equal(await run(['--json']), 0)
  const parsed = JSON.parse(out.join('\n')) as { exitCode: number; connectors: Array<{ state: string }> }
  assert.equal(parsed.exitCode, 0)
  assert.deepEqual(parsed.connectors.map((c) => c.state), ['held', 'held', 'held'])
  assert.equal(await run(['--expect-held'], { XERO_WRITE_ALLOWED_TENANT: TENANT }), 4)
  assert.equal(await run(['--frobnicate']), OUTBOUND_STATUS_EXIT_CODES.find((r) => r.name === 'usage')!.code)
  assert.match(err.join('\n'), /Unknown argument/)
  assert.equal(disconnected, 3, 'every evaluated run disconnects; the usage error evaluates nothing')
})

// ---------------------------------------------------------------------------------------------
// THE PRODUCER-SIDE HALF (WP2 S6): per-destination phase, dispositions, shadows, queues, and the new exit codes.
//
// Named mutations (each shown red in the PR, restored from a copy, md5-verified):
//  d  count-only-the-outbox      derivePreCutoffTotal counts only the outbox: the seeded sync-log arm goes red (exit 6 not reached)
//  f  enforced-not-consulted     the report evaluates a destination the switch does not name: the legacy-identical arm goes red
//  g  expect-held-ignores-live   --expect-held looks only at grants: the LIVE-disposition arm goes red
// ---------------------------------------------------------------------------------------------


const SWITCH = 'PRODUCER_HOLD_ENFORCED_DESTINATIONS'
const XERO_LIVE_FROM = 'XERO_WRITES_LIVE_FROM'
const zero = { outbox: 0, syncLog: 0, links: 0 }
const counts = (over: Partial<ProducerDestinationCounts> = {}): ProducerDestinationCounts => ({
  shadowsLastWindow: 0, shadowsTotal: 0, shadowOccurrencesTotal: 0, shadowsByReason: {},
  queued: { ...zero }, sentLastWindow: { ...zero }, preCutoffQueued: { ...zero }, ...over,
})
const countsRead = (byXero: ProducerDestinationCounts, unrecorded = 0): ProducerCountsRead => ({ byDestination: { xero: byXero }, shadowUnrecorded: unrecorded })
const LIVE_XERO = { [SWITCH]: 'xero', XERO_WRITE_ALLOWED_TENANT: TENANT, [XERO_LIVE_FROM]: '2026-10-01T00:00:00Z' }

async function producerReport(env: Record<string, string | undefined>, read: ProducerCountsRead | 'throw' | 'never') {
  let called = 0
  const built = await buildOutboundStatusReport({
    env, now: NOW, readRefusals: noRefusals,
    readProducerCounts: async () => {
      called += 1
      if (read === 'throw') throw new Error('db down')
      if (read === 'never') throw new Error('must not be called')
      return read
    },
  })
  return { built, called }
}

test('producer half, switch OFF: nothing is read or printed and the exit codes are exactly the legacy ones (a grant without a cut-off still exits 0)', async () => {
  const { built, called } = await producerReport({ XERO_WRITE_ALLOWED_TENANT: TENANT }, 'never')
  assert.equal(called, 0, 'no count is read when nothing is enforced')
  assert.equal(built.producer.enforced, false)
  assert.ok(built.producer.destinations.every((d) => !d.enforced && d.operations.length === 0 && d.counts === null))
  assert.equal(outboundStatusExitCode(built), 0)
  assert.doesNotMatch(renderOutboundStatusText(built), /Producer-side hold/)
  // Only the destinations the switch names are evaluated.
  const { built: one, called: calledOne } = await producerReport({ [SWITCH]: 'woocommerce' }, countsRead(counts()))
  assert.equal(calledOne, 1)
  assert.deepEqual(one.producer.destinations.map((d) => d.enforced), [true, false, false])
})

test('producer half: phase, agreement and the per-operation table come from the environment and the ownership map; the held phase has no LIVE operation', async () => {
  const held = (await producerReport({ [SWITCH]: 'xero' }, countsRead(counts()))).built.producer.destinations[2]!
  assert.equal(held.connector, 'xero')
  assert.equal(held.phase, 'P1')
  assert.equal(held.agreement, 'agreed_held')
  assert.equal(held.liveOperations, 0)
  assert.ok(held.operations.length > 5, `precondition: the table lists the mapped operations (${held.operations.length})`)
  assert.ok(held.operations.every((op) => op.disposition === 'SHADOW'))
  const live = (await producerReport(LIVE_XERO, countsRead(counts()))).built.producer.destinations[2]!
  assert.equal(live.phase, 'P2')
  assert.equal(live.liveFrom, '2026-10-01T00:00:00.000Z')
  assert.equal(live.agreement, 'agreed_live')
  assert.ok(live.liveOperations > 0, 'IMS owns some Xero operations in the live phase')
  const byOp = Object.fromEntries(live.operations.map((op) => [op.operation, op.disposition]))
  assert.equal(byOp['sales.invoice'], 'SHADOW', 'Xeroom keeps sales invoicing in every phase')
  assert.equal(byOp['purchase.bill'], 'LIVE')
})

test('producer half exit codes: pre-cutoff-queued (a SYNC-LOG row alone is enough), inconsistent, shadow-unrecorded, unreadable cut-off, counts unavailable; each is its own table row', async () => {
  const code = (name: string) => OUTBOUND_STATUS_EXIT_CODES.find((row) => row.name === name)!.code
  const exitOf = async (env: Record<string, string | undefined>, read: ProducerCountsRead | 'throw', expectHeld = false) => outboundStatusExitCode((await producerReport(env, read)).built, { expectHeld })

  // (d) Only the sync log holds a pre-cut-off row: counting the outbox alone would call this installation clean.
  assert.equal(await exitOf(LIVE_XERO, countsRead(counts({ preCutoffQueued: { outbox: 0, syncLog: 3, links: 0 } }))), code('pre-cutoff-queued'))
  assert.equal(await exitOf(LIVE_XERO, countsRead(counts({ preCutoffQueued: { outbox: 0, syncLog: 0, links: 2 } }))), code('pre-cutoff-queued'), 'warehouse order links count too')
  assert.equal(await exitOf(LIVE_XERO, countsRead(counts())), 0, 'CONTROL: nothing pre-cut-off is clean')
  assert.equal(derivePreCutoffTotal(counts({ preCutoffQueued: { outbox: 1, syncLog: 2, links: 4 } })), 7)
  // In the held phase the cut-off has not been reached: a queue is expected, and is not reported as a violation.
  assert.equal(await exitOf({ [SWITCH]: 'xero' }, countsRead(counts({ preCutoffQueued: { outbox: 0, syncLog: 9, links: 0 } }))), 0)

  assert.equal(await exitOf({ [SWITCH]: 'xero', [XERO_LIVE_FROM]: '2026-10-01T00:00:00Z' }, countsRead(counts())), code('inconsistent'), 'a cut-off without a grant')
  assert.equal(await exitOf({ [SWITCH]: 'xero', XERO_WRITE_ALLOWED_TENANT: TENANT }, countsRead(counts())), code('inconsistent'), 'a grant without a cut-off')
  assert.equal(await exitOf(LIVE_XERO, countsRead(counts(), 2)), code('shadow-unrecorded'))
  assert.equal(await exitOf({ ...LIVE_XERO, [XERO_LIVE_FROM]: '2026-10-01' }, countsRead(counts())), code('unreadable-grant'), 'an unreadable live-from variable is an operator error to fix')
  assert.equal(await exitOf({ [SWITCH]: 'xerro' }, countsRead(counts())), code('unreadable-grant'), 'an unreadable switch enforces everything and is reported')
  assert.equal(await exitOf(LIVE_XERO, 'throw'), code('counts-unavailable'))
  // Precedence follows the array order of the table.
  const order = OUTBOUND_STATUS_EXIT_CODES.map((row) => row.name)
  assert.deepEqual(order, ['failed', 'usage', 'expected-held-violated', 'unreadable-grant', 'pre-cutoff-queued', 'inconsistent', 'shadow-unrecorded', 'counts-unavailable', 'ok'])
  assert.equal(await exitOf({ ...LIVE_XERO }, countsRead(counts({ preCutoffQueued: { outbox: 1, syncLog: 0, links: 0 } }), 5)), code('pre-cutoff-queued'), 'pre-cutoff-queued outranks shadow-unrecorded')
  assert.equal(new Set(OUTBOUND_STATUS_EXIT_CODES.map((row) => row.code)).size, OUTBOUND_STATUS_EXIT_CODES.length)
})

test('--expect-held also fails on a LIVE disposition, not only on a grant', async () => {
  // A fully live Xero (grant + cut-off) is both: the grant arm and the disposition arm agree here...
  const live = (await producerReport(LIVE_XERO, countsRead(counts()))).built
  assert.equal(outboundStatusExitCode(live, { expectHeld: true }), 4)
  // ...so the disposition arm is proven on its own by a report whose grants read held while a destination decides LIVE.
  const forged = JSON.parse(JSON.stringify(live)) as typeof live
  forged.anyGranted = false
  assert.ok(forged.producer.destinations.some((d) => d.liveOperations > 0), 'precondition: a destination decides LIVE')
  assert.equal(outboundStatusExitCode(forged, { expectHeld: true }), 4, 'LIVE dispositions fail --expect-held by themselves')
  assert.equal(outboundStatusExitCode(forged), 0, 'and only under --expect-held')
})

test('the text report prints phase, shadows, queues, sent counts and the pre-cut-off line, and says what to run', async () => {
  const read = countsRead(counts({
    shadowsLastWindow: 4, shadowsTotal: 11, shadowOccurrencesTotal: 30, shadowsByReason: { no_grant: 9, before_cutoff: 2 },
    queued: { outbox: 2, syncLog: 5, links: 0 }, sentLastWindow: { outbox: 0, syncLog: 1, links: 0 },
    preCutoffQueued: { outbox: 1, syncLog: 3, links: 0 },
  }), 1)
  const text = renderOutboundStatusText((await producerReport(LIVE_XERO, read)).built)
  console.log(text)
  assert.match(text, /Xero\s+LIVE PHASE from 2026-10-01T00:00:00\.000Z/)
  assert.match(text, /shadows: 4 new in the last 24h, 11 distinct and 30 counting repeats in total \(by reason: no_grant: 9, before_cutoff: 2\)/)
  assert.match(text, /queued: 5 accounting sync row\(s\), 2 outbox job\(s\), 0 warehouse order link\(s\)/)
  assert.match(text, /queued BEFORE the live-from instant: 4 - IMS will not deliver these; retire them with npm run retire:held-backlog/)
  assert.match(text, /WARNING: 1 shadow\(s\) could not be recorded/)
  assert.match(text, /not enforced: IMS produces work for it exactly as before/)
  const json = JSON.parse(JSON.stringify((await producerReport(LIVE_XERO, read)).built)) as { producer: { destinations: Array<{ connector: string; counts: { preCutoffQueued: object } | null }> } }
  assert.equal(json.producer.destinations.find((d) => d.connector === 'xero')!.counts!.preCutoffQueued !== undefined, true, 'the JSON carries the counts')
})

test('the CLI returns the new exit codes through the table and prints the producer half', async () => {
  const out: string[] = []
  const run = (env: Record<string, string | undefined>, read: ProducerCountsRead) => runOutboundStatusCli({
    argv: ['--json'], stdout: { log: (m: string) => out.push(m) }, stderr: { error: () => undefined },
    build: () => buildOutboundStatusReport({ env, now: NOW, readRefusals: noRefusals, readProducerCounts: async () => read }),
    disconnect: async () => undefined,
  })
  assert.equal(await run(LIVE_XERO, countsRead(counts({ preCutoffQueued: { outbox: 0, syncLog: 1, links: 0 } }))), OUTBOUND_STATUS_EXIT_CODES.find((r) => r.name === 'pre-cutoff-queued')!.code)
  const parsed = JSON.parse(out.join('\n')) as { exitCode: number; producer: { enforced: boolean } }
  assert.equal(parsed.exitCode, 6)
  assert.equal(parsed.producer.enforced, true)
})
