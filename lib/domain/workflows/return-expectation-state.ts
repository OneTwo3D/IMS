import { addMoney, compareDecimal, subtractMoney, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'

/**
 * The lifecycle of a return expectation: goods a refund sent back that have not arrived.
 *
 * The status is DERIVED from the lines, never set by hand, so it cannot disagree with them. Quantities are
 * compared as Decimals (the columns are 6dp) and never through floats.
 *
 *   outstanding = qty - received - writtenOff, summed over the lines
 *
 *   still outstanding   nothing yet accounted      IN_TRANSIT
 *                       some written off only      PARTIALLY_WRITTEN_OFF
 *                       any received               PARTIALLY_RECEIVED
 *   nothing outstanding nothing written off        RECEIVED
 *                       nothing received           WRITTEN_OFF
 *                       both                       RECEIVED (the per-line quantities carry the split)
 *
 * A written-off quantity can never be received afterwards, and a received quantity can never be written off:
 * both consume the same outstanding quantity, which the database also holds as a CHECK.
 */
export type ReturnExpectationStatusValue =
  | 'IN_TRANSIT'
  | 'PARTIALLY_RECEIVED'
  | 'RECEIVED'
  | 'WRITTEN_OFF'
  | 'PARTIALLY_WRITTEN_OFF'

export type ReturnExpectationLineQuantities = {
  qty: DecimalInput
  qtyReceived: DecimalInput
  qtyWrittenOff: DecimalInput
}

export function deriveReturnExpectationStatus(
  lines: readonly ReturnExpectationLineQuantities[],
): ReturnExpectationStatusValue {
  let received = toDecimal(0)
  let writtenOff = toDecimal(0)
  let outstanding = toDecimal(0)
  for (const line of lines) {
    const left = subtractMoney(subtractMoney(line.qty, line.qtyReceived), line.qtyWrittenOff)
    // A line over-accounted is a corrupt document (the CHECK forbids it): never read it as closed.
    if (compareDecimal(left, 0) < 0) throw new Error('return_expectation_line_over_accounted')
    outstanding = addMoney(outstanding, left)
    received = addMoney(received, line.qtyReceived)
    writtenOff = addMoney(writtenOff, line.qtyWrittenOff)
  }
  // An empty document is not "received": a closed status needs at least one line that was closed.
  if (lines.length === 0) throw new Error('return_expectation_has_no_lines')

  const anyReceived = compareDecimal(received, 0) > 0
  const anyWrittenOff = compareDecimal(writtenOff, 0) > 0
  if (compareDecimal(outstanding, 0) > 0) {
    if (anyReceived) return 'PARTIALLY_RECEIVED'
    if (anyWrittenOff) return 'PARTIALLY_WRITTEN_OFF'
    return 'IN_TRANSIT'
  }
  if (anyReceived) return 'RECEIVED'
  return 'WRITTEN_OFF'
}

/** A document still waiting on units: the "Returns in transit" list and its aging alert read this. */
export function isReturnExpectationOpen(status: ReturnExpectationStatusValue): boolean {
  return status === 'IN_TRANSIT' || status === 'PARTIALLY_RECEIVED' || status === 'PARTIALLY_WRITTEN_OFF'
}
