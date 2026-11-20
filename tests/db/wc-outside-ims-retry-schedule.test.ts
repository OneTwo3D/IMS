import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'
import { purge } from '../helpers/purge-rows'

/**
 * The owed-despatch retry's SCHEDULE and SIGNATURE rules, on a real database, with the completion flow replaced so each test chooses the
 * refusal an attempt ends in (a real allocation cannot be made to fail on demand for the non-stock reasons). Gated like the other DB tests; no network.
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/wc-outside-ims-retry-schedule.test.ts would have been skipped.')

mock.module('next/cache', { namedExports: { revalidatePath: () => undefined, revalidateTag: () => undefined } })
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
const state = { refusal: 'insufficient_physical_stock', calls: 0 }
mock.module('../../lib/connectors/woocommerce/sync/completion-flow', {
  namedExports: {
    processWcCompletion: async () => { state.calls++; return { kind: 'refused', error: `refused: ${state.refusal}`, permanent: false, refusal: state.refusal } },
  },
})

const ADMITTED = { createAdmission: 'preauthorised-by-status-query' } as const
const CUTOFF = '2026-11-05T00:00:00.000Z'
const AFTER_CUTOFF = '2026-11-10T11:00:00'

async function load() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('../../lib/db')
  const { Prisma } = await import('../../app/generated/prisma/client')
  const { importWcOrder } = await import('../../lib/connectors/woocommerce/sync/order-import')
  const mod = await import('../../lib/connectors/woocommerce/sync/outside-ims-despatch')
  const { openWcCompletionRefusalWhere } = await import('../../lib/domain/sales/wc-sync-row-families')
  const { recordWcCompletionRefusal } = await import('../../lib/connectors/woocommerce/sync/completion-refusal')
  return { db: db as Any, Prisma, importWcOrder, retry: mod.retryOwedOutsideImsDespatches, openWhere: openWcCompletionRefusalWhere, recordWcCompletionRefusal }
}

async function seedOwed(env: Awaited<ReturnType<typeof load>>, t: { after: (fn: () => Promise<void>) => void }) {
  const { db, Prisma, importWcOrder } = env
  const D = (v: number) => new Prisma.Decimal(String(v))
  const suffix = randomUUID().slice(0, 8)
  const warehouse = await db.warehouse.create({ data: { code: `S48${suffix}`, name: `s48 ${suffix}`, active: true, syncToStore: true, isDefault: false }, select: { id: true } })
  const product = await db.product.create({ data: { sku: `S48-${suffix}`, name: `s48 ${suffix}`, type: 'SIMPLE' }, select: { id: true, sku: true } })
  await db.stockLevel.create({ data: { productId: product.id, warehouseId: warehouse.id, quantity: D(1), reservedQty: D(0) } })
  await db.costLayer.create({ data: { productId: product.id, warehouseId: warehouse.id, receivedQty: D(1), remainingQty: D(1), unitCostBase: D(3), receivedAt: new Date(Date.now() - 40 * 86_400_000) } })
  await db.firstLoadApplyRun.deleteMany({ where: { manifestDigest: { startsWith: 's48-' } } })
  await db.firstLoadApplyRun.create({ data: { version: 1, manifestDigest: `s48-${randomUUID()}`, runId: `s48-${randomUUID()}`, status: 'APPLIED', facts: { openingStockCutoffAt: CUTOFF } } })
  const wcId = 700_000_000 + Math.floor(Math.random() * 90_000_000)
  const stamp = '2026-11-10T10:00:00'
  const payload: Any = {
    id: wcId, number: String(wcId), status: 'completed', currency: 'GBP', total: '30', total_tax: '0', discount_total: '0', shipping_total: '0', shipping_tax: '0', cart_tax: '0', prices_include_tax: false,
    date_created_gmt: stamp, date_modified_gmt: stamp, date_paid_gmt: stamp, date_completed_gmt: AFTER_CUTOFF, customer_id: 0,
    billing: { first_name: 'Ada', last_name: 'Test', email: `s48-${suffix}@example.invalid`, country: 'GB' }, shipping: { country: 'GB' },
    payment_method: 'bacs', payment_method_title: 'BACS', meta_data: [], tax_lines: [], shipping_lines: [], fee_lines: [], coupon_lines: [], refunds: [],
    line_items: [{ id: wcId + 1, name: 's48', product_id: 1, variation_id: 0, quantity: 3, subtotal: '30', subtotal_tax: '0', total: '30', total_tax: '0', sku: product.sku, price: 10, taxes: [], meta_data: [] }],
  }
  state.refusal = 'insufficient_physical_stock'
  const orderId = (await importWcOrder(payload, ADMITTED)).orderId as string
  assert.ok(orderId)
  t.after(async () => {
    await db.firstLoadApplyRun.deleteMany({ where: { manifestDigest: { startsWith: 's48-' } } })
    await db.activityLog.deleteMany({ where: { entityId: orderId } })
    await db.shoppingSyncLog.deleteMany({ where: { OR: [{ entityId: orderId }, { externalId: String(wcId) }] } })
    await purge(db, 'sales_orders', 'id', [orderId])
    const customers: Array<{ id: string }> = await db.customer.findMany({ where: { email: `s48-${suffix}@example.invalid` }, select: { id: true } })
    await purge(db, 'customers', 'id', customers.map((row) => row.id))
    await purge(db, 'products', 'id', [product.id])
    await purge(db, 'warehouses', 'id', [warehouse.id])
  })
  const row = async () => (await db.shoppingSyncLog.findFirstOrThrow({ where: { ...env.openWhere(), entityId: orderId }, select: { id: true, payload: true } })).payload as Any
  return { orderId, payload, row, productId: product.id as string, warehouseId: warehouse.id as string }
}

test('[db] the signature is kept only after a genuine stock shortfall: any other refusal clears it, so the next due check really attempts', { skip }, async (t) => {
  const env = await load()
  const fx = await seedOwed(env, t)
  const live = async () => ({ order: fx.payload })
  const base = Date.now()
  const at = (minutes: number) => new Date(base + minutes * 60_000)
  await env.retry(20, live, at(1))
  assert.ok((await fx.row()).stockSignature !== undefined, 'a stock shortfall keeps the signature')
  const before = state.calls
  assert.equal((await env.retry(20, live, at(30))).skipped, 1, 'unchanged: skipped')
  assert.equal(state.calls, before, 'no attempt was made')
  // Something moves, and the attempt now ends for a reason that has nothing to do with stock.
  state.refusal = 'auto_allocation_failed'
  await env.db.stockLevel.updateMany({ where: { productId: fx.productId }, data: { quantity: new env.Prisma.Decimal('2') } })
  await env.retry(20, live, at(120))
  assert.equal((await fx.row()).stockSignature, undefined, 'auto_allocation_failed does not keep the signature')
  const calls = state.calls
  const next = await env.retry(20, live, at(24 * 60))
  assert.equal(next.skipped, 0, 'no skip after a non-stock refusal even though no stock level moved')
  assert.equal(state.calls, calls + 1)
})

test('[db] whatever the signature says, a real attempt is made at least once a day', { skip }, async (t) => {
  const env = await load()
  const fx = await seedOwed(env, t)
  const live = async () => ({ order: fx.payload })
  const base = Date.now()
  const at = (minutes: number) => new Date(base + minutes * 60_000)
  await env.retry(20, live, at(1))
  assert.equal((await env.retry(20, live, at(30))).skipped, 1)
  const calls = state.calls
  const day = await env.retry(20, live, at(1 + 24 * 60))
  assert.equal(day.skipped, 0, JSON.stringify(day))
  assert.equal(state.calls, calls + 1, 'the forced attempt ran')
})

test('[db] a failed or gone live read is scheduled like any check, so it cannot stay due and first in line', { skip }, async (t) => {
  const env = await load()
  const fx = await seedOwed(env, t)
  const base = Date.now()
  const first = await env.retry(20, async () => ({ failed: true }), new Date(base))
  assert.equal(first.failed, 1)
  assert.ok((await fx.row()).nextAttemptAt, 'a next check time was written')
  assert.equal((await env.retry(20, async () => ({ gone: true }), new Date(base + 60_000))).scanned, 0, 'not due again inside the back-off')
})

test('[db] retry bookkeeping merges into the row: a refusal re-record keeps it, and the retry keeps what the re-record wrote', { skip }, async (t) => {
  const env = await load()
  const fx = await seedOwed(env, t)
  const live = async () => ({ order: fx.payload })
  const base = Date.now()
  await env.retry(20, live, new Date(base + 60_000))
  const eventAt = new Date(base + 3_600_000)
  await env.recordWcCompletionRefusal({ orderId: fx.orderId, externalOrderId: fx.payload.id, wcStatus: 'completed', refusal: 'insufficient_physical_stock', error: 'newer delivery', eventAt })
  const mid = await fx.row()
  assert.equal(mid.retryAttempts, 1, 'the re-record carried the retry state')
  assert.equal((await env.retry(20, live, new Date(base + 2 * 3_600_000))).skipped, 1, 'the signature and the forced-attempt clock survived the re-record')
  const after = await fx.row()
  assert.equal(after.error, 'newer delivery', 'a schedule-only check did not overwrite the re-record')
  assert.equal(after.refusedEventAt, eventAt.toISOString())
  assert.ok(after.retryChecks >= 2)
})

test('the exceptions screen compares against the shared reopened-decision refusal code', async () => {
  const { readFileSync } = await import('node:fs')
  const { WC_REOPENED_OPERATOR_DECISION_REFUSAL } = await import('../../lib/domain/sales/wc-sync-row-families')
  assert.ok(readFileSync('app/(dashboard)/sync/exceptions/exceptions-client.tsx', 'utf8').includes(`'${WC_REOPENED_OPERATOR_DECISION_REFUSAL}'`))
})
