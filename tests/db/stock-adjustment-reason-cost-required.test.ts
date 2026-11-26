import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'
import type { CsvImportExecutionResult } from '@/lib/csv-import'

/**
 * o3d-0ypv9 — EVERY WRITER OF A STOCK ADJUSTMENT, against a real database, with the switch
 * `stock_adjustment_reason_cost_required` ON and OFF:
 *
 *   single form (adjustStock), bulk (bulkAdjustStock), the adjustments CSV import (importAdjustmentsCsv), a stock count post
 *   (postStockCount) and an in-place edit (updateAdjustmentMovement). The WMS align-down goes through the same
 *   applyStockAdjustment and already requires a reason with an account before it applies.
 *
 * ON: no reason is refused; a valued adjustment whose reason has no account is refused while Xero would post it (nothing is
 * written and nothing goes to the exception inbox); a blank addition is valued at the latest cost layer, never the average; a
 * product with no costed layer needs an entered cost; 0 is booked only when entered; a stock count with no chosen reason posts
 * under "Stock count" or is refused.
 * OFF: the same inputs are accepted exactly as before (a blank addition at the average; an unmapped valued adjustment is owed to
 * the exception inbox).
 * GATED on RUN_DB_RETENTION_TESTS (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/stock-adjustment-reason-cost-required.test.ts would have been skipped')
}

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    requireFreshPermission: async () => ({ user: { id: 'u1' } }),
    freshAuthFailureResult: () => null,
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => undefined, revalidateTag: () => undefined } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => undefined, pushProductMetadata: async () => ({ success: true }) } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined } })
mock.module('@/lib/fulfillment/backorder-allocator', { namedExports: { allocateBackordersForProducts: async () => undefined } })

const SWITCH = 'stock_adjustment_reason_cost_required'
const ACCOUNTING = [['plugin_xero_enabled', 'true'], ['xero_sync_enabled', 'true'], ['xero_inventory_account', '630']] as const

async function setup() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('@/lib/db')
  const stock = await import('@/app/actions/stock')
  const counts = await import('@/app/actions/stock-counts')
  const imports = await import('@/app/actions/import')
  return { db, stock, counts, imports }
}

test('stock adjustments: reason and unit cost required (switch on) and unchanged (switch off), every writer', { skip }, async (t) => {
  const { db, stock, counts, imports } = await setup()
  const RUN = `ARC-${process.pid}-${randomUUID().slice(0, 8)}`
  const warehouseIds: string[] = []
  const productIds: string[] = []
  const reasonIds: string[] = []
  const countIds: string[] = []
  const savedSettings = await db.setting.findMany({ where: { key: { in: [SWITCH, ...ACCOUNTING.map(([k]) => k)] } } })
  const savedActiveReasons = await db.adjustmentReason.findMany({ where: { active: true }, select: { id: true } })
  t.after(async () => {
    const movements = await db.stockMovement.findMany({ where: { productId: { in: productIds } }, select: { id: true } })
    const movementIds = movements.map((m) => m.id)
    await db.accountingSyncLog.deleteMany({ where: { referenceType: 'StockMovement', referenceId: { in: movementIds } } })
    await db.accountingPostingRefusal.deleteMany({ where: { referenceType: 'StockMovement', referenceId: { in: movementIds } } })
    await db.cogsEntry.deleteMany({ where: { movementId: { in: movementIds } } })
    await db.costLayer.deleteMany({ where: { productId: { in: productIds } } })
    await db.stockMovement.deleteMany({ where: { productId: { in: productIds } } })
    await db.stockCountLine.deleteMany({ where: { countId: { in: countIds } } })
    await db.stockCount.deleteMany({ where: { id: { in: countIds } } })
    await db.stockLevel.deleteMany({ where: { warehouseId: { in: warehouseIds } } })
    await db.product.deleteMany({ where: { id: { in: productIds } } })
    await db.warehouse.deleteMany({ where: { id: { in: warehouseIds } } })
    await db.adjustmentReason.deleteMany({ where: { id: { in: reasonIds } } })
    await db.adjustmentReason.updateMany({ where: { id: { in: savedActiveReasons.map((r) => r.id) } }, data: { active: true } })
    await db.setting.deleteMany({ where: { key: { in: [SWITCH, ...ACCOUNTING.map(([k]) => k)] } } })
    for (const s of savedSettings) await db.setting.create({ data: { key: s.key, value: s.value } })
  })

  // Xero posting on, so an unmapped valued adjustment is one the ledger would miss.
  for (const [key, value] of ACCOUNTING) await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  // Only this run's reasons are active, so "Stock count" resolves to the one this test controls.
  await db.adjustmentReason.updateMany({ where: { active: true }, data: { active: false } })
  const setSwitch = async (on: boolean) => {
    if (on) await db.setting.upsert({ where: { key: SWITCH }, create: { key: SWITCH, value: 'true' }, update: { value: 'true' } })
    else await db.setting.deleteMany({ where: { key: SWITCH } })
  }
  const reason = async (name: string, accountCode: string | null) => {
    const r = await db.adjustmentReason.create({ data: { name: `${name}`, accountCode, active: true }, select: { id: true } })
    reasonIds.push(r.id)
    return r.id
  }
  const mapped = await reason(`${RUN} Damaged`, '820')
  const unmapped = await reason(`${RUN} Found`, null)

  const warehouse = async (label: string) => {
    const w = await db.warehouse.create({ data: { code: `${RUN}-${label}`.toUpperCase(), name: `${RUN}-${label}`, type: 'STANDARD' }, select: { id: true, code: true } })
    warehouseIds.push(w.id)
    return w
  }
  const product = async (label: string) => {
    const p = await db.product.create({ data: { sku: `${RUN}-${label}`, name: `${RUN}-${label}`, type: 'SIMPLE', countryOfOrigin: 'CN' }, select: { id: true, sku: true } })
    productIds.push(p.id)
    return p
  }
  /** Two layers: an older dear one and a newer cheap one, so the average (and the warehouse average) differs from the latest. */
  const stockWithLayers = async (productId: string, warehouseId: string) => {
    await db.stockLevel.create({ data: { productId, warehouseId, quantity: 20 } })
    await db.costLayer.create({ data: { productId, warehouseId, receivedQty: 10, remainingQty: 10, unitCostBase: 10, receivedAt: new Date(Date.now() - 120_000) } })
    await db.costLayer.create({ data: { productId, warehouseId, receivedQty: 10, remainingQty: 10, unitCostBase: 2, receivedAt: new Date(Date.now() - 60_000) } })
  }
  const lastMovement = (productId: string) => db.stockMovement.findFirst({ where: { productId, type: 'ADJUSTMENT' }, orderBy: { createdAt: 'desc' } })
  const movementCount = (productId: string) => db.stockMovement.count({ where: { productId } })
  const onHand = async (productId: string, warehouseId: string) => Number((await db.stockLevel.findUniqueOrThrow({ where: { productId_warehouseId: { productId, warehouseId } } })).quantity)
  const owed = (movementId: string) => db.accountingPostingRefusal.count({ where: { referenceType: 'StockMovement', referenceId: movementId } })
  const single = (input: Record<string, string>) => {
    const fd = new FormData()
    for (const [k, v] of Object.entries(input)) fd.set(k, v)
    fd.set('idempotencyToken', randomUUID())
    return stock.adjustStock({}, fd)
  }
  const csv = (body: string) => {
    const fd = new FormData()
    fd.set('file', new File([body], 'adjustments.csv', { type: 'text/csv' }))
    // No `mode` is set, so the import executes and returns the execution result.
    return imports.importAdjustmentsCsv(fd) as Promise<CsvImportExecutionResult>
  }

  await t.test('single (adjustStock): ON refuses no reason and an unmapped valued reason; OFF accepts both as before', async () => {
    const w = await warehouse('single')
    const p = await product('single')
    await stockWithLayers(p.id, w.id)

    await setSwitch(true)
    const noReason = await single({ productId: p.id, warehouseId: w.id, qty: '1', unitCostBase: '3' })
    assert.match(noReason.message ?? '', /Choose an adjustment reason/)
    const unmappedRes = await single({ productId: p.id, warehouseId: w.id, qty: '1', unitCostBase: '3', reasonId: unmapped })
    assert.match(unmappedRes.message ?? '', new RegExp(`Map an account to "${RUN} Found"`))
    const removal = await single({ productId: p.id, warehouseId: w.id, qty: '-1', reasonId: unmapped })
    assert.match(removal.message ?? '', /Map an account to/, 'a valued removal under an unmapped reason is refused too (FIFO value known after consumption, rolled back)')
    assert.equal(await movementCount(p.id), 0, 'nothing was written by any refusal')
    assert.equal(await onHand(p.id, w.id), 20)
    assert.equal(await db.costLayer.count({ where: { productId: p.id } }), 2, 'the FIFO layers the refused removal consumed are restored by the rollback')

    // Blank cost: latest layer (2), not the warehouse average (6) or the historical average.
    const ok = await single({ productId: p.id, warehouseId: w.id, qty: '3', reasonId: mapped })
    assert.equal(ok.success, true, JSON.stringify(ok))
    const mv = await lastMovement(p.id)
    assert.equal(mv!.unitCostBase!.toFixed(6), '2.000000')
    assert.equal(mv!.totalValueBase!.toFixed(6), '6.000000')
    const sync = await db.accountingSyncLog.findFirst({ where: { referenceType: 'StockMovement', referenceId: mv!.id } })
    assert.ok(sync, 'the mapped adjustment queued its journal')
    assert.deepEqual((sync!.payload as { lines: Array<{ debit?: number; credit?: number }> }).lines.map((l) => l.debit ?? l.credit), [6, 6])

    // Entered 0 is booked at 0.
    const free = await single({ productId: p.id, warehouseId: w.id, qty: '2', reasonId: unmapped, unitCostBase: '0' })
    assert.equal(free.success, true, JSON.stringify(free))
    assert.equal((await lastMovement(p.id))!.unitCostBase!.toFixed(6), '0.000000')

    await setSwitch(false)
    const before = await movementCount(p.id)
    const offOk = await single({ productId: p.id, warehouseId: w.id, qty: '1' })
    assert.equal(offOk.success, true, JSON.stringify(offOk))
    const offMv = await lastMovement(p.id)
    assert.equal(await movementCount(p.id), before + 1)
    assert.notEqual(offMv!.unitCostBase!.toFixed(6), '2.000000', 'OFF: a blank addition takes the average, as before')
    assert.equal(await owed(offMv!.id), 1, 'OFF: the unmapped valued adjustment is owed to the exception inbox, as before')
  })

  await t.test('single: ON with no costed layer anywhere needs an entered cost; another warehouse\'s layer is the fallback', async () => {
    const w1 = await warehouse('nolayer1')
    const w2 = await warehouse('nolayer2')
    const p = await product('nolayer')
    await setSwitch(true)
    const refused = await single({ productId: p.id, warehouseId: w1.id, qty: '1', reasonId: mapped })
    assert.match(refused.message ?? '', /Enter a unit cost for this addition/)
    assert.equal(await movementCount(p.id), 0)
    await db.stockLevel.create({ data: { productId: p.id, warehouseId: w2.id, quantity: 5 } })
    await db.costLayer.create({ data: { productId: p.id, warehouseId: w2.id, receivedQty: 5, remainingQty: 0, unitCostBase: '7.123456', receivedAt: new Date(Date.now() - 60_000) } })
    const fallback = await single({ productId: p.id, warehouseId: w1.id, qty: '1', reasonId: mapped })
    assert.equal(fallback.success, true, JSON.stringify(fallback))
    assert.equal((await lastMovement(p.id))!.unitCostBase!.toFixed(6), '7.123456', 'a consumed layer still counts as the latest cost')
    await setSwitch(false)
  })

  await t.test('bulk (bulkAdjustStock): ON refuses a line with no reason and rolls the whole batch back; OFF accepts it', async () => {
    const w = await warehouse('bulk')
    const p1 = await product('bulk1')
    const p2 = await product('bulk2')
    await stockWithLayers(p1.id, w.id)
    await stockWithLayers(p2.id, w.id)
    const lines = [
      { lineId: '1', productId: p1.id, warehouseId: w.id, reasonId: mapped, qty: 2 },
      { lineId: '2', productId: p2.id, warehouseId: w.id, reasonId: '', qty: 2 },
    ]
    await setSwitch(true)
    const refused = await stock.bulkAdjustStock(lines, randomUUID())
    assert.match(refused.message ?? '', new RegExp(`Choose an adjustment reason for ${p2.sku}`))
    assert.equal(await movementCount(p1.id) + await movementCount(p2.id), 0, 'the earlier line was rolled back with the batch')
    const ok = await stock.bulkAdjustStock([lines[0]!, { ...lines[1]!, reasonId: mapped }], randomUUID())
    assert.equal(ok.success, true, JSON.stringify(ok))
    assert.equal((await lastMovement(p2.id))!.unitCostBase!.toFixed(6), '2.000000', 'bulk blank cost = latest layer')

    await setSwitch(false)
    const off = await stock.bulkAdjustStock(lines, randomUUID())
    assert.equal(off.success, true, JSON.stringify(off))
  })

  await t.test('CSV (importAdjustmentsCsv): ON needs a reason column matched by name; OFF ignores it as before', async () => {
    const w = await warehouse('csv')
    const p = await product('csv')
    await stockWithLayers(p.id, w.id)
    await setSwitch(true)
    const res = await csv([
      'sku,warehouseCode,qty,unitCost,note,reason',
      `${p.sku},${w.code},1,,no reason,`,
      `${p.sku},${w.code},1,,unknown,Nope`,
      `${p.sku},${w.code},1,,unmapped,${RUN} found`,
      `${p.sku},${w.code},2,,ok,${RUN} DAMAGED`,
    ].join('\n'))
    assert.equal(res.created, 1, JSON.stringify(res))
    assert.ok(res.errors.some((e) => /Row 2: missing reason/.test(e)), JSON.stringify(res.errors))
    assert.ok(res.errors.some((e) => /Row 3: reason "Nope" is not an active adjustment reason/.test(e)), JSON.stringify(res.errors))
    assert.ok(res.errors.some((e) => /Row 4 .*Map an account to/.test(e)), JSON.stringify(res.errors))
    const mv = await lastMovement(p.id)
    assert.equal(mv!.note, `${RUN} Damaged: ok`, 'the matched reason is recorded on the movement')
    assert.equal(mv!.unitCostBase!.toFixed(6), '2.000000')

    await setSwitch(false)
    const off = await csv(['sku,warehouseCode,qty,unitCost,note', `${p.sku},${w.code},1,,off`].join('\n'))
    assert.equal(off.created, 1, JSON.stringify(off))
    assert.equal((await lastMovement(p.id))!.note, 'off', 'OFF: no reason, as before')
  })

  await t.test('stock count (postStockCount): ON posts under "Stock count" when none is chosen, or refuses; OFF posts without a reason', async () => {
    const run = async (label: string, reasonId?: string) => {
      const w = await warehouse(label)
      const p = await product(label)
      await stockWithLayers(p.id, w.id)
      const created = await counts.createStockCount({ warehouseId: w.id })
      assert.ok(created.success && created.count, JSON.stringify(created))
      countIds.push(created.count!.id)
      const lineId = created.count!.lines[0]!.id
      await counts.saveStockCountCounts({ countId: created.count!.id, counts: [{ lineId, countedQty: 22 }] })
      await counts.reconcileStockCount({ countId: created.count!.id, counts: [{ lineId, countedQty: 22 }] })
      const posted = await counts.postStockCount({ countId: created.count!.id, ...(reasonId ? { reasonId } : {}) })
      return { posted, p, countId: created.count!.id }
    }
    await setSwitch(true)
    const refused = await run('cnt-none')
    assert.match(refused.posted.message ?? '', /add an active adjustment reason called "Stock count"/)
    assert.equal(await movementCount(refused.p.id), 0)
    assert.equal((await db.stockCount.findUniqueOrThrow({ where: { id: refused.countId } })).status === 'COMPLETED', false)

    const stockCountReason = await reason('Stock count', '821')
    const ok = await run('cnt-default')
    assert.equal(ok.posted.success, true, JSON.stringify(ok.posted))
    const mv = await lastMovement(ok.p.id)
    assert.match(mv!.note ?? '', /^Stock count: Stock count /, 'posted under the "Stock count" reason')
    assert.equal(mv!.unitCostBase!.toFixed(6), '2.000000', 'a surplus is valued at the latest layer cost')
    await db.adjustmentReason.update({ where: { id: stockCountReason }, data: { active: false } })

    await setSwitch(false)
    const off = await run('cnt-off')
    assert.equal(off.posted.success, true, JSON.stringify(off.posted))
    assert.equal((await lastMovement(off.p.id))!.note, `Stock count ${off.countId}`, 'OFF: no reason, as before')
  })

  await t.test('edit (updateAdjustmentMovement): ON values a removal edited into an addition at the latest layer; OFF at the average', async () => {
    for (const on of [true, false]) {
      const w = await warehouse(`edit-${on}`)
      const p = await product(`edit-${on}`)
      await stockWithLayers(p.id, w.id)
      await setSwitch(on)
      const removed = await single({ productId: p.id, warehouseId: w.id, qty: '-1', reasonId: mapped })
      assert.equal(removed.success, true, JSON.stringify(removed))
      const mv = await lastMovement(p.id)
      // The journal it queued would block the edit; this test is about valuation, so release it.
      await db.accountingSyncLog.deleteMany({ where: { referenceType: 'StockMovement', referenceId: mv!.id } })
      const edited = await stock.updateAdjustmentMovement(mv!.id, 2, null)
      assert.equal(edited.success, true, JSON.stringify(edited))
      const after = await db.stockMovement.findUniqueOrThrow({ where: { id: mv!.id } })
      if (on) assert.equal(after.unitCostBase!.toFixed(6), '2.000000', 'ON: latest layer')
      else assert.notEqual(after.unitCostBase!.toFixed(6), '2.000000', 'OFF: the average, as before')
    }
    await setSwitch(false)
  })
})
