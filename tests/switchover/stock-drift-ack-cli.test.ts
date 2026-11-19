import assert from 'node:assert/strict'
import test from 'node:test'

import { runStockDriftAckCli } from '../../scripts/switchover-stock-drift-ack'

/** The acknowledgement CLI: usage errors, dry run by default, and --yes writes through the domain function (a fake database; nothing real is touched). */
const event = { id: 'e1', externalProductId: '5', sku: 'S5', fromQuantity: 9, toQuantity: 7, observedAt: new Date('2027-01-11T12:00:00Z') }
function fakeDb() {
  const calls: Array<{ op: string; args: unknown }> = []
  return {
    calls,
    db: {
      wcStockDriftEvent: {
        findMany: async (args: unknown) => { calls.push({ op: 'findMany', args }); return [event] },
        updateMany: async (args: unknown) => { calls.push({ op: 'updateMany', args }); return { count: 1 } },
      },
    },
  }
}
const sink = () => { const lines: string[] = []; return { lines, log: (m: string) => { lines.push(m) }, error: (m: string) => { lines.push(m) } } }

test('--list prints the unacknowledged events; usage errors exit 3', async () => {
  const f = fakeDb(); const out = sink()
  assert.equal(await runStockDriftAckCli({ argv: ['--list'], db: f.db as never, stdout: out, stderr: out, disconnect: async () => {} }), 0)
  assert.match(out.lines[0]!, /e1 {2}product 5 \(S5\) {2}9 -> 7/)
  for (const argv of [[], ['--event', 'e1'], ['--event', 'e1', '--by', 'jan'], ['--list', '--yes'], ['--bogus']]) {
    assert.equal(await runStockDriftAckCli({ argv, db: f.db as never, stdout: sink(), stderr: sink(), disconnect: async () => {} }), 3, argv.join(' '))
  }
})

test('without --yes nothing is written; with --yes the event is acknowledged with who and why', async () => {
  const dry = fakeDb()
  assert.equal(await runStockDriftAckCli({ argv: ['--event', 'e1', '--by', 'jan', '--note', 'reviewed'], db: dry.db as never, stdout: sink(), stderr: sink(), disconnect: async () => {} }), 0)
  assert.equal(dry.calls.filter((c) => c.op === 'updateMany').length, 0)
})
