import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * Unpaid-invoice deferral (FRS 102 s23.10): an UNPAID order whose AUTHORISED invoice IMS posted after the switch
 * `xero_defer_unpaid_invoiced_revenue_enabled` went on has its unshipped revenue deferred by Group A1, dated on the
 * invoice's document day, and released by Group B on each shipment's day — through the real daily batch and refund
 * service against a real Postgres.
 *
 * Offline: the batch only writes PENDING sync-log rows and the refund service only RETURNS its syncs; nothing reaches
 * Xero. Every test asserts that the journals it produced balance. Gated behind RUN_DB_CONCURRENCY_TESTS=1.
 */

const skip = process.env.RUN_DB_CONCURRENCY_TESTS !== '1'

const SWITCH = 'xero_defer_unpaid_invoiced_revenue_enabled'
const SWITCH_AT = 'xero_defer_unpaid_invoiced_revenue_enabled_at'
const DAY = 24 * 60 * 60 * 1000

async function openRig() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const [{ Prisma, PrismaClient }, { PrismaPg }, { createSalesOrderRefund }, { runDailyBatchSync }, { db: appDb }, { businessDay }, { completeAccountingDocumentDeletion }, { markInvoiceBasisDeferralUnwindOwed }, { collectAccountingInvariantRows, evaluateAccountingInvariantRows }] = await Promise.all([
    import('@/app/generated/prisma/client'),
    import('@prisma/adapter-pg'),
    import('@/lib/domain/sales/refund-service'),
    import('@/lib/connectors/xero/daily-sync'),
    import('@/lib/db'),
    import('@/lib/domain/accounting/daily-batch-event-date'),
    import('@/lib/domain/accounting/document-delete-service'),
    import('@/lib/domain/accounting/invoice-basis-deferral'),
    import('@/lib/domain/accounting/invariants'),
  ])
  const { cancelSalesOrderFulfillmentState } = await import('@/lib/domain/sales/allocation-service')
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 4 }) })
  return { Prisma, db, appDb, createSalesOrderRefund, runDailyBatchSync, businessDay, completeAccountingDocumentDeletion, markInvoiceBasisDeferralUnwindOwed, collectAccountingInvariantRows, evaluateAccountingInvariantRows, cancelSalesOrderFulfillmentState }
}
type Rig = Awaited<ReturnType<typeof openRig>>

const SETTINGS: Array<[string, string]> = [
  ['xero_sync_enabled', 'true'], ['xero_cogs_account', '5000'], ['xero_inventory_account', '1200'],
  ['xero_allocated_inventory_account', '1210'], ['xero_unearned_revenue_account', '2100'], ['xero_sales_account', '4000'],
]
const accountingSettings = {
  connector: 'xero', syncEnabled: true, salesAccount: '4000', shippingAccount: '4010', discountAccount: '', cogsAccount: '5000',
  inventoryRevaluationAccount: '', inventoryAccount: '1200', allocatedInventoryAccount: '1210', unearnedRevenueAccount: '2100',
  transitAccount: '', accountsReceivableAccount: '', accountsPayableAccount: '', realisedFxGainLossAccount: '',
  unrealisedFxGainLossAccount: '', manufacturingOverheadAccount: '', euVatIossAccount: '', euVatDdpAccount: '', euFeeAccount: '',
  roundingDifferenceAccount: '', paymentAccountMap: '{}', invoiceUrlTemplate: '', billUrlTemplate: '', reverseChargeSalesTaxType: '',
} as never

type Line = { accountCode: string; debit?: number; credit?: number }
type Journal = { type: string; date: string; lines: Line[]; narration: string }

const noonDaysAgo = (days: number) => {
  const d = new Date(Date.now() - days * DAY)
  d.setUTCHours(12, 0, 0, 0)
  return d
}
const ymd = (d: Date) => d.toISOString().slice(0, 10)

/**
 * An order of 4 units at 100 each, allocated 4 from one warehouse, invoiced (`INV-<suffix>`). `invoice` writes the
 * SALES_INVOICE sync row the proof reads: synced `syncedAgoMs` ago, sent in `mode`, with document date `docDay`.
 */
async function seed(rig: Rig, suffix: string, opts: {
  paidAt?: Date
  allocatedAt?: Date
  invoice?: { mode: string; docDay: string; syncedAt: Date } | null
}) {
  const { Prisma, db } = rig
  const D = (v: string | number) => new Prisma.Decimal(String(v))
  const product = await db.product.create({ data: { sku: `IB-${suffix}`, name: `ib ${suffix}`, type: 'SIMPLE' }, select: { id: true } })
  const main = await db.warehouse.create({ data: { code: `IM${suffix.slice(0, 8)}`, name: `ib main ${suffix}` }, select: { id: true } })
  const layer = await db.costLayer.create({
    data: { productId: product.id, warehouseId: main.id, receivedQty: D(4), remainingQty: D(4), unitCostBase: D('10') },
    select: { id: true },
  })
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `IB-${suffix.slice(0, 8)}`, status: 'ALLOCATED', currency: 'GBP', fxRateToBase: D('1'),
      subtotalForeign: D(400), totalForeign: D(400), subtotalBase: D(400), taxBase: D('0'), totalBase: D(400),
      accountingInvoiceId: `INV-${suffix}`,
      ...(opts.paidAt ? { paidAt: opts.paidAt } : {}),
      lines: { create: [{ productId: product.id, description: 'ib', qty: D(4), unitPriceForeign: D('100'), unitPriceBase: D('100'), taxForeign: D('0'), taxBase: D('0'), totalForeign: D(400), totalBase: D(400) }] },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  const lineId = order.lines[0].id
  await db.orderAllocation.create({ data: { orderId: order.id, lineId, productId: product.id, warehouseId: main.id, qty: D(4), ...(opts.allocatedAt ? { createdAt: opts.allocatedAt } : {}) } })
  await db.stockLevel.create({ data: { productId: product.id, warehouseId: main.id, quantity: D('0'), reservedQty: D('0') } })
  if (opts.invoice) {
    await db.accountingSyncLog.create({
      data: {
        type: 'SALES_INVOICE', status: 'SYNCED', referenceType: 'SalesOrder', referenceId: order.id,
        externalTransactionId: `INV-${suffix}`, syncedAt: opts.invoice.syncedAt,
        payload: { _postingMode: opts.invoice.mode, date: opts.invoice.docDay, invoiceNumber: `INV-${suffix}` },
      },
    })
  }
  const ids = { productId: product.id, mainId: main.id, orderId: order.id, lineId, layerId: layer.id, shipmentIds: [] as string[] }
  const ship = async (units: number, shippedAt: Date = new Date()) => {
    const shipment = await db.shipment.create({
      data: {
        orderId: order.id, warehouseId: main.id, status: 'SHIPPED', shippedAt, createdAt: new Date(Date.now() - 60_000 + ids.shipmentIds.length * 1000),
        lines: { create: [{ lineId, productId: product.id, qty: D(units), costLayerSnapshot: [{ costLayerId: layer.id, qty: String(units), unitCostBase: '10' }] }] },
      },
      select: { id: true },
    })
    await db.costLayer.update({ where: { id: layer.id }, data: { remainingQty: { decrement: D(units) } } })
    ids.shipmentIds.push(shipment.id)
    return shipment.id
  }
  return { ...ids, ship }
}
type Fixture = Awaited<ReturnType<typeof seed>>

const BATCH_TYPES = ['DAILY_BATCH_REVENUE_DEFERRAL', 'DAILY_BATCH_INVENTORY_ALLOC', 'DAILY_BATCH_GROUP_B', 'DAILY_BATCH_INVENTORY_RECONCILIATION', 'DAILY_BATCH_COGS_RECONCILIATION', 'DAILY_BATCH_TRANSIT_RECONCILIATION'] as const

async function clean(rig: Rig, fixtures: Fixture[]) {
  const { db } = rig
  await db.accountingSyncLog.deleteMany({ where: { type: { in: [...BATCH_TYPES] } } }).catch(() => {})
  await db.cogsSubledgerMovement.deleteMany({ where: { OR: [{ idempotencyKey: { startsWith: 'dispatch:' } }, { idempotencyKey: { startsWith: 'refund-unjournaled-return:' } }] } }).catch(() => {})
  await db.setting.deleteMany({ where: { key: { in: [SWITCH, SWITCH_AT, 'plugin_xero_enabled'] } } }).catch(() => {})
  for (const fx of fixtures) {
    await db.accountingSyncLog.deleteMany({ where: { referenceType: 'SalesOrder', referenceId: fx.orderId } }).catch(() => {})
    await db.wmsOperatorTask.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
    await db.accountingSyncLog.deleteMany({ where: { referenceType: 'SalesOrderRefund', referenceId: { in: (await db.salesOrderRefund.findMany({ where: { orderId: fx.orderId }, select: { id: true } })).map((r) => r.id) } } }).catch(() => {})
    await db.accountingDocumentDeletion.deleteMany({ where: { documentId: fx.orderId } }).catch(() => {})
    await db.activityLog.deleteMany({ where: { entityId: fx.orderId } }).catch(() => {})
    await db.integrationOutbox.deleteMany({ where: { operation: 'refund.reservation-release', payloadJson: { path: ['orderId'], equals: fx.orderId } } }).catch(() => {})
    await db.stockMovement.deleteMany({ where: { productId: fx.productId } }).catch(() => {})
    await db.costLayerSourceLine.deleteMany({ where: { costLayer: { productId: fx.productId } } }).catch(() => {})
    await db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId: fx.orderId } } }).catch(() => {})
    await db.salesOrderRefund.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
    await db.shipmentLine.deleteMany({ where: { shipment: { orderId: fx.orderId } } }).catch(() => {})
    await db.shipment.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
    await db.orderAllocation.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
    await db.salesOrderLine.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
    await db.salesOrder.delete({ where: { id: fx.orderId } }).catch(() => {})
    await db.costLayer.deleteMany({ where: { productId: fx.productId } }).catch(() => {})
    await db.stockLevel.deleteMany({ where: { productId: fx.productId } }).catch(() => {})
    await db.warehouse.deleteMany({ where: { id: fx.mainId } }).catch(() => {})
    await db.product.delete({ where: { id: fx.productId } }).catch(() => {})
  }
}

async function close(rig: Rig) {
  await rig.db.$disconnect()
  await rig.appDb.$disconnect()
}

async function journals(rig: Rig): Promise<Journal[]> {
  const rows = await rig.db.accountingSyncLog.findMany({
    where: { type: { in: ['DAILY_BATCH_REVENUE_DEFERRAL', 'DAILY_BATCH_INVENTORY_ALLOC', 'DAILY_BATCH_GROUP_B', 'ALLOCATION_REVERSAL'] }, status: { not: 'CANCELLED' } },
    select: { type: true, payload: true },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map((row) => {
    const payload = row.payload as { lines: Line[]; date: string; narration: string }
    return { type: row.type as string, date: payload.date, lines: payload.lines, narration: payload.narration }
  })
}
const cents = (n: number) => Math.round(n * 100)
function assertBalanced(list: Journal[], label: string) {
  for (const journal of list) {
    const debit = journal.lines.reduce((s, l) => s + (l.debit ?? 0), 0)
    const credit = journal.lines.reduce((s, l) => s + (l.credit ?? 0), 0)
    assert.equal(cents(debit), cents(credit), `${label}: ${journal.type} journal balances (DR ${debit} / CR ${credit})`)
  }
}
function net(list: Journal[], account: string, type?: string): number {
  return list.filter((j) => !type || j.type === type).flatMap((j) => j.lines).filter((l) => l.accountCode === account).reduce((s, l) => s + (l.debit ?? 0) - (l.credit ?? 0), 0)
}

async function setup(rig: Rig, switchOn: { since: Date } | 'off' | 'value-only') {
  for (const [key, value] of SETTINGS) await rig.db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  if (switchOn === 'off') return
  await rig.db.setting.upsert({ where: { key: SWITCH }, create: { key: SWITCH, value: 'true' }, update: { value: 'true' } })
  if (switchOn === 'value-only') return
  const at = switchOn.since.toISOString()
  await rig.db.setting.upsert({ where: { key: SWITCH_AT }, create: { key: SWITCH_AT, value: at }, update: { value: at } })
}

const suffixOf = () => randomUUID().replace(/-/g, '').slice(0, 12)

test('unpaid-invoice deferral: unpaid, unshipped: A1 defers the whole order on the invoice day; each shipment releases its part on the day it ships', { skip }, async () => {
  const rig = await openRig()
  const fixtures: Fixture[] = []
  try {
    await clean(rig, [])
    await setup(rig, { since: new Date(Date.now() - 10 * DAY) })
    const docDay = ymd(noonDaysAgo(5))
    const fx = await seed(rig, suffixOf(), { invoice: { mode: 'submitted', docDay, syncedAt: new Date(Date.now() - 5 * DAY) } })
    fixtures.push(fx)

    const run1 = await rig.runDailyBatchSync()
    assert.deepEqual(run1.errors, [])
    assert.equal(run1.groupA1, 1)
    const afterA1 = await journals(rig)
    assertBalanced(afterA1, 'deferral')
    const a1 = afterA1.filter((j) => j.type === 'DAILY_BATCH_REVENUE_DEFERRAL')
    assert.equal(a1.length, 1)
    assert.equal(a1[0].date, docDay, 'dated on the invoice document day, not today and not a payment day')
    assert.equal(net(a1, '4000'), 400, 'DR Sales 400')
    assert.equal(net(a1, '2100'), -400, 'CR Unearned Revenue 400 (the existing account)')
    const order = await rig.db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
    assert.equal(order.revenueDeferralBasis, 'INVOICE')
    assert.equal(order.revenueDeferralEventAt?.toISOString().slice(0, 10), docDay)
    assert.equal(order.paidAt, null)
    assert.equal(Number(order.unearnedRevenueAmount), 400)

    // Idempotent: a rerun posts nothing more.
    const rerun = await rig.runDailyBatchSync()
    assert.deepEqual(rerun.errors, [])
    assert.equal(rerun.groupA1, 0)
    assert.equal((await journals(rig)).filter((j) => j.type === 'DAILY_BATCH_REVENUE_DEFERRAL').length, 1)

    // First shipment (2 units) two days ago, still unpaid: released on its own day.
    const ship1Day = noonDaysAgo(2)
    await fx.ship(2, ship1Day)
    const run2 = await rig.runDailyBatchSync()
    assert.deepEqual(run2.errors, [])
    const b1 = (await journals(rig)).filter((j) => j.type === 'DAILY_BATCH_GROUP_B')
    assert.equal(b1.length, 1)
    assert.equal(b1[0].date, rig.businessDay(ship1Day), 'released on the day the goods shipped')
    assert.equal(net(b1, '2100'), 200, 'DR Unearned 200 (half the order)')
    assert.equal(net(b1, '4000'), -200, 'CR Sales 200')
    assert.equal(net(b1, '5000'), 20, 'DR COGS 20')
    assert.equal(net(b1, '1210'), -20, 'CR Allocated Inventory 20 (A2 reclassified it)')

    // The rest ships today; the order completes. Everything nets to zero.
    await fx.ship(2)
    await rig.db.salesOrder.update({ where: { id: fx.orderId }, data: { status: 'SHIPPED' } })
    const run3 = await rig.runDailyBatchSync()
    assert.deepEqual(run3.errors, [])
    const all = await journals(rig)
    assertBalanced(all, 'final')
    assert.equal(net(all, '2100'), 0, 'Unearned Revenue nets to zero')
    assert.equal(net(all, '4000'), 0, 'Sales back where the invoice put it')
    assert.equal(net(all, '1210'), 0, 'Allocated Inventory nets to zero')
    assert.equal(net(all, '5000'), 40, 'COGS once per unit')
  } finally {
    await clean(rig, fixtures)
    await close(rig)
  }
})

test('unpaid-invoice deferral: partially shipped before the first run: the shipped part is costed directly and stays in Sales; A1 defers only the unshipped part', { skip }, async () => {
  const rig = await openRig()
  const fixtures: Fixture[] = []
  try {
    await clean(rig, [])
    await setup(rig, { since: new Date(Date.now() - 10 * DAY) })
    const docDay = ymd(noonDaysAgo(4))
    const fx = await seed(rig, suffixOf(), { invoice: { mode: 'submitted', docDay, syncedAt: new Date(Date.now() - 4 * DAY) } })
    fixtures.push(fx)
    await fx.ship(2, noonDaysAgo(3))

    const run = await rig.runDailyBatchSync()
    assert.deepEqual(run.errors, [])
    const all = await journals(rig)
    assertBalanced(all, 'partial')
    const direct = all.filter((j) => j.type === 'DAILY_BATCH_GROUP_B')
    assert.equal(direct.length, 1, 'the direct pass costed the shipment first')
    assert.equal(net(direct, '5000'), 20)
    assert.equal(net(direct, '1200'), -20, 'straight out of Inventory')
    assert.equal(net(direct, '2100') + net(direct, '4000'), 0, 'no revenue leg for the costed shipment')
    const a1 = all.filter((j) => j.type === 'DAILY_BATCH_REVENUE_DEFERRAL')
    assert.equal(a1.length, 1)
    assert.equal(a1[0].date, docDay)
    assert.equal(net(a1, '2100'), -200, 'only the unshipped half is deferred')
    const order = await rig.db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
    assert.equal(order.revenueDeferralBasis, 'INVOICE')
    assert.equal(Number(order.unearnedRevenueAmount), 400, 'the order keeps the full figure, as for a paid order')
    const a2 = all.filter((j) => j.type === 'DAILY_BATCH_INVENTORY_ALLOC')
    assert.equal(net(a2, '1210'), 20, 'A2 reclassifies only the 2 units still to ship')

    await fx.ship(2)
    await rig.db.salesOrder.update({ where: { id: fx.orderId }, data: { status: 'SHIPPED' } })
    assert.deepEqual((await rig.runDailyBatchSync()).errors, [])
    const final = await journals(rig)
    assertBalanced(final, 'final')
    assert.equal(net(final, '2100'), 0, 'Unearned nets to zero: 200 deferred, 200 released')
    assert.equal(net(final, '1210'), 0)
    assert.equal(net(final, '5000'), 40)
  } finally {
    await clean(rig, fixtures)
    await close(rig)
  }
})

test('unpaid-invoice deferral: deferred from the invoice, shipped, THEN paid: the release is dated the ship day, not the later payment day', { skip }, async () => {
  const rig = await openRig()
  const fixtures: Fixture[] = []
  try {
    await clean(rig, [])
    await setup(rig, { since: new Date(Date.now() - 10 * DAY) })
    const docDay = ymd(noonDaysAgo(6))
    const fx = await seed(rig, suffixOf(), { allocatedAt: noonDaysAgo(6), invoice: { mode: 'submitted', docDay, syncedAt: new Date(Date.now() - 6 * DAY) } })
    fixtures.push(fx)
    assert.deepEqual((await rig.runDailyBatchSync()).errors, [])
    const shipDay = noonDaysAgo(3)
    await fx.ship(4, shipDay)
    await rig.db.salesOrder.update({ where: { id: fx.orderId }, data: { status: 'SHIPPED', paidAt: noonDaysAgo(1) } })
    const run = await rig.runDailyBatchSync()
    assert.deepEqual(run.errors, [])
    const all = await journals(rig)
    assertBalanced(all, 'shipped then paid')
    const b = all.filter((j) => j.type === 'DAILY_BATCH_GROUP_B')
    assert.equal(b.length, 1)
    assert.equal(b[0].date, rig.businessDay(shipDay), 'released on the ship day; the later payment does not delay it')
    const a2 = all.filter((j) => j.type === 'DAILY_BATCH_INVENTORY_ALLOC')
    assert.equal(a2.length, 1)
    assert.equal(a2[0].date, docDay, 'A2 is dated from the invoice deferral and the allocation day, not a payment')
    assert.equal(net(all, '2100'), 0)
    assert.equal(net(all, '1210'), 0)
    const order = await rig.db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
    assert.equal(order.revenueDeferralBasis, 'INVOICE', 'payment does not change the basis')
  } finally {
    await clean(rig, fixtures)
    await close(rig)
  }
})

/** The journals of one paid-then-shipped order with every id-derived token removed, so two runs can be compared. */
async function paidThenShippedShape(rig: Rig, switchSetting: { since: Date } | 'off') {
  const fixtures: Fixture[] = []
  try {
    await clean(rig, [])
    await setup(rig, switchSetting)
    const paidAt = noonDaysAgo(4)
    const fx = await seed(rig, suffixOf(), { paidAt, invoice: { mode: 'submitted', docDay: ymd(noonDaysAgo(6)), syncedAt: new Date(Date.now() - 6 * DAY) } })
    fixtures.push(fx)
    assert.deepEqual((await rig.runDailyBatchSync()).errors, [])
    await fx.ship(4, noonDaysAgo(2))
    await rig.db.salesOrder.update({ where: { id: fx.orderId }, data: { status: 'SHIPPED' } })
    assert.deepEqual((await rig.runDailyBatchSync()).errors, [])
    const all = await journals(rig)
    assertBalanced(all, 'paid then shipped')
    const order = await rig.db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
    return {
      journals: all.map((j) => ({ type: j.type, date: j.date, lines: j.lines, narration: j.narration.replace(/[0-9a-f]{8}\b/g, '') })),
      basis: order.revenueDeferralBasis,
      eventAt: order.revenueDeferralEventAt,
      unearned: Number(order.unearnedRevenueAmount),
      paidDay: rig.businessDay(paidAt),
    }
  } finally {
    await clean(rig, fixtures)
  }
}

test('unpaid-invoice deferral: paid then shipped is unchanged by the switch: same journals, same dates (the payment day)', { skip }, async () => {
  const rig = await openRig()
  try {
    const off = await paidThenShippedShape(rig, 'off')
    const on = await paidThenShippedShape(rig, { since: new Date(Date.now() - 10 * DAY) })
    assert.deepEqual(on.journals, off.journals, 'identical journals with the switch on and off')
    const a1 = off.journals.find((j) => j.type === 'DAILY_BATCH_REVENUE_DEFERRAL')
    assert.equal(a1?.date, off.paidDay, 'a paid order is still deferred on its payment day')
    assert.equal(off.basis, null, 'switch off writes no basis')
    assert.equal(on.basis, 'PAID')
    assert.equal(on.eventAt, null)
    assert.equal(on.unearned, off.unearned)
  } finally {
    await close(rig)
  }
})

test('unpaid-invoice deferral: switch OFF (and the refusals with it on): an unpaid invoiced order is never deferred and the batch output is what it was', { skip }, async () => {
  const rig = await openRig()
  const fixtures: Fixture[] = []
  try {
    const cases: Array<{ label: string; switchSetting: { since: Date } | 'off' | 'value-only'; invoice: { mode: string; docDay: string; syncedAt: Date } | null }> = [
      { label: 'switch off', switchSetting: 'off', invoice: { mode: 'submitted', docDay: ymd(noonDaysAgo(2)), syncedAt: new Date() } },
      { label: 'switch on without its switch-on instant', switchSetting: 'value-only', invoice: { mode: 'submitted', docDay: ymd(noonDaysAgo(2)), syncedAt: new Date() } },
      { label: 'invoice posted before switch-on (stays in Sales, no backfill)', switchSetting: { since: new Date() }, invoice: { mode: 'submitted', docDay: ymd(noonDaysAgo(2)), syncedAt: new Date(Date.now() - DAY) } },
      { label: 'DRAFT-mode invoice', switchSetting: { since: new Date(Date.now() - 10 * DAY) }, invoice: { mode: 'draft', docDay: ymd(noonDaysAgo(2)), syncedAt: new Date() } },
      { label: 'no proof row (Xeroom or hand-linked invoice)', switchSetting: { since: new Date(Date.now() - 10 * DAY) }, invoice: null },
    ]
    for (const c of cases) {
      await clean(rig, fixtures.splice(0))
      await setup(rig, c.switchSetting)
      const fx = await seed(rig, suffixOf(), { invoice: c.invoice })
      fixtures.push(fx)
      const run = await rig.runDailyBatchSync()
      assert.deepEqual(run.errors, [], c.label)
      assert.equal(run.groupA1, 0, `${c.label}: nothing deferred`)
      assert.equal((await journals(rig)).length, 0, `${c.label}: no journal`)
      const order = await rig.db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
      assert.equal(order.revenueDeferredDate, null, c.label)
      assert.equal(order.revenueDeferralBasis, null, c.label)
      // Shipping it takes the existing ACC-H12 path: costed directly, no revenue leg.
      await fx.ship(4)
      assert.deepEqual((await rig.runDailyBatchSync()).errors, [], c.label)
      const after = await journals(rig)
      assert.equal(after.length, 1, `${c.label}: only the direct cost journal`)
      assert.equal(after[0].type, 'DAILY_BATCH_GROUP_B')
      assert.equal(net(after, '2100') + net(after, '4000'), 0, `${c.label}: no revenue leg`)
    }
  } finally {
    await clean(rig, fixtures)
    await close(rig)
  }
})

test('unpaid-invoice deferral: refunds of an invoice-deferred unpaid order: a pre-batch refund is netted (dated from the invoice day), a later refund reverses Unearned, a full refund clears the basis', { skip }, async () => {
  const rig = await openRig()
  const fixtures: Fixture[] = []
  try {
    await clean(rig, [])
    await setup(rig, { since: new Date(Date.now() - 10 * DAY) })
    const docDay = ymd(noonDaysAgo(5))
    const fx = await seed(rig, suffixOf(), { invoice: { mode: 'submitted', docDay, syncedAt: new Date(Date.now() - 5 * DAY) } })
    fixtures.push(fx)

    // 1. A refund of one unit entered BEFORE the first run (a cancelled line on an unpaid order).
    const pre = await rig.createSalesOrderRefund(rig.db, {
      orderId: fx.orderId,
      lines: [{ lineId: fx.lineId, productId: fx.productId, description: 'ib', qty: 1, totalBase: 100 }],
      reason: 'Cancelled line', creditNotePrefix: `IB${fx.orderId.slice(-6)}a-`,
      accountingSettings, activeAccountingConnector: 'xero',
    })
    assert.equal(pre.success, true, `pre-batch refund (${pre.success ? '' : pre.error})`)
    const run1 = await rig.runDailyBatchSync()
    assert.deepEqual(run1.errors, [])
    const a1 = (await journals(rig)).filter((j) => j.type === 'DAILY_BATCH_REVENUE_DEFERRAL')
    assertBalanced(a1, 'deferral + adjustment')
    const paidDay = a1.find((j) => !/adjustment/i.test(j.narration))
    const adjustment = a1.find((j) => /adjustment/i.test(j.narration))
    assert.ok(paidDay && adjustment, 'the invoice-day deferral and the refund adjustment')
    assert.equal(paidDay!.date, docDay)
    assert.equal(net([paidDay!], '2100'), -400, 'the deferral journal carries the gross 400')
    assert.equal(net([adjustment!], '2100'), 100, 'the pre-batch refund comes back out of Unearned')
    assert.ok(adjustment!.date >= docDay, 'never dated before the invoice deferral it adjusts')
    let order = await rig.db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
    assert.equal(order.revenueDeferralBasis, 'INVOICE')
    assert.equal(Number(order.unearnedRevenueAmount), 300)

    // 2. A refund of another unit after the deferral: the refund service reverses Unearned for it.
    await rig.db.accountingSyncLog.updateMany({
      where: { type: { in: ['DAILY_BATCH_REVENUE_DEFERRAL', 'DAILY_BATCH_INVENTORY_ALLOC', 'DAILY_BATCH_GROUP_B'] } },
      data: { status: 'SYNCED', syncedAt: new Date(), externalTransactionId: `JNL-${fx.orderId.slice(-6)}` },
    })
    const post = await rig.createSalesOrderRefund(rig.db, {
      orderId: fx.orderId,
      lines: [{ lineId: fx.lineId, productId: fx.productId, description: 'ib', qty: 3, totalBase: 300 }],
      reason: 'Order cancelled', creditNotePrefix: `IB${fx.orderId.slice(-6)}b-`,
      accountingSettings, activeAccountingConnector: 'xero',
    })
    assert.equal(post.success, true, `post-deferral refund (${post.success ? '' : post.error})`)
    if (!post.success) return
    const syncs = post.accountingSyncs as unknown as Array<{ type: string; payload: { lines: Line[] } }>
    const reversal = syncs.find((s) => s.type === 'UNEARNED_REV_REVERSAL')
    assert.ok(reversal, 'an invoice-basis deferral is unwound by the same refund reversal a paid one is')
    const reversalJournal: Journal = { type: 'UNEARNED_REV_REVERSAL', date: '', narration: '', lines: reversal!.payload.lines }
    assertBalanced([reversalJournal], 'reversal')
    const lifetime = [...(await journals(rig)), reversalJournal]
    assert.equal(net(lifetime, '2100'), 0, 'Unearned Revenue nets to zero across deferral, adjustment and reversal')
    assert.equal(net(lifetime, '1210'), 0, 'Allocated Inventory nets to zero')

    // 3. Fully refunded: the deferral stamp and its basis go together.
    order = await rig.db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
    assert.equal(order.refundStatus, 'FULL')
    assert.equal(order.revenueDeferredDate, null)
    assert.equal(order.revenueDeferralBasis, null)
    assert.equal(order.revenueDeferralEventAt, null)
    // And a further run never re-defers it.
    assert.deepEqual((await rig.runDailyBatchSync()).errors, [])
    assert.equal((await journals(rig)).filter((j) => j.type === 'DAILY_BATCH_REVENUE_DEFERRAL').length, 2)
  } finally {
    await clean(rig, fixtures)
    await close(rig)
  }
})

test('unpaid-invoice deferral: a cancelled unpaid order is never deferred, even with a proved invoice', { skip }, async () => {
  const rig = await openRig()
  const fixtures: Fixture[] = []
  try {
    await clean(rig, [])
    await setup(rig, { since: new Date(Date.now() - 10 * DAY) })
    const fx = await seed(rig, suffixOf(), { invoice: { mode: 'submitted', docDay: ymd(noonDaysAgo(2)), syncedAt: new Date() } })
    fixtures.push(fx)
    await rig.db.salesOrder.update({ where: { id: fx.orderId }, data: { status: 'CANCELLED' } })
    const run = await rig.runDailyBatchSync()
    assert.deepEqual(run.errors, [])
    assert.equal(run.groupA1, 0)
    assert.equal((await journals(rig)).length, 0)
  } finally {
    await clean(rig, fixtures)
    await close(rig)
  }
})

/** Settle every batch journal as posted (the refund and unwind paths ask whether the deferral reached the ledger). */
async function settleBatchJournals(rig: Rig, tag: string) {
  await rig.db.accountingSyncLog.updateMany({
    where: { type: { in: ['DAILY_BATCH_REVENUE_DEFERRAL', 'DAILY_BATCH_INVENTORY_ALLOC', 'DAILY_BATCH_GROUP_B'] }, status: 'PENDING' },
    data: { status: 'SYNCED', syncedAt: new Date(), externalTransactionId: `JNL-${tag}` },
  })
}

async function strandedFindings(rig: Rig, orderId: string) {
  const rows = await rig.collectAccountingInvariantRows(rig.db as never)
  return rig.evaluateAccountingInvariantRows(rows).filter((f) => f.code === 'invoice_basis_deferral_stranded' && f.orderId === orderId)
}

test('unpaid-invoice deferral: the IMS document delete of the invoice owes the unwind in the same transaction; the batch reverses the open deferral and the books net to zero', { skip }, async () => {
  const rig = await openRig()
  const fixtures: Fixture[] = []
  try {
    await clean(rig, [])
    await setup(rig, { since: new Date(Date.now() - 10 * DAY) })
    const docDay = ymd(noonDaysAgo(4))
    const suffix = suffixOf()
    const fx = await seed(rig, suffix, { invoice: { mode: 'submitted', docDay, syncedAt: new Date(Date.now() - 4 * DAY) } })
    fixtures.push(fx)
    assert.deepEqual((await rig.runDailyBatchSync()).errors, [])
    await settleBatchJournals(rig, suffix)
    assert.equal(net(await journals(rig), '2100'), -400, 'deferred 400')

    // The delete was requested and Xero has voided the document: IMS completes the unwind.
    await rig.db.accountingDocumentDeletion.create({
      data: { kind: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: fx.orderId, documentId: fx.orderId, externalDocumentId: `INV-${suffix}`, originalNumber: `INV-${suffix}`, releasedNumber: `INV-${suffix}-X`, targetStatus: 'VOIDED' },
    })
    assert.equal(await rig.completeAccountingDocumentDeletion(`INV-${suffix}`), 'completed')
    let order = await rig.db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
    assert.equal(order.accountingInvoiceId, null)
    assert.ok(order.revenueDeferralUnwindOwedAt, 'the unwind is owed, recorded with the delete')
    assert.equal(order.revenueDeferralUnwindReason, 'INVOICE_DELETED')
    assert.equal((await strandedFindings(rig, fx.orderId)).length, 1, 'the invariant reports the open deferral until the unwind posts')

    const run = await rig.runDailyBatchSync()
    assert.deepEqual(run.errors, [])
    const all = await journals(rig)
    assertBalanced(all, 'unwind')
    const unwind = all.filter((j) => /unwind/i.test(j.narration))
    assert.equal(unwind.length, 1)
    assert.equal(net(unwind, '2100'), 400, 'DR Unearned 400')
    assert.equal(net(unwind, '4000'), -400, 'CR Sales 400')
    assert.equal(net(all, '2100'), 0, 'Unearned Revenue nets to zero')
    assert.equal(net(all, '4000'), 0, 'the deferral and its unwind cancel in Sales; the void took the invoice credit back')
    order = await rig.db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
    assert.equal(Number(order.revenueDeferralUnwoundAmount), 400)
    assert.ok(order.revenueDeferralUnwindRef)
    assert.equal((await strandedFindings(rig, fx.orderId)).length, 0)

    // Idempotent.
    assert.deepEqual((await rig.runDailyBatchSync()).errors, [])
    assert.equal((await journals(rig)).length, all.length, 'a rerun posts no second unwind')
    // And the order cancelled afterwards stays clean.
    await rig.db.salesOrder.update({ where: { id: fx.orderId }, data: { status: 'CANCELLED' } })
    assert.equal((await strandedFindings(rig, fx.orderId)).length, 0)
  } finally {
    await clean(rig, fixtures)
    await close(rig)
  }
})

test('unpaid-invoice deferral: a VOIDED invoice on a partially shipped order unwinds only what is still open; later shipments release nothing more', { skip }, async () => {
  const rig = await openRig()
  const fixtures: Fixture[] = []
  try {
    await clean(rig, [])
    await setup(rig, { since: new Date(Date.now() - 10 * DAY) })
    const suffix = suffixOf()
    const fx = await seed(rig, suffix, { invoice: { mode: 'submitted', docDay: ymd(noonDaysAgo(5)), syncedAt: new Date(Date.now() - 5 * DAY) } })
    fixtures.push(fx)
    assert.deepEqual((await rig.runDailyBatchSync()).errors, [])
    await fx.ship(2, noonDaysAgo(2))
    assert.deepEqual((await rig.runDailyBatchSync()).errors, [])
    await settleBatchJournals(rig, suffix)
    assert.equal(net(await journals(rig), '2100'), -200, '200 still deferred after the first shipment released 200')

    // What the payment poller does for an ACCREC invoice Xero reports VOIDED.
    assert.equal(await rig.markInvoiceBasisDeferralUnwindOwed(rig.db, { accountingInvoiceIds: [`INV-${suffix}`] }, 'INVOICE_VOIDED'), 1)
    assert.equal(await rig.markInvoiceBasisDeferralUnwindOwed(rig.db, { accountingInvoiceIds: [`INV-${suffix}`] }, 'INVOICE_VOIDED'), 0, 'idempotent')
    assert.equal((await strandedFindings(rig, fx.orderId)).length, 1)
    assert.deepEqual((await rig.runDailyBatchSync()).errors, [])
    let all = await journals(rig)
    assertBalanced(all, 'void')
    assert.equal(net(all.filter((j) => /unwind/i.test(j.narration)), '2100'), 200, 'only the open 200 is unwound')
    assert.equal(net(all, '2100'), 0, 'Unearned Revenue nets to zero')
    assert.equal((await strandedFindings(rig, fx.orderId)).length, 0)

    // The rest still ships (stock left): COGS from Allocated as A2 reclassified it, and no revenue is released.
    await fx.ship(2)
    await rig.db.salesOrder.update({ where: { id: fx.orderId }, data: { status: 'SHIPPED' } })
    assert.deepEqual((await rig.runDailyBatchSync()).errors, [])
    all = await journals(rig)
    assertBalanced(all, 'after the rest shipped')
    assert.equal(net(all, '2100'), 0, 'Unearned stays at zero: nothing is released twice')
    assert.equal(net(all, '1210'), 0, 'Allocated Inventory nets to zero')
    assert.equal(net(all, '5000'), 40, 'COGS once per unit')
  } finally {
    await clean(rig, fixtures)
    await close(rig)
  }
})

test('unpaid-invoice deferral: a deferral journal proven never sent is rebuilt first and the unwind follows it (never alone), and a PAID-basis order is never marked', { skip }, async () => {
  const rig = await openRig()
  const fixtures: Fixture[] = []
  try {
    await clean(rig, [])
    await setup(rig, { since: new Date(Date.now() - 10 * DAY) })
    const suffix = suffixOf()
    const fx = await seed(rig, suffix, { invoice: { mode: 'submitted', docDay: ymd(noonDaysAgo(3)), syncedAt: new Date(Date.now() - 3 * DAY) } })
    fixtures.push(fx)
    const paidSuffix = suffixOf()
    const paid = await seed(rig, paidSuffix, { paidAt: noonDaysAgo(2), invoice: { mode: 'submitted', docDay: ymd(noonDaysAgo(3)), syncedAt: new Date(Date.now() - 3 * DAY) } })
    fixtures.push(paid)
    assert.deepEqual((await rig.runDailyBatchSync()).errors, [])
    // Both deferral journals proven never sent.
    await rig.db.accountingSyncLog.updateMany({
      where: { type: 'DAILY_BATCH_REVENUE_DEFERRAL', status: 'PENDING' },
      data: { status: 'CANCELLED', abandonedBeforeRemoteCall: true },
    })
    assert.equal(await rig.markInvoiceBasisDeferralUnwindOwed(rig.db, { accountingInvoiceIds: [`INV-${suffix}`, `INV-${paidSuffix}`] }, 'INVOICE_VOIDED'), 1, 'only the INVOICE-basis order')
    assert.deepEqual((await rig.runDailyBatchSync()).errors, [])
    const live = (await rig.db.accountingSyncLog.findMany({ where: { type: 'DAILY_BATCH_REVENUE_DEFERRAL', status: { not: 'CANCELLED' } }, select: { payload: true } }))
      .map((row) => row.payload as { lines: Line[]; narration: string })
    const liveJournals = live.map((p) => ({ type: 'DAILY_BATCH_REVENUE_DEFERRAL', date: '', lines: p.lines, narration: p.narration }))
    assert.ok(liveJournals.some((j) => /Recreated/.test(j.narration)), 'the lost deferral journal was rebuilt')
    const unwound = liveJournals.filter((j) => /unwind/i.test(j.narration))
    assert.equal(unwound.length, 1)
    assert.equal(net(unwound, '2100'), 400)
    const order = await rig.db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
    assert.equal(Number(order.revenueDeferralUnwoundAmount), 400)
    const paidOrder = await rig.db.salesOrder.findUniqueOrThrow({ where: { id: paid.orderId } })
    assert.equal(paidOrder.revenueDeferralUnwindOwedAt, null, 'a PAID-basis deferral is left to the refund and chargeback paths')
  } finally {
    await clean(rig, fixtures)
    await close(rig)
  }
})

test('unpaid-invoice deferral: a CANCELLED order still holding an open deferral is reported (cancelled orders included)', { skip }, async () => {
  const rig = await openRig()
  const fixtures: Fixture[] = []
  try {
    await clean(rig, [])
    await setup(rig, { since: new Date(Date.now() - 10 * DAY) })
    const fx = await seed(rig, suffixOf(), { invoice: { mode: 'submitted', docDay: ymd(noonDaysAgo(3)), syncedAt: new Date(Date.now() - 3 * DAY) } })
    fixtures.push(fx)
    assert.deepEqual((await rig.runDailyBatchSync()).errors, [])
    assert.equal((await strandedFindings(rig, fx.orderId)).length, 0, 'an ordinary deferred order is not reported')
    await rig.db.salesOrder.update({ where: { id: fx.orderId }, data: { status: 'CANCELLED' } })
    const findings = await strandedFindings(rig, fx.orderId)
    assert.equal(findings.length, 1)
    assert.match(findings[0].message, /cancelled/)
  } finally {
    await clean(rig, fixtures)
    await close(rig)
  }
})

/** The REAL cancel path, as the status action runs it: its own transaction, the order lock, allocation teardown. */
async function cancelOrder(rig: Rig, orderId: string, opts: { automated?: boolean } = {}) {
  // The allocation reversal is pinned to the ACTIVE accounting connector; enable the Xero plugin for this rig.
  await rig.db.setting.upsert({ where: { key: 'plugin_xero_enabled' }, create: { key: 'plugin_xero_enabled', value: 'true' }, update: { value: 'true' } })
  await rig.db.stockLevel.updateMany({ where: { product: { salesOrderLines: { some: { orderId } } } }, data: { quantity: 4, reservedQty: 4 } })
  return rig.appDb.$transaction((tx) => rig.cancelSalesOrderFulfillmentState(tx as never, { orderId, automated: opts.automated }), { timeout: 30_000 })
}

function allocStranded(rig: Rig, rows: Awaited<ReturnType<Rig['collectAccountingInvariantRows']>>, orderId: string) {
  return rig.evaluateAccountingInvariantRows(rows).filter((f) => f.orderId === orderId && /^invoice_basis_/.test(f.code)).map((f) => f.code)
}

test('unpaid-invoice deferral: invoice deleted, then cancelled through the REAL cancel path without a refund: Allocated, Unearned and Sales all net to zero', { skip }, async () => {
  const rig = await openRig()
  const fixtures: Fixture[] = []
  try {
    await clean(rig, [])
    await setup(rig, { since: new Date(Date.now() - 10 * DAY) })
    const docDay = ymd(noonDaysAgo(4))
    const suffix = suffixOf()
    const fx = await seed(rig, suffix, { allocatedAt: noonDaysAgo(4), invoice: { mode: 'submitted', docDay, syncedAt: new Date(Date.now() - 4 * DAY) } })
    fixtures.push(fx)
    assert.deepEqual((await rig.runDailyBatchSync()).errors, [])
    await settleBatchJournals(rig, suffix)
    assert.equal(net(await journals(rig), '1210'), 40, 'A2 reclassified the 4 units')

    await rig.db.accountingDocumentDeletion.create({
      data: { kind: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: fx.orderId, documentId: fx.orderId, externalDocumentId: `INV-${suffix}`, originalNumber: `INV-${suffix}`, releasedNumber: `INV-${suffix}-X`, targetStatus: 'VOIDED' },
    })
    assert.equal(await rig.completeAccountingDocumentDeletion(`INV-${suffix}`), 'completed')
    assert.deepEqual((await rig.runDailyBatchSync()).errors, [])
    const unwind = (await journals(rig)).filter((j) => /unwind/i.test(j.narration))
    assert.equal(unwind.length, 1)
    assert.equal(unwind[0].date, docDay, "the unwind is dated on the deferral journal's own day")

    // A MANUAL operator cancel: no refund is demanded, because there is no invoice left to credit.
    const cancelled = await cancelOrder(rig, fx.orderId)
    assert.equal(cancelled.previousStatus, 'ALLOCATED')
    const order = await rig.db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
    assert.equal(order.status, 'CANCELLED')
    assert.equal(Number(order.allocationReversalAmount), 40, 'the whole open A2 debit was reversed at cancel')
    const all = await journals(rig)
    assertBalanced(all, 'cancelled')
    assert.equal(net(all, '1210'), 0, 'Allocated Inventory nets to zero')
    assert.equal(net(all, '2100'), 0, 'Unearned Revenue nets to zero')
    assert.equal(net(all, '4000'), 0, 'Sales nets to zero (the deleted invoice took its own credit back)')
    assert.equal(net(all, '1200'), 0, 'Inventory is whole again')
    assert.deepEqual(allocStranded(rig, await rig.collectAccountingInvariantRows(rig.db as never), fx.orderId), [])
  } finally {
    await clean(rig, fixtures)
    await close(rig)
  }
})

test('unpaid-invoice deferral: cancelled (automated, invoice still standing) and THEN voided: the unwind also reverses the open Allocated debit; all three accounts net to zero', { skip }, async () => {
  const rig = await openRig()
  const fixtures: Fixture[] = []
  try {
    await clean(rig, [])
    await setup(rig, { since: new Date(Date.now() - 10 * DAY) })
    const suffix = suffixOf()
    const fx = await seed(rig, suffix, { allocatedAt: noonDaysAgo(4), invoice: { mode: 'submitted', docDay: ymd(noonDaysAgo(4)), syncedAt: new Date(Date.now() - 4 * DAY) } })
    fixtures.push(fx)
    assert.deepEqual((await rig.runDailyBatchSync()).errors, [])
    await settleBatchJournals(rig, suffix)
    // A manual cancel is still refused while the invoice stands.
    await assert.rejects(cancelOrder(rig, fx.orderId), /invoice/i)
    // The storefront's own cancel lands and keeps the A2 debit, as before.
    await cancelOrder(rig, fx.orderId, { automated: true })
    assert.equal(net(await journals(rig), '1210'), 40, 'A2 debit kept at the automated cancel')
    assert.deepEqual(allocStranded(rig, await rig.collectAccountingInvariantRows(rig.db as never), fx.orderId), ['invoice_basis_deferral_stranded'], 'cancelled with the deferral open')

    assert.equal(await rig.markInvoiceBasisDeferralUnwindOwed(rig.db, { accountingInvoiceIds: [`INV-${suffix}`] }, 'INVOICE_VOIDED'), 1)
    const run = await rig.runDailyBatchSync()
    assert.deepEqual(run.errors, [])
    const all = await journals(rig)
    assertBalanced(all, 'void after cancel')
    assert.equal(net(all, '1210'), 0, 'Allocated Inventory nets to zero')
    assert.equal(net(all, '2100'), 0, 'Unearned Revenue nets to zero')
    assert.equal(net(all, '4000'), 0, 'Sales nets to zero (the void took the invoice credit back)')
    assert.deepEqual(allocStranded(rig, await rig.collectAccountingInvariantRows(rig.db as never), fx.orderId), [])
  } finally {
    await clean(rig, fixtures)
    await close(rig)
  }
})

test('unpaid-invoice deferral: deleted and then RE-ISSUED: the new invoice re-defers what the unwind took out, and shipping releases it', { skip }, async () => {
  const rig = await openRig()
  const fixtures: Fixture[] = []
  try {
    await clean(rig, [])
    await setup(rig, { since: new Date(Date.now() - 10 * DAY) })
    const suffix = suffixOf()
    const fx = await seed(rig, suffix, { allocatedAt: noonDaysAgo(5), invoice: { mode: 'submitted', docDay: ymd(noonDaysAgo(5)), syncedAt: new Date(Date.now() - 5 * DAY) } })
    fixtures.push(fx)
    assert.deepEqual((await rig.runDailyBatchSync()).errors, [])
    await settleBatchJournals(rig, suffix)
    await rig.db.accountingDocumentDeletion.create({
      data: { kind: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: fx.orderId, documentId: fx.orderId, externalDocumentId: `INV-${suffix}`, originalNumber: `INV-${suffix}`, releasedNumber: `INV-${suffix}-X`, targetStatus: 'VOIDED' },
    })
    assert.equal(await rig.completeAccountingDocumentDeletion(`INV-${suffix}`), 'completed')
    assert.deepEqual((await rig.runDailyBatchSync()).errors, [])
    assert.equal(net(await journals(rig), '2100'), 0, 'unwound')

    // Re-issued: a new AUTHORISED invoice posted for the order after the unwind was owed.
    const newDay = ymd(noonDaysAgo(1))
    await rig.db.salesOrder.update({ where: { id: fx.orderId }, data: { accountingInvoiceId: `INV2-${suffix}` } })
    await rig.db.accountingSyncLog.create({
      data: { type: 'SALES_INVOICE', status: 'SYNCED', referenceType: 'SalesOrder', referenceId: fx.orderId, externalTransactionId: `INV2-${suffix}`, syncedAt: new Date(), payload: { _postingMode: 'submitted', date: newDay } },
    })
    assert.deepEqual((await rig.runDailyBatchSync()).errors, [])
    const redefer = (await journals(rig)).filter((j) => /re-deferral/i.test(j.narration))
    assert.equal(redefer.length, 1)
    assert.equal(redefer[0].date, newDay, "dated the new invoice's document day")
    assert.equal(net(redefer, '2100'), -400, 'CR Unearned 400 again')
    let order = await rig.db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
    assert.equal(order.revenueDeferralUnwoundAmount, null)
    assert.equal(order.revenueDeferralUnwindOwedAt, null)
    assert.deepEqual((await rig.runDailyBatchSync()).errors, [])
    assert.equal((await journals(rig)).filter((j) => /re-deferral/i.test(j.narration)).length, 1, 'idempotent')

    await fx.ship(4)
    await rig.db.salesOrder.update({ where: { id: fx.orderId }, data: { status: 'SHIPPED' } })
    assert.deepEqual((await rig.runDailyBatchSync()).errors, [])
    const all = await journals(rig)
    assertBalanced(all, 're-issued and shipped')
    assert.equal(net(all, '2100'), 0, 'Unearned nets to zero: deferred, unwound, re-deferred, released')
    assert.equal(net(all, '1210'), 0)
    order = await rig.db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
    assert.equal(order.revenueDeferralBasis, 'INVOICE')
  } finally {
    await clean(rig, fixtures)
    await close(rig)
  }
})

test('unpaid-invoice deferral: refund, then Xero void, then the REAL cancel: the A2 reversal is capped by the refund relief; 1210, 1200, 2100 and 4000 all net to zero', { skip }, async () => {
  const rig = await openRig()
  const fixtures: Fixture[] = []
  try {
    await clean(rig, [])
    await setup(rig, { since: new Date(Date.now() - 10 * DAY) })
    const suffix = suffixOf()
    const fx = await seed(rig, suffix, { allocatedAt: noonDaysAgo(4), invoice: { mode: 'submitted', docDay: ymd(noonDaysAgo(4)), syncedAt: new Date(Date.now() - 4 * DAY) } })
    fixtures.push(fx)
    assert.deepEqual((await rig.runDailyBatchSync()).errors, [])
    await settleBatchJournals(rig, suffix)

    // A refund of one (unshipped) unit after the deferral: its reversal takes 100 out of Unearned and 10 out of Allocated.
    await rig.db.setting.upsert({ where: { key: 'plugin_xero_enabled' }, create: { key: 'plugin_xero_enabled', value: 'true' }, update: { value: 'true' } })
    const refund = await rig.createSalesOrderRefund(rig.db, {
      orderId: fx.orderId,
      lines: [{ lineId: fx.lineId, productId: fx.productId, description: 'ib', qty: 1, totalBase: 100 }],
      reason: 'Line cancelled', creditNotePrefix: `IB${suffix.slice(0, 6)}r-`,
      accountingSettings, activeAccountingConnector: 'xero',
    })
    assert.equal(refund.success, true, `refund (${refund.success ? '' : refund.error})`)
    if (!refund.success) return
    const refundJournals: Journal[] = (refund.accountingSyncs as unknown as Array<{ type: string; payload: { lines: Line[] } }>)
      .filter((sync) => sync.type === 'UNEARNED_REV_REVERSAL' || sync.type === 'ALLOCATION_REVERSAL')
      .map((sync) => ({ type: sync.type, date: '', narration: '', lines: sync.payload.lines }))
    // The refund service RETURNS its syncs; the action queues them and clears the retry flag. Stand in for that hand-off.
    await rig.db.salesOrderRefund.update({ where: { id: refund.createdRefund.id }, data: { accountingRetryRequired: false } })
    const refundRow = await rig.db.salesOrderRefund.findUniqueOrThrow({ where: { id: refund.createdRefund.id } })
    assert.equal(Number(refundRow.allocatedReliefAmount), 10, 'the refund relieved 10 of Allocated Inventory')
    assert.equal(net(refundJournals, '1210'), -10)
    assert.equal(net(refundJournals, '2100'), 100)

    // Xero voids the invoice; the batch unwinds what is still open (300).
    assert.equal(await rig.markInvoiceBasisDeferralUnwindOwed(rig.db, { accountingInvoiceIds: [`INV-${suffix}`] }, 'INVOICE_VOIDED'), 1)
    assert.deepEqual((await rig.runDailyBatchSync()).errors, [])
    assert.equal(net((await journals(rig)).filter((j) => /unwind/i.test(j.narration)), '2100'), 300)

    // A manual cancel needs no refund: the order still names only the voided invoice. The A2 reversal is 40 - 10 = 30.
    await cancelOrder(rig, fx.orderId)
    const order = await rig.db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
    assert.equal(order.status, 'CANCELLED')
    assert.equal(Number(order.allocationReversalAmount), 30, 'capped by the refund relief, not the whole recorded debit')
    const all = [...await journals(rig), ...refundJournals]
    assertBalanced(all, 'refund, void, cancel')
    assert.equal(net(all, '1210'), 0, 'Allocated Inventory nets to zero, never below')
    assert.equal(net(all, '1200'), 0, 'Inventory nets to zero')
    assert.equal(net(all, '2100'), 0, 'Unearned Revenue nets to zero')
    assert.equal(net(all, '4000'), 0, 'Sales: the deferral, the refund reversal and the unwind cancel out (the credit note and the void are Xero documents)')
    assert.deepEqual(allocStranded(rig, await rig.collectAccountingInvariantRows(rig.db as never), fx.orderId), [])
  } finally {
    await clean(rig, fixtures)
    await close(rig)
  }
})

test('unpaid-invoice deferral: a RE-ISSUED live invoice cannot be cancelled without a refund, even while the old unwind is recorded', { skip }, async () => {
  const rig = await openRig()
  const fixtures: Fixture[] = []
  try {
    await clean(rig, [])
    await setup(rig, { since: new Date(Date.now() - 10 * DAY) })
    const suffix = suffixOf()
    const fx = await seed(rig, suffix, { allocatedAt: noonDaysAgo(4), invoice: { mode: 'submitted', docDay: ymd(noonDaysAgo(4)), syncedAt: new Date(Date.now() - 4 * DAY) } })
    fixtures.push(fx)
    assert.deepEqual((await rig.runDailyBatchSync()).errors, [])
    await settleBatchJournals(rig, suffix)
    await rig.db.accountingDocumentDeletion.create({
      data: { kind: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: fx.orderId, documentId: fx.orderId, externalDocumentId: `INV-${suffix}`, originalNumber: `INV-${suffix}`, releasedNumber: `INV-${suffix}-X`, targetStatus: 'VOIDED' },
    })
    assert.equal(await rig.completeAccountingDocumentDeletion(`INV-${suffix}`), 'completed')
    let order = await rig.db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
    assert.equal(order.revenueDeferralUnwindInvoiceId, `INV-${suffix}`, 'the unwind names the invoice it is for')
    // Re-issued before the batch has run: a new, live AUTHORISED invoice.
    await rig.db.salesOrder.update({ where: { id: fx.orderId }, data: { accountingInvoiceId: `INV2-${suffix}` } })
    await rig.db.accountingSyncLog.create({
      data: { type: 'SALES_INVOICE', status: 'SYNCED', referenceType: 'SalesOrder', referenceId: fx.orderId, externalTransactionId: `INV2-${suffix}`, syncedAt: new Date(), payload: { _postingMode: 'submitted', date: ymd(noonDaysAgo(1)) } },
    })
    await assert.rejects(cancelOrder(rig, fx.orderId), /invoice/i, 'the live re-issued invoice must be credited by a refund')
    order = await rig.db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
    assert.notEqual(order.status, 'CANCELLED')
    assert.equal(order.allocationReversalAmount, null, 'no A2 reversal was raised')
  } finally {
    await clean(rig, fixtures)
    await close(rig)
  }
})
