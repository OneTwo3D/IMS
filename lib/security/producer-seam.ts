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
import { WRITER_OWNERSHIP_MAP, type MappedOperation } from './writer-ownership-map'

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

export type ProducerEgressVerdict =
  | { kind: 'legacy' }
  | { kind: 'open'; decision: ProducerDecision }
  | { kind: 'held'; decision: ProducerDecision }

/**
 * THE OPERATION-AGNOSTIC GATE: may ANY write to this destination leave IMS right now?
 *
 * {@link producerSeamVerdict} answers for one operation of the ownership map. A claim boundary (a drain that sends
 * work already queued) and the last barrier in front of a transport call do not know which operation they carry, and
 * they must not guess: they ask only whether the destination is in its live phase at all.
 *
 *   legacy   the destination is not enforced: nothing changes.
 *   open     enforced, and the grant and the live-from instant are both in force with the instant reached (phase P2). Which
 *            operations IMS may produce in that phase was decided when each unit of work was produced.
 *   held     enforced, and the destination is not in its live phase (no grant, no live-from instant, an instant not yet
 *            reached, or either unreadable): no operation can be LIVE, so nothing is sent.
 *
 * Pure and synchronous; never throws, and anything it cannot read is held.
 */
export function producerEgressVerdict(
  destination: OutboundConnector,
  context: ProducerDecisionContext = {},
): ProducerEgressVerdict {
  try {
    const enforcement = readProducerEnforcement(context.env ?? process.env)
    if (!enforcement.enforced || !enforcement.destinations.has(destination)) return { kind: 'legacy' }
    // The phase does not depend on the operation, so any mapped operation of the destination reads it.
    const probe = WRITER_OWNERSHIP_MAP.find((row) => row.destination === destination)
    if (!probe) throw new Error(`no ownership-map row for ${destination}`)
    const decision = explainProducerDisposition(destination, probe.operation as never, undefined, context)
    return decision.phase === 'P2' ? { kind: 'open', decision } : { kind: 'held', decision }
  } catch {
    return {
      kind: 'held',
      decision: { disposition: 'SHADOW', reason: 'unreadable', owner: 'unknown', phase: 'P1', cutoff: null, grant: 'unreadable' },
    }
  }
}

/**
 * THE WRITER-SIDE CUT-OFF: the earliest instant at which a unit of QUEUED work for this destination may have been created and still be
 * delivered. Null when no such floor applies; a number of queue-reading sites share this one answer.
 *
 * The producer seams decide whether work is produced at all. This answers the question of work that ALREADY EXISTS: a row queued
 * before the destination's live-from instant (in the window when the transport hold was the only barrier, or while the hold was not
 * enforced) belongs to the writer that owned the destination then, and must never be delivered by IMS once it is live, whatever its
 * status and however it was re-queued. Every claim, every selection of oldest-first work and every re-queue asks here.
 *
 *   null     the destination is not enforced (the switch is off: legacy behaviour, byte for byte), or it is not in its live phase (no
 *            grant, no live-from instant, or the instant not reached yet: the claim boundary hold already stands down everything), or
 *            anything is unreadable. NOTHING is filtered.
 *   a Date   enforced and in the live phase: work created before this instant is never delivered.
 *
 * Re-derived at every call from the environment, never cached, so a decision made under a claim reads the value of that moment.
 * Pure and synchronous; never throws.
 */
export function producerCutoffFloor(
  destination: OutboundConnector,
  context: ProducerDecisionContext = {},
): Date | null {
  try {
    const verdict = producerEgressVerdict(destination, context)
    return verdict.kind === 'open' ? verdict.decision.cutoff : null
  } catch {
    return null
  }
}

/** True when a row created at `createdAt` is before the floor. No floor: never. A createdAt that cannot be read is before it (fail closed). */
export function createdBeforeCutoffFloor(createdAt: Date | null | undefined, floor: Date | null): boolean {
  if (floor === null) return false
  if (!(createdAt instanceof Date)) return true
  const ms = createdAt.getTime()
  return !Number.isFinite(ms) || ms < floor.getTime()
}
