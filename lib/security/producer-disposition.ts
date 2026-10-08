/**
 * THE PRODUCER-SIDE HOLD: LIVE OR SHADOW, DECIDED FROM THE ENVIRONMENT ALONE.
 *
 * Pure and synchronous. No database, no network, no settings row. It is the only place that decides
 * whether a unit of IMS work for a destination is produced for delivery (LIVE) or only recorded as a
 * shadow of what IMS would have written (SHADOW). Nothing consults it yet; the seams that do come in
 * later changes, one per mechanism.
 *
 * LIVE only when ALL of these hold; otherwise SHADOW, with the FIRST failing reason:
 *  1. the outbound-write grant for the destination reads ok (outbound-write-grant.ts decides what ok is);
 *  2. the destination's live-from variable is set and is one UTC instant in ISO-8601 with an explicit Z;
 *  3. now is at or after that instant (a future instant is a scheduled flip and stays SHADOW until then);
 *  4. the ownership map says IMS owns the operation in the phase that 1-3 establish (P2);
 *  5. the business-event time of the work, `obligationAt`, is at or after the instant (work for an event that
 *     happened before it belongs to the writer that owned it then); for a row the map marks obligationTime
 *     'required' it MUST be passed, and omitting it is SHADOW. Rows marked 'not-applicable' may omit it.
 *
 * Absent, unreadable, inconsistent, unmapped and thrown are all SHADOW. The function never throws and
 * never returns LIVE for a value it could not read.
 *
 * There is no phase setting. The installation is in P2 for a destination exactly when 1-3 hold, so
 * there is no second switch to drift from the first, and a restored backup, a clone or a new checkout
 * (environment only) never inherits LIVE.
 */

import {
  PRODUCER_CUTOFF_ENV,
  producerAgreementText,
  type ProducerAgreementState,
  type ProducerReason,
} from './producer-disposition-constants'
import { OUTBOUND_CONNECTORS, type OutboundConnector } from './outbound-write-hold-constants'
import { readOutboundGrantStates, type OutboundEnv } from './outbound-write-grant'
import { ownershipRowFor, type MappedOperation, type WriterOwner } from './writer-ownership-map'

export type ProducerDisposition = 'LIVE' | 'SHADOW'

export type ProducerDecisionContext = {
  /** Defaults to process.env. */
  env?: OutboundEnv
  /** Defaults to the current time. */
  now?: Date
}

export type ProducerDecision = {
  disposition: ProducerDisposition
  reason: ProducerReason
  /** The owner of the operation in `phase`; `unknown` when unmapped. */
  owner: WriterOwner
  /** P2 exactly when the grant and the live-from instant are in force; otherwise P1 (P0 is not derivable from the environment). */
  phase: 'P1' | 'P2'
  cutoff: Date | null
  grant: 'granted' | 'absent' | 'unreadable'
}

type CutoffRead =
  | { ok: true; at: Date }
  | { ok: false; reason: 'absent' | 'unreadable' }

const ISO_UTC_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?Z$/

/**
 * One UTC instant in ISO-8601 with an explicit Z, to at most a millisecond. No lenient Date.parse, and NO trimming:
 * a date alone, an offset, a list, text, surrounding whitespace of any kind, or precision finer than a millisecond
 * (which a Date cannot hold and would be rounded down into an EARLIER instant) is unreadable. Only unset and the
 * empty string are absent.
 */
export function parseProducerCutoff(raw: string | undefined): CutoffRead {
  if (raw === undefined || raw === '') return { ok: false, reason: 'absent' }
  const match = ISO_UTC_RE.exec(raw)
  if (!match) return { ok: false, reason: 'unreadable' }
  const [year, month, day, hour, minute] = [match[1], match[2], match[3], match[4], match[5]].map(Number) as [number, number, number, number, number]
  const second = match[6] === undefined ? 0 : Number(match[6])
  const millis = match[7] === undefined ? 0 : Number(match[7].padEnd(3, '0'))
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return { ok: false, reason: 'unreadable' }
  const at = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millis))
  // A day that does not exist (2026-02-30) rolls over in Date.UTC; reject any roll-over.
  if (Number.isNaN(at.getTime()) || at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) {
    return { ok: false, reason: 'unreadable' }
  }
  return { ok: true, at }
}

/**
 * A timestamp as a FINITE epoch-millisecond number, read once, or null. Only a real Date is accepted, and its
 * time value is read through Date.prototype.getTime so that a subclass or an injected object cannot answer
 * with Infinity, undefined, a string or an exception of its own choosing; anything else is unreadable.
 */
function readInstant(value: unknown): number | null {
  try {
    if (!(value instanceof Date)) return null
    const ms: unknown = Date.prototype.getTime.call(value)
    return typeof ms === 'number' && Number.isFinite(ms) ? ms : null
  } catch {
    return null
  }
}

function shadow(
  reason: ProducerReason,
  base: Pick<ProducerDecision, 'owner' | 'phase' | 'cutoff' | 'grant'>,
): ProducerDecision {
  return { disposition: 'SHADOW', reason, ...base }
}

function evaluate<D extends OutboundConnector>(
  destination: D,
  operation: MappedOperation<D>,
  obligationAt: Date | undefined,
  context: ProducerDecisionContext,
): ProducerDecision {
  const env = context.env ?? process.env
  const now = context.now ?? new Date()
  const row = ownershipRowFor(destination, operation)
  const unreadableBase = { owner: 'unknown' as WriterOwner, phase: 'P1' as const, cutoff: null, grant: 'unreadable' as const }
  if (!(OUTBOUND_CONNECTORS as readonly string[]).includes(destination)) return shadow('unreadable', unreadableBase)

  const p1Owner = row?.owners.P1 ?? 'unknown'

  const state = readOutboundGrantStates(env).find((candidate) => candidate.connector === destination)
  if (!state) return shadow('unreadable', unreadableBase)
  if (state.state === 'held') return shadow('no_grant', { owner: p1Owner, phase: 'P1', cutoff: null, grant: 'absent' })
  if (state.state === 'unreadable') return shadow('unreadable_grant', { owner: p1Owner, phase: 'P1', cutoff: null, grant: 'unreadable' })

  const cutoff = parseProducerCutoff(env[PRODUCER_CUTOFF_ENV[destination]])
  if (!cutoff.ok) {
    return shadow(cutoff.reason === 'absent' ? 'no_cutoff' : 'unreadable_cutoff', { owner: p1Owner, phase: 'P1', cutoff: null, grant: 'granted' })
  }
  const nowMs = readInstant(now)
  if (nowMs === null) return shadow('unreadable', { owner: p1Owner, phase: 'P1', cutoff: cutoff.at, grant: 'granted' })
  const cutoffMs = readInstant(cutoff.at)
  if (cutoffMs === null) return shadow('unreadable_cutoff', { owner: p1Owner, phase: 'P1', cutoff: null, grant: 'granted' })
  if (nowMs < cutoffMs) return shadow('before_cutoff', { owner: p1Owner, phase: 'P1', cutoff: cutoff.at, grant: 'granted' })

  // Phase P2 for this destination from here on.
  const owner: WriterOwner = row?.owners.P2 ?? 'unknown'
  const base = { owner, phase: 'P2' as const, cutoff: cutoff.at, grant: 'granted' as const }
  if (owner === 'unknown') return shadow('owner_unknown', base)
  if (owner !== 'IMS') return shadow('not_ims_owned', base)

  if (obligationAt === undefined) {
    // A row that says the business-event time is required cannot be LIVE without it: an omitted time would
    // re-produce a pre-cut-off obligation as new work.
    if (row?.obligationTime === 'required') return shadow('obligation_time_required', base)
  } else {
    const obligationMs = readInstant(obligationAt)
    if (obligationMs === null) return shadow('unreadable_obligation', base)
    if (obligationMs < cutoffMs) return shadow('obligation_before_cutoff', base)
  }
  return { disposition: 'LIVE', reason: 'live', ...base }
}

/** The decision with its reason, owner, phase and instant. Never throws. */
export function explainProducerDisposition<D extends OutboundConnector>(
  destination: D,
  operation: MappedOperation<D>,
  obligationAt?: Date,
  context: ProducerDecisionContext = {},
): ProducerDecision {
  try {
    return evaluate(destination, operation, obligationAt, context)
  } catch {
    return { disposition: 'SHADOW', reason: 'unreadable', owner: 'unknown', phase: 'P1', cutoff: null, grant: 'unreadable' }
  }
}

/** LIVE or SHADOW for one unit of work. Never throws; anything it cannot read is SHADOW. */
export function producerDisposition<D extends OutboundConnector>(
  destination: D,
  operation: MappedOperation<D>,
  obligationAt?: Date,
  context: ProducerDecisionContext = {},
): ProducerDisposition {
  return explainProducerDisposition(destination, operation, obligationAt, context).disposition
}

export type ProducerAgreement = {
  connector: OutboundConnector
  state: ProducerAgreementState
  /** One sentence for `outbound:status`. */
  text: string
}

/**
 * Whether a destination's grant and live-from instant agree: both absent (held), both readable (live phase),
 * exactly one of them set (inconsistent), or either unreadable. Pure; the environment only. Every state is
 * safe (the decision above is SHADOW unless both are readable); the point is to show the operator which
 * one they are in. Never throws.
 */
export function producerGrantCutoffAgreement(
  connector: OutboundConnector,
  env: OutboundEnv = process.env,
): ProducerAgreement {
  try {
    const state = readOutboundGrantStates(env).find((candidate) => candidate.connector === connector)
    if (!state) throw new Error(`no grant state for ${connector}`)
    const cutoff = parseProducerCutoff(env[PRODUCER_CUTOFF_ENV[connector]])
    const make = (agreement: ProducerAgreementState, detail: Parameters<typeof producerAgreementText>[1]): ProducerAgreement => ({
      connector, state: agreement, text: producerAgreementText(connector, detail),
    })
    if (state.state === 'unreadable' || (!cutoff.ok && cutoff.reason === 'unreadable')) return make('unreadable', 'unreadable')
    if (state.state === 'granted' && cutoff.ok) return make('agreed_live', 'agreed_live')
    if (state.state === 'held' && !cutoff.ok) return make('agreed_held', 'agreed_held')
    if (state.state === 'granted') return make('inconsistent', 'grant_without_cutoff')
    return make('inconsistent', 'cutoff_without_grant')
  } catch {
    return {
      connector,
      state: 'unreadable',
      text: producerAgreementText(connector, 'unreadable'),
    }
  }
}
