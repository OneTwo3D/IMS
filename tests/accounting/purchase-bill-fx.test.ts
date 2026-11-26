/**
 * PER-EVENT FX RATES FOR PURCHASING, STEP 3 (the supplier bill), against a real scratch database and the real actions (permission, cache and outbound
 * hooks stubbed). The bill rate, the PPV split, the GR/IR rows and the FX-difference journal are all written in the transaction of the bill, the bill
 * edit, the bill deletion and the receipt, so these arms run the actions and read the tables. Xero is never reached: the prepayment lock is seeded as
 * the step-2 read would store it (with Xero sync off the receipt and the bill read the stored lock and ask nothing), the outbox is read and never
 * drained, and the network is blocked by the harness.
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

let s: Scratch
let productId: string
let supplierId: string
let warehouseId: string
let seq = 0
const CURRENCY = 'QPX'
/** The PO rate (planning only), the table rate on the bill date (2026-11-10), the table rate in force now, and the prepayment (lock) rate. */
const PO_RATE = '1.25'
const BILL_DATE = '2026-11-10'
const BILL_DATE_TABLE_RATE = '1.2'
const NOW_TABLE_RATE = '1.25'
const LOCK_RATE = '1.6'

before(async () => {
  s = await startScratch('ims-purchfx3')
  const { setPurchaseEventFxStepsCompleteForTests } = await import('@/lib/domain/purchasing/purchase-event-fx-settings')
  setPurchaseEventFxStepsCompleteForTests(true)
  productId = (await s.db.product.create({ data: { sku: 'PFX-1', name: 'PFX 1', type: 'SIMPLE' }, select: { id: true } })).id
  supplierId = (await s.db.supplier.create({ data: { name: 'PFX Supplier', currency: CURRENCY, prepaid: true }, select: { id: true } })).id
  warehouseId = (await s.db.warehouse.findFirstOrThrow({ where: { availableForSale: true }, select: { id: true } })).id
  await s.db.currency.upsert({ where: { code: CURRENCY }, create: { code: CURRENCY, name: 'Test currency', symbol: CURRENCY }, update: {} })
  await s.db.fxRate.create({ data: { fromCurrency: 'GBP', toCurrency: CURRENCY, rate: BILL_DATE_TABLE_RATE, fetchedAt: new Date('2026-11-09T12:00:00Z'), source: 'aelia' } })
  await s.db.fxRate.create({ data: { fromCurrency: 'GBP', toCurrency: CURRENCY, rate: NOW_TABLE_RATE, fetchedAt: new Date(Date.now() - 60_000), source: 'aelia' } })
  await setSettings({ purchase_event_fx_rates_enabled: 'true' })
})
after(async () => {
  const { setPurchaseEventFxStepsCompleteForTests } = await import('@/lib/domain/purchasing/purchase-event-fx-settings')
  setPurchaseEventFxStepsCompleteForTests(null)
  await s?.stop()
})

async function setSettings(values: Record<string, string | null>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === null) await s.db.setting.deleteMany({ where: { key } })
    else await s.db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  }
}

type Po = { id: string; lineId: string; reference: string }

/** A sent order in CURRENCY for `qty` units at 12.5 foreign (10 GBP at the PO rate), no tax, no discount. */
async function seedPo(qty: number): Promise<Po> {
  const { createPurchaseOrder } = await import('@/app/actions/purchase-orders')
  const reference = `PFX-PO-${++seq}-${Date.now()}`
  const created = await createPurchaseOrder({
    reference, supplierId, currency: 'GBP', destinationWarehouseId: warehouseId, pricesIncludeVat: false, taxRateValue: 0,
    lines: [{ productId, sku: 'PFX-1', productName: 'PFX 1', qty, unitCostForeign: 10 }],
  } as never)
  assert.equal(created.success, true, String(created.error))
  const po = await s.db.purchaseOrder.findUniqueOrThrow({ where: { reference }, select: { id: true, subtotalBase: true, totalBase: true, lines: { select: { id: true, totalBase: true } } } })
  await s.db.purchaseOrder.update({
    where: { id: po.id },
    data: { status: 'PO_SENT', currency: CURRENCY, fxRateToBase: PO_RATE, subtotalForeign: po.subtotalBase.mul(PO_RATE).toFixed(4), totalForeign: po.totalBase.mul(PO_RATE).toFixed(4) },
  })
  for (const line of po.lines) await s.db.purchaseOrderLine.update({ where: { id: line.id }, data: { unitCostForeign: '12.5', totalForeign: line.totalBase.mul(PO_RATE).toFixed(4) } })
  return { id: po.id, lineId: po.lines[0]!.id, reference }
}

/** The lock the step-2 Xero read stores for a found prepayment. */
async function lockAt(po: Po, rate = LOCK_RATE) {
  await s.db.purchaseOrderFxLock.create({
    data: {
      poId: po.id, source: 'XERO_PREPAYMENT', currency: CURRENCY, rateToBase: rate, xeroPrepaymentId: `pp-${po.id}`, xeroTenantId: 't', xeroContactId: 'c',
      prepaymentDate: new Date('2026-11-08'), prepaymentTotal: '125', prepaymentStatus: 'AUTHORISED', readAt: new Date(),
    },
  })
}

const receive = async (po: Po, qty: number) => {
  const { receivePurchaseOrder } = await import('@/app/actions/purchase-orders')
  return receivePurchaseOrder(po.id, [{ poLineId: po.lineId, qtyReceived: qty, warehouseId }])
}
const bill = async (po: Po, qty: number, unitCost: number) => {
  const { createInvoice } = await import('@/app/actions/purchase-orders')
  return createInvoice(po.id, { invoiceDate: BILL_DATE, invoiceNumber: `SUP-${++seq}`, lines: [{ kind: 'product', poLineId: po.lineId, qtyBilled: qty, unitCostForeign: unitCost }] } as never)
}
const billOf = (po: Po) => s.db.purchaseInvoice.findFirstOrThrow({ where: { poId: po.id }, orderBy: { createdAt: 'desc' }, include: { lines: true } })
const grir = async (po: Po, type: string) => (await s.db.grirSubledgerMovement.findMany({ where: { poId: po.id, sourceType: type } }))
  .reduce((sum, row) => sum + Number(row.baseDelta), 0)
const balance = async (po: Po) => (await import('@/lib/domain/accounting/grir-subledger-movement')).sumGrirBalance('2100-01-01', { poId: po.id, client: s.db })
const close = (actual: number, expected: number, message: string) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: expected ${expected}, got ${actual}`)

async function withXeroPosting<T>(fn: () => Promise<T>): Promise<T> {
  await setSettings({
    plugin_xero_enabled: 'true', xero_sync_enabled: 'true', xero_sync_stock_receipt: 'submitted', xero_transit_account: '631', xero_inventory_account: '630',
    xero_realised_fx_gain_loss_account: '4900', xero_purchase_price_variance_account: '5050',
  })
  try {
    return await fn()
  } finally {
    await setSettings({ xero_sync_enabled: 'false' })
  }
}
/** Run the reconciliation as a later event would (a receipt, an edit), with Xero posting on, and read the FX journals it queued for the order. */
async function reconcileWithPosting(po: Po) {
  const { reconcilePurchaseBillFx } = await import('@/lib/domain/purchasing/purchase-bill-fx')
  return withXeroPosting(async () => {
    const { db } = await import('@/lib/db')
    const result = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${po.id} FOR UPDATE`
      return reconcilePurchaseBillFx(tx, { poId: po.id, connector: 'xero', syncEnabled: true, at: new Date() })
    })
    const logs = await s.db.accountingSyncLog.findMany({ where: { type: 'PURCHASE_FX_VARIANCE', referenceId: po.id }, orderBy: { createdAt: 'asc' }, select: { payload: true } })
    const transit = await s.db.transitSubledgerMovement.findMany({ where: { sourceType: 'PURCHASE_FX_VARIANCE', sourceRef: po.id } })
    return { result, logs, transitNet: transit.reduce((sum, row) => sum + Number(row.baseDelta), 0) }
  })
}

// [mutation: copy po.fxRateToBase onto the bill, or skip markPurchaseFxLockUsedByBill]
test('prepaid, bill at the same rate: the bill is valued at the lock rate, stores it, uses the lock, and leaves no FX difference; GR/IR nets to zero', async () => {
  const po = await seedPo(10)
  await lockAt(po)
  assert.equal((await receive(po, 10)).success, true)
  const b = await bill(po, 10, 12.5)
  assert.equal(b.success, true, String(b.error))
  const row = await billOf(po)
  assert.equal(row.fxRateSource, 'XERO_PREPAYMENT')
  assert.equal(row.fxEventRateToBase?.toString(), LOCK_RATE)
  assert.equal(row.fxRateToBase.toString(), LOCK_RATE, 'resolved per bill, not the PO rate 1.25')
  close(Number(row.subtotalBase), 78.125, 'the bill base at the lock rate')
  close(Number(row.ppvBase), 0, 'no price difference')
  assert.equal(row.lines[0]!.stockUnitForeign?.toString(), '12.5')
  assert.ok((await s.db.purchaseOrderFxLock.findUniqueOrThrow({ where: { poId: po.id } })).firstUsedAt, 'the lock is final once a bill posts at it')
  close(await grir(po, 'BILL'), -78.125, 'GR/IR debited at the accrued receipt value')
  close(await grir(po, 'BILL_FX_VARIANCE'), 0, 'no FX difference')
  close((await balance(po)).toNumber(), 0, 'GR/IR nets to zero')
  const posted = await reconcileWithPosting(po)
  assert.equal(posted.logs.length, 0, 'nothing to clear from transit')
})

// [mutation: value the GR/IR bill at the bill's own stock value instead of the receipts', or post the journal the wrong way round]
test('table-rate receipt, then the prepayment bill: the FX difference goes to GR/IR BILL_FX_VARIANCE and one Realised FX journal clears it from transit, once', async () => {
  const po = await seedPo(10)
  assert.equal((await receive(po, 10)).success, true) // no lock: table rate 1.25 now, goods 100
  const receipt = await s.db.purchaseReceipt.findFirstOrThrow({ where: { poId: po.id } })
  assert.equal(receipt.fxRateSource, 'FX_TABLE')
  await lockAt(po) // the prepayment was recorded after the receipt
  assert.equal((await bill(po, 10, 12.5)).success, true)
  close(await grir(po, 'BILL'), -100, 'GR/IR is cleared at what the receipt credited')
  close(await grir(po, 'BILL_FX_VARIANCE'), 78.125 - 100, 'the bill (78.125 at 1.6) is cheaper in base than the goods were received at (100)')
  close((await balance(po)).toNumber(), 0, 'GR/IR nets to zero')
  const first = await reconcileWithPosting(po)
  assert.equal(first.logs.length, 1, 'one journal')
  const payload = first.logs[0]!.payload as { lines: Array<{ accountCode: string; debit?: number; credit?: number }> }
  const transitLine = payload.lines.find((l) => l.accountCode === '631')
  assert.equal(transitLine?.debit, 21.88, 'transit DEBITED: the receipt credited 100, the bill debited 78.125')
  assert.equal(transitLine?.credit, undefined)
  assert.equal(payload.lines.find((l) => l.accountCode === '4900')?.credit, 21.88, 'realised FX credited (a gain)')
  close(first.transitNet, 21.88, 'the transit sub-ledger records the journal')
  const again = await reconcileWithPosting(po)
  assert.equal(again.logs.length, 1, 'idempotent: a second run posts nothing')
  assert.equal(again.result.journals.length, 0)
})

// [mutation: drop the ppvSplit, or code the variance to transit]
test('a bill dearer, and a bill cheaper, than the order: the stock part stays at the PO cost and the whole difference is the PPV line', async () => {
  const dear = await seedPo(10)
  await lockAt(dear)
  assert.equal((await receive(dear, 10)).success, true)
  assert.equal((await bill(dear, 10, 13.5)).success, true)
  const dearBill = await billOf(dear)
  close(Number(dearBill.ppvBase), 6.25, '10 foreign over the order at 1.6')
  close(await grir(dear, 'BILL_PRICE_VARIANCE'), 6.25, 'GR/IR price variance')
  close(await grir(dear, 'BILL'), -78.125, 'GR/IR cleared at the PO goods value')
  close(await grir(dear, 'BILL_FX_VARIANCE'), 0, 'no FX difference: the price difference is not FX')
  const cheap = await seedPo(10)
  await lockAt(cheap)
  assert.equal((await receive(cheap, 10)).success, true)
  assert.equal((await bill(cheap, 10, 11.5)).success, true)
  close(Number((await billOf(cheap)).ppvBase), -6.25, '10 foreign under the order')
  close((await balance(cheap)).toNumber(), 0, 'GR/IR nets to zero')
})

// [mutation: match the bill to the receipts at one rate instead of per receipt]
test('partial receipts at mixed rates (MED-7): the FX difference is computed per receipt', async () => {
  const po = await seedPo(10)
  assert.equal((await receive(po, 4)).success, true) // table 1.25: 4 x 10 = 40
  await lockAt(po)
  assert.equal((await receive(po, 6)).success, true) // lock 1.6: 6 x 7.8125 = 46.875
  const sources = (await s.db.purchaseReceipt.findMany({ where: { poId: po.id }, orderBy: { createdAt: 'asc' } })).map((r) => r.fxRateSource)
  assert.deepEqual(sources, ['FX_TABLE', 'XERO_PREPAYMENT'])
  assert.equal((await bill(po, 10, 12.5)).success, true)
  close(await grir(po, 'BILL'), -86.875, 'accrued at each receipt\'s own value')
  close(await grir(po, 'BILL_FX_VARIANCE'), 78.125 - 86.875, 'only the table-rate receipt carries a difference')
  const posted = await reconcileWithPosting(po)
  close(posted.transitNet, 8.75, 'transit DEBITED by the difference')
})

// [mutation: skip reconcilePurchaseBillFx in updateInvoice or in the deletion completion]
test('bill edit adjusts, bill deletion (Xero confirmed) reverses: GR/IR rows and the FX journal follow the bill', async () => {
  const { updateInvoice } = await import('@/app/actions/purchase-orders')
  const po = await seedPo(10)
  assert.equal((await receive(po, 10)).success, true) // table 1.25
  await lockAt(po)
  assert.equal((await bill(po, 10, 12.5)).success, true)
  close((await reconcileWithPosting(po)).transitNet, 21.88, 'the first journal')
  const before = await billOf(po)
  const edited = await updateInvoice(before.id, {
    invoiceNumber: before.invoiceNumber, invoiceDate: BILL_DATE, dueDate: null, notes: null, supplierInvoiceUrl: null,
    lines: [{ id: before.lines[0]!.id, qtyBilled: 6, unitCostForeign: 12.5 }],
  } as never)
  assert.equal(edited.success, true, String(edited.error))
  const afterEdit = await billOf(po)
  assert.equal(afterEdit.fxEventRateToBase?.toString(), LOCK_RATE, 'the edit keeps the bill\'s own rate')
  close(await grir(po, 'BILL') + await grir(po, 'BILL_UPDATE'), -60, '6 of the first receipt (10 each)')
  close(await grir(po, 'BILL_FX_VARIANCE'), 46.875 - 60, 'the difference for 6 units')
  close((await reconcileWithPosting(po)).transitNet, 13.13, 'the edit adjusted the journal (13.125 rounded half up)')

  await s.db.purchaseInvoice.update({ where: { id: before.id }, data: { accountingInvoiceId: `XB-${before.id}`, accountingInvoiceConnector: 'xero' } })
  await s.db.accountingDocumentDeletion.create({
    data: {
      kind: 'PURCHASE_INVOICE', referenceType: 'PurchaseInvoice', referenceId: before.id, documentId: before.id, externalDocumentId: `XB-${before.id}`,
      originalNumber: before.invoiceNumber ?? '', releasedNumber: `${before.invoiceNumber}-released`, targetStatus: 'VOIDED', snapshot: { purchaseOrderId: po.id },
    },
  })
  const { completeAccountingDocumentDeletion } = await import('@/lib/domain/accounting/document-delete-service')
  await withXeroPosting(async () => assert.equal(await completeAccountingDocumentDeletion(`XB-${before.id}`), 'completed'))
  assert.equal(await s.db.purchaseInvoice.count({ where: { poId: po.id } }), 0)
  close(await grir(po, 'BILL') + await grir(po, 'BILL_UPDATE'), 0, 'the deleted bill\'s GR/IR debit is gone')
  close(await grir(po, 'BILL_FX_VARIANCE'), 0, 'and its FX difference')
  close((await balance(po)).toNumber(), 100, 'the receipt is open again: received, not billed')
  const transit = await s.db.transitSubledgerMovement.findMany({ where: { sourceType: 'PURCHASE_FX_VARIANCE', sourceRef: po.id } })
  close(transit.reduce((sum, row) => sum + Number(row.baseDelta), 0), 0, 'the FX journals are reversed in full')
})

// [mutation: let a later receipt not reconcile the bill]
test('a bill before the goods (prepaid supplier), table rate on both dates: the receipt that arrives later posts the difference', async () => {
  const po = await seedPo(10)
  assert.equal((await bill(po, 10, 12.5)).success, true) // no lock: table rate on the bill date 1.2 -> 104.1667
  const row = await billOf(po)
  assert.equal(row.fxRateSource, 'FX_TABLE')
  assert.equal(row.fxEventRateToBase?.toString(), BILL_DATE_TABLE_RATE)
  close(await grir(po, 'BILL_FX_VARIANCE'), 0, 'nothing received yet: no difference')
  await withXeroPosting(async () => {
    await setSettings({ xero_sync_enabled: 'false' })
    assert.equal((await receive(po, 10)).success, true) // table 1.25 now: 100
  })
  close(await grir(po, 'BILL') + await grir(po, 'BILL_UPDATE'), -100, 'the bill is re-accrued at the receipt value')
  close(await grir(po, 'BILL_FX_VARIANCE'), 125 / 1.2 - 100, 'the bill is dearer in base than the goods')
  close((await balance(po)).toNumber(), 0, 'GR/IR nets to zero')
})

// [mutation: drop the interlock from isPurchaseEventFxEnabled, or write the per-event columns with the switch off]
test('switch OFF (or the interlock not complete): the bill is exactly as before - the PO rate, no PPV split, the standard GR/IR rows', async () => {
  const { setPurchaseEventFxStepsCompleteForTests } = await import('@/lib/domain/purchasing/purchase-event-fx-settings')
  for (const how of ['switch off', 'interlock'] as const) {
    if (how === 'switch off') await setSettings({ purchase_event_fx_rates_enabled: 'false' })
    else setPurchaseEventFxStepsCompleteForTests(null)
    try {
      const po = await seedPo(10)
      await lockAt(po)
      assert.equal((await receive(po, 10)).success, true)
      assert.equal((await bill(po, 10, 13.5)).success, true)
      const row = await billOf(po)
      assert.equal(row.fxRateSource, null, how)
      assert.equal(row.fxEventRateToBase, null, how)
      assert.equal(row.ppvBase, null, how)
      assert.equal(row.fxRateToBase.toString(), PO_RATE, `${how}: the PO rate`)
      assert.equal(row.lines[0]!.stockUnitForeign, null, how)
      const keys = (await s.db.grirSubledgerMovement.findMany({ where: { poId: po.id, sourceType: { in: ['BILL', 'BILL_PRICE_VARIANCE'] } } })).map((r) => r.idempotencyKey).sort()
      assert.deepEqual(keys, [`grir:bill-ppv:${row.id}:${po.lineId}`, `grir:bill:${row.id}:${po.lineId}`], `${how}: the standard writer`)
      assert.equal((await s.db.purchaseReceipt.findFirstOrThrow({ where: { poId: po.id } })).fxRateSource, null, `${how}: the receipt at the PO rate`)
      assert.equal((await s.db.purchaseOrderFxLock.findUniqueOrThrow({ where: { poId: po.id } })).firstUsedAt, null, `${how}: the lock untouched`)
    } finally {
      await setSettings({ purchase_event_fx_rates_enabled: 'true' })
      setPurchaseEventFxStepsCompleteForTests(true)
    }
  }
})
