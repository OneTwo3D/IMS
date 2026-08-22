import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import { calcRequotedLineAmounts } from '@/lib/domain/purchasing/quote-line-amounts'

// o3d-4rp: submitSupplierQuote rewrote each line's qty/unitCost/total on a requote but left
// taxForeign/taxBase at the values computed for the ORIGINAL RFQ prices, then summed those stale
// figures into the PO tax totals — and, since o3d-lx1, consumed them as the basis and the VAT split
// of the reapplied header discount. The line tax must track the requoted price.

test('a VAT-exclusive requote derives line tax from the NEW price, never the old one', () => {
  // RFQ line was 2 @ 100 (tax 40 at 20%). Supplier requotes 150: tax must be 60, not the stored 40.
  const amounts = calcRequotedLineAmounts({
    qty: 2,
    quotedUnitPriceForeign: 150,
    taxRate: 0.2,
    pricesIncludeVat: false,
    fxRateToBase: 1,
  })
  assert.equal(amounts.totalForeign.toString(), '300')
  assert.equal(amounts.unitCostForeign.toString(), '150')
  assert.equal(amounts.taxForeign.toString(), '60')
  assert.equal(amounts.taxBase.toString(), '60')
})

test('a VAT-inclusive requote extracts the net and books the difference as tax', () => {
  // PurchaseOrderLine.unitCostForeign/totalForeign are NET by schema contract, and on an inclusive
  // PO the quoted price is gross. 2 @ 120 gross at 20% = 200 net + 40 VAT.
  const amounts = calcRequotedLineAmounts({
    qty: 2,
    quotedUnitPriceForeign: 120,
    taxRate: 0.2,
    pricesIncludeVat: true,
    fxRateToBase: 1,
  })
  assert.equal(amounts.totalForeign.toString(), '200')
  assert.equal(amounts.unitCostForeign.toString(), '100')
  assert.equal(amounts.taxForeign.toString(), '40')
})

test('a zero-rate line books no tax and leaves the quoted price untouched', () => {
  // The "No VAT supplier" case, and the pre-o3d-4rp arithmetic: qty x price, tax 0.
  const amounts = calcRequotedLineAmounts({
    qty: 3,
    quotedUnitPriceForeign: 25,
    taxRate: 0,
    pricesIncludeVat: true,
    fxRateToBase: 1,
  })
  assert.equal(amounts.totalForeign.toString(), '75')
  assert.equal(amounts.unitCostForeign.toString(), '25')
  assert.equal(amounts.taxForeign.toString(), '0')
})

test('line tax converts to base on the PO fx rate', () => {
  const amounts = calcRequotedLineAmounts({
    qty: 4,
    quotedUnitPriceForeign: 50,
    taxRate: 0.25,
    pricesIncludeVat: false,
    fxRateToBase: 2,
  })
  assert.equal(amounts.totalForeign.toString(), '200')
  assert.equal(amounts.totalBase.toString(), '100')
  assert.equal(amounts.taxForeign.toString(), '50')
  assert.equal(amounts.taxBase.toString(), '25')
})

test('requote money is Decimal — a price float would not sum exactly', () => {
  const amounts = calcRequotedLineAmounts({
    qty: 3,
    quotedUnitPriceForeign: '0.1',
    taxRate: '0.2',
    pricesIncludeVat: false,
    fxRateToBase: 1,
  })
  assert.ok(amounts.totalForeign instanceof Prisma.Decimal)
  assert.equal(amounts.totalForeign.toString(), '0.3', '0.1 * 3 must be exactly 0.3, not 0.30000000000000004')
  assert.equal(amounts.taxForeign.toString(), '0.06')
})

// --- The action itself actually persists the recomputed tax -----------------

type LineUpdate = { where: { id: string }; data: Record<string, string> }
const lineUpdates: LineUpdate[] = []
let poUpdateData: Record<string, unknown> | undefined

const RFQ_LINE = {
  id: 'line-1',
  // RFQ was priced at 100/unit, so the stored tax is 20% of 2 x 100 = 40.
  taxForeign: new Prisma.Decimal('40'),
  taxBase: new Prisma.Decimal('40'),
  totalForeign: new Prisma.Decimal('200'),
  totalBase: new Prisma.Decimal('200'),
  taxRate: { rate: new Prisma.Decimal('0.2') },
}

const tx = {
  $queryRaw: async () => [],
  purchaseOrder: {
    findFirst: async () => ({
      id: 'po-1',
      supplierId: 'sup-1',
      reference: 'PO-0001',
      currency: 'EUR',
      fxRateToBase: new Prisma.Decimal('1'),
      discountStr: null,
      discountAmount: new Prisma.Decimal('0'),
      pricesIncludeVat: false,
      taxRatePercent: new Prisma.Decimal('0.2'),
    }),
    updateMany: async ({ data }: { data: Record<string, unknown> }) => {
      poUpdateData = data
      return { count: 1 }
    },
  },
  purchaseOrderLine: {
    findFirst: async () => RFQ_LINE,
    update: async (args: LineUpdate) => {
      lineUpdates.push(args)
      // Reflect the write back, the way the subsequent findMany would read it.
      RFQ_LINE.totalForeign = new Prisma.Decimal(args.data.totalForeign)
      RFQ_LINE.totalBase = new Prisma.Decimal(args.data.totalBase)
      RFQ_LINE.taxForeign = new Prisma.Decimal(args.data.taxForeign ?? RFQ_LINE.taxForeign)
      RFQ_LINE.taxBase = new Prisma.Decimal(args.data.taxBase ?? RFQ_LINE.taxBase)
      return args
    },
    findMany: async () => [{
      totalForeign: RFQ_LINE.totalForeign,
      totalBase: RFQ_LINE.totalBase,
      taxForeign: RFQ_LINE.taxForeign,
      taxBase: RFQ_LINE.taxBase,
    }],
  },
}

mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/auth', {
  namedExports: { auth: async () => ({ user: { id: 'u1', role: 'SUPPLIER', supplierId: 'sup-1' } }) },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/rate-limit', { namedExports: { checkRateLimit: async () => ({ allowed: true }) } })
mock.module('@/lib/db', {
  namedExports: {
    db: { $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx) },
  },
})

test('submitSupplierQuote PERSISTS the recomputed line tax and sums it into the PO totals', async () => {
  const { submitSupplierQuote } = await import('@/app/actions/supplier-portal')

  const result = await submitSupplierQuote('po-1', {
    lines: [{ lineId: 'line-1', unitPrice: 150, qty: 2 }],
    supplierRef: 'Q-99',
    expectedDelivery: '',
    shippingCost: 0,
    shippingMethod: '',
  })

  assert.equal(result.success, true, result.error)
  assert.equal(lineUpdates.length, 1)
  assert.equal(lineUpdates[0]?.data.totalForeign, '300')
  assert.equal(lineUpdates[0]?.data.taxForeign, '60', 'stale RFQ tax of 40 must be rewritten to 20% of the requoted 300')
  assert.equal(lineUpdates[0]?.data.taxBase, '60')
  assert.equal(poUpdateData?.subtotalForeign, '300')
  assert.equal(poUpdateData?.taxForeign, '60', 'the PO header must sum the requoted tax, not the RFQ tax')
  assert.equal(poUpdateData?.totalForeign, '360')
})
