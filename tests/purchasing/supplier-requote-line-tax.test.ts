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

let landShipping = false
const freightCreates: Array<Record<string, unknown>> = []
const freightDeletes: string[][] = []
const activityCalls: Array<Record<string, unknown>> = []
let storedCostLines: Array<Record<string, unknown>> = [
  { id: 'c1', description: 'Freight', amountForeign: new Prisma.Decimal('50'), vatable: true, kind: null, _count: { invoiceLines: 0 } },
]
const tx = {
  $queryRaw: async () => [],
  setting: { findUnique: async () => (landShipping ? { value: 'true' } : null) },
  freightCostLine: {
    findMany: async () => storedCostLines,
    deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => { freightDeletes.push(where.id.in); return { count: where.id.in.length } },
    create: async ({ data }: { data: Record<string, unknown> }) => { freightCreates.push(data); return data },
  },
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

let orderLanded = false
mock.module('@/lib/domain/purchasing/po-edit-plan', { namedExports: { readPoEditFacts: async () => ({ anyLanded: orderLanded }) } })
mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/auth', {
  namedExports: { auth: async () => ({ user: { id: 'u1', role: 'SUPPLIER', supplierId: 'sup-1' } }) },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async (a: Record<string, unknown>) => { activityCalls.push(a) } } })
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

test('supplier-quoted shipping: OFF writes only the aggregate; ON also creates a landed cost line and keeps the buyer freight VAT', async () => {
  const { submitSupplierQuote } = await import('@/app/actions/supplier-portal')
  const quote = { lines: [{ lineId: 'line-1', unitPrice: 150, qty: 2 }], supplierRef: 'Q-99', expectedDelivery: '', shippingCost: 80, shippingMethod: '' }

  landShipping = false
  freightCreates.length = 0
  assert.equal((await submitSupplierQuote('po-1', quote)).success, true)
  assert.equal(freightCreates.length, 0, 'flag OFF: no cost line, behaviour unchanged')
  assert.equal(poUpdateData?.directFreightForeign, '80')
  const offTax = Number(poUpdateData?.taxForeign)

  landShipping = true
  assert.equal((await submitSupplierQuote('po-1', quote)).success, true)
  assert.equal(freightCreates.length, 1)
  assert.equal(freightCreates[0]?.description, 'Supplier quoted shipping')
  assert.equal(String(freightCreates[0]?.amountForeign), '80')
  assert.equal(poUpdateData?.directFreightForeign, '130', 'aggregate = buyer 50 + supplier 80')
  assert.equal(Number(poUpdateData?.taxForeign) - offTax, 10, 'the 20% VAT on the buyer vatable 50 is kept')
  landShipping = false
})


// ---- Owner ruling 2026-11-18: through the real action ----
const shipQuote = { lines: [{ lineId: 'line-1', unitPrice: 150, qty: 2 }], supplierRef: 'Q-99', expectedDelivery: '', shippingCost: 80, shippingMethod: '' }
const taggedLine = (over: Record<string, unknown> = {}) => ({ id: 'b1', description: 'Carriage estimate', amountForeign: new Prisma.Decimal('30'), vatable: false, kind: 'SHIPPING', _count: { invoiceLines: 0 }, ...over })
const reset = () => { freightCreates.length = 0; freightDeletes.length = 0; activityCalls.length = 0 }

test('flag ON: an unbilled Shipping-tagged buyer line is replaced by the supplier line, which is itself tagged Shipping', async () => {
  const { submitSupplierQuote } = await import('@/app/actions/supplier-portal')
  reset(); landShipping = true
  storedCostLines = [taggedLine()]
  assert.equal((await submitSupplierQuote('po-1', shipQuote)).success, true)
  assert.deepEqual(freightDeletes, [['b1']])
  assert.equal(freightCreates.length, 1)
  assert.equal(freightCreates[0]?.kind, 'SHIPPING')
  assert.equal(poUpdateData?.directFreightForeign, '80', 'shipping counted once: the 30 estimate is gone')
  assert.equal(activityCalls.some((a) => a.action === 'supplier_quote_shipping_replace_refused'), false)
  landShipping = false
})

test('flag ON: a billed Shipping line is kept beside the supplier line and a WARNING row is logged', async () => {
  const { submitSupplierQuote } = await import('@/app/actions/supplier-portal')
  reset(); landShipping = true
  storedCostLines = [taggedLine({ _count: { invoiceLines: 1 } })]
  assert.equal((await submitSupplierQuote('po-1', shipQuote)).success, true)
  assert.deepEqual(freightDeletes, [])
  assert.equal(freightCreates.length, 1)
  assert.equal(poUpdateData?.directFreightForeign, '110')
  const warn = activityCalls.find((a) => a.action === 'supplier_quote_shipping_replace_refused')
  assert.equal(warn?.level, 'WARNING')
  assert.equal((warn?.metadata as { reason: string }).reason, 'billed')
  landShipping = false
})

test('flag ON: a Shipping line on an order whose goods have landed is kept beside the supplier line, with a WARNING row', async () => {
  const { submitSupplierQuote } = await import('@/app/actions/supplier-portal')
  reset(); landShipping = true; orderLanded = true
  storedCostLines = [taggedLine()]
  assert.equal((await submitSupplierQuote('po-1', shipQuote)).success, true)
  orderLanded = false
  assert.deepEqual(freightDeletes, [])
  assert.equal(poUpdateData?.directFreightForeign, '110')
  assert.equal((activityCalls.find((a) => a.action === 'supplier_quote_shipping_replace_refused')?.metadata as { reason: string }).reason, 'landed')
  landShipping = false
})

test('flag ON: untagged lines (even one called Shipping) are left alone', async () => {
  const { submitSupplierQuote } = await import('@/app/actions/supplier-portal')
  reset(); landShipping = true
  storedCostLines = [taggedLine({ kind: null })]
  assert.equal((await submitSupplierQuote('po-1', shipQuote)).success, true)
  assert.deepEqual(freightDeletes, [])
  assert.equal(poUpdateData?.directFreightForeign, '110')
  landShipping = false
})

test('flag ON: a requote replaces the previous supplier-quoted line', async () => {
  const { submitSupplierQuote } = await import('@/app/actions/supplier-portal')
  reset(); landShipping = true
  storedCostLines = [taggedLine({ id: 'q1', description: 'Supplier quoted shipping', amountForeign: new Prisma.Decimal('70') })]
  assert.equal((await submitSupplierQuote('po-1', shipQuote)).success, true)
  assert.deepEqual(freightDeletes, [['q1']])
  assert.equal(poUpdateData?.directFreightForeign, '80')
  landShipping = false
})

test('flag OFF with a Shipping-tagged line: nothing is read, deleted or created, and the aggregate is the supplier figure', async () => {
  const { submitSupplierQuote } = await import('@/app/actions/supplier-portal')
  reset(); landShipping = false
  storedCostLines = [taggedLine()]
  assert.equal((await submitSupplierQuote('po-1', shipQuote)).success, true)
  assert.deepEqual(freightDeletes, [])
  assert.equal(freightCreates.length, 0)
  assert.equal(poUpdateData?.directFreightForeign, '80')
  assert.equal(activityCalls.some((a) => a.action === 'supplier_quote_shipping_replace_refused'), false)
})
