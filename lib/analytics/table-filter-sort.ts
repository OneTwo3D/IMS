/**
 * Filtering and sorting for the analytics stat tables (sales, purchase and inventory stats
 * clients), kept React-free so the rules below are unit-testable without mounting a page.
 *
 * WHY IT IS SHARED. The three clients each carried a private copy of this, and the copies had
 * already drifted — one of them silently answered `true` for any operator its own switch did not
 * implement. More to the point, a defect in the rule below is a defect in every tab of all three
 * pages at once, and the round of review that found it had to find it three times.
 *
 * WHAT AN UNKNOWN IS, AND WHY IT IS NOT A ZERO (o3d-iigc round 2, Codex finding 3). These tables
 * now carry figures that are deliberately `null`: a customer-aging net total whose credits are not
 * all on one proven basis, a refund's proportion-of-sale whose basis was never stamped. A `null`
 * there is an ADMISSION that the figure could not be established — the whole point of withholding
 * it rather than printing a number that looks authoritative.
 *
 * The previous comparator coerced that admission with `?? 0`, and the previous filter coerced it
 * with `Number(null)`. So a withheld figure sorted in among the genuine zeroes — telling the
 * reader it was the smallest value in the table, which is a claim about a number we had just said
 * we could not establish — and it matched `= 0`, and `< anything`, and was excluded by `> 0`.
 *
 * So, here:
 *
 *   * an unknown sorts LAST in BOTH directions. It has no position in the ordering; pinning it to
 *     the top of ascending order would only move the same false claim to the other end.
 *   * an unknown satisfies NO numeric comparison — the three-valued logic SQL uses for NULL.
 *     Not `< 100`, not `= 0`, and not `!= 0` either: "we cannot say" is not evidence that the
 *     figure differs from zero any more than that it equals it.
 *
 * THE RULE IS NOT INVENTED HERE. The product-profitability table in this same tree already sorts
 * its own nullable margin exactly this way — `if (va == null) return 1` outside the direction flip
 * — so these three tables were the outliers, not the new behaviour.
 *
 * TEXT OPERATORS KEEP THE EMPTY-STRING READING, deliberately. An absent barcode or MPN is an
 * established absence — the product genuinely has none — rather than a measurement we withheld, so
 * "does not contain X" is true of it and "contains X" is false, which is what a reader filtering a
 * text column means. Only the numeric operators are the ones that were making arithmetic claims.
 */

export type AnalyticsFilterRule = {
  field: string
  operator: string
  value: string
}

export type AnalyticsSortDir = 'asc' | 'desc'

/** What a table cell can hold. `null` covers both "no such field" and "withheld". */
export type AnalyticsCellValue = string | number | boolean | null

/**
 * Operators that compare the cell AS A NUMBER. An unknown answers none of them.
 *
 * `equals`/`is`/`is_not` are NOT in here: those are the text/select operators, which compare the
 * rendered string.
 */
const NUMERIC_OPERATORS: ReadonlySet<string> = new Set(['>', '>=', '<', '<=', '=', '!='])

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function cellValue(row: any, field: string): AnalyticsCellValue {
  const value = row[field]
  return value === undefined ? null : value
}

export function matchesFilterRule(value: AnalyticsCellValue, rule: AnalyticsFilterRule): boolean {
  // An unknown is not a quantity, so it answers no question about quantities. Falling through to
  // the cases below would ask `Number(null)`, which is 0 — a figure we did not have.
  if (value == null && NUMERIC_OPERATORS.has(rule.operator)) return false

  const v = value == null ? '' : String(value).toLowerCase()
  const rv = rule.value.toLowerCase()
  switch (rule.operator) {
    case 'contains': return v.includes(rv)
    case 'equals': case 'is': return v === rv
    case 'starts_with': return v.startsWith(rv)
    case 'not_contains': return !v.includes(rv)
    case 'is_not': return v !== rv
    case '>': return Number(value) > Number(rule.value)
    case '>=': return Number(value) >= Number(rule.value)
    case '<': return Number(value) < Number(rule.value)
    case '<=': return Number(value) <= Number(rule.value)
    case '=': return Number(value) === Number(rule.value)
    case '!=': return Number(value) !== Number(rule.value)
    default: return true
  }
}

/**
 * Order two cells. Unknowns go last whichever way the column is sorted, so the direction flip is
 * applied to the comparison of two KNOWN values only.
 */
export function compareCells(a: AnalyticsCellValue, b: AnalyticsCellValue, dir: AnalyticsSortDir): number {
  if (a == null || b == null) {
    if (a == null && b == null) return 0
    return a == null ? 1 : -1
  }
  const cmp = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))
  return dir === 'asc' ? cmp : -cmp
}

/**
 * Apply every non-empty rule, then sort. Array#sort is stable, so rows the comparator calls equal —
 * including every unknown in the sorted column — keep the order the server sent them in.
 */
export function filterAndSortRows<T extends object>(
  data: readonly T[],
  rules: readonly AnalyticsFilterRule[],
  sortCol: string | null,
  sortDir: AnalyticsSortDir,
): T[] {
  let result: readonly T[] = data
  for (const rule of rules) {
    if (!rule.value) continue
    result = result.filter((row) => matchesFilterRule(cellValue(row, rule.field), rule))
  }
  if (!sortCol) return [...result]
  const col = sortCol
  return [...result].sort((a, b) => compareCells(cellValue(a, col), cellValue(b, col), sortDir))
}

/**
 * The columns a tab can actually render, out of the columns something ASKED it to render.
 *
 * o3d-8u4h. A saved view stores its column keys verbatim in the database, and a column key can stop
 * existing — the supplier-aging buckets were renamed twice, first away from `overdue*` (which
 * claimed a relation to a due date the report does not measure) and then away from `unsettled*`
 * (which claimed a settlement a payment marker does not prove). The stat tables rendered the header
 * and the body from the SAME key list but disagreed about unknown keys: the header skipped a key it
 * had no field definition for, and the body still emitted a cell for it. One missing header and a
 * full row of cells means EVERY COLUMN AFTER IT SHIFTS ONE PLACE LEFT, so the figures are read under
 * the wrong headings — a silent misreading, not a visible break.
 *
 * Filtering once, before every loop of a render path, is what keeps those loops agreeing by
 * construction. It is a general property of these tables rather than a supplier-aging fix: any
 * renamed or retired column in any of the three stat clients reaches this same shape through an old
 * saved view. Round 2 found the fix had been applied to ONE of the four render paths — the purchase
 * page's generic table — while the sales page's generic table, and three footer rows that emit a
 * `<td>` for every key unconditionally, still shifted.
 */
export function presentColumns(
  columns: readonly string[],
  fields: readonly { key: string }[],
): string[] {
  return presentColumnKeys(columns, fields.map((field) => field.key))
}

/**
 * The same filter where the authority is a RENDERER MAP rather than a field list.
 *
 * The products tabs render from a `Record<string, {label, render, footer}>` whose keys are not
 * identical to the tab's filterable field list, and the honest filter for a render path is "what
 * this loop can actually draw". Passing the field list there would let a key the map has no entry
 * for through — which is the defect, one indirection along.
 */
export function presentColumnKeys(columns: readonly string[], known: Iterable<string>): string[] {
  const keys = known instanceof Set ? known : new Set(known)
  return columns.filter((key) => keys.has(key))
}

// ---------------------------------------------------------------------------
// Loading a saved view that outlived part of the report
// ---------------------------------------------------------------------------

export type SavedViewFilterLike = { field: string; operator: string; value: string }

export type SanitisedSavedView<F extends SavedViewFilterLike> = {
  /** The saved column order, minus the keys this tab no longer has. */
  columns: string[]
  /** The saved filters, minus the rules whose field this tab no longer has. */
  filters: F[]
  droppedColumns: string[]
  droppedFilterFields: string[]
  /**
   * A SENTENCE FOR THE READER, or null when the view loaded intact. Rendered persistently above the
   * table — not as a tooltip, because the reader who most needs it is the one who cannot hover.
   */
  notice: string | null
}

/**
 * o3d-8u4h round 2. A saved view is loaded verbatim, and the report it was saved against moves.
 *
 * Columns were already being filtered at render. FILTERS WERE NOT, and a filter rule is the more
 * dangerous half: a rule on a field the rows no longer carry reads as an unknown for every row, and
 * an unknown answers no numeric comparison (the three-valued rule this module already applies), so
 * the rule REJECTS EVERY ROW. The operator sees an empty report and no reason for it — the table
 * says "0 rows" and nothing else, which reads as "this supplier has no bills" rather than "your
 * saved filter names a column that no longer exists".
 *
 * Dropping the rule rather than applying it is the choice that fails visibly instead of silently:
 * the report shows its rows, and the notice says which rule was dropped and why. Keeping the rule
 * would preserve a filter the reader cannot see, edit or reason about, and preserving it "for
 * fidelity" is fidelity to a question nobody can now ask.
 */
export function sanitiseSavedView<F extends SavedViewFilterLike>(
  view: { name?: string; columns: readonly string[]; filters: readonly F[] },
  fields: readonly { key: string }[],
): SanitisedSavedView<F> {
  const known = new Set(fields.map((field) => field.key))
  const columns = view.columns.filter((key) => known.has(key))
  const droppedColumns = view.columns.filter((key) => !known.has(key))
  const filters = view.filters.filter((rule) => known.has(rule.field))
  const droppedFilterFields = view.filters.filter((rule) => !known.has(rule.field)).map((rule) => rule.field)
  return {
    columns,
    filters,
    droppedColumns,
    droppedFilterFields,
    notice: savedViewDropNotice(view.name, droppedColumns, droppedFilterFields),
  }
}

/** The sentence `sanitiseSavedView` puts on screen. Exported so it can be asserted on its own. */
export function savedViewDropNotice(
  name: string | undefined,
  droppedColumns: readonly string[],
  droppedFilterFields: readonly string[],
): string | null {
  if (droppedColumns.length === 0 && droppedFilterFields.length === 0) return null
  const subject = name ? `Saved view “${name}”` : 'This saved view'
  const parts: string[] = []
  if (droppedColumns.length > 0) {
    parts.push(
      `${droppedColumns.length === 1 ? 'a column it saved is' : `${droppedColumns.length} columns it saved are`}` +
      ` no longer on this report (${droppedColumns.join(', ')}), so ${droppedColumns.length === 1 ? 'it was' : 'they were'} left out`,
    )
  }
  if (droppedFilterFields.length > 0) {
    parts.push(
      `${droppedFilterFields.length === 1 ? 'a filter names' : `${droppedFilterFields.length} filters name`}` +
      ` a field this report no longer has (${droppedFilterFields.join(', ')}), and ${droppedFilterFields.length === 1 ? 'it was dropped rather than applied' : 'they were dropped rather than applied'}` +
      ': a filter on an absent field matches no row, so keeping it would have emptied the table with no explanation',
    )
  }
  return `${subject}: ${parts.join('; and ')}. Everything else is as you saved it.`
}

// ---------------------------------------------------------------------------
// Whose saved view is it?
// ---------------------------------------------------------------------------

/**
 * o3d-8u4h round 3. THE THREE STAT PAGES SHARE ONE SAVED-VIEW RECORD, AND ONE OF THEM READ ALL OF IT.
 *
 * `getSavedViews` reads a single `Setting` row — `sales_stats_views` — and all three clients save
 * into it. They tell their views apart by a PREFIX on the stored tab key: the purchase page writes
 * `po_<tab>`, the inventory page writes `inv_<tab>`, and the sales page writes its tab key bare.
 *
 * The purchase and inventory pickers filtered on that prefix. THE SALES PICKER OFFERED EVERY VIEW
 * IN THE RECORD, including the other two pages' — and `loadView` then indexed its own
 * `TAB_FIELDS` with the stored key. `TAB_FIELDS['po_aging']` is `undefined`, `sanitiseSavedView`
 * calls `.map` on it, and the whole Sales Analytics page comes down with a TypeError. Not a corner
 * case: saving a purchase view and then opening Sales is all it takes, and the crash is on the
 * REPORT, not on the view.
 *
 * That is the same defect family this module was written for — A KEY STORED SOMEWHERE ELSE, USED
 * WITHOUT VALIDATION — one level up from the column keys. `presentColumns` already refuses to
 * render a column key the tab does not own; this refuses to load a TAB key the page does not own.
 *
 * A PREFIX TEST IS NOT ENOUGH ON ITS OWN, which is why this resolves against the page's own tab
 * list rather than just stripping. `po_` on the front does not prove the remainder is still a tab:
 * a retired purchase tab would sail through `startsWith('po_')` and land back on `TAB_FIELDS[...]
 * === undefined` — the identical crash, from the page that thought it was already filtered. And
 * the sales page cannot use a prefix test at all, because its prefix is the empty string, which
 * every stored key starts with; membership in its own tab list is the only thing that separates
 * `aging` from `po_aging`.
 *
 * Returns the page's OWN tab key, or null for a view that belongs to another report.
 */
export function resolveSavedViewTab<T extends string>(
  viewTab: string,
  prefix: string,
  ownTabs: readonly T[],
): T | null {
  if (prefix.length > 0 && !viewTab.startsWith(prefix)) return null
  const key = viewTab.slice(prefix.length)
  return (ownTabs as readonly string[]).includes(key) ? (key as T) : null
}

/**
 * The views a picker may offer: the ones this page can actually load.
 *
 * Filtering the picker is the fix a reader sees; `resolveSavedViewTab` in the load path is the fix
 * that holds. Both, because the picker's list is a render of props that can be a revision behind
 * the click — and because a guard nothing can reach is a guard nobody can test.
 */
export function ownedSavedViews<V extends { tab: string }, T extends string>(
  views: readonly V[],
  prefix: string,
  ownTabs: readonly T[],
): V[] {
  return views.filter((view) => resolveSavedViewTab(view.tab, prefix, ownTabs) !== null)
}

/**
 * What the page says when it is asked for a view it cannot load. Same persistent block as
 * `savedViewDropNotice` — the reader who most needs it is the one who cannot hover — and it names
 * the stored tab, because that is the only thing that tells them which report to open instead.
 */
export function foreignSavedViewNotice(name: string | undefined, viewTab: string): string {
  const subject = name ? `Saved view “${name}”` : 'That saved view'
  return `${subject} belongs to a different analytics report (it was saved on the “${viewTab}” tab), so it was not loaded here. Nothing on this page has changed. Open it from the report it was saved on.`
}
