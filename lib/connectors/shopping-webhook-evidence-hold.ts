import { db } from '@/lib/db'
import {
  LEGACY_WC_ORDER_EVIDENCE_CUTOFF_SETTING,
  PRESERVE_LEGACY_WC_ORDER_CURRENCY_EVIDENCE,
  legacyWcOrderEvidenceCutoffFromObservation,
  parseLegacyWcOrderEvidenceCutoff,
  preservedWcOrderEvidenceWhere,
} from '@/lib/connectors/shopping-webhook-retention'

/**
 * WHERE THE HOLD ON WOOCOMMERCE ORDER EVIDENCE TOUCHES THE DATABASE (o3d-j7y4, Codex r18 MEDIUM).
 *
 * The predicate itself, and the whole of the reasoning for it, live in
 * `lib/connectors/shopping-webhook-retention.ts` — that module stays free of `@/lib/db` so the
 * retention unit test can import it directly. This one holds the two things that need a database: the
 * cutoff that bounds the hold, and the read that shows an operator the hold is in force.
 */

/**
 * This installation's evidence cutoff, recording it if it has none yet.
 *
 * WHAT THE INSTANT MARKS. Not the release date and not the deploy date, neither of which anything here
 * can know: it marks THE FIRST TIME THIS INSTALLATION WAS OBSERVED RUNNING A BUILD THAT CARRIES THE
 * CURRENCY GUARD, plus a drain margin. That is a per-installation, run-time fact — an install that
 * upgrades next month gets next month's cutoff — and the daily retention pass is the natural observer
 * of it, because the pass is part of the same build as the guard and runs unconditionally.
 *
 * WHY THAT IS THE RIGHT SIDE TO ERR ON. The observation can only be LATE relative to the deploy (up to
 * one nightly period), never early. A late cutoff holds back a few deliveries that were already safe;
 * an early one would empty rows that are still the only evidence of an invented currency. Only the
 * second is unrecoverable.
 *
 * INSERT-ONLY, AND NEVER MOVED. A recorded cutoff is a historical fact about this installation, so
 * later runs must not restamp it — that would drag the boundary forward every night and make the hold
 * meaningless. `createMany({ skipDuplicates: true })` is the whole of the concurrency story: two
 * simultaneous passes cannot produce two cutoffs, and the loser re-reads the winner's value. An
 * existing row that does not parse is left exactly as it is and reported as "no cutoff", which holds
 * everything rather than overwriting whatever an operator or a failed write put there.
 *
 * Returns `null` when the hold is off (nothing to bound) or when no readable cutoff exists after this
 * call, which the compaction predicate reads as "hold every WooCommerce order delivery".
 */
export async function ensureLegacyWcOrderEvidenceCutoff(now: Date = new Date()): Promise<Date | null> {
  if (!PRESERVE_LEGACY_WC_ORDER_CURRENCY_EVIDENCE) return null

  const existing = await db.setting.findUnique({
    where: { key: LEGACY_WC_ORDER_EVIDENCE_CUTOFF_SETTING },
  })
  const recorded = parseLegacyWcOrderEvidenceCutoff(existing?.value)
  if (recorded) return recorded
  if (existing) return null // present but unreadable — hold everything, and do not clobber it

  const cutoff = legacyWcOrderEvidenceCutoffFromObservation(now)
  const { count } = await db.setting.createMany({
    data: [{ key: LEGACY_WC_ORDER_EVIDENCE_CUTOFF_SETTING, value: cutoff.toISOString() }],
    skipDuplicates: true,
  })
  if (count > 0) return cutoff

  // Another pass recorded one between the read and the insert. Theirs wins; nothing is overwritten.
  const raced = await db.setting.findUnique({
    where: { key: LEGACY_WC_ORDER_EVIDENCE_CUTOFF_SETTING },
  })
  return parseLegacyWcOrderEvidenceCutoff(raced?.value)
}

export type LegacyWcOrderEvidenceHold = {
  /** The issue that owns the hold and is the only thing that lifts it. */
  issue: string
  /**
   * The instant the hold stops at, or `null` when this installation has not recorded one yet — in
   * which case EVERY WooCommerce order delivery is held until the next retention run records it.
   */
  cutoffAt: Date | null
  /**
   * How many held rows still carry a payload, i.e. how much personal data this exemption is actually
   * keeping alive. Already-compacted rows are excluded because nothing is being retained for them.
   */
  heldRows: number
}

/**
 * The hold as an operator should see it, or `null` when it is not in force. Read-only: it records
 * nothing and it must not, because the settings page is not the observer that establishes the cutoff.
 */
export async function describeLegacyWcOrderEvidenceHold(): Promise<LegacyWcOrderEvidenceHold | null> {
  if (!PRESERVE_LEGACY_WC_ORDER_CURRENCY_EVIDENCE) return null

  const row = await db.setting.findUnique({
    where: { key: LEGACY_WC_ORDER_EVIDENCE_CUTOFF_SETTING },
  })
  const cutoffAt = parseLegacyWcOrderEvidenceCutoff(row?.value)
  const heldRows = await db.shoppingWebhookEvent.count({
    where: {
      ...preservedWcOrderEvidenceWhere(cutoffAt),
      NOT: { payloadJson: { equals: {} } },
    },
  })
  return { issue: 'o3d-j7y4', cutoffAt, heldRows }
}
