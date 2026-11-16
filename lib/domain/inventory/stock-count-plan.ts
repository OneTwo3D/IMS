/**
 * Pure helpers for PREPARED stocktakes: the operator chooses the product list before counting starts, and keeps
 * editing it while the count is open. The write path is app/actions/stock-counts.ts; the rules live here so they
 * are unit-testable without Prisma.
 *
 * Line states that already exist on a count line:
 *   - counted:     countedQty is not null
 *   - reconciled:  reconciledQty is not null (stamped by Reconcile; cleared when the counted figure changes)
 * A line is REMOVABLE only while it is neither. A count is EDITABLE while it is DRAFT or IN_PROGRESS.
 */

export type StockCountStatusValue = 'DRAFT' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED'

/** Product types a stock count can hold: they carry their own on-hand. VARIABLE (a parent), KIT (virtual) and NON_INVENTORY have none. */
export const STOCK_COUNTABLE_PRODUCT_TYPES = ['SIMPLE', 'VARIANT', 'BOM'] as const
export type StockCountableProductType = (typeof STOCK_COUNTABLE_PRODUCT_TYPES)[number]

export function isStockCountableProductType(type: string): type is StockCountableProductType {
  return (STOCK_COUNTABLE_PRODUCT_TYPES as readonly string[]).includes(type)
}

/** Whether the plan (the product list) of a count with this status can still be changed. */
export function isStockCountPlanEditable(status: StockCountStatusValue): boolean {
  return status === 'DRAFT' || status === 'IN_PROGRESS'
}

export type PlanLineState = { countedQty: number | null; reconciledQty: number | null }

export type LineRemovability =
  | { removable: true }
  | { removable: false; reason: 'COUNTED' | 'RECONCILED' | 'COUNTED_AND_RECONCILED' }

export function lineRemovability(line: PlanLineState): LineRemovability {
  const counted = line.countedQty != null
  const reconciled = line.reconciledQty != null
  if (counted && reconciled) return { removable: false, reason: 'COUNTED_AND_RECONCILED' }
  if (counted) return { removable: false, reason: 'COUNTED' }
  if (reconciled) return { removable: false, reason: 'RECONCILED' }
  return { removable: true }
}

/** Why the plan cannot be edited, in operator wording; null when it can. */
export function describePlanLocked(status: StockCountStatusValue): string | null {
  if (status === 'COMPLETED') return 'This stock count has already been posted, so its product list can no longer be changed.'
  if (status === 'CANCELLED') return 'This stock count was cancelled, so its product list can no longer be changed.'
  return null
}

export type RemovalCheck = {
  /** Requested line ids that can be removed. */
  removableIds: string[]
  /** Requested line ids that are not on this count at all. */
  unknownIds: string[]
  blocked: Array<{ lineId: string; sku: string; reason: Exclude<LineRemovability, { removable: true }>['reason'] }>
}

export function checkLineRemoval(
  requestedLineIds: string[],
  lines: Array<{ id: string; sku: string } & PlanLineState>,
): RemovalCheck {
  const byId = new Map(lines.map((l) => [l.id, l]))
  const removableIds: string[] = []
  const unknownIds: string[] = []
  const blocked: RemovalCheck['blocked'] = []
  for (const id of new Set(requestedLineIds)) {
    const line = byId.get(id)
    if (!line) { unknownIds.push(id); continue }
    const r = lineRemovability(line)
    if (r.removable) removableIds.push(id)
    else blocked.push({ lineId: id, sku: line.sku, reason: r.reason })
  }
  return { removableIds, unknownIds, blocked }
}

/** Operator-facing refusal for lines that can no longer be taken off the count. Names every product and says what to do. */
export function describeUnremovableLines(blocked: RemovalCheck['blocked']): string {
  const why = (r: RemovalCheck['blocked'][number]['reason']) =>
    r === 'RECONCILED' ? 'reconciled' : r === 'COUNTED' ? 'already counted' : 'already counted and reconciled'
  const parts = blocked.map((b) => `${b.sku} (${why(b.reason)})`)
  return `Nothing was removed: ${blocked.length} product(s) can no longer be taken off this count because they have been counted or reconciled: ${parts.join(', ')}. `
    + 'To take a line off, clear its counted quantity and save the counts first; otherwise leave it on the count and it will be posted with the rest.'
}

export type AdditionCheck = {
  /** Product ids to add: de-duplicated, in request order, none already on the count. */
  toAdd: string[]
  /** Requested product ids already on the count. */
  alreadyInCount: string[]
}

export function checkLineAddition(requestedProductIds: string[], existingProductIds: Iterable<string>): AdditionCheck {
  const existing = new Set(existingProductIds)
  const toAdd: string[] = []
  const alreadyInCount: string[] = []
  const seen = new Set<string>()
  for (const id of requestedProductIds) {
    if (seen.has(id)) continue
    seen.add(id)
    if (existing.has(id)) alreadyInCount.push(id)
    else toAdd.push(id)
  }
  return { toAdd, alreadyInCount }
}

/** Operator-facing refusal when a request names products already on the count. */
export function describeAlreadyInCount(skus: string[]): string {
  return `Nothing was added: ${skus.length} product(s) are already on this count: ${skus.join(', ')}. A product can only be on a count once, so untick them and add the rest.`
}

/** Operator-facing refusal for products that cannot be counted, with the reason per product. */
export function describeNotCountable(items: Array<{ sku: string; why: 'ARCHIVED' | 'TYPE' | 'MISSING' }>): string {
  const wording = (w: 'ARCHIVED' | 'TYPE' | 'MISSING') =>
    w === 'ARCHIVED' ? 'archived' : w === 'TYPE' ? 'not a stocked product type (parent, kit or non-inventory item)' : 'no longer exists'
  return `Nothing was added: ${items.length} product(s) cannot be counted: ${items.map((i) => `${i.sku} (${wording(i.why)})`).join(', ')}.`
}

/** Remove the products a request repeats or that are already on the count so a client can mark them; keeps order. */
export function mergeSelection(current: string[], picked: string[], unpicked: string[]): string[] {
  const drop = new Set(unpicked)
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of [...current, ...picked]) {
    if (drop.has(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

// ---------------------------------------------------------------------------
// Product search filters
// ---------------------------------------------------------------------------

/** State filter in the selection window: the product's lifecycle status. */
export const PRODUCT_STATE_FILTERS = ['OPERATIONAL', 'ARCHIVED', 'ALL'] as const
export type ProductStateFilter = (typeof PRODUCT_STATE_FILTERS)[number]

export type ProductSearchFilters = {
  query: string
  types: StockCountableProductType[]
  state: ProductStateFilter
  categoryId: string | null
}

/** Trim the query; keep only countable types (an empty list means "all countable types"). */
export function normaliseProductSearchFilters(input: {
  query?: string | null
  types?: string[] | null
  state?: string | null
  categoryId?: string | null
}): ProductSearchFilters {
  const types = [...new Set((input.types ?? []).filter(isStockCountableProductType))]
  const state = (PRODUCT_STATE_FILTERS as readonly string[]).includes(input.state ?? '') ? (input.state as ProductStateFilter) : 'OPERATIONAL'
  return {
    query: (input.query ?? '').trim().slice(0, 100),
    types,
    state,
    categoryId: input.categoryId && input.categoryId.length > 0 ? input.categoryId : null,
  }
}

export type StockCountListFilter = 'ALL' | 'DRAFT' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED'

export function filterCountsByStatus<T extends { status: StockCountStatusValue }>(counts: T[], filter: StockCountListFilter): T[] {
  return filter === 'ALL' ? counts : counts.filter((c) => c.status === filter)
}
