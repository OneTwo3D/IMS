/**
 * Three money defects found by the 2026-11 workflow audit, each against a real scratch database and the real actions (permission, cache and outbound hooks stubbed).
 *
 *  1. A manual order whose prices include VAT but whose default VAT rate is "No VAT" (the form's default state) while a line carries VAT: the stored amounts read the
 *     typed price as gross and the ledger received it as NET, so the VAT was added a second time. Refused now; a chosen default rate posts the order inclusive.
 *  2. A clone (and any allocation of a DRAFT) moved the order to ALLOCATED without finalising it, so no sales invoice was ever queued.
 *  3. A bill edited before its first posting reached the ledger was never re-sent: the queued create posted the pre-edit figures.
 *
 * Every arm names the mutation that turns it red.
 */
import assert from 'node:assert/strict'
import test, { after, before, mock } from 'node:test'
import { startScratch, type Scratch } from './apply-scratch'

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireFreshPermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })

let s: Scratch
let productId: string
let vat20Id: string
let zeroId: string
let supplierId: string
let warehouseId: string
let seq = 0

before(async () => {
  s = await startScratch('ims-audit-fixes')
  for (const [key, value] of [['plugin_xero_enabled', 'true'], ['xero_sync_enabled', 'true'], ['xero_sales_account', '200'], ['xero_shipping_account', '210'], ['xero_discount_account', '220'], ['xero_transit_account', '631']] as const) {
    await s.db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  }
  productId = (await s.db.product.create({ data: { sku: 'AUD-1', name: 'AUD 1', type: 'SIMPLE' }, select: { id: true } })).id
  vat20Id = (await s.db.taxRate.create({ data: { name: 'AUD Sales 20', rate: '0.2', usedFor: 'SALES', accountingTaxType: 'OUTPUT2', active: true }, select: { id: true } })).id
  zeroId = (await s.db.taxRate.create({ data: { name: 'AUD Zero', rate: '0', usedFor: 'SALES', accountingTaxType: 'ZEROOUT', active: true }, select: { id: true } })).id
  supplierId = (await s.db.supplier.create({ data: { name: 'AUD Supplier', currency: 'GBP', prepaid: true }, select: { id: true } })).id
  const wh = await s.db.warehouse.findFirstOrThrow({ where: { availableForSale: true }, select: { id: true } })
  warehouseId = wh.id
  await s.db.stockLevel.create({ data: { productId, warehouseId, quantity: '50', reservedQty: '0' } })
})
after(async () => { await s?.stop() })

const line = (unitPriceForeign: number, extra: Record<string, unknown> = {}) => ({ productId, sku: 'AUD-1', description: 'x', qty: 1, unitPriceForeign, taxRateId: vat20Id, ...extra })
const orderInput = (extra: Record<string, unknown> = {}) => ({ customerName: `Cust ${++seq}`, currency: 'GBP', lines: [line(120)], ...extra })
const invoiceRows = (orderId: string) => s.db.accountingSyncLog.findMany({ where: { referenceId: orderId, type: { in: ['SALES_INVOICE', 'SALES_INVOICE_UPDATE'] } }, select: { id: true, type: true, payload: true } })
type InvoicePayload = { lineAmountsIncludeTax: boolean; lines: Array<{ unitAmount: number; taxType?: string }> }

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// 1. Inclusive prices with no default VAT rate
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

// [mutation: delete the inclusivePricesWithoutOrderRate refusal in createSalesOrder]
test('SO-H1: prices including VAT with "No VAT" as the default rate, a line carrying 20%: refused, nothing written', async () => {
  const { createSalesOrder } = await import('@/app/actions/sales')
  const before = await s.db.salesOrder.count()
  const r = await createSalesOrder(orderInput({ pricesIncludeVat: true, taxRateValue: 0 }) as never)
  assert.equal(r.success, false, 'a £120 gross price at 20% with no order rate must not be stored')
  assert.match(String(r.error), /no default VAT rate/)
  assert.equal(await s.db.salesOrder.count(), before, 'no order was written')
  const noRate = await createSalesOrder(orderInput({ pricesIncludeVat: true }) as never)
  assert.equal(noRate.success, false, 'taxRateValue left out is the same combination')
  const mixed = await createSalesOrder(orderInput({ pricesIncludeVat: true, lines: [line(120), line(50, { taxRateId: zeroId })] }) as never)
  assert.equal(mixed.success, false, 'one taxed line among zero-rated ones is enough')
  const allZero = await createSalesOrder(orderInput({ pricesIncludeVat: true, lines: [line(50, { taxRateId: zeroId })] }) as never)
  assert.equal(allZero.success, true, allZero.error)
})

// [mutation: lineAmountsIncludeTax stops following the header rate, or the refusal is removed]
test('SO-H1: with the default rate chosen, £120 gross is stored as net 100 + tax 20 = 120 and queued to the ledger INCLUSIVE at 120 (not 120 + 24)', async () => {
  const { createSalesOrder } = await import('@/app/actions/sales')
  const r = await createSalesOrder(orderInput({ pricesIncludeVat: true, taxRateName: 'AUD Sales 20', taxRateValue: 0.2 }) as never)
  assert.equal(r.success, true, r.error)
  const so = await s.db.salesOrder.findUniqueOrThrow({ where: { id: r.order!.id }, include: { lines: true } })
  assert.equal(Number(so.subtotalForeign), 100)
  assert.equal(Number(so.taxForeign), 20)
  assert.equal(Number(so.totalForeign), 120)
  assert.equal(Number(so.lines[0]!.unitPriceForeign), 120, 'the operator\'s typed gross price is kept')
  const rows = await invoiceRows(so.id)
  assert.equal(rows.length, 1, JSON.stringify(r.postCommitWarnings))
  const p = rows[0]!.payload as InvoicePayload
  assert.equal(p.lineAmountsIncludeTax, true)
  assert.equal(p.lines[0]!.unitAmount, 120)
  assert.equal(p.lines[0]!.taxType, 'OUTPUT2')
})

test('SO-H1: exclusive prices keep working with and without a default rate (net 100 + 20 = 120 either way)', async () => {
  const { createSalesOrder } = await import('@/app/actions/sales')
  for (const extra of [{ taxRateName: 'AUD Sales 20', taxRateValue: 0.2 }, { taxRateValue: 0 }]) {
    const r = await createSalesOrder(orderInput({ pricesIncludeVat: false, lines: [line(100)], ...extra }) as never)
    assert.equal(r.success, true, r.error)
    const so = await s.db.salesOrder.findUniqueOrThrow({ where: { id: r.order!.id } })
    assert.equal(Number(so.subtotalForeign), 100)
    assert.equal(Number(so.taxForeign), 20)
    assert.equal(Number(so.totalForeign), 120)
    const rows = await invoiceRows(so.id)
    assert.equal(rows.length, 1, JSON.stringify(r.postCommitWarnings))
    const p = rows[0]!.payload as InvoicePayload
    assert.equal(p.lineAmountsIncludeTax, false)
    assert.equal(p.lines[0]!.unitAmount, 100)
  }
})

// [mutation: delete the STORED_INCLUSIVE guard in updateSalesOrderStatus / queueSalesInvoiceForOrder]
test('SO-H1: a draft ALREADY stored with that combination is not finalised and no invoice is queued for it (existing orders are not re-read either way)', async () => {
  const { updateSalesOrderStatus } = await import('@/app/actions/sales')
  const legacy = await s.db.salesOrder.create({
    data: {
      orderNumber: `LEG-H1-${++seq}`, customerName: 'Legacy', currency: 'GBP', fxRateToBase: 1, status: 'DRAFT', pricesIncludeVat: true,
      subtotalForeign: '100', taxForeign: '20', totalForeign: '120', subtotalBase: '100', taxBase: '20', totalBase: '120',
      lines: { create: [{ productId, sku: 'AUD-1', description: 'x', qty: 1, unitPriceForeign: '120', unitPriceBase: '120', taxForeign: '20', taxBase: '20', totalForeign: '100', totalBase: '100', taxRateId: vat20Id }] },
    } as never,
    select: { id: true },
  })
  const r = await updateSalesOrderStatus(legacy.id, 'PENDING_PAYMENT')
  assert.equal(r.success, false)
  assert.match(String(r.error), /no default VAT rate/)
  assert.equal((await s.db.salesOrder.findUniqueOrThrow({ where: { id: legacy.id } })).status, 'DRAFT', 'the order did not move')
  assert.equal((await invoiceRows(legacy.id)).length, 0)
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// 2. A clone is finalised like any order
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

// [mutation: call autoAllocateOrder(clone.id) in cloneSalesOrder again, or let the allocator promote a DRAFT]
test('SO-H2: a clone stays DRAFT with no stock held and no invoice, then finalising it allocates AND queues exactly one invoice', async () => {
  const { createSalesOrder, cloneSalesOrder, updateSalesOrderStatus } = await import('@/app/actions/sales')
  const src = await createSalesOrder(orderInput({ pricesIncludeVat: true, taxRateName: 'AUD Sales 20', taxRateValue: 0.2 }) as never)
  assert.equal(src.success, true, src.error)
  const cloned = await cloneSalesOrder(src.order!.id)
  assert.equal(cloned.success, true, cloned.error)
  const clone = await s.db.salesOrder.findUniqueOrThrow({ where: { id: cloned.newId! }, include: { lines: true } })
  assert.equal(clone.status, 'DRAFT', 'the clone is a draft, as the UI says')
  assert.equal(clone.pricesIncludeVat, true, 'the clone reads the copied gross prices the way the source did')
  assert.equal(await s.db.orderAllocation.count({ where: { orderId: clone.id } }), 0, 'a draft holds no stock')
  assert.equal((await invoiceRows(clone.id)).length, 0, 'a draft is not invoiced')

  const done = await updateSalesOrderStatus(clone.id, 'PENDING_PAYMENT')
  assert.equal(done.success, true, done.error)
  const rows = await invoiceRows(clone.id)
  assert.equal(rows.length, 1, 'finalisation queued the invoice')
  const p = rows[0]!.payload as InvoicePayload
  assert.equal(p.lineAmountsIncludeTax, true, 'the clone of an inclusive order posts inclusive')
  assert.equal(p.lines[0]!.unitAmount, 120)
})

// [mutation: put 'DRAFT' back in the allocator's promote list]
test('SO-H2: allocating a DRAFT directly does not promote it (the server action needs only sales.process)', async () => {
  const { createSalesOrder } = await import('@/app/actions/sales')
  const { autoAllocateOrder } = await import('@/app/actions/allocation')
  const d = await createSalesOrder(orderInput({ isDraft: true, pricesIncludeVat: false, lines: [line(100)], taxRateName: 'AUD Sales 20', taxRateValue: 0.2 }) as never)
  assert.equal(d.success, true, d.error)
  const r = await autoAllocateOrder(d.order!.id)
  assert.equal(r.success, false)
  assert.match(String(r.error), /draft order is not allocated/i)
  assert.equal((await s.db.salesOrder.findUniqueOrThrow({ where: { id: d.order!.id } })).status, 'DRAFT')
  assert.equal(await s.db.orderAllocation.count({ where: { orderId: d.order!.id } }), 0)
})

// What the ledger would book for a queued sales invoice, from its payload alone (every line, the shipping and the discount at the one 20% rate).
type FullPayload = { lineAmountsIncludeTax: boolean; lines: Array<{ quantity: number; unitAmount: number; discountAmount?: number; taxType?: string }>; shippingAmount?: number; discountAmount?: number }
const ledgerTotal = (p: FullPayload) => {
  // Priced from the code each part is sent on: NONE is 0%, every other code in this file is the 20% one.
  const net = p.lines.map((l) => l.quantity * l.unitAmount - (l.discountAmount ?? 0))
  const sum = p.lineAmountsIncludeTax
    ? net.reduce((t, n) => t + n, 0) + (p.shippingAmount ?? 0) - (p.discountAmount ?? 0)
    : net.reduce((t, n, i) => t + n * (p.lines[i]!.taxType === 'NONE' ? 1 : 1.2), 0) + ((p.shippingAmount ?? 0) - (p.discountAmount ?? 0)) * 1.2
  return Math.round(sum * 100) / 100
}

async function wooSource(pricesIncludeVat: boolean) {
  // The shape the WooCommerce importer stores whatever the store's display setting says: every amount NET, header rate 20%, 100 + 10 shipping - 5 discount, VAT 21.
  const so = await s.db.salesOrder.create({
    data: {
      orderNumber: `WOO-${++seq}`, customerName: 'Woo', currency: 'GBP', fxRateToBase: 1, status: 'PROCESSING', pricesIncludeVat,
      taxRateName: 'AUD Sales 20', taxRatePercent: '0.2', discountAmount: '5',
      subtotalForeign: '100', shippingForeign: '10', taxForeign: '21', totalForeign: '126', subtotalBase: '100', shippingBase: '10', taxBase: '21', totalBase: '126',
      shoppingLinks: { create: { connector: 'woocommerce', externalOrderId: `wc-${seq}` } },
      lines: { create: [{ productId, sku: 'AUD-1', description: 'x', qty: 1, unitPriceForeign: '100', unitPriceBase: '100', taxForeign: '20', taxBase: '20', totalForeign: '100', totalBase: '100', taxRateId: vat20Id }] },
    } as never,
    select: { id: true },
  })
  return so.id
}

// [mutation: copy so.pricesIncludeVat unconditionally, or drop the WooCommerce test in cloneSalesOrder]
for (const [label, source] of [
  ['manual, prices including VAT', async () => (await (await import('@/app/actions/sales')).createSalesOrder(orderInput({ pricesIncludeVat: true, taxRateName: 'AUD Sales 20', taxRateValue: 0.2, shippingForeign: 12, orderDiscountForeign: 6 }) as never)).order!.id],
  ['manual, prices excluding VAT', async () => (await (await import('@/app/actions/sales')).createSalesOrder(orderInput({ pricesIncludeVat: false, lines: [line(100)], taxRateName: 'AUD Sales 20', taxRateValue: 0.2, shippingForeign: 10, orderDiscountForeign: 5 }) as never)).order!.id],
  ['WooCommerce, store shows prices including tax', () => wooSource(true)],
  ['WooCommerce, store shows prices excluding tax', () => wooSource(false)],
] as const) {
  test(`SO-H2: a clone of a ${label} source (with shipping and an order discount) is invoiced at exactly the clone's stored total`, async () => {
    const { cloneSalesOrder, updateSalesOrderStatus } = await import('@/app/actions/sales')
    const sourceId = await source()
    const cloned = await cloneSalesOrder(sourceId)
    assert.equal(cloned.success, true, cloned.error)
    const done = await updateSalesOrderStatus(cloned.newId!, 'PENDING_PAYMENT')
    assert.equal(done.success, true, done.error)
    const clone = await s.db.salesOrder.findUniqueOrThrow({ where: { id: cloned.newId! } })
    assert.equal(Number(clone.totalForeign), 126, 'the clone carries the source total')
    const rows = await invoiceRows(clone.id)
    assert.equal(rows.length, 1)
    assert.equal(ledgerTotal(rows[0]!.payload as FullPayload), Number(clone.totalForeign), 'the invoice the ledger would book equals the order')
  })
}

// [mutation: delete the reconciliation refusal in updateSalesOrderStatus / queueSalesInvoiceForOrder]
test('SO-H2: a WooCommerce order whose shipping is ZERO-RATED on a 20% order cannot be cloned into a mis-taxed invoice: finalisation is refused, nothing moves, nothing is queued', async () => {
  const { cloneSalesOrder, updateSalesOrderStatus } = await import('@/app/actions/sales')
  // 100 net at 20% + 10 shipping at 0%: the order is 130, but the invoice's shipping takes the order's 20% type (the importer's own invoice sends shipping with its own rate, which the order does not store).
  const src = await s.db.salesOrder.create({
    data: {
      orderNumber: `WOO-ZS-${++seq}`, customerName: 'Woo', currency: 'GBP', fxRateToBase: 1, status: 'PROCESSING', pricesIncludeVat: true,
      taxRateName: 'AUD Sales 20', taxRatePercent: '0.2',
      subtotalForeign: '100', shippingForeign: '10', taxForeign: '20', totalForeign: '130', subtotalBase: '100', shippingBase: '10', taxBase: '20', totalBase: '130',
      shoppingLinks: { create: { connector: 'woocommerce', externalOrderId: `wc-zs-${seq}` } },
      lines: { create: [{ productId, sku: 'AUD-1', description: 'x', qty: 1, unitPriceForeign: '100', unitPriceBase: '100', taxForeign: '20', taxBase: '20', totalForeign: '100', totalBase: '100', taxRateId: vat20Id }] },
    } as never,
    select: { id: true },
  })
  const cloned = await cloneSalesOrder(src.id)
  assert.equal(cloned.success, true, cloned.error)
  const refused = await updateSalesOrderStatus(cloned.newId!, 'PENDING_PAYMENT')
  assert.equal(refused.success, false)
  assert.match(String(refused.error), /would total 132\.00 GBP but the order totals 130\.00 GBP/)
  assert.equal((await s.db.salesOrder.findUniqueOrThrow({ where: { id: cloned.newId! } })).status, 'DRAFT', 'the clone did not move')
  assert.equal((await invoiceRows(cloned.newId!)).length, 0)
  assert.equal(await s.db.orderAllocation.count({ where: { orderId: cloned.newId! } }), 0)
})

// 100 net at 20% + a 10 fee the shop charged NO tax on (what the importer stores for a forced no-tax fee: no product, no rate, no VAT) = 130.
async function wooFeeSource(stripMarker: boolean) {
  const so = await s.db.salesOrder.create({
    data: {
      orderNumber: `WOO-FEE-${++seq}`, customerName: 'Woo', currency: 'GBP', fxRateToBase: 1, status: 'PROCESSING', pricesIncludeVat: false,
      taxRateName: 'AUD Sales 20', taxRatePercent: '0.2',
      subtotalForeign: '110', shippingForeign: '0', taxForeign: '20', totalForeign: '130', subtotalBase: '110', shippingBase: '0', taxBase: '20', totalBase: '130',
      shoppingLinks: { create: { connector: 'woocommerce', externalOrderId: `wc-fee-${seq}` } },
      lines: { create: [
        { productId, sku: 'AUD-1', description: 'x', qty: 1, unitPriceForeign: '100', unitPriceBase: '100', taxForeign: '20', taxBase: '20', totalForeign: '100', totalBase: '100', taxRateId: vat20Id },
        { productId: stripMarker ? productId : null, sku: null, description: 'Import Duty', qty: 1, unitPriceForeign: '10', unitPriceBase: '10', taxForeign: '0', taxBase: '0', totalForeign: '10', totalBase: '10', taxRateId: null },
      ] },
    } as never,
    select: { id: true },
  })
  return so.id
}

// [mutation: drop the isNoTaxFee identity in the invoice builder, or price the lines from stored VAT in the reconciliation]
test('SO-H2: a WooCommerce order with a no-tax fee (100 + 20% + 10 exempt = 130) clones, finalises and posts 130 with the fee on the no-tax code', async () => {
  const { cloneSalesOrder, updateSalesOrderStatus } = await import('@/app/actions/sales')
  const cloned = await cloneSalesOrder(await wooFeeSource(false))
  assert.equal(cloned.success, true, cloned.error)
  const done = await updateSalesOrderStatus(cloned.newId!, 'PENDING_PAYMENT')
  assert.equal(done.success, true, done.error)
  const rows = await invoiceRows(cloned.newId!)
  assert.equal(rows.length, 1)
  const p = rows[0]!.payload as FullPayload & { lines: Array<{ taxType?: string; noTaxKind?: string }> }
  assert.equal(p.lines[0]!.taxType, 'OUTPUT2')
  assert.equal(p.lines[1]!.taxType, 'NONE')
  assert.equal(p.lines[1]!.noTaxKind, 'fee-no-tax')
  assert.equal(ledgerTotal(p), 130)
  assert.equal(Number((await s.db.salesOrder.findUniqueOrThrow({ where: { id: cloned.newId! } })).totalForeign), 130)
})

test('SO-H2: the same fee with its no-tax identity stripped (a product on the line) would be sent on the taxable code and is refused, not posted at 132', async () => {
  const { cloneSalesOrder, updateSalesOrderStatus } = await import('@/app/actions/sales')
  const cloned = await cloneSalesOrder(await wooFeeSource(true))
  assert.equal(cloned.success, true, cloned.error)
  const refused = await updateSalesOrderStatus(cloned.newId!, 'PENDING_PAYMENT')
  assert.equal(refused.success, false)
  assert.match(String(refused.error), /would total 132\.00 GBP but the order totals 130\.00 GBP/)
  assert.equal((await invoiceRows(cloned.newId!)).length, 0)
})

// [mutation: stop passing the shipping / discount code's rate to the reconciliation (it then falls back to the stored header percent)]
test('SO-H2: shipping and the order discount are priced from the code they are sent on, not the stored header percent', async () => {
  const { updateSalesOrderStatus } = await import('@/app/actions/sales')
  // No stored header percent, but the header names the 20% code: shipping 10 and a discount 5 are sent on it. 100 + 20 VAT + 12 - 6 = 126.
  const so = await s.db.salesOrder.create({
    data: {
      orderNumber: `RATE-${++seq}`, customerName: 'Rate', currency: 'GBP', fxRateToBase: 1, status: 'DRAFT', pricesIncludeVat: false, taxRateName: 'AUD Sales 20', discountAmount: '5',
      subtotalForeign: '100', shippingForeign: '10', taxForeign: '21', totalForeign: '126', subtotalBase: '100', shippingBase: '10', taxBase: '21', totalBase: '126',
      lines: { create: [{ productId, sku: 'AUD-1', description: 'x', qty: 1, unitPriceForeign: '100', unitPriceBase: '100', taxForeign: '20', taxBase: '20', totalForeign: '100', totalBase: '100', taxRateId: vat20Id }] },
    } as never,
    select: { id: true },
  })
  const r = await updateSalesOrderStatus(so.id, 'PENDING_PAYMENT')
  assert.equal(r.success, true, r.error)
})

// [mutation: widen the no-tax fee identity (ignore the rate id, or the stored VAT)]
test('SO-H2: only a line with NO product, NO rate and NO VAT is a no-tax fee: a productless line with a rate keeps its own code, one with VAT takes the order\'s', async () => {
  const { updateSalesOrderStatus } = await import('@/app/actions/sales')
  const mk = (extraLine: Record<string, unknown>, total: string, tax: string) => s.db.salesOrder.create({
    data: {
      orderNumber: `FEE-${++seq}`, customerName: 'Fee', currency: 'GBP', fxRateToBase: 1, status: 'DRAFT', pricesIncludeVat: false, taxRateName: 'AUD Sales 20', taxRatePercent: '0.2',
      subtotalForeign: '110', taxForeign: tax, totalForeign: total, subtotalBase: '110', taxBase: tax, totalBase: total,
      lines: { create: [
        { productId, sku: 'AUD-1', description: 'x', qty: 1, unitPriceForeign: '100', unitPriceBase: '100', taxForeign: '20', taxBase: '20', totalForeign: '100', totalBase: '100', taxRateId: vat20Id },
        { productId: null, sku: null, description: 'Fee', qty: 1, unitPriceForeign: '10', unitPriceBase: '10', totalForeign: '10', totalBase: '10', ...extraLine },
      ] },
    } as never,
    select: { id: true },
  })
  const zeroRated = await mk({ taxRateId: zeroId, taxForeign: '0', taxBase: '0' }, '130', '20')
  assert.equal((await updateSalesOrderStatus(zeroRated.id, 'PENDING_PAYMENT')).success, true)
  const zl = ((await invoiceRows(zeroRated.id))[0]!.payload as { lines: Array<{ taxType?: string; noTaxKind?: string }> }).lines[1]!
  assert.equal(zl.taxType, 'ZEROOUT', 'a zero-rated fee keeps its rate\'s code')
  assert.equal(zl.noTaxKind, undefined)
  const taxed = await mk({ taxRateId: null, taxForeign: '2', taxBase: '2' }, '132', '22')
  assert.equal((await updateSalesOrderStatus(taxed.id, 'PENDING_PAYMENT')).success, true)
  const tl = ((await invoiceRows(taxed.id))[0]!.payload as { lines: Array<{ taxType?: string; noTaxKind?: string }> }).lines[1]!
  assert.equal(tl.taxType, 'OUTPUT2', 'a fee that carries VAT takes the order\'s taxable code')
  assert.equal(tl.noTaxKind, undefined)
})

// [mutation: price an ambiguous code from the first rate that carries it]
test('SO-H2: a code carried by two active rates with different values is not priced from either: the line\'s stored VAT stands', async () => {
  const { updateSalesOrderStatus } = await import('@/app/actions/sales')
  await s.db.taxRate.create({ data: { name: 'AUD Dual 20', rate: '0.2', usedFor: 'SALES', accountingTaxType: 'DUALOUT', active: true } })
  const dual10 = await s.db.taxRate.create({ data: { name: 'AUD Dual 10', rate: '0.1', usedFor: 'SALES', accountingTaxType: 'DUALOUT', active: true }, select: { id: true } })
  const so = await s.db.salesOrder.create({
    data: {
      orderNumber: `DUAL-${++seq}`, customerName: 'Dual', currency: 'GBP', fxRateToBase: 1, status: 'DRAFT', pricesIncludeVat: false, taxRateName: 'AUD Dual 10', taxRatePercent: '0.1',
      subtotalForeign: '100', taxForeign: '10', totalForeign: '110', subtotalBase: '100', taxBase: '10', totalBase: '110',
      lines: { create: [{ productId, sku: 'AUD-1', description: 'x', qty: 1, unitPriceForeign: '100', unitPriceBase: '100', taxForeign: '10', taxBase: '10', totalForeign: '100', totalBase: '100', taxRateId: dual10.id }] },
    } as never,
    select: { id: true },
  })
  const r = await updateSalesOrderStatus(so.id, 'PENDING_PAYMENT')
  assert.equal(r.success, true, r.error)
})

// [mutation: drop the in-transaction reconciliation in createSalesOrder, or make it a warning]
test('SO-H2: a LIVE order whose invoice would not book to its total is refused at creation: nothing is saved, nothing is allocated, nothing is queued', async () => {
  const { createSalesOrder } = await import('@/app/actions/sales')
  const orders = await s.db.salesOrder.count()
  const allocations = await s.db.orderAllocation.count()
  const syncRows = await s.db.accountingSyncLog.count()
  // The header names the 20% code but the order is told 10%: shipping is stored with 10% VAT and sent on the 20% code.
  const r = await createSalesOrder(orderInput({ pricesIncludeVat: false, lines: [line(100)], taxRateName: 'AUD Sales 20', taxRateValue: 0.1, shippingForeign: 10 }) as never)
  assert.equal(r.success, false)
  assert.match(String(r.error), /^The invoice built for this order would total 132\.00 GBP but the order totals 131\.00 GBP/, 'the operator sees the message itself, not an error class')
  assert.equal(await s.db.salesOrder.count(), orders, 'no order was written')
  assert.equal(await s.db.orderAllocation.count(), allocations, 'no stock was allocated')
  assert.equal(await s.db.accountingSyncLog.count(), syncRows, 'no invoice was queued')
  // The same order as a DRAFT is saved (it is checked at finalisation), and the consistent live order still goes through.
  const draft = await createSalesOrder(orderInput({ isDraft: true, pricesIncludeVat: false, lines: [line(100)], taxRateName: 'AUD Sales 20', taxRateValue: 0.1, shippingForeign: 10 }) as never)
  assert.equal(draft.success, true, draft.error)
  const ok = await createSalesOrder(orderInput({ pricesIncludeVat: false, lines: [line(100)], taxRateName: 'AUD Sales 20', taxRateValue: 0.2, shippingForeign: 10 }) as never)
  assert.equal(ok.success, true, ok.error)
  assert.equal((await invoiceRows(ok.order!.id)).length, 1)
})

// [mutation: reconcile against the amounts instead of the lines the connector emits; or drop the missing-mapping refusal]
test('SO-H2: shipping or an order discount whose account is not mapped would be DROPPED by the connector: live creation and finalisation refuse, naming the mapping', async () => {
  const { createSalesOrder, updateSalesOrderStatus } = await import('@/app/actions/sales')
  const keys = ['xero_shipping_account', 'xero_discount_account']
  const saved = await s.db.setting.findMany({ where: { key: { in: keys } } })
  const restore = async () => { for (const r of saved) await s.db.setting.upsert({ where: { key: r.key }, create: { key: r.key, value: r.value }, update: { value: r.value } }) }
  const base = { pricesIncludeVat: false, lines: [line(100)], taxRateName: 'AUD Sales 20', taxRateValue: 0.2 }
  try {
    // (a) no shipping account
    await s.db.setting.deleteMany({ where: { key: 'xero_shipping_account' } })
    const before = await s.db.salesOrder.count()
    const noShip = await createSalesOrder(orderInput({ ...base, shippingForeign: 10 }) as never)
    assert.equal(noShip.success, false)
    assert.match(String(noShip.error), /^This order has shipping of 10\.00 GBP, but the shipping account is not set/)
    assert.equal(await s.db.salesOrder.count(), before, 'nothing was saved')
    const draft = await createSalesOrder(orderInput({ ...base, shippingForeign: 10, isDraft: true }) as never)
    assert.equal(draft.success, true, draft.error)
    const fin = await updateSalesOrderStatus(draft.order!.id, 'PENDING_PAYMENT')
    assert.equal(fin.success, false)
    assert.match(String(fin.error), /shipping account is not set/)
    assert.equal((await s.db.salesOrder.findUniqueOrThrow({ where: { id: draft.order!.id } })).status, 'DRAFT')
    const plain = await createSalesOrder(orderInput(base) as never)
    assert.equal(plain.success, true, 'an order with no shipping does not need the mapping: ' + plain.error)
    await restore()
    // (b) shipping mapped, no discount account
    await s.db.setting.deleteMany({ where: { key: 'xero_discount_account' } })
    const noDisc = await createSalesOrder(orderInput({ ...base, shippingForeign: 10, orderDiscountForeign: 5 }) as never)
    assert.equal(noDisc.success, false)
    assert.match(String(noDisc.error), /^This order has an order discount of 5\.00 GBP, but the discount account is not set/)
    const shipOnly = await createSalesOrder(orderInput({ ...base, shippingForeign: 10 }) as never)
    assert.equal(shipOnly.success, true, 'shipping alone does not need the discount mapping: ' + shipOnly.error)
  } finally {
    await restore()
    await s.db.setting.upsert({ where: { key: 'xero_discount_account' }, create: { key: 'xero_discount_account', value: '220' }, update: { value: '220' } })
    await s.db.setting.upsert({ where: { key: 'xero_shipping_account' }, create: { key: 'xero_shipping_account', value: '210' }, update: { value: '210' } })
  }
})

// [mutation: read the display flag again instead of storedAmountsIncludeVat in the invoice builder]
test('SO-H2: an INCLUSIVE WooCommerce draft (stored net 100 + 20 VAT, display flag true) finalises through invoice enqueue as a 120 invoice, not a 100 one', async () => {
  const { updateSalesOrderStatus } = await import('@/app/actions/sales')
  // A storefront order allocates only from storefront-synced warehouses.
  const syncedWh = await s.db.warehouse.create({ data: { code: `AUD-WS-${seq}-${Date.now()}`, name: 'AUD storefront wh', type: 'STANDARD', availableForSale: true, syncToStore: true }, select: { id: true } })
  await s.db.stockLevel.create({ data: { productId, warehouseId: syncedWh.id, quantity: '50', reservedQty: '0' } })
  const so = await s.db.salesOrder.create({
    data: {
      orderNumber: `WOO-INC-${++seq}`, customerName: 'Woo', currency: 'GBP', fxRateToBase: 1, status: 'DRAFT', pricesIncludeVat: true, taxRateName: 'AUD Sales 20', taxRatePercent: '0.2',
      subtotalForeign: '100', taxForeign: '20', totalForeign: '120', subtotalBase: '100', taxBase: '20', totalBase: '120',
      shoppingLinks: { create: { connector: 'woocommerce', externalOrderId: `wc-inc-${seq}` } },
      lines: { create: [{ productId, sku: 'AUD-1', description: 'x', qty: 1, unitPriceForeign: '100', unitPriceBase: '100', taxForeign: '20', taxBase: '20', totalForeign: '100', totalBase: '100', taxRateId: vat20Id }] },
    } as never,
    select: { id: true },
  })
  const r = await updateSalesOrderStatus(so.id, 'PENDING_PAYMENT')
  assert.equal(r.success, true, r.error)
  const rows = await invoiceRows(so.id)
  assert.equal(rows.length, 1)
  const p = rows[0]!.payload as FullPayload
  assert.equal(p.lineAmountsIncludeTax, false, 'net amounts are sent as net')
  assert.equal(p.lines[0]!.unitAmount, 100)
  assert.equal(ledgerTotal(p), 120)
})

// [mutation: queue the invoice after the commit again (swallowing a failure), or allocate outside the finalisation transaction]
test('SO-H2: draft finalisation is ONE transaction: a failed invoice enqueue leaves the draft a draft, with no reservation and no invoice row; live creation likewise saves nothing', async () => {
  const { createSalesOrder, updateSalesOrderStatus } = await import('@/app/actions/sales')
  const draft = await createSalesOrder(orderInput({ isDraft: true, pricesIncludeVat: false, lines: [line(100)], taxRateName: 'AUD Sales 20', taxRateValue: 0.2 }) as never)
  assert.equal(draft.success, true, draft.error)
  const reserved = async () => Number((await s.db.stockLevel.findFirstOrThrow({ where: { productId, warehouseId }, select: { reservedQty: true } })).reservedQty)
  const reservedBefore = await reserved()
  await s.sql(`create or replace function aud_block_sync() returns trigger language plpgsql as $$ begin raise exception 'forced enqueue failure'; end $$`)
  await s.sql('create trigger aud_block_sync before insert on accounting_sync_logs for each row execute function aud_block_sync()')
  try {
    const failed = await updateSalesOrderStatus(draft.order!.id, 'PENDING_PAYMENT')
    assert.equal(failed.success, false)
    assert.equal((await s.db.salesOrder.findUniqueOrThrow({ where: { id: draft.order!.id } })).status, 'DRAFT', 'the status did not move')
    assert.equal(await s.db.orderAllocation.count({ where: { orderId: draft.order!.id } }), 0, 'nothing is allocated')
    assert.equal(await reserved(), reservedBefore, 'no stock is reserved')
    assert.equal((await invoiceRows(draft.order!.id)).length, 0)
    const orders = await s.db.salesOrder.count()
    const live = await createSalesOrder(orderInput({ pricesIncludeVat: false, lines: [line(100)], taxRateName: 'AUD Sales 20', taxRateValue: 0.2 }) as never)
    assert.equal(live.success, false)
    assert.equal(await s.db.salesOrder.count(), orders, 'the live order was not saved')
  } finally {
    await s.sql('drop trigger if exists aud_block_sync on accounting_sync_logs')
  }
  const ok = await updateSalesOrderStatus(draft.order!.id, 'PENDING_PAYMENT')
  assert.equal(ok.success, true, ok.error)
  assert.equal((await invoiceRows(draft.order!.id)).length, 1)
  assert.ok(await reserved() > reservedBefore, 'finalised: stock is reserved')
})

// [mutation: ignore a refused enqueue inside the finalisation transaction (postingIsOwed)]
test('SO-H2: an enqueue the accounting queue REFUSES (a retired tax code) rolls the finalisation back: the draft stays a draft with nothing allocated', async () => {
  const { updateSalesOrderStatus } = await import('@/app/actions/sales')
  const retiring = await s.db.taxRate.create({ data: { name: `AUD Retiring ${++seq}`, rate: '0.2', usedFor: 'SALES', accountingTaxType: 'RETIREDOUT', active: true }, select: { id: true } })
  const so = await s.db.salesOrder.create({
    data: {
      orderNumber: `RET-${seq}`, customerName: 'Ret', currency: 'GBP', fxRateToBase: 1, status: 'DRAFT', pricesIncludeVat: false, taxRateName: 'AUD Retiring ' + seq, taxRatePercent: '0.2',
      subtotalForeign: '100', taxForeign: '20', totalForeign: '120', subtotalBase: '100', taxBase: '20', totalBase: '120',
      lines: { create: [{ productId, sku: 'AUD-1', description: 'x', qty: 1, unitPriceForeign: '100', unitPriceBase: '100', taxForeign: '20', taxBase: '20', totalForeign: '100', totalBase: '100', taxRateId: retiring.id }] },
    } as never,
    select: { id: true },
  })
  const retired = JSON.stringify({ RETIREDOUT: { rateId: retiring.id, newCode: 'OUTPUT3', at: new Date().toISOString() } })
  await s.db.taxRate.update({ where: { id: retiring.id }, data: { active: false } })
  await s.db.setting.upsert({ where: { key: 'tax_rekey_retired_codes' }, create: { key: 'tax_rekey_retired_codes', value: retired }, update: { value: retired } })
  try {
    const r = await updateSalesOrderStatus(so.id, 'PENDING_PAYMENT')
    assert.equal(r.success, false, 'a refused enqueue refuses the finalisation')
    assert.equal((await s.db.salesOrder.findUniqueOrThrow({ where: { id: so.id } })).status, 'DRAFT')
    assert.equal(await s.db.orderAllocation.count({ where: { orderId: so.id } }), 0)
    assert.equal((await invoiceRows(so.id)).length, 0)
  } finally {
    await s.db.setting.deleteMany({ where: { key: 'tax_rekey_retired_codes' } })
  }
})

test('SO-H2: the reconciliation also refuses a stored order whose amounts are net but flagged gross, and lets every consistent order through', async () => {
  const { updateSalesOrderStatus } = await import('@/app/actions/sales')
  const mk = (flag: boolean, unit: string, total: string) => s.db.salesOrder.create({
    data: {
      orderNumber: `REC-${++seq}`, customerName: 'Rec', currency: 'GBP', fxRateToBase: 1, status: 'DRAFT', pricesIncludeVat: flag, taxRateName: 'AUD Sales 20', taxRatePercent: '0.2',
      subtotalForeign: '100', taxForeign: '20', totalForeign: total, subtotalBase: '100', taxBase: '20', totalBase: total,
      lines: { create: [{ productId, sku: 'AUD-1', description: 'x', qty: 1, unitPriceForeign: unit, unitPriceBase: unit, taxForeign: '20', taxBase: '20', totalForeign: '100', totalBase: '100', taxRateId: vat20Id }] },
    } as never,
    select: { id: true },
  })
  const bad = await mk(true, '100', '120') // net 100 stored under a gross flag: the invoice would book 100
  const refused = await updateSalesOrderStatus(bad.id, 'PENDING_PAYMENT')
  assert.equal(refused.success, false)
  assert.match(String(refused.error), /would total 100\.00 GBP but the order totals 120\.00 GBP/)
  assert.equal((await s.db.salesOrder.findUniqueOrThrow({ where: { id: bad.id } })).status, 'DRAFT')
  for (const [flag, unit] of [[true, '120'], [false, '100']] as const) {
    const good = await mk(flag, unit, '120')
    const ok = await updateSalesOrderStatus(good.id, 'PENDING_PAYMENT')
    assert.equal(ok.success, true, `${flag}: ${ok.error}`)
    assert.equal((await invoiceRows(good.id)).length, 1)
  }
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// 3. A bill edited before its first posting
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

async function seedBill() {
  const { createPurchaseOrder, createInvoice } = await import('@/app/actions/purchase-orders')
  const ref = `AUD-PO-${++seq}-${Date.now()}`
  const created = await createPurchaseOrder({
    reference: ref, supplierId, currency: 'GBP', destinationWarehouseId: warehouseId, pricesIncludeVat: false, taxRateValue: 0,
    lines: [{ productId, sku: 'AUD-1', productName: 'AUD 1', qty: 10, unitCostForeign: 12 }],
  } as never)
  assert.equal(created.success, true, String(created.error))
  const po = await s.db.purchaseOrder.findUniqueOrThrow({ where: { reference: ref }, select: { id: true } })
  await s.db.purchaseOrder.update({ where: { id: po.id }, data: { status: 'PO_SENT' } })
  const bill = await createInvoice(po.id, { invoiceDate: '2026-11-01', invoiceNumber: 'SUP-1', lines: [{ kind: 'product', poLineId: (await s.db.purchaseOrderLine.findFirstOrThrow({ where: { poId: po.id }, select: { id: true } })).id, qtyBilled: 10, unitCostForeign: 12 }] } as never)
  assert.equal(bill.success, true, String(bill.error))
  const invoice = await s.db.purchaseInvoice.findFirstOrThrow({ where: { poId: po.id }, select: { id: true, lines: { select: { id: true } } } })
  return { poId: po.id, invoice }
}
const createRows = (invoiceId: string) => s.db.accountingSyncLog.findMany({ where: { type: 'PURCHASE_INVOICE', referenceType: 'PurchaseInvoice', referenceId: invoiceId }, select: { id: true, status: true, payload: true } })
type BillPayload = { _idempotencyKey?: string; accountingInvoiceId?: string; lines: Array<{ quantity: number; unitAmount: number }> }

// [mutation: skip refreshPendingPurchaseInvoiceCreate in updateInvoice]
test('PO-H3: 10 x 12 corrected to 10 x 10 before the first posting: the ONE queued create now carries 100 (no update row, no second posting)', async () => {
  const { updateInvoice } = await import('@/app/actions/purchase-orders')
  const { poId, invoice } = await seedBill()
  const before = await createRows(invoice.id)
  assert.equal(before.length, 1)
  assert.equal(before[0]!.status, 'PENDING')
  const stampBefore = (before[0]!.payload as BillPayload)._idempotencyKey
  const pBefore = before[0]!.payload as BillPayload
  assert.equal(pBefore.lines.reduce((t, l) => t + l.quantity * l.unitAmount, 0), 120)

  const r = await updateInvoice(invoice.id, { invoiceDate: '2026-11-01', invoiceNumber: 'SUP-1', lines: [{ id: invoice.lines[0]!.id, qtyBilled: 10, unitCostForeign: 10 }] } as never)
  assert.equal(r.success, true, r.error)
  const bill = await s.db.purchaseInvoice.findUniqueOrThrow({ where: { id: invoice.id } })
  assert.equal(Number(bill.subtotalForeign), 100, 'IMS holds 100')
  const after = await createRows(invoice.id)
  assert.equal(after.length, 1, 'still the one create row')
  assert.equal(after[0]!.id, before[0]!.id)
  assert.equal(after[0]!.status, 'PENDING')
  const p = after[0]!.payload as BillPayload
  assert.equal(p.lines.reduce((t, l) => t + l.quantity * l.unitAmount, 0), 100, 'the first posting carries the edit')
  assert.equal(p._idempotencyKey, stampBefore, 'the row keeps its identity')
  assert.equal(p.accountingInvoiceId, undefined)
  assert.equal(await s.db.accountingSyncLog.count({ where: { type: 'PURCHASE_INVOICE_UPDATE', referenceId: poId } }), 0, 'no update was queued for a document that does not exist yet')
  const movements = await s.db.transitSubledgerMovement.findMany({ where: { sourceRef: poId }, select: { sourceType: true, baseDelta: true } })
  assert.deepEqual(movements.map((m) => m.sourceType).sort(), ['PURCHASE_BILL', 'PURCHASE_BILL_UPDATE'])
  assert.equal(movements.reduce((t, m) => t + Number(m.baseDelta), 0), 100, 'the transit subledger nets to the posted 100 (+120 at the bill, -20 at the edit)')
})

// [mutation: let the refresh run on a row that has been claimed / attempted]
test('PO-H3: once the first posting may have left (claimed, attempted, or posted but unlinked) the edit is refused and nothing is saved', async () => {
  const { updateInvoice } = await import('@/app/actions/purchase-orders')
  for (const [label, patch] of [
    ['claimed', { status: 'PROCESSING' }],
    ['failed (never provable unsent)', { status: 'FAILED' }],
    ['attempted then failed', { status: 'FAILED', remoteAttemptedAt: new Date() }],
    ['claimed once and released', { attemptRevision: 1 }],
    ['posted but not linked back', { status: 'SYNCED', externalTransactionId: 'XERO-BILL-ORPHAN' }],
  ] as const) {
    const { invoice } = await seedBill()
    const rows = await createRows(invoice.id)
    await s.db.accountingSyncLog.update({ where: { id: rows[0]!.id }, data: patch as never })
    const r = await updateInvoice(invoice.id, { invoiceDate: '2026-11-01', invoiceNumber: 'SUP-1', lines: [{ id: invoice.lines[0]!.id, qtyBilled: 10, unitCostForeign: 10 }] } as never)
    assert.equal(r.success, false, label)
    assert.match(String(r.error), /Nothing was saved/, label)
    assert.equal(Number((await s.db.purchaseInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).subtotalForeign), 120, `${label}: IMS still holds the posted figures`)
    const p = (await createRows(invoice.id))[0]!.payload as BillPayload
    assert.equal(p.lines.reduce((t, l) => t + l.quantity * l.unitAmount, 0), 120, `${label}: the row is untouched`)
  }
})

// [mutation: delete the retiredTaxCodesInPayload refusal in updateInvoice]
test('PO-H3: an edit that would put a retired tax code into the unsent first posting is refused and nothing is saved', async () => {
  const { createPurchaseOrder, createInvoice, updateInvoice } = await import('@/app/actions/purchase-orders')
  const rate = await s.db.taxRate.create({ data: { name: `AUD Bill ${++seq}`, rate: '0.2', usedFor: 'PURCHASE', accountingTaxType: 'TAX003', active: true }, select: { id: true } })
  const supplier = await s.db.supplier.create({ data: { name: `AUD Supplier ${seq}`, currency: 'GBP', prepaid: true, taxRateId: rate.id }, select: { id: true } })
  const ref = `AUD-PO-RC-${seq}-${Date.now()}`
  const created = await createPurchaseOrder({ reference: ref, supplierId: supplier.id, currency: 'GBP', destinationWarehouseId: warehouseId, pricesIncludeVat: false, taxRateValue: 0, lines: [{ productId, sku: 'AUD-1', productName: 'AUD 1', qty: 10, unitCostForeign: 12 }] } as never)
  assert.equal(created.success, true, String(created.error))
  const po = await s.db.purchaseOrder.findUniqueOrThrow({ where: { reference: ref }, select: { id: true, lines: { select: { id: true } } } })
  await s.db.purchaseOrder.update({ where: { id: po.id }, data: { status: 'PO_SENT' } })
  await s.db.purchaseOrderLine.updateMany({ where: { poId: po.id }, data: { taxRateId: rate.id } })
  const bill = await createInvoice(po.id, { invoiceDate: '2026-11-01', invoiceNumber: 'SUP-RC', lines: [{ kind: 'product', poLineId: po.lines[0]!.id, qtyBilled: 10, unitCostForeign: 12 }] } as never)
  assert.equal(bill.success, true, String(bill.error))
  const invoice = await s.db.purchaseInvoice.findFirstOrThrow({ where: { poId: po.id }, select: { id: true, lines: { select: { id: true } } } })
  assert.equal((await createRows(invoice.id)).length, 1, 'the first posting is queued')
  // A tax re-key retires the code after the bill was queued: the rate is replaced and the old code is on the retired list.
  const replacement = await s.db.taxRate.create({ data: { name: `AUD Bill repl ${seq}`, rate: '0.2', usedFor: 'PURCHASE', accountingTaxType: 'TAX004', active: true }, select: { id: true } })
  await s.db.taxRate.update({ where: { id: rate.id }, data: { active: false, replacedById: replacement.id } })
  await s.db.setting.upsert({ where: { key: 'tax_rekey_retired_codes' }, create: { key: 'tax_rekey_retired_codes', value: JSON.stringify({ TAX003: { rateId: rate.id, newCode: 'TAX004', at: new Date().toISOString() } }) }, update: { value: JSON.stringify({ TAX003: { rateId: rate.id, newCode: 'TAX004', at: new Date().toISOString() } }) } })
  try {
    const r = await updateInvoice(invoice.id, { invoiceDate: '2026-11-01', invoiceNumber: 'SUP-RC', lines: [{ id: invoice.lines[0]!.id, qtyBilled: 10, unitCostForeign: 10 }] } as never)
    assert.equal(r.success, false)
    assert.match(String(r.error), /no longer accepts/)
    assert.equal(Number((await s.db.purchaseInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).subtotalForeign), 120)
  } finally {
    await s.db.setting.deleteMany({ where: { key: 'tax_rekey_retired_codes' } })
  }
})

// ---- legacy create rows (keyed to the purchase order, naming no bill)
async function legacyKeyed(invoiceId: string, poId: string) {
  const [row] = await createRows(invoiceId)
  await s.db.accountingSyncLog.update({ where: { id: row!.id }, data: { referenceType: 'PurchaseOrder', referenceId: poId } })
  return row!.id
}
const legacyRowPayload = (id: string) => s.db.accountingSyncLog.findUniqueOrThrow({ where: { id }, select: { payload: true, referenceType: true } })

// [mutation: skip the legacy lookup in refreshPendingPurchaseInvoiceCreate]
test('PO-H3: a LEGACY purchase-order-keyed create row that is this bill\'s and unsent carries the edit; one that may have left refuses it', async () => {
  const { updateInvoice } = await import('@/app/actions/purchase-orders')
  const edit = (invoice: { id: string; lines: Array<{ id: string }> }) => updateInvoice(invoice.id, { invoiceDate: '2026-11-01', invoiceNumber: 'SUP-1', lines: [{ id: invoice.lines[0]!.id, qtyBilled: 10, unitCostForeign: 10 }] } as never)
  {
    const { poId, invoice } = await seedBill()
    const rowId = await legacyKeyed(invoice.id, poId)
    const r = await edit(invoice)
    assert.equal(r.success, true, r.error)
    const row = await legacyRowPayload(rowId)
    assert.equal(row.referenceType, 'PurchaseOrder')
    assert.equal((row.payload as BillPayload).lines.reduce((t, l) => t + l.quantity * l.unitAmount, 0), 100, 'the legacy row now carries 100')
    assert.equal(await s.db.accountingSyncLog.count({ where: { type: 'PURCHASE_INVOICE_UPDATE', referenceId: poId } }), 0)
  }
  {
    const { poId, invoice } = await seedBill()
    const rowId = await legacyKeyed(invoice.id, poId)
    await s.db.accountingSyncLog.update({ where: { id: rowId }, data: { status: 'PROCESSING' } })
    const r = await edit(invoice)
    assert.equal(r.success, false)
    assert.match(String(r.error), /Nothing was saved/)
    assert.equal(Number((await s.db.purchaseInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).subtotalForeign), 120)
    assert.equal((await legacyRowPayload(rowId) as unknown as { payload: BillPayload }).payload.lines.reduce((t, l) => t + l.quantity * l.unitAmount, 0), 120)
  }
})
