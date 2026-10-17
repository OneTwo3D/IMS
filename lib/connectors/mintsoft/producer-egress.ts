import {
  OUTBOUND_CONNECTOR_LABEL,
  OUTBOUND_HELD_TEXT_PREFIX,
  outboundHoldReferenceSuffix,
} from '@/lib/security/outbound-write-hold-constants'
import { PRODUCER_REASON_TEXT, producerHeldNotice, producerShadowNotice, type ProducerReason } from '@/lib/security/producer-disposition-constants'
import type { ProducerDecisionContext } from '@/lib/security/producer-disposition'
import { producerEgressVerdict } from '@/lib/security/producer-seam'
import { outboundTextAfterEarlierSend } from '@/lib/security/outbound-write-hold-constants'
import { classifyMintsoftRequest } from './api/read-allowlist'

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

/** Whether the producer-side hold is enforced for Mintsoft at all. Unset enforcement is the legacy behaviour, byte for byte. Pure; never throws. */
export function mintsoftProducerHoldEnforced(context?: ProducerDecisionContext): boolean {
  return producerEgressVerdict('mintsoft', context).kind !== 'legacy'
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

/**
 * The per-hop gate every Mintsoft connectorFetch call passes (ConnectorFetchOptions.hopGate): Mintsoft mutates through GET, so an
 * allowed read can redirect onto a write path. A write-classified hop is refused while the destination is not live; a redirect hop
 * means the earlier request was sent, so its text is the maybe-sent one, never a pure hold.
 */
export function mintsoftHopGate(hop: { method: string; url: URL; redirectCount: number }): string | null {
  const hold = mintsoftEgressHold()
  if (!hold.held || classifyMintsoftRequest(hop.method, hop.url.pathname).class !== 'write') return null
  const text = mintsoftEgressRefusalText(hold, { method: hop.method.toUpperCase(), target: hop.url.pathname })
  return hop.redirectCount > 0 ? outboundTextAfterEarlierSend(text, 'Mintsoft') : text
}

/**
 * Key minting (POST /api/Auth) issues a NEW tenant API key and invalidates the one every other integration uses, so while the
 * producer hold is enforced and this installation is not in its live phase it is refused before anything is sent. The text is a
 * complete outbound-write-hold text and carries no credential, username or key. Reads keep working on the stored or fixed key.
 */
export class MintsoftKeyMintingHeldError extends Error {
  readonly code = 'MINTSOFT_KEY_MINTING_HELD'
  constructor(text: string) {
    super(text)
    this.name = 'MintsoftKeyMintingHeldError'
  }
}

/** Throws {@link MintsoftKeyMintingHeldError} when key minting must stand down. Pure on the environment; never touches the network. */
export function assertMintsoftKeyMintingAllowed(context?: ProducerDecisionContext): void {
  const hold = mintsoftEgressHold(context)
  if (hold.held) throw new MintsoftKeyMintingHeldError(mintsoftEgressRefusalText(hold, { method: 'POST', target: '/api/Auth' }))
}
