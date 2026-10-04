import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

/**
 * o3d-fj4m - THE DISCHARGE WRITE HAS ONE WRITER, AND THE TWO CALL SITES THAT REACH IT PASS WHAT THE
 * HAND-OFF SETTLED, AND A REPLAY DOES NOT REACH IT.
 *
 * The behaviour is proved against a real database in tests/concurrency/refund-relief-never-queued.concurrent.test.ts
 * (real createRefund / retryRefundAccounting). This is the always-on half, as ABSENCE checks (a second
 * spelling of the clear anywhere is the defect, whatever else is also spelled right), each printing how
 * many sites it inspected so a scan that finds nothing is not mistaken for a pass.
 */

const root = process.cwd()
const action = readFileSync(join(root, 'app/actions/sales.ts'), 'utf8')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'generated' || name === '.next') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

test('[o3d-fj4m] the only writer of `accountingRetryRequired: false` in lib/ and app/ is the discharge module', () => {
  const files = [...walk(join(root, 'lib')), ...walk(join(root, 'app'))]
  const writers = files
    .filter((file) => /accountingRetryRequired:\s*false/.test(readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')))
    .map((file) => file.slice(root.length + 1))
  console.log(`o3d-fj4m wiring: files scanned=${files.length}, writers of accountingRetryRequired:false (comments stripped)=${JSON.stringify(writers)}`)
  assert.ok(files.length > 100, 'PRECONDITION: the scan reached the source tree')
  assert.deepEqual(writers, ['lib/domain/sales/refund-accounting-discharge.ts'])
})

test('[o3d-fj4m] every call of clearRefundAccountingRetryState passes the hand-off settlement', () => {
  const calls = [...action.matchAll(/clearRefundAccountingRetryState\(([^)]*)\)/g)].map((m) => m[1].trim())
  const sites = calls.filter((args) => !/refundId: string/.test(args))
  console.log(`o3d-fj4m wiring: clearRefundAccountingRetryState call sites=${sites.length} args=${JSON.stringify(sites)}`)
  assert.equal(sites.length, 2, 'PRECONDITION: the create path and the retry path both discharge through it')
  for (const args of sites) assert.match(args, /,\s*handOffSettlement$/, 'each passes what the hand-off settled')
})

test('[o3d-fj4m] the create path does not discharge a REPLAY, and the hand-off returns what settle() returned', () => {
  const at = action.indexOf('await clearRefundAccountingRetryState(refundResult.createdRefund.id')
  assert.ok(at > 0, 'PRECONDITION: the create-path call exists')
  const guard = action.slice(action.lastIndexOf('if (', at), at)
  console.log(`o3d-fj4m wiring: create-path guard=${guard.replace(/\s+/g, ' ').trim()}`)
  assert.match(guard, /!refundResult\.replayed/, 'a replay handed off no recorded sync, so it discharges nothing')
  assert.match(guard, /handOffSettlement/, 'and it cannot discharge without the settlement it is meant to carry')
  assert.match(action, /return ledger\.settle\(\)/, 'queueRefundAccountingActions returns settle()\'s answer')
  assert.ok(!/^\s*ledger\.settle\(\)\s*$/m.test(action), 'no call discards settle()\'s answer')
})
