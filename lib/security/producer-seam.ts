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
  liveStepsOfDestination,
} from './producer-disposition-constants'
import { OUTBOUND_CONNECTORS, type OutboundConnector } from './outbound-write-hold-constants'
import {
  explainProducerDisposition,
  type ProducerDecision,
  type ProducerDecisionContext,
} from './producer-disposition'
import { WRITER_OWNERSHIP_MAP, ownershipRowFor, type MappedOperation } from './writer-ownership-map'
import { attestationState } from './writer-attestation-snapshot'
import { requiredAttestationFor, type WriterAttestationKind } from './writer-attestation-constants'

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
    // The phase is per switchover STEP: a destination is open when ANY step whose rows write to it is in its live phase (WooCommerce is written
    // by steps M, W and X; its order completions go live with step M, long before its stock push). Each step is probed through one of its own
    // IMS-owned rows. When several steps are live the decision with the EARLIEST live-from instant answers, so the writer-side cut-off floor never
    // discards work that a step already live produced.
    const decisions: ProducerDecision[] = []
    for (const step of liveStepsOfDestination(destination)) {
      const probe = WRITER_OWNERSHIP_MAP.find((row) => row.destination === destination && row.step === step && row.owners.P2 === 'IMS')
      if (!probe) continue
      decisions.push(explainProducerDisposition(destination, probe.operation as never, undefined, context))
    }
    if (decisions.length === 0) throw new Error(`no step-owned ownership-map row for ${destination}`)
    const open = decisions.filter((decision) => decision.phase === 'P2')
    if (open.length > 0) {
      const earliest = open.reduce((best, next) => ((next.cutoff?.getTime() ?? Infinity) < (best.cutoff?.getTime() ?? Infinity) ? next : best))
      return { kind: 'open', decision: earliest }
    }
    return { kind: 'held', decision: decisions[0]! }
  } catch {
    return {
      kind: 'held',
      decision: { disposition: 'SHADOW', reason: 'unreadable', owner: 'unknown', phase: 'P1', cutoff: null, grant: 'unreadable' },
    }
  }
}

export type ProducerOperationEgressVerdict =
  | { kind: 'legacy' }
  | { kind: 'open'; decision: ProducerDecision }
  | {
      kind: 'held'
      decision: ProducerDecision
      /** Set when the hold is the owner's confirmation not being on record (absent) or not being known yet (unknown): the work is retried, never shadowed. */
      awaiting?: { kind: WriterAttestationKind; state: 'absent' | 'unknown' }
    }

/**
 * THE PER-OPERATION GATE: may queued work of ONE operation of the ownership map leave IMS right now?
 *
 * {@link producerEgressVerdict} is the destination-level gate (any step live opens it) and is only the EARLIEST-OPEN TRANSPORT BARRIER. A drain, a claim
 * boundary or a re-queue that knows which operation it carries asks here, so that work belonging to a step that is not live yet stays held while an
 * earlier step is live: with only step M live, the WooCommerce completions and tracking go out and the stock, invoice-note and invoice-document rows
 * do not, whatever put them in the queue.
 *
 *   legacy   the hold is not enforced for the destination.
 *   open     enforced, the operation's own step is in its live phase (grant and that step's live-from instant reached), IMS owns the operation there,
 *            and, where the operation replaces an incumbent the owner stops by hand, the owner's confirmation is on record.
 *   held     anything else. When the only thing missing is the confirmation (absent, or not read yet) `awaiting` says so: the work waits and is
 *            retried, and nothing is shadowed.
 *
 * Pure and synchronous; never throws, and anything it cannot read is held.
 */
export function producerOperationEgressVerdict<D extends OutboundConnector>(
  destination: D,
  operation: MappedOperation<D>,
  context: ProducerDecisionContext = {},
): ProducerOperationEgressVerdict {
  try {
    const enforcement = readProducerEnforcement(context.env ?? process.env)
    if (!enforcement.enforced || !enforcement.destinations.has(destination)) return { kind: 'legacy' }
    const decision = explainProducerDisposition(destination, operation, undefined, context)
    const row = ownershipRowFor(destination, operation)
    if (row === null || decision.phase !== 'P2' || decision.owner !== 'IMS') return { kind: 'held', decision }
    const needed = requiredAttestationFor(destination, operation, row.step)
    if (needed !== undefined) {
      const supplied: unknown = Object.prototype.hasOwnProperty.call(context, 'attestations') ? context.attestations : undefined
      const state = attestationState(needed, supplied instanceof Set ? (supplied as ReadonlySet<string>) : undefined)
      if (state !== 'present') {
        return { kind: 'held', decision: { ...decision, disposition: 'SHADOW', reason: 'attestation_missing' }, awaiting: { kind: needed, state } }
      }
    }
    return { kind: 'open', decision }
  } catch {
    return {
      kind: 'held',
      decision: { disposition: 'SHADOW', reason: 'unreadable', owner: 'unknown', phase: 'P1', cutoff: null, grant: 'unreadable' },
    }
  }
}

/**
 * THE WRITER-SIDE CUT-OFF OF ONE OPERATION: the live-from instant of the operation's OWN step when that step is in its live phase and IMS owns the
 * operation there, else null (nothing is filtered: the per-operation gate stands the work down). Work for this operation created before it belongs to
 * the writer that owned the operation then. The owner's confirmation does not move it: waiting for the confirmation holds the work, it does not change
 * which writer owned it before the instant. Pure and synchronous; never throws.
 */
export function producerOperationCutoffFloor<D extends OutboundConnector>(
  destination: D,
  operation: MappedOperation<D>,
  context: ProducerDecisionContext = {},
): Date | null {
  try {
    const enforcement = readProducerEnforcement(context.env ?? process.env)
    if (!enforcement.enforced || !enforcement.destinations.has(destination)) return null
    const decision = explainProducerDisposition(destination, operation, undefined, context)
    return decision.phase === 'P2' && decision.owner === 'IMS' ? decision.cutoff : null
  } catch {
    return null
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
