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
  for (const [key, value] of [['plugin_xero_enabled', 'true'], ['xero_sync_enabled', 'true'], ['xero_sales_account', '200'], ['xero_transit_account', '631']] as const) {
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
type FullPayload = InvoicePayload & { lines: Array<{ quantity: number; unitAmount: number; discountAmount?: number }>; shippingAmount?: number; discountAmount?: number }
const ledgerTotal = (p: FullPayload) => {
  const lines = p.lines.reduce((t, l) => t + l.quantity * l.unitAmount - (l.discountAmount ?? 0), 0)
  const net = lines + (p.shippingAmount ?? 0) - (p.discountAmount ?? 0)
  return Math.round((p.lineAmountsIncludeTax ? net : net * 1.2) * 100) / 100
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
    ['attempted then failed', { status: 'FAILED', remoteAttemptedAt: new Date() }],
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
