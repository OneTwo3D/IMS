import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertPurchaseInvoiceEditable,
  buildPurchaseInvoiceAccountingPayload,
  buildPurchaseInvoiceUpdateIdempotencyKey,
  calculatePurchaseInvoice,
  hasPurchaseInvoiceEditChanges,
  validatePurchaseInvoiceLineLimits,
  type PurchaseInvoiceEditHeader,
  type PurchaseInvoiceEditLine,
  type PurchaseInvoiceCostLine,
  type PurchaseInvoicePoLine,
} from '@/lib/domain/purchasing/purchase-invoice-edit'

const header: PurchaseInvoiceEditHeader = {
  invoiceNumber: 'SUP-1',
  invoiceDate: '2026-06-12',
  dueDate: '2026-07-12',
  notes: 'Original',
  supplierInvoiceUrl: '/uploads/invoice/supplier.pdf',
}

const lines: PurchaseInvoiceEditLine[] = [
  {
    id: 'line-1',
    description: null,
    qtyBilled: 2,
    unitCostForeign: 10,
    totalForeign: 20,
  },
  {
    id: 'line-2',
    description: 'Freight',
    qtyBilled: 1,
    unitCostForeign: 5,
    totalForeign: 5,
  },
]

const poLineById = new Map<string, PurchaseInvoicePoLine>([
  ['po-line-1', {
    id: 'po-line-1',
    qty: 5,
    product: { sku: 'SKU-1' },
    taxRate: { accountingTaxType: 'INPUT2' },
  }],
])

const costLineById = new Map<string, PurchaseInvoiceCostLine>([
  ['cost-vatable', {
    id: 'cost-vatable',
    description: 'Freight',
    amountForeign: 20,
    vatable: true,
  }],
  ['cost-non-vatable', {
    id: 'cost-non-vatable',
    description: 'Duty',
    amountForeign: 10,
    vatable: false,
  }],
])

test('assertPurchaseInvoiceEditable rejects paid bills', () => {
  assert.doesNotThrow(() => assertPurchaseInvoiceEditable({ paidAt: null }))
  assert.throws(
    () => assertPurchaseInvoiceEditable({ paidAt: '2026-06-12T10:00:00.000Z' }),
    /Paid bills cannot be edited/,
  )
})

test('hasPurchaseInvoiceEditChanges ignores line ordering but detects editable field changes', () => {
  assert.equal(hasPurchaseInvoiceEditChanges({
    existingHeader: header,
    nextHeader: { ...header },
    existingLines: lines,
    nextLines: [...lines].reverse(),
  }), false)

  assert.equal(hasPurchaseInvoiceEditChanges({
    existingHeader: header,
    nextHeader: { ...header, invoiceNumber: 'SUP-2' },
    existingLines: lines,
    nextLines: lines,
  }), true)

  assert.equal(hasPurchaseInvoiceEditChanges({
    existingHeader: header,
    nextHeader: header,
    existingLines: lines,
    nextLines: lines.map((line) => line.id === 'line-1' ? { ...line, qtyBilled: 3, totalForeign: 30 } : line),
  }), true)
})

test('buildPurchaseInvoiceUpdateIdempotencyKey is stable and payload-derived', () => {
  const basePayload = {
    accountingInvoiceId: 'xero-bill-1',
    invoiceNumber: 'PO-1',
    date: '2026-06-12',
    lines: [{ description: 'Line', quantity: 2, unitAmount: 10 }],
  }
  const first = buildPurchaseInvoiceUpdateIdempotencyKey({
    invoiceId: 'bill-1',
    accountingInvoiceId: 'xero-bill-1',
    payload: basePayload,
  })
  const repeat = buildPurchaseInvoiceUpdateIdempotencyKey({
    invoiceId: 'bill-1',
    accountingInvoiceId: 'xero-bill-1',
    payload: basePayload,
  })
  const changed = buildPurchaseInvoiceUpdateIdempotencyKey({
    invoiceId: 'bill-1',
    accountingInvoiceId: 'xero-bill-1',
    payload: { ...basePayload, date: '2026-06-13' },
  })

  assert.equal(first, repeat)
  assert.notEqual(first, changed)
})

test('calculatePurchaseInvoice builds shared totals and accounting lines for product and mixed VAT costs', () => {
  const calculation = calculatePurchaseInvoice({
    lines: [
      {
        kind: 'product',
        id: 'bill-line-product',
        poLineId: 'po-line-1',
        qtyBilled: 2,
        unitCostForeign: 10,
      },
      {
        kind: 'cost',
        id: 'bill-line-freight',
        costLineId: 'cost-vatable',
        description: 'Inbound freight',
        amountForeign: 5,
      },
      {
        kind: 'cost',
        id: 'bill-line-duty',
        costLineId: 'cost-non-vatable',
        amountForeign: 3,
      },
    ],
    fxRateToBase: 2,
    poReference: 'PO-1',
    poSubtotalForeign: 100,
    poTaxForeign: 20,
    transitAccount: '1400',
    fallbackTaxType: 'INPUT',
    poLineById,
    costLineById,
  })

  assert.deepEqual(calculation.lineData, [
    {
      id: 'bill-line-product',
      poLineId: 'po-line-1',
      costLineId: null,
      description: null,
      qtyBilled: 2,
      unitCostForeign: 10,
      totalForeign: 20,
      totalBase: 10,
    },
    {
      id: 'bill-line-freight',
      poLineId: null,
      costLineId: 'cost-vatable',
      description: 'Inbound freight',
      qtyBilled: 1,
      unitCostForeign: 5,
      totalForeign: 5,
      totalBase: 2.5,
    },
    {
      id: 'bill-line-duty',
      poLineId: null,
      costLineId: 'cost-non-vatable',
      description: 'Duty',
      qtyBilled: 1,
      unitCostForeign: 3,
      totalForeign: 3,
      totalBase: 1.5,
    },
  ])
  assert.equal(calculation.subtotalForeign, 28)
  assert.equal(calculation.subtotalBase, 14)
  assert.equal(calculation.taxForeign, 5)
  assert.equal(calculation.taxBase, 2.5)
  assert.equal(calculation.totalForeign, 33)
  assert.equal(calculation.totalBase, 16.5)
  assert.deepEqual(calculation.accountingLines, [
    {
      description: 'PO PO-1 line',
      quantity: 2,
      unitAmount: 10,
      accountCode: '1400',
      taxType: 'INPUT2',
    },
    {
      description: 'Inbound freight',
      quantity: 1,
      unitAmount: 5,
      accountCode: '1400',
      taxType: 'INPUT',
    },
    {
      description: 'Duty',
      quantity: 1,
      unitAmount: 3,
      accountCode: '1400',
      taxType: undefined,
    },
  ])
})

test('buildPurchaseInvoiceAccountingPayload normalizes optional connector fields consistently', () => {
  assert.deepEqual(buildPurchaseInvoiceAccountingPayload({
    accountingInvoiceId: 'xero-bill-1',
    poReference: 'PO-1',
    contactName: null,
    date: '2026-06-12',
    dueDate: null,
    currency: 'GBP',
    fxRateToBase: 1,
    reference: null,
    supplierInvoicePath: null,
    lines: [
      {
        description: 'PO PO-1 line',
        quantity: 1,
        unitAmount: 10,
        accountCode: '1400',
      },
    ],
  }), {
    accountingInvoiceId: 'xero-bill-1',
    invoiceNumber: 'PO-1',
    contactName: 'Unknown Supplier',
    date: '2026-06-12',
    dueDate: undefined,
    currency: 'GBP',
    currencyRateToBase: 1,
    reference: undefined,
    lines: [
      {
        description: 'PO PO-1 line',
        quantity: 1,
        unitAmount: 10,
        accountCode: '1400',
      },
    ],
    supplierInvoicePath: undefined,
  })
})

test('validatePurchaseInvoiceLineLimits rejects product and cost overbilling', () => {
  assert.doesNotThrow(() => validatePurchaseInvoiceLineLimits({
    lineData: [
      {
        poLineId: 'po-line-1',
        costLineId: null,
        description: null,
        qtyBilled: 2,
        unitCostForeign: 10,
        totalForeign: 20,
        totalBase: 10,
      },
      {
        poLineId: null,
        costLineId: 'cost-vatable',
        description: 'Freight',
        qtyBilled: 1,
        unitCostForeign: 5,
        totalForeign: 5,
        totalBase: 2.5,
      },
    ],
    alreadyBilledLines: [
      { poLineId: 'po-line-1', costLineId: null, qtyBilled: 3, totalForeign: 30 },
      { poLineId: null, costLineId: 'cost-vatable', qtyBilled: 1, totalForeign: 15 },
    ],
    poLineById,
    costLineById,
  }))

  assert.throws(() => validatePurchaseInvoiceLineLimits({
    lineData: [
      {
        poLineId: 'po-line-1',
        costLineId: null,
        description: null,
        qtyBilled: 2.1,
        unitCostForeign: 10,
        totalForeign: 21,
        totalBase: 10.5,
      },
    ],
    alreadyBilledLines: [
      { poLineId: 'po-line-1', costLineId: null, qtyBilled: 3, totalForeign: 30 },
    ],
    poLineById,
    costLineById,
  }), /Line SKU-1 exceeds remaining qty/)

  assert.throws(() => validatePurchaseInvoiceLineLimits({
    lineData: [
      {
        poLineId: null,
        costLineId: 'cost-vatable',
        description: 'Freight',
        qtyBilled: 1,
        unitCostForeign: 5.01,
        totalForeign: 5.01,
        totalBase: 2.505,
      },
    ],
    alreadyBilledLines: [
      { poLineId: null, costLineId: 'cost-vatable', qtyBilled: 1, totalForeign: 15 },
    ],
    poLineById,
    costLineById,
  }), /Cost line "Freight" exceeds remaining amount/)
})

test('calculatePurchaseInvoice swaps taxType to reverseChargeTaxType when poLine.taxRate.reverseCharge is true', () => {
  const poLineById = new Map([
    ['po-line-uk', {
      id: 'po-line-uk',
      qty: 5 as unknown,
      product: { sku: 'SKU-UK' },
      taxRate: { accountingTaxType: 'INPUT2', reverseCharge: false },
    }],
    ['po-line-rc', {
      id: 'po-line-rc',
      qty: 5 as unknown,
      product: { sku: 'SKU-RC' },
      taxRate: { accountingTaxType: 'INPUT2', reverseCharge: true },
    }],
  ])
  const result = calculatePurchaseInvoice({
    lines: [
      { kind: 'product', poLineId: 'po-line-uk', qtyBilled: 1, unitCostForeign: 100 },
      { kind: 'product', poLineId: 'po-line-rc', qtyBilled: 1, unitCostForeign: 100 },
    ],
    fxRateToBase: 1,
    poReference: 'PO-1',
    poSubtotalForeign: 200,
    poTaxForeign: 40,
    transitAccount: 'TRANSIT',
    fallbackTaxType: 'NONE',
    reverseChargeTaxType: 'REVERSECHARGES',
    poLineById,
    costLineById: new Map(),
  })
  assert.equal(result.accountingLines[0]?.taxType, 'INPUT2')
  assert.equal(result.accountingLines[1]?.taxType, 'REVERSECHARGES')
})

test('calculatePurchaseInvoice falls back to baseTaxType when reverseChargeTaxType is empty', () => {
  const poLineById = new Map([
    ['po-line-rc', {
      id: 'po-line-rc',
      qty: 5 as unknown,
      product: { sku: 'SKU-RC' },
      taxRate: { accountingTaxType: 'INPUT2', reverseCharge: true },
    }],
  ])
  const result = calculatePurchaseInvoice({
    lines: [{ kind: 'product', poLineId: 'po-line-rc', qtyBilled: 1, unitCostForeign: 100 }],
    fxRateToBase: 1,
    poReference: 'PO-1',
    poSubtotalForeign: 100,
    poTaxForeign: 0,
    transitAccount: 'TRANSIT',
    fallbackTaxType: 'NONE',
    poLineById,
    costLineById: new Map(),
  })
  assert.equal(result.accountingLines[0]?.taxType, 'INPUT2')
})
