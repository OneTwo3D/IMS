import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { parseWindowDays, runWritersCheckCli } from '../../scripts/writers-check'
import { evaluateWritersCheck } from '../../lib/ops/writers-check'
import { WRITERS_CHECK_EXIT_CODES } from '../../lib/security/writers-check-constants'

const exitOf = (name: string) => WRITERS_CHECK_EXIT_CODES.find((row) => row.name === name)!.code

function cli(argv: string[], build?: Parameters<typeof runWritersCheckCli>[0] extends infer O ? (O extends { build?: infer B } ? B : never) : never) {
  const out: string[] = []
  const err: string[] = []
  return {
    out, err,
    run: () => runWritersCheckCli({ argv, build, stdout: { log: (m: string) => out.push(m) }, stderr: { error: (m: string) => err.push(m) }, disconnect: async () => undefined }),
  }
}

const okReport = () => evaluateWritersCheck({
  env: {}, now: new Date('2026-10-20T00:00:00Z'), windowDays: 14, settings: new Map(), cronEnabled: {}, pluginEnabled: { woocommerce: true, mintsoft: true, xero: true },
  evidence: Object.fromEntries(['MINTSOFT_ORDER_ID', 'MINTSOFT_OTHER_META', 'XEROOM_MARKER', 'XERO_FOREIGN_NUMBER'].map((k) => [k, { counted: 0, total: 0, unpaid: 0, floor: 'x' }])),
  evidenceUnrecorded: 0,
  unknownEvidenceKinds: 0,
})

test('arguments: only --json and --window-days <1..365>; anything else is usage and reads nothing', async () => {
  for (const bad of [['--bogus'], ['--window-days'], ['--window-days', '0'], ['--window-days', '366'], ['--window-days', '1.5'], ['--window-days', '07'], ['--window-days', 'x'], ['extra']]) {
    let built = false
    const harness = cli(bad, async () => { built = true; return okReport() })
    assert.equal(await harness.run(), exitOf('usage'), bad.join(' '))
    assert.equal(built, false)
  }
  assert.equal(parseWindowDays('14'), 14)
  assert.equal(parseWindowDays('365'), 365)
  assert.equal(parseWindowDays('1'), 1)
})

test('exit code follows the report; --json prints the report; an exception is `failed`, never zero', async () => {
  const seen: number[] = []
  const okRun = cli(['--json', '--window-days', '30'], async (input) => { seen.push(input.windowDays); return okReport() })
  assert.equal(await okRun.run(), 0)
  assert.deepEqual(seen, [30])
  assert.equal(JSON.parse(okRun.out.join('\n')).verdict, 'ok')

  const gap = { ...okReport(), exitCode: exitOf('double-claim') }
  assert.equal(await cli([], async () => gap).run(), exitOf('double-claim'))

  const failing = cli([], async () => { throw new Error('database unavailable') })
  assert.equal(await failing.run(), exitOf('failed'))
  assert.match(failing.err.join('\n'), /database unavailable/)
})

test('the storefront import keeps incumbent evidence before it decides anything (declared site count printed)', () => {
  const source = readFileSync('lib/connectors/woocommerce/sync/order-import.ts', 'utf8')
  const calls = source.match(/(?<![\w.])startWcIncumbentEvidence\(/g) ?? []
  console.log(`# order-import startWcIncumbentEvidence calls=${calls.length}`)
  assert.equal(calls.length, 1)
  const start = source.indexOf('export async function importWcOrder(')
  const tryAt = source.indexOf('try {', start)
  const callAt = source.indexOf('startWcIncumbentEvidence(wcOrder)', start)
  const lookupAt = source.indexOf('db.salesOrder.findFirst', start)
  assert.ok(start > 0 && tryAt > start && callAt > tryAt && callAt < lookupAt, 'the call sits before the first decision of importWcOrder')
  const between = source.slice(tryAt + 5, callAt).replace(/\/\/.*$/gm, '').trim()
  assert.equal(between, '', 'nothing but comments precedes the call inside the try')
  // OFF THE CRITICAL PATH: the call is a bare statement (not awaited, returned, assigned or chained), and the awaitable recorder is not
  // referenced from the import at all, so no promise of the evidence write can be on the import's path.
  const lineStart = source.lastIndexOf('\n', callAt) + 1
  assert.equal(source.slice(lineStart, callAt).trim(), '', 'the call starts its own statement: no await, return or assignment before it')
  assert.equal(source.slice(callAt).split('\n')[0]!.trim(), 'startWcIncumbentEvidence(wcOrder)', 'nothing chained or awaited after the call')
  assert.ok(!/\brecordWcIncumbentEvidence\b/.test(source), 'the awaitable recorder is not used by the import')
  assert.ok(!/\bawait\s+(?:startWc|settleWc)IncumbentEvidence/.test(source), 'the import never awaits the evidence')
})
