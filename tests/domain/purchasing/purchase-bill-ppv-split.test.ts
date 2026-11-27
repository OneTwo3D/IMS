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

// [mutation: send the PPV line at 4dp and let the ledger tax each part (MED-4)]
test('MED-4: qty 2 x 1.0025 against a PO cost of 1.0000: the two parts total the supplier\'s line to the penny, tax included', () => {
  const result = calculatePurchaseInvoice({
    lines: [{ kind: 'product', poLineId: 'p', qtyBilled: 2, unitCostForeign: 1.0025 }], fxRateToBase: 1, currency: 'GBP', poReference: 'PO-1', transitAccount: '631',
    poTaxRatePercent: 0.2, poLineById, costLineById: new Map(), ppvSplit: { stockUnitForeignByPoLine: new Map([['p', 1]]), ppvAccount: '5050' },
  })
  const [stock, ppv] = result.accountingLines
  assert.deepEqual([stock!.lineAmount, stock!.taxAmount], [2, 0.4])
  assert.deepEqual([ppv!.unitAmount, ppv!.lineAmount, ppv!.taxAmount], [0.01, 0.01, 0], 'round2(2.005) - 2.00, and tax(line) - tax(stock)')
  assert.equal(stock!.lineAmount! + ppv!.lineAmount!, 2.01, 'the supplier\'s line amount')
  assert.equal(Math.round((stock!.taxAmount! + ppv!.taxAmount!) * 100) / 100, result.taxForeign, 'the bill\'s VAT')
  assert.equal(result.taxForeign, 0.4)
})

test('MED-4 on the wire: the Xero bill carries the split lines\' LineAmount and TaxAmount; a line without them carries neither', async () => {
  const { buildPurchaseBillPayload } = await import('@/lib/connectors/xero/bills')
  const payload = buildPurchaseBillPayload({
    invoiceNumber: 'B-1', contactName: 'S', date: '2026-11-22', currency: 'GBP',
    lines: [
      { description: 'Goods', quantity: 2, unitAmount: 1, accountCode: '631', taxType: 'INPUT2', lineAmount: 2, taxAmount: 0.4 },
      { description: 'PPV', quantity: 1, unitAmount: 0.01, accountCode: '5050', taxType: 'INPUT2', lineAmount: 0.01, taxAmount: 0 },
      { description: 'Plain', quantity: 1, unitAmount: 5, accountCode: '631', taxType: 'INPUT2' },
    ],
  } as never, 'AUTHORISED', 'c1', 'GBP') as { LineItems: Array<Record<string, unknown>> }
  assert.deepEqual([payload.LineItems[0]!.LineAmount, payload.LineItems[0]!.TaxAmount], [2, 0.4])
  assert.deepEqual([payload.LineItems[1]!.LineAmount, payload.LineItems[1]!.TaxAmount], [0.01, 0])
  assert.equal('LineAmount' in payload.LineItems[2]!, false)
  assert.equal('TaxAmount' in payload.LineItems[2]!, false)
})

// ─── Step 3b: returns and supplier credit notes (pure) ───────────────────────────────────────────────────────────────────────────────

// [mutation: take a return from the first receipt whatever its value, or drop the rounding residue]
test('a return takes back the receipt valued at its own unit value first, then in order; the lots keep receipts less returns exactly', async () => {
  const { receiptLotsAfterReturns } = await import('@/lib/domain/purchasing/purchase-bill-fx')
  const lots = receiptLotsAfterReturns([
    { poLineId: 'p', qty: D(4), valueBase: D(40) },
    { poLineId: 'p', qty: D(6), valueBase: D('46.875') },
    { poLineId: 'p', qty: D(-2), valueBase: D('-15.625') }, // two lock-rate units (7.8125)
  ]).get('p')!
  assert.deepEqual(lots.map((l) => [l.qty.toString(), l.valueBase.toString()]), [['4', '40'], ['4', '31.25']], 'taken from the lock-rate receipt')
  const fifo = receiptLotsAfterReturns([
    { poLineId: 'p', qty: D(4), valueBase: D(40) },
    { poLineId: 'p', qty: D(6), valueBase: D('46.875') },
    { poLineId: 'p', qty: D(-5), valueBase: D('-47') }, // no receipt at 9.4: in order, and the residue off the first lot left
  ]).get('p')!
  assert.equal(fifo.length, 1)
  assert.equal(fifo[0]!.qty.toString(), '5')
  assert.equal(fifo[0]!.valueBase.toString(), '39.875', '86.875 - 47')
  const beyond = receiptLotsAfterReturns([{ poLineId: 'p', qty: D(2), valueBase: D(20) }, { poLineId: 'p', qty: D(-3), valueBase: D(-30) }]).get('p')!
  assert.deepEqual(beyond, [], 'a return beyond the lots removes what there is')
})

// [mutation: split a credit by the whole bill instead of its goods lines, or split a bill that was not split]
test('a return credit reversing a split bill: the price-variance fraction of the bill\'s goods lines', async () => {
  const { creditPpvFractions } = await import('@/lib/domain/purchasing/purchase-bill-fx')
  const split = creditPpvFractions([
    { poLineId: 'p', qtyBilled: 10, totalForeign: '135', stockUnitForeign: '12.5' },
    { poLineId: null, qtyBilled: 1, totalForeign: '50', stockUnitForeign: null },
  ], 'EUR')
  assert.equal(split.overall.toString(), D(10).div(135).toString(), '10 of the 135 billed for goods is price variance; the freight line is not in it')
  assert.equal(split.byLine[1]!.toString(), '0')
  assert.equal(creditPpvFractions([{ poLineId: 'p', qtyBilled: 10, totalForeign: '135', stockUnitForeign: null }], 'EUR').overall.toString(), '0', 'an unsplit bill: nothing')
})

// [mutation: put the whole credit on transit, or let the two lines not add up to the credit]
test('the credit payload carries the stock part on transit and the price variance on the PPV account, adding up to the credit', async () => {
  const { buildSupplierCreditNoteSyncPayload } = await import('@/lib/domain/purchasing/supplier-credit-note')
  const base = {
    creditNoteId: 'cn1', creditNoteNumber: null, reference: 'PO-1', reason: 'Supplier return', supplierName: 'S', supplierId: 's', currency: 'EUR',
    fxRateToBase: 1.6, amountForeign: 27, transitAccount: '631', taxType: 'NONE', date: '2026-11-27',
  }
  const plain = buildSupplierCreditNoteSyncPayload(base) as { lines: Array<{ unitAmount: number; accountCode: string }> }
  assert.deepEqual(plain.lines.map((l) => [l.accountCode, l.unitAmount]), [['631', 27]], 'no split: one transit line, as before')
  const split = buildSupplierCreditNoteSyncPayload({ ...base, ppvSplit: { account: '5050', ppvAmount: 2 } }) as { lines: Array<{ unitAmount: number; accountCode: string; taxType: string }>; currencyRateToBase: number }
  assert.deepEqual(split.lines.map((l) => [l.accountCode, l.unitAmount]), [['631', 25], ['5050', 2]])
  assert.ok(split.lines.every((l) => l.taxType === 'NONE'), 'the same tax treatment on both parts')
  assert.equal(split.currencyRateToBase, 1.6)
})

// [mutation: drop the >4dp quantity guard on a split line]
test('a split bill line with a quantity finer than 4 decimal places is refused (the ledger keeps 4); an unsplit one is not', async () => {
  const { PurchaseBillTaxRefusal } = await import('@/lib/domain/purchasing/purchase-invoice-edit')
  const fine = (split?: number) => calculatePurchaseInvoice({
    lines: [{ kind: 'product', poLineId: 'p', qtyBilled: 1.23456, unitCostForeign: 12.5 }], fxRateToBase: 1.6, currency: 'EUR', poReference: 'PO-1', transitAccount: '631',
    poTaxRatePercent: 0.2, poLineById, costLineById: new Map(),
    ...(split === undefined ? {} : { ppvSplit: { stockUnitForeignByPoLine: new Map([['p', split]]), ppvAccount: '5050' } }),
  })
  assert.throws(() => fine(12.5), PurchaseBillTaxRefusal)
  assert.doesNotThrow(() => fine())
})
