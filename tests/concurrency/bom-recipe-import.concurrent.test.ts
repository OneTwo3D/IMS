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

/**
 * THE RECIPE AS THE DATABASE HOLDS IT, for asserting a refusal changed NOTHING.
 *
 * Round 6's three findings all had the same shape: the action reported failure and the rejected state
 * committed anyway. Asserting on the return value alone cannot see that, so each refusal test compares
 * this before and after. `qty` is stringified because Prisma hands back Decimal objects that
 * `deepEqual` compares by identity rather than value.
 */
async function snapshotRecipe(deps: Deps, productId: string, bomId: string) {
  const bom = await deps.db.bom.findUniqueOrThrow({
    where: { id: bomId }, select: { active: true, productId: true },
  })
  const items = await deps.db.bomItem.findMany({
    where: { parentProductId: productId },
    select: { bomId: true, componentProductId: true, qty: true, sortOrder: true },
    orderBy: [{ bomId: 'asc' }, { componentProductId: 'asc' }],
  })
  return {
    bom,
    items: items.map((item) => ({ ...item, qty: String(item.qty) })),
  }
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

    // AND THE OPERATOR CHECK MUST AGREE (round 6, finding 2). This is the same state from the drift
    // check's side: a retired PARENT -> CHILD edge alongside a live CHILD -> PARENT one. The write
    // path was scoped in round 4 but `findBomRecipeDrift` still walked every BomItem row, so it
    // reported `bom-item-cycle` here and `check:bom-recipes` exited 1 on a correct, ordinary
    // post-retirement state. A guard that goes red on correct states gets ignored, which is strictly
    // worse than one that is merely narrow -- so the two walks now share one definition.
    const drift = await driftForThisTest(deps, NS)
    assert.deepEqual(
      drift.filter((row) => row.kind === 'bom-item-cycle'),
      [],
      `a retirement plus a reverse edge is NOT a planning cycle, got: ${JSON.stringify(drift)}`,
    )
  },
)

test(
  '[o3d-zjsb5.9 r6] components cleared while a build order waits for the lock is REFUSED, and nothing is written',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    // THE SECOND LOCKED-READ REFUSAL, which round 5 noted was assumed rather than exercised: only
    // `not-bom` had a test. Both refusals return before any write, so they were safe -- but "safe
    // because I read it" is what rounds 5 and 6 kept overturning.
    const deps = await loadDeps()
    const NS = 'E'
    const { tableId } = await seedCatalogue(deps, NS)
    const originalBom = await deps.db.bom.findUniqueOrThrow({
      where: { productId: tableId }, select: { id: true },
    })
    const warehouse = await ownWarehouse(deps, NS)
    const before = await snapshotRecipe(deps, tableId, originalBom.id)

    const outcome = await whileHoldingGraphLock(deps, async () => {
      const inFlight = deps.createManufacturingOrder({
        productId: tableId, warehouseId: warehouse.id, orderType: 'ASSEMBLY', qtyPlanned: 1,
      })
      inFlight.catch(() => {})
      await awaitAdvisoryLockWaiter(deps)
      // An editor empties the recipe while the build order waits. The product stays BOM-typed, so
      // only the component list distinguishes this from a valid build.
      await deps.db.$executeRaw`DELETE FROM product_components WHERE "productId" = ${tableId}`
      return { deferred: inFlight }
    })

    const created = await outcome.deferred
    assert.equal(created.success, false, 'a build order against an emptied recipe must be REFUSED')
    assert.match(String(created.error), /components were cleared/i,
      `the refusal must name what changed, got: ${created.error}`)
    assert.equal(
      await deps.db.productionOrder.count({ where: { outputProductId: tableId } }), 0,
      'and no production order may exist',
    )
    // THE DATABASE, NOT THE RETURN VALUE. Reporting failure while committing the rejected state is
    // the trap this round is about, so assert the recipe rows are exactly as they were.
    assert.deepEqual(await snapshotRecipe(deps, tableId, originalBom.id), before,
      'the refusal must leave Bom/BomItem byte-for-byte unchanged')
  },
)

test(
  '[o3d-zjsb5.9 r6] a build order refused for a CYCLE does not commit the rejected recipe',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    /**
     * ROUND 5, FINDING 1 -- and the same defect I introduced and fixed at the import site in round 2.
     * `syncBomRecipeFromProductComponents` REPLACES this parent's BomItem rows and only then checks
     * the graph it is committing (it must: checking first asks about the old edges). So returning the
     * `cycle` outcome from the transaction callback COMMITTED it: the action reported failure and
     * raised no order, while leaving an active cyclic graph behind for the planning explosion to walk.
     * Failure reported, rejected state committed -- worse than either alone.
     */
    const deps = await loadDeps()
    const NS = 'F'
    const { tableId, legId } = await seedCatalogue(deps, NS)
    const originalBom = await deps.db.bom.findUniqueOrThrow({
      where: { productId: tableId }, select: { id: true },
    })
    const warehouse = await ownWarehouse(deps, NS)

    // THE REVERSE EDGE MUST LIVE IN `bom_items` ONLY, and that is the whole reason this hazard exists.
    // Importing LEG as a BOM consuming TABLE is refused by the PRE-EXISTING `ProductComponent` cycle
    // check (`detectComponentCycle`) -- correctly, and I tried it first: `Row 2: circular BOM reference
    // detected`. So a cycle reachable by the BOM walk can only be one the ProductComponent graph does
    // NOT have, which is exactly what a legacy `bom_items` row left by an earlier snapshot is. That is
    // also why `detectComponentCycle` could not be reused for this: it walks `product_components`.
    await deps.db.product.update({ where: { id: legId }, data: { type: 'BOM' } })
    const legacyBom = await deps.db.bom.create({
      data: { name: `${TAG}${NS} legacy leg recipe`, productId: legId, active: true },
      select: { id: true },
    })
    await deps.db.bomItem.create({
      data: {
        bomId: legacyBom.id, parentProductId: legId, componentProductId: tableId, qty: 1, sortOrder: 0,
      },
    })
    // MAKE THE REJECTED WRITE DIFFER FROM WHAT IS STORED, or this test cannot see the defect at all.
    // The sync rewrites TABLE's BomItem rows from its ProductComponent list; if the two already agree,
    // committing the rejected recipe produces rows identical to the ones already there and "the
    // database is unchanged" passes whether or not the rollback happened. So desync them first, the way
    // a direct edit would: ProductComponent now says LEG:9, while BomItem still says LEG:4. A commit of
    // the rejected recipe would therefore leave LEG:9 behind, which the snapshot WILL see.
    // (Verified by mutation: with the refusal returned instead of thrown, this test reds.)
    await deps.db.$executeRaw`
      UPDATE product_components SET qty = 9
      WHERE "productId" = ${tableId} AND "componentId" = ${legId}
    `
    const before = await snapshotRecipe(deps, tableId, originalBom.id)
    assert.ok(before.items.length > 0, 'precondition: TABLE must have a recipe to reject')
    assert.ok(
      before.items.some((item) => item.componentProductId === legId && item.qty.startsWith('4')),
      'precondition: BomItem must still hold the OLD qty, so a committed rewrite is detectable',
    )

    const created = await deps.createManufacturingOrder({
      productId: tableId, warehouseId: warehouse.id, orderType: 'ASSEMBLY', qtyPlanned: 1,
    })
    assert.equal(created.success, false, 'a build order against a cyclic recipe must be REFUSED')
    assert.match(String(created.error), /circular/i, `the refusal must say why, got: ${created.error}`)
    assert.equal(
      await deps.db.productionOrder.count({ where: { outputProductId: tableId } }), 0,
      'and no production order may exist',
    )
    // THE POINT OF THE ROUND: the rejected recipe must not be sitting in the database.
    assert.deepEqual(await snapshotRecipe(deps, tableId, originalBom.id), before,
      'the refused cycle must have been ROLLED BACK, not committed while the action reported failure')
    // And the operator check must SEE this one -- it is genuinely reachable by planning, unlike the
    // retired edges of test 4. The same walk, giving opposite answers on the two states, is the point.
    const cycleDrift = await driftForThisTest(deps, NS)
    assert.ok(
      cycleDrift.some((row) => row.kind === 'bom-item-cycle'),
      `a LIVE cycle must still be reported as drift, got: ${JSON.stringify(cycleDrift)}`,
    )

    // CLEAN UP THE CYCLE, and this is load-bearing rather than tidiness.
    // `detectBomItemCycleInEdges` walks every parent and returns the FIRST cycle it finds ANYWHERE in
    // the graph -- it is not scoped to the product being written. So this test's deliberate cycle makes
    // every later BOM import and every later build order fail, in this file and in any sibling sharing
    // this tier's database, with a message naming two unrelated product ids. Test 7 failed exactly that
    // way before this cleanup existed. Filed as its own issue, because the same property means one
    // pre-existing cyclic legacy pair in a real database blocks ALL BOM imports (o3d-zjsb5.9 round 6).
    await deps.db.bom.update({ where: { id: legacyBom.id }, data: { active: false, productId: null } })
    await deps.db.product.update({ where: { id: legId }, data: { type: 'SIMPLE' } })
    assert.deepEqual(
      (await driftForThisTest(deps, NS)).filter((row) => row.kind === 'bom-item-cycle'), [],
      'and retiring it must clear the cycle again -- proof the cleanup worked, not just that it ran',
    )
  },
)

test(
  '[o3d-zjsb5.9 r6] an import that LOSES the BOM claim writes NEITHER representation',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    /**
     * ROUND 5, FINDING 3. The component pass handled `cycle` and ignored `claim-contended`, so losing
     * the compare-and-set returned `true` and COMMITTED the component list with no claimed Bom -- the
     * sellable-but-unmanufacturable state this whole change exists to remove, reintroduced by the very
     * CAS added in round 2 to prevent a different form of it.
     *
     * WHICH SITE THIS ACTUALLY EXERCISES, stated because a mutation proved my first answer wrong.
     * Removing the pass-2 guard does NOT red this test. The refusal it observes comes from PASS 1's
     * `reconcileBomRecipeForProductType`, which runs first, in its own transaction, under the same
     * graph lock, and already threw on `claim-contended` before round 6. Pass 1 therefore reconciles
     * every existing BOM-typed row in the CSV, so by the time pass 2 runs the product normally HAS a
     * claimed Bom and pass 2's adopt-and-CAS branch is not reached at all. I could not construct a
     * reachable case where pass 2 loses the CAS while pass 1 does not refuse first.
     *
     * So the pass-2 guard added in round 6 is FAIL-CLOSED DEFENCE, not a fix for a demonstrated live
     * path, and its presence is asserted structurally by the shape test in
     * `tests/products/bom-recipe.test.ts` rather than behaviourally here. What this test does prove,
     * on the real code path and with a real lost compare-and-set, is the property the finding is
     * about: when the claim is lost, NEITHER representation is written and the operator is told.
     */
    const deps = await loadDeps()
    const NS = 'G'
    assert.deepEqual(errorsOf(await deps.importProductsCsv(csv([
      'sku,name,type,components,stockUnit',
      `${sku(NS, 'RAW')},Oak board,SIMPLE,,each`,
      `${sku(NS, 'OTHER')},Other,SIMPLE,,each`,
      `${sku(NS, 'TABLE')},Oak table,BOM,${sku(NS, 'RAW')}:1,each`,
    ]))), [], 'the catalogue must import cleanly')
    const table = await deps.db.product.findUniqueOrThrow({
      where: { sku: sku(NS, 'TABLE') }, select: { id: true },
    })
    const other = await deps.db.product.findUniqueOrThrow({
      where: { sku: sku(NS, 'OTHER') }, select: { id: true },
    })
    // Retire TABLE's recipe so the next import has an UNCLAIMED row to adopt -- the only path that
    // runs the compare-and-set at all.
    const bom = await deps.db.bom.findUniqueOrThrow({ where: { productId: table.id }, select: { id: true } })
    await deps.db.$executeRaw`UPDATE boms SET active = false, "productId" = NULL WHERE id = ${bom.id}`
    const beforeComponents = await deps.db.productComponent.findMany({
      where: { productId: table.id }, select: { componentId: true }, orderBy: { componentId: 'asc' },
    })

    // A GENUINE COMPARE-AND-SET LOSS, forced with a row lock rather than simulated.
    //
    // I tried the obvious interleaving first -- claim the row while the import waits for the GRAPH
    // lock -- and it does not work: the import reads `adoptable` AFTER taking that lock, so it sees the
    // row already claimed, finds nothing to adopt, and creates a fresh Bom. No contention, and the test
    // passed while proving nothing. The window is between the helper's READ and its WRITE, inside one
    // transaction, so it cannot be reached from outside by ordering alone.
    //
    // READ COMMITTED gives it to us exactly. An uncommitted `UPDATE` on that row from another
    // connection leaves the import's read seeing `productId = NULL` (the pre-update row version) while
    // its `updateMany ... WHERE productId IS NULL` BLOCKS on the row lock. When the other connection
    // commits, Postgres re-evaluates the predicate against the NEW row version, the row no longer
    // matches, and `count` comes back 0 -- a real lost CAS, on the real code path.
    const claimHeld = Promise.withResolvers<number>()
    const claimRelease = Promise.withResolvers<void>()
    const claimant = deps.db.$transaction(async (tx) => {
      const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`
      await tx.$executeRaw`UPDATE boms SET "productId" = ${other.id}, active = true WHERE id = ${bom.id}`
      claimHeld.resolve(pid)
      await claimRelease.promise
    }, { timeout: 60_000, maxWait: 10_000 })
    const claimantSettled = claimant.then(() => undefined, (error: unknown) => error as unknown)
    const claimantPid = await Promise.race([
      claimHeld.promise,
      claimantSettled.then((error) => {
        throw error ?? new Error('the claimant ended before it held the row')
      }),
    ])

    let result: Awaited<ReturnType<typeof deps.importProductsCsv>>
    try {
      const inFlight = deps.importProductsCsv(csv([
        'sku,name,type,components,stockUnit',
        `${sku(NS, 'TABLE')},Oak table,BOM,${sku(NS, 'RAW')}:5,each`,
      ]))
      inFlight.catch(() => {})
      // PROOF THE WINDOW WAS ACTUALLY ENTERED. `pg_blocking_pids` is the lock manager's own answer, not
      // a reporting field, so this is the authoritative "it is waiting for my row" -- and without it
      // this test would be asserting about ordinary sequencing.
      const deadline = Date.now() + 20_000
      let blocked = 0
      while (Date.now() < deadline) {
        const rows = await deps.db.$queryRaw<Array<{ n: bigint }>>`
          SELECT count(*)::bigint AS n FROM pg_stat_activity
          WHERE ${claimantPid} = ANY(pg_blocking_pids(pid))
        `
        blocked = Number(rows[0]?.n ?? 0)
        if (blocked > 0) break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert.ok(blocked > 0, 'the import must actually block on the claimed row, or the CAS never raced')
      result = await (async () => {
        claimRelease.resolve()
        return await inFlight
      })()
    } finally {
      claimRelease.resolve()
      await claimantSettled
    }

    const errors = errorsOf(result)
    assert.ok(
      errors.some((line) => /claimed this product's manufacturing BOM/i.test(line)),
      `losing the claim must be REPORTED, not ignored, got: ${JSON.stringify(errors)}`,
    )
    // Which refusal this is, pinned so the test cannot silently start proving something else -- the
    // way it silently proved the wrong thing until a surviving mutation said so.
    assert.ok(
      errors.some((line) => /while the import\s+was running|while the import was running/.test(line)),
      `the refusal must be pass 1's reconcile, the reachable site, got: ${JSON.stringify(errors)}`,
    )
    // AND ROLLED BACK: the component list must still be the old one, not the qty 5 the CSV asked for.
    assert.deepEqual(
      await deps.db.productComponent.findMany({
        where: { productId: table.id }, select: { componentId: true }, orderBy: { componentId: 'asc' },
      }),
      beforeComponents,
      'the ProductComponent write must NOT have committed without a claimed Bom -- that is exactly the '
      + 'sellable-but-unmanufacturable split this change exists to prevent',
    )
    const stillTheirs = await deps.db.bom.findUniqueOrThrow({
      where: { id: bom.id }, select: { productId: true },
    })
    assert.equal(stillTheirs.productId, other.id, 'and the other writer keeps its claim')
  },
)
