/**
 * GR/IR (goods received, not invoiced) accrual, against a real scratch database and the real actions (permission, cache and outbound hooks stubbed).
 *
 * The sub-ledger is written in the SAME transaction as the receipt, the bill, the bill edit, the return and the return-generated credit note, so these arms
 * run the actions and read the table: they cannot be satisfied by a double that merely records a call. Xero is never reached (the outbox is read, never
 * drained) and the network is blocked by the harness.
 *
 * Every arm names the mutation that turns it red.
 */
import assert from 'node:assert/strict'
import test, { after, before, mock } from 'node:test'
import { startScratch, type Scratch } from '../first-load/apply-scratch'

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
// The daily batch imports the Xero books lock date at the start of a run; offline, and not what this file tests.
mock.module('@/lib/connectors/xero/books-lock-date', { namedExports: { refreshXeroBooksLockDate: async () => ({ lockDate: null, refreshed: false }) } })

let s: Scratch
let productId: string
let supplierId: string
let prepaidSupplierId: string
let warehouseId: string
let seq = 0

before(async () => {
  s = await startScratch('ims-grir')
  productId = (await s.db.product.create({ data: { sku: 'GRIR-1', name: 'GRIR 1', type: 'SIMPLE' }, select: { id: true } })).id
  supplierId = (await s.db.supplier.create({ data: { name: 'GRIR Supplier', currency: 'GBP', prepaid: false }, select: { id: true } })).id
  prepaidSupplierId = (await s.db.supplier.create({ data: { name: 'GRIR Prepaid Supplier', currency: 'GBP', prepaid: true }, select: { id: true } })).id
  warehouseId = (await s.db.warehouse.findFirstOrThrow({ where: { availableForSale: true }, select: { id: true } })).id
})
after(async () => { await s?.stop() })

type Po = { id: string; lineId: string; reference: string }

/** A sent order for `qty` units at `unitCost` (GBP, no tax, no discount) from `supplier`. */
async function seedPo(qty: number, unitCost: number, supplier = supplierId): Promise<Po> {
  const { createPurchaseOrder } = await import('@/app/actions/purchase-orders')
  const reference = `GRIR-PO-${++seq}-${Date.now()}`
  const created = await createPurchaseOrder({
    reference, supplierId: supplier, currency: 'GBP', destinationWarehouseId: warehouseId, pricesIncludeVat: false, taxRateValue: 0,
    lines: [{ productId, sku: 'GRIR-1', productName: 'GRIR 1', qty, unitCostForeign: unitCost }],
  } as never)
  assert.equal(created.success, true, String(created.error))
  const po = await s.db.purchaseOrder.findUniqueOrThrow({ where: { reference }, select: { id: true, lines: { select: { id: true } } } })
  await s.db.purchaseOrder.update({ where: { id: po.id }, data: { status: 'PO_SENT' } })
  return { id: po.id, lineId: po.lines[0]!.id, reference }
}

const receive = async (po: Po, qty: number, options?: { idempotencyToken?: string }) => {
  const { receivePurchaseOrder } = await import('@/app/actions/purchase-orders')
  return receivePurchaseOrder(po.id, [{ poLineId: po.lineId, qtyReceived: qty, warehouseId }], undefined, options)
}
const bill = async (po: Po, qty: number, unitCost: number) => {
  const { createInvoice } = await import('@/app/actions/purchase-orders')
  return createInvoice(po.id, { invoiceDate: '2026-11-10', invoiceNumber: `SUP-${++seq}`, lines: [{ kind: 'product', poLineId: po.lineId, qtyBilled: qty, unitCostForeign: unitCost }] } as never)
}
const rows = (poId: string) => s.db.grirSubledgerMovement.findMany({ where: { poId }, orderBy: [{ createdAt: 'asc' }, { sourceType: 'asc' }], select: { sourceType: true, baseDelta: true, qtyDelta: true, poLineId: true, supplierId: true, idempotencyKey: true } })
const balance = async (poId: string) => (await import('@/lib/domain/accounting/grir-subledger-movement')).sumGrirBalance('2100-01-01', { poId, client: s.db })
const byType = async (poId: string, type: string) => (await rows(poId)).filter((r) => r.sourceType === type)

// [mutation: delete the recordGrirReceipt call in receivePurchaseOrder]
test('a receipt credits GR/IR with the received quantity at the PO unit cost, with the stock, whether or not Xero posting is on', async () => {
  const po = await seedPo(10, 12)
  assert.equal(await s.db.grirSubledgerMovement.count({ where: { poId: po.id } }), 0, 'nothing accrues before a receipt')
  const r = await receive(po, 10)
  assert.equal(r.success, true, String(r.error))
  const receipt = await byType(po.id, 'RECEIPT')
  assert.equal(receipt.length, 1)
  assert.equal(Number(receipt[0]!.baseDelta), 120, '10 x 12 credited')
  assert.equal(Number(receipt[0]!.qtyDelta), 10)
  assert.equal(receipt[0]!.supplierId, supplierId)
  assert.equal(receipt[0]!.poLineId, po.lineId)
  assert.equal((await balance(po.id)).toNumber(), 120)
  // It is the valuation the cost layer carries (no freight here, so the goods part is all of it).
  const layer = await s.db.costLayer.findFirstOrThrow({ where: { poLineId: po.lineId }, select: { unitCostBase: true, receivedQty: true } })
  assert.equal(Number(layer.unitCostBase) * Number(layer.receivedQty), 120)
})

// [mutation: delete the recordGrirBill call in createInvoice, or write the bill as a credit]
test('the bill debits GR/IR by the billed quantity at the PO value, and a full receipt-then-bill cycle nets to zero', async () => {
  const po = await seedPo(10, 12)
  assert.equal((await receive(po, 10)).success, true)
  const b = await bill(po, 10, 12)
  assert.equal(b.success, true, String(b.error))
  const billRows = await byType(po.id, 'BILL')
  assert.equal(billRows.length, 1)
  assert.equal(Number(billRows[0]!.baseDelta), -120)
  assert.equal(Number(billRows[0]!.qtyDelta), -10)
  assert.equal((await balance(po.id)).toNumber(), 0, 'received 120, billed 120: nothing open')
  assert.equal((await byType(po.id, 'BILL_PRICE_VARIANCE')).length, 0, 'the bill agrees with the order: no price difference row')
})

// [mutation: value the bill at the billed price instead of the PO value]
test('a partial receipt and a partial bill leave the right open balance, and the report lists it as received not billed', async () => {
  const po = await seedPo(10, 12)
  assert.equal((await receive(po, 4)).success, true)
  assert.equal((await bill(po, 3, 12)).success, true)
  assert.equal((await balance(po.id)).toNumber(), 12, '(4 received - 3 billed) x 12')
  const { getGrirReport } = await import('@/lib/domain/finance/finance-period-analytics')
  const report = await getGrirReport({ pageSize: 500 }, { deps: { baseCurrency: async () => 'GBP', client: s.db as never } })
  const row = report.rows.find((r) => r.poId === po.id)!
  assert.ok(row, 'the order is on the report')
  assert.equal(row.supplierName, 'GRIR Supplier')
  assert.equal(row.receivedNotBilledBase, '12')
  assert.equal(row.receivedNotBilledQty, '1')
  assert.equal(row.billedNotReceivedBase, '0')
  assert.equal(row.netBase, '12')
})

// [mutation: fold the price difference into the GR/IR debit, or drop the variance row]
test('a price difference goes to its own variance movement and never to the GR/IR balance', async () => {
  const po = await seedPo(10, 12)
  assert.equal((await receive(po, 10)).success, true)
  assert.equal((await bill(po, 10, 13)).success, true)
  const debit = await byType(po.id, 'BILL')
  assert.equal(Number(debit[0]!.baseDelta), -120, 'GR/IR is cleared at the PO value, not the billed 130')
  const variance = await byType(po.id, 'BILL_PRICE_VARIANCE')
  assert.equal(variance.length, 1)
  assert.equal(Number(variance[0]!.baseDelta), 10, 'billed 130 - ordered 120: the bill is dearer')
  assert.equal((await balance(po.id)).toNumber(), 0, 'the variance is outside the balance')
  const { getGrirReport } = await import('@/lib/domain/finance/finance-period-analytics')
  const report = await getGrirReport({ pageSize: 500 }, { deps: { baseCurrency: async () => 'GBP', client: s.db as never } })
  assert.equal(report.rows.some((r) => r.poId === po.id), false, 'a settled order with only a price difference is not an open GR/IR balance')
})

// [mutation: skip recordGrirBillEdit in updateInvoice]
test('an edited bill moves GR/IR by the delta of its goods quantity and its price difference', async () => {
  const { updateInvoice } = await import('@/app/actions/purchase-orders')
  const po = await seedPo(10, 12)
  assert.equal((await receive(po, 10)).success, true)
  assert.equal((await bill(po, 10, 12)).success, true)
  const invoice = await s.db.purchaseInvoice.findFirstOrThrow({ where: { poId: po.id }, select: { id: true, lines: { select: { id: true } } } })
  const edited = await updateInvoice(invoice.id, { invoiceDate: '2026-11-10', invoiceNumber: 'EDITED', lines: [{ id: invoice.lines[0]!.id, qtyBilled: 8, unitCostForeign: 12 }] } as never)
  assert.equal(edited.success, true, String(edited.error))
  assert.equal((await byType(po.id, 'BILL_UPDATE')).length, 1)
  assert.equal((await balance(po.id)).toNumber(), 24, 'billed down from 10 to 8: 2 x 12 is received-not-billed again')
})

// [mutation: delete the recordGrirSupplierReturn call, or write the return as a debit]
test('a supplier return reverses the receipt portion at the PO unit cost', async () => {
  const { returnPurchaseOrder } = await import('@/app/actions/purchase-orders')
  const po = await seedPo(10, 12)
  assert.equal((await receive(po, 10)).success, true)
  const r = await returnPurchaseOrder(po.id, [{ poLineId: po.lineId, qtyReturned: 4, warehouseId }], 'faulty')
  assert.equal(r.success, true, String(r.error))
  const ret = await byType(po.id, 'SUPPLIER_RETURN')
  assert.equal(ret.length, 1)
  assert.equal(Number(ret[0]!.baseDelta), -48)
  assert.equal(Number(ret[0]!.qtyDelta), -4)
  assert.equal((await balance(po.id)).toNumber(), 72, '6 retained x 12, none billed')
})

// [mutation: delete the recordGrirReturnCreditNote call in postSupplierCreditNote]
test('billed goods that are returned leave a billed-not-received debit that the return-generated credit note clears', async () => {
  const { returnPurchaseOrder, postSupplierCreditNote } = await import('@/app/actions/purchase-orders')
  const po = await seedPo(10, 12)
  assert.equal((await receive(po, 10)).success, true)
  assert.equal((await bill(po, 10, 12)).success, true)
  const r = await returnPurchaseOrder(po.id, [{ poLineId: po.lineId, qtyReturned: 4, warehouseId }], 'faulty')
  assert.equal(r.success, true, String(r.error))
  assert.equal((await balance(po.id)).toNumber(), -48, 'billed 10, retained 6: 4 x 12 billed and not received')
  const note = await s.db.supplierCreditNote.findFirstOrThrow({ where: { poId: po.id, isReturnGenerated: true }, select: { id: true } })
  const posted = await postSupplierCreditNote(note.id)
  assert.equal(posted.success, true, String(posted.error))
  const credits = await byType(po.id, 'SUPPLIER_CREDIT_NOTE')
  assert.equal(credits.length, 1)
  assert.equal(credits[0]!.poLineId, po.lineId, 'valued per line, like the return')
  assert.equal((await balance(po.id)).toNumber(), 0, 'the supplier has credited the 4 returned units: the debit is lifted')
  // Posting again claims nothing and writes nothing.
  await postSupplierCreditNote(note.id)
  assert.equal((await byType(po.id, 'SUPPLIER_CREDIT_NOTE')).length, 1)
})

// [mutation: value the credit at the credit's net instead of the PO value, or send the difference to the balance]
test('a returned-and-credited line nets to exactly zero when the bill carried a different price: the difference is a price-difference reversal, not balance', async () => {
  const { returnPurchaseOrder, postSupplierCreditNote } = await import('@/app/actions/purchase-orders')
  const po = await seedPo(10, 12)
  assert.equal((await receive(po, 10)).success, true)
  assert.equal((await bill(po, 10, 13)).success, true)
  assert.equal((await returnPurchaseOrder(po.id, [{ poLineId: po.lineId, qtyReturned: 4, warehouseId }], 'faulty')).success, true)
  assert.equal((await balance(po.id)).toNumber(), -48, 'billed 10 at the PO value, 6 retained')
  const note = await s.db.supplierCreditNote.findFirstOrThrow({ where: { poId: po.id, isReturnGenerated: true }, select: { id: true, amountBase: true } })
  assert.equal((await postSupplierCreditNote(note.id)).success, true)
  const credit = (await byType(po.id, 'SUPPLIER_CREDIT_NOTE'))[0]!
  assert.equal(Number(credit.baseDelta), 48, 'the 4 credited units at the PO value 12, not at the credit net 52')
  assert.equal((await balance(po.id)).toNumber(), 0, 'no false 4 left on GR/IR')
  const ppv = (await byType(po.id, 'BILL_PRICE_VARIANCE')).reduce((t, r) => t + Number(r.baseDelta), 0)
  assert.ok(Math.abs(ppv - 6) < 0.000001, `the premium on the 6 retained units remains (6), got ${ppv}`)
  // A credit with nothing billed-and-returned to clear writes no balance row.
  const po2 = await seedPo(10, 12)
  assert.equal((await receive(po2, 10)).success, true)
  assert.equal((await bill(po2, 6, 12)).success, true)
  assert.equal((await returnPurchaseOrder(po2.id, [{ poLineId: po2.lineId, qtyReturned: 4, warehouseId }], 'faulty')).success, true)
  assert.equal((await balance(po2.id)).toNumber(), 0, 'received 10, returned 4, billed 6: settled with no credit needed')
})

// [mutation: clear the whole returned quantity whatever the credit note covers]
test('a capacity-limited return credit clears only what its net pays for; the rest waits for a later note', async () => {
  const { returnPurchaseOrder } = await import('@/app/actions/purchase-orders')
  const { recordGrirReturnCreditNote } = await import('@/lib/domain/accounting/grir-subledger-movement')
  const po = await seedPo(10, 12)
  assert.equal((await receive(po, 10)).success, true)
  assert.equal((await bill(po, 10, 12)).success, true)
  assert.equal((await returnPurchaseOrder(po.id, [{ poLineId: po.lineId, qtyReturned: 4, warehouseId }], 'faulty')).success, true)
  assert.equal((await balance(po.id)).toNumber(), -48)
  const credit = (id: string, netBase: number) => recordGrirReturnCreditNote(s.db, { poId: po.id, supplierId, creditNoteId: id, netBase, journalDate: '2026-11-17', at: new Date() })
  await credit('cn-a', 24)
  assert.equal((await balance(po.id)).toNumber(), -24, 'a 24 credit pays for 2 of the 4 returned units')
  assert.equal(Number((await byType(po.id, 'SUPPLIER_CREDIT_NOTE'))[0]!.qtyDelta), 2)
  await credit('cn-b', 100)
  assert.equal((await balance(po.id)).toNumber(), 0, 'the later note clears the remaining 2 and no more')
  assert.equal((await byType(po.id, 'SUPPLIER_CREDIT_NOTE')).reduce((t, r) => t + Number(r.qtyDelta), 0), 4, 'never more than the returned quantity')
})

// [mutation: leave posted pre-ledger return credits out of the expected quantity]
test('the opening balance adds back historical return credits: received and billed 10, returned and credited 4, opens +6 not +10 and no false negative', async () => {
  const { planGrirOpeningBalance, applyGrirOpeningBalance } = await import('@/lib/domain/accounting/grir-opening-balance')
  const po = await seedPo(10, 12)
  await s.db.purchaseOrderLine.update({ where: { id: po.lineId }, data: { qtyReceived: '10', qtyReturned: '4' } })
  await s.db.purchaseOrder.update({ where: { id: po.id }, data: { status: 'PARTIALLY_RETURNED' } })
  const invoice = await s.db.purchaseInvoice.create({
    data: {
      poId: po.id, invoiceDate: new Date('2026-10-01'), subtotalForeign: 120, subtotalBase: 120, totalForeign: 120, totalBase: 120, fxRateToBase: 1,
      lines: { create: [{ poLineId: po.lineId, qtyBilled: 10, unitCostForeign: 12, totalForeign: 120, totalBase: 120 }] },
    },
    select: { id: true },
  })
  await s.db.supplierCreditNote.create({
    data: { poId: po.id, purchaseInvoiceId: invoice.id, supplierId, amountForeign: 48, amountBase: 48, currency: 'GBP', fxRateToBase: 1, status: 'POSTED', postedAt: new Date('2026-10-05'), isReturnGenerated: true },
  })
  const plan = await planGrirOpeningBalance(s.db)
  assert.equal(plan.rows.some((r) => r.poId === po.id), false, 'received 10 - returned 4 - billed 10 + credited 4 = 0: nothing to open, and no false -4')
  // A partially credited historical return: only 2 of the 4 credited.
  const po2 = await seedPo(10, 12)
  await s.db.purchaseOrderLine.update({ where: { id: po2.lineId }, data: { qtyReceived: '10', qtyReturned: '4' } })
  await s.db.purchaseOrder.update({ where: { id: po2.id }, data: { status: 'PARTIALLY_RETURNED' } })
  const invoice2 = await s.db.purchaseInvoice.create({
    data: {
      poId: po2.id, invoiceDate: new Date('2026-10-01'), subtotalForeign: 120, subtotalBase: 120, totalForeign: 120, totalBase: 120, fxRateToBase: 1,
      lines: { create: [{ poLineId: po2.lineId, qtyBilled: 10, unitCostForeign: 12, totalForeign: 120, totalBase: 120 }] },
    },
    select: { id: true },
  })
  await s.db.supplierCreditNote.create({
    data: { poId: po2.id, purchaseInvoiceId: invoice2.id, supplierId, amountForeign: 24, amountBase: 24, currency: 'GBP', fxRateToBase: 1, status: 'POSTED', postedAt: new Date('2026-10-05'), isReturnGenerated: true },
  })
  const plan2 = await planGrirOpeningBalance(s.db)
  const row = plan2.rows.find((r) => r.poId === po2.id)!
  assert.equal(row.openQty, '-2', 'billed 10, retained 6, credited 2: 2 still billed-not-received')
  await applyGrirOpeningBalance(plan2, { asOf: '2026-11-17', client: s.db })
  assert.equal((await balance(po2.id)).toNumber(), -24)
  assert.equal((await planGrirOpeningBalance(s.db)).rows.some((r) => r.poId === po2.id), false, 'idempotent')
})

// [mutation: skip tracked credit notes when seeding the credited quantity (the pre-o3d-o35oo behaviour)]
test('the opening balance does not subtract a return credit the sub-ledger already tracks: received 10, billed 10, returned 4 and credited 4 afterwards opens nothing (o3d-o35oo)', async () => {
  const { planGrirOpeningBalance } = await import('@/lib/domain/accounting/grir-opening-balance')
  const po = await seedPo(10, 12)
  await s.db.purchaseOrderLine.update({ where: { id: po.lineId }, data: { qtyReceived: '10', qtyReturned: '4' } })
  await s.db.purchaseOrder.update({ where: { id: po.id }, data: { status: 'PARTIALLY_RETURNED' } })
  const invoice = await s.db.purchaseInvoice.create({
    data: {
      poId: po.id, invoiceDate: new Date('2026-10-01'), subtotalForeign: 120, subtotalBase: 120, totalForeign: 120, totalBase: 120, fxRateToBase: 1,
      lines: { create: [{ poLineId: po.lineId, qtyBilled: 10, unitCostForeign: 12, totalForeign: 120, totalBase: 120 }] },
    },
    select: { id: true },
  })
  const note = await s.db.supplierCreditNote.create({
    data: { poId: po.id, purchaseInvoiceId: invoice.id, supplierId, amountForeign: 48, amountBase: 48, currency: 'GBP', fxRateToBase: 1, status: 'POSTED', postedAt: new Date('2026-11-12'), isReturnGenerated: true },
    select: { id: true },
  })
  // The receipt and the bill predate the sub-ledger; the return and its credit were recorded live (net 0 together).
  const at = new Date('2026-11-12')
  const base = { poId: po.id, poLineId: po.lineId, supplierId, journalDate: at, occurredAt: at }
  await s.db.grirSubledgerMovement.create({ data: { ...base, sourceType: 'SUPPLIER_RETURN', sourceRef: `ret-${po.id}`, idempotencyKey: `t-ret-${po.id}`, qtyDelta: '-4', baseDelta: '-48' } })
  await s.db.grirSubledgerMovement.create({ data: { ...base, sourceType: 'SUPPLIER_CREDIT_NOTE', sourceRef: note.id, idempotencyKey: `t-cn-${po.id}`, qtyDelta: '4', baseDelta: '48' } })
  const plan = await planGrirOpeningBalance(s.db)
  const row = plan.rows.find((r) => r.poId === po.id)
  assert.equal(row, undefined, `expected 10 - 4 - 10 + 4 = 0 against live 0: nothing to open, got ${row?.openQty}`)
})

// [mutation: make the row key random instead of per source event]
test('a replayed source event records exactly once (the unique key is the source event)', async () => {
  const { recordGrirReceipt, recordGrirSupplierReturn } = await import('@/lib/domain/accounting/grir-subledger-movement')
  const po = await seedPo(10, 12)
  const event = { poId: po.id, sourceRef: 'evt-1', keyBase: `replay:${po.id}`, at: new Date(), lines: [{ poLineId: po.lineId, qty: 3 }] }
  await recordGrirReceipt(s.db, event)
  await recordGrirReceipt(s.db, event)
  await s.db.$transaction(async (tx) => { await recordGrirReceipt(tx, event) })
  assert.equal((await byType(po.id, 'RECEIPT')).length, 1)
  assert.equal((await balance(po.id)).toNumber(), 36)
  const ret = { poId: po.id, returnId: 'ret-1', at: new Date(), lines: [{ poLineId: po.lineId, qty: 1 }] }
  await recordGrirSupplierReturn(s.db, ret)
  await recordGrirSupplierReturn(s.db, ret)
  assert.equal((await balance(po.id)).toNumber(), 24)
  // A client-token replay of a whole receipt books it once, and so records it once.
  const po2 = await seedPo(10, 12)
  assert.equal((await receive(po2, 5, { idempotencyToken: 'tok-1' })).success, true)
  assert.equal((await receive(po2, 5, { idempotencyToken: 'tok-1' })).success, true)
  assert.equal((await byType(po2.id, 'RECEIPT')).length, 1)
  assert.equal((await balance(po2.id)).toNumber(), 60)
})

// [mutation: write the receipt row outside the receipt's transaction]
test('a receipt that rolls back leaves no GR/IR row', async () => {
  const po = await seedPo(10, 12)
  const before = await s.db.grirSubledgerMovement.count({ where: { poId: po.id } })
  const over = await receive(po, 11)
  assert.equal(over.success, false, 'over-receipt is refused')
  assert.equal(await s.db.grirSubledgerMovement.count({ where: { poId: po.id } }), before)
})

// [mutation: let the bill read the received quantity without the order lock]
test('a receipt and a bill racing on a prepaid order both commit and the sub-ledger nets to zero with one row each', async () => {
  const po = await seedPo(10, 12, prepaidSupplierId)
  const [received, billed] = await Promise.all([receive(po, 10), bill(po, 10, 12)])
  assert.equal(received.success, true, String(received.error))
  assert.equal(billed.success, true, String(billed.error))
  assert.equal((await byType(po.id, 'RECEIPT')).length, 1)
  assert.equal((await byType(po.id, 'BILL')).length, 1)
  assert.equal((await balance(po.id)).toNumber(), 0)
})

// [mutation: drop the age or the credit column from the report]
test('the report: figures by supplier and order, billed-not-received for a prepaid bill, and the age of the oldest open movement', async () => {
  const po = await seedPo(10, 12, prepaidSupplierId)
  assert.equal((await bill(po, 5, 12)).success, true)
  const old = new Date('2026-10-01T09:00:00Z')
  await s.db.grirSubledgerMovement.updateMany({ where: { poId: po.id }, data: { occurredAt: old } })
  const { getGrirReport } = await import('@/lib/domain/finance/finance-period-analytics')
  const report = await getGrirReport({ pageSize: 500 }, { deps: { baseCurrency: async () => 'GBP', client: s.db as never, now: () => new Date('2026-11-17T12:00:00Z') } })
  const row = report.rows.find((r) => r.poId === po.id)!
  assert.equal(row.supplierName, 'GRIR Prepaid Supplier')
  assert.equal(row.billedNotReceivedBase, '60')
  assert.equal(row.billedNotReceivedQty, '5')
  assert.equal(row.receivedNotBilledBase, '0')
  assert.equal(row.netBase, '-60')
  assert.equal(row.oldestOpenDate, '2026-10-01')
  assert.equal(row.ageDays, 47)
  assert.equal(report.totals.orderCount, String(report.rows.length))
  const sum = (pick: (r: (typeof report.rows)[number]) => string) => report.rows.reduce((t, r) => t + Number(pick(r)), 0)
  assert.equal(Number(report.totals.netBase), sum((r) => r.netBase), 'the total is the sum of the rows')
  const earlier = await getGrirReport({ dateTo: '2026-09-30', pageSize: 500 }, { deps: { baseCurrency: async () => 'GBP', client: s.db as never } })
  assert.equal(earlier.rows.some((r) => r.poId === po.id), false, 'as of before the bill was dated, the order has no balance')
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The Xero daily batch
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

async function setSettings(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) await s.db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
}
const grirLogs = () => s.db.accountingSyncLog.findMany({ where: { type: 'DAILY_BATCH_GRIR_RECLASS' }, select: { id: true, status: true, referenceId: true, payload: true } })
const unconsumed = () => s.db.grirSubledgerMovement.count({ where: { xeroBatchRef: null, sourceType: { not: 'BILL_PRICE_VARIANCE' } } })

// [mutation: read the setting with the wrong default, or stage before checking it]
test('with GR/IR posting OFF (the default) the daily batch posts nothing and stamps nothing, while the sub-ledger keeps accruing', async () => {
  await setSettings({ plugin_xero_enabled: 'true', xero_sync_enabled: 'true', xero_transit_account: '631', xero_grir_account: '632' })
  const { runDailyBatchSync } = await import('@/lib/connectors/xero/daily-sync')
  const po = await seedPo(10, 12)
  assert.equal((await receive(po, 10)).success, true)
  const before = await unconsumed()
  assert.ok(before > 0, 'the sub-ledger accrued')
  const result = await runDailyBatchSync()
  assert.equal(result.errors.length, 0, result.errors.join('; '))
  assert.equal(result.grirReclassJournals, 0)
  assert.equal((await grirLogs()).length, 0, 'no GR/IR journal row of any status')
  assert.equal(await unconsumed(), before, 'no row was consumed')
  assert.equal(await s.db.transitSubledgerMovement.count({ where: { sourceType: 'GRIR_RECLASS' } }), 0)
  assert.equal((await balance(po.id)).toNumber(), 120)
})

// [mutation: post the journal the wrong way round, or skip the transit sub-ledger row, or stamp the rows without staging]
test('with GR/IR posting ON the batch stages one reclass journal per day (Stock in Transit to GR/IR), records its transit movement, consumes the rows once', async () => {
  await setSettings({ grir_xero_posting_enabled: 'true' })
  const { runDailyBatchSync } = await import('@/lib/connectors/xero/daily-sync')
  const pending = await s.db.grirSubledgerMovement.findMany({ where: { xeroBatchRef: null, sourceType: { not: 'BILL_PRICE_VARIANCE' } }, select: { baseDelta: true, journalDate: true } })
  const expected = new Map<string, number>()
  for (const row of pending) {
    const day = row.journalDate.toISOString().slice(0, 10)
    expected.set(day, (expected.get(day) ?? 0) + Number(row.baseDelta))
  }
  const result = await runDailyBatchSync()
  assert.equal(result.errors.length, 0, result.errors.join('; '))
  assert.equal(result.grirReclassJournals, [...expected.values()].filter((v) => Math.abs(v) >= 0.005).length)
  assert.equal(await unconsumed(), 0, 'every row is consumed')
  const logs = await grirLogs()
  assert.equal(logs.length, result.grirReclassJournals)
  for (const log of logs) {
    assert.equal(log.status, 'PENDING')
    const payload = log.payload as { date: string; lines: Array<{ accountCode: string; debit?: number; credit?: number }> }
    const net = Math.round((expected.get(payload.date) ?? NaN) * 100) / 100
    assert.ok(Number.isFinite(net), `a day ${payload.date} that has rows`)
    const transit = payload.lines.find((l) => l.accountCode === '631')!
    const grir = payload.lines.find((l) => l.accountCode === '632')!
    if (net > 0) { assert.equal(transit.debit, net); assert.equal(grir.credit, net) } else { assert.equal(grir.debit, -net); assert.equal(transit.credit, -net) }
    const transitRow = await s.db.transitSubledgerMovement.findUniqueOrThrow({ where: { idempotencyKey: `grir-reclass:${log.referenceId}` } })
    assert.equal(Number(transitRow.baseDelta), net, 'the transit sub-ledger records the transit movement the journal makes')
    assert.equal(transitRow.sourceType, 'GRIR_RECLASS')
  }
  // A second run has nothing to consume: no second journal.
  const again = await runDailyBatchSync()
  assert.equal(again.grirReclassJournals, 0)
  assert.equal((await grirLogs()).length, logs.length)
})

// [mutation: ignore the producer hold for this type, or consume the rows of a shadowed journal]
test('with GR/IR posting ON and the Xero hold enforced, the journal is shadowed: nothing is queued, no transit row, the rows stay unconsumed and post once the hold is lifted', async () => {
  const { runDailyBatchSync } = await import('@/lib/connectors/xero/daily-sync')
  const po = await seedPo(10, 7)
  assert.equal((await receive(po, 10)).success, true)
  const logsBefore = (await grirLogs()).length
  const transitBefore = await s.db.transitSubledgerMovement.count({ where: { sourceType: 'GRIR_RECLASS' } })
  const outboxBefore = await s.db.integrationOutbox.count()
  const pendingRows = await unconsumed()
  assert.ok(pendingRows > 0)
  const saved = process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS
  process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS = 'xero'
  try {
    const result = await runDailyBatchSync()
    assert.equal(result.errors.length, 0, result.errors.join('; '))
    assert.equal(result.grirReclassJournals, 0, 'nothing was queued')
    assert.equal(result.grirReclassShadowed, 1, 'the journal was composed and shadowed')
  } finally {
    if (saved === undefined) delete process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS; else process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS = saved
  }
  const logs = await grirLogs()
  const added = logs.slice(logsBefore)
  assert.equal(added.length, 1, 'one shadow row was recorded')
  assert.equal(logs.filter((l) => l.status === 'PENDING').length, logsBefore, 'no NEW pending journal: it is a shadow, never queued')
  assert.equal(added.every((l) => l.status === 'CANCELLED'), true, 'the shadow row is recorded CANCELLED')
  assert.equal(await s.db.integrationOutbox.count(), outboxBefore, 'no outbox job')
  assert.equal(await s.db.transitSubledgerMovement.count({ where: { sourceType: 'GRIR_RECLASS' } }), transitBefore, 'the ledger did not move, so the transit sub-ledger claims nothing')
  assert.equal(await unconsumed(), pendingRows, 'the shadowed rows are NOT consumed')
  // The hold is lifted: the same rows post.
  const lifted = await runDailyBatchSync()
  assert.equal(lifted.errors.length, 0, lifted.errors.join('; '))
  assert.ok((lifted.grirReclassJournals ?? 0) >= 1, 'the journal is queued now')
  assert.equal(await unconsumed(), 0, 'and its rows are consumed')
  const after = (await grirLogs()).slice(logsBefore)
  assert.equal(after.filter((l) => l.status === 'PENDING').length, lifted.grirReclassJournals)
  assert.ok(await s.db.transitSubledgerMovement.count({ where: { sourceType: 'GRIR_RECLASS' } }) > transitBefore)
})

// [mutation: stage with the GR/IR account unmapped]
test('with posting ON and the GR/IR account unmapped the run reports it and consumes nothing', async () => {
  const { runDailyBatchSync } = await import('@/lib/connectors/xero/daily-sync')
  await setSettings({ xero_grir_account: '' })
  const po = await seedPo(10, 5)
  assert.equal((await receive(po, 10)).success, true)
  const result = await runDailyBatchSync()
  assert.equal(result.grirReclassJournals, 0)
  assert.ok(result.errors.some((e) => /GR\/IR account/.test(e)), result.errors.join('; '))
  assert.ok(await unconsumed() > 0, 'the rows wait for the mapping')
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The stage opening balance
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

// [mutation: write on a dry run, or key the opening row on something that changes between runs]
test('the opening-balance plan lists received-but-unbilled lines with no history, writes nothing on a dry run, and a real run is idempotent', async () => {
  const { planGrirOpeningBalance, applyGrirOpeningBalance } = await import('@/lib/domain/accounting/grir-opening-balance')
  const legacy = await seedPo(10, 12)
  // A line received before the ledger existed: the quantity is on the line, no sub-ledger row was ever written.
  await s.db.purchaseOrderLine.update({ where: { id: legacy.lineId }, data: { qtyReceived: '6' } })
  await s.db.purchaseOrder.update({ where: { id: legacy.id }, data: { status: 'PARTIALLY_RECEIVED' } })
  const live = await seedPo(10, 12)
  assert.equal((await receive(live, 4)).success, true)

  const plan = await planGrirOpeningBalance(s.db)
  const mine = plan.rows.filter((r) => r.poId === legacy.id)
  assert.equal(mine.length, 1)
  assert.equal(mine[0]!.openQty, '6')
  assert.equal(mine[0]!.baseDelta, '72')
  assert.equal(plan.rows.some((r) => r.poId === live.id), false, 'a line that already accrues is left alone')
  assert.ok(plan.alreadyTracked >= 1)

  const beforeCount = await s.db.grirSubledgerMovement.count()
  // DRY RUN: the planner alone writes nothing.
  assert.equal(await s.db.grirSubledgerMovement.count(), beforeCount)

  const written = await applyGrirOpeningBalance(plan, { asOf: '2026-11-17', client: s.db })
  assert.ok(written >= 1)
  const opening = await byType(legacy.id, 'OPENING_BALANCE')
  assert.equal(opening.length, 1)
  assert.equal(Number(opening[0]!.baseDelta), 72)
  assert.equal((await balance(legacy.id)).toNumber(), 72)
  const afterFirst = await s.db.grirSubledgerMovement.count()

  // A second run: the line now has history, so the plan no longer contains it, and an apply of the OLD plan upserts onto the same key.
  const second = await planGrirOpeningBalance(s.db)
  assert.equal(second.rows.some((r) => r.poId === legacy.id), false)
  await applyGrirOpeningBalance(plan, { asOf: '2026-11-17', client: s.db })
  assert.equal(await s.db.grirSubledgerMovement.count(), afterFirst, 'replaying the same plan writes nothing')
  assert.equal((await balance(legacy.id)).toNumber(), 72)
})

// [mutation: skip a line as soon as it has any live row, instead of completing it]
test('the opening-balance plan completes a line with pre-existing history AFTER its first live movement: 10 received before deployment, 5 billed after, opens +10', async () => {
  const { planGrirOpeningBalance, applyGrirOpeningBalance } = await import('@/lib/domain/accounting/grir-opening-balance')
  const po = await seedPo(10, 12)
  await s.db.purchaseOrderLine.update({ where: { id: po.lineId }, data: { qtyReceived: '10' } })
  await s.db.purchaseOrder.update({ where: { id: po.id }, data: { status: 'RECEIVED' } })
  assert.equal((await bill(po, 5, 12)).success, true)
  assert.equal((await balance(po.id)).toNumber(), -60, 'the live ledger alone says billed-not-received')
  const plan = await planGrirOpeningBalance(s.db)
  const row = plan.rows.find((r) => r.poId === po.id)!
  assert.ok(row, 'the line is planned although it already has a live row')
  assert.equal(row.liveQty, '-5')
  assert.equal(row.openQty, '10')
  assert.equal(row.baseDelta, '120')
  await applyGrirOpeningBalance(plan, { asOf: '2026-11-17', client: s.db })
  assert.equal((await balance(po.id)).toNumber(), 60, '(10 received - 5 billed) x 12')
  assert.equal((await planGrirOpeningBalance(s.db)).rows.some((r) => r.poId === po.id), false, 'a second run plans nothing for it')
  const count = await s.db.grirSubledgerMovement.count({ where: { poId: po.id } })
  await applyGrirOpeningBalance(plan, { asOf: '2026-11-17', client: s.db })
  assert.equal(await s.db.grirSubledgerMovement.count({ where: { poId: po.id } }), count, 'replaying the old plan writes nothing')
  // A movement after the opening keeps the line tracked.
  assert.equal((await bill(po, 5, 12)).success, true)
  assert.equal((await planGrirOpeningBalance(s.db)).rows.some((r) => r.poId === po.id), false)
  assert.equal((await balance(po.id)).toNumber(), 0)
})

// [mutation: let the script write without the dry-run flag guard]
test('the script entry point: --dry-run prints the plan and exits without writing', async () => {
  const { runChild } = await import('../../scripts/rehearse-first-install')
  const legacy = await seedPo(10, 3)
  await s.db.purchaseOrderLine.update({ where: { id: legacy.lineId }, data: { qtyReceived: '2' } })
  await s.db.purchaseOrder.update({ where: { id: legacy.id }, data: { status: 'PARTIALLY_RECEIVED' } })
  const before = await s.db.grirSubledgerMovement.count()
  const dry = await runChild({ cmd: `${process.cwd()}/node_modules/.bin/tsx`, args: ['scripts/grir-opening-balance.ts', '--dry-run', '--as-of', '2026-11-17'], env: s.childEnv, cwd: process.cwd(), timeoutMs: 120_000 })
  assert.equal(dry.exitCode, 0, dry.stderr)
  assert.match(dry.stdout, /DRY RUN/)
  assert.match(dry.stdout, new RegExp(legacy.reference))
  assert.equal(await s.db.grirSubledgerMovement.count(), before, 'a dry run writes nothing')
  const real = await runChild({ cmd: `${process.cwd()}/node_modules/.bin/tsx`, args: ['scripts/grir-opening-balance.ts', '--as-of', '2026-11-17'], env: s.childEnv, cwd: process.cwd(), timeoutMs: 120_000 })
  assert.equal(real.exitCode, 0, real.stderr)
  assert.equal((await byType(legacy.id, 'OPENING_BALANCE')).length, 1)
  const again = await runChild({ cmd: `${process.cwd()}/node_modules/.bin/tsx`, args: ['scripts/grir-opening-balance.ts', '--as-of', '2026-11-17'], env: s.childEnv, cwd: process.cwd(), timeoutMs: 120_000 })
  assert.equal(again.exitCode, 0, again.stderr)
  assert.equal((await byType(legacy.id, 'OPENING_BALANCE')).length, 1, 'a second real run opens nothing again')
})
