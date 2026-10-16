import { producerHeldNotice, producerShadowNotice, type ProducerReason } from '@/lib/security/producer-disposition-constants'
import type { ProducerDecisionContext } from '@/lib/security/producer-disposition'
import { producerEgressVerdict } from '@/lib/security/producer-seam'

/**
 * The two operation-agnostic WooCommerce gates (see producer-seam.ts for the whole picture). They read the environment only:
 * no database and no network, so the transport module can import them without a cycle.
 */
export type WooHold =
  | { held: false }
  | {
      held: true
      /** The sentence for work that is being PRODUCED now and was kept as a shadow instead. */
      notice: string
      /** The sentence for work that already EXISTS (a queued row) and was handed back unsent. */
      queuedNotice: string
      reason: ProducerReason
    }

/** Whether a drain of already-queued WooCommerce work must stand down. Pure; never throws. */
export function wooDrainHold(context?: ProducerDecisionContext): WooHold {
  const verdict = producerEgressVerdict('woocommerce', context)
  if (verdict.kind !== 'held') return { held: false }
  return {
    held: true,
    reason: verdict.decision.reason,
    notice: producerShadowNotice({ connector: 'woocommerce', reason: verdict.decision.reason, owner: verdict.decision.owner }),
    queuedNotice: producerHeldNotice({ connector: 'woocommerce', reason: verdict.decision.reason, owner: verdict.decision.owner }),
  }
}

/** The last barrier before a WooCommerce transport call. Same answer as {@link wooDrainHold}: a separate name so the census can tell the two roles apart. */
export function wooEgressHold(context?: ProducerDecisionContext): WooHold {
  return wooDrainHold(context)
}
