/**
 * THE CLAIMED RECIPE -- the one `Bom` row a planning reader may count for a product.
 *
 * `boms.productId` is UNIQUE and nullable. A Bom whose `productId` is a product CLAIMS that product:
 * it is the recipe the importer, the editors and `createManufacturingOrder` all write, and the only
 * one a second claim cannot exist beside. A Bom with a NULL `productId` is a legacy / hand-written
 * row. It can still hold `bom_items` for the same parent and still be `active`, so a reader that
 * sums "every active BomItem for this parent" counts the claimed recipe AND every stray duplicate,
 * and component demand doubles.
 *
 * So every reader that PLANS or EXPLODES demand scopes to the claim, through the helpers below, and
 * `tests/products/claimed-bom-reader-census.test.ts` fails if a planning file reads `bomItem` / `bom`
 * without importing this module. Readers that deliberately see every row (cycle checks, drift
 * reports, exports, repair) are NOT planning readers; the census lists each with its reason.
 * Retired Boms stay readable for history: nothing here deletes or hides a row, it only chooses
 * which rows planning counts.
 */

/** Prisma `where` fragment for a Bom: only claimed recipes. Spread into a `bom: { ... }` filter. */
export const CLAIMED_BOM_WHERE = { productId: { not: null } } as const

/** Prisma `select` fragment: what `isClaimedBomItem` needs from the item's Bom. */
export const CLAIMED_BOM_SELECT = { productId: true } as const

export type ClaimedBomItemShape = {
  parentProductId: string
  bom: { productId: string | null }
}

/**
 * Is this item a line of its parent's CLAIMED recipe? Prisma cannot compare `bom_items.parentProductId`
 * with `boms.productId` in a `where`, so the equality is applied to the rows read.
 */
export function isClaimedBomItem(item: ClaimedBomItemShape): boolean {
  return item.bom.productId !== null && item.bom.productId === item.parentProductId
}

/** The items of `rows` that belong to their parent's claimed recipe, in the order read. */
export function claimedBomItems<T extends ClaimedBomItemShape>(rows: readonly T[]): T[] {
  return rows.filter(isClaimedBomItem)
}
