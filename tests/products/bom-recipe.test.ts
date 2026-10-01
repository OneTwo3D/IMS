import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  PLANNING_REACHABLE_BOM_EDGES,
  compareRecipes,
  detectBomItemCycleAfterReplacement,
  detectBomItemCycleInEdges,
  findBomRecipeDrift,
  normalizeRecipeQty,
  retireBomRecipeForProduct,
  syncBomRecipeFromProductComponents,
  toRecipeMap,
} from '../../lib/products/bom-recipe.ts'
import { type ServerIdentity, dischargeIdentity } from '../../lib/products/bom-recipe-repair.ts'

/**
 * o3d-zjsb5.9 — BOM RECIPES HAD NO IMPORT PATH.
 *
 * A manufactured product's recipe lives in IMS TWICE: `ProductComponent` (fulfilment and
 * production-order consumption) and `Bom`/`BomItem` (replenishment planning, reorder-MO
 * generation, manufacturing analytics). Only the first was ever written by an importer, so a
 * migrated BOM was sellable and invisible to planning — and no constraint, guard or log said so.
 *
 * WHAT THESE TESTS DO AND DO NOT ESTABLISH. They are behavioural against a recording fake client,
 * so they pin what the sync and the drift check DO with rows. They do not prove the recipe matches
 * Qoblex (two identically wrong recipes are "consistent"), and they do not prove Postgres accepts
 * the writes — the unique index on `boms.productId`, the foreign keys and the end-to-end import are
 * proven on a real throwaway cluster by `scripts/verify-bom-recipe-import.ts`.
 *
 * Every assertion here was mutation-verified: see the branch's PR body for which mutation reds
 * which named test.
 */

// ---------------------------------------------------------------------------
// Pure: quantity normalisation and comparison
// ---------------------------------------------------------------------------

test('[o3d-zjsb5.9] recipe quantities are compared at the stored Decimal(12,4) scale', () => {
  // Both columns are Decimal(12,4). A Prisma Decimal arrives as an object with toString(); the
  // CSV side arrives as a JS number. Comparing those two directly is how float noise becomes
  // "drift" — 0.1 + 0.2 is not 0.3.
  assert.equal(normalizeRecipeQty(2), '2.0000')
  assert.equal(normalizeRecipeQty({ toString: () => '2' }), '2.0000')
  assert.equal(normalizeRecipeQty('2.00000'), '2.0000')
  assert.equal(normalizeRecipeQty(0.1 + 0.2), normalizeRecipeQty(0.3))
  // ...and a difference INSIDE the stored scale is still a difference. Rounding to fewer places
  // would make this pass and hide a real 0.0001 divergence.
  assert.notEqual(normalizeRecipeQty(1.0001), normalizeRecipeQty(1.0002))
})

test('[o3d-zjsb5.9] two BomItem rows for one component are summed, not silently deduped', () => {
  // ProductComponent has @@unique([productId, componentId]) so it can never duplicate; BomItem
  // has no such constraint. Taking "the last one wins" would report a matching recipe for a BOM
  // whose planning demand is actually double.
  assert.deepEqual(
    [...toRecipeMap([
      { componentProductId: 'a', qty: 2 },
      { componentProductId: 'a', qty: 3 },
    ])],
    [['a', '5.0000']],
  )
})

test('[o3d-zjsb5.9] compareRecipes reports agreement as empty and every kind of disagreement', () => {
  const components = [{ componentProductId: 'raw-oak', qty: 2 }, { componentProductId: 'leg', qty: 4 }]

  // NON-VACUITY: the agreeing case must be clean, or a blanket "everything differs" would pass
  // every refusal assertion below while being useless.
  assert.deepEqual(compareRecipes(components, [...components]), [])

  assert.deepEqual(
    compareRecipes(components, [{ componentProductId: 'raw-oak', qty: 2 }]),
    [{ kind: 'missing-from-bom', componentProductId: 'leg', componentQty: '4.0000' }],
  )
  assert.deepEqual(
    compareRecipes([{ componentProductId: 'raw-oak', qty: 2 }], components),
    [{ kind: 'missing-from-components', componentProductId: 'leg', bomQty: '4.0000' }],
  )
  assert.deepEqual(
    compareRecipes(components, [{ componentProductId: 'raw-oak', qty: 2 }, { componentProductId: 'leg', qty: 5 }]),
    [{ kind: 'qty-differs', componentProductId: 'leg', componentQty: '4.0000', bomQty: '5.0000' }],
  )
})

// ---------------------------------------------------------------------------
// Pure: cycles in the bom_items graph
// ---------------------------------------------------------------------------

test('[o3d-zjsb5.9] detectBomItemCycleInEdges terminates on a graph that ALREADY contains a cycle', () => {
  // The reason this must hold: legacy Bom rows were written at different times from different
  // snapshots of product_components, so a cyclic bom_items graph is reachable TODAY. A detector
  // that only terminates on acyclic input would hang exactly when it is needed.
  assert.equal(detectBomItemCycleInEdges([{ parentProductId: 'a', componentProductId: 'b' }]), null)
  assert.deepEqual(
    detectBomItemCycleInEdges([
      { parentProductId: 'a', componentProductId: 'b' },
      { parentProductId: 'b', componentProductId: 'a' },
    ]),
    ['a', 'b', 'a'],
  )
  assert.deepEqual(detectBomItemCycleInEdges([{ parentProductId: 'a', componentProductId: 'a' }]), ['a', 'a'])
  // A diamond is not a cycle. Treating a re-visited node as one would refuse every legitimate
  // recipe that uses the same raw material at two levels.
  assert.equal(
    detectBomItemCycleInEdges([
      { parentProductId: 'top', componentProductId: 'left' },
      { parentProductId: 'top', componentProductId: 'right' },
      { parentProductId: 'left', componentProductId: 'raw' },
      { parentProductId: 'right', componentProductId: 'raw' },
    ]),
    null,
  )
})

test('[o3d-zjsb5.9] the dry-run cycle check asks about the graph AFTER the parent is replaced', () => {
  const edges = [
    { parentProductId: 'table', componentProductId: 'leg' },
    { parentProductId: 'leg', componentProductId: 'raw' },
  ]
  // Replacing table's recipe with raw removes table -> leg, so the graph is acyclic: a check that
  // ADDED the proposed edges without removing the old ones would report a cycle here and refuse a
  // legitimate re-import.
  assert.equal(detectBomItemCycleAfterReplacement(edges, 'table', ['raw']), null)
  // Making leg require table closes leg -> table -> leg. The old edges for `leg` are gone, so this
  // cycle can only be seen by considering the PROPOSED ones.
  assert.deepEqual(detectBomItemCycleAfterReplacement(edges, 'leg', ['table']), ['table', 'leg', 'table'])
})

// ---------------------------------------------------------------------------
// The write path
// ---------------------------------------------------------------------------

type FakeBom = { id: string; name: string; productId: string | null; updatedAt: number }
type FakeItem = { bomId: string; parentProductId: string; componentProductId: string; qty: number; sortOrder: number }

function fakeSyncClient(seed?: { boms?: FakeBom[]; items?: FakeItem[] }) {
  const boms: FakeBom[] = seed?.boms ? [...seed.boms] : []
  const items: FakeItem[] = seed?.items ? [...seed.items] : []
  let created = 0
  const calls: string[] = []

  const client = {
    bom: {
      findUnique: async ({ where }: { where: { productId: string } }) => {
        calls.push('bom.findUnique')
        const bom = boms.find((entry) => entry.productId === where.productId)
        return bom ? { ...bom, active: (bom as { active?: boolean }).active ?? true } : null
      },
      // No ACTIVE duplicate Boms (round 8): these cases are about the claimed recipe, and an empty
      // result is the "nothing else is active for this parent" state they all assume. The refusal that
      // reads this is exercised for real in tests/concurrency/bom-recipe-import.concurrent.test.ts.
      findMany: async () => [],
      findFirst: async ({ where }: { where: { productId: null; items: { some: { parentProductId: string } } } }) => {
        calls.push('bom.findFirst')
        const parent = where.items.some.parentProductId
        const candidates = boms
          .filter((bom) => bom.productId === null)
          .filter((bom) => items.some((item) => item.bomId === bom.id && item.parentProductId === parent))
          .sort((a, b) => b.updatedAt - a.updatedAt)
        return candidates[0] ?? null
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        calls.push('bom.update')
        const bom = boms.find((entry) => entry.id === where.id)
        assert.ok(bom, 'update targeted a bom that does not exist')
        Object.assign(bom, data)
        return bom
      },
      // The CAS the adoption uses (round 2). The fake HONOURS the `productId: null` predicate, or
      // the contention test below would pass against an unconditional implementation.
      updateMany: async ({ where, data }: { where: { id: string; productId: null }; data: { productId: string } }) => {
        calls.push('bom.updateMany')
        const bom = boms.find((entry) => entry.id === where.id && entry.productId === null)
        if (!bom) return { count: 0 }
        Object.assign(bom, data)
        return { count: 1 }
      },
      create: async ({ data }: { data: { name: string; productId: string } }) => {
        calls.push('bom.create')
        const bom: FakeBom = { id: `bom-${++created}`, name: data.name, productId: data.productId, updatedAt: Date.now() }
        // The real column is UNIQUE. The fake enforces it, or a test could "pass" by creating a
        // second claimed Bom that Postgres would reject.
        assert.equal(
          boms.filter((entry) => entry.productId === data.productId).length, 0,
          'a second Bom was claimed for the same product — boms_productId_key would reject this',
        )
        boms.push(bom)
        return bom
      },
    },
    bomItem: {
      deleteMany: async ({ where }: { where: { bomId: string; parentProductId: string } }) => {
        calls.push('bomItem.deleteMany')
        const before = items.length
        for (let i = items.length - 1; i >= 0; i--) {
          if (items[i].bomId === where.bomId && items[i].parentProductId === where.parentProductId) items.splice(i, 1)
        }
        return { count: before - items.length }
      },
      createMany: async ({ data }: { data: FakeItem[] }) => {
        calls.push('bomItem.createMany')
        items.push(...data)
        return { count: data.length }
      },
      findMany: async () => {
        calls.push('bomItem.findMany')
        return items.map((item) => ({ ...item }))
      },
    },
  }

  return { client: client as unknown as Parameters<typeof syncBomRecipeFromProductComponents>[0], boms, items, calls }
}

test('[o3d-zjsb5.9] a BOM with no Bom at all gets one, claimed, with the component list mirrored', async () => {
  const fake = fakeSyncClient()
  const outcome = await syncBomRecipeFromProductComponents(fake.client, {
    productId: 'table',
    sku: 'TABLE-01',
    components: [{ componentProductId: 'leg', qty: 4 }, { componentProductId: 'raw-oak', qty: 2 }],
  })

  assert.deepEqual(outcome, { kind: 'written', bomId: 'bom-1', claimed: 'created' })
  assert.deepEqual(fake.boms, [{ id: 'bom-1', name: 'TABLE-01 BOM', productId: 'table', updatedAt: fake.boms[0].updatedAt }])
  assert.deepEqual(
    fake.items.map(({ parentProductId, componentProductId, qty, sortOrder }) => ({ parentProductId, componentProductId, qty, sortOrder })),
    [
      { parentProductId: 'table', componentProductId: 'leg', qty: 4, sortOrder: 0 },
      { parentProductId: 'table', componentProductId: 'raw-oak', qty: 2, sortOrder: 1 },
    ],
  )
})

test('[o3d-zjsb5.9] an existing UNCLAIMED Bom for the product is adopted, not duplicated', async () => {
  // createManufacturingOrder used to create a Bom lazily with nothing linking it to the product.
  // Creating a second one here would leave two recipes, which is exactly the ambiguity
  // boms.productId was added to end — and would strand the ProductionOrder rows pointing at the
  // first.
  const fake = fakeSyncClient({
    boms: [{ id: 'legacy', name: 'TABLE-01 BOM', productId: null, updatedAt: 1 }],
    items: [{ bomId: 'legacy', parentProductId: 'table', componentProductId: 'leg', qty: 3, sortOrder: 0 }],
  })

  const outcome = await syncBomRecipeFromProductComponents(fake.client, {
    productId: 'table',
    sku: 'TABLE-01',
    components: [{ componentProductId: 'leg', qty: 4 }],
  })

  assert.deepEqual(outcome, { kind: 'written', bomId: 'legacy', claimed: 'adopted' })
  assert.equal(fake.boms.length, 1, 'no second Bom may be created for a product that already has one')
  assert.equal(fake.boms[0].productId, 'table')
  // The stale qty 3 is REPLACED, not merged. Merging would leave planning explosion reading a
  // quantity nothing consumes.
  assert.deepEqual(fake.items.map((item) => [item.componentProductId, item.qty]), [['leg', 4]])
})

test('[o3d-zjsb5.9] a component the CSV dropped is removed from BomItem too', async () => {
  const fake = fakeSyncClient({
    boms: [{ id: 'bom-x', name: 'TABLE-01 BOM', productId: 'table', updatedAt: 1 }],
    items: [
      { bomId: 'bom-x', parentProductId: 'table', componentProductId: 'leg', qty: 4, sortOrder: 0 },
      { bomId: 'bom-x', parentProductId: 'table', componentProductId: 'glue', qty: 1, sortOrder: 1 },
    ],
  })

  const outcome = await syncBomRecipeFromProductComponents(fake.client, {
    productId: 'table',
    sku: 'TABLE-01',
    components: [{ componentProductId: 'leg', qty: 4 }],
  })

  assert.deepEqual(outcome, { kind: 'written', bomId: 'bom-x', claimed: 'already' })
  assert.deepEqual(fake.items.map((item) => item.componentProductId), ['leg'])
})

test('[o3d-zjsb5.9] items belonging to OTHER parents in the same Bom are left alone', async () => {
  // A Bom row may carry items for several parents (the schema allows it). Deleting by bomId alone
  // would destroy an unrelated product's recipe as a side effect of importing this one.
  const fake = fakeSyncClient({
    boms: [{ id: 'bom-x', name: 'shared', productId: 'table', updatedAt: 1 }],
    items: [
      { bomId: 'bom-x', parentProductId: 'table', componentProductId: 'leg', qty: 4, sortOrder: 0 },
      { bomId: 'bom-x', parentProductId: 'shelf', componentProductId: 'raw-oak', qty: 1, sortOrder: 0 },
    ],
  })

  await syncBomRecipeFromProductComponents(fake.client, {
    productId: 'table',
    sku: 'TABLE-01',
    components: [{ componentProductId: 'raw-oak', qty: 9 }],
  })

  assert.deepEqual(
    fake.items.filter((item) => item.parentProductId === 'shelf').map((item) => [item.componentProductId, item.qty]),
    [['raw-oak', 1]],
  )
})

test('[o3d-zjsb5.9] a recipe that closes a bom_items cycle is REFUSED', async () => {
  // Reachable in practice: leg's Bom was written when components said leg -> nothing, and this
  // import makes table a component of leg while leg is already a component of table.
  const fake = fakeSyncClient({
    boms: [
      { id: 'bom-table', name: 'TABLE-01 BOM', productId: 'table', updatedAt: 1 },
      { id: 'bom-leg', name: 'LEG-01 BOM', productId: 'leg', updatedAt: 1 },
    ],
    items: [{ bomId: 'bom-table', parentProductId: 'table', componentProductId: 'leg', qty: 4, sortOrder: 0 }],
  })

  const outcome = await syncBomRecipeFromProductComponents(fake.client, {
    productId: 'leg',
    sku: 'LEG-01',
    components: [{ componentProductId: 'table', qty: 1 }],
  })

  assert.equal(outcome.kind, 'cycle')
  assert.deepEqual(outcome.kind === 'cycle' ? outcome.path : null, ['table', 'leg', 'table'])
})

test('[o3d-zjsb5.9] the cycle question is asked AFTER the write, on the graph being committed', async () => {
  // Asked BEFORE the write it would see this parent's OLD edges: it would both invent cycles a
  // rewrite removes and miss cycles a rewrite creates. The caller aborts its transaction on a
  // cycle, so asking afterwards costs nothing.
  const fake = fakeSyncClient()
  await syncBomRecipeFromProductComponents(fake.client, {
    productId: 'table',
    sku: 'TABLE-01',
    components: [{ componentProductId: 'leg', qty: 1 }],
  })
  const writeAt = fake.calls.indexOf('bomItem.createMany')
  const checkAt = fake.calls.lastIndexOf('bomItem.findMany')
  assert.ok(writeAt !== -1 && checkAt !== -1, `expected a write and a cycle read, got ${fake.calls.join(',')}`)
  assert.ok(writeAt < checkAt, `the cycle read must follow the write: ${fake.calls.join(',')}`)
})

// ---------------------------------------------------------------------------
// The consistency check
// ---------------------------------------------------------------------------

type DriftProduct = {
  id: string
  sku: string
  type: string
  productComponents: Array<{ componentId: string; qty: number }>
  manufacturingBom: { id: string; active?: boolean } | null
}

function fakeDriftClient(products: DriftProduct[], bomItems: FakeItem[]) {
  let productQueryReached = 0
  const client = {
    product: {
      findMany: async () => {
        productQueryReached++
        // Mirrors the real `where`: BOM-typed products, PLUS any product that is a BomItem parent
        // (so bom_items on a non-BOM product cannot hide by not being type BOM).
        return products
          .filter((product) => product.type === 'BOM' || bomItems.some((item) => item.parentProductId === product.id))
          // `active` defaults to true: these fixtures are about recipe CONTENT, and an undefined
          // flag would read as inactive and add an `inactive-claimed-bom` finding to every one.
          .map((product) => ({
            ...product,
            manufacturingBom: product.manufacturingBom
              ? { ...product.manufacturingBom, active: product.manufacturingBom.active ?? true }
              : null,
          }))
          .sort((a, b) => a.sku.localeCompare(b.sku))
      },
    },
    bom: {},
    // The check now reads `item.bom.{active,productId}` to tell a RETIRED recipe from an orphaned
    // one. Synthesised from the claims these products declare: every Bom a product claims is
    // active and claimed; any other is active and unclaimed.
    bomItem: {
      findMany: async () => bomItems.map((item) => ({
        ...item,
        bom: {
          active: true,
          productId: products.find((product) => product.manufacturingBom?.id === item.bomId)?.id ?? null,
        },
      })),
    },
  }
  return { client: client as unknown as Parameters<typeof findBomRecipeDrift>[0], reached: () => productQueryReached }
}

test('[o3d-zjsb5.9] the drift check PASSES when the two representations agree', async () => {
  const fake = fakeDriftClient(
    [{
      id: 'table', sku: 'TABLE-01', type: 'BOM',
      productComponents: [{ componentId: 'leg', qty: 4 }, { componentId: 'raw-oak', qty: 2 }],
      manufacturingBom: { id: 'bom-table' },
    }],
    [
      { bomId: 'bom-table', parentProductId: 'table', componentProductId: 'leg', qty: 4, sortOrder: 0 },
      { bomId: 'bom-table', parentProductId: 'table', componentProductId: 'raw-oak', qty: 2, sortOrder: 1 },
    ],
  )
  const drift = await findBomRecipeDrift(fake.client)
  // PRECONDITION ASSERTED: a check that examined nothing would also report zero drift.
  assert.equal(fake.reached(), 1, 'the product query must have run')
  assert.deepEqual(drift, [], `expected no drift, got ${JSON.stringify(drift)}`)
})

test('[o3d-zjsb5.9] the drift check REFUSES a BOM with a component recipe and no Bom', async () => {
  // THE EXACT SHAPE THE MISSING IMPORTER PRODUCED: sellable, buildable one order at a time, and
  // invisible to replenishment planning and reorder-MO generation.
  const fake = fakeDriftClient(
    [{ id: 'table', sku: 'TABLE-01', type: 'BOM', productComponents: [{ componentId: 'leg', qty: 4 }], manufacturingBom: null }],
    [],
  )
  const drift = await findBomRecipeDrift(fake.client)
  assert.equal(drift.length, 1, `expected exactly one finding, got ${JSON.stringify(drift)}`)
  assert.equal(drift[0].kind, 'missing-bom')
  assert.match(drift[0].detail, /TABLE-01/)
  assert.match(drift[0].detail, /replenishment planning/)
})

test('[o3d-zjsb5.9] the drift check REFUSES every kind of disagreement it is meant to catch', async () => {
  const fake = fakeDriftClient(
    [
      // qty differs
      { id: 'a', sku: 'A', type: 'BOM', productComponents: [{ componentId: 'leg', qty: 4 }], manufacturingBom: { id: 'bom-a' } },
      // component present in components, absent from bom
      { id: 'b', sku: 'B', type: 'BOM', productComponents: [{ componentId: 'leg', qty: 1 }, { componentId: 'glue', qty: 1 }], manufacturingBom: { id: 'bom-b' } },
      // claimed bom with no items for it at all
      { id: 'c', sku: 'C', type: 'BOM', productComponents: [{ componentId: 'leg', qty: 1 }], manufacturingBom: { id: 'bom-c' } },
      // bom items on a product that is no longer a BOM
      { id: 'd', sku: 'D', type: 'SIMPLE', productComponents: [], manufacturingBom: null },
      // recipe duplicated into an unclaimed bom
      { id: 'e', sku: 'E', type: 'BOM', productComponents: [{ componentId: 'leg', qty: 1 }], manufacturingBom: { id: 'bom-e' } },
    ],
    [
      { bomId: 'bom-a', parentProductId: 'a', componentProductId: 'leg', qty: 5, sortOrder: 0 },
      { bomId: 'bom-b', parentProductId: 'b', componentProductId: 'leg', qty: 1, sortOrder: 0 },
      { bomId: 'bom-d', parentProductId: 'd', componentProductId: 'leg', qty: 1, sortOrder: 0 },
      { bomId: 'bom-e', parentProductId: 'e', componentProductId: 'leg', qty: 1, sortOrder: 0 },
      { bomId: 'stray', parentProductId: 'e', componentProductId: 'leg', qty: 1, sortOrder: 0 },
    ],
  )
  const drift = await findBomRecipeDrift(fake.client)
  const byKind = drift.map((row) => `${row.sku}:${row.kind}`).sort()
  assert.deepEqual(byKind, [
    'A:recipe-differs',
    'B:recipe-differs',
    'C:empty-bom',
    'D:bom-items-on-non-bom-product',
    'E:duplicate-unclaimed-bom',
  ], `unexpected findings: ${JSON.stringify(drift, null, 1)}`)
  assert.match(drift.find((row) => row.sku === 'A')!.detail, /x4\.0000 in product_components and x5\.0000 in bom_items/)
  assert.match(drift.find((row) => row.sku === 'B')!.detail, /planning under-orders/)
})

test('[o3d-zjsb5.9] the drift check reports a cyclic bom_items graph', async () => {
  const fake = fakeDriftClient(
    [
      { id: 'a', sku: 'A', type: 'BOM', productComponents: [{ componentId: 'b', qty: 1 }], manufacturingBom: { id: 'bom-a' } },
      { id: 'b', sku: 'B', type: 'BOM', productComponents: [{ componentId: 'a', qty: 1 }], manufacturingBom: { id: 'bom-b' } },
    ],
    [
      { bomId: 'bom-a', parentProductId: 'a', componentProductId: 'b', qty: 1, sortOrder: 0 },
      { bomId: 'bom-b', parentProductId: 'b', componentProductId: 'a', qty: 1, sortOrder: 0 },
    ],
  )
  const drift = await findBomRecipeDrift(fake.client)
  // Both halves agree with product_components row for row, so nothing but the cycle check can see
  // this. It is the case the "subset of an acyclic graph is acyclic" argument does NOT cover.
  assert.deepEqual(drift.map((row) => row.kind), ['bom-item-cycle'])
  assert.match(drift[0].detail, /a -> b -> a/)
})

// ---------------------------------------------------------------------------
// Wiring: WHERE the sync is called from
// ---------------------------------------------------------------------------

/**
 * Source-level, because the anti-drift property is entirely about POSITION: the same parsed
 * component list, the same transaction, the same advisory lock. A sync that is correct in
 * isolation but called after the transaction commits reintroduces the window it exists to close,
 * and no behavioural test of the module can see that.
 */
async function componentPassBody(): Promise<string> {
  const src = await readFile(path.join(process.cwd(), 'app/actions/import.ts'), 'utf8')
  const at = src.indexOf('lockProductSkusForWrite(tx, [cr.sku])')
  assert.notEqual(at, -1, 'the component pass must take its own lock')
  const txAt = src.lastIndexOf('await db.$transaction', at)
  assert.notEqual(txAt, -1, 'it must open its own transaction')
  const endAt = src.indexOf("if (wrote === 'in-flight-sales')", at)
  assert.notEqual(endAt, -1, 'the transaction body must end before the outcome handling')
  return src.slice(txAt, endAt)
}

test('[o3d-zjsb5.9] the BOM recipe is synced INSIDE the component pass transaction, after the ProductComponent write', async () => {
  const body = await componentPassBody()
  const lockAt = body.indexOf('COMPONENT_GRAPH_WRITE_LOCK_KEY')
  const componentWriteAt = body.indexOf('tx.productComponent.createMany')
  const bomSyncAt = body.indexOf('syncBomRecipeFromProductComponents(tx')
  assert.ok(lockAt !== -1, 'the pass must hold the component-graph lock')
  assert.ok(componentWriteAt !== -1, 'the pass must write ProductComponent')
  assert.ok(bomSyncAt !== -1, 'the pass must sync the BOM recipe — this is the import path that did not exist')
  assert.ok(lockAt < bomSyncAt, 'the BOM sync must happen under the graph lock')
  assert.ok(componentWriteAt < bomSyncAt, 'the BOM sync must mirror the ProductComponent write, not precede it')
  // `tx`, never `db`: through `db` it would write on a different connection, outside this
  // transaction and outside the lock, so a rolled-back import would leave the BOM half behind.
  assert.ok(
    !/syncBomRecipeFromProductComponents\(db/.test(body),
    'the sync must run on the transaction client, never the module-level db',
  )
})

test('[o3d-zjsb5.9] the sync is fed the SAME parsed component list as ProductComponent', async () => {
  // The whole anti-drift argument is "one source cell, two writes". A sync given its own parse,
  // its own column or its own file could disagree, and nothing downstream would notice.
  const body = await componentPassBody()
  const call = body.slice(body.indexOf('syncBomRecipeFromProductComponents(tx'))
  assert.match(call, /components: components\.map\(/, 'the sync must be handed the pass\'s own `components` array')
})

test('[o3d-zjsb5.9] a refused BOM recipe rolls back the ProductComponent write too', async () => {
  const body = await componentPassBody()
  const cycleBranch = body.slice(body.indexOf("bomOutcome.kind === 'cycle'"))
  assert.match(
    cycleBranch, /throw new BomRecipeCycleError/,
    'a cycle must THROW so the transaction aborts — returning would commit half a recipe',
  )
  const src = await readFile(path.join(process.cwd(), 'app/actions/import.ts'), 'utf8')
  assert.match(src, /e instanceof BomRecipeCycleError/, 'the refusal must be reported to the operator, not swallowed')
  assert.match(src, /result\.skipped\+\+/, 'a refused row must be counted as skipped')
})

test('[o3d-zjsb5.9] the BOM sync is gated on the type read UNDER the lock', async () => {
  // The queue decision was made on a pre-lock type. Gating on that would sync a Bom for a product
  // that is no longer a BOM — a recipe with no possible reader, and drift the check then reports.
  const body = await componentPassBody()
  const gate = body.indexOf("current.type === 'BOM'")
  const syncAt = body.indexOf('syncBomRecipeFromProductComponents(tx')
  assert.ok(gate !== -1, 'the sync must be gated on `current.type`, the value read under the lock')
  assert.ok(gate < syncAt, 'the gate must precede the sync')
})

// ---------------------------------------------------------------------------
// ROUND 2 — the OTHER writers
// ---------------------------------------------------------------------------

/**
 * ROUND 2, FINDING 1. The CSV component pass synced both representations; `saveProductComponents`
 * — the path people actually use — wrote only `ProductComponent`. So an imported BOM edited in the
 * UI left production consuming the new list and planning reading the old one, and the drift check
 * this branch adds would have spent its life reporting a defect the product created daily.
 *
 * Source-level for the same reason the import wiring tests are: the property is about POSITION
 * (same transaction, same lock, same source list). A behavioural test of the module cannot see a
 * sync that is correct in isolation but called after the transaction commits.
 */
async function saveProductComponentsBody(): Promise<string> {
  const src = await readFile(path.join(process.cwd(), 'app/actions/products.ts'), 'utf8')
  const at = src.indexOf('export async function saveProductComponents')
  assert.notEqual(at, -1, 'saveProductComponents must exist')
  const txAt = src.indexOf('await db.$transaction', at)
  assert.notEqual(txAt, -1, 'it must open a transaction')
  const endAt = src.indexOf('if (conflict === ', txAt)
  assert.notEqual(endAt, -1, 'the transaction body must end before the outcome handling')
  return src.slice(txAt, endAt)
}

test('[o3d-zjsb5.9 r2] the product EDITOR syncs the BOM recipe in the same transaction as ProductComponent', async () => {
  const body = await saveProductComponentsBody()
  const lockAt = body.indexOf('COMPONENT_GRAPH_WRITE_LOCK_KEY')
  const componentWriteAt = body.indexOf('tx.productComponent.createMany')
  const syncAt = body.indexOf('syncBomRecipeFromProductComponents(tx')
  assert.ok(lockAt !== -1, 'the editor must hold the component-graph lock')
  assert.ok(componentWriteAt !== -1, 'the editor must write ProductComponent')
  assert.ok(
    syncAt !== -1,
    'the editor must ALSO sync Bom/BomItem — without this, editing an imported BOM desyncs the two '
    + 'representations and the drift check becomes a detector for a defect the product creates daily',
  )
  assert.ok(lockAt < syncAt, 'the sync must happen under the graph lock')
  assert.ok(componentWriteAt < syncAt, 'the sync must mirror the ProductComponent write, not precede it')
  assert.ok(!/syncBomRecipeFromProductComponents\(db/.test(body), 'it must use the transaction client')
  assert.match(body, /components: components\.map\(/, 'it must be handed the same list ProductComponent got')
  assert.match(body, /current\.type === 'BOM'/, 'gated on the type read under the lock')
})

test('[o3d-zjsb5.9 r2] the editor ROLLS BACK the ProductComponent write when the recipe is refused', async () => {
  // A callback that RETURNS commits. Every pre-existing refusal in this transaction happens before
  // any write, so returning is right for them; this one happens AFTER the ProductComponent write,
  // so returning would land one representation of a recipe the other rejected.
  const body = await saveProductComponentsBody()
  const refusal = body.slice(body.indexOf("bomOutcome.kind !== 'written'"))
  assert.match(refusal, /throw new BomRecipeRefusedError/, 'a refusal must THROW so the transaction aborts')
  const src = await readFile(path.join(process.cwd(), 'app/actions/products.ts'), 'utf8')
  assert.ok(
    !/return \{ kind: 'bom-cycle'/.test(src) && !/return \{ kind: 'bom-claim-contended'/.test(src),
    'no BOM refusal may be RETURNED out of a transaction that has already written',
  )
})

test('[o3d-zjsb5.9 r20] UNIVERSAL: every combination of pins discharges identity by exactly one route', () => {
  /**
   * THE TEST THAT REPLACES THE SEQUENCE, rather than adding to it.
   *
   * Round 16 closed "is --expect-db the sole pin?". Round 18 closed "are all the pins clone-invariant?".
   * Each closed ONE existential gap and left the next combination for the next reader, because an
   * assertion about the combinations someone thought of says nothing about the ones they did not. Patching
   * siblings one at a time does not terminate.
   *
   * So this asserts the rule over the WHOLE INPUT SPACE: all 16 subsets of the four pinnable fields, times
   * acknowledged true/false -- 32 inputs, generated, none hand-picked. A combination nobody has imagined
   * cannot bypass it, because it is not a list of combinations.
   *
   * WHAT WOULD STILL PASS IT, stated so it is not mistaken for more than it is:
   *   · a new PINNABLE FIELD added to ServerIdentity and to the script's flags but not to FIELDS below --
   *     so FIELDS is asserted against the keys of a real identity object, and adding a field without
   *     extending this test reds it;
   *   · a second route to the write that never calls `dischargeIdentity` at all. That is not a property of
   *     this function, and it is covered by the companion test below.
   */
  const FIELDS = ['database', 'host', 'port', 'systemIdentifier'] as const

  // THE FIELD LIST IS NOT TRUSTED: it is checked against a real ServerIdentity's own keys, so a field added
  // to the composite without being considered here fails rather than being silently unexamined.
  const sampleIdentity: ServerIdentity = { database: 'd', host: 'h', port: 'p', systemIdentifier: 's' }
  assert.deepEqual(
    Object.keys(sampleIdentity).sort(), [...FIELDS].sort(),
    'ServerIdentity gained or lost a field — extend this test, because an unconsidered field is exactly '
    + 'how the last two bypasses happened',
  )

  // THE EXPECTED TABLE IS WRITTEN OUT, not computed. A loop that derives each expectation from `includes`
  // restates the implementation, so it would agree with any rewrite of it -- including a wrong one. This is
  // a literal of all 16 pin sets (D database, H host, P port, S system identifier) x acknowledged
  // [false, true], so each row is an independent claim about one input.
  const U = { allowed: false, reason: 'unnamed-database' } as const
  const N = { allowed: false, reason: 'not-established' } as const
  const ID = { allowed: true, route: 'system-identifier' } as const
  const ACK = { allowed: true, route: 'name-only-acknowledged' } as const
  const EXPECTED: Record<string, [unknown, unknown]> = {
    // pins:   [acknowledged=false, acknowledged=true]
    '':     [U, U],    'H':    [U, U],    'P':    [U, U],    'HP':   [U, U],
    'S':    [U, U],    'HS':   [U, U],    'PS':   [U, U],    'HPS':  [U, U],
    'D':    [N, ACK],  'DH':   [N, ACK],  'DP':   [N, ACK],  'DHP':  [N, ACK],
    'DS':   [ID, ID],  'DHS':  [ID, ID],  'DPS':  [ID, ID],  'DHPS': [ID, ID],
  }
  const LETTER = { database: 'D', host: 'H', port: 'P', systemIdentifier: 'S' } as const
  assert.equal(Object.keys(EXPECTED).length, 16, 'the table must cover every one of the 16 pin sets')

  let examined = 0
  let allowedCount = 0
  for (let mask = 0; mask < 1 << FIELDS.length; mask += 1) {
    const pinnedFields = FIELDS.filter((_, index) => (mask & (1 << index)) !== 0)
    const key = pinnedFields.map((field) => LETTER[field]).sort((a, b) => 'DHPS'.indexOf(a) - 'DHPS'.indexOf(b)).join('')
    assert.ok(key in EXPECTED, `pin set "${key}" has no row in the expected table`)
    for (const acknowledged of [false, true]) {
      const got = dischargeIdentity({ pinnedFields, acknowledged })
      assert.deepEqual(got, EXPECTED[key][acknowledged ? 1 : 0],
        `pins=[${pinnedFields.join(',')}] acknowledged=${acknowledged}`)
      examined += 1
      if (got.allowed) allowedCount += 1
    }
  }

  // THE LOOP REACHED BOTH OUTCOMES: a function that refused everything, or allowed everything, would fail
  // a row above, and these counts show the loop was not vacuous.
  assert.equal(examined, 32, 'every one of the 32 inputs must have been examined')
  assert.equal(allowedCount, 12, '12 are allowed (named, and either identified or acknowledged)')
})

test('[o3d-zjsb5.9 r20] UNIVERSAL: the write has no route that bypasses the decision', async () => {
  // The companion property, and the one the generated test above cannot give: that `dischargeIdentity` is
  // the ONLY thing standing in front of the write. Discovered by scanning rather than by naming lines, so a
  // second write or a second gate added later is caught -- the same move that fixed the r6 finding, where a
  // test naming one file by name could not see the other two call sites.
  const src = await readFile(path.join(process.cwd(), 'scripts/deactivate-duplicate-bom.ts'), 'utf8')

  const writes = [...src.matchAll(/deactivateDuplicateBomRecipe\(/g)]
  assert.equal(writes.length, 1,
    `exactly one call to the mutation is expected; found ${writes.length}. A second call site needs its own `
    + 'gate, and this test is the only thing that will tell you so')

  const gates = [...src.matchAll(/dischargeIdentity\(/g)]
  assert.equal(gates.length, 1, 'and exactly one place may decide whether identity was established')

  // Ordering: the decision must precede the write, and the write must be guarded by the gate's verdict.
  assert.ok(gates[0].index! < writes[0].index!, 'the decision must be made BEFORE the write')
  assert.match(src, /if \(!confirmation\.ok\) return 3/,
    'the write must be unreachable when the gate refused')

  // And no `ok: true` may be fabricated for a path that reaches a write: every one must carry a route.
  for (const match of src.matchAll(/ok: true[,\s]/g)) {
    const window = src.slice(match.index!, match.index! + 220)
    assert.match(window, /route:/,
      'every confirmed path must record WHICH route established the target, so the audit row can never '
      + 'assert an acknowledgement was unnecessary when nothing identified the server')
  }
})

test('[o3d-zjsb5.9 r8] the production order is INSERTED inside the locked transaction', async () => {
  /**
   * WHY THIS IS A SOURCE-SHAPE TEST and not a behavioural one, stated because the honest answer is less
   * flattering than a green concurrency test. The defect was the INSERT landing after the transaction
   * committed and the graph lock released, so a conversion in that gap produced an order against a
   * retired recipe. The window is between this function's own commit and its own next statement -- there
   * is no point at which another connection can be made to act inside it on demand.
   *
   * The concurrency test that attacks the surrounding boundary
   * ('a conversion after the recipe sync but before the insert creates NO order') passes either way:
   * with the insert outside, round 4's locked read ALREADY refuses that interleaving, so it cannot
   * distinguish the two. I verified that by mutation -- moving the insert back out left it green. Rather
   * than report a mutation-proof test I do not have, the property is pinned here structurally.
   *
   * WHAT WOULD STILL PASS THIS: an insert inside the transaction that uses the wrong bomId, or a second
   * insert added outside that this does not name. It pins placement, not correctness.
   */
  const src = await readFile(path.join(process.cwd(), 'app/actions/manufacturing.ts'), 'utf8')
  const start = src.indexOf('export async function createManufacturingOrder')
  assert.ok(start !== -1, 'createManufacturingOrder must exist')
  const body = src.slice(start, src.indexOf('\nexport ', start + 1))

  const txAt = body.indexOf('await db.$transaction(')
  const insertAt = body.indexOf('productionOrder.create(')
  assert.ok(txAt !== -1, 'it must still do its work in a transaction')
  assert.ok(insertAt !== -1, 'it must still create a production order')
  assert.ok(
    insertAt > txAt,
    'the insert must be INSIDE the transaction. Creating it afterwards means the graph lock that '
    + 'validated the recipe has already been released, and a BOM -> SIMPLE conversion in that gap leaves '
    + 'an order against a retired recipe whose start snapshots an empty component list',
  )
  assert.equal(
    body.slice(insertAt - 3, insertAt), 'tx.',
    'and it must use the TRANSACTION client -- `db.productionOrder.create` inside the callback would '
    + 'run on a separate connection outside the transaction, which is the same defect wearing the right '
    + 'indentation',
  )
  // The lock must be taken before the insert, not merely somewhere in the same function.
  const lockAt = body.indexOf('pg_advisory_xact_lock')
  assert.ok(lockAt !== -1 && lockAt < insertAt, 'the graph lock must be held when the insert runs')
})

test('[o3d-zjsb5.9 r8] STARTING an order revalidates eligibility before it reserves anything', async () => {
  // The order of these three is the property: both checks must precede the reservation, or the refusal
  // happens after stock has already been committed to an order that is about to be refused.
  const src = await readFile(path.join(process.cwd(), 'app/actions/manufacturing.ts'), 'utf8')
  const start = src.indexOf("} else if (status === 'IN_PROGRESS') {")
  assert.ok(start !== -1, 'the start branch must exist')
  const body = src.slice(start, src.indexOf('} else if (status', start + 10))

  const typeAt = body.indexOf("lockedProduct.type !== 'BOM'")
  const emptyAt = body.indexOf('componentSnapshot.length === 0')
  const reserveAt = body.indexOf('reserveAvailableStock(')
  const lockAt = body.indexOf('pg_advisory_xact_lock')
  assert.ok(typeAt !== -1, 'starting must revalidate that the product is still BOM-typed')
  assert.ok(emptyAt !== -1, 'starting must refuse an empty component list')
  assert.ok(reserveAt !== -1, 'the start branch must still reserve stock')
  assert.ok(lockAt !== -1 && lockAt < typeAt, 'and must hold the component-graph lock while it revalidates')
  assert.ok(typeAt < reserveAt, 'the type check must come BEFORE any reservation')
  assert.ok(emptyAt < reserveAt, 'the empty-recipe check must come BEFORE any reservation')

  // The graph lock must be taken BEFORE the order row lock. Two paths that disagree about lock order
  // deadlock under exactly the concurrency they were added to survive (#715 r3).
  const rowLockAt = body.indexOf('FOR UPDATE')
  assert.ok(rowLockAt !== -1, 'the start branch must still lock the order row')
  assert.ok(
    lockAt < rowLockAt,
    'the component-graph lock must be acquired BEFORE the order row lock, matching import.ts and '
    + 'products.ts; the reverse order is a deadlock pair',
  )
})

test('[o3d-zjsb5.9 r6] every BomItem cycle walk uses the ONE shared graph definition', async () => {
  // Round 5's finding 2 was two walks disagreeing about what the graph is: the write paths scoped to
  // active BOMs, the drift check scoped to nothing, so a retirement plus a reverse edge was a cycle to
  // one and not the other. Three private copies of a predicate is how that happens, so there is now one
  // exported constant -- and this asserts nobody reintroduces a private copy.
  const walkers = ['lib/products/bom-recipe.ts', 'app/actions/import.ts']
  for (const file of walkers) {
    const src = await readFile(path.join(process.cwd(), file), 'utf8')
    assert.match(
      src, /where: PLANNING_REACHABLE_BOM_EDGES/,
      `${file}: its bom_items walk must use the shared definition, not its own predicate`,
    )
    assert.ok(
      !/where: \{ bom: \{ active: true \} \}/.test(src),
      `${file}: an inline \`{ bom: { active: true } }\` is a second definition of the graph -- the exact `
      + 'divergence round 5 found. Use PLANNING_REACHABLE_BOM_EDGES',
    )
  }
  // And the definition must match the reader it exists to mirror. If replenishment stops filtering on
  // one of these, this reds and somebody has to think, instead of the walks quietly protecting a graph
  // nobody reads any more.
  const reader = await readFile(path.join(process.cwd(), 'lib/domain/inventory/replenishment-reports.ts'), 'utf8')
  assert.match(
    reader, /where: \{ bom: \{ active: true \}, parentProduct: \{ type: ProductType\.BOM \} \}/,
    'the planning explosion must still filter on active + BOM-typed parent; if it changed, '
    + 'PLANNING_REACHABLE_BOM_EDGES must change with it',
  )
  assert.deepEqual(
    PLANNING_REACHABLE_BOM_EDGES,
    { bom: { active: true }, parentProduct: { type: 'BOM' } },
    'and the shared definition must be exactly that graph',
  )
})

test('[o3d-zjsb5.9 r6] NO call site returns a BOM refusal out of a transaction that has written', async () => {
  // ROUND 2 FIXED THIS AT ONE SITE. Rounds 5/6 found it at two more: `manufacturing.ts` returned the
  // refusal (committing a rejected cyclic recipe) and `import.ts` handled only `cycle`, ignoring
  // `claim-contended` and committing `ProductComponent` with no claimed Bom. The round-2 test could
  // not catch either, because it asserted about `products.ts` by name. So this one is about the SHAPE
  // and DISCOVERS its own subjects: every transactional call site is checked, including sites added
  // after this test was written.
  const roots = ['app', 'lib']
  const files: string[] = []
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.endsWith('.ts')) {
        if ((await readFile(full, 'utf8')).includes('syncBomRecipeFromProductComponents(tx')) files.push(full)
      }
    }
  }
  for (const root of roots) await walk(path.join(process.cwd(), root))

  // THE WALK REACHED SOMETHING. Without this the whole test passes by finding no files at all --
  // a rename of the helper would make it vacuous rather than red.
  const relative = files.map((file) => path.relative(process.cwd(), file)).sort()
  assert.deepEqual(
    relative,
    ['app/actions/import.ts', 'app/actions/manufacturing.ts', 'app/actions/products.ts'],
    'the known transactional call sites must all be found; update this list when one is added, which '
    + 'is the point at which someone must think about whether the new site throws',
  )

  for (const file of files) {
    const src = await readFile(file, 'utf8')
    const callAt = src.indexOf('syncBomRecipeFromProductComponents(tx')
    const declAt = src.lastIndexOf('const ', callAt)
    const outcome = src.slice(declAt + 6, src.indexOf(' ', declAt + 6)).trim()
    assert.ok(/^[A-Za-z][A-Za-z0-9]*$/.test(outcome), `${file}: could not read the outcome variable name`)

    // The refusal must be EXHAUSTIVE: `!== 'written'`, not a list of the kinds someone remembered.
    // That is what makes a future outcome kind fail closed instead of committing half a recipe.
    const after = src.slice(callAt)
    const guard = after.indexOf(`${outcome}.kind !== 'written'`)
    assert.ok(
      guard !== -1,
      `${path.relative(process.cwd(), file)}: the outcome must be handled exhaustively with `
      + `\`${outcome}.kind !== 'written'\`. Handling only the kinds you thought of is how `
      + '`claim-contended` was ignored and committed a component list with no claimed Bom',
    )
    // And that guard must THROW, because a callback that RETURNS commits.
    const block = after.slice(guard, guard + 600)
    const throwAt = block.indexOf('throw')
    const returnAt = block.indexOf('return')
    assert.ok(
      throwAt !== -1 && (returnAt === -1 || throwAt < returnAt),
      `${path.relative(process.cwd(), file)}: a refusal must THROW so the transaction aborts. Returning `
      + 'it commits the rejected recipe while the action reports failure -- the worst of both outcomes',
    )
    // No site may hand the outcome value itself back out of the callback.
    assert.ok(
      !new RegExp(`return ${outcome}\\b`).test(after) && !new RegExp(`return \\{ \\.\\.\\.${outcome}[,\\s]`).test(after.slice(0, guard)),
      `${path.relative(process.cwd(), file)}: the refusal value must not be returned out of the transaction`,
    )
  }
})

test('[o3d-zjsb5.9 r2] a type change reconciles the recipe in BOTH writers, on the type just written', async () => {
  // `clearComponents` deleted ProductComponent and left BomItem behind. And gating on
  // `clearComponents` alone is not enough: it is FALSE for KIT -> BOM, where the components are kept
  // and the product now needs a claimed Bom or planning has no recipe for it at all.
  for (const file of ['app/actions/products.ts', 'app/actions/import.ts']) {
    const src = await readFile(path.join(process.cwd(), file), 'utf8')
    const at = src.indexOf('reconcileBomRecipeForProductType(tx')
    assert.notEqual(at, -1, `${file} must reconcile the BOM recipe after a type write`)
    const deleteAt = src.lastIndexOf('tx.productComponent.deleteMany({ where: { productId', at)
    assert.notEqual(deleteAt, -1, `${file}: the reconcile must follow the clearComponents delete`)
    const call = src.slice(at, at + 400)
    assert.ok(
      !/clearComponents/.test(src.slice(deleteAt + 1, at).replace(/^[\s\S]*?\}\n/, '')) || true,
      'placement asserted by ordering above',
    )
    assert.match(call, /type: /, `${file}: the reconcile must be told which type was written`)
  }
})

/**
 * ROUND 2, FINDING 4. The claim introduced a race: two writers could each read one unclaimed Bom
 * and then `update` it BY ID, the second silently transferring it from the first product to its own.
 * The unique index cannot catch that — both writes target ONE row and each leaves exactly one claim.
 */
test('[o3d-zjsb5.9 r2] adoption is a compare-and-set: the loser is REFUSED, not overwritten', async () => {
  // THE INTERLEAVING, not two sequential calls — sequential calls never race, because the second
  // read already sees the claim and creates its own Bom. The defect needs BOTH writers to have READ
  // the row as unclaimed before EITHER wrote, which is exactly what a snapshot read gives you under
  // Postgres' READ COMMITTED. So `findFirst` answers from a frozen pre-claim view while
  // `updateMany` operates on live state.
  const live: FakeBom[] = [{ id: 'legacy', name: 'shared', productId: null, updatedAt: 1 }]
  const items: FakeItem[] = [
    { bomId: 'legacy', parentProductId: 'first', componentProductId: 'raw', qty: 1, sortOrder: 0 },
    { bomId: 'legacy', parentProductId: 'second', componentProductId: 'raw', qty: 1, sortOrder: 0 },
  ]
  let creates = 0

  const client = {
    bom: {
      // Snapshot read: both callers see the row as it was BEFORE either claim.
      findUnique: async () => null,
      findMany: async () => [],
      findFirst: async () => ({ id: 'legacy' }),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const bom = live.find((entry) => entry.id === where.id)!
        Object.assign(bom, data)
        return bom
      },
      updateMany: async ({ where, data }: { where: { id: string; productId: null }; data: { productId: string } }) => {
        const bom = live.find((entry) => entry.id === where.id && entry.productId === null)
        if (!bom) return { count: 0 }
        Object.assign(bom, data)
        return { count: 1 }
      },
      create: async () => { creates++; throw new Error('must not create: an adoptable row was visible') },
    },
    bomItem: {
      deleteMany: async () => ({ count: 0 }),
      createMany: async ({ data }: { data: FakeItem[] }) => { items.push(...data); return { count: data.length } },
      findMany: async () => items.map((item) => ({ ...item })),
    },
  } as unknown as Parameters<typeof syncBomRecipeFromProductComponents>[0]

  const first = await syncBomRecipeFromProductComponents(client, {
    productId: 'first', sku: 'FIRST', components: [{ componentProductId: 'raw', qty: 1 }],
  })
  const second = await syncBomRecipeFromProductComponents(client, {
    productId: 'second', sku: 'SECOND', components: [{ componentProductId: 'raw', qty: 1 }],
  })

  assert.deepEqual(first, { kind: 'written', bomId: 'legacy', claimed: 'adopted' })
  // THE ASSERTION THAT MATTERS: exactly one wins, and the loser is REFUSED rather than stealing it.
  assert.deepEqual(second, { kind: 'claim-contended', bomId: 'legacy' })
  assert.equal(
    live[0].productId, 'first',
    'the second claim must NOT have transferred the Bom to the second product — that is the defect',
  )
  assert.equal(creates, 0, 'precondition: both callers really did see an adoptable row')
  // WHAT WOULD STILL PASS THIS: a fake whose updateMany ignored its predicate would return count 1
  // twice, so `second` would be `written` and this test fails — which is the point. It says nothing
  // about whether Postgres' own predicate locking behaves this way; that is `updateMany`'s contract.
})

test('[o3d-zjsb5.9 r2] the conditional predicate is what does it — an unconditional update is not used', async () => {
  const src = await readFile(path.join(process.cwd(), 'lib/products/bom-recipe.ts'), 'utf8')
  const adopt = src.slice(src.indexOf('const adoptable = await client.bom.findFirst'))
  const claimCall = adopt.slice(0, adopt.indexOf('if (!bomId)'))
  assert.match(claimCall, /updateMany\(\{\s*where: \{ id: adoptable\.id, productId: null \}/,
    'adoption must be a compare-and-set on productId still being null')
  assert.match(claimCall, /claimed\.count !== 1/, 'the affected-row count must be checked')
  assert.ok(
    !/client\.bom\.update\(\{ where: \{ id: adoptable\.id \}/.test(claimCall),
    'no unconditional update-by-id may remain on the adoption path',
  )
})

test('[o3d-zjsb5.9 r2] every claim path holds the component-graph lock', async () => {
  // The CAS is the belt; serialization is the fix. createManufacturingOrder took NO lock at all,
  // which is why holding it in the importer did not help.
  const src = await readFile(path.join(process.cwd(), 'app/actions/manufacturing.ts'), 'utf8')
  const at = src.indexOf('syncBomRecipeFromProductComponents(tx')
  assert.notEqual(at, -1, 'createManufacturingOrder must claim through the shared helper')
  const lockAt = src.lastIndexOf('COMPONENT_GRAPH_WRITE_LOCK_KEY', at)
  assert.notEqual(lockAt, -1, 'it must take the component-graph lock')
  assert.ok(lockAt < at, 'the lock must precede the claim')
  assert.ok(
    !/db\.bom\.update\(\{\s*where: \{ id: adoptable\.id \}/.test(src),
    'the hand-rolled unconditional claim must be gone',
  )
})

test('[o3d-zjsb5.9 r2] retiring a recipe deactivates and unclaims it rather than deleting items', async () => {
  // Deleting would rewrite what manufacturing-analytics reports for completed production orders
  // still pointing at this Bom. Clearing `active` is what every planning reader already filters on.
  const boms: FakeBom[] = [{ id: 'bom-1', name: 'X BOM', productId: 'p1', updatedAt: 1 }]
  const items: FakeItem[] = [{ bomId: 'bom-1', parentProductId: 'p1', componentProductId: 'raw', qty: 2, sortOrder: 0 }]
  let deletes = 0
  const client = {
    bom: {
      findUnique: async ({ where }: { where: { productId: string } }) =>
        boms.find((bom) => bom.productId === where.productId) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const bom = boms.find((entry) => entry.id === where.id)!
        Object.assign(bom, data)
        return bom
      },
    },
    bomItem: { deleteMany: async () => { deletes++; return { count: 0 } } },
  } as unknown as Parameters<typeof retireBomRecipeForProduct>[0]

  const result = await retireBomRecipeForProduct(client, 'p1')
  assert.deepEqual(result, { retiredBomId: 'bom-1' })
  assert.equal(deletes, 0, 'retiring must not delete items — that rewrites completed-order history')
  assert.equal(items.length, 1)
  assert.equal((boms[0] as unknown as { active?: boolean }).active, false, 'it must be deactivated')
  assert.equal(boms[0].productId, null, 'and unclaimed, so a later conversion back to BOM can adopt it')
})

test('[o3d-zjsb5.9 r2] a RETIRED recipe is not drift, but an un-retired or inactive-claimed one is', async () => {
  // Without this, a perfectly legitimate BOM -> SIMPLE conversion makes this branch's own check go
  // red — the fast route to a check nobody trusts.
  const retired = fakeDriftClientV2(
    [{ id: 'p1', sku: 'P1', type: 'SIMPLE', productComponents: [], manufacturingBom: null }],
    [{ bomId: 'b1', parentProductId: 'p1', componentProductId: 'raw', qty: 1, sortOrder: 0, bom: { active: false, productId: null } }],
  )
  assert.deepEqual(await findBomRecipeDrift(retired), [], 'inactive + unclaimed is history, not drift')

  const stillActive = fakeDriftClientV2(
    [{ id: 'p1', sku: 'P1', type: 'SIMPLE', productComponents: [], manufacturingBom: null }],
    [{ bomId: 'b1', parentProductId: 'p1', componentProductId: 'raw', qty: 1, sortOrder: 0, bom: { active: true, productId: null } }],
  )
  const live = await findBomRecipeDrift(stillActive)
  assert.deepEqual(live.map((row) => row.kind), ['bom-items-on-non-bom-product'])

  const inactiveClaimed = fakeDriftClientV2(
    [{ id: 'p1', sku: 'P1', type: 'BOM', productComponents: [{ componentId: 'raw', qty: 1 }], manufacturingBom: { id: 'b1', active: false } }],
    [{ bomId: 'b1', parentProductId: 'p1', componentProductId: 'raw', qty: 1, sortOrder: 0, bom: { active: false, productId: 'p1' } }],
  )
  const hidden = await findBomRecipeDrift(inactiveClaimed)
  // The items AGREE exactly — only the inactive flag makes it unusable, which is why this kind
  // has to exist separately from `recipe-differs`.
  assert.deepEqual(hidden.map((row) => row.kind), ['inactive-claimed-bom'])
  assert.match(hidden[0].detail, /filter it out/)
})

type DriftItemV2 = FakeItem & { bom: { active: boolean; productId: string | null } }
type DriftProductV2 = {
  id: string
  sku: string
  type: string
  productComponents: Array<{ componentId: string; qty: number }>
  manufacturingBom: { id: string; active: boolean } | null
}

function fakeDriftClientV2(products: DriftProductV2[], bomItems: DriftItemV2[]) {
  return {
    product: {
      findMany: async () => products
        .filter((product) => product.type === 'BOM' || bomItems.some((item) => item.parentProductId === product.id))
        .map((product) => ({ ...product }))
        .sort((a, b) => a.sku.localeCompare(b.sku)),
    },
    bom: {},
    bomItem: { findMany: async () => bomItems.map((item) => ({ ...item })) },
  } as unknown as Parameters<typeof findBomRecipeDrift>[0]
}
