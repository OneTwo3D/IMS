import assert from 'node:assert/strict'
import test from 'node:test'

import { buildOutboundStatusReport, outboundStatusExitCode, renderOutboundStatusText } from '../lib/ops/outbound-status'
import { runOutboundStatusCli } from '../scripts/outbound-status'
import { OUTBOUND_STATUS_EXIT_CODES } from '../lib/security/outbound-write-hold-constants'

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
