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
 * existing — the supplier-aging buckets were renamed from `overdue*` to `unsettledBilled*` precisely
 * because "overdue" claimed a relation the report does not measure. The stat tables then rendered
 * the header and the body from the SAME key list but disagreed about unknown keys: the header
 * skipped a key it had no field definition for, and the body still emitted a cell for it. One
 * missing header and a full row of cells means EVERY COLUMN AFTER IT SHIFTS ONE PLACE LEFT, so the
 * figures are read under the wrong headings — a silent misreading, not a visible break.
 *
 * Filtering once, here, is what keeps the two loops agreeing by construction. It is a general
 * property of these tables rather than a supplier-aging fix: any renamed or retired column in any of
 * the three stat clients reaches this same shape through an old saved view.
 */
export function presentColumns(
  columns: readonly string[],
  fields: readonly { key: string }[],
): string[] {
  const known = new Set(fields.map((field) => field.key))
  return columns.filter((key) => known.has(key))
}
