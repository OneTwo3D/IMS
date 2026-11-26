import assert from 'node:assert/strict'
import test from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import { calculatePurchaseInvoice, type PurchaseInvoicePoLine } from '@/lib/domain/purchasing/purchase-invoice-edit'
import { matchBillsToReceipts, stockUnitsForeign } from '@/lib/domain/purchasing/purchase-bill-fx'

/** Per-event FX step 3, the pure parts: the PPV split of a bill line, and the per-receipt matching that values the FX difference. */

const D = (v: string | number) => new Prisma.Decimal(v)
const poLineById = new Map<string, PurchaseInvoicePoLine>([['p', { id: 'p', qty: 10, qtyReceived: 10, product: { sku: 'SKU-1' }, taxRate: { id: 'std', accountingTaxType: 'INPUT2', rate: '0.2' } }]])
const bill = (unit: number, split?: number) => calculatePurchaseInvoice({
  lines: [{ kind: 'product', poLineId: 'p', qtyBilled: 10, unitCostForeign: unit }], fxRateToBase: 1.6, currency: 'EUR', poReference: 'PO-1', transitAccount: '631',
  poTaxRatePercent: 0.2, poLineById, costLineById: new Map(),
  ...(split === undefined ? {} : { ppvSplit: { stockUnitForeignByPoLine: new Map([['p', split]]), ppvAccount: '5050' } }),
})

// [mutation: change the bill when no split is asked for]
test('without a split the bill is exactly as before (one line on transit, no PPV)', () => {
  const plain = bill(13.5)
  assert.equal(plain.accountingLines.length, 1)
  assert.equal(plain.accountingLines[0]!.unitAmount, 13.5)
  assert.equal(plain.ppvBase, 0)
  assert.equal(plain.transitBase, plain.subtotalBase)
  assert.equal(plain.lineData[0]!.stockUnitForeign, undefined)
})

// [mutation: code the variance to transit, or drop its tax treatment]
test('a dearer bill: the stock part at the PO cost on transit, the whole difference on a PPV line with the same tax, taxed per part', () => {
  const split = bill(13.5, 12.5)
  assert.equal(split.accountingLines.length, 2)
  const [stock, ppv] = split.accountingLines
  assert.deepEqual([stock!.quantity, stock!.unitAmount, stock!.accountCode, stock!.taxType], [10, 12.5, '631', 'INPUT2'])
  assert.deepEqual([ppv!.quantity, ppv!.unitAmount, ppv!.accountCode, ppv!.taxType], [1, 10, '5050', 'INPUT2'])
  assert.equal(split.subtotalForeign, 135, 'the bill total is unchanged')
  assert.equal(split.taxForeign, 27, '25 + 2 VAT')
  assert.equal(split.ppvBase, 6.25, '10 / 1.6')
  assert.equal(split.transitBase, 78.125)
  assert.equal(split.lineData[0]!.stockUnitForeign, 12.5)
})

test('a cheaper bill puts a negative PPV line; a bill at the PO cost has none', () => {
  const cheap = bill(11.5, 12.5)
  assert.equal(cheap.accountingLines[1]!.unitAmount, -10)
  assert.equal(cheap.ppvBase, -6.25)
  const same = bill(12.5, 12.5)
  assert.equal(same.accountingLines.length, 1)
  assert.equal(same.ppvBase, 0)
})

test('the PO goods unit cost is read after the header discount, from the foreign totals', () => {
  const units = stockUnitsForeign({ subtotalForeign: 90, lines: [{ id: 'a', unitCostForeign: 12.5, totalForeign: 100 }] })
  assert.equal(units.get('a')!.toString(), '11.25')
})

// [mutation: value matched quantity at one rate, or let a later bill take an earlier bill's receipts]
test('matching: per receipt, in order; earlier (even unmanaged) bills take the earlier receipts; unreceived quantity carries no difference', () => {
  const lots = new Map([['p', [{ qty: D(4), valueBase: D(40) }, { qty: D(6), valueBase: D('46.875') }]]])
  const [only] = matchBillsToReceipts(lots, [{ invoiceId: 'b', managed: true, rateToBase: D('1.6'), lines: [{ poLineId: 'p', qty: D(10), stockForeign: D(125), ppvBase: D(0) }] }])
  assert.equal(only!.accruedBase.toString(), '86.875')
  assert.equal(only!.fxVarianceBase.toString(), '-8.75')
  const two = matchBillsToReceipts(lots, [
    { invoiceId: 'old', managed: false, rateToBase: null, lines: [{ poLineId: 'p', qty: D(4), stockForeign: D(50), ppvBase: D(0) }] },
    { invoiceId: 'new', managed: true, rateToBase: D('1.6'), lines: [{ poLineId: 'p', qty: D(8), stockForeign: D(100), ppvBase: D(0) }] },
  ])
  assert.equal(two.length, 1, 'only the managed bill gets a target')
  assert.equal(two[0]!.accruedBase.toString(), '62.5', '6 at the second receipt (46.875) plus 2 not received, at the bill (2 x 7.8125)')
  assert.equal(two[0]!.fxVarianceBase.toString(), '0', 'all matched at the lock rate')
})
