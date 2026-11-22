import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

/**
 * #1127 R2 (defence in depth): EVERY READER OF THE "PROVEN NEVER ATTEMPTED" RECORD IS GATED ON A MONEY TYPE OR ON REVISION 0.
 *
 * `attemptProvenNeverMade` / `ATTEMPT_PROVEN_NEVER_MADE_WHERE` read `remoteAttemptedAt` null under stamping custody as proof that no remote call left the row. Only
 * the MONEY fence stamps `remoteAttemptedAt` (STAMPED_MONEY_TYPES); for any other type (a credit note, a COGS reversal) a null stamp under custody proves nothing
 * once the row has been CLAIMED, because a response may have been lost. So every reader must either be scoped to the money types or also require that the row was
 * never claimed (attemptRevision UNCLAIMED_ATTEMPT_REVISION). A new reader without either fails here.
 */
const ROOTS = ['lib', 'app']
const DEFINITION = 'lib/domain/accounting/money-attempt-provenance.ts'
const GATE = /UNCLAIMED_ATTEMPT_REVISION|attemptRevision === 0|STAMPED_MONEY_TYPES|isMoneyMoving|MoneyPost/
/** Readers whose whole function serves one money type (its name says which), so the type is the gate. */
const MONEY_ONLY_FUNCTIONS = new Set(['lib/domain/accounting/invoice-payment-capacity.ts::guardInvoicePaymentCapacity'])

function files(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (name === 'node_modules' || name === 'generated') continue
    if (statSync(path).isDirectory()) out.push(...files(path))
    else if (/\.(ts|tsx)$/.test(name)) out.push(path)
  }
  return out
}

/** The text of the function that encloses `offset`: from its declaration to the first line that closes at column 0. */
function enclosing(src: string, offset: number): { name: string; body: string } {
  const before = src.slice(0, offset)
  const decls = [...before.matchAll(/^(?:export )?(?:async )?function (\w+)|^(?:export )?const (\w+)\s*=\s*(?:async\s*)?\(/gm)]
  const last = decls[decls.length - 1]
  const start = last ? last.index! : 0
  const end = src.indexOf('\n}\n', offset)
  return { name: last ? (last[1] ?? last[2] ?? '<top>') : '<top>', body: src.slice(start, end < 0 ? src.length : end) }
}

test('[#1127 R2] every reader of attemptProvenNeverMade / ATTEMPT_PROVEN_NEVER_MADE_WHERE is gated on a money type or on revision 0', () => {
  const sites: string[] = []
  const ungated: string[] = []
  for (const root of ROOTS) {
    for (const file of files(root)) {
      if (file === DEFINITION) continue
      const src = readFileSync(file, 'utf8')
      for (const match of src.matchAll(/attemptProvenNeverMade\(|\.\.\.ATTEMPT_PROVEN_NEVER_MADE_WHERE|^\s+ATTEMPT_PROVEN_NEVER_MADE_WHERE,?$/gm)) {
        const line = src.slice(src.lastIndexOf('\n', match.index!) + 1, src.indexOf('\n', match.index!))
        if (/^\s*(\/\/|\*)|^import /.test(line)) continue
        const fn = enclosing(src, match.index!)
        const site = `${file}::${fn.name}`
        sites.push(site)
        if (!GATE.test(fn.body) && !MONEY_ONLY_FUNCTIONS.has(site)) ungated.push(site)
      }
    }
  }
  assert.ok(sites.length >= 8, `PRECONDITION: the scan finds the readers (found ${sites.length}: ${sites.join(', ')})`)
  assert.deepEqual(ungated, [], 'a never-attempted reader with no money-type or revision-0 gate')
})

test('[#1127 R2] the refund delete reads "never attempted" through its own predicate, which is gated on revision 0 for the types the money fence never stamps', () => {
  const src = readFileSync('lib/domain/sales/refund-delete-service.ts', 'utf8')
  const fn = enclosing(src, src.indexOf('function neverAttempted(') + 'function neverAttempted('.length)
  assert.equal(fn.name, 'neverAttempted')
  assert.match(fn.body, /STAMPED_MONEY_TYPES[\s\S]*attemptRevision === UNCLAIMED_ATTEMPT_REVISION/)
})
