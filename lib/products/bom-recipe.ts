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
   * The adoption lost a race: the row this call chose was claimed by another writer between the
   * read and the conditional update (round 2, finding 4). Refused rather than retried, because
   * every claim path now holds `COMPONENT_GRAPH_WRITE_LOCK_KEY`, so reaching this means an
   * unlocked writer exists and guessing would hide it.
   */
  | { kind: 'claim-contended'; bomId: string }

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

  const existing = await client.bom.findUnique({ where: { productId }, select: { id: true, active: true } })
  let bomId = existing?.id ?? null
  let claimKind: 'created' | 'adopted' | 'already' = 'already'

  if (bomId) {
    // A CLAIMED Bom that is INACTIVE is a recipe planning cannot see:
    // `replenishment-reports.ts` filters `bom: { active: true }` and `createReorderMOs` filters
    // `active: true`. Being the claimed recipe of a BOM-typed product is exactly what "this is the
    // live recipe" means, so writing it re-activates it. Without this, converting a product away
    // from BOM and back again would leave it silently unplannable (round 2).
    if (existing && !existing.active) {
      await client.bom.update({ where: { id: bomId }, data: { active: true } })
    }
  } else {
    const adoptable = await client.bom.findFirst({
      where: { productId: null, items: { some: { parentProductId: productId } } },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    })
    if (adoptable) {
      // CONDITIONAL, and the count is checked (round 2, finding 4). `update({ where: { id } })`
      // was unconditional: two writers could each read the row as unclaimed and then both update
      // it by id, and the SECOND silently overwrote the first product's claim — transferring a
      // BOM between products. The unique index cannot stop that, because both writes target ONE
      // row and each leaves exactly one claim in place.
      //
      // `productId: null` in the predicate makes the read-then-write a compare-and-set, so a row
      // that has been claimed since the read is not touched at all.
      const claimed = await client.bom.updateMany({
        where: { id: adoptable.id, productId: null },
        data: { productId, active: true },
      })
      if (claimed.count !== 1) return { kind: 'claim-contended', bomId: adoptable.id }
      bomId = adoptable.id
      claimKind = 'adopted'
    }
  }

  if (!bomId) {
    const created = await client.bom.create({
      data: { name: `${sku} BOM`, description: args.productName ?? null, productId, active: true },
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
    // SCOPED TO ACTIVE BOMS, and that scope is not cosmetic (o3d-zjsb5.9 round 3 reader audit).
    // The reader this check protects — `replenishment-reports.ts` explodes component demand from
    // bom_items — selects `where: { bom: { active: true }, parentProduct: { type: BOM } }`. So the
    // graph that can actually hurt anyone is the ACTIVE one. Retiring a recipe deliberately KEEPS
    // its items (deactivated and unclaimed) so completed and in-flight orders still resolve, which
    // means an unscoped walk counts edges no reader will ever follow and can refuse a perfectly
    // legitimate re-import. Conservative in the wrong direction is still wrong.
    where: { bom: { active: true } },
    select: { parentProductId: true, componentProductId: true },
  })
  const cycle = detectBomItemCycleInEdges(edges)
  if (cycle) return { kind: 'cycle', path: cycle }

  return { kind: 'written', bomId, claimed: claimKind }
}

/**
 * RETIRE the manufacturing recipe of a product that is no longer a BOM (round 2, finding 1b).
 *
 * `validateProductStructureChange` sets `clearComponents` when a component-bearing type becomes a
 * non-component one, and both writers then delete `ProductComponent` — leaving `BomItem` behind.
 *
 * WHAT THAT ACTUALLY EXPOSED, stated precisely rather than as "planning still reads them", because
 * two of the three readers do filter: `replenishment-reports.ts:776` requires
 * `parentProduct: { type: BOM }` and `createReorderMOs` only asks about products it has already
 * decided are eligible. So the orphan rows are mostly inert TODAY. They are still wrong for two
 * reasons that do bite: the claimed `Bom` keeps asserting it is the live recipe of a product that
 * has none, and {@link findBomRecipeDrift} reports `bom-items-on-non-bom-product` — so an entirely
 * legitimate BOM -> SIMPLE conversion would make this branch's own check go red, which is the fast
 * route to a check nobody trusts.
 *
 * DEACTIVATE AND UNCLAIM, DO NOT DELETE. Deleting the items would rewrite what
 * `manufacturing-analytics.ts` reports for completed production orders that still point at this
 * Bom (the deferred round-2 finding 2). Clearing `active` is what every planning reader already
 * filters on, and clearing `productId` releases the claim so a later conversion back to BOM can
 * adopt the row rather than add a second one. History keeps resolving; planning stops reading it.
 */
export async function retireBomRecipeForProduct(
  client: BomSyncClient,
  productId: string,
): Promise<{ retiredBomId: string | null }> {
  const claimed = await client.bom.findUnique({ where: { productId }, select: { id: true } })
  if (!claimed) return { retiredBomId: null }
  await client.bom.update({ where: { id: claimed.id }, data: { active: false, productId: null } })
  return { retiredBomId: claimed.id }
}

export type BomRecipeReconcileOutcome =
  | { kind: 'synced'; bomId: string; claimed: 'created' | 'adopted' | 'already' }
  | { kind: 'retired'; retiredBomId: string | null }
  | { kind: 'cycle'; path: string[] }
  | { kind: 'claim-contended'; bomId: string }

type BomReconcileClient = BomSyncClient & Pick<Prisma.TransactionClient, 'productComponent'>

/**
 * RECONCILE the BOM recipe to whatever the product's type NOW says it should be (round 2).
 *
 * Called by the two paths that change `Product.type`, after the type write. It reads
 * `ProductComponent` itself rather than taking a list, because a type change does not come with
 * one — and all four directions have to be right, not just the one that deletes components:
 *
 *   - anything -> BOM (including KIT -> BOM, where `clearComponents` is FALSE and the components
 *     are kept): the product now needs a claimed Bom mirroring them, or planning has no recipe and
 *     `createReorderMOs` cannot raise a build for it;
 *   - BOM -> anything: retire, per {@link retireBomRecipeForProduct};
 *   - neither before nor after: nothing to do.
 *
 * MUST run in the caller's transaction, under `COMPONENT_GRAPH_WRITE_LOCK_KEY`, after the type
 * write — the same contract as {@link syncBomRecipeFromProductComponents}, and for the same reason.
 */
export async function reconcileBomRecipeForProductType(
  client: BomReconcileClient,
  args: { productId: string; sku: string; type: string; productName?: string | null },
): Promise<BomRecipeReconcileOutcome> {
  if (args.type !== 'BOM') {
    return { kind: 'retired', ...(await retireBomRecipeForProduct(client, args.productId)) }
  }

  const components = await client.productComponent.findMany({
    where: { productId: args.productId },
    select: { componentId: true, qty: true },
    orderBy: { sortOrder: 'asc' },
  })
  const outcome = await syncBomRecipeFromProductComponents(client, {
    productId: args.productId,
    sku: args.sku,
    productName: args.productName,
    components: components.map((component) => ({
      componentProductId: component.componentId,
      qty: Number(component.qty),
    })),
  })
  if (outcome.kind === 'cycle' || outcome.kind === 'claim-contended') return outcome
  return { kind: 'synced', bomId: outcome.bomId, claimed: outcome.claimed }
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
  /**
   * `BomItem` rows exist for a product whose type is not BOM, in a Bom that is still ACTIVE or
   * still CLAIMED — i.e. not properly retired. A retired recipe (inactive AND unclaimed) is
   * history and is NOT drift: see `retireBomRecipeForProduct`.
   */
  | 'bom-items-on-non-bom-product'
  /**
   * The claimed Bom of a BOM-typed product is INACTIVE, so every planning reader filters it out
   * (`replenishment-reports.ts` requires `bom: { active: true }`, `createReorderMOs` the same) —
   * the recipe exists and agrees, and planning still cannot see it. Silent everywhere else.
   */
  | 'inactive-claimed-bom'
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
      manufacturingBom: { select: { id: true, active: true } },
    },
    orderBy: { sku: 'asc' },
  })

  const bomItems = await client.bomItem.findMany({
    select: {
      bomId: true,
      parentProductId: true,
      componentProductId: true,
      qty: true,
      // Needed to tell a RETIRED recipe (inactive + unclaimed) from an orphaned one. Without it
      // this check goes red on a legitimate BOM -> SIMPLE conversion, which is the fast route to
      // a check nobody trusts (round 2).
      bom: { select: { active: true, productId: true } },
    },
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
      // A RETIRED recipe is inactive AND unclaimed: no planning reader can reach it and nothing
      // claims it is this product's live recipe, so it is history, not drift. Anything else is
      // reported.
      const liveItems = allItems.filter((item) => item.bom.active || item.bom.productId !== null)
      if (liveItems.length > 0) {
        const bomIds = [...new Set(liveItems.map((item) => item.bomId))]
        drift.push({
          productId: product.id,
          sku: product.sku,
          kind: 'bom-items-on-non-bom-product',
          detail: `${product.sku} is type ${product.type} but has ${liveItems.length} bom_items row(s) as parent in `
            + `Bom(s) ${bomIds.join(', ')} that are still active or still claimed — a type conversion left the `
            + 'manufacturing recipe behind instead of retiring it',
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

    if (product.manufacturingBom && !product.manufacturingBom.active) {
      // Reported IN ADDITION to any recipe difference, not instead of it: an inactive Bom whose
      // items agree perfectly is still invisible to planning, and that is the whole point.
      drift.push({
        productId: product.id,
        sku: product.sku,
        kind: 'inactive-claimed-bom',
        detail: `${product.sku}'s claimed Bom (${claimedBomId}) is inactive, so replenishment planning and `
          + 'reorder-MO generation filter it out — the recipe exists and cannot be used',
      })
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

/**
 * A BOM-recipe write the caller must ROLL BACK (round 2).
 *
 * WHY AN EXCEPTION AND NOT A RETURN VALUE. Both callers in `app/actions/products.ts` report
 * failures by returning a discriminated union out of their `db.$transaction` callback — and a
 * callback that RETURNS commits. That is correct for their existing refusals, which all happen
 * BEFORE any write. A BOM refusal happens AFTER `ProductComponent` has been written in the same
 * transaction, so returning it would commit one representation of a recipe the other rejected:
 * precisely the split this whole change exists to prevent. Throwing is what makes the refusal
 * atomic.
 */
export class BomRecipeRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BomRecipeRefusedError'
  }
}

/** The operator-facing message for a refused recipe write, shared by every caller. */
export function describeBomRecipeRefusal(
  outcome: { kind: 'cycle'; path: string[] } | { kind: 'claim-contended'; bomId: string },
): string {
  if (outcome.kind === 'cycle') {
    return 'Circular reference detected in the manufacturing BOM graph ('
      + `${outcome.path.join(' -> ')}) — nothing was saved. An older BOM recipe for a different product may still `
      + "list this one as its parent; re-save that product's recipe too, or clear it"
  }
  return "Another writer claimed this product's manufacturing BOM while saving — nothing was saved. "
    + 'Reload and try again'
}
