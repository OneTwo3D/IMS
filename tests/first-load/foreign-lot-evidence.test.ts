/**
 * Every lot behind opening stock is carried into the prepared report (stock.lots: currency, received day, foreign cost, selected rate, derived base cost) so
 * the apply step can prove them against the live fx_rates before opening stock is written (the database half is in apply-db.test.ts). This file is the byte side: what prepare writes,
 * and what the loader refuses: the list must REPRODUCE the hashed opening-stock rows, so an emptied list, a removed, added or altered lot all refuse. Every arm names the mutation that turns it red.
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
const evidenceOf = (report: EditableReport) => (report as unknown as { stock: { lots: Evidence[] } }).stock.lots
const edited = (edit: (lots: Evidence[], report: EditableReport) => void) => withReport(files, (r) => edit(evidenceOf(r), r))
const expectRefused = (f: typeof files, pattern: RegExp) => {
  const problems = problemsOf(f)
  assert.ok(problems.some((p) => pattern.test(p)), `expected ${pattern}, got ${JSON.stringify(problems)}`)
}

// [mutation: do not collect the evidence per lot; drop the received day, the foreign cost or the rate from an entry; collect only foreign lots]
test('prepare carries every lot (base ones too) with its currency, received day, foreign cost, selected rate and base cost', (t) => {
  const lots = evidenceOf(loadOk(files).report as unknown as EditableReport)
  precondition(t, 'lots', lots.length)
  assert.equal(lots.length, 6, 'all six lots: three EUR and three GBP')
  assert.equal(lots.filter((l) => l.currency === 'EUR').length, 3)
  const e2 = lots.find((l) => l.lotRef === 'E2')!
  assert.deepEqual({ ...e2 }, { sku: 'ZQSENT-LEG-01', warehouseCode: 'ZQSENT-MAIN', lotRef: 'E2', currency: 'EUR', receivedDate: '2026-09-12', qty: '8', unitCostForeign: '12', fxRateToBase: '1.25', unitCostBase: '9.6' })
  assert.ok(lots.filter((l) => l.currency === 'GBP').every((l) => l.fxRateToBase === '1' && l.unitCostBase === l.unitCostForeign))
})

test('control: the unmodified report loads, with and without foreign lots', () => {
  assert.deepEqual(problemsOf(files), [])
  assert.deepEqual(problemsOf(preparedFiles(prepareSynthetic())), [])
})

// [mutation: treat a missing list as "no lots"]
test('a report with no lots list is refused, never read as "no lots"', () => {
  expectRefused(withReport(files, (r) => { delete (r as unknown as { stock: Record<string, unknown> }).stock.lots }), /no stock\.lots list/)
})

// The coverage arms: the CSV and its hash are unchanged, only the report's list is edited.
// [mutation: skip the per-row reproduction check; trust a present list without comparing it with the file; compare only the quantity]
test('an EMPTIED list is refused: no row is reproduced', () => {
  expectRefused(edited((l) => { l.length = 0 }), /no lot evidence in the prepared report reproduces this row/)
})

test('a list with ONE LOT REMOVED is refused (the row is no longer reproduced)', () => {
  expectRefused(edited((l) => { l.splice(l.findIndex((x) => x.lotRef === 'E1'), 1) }), /do not reproduce this row's quantity and weighted-average cost/)
  expectRefused(edited((l) => { l.splice(l.findIndex((x) => x.lotRef === 'E3'), 1) }), /do not reproduce this row's quantity and weighted-average cost/)
})

test('a list with an EXTRA FAKE LOT is refused', () => {
  expectRefused(edited((l) => { l.push({ ...l.find((x) => x.lotRef === 'E1')!, lotRef: 'FAKE' }) }), /do not reproduce this row's quantity and weighted-average cost/)
  expectRefused(edited((l) => { l.push({ ...l[0]!, sku: 'ZQSENT-NOT-HERE' }) }), /names lots for a SKU and warehouse that has no row/)
})

// [mutation: skip the cost comparison; compare only the quantity]
test('a lot whose cost is edited consistently (cost and rate) but no longer reproduces the row is refused', () => {
  expectRefused(edited((l) => { const e = l.find((x) => x.lotRef === 'E1')!; e.unitCostForeign = '6'; e.unitCostBase = '4.8' }), /do not reproduce this row/)
})

// A lot of a single-lot row whose quantity changes while its cost (so the average) does not: only the quantity reproduction can see it. [mutation: ignore the quantity; accept any surplus file quantity as in-transit]
test('a lot whose quantity differs from the file row (same cost) is refused, whether it is larger or smaller than the row', () => {
  const single = (l: Evidence[]) => l.find((x) => x.sku === 'ZQSENT-OAK-BOARD' && x.warehouseCode === 'ZQSENT-OVER')!
  expectRefused(edited((l) => { single(l).qty = '6' }), /do not reproduce this row's quantity/)
  expectRefused(edited((l) => { single(l).qty = '4' }), /do not reproduce this row's quantity/)
})

// [mutation: drop the cost-over-rate comparison]
test('an entry whose base cost is not its foreign cost over its rate is refused (a hand-edited rate or cost)', () => {
  expectRefused(edited((l) => { l[0]!.fxRateToBase = '1.26' }), /base cost is not the foreign cost divided by the stated rate|states a rate other than 1/)
  expectRefused(edited((l) => { l.find((x) => x.lotRef === 'E2')!.unitCostBase = '9.61' }), /base cost is not the foreign cost divided by the stated rate/)
})

// [mutation: accept a base-currency lot with a rate other than 1]
test('a base-currency lot with a rate other than 1 is refused', () => {
  expectRefused(edited((l) => { const g = l.find((x) => x.currency === 'GBP')!; g.fxRateToBase = '2'; g.unitCostBase = String(Number(g.unitCostForeign) / 2) }), /rate other than 1/)
})

// [mutation: skip the shape checks; accept a lower-case or 4-letter currency, an impossible day, a zero rate or quantity, or a non-number]
test('malformed entries are refused without quoting them', (t) => {
  const firstEur = (l: Evidence[]) => l.find((x) => x.currency === 'EUR')!
  const arms: Array<[string, (l: Evidence[]) => void, RegExp]> = [
    ['currency', (l) => { firstEur(l).currency = 'eur' }, /missing or malformed/],
    ['day', (l) => { firstEur(l).receivedDate = '2026-02-31' }, /received day is missing or malformed/],
    ['sku missing', (l) => { delete (firstEur(l) as Partial<Evidence>).sku }, /missing or malformed/],
    ['rate not a number', (l) => { firstEur(l).fxRateToBase = 'abc' }, /not a number/],
    ['rate zero', (l) => { firstEur(l).fxRateToBase = '0' }, /not positive/],
    ['quantity zero', (l) => { firstEur(l).qty = '0' }, /not positive/],
    ['negative cost', (l) => { firstEur(l).unitCostForeign = '-1' }, /not positive, or a cost is negative/],
  ]
  precondition(t, 'arms', arms.length)
  for (const [, edit, pattern] of arms) expectRefused(edited((l) => edit(l)), pattern)
})
