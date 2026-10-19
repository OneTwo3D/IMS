/**
 * The apply manifest and the prepared-run loader. Every refusal arm is paired with an HONEST CONTROL (the unmodified synthetic run loads), edits
 * only what the arm names, asserts the specific problem, and prints how many arms examined it. Where two checks could each refuse the same edit
 * (a SHA-256 and a row check), `withConsistentFile` rewrites the report's hash, size and row count so only the check under test can fire.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { ApplyManifestError, parseApplyManifest } from '../../lib/first-load/apply/manifest.ts'
import { loadPreparedRun } from '../../lib/first-load/apply/prepared.ts'
import { TRANSFERS_REFUSAL } from '../../lib/first-load/apply/constants.ts'
import { IMPORT_TARGETS, MAX_ROWS_PER_FILE, MAX_BYTES_PER_FILE } from '../../lib/first-load/spec.ts'
import { load, loadOk, manifest, manifestText, prepareSynthetic, preparedFiles, problemsOf, withConsistentFile, withFile, withReport, type EditableReport, type FileMap } from './apply-helpers.ts'
import { sha256Hex } from '../../lib/first-load/snapshot.ts'
import { precondition } from './helpers.ts'

const honest: FileMap = preparedFiles(prepareSynthetic())
const PRODUCTS = '02-products-001-of-001.csv'
const STOCK = '03-opening-stock-001-of-001.csv'
const SUPPLIERS = '01-suppliers-001-of-001.csv'
const ORDERS = '05-purchase-orders-001-of-001.csv'

function expectProblem(files: FileMap, pattern: RegExp, overrides: Record<string, unknown> = {}): string[] {
  const problems = problemsOf(files, overrides)
  assert.ok(problems.some((p) => pattern.test(p)), `expected a problem matching ${pattern}, got: ${JSON.stringify(problems)}`)
  return problems
}

test('control: the unmodified synthetic prepared run loads, with every claim checked', (t) => {
  const run = loadOk(honest)
  precondition(t, 'selected steps', run.steps.length)
  assert.deepEqual(run.steps.map((s) => [s.step, s.units.length]), [['suppliers', 2], ['products', 8], ['opening-stock', 4], ['purchase-orders', 2]])
  assert.deepEqual(run.zeroCostPairs, ['ZQSENT-TSHIRT-M@ZQSENT-MAIN'])
  assert.deepEqual(run.warehouseCodes, ['ZQSENT-MAIN', 'ZQSENT-OVER'])
  assert.match(run.manifestDigest, /^[0-9a-f]{64}$/)
})

test('the digest changes with the manifest and with the prepared files, and ignores locations', (t) => {
  const base = loadOk(honest).manifestDigest
  const digests = new Map<string, string>()
  digests.set('runId', loadOk(honest, { runId: 'other-run' }).manifestDigest)
  digests.set('steps', loadOk(honest, { steps: ['suppliers', 'products'], expectWarehouses: undefined, acceptZeroCost: undefined, fxRates: undefined }).manifestDigest)
  digests.set('profile', loadOk(honest, { expectWarehouses: { 'ZQSENT-MAIN': { type: 'STANDARD', availableForSale: true, syncToStore: true }, 'ZQSENT-OVER': { type: 'RESTOCK', availableForSale: false, syncToStore: false } } }).manifestDigest)
  digests.set('file byte', loadOk(withConsistentFile(honest, SUPPLIERS, (text) => text.replace('GBP', 'USD'))).manifestDigest)
  precondition(t, 'variants compared', digests.size)
  for (const [what, digest] of digests) assert.notEqual(digest, base, `${what} must change the digest`)
  assert.equal(new Set([...digests.values(), base]).size, digests.size + 1, 'and no two variants collide')
  // Locations are not part of the load.
  assert.equal(loadOk(honest, { preparedDir: '/elsewhere', restorePointDir: '/other/restore' }).manifestDigest, base)
})

// ---------------------------------------------------------------------------------------------------------------------------------
// The apply manifest
// ---------------------------------------------------------------------------------------------------------------------------------

test('manifest: control parses; every malformed manifest is refused with its reason (and all reasons at once)', (t) => {
  assert.doesNotThrow(() => parseApplyManifest(manifestText()))
  const arms: Array<[string, Record<string, unknown>, RegExp]> = [
    ['unknown key', { surprise: 1 }, /unknown apply manifest key "surprise"/],
    ['format version', { formatVersion: 2 }, /formatVersion must be 1/],
    ['bad run id', { runId: 'has space' }, /runId/],
    ['base currency not GBP', { baseCurrency: 'USD' }, /must be GBP/],
    ['base currency missing', { baseCurrency: undefined }, /baseCurrency is required/],
    ['step unknown', { steps: ['suppliers', 'transfers'] }, /not a step/],
    ['step twice', { steps: ['suppliers', 'suppliers'] }, /twice/],
    ['steps out of order', { steps: ['products', 'suppliers', 'opening-stock', 'purchase-orders'] }, /load order/],
    ['missing prerequisite', { steps: ['opening-stock'], expectWarehouses: WAREHOUSES_ONE, acceptZeroCost: undefined, fxRates: undefined }, /needs products/],
    ['warehouses required', { expectWarehouses: undefined }, /expectWarehouses is required/],
    ['warehouses with nothing to check', { steps: ['suppliers', 'products'], acceptZeroCost: undefined, fxRates: undefined }, /no step uses a warehouse/],
    ['profile incomplete', { expectWarehouses: { 'ZQSENT-MAIN': { type: 'STANDARD', availableForSale: true } } }, /availableForSale and syncToStore must both/],
    ['profile type', { expectWarehouses: { 'ZQSENT-MAIN': { type: 'SHELF', availableForSale: true, syncToStore: false } } }, /type must be one of/],
    ['profile key', { expectWarehouses: { 'ZQSENT-MAIN': { type: 'STANDARD', availableForSale: true, syncToStore: false, extra: 1 } } }, /unknown key "extra"/],
    ['warehouse twice in upper case', { expectWarehouses: { 'ZQSENT-MAIN': WAREHOUSES_ONE['ZQSENT-MAIN'], 'zqsent-main': WAREHOUSES_ONE['ZQSENT-MAIN'] } }, /twice/],
    ['zero-cost entry shape', { acceptZeroCost: ['NOWAREHOUSE'] }, /not "SKU@WAREHOUSE"/],
    ['zero-cost twice', { acceptZeroCost: ['A@ZQSENT-MAIN', 'a@zqsent-main'] }, /twice/],
    ['zero-cost without stock step', { steps: ['suppliers', 'products'], expectWarehouses: undefined, fxRates: undefined }, /opening-stock is not a step/],
    ['fx as number', { fxRates: { EUR: 1.25 } }, /must be a string/],
    ['fx zero', { fxRates: { EUR: '0' } }, /greater than zero/],
    ['fx for base currency', { fxRates: { GBP: '1' } }, /must not list the base currency/],
    ['fx without purchase orders', { steps: ['suppliers', 'products', 'opening-stock'], expectWarehouses: WAREHOUSES_ONE }, /purchase-orders is not a step/],
    ['restore dir relative', { restorePointDir: 'restore' }, /absolute path/],
    ['woo snapshot incomplete', { wooSnapshot: { snapshot: 'a' } }, /wooSnapshot/],
  ]
  precondition(t, 'refusal arms', arms.length)
  for (const [label, overrides, pattern] of arms) {
    let error: unknown
    try { parseApplyManifest(manifestText(overrides)) } catch (e) { error = e }
    assert.ok(error instanceof ApplyManifestError, `${label}: was not refused`)
    assert.match((error as ApplyManifestError).message, pattern, label)
  }
  assert.throws(() => parseApplyManifest('{not json'), /not valid JSON/)
  // All reasons at once, not the first.
  assert.ok((() => { try { parseApplyManifest(manifestText({ surprise: 1, runId: '!', formatVersion: 3 })) } catch (e) { return (e as ApplyManifestError).problems.length >= 3 } return false })())
})
const WAREHOUSES_ONE = { 'ZQSENT-MAIN': { type: 'STANDARD', availableForSale: true, syncToStore: false } }

// ---------------------------------------------------------------------------------------------------------------------------------
// The prepared report: the tool's own verdict
// ---------------------------------------------------------------------------------------------------------------------------------

test('report: a blocked, unbalanced, self-check-failing or ERROR-bearing report is refused; so is another base currency', (t) => {
  const arms: Array<[string, (r: EditableReport) => void, RegExp]> = [
    ['verdict BLOCKED', (r) => { r.verdict = 'BLOCKED' }, /not PASS/],
    ['self-check failures', (r) => { r.selfCheckFailures = ['x'] }, /self-check failures/],
    ['accounting does not balance', (r) => { r.accountingBalanced = false }, /does not balance/],
    ['unaccounted records', (r) => { r.accounting[0].unaccounted = 1 }, /unaccounted/],
    ['ERROR finding', (r) => { r.findings.push({ severity: 'ERROR', code: 'SOMETHING_BAD', message: 'm' }) }, /ERROR finding.*SOMETHING_BAD/],
    ['other tool', (r) => { r.tool = 'something-else' }, /not a first-load-prepare report/],
    ['prepared for USD', (r) => { r.config.baseCurrency = 'USD' }, /different base currency/],
  ]
  precondition(t, 'refusal arms', arms.length)
  for (const [label, edit, pattern] of arms) {
    const problems = problemsOf(withReport(honest, edit))
    assert.ok(problems.some((p) => pattern.test(p)), `${label}: ${JSON.stringify(problems)}`)
  }
  assert.deepEqual(problemsOf(new Map([...honest].filter(([name]) => name !== 'validation-report.json'))).length, 1)
})

test('files: a changed byte, a stray file, a missing file, a wrong header, a wrong size and a wrong row count are each refused on their own', (t) => {
  const arms: Array<[string, FileMap, RegExp]> = [
    ['one byte changed', withFile(honest, SUPPLIERS, (s) => s.replace('Cotton', 'Cottom')), /SHA-256 differs/],
    ['stray file', new Map([...honest, ['extra.csv', new TextEncoder().encode('x')]]), /does not name: extra\.csv/],
    ['missing file', new Map([...honest].filter(([n]) => n !== STOCK)), /missing from the prepared directory/],
    ['header renamed (hash kept consistent)', withConsistentFile(honest, STOCK, (s) => s.replace('unitCostBase', 'unitCost')), /template header/],
    ['row count wrong in the report', withReport(honest, (r) => { r.outputs.find((o) => o.name === SUPPLIERS)!.rows = 3 }), /data row\(s\), the report says 3/],
    ['size wrong in the report', withReport(honest, (r) => { r.outputs.find((o) => o.name === SUPPLIERS)!.bytes += 1 }), /byte\(s\), the report says/],
    ['planned rows wrong', withReport(honest, (r) => { r.plannedOutputRows.products += 1 }), /the report plans/],
    ['chunk numbering', withReport(honest, (r) => { r.outputs.find((o) => o.name === SUPPLIERS)!.chunk = 2 }), /chunk numbering/],
    ['a row the importer would silently skip', withConsistentFile(honest, SUPPLIERS, (s) => s.replace(',ZQSENT Cotton Ltd,', ',#ZQSENT Cotton Ltd,').replace('\r\n,#Cotton', '\r\n#,Cotton')), /silently skip/],
    ['not UTF-8', (() => { const m = new Map(honest); m.set(SUPPLIERS, Uint8Array.from([0xff, 0xfe, 0x41])); return m })(), /not valid UTF-8/],
  ]
  precondition(t, 'refusal arms', arms.length)
  for (const [label, files, pattern] of arms) {
    const problems = problemsOf(files)
    assert.ok(problems.some((p) => pattern.test(p)), `${label}: ${JSON.stringify(problems)}`)
  }
})

test('limits: more than 9,999 rows, or 9,999,999 bytes, in a file is refused even when the report agrees with the file', (t) => {
  const header = IMPORT_TARGETS.suppliers.headers
  const blank = header.map(() => '')
  const many = withConsistentFile(honest, SUPPLIERS, (s) => s + Array.from({ length: MAX_ROWS_PER_FILE }, (_, i) => `${['', `Extra ${i}`, ...blank.slice(2)].join(',')}\r\n`).join(''))
  const rows = problemsOf(many)
  precondition(t, 'rows in the oversized file', MAX_ROWS_PER_FILE + 2)
  assert.ok(rows.some((p) => /exceeds the 9999 row limit/.test(p)), JSON.stringify(rows.slice(0, 3)))
  const big = withConsistentFile(honest, SUPPLIERS, (s) => s.replace('ZQSENT Cotton Ltd,,', `ZQSENT Cotton Ltd,,${'x'.repeat(MAX_BYTES_PER_FILE)}`))
  assert.ok(problemsOf(big).some((p) => /byte limit/.test(p)))
  // The control for the limits: exactly at the boundary is NOT refused for size.
  const atLimit = withConsistentFile(honest, SUPPLIERS, (s) => s + Array.from({ length: MAX_ROWS_PER_FILE - 2 }, (_, i) => `${['', `Extra ${i}`, ...blank.slice(2)].join(',')}\r\n`).join(''))
  assert.ok(!problemsOf(atLimit).some((p) => /row limit/.test(p)), 'a file at 9,999 rows is within the limit')
})

test('transfers: a prepared run that contains transfers is refused with the explicit reason', (t) => {
  const planned = problemsOf(withReport(honest, (r) => { r.plannedOutputRows.transfers = 2 }))
  precondition(t, 'transfer arms', 2)
  assert.ok(planned.includes(TRANSFERS_REFUSAL))
  const named = problemsOf(withReport(honest, (r) => { r.outputs.push({ name: '04-transfers-001-of-001.csv', target: 'transfers', chunk: 1, chunks: 1, rows: 1, bytes: 1, sha256: 'a'.repeat(64) }) }))
  assert.ok(named.includes(TRANSFERS_REFUSAL))
})

// ---------------------------------------------------------------------------------------------------------------------------------
// Keys and cross-file references (the hash is kept consistent, so only the check under test can fire)
// ---------------------------------------------------------------------------------------------------------------------------------

test('keys: duplicate and look-alike keys, ids and unusable cells are refused', (t) => {
  const oak = ',,ZQSENT-OAK-BOARD,Name of ZQSENT-OAK-BOARD,,SIMPLE,,,,,,,,,,,,,,,,,,,,,'
  const arms: Array<[string, FileMap, RegExp]> = [
    ['duplicate SKU', withConsistentFile(honest, PRODUCTS, (s) => s.replace(oak, `${oak}\r\n${oak}`)), /the same key as chunk 1 line/],
    ['SKU differing only in case', withConsistentFile(honest, PRODUCTS, (s) => s.replace(oak, `${oak}\r\n${oak.replace('ZQSENT-OAK-BOARD,Name', 'zqsent-oak-board,Name')}`)), /only in letter case/],
    ['a productId', withConsistentFile(honest, PRODUCTS, (s) => s.replace(oak, oak.replace(',,ZQSENT-OAK', 'p1,,ZQSENT-OAK'))), /productId must be blank/],
    // Mutation: drop 'preferredSupplierId' from ID_COLUMNS (keys.ts) and this arm goes red, because the cell is then accepted and reads back as a conflict after a successful import.
    ['a preferredSupplierId', withConsistentFile(honest, PRODUCTS, (s) => s.replace(oak, oak.replace('SIMPLE,,,,,', 'SIMPLE,,,,,ZQSENT-SUPPLIER-ID'))), /preferredSupplierId must be blank/],
    ['duplicate supplier name in other case', withConsistentFile(honest, SUPPLIERS, (s) => s.replace(',ZQSENT Timber Co,', ',ZQSENT Cotton LTD,')), /only in letter case|the same key as/],
    ['duplicate opening-stock pair', withConsistentFile(honest, STOCK, (s) => s.replace('ZQSENT-LEG-01,ZQSENT-MAIN,8,12.000000', 'ZQSENT-OAK-BOARD,ZQSENT-MAIN,8,12.000000')), /the same key as chunk 1 line/],
    ['zero opening quantity', withConsistentFile(honest, STOCK, (s) => s.replace('ZQSENT-LEG-01,ZQSENT-MAIN,8,', 'ZQSENT-LEG-01,ZQSENT-MAIN,0,')), /greater than zero/],
    ['a KIT without components', withConsistentFile(honest, PRODUCTS, (s) => s.replace('ZQSENT-OAK-BOARD:2;ZQSENT-TSHIRT-S:1', '')), /without components/],
    ['components on a SIMPLE product', withConsistentFile(honest, PRODUCTS, (s) => s.replace(oak, oak.replace(/,,$/, ',ZQSENT-OAK-BOARD:1,'))), /only a KIT or BOM can carry components/],
    ['a purchase order whose lines disagree', withConsistentFile(honest, ORDERS, (s) => s.replace('QBX-ZQSENT-PO-5002,ZQSENT Cotton Ltd,EUR,1.25,ZQSENT-MAIN,ZQSENT-TSHIRT-S', 'QBX-ZQSENT-PO-5002,ZQSENT Cotton Ltd,EUR,1.25,ZQSENT-OVER,ZQSENT-TSHIRT-S')), /disagrees with chunk 1 line 3 on destinationWarehouseCode/],
  ]
  precondition(t, 'refusal arms', arms.length)
  for (const [label, files, pattern] of arms) {
    const problems = problemsOf(files)
    assert.ok(problems.some((p) => pattern.test(p)), `${label}: ${JSON.stringify(problems)}`)
  }
})

test('cross-file: a missing parent, a missing component, a recipe cycle, stock on a non-stock product, an unknown SKU and an unknown supplier are refused', (t) => {
  const arms: Array<[string, FileMap, RegExp]> = [
    ['variant whose parent is not in the file', withConsistentFile(honest, PRODUCTS, (s) => s.replace('VARIANT,ZQSENT-TSHIRT,', 'VARIANT,ZQSENT-NOPE,').replace('VARIANT,ZQSENT-TSHIRT,', 'VARIANT,ZQSENT-NOPE,')), /is not a VARIABLE product in the same files/],
    ['variant parent that is not VARIABLE', withConsistentFile(honest, PRODUCTS, (s) => s.replace('VARIANT,ZQSENT-TSHIRT,', 'VARIANT,ZQSENT-OAK-BOARD,')), /is not a VARIABLE product/],
    ['component not in the catalogue (silent recipe loss)', withConsistentFile(honest, PRODUCTS, (s) => s.replace('ZQSENT-LEG-01:4;ZQSENT-OAK-BOARD:2', 'ZQSENT-GONE-01:4;ZQSENT-OAK-BOARD:2')), /would count the product created and load no recipe/],
    ['recipe containing its own product', withConsistentFile(honest, PRODUCTS, (s) => s.replace(',ZQSENT-OAK-BOARD:0.5,', ',ZQSENT-LEG-01:1,')), /its own product/],
    ['recipe cycle', withConsistentFile(honest, PRODUCTS, (s) => s.replace(',ZQSENT-OAK-BOARD:0.5,', ',ZQSENT-TABLE-01:1,')), /recipe cycle/],
    ['stock on a NON_INVENTORY product', withConsistentFile(honest, STOCK, (s) => s.replace('ZQSENT-LEG-01,ZQSENT-MAIN,8,12.000000,Name of ZQSENT-LEG-01,BOM', 'ZQSENT-LICENCE-FEE,ZQSENT-MAIN,8,12.000000,Name of ZQSENT-LICENCE-FEE,NON_INVENTORY')), /type cannot hold opening stock/],
    ['stock on a VARIABLE parent', withConsistentFile(honest, STOCK, (s) => s.replace('ZQSENT-LEG-01,ZQSENT-MAIN,8,12.000000,Name of ZQSENT-LEG-01,BOM', 'ZQSENT-TSHIRT,ZQSENT-MAIN,8,12.000000,Name of ZQSENT-TSHIRT,VARIABLE')), /type cannot hold opening stock/],
    ['stock on a KIT', withConsistentFile(honest, STOCK, (s) => s.replace('ZQSENT-LEG-01,ZQSENT-MAIN,8,12.000000,Name of ZQSENT-LEG-01,BOM', 'ZQSENT-GIFT-SET,ZQSENT-MAIN,8,12.000000,Name of ZQSENT-GIFT-SET,KIT')), /type cannot hold opening stock/],
    ['stock on an unknown SKU', withConsistentFile(honest, STOCK, (s) => s.replace('ZQSENT-LEG-01,ZQSENT-MAIN', 'ZQSENT-GHOST,ZQSENT-MAIN')), /is not a product in the products file/],
    ['order from a supplier not in the file', withConsistentFile(honest, ORDERS, (s) => s.replace('QBX-ZQSENT-PO-5001,ZQSENT Timber Co', 'QBX-ZQSENT-PO-5001,ZQSENT Nobody Ltd')), /is not in the suppliers file/],
    ['order for an unknown SKU', withConsistentFile(honest, ORDERS, (s) => s.replace('ZQSENT-MAIN,ZQSENT-OAK-BOARD,60', 'ZQSENT-MAIN,ZQSENT-GHOST,60')), /is not a product in the products file/],
  ]
  precondition(t, 'refusal arms', arms.length)
  for (const [label, files, pattern] of arms) {
    const problems = problemsOf(files)
    assert.ok(problems.some((p) => pattern.test(p)), `${label}: ${JSON.stringify(problems)}`)
  }
})

test('chain to the tool: opening-stock quantity and value must equal the prepared report even when the file hash is kept consistent', () => {
  const changed = withConsistentFile(honest, STOCK, (s) => s.replace('ZQSENT-OAK-BOARD,ZQSENT-MAIN,60,5.333333', 'ZQSENT-OAK-BOARD,ZQSENT-MAIN,61,5.333333'))
  const problems = problemsOf(changed)
  assert.ok(problems.some((p) => /TOTAL_QUANTITY_MISMATCH/.test(p)), JSON.stringify(problems))
  assert.ok(problems.some((p) => /TOTAL_VALUE_MISMATCH/.test(p)))
  // Mutation: put the figures back into the text and this fails. No quantity or value of the file or of the report reaches a problem string.
  const marked = withReport(changed, (r) => { r.stock.totals.openingQty = '918273.645'; r.stock.totals.openingValueBase = '564738.291837' })
  const text = problemsOf(marked).join('\n')
  assert.match(text, /TOTAL_QUANTITY_MISMATCH/)
  for (const figure of ['918273', '564738', '61', '443.83', '76']) assert.ok(!new RegExp(`(^|[^0-9])${figure.replace('.', '\\.')}([^0-9]|$)`).test(text), `the figure ${figure} is not printed`)
  // The same edit with the totals ALSO fixed in the report is the tool's problem, not a tampering: it is accepted at this layer.
  const fixed = withReport(changed, (r) => { r.stock.totals.openingQty = '77'; r.stock.totals.openingValueBase = '443.833313' })
  assert.deepEqual(problemsOf(fixed), [])
})

// ---------------------------------------------------------------------------------------------------------------------------------
// Operator assertions are checked, never trusted, and an unused one is refused
// ---------------------------------------------------------------------------------------------------------------------------------

test('zero cost: the accepted set must EQUAL the zero-cost pairs in the file (a missing and an extra entry are each refused)', (t) => {
  precondition(t, 'zero-cost pairs in the control', loadOk(honest).zeroCostPairs.length)
  expectProblem(honest, /1 zero-cost pair\(s\) are not accepted.*first at chunk 1 line 5/, { acceptZeroCost: [] })
  expectProblem(honest, /accepts 1 pair\(s\) that have no zero-cost opening stock/, { acceptZeroCost: ['ZQSENT-TSHIRT-M@ZQSENT-MAIN', 'zqsent-oak-board@zqsent-main'] })
  const noFinding = withReport(honest, (r) => { r.findings = r.findings.filter((f) => f.code !== 'ZERO_COST_OPENING_STOCK') })
  expectProblem(noFinding, /1 zero-cost row\(s\) in the file, 0 in the prepared report/)
})

test('warehouses: every code used must be declared and every declared code used', (t) => {
  precondition(t, 'warehouses', loadOk(honest).warehouseCodes.length)
  expectProblem(honest, /1 warehouse code\(s\) used by the files are not declared.*opening-stock chunk 1 line 4/, { expectWarehouses: { 'ZQSENT-MAIN': { type: 'STANDARD', availableForSale: true, syncToStore: false } } })
  expectProblem(honest, /declared in the apply manifest expectWarehouses but used by no selected file/, { expectWarehouses: { 'ZQSENT-MAIN': { type: 'STANDARD', availableForSale: true, syncToStore: false }, 'ZQSENT-OVER': { type: 'RESTOCK', availableForSale: false, syncToStore: false }, 'QUARANTINE-CAMBRIDGE': { type: 'QUARANTINE', availableForSale: false, syncToStore: false } } })
  expectProblem(withReport(honest, (r) => { r.warehouseCodesUsed = ['ZQSENT-MAIN'] }), /1 warehouse code\(s\) in the files are not listed by the prepared report \(first use at opening-stock chunk 1 line 4\)/)
})

test('fx rates: a missing, a different and an unused rate are each refused', (t) => {
  precondition(t, 'non-base orders', 1)
  expectProblem(honest, /the currency has no rate in the apply manifest fxRates/, { fxRates: undefined })
  expectProblem(honest, /fxRateToBase differs from the rate the apply manifest states/, { fxRates: { EUR: '1.3' } })
  expectProblem(honest, /lists a currency that no selected purchase order uses/, { fxRates: { EUR: '1.25', USD: '1.3' } })
})

test('owner rulings: a SKU the manifest forbids may appear in no prepared file, in any case, as a SKU, parent or component', (t) => {
  precondition(t, 'forbidden SKUs matched', 1)
  expectProblem(honest, /1 row\(s\) of the prepared files contain a SKU the apply manifest forbids.*02-products-001-of-001\.csv line 2/, { forbidSkus: ['zqsent-licence-fee'] })
  expectProblem(honest, /forbids/, { forbidSkus: ['zqsent-tshirt'] })
  expectProblem(honest, /forbids/, { forbidSkus: ['ZQSENT-LEG-01'] })
  assert.ok(load(honest, { forbidSkus: ['XY-NOT-HERE'] }).ok, 'a forbidden SKU that is absent changes nothing')
})

test('steps: a selected step with no prepared file is refused; an unselected one is recorded, not loaded', () => {
  const noOrders = new Map([...honest].filter(([n]) => n !== ORDERS))
  const withoutOrders = withReport(noOrders, (r) => { r.outputs = r.outputs.filter((o) => o.name !== ORDERS); r.plannedOutputRows['purchase-orders'] = 0 })
  expectProblem(withoutOrders, /selects purchase-orders but the prepared run has no purchase-orders file/)
  const run = loadOk(honest, { steps: ['suppliers', 'products', 'opening-stock'], fxRates: undefined })
  assert.deepEqual(run.notSelected, ['purchase-orders'])
  assert.deepEqual(run.steps.map((s) => s.step), ['suppliers', 'products', 'opening-stock'])
})

test('an input nothing uses is refused: a wooSnapshot for a run without variant parents', () => {
  const m = manifest()
  const text = (a: unknown) => JSON.stringify(a)
  void text
  const loaded = loadPreparedRun({ manifest: { ...m, wooSnapshot: { snapshot: 's', provenance: 'p', variantParents: 'v', origin: 'https://shop.example', visibilityChecked: { products: { publish: 1, draft: 0, private: 0, pending: 0 }, variations: { publish: 1, draft: 0, private: 0, pending: 0 } } } }, files: honest, woo: null })
  assert.ok(!loaded.ok && loaded.problems.some((p) => /names a wooSnapshot but the prepared run used no variant parents/.test(p)))
})

// ---------------------------------------------------------------------------------------------------------------------------------
// A purchase order must be whole inside ONE file
// ---------------------------------------------------------------------------------------------------------------------------------

function splitOrders(files: FileMap, firstFile: string[], secondFile: string[]): FileMap {
  const lines = new TextDecoder().decode(files.get(ORDERS)!).split('\r\n').filter((l) => l !== '')
  const header = lines[0]
  const body = lines.slice(1)
  const copy: FileMap = new Map([...files].filter(([n]) => n !== ORDERS))
  const mk = (name: string, keep: string[]) => {
    const text = `${[header, ...body.filter((l) => keep.some((k) => l.includes(k)))].join('\r\n')}\r\n`
    const bytes = new TextEncoder().encode(text)
    copy.set(name, bytes)
    return { name, bytes, rows: body.filter((l) => keep.some((k) => l.includes(k))).length }
  }
  const one = mk('05-purchase-orders-001-of-002.csv', firstFile)
  const two = mk('05-purchase-orders-002-of-002.csv', secondFile)
  return withReport(copy, (r) => {
    r.outputs = r.outputs.filter((o) => o.name !== ORDERS)
    ;[one, two].forEach((f, i) => r.outputs.push({ name: f.name, target: 'purchase-orders', chunk: i + 1, chunks: 2, rows: f.rows, bytes: f.bytes.length, sha256: sha256Hex(f.bytes) }))
    r.plannedOutputRows['purchase-orders'] = one.rows + two.rows
  })
}

test('chunks: an order whole inside one file loads; an order whose lines span two files is refused (the importer would lose the later lines)', (t) => {
  const whole = splitOrders(honest, ['QBX-ZQSENT-PO-5001'], ['QBX-ZQSENT-PO-5002'])
  const control = load(whole)
  assert.ok(control.ok, control.ok ? '' : control.problems.join('; '))
  precondition(t, 'purchase-order chunks in the control', control.ok ? control.run.steps.find((s) => s.step === 'purchase-orders')!.files.length : 0)
  const split = splitOrders(honest, ['QBX-ZQSENT-PO-5001', 'ZQSENT-TSHIRT-M'], ['ZQSENT-TSHIRT-S'])
  expectProblem(split, /the rows of this order are in 2 different files/)
})

test('an order with more lines than one importer call may hold is refused at load, before any call, with a count and no key; one at the bound loads', (t) => {
  // Mutation named: drop the check in prepared.ts -> the oversized order loads and this arm is red.
  const text = new TextDecoder().decode(honest.get(ORDERS)!)
  const [header, ...lines] = text.split('\r\n').filter((l) => l !== '')
  const first = lines[0]!
  const orderLines = (n: number) => (body: string) => {
    const rows = body.split('\r\n').filter((l) => l !== '')
    return [rows[0]!, ...Array.from({ length: n }, () => first), ...rows.slice(1).filter((l) => !l.startsWith(first.split(',')[0]!))].join('\r\n') + '\r\n'
  }
  const atBound = problemsOf(withConsistentFile(honest, ORDERS, orderLines(500)))
  assert.ok(!atBound.some((p) => /more than 500 lines/.test(p)), `at the bound: ${JSON.stringify(atBound)}`)
  const over = problemsOf(withConsistentFile(honest, ORDERS, orderLines(501)))
  precondition(t, 'problems', over.length)
  const message = over.find((p) => /order\(s\) have more than 500 lines/.test(p))
  assert.ok(message, JSON.stringify(over))
  assert.match(message!, /^purchase-orders: 1 order\(s\) have more than 500 lines/)
  assert.ok(!message!.includes(first.split(',')[0]!), 'no order key in the sentence')
})
