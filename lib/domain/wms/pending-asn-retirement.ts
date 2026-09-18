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

import type { Prisma } from '@/app/generated/prisma/client'
import type { Decimal, DecimalInput } from '@/lib/domain/math/decimal'
import { roundQuantity, toDecimal } from '@/lib/domain/math/decimal'
import {
  lockStockTransfers,
  lockWmsAsnLineMaps,
  lockWmsAsnMaps,
} from '@/lib/domain/wms/transfer-asn-lock-order'

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
 * Apply a retirement. Runs in the caller's transaction. Call it through
 * `disposePendingTransferAsnReservation` below, which takes the transfer, header and
 * line locks and re-reads the credit before deciding (o3d-zzgp r3) — a retirement
 * planned from an unlocked read is the round-3 defect with a different last statement.
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

// ---------------------------------------------------------------------------
// THE DECISION MUST BE HELD ACROSS THE ACT IT GUARDS (o3d-zzgp, Codex round-3 HIGH)
// ---------------------------------------------------------------------------

/**
 * Round 2's rule above — delete only while nothing is credited — was right, and one
 * of its call sites checked it and then acted in a SEPARATE autocommit statement.
 * `discardPendingReservation` read the line maps, decided "uncredited", and deleted
 * the header in its own statement. A WMS stock-sync alignment committing in between
 * credits `qtyAccountedViaSnapshot` on one of those lines; the delete then cascades
 * the newly credited line, and the only record that those units arrived goes with
 * it. A live check is not a held check.
 *
 * THE FIX IS THE LOCK. The credit read, the retire-or-delete decision and the
 * disposal all happen in ONE transaction, after taking the established order from
 * lib/domain/wms/transfer-asn-lock-order.ts — step 2 `stock_transfers`, step 3
 * `wms_asn_maps`, step 4 `wms_asn_line_maps` — and every credit writer takes at least
 * one of those before writing:
 *
 *   · the alignment (lib/connectors/mintsoft/sync/stock-sync.ts) takes 2 → 3 → 4 and
 *     only then increments `qtyAccountedViaSnapshot`, re-reading its candidates under
 *     those locks;
 *   · booked-in reconciliation takes its step-2 parents, then 3, then 4, before it
 *     writes `qtyAccountedViaReceipt` / `lastProcessedReceivedQty`;
 *   · `receiveTransfer`'s absorb takes 2 and 4 before writing `qtyAccountedViaReceipt`.
 *
 * So once this function holds the three, no credit can change under the decision,
 * and an alignment that arrives meanwhile waits on the transfer row, re-reads after
 * this commits, and finds the reservation gone or closed.
 *
 * THE WHERE CLAUSE IS THE BACKSTOP, NOT THE FIX. The header delete also carries
 * `UNCREDITED_ASN_MAP_WHERE`, so a delete that somehow ran without the locks still
 * refuses a reservation whose lines visibly hold credit. It does NOT close the race
 * by itself, and must not be mistaken for doing so: under READ COMMITTED the
 * `NOT EXISTS` is evaluated against the DELETE statement's own snapshot, and the
 * `ON DELETE CASCADE` to the line maps runs afterwards against a newer one, so a
 * credit that commits after the statement starts and before the cascade reaches its
 * row is invisible to the guard and still deleted by the cascade.
 * tests/concurrency/pending-asn-disposal-race.concurrent.test.ts parks the delete
 * exactly there and shows it. And where the guard DOES see the credit it can only
 * refuse, leaving a reservation the caller expected to be gone — round 2's mutation
 * M4a showed that shape surfacing as a misleading hard failure. Hence the loud
 * `PendingAsnDisposalBackstopError` below rather than a quiet zero-row delete.
 */

/** The credit columns every disposal decision reads — under the locks, never before. */
export const PENDING_ASN_RESERVATION_LINE_SELECT = {
  id: true,
  sourceLineId: true,
  productId: true,
  sku: true,
  expectedQty: true,
  qtyAccountedViaSnapshot: true,
  qtyAccountedViaReceipt: true,
  lastProcessedReceivedQty: true,
} as const

/**
 * THE BACKSTOP: a header none of whose lines holds any credit. Kept in the delete's
 * own WHERE so the statement cannot remove visible evidence even if it ever ran
 * unlocked. See the block above for why it is not sufficient on its own.
 */
export const UNCREDITED_ASN_MAP_WHERE = {
  lines: {
    none: {
      OR: [
        { qtyAccountedViaSnapshot: { not: 0 } },
        { qtyAccountedViaReceipt: { not: 0 } },
        { lastProcessedReceivedQty: { not: 0 } },
      ],
    },
  },
} as const satisfies Prisma.WmsAsnMapWhereInput

/**
 * Thrown when the backstop refuses a delete the locked decision said was safe.
 *
 * THROWN, AND IT ROLLS BACK THE CALLER'S TRANSACTION ON PURPOSE (o3d-zzgp r4). By the
 * time it is raised the disposal itself has written nothing — the refused delete changed
 * no row — so what the rollback discards is whatever the CALLER wrote earlier in the same
 * transaction (the reservation path's demotion of a stale in-flight claim). That is the
 * intended result: firing means credit was written without the locks this transaction's
 * reads relied on, so none of those reads should be acted on. It must never be converted
 * into a returned refusal; that would commit decisions taken on untrustworthy reads.
 */
export class PendingAsnDisposalBackstopError extends Error {
  override readonly name = 'PendingAsnDisposalBackstopError'

  constructor(asnMapId: string) {
    super(
      `Pending ASN reservation ${asnMapId} was judged uncredited under the transfer → ASN header → ASN line `
      + 'locks, but the zero-credit guard on its delete refused it. Something wrote credit without taking '
      + 'those locks. Nothing was deleted and the reservation is left as it is (o3d-zzgp r3).',
    )
  }
}

/**
 * Thrown when a locked re-read finds a line row the step-4 lock did not cover.
 * Raised before the disposal writes anything, and rolls the caller's transaction back
 * deliberately for the same reason as the backstop error above.
 */
export class PendingAsnLineNotLockedError extends Error {
  override readonly name = 'PendingAsnLineNotLockedError'

  constructor(asnMapId: string, lineIds: string[]) {
    super(
      `Pending ASN reservation ${asnMapId} gained line row(s) ${lineIds.join(', ')} after its step-4 lock was `
      + 'taken. Lines of a transfer reservation are only created under the transfer lock this transaction '
      + 'holds, so this should be impossible; the disposal is abandoned rather than acting on an unlocked row '
      + '(o3d-zzgp r3).',
    )
  }
}

export type LockedPendingAsnReservation = {
  asnMapId: string
  lines: Array<PendingAsnReservationLine & { productId: string; sku: string }>
}

/**
 * Take step 2, step 3 and step 4 for one transfer reservation, in that order, and
 * return what the reservation looks like UNDER them.
 *
 * `null` when no header matching `reservationWhere` exists once the locks are held —
 * a concurrent disposal or a finalizer got there first, or it is no longer the
 * pending reservation the caller meant. The where is applied AFTER the header lock,
 * so a status or external-id change that commits while this waits is seen.
 *
 * Re-locking a row this transaction already holds is a no-op in PostgreSQL, so a
 * caller that took the transfer lock at the top of its transaction (the reservation)
 * can call this without special-casing, and the order is still 2 → 3 → 4.
 */
export async function lockPendingTransferAsnReservation(
  tx: Prisma.TransactionClient,
  input: { transferId: string; asnMapId: string; reservationWhere?: Prisma.WmsAsnMapWhereInput },
): Promise<LockedPendingAsnReservation | null> {
  await lockStockTransfers(tx, [input.transferId]) // step 2
  await lockWmsAsnMaps(tx, [input.asnMapId]) // step 3

  const header = await tx.wmsAsnMap.findFirst({
    where: {
      ...input.reservationWhere,
      id: input.asnMapId,
      sourceType: 'STOCK_TRANSFER',
      // The parent this transaction locked at step 2. A header pointing anywhere else
      // is not one these locks cover, so it is not ours to dispose of.
      sourceId: input.transferId,
    },
    select: { id: true },
  })
  if (!header) return null

  const discovered = await tx.wmsAsnLineMap.findMany({
    where: { asnMapId: input.asnMapId },
    select: { id: true },
    orderBy: [{ id: 'asc' }],
  })
  const locked = new Set(await lockWmsAsnLineMaps(tx, discovered.map((row) => row.id))) // step 4

  const lines = await tx.wmsAsnLineMap.findMany({
    where: { asnMapId: input.asnMapId },
    select: PENDING_ASN_RESERVATION_LINE_SELECT,
    orderBy: [{ id: 'asc' }],
  })
  const unlocked = lines.filter((line) => !locked.has(line.id)).map((line) => line.id)
  if (unlocked.length > 0) throw new PendingAsnLineNotLockedError(input.asnMapId, unlocked)

  return { asnMapId: header.id, lines }
}

export type PendingAsnDisposalOutcome = 'retired' | 'deleted' | 'absent'

/**
 * THE ONLY WAY a pending transfer ASN reservation is disposed of: lock (2 → 3 → 4),
 * re-read the credit, then retire it if anything is credited or delete it if nothing
 * is — all inside the caller's transaction, which must not have taken a step-3 or
 * step-4 lock before calling (it may hold step 2).
 */
export async function disposePendingTransferAsnReservation(
  tx: Prisma.TransactionClient,
  input: { transferId: string; asnMapId: string; reservationWhere?: Prisma.WmsAsnMapWhereInput },
): Promise<PendingAsnDisposalOutcome> {
  const reservation = await lockPendingTransferAsnReservation(tx, input)
  if (!reservation) return 'absent'

  const retirement = planPendingAsnReservationRetirement(reservation.lines)
  if (retirement) {
    await retirePendingAsnReservation(tx, reservation.asnMapId, retirement)
    return 'retired'
  }

  const { count } = await tx.wmsAsnMap.deleteMany({
    where: {
      ...input.reservationWhere,
      id: reservation.asnMapId,
      sourceType: 'STOCK_TRANSFER',
      sourceId: input.transferId,
      // THE BACKSTOP — see UNCREDITED_ASN_MAP_WHERE. The locks above are the fix.
      ...UNCREDITED_ASN_MAP_WHERE,
    },
  })
  if (count !== 1) throw new PendingAsnDisposalBackstopError(reservation.asnMapId)
  return 'deleted'
}
