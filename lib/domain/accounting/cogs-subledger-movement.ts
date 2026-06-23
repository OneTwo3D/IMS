import type { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { roundQuantity, type DecimalInput } from '@/lib/domain/math/decimal'

/**
 * khdw: append-only subledger of EVERY GL COGS-account movement, used by the
 * daily-batch COGS subledger-vs-GL rounding reconciliation:
 *   - DISPATCH              — Group B dispatch COGS (positive; 4dp cogsBatchAmount)
 *   - REFUND_REVERSAL       — refund COGS reversal (negative: COGS credited; 6dp)
 *   - SHIPMENT_REVALUATION  — cost-layer revaluation reverse+repost (signed; 2dp)
 *   - LANDED_COST_ADJUSTMENT — retrospective landed-cost COGS adjustment (signed; 2dp)
 *
 * Dispatch is recorded here (not read live from Shipment.cogsBatchAmount) BECAUSE
 * cogsBatchAmount is MUTATED in place by revaluation (cost-layers.ts) — reading it
 * live would double-count a same-window dispatch+revaluation. The ledger row is the
 * immutable, correctly-dated record of what dispatch actually posted to the GL.
 *
 * `baseDelta` is the signed base-currency COGS movement (+ = debited/increased,
 * − = credited/decreased) at the highest precision the source carries. Idempotent
 * on `idempotencyKey` (mirrors the COGS journal's own key), so re-staged/retried
 * postings record exactly once — first write wins.
 */
export type CogsSubledgerMovementSource =
  | 'DISPATCH'
  | 'REFUND_REVERSAL'
  | 'SHIPMENT_REVALUATION'
  | 'LANDED_COST_ADJUSTMENT'

type CogsSubledgerMovementClient = Pick<Prisma.TransactionClient, 'cogsSubledgerMovement'>

// Normalise every journal date to UTC date-only (midnight). The reconciliation
// window is the half-open (opening, closing] between two GL balance-snapshot dates,
// which are themselves date-only — so a row carrying a wall-clock time would fall
// OUTSIDE its own GL day's window (e.g. a dispatch posted 15:00 on the closing date
// is > the closing midnight bound) and the day would perpetually flag. Date inputs
// (dispatch passes `new Date()`) MUST be truncated to match the string callers.
function toJournalDate(value: Date | string): Date {
  const isoDay = (typeof value === 'string' ? value : value.toISOString()).slice(0, 10)
  return new Date(`${isoDay}T00:00:00.000Z`)
}

export async function recordCogsSubledgerMovement(
  client: CogsSubledgerMovementClient = db,
  input: {
    sourceType: CogsSubledgerMovementSource
    sourceRef: string
    idempotencyKey: string
    baseDelta: DecimalInput
    /** GL posting date — 'YYYY-MM-DD' string or a Date (used as the recon window key). */
    journalDate: Date | string
  },
): Promise<void> {
  const baseDelta = roundQuantity(input.baseDelta, 6)
  // A zero movement never affects the reconciliation; skip it rather than store noise.
  if (baseDelta.isZero()) return
  await client.cogsSubledgerMovement.upsert({
    where: { idempotencyKey: input.idempotencyKey },
    create: {
      sourceType: input.sourceType,
      sourceRef: input.sourceRef,
      idempotencyKey: input.idempotencyKey,
      baseDelta,
      journalDate: toJournalDate(input.journalDate),
    },
    // Idempotent: the key identifies one posting, so a re-run must not double-count.
    update: {},
  })
}
