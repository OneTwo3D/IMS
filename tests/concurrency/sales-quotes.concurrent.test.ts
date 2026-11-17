import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { loadEnv, uid } from './po-landed-fixtures'

/**
 * SALES QUOTATIONS, against a real database (o3d-ngmt.16).
 *
 * A quote is a DRAFT with `is_quote` set. The claim this file proves with real rows is that nothing downstream treats it differently from a draft:
 *   - no stock is reserved and nothing is allocated (even when the allocator is asked directly), whoever asks;
 *   - no accounting invoice is queued and no invoice number is minted;
 *   - the warehouse push predicate does not select it, even with everything else on the order satisfied (paid, bound warehouse);
 * and that the quote features themselves hold: it cannot be processed before it is converted, conversion clears the flag and leaves the money exactly as
 * quoted, an expired quote converts only with a note, the Quotes tab filters on the flag, the queue action writes nothing with the setting off and one
 * outbox row with it on, and the quote PDF renders.
 * Mutations: a status move allowed for a quote (the PROCESSING refusal goes red); conversion recomputing a total (the money check goes red); the list filter dropped (the tab check goes red).
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

let denied: string | null = null
// A real user row (the activity log's foreign key), set by seedWorld.
let testUserId = 'test-user'
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async (permission: string) => {
      if (denied === permission) throw new Error(`Forbidden: ${permission}`)
      return { user: { id: testUserId, role: 'ADMIN' } }
    },
    requireInternalUser: async () => ({ user: { id: testUserId, role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: testUserId, role: 'ADMIN' } }),
    requireFreshPermission: async () => ({ user: { id: testUserId, role: 'ADMIN' } }),
  },
})
mock.module('@/lib/auth', { namedExports: { auth: async () => ({ user: { id: testUserId } }) } })
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })

type World = { tag: string; productId: string; sku: string; warehouseId: string; rateId: string; orderIds: string[]; teardown: () => Promise<void> }

async function seedWorld(): Promise<World> {
  loadEnv()
  const { db } = await import('@/lib/db')
  const tag = uid()
  const rate = await db.taxRate.create({ data: { name: `ZQQT Std 20 ${tag}`, rate: '0.2', usedFor: 'SALES', taxCategory: 'STANDARD', active: true }, select: { id: true } })
  const product = await db.product.create({ data: { sku: `QT-${tag}`, name: 'Quote product', type: 'SIMPLE', taxCategory: 'STANDARD' }, select: { id: true, sku: true } })
  const user = await db.user.create({ data: { email: `quote-${tag}@users.example.test`, name: 'Quote tester', passwordHash: 'x' }, select: { id: true } })
  testUserId = user.id
  const warehouse = await db.warehouse.create({ data: { code: `QT${tag.slice(0, 8)}`, name: 'Quote warehouse' }, select: { id: true } })
  await db.stockLevel.create({ data: { productId: product.id, warehouseId: warehouse.id, quantity: 10, reservedQty: 0 } })
  const world: World = {
    tag, productId: product.id, sku: product.sku, warehouseId: warehouse.id, rateId: rate.id, orderIds: [],
    teardown: async () => {
      await db.emailOutbox.deleteMany({ where: { referenceId: { in: world.orderIds } } })
      await db.activityLog.deleteMany({ where: { OR: [{ entityType: 'SALES_ORDER', entityId: { in: world.orderIds } }, { userId: user.id }] } })
      await db.user.deleteMany({ where: { id: user.id } })
      await db.orderAllocation.deleteMany({ where: { orderId: { in: world.orderIds } } })
      await db.salesOrderLine.deleteMany({ where: { orderId: { in: world.orderIds } } })
      await db.salesOrder.deleteMany({ where: { id: { in: world.orderIds } } })
      await db.stockLevel.deleteMany({ where: { productId: product.id } })
      await db.warehouse.deleteMany({ where: { id: warehouse.id } })
      await db.product.deleteMany({ where: { id: product.id } })
      await db.taxRate.deleteMany({ where: { id: rate.id } })
      await db.setting.deleteMany({ where: { key: 'sales_quote_email_enabled' } })
    },
  }
  return world
}

function inputFor(w: World, extra: Record<string, unknown> = {}) {
  return {
    customerName: 'Quote Customer',
    customerEmail: `quote-${w.tag}@example.test`,
    billingAddress: { line1: '1 Test St', country: 'GB' },
    shippingAddress: { line1: '2 Test St', country: 'GB' },
    currency: 'GBP',
    taxRateName: `ZQQT Std 20 ${w.tag}`,
    taxRateValue: 0.2,
    pricesIncludeVat: false,
    shippingForeign: 4.5,
    shipFromWarehouseId: w.warehouseId,
    isDraft: true,
    lines: [{ productId: w.productId, sku: w.sku, description: 'Quoted', qty: 3, unitPriceForeign: 12.345, discountAmount: 1.5 }],
    ...extra,
  }
}

const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
const MONEY = ['subtotalForeign', 'shippingForeign', 'taxForeign', 'totalForeign', 'subtotalBase', 'shippingBase', 'taxBase', 'totalBase', 'discountAmount', 'fxRateToBase', 'taxRatePercent'] as const

async function moneyOf(orderId: string) {
  const { db } = await import('@/lib/db')
  const so = await db.salesOrder.findUniqueOrThrow({ where: { id: orderId }, include: { lines: { orderBy: { sku: 'asc' } } } })
  return JSON.stringify({
    header: MONEY.map((k) => String(so[k])),
    lines: so.lines.map((l) => [l.sku, String(l.qty), String(l.unitPriceForeign), String(l.unitPriceBase), String(l.discountAmount), String(l.taxForeign), String(l.totalForeign), String(l.totalBase)]),
  })
}

test('a quote is created as a DRAFT carrying the flag, and behaves as a draft in every consumer', SKIP, async (t) => {
  const w = await seedWorld()
  t.after(() => w.teardown())
  const { createSalesOrder, updateSalesOrderStatus } = await import('@/app/actions/sales')
  const { autoAllocateOrder } = await import('@/app/actions/allocation')
  const { wmsCreateEligibleOrderWhere } = await import('@/lib/domain/wms/create-eligibility')
  const { db } = await import('@/lib/db')

  const created = await createSalesOrder(inputFor(w, { isQuote: true, quoteValidUntil: future(30) }) as never)
  assert.equal(created.success, true, created.error)
  const id = created.order!.id
  w.orderIds.push(id)
  assert.equal(created.order!.isQuote, true)
  assert.equal(created.order!.status, 'DRAFT')
  assert.equal(created.order!.quoteValidUntil, future(30))
  const row = await db.salesOrder.findUniqueOrThrow({ where: { id } })
  assert.equal(row.isQuote, true)
  assert.equal(row.status, 'DRAFT')
  assert.equal(row.quoteSentAt, null)

  // Not allocated, and no stock reserved, even when the allocator is asked directly.
  const allocation = await autoAllocateOrder(id)
  assert.equal(allocation.success, false, 'a draft (and so a quote) is not allocated')
  assert.equal(await db.orderAllocation.count({ where: { orderId: id } }), 0)
  const stock = await db.stockLevel.findUniqueOrThrow({ where: { productId_warehouseId: { productId: w.productId, warehouseId: w.warehouseId } } })
  assert.equal(String(stock.reservedQty), '0', 'a quote reserves nothing')
  assert.equal(String(stock.quantity), '10')

  // Not invoiced.
  assert.equal(await db.accountingSyncLog.count({ where: { referenceType: 'SalesOrder', referenceId: id } }), 0)
  assert.equal(row.invoiceNumber, null)
  assert.equal(row.salesInvoiceOwedAt, null)

  // Not selected by the warehouse push predicate, even with every other fence on the order satisfied (paid, bound warehouse).
  await db.salesOrder.update({ where: { id }, data: { paidAt: new Date() } })
  assert.equal(await db.salesOrder.count({ where: { id, ...wmsCreateEligibleOrderWhere([w.warehouseId], null) } }), 0)

  // Cannot leave the draft state before it is converted (the same refusal for every target but cancelling).
  for (const target of ['PROCESSING', 'PENDING_PAYMENT', 'ON_HOLD', 'ALLOCATED'] as const) {
    const moved = await updateSalesOrderStatus(id, target)
    assert.equal(moved.success, false, target)
    assert.match(moved.error ?? '', /This is a quote\. Convert it to an order first/)
  }
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id } })).status, 'DRAFT')
  assert.equal(await db.orderAllocation.count({ where: { orderId: id } }), 0)
})

test('a quote needs a draft and a real, not-past validity date; a storefront-numbered order is never a quote', SKIP, async (t) => {
  const w = await seedWorld()
  t.after(() => w.teardown())
  const { createSalesOrder } = await import('@/app/actions/sales')
  const { db } = await import('@/lib/db')
  const before = await db.salesOrder.count()
  for (const [extra, pattern] of [
    [{ isQuote: true }, /valid until/],
    [{ isQuote: true, quoteValidUntil: '2020-01-01' }, /in the past/],
    [{ isQuote: true, quoteValidUntil: '2026-02-30' }, /valid until/],
    [{ isQuote: true, isDraft: false, quoteValidUntil: future(5) }, /saved as a draft/],
    [{ isQuote: true, quoteValidUntil: future(5), externalOrderNumber: `X-${w.tag}` }, /storefront order is never a quote/],
    [{ quoteValidUntil: future(5) }, /belongs to a quote only/],
  ] as const) {
    const r = await createSalesOrder(inputFor(w, extra) as never)
    assert.equal(r.success, false)
    assert.match(r.error ?? '', pattern)
  }
  assert.equal(await db.salesOrder.count(), before, 'nothing was written')
})

test('editing a quote keeps it a quote and may move the date; an order cannot become a quote and a quote cannot silently become an order', SKIP, async (t) => {
  const w = await seedWorld()
  t.after(() => w.teardown())
  const { createSalesOrder, updateSalesOrder } = await import('@/app/actions/sales')
  const { db } = await import('@/lib/db')
  const quote = await createSalesOrder(inputFor(w, { isQuote: true, quoteValidUntil: future(10) }) as never)
  const draft = await createSalesOrder(inputFor(w) as never)
  assert.ok(quote.success && draft.success)
  w.orderIds.push(quote.order!.id, draft.order!.id)
  const version = async (id: string) => (await db.salesOrder.findUniqueOrThrow({ where: { id }, select: { updatedAt: true } })).updatedAt.toISOString()

  const moved = await updateSalesOrder(quote.order!.id, inputFor(w, { isQuote: true, quoteValidUntil: future(45) }) as never, await version(quote.order!.id))
  assert.equal(moved.success, true, moved.error)
  assert.equal(moved.order!.quoteValidUntil, future(45))
  assert.equal(moved.order!.isQuote, true)

  const toOrder = await updateSalesOrder(quote.order!.id, inputFor(w) as never, await version(quote.order!.id))
  assert.equal(toOrder.success, false)
  assert.match(toOrder.error ?? '', /keep it a quote/)
  const toQuote = await updateSalesOrder(draft.order!.id, inputFor(w, { isQuote: true, quoteValidUntil: future(9) }) as never, await version(draft.order!.id))
  assert.equal(toQuote.success, false)
  assert.match(toQuote.error ?? '', /cannot be turned into a quote/)
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: draft.order!.id } })).isQuote, false)
})

test('the Quotes tab lists only quotes; an expired quote carries the expired flag; converted quotes leave the tab', SKIP, async (t) => {
  const w = await seedWorld()
  t.after(() => w.teardown())
  const { createSalesOrder, getSalesOrders } = await import('@/app/actions/sales')
  const { convertQuoteToOrder } = await import('@/app/actions/sales-quotes')
  const { db } = await import('@/lib/db')
  const live = await createSalesOrder(inputFor(w, { isQuote: true, quoteValidUntil: future(20) }) as never)
  const old = await createSalesOrder(inputFor(w, { isQuote: true, quoteValidUntil: future(20) }) as never)
  const plain = await createSalesOrder(inputFor(w) as never)
  assert.ok(live.success && old.success && plain.success)
  w.orderIds.push(live.order!.id, old.order!.id, plain.order!.id)
  await db.salesOrder.update({ where: { id: old.order!.id }, data: { quoteValidUntil: new Date('2026-01-01T00:00:00.000Z') } })

  const marker = `quote-${w.tag}@example.test`
  const tab = await getSalesOrders({ quotes: true, q: marker })
  assert.deepEqual(tab.rows.map((r) => r.id).sort(), [live.order!.id, old.order!.id].sort(), 'only the quotes')
  assert.equal(tab.rows.find((r) => r.id === live.order!.id)!.quoteExpired, false)
  assert.equal(tab.rows.find((r) => r.id === old.order!.id)!.quoteExpired, true)
  const all = await getSalesOrders({ q: marker })
  assert.equal(all.rows.length, 3, 'the default list still shows every draft')
  assert.equal(all.rows.find((r) => r.id === plain.order!.id)!.quoteExpired, false)

  assert.equal((await convertQuoteToOrder(live.order!.id)).success, true)
  const after = await getSalesOrders({ quotes: true, q: marker })
  assert.deepEqual(after.rows.map((r) => r.id), [old.order!.id])
})

test('conversion clears the flag and leaves every price, tax and total exactly as quoted; an expired quote needs a note', SKIP, async (t) => {
  const w = await seedWorld()
  t.after(() => w.teardown())
  const { createSalesOrder } = await import('@/app/actions/sales')
  const { convertQuoteToOrder } = await import('@/app/actions/sales-quotes')
  const { db } = await import('@/lib/db')
  const quote = await createSalesOrder(inputFor(w, { isQuote: true, quoteValidUntil: future(7) }) as never)
  assert.ok(quote.success)
  const id = quote.order!.id
  w.orderIds.push(id)
  const before = await moneyOf(id)

  const converted = await convertQuoteToOrder(id)
  assert.deepEqual(converted, { success: true, expired: false })
  const row = await db.salesOrder.findUniqueOrThrow({ where: { id } })
  assert.equal(row.isQuote, false)
  assert.equal(row.status, 'DRAFT', 'a plain draft: the operator confirms it through the existing flow')
  assert.equal(await moneyOf(id), before, 'prices are not changed')
  assert.ok(row.quoteValidUntil, 'the validity date is kept as the record of what was offered')
  assert.equal(await db.orderAllocation.count({ where: { orderId: id } }), 0)
  assert.equal(await db.accountingSyncLog.count({ where: { referenceType: 'SalesOrder', referenceId: id } }), 0)
  const again = await convertQuoteToOrder(id)
  assert.equal(again.success, false)
  assert.match(again.error ?? '', /not a quote/)

  // Expired: refused without a note, allowed with one (recorded on the internal notes), money still untouched.
  const stale = await createSalesOrder(inputFor(w, { isQuote: true, quoteValidUntil: future(7), internalNotes: 'keep me' }) as never)
  assert.ok(stale.success)
  w.orderIds.push(stale.order!.id)
  await db.salesOrder.update({ where: { id: stale.order!.id }, data: { quoteValidUntil: new Date('2026-01-01T00:00:00.000Z') } })
  const staleBefore = await moneyOf(stale.order!.id)
  const refused = await convertQuoteToOrder(stale.order!.id)
  assert.equal(refused.success, false)
  assert.match(refused.error ?? '', /expired on 2026-01-01/)
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: stale.order!.id } })).isQuote, true, 'still a quote')
  const overridden = await convertQuoteToOrder(stale.order!.id, { overrideNote: 'agreed by phone' })
  assert.deepEqual(overridden, { success: true, expired: true })
  const after = await db.salesOrder.findUniqueOrThrow({ where: { id: stale.order!.id } })
  assert.equal(after.isQuote, false)
  assert.match(after.internalNotes ?? '', /^keep me\n\[Quote converted after it expired on 2026-01-01, on \d{4}-\d{2}-\d{2}: agreed by phone\]$/)
  assert.equal(await moneyOf(stale.order!.id), staleBefore)
})

test('send quote: nothing is queued with the setting off; with it on one SALES_QUOTE row is queued once and the quote PDF renders; switched off again it is refused at send time', SKIP, async (t) => {
  const w = await seedWorld()
  t.after(() => w.teardown())
  process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || 'a1'.repeat(32)
  const { createSalesOrder } = await import('@/app/actions/sales')
  const { sendQuoteEmail, setSalesQuoteEmailEnabled } = await import('@/app/actions/sales-quotes')
  const { prepareQueuedEmail } = await import('@/lib/order-email')
  const { EmailKindDisabledError } = await import('@/lib/email-kind-disabled')
  const { db } = await import('@/lib/db')
  const quote = await createSalesOrder(inputFor(w, { isQuote: true, quoteValidUntil: future(14) }) as never)
  assert.ok(quote.success)
  const id = quote.order!.id
  w.orderIds.push(id)
  const rows = () => db.emailOutbox.findMany({ where: { referenceId: id, kind: 'SALES_QUOTE' } })

  const off = await sendQuoteEmail(id)
  assert.equal(off.success, false)
  assert.match(off.error ?? '', /switched off/)
  assert.equal((await rows()).length, 0, 'nothing queued with the setting off')

  assert.deepEqual(await setSalesQuoteEmailEnabled(true), { success: true })
  const sent = await sendQuoteEmail(id)
  assert.deepEqual(sent, { success: true })
  const queued = await rows()
  assert.equal(queued.length, 1)
  assert.equal(queued[0]!.referenceType, 'SalesOrder')
  assert.equal(queued[0]!.status, 'PENDING', 'queued, not sent')
  assert.equal(queued[0]!.toEmail, `quote-${w.tag}@example.test`)
  assert.ok((await db.salesOrder.findUniqueOrThrow({ where: { id } })).quoteSentAt, 'the queue time is stamped')
  const dup = await sendQuoteEmail(id)
  assert.deepEqual(dup, { success: true, alreadyQueued: true })
  assert.equal((await rows()).length, 1, 'not duplicated while undelivered')

  // The preparer renders the real quote PDF at send time.
  const prepared = await prepareQueuedEmail('SALES_QUOTE', 'SalesOrder', id)
  assert.equal(prepared?.subject.startsWith('Quotation '), true)
  assert.equal(prepared?.attachments?.[0]?.content.subarray(0, 5).toString('latin1'), '%PDF-')
  assert.match(prepared?.attachments?.[0]?.filename ?? '', /^Quote-.*\.pdf$/)

  // Held: switched off after queueing, the preparer refuses (the drain settles the row FAILED and sends nothing).
  await setSalesQuoteEmailEnabled(false)
  await assert.rejects(() => prepareQueuedEmail('SALES_QUOTE', 'SalesOrder', id), (e: unknown) => e instanceof EmailKindDisabledError)
})

test('permission denial: converting, sending and the setting each refuse and write nothing', SKIP, async (t) => {
  const w = await seedWorld()
  t.after(() => w.teardown())
  const { createSalesOrder } = await import('@/app/actions/sales')
  const { convertQuoteToOrder, sendQuoteEmail, setSalesQuoteEmailEnabled } = await import('@/app/actions/sales-quotes')
  const { db } = await import('@/lib/db')
  const quote = await createSalesOrder(inputFor(w, { isQuote: true, quoteValidUntil: future(14) }) as never)
  assert.ok(quote.success)
  const id = quote.order!.id
  w.orderIds.push(id)
  await db.setting.upsert({ where: { key: 'sales_quote_email_enabled' }, create: { key: 'sales_quote_email_enabled', value: 'true' }, update: { value: 'true' } })
  try {
    for (const [permission, run] of [
      ['sales.create', () => convertQuoteToOrder(id)],
      ['sales.process', () => sendQuoteEmail(id)],
      ['settings.company', () => setSalesQuoteEmailEnabled(false)],
    ] as const) {
      denied = permission
      const r = await run()
      assert.equal(r.success, false, permission)
      assert.match(r.error ?? '', /Forbidden/)
    }
  } finally {
    denied = null
  }
  const row = await db.salesOrder.findUniqueOrThrow({ where: { id } })
  assert.equal(row.isQuote, true)
  assert.equal(await db.emailOutbox.count({ where: { referenceId: id } }), 0)
  assert.equal((await db.setting.findUniqueOrThrow({ where: { key: 'sales_quote_email_enabled' } })).value, 'true')
})
