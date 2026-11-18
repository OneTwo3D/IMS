// ---------------------------------------------------------------------------
// CSV cell escaping with the formula-injection guard. No Node imports, so browser-built exports can use it too.
// ---------------------------------------------------------------------------

// Characters that trigger formula evaluation in Excel / LibreOffice / Google Sheets
// when they appear at the start of a cell. We neutralise by prefixing with `'`.
const FORMULA_PREFIX = /^[=+\-@\t\r]/
const NUMERIC_LITERAL = /^-?\d+(?:\.\d+)?$/

/**
 * True when the exporter writes `value` with a leading apostrophe (the formula guard in `escapeField`). A round-trip
 * importer uses it to tell an unedited cell the guard changed from one an operator typed, by comparing against what the
 * download held; it must never strip an apostrophe on its own, because text such as `'=SUM(1)` is exported as it is.
 */
export function csvFormulaGuardApplies(value: string): boolean {
  return FORMULA_PREFIX.test(value) && !NUMERIC_LITERAL.test(value)
}

/** Escape a single value for CSV output */
export function escapeField(value: unknown): string {
  if (value === null || value === undefined) return ''
  let str = String(value)
  // CSV injection mitigation — see OWASP "Formula Injection".
  // Preserve plain numeric literals so exported quantity/currency fields
  // remain re-importable without carrying a leading apostrophe.
  if (FORMULA_PREFIX.test(str) && !NUMERIC_LITERAL.test(str)) str = "'" + str
  // Quote if contains comma, quote, newline
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"'
  }
  return str
}

/** Build a CSV from a header row and positional rows, every cell through the formula guard. */
export function buildGuardedCsv(headers: string[], rows: unknown[][], lineBreak = '\n'): string {
  // wms-connector-boundary-ok: 2026-11-18: generic CSV row join over caller-supplied cells, spells no connector id.
  return [headers, ...rows].map((r) => r.map(escapeField).join(',')).join(lineBreak)
}
