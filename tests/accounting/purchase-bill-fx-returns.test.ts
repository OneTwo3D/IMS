/**
 * PER-EVENT FX RATES FOR PURCHASING, STEP 3b (returns, supplier credit notes and the review follow-ups), against a real scratch database and the real
 * actions (permission, cache and outbound hooks stubbed), in the harness of tests/accounting/purchase-bill-fx.test.ts. Xero is never reached: bills and
 * credits are recorded with Xero sync off, the PURCHASE_BILL transit row a queued bill writes is seeded where an FX journal must be owed, and the
 * outbox is read and never drained.
 *
 * Every arm names the mutation that turns it red.
 */
import assert from 'node:assert/strict'
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

// [mutation: let a return before the bill leave its quantity in the lots]
test('return before the bill: the returned goods are no longer received, so the bill matches only what is left', async () => {
  const po = await seedPo(10)
  assert.equal((await receive(po, 10)).success, true) // table 1.25: 100
  assert.equal((await returnGoods(po, 2)).success, true)
  close(await grir(po, 'SUPPLIER_RETURN'), -20, 'the return at the layers\' goods cost')
  assert.equal(await s.db.supplierCreditNote.count({ where: { poId: po.id } }), 0, 'nothing billed yet: no credit')
  await lockAt(po)
  assert.equal((await bill(po, 8, 12.5)).success, true) // at the lock: 62.5
  close(await grir(po, 'BILL_FX_VARIANCE'), 62.5 - 80, 'the 8 left, at the receipt\'s 10')
  close((await balance(po)).toNumber(), 0, 'GR/IR nets to zero')
  const journal = await reconcileWithPosting(po)
  close(journal.transitNet, 17.5, 'transit: -100 + 20 + 62.5 = -17.5, cleared')
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

  const noRate = await seedPo(5, NO_RATE_CURRENCY)
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
  setPurchaseEventFxStepsCompleteForTests(null)
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
  setPurchaseEventFxStepsCompleteForTests(null)
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
  setPurchaseEventFxStepsCompleteForTests(null)
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
