import {
  OUTBOUND_CONNECTOR_LABEL,
  OUTBOUND_HELD_TEXT_PREFIX,
  outboundHoldReferenceSuffix,
} from '@/lib/security/outbound-write-hold-constants'
import { PRODUCER_REASON_TEXT, producerHeldNotice, producerShadowNotice, type ProducerReason } from '@/lib/security/producer-disposition-constants'
import type { ProducerDecisionContext } from '@/lib/security/producer-disposition'
import { producerEgressVerdict } from '@/lib/security/producer-seam'

/**
 * The two operation-agnostic Mintsoft gates (see producer-seam.ts for the whole picture). They read the environment only:
 * no database and no network, so the transport module can import them without a cycle.
 */
export type MintsoftHold =
  | { held: false }
  | {
      held: true
      /** The sentence for work that is being PRODUCED now and was kept as a shadow instead. */
      notice: string
      /** The sentence for work that already EXISTS (a queued link) and was handed back unsent. */
      queuedNotice: string
      reason: ProducerReason
    }

/** Whether a drain of already-queued Mintsoft work must stand down. Pure; never throws. */
export function mintsoftDrainHold(context?: ProducerDecisionContext): MintsoftHold {
  const verdict = producerEgressVerdict('mintsoft', context)
  if (verdict.kind !== 'held') return { held: false }
  return {
    held: true,
    reason: verdict.decision.reason,
    notice: producerShadowNotice({ connector: 'mintsoft', reason: verdict.decision.reason, owner: verdict.decision.owner }),
    queuedNotice: producerHeldNotice({ connector: 'mintsoft', reason: verdict.decision.reason, owner: verdict.decision.owner }),
  }
}

/** The last barrier before a Mintsoft write request. Same answer as {@link mintsoftDrainHold}: a separate name so the census can tell the two roles apart. */
export function mintsoftEgressHold(context?: ProducerDecisionContext): MintsoftHold {
  return mintsoftDrainHold(context)
}

/**
 * The refusal text of the transport barrier. It is a complete outbound-write-hold text (prefix and reference), so every
 * queue that already recognises a hold from its text treats this one the same way: nothing was sent, no attempt is spent,
 * the work stays as it was. It claims only what IMS knows: the request did not leave, and it says nothing about Mintsoft.
 */
export function mintsoftEgressRefusalText(hold: Extract<MintsoftHold, { held: true }>, request: { method: string; target: string }): string {
  const label = OUTBOUND_CONNECTOR_LABEL.mintsoft
  const body = `${OUTBOUND_HELD_TEXT_PREFIX} (${label}): the producer-side hold is enforced for ${label} and this installation is not in its live phase (${PRODUCER_REASON_TEXT[hold.reason]}). `
    + `${request.method} ${request.target} was refused before it left IMS, so nothing was sent to ${label}. This is a hold on this installation, not a rejection by ${label}.`
  return `${body}${outboundHoldReferenceSuffix('held', body)}`
}
