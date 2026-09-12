/**
 * RETIRING A PENDING WMS ASN RESERVATION WITHOUT DESTROYING THE RECORD THAT UNITS
 * LANDED (o3d-zzgp, Codex round-1 HIGH-1 and HIGH-2).
 *
 * THE PREMISE OF THE WHOLE ISSUE, one sentence: the WMS stock-sync alignment brings
 * transfer units into stock and lays their cost layers by crediting
 * `wms_asn_line_maps.qtyAccountedViaSnapshot`, and it NEVER writes
 * `stock_transfer_lines.qtyReceived`. So for those units that ASN line-map row is the
 * ONLY record that they arrived and were costed. Delete the row and
 * `loadTransferLineLandedQty` answers zero, the line reads as entirely outstanding
 * again, ASN creation reopens for stock that is already on the shelf, and the next
 * receipt re-slices the dispatch snapshot from offset zero and lays a second set of
 * cost layers over the first.
 *
 * `createMintsoftTransferAsn` had FOUR routes that deleted exactly those rows, and
 * every one of them is reached by the same event that puts the credit there:
 *
 *   1. a retry that finds nothing outstanding left deleted its `wms_asn_maps` row,
 *      which cascades to the line maps (the round-1 HIGH-1);
 *   2. the same retry `deleteMany`d the line maps of lines that had dropped out of
 *      the outstanding set — and a line drops out precisely BECAUSE the alignment
 *      landed it;
 *   3. `discardPendingReservation` deleted the whole reservation when the
 *      revalidation found the outstanding quantities had moved — and an interleaving
 *      alignment is what moves them;
 *   4. `finalizePendingAsn` deleted the reservation when the remote turned out to
 *      already have the ASN under another id.
 *
 * THE RULE THIS MODULE EXISTS TO IMPOSE: a pending reservation may be deleted only
 * while it holds NO credit. One that holds credit is RETIRED instead —
 *
 *   · `closedAt` is set, so it leaves every "open ASN" population at once: the
 *     alignment's candidate query (`asn.closedAt IS NULL`), the reuse and
 *     reuse-as-pending lookups in the create action, and the overdue-ASN watchdog.
 *     Nothing will push it, resize it or credit it again.
 *   · each line's `expectedQty` is SHRUNK to exactly what that row has already been
 *     credited, so the row's own residue (`expectedQty − credit`, the ASN-scope
 *     quantity in lib/domain/inventory/transfer-landed-quantity.ts) is zero by
 *     construction rather than by a `closedAt` filter somebody has to remember. It
 *     also keeps `getProductIncomingStock`'s ASN arm honest: that arm counts
 *     `expectedQty − credit` and would otherwise report a retired ten-unit
 *     reservation with six credited units as four units still due in, for ever.
 *   · the numbers that were shrunk away are written to the row's `note`, which is
 *     what that column is for. The credit columns themselves are NEVER touched — they
 *     are the thing being preserved.
 *
 * AND THAT IS THE OTHER HALF, HIGH-2. A retry used to keep the credited row and
 * re-point its `expectedQty` at the FRESH outstanding quantity: ten expected became
 * four while six credited units stayed on the row. Booked-in reconciliation then
 * compared a remote received of four against a raw snapshot credit of six, emitted
 * `remote_regression` and blocked approval permanently — and worse,
 * `reconcileBookedInQuantities` clamps the credit to the new expectation and treats
 * the four fresh units as already covered by it, so they would have added no stock at
 * all. The historical credit and the fresh remote expectation are two different
 * quantities about two different populations of units, so they are now two different
 * rows on two different `wms_asn_maps`: the retired one carries the credit, and a
 * freshly created reservation carries the four-unit expectation with a zero credit.
 */

import type { Decimal, DecimalInput } from '@/lib/domain/math/decimal'
import { roundQuantity, toDecimal } from '@/lib/domain/math/decimal'

/**
 * Matching WMS_RECEIPT_QTY_EPSILON and TRANSFER_LANDED_QTY_EPSILON. Re-declared for
 * the same reason the landed-quantity module re-declares it: this module is imported
 * by the WMS action layer and a cycle through it would make load order load-bearing.
 */
export const PENDING_ASN_CREDIT_EPSILON = 0.0001

/** The columns of one `wms_asn_line_maps` row this module needs to see. */
export type PendingAsnReservationLine = {
  id: string
  sourceLineId: string
  expectedQty: DecimalInput
  qtyAccountedViaSnapshot: DecimalInput
  qtyAccountedViaReceipt: DecimalInput
  lastProcessedReceivedQty: DecimalInput
}

export type RetiredAsnReservationLine = {
  asnLineMapId: string
  sourceLineId: string
  /** The row's new `expectedQty`: exactly what it has already been credited. */
  retainedCreditQty: Decimal
  retainedCreditQtyNumber: number
  /** What the row expected before retirement, for the note and for the logs. */
  originalExpectedQty: number
}

export type PendingAsnReservationRetirement = {
  /**
   * There is ONE reason and it is carried anyway, so a second one cannot be added
   * without every call site seeing it. `credited` means at least one line of the
   * reservation holds credit, which is the only thing that makes a reservation
   * unsafe to delete or to resize in place — "nothing outstanding" on its own does
   * not: a reservation with nothing outstanding and no credit anywhere holds no
   * evidence, and is deleted exactly as before.
   */
  reason: 'credited'
  lines: RetiredAsnReservationLine[]
}

/**
 * How much of this ASN row has already been claimed as landed.
 *
 * The MAX of the three counters, never a sum. `qtyAccountedViaSnapshot` (what the
 * alignment credited here) and `lastProcessedReceivedQty` (what the WMS last reported
 * booked in here) describe the SAME units from two sides, and
 * `qtyAccountedViaReceipt` is the portion of the snapshot credit that a receipt has
 * since folded into `stock_transfer_lines.qtyReceived` — still the same units, and it
 * can exceed the snapshot column after a remote regression. Summing them would
 * inflate a retired row's retained expectation and hand `getProductIncomingStock` a
 * negative residue to clamp; the max is the smallest figure that covers every unit
 * any of the three columns speaks for.
 */
export function creditedQtyOnPendingAsnLine(line: PendingAsnReservationLine): Decimal {
  let credited = toDecimal(0)
  for (const candidate of [line.qtyAccountedViaSnapshot, line.qtyAccountedViaReceipt, line.lastProcessedReceivedQty]) {
    const value = toDecimal(candidate)
    if (value.gt(credited)) credited = value
  }
  return roundQuantity(credited, 6)
}

/** Does this row hold evidence that units landed against it? */
export function pendingAsnLineCarriesCredit(line: PendingAsnReservationLine): boolean {
  return creditedQtyOnPendingAsnLine(line).gt(PENDING_ASN_CREDIT_EPSILON)
}

/** Does ANY row of this reservation hold such evidence? */
export function pendingAsnReservationCarriesCredit(
  lines: ReadonlyArray<PendingAsnReservationLine>,
): boolean {
  return lines.some(pendingAsnLineCarriesCredit)
}

/**
 * What must happen to this pending reservation — `null` when it holds no credit and
 * may therefore be deleted, or resized in place, exactly as before.
 *
 * THE DECISION IS OVER THE WHOLE RESERVATION, NOT PER LINE. An in-place resize
 * rewrites one line's `expectedQty` while leaving its siblings alone, so a
 * reservation is only safe to resize when NO row holds credit; one credited row
 * anywhere means the whole reservation is retired and replaced. That is deliberately
 * blunt: the alternative is a per-line rule whose two halves have to stay consistent
 * with each other, which is the shape of the defect this replaces.
 */
export function planPendingAsnReservationRetirement(
  lines: ReadonlyArray<PendingAsnReservationLine>,
): PendingAsnReservationRetirement | null {
  if (!pendingAsnReservationCarriesCredit(lines)) return null

  return {
    reason: 'credited',
    lines: lines.map((line) => {
      const credited = creditedQtyOnPendingAsnLine(line)
      return {
        asnLineMapId: line.id,
        sourceLineId: line.sourceLineId,
        retainedCreditQty: credited,
        retainedCreditQtyNumber: credited.toNumber(),
        originalExpectedQty: toDecimal(line.expectedQty).toNumber(),
      }
    }),
  }
}

/** The note left on a retired row, naming both figures. */
export function retiredAsnLineNote(line: RetiredAsnReservationLine): string {
  return 'o3d-zzgp: reservation retired on retry; expectation shrunk from '
    + `${line.originalExpectedQty} to the ${line.retainedCreditQtyNumber} unit(s) already credited here. `
    + 'The credit columns are the only record that those units landed (the WMS alignment never '
    + 'writes stock_transfer_lines.qtyReceived), so this row is closed rather than deleted and any '
    + 'remaining outstanding quantity is reserved on a NEW ASN.'
}

/** The minimum a client must expose for `retirePendingAsnReservation`. */
export type PendingAsnRetirementClient = {
  wmsAsnMap: {
    update: (args: {
      where: { id: string }
      data: { closedAt: Date; sloAlertedAt: null }
    }) => Promise<unknown>
  }
  wmsAsnLineMap: {
    update: (args: {
      where: { id: string }
      data: { expectedQty: string; note: string }
    }) => Promise<unknown>
  }
}

/**
 * Apply a retirement. Runs in the caller's transaction, under whatever locks the
 * caller already holds — the transfer-ASN create holds the transfer row FOR UPDATE.
 *
 * `sloAlertedAt` is cleared alongside `closedAt` for tidiness and NOT because anything
 * needs it: the overdue-ASN watchdog (lib/domain/wms/watchdog-sweep.ts) excludes
 * `CREATE_PENDING` and `CREATE_IN_FLIGHT` outright — a reservation was never created in
 * the WMS, so an overdue-SHIPMENT alert about it would be misleading — so the column is
 * already null on every row that reaches here. Written anyway so a retired row cannot
 * carry an alert marker into its closed life if that exclusion is ever relaxed.
 *
 * The note is SET, not appended. These rows are created by the ASN-create action with
 * `note` null and a retired reservation is never reused, so there is nothing to
 * append to; a row that somehow arrived here twice would say so by having been closed
 * already.
 */
export async function retirePendingAsnReservation(
  client: PendingAsnRetirementClient,
  asnMapId: string,
  retirement: PendingAsnReservationRetirement,
  now: Date = new Date(),
): Promise<void> {
  await client.wmsAsnMap.update({
    where: { id: asnMapId },
    data: { closedAt: now, sloAlertedAt: null },
  })

  for (const line of retirement.lines) {
    await client.wmsAsnLineMap.update({
      where: { id: line.asnLineMapId },
      data: {
        // Decimal(12,4) in the schema; a string keeps the value exact through Prisma.
        expectedQty: roundQuantity(line.retainedCreditQty, 4).toFixed(4),
        note: retiredAsnLineNote(line),
      },
    })
  }
}
