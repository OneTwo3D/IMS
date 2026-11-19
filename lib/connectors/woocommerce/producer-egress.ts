import { producerHeldNotice, producerShadowNotice, type ProducerReason } from '@/lib/security/producer-disposition-constants'
import type { ProducerDecisionContext } from '@/lib/security/producer-disposition'
import { producerEgressVerdict, producerOperationEgressVerdict } from '@/lib/security/producer-seam'
import type { MappedOperation } from '@/lib/security/writer-ownership-map'

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

/**
 * Whether a drain of already-queued WooCommerce work must stand down. Pure; never throws.
 *
 * Given the OPERATION the drain carries, the answer is that operation's own (its step must be live, and where the operation replaces an incumbent the
 * owner stops by hand, the owner's confirmation must be on record, otherwise it waits and is retried): with only step M live, the stock, invoice-note and
 * invoice-document drains stay held. Without an operation it is the destination-level gate (any step live), which is only right for the transport barrier
 * and for a caller that genuinely carries no single operation.
 */
export function wooDrainHold(context?: ProducerDecisionContext, operation?: MappedOperation<'woocommerce'>): WooHold {
  if (operation !== undefined) {
    const verdict = producerOperationEgressVerdict('woocommerce', operation, context)
    if (verdict.kind !== 'held') return { held: false }
    return {
      held: true,
      reason: verdict.decision.reason,
      notice: producerShadowNotice({ connector: 'woocommerce', reason: verdict.decision.reason, owner: verdict.decision.owner }),
      queuedNotice: producerHeldNotice({ connector: 'woocommerce', reason: verdict.decision.reason, owner: verdict.decision.owner }),
    }
  }
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
