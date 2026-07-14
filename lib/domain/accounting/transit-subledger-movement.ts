import type { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { roundQuantity, type DecimalInput } from '@/lib/domain/math/decimal'

/**
 * 6oyu.4 (epic khdw): append-only subledger of EVERY GL STOCK_IN_TRANSIT-account
 * movement, used by the daily-batch transit GL reconciliation. Mirrors
 * CogsSubledgerMovement exactly.
 *
 * Transit is a CLEARING account: goods/freight bills DEBIT it (value in transit),
 * and receipt / landed-cost reclass / supplier credit notes / cancellations CREDIT
 * it (value received or reclassed out). The khdw decision (2026-06-22) defined the
 * transit balance basis as "freight-bill debits net of reclass credits" — a purely
 * posting-derived cumulative balance. Every transit-account posting site records a
 * signed row here at post time, so the independent subledger movement over a GL
 * window equals the GL transit movement up to per-posting 2dp rounding (the residue
 * the guarded sweep absorbs). A material gap = a genuinely missing/double posting or
 * a new transit flow not yet recording a row; it exceeds the sweep limit and FLAGS.
 *
 * Sources (sign convention: + = transit DEBITED/increased, − = transit CREDITED):
 *   - PURCHASE_BILL              — goods/freight bill posts its NET (excl. VAT) to
 *                                  transit; + (the bill posts EXCLUSIVE, so transit
 *                                  receives the net subtotal, not the gross).
 *   - PURCHASE_BILL_UPDATE       — a bill edit reposts to Xero; signed NET delta
 *                                  (new subtotal − old subtotal).
 *   - SUPPLIER_CREDIT_NOTE       — ACCPAYCREDIT reverses freight on transit; − NET
 *                                  (the credit posts INCLUSIVE, so transit receives
 *                                  the net after Xero's VAT split, not the gross).
 *   - STOCK_RECEIPT              — receipt DR inventory / CR transit; − receipt value.
 *   - LANDED_COST_RECLASS        — on-hand landed-cost reclass DR/CR transit; signed.
 *   - LANDED_COST_CONSUMED_OFFSET— consumed-qty COGS adjustment offset to transit;
 *                                  signed (drains the sold units' freight share).
 *   - PURCHASE_ORDER_CANCEL      — cancel reversal DR transit / CR inventory; +.
 *   - SUPPLIER_RETURN            — return reversal DR transit / CR inventory; +.
 *
 * `baseDelta` is the signed base-currency transit movement at the highest precision
 * the source carries. Idempotent on `idempotencyKey` (the transit-affecting
 * journal's OWN key), so re-staged/retried postings record exactly once — first
 * write wins. A single journal that also moves COGS (LANDED_COST_CONSUMED_OFFSET)
 * writes to BOTH subledger tables under the same key without collision.
 */
export type TransitSubledgerMovementSource =
  | 'PURCHASE_BILL'
  | 'PURCHASE_BILL_UPDATE'
  | 'SUPPLIER_CREDIT_NOTE'
  | 'STOCK_RECEIPT'
  | 'LANDED_COST_RECLASS'
  | 'LANDED_COST_CONSUMED_OFFSET'
  | 'PURCHASE_ORDER_CANCEL'
  | 'SUPPLIER_RETURN'

type TransitSubledgerMovementClient = Pick<Prisma.TransactionClient, 'transitSubledgerMovement'>

// Normalise every journal date to UTC date-only (midnight). The reconciliation
// window is the half-open (opening, closing] between two GL balance-snapshot dates,
// which are themselves date-only — so a row carrying a wall-clock time would fall
// OUTSIDE its own GL day's window and the day would perpetually flag. Date inputs
// (sites passing `new Date()`) MUST be truncated to match the string callers.
function toJournalDate(value: Date | string): Date {
  const isoDay = (typeof value === 'string' ? value : value.toISOString()).slice(0, 10)
  return new Date(`${isoDay}T00:00:00.000Z`)
}

export async function recordTransitSubledgerMovement(
  client: TransitSubledgerMovementClient = db,
  input: {
    sourceType: TransitSubledgerMovementSource
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
  await client.transitSubledgerMovement.upsert({
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
