import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { inactiveBillRatesMessage, inactiveOrderRateMessage, inactiveOrderRateName, type OrderRateCandidate } from '@/lib/domain/purchasing/order-rate-tax-code'
import {
  billLineTaxTreatments,
  bookedTaxFromLine,
  calculatePurchaseInvoice,
  legacyTreatmentsReproduceBillTax,
  PurchaseBillTaxRefusal,
  snapshotColumnsFor,
  type PurchaseInvoiceCostLine,
  type PurchaseInvoicePoLine,
} from '@/lib/domain/purchasing/purchase-invoice-edit'
import { resolveSupplierCreditNoteTaxType } from '@/lib/domain/purchasing/supplier-credit-note'

/**
 * A BILL LINE KEEPS THE TAX TREATMENT IT WAS BOOKED WITH. The purchase order's rate can change after booking (updateTaxRate), and an edit or a supplier credit must not
 * re-price the bill at the new rate.
 */

// The order line was booked at 20% (INPUT2). Its rate has SINCE been changed to 5% (INPUT5).
const poLinesNow = new Map<string, PurchaseInvoicePoLine>([['p', { id: 'p', qty: 10, product: { sku: 'A' }, taxRate: { id: 'r-new', accountingTaxType: 'INPUT5', rate: '0.05' } }]])
const booked = { taxType: 'INPUT2', rate: '0.2', taxRateId: 'r-old', reverseCharge: false }
const calc = (lines: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) => calculatePurchaseInvoice({
  lines: lines as never, fxRateToBase: 1, poReference: 'PO-1', transitAccount: '631', poTaxRatePercent: 0.05, poLineById: poLinesNow, costLineById: new Map(), ...over,
})

test('an edit keeps the BOOKED code, rate and VAT after the order\'s rate changed; a new line (no snapshot) takes today\'s rate', () => {
  const edited = calc([{ kind: 'product', id: 'l1', poLineId: 'p', qtyBilled: 2, unitCostForeign: 50, booked }])
  assert.equal(edited.taxForeign, 20, 'VAT on 100 at the BOOKED 20%, not today\'s 5%')
  assert.deepEqual([edited.accountingLines[0].taxType, edited.accountingLines[0].taxRateId], ['INPUT2', 'r-old'])
  assert.deepEqual(edited.lineTaxRates[0], { description: 'PO PO-1 line', taxType: 'INPUT2', rate: 0.2, checkable: true, taxRateId: 'r-old', reverseCharge: false })
  const unbooked = calc([{ kind: 'product', poLineId: 'p', qtyBilled: 2, unitCostForeign: 50 }])
  assert.equal(unbooked.taxForeign, 5)
  assert.equal(unbooked.accountingLines[0].taxType, 'INPUT5')
})

test('a booked cost line keeps its code and rate; a booked reverse-charge line keeps its swapped code and flag', () => {
  const costs = new Map<string, PurchaseInvoiceCostLine>([['f', { id: 'f', description: 'Freight', amountForeign: 100, vatable: true }]])
  const edited = calc([{ kind: 'cost', id: 'c1', costLineId: 'f', amountForeign: 100, booked: { taxType: 'INPUT2', rate: 0.2, taxRateId: 'r-old', reverseCharge: false } }], { costLineById: costs, fallbackTaxType: 'INPUT5', fallbackTaxRateId: 'r-new' })
  assert.equal(edited.taxForeign, 20)
  assert.equal(edited.accountingLines[0].taxType, 'INPUT2')
  const rc = calc([{ kind: 'product', id: 'l1', poLineId: 'p', qtyBilled: 1, unitCostForeign: 100, booked: { taxType: 'REVERSECHARGES', rate: 0.2, taxRateId: 'r-rc', reverseCharge: true } }])
  assert.deepEqual([rc.lineTaxRates[0].reverseCharge, rc.lineTaxRates[0].checkable, rc.accountingLines[0].taxType], [true, false, 'REVERSECHARGES'])
})

test('the snapshot columns written for a line round-trip to the booked treatment', () => {
  const lineTaxRate = calc([{ kind: 'product', poLineId: 'p', qtyBilled: 1, unitCostForeign: 100 }]).lineTaxRates[0]
  const at = new Date('2026-11-12T10:00:00.000Z')
  const columns = snapshotColumnsFor(lineTaxRate, at)
  assert.deepEqual(columns, { taxType: 'INPUT5', taxRateValue: 0.05, taxRateId: 'r-new', taxReverseCharge: false, taxBookedAt: at })
  assert.deepEqual(bookedTaxFromLine(columns), { taxType: 'INPUT5', rate: '0.05', taxRateId: 'r-new', reverseCharge: false })
  assert.equal(bookedTaxFromLine({ taxBookedAt: null, taxType: 'X' }), null, 'no marker = a legacy line')
  // A booked line that could not be given a code stays "booked, no code" (never NONE).
  assert.deepEqual(bookedTaxFromLine({ taxBookedAt: at, taxType: null, taxRateValue: '0.2', taxRateId: null, taxReverseCharge: false }), { taxType: null, rate: '0.2', taxRateId: null, reverseCharge: false })
})

const costLinesNone = new Map<string, { vatable: boolean }>()
test('a supplier credit mirrors the BOOKED snapshot after the order\'s rate changed; a legacy line is reconstructed and only trusted when it reproduces the bill\'s VAT', () => {
  const snapshotLine = { poLineId: 'p', costLineId: null, totalForeign: 100, taxBookedAt: new Date(), taxType: 'INPUT2', taxRateValue: '0.2', taxRateId: 'r-old', taxReverseCharge: false }
  const [t] = billLineTaxTreatments({ billLines: [snapshotLine], poLineById: poLinesNow, costLineById: costLinesNone, poTaxRatePercent: 0.05 })
  assert.deepEqual([t.taxType, t.rate, t.legacy], ['INPUT2', 0.2, false])
  assert.deepEqual(resolveSupplierCreditNoteTaxType({ billHadTax: true, billLines: [t] }), { taxType: 'INPUT2', taxRateId: 'r-old' })

  // A legacy line (no marker): reconstructed at TODAY'S 5%, which does not reproduce the 20.00 the bill recorded -> refused by the caller.
  const legacyLine = { poLineId: 'p', costLineId: null, totalForeign: 100 }
  const legacy = billLineTaxTreatments({ billLines: [legacyLine], poLineById: poLinesNow, costLineById: costLinesNone, poTaxRatePercent: 0.05 })
  assert.equal(legacy[0].legacy, true)
  assert.equal(legacyTreatmentsReproduceBillTax({ treatments: legacy, billTaxForeign: 20, currency: 'GBP' }), false)
  // ...but when the order's rate has NOT changed since, the reconstruction reproduces the recorded VAT and is accepted.
  assert.equal(legacyTreatmentsReproduceBillTax({ treatments: legacy, billTaxForeign: 5, currency: 'GBP' }), true)
  assert.equal(legacyTreatmentsReproduceBillTax({ treatments: legacy, billTaxForeign: 5.01, currency: 'GBP' }), true, 'within a minor unit')
  assert.equal(legacyTreatmentsReproduceBillTax({ treatments: legacy, billTaxForeign: 5.5, currency: 'GBP' }), false)
})

const rate = (id: string, name: string, r: number, active: boolean, over: Partial<OrderRateCandidate> = {}): OrderRateCandidate =>
  ({ id, name, rate: r, accountingTaxType: 'INPUT5', active, usedFor: 'PURCHASE', isCompound: false, reverseCharge: false, ...over })

test('an INACTIVE order rate is named (and only when the percentage and recorded name match); the bill calculation refuses lines that would use it, not booked lines', () => {
  assert.equal(inactiveOrderRateName({ recordedRate: 0.05, recordedName: 'UK Reduced', candidates: [rate('a', 'UK Reduced', 0.05, false)] }), 'UK Reduced')
  assert.equal(inactiveOrderRateName({ recordedRate: 0.05, candidates: [rate('a', 'UK Reduced', 0.05, true)] }), null, 'active: nothing to name')
  assert.equal(inactiveOrderRateName({ recordedRate: 0.2, candidates: [rate('a', 'UK Reduced', 0.05, false)] }), null, 'another percentage')
  assert.equal(inactiveOrderRateName({ recordedRate: 0.05, recordedName: 'Other', candidates: [rate('a', 'UK Reduced', 0.05, false)] }), null, 'another name')
  assert.equal(inactiveOrderRateName({ recordedRate: 0.05, candidates: [rate('a', 'Sales only', 0.05, false, { usedFor: 'SALES' })] }), null)
  const problem = inactiveOrderRateMessage('UK Reduced')
  assert.match(problem, /"UK Reduced" this purchase order was charged at is inactive/)
  const costs = new Map<string, PurchaseInvoiceCostLine>([['f', { id: 'f', description: 'Freight', amountForeign: 100, vatable: true }]])
  assert.throws(() => calc([{ kind: 'cost', costLineId: 'f', amountForeign: 100 }], { costLineById: costs, orderRateProblem: problem }), (e: unknown) => e instanceof PurchaseBillTaxRefusal && e.message === problem)
  const noRateRow = new Map<string, PurchaseInvoicePoLine>([['n', { id: 'n', qty: 1, product: { sku: 'N' }, taxRate: null }]])
  assert.throws(() => calc([{ kind: 'product', poLineId: 'n', qtyBilled: 1, unitCostForeign: 10 }], { poLineById: noRateRow, orderRateProblem: problem }), PurchaseBillTaxRefusal)
  // A line with its own (active) rate does not use the order rate, a booked line keeps its snapshot, and a non-vatable cost line has no VAT to refuse.
  assert.doesNotThrow(() => calc([{ kind: 'product', poLineId: 'p', qtyBilled: 1, unitCostForeign: 10 }], { orderRateProblem: problem }))
  assert.doesNotThrow(() => calc([{ kind: 'cost', costLineId: 'f', amountForeign: 100, booked: { taxType: 'INPUT5', rate: 0.05, taxRateId: 'r', reverseCharge: false } }], { costLineById: costs, orderRateProblem: problem }))
  assert.doesNotThrow(() => calc([{ kind: 'cost', costLineId: 'x', amountForeign: 1 }], { costLineById: new Map([['x', { id: 'x', description: 'H', amountForeign: 1, vatable: false }]]), orderRateProblem: problem }))
  assert.match(inactiveBillRatesMessage(['A', 'B']), /inactive \("A", "B"\)/)
})

test('wiring: create and edit refuse inactive rates and store/keep the snapshot; the credit refuses an ambiguous legacy bill and inactive rates before claiming', () => {
  const source = readFileSync('app/actions/purchase-orders.ts', 'utf8')
  assert.equal((source.match(/await inactiveRatesRefusal\(/g) ?? []).length, 3, 'create, edit, credit')
  assert.equal((source.match(/snapshotColumnsFor\(invoiceCalculation/g) ?? []).length, 2, 'written at create and at edit')
  assert.equal((source.match(/booked: bookedTaxFromLine\(existingLine\)/g) ?? []).length, 2, 'an edit passes the booked treatment back for product and cost lines')
  assert.match(source, /if \(legacyTreatmentsAmbiguous\) return \{ success: false, error: LEGACY_BILL_TAX_AMBIGUOUS_MESSAGE \}/)
  assert.match(source, /where: \{ id: \{ in: ids \}, active: false, replacedById: null \}/, 'a rate a re-key retired is not "inactive"')
})
