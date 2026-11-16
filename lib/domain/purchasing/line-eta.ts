/**
 * Per-line estimated delivery on a purchase order.
 *
 * A line's own date wins; a line with none inherits the order's header date. This is the ONE place that rule lives:
 * PO detail, the supplier PDF, exports, analytics and the reorder report all call it. Receiving never writes the
 * line date (it only moves qtyReceived), so a partial receipt keeps it.
 */

export type EtaDate = Date | string | null | undefined

/** The date that applies to a line: its own, else the order's. Null when neither is set. */
export function effectiveLineEta<T extends EtaDate>(lineEta: T, headerEta: EtaDate): Date | null {
  const own = toDate(lineEta)
  if (own) return own
  return toDate(headerEta)
}

/** True when the line carries its own date that differs (by calendar day, UTC) from the order's header date. */
export function lineEtaDiffersFromHeader(lineEta: EtaDate, headerEta: EtaDate): boolean {
  const own = toDate(lineEta)
  if (!own) return false
  const header = toDate(headerEta)
  if (!header) return true
  return dayKey(own) !== dayKey(header)
}

/** Parses a form/API date string. Blank means "inherit the header" (null); anything unparseable throws. */
export function parseLineEtaInput(value: string | null | undefined): Date | null {
  if (value == null) return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  const parsed = new Date(trimmed)
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid line delivery date: ${trimmed}`)
  return parsed
}

function toDate(value: EtaDate): Date | null {
  if (value == null || value === '') return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10)
}
