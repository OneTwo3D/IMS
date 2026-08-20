import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FulfillmentGraphSnapshotError,
  expandFulfillmentRequirementsDecimal,
  loadFulfillmentProductGraph,
  type FulfillmentGraphNode,
} from '@/lib/products/kit-fulfillment'

/**
 * o3d-4kfh r8 (Codex finding 1) — THE GRAPH LOAD MUST BE ONE CONSISTENT VERSION-SNAPSHOT.
 *
 * `loadFulfillmentProductGraph` walks the graph breadth-first: one `product.findMany` per level.
 * Under READ COMMITTED each of those is its own snapshot. r7 made every NODE internally consistent
 * (the version is selected in the same statement as that node's component list) and stopped there,
 * which left the MAP inconsistent: the root comes from batch 1, its nested KIT from batch 2, and a
 * component edit committing between the two produced a map holding an OLD root version beside a NEW
 * descendant recipe. Consumers compare the `OrderAllocation` stamp to the ROOT node, so the stale
 * stamp matched, while the quantities were checked against the new recipe — and under a uniform
 * rescale that is perfectly proportional, so the dispatch backstop passed too.
 *
 * THE DOUBLE HERE MUST BE ABLE TO EXPRESS THAT, and that is the whole point of its shape: it serves
 * every statement from a MUTABLE product map, computes that statement's rows BEFORE running the
 * interleaving hook (so the hook models an editor committing AFTER our read), and lets a test
 * mutate the map between two batches of ONE load. A double that answered the whole graph from a
 * single frozen read could not model this finding at all, and a double that slaved the node
 * versions and the recipes to one value could not let them disagree.
 */

type FakeProduct = {
  id: string
  type: 'SIMPLE' | 'KIT'
  version: number
  components: Array<{ componentId: string; qty: number }>
}

type GraphClientHooks = {
  /** Runs AFTER the statement's rows have been computed — an editor committing after our read. */
  afterStatement?: (callIndex: number, batch: string[]) => void
}

function createGraphClient(products: Map<string, FakeProduct>, hooks: GraphClientHooks = {}) {
  const batches: string[][] = []
  const client = {
    product: {
      findMany: async ({ where, select }: {
        where: { id: { in: string[] } }
        select: Record<string, unknown>
      }) => {
        const batch = [...where.id.in]
        batches.push(batch)
        const wantsComponents = 'productComponents' in select
        // Snapshot semantics: the rows this statement returns are the state as of NOW, before any
        // concurrent commit the hook below models.
        const rows = batch.flatMap((id) => {
          const product = products.get(id)
          if (!product) return []
          if (!wantsComponents) {
            return [{ id: product.id, fulfillmentGraphVersion: product.version }]
          }
          return [{
            id: product.id,
            type: product.type,
            fulfillmentGraphVersion: product.version,
            productComponents: product.components.map((component, index) => ({
              componentId: component.componentId,
              qty: component.qty,
              component: {
                sku: component.componentId.toUpperCase(),
                type: products.get(component.componentId)?.type ?? 'SIMPLE',
                oversellAllowed: false,
              },
              sortOrder: index,
            })),
          }]
        })
        hooks.afterStatement?.(batches.length, batch)
        return rows
      },
    },
  }
  return { client: client as unknown as Parameters<typeof loadFulfillmentProductGraph>[0], batches }
}

/** kit-1 -> 1 x kit-2 -> (2 x comp-a + 1 x comp-b). Everything at version 0. */
function nestedKitProducts(): Map<string, FakeProduct> {
  return new Map<string, FakeProduct>([
    ['kit-1', { id: 'kit-1', type: 'KIT', version: 0, components: [{ componentId: 'kit-2', qty: 1 }] }],
    ['kit-2', {
      id: 'kit-2',
      type: 'KIT',
      version: 0,
      components: [{ componentId: 'comp-a', qty: 2 }, { componentId: 'comp-b', qty: 1 }],
    }],
    ['comp-a', { id: 'comp-a', type: 'SIMPLE', version: 0, components: [] }],
    ['comp-b', { id: 'comp-b', type: 'SIMPLE', version: 0, components: [] }],
  ])
}

/**
 * The editor's transaction: a UNIFORM rescale of the nested kit, plus the ancestor bump
 * `bumpFulfillmentGraphVersions` performs in the same transaction as the component write.
 */
function commitUniformRescale(products: Map<string, FakeProduct>) {
  const nested = products.get('kit-2')!
  nested.components = [{ componentId: 'comp-a', qty: 4 }, { componentId: 'comp-b', qty: 2 }]
  nested.version += 1
  products.get('kit-1')!.version += 1
}

function expandToPairs(graph: Map<string, FulfillmentGraphNode>, rootId: string) {
  return [...expandFulfillmentRequirementsDecimal(rootId, 1, graph)]
    .map(([id, qty]) => [id, qty.toNumber()])
}

test('o3d-4kfh r8: an empty root set issues no query at all', async () => {
  const { client, batches } = createGraphClient(nestedKitProducts())

  const graph = await loadFulfillmentProductGraph(client, ['', ''])

  assert.equal(graph.size, 0)
  assert.equal(batches.length, 0)
})

test('o3d-4kfh r8: a flat kit still pays for the verify read — a nested read is not one statement', async () => {
  // No single-batch fast path. Prisma does not document a nested `select` as one SQL statement and
  // `relationLoadStrategy` is a configurable knob, so "one findMany is one snapshot" is not a
  // property to build a correctness boundary on. The verify read closes that window too.
  const products = new Map<string, FakeProduct>([
    ['kit-1', { id: 'kit-1', type: 'KIT', version: 3, components: [{ componentId: 'comp-a', qty: 2 }] }],
    ['comp-a', { id: 'comp-a', type: 'SIMPLE', version: 0, components: [] }],
  ])
  const { client, batches } = createGraphClient(products)

  const graph = await loadFulfillmentProductGraph(client, ['kit-1'])

  assert.deepEqual(batches, [['kit-1'], ['kit-1']], 'one BFS batch, then the verify read')
  assert.equal(graph.get('kit-1')?.fulfillmentGraphVersion, 3)
})

test('o3d-4kfh r8: a nested load verifies once and returns when nothing moved', async () => {
  const { client, batches } = createGraphClient(nestedKitProducts())

  const graph = await loadFulfillmentProductGraph(client, ['kit-1'])

  assert.deepEqual(
    batches,
    [['kit-1'], ['kit-2'], ['kit-1', 'kit-2']],
    'two BFS batches then ONE verify read covering EVERY visited node',
  )
  assert.equal(graph.get('kit-1')?.fulfillmentGraphVersion, 0)
  assert.equal(graph.get('kit-2')?.fulfillmentGraphVersion, 0)
  assert.deepEqual(expandToPairs(graph, 'kit-1'), [['comp-a', 2], ['comp-b', 1]])
})

test('o3d-4kfh r8 (finding 1): a nested KIT rescaled BETWEEN BATCHES never reaches the caller', async () => {
  // THE FINDING, at the seam. The editor commits after batch 1 has returned the root at version 0
  // and before batch 2 reads the child. Pre-fix the returned map paired root@0 with the NEW 4xA+2xB
  // recipe: an allocation stamped 0 matched the root, so the CAS passed while the quantities were
  // judged against a recipe the rows were never built from.
  const products = nestedKitProducts()
  let fired = 0
  const { client, batches } = createGraphClient(products, {
    afterStatement: (callIndex) => {
      if (callIndex !== 1) return
      commitUniformRescale(products)
      fired += 1
    },
  })

  const graph = await loadFulfillmentProductGraph(client, ['kit-1'])

  assert.equal(fired, 1, 'the interleaving really happened — otherwise this test proves nothing')
  // The property first, so a regression reports the CORRUPTION and not merely a changed call count:
  // the map handed back must belong to ONE version of the graph.
  assert.equal(graph.get('kit-1')?.fulfillmentGraphVersion, 1, 'the root carries the POST-edit version')
  assert.equal(graph.get('kit-2')?.fulfillmentGraphVersion, 1, 'and so does the descendant that moved')
  assert.deepEqual(
    expandToPairs(graph, 'kit-1'),
    [['comp-a', 4], ['comp-b', 2]],
    'the requirements are the new recipe — which the root version now agrees with',
  )
  // And therefore the CAS refuses an allocation stamped against the pre-edit graph, which is the
  // whole point: pre-fix the root read back as 0 and that stale stamp was accepted.
  const staleAllocationStamp = 0
  assert.notEqual(
    graph.get('kit-1')?.fulfillmentGraphVersion,
    staleAllocationStamp,
    'a stamp from the pre-edit graph must NOT match the root version the caller expanded against',
  )
  assert.equal(batches.length, 6, 'the torn walk was detected by the verify read and re-walked')
})

test('o3d-4kfh r8: an edit landing between the LAST batch and the verify read is detected too', async () => {
  // Not only the batch-to-batch boundary: the verify read closes the window right up to its own
  // statement, so an edit committing after the deepest batch is caught as well.
  const products = nestedKitProducts()
  const { client, batches } = createGraphClient(products, {
    afterStatement: (callIndex) => {
      if (callIndex === 2) commitUniformRescale(products)
    },
  })

  const graph = await loadFulfillmentProductGraph(client, ['kit-1'])

  assert.equal(graph.get('kit-1')?.fulfillmentGraphVersion, 1, 'the root carries the POST-edit version')
  assert.equal(graph.get('kit-2')?.fulfillmentGraphVersion, 1)
  assert.deepEqual(expandToPairs(graph, 'kit-1'), [['comp-a', 4], ['comp-b', 2]])
  assert.equal(batches.length, 6, 're-walked rather than returning the pre-edit map')
})

test('o3d-4kfh r8: an edit that commits BEFORE the walk is not a tear — no re-walk', async () => {
  // The uncontended case must stay uncontended. A graph that settled before we started reads clean
  // on the first attempt; catching the stale ALLOCATION is the CAS's job, not the loader's.
  const products = nestedKitProducts()
  commitUniformRescale(products)
  const { client, batches } = createGraphClient(products)

  const graph = await loadFulfillmentProductGraph(client, ['kit-1'])

  assert.equal(batches.length, 3, 'two batches and one verify read — no re-walk')
  assert.equal(graph.get('kit-1')?.fulfillmentGraphVersion, 1)
  assert.deepEqual(expandToPairs(graph, 'kit-1'), [['comp-a', 4], ['comp-b', 2]])
})

test('o3d-4kfh r8: a visited product DELETED mid-walk counts as moved', async () => {
  // A hole in the map is not a graph we may expand: `expandFulfillmentRequirementsDecimal` treats a
  // missing node as a LEAF. The verify read returns fewer rows than the map has nodes — a tear.
  const products = nestedKitProducts()
  let deleted = false
  const { client, batches } = createGraphClient(products, {
    afterStatement: (callIndex) => {
      if (callIndex !== 1 || deleted) return
      products.delete('kit-2')
      products.get('kit-1')!.components = []
      products.get('kit-1')!.version += 1
      deleted = true
    },
  })

  const graph = await loadFulfillmentProductGraph(client, ['kit-1'])

  assert.equal(deleted, true)
  assert.equal(graph.has('kit-2'), false, 'the re-walk reflects the deletion instead of half-holding it')
  assert.equal(
    graph.get('kit-1')?.fulfillmentGraphVersion,
    1,
    'and the root is the POST-deletion version, not the stale one batch 1 read',
  )
  assert.deepEqual(expandToPairs(graph, 'kit-1'), [['kit-1', 1]], 'a componentless KIT is its own leaf')
  assert.deepEqual(
    batches,
    [['kit-1'], ['kit-2'], ['kit-1'], ['kit-1'], ['kit-1']],
    'first walk torn (2 batches + verify), second walk clean (1 batch + verify)',
  )
})

test('o3d-4kfh r8: a graph that never settles is REFUSED, not expanded half-old', async () => {
  // Fail closed. Three consecutive tears means an editor committing between every pair of our
  // statements; handing back a torn map instead would be the very defect this closes.
  const products = nestedKitProducts()
  const { client, batches } = createGraphClient(products, {
    afterStatement: (_callIndex, batch) => {
      // Bump on every ROOT walk batch (the verify read asks for both ids, so it is distinguishable),
      // so every attempt tears.
      if (batch.length === 1 && batch[0] === 'kit-1') commitUniformRescale(products)
    },
  })

  await assert.rejects(
    () => loadFulfillmentProductGraph(client, ['kit-1']),
    (error: unknown) => {
      assert.ok(error instanceof FulfillmentGraphSnapshotError, 'fails closed with the snapshot error')
      assert.match(error.message, /changed while it was being read/)
      assert.match(error.message, /Refusing rather than expanding/)
      assert.deepEqual(error.movedProductIds, ['kit-1'])
      return true
    },
  )
  assert.equal(batches.length, 9, 'three attempts, each two batches and a verify read')
})

// ---------------------------------------------------------------------------
// o3d-57b0 (carried in from o3d-ryyd) — THE WALK IS ONE QUERY PER LEVEL AND RUNS UNDER THE SALES
// ORDER LOCK. `graph.has()` stops it looping on a cycle; nothing stopped it issuing a hundred
// round trips on a hundred-deep chain, three times over once the verify-and-re-walk loop was added.

/** A chain kit-0 -> kit-1 -> ... -> kit-N, every level a KIT so the walk must follow it. */
function kitChain(levels: number): Map<string, FakeProduct> {
  const products = new Map<string, FakeProduct>()
  for (let level = 0; level <= levels; level += 1) {
    products.set(`kit-${level}`, {
      id: `kit-${level}`,
      type: 'KIT',
      version: 0,
      components: level === levels
        ? [{ componentId: 'leaf', qty: 1 }]
        : [{ componentId: `kit-${level + 1}`, qty: 1 }],
    })
  }
  products.set('leaf', { id: 'leaf', type: 'SIMPLE', version: 0, components: [] })
  return products
}

test('o3d-57b0: a graph nested to the depth cap still loads, in one query per level', async () => {
  // Eight levels of KIT below the root is the documented limit, and it must not be refused.
  const { client, batches } = createGraphClient(kitChain(8))

  const graph = await loadFulfillmentProductGraph(client, ['kit-0'])

  // kit-0..kit-8. The SIMPLE leaf is never enqueued — only KIT components are followed.
  assert.equal(graph.size, 9)
  // 9 walk statements (the roots plus 8 nested levels) and one verify read.
  assert.equal(batches.length, 10)
})

test('o3d-57b0: a graph nested PAST the cap is refused, naming where it stopped', async () => {
  const { client } = createGraphClient(kitChain(12))

  await assert.rejects(
    () => loadFulfillmentProductGraph(client, ['kit-0']),
    (error: Error) => {
      assert.equal(error.name, 'FulfillmentGraphDepthError')
      assert.match(error.message, /nests more than 8 levels of KIT/)
      assert.deepEqual((error as unknown as { productIds: string[] }).productIds, ['kit-9'])
      return true
    },
    'an unbounded fan-out inside the order lock must fail closed, not run',
  )
})
