/**
 * PER-EVENT FX RATES FOR PURCHASING, STEP 3b (returns, supplier credit notes and the review follow-ups), against a real scratch database and the real
 * actions (permission, cache and outbound hooks stubbed), in the harness of tests/accounting/purchase-bill-fx.test.ts. Xero is never reached: bills and
 * credits are recorded with Xero sync off, the PURCHASE_BILL transit row a queued bill writes is seeded where an FX journal must be owed, and the
 * outbox is read and never drained.
 *
 * Every arm names the mutation that turns it red.
 */
import assert from 'node:assert/strict'
import { Prisma } from '@/app/generated/prisma/client'
import test, { after, before, mock } from 'node:test'
import { startScratch, type Scratch } from '../first-load/apply-scratch'

// The Xero prepayment read answers "no prepayment" (the network is never reached); only the table-rate warning arm turns Xero sync on for a bill.
mock.module('@/lib/connectors/xero/prepayments', {
  namedExports: {
    XERO_PREPAYMENTS_PAGE_SIZE: 100,
    XERO_PREPAYMENT_READ_TIMEOUT_MS: 20_000,
    readXeroSupplierPrepaymentsByReference: async () => ({ ok: true, tenantId: 'tenant-pfr', prepayments: [] }),
  },
})
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
const CURRENCY = 'QPR'
/** A currency the exchange-rate table has no row for. */
const NO_RATE_CURRENCY = 'QPN'
const PO_RATE = '1.25'
const BILL_DATE = '2026-11-10'
const BILL_DATE_TABLE_RATE = '1.2'
/** The table rate in force now: a receipt with no lock, and a credit with no bill posted today. */
const NOW_TABLE_RATE = '1.25'
const LOCK_RATE = '1.6'

before(async () => {
  s = await startScratch('ims-purchfx3b')
  const { setPurchaseEventFxStepsCompleteForTests } = await import('@/lib/domain/purchasing/purchase-event-fx-settings')
  setPurchaseEventFxStepsCompleteForTests(true)
  productId = (await s.db.product.create({ data: { sku: 'PFR-1', name: 'PFR 1', type: 'SIMPLE' }, select: { id: true } })).id
  supplierId = (await s.db.supplier.create({ data: { name: 'PFR Supplier', currency: CURRENCY, prepaid: true }, select: { id: true } })).id
  warehouseId = (await s.db.warehouse.findFirstOrThrow({ where: { availableForSale: true }, select: { id: true } })).id
  for (const code of [CURRENCY, NO_RATE_CURRENCY]) {
    await s.db.currency.upsert({ where: { code }, create: { code, name: `Test ${code}`, symbol: code }, update: {} })
  }
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

/** A sent order in `currency` for `qty` units at 12.5 foreign (10 GBP at the PO rate), no tax, no discount. */
async function seedPo(qty: number, currency = CURRENCY): Promise<Po> {
  const { createPurchaseOrder } = await import('@/app/actions/purchase-orders')
  const reference = `PFR-PO-${++seq}-${Date.now()}`
  const created = await createPurchaseOrder({
    reference, supplierId, currency: 'GBP', destinationWarehouseId: warehouseId, pricesIncludeVat: false, taxRateValue: 0,
    lines: [{ productId, sku: 'PFR-1', productName: 'PFR 1', qty, unitCostForeign: 10 }],
  } as never)
  assert.equal(created.success, true, String(created.error))
  const po = await s.db.purchaseOrder.findUniqueOrThrow({ where: { reference }, select: { id: true, subtotalBase: true, totalBase: true, lines: { select: { id: true, totalBase: true } } } })
  await s.db.purchaseOrder.update({
    where: { id: po.id },
    data: { status: 'PO_SENT', currency, fxRateToBase: PO_RATE, subtotalForeign: po.subtotalBase.mul(PO_RATE).toFixed(4), totalForeign: po.totalBase.mul(PO_RATE).toFixed(4) },
  })
  for (const line of po.lines) await s.db.purchaseOrderLine.update({ where: { id: line.id }, data: { unitCostForeign: '12.5', totalForeign: line.totalBase.mul(PO_RATE).toFixed(4) } })
  return { id: po.id, lineId: po.lines[0]!.id, reference }
}

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
  return createInvoice(po.id, { invoiceDate: BILL_DATE, invoiceNumber: `SUP-R-${++seq}`, lines: [{ kind: 'product', poLineId: po.lineId, qtyBilled: qty, unitCostForeign: unitCost }] } as never)
}
const returnGoods = async (po: Po, qty: number) => {
  const { returnPurchaseOrder } = await import('@/app/actions/purchase-orders')
  return returnPurchaseOrder(po.id, [{ poLineId: po.lineId, qtyReturned: qty, warehouseId }], 'damaged')
}
const billOf = (po: Po) => s.db.purchaseInvoice.findFirstOrThrow({ where: { poId: po.id }, orderBy: { createdAt: 'desc' }, include: { lines: true } })
const grir = async (po: Po, type: string) => (await s.db.grirSubledgerMovement.findMany({ where: { poId: po.id, sourceType: type } }))
  .reduce((sum, row) => sum + Number(row.baseDelta), 0)
const balance = async (po: Po) => (await import('@/lib/domain/accounting/grir-subledger-movement')).sumGrirBalance('2100-01-01', { poId: po.id, client: s.db })
const close = (actual: number, expected: number, message: string) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: expected ${expected}, got ${actual}`)

const XERO_POSTING = {
  plugin_xero_enabled: 'true', xero_sync_enabled: 'true', xero_sync_stock_receipt: 'submitted', xero_transit_account: '631', xero_inventory_account: '630',
  xero_realised_fx_gain_loss_account: '4900', xero_purchase_price_variance_account: '5050',
}
async function withXeroPosting<T>(fn: () => Promise<T>): Promise<T> {
  await setSettings(XERO_POSTING)
  try {
    return await fn()
  } finally {
    await setSettings({ xero_sync_enabled: 'false' })
  }
}
async function markBillsPosted(po: Po) {
  for (const row of await s.db.purchaseInvoice.findMany({ where: { poId: po.id }, select: { id: true, subtotalBase: true, ppvBase: true, invoiceDate: true } })) {
    const key = `purchase-invoice:${row.id}:test`
    await s.db.transitSubledgerMovement.upsert({
      where: { idempotencyKey: key }, update: {},
      create: { sourceType: 'PURCHASE_BILL', sourceRef: po.id, idempotencyKey: key, baseDelta: row.subtotalBase.sub(row.ppvBase ?? 0), journalDate: row.invoiceDate },
    })
  }
}
async function reconcileWithPosting(po: Po) {
  const { reconcilePurchaseBillFx } = await import('@/lib/domain/purchasing/purchase-bill-fx')
  await markBillsPosted(po)
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
const postCredit = async (id: string) => (await import('@/app/actions/purchase-orders')).postSupplierCreditNote(id)

// [mutation: value the GR/IR return at the PO goods cost, leave returns out of the matching, or take the credit at the bill's 8dp / the PO rate]
test('return then credit note: GR/IR takes back the consumed layers\' goods cost, the bill is re-matched, the credit reverses the bill at its rate; GR/IR and transit net to zero', async () => {
  const po = await seedPo(10)
  assert.equal((await receive(po, 10)).success, true) // no lock: table 1.25, goods 10 each = 100
  await lockAt(po)
  assert.equal((await bill(po, 10, 12.5)).success, true) // at the lock 1.6: stock 78.125
  close(await grir(po, 'BILL_FX_VARIANCE'), 78.125 - 100, 'before the return: the whole receipt matched')
  const returned = await returnGoods(po, 2)
  assert.equal(returned.success, true, String(returned.error))
  close(await grir(po, 'SUPPLIER_RETURN'), -20, 'GR/IR takes back what the consumed layers\' receipt credited (10 a unit)')
  close(await grir(po, 'BILL_FX_VARIANCE'), 78.125 - (80 + 15.625), 'after the return: 8 matched at 10, 2 unreceived at the bill\'s own 7.8125')
  const credit = await s.db.supplierCreditNote.findFirstOrThrow({ where: { poId: po.id } })
  assert.equal(credit.isReturnGenerated, true)
  assert.equal(credit.fxRateSource, 'BILL')
  assert.equal(credit.fxEventRateToBase?.toString(), LOCK_RATE, 'the bill\'s exact rate')
  close(Number(credit.amountForeign), 25, '2 x 12.5')
  close(Number(credit.amountBase), 15.625, 'at the bill\'s rate')
  const posted = await postCredit(credit.id)
  assert.equal(posted.success, true, String(posted.error))
  close(await grir(po, 'SUPPLIER_CREDIT_NOTE'), 15.625, 'the credit clears GR/IR at the bill\'s stock value per unit')
  close((await balance(po)).toNumber(), 0, 'GR/IR nets to zero')
  const journal = await reconcileWithPosting(po)
  close(journal.transitNet, 17.5, 'transit: receipt -100, bill +78.125, return +20, credit -15.625 = -17.5; the journal clears it')
})

// [mutation: value the GR/IR return at the PO goods cost instead of the consumed layers' goods cost]
test('return of goods valued at the lock: GR/IR takes back the layers\' own goods cost, not the PO cost', async () => {
  const po = await seedPo(10)
  await lockAt(po)
  assert.equal((await receive(po, 10)).success, true) // at the lock: 7.8125 each = 78.125
  assert.equal((await returnGoods(po, 2)).success, true)
  close(await grir(po, 'SUPPLIER_RETURN'), -15.625, '2 x 7.8125 (the PO cost would be 2 x 10)')
  assert.equal((await bill(po, 8, 12.5)).success, true) // at the lock: 62.5
  close(await grir(po, 'BILL_FX_VARIANCE'), 0, 'same rate: no difference')
  close((await balance(po)).toNumber(), 0, 'GR/IR nets to zero')
})

// [mutation: let a return before the bill leave its quantity in the lots, or take it from the wrong receipt]
test('return before the bill, mixed rates: the return takes back the receipt it consumed, and the bill matches what is left', async () => {
  const po = await seedPo(10)
  assert.equal((await receive(po, 4)).success, true) // table 1.25: 4 x 10 = 40
  await lockAt(po)
  assert.equal((await receive(po, 6)).success, true) // lock 1.6: 6 x 7.8125 = 46.875
  assert.equal((await returnGoods(po, 2)).success, true) // FIFO: 2 of the table-rate layer
  close(await grir(po, 'SUPPLIER_RETURN'), -20, 'the consumed (table-rate) layer\'s goods cost')
  assert.equal(await s.db.supplierCreditNote.count({ where: { poId: po.id } }), 0, 'nothing billed yet: no credit')
  assert.equal((await bill(po, 8, 12.5)).success, true) // at the lock: 62.5
  close(await grir(po, 'BILL_FX_VARIANCE'), 62.5 - (20 + 46.875), '2 table-rate units left and the 6 lock-rate ones (the first 8 receipts would give -8.75)')
  close((await balance(po)).toNumber(), 0, 'GR/IR nets to zero')
  const journal = await reconcileWithPosting(po)
  close(journal.transitNet, 4.38, 'transit: -40 - 46.875 + 20 + 62.5 = -4.375, cleared (rounded half up)')
})

// [mutation: post a credit with no bill at the PO rate, or at its 8dp record-time rate, or post it with no rate]
test('a credit with no bill is valued at the exchange-rate table rate on its own (posting) date; with no rate it is refused and stays a draft', async () => {
  const po = await seedPo(10)
  assert.equal((await receive(po, 10)).success, true)
  const { resolveNoBillCreditFxRate } = await import('@/lib/domain/purchasing/purchase-bill-fx')
  const resolved = await resolveNoBillCreditFxRate(s.db as never, { poId: po.id, creditDate: BILL_DATE })
  assert.equal(resolved?.rateToBase.toString(), BILL_DATE_TABLE_RATE, 'the rate in force at the end of its date')
  const draft = await s.db.supplierCreditNote.create({
    data: { poId: po.id, supplierId, reference: po.reference, amountForeign: '25', amountBase: '20', currency: CURRENCY, fxRateToBase: '1.11', status: 'DRAFT' },
  })
  const posted = await postCredit(draft.id)
  assert.equal(posted.success, true, String(posted.error))
  const after = await s.db.supplierCreditNote.findUniqueOrThrow({ where: { id: draft.id } })
  assert.equal(after.status, 'POSTED')
  assert.equal(after.fxRateSource, 'FX_TABLE')
  assert.equal(after.fxEventRateToBase?.toString(), NOW_TABLE_RATE, 'the table rate on the day it is posted, not the 1.11 it was drafted at')
  close(Number(after.amountBase), 20, '25 at 1.25')

  // #1157 MED-3: an order the switch never touched keeps today's rule (the stored rate), even with the switch on.
  const untouched = await seedPo(5)
  const plain = await s.db.supplierCreditNote.create({
    data: { poId: untouched.id, supplierId, reference: untouched.reference, amountForeign: '25', amountBase: '22.5225', currency: CURRENCY, fxRateToBase: '1.11', status: 'DRAFT' },
  })
  assert.equal((await postCredit(plain.id)).success, true)
  const plainAfter = await s.db.supplierCreditNote.findUniqueOrThrow({ where: { id: plain.id } })
  assert.equal(plainAfter.fxRateSource, null, 'never touched: no table rate')
  assert.equal(plainAfter.fxRateToBase.toString(), '1.11')

  const noRate = await seedPo(5, NO_RATE_CURRENCY)
  // An order the switch has touched (here: a journal it settled as a shadow).
  await s.db.purchaseFxVarianceShadow.create({ data: { poId: noRate.id, invoiceId: 'gone', idempotencyKey: `purchase-fx-variance:gone:${noRate.id}`, baseDelta: '0', journalDate: BILL_DATE } })
  const stuck = await s.db.supplierCreditNote.create({
    data: { poId: noRate.id, supplierId, reference: noRate.reference, amountForeign: '10', amountBase: '8', currency: NO_RATE_CURRENCY, fxRateToBase: '1.25', status: 'DRAFT' },
  })
  const refused = await postCredit(stuck.id)
  assert.equal(refused.success, false)
  assert.match(refused.error ?? '', /no QPN exchange rate/)
  assert.equal((await s.db.supplierCreditNote.findUniqueOrThrow({ where: { id: stuck.id } })).status, 'DRAFT', 'nothing claimed')
})

// [mutation: forget to count the shadow marker in the target state (MED-2)]
test('MED-2: a journal settled as a shadow is not caught up later', async () => {
  const po = await seedPo(10)
  assert.equal((await receive(po, 10)).success, true)
  await lockAt(po)
  assert.equal((await bill(po, 10, 12.5)).success, true)
  const row = await billOf(po)
  // What the reconciliation records when the producer-side hold answers "shadowed": the difference, settled without a ledger posting.
  await s.db.purchaseFxVarianceShadow.create({ data: { poId: po.id, invoiceId: row.id, idempotencyKey: `purchase-fx-variance:${row.id}:shadow-test`, baseDelta: '21.88', journalDate: '2026-11-10' } })
  const later = await reconcileWithPosting(po)
  assert.equal(later.logs.length, 0, 'no live catch-up of a shadowed difference')
  assert.equal(later.result.journals.length, 0)
  const { purchaseFxOrdersToReconcile } = await import('@/lib/domain/purchasing/purchase-bill-fx')
  assert.ok((await purchaseFxOrdersToReconcile(s.db as never)).includes(po.id))
})

// [mutation: gate the receipt's reconciliation on the switch-on valuation only (MED-3)]
test('MED-3: after a switch-off rollback, a receipt of an order with a bill valued under the switch still reconciles', async () => {
  const po = await seedPo(10)
  assert.equal((await bill(po, 10, 12.5)).success, true) // table 1.2 on the bill date: 104.1667
  assert.equal((await billOf(po)).fxRateSource, 'FX_TABLE')
  await setSettings({ purchase_event_fx_rates_enabled: 'false' })
  try {
    assert.equal((await receive(po, 10)).success, true) // switch off: at the PO rate, 100
  } finally {
    await setSettings({ purchase_event_fx_rates_enabled: 'true' })
  }
  assert.equal((await s.db.purchaseReceipt.findFirstOrThrow({ where: { poId: po.id } })).fxRateSource, null, 'the receipt itself is at the PO rate')
  close(await grir(po, 'BILL') + await grir(po, 'BILL_UPDATE'), -100, 'the bill is re-accrued at the receipt value')
  close(await grir(po, 'BILL_FX_VARIANCE'), 125 / 1.2 - 100, 'and its FX difference is recorded')
  close((await balance(po)).toNumber(), 0, 'GR/IR nets to zero')
})

// [mutation: let --po run the writer on an order the switch never touched (MED-A)]
test('MED-A: the re-run refuses an order the switch never touched', async () => {
  const { setPurchaseEventFxStepsCompleteForTests } = await import('@/lib/domain/purchasing/purchase-event-fx-settings')
  const { rerunPurchaseBillFx, PurchaseFxNotReconcilableError } = await import('@/lib/domain/purchasing/purchase-bill-fx')
  const po = await seedPo(10)
  setPurchaseEventFxStepsCompleteForTests(false)
  try {
    assert.equal((await receive(po, 10)).success, true)
    assert.equal((await bill(po, 10, 12.5)).success, true)
  } finally {
    setPurchaseEventFxStepsCompleteForTests(true)
  }
  await assert.rejects(rerunPurchaseBillFx(po.id), PurchaseFxNotReconcilableError)
  await assert.rejects(rerunPurchaseBillFx(po.id, { dryRun: true }), PurchaseFxNotReconcilableError)
})

// [mutation: value a PO-rate bill from the order's current cost instead of its own GR/IR rows (MED-B)]
test('MED-B: a bill from before the switch is valued at what it debited GR/IR with, even after the order\'s cost is edited', async () => {
  const { setPurchaseEventFxStepsCompleteForTests } = await import('@/lib/domain/purchasing/purchase-event-fx-settings')
  const po = await seedPo(10)
  setPurchaseEventFxStepsCompleteForTests(false)
  try {
    assert.equal((await bill(po, 10, 12.5)).success, true) // PO rate: 100, GR/IR -100
  } finally {
    setPurchaseEventFxStepsCompleteForTests(true)
  }
  close(await grir(po, 'BILL'), -100, 'the PO-rate bill\'s own GR/IR row')
  await s.db.purchaseOrderLine.update({ where: { id: po.lineId }, data: { unitCostBase: '11' } }) // the order's cost edited since
  await lockAt(po)
  assert.equal((await receive(po, 10)).success, true) // at the lock: 78.125
  close(await grir(po, 'BILL_FX_VARIANCE'), 100 - 78.125, 'measured against the bill\'s own 100, not the edited 110')
  close((await balance(po)).toNumber(), 0, 'GR/IR nets to zero')
})

// [mutation: leave positive OPENING_BALANCE rows out of the lots (MED-7)]
test('MED-7: goods received before the sub-ledger (a positive opening balance) are received lots for the bill', async () => {
  const po = await seedPo(10)
  await s.db.grirSubledgerMovement.create({
    data: {
      sourceType: 'OPENING_BALANCE', sourceRef: 'opening', idempotencyKey: `grir:opening:${po.id}:${po.lineId}`, poId: po.id, poLineId: po.lineId, supplierId,
      qtyDelta: '10', baseDelta: '100', journalDate: new Date('2026-11-01T00:00:00Z'), occurredAt: new Date('2026-11-01T00:00:00Z'),
    },
  })
  await lockAt(po)
  assert.equal((await bill(po, 10, 12.5)).success, true)
  close(await grir(po, 'BILL'), -100, 'cleared at the opening balance\'s value')
  close(await grir(po, 'BILL_FX_VARIANCE'), 78.125 - 100, 'the difference against it')
  close((await balance(po)).toNumber(), 0, 'GR/IR nets to zero')
  const { listPurchaseFxInFlightOrders } = await import('@/lib/domain/purchasing/purchase-bill-fx')
  assert.ok(!(await listPurchaseFxInFlightOrders(s.db as never)).some((o) => o.poId === po.id), 'not in flight: the opening balance counts as received')
})

// [mutation: let the dry run queue, or compute nothing]
test('dry run: the re-run computes what --apply would queue inside a rolled-back transaction, and writes nothing', async () => {
  const { rerunPurchaseBillFx } = await import('@/lib/domain/purchasing/purchase-bill-fx')
  const po = await seedPo(10)
  assert.equal((await receive(po, 10)).success, true)
  await lockAt(po)
  assert.equal((await bill(po, 10, 12.5)).success, true)
  await markBillsPosted(po)
  const gririBefore = await s.db.grirSubledgerMovement.count({ where: { poId: po.id } })
  const dry = await withXeroPosting(() => rerunPurchaseBillFx(po.id, { dryRun: true }))
  assert.equal(dry.journals.length, 1)
  assert.equal(dry.journals[0]!.transitDelta, '21.88')
  assert.equal(dry.journals[0]!.invoiceNumber, (await billOf(po)).invoiceNumber, 'named by number')
  assert.equal(await s.db.accountingSyncLog.count({ where: { type: 'PURCHASE_FX_VARIANCE', referenceId: po.id } }), 0, 'nothing queued')
  assert.equal(await s.db.grirSubledgerMovement.count({ where: { poId: po.id } }), gririBefore, 'nothing written')
  const applied = await withXeroPosting(() => rerunPurchaseBillFx(po.id))
  assert.equal(applied.journals.length, 1, '--apply queues the same')
})

// [mutation: leave returns, opening balances or the not-posted-by-IMS flag out of the turn-on check]
test('--in-flight: returns count against received, and a bill IMS did not post is flagged "no journal"', async () => {
  const { setPurchaseEventFxStepsCompleteForTests } = await import('@/lib/domain/purchasing/purchase-event-fx-settings')
  const { listPurchaseFxInFlightOrders } = await import('@/lib/domain/purchasing/purchase-bill-fx')
  const po = await seedPo(10)
  setPurchaseEventFxStepsCompleteForTests(false)
  try {
    assert.equal((await receive(po, 10)).success, true)
    assert.equal((await bill(po, 10, 12.5)).success, true)
    assert.equal((await returnGoods(po, 3)).success, true)
  } finally {
    setPurchaseEventFxStepsCompleteForTests(true)
  }
  const listed = (await listPurchaseFxInFlightOrders(s.db as never)).find((o) => o.poId === po.id)
  assert.ok(listed, 'billed 10, received 10 - 3 returned = 7: in flight')
  assert.equal(listed.lines[0]!.receivedQty, '7')
  const row = await billOf(po)
  assert.deepEqual(listed.billsNotPostedByIms, [{ invoiceId: row.id, invoiceNumber: row.invoiceNumber }], 'no PURCHASE_BILL transit row: not posted by IMS')
  await markBillsPosted(po)
  const again = (await listPurchaseFxInFlightOrders(s.db as never)).find((o) => o.poId === po.id)
  assert.deepEqual(again?.billsNotPostedByIms, [], 'posted by IMS: no flag')
})

// [mutation: let a PurchaseFxRefusalError escape completeAccountingDocumentDeletion]
test('a refused FX journal does not hold a confirmed bill deletion (it would retry for ever)', async () => {
  const po = await seedPo(10)
  assert.equal((await receive(po, 10)).success, true)
  await lockAt(po)
  assert.equal((await bill(po, 10, 12.5)).success, true)
  close((await reconcileWithPosting(po)).transitNet, 21.88, 'the journal is in transit')
  const row = await billOf(po)
  await s.db.purchaseInvoice.update({ where: { id: row.id }, data: { accountingInvoiceId: `XB-${row.id}`, accountingInvoiceConnector: 'xero' } })
  await s.db.accountingDocumentDeletion.create({
    data: {
      kind: 'PURCHASE_INVOICE', referenceType: 'PurchaseInvoice', referenceId: row.id, documentId: row.id, externalDocumentId: `XB-${row.id}`,
      originalNumber: row.invoiceNumber ?? '', releasedNumber: `${row.invoiceNumber}-released`, targetStatus: 'VOIDED', snapshot: { purchaseOrderId: po.id },
    },
  })
  const { completeAccountingDocumentDeletion } = await import('@/lib/domain/accounting/document-delete-service')
  await withXeroPosting(async () => {
    await setSettings({ xero_realised_fx_gain_loss_account: null })
    try {
      assert.equal(await completeAccountingDocumentDeletion(`XB-${row.id}`), 'completed')
    } finally {
      await setSettings({ xero_realised_fx_gain_loss_account: '4900' })
    }
  })
  assert.equal(await s.db.purchaseInvoice.count({ where: { poId: po.id } }), 0, 'the bill is gone')
  const deletion = await s.db.accountingDocumentDeletion.findFirstOrThrow({ where: { externalDocumentId: `XB-${row.id}` } })
  assert.equal(deletion.state, 'COMPLETED')
  assert.match(JSON.stringify(deletion.snapshot), /purchaseFxJournalRefused/)
  assert.equal(await s.db.activityLog.count({ where: { action: 'purchase_fx_variance_refused_on_bill_delete', entityId: po.id } }), 1)
  // Once the mapping is back, the re-run reverses the journal that is no longer owed.
  const { rerunPurchaseBillFx } = await import('@/lib/domain/purchasing/purchase-bill-fx')
  const reversed = await withXeroPosting(() => rerunPurchaseBillFx(po.id))
  assert.equal(reversed.journals.length, 1)
  assert.equal(reversed.journals[0]!.transitDelta, '-21.88')
})

// [mutation: drop the table-rate bill warning]
test('a bill valued at the table rate while Xero sync is on is saved with a warning and an activity entry; with sync off there is none', async () => {
  const quiet = await seedPo(10)
  const offResult = await bill(quiet, 10, 12.5)
  assert.equal(offResult.success, true)
  assert.equal((offResult as { warning?: string }).warning, undefined, 'sync off: no Xero prepayment is expected, no warning')
  const noVat = await s.db.taxRate.findFirstOrThrow({ where: { accountingTaxType: 'NONE' }, select: { id: true } })
  await s.db.supplier.update({ where: { id: supplierId }, data: { taxRateId: noVat.id, accountingContactId: 'c-pfr', accountingContactProvenance: 'xero:tenant-pfr' } })
  const po = await seedPo(10)
  const result = await withXeroPosting(() => bill(po, 10, 12.5))
  assert.equal(result.success, true, String(result.error))
  assert.match((result as { warning?: string }).warning ?? '', /exchange-rate table rate 1\.2 on 2026-11-10/)
  assert.equal(await s.db.activityLog.count({ where: { action: 'purchase_bill_fx_table_rate', entityId: po.id } }), 1)
})

// [mutation: date the journal raised by the bill's own create or edit on today instead of the bill date]
test('the FX journal raised by the bill\'s own create or edit is dated on the bill date; any other event\'s on its own date', async () => {
  const { reconcilePurchaseBillFx } = await import('@/lib/domain/purchasing/purchase-bill-fx')
  const po = await seedPo(10)
  assert.equal((await receive(po, 10)).success, true)
  await lockAt(po)
  assert.equal((await bill(po, 10, 12.5)).success, true)
  await markBillsPosted(po)
  const row = await billOf(po)
  const at = new Date('2026-11-27T12:00:00Z')
  await withXeroPosting(async () => {
    const { db } = await import('@/lib/db')
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${po.id} FOR UPDATE`
      return reconcilePurchaseBillFx(tx, { poId: po.id, connector: 'xero', syncEnabled: true, at, billEventInvoiceId: row.id })
    })
  })
  const logs = await s.db.accountingSyncLog.findMany({ where: { type: 'PURCHASE_FX_VARIANCE', referenceId: po.id }, select: { payload: true } })
  assert.equal(logs.length, 1)
  assert.equal((logs[0]!.payload as { date: string }).date, BILL_DATE, 'the bill date, as the bill\'s own transit row')
  const transit = await s.db.transitSubledgerMovement.findFirstOrThrow({ where: { sourceType: 'PURCHASE_FX_VARIANCE', sourceRef: po.id } })
  assert.equal(transit.journalDate.toISOString().slice(0, 10), BILL_DATE)
})

// [mutation: split a return credit by the bill's overall proportion instead of per credited line (#1157 HIGH-1), or send the parts without exact amounts]
test('HIGH-1 / MED-7 end to end: a two-line bill with uneven price differences, two return credits posted to Xero: each credit splits only its own line\'s PPV; GR/IR and transit net', async () => {
  const { createPurchaseOrder } = await import('@/app/actions/purchase-orders')
  const second = (await s.db.product.create({ data: { sku: 'PFR-2', name: 'PFR 2', type: 'SIMPLE' }, select: { id: true } })).id
  const noVat = await s.db.taxRate.findFirstOrThrow({ where: { accountingTaxType: 'NONE' }, select: { id: true } })
  await s.db.supplier.update({ where: { id: supplierId }, data: { taxRateId: noVat.id } })
  const reference = `PFR-PO2-${++seq}-${Date.now()}`
  const created = await createPurchaseOrder({
    reference, supplierId, currency: 'GBP', destinationWarehouseId: warehouseId, pricesIncludeVat: false, taxRateValue: 0,
    lines: [{ productId, sku: 'PFR-1', productName: 'PFR 1', qty: 10, unitCostForeign: 10 }, { productId: second, sku: 'PFR-2', productName: 'PFR 2', qty: 10, unitCostForeign: 10 }],
  } as never)
  assert.equal(created.success, true, String(created.error))
  const row = await s.db.purchaseOrder.findUniqueOrThrow({ where: { reference }, select: { id: true, subtotalBase: true, totalBase: true, lines: { orderBy: { sortOrder: 'asc' }, select: { id: true, productId: true, totalBase: true } } } })
  await s.db.purchaseOrder.update({ where: { id: row.id }, data: { status: 'PO_SENT', currency: CURRENCY, fxRateToBase: PO_RATE, subtotalForeign: row.subtotalBase.mul(PO_RATE).toFixed(4), totalForeign: row.totalBase.mul(PO_RATE).toFixed(4) } })
  for (const line of row.lines) await s.db.purchaseOrderLine.update({ where: { id: line.id }, data: { unitCostForeign: '12.5', totalForeign: line.totalBase.mul(PO_RATE).toFixed(4) } })
  const lineA = row.lines.find((l) => l.productId === productId)!.id
  const lineB = row.lines.find((l) => l.productId === second)!.id
  const po: Po = { id: row.id, lineId: lineA, reference }
  await lockAt(po)
  const { receivePurchaseOrder, createInvoice, returnPurchaseOrder } = await import('@/app/actions/purchase-orders')
  assert.equal((await receivePurchaseOrder(po.id, [{ poLineId: lineA, qtyReceived: 10, warehouseId }, { poLineId: lineB, qtyReceived: 10, warehouseId }])).success, true)
  // Line A at the PO cost (12.5), line B dearer (18.75: 6.25 a unit of price variance).
  const billed = await createInvoice(po.id, { invoiceDate: BILL_DATE, invoiceNumber: `SUP-R2-${++seq}`, lines: [
    { kind: 'product', poLineId: lineA, qtyBilled: 10, unitCostForeign: 12.5 }, { kind: 'product', poLineId: lineB, qtyBilled: 10, unitCostForeign: 18.75 },
  ] } as never)
  assert.equal(billed.success, true, String(billed.error))
  close(Number((await billOf(po)).ppvBase), 39.0625, '62.5 foreign of price variance, all on line B, at 1.6')

  const postLatest = async () => {
    const credit = await s.db.supplierCreditNote.findFirstOrThrow({ where: { poId: po.id, status: 'DRAFT' } })
    const posted = await withXeroPosting(() => postCredit(credit.id))
    assert.equal(posted.success, true, String(posted.error))
    const log = await s.db.accountingSyncLog.findFirstOrThrow({ where: { type: 'PURCHASE_CREDIT_NOTE', referenceId: credit.id }, select: { payload: true } })
    const transit = await s.db.transitSubledgerMovement.findFirstOrThrow({ where: { sourceType: 'SUPPLIER_CREDIT_NOTE', sourceRef: credit.id } })
    return { credit: await s.db.supplierCreditNote.findUniqueOrThrow({ where: { id: credit.id } }), payload: log.payload as { lines: Array<{ accountCode: string; unitAmount: number; lineAmount?: number; taxAmount?: number }>; lineAmountsIncludeTax: boolean }, transit: Number(transit.baseDelta) }
  }

  // Return 4 of line A (no price variance on it): the credit is all stock, on transit. The bill's overall share (62.5 / 250) would have moved 12.5 to PPV.
  assert.equal((await returnPurchaseOrder(po.id, [{ poLineId: lineA, qtyReturned: 4, warehouseId }], 'damaged')).success, true)
  const first = await postLatest()
  close(Number(first.credit.amountForeign), 50, '4 x 12.5')
  assert.deepEqual(first.payload.lines.map((l) => [l.accountCode, l.unitAmount]), [['631', 50]], 'one transit line: nothing to split')
  close(first.transit, -31.25, 'transit credited with the whole credit (50 at 1.6)')
  assert.equal(first.credit.ppvBase, null)

  // Return 2 of line B: its credit (2 x 18.75 = 37.5) splits 25 stock / 12.5 price variance, exclusive with exact amounts.
  assert.equal((await returnPurchaseOrder(po.id, [{ poLineId: lineB, qtyReturned: 2, warehouseId }], 'damaged')).success, true)
  const secondCredit = await postLatest()
  close(Number(secondCredit.credit.amountForeign), 37.5, 'the top-up for line B')
  assert.deepEqual(secondCredit.payload.lines.map((l) => [l.accountCode, l.unitAmount, l.lineAmount, l.taxAmount]), [['631', 25, 25, 0], ['5050', 12.5, 12.5, 0]])
  assert.equal(secondCredit.payload.lineAmountsIncludeTax, false)
  close(Number(secondCredit.credit.ppvBase), 7.8125, '12.5 at 1.6')
  close(secondCredit.transit, -15.625, 'transit gets back only the stock part (25 at 1.6), what the bill put there for 2 units')

  const credited = await s.db.grirSubledgerMovement.findMany({ where: { poId: po.id, sourceType: 'SUPPLIER_CREDIT_NOTE' }, select: { poLineId: true, baseDelta: true } })
  close(credited.filter((r) => r.poLineId === lineA).reduce((a, r) => a + Number(r.baseDelta), 0), 31.25, 'line A cleared at the bill\'s stock value (4 x 7.8125)')
  close(credited.filter((r) => r.poLineId === lineB).reduce((a, r) => a + Number(r.baseDelta), 0), 15.625, 'line B likewise (2 x 7.8125)')
  close((await balance(po)).toNumber(), 0, 'GR/IR nets to zero')
  // Transit for the 6 returned units: the returns debited their goods (6 x 7.8125 = 46.875), the credits took back exactly that.
  close(first.transit + secondCredit.transit, -46.875, 'transit nets to zero against the returns')
})

// [mutation: gate the bill create's reconciliation on the switch-on rate only (#1157 MED-2)]
test('MED-2 (#1157): after a switch-off rollback, a bill at the PO rate for goods received under the switch is reconciled at once', async () => {
  const po = await seedPo(10)
  await lockAt(po)
  assert.equal((await receive(po, 10)).success, true) // at the lock: 78.125
  await setSettings({ purchase_event_fx_rates_enabled: 'false' })
  try {
    assert.equal((await bill(po, 10, 12.5)).success, true) // switch off: the PO rate, 100
  } finally {
    await setSettings({ purchase_event_fx_rates_enabled: 'true' })
  }
  assert.equal((await billOf(po)).fxRateSource, null)
  close(await grir(po, 'BILL_FX_VARIANCE'), 100 - 78.125, 'the bill\'s FX difference against the lock-rate receipt')
  close((await balance(po)).toNumber(), 0, 'GR/IR nets to zero')
})

// [mutation: post live the reversal of an amount that was settled as a shadow (#1157 LOW-2)]
test('LOW-2 (#1157): taking back an amount settled as a shadow (the bill deleted) is settled as a shadow, never posted live', async () => {
  const po = await seedPo(10)
  assert.equal((await receive(po, 10)).success, true)
  await lockAt(po)
  assert.equal((await bill(po, 10, 12.5)).success, true)
  const row = await billOf(po)
  await markBillsPosted(po)
  await s.db.purchaseFxVarianceShadow.create({ data: { poId: po.id, invoiceId: row.id, idempotencyKey: `purchase-fx-variance:${row.id}:shadow-test`, baseDelta: '21.88', journalDate: BILL_DATE } })
  await s.db.purchaseInvoice.update({ where: { id: row.id }, data: { accountingInvoiceId: `XB-${row.id}`, accountingInvoiceConnector: 'xero' } })
  await s.db.accountingDocumentDeletion.create({
    data: {
      kind: 'PURCHASE_INVOICE', referenceType: 'PurchaseInvoice', referenceId: row.id, documentId: row.id, externalDocumentId: `XB-${row.id}`,
      originalNumber: row.invoiceNumber ?? '', releasedNumber: `${row.invoiceNumber}-released`, targetStatus: 'VOIDED', snapshot: { purchaseOrderId: po.id },
    },
  })
  const { completeAccountingDocumentDeletion } = await import('@/lib/domain/accounting/document-delete-service')
  await withXeroPosting(async () => assert.equal(await completeAccountingDocumentDeletion(`XB-${row.id}`), 'completed'))
  assert.equal(await s.db.accountingSyncLog.count({ where: { type: 'PURCHASE_FX_VARIANCE', referenceId: po.id } }), 0, 'no live journal')
  const shadows = await s.db.purchaseFxVarianceShadow.findMany({ where: { poId: po.id } })
  close(shadows.reduce((a, r) => a + Number(r.baseDelta), 0), 0, 'the shadow is taken back as a shadow')
})

// ─── MED-C: bills posted to Xero outside IMS; o3d-ygc2x and o3d-tqs3o ────────────────────────────────────────────────────────────────

/** A sent order with two lines (qtyA, qtyB) at 12.5 foreign each (10 GBP at the PO rate), no tax; the lines can carry their own tax rate. */
async function seedTwoLinePo(qtyA: number, qtyB: number, taxRateId?: string) {
  const { createPurchaseOrder } = await import('@/app/actions/purchase-orders')
  const second = (await s.db.product.findFirst({ where: { sku: 'PFR-2' }, select: { id: true } }))?.id
    ?? (await s.db.product.create({ data: { sku: 'PFR-2', name: 'PFR 2', type: 'SIMPLE' }, select: { id: true } })).id
  const reference = `PFR-PO2-${++seq}-${Date.now()}`
  const created = await createPurchaseOrder({
    reference, supplierId, currency: 'GBP', destinationWarehouseId: warehouseId, pricesIncludeVat: false, taxRateValue: 0,
    lines: [{ productId, sku: 'PFR-1', productName: 'PFR 1', qty: qtyA, unitCostForeign: 10 }, { productId: second, sku: 'PFR-2', productName: 'PFR 2', qty: qtyB, unitCostForeign: 10 }],
  } as never)
  assert.equal(created.success, true, String(created.error))
  const row = await s.db.purchaseOrder.findUniqueOrThrow({ where: { reference }, select: { id: true, subtotalBase: true, totalBase: true, lines: { select: { id: true, productId: true, totalBase: true } } } })
  await s.db.purchaseOrder.update({ where: { id: row.id }, data: { status: 'PO_SENT', currency: CURRENCY, fxRateToBase: PO_RATE, subtotalForeign: row.subtotalBase.mul(PO_RATE).toFixed(4), totalForeign: row.totalBase.mul(PO_RATE).toFixed(4) } })
  // A line's own tax rate is recorded with the tax it was priced at (a bill bills at the RECORDED rate).
  for (const line of row.lines) await s.db.purchaseOrderLine.update({ where: { id: line.id }, data: { unitCostForeign: '12.5', totalForeign: line.totalBase.mul(PO_RATE).toFixed(4), ...(taxRateId ? { taxRateId, taxForeign: line.totalBase.mul(PO_RATE).mul('0.2').toFixed(4) } : {}) } })
  return { id: row.id, reference, lineA: row.lines.find((l) => l.productId === productId)!.id, lineB: row.lines.find((l) => l.productId === second)!.id }
}

/** A fake read-only Xero bill read (the network is never reached): answers each InvoiceID from `xeroBills`, and counts the calls. */
const xeroBills = new Map<string, { CurrencyRate: number; lines: Array<{ AccountCode: string; LineAmount: number; TaxAmount?: number }>; Status?: string; CurrencyCode?: string; httpStatus?: number }>()
const xeroReads: string[] = []
const xeroDeps = {
  get: async <T,>(path: string) => {
    xeroReads.push(path)
    const id = decodeURIComponent(path.replace(/^Invoices\//, ''))
    const bill = xeroBills.get(id)
    if (!bill) return { ok: false, status: 404, error: 'not found' }
    if (bill.httpStatus) return { ok: false, status: bill.httpStatus, error: `HTTP ${bill.httpStatus}` }
    return {
      ok: true, status: 200, tenantId: 'tenant-pfr',
      data: { Invoices: [{ InvoiceID: id, Type: 'ACCPAY', Status: bill.Status ?? 'AUTHORISED', CurrencyCode: bill.CurrencyCode ?? CURRENCY, CurrencyRate: bill.CurrencyRate, LineAmountTypes: 'Exclusive', LineItems: bill.lines }] } as T,
    }
  },
}
/** The confirmation compares the connected Xero organisation with the one that answered the read (the fake answers as tenant-pfr). */
async function withXeroToken<T>(fn: () => Promise<T>): Promise<T> {
  await s.db.accountingToken.upsert({ where: { connector: 'xero' }, create: { connector: 'xero', accessToken: 'x', expiresAt: new Date(Date.now() + 3_600_000), tenantId: 'tenant-pfr' }, update: { tenantId: 'tenant-pfr' } })
  try {
    return await fn()
  } finally {
    await s.db.accountingToken.deleteMany({ where: { connector: 'xero' } })
  }
}
/** Run with the producer-side hold variables set (and restored after). */
async function withHold<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  Object.assign(process.env, vars)
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
}
let guidSeq = 0
const guid = () => `00000000-0000-4000-8000-${String(++guidSeq).padStart(12, '0')}`

/** A bill at the PO rate from before switch-on that Qoblex posted (no PURCHASE_BILL transit row), linked to its Xero bill. */
async function nonImsBill(po: Po, qty: number, unit: number, xero: { rate: number; account?: string } | null): Promise<{ id: string; xeroId: string | null }> {
  const { setPurchaseEventFxStepsCompleteForTests } = await import('@/lib/domain/purchasing/purchase-event-fx-settings')
  setPurchaseEventFxStepsCompleteForTests(false)
  try {
    assert.equal((await bill(po, qty, unit)).success, true)
  } finally {
    setPurchaseEventFxStepsCompleteForTests(true)
  }
  const row = await billOf(po)
  if (!xero) return { id: row.id, xeroId: null }
  const xeroId = guid()
  await s.db.purchaseInvoice.update({ where: { id: row.id }, data: { accountingInvoiceId: xeroId, accountingInvoiceConnector: 'xero' } })
  xeroBills.set(xeroId, { CurrencyRate: xero.rate, lines: [{ AccountCode: xero.account ?? '631', LineAmount: qty * unit, TaxAmount: 0 }] })
  return { id: row.id, xeroId }
}

// [mutation: owe a journal for a bill posted outside IMS without a confirmation, measure it at the bill's own GR/IR value instead of the Xero bill's rate,
//  skip the under-the-lock comparison, read Xero twice, or let a confirmation post twice]
test('MED-C: a bill posted outside IMS is listed with its Xero basis (read once), confirmed only with the shown journal, measured at the Xero rate, posted once', async () => {
  const { setPurchaseEventFxStepsCompleteForTests } = await import('@/lib/domain/purchasing/purchase-event-fx-settings')
  const { listNonImsBills, confirmNonImsBills, NonImsBillsConfirmRefused } = await import('@/lib/domain/purchasing/purchase-fx-non-ims-bills')
  const { rerunPurchaseBillFx } = await import('@/lib/domain/purchasing/purchase-bill-fx')
  const po = await seedPo(10)
  const qoblex = await nonImsBill(po, 10, 12.5, { rate: 1.2 }) // Qoblex posted it at 1.2: 125 / 1.2 = 104.17 in transit
  // Interlock off: listed read-only, "not confirmable yet", and Xero is not asked.
  setPurchaseEventFxStepsCompleteForTests(false)
  try {
    xeroReads.length = 0
    const off = await withXeroPosting(() => listNonImsBills({ deps: xeroDeps }))
    assert.equal(off.confirmable, false)
    assert.match(off.notConfirmableReason ?? '', /not confirmable yet/)
    assert.equal(xeroReads.length, 0, 'no Xero call while it cannot be confirmed')
    await assert.rejects(withXeroPosting(() => withXeroToken(() => confirmNonImsBills({ by: 'Jan', reason: 'turn-on', all: true, deps: xeroDeps }))), NonImsBillsConfirmRefused)
  } finally {
    setPurchaseEventFxStepsCompleteForTests(true)
  }
  await lockAt(po)
  assert.equal((await receive(po, 10)).success, true) // after switch-on, at the lock: 78.125
  close(await grir(po, 'BILL_FX_VARIANCE'), 100 - 78.125, 'GR/IR is corrected on the bill\'s own value, as before')
  assert.equal((await withXeroPosting(() => rerunPurchaseBillFx(po.id))).journals.length, 0, 'not posted by IMS: no journal owed before a confirmation')
  xeroReads.length = 0
  const list = await withXeroPosting(() => listNonImsBills({ deps: xeroDeps }))
  const mine = list.candidates.find((c) => c.invoiceId === qoblex.id)!
  assert.equal(xeroReads.filter((p) => p.includes(qoblex.xeroId!)).length, 1, 'one Xero read per candidate')
  assert.equal(mine.accountingInvoiceId, qoblex.xeroId)
  assert.match(mine.noTransitRowReason, /not posted by IMS/)
  assert.deepEqual([mine.basis.qty, mine.basis.stockForeign, mine.basis.rate, mine.basis.account, mine.basis.stockTransitBase], ['10', '125.00', '1.2', '631', '104.17'])
  assert.equal(mine.notReceived.qty, '0')
  assert.equal(mine.proposedTransitDelta, '-26.04', 'the Xero bill (104.17 at 1.2) against the receipt (78.125); not -21.88 at the PO rate')
  assert.equal(await s.db.accountingSyncLog.count({ where: { type: 'PURCHASE_FX_VARIANCE', referenceId: po.id } }), 0, 'the list writes nothing')
  // Refusals: no who, neither --all nor --bill, no --expect/--digest.
  await assert.rejects(withXeroPosting(() => withXeroToken(() => confirmNonImsBills({ by: '', reason: 'x', invoiceIds: [qoblex.id], deps: xeroDeps }))), NonImsBillsConfirmRefused)
  await assert.rejects(withXeroPosting(() => withXeroToken(() => confirmNonImsBills({ by: 'Jan', reason: 'x', deps: xeroDeps }))), /--all/)
  await assert.rejects(withXeroPosting(() => withXeroToken(() => confirmNonImsBills({ by: 'Jan', reason: 'x', invoiceIds: [qoblex.id], deps: xeroDeps }))), /--expect/)
  // A wrong expectation is refused under the lock and rolled back.
  const wrong = await withXeroPosting(() => withXeroToken(() => confirmNonImsBills({ by: 'Jan', reason: 'x', invoiceIds: [qoblex.id], expect: new Map([[qoblex.id, '-21.88']]), deps: xeroDeps })))
  assert.equal(wrong.confirmed.length, 0)
  assert.match(wrong.failed[0]?.error ?? '', /not the -21.88 shown/)
  assert.equal(await s.db.purchaseFxNonImsBillApproval.count({ where: { invoiceId: qoblex.id } }), 0, 'rolled back')
  xeroReads.length = 0
  const confirmed = await withXeroPosting(() => withXeroToken(() => confirmNonImsBills({ by: 'Jan', reason: 'owner ruling: one-off journal', invoiceIds: [qoblex.id], expect: new Map([[qoblex.id, '-26.04']]), deps: xeroDeps })))
  assert.equal(xeroReads.length, 1, 'the confirmation reads the Xero bill once and stores the answer')
  assert.deepEqual(confirmed.journals.map((j) => j.transitDelta), ['-26.04'])
  const approval = await s.db.purchaseFxNonImsBillApproval.findUniqueOrThrow({ where: { invoiceId: qoblex.id } })
  assert.deepEqual([approval.xeroInvoiceId, approval.xeroCurrencyRate?.toString(), approval.stockTransitBase?.toString()], [qoblex.xeroId, '1.2', '104.17'])
  assert.equal(await s.db.activityLog.count({ where: { action: 'purchase_fx_non_ims_bill_confirmed', entityId: po.id } }), 1)
  close((await balance(po)).toNumber(), 0, 'GR/IR nets to zero')
  assert.equal((await withXeroPosting(() => rerunPurchaseBillFx(po.id))).journals.length, 0, 'posted once: a re-run queues nothing')
  // A named, already confirmed bill is a re-confirmation (after a Xero-side edit): the same basis posts nothing more.
  const reconfirmed = await withXeroPosting(() => withXeroToken(() => confirmNonImsBills({ by: 'Jan', reason: 'again', invoiceIds: [qoblex.id], expect: new Map([[qoblex.id, '0']]), deps: xeroDeps })))
  assert.equal(reconfirmed.confirmed.length, 1)
  assert.equal(reconfirmed.journals.length, 0)
  assert.equal(await s.db.purchaseFxNonImsBillApproval.count({ where: { invoiceId: qoblex.id } }), 1, 'replaced, not added')
  assert.equal(await s.db.accountingSyncLog.count({ where: { type: 'PURCHASE_FX_VARIANCE', referenceId: po.id } }), 1)
  // Not in the default list while it holds.
  assert.ok(!(await withXeroPosting(() => listNonImsBills({ deps: xeroDeps }))).candidates.some((c) => c.invoiceId === qoblex.id))
})

// [mutation: list a bill with no Xero link, a delete pending or lines off transit as confirmable, or confirm --all without the digest]
test('MED-C candidates: unlinked, delete-pending and off-transit bills are not confirmable by default; --all needs the digest; goods not received are shown', async () => {
  const { listNonImsBills, confirmNonImsBills } = await import('@/lib/domain/purchasing/purchase-fx-non-ims-bills')
  const unlinked = await seedPo(10)
  const noLink = await nonImsBill(unlinked, 10, 12.5, null)
  const offTransit = await seedPo(10)
  const off = await nonImsBill(offTransit, 10, 12.5, { rate: 1.25, account: '300' })
  const pending = await seedPo(10)
  const del = await nonImsBill(pending, 10, 12.5, { rate: 1.25 })
  await s.db.accountingDocumentDeletion.create({
    data: { kind: 'PURCHASE_INVOICE', referenceType: 'PurchaseInvoice', referenceId: del.id, documentId: del.id, externalDocumentId: del.xeroId!, originalNumber: 'X', releasedNumber: 'X-r', targetStatus: 'VOIDED', snapshot: {} },
  })
  const open = await seedPo(10)
  const ok = await nonImsBill(open, 10, 12.5, { rate: 1.25 })
  const list = await withXeroPosting(() => listNonImsBills({ deps: xeroDeps }))
  const ids = list.candidates.map((c) => c.invoiceId)
  assert.ok(!ids.includes(noLink.id) && !ids.includes(del.id), 'unlinked and delete-pending bills are left out by default')
  assert.match(list.candidates.find((c) => c.invoiceId === off.id)?.problem ?? '', /coded to 300/)
  const okRow = list.candidates.find((c) => c.invoiceId === ok.id)!
  assert.equal(okRow.problem, null)
  assert.deepEqual([okRow.notReceived.qty, okRow.notReceived.base], ['10', '100.00'], 'nothing received yet: the confirmation covers all of it')
  const named = await withXeroPosting(() => listNonImsBills({ named: [noLink.id, del.id], deps: xeroDeps }))
  assert.match(named.candidates.find((c) => c.invoiceId === noLink.id)?.problem ?? '', /not linked to a Xero bill/)
  assert.match(named.candidates.find((c) => c.invoiceId === del.id)?.exclusion ?? '', /delete of the bill is pending/)
  await assert.rejects(withXeroPosting(() => withXeroToken(() => confirmNonImsBills({ by: 'Jan', reason: 'x', all: true, digest: 'deadbeefdeadbeef', deps: xeroDeps }))), /changed since the dry run/)
  const all = await withXeroPosting(() => withXeroToken(() => confirmNonImsBills({ by: 'Jan', reason: 'x', all: true, digest: list.digest, deps: xeroDeps })))
  assert.ok(all.confirmed.some((c) => c.invoiceId === ok.id) && !all.confirmed.some((c) => c.invoiceId === off.id), '--all confirms only the confirmable default list')
})

// [mutation: accept a DRAFT/SUBMITTED Xero bill as a basis (#1162 HIGH-1), read past the cap or past a 429, read unnamed bills, or take --digest without --all]
test('MED-C reads: only an AUTHORISED or PAID Xero bill is a basis; the read cap, a 429 and --bill limit the reads; --digest needs --all; --expect must name a chosen bill', async () => {
  const { listNonImsBills, confirmNonImsBills, NonImsBillsConfirmRefused } = await import('@/lib/domain/purchasing/purchase-fx-non-ims-bills')
  const draftPo = await seedPo(10)
  const draft = await nonImsBill(draftPo, 10, 12.5, { rate: 1.25 })
  xeroBills.get(draft.xeroId!)!.Status = 'DRAFT'
  const named = await withXeroPosting(() => listNonImsBills({ named: [draft.id], deps: xeroDeps }))
  const row = named.candidates.find((c) => c.invoiceId === draft.id)!
  assert.equal(row.basis.xeroStatus, 'DRAFT')
  assert.match(row.problem ?? '', /only an AUTHORISED or PAID bill/)
  for (const status of ['SUBMITTED', 'AUTHORISED', 'PAID']) {
    xeroBills.get(draft.xeroId!)!.Status = status
    const again = (await withXeroPosting(() => listNonImsBills({ named: [draft.id], deps: xeroDeps }))).candidates[0]!
    assert.equal(again.problem === null, status !== 'SUBMITTED', status)
  }
  // --bill reads only the named bill; the cap stops further reads; a 429 stops the rest.
  const other = await seedPo(10)
  const second = await nonImsBill(other, 10, 12.5, { rate: 1.25 })
  xeroReads.length = 0
  const onlyNamed = await withXeroPosting(() => listNonImsBills({ named: [second.id], deps: xeroDeps }))
  assert.deepEqual(onlyNamed.candidates.map((c) => c.invoiceId), [second.id])
  assert.equal(onlyNamed.xeroReads, 1)
  assert.equal(xeroReads.length, 1, 'only the named bill is read')
  xeroReads.length = 0
  const capped = await withXeroPosting(() => listNonImsBills({ maxReads: 1, deps: xeroDeps }))
  assert.equal(capped.xeroReads, 1)
  assert.equal(xeroReads.length, 1, 'the cap holds')
  assert.ok(capped.candidates.some((c) => /cap of 1 Xero reads/.test(c.problem ?? '')))
  const both = (await withXeroPosting(() => listNonImsBills({ named: [draft.id, second.id], deps: xeroDeps }))).candidates.map((c) => c.invoiceId)
  const [firstId, laterId] = both as [string, string]
  const firstXero = [draft, second].find((b) => b.id === firstId)!.xeroId!
  xeroBills.get(firstXero)!.httpStatus = 429
  xeroReads.length = 0
  const limited = await withXeroPosting(() => listNonImsBills({ named: [draft.id, second.id], deps: xeroDeps }))
  assert.equal(xeroReads.length, 1, 'stopped after the 429')
  assert.match(limited.candidates.find((c) => c.invoiceId === laterId)?.problem ?? '', /^not read: Xero rate-limited/)
  delete xeroBills.get(firstXero)!.httpStatus
  // LOW-9.
  await assert.rejects(withXeroPosting(() => withXeroToken(() => confirmNonImsBills({ by: 'Jan', reason: 'x', invoiceIds: [second.id], digest: 'abc', deps: xeroDeps }))), /--digest goes with --all/)
  await assert.rejects(withXeroPosting(() => withXeroToken(() => confirmNonImsBills({ by: 'Jan', reason: 'x', invoiceIds: [second.id], expect: new Map([[second.id, '0.00'], ['someone-else', '1']]), deps: xeroDeps }))), NonImsBillsConfirmRefused)
})

// [mutation: measure a confirmed bill on the order's CURRENT cost instead of the frozen basis, or keep adjusting a stale confirmation (MED-5)]
test('MED-5: the basis is frozen with the confirmation; an IMS bill edit, an order cost edit or a re-link makes it stale (journal held) until it is confirmed again', async () => {
  const { listNonImsBills, confirmNonImsBills } = await import('@/lib/domain/purchasing/purchase-fx-non-ims-bills')
  const { rerunPurchaseBillFx } = await import('@/lib/domain/purchasing/purchase-bill-fx')
  const po = await seedPo(10)
  const qoblex = await nonImsBill(po, 10, 12.5, { rate: 1.2 })
  await lockAt(po)
  assert.equal((await receive(po, 10)).success, true)
  const confirmed = await withXeroPosting(() => withXeroToken(() => confirmNonImsBills({ by: 'Jan', reason: 'one-off', invoiceIds: [qoblex.id], expect: new Map([[qoblex.id, '-26.04']]), deps: xeroDeps })))
  assert.equal(confirmed.confirmed.length, 1)
  const approval = await s.db.purchaseFxNonImsBillApproval.findUniqueOrThrow({ where: { invoiceId: qoblex.id } })
  assert.deepEqual(approval.stockUnits, { [po.lineId]: '12.5' })
  assert.equal(approval.xeroTenantId, 'tenant-pfr')
  // The order's cost is edited: the confirmation goes stale and its journal is held (not re-measured on the new cost).
  await s.db.purchaseOrderLine.update({ where: { id: po.lineId }, data: { unitCostForeign: '13' } })
  const held = await withXeroPosting(() => rerunPurchaseBillFx(po.id))
  assert.equal(held.journals.length, 0, 'held where it is')
  const stale = await s.db.purchaseFxNonImsBillApproval.findUniqueOrThrow({ where: { invoiceId: qoblex.id } })
  assert.ok(stale.staleAt)
  assert.match(stale.staleReason ?? '', /goods cost was edited/)
  const listed = (await withXeroPosting(() => listNonImsBills({ deps: xeroDeps }))).candidates.find((c) => c.invoiceId === qoblex.id)
  assert.match(listed?.reconfirmation ?? '', /now stale/, 'listed again for re-confirmation')
  await s.db.purchaseOrderLine.update({ where: { id: po.lineId }, data: { unitCostForeign: '12.5' } })
  // Linked to another Xero bill: stale too (once re-confirmed on the restored cost).
  const again = await withXeroPosting(() => withXeroToken(() => confirmNonImsBills({ by: 'Jan', reason: 're-confirm', invoiceIds: [qoblex.id], expect: new Map([[qoblex.id, '0.00']]), deps: xeroDeps })))
  assert.equal(again.confirmed.length, 1, String(again.failed[0]?.error))
  assert.equal((await s.db.purchaseFxNonImsBillApproval.findUniqueOrThrow({ where: { invoiceId: qoblex.id } })).staleAt, null)
  // The IMS bill is edited (10 -> 8): its journal would change (8 units matched), but the confirmation is stale, so the journal is held.
  const { updateInvoice } = await import('@/app/actions/purchase-orders')
  const current = await billOf(po)
  const edited = await updateInvoice(current.id, {
    invoiceNumber: current.invoiceNumber, invoiceDate: BILL_DATE, dueDate: null, notes: null, supplierInvoiceUrl: null,
    lines: [{ id: current.lines[0]!.id, qtyBilled: 8, unitCostForeign: 12.5 }],
  } as never)
  assert.equal(edited.success, true, String(edited.error))
  await withXeroPosting(() => rerunPurchaseBillFx(po.id))
  assert.match((await s.db.purchaseFxNonImsBillApproval.findUniqueOrThrow({ where: { invoiceId: qoblex.id } })).staleReason ?? '', /IMS bill was edited/)
  assert.equal(await s.db.accountingSyncLog.count({ where: { type: 'PURCHASE_FX_VARIANCE', referenceId: po.id } }), 1, 'one journal through all of it: the stale one is held')
  await s.db.purchaseInvoice.update({ where: { id: qoblex.id }, data: { accountingInvoiceId: guid() } })
  const { nonImsBillFingerprint } = await import('@/lib/domain/purchasing/purchase-bill-fx')
  const edited8 = await s.db.purchaseInvoice.findUniqueOrThrow({ where: { id: qoblex.id }, include: { lines: true } })
  await s.db.purchaseFxNonImsBillApproval.update({ where: { invoiceId: qoblex.id }, data: { staleAt: null, staleReason: null, billFingerprint: nonImsBillFingerprint(edited8) } })
  await withXeroPosting(() => rerunPurchaseBillFx(po.id))
  assert.match((await s.db.purchaseFxNonImsBillApproval.findUniqueOrThrow({ where: { invoiceId: qoblex.id } })).staleReason ?? '', /linked to another Xero bill/)
})

// [mutation: confirm while the hold shadows the journal (#1164 MED-1: the journal would be lost), or read Xero first]
test('MED-1 (#1164): while the hold shadows exchange-rate journals, a confirmation is refused up front, before any Xero read', async () => {
  const { confirmNonImsBills, NonImsBillsConfirmRefused } = await import('@/lib/domain/purchasing/purchase-fx-non-ims-bills')
  const po = await seedPo(10)
  const qoblex = await nonImsBill(po, 10, 12.5, { rate: 1.2 })
  await lockAt(po)
  assert.equal((await receive(po, 10)).success, true)
  xeroReads.length = 0
  await withHold({ PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero' }, async () => {
    await assert.rejects(
      withXeroPosting(() => withXeroToken(() => confirmNonImsBills({ by: 'Jan', reason: 'one-off', invoiceIds: [qoblex.id], expect: new Map([[qoblex.id, '-26.04']]), deps: xeroDeps }))),
      (error: unknown) => error instanceof NonImsBillsConfirmRefused && /shadows exchange-rate difference journals/.test(error.message),
    )
  })
  assert.equal(xeroReads.length, 0, 'refused before any Xero read')
  assert.equal(await s.db.purchaseFxNonImsBillApproval.count({ where: { invoiceId: qoblex.id } }), 0)
  assert.equal(await s.db.purchaseFxVarianceShadow.count({ where: { poId: po.id } }), 0, 'nothing settled as a shadow')
})

// [mutation: leave the take-back of an earlier shadow out of a dry run (#1164 LOW-4)]
test('LOW-4 (#1164): a dry run reports the take-back of an earlier shadow, as the real run settles it', async () => {
  const { rerunPurchaseBillFx } = await import('@/lib/domain/purchasing/purchase-bill-fx')
  const po = await seedPo(10)
  assert.equal((await receive(po, 10)).success, true) // table 1.25: 100
  await lockAt(po)
  assert.equal((await bill(po, 10, 12.5)).success, true) // lock: 78.125 -> journal +21.88
  const row = await billOf(po)
  await markBillsPosted(po)
  await s.db.purchaseFxVarianceShadow.create({ data: { poId: po.id, invoiceId: row.id, idempotencyKey: `purchase-fx-variance:${row.id}:shadow-low4`, baseDelta: '21.88', journalDate: BILL_DATE } })
  // The bill now bills 6 (target 13.13): the 8.75 taken back is a shadow reversal.
  await s.db.purchaseInvoiceLine.update({ where: { id: row.lines[0]!.id }, data: { qtyBilled: '6', totalForeign: '75', totalBase: '46.875' } })
  const dry = await withXeroPosting(() => rerunPurchaseBillFx(po.id, { dryRun: true }))
  assert.deepEqual((dry.shadowed ?? []).map((x) => [x.transitDelta, x.reversal]), [['-8.75', true]])
  assert.equal(dry.journals.length, 0)
  assert.equal(await s.db.purchaseFxVarianceShadow.count({ where: { poId: po.id } }), 1, 'the dry run wrote nothing')
})

// [mutation: judge the bill's date at the END of the day instead of the producer's START of the day (#1164 HIGH-1)]
test('HIGH-1 (#1164): a bill dated on a live-from day whose instant is after midnight is shadowed as its posting is, so it stays at the PO rate', async () => {
  const live = { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero', XERO_WRITES_LIVE_FROM: '2026-11-20T09:00:00Z', XERO_WRITE_ALLOWED_TENANT: 'tenant-pfr' }
  const { createInvoice } = await import('@/app/actions/purchase-orders')
  await withHold(live, async () => {
    const onTheDay = await seedPo(10)
    await lockAt(onTheDay)
    assert.equal((await createInvoice(onTheDay.id, { invoiceDate: '2026-11-20', invoiceNumber: `SUP-H1-${++seq}`, lines: [{ kind: 'product', poLineId: onTheDay.lineId, qtyBilled: 10, unitCostForeign: 12.5 }] } as never)).success, true)
    assert.equal((await billOf(onTheDay)).fxRateSource, null, 'dated 11-20: its posting is judged at 11-20T00:00Z, before the 09:00 live-from: shadowed')
    const dayAfter = await seedPo(10)
    await lockAt(dayAfter)
    assert.equal((await createInvoice(dayAfter.id, { invoiceDate: '2026-11-21', invoiceNumber: `SUP-H1-${++seq}`, lines: [{ kind: 'product', poLineId: dayAfter.lineId, qtyBilled: 10, unitCostForeign: 12.5 }] } as never)).success, true)
    assert.equal((await billOf(dayAfter)).fxRateSource, 'XERO_PREPAYMENT', 'dated 11-21: live, valued under the switch')
  })
})

// [mutation: value a bill under the switch while the producer-side hold shadows supplier bills on its date, or edit such a bill]
test('bill writer: while the hold shadows supplier bills, a new bill is valued at the PO rate as before and a switch-valued bill is not edited', async () => {
  const { updateInvoice } = await import('@/app/actions/purchase-orders')
  const managedPo = await seedPo(10)
  await lockAt(managedPo)
  assert.equal((await receive(managedPo, 10)).success, true)
  assert.equal((await bill(managedPo, 10, 12.5)).success, true)
  const managed = await billOf(managedPo)
  assert.equal(managed.fxRateSource, 'XERO_PREPAYMENT')
  const before = process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS
  process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS = 'xero'
  try {
    const po = await seedPo(10)
    await lockAt(po)
    assert.equal((await receive(po, 10)).success, true)
    assert.equal((await bill(po, 10, 12.5)).success, true)
    const row = await billOf(po)
    assert.equal(row.fxRateSource, null, 'shadowed: the PO rate, no per-event valuation')
    assert.equal(row.fxRateToBase.toString(), PO_RATE)
    // MED-2 (#1164): the STORED date is judged too.
    const live = { XERO_WRITES_LIVE_FROM: '2026-11-20T09:00:00Z', XERO_WRITE_ALLOWED_TENANT: 'tenant-pfr' }
    const movedOut = await withHold(live, () => updateInvoice(managed.id, {
      invoiceNumber: managed.invoiceNumber, invoiceDate: '2026-11-25', dueDate: null, notes: null, supplierInvoiceUrl: null,
      lines: [{ id: managed.lines[0]!.id, qtyBilled: 9, unitCostForeign: 12.5 }],
    } as never))
    assert.equal(movedOut.success, false, 'stored 11-10 is shadowed, though the new 11-25 is live')
    assert.match(movedOut.error ?? '', /dated 2026-11-10 are now shadowed/)
    const edited = await updateInvoice(managed.id, {
      invoiceNumber: managed.invoiceNumber, invoiceDate: BILL_DATE, dueDate: null, notes: null, supplierInvoiceUrl: null,
      lines: [{ id: managed.lines[0]!.id, qtyBilled: 9, unitCostForeign: 12.5 }],
    } as never)
    assert.equal(edited.success, false)
    assert.match(edited.error ?? '', /shadowed by the producer-side hold/)
  } finally {
    if (before === undefined) delete process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS
    else process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS = before
  }
})

// [mutation: let a tenant mismatch, a NULL tenant or a pre-freeze row hold; mark a missing connection stale; warn on every run; drop the superseded row]
test('staleness (#1164 LOW-5..11): tenant mismatch, NULL tenant and pre-freeze rows are stale (listed before any reconcile), no connection only holds; one WARNING on the transition; the superseded row is kept', async () => {
  const { listNonImsBills, confirmNonImsBills } = await import('@/lib/domain/purchasing/purchase-fx-non-ims-bills')
  const { rerunPurchaseBillFx } = await import('@/lib/domain/purchasing/purchase-bill-fx')
  const po = await seedPo(10)
  const qoblex = await nonImsBill(po, 10, 12.5, { rate: 1.2 })
  await lockAt(po)
  assert.equal((await receive(po, 10)).success, true)
  const confirmed = await withXeroPosting(() => withXeroToken(() => confirmNonImsBills({ by: 'Jan', reason: 'one-off', invoiceIds: [qoblex.id], expect: new Map([[qoblex.id, '-26.04']]), deps: xeroDeps })))
  assert.equal(confirmed.confirmed.length, 1)
  const first = await s.db.purchaseFxNonImsBillApproval.findUniqueOrThrow({ where: { invoiceId: qoblex.id } })
  // No Xero organisation connected: held, not marked stale, no warning.
  const held = await withXeroPosting(() => rerunPurchaseBillFx(po.id))
  assert.deepEqual((held.stale ?? []).map((x) => [x.invoiceId, x.held]), [[qoblex.id, true]])
  assert.equal((await s.db.purchaseFxNonImsBillApproval.findUniqueOrThrow({ where: { invoiceId: qoblex.id } })).staleAt, null)
  // Another organisation connected: listed as stale by the dry run before any reconcile, then marked by the reconcile with ONE warning.
  await s.db.accountingToken.upsert({ where: { connector: 'xero' }, create: { connector: 'xero', accessToken: 'x', expiresAt: new Date(Date.now() + 3_600_000), tenantId: 'other-org' }, update: { tenantId: 'other-org' } })
  try {
    const listed = (await withXeroPosting(() => listNonImsBills({ named: [qoblex.id], deps: xeroDeps }))).candidates.find((c) => c.invoiceId === qoblex.id)
    assert.match(listed?.reconfirmation ?? '', /now stale: the connected Xero organisation \(other-org\)/)
    assert.equal((await s.db.purchaseFxNonImsBillApproval.findUniqueOrThrow({ where: { invoiceId: qoblex.id } })).staleAt, null, 'the list marks nothing')
    const a = await withXeroPosting(() => rerunPurchaseBillFx(po.id))
    assert.deepEqual((a.stale ?? []).map((x) => [x.invoiceId, x.held]), [[qoblex.id, false]])
    await withXeroPosting(() => rerunPurchaseBillFx(po.id))
  } finally {
    await s.db.accountingToken.deleteMany({ where: { connector: 'xero' } })
  }
  assert.match((await s.db.purchaseFxNonImsBillApproval.findUniqueOrThrow({ where: { invoiceId: qoblex.id } })).staleReason ?? '', /other-org/)
  assert.equal(await s.db.activityLog.count({ where: { action: 'purchase_fx_non_ims_bill_stale', entityId: po.id } }), 1, 'one WARNING, on the transition')
  // Re-confirmation: the superseded row is kept in the history.
  const again = await withXeroPosting(() => withXeroToken(() => confirmNonImsBills({ by: 'Ann', reason: 're-confirm', invoiceIds: [qoblex.id], expect: new Map([[qoblex.id, '0.00']]), deps: xeroDeps })))
  assert.equal(again.confirmed.length, 1, String(again.failed[0]?.error))
  const history = await s.db.purchaseFxNonImsBillApprovalHistory.findMany({ where: { invoiceId: qoblex.id } })
  assert.equal(history.length, 1)
  assert.equal(history[0]!.approvalId, first.id)
  assert.equal(history[0]!.supersededBy, 'Ann')
  assert.equal((history[0]!.snapshot as { approvedBy: string; staleReason: string }).approvedBy, 'Jan')
  // A NULL tenant, and a row confirmed before the basis was frozen, are stale.
  for (const [label, data] of [['tenant', { xeroTenantId: null }], ['pre-freeze', { stockUnits: Prisma.DbNull, billFingerprint: null }]] as const) {
    const reset: Record<string, unknown> = { staleAt: null, staleReason: null, xeroTenantId: 'tenant-pfr', billFingerprint: first.billFingerprint, stockUnits: first.stockUnits }
    await s.db.purchaseFxNonImsBillApproval.update({ where: { invoiceId: qoblex.id }, data: Object.assign(reset, data) as never })
    const r = await withXeroPosting(() => withXeroToken(() => rerunPurchaseBillFx(po.id)))
    assert.deepEqual((r.stale ?? []).map((x) => x.held), [false], label)
    assert.match((await s.db.purchaseFxNonImsBillApproval.findUniqueOrThrow({ where: { invoiceId: qoblex.id } })).staleReason ?? '', /before its basis was frozen/, label)
  }
  assert.equal(await s.db.accountingSyncLog.count({ where: { type: 'PURCHASE_FX_VARIANCE', referenceId: po.id } }), 1, 'one journal through all of it')
})

// [mutation: spend a return credit over the order's lines in id order instead of the lines of the return that raised it (o3d-ygc2x)]
test('o3d-ygc2x: two return credits posted in reverse order, then one draft deleted: each credit clears only its own return\'s line', async () => {
  const noVat = await s.db.taxRate.findFirstOrThrow({ where: { accountingTaxType: 'NONE' }, select: { id: true } })
  await s.db.supplier.update({ where: { id: supplierId }, data: { taxRateId: noVat.id } })
  const po = await seedTwoLinePo(10, 10)
  await lockAt({ id: po.id, lineId: po.lineA, reference: po.reference })
  const { receivePurchaseOrder, createInvoice, returnPurchaseOrder } = await import('@/app/actions/purchase-orders')
  assert.equal((await receivePurchaseOrder(po.id, [{ poLineId: po.lineA, qtyReceived: 10, warehouseId }, { poLineId: po.lineB, qtyReceived: 10, warehouseId }])).success, true)
  assert.equal((await createInvoice(po.id, { invoiceDate: BILL_DATE, invoiceNumber: `SUP-YG-${++seq}`, lines: [
    { kind: 'product', poLineId: po.lineA, qtyBilled: 10, unitCostForeign: 12.5 }, { kind: 'product', poLineId: po.lineB, qtyBilled: 10, unitCostForeign: 18.75 },
  ] } as never)).success, true)
  assert.equal((await returnPurchaseOrder(po.id, [{ poLineId: po.lineA, qtyReturned: 4, warehouseId }], 'damaged')).success, true)
  assert.equal((await returnPurchaseOrder(po.id, [{ poLineId: po.lineB, qtyReturned: 2, warehouseId }], 'damaged')).success, true)
  const drafts = await s.db.supplierCreditNote.findMany({ where: { poId: po.id }, orderBy: { createdAt: 'asc' } })
  assert.equal(drafts.length, 2)
  const [creditA, creditB] = drafts as [typeof drafts[0], typeof drafts[0]]
  // B's credit first: it must clear line B (2 x 7.8125), not the earlier-id line A.
  const posted = await withXeroPosting(() => postCredit(creditB.id))
  assert.equal(posted.success, true, String(posted.error))
  const rowsB = await s.db.grirSubledgerMovement.findMany({ where: { sourceRef: creditB.id, sourceType: 'SUPPLIER_CREDIT_NOTE' }, select: { poLineId: true, baseDelta: true } })
  assert.deepEqual(rowsB.map((r) => [r.poLineId, Number(r.baseDelta)]), [[po.lineB, 15.625]])
  const log = await s.db.accountingSyncLog.findFirstOrThrow({ where: { type: 'PURCHASE_CREDIT_NOTE', referenceId: creditB.id }, select: { payload: true } })
  assert.deepEqual((log.payload as { lines: Array<{ accountCode: string; unitAmount: number }> }).lines.map((l) => [l.accountCode, l.unitAmount]), [['631', 25], ['5050', 12.5]])
  close(Number((await s.db.transitSubledgerMovement.findFirstOrThrow({ where: { sourceType: 'SUPPLIER_CREDIT_NOTE', sourceRef: creditB.id } })).baseDelta), -15.625, 'stock part only')
  // A's draft is deleted (never posted): line A stays returned and not credited, nothing stranded by B.
  await s.db.supplierCreditNote.delete({ where: { id: creditA.id } })
  close((await balance({ id: po.id, lineId: po.lineA, reference: po.reference })).toNumber(), -31.25, 'GR/IR: only line A\'s 4 returned units are billed and not credited (4 x 7.8125)')
})

// [mutation: put a returned line's whole PPV on its own pro-rata plan line (o3d-tqs3o): negative transit and VAT lines]
test('o3d-tqs3o end to end: a reverse-charge return credit whose line PPV exceeds its pro-rata share: PPV capped per plan line, no negative line, transit nets', async () => {
  const rc = await s.db.taxRate.create({ data: { name: `ZQ RC 20 ${++seq}`, rate: '0.2', usedFor: 'PURCHASE', active: true, reverseCharge: true, accountingTaxType: 'ECACQGOODS' }, select: { id: true } })
  const po = await seedTwoLinePo(10, 100, rc.id)
  await lockAt({ id: po.id, lineId: po.lineA, reference: po.reference })
  const { receivePurchaseOrder, createInvoice, returnPurchaseOrder } = await import('@/app/actions/purchase-orders')
  assert.equal((await receivePurchaseOrder(po.id, [{ poLineId: po.lineA, qtyReceived: 10, warehouseId }, { poLineId: po.lineB, qtyReceived: 100, warehouseId }])).success, true)
  // Line A dearer (25 against 12.5: half of it is price variance), line B at the order's cost and much larger (its pro-rata share dominates).
  const billed = await createInvoice(po.id, { invoiceDate: BILL_DATE, invoiceNumber: `SUP-RC-${++seq}`, lines: [
    { kind: 'product', poLineId: po.lineA, qtyBilled: 10, unitCostForeign: 25 }, { kind: 'product', poLineId: po.lineB, qtyBilled: 100, unitCostForeign: 12.5 },
  ] } as never)
  assert.equal(billed.success, true, String(billed.error))
  assert.equal((await returnPurchaseOrder(po.id, [{ poLineId: po.lineA, qtyReturned: 2, warehouseId }], 'damaged')).success, true)
  const credit = await s.db.supplierCreditNote.findFirstOrThrow({ where: { poId: po.id } })
  close(Number(credit.amountForeign), 50, '2 x 25')
  const posted = await withXeroPosting(() => postCredit(credit.id))
  assert.equal(posted.success, true, String(posted.error))
  const payload = (await s.db.accountingSyncLog.findFirstOrThrow({ where: { type: 'PURCHASE_CREDIT_NOTE', referenceId: credit.id }, select: { payload: true } })).payload as {
    lines: Array<{ accountCode: string; unitAmount: number; taxAmount?: number }>
  }
  assert.ok(payload.lines.every((l) => l.unitAmount > 0 && (l.taxAmount ?? 0) >= 0), `no negative or zero line: ${JSON.stringify(payload.lines)}`)
  const sum = (code: string) => payload.lines.filter((l) => l.accountCode === code).reduce((a, l) => a + l.unitAmount, 0)
  close(sum('5050'), 25, 'the whole PPV of the returned units (2 x 12.5), though line A\'s own plan share is far smaller')
  close(sum('631'), 25, 'the stock part on transit')
  close(Number((await s.db.transitSubledgerMovement.findFirstOrThrow({ where: { sourceType: 'SUPPLIER_CREDIT_NOTE', sourceRef: credit.id } })).baseDelta), -15.625, 'transit gets back the returned goods (2 x 7.8125)')
  close((await balance({ id: po.id, lineId: po.lineA, reference: po.reference })).toNumber(), 0, 'GR/IR nets to zero')
})
