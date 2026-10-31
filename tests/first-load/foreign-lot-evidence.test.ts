/**
 * The foreign-currency lots behind opening stock are carried into the prepared report (stock.foreignLots: currency, received day, foreign cost, selected rate, derived base cost) so
 * the apply step can prove them against the live fx_rates before opening stock is written (the database half is in apply-db.test.ts). This file is the byte side: what prepare writes,
 * and what the loader refuses from the report alone. Every arm names the mutation that turns it red.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { ds, lot, precondition } from './helpers.ts'
import { loadOk, prepareSynthetic, preparedFiles, problemsOf, syntheticDatasets, withReport, type EditableReport } from './apply-helpers.ts'

const withForeignLots = () => {
  const datasets = syntheticDatasets()
    return {
    ...datasets,
    'stock-lots': ds('stock-lots', [
      lot('ZQSENT-OAK-BOARD', '60', '5.333333', { warehouseCode: 'ZQSENT-MAIN' }),
      lot('ZQSENT-OAK-BOARD', '10', '5', { warehouseCode: 'ZQSENT-MAIN', currency: 'EUR', receivedDate: '2026-09-12', lotRef: 'E1' }),
      lot('ZQSENT-OAK-BOARD', '5', '4.5', { warehouseCode: 'ZQSENT-OVER' }),
      lot('ZQSENT-LEG-01', '8', '12', { warehouseCode: 'ZQSENT-MAIN', currency: 'EUR', receivedDate: '2026-09-12', lotRef: 'E2' }),
      lot('ZQSENT-LEG-01', '2', '10', { warehouseCode: 'ZQSENT-MAIN', currency: 'EUR', receivedDate: '2026-09-12', lotRef: 'E3' }),
      lot('ZQSENT-TSHIRT-M', '3', '0', { warehouseCode: 'ZQSENT-MAIN' }),
    ]),
  }
}
const files = preparedFiles(prepareSynthetic(withForeignLots()))
type Evidence = { sku: string; warehouseCode: string; lotRef: string; currency: string; receivedDate: string; qty: string; unitCostForeign: string; fxRateToBase: string; unitCostBase: string }
const evidenceOf = (report: EditableReport) => (report as unknown as { stock: { foreignLots: Evidence[] } }).stock.foreignLots
const edited = (edit: (lots: Evidence[], report: EditableReport) => void) => withReport(files, (r) => edit(evidenceOf(r), r))
const expectRefused = (f: typeof files, pattern: RegExp) => {
  const problems = problemsOf(f)
  assert.ok(problems.some((p) => pattern.test(p)), `expected ${pattern}, got ${JSON.stringify(problems)}`)
}

// [mutation: do not collect the evidence per lot; collect it for base-currency lots too; drop the received day, the foreign cost or the rate from an entry]
test('prepare carries each foreign lot (and only foreign lots) with its currency, received day, foreign cost, selected rate and base cost', (t) => {
  const run = loadOk(files)
  const lots = (run.report.stock as unknown as { foreignLots: Evidence[] }).foreignLots
  precondition(t, 'foreign lots', lots.length)
  assert.equal(lots.length, 3, 'three EUR lots; the GBP lots are not evidence')
  const e2 = lots.find((l) => l.lotRef === 'E2')!
  assert.deepEqual({ ...e2 }, { sku: 'ZQSENT-LEG-01', warehouseCode: 'ZQSENT-MAIN', lotRef: 'E2', currency: 'EUR', receivedDate: '2026-09-12', qty: '8', unitCostForeign: '12', fxRateToBase: '1.25', unitCostBase: '9.6' })
  assert.ok(lots.every((l) => l.currency === 'EUR' && l.fxRateToBase === '1.25'))
})

test('a run with no foreign lots carries an empty list and loads', () => {
  const plain = preparedFiles(prepareSynthetic())
  assert.deepEqual(evidenceOf(JSON.parse(new TextDecoder().decode(plain.get('validation-report.json')!)) as EditableReport), [])
  assert.deepEqual(problemsOf(plain), [])
})

// [mutation: treat a missing list as "no foreign lots"]
test('a report with no foreignLots list is refused, never read as "no foreign lots"', () => {
  expectRefused(withReport(files, (r) => { delete (r as unknown as { stock: Record<string, unknown> }).stock.foreignLots }), /no stock\.foreignLots list/)
})

test('control: the unmodified report with foreign lots loads', () => {
  assert.deepEqual(problemsOf(files), [])
})

// [mutation: drop the cost-over-rate comparison]
test('an entry whose base cost is not its foreign cost over its rate is refused (a hand-edited rate or cost)', () => {
  expectRefused(edited((l) => { l[0]!.fxRateToBase = '1.26' }), /base cost is not the foreign cost divided by the stated rate/)
  expectRefused(edited((l) => { l[0]!.unitCostBase = '9.61' }), /base cost is not the foreign cost divided by the stated rate/)
})

// [mutation: skip the shape checks; accept a lower-case or 4-letter currency, an impossible day, a zero rate or quantity, or a non-number]
test('malformed entries are refused without quoting them', (t) => {
  const arms: Array<[string, (l: Evidence[]) => void, RegExp]> = [
    ['currency', (l) => { l[0]!.currency = 'eur' }, /missing or malformed/],
    ['day', (l) => { l[0]!.receivedDate = '2026-02-31' }, /missing or malformed/],
    ['sku missing', (l) => { delete (l[0] as Partial<Evidence>).sku }, /missing or malformed/],
    ['rate not a number', (l) => { l[0]!.fxRateToBase = 'abc' }, /not a number/],
    ['rate zero', (l) => { l[0]!.fxRateToBase = '0' }, /not positive/],
    ['quantity zero', (l) => { l[0]!.qty = '0' }, /not positive/],
    ['negative cost', (l) => { l[0]!.unitCostForeign = '-1' }, /not positive, or a cost is negative/],
  ]
  precondition(t, 'arms', arms.length)
  for (const [, edit, pattern] of arms) expectRefused(edited((l) => edit(l)), pattern)
})

// [mutation: skip the group binding; compare only the quantity; allow the evidence of a group the file has no row for]
test('evidence that does not belong to the run is refused: an unknown group, more than the group holds, or a foreign-only group whose total differs', () => {
  expectRefused(edited((l) => { l[0]!.sku = 'ZQSENT-NOT-HERE' }), /belongs to no stock group/)
  expectRefused(edited((l) => { l[0]!.warehouseCode = 'ZQSENT-OVER' }), /belongs to no stock group/)
  expectRefused(edited((l) => { l[0]!.qty = '1000' }), /exceed the group's own lot quantity or value/)
  // ZQSENT-LEG-01@MAIN is priced ONLY from foreign lots: their total is the group's lot total, exactly
  expectRefused(edited((l) => { const e = l.find((x) => x.lotRef === 'E3')!; e.unitCostForeign = '9.5'; e.unitCostBase = '7.6' }), /not the sum of those lots' costs/)
})
