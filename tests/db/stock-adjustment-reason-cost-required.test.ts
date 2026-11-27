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
  const poIds: string[] = []
  const supplierIds: string[] = []
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
    await db.purchaseOrderLine.deleteMany({ where: { poId: { in: poIds } } })
    await db.purchaseOrder.deleteMany({ where: { id: { in: poIds } } })
    await db.supplier.deleteMany({ where: { id: { in: supplierIds } } })
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
  /** A purchase-order line for the product: the default addition cost reads receipt layers only (o3d-jwa8m), so the test layers are receipt layers. */
  const poLineFor = async (productId: string) => {
    const supplier = await db.supplier.create({ data: { name: `${RUN}-sup-${supplierIds.length}` }, select: { id: true } })
    supplierIds.push(supplier.id)
    const po = await db.purchaseOrder.create({
      data: {
        reference: `${RUN}-PO-${poIds.length}`, supplierId: supplier.id, status: 'RECEIVED', currency: 'GBP', fxRateToBase: 1,
        subtotalForeign: 1, subtotalBase: 1, totalForeign: 1, totalBase: 1,
        lines: { create: [{ productId, qty: 1, unitCostForeign: 1, unitCostBase: 1, totalForeign: 1, totalBase: 1 }] },
      },
      select: { id: true, lines: { select: { id: true } } },
    })
    poIds.push(po.id)
    return po.lines[0]!.id
  }
  /** Two receipt layers: an older dear one and a newer cheap one, so the average (and the warehouse average) differs from the latest. */
  const stockWithLayers = async (productId: string, warehouseId: string) => {
    const poLineId = await poLineFor(productId)
    await db.stockLevel.create({ data: { productId, warehouseId, quantity: 20 } })
    await db.costLayer.create({ data: { productId, warehouseId, receivedQty: 10, remainingQty: 10, unitCostBase: 10, receivedAt: new Date(Date.now() - 120_000), poLineId } })
    await db.costLayer.create({ data: { productId, warehouseId, receivedQty: 10, remainingQty: 10, unitCostBase: 2, receivedAt: new Date(Date.now() - 60_000), poLineId } })
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
    await db.costLayer.create({ data: { productId: p.id, warehouseId: w2.id, receivedQty: 5, remainingQty: 0, unitCostBase: '7.123456', receivedAt: new Date(Date.now() - 60_000), poLineId: await poLineFor(p.id) } })
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
    assert.match(refused.posted.message ?? '', /create, activate and map an adjustment reason called "Stock count"/)
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
      // ON: with accounting posting off the edit owes no journal, so the valuation rule is what is under test (the posting-on refusal is the next test).
      if (on) await db.setting.deleteMany({ where: { key: { in: ACCOUNTING.map(([k]) => k) } } })
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
      for (const [key, value] of ACCOUNTING) await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
    }
    await setSwitch(false)
  })

  await t.test('MED-3: ON and posting applies, +5 at 0 edited to -5 is refused (no silent valued removal); same-value edits still work', async () => {
    const w = await warehouse('med3')
    const p = await product('med3')
    await stockWithLayers(p.id, w.id)
    await setSwitch(true)
    // +5 at an entered 0 under an UNMAPPED reason: value 0, so it owes no journal and is accepted.
    const free = await single({ productId: p.id, warehouseId: w.id, qty: '5', reasonId: unmapped, unitCostBase: '0' })
    assert.equal(free.success, true, JSON.stringify(free))
    const mv = await lastMovement(p.id)
    assert.equal(mv!.totalValueBase!.toFixed(6), '0.000000')
    const before = await onHand(p.id, w.id)
    const layersBefore = await db.costLayer.count({ where: { productId: p.id } })

    const flipped = await stock.updateAdjustmentMovement(mv!.id, -5, null)
    assert.match(flipped.message ?? '', /would change the value of the adjustment/)
    assert.match(flipped.message ?? '', /Reverse this adjustment/)
    assert.equal(await onHand(p.id, w.id), before, 'nothing was re-booked')
    assert.equal(await db.costLayer.count({ where: { productId: p.id } }), layersBefore)
    const unchanged = await db.stockMovement.findUniqueOrThrow({ where: { id: mv!.id } })
    assert.equal(unchanged.toWarehouseId, mv!.toWarehouseId)
    assert.equal(unchanged.qty.toFixed(6), '5.000000')
    assert.equal(await owed(mv!.id), 0)

    // A zero-value edit that stays zero is not a value change: +5 at 0 -> +7 at 0.
    const grown = await stock.updateAdjustmentMovement(mv!.id, 7, 'recount')
    assert.equal(grown.success, true, JSON.stringify(grown))

    // ON but accounting posting off: no journal is owed, so the value-changing flip is accepted as before.
    await db.setting.deleteMany({ where: { key: { in: ACCOUNTING.map(([k]) => k) } } })
    const flippedNoPosting = await stock.updateAdjustmentMovement(mv!.id, -5, null)
    assert.equal(flippedNoPosting.success, true, JSON.stringify(flippedNoPosting))
    for (const [key, value] of ACCOUNTING) await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })

    // OFF: the flip is accepted exactly as before.
    await setSwitch(false)
    const w2 = await warehouse('med3-off')
    const p2 = await product('med3-off')
    await stockWithLayers(p2.id, w2.id)
    const free2 = await single({ productId: p2.id, warehouseId: w2.id, qty: '5', reasonId: unmapped, unitCostBase: '0' })
    assert.equal(free2.success, true, JSON.stringify(free2))
    const mv2 = await lastMovement(p2.id)
    await db.accountingPostingRefusal.deleteMany({ where: { referenceType: 'StockMovement', referenceId: mv2!.id } })
    const flipped2 = await stock.updateAdjustmentMovement(mv2!.id, -5, null)
    assert.equal(flipped2.success, true, JSON.stringify(flipped2))
  })

  await t.test('MED-3: ON refuses to edit a supplier return, a stock-count variance and a Mintsoft align-down; OFF does not refuse them for that reason', async () => {
    const w = await warehouse('nonplain')
    for (const [label, referenceType] of [['ret', 'PurchaseReturn'], ['cnt', 'StockCount'], ['wms', 'WmsSyncJob']] as const) {
      const p = await product(`nonplain-${label}`)
      await stockWithLayers(p.id, w.id)
      // The DB requires inbound movements to carry their cost-layer evidence at commit, so the layer is written in the same transaction.
      const movement = await db.$transaction(async (tx) => {
        const m = await tx.stockMovement.create({
          data: { type: 'ADJUSTMENT', productId: p.id, toWarehouseId: w.id, qty: 1, unitCostBase: 3, totalValueBase: 3, referenceType, referenceId: `${RUN}-${label}` },
          select: { id: true },
        })
        await tx.costLayer.create({ data: { productId: p.id, warehouseId: w.id, receivedQty: 1, remainingQty: 1, unitCostBase: 3, adjustmentMovementId: m.id } })
        return m
      })
      await setSwitch(true)
      const refused = await stock.updateAdjustmentMovement(movement.id, 2, null)
      assert.match(refused.message ?? '', /not a plain stock adjustment/, referenceType)
      const noteOnly = await stock.updateAdjustmentMovement(movement.id, 1, 'x')
      assert.match(noteOnly.message ?? '', /not a plain stock adjustment/, `${referenceType}: a note-only edit too`)
      await setSwitch(false)
      const off = await stock.updateAdjustmentMovement(movement.id, 2, null)
      assert.doesNotMatch(off.message ?? '', /not a plain stock adjustment/, `${referenceType}: OFF is not judged by the new rule`)
    }
    await setSwitch(false)
  })

  await t.test('MED-4: the default addition cost reads receipt/production layers only, and breaks a receivedAt tie by creation order', async () => {
    const w = await warehouse('med4')
    const p = await product('med4')
    const poLineId = await poLineFor(p.id)
    const base = Date.now() - 600_000
    await db.stockLevel.create({ data: { productId: p.id, warehouseId: w.id, quantity: 10 } })
    // The receipt layer (4) is OLDER than a transfer-recreated one (9, no po line), a refund restock-style one and an opening layer.
    await db.costLayer.create({ data: { productId: p.id, warehouseId: w.id, receivedQty: 5, remainingQty: 5, unitCostBase: 4, receivedAt: new Date(base), poLineId } })
    await db.costLayer.create({ data: { productId: p.id, warehouseId: w.id, receivedQty: 1, remainingQty: 1, unitCostBase: 9, receivedAt: new Date(base + 60_000) } })
    await db.costLayer.create({ data: { productId: p.id, warehouseId: w.id, receivedQty: 1, remainingQty: 1, unitCostBase: 8, receivedAt: new Date(base + 90_000), isOpeningStock: true } })
    await setSwitch(true)
    const defaulted = await single({ productId: p.id, warehouseId: w.id, qty: '2', reasonId: mapped })
    assert.equal(defaulted.success, true, JSON.stringify(defaulted))
    const mv = await lastMovement(p.id)
    assert.equal(mv!.unitCostBase!.toFixed(6), '4.000000', 'the transfer and opening layers are not the default; the adjustment layer just written is not either')
    // The adjustment layer it just wrote (4) does not perpetuate: a further default still reads the receipt layer, not the adjustment layer.
    await db.costLayer.updateMany({ where: { productId: p.id, poLineId }, data: { unitCostBase: 5 } })
    const again = await single({ productId: p.id, warehouseId: w.id, qty: '1', reasonId: mapped })
    assert.equal(again.success, true, JSON.stringify(again))
    assert.equal((await lastMovement(p.id))!.unitCostBase!.toFixed(6), '5.000000')

    // Two receipt layers at the same receivedAt: the one created second wins, whatever the cuids sort to.
    const p2 = await product('med4-tie')
    const poLine2 = await poLineFor(p2.id)
    await db.stockLevel.create({ data: { productId: p2.id, warehouseId: w.id, quantity: 10 } })
    const at = new Date(base)
    await db.costLayer.create({ data: { id: 'zzzz-tie-first', productId: p2.id, warehouseId: w.id, receivedQty: 1, remainingQty: 1, unitCostBase: 3, receivedAt: at, poLineId: poLine2 } })
    await db.costLayer.create({ data: { id: 'aaaa-tie-second', productId: p2.id, warehouseId: w.id, receivedQty: 1, remainingQty: 1, unitCostBase: 6, receivedAt: at, poLineId: poLine2 } })
    const tie = await single({ productId: p2.id, warehouseId: w.id, qty: '1', reasonId: mapped })
    assert.equal(tie.success, true, JSON.stringify(tie))
    assert.equal((await lastMovement(p2.id))!.unitCostBase!.toFixed(6), '6.000000', 'creation sequence, not cuid order')
    await setSwitch(false)
  })

  /** A stock movement and the layer it created, written in one transaction (the DB requires inbound movements to carry their cost-layer evidence at commit). */
  const movementWithLayer = (productId: string, warehouseId: string, movementType: 'ADJUSTMENT' | 'OPENING_STOCK' | 'RETURN_INBOUND', unitCostBase: number, layer: { poLineId?: string; opening?: boolean; viaReturn?: boolean; receivedAt: Date }) =>
    db.$transaction(async (tx) => {
      const m = await tx.stockMovement.create({
        data: { type: movementType, productId, toWarehouseId: warehouseId, qty: 4, unitCostBase, totalValueBase: unitCostBase * 4 },
        select: { id: true },
      })
      await tx.costLayer.create({
        data: {
          productId, warehouseId, receivedQty: 4, remainingQty: 4, unitCostBase, receivedAt: layer.receivedAt,
          ...(layer.poLineId ? { poLineId: layer.poLineId } : {}),
          ...(layer.opening ? { isOpeningStock: true } : {}),
          ...(layer.viaReturn ? { returnMovementId: m.id } : { adjustmentMovementId: m.id }),
        },
      })
      await tx.stockLevel.upsert({ where: { productId_warehouseId: { productId, warehouseId } }, create: { productId, warehouseId, quantity: 4 }, update: { quantity: { increment: 4 } } })
      return m
    })

  await t.test('F1: a Mintsoft align-up layer (PO line AND adjustment movement) is the default; a plain adjustment layer and a refund restock are not', async () => {
    const w = await warehouse('f1')
    const p = await product('f1')
    const poLineId = await poLineFor(p.id)
    const base = Date.now() - 600_000
    await movementWithLayer(p.id, w.id, 'ADJUSTMENT', 6, { poLineId, receivedAt: new Date(base) }) // the alignment layer
    await movementWithLayer(p.id, w.id, 'ADJUSTMENT', 9, { receivedAt: new Date(base + 60_000) }) // a plain adjustment layer, newer
    await movementWithLayer(p.id, w.id, 'RETURN_INBOUND', 8, { poLineId, viaReturn: true, receivedAt: new Date(base + 120_000) }) // a refund restock, newer still
    await setSwitch(true)
    const res = await single({ productId: p.id, warehouseId: w.id, qty: '2', reasonId: mapped })
    assert.equal(res.success, true, JSON.stringify(res))
    assert.equal((await lastMovement(p.id))!.unitCostBase!.toFixed(6), '6.000000', 'the alignment layer, not the newer adjustment or refund-restock layers')
    await setSwitch(false)
  })

  await t.test('F2: an opening-stock-only product takes the latest opening batch cost for a blank addition and a stock-count surplus; zero-cost opening is skipped; OFF unchanged', async () => {
    const wOlder = await warehouse('f2-older')
    const wNewer = await warehouse('f2-newer')
    const wZero = await warehouse('f2-zero')
    const wNone = await warehouse('f2-none')
    const p = await product('f2')
    const base = Date.now() - 600_000
    // One opening layer per product and warehouse (a DB constraint), so the "batches" sit in different warehouses.
    await movementWithLayer(p.id, wOlder.id, 'OPENING_STOCK', 3, { opening: true, receivedAt: new Date(base) })
    await movementWithLayer(p.id, wNewer.id, 'OPENING_STOCK', 5.5, { opening: true, receivedAt: new Date(base + 60_000) })
    await movementWithLayer(p.id, wZero.id, 'OPENING_STOCK', 0, { opening: true, receivedAt: new Date(base + 120_000) })
    await setSwitch(true)
    const blank = await single({ productId: p.id, warehouseId: wNone.id, qty: '2', reasonId: mapped })
    assert.equal(blank.success, true, JSON.stringify(blank))
    assert.equal((await lastMovement(p.id))!.unitCostBase!.toFixed(6), '5.500000', 'the latest NON-ZERO opening batch anywhere, never the average (2.8333...)')
    const here = await single({ productId: p.id, warehouseId: wOlder.id, qty: '1', reasonId: mapped })
    assert.equal(here.success, true, JSON.stringify(here))
    assert.equal((await lastMovement(p.id))!.unitCostBase!.toFixed(6), '3.000000', 'this warehouse\'s opening batch first')

    // Stock count surplus on the same opening-only product posts under "Stock count" at the opening cost.
    const stockCountReason = await reason('Stock count', '821')
    const wCount = await warehouse('f2-count')
    const p2 = await product('f2-count')
    await movementWithLayer(p2.id, wCount.id, 'OPENING_STOCK', 4.25, { opening: true, receivedAt: new Date(base) })
    const created = await counts.createStockCount({ warehouseId: wCount.id })
    assert.ok(created.success && created.count, JSON.stringify(created))
    countIds.push(created.count!.id)
    const line = created.count!.lines.find((l) => l.productId === p2.id)
    assert.ok(line, 'the opening-only product is on the count')
    await counts.saveStockCountCounts({ countId: created.count!.id, counts: [{ lineId: line!.id, countedQty: 7 }] })
    await counts.reconcileStockCount({ countId: created.count!.id, counts: [{ lineId: line!.id, countedQty: 7 }] })
    const posted = await counts.postStockCount({ countId: created.count!.id })
    assert.equal(posted.success, true, JSON.stringify(posted))
    const surplus = await lastMovement(p2.id)
    assert.equal(surplus!.qty.toFixed(6), '3.000000')
    assert.equal(surplus!.unitCostBase!.toFixed(6), '4.250000', 'the surplus is valued at the opening batch cost')
    await db.adjustmentReason.update({ where: { id: stockCountReason }, data: { active: false } })

    // Opening layers that are all zero still refuse a blank addition (zero is only ever booked when entered).
    const p3 = await product('f2-zero')
    await movementWithLayer(p3.id, wZero.id, 'OPENING_STOCK', 0, { opening: true, receivedAt: new Date(base) })
    const refused = await single({ productId: p3.id, warehouseId: wNone.id, qty: '1', reasonId: mapped })
    assert.match(refused.message ?? '', /Enter a unit cost for this addition/)

    // OFF: unchanged (a blank addition takes the average).
    await setSwitch(false)
    const off = await single({ productId: p.id, warehouseId: wNone.id, qty: '1' })
    assert.equal(off.success, true, JSON.stringify(off))
    // The switch-off path is the average path, untouched: here this warehouse's own layer (the 5.5 booked above) is its average.
    assert.equal((await lastMovement(p.id))!.unitCostBase!.toFixed(6), '5.500000')
  })

  await t.test('LOW-7: ON builds the journal from the 6dp movement total (no one-penny mismatch)', async () => {
    const w = await warehouse('low7')
    const p = await product('low7')
    await stockWithLayers(p.id, w.id)
    await setSwitch(true)
    // 0.5 x 0.009999 = 0.0049995 exactly: the movement stores 0.005000 (6dp), which is a penny; rounding the exact product to 2dp would be 0.00.
    const res = await single({ productId: p.id, warehouseId: w.id, qty: '0.5', reasonId: mapped, unitCostBase: '0.009999' })
    assert.equal(res.success, true, JSON.stringify(res))
    const mv = await lastMovement(p.id)
    assert.equal(mv!.totalValueBase!.toFixed(6), '0.005000')
    const sync = await db.accountingSyncLog.findFirst({ where: { referenceType: 'StockMovement', referenceId: mv!.id } })
    assert.ok(sync, 'the journal is built from the stored 6dp total')
    assert.deepEqual((sync!.payload as { lines: Array<{ debit?: number; credit?: number }> }).lines.map((l) => l.debit ?? l.credit), [0.01, 0.01])
    await setSwitch(false)
  })
})
