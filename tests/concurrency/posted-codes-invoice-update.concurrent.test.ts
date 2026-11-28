import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { loadEnv, uid } from './po-landed-fixtures'

/**
 * AN UPDATE OF A POSTED INVOICE KEEPS ITS POSTED CODES (owner ruling: a later remap only affects new invoices), against a real database, through the real create and edit paths.
 *
 *  1. An order is created (its invoice queued by the real builder, bindings and all), the invoice is marked posted, and the rate is then remapped IN PLACE. The edit's SALES_INVOICE_UPDATE keeps the posted code on the
 *     line of the unchanged rate and takes the CURRENT code on a line of a rate the invoice never carried.
 *  2. The same edit with no usable record (a hand-linked invoice: no sync row) is built on the current codes and writes the activity WARNING, once.
 *  3. An invoice that was never remapped: the update is byte-identical to what it was (same codes as the current mapping), and no warning is written.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

const permissionsAsked: string[] = []
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async (permission: string) => {
      permissionsAsked.push(permission)
      return { user: { id: 'test-user', role: 'ADMIN' } }
    },
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireFreshPermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
const stockSyncs: string[][] = []
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async (ids: string[]) => { stockSyncs.push(ids) } } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })

type World = {
  tag: string
  warehouseId: string
  p1: { id: string; sku: string }
  p2: { id: string; sku: string }
  rateName: string
  orderIds: string[]
  settingKeys: string[]
  teardown: () => Promise<void>
}

async function seedWorld(stock = 20): Promise<World> {
  loadEnv()
  const { db } = await import('@/lib/db')
  const tag = uid()
  // The shared CI database may carry accounting settings an earlier file left (Xero switched on without its shipping account refuses every create). The world starts with none and puts them back at teardown; tests that need invoicing set their own.
  const leftover = await db.setting.findMany({ where: { OR: [{ key: { startsWith: 'xero_' } }, { key: 'plugin_xero_enabled' }] } })
  await db.setting.deleteMany({ where: { key: { in: leftover.map((r) => r.key) } } })
  await db.user.upsert({ where: { id: 'test-user' }, create: { id: 'test-user', email: 'test-user@example.invalid', name: 'test user', passwordHash: 'x' }, update: {} })
  const rate = await db.taxRate.create({ data: { name: `ZQEC Std 20 ${tag}`, rate: '0.2', usedFor: 'SALES', taxCategory: 'STANDARD', accountingTaxType: 'OUTPUT2', active: true }, select: { id: true } })
  // syncToStore so a shop-linked order can allocate from it; the only warehouse the orders name.
  const warehouse = await db.warehouse.create({ data: { code: `EC${tag.slice(0, 8)}`, name: `Edit confirmed ${tag}`, active: true, availableForSale: true, syncToStore: true }, select: { id: true } })
  const mk = async (k: string) => db.product.create({ data: { sku: `EC-${k}-${tag}`, name: `Edit confirmed ${k}`, type: 'SIMPLE', taxCategory: 'STANDARD', oversellAllowed: false }, select: { id: true, sku: true } })
  const p1 = await mk('P1')
  const p2 = await mk('P2')
  for (const p of [p1, p2]) await db.stockLevel.create({ data: { productId: p.id, warehouseId: warehouse.id, quantity: stock } })
  const world: World = {
    tag, warehouseId: warehouse.id, p1, p2, rateName: `ZQEC Std 20 ${tag}`, orderIds: [], settingKeys: [],
    teardown: async () => {
      const ids = world.orderIds
      await db.wmsOrderPushLink.deleteMany({ where: { orderId: { in: ids } } })
      await db.shoppingOrderLink.deleteMany({ where: { orderId: { in: ids } } })
      await db.accountingSyncLog.deleteMany({ where: { referenceId: { in: ids } } })
      await db.shipment.deleteMany({ where: { orderId: { in: ids } } })
      await db.activityLog.deleteMany({ where: { entityId: { in: ids } } })
      await db.salesOrderLine.deleteMany({ where: { orderId: { in: ids } } })
      await db.salesOrder.deleteMany({ where: { id: { in: ids } } })
      await db.stockLevel.deleteMany({ where: { warehouseId: warehouse.id } })
      await db.product.deleteMany({ where: { id: { in: [p1.id, p2.id] } } })
      await db.warehouse.deleteMany({ where: { id: warehouse.id } })
      await db.taxRate.deleteMany({ where: { id: rate.id } })
      await db.setting.deleteMany({ where: { key: { in: [...world.settingKeys, ...leftover.map((r) => r.key)] } } })
      for (const r of leftover) await db.setting.create({ data: { key: r.key, value: r.value } })
      // The guard refuses a database holding users, so the acting user the mocked session names is removed again.
      await db.user.deleteMany({ where: { id: 'test-user' } })
    },
  }
  return world
}

type Line = { p: 'p1' | 'p2'; qty: number; price?: number }

function inputFor(w: World, lines: Line[], extra: Record<string, unknown> = {}) {
  return {
    customerName: 'Edit Confirmed Customer',
    customerEmail: 'ec@example.test',
    billingAddress: { line1: '1 Bill St', country: 'GB' },
    shippingAddress: { line1: '2 Ship St', country: 'GB' },
    currency: 'GBP',
    shipFromWarehouseId: w.warehouseId,
    taxRateName: w.rateName,
    taxRateValue: 0.2,
    pricesIncludeVat: false,
    shippingForeign: 5,
    notes: 'n',
    isDraft: false,
    lines: lines.map((l) => ({ productId: w[l.p].id, sku: w[l.p].sku, description: `Desc ${l.p}`, qty: l.qty, unitPriceForeign: l.price ?? 10 })),
    ...extra,
  }
}

async function versionOf(orderId: string): Promise<string> {
  const { db } = await import('@/lib/db')
  return (await db.salesOrder.findUniqueOrThrow({ where: { id: orderId }, select: { updatedAt: true } })).updatedAt.toISOString()
}

async function enableXeroInvoicing(w: World) {
  const { db } = await import('@/lib/db')
  const settings: Array<[string, string]> = [['plugin_xero_enabled', 'true'], ['xero_sync_enabled', 'true'], ['xero_sync_sales_invoice', 'submitted'], ['xero_sales_account', '200'], ['xero_shipping_account', '260']]
  for (const [key, value] of settings) {
    await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
    w.settingKeys.push(key)
  }
}

async function postInvoice(w: World, orderId: string): Promise<void> {
  const { db } = await import('@/lib/db')
  const invoiceId = `XERO-${w.tag}-${orderId.slice(-6)}`
  await db.accountingSyncLog.updateMany({ where: { referenceId: orderId, type: 'SALES_INVOICE' }, data: { status: 'SYNCED', externalTransactionId: invoiceId, syncedAt: new Date() } })
  await db.salesOrder.update({ where: { id: orderId }, data: { accountingInvoiceId: invoiceId, accountingInvoiceConnector: 'xero', invoiceNumber: `INV-${invoiceId}`, invoicedAt: new Date('2026-09-30T00:00:00Z') } })
}

async function updatePayloadOf(orderId: string) {
  const { db } = await import('@/lib/db')
  const row = await db.accountingSyncLog.findFirstOrThrow({ where: { referenceId: orderId, type: 'SALES_INVOICE_UPDATE', status: 'PENDING' }, orderBy: { createdAt: 'desc' } })
  return row.payload as { lines: Array<{ taxType: string; taxRateId?: string; quantity: number }>; shippingTaxType?: string }
}

test('a posted invoice whose rate was remapped: the update keeps the posted code on the unchanged rate and takes the current code on a new rate; with no record it falls back to current and warns', SKIP, async (t) => {
  process.env.SETTINGS_ENCRYPTION_KEY ??= 'a1'.repeat(32)
  const w = await seedWorld()
  const { db } = await import('@/lib/db')
  const extraRates: string[] = []
  t.after(async () => { await db.taxRate.deleteMany({ where: { id: { in: extraRates } } }); await w.teardown() })
  await enableXeroInvoicing(w)
  const { updateSalesOrder } = await import('@/app/actions/sales')
  const rateA = await db.taxRate.findFirstOrThrow({ where: { name: w.rateName }, select: { id: true } })
  const rateB = await db.taxRate.create({ data: { name: `ZQPC B ${w.tag}`, rate: '0.05', usedFor: 'SALES', taxCategory: 'STANDARD', accountingTaxType: `PCB-${w.tag}`, active: true }, select: { id: true } })
  extraRates.push(rateB.id)
  const withRates = (lines: Array<{ p: 'p1' | 'p2'; qty: number; rate: string }>) => {
    const i = inputFor(w, lines.map((l) => ({ p: l.p, qty: l.qty })))
    return { ...i, lines: i.lines.map((l, idx) => ({ ...l, taxRateId: lines[idx]!.rate })) }
  }
  const { createSalesOrder } = await import('@/app/actions/sales')
  const make = async (lines: Array<{ p: 'p1' | 'p2'; qty: number; rate: string }>) => {
    const r = await createSalesOrder(withRates(lines) as never)
    assert.equal(r.success, true, r.error)
    w.orderIds.push(r.order!.id)
    return r.order!.id
  }

  // 1. posted, remapped in place, edited: the unchanged rate keeps OUTPUT2; the new rate takes its current code.
  const id = await make([{ p: 'p1', qty: 1, rate: rateA.id }])
  await postInvoice(w, id)
  await db.taxRate.update({ where: { id: rateA.id }, data: { accountingTaxType: `PCA-REMAPPED-${w.tag}` } })
  const r1 = await updateSalesOrder(id, withRates([{ p: 'p1', qty: 2, rate: rateA.id }, { p: 'p2', qty: 1, rate: rateB.id }]) as never, await versionOf(id))
  assert.equal(r1.success, true, r1.error)
  const p1 = await updatePayloadOf(id)
  const byRate = new Map(p1.lines.map((l) => [l.taxRateId ?? (l as { postedFromRateId?: string }).postedFromRateId, l.taxType]))
  assert.equal(byRate.get(rateA.id), 'OUTPUT2', 'the unchanged rate keeps the code the invoice was posted with')
  assert.equal(byRate.get(rateB.id), `PCB-${w.tag}`, 'a rate the invoice never carried takes the current code')
  assert.equal(p1.shippingTaxType, 'OUTPUT2', 'shipping keeps the posted default code')
  assert.equal(await db.activityLog.count({ where: { entityId: id, action: 'sales_invoice_update_used_current_tax_codes' } }), 0, 'a usable record: no warning')

  // 2. the same remapped order with no usable record (a hand-linked invoice): current codes, and one warning.
  const id2 = await make([{ p: 'p1', qty: 1, rate: rateA.id }])
  await postInvoice(w, id2)
  await db.accountingSyncLog.deleteMany({ where: { referenceId: id2 } })
  const r2 = await updateSalesOrder(id2, withRates([{ p: 'p1', qty: 2, rate: rateA.id }]) as never, await versionOf(id2))
  assert.equal(r2.success, true, r2.error)
  const p2 = await updatePayloadOf(id2)
  assert.equal(p2.lines[0]!.taxType, `PCA-REMAPPED-${w.tag}`, 'no record: the current code')
  assert.equal(await db.activityLog.count({ where: { entityId: id2, action: 'sales_invoice_update_used_current_tax_codes', level: 'WARNING' } }), 1, 'the fallback is flagged once')
})

test('a posted invoice that was never remapped: the update carries the current codes (identical to today) and writes no warning', SKIP, async (t) => {
  process.env.SETTINGS_ENCRYPTION_KEY ??= 'a1'.repeat(32)
  const w = await seedWorld()
  const { db } = await import('@/lib/db')
  t.after(async () => { await w.teardown() })
  await enableXeroInvoicing(w)
  const { updateSalesOrder, createSalesOrder } = await import('@/app/actions/sales')
  const rateA = await db.taxRate.findFirstOrThrow({ where: { name: w.rateName }, select: { id: true } })
  const i = inputFor(w, [{ p: 'p1', qty: 1 }])
  const created = await createSalesOrder({ ...i, lines: i.lines.map((l) => ({ ...l, taxRateId: rateA.id })) } as never)
  assert.equal(created.success, true, created.error)
  const id = created.order!.id
  w.orderIds.push(id)
  await postInvoice(w, id)
  const e = inputFor(w, [{ p: 'p1', qty: 3 }])
  const r = await updateSalesOrder(id, { ...e, lines: e.lines.map((l) => ({ ...l, taxRateId: rateA.id })) } as never, await versionOf(id))
  assert.equal(r.success, true, r.error)
  const payload = await updatePayloadOf(id)
  assert.equal(payload.lines[0]!.taxType, 'OUTPUT2')
  assert.equal(payload.shippingTaxType, 'OUTPUT2')
  assert.equal(await db.activityLog.count({ where: { entityId: id, action: 'sales_invoice_update_used_current_tax_codes' } }), 0)
})

async function postedFixture(t: { after: (fn: () => Promise<void>) => void }) {
  process.env.SETTINGS_ENCRYPTION_KEY ??= 'a1'.repeat(32)
  const w = await seedWorld()
  const { db } = await import('@/lib/db')
  const extra: { rates: string[]; tokens: string[]; taxRows: string[] } = { rates: [], tokens: [], taxRows: [] }
  t.after(async () => {
    delete process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS
    await db.xeroTaxRate.deleteMany({ where: { id: { in: extra.taxRows } } }).catch(() => {})
    await db.accountingToken.deleteMany({ where: { id: { in: extra.tokens } } }).catch(() => {})
    await db.taxRate.deleteMany({ where: { id: { in: extra.rates } } }).catch(() => {})
    await w.teardown()
  })
  await enableXeroInvoicing(w)
  const { updateSalesOrder, createSalesOrder } = await import('@/app/actions/sales')
  const rateA = await db.taxRate.findFirstOrThrow({ where: { name: w.rateName }, select: { id: true } })
  const mkRate = async (key: string, rate: string, code: string) => {
    const r = await db.taxRate.create({ data: { name: `ZQPC ${key} ${w.tag}`, rate, usedFor: 'SALES', taxCategory: 'STANDARD', accountingTaxType: code, active: true }, select: { id: true, name: true } })
    extra.rates.push(r.id)
    return r
  }
  const input = (lines: Array<{ p: 'p1' | 'p2'; qty: number; rate: string }>, over: Record<string, unknown> = {}) => {
    const i = inputFor(w, lines.map((l) => ({ p: l.p, qty: l.qty })), over)
    return { ...i, lines: i.lines.map((l, idx) => ({ ...l, taxRateId: lines[idx]!.rate })) }
  }
  const make = async (lines: Array<{ p: 'p1' | 'p2'; qty: number; rate: string }>) => {
    const r = await createSalesOrder(input(lines) as never)
    assert.equal(r.success, true, r.error)
    w.orderIds.push(r.order!.id)
    return r.order!.id
  }
  const edit = async (id: string, lines: Array<{ p: 'p1' | 'p2'; qty: number; rate: string }>, over: Record<string, unknown> = {}) => updateSalesOrder(id, input(lines, over) as never, await versionOf(id))
  return { w, db, rateA, mkRate, make, edit, extra }
}

test('an edit that changes the header VAT rate of a posted order saves, and shipping goes on the new default code; a WooCommerce-style zero-rated postage bound to its own rate is not changed', SKIP, async (t) => {
  const f = await postedFixture(t)
  const zero = await f.mkRate('Z', '0', `PCZ-${f.w.tag}`)
  const id = await f.make([{ p: 'p1', qty: 1, rate: f.rateA.id }])
  await postInvoice(f.w, id)
  // The header rate is edited from 20% to Zero: the posted default code must not be re-bound to the NEW default rate.
  const r1 = await f.edit(id, [{ p: 'p1', qty: 2, rate: f.rateA.id }], { taxRateName: zero.name, taxRateValue: 0 })
  assert.equal(r1.success, true, r1.error)
  assert.equal((await updatePayloadOf(id)).shippingTaxType, `PCZ-${f.w.tag}`, 'shipping takes the current (zero) default code')

  // A posted shipping bound to ANOTHER rate than the default (WooCommerce zero-rated postage): not read as the default's posted code, so the update is what it always was (the default's current code).
  const id2 = await f.make([{ p: 'p1', qty: 1, rate: f.rateA.id }])
  await postInvoice(f.w, id2)
  const row = await f.db.accountingSyncLog.findFirstOrThrow({ where: { referenceId: id2, type: 'SALES_INVOICE' } })
  await f.db.accountingSyncLog.update({ where: { id: row.id }, data: { payload: { ...(row.payload as object), shippingTaxType: `PCZ-${f.w.tag}`, shippingTaxRateId: zero.id, shippingTaxRateBasis: 'plain' } } })
  const r2 = await f.edit(id2, [{ p: 'p1', qty: 2, rate: f.rateA.id }])
  assert.equal(r2.success, true, r2.error)
  assert.equal((await updatePayloadOf(id2)).shippingTaxType, 'OUTPUT2', 'unchanged from before this PR')
})

test('a rate a re-key CLEARED, remapped after posting: the edit saves (the posted code is not bound to the rate), and the next update still finds the rate', SKIP, async (t) => {
  const f = await postedFixture(t)
  const id = await f.make([{ p: 'p1', qty: 1, rate: f.rateA.id }])
  await postInvoice(f.w, id)
  await f.db.taxRate.update({ where: { id: f.rateA.id }, data: { accountingTaxType: `PCA-NEW-${f.w.tag}` } })
  await f.db.setting.upsert({ where: { key: 'tax_rekey_cleared_rates' }, create: { key: 'tax_rekey_cleared_rates', value: JSON.stringify({ [f.rateA.id]: { at: new Date().toISOString() } }) }, update: { value: JSON.stringify({ [f.rateA.id]: { at: new Date().toISOString() } }) } })
  f.w.settingKeys.push('tax_rekey_cleared_rates')
  // The rate's CURRENT code is valid and live at the tenant (as after a real re-key): what the guard demands of a binding to a cleared rate.
  const token = await f.db.accountingToken.create({ data: { connector: 'xero', accessToken: 'x', expiresAt: new Date(Date.now() + 3600_000), tenantId: `T-${f.w.tag}` }, select: { id: true } })
  f.extra.tokens.push(token.id)
  const tax = await f.db.xeroTaxRate.create({ data: { connector: 'xero', tenantId: `T-${f.w.tag}`, taxType: `PCA-NEW-${f.w.tag}`, name: 'live', status: 'ACTIVE', components: [], fetchedAt: new Date() }, select: { id: true } })
  f.extra.taxRows.push(tax.id)
  const r = await f.edit(id, [{ p: 'p1', qty: 2, rate: f.rateA.id }])
  assert.equal(r.success, true, `the guard does not refuse the re-sent posted code: ${r.error}`)
  const payload = (await updatePayloadOf(id)) as { lines: Array<Record<string, unknown>> }
  assert.equal(payload.lines[0]!.taxType, 'OUTPUT2')
  assert.equal(payload.lines[0]!.taxRateId, undefined, 'not bound to the rate under the key the guard reads')
  assert.equal(payload.lines[0]!.postedFromRateId, f.rateA.id, 'but the source rate is recorded for the next read')
  // The update row confirmed, the record is still read from it.
  await f.db.accountingSyncLog.updateMany({ where: { referenceId: id, type: 'SALES_INVOICE_UPDATE' }, data: { status: 'SYNCED', externalTransactionId: (await f.db.salesOrder.findUniqueOrThrow({ where: { id }, select: { accountingInvoiceId: true } })).accountingInvoiceId, syncedAt: new Date() } })
  const { readPostedInvoiceTaxCodes } = await import('@/lib/domain/sales/posted-invoice-tax-codes')
  const codes = await readPostedInvoiceTaxCodes(f.db, id, (await f.db.salesOrder.findUniqueOrThrow({ where: { id }, select: { accountingInvoiceId: true } })).accountingInvoiceId)
  assert.equal(codes?.lineCodeByRateId.get(f.rateA.id), 'OUTPUT2')
})

test('an update still in flight: the next edit reads the codes of that pending update (built from the confirmed record behind it) instead of falling back, and writes no warning', SKIP, async (t) => {
  const f = await postedFixture(t)
  const id = await f.make([{ p: 'p1', qty: 1, rate: f.rateA.id }])
  await postInvoice(f.w, id)
  await f.db.taxRate.update({ where: { id: f.rateA.id }, data: { accountingTaxType: `PCA-NEW-${f.w.tag}` } })
  assert.equal((await f.edit(id, [{ p: 'p1', qty: 2, rate: f.rateA.id }])).success, true)
  const r2 = await f.edit(id, [{ p: 'p1', qty: 3, rate: f.rateA.id }])
  assert.equal(r2.success, true, r2.error)
  const rows = await f.db.accountingSyncLog.findMany({ where: { referenceId: id, type: 'SALES_INVOICE_UPDATE', status: 'PENDING' }, orderBy: { createdAt: 'desc' } })
  assert.equal((rows[0]!.payload as { lines: Array<{ taxType: string }> }).lines[0]!.taxType, 'OUTPUT2', 'the second update keeps the posted code too')
  assert.equal(await f.db.activityLog.count({ where: { entityId: id, action: 'sales_invoice_update_used_current_tax_codes' } }), 0)
})

test('the fallback warning: a record that names no line rate warns (and the update still builds); a shadowed update (nothing queued) writes none; an ambiguous record refuses the edit with its own wording', SKIP, async (t) => {
  const f = await postedFixture(t)
  // A record whose lines carry no rate binding (an older WooCommerce invoice).
  const id = await f.make([{ p: 'p1', qty: 1, rate: f.rateA.id }])
  await postInvoice(f.w, id)
  const row = await f.db.accountingSyncLog.findFirstOrThrow({ where: { referenceId: id, type: 'SALES_INVOICE' } })
  const body = row.payload as { lines: Array<Record<string, unknown>> }
  await f.db.accountingSyncLog.update({ where: { id: row.id }, data: { payload: { ...body, lines: body.lines.map((l) => ({ ...l, taxRateId: undefined, taxRateBasis: undefined })) } } as never })
  assert.equal((await f.edit(id, [{ p: 'p1', qty: 2, rate: f.rateA.id }])).success, true)
  const warn = await f.db.activityLog.findFirst({ where: { entityId: id, action: 'sales_invoice_update_used_current_tax_codes' } })
  assert.equal((warn?.metadata as { reason?: string } | null)?.reason, 'record-names-no-line-rates')

  // Shadowed by the producer-side hold: nothing is queued, so no warning.
  const id2 = await f.make([{ p: 'p1', qty: 1, rate: f.rateA.id }])
  await postInvoice(f.w, id2)
  await f.db.accountingSyncLog.deleteMany({ where: { referenceId: id2 } })
  process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS = 'xero'
  assert.equal((await f.edit(id2, [{ p: 'p1', qty: 2, rate: f.rateA.id }])).success, true)
  delete process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS
  assert.equal(await f.db.activityLog.count({ where: { entityId: id2, action: 'sales_invoice_update_used_current_tax_codes' } }), 0, 'nothing queued: no warning')

  // An ambiguous record (one rate, two codes) refuses the edit with the posted-codes wording.
  const id3 = await f.make([{ p: 'p1', qty: 1, rate: f.rateA.id }])
  await postInvoice(f.w, id3)
  const row3 = await f.db.accountingSyncLog.findFirstOrThrow({ where: { referenceId: id3, type: 'SALES_INVOICE' } })
  const l0 = (row3.payload as { lines: Array<Record<string, unknown>> }).lines[0]!
  await f.db.accountingSyncLog.update({ where: { id: row3.id }, data: { payload: { ...(row3.payload as object), lines: [l0, { ...l0, taxType: 'OTHERCODE' }] } } as never })
  const refused = await f.edit(id3, [{ p: 'p1', qty: 2, rate: f.rateA.id }])
  assert.equal(refused.success, false)
  assert.match(refused.error ?? '', /two different tax codes/)
  assert.doesNotMatch(refused.error ?? '', /out of step/)
})

test('a posted code the tenant has archived: the update falls back to the current code and warns', SKIP, async (t) => {
  const f = await postedFixture(t)
  const org = `TAX9${f.w.tag.slice(0, 3).toUpperCase()}`
  const id = await f.make([{ p: 'p1', qty: 1, rate: f.rateA.id }])
  await postInvoice(f.w, id)
  // The posted record names an organisation-specific code; the active tenant's list now has it ARCHIVED.
  const row = await f.db.accountingSyncLog.findFirstOrThrow({ where: { referenceId: id, type: 'SALES_INVOICE' } })
  const body = row.payload as { lines: Array<Record<string, unknown>> }
  await f.db.accountingSyncLog.update({ where: { id: row.id }, data: { payload: { ...body, lines: body.lines.map((l) => ({ ...l, taxType: org })) } } as never })
  const token = await f.db.accountingToken.create({ data: { connector: 'xero', accessToken: 'x', expiresAt: new Date(Date.now() + 3600_000), tenantId: `T-${f.w.tag}` }, select: { id: true } })
  f.extra.tokens.push(token.id)
  const tax = await f.db.xeroTaxRate.create({ data: { connector: 'xero', tenantId: `T-${f.w.tag}`, taxType: org, name: 'archived', status: 'ARCHIVED', components: [], fetchedAt: new Date() }, select: { id: true } })
  f.extra.taxRows.push(tax.id)
  const r = await f.edit(id, [{ p: 'p1', qty: 2, rate: f.rateA.id }])
  assert.equal(r.success, true, r.error)
  assert.equal((await updatePayloadOf(id)).lines[0]!.taxType, 'OUTPUT2', 'the current code, not the archived posted one')
  const warn = await f.db.activityLog.findFirst({ where: { entityId: id, action: 'sales_invoice_update_used_current_tax_codes' } })
  assert.equal((warn?.metadata as { reason?: string } | null)?.reason, 'archived-code')
})

test('a kept posted code that a tax re-key RETIRED does not block the edit: the update falls back to the current code and warns (retired-code); an already-queued update writes no warning', SKIP, async (t) => {
  const f = await postedFixture(t)
  const posted = `TAX7${f.w.tag.slice(0, 3).toUpperCase()}`
  const current = `TAX8${f.w.tag.slice(0, 3).toUpperCase()}`
  const rate = await f.mkRate('R', '0.2', posted)
  const id = await f.make([{ p: 'p1', qty: 1, rate: rate.id }])
  await postInvoice(f.w, id)
  // The re-key: the rate now carries the new code and the posted one is in the retired list (bound to the rate that replaced it).
  await f.db.taxRate.update({ where: { id: rate.id }, data: { accountingTaxType: current } })
  const retired = JSON.stringify({ [posted]: { rateId: rate.id, newCode: current, at: new Date().toISOString() } })
  await f.db.setting.upsert({ where: { key: 'tax_rekey_retired_codes' }, create: { key: 'tax_rekey_retired_codes', value: retired }, update: { value: retired } })
  f.w.settingKeys.push('tax_rekey_retired_codes')
  const r = await f.edit(id, [{ p: 'p1', qty: 2, rate: rate.id }])
  assert.equal(r.success, true, `the retired posted code is not re-sent, so the guard does not refuse the edit: ${r.error}`)
  assert.equal((await updatePayloadOf(id)).lines[0]!.taxType, current)
  const warn = await f.db.activityLog.findFirst({ where: { entityId: id, action: 'sales_invoice_update_used_current_tax_codes' } })
  assert.equal((warn?.metadata as { reason?: string } | null)?.reason, 'retired-code')
  // The identical edit again: the update is already queued (same idempotency key), so nothing new is queued and no second warning is written.
  const again = await f.edit(id, [{ p: 'p1', qty: 2, rate: rate.id }])
  assert.equal(again.success, true, again.error)
  assert.equal(await f.db.activityLog.count({ where: { entityId: id, action: 'sales_invoice_update_used_current_tax_codes' } }), 1, 'an already-queued update writes no warning')
})
