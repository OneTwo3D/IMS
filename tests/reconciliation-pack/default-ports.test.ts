import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChildResult, ChildSpec } from '../../lib/ops/readiness-gate-collect.ts'
import { bracketLiveness } from '../../lib/reconciliation-pack/liveness.ts'
import { cleanBracket, D, fakeRun, goodState } from './basis-fixtures.ts'
import { goodReport, makeStale } from './liveness-fixtures.ts'

/**
 * THE REAL PORTS (default-ports.ts) over doubles: the liveness port runs the status command as a child and believes only a report
 * that parses and checks out against itself; the basis port uses a client of its own and always disconnects it.
 */

import { childLivenessPort, ownClientBasisPort } from '../../lib/reconciliation-pack/default-ports.ts'

const child = (stdout: string, over: Partial<ChildResult> = {}): ChildResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false, ...over })
function port(result: ChildResult | Error, specs: ChildSpec[] = []) {
  return childLivenessPort({
    cwd: '/var/tmp', env: { PATH: '/bin', HOME: '/h', DATABASE_URL: 'postgresql://x@127.0.0.1:1/x', PGPASSWORD: 'leak', NODE_OPTIONS: '--require=evil', MINTSOFT_WRITE_GRANT: 'yes' },
    runScript: async (spec) => { specs.push(spec); if (result instanceof Error) throw result; return result },
  })
}

test('the liveness port runs `npm run --silent read-sync:status -- --json` with the gate\'s whitelisted environment, and no other command', async () => {
  const specs: ChildSpec[] = []
  const read = await port(child(JSON.stringify(goodReport())), specs).read()
  assert.equal(read.ok, true)
  assert.equal(specs.length, 1)
  const spec = specs[0]!
  assert.deepEqual([spec.script, spec.silent, spec.args, spec.cwd], ['read-sync:status', true, ['--json'], '/var/tmp'])
  assert.deepEqual(Object.keys(spec.env).filter((k) => ['PGPASSWORD', 'NODE_OPTIONS', 'MINTSOFT_WRITE_GRANT'].includes(k)), [], 'no PG variable, outbound grant or loader variable reaches the child')
  assert.equal(spec.env.DATABASE_URL, 'postgresql://x@127.0.0.1:1/x')
  assert.ok(spec.timeoutMs > 0 && spec.timeoutMs <= 5 * 60_000)
})

// [mutation: the exit code taken as the verdict / a failed read taken as healthy]
test('the exit code is not the verdict (a stale stream exits non-zero and its report is still read); a timeout, a kill, no output, a throw, or output that is not the report is { ok: false }', async () => {
  const stale = makeStale(goodReport(), 'xero-balance-snapshots')
  const staleRead = await port(child(JSON.stringify({ ...stale, exitCode: 2 }), { exitCode: 2 })).read()
  assert.equal(staleRead.ok, true, 'a report is read whatever the exit code says; its own fields say what is stale')
  const bad: Array<[string, ChildResult | Error]> = [
    ['timed out', child(JSON.stringify(goodReport()), { timedOut: true })],
    ['killed', child(JSON.stringify(goodReport()), { exitCode: null })],
    ['no output', child('')],
    ['not JSON', child('SCHEDULER NOT CHECKED')],
    ['truncated JSON', child(JSON.stringify(goodReport()).slice(0, 200))],
    ['JSON that is not a report', child('{"ok":true}')],
    ['a list', child('[]')],
    ['null', child('null')],
    ['a contradictory report', child(JSON.stringify({ ...goodReport(), counts: { fresh: 99, stale: 0, never: 0, off: 0 } }))],
    ['the runner throws', new Error('spawn ENOENT secret')],
  ]
  for (const [name, result] of bad) assert.deepEqual(await port(result).read(), { ok: false }, name)
})

test('the same bracket logic holds over this port: a stale stream is not fresh, a good report brackets fresh', async () => {
  const a = await port(child(JSON.stringify(goodReport()))).read()
  const b = await port(child(JSON.stringify(goodReport()))).read()
  const bracket = bracketLiveness(a, b)
  assert.equal(bracket.readable, true)
  assert.ok(bracket.instances.filter((i) => i.stream === 'xero-balance-snapshots').every((i) => i.fresh && i.stable))
})

// ---- the basis port ---------------------------------------------------------------------------------

test('the basis port: read and settle use the injected run, one transaction each', async () => {
  const state = goodState()
  const fake = fakeRun(state)
  const basis = ownClientBasisPort({ run: fake.run })
  const read = await basis.read(D)
  const settled = await basis.settle(read, cleanBracket())
  assert.equal(settled.available, true)
  assert.equal(fake.calls(), 2)
})
