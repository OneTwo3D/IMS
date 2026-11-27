import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * A TYPED PRICE REFUND THROUGH THE REAL WRITER (syncWcRefund -> createRefund -> createSalesOrderRefund), against a real PostgreSQL (scratch database). WooCommerce fills a line's tax only when its quantity changes, so a price typed on a 20% line arrives as total 5.00, total_tax 0.
 * The sync reads it as GROSS at the order's rate (net 4.1667, VAT 0.8333), the writer's posted-VAT fence accepts it, and the credit note's VAT on that line is 0.83 - not refused, not 0.
 */
const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'

let depsPromise: ReturnType<typeof loadDepsOnce> | undefined
function loadDeps() { depsPromise ??= loadDepsOnce(); return depsPromise }
async function loadDepsOnce() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  mock.module('../../lib/domain/sales/post-refund-release.ts', { namedExports: { releaseReservationsAfterRefund: async () => undefined } })
  mock.module('next/headers', { namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }) } })
  mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn } })
  const realAuth = await import('../../lib/auth/server.ts')
  mock.module('../../lib/auth/server.ts', { namedExports: { ...realAuth, requirePermission: async () => ({ user: { id: 'ioss-cn-test' } }), requireFreshPermission: async () => ({ user: { id: 'ioss-cn-test' } }), freshAuthFailureResult: () => null } })
  const [{ db }, actions, bypass, { getBaseCurrencyCode }] = await Promise.all([
    import('../../lib/db/index.ts'), import('../../app/actions/sales.ts'), import('../../lib/internal-action-bypass.ts'), import('../../lib/base-currency.ts'),
  ])
  return { db, createRefund: actions.createRefund, bypass: bypass.INTERNAL_ACTION_BYPASS, baseCurrency: await getBaseCurrencyCode() }
}
type Deps = Awaited<ReturnType<typeof loadDepsOnce>>
type Db = Deps['db']


async function seed(deps: Deps, opts: { orderRate: string }) {
  const { db } = deps
  const { Prisma } = await import('../../app/generated/prisma/client.ts')
  const suffix = randomUUID().slice(0, 8)
  const rate = await db.taxRate.create({ data: { name: `GB TYPED VAT ${suffix}`, rate: new Prisma.Decimal('0.2'), usedFor: 'SALES', accountingTaxType: `OUTPUT2_${suffix}`, countryCode: 'GB', taxCategory: 'STANDARD', active: true } })
  const dec = (v: string) => new Prisma.Decimal(v)
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `TP-${suffix}`, status: 'SHIPPED', currency: deps.baseCurrency, fxRateToBase: dec('1'), pricesIncludeVat: false, taxRateName: rate.name, taxRatePercent: dec(opts.orderRate),
      subtotalForeign: dec('110'), subtotalBase: dec('110'), taxForeign: dec('22'), taxBase: dec('22'), totalForeign: dec('132'), totalBase: dec('132'), shippingForeign: dec('10'), shippingBase: dec('10'),
      lines: { create: [{ description: 'Widget', qty: dec('1'), unitPriceForeign: dec('100'), unitPriceBase: dec('100'), taxForeign: dec('20'), taxBase: dec('20'), totalForeign: dec('100'), totalBase: dec('100'), taxRateId: rate.id, externalLineItemId: 501 }] },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  const externalOrderId = 7_000_000 + Math.floor(Math.random() * 1_000_000)
  await db.shoppingOrderLink.create({ data: { orderId: order.id, connector: 'woocommerce', externalOrderId: String(externalOrderId) } })
  return { rate, orderId: order.id, lineId: order.lines[0]!.id, externalOrderId }
}
type Fixture = Awaited<ReturnType<typeof seed>>

async function cleanup(db: Db, fx: Fixture | undefined) {
  if (!fx) return
  const refunds = await db.salesOrderRefund.findMany({ where: { orderId: fx.orderId }, select: { id: true } })
  const ids = refunds.map((r) => r.id)
  await db.accountingSyncLog.deleteMany({ where: { referenceId: { in: [...ids, fx.orderId] } } }).catch(() => {})
  await db.accountingEvent.deleteMany({ where: { sourceEntityId: { in: ids } } }).catch(() => {})
  await db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId: fx.orderId } } }).catch(() => {})
  await db.salesOrderRefund.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
  await db.shoppingSyncLog.deleteMany({ where: { entityId: fx.orderId } }).catch(() => {})
  await db.shoppingOrderLink.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
  await db.activityLog.deleteMany({ where: { entityId: fx.orderId } }).catch(() => {})
  await db.salesOrderLine.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
  await db.salesOrder.deleteMany({ where: { id: fx.orderId } }).catch(() => {})
  await db.taxRate.deleteMany({ where: { id: fx.rate.id } }).catch(() => {})
}

const wooRefundId = () => 3_000_000 + Math.floor(Math.random() * 6_000_000)
/** A typed 5.00 price refund on goods line 501 (total 5.00, total_tax 0, quantity 0) beside a 5.00 + 1.00 VAT shipping refund: 11.00 in all. */
const typedPriceRefund = (id: number, parent: number, tax = '0') => ({
  id, parent_id: parent, date_created: '2026-11-02T10:00:00', date_created_gmt: '2026-11-02T10:00:00', amount: (5 + 5 + 1 + Number(tax)).toFixed(2), reason: 'r', refunded_by: 1, refunded_payment: false,
  meta_data: [],
  line_items: [{ id: 91, name: 'Widget', product_id: 1, variation_id: 0, quantity: 0, tax_class: '', subtotal: '0', subtotal_tax: '0', total: '-5.00', total_tax: `-${tax}`, sku: 's', meta_data: [{ id: 1, key: '_refunded_item_id', value: '501' }], refund_total: -5 }],
  shipping_lines: [{ id: 5, method_title: 'Shipping', method_id: 'flat_rate', total: '-5.00', total_tax: '-1.00', taxes: [] }],
})

test('[typed price refund] a typed 5.00 (tax 0) on a 20% line is recorded through the real writer: net 4.1667, charged VAT 0.8333, credit-note VAT 0.83, gross 5.00', { skip }, async (t) => {
  const deps = await loadDeps()
  const fx = await seed(deps, { orderRate: '0.2' })
  t.after(async () => { await cleanup(deps.db, fx) })
  const { syncWcRefund } = await import('../../lib/connectors/woocommerce/sync/refund-sync.ts')
  const outcome = await syncWcRefund(fx.externalOrderId, typedPriceRefund(wooRefundId(), fx.externalOrderId) as never)
  assert.notEqual(outcome.outcome, 'quarantined-refusal', outcome.error)
  const refunds = await deps.db.salesOrderRefund.findMany({ where: { orderId: fx.orderId }, select: { id: true } })
  assert.equal(refunds.length, 1, 'recorded: ' + (outcome.error ?? ''))
  const lines = await deps.db.salesOrderRefundLine.findMany({ where: { refundId: refunds[0]!.id, salesOrderLineId: fx.lineId }, select: { totalForeign: true, chargedTaxForeign: true, postedTaxRate: true } })
  assert.equal(lines.length, 1)
  const line = lines[0]!
  assert.equal(line.totalForeign.toString(), '4.1667')
  assert.equal(line.chargedTaxForeign?.toString(), '0.8333')
  assert.equal(Number(line.postedTaxRate), 0.2, 'posted under the 20% identity')
  const net = Number(line.totalForeign)
  assert.equal((net * Number(line.postedTaxRate)).toFixed(2), '0.83', 'the credit note VAT on the typed line')
  assert.equal((net * (1 + Number(line.postedTaxRate))).toFixed(2), '5.00', 'and its gross is what the operator typed')
})

test('[typed price refund] when the order rate cannot be established the refund is QUARANTINED, nothing is recorded, and the message does not send the operator to map a tax code', { skip }, async (t) => {
  const deps = await loadDeps()
  const fx = await seed(deps, { orderRate: '0.1' })
  t.after(async () => { await cleanup(deps.db, fx) })
  const { syncWcRefund } = await import('../../lib/connectors/woocommerce/sync/refund-sync.ts')
  const outcome = await syncWcRefund(fx.externalOrderId, typedPriceRefund(wooRefundId(), fx.externalOrderId) as never)
  assert.equal(outcome.outcome, 'quarantined-refusal')
  assert.match(outcome.error ?? '', /no VAT stated/)
  assert.doesNotMatch(outcome.error ?? '', /tax code|Settings → Tax Rates/)
  assert.equal((await deps.db.salesOrderRefund.findMany({ where: { orderId: fx.orderId } })).length, 0)
})
