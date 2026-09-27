import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-zjsb5.9 — THE BOM RECIPE IMPORT PATH, IN A TIER CI ACTUALLY RUNS.
 *
 * WHY THIS FILE EXISTS AT ALL, stated plainly because it is a process defect as much as a technical
 * one (round 3 verdict). The branch's central claim is that a migrated manufacturing recipe is
 * GENUINELY USABLE — not merely present. That was proven, but in two places CI never looks: the
 * end-to-end proof sat in `tests/manual/`, which nothing collects, and the automated tests sat in
 * `tests/products/`, which `test:unit` covers but the concurrency job's glob does not. A property
 * that only holds when somebody remembers to run something is documentation, not a gate. So the
 * load-bearing parts live here, in `tests/concurrency/**`, which gates every merge.
 *
 * TWO THINGS ARE PROVEN HERE.
 *
 * 1. THE INTERLEAVING (round 3's HIGH). `createManufacturingOrder` took the component-graph lock but
 *    read the product's type and component list BEFORE it, outside any transaction. The lock
 *    serialized the write and not the data written: while the request waited, an editor could change
 *    the recipe — and the action would then write the OLD list into BomItem and raise an order
 *    against it — or a type conversion could RETIRE the Bom, and the action would claim and
 *    reactivate it for a product that is no longer BOM-typed. Both are driven here through a
 *    deliberate barrier, and both must be REFUSED rather than acted on.
 *
 *    The barrier is the advisory lock itself, held by this test on a connection of its own, so the
 *    interleaving is a fact of the sequence and not of the scheduler: the action provably cannot
 *    proceed past its lock acquisition until this test commits, which is precisely the window the
 *    finding is about.
 *
 * 2. THE RECIPE IS USABLE END TO END: one products CSV writes BOTH representations, and a production
 *    order is created AND COMPLETED against the migrated Bom, moving stock. That is the claim the
 *    whole branch rests on, and it now runs on every PR.
 *
 * Needs a real PostgreSQL — the advisory lock, the unique index on `boms.productId`, the foreign keys
 * and the deferrable stock-movement evidence trigger all participate. Gated behind
 * RUN_DB_CONCURRENCY_TESTS=1 like its siblings.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
// Belt, not decoration: importProductsCsv schedules a WooCommerce metadata push and an IMMEDIATE
// stock sync. A scratch database has no connector rows so both are no-ops, but "no vendor calls"
// must not rest on a database happening to be empty.
mock.module('@/lib/shopping', {
  namedExports: {
    enqueueStockSync: async () => {},
    pushProductMetadata: async () => ({ success: true }),
  },
})

config({ path: '.env.local', quiet: true })
config({ quiet: true })

type Deps = {
  db: typeof import('../../lib/db/index')['db']
  importProductsCsv: typeof import('../../app/actions/import')['importProductsCsv']
  importOpeningStockCsv: typeof import('../../app/actions/import')['importOpeningStockCsv']
  saveProductComponents: typeof import('../../app/actions/products')['saveProductComponents']
  createManufacturingOrder: typeof import('../../app/actions/manufacturing')['createManufacturingOrder']
  updateManufacturingOrderStatus: typeof import('../../app/actions/manufacturing')['updateManufacturingOrderStatus']
  findBomRecipeDrift: typeof import('../../lib/products/bom-recipe')['findBomRecipeDrift']
  COMPONENT_GRAPH_WRITE_LOCK_KEY: number
}

async function loadDeps(): Promise<Deps> {
  const [dbMod, importMod, productsMod, mfgMod, recipeMod, locksMod] = await Promise.all([
    import('../../lib/db/index'),
    import('../../app/actions/import'),
    import('../../app/actions/products'),
    import('../../app/actions/manufacturing'),
    import('../../lib/products/bom-recipe'),
    import('../../lib/db/advisory-locks'),
  ])
  return {
    db: dbMod.db,
    importProductsCsv: importMod.importProductsCsv,
    importOpeningStockCsv: importMod.importOpeningStockCsv,
    saveProductComponents: productsMod.saveProductComponents,
    createManufacturingOrder: mfgMod.createManufacturingOrder,
    updateManufacturingOrderStatus: mfgMod.updateManufacturingOrderStatus,
    findBomRecipeDrift: recipeMod.findBomRecipeDrift,
    COMPONENT_GRAPH_WRITE_LOCK_KEY: locksMod.COMPONENT_GRAPH_WRITE_LOCK_KEY,
  }
}

function csv(rows: string[]): FormData {
  const data = new FormData()
  data.set('file', new File([rows.join('\n')], 'products.csv', { type: 'text/csv' }))
  data.set('mode', 'execute')
  return data
}

function errorsOf(result: { errors?: string[] }): string[] {
  return result.errors ?? []
}

/**
 * A prefix unique to this run, so a re-run never collides with its own leftovers -- AND a per-test
 * namespace on top of it, so the three tests below never collide with EACH OTHER. They share a
 * database and each one mutates the catalogue it seeds (one rewrites the recipe, one converts the
 * product away from BOM), so a shared namespace would make each test's fixture depend on the order
 * the previous one left things in. Caught the first run: the warehouse `code` unique index.
 */
const TAG = `BR${Date.now().toString(36).toUpperCase()}`
const sku = (ns: string, name: string) => `${TAG}${ns}-${name}`

/**
 * HOLD THE COMPONENT-GRAPH LOCK on a connection of its own, run `body` while it is held, and release
 * it whatever body does.
 *
 * Deliberately the same discipline as o3d-nuhmy's `withRowPinned`: the release is in a `finally` the
 * caller cannot forget, and deferred work is handed back BOXED so `await` cannot flatten it into a
 * wait for something that needs the lock released first.
 */
async function whileHoldingGraphLock<T>(
  deps: Deps,
  body: () => Promise<{ deferred: T }>,
): Promise<{ deferred: T }> {
  const held = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const holder = deps.db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${deps.COMPONENT_GRAPH_WRITE_LOCK_KEY})`
    held.resolve()
    await release.promise
  }, { timeout: 60_000, maxWait: 10_000 })
  const settled = holder.then(() => undefined, (error: unknown) => error as unknown)
  await Promise.race([
    held.promise,
    settled.then((error) => { throw error ?? new Error('the lock holder ended before it took the lock') }),
  ])
  try {
    return await body()
  } finally {
    release.resolve()
    await settled
  }
}

/** Waits until `pg_locks` shows somebody WAITING for the advisory lock we are holding. */
async function awaitAdvisoryLockWaiter(deps: Deps, expected = 1): Promise<number> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const rows = await deps.db.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted
        AND classid = 0 AND objid = ${deps.COMPONENT_GRAPH_WRITE_LOCK_KEY}
    `
    const waiting = Number(rows[0]?.n ?? 0)
    if (waiting >= expected) return waiting
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(
    `no caller ever blocked on the component-graph advisory lock; without that, this test would be `
    + 'asserting about ordinary sequencing rather than about the window the finding is in',
  )
}

/**
 * A WAREHOUSE OF OUR OWN, never the seed's.
 *
 * This tier's guard refuses any database with rows in `users`, `organisations` or `currencies` --
 * exactly what `prisma/seed.ts` creates -- so a concurrency test cannot assume a seeded database and
 * must write what it needs. (`resolveBaseCurrencyCode` falls back to the default with no organisation
 * row, which is why the imports below work regardless.) Products and warehouses are explicitly NOT
 * evidence of repurposing: the guard's own note records that one green tier run left 47 products and
 * 85 warehouses behind.
 */
async function ownWarehouse(deps: Deps, ns: string): Promise<{ id: string; code: string }> {
  return await deps.db.warehouse.create({
    data: { code: sku(ns, 'WH').slice(0, 20), name: `${TAG}${ns} probe warehouse` },
    select: { id: true, code: true },
  })
}

/**
 * DRIFT FOR THIS TEST'S OWN PRODUCTS ONLY, and the scoping is not tidiness.
 *
 * `findBomRecipeDrift` deliberately scans the WHOLE database -- that is what makes it useful as an
 * operator check. Asserting its result is empty inside this tier would therefore assert that no other
 * file, and no earlier run, has ever left a drifted row behind: the guard's own note records that one
 * green tier run left 47 products and 85 warehouses in place, and sibling tests create drift on
 * purpose. Caught while mutation-testing this very file -- a leftover row from the previous run failed
 * an assertion about code the mutation had not touched, which is a false signal in both directions.
 */
async function driftForThisTest(deps: Deps, ns: string) {
  const mine = `${TAG}${ns}-`
  return (await deps.findBomRecipeDrift(deps.db)).filter((row) => row.sku.startsWith(mine))
}

async function seedCatalogue(deps: Deps, ns: string): Promise<{ tableId: string; legId: string; rawId: string }> {
  const loaded = await deps.importProductsCsv(csv([
    'sku,name,type,components,stockUnit',
    `${sku(ns, 'RAW')},Oak board,SIMPLE,,each`,
    `${sku(ns, 'LEG')},Table leg,SIMPLE,,each`,
    `${sku(ns, 'TABLE')},Oak table,BOM,${sku(ns, 'LEG')}:4;${sku(ns, 'RAW')}:2,each`,
  ]))
  assert.deepEqual(errorsOf(loaded), [], 'the catalogue must import cleanly')
  const table = await deps.db.product.findUniqueOrThrow({ where: { sku: sku(ns, 'TABLE') }, select: { id: true } })
  const leg = await deps.db.product.findUniqueOrThrow({ where: { sku: sku(ns, 'LEG') }, select: { id: true } })
  const raw = await deps.db.product.findUniqueOrThrow({ where: { sku: sku(ns, 'RAW') }, select: { id: true } })
  return { tableId: table.id, legId: leg.id, rawId: raw.id }
}

test(
  '[o3d-zjsb5.9] one products CSV writes BOTH representations, and the migrated recipe completes a production order',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    const deps = await loadDeps()
    const NS = 'A'
    const { tableId, legId, rawId } = await seedCatalogue(deps, NS)

    const table = await deps.db.product.findUniqueOrThrow({
      where: { id: tableId },
      select: {
        productComponents: { select: { componentId: true, qty: true } },
        manufacturingBom: { select: { id: true, active: true, productId: true, items: { select: { componentProductId: true, qty: true } } } },
      },
    })
    assert.equal(table.productComponents.length, 2, 'the fulfilment/consumption copy must be written')
    assert.ok(table.manufacturingBom, 'the PLANNING copy must be written too — this is the gap the branch closes')
    assert.equal(table.manufacturingBom.productId, tableId, 'and it must be claimed by the product')
    assert.equal(table.manufacturingBom.active, true, 'and active, or planning filters it out')
    assert.deepEqual(
      table.manufacturingBom.items.map((item) => [item.componentProductId, Number(item.qty)]).sort(),
      [[legId, 4], [rawId, 2]].sort(),
      'the two representations must agree, component for component',
    )
    assert.deepEqual(await driftForThisTest(deps, NS), [], 'no drift after the load')

    // Stock for the components, through the sanctioned opening-stock path: a hand-written movement is
    // refused by the deferrable reporting-evidence trigger.
    const warehouse = await ownWarehouse(deps, NS)
    const stock = await deps.importOpeningStockCsv(csv([
      'sku,warehouseCode,qty,unitCostBase',
      `${sku(NS, 'RAW')},${warehouse.code},500,1`,
      `${sku(NS, 'LEG')},${warehouse.code},500,2`,
    ]))
    assert.deepEqual(errorsOf(stock), [], 'opening stock must load')

    const created = await deps.createManufacturingOrder({
      productId: tableId, warehouseId: warehouse.id, orderType: 'ASSEMBLY', qtyPlanned: 2,
    })
    assert.ok(created.success && created.id, `order create failed: ${JSON.stringify(created)}`)
    const order = await deps.db.productionOrder.findUniqueOrThrow({
      where: { id: created.id }, select: { bomId: true },
    })
    assert.equal(order.bomId, table.manufacturingBom.id,
      'the order must run against the MIGRATED Bom, not one invented lazily at create time')

    assert.ok((await deps.updateManufacturingOrderStatus(created.id, 'IN_PROGRESS')).success)
    assert.ok((await deps.updateManufacturingOrderStatus(created.id, 'COMPLETED')).success)
    const output = await deps.db.stockLevel.findFirstOrThrow({
      where: { productId: tableId, warehouseId: warehouse.id }, select: { quantity: true },
    })
    assert.equal(Number(output.quantity), 2, 'completing the order must add finished stock — this is "usable", not "present"')
    assert.deepEqual(await driftForThisTest(deps, NS), [], 'and the two representations still agree')
  },
)

test(
  '[o3d-zjsb5.9 r3] a recipe edited while a build order waits for the graph lock is not written from the stale snapshot',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    const deps = await loadDeps()
    const NS = 'B'
    const { tableId, legId, rawId } = await seedCatalogue(deps, NS)
    const originalBom = await deps.db.bom.findUniqueOrThrow({ where: { productId: tableId }, select: { id: true } })
    const warehouse = await ownWarehouse(deps, NS)

    const outcome = await whileHoldingGraphLock(deps, async () => {
      // The action does its preflight read now, then blocks on the lock we are holding.
      const inFlight = deps.createManufacturingOrder({
        productId: tableId, warehouseId: warehouse.id, orderType: 'ASSEMBLY', qtyPlanned: 1,
      })
      inFlight.catch(() => {})
      // THE WINDOW, ESTABLISHED BY THE SERVER rather than by a sleep: it is provably parked on the
      // lock, so its snapshot is provably older than anything we change next.
      await awaitAdvisoryLockWaiter(deps)

      // Change the recipe underneath it. Done with raw SQL ON OUR OWN connection because the editor
      // would want the very lock we are holding -- the point is that the action's snapshot is now
      // stale, not how it became stale.
      await deps.db.$executeRaw`DELETE FROM product_components WHERE "productId" = ${tableId}`
      await deps.db.$executeRaw`
        INSERT INTO product_components ("id", "productId", "componentId", qty, "sortOrder")
        VALUES (${`pc-${TAG}${NS}-new`}, ${tableId}, ${rawId}, 9, 0)
      `
      return { deferred: inFlight }
    })

    const created = await outcome.deferred
    assert.ok(created.success, `the order should still be raised, from the CURRENT recipe: ${JSON.stringify(created)}`)

    // THE ASSERTION THAT MATTERS. The recipe written under the lock must be the one that existed when
    // the lock was granted (RAW x9), never the pre-lock snapshot (LEG x4 + RAW x2).
    const after = await deps.db.bom.findUniqueOrThrow({
      where: { id: originalBom.id },
      select: { items: { select: { componentProductId: true, qty: true } } },
    })
    assert.deepEqual(
      after.items.map((item) => [item.componentProductId, Number(item.qty)]),
      [[rawId, 9]],
      'BomItem must mirror the recipe as of the LOCKED read; the stale snapshot would have written LEG x4 + RAW x2',
    )
    assert.ok(
      !after.items.some((item) => item.componentProductId === legId),
      'the dropped component must not survive in the planning copy',
    )
    assert.deepEqual(await driftForThisTest(deps, NS), [],
      'and the two representations must agree afterwards — a stale write is exactly the drift this branch removes')
  },
)

test(
  '[o3d-zjsb5.9 r3] a BOM retired while a build order waits for the graph lock is REFUSED, not claimed and reactivated',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    const deps = await loadDeps()
    const NS = 'C'
    const { tableId } = await seedCatalogue(deps, NS)
    const originalBom = await deps.db.bom.findUniqueOrThrow({ where: { productId: tableId }, select: { id: true } })
    const warehouse = await ownWarehouse(deps, NS)

    const outcome = await whileHoldingGraphLock(deps, async () => {
      const inFlight = deps.createManufacturingOrder({
        productId: tableId, warehouseId: warehouse.id, orderType: 'ASSEMBLY', qtyPlanned: 1,
      })
      inFlight.catch(() => {})
      await awaitAdvisoryLockWaiter(deps)

      // Retire the recipe exactly as a type conversion does: product away from BOM, recipe
      // deactivated and unclaimed, items KEPT so history still resolves.
      await deps.db.$executeRaw`UPDATE products SET type = 'SIMPLE' WHERE id = ${tableId}`
      await deps.db.$executeRaw`UPDATE boms SET active = false, "productId" = NULL WHERE id = ${originalBom.id}`
      return { deferred: inFlight }
    })

    const created = await outcome.deferred
    assert.equal(created.success, false, 'raising a build order for a product that is no longer a BOM must be REFUSED')
    assert.match(String(created.error), /no longer has a manufacturing recipe|changed to SIMPLE/i,
      `the refusal must say what happened, got: ${created.error}`)

    // AND THE REFUSAL MUST BE COMPLETE: nothing claimed, nothing reactivated, no order.
    const bom = await deps.db.bom.findUniqueOrThrow({
      where: { id: originalBom.id }, select: { active: true, productId: true },
    })
    assert.equal(bom.active, false, 'the retired recipe must NOT have been reactivated')
    assert.equal(bom.productId, null, 'and must NOT have been re-claimed for a product that is no longer BOM-typed')
    assert.equal(
      await deps.db.productionOrder.count({ where: { outputProductId: tableId } }), 0,
      'and no production order may exist for it',
    )
  },
)

test(
  '[o3d-zjsb5.9 r3] a RETIRED recipe\'s edges do not block a legitimate re-import through the cycle check',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    /**
     * A CONSEQUENCE OF RETIRE-NOT-DELETE, found by auditing every reader of Bom/BomItem for the
     * `active` filter (round 3). Retiring keeps the items on purpose, so open and completed production
     * orders still resolve. But the two cycle walks -- the import preflight and the in-transaction
     * check -- read `bom_items` with no `active` filter, so a retired recipe's edges stayed in the
     * graph they walk. The reader those walks protect
     * (`replenishment-reports.ts`: `where: { bom: { active: true }, parentProduct: { type: BOM } }`)
     * cannot follow those edges at all, so counting them cannot prevent a real problem -- it can only
     * refuse a legitimate import. Conservative in the wrong direction is still wrong.
     */
    const deps = await loadDeps()
    const NS = 'D'
    const parent = sku(NS, 'PARENT')
    const child = sku(NS, 'CHILD')

    // Two BOMs where each is, at some point, a component of the other -- legal only because the first
    // arrangement is retired before the second is created.
    assert.deepEqual(errorsOf(await deps.importProductsCsv(csv([
      'sku,name,type,components,stockUnit',
      `${sku(NS, 'RAW')},Oak board,SIMPLE,,each`,
      `${child},Child,BOM,${sku(NS, 'RAW')}:1,each`,
      `${parent},Parent,BOM,${child}:2,each`,
    ]))), [], 'the first arrangement must import')

    // Retire the PARENT exactly as a type conversion does: items kept, recipe deactivated+unclaimed.
    assert.deepEqual(errorsOf(await deps.importProductsCsv(csv([
      'sku,name,type,stockUnit', `${parent},Parent,SIMPLE,each`,
    ]))), [], 'the conversion must import')
    const retired = await deps.db.bom.findFirstOrThrow({
      where: { items: { some: { parentProduct: { sku: parent } } } },
      select: { active: true, productId: true, items: { select: { id: true } } },
    })
    assert.equal(retired.active, false, 'precondition: the recipe must be retired')
    assert.ok(retired.items.length > 0, 'precondition: and its items KEPT -- that is what makes this a hazard')

    // NOW the reverse direction is legitimate: PARENT is no longer a BOM, so CHILD may consume it.
    // With the walk unscoped, the retired PARENT -> CHILD edge closes a cycle and refuses this.
    const result = await deps.importProductsCsv(csv([
      'sku,name,type,components,stockUnit', `${child},Child,BOM,${parent}:1,each`,
    ]))
    assert.ok(
      !errorsOf(result).some((line) => /circular/i.test(line)),
      `a retired recipe's edges must not refuse this import, got: ${JSON.stringify(errorsOf(result))}`,
    )
    const childRow = await deps.db.product.findUniqueOrThrow({
      where: { sku: child },
      select: { manufacturingBom: { select: { items: { select: { component: { select: { sku: true } } } } } } },
    })
    assert.deepEqual(
      childRow.manufacturingBom?.items.map((item) => item.component.sku),
      [parent],
      'and the new recipe must actually have been written',
    )
  },
)
