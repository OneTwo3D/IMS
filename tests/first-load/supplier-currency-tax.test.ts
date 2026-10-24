/**
 * Two owner rulings on the first-load supplier import.
 *
 *   1. A BLANK supplier currency is refused (MISSING_CURRENCY). The supplier importer would default it silently (Supplier.currency @default("GBP"); the base currency on create).
 *      A base-currency supplier states GBP.
 *   2. The supplier's DEFAULT TAX RATE is its Qoblex "Purchase Tax Class Name", mapped through a PINNED value map to a Xero tax type (INPUT2, ZERORATEDINPUT, NONE) and resolved
 *      to EXACTLY ONE active, purchase-capable IMS tax rate that carries that accounting tax type. Unmapped, blank, no rate, several rates: each rejects with its own code.
 *
 * Every arm names the one change to the subject that makes it red ("Mutation:"); the change was made, the arm went red and the change was reverted. Each arm prints how many
 * cases it examined and fails when it examined none (the vacuous-pass guard).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { QOBLEX_PURCHASE_TAX_CLASS_TYPES, SUPPLIER_PURCHASE_TAX_TYPES } from '../../lib/first-load/spec.ts'
import { parseColumnMap } from '../../lib/first-load/ingest.ts'
import { dispositionCodes, ds, findingCodes, loadFixtureDatasets, precondition, rowsOf, run } from './helpers.ts'

const NATIVE = path.join(process.cwd(), 'tests', 'first-load', 'fixtures', 'qoblex-native')
const rejected = (result: ReturnType<typeof run>) => dispositionCodes(result, 'suppliers', 'REJECTED')

const supplierWith = (extra: Record<string, string>, rates?: Array<Record<string, string>>) =>
  run({ suppliers: ds('suppliers', [{ name: 'Acme', ...extra }]), ...(rates ? { 'ims-tax-rates': ds('ims-tax-rates', rates) } : {}) })

const RATES = [
  { name: 'Std', accountingTaxType: 'INPUT2', usedFor: 'PURCHASE', active: 'TRUE' },
  { name: 'Zero', accountingTaxType: 'ZERORATEDINPUT', usedFor: 'PURCHASE', active: 'TRUE' },
  { name: 'None', accountingTaxType: 'NONE', usedFor: 'BOTH', active: 'TRUE' },
]

// ---------------------------------------------------------------------------------------------------------------------
// Ruling 1: currency
// ---------------------------------------------------------------------------------------------------------------------

test('currency: a blank is rejected MISSING_CURRENCY, an explicit GBP is accepted [mutation: restore `if (v.currency !== \'\')` in loadSuppliers, which omits a blank]', (t) => {
  for (const blank of ['', '   ']) {
    const r = supplierWith({ currency: blank })
    assert.deepEqual(rejected(r), ['MISSING_CURRENCY'], `blank ${JSON.stringify(blank)}`)
    assert.equal(rowsOf(r, 'suppliers').length, 0, 'a refused supplier is not in the import file')
  }
  const ok = supplierWith({ currency: 'gbp' })
  assert.deepEqual(rejected(ok), [])
  assert.deepEqual(rowsOf(ok, 'suppliers').map((row) => [row.name, row.currency]), [['Acme', 'GBP']], 'the currency is stated in the file, upper-cased')
  assert.deepEqual(rejected(supplierWith({ currency: 'GB' })), ['BAD_CURRENCY'], 'a malformed code keeps its own code')
  precondition(t, 'currency cases', 5)
})

// ---------------------------------------------------------------------------------------------------------------------
// Ruling 2: the pinned map
// ---------------------------------------------------------------------------------------------------------------------

test('the shipped Qoblex contacts map carries exactly the pinned class -> Xero type value map (and a blank that the transform refuses) [mutation: change one value in the map or in QOBLEX_PURCHASE_TAX_CLASS_TYPES]', (t) => {
  const text = readFileSync(path.join(NATIVE, 'maps', 'qoblex-contacts.map.json'), 'utf8')
  const mapping = parseColumnMap(text, 'qoblex-contacts.map.json').datasets.suppliers!
  assert.deepEqual(mapping.valueMaps.purchaseTaxType, { '': '', ...QOBLEX_PURCHASE_TAX_CLASS_TYPES })
  assert.equal(mapping.columns.purchaseTaxType, 'Purchase Tax Class Name')
  assert.deepEqual(QOBLEX_PURCHASE_TAX_CLASS_TYPES, { 'Purchase Tax': 'INPUT2', 'Zero Rated Purchase': 'ZERORATEDINPUT', 'No VAT': 'NONE' })
  for (const type of Object.values(QOBLEX_PURCHASE_TAX_CLASS_TYPES)) assert.ok((SUPPLIER_PURCHASE_TAX_TYPES as readonly string[]).includes(type), `${type} is in the closed list`)
  precondition(t, 'classes pinned', Object.keys(QOBLEX_PURCHASE_TAX_CLASS_TYPES).length)
})

/** The native Qoblex fixture with the three suppliers' tax class (and optionally currency) rewritten; the replacement must have happened. */
function nativeWith(classes: [string, string, string], ratesText?: string) {
  const swaps: Array<[string, string]> = [['"No VAT","USD"', `"${classes[0]}","USD"`], ['"No VAT","GBP"', `"${classes[1]}","GBP"`], ['"No VAT","EUR"', `"${classes[2]}","EUR"`]]
  const datasets = loadFixtureDatasets(NATIVE, (dataset, text) => {
    if (dataset === 'ims-tax-rates' && ratesText !== undefined) return ratesText
    if (dataset !== 'suppliers') return text
    let out = text
    for (const [from, to] of swaps) {
      assert.ok(out.includes(from), `precondition not reached: ${from} is not in the contacts fixture`)
      out = out.replace(from, to)
    }
    return out
  })
  // Only the supplier datasets: the rest of the native fixture is blocked on its own (variants without parents), which would empty every output.
  return run({ suppliers: datasets.suppliers, 'ims-tax-rates': datasets['ims-tax-rates'] })
}

test('each Qoblex class reaches the supplier file as its Xero tax type [mutation: swap two values of QOBLEX_PURCHASE_TAX_CLASS_TYPES and of the map]', (t) => {
  const r = nativeWith(['Purchase Tax', 'Zero Rated Purchase', 'No VAT'])
  const byName = Object.fromEntries(rowsOf(r, 'suppliers').map((row) => [row.name, row.purchaseTaxType]))
  assert.deepEqual(byName, { 'Supplier Alpha': 'INPUT2', 'Supplier Beta': 'ZERORATEDINPUT', 'Supplier Gamma': 'NONE' })
  assert.deepEqual(rejected(r), [])
  precondition(t, 'suppliers mapped', Object.keys(byName).length)
})

test('an unmapped class is rejected UNMAPPED_VALUE (the ingest\'s closed list), a blank class MISSING_PURCHASE_TAX_TYPE [mutation: drop `"": ""` from the map; add the unmapped class to the map]', (t) => {
  const unmapped = nativeWith(['Reverse Charge', 'No VAT', 'No VAT'])
  assert.deepEqual(dispositionCodes(unmapped, 'suppliers', 'REJECTED'), ['UNMAPPED_VALUE'])
  assert.equal(unmapped.blocking, true, 'a refused row blocks the run: nothing is written')
  const blank = nativeWith(['', 'No VAT', 'No VAT'])
  assert.deepEqual(dispositionCodes(blank, 'suppliers', 'REJECTED'), ['MISSING_PURCHASE_TAX_TYPE'])
  assert.equal(blank.blocking, true)
  precondition(t, 'cases', 2)
})

test('a canonical purchaseTaxType outside the closed Xero list is rejected UNSUPPORTED_PURCHASE_TAX_TYPE, a blank one MISSING_PURCHASE_TAX_TYPE [mutation: delete the closed-list check / the blank check]', (t) => {
  assert.deepEqual(rejected(supplierWith({ purchaseTaxType: 'INPUT' })), ['UNSUPPORTED_PURCHASE_TAX_TYPE'])
  assert.deepEqual(rejected(supplierWith({ purchaseTaxType: 'TAX001' })), ['UNSUPPORTED_PURCHASE_TAX_TYPE'], 'a per-organisation custom id is refused')
  assert.deepEqual(rejected(supplierWith({ purchaseTaxType: 'input2' })), ['UNSUPPORTED_PURCHASE_TAX_TYPE'], 'case-exact')
  assert.deepEqual(rejected(supplierWith({ purchaseTaxType: '' })), ['MISSING_PURCHASE_TAX_TYPE'])
  for (const type of SUPPLIER_PURCHASE_TAX_TYPES) assert.deepEqual(rejected(supplierWith({ purchaseTaxType: type })), [], type)
  precondition(t, 'cases', 4 + SUPPLIER_PURCHASE_TAX_TYPES.length)
})

// ---------------------------------------------------------------------------------------------------------------------
// Ruling 2: resolution to exactly one IMS rate
// ---------------------------------------------------------------------------------------------------------------------

test('resolution: each type finds its one rate; none, several, inactive-only and sales-only each reject with their code, and a decoy never counts [mutation: drop the active filter / the usedFor filter / the === 1 test / compare by name]', (t) => {
  const accepted = (rates: Array<Record<string, string>>, type = 'INPUT2') => rejected(supplierWith({ purchaseTaxType: type }, rates))
  // each class against the full set
  for (const type of SUPPLIER_PURCHASE_TAX_TYPES) assert.deepEqual(accepted(RATES, type), [], type)
  // zero matches
  assert.deepEqual(accepted(RATES.filter((r) => r.accountingTaxType !== 'INPUT2')), ['NO_IMS_PURCHASE_TAX_RATE'], 'zero matching rates')
  assert.deepEqual(accepted([{ name: 'Blank type', accountingTaxType: '', usedFor: 'PURCHASE', active: 'TRUE' }]), ['NO_IMS_PURCHASE_TAX_RATE'], 'a rate with no tax type is not a candidate, whatever its name')
  assert.deepEqual(accepted([{ name: 'INPUT2', accountingTaxType: 'OUTPUT2', usedFor: 'PURCHASE', active: 'TRUE' }]), ['NO_IMS_PURCHASE_TAX_RATE'], 'a rate NAMED like the type is not chosen: no guessing by name')
  // several matches
  assert.deepEqual(accepted([...RATES, { name: 'Std again', accountingTaxType: 'INPUT2', usedFor: 'PURCHASE', active: 'TRUE' }]), ['AMBIGUOUS_IMS_PURCHASE_TAX_RATE'], 'two purchase rates')
  assert.deepEqual(accepted([...RATES, { name: 'Std both', accountingTaxType: 'INPUT2', usedFor: 'BOTH', active: 'TRUE' }]), ['AMBIGUOUS_IMS_PURCHASE_TAX_RATE'], 'PURCHASE and BOTH both count')
  // an inactive or sales-only rate is not chosen: alone it is zero matches, beside a good one it does not make two
  assert.deepEqual(accepted([{ name: 'Old', accountingTaxType: 'INPUT2', usedFor: 'PURCHASE', active: 'FALSE' }]), ['NO_IMS_PURCHASE_TAX_RATE'], 'inactive only')
  assert.deepEqual(accepted([{ name: 'Sales', accountingTaxType: 'INPUT2', usedFor: 'SALES', active: 'TRUE' }]), ['NO_IMS_PURCHASE_TAX_RATE'], 'sales-only only')
  assert.deepEqual(accepted([...RATES, { name: 'Old', accountingTaxType: 'INPUT2', usedFor: 'PURCHASE', active: 'FALSE' }, { name: 'Sales', accountingTaxType: 'INPUT2', usedFor: 'SALES', active: 'TRUE' }]), [], 'decoys beside the one real rate')
  precondition(t, 'cases', 3 + 9)
})

test('ims-tax-rates rows that cannot be read are rejected, never assumed eligible; and without the list the resolution is reported NOT RUN with a warning [mutation: default a bad usedFor/active to eligible; drop the warning]', (t) => {
  const bad = run({ suppliers: ds('suppliers', [{ name: 'Acme', purchaseTaxType: 'INPUT2' }]), 'ims-tax-rates': ds('ims-tax-rates', [
    { name: 'A', accountingTaxType: 'INPUT2', usedFor: 'PURCHSE', active: 'TRUE' },
    { name: 'B', accountingTaxType: 'INPUT2', usedFor: 'PURCHASE', active: 'yes' },
    { name: '', accountingTaxType: 'INPUT2', usedFor: 'PURCHASE', active: 'TRUE' },
  ]) })
  assert.deepEqual(dispositionCodes(bad, 'ims-tax-rates', 'REJECTED').sort(), ['BAD_ACTIVE', 'BAD_USED_FOR', 'MISSING_NAME'])
  assert.deepEqual(rejected(bad), ['NO_IMS_PURCHASE_TAX_RATE'])
  const without = supplierWith({ purchaseTaxType: 'INPUT2' })
  assert.deepEqual(rejected(without), [])
  assert.ok(findingCodes(without, 'WARNING').includes('SUPPLIER_TAX_RATES_UNCHECKED'))
  assert.equal(without.report.checks.find((c) => c.check === 'supplier purchase tax type versus IMS tax rates')?.status, 'NOT RUN')
  const withList = supplierWith({ purchaseTaxType: 'INPUT2' }, RATES)
  assert.equal(findingCodes(withList).includes('SUPPLIER_TAX_RATES_UNCHECKED'), false)
  assert.equal(withList.report.checks.find((c) => c.check === 'supplier purchase tax type versus IMS tax rates')?.status, 'RAN')
  precondition(t, 'cases', 3 + 4)
})

test('the native fixture run with the shipped map and a complete ims-tax-rates list passes; with the Purchase Tax rate missing the Purchase Tax suppliers are refused NO_IMS_PURCHASE_TAX_RATE', (t) => {
  const ok = nativeWith(['Purchase Tax', 'Zero Rated Purchase', 'No VAT'])
  assert.deepEqual(rejected(ok), [])
  const ratesWithoutStd = 'name,accountingTaxType,usedFor,active\r\nSynthetic Zero Rated Purchase,ZERORATEDINPUT,PURCHASE,TRUE\r\nSynthetic No VAT,NONE,BOTH,TRUE\r\n'
  const missing = nativeWith(['Purchase Tax', 'Zero Rated Purchase', 'No VAT'], ratesWithoutStd)
  assert.deepEqual(rejected(missing), ['NO_IMS_PURCHASE_TAX_RATE'])
  precondition(t, 'runs', 2)
})
