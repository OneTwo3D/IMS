import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * ACC-H11 / ACC-H13 against a real database, driving the real `runDailyBatchSync`.
 *
 *  - every daily-batch journal is dated the day of its EVENT (paid / allocated / shipped), not the day the
 *    batch ran, with one journal and one reference per date, and each journal balances;
 *  - an event inside a period the operator has marked locked is NOT back-dated: its journal is dated the
 *    first open day, the narration says so, and a WARNING is logged;
 *  - a NET refund entered before the first run is netted out of the deferral, so Unearned Revenue is not
 *    left holding the refunded value;
 *  - a re-run posts nothing a second time.
 *
 * Every fixture is created under a unique tag and removed when the file ends. The run is the real one, so
 * it may also stage rows other files left behind; every assertion is about THIS file's own orders only.
 * No network: fetch and the connector transport throw.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'

const NO_NETWORK = 'daily-batch event-date test: an outbound network call was attempted.'
globalThis.fetch = (async () => { throw new Error(NO_NETWORK) }) as typeof fetch
mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async () => { throw new Error(NO_NETWORK) },
    DEFAULT_CONNECTOR_FETCH_TIMEOUT_MS: 30_000,
    DEFAULT_CONNECTOR_FETCH_MAX_RESPONSE_BYTES: 10 * 1024 * 1024,
    isAllAddressesLookup: () => false,
  },
})

// The batch reads the lock date from Xero at the start of each run. Offline: the GET is answered here.
let xeroLockDate: string | null = null
mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroGet: async () => ({
      ok: true, status: 200,
      data: { Organisations: [xeroLockDate ? { PeriodLockDate: `${xeroLockDate}T00:00:00` } : {}] },
    }),
  },
})

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
}

const ACCOUNTS = {
  xero_sync_enabled: 'true',
  xero_sales_account: '200',
  xero_unearned_revenue_account: '830',
  xero_allocated_inventory_account: '631',
  xero_inventory_account: '630',
  xero_cogs_account: '500',
}

const seededOrderIds: string[] = []
const seededProductIds: string[] = []
const seededWarehouseIds: string[] = []
const seededCustomerIds: string[] = []
const adjustmentReferenceIds: string[] = []
const previousSettings = new Map<string, string | null>()

async function setSetting(key: string, value: string | null) {
  const { db } = await import('@/lib/db')
  if (!previousSettings.has(key)) {
    previousSettings.set(key, (await db.setting.findUnique({ where: { key } }))?.value ?? null)
  }
  if (value === null) await db.setting.deleteMany({ where: { key } })
  else await db.setting.upsert({ where: { key }, update: { value }, create: { key, value } })
}

type Fixture = {
  tag: string
  orderId: string
  lineIds: string[]
  productId: string
  warehouseId: string
  layerId: string
}

/**
 * One paid, invoiced order of `lineCount` single-unit lines at 60 / 40, shipping `shipping`, each line backed
 * by its own cost layer at 4.00 and its own allocation. Paid and allocated on the given days.
 */
async function seedOrder(label: string, options: { paidAt: string; allocatedAt: string; shipping?: number; twoLines?: boolean }): Promise<Fixture & { productIds: string[]; layerIds: string[]; allocationIds: string[] }> {
  const { db } = await import('@/lib/db')
  const tag = `EVD-${label}-${process.pid}-${Date.now()}`
  const warehouse = await db.warehouse.create({ data: { code: tag, name: tag, availableForSale: true, active: true } })
  seededWarehouseIds.push(warehouse.id)
  const customer = await db.customer.create({ data: { firstName: 'EVD', lastName: tag, email: `${tag.toLowerCase()}@example.invalid`, active: true } })
  seededCustomerIds.push(customer.id)
  const prices = options.twoLines ? [60, 40] : [100]
  const shipping = options.shipping ?? 0
  const subtotal = prices.reduce((a, b) => a + b, 0)
  const products: Array<{ id: string; sku: string; name: string }> = []
  const layers: Array<{ id: string }> = []
  for (let i = 0; i < prices.length; i++) {
    const product = await db.product.create({ data: {
      sku: `${tag}-${i}`, name: `product ${tag} ${i}`, type: 'SIMPLE', lifecycleStatus: 'ACTIVE', salesPriceBase: prices[i],
      salesPriceTaxInclusive: false, taxCategory: 'STANDARD', stockUnit: 'pcs', oversellAllowed: false, active: true,
    } })
    seededProductIds.push(product.id)
    products.push(product)
    layers.push(await db.costLayer.create({ data: {
      productId: product.id, warehouseId: warehouse.id, receivedQty: 1, remainingQty: 1, unitCostBase: 4,
      receivedAt: new Date('2026-01-01T00:00:00.000Z'), isOpeningStock: true,
    } }))
  }
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `SO-${tag}`, status: 'ALLOCATED', currency: 'GBP', fxRateToBase: 1, customerId: customer.id,
      customerName: 'EVD', customerEmail: customer.email, billingAddress: { country: 'GB' } as never, shippingAddress: { country: 'GB' } as never,
      subtotalForeign: subtotal, shippingForeign: shipping, taxForeign: 0, pricesIncludeVat: false, totalForeign: subtotal + shipping,
      subtotalBase: subtotal, shippingBase: shipping, taxBase: 0, totalBase: subtotal + shipping, shipFromWarehouseId: warehouse.id,
      paidAt: new Date(options.paidAt), accountingInvoiceId: `INV-${tag}`,
      lines: { create: products.map((product, i) => ({ productId: product.id, sku: product.sku, description: product.name, qty: 1, unitPriceForeign: prices[i], unitPriceBase: prices[i], totalForeign: prices[i], totalBase: prices[i], cogsBase: 4 })) },
    },
    include: { lines: { orderBy: { totalBase: 'desc' } } },
  })
  seededOrderIds.push(order.id)
  const allocationIds: string[] = []
  for (let i = 0; i < order.lines.length; i++) {
    const allocation = await db.orderAllocation.create({ data: {
      orderId: order.id, lineId: order.lines[i].id, productId: order.lines[i].productId!, warehouseId: warehouse.id, qty: 1,
      createdAt: new Date(options.allocatedAt),
    } })
    allocationIds.push(allocation.id)
  }
  return {
    tag, orderId: order.id, lineIds: order.lines.map((line) => line.id), productId: products[0].id, warehouseId: warehouse.id,
    layerId: layers[0].id, productIds: products.map((product) => product.id), layerIds: layers.map((layer) => layer.id), allocationIds,
  }
}

async function shipLines(fx: Awaited<ReturnType<typeof seedOrder>>, shippedAt: string, lineIndexes: number[]) {
  const { db } = await import('@/lib/db')
  const shipment = await db.shipment.create({
    data: {
      orderId: fx.orderId, warehouseId: fx.warehouseId, status: 'SHIPPED', shippedAt: new Date(shippedAt), createdAt: new Date(shippedAt),
      lines: {
        create: lineIndexes.map((i) => ({
          lineId: fx.lineIds[i], productId: fx.productIds[i], qty: 1,
          costLayerSnapshot: [{ costLayerId: fx.layerIds[i], qty: '1.000000', unitCostBase: '4.000000' }] as never,
        })),
      },
    },
  })
  await db.salesOrder.update({ where: { id: fx.orderId }, data: { status: lineIndexes.length === fx.lineIds.length ? 'SHIPPED' : 'PICKING', shippedAt: new Date(shippedAt) } })
  return shipment
}

type JournalLine = { accountCode: string; debit?: number; credit?: number }

async function journalsFor(referenceIds: Array<string | null | undefined>) {
  const { db } = await import('@/lib/db')
  const ids = referenceIds.filter((id): id is string => !!id)
  const rows = await db.accountingSyncLog.findMany({ where: { referenceId: { in: ids } }, orderBy: { createdAt: 'asc' } })
  return rows.map((row) => {
    const payload = row.payload as { date: string; narration: string; lines: JournalLine[] }
    return { type: String(row.type), referenceId: row.referenceId, date: payload.date, narration: payload.narration, lines: payload.lines }
  })
}

/** The pre-batch refund adjustment journal for an order: the A1-typed journal whose payload names its refunds. */
async function adjustmentJournalFor(orderId: string) {
  const { db } = await import('@/lib/db')
  const refunds = await db.salesOrderRefund.findMany({ where: { orderId }, select: { id: true } })
  const rows = await db.accountingSyncLog.findMany({ where: { type: 'DAILY_BATCH_REVENUE_DEFERRAL' }, orderBy: { createdAt: 'desc' }, take: 200 })
  const row = rows.find((candidate) => {
    const payload = candidate.payload as { refundAdjustments?: Array<{ orderId: string; refundId: string | null }> } | null
    return payload?.refundAdjustments?.some((entry) => entry.orderId === orderId && refunds.some((refund) => refund.id === entry.refundId))
  })
  assert.ok(row, 'the refund adjustment journal exists')
  const payload = row!.payload as { date: string; narration: string; lines: JournalLine[] }
  adjustmentReferenceIds.push(row!.referenceId)
  return { referenceId: row!.referenceId, date: payload.date, narration: payload.narration, lines: payload.lines }
}

function assertBalanced(lines: JournalLine[]) {
  const debit = lines.reduce((sum, line) => sum + (line.debit ?? 0), 0)
  const credit = lines.reduce((sum, line) => sum + (line.credit ?? 0), 0)
  assert.ok(Math.abs(debit - credit) < 0.005, `journal does not balance: DR ${debit} CR ${credit}`)
}

function amount(lines: JournalLine[], accountCode: string, side: 'debit' | 'credit'): number {
  return lines.filter((line) => line.accountCode === accountCode).reduce((sum, line) => sum + (line[side] ?? 0), 0)
}

async function runBatch() {
  const { runDailyBatchSync } = await import('@/lib/connectors/xero/daily-sync')
  return runDailyBatchSync()
}

test.before(async () => {
  if (!RUN) return
  loadEnv()
  for (const [key, value] of Object.entries(ACCOUNTS)) await setSetting(key, value)
  xeroLockDate = null
  await setSetting('xero_books_lock_date', null)
  await setSetting('xero_books_lock_date_read_at', null)
})

test.after(async () => {
  if (!RUN) return
  const { db } = await import('@/lib/db')
  const shipments = await db.shipment.findMany({ where: { orderId: { in: seededOrderIds } }, select: { id: true, shipmentJournalBatchRef: true } })
  const orders = await db.salesOrder.findMany({ where: { id: { in: seededOrderIds } }, select: { revenueDeferredBatchRef: true, inventoryAllocatedBatchRef: true } })
  const refs = [
    ...shipments.map((shipment) => shipment.shipmentJournalBatchRef),
    ...orders.flatMap((order) => [order.revenueDeferredBatchRef, order.inventoryAllocatedBatchRef]),
  ].filter((ref): ref is string => !!ref).concat(adjustmentReferenceIds)
  const shipmentIds = shipments.map((shipment) => shipment.id)
  await db.cogsSubledgerMovement.deleteMany({ where: { sourceRef: { in: shipmentIds } } })
  const events = await db.accountingEvent.findMany({ where: { sourceEntityId: { in: refs } }, select: { id: true } })
  await db.accountingEventLog.deleteMany({ where: { accountingEventId: { in: events.map((event) => event.id) } } })
  await db.accountingEvent.deleteMany({ where: { id: { in: events.map((event) => event.id) } } })
  await db.accountingSyncLog.deleteMany({ where: { referenceId: { in: refs } } })
  await db.shipmentLine.deleteMany({ where: { shipmentId: { in: shipmentIds } } })
  await db.shipment.deleteMany({ where: { id: { in: shipmentIds } } })
  await db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId: { in: seededOrderIds } } } })
  await db.salesOrderRefund.deleteMany({ where: { orderId: { in: seededOrderIds } } })
  await db.orderAllocation.deleteMany({ where: { orderId: { in: seededOrderIds } } })
  await db.salesOrderLine.deleteMany({ where: { orderId: { in: seededOrderIds } } })
  await db.salesOrder.deleteMany({ where: { id: { in: seededOrderIds } } })
  await db.costLayer.deleteMany({ where: { productId: { in: seededProductIds } } })
  await db.product.deleteMany({ where: { id: { in: seededProductIds } } })
  await db.warehouse.deleteMany({ where: { id: { in: seededWarehouseIds } } })
  await db.customer.deleteMany({ where: { id: { in: seededCustomerIds } } })
  for (const [key, value] of previousSettings) {
    if (value === null) await db.setting.deleteMany({ where: { key } })
    else await db.setting.upsert({ where: { key }, update: { value }, create: { key, value } })
  }
  await db.$disconnect()
})

test('ACC-H11: deferral, reclass, revenue and COGS are dated by their events, not the run; a re-run posts nothing twice', { skip }, async () => {
  const { db } = await import('@/lib/db')
  xeroLockDate = null
  // Paid, allocated and invoiced 30 March; it ships on 31 March; the batch runs on neither day.
  const fx = await seedOrder('dates', { paidAt: '2026-03-30T10:00:00.000Z', allocatedAt: '2026-03-30T11:00:00.000Z' })

  const first = await runBatch()
  assert.deepEqual(first.errors.filter((error) => error.includes(fx.orderId) || error.includes(fx.tag)), [])
  const afterFirst = await db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
  assert.ok(afterFirst.revenueDeferredBatchRef, 'A1 stamped the order')
  assert.ok(afterFirst.inventoryAllocatedBatchRef, 'A2 stamped the order')
  assert.match(afterFirst.revenueDeferredBatchRef!, /^A1-2026-03-30-[0-9a-f]{8}$/, 'A1 reference carries the PAID day')
  assert.match(afterFirst.inventoryAllocatedBatchRef!, /^A2-2026-03-30-[0-9a-f]{8}$/, 'A2 reference carries the later of paid and allocated')
  const [a1] = await journalsFor([afterFirst.revenueDeferredBatchRef])
  assert.equal(a1.date, '2026-03-30')
  assert.equal(amount(a1.lines, '200', 'debit'), 100)
  assert.equal(amount(a1.lines, '830', 'credit'), 100)
  const [a2] = await journalsFor([afterFirst.inventoryAllocatedBatchRef])
  assert.equal(a2.date, '2026-03-30')
  assert.equal(amount(a2.lines, '631', 'debit'), 4)
  assertBalanced(a1.lines)
  assertBalanced(a2.lines)

  const shipment = await shipLines(fx, '2026-03-31T09:00:00.000Z', [0])
  const second = await runBatch()
  assert.deepEqual(second.errors.filter((error) => error.includes(fx.orderId) || error.includes(fx.tag)), [])
  const shipped = await db.shipment.findUniqueOrThrow({ where: { id: shipment.id } })
  assert.ok(shipped.shipmentJournalBatchRef, 'Group B stamped the shipment')
  assert.match(shipped.shipmentJournalBatchRef!, /^B-2026-03-31-[0-9a-f]{8}$/, 'Group B reference carries the SHIPPED day')
  const [b] = await journalsFor([shipped.shipmentJournalBatchRef])
  assert.equal(b.date, '2026-03-31')
  assert.equal(amount(b.lines, '830', 'debit'), 100)
  assert.equal(amount(b.lines, '200', 'credit'), 100)
  assert.equal(amount(b.lines, '500', 'debit'), 4)
  assert.equal(amount(b.lines, '631', 'credit'), 4)
  assertBalanced(b.lines)
  const movement = await db.cogsSubledgerMovement.findUniqueOrThrow({ where: { idempotencyKey: `dispatch:${shipment.id}` } })
  assert.equal(movement.journalDate.toISOString().slice(0, 10), '2026-03-31', 'the COGS subledger row is dated with its journal')

  // Idempotent: a further run raises no journal for this order.
  const refs = [afterFirst.revenueDeferredBatchRef, afterFirst.inventoryAllocatedBatchRef, shipped.shipmentJournalBatchRef]
  const before = await journalsFor(refs)
  await runBatch()
  const after = await journalsFor(refs)
  assert.equal(after.length, before.length, 'a re-run must not post anything twice')
  assert.equal(before.length, 3)
})

test('ACC-H11: events in a locked period are moved to the first open day, never back-dated, and say so', { skip }, async () => {
  const { db } = await import('@/lib/db')
  xeroLockDate = '2026-03-31'
  const fx = await seedOrder('locked', { paidAt: '2026-03-10T10:00:00.000Z', allocatedAt: '2026-03-10T10:30:00.000Z' })
  const result = await runBatch()
  assert.deepEqual(result.errors.filter((error) => error.includes(fx.orderId) || error.includes(fx.tag)), [])
  const order = await db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
  assert.match(order.revenueDeferredBatchRef ?? '', /^A1-2026-04-01-/, 'dated the first open day, not 10 March')
  const [a1] = await journalsFor([order.revenueDeferredBatchRef])
  assert.equal(a1.date, '2026-04-01')
  assert.match(a1.narration, /2026-03-10 fall in a locked period/)
  assertBalanced(a1.lines)
  const warnings = await db.activityLog.findMany({ where: { action: 'daily_batch_locked_period_event_moved' } })
  assert.ok(warnings.some((row) => (row.description ?? '').includes('2026-03-10')), 'a WARNING names the moved event day')

  // The same order shipped on a locked day: Group B is moved too, and never earlier than the deferral.
  const shipment = await shipLines(fx, '2026-03-20T09:00:00.000Z', [0])
  await runBatch()
  const shipped = await db.shipment.findUniqueOrThrow({ where: { id: shipment.id } })
  assert.match(shipped.shipmentJournalBatchRef ?? '', /^B-2026-04-01-/)
  const movement = await db.cogsSubledgerMovement.findUniqueOrThrow({ where: { idempotencyKey: `dispatch:${shipment.id}` } })
  assert.equal(movement.journalDate.toISOString().slice(0, 10), '2026-04-01')
  xeroLockDate = null
})

test('ACC-H13: a NET partial refund entered before the first run is adjusted on its own date; the paid-day journal stays gross and Unearned is not stranded', { skip }, async () => {
  const { db } = await import('@/lib/db')
  xeroLockDate = null
  // Lines 60 + 40, shipping 10. The 40 line is refunded (net 40) before the batch has ever seen the order.
  const fx = await seedOrder('refund', { paidAt: '2026-03-12T10:00:00.000Z', allocatedAt: '2026-03-12T10:30:00.000Z', shipping: 10, twoLines: true })
  await db.salesOrderRefund.create({
    data: {
      orderId: fx.orderId, totalForeign: 40, totalBase: 40, totalsBasis: 'NET', source: 'MANUAL_UI',
      refundedAt: new Date('2026-03-13T09:00:00.000Z'),
    },
  })
  await db.salesOrder.update({ where: { id: fx.orderId }, data: { refundStatus: 'PARTIAL' } })

  await runBatch()
  const order = await db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
  assert.equal(Number(order.unearnedRevenueAmount), 70, 'the order stores the netted deferral: 100 + 10 - 40, not 110')
  const [a1] = await journalsFor([order.revenueDeferredBatchRef])
  assert.equal(a1.date, '2026-03-12')
  assert.equal(amount(a1.lines, '830', 'credit'), 110, 'the paid-day journal is the gross deferral')
  assertBalanced(a1.lines)
  const adjustment = await adjustmentJournalFor(fx.orderId)
  assert.equal(adjustment.date, '2026-03-13', 'the adjustment is dated the refund day')
  assert.equal(amount(adjustment.lines, '830', 'debit'), 40)
  assert.equal(amount(adjustment.lines, '200', 'credit'), 40)
  assertBalanced(adjustment.lines)

  // Ship the unrefunded 60 line; revenue recognised is its share of the NETTED deferral (42 of 70), not of 110 (66).
  const shipment = await shipLines(fx, '2026-03-14T09:00:00.000Z', [0])
  await runBatch()
  const shipped = await db.shipment.findUniqueOrThrow({ where: { id: shipment.id } })
  assert.equal(Number(shipped.revenueRecognizedAmount), 42)
  const [b] = await journalsFor([shipped.shipmentJournalBatchRef])
  assertBalanced(b.lines)
})

test('ACC-H13: across a period boundary (paid 31 March, refunded 1 April, first run later) March keeps the full deferral and April carries the adjustment; a rerun posts nothing twice', { skip }, async () => {
  const { db } = await import('@/lib/db')
  xeroLockDate = null
  const fx = await seedOrder('boundary', { paidAt: '2026-03-31T10:00:00.000Z', allocatedAt: '2026-03-31T10:30:00.000Z', shipping: 10, twoLines: true })
  await db.salesOrderRefund.create({
    data: { orderId: fx.orderId, totalForeign: 40, totalBase: 40, totalsBasis: 'NET', source: 'MANUAL_UI', refundedAt: new Date('2026-04-01T08:00:00.000Z') },
  })
  await db.salesOrder.update({ where: { id: fx.orderId }, data: { refundStatus: 'PARTIAL' } })
  await runBatch()
  const order = await db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
  const [march] = await journalsFor([order.revenueDeferredBatchRef])
  assert.equal(march.date, '2026-03-31')
  assert.equal(amount(march.lines, '830', 'credit'), 110, 'March shows the FULL deferral; the April refund does not reach back into it')
  const april = await adjustmentJournalFor(fx.orderId)
  assert.equal(april.date, '2026-04-01')
  assert.equal(amount(april.lines, '830', 'debit'), 40)
  assert.equal(amount(april.lines, '200', 'credit'), 40)
  assertBalanced(april.lines)
  // Net Unearned for the order after both journals: 110 - 40 = 70 = what the order stores.
  assert.equal(110 - 40, Number(order.unearnedRevenueAmount))

  const before = await journalsFor([order.revenueDeferredBatchRef, april.referenceId])
  await runBatch()
  const after = await journalsFor([order.revenueDeferredBatchRef, april.referenceId])
  assert.equal(before.length, 2)
  assert.equal(after.length, 2, 'a re-run must not post either journal again')
})

test('a lock that reaches today stages NOTHING (no journal on a locked day), warns, and the events post once the lock moves', { skip }, async () => {
  const { db } = await import('@/lib/db')
  xeroLockDate = '2099-01-01'
  const fx = await seedOrder('lockfuture', { paidAt: '2026-03-20T10:00:00.000Z', allocatedAt: '2026-03-20T10:30:00.000Z' })
  const blocked = await runBatch()
  assert.deepEqual(blocked.errors.filter((error) => error.includes(fx.orderId) || error.includes(fx.tag)), [])
  const untouched = await db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
  assert.equal(untouched.revenueDeferredDate, null, 'nothing was staged or stamped')
  assert.equal(untouched.inventoryAllocatedDate, null)
  const warnings = await db.activityLog.findMany({ where: { action: 'daily_batch_blocked_by_lock_date' } })
  assert.ok(warnings.some((row) => (row.description ?? '').includes('locked up to 2099-01-01') && (row.description ?? '').includes('wait until the lock is moved')))

  xeroLockDate = null
  await runBatch()
  const posted = await db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
  assert.match(posted.revenueDeferredBatchRef ?? '', /^A1-2026-03-20-/)
})

test('ACC-H11: a FAILED journal dated on or before the lock is NOT requeued (warning), one dated after it is', { skip }, async () => {
  const { db } = await import('@/lib/db')
  xeroLockDate = '2026-03-31'
  const tag = `EVD-requeue-${process.pid}-${Date.now()}`
  const mk = (day: string, suffix: string) => db.accountingSyncLog.create({
    data: {
      connector: 'xero', type: 'DAILY_BATCH_REVENUE_DEFERRAL', status: 'FAILED', referenceType: 'DailyBatch',
      referenceId: `A1-${day}-${suffix}`, errorMessage: 'Xero: period is locked',
      payload: { date: day, reference: tag, narration: tag, lines: [], _postingMode: 'submitted' } as never,
    },
  })
  const locked = await mk('2026-03-05', 'ee000001')
  const open = await mk('2026-04-05', 'ee000002')
  adjustmentReferenceIds.push(locked.referenceId, open.referenceId)
  await runBatch()
  assert.equal((await db.accountingSyncLog.findUniqueOrThrow({ where: { id: locked.id } })).status, 'FAILED', 'a locked-period journal is not requeued')
  assert.notEqual((await db.accountingSyncLog.findUniqueOrThrow({ where: { id: open.id } })).status, 'FAILED', 'an open-period journal is requeued as before')
  const warnings = await db.activityLog.findMany({ where: { action: 'daily_batch_journal_skipped_locked_period' } })
  assert.ok(warnings.some((row) => (row.description ?? '').includes(locked.id)))
  xeroLockDate = null
})

test('ACC-H13: a lost adjustment journal is rebuilt exactly once, the paid-day journal is rebuilt GROSS for the new path and at the STORED amount for an old stamp', { skip }, async () => {
  const { db } = await import('@/lib/db')
  xeroLockDate = null
  const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  const stamped = new Date(Date.now() - 86_400_000)
  const refundedAt = new Date(Date.now() - 2 * 86_400_000)

  // NEW path: stored net 70, refund of 40 carries its adjustment ref; both journals are missing.
  const fresh = await seedOrder('lostadj', { paidAt: refundedAt.toISOString(), allocatedAt: refundedAt.toISOString(), shipping: 10, twoLines: true })
  const paidRef = `A1-${day}-aa000001`
  const adjRef = `A1-${day}-aa000002`
  await db.salesOrder.update({ where: { id: fresh.orderId }, data: { revenueDeferredDate: stamped, revenueDeferredBatchRef: paidRef, unearnedRevenueAmount: 70, refundStatus: 'PARTIAL' } })
  await db.salesOrderRefund.create({ data: { orderId: fresh.orderId, totalForeign: 40, totalBase: 40, totalsBasis: 'NET', source: 'MANUAL_UI', refundedAt, deferralAdjustmentRef: adjRef } })

  // OLD stamp: stored GROSS 110 (the convention before the adjustment path), a pre-batch refund with NO ref.
  const old = await seedOrder('oldstamp', { paidAt: refundedAt.toISOString(), allocatedAt: refundedAt.toISOString(), shipping: 10, twoLines: true })
  const oldRef = `A1-${day}-bb000001`
  await db.salesOrder.update({ where: { id: old.orderId }, data: { revenueDeferredDate: stamped, revenueDeferredBatchRef: oldRef, unearnedRevenueAmount: 110, refundStatus: 'PARTIAL' } })
  await db.salesOrderRefund.create({ data: { orderId: old.orderId, totalForeign: 40, totalBase: 40, totalsBasis: 'NET', source: 'MANUAL_UI', refundedAt } })
  adjustmentReferenceIds.push(paidRef, adjRef, oldRef)

  await runBatch()
  const paid = await journalsFor([paidRef])
  assert.equal(paid.length, 1)
  assert.equal(amount(paid[0].lines, '830', 'credit'), 110, 'new path: rebuilt at gross (70 stored + 40 netted)')
  const adj = await journalsFor([adjRef])
  assert.equal(adj.length, 1)
  assert.equal(amount(adj[0].lines, '830', 'debit'), 40)
  assert.equal(amount(adj[0].lines, '200', 'credit'), 40)
  const oldJournal = await journalsFor([oldRef])
  assert.equal(oldJournal.length, 1)
  assert.equal(amount(oldJournal[0].lines, '830', 'credit'), 110, 'old stamp: 110 stays 110, not inflated by the refund')

  await runBatch()
  assert.equal((await journalsFor([paidRef, adjRef, oldRef])).length, 3, 'rebuilt exactly once: a rerun adds nothing')
})
