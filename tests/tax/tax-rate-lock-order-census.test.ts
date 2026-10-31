import assert from 'node:assert/strict'
import test from 'node:test'

import { productionSources } from '../accounting/paid-provenance-scan'

/**
 * THE TAX-RATE ROW LOCK ORDER (written down in lib/tax/writable-tax-rate.ts): every transaction that locks MORE THAN ONE tax_rates row does it in ONE statement in ascending id
 * (`... ORDER BY id FOR <mode>`); a statement that locks a single row by `WHERE id = <one value>` cannot form a cycle with an ordered locker. Two statements that each lock rows one after another
 * in name order (or any order other than id) can deadlock against each other, which is what an order write (lines, then header) and the tax import's one-row-at-a-time deactivation did.
 *
 * This census reads every raw `FROM tax_rates ... FOR UPDATE|SHARE|NO KEY UPDATE|KEY SHARE` in app/ and lib/, requires each to be either a single-id lock or `ORDER BY id` before the FOR clause,
 * and pins the set of lock takers, so a new one has to be classified here.
 */

type Taker = { file: string; sql: string }

export function rateLockStatements(sources: ReadonlyArray<readonly [string, string]>): Taker[] {
  const out: Taker[] = []
  for (const [file, source] of sources) {
    const re = /SELECT\s+(?:c\.)?[\w", ]+\s+FROM\s+tax_rates[^`]*?\bFOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)\b/g
    let m: RegExpExecArray | null
    while ((m = re.exec(source)) !== null) out.push({ file, sql: m[0].replace(/\s+/g, ' ') })
  }
  return out
}

/** Ordered (ORDER BY id before FOR) or a lock of exactly one row by id. */
export const orderedOrSingle = (sql: string): boolean => /ORDER BY id FOR /.test(sql) || /WHERE id = \$\{[^}]+\} FOR /.test(sql)

// Every taker, by file. The comment says why the file is consistent.
const EXPECTED: Readonly<Record<string, number>> = {
  'lib/tax/writable-tax-rate.ts': 3,       // resolveWritableTaxRateIds (ids, ordered), lockOrderNamedTaxRate (lines + named rate, ordered), shareLockOrderTaxRates (ordered)
  'lib/tax/purchase-tax-import.ts': 2,     // writePurchaseTaxImport (all touched rows, ordered, up front), lockAndRecheck (one row, already held)
  'lib/tax/tax-rekey.ts': 1,               // the apply: every active rate, ordered
  'lib/tax/tax-rate-replaced.ts': 1,       // lockTaxRateForEdit: one row
}

test('every multi-row tax_rates lock is one ORDER BY id statement, and the lock takers are exactly the classified ones', () => {
  const takers = rateLockStatements(productionSources())
  const bad = takers.filter((t) => !orderedOrSingle(t.sql)).map((t) => `${t.file}: ${t.sql.slice(0, 140)}`)
  assert.deepEqual(bad, [], 'a tax_rates lock that is neither ORDER BY id nor a single-id lock can deadlock against an ordered locker (see the lock order in lib/tax/writable-tax-rate.ts)')
  const counts: Record<string, number> = {}
  for (const t of takers) counts[t.file] = (counts[t.file] ?? 0) + 1
  assert.deepEqual(counts, EXPECTED, 'a new tax_rates lock taker: classify it (and use the one-statement id order) before adding it here')
})

test('the detector reports an unordered multi-row lock and accepts the ordered and single-id shapes', () => {
  const sql = (inner: string): Array<[string, string]> => [['f.ts', 'await tx.$queryRaw`' + inner + '`']]
  const verdict = (inner: string): boolean[] => rateLockStatements(sql(inner)).map((t) => orderedOrSingle(t.sql))
  assert.deepEqual(verdict('SELECT id FROM tax_rates WHERE id = ANY(${ids}::text[]) ORDER BY id FOR SHARE'), [true])
  assert.deepEqual(verdict('SELECT id FROM tax_rates WHERE id = ${id} FOR UPDATE'), [true])
  assert.deepEqual(verdict('SELECT id FROM tax_rates WHERE active ORDER BY id FOR NO KEY UPDATE'), [true])
  assert.deepEqual(verdict('SELECT id FROM tax_rates WHERE name = ANY(${n}) FOR SHARE'), [false], 'no order')
  assert.deepEqual(verdict('SELECT id FROM tax_rates WHERE id = ANY(${ids}::text[]) ORDER BY name FOR UPDATE'), [false], 'wrong order')
  assert.deepEqual(verdict('SELECT id FROM tax_rates WHERE name = ${n} FOR KEY SHARE'), [false], 'one row by name is not a single-id lock')
})
