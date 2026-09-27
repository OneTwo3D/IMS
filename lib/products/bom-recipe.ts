import type { Prisma } from '@/app/generated/prisma/client'

/**
 * THE MANUFACTURING HALF OF A RECIPE (o3d-zjsb5.9).
 *
 * IMS stores a manufactured product's recipe TWICE, for two different sets of readers:
 *
 *   - `ProductComponent` is read by FULFILMENT (`lib/domain/sales/allocation-service.ts`,
 *     `lib/domain/inventory/reservation-breakdown.ts`) and by PRODUCTION-ORDER CONSUMPTION
 *     (`app/actions/manufacturing.ts` reads `outputProduct.productComponents`, then freezes a
 *     `componentSnapshot` when the order starts). It rides in the products CSV's `components`
 *     column.
 *   - `Bom` / `BomItem` is read by PLANNING: `lib/domain/inventory/replenishment-reports.ts`
 *     explodes component demand from `bomItem.findMany`, `app/actions/forecasting.ts` needs a
 *     `bomId` before it can raise a reorder MO, and
 *     `lib/domain/manufacturing/manufacturing-analytics.ts` values an order through
 *     `order.bom.items`.
 *
 * Until this module existed, NOTHING wrote the second representation from an import. A Qoblex
 * BOM loaded through the products CSV was therefore sellable and (via the lazy Bom create in
 * `createManufacturingOrder`) manufacturable ONE ORDER AT A TIME, but invisible to every
 * planning report — and no guard, constraint or log said so.
 *
 * THE ANTI-DRIFT DESIGN. This module never accepts a recipe of its own. `syncBomRecipeFromProductComponents`
 * is called from inside the products importer's component-pass transaction, with the SAME parsed
 * component list that the `ProductComponent` write just used, under the SAME
 * `COMPONENT_GRAPH_WRITE_LOCK_KEY` advisory lock. Drift between the two representations is
 * therefore not prevented by a second check — it is unrepresentable for anything this code
 * wrote. {@link findBomRecipeDrift} exists for everything it did NOT write: rows created by the
 * lazy `createManufacturingOrder` path, rows created by hand, and rows that predate the import
 * path entirely.
 */

/** A recipe line in the shape both representations reduce to. */
export type RecipeLine = { componentProductId: string; qty: number }

/**
 * `Decimal(12, 4)` on both `BomItem.qty` and `ProductComponent.qty`, so four decimal places is
 * the full stored precision and an exact comparison at that scale is not a tolerance fudge — it
 * is the values as the database holds them. Comparing `Number` equality directly would make
 * 0.1 + 0.2 style representation noise look like drift.
 */
export const RECIPE_QTY_SCALE = 4

/** Anything with a `toString()` — a Prisma `Decimal`, a `number`, or a string from raw SQL. */
export type DecimalLike = { toString(): string } | number | string

export function normalizeRecipeQty(qty: DecimalLike): string {
  const asNumber = typeof qty === 'number' ? qty : Number(qty.toString())
  if (!Number.isFinite(asNumber)) return 'NaN'
  return asNumber.toFixed(RECIPE_QTY_SCALE)
}

export function toRecipeMap(lines: Array<{ componentProductId: string; qty: DecimalLike }>): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of lines) {
    const existing = map.get(line.componentProductId)
    // Duplicated component in one recipe: SUM, because that is what two BomItem rows for the
    // same component mean in every reader that explodes them. `ProductComponent` cannot have a
    // duplicate (`@@unique([productId, componentId])`), so a summed BomItem side that matches is
    // genuinely equivalent, and one that does not is genuinely drift.
    const merged = existing === undefined
      ? normalizeRecipeQty(line.qty)
      : (Number(existing) + Number(normalizeRecipeQty(line.qty))).toFixed(RECIPE_QTY_SCALE)
    map.set(line.componentProductId, merged)
  }
  return map
}

export type RecipeDifference =
  /** In `ProductComponent` (what fulfilment and consumption use) but not in `BomItem`. */
  | { kind: 'missing-from-bom'; componentProductId: string; componentQty: string }
  /** In `BomItem` (what planning uses) but not in `ProductComponent`. */
  | { kind: 'missing-from-components'; componentProductId: string; bomQty: string }
  | { kind: 'qty-differs'; componentProductId: string; componentQty: string; bomQty: string }

/**
 * PURE. Compare the two representations of one product's recipe.
 *
 * Returns every difference, sorted by component id so the output is stable enough to assert on
 * and to diff between runs. An empty array means the two representations agree EXACTLY at the
 * stored scale — not "agree approximately", and not "the BOM side is a superset".
 */
export function compareRecipes(
  componentLines: Array<{ componentProductId: string; qty: DecimalLike }>,
  bomLines: Array<{ componentProductId: string; qty: DecimalLike }>,
): RecipeDifference[] {
  const components = toRecipeMap(componentLines)
  const bom = toRecipeMap(bomLines)
  const differences: RecipeDifference[] = []

  for (const [componentProductId, componentQty] of components) {
    const bomQty = bom.get(componentProductId)
    if (bomQty === undefined) {
      differences.push({ kind: 'missing-from-bom', componentProductId, componentQty })
    } else if (bomQty !== componentQty) {
      differences.push({ kind: 'qty-differs', componentProductId, componentQty, bomQty })
    }
  }
  for (const [componentProductId, bomQty] of bom) {
    if (!components.has(componentProductId)) {
      differences.push({ kind: 'missing-from-components', componentProductId, bomQty })
    }
  }

  return differences.sort((a, b) => a.componentProductId.localeCompare(b.componentProductId))
}

/**
 * PURE. Is the `bom_items` edge set cyclic?
 *
 * WHY THIS EXISTS AT ALL, given `detectComponentCycle` (o3d-zjsb5.9 requirement 3).
 * `detectComponentCycle` walks `product_components` and nothing else — the table name is baked
 * into its recursive CTE — so it cannot answer this question, and generalising it to take a table
 * name would put an identifier into a raw query for no gain. What IS reused is its reasoning:
 * dedupe the frontier so the walk terminates on a graph that ALREADY contains a cycle, because
 * the whole point is that such a graph is reachable.
 *
 * And it IS reachable, which is why a subset argument is not enough. `bom_items` is a mirror of
 * `product_components`, and a subset of an acyclic edge set is acyclic — but the mirror is
 * maintained PER PARENT and legacy rows were written at different times. Product A gets a Bom
 * while components say A -> B; components are later changed to B -> A and B gets a Bom. Now
 * `product_components` holds only B -> A (acyclic) while `bom_items` holds both directions. The
 * planning explosion in `replenishment-reports.ts` walks `bom_items`, so that cycle is a real
 * hang/blow-up risk in a reader that has no cycle check of its own.
 *
 * Returns the cycle as a product-id path (first id repeated at the end), or `null`.
 */
export function detectBomItemCycleInEdges(
  edges: Array<{ parentProductId: string; componentProductId: string }>,
): string[] | null {
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    const list = adjacency.get(edge.parentProductId) ?? []
    list.push(edge.componentProductId)
    adjacency.set(edge.parentProductId, list)
  }

  const VISITING = 1
  const DONE = 2
  const state = new Map<string, number>()
  const stack: string[] = []

  const walk = (node: string): string[] | null => {
    const known = state.get(node)
    if (known === DONE) return null
    if (known === VISITING) return [...stack.slice(stack.indexOf(node)), node]
    state.set(node, VISITING)
    stack.push(node)
    for (const next of adjacency.get(node) ?? []) {
      const found = walk(next)
      if (found) return found
    }
    stack.pop()
    state.set(node, DONE)
    return null
  }

  for (const parent of adjacency.keys()) {
    const found = walk(parent)
    if (found) return found
  }
  return null
}

/**
 * PURE. The same question as {@link detectBomItemCycleInEdges}, asked about the graph that would
 * exist if `parentProductId`'s edges were REPLACED by `componentProductIds`.
 *
 * This is what a DRY RUN needs. The authoritative check runs after the write, inside the
 * importer's transaction and under its lock, and that is the one that decides — but a preview that
 * cannot report a refusal it will make on execute is a preview the operator cannot trust, which is
 * the whole point of the preview mode.
 */
export function detectBomItemCycleAfterReplacement(
  edges: Array<{ parentProductId: string; componentProductId: string }>,
  parentProductId: string,
  componentProductIds: string[],
): string[] | null {
  const kept = edges.filter((edge) => edge.parentProductId !== parentProductId)
  const proposed = componentProductIds.map((componentProductId) => ({ parentProductId, componentProductId }))
  return detectBomItemCycleInEdges([...kept, ...proposed])
}

// ---------------------------------------------------------------------------
// Write path — called from the products importer's component pass
// ---------------------------------------------------------------------------

type BomSyncClient = Pick<Prisma.TransactionClient, 'bom' | 'bomItem'>

export type BomRecipeSyncOutcome =
  | { kind: 'written'; bomId: string; claimed: 'created' | 'adopted' | 'already' }
  | { kind: 'cycle'; path: string[] }

/**
 * Bring `Bom`/`BomItem` into line with the component list the caller is writing to
 * `ProductComponent` for `productId`.
 *
 * MUST be called inside the caller's transaction, AFTER the `ProductComponent` write, while the
 * caller holds `COMPONENT_GRAPH_WRITE_LOCK_KEY`. Not "should": the anti-drift property is that
 * both representations move in one atomic step from one source list. Called outside that
 * transaction it would reintroduce exactly the window it exists to remove.
 *
 * CLAIMING. The target Bom is resolved in three steps, in this order:
 *   1. the Bom already claimed by this product (`productId`);
 *   2. otherwise the most recently updated Bom holding items for this parent — ADOPTED by
 *      claiming it, so the readers that still resolve through `BomItem.parentProductId`
 *      (`createManufacturingOrder`, `createReorderMOs`) keep finding the same row and the
 *      production-order history pointing at it keeps resolving;
 *   3. otherwise a new Bom.
 *
 * Items are rewritten for THIS PARENT ONLY, inside the claimed Bom. Items for this parent living
 * in some OTHER, unclaimed Bom are deliberately left alone and reported by
 * {@link findBomRecipeDrift} as `duplicate-unclaimed-bom` instead of being deleted: a completed
 * `ProductionOrder` may point at that Bom, and `manufacturing-analytics.ts` values it through
 * `order.bom.items`, so deleting them would silently rewrite history to prettify a check.
 */
export async function syncBomRecipeFromProductComponents(
  client: BomSyncClient,
  args: {
    productId: string
    sku: string
    productName?: string | null
    components: RecipeLine[]
  },
): Promise<BomRecipeSyncOutcome> {
  const { productId, sku, components } = args

  const claimed = await client.bom.findUnique({ where: { productId }, select: { id: true } })
  let bomId = claimed?.id ?? null
  let claimKind: 'created' | 'adopted' | 'already' = 'already'

  if (!bomId) {
    const adoptable = await client.bom.findFirst({
      where: { productId: null, items: { some: { parentProductId: productId } } },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    })
    if (adoptable) {
      await client.bom.update({ where: { id: adoptable.id }, data: { productId } })
      bomId = adoptable.id
      claimKind = 'adopted'
    }
  }

  if (!bomId) {
    const created = await client.bom.create({
      data: { name: `${sku} BOM`, description: args.productName ?? null, productId },
      select: { id: true },
    })
    bomId = created.id
    claimKind = 'created'
  }

  // Replace, never merge: the component list is the whole recipe, so a component the CSV dropped
  // must leave the BomItem side too or the two representations diverge in the direction planning
  // over-orders.
  await client.bomItem.deleteMany({ where: { bomId, parentProductId: productId } })
  if (components.length > 0) {
    await client.bomItem.createMany({
      data: components.map((component, index) => ({
        bomId,
        parentProductId: productId,
        componentProductId: component.componentProductId,
        qty: component.qty,
        sortOrder: index,
      })),
    })
  }

  // AFTER the write, on the graph this transaction is actually committing. Checking before the
  // write would ask about a graph that still holds this parent's OLD edges — which both invents
  // cycles that the rewrite removes and misses cycles the rewrite creates. The caller aborts its
  // transaction on a cycle, so nothing lands.
  const edges = await client.bomItem.findMany({
    select: { parentProductId: true, componentProductId: true },
  })
  const cycle = detectBomItemCycleInEdges(edges)
  if (cycle) return { kind: 'cycle', path: cycle }

  return { kind: 'written', bomId, claimed: claimKind }
}

// ---------------------------------------------------------------------------
// Consistency check
// ---------------------------------------------------------------------------

export type BomRecipeDriftKind =
  /** BOM-typed product with a `ProductComponent` recipe and no claimed `Bom` at all. */
  | 'missing-bom'
  /** Claimed Bom exists but carries no items for this parent. */
  | 'empty-bom'
  /** The two representations disagree on components or quantities. */
  | 'recipe-differs'
  /** `BomItem` rows for this parent live in a Bom other than the claimed one. */
  | 'duplicate-unclaimed-bom'
  /** `BomItem` rows exist for a product whose type is not BOM. */
  | 'bom-items-on-non-bom-product'
  /** The `bom_items` graph as a whole is cyclic (reported once, on the first product in it). */
  | 'bom-item-cycle'

export type BomRecipeDriftRow = {
  productId: string
  sku: string
  kind: BomRecipeDriftKind
  detail: string
}

type DriftClient = Pick<Prisma.TransactionClient, 'product' | 'bom' | 'bomItem'>

/**
 * THE CONSISTENCY CHECK. Every difference between `ProductComponent` and `Bom`/`BomItem`, for
 * every product either representation speaks about.
 *
 * WHAT WOULD STILL PASS THIS, stated so the next reader does not have to guess: it says nothing
 * about whether either recipe is CORRECT against Qoblex. Two identically wrong recipes are
 * clean. It is an agreement check between two IMS tables, and that is the only thing the schema
 * cannot already enforce.
 */
export async function findBomRecipeDrift(client: DriftClient): Promise<BomRecipeDriftRow[]> {
  const products = await client.product.findMany({
    where: {
      OR: [
        { type: 'BOM' },
        { bomAsParent: { some: {} } },
      ],
    },
    select: {
      id: true,
      sku: true,
      type: true,
      productComponents: { select: { componentId: true, qty: true } },
      manufacturingBom: { select: { id: true } },
    },
    orderBy: { sku: 'asc' },
  })

  const bomItems = await client.bomItem.findMany({
    select: { bomId: true, parentProductId: true, componentProductId: true, qty: true },
  })

  const itemsByParent = new Map<string, typeof bomItems>()
  for (const item of bomItems) {
    const list = itemsByParent.get(item.parentProductId) ?? []
    list.push(item)
    itemsByParent.set(item.parentProductId, list)
  }

  const drift: BomRecipeDriftRow[] = []

  for (const product of products) {
    const allItems = itemsByParent.get(product.id) ?? []
    const claimedBomId = product.manufacturingBom?.id ?? null
    const strayBomIds = [...new Set(allItems.filter((item) => item.bomId !== claimedBomId).map((item) => item.bomId))]

    if (product.type !== 'BOM') {
      if (allItems.length > 0) {
        drift.push({
          productId: product.id,
          sku: product.sku,
          kind: 'bom-items-on-non-bom-product',
          detail: `${product.sku} is type ${product.type} but has ${allItems.length} bom_items row(s) as parent — `
            + 'planning will explode component demand for a product no production order can be raised against',
        })
      }
      continue
    }

    if (!claimedBomId) {
      drift.push({
        productId: product.id,
        sku: product.sku,
        kind: 'missing-bom',
        detail: `${product.sku} is a BOM with ${product.productComponents.length} component(s) in `
          + 'product_components and no claimed Bom — replenishment planning and reorder-MO generation see no recipe',
      })
      continue
    }

    const claimedItems = allItems.filter((item) => item.bomId === claimedBomId)
    if (claimedItems.length === 0 && product.productComponents.length > 0) {
      drift.push({
        productId: product.id,
        sku: product.sku,
        kind: 'empty-bom',
        detail: `${product.sku} has a claimed Bom (${claimedBomId}) with no items for it, while product_components `
          + `lists ${product.productComponents.length} component(s)`,
      })
    } else {
      const differences = compareRecipes(
        product.productComponents.map((component) => ({ componentProductId: component.componentId, qty: component.qty })),
        claimedItems.map((item) => ({ componentProductId: item.componentProductId, qty: item.qty })),
      )
      for (const difference of differences) {
        drift.push({
          productId: product.id,
          sku: product.sku,
          kind: 'recipe-differs',
          detail: describeRecipeDifference(product.sku, difference),
        })
      }
    }

    if (strayBomIds.length > 0) {
      drift.push({
        productId: product.id,
        sku: product.sku,
        kind: 'duplicate-unclaimed-bom',
        detail: `${product.sku} also has bom_items in unclaimed Bom(s) ${strayBomIds.join(', ')} — left in place `
          + 'because a completed production order may still be valued through them, but they are not maintained by '
          + 'the importer and will not track product_components',
      })
    }
  }

  const cycle = detectBomItemCycleInEdges(bomItems)
  if (cycle) {
    const head = products.find((product) => product.id === cycle[0])
    drift.push({
      productId: cycle[0],
      sku: head?.sku ?? cycle[0],
      kind: 'bom-item-cycle',
      detail: `bom_items contains a cycle: ${cycle.join(' -> ')} — the planning explosion in `
        + 'replenishment-reports.ts walks this graph and has no cycle check of its own',
    })
  }

  return drift
}

export function describeRecipeDifference(sku: string, difference: RecipeDifference): string {
  switch (difference.kind) {
    case 'missing-from-bom':
      return `${sku}: component ${difference.componentProductId} x${difference.componentQty} is in product_components `
        + 'but has no BomItem — planning under-orders it'
    case 'missing-from-components':
      return `${sku}: component ${difference.componentProductId} x${difference.bomQty} has a BomItem but no `
        + 'ProductComponent — planning orders a component production never consumes'
    case 'qty-differs':
      return `${sku}: component ${difference.componentProductId} is x${difference.componentQty} in `
        + `product_components and x${difference.bomQty} in bom_items`
  }
}
