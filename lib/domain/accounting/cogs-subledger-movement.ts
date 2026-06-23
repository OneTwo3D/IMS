import type { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { roundQuantity, type DecimalInput } from '@/lib/domain/math/decimal'

/**
 * khdw: append-only subledger of GL COGS-account movements that do not have a
 * native structured home, used by the daily-batch COGS subledger-vs-GL rounding
 * reconciliation. Dispatch COGS is reconciled from Shipment.cogsBatchAmount and is
 * NOT recorded here; everything else that posts to the COGS account is:
 *   - REFUND_REVERSAL       — refund COGS reversal (negative: COGS credited)
 *   - SHIPMENT_REVALUATION  — cost-layer revaluation reverse+repost (signed)
 *   - LANDED_COST_ADJUSTMENT — retrospective landed-cost COGS adjustment (signed)
 *
 * `baseDelta` is the signed base-currency COGS movement (+ = debited/increased,
 * − = credited/decreased) at the highest precision the source carries. Idempotent
 * on `idempotencyKey` (mirrors the COGS journal's own key), so re-staged/retried
 * postings record exactly once — first write wins.
 */
export type CogsSubledgerMovementSource =
  | 'REFUND_REVERSAL'
  | 'SHIPMENT_REVALUATION'
  | 'LANDED_COST_ADJUSTMENT'

type CogsSubledgerMovementClient = Pick<Prisma.TransactionClient, 'cogsSubledgerMovement'>

function toJournalDate(value: Date | string): Date {
  return typeof value === 'string' ? new Date(`${value.slice(0, 10)}T00:00:00.000Z`) : value
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
