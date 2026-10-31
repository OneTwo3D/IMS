import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { balancedFrom, blankNonCode, productionSources, ROOT, SHORTHAND, topLevelProperty, walk, WRITE_OPS } from '../accounting/paid-provenance-scan'
import { lockOrderNamedTaxRate } from '../../lib/tax/writable-tax-rate'

/**
 * EVERY WRITER OF `SalesOrder.taxRateName` LOCKS THE ACTIVE RATE IT NAMES, IN THE TRANSACTION THAT WRITES THE ORDER.
 *
 * Why: sales posting and the refund paths resolve an order's default tax identity by "the ACTIVE rate with the order's tax-rate name". The tax import's opt-in `deactivateAbsent`
 * (lib/tax/purchase-tax-import.ts) locks the rate FOR UPDATE and re-counts the orders naming it; that re-count is only complete if no order can commit naming the rate afterwards. A writer
 * that takes FOR KEY SHARE on the named rate (`lockOrderNamedTaxRate`, lib/tax/writable-tax-rate.ts) before it writes makes the two serialise.
 *
 * This is a census over the writers, not a list of files: it walks every `salesOrder.<write>(...)` in app/, lib/ and scripts/, resolves the `data`, and for each write that sets `taxRateName`
 * requires either the lock in the same transaction callback (before the write, on the same expression the write persists) or an entry in the exemptions below with its reason. Raw SQL writers
 * of the column are found separately. A writer it cannot classify fails the test.
 */

type Site = { file: string; line: number; op: string; receiver: string; data: string | null; name: string | null; locked: boolean }

/** The `taxRateName` write sites of one source (every salesOrder write whose data names the column, plus any whose data cannot be read in a file that mentions the column). */
export function salesOrderNameSites(file: string, source: string): Site[] {
  const code = blankNonCode(source)
  const sites: Site[] = []
  const call = new RegExp(`(\\b[\\w$]+)\\s*\\.\\s*salesOrder\\s*\\.\\s*(${WRITE_OPS.join('|')})\\s*\\(`, 'g')
  let m: RegExpExecArray | null
  while ((m = call.exec(code)) !== null) {
    const open = code.indexOf('(', m.index + m[0].length - 1)
    const args = balancedFrom(code, open)
    const line = source.slice(0, m.index).split('\n').length
    const brace = args.indexOf('{')
    const argObject = brace === -1 ? '' : balancedFrom(args, brace)
    const props = m[2] === 'upsert' ? ['create', 'update'] : ['data']
    for (const prop of props) {
      const raw = topLevelProperty(argObject, prop)
      if (raw === null) continue
      let data: string | null = raw
      if (!raw.startsWith('{')) {
        // `data: built` or the shorthand `{ data }`: resolve the local variable's object literal.
        const varName = raw === SHORTHAND ? prop : raw.match(/^[\w$]+$/)?.[0]
        const init = varName ? code.match(new RegExp(`\\b(?:const|let|var)\\s+${varName}\\b[^=\\n]*=\\s*\\{`)) : null
        data = init ? balancedFrom(code, code.indexOf('{', code.indexOf(init[0]))) : null
      }
      const name = data === null ? null : topLevelProperty(data, 'taxRateName')
      // The lock must sit in the SAME transaction callback, before the write, on the value the write persists.
      const txStart = code.lastIndexOf('$transaction(', m.index)
      const segment = txStart === -1 ? '' : code.slice(txStart, m.index)
      const lock = segment.match(/lockOrderNamedTaxRate\s*\(\s*(tx)\s*,\s*([^)]*)\)/)
      const written = name === SHORTHAND ? 'taxRateName' : (name ?? '')
      const locked = lock !== null && m[1] === 'tx' && written !== '' && written.includes(lock[2]!.trim())
      sites.push({ file, line, op: m[2]!, receiver: m[1]!, data, name, locked })
    }
  }
  return sites
}

const scriptSources = (): Array<[string, string]> => {
  assert.ok(statSync(path.join(ROOT, 'scripts')).isDirectory(), `expected the repository root, got ${ROOT}`)
  return walk(path.join(ROOT, 'scripts')).map((f) => [path.relative(ROOT, f), readFileSync(f, 'utf8')])
}
const allSources = (): Array<[string, string]> => [...productionSources(), ...scriptSources()]

/** The raw-SQL writers of the column (UPDATE / INSERT on sales_orders that mention "taxRateName"): template strings are blanked by the code scanner, so this reads the text. */
export function rawNameWriterFiles(sources: ReadonlyArray<readonly [string, string]>): string[] {
  const out = new Set<string>()
  for (const [file, source] of sources) {
    if (/UPDATE\s+"?sales_orders"?[\s\S]{0,3000}?"taxRateName"\s*=/.test(source) || /INSERT\s+INTO\s+"?sales_orders"?[^;`]*"?taxRateName"?/.test(source)) out.add(file)
  }
  return [...out].sort()
}

/** Writers outside the lock, each with the reason it needs none. A new entry needs a reason a reviewer accepts. */
const EXEMPT_FILES: Readonly<Record<string, string>> = {
  'scripts/commerce-accounting-e2e-fixture.ts': 'e2e fixture: seeds a throwaway database for the commerce-to-accounting scenario, never runs beside an operator-run deactivateAbsent',
  'scripts/xero-daily-batch-refund-fixture.ts': 'e2e fixture: seeds a throwaway database for the daily-batch refund scenario, never runs beside an operator-run deactivateAbsent',
}
const EXEMPT_RAW: Readonly<Record<string, string>> = {
  'lib/tax/document-tax-snapshot-refresh.ts': 'the rate editor\'s own header refresh: it renames the header to the EDITED rate, and its only caller (updateTaxRate) holds that rate\'s row lock (lockTaxRateForEdit) to commit',
}

const EXPECTED_LOCKED = [
  'app/actions/sales.ts',                                // createSalesOrder (the form, the CSV import and the API go through it)
  'app/actions/sales.ts',                                // cloneSalesOrder
  'lib/connectors/woocommerce/sync/order-import.ts',     // the WooCommerce order import
]

function censusSites(): Site[] {
  return allSources().flatMap(([file, source]) => salesOrderNameSites(file, source))
}

test('every salesOrder write whose data this scan cannot read is in a file that never mentions taxRateName', () => {
  const unreadable = allSources().flatMap(([file, source]) => (source.includes('taxRateName') ? salesOrderNameSites(file, source).filter((s) => s.data === null) : []))
  assert.deepEqual(unreadable.map((s) => `${s.file}:${s.line}`), [], 'a write whose data cannot be resolved could set taxRateName unlocked: teach the scan the shape')
})

test('the census reaches every writer of SalesOrder.taxRateName and each non-exempt one locks the named rate in its own transaction', () => {
  const writers = censusSites().filter((s) => s.name !== null)
  const outside = writers.filter((s) => !(s.file in EXEMPT_FILES))
  // The writers, listed (the artefact of this census): exactly these, each locked.
  assert.deepEqual(outside.map((s) => s.file).sort(), [...EXPECTED_LOCKED].sort(), `writers found: ${JSON.stringify(writers.map((s) => `${s.file}:${s.line} ${s.receiver}.${s.op}`))}`)
  const unlocked = outside.filter((s) => !s.locked).map((s) => `${s.file}:${s.line} (${s.receiver}.salesOrder.${s.op})`)
  assert.deepEqual(unlocked, [], 'these write SalesOrder.taxRateName without lockOrderNamedTaxRate(tx, <the persisted name>) earlier in the same transaction')
  // The exemptions are real writers (not stale entries), so the table cannot silently outlive its reason.
  for (const file of Object.keys(EXEMPT_FILES)) assert.ok(writers.some((s) => s.file === file), `${file} is exempt but no longer writes taxRateName: remove the entry`)
})

test('the raw-SQL writers of the column are exactly the exempt rate-editor refresh, whose only caller holds the edited rate\'s row lock first', () => {
  const sources = allSources()
  assert.deepEqual(rawNameWriterFiles(sources), Object.keys(EXEMPT_RAW).sort())
  const callers = sources.filter(([file, source]) => file !== 'lib/tax/document-tax-snapshot-refresh.ts' && /refreshMutableDocumentTaxSnapshotsForRate\s*\(/.test(source))
  assert.deepEqual(callers.map(([file]) => file), ['app/actions/settings.ts'])
  const code = blankNonCode(callers[0]![1])
  const lockAt = code.indexOf('lockTaxRateForEdit(tx')
  const refreshAt = code.indexOf('refreshMutableDocumentTaxSnapshotsForRate(tx')
  assert.ok(lockAt !== -1 && refreshAt !== -1 && lockAt < refreshAt, 'the editor locks the edited rate before it refreshes the headers')
})

test('lockOrderNamedTaxRate locks the ACTIVE rate of the name FOR KEY SHARE (the mode a FOR UPDATE deactivation conflicts with) and reports how many rows it locked', async () => {
  const source = readFileSync(path.join(ROOT, 'lib/tax/writable-tax-rate.ts'), 'utf8')
  const body = source.slice(source.indexOf('export async function lockOrderNamedTaxRate'))
  assert.match(body, /WHERE active AND name = \$\{name\}/)
  assert.match(body, /ORDER BY id\s+FOR KEY SHARE/, 'rows are locked in id order, like every other rate lock')
  const seen: string[] = []
  const tx = { $queryRaw: async (query: { sql?: string; values?: unknown[] }) => { seen.push(`${query.sql} <- ${JSON.stringify(query.values)}`); return [{ id: 'a' }, { id: 'b' }] } }
  assert.equal(await lockOrderNamedTaxRate(tx, 'UK VAT'), 2)
  assert.equal(seen.length, 1)
  assert.match(seen[0]!, /FOR KEY SHARE/)
  assert.match(seen[0]!, /\["UK VAT"\]/)
  assert.equal(await lockOrderNamedTaxRate({ $queryRaw: async () => [] }, 'Gone VAT'), 0, 'no active rate of that name: the count is 0')
  for (const empty of [null, undefined, '']) assert.equal(await lockOrderNamedTaxRate(tx, empty), null, 'no name, nothing to lock')
  assert.equal(seen.length, 1, 'no query for an empty name')
  assert.equal(await lockOrderNamedTaxRate({}, 'UK VAT'), null, 'a client with no raw access is not locked')
})

// ---------------------------------------------------------------------------
// PROOF THE DETECTOR CAN FAIL
// ---------------------------------------------------------------------------

const wrap = (inner: string): string => `async function f(db, input) {\n  return db.$transaction(async (tx) => {\n${inner}\n  })\n}`
const sitesOf = (src: string): Site[] => salesOrderNameSites('fixture.ts', src).filter((s) => s.name !== null)

test('the detector accepts a locked writer and reports each unlocked shape', () => {
  const good = sitesOf(wrap(`    await lockOrderNamedTaxRate(tx, input.taxRateName)\n    return tx.salesOrder.create({ data: { orderNumber: 'x', taxRateName: input.taxRateName || null } })`))
  assert.deepEqual(good.map((s) => s.locked), [true])
  const shorthand = sitesOf(wrap(`    await lockOrderNamedTaxRate(tx, taxRateName)\n    return tx.salesOrder.create({ data: { orderNumber: 'x', taxRateName } })`))
  assert.deepEqual(shorthand.map((s) => s.locked), [true], 'shorthand is a write too')
  const offenders: Array<[string, string]> = [
    ['no lock at all', wrap(`    return tx.salesOrder.create({ data: { orderNumber: 'x', taxRateName: input.taxRateName } })`)],
    ['the lock comes after the write', wrap(`    const o = await tx.salesOrder.create({ data: { orderNumber: 'x', taxRateName: input.taxRateName } })\n    await lockOrderNamedTaxRate(tx, input.taxRateName)\n    return o`)],
    ['the lock is on another name', wrap(`    await lockOrderNamedTaxRate(tx, other.name)\n    return tx.salesOrder.create({ data: { orderNumber: 'x', taxRateName: input.taxRateName } })`)],
    ['the lock is on the pooled client, not the transaction', wrap(`    await lockOrderNamedTaxRate(db, input.taxRateName)\n    return tx.salesOrder.create({ data: { orderNumber: 'x', taxRateName: input.taxRateName } })`)],
    ['the write is outside a transaction', `async function f(db, input) {\n  await lockOrderNamedTaxRate(db, input.taxRateName)\n  return db.salesOrder.create({ data: { orderNumber: 'x', taxRateName: input.taxRateName } })\n}`],
    ['the lock is in an earlier, other transaction', `async function f(db, input) {\n  await db.$transaction(async (tx) => { await lockOrderNamedTaxRate(tx, input.taxRateName) })\n  return db.$transaction(async (tx) => tx.salesOrder.create({ data: { orderNumber: 'x', taxRateName: input.taxRateName } }))\n}`],
    ['an update that renames the header', wrap(`    return tx.salesOrder.update({ where: { id: 'a' }, data: { taxRateName: input.taxRateName } })`)],
    ['the data built separately', wrap(`    const data = { orderNumber: 'x', taxRateName: input.taxRateName }\n    return tx.salesOrder.create({ data })`)],
  ]
  for (const [label, src] of offenders) {
    const sites = sitesOf(src)
    assert.equal(sites.length, 1, `${label}: one writer found`)
    assert.equal(sites[0]!.locked, false, `${label}: reported as unlocked`)
  }
  // A write that does not set the column is not a writer.
  assert.deepEqual(sitesOf(wrap(`    return tx.salesOrder.update({ where: { id: 'a' }, data: { status: 'DRAFT' } })`)), [])
  // Raw SQL is found by its own scan.
  assert.deepEqual(rawNameWriterFiles([['a.ts', 'await tx.$executeRaw`UPDATE "sales_orders" AS o SET "taxRateName" = ${n} WHERE id = ${id}`'], ['b.ts', 'await tx.$executeRaw`UPDATE "sales_orders" SET "paidAt" = NULL WHERE id = ${id}`']]), ['a.ts'])
})
