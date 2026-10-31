import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { loadEnv, uid } from './po-landed-fixtures'

/**
 * THE ORDER WRITERS LOCK THE ACTIVE RATE THEIR HEADER NAMES (SalesOrder.taxRateName), against a real database. The tax import's deactivateAbsent holds the rate FOR UPDATE while it re-counts
 * the orders naming it; a writer that did not lock the named rate could commit an order after that re-count. Here the deactivation's lock is played by a transaction holding the rate FOR UPDATE:
 *
 *   (The lines carry another rate, so only the header names the rate under test.)
 *   createSalesOrder   waits for it (does not complete while the rate is held); when the holder deactivates the rate and commits, the order is REFUSED (not saved naming a deactivated rate);
 *                      when the holder commits without deactivating, the order is saved.
 *   cloneSalesOrder    waits for it the same way, then clones the source order's header name.
 * Mutations: the lock removed from createSalesOrder (it completes while the rate is held: first arm red); the "found active before, gone now" refusal removed (the order is saved naming a deactivated
 * rate: second arm red); the lock removed from cloneSalesOrder (the clone arm is red).
 * (The WooCommerce order import's lock is pinned by the census in tests/tax/sales-order-tax-rate-name-writers-census.test.ts.)
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

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

test('createSalesOrder and cloneSalesOrder wait for a transaction holding the named rate; a deactivation that commits first refuses the order, a plain release lets it through', SKIP, async (t) => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const { createSalesOrder, cloneSalesOrder } = await import('@/app/actions/sales')
  const tag = uid()
  const product = await db.product.create({ data: { sku: `NRL-${tag}`, name: 'named rate lock', type: 'SIMPLE' }, select: { id: true, sku: true } })
  const rateName = `ZQNRL${tag} rate`
  const rate = await db.taxRate.create({ data: { name: rateName, rate: '0.2', usedFor: 'SALES', active: true }, select: { id: true } })
  // The lines carry ANOTHER rate: only the header names the rate under test (the case the line-level share locks never covered).
  const lineRate = await db.taxRate.create({ data: { name: `ZQNRL${tag} line rate`, rate: '0.05', usedFor: 'SALES', active: true }, select: { id: true } })
  t.after(async () => {
    const orders = (await db.salesOrder.findMany({ where: { OR: [{ externalOrderNumber: { startsWith: `NRL${tag}` } }, { taxRateName: rateName }] }, select: { id: true } })).map((r) => r.id)
    await db.salesOrderLine.deleteMany({ where: { orderId: { in: orders } } })
    await db.salesOrder.deleteMany({ where: { id: { in: orders } } })
    await db.taxRate.deleteMany({ where: { id: { in: [rate.id, lineRate.id] } } })
    await db.product.deleteMany({ where: { id: product.id } })
  })
  const input = (key: string) => ({ externalOrderNumber: `NRL${tag}-${key}`, customerName: 'Named rate customer', currency: 'GBP', taxRateName: rateName, taxRateValue: 0.2, isDraft: true, lines: [{ productId: product.id, sku: product.sku, description: 'x', qty: 1, unitPriceForeign: 10, taxRateId: lineRate.id }] })

  /** A transaction that holds the rate FOR UPDATE (what deactivateAbsent's lock does) until released; `deactivate` switches it off in that same transaction. */
  const holdRate = async (deactivate: boolean) => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let held!: () => void
    const heldFirst = new Promise<void>((resolve) => { held = resolve })
    const tx = db.$transaction(async (inner) => {
      await inner.$queryRaw`SELECT id FROM tax_rates WHERE id = ${rate.id} FOR UPDATE`
      held()
      await gate
      if (deactivate) await inner.$executeRaw`UPDATE tax_rates SET active = false WHERE id = ${rate.id}`
    })
    await heldFirst
    return { release, done: tx }
  }
  const waitingOn = async <T>(promise: Promise<T>): Promise<{ settled: () => boolean }> => {
    let settled = false
    void promise.then(() => { settled = true }, () => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    return { settled: () => settled }
  }

  // (1) Deactivation committed while the writer waited: the order is refused, nothing is saved naming the rate.
  const deactivating = await holdRate(true)
  const refused = createSalesOrder(input('deactivated') as never)
  const w1 = await waitingOn(refused)
  assert.equal(w1.settled(), false, 'createSalesOrder waits for the transaction that holds the named rate')
  deactivating.release()
  await deactivating.done
  const result = await refused
  assert.equal(result.success, false)
  assert.match(String(result.error), /deactivated/, 'refused, naming the cause')
  assert.equal(await db.salesOrder.count({ where: { externalOrderNumber: `NRL${tag}-deactivated` } }), 0, 'no order was saved naming a rate that was switched off')

  // (2) Control: the holder releases without deactivating, the order is saved with the name. (Reactivate the rate first.)
  await db.taxRate.update({ where: { id: rate.id }, data: { active: true } })
  const plain = await holdRate(false)
  const saved = createSalesOrder(input('plain') as never)
  const w2 = await waitingOn(saved)
  assert.equal(w2.settled(), false, 'createSalesOrder waits')
  plain.release()
  await plain.done
  const ok = await saved
  assert.equal(ok.success, true, String(ok.error))
  const order = await db.salesOrder.findFirstOrThrow({ where: { externalOrderNumber: `NRL${tag}-plain` }, select: { id: true, taxRateName: true } })
  assert.equal(order.taxRateName, rateName)

  // (3) The clone locks the rate its copied header names.
  const cloneHold = await holdRate(false)
  const cloned = cloneSalesOrder(order.id)
  const w3 = await waitingOn(cloned)
  assert.equal(w3.settled(), false, 'cloneSalesOrder waits for the transaction that holds the named rate')
  cloneHold.release()
  await cloneHold.done
  const clone = await cloned
  assert.equal(clone.success, true, String(clone.error))
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: clone.newId! } })).taxRateName, rateName)
})

// ---------------------------------------------------------------------------------------------------------------------------------
// The deactivation WINS the race, on every writer; and an order spanning two rates against a multi-rate deactivation never deadlocks.
// ---------------------------------------------------------------------------------------------------------------------------------

const CHECKED_KEY = 'xero_tax_rate_drift_last_checked_at'

async function xeroSeed(db: Awaited<ReturnType<typeof loadDb>>, tenant: string) {
  const { digestTaxRateList } = await import('@/lib/connectors/xero/tax-rate-list')
  const rows = [{ taxType: 'INPUT2', name: 'Std', status: 'ACTIVE' as const, reportTaxType: null, effectiveRate: '20.000000', displayTaxRate: '20.000000', components: [{ name: 'VAT', rate: '20.000000', compound: false, nonRecoverable: false }], canApply: { assets: false, equity: false, expenses: true, liabilities: false, revenue: false } }]
  const fetchedAt = new Date(Date.now() - 300_000)
  await db.setting.deleteMany({ where: { key: CHECKED_KEY } })
  await db.accountingToken.deleteMany({ where: { connector: 'xero' } })
  await db.xeroTaxRateList.deleteMany({})
  await db.xeroTaxRate.deleteMany({})
  await db.accountingToken.create({ data: { connector: 'xero', accessToken: 'a', expiresAt: new Date(Date.now() + 3_600_000), tenantId: tenant, tenantName: `Org ${tenant}`, connectionGeneration: `gen-${tenant}` } })
  await db.xeroTaxRate.createMany({ data: rows.map((r) => ({ connector: 'xero', tenantId: tenant, fetchedAt, taxType: r.taxType, name: r.name, status: r.status, reportTaxType: r.reportTaxType, effectiveRate: r.effectiveRate, displayTaxRate: r.displayTaxRate, components: r.components, canApplyToAssets: r.canApply.assets, canApplyToEquity: false, canApplyToExpenses: r.canApply.expenses, canApplyToLiabilities: false, canApplyToRevenue: r.canApply.revenue })) })
  await db.xeroTaxRateList.create({ data: { connector: 'xero', tenantId: tenant, fetchedAt, rowCount: rows.length, digest: digestTaxRateList(tenant, rows as never) } })
  await db.setting.upsert({ where: { key: CHECKED_KEY }, create: { key: CHECKED_KEY, value: fetchedAt.toISOString() }, update: { value: fetchedAt.toISOString() } })
}
async function loadDb() {
  const { db } = await import('@/lib/db')
  return db
}

// [mutation: the named-rate lock removed from the WooCommerce order import -> the import does not wait for the held rate and saves the order: red; zero locked rows ignored (allowMissing forced) -> the order is saved naming the deactivated rate: red]
test('the WooCommerce import is refused (nothing saved) when the deactivation of its header rate commits while it waits for the lock', SKIP, async (t) => {
  loadEnv()
  const db = await loadDb()
  const actual = await import('@/lib/accounting')
  mock.module('@/lib/accounting', { namedExports: { ...actual, getAccountingSettings: async () => ({ connector: 'xero', salesAccount: '200', shippingAccount: '260', discountAccount: '270', reverseChargeSalesTaxType: '' }), queueAccountingSync: async () => ({ queued: true }) } })
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const tag = uid()
  const wcRateId = 800_000 + Math.floor(Math.random() * 90_000)
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  const rate = await db.taxRate.create({ data: { name: `ZQWCI${tag} NL`, rate: 0.21, usedFor: 'SALES', accountingTaxType: 'OUTPUT2', countryCode: 'NL', taxCategory: 'STANDARD' } })
  await db.shoppingTaxRateMapping.create({ data: { connector: 'woocommerce', externalTaxRateId: String(wcRateId), externalName: 'NL VAT', externalCountry: 'NL', externalRatePct: 21, taxRateId: rate.id } })
  const warehouse = await db.warehouse.create({ data: { code: `NRI-${tag.slice(0, 8)}`, name: 'named rate import warehouse', syncToStore: true, availableForSale: true } })
  t.after(async () => {
    await db.shoppingTaxRateMapping.deleteMany({ where: { taxRateId: rate.id } })
    await db.warehouse.deleteMany({ where: { id: warehouse.id } })
    await db.taxRate.deleteMany({ where: { id: rate.id } })
  })
  const address = { first_name: 'A', last_name: 'B', company: '', address_1: '1 St', address_2: '', city: 'Amsterdam', state: '', postcode: '1011AB', country: 'NL', email: 'a@b.c', phone: '' }
  const payload = {
    id: externalId, number: String(externalId), status: 'processing', currency: 'GBP', prices_include_tax: false, customer_note: '', customer_id: 0, payment_method: 'bacs', payment_method_title: 'Bank', transaction_id: '',
    date_paid_gmt: null, date_created: '2026-11-02T09:00:00', date_created_gmt: '2026-11-02T09:00:00', date_modified: '2026-11-02T09:00:00', date_modified_gmt: '2026-11-02T09:00:00',
    billing: address, shipping: address, meta_data: [],
    line_items: [{ id: 1, name: 'Widget', product_id: 1, variation_id: 0, quantity: 1, tax_class: '', subtotal: '100.00', subtotal_tax: '21.00', total: '100.00', total_tax: '21.00', sku: `NOSKU-${externalId}`, price: 100, taxes: [{ id: wcRateId, total: '21.00', subtotal: '21.00' }], meta_data: [] }],
    fee_lines: [], tax_lines: [{ id: 21, rate_code: 'NL-VAT-1', rate_id: wcRateId, label: 'VAT', compound: false, tax_total: '21.00', shipping_tax_total: '0.00', meta_data: [] }],
    shipping_lines: [], coupon_lines: [], refunds: [], total: '121.00', total_tax: '21.00', discount_total: '0.00', discount_tax: '0.00', shipping_total: '0.00', shipping_tax: '0.00',
  }
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let held!: () => void
  const heldFirst = new Promise<void>((resolve) => { held = resolve })
  const deactivator = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM tax_rates WHERE id = ${rate.id} FOR UPDATE`
    held()
    await gate
    await tx.$executeRaw`UPDATE tax_rates SET active = false WHERE id = ${rate.id}`
  })
  await heldFirst
  let settled = false
  const importing = importWcOrder(payload as never).then((r) => ({ r }), (e: unknown) => ({ e })).finally(() => { settled = true })
  await new Promise((resolve) => setTimeout(resolve, 2500))
  assert.equal(settled, false, `the import waits for the transaction that holds its header rate: ${JSON.stringify(await Promise.race([importing, null]).catch((e) => String(e)), (_k, v) => (typeof v === 'bigint' ? String(v) : v))}`)
  release()
  await deactivator
  const outcome = await importing
  const failed = 'e' in outcome || (outcome.r as { success?: boolean }).success === false
  assert.equal(failed, true, 'the import did not succeed')
  assert.equal(await db.shoppingOrderLink.count({ where: { connector: 'woocommerce', externalOrderId: String(externalId) } }), 0, 'no order was saved naming the deactivated rate')
  assert.equal(await db.salesOrder.count({ where: { externalOrderNumber: String(externalId) } }), 0)
})

// [mutation: the clone's allowMissing forced -> the clone is saved naming the deactivated rate: red]
test('cloneSalesOrder is refused when the deactivation of the copied header rate commits while it waits for the lock', SKIP, async (t) => {
  loadEnv()
  const db = await loadDb()
  const { createSalesOrder, cloneSalesOrder } = await import('@/app/actions/sales')
  const tag = uid()
  const product = await db.product.create({ data: { sku: `NRC-${tag}`, name: 'clone race', type: 'SIMPLE' }, select: { id: true, sku: true } })
  const rate = await db.taxRate.create({ data: { name: `ZQNRC${tag} rate`, rate: '0.2', usedFor: 'SALES', active: true }, select: { id: true, name: true } })
  const lineRate = await db.taxRate.create({ data: { name: `ZQNRC${tag} line`, rate: '0.05', usedFor: 'SALES', active: true }, select: { id: true } })
  t.after(async () => {
    const orders = (await db.salesOrder.findMany({ where: { OR: [{ externalOrderNumber: { startsWith: `NRC${tag}` } }, { taxRateName: rate.name }] }, select: { id: true } })).map((r) => r.id)
    await db.salesOrderLine.deleteMany({ where: { orderId: { in: orders } } })
    await db.salesOrder.deleteMany({ where: { id: { in: orders } } })
    await db.taxRate.deleteMany({ where: { id: { in: [rate.id, lineRate.id] } } })
    await db.product.deleteMany({ where: { id: product.id } })
  })
  const created = await createSalesOrder({ externalOrderNumber: `NRC${tag}-src`, customerName: 'Clone race', currency: 'GBP', taxRateName: rate.name, taxRateValue: 0.2, isDraft: true, lines: [{ productId: product.id, sku: product.sku, description: 'x', qty: 1, unitPriceForeign: 10, taxRateId: lineRate.id }] } as never)
  assert.equal(created.success, true, String(created.error))
  const sourceId = created.order!.id
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let held!: () => void
  const heldFirst = new Promise<void>((resolve) => { held = resolve })
  const deactivator = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM tax_rates WHERE id = ${rate.id} FOR UPDATE`
    held()
    await gate
    await tx.$executeRaw`UPDATE tax_rates SET active = false WHERE id = ${rate.id}`
  })
  await heldFirst
  const before = await db.salesOrder.count({ where: { taxRateName: rate.name } })
  const cloning = cloneSalesOrder(sourceId)
  await new Promise((resolve) => setTimeout(resolve, 1500))
  release()
  await deactivator
  const clone = await cloning
  assert.equal(clone.success, false)
  assert.match(String(clone.error), /deactivated/)
  assert.equal(await db.salesOrder.count({ where: { taxRateName: rate.name } }), before, 'no clone was saved naming the deactivated rate')
})

// [mutation: the writer's lock split back into two statements (lines, then the header) or the import's row locks taken one at a time in plan order -> the two take rows in opposite orders and a deadlock (40P01) shows within the iterations]
test('an order whose lines carry one rate and whose header names another never deadlocks against a multi-rate deactivation (20 rounds, opposite name and id orders)', SKIP, async (t) => {
  loadEnv()
  const db = await loadDb()
  const { createSalesOrder } = await import('@/app/actions/sales')
  const imp = await import('@/lib/tax/purchase-tax-import')
  const tag = uid()
  const tenant = `tenant-nrl-${tag}`
  await xeroSeed(db, tenant)
  const product = await db.product.create({ data: { sku: `NRD-${tag}`, name: 'deadlock', type: 'SIMPLE' }, select: { id: true, sku: true } })
  // Created in this order, so ids ascend A < B; the names run the other way (B sorts first), which is the order the import used to lock in.
  const rateA = await db.taxRate.create({ data: { name: `ZQNRD${tag} z-late-name`, rate: '0.2', usedFor: 'SALES', accountingTaxType: `ZQNRDA${tag.slice(0, 4)}`, active: true }, select: { id: true, name: true } })
  const rateB = await db.taxRate.create({ data: { name: `ZQNRD${tag} a-early-name`, rate: '0.2', usedFor: 'SALES', accountingTaxType: `ZQNRDB${tag.slice(0, 4)}`, active: true }, select: { id: true, name: true } })
  t.after(async () => {
    await db.setting.deleteMany({ where: { key: CHECKED_KEY } })
    await db.accountingToken.deleteMany({ where: { connector: 'xero' } })
    await db.xeroTaxRateList.deleteMany({})
    await db.xeroTaxRate.deleteMany({})
    const orders = (await db.salesOrder.findMany({ where: { externalOrderNumber: { startsWith: `NRD${tag}` } }, select: { id: true } })).map((r) => r.id)
    await db.salesOrderLine.deleteMany({ where: { orderId: { in: orders } } })
    await db.salesOrder.deleteMany({ where: { id: { in: orders } } })
    await db.taxRate.deleteMany({ where: { id: { in: [rateA.id, rateB.id] } } })
    await db.product.deleteMany({ where: { id: product.id } })
  })
  const results: string[] = []
  for (let round = 0; round < 20; round++) {
    await db.taxRate.updateMany({ where: { id: { in: [rateA.id, rateB.id] } }, data: { active: true } })
    // Alternate which rate the header names and which the line carries, so both opposite orders are exercised.
    const [header, line] = round % 2 === 0 ? [rateB, rateA] : [rateA, rateB]
    const [order, run] = await Promise.all([
      createSalesOrder({ externalOrderNumber: `NRD${tag}-${round}`, customerName: 'Deadlock', currency: 'GBP', taxRateName: header.name, taxRateValue: 0.2, isDraft: true, lines: [{ productId: product.id, sku: product.sku, description: 'x', qty: 1, unitPriceForeign: 10, taxRateId: line.id }] } as never),
      imp.runPurchaseTaxImport({ apply: true, types: [], deactivateAbsent: true }).then((r) => ({ r }), (e: unknown) => ({ e })),
    ])
    const text = `${String(order.error ?? '')} ${'e' in run ? String(run.e) : JSON.stringify(run.r, (_k, x) => (typeof x === 'bigint' ? String(x) : x))}`
    assert.ok(!/deadlock/i.test(text), `round ${round}: deadlock: ${text}`)
    // Either the order won (saved; the deactivation refused the rate it names) or the deactivation won (the order refused): never an order saved naming an inactive rate.
    const saved = await db.salesOrder.findFirst({ where: { externalOrderNumber: `NRD${tag}-${round}` }, select: { taxRateName: true } })
    if (saved !== null) {
      const named = await db.taxRate.findFirst({ where: { name: saved.taxRateName ?? '' }, select: { active: true } })
      assert.equal(named?.active, true, `round ${round}: an order was saved naming an inactive rate`)
    }
    results.push(saved === null ? 'order-refused' : 'order-saved')
  }
  console.log(`# deadlock rounds: ${results.join(',')}`)

  // DETERMINISTIC: a transaction holds the LOWER-id rate A FOR UPDATE; the order (lines on the higher-id rate B, header naming A) and the multi-rate deactivation queue behind it, in each order. A locker that
  // takes B first and then waits for A (the old writer: lines, then header; the old import: name order) deadlocks with the other one here, whichever queued first; ordered lockers never do.
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  for (const first of ['writer', 'import'] as const) {
    await db.taxRate.updateMany({ where: { id: { in: [rateA.id, rateB.id] } }, data: { active: true } })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let held!: () => void
    const heldFirst = new Promise<void>((resolve) => { held = resolve })
    const holder = db.$transaction(async (tx) => { await tx.$queryRaw`SELECT id FROM tax_rates WHERE id = ${rateA.id} FOR UPDATE`; held(); await gate })
    await heldFirst
    const startWriter = () => createSalesOrder({ externalOrderNumber: `NRD${tag}-det-${first}`, customerName: 'Deadlock', currency: 'GBP', taxRateName: rateA.name, taxRateValue: 0.2, isDraft: true, lines: [{ productId: product.id, sku: product.sku, description: 'x', qty: 1, unitPriceForeign: 10, taxRateId: rateB.id }] } as never).then((r) => ({ r }), (e: unknown) => ({ e }))
    const startImport = () => imp.runPurchaseTaxImport({ apply: true, types: [], deactivateAbsent: true }).then((r) => ({ r }), (e: unknown) => ({ e }))
    const started: Record<string, Promise<{ r?: unknown; e?: unknown }>> = {}
    for (const who of first === 'writer' ? (['writer', 'import'] as const) : (['import', 'writer'] as const)) {
      started[who] = who === 'writer' ? startWriter() : startImport()
      await sleep(1500)
    }
    release()
    await holder
    const [w, i] = await Promise.all([started.writer!, started.import!])
    const show = (v: unknown): string => JSON.stringify(v ?? null, (_k, x) => (typeof x === 'bigint' ? String(x) : x instanceof Error ? String(x) : x))
    const text = `${show(w.r)} ${String(w.e ?? '')} ${show(i.r)} ${String(i.e ?? '')}`
    assert.ok(!/deadlock|40P01/i.test(text), `${first} queued first: deadlock: ${text}`)
  }
})
