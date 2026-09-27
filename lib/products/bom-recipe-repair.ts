/**
 * o3d-zjsb5.9 round 10: THE OPERATOR RECOVERY PATH for the duplicate-recipe refusal.
 *
 * Round 8 made `syncBomRecipeFromProductComponents` REFUSE while another ACTIVE `Bom` holds
 * `BomItem` rows for the same parent, because `replenishment-reports.ts` reads every active
 * `BomItem` whose parent is BOM-typed and has no "the claimed Bom wins" rule — two active recipes
 * for one product means planning ADDS both and over-orders. Refusing beats silently double-counting.
 *
 * But that refusal blocked the product's import, its component edit AND its build orders, and told
 * the operator to "deactivate the duplicate BOM" — which NOTHING in the application could do. There
 * is no Bom list, no Bom detail page, and no server action anywhere writes `bom.update`. The only
 * way out was hand-editing production data, and the worst place to meet that is the first load,
 * inside the quiescent switchover window, with the catalogue import blocked.
 *
 * WHY A COMMAND AND NOT A BUTTON. An authorized action would have to invent the surface to put it
 * on: a Bom has no page, so it would mean a new route, a new client component, permission wiring and
 * a route-auth policy entry, for something a first load needs ONCE per stray legacy row. The
 * switchover needs an executable path, not necessarily a button. This is that path, and the reader-
 * side fix that makes duplicates harmless rather than merely detectable stays in o3d-zjsb5.30.
 *
 * WHAT IT REFUSES, because "deactivate this row" is not always safe:
 *   · a Bom CLAIMED by a product (`productId` set) is that product's live recipe — deactivating it
 *     would make a BOM-typed product silently unplannable, which is the o3d-zjsb5.29 defect;
 *   · a Bom that is the LAST active recipe of some OTHER BOM-typed parent would do the same to that
 *     product. One Bom row can legitimately hold items for several parents, so this must be checked
 *     per parent rather than assumed.
 * In both cases nothing is written and the caller is told which product is in the way.
 *
 * IT NEVER DELETES. The items are kept, deactivated, exactly as a type conversion retires a recipe:
 * `manufacturing-analytics.ts` values a completed production order through `order.bom.items`, so
 * deleting them would rewrite history to prettify a check (o3d-zjsb5.29/.30).
 */
import type { Prisma } from '@/app/generated/prisma/client'

import { COMPONENT_GRAPH_WRITE_LOCK_KEY } from '@/lib/db/advisory-locks'
import { PLANNING_REACHABLE_BOM_EDGES } from '@/lib/products/bom-recipe'

/**
 * A transaction client with exactly the models this needs. Prisma's own type, not a hand-rolled
 * structural one: a hand-rolled `(args: unknown) => Promise<unknown>` is NOT assignable from Prisma's
 * typed methods (the argument types are contravariant), so it forces an `as never` at the call site
 * and throws away the type checking that would catch a wrong `where`.
 */
type RepairClient = Pick<
  Prisma.TransactionClient,
  '$executeRaw' | '$queryRaw' | 'bom' | 'bomItem' | 'activityLog'
>

export type BomRecipeRepairOutcome =
  /** Deactivated. `items` were KEPT — that is the point. */
  | { kind: 'deactivated'; bomId: string; itemCount: number; parentProductIds: string[] }
  /** Nothing to do; safe to run twice. */
  | { kind: 'already-inactive'; bomId: string }
  | { kind: 'not-found'; bomId: string }
  /** It is a product's live recipe. Refused. */
  | { kind: 'claimed'; bomId: string; productId: string; sku: string }
  /** Deactivating it would leave another BOM-typed product with no planning-visible recipe. Refused. */
  | { kind: 'sole-recipe-for-other-parent'; bomId: string; blockedBy: Array<{ productId: string; sku: string }> }
  /**
   * The connection is not to the database the caller confirmed. Refused, inside the transaction, so the
   * abort discards anything already written (round 12).
   */
  | { kind: 'wrong-database'; expected: string; actual: string }

/**
 * Deactivate one `Bom` by id, keeping its items, refusing when another product depends on it.
 *
 * MUST be called inside a transaction: it takes `COMPONENT_GRAPH_WRITE_LOCK_KEY` so the "is this the
 * last active recipe for that parent" question cannot be answered against a graph that changes
 * underneath it — the same reason every other writer of this graph takes it, and the same lesson as
 * rounds 4 and 8 (a check outside the lock describes a state the lock is not protecting).
 */
export async function deactivateDuplicateBomRecipe(
  client: RepairClient,
  args: { bomId: string; actor?: string; database?: string; expectDatabase?: string },
): Promise<BomRecipeRepairOutcome> {
  const { bomId } = args
  await client.$executeRaw`SELECT pg_advisory_xact_lock(${COMPONENT_GRAPH_WRITE_LOCK_KEY})`

  // WHICH DATABASE IS THIS, ASKED AGAIN, IN HERE (round 12).
  //
  // The caller confirms the target before opening this transaction, and that check is necessary but not
  // sufficient: it ran on a different statement, and anything that changes which server the connection
  // reaches between then and now defeats it. That is not hypothetical in this repo -- a socket-form
  // `DATABASE_URL` losing its `?host=` silently retargets the shared cluster, and a CLONE of the
  // database holds the same BOM ids, so neither the id nor the earlier banner can tell two servers
  // apart. Asking the server itself, inside the transaction that does the writing, is what turns the
  // banner from a greeting into a guard: a mismatch here aborts, and the abort discards the write.
  if (args.expectDatabase !== undefined) {
    const identity = await client.$queryRaw<Array<{ database: string }>>`
      SELECT current_database()::text AS database
    `
    const actual = identity[0]?.database ?? 'unknown'
    if (actual !== args.expectDatabase) {
      return { kind: 'wrong-database', expected: args.expectDatabase, actual }
    }
  }

  const bom = await client.bom.findUnique({
    where: { id: bomId },
    select: { id: true, active: true, productId: true, product: { select: { sku: true } } },
  })
  if (!bom) return { kind: 'not-found', bomId }
  if (bom.productId) {
    return { kind: 'claimed', bomId, productId: bom.productId, sku: bom.product?.sku ?? bom.productId }
  }
  if (!bom.active) return { kind: 'already-inactive', bomId }

  // Every parent this row carries items for. A Bom is not necessarily one product's recipe.
  const items = await client.bomItem.findMany({
    where: { bomId },
    select: { parentProductId: true, parentProduct: { select: { sku: true, type: true } } },
  })

  // For each BOM-typed parent, is this the ONLY active Bom carrying its recipe? If so, deactivating
  // here would take that product out of planning entirely — the same silent unplannability the
  // refusal exists to prevent, just moved to a different product.
  const blockedBy: Array<{ productId: string; sku: string }> = []
  const parents = new Map<string, { sku: string; type: string }>()
  for (const item of items) {
    if (item.parentProduct) parents.set(item.parentProductId, item.parentProduct)
  }
  for (const [parentProductId, parent] of parents) {
    if (parent.type !== 'BOM') continue
    const otherActive = await client.bomItem.findMany({
      where: {
        parentProductId,
        bomId: { not: bomId },
        ...PLANNING_REACHABLE_BOM_EDGES,
      },
      select: { bomId: true },
      take: 1,
    })
    if (otherActive.length === 0) {
      blockedBy.push({ productId: parentProductId, sku: parent.sku })
    }
  }
  if (blockedBy.length > 0) return { kind: 'sole-recipe-for-other-parent', bomId, blockedBy }

  await client.bom.update({ where: { id: bomId }, data: { active: false } })

  // LOGGED, because this is a deliberate change to production data made outside the UI. `userId` is
  // nullable precisely so a command can record itself.
  await client.activityLog.create({
    data: {
      entityType: 'PRODUCT',
      entityId: [...parents.keys()][0] ?? null,
      action: 'updated',
      tag: 'manufacturing',
      level: 'WARNING',
      description:
        `Deactivated duplicate manufacturing BOM ${bomId} (${items.length} recipe line(s) KEPT) via `
        + `scripts/deactivate-duplicate-bom.ts${args.actor ? ` by ${args.actor}` : ''}`
        + `${args.database ? ` on database ${args.database}` : ''}. It was not any product's claimed `
        + 'recipe and was not the last active recipe for any BOM-typed parent.',
      metadata: {
        bomId,
        itemCount: items.length,
        parentProductIds: [...parents.keys()],
        // WHICH DATABASE, recorded in the row itself. A repair run by hand during a load window is
        // exactly the case where "was that done on stage or on production?" gets asked afterwards.
        database: args.database ?? null,
        reason: 'o3d-zjsb5.9 duplicate-recipe repair',
      },
    },
  })

  return { kind: 'deactivated', bomId, itemCount: items.length, parentProductIds: [...parents.keys()] }
}

/** The operator-facing line for each outcome, shared by the script and its tests. */
export function describeBomRecipeRepair(outcome: BomRecipeRepairOutcome): string {
  switch (outcome.kind) {
    case 'deactivated':
      return `Deactivated BOM ${outcome.bomId}. Its ${outcome.itemCount} recipe line(s) were KEPT, so past `
        + 'build orders still report correctly. Re-run the import.'
    case 'already-inactive':
      return `BOM ${outcome.bomId} is already inactive — nothing to do.`
    case 'not-found':
      return `No BOM with id ${outcome.bomId}.`
    case 'claimed':
      return `REFUSED: BOM ${outcome.bomId} is the live recipe of ${outcome.sku}. Deactivating it would make `
        + 'that product unplannable. If you meant to retire that product\'s recipe, change its type instead.'
    case 'wrong-database':
      return `REFUSED inside the transaction: expected to be connected to "${outcome.expected}" but the `
        + `server says this is "${outcome.actual}". Nothing was written. Check DATABASE_URL -- a cloned `
        + 'database holds the same BOM ids, so the id you passed cannot tell them apart.'
    case 'sole-recipe-for-other-parent':
      return `REFUSED: BOM ${outcome.bomId} is the only active recipe for `
        + `${outcome.blockedBy.map((row) => row.sku).join(', ')}. Deactivating it would remove `
        + 'that product from planning. Give that product its own recipe first.'
  }
}
