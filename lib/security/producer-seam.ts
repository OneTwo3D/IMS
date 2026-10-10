/**
 * THE PRODUCER SEAM: WHAT A PRODUCER ASKS BEFORE IT CREATES OUTBOUND WORK.
 *
 * `producerDisposition` (producer-disposition.ts) is the pure decision. A producer does not call it directly:
 * it calls {@link producerSeamVerdict}, which adds the one thing the decision deliberately does not know, whether this
 * installation obeys it for the destination at all (PRODUCER_HOLD_ENFORCED_ENV). Three answers:
 *
 *   legacy   the destination is not enforced: the producer does exactly what it did before the decision existed.
 *   live     enforced, and the decision is LIVE: produce the work.
 *   shadow   enforced, and the decision is SHADOW: record what would have been written and produce NOTHING.
 *
 * FAIL-CLOSED READING OF THE SWITCH. Only an unset or empty variable means "enforce nothing". A value that is not a
 * list of known destinations or `all` enforces EVERY destination: a misspelling must not leave a hold off. A read that
 * throws enforces everything too. Pure and synchronous; it never throws.
 */

import {
  PRODUCER_HOLD_ENFORCED_ENV,
} from './producer-disposition-constants'
import { OUTBOUND_CONNECTORS, type OutboundConnector } from './outbound-write-hold-constants'
import {
  explainProducerDisposition,
  type ProducerDecision,
  type ProducerDecisionContext,
} from './producer-disposition'
import type { MappedOperation } from './writer-ownership-map'

export type ProducerEnforcement =
  | { enforced: false }
  | { enforced: true; destinations: ReadonlySet<OutboundConnector>; readable: boolean }

const hasOwn = Object.prototype.hasOwnProperty
const ALL: ReadonlySet<OutboundConnector> = new Set(OUTBOUND_CONNECTORS)

/** Which destinations obey the decision, from the environment. Never throws. */
export function readProducerEnforcement(env: Record<string, string | undefined> = process.env): ProducerEnforcement {
  try {
    const raw: unknown = hasOwn.call(env, PRODUCER_HOLD_ENFORCED_ENV) ? env[PRODUCER_HOLD_ENFORCED_ENV] : undefined
    if (raw === undefined || raw === '') return { enforced: false }
    if (typeof raw !== 'string') return { enforced: true, destinations: ALL, readable: false }
    const names = raw.split(',').map((part) => part.trim())
    if (names.length === 0 || names.some((name) => name === '')) return { enforced: true, destinations: ALL, readable: false }
    const destinations = new Set<OutboundConnector>()
    for (const name of names) {
      if (name === 'all') return { enforced: true, destinations: ALL, readable: true }
      if (!(OUTBOUND_CONNECTORS as readonly string[]).includes(name)) {
        return { enforced: true, destinations: ALL, readable: false }
      }
      destinations.add(name as OutboundConnector)
    }
    return { enforced: true, destinations, readable: true }
  } catch {
    return { enforced: true, destinations: ALL, readable: false }
  }
}

export type ProducerSeamVerdict =
  | { kind: 'legacy' }
  | { kind: 'live'; decision: ProducerDecision }
  | { kind: 'shadow'; decision: ProducerDecision }

export function producerSeamVerdict<D extends OutboundConnector>(
  destination: D,
  operation: MappedOperation<D>,
  obligationAt?: Date,
  context: ProducerDecisionContext = {},
): ProducerSeamVerdict {
  try {
    const enforcement = readProducerEnforcement(context.env ?? process.env)
    if (!enforcement.enforced || !enforcement.destinations.has(destination)) return { kind: 'legacy' }
    const decision = explainProducerDisposition(destination, operation, obligationAt, context)
    return decision.disposition === 'LIVE' ? { kind: 'live', decision } : { kind: 'shadow', decision }
  } catch {
    // Unreachable in practice (both reads above never throw); kept so a producer can never see an exception here.
    return {
      kind: 'shadow',
      decision: { disposition: 'SHADOW', reason: 'unreadable', owner: 'unknown', phase: 'P1', cutoff: null, grant: 'unreadable' },
    }
  }
}
