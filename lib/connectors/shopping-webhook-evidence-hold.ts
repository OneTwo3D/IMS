import { db } from '@/lib/db'
import { getWebhookEventRetentionMonths, monthsAgo } from '@/lib/data-retention'
import {
  PRESERVE_LEGACY_WC_ORDER_CURRENCY_EVIDENCE,
  compactableShoppingWebhookEventWhere,
  preservedWcOrderEvidenceWhere,
} from '@/lib/connectors/shopping-webhook-retention'

/**
 * WHERE THE HOLD ON WOOCOMMERCE ORDER EVIDENCE MEETS THE OPERATOR (o3d-j7y4).
 *
 * The predicate itself, and the whole of the reasoning for it — including why round 18's
 * per-installation cutoff was withdrawn in r19 — live in
 * `lib/connectors/shopping-webhook-retention.ts`, which stays free of `@/lib/db` so the retention unit
 * test can import it directly. This module holds the one thing that needs a database: the read that
 * shows an operator what the hold is actually keeping alive.
 */

export type LegacyWcOrderEvidenceHold = {
  /** The issue that owns the hold, owns its data-minimisation cost, and is the only thing that lifts it. */
  issue: string
  /**
   * The configured shopping-inbox window, in months, or `0` when the operator has that compaction
   * switched off entirely — in which case the override is retaining nothing that would otherwise go.
   */
  retentionMonths: number
  /**
   * HOW MANY PAYLOADS SURVIVE SOLELY BECAUSE OF THE OVERRIDE (Codex r19 MEDIUM).
   *
   * The first version of this number counted the held SET — every WooCommerce order delivery still
   * carrying a payload — and the screen described it as what the exemption "is retaining today". Those
   * are different populations, and the first is much the larger: it includes rows too young to have
   * reached the retention window, and PENDING, FAILED and DEAD_LETTER rows that this compaction never
   * touches at any age. An operator reading it as compliance impact was reading a number that could be
   * several times the truth.
   *
   * This is the intersection that answers the question actually asked: held, AND otherwise compactable
   * — PROCESSED, payload not already emptied, and past the configured window. Take the override away
   * and exactly these rows would be `{}` by now.
   */
  retainedByOverride: number
  /**
   * The whole held population that still carries a payload, labelled as what it is: the evidence
   * `o3d-j7y4` has to work from. Not a retention figure — most of it is inside the window and would be
   * here regardless — but it is the number that says whether there is anything left to reason about.
   */
  evidenceRowsWithPayload: number
}

/**
 * The hold as an operator should see it, or `null` when it is not in force. Read-only.
 */
export async function describeLegacyWcOrderEvidenceHold(): Promise<LegacyWcOrderEvidenceHold | null> {
  if (!PRESERVE_LEGACY_WC_ORDER_CURRENCY_EVIDENCE) return null

  const retentionMonths = await getWebhookEventRetentionMonths()
  const held = preservedWcOrderEvidenceWhere()

  // The compaction's OWN predicate with its exemption REMOVED: what the nightly pass would empty if
  // the hold were lifted. Built from the shared function rather than restated, so a conjunct added to
  // the compaction is reflected here instead of quietly making this number wrong again.
  const { AND: _heldBack, ...otherwiseCompactable } =
    retentionMonths > 0 ? compactableShoppingWebhookEventWhere(monthsAgo(retentionMonths)) : { AND: undefined }

  const [evidenceRowsWithPayload, retainedByOverride] = await Promise.all([
    db.shoppingWebhookEvent.count({
      where: { ...held, NOT: { payloadJson: { equals: {} } } },
    }),
    // A window of 0 disables the compaction, so nothing at all is being retained BY the override —
    // not "everything", which is what a count that ignored the setting would imply.
    retentionMonths > 0
      ? db.shoppingWebhookEvent.count({ where: { ...held, ...otherwiseCompactable } })
      : Promise.resolve(0),
  ])

  return { issue: 'o3d-j7y4', retentionMonths, retainedByOverride, evidenceRowsWithPayload }
}
