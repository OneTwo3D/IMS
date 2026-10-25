import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { TaxRateNotUsableError, resolveLinesTaxRates, resolveWritableTaxRateId, resolveWritableTaxRateIds } from '@/lib/tax/writable-tax-rate'

/**
 * THE SHARED WRITER-SIDE RESOLUTION OF A SUPPLIED TAX RATE ID (lib/tax/writable-tax-rate.ts) over a double, and the census that every writer of a tax rate id uses it.
 * The committed behaviour (the real row share lock against the re-key apply) is in tests/concurrency/tax-rekey.concurrent.test.ts.
 * Each guard has a `[mutation: ...]` line: the change that turns its arm red (made, seen red, reverted).
 */

type Row = { id: string; active: boolean; replacedById: string | null }
function client(rows: Row[], locks: string[][] = []) {
  return {
    taxRate: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => rows.filter((r) => where.id.in.includes(r.id)) },
    $queryRaw: async (_q: TemplateStringsArray, ids: string[]) => { locks.push([...ids]); return [] },
  }
}
const ROWS: Row[] = [
  { id: 'live', active: true, replacedById: null },
  { id: 'old', active: false, replacedById: 'live' },
  { id: 'old2', active: false, replacedById: 'old' },
  { id: 'plain', active: false, replacedById: null },
  { id: 'orphan', active: false, replacedById: 'gone' },
  { id: 'dead-end', active: false, replacedById: 'plain' },
]

// [mutation: the replacedById follow removed -> the retired arm rejects instead of resolving; mutation: the reject removed -> the plain-inactive arm resolves it to itself]
test('an active rate is used; a rate a re-key retired RESOLVES (through a chain); a plainly inactive rate is REJECTED; an unknown id is left to the caller', async () => {
  const map = await resolveWritableTaxRateIds(client(ROWS), ['live', 'old', 'old2', 'nope'])
  assert.deepEqual([...map.entries()].sort(), [['live', 'live'], ['old', 'live'], ['old2', 'live']])
  await assert.rejects(resolveWritableTaxRateIds(client(ROWS), ['plain']), (e: unknown) => e instanceof TaxRateNotUsableError && e.code === 'TAX_RATE_INACTIVE' && e.taxRateId === 'plain')
  await assert.rejects(resolveWritableTaxRateIds(client(ROWS), ['orphan']), (e: unknown) => e instanceof TaxRateNotUsableError && e.code === 'TAX_RATE_REPLACEMENT_MISSING')
  await assert.rejects(resolveWritableTaxRateIds(client(ROWS), ['dead-end']), (e: unknown) => e instanceof TaxRateNotUsableError && e.code === 'TAX_RATE_REPLACEMENT_MISSING', 'a replacement that is itself inactive')
  assert.equal(await resolveWritableTaxRateId(client(ROWS), 'old'), 'live')
  assert.deepEqual([await resolveWritableTaxRateId(client(ROWS), null), await resolveWritableTaxRateId(client(ROWS), undefined), await resolveWritableTaxRateId(client(ROWS), 'nope')], [null, undefined, 'nope'])
})

test('keep (editing a record that already carries it) and lenient (an inbound order) let a plainly inactive rate stand, but a retired one still resolves', async () => {
  assert.equal((await resolveWritableTaxRateIds(client(ROWS), ['plain'], { keep: new Set(['plain']) })).get('plain'), 'plain')
  await assert.rejects(resolveWritableTaxRateIds(client(ROWS), ['plain'], { keep: new Set(['other']) }), TaxRateNotUsableError)
  assert.equal((await resolveWritableTaxRateIds(client(ROWS), ['plain'], { lenient: true })).get('plain'), 'plain')
  assert.equal((await resolveWritableTaxRateIds(client(ROWS), ['old'], { keep: new Set(['old']) })).get('old'), 'live', 'keep never preserves a retired row')
  assert.equal((await resolveWritableTaxRateIds(client(ROWS), ['orphan'], { lenient: true })).get('orphan'), 'orphan')
})

test('lines are resolved in place and counted', async () => {
  const lines = [{ taxRateId: 'old' }, { taxRateId: 'live' }, { taxRateId: null }, {}]
  assert.equal(await resolveLinesTaxRates(client(ROWS), lines), 1)
  assert.deepEqual(lines, [{ taxRateId: 'live' }, { taxRateId: 'live' }, { taxRateId: null }, {}])
})

// [mutation: the share lock removed -> the arm fails (and the committed race arm in the concurrency tier)]
test('the rows the answer rests on are locked FOR SHARE before they are read, including the replacement', async () => {
  const locks: string[][] = []
  await resolveWritableTaxRateIds(client(ROWS, locks), ['old'])
  assert.deepEqual(locks, [['old'], ['live']])
  await resolveWritableTaxRateIds({ taxRate: client(ROWS).taxRate }, ['old'])
})

// ---- the census: every writer of a tax rate id uses the helper ----------------------------------------------------------
const WRITERS: Array<[string, RegExp, string]> = [
  ['app/actions/sales.ts', /resolveLinesTaxRates\(tx, lineData\)/, 'sales order create (lines)'],
  ['app/actions/sales.ts', /resolveWritableTaxRateIds\(tx, so\.lines/, 'sales order clone'],
  ['app/actions/purchase-orders.ts', /resolveLinesTaxRates\(tx, lineData\)/, 'purchase order create (lines)'],
  ['app/actions/purchase-orders.ts', /resolveWritableTaxRateIds\(client, overrideIds/, 'purchase order create / update (overrides)'],
  ['app/actions/suppliers.ts', /resolveWritableTaxRateId\(db, input\.taxRateId \|\| null\)/, 'supplier create'],
  ['app/actions/suppliers.ts', /resolveWritableTaxRateId\(db, input\.taxRateId, \{ keep/, 'supplier update'],
  ['app/actions/wc-sync.ts', /resolveWritableTaxRateId\(db, taxRateId\)/, 'storefront mapping update'],
  ['lib/connectors/woocommerce/sync/taxes.ts', /resolveWritableTaxRateId\(db, existing\.id, \{ lenient: true \}\)/, 'storefront rate import'],
  ['lib/connectors/woocommerce/sync/order-import.ts', /resolveLinesTaxRates\(tx, lineData, \{ lenient: true \}\)/, 'WooCommerce order import'],
]
// [mutation: any one call removed from its writer -> that census row fails]
test('CENSUS: every writer that persists a tax rate id resolves it through the shared helper', () => {
  for (const [file, pattern, what] of WRITERS) assert.match(readFileSync(file, 'utf8'), pattern, `${what} (${file}) must use lib/tax/writable-tax-rate.ts`)
})
