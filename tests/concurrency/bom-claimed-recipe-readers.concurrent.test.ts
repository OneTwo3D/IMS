import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * PLANNING AND HISTORY READERS OF THE BOM, AGAINST A REAL DATABASE.
 *
 * Two defects, one cause: readers resolved "the recipe" through whatever Bom rows happened to be
 * reachable, instead of through the two records that are authoritative.
 *
 *   HISTORY  -- a completed order's variance was planned from the LIVE Bom items, so re-importing a
 *               recipe (which deletes and recreates those items) rewrote the history of every order
 *               already run. It now reads the componentSnapshot frozen when the order started.
 *   PLANNING -- replenishment summed EVERY active BomItem for a BOM product, and createReorderMOs
 *               chose between Boms by updatedAt, so a second active Bom listing the same parent
 *               doubled component demand and could win the Bom choice. Both now use the CLAIMED
 *               recipe (boms.productId = the product).
 *
 * The no-snapshot rule for variance (see manufacturing-analytics.ts): an IN_PROGRESS / COMPLETED
 * order with no readable frozen recipe is EXCLUDED and named in a notice; it is never planned from the
 * live recipe.
 *
 * Needs a real PostgreSQL (the unique index on boms.productId, the advisory lock, the stock-evidence
 * trigger). Gated behind RUN_DB_CONCURRENCY_TESTS=1 like its siblings.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', {
  namedExports: {
    enqueueStockSync: async () => {},
    pushProductMetadata: async () => ({ success: true }),
  },
})

config({ path: '.env.local', quiet: true })
config({ quiet: true })

async function loadDeps() {
  const [dbMod, importMod, mfgMod, fcMod, analyticsMod, replMod] = await Promise.all([
    import('../../lib/db/index'),
    import('../../app/actions/import'),
    import('../../app/actions/manufacturing'),
    import('../../app/actions/forecasting'),
    import('../../lib/domain/manufacturing/manufacturing-analytics'),
    import('../../lib/domain/inventory/replenishment-reports'),
  ])
  return {
    db: dbMod.db,
    importProductsCsv: importMod.importProductsCsv,
    importOpeningStockCsv: importMod.importOpeningStockCsv,
    createManufacturingOrder: mfgMod.createManufacturingOrder,
    updateManufacturingOrderStatus: mfgMod.updateManufacturingOrderStatus,
    createReorderMOs: fcMod.createReorderMOs,
    getProductionVarianceReport: analyticsMod.getProductionVarianceReport,
    getReorderReport: replMod.getReorderReport,
    getComponentShortageReport: replMod.getComponentShortageReport,
  }
}
type Deps = Awaited<ReturnType<typeof loadDeps>>

function csv(rows: string[]): FormData {
  const data = new FormData()
  data.set('file', new File([rows.join('\n')], 'products.csv', { type: 'text/csv' }))
  data.set('mode', 'execute')
  return data
}

const TAG = `CR${Date.now().toString(36).toUpperCase()}`
const sku = (ns: string, name: string) => `${TAG}${ns}-${name}`

async function ownWarehouse(deps: Deps, ns: string): Promise<{ id: string; code: string }> {
  return await deps.db.warehouse.create({
    data: { code: sku(ns, 'WH').slice(0, 20), name: `${TAG}${ns} probe warehouse` },
    select: { id: true, code: true },
  })
}

/** TABLE (BOM) = LEG x4 + RAW x2, imported through the sanctioned path so both recipe copies exist and the Bom is claimed. */
async function seedCatalogue(deps: Deps, ns: string): Promise<{ tableId: string; legId: string; rawId: string; claimedBomId: string }> {
  const loaded = await deps.importProductsCsv(csv([
    'sku,name,type,components,stockUnit',
    `${sku(ns, 'RAW')},Oak board,SIMPLE,,each`,
    `${sku(ns, 'LEG')},Table leg,SIMPLE,,each`,
    `${sku(ns, 'TABLE')},Oak table,BOM,${sku(ns, 'LEG')}:4;${sku(ns, 'RAW')}:2,each`,
  ]))
  assert.deepEqual(loaded.errors ?? [], [], 'the catalogue must import cleanly')
  const table = await deps.db.product.findUniqueOrThrow({ where: { sku: sku(ns, 'TABLE') }, select: { id: true } })
  const leg = await deps.db.product.findUniqueOrThrow({ where: { sku: sku(ns, 'LEG') }, select: { id: true } })
  const raw = await deps.db.product.findUniqueOrThrow({ where: { sku: sku(ns, 'RAW') }, select: { id: true } })
  const bom = await deps.db.bom.findUniqueOrThrow({ where: { productId: table.id }, select: { id: true } })
  return { tableId: table.id, legId: leg.id, rawId: raw.id, claimedBomId: bom.id }
}

async function stockUp(deps: Deps, ns: string, warehouseCode: string, rawQty: number, legQty = rawQty): Promise<void> {
  const stock = await deps.importOpeningStockCsv(csv([
    'sku,warehouseCode,qty,unitCostBase',
    `${sku(ns, 'RAW')},${warehouseCode},${rawQty},1`,
    `${sku(ns, 'LEG')},${warehouseCode},${legQty},2`,
  ]))
  assert.deepEqual(stock.errors ?? [], [], 'opening stock must load')
}

async function reimportRecipe(deps: Deps, ns: string, legQty: number, rawQty: number): Promise<void> {
  const result = await deps.importProductsCsv(csv([
    'sku,name,type,components,stockUnit',
    `${sku(ns, 'TABLE')},Oak table,BOM,${sku(ns, 'LEG')}:${legQty};${sku(ns, 'RAW')}:${rawQty},each`,
  ]))
  assert.deepEqual(result.errors ?? [], [], 'the recipe re-import must succeed')
}

/** A second ACTIVE Bom listing `parentId`, claimed by nobody -- the legacy / hand-written duplicate. */
async function strayDuplicateBom(deps: Deps, ns: string, parentId: string, componentId: string, qty: number): Promise<string> {
  const stray = await deps.db.bom.create({
    data: {
      name: `${TAG}${ns} stray duplicate`,
      active: true,
      productId: null,
      items: { create: [{ parentProductId: parentId, componentProductId: componentId, qty, sortOrder: 0 }] },
    },
    select: { id: true },
  })
  return stray.id
}

const varianceOf = async (deps: Deps, orderId: string) => {
  const report = await deps.getProductionVarianceReport({}, { paginate: false })
  return {
    notices: report.notices,
    rows: report.rows
      .filter((row) => row.productionOrderId === orderId)
      .map((row) => [row.componentSku, row.plannedQty, row.actualQty, row.varianceQty, row.outcome])
      .sort(),
  }
}

test(
  'variance of a COMPLETED order is unchanged by a later recipe re-import (read from the frozen snapshot)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    const deps = await loadDeps()
    const NS = 'V'
    const { tableId, legId, rawId } = await seedCatalogue(deps, NS)
    const warehouse = await ownWarehouse(deps, NS)
    await stockUp(deps, NS, warehouse.code, 500)
    const created = await deps.createManufacturingOrder({
      productId: tableId, warehouseId: warehouse.id, orderType: 'ASSEMBLY', qtyPlanned: 2,
    })
    assert.ok(created.success && created.id, `order create failed: ${JSON.stringify(created)}`)
    assert.ok((await deps.updateManufacturingOrderStatus(created.id, 'IN_PROGRESS')).success)
    assert.ok((await deps.updateManufacturingOrderStatus(created.id, 'COMPLETED')).success)

    const before = await varianceOf(deps, created.id)
    assert.deepEqual(before.rows, [
      [sku(NS, 'LEG'), '8', '8', '0', 'on_plan'],
      [sku(NS, 'RAW'), '4', '4', '0', 'on_plan'],
    ], 'planned = snapshot qty x planned output (LEG 4 x 2, RAW 2 x 2), actual = what completion consumed')

    // THE RE-IMPORT: deletes and recreates the live Bom items with different quantities.
    await reimportRecipe(deps, NS, 1, 1)
    const live = await deps.db.bom.findUniqueOrThrow({
      where: { productId: tableId }, select: { items: { select: { componentProductId: true, qty: true } } },
    })
    assert.deepEqual(
      live.items.map((item) => [item.componentProductId, Number(item.qty)]).sort(),
      [[legId, 1], [rawId, 1]].sort(),
      'PRECONDITION: the live recipe really did change, so an unchanged report cannot be a vacuous pass',
    )

    const after = await varianceOf(deps, created.id)
    assert.deepEqual(after.rows, before.rows, 'a completed order\'s variance must not move when its recipe is re-imported')
  },
)

test(
  'variance excludes an order with no frozen recipe and says so; it is never planned from the live Bom',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    const deps = await loadDeps()
    const NS = 'N'
    const { tableId } = await seedCatalogue(deps, NS)
    const warehouse = await ownWarehouse(deps, NS)
    await stockUp(deps, NS, warehouse.code, 500)
    const created = await deps.createManufacturingOrder({
      productId: tableId, warehouseId: warehouse.id, orderType: 'ASSEMBLY', qtyPlanned: 1,
    })
    assert.ok(created.success && created.id)
    assert.ok((await deps.updateManufacturingOrderStatus(created.id, 'IN_PROGRESS')).success)
    assert.ok((await deps.updateManufacturingOrderStatus(created.id, 'COMPLETED')).success)
    const order = await deps.db.productionOrder.findUniqueOrThrow({ where: { id: created.id }, select: { reference: true, componentSnapshot: true } })
    assert.ok(Array.isArray(order.componentSnapshot) && order.componentSnapshot.length === 2, 'PRECONDITION: starting froze the recipe')

    // A legacy row: completed before snapshots existed.
    await deps.db.$executeRaw`UPDATE production_orders SET "componentSnapshot" = NULL WHERE id = ${created.id}`
    const report = await varianceOf(deps, created.id)
    assert.deepEqual(report.rows, [], 'no rows may be fabricated from the live recipe')
    const notice = report.notices.find((n) => /no frozen recipe/.test(n))
    assert.ok(notice?.includes(order.reference), `the exclusion must name the order: ${notice}`)
  },
)

test(
  'replenishment counts only the CLAIMED recipe when a second active Bom lists the same parent',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    const deps = await loadDeps()
    const NS = 'R'
    const { tableId, legId, rawId } = await seedCatalogue(deps, NS)
    await deps.db.product.update({ where: { id: tableId }, data: { reorderPoint: 5, reorderQty: 8 } })

    const reorderQtys = async () => {
      const report = await deps.getReorderReport({}, { paginate: false })
      return {
        table: report.rows.find((row) => row.sku === sku(NS, 'TABLE'))?.suggestedReorderQty,
        raw: report.rows.find((row) => row.sku === sku(NS, 'RAW'))?.suggestedReorderQty,
        leg: report.rows.find((row) => row.sku === sku(NS, 'LEG'))?.suggestedReorderQty,
      }
    }
    const baseline = await reorderQtys()
    assert.ok(baseline.table && Number(baseline.table) > 0, 'PRECONDITION: the BOM product needs reordering')
    assert.equal(baseline.raw, String(Number(baseline.table) * 2), 'baseline: RAW demand = TABLE qty x claimed qty 2')
    assert.equal(baseline.leg, String(Number(baseline.table) * 4))

    const strayId = await strayDuplicateBom(deps, NS, tableId, rawId, 50)
    // A second kind of stray: an active Bom CLAIMED FOR A DIFFERENT PRODUCT that nevertheless lists TABLE as a parent.
    await deps.db.bom.create({
      data: {
        name: `${TAG}${NS} claimed elsewhere`,
        active: true,
        productId: legId,
        items: { create: [{ parentProductId: tableId, componentProductId: rawId, qty: 7, sortOrder: 0 }] },
      },
    })
    // PRECONDITION, using the reader's own predicate: three ACTIVE Boms really do list this parent.
    const active = await deps.db.bomItem.count({ where: { parentProductId: tableId, bom: { active: true } } })
    assert.equal(active, 4, 'two claimed-recipe items plus both strays\' items are all visible to an unscoped read')
    assert.equal((await deps.db.bom.findUniqueOrThrow({ where: { id: strayId }, select: { productId: true } })).productId, null)

    assert.deepEqual(await reorderQtys(), baseline, 'neither stray may add 50 or 7 x TABLE qty of RAW demand')
  },
)

test(
  'createReorderMOs picks the claimed Bom regardless of updatedAt, and reports a product with no claimed Bom',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    const deps = await loadDeps()
    const NS = 'M'
    const { tableId, rawId, claimedBomId } = await seedCatalogue(deps, NS)
    await ownWarehouse(deps, NS)
    await deps.db.product.update({ where: { id: tableId }, data: { reorderPoint: 5, reorderQty: 8 } })
    const strayId = await strayDuplicateBom(deps, NS, tableId, rawId, 50)
    // The stray is NEWER than the claimed recipe: the old "most recently updated active Bom" pick would take it.
    await deps.db.$executeRaw`UPDATE boms SET "updatedAt" = now() - interval '2 days' WHERE id = ${claimedBomId}`
    await deps.db.$executeRaw`UPDATE boms SET "updatedAt" = now() + interval '1 hour' WHERE id = ${strayId}`
    const ordered = await deps.db.bom.findMany({ where: { id: { in: [claimedBomId, strayId] } }, orderBy: { updatedAt: 'desc' }, select: { id: true } })
    assert.equal(ordered[0]?.id, strayId, 'PRECONDITION: the unclaimed duplicate is the most recently updated')

    const result = await deps.createReorderMOs([tableId])
    assert.equal(result.success, true, JSON.stringify(result))
    assert.equal(result.moCount, 1, JSON.stringify(result))
    const orders = await deps.db.productionOrder.findMany({ where: { outputProductId: tableId }, select: { bomId: true } })
    assert.deepEqual(orders.map((o) => o.bomId), [claimedBomId], 'the draft MO must be raised against the CLAIMED Bom')

    // A BOM product whose only Bom is unclaimed has no recipe to build from: skipped with a reason, never guessed.
    const NS2 = 'M2'
    const other = await seedCatalogue(deps, NS2)
    await deps.db.product.update({ where: { id: other.tableId }, data: { reorderPoint: 5, reorderQty: 8 } })
    await deps.db.$executeRaw`UPDATE boms SET "productId" = NULL WHERE id = ${other.claimedBomId}`
    const skipped = await deps.createReorderMOs([other.tableId])
    assert.equal(skipped.success, true, JSON.stringify(skipped))
    assert.equal(skipped.moCount, 0)
    assert.deepEqual(skipped.skipped?.map((s) => s.reason), ['no_active_bom'])
    assert.equal(await deps.db.productionOrder.count({ where: { outputProductId: other.tableId } }), 0)

    // And the replenishment report says so instead of silently dropping that product's component demand.
    const report = await deps.getReorderReport({}, { paginate: false })
    const notice = report.notices.find((n) => /No claimed recipe/.test(n))
    assert.ok(notice?.includes(sku(NS2, 'TABLE')), `the report must name the product with no claimed recipe: ${notice}`)
  },
)

test(
  'component shortage plans a started order from its snapshot and a DRAFT order from the claimed recipe',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    const deps = await loadDeps()
    const NS = 'S'
    const { tableId, rawId, claimedBomId } = await seedCatalogue(deps, NS)
    const warehouse = await ownWarehouse(deps, NS)
    await stockUp(deps, NS, warehouse.code, 10, 100)
    const started = await deps.createManufacturingOrder({
      productId: tableId, warehouseId: warehouse.id, orderType: 'ASSEMBLY', qtyPlanned: 4,
    })
    assert.ok(started.success && started.id)
    assert.ok((await deps.updateManufacturingOrderStatus(started.id, 'IN_PROGRESS')).success)

    const rawRow = async () => (await deps.getComponentShortageReport({}, { paginate: false }))
      .rows.find((row) => row.productId === rawId)
    // RAW: 10 on hand, 8 reserved by the start (2 x 4) => 2 available; requirement 8 => shortage 6.
    assert.equal((await rawRow())?.requiredQty, '8', 'PRECONDITION: the started order plans RAW x2 per unit')

    // Re-import the recipe (RAW x2 -> x3). The STARTED order keeps its frozen requirement.
    await reimportRecipe(deps, NS, 1, 3)
    const claimed = await deps.db.bom.findUniqueOrThrow({ where: { id: claimedBomId }, select: { items: { select: { componentProductId: true, qty: true } } } })
    assert.ok(claimed.items.some((item) => item.componentProductId === rawId && Number(item.qty) === 3), 'PRECONDITION: the claimed recipe changed')
    assert.equal((await rawRow())?.requiredQty, '8', 'a started order is planned from its snapshot (8), not the re-imported recipe (12)')

    // A DRAFT order that points at a stray duplicate Bom: planned from the CLAIMED recipe (RAW x3 -> 30), not the stray's x500.
    const strayId = await strayDuplicateBom(deps, NS, tableId, rawId, 500)
    await deps.db.productionOrder.create({
      data: { reference: `${TAG}${NS}-DRAFT`, orderType: 'ASSEMBLY', bomId: strayId, outputProductId: tableId, warehouseId: warehouse.id, qtyPlanned: 10, status: 'DRAFT' },
    })
    assert.equal((await rawRow())?.requiredQty, '38', 'started 4 x 2 (snapshot) + draft 10 x 3 (claimed recipe); the stray\'s x500 must not be used')

    // A started order whose snapshot is gone (a legacy row) is NOT planned from the live recipe; it is named.
    await deps.db.$executeRaw`UPDATE production_orders SET "componentSnapshot" = NULL WHERE id = ${started.id}`
    const afterLoss = await deps.getComponentShortageReport({}, { paginate: false })
    assert.equal(afterLoss.rows.find((row) => row.productId === rawId)?.requiredQty, '30', 'only the DRAFT (claimed recipe) remains')
    const startedRef = (await deps.db.productionOrder.findUniqueOrThrow({ where: { id: started.id }, select: { reference: true } })).reference
    assert.ok(afterLoss.notices.some((n) => /no usable frozen recipe/.test(n) && n.includes(startedRef)))
  },
)
