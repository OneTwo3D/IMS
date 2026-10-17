/**
 * The fingerprint is a single table (FINGERPRINT_SPECS) that must account for EVERY column of every importer template, and a difference in any
 * fingerprinted column must be a conflict. Then: no problem text ever carries a prepared-file value (hostile cells, every kind of refusal).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { FINGERPRINT_SPECS, keyStep, type StepRows } from '../../lib/first-load/apply/keys.ts'
import { classifyStep, hasConflict, listConflicts, type ObservedEntry } from '../../lib/first-load/apply/residual.ts'
import { APPLY_STEP_IDS, STEP_TARGET } from '../../lib/first-load/apply/constants.ts'
import { IMPORT_TARGETS } from '../../lib/first-load/spec.ts'
import { SENTINEL, loadOk, load, prepareSynthetic, preparedFiles, withConsistentFile, loadedProblemCount, type FileMap } from './apply-helpers.ts'
import { precondition } from './helpers.ts'

const ORDER_TWO = 'QBX-ZQSENT-PO-5002'
const prepared = loadOk(preparedFiles(prepareSynthetic()))
const importerSource = readFileSync(path.join(process.cwd(), 'app/actions/import.ts'), 'utf8')

function importerBody(name: string): string {
  const start = importerSource.indexOf(`export async function ${name}(`)
  assert.ok(start >= 0, `${name} is in app/actions/import.ts`)
  const next = importerSource.indexOf('\nexport async function ', start + 10)
  return importerSource.slice(start, next < 0 ? undefined : next)
}
const IMPORTER: Partial<Record<(typeof APPLY_STEP_IDS)[number], string>> = { products: 'importProductsCsv', 'opening-stock': 'importOpeningStockCsv', 'purchase-orders': 'importPurchaseOrdersCsv' }
const readsColumn = (body: string, column: string) => new RegExp(`readCsvValue\\(\\s*row,\\s*'${column}'`).test(body)

test('every template column is in exactly one place of the fingerprint table, and every non-persisted one has a reason', (t) => {
  let columns = 0
  for (const step of APPLY_STEP_IDS) {
    const spec = FINGERPRINT_SPECS[step]
    const headers = IMPORT_TARGETS[STEP_TARGET[step]].headers
    const places = [...spec.key, ...spec.fingerprinted, ...(spec.lineLevel ?? []), ...Object.keys(spec.comparedSeparately), ...Object.keys(spec.notPersisted)]
    assert.deepEqual([...places].sort(), [...headers].sort(), `${step}: the table covers exactly the template columns, each once`)
    for (const [column, reason] of [...Object.entries(spec.notPersisted), ...Object.entries(spec.comparedSeparately)]) assert.ok(reason.length > 10, `${step}.${column} has a reason`)
    columns += headers.length
  }
  precondition(t, 'template columns accounted for', columns)
})

test('the table agrees with what each importer actually reads: persisted columns are read, non-persisted ones are not', (t) => {
  let examined = 0
  for (const [step, fn] of Object.entries(IMPORTER)) {
    const spec = FINGERPRINT_SPECS[step as (typeof APPLY_STEP_IDS)[number]]
    const body = importerBody(fn!)
    for (const column of [...spec.key, ...spec.fingerprinted, ...(spec.lineLevel ?? []), ...Object.keys(spec.comparedSeparately)]) {
      if (step === 'products' && column === 'components') continue // read through the recipe cell parser, not readCsvValue
      assert.ok(readsColumn(body, column) || (step === 'products' && ['sku', 'name', 'type', 'description', 'barcode', 'mpn', 'weight', 'widthCm', 'heightCm', 'depthCm', 'salesPriceBase', 'salePriceBase', 'salesPriceTaxInclusive', 'stockUnit', 'oversellAllowed', 'imageUrl', 'active', 'lifecycleStatus', 'parentSku'].includes(column) && body.includes(`'${column}'`)), `${step}: the importer reads ${column}`)
      examined++
    }
    for (const column of Object.keys(spec.notPersisted)) {
      if (step === 'products') continue // the two id columns ARE read (to be refused when set)
      assert.ok(!readsColumn(body, column), `${step}: the importer does not read ${column}`)
      examined++
    }
  }
  precondition(t, 'columns checked against the importer source', examined)
})

/**
 * A change to a cell that the importer would store DIFFERENTLY. A blunt "append x" is not always a difference: the importers read any text that
 * is not 1/true/yes/y as false, so "falsex" is false again (no difference), and an origin the importer cannot resolve is kept as written.
 */
const BOOLEAN_COLUMNS = new Set(['preferredSupplierLocked', 'salesPriceTaxInclusive', 'oversellAllowed', 'pricesIncludeVat'])
function meaningfulChange(column: string, c: string): string {
  if (BOOLEAN_COLUMNS.has(column)) return c.trim() === '' ? (column === 'oversellAllowed' ? 'false' : 'true') : /^(1|true|yes|y)$/i.test(c.trim()) ? 'false' : 'true'
  if (column === 'lifecycleStatus') return c === 'DRAFT' ? 'ARCHIVED' : 'DRAFT'
  if (column === 'active') return /^false$/i.test(c.trim()) ? 'TRUE' : 'FALSE'
  if (column === 'taxRateValue' || column === 'orderTaxRateValue') return c === '' ? '0.2' : String(Number(c) + 0.05)
  if (column === 'expectedDelivery') return c === '' ? '2027-01-01' : '2027-02-02'
  return c === '' ? '7' : /^-?\d+(\.\d+)?$/.test(c) ? String(Number(c) + 3) : `${c}x`
}

/** A difference in EACH fingerprinted column of one unit is a conflict against an otherwise identical database row. */
test('a difference in each fingerprinted column of each step is a conflict (and an identical row is not)', (t) => {
  let arms = 0
  for (const step of APPLY_STEP_IDS) {
    const ps = prepared.steps.find((s) => s.step === step)!
    const spec = FINGERPRINT_SPECS[step]
    const data: StepRows = ps.data
    const baseUnit = ps.units.find((u) => (step === 'products' ? u.key === 'ZQSENT-TABLE-01' : step === 'purchase-orders' ? u.key === ORDER_TWO : true))!
    const asEntry = (u: typeof baseUnit): ObservedEntry => ({ key: u.key, collisionKey: u.collisionKey, fingerprint: u.fingerprint, recipe: u.recipe })
    const clean = classifyStep(step, [baseUnit], { entries: [asEntry(baseUnit)] })
    assert.equal(hasConflict(clean), false, `${step}: control, an identical row is not a conflict`)
    const columns = [...spec.fingerprinted, ...(spec.lineLevel ?? [])]
    for (const column of columns) {
      const index = data.header.indexOf(column)
      assert.ok(index >= 0, `${step}.${column} is a template column`)
      const rows = data.rows.map((row, i) => (baseUnit.rowIndexes.includes(i) ? { ...row, cells: row.cells.map((c, ci) => (ci === index ? meaningfulChange(column, c) : c)) } : row))
      const changed = keyStep(step, { header: data.header, rows })
      const unit = changed.units.find((u) => u.key === baseUnit.key)
      assert.ok(unit, `${step}.${column}: the changed row still keys the same`)
      const result = classifyStep(step, [unit], { entries: [asEntry(baseUnit)] })
      assert.ok(hasConflict(result), `${step}.${column}: a difference is a conflict`)
      assert.equal(listConflicts(result)[0].code, 'FIELDS_DIFFER')
      arms++
    }
    if (step === 'products') {
      const recipeChanged = classifyStep(step, [baseUnit], { entries: [{ ...asEntry(baseUnit), recipe: 'X:1.0000' }] })
      assert.equal(listConflicts(recipeChanged)[0].code, 'RECIPE_DIFFERS')
      arms++
    }
  }
  precondition(t, 'column arms', arms)
})

test('purchase-order lines: a difference in any per-line column, a missing line and an extra line are each a conflict', () => {
  const ps = prepared.steps.find((s) => s.step === 'purchase-orders')!
  const unit = ps.units.find((u) => u.key === ORDER_TWO)!
  const entry: ObservedEntry = { key: unit.key, collisionKey: unit.collisionKey, fingerprint: unit.fingerprint, recipe: null }
  const fp = JSON.parse(unit.fingerprint) as { lines: string[] }
  for (const lines of [fp.lines.slice(1), [...fp.lines, 'ZQSENT-EXTRA|1.0000|1.000000||||'], [fp.lines[0].replace('|', '|9'), fp.lines[1]]]) {
    const changed = { ...entry, fingerprint: JSON.stringify({ ...fp, lines }) }
    assert.ok(hasConflict(classifyStep('purchase-orders', [unit], { entries: [changed] })))
  }
})

// ---------------------------------------------------------------------------------------------------------------------------------
// No prepared-file value in any problem text
// ---------------------------------------------------------------------------------------------------------------------------------

test('no problem returned by loadPreparedRun echoes a prepared-file value, whatever is wrong with the cell', (t) => {
  const SECRET = 'ZQSENT-HOSTILE-CELL'
  const PRODUCTS = '02-products-001-of-001.csv'
  const STOCK = '03-opening-stock-001-of-001.csv'
  const ORDERS = '05-purchase-orders-001-of-001.csv'
  const SUPPLIERS = '01-suppliers-001-of-001.csv'
  const honest = preparedFiles(prepareSynthetic())
  const arms: Array<[string, FileMap]> = [
    ['component without a quantity', withConsistentFile(honest, PRODUCTS, (s) => s.replace('ZQSENT-OAK-BOARD:0.5', SECRET))],
    ['component quantity not a number', withConsistentFile(honest, PRODUCTS, (s) => s.replace('ZQSENT-OAK-BOARD:0.5', `ZQSENT-OAK-BOARD:${SECRET}`))],
    ['component quantity zero', withConsistentFile(honest, PRODUCTS, (s) => s.replace('ZQSENT-OAK-BOARD:0.5', `${SECRET}:0`))],
    ['component twice', withConsistentFile(honest, PRODUCTS, (s) => s.replace('ZQSENT-OAK-BOARD:0.5', `${SECRET}:1;${SECRET.toLowerCase()}:1`))],
    ['component not in the catalogue', withConsistentFile(honest, PRODUCTS, (s) => s.replace('ZQSENT-OAK-BOARD:0.5', `${SECRET}:1`))],
    ['variant parent unknown', withConsistentFile(honest, PRODUCTS, (s) => s.replace('VARIANT,ZQSENT-TSHIRT,', `VARIANT,${SECRET},`))],
    ['sku with surrounding spaces', withConsistentFile(honest, PRODUCTS, (s) => s.replace(',,ZQSENT-OAK-BOARD,', `,, ${SECRET} ,`))],
    ['stock quantity not a number', withConsistentFile(honest, STOCK, (s) => s.replace(',8,12.000000', `,${SECRET},12.000000`))],
    ['stock cost not a number', withConsistentFile(honest, STOCK, (s) => s.replace(',8,12.000000', `,8,${SECRET}`))],
    ['stock on an unknown SKU', withConsistentFile(honest, STOCK, (s) => s.replace('ZQSENT-LEG-01,', `${SECRET},`))],
    ['stock in an unknown warehouse', withConsistentFile(honest, STOCK, (s) => s.replace('ZQSENT-LEG-01,ZQSENT-MAIN', `ZQSENT-LEG-01,${SECRET}`))],
    ['order supplier unknown', withConsistentFile(honest, ORDERS, (s) => s.replace('QBX-ZQSENT-PO-5001,ZQSENT Timber Co', `QBX-ZQSENT-PO-5001,${SECRET}`))],
    ['order line quantity not a number', withConsistentFile(honest, ORDERS, (s) => s.replace(',60,4.25', `,${SECRET},4.25`))],
    ['order fx not a number', withConsistentFile(honest, ORDERS, (s) => s.replace(',1.25,', `,${SECRET},`))],
    ['order lines disagree', withConsistentFile(honest, ORDERS, (s) => s.replace('ZQSENT-TSHIRT-S,30,2.1,', `ZQSENT-TSHIRT-S,30,2.1,,,,,,,,,${SECRET}`).replace(/ZQSENT-TSHIRT-M,20,2\.1,(,*)/, 'ZQSENT-TSHIRT-M,20,2.1,$1'))],
    ['order key with spaces', withConsistentFile(honest, ORDERS, (s) => s.replace('QBX-ZQSENT-PO-5001', ` ${SECRET} `))],
    ['supplier name with spaces', withConsistentFile(honest, SUPPLIERS, (s) => s.replace(',ZQSENT Timber Co,', `, ${SECRET} ,`))],
    ['supplier id set', withConsistentFile(honest, SUPPLIERS, (s) => s.replace('\r\n,ZQSENT Timber Co', `\r\n${SECRET},ZQSENT Timber Co`))],
    ['product id set', withConsistentFile(honest, PRODUCTS, (s) => s.replace('\r\n,,ZQSENT-OAK-BOARD', `\r\n${SECRET},,ZQSENT-OAK-BOARD`))],
  ]
  const before = loadedProblemCount
  let refused = 0
  for (const [label, files] of arms) {
    const loaded = load(files) // `load` throws if any problem matches the sentinel
    assert.equal(loaded.ok, false, `${label}: is refused`)
    if (!loaded.ok) {
      assert.ok(!loaded.problems.some((p) => SENTINEL.test(p) || p.includes(SECRET)), label)
      refused++
    }
  }
  precondition(t, 'hostile arms refused', refused)
  precondition(t, 'problem strings examined', loadedProblemCount - before)
  assert.equal(refused, arms.length)
  // The rule can fail: the sentinel pattern matches a problem that does echo a value.
  assert.ok(SENTINEL.test('products chunk 1 line 3: component "ZQSENT-X" is not SKU:quantity'))
})
